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
