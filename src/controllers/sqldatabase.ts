import log from "../modules/logger";
import path from "node:path";

// Worker pool configuration
const WORKER_POOL_SIZE = 4;
const workerPool: Worker[] = [];
const pendingQueries = new Map<string, { resolve: (value: any) => void; reject: (error: any) => void }>();
let nextWorkerId = 0;
let queryIdCounter = 0;
let workersReady = 0;

// Initialize worker pool
async function initializeWorkerPool(): Promise<void> {
  log.info("Initializing database worker pool...");
  const workerPath = path.join(import.meta.dir, "sqldatabase.worker.ts");

  return new Promise((resolve, reject) => {
    const initTimeout = setTimeout(() => {
      reject(new Error("Worker pool initialization timeout"));
    }, 60000); // Increased from 10s to 60s

    for (let i = 0; i < WORKER_POOL_SIZE; i++) {
      const worker = new Worker(workerPath);

      worker.onmessage = (event: MessageEvent) => {
        const { type, id, result, error } = event.data;

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
          if (error) {
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

// Initialize the worker pool
await initializeWorkerPool();

// Round-robin worker selection
function getNextWorker(): Worker {
  const worker = workerPool[nextWorkerId];
  nextWorkerId = (nextWorkerId + 1) % WORKER_POOL_SIZE;
  return worker;
}

export default async function query<T>(sql: string, values?: any[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const queryId = `query_${++queryIdCounter}_${Date.now()}`;
    const worker = getNextWorker();

    // Store promise handlers
    pendingQueries.set(queryId, { resolve, reject });

    // Set timeout for query
    const timeout = setTimeout(() => {
      pendingQueries.delete(queryId);
      reject(new Error('Query timeout after 30 seconds'));
    }, 30000); // Increased from 10s to 30s

    // Override resolve/reject to clear timeout
    const originalResolve = resolve;
    const originalReject = reject;

    pendingQueries.set(queryId, {
      resolve: (value: any) => {
        clearTimeout(timeout);
        originalResolve(value);
      },
      reject: (error: any) => {
        clearTimeout(timeout);
        originalReject(error);
      }
    });

    // Send query to worker
    worker.postMessage({ id: queryId, sql, values: values || [] });
  });
}
