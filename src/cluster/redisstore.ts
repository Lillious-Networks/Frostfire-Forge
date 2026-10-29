import { RedisClient } from "bun";
import log from "../modules/logger";
import { ATTEMPT_MS, CLIENT_OPTIONS, CONNECT_WAIT_MS, REVIVE_MS, RedisSlot } from "../services/redisclient";
import type { ClusterStore } from "./store";

export { ATTEMPT_MS, REVIVE_MS };

// Epoch checks run in Redis, so no other write can land between the read and the write.
// A value that is not JSON (or has no epoch) has epoch 0, as in MemoryStore.
const SWAP_IF_EPOCH = `
local held = redis.call('GET', KEYS[1])
local epoch = 0
if held then
  local ok, decoded = pcall(cjson.decode, held)
  if ok and type(decoded) == 'table' then epoch = tonumber(decoded.epoch) or 0 end
end
if epoch ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

const DELETE_IF_EPOCH = `
local held = redis.call('GET', KEYS[1])
if not held then return 0 end
local epoch = 0
local ok, decoded = pcall(cjson.decode, held)
if ok and type(decoded) == 'table' then epoch = tonumber(decoded.epoch) or 0 end
if epoch ~= tonumber(ARGV[1]) then return 0 end
redis.call('DEL', KEYS[1])
return 1`;

const RENEW_IF_EPOCH = `
local held = redis.call('GET', KEYS[1])
if not held then return 0 end
local epoch = 0
local ok, decoded = pcall(cjson.decode, held)
if ok and type(decoded) == 'table' then epoch = tonumber(decoded.epoch) or 0 end
if epoch ~= tonumber(ARGV[1]) then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;

// Nothing queues while Redis is away, and a lost connection is replaced by a fresh client every REVIVE_MS (the clients
// and their revival are services/redisclient.ts, which the cache client shares: Bun 1.4.4 stops reconnecting once the
// connection has been away longer than connectionTimeout). The first connection is waited for CONNECT_WAIT_MS at most.
/**
 * How long one command may wait for Redis's answer (ms). Bun's client has no timeout of its own, so a Redis that
 * accepts the connection and then stalls would hold every caller without a deadline of its own for ever.
 * A command that misses it is rejected, like a call that failed.
 */
export const STORE_CALL_MS = 2_000;
/** After this many deadline misses in a row, and until a command is answered in time, the store says it is down. */
export const STORE_STALL_MISSES = 3;

/** The cluster's store in Redis (REDIS_URL). Subscriptions use a second connection, as Redis requires. */
export class RedisStore implements ClusterStore {
  // The main connection (its client is this.main.client), and the subscriber's, once it is made (its client is
  // this.sub.client; subscriber is the promise of it).
  private main: RedisSlot;
  private sub: RedisSlot;
  private subscriber: Promise<RedisClient> | null = null;
  private handlers = new Map<string, Array<(message: string) => void>>();
  // Per channel, what the subscriber's connection calls on a message: kept, so a reconnect subscribes the same function again.
  private dispatchers = new Map<string, (message: string) => void>();
  // Per channel, the subscribe in flight or done: a second subscribe waits for it.
  private listening = new Map<string, Promise<void>>();

  // The first connection, until it is made. With the offline queue off a call made before it is up would be
  // refused, so calls wait for it (a while at most: Redis may not be there, and then they fail like any other).
  private connecting: Promise<void> | null;
  private stopped = false;
  // Commands in a row that missed their deadline; reset by one that is answered in time (see isUp).
  private misses = 0;
  private stalledLogged = false;
  // While stalled: a cheap command now and then, so the store hears when Redis answers again even if no caller is
  // sending anything (callers wait for the store to be up).
  private stallProbe: ReturnType<typeof setInterval> | null = null;

  constructor(
    url = process.env.REDIS_URL,
    client?: RedisClient,
    makeClient: () => RedisClient = () => new RedisClient(url, CLIENT_OPTIONS),
    private readonly reviveMs = REVIVE_MS,
    attemptMs = ATTEMPT_MS,
    private readonly callMs = STORE_CALL_MS,
    private readonly stallMisses = STORE_STALL_MISSES,
  ) {
    this.main = new RedisSlot({ name: "Redis", make: makeClient, reviveMs, attemptMs });
    // The subscriber is useless without its channels: a fresh one counts as connected once it has them all.
    this.sub = new RedisSlot({
      name: "Redis subscriber",
      make: makeClient,
      reviveMs,
      attemptMs,
      prepare: (fresh, stale) => this.subscribeFresh(fresh, stale),
      adopted: (fresh) => { this.subscriber = Promise.resolve(fresh); },
      // A client that lost its connection comes back on its own; the server forgot what it was subscribed to, so this tells it again.
      reconnected: (subscriber) => { void this.resubscribe(subscriber); },
    });
    const first = client ?? makeClient();
    this.main.use(first, false);
    this.connecting = first.connect()
      .catch((error) => log.error(`Could not connect to Redis: ${error}`))
      .finally(() => { this.connecting = null; });
  }

  private async redis(): Promise<RedisClient> {
    if (this.connecting) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.connecting, new Promise<void>((resolve) => { timer = setTimeout(resolve, CONNECT_WAIT_MS); })]);
      clearTimeout(timer);
    }
    return this.main.client!;
  }

  // One command, with a deadline of callMs from the moment the client is chosen (waiting for the first connection
  // has its own bound in redis()). A miss rejects, and counts toward stallMisses; the command may still reach Redis
  // later, as with any call whose answer is lost. A command that fails some other way is no stall: it does not count,
  // and it does not clear the count either. The late answer of a command that missed its deadline is not read.
  private async call<T>(run: (client: RedisClient) => Promise<T>): Promise<T> {
    const client = await this.redis();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let late = false;
    const running = run(client);
    // A rejection that comes after the deadline has no one waiting for it.
    running.catch(() => {});
    try {
      const result = await Promise.race([
        running,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            late = true;
            reject(new Error(`Redis did not answer within ${this.callMs} ms`));
          }, this.callMs);
          (timer as { unref?: () => unknown }).unref?.();
        }),
      ]);
      this.answered();
      return result;
    } catch (error) {
      if (late) this.missed();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private answered(): void {
    this.misses = 0;
    if (this.stalledLogged) {
      this.stalledLogged = false;
      if (this.stallProbe) clearInterval(this.stallProbe);
      this.stallProbe = null;
      log.success("Redis answers commands again");
    }
  }

  private missed(): void {
    this.misses++;
    if (this.misses >= this.stallMisses && !this.stalledLogged) {
      this.stalledLogged = true;
      log.error(`Redis did not answer ${this.misses} commands in a row (each waited ${this.callMs} ms): the cluster store counts as down until one is answered`);
      if (!this.stopped && !this.stallProbe) {
        this.stallProbe = setInterval(() => { void this.call((c) => c.send("PING", [])).catch(() => {}); }, this.reviveMs);
        (this.stallProbe as { unref?: () => unknown }).unref?.();
      }
    }
  }

  async get(key: string) {
    return (await this.call((c) => c.get(key))) ?? null;
  }

  async set(key: string, value: string, ttlMs = 0) {
    if (ttlMs > 0) await this.call((c) => c.set(key, value, "PX", ttlMs));
    else await this.call((c) => c.set(key, value));
  }

  async setIfAbsent(key: string, value: string, ttlMs: number) {
    return (await this.call((c) => c.set(key, value, "NX", "PX", String(ttlMs)))) === "OK";
  }

  async del(key: string) {
    await this.call((c) => c.del(key));
  }

  async take(key: string) {
    const held = await this.call((c) => c.send("GETDEL", [key]));
    return held == null ? null : String(held);
  }

  async incrBy(key: string, amount: number) {
    return await this.call((c) => c.incrby(key, amount));
  }

  async swapIfEpoch(key: string, expectedEpoch: number, value: string) {
    return Number(await this.call((c) => c.send("EVAL", [SWAP_IF_EPOCH, "1", key, String(expectedEpoch), value]))) === 1;
  }

  async deleteIfEpoch(key: string, epoch: number) {
    return Number(await this.call((c) => c.send("EVAL", [DELETE_IF_EPOCH, "1", key, String(epoch)]))) === 1;
  }

  async renewIfEpoch(key: string, epoch: number, ttlMs: number) {
    return Number(await this.call((c) => c.send("EVAL", [RENEW_IF_EPOCH, "1", key, String(epoch), String(ttlMs)]))) === 1;
  }

  async addToSet(key: string, member: string) {
    await this.call((c) => c.sadd(key, member));
  }

  async removeFromSet(key: string, member: string) {
    await this.call((c) => c.srem(key, member));
  }

  async members(key: string) {
    return await this.call((c) => c.smembers(key));
  }

  async expire(key: string, ttlMs: number) {
    await this.call((c) => c.pexpire(key, ttlMs));
  }

  async publish(channel: string, message: string) {
    await this.call((c) => c.publish(channel, message));
  }

  // subscribe and unsubscribe on one channel must not overlap: callers (ClusterBus) await each before the next.
  async subscribe(channel: string, handler: (message: string) => void) {
    let listening = this.listening.get(channel);
    if (!listening) {
      // A failed subscribe is forgotten (by listen), so the next call to subscribe tries again.
      listening = this.listen(channel);
      this.listening.set(channel, listening);
    }
    // Waits for the channel to be listened to (also when another call started it), and rethrows if Redis refused.
    await listening;
    // Only once Redis has the channel: a handler is never registered for a channel that is not live.
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
  }

  async unsubscribe(channel: string, handler: (message: string) => void) {
    const list = this.handlers.get(channel);
    if (!list) return;
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
    if (list.length > 0) return;
    // The last handler: Redis stops sending the channel, and a later subscribe listens afresh.
    this.handlers.delete(channel);
    this.dispatchers.delete(channel);
    this.listening.delete(channel);
    const subscriber = this.subscriber;
    if (!subscriber) return;
    try {
      await (await subscriber).unsubscribe([channel]);
    } catch (error) {
      log.warn(`Could not leave ${channel} on Redis: ${error}`);
    }
  }

  private async listen(channel: string): Promise<void> {
    const dispatch = (message: string) => {
      for (const each of this.handlers.get(channel) ?? []) {
        try {
          each(message);
        } catch (error) {
          log.error(`Cluster message on ${channel} failed: ${error}`);
        }
      }
    };
    let client: RedisClient;
    try {
      this.subscriber ??= this.connectSubscriber();
      client = await this.subscriber;
    } catch (error) {
      // No connection was made: the next subscribe makes a new one.
      this.subscriber = null;
      this.listening.delete(channel);
      throw error;
    }
    try {
      await client.subscribe(channel, dispatch);
      this.dispatchers.set(channel, dispatch);
    } catch (error) {
      this.listening.delete(channel);
      // The connection is shared: it is closed (and made anew by the next subscribe) only when no other channel is on it.
      if (this.listening.size === 0) {
        if (this.sub.client === client) this.subscriber = null;
        // A lost subscriber closed here is not revived: its fresh client would be a second one next to the next subscriber.
        this.sub.release(client);
      }
      throw error;
    }
  }

  private async connectSubscriber(): Promise<RedisClient> {
    const subscriber = await (await this.redis()).duplicate();
    this.sub.use(subscriber, true);
    return subscriber;
  }

  // A client that lost its connection comes back on its own; the server forgot what it was subscribed to, so this tells it again.
  private async resubscribe(client: RedisClient): Promise<void> {
    for (const channel of [...this.handlers.keys()]) {
      const dispatch = this.dispatchers.get(channel);
      if (!dispatch) continue;
      try {
        // The client may still hold the listener it was given: unsubscribing first keeps it from being added twice
        // (it refuses when it holds no subscription, which is as good).
        try { await client.unsubscribe([channel]); } catch {}
        await client.subscribe(channel, dispatch);
      } catch (error) {
        log.error(`Could not subscribe to ${channel} again after reconnecting to Redis: ${error}`);
      }
    }
  }

  // Puts every channel of the store on the fresh subscriber, with the dispatch function the store holds for it, and
  // takes off it a channel that was left or given a new dispatch since (it would otherwise run its handlers twice
  // when the channel is subscribed to again). The store can change while this waits: the caller compares again.
  private async subscribeAll(fresh: RedisClient, on: Map<string, (message: string) => void>): Promise<void> {
    for (const [channel, dispatch] of this.dispatchers) {
      if (on.get(channel) === dispatch) continue;
      if (on.has(channel)) await fresh.unsubscribe([channel]);
      await fresh.subscribe(channel, dispatch);
      on.set(channel, dispatch);
    }
    for (const [channel, dispatch] of on) {
      if (this.dispatchers.get(channel) === dispatch) continue;
      on.delete(channel);
      await fresh.unsubscribe([channel]);
    }
  }

  // Whether `on` is exactly what the store holds: the same channels, each with the same dispatch function.
  private holdsAll(on: Map<string, (message: string) => void>): boolean {
    if (on.size !== this.dispatchers.size) return false;
    for (const [channel, dispatch] of this.dispatchers) if (on.get(channel) !== dispatch) return false;
    return true;
  }

  // What a fresh subscriber is given before it takes the lost one's place: what is on the fresh client. The store can
  // change while the channels are put on it, and in the turn between the last subscribe and this code resuming: so what
  // the store holds is compared once more, with no await between that comparison and the adoption.
  private async subscribeFresh(fresh: RedisClient, stale: () => boolean): Promise<boolean> {
    const on = new Map<string, (message: string) => void>();
    do {
      await this.subscribeAll(fresh, on);
      if (stale()) return false;
    } while (!this.holdsAll(on));
    return true;
  }

  /**
   * False while the main connection is lost, and once closed here; the subscriber's connection does not count.
   * Also false after stallMisses commands in a row missed their deadline (a Redis that holds the connection and does
   * not answer), until one is answered in time. A stall starts no revival: the connection is not lost, and a fresh
   * client would meet the same Redis.
   */
  isUp(): boolean {
    return this.main.isUp() && this.misses < this.stallMisses;
  }

  close() {
    this.stopped = true;
    if (this.stallProbe) clearInterval(this.stallProbe);
    this.stallProbe = null;
    this.main.close();
    this.sub.close();
    // A subscriber still being made is closed when it is there.
    this.subscriber?.then((client) => this.sub.release(client)).catch(() => {});
  }
}
