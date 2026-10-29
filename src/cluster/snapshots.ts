import log from "../modules/logger";
import type { ClusterStore } from "./store";
import { storeIsUp } from "./health";

// Where each player stands and how hurt they are, in Redis every 5 s (spec §7). The database is written on the
// save interval and at logout; a node that crashes loses what happened since. The next login reads the snapshot
// and the row and keeps the newer one (recovery.ts). A snapshot counts only under the owner epoch the database
// holds or a later one: a node that lost the player may write one more, and it is older than the claim that took
// the player away. Nothing in a snapshot is an item.

export const SNAPSHOT_EVERY_MS = 5_000;
/** Writes in flight at once: a node with thousands of players does not flood Redis. */
export const SNAPSHOT_CHUNK = 200;
/** Long past any crash a login could still recover from. */
export const SNAPSHOT_TTL_MS = 600_000;

export const snapshotKey = (username: string) => `cells:snap:${username.toLowerCase()}`;

export interface SnapshotStats { health: number; max_health: number; stamina: number; max_stamina: number }

export interface SavedSnapshot {
  epoch: number;
  at: number;
  username: string;
  /** Bare map name (no ".json"). */
  map: string;
  x: number;
  y: number;
  direction: string;
  stats: SnapshotStats | null;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const STAT_FIELDS = ["health", "max_health", "stamina", "max_stamina"] as const;

/** The directions a player can face (the movement and editor code's eight). */
export const SNAPSHOT_DIRECTIONS: ReadonlySet<string> = new Set(["down", "up", "left", "right", "downleft", "downright", "upleft", "upright"]);

/** A map's size in pixels, as the node loaded it (maps.ts MapExtent). */
export interface SnapshotMap { name: string; widthPx: number; heightPx: number }

// The maps this node has loaded, by bare name: a snapshot is read only on one of them, inside its size (security review
// H1). Set by startCluster; null before that, and then no snapshot is read at all.
let knownMaps: Map<string, SnapshotMap> | null = null;

/** The maps a snapshot may be on (startCluster, from the maps it loaded); null forgets them. Answers the ones set before. */
export function useSnapshotMaps(maps: Iterable<SnapshotMap> | Map<string, SnapshotMap> | null): Map<string, SnapshotMap> | null {
  const previous = knownMaps;
  if (maps === null || maps instanceof Map) knownMaps = maps;
  else knownMaps = new Map([...maps].map((map) => [map.name.replace(/\.json$/, ""), map]));
  return previous;
}

/** Whether `x`,`y` is a point inside `map` as this node knows it. */
function inside(map: SnapshotMap | undefined, x: number, y: number): boolean {
  return !!map && finite(map.widthPx) && finite(map.heightPx) && x >= 0 && y >= 0 && x <= map.widthPx && y <= map.heightPx;
}

function statsOf(stats: any): SnapshotStats | null {
  if (!stats || !STAT_FIELDS.every((field) => finite(stats[field]))) return null;
  return { health: stats.health, max_health: stats.max_health, stamina: stats.stamina, max_stamina: stats.max_stamina };
}

/** The snapshot of a player this node owns now, or null (no owner epoch, a handoff under way, no point). */
export function snapshotOf(player: any, at: number): SavedSnapshot | null {
  const epoch = player?.ownerEpoch;
  if (!finite(epoch) || epoch <= 0) return null;
  // During a handoff the player is the new node's to write once it arrives.
  if (player.handoff) return null;
  const username = typeof player.username === "string" ? player.username.toLowerCase() : "";
  const map = String(player.location?.map ?? "").replace(/\.json$/, "");
  const position = player.location?.position;
  if (!username || !map || !finite(position?.x) || !finite(position?.y)) return null;
  return {
    epoch, at, username, map,
    x: Math.round(position.x), y: Math.round(position.y),
    // Only a direction a reader takes (readSnapshot): any other is written as "down".
    direction: typeof position.direction === "string" && SNAPSHOT_DIRECTIONS.has(position.direction) ? position.direction : "down",
    stats: statsOf(player.stats),
  };
}

/**
 * The stored snapshot of `username`, or null when there is none or it is not one. The store seals snapshots
 * (storeseal.ts); besides, one is taken only for this player, on a map this node knows (`maps`, useSnapshotMaps
 * unless given), at a point inside that map's size, facing a known direction: anything else counts as none.
 */
export async function readSnapshot(store: Pick<ClusterStore, "get">, username: string, maps: Map<string, SnapshotMap> | null = knownMaps): Promise<SavedSnapshot | null> {
  const raw = await store.get(snapshotKey(username));
  if (!raw) return null;
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || !finite(value.epoch) || !finite(value.at) || typeof value.username !== "string" || typeof value.map !== "string") return null;
  if (!finite(value.x) || !finite(value.y) || typeof value.direction !== "string") return null;
  if (value.stats !== null && !statsOf(value.stats)) return null;
  // Guard (test "a snapshot of another player is not read for this one").
  if (value.username !== String(username ?? "").toLowerCase()) return null;
  // Guards (tests "a snapshot outside its map, on a map not known here, or facing no known way is not read").
  if (!SNAPSHOT_DIRECTIONS.has(value.direction)) return null;
  if (!inside(maps?.get(value.map), value.x, value.y)) return null;
  return {
    epoch: value.epoch, at: value.at, username: value.username, map: value.map, x: value.x, y: value.y,
    direction: value.direction, stats: value.stats === null ? null : statsOf(value.stats),
  };
}

/**
 * The snapshot when it is newer than the account's last fenced save; else null (the row is used). `stamp` is
 * player.saveStamp, read before this login claims the epoch.
 *
 * Owner epochs decide first (security review L1): a snapshot from an older epoch than the row's is older than the
 * claim that took the player away, and one from a later epoch is newer than any save of the row's epoch. Only within
 * one epoch are the times compared: both were then taken by the one node that owned the player, on its own clock, so
 * no two nodes' clocks are ever compared.
 */
export function chooseNewer(stamp: { ownerEpoch: number; savedAt: number } | null, snap: SavedSnapshot | null): SavedSnapshot | null {
  if (!stamp || !snap) return null;
  if (snap.epoch < stamp.ownerEpoch) return null;
  // Guard (test "a snapshot of a later owner epoch wins whatever the times say").
  if (snap.epoch > stamp.ownerEpoch) return snap;
  if (snap.at <= stamp.savedAt) return null;
  return snap;
}

export interface SnapshotWriterOptions {
  everyMs?: number;
  chunk?: number;
  ttlMs?: number;
  now?: () => number;
  /** Whether the store is up: a pass is skipped while it is not. The node's health (health.ts) unless given. */
  up?: () => boolean;
}

export class SnapshotWriter {
  private readonly everyMs: number;
  private readonly chunk: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly up: () => boolean;

  constructor(private readonly store: Pick<ClusterStore, "set">, private readonly players: () => Iterable<any>, opts: SnapshotWriterOptions = {}) {
    this.everyMs = opts.everyMs ?? SNAPSHOT_EVERY_MS;
    this.chunk = Math.max(1, opts.chunk ?? SNAPSHOT_CHUNK);
    this.ttlMs = opts.ttlMs ?? SNAPSHOT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.up = opts.up ?? storeIsUp;
  }

  /** One snapshot per owned player, `chunk` writes at a time. How many were written. */
  async writeAll(): Promise<number> {
    const at = this.now();
    const snaps: SavedSnapshot[] = [];
    for (const player of this.players()) {
      const snap = snapshotOf(player, at);
      if (snap) snaps.push(snap);
    }
    let written = 0;
    for (let i = 0; i < snaps.length; i += this.chunk) {
      const results = await Promise.allSettled(snaps.slice(i, i + this.chunk).map((snap) =>
        this.store.set(snapshotKey(snap.username), JSON.stringify(snap), this.ttlMs)));
      for (const result of results) {
        if (result.status === "fulfilled") written++;
      }
      const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) log.debug(`Snapshot writes failed: ${failed.reason}`);
    }
    return written;
  }

  start(): () => void {
    let writing = false;
    let paused = false;
    const timer = setInterval(() => {
      if (writing) return;
      // While the store is down every write fails: the pass is skipped, and the pause logged once.
      if (!this.up()) {
        if (!paused) log.warn("Snapshots pause: the cluster store is down");
        paused = true;
        return;
      }
      if (paused) log.info("Snapshots resume: the cluster store is back");
      paused = false;
      writing = true;
      this.writeAll()
        .catch((error) => log.error(`Snapshots: ${error}`))
        .finally(() => { writing = false; });
    }, this.everyMs);
    (timer as any).unref?.();
    return () => clearInterval(timer);
  }
}
