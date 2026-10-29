// Runs a list of statements as one transaction: all of them are kept, or none. Kept apart from the
// worker so it can be tested against a database without the worker pool.

import { sqlWrapper } from "./sqlescape";

export interface TransactionStatement {
  sql: string;
  values?: any[];
  /**
   * The transaction is undone if this statement changes no rows. For a write whose WHERE holds the
   * check ("copper >= ?"): the check and the write are then one step no other write can come between.
   * MySQL does not count a row that already held the values written, so the statement must be one
   * that changes what it finds ("copper = copper - ?"), never one that may write the same value back.
   */
  mustChange?: boolean;
}

/** A statement marked `mustChange` changed no rows. Nothing was kept. */
export class GuardError extends Error {
  /** Which statement of the list, counted from 0. */
  statement: number;

  constructor(statement: number) {
    super(`Transaction undone: statement ${statement} changed no rows`);
    this.name = "GuardError";
    this.statement = statement;
  }
}

/** The transaction never opened, so no statement was sent: it may be tried again. */
export class NotStartedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotStartedError";
  }
}

/** The transaction could not open by its open-by deadline: nothing was sent, and it is not tried again. */
export class LateError extends Error {
  /** The deadline (ms since the epoch). */
  openBy: number;

  constructor(openBy: number) {
    super(`Transaction not opened: its open-by deadline passed ${Math.max(0, Date.now() - openBy)} ms ago`);
    this.name = "LateError";
    this.openBy = openBy;
  }
}

/**
 * `attempt`, run up to `maxRetries` times in all, `retryDelay` ms apart, while it fails with NotStartedError: only a
 * transaction that never opened may be run again. Any other error ends it, a LateError among them, so a transaction
 * with an open-by deadline is not retried past it.
 */
export async function runWithRetries<T>(attempt: () => Promise<T>, maxRetries: number, retryDelay: number): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof NotStartedError) || tries >= maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

/** Bun reports the rows a write changed as `affectedRows` on MySQL and as `count` elsewhere. */
function changedRows(result: any): number {
  return typeof result?.affectedRows === "number" ? result.affectedRows : result?.count ?? 0;
}

function inTime<T>(work: Promise<T>, left: number, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Transaction timeout after ${timeoutMs}ms`)), Math.max(left, 0));
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * One result for each statement, as `unsafe` gives them, once all are kept. Throws once none are:
 * a statement failed, a `mustChange` statement changed nothing, or `timeoutMs` ran out.
 *
 * `openBy` (ms since the epoch), when given, is the latest the transaction may open. Past it the transaction is
 * refused whole with LateError, before a connection is asked for or, when `begin` waited past it, before the first
 * statement. A throw inside `begin` rolls the transaction back, so nothing of it is kept.
 */
export async function runTransaction(db: any, statements: TransactionStatement[], engine: DatabaseEngine, timeoutMs = 15000, openBy?: number): Promise<any[]> {
  if (statements.length === 0) return [];

  // Built before the transaction opens: a list that cannot be built is refused whole.
  const texts = statements.map((statement) => sqlWrapper(statement.sql, statement.values || [], engine));
  // Guard (test "a transaction past its open-by deadline does not ask for a connection").
  if (openBy !== undefined && Date.now() > openBy) throw new LateError(openBy);
  let started = false;

  const work = async (tx: any) => {
    started = true;
    // The wait for a connection in `begin` has no limit of its own. Guard (test "a transaction that opens after its
    // open-by deadline sends nothing and is refused whole").
    if (openBy !== undefined && Date.now() > openBy) throw new LateError(openBy);
    const deadline = Date.now() + timeoutMs;
    const results: any[] = [];
    for (let i = 0; i < texts.length; i++) {
      const result = await inTime(tx.unsafe(texts[i]), deadline - Date.now(), timeoutMs);
      if (statements[i].mustChange && changedRows(result) === 0) throw new GuardError(i);
      results.push(result);
    }
    return results;
  };

  try {
    // SQLite takes its write lock at the start, where it waits its turn: taking it at the first
    // write, after another connection has written, fails at once instead.
    return await (engine === "sqlite" ? db.begin("immediate", work) : db.begin(work));
  } catch (error: any) {
    if (!started) throw new NotStartedError(error?.message || String(error));
    throw error;
  }
}
