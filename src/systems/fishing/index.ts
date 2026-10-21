/**
 * Fishing wired to the engine (USER REQUEST 2026-10-20, see catches.ts): the fishable tiles kept in the database, the
 * fishable tile under a point of any map, and the rules of a cast. The cast itself (the pose, the bite, the catch)
 * is run by the receiver (castFish), as a gather is.
 *
 * A player clicks a fishable tile within FISH_RANGE: the bobber lands there, a fish bites after BITE_MIN_MS to
 * BITE_MAX_MS, and the player reels it in. The client draws the line and the reel; the server only takes the catch once
 * the fish has been on the line for MIN_REEL_MS. A fish not reeled within BITE_ESCAPE_MS of its bite, or not landed
 * within HOOKED_MAX_MS of the reel starting, gets away.
 *
 * The tiles are rows of fishing_tiles, one per tile: its tileset key, its id there, and its catches as JSON. Every
 * player is sent which tiles are fishable (FISHING_TILES) at login and after every save; only the editor is sent what
 * they give.
 */
import query from "../../controllers/sqldatabase";
import log from "../../modules/logger";
import { serverFetch } from "../../modules/https_servers";
import { getIconUrl } from "../../modules/spriteSheetManager";
import { getWorldMap, type WorldMap } from "../../modules/worldmaps";
import assetCache from "../../services/assetCache";
import { tableCache } from "../../services/datacache";
import { Events, listener } from "../events";
import {
  fishingSpotInChunk, fishingSpotInMap, readFishingChanges, type Catch, type FishingChange, type FishingSpot, type FishingTiles, type FishingTools,
} from "./catches";

export * from "./catches";

/** How far from the player a cast may land (px, from the player's position to the bobber). */
export const FISH_RANGE = 256;
/**
 * How far a fishing player may walk from where they cast before the line is taken in (px; USER REQUEST 2026-10-20: "My
 * player should be able to move a short distance while fishing").
 */
export const FISH_WALK_RANGE = 64;
/** How long the bobber floats before a fish bites, at least and at most (ms). */
export const BITE_MIN_MS = 3000, BITE_MAX_MS = 10000;
/** How long a fish must be on the line before it can be landed (ms): the client's reel takes longer. */
export const MIN_REEL_MS = 1000;
/** A fish not landed this long after the reel began gets away (ms). */
export const HOOKED_MAX_MS = 60000;
/**
 * A fish the player does not start reeling in this long after it bit gets away (ms; USER REQUEST 2026-10-20: "if the
 * line doesn't start reeling in for 5 seconds, make the fish get away"). The bobber comes up again and the line stays
 * out: another fish may bite.
 */
export const BITE_ESCAPE_MS = 5000;
/**
 * How long the staff stays in hand after the line ends (ms): the clients draw a caught fish swung up to its tip
 * (fishing.ts YANK_S, 550 ms), or an empty line's bobber drawn back to it (RETRIEVE_S, 350 ms), before the pose goes,
 * with room for the packets' way and the clients' frames (USER REPORT 2026-10-20: the rod "completely disappears before
 * the line is finished being reeled in").
 */
export const CATCH_HOLD_MS = 950, LINE_IN_MS = 700;

const sqlite = (): boolean => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";
const normMap = (map: unknown) => String(map ?? "").replaceAll(".json", "");

/** The table, as the setup scripts make it. */
export const FISHING_TILES_TABLE: Record<"mysql" | "sqlite", string> = {
  mysql: `CREATE TABLE IF NOT EXISTS fishing_tiles (
    tileset VARCHAR(64) NOT NULL,
    tile_id INT NOT NULL,
    catches TEXT NOT NULL,
    tools TEXT NULL,
    PRIMARY KEY (tileset, tile_id)
  )`,
  sqlite: `CREATE TABLE IF NOT EXISTS fishing_tiles (
    tileset TEXT NOT NULL,
    tile_id INTEGER NOT NULL,
    catches TEXT NOT NULL,
    tools TEXT,
    PRIMARY KEY (tileset, tile_id)
  )`,
};

let ready = false;

/** Whether fishing_tiles has its tools column (added after the table was). */
async function hasToolsColumn(): Promise<boolean> {
  if (sqlite()) {
    const found = (await query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fishing_tiles'`)) as any[];
    return /\btools\b/.test(String(found?.[0]?.sql || ""));
  }
  const found = (await query(
    `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fishing_tiles' AND COLUMN_NAME = 'tools'`
  )) as any[];
  return Number(found?.[0]?.count) > 0;
}

/**
 * Start-time safety step: makes the table, and its tools column, on a database whose setup ran before they were added.
 * Safe on every start, and never throws: without the table, nothing is fishable and a save is refused. The tiles saved
 * before the column was added name no tools, so they cannot be fished until the map editor gives them some.
 */
export async function ensureFishingSchema(): Promise<boolean> {
  ready = false;
  try {
    await query(FISHING_TILES_TABLE[sqlite() ? "sqlite" : "mysql"]);
    if (!(await hasToolsColumn())) {
      try {
        await query(`ALTER TABLE fishing_tiles ADD COLUMN tools TEXT${sqlite() ? "" : " NULL"}`);
      } catch (error) {
        // another realm starting at the same moment may have added it first
        if (!(await hasToolsColumn())) throw error;
      }
    }
    ready = true;
  } catch (error) {
    log.warn(`[Fishing] The fishing_tiles table could not be made, so nothing can be fished: ${error}`);
  }
  return ready;
}

interface Row { tileset: string; tile_id: number; catches: string; tools: string | null }

const rows = tableCache<Row>("fishing_tiles", async () =>
  ready ? (((await query(`SELECT tileset, tile_id, catches, tools FROM fishing_tiles`)) as Row[]) || []) : []
);

/** A JSON list as written, or null when it cannot be read as one. */
function listOf(text: unknown): unknown[] | null {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The rows as two lists: what each tile gives, and what fishes it (a row whose catches cannot be read is left out). */
function fromRows(list: Row[]): { tiles: FishingTiles; tools: FishingTools } {
  const out: FishingTiles = {};
  const fishedWith: FishingTools = {};
  for (const row of list) {
    const parsed = listOf(row.catches);
    if (!parsed) continue;
    const entries: Catch[] = parsed
      .filter((entry: any) => typeof entry?.item === "string" && Number(entry?.chance) > 0)
      .map((entry: any) => ({ item: String(entry.item), chance: Number(entry.chance) }));
    if (!entries.length) continue;
    const key = String(row.tileset).toLowerCase(), id = String(Number(row.tile_id));
    (out[key] ??= {})[id] = entries;
    (fishedWith[key] ??= {})[id] = (listOf(row.tools) ?? []).filter((tool): tool is string => typeof tool === "string" && !!tool.trim());
  }
  return { tiles: out, tools: fishedWith };
}

let tiles: FishingTiles = {};
let tools: FishingTools = {};

/** Reads the list again from the cache (start, saves, and now and then: another realm on the database may have saved). */
export async function refreshTiles(): Promise<FishingTiles> {
  ({ tiles, tools } = ready ? fromRows(await rows.all()) : { tiles: {}, tools: {} });
  return tiles;
}

/** What fishes every fishable tile. */
export function getFishingTools(): FishingTools {
  return tools;
}

/** Every fishable tile and what it gives. */
export function getFishingTiles(): FishingTiles {
  return tiles;
}

/** Which tiles are fishable, without what they give: what every player is sent. */
export function publicTiles(): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [key, row] of Object.entries(tiles)) out[key] = Object.keys(row).map(Number).sort((a, b) => a - b);
  return out;
}

/** Who may save: the same as for saving a map or tile sounds. */
export function mayEditFishing(perms: string[]): boolean {
  return perms.includes("server.admin") || perms.includes("server.*");
}

const SAVE_ROWS = 500;

/** Write the changes, then read the list again. Returns it as it is now. Throws when the database refuses. */
export async function saveFishing(changes: FishingChange[]): Promise<FishingTiles> {
  if (!ready) throw new Error("the fishing_tiles table is missing");
  try {
    for (const change of changes) {
      for (let at = 0; at < change.ids.length; at += SAVE_ROWS) {
        const ids = change.ids.slice(at, at + SAVE_ROWS);
        if (change.catches === null) {
          await query(`DELETE FROM fishing_tiles WHERE tileset = ? AND tile_id IN (${ids.map(() => "?").join(", ")})`, [change.tileset, ...ids]);
          continue;
        }
        const json = JSON.stringify(change.catches), toolsJson = JSON.stringify(change.tools);
        const values = ids.map(() => "(?, ?, ?, ?)").join(", ");
        const params = ids.flatMap((id) => [change.tileset, id, json, toolsJson]);
        await query(
          sqlite()
            ? `INSERT OR REPLACE INTO fishing_tiles (tileset, tile_id, catches, tools) VALUES ${values}`
            : `INSERT INTO fishing_tiles (tileset, tile_id, catches, tools) VALUES ${values} ON DUPLICATE KEY UPDATE catches = VALUES(catches), tools = VALUES(tools)`,
          params
        );
      }
    }
  } catch (error) {
    // part of it may have been written: the next read takes the table as it is
    await rows.drop();
    throw error;
  }
  await rows.reload();
  await refreshTiles();
  return tiles;
}

// ------------------------------------------------------------------ items

/** item name (lower case) -> item, of the material items only: what can be caught. */
let materials = new Map<string, any>();
/** item name (lower case) -> item, of the weapons only (equipable in the weapon slot): what can fish. */
let weapons = new Map<string, any>();

async function refreshItems(): Promise<void> {
  const list = ((await assetCache.get("items")) || []) as any[];
  const byName = (keep: (item: any) => boolean) => new Map(list.filter((item) => item?.name && keep(item)).map((item) => [String(item.name).toLowerCase(), item]));
  materials = byName((item) => item.type === "material");
  weapons = byName((item) => !!item.equipable && Number(item.equipable) !== 0 && String(item.equipment_slot).toLowerCase() === "weapon");
}

/** A material item's own name for a name in any case, or null. */
export function materialName(name: string): string | null {
  const item = materials.get(String(name).toLowerCase());
  return item ? String(item.name) : null;
}

/** A weapon's own name for a name in any case, or null: what a tile can be fished with. */
export function weaponName(name: string): string | null {
  const item = weapons.get(String(name).toLowerCase());
  return item ? String(item.name) : null;
}

/** The icon a caught item is drawn with. */
export function iconOf(item: string): string | null {
  return getIconUrl(materials.get(item.toLowerCase())?.icon ?? null);
}

/** A caught item's quality: the colour its name is shown in. */
export function qualityOf(item: string): string {
  return String(materials.get(item.toLowerCase())?.quality || "common");
}

type EditorItem = { name: string; image: string | null; quality: string | null };

/**
 * What the editor is sent: every fishable tile with its catches and what fishes it, the material items to pick catches
 * from, and the weapons to pick what fishes from.
 */
export async function editorData(): Promise<{ tiles: FishingTiles; tools: FishingTools; items: EditorItem[]; weapons: EditorItem[] }> {
  await refreshItems();
  const listed = (from: Map<string, any>): EditorItem[] => [...from.values()]
    .map((item) => ({ name: String(item.name), image: getIconUrl(item.icon ?? null), quality: item.quality ? String(item.quality) : null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { tiles, tools, items: listed(materials), weapons: listed(weapons) };
}

/** Make sure the item list is fresh before a save is read. */
export const loadItems = refreshItems;

// ------------------------------------------------------------- the tiles

/** A world's chunks, as the asset server sends them, kept a while: a world's tiles are not held on this server. */
const CHUNK_TTL_MS = 5 * 60_000, CHUNKS_KEPT = 128;
const chunks = new Map<string, { at: number; chunk: Promise<any | null> }>();

function worldChunk(world: WorldMap, cx: number, cy: number): Promise<any | null> {
  const key = `${world.id}:${cx}:${cy}`;
  const now = Date.now();
  const held = chunks.get(key);
  if (held && now - held.at < CHUNK_TTL_MS) {
    // the newest used stay longest
    chunks.delete(key);
    chunks.set(key, held);
    return held.chunk;
  }
  const base = process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL || "http://localhost:8081";
  const chunk = serverFetch(`${base}/map-chunk?map=${encodeURIComponent(world.name)}&x=${cx}&y=${cy}&size=${world.chunkSize}`)
    .then((response) => (response.ok ? response.json() : null))
    .catch((error) => {
      log.warn(`[Fishing] Chunk ${cx}, ${cy} of ${world.id} could not be read: ${error}`);
      return null;
    });
  chunks.set(key, { at: now, chunk });
  // a chunk that failed is asked for again next time
  chunk.then((value) => { if (!value && chunks.get(key)?.chunk === chunk) chunks.delete(key); });
  while (chunks.size > CHUNKS_KEPT) chunks.delete(chunks.keys().next().value!);
  return chunk;
}

/** Forget a world's chunks (after a save of it). */
export function forgetMap(mapName: string): void {
  const id = normMap(mapName);
  for (const key of [...chunks.keys()]) if (key.startsWith(`${id}:`)) chunks.delete(key);
}

/** The fishable tile at a world point (px) of a map, or null. */
export async function spotAt(mapName: string, x: number, y: number): Promise<FishingSpot | null> {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || !Object.keys(tiles).length) return null;
  const name = normMap(mapName);
  const world = getWorldMap(name);
  if (world) {
    const tx = Math.floor(x / world.tileWidth), ty = Math.floor(y / world.tileHeight);
    if (tx >= world.width || ty >= world.height) return null;
    const size = world.chunkSize, cx = Math.floor(tx / size), cy = Math.floor(ty / size);
    const chunk = await worldChunk(world, cx, cy);
    return chunk ? fishingSpotInChunk(chunk, tx - cx * size, ty - cy * size, world.map.data.tilesets || [], tiles, tools) : null;
  }
  const maps = ((await assetCache.get("maps")) || []) as any[];
  const map = maps.find((m: any) => m?.name === `${name}.json`)?.data;
  return map ? fishingSpotInMap(map, x, y, tiles, tools) : null;
}

// ---------------------------------------------------------------- sessions

/** A player's cast: where the bobber is, what it gives, and when the fish bit (0 while none has). */
export interface FishingSession {
  castId: number;
  map: string;
  from: { x: number; y: number };
  x: number;
  y: number;
  spot: FishingSpot;
  /** The weapon the line was cast with: unequipping it takes the line in. */
  tool: string;
  item: string | null;
  bitAt: number;
  /** When the player began reeling the fish in (FISH_REEL), 0 while they have not. */
  reeledAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, FishingSession>();

export function session(playerId: string): FishingSession | undefined {
  return sessions.get(playerId);
}

/** Every cast out now, by player id. */
export function allSessions(): Array<[string, FishingSession]> {
  return [...sessions];
}

export function startSession(playerId: string, value: FishingSession): void {
  endSession(playerId);
  sessions.set(playerId, value);
}

/** Ends a player's cast, if they are in one; returns it. */
export function endSession(playerId: string): FishingSession | undefined {
  const held = sessions.get(playerId);
  if (!held) return undefined;
  if (held.timer) clearTimeout(held.timer);
  sessions.delete(playerId);
  return held;
}

/** How long a cast floats before a fish bites (`r`: from 0 up to 1). */
export const biteDelay = (r: number) => Math.round(BITE_MIN_MS + (BITE_MAX_MS - BITE_MIN_MS) * Math.min(Math.max(r, 0), 1));

let initialized = false;

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await refreshItems();
  await refreshTiles();
  let tick = 0;
  listener.on(Events.SERVER_TICK, () => {
    if (++tick % 30 !== 0) return;
    refreshItems().catch(() => {});
    refreshTiles().catch(() => {});
  });
  const leave = (payload: any) => {
    const id = payload?.player?.id;
    if (id) endSession(String(id));
  };
  listener.on(Events.PLAYER_LOGOUT, leave);
  listener.on(Events.PLAYER_DISCONNECT, leave);
  const count = Object.values(tiles).reduce((n, row) => n + Object.keys(row).length, 0);
  log.success(`Fishing started: ${count} fishable tile(s)`);
}

export default {
  init, ensureFishingSchema, refreshTiles, getFishingTiles, getFishingTools, publicTiles, mayEditFishing, readFishingChanges, saveFishing,
  materialName, weaponName, iconOf, qualityOf, editorData, loadItems, spotAt, forgetMap, session, allSessions, startSession, endSession, biteDelay,
  FISH_RANGE, FISH_WALK_RANGE, CATCH_HOLD_MS, LINE_IN_MS, BITE_MIN_MS, BITE_MAX_MS, MIN_REEL_MS, HOOKED_MAX_MS, BITE_ESCAPE_MS,
};
