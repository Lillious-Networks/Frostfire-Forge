import log from "../modules/logger";
import path from "node:path";
import { GuardError, type TransactionStatement } from "./sqltransaction";

export { GuardError, type TransactionStatement };

const MAX_DB_WORKER_POOL_SIZE = 64;
const parsedDbWorkerPoolSize = parseInt(process.env.DB_WORKER_POOL_SIZE || "", 10);
const WORKER_POOL_SIZE = Number.isInteger(parsedDbWorkerPoolSize) && parsedDbWorkerPoolSize > 0
  ? Math.min(parsedDbWorkerPoolSize, MAX_DB_WORKER_POOL_SIZE)
  : 8;
const workerPool: Worker[] = [];
const pendingQueries = new Map<string, { resolve: (value: any) => void; reject: (error: any) => void }>();
let nextWorkerId = 0;
let queryIdCounter = 0;
let workersReady = 0;

async function initializeWorkerPool(): Promise<void> {
  log.info("Initializing database worker pool...");
  const workerPath = path.join(import.meta.dir, "sqldatabase.worker.ts");

  return new Promise((resolve, reject) => {
    const initTimeout = setTimeout(() => {
      reject(new Error("Worker pool initialization timeout"));
    }, 60000);

    for (let i = 0; i < WORKER_POOL_SIZE; i++) {
      const worker = new Worker(workerPath);

      worker.onmessage = (event: MessageEvent) => {
        const { type, id, result, error, guard } = event.data;

        if (type === 'ready') {
          workersReady++;
          if (workersReady === WORKER_POOL_SIZE) {
            clearTimeout(initTimeout);
            log.success(`Database worker pool initialized with ${WORKER_POOL_SIZE} workers`);
            resolve();
          }
          return;
        }

        if (type === 'error') {
          clearTimeout(initTimeout);
          reject(new Error(error));
          return;
        }

        const pending = pendingQueries.get(id);
        if (pending) {
          pendingQueries.delete(id);
          if (typeof guard === "number") {
            pending.reject(new GuardError(guard));
          } else if (error) {
            pending.reject(new Error(error));
          } else {
            pending.resolve(result);
          }
        }
      };

      worker.onerror = (error) => {
        log.error(`Database worker error: ${error.message}`);
        clearTimeout(initTimeout);
        reject(error);
      };

      workerPool.push(worker);
    }
  });
}

await initializeWorkerPool();

function getNextWorker(): Worker {
  const worker = workerPool[nextWorkerId];
  nextWorkerId = (nextWorkerId + 1) % WORKER_POOL_SIZE;
  return worker;
}

/** Hands `work` to the next worker and waits for its answer. */
function ask<T>(work: { sql: string; values: any[] } | { transaction: TransactionStatement[] }): Promise<T> {
  return new Promise((resolve, reject) => {
    const queryId = `query_${++queryIdCounter}_${Date.now()}`;
    const worker = getNextWorker();

    const timeout = setTimeout(() => {
      pendingQueries.delete(queryId);
      reject(new Error('Query timeout after 30 seconds'));
    }, 30000);

    pendingQueries.set(queryId, {
      resolve: (value: any) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error: any) => {
        clearTimeout(timeout);
        reject(error);
      }
    });

    worker.postMessage({ id: queryId, ...work });
  });
}

export default async function query<T>(sql: string, values?: any[]): Promise<T[]> {
  return ask<T[]>({ sql, values: values || [] });
}

/**
 * Runs `statements` in order as one transaction, on one connection: all of them are kept, or none.
 * Answers with one result for each statement, as `query` would give it. Throws when nothing was
 * kept: a GuardError when a statement marked `mustChange` changed no rows, the database's own error
 * otherwise. See TransactionStatement for what `mustChange` asks of a statement.
 */
export async function transaction(statements: TransactionStatement[]): Promise<any[]> {
  if (statements.length === 0) return [];
  return ask<any[]>({ transaction: statements });
}

/** Resolves once every query sent so far has been answered or has timed out. */
export async function drainQueries(): Promise<void> {
  while (pendingQueries.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
