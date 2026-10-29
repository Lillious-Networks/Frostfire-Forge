import assetCache from "../services/assetCache";
import { packetManager } from "../socket/packet_manager";
import { getNpcSpriteLayers } from "../modules/spriteSheetManager";
import log from "../modules/logger";

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
/** The syncs running for a player id, so a sync that finishes after the player left drops its result. */
const running = new Map<string, Set<{ gone: boolean }>>();

/** Forget a player's state (disconnect). */
export function forgetNpcStream(id: string): void {
  streams.delete(id);
  for (const run of running.get(id) ?? []) run.gone = true;
}

/** How often a node re-reads the NPC and particle lists, to see an edit another node made (no signal crosses nodes). */
export const STATIC_LIST_REFRESH_MS = 30000;

/** The lists a node holds. npcs and particles stream to clients; mapProperties and spells are read on hot paths. */
export type ListKey = "npcs" | "particles" | "mapProperties" | "spells";
const LIST_KEYS: ListKey[] = ["npcs", "particles", "mapProperties", "spells"];
interface CacheLike {
  get(key: string): Promise<any>;
  onChange?(key: string, listener: () => void): void;
  /** Redis only: the value, or `same` when the stored text is the one `digest` was made of (nothing parsed then). */
  getIfChanged?(key: string, digest: string | null): Promise<{ digest: string; same: boolean; value?: any }>;
}
/** Where the lists come from; replaced only by tests. */
export const streamSource: { cache: CacheLike; redis: () => boolean } = {
  // Looks assetCache up at each call (not once at load), so whatever stands in for it, as a test's, is what is read.
  cache: {
    get: (key: string) => assetCache.get(key),
    onChange: (key: string, listener: () => void) => (assetCache as CacheLike).onChange?.(key, listener),
    get getIfChanged() { return (assetCache as CacheLike).getIfChanged?.bind(assetCache); },
  } as CacheLike,
  redis: () => (process.env.CACHE?.toLowerCase() || "memory") === "redis",
};

// With CACHE=redis every assetCache.get is a Redis GET, a JSON.parse and a deep copy of the whole list, and a new
// array each time. The NPC, particle, map property and spell lists are static content (definitions only, no per-player state), so a node
// keeps its own copy: the same array until the list changes. It is read again when this process writes the list
// (assetCache.onChange) and every STATIC_LIST_REFRESH_MS (a write by another node is not signalled). Readers only
// read it. With CACHE=memory the cache already hands out the stored array, and it is read straight from there.
interface Held { list: any[] | null; digest: string | null; loaded: boolean; dirty: boolean; version: number; loading: Promise<void> | null }
const newHeld = (): Held => ({ list: null, digest: null, loaded: false, dirty: true, version: 0, loading: null });
const newHeldAll = (): Record<ListKey, Held> => ({ npcs: newHeld(), particles: newHeld(), mapProperties: newHeld(), spells: newHeld() });
let held: Record<ListKey, Held> = newHeldAll();
const EMPTY: any[] = [];
const DEFER = Symbol("defer");
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function reloadList(key: ListKey): Promise<void> {
  const h = held[key];
  if (h.loading) return h.loading;
  h.loading = (async () => {
    try {
      for (;;) {
        const seen = h.version;
        let value: any;
        let same = false;
        try {
          if (streamSource.cache.getIfChanged) {
            const read = await streamSource.cache.getIfChanged(key, h.loaded ? h.digest : null);
            h.digest = read.digest;
            same = read.same;
            value = read.value;
          } else {
            value = await streamSource.cache.get(key);
          }
        } catch (err) {
          log.warn(`[npcstream] Could not read the ${key} list: ${err}`);
          if (h.loaded) h.dirty = false; // the last copy keeps being served; the next refresh tries again
          return;
        }
        // Unchanged text keeps the array, so the chunk index and the particle names built from it stay valid.
        if (!same) h.list = Array.isArray(value) ? value : null;
        h.loaded = true;
        if (h.version === seen) { h.dirty = false; return; }
      }
    } finally {
      h.loading = null;
    }
  })();
  return h.loading;
}

function listChanged(key: ListKey): void {
  const h = held[key];
  h.version++;
  h.dirty = true;
}

/** Reads the lists a node holds again, in the background. */
export function refreshStaticLists(): void {
  for (const key of LIST_KEYS) if (held[key].loaded) void reloadList(key);
}

function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshStaticLists();
    scheduleRefresh();
  }, STATIC_LIST_REFRESH_MS * (0.8 + Math.random() * 0.4));
  (refreshTimer as any).unref?.();
}

/** Listens for writes of the lists made by this process. */
function attachListeners(): void {
  for (const key of LIST_KEYS) streamSource.cache.onChange?.(key, () => listChanged(key));
}
attachListeners();
if (streamSource.redis()) {
  log.info(`[npcstream] The npcs, particles, mapProperties and spells lists are held in this process (read again on change and every ${STATIC_LIST_REFRESH_MS} ms)`);
}

/** Swaps the source of the lists and forgets what is held (tests). */
export function useStreamSource(cache: CacheLike, redis: () => boolean): void {
  streamSource.cache = cache;
  streamSource.redis = redis;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  held = newHeldAll();
  geometryCache.clear();
  geometryLoading.clear();
  mapsLoading = null;
  warming = null;
  attachListeners();
}

/**
 * A list for streaming: the held copy (the same array until the list changes). DEFER: it is not held yet or is out
 * of date, `mayWait` is false, and a read has been started; the caller tries again later instead of holding the
 * player's step on Redis.
 */
async function staticList(key: ListKey, mayWait: boolean): Promise<any[] | null | typeof DEFER> {
  if (!streamSource.redis()) return ((await streamSource.cache.get(key)) as any[] | null) ?? null;
  const h = held[key];
  scheduleRefresh();
  if (h.loaded && !h.dirty) return h.list;
  if (!mayWait) {
    void reloadList(key);
    return DEFER;
  }
  await reloadList(key);
  if (!h.loaded) throw new Error(`the ${key} list could not be read`);
  return h.list;
}

type ParticleLookup = (name: string) => Particle | undefined;
const particleNames = new WeakMap<Particle[], Map<string | null, Particle>>();
/** Finds a particle by name, the first of that name, as going through the list does. */
function particleLookup(list: Particle[] | null): ParticleLookup {
  if (!list) return () => undefined;
  if (!streamSource.redis()) return (name) => list.find((p: Particle) => p.name === name);
  let byName = particleNames.get(list);
  if (!byName) {
    byName = new Map();
    for (const p of list) if (!byName.has(p.name)) byName.set(p.name, p);
    particleNames.set(list, byName);
  }
  return (name) => byName!.get(name);
}
const usesParticles = (npc: Npc) => typeof npc.particles === "string";

const norm = (map: string) => String(map ?? "").replace(".json", "");

type Geometry = { chunkPx: number; chunksX: number; chunksY: number };
const geometryCache = new Map<string, Geometry>();
const geometryLoading = new Map<string, Promise<Geometry | null>>();
async function geometry(map: string): Promise<Geometry | null> {
  const hit = geometryCache.get(norm(map));
  if (hit) return hit;
  let loading = geometryLoading.get(norm(map));
  if (!loading) {
    loading = mapGeometry(map).then((g) => {
      if (g) geometryCache.set(norm(map), g);
      return g;
    }).finally(() => geometryLoading.delete(norm(map)));
    geometryLoading.set(norm(map), loading);
  }
  return loading;
}
/** The maps list (every map's data: a whole-cache read with CACHE=redis); readers that come while it is read share it. */
let mapsLoading: Promise<MapData[] | null> | null = null;
function mapsList(): Promise<MapData[] | null> {
  if (!mapsLoading) {
    const reading = Promise.resolve(streamSource.cache.get("maps") as Promise<MapData[] | null>).finally(() => {
      if (mapsLoading === reading) mapsLoading = null;
    });
    mapsLoading = reading;
  }
  return mapsLoading;
}
function geometryOf(m: MapData): Geometry {
  const tw = m.data?.tilewidth || 32, size = CHUNK_SIZE_CONFIG[tw] || 32;
  return { chunkPx: size * tw, chunksX: Math.ceil((m.data?.width || 0) / size), chunksY: Math.ceil((m.data?.height || 0) / size) };
}
async function mapGeometry(map: string): Promise<Geometry | null> {
  const maps = await mapsList();
  const m = (maps || []).find((x: MapData) => norm(x.name) === norm(map));
  return m ? geometryOf(m) : null;
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

// The NPCs of each map by chunk, as places in the NPC list. A large world carries a particle NPC on every lantern and
// crystal (some 190,000 on the 10240 x 10240 underworld), and going through the whole list each time a player
// crosses a chunk border took milliseconds per player. Built per NPC list: the list is replaced whenever an NPC is
// added, changed or removed (every write ends in assetCache.set("npcs", a new list)), never changed in place. With
// CACHE=redis the list is the one held in this process (see staticList), so the same array comes back until it changes.
const npcChunks = new WeakMap<Npc[], Map<string, Map<string, number[]>>>();

function npcsIn(all: Npc[], map: string, g: { chunkPx: number }, keys: Set<string>): Npc[] {
  let byMap = npcChunks.get(all);
  if (!byMap) {
    byMap = new Map();
    npcChunks.set(all, byMap);
  }
  const name = norm(map), id = `${name}|${g.chunkPx}`;
  let chunks = byMap.get(id);
  if (!chunks) {
    chunks = new Map();
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (n.id == null || norm(n.map) !== name) continue;
      const key = chunkOf(g, n.position.x, n.position.y);
      const list = chunks.get(key);
      if (list) list.push(i);
      else chunks.set(key, [i]);
    }
    byMap.set(id, chunks);
  }
  // in the order of the NPC list, as going through the whole list gave them
  const places: number[] = [];
  for (const key of keys) {
    const list = chunks.get(key);
    if (list) for (const i of list) places.push(i);
  }
  places.sort((a, b) => a - b);
  return places.map((i) => all[i]);
}

/** The client's NPC data (particle names resolved to their definitions), as the map-entry packets always sent it. */
export async function npcForClient(npc: Npc): Promise<any> {
  if (!usesParticles(npc)) return clientNpc(npc, particleLookup(null));
  const list = await staticList("particles", true);
  return clientNpc(npc, particleLookup(list === DEFER ? null : list));
}

function clientNpc(npc: Npc, findParticle: ParticleLookup): any {
  const particles = usesParticles(npc)
    ? (npc.particles as unknown as string).split(",").map((name) => findParticle(name.trim())).filter(Boolean)
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
    // Whether it sells things: an NPC that does can be talked to, though it has nothing to say. What it sells is sent when it is opened.
    vendor: Array.isArray(npc.vendor_items) && npc.vendor_items.length > 0,
    // Whether it keeps an inn: a reason to talk to it too.
    innkeeper: npc.innkeeper === true,
    // A sound NPC: draws nothing, and plays its sound to players within its radius.
    sound_npc: npc.sound_npc === true,
    sound: npc.sound_npc ? npc.sound ?? null : null,
    sound_radius: npc.sound_npc ? npc.sound_radius ?? 0 : 0,
  };
}

/**
 * Brings a player's NPCs up to date with the chunks round them: packets for the NPCs of chunks newly in range (one
 * LOAD_NPCS) and an UNLOAD_NPCS for those that left it. `reset`: the player has just entered the map (nothing held).
 * Cheap when the player has not changed chunk. Returns the packets to send (empty when nothing changed).
 * Without `reset` or `wait` (`wait`: a jump within the map, after which the player may stand still and nothing would
 * ask again), with CACHE=redis, it never waits on Redis: a map or list not held yet is read in the background and
 * the call returns nothing, to be asked again on the next scan (the player's chunk is not marked as done).
 */
export async function syncNpcChunks(player: StreamPlayer, reset = false, wait = false): Promise<any[]> {
  const run = { gone: false };
  const runs = running.get(player.id) ?? new Set();
  runs.add(run);
  running.set(player.id, runs);
  try {
    return await syncNow(player, reset, wait, run);
  } finally {
    runs.delete(run);
    if (!runs.size) running.delete(player.id);
  }
}

async function syncNow(player: StreamPlayer, reset: boolean, wait: boolean, run: { gone: boolean }): Promise<any[]> {
  const started = performance.now();
  const mayWait = reset || wait || !streamSource.redis();
  const map = norm(player.location.map), { x, y } = player.location.position;
  let g = geometryCache.get(map) ?? null;
  if (!g) {
    if (!mayWait) {
      void geometry(map).catch(() => {});
      return [];
    }
    g = await geometry(map);
  }
  if (!g) return [];
  const chunk = chunkOf(g, x, y);
  const current = streams.get(player.id);
  if (!reset && current && current.map === map && current.chunk === chunk) return [];

  const all = await staticList("npcs", mayWait);
  if (all === DEFER) return [];
  const inRange = npcsIn((all ?? EMPTY) as Npc[], map, g, windowAround(g, x, y));
  let particles: Particle[] | null = null;
  if (inRange.some(usesParticles)) {
    const list = await staticList("particles", mayWait);
    if (list === DEFER) return [];
    particles = list;
  }
  // Nothing is awaited from here: the player's state is read and written in one go.
  if (run.gone) return [];
  let st = streams.get(player.id);
  if (reset || !st || st.map !== map) { st = { map, chunk: "", sent: new Set() }; streams.set(player.id, st); }
  if (st.chunk === chunk) return [];
  st.chunk = chunk;
  const keep = new Set(inRange.map((n) => n.id as number));
  const add = inRange.filter((n) => !st!.sent.has(n.id as number));
  const drop = [...st.sent].filter((id) => !keep.has(id));
  st.sent = keep;
  const packets: any[] = [];
  if (add.length) {
    const find = particleLookup(particles);
    packets.push(...packetManager.loadNpcs(add.map((n) => clientNpc(n, find))));
  }
  if (drop.length) packets.push(...packetManager.unloadNpcs(drop));
  const elapsed = performance.now() - started;
  if (elapsed > 20) {
    log.debug(`[npcstream] ${player.id} chunk ${chunk} total=${elapsed.toFixed(1)}ms npcs=${all?.length ?? 0} particles=${particles?.length ?? 0} added=${add.length} dropped=${drop.length}`);
  }
  return packets;
}

/**
 * The NPCs round a warp's arrival point on its destination map, sent ahead (the client holds them for that map until
 * it is loaded, and skips the ones it already has when the map's own NPCs arrive on entry).
 */
export async function preloadNpcsAt(_player: StreamPlayer, map: string, x: number, y: number): Promise<any[]> {
  const g = await geometry(map);
  if (!g) return [];
  const all = await staticList("npcs", true);
  const npcs = npcsIn(((all === DEFER ? null : all) ?? EMPTY) as Npc[], map, g, windowAround(g, x, y));
  if (!npcs.length) return [];
  let particles: Particle[] | null = null;
  if (npcs.some(usesParticles)) {
    const list = await staticList("particles", true);
    particles = list === DEFER ? null : list;
  }
  const find = particleLookup(particles);
  return packetManager.loadNpcs(npcs.map((n) => clientNpc(n, find)));
}

/**
 * The NPC list for a caller that only reads it (a login send, a lookup by id): the array this process holds, loaded
 * once (callers that come before it is held share one load) and as fresh as the stream's copy: read again after a
 * write made here, and every STATIC_LIST_REFRESH_MS for a write by another node. The same array comes back until the
 * list changes, so a caller must never change it or an NPC in it (sort, push, splice, set a property); one that does,
 * or that reads to write back, takes the list from assetCache. With CACHE=memory it is what the cache holds.
 * Without it every call is a Redis GET, a JSON.parse of the whole world's NPCs and a deep copy on the main thread.
 */
export async function readNpcList(): Promise<Npc[]> {
  return ((await staticList("npcs", true)) as Npc[] | null) ?? [];
}

/**
 * A list for a caller that only reads it, on a per-tick, per-cast or per-login path: the array this process holds
 * (see readNpcList, which is this for "npcs"), or null when the cache has none. The same array comes back until the
 * list changes, so a caller must never change it or an object in it (sort, push, splice, set a property, hand an
 * object on to code that does); a caller that does, or that reads to write back, takes the list from assetCache.
 * With CACHE=memory it is what the cache holds, read on each call.
 */
export async function readHeldList<T = any>(key: ListKey): Promise<T[] | null> {
  return ((await staticList(key, true)) as T[] | null) ?? null;
}

let warming: Promise<void> | null = null;

/**
 * Loads, once and in the background, what the first player to reach a freshly started node would otherwise wait for:
 * the held NPC and particle lists (a parse of the whole world's lists), each map's chunk geometry and the NPCs-by-chunk
 * index of each map that has NPCs. Never throws: a step that fails is logged and the normal lazy load still works. It
 * shares the lists' and the maps' in-flight reads with a lazy caller, so nothing is read twice at once. A second call
 * while one runs returns the same promise.
 */
export function warmStreamData(): Promise<void> {
  if (warming) return warming;
  const run = (async () => {
    const started = performance.now();
    let npcs: any[] | null = null, particles: any[] | null = null;
    // started with the others: read in the same wait as the lists streaming needs
    const hot = (["mapProperties", "spells"] as ListKey[]).map((key) =>
      staticList(key, true).catch((err) => { log.warn(`[npcstream] Could not warm the ${key} list: ${err}`); }));
    const mapsRead = mapsList(); // started with the lists: a lazy reader that comes meanwhile shares all three reads
    mapsRead.catch(() => {});
    try { npcs = (await staticList("npcs", true)) as any[] | null; } catch (err) { log.warn(`[npcstream] Could not warm the npcs list: ${err}`); }
    try {
      particles = (await staticList("particles", true)) as any[] | null;
      particleLookup(particles); // builds the by-name index
    } catch (err) { log.warn(`[npcstream] Could not warm the particles list: ${err}`); }
    try {
      const maps = (await mapsRead) || [];
      const withNpcs = new Set<string>();
      for (const n of (npcs ?? EMPTY) as Npc[]) if (n.id != null) withNpcs.add(norm(n.map));
      for (const m of maps) {
        const name = norm(m.name);
        let g = geometryCache.get(name);
        if (!g) {
          g = geometryOf(m);
          geometryCache.set(name, g);
        }
        if (npcs && withNpcs.has(name)) npcsIn(npcs as Npc[], name, g, new Set()); // builds the chunk index
        await new Promise((resolve) => setImmediate(resolve)); // players and timers go on between maps
      }
    } catch (err) { log.warn(`[npcstream] Could not warm the map geometry: ${err}`); }
    await Promise.all(hot);
    log.info(`[npcstream] Warmed the npc and particle lists and the map chunk indexes in ${(performance.now() - started).toFixed(0)} ms`);
  })().catch((err) => { log.warn(`[npcstream] Warm-up failed: ${err}`); });
  warming = run;
  return run;
}

/** How long start-up waits for the warm-up; it keeps running in the background after that. */
export const WARM_START_CAP_MS = 30000;

/**
 * Start-up's wait for the warm-up: returns when it is done or after `capMs`, whichever is first (a cache read can wait
 * a long time while Redis reconnects). On the cap a warning is logged and the warm-up goes on in the background; its
 * in-flight loads stay shared with lazy reads. Never throws.
 */
export async function warmStreamDataWithin(capMs: number = WARM_START_CAP_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), capMs);
    (timer as any).unref?.();
  });
  try {
    const capped = await Promise.race([warmStreamData().then(() => false), cap]);
    if (capped) log.warn(`[npcstream] The warm-up is not done after ${capMs} ms; start-up goes on and it finishes in the background`);
  } catch (err) {
    log.warn(`[npcstream] Warm-up failed: ${err}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The array a list is held as, or null (tests). */
export function heldStaticList(key: ListKey): any[] | null {
  return held[key].list;
}
