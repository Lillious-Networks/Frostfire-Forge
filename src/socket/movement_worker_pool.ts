import { Worker } from "worker_threads";
import log from "../modules/logger.ts";
import type { MoverSnapshot, ReceiverInfo } from "./movement_batch.ts";

export interface WorkerFlushRequest {
  tick: number;
  movers: MoverSnapshot[];
  receiverIds: string[];
  receiverInfo: Record<string, ReceiverInfo>;
  diffs: Array<{ playerId: string; add: string[]; remove: string[] }>;
  onBatches: (batches: any[], updatedSeqs?: Record<string, number>) => void;
}

interface PooledWorker {
  worker: Worker;
  flushInFlight: boolean;
  pendingFlushRequest: WorkerFlushRequest | null;
  currentFlushRequest: WorkerFlushRequest | null;
  lastUsedAt: number;
}

// One worker thread per map layer. Layers are capped at MAX_PLAYERS_PER_LAYER
// (default 50), so each worker's per-flush work is small - but spreading the
// flush across worker threads keeps the main event loop free, which the
// [LAG] diagnostics showed was saturated by inline encoding at high player
// counts.
const pool = new Map<string, PooledWorker>();

let onWorkerRetiredCallback: ((layerId: string) => void) | null = null;

export function setOnWorkerRetired(callback: (layerId: string) => void): void {
  onWorkerRetiredCallback = callback;
}

function getPooledWorker(layerId: string): PooledWorker {
  const existing = pool.get(layerId);
  if (existing) return existing;

  const worker = new Worker(new URL("./movement_worker.ts", import.meta.url));
  const pooled: PooledWorker = {
    worker,
    flushInFlight: false,
    pendingFlushRequest: null,
    currentFlushRequest: null,
    lastUsedAt: Date.now(),
  };

  worker.on("message", (message: any) => {
    if (message.type === "flushResult") {
      finishFlush(pooled, message.batches, message.updatedSeqs);
    } else if (message.type === "flushError") {
      log.warn(`[MOVEMENT WORKER] ${message.error}`);
      finishFlush(pooled, []);
    }
  });
  worker.on("error", (error: Error) => {
    log.error(`[MOVEMENT WORKER] ${error.message}`);
    finishFlush(pooled, []);
    pool.delete(layerId);
    if (onWorkerRetiredCallback) {
      onWorkerRetiredCallback(layerId);
    }
  });

  pool.set(layerId, pooled);
  return pooled;
}

function finishFlush(pooled: PooledWorker, batches: any[], updatedSeqs?: Record<string, number>): void {
  const request = pooled.currentFlushRequest;
  pooled.currentFlushRequest = null;
  pooled.flushInFlight = false;

  if (request) {
    request.onBatches(batches, updatedSeqs);
  }

  const next = pooled.pendingFlushRequest;
  pooled.pendingFlushRequest = null;
  if (next) {
    queueFlushOn(pooled, next);
  }
}

function queueFlushOn(pooled: PooledWorker, request: WorkerFlushRequest): void {
  if (pooled.flushInFlight) {
    pooled.pendingFlushRequest = request;
    return;
  }

  pooled.flushInFlight = true;
  pooled.currentFlushRequest = request;
  pooled.lastUsedAt = Date.now();

  pooled.worker.postMessage({
    type: "flush",
    tick: request.tick,
    movers: request.movers,
    receiverIds: request.receiverIds,
    receiverInfo: request.receiverInfo,
    diffs: request.diffs || [],
  });

  setTimeout(() => {
    if (pooled.currentFlushRequest === request) {
      log.warn("[MOVEMENT WORKER] Flush timed out");
      finishFlush(pooled, []);
    }
  }, 5000);
}

export function queueLayerWorkerFlush(layerId: string, request: WorkerFlushRequest): void {
  queueFlushOn(getPooledWorker(layerId), request);
}

export function postToAllWorkers(message: any): void {
  for (const entry of pool.values()) {
    try {
      entry.worker.postMessage(message);
    } catch {
      // Worker may be mid-termination; ignore
    }
  }
}

// Workers for emptied layers are reaped after a period of inactivity.
const WORKER_IDLE_TIMEOUT_MS = 120000;
setInterval(() => {
  const now = Date.now();
  for (const [layerId, entry] of pool.entries()) {
    if (now - entry.lastUsedAt > WORKER_IDLE_TIMEOUT_MS) {
      try {
        entry.worker.terminate();
      } catch {
        // Ignore termination races
      }
      pool.delete(layerId);
      if (onWorkerRetiredCallback) {
        onWorkerRetiredCallback(layerId);
      }
      log.debug(`[MOVEMENT WORKER] Terminated idle worker for layer ${layerId}`);
    }
  }
}, 30000);
