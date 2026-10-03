import assetCache from "../services/assetCache";
import { packetManager } from "../socket/packet_manager";
import { getNpcSpriteLayers } from "../modules/spriteSheetManager";

/**
 * NPCs are streamed by map chunk instead of all at once on map entry: a player holds the NPCs of the chunks around
 * them (the same chunk size and window the client's map loader uses, client map.ts), gets the NPCs of chunks coming
 * into that window as they move and an unload for the ones leaving it, and, when nearing a warp, the NPCs around the
 * arrival point on the destination map ahead of time (the client keeps those until that map is loaded).
 */

/** Chunk size in tiles by tile size, as the client's map loader (client map.ts CHUNK_SIZE_CONFIG). */
const CHUNK_SIZE_CONFIG: Record<number, number> = { 16: 64, 32: 32, 64: 16 };
/** The client's chunk window: a 1920x1080 viewport plus one chunk of padding each side (client map.ts). */
const VIEW_W = 1920, VIEW_H = 1080;

interface StreamState { map: string; chunk: string; sent: Set<number> }
/** Per player id (kept here, not on the player object: the player cache may hand out copies). */
const streams = new Map<string, StreamState>();
type StreamPlayer = { id: string; location: { map: string; position: { x: number; y: number } } };

/** Forget a player's state (disconnect). */
export function forgetNpcStream(id: string): void {
  streams.delete(id);
}

const norm = (map: string) => String(map ?? "").replace(".json", "");

const geometryCache = new Map<string, { chunkPx: number; chunksX: number; chunksY: number }>();
async function geometry(map: string): Promise<{ chunkPx: number; chunksX: number; chunksY: number } | null> {
  const hit = geometryCache.get(norm(map));
  if (hit) return hit;
  const g = await mapGeometry(map);
  if (g) geometryCache.set(norm(map), g);
  return g;
}
async function mapGeometry(map: string): Promise<{ chunkPx: number; chunksX: number; chunksY: number } | null> {
  const maps = (await assetCache.get("maps")) as MapData[] | null;
  const m = (maps || []).find((x: MapData) => norm(x.name) === norm(map));
  if (!m) return null;
  const tw = m.data?.tilewidth || 32, size = CHUNK_SIZE_CONFIG[tw] || 32;
  return { chunkPx: size * tw, chunksX: Math.ceil((m.data?.width || 0) / size), chunksY: Math.ceil((m.data?.height || 0) / size) };
}

/** The chunk keys ("x,y") the client keeps loaded round a point, clamped to the map. */
function windowAround(g: { chunkPx: number; chunksX: number; chunksY: number }, x: number, y: number): Set<string> {
  const cx = Math.max(0, Math.min(Math.floor(x / g.chunkPx), g.chunksX - 1));
  const cy = Math.max(0, Math.min(Math.floor(y / g.chunkPx), g.chunksY - 1));
  const nx = Math.ceil((VIEW_W + g.chunkPx * 2) / g.chunkPx / 2), ny = Math.ceil((VIEW_H + g.chunkPx * 2) / g.chunkPx / 2);
  const out = new Set<string>();
  for (let dy = -ny; dy <= ny; dy++) for (let dx = -nx; dx <= nx; dx++) {
    const kx = cx + dx, ky = cy + dy;
    if (kx >= 0 && ky >= 0 && kx < g.chunksX && ky < g.chunksY) out.add(`${kx},${ky}`);
  }
  return out;
}

const chunkOf = (g: { chunkPx: number }, x: number, y: number) => `${Math.floor(x / g.chunkPx)},${Math.floor(y / g.chunkPx)}`;

async function npcsIn(map: string, g: { chunkPx: number }, keys: Set<string>): Promise<Npc[]> {
  const all = ((await assetCache.get("npcs")) || []) as Npc[];
  return all.filter((n) => norm(n.map) === norm(map) && n.id != null && keys.has(chunkOf(g, n.position.x, n.position.y)));
}

/** The client's NPC data (particle names resolved to their definitions), as the map-entry packets always sent it. */
export async function npcForClient(npc: Npc): Promise<any> {
  const particlesCache = (await assetCache.get("particles")) as Particle[] | null;
  const particles =
    typeof npc.particles === "string" && particlesCache
      ? (npc.particles as string).split(",").map((name) => particlesCache.find((p: Particle) => p.name === name.trim())).filter(Boolean)
      : [];
  return {
    id: npc.id,
    last_updated: npc.last_updated,
    name: npc.name || null,
    location: { x: npc.position.x, y: npc.position.y, direction: npc.position.direction || "down" },
    script: npc.script,
    hidden: npc.hidden,
    dialog: npc.dialog,
    gossip: npc.gossip || null,
    particles,
    map: npc.map,
    position: npc.position,
    sprite_type: npc.sprite_type,
    spriteLayers: getNpcSpriteLayers(npc),
  };
}

/**
 * Brings a player's NPCs up to date with the chunks round them: packets for the NPCs of chunks newly in range (one
 * LOAD_NPCS) and an UNLOAD_NPCS for those that left it. `reset`: the player has just entered the map (nothing held).
 * Cheap when the player has not changed chunk. Returns the packets to send (empty when nothing changed).
 */
export async function syncNpcChunks(player: StreamPlayer, reset = false): Promise<any[]> {
  const map = norm(player.location.map), { x, y } = player.location.position;
  const g = await geometry(map);
  if (!g) return [];
  const chunk = chunkOf(g, x, y);
  let st = streams.get(player.id);
  if (reset || !st || st.map !== map) { st = { map, chunk: "", sent: new Set() }; streams.set(player.id, st); }
  if (st.chunk === chunk) return [];
  st.chunk = chunk;
  const inRange = await npcsIn(map, g, windowAround(g, x, y));
  const keep = new Set(inRange.map((n) => n.id as number));
  const add = inRange.filter((n) => !st!.sent.has(n.id as number));
  const drop = [...st.sent].filter((id) => !keep.has(id));
  st.sent = keep;
  const packets: any[] = [];
  if (add.length) packets.push(...packetManager.loadNpcs(await Promise.all(add.map(npcForClient))));
  if (drop.length) packets.push(...packetManager.unloadNpcs(drop));
  return packets;
}

/**
 * The NPCs round a warp's arrival point on its destination map, sent ahead (the client holds them for that map until
 * it is loaded, and skips the ones it already has when the map's own NPCs arrive on entry).
 */
export async function preloadNpcsAt(_player: StreamPlayer, map: string, x: number, y: number): Promise<any[]> {
  const g = await geometry(map);
  if (!g) return [];
  const npcs = await npcsIn(map, g, windowAround(g, x, y));
  if (!npcs.length) return [];
  return packetManager.loadNpcs(await Promise.all(npcs.map(npcForClient)));
}
