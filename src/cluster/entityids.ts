import log from "../modules/logger";
import type { IdAllocator } from "./ids";

// Ids for what lives in the world: creatures, gathering nodes, loot, chests,
// death markers, ground zones and tornadoes. In a cluster they come from the
// node's IdAllocator, so no two nodes name different things alike and an entity
// that moves to another node keeps its id. On its own, a process-local counter
// does the same job.

let world: IdAllocator | null = null;
let local = 0;

// With no ids to give every spawner retries on its own tick, so one outage
// would log the same failure many times a second.
const NO_IDS_LOG_EVERY_MS = 10_000;
const noIdsLoggedAt = new Map<string, number>();

/** Called by startCluster: from now on ids come from the node's allocator. Null detaches it. */
export function useWorldIds(ids: IdAllocator | null): void {
  if (ids && local > 0) {
    // Local ids start at 1, as the first world block (block 0) does, so
    // anything already named by the local counter may share an id with a
    // later world entity.
    log.warn(`[Cluster] World ids attached after ${local} local entity id(s) were handed out: those may collide with world ids`);
  }
  world = ids;
}

/**
 * A number, not a string: creatures and gathering nodes are numbers on the client. Throws when the allocator has no
 * id to give (Redis was down while the block ran out); the caller skips that spawn and may try again later.
 */
export function nextEntityId(): number {
  return world ? world.next() : ++local;
}

/** Logs a failed id request as an error at most once per 10 s per call site (`site`). */
export function logNoIds(site: string, message: string, now: number = Date.now()): void {
  const last = noIdsLoggedAt.get(site);
  if (last !== undefined && now - last < NO_IDS_LOG_EVERY_MS) return;
  noIdsLoggedAt.set(site, now);
  log.error(message);
}

/** For tests: the local counter starts again and the allocator is let go. */
export function resetEntityIds(): void {
  world = null;
  local = 0;
  noIdsLoggedAt.clear();
}
