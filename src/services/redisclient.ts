import { RedisClient, type RedisOptions } from "bun";
import log from "../modules/logger";

// Redis clients that come back after an outage. A Bun client reconnects on its own for a while only: Bun 1.4.4 stops
// for good once the connection has been away longer than connectionTimeout, whatever maxRetries says, and every call
// then fails with "Connection has failed" until the process restarts. So while a connection is lost a fresh client is
// tried every REVIVE_MS and swapped in when one connects. This is the cluster store's approach (cluster/redisstore.ts),
// and the shared cache client's (the asset and row cache, SharedRedis below): one implementation, RedisSlot.
//
// Nothing queues while Redis is away: a call fails at once, so a login is not held behind a queue that may never drain.
// connectionTimeout stays for the first connection only: for a refused connection Bun's connect() neither resolves nor
// rejects, so it does not bound an attempt. Each attempt has its own deadline here instead.

export const CONNECT_WAIT_MS = 5_000;
/** How often a lost connection is tried again with a fresh client (ms). */
export const REVIVE_MS = 3_000;
/** How long one revival attempt waits for its fresh client to connect before it is closed and dropped (ms). */
export const ATTEMPT_MS = 5_000;
export const CLIENT_OPTIONS: RedisOptions = {
  autoReconnect: true,
  maxRetries: 0xffff_ffff, // the most Bun accepts
  enableOfflineQueue: false,
  connectionTimeout: CONNECT_WAIT_MS,
};
/**
 * The cache client's: the same, but with Bun's default offline queue on, as the `redis` singleton it replaces had. A
 * call made while the client reconnects waits and completes when it is back, so a short blip fails nothing on a single
 * node (CACHE=redis, no cluster). The cluster store keeps CLIENT_OPTIONS: its callers must not wait on a queue.
 */
export const SHARED_OPTIONS: RedisOptions = { ...CLIENT_OPTIONS, enableOfflineQueue: true };

/** `connecting`, or a rejection after `ms`: a connect that is refused neither resolves nor rejects. */
export async function within(connecting: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the connection was not made in time")), ms);
        (timer as { unref?: () => unknown }).unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A lost connection being replaced: the timer, and the fresh client while it connects.
interface Revival {
  timer: ReturnType<typeof setInterval>;
  fresh: RedisClient | null;
  busy: boolean;
}

export interface RedisSlotOptions {
  /** How the connection is named in the log ("Redis", "Redis subscriber"). */
  name: string;
  /** A fresh client, not yet connected. */
  make: () => RedisClient;
  reviveMs: number;
  attemptMs: number;
  /**
   * Work on a fresh client, once connected, before it takes the lost one's place (the subscriber puts its channels on
   * it). False when the slot changed meanwhile, or the work throws: the fresh client is dropped and the next tick tries
   * again. `stale` tells whether the attempt is pointless now.
   */
  prepare?: (fresh: RedisClient, stale: () => boolean) => Promise<boolean>;
  /** A fresh client has taken the lost one's place. */
  adopted?: (fresh: RedisClient) => void;
  /** The client came back on its own. */
  reconnected?: (client: RedisClient) => void;
}

/** One connection that is replaced when it is lost: the client in use, and the timer that tries a fresh one. */
export class RedisSlot {
  client: RedisClient | null = null;
  // Clients closed on purpose: their onclose is not an outage.
  private closedByUs = new WeakSet<RedisClient>();
  // False while the client in use is lost.
  private connected = true;
  // Per lost client, the timer that tries a fresh one; and whether close() has been called.
  private revivals = new Map<RedisClient, Revival>();
  private stopped = false;

  constructor(private readonly options: RedisSlotOptions) {}

  /** Takes `client` as the one in use and watches it. `connected`: it has connected already (a first connection is not logged as a return). */
  use(client: RedisClient, connected: boolean): void {
    this.client = client;
    this.watch(client, connected);
  }

  /** False while the client in use is lost, and once closed here. */
  isUp(): boolean {
    return this.connected && this.client !== null && !this.closedByUs.has(this.client);
  }

  // Logs a lost connection once per outage (not once per failed attempt to get it back), and the return.
  // A client that reconnects on its own does not say when it loses the connection, only when it has it again.
  // While it is lost, a fresh client is tried every reviveMs (see revive); the client's own return stops that.
  private watch(client: RedisClient, connected: boolean): void {
    let down = false;
    client.onclose = (error) => {
      // Closing is not an outage.
      if (this.closedByUs.has(client)) return;
      if (client === this.client) this.connected = false;
      this.revive(client);
      if (down) return;
      down = true;
      log.error(`${this.options.name} connection lost, reconnecting: ${error?.message ?? error}`);
    };
    client.onconnect = () => {
      // A client replaced or closed here may still say it connected.
      if (this.closedByUs.has(client)) return;
      this.stopRevival(client);
      if (client === this.client) this.connected = true;
      if (!connected) {
        connected = true; // the first connection
        return;
      }
      down = false;
      log.success(`${this.options.name} connection restored`);
      this.options.reconnected?.(client);
    };
  }

  /** Starts the timer that tries a fresh client for a lost one. One timer per lost client. */
  revive(client: RedisClient): void {
    if (client === this.client) this.connected = false;
    if (this.stopped || this.revivals.has(client)) return;
    const revival: Revival = { timer: setInterval(() => { void this.attempt(client, revival); }, this.options.reviveMs), fresh: null, busy: false };
    (revival.timer as { unref?: () => unknown }).unref?.();
    this.revivals.set(client, revival);
  }

  // Stops the timer of a client, and closes the fresh client that was connecting for it.
  private stopRevival(client: RedisClient): void {
    const revival = this.revivals.get(client);
    if (!revival) return;
    clearInterval(revival.timer);
    this.revivals.delete(client);
    if (revival.fresh) this.discard(revival.fresh);
    revival.fresh = null;
  }

  // Closes a client of ours that is not used: its onclose is no outage.
  private discard(client: RedisClient): void {
    if (this.closedByUs.has(client)) return;
    this.closedByUs.add(client);
    try { client.close(); } catch {}
  }

  // One try with a fresh client; only one is in flight at a time. A fresh client that connects replaces the lost one.
  private async attempt(lost: RedisClient, revival: Revival): Promise<void> {
    if (revival.busy || this.stopped) return;
    // The lost client is no longer the slot's (it was closed here, or replaced): nothing to revive.
    if (this.client !== lost || this.closedByUs.has(lost)) {
      this.stopRevival(lost);
      return;
    }
    // After every wait: has anything made this attempt pointless?
    const stale = () => this.revivals.get(lost) !== revival || this.client !== lost || this.closedByUs.has(lost);
    revival.busy = true;
    let fresh: RedisClient | null = null;
    try {
      fresh = this.options.make();
      revival.fresh = fresh;
      await within(fresh.connect(), this.options.attemptMs);
      if (stale()) return this.discard(fresh);
      if (this.options.prepare && !(await this.options.prepare(fresh, stale))) return this.discard(fresh);
      revival.fresh = null;
      this.stopRevival(lost);
      this.replace(lost, fresh);
    } catch {
      // Not connected in time, or refused: the attempt is dropped, and the next tick tries again.
      if (fresh) this.discard(fresh);
    } finally {
      if (revival.fresh === fresh) revival.fresh = null;
      revival.busy = false;
    }
  }

  // The fresh client takes the lost one's place. It is watched like the first, and the return is logged once.
  private replace(lost: RedisClient, fresh: RedisClient): void {
    this.closedByUs.add(lost);
    try { lost.close(); } catch {}
    this.use(fresh, true);
    this.connected = true;
    this.options.adopted?.(fresh);
    log.success(`${this.options.name} connection restored`);
  }

  /** Lets `client` go: no revival for it, and it is closed. When it is the one in use, the slot has none. */
  release(client: RedisClient): void {
    this.stopRevival(client);
    if (this.client === client) this.client = null;
    this.discard(client);
  }

  /** Stops every revival and closes the client in use. */
  close(): void {
    this.stopped = true;
    for (const client of [...this.revivals.keys()]) this.stopRevival(client);
    if (!this.client) return;
    this.closedByUs.add(this.client);
    this.client.close();
  }
}

/**
 * The cache client: the one Redis connection the asset and row cache (CACHE=redis) and the worlds' player counts share,
 * in place of Bun's `redis` singleton, which gives up for good after a long outage. It connects on first use. A call
 * made while the first connection is made waits for it (CONNECT_WAIT_MS at most), then goes to the client, or fails
 * like any call to a lost connection.
 */
export class SharedRedis {
  private readonly slot: RedisSlot;
  private started: Promise<void> | null = null;

  constructor(
    url: string | undefined = process.env.REDIS_URL,
    private readonly first?: RedisClient,
    private readonly make: () => RedisClient = () => new RedisClient(url, SHARED_OPTIONS),
    private readonly attemptMs = ATTEMPT_MS,
    reviveMs = REVIVE_MS,
  ) {
    this.slot = new RedisSlot({ name: "Redis cache", make, reviveMs, attemptMs });
  }

  // Made on the first call. A first connection that is refused or does not answer in time starts the revival at once:
  // the client may never say that it was lost.
  private start(): Promise<void> {
    this.started ??= (async () => {
      const client = this.first ?? this.make();
      this.slot.use(client, false);
      try {
        await within(client.connect(), this.attemptMs);
      } catch (error) {
        log.error(`Could not connect to Redis: ${error}`);
        this.slot.revive(client);
      }
    })();
    return this.started;
  }

  private async redis(): Promise<RedisClient> {
    await this.start();
    return this.slot.client!;
  }

  async get(key: string): Promise<string | null> {
    return (await this.redis()).get(key);
  }

  async set(key: string, value: string): Promise<unknown> {
    return (await this.redis()).set(key, value);
  }

  async send(command: string, args: string[]): Promise<any> {
    return (await this.redis()).send(command, args);
  }

  /** False while the connection is lost. */
  isUp(): boolean {
    return this.slot.isUp();
  }

  close(): void {
    this.slot.close();
  }
}

let shared: SharedRedis | null = null;
/** The cache client of this process, made on first use. */
export function sharedRedis(): SharedRedis {
  shared ??= new SharedRedis();
  return shared;
}
