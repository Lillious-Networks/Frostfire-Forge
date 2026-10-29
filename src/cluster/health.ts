import log from "../modules/logger";

// Whether the cluster store (Redis) can be reached, and waiting for it to come back (spec §7: a dead Redis pauses
// handoffs, delivery and the directory; the nodes keep simulating their blocks). The store says it is down as soon
// as its connection drops (RedisStore.isUp); this reads that, logs an outage once when it starts and once when it
// ends, and wakes whoever waits for it. A store with no isUp, or no store at all (the cluster off), is up.

/** How often the store is read for a change (ms). */
export const STORE_POLL_MS = 250;

export interface StoreGate {
  up(): boolean;
  /** True at once when the store is up; else true when it comes back within `timeoutMs`, false when it does not. */
  whenUp(timeoutMs: number): Promise<boolean>;
}

export interface WhenUpOptions {
  /** How long one wait for the store lasts (ms). */
  holdMs: number;
  /** The most times `work` runs. */
  attempts: number;
  /** False once whoever asked has stopped: the work is not run after that. */
  alive?: () => boolean;
}

/** What runWhenUp throws when its owner stopped while it waited: a shutdown, not a fault. */
export class StoppedWaiting extends Error {}

const unref =(timer: ReturnType<typeof setTimeout>) => {
  (timer as { unref?: () => unknown }).unref?.();
  return timer;
};

export class StoreHealth implements StoreGate {
  private store: { isUp?(): boolean } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wasUp = true;
  private downSince = 0;
  private waiters = new Set<() => void>();

  attach(store: { isUp?(): boolean }, pollMs = STORE_POLL_MS): void {
    this.detach();
    this.store = store;
    this.wasUp = true;
    this.timer = setInterval(() => this.check(), pollMs);
    unref(this.timer);
    this.check();
  }

  /** Stops watching. With no store everything is up, so whoever waits is woken. */
  detach(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.store = null;
    this.wasUp = true;
    this.wake();
  }

  up(): boolean {
    return this.store?.isUp?.() !== false;
  }

  whenUp(timeoutMs: number): Promise<boolean> {
    if (this.up()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (value: boolean) => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(value);
      };
      const wake = () => done(true);
      this.waiters.add(wake);
      timer = unref(setTimeout(() => done(this.up()), Math.max(0, timeoutMs)));
    });
  }

  check(): void {
    const now = this.up();
    if (now !== this.wasUp) {
      this.wasUp = now;
      if (!now) {
        this.downSince = Date.now();
        log.error("The cluster store is down: handoffs, delivery to other nodes, directory changes and snapshots pause; the blocks here keep running");
      } else {
        log.success(`The cluster store is back after ${Date.now() - this.downSince} ms: handoffs, delivery, the directory and snapshots resume`);
      }
    }
    // Woken on every up reading, not only on a change: an outage shorter than one poll still ends a wait at once.
    if (now) this.wake();
  }

  private wake(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

/**
 * `work` once the store is up: at once when it is, else after a wait of at most `holdMs`. A run that fails while the
 * store is down (it went down meanwhile) waits and runs again, `attempts` runs in all. A failure while the store is up
 * is the caller's, and is thrown at once.
 */
export async function runWhenUp<T>(gate: StoreGate, what: string, work: () => Promise<T>, opts: WhenUpOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (!gate.up()) {
      log.warn(`${what} waits for the cluster store (at most ${opts.holdMs} ms)`);
      if (!(await gate.whenUp(opts.holdMs))) throw new Error(`the cluster store stayed down for ${opts.holdMs} ms`);
    }
    if (opts.alive && !opts.alive()) throw new StoppedWaiting(`${what} stopped while it waited for the cluster store`);
    try {
      return await work();
    } catch (error) {
      if (gate.up() || attempt >= opts.attempts) throw error;
      log.warn(`${what} failed while the cluster store went down (${error}): it runs again once the store is back`);
    }
  }
}

/** The node's health. startCluster attaches the store (Task 21); until then everything is up. */
export const storeHealth = new StoreHealth();

/** Whether the node's cluster store is up. True with the cluster off. */
export const storeIsUp = (): boolean => storeHealth.up();
