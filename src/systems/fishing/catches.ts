/**
 * Fishing (USER REQUEST 2026-10-20: "Fishing editor choose type of fish (multiple choice with % chance editable)
 * rewarded on what tile (similar to tileset sound editor) (item listed as material)").
 *
 * The map editor's Fishing tab gives tiles of a tileset what can be caught from them: a list of material items, each
 * with a chance. A tile is fishable when it has such a list, on every map that draws it, as the editor's footstep
 * sounds are kept (systems/tilesounds.ts): by tileset picture (the image's file name without its extension, in lower
 * case: "environment") and tile id in that tileset. This file holds what needs no server: reading an editor save,
 * applying it, rolling a catch, and finding the fishable tile at a point of a map.
 */

/** One thing a tile can give: an item and its chance, in percent. */
export interface Catch { item: string; chance: number }
/** tileset key -> tile id (as text) -> what can be caught there */
export type FishingTiles = Record<string, Record<string, Catch[]>>;
/** A save: these tiles of one tileset give these catches; null makes them not fishable. */
export interface FishingChange { tileset: string; ids: number[]; catches: Catch[] | null }
/** The fishable tile at a point: its tileset key, its id there, and what it gives. */
export interface FishingSpot { tileset: string; id: number; catches: Catch[] }

/** At most this many changes in one save, tiles in one change, and a tile id below MAX_TILE_ID (as for tile sounds). */
export const MAX_CHANGES = 64, MAX_IDS = 65536, MAX_TILE_ID = 1_000_000, MAX_KEY = 64;
/** At most this many catches on one tile, and a chance between these, in percent. */
export const MAX_CATCHES = 12, MIN_CHANCE = 0.01, MAX_CHANCE = 100;
const KEY_RE = /^[a-z0-9 ._-]+$/;
const GID_MASK = 0x1fffffff;

/** A tileset's key: its picture's file name without the extension, in lower case (the client's tilesounds.ts does the same). */
export function tilesetKey(tileset: any): string {
  const image = String(tileset?.image ?? "").split(/[\\/]/).pop() ?? "";
  return (image.replace(/\.[^.]+$/, "") || String(tileset?.name ?? "")).trim().toLowerCase();
}

/** A chance as kept: rounded to hundredths of a percent. */
const roundChance = (n: number) => Math.round(n * 100) / 100;

/**
 * A save as the editor sent it, made tidy (tileset names in lower case, each tile once, in order, item names as the
 * item list spells them), or what is wrong with it in words. `itemName` gives the item's own name for a name of a
 * material item in any case, and null for anything else.
 */
export function readFishingChanges(raw: unknown, itemName: (name: string) => string | null): { changes: FishingChange[] } | { error: string } {
  const list = (raw as any)?.changes;
  if (!Array.isArray(list) || list.length === 0) return { error: "Nothing to save." };
  if (list.length > MAX_CHANGES) return { error: `At most ${MAX_CHANGES} changes can be saved at once.` };
  const changes: FishingChange[] = [];
  for (const c of list) {
    const tileset = typeof c?.tileset === "string" ? c.tileset.trim().toLowerCase() : "";
    if (!tileset || tileset.length > MAX_KEY || !KEY_RE.test(tileset)) return { error: "A change names no valid tileset." };
    if (!Array.isArray(c.ids) || c.ids.length === 0 || c.ids.length > MAX_IDS) return { error: `Pick 1 to ${MAX_IDS.toLocaleString()} tiles.` };
    if (c.ids.some((id: unknown) => !Number.isInteger(id) || (id as number) < 0 || (id as number) >= MAX_TILE_ID)) return { error: "A tile id is not valid." };
    let catches: Catch[] | null = null;
    if (c.catches !== null && c.catches !== undefined) {
      if (!Array.isArray(c.catches) || c.catches.length === 0) return { error: "Add at least one catch, or make the tiles not fishable." };
      if (c.catches.length > MAX_CATCHES) return { error: `A tile gives at most ${MAX_CATCHES} catches.` };
      catches = [];
      const seen = new Set<string>();
      for (const entry of c.catches) {
        const name = typeof entry?.item === "string" ? itemName(entry.item.trim()) : null;
        if (!name) return { error: `${typeof entry?.item === "string" && entry.item.trim() ? entry.item.trim() : "A catch"} is not a material item.` };
        if (seen.has(name.toLowerCase())) return { error: `${name} is in the list twice.` };
        seen.add(name.toLowerCase());
        const chance = Number(entry?.chance);
        if (!Number.isFinite(chance) || chance < MIN_CHANCE || chance > MAX_CHANCE) return { error: `The chance of ${name} must be ${MIN_CHANCE} to ${MAX_CHANCE} %.` };
        catches.push({ item: name, chance: roundChance(chance) });
      }
    }
    changes.push({ tileset, ids: [...new Set<number>(c.ids)].sort((a, b) => a - b), catches });
  }
  return { changes };
}

/** The tiles with the changes made, in order (the tiles given are not changed). */
export function applyFishingChanges(base: FishingTiles, changes: FishingChange[]): FishingTiles {
  const out: FishingTiles = {};
  for (const [key, tiles] of Object.entries(base)) out[key] = { ...tiles };
  for (const c of changes) {
    const row = out[c.tileset] ?? (out[c.tileset] = {});
    for (const id of c.ids) {
      if (c.catches === null) delete row[String(id)];
      else row[String(id)] = c.catches.map((entry) => ({ ...entry }));
    }
    if (Object.keys(row).length === 0) delete out[c.tileset];
  }
  return out;
}

/**
 * One catch out of a tile's list, picked by chance (`r`: a number from 0 up to 1). The chances are weights: when they
 * do not add up to 100 %, each counts for its share of their sum, so a list always gives something.
 */
export function rollCatch(catches: Catch[], r: number): string | null {
  const total = catches.reduce((sum, entry) => sum + Math.max(0, entry.chance), 0);
  if (!(total > 0)) return null;
  let left = Math.min(Math.max(r, 0), 0.999999999) * total;
  for (const entry of catches) {
    left -= Math.max(0, entry.chance);
    if (left < 0) return entry.item;
  }
  return catches[catches.length - 1]?.item ?? null;
}

/** Which tileset a gid is drawn from: the one with the highest firstgid not above it. */
function tilesetOf(tilesets: any[], gid: number): any | null {
  let best: any = null;
  for (const ts of tilesets) {
    const first = Number(ts?.firstgid);
    if (Number.isFinite(first) && first <= gid && (!best || first > Number(best.firstgid))) best = ts;
  }
  return best;
}

/** The fishable tile a gid is, or null. */
function spotOf(tilesets: any[], gid: number, tiles: FishingTiles): FishingSpot | null {
  if (!gid) return null;
  const ts = tilesetOf(tilesets, gid);
  if (!ts) return null;
  const key = tilesetKey(ts), id = gid - Number(ts.firstgid);
  const catches = tiles[key]?.[String(id)];
  return catches && catches.length ? { tileset: key, id, catches } : null;
}

const skipped = (layer: any) => /collision|nopvp/i.test(String(layer?.name ?? ""));

/** Every tile layer of a Tiled map, groups opened, bottom first (the order they are drawn in). */
function tileLayers(layers: any[] | undefined, out: any[] = []): any[] {
  for (const layer of layers ?? []) {
    if (layer?.type === "group") tileLayers(layer.layers, out);
    else if (layer?.type === "tilelayer" && Array.isArray(layer.data) && !skipped(layer)) out.push(layer);
  }
  return out;
}

/**
 * The fishable tile at a world point (px) of a Tiled map held whole (the "maps" cache): of the tiles drawn there,
 * every layer but collision and no-pvp, the topmost that is fishable. A tile that is not, a lily pad on the water for
 * one, is passed over.
 */
export function fishingSpotInMap(map: any, x: number, y: number, tiles: FishingTiles): FishingSpot | null {
  const tw = Number(map?.tilewidth) || 16, th = Number(map?.tileheight) || 16;
  const tx = Math.floor(x / tw), ty = Math.floor(y / th);
  if (!(tx >= 0 && ty >= 0)) return null;
  let best: FishingSpot | null = null;
  for (const layer of tileLayers(map?.layers)) {
    const w = Number(layer.width) || Number(map?.width) || 0, h = Number(layer.height) || Number(map?.height) || 0;
    if (tx >= w || ty >= h) continue;
    const spot = spotOf(map?.tilesets ?? [], Number(layer.data[ty * w + tx]) & GID_MASK, tiles);
    if (spot) best = spot;
  }
  return best;
}

/**
 * The same for a chunk of a world as the asset server sends it (/map-chunk: layers with zIndex and data), at the
 * tile (lx, ly) inside the chunk. Ties of zIndex go to the layer listed later.
 */
export function fishingSpotInChunk(chunk: any, lx: number, ly: number, tilesets: any[], tiles: FishingTiles): FishingSpot | null {
  const w = Number(chunk?.width) || 0, h = Number(chunk?.height) || 0;
  if (!(lx >= 0 && ly >= 0 && lx < w && ly < h)) return null;
  let best: FishingSpot | null = null, bestZ = -Infinity;
  for (const layer of chunk?.layers ?? []) {
    if (!Array.isArray(layer?.data) || skipped(layer)) continue;
    const z = Number(layer.zIndex) || 0;
    const spot = spotOf(tilesets, Number(layer.data[ly * w + lx]) & GID_MASK, tiles);
    if (spot && z >= bestZ) { best = spot; bestZ = z; }
  }
  return best;
}

/** The eight ways a player faces, toward a point `dx`, `dy` away (screen axes: y grows downward). */
export function facingToward(dx: number, dy: number): string {
  if (!dx && !dy) return "down";
  const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return ["right", "downright", "down", "downleft", "left", "upleft", "up", "upright"][(sector + 8) % 8]!;
}
