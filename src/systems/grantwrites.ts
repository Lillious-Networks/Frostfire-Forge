import query, { GuardError } from "../controllers/sqldatabase";
import log from "../modules/logger";
import type { Batch } from "../services/batch";

// Durable at-most-once for hand-overs and corpse money between nodes (security review phase 7, M2). The cluster
// store routes a grant and its once-only marks, but a store that is flushed or rolled back can bring a grant that was
// written back, or lose the mark of a share that was paid. So every write of a grant id also writes a row of
// grant_writes in the same transaction: the row is the proof that the id was written. A second write of the same id
// finds the row, changes nothing, and its whole transaction is undone (a GuardError on that statement): nothing of it
// is kept, and it is skipped as written before.
//
// Used only for writes that carry a grant id, which only cluster mode makes: with the cluster off the table is never
// created or read.

export const GRANT_WRITES_TABLE = "grant_writes";
/** The longest grant id (cluster/grants.ts MAX_ID). */
export const GRANT_ID_MAX = 128;

const sqlite = (): boolean => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";

let made: Promise<void> | null = null;

/** Creates the table once per process; a failure is thrown, and the next write tries again. */
export function ensureGrantWrites(): Promise<void> {
  made ??= (async () => {
    await query(sqlite()
      ? `CREATE TABLE IF NOT EXISTS ${GRANT_WRITES_TABLE} (id TEXT NOT NULL PRIMARY KEY, written_at INTEGER NOT NULL)`
      : `CREATE TABLE IF NOT EXISTS ${GRANT_WRITES_TABLE} (id VARCHAR(191) NOT NULL PRIMARY KEY, written_at BIGINT NOT NULL)`);
  })().catch((error) => {
    made = null;
    throw error;
  });
  return made;
}

/** For tests: the table is created again by the next write. */
export function forgetGrantWritesTable(): void {
  made = null;
}

/**
 * Adds the row of grant `id` to `batch`. Call it first in the batch's work, before any other statement: the row's
 * statement is then the first of the transaction, which is how grantWrittenBefore knows its GuardError. Throws (before
 * anything is sent, so services/batch.ts nothingWritten holds) when the id is not one or the table cannot be made.
 */
export async function recordGrantWrite(batch: Batch, id: string): Promise<void> {
  if (typeof id !== "string" || !id || id.length > GRANT_ID_MAX) throw new Error(`${String(id).slice(0, GRANT_ID_MAX)} is not a grant id`);
  await ensureGrantWrites();
  batch.add({
    sql: sqlite()
      ? `INSERT OR IGNORE INTO ${GRANT_WRITES_TABLE} (id, written_at) VALUES (?, ?)`
      : `INSERT IGNORE INTO ${GRANT_WRITES_TABLE} (id, written_at) VALUES (?, ?)`,
    values: [id, Date.now()],
    // A row already there changes nothing: the transaction is undone whole.
    mustChange: true,
  });
}

/** How long a grant_writes row is kept: far past any grant's TTL (cluster/grants.ts GRANT_TTL_MS, 10 minutes). */
export const GRANT_WRITES_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Deletes the rows older than GRANT_WRITES_KEEP_MS, in one statement. Run when the cluster starts (grantwriter.ts,
 * a link hook), so never with the cluster off. A failure (no table yet, the database away) is logged and ignored:
 * the rows are deleted at the next start.
 */
export async function pruneGrantWrites(): Promise<void> {
  try {
    await query(`DELETE FROM ${GRANT_WRITES_TABLE} WHERE written_at < ?`, [Date.now() - GRANT_WRITES_KEEP_MS]);
  } catch (error) {
    log.warn(`Old ${GRANT_WRITES_TABLE} rows could not be deleted (they are tried again at the next cluster start): ${error}`);
  }
}

/**
 * Whether `error`, thrown by an atomically whose work called recordGrantWrite first, says the grant was written
 * before: the guard of its row (the first statement) found the row there, and nothing of this batch was kept.
 */
export function grantWrittenBefore(error: unknown): boolean {
  return error instanceof GuardError && error.statement === 0;
}
