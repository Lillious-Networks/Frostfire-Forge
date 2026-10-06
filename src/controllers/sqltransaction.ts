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
 */
export async function runTransaction(db: any, statements: TransactionStatement[], engine: DatabaseEngine, timeoutMs = 15000): Promise<any[]> {
  if (statements.length === 0) return [];

  // Built before the transaction opens: a list that cannot be built is refused whole.
  const texts = statements.map((statement) => sqlWrapper(statement.sql, statement.values || [], engine));
  let started = false;

  const work = async (tx: any) => {
    started = true;
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
