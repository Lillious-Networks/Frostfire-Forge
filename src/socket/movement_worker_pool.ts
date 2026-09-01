import { Worker } from "worker_threads";
import os from "node:os";
import log from "../modules/logger.ts";
import type { MoverSnapshot, ReceiverInfo } from "./movement_batch.ts";

export interface WorkerFlushRequest {
  tick: number;
  movers: MoverSnapshot[];
  receiverIds: string[];
  receiverInfo: Record<string, ReceiverInfo>;
  diffs: Array<{ playerId: string; add: string[]; remove: string[] }>;
  onBatches: (batches: any[], updatedSeqs?: Record<string, number>) => void;
  // Set by queueLayerWorkerFlush; used to coalesce repeat flushes per layer
  // when several layers share one worker.
  layerId?: string;
}

interface PooledWorker {
  worker: Worker;
  flushInFlight: boolean;
  currentFlushRequest: WorkerFlushRequest | null;
  lastUsedAt: number;
  queue: WorkerFlushRequest[];
}

// Worker threads are shared across map layers rather than allocated one per
// layer. Layers are capped at MAX_PLAYERS_PER_LAYER (default 50), so at 2000+
// players a per-layer thread meant 40+ OS threads each holding its own heap -
// hundreds of MB of RSS. A bounded pool keeps the flush off the main event
// loop without the thread explosion.
//
// The worker's receiver-set mirror is keyed by playerId (globally unique), so
// several layers can safely share one worker's state.
const MAX_WORKERS = Math.max(2, Math.min(8, os.cpus().length - 1));
const workers: PooledWorker[] = [];

// Stable layer -> worker assignment. Re-hashing a layer to a different worker
// would strand its receiver-set mirror on the old one.
const layerAssignment = new Map<string, PooledWorker>();
let nextWorkerIndex = 0;

let onWorkerRetiredCallback: ((layerId: string) => void) | null = null;

export function setOnWorkerRetired(callback: (layerId: string) => void): void {
  onWorkerRetiredCallback = callback;
}

function createWorker(): PooledWorker {
  const worker = new Worker(new URL("./movement_worker.ts", import.meta.url));
  const pooled: PooledWorker = {
    worker,
    flushInFlight: false,
    currentFlushRequest: null,
    lastUsedAt: Date.now(),
    queue: [],
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
    // The worker is dead: drop queued work before finalizing so nothing gets
    // re-posted onto a terminated worker.
    pooled.queue.length = 0;
    finishFlush(pooled, []);

    // Evict it from the pool and detach every layer that was mapped to it, so
    // those layers re-sync their receiver-set mirror onto a fresh worker.
    const index = workers.indexOf(pooled);
    if (index !== -1) workers.splice(index, 1);

    for (const [assignedLayer, assignedWorker] of layerAssignment.entries()) {
      if (assignedWorker !== pooled) continue;
      layerAssignment.delete(assignedLayer);
      if (onWorkerRetiredCallback) {
        onWorkerRetiredCallback(assignedLayer);
      }
    }
  });

  workers.push(pooled);
  return pooled;
}

function getPooledWorker(layerId: string): PooledWorker {
  const existing = layerAssignment.get(layerId);
  if (existing) return existing;

  let pooled: PooledWorker;
  if (workers.length < MAX_WORKERS) {
    pooled = createWorker();
  } else {
    // Round-robin across the bounded pool.
    pooled = workers[nextWorkerIndex % workers.length];
    nextWorkerIndex++;
  }

  layerAssignment.set(layerId, pooled);
  return pooled;
}

function finishFlush(pooled: PooledWorker, batches: any[], updatedSeqs?: Record<string, number>): void {
  const request = pooled.currentFlushRequest;
  pooled.currentFlushRequest = null;
  pooled.flushInFlight = false;

  if (request) {
    request.onBatches(batches, updatedSeqs);
  }

  const next = pooled.queue.shift();
  if (next) {
    queueFlushOn(pooled, next);
  }
}

function queueFlushOn(pooled: PooledWorker, request: WorkerFlushRequest): void {
  if (pooled.flushInFlight) {
    // Coalesce per layer: a layer only ever needs its most recent flush, but
    // DIFFERENT layers sharing this worker must not overwrite each other (the
    // old single-slot pendingFlushRequest silently dropped one of them).
    const queuedIndex = pooled.queue.findIndex((queued) => queued.layerId === request.layerId);
    if (queuedIndex !== -1) {
      pooled.queue[queuedIndex] = request;
    } else {
      pooled.queue.push(request);
    }
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
  request.layerId = layerId;
  queueFlushOn(getPooledWorker(layerId), request);
}

export function postToAllWorkers(message: any): void {
  for (const entry of workers) {
    try {
      entry.worker.postMessage(message);
    } catch {
      // Worker may be mid-termination; ignore
    }
  }
}

// Idle workers are reaped so an emptied server doesn't hold threads open.
// A worker is only reaped once EVERY layer mapped to it has gone quiet.
const WORKER_IDLE_TIMEOUT_MS = 30000;
setInterval(() => {
  const now = Date.now();

  for (let i = workers.length - 1; i >= 0; i--) {
    const entry = workers[i];
    if (now - entry.lastUsedAt <= WORKER_IDLE_TIMEOUT_MS) continue;
    if (entry.flushInFlight || entry.queue.length > 0) continue;

    try {
      entry.worker.terminate();
    } catch {
      // Ignore termination races
    }

    workers.splice(i, 1);

    // Detach every layer bound to this worker so the next flush re-syncs its
    // receiver-set mirror onto a fresh one.
    for (const [assignedLayer, assignedWorker] of layerAssignment.entries()) {
      if (assignedWorker !== entry) continue;
      layerAssignment.delete(assignedLayer);
      if (onWorkerRetiredCallback) {
        onWorkerRetiredCallback(assignedLayer);
      }
    }
  }
}, 10000);
