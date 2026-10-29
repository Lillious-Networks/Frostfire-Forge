/**
 * Claim/requeue protocol for the batched spawn/despawn queues in receiver.ts.
 *
 * Race this fixes: `flushSpawnBatches` awaits sprite/animation lookups while
 * holding a live reference to each receiver's pending-entry Map. A second
 * player logging in during that await queues a spawn into the SAME Map object,
 * and the flush then either `delete`s the whole entry (nothing left to send)
 * or `clear()`s it to re-queue only its own stale remainder - silently
 * dropping the newly arrived spawn. The existing player never receives the
 * spawn packet, so its client never creates the entity and ignores every
 * later update for it (movement, stats, ...). Simultaneous logins hit this
 * whenever the 50ms flush timer fires between the two logins' queue writes,
 * which is why only one side goes blind and only sometimes.
 *
 * The protocol: claim (detach) the entry BEFORE the first await so concurrent
 * producers land in a fresh entry, then requeue the unprocessed remainder
 * MERGED with whatever arrived mid-flush (arrivals are fresher and win key
 * conflicts). Everything queued before or during a flush is therefore either
 * sent or still queued - never dropped.
 */

/** Detach and return a receiver's pending batch entry. Sync, hence atomic. */
export function claimBatchEntry<K, V>(
  queue: Map<string, Map<K, V>>,
  receiverId: string
): Map<K, V> | undefined {
  const entry = queue.get(receiverId);
  if (entry === undefined) return undefined;
  queue.delete(receiverId);
  return entry;
}

/**
 * Restore the unprocessed remainder of a claimed spawn batch, merged with
 * entries that arrived while the flush was awaiting. Arrived entries win on
 * duplicate keys (they hold the fresher snapshot).
 */
export function requeueSpawnBatch(
  queue: Map<string, Map<string, any>>,
  receiverId: string,
  unprocessed: Map<string, any> | undefined
): void {
  const arrived = queue.get(receiverId);
  if ((!unprocessed || unprocessed.size === 0) && !arrived) return;
  if (arrived && (!unprocessed || unprocessed.size === 0)) return;
  const merged = new Map<string, any>();
  if (unprocessed) {
    for (const [k, v] of unprocessed) merged.set(k, v);
  }
  if (arrived) {
    for (const [k, v] of arrived) merged.set(k, v);
  }
  if (merged.size > 0) {
    queue.set(receiverId, merged);
  } else {
    queue.delete(receiverId);
  }
}

/** Detach and return a receiver's pending despawn set. Sync, hence atomic. */
export function claimDespawnEntry(
  queue: Map<string, Set<string>>,
  receiverId: string
): Set<string> | undefined {
  const entry = queue.get(receiverId);
  if (entry === undefined) return undefined;
  queue.delete(receiverId);
  return entry;
}

/** Restore an unsent despawn set, unioned with ids that arrived mid-flush. */
export function requeueDespawnEntry(
  queue: Map<string, Set<string>>,
  receiverId: string,
  unprocessed: Set<string> | undefined
): void {
  const arrived = queue.get(receiverId);
  if ((!unprocessed || unprocessed.size === 0) && !arrived) return;
  if (arrived && (!unprocessed || unprocessed.size === 0)) return;
  const merged = new Set<string>();
  if (unprocessed) {
    for (const id of unprocessed) merged.add(id);
  }
  if (arrived) {
    for (const id of arrived) merged.add(id);
  }
  if (merged.size > 0) {
    queue.set(receiverId, merged);
  } else {
    queue.delete(receiverId);
  }
}

/** Receivers whose spawn batches are flushed at the same time. */
export const SPAWN_FLUSH_CONCURRENCY = 8;
/** Spawns one receiver gets per flush, and the most when its queue is long (above SPAWN_BACKLOG). */
export const SPAWNS_PER_FLUSH = 10;
export const SPAWNS_PER_FLUSH_BACKLOG = 50;
export const SPAWN_BACKLOG = 100;

/** How many of a receiver's `queued` spawns go out in one flush: more when it is far behind, so a long queue drains. */
export function spawnsPerFlush(queued: number): number {
  return queued > SPAWN_BACKLOG ? SPAWNS_PER_FLUSH_BACKLOG : SPAWNS_PER_FLUSH;
}

/**
 * Runs `task` for every item, `limit` of them at a time, each item once and in order of start. Resolves when all
 * are done (or, past `mayStart` turning false, all that started); if tasks threw, the first error is thrown after the rest finished (a task that must not fail catches
 * its own errors, as the spawn flush does).
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
  mayStart: () => boolean = () => true
): Promise<void> {
  let next = 0;
  const worker = async () => {
    // Once `mayStart` says no, nothing more is started and the unstarted items are left to the caller; one already
    // running finishes.
    while (next < items.length && (next === 0 || mayStart())) await task(items[next++]!);
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

/** Sets `key`, and drops the oldest entries first while `map` holds more than `max` (a Map iterates in insertion order). */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size <= max) return;
  for (const oldest of map.keys()) {
    if (map.size <= max) break;
    map.delete(oldest);
  }
}

/**
 * Main-thread time one spawn flush pass may use before it starts no new receiver (the rest wait for the next
 * pass 50 ms later). A login wave can hand one receiver 50 spawns in a single synchronous chunk; this keeps a
 * pass of many such receivers from stalling the tick. A receiver already started always finishes its batch.
 */
export const SPAWN_FLUSH_BUDGET_MS = 12;

/**
 * One spawn flush pass over every receiver queued now. Each receiver's entry is claimed before `flushOne` runs
 * (see the protocol above) and restored if `flushOne` throws. Receivers start in queue order, `concurrency` at a
 * time; once `budgetMs` has passed on `now()` since the pass began, no further receiver starts and the unstarted
 * ones stay queued, untouched and in order, for the next pass. The first receiver always starts.
 */
export async function flushSpawnQueue(
  queue: Map<string, Map<string, any>>,
  flushOne: (receiverId: string, claimed: Map<string, any>) => Promise<void>,
  concurrency: number,
  budgetMs: number = SPAWN_FLUSH_BUDGET_MS,
  now: () => number = () => performance.now()
): Promise<void> {
  const began = now();
  await runBounded(
    Array.from(queue.keys()),
    concurrency,
    async (receiverId) => {
      const claimed = claimBatchEntry(queue, receiverId);
      if (!claimed || claimed.size === 0) return;
      try {
        await flushOne(receiverId, claimed);
      } catch (error) {
        // A claimed batch is never lost to an exception: put it back so the next pass retries.
        requeueSpawnBatch(queue, receiverId, claimed);
      }
    },
    () => now() - began < budgetMs
  );
}
