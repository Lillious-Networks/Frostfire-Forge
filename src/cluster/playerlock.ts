import log from "../modules/logger";
import type { ClusterStore } from "./store";

// One writer at a time for a player's rows, across the cluster (spec §7). A batch (services/batch.ts) already
// waits for any other batch of the same player on this node; a trade, a mail or a purchase on another node writes
// the same rows from there, and only a lock both can see keeps the two apart.
//
// The lock is `{ epoch, node, hold }` under cells:plock:<name>: the epoch is drawn from one counter, and `hold` is
// a random id, so no two holds share a value even when Redis lost the counter and an epoch comes round again. The
// counter lives under cells:plock-epoch, outside the lock keys, so a player named "epoch" has a lock key of its
// own. A lock is taken with setIfAbsent and kept with renewIfEpoch while the work runs. Renewing and giving it up
// first read the value and go on only when it is this hold's own; the epoch step that follows is atomic, so a
// holder that stalled past the ttl can never free, or renew, the next holder's lock. Several names are taken in
// sorted order, with one deadline for all of them, so two lockers of the same names never each hold one the other
// waits for.
//
// A lock that ran out while its work runs is lost: the work is handed `check`, which renews every lock once more
// and throws when one is gone, and a batch calls it right before it sends its transaction, so a holder that lost
// its lock writes nothing. A transaction already sent when the lock is lost can still overlap the next holder's.
// `check` has just renewed the lock to a full ttl, so that needs one transaction to outlast the ttl; closing it
// fully needs a fencing epoch the database itself checks.
//
// Without Redis there is no lock to take. Work on players of this node only still runs on the batch turns alone,
// which keep this node's own writers apart. A hold another node took just before the outage may still be inside
// its work then; its `check` cannot renew without the store and throws, so it commits nothing (a transaction it
// already sent is the overlap above). Work that names a player of another node does not run.
// Work that runs without a lock because the store failed can also overlap a hold another node takes once Redis
// is back, while that work is still running: the same kind of window as the in-flight transaction above.
//
// Every store call on the lock path is bounded: one that does not answer in time counts as not acquired (the
// locker is busy) or as lost, so a store that hangs never holds this node's batch turns past the wait.

export const PLOCK_TTL_MS = 10_000;
export const PLOCK_RENEW_MS = 3_000;
export const PLOCK_POLL_MS = 25;
export const PLOCK_WAIT_MS = 2_000;
/** The least time an acquire's store call is given, so a locker that waits 0 still gets its one try. */
export const PLOCK_MIN_CALL_MS = 250;

const EPOCH_KEY = "cells:plock-epoch";
const lockKey = (name: string) => `cells:plock:${name}`;
const lower = (name: string) => String(name).toLowerCase();

const TIMED_OUT = Symbol("timed out");

/** Answers what `promise` answers, or TIMED_OUT once `ms` have gone by. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export class PlayerLockBusy extends Error {
  constructor(readonly username: string) {
    super(`The player ${username} is locked by another writer`);
    this.name = "PlayerLockBusy";
  }
}

/** Thrown by `check` when a lock of the work ran out or could not be renewed: the work must not commit. */
export class PlayerLockLost extends Error {
  constructor(readonly username: string) {
    super(`The player lock of ${username} was lost`);
    this.name = "PlayerLockLost";
  }
}

export interface LockOptions {
  /** How long to wait, in all, for locks someone holds; 0 tries once. Default PLOCK_WAIT_MS. */
  waitMs?: number;
  /** Whether a player is on this node: without Redis, work on local players only still runs. */
  isLocal?: (username: string) => boolean;
}

interface Hold {
  name: string;
  epoch: number;
  value: string;
}

export class PlayerLocks {
  private readonly heldNow = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly pollMs: number;

  constructor(private store: ClusterStore, private self: string, timing: { ttlMs?: number; renewMs?: number; pollMs?: number } = {}) {
    this.ttlMs = timing.ttlMs ?? PLOCK_TTL_MS;
    this.renewMs = timing.renewMs ?? PLOCK_RENEW_MS;
    this.pollMs = timing.pollMs ?? PLOCK_POLL_MS;
  }

  /** Whether this node holds the lock of `username` now. */
  held(username: string): boolean {
    return this.heldNow.has(lower(username));
  }

  /**
   * Runs `work` holding the lock of every name. `work` is handed `check`, to call right before it commits: it
   * throws when a lock was lost, or the store failed, and then the work must not commit.
   */
  async withLocks<T>(names: string[], work: (check: () => Promise<void>) => Promise<T>, options: LockOptions = {}): Promise<T> {
    const sorted = [...new Set(names.map(lower))].sort();
    const deadline = Date.now() + (options.waitMs ?? PLOCK_WAIT_MS);
    const taken: Hold[] = [];
    try {
      for (const name of sorted) taken.push(await this.acquire(name, deadline));
    } catch (error) {
      await this.release(taken);
      if (error instanceof PlayerLockBusy) throw error;
      const isLocal = options.isLocal;
      if (isLocal && sorted.every((name) => isLocal(name))) {
        log.warn(`No player lock for ${sorted.join(", ")} (the store failed: ${error}); they are all on this node, so the work runs on its batch turns alone`);
        return work(async () => {});
      }
      throw error;
    }

    let lost: string | null = null;
    let finished = false;
    const lose = (hold: Hold, why: string) => {
      // A renewal that answers after the work ended (and the lock was given up) is not a loss.
      if (finished) return;
      if (this.heldNow.get(hold.name) === hold.value) this.heldNow.delete(hold.name);
      if (lost === null) log.warn(`The player lock of ${hold.name} was lost while ${this.self} held it (${why}); its work commits nothing`);
      lost ??= hold.name;
    };
    const renewal = setInterval(() => {
      for (const hold of taken) {
        this.renew(hold)
          .then((kept) => { if (!kept) lose(hold, "it ran out"); })
          .catch((error) => lose(hold, `it could not be renewed: ${error}`));
      }
    }, this.renewMs);
    (renewal as any).unref?.();
    const check = async () => {
      if (lost !== null) throw new PlayerLockLost(lost);
      for (const hold of taken) {
        let kept: boolean;
        try {
          kept = await this.renew(hold);
        } catch (error) {
          lose(hold, `it could not be renewed: ${error}`);
          throw error;
        }
        if (!kept) {
          lose(hold, "it ran out");
          throw new PlayerLockLost(hold.name);
        }
      }
    };
    try {
      return await work(check);
    } finally {
      finished = true;
      clearInterval(renewal);
      await this.release(taken);
    }
  }

  private async acquire(name: string, deadline: number): Promise<Hold> {
    const callMs = () => Math.max(deadline - Date.now(), PLOCK_MIN_CALL_MS);
    const epoch = await within(this.store.incrBy(EPOCH_KEY, 1), callMs());
    if (epoch === TIMED_OUT) {
      log.warn(`The player lock of ${name} was not taken: the store did not answer in time`);
      throw new PlayerLockBusy(name);
    }
    const hold: Hold = { name, epoch, value: JSON.stringify({ epoch, node: this.self, hold: crypto.randomUUID() }) };
    for (;;) {
      const attempt = this.store.setIfAbsent(lockKey(name), hold.value, this.ttlMs);
      const took = await within(attempt, callMs());
      if (took === TIMED_OUT) {
        // Not taken, as far as this locker knows; a set that lands later is given up as soon as it does.
        attempt.then((late) => { if (late) void this.release([hold]); }, () => {});
        log.warn(`The player lock of ${name} was not taken: the store did not answer in time`);
        throw new PlayerLockBusy(name);
      }
      if (took) {
        this.heldNow.set(name, hold.value);
        return hold;
      }
      if (Date.now() >= deadline) throw new PlayerLockBusy(name);
      await new Promise<void>((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  /** Whether the lock is still this hold's and now runs a full ttl again. A store that does not answer in time: false. */
  private async renew(hold: Hold): Promise<boolean> {
    const kept = await within((async () => {
      if ((await this.store.get(lockKey(hold.name))) !== hold.value) return false;
      return this.store.renewIfEpoch(lockKey(hold.name), hold.epoch, this.ttlMs);
    })(), this.renewMs);
    return kept === true;
  }

  /** Gives up every hold at once, so a store that hangs costs one bound, not one per name. */
  private async release(taken: Hold[]): Promise<void> {
    await Promise.all(taken.map(async (hold) => {
      if (this.heldNow.get(hold.name) === hold.value) this.heldNow.delete(hold.name);
      try {
        const done = await within((async () => {
          if ((await this.store.get(lockKey(hold.name))) !== hold.value) return;
          await this.store.deleteIfEpoch(lockKey(hold.name), hold.epoch);
        })(), this.renewMs);
        if (done === TIMED_OUT) log.error(`The player lock of ${hold.name} could not be given up in time (it runs out in ${this.ttlMs} ms)`);
      } catch (error) {
        // The lock runs out on its own.
        log.error(`The player lock of ${hold.name} could not be given up (it runs out in ${this.ttlMs} ms): ${error}`);
      }
    }));
  }
}
