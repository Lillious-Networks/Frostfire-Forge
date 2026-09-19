import log from "../modules/logger";

const SKELETON_TTL_MS = 15 * 60 * 1000;

export interface DeathSkeleton {
  id: string;
  username: string;
  map: string;
  /** Layer the death happened on; only players on it see the marker. */
  layerId: string | null;
  x: number;
  y: number;
  createdAt: number;
  expiresAt: number;
}

const skeletonList = new Map<string, DeathSkeleton>();
const despawnTimers = new Map<string, NodeJS.Timeout>();

let skeletonIdCounter = 0;
let onSpawn: ((skeleton: DeathSkeleton) => void) | null = null;
let onDespawn: ((skeleton: DeathSkeleton) => void) | null = null;

function generateId(): string {
  return `skeleton_${++skeletonIdCounter}_${Date.now()}`;
}

const skeletons = {
  setOnSpawn(fn: (skeleton: DeathSkeleton) => void): void {
    onSpawn = fn;
  },

  setOnDespawn(fn: (skeleton: DeathSkeleton) => void): void {
    onDespawn = fn;
  },

  spawn(map: string, x: number, y: number, username: string, layerId: string | null = null): DeathSkeleton | null {
    // Players only: this is the single choke point for marker creation and
    // entities have no username/account, so reject anything else here rather
    // than trusting every present and future call site.
    if (typeof username !== "string" || username.length === 0) return null;
    if (typeof map !== "string" || map.length === 0) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const now = Date.now();
    const skeleton: DeathSkeleton = {
      id: generateId(),
      username: username || "Unknown",
      map,
      layerId,
      x: Math.round(x),
      y: Math.round(y),
      createdAt: now,
      expiresAt: now + SKELETON_TTL_MS,
    };
    skeletonList.set(skeleton.id, skeleton);

    const timer = setTimeout(() => {
      skeletons.despawn(skeleton.id);
    }, SKELETON_TTL_MS);
    despawnTimers.set(skeleton.id, timer);

    log.debug(`Skeleton spawned for ${skeleton.username} on ${map} (${skeleton.x}, ${skeleton.y})`);
    if (onSpawn) onSpawn(skeleton);
    return skeleton;
  },

  despawn(id: string): DeathSkeleton | null {
    const skeleton = skeletonList.get(id);
    if (!skeleton) return null;

    const timer = despawnTimers.get(id);
    if (timer) clearTimeout(timer);
    despawnTimers.delete(id);
    skeletonList.delete(id);

    if (onDespawn) onDespawn(skeleton);
    return skeleton;
  },

  get(id: string): DeathSkeleton | undefined {
    return skeletonList.get(id);
  },

  /** Markers a viewer can see: same map, same layer (or layerless), in radius. */
  getInRadius(map: string, x: number, y: number, radius: number, layerId: string | null = null): DeathSkeleton[] {
    const result: DeathSkeleton[] = [];
    const expired: string[] = [];
    const now = Date.now();
    const r2 = radius * radius;
    for (const skeleton of skeletonList.values()) {
      if (skeleton.map !== map) continue;
      // A layerless marker predates layer tracking; show it to everyone.
      if (skeleton.layerId !== null && layerId !== null && skeleton.layerId !== layerId) continue;
      if (skeleton.expiresAt <= now) {
        expired.push(skeleton.id);
        continue;
      }
      const dx = skeleton.x - x;
      const dy = skeleton.y - y;
      if (dx * dx + dy * dy <= r2) {
        result.push(skeleton);
      }
    }
    for (const id of expired) {
      skeletons.despawn(id);
    }
    return result;
  },

  SKELETON_TTL_MS,
};

export default skeletons;
