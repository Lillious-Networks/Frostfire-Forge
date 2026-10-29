import layerManager from "../services/layermanager";
import playerCache from "../services/playermanager";
import type { GhostKindName } from "./ghosts";

// Read-only copies of entities a neighbouring node owns (spec §3). They live
// apart from the node's own entities (players never enter playerCache), so the
// save loop, regen, online counts and every other "players on this node" loop
// cannot reach them. Code that wants a player whether local or mirrored asks
// entityById.

export interface MirrorEntry {
  kind: GhostKindName;
  id: string | number;
  /** The id's u32 (linkproto idNumber): the key GHOST_MOVE datagrams use. */
  num: number;
  /** The node it came from; only that node may move, change or remove it. */
  from: string;
  /** When it was last spawned or sent again. */
  confirmedAt: number;
}

export class MirrorStore {
  private byNum = new Map<number, MirrorEntry>();
  private byPeer = new Map<string, Set<number>>();

  set(entry: MirrorEntry): void {
    const old = this.byNum.get(entry.num);
    if (old && old.from !== entry.from) this.forget(old.from, entry.num);
    this.byNum.set(entry.num, entry);
    let nums = this.byPeer.get(entry.from);
    if (!nums) this.byPeer.set(entry.from, (nums = new Set()));
    nums.add(entry.num);
  }

  get(num: number): MirrorEntry | undefined {
    return this.byNum.get(num);
  }

  remove(num: number): MirrorEntry | undefined {
    const entry = this.byNum.get(num);
    if (!entry) return undefined;
    this.byNum.delete(num);
    this.forget(entry.from, num);
    return entry;
  }

  /** Drops `num` from a peer's set, and the set once it is empty. */
  private forget(peer: string, num: number): void {
    const nums = this.byPeer.get(peer);
    if (!nums) return;
    nums.delete(num);
    if (nums.size === 0) this.byPeer.delete(peer);
  }

  fromPeer(peer: string): MirrorEntry[] {
    const out: MirrorEntry[] = [];
    for (const num of this.byPeer.get(peer) ?? []) {
      const entry = this.byNum.get(num);
      if (entry) out.push(entry);
    }
    return out;
  }

  all(): MirrorEntry[] {
    return [...this.byNum.values()];
  }

  get size(): number {
    return this.byNum.size;
  }

  clear(): void {
    this.byNum.clear();
    this.byPeer.clear();
  }
}

/** Player mirrors by id: player-shaped records with `remote: true` and no `wt` (filled by the player kind). */
export const mirrorPlayers = new Map<string, any>();

/** A player by id, local first, else a mirror. For read sites only (AOI, spawn and movement sends, animation). */
export function entityById(id: string | number): any {
  return playerCache.get(String(id)) ?? mirrorPlayers.get(String(id));
}

/** The layer of a player, local or mirrored: mirrors are never registered with layerManager. */
export function playerLayer(id: string | number): string | null | undefined {
  const mirror = mirrorPlayers.get(String(id));
  return mirror ? mirror.aoi?.layerId ?? null : layerManager.getPlayerLayer(String(id));
}

/** A map name without its ".json": a mirror's map is bare, a local player's may not be. */
export function bareMap(map: unknown): string {
  return String(map ?? "").replace(/\.json$/, "");
}

/** The mirror of a player here, by username, any case (a chat line or a trade names its player). */
export function mirrorByUsername(username: string): any {
  const name = String(username ?? "").toLowerCase();
  if (!name) return undefined;
  for (const mirror of mirrorPlayers.values()) if (String(mirror?.username ?? "").toLowerCase() === name) return mirror;
  return undefined;
}

/** The node a mirrored player came from: where an action on it is sent. Null when it is not a mirror. */
export function mirrorOwner(id: string | number): string | null {
  return mirrorPlayers.get(String(id))?.mirrorFrom ?? null;
}

/** Mirrored players on `map` within `radius` of (x, y). Callers that care about layers filter by playerLayer. */
export function mirrorsNearPoint(map: string, x: number, y: number, radius: number): any[] {
  const bare = bareMap(map);
  const radiusSquared = radius * radius;
  const out: any[] = [];
  for (const mirror of mirrorPlayers.values()) {
    if (bareMap(mirror?.location?.map) !== bare) continue;
    const position = mirror?.location?.position;
    if (!position) continue;
    const dx = (position.x ?? 0) - x;
    const dy = (position.y ?? 0) - y;
    if (dx * dx + dy * dy <= radiusSquared) out.push(mirror);
  }
  return out;
}

/**
 * The mirrored players a local query on a layer would also find: on `map`, within `radius` of (x, y), on
 * `layerId`. Undefined means every layer, as it does for getPlayersNearPoint.
 */
export function mirrorsOnLayerNear(map: string, x: number, y: number, radius: number, layerId: string | null | undefined): any[] {
  if (mirrorPlayers.size === 0) return [];
  const near = mirrorsNearPoint(map, x, y, radius);
  return layerId === undefined ? near : near.filter((mirror) => (mirror.aoi?.layerId ?? null) === layerId);
}

/** A kind's remote copies (loot, chests, skeletons, zones, tornadoes, gathering nodes): kept beside the local ones. */
export class RemoteObjects<T extends { id: string | number }> {
  private items = new Map<string, T>();

  set(item: T): void { this.items.set(String(item.id), item); }
  get(id: string | number): T | undefined { return this.items.get(String(id)); }
  delete(id: string | number): T | undefined {
    const item = this.items.get(String(id));
    this.items.delete(String(id));
    return item;
  }
  values(): IterableIterator<T> { return this.items.values(); }
  /** Those on a map; a strip holds few, so a scan is enough. */
  onMap(map: string, mapOf: (item: T) => string): T[] {
    const out: T[] = [];
    for (const item of this.items.values()) if (mapOf(item) === map) out.push(item);
    return out;
  }
  get size(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
}
