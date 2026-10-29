// A trade across a border whose host this node can no longer reach (cells phase 6). The host makes the swap in the
// shared database, and a link that went down does not mean the host stopped: a swap that started before the link
// dropped can still commit after this node has read its player's bags and coins again. Those copies would then hold
// what the player had before the swap, and the next write here sets its count from them (inventory and currency
// write whole quantities): what the player traded away would be put back, and the item would exist twice.
//
// So the player is marked unsettled for SETTLE_MS, longer than a swap that started before the link dropped can take
// to end. Their rows are dropped at once, and every write to their bags or coins waits until the mark has run out.
// Then the rows are dropped again, so the write reads what the database holds after the swap.
//
// The rows live in the cache the whole cluster shares, so the mark is shared too. It is kept in the cluster's store
// under `cells:settle:<username>` until it runs out (attach, unsettle). Another node takes it from there when it may
// write the player's rows: at login (the login gate, services/datacache.ts) and before an admin's write (/give and the
// player editor, settleForAdmin). From then on the mark is held there as well, so `settled` stays a read of the node's
// own memory: an ordinary write never waits on the store. While a player is marked on a node they are not handed off
// (cluster/handoffwatch.ts), and they cannot open or accept a trade across a border (cluster/tradelink.ts) or there
// (systems/trades.ts).
//
// What sharing leaves open. A login on another node that reads the store before this node's write lands is not
// marked; the write is sent the moment the link is lost, while the player is still connected here. A login whose mark
// cannot be read (the store is down, or does not answer within LOGIN_MARK_READ_MS) goes on unmarked, and that is
// logged; an admin's write is refused instead. A node that takes a mark holds it for what was left of it when it was
// written, on its own clock (leftOf): never shorter than on the node that set it, and longer by the time between the
// write and the read, which can be most of the mark's window for a login near its end. The
// bags and coins shown at a login on another node may predate the swap until the mark runs out: no write uses them,
// and they are shown again then (reloadWhenSettled, socket/receiver.ts).
//
// The bound behind SETTLE_MS. The host starts a swap's transaction only while the link to the partner's node is up,
// and no later than SWAP_START_MS after the final accept (systems/trades.ts, swap). The same time goes with the
// transaction as its open-by deadline (Batch.openBy): the database worker does not open it, or try it again, after
// that, however long it waited for a connection (LateError, controllers/sqltransaction.ts). Once open, its statements
// have the worker's own 15 s. The host waits at most the client's query timeout (DB_QUERY_TIMEOUT_MS) for the answer.
// SETTLE_MS is SWAP_START_MS and DB_QUERY_TIMEOUT_MS plus a margin.
//
// The gap that is left. The commit itself has no time limit: a database server that takes most of the window to
// commit a transaction whose statements all ran makes the swap after the host told both players nothing was traded,
// and possibly after this mark ran out.
//
// With the cluster off nothing is ever marked, and `settled` hands back one promise made at load: no allocation, no
// timer. `settledThen` does not wait on it at all, so a write runs exactly as it did before.

import log from "../modules/logger";
import { dropRows, setLoginGate } from "../services/datacache";
import type { ClusterStore } from "./store";

/** How long (ms) after the final accept the host may still start a swap's transaction (systems/trades.ts). */
export const SWAP_START_MS = 5_000;
/**
 * How long (ms) the database client waits for a query or a transaction (ask() in controllers/sqldatabase.ts, where it
 * is written as a literal). A test reads it there, so the two cannot drift apart.
 */
export const DB_QUERY_TIMEOUT_MS = 30_000;
/** Time for the links to notice a node is down, on top of the two bounds. */
export const SETTLE_MARGIN_MS = 5_000;
/** How long (ms) a player stays unsettled: longer than a swap the host started before the link dropped can take to end. */
export const SETTLE_MS = SWAP_START_MS + DB_QUERY_TIMEOUT_MS + SETTLE_MARGIN_MS;
/** The most players marked at once. Past it the oldest mark is ended early, and that is logged. */
export const MAX_MARKS = 4096;

/** Where a player's mark is kept for the whole cluster, until it runs out. */
export const SETTLE_KEY_PREFIX = "cells:settle:";
export const settleKey = (username: string): string => `${SETTLE_KEY_PREFIX}${String(username ?? "").toLowerCase()}`;
/** What an admin is told when a player's mark could not be read from the cluster's store. */
export const UNCHECKED_SETTLE = "The player's trade state could not be checked; try again.";
/**
 * What an admin is told when an absolute change (a balance or a stack set to a number) came in while the player was
 * marked: the numbers were chosen from bags and coins a swap may have changed since.
 */
export const STALE_AFTER_SETTLE = "The player's bags and coins may have changed while a trade settled; check them and save again.";
/** What an admin is told while their change waits for `username`'s mark, `leftMs` from its end. */
export const settlingNotice = (username: string, leftMs: number): string =>
  `${username} has a trade settling; the change is made in up to ${Math.max(1, Math.ceil(leftMs / 1000))} s.`;
/** The longest (ms) a login waits to read the player's mark from the store; past it the login goes on unmarked. */
export const LOGIN_MARK_READ_MS = 2_000;
/** The login read's limit as used. Shortened by tests. */
export const loginMarkRead = { ms: LOGIN_MARK_READ_MS };

/** A mark as the store keeps it. */
interface SharedMark {
  /** Its end on the clock of the node that set it (ms since the epoch). For the logs: another node's clock may differ. */
  until: number;
  peer: string;
  /** What was left of it (ms) when it was written. */
  left: number;
}

/**
 * How long (ms) a node that reads a shared mark holds it: what was left of it when it was written. That is never less
 * than what is left when it is read, so no node's clock is relied on. A mark read late is held longer than it lasts on
 * the node that set it, by the time between the write and the read: writes wait longer, never too little. The key's
 * own ttl, kept by the store, ends it there. Null when `raw` is not a mark, or one with nothing left.
 *
 * Never more than SETTLE_MS (security review H1, L9): no mark is ever written with more left than that, and one that
 * says so would hold the player's bags and coins, and an admin's writes, for as long as it claims. Marks are sealed in
 * the store (storeseal.ts); the cap holds even for one that was not.
 */
export function leftOf(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SharedMark> | null;
    const left = parsed?.left;
    // Guard (test "a mark that claims more than SETTLE_MS is held for SETTLE_MS").
    return typeof left === "number" && Number.isFinite(left) && left > 0 ? Math.min(left, SETTLE_MS) : null;
  } catch {
    return null;
  }
}

/** What `settled` hands back for a player who is not marked: one promise, made once. */
const SETTLED: Promise<void> = Promise.resolve();

interface Mark {
  until: number;
  timer: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  finish: () => void;
}

export interface SettleOptions {
  /** How long a mark lasts (ms). Shortened by tests. */
  ms?: number;
  /** The most marks held at once. */
  cap?: number;
  /** Drops a player's rows held here. Their inventory and currency rows, unless a test gives another. */
  drop?: (username: string) => Promise<void>;
}

/** A timer that does not keep the process alive by itself. */
const unref = (timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => {
  (timer as { unref?: () => unknown }).unref?.();
  return timer;
};

const dropBelongings = async (username: string): Promise<void> => {
  await Promise.all([dropRows("inventory", username), dropRows("currency", username)]);
};

export class TradeSettle {
  /** Players marked unsettled, oldest first. Each mark has one timer, which every waiter of that player shares. */
  private marks = new Map<string, Mark>();
  private ms!: number;
  private cap!: number;
  private dropper!: (username: string) => Promise<void>;
  /** The cluster's store, where marks are shared. Null with the cluster off: nothing is shared or read then. */
  private store: ClusterStore | null = null;

  constructor(options: SettleOptions = {}) {
    this.configure(options);
  }

  /** Marks are shared through `store` from now on, and read from it at login and before an admin's write. */
  attach(store: ClusterStore): void {
    this.store = store;
  }

  /** Marks are held on this node only again. The marks held are kept (see reset). */
  detach(): void {
    this.store = null;
  }

  /** Whether marks are shared through a store. */
  attached(): boolean {
    return this.store !== null;
  }

  /**
   * `username`'s bags and coins may predate a swap on `peer`: they are marked unsettled until SETTLE_MS from now (a
   * mark already there is made to last that long), their rows are dropped, and the mark is kept in the store for the
   * rest of its window. The promise ends once the rows are dropped and the mark is shared (or its write failed, which
   * is logged).
   */
  unsettle(username: string, reason: string, peer: string): Promise<void> {
    const name = String(username ?? "").toLowerCase();
    const mark = this.hold(name, Date.now() + this.ms);
    log.warn(`The bags and coins of ${name} may predate a swap on ${peer} (${reason}): their writes wait ${this.ms} ms, and their rows are read again after`);
    // Guard (test "a mark is kept in the store for the rest of its window").
    return Promise.all([this.drop(name), this.share(name, mark.until, peer)]).then(() => undefined);
  }

  /**
   * The mark another node keeps for `username` in the store, held here too until the same time: this node's writes
   * of their rows then wait for it. False only when the store could not be read. With no store it reads nothing.
   */
  async importMark(username: string): Promise<boolean> {
    const store = this.store;
    if (!store) return true;
    const name = String(username ?? "").toLowerCase();
    let raw: string | null;
    try {
      raw = await store.get(settleKey(name));
    } catch (error) {
      log.error(`The trade mark of ${name} could not be read from the cluster's store: ${error}`);
      return false;
    }
    const left = leftOf(raw);
    // Guard (test "a mark that has run out, or none, or a malformed one, is not taken"): a mark with nothing left is
    // not held. Guard (test "another node takes the mark from the store, and its writes wait for it"): the hold. Guard
    // (test "an imported mark is held for what was left of it, whatever the other node's clock says"): this node's
    // clock only.
    if (left !== null) this.hold(name, Date.now() + left);
    return true;
  }

  /**
   * True once `username` is settled here and in the store: their mark, wherever it was set, has run out and their
   * rows have been dropped. False when the store could not be read. `onWait` is told, before the wait, how long (ms)
   * is left when there is a mark to wait for.
   */
  async settleEverywhere(username: string, onWait?: (leftMs: number) => void): Promise<boolean> {
    if (!(await this.importMark(username))) return false;
    const until = this.unsettledUntil(username);
    if (until !== null) onWait?.(Math.max(until - Date.now(), 0));
    // Guard (test "an admin's write to a player marked on another node waits for the mark").
    await this.settled(username);
    return true;
  }

  /**
   * Ends at once for a player who is not marked: no allocation, no timer. Otherwise once the mark has run out and the
   * player's rows have been dropped again, so the next read is what the database holds. Waiters of one player share
   * one promise and one timer.
   */
  settled(username: string): Promise<void> {
    if (this.marks.size === 0) return SETTLED;
    return this.marks.get(String(username ?? "").toLowerCase())?.done ?? SETTLED;
  }

  /** `work`, once `username` is settled. For a player who is not marked it runs at once, with nothing waited for. */
  settledThen<T>(username: string, work: () => Promise<T>): Promise<T> {
    const wait = this.settled(username);
    return wait === SETTLED ? work() : wait.then(work);
  }

  /** Whether `username` is marked. Synchronous, and with no marks it reads nothing but the count. */
  unsettled(username: string): boolean {
    if (this.marks.size === 0) return false;
    return this.marks.has(String(username ?? "").toLowerCase());
  }

  /** When `username`'s mark runs out (ms since the epoch), or null when they are not marked. */
  unsettledUntil(username: string): number | null {
    return this.marks.get(String(username ?? "").toLowerCase())?.until ?? null;
  }

  /** How many players are marked. */
  get size(): number {
    return this.marks.size;
  }

  /**
   * Ends every mark, and releases whoever waits on one, with nothing dropped. For tests (with options).
   *
   * Not called when the cluster stops (stopCluster in cluster/index.ts): a swap on a node this one has left can still
   * commit, and releasing the waiters early would let their writes read rows from before it. The marks run out on
   * their own; their timers are unref'd, so they do not keep a process that is stopping alive.
   */
  reset(options: SettleOptions = {}): void {
    for (const mark of this.marks.values()) {
      clearTimeout(mark.timer);
      mark.finish();
    }
    this.marks.clear();
    this.configure(options);
  }

  /**
   * Marks `name` until `until`, or makes their mark last that long. The mark is moved to the end: the oldest mark is
   * the one that was set or made longer the longest time ago.
   */
  private hold(name: string, until: number): Mark {
    const held = this.marks.get(name);
    if (held) {
      held.until = Math.max(held.until, until);
      this.marks.delete(name);
      this.marks.set(name, held);
      return held;
    }
    if (this.marks.size >= this.cap) this.evictOldest();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const mark: Mark = { until, timer: unref(setTimeout(() => void this.expire(name, mark), Math.max(until - Date.now(), 0))), done, finish };
    this.marks.set(name, mark);
    return mark;
  }

  /** Keeps `name`'s mark in the store for what is left of it. Nothing without a store. A failed write is logged. */
  private async share(name: string, until: number, peer: string): Promise<void> {
    const store = this.store;
    const left = until - Date.now();
    if (!store || left <= 0) return;
    try {
      await store.set(settleKey(name), JSON.stringify({ until, peer, left } satisfies SharedMark), left);
    } catch (error) {
      log.error(`The trade mark of ${name} could not be shared: another node may write their bags and coins before ${new Date(until).toISOString()}: ${error}`);
    }
  }

  private configure(options: SettleOptions): void {
    this.ms = options.ms ?? SETTLE_MS;
    this.cap = options.cap ?? MAX_MARKS;
    this.dropper = options.drop ?? dropBelongings;
  }

  /**
   * The mark's timer ran out: the rows are dropped, then the mark ends. A mark made longer meanwhile (by an unsettle
   * before or during the drop) waits on to its new end instead, on a new timer.
   */
  private async expire(name: string, mark: Mark): Promise<void> {
    if (this.marks.get(name) !== mark) return;
    // The mark is kept while the rows are dropped: a write that came now would otherwise read the old rows first.
    await this.drop(name);
    if (this.marks.get(name) !== mark) return;
    const left = mark.until - Date.now();
    if (left > 0) {
      mark.timer = unref(setTimeout(() => void this.expire(name, mark), left));
      return;
    }
    this.marks.delete(name);
    mark.finish();
  }

  private evictOldest(): void {
    const [name, mark] = this.marks.entries().next().value as [string, Mark];
    clearTimeout(mark.timer);
    this.marks.delete(name);
    log.warn(`Too many players are marked unsettled after lost trades (${this.cap}): the mark of ${name} is ended early, and their writes no longer wait`);
    void this.drop(name).then(mark.finish);
  }

  private drop(name: string): Promise<void> {
    return this.dropper(name).catch((error) =>
      log.error(`The bags and coins of ${name} held here could not be dropped after a lost trade: ${error}`));
  }
}

/** The node's marks. Nothing is marked while the cluster is off. Kept when the cluster stops (see reset). */
export const tradeSettle = new TradeSettle();

/** See TradeSettle.unsettle. For the phase 5 `gone` relay too (socket/receiver.ts). */
export const unsettle = (username: string, reason: string, peer: string): Promise<void> => tradeSettle.unsettle(username, reason, peer);

/** See TradeSettle.unsettled. */
export const unsettled = (username: string): boolean => tradeSettle.unsettled(username);

/** See TradeSettle.settled. */
export const settled = (username: string): Promise<void> => tradeSettle.settled(username);

/** See TradeSettle.settledThen. Every write to a player's bags or coins goes through it. */
export const settledThen = <T>(username: string, work: () => Promise<T>): Promise<T> => tradeSettle.settledThen(username, work);

/** Whether marks are shared through the cluster's store. False with the cluster off. */
export const settleStoreAttached = (): boolean => tradeSettle.attached();

/**
 * Before an admin's write to `username`'s bags or coins (/give, the player editor): waits until the player is
 * settled here and in the cluster's store. Null once the write may go ahead, or the text to show the admin when the
 * mark could not be read. `onWait` is told how long (ms) is left before a wait for a mark, so the admin can be told
 * their change is held. Called only while settleStoreAttached().
 */
export async function settleForAdmin(username: string, onWait?: (leftMs: number) => void): Promise<string | null> {
  // Guard (test "a mark that cannot be read refuses an admin's write").
  return (await tradeSettle.settleEverywhere(username, onWait)) ? null : UNCHECKED_SETTLE;
}

/**
 * The login gate: the player's mark taken from the store, for at most loginMarkRead.ms. A store that does not answer
 * in time is logged and the login goes on unmarked, as when the read fails. A read that answers later still holds the
 * mark it finds.
 */
function importAtLogin(username: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = loginMarkRead.ms;
  const late = new Promise<void>((resolve) => {
    timer = unref(setTimeout(() => {
      log.error(`The trade mark of ${String(username ?? "").toLowerCase()} was not read within ${limit} ms at login: the login goes on unmarked`);
      resolve();
    }, limit));
  });
  // Guard (test "a login whose mark is not read in time goes on").
  return Promise.race([tradeSettle.importMark(username), late]).finally(() => clearTimeout(timer));
}

// A login takes the player's mark from the store before their rows are read. Nothing is awaited while no store is
// attached, so a login with the cluster off runs exactly as before.
setLoginGate((username) => (tradeSettle.attached() ? importAtLogin(username) : undefined));
