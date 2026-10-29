// One change made of several systems' writes: all of them are kept, or none.
//
// Each system that owns rows (the inventory, the currency, ...) sends its own
// statements, holds its own copy of the rows and queues its own changes. A
// change that spans systems (a purchase takes coins and gives an item) is
// handed a batch instead: every system adds its statements to it, the batch
// sends them as one transaction, and only then does each system put what it
// has pending into the rows it holds.
//
//   await atomically([buyer], async (batch) => {
//     await currency.remove(buyer, price, batch);
//     await inventory.add(buyer, item, batch);
//   });
//
// Inside `work`, every call on a system that owns rows of a named player must
// be given the batch: one that is not would wait for a turn the batch holds
// until it ends, which is after `work`. For the same reason a batch is not
// started inside another for the same player.

import { transaction, type TransactionStatement } from "../controllers/sqldatabase";
import log from "../modules/logger";
import { turns } from "./datacache";

/** A queue of work, one piece at a time for a key. `turns()` makes one. */
type Queue = <T>(key: string, work: () => Promise<T>) => Promise<T>;

export interface Batch {
  /**
   * Take `queue`'s turn for `player` and keep it until the batch ends, so nothing else changes that
   * system's rows of the player between what the batch read and what it writes. Taken once however
   * often it is asked for.
   */
  hold(queue: Queue, player: string): Promise<void>;
  /**
   * What `owner` (a system: its cache, say) has pending for `player` in this batch. `start` makes
   * it the first time, and the same thing is handed back after: the system changes it as it adds
   * statements, so its second change in a batch works from what its first one left.
   */
  pending<T extends object>(owner: object, player: string, start: () => Promise<T>): Promise<T>;
  /** A statement of the transaction. `answered` is handed its result, once the transaction is kept. */
  add(statement: TransactionStatement, answered?: (result: any) => void): void;
  /** Run once the transaction is kept, in the order asked: where a system puts what it has pending into the rows it holds. */
  kept(step: () => unknown): void;
  /**
   * Run when the transaction was not kept, or may have been (an answer that never came): where a
   * system forgets the rows it holds, so the next read asks the database.
   */
  undone(step: () => unknown): void;
  /**
   * Run once the batch is kept and has ended: the player and every turn it held are free again, so
   * this is where to ask a system for a change of its own (a `kept` step that did would wait for a
   * turn the batch still holds). A step that fails is logged and is not the caller's error: what
   * the batch wrote is kept.
   */
  after(step: () => unknown): void;
  /**
   * The transaction may not open after `deadline` (ms since the epoch): past it the database refuses it whole,
   * however long it waited for a connection, and does not try it again (LateError, controllers/sqltransaction.ts).
   * Asked more than once, the earliest deadline holds. A batch that sets none is sent as it always was.
   */
  openBy(deadline: number): void;
}

// One batch at a time for a player.
const oneAtATime = turns();

/**
 * Cluster mode: the lock a batch also holds for its players, across every node (cluster/playerlock.ts). Taken
 * inside the turns of this node, so a batch waits for this node's other batches first and holds the cluster lock
 * only while it reads and writes. Null (the default, and with the cluster off): the turns alone.
 *
 * The work is handed `check`, which the batch calls right before it sends its transaction: it throws when a lock
 * of the batch was lost (it ran out, or the store failed), and the batch then writes nothing and fails as any
 * batch whose transaction failed. A transaction already sent when a lock is lost can still overlap the next
 * holder's; `check` renews every lock to a full ttl first, so that needs one transaction to take longer than it.
 */
export type ClusterPlayerLock = <T>(players: string[], work: (check: () => Promise<void>) => Promise<T>) => Promise<T>;
let clusterLock: ClusterPlayerLock | null = null;

/** Answers the lock set before, so a test can put it back. */
export function setClusterPlayerLock(lock: ClusterPlayerLock | null): ClusterPlayerLock | null {
  const previous = clusterLock;
  clusterLock = lock;
  return previous;
}

const lower = (player: string) => String(player).toLowerCase();

// The errors of batches that threw before their transaction was sent (see nothingWritten).
const unsent = new WeakSet<object>();

/**
 * Whether `error`, thrown by atomically, was thrown before the batch's transaction was sent: what `work` threw, a
 * lock check that refused, or a cluster lock that was not taken. Nothing of the batch was written then. Any other
 * error may come after the rows were written (a kept step that failed after the commit, or a commit whose answer was
 * lost), so what the batch wrote may be in the database.
 */
export function nothingWritten(error: unknown): boolean {
  return typeof error === "object" && error !== null && unsent.has(error);
}

/**
 * Runs `work` and sends every statement it added as one transaction. Answers with what `work`
 * answered once the transaction is kept. Throws when the batch failed: what `work` threw or a lock
 * check refused (nothing is sent then, and nothingWritten says so), the transaction's own error (see
 * `transaction`; its rows may have been written when the answer was lost), or a kept step that failed
 * after the commit (the rows are written then).
 *
 * `players` are all the players whose rows the batch changes. It waits for any batch under way for
 * one of them, and a system's turn cannot be held for a player who is not named.
 */
export async function atomically<T>(players: string[], work: (batch: Batch) => Promise<T>): Promise<T> {
  const names = [...new Set(players.map(lower))].sort();
  const afterSteps: Array<() => unknown> = [];
  const progress = { sent: false };
  // Waited for in order of name: two batches that share players then ask for them in the same
  // order, so neither holds a player the other is waiting for.
  const run = names.reduceRight<() => Promise<T>>(
    (inner, name) => () => oneAtATime(name, inner),
    () => (clusterLock
      ? clusterLock(names, (check) => carryOut(names, work, afterSteps, progress, check))
      : carryOut(names, work, afterSteps, progress)),
  );
  let result: T;
  try {
    result = await run();
  } catch (error) {
    if (progress.sent) throw error;
    // Guard (test "an error from before the transaction is told apart from one after it").
    const marked = typeof error === "object" && error !== null ? error : new Error(String(error));
    unsent.add(marked);
    throw marked;
  }
  for (const step of afterSteps) {
    try {
      await step();
    } catch (error) {
      log.error(`A step left for after a batch failed: ${error}`);
    }
  }
  return result;
}

async function carryOut<T>(
  names: string[],
  work: (batch: Batch) => Promise<T>,
  afterSteps: Array<() => unknown>,
  progress: { sent: boolean },
  check?: () => Promise<void>,
): Promise<T> {
  const statements: TransactionStatement[] = [];
  const answers: Array<((result: any) => void) | undefined> = [];
  const keptSteps: Array<() => unknown> = [];
  const undoneSteps: Array<() => unknown> = [];
  const leftForAfter: Array<() => unknown> = [];
  const held = new Map<Queue, Map<string, Promise<void>>>();
  const states = new Map<object, Map<string, Promise<object>>>();
  let openDeadline: number | undefined;

  let end!: () => void;
  const ended = new Promise<void>((resolve) => { end = resolve; });

  const batch: Batch = {
    async hold(queue, player) {
      const name = lower(player);
      if (!names.includes(name)) throw new Error(`A batch changed the rows of ${name}, a player it did not name.`);
      if (!held.has(queue)) held.set(queue, new Map());
      const mine = held.get(queue)!;
      // Asked for once; whoever asks again waits for the same turn to be taken.
      if (!mine.has(name)) {
        mine.set(name, new Promise<void>((taken) => {
          void queue(name, () => {
            taken();
            return ended;
          });
        }));
      }
      await mine.get(name);
    },
    pending<S extends object>(owner: object, player: string, start: () => Promise<S>): Promise<S> {
      const name = lower(player);
      if (!states.has(owner)) states.set(owner, new Map());
      const mine = states.get(owner)!;
      if (!mine.has(name)) mine.set(name, start());
      return mine.get(name) as Promise<S>;
    },
    add(statement, answered) {
      statements.push(statement);
      answers.push(answered);
    },
    kept(step) { keptSteps.push(step); },
    undone(step) { undoneSteps.push(step); },
    after(step) { leftForAfter.push(step); },
    openBy(deadline) {
      openDeadline = openDeadline === undefined ? deadline : Math.min(openDeadline, deadline);
    },
  };

  const undo = async () => { for (const step of undoneSteps) await step(); };

  try {
    const result = await work(batch);

    let results: any[] = [];
    if (statements.length > 0) {
      try {
        // Cluster mode: the batch's player locks are still held, or nothing is sent. A failed check
        // is undone as a failed transaction is: another node may have written these rows meanwhile.
        if (check) await check();
        progress.sent = true;
        // Guard (test "a batch hands its earliest open-by deadline to the transaction, and none when it set none").
        results = openDeadline === undefined ? await transaction(statements) : await transaction(statements, { openBy: openDeadline });
      } catch (error) {
        await undo();
        throw error;
      }
    }
    answers.forEach((answered, index) => answered?.(results[index]));

    // The rows are written: a step that fails leaves a system holding rows that are not the
    // database's, so after the other steps have run, every system forgets what it holds.
    const failures: unknown[] = [];
    for (const step of keptSteps) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      await undo();
      throw failures[0];
    }
    afterSteps.push(...leftForAfter);
    return result;
  } finally {
    end();
  }
}
