import { packetTypes } from "./types";
import { packetManager } from "./packet_manager";
import log from "../modules/logger";
import player, { clearMapCache, hasLineOfSight } from "../systems/player.ts";
import permissions from "../systems/permissions";
import { getAuthWorker } from "./authentication_pool.ts";
import { listener } from "../modules/event_bus";
import { Events, setPlayerPvp } from "../systems/events";
import { collectReceiverEntries, encodeBatch, MoverSnapshot, ReceiverInfo } from "./movement_batch.ts";
import { queueLayerWorkerFlush, postToAllWorkers, setOnWorkerRetired } from "./movement_worker_pool.ts";
import { claimBatchEntry, requeueSpawnBatch, claimDespawnEntry, requeueDespawnEntry } from "./batch_queue_utils.ts";
const authentication_queue = new Set<string>();
const authentication_session_queue = new Set<string>();

const pendingAuthentications = new Map<string, { wt: any; token: string; language: string }>();

// Track current target for target cycling
const currentTargetMap = new Map<string, string | null>();

// Track who is being dragged by whom (draggedPlayerId -> adminId)
const draggedPlayersMap = new Map<number, number>();

// Track active tile editors per map (mapName -> Set<playerId>)
const chatRateLimit = new Map<number, number[]>();

/** Player-triggered NPC/quest packets share the chat-style rate limit bucket. */
const questRateLimit = new Map<string, number[]>();
const QUEST_RATE_MAX = 5;
const QUEST_RATE_WINDOW = 3000;
/** Must be within this distance (px) to talk to an NPC. Matches loot chests. */
const NPC_INTERACT_RADIUS = 120;

registerExploreHooks();
registerLevelUpHook();

function isQuestRateLimited(id: string): boolean {
  const now = Date.now();
  const hits = questRateLimit.get(id) || [];
  const fresh = hits.filter((t) => now - t < QUEST_RATE_WINDOW);
  fresh.push(now);
  questRateLimit.set(id, fresh);
  return fresh.length > QUEST_RATE_MAX;
}

async function sendQuestMarkersFor(wt: any, username: string, map: string): Promise<void> {
  try {
    const markers = await markersFor(username, String(map ?? "").replaceAll(".json", ""));
    sendPacket(wt, packetManager.questMarkers({ map: String(map ?? "").replaceAll(".json", ""), markers }));
  } catch {
    // Markers are best-effort.
  }
}

function questDefsForEntries(active: QuestLogEntry[], completed: number[]): Quest[] {
  const ids = new Set<number>([...active.map((e) => e.quest_id), ...completed]);
  const defs: Quest[] = [];
  for (const id of ids) {
    const q = questDefinitions.find(id);
    if (q) defs.push(q);
  }
  return defs;
}

const MAX_CHAT_LENGTH = 500;
const CHAT_RATE_MAX = 5;
const CHAT_RATE_WINDOW = 3000;
const activeEditorsByMap = new Map<string, Set<number>>();

// Track unsaved tile edits per map for syncing to new editors
const editorEditHistory = new Map<string, Array<{ senderId: number; mapName: string; edits: any[] }>>();

import playerCache from "../services/playermanager.ts";
import layerManager from "../services/layermanager";
import mapIndex from "../services/mapindex";
import gameLoop from "../services/gameloop";
import assetCache from "../services/assetCache";
import cooldownManager from "../services/cooldownmanager";
import effectManager from "../services/effectmanager";
import { reloadMap } from "../modules/assetloader";
import { serverFetch } from "../modules/https_servers.ts";
import language from "../systems/language";
import questDefinitions from "../systems/quests/definitions";
import questLogApi from "../systems/quests/log";
import { credit as creditObjective, trackRadiusPlayer } from "../systems/quests/objectives";
import { markersFor } from "../systems/quests/markers";
import * as questEditor from "../systems/quests/editor";
import { registerExploreHooks } from "../systems/quests/objectives";
import { registerLevelUpHook } from "../systems/quests/markers";
import friends from "../systems/friends";
import parties from "../systems/parties.ts";
import guilds from "../systems/guild.ts";
import spells from "../systems/spells";
import equipment from "../systems/equipment.ts";
import inventory from "../systems/inventory";
import particles from "../systems/particles";
import worlds from "../systems/worlds";
import npcSystem from "../systems/npcs";
import spellEffects, { registerSpellEffect, spellHasHostileEffects, cancelEffect, setStunsForPlayer, setSlowsForPlayer } from "../systems/spelleffects";
import dots from "../systems/dots";
import { rollHeal, spellManaCost } from "../systems/spellmath";
import creatures from "../systems/creatures";
import { projectileTravelMs } from "../systems/creatures/projectile";
import * as itemEditor from "../systems/itemeditor";
import { listSpriteSheets, listIcons } from "../systems/creatures/editor";
import { setCreatureEngineBridge } from "../systems/creatures/bridge";
import { spellMissChance } from "../systems/creatures/combat";
import { spawnZone, setPlayerDeathHandler, getZonesOnMap } from "../systems/groundaoe";
import bags from "../systems/bags";
import currencySystem from "../systems/currency";
import query from "../controllers/sqldatabase";
import loot from "../systems/loot";
import lootChest from "../systems/lootChest";
import lootTable from "../systems/lootTable";
import skeletons from "../systems/skeletons";
import * as resurrection from "../systems/resurrection";
const maps = await assetCache.get("maps");
const worldsCache = await assetCache.get("worlds") as WorldData[];
const mapPropertiesCache = await assetCache.get("mapProperties");
const resolvedWeatherCache = new Map<string, { weather: string; weatherData: WeatherData | null }>();
import { decryptPrivateKey, decryptRsa, _privateKey } from "../modules/cipher";

import * as settings from "../config/settings.json";
import AOI_CONFIG from "../config/aoi.json";
import { randomBytes } from "../modules/hash";
import { saveMapChunks, saveMapProperties, applyChunksWithRebase } from "../modules/assetloader";
import { getPlayerSpriteSheetData, isSpriteSheetSystemAvailable, getIconUrl, getMountSpriteUrl, getNpcSpriteLayers } from "../modules/spriteSheetManager";
import { setLayerChangeHandler, initializePlayerAOI, updatePlayerAOI, shouldUpdateAOI, broadcastToAOI, broadcastToAOIBestEffort, broadcastStatsUpdateToAOI, broadcastToAOIBestEffortAtPosition, handleMapChangeAOI, syncPartyLayers, queueSpawnPlayerPacket, broadcastPlayerUpdate, sendLoadPlayersChunked, cleanupKickedSession, aoiProf } from "./aoi";
import { realmWhitelist, isWhitelistEnabled } from "./server.ts";
const defaultMap = (settings as any).default_map?.replace(".json", "") || "main";

const useSpriteSheets = (settings as any).animation_system?.use_sprite_sheets ?? true;

// Resolve a spell's comma-separated particle names to full particle objects for projectile rendering
// Pass the latest particle cache so editor updates are reflected immediately.

function resolveSpellParticles(spell: SpellData, particleList: Particle[] | null): Particle[] | null {
  if (!spell?.particles || !particleList || particleList.length === 0) return null;
  const names = spell.particles.split(",").map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return null;
  const resolved = names
    .map((name) => particleList.find((p) => p.name && p.name.toLowerCase() === name.toLowerCase()))
    .filter((p): p is Particle => p != null);
  return resolved.length > 0 ? resolved : null;
}

async function resolveWorldWeather(worldName: string): Promise<{ weather: string; weatherData: WeatherData | null }> {
  const normalized = worldName.replace(".json", "");
  const worldsResult = await assetCache.get("worlds").catch(() => worldsCache) as WorldData[] | string;
  const worlds: WorldData[] = Array.isArray(worldsResult) ? worldsResult : JSON.parse(worldsResult as string);
  const world = worlds.find((w) => w.name === normalized);
  if (!world) return { weather: "clear", weatherData: null };

  const weatherName = world.weather || "clear";

  if (weatherName === "random") {
    const cached = resolvedWeatherCache.get(normalized);
    if (cached) return cached;

    const allWeathers = await assetCache.get("weather") as WeatherData[];
    if (allWeathers?.length) {
      const randomWeather = allWeathers[Math.floor(Math.random() * allWeathers.length)];
      const resolved = { weather: randomWeather.name, weatherData: randomWeather };
      resolvedWeatherCache.set(normalized, resolved);
      return resolved;
    }
    return { weather: "clear", weatherData: null };
  }

  if (weatherName === "clear") {
    return { weather: "clear", weatherData: null };
  }

  const allWeathers = await assetCache.get("weather") as WeatherData[];
  const weatherData = allWeathers?.find((w: WeatherData) => w.name === weatherName) || null;
  return { weather: weatherName, weatherData };
}

async function waitForSpritesReady() {
  if (!useSpriteSheets || !(await isSpriteSheetSystemAvailable())) {
    log.warn("Sprite sheet system not available");
    return;
  }
  log.success("Sprite system ready");
}

export const spriteDataCacheReady = waitForSpritesReady();

let restartScheduled: boolean;
let restartTimers: ReturnType<typeof setTimeout>[];

let globalStateRevision: number = 0;

export const pluginHandlers = new Map<string, PluginHandlerFn>();

export const warpInterceptors: Array<(warp: { map: string; x: number; y: number }, wt: any, player: any, sendPacket: (wt: any, packets: any[]) => void) => Promise<boolean>> = [];

export const packetInterceptors: Array<(type: string, data: any, wt: any, player: any) => boolean> = [];

export const movementBatchQueue = new Map<string, Map<string, any>>();

const receiverSetCache = new Map<string, { revision: number; receivers: Set<string> }>();

let flushOffset = 0;
let flushTick = 0;

// Per-receiver probe sequence numbers: loss accounting on the client requires
// a monotonic sequence for each receiver's own frame stream. A global counter
// would make every client count the other players' frames as "lost".
const movementProbeSeqs = new Map<string, number>();

// Per-layer worker pool: keeps the movement batch encoding off the main event
// loop.
const workerLayerSynced = new Set<string>();

setOnWorkerRetired((layerId: string) => {
  workerLayerSynced.delete(layerId);
});

// Packet type validation runs on every inbound packet; a Set lookup replaces
// building an array with Object.values() and scanning it with indexOf().
const validPacketTypes = new Set<string>(Object.values(packetTypes) as string[]);

// Movement direction offsets. The per-tick movement callback previously built
// a fresh 9-object literal every tick for every moving player; at 2000 movers
// @30Hz that was 540k object allocations per second. Offsets only depend on
// speed, and speed only changes on mount/slow, so the tables are memoized.
const DIRECTION_UNIT_OFFSETS: Record<string, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
  upleft: { dx: -1, dy: -1 },
  upright: { dx: 1, dy: -1 },
  downleft: { dx: -1, dy: 1 },
  downright: { dx: 1, dy: 1 },
};

// Direction validation for inbound MOVEXY; was an array literal rebuilt and
// linearly scanned on every movement packet.
const VALID_DIRECTIONS = new Set(Object.keys(DIRECTION_UNIT_OFFSETS));

const directionOffsetCache = new Map<number, Record<string, { dx: number; dy: number }>>();

function getDirectionOffsets(speed: number): Record<string, { dx: number; dy: number }> {
  const cached = directionOffsetCache.get(speed);
  if (cached) return cached;

  const table: Record<string, { dx: number; dy: number }> = {};
  for (const key in DIRECTION_UNIT_OFFSETS) {
    const unit = DIRECTION_UNIT_OFFSETS[key];
    table[key] = { dx: unit.dx * speed, dy: unit.dy * speed };
  }

  // Distinct speeds are few (base, mounted, and a handful of slow tiers), but
  // cap the cache so an unusual slowMultiplier stream can't grow it unbounded.
  if (directionOffsetCache.size < 64) {
    directionOffsetCache.set(speed, table);
  }
  return table;
}

const MAX_BUFFER_BACKPRESSURE = 1024 * 32; // 32KB - aggressive at high loads
// Spawn payloads are much larger than movement frames; gate them with a
// higher threshold - but keep it BELOW the transport's per-stream queue limit
// (~256KB) so bursty spawn batches can never destroy the stream.
const SPAWN_BACKPRESSURE_THRESHOLD = 1024 * 128; // 128KB

// Track recent flush latencies for adaptive batch scheduling
const LATENCY_HISTORY_SIZE = 5; // Keep last 5 flushes for fast recovery
const recentFlushLatencies: number[] = [];

/**
 * Calculate average flush latency from recent history
 */
function getAverageFlushLatency(): number {
  if (recentFlushLatencies.length === 0) return 0;
  const sum = recentFlushLatencies.reduce((a, b) => a + b, 0);
  return sum / recentFlushLatencies.length;
}

const BASE_INVENTORY_SLOTS = 25;

async function getBagBoundaries(username: string): Promise<number[]> {
  const boundaries: number[] = [BASE_INVENTORY_SLOTS];
  const bagRow = await bags.get(username);
  if (bagRow) {
    const items = await assetCache.get("items") as Item[];
    for (const slot of bags.SLOTS) {
      const itemName = bagRow[slot];
      if (itemName) {
        const item = Array.isArray(items) ? items.find((i: any) => i.name === itemName) : null;
        const bonus = item?.bag_slots != null ? Number(item.bag_slots) : 10;
        boundaries.push(boundaries[boundaries.length - 1] + bonus);
      }
    }
  }
  return boundaries;
}

function computeBagSlot(slot: number, boundaries?: number[]): number {
  if (slot == null || slot < BASE_INVENTORY_SLOTS) return 0;
  if (!boundaries || boundaries.length <= 1) return 0;
  for (let i = 1; i < boundaries.length; i++) {
    if (slot < boundaries[i]) return i;
  }
  return 0;
}

async function patchInventoryBagSlots(inv: any[], username: string): Promise<any[]> {
  if (!Array.isArray(inv)) return inv;
  const boundaries = await getBagBoundaries(username);
  return inv.map((item: any) => ({
    ...item,
    bag_slot: computeBagSlot(item.slot, boundaries),
  }));
}

async function getInventorySlots(player: any): Promise<number> {
  let slots = BASE_INVENTORY_SLOTS;
  const username = player?.username || player?.equipment?.username;
  if (username) {
    const bagRow = await bags.get(username);
    if (bagRow) {
      const items = await assetCache.get("items") as Item[];
      for (const slot of bags.SLOTS) {
        const itemName = bagRow[slot];
        if (itemName) {
          const item = Array.isArray(items) ? items.find((i: any) => i.name === itemName) : null;
          slots += item?.bag_slots != null ? Number(item.bag_slots) : 10;
        }
      }
    }
  }
  return slots;
}

// Event-loop lag: the single most honest measure of whether the one JS thread
// that runs all game logic is keeping up. A timer set for `PROBE_INTERVAL_MS`
// that actually fires `PROBE_INTERVAL_MS + N` late means the loop was blocked
// for N ms - by a long SERVER_TICK, GC, a synchronous burst, anything.
//
// This replaces the old process.cpuUsage() check, which divided busy time by
// the logical CPU count (20 on a typical box). Single-threaded work pegged at
// 100% of one core reported as ~5% "busy" and never tripped the throttle.
const LOOP_PROBE_INTERVAL_MS = 250;
let eventLoopLagMs = 0;
{
  let expected = performance.now() + LOOP_PROBE_INTERVAL_MS;
  setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - expected);
    // EMA so a single GC pause doesn't slam the throttle, but sustained lag
    // ramps it within a second or two.
    eventLoopLagMs = eventLoopLagMs * 0.6 + lag * 0.4;
    expected = now + LOOP_PROBE_INTERVAL_MS;
  }, LOOP_PROBE_INTERVAL_MS);
}

export function getEventLoopLagMs(): number {
  return eventLoopLagMs;
}

// Opt-in load diagnostics. `BENCHMARK_PROFILE=1` emits a one-line breakdown
// every 5s of where the single JS thread's time is going at scale, so a load
// test tells us the actual bottleneck instead of us guessing per run.
const PROFILE = process.env.BENCHMARK_PROFILE === "1" || process.env.BENCHMARK_PROFILE === "true";
const prof = {
  moveCbCount: 0,
  collisionMs: 0,
  aoiUpdateCount: 0,
  flushCount: 0,
  flushMs: 0,
  flushReceivers: 0,
  flushSkipped: 0,
  datagramsSent: 0,
  tcCount: 0,
  tcFilterMs: 0,
  tcConeMs: 0,
  tcCreatureMs: 0,
  spawnFlushCount: 0,
  spawnFlushMs: 0,
  despawnFlushMs: 0,
  spawnQueueSeen: 0,
  collisionBlocks: 0,
  collisionReasons: {} as Record<string, number>,
};
if (PROFILE) {
  setInterval(() => {
    const movers = prof.moveCbCount;
    const line =
      `[profile] lag=${eventLoopLagMs.toFixed(1)}ms flushInterval=${getAdaptiveBatchInterval()}ms | ` +
      `move: ${movers} cb/5s (collision ${prof.collisionMs.toFixed(0)}ms sync) | ` +
      `aoi: ${prof.aoiUpdateCount} upd | ` +
      `flush: ${prof.flushCount}x, ${prof.flushMs.toFixed(0)}ms total, ${prof.flushReceivers} recv, ${prof.flushSkipped} skipped, ${prof.datagramsSent} dgrams | ` +
      `spawnflush: ${prof.spawnFlushCount}x, ${prof.spawnFlushMs.toFixed(0)}ms spawn + ${prof.despawnFlushMs.toFixed(0)}ms despawn, queue seen ${prof.spawnQueueSeen} | ` +
      `collblocks: ${prof.collisionBlocks} ${JSON.stringify(prof.collisionReasons)} | ` +
      `targetclosest: ${prof.tcCount}x, filter ${prof.tcFilterMs.toFixed(0)}ms, cone ${prof.tcConeMs.toFixed(0)}ms, creature ${prof.tcCreatureMs.toFixed(0)}ms`;
    log.info(line);
    if (aoiProf.calls > 0) {
      log.info(
        `[profile:aoi] ${aoiProf.calls} upd | filter ${aoiProf.filterMs.toFixed(0)}ms, entered-loop ${aoiProf.enteredLoopMs.toFixed(0)}ms, exited-loop ${aoiProf.exitedLoopMs.toFixed(0)}ms | ` +
        `candidates avg ${(aoiProf.candidateTotal / aoiProf.calls).toFixed(1)} max ${aoiProf.maxCandidates}, ` +
        `entered ${aoiProf.enteredTotal}, exited ${aoiProf.exitedTotal}`
      );
    }
    aoiProf.calls = aoiProf.filterMs = aoiProf.enteredLoopMs = aoiProf.exitedLoopMs = aoiProf.tailMs = 0;
    aoiProf.candidateTotal = aoiProf.enteredTotal = aoiProf.exitedTotal = aoiProf.maxCandidates = 0;
    prof.moveCbCount = prof.collisionMs = 0;
    prof.aoiUpdateCount = 0;
    prof.flushCount = prof.flushMs = prof.flushReceivers = prof.flushSkipped = prof.datagramsSent = 0;
    prof.tcCount = prof.tcFilterMs = prof.tcConeMs = prof.tcCreatureMs = 0;
    prof.spawnFlushCount = prof.spawnFlushMs = prof.despawnFlushMs = prof.spawnQueueSeen = 0;
    prof.collisionBlocks = 0;
    prof.collisionReasons = {};
  }, 5000).unref();
}

/**
 * Adaptive movement-flush interval. Driven by two signals:
 *   - event-loop lag: is the game-logic thread itself falling behind?
 *   - flush latency: how long the flush's own bookkeeping takes.
 * Whichever is worse wins. The interval climbs monotonically with load so a
 * saturated server sheds movement cadence (fewer, larger updates) instead of
 * queueing work it can't drain.
 */
// Datagrams sent by the most recent movement flush. Used to decide the flush
// cadence: at low volume there's no reason to throttle (a fast flush makes
// movement look smooth for the handful of players watching), but at high volume
// each flush is ~1 datagram per active receiver and flushing at 60 Hz would
// saturate the single native UDP send path (~9% loss + lag oscillation). So the
// floor slides: 33ms (30 Hz) when the server is nearly idle, 50ms (20 Hz) once
// there's real outbound volume.
// Rolling count of movement datagrams sent, sampled every second into a rate.
let movementDatagramsSent = 0;
let movementDatagramRatePerSec = 0;
setInterval(() => {
  movementDatagramRatePerSec = movementDatagramRatePerSec * 0.5 + movementDatagramsSent * 0.5;
  movementDatagramsSent = 0;
}, 1000).unref();
const HIGH_VOLUME_RATE = 8000; // datagrams/sec ~ a few hundred concurrent players

function getAdaptiveBatchInterval(): number {
  const avgLatency = getAverageFlushLatency();
  const lag = eventLoopLagMs;

  // Event-loop lag dominates: if the thread is blocked, flushing more often
  // just adds to the backlog. These thresholds are deliberately aggressive.
  if (lag > 120) return 150; // loop badly behind - ~7 Hz, let it recover
  if (lag > 60) return 100;  // ~10 Hz
  if (lag > 30) return 66;   // ~15 Hz

  const floor = movementDatagramRatePerSec >= HIGH_VOLUME_RATE ? 50 : 33;

  // Loop is healthy; pace off flush latency, but never below the sliding floor.
  if (avgLatency < 15) {
    return floor;
  } else if (avgLatency < 25) {
    return 66; // ~15 Hz
  } else if (avgLatency < 40) {
    return 85; // ~12 Hz
  } else if (avgLatency < 50) {
    return 100; // 10 Hz
  } else {
    return 120; // ~8 Hz - maximum stability
  }
}

async function flushMovementBatches() {
  const startTime = Date.now();
  const _profStart = PROFILE ? performance.now() : 0;

  const avgLatency = getAverageFlushLatency();

  let skippedDueToLoad = 0;

  // Queue management based on latency
  const MAX_BATCH_QUEUE_SIZE = avgLatency > 40 ? 800 : (avgLatency > 25 ? 1200 : 2000);

  if (movementBatchQueue.size > MAX_BATCH_QUEUE_SIZE) {
    const dropRate = avgLatency > 40 ? 0.15 : (avgLatency > 25 ? 0.08 : 0.05);
    const toDrop = Math.floor(MAX_BATCH_QUEUE_SIZE * dropRate);
    const keys = Array.from(movementBatchQueue.keys());
    for (let i = 0; i < toDrop; i++) {
      movementBatchQueue.delete(keys[i]);
    }
  }

  for (const [groupKey, playerMovements] of movementBatchQueue.entries()) {
    if (playerMovements.size === 0) continue;

    const allPlayers = playerCache.list();
    const groupPlayerIds = groupKey.includes(":layer_")
      ? layerManager.getPlayersInLayer(groupKey)
      : mapIndex.getPlayersOnMap(groupKey);

    // Iterate the group's id set directly against the live player cache. The
    // previous code copied every player in the group into a throwaway
    // `mapPlayers` object on every flush, even when only a few were moving.
    const receiverSets = new Map<string, Set<string>>();
    const changedSets: Array<{ playerId: string; add: string[]; remove: string[] }> = [];

    for (const playerId of groupPlayerIds) {
      const player = allPlayers[playerId];
      if (!player || !player.aoi) continue;

      const revision = player.aoi.revision || 0;
      const cached = receiverSetCache.get(playerId);
      if (cached && cached.revision === revision) {
        receiverSets.set(playerId, cached.receivers);
        continue;
      }

      const receivers = new Set<string>([playerId]);
      if (player.aoi.playersInAOI) {
        for (const aoiPlayerId of player.aoi.playersInAOI) {
          receivers.add(aoiPlayerId as string);
        }
      }
      receiverSets.set(playerId, receivers);
      receiverSetCache.set(playerId, { revision, receivers });

      const oldSet = cached?.receivers;
      if (!oldSet) {
        changedSets.push({ playerId, add: [...receivers], remove: [] });
      } else {
        // Direct Set iteration; the previous [...set].filter(...) spread both
        // sets into throwaway arrays before filtering.
        const add: string[] = [];
        for (const id of receivers) {
          if (!oldSet.has(id)) add.push(id);
        }
        const remove: string[] = [];
        for (const id of oldSet) {
          if (!receivers.has(id)) remove.push(id);
        }
        if (add.length > 0 || remove.length > 0) {
          changedSets.push({ playerId, add, remove });
        }
      }
    }

    const movers: MoverSnapshot[] = [];
    for (const [movingPlayerId, movementData] of playerMovements.entries()) {
      const movingPlayer = allPlayers[movingPlayerId];
      if (!movingPlayer || !movingPlayer.aoi) continue;
      movers.push({
        id: movingPlayerId,
        x: movementData.d?.x ?? movingPlayer.location.position.x,
        y: movementData.d?.y ?? movingPlayer.location.position.y,
        direction: movementData.d?.dr ?? movingPlayer.location.position.direction ?? "down",
        stealth: !!(movementData.isStealth || movingPlayer.isStealth),
        vanished: !!movingPlayer.isVanished,
        party: movingPlayer.party || [],
      });
    }

    let sentCount = 0;
    let processedReceivers = 0;

    // Cap the non-mover receivers processed per flush when the loop is behind,
    // so a single flush can't monopolise a struggling thread. Movers are always
    // processed (see isSelfReceiver below). Was gated on the broken cpuBusy
    // metric; now on real event-loop lag.
    const maxReceiversPerFlush =
      eventLoopLagMs > 60 ? 100 : eventLoopLagMs > 30 ? 300 : Number.MAX_SAFE_INTEGER;

    const receiverArray = Array.from(receiverSets.entries());
    const startIndex = flushOffset % Math.max(receiverArray.length, 1);

    // Layers above this size offload batch encoding to a per-layer worker
    // thread (keeps the main event loop free at high player counts).
    const useWorker = receiverArray.length > 20;

    let workerDiffs: Array<{ playerId: string; add: string[]; remove: string[] }> = [];
    if (useWorker) {
      if (!workerLayerSynced.has(groupKey)) {
        // First flush for this layer's worker: send a full snapshot of the
        // layer's receiver sets so the worker mirror starts correct.
        // Iterate the group's members and look each up, rather than scanning
        // the whole global receiverSetCache (O(all players)) to filter it down.
        for (const playerId of groupPlayerIds) {
          const cachedEntry = receiverSetCache.get(playerId);
          if (cachedEntry) {
            workerDiffs.push({ playerId, add: [...cachedEntry.receivers], remove: [] });
          }
        }
        workerLayerSynced.add(groupKey);
      } else {
        workerDiffs = changedSets;
      }
    }

    const selectedReceiverIds: string[] = [];
    const selectedSets = new Map<string, Set<string>>();
    const receiverInfo: Record<string, ReceiverInfo> = {};

    for (let i = 0; i < receiverArray.length; i++) {
      const [receiverId, receiversForPlayer] = receiverArray[(startIndex + i) % receiverArray.length];

      const isSelfReceiver = playerMovements.has(receiverId);
      if (!isSelfReceiver && processedReceivers >= maxReceiversPerFlush) {
        skippedDueToLoad++;
        continue;
      }
      if (!isSelfReceiver) {
        processedReceivers++;
      }

      const receiver = allPlayers[receiverId];
      if (!receiver || !receiver.wt || receiver.wt.readyState !== 1) continue;

      // No stream-queue backpressure gate here: movement batches are delivered
      // as DATAGRAMS, which never touch the reliable stream's queue. Skipping
      // receivers with a busy stream queue (e.g. mid spawn-burst) froze their
      // view of other players - the exact clients that need updates most. QUIC
      // datagram flow control drops datagrams itself when a receiver can't
      // keep up, so this costs nothing.

      selectedReceiverIds.push(receiverId);
      selectedSets.set(receiverId, receiversForPlayer);
      receiverInfo[receiverId] = {
        x: receiver.location?.position?.x ?? 0,
        y: receiver.location?.position?.y ?? 0,
        isAdmin: !!receiver.isAdmin,
        username: receiver.username || "",
        seq: movementProbeSeqs.get(receiverId) ?? 0,
      };
    }

    if (PROFILE) prof.flushReceivers += selectedReceiverIds.length;

    if (selectedReceiverIds.length > 0) {
      const movementTick = flushTick++;

      if (useWorker) {
        const allPlayersRef = allPlayers;
        queueLayerWorkerFlush(groupKey, {
          tick: movementTick,
          movers,
          receiverIds: selectedReceiverIds,
          receiverInfo,
          diffs: workerDiffs,
          onBatches: (batches, updatedSeqs) => {
            if (updatedSeqs) {
              for (const [receiverId, seq] of Object.entries(updatedSeqs)) {
                movementProbeSeqs.set(receiverId, seq);
              }
            }
            for (const batch of batches) {
              const receiver = allPlayersRef[batch.receiverId];
              if (!receiver?.wt || receiver.wt.readyState !== 1) continue;

              const data = batch.data;
              const parts: Uint8Array[] = [];
              for (let i = 0; i < batch.offsets.length - 1; i++) {
                const start = batch.offsets[i];
                const end = batch.offsets[i + 1];
                parts.push(new Uint8Array(data.buffer, data.byteOffset + start, end - start));
              }
              if (parts.length === 1) {
                receiver.wt.send(parts[0]);
              } else if (parts.length > 1) {
                receiver.wt.sendMovementBatch(parts);
              }
              movementDatagramsSent += parts.length;
              if (PROFILE) prof.datagramsSent += parts.length;
              sentCount++;
            }
          },
        });
      } else {
        // Layer served inline: its worker mirror (if any) goes stale. Forget
        // the sync flag so the next worker engagement starts with a full sync.
        workerLayerSynced.delete(groupKey);

        for (const receiverId of selectedReceiverIds) {
          const receiver = allPlayers[receiverId];
          if (!receiver?.wt || receiver.wt.readyState !== 1) continue;

          const entries = collectReceiverEntries(selectedSets.get(receiverId)!, movers, receiverInfo[receiverId], movementTick);
          if (entries.length === 0) continue;

          const receiverProbeSeq = movementProbeSeqs.get(receiverId) ?? 0;
          const { data, offsets } = encodeBatch(entries, { seq: receiverProbeSeq, serverSendTime: Date.now() });
          movementProbeSeqs.set(receiverId, receiverProbeSeq + (offsets.length - 1));
          const parts: Uint8Array[] = [];
          for (let i = 0; i < offsets.length - 1; i++) {
            const start = offsets[i];
            const end = offsets[i + 1];
            parts.push(new Uint8Array(data.buffer, data.byteOffset + start, end - start));
          }
          if (parts.length === 1) {
            receiver.wt.send(parts[0]);
          } else if (parts.length > 1) {
            receiver.wt.sendMovementBatch(parts);
          }
          movementDatagramsSent += parts.length;
          if (PROFILE) prof.datagramsSent += parts.length;
          sentCount++;
        }
      }
    }

    flushOffset += Math.max(processedReceivers, 1);
  }

  movementBatchQueue.clear();

  // Track this flush's latency
  const flushLatency = Date.now() - startTime;
  recentFlushLatencies.push(flushLatency);
  if (recentFlushLatencies.length > LATENCY_HISTORY_SIZE) {
    recentFlushLatencies.shift();
  }

  if (PROFILE) {
    prof.flushCount++;
    prof.flushMs += performance.now() - _profStart;
    prof.flushSkipped += skippedDueToLoad;
  }
}

export const spawnBatchQueue = new Map<string, Map<string, any>>();

// Sprite/animation payload caches live at module scope: spawn data for a given
// player+animation is identical across receivers and flushes, so rebuilding it
// per flush was pure repeated work during churn.
const spriteDataCache = new Map<string, any>();
const animationDataCache = new Map<string, any>();

function queueSpawnForReceivers(spawnedPlayer: any, receivers: any[], spriteData: any = null) {
  // Build the snapshot ONCE per call - the same player object is identical for
  // every receiver, and rebuilding it per receiver was O(N^2) work per wave.
  const spawnData = queueSpawnPlayerPacket(spawnedPlayer);
  if (!spawnData) return;
  if (spriteData) spawnData.spriteData = spriteData;

  for (const receiver of receivers) {
    if (!receiver || !receiver.wt || receiver.id === spawnedPlayer.id) continue;
    if (!spawnBatchQueue.has(receiver.id)) spawnBatchQueue.set(receiver.id, new Map());
    spawnBatchQueue.get(receiver.id)!.set(spawnedPlayer.id, spawnData);
  }
}

async function flushSpawnBatches() {
  if (spawnBatchQueue.size === 0) return;

  const allPlayers = playerCache.list();

  // Pre-serialized spawn/animation JSON, shared across receivers within this
  // flush: every receiver sees the same snapshots, so each player's deep
  // sprite-laden object is stringified once instead of once per receiver.
  const spawnJsonCache = new Map<string, string>();
  const animJsonCache = new Map<string, string>();

  // Snapshot the receiver list up front: receivers that log in mid-flush are
  // picked up by the next flush 50ms later.
  for (const receivingPlayerId of Array.from(spawnBatchQueue.keys())) {
    // Claim (detach) the entry BEFORE the first await below. Spawns queued by
    // a player logging in while this flush is awaiting sprite data land in a
    // fresh entry instead of the snapshot being processed; holding the live
    // reference and deleting/clearing it afterwards silently dropped those
    // arrivals, leaving the new player permanently invisible to this receiver
    // (no spawn -> the client ignores all later movement/stats for them).
    const claimed = claimBatchEntry(spawnBatchQueue, receivingPlayerId);
    if (!claimed || claimed.size === 0) {
      continue;
    }

    try {
      await flushOneSpawnBatch(receivingPlayerId, claimed, allPlayers, spawnJsonCache, animJsonCache);
    } catch (error) {
      // Never lose a claimed batch to an exception (bad sprite data, a
      // mid-flush disconnect mutating player state, ...): restore everything
      // we claimed so the next flush retries. The old live-reference code was
      // accidentally immune here (the entry stayed queued); the claim
      // protocol must restore explicitly.
      requeueSpawnBatch(spawnBatchQueue, receivingPlayerId, claimed);
    }
  }
}

async function flushOneSpawnBatch(
  receivingPlayerId: string,
  claimed: Map<string, any>,
  allPlayers: Record<string, any>,
  spawnJsonCache: Map<string, string>,
  animJsonCache: Map<string, string>
): Promise<void> {
  const receivingPlayer = allPlayers[receivingPlayerId];

  // Receiver is gone / not connected: drop their queued spawns entirely.
  // Previously this only `continue`d, leaving the entry in spawnBatchQueue
  // forever - after a load test the map held thousands of dead receivers and
  // the 50ms flush re-scanned all of them (~110ms/flush doing nothing).
  if (!receivingPlayer || !receivingPlayer.wt || receivingPlayer.wt.readyState !== 1) {
    return;
  }

  const spawnsForThisPlayer = Array.from(claimed.values());

  // Spawn batches are the largest stream payloads. Use a FRESH queue reading
  // (not the 250ms cache) so a burst can't pile past the transport limit
  // before the gate notices. Skipped spawns stay queued for a later flush.
  if (receivingPlayer.wt.getFreshQueuedBytes() > SPAWN_BACKPRESSURE_THRESHOLD) {
    requeueSpawnBatch(spawnBatchQueue, receivingPlayerId, claimed);
    return;
  }

  if (spawnsForThisPlayer.length > 0) {
    const MAX_SPAWNS_PER_FLUSH = 10;
    const batchToSend = spawnsForThisPlayer.slice(0, MAX_SPAWNS_PER_FLUSH);
    const remaining = spawnsForThisPlayer.slice(MAX_SPAWNS_PER_FLUSH);

    const playersWithSprites = await Promise.all(
      batchToSend.map(async (queuedPlayer) => {
        const fullPlayer = allPlayers[queuedPlayer.id];
        if (!fullPlayer) {
          return { ...queuedPlayer, spriteData: null };
        }

        const animationName = getAnimationNameForDirection(
          fullPlayer.location.position?.direction || "down",
          !!fullPlayer.moving,
          !!fullPlayer.mounted,
          fullPlayer.mount_type,
          !!fullPlayer.casting
        );

        const spriteCacheKey = `${queuedPlayer.id}:${animationName}:${fullPlayer.equipmentRevision || 0}`;
        let playerSpriteData = spriteDataCache.get(spriteCacheKey);
        if (playerSpriteData === undefined) {
          playerSpriteData = await getPlayerSpriteSheetData(animationName, fullPlayer.equipment || null);
          spriteDataCache.set(spriteCacheKey, playerSpriteData);
        }

        const mountSpriteForBatch = fullPlayer.mount_type ? getMountSpriteUrl(fullPlayer.mount_type) : null;

        let spriteData = null;
        if (playerSpriteData?.bodySprite || playerSpriteData?.headSprite || mountSpriteForBatch) {
          // Sprite URLs are now sent to the client, which fetches them from the asset server
          spriteData = {
            mountSprite: mountSpriteForBatch,
            bodySprite: playerSpriteData.bodySprite || null,
            headSprite: playerSpriteData.headSprite || null,
            armorHelmetSprite: playerSpriteData.armorHelmetSprite || null,
            armorShoulderguardsSprite: playerSpriteData.armorShoulderguardsSprite || null,
            armorNeckSprite: playerSpriteData.armorNeckSprite || null,
            armorHandsSprite: playerSpriteData.armorHandsSprite || null,
            armorChestSprite: playerSpriteData.armorChestSprite || null,
            armorFeetSprite: playerSpriteData.armorFeetSprite || null,
            armorLegsSprite: playerSpriteData.armorLegsSprite || null,
            armorWeaponSprite: playerSpriteData.armorWeaponSprite || null,
            animationState: playerSpriteData.animationState,
          };
        }

        return {
          ...queuedPlayer,
          spriteData: spriteData,
        };
      })
    );

    const playerJsonParts = playersWithSprites.map((spawnData) => {
      let json = spawnJsonCache.get(spawnData.id);
      if (json === undefined) {
        json = JSON.stringify(spawnData);
        spawnJsonCache.set(spawnData.id, json);
      }
      return json;
    });

    const SPAWN_CHUNK_SIZE = 8;
    for (let i = 0; i < playerJsonParts.length; i += SPAWN_CHUNK_SIZE) {
      sendPacket(receivingPlayer.wt, packetManager.loadPlayersJson(
        playerJsonParts.slice(i, i + SPAWN_CHUNK_SIZE),
        globalStateRevision
      ));
    }

    const animationPromises = playersWithSprites.map(async (spawnData) => {
      const spawnedPlayer = allPlayers[spawnData.id];
      if (!spawnedPlayer) {
        return null;
      }

      const animationName = getAnimationNameForDirection(
        spawnedPlayer.location?.position?.direction || "down",
        spawnedPlayer.moving,
        spawnedPlayer.mounted,
        spawnedPlayer.mount_type,
        spawnedPlayer.casting || false
      );

      const fullPlayer = allPlayers[spawnData.id];
      const equipRev = fullPlayer?.equipmentRevision || 0;
      const animCacheKey = `${spawnData.id}:${animationName}:${equipRev}`;
      let animData = animationDataCache.get(animCacheKey);
      if (animData === undefined) {
        animData = await getAnimationData(animationName, spawnData.id);
        animationDataCache.set(animCacheKey, animData);
      }
      return animData;
    });

    const animationDataArray = (await Promise.all(animationPromises)).filter(a => a !== null);

    if (animationDataArray.length > 0) {
      const animJsonParts = animationDataArray.map((animData) => {
        const key = String(animData.id);
        let json = animJsonCache.get(key);
        if (json === undefined) {
          json = JSON.stringify(animData);
          animJsonCache.set(key, json);
        }
        return json;
      });
      sendPacket(receivingPlayer.wt, packetManager.batchSpriteSheetAnimationJson(animJsonParts));
    }

    // Re-queue remaining spawns for the next flush, merged with anything
    // that arrived while this receiver was awaiting sprite/animation data.
    // The old code cleared the live entry here, dropping those arrivals.
      const remainder = new Map<string, any>();
      for (const r of remaining) {
        remainder.set(r.id, r);
      }
      requeueSpawnBatch(spawnBatchQueue, receivingPlayerId, remainder);
  }
}

export const despawnBatchQueue = new Map<string, Set<string>>();

function flushDespawnBatches() {
  if (despawnBatchQueue.size === 0) return;

  const allPlayers = playerCache.list();

  for (const receivingPlayerId of Array.from(despawnBatchQueue.keys())) {
    // Claim (detach) up front so the tail clear below cannot drop entries for
    // receivers skipped on backpressure - the old code `continue`d past them
    // and then wiped them with a blanket clear, leaving ghost entities stuck
    // on the client's screen.
    const claimed = claimDespawnEntry(despawnBatchQueue, receivingPlayerId);
    if (!claimed || claimed.size === 0) continue;

    const receivingPlayer = allPlayers[receivingPlayerId];

    if (!receivingPlayer || !receivingPlayer.wt || receivingPlayer.wt.readyState !== 1) continue;

    if (receivingPlayer.wt.bufferedAmount > MAX_BUFFER_BACKPRESSURE) {
      requeueDespawnEntry(despawnBatchQueue, receivingPlayerId, claimed);
      continue;
    }

    const despawnsArray = Array.from(claimed);

    if (despawnsArray.length > 0) {

      const despawnData = despawnsArray.map(playerId => ({ id: playerId, reason: "disconnect" }));
      sendPacket(receivingPlayer.wt, packetManager.batchDisconnectPlayer(despawnData));
    }

    // Anything re-queued for this receiver while its despawns were sending
    // (e.g. a player disconnecting mid-flush) is already in a fresh entry and
    // is left for the next flush.
  }
}

// Movement runs on its own timer, decoupled from spawn/despawn. A spawn burst
// (sprite data, JSON stringify) previously sat in the same await chain ahead of
// the next movement flush, so a login wave would stutter everyone's movement.
// The two flush families touch disjoint queues and disjoint state.

let movementFlushTimer: ReturnType<typeof setTimeout> | null = null;

async function scheduleMovementFlush() {
  try {
    await flushMovementBatches();
  } catch (error) {
    // Silently ignore batch flush errors
  } finally {
    if (movementFlushTimer) clearTimeout(movementFlushTimer);
    movementFlushTimer = setTimeout(scheduleMovementFlush, getAdaptiveBatchInterval());
  }
}

// Spawn and despawn are less latency-critical and much heavier per flush, so
// they run on a fixed, slower cadence.
const SPAWN_FLUSH_INTERVAL = 50;
let spawnFlushTimer: ReturnType<typeof setTimeout> | null = null;

async function scheduleSpawnFlush() {
  try {
    const _qSize = PROFILE ? spawnBatchQueue.size : 0;
    // Despawns drain BEFORE spawns every cycle (removal-before-add). On a
    // rapid refresh the kick queues despawn(old session) and the relogin
    // queues spawn(new session) for the same viewer; if both land in one
    // cycle the old order sent spawn-then-despawn, and any client matching
    // the despawn to the same user dropped the just-added entity - leaving
    // the refresher permanently invisible until the next AOI retrigger.
    const _s1 = PROFILE ? performance.now() : 0;
    flushDespawnBatches();
    if (PROFILE) {
      prof.despawnFlushMs += performance.now() - _s1;
    }
    const _s2 = PROFILE ? performance.now() : 0;
    await flushSpawnBatches();
    if (PROFILE) {
      prof.spawnFlushCount++;
      prof.spawnFlushMs += performance.now() - _s2;
      prof.spawnQueueSeen += _qSize;
    }
  } catch (error) {
    // Silently ignore batch flush errors
  } finally {
    if (spawnFlushTimer) clearTimeout(spawnFlushTimer);
    spawnFlushTimer = setTimeout(scheduleSpawnFlush, SPAWN_FLUSH_INTERVAL);
  }
}

movementFlushTimer = setTimeout(scheduleMovementFlush, getAdaptiveBatchInterval());
spawnFlushTimer = setTimeout(scheduleSpawnFlush, SPAWN_FLUSH_INTERVAL);

function constructMapMetadata(
  mapName: string,
  spawnX: number,
  spawnY: number,
  direction: string,
  maps: MapData[],
  mapPropertiesCache: any[]
): any {
  const normalizedName = mapName.replace(".json", "");
  const map = maps.find((m: MapData) => m.name === `${normalizedName}.json` || m.name === normalizedName);
  const mapProps = mapPropertiesCache.find((m: any) => m.name === `${normalizedName}.json`);
  const assetServerUrl = process.env.ASSET_SERVER_URL || "http://localhost:8081";

  const worldsArr: WorldData[] = Array.isArray(worldsCache) ? worldsCache : (typeof worldsCache === "string" ? JSON.parse(worldsCache) : []);

  const objectLayers = (map?.data?.layers || [])
    .filter((layer: any) => layer.type === "objectgroup")
    .map((layer: any) => ({ name: layer.name }));

  const mapVersion = mapProps?.version || '';

  const metadata = {
    name: normalizedName,
    assetServerUrl,
    width: map?.data?.width || 0,
    height: map?.data?.height || 0,
    tilewidth: map?.data?.tilewidth || 32,
    tileheight: map?.data?.tileheight || 32,
    tilesets: map?.data?.tilesets || [],
    infinite: map?.data?.infinite === true,
    spawnX,
    spawnY,
    direction,
    chunks: null,
    warps: mapProps?.warps || null,
    graveyards: mapProps?.graveyards || null,
    shadowLayerNames: mapProps?.shadowLayerNames || null,
    hasWeather: !!worldsArr.find((w) => w.name === normalizedName),
    objectLayers,
    mapVersion,
  };

  listener.emit(Events.WARP, { mapName, metadata });
  return metadata;
}

async function transitionPlayerToMap(
  player: any,
  newMapName: string,
  newPosition: { x: number; y: number; direction?: string },
  wt: any,
  spawnBatchQueue: Map<string, Map<string, any>>,
  despawnBatchQueue: Map<string, Set<string>>
): Promise<void> {
  loot.cancelCleanup(player.username);

  await handleMapChangeAOI(player, newMapName, { x: newPosition.x, y: newPosition.y }, spawnBatchQueue, despawnBatchQueue);

  clearTargetOnMapChange(player.id);

  const updatedPlayer = playerCache.get(player.id);
  if (!updatedPlayer) return;

  listener.emit(Events.MAP_ENTER, { player: updatedPlayer, mapName: newMapName, position: { x: newPosition.x, y: newPosition.y } });

  const direction = newPosition.direction || updatedPlayer.location.position?.direction || "down";
  const mapMetadata = constructMapMetadata(newMapName, newPosition.x, newPosition.y, direction, maps, mapPropertiesCache);
  sendPacket(wt, packetManager.loadMap(mapMetadata));
  // Loading a map clears the client's creatures, even when it is the same map
  // again: resend every creature around the player.
  creatures.resyncPlayer(player.id);

  setImmediate(async () => {
    try {
      const normalizedMap = newMapName.replace(".json", "");
      const resolved = await resolveWorldWeather(normalizedMap);
      if (resolved.weather) {
        sendPacket(wt, packetManager.weather({ weather: resolved.weather, weatherData: resolved.weatherData }));
      }
    } catch (e) {
      log.warn(`Failed to fetch weather data for ${newMapName}: ${e}`);
    }

    try {
      const npcsData = await assetCache.get("npcs") as Npc[];
      const npcsInMap = (npcsData || []).filter((npc: Npc) => npc.map === newMapName);
      const particlesCache = await assetCache.get("particles") as Particle[] | null;
      const npcPackets = await npcsInMap.reduce(
        async (packetsPromise: Promise<any[]>, npc: Npc) => {
          const packets = await packetsPromise;
          const particleArray =
            typeof npc.particles === "string" && particlesCache
              ? (
                (npc.particles as string)
                  .split(",")
                  .map((name) =>
                    particlesCache.find((p: Particle) => p.name === name.trim())
                  )
              ).filter(Boolean)
              : [];
          const npcData = {
            id: npc.id,
            last_updated: npc.last_updated,
            name: npc.name || null,
            location: {
              x: npc.position.x,
              y: npc.position.y,
              direction: npc.position.direction || "down",
            },
            script: npc.script,
            hidden: npc.hidden,
            dialog: npc.dialog,
            gossip: npc.gossip || null,
            particles: particleArray,
            map: npc.map,
            position: npc.position,
            sprite_type: npc.sprite_type,
            spriteLayers: getNpcSpriteLayers(npc),
          };
          return [...packets, ...packetManager.createNpc(npcData)];
        },
        Promise.resolve([] as any[])
      );
      if (npcPackets.length) {
        sendPacket(wt, npcPackets);
      }
    } catch (e) {
      log.warn(`Failed to fetch NPC data for ${newMapName}: ${e}`);
    }

    // Quest markers for the new map. Map-wide explore objectives credit via
    // the MAP_ENTER listener in the quest objectives module.
    await sendQuestMarkersFor(wt, player.username, newMapName);

    try {
      const lootOnMap = loot.getOnMap(newMapName);
      if (lootOnMap.length > 0) {
        const lootPackets = lootOnMap.map((l) =>
          packetManager.lootSpawn({
            id: l.id,
            item: l.item,
            quantity: l.quantity,
            quality: l.quality,
            iconUrl: l.iconUrl,
            x: l.x,
            y: l.y,
            ownerId: l.ownerId,
            ownerName: l.ownerName,
          })
        ).flat();
        sendPacket(wt, lootPackets);
      }
    } catch (e) {
      log.warn(`Failed to sync loot for ${newMapName}: ${e}`);
    }

    try {
      const playerPos = newPosition || player.location?.position;
      const playerRadius = player.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS;
      const skeletonsInAOI = skeletons.getInRadius(newMapName, playerPos.x, playerPos.y, playerRadius, layerManager.getPlayerLayer(player.id));
      // Always sent, even when empty: this replaces the client list, clearing
      // markers from the map or layer the player just left.
      sendPacketBestEffort(wt, packetManager.loadSkeletons(skeletonsInAOI.map((s) => toSkeletonPacket(s))));
    } catch (e) {
      log.warn(`Failed to sync skeletons for ${newMapName}: ${e}`);
    }

    try {
      const chestsOnMap = lootChest.getOnMap(newMapName);
      if (chestsOnMap.length > 0) {
        const chestPackets = chestsOnMap.map((c: any) =>
          packetManager.lootChestSpawn({ id: c.id, x: c.x, y: c.y, iconUrl: c.iconUrl, map: c.map })
        ).flat();
        sendPacket(wt, chestPackets);
      }
    } catch (e) {
      log.warn(`Failed to sync loot chests for ${newMapName}: ${e}`);
    }

    const p = playerCache.get(player.id);
    if (!p) return;

    const dir = newPosition.direction || p.location.position?.direction || "down";
    const animationName = getAnimationNameForDirection(dir, false, !!p.mounted, p.mount_type, false);
    let spriteData: any = null;
    try {
      const selfSpriteData = await getPlayerSpriteSheetData(animationName, p.equipment || null);
      if (selfSpriteData.bodySprite || selfSpriteData.headSprite) {
        spriteData = {
          mountSprite: p.mount_type ? getMountSpriteUrl(p.mount_type) : null,
          bodySprite: selfSpriteData.bodySprite || null,
          headSprite: selfSpriteData.headSprite || null,
          armorHelmetSprite: selfSpriteData.armorHelmetSprite || null,
          armorShoulderguardsSprite: selfSpriteData.armorShoulderguardsSprite || null,
          armorNeckSprite: selfSpriteData.armorNeckSprite || null,
          armorHandsSprite: selfSpriteData.armorHandsSprite || null,
          armorChestSprite: selfSpriteData.armorChestSprite || null,
          armorFeetSprite: selfSpriteData.armorFeetSprite || null,
          armorLegsSprite: selfSpriteData.armorLegsSprite || null,
          armorWeaponSprite: selfSpriteData.armorWeaponSprite || null,
          animationState: selfSpriteData.animationState,
        };
      }
    } catch (e) {
      log.warn(`Failed to fetch player sprite data for ${player.id}: ${e}`);
    }

    const spawnData = {
      id: player.id,
      userid: p.userid,
      location: {
        map: `${newMapName}.json`,
        x: newPosition.x,
        y: newPosition.y,
        direction: dir,
      },
      username: p.username,
      isAdmin: p.isAdmin,
      isGuest: p.isGuest,
      isStealth: p.isStealth,
      isNoclip: p.isNoclip,
      stats: p.stats || {},
      animation: null,
      spriteData,
      friends: p.friends || [],
      party_id: p.party_id ? Number(p.party_id) : null,
      party: p.party || [],
      guild_id: p.guild_id ? Number(p.guild_id) : null,
      guild: p.guild || [],
      guild_name: p.guild_name || null,
      currency: p.currency || { copper: 0, silver: 0, gold: 0 },
    };
    sendPacket(wt, packetManager.spawnPlayer(spawnData));

    try {
      await sendAnimationTo(wt, animationName, player.id);
    } catch (e) {
      log.warn(`Failed to send animation for ${player.id}: ${e}`);
    }
  });
}

export function clearBatchQueuesForPlayer(playerId: string) {

  receiverSetCache.delete(playerId);
  movementProbeSeqs.delete(playerId);
  postToAllWorkers({ type: "removePlayers", ids: [playerId] });

  for (const [groupKey, groupMovements] of movementBatchQueue.entries()) {
    if (!groupMovements.has(playerId)) continue;
    groupMovements.delete(playerId);
    if (groupMovements.size === 0) {
      movementBatchQueue.delete(groupKey);
    }
  }

  spawnBatchQueue.delete(playerId);

  for (const key of spriteDataCache.keys()) {
    if (key.startsWith(`${playerId}:`)) {
      spriteDataCache.delete(key);
    }
  }
  for (const key of animationDataCache.keys()) {
    if (key.startsWith(`${playerId}:`)) {
      animationDataCache.delete(key);
    }
  }

  let clearedSpawnsFrom = 0;
  for (const [receivingPlayerId, spawnedPlayers] of spawnBatchQueue.entries()) {
    if (spawnedPlayers.has(playerId)) {
      spawnedPlayers.delete(playerId);
      clearedSpawnsFrom++;
    }
    if (spawnedPlayers.size === 0) {
      spawnBatchQueue.delete(receivingPlayerId);
    }
  }

  despawnBatchQueue.delete(playerId);

}

/**
 * Clean up target cycling state when a player disconnects
 */
export function clearPlayerTarget(playerId: string) {
  currentTargetMap.delete(playerId);
}

/**
 * Untarget when a player changes maps. The moving player can no longer see
 * their previous target, and any players that were targeting the mover can no
 * longer see them, so clear both server-side target state and notify clients.
 */
export function clearTargetOnMapChange(playerId: string) {
  if (currentTargetMap.has(playerId)) {
    currentTargetMap.delete(playerId);
    const mover = playerCache.get(playerId);
    if (mover?.wt && mover.wt.readyState === 1) {
      sendPacket(mover.wt, packetManager.selectPlayer({ id: playerId, data: null }));
    }
  }

  for (const [observerId, targetedId] of currentTargetMap.entries()) {
    if (targetedId === playerId) {
      currentTargetMap.delete(observerId);
      const observer = playerCache.get(observerId);
      if (observer?.wt && observer.wt.readyState === 1) {
        sendPacket(observer.wt, packetManager.selectPlayer({ id: observerId, data: null }));
      }
    }
  }
}

export function removePlayerFromCleanupMaps(playerId: string | number) {
    const id = Number(playerId);
    chatRateLimit.delete(id);
    draggedPlayersMap.delete(id);

    for (const [mapName, editors] of activeEditorsByMap.entries()) {
        editors.delete(id);
        if (editors.size === 0) activeEditorsByMap.delete(mapName);
    }

    for (const [mapName, history] of editorEditHistory.entries()) {
        const filtered = history.filter(e => e.senderId !== id);
        if (filtered.length === 0) {
            editorEditHistory.delete(mapName);
        } else {
            editorEditHistory.set(mapName, filtered);
        }
    }
}

export function removeFromAuthenticationQueues(sessionId: string, token: string) {
    pendingAuthentications.delete(sessionId);
    authentication_queue.delete(token);
    authentication_session_queue.delete(sessionId);
}

export async function teleportPlayerWrapper(playerObj: any, mapName: string, x: number, y: number): Promise<void> {
  const wt = playerObj.wt;
  if (!wt) return;
  await transitionPlayerToMap(
    playerObj,
    mapName.replace(".json", ""),
    { x, y, direction: playerObj.location?.position?.direction || "down" },
    wt,
    spawnBatchQueue,
    despawnBatchQueue
  );
}

const authWorker = await getAuthWorker();
authWorker.on("message", async (result: any) => {
  const status = result as Authentication;
  const sessionId = result.id;

  const pending = pendingAuthentications.get(sessionId);
  if (!pending) return;

  const { wt, token, language } = pending;

  pendingAuthentications.delete(sessionId);
  authentication_queue.delete(token);
  authentication_session_queue.delete(sessionId);

  if (status.error && !status.authenticated) {
    sendPacket(wt, packetManager.loginFailed());
    wt.close(1008, status.error);
    return;
  }

  if (status.authenticated && status.completed && status.error) {
    sendPacket(wt, packetManager.loginFailed());
    wt.close(1008, status.error);
    return;
  }

  const playerData = status.data as PlayerData;
  if (status.authenticated && status.completed && playerData) {
    // Check realm whitelist
    if (isWhitelistEnabled && !realmWhitelist.has(playerData.username.toLowerCase())) {
      log.warn(`[Whitelist] Access denied for ${playerData.username} - not in whitelist`);
      sendPacket(wt, packetManager.loginFailed());
      wt.close(1008, "Username not whitelisted on this realm");
      return;
    }

    const assetServerUrl = process.env.ASSET_SERVER_URL || "http://localhost:8081";

    if (!playerData.isAdmin && playerData.isNoclip) {
      player.toggleNoclip(playerData.username).catch(err =>
        log.error(`Failed to toggle noclip: ${err}`)
      );
    }
    if (!playerData.isAdmin && playerData.isStealth) {
      player.toggleStealth(playerData.username).catch(err =>
        log.error(`Failed to toggle stealth: ${err}`)
      );
    }

    // Kick any existing session for this username (duplicate login prevention)
    const newUsername = playerData.username.toLowerCase();
    for (const [_id, p] of Object.entries(playerCache.list()) as [string, any][]) {
      if (p.username?.toLowerCase() === newUsername) {
        log.info(`Kicking existing session for ${playerData.username} (duplicate login)`);

        if (p.wt && p.wt.readyState === 1) {
          p.wt.send(packetManager.notify({
            message: "You have been logged in from another location."
          }));
        }

        // World-index hygiene for the kicked session. The later onDisconnect
        // for the closing socket early-returns on the cache miss below, so
        // nothing else removes the stale id from viewers' AOI sets, the
        // reverse index, its layer, the map index or the spatial grid.
        cleanupKickedSession(p, despawnBatchQueue);
        gameLoop.unregisterMovingPlayer(p.id);
        clearBatchQueuesForPlayer(p.id);
        try {
          await worlds.adjustPlayerCount(p.location?.map || "", -1);
        } catch (err) {
          log.error(`[WorldsFetchError] Failed to update world player count: ${err}`);
        }

        const map = p.location?.map;
        if (map) {
          for (const [, other] of Object.entries(playerCache.list()) as [string, any][]) {
            // Map-wide notify so bystanders whose AOI missed the old session
            // still drop it. This MUST be a DESPAWN_PLAYER: the previous
            // packetManager.disconnect (DISCONNECT_MALIFORMED) reads as "you
            // are disconnected" client-side and blanks the bystander's screen,
            // swallowing the replacement session's spawn that follows.
            if (other.location?.map === map && other.id !== p.id && other.wt?.readyState === 1) {
              other.wt.send(packetManager.despawnPlayer(p.id, "disconnect"));
            }
          }
        }

        if (p.wt && p.wt.readyState === 1) {
          p.wt.close(1000, "Logged in from another location");
        }
        playerCache.remove(p.id);
        break;
      }
    }

    const default_map_properties = mapPropertiesCache.find((m: any) => m.name === `${defaultMap}.json`);
    const spawnX = (settings as any).spawn_x;
    const spawnY = (settings as any).spawn_y;
    const default_map_spawnpoint_x = spawnX != null
      ? spawnX
      : default_map_properties ? (default_map_properties.width * default_map_properties.tileWidth) / 2 : 0;
    const default_map_spawnpoint_y = spawnY != null
      ? spawnY
      : default_map_properties ? (default_map_properties.height * default_map_properties.tileHeight) / 2 : 0;
    const default_map_spawnpoint = { map: `${defaultMap}.json`, x: default_map_spawnpoint_x, y: default_map_spawnpoint_y, direction: "down" };
    const dbMap = playerData.location?.map;
    const player_map_properties = dbMap ? mapPropertiesCache.find((m: any) => m.name === `${dbMap}.json`) : default_map_properties;

    const position = playerData.location?.position as PositionData;
    let spawnLocation = default_map_spawnpoint;

    if (playerData.location && position && dbMap) {
      spawnLocation = {
        map: `${dbMap}.json`,
        x: position.x || (player_map_properties ? (player_map_properties.width * player_map_properties.tileWidth) / 2 : 0),
        y: position.y || (player_map_properties ? (player_map_properties.height * player_map_properties.tileHeight) / 2 : 0),
        direction: position.direction || "down",
      };
    }

    // Dead players never resume at a spawn point: a corpse awaiting release
    // resumes at the corpse, a ghost resumes where it logged out. Both stay
    // at 0 HP/stamina until revived.
    const loginDeadState = Number(playerData.isDead) || 0;
    if (loginDeadState === 1 && playerData.corpse?.map) {
      spawnLocation = {
        map: `${playerData.corpse.map}.json`,
        x: playerData.corpse.x,
        y: playerData.corpse.y,
        direction: "down",
      };
    }
    if (loginDeadState !== 0 && playerData.stats) {
      playerData.stats.health = 0;
      playerData.stats.stamina = 0;
    }

    listener.emit(Events.PLAYER_AUTH_COMPLETE, { username: playerData.username, spawnLocation, playerData });

    const map =
      maps.find((m: MapData) => m.name === spawnLocation.map) ||
      maps.find((m: MapData) => m.name === `${defaultMap}.json`);
    if (!map) return;

    spawnLocation.map = map.name;

    const questActive: QuestLogEntry[] = Array.isArray(playerData.questlog?.active) ? playerData.questlog.active : [];
    const questCompleted: number[] = Array.isArray(playerData.questlog?.completed) ? playerData.questlog.completed : [];

    const worldsResult = await assetCache.get("worlds").catch(err => {
      log.error(`[WorldsFetchError] Failed to fetch worlds: ${err}`);
      return worldsCache;
    });

    const worldData: WorldData[] = Array.isArray(worldsResult)
      ? worldsResult
      : JSON.parse(worldsResult);

    const world = worldData.find(
      (w) => w.name === spawnLocation.map.replace(".json", "")
    );


    if (world) {
      const worldPlayerCount = await worlds.adjustPlayerCount(spawnLocation.map, 1);
      if (worldPlayerCount !== null) {
        // log.info(
        //   `World: ${world.name} now has ${worldPlayerCount} players. (player_join)`
        // );
      }
    }

    // Only apply weather/ambience if the map has a defined world entry
    if (world) {
      const resolved = await resolveWorldWeather(spawnLocation.map.replace(".json", ""));
      if (resolved.weather) {
        sendPacket(wt, packetManager.weather({ weather: resolved.weather, weatherData: resolved.weatherData }));
      }
    }

    const inventorySlots = await getInventorySlots(playerData);
    const limitedInventory = Array.isArray(playerData.inventory) ? playerData.inventory.slice(0, inventorySlots) : [];
    const limitedFriends = Array.isArray(playerData.friends) ? playerData.friends.slice(0, 100) : [];
    const limitedCollectables = Array.isArray(playerData.collectables) ? playerData.collectables.slice(0, 50) : [];
    const limitedLearnedSpells = Array.isArray(playerData.learnedSpells) ? playerData.learnedSpells.slice(0, 100) : (playerData.learnedSpells || []);

    playerCache.add(wt.data.id, {
      username: playerData.username,
      animation: null,
      isAdmin: playerData.isAdmin,
      isStealth: playerData.isStealth,
      isNoclip: playerData.isNoclip,
      id: wt.data.id,
      userid: playerData.id,
      location: {
        map: spawnLocation.map.replace(".json", ""),
        position: {
          x: spawnLocation.x || 0,
          y: spawnLocation.y || 0,
          direction: spawnLocation.direction || "down",
          moving: false,
        },
      },
      language: language || "en",
      wt,
      stats: playerData.stats || {},
      friends: limitedFriends,
      attackDelay: 0,
      lastMovementPacket: null,
      permissions: typeof playerData.permissions === "string" ? (playerData.permissions as string).split(",") : playerData.permissions || [],
      pvp: false,
      last_attack: null,
      invitations: [],
      party_id: playerData.party_id ? Number(playerData.party_id) : null,
      party: playerData.party || null,
      guild_id: playerData.guild_id ? Number(playerData.guild_id) : null,
      guild: playerData.guild || [],
      guild_name: playerData.guild_name || null,
      currency: playerData.currency || { copper: 0, silver: 0, gold: 0 },
      isGuest: playerData.isGuest,
      created: performance.now(),
      lastUpdated: performance.now(),
      mounted: false,
      mount_type: null,
      collectables: limitedCollectables,
      spellCooldowns: cooldownManager.getActiveCooldowns(playerData.username),
      casting: false,
      lastInterruptTime: 0,
      interruptableSpell: false,
      castId: 0,
      stunnedUntil: 0,
      // Monotonic MOVEXY generation. Every inbound MOVEXY (direction or "abort")
      // bumps it; a handler that suspended on an await is stale once a newer
      // MOVEXY has bumped past the value it captured, and must not register the
      // player as moving. Prevents rapid start/stop taps from leaving a player
      // stuck walking (an older direction packet's deferred registration landing
      // after a newer "abort").
      _moveSeq: 0,
      spellLockoutUntil: cooldownManager.getLockout(playerData.username),
      slowPercent: 0,
      slowMultiplier: 1,
      isVanished: false,
      isDead: loginDeadState === 1,
      isGhost: loginDeadState === 2,
      corpse: loginDeadState !== 0 ? playerData.corpse || null : null,
      reviveOffered: false,
      learnedSpells: limitedLearnedSpells,
      inventory: limitedInventory,
      equipment: playerData.equipment || {},
      equipmentRevision: 0,
      questlog: { active: questActive, completed: questCompleted },
    });

    const _pcache = playerCache.get(wt.data.id);
    if (!_pcache) return;

    // Send initial packets immediately - stats sync and effect restoration follow asynchronously
    await initializePlayerAOI(_pcache);
    playerCache.set(_pcache.id, _pcache);
    mapIndex.addPlayer(_pcache.id, _pcache.location.map);
    loot.cancelCleanup(_pcache.username);

    const mapMetadata = constructMapMetadata(
      spawnLocation?.map,
      position?.x || 0,
      position?.y || 0,
      position?.direction || "down",
      maps,
      mapPropertiesCache
    );
    sendPacket(wt, packetManager.loadMap(mapMetadata));

    // Anchor the client's clock once. It advances time locally from here, so
    // this is not re-pushed on the server tick.
    sendPacket(wt, packetManager.serverTime());

    setTimeout(async () => {

      const currentPlayer = playerCache.get(wt.data.id);
      if (!currentPlayer) return;

      // Sync stats with equipment bonuses before spawning
      const syncedStats = await player.synchronizeStats(playerData.username);
      if (syncedStats) {
        if (syncedStats.stamina > syncedStats.total_max_stamina) syncedStats.stamina = syncedStats.total_max_stamina;
        if (syncedStats.health > syncedStats.total_max_health) syncedStats.health = syncedStats.total_max_health;
        currentPlayer.stats = syncedStats;
        playerCache.set(currentPlayer.id, currentPlayer);
      }

      await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);

      const animationName = getAnimationNameForDirection(position?.direction || "down", false, false, undefined, false);
      const selfSpriteData = await getPlayerSpriteSheetData(animationName, _pcache?.equipment || null);

      let spriteDataForSelf = null;
      if (selfSpriteData.bodySprite || selfSpriteData.headSprite) {
        // Sprite URLs are now sent to the client, which fetches them from the asset server
        spriteDataForSelf = {
          mountSprite: _pcache?.mount_type ? getMountSpriteUrl(_pcache.mount_type) : null,
          bodySprite: selfSpriteData.bodySprite || null,
          headSprite: selfSpriteData.headSprite || null,
          armorHelmetSprite: selfSpriteData.armorHelmetSprite || null,
          armorShoulderguardsSprite: selfSpriteData.armorShoulderguardsSprite || null,
          armorNeckSprite: selfSpriteData.armorNeckSprite || null,
          armorHandsSprite: selfSpriteData.armorHandsSprite || null,
          armorChestSprite: selfSpriteData.armorChestSprite || null,
          armorFeetSprite: selfSpriteData.armorFeetSprite || null,
          armorLegsSprite: selfSpriteData.armorLegsSprite || null,
          armorWeaponSprite: selfSpriteData.armorWeaponSprite || null,
          animationState: selfSpriteData.animationState,
        };
      }

      const spawnDataForAll = {
        id: wt.data.id,
        userid: playerData.id,
        location: {
          map: spawnLocation.map,
          x: spawnLocation.x || 0,
          y: spawnLocation.y || 0,
          direction: spawnLocation.direction,
        },
        username: playerData.username,
        isAdmin: playerData.isAdmin,
        isGuest: playerData.isGuest,
        isStealth: playerData.isStealth,
        isNoclip: playerData.isNoclip,
        isDead: currentPlayer.isDead || false,
        isGhost: currentPlayer.isGhost || false,
        ghostTeleportPending: currentPlayer.ghostTeleportPending || false,
        corpse: currentPlayer.corpse || null,
        stats: currentPlayer.stats || {},
        animation: null,
        spriteData: spriteDataForSelf,
        friends: playerData.friends || [],
        party_id: playerData.party_id ? Number(playerData.party_id) : null,
        party: playerData.party || [],
        guild_id: playerData.guild_id ? Number(playerData.guild_id) : null,
        guild: playerData.guild || [],
        guild_name: playerData.guild_name || null,
        currency: playerData.currency || { copper: 0, silver: 0, gold: 0 },
        effects: spellEffects.getEffectsPayload(currentPlayer),
      };
      sendPacket(wt, packetManager.spawnPlayer(spawnDataForAll));

      const snapshotRevision = globalStateRevision;

      const playerDataForLoad: any[] = [];
      const playersInAOI = Array.from(currentPlayer.aoi.playersInAOI)
        .map(id => playerCache.get(id as string))
        .filter(p => p && p.wt);

      for (const p of playersInAOI) {

        const animationName = getAnimationNameForDirection(p.location.position?.direction || "down", !!p.moving, !!p.mounted, p.mount_type, !!p.casting);
        // Reuse the shared sprite-data cache (same key the spawn flush uses).
        // At a login ramp this loop runs ~50x per login x hundreds of logins/s;
        // an uncached async sprite lookup each time was a main-thread hotspot.
        const spriteCacheKey = `${p.id}:${animationName}:${p.equipmentRevision || 0}`;
        let playerSpriteData = spriteDataCache.get(spriteCacheKey);
        if (playerSpriteData === undefined) {
          playerSpriteData = await getPlayerSpriteSheetData(animationName, p.equipment || null);
          spriteDataCache.set(spriteCacheKey, playerSpriteData);
        }

        const mountSprite = p.mount_type ? getMountSpriteUrl(p.mount_type) : null;

        let spriteData = null;
        if (playerSpriteData?.bodySprite || playerSpriteData?.headSprite || mountSprite) {
          // Sprite URLs are now sent to the client, which fetches them from the asset server
          spriteData = {
            mountSprite: mountSprite,
            bodySprite: playerSpriteData.bodySprite || null,
            headSprite: playerSpriteData.headSprite || null,
            armorHelmetSprite: playerSpriteData.armorHelmetSprite || null,
            armorShoulderguardsSprite: playerSpriteData.armorShoulderguardsSprite || null,
            armorNeckSprite: playerSpriteData.armorNeckSprite || null,
            armorHandsSprite: playerSpriteData.armorHandsSprite || null,
            armorChestSprite: playerSpriteData.armorChestSprite || null,
            armorFeetSprite: playerSpriteData.armorFeetSprite || null,
            armorLegsSprite: playerSpriteData.armorLegsSprite || null,
            armorWeaponSprite: playerSpriteData.armorWeaponSprite || null,
            animationState: playerSpriteData.animationState,
          };
        }

        const loadPlayerData = {
          id: p.id,
          userid: p.userid,
          location: {
            map: p.location.map,

            x: Number(p.location.position.x) || 0,
            y: Number(p.location.position.y) || 0,
            direction: p.location.position?.direction || "down",
            moving: p.moving || false,
          },
          username: p.username,
          isAdmin: p.isAdmin,
          isGuest: p.isGuest,
      isStealth: p.isStealth,
      isVanished: p.isVanished,
          isNoclip: p.isNoclip,
          isDead: p.isDead || false,
          isGhost: p.isGhost || false,
          ghostTeleportPending: p.ghostTeleportPending || false,
          corpse: p.corpse || null,
          stats: p.stats,
          animation: null,
          spriteData: spriteData,
          mounted: p.mounted,
          guild: p.guild || [],
          guild_name: p.guild_name || null,
          effects: spellEffects.getEffectsPayload(p),
        }
        playerDataForLoad.push(loadPlayerData);
      }

      // Chunk the initial player snapshot: a single frame with 50 sprite-laden
      // players can exceed the transport's per-stream queue limit (~256KB) and
      // destroy the stream during login.
      sendLoadPlayersChunked(sendPacket, wt, playerDataForLoad, snapshotRevision);

      // Batch animation data for all existing players into one packet for the new player
      if (playerDataForLoad.length > 0) {
        const animationDataArray: any[] = [];
        for (const pl of playerDataForLoad) {
          if (pl.id !== wt.data.id && pl.location.direction) {
            const pcache = playerCache.get(pl.id);
            const animName = getAnimationNameForDirection(pl.location.direction, !!pcache?.moving, !!pcache?.mounted, pcache?.mount_type, !!pcache?.casting);
            animationDataArray.push({
              id: pl.id,
              name: animName,
              revision: globalStateRevision,
            });
          }
        }
        // Chunked for the same queue-limit reason
        const ANIMATION_CHUNK_SIZE = 25;
        for (let i = 0; i < animationDataArray.length; i += ANIMATION_CHUNK_SIZE) {
          sendPacket(wt, packetManager.batchSpriteSheetAnimation(animationDataArray.slice(i, i + ANIMATION_CHUNK_SIZE)));
        }
      }

      const layerId = currentPlayer.aoi?.layerId || layerManager.getPlayerLayer(currentPlayer.id);
      const groupKey = layerId || currentPlayer.location.map;
      const queuedMovements = movementBatchQueue.get(groupKey);
      if (queuedMovements && queuedMovements.size > 0) {
        const movementsForNewPlayer: any[] = [];

        for (const playerId of currentPlayer.aoi.playersInAOI) {
          const movement = queuedMovements.get(playerId as string);
          if (movement) {
            movementsForNewPlayer.push(movement);
          }
        }

        if (movementsForNewPlayer.length > 0) {
          sendPacket(wt, packetManager.batchMoveXY(movementsForNewPlayer));
        }
      }

      if (position?.direction) {
        await sendAnimationTo(
          wt,
          getAnimationNameForDirection(position.direction, false, false, undefined, false),
          wt.data.id
        );
      }

      // Effects and other-player animations are handled by flushSpawnBatches

      // Send active ground AoE zones on this map to the newly connected player
      const activeZones = getZonesOnMap(currentPlayer.location.map);
      for (const zone of activeZones) {
        sendPacket(wt, packetManager.groundAoeSpawn({
          id: zone.id,
          spell: zone.spellName,
          casterId: zone.casterId,
          x: zone.position.x,
          y: zone.position.y,
          radius: zone.radius,
          duration: Math.max(0, Math.ceil((zone.expiresAt - Date.now()) / 1000)),
          damageType: zone.damageType,
          particles: zone.particles,
          casterUsername: zone.casterUsername,
        }));
      }

      // Restore persisted effects from previous session
      const effectUsername = playerData.username?.toLowerCase();
      if (effectUsername) {
        const savedDots = effectManager.loadDots(effectUsername);
        if (savedDots.length > 0) {
          dots.setPlayerDots(String(currentPlayer.id), savedDots.filter((d: any) => d.expiresAt > Date.now()));
        }

        const savedBarriers = effectManager.loadBarriers(effectUsername);
        if (savedBarriers.length > 0) {
          currentPlayer.barriers = savedBarriers;
          currentPlayer.stats.absorbtion = savedBarriers.reduce((sum: number, b: any) => sum + Math.max(0, b.amount), 0);
        }

        const savedStuns = effectManager.loadStuns(effectUsername);
        if (savedStuns.length > 0) {
          setStunsForPlayer(String(currentPlayer.id), savedStuns);
          currentPlayer.stunnedUntil = Math.max(...savedStuns.map((s: any) => s.expiresAt));
        }

        const savedSlows = effectManager.loadSlows(effectUsername);
        if (savedSlows.length > 0) {
          setSlowsForPlayer(String(currentPlayer.id), savedSlows);
          currentPlayer.slowPercent = Math.max(...savedSlows.map((s: any) => s.slowPercent));
          currentPlayer.slowMultiplier = 1 - currentPlayer.slowPercent / 100;
        }

        // Resurrection Sickness restores like any other debuff (in-memory
        // handoff, so it survives relog but not a server restart). Totals
        // were already synced above; push the scaled values to the client.
        if (resurrection.restoreOnLogin(currentPlayer)) {
          sendPacket(
            wt,
            packetManager.updateStats({
              id: currentPlayer.id,
              target: currentPlayer.id,
              stats: currentPlayer.stats,
            })
          );
          spellEffects.broadcastEffectsUpdate(currentPlayer);
        }

        effectManager.clearAll(effectUsername);
      }

    });
    // Defer secondary loads with a delay so the game loop can process between player spawns
    setTimeout(async () => {

      const currentPlayerData = playerCache.get(wt.data.id);
      if (currentPlayerData) {
        const allPlayers = playerCache.list();
        const usernameIndex = new Map<string, any>();
        for (const player of Object.values(allPlayers)) {
          if (player.wt && player.username) {
            usernameIndex.set(player.username.toLowerCase(), player);
          }
        }
        const newPlayerFriends = currentPlayerData.friends || [];
        for (const friendUsername of newPlayerFriends) {
          const onlineFriend = usernameIndex.get(friendUsername.toLowerCase());
          if (onlineFriend) {
            sendPacket(onlineFriend.wt, packetManager.updateOnlineStatus({ online: true, username: currentPlayerData.username }));
            sendPacket(currentPlayerData.wt, packetManager.updateOnlineStatus({ online: true, username: onlineFriend.username }));
          }
        }
      }

      // NPCs
      const npcsData = await assetCache.get("npcs") as Npc[];
      const npcsInMap = npcsData.filter((npc: Npc) => npc.map === spawnLocation.map.replace(".json", ""));
      if (npcsInMap.length) {
        const particlesCache = await assetCache.get("particles") as Particle[] | null;
        const npcDataArray: any[] = [];
        for (const npc of npcsInMap) {
          const particleArray = typeof npc.particles === "string" && particlesCache
            ? (npc.particles as string).split(",").map((name) => particlesCache.find((p: Particle) => p.name === name.trim())).filter(Boolean)
            : [];
          npcDataArray.push({
            id: npc.id, last_updated: npc.last_updated, name: npc.name || null,
            location: { x: npc.position.x, y: npc.position.y, direction: npc.position.direction || "down" },
            script: npc.script, hidden: npc.hidden, dialog: npc.dialog, gossip: npc.gossip || null,
            particles: particleArray, map: npc.map, position: npc.position,
            sprite_type: npc.sprite_type, spriteLayers: getNpcSpriteLayers(npc),
          });
        }
        sendPacket(wt, packetManager.loadNpcs(npcDataArray));
      }

      const mapName = spawnLocation.map.replace(".json", "");

      // Loot
      const lootOnMap = loot.getOnMap(mapName);
      if (lootOnMap.length) {
        sendPacket(wt, packetManager.loadLoot(lootOnMap));
      }

      // Death skeletons inside the player's AOI only.
      const skeletonViewer = playerCache.get(wt.data.id);
      const skeletonPos = skeletonViewer?.location?.position;
      if (skeletonPos) {
        const skeletonRadius = skeletonViewer.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS;
        const skeletonsInAOI = skeletons.getInRadius(mapName, skeletonPos.x, skeletonPos.y, skeletonRadius, layerManager.getPlayerLayer(wt.data.id));
        sendPacketBestEffort(wt, packetManager.loadSkeletons(skeletonsInAOI.map((s) => toSkeletonPacket(s))));
      }

      // Relogging while dead: restore the phase. The corpse gets its popup
      // back; the ghost is re-announced so others keep rendering it.
      const relogPlayer = playerCache.get(wt.data.id);
      if (relogPlayer?.isDead) {
        sendPacket(wt, packetManager.playerDied({ id: relogPlayer.id }));
      } else if (relogPlayer?.isGhost) {
        const viewersInMap = filterPlayersByMap(relogPlayer.location.map);
        viewersInMap.forEach((p) => {
          sendPacket(p.wt, packetManager.playerGhost({ id: relogPlayer.id, ghost: true }));
        });
      }
    }, 200);

    // Build cooldown data to include with CLIENTCONFIG so the client can display
    // partially-expired cooldown overlays on reconnect.
    const clientConfig: any[] = (playerData.config || []).slice();
    if (clientConfig.length > 0) {
      const spellCooldownsForClient: Record<string, number> = {};
      const now = performance.now();
      for (const [spellIdStr, endTime] of Object.entries(_pcache?.spellCooldowns || {})) {
        const remaining = Math.max(0, (endTime as number) - now);
        if (remaining > 0) {
          const spell = await spells.find(Number(spellIdStr));
          if (spell?.name) {
            spellCooldownsForClient[spell.name] = Math.ceil(remaining);
          }
        }
      }
      clientConfig[0].spell_cooldowns = spellCooldownsForClient;
      const lockoutRemaining = Math.max(0, (_pcache?.spellLockoutUntil || 0) - now);
      clientConfig[0].spell_lockout = Math.ceil(lockoutRemaining);
    }
    sendPacket(wt, packetManager.clientConfig(clientConfig));

    // Convert icon names to Asset Server URLs for inventory items
    const bagBoundaries = await getBagBoundaries(playerData.username);
    const inventoryWithIconUrls = playerData.inventory?.map((item: any) => ({
      ...item,
      iconUrl: getIconUrl(item.icon),
      icon: undefined,
      bag_slot: computeBagSlot(item.slot, bagBoundaries),
    })) || [];

    // Convert icon names to Asset Server sprite URLs for spells (icons and sprites share the same name)
    const spellsWithSpriteUrls: Record<string, any> = {};
    if (playerData.learnedSpells && typeof playerData.learnedSpells === 'object') {
      for (const [spellName, spellData] of Object.entries(playerData.learnedSpells)) {
        spellsWithSpriteUrls[spellName] = {
          spriteUrl: (spellData as any).icon ? `${assetServerUrl}/sprite?name=${encodeURIComponent((spellData as any).icon)}` : null,
          description: (spellData as any).description ?? null,
          mana: (spellData as any).mana ?? 0,
          cooldown: (spellData as any).cooldown ?? 0,
          cast_time: (spellData as any).cast_time ?? 0,
          damage: (spellData as any).damage ?? 0,
          type: (spellData as any).type ?? null,
          effects: (spellData as any).effects ?? [],
          particles: (spellData as any).particles ?? null,
          aoe_radius: (spellData as any).aoe_radius ?? null,
          range: (spellData as any).range ?? null,
          ground_aoe: (spellData as any).ground_aoe ?? null,
          ground_duration: (spellData as any).ground_duration ?? null,
          is_thrown: (spellData as any).is_thrown ?? null,
          charge_distance: (spellData as any).charge_distance ?? null,
          teleport_behind: (spellData as any).teleport_behind ?? null,
          // Lets the client skip its optimistic cast bar for stand-still
          // spells pressed while moving (the server ignores those).
          can_move: (spellData as any).can_move ? 1 : 0,
        };
      }
    }

    // Convert icon names to Asset Server URLs for collectables (mounts)
    const collectablesWithIconUrls = playerData.collectables?.map((collectable: any) => ({
      ...collectable,
      iconUrl: getIconUrl(collectable.icon),
      icon: undefined // Remove the old icon field
    })) || [];

    sendPacket(wt, packetManager.inventory(inventoryWithIconUrls, inventorySlots));
    sendPacket(wt, packetManager.equipment(playerData.equipment || {}));

    const playerBags = await bags.ensure(playerData.username);
    sendPacket(wt, packetManager.bags(playerBags));
    sendPacket(wt, packetManager.collectables(collectablesWithIconUrls));
    sendPacket(wt, packetManager.spells(spellsWithSpriteUrls));
    // Quest log + definitions so the client needs no second fetch, then markers.
    try {
      trackRadiusPlayer(playerData.username);
    } catch {
      // Best-effort.
    }
    sendPacket(
      wt,
      packetManager.questLog({ active: questActive, completed: questCompleted, definitions: questDefsForEntries(questActive, questCompleted) })
    );
    await sendQuestMarkersFor(wt, playerData.username, spawnLocation.map);
  }
});

export default async function packetReceiver(
  server: any,
  wt: any,
  message: string,
  preParsed?: Packet
) {
  try {

    if (!message) return wt.close(1008, "Empty message");

    // Size check BEFORE parsing: parsing first let a hostile client force a
    // full JSON.parse of a maxPayloadMB-sized frame (50MB by default) before
    // the frame was ever rejected.
    const maxPayloadBytes = 1024 * 1024 * ((settings as any)?.webtransport?.maxPayloadMB || 1);
    const oversized = message.length > maxPayloadBytes;

    // The transport layer already parsed this frame to route it; reuse that
    // result instead of parsing the same JSON a second time.
    const parsedMessage: Packet = (preParsed ?? tryParsePacket(message)) as Packet;
    if (!parsedMessage) return wt.close(1007, "Malformed message");

    if (
      oversized &&
      parsedMessage.type !== "BENCHMARK" &&
      !(settings as any)?.webtransport?.benchmarkenabled
    )
      return wt.close(1009, "Message too large");

    const data = parsedMessage?.data;
    const type = parsedMessage?.type;

    if (!type || (!data && data != null))
      return wt.close(1007, "Malformed message");

    if (!validPacketTypes.has(type as unknown as string)) {
      wt.close(1007, "Invalid packet type");
    }

    const currentPlayer = playerCache.get(wt.data.id) || null;

    for (const interceptor of packetInterceptors) {
      if (interceptor(type, data, wt, currentPlayer)) {
        return;
      }
    }

    const pluginHandler = pluginHandlers.get(type);
    if (pluginHandler) {
      await pluginHandler(wt, currentPlayer, data, sendPacket);
      return;
    }

    // Resolve a DB NPC's comma-separated particle names to full particle objects
    async function resolveNpcParticles(npc: Npc): Promise<Npc> {
      const particlesCache = await assetCache.get("particles") as any[] | null;
      const resolved = typeof npc.particles === "string" && npc.particles && particlesCache
        ? (npc.particles as string).split(",")
            .map((name: string) => particlesCache.find((p: any) => p.name === name.trim()))
            .filter(Boolean)
        : (Array.isArray(npc.particles) ? npc.particles : []);


      return { ...npc, particles: resolved as Particle[] };
    }

    async function resolveNpcForClient(npc: Npc): Promise<any> {
      const withParticles = await resolveNpcParticles(npc);
      return { ...withParticles, spriteLayers: getNpcSpriteLayers(npc) };
    }

    switch (type) {
      case "BENCHMARK": {
        (data as any)["returned_timestamp"] = Date.now();
        sendPacket(wt, packetManager.benchmark(data));
        break;
      }
      case "PING": {
        sendPacket(wt, packetManager.ping(data));
        break;
      }
      case "PONG": {
        sendPacket(wt, packetManager.pong(data));
        break;
      }
      case "LOGIN": {
        sendPacket(wt, packetManager.login(wt));
        break;
      }
      case "AUTH": {
        const token = data?.toString() as string;

        if (!token) {
          sendPacket(wt, packetManager.loginFailed());
          wt.close(1008, "Invalid token");
          break;
        }

        if (authentication_queue.has(token)) {
          sendPacket(wt, packetManager.loginFailed());
          wt.close(1008, "Authentication already in progress");
          break;
        }

        if (authentication_session_queue.has(wt.data.id)) {
          sendPacket(wt, packetManager.loginFailed());
          wt.close(1008, "Session authentication already in progress");
          break;
        }

        authentication_queue.add(token);
        authentication_session_queue.add(wt.data.id);

        pendingAuthentications.set(wt.data.id, { wt, token, language: parsedMessage?.language || "en" });

        authWorker.postMessage({ token, id: wt.data.id });

        break;
      }

      case "LOGOUT": {
        if (!currentPlayer) return;
        player.setLocation(
          currentPlayer.id,
          currentPlayer.location.map,
          currentPlayer.location.position
        );
        player.logout(currentPlayer.id);
        listener.emit(Events.PLAYER_LOGOUT, { player: currentPlayer });
        // Close the connection so the onDisconnect handler fires and does the
        // full in-memory cleanup (despawn, remove from cache, update friends, etc.)
        if (wt.readyState === 1) {
          wt.close(1000, "Player logout");
        }
        break;
      }
      case "DISCONNECT": {
        if (!currentPlayer) return;
        player.setLocation(
          currentPlayer.id,
          currentPlayer.location.map,
          currentPlayer.location.position
        );
        player.clearSessionId(currentPlayer.id);

        // If this admin was dragging any players, release them
        const adminId = currentPlayer.id;
        const draggedPlayerIds: number[] = [];
        for (const [draggedId, dragByAdminId] of draggedPlayersMap.entries()) {
          if (dragByAdminId === adminId) {
            draggedPlayerIds.push(draggedId);
          }
        }

        // Release all dragged players
        for (const draggedPlayerId of draggedPlayerIds) {
          draggedPlayersMap.delete(draggedPlayerId);

          const draggedPlayer = playerCache.get(draggedPlayerId.toString());
          if (draggedPlayer) {
            // Notify all players that the dragged player was released
            const dragStopData = {
              id: draggedPlayerId,
              adminId: adminId,
            };
            const playersInMap = filterPlayersByMap(draggedPlayer.location.map);
            playersInMap.forEach((p) => {
              if (p.wt && p.wt.readyState === 1) {
                sendPacket(p.wt, packetManager.dragPlayerStop(dragStopData));
              }
            });
          }
        }

        break;
      }
      case "MOVEXY": {
        if (!currentPlayer) return;

        // MOVEXY is dispatched fire-and-forget (PROCESS_IMMEDIATELY, no await in
        // server.ts) so multiple handlers for one connection interleave across
        // their await points. Stamp this invocation with a monotonic generation;
        // a newer MOVEXY bumps past it, marking any suspended older handler stale
        // so it won't (re)register the player as moving after a later "abort".
        const moveSeq = ++currentPlayer._moveSeq;

        await player.preloadMapCollision(currentPlayer.location.map);

        const baseSpeed = 6;
        const mountSpeedMultiplier = 1.35;

        const direction = data.toString().toLowerCase();

        if (direction === "abort") {
          await forceStopPlayerMovement(currentPlayer);
          return;
        }

        // Corpses awaiting release cannot move. Ghosts can (mounted speed),
        // except during the release cinematic's pending teleport window.
        if (currentPlayer.isDead || currentPlayer.ghostTeleportPending) {
          await forceStopPlayerMovement(currentPlayer);
          return;
        }

        // A newer MOVEXY (another direction, or an "abort") arrived while this
        // handler was awaiting above - it is now authoritative. Drop this one.
        if (currentPlayer._moveSeq !== moveSeq) {
          return;
        }

        if (currentPlayer.casting && currentPlayer.interruptableSpell) {
          await interruptPlayerCast(currentPlayer);
        }

        if (!VALID_DIRECTIONS.has(direction)) return;

        // Stunned players cannot move. stunnedUntil is an epoch timestamp
        // (Date.now()-based), so it must be compared against Date.now().
        if (currentPlayer.stunnedUntil && currentPlayer.stunnedUntil > Date.now()) {
          return;
        }

        currentPlayer.location.position.direction = direction || "down";
        currentPlayer.moving = true;

        // Track direction changes for smooth transitions
        if (!currentPlayer._movementState) {
          currentPlayer._movementState = {
            currentDirection: direction,
            targetDirection: direction,
            directionChangeTime: 0,
          };
        } else {
          currentPlayer._movementState.targetDirection = direction;
          currentPlayer._movementState.directionChangeTime = Date.now();
        }

        globalStateRevision++;
        await sendPositionAnimation(
          wt,
          direction,
          true,
          currentPlayer.mounted,
          currentPlayer.mount_type || "unicorn",
          undefined,
          globalStateRevision,
          currentPlayer.casting || false
        );

        const wasAlreadyMoving = gameLoop.isPlayerMoving(currentPlayer.id);

        const movePlayer = async () => {

          if (!wt || wt.readyState !== 1) {
            gameLoop.unregisterMovingPlayer(currentPlayer.id);
            return;
          }

          // A newer MOVEXY superseded the packet that registered this callback
          // (e.g. an "abort" that raced past this handler). Stop rather than
          // keep stepping - the client believes it has stopped.
          if (currentPlayer._moveSeq !== moveSeq) {
            await forceStopPlayerMovement(currentPlayer);
            return;
          }

          // Safety net: if a stun landed mid-movement and the stun handler's
          // force-stop somehow didn't unregister us, halt here rather than
          // waiting for a client ABORT that may never arrive.
          if (spellEffects.isStunned(currentPlayer)) {
            await forceStopPlayerMovement(currentPlayer);
            return;
          }

          const tempPosition = { ...currentPlayer.location.position };
          const playerHeight = 40;
          const playerWidth = 24;

          const speed = (currentPlayer.mounted || currentPlayer.isGhost ? baseSpeed * mountSpeedMultiplier : baseSpeed) * (currentPlayer.slowMultiplier || 1);

          // Offsets are derived from a shared static unit table (see
          // DIRECTION_UNIT_OFFSETS) rather than rebuilding a 9-object literal
          // on every tick of every moving player.
          const directionOffsets = getDirectionOffsets(speed);

          // Handle direction transitions smoothly
          let activeDirection = direction;
          if (currentPlayer._movementState) {
            const timeSinceDirectionChange = Date.now() - currentPlayer._movementState.directionChangeTime;
            const DIRECTION_TRANSITION_TIME = 50; // ms to blend direction changes

            if (timeSinceDirectionChange < DIRECTION_TRANSITION_TIME &&
                currentPlayer._movementState.currentDirection !== currentPlayer._movementState.targetDirection) {
              // During transition: blend between old and new direction
              const transitionProgress = Math.min(1, timeSinceDirectionChange / DIRECTION_TRANSITION_TIME);

              const oldOffset = directionOffsets[currentPlayer._movementState.currentDirection] || directionOffsets.down;
              const newOffset = directionOffsets[currentPlayer._movementState.targetDirection] || directionOffsets.down;

              // Smoothly interpolate between old and new direction offsets
              const blendedOffset = {
                dx: oldOffset.dx + (newOffset.dx - oldOffset.dx) * transitionProgress,
                dy: oldOffset.dy + (newOffset.dy - oldOffset.dy) * transitionProgress,
              };

              tempPosition.x = tempPosition.x + blendedOffset.dx;
              tempPosition.y = tempPosition.y + blendedOffset.dy;
            } else {
              // Direction transition complete, use target direction
              if (currentPlayer._movementState.currentDirection !== currentPlayer._movementState.targetDirection) {
                currentPlayer._movementState.currentDirection = currentPlayer._movementState.targetDirection;
              }
              activeDirection = currentPlayer._movementState.currentDirection;
              const offset = directionOffsets[activeDirection];
              if (offset) {
                tempPosition.x = tempPosition.x + offset.dx;
                tempPosition.y = tempPosition.y + offset.dy;
              }
            }
          } else {
            const offset = directionOffsets[direction];
            if (offset) {
              tempPosition.x = tempPosition.x + offset.dx;
              tempPosition.y = tempPosition.y + offset.dy;
            }
          }

          // Round for collision detection only
          const _profCollStart = PROFILE ? performance.now() : 0;
          const collision = player.checkCollisionSync(
            currentPlayer.location.map,
            {
              x: Math.round(tempPosition.x),
              y: Math.round(tempPosition.y),
              direction,
            },
            {
              width: playerWidth,
              height: playerHeight,
            }
          );
          if (PROFILE) prof.collisionMs += performance.now() - _profCollStart;

          const isColliding = collision?.value === true;

          if (PROFILE && isColliding && !currentPlayer.isNoclip) {
            prof.collisionBlocks++;
            prof.collisionReasons[collision?.reason || "unknown"] =
              (prof.collisionReasons[collision?.reason || "unknown"] || 0) + 1;
          }

          if (!isColliding || currentPlayer.isNoclip) {
            currentPlayer.location.position.x = Math.round(tempPosition.x);
            currentPlayer.location.position.y = Math.round(tempPosition.y);
            checkGhostReviveProximity(currentPlayer);
          }

          if (isColliding && !currentPlayer.isNoclip) {
            gameLoop.unregisterMovingPlayer(currentPlayer.id);
            currentPlayer.moving = false;
            // Clean up movement state on collision
            if (currentPlayer._movementState) {
              currentPlayer._movementState = undefined;
            }

            globalStateRevision++;
            await sendPositionAnimation(
              wt,
              direction,
              false,
              currentPlayer.mounted,
              currentPlayer.mount_type || "unicorn",
              undefined,
              globalStateRevision,
              currentPlayer.casting || false
            );

            const reason = collision?.reason;

            if (reason === "tile_collision" && collision?.tile) {
              sendPacket(wt, packetManager.collisionDebug({
                tileX: collision.tile.x,
                tileY: collision.tile.y
              }));
            }

            if (reason === "warp_collision" && collision?.warp) {
              // Corpses and ghosts cannot use warps.
              if (currentPlayer.isDead || currentPlayer.isGhost) {
                return;
              }
              // Players in combat cannot use warps (admin summons bypass this path entirely)
              if (currentPlayer.pvp) {
                const nowTs = performance.now();
                if (!currentPlayer.lastCombatWarpNotify || nowTs - currentPlayer.lastCombatWarpNotify > 2000) {
                  currentPlayer.lastCombatWarpNotify = nowTs;
            sendPacket(
              wt,
              packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer))
            );
                }
                return;
              }
              const warp = collision.warp as {
                map: string;
                x: number;
                y: number;
              };

              for (const interceptor of warpInterceptors) {
                if (await interceptor(warp, wt, currentPlayer, sendPacket)) {
                  return;
                }
              }

              const currentMap = currentPlayer.location.map;

              const result = await player.setLocation(
                currentPlayer.id,
                warp.map.replace(".json", ""),
                {
                  x: warp.x || 0,
                  y: warp.y || 0,
                  direction: currentPlayer.location.position?.direction || "down",
                }
              );

              if (
                result &&
                typeof result === "object" &&
                "affectedRows" in result &&
                (result as { affectedRows: number }).affectedRows !== 0
              ) {
                const newMap = warp.map.replace(".json", "");
                const newPosition = {
                  x: warp.x || 0,
                  y: warp.y || 0
                };

                if (currentMap !== warp.map) {
                  await transitionPlayerToMap(currentPlayer, newMap, newPosition, wt, spawnBatchQueue, despawnBatchQueue);
                } else {
                  await handleMapChangeAOI(currentPlayer, newMap, newPosition, spawnBatchQueue, despawnBatchQueue);

                  currentPlayer.location.position.direction = currentPlayer.location.position?.direction || "down";

                  globalStateRevision++;

                  const movementData = {
                    i: wt.data.id,
                    d: {
                      x: Number(currentPlayer.location.position.x),
                      y: Number(currentPlayer.location.position.y),
                      dr: currentPlayer.location.position.direction
                    },
                    r: globalStateRevision,
                    s: currentPlayer.isStealth ? 1 : 0
                  };
                  sendPacket(wt, packetManager.moveXY(movementData));
                }
              }
            }

            return;
          }

          globalStateRevision++;

          // Check for nearby warps and preload their destination maps.
          // Throttled: a player moves at most ~8px per tick and the trigger
          // radius is 100px, so scanning every warp on the map (plus a linear
          // mapPropertiesCache lookup and a Set allocation) on EVERY tick of
          // EVERY moving player was wasted work. Every 8th tick still leaves
          // ~35px of slack before the radius could be crossed unnoticed.
          currentPlayer._warpScanTick = (currentPlayer._warpScanTick || 0) + 1;
          const shouldScanWarps = currentPlayer._warpScanTick % 8 === 0;

          const mapNameWithJson = shouldScanWarps
            ? (currentPlayer.location.map.endsWith('.json')
              ? currentPlayer.location.map
              : `${currentPlayer.location.map}.json`)
            : null;
          const playerMapProperties = shouldScanWarps
            ? mapPropertiesCache.find((m: any) => m.name === mapNameWithJson)
            : null;
          if (playerMapProperties?.warps && Array.isArray(playerMapProperties.warps)) {
            const WARP_PRELOAD_DISTANCE = 100; // pixels
            const now = performance.now();
            const preloadedDestinations = new Set<string>();

            const warpPreloadDistanceSq = WARP_PRELOAD_DISTANCE * WARP_PRELOAD_DISTANCE;

            for (const warp of playerMapProperties.warps) {
              const warpX = warp.position?.x || warp.x;
              const warpY = warp.position?.y || warp.y;
              // Squared compare: Math.hypot is markedly slower and the actual
              // distance is never used, only the threshold test.
              const warpDx = currentPlayer.location.position.x - warpX;
              const warpDy = currentPlayer.location.position.y - warpY;
              const distanceSq = warpDx * warpDx + warpDy * warpDy;

              if (distanceSq < warpPreloadDistanceSq) {
                const destMapName = warp.map.replace(".json", "");

                if (!currentPlayer._warpPreloadTimes) {
                  currentPlayer._warpPreloadTimes = {};
                }

                // Skip if already preloaded
                if (currentPlayer._warpPreloadTimes[destMapName]) {
                  continue;
                }

                // Skip if already preloaded in this movement frame
                if (preloadedDestinations.has(destMapName)) {
                  continue;
                }

                // Mark as preloaded immediately to prevent re-preloading
                currentPlayer._warpPreloadTimes[destMapName] = now;
                preloadedDestinations.add(destMapName);

                try {
                  // Find the destination map
                  const destMap = maps.find((m: MapData) =>
                    m.name === (warp.map.endsWith('.json') ? warp.map : `${warp.map}.json`)
                  );

                  if (destMap) {
                    // Calculate chunks around the warp destination
                    const tilewidth = destMap.data?.tilewidth || 32;
                    const tileheight = destMap.data?.tileheight || 32;
                    const CHUNK_SIZE_CONFIG: { [key: number]: number } = {
                      16: 64,
                      32: 32,
                      64: 16,
                    };
                    const CHUNK_SIZE = CHUNK_SIZE_CONFIG[tilewidth] || 32;
                    const chunkPixelSize = CHUNK_SIZE * tilewidth;

                    const chunksX = Math.ceil((destMap.data?.width || 0) / CHUNK_SIZE);
                    const chunksY = Math.ceil((destMap.data?.height || 0) / CHUNK_SIZE);

                    // Clamp warp position to valid chunk range
                    let spawnChunkX = Math.floor(warpX / chunkPixelSize);
                    let spawnChunkY = Math.floor(warpY / chunkPixelSize);
                    spawnChunkX = Math.max(0, Math.min(spawnChunkX, Math.max(0, chunksX - 1)));
                    spawnChunkY = Math.max(0, Math.min(spawnChunkY, Math.max(0, chunksY - 1)));

                    const viewportWidth = 1920; // Standard viewport
                    const viewportHeight = 1080;
                    const padding = chunkPixelSize;

                    const chunksNeededX = Math.ceil(
                      (viewportWidth + padding * 2) / chunkPixelSize / 2
                    );
                    const chunksNeededY = Math.ceil(
                      (viewportHeight + padding * 2) / chunkPixelSize / 2
                    );

                    const chunksToPreload: Array<{ x: number; y: number; data?: any }> = [];
                    for (let dy = -chunksNeededY; dy <= chunksNeededY; dy++) {
                      for (let dx = -chunksNeededX; dx <= chunksNeededX; dx++) {
                        const chunkX = spawnChunkX + dx;
                        const chunkY = spawnChunkY + dy;
                        if (chunkX >= 0 && chunkY >= 0 && chunkX < chunksX && chunkY < chunksY) {
                          chunksToPreload.push({ x: chunkX, y: chunkY });
                        }
                      }
                    }

                    if (chunksToPreload.length > 0) {
                      sendPacket(
                        wt,
                        packetManager.preloadMapChunks({
                          mapName: destMapName,
                          chunks: chunksToPreload,
                          tilewidth: tilewidth,
                          tileheight: tileheight,
                          chunkSize: CHUNK_SIZE,
                          width: destMap.data?.width || 0,
                          height: destMap.data?.height || 0,
                          tilesets: destMap.data?.tilesets || [],
                        })
                      );
                    }
                  }
                } catch (err) {
                  log.warn(`Failed to preload warp chunks: ${err}`);
                }
              }
            }
          }

          const aoiUpdateCounter = gameLoop.getAOIUpdateCounter(currentPlayer.id);
          if (aoiUpdateCounter % 10 === 0 && shouldUpdateAOI(currentPlayer)) {
            // NOTE: timing lives inside updatePlayerAOI (see [profile:aoi]).
            // Wrapping the await here would charge this callback for every
            // other mover's work that runs while it's suspended.
            if (PROFILE) prof.aoiUpdateCount++;
            await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
          }

          const movementData = {
            i: wt.data.id,
            d: {
              x: Number(currentPlayer.location.position.x),
              y: Number(currentPlayer.location.position.y),
              dr: currentPlayer.location.position.direction
            },
            r: globalStateRevision,
            s: currentPlayer.isStealth ? 1 : 0
          };

          if (wt.readyState === 1) {
            // Direct self-echo, every tick, as a datagram (binary moveXY, 0x02).
            // It is the client's only source for its own position - it ignores
            // its entry in the batches below. A lost echo is just a skipped
            // step: the client interpolates across it using the send time
            // each packet carries, and drops any that arrive out of order.
            // Other players learn about this mover via the batched flush below.
            sendPacket(wt, packetManager.moveXY(movementData));

            const layerId = currentPlayer.aoi?.layerId || layerManager.getPlayerLayer(currentPlayer.id);
            const groupKey = layerId || currentPlayer.location.map;
            if (!movementBatchQueue.has(groupKey)) {
              movementBatchQueue.set(groupKey, new Map());
            }
            movementBatchQueue.get(groupKey)!.set(currentPlayer.id, movementData);
          }

          if (PROFILE) prof.moveCbCount++;
        };

        // Final staleness check: if an "abort" (or newer direction) landed while
        // we were building the callback, that newer handler owns the movement
        // state now - don't (re)register from this stale one.
        if (currentPlayer._moveSeq !== moveSeq) {
          break;
        }

        gameLoop.registerMovingPlayer(currentPlayer.id, movePlayer);

        if (!wasAlreadyMoving) {
          await movePlayer();
        }
        break;
      }
      case "TELEPORTXY": {
        if (!currentPlayer?.isAdmin) return;
        const prevDirection = currentPlayer.location.position?.direction;
        currentPlayer.location.position = data;
        currentPlayer.location.position.direction =
          (data as any).direction || prevDirection || "down";

        currentPlayer.location.position.x = Math.round(
          Number(currentPlayer.location.position.x)
        );
        currentPlayer.location.position.y = Math.round(
          Number(currentPlayer.location.position.y)
        );
        globalStateRevision++;

        if (shouldUpdateAOI(currentPlayer)) {
          await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
        }

        const movementData = {
          i: wt.data.id,
          d: {
            x: Number(currentPlayer.location.position.x),
            y: Number(currentPlayer.location.position.y),
            dr: currentPlayer.location.position.direction
          },
          r: globalStateRevision,
          s: currentPlayer.isStealth ? 1 : 0
        };
        broadcastToAOI(currentPlayer, packetManager.moveXY(movementData), true);
        break;
      }
      case "CHAT": {
        if (!currentPlayer) return;
        // Corpses cannot talk. Ghost speech comes out as spirit-tongue
        // (except admins, who speak normally). Applied after decryption below.
        if (currentPlayer.isDead) return;
        const ghostSpeak = currentPlayer.isGhost && !currentPlayer.isAdmin;
        if (currentPlayer.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }
        const messageData = data as any;
        const message = messageData?.message;

        if (typeof message === "string" && message.length > MAX_CHAT_LENGTH) {
          sendPacket(wt, packetManager.notify({ message: `Message too long (max ${MAX_CHAT_LENGTH} characters).` }));
          return;
        }

        const now = Date.now();
        const timestamps = chatRateLimit.get(wt.data.id) || [];
        const recent = timestamps.filter((t) => now - t < CHAT_RATE_WINDOW);
        if (recent.length >= CHAT_RATE_MAX) {
          sendPacket(wt, packetManager.notify({ message: "You are sending messages too fast." }));
          return;
        }
        recent.push(now);
        chatRateLimit.set(wt.data.id, recent);

        const mode = messageData?.mode;

        const sendMessageToPlayer = (playerWs: any, message: string) => {
          const chatData = {
            id: wt.data.id,
            message,
            username: currentPlayer.username,
          };
          sendPacket(playerWs, packetManager.chat(chatData));
        };

        if (message == null) {
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          playersInMap.forEach((player) => {
            sendMessageToPlayer(player.wt, "");
          });
          return;
        }

        let decryptedMessage;
        if (mode && mode == "decrypt") {
          const encryptedMessage = Buffer.from(
            Object.values(message) as number[]
          );
          const privateKey = _privateKey;
          if (!privateKey) return;
          const decryptedPrivateKey = decryptPrivateKey(
            privateKey,
            process.env.RSA_PASSPHRASE || ""
          ).toString();
          decryptedMessage =
            decryptRsa(encryptedMessage, decryptedPrivateKey) || "";
        } else {
          decryptedMessage = message;
        }

        // Ghosts (non-admin) speak only in spirit-tongue: random short
        // O-words, deliberately unrelated to the real message's length.
        if (ghostSpeak) {
          decryptedMessage = generateGhostSpeak();
        }

        sendMessageToPlayer(wt, decryptedMessage as string);

        const cache = playerCache.list();
        let playersInMap = Object.values(cache).filter(
          (p) =>
            p.location.map === currentPlayer.location.map && p.id !== wt.data.id
        );

        listener.emit(Events.PLAYER_CHAT, { player: currentPlayer, message: decryptedMessage || data?.toString(), mapName: currentPlayer.location.map });

        if (currentPlayer.isStealth) {

          playersInMap = playersInMap.filter((p) => p.isAdmin);
        }

        if (playersInMap.length === 0) return;

        const translations: Record<string, string> = {};

        playersInMap.forEach(async (player) => {
          if (!translations[player.language]) {

            translations[player.language] =
              player.language === currentPlayer.language
                ? decryptedMessage
                : await language.translate(decryptedMessage, player.language);
          }

          const chatData = {
            id: wt.data.id,
            message: translations[player.language],
            username: currentPlayer.username,
          };

          sendPacket(player.wt, packetManager.chat(chatData));
        });
        break;
      }
      case "TYPING": {
        if (!currentPlayer || currentPlayer?.isGuest) return;
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        const typingData = {
          id: wt.data.id,
        };
        let playersInMap = filterPlayersByMap(currentPlayer.location.map);
        if (currentPlayer.isStealth) {
          playersInMap = playersInMap.filter((p) => p.isAdmin);
        }
        playersInMap.forEach((player) => {
          sendPacketBestEffort(player.wt, packetManager.typing(typingData));
        });
        break;
      }
      case "EDITOR_TILE_EDIT": {
        // Relay live tile edits from one admin/editor to other admins editing the
        // same map so concurrent editors stay in sync (no save-time clobbering).
        if (!currentPlayer || !currentPlayer.isAdmin) return;
        const editData = data as any;
        if (!editData || !Array.isArray(editData.edits)) return;

        const mapName = editData.mapName;
        if (mapName) {
          // Store in history so new editors can sync unsaved work
          if (!editorEditHistory.has(mapName)) {
            editorEditHistory.set(mapName, []);
          }
          editorEditHistory.get(mapName)!.push({ senderId: wt.data.id, mapName, edits: editData.edits });
        }

        const targets = filterPlayersByMap(currentPlayer.location.map).filter(
          (p) => p.isAdmin && p.id !== wt.data.id && p.wt?.readyState === 1
        );
        if (targets.length === 0) break;
        const relay = { senderId: wt.data.id, mapName: editData.mapName, edits: editData.edits };
        targets.forEach((player) => {
          sendPacket(player.wt, packetManager.editorTileEdit(relay));
        });
        break;
      }
      case "EDITOR_LAYER_LOCK": {
        // Relay layer lock/unlock changes to other admins on the same map.
        if (!currentPlayer || !currentPlayer.isAdmin) return;
        const lockData = data as any;
        if (!lockData || lockData.mapName !== currentPlayer.location.map) return;
        const targets = filterPlayersByMap(currentPlayer.location.map).filter(
          (p) => p.isAdmin && p.id !== wt.data.id && p.wt?.readyState === 1
        );
        if (targets.length === 0) break;
        const relay = { mapName: lockData.mapName, layerName: lockData.layerName, locked: lockData.locked };
        targets.forEach((player) => {
          sendPacket(player.wt, packetManager.editorLayerLock(relay));
        });
        break;
      }
      case "EDITOR_OPEN": {
        if (!currentPlayer || !currentPlayer.isAdmin) return;
        const mapName = currentPlayer.location.map;
        if (!activeEditorsByMap.has(mapName)) {
          activeEditorsByMap.set(mapName, new Set());
        }
        activeEditorsByMap.get(mapName)!.add(wt.data.id);

        // Replay all unsaved edits as one batch.
        const history = editorEditHistory.get(mapName);
        if (history && history.length > 0) {
          const allEdits: any[] = [];
          for (const entry of history) {
            if (!Array.isArray(entry.edits)) continue;
            for (const edit of entry.edits) {
              allEdits.push(edit);
            }
          }
          if (allEdits.length > 0) {
            sendPacket(wt, packetManager.editorTileEdit({ mapName, edits: allEdits }));
          }
        }

        sendPacket(wt, packetManager.editorSyncReady({ mapName }));
        break;
      }
      case "EDITOR_CLOSE": {
        if (!currentPlayer || !currentPlayer.isAdmin) return;
        const mapName = currentPlayer.location.map;
        const editors = activeEditorsByMap.get(mapName);
        if (editors) {
          editors.delete(wt.data.id);
          if (editors.size === 0) {
            activeEditorsByMap.delete(mapName);
            // No editors left on this map - clear unsaved edit history
            editorEditHistory.delete(mapName);
          }
        }
        break;
      }
      case "CLIENTCONFIG": {
        if (!currentPlayer) return;
        await player.setConfig(wt.data.id, data);
        break;
      }
      case "SELECTPLAYER": {
        if (!currentPlayer) return;
        const location = data as unknown as LocationData;
        const cache = playerCache.list();

        const players = Object.values(cache).filter(
          (p) => p.location.map === currentPlayer.location.map
        );

        // Taps from touch devices get a wider pick area: a fingertip is far
        // less precise than a cursor. With the wider area two players can both
        // qualify, so the nearest one wins.
        const pickRange = (data as any)?.touch === true ? 49 : 35;
        const pickX = Math.floor(Number(location.x));
        const pickY = Math.floor(Number(location.y));
        let selectedPlayer: any = null;
        let selectedDistSq = Infinity;
        for (const p of players) {
          const dx = p.location.position.x - pickX;
          const dy = p.location.position.y - pickY;
          if (Math.abs(dx) >= pickRange || Math.abs(dy) >= pickRange) continue;
          const distSq = dx * dx + dy * dy;
          if (distSq < selectedDistSq) {
            selectedPlayer = p;
            selectedDistSq = distSq;
          }
        }

        if (!selectedPlayer) break;
        // Corpses cannot be targeted (despawned for observers). Ghosts can be
        // targeted and interacted with, except while their graveyard teleport
        // is still pending (not rendered anywhere yet).
        if (selectedPlayer.isDead || (selectedPlayer.isGhost && selectedPlayer.ghostTeleportPending)) {
          const selectPlayerData = {
            id: wt.data.id,
            data: null,
          };
          sendPacket(wt, packetManager.selectPlayer(selectPlayerData));
          break;
        }
        if (selectedPlayer.isStealth && !currentPlayer.isAdmin) {
          const selectPlayerData = {
            id: wt.data.id,
            data: null,
          };
          sendPacket(wt, packetManager.selectPlayer(selectPlayerData));
          break;
        } else {
          const selectPlayerData = {
            id: selectedPlayer.id,
            username: selectedPlayer.username,
            stats: selectedPlayer.stats,
          };
          sendPacket(wt, packetManager.selectPlayer(selectPlayerData));
        }
        break;
      }
      case "TARGETCLOSEST": {
        if (!currentPlayer) return;

        // Tab-target reach = AOI radius: you can target anyone you can actually
        // see rendered, even if no spell can reach them. Spell range is enforced
        // separately at cast time ("Target is out of range"), so a wider select
        // range never lets you hit something you couldn't before.
        const TARGETING_RANGE = (AOI_CONFIG as any).DEFAULT_RADIUS ?? 1000;
        const CONE_ANGLE = 90; // 90 degree cone (45 degrees on each side of facing direction)

        const _tcT0 = PROFILE ? performance.now() : 0;

        // Get all players on the same map
        const playersInRange = filterPlayersByDistance(
          wt,
          TARGETING_RANGE,
          currentPlayer.location.map
        ).filter((p) => !p.isStealth && !p.isDead && !(p.isGhost && p.ghostTeleportPending) && p.id !== currentPlayer.id);

        const _tcT1 = PROFILE ? performance.now() : 0;

        // Find next player target using cone-based directional targeting with cycling
        const currentTargetId = currentTargetMap.get(currentPlayer.id) || null;
        const nextPlayer = player.getNextTargetInCone(
          currentPlayer,
          playersInRange,
          TARGETING_RANGE,
          currentTargetId,
          CONE_ANGLE
        );

        const _tcT2 = PROFILE ? performance.now() : 0;

        // Closest creature in the facing cone, cycling like players do.
        const creatureCandidates = creatures.coneTargets(currentPlayer, TARGETING_RANGE, CONE_ANGLE);
        let nextCreature: { id: number; distance: number } | null = null;
        if (creatureCandidates.length > 0) {
          const currentTargetId = currentTargetMap.get(currentPlayer.id) || null;
          const currentIndex = creatureCandidates.findIndex((c) => `c:${c.id}` === currentTargetId);
          nextCreature = currentIndex === -1 || currentIndex === creatureCandidates.length - 1
            ? creatureCandidates[0]
            : creatureCandidates[currentIndex + 1];
        }

        // Pick whichever is closer: the next player or the next creature.
        let targetToSelect: any = null;
        if (nextPlayer && nextCreature) {
          const playerPos = nextPlayer?.location?.position as any;
          const playerDistance = Math.hypot(currentPlayer.location.position.x - playerPos.x, currentPlayer.location.position.y - playerPos.y);
          targetToSelect = playerDistance < nextCreature.distance ? nextPlayer : nextCreature;
        } else {
          targetToSelect = nextPlayer || nextCreature;
        }
        if (targetToSelect) {
          // Update current target for cycling
          currentTargetMap.set(currentPlayer.id, targetToSelect.stats ? targetToSelect.id : `c:${targetToSelect.id}`);

          if (targetToSelect.stats) {
            // It's a player
            const selectPlayerData = {
              id: targetToSelect.id || null,
              username: targetToSelect.username || null,
              stats: targetToSelect.stats || null,
            };
            sendPacket(wt, packetManager.selectPlayer(selectPlayerData));
          } else {
            sendPacket(wt, packetManager.creatureTargeted({ id: targetToSelect.id }));
          }
        }
        if (PROFILE) {
          const now = performance.now();
          prof.tcFilterMs += _tcT1 - _tcT0;
          prof.tcConeMs += _tcT2 - _tcT1;
          prof.tcCreatureMs += now - _tcT2;
          prof.tcCount++;
        }
        break;
      }
      case "INSPECTPLAYER": {
        if (currentPlayer) {
          const targetId = (data as any)?.id;

          const targetPlayer = targetId
            ? playerCache.get(targetId)
            : currentPlayer;

          if (targetPlayer) {
            const inspectPlayerData = {
              id: targetPlayer.id,
              stats: targetPlayer.stats,
              username: targetPlayer.username,
              equipment: targetPlayer.equipment || {},
              inventory: targetPlayer.inventory || [],
            };
            sendPacket(wt, packetManager.inspectPlayer(inspectPlayerData));
          }
        }
        break;
      }
      case "NOCLIP": {
        if (!currentPlayer?.isAdmin) return;
        const isNoclip = await player.toggleNoclip(currentPlayer.username);
        currentPlayer.isNoclip = isNoclip;
        const noclipData = {
          id: wt.data.id,
          isNoclip: currentPlayer.isNoclip,
        };
        sendPacket(wt, packetManager.noclip(noclipData));
        break;
      }
      case "STEALTH": {
        if (!currentPlayer?.isAdmin) return;
        const isStealth = await player.toggleStealth(currentPlayer.username);
        currentPlayer.isStealth = isStealth;
        const playersInMap = filterPlayersByMap(currentPlayer.location.map);
        const stealthData = {
          id: wt.data.id,
          isStealth: currentPlayer.isStealth,
        };
        sendPacket(wt, packetManager.stealth(stealthData));
        playersInMap.forEach((player) => {
          const stealthData = {
            id: wt.data.id,
            isStealth: currentPlayer.isStealth,
          };
          sendPacket(player.wt, packetManager.stealth(stealthData));
        });
        if (isStealth) {
          // When stealthing, despawn from other players (admins can still see stealthed players)
          playersInMap.forEach((player) => {
            if (player.id === currentPlayer.id) return;
            if (player.isAdmin) return;
            sendPacket(player.wt, packetManager.despawnPlayer(currentPlayer.id as string));
          });
        } else if (!isStealth) {
          globalStateRevision++;
          // Spawn the admin to all other players using the same spawn packet format
          // First fetch sprite data asynchronously
          const animationName = getAnimationNameForDirection(
            currentPlayer.location.position?.direction || "down",
            !!currentPlayer.moving,
            !!currentPlayer.mounted,
            currentPlayer.mount_type,
            !!currentPlayer.casting
          );
          const playerSpriteData = await getPlayerSpriteSheetData(animationName, currentPlayer.equipment || null);
          const mountSpriteForBatch = currentPlayer.mount_type ? getMountSpriteUrl(currentPlayer.mount_type) : null;

          let spriteData = null;
          if (playerSpriteData?.bodySprite || playerSpriteData?.headSprite || mountSpriteForBatch) {
            spriteData = {
              mountSprite: mountSpriteForBatch,
              bodySprite: playerSpriteData.bodySprite || null,
              headSprite: playerSpriteData.headSprite || null,
              armorHelmetSprite: playerSpriteData.armorHelmetSprite || null,
              armorShoulderguardsSprite: playerSpriteData.armorShoulderguardsSprite || null,
              armorNeckSprite: playerSpriteData.armorNeckSprite || null,
              armorHandsSprite: playerSpriteData.armorHandsSprite || null,
              armorChestSprite: playerSpriteData.armorChestSprite || null,
              armorFeetSprite: playerSpriteData.armorFeetSprite || null,
              armorLegsSprite: playerSpriteData.armorLegsSprite || null,
              armorWeaponSprite: playerSpriteData.armorWeaponSprite || null,
              animationState: playerSpriteData.animationState,
            };
          }

          const nonAdminPlayers = playersInMap.filter((player) => {
            if (player.id === currentPlayer.id) return false;
            if (player.isAdmin) return false;
            return true;
          });

          queueSpawnForReceivers(currentPlayer, nonAdminPlayers, spriteData);

          for (const player of nonAdminPlayers) {
            const moveXYData = {
              i: wt.data.id,
              d: {
                x: Number(currentPlayer.location.position.x),
                y: Number(currentPlayer.location.position.y),
                dr: currentPlayer.location.position.direction
              },
              r: globalStateRevision,
              s: currentPlayer.isStealth ? 1 : 0
            };

            if (currentPlayer.location.position?.direction) {
              sendPacket(player.wt, packetManager.moveXY(moveXYData));
            }
          }
        }
        listener.emit(Events.PLAYER_STEALTH_CHANGE, { player: currentPlayer, isStealth: currentPlayer.isStealth });
        break;
      }
      case "DRAG_PLAYER_START": {
        // Check for admin.drag or admin.* permission
        if (!currentPlayer || !Array.isArray(currentPlayer.permissions)) {
          sendPacket(wt, packetManager.notify({ message: "Permissions not loaded" }));
          break;
        }

        const hasPermission = currentPlayer.permissions.some(
          (p: string) => p === "admin.drag" || p === "admin.*"
        );

        if (!hasPermission) {
          break;
        }

        const targetPlayerId = (data as any)?.id;
        if (!targetPlayerId) break;

        const targetPlayer = playerCache.get(targetPlayerId);
        if (!targetPlayer) break;

        // Track that this player is being dragged
        draggedPlayersMap.set(targetPlayerId, wt.data.id);

        // Send confirmation to admin that drag started
        const dragStartData = {
          id: targetPlayerId,
          adminId: wt.data.id,
        };
        sendPacket(wt, packetManager.dragPlayerStart(dragStartData));

        // Notify all players on the map that drag started
        const playersInMap = filterPlayersByMap(targetPlayer.location.map);
        playersInMap.forEach((p) => {
          if (p.wt && p.wt.readyState === 1) {
            sendPacket(p.wt, packetManager.dragPlayerStart(dragStartData));
          }
        });
        break;
      }
      case "DRAG_PLAYER_STOP": {
        // Check for admin.drag or admin.* permission
        if (!currentPlayer || !Array.isArray(currentPlayer.permissions)) break;

        const hasPermission = currentPlayer.permissions.some(
          (p: string) => p === "admin.drag" || p === "admin.*"
        );

        if (!hasPermission) break;

        const targetPlayerId = (data as any)?.id;
        if (!targetPlayerId) break;

        const targetPlayer = playerCache.get(targetPlayerId);
        if (!targetPlayer) break;

        // Remove tracking that this player was being dragged
        draggedPlayersMap.delete(targetPlayerId);

        // Send confirmation to admin that drag stopped
        const dragStopData = {
          id: targetPlayerId,
          adminId: wt.data.id,
        };
        sendPacket(wt, packetManager.dragPlayerStop(dragStopData));

        // Notify all players on the map that drag stopped
        const playersInMap = filterPlayersByMap(targetPlayer.location.map);
        playersInMap.forEach((p) => {
          if (p.wt && p.wt.readyState === 1) {
            sendPacket(p.wt, packetManager.dragPlayerStop(dragStopData));
          }
        });
        break;
      }
      case "DRAG_UPDATE": {
        // Check for admin.drag or admin.* permission
        if (!currentPlayer || !Array.isArray(currentPlayer.permissions)) break;

        const hasPermission = currentPlayer.permissions.some(
          (p: string) => p === "admin.drag" || p === "admin.*"
        );

        if (!hasPermission) break;

        const targetPlayerId = (data as any)?.id;
        const newX = (data as any)?.x;
        const newY = (data as any)?.y;

        if (targetPlayerId === undefined || newX === undefined || newY === undefined) break;

        const targetPlayer = playerCache.get(targetPlayerId);
        if (!targetPlayer) break;

        // Update target player position without collision check (admin drag bypasses collision)
        targetPlayer.location.position.x = newX;
        targetPlayer.location.position.y = newY;

        // Persist to database
        try {
          await player.setLocation(
            targetPlayer.session_id,
            targetPlayer.location.map,
            {
              x: newX,
              y: newY,
              direction: targetPlayer.location.position.direction,
            }
          );
        } catch (e) {
          log.error(`Failed to set location for dragged player: ${e}`);
        }

        // Update AOI boundaries for the dragged player to handle visibility changes
        await updatePlayerAOI(targetPlayer);

        // Broadcast position update to all players in AOI
        globalStateRevision++;
        const moveXYData = {
          i: targetPlayerId,
          d: {
            x: Number(newX),
            y: Number(newY),
            dr: targetPlayer.location.position.direction,
          },
          r: globalStateRevision,
          s: targetPlayer.isStealth ? 1 : 0,
        };

        broadcastToAOI(targetPlayer, packetManager.moveXY(moveXYData), true);
        break;
      }
      case "SAVE_HOTBAR": {
        if (!currentPlayer) return;
        await player.saveHotBarConfig(currentPlayer.username, data as any);
        break;
      }
      case "SAVE_INVENTORY_CONFIG": {
        if (!currentPlayer) return;
        await player.saveInventoryConfig(currentPlayer.username, data as any);
        break;
      }
      case "CREATURE_ATTACK": {
        if (!currentPlayer) return;
        const creatureId = (data as any)?.id;
        if (creatureId === null || creatureId === undefined) {
          creatures.stopAutoAttack(currentPlayer);
          break;
        }
        if (currentPlayer.isDead || currentPlayer.isGhost || currentPlayer.isGuest) return;
        const creature = creatures.getCreature(Number(creatureId));
        if (!creature || !creatures.isTargetableBy(currentPlayer, creature)) {
          sendPacket(wt, packetManager.creatureAttackStopped(Number(creatureId)));
          break;
        }
        if (creatures.startAutoAttack(currentPlayer, creature.id)) {
          sendPacket(wt, packetManager.creatureAttackStopped(creature.id));
        }
        break;
      }
      case "CREATURE_EDITOR_LIST":
      case "CREATURE_EDITOR_CLOSE":
      case "CREATURE_EDITOR_SAVE_TEMPLATE":
      case "CREATURE_EDITOR_DELETE_TEMPLATE":
      case "CREATURE_EDITOR_SAVE_ABILITY":
      case "CREATURE_EDITOR_DELETE_ABILITY":
      case "CREATURE_EDITOR_SAVE_ABILITIES":
      case "CREATURE_EDITOR_SAVE_SPAWN":
      case "CREATURE_EDITOR_DELETE_SPAWN":
      case "CREATURE_EDITOR_SAVE_PATH":
      case "CREATURE_EDITOR_DELETE_PATH":
      case "CREATURE_EDITOR_SAVE_LINKGROUP":
      case "CREATURE_EDITOR_DELETE_LINKGROUP":
      case "CREATURE_EDITOR_SAVE_POOL":
      case "CREATURE_EDITOR_DELETE_POOL":
      case "CREATURE_EDITOR_ACTION": {
        if (!currentPlayer) return;
        // Permission is re-checked on every editor packet, not just on /ce.
        if (!creatures.canUseEditor(currentPlayer)) {
          sendPacket(wt, packetManager.notify({ message: "You don't have permission to use the creature editor." }));
          break;
        }
        const result = await creatures.handleEditorPacket(currentPlayer, type, data);
        if (result.kind === "data") {
          sendPacket(wt, packetManager.creatureEditorData(result.data));
          break;
        }
        if (result.kind === "goto" && result.goto) {
          const destMap = String(result.goto.map).replace(".json", "");
          const currentMap = String(currentPlayer.location?.map ?? "").replace(".json", "");
          if (destMap === currentMap) {
            // Already on that map: move there like an admin teleport, without
            // reloading the map (a reload wipes everything the client shows).
            const direction = currentPlayer.location.position?.direction || "down";
            currentPlayer.location.position = {
              ...currentPlayer.location.position,
              x: Math.round(Number(result.goto.x)),
              y: Math.round(Number(result.goto.y)),
              direction,
            };
            globalStateRevision++;
            if (shouldUpdateAOI(currentPlayer)) {
              await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
            }
            broadcastToAOI(currentPlayer, packetManager.moveXY({
              i: wt.data.id,
              d: { x: currentPlayer.location.position.x, y: currentPlayer.location.position.y, dr: direction },
              r: globalStateRevision,
              s: currentPlayer.isStealth ? 1 : 0,
            }), true);
          } else {
            await teleportPlayerWrapper(currentPlayer, result.goto.map, result.goto.x, result.goto.y);
          }
          sendPacket(wt, packetManager.creatureEditorResult({ ok: true, errors: [], action: type }));
          break;
        }
        if (result.kind === "result") {
          sendPacket(wt, packetManager.creatureEditorResult({ ok: result.ok, errors: result.errors, id: result.id, action: type }));
          if (result.ok) {
            const updated = packetManager.creatureEditorUpdated({ by: currentPlayer.username });
            for (const viewerId of creatures.editorViewerIds()) {
              if (viewerId === currentPlayer.id) continue;
              const viewer = playerCache.get(viewerId);
              if (viewer?.wt) sendPacket(viewer.wt, updated);
            }
          }
        }
        break;
      }
      case "ITEM_EDITOR_LIST":
      case "ITEM_EDITOR_SEARCH":
      case "ITEM_EDITOR_SAVE":
      case "ITEM_EDITOR_DELETE": {
        if (!currentPlayer) return;
        // Permission is re-checked on every editor packet, not just on /ie.
        if (!itemEditor.canUseEditor(currentPlayer)) {
          sendPacket(wt, packetManager.notify({ message: "You don't have permission to use the item editor." }));
          break;
        }
        const result = await itemEditor.handleEditorPacket(type, data);
        if (result.kind === "data") {
          sendPacket(wt, packetManager.itemEditorData(result.data));
          break;
        }
        if (result.kind === "search") {
          sendPacket(wt, packetManager.itemEditorResults(result.data));
          break;
        }
        sendPacket(wt, packetManager.itemEditorResult({ ok: result.ok, errors: result.errors, name: result.name, action: type }));
        if (result.ok) {
          // Items are cached per process; tell every other editor to reload.
          const updated = packetManager.itemEditorUpdated({ by: currentPlayer.username });
          for (const other of Object.values(playerCache.list()) as any[]) {
            if (!other?.wt || other.id === currentPlayer.id) continue;
            if (itemEditor.canUseEditor(other)) sendPacket(other.wt, updated);
          }
        }
        break;
      }
      case "CREATURE_DEBUG_SUBSCRIBE": {
        if (!currentPlayer) return;
        if (!creatures.canUseEditor(currentPlayer)) return;
        creatures.setDebugSubscription(currentPlayer.id, !!(data as any)?.on);
        break;
      }
      case "CREATURE_LOOT":
      case "CREATURE_LOOT_TAKE": {
        if (!currentPlayer) return;
        if (currentPlayer.isDead || currentPlayer.isGhost || currentPlayer.isGuest) return;
        const creatureId = Number((data as any)?.id);
        if (!Number.isFinite(creatureId)) return;
        const lootErrors: Record<string, string> = {
          not_found: "Corpse not found.",
          too_far: "You are too far away to loot that.",
          not_allowed: "You don't have permission to loot that corpse.",
          empty: "There is nothing to loot.",
        };
        if (type === "CREATURE_LOOT") {
          const opened = creatures.openCorpseFor(currentPlayer, creatureId);
          if (typeof opened === "string") {
            sendPacket(wt, packetManager.notify({ message: lootErrors[opened] }));
            break;
          }
          sendPacket(wt, packetManager.creatureLootContents({ id: creatureId, items: opened.items, copper: opened.copper }));
          break;
        }
        const rawIndices = (data as any)?.indices;
        const indices = Array.isArray(rawIndices) ? rawIndices.map(Number).filter(Number.isFinite) : null;
        const result = await creatures.takeCorpseLootFor(currentPlayer, creatureId, indices);
        if (typeof result === "string") {
          sendPacket(wt, packetManager.notify({ message: lootErrors[result] }));
          break;
        }
        if (result.taken.length > 0) {
          currentPlayer.inventory = await inventory.get(currentPlayer.username);
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        }
        break;
      }
      case "HOTBAR": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot cast.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        // GM stealth is non-interactive: an invisible admin casting would hit
        // things (AoE, ground zones, projectiles) while nothing can see or fight
        // back, and the visuals would give the admin away anyway.
        if (currentPlayer.isStealth) return;
        if (currentPlayer.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }


        const casting = playerCache.get(currentPlayer.id)?.casting;
        if (casting) {
          return;
        }

        const freshPlayerForDelay = playerCache.get(currentPlayer.id);
        const lastCastTime = freshPlayerForDelay?.lastCastTime || 0;
        const timeSinceLastCast = performance.now() - lastCastTime;
        const globalCastDelay = 500;
        if (timeSinceLastCast < globalCastDelay) {
          return;
        }

        // Spell lockout (e.g. from an interrupt): all casting is blocked until it expires
        const spellLockoutUntil = freshPlayerForDelay?.spellLockoutUntil || 0;
        if (spellLockoutUntil > performance.now()) {
          return;
        }

        // Stunned players cannot cast. stunnedUntil is an epoch timestamp
        // (Date.now()-based), so it must be compared against Date.now().
        if (freshPlayerForDelay?.stunnedUntil && freshPlayerForDelay.stunnedUntil > Date.now()) {
          return;
        }

        const spell_identifier = (data as any).spell;
        let targetId = (data as any).target?.id;
        log.debug(`[ATTACK] Spell cast request - spell=${spell_identifier}, targetId=${targetId}`);

        const spell = await spells.find(spell_identifier);
        const spell_id = spell?.id;
        if (!spell || !spell_id) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Invalid spell selected." })
          );
          break;
        }

        if (!spell_identifier) {
          sendPacket(
            wt,
            packetManager.notify({ message: "No spell selected." })
          );
          break;
        }

        if (!currentPlayer.learnedSpells?.[spell.name]) {
          sendPacket(wt, packetManager.notify({ message: "You have not learned this spell." }));
          return;
        }

        if ((data as any).creature === true) {
          // As in WoW: a friendly spell (a heal, or harmless effects only) cast
          // with an enemy selected lands on the caster instead of failing.
          const creatureSpellValue = Number(spell.damage) || 0;
          const friendlySpell = creatureSpellValue < 0 ||
            (creatureSpellValue === 0 && Array.isArray(spell.effects) && spell.effects.length > 0 && !spellHasHostileEffects(spell));
          // An AoE centred on the caster (Flamestrike-style) ignores the
          // selection: the normal cast hits every player and creature around
          // the caster, so the selected creature is not needed.
          const casterCentredAoe = (Number(spell.aoe_radius) || 0) > 0 && spell.ground_aoe !== 1;
          if (!friendlySpell && !casterCentredAoe) {
            await castSpellOnCreature(wt, currentPlayer, spell, Number(targetId));
            return;
          }
          targetId = currentPlayer.id;
        }

        log.debug(`[ATTACK] Looking for target ID: ${targetId}`);
        let target = null;

        target = playerCache.get(targetId);
        if (target) {
          log.debug(`[ATTACK] Found target as player: ${target.username}`);
        } else if (targetId) {
          log.debug(`[ATTACK] Player target not found in cache: ${targetId}`);
        }

        if (!target && !targetId) {
          // Only default to self if no target was specified
          target = currentPlayer;
          log.debug(`[ATTACK] No target specified, defaulting to self`);
        }

        // Ghosts cannot be targeted or damaged.
        if (target && target.isGhost) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You cannot attack ghosts." })
          );
          return;
        }

        // AoE spells don't need a valid target - they hit everything around the caster
        const isAoeSpell = spell?.aoe_radius && spell.aoe_radius > 0;
        const isGroundAoe = spell?.ground_aoe === 1 && (data as any).groundX !== undefined && (data as any).groundY !== undefined;

        if (!isAoeSpell && !isGroundAoe && !target?.id) {
          log.debug(`[ATTACK] Player ${currentPlayer.username} attempted attack with invalid target: ${targetId}`);
          sendPacket(
            wt,
            packetManager.notify({ message: "Target not found." })
          );
          return;
        }

        // Only guests check applies to players, not entities
        if (target.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You cannot attack guests." })
          );
          return;
        }

        // These are re-evaluated later if the target changes (auto-self-cast)
        let isSelf = (target.id === currentPlayer.id) || (currentPlayer.username === target.username);

        const freshPlayerForCooldown = playerCache.get(currentPlayer.id);
        if (!freshPlayerForCooldown) return;
        freshPlayerForCooldown.spellCooldowns = freshPlayerForCooldown.spellCooldowns || {};
        const spellCooldownEnd = freshPlayerForCooldown.spellCooldowns[spell_id] || 0;
        if (spellCooldownEnd > performance?.now()) {
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "cooldown" } as any);
          return;
        }

        const spell_range = spell.range || 100;
        const spell_damage = spell?.damage;
        const spell_mana = spell?.mana || 0;
        const hasEffects = Array.isArray(spell?.effects) && spell.effects.length > 0;
        const spellIsHostileEffect = spellHasHostileEffects(spell);
        const playerLevel = currentPlayer.stats.level || 1;

        if (currentPlayer.isVanished && spell_damage <= 0 && !spellIsHostileEffect) {
          const hasVanishEffect = Array.isArray(spell?.effects) && spell.effects.some((e: SpellEffect) => e.type === "vanish");
          if (!hasVanishEffect) {
            sendPacket(wt, packetManager.notify({ message: "You cannot cast beneficial spells while vanished." }));
            listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "vanished" } as any);
            return;
          }
        }

        currentPlayer.interruptableSpell = !spell?.can_move || false;

        // A stand-still spell pressed while moving simply does nothing: it
        // never started, so there is no cast to interrupt and nothing to show.
        if (!spell?.can_move && currentPlayer.moving) {

          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "moving" } as any);
          return;
        }

        const freshPlayerForMana = playerCache.get(currentPlayer.id);
        if (!freshPlayerForMana) return;

        // WoW-style: a percentage of base stamina (level only, not gear).
        const actualManaCost = spellManaCost(spell_mana, freshPlayerForMana.stats);
        if ((freshPlayerForMana.stats.stamina || 0) < actualManaCost) {
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "mana" } as any);
          return;
        }

        if (!spell_damage && !hasEffects) {
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "no_effects" } as any);
          return;
        }

        // ATOMIC: Set cooldown immediately to prevent race condition with mana deduction
        // This must happen before any other async operations
        // Only apply spell cooldown (not cast_time) for faster feel
        freshPlayerForMana.spellCooldowns = freshPlayerForMana.spellCooldowns || {};
        const spellCooldownTime = spell.cooldown * 1000;
        freshPlayerForMana.spellCooldowns[spell_id] = performance.now() + spellCooldownTime;
        cooldownManager.setCooldown(freshPlayerForMana.username, spell_id, performance.now() + spellCooldownTime);
        freshPlayerForMana.lastCastTime = performance.now();
        freshPlayerForMana.castingSpellId = spell_id;

        playerCache.set(freshPlayerForMana.id, freshPlayerForMana);

        currentPlayer.stats = freshPlayerForMana.stats;
        currentPlayer.lastCastTime = freshPlayerForMana.lastCastTime;
        currentPlayer.spellCooldowns = freshPlayerForMana.spellCooldowns;

        if (currentPlayer.isVanished && (spell_damage > 0 || spellIsHostileEffect)) {
          const vanishId = spellEffects.getVanishedEffectId(currentPlayer);
          if (vanishId) {
            cancelEffect(currentPlayer, vanishId);
            spellEffects.broadcastEffectsUpdate(currentPlayer);
          }
        }
        currentPlayer.lastCastTime = freshPlayerForMana.lastCastTime;
        currentPlayer.spellCooldowns = freshPlayerForMana.spellCooldowns;

        // --- AoE branch: cast on self, hit everything around the caster ---
        if (isAoeSpell && !isGroundAoe) {
          currentPlayer.casting = true;
          currentPlayer.castId = (currentPlayer.castId || 0) + 1;
          playerCache.set(currentPlayer.id, currentPlayer);
          const thisAoeCastId = currentPlayer.castId;
          const aoeSpellStartTime = performance.now();

          if (currentPlayer.mounted) {
            currentPlayer.mounted = false;
            playerCache.set(currentPlayer.id, currentPlayer);
          }

          globalStateRevision++;
          await sendPositionAnimation(wt, currentPlayer.location.position?.direction || "down", currentPlayer.moving || false, false, currentPlayer.mount_type || "unicorn", undefined, globalStateRevision, true);

          const aoePlayersInMap = filterPlayersByMap(currentPlayer.location.map);
          broadcastCastToMap(
            aoePlayersInMap,
            currentPlayer.id,
            packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: spell.cast_time })
          );

          await new Promise((resolve) => setTimeout(resolve, spell.cast_time * 1000));

          const aoeCheckPlayer = playerCache.get(currentPlayer.id);
          if (aoeCheckPlayer && aoeCheckPlayer.castId !== thisAoeCastId) return;

          const aoeUpdatedPlayer = playerCache.get(currentPlayer.id);
          if (aoeUpdatedPlayer && aoeUpdatedPlayer.manualSpellCancel && aoeUpdatedPlayer.manualSpellCancel >= aoeSpellStartTime) {
            if (aoeUpdatedPlayer.spellCooldowns) {
              delete aoeUpdatedPlayer.spellCooldowns[spell_id];
              cooldownManager.deleteCooldown(aoeUpdatedPlayer.username, spell_id);
            }
            delete aoeUpdatedPlayer.manualSpellCancel;
            aoeUpdatedPlayer.casting = false;
            playerCache.set(aoeUpdatedPlayer.id, aoeUpdatedPlayer);
            currentPlayer.spellCooldowns = aoeUpdatedPlayer.spellCooldowns;
            currentPlayer.manualSpellCancel = undefined;
            currentPlayer.casting = false;
            return;
          }

          if (!spell.can_move && !playerCache.get(currentPlayer.id)?.casting) {
            const resetPlayer = playerCache.get(currentPlayer.id);
            if (resetPlayer && resetPlayer.spellCooldowns) {
              delete resetPlayer.spellCooldowns[spell_id];
              playerCache.set(resetPlayer.id, resetPlayer);
            }
            return;
          }

          currentPlayer.casting = false;
          currentPlayer.mounted = false;
          playerCache.set(currentPlayer.id, currentPlayer);

          globalStateRevision++;
          await sendPositionAnimation(wt, currentPlayer.location.position?.direction || "down", currentPlayer.moving || false, false, currentPlayer.mount_type || "unicorn", undefined, globalStateRevision, false);

          // Mana deduction
          const aoeManaCheck = playerCache.get(currentPlayer.id);
          if (!aoeManaCheck || (aoeManaCheck.stats.stamina || 0) < actualManaCost) {
            if (aoeManaCheck && aoeManaCheck.spellCooldowns) {
              delete aoeManaCheck.spellCooldowns[spell_id];
              cooldownManager.deleteCooldown(aoeManaCheck.username, spell_id);
              playerCache.set(aoeManaCheck.id, aoeManaCheck);
            }
            return;
          }
          currentPlayer.stats.stamina = aoeManaCheck.stats.stamina;
          currentPlayer.stats.stamina -= actualManaCost;
          if (currentPlayer.stats.stamina < 0) currentPlayer.stats.stamina = 0;

          // AoE splash from caster position
          const aoeX = currentPlayer.location.position.x;
          const aoeY = currentPlayer.location.position.y;
          const aoeRadius = spell.aoe_radius!;

          // Send a projectile packet from caster to self as a visual indicator
          aoePlayersInMap.forEach((p) => {
            sendPacketBestEffort(p.wt, packetManager.projectile({
              id: currentPlayer.id, time: 0.3, target_id: currentPlayer.id,
              spell: spell.name, icon: getIconUrl(spell.icon), entity: false
            }));
          });

          const splashTargets: Array<{ target: any }> = [];
          const aoeIsHeal = spell_damage < 0;
          for (const p of aoePlayersInMap) {
            if (p.id === currentPlayer.id && !aoeIsHeal) continue;
            if (p.isGuest) continue;
            // Ghosts cannot be damaged or healed.
            if (p.isGhost) continue;
            const inParty = currentPlayer?.party?.includes(p?.username) || false;
            if (aoeIsHeal) {
              // Healing AoE: only hit self and party members
              if (p.id !== currentPlayer.id && !inParty) continue;
            } else {
              // Damage AoE: skip self and party members
              if (p.id === currentPlayer.id || inParty) continue;
            }
            const pPos = p.location?.position;
            if (!pPos) continue;
            const dist = Math.sqrt((pPos.x - aoeX) ** 2 + (pPos.y - aoeY) ** 2);
            if (dist <= aoeRadius) splashTargets.push({ target: p });
          }

          // Creatures don't receive healing AoE
          if (!aoeIsHeal) splashCreatures(currentPlayer, spell, aoeX, aoeY, aoeRadius, null);

          const attackerDamageBonus = currentPlayer.stats.stat_damage || 0;
          for (const splash of splashTargets) {
            const st = splash.target;
            // Heals: WoW-style roll (negative = healing); damage: level roll + damage stat.
            let splashDmg = spell_damage < 0
              ? -rollHeal(spell_damage, currentPlayer.stats, spell.cast_time).amount
              : Math.floor(Math.random() * ((playerLevel - 1) * 3 + 1)) + spell_damage + (playerLevel - 1) * 2 + attackerDamageBonus;
            if (spell_damage === 0) splashDmg = 0;

            if (splashDmg > 0) {
              const av = st.stats?.stat_avoidance || 0;
              if (Math.random() * 100 < av) splashDmg = 0;
              if (splashDmg > 0) {
                const ar = st.stats?.stat_armor || 0;
                splashDmg = Math.floor(splashDmg * (1 - Math.min(ar, 75) / 100));
              }
            }

            {
              let toHealth = splashDmg;
              if (splashDmg > 0) {
                const ab = spellEffects.consumeBarrier(st, splashDmg);
                toHealth = splashDmg - ab;
                if (ab > 0) spellEffects.broadcastEffectsUpdate(st);
              }
              st.stats.health = Math.round(st.stats.health - toHealth);
              if (st.stats.health > st.stats.total_max_health) {
                st.stats.health = st.stats.total_max_health;
              }
              listener.emit(Events.PLAYER_DAMAGED, { attacker: currentPlayer, target: st, damage: splashDmg, isCrit: false });

              if (st.stats.health <= 0) {
                await handlePlayerDeath(st, currentPlayer, { damage: splashDmg, isCrit: false });
              } else {
                if (!(spell_damage > 0 && splashDmg === 0)) {
                await spellEffects.applySpellEffects(spell, currentPlayer, st,
                  (pp: any) => { const pls = filterPlayersByMap(pp.location.map); pls.forEach((pl: any) => sendPacket(pl.wt, packetManager.updateStats({ id: pp.id, target: pp.id, stats: pp.stats }))); },
                  (pp: any) => spellEffects.broadcastEffectsUpdate(pp)
                );
                }
                if (spell_damage !== 0) {
                broadcastStatsUpdateToAOI(
                  st,
                  currentPlayer,
                  packetManager.updateStats({ id: wt.data.id, target: st.id, stats: st.stats, isCrit: false, damage: splashDmg })
                );
                }
              }

              setPlayerPvp(currentPlayer, true);
              setPlayerPvp(st, true);
              st.last_attack = performance.now();

              if (spell_damage > 0 && st.isVanished) {
                const vId = spellEffects.getVanishedEffectId(st);
                if (vId) {
                  cancelEffect(st, vId);
                  spellEffects.broadcastEffectsUpdate(st);
                }
              }
            }
          }

          if (currentPlayer.isVanished) {
            const cvId = spellEffects.getVanishedEffectId(currentPlayer);
            if (cvId) {
              cancelEffect(currentPlayer, cvId);
              spellEffects.broadcastEffectsUpdate(currentPlayer);
            }
          }

          // Sync caster stats
          const syncedStats = await player.synchronizeStats(currentPlayer.username);
          if (syncedStats) currentPlayer.stats = syncedStats;
          playerCache.set(currentPlayer.id, currentPlayer);
          broadcastToAOIBestEffort(currentPlayer, packetManager.updateStats({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats }));

          currentPlayer.last_attack = performance.now();
          listener.emit(Events.SPELL_CAST, { player: currentPlayer, spellName: spell.name, target: currentPlayer, isEntityTarget: false });
          break;
        }

        // --- Ground-targeted AoE branch: click-to-place, with optional lingering zone ---
        if (isGroundAoe) {
          const groundX = Number((data as any).groundX);
          const groundY = Number((data as any).groundY);

          // Validate range
          const casterPos = currentPlayer.location.position;
          const casterX = typeof casterPos === 'string' ? Number(casterPos.split(',')[0]) : casterPos.x;
          const casterY = typeof casterPos === 'string' ? Number(casterPos.split(',')[1]) : casterPos.y;
          const distToTarget = Math.sqrt((groundX - casterX) ** 2 + (groundY - casterY) ** 2);
          const maxRange = spell.range || 100;
          if (distToTarget > maxRange) {
            if (freshPlayerForMana.spellCooldowns) {
              delete freshPlayerForMana.spellCooldowns[spell_id];
              cooldownManager.deleteCooldown(freshPlayerForMana.username, spell_id);
            }
            playerCache.set(freshPlayerForMana.id, freshPlayerForMana);
            currentPlayer.spellCooldowns = freshPlayerForMana.spellCooldowns;
            return;
          }

          currentPlayer.casting = true;
          currentPlayer.castId = (currentPlayer.castId || 0) + 1;
          playerCache.set(currentPlayer.id, currentPlayer);
          const thisGroundCastId = currentPlayer.castId;
          const groundCastStartTime = performance.now();

          if (currentPlayer.mounted) {
            currentPlayer.mounted = false;
            playerCache.set(currentPlayer.id, currentPlayer);
          }

          const groundAoERadius = spell.aoe_radius || 0;
          const groundDuration = spell.ground_duration || 0;

          globalStateRevision++;
          await sendPositionAnimation(wt, currentPlayer.location.position?.direction || "down", currentPlayer.moving || false, false, currentPlayer.mount_type || "unicorn", undefined, globalStateRevision, true);

          const groundPlayersInMap = filterPlayersByMap(currentPlayer.location.map);
          broadcastCastToMap(
            groundPlayersInMap,
            currentPlayer.id,
            packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: spell.cast_time, groundX, groundY, groundRadius: groundAoERadius })
          );
          broadcastCastToMap(
            groundPlayersInMap,
            currentPlayer.id,
            packetManager.groundAoeCasting({ id: currentPlayer.id, spell: spell.name, casterId: currentPlayer.id, x: groundX, y: groundY, radius: groundAoERadius, castTime: spell.cast_time })
          );

          await new Promise((resolve) => setTimeout(resolve, spell.cast_time * 1000));

          const groundCheckPlayer = playerCache.get(currentPlayer.id);
          if (groundCheckPlayer && groundCheckPlayer.castId !== thisGroundCastId) return;

          const groundUpdatedPlayer = playerCache.get(currentPlayer.id);
          if (groundUpdatedPlayer && groundUpdatedPlayer.manualSpellCancel && groundUpdatedPlayer.manualSpellCancel >= groundCastStartTime) {
            // Cancel: clear preview
            groundPlayersInMap.forEach((p) => {
              sendPacket(p.wt, packetManager.groundAoeDespawn({ id: currentPlayer.id + "_casting" }));
            });
            if (groundUpdatedPlayer.spellCooldowns) {
              delete groundUpdatedPlayer.spellCooldowns[spell_id];
              cooldownManager.deleteCooldown(groundUpdatedPlayer.username, spell_id);
            }
            delete groundUpdatedPlayer.manualSpellCancel;
            groundUpdatedPlayer.casting = false;
            playerCache.set(groundUpdatedPlayer.id, groundUpdatedPlayer);
            currentPlayer.spellCooldowns = groundUpdatedPlayer.spellCooldowns;
            currentPlayer.manualSpellCancel = undefined;
            currentPlayer.casting = false;
            return;
          }

          if (!spell.can_move && !playerCache.get(currentPlayer.id)?.casting) {
            groundPlayersInMap.forEach((p) => {
              sendPacket(p.wt, packetManager.groundAoeDespawn({ id: currentPlayer.id + "_casting" }));
            });
            const resetPlayer = playerCache.get(currentPlayer.id);
            if (resetPlayer && resetPlayer.spellCooldowns) {
              delete resetPlayer.spellCooldowns[spell_id];
              playerCache.set(resetPlayer.id, resetPlayer);
            }
            return;
          }

          // Clear casting preview
          groundPlayersInMap.forEach((p) => {
            sendPacket(p.wt, packetManager.groundAoeDespawn({ id: currentPlayer.id + "_casting" }));
          });

          currentPlayer.casting = false;
          currentPlayer.mounted = false;
          playerCache.set(currentPlayer.id, currentPlayer);

          globalStateRevision++;
          await sendPositionAnimation(wt, currentPlayer.location.position?.direction || "down", currentPlayer.moving || false, false, currentPlayer.mount_type || "unicorn", undefined, globalStateRevision, false);

          // Mana deduction
          const groundManaCheck = playerCache.get(currentPlayer.id);
          if (!groundManaCheck || (groundManaCheck.stats.stamina || 0) < actualManaCost) {
            if (groundManaCheck && groundManaCheck.spellCooldowns) {
              delete groundManaCheck.spellCooldowns[spell_id];
              cooldownManager.deleteCooldown(groundManaCheck.username, spell_id);
              playerCache.set(groundManaCheck.id, groundManaCheck);
            }
            return;
          }
          currentPlayer.stats.stamina = groundManaCheck.stats.stamina;
          currentPlayer.stats.stamina -= actualManaCost;
          if (currentPlayer.stats.stamina < 0) currentPlayer.stats.stamina = 0;

          const isHeal = spell_damage < 0;
          const isThrown = spell?.is_thrown === 1;
          const resolvedParticles = spell.particles
            ? (typeof spell.particles === 'string'
              ? spell.particles.split(',').map((s: string) => s.trim()).filter(Boolean)
              : [])
            : [];

          if (isThrown) {
            const casterPos = currentPlayer.location.position;
            const cx = typeof casterPos === 'string' ? Number(casterPos.split(',')[0]) : casterPos.x;
            const cy = typeof casterPos === 'string' ? Number(casterPos.split(',')[1]) : casterPos.y;
            const throwDist = Math.sqrt((groundX - cx) ** 2 + (groundY - cy) ** 2);
            const throwSpeed = 350;
            const travelTime = Math.max(0.4, Math.min(throwDist / throwSpeed, 2.5));

            groundPlayersInMap.forEach((p) => {
              sendPacketBestEffort(p.wt, packetManager.projectile({
                id: currentPlayer.id,
                time: travelTime,
                target_id: currentPlayer.id,
                spell: spell.name,
                icon: getIconUrl(spell.icon),
                entity: false,
                isThrown: true,
                targetX: groundX,
                targetY: groundY,
                particles: resolvedParticles.length > 0 ? resolvedParticles : undefined,
              }));
            });

            await new Promise((resolve) => setTimeout(resolve, travelTime * 1000));

            const thrownCheckPlayer = playerCache.get(currentPlayer.id);
            if (thrownCheckPlayer && thrownCheckPlayer.castId !== thisGroundCastId) return;
          }

          if (groundDuration > 0) {
            // Lingering zone
            spawnZone({
              spellId: spell_id,
              spellName: spell.name,
              casterId: currentPlayer.id,
              casterUsername: currentPlayer.username,
              mapName: currentPlayer.location.map,
              position: { x: groundX, y: groundY },
              radius: groundAoERadius,
              duration: groundDuration,
              tickInterval: 1,
              damagePerTick: spell_damage,
              damageType: isHeal ? "heal" : "damage",
              particles: resolvedParticles.length > 0 ? resolvedParticles : null,
              effects: Array.isArray(spell.effects) ? spell.effects : null,
              spell,
            });
          } else {
            // Instant burst at ground position (no lingering)
            const splashTargets: Array<{ target: any }> = [];
            for (const p of groundPlayersInMap) {
              if (p.isGuest) continue;
              const inParty = currentPlayer?.party?.includes(p.username) || false;
              if (isHeal) {
                if (p.id !== currentPlayer.id && !inParty) continue;
              } else {
                if (p.id === currentPlayer.id || inParty) continue;
              }
              const pPos = p.location?.position;
              if (!pPos) continue;
              const dist = Math.sqrt((pPos.x - groundX) ** 2 + (pPos.y - groundY) ** 2);
              if (dist <= groundAoERadius) splashTargets.push({ target: p });
            }

            if (!isHeal) splashCreatures(currentPlayer, spell, groundX, groundY, groundAoERadius, null);

            const attackerDamageBonus = currentPlayer.stats.stat_damage || 0;
            for (const splash of splashTargets) {
              const st = splash.target;
              // Heals: WoW-style roll (negative = healing); damage: level roll + damage stat.
              let splashDmg = spell_damage < 0
                ? -rollHeal(spell_damage, currentPlayer.stats, spell.cast_time).amount
                : Math.floor(Math.random() * ((playerLevel - 1) * 3 + 1)) + spell_damage + (playerLevel - 1) * 2 + attackerDamageBonus;
              if (spell_damage === 0) splashDmg = 0;

              if (splashDmg > 0) {
                const av = st.stats?.stat_avoidance || 0;
                if (Math.random() * 100 < av) splashDmg = 0;
                if (splashDmg > 0) {
                  const ar = st.stats?.stat_armor || 0;
                  splashDmg = Math.floor(splashDmg * (1 - Math.min(ar, 75) / 100));
                }
              }

              {
                let toHealth = splashDmg;
                if (splashDmg > 0) {
                  const ab = spellEffects.consumeBarrier(st, splashDmg);
                  toHealth = splashDmg - ab;
                  if (ab > 0) spellEffects.broadcastEffectsUpdate(st);
                }
                st.stats.health = Math.round(st.stats.health - toHealth);
                if (st.stats.health > st.stats.total_max_health) {
                  st.stats.health = st.stats.total_max_health;
                }
                listener.emit(Events.PLAYER_DAMAGED, { attacker: currentPlayer, target: st, damage: splashDmg, isCrit: false });

                if (st.stats.health <= 0) {
                  await handlePlayerDeath(st, currentPlayer, { damage: splashDmg, isCrit: false });
                } else {
                  if (!(spell_damage > 0 && splashDmg === 0)) {
                    await spellEffects.applySpellEffects(spell, currentPlayer, st,
                      (pp: any) => { const pls = filterPlayersByMap(pp.location.map); pls.forEach((pl: any) => sendPacket(pl.wt, packetManager.updateStats({ id: pp.id, target: pp.id, stats: pp.stats }))); },
                      (pp: any) => spellEffects.broadcastEffectsUpdate(pp)
                    );
                  }
                  if (spell_damage !== 0) {
                    broadcastStatsUpdateToAOI(
                      st,
                      currentPlayer,
                      packetManager.updateStats({ id: wt.data.id, target: st.id, stats: st.stats, isCrit: false, damage: splashDmg })
                    );
                  }
                }

                setPlayerPvp(currentPlayer, true);
                setPlayerPvp(st, true);
                st.last_attack = performance.now();

                if (splashDmg > 0 && st.isVanished) {
                  const vId = spellEffects.getVanishedEffectId(st);
                  if (vId) {
                    cancelEffect(st, vId);
                    spellEffects.broadcastEffectsUpdate(st);
                  }
                }
              }
            }

            if (currentPlayer.isVanished) {
              const cvId = spellEffects.getVanishedEffectId(currentPlayer);
              if (cvId) {
                cancelEffect(currentPlayer, cvId);
                spellEffects.broadcastEffectsUpdate(currentPlayer);
              }
            }

            // Visual projectile from caster to ground position
            groundPlayersInMap.forEach((p) => {
              sendPacketBestEffort(p.wt, packetManager.projectile({
                id: currentPlayer.id, time: 0.3, target_id: currentPlayer.id,
                spell: spell.name, icon: getIconUrl(spell.icon), entity: false
              }));
            });
          }

          // Sync caster stats
          const syncedStats = await player.synchronizeStats(currentPlayer.username);
          if (syncedStats) currentPlayer.stats = syncedStats;
          playerCache.set(currentPlayer.id, currentPlayer);
          broadcastToAOIBestEffort(currentPlayer, packetManager.updateStats({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats }));

          currentPlayer.last_attack = performance.now();
          listener.emit(Events.SPELL_CAST, { player: currentPlayer, spellName: spell.name, target: currentPlayer, isEntityTarget: false });
          break;
        }

        const isInParty = currentPlayer?.party?.includes(target?.username) || null;

        if (isInParty && (spell_damage > 0 || spellIsHostileEffect)) {
          if (isSelf) return;
          sendPacket(
            wt,
            packetManager.notify({
              message: "You cannot attack your party members",
            })
          );
          return;
        }

        if ((spell_damage < 0 || (spell_damage === 0 && hasEffects && !spellIsHostileEffect)) && target.id !== currentPlayer.id && !isInParty) {
          target = currentPlayer;
          isSelf = true;
        }

        const playersInMap = filterPlayersByMap(currentPlayer.location.map);

        const playersInAttackRange = filterPlayersByDistance(
          wt,
          spell_range,
          currentPlayer.location.map
        );

        log.debug(`[ATTACK] Identified target as player. username=${target.username}`);

        // Casting at someone behind you turns you to face them (WoW) rather
        // than failing the facing check below.
        if (target.id !== currentPlayer.id && target.location?.position) {
          faceToward(currentPlayer, Number(target.location.position.x), Number(target.location.position.y));
        }

        const canAttack: any = await player.canAttack(currentPlayer, target,
          {
            width: 24,
            height: 40,
          },
          spell_range
        );
        log.debug(`[ATTACK] canAttack result: ${JSON.stringify(canAttack)}`);

        const targetX = target.location?.position?.x || 0;
        const targetY = target.location?.position?.y || 0;

        const distance = Math.sqrt(
          Math.pow(currentPlayer.location.position.x - targetX, 2) +
          Math.pow(currentPlayer.location.position.y - targetY, 2)
        );

        isSelf = (target.id === currentPlayer.id) || (currentPlayer.username === target.username);
        
        // Prevent self-targeting for damaging/hostile spells, but allow self-targeting for healing/buff spells and AoE
        if (isSelf && (spell_damage > 0 || spellIsHostileEffect) && !isAoeSpell) return;

        if (!canAttack?.value) {
          if (canAttack?.reason == "nopvp") {
            sendPacket(
              wt,
              packetManager.notify({ message: "You are not in a PvP area" })
            );
          }
          if (canAttack?.reason == "path_blocked") {
            sendPacket(
              wt,
              packetManager.notify({ message: "Target is not in line of sight" })
            );
          }
          if (canAttack?.reason == "range") {
            sendPacket(
              wt,
              packetManager.notify({ message: "Target is out of range" })
            );
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: canAttack?.reason || "unknown" } as any);
          return;
        } else if (!playersInAttackRange.includes(target)) {
          return;
        }

        const isChargeSpell = spell?.charge_distance && spell.charge_distance > 0;
        const isTeleportBehind = spell?.teleport_behind === 1;
        if (isChargeSpell && !isSelf) {
          const cPos = currentPlayer.location.position;
          const cx = typeof cPos === 'string' ? Number(cPos.split(',')[0]) : cPos.x;
          const cy = typeof cPos === 'string' ? Number(cPos.split(',')[1]) : cPos.y;
          const tPos = target.location.position;
          const tx = typeof tPos === 'string' ? Number(tPos.split(',')[0]) : tPos.x;
          const ty = typeof tPos === 'string' ? Number(tPos.split(',')[1]) : tPos.y;
          const dist = Math.sqrt((tx - cx) ** 2 + (ty - cy) ** 2);
          const chargeDist = Math.min(spell.charge_distance ?? 0, Math.max(0, dist - 40));
          const ratio = dist > 0 ? chargeDist / dist : 0;
          const landX = Math.round(cx + (tx - cx) * ratio);
          const landY = Math.round(cy + (ty - cy) * ratio);

          const losCharge = await hasLineOfSight(cx, cy, landX, landY, currentPlayer.location.map, (spell.charge_distance ?? 0) + 50);
          if (!losCharge) {
            sendPacket(wt, packetManager.notify({ message: "Cannot charge - path blocked." }));
            if (currentPlayer.spellCooldowns) {
              delete currentPlayer.spellCooldowns[spell_id];
            }
            return;
          }

          const newDir = directionToward(landX, landY, tx, ty);

          currentPlayer.location.position.x = landX;
          currentPlayer.location.position.y = landY;
          currentPlayer.location.position.direction = newDir;
          currentPlayer.moving = false;
          playerCache.set(currentPlayer.id, currentPlayer);

          globalStateRevision++;
          if (shouldUpdateAOI(currentPlayer)) {
            await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
          }
          const chargeMoveData = {
            i: wt.data.id,
            d: { x: landX, y: landY, dr: newDir },
            r: globalStateRevision,
            s: currentPlayer.isStealth ? 1 : 0,
          };
          broadcastToAOI(currentPlayer, packetManager.moveXY(chargeMoveData), true);

          await sendPositionAnimation(wt, newDir, false, false, "", undefined, globalStateRevision, false);

          broadcastCastToMap(
            playersInMap,
            currentPlayer.id,
            packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: 0 })
          );

          currentPlayer.last_attack = performance.now();
          if (currentPlayer.isVanished) {
            const vId = spellEffects.getVanishedEffectId(currentPlayer);
            if (vId) {
              cancelEffect(currentPlayer, vId);
              spellEffects.broadcastEffectsUpdate(currentPlayer);
            }
          }
          listener.emit(Events.SPELL_CAST, { player: currentPlayer, spellName: spell.name, target, isEntityTarget: false });

          if (Array.isArray(spell.effects) && spell.effects.length > 0) {
            await spellEffects.applySpellEffects(spell, currentPlayer, target,
              (pp: any) => { const pls = filterPlayersByMap(pp.location.map); pls.forEach((pl: any) => sendPacket(pl.wt, packetManager.updateStats({ id: pp.id, target: pp.id, stats: pp.stats }))); },
              (pp: any) => spellEffects.broadcastEffectsUpdate(pp)
            );
          }

          setPlayerPvp(currentPlayer, true);
          setPlayerPvp(target, true);
          target.last_attack = performance.now();
          break;
        }

        if (isTeleportBehind && !isSelf) {
          const tPos = target.location.position;
          const tx = typeof tPos === 'string' ? Number(tPos.split(',')[0]) : tPos.x;
          const ty = typeof tPos === 'string' ? Number(tPos.split(',')[1]) : tPos.y;
          const tDir = typeof tPos === 'string' ? 'down' : (tPos.direction || 'down');

          const dirOffsets: Record<string, { dx: number; dy: number; face: string }> = {
            right:     { dx: -40, dy: 0,   face: 'right' },
            downright: { dx: -28, dy: -28, face: 'downright' },
            down:      { dx: 0,   dy: -40, face: 'down' },
            downleft:  { dx: 28,  dy: -28, face: 'downleft' },
            left:      { dx: 40,  dy: 0,   face: 'left' },
            upleft:    { dx: 28,  dy: 28,  face: 'upleft' },
            up:        { dx: 0,   dy: 40,  face: 'up' },
            upright:   { dx: -28, dy: 28,  face: 'upright' },
          };
          const offset = dirOffsets[tDir] || dirOffsets['down'];
          const landX = Math.round(tx + offset.dx);
          const landY = Math.round(ty + offset.dy);

          const losBehind = await hasLineOfSight(tx, ty, landX, landY, currentPlayer.location.map, 60);
          if (!losBehind) {
            sendPacket(wt, packetManager.notify({ message: "Cannot teleport behind target - path blocked." }));
            if (currentPlayer.spellCooldowns) {
              delete currentPlayer.spellCooldowns[spell_id];
            }
            return;
          }

          currentPlayer.location.position.x = landX;
          currentPlayer.location.position.y = landY;
          currentPlayer.location.position.direction = offset.face;
          currentPlayer.moving = false;
          playerCache.set(currentPlayer.id, currentPlayer);

          globalStateRevision++;
          if (shouldUpdateAOI(currentPlayer)) {
            await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
          }
          const tpMoveData = {
            i: wt.data.id,
            d: { x: landX, y: landY, dr: offset.face },
            r: globalStateRevision,
            s: currentPlayer.isStealth ? 1 : 0,
          };
          broadcastToAOI(currentPlayer, packetManager.moveXY(tpMoveData), true);

          await sendPositionAnimation(wt, offset.face, false, false, "", undefined, globalStateRevision, false);

          broadcastCastToMap(
            playersInMap,
            currentPlayer.id,
            packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: 0 })
          );

          currentPlayer.last_attack = performance.now();
          if (currentPlayer.isVanished) {
            const vId = spellEffects.getVanishedEffectId(currentPlayer);
            if (vId) {
              cancelEffect(currentPlayer, vId);
              spellEffects.broadcastEffectsUpdate(currentPlayer);
            }
          }
          listener.emit(Events.SPELL_CAST, { player: currentPlayer, spellName: spell.name, target, isEntityTarget: false });

          if (Array.isArray(spell.effects) && spell.effects.length > 0) {
            await spellEffects.applySpellEffects(spell, currentPlayer, target,
              (pp: any) => { const pls = filterPlayersByMap(pp.location.map); pls.forEach((pl: any) => sendPacket(pl.wt, packetManager.updateStats({ id: pp.id, target: pp.id, stats: pp.stats }))); },
              (pp: any) => spellEffects.broadcastEffectsUpdate(pp)
            );
          }

          setPlayerPvp(currentPlayer, true);
          setPlayerPvp(target, true);
          target.last_attack = performance.now();
          break;
        }

        let delay = 0;
        if (target.id !== currentPlayer.id && spell_damage >= 0) {
          const maxTravelTime = 500;
          const speedMultiplier = 1000;

          const calculatedDelay = (distance / speedMultiplier) * 1000;

          delay = Math.min(calculatedDelay, maxTravelTime);
        }

        currentPlayer.casting = true;
        currentPlayer.castId = (currentPlayer.castId || 0) + 1;
        playerCache.set(currentPlayer.id, currentPlayer);
        const thisCastId = currentPlayer.castId;
        const spellStartTime = performance.now();

        // Dismount player if they're mounted
        if (currentPlayer.mounted) {
          currentPlayer.mounted = false;
          playerCache.set(currentPlayer.id, currentPlayer);
        }

        globalStateRevision++;
        await sendPositionAnimation(
          wt,
          currentPlayer.location.position?.direction || "down",
          currentPlayer.moving || false,
          false,
          currentPlayer.mount_type || "unicorn",
          undefined,
          globalStateRevision,
          true
        );

        broadcastCastToMap(
          playersInMap,
          currentPlayer.id,
          packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: spell.cast_time })
        );
        await new Promise((resolve) => setTimeout(resolve, spell.cast_time * 1000));

        // Abort if this cast was superseded by a new cast (e.g. interrupted then recast)
        const castCheckPlayer = playerCache.get(currentPlayer.id);
        if (castCheckPlayer && castCheckPlayer.castId !== thisCastId) {
          return;
        }

        // Check if spell was manually cancelled via ESC during cast time
        const updatedPlayer = playerCache.get(currentPlayer.id);
        if (updatedPlayer && updatedPlayer.manualSpellCancel && updatedPlayer.manualSpellCancel >= spellStartTime) {
          // Spell was cancelled during cast time, abort execution
          // Clear the manual cancel flag so next cast is allowed
          if (updatedPlayer.spellCooldowns) {
            delete updatedPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(updatedPlayer.username, spell_id);
          }
          delete updatedPlayer.manualSpellCancel;
          updatedPlayer.casting = false;
          playerCache.set(updatedPlayer.id, updatedPlayer);
          // Sync back to currentPlayer so wt.data stays current
          currentPlayer.spellCooldowns = updatedPlayer.spellCooldowns;
          currentPlayer.manualSpellCancel = undefined;
          currentPlayer.casting = false;
          return;
        }

        if (!spell.can_move && !playerCache.get(currentPlayer.id)?.casting) {

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          return;
        }
        currentPlayer.casting = false;
        // After cast, mounted should always be false (player was dismounted at start of cast)
        currentPlayer.mounted = false;
        playerCache.set(currentPlayer.id, currentPlayer);

        // The target may have moved behind the caster during the cast: face
        // them again so the completion check below does not fail on facing.
        const targetNow = playerCache.get(target.id) ?? target;
        if (!isSelf && targetNow.location?.position) {
          faceToward(currentPlayer, Number(targetNow.location.position.x), Number(targetNow.location.position.y));
        }

        globalStateRevision++;
        await sendPositionAnimation(
          wt,
          currentPlayer.location.position?.direction || "down",
          currentPlayer.moving || false,
          false,
          currentPlayer.mount_type || "unicorn",
          undefined,
          globalStateRevision,
          false
        );

        let canAttack2: any = { value: true };

        if (spell.cast_time > 0) {
          canAttack2 = await player.canAttack(currentPlayer, target,
            {
              width: 24,
              height: 40,
            },
            spell_range
          );
        }

        if (canAttack2?.reason == "nopvp") {
          broadcastCastToMap(
            playersInMap,
            currentPlayer.id,
            packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
          );

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "nopvp" } as any);
          return;
        }

        if (canAttack2?.reason == "path_blocked") {
          broadcastCastToMap(
            playersInMap,
            currentPlayer.id,
            packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
          );

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "path_blocked" } as any);
          return;
        }

        if (canAttack2?.reason == "range") {
          broadcastCastToMap(
            playersInMap,
            currentPlayer.id,
            packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
          );

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "range" } as any);
          return;
        }

        if (canAttack2?.reason == "direction") {
          broadcastCastToMap(
            playersInMap,
            currentPlayer.id,
            packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
          );

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "direction" } as any);
          return;
        }

        // If canAttack validation failed for any other reason, abort
        if (!canAttack2?.value) {
          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(resetPlayer.username, spell_id);
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target, spellName: spell.name, reason: "unknown" } as any);
          return;
        }

        if (target.id !== currentPlayer.id) {
          const liveParticleCache = await assetCache.get("particles") as Particle[] | null;
          const resolvedParticles = resolveSpellParticles(spell, liveParticleCache);
          playersInMap.forEach((player) => {
            sendPacketBestEffort(
              player.wt,
              packetManager.projectile({
                id: currentPlayer.id,
                time: delay / 1000,
                target_id: target.id,
                spell: spell.name,
                icon: getIconUrl(spell.icon),
                entity: false,
                particles: resolvedParticles,
              })
            );
          });
        }
        await new Promise((resolve) => setTimeout(resolve, delay));

        const attackerDamageBonus = currentPlayer.stats.stat_damage || 0;
        let finalDamage: number;
        let isCrit: boolean;
        if (spell_damage < 0) {
          // WoW-style heal: level roll + cast-time share of the damage stat,
          // 150% on a crit. Negative = healing.
          const heal = rollHeal(spell_damage, currentPlayer.stats, spell.cast_time);
          finalDamage = -heal.amount;
          isCrit = heal.isCrit;
        } else {
          const baseDamage = Math.floor(Math.random() * ((playerLevel - 1) * 3 + 1)) + spell_damage + (playerLevel - 1) * 2 + attackerDamageBonus;
          const critDamage = currentPlayer.stats.stat_critical_damage || 0;
          isCrit = Math.random() * 100 < (currentPlayer.stats.stat_critical_chance || 0);
          finalDamage = isCrit ? Math.floor(baseDamage * (1 + critDamage / 100)) : baseDamage;
        }

        // Utility/effect-only spells (base damage 0) never deal damage and skip avoidance/armor
        if (spell_damage === 0) finalDamage = 0;

        log.debug(`[ATTACK] Damage calculation: spell=${spell_damage}, bonus=${attackerDamageBonus}, crit=${isCrit}, final=${finalDamage}`);

        if (finalDamage > 0) {
          const targetAvoidance = target.stats?.stat_avoidance || 0;
          const avoidanceRoll = Math.random() * 100;
          if (avoidanceRoll < targetAvoidance) {
            finalDamage = 0;
          }

          if (finalDamage > 0) {
            const targetArmor = target.stats?.stat_armor || 0;
            const armorReduction = Math.min(targetArmor, 75) / 100;
            finalDamage = Math.floor(finalDamage * (1 - armorReduction));
          }
        }

        const finalManaCheck = playerCache.get(currentPlayer.id);
        if (!finalManaCheck || (finalManaCheck.stats.stamina || 0) < actualManaCost) {

          if (finalManaCheck && finalManaCheck.spellCooldowns) {
            delete finalManaCheck.spellCooldowns[spell_id];
            cooldownManager.deleteCooldown(finalManaCheck.username, spell_id);
            playerCache.set(finalManaCheck.id, finalManaCheck);
          }
          return;
        }

        currentPlayer.stats.stamina = finalManaCheck.stats.stamina;
        currentPlayer.stats.stamina -= actualManaCost;

        if (currentPlayer.stats.stamina < 0) {
          currentPlayer.stats.stamina = 0;
        }

        {
          // Apply damage to player target
          // Add if negative damage (healing) to current health, subtract positive damage
          // Positive damage is first absorbed by absorbtion, remainder hits health
          // Corpses awaiting release can neither be damaged further nor healed;
          // only the release + revive flow changes their state.
          if (target.isDead) {
            return;
          }
          let damageToHealth = finalDamage;
          if (finalDamage > 0) {
            const absorbed = spellEffects.consumeBarrier(target, finalDamage);
            damageToHealth = finalDamage - absorbed;
            if (absorbed > 0) {
              spellEffects.broadcastEffectsUpdate(target);
            }
          }
          target.stats.health = Math.round(target.stats.health - damageToHealth);
          if (finalDamage < 0) {
            listener.emit(Events.PLAYER_HEALED, { caster: currentPlayer, target, amount: Math.abs(finalDamage), source: spell.name } as any);
          }
          listener.emit(Events.PLAYER_DAMAGED, { attacker: currentPlayer, target, damage: finalDamage, isCrit });

          playerCache.set(currentPlayer.id, currentPlayer);

          if (target.stats.health > target.stats.total_max_health) {
            target.stats.health = target.stats.total_max_health;
          }

          if (target.stats.health <= 0) {

          await handlePlayerDeath(target, currentPlayer, { damage: finalDamage, isCrit });
        } else {

          const broadcastStats = (p: any) => {
            const pls = filterPlayersByMap(p.location.map).filter((pl: any) => {
              if (pl.id === p.id) return true;
              if (p.isVanished && !pl.isAdmin && !pl.party?.includes(p.username)) return false;
              return true;
            });
            pls.forEach((pl: any) =>
              sendPacket(pl.wt, packetManager.updateStats({ id: p.id, target: p.id, stats: p.stats }))
            );
            sendStatsToPartyMembers(p.username, p.id, p.stats);
          };
          const broadcastEffects = (p: any) => {
            spellEffects.broadcastEffectsUpdate(p);
          };
          // If the attack was dodged (spell deals damage but 0 got through), skip effects
          let effectResult: any = {};
          if (!(spell_damage > 0 && finalDamage === 0)) {
            effectResult = await spellEffects.applySpellEffects(spell, currentPlayer, target, broadcastStats, broadcastEffects);
          }

          // Vanish despawn - must happen in receiver, same pattern as admin stealth
          if (Array.isArray(spell.effects) && spell.effects.some((e: SpellEffect) => e.type === "vanish") && target.isVanished) {
            playersInMap.forEach((player) => {
              if (player.id === target.id) return;
              if (player.isAdmin) return;
              if (player.party?.includes(target.username)) return;
              sendPacket(player.wt, packetManager.despawnPlayer(target.id));
            });
          }

          // Utility spells (damage=0) don't show damage numbers
          if (spell_damage !== 0) {
          broadcastStatsUpdateToAOI(
            target,
            currentPlayer,
            packetManager.updateStats({
              id: wt.data.id,
              target: target.id,
              stats: target.stats,
              isCrit: isCrit,
              damage: finalDamage,
              absorb: effectResult.absorb || 0,
            })
          );
          }

          // Always send caster's stats (mana change)
          broadcastToAOIBestEffort(
            currentPlayer,
            packetManager.updateStats({
              id: currentPlayer.id,
              target: currentPlayer.id,
              stats: currentPlayer.stats,
            })
          );

          sendStatsToPartyMembers(target.username, target.id, target.stats);
          sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
        }
        }

        // Update attacker stats regardless of target type
        playerCache.set(currentPlayer.id, currentPlayer);

        // Is not in the targets party and is not self, then set PvP flag on both
        if (!isInParty && !isSelf) {
          setPlayerPvp(currentPlayer, true);
          setPlayerPvp(target, true);
        }

        currentPlayer.last_attack = performance.now();
        target.last_attack = performance.now();

        // Attacking breaks vanish (but not DoT ticks - this is a direct cast)
        if (currentPlayer.isVanished && !isSelf && !isInParty) {
          const vanishId = spellEffects.getVanishedEffectId(currentPlayer);
          if (vanishId) {
            cancelEffect(currentPlayer, vanishId);
            spellEffects.broadcastEffectsUpdate(currentPlayer);
          }
        }
        listener.emit(Events.SPELL_CAST, { player: currentPlayer, spellName: spell.name, target, isEntityTarget: false });

        // AoE splash: apply damage and effects to all valid targets within aoe_radius
        // of the primary target (excluding the primary target itself).
        const aoeRadius = spell?.aoe_radius;
        if (aoeRadius && aoeRadius > 0) {
          const splashTargets: Array<{ target: any; distance: number }> = [];

          // Collect nearby players
          const allMapPlayers = filterPlayersByMap(currentPlayer.location.map);
          for (const p of allMapPlayers) {
            if (p.id === target.id) continue;
            if (p.isGuest) continue;
            // Ghosts cannot be damaged or healed.
            if (p.isGhost) continue;
            if (isInParty && currentPlayer?.party?.includes(p?.username)) continue;
            const pPos = p.location?.position;
            if (!pPos) continue;
            const dist = Math.sqrt((pPos.x - targetX) ** 2 + (pPos.y - targetY) ** 2);
            if (dist <= aoeRadius) {
              splashTargets.push({ target: p, distance: dist });
            }
          }

          // Creatures near the target take the splash too.
          splashCreatures(currentPlayer, spell, targetX, targetY, aoeRadius, null);

          for (const splash of splashTargets) {
            const splashTarget = splash.target;

            // AoE damage: independent roll per target (same formula as primary)
            // Heals: WoW-style roll (negative = healing); damage: level roll + damage stat.
            let splashDmg = spell_damage < 0
              ? -rollHeal(spell_damage, currentPlayer.stats, spell.cast_time).amount
              : Math.floor(Math.random() * ((playerLevel - 1) * 3 + 1)) + spell_damage + (playerLevel - 1) * 2 + attackerDamageBonus;
            if (spell_damage === 0) splashDmg = 0;

            if (splashDmg > 0) {
              const splashAvoid = splashTarget.stats?.stat_avoidance || 0;
              if (Math.random() * 100 < splashAvoid) splashDmg = 0;
              if (splashDmg > 0) {
                const splashArmor = splashTarget.stats?.stat_armor || 0;
                splashDmg = Math.floor(splashDmg * (1 - Math.min(splashArmor, 75) / 100));
              }
            }

            {
              let splashToHealth = splashDmg;
              if (splashDmg > 0) {
                const absorbed = spellEffects.consumeBarrier(splashTarget, splashDmg);
                splashToHealth = splashDmg - absorbed;
                if (absorbed > 0) spellEffects.broadcastEffectsUpdate(splashTarget);
              }
              splashTarget.stats.health = Math.round(splashTarget.stats.health - splashToHealth);
              listener.emit(Events.PLAYER_DAMAGED, { attacker: currentPlayer, target: splashTarget, damage: splashDmg, isCrit: false });

              if (splashTarget.stats.health <= 0) {
                await handlePlayerDeath(splashTarget, currentPlayer, { damage: splashDmg, isCrit: false });
              } else {
                await spellEffects.applySpellEffects(spell, currentPlayer, splashTarget,
                  (p: any) => {
                    const pls = filterPlayersByMap(p.location.map);
                    pls.forEach((pl: any) => sendPacket(pl.wt, packetManager.updateStats({ id: p.id, target: p.id, stats: p.stats })));
                  },
                  (p: any) => spellEffects.broadcastEffectsUpdate(p)
                );

                broadcastStatsUpdateToAOI(
                  splashTarget,
                  currentPlayer,
                  packetManager.updateStats({
                    id: wt.data.id,
                    target: splashTarget.id,
                    stats: splashTarget.stats,
                    isCrit: false,
                    damage: splashDmg,
                  })
                );
              }

              if (!isInParty) {
                setPlayerPvp(currentPlayer, true);
                setPlayerPvp(splashTarget, true);
                splashTarget.last_attack = performance.now();
              }
            }
          }
        }

        break;
      }
      case "CANCEL_SPELL": {
        if (!currentPlayer) return;

        // Only process if actually casting
        if (!currentPlayer.casting) return;

        // Treat ESC cancel as spell interruption
        const playersInMap = filterPlayersByMap(currentPlayer.location.map);
        broadcastCastToMap(
          playersInMap,
          currentPlayer.id,
          packetManager.castSpell({ id: currentPlayer.id, spell: 'interrupted', time: 1 })
        );
        playersInMap.forEach((player) => {
          sendPacket(
            player.wt,
            packetManager.groundAoeDespawn({ id: currentPlayer.id + "_casting" })
          );
        });

        globalStateRevision++;
        await sendPositionAnimation(
          wt,
          currentPlayer.location.position?.direction || "down",
          currentPlayer.moving || false,
          currentPlayer.mounted,
          currentPlayer.mount_type || "unicorn",
          undefined,
          globalStateRevision,
          false
        );

        // Mark this as a manual cancel (not a movement interrupt)
        // Don't set lastInterruptTime to allow immediate recast
        currentPlayer.casting = false;
        currentPlayer.castId = (currentPlayer.castId || 0) + 1;
        currentPlayer.manualSpellCancel = performance.now();

        if (currentPlayer.castingSpellId && currentPlayer.spellCooldowns) {
          delete currentPlayer.spellCooldowns[currentPlayer.castingSpellId];
          cooldownManager.deleteCooldown(currentPlayer.username, currentPlayer.castingSpellId);
          currentPlayer.castingSpellId = undefined;
        }

        // Also update in playerCache so spell execution can detect it
        const cachedPlayer = playerCache.get(currentPlayer.id);
        if (cachedPlayer) {
          cachedPlayer.casting = false;
          cachedPlayer.castId = currentPlayer.castId;
          cachedPlayer.manualSpellCancel = performance.now();
          if (cachedPlayer.castingSpellId && cachedPlayer.spellCooldowns) {
            delete cachedPlayer.spellCooldowns[cachedPlayer.castingSpellId];
            cachedPlayer.castingSpellId = undefined;
          }
          playerCache.set(cachedPlayer.id, cachedPlayer);
        }

        log.debug(`[SPELL] Player ${currentPlayer.username} cancelled spell via ESC`);
        listener.emit(Events.SPELL_INTERRUPTED, { player: currentPlayer });
        break;
      }
      case "CANCEL_EFFECT": {
        if (!currentPlayer) return;
        const effectId = (data as any)?.id;
        if (!effectId) return;
        const removed = spellEffects.cancelEffect(currentPlayer, effectId);
        if (removed) {
          spellEffects.broadcastEffectsUpdate(currentPlayer);
          broadcastToAOIBestEffort(
            currentPlayer,
            packetManager.updateStats({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats })
          );
        }
        break;
      }
      case "NPC_INTERACT": {
        if (!currentPlayer) return;
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        if (isQuestRateLimited(`npc:${wt.data.id}`)) return;
        const npcId = Number((data as any)?.npcId ?? (data as any)?.id);
        if (!Number.isFinite(npcId)) return;
        const npcsData = ((await assetCache.get("npcs")) || []) as Npc[];
        const npc = npcsData.find((n) => Number(n.id) === npcId);
        if (!npc || npc.hidden) return;
        const playerMap = String(currentPlayer.location.map ?? "").replaceAll(".json", "");
        if (String(npc.map ?? "").replaceAll(".json", "") !== playerMap) return;
        const pos = currentPlayer.location.position;
        if (!pos) return;
        const dist = Math.hypot(Number(pos.x) - Number(npc.position.x), Number(pos.y) - Number(npc.position.y));
        if (dist > NPC_INTERACT_RADIUS) {
          sendPacket(wt, packetManager.questError({ code: "too_far", message: "You are too far from that NPC." }));
          break;
        }
        // Talk objectives credit on interaction, before the offer list is built.
        try {
          const talkUpdates = await creditObjective(currentPlayer.username, "talk", String(npcId), 1);
          if (talkUpdates.length > 0) {
            const byQuest = new Map<number, ObjectiveUpdate[]>();
            for (const u of talkUpdates) {
              const list = byQuest.get(u.questId) || [];
              list.push(u);
              byQuest.set(u.questId, list);
            }
            for (const [questId, questUpdates] of byQuest) {
              sendPacket(wt, packetManager.questProgress({ questId, updates: questUpdates }));
            }
            await sendQuestMarkersFor(wt, currentPlayer.username, playerMap);
          }
        } catch {
          // Talk credit is best-effort.
        }
        const offers = await questLogApi.offersFor(currentPlayer.username, npcId);
        // Locked quests (level-gated, prerequisite-locked) are hidden from
        // the player, so they must not count toward the skip-the-menu
        // decision: one visible quest opens its frame directly.
        const visibleOffers = offers.filter(
          (o) => !(o.marker === "available_future" && (o.reason === "level_too_low" || o.reason === "missing_prerequisite"))
        );
        if (visibleOffers.length === 0) {
          sendPacket(
            wt,
            packetManager.npcGossip({ npcId, name: npc.name || null, gossipText: npc.dialog || null, quests: [] })
          );
          break;
        }
        if (visibleOffers.length === 1) {
          const offer = visibleOffers[0]!;
          const quest = questDefinitions.find(offer.questId);
          if (!quest) break;
          if (offer.action === "offer") {
            const eligibility = await questLogApi.eligibility(currentPlayer.username, quest.id);
            sendPacket(
              wt,
              packetManager.questOffer({ npcId, quest, canAccept: eligibility === "available", reason: eligibility })
            );
          } else if (offer.action === "incomplete") {
            const cached = questLogApi.getCachedLog(currentPlayer.username);
            const entry = cached?.active.find((e) => e.quest_id === quest.id);
            const progress: ObjectiveUpdate[] = (quest.objectives || []).map((o) => ({
              questId: quest.id,
              objectiveId: o.id,
              type: o.type,
              target: o.target,
              count: Math.min(Number(entry?.progress[o.id]) || 0, o.required_count),
              required: o.required_count,
              questReady: false,
            }));
            sendPacket(wt, packetManager.questIncomplete({ npcId, quest, progress }));
          } else {
            sendPacket(wt, packetManager.questTurnInOffer({ npcId, quest }));
          }
          break;
        }
        sendPacket(
          wt,
          packetManager.npcGossip({ npcId, name: npc.name || null, gossipText: npc.dialog || null, quests: offers })
        );
        break;
      }
      case "QUEST_SELECT": {
        if (!currentPlayer) return;
        if (isQuestRateLimited(`qs:${wt.data.id}`)) return;
        const npcId = Number((data as any)?.npcId);
        const questId = Number((data as any)?.questId);
        if (!Number.isFinite(npcId) || !Number.isFinite(questId)) return;
        const npcsData = ((await assetCache.get("npcs")) || []) as Npc[];
        const npc = npcsData.find((n) => Number(n.id) === npcId);
        if (!npc || npc.hidden) return;
        const playerMap = String(currentPlayer.location.map ?? "").replaceAll(".json", "");
        if (String(npc.map ?? "").replaceAll(".json", "") !== playerMap) return;
        const pos = currentPlayer.location.position;
        if (!pos) return;
        if (Math.hypot(Number(pos.x) - Number(npc.position.x), Number(pos.y) - Number(npc.position.y)) > NPC_INTERACT_RADIUS) {
          sendPacket(wt, packetManager.questError({ code: "too_far", message: "You are too far from that NPC." }));
          break;
        }
        const offers = await questLogApi.offersFor(currentPlayer.username, npcId);
        const offer = offers.find((o) => o.questId === questId);
        if (!offer) return;
        const quest = questDefinitions.find(questId);
        if (!quest) return;
        if (offer.action === "offer") {
          const eligibility = await questLogApi.eligibility(currentPlayer.username, quest.id);
          sendPacket(
            wt,
            packetManager.questOffer({ npcId, quest, canAccept: eligibility === "available", reason: eligibility })
          );
        } else if (offer.action === "incomplete") {
          const cached = questLogApi.getCachedLog(currentPlayer.username);
          const entry = cached?.active.find((e) => e.quest_id === quest.id);
          const progress: ObjectiveUpdate[] = (quest.objectives || []).map((o) => ({
            questId: quest.id,
            objectiveId: o.id,
            type: o.type,
            target: o.target,
            count: Math.min(Number(entry?.progress[o.id]) || 0, o.required_count),
            required: o.required_count,
            questReady: false,
          }));
          sendPacket(wt, packetManager.questIncomplete({ npcId, quest, progress }));
        } else {
          sendPacket(wt, packetManager.questTurnInOffer({ npcId, quest }));
        }
        break;
      }
      case "QUEST_ACCEPT": {
        if (!currentPlayer) return;
        if (isQuestRateLimited(`qa:${wt.data.id}`)) return;
        const npcId = Number((data as any)?.npcId);
        const questId = Number((data as any)?.questId);
        if (!Number.isFinite(npcId) || !Number.isFinite(questId)) return;
        // Never trust a client-supplied quest id without checking range.
        const npcsData = ((await assetCache.get("npcs")) || []) as Npc[];
        const npc = npcsData.find((n) => Number(n.id) === npcId);
        if (!npc) return;
        const playerMap = String(currentPlayer.location.map ?? "").replaceAll(".json", "");
        if (String(npc.map ?? "").replaceAll(".json", "") !== playerMap) return;
        const pos = currentPlayer.location.position;
        if (!pos) return;
        if (Math.hypot(Number(pos.x) - Number(npc.position.x), Number(pos.y) - Number(npc.position.y)) > NPC_INTERACT_RADIUS) {
          sendPacket(wt, packetManager.questError({ code: "too_far", message: "You are too far from that NPC." }));
          break;
        }
        const result = await questLogApi.accept(currentPlayer.username, questId, npcId);
        if (!result.ok || !result.entry || !result.quest) {
          sendPacket(wt, packetManager.questError({ code: result.code || "ineligible", message: result.error || "You cannot accept that quest." }));
          break;
        }
        sendPacket(wt, packetManager.questLogEntry({ entry: result.entry, quest: result.quest }));
        // The accept backfill may have credited collect/explore immediately.
        const backfilled: ObjectiveUpdate[] = (result.quest.objectives || [])
          .filter((o) => (Number(result.entry!.progress[o.id]) || 0) > 0)
          .map((o) => ({
            questId: result.quest!.id,
            objectiveId: o.id,
            type: o.type,
            target: o.target,
            count: Number(result.entry!.progress[o.id]) || 0,
            required: o.required_count,
            questReady: result.entry!.state === "ready",
          }));
        if (backfilled.length > 0) {
          sendPacket(wt, packetManager.questProgress({ questId: result.quest.id, updates: backfilled }));
        }
        await sendQuestMarkersFor(wt, currentPlayer.username, currentPlayer.location.map);
        break;
      }
      case "QUEST_DECLINE": {
        // Closes the frame client-side. No state change; exists so packet
        // interceptors and plugins can observe it.
        break;
      }
      case "QUEST_ABANDON": {
        if (!currentPlayer) return;
        if (isQuestRateLimited(`qab:${wt.data.id}`)) return;
        const questId = Number((data as any)?.questId);
        if (!Number.isFinite(questId)) return;
        const cached = questLogApi.getCachedLog(currentPlayer.username);
        const entry = cached?.active.find((e) => e.quest_id === questId);
        if (!entry) {
          sendPacket(wt, packetManager.questError({ code: "not_active", message: "That quest is not in your log." }));
          break;
        }
        const quest = questDefinitions.find(questId);
        await questLogApi.abandon(currentPlayer.username, questId);
        if (quest) {
          sendPacket(wt, packetManager.questLogEntry({ entry: null, quest, removed: true }));
        }
        await sendQuestMarkersFor(wt, currentPlayer.username, currentPlayer.location.map);
        break;
      }
      case "QUEST_TURN_IN": {
        if (!currentPlayer) return;
        if (isQuestRateLimited(`qt:${wt.data.id}`)) return;
        const npcId = Number((data as any)?.npcId);
        const questId = Number((data as any)?.questId);
        const rewardChoiceIndex = (data as any)?.rewardChoiceIndex;
        if (!Number.isFinite(npcId) || !Number.isFinite(questId)) return;
        // Range check before anything else; never trust client-supplied ids.
        const npcsData = ((await assetCache.get("npcs")) || []) as Npc[];
        const npc = npcsData.find((n) => Number(n.id) === npcId);
        if (!npc) return;
        const playerMap = String(currentPlayer.location.map ?? "").replaceAll(".json", "");
        if (String(npc.map ?? "").replaceAll(".json", "") !== playerMap) return;
        const pos = currentPlayer.location.position;
        if (!pos) return;
        if (Math.hypot(Number(pos.x) - Number(npc.position.x), Number(pos.y) - Number(npc.position.y)) > NPC_INTERACT_RADIUS) {
          sendPacket(wt, packetManager.questError({ code: "too_far", message: "You are too far from that NPC." }));
          break;
        }
        const result = await questLogApi.turnIn(currentPlayer.username, questId, npcId, rewardChoiceIndex);
        if (!result.ok) {
          sendPacket(
            wt,
            packetManager.questError({ code: result.code || "turnin_failed", message: result.error || "Could not turn in that quest." })
          );
          break;
        }
        const quest = questDefinitions.find(questId);
        if (quest) {
          sendPacket(wt, packetManager.questLogEntry({ entry: null, quest, removed: true }));
        }
        sendPacket(
          wt,
          packetManager.questCompleted({
            questId: result.questId!,
            xp: result.xp || 0,
            copper: result.copper || 0,
            items: result.items || [],
            nextQuestId: result.nextQuestId ?? null,
          })
        );
        // Sync the client with the granted rewards.
        try {
          currentPlayer.inventory = await patchInventoryBagSlots(await inventory.get(currentPlayer.username), currentPlayer.username);
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        } catch {
          // Best-effort.
        }
        try {
          const balance = await currencySystem.get(currentPlayer.username);
          currentPlayer.currency = balance;
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(wt, packetManager.currency(balance));
        } catch {
          // Best-effort.
        }
        try {
          // Merge the fresh XP first: synchronizeStats rebuilds from the
          // in-memory copy and would otherwise wipe the just-granted
          // xp/level back to their pre-turn-in values (same pattern as the
          // creature-kill XP path).
          const levelBefore = Number(currentPlayer.stats?.level) || 1;
          const xpResult = result.xpResult;
          if (xpResult) {
            currentPlayer.stats.xp = xpResult.xp;
            currentPlayer.stats.max_xp = xpResult.max_xp;
            currentPlayer.stats.level = xpResult.level;
          }
          const leveled = !!xpResult && xpResult.level > levelBefore;
          if (leveled) {
            currentPlayer.stats.max_health = player.getMaxHealthForLevel(xpResult!.level);
            currentPlayer.stats.max_stamina = player.getMaxStaminaForLevel(xpResult!.level);
            const synced = await player.synchronizeStats(currentPlayer.username);
            if (synced) currentPlayer.stats = synced;
            currentPlayer.stats.health = currentPlayer.stats.total_max_health ?? currentPlayer.stats.max_health;
            currentPlayer.stats.stamina = currentPlayer.stats.total_max_stamina ?? currentPlayer.stats.max_stamina;
          } else {
            const syncedStats = await player.synchronizeStats(currentPlayer.username);
            if (syncedStats) currentPlayer.stats = syncedStats;
          }
          playerCache.set(currentPlayer.id, currentPlayer);
          // XP bar: UPDATESTATS handlers only merge health/mana, so push the
          // dedicated XP packet too.
          if (xpResult) {
            sendPacket(
              wt,
              packetManager.updateXp({ id: currentPlayer.id, xp: xpResult.xp, level: xpResult.level, max_xp: xpResult.max_xp })
            );
          }
          const statsPacket = packetManager.updateStats({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats });
          if (leveled) {
            broadcastToAOI(currentPlayer, statsPacket);
            listener.emit(Events.PLAYER_LEVEL_UP, { player: currentPlayer, level: xpResult!.level });
          } else {
            sendPacket(wt, statsPacket);
          }
        } catch {
          // Best-effort.
        }
        await sendQuestMarkersFor(wt, currentPlayer.username, currentPlayer.location.map);
        break;
      }
      case "TOGGLE_QUEST_EDITOR":
      case "QUEST_EDITOR_DATA":
      case "QUEST_EDITOR_SEARCH":
      case "QUEST_EDITOR_SAVE":
      case "QUEST_EDITOR_DELETE": {
        if (!currentPlayer) return;
        if (!questEditor.canUseEditor(currentPlayer)) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to use the quest editor." }));
          break;
        }
        const outcome = await questEditor.handleEditorPacket(type, data);
        if (outcome.kind === "data") {
          sendPacket(wt, packetManager.questEditorData(outcome.data));
        } else if (outcome.kind === "search") {
          sendPacket(wt, packetManager.questEditorResults(outcome.data));
        } else {
          sendPacket(wt, packetManager.questEditorResult({ ok: outcome.ok, errors: outcome.errors, id: outcome.id }));
          if (outcome.ok && (type === "QUEST_EDITOR_SAVE" || type === "QUEST_EDITOR_DELETE")) {
            const viewers = Object.values(playerCache.list() as Record<string, any>).filter(
              (p) => p?.wt?.readyState === 1 && questEditor.canUseEditor(p)
            );
            for (const viewer of viewers) {
              if (viewer.id !== wt.data.id) {
                sendPacket(viewer.wt, packetManager.questEditorUpdated({ by: currentPlayer.username }));
              }
            }
          }
        }
        break;
      }
      case "QUEST_EDITOR_CLOSE": {
        break;
      }
      case "STOPTYPING": {
        if (!currentPlayer || currentPlayer.isGuest) return;
        let playersInMap = filterPlayersByMap(currentPlayer.location.map);
        const stopTypingData = {
          id: wt.data.id,
        };
        if (currentPlayer.isStealth) {
          playersInMap = playersInMap.filter((p) => p.isAdmin);
        }
        playersInMap.forEach((player) => {
          sendPacketBestEffort(player.wt, packetManager.stopTyping(stopTypingData));
        });
        break;
      }
      case "SAVE_MAP": {
        if (!currentPlayer) return;

        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        const hasPermission = perms.includes('server.admin') || perms.includes('server.*');

        if (!hasPermission) {
          sendPacket(wt, packetManager.notify({
            message: 'You do not have permission to save map changes.'
          }));
          return;
        }

        const saveData = data as unknown as { mapName: string, chunks: any[], graveyards?: any, warps?: any };

        try {
          log.info(`Map save requested by ${currentPlayer.username} for map: ${saveData.mapName}, ${saveData.chunks.length} chunks modified`);

          // Forward chunks to asset server via HTTP
          const assetServerUrl = process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL || "http://localhost:8081";
          const authKey = process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY;

          const response = await serverFetch(`${assetServerUrl}/save-map-chunks`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              mapName: saveData.mapName,
              chunks: saveData.chunks,
              bounds: (saveData as any).bounds,
              authKey: authKey
            })
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: response.statusText }));
            throw new Error(errorData.error || `Failed to save chunks to asset server: ${response.status}`);
          }

          log.info(`Map chunks saved to asset server: ${saveData.mapName}`);

          // Also sync graveyards and warps to asset server if present
          if (saveData.graveyards || saveData.warps) {
            try {
              const syncResponse = await serverFetch(`${assetServerUrl}/save-map-properties`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  mapName: saveData.mapName,
                  graveyards: saveData.graveyards,
                  warps: saveData.warps,
                  authKey: authKey
                })
              });

              if (!syncResponse.ok) {
                const syncErrorData = await syncResponse.json().catch(() => ({ error: syncResponse.statusText }));
                log.warn(`Failed to sync graveyards/warps to asset server: ${syncErrorData.error || syncResponse.status}`);
              } else {
                log.info(`Map graveyards/warps synced to asset server: ${saveData.mapName}`);
              }
            } catch (syncError) {
              log.warn(`Error syncing graveyards/warps to asset server: ${syncError}`);
            }
          }

          // Save graveyards and warps to mapProperties
          if (saveData.graveyards !== undefined || saveData.warps !== undefined) {
            const mapPropertiesCache = await assetCache.get("mapProperties");
            const mapPropsIndex = mapPropertiesCache.findIndex((m: any) => m.name === `${saveData.mapName.replace('.json', '')}.json`);

            if (mapPropsIndex !== -1) {
              if (saveData.graveyards !== undefined) {
                mapPropertiesCache[mapPropsIndex].graveyards = saveData.graveyards;
              }
              if (saveData.warps !== undefined) {
                mapPropertiesCache[mapPropsIndex].warps = saveData.warps;
              }

              try {
                await assetCache.add("mapProperties", mapPropertiesCache);
              } catch (propError) {
                log.warn(`Failed to update mapProperties for ${saveData.mapName}: ${propError}`);
              }
            }
          }

          // Update local cache with the changes AND save to disk
          const cachedMaps = (await assetCache.get("maps")) as MapData[];
          const mapIndex = cachedMaps.findIndex((m: any) => m.name === saveData.mapName);
          let rebaseResult: { shiftX: number; shiftY: number; width: number; height: number } | null = null;

          if (mapIndex !== -1) {
            // Update actual map layers with chunk data (growing / re-basing the
            // origin for infinite-map expansion; empty expansion is trimmed away).
            const mapData = cachedMaps[mapIndex].data;
            rebaseResult = applyChunksWithRebase(mapData, saveData.chunks, (saveData as any).bounds);

            // Update graveyards and warps in the map data
            if (saveData.graveyards !== undefined) {
              cachedMaps[mapIndex].data.graveyards = saveData.graveyards;
            }
            if (saveData.warps !== undefined) {
              cachedMaps[mapIndex].data.warps = saveData.warps;
            }

            assetCache.add("maps", cachedMaps);

            // Save graveyards and warps properties and reload the map
            if (saveData.graveyards !== undefined || saveData.warps !== undefined) {
              try {
                log.debug(`[SAVE_MAP] Graveyards: ${saveData.graveyards ? `${saveData.graveyards.length} items` : 'undefined'}`);
                log.debug(`[SAVE_MAP] Warps: ${saveData.warps ? `${saveData.warps.length} items` : 'undefined'}`);

                // Only call saveMapProperties if there's actual data to save
                if ((saveData.graveyards && saveData.graveyards.length > 0) || (saveData.warps && saveData.warps.length > 0)) {
                  await saveMapProperties(saveData.mapName, saveData.graveyards, saveData.warps);

                  // Reload the map to refresh mapProperties cache
                  const { reloadMap: reloadMapFunc } = await import("../modules/assetloader");
                  const reloadedMap = await reloadMapFunc(saveData.mapName);

                  // Update the cached maps with the reloaded map
                  const updatedMaps = cachedMaps;
                  const mapIdx = updatedMaps.findIndex((m: any) => m.name === saveData.mapName);
                  if (mapIdx !== -1) {
                    updatedMaps[mapIdx] = reloadedMap;
                    assetCache.add("maps", updatedMaps);
                  }
                } else {
                  log.debug(`[SAVE_MAP] No graveyards or warps to save`);
                }
              } catch (propError) {
                log.warn(`Failed to save/reload map properties: ${propError}`);
              }
            }

          }

          // Save chunks to disk locally so reloadMap reads fresh file
          try {
            await saveMapChunks(saveData.mapName, saveData.chunks, (saveData as any).bounds);
          } catch (diskError) {
            log.warn(`Failed to save chunks to disk locally: ${diskError}`);
          }

          // Refresh collision cache since collision layer may have been updated
          try {
            const { reloadMap } = await import("../modules/assetloader");
            await reloadMap(saveData.mapName);
            log.info(`Collision cache refreshed for ${saveData.mapName}`);
            clearMapCache(saveData.mapName);
          } catch (reloadError) {
            log.warn(`Failed to reload map collision cache: ${reloadError}`);
          }

          sendPacket(wt, packetManager.notify({
            message: `Map saved successfully! ${saveData.chunks.length} chunks updated.`
          }));

          // Propagate the save to everyone on the map. Bounds (incl. trimmed empty
          // expansion) go to ALL players so the saver's view shrinks too; chunk
          // refreshes go only to OTHER players.
          const onMapPlayers = filterPlayersByMap(currentPlayer.location.map);
          const updatedMapData = cachedMaps[mapIndex]?.data;
          // Use the SERVER-computed shift (empty expansion is trimmed away, so the
          // real shift may be 0 even if the client claimed a negative expansion) and
          // the persisted dims (what a reload will show), so live matches reload.
          const shiftTilesX = rebaseResult?.shiftX ?? 0;
          const shiftTilesY = rebaseResult?.shiftY ?? 0;
          const newMapWidth = updatedMapData?.width ?? rebaseResult?.width;
          const newMapHeight = updatedMapData?.height ?? rebaseResult?.height;
          const tw = updatedMapData?.tilewidth || 32;
          const th = updatedMapData?.tileheight || 32;
          const shiftPxX = shiftTilesX * tw;
          const shiftPxY = shiftTilesY * th;

          if (shiftTilesX > 0 || shiftTilesY > 0) {
            // Left/up expansion re-based the origin to (0,0). Shift every on-map
            // player's authoritative position and fully re-sync each client.
            for (const p of onMapPlayers) {
              if (p.location?.position) {
                p.location.position.x = (Number(p.location.position.x) || 0) + shiftPxX;
                p.location.position.y = (Number(p.location.position.y) || 0) + shiftPxY;
                playerCache.set(p.id, p);
              }
            }
            const rebasePayload = { shiftX: shiftPxX, shiftY: shiftPxY, width: newMapWidth, height: newMapHeight };
            onMapPlayers.forEach((player) => {
              sendPacket(player.wt, packetManager.mapRebase(rebasePayload));
            });
          } else {
            // No re-base (grew or trimmed): update EVERYONE's bounds (shiftX/Y = 0 is
            // a bounds-only update that drops trimmed-away chunks without re-fetching),
            // and refresh the saved chunks for OTHER players only.
            const boundsPayload = { shiftX: 0, shiftY: 0, width: newMapWidth, height: newMapHeight };
            onMapPlayers.forEach((player) => {
              sendPacket(player.wt, packetManager.mapRebase(boundsPayload));
            });
            const chunkCoords = saveData.chunks.map((chunk: any) => ({
              chunkX: chunk.chunkX,
              chunkY: chunk.chunkY
            }));
            onMapPlayers
              .filter((p) => p.id !== wt.data.id)
              .forEach((player) => {
                sendPacket(player.wt, packetManager.updateChunks({ chunks: chunkCoords }));
              });
          }
        } catch (error: any) {
          log.error(`Error saving map: ${error.message}`);
          sendPacket(wt, packetManager.notify({
            message: 'Error saving map changes.'
          }));
        }

        // Clear edit history for this map now that it's saved
        if (saveData.mapName) {
          editorEditHistory.delete(saveData.mapName);
        }

        break;
      }
      case "SAVE_PARTICLE": {
        if (!currentPlayer) return;

        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        const hasPermission = perms.includes('server.admin') || perms.includes('server.*');

        if (!hasPermission) {
          sendPacket(wt, packetManager.notify({
            message: 'You do not have permission to save particles.'
          }));
          return;
        }

        try {
          const particleData = data as unknown as Particle;

          // Check if particle already exists
          const existingParticles = await particles.list();
          const particleExists = existingParticles.some(p => p.name === particleData.name);

          if (particleExists) {
            await particles.update(particleData);
            log.info(`Particle updated by ${currentPlayer.username}: ${particleData.name}`);
          } else {
            await particles.add(particleData);
            log.info(`Particle added by ${currentPlayer.username}: ${particleData.name}`);
          }

          // Reload particles cache from database to ensure consistency
          const updatedParticles = await particles.list();
          const updatedParticleData = updatedParticles.find(p => p.name === particleData.name);

          // Broadcast particle update to all connected players
          if (updatedParticleData) {
            const updatePacket = packetManager.particleUpdated(updatedParticleData);
            const allPlayers = playerCache.list();
            for (const playerId in allPlayers) {
              const player = allPlayers[playerId];
              if (player.wt && player.wt.readyState === 1) { // readyState 1 = OPEN
                sendPacket(player.wt, updatePacket);
              }
            }
          }

          sendPacket(wt, packetManager.notify({
            message: 'Particle saved successfully'
          }));
        } catch (error: any) {
          log.error(`Error saving particle: ${error.message}`);
          sendPacket(wt, packetManager.notify({
            message: 'Error saving particle.'
          }));
        }
        break;
      }
      case "DELETE_PARTICLE": {
        if (!currentPlayer) return;

        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        const hasPermission = perms.includes('server.admin') || perms.includes('server.*');

        if (!hasPermission) {
          sendPacket(wt, packetManager.notify({
            message: 'You do not have permission to delete particles.'
          }));
          return;
        }

        try {
          const { name } = data as unknown as { name: string };
          await particles.remove({ name } as any);
          log.info(`Particle deleted by ${currentPlayer.username}: ${name}`);

          sendPacket(wt, packetManager.notify({
            message: 'Particle deleted successfully'
          }));
        } catch (error: any) {
          log.error(`Error deleting particle: ${error.message}`);
          sendPacket(wt, packetManager.notify({
            message: 'Error deleting particle.'
          }));
        }
        break;
      }
      case "LIST_PARTICLES": {
        if (!currentPlayer) return;

        try {
          const particleList = await particles.list();
          sendPacket(wt, packetManager.custom({
            type: "PARTICLE_LIST",
            data: particleList
          }));
        } catch (error: any) {
          log.error(`Error listing particles: ${error.message}`);
          sendPacket(wt, packetManager.notify({
            message: 'Error loading particles.'
          }));
        }
        break;
      }
      case "LIST_NPCS": {
        if (!currentPlayer) return;

        try {
          const allNpcs = await assetCache.get("npcs") as Npc[];
          const mapName = currentPlayer.location.map;
          const npcsInMap = (allNpcs || []).filter((npc: Npc) => npc.map === mapName);
          // Resolve particles to include all particle data (including time fields)
          const resolvedNpcs = await Promise.all(npcsInMap.map(resolveNpcForClient));
          // Quest links for the NPC editor's given/ended pickers.
          for (const npc of resolvedNpcs) {
            const npcId = Number((npc as any).id);
            if (Number.isFinite(npcId)) {
              (npc as any).questsGiven = questDefinitions.questsGivenBy(npcId);
              (npc as any).questsEnded = questDefinitions.questsEndedBy(npcId);
            }
          }
          const questCatalog = questDefinitions.getCachedQuestsSync().map((q) => ({ id: q.id, name: q.name }));
          // Sprite data for the appearance tab, same feed as the creature editor.
          const [spriteSheets, icons] = await Promise.all([listSpriteSheets(), listIcons()]);

          sendPacket(wt, packetManager.npcList(resolvedNpcs, questCatalog, { spriteSheets, icons }));
        } catch (error: any) {
          log.error(`Error listing NPCs: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: "Error loading NPCs." }));
        }
        break;
      }
      case "ADD_NPC": {
        if (!currentPlayer) return;

        if (
          !currentPlayer.permissions.some(
            (p: string) => p === "server.admin" || p === "server.*"
          )
        ) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to add NPCs." }));
          return;
        }

        try {
          const mapName = currentPlayer.location.map;
          const clientData = data as any;
          const newNpc: Npc = {
            id: null,
            last_updated: null,
            map: mapName,
            name: clientData?.name ?? null,
            position: {
              x: clientData?.position?.x ?? currentPlayer.location.position.x,
              y: clientData?.position?.y ?? currentPlayer.location.position.y,
              direction: clientData?.position?.direction ?? "down",
            },
            hidden: clientData?.hidden ?? false,
            script: clientData?.script ?? null,
            dialog: clientData?.dialog ?? null,
            gossip: clientData?.gossip ?? null,
            particles: clientData?.particles ?? [],
            quest_giver: clientData?.quest_giver === true || clientData?.quest_giver === 1,
            sprite_type: clientData?.sprite_type ?? 'animated',
            sprite_body: clientData?.sprite_body ?? null,
            sprite_head: clientData?.sprite_head ?? null,
            sprite_helmet: clientData?.sprite_helmet ?? null,
            sprite_shoulderguards: clientData?.sprite_shoulderguards ?? null,
            sprite_neck: clientData?.sprite_neck ?? null,
            sprite_hands: clientData?.sprite_hands ?? null,
            sprite_chest: clientData?.sprite_chest ?? null,
            sprite_feet: clientData?.sprite_feet ?? null,
            sprite_legs: clientData?.sprite_legs ?? null,
            sprite_weapon: clientData?.sprite_weapon ?? null,
          };

          await npcSystem.add(newNpc);
          const updatedNpcs = await npcSystem.list();
          await assetCache.set("npcs", updatedNpcs);

          const createdNpc = updatedNpcs
            .filter((n: Npc) => n.map === mapName)
            .sort((a: Npc, b: Npc) => (b.id ?? 0) - (a.id ?? 0))[0];

          // Quest links arrive as questsGiven / questsEnded arrays.
          if (createdNpc?.id) {
            const given: number[] = Array.isArray(clientData?.questsGiven) ? clientData.questsGiven : [];
            const ended: number[] = Array.isArray(clientData?.questsEnded) ? clientData.questsEnded : [];
            try {
              await query("DELETE FROM npc_quests WHERE npc_id = ?", [createdNpc.id]);
              for (const qid of [...new Set([...given.map(Number), ...ended.map(Number)])]) {
                if (!Number.isFinite(qid)) continue;
                if (given.map(Number).includes(qid)) {
                  await query("INSERT INTO npc_quests (npc_id, quest_id, `role`) VALUES (?, ?, 'giver')", [createdNpc.id, qid]);
                }
                if (ended.map(Number).includes(qid)) {
                  await query("INSERT INTO npc_quests (npc_id, quest_id, `role`) VALUES (?, ?, 'ender')", [createdNpc.id, qid]);
                }
              }
              await questDefinitions.reload();
            } catch {
              // Quest links are best-effort on NPC create.
            }
          }

          if (createdNpc) {
            const resolvedNpc = await resolveNpcForClient(createdNpc);
            const updatePacket = packetManager.npcUpdated(resolvedNpc);
            const playersInMap = filterPlayersByMap(mapName);
            for (const p of playersInMap) {
              if (p.wt && p.wt.readyState === 1) {
                sendPacket(p.wt, updatePacket);
              }
            }
          }

          log.info(`NPC added by ${currentPlayer.username} on map ${mapName}`);
        } catch (error: any) {
          log.error(`Error adding NPC: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: "Error adding NPC." }));
        }
        break;
      }
      case "SAVE_NPC": {
        if (!currentPlayer) return;

        if (
          !currentPlayer.permissions.some(
            (p: string) => p === "server.admin" || p === "server.*"
          )
        ) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to save NPCs." }));
          return;
        }

        try {
          const npcData = data as unknown as Npc;
          if (!npcData?.id) {
            sendPacket(wt, packetManager.notify({ message: "Invalid NPC data." }));
            return;
          }

          await npcSystem.update(npcData);
          const updatedNpcs = await npcSystem.list();
          await assetCache.set("npcs", updatedNpcs);

          // Quest links arrive as questsGiven / questsEnded arrays.
          try {
            const given: number[] = Array.isArray((npcData as any)?.questsGiven) ? (npcData as any).questsGiven : [];
            const ended: number[] = Array.isArray((npcData as any)?.questsEnded) ? (npcData as any).questsEnded : [];
            if ((npcData as any)?.questsGiven !== undefined || (npcData as any)?.questsEnded !== undefined) {
              await query("DELETE FROM npc_quests WHERE npc_id = ?", [npcData.id]);
              for (const qid of [...new Set([...given.map(Number), ...ended.map(Number)])]) {
                if (!Number.isFinite(qid)) continue;
                if (given.map(Number).includes(qid)) {
                  await query("INSERT INTO npc_quests (npc_id, quest_id, `role`) VALUES (?, ?, 'giver')", [npcData.id, qid]);
                }
                if (ended.map(Number).includes(qid)) {
                  await query("INSERT INTO npc_quests (npc_id, quest_id, `role`) VALUES (?, ?, 'ender')", [npcData.id, qid]);
                }
              }
              await questDefinitions.reload();
            }
          } catch {
            // Quest links are best-effort on NPC save.
          }

          const updatedNpc = updatedNpcs.find((n: Npc) => n.id === npcData.id);
          if (updatedNpc) {
            const resolvedNpc = await resolveNpcForClient(updatedNpc);
            const updatePacket = packetManager.npcUpdated(resolvedNpc);
            const playersInMap = filterPlayersByMap(resolvedNpc.map);
            for (const p of playersInMap) {
              if (p.wt && p.wt.readyState === 1) {
                sendPacket(p.wt, updatePacket);
              }
            }
          }

          sendPacket(wt, packetManager.notify({ message: "NPC saved successfully." }));
          log.info(`NPC ${npcData.id} saved by ${currentPlayer.username}`);
        } catch (error: any) {
          log.error(`Error saving NPC: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: "Error saving NPC." }));
        }
        break;
      }
      case "MOVE_NPC": {
        if (!currentPlayer) return;

        if (
          !currentPlayer.permissions.some(
            (p: string) => p === "server.admin" || p === "server.*"
          )
        ) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to move NPCs." }));
          return;
        }

        try {
          const { id, position } = data as unknown as { id: number; position: { x: number; y: number } };
          if (!id || !position) {
            sendPacket(wt, packetManager.notify({ message: "Invalid NPC move data." }));
            return;
          }

          const allNpcs = await assetCache.get("npcs") as Npc[];
          const existingNpc = (allNpcs || []).find((n: Npc) => n.id === id);
          if (!existingNpc) {
            sendPacket(wt, packetManager.notify({ message: "NPC not found." }));
            return;
          }

          const updatedNpcData: Npc = {
            ...existingNpc,
            position: {
              x: position.x,
              y: position.y,
              direction: existingNpc.position.direction || "down",
            },
          };

          await npcSystem.update(updatedNpcData);
          const updatedNpcs = await npcSystem.list();
          await assetCache.set("npcs", updatedNpcs);

          const updatedNpc = updatedNpcs.find((n: Npc) => n.id === id);
          if (updatedNpc) {
            const resolvedNpc = await resolveNpcForClient(updatedNpc);
            const updatePacket = packetManager.npcUpdated(resolvedNpc);
            const playersInMap = filterPlayersByMap(resolvedNpc.map);
            for (const p of playersInMap) {
              if (p.wt && p.wt.readyState === 1) {
                sendPacket(p.wt, updatePacket);
              }
            }
          }

          log.info(`NPC ${id} moved by ${currentPlayer.username}`);
        } catch (error: any) {
          log.error(`Error moving NPC: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: "Error moving NPC." }));
        }
        break;
      }
      case "DELETE_NPC": {
        if (!currentPlayer) return;

        if (
          !currentPlayer.permissions.some(
            (p: string) => p === "server.admin" || p === "server.*"
          )
        ) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to delete NPCs." }));
          return;
        }

        try {
          const { id } = data as unknown as { id: number };
          if (!id) {
            sendPacket(wt, packetManager.notify({ message: "Invalid NPC ID." }));
            return;
          }

          const allNpcs = await assetCache.get("npcs") as Npc[];
          const existingNpc = (allNpcs || []).find((n: Npc) => n.id === id);
          if (!existingNpc) {
            sendPacket(wt, packetManager.notify({ message: "NPC not found." }));
            return;
          }

          const mapName = existingNpc.map;
          await npcSystem.remove({ id } as Npc);
          const updatedNpcs = await npcSystem.list();
          await assetCache.set("npcs", updatedNpcs);

          const removePacket = packetManager.npcRemoved(id);
          const playersInMap = filterPlayersByMap(mapName);
          for (const p of playersInMap) {
            if (p.wt && p.wt.readyState === 1) {
              sendPacket(p.wt, removePacket);
            }
          }

          sendPacket(wt, packetManager.notify({ message: "NPC deleted successfully." }));
          log.info(`NPC ${id} deleted by ${currentPlayer.username}`);
        } catch (error: any) {
          log.error(`Error deleting NPC: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: "Error deleting NPC." }));
        }
        break;
      }
      case "TEST_PARTICLE": {
        if (!currentPlayer) return;

        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        const hasPermission = perms.includes('server.admin') || perms.includes('server.*');

        if (!hasPermission) {
          return;
        }

        try {
          const { testType, data: testData } = data as { testType: string; data: any };
          log.info(`Particle test by ${currentPlayer.username}: type=${testType}`);

          // Broadcast test particle event to all players in the map
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          playersInMap.forEach((player) => {
            sendPacket(player.wt, packetManager.custom({
              type: "TEST_PARTICLE_EVENT",
              data: {
                testType,
                particle: testData.particle,
                position: testData.position || currentPlayer.location,
                npcId: testData.npcId
              }
            }));
          });
        } catch (error: any) {
          log.error(`Error testing particle: ${error.message}`);
        }
        break;
      }
      case "COMMAND": {
        if (!currentPlayer) return;
        // Corpses keep party/whisper/guild chat; the allowlist is enforced
        // after parsing below. Ghosts keep all commands; only proximity say
        // (/s, the CHAT packet) is barred for them.
        if (currentPlayer.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }
        const _data = data as any;
        const command = _data?.command;
        const mode = _data?.mode;

        let decryptedMessage;
        if (mode && mode == "decrypt") {
          const encryptedMessage = Buffer.from(
            Object.values(command) as number[]
          );

          const privateKey = _privateKey;
          if (!privateKey) return;
          const decryptedPrivateKey = decryptPrivateKey(
            privateKey,
            process.env.RSA_PASSPHRASE || ""
          ).toString();
          decryptedMessage =
            decryptRsa(encryptedMessage, decryptedPrivateKey) || "";
        } else {
          decryptedMessage = command;
        }

        const commandParts = decryptedMessage.match(/[^\s"]+|"([^"]*)"/g) || [];
        const commandName = commandParts[0]?.toUpperCase();

        // Corpses may use chat channels only: no admin, tool, or other
        // commands while awaiting release.
        if (
          currentPlayer.isDead &&
          !["P", "PARTY", "W", "WHISPER", "G", "GUILD"].includes(commandName || "")
        ) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You cannot do that while dead." })
          );
          return;
        }

        const args = commandParts
          .slice(1)
          .map((arg: any) => (arg.startsWith('"') ? arg.slice(1, -1) : arg));

        switch (commandName) {

          case "P":
          case "PARTY": {
            if (!currentPlayer) return;
            const message = args.join(" ");
            if (!message) {
              sendPacket(
                wt,
                packetManager.notify({ message: "Please provide a message" })
              );
              break;
            }

            const partyId = await player.getPartyIdByUsername(
              currentPlayer.username
            );
            if (!partyId) {
              sendPacket(
                wt,
                packetManager.notify({ message: "You are not in a party" })
              );
              break;
            }

            const partyMembers = await parties.getPartyMembers(partyId);
            if (partyMembers.length === 0 || !partyMembers) {
              sendPacket(
                wt,
                packetManager.notify({ message: "You are not in a party" })
              );
              break;
            }

            partyMembers.forEach(async (member: any) => {
              const session_id = await player.getSessionIdByUsername(member);
              const memberPlayer = playerCache.get(session_id);
              if (memberPlayer) {
                sendPacket(
                  memberPlayer.wt,
                  packetManager.partyChat({
                    id: wt.data.id,
                    message,
                    username:
                      currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1),
                  })
                );
              }
            });

            listener.emit(Events.PARTY_CHAT, { player: currentPlayer, message, partyMembers } as any);
            break;
          }

          case "W":
          case "WHISPER": {
            const username = args[0]?.toLowerCase() || null;
            if (!username) {
              const notifyData = {
                message: "Please provide a username",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const players = Object.values(playerCache.list());
            const targetPlayer = players.find(
              (p) => p.username.toLowerCase() === username.toLowerCase()
            );

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            sendPacket(
              targetPlayer.wt,
              packetManager.whisper({
                id: wt.data.id,
                message: args.slice(1).join(" "),

                username: `<- ${currentPlayer.username.charAt(0).toUpperCase() +
                  currentPlayer.username.slice(1)
                  }`,
              })
            );

            sendPacket(
              wt,
              packetManager.whisper({
                id: targetPlayer.id,
                message: args.slice(1).join(" "),
                username: `-> ${targetPlayer.username.charAt(0).toUpperCase() +
                  targetPlayer.username.slice(1)
                  }`,
              })
            );

            break;
          }

          case "INVITE": {
            const username = args[0]?.toLowerCase() || null;
            if (!username) {
              sendPacket(
                wt,
                packetManager.notify({
                  message: "Usage: /invite <username>",
                })
              );
              break;
            }

            if (username === currentPlayer.username.toLowerCase()) {
              sendPacket(
                wt,
                packetManager.notify({
                  message: "You cannot invite yourself to a party.",
                })
              );
              break;
            }

            const players = Object.values(playerCache.list());
            const targetPlayer = players.find(
              (p: any) => p.username && p.username.toLowerCase() === username.toLowerCase()
            );

            if (!targetPlayer) {
              sendPacket(
                wt,
                packetManager.notify({
                  message: `Player ${username} is not online.`,
                })
              );
              break;
            }

            if (targetPlayer.id === currentPlayer.id) {
              sendPacket(
                wt,
                packetManager.notify({
                  message: "You cannot invite yourself to a party.",
                })
              );
              break;
            }

            const existingInvite = targetPlayer.invitations?.find(
              (invite: any) => invite?.type === "party" && invite?.from === currentPlayer.username
            );

            if (existingInvite) {
              sendPacket(
                wt,
                packetManager.notify({
                  message: `You have already sent a party invite to ${targetPlayer.username}.`,
                })
              );
              break;
            }

            const player_username =
              currentPlayer.username.charAt(0).toUpperCase() +
              currentPlayer.username.slice(1);

            const invite_data = {
              action: "INVITE_PARTY",
              message: `${player_username} wants to invite you to their party`,
              originator: currentPlayer.id.toString(),
              authorization: randomBytes(16).toString(),
            };

            if (!currentPlayer.invitations) {
              currentPlayer.invitations = [];
            }

            currentPlayer.invitations.push({
              action: invite_data.action,
              originator: invite_data.originator,
              authorization: invite_data.authorization,
            });

            playerCache.set(currentPlayer.id, currentPlayer);

            sendPacket(targetPlayer.wt, packetManager.invitation(invite_data));

            sendPacket(
              wt,
              packetManager.notify({
                message: `Invitation sent to ${targetPlayer.username.charAt(0).toUpperCase() +
                  targetPlayer.username.slice(1)
                  }`,
              })
            );

            break;
          }

          case "G":
          case "GUILD": {
            if (!currentPlayer) return;
            const message = args.join(" ");
            if (!message) {
              sendPacket(wt, packetManager.notify({ message: "Please provide a message" }));
              break;
            }

            const guildId = currentPlayer.guild_id;
            if (!guildId) {
              sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
              break;
            }

            const guildMembers = await guilds.getGuildMembers(guildId);
            if (!guildMembers || guildMembers.length === 0) {
              sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
              break;
            }

            guildMembers.forEach(async (member: any) => {
              const session_id = await player.getSessionIdByUsername(member);
              const memberPlayer = playerCache.get(session_id);
              if (memberPlayer) {
                sendPacket(
                  memberPlayer.wt,
                  packetManager.guildChat({
                    id: wt.data.id,
                    message,
                    username:
                      currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1),
                  })
                );
              }
            });

            listener.emit(Events.GUILD_CHAT, { player: currentPlayer, message, guildMembers, guildId } as any);
            break;
          }

          case "GINVITE": {
            if (!currentPlayer) return;
            if (currentPlayer.isGuest) {
              sendPacket(wt, packetManager.notify({ message: "Please create an account to use that feature." }));
              break;
            }

            const guildId = currentPlayer.guild_id;
            if (!guildId) {
              sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
              break;
            }

            const isLeader = await guilds.isGuildLeader(currentPlayer.username);
            if (!isLeader) {
              sendPacket(wt, packetManager.notify({ message: "You are not the guild leader" }));
              break;
            }

            const username = args[0]?.toLowerCase() || null;
            if (!username) {
              sendPacket(wt, packetManager.notify({ message: "Usage: /ginvite <username>" }));
              break;
            }

            if (username === currentPlayer.username.toLowerCase()) {
              sendPacket(wt, packetManager.notify({ message: "You cannot invite yourself to your guild." }));
              break;
            }

            const players = Object.values(playerCache.list());
            const targetPlayer = players.find(
              (p: any) => p.username && p.username.toLowerCase() === username.toLowerCase()
            );

            if (!targetPlayer) {
              sendPacket(wt, packetManager.notify({ message: `Player ${username} is not online.` }));
              break;
            }

            if (targetPlayer.isGuest) {
              sendPacket(wt, packetManager.notify({ message: `${targetPlayer.username} is a guest and cannot join a guild.` }));
              break;
            }

            const targetInGuild = await guilds.isInGuild(targetPlayer.username);
            if (targetInGuild) {
              sendPacket(wt, packetManager.notify({ message: `${targetPlayer.username} is already in a guild` }));
              break;
            }

            const existingInvite = targetPlayer.invitations?.find(
              (invite: any) => invite?.action === "INVITE_GUILD" && invite?.originator === currentPlayer.id.toString()
            );

            if (existingInvite) {
              sendPacket(wt, packetManager.notify({ message: `You have already sent a guild invite to ${targetPlayer.username}.` }));
              break;
            }

            const player_username =
              currentPlayer.username.charAt(0).toUpperCase() +
              currentPlayer.username.slice(1);

            const guildName = currentPlayer.guild_name || "Unknown Guild";

            const invite_data = {
              action: "INVITE_GUILD",
              message: `${player_username} wants to invite you to join "${guildName}"`,
              originator: currentPlayer.id.toString(),
              authorization: randomBytes(16).toString(),
            };

            if (!currentPlayer.invitations) {
              currentPlayer.invitations = [];
            }

            currentPlayer.invitations.push({
              action: invite_data.action,
              originator: invite_data.originator,
              authorization: invite_data.authorization,
            });

            playerCache.set(currentPlayer.id, currentPlayer);

            sendPacket(targetPlayer.wt, packetManager.invitation(invite_data));

            sendPacket(
              wt,
              packetManager.notify({
                message: `Invitation sent to ${targetPlayer.username.charAt(0).toUpperCase() +
                  targetPlayer.username.slice(1)}`,
              })
            );

            break;
          }

          case "SUMMON": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.summon" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const identifier = args[0]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(identifier))) {

              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              targetPlayer = playerCache.get(identifier);
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot summon yourself",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.isAdmin && !currentPlayer.permissions.some((p: string) => p === "admin.summonadmins" || p === "admin.*")) {
              const notifyData = {
                message: "You cannot summon other admins",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.location.map !== currentPlayer.location.map) {

              const result = await player.setLocation(
                targetPlayer.id,
                currentPlayer.location.map,
                {
                  x: currentPlayer.location.position.x,
                  y: currentPlayer.location.position.y,
                  direction: targetPlayer.location.position?.direction || "down",
                }
              );

              if (
                result &&
                typeof result === "object" &&
                "affectedRows" in result &&
                (result as { affectedRows: number }).affectedRows != 0
              ) {
                if (!currentPlayer.forceVisibleTo) currentPlayer.forceVisibleTo = new Set();
                currentPlayer.forceVisibleTo.add(targetPlayer.id);

                playerCache.set(targetPlayer.id, targetPlayer);

                setTimeout(() => {
                  const admin = playerCache.get(currentPlayer.id);
                  if (admin?.forceVisibleTo) {
                    admin.forceVisibleTo.delete(targetPlayer.id);
                    playerCache.set(admin.id, admin);
                  }
                }, 5000);

                await transitionPlayerToMap(
                  targetPlayer,
                  currentPlayer.location.map,
                  {
                    x: Math.round(currentPlayer.location.position.x),
                    y: Math.round(currentPlayer.location.position.y),
                    direction: targetPlayer.location.position?.direction || "down",
                  },
                  targetPlayer.wt,
                  spawnBatchQueue,
                  despawnBatchQueue
                );

                sendPacket(
                  targetPlayer.wt,
                  packetManager.notify({
                    message: `You have been summoned by an admin`,
                  })
                );

                sendPacket(
                  wt,
                  packetManager.notify({
                    message: `Summoned ${targetPlayer.username.charAt(0).toUpperCase() +
                      targetPlayer.username.slice(1)
                      } to your location`,
                  })
                );
              } else {
                const notifyData = {
                  message: "Failed to summon player",
                };
                sendPacket(wt, packetManager.notify(notifyData));
              }
            } else {

              targetPlayer.location.position = {
                x: Math.round(currentPlayer.location.position.x),
                y: Math.round(currentPlayer.location.position.y),
                direction: targetPlayer.location.position?.direction || "down",
              };

              if (currentPlayer.aoi?.layerId && targetPlayer.aoi) {
                const adminLayerId = currentPlayer.aoi.layerId;
                const adminLayerInfo = layerManager.getLayerInfo(adminLayerId);

                if (adminLayerInfo && adminLayerInfo.playerCount < 100) {

                  layerManager.removePlayerFromLayer(targetPlayer.id);
                  const layer = layerManager.getLayerInfo(adminLayerId);
                  if (layer) {
                    layer.players.add(targetPlayer.id);
                    layer.playerCount++;
                    targetPlayer.aoi.layerId = adminLayerId;
                    resyncSkeletonsFor(targetPlayer.id);
                    log.info(`[SUMMON] ${targetPlayer.username} moved to admin's layer ${adminLayerId}`);
                  }
                }
              }

              playerCache.set(targetPlayer.id, targetPlayer);

              await updatePlayerAOI(targetPlayer, spawnBatchQueue, despawnBatchQueue);
              await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);

              const targetAnimationNameForSprite = getAnimationNameForDirection(
                targetPlayer.location.position?.direction || "down",
                !!targetPlayer.moving,
                !!targetPlayer.mounted,
                targetPlayer.mount_type,
                !!targetPlayer.casting
              );
              const targetSpriteData = await getPlayerSpriteSheetData(targetAnimationNameForSprite, targetPlayer.equipment || null);

              let targetSpritesData = null;
              if (targetSpriteData?.bodySprite || targetSpriteData?.headSprite) {
                targetSpritesData = {
                  mountSprite: targetPlayer.mounted && targetPlayer.mount_type ? getMountSpriteUrl(targetPlayer.mount_type) : null,
                  bodySprite: targetSpriteData.bodySprite || null,
                  headSprite: targetSpriteData.headSprite || null,
                  armorHelmetSprite: targetSpriteData.armorHelmetSprite || null,
                  armorShoulderguardsSprite: targetSpriteData.armorShoulderguardsSprite || null,
                  armorNeckSprite: targetSpriteData.armorNeckSprite || null,
                  armorHandsSprite: targetSpriteData.armorHandsSprite || null,
                  armorChestSprite: targetSpriteData.armorChestSprite || null,
                  armorFeetSprite: targetSpriteData.armorFeetSprite || null,
                  armorLegsSprite: targetSpriteData.armorLegsSprite || null,
                  armorWeaponSprite: targetSpriteData.armorWeaponSprite || null,
                  animationState: targetSpriteData.animationState,
                };
              }

              const targetSpawnData = {
                id: targetPlayer.id,
                userid: targetPlayer.userid,
                location: {
                  map: targetPlayer.location.map,
                  x: targetPlayer.location.position.x,
                  y: targetPlayer.location.position.y,
                  direction: targetPlayer.location.position?.direction || "down",
                  moving: targetPlayer.moving || false,
                },
                username: targetPlayer.username,
                isAdmin: targetPlayer.isAdmin,
                isGuest: targetPlayer.isGuest,
                isStealth: targetPlayer.isStealth,
                isNoclip: targetPlayer.isNoclip,
                stats: targetPlayer.stats,
                animation: null,
                spriteData: targetSpritesData,
                mounted: targetPlayer.mounted,
                guild: targetPlayer.guild || [],
                guild_name: targetPlayer.guild_name || null,
              };

              sendPacket(wt, packetManager.loadPlayers({
                players: [targetSpawnData],
                snapshotRevision: globalStateRevision
              }));

              const targetAnimationName = getAnimationNameForDirection(
                targetPlayer.location.position?.direction || "down",
                !!targetPlayer.moving,
                !!targetPlayer.mounted,
                targetPlayer.mount_type || undefined,
                !!targetPlayer.casting
              );
              await sendAnimationTo(wt, targetAnimationName, targetPlayer.id);

              globalStateRevision++;

              const targetMovementData = {
                i: targetPlayer.id,
                d: {
                  x: Number(targetPlayer.location.position.x),
                  y: Number(targetPlayer.location.position.y),
                  dr: targetPlayer.location.position.direction
                },
                r: globalStateRevision,
                s: targetPlayer.isStealth ? 1 : 0
              };
              sendPacket(targetPlayer.wt, packetManager.moveXY(targetMovementData));

              sendPacket(wt, packetManager.moveXY(targetMovementData));

              const allPlayers = playerCache.list();
              for (const playerId of currentPlayer.aoi.playersInAOI) {
                const otherPlayer = allPlayers[playerId as string];
                if (!otherPlayer || !otherPlayer.wt || otherPlayer.id === targetPlayer.id || otherPlayer.id === currentPlayer.id) continue;

                const canSeeTarget = !targetPlayer.isStealth || otherPlayer.isAdmin;
                if (canSeeTarget) {
                  sendPacket(otherPlayer.wt, packetManager.moveXY(targetMovementData));
                }
              }

              sendPacket(
                targetPlayer.wt,
                packetManager.notify({
                  message: `You have been summoned by an admin`,
                })
              );

              sendPacket(
                wt,
                packetManager.notify({
                  message: `Summoned ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)
                    }`,
                })
              );
            }
            break;
          }

          case "GOTO":
          case "TELEPORT": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.summon" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const identifier = args[0]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(identifier))) {

              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {

              targetPlayer = playerCache.get(identifier);
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot teleport to yourself",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.location.map !== currentPlayer.location.map) {

              const result = await player.setLocation(
                currentPlayer.id,
                targetPlayer.location.map,
                {
                  x: targetPlayer.location.position.x,
                  y: targetPlayer.location.position.y,
                  direction: currentPlayer.location.position?.direction || "down",
                }
              );

              if (
                result &&
                typeof result === "object" &&
                "affectedRows" in result &&
                (result as { affectedRows: number }).affectedRows != 0
              ) {
                if (!currentPlayer.forceVisibleTo) currentPlayer.forceVisibleTo = new Set();
                currentPlayer.forceVisibleTo.add(targetPlayer.id);

                playerCache.set(currentPlayer.id, currentPlayer);
                playerCache.set(targetPlayer.id, targetPlayer);

                setTimeout(() => {
                  const admin = playerCache.get(currentPlayer.id);
                  if (admin?.forceVisibleTo) {
                    admin.forceVisibleTo.delete(targetPlayer.id);
                    playerCache.set(admin.id, admin);
                  }
                }, 5000);

                await transitionPlayerToMap(
                  currentPlayer,
                  targetPlayer.location.map,
                  {
                    x: Math.round(targetPlayer.location.position.x),
                    y: Math.round(targetPlayer.location.position.y),
                    direction: currentPlayer.location.position?.direction || "down",
                  },
                  wt,
                  spawnBatchQueue,
                  despawnBatchQueue
                );

                sendPacket(
                  wt,
                  packetManager.notify({
                    message: `Teleported to ${targetPlayer.username.charAt(0).toUpperCase() +
                      targetPlayer.username.slice(1)
                      }'s location`,
                  })
                );
              } else {
                const notifyData = {
                  message: "Failed to teleport to player",
                };
                sendPacket(wt, packetManager.notify(notifyData));
              }
            } else {

              currentPlayer.location.position = {
                x: Math.round(targetPlayer.location.position.x),
                y: Math.round(targetPlayer.location.position.y),
                direction: currentPlayer.location.position?.direction || "down",
              };

              if (targetPlayer.aoi?.layerId && currentPlayer.aoi) {
                const targetLayerId = targetPlayer.aoi.layerId;
                const targetLayerInfo = layerManager.getLayerInfo(targetLayerId);

                if (targetLayerInfo && targetLayerInfo.playerCount < 100) {

                  layerManager.removePlayerFromLayer(currentPlayer.id);
                  const layer = layerManager.getLayerInfo(targetLayerId);
                  if (layer) {
                    layer.players.add(currentPlayer.id);
                    layer.playerCount++;
                    currentPlayer.aoi.layerId = targetLayerId;
                    resyncSkeletonsFor(currentPlayer.id);
                    log.info(`[TELEPORT] Admin ${currentPlayer.username} moved to target's layer ${targetLayerId}`);
                  }
                }
              }

              playerCache.set(currentPlayer.id, currentPlayer);

              await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
              await updatePlayerAOI(targetPlayer, spawnBatchQueue, despawnBatchQueue);

              const targetAnimationNameForSpriteTeleport = getAnimationNameForDirection(
                targetPlayer.location.position?.direction || "down",
                !!targetPlayer.moving,
                !!targetPlayer.mounted,
                targetPlayer.mount_type,
                !!targetPlayer.casting
              );
              const targetSpriteDataTeleport = await getPlayerSpriteSheetData(targetAnimationNameForSpriteTeleport, targetPlayer.equipment || null);

              let targetSpritesDataTeleport = null;
              if (targetSpriteDataTeleport?.bodySprite || targetSpriteDataTeleport?.headSprite) {
                targetSpritesDataTeleport = {
                  mountSprite: targetPlayer.mounted && targetPlayer.mount_type ? getMountSpriteUrl(targetPlayer.mount_type) : null,
                  bodySprite: targetSpriteDataTeleport.bodySprite || null,
                  headSprite: targetSpriteDataTeleport.headSprite || null,
                  armorHelmetSprite: targetSpriteDataTeleport.armorHelmetSprite || null,
                  armorShoulderguardsSprite: targetSpriteDataTeleport.armorShoulderguardsSprite || null,
                  armorNeckSprite: targetSpriteDataTeleport.armorNeckSprite || null,
                  armorHandsSprite: targetSpriteDataTeleport.armorHandsSprite || null,
                  armorChestSprite: targetSpriteDataTeleport.armorChestSprite || null,
                  armorFeetSprite: targetSpriteDataTeleport.armorFeetSprite || null,
                  armorLegsSprite: targetSpriteDataTeleport.armorLegsSprite || null,
                  armorWeaponSprite: targetSpriteDataTeleport.armorWeaponSprite || null,
                  animationState: targetSpriteDataTeleport.animationState,
                };
              }

              const targetSpawnDataTeleport = {
                id: targetPlayer.id,
                userid: targetPlayer.userid,
                location: {
                  map: targetPlayer.location.map,
                  x: targetPlayer.location.position.x,
                  y: targetPlayer.location.position.y,
                  direction: targetPlayer.location.position?.direction || "down",
                  moving: targetPlayer.moving || false,
                },
                username: targetPlayer.username,
                isAdmin: targetPlayer.isAdmin,
                isGuest: targetPlayer.isGuest,
                isStealth: targetPlayer.isStealth,
                isNoclip: targetPlayer.isNoclip,
                stats: targetPlayer.stats,
                animation: null,
                spriteData: targetSpritesDataTeleport,
                mounted: targetPlayer.mounted,
                guild: targetPlayer.guild || [],
                guild_name: targetPlayer.guild_name || null,
              };

              sendPacket(wt, packetManager.loadPlayers({
                players: [targetSpawnDataTeleport],
                snapshotRevision: globalStateRevision
              }));

              const targetAnimationNameTeleport = getAnimationNameForDirection(
                targetPlayer.location.position?.direction || "down",
                !!targetPlayer.moving,
                !!targetPlayer.mounted,
                targetPlayer.mount_type || undefined,
                !!targetPlayer.casting
              );
              await sendAnimationTo(wt, targetAnimationNameTeleport, targetPlayer.id);

              globalStateRevision++;

              const adminMovementData = {
                i: currentPlayer.id,
                d: {
                  x: Number(currentPlayer.location.position.x),
                  y: Number(currentPlayer.location.position.y),
                  dr: currentPlayer.location.position.direction
                },
                r: globalStateRevision,
                s: currentPlayer.isStealth ? 1 : 0
              };
              sendPacket(wt, packetManager.moveXY(adminMovementData));

              const targetMovementData = {
                i: targetPlayer.id,
                d: {
                  x: Number(targetPlayer.location.position.x),
                  y: Number(targetPlayer.location.position.y),
                  dr: targetPlayer.location.position.direction
                },
                r: globalStateRevision,
                s: targetPlayer.isStealth ? 1 : 0
              };
              sendPacket(targetPlayer.wt, packetManager.moveXY(targetMovementData));

              broadcastToAOI(currentPlayer, packetManager.moveXY(adminMovementData), true);
              broadcastToAOI(targetPlayer, packetManager.moveXY(targetMovementData), true);

              sendPacket(
                wt,
                packetManager.notify({
                  message: `Teleported to ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)
                    }`,
                })
              );
            }
            break;
          }

          case "KICK":
          case "DISCONNECT": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.kick" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0].toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(identifier))) {

              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {

              targetPlayer = playerCache.get(identifier);
            }

            if (targetPlayer?.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot disconnect yourself",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.isAdmin) {
              const notifyData = {
                message: "You cannot disconnect other admins",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            player.kick(targetPlayer.username, targetPlayer.wt);
            const notifyData = {
              message: `Disconnected ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } from the server`,
            };
            sendPacket(wt, packetManager.notify(notifyData));
            break;
          }

          case "NOTIFY":
          case "BROADCAST": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.notify" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            let message;
            let audience = "ALL";

            if (!args[0]) return;
            if (!["ALL", "ADMINS", "MAP"].includes(args[0].toUpperCase())) {
              message = args.join(" ");
            } else {
              audience = args[0].toUpperCase();
              message = args.slice(1).join(" ");
            }

            if (!message) return;
            const players = Object.values(playerCache.list());

            switch (audience) {
              case "ALL": {
                players.forEach((player) => {
                  const notifyData = {
                    message: message,
                  };
                  sendPacket(player.wt, packetManager.notify(notifyData));
                });
                break;
              }
              case "ADMINS": {
                const playersInMap = filterPlayersByMap(
                  currentPlayer.location.map
                );
                const playersInMapAdmins = playersInMap.filter(
                  (p) => p.isAdmin
                );
                playersInMapAdmins.forEach((player) => {
                  const notifyData = {
                    message: message,
                  };
                  sendPacket(player.wt, packetManager.notify(notifyData));
                });
                break;
              }
              case "MAP": {
                const playersInMap = filterPlayersByMap(
                  currentPlayer.location.map
                );
                playersInMap.forEach((player) => {
                  const notifyData = {
                    message: message,
                  };
                  sendPacket(player.wt, packetManager.notify(notifyData));
                });
                break;
              }
            }
            break;
          }

          case "BAN": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.ban" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0].toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(identifier))) {

              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {

              targetPlayer = playerCache.get(identifier);
            }

            if (!targetPlayer) {
              const dbPlayer = (await player.findPlayerInDatabase(
                identifier
              )) as { username: string; banned: number }[];
              targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot ban yourself",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.isAdmin) {
              const notifyData = {
                message: "You cannot ban other admins",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.banned) {
              const notifyData = {
                message: `${targetPlayer.username.charAt(0).toUpperCase() +
                  targetPlayer.username.slice(1)
                  } is already banned`,
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            await player.ban(targetPlayer.username, targetPlayer.wt);
            const notifyData = {
              message: `Banned ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } from the server`,
            };
            sendPacket(wt, packetManager.notify(notifyData));
            break;
          }
          case "UNBAN": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.unban" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0] || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const targetPlayer = (await player.findPlayerInDatabase(
              identifier
            )) as { username: string; banned: number }[] as any[];
            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer[0].id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot unban yourself",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            await player.unban(targetPlayer[0].username);
            const notifyData = {
              message: `Unbanned ${targetPlayer[0].username} from the server`,
            };
            sendPacket(wt, packetManager.notify(notifyData));
            break;
          }

          case "ADMIN":
          case "SETADMIN": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.admin" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0].toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(identifier))) {

              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {

              targetPlayer = playerCache.get(identifier);
            }

            if (!targetPlayer) {
              const dbPlayer = (await player.findPlayerInDatabase(
                identifier
              )) as { username: string; banned: number }[];
              targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
            }

            if (targetPlayer?.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot toggle your own admin status",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const admin = await player.toggleAdmin(targetPlayer.username);

            if (targetPlayer && targetPlayer.wt) {
              targetPlayer.isAdmin = admin;
              playerCache.set(targetPlayer.id, targetPlayer);
            }
            const notifyData = {
              message: `${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } is now ${admin ? "an admin" : "not an admin"}`,
            };

            if (targetPlayer?.wt) {
              sendPacket(targetPlayer.wt, packetManager.reconnect());
            }
            sendPacket(wt, packetManager.notify(notifyData));
            break;
          }

          case "WHITELIST": {
            // Check if whitelist is enabled
            const { isWhitelistEnabled } = await import("../socket/server.ts");
            if (!isWhitelistEnabled) {
              const notifyData = {
                message: "Whitelist is not enabled on this realm",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.whitelist" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const whitelistMode = args[0]?.toLowerCase() || null;
            const whitelistUsername = args[1] || null;

            if (!whitelistMode || !["add", "remove"].includes(whitelistMode)) {
              const notifyData = {
                message: "Usage: /whitelist add|remove [username]",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (!whitelistUsername) {
              const notifyData = {
                message: `Usage: /whitelist ${whitelistMode} [username]`,
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            try {
              if (whitelistMode === "add") {
                if (whitelistUsername.toLowerCase() === currentPlayer.username.toLowerCase()) {
                  const notifyData = {
                    message: "You cannot add yourself to the whitelist",
                  };
                  sendPacket(wt, packetManager.notify(notifyData));
                  break;
                }
                const result = await player.whitelistAdd(whitelistUsername);
                const notifyData = {
                  message: result.message,
                };
                sendPacket(wt, packetManager.notify(notifyData));
              } else if (whitelistMode === "remove") {
                if (whitelistUsername.toLowerCase() === currentPlayer.username.toLowerCase()) {
                  const notifyData = {
                    message: "You cannot remove yourself from the whitelist",
                  };
                  sendPacket(wt, packetManager.notify(notifyData));
                  break;
                }
                const result = await player.whitelistRemove(whitelistUsername);
                const notifyData = {
                  message: result.message,
                };
                sendPacket(wt, packetManager.notify(notifyData));
              }
            } catch (error) {
              log.error(`Whitelist command error: ${error}`);
              const notifyData = {
                message: "An error occurred while processing the whitelist command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
            }
            break;
          }

          case "SHUTDOWN": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.shutdown" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const players = Object.values(playerCache.list());
            players.forEach((player) => {
              const notifyData = {
                message:
                  "⚠️ Server shutting down - please reconnect in a few minutes ⚠️",
              };
              sendPacket(player.wt, packetManager.notify(notifyData));
            });

            await new Promise((resolve) => setTimeout(resolve, 5000));
            players.forEach((player) => {
              player.wt.close(1000, "Server is restarting");
            });

            const checkInterval = setInterval(async () => {
              const remainingPlayers = Object.values(playerCache.list());
              remainingPlayers.forEach((player) => {
                player.wt.close(1000, "Server is restarting");
              });

              if (remainingPlayers.length === 0) {
                clearInterval(checkInterval);
                await player.clear();
                Bun.spawn(["bun", "transpile-production"]);
              }
            }, 100);
            break;
          }

          case "TE":
          case "TILEEDITOR": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "tools.tile_editor" || p === "tools.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            sendPacket(wt, packetManager.toggleTileEditor());
            break;
          }

          case "PE":
          case "PARTICLEEDITOR": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "tools.particle_editor" || p === "tools.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            sendPacket(wt, packetManager.toggleParticleEditor());
            break;
          }

          case "IE":
          case "ITEMEDITOR": {
            if (!itemEditor.canUseEditor(currentPlayer)) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleItemEditor());
            break;
          }

          case "QE":
          case "QUESTEDITOR": {
            if (!questEditor.canUseEditor(currentPlayer)) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleQuestEditor());
            break;
          }

          case "CE":
          case "CREATUREEDITOR": {
            if (!creatures.canUseEditor(currentPlayer)) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleCreatureEditor());
            break;
          }

          case "NE":
          case "NPCEDITOR": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "tools.npc_editor" || p === "tools.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            sendPacket(wt, packetManager.toggleNpcEditor());
            break;
          }

          case "RESTART": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.restart" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (restartScheduled) {
              restartTimers.forEach((timer) => clearTimeout(timer));
              restartTimers = [];
              restartScheduled = false;

              const players = Object.values(playerCache.list());
              players.forEach((player) => {
                const notifyData = {
                  message: "⚠️ Server restart has been aborted ⚠️",
                };
                sendPacket(player.wt, packetManager.notify(notifyData));
              });
              break;
            }

            restartScheduled = true;
            restartTimers = [];

            const minutes = 15;
            const RESTART_DELAY = minutes * 60000;
            const totalMinutes = Math.floor(RESTART_DELAY / 60000);

            const minuteIntervals = Array.from(
              { length: totalMinutes },
              (_, i) => totalMinutes - i
            );
            const secondIntervals = Array.from(
              { length: 30 },
              (_, i) => 30 - i
            );

            minuteIntervals.forEach((minutes) => {
              restartTimers.push(
                setTimeout(() => {
                  const players = Object.values(playerCache.list());
                  players.forEach((player) => {
                    const notifyData = {
                      message: `⚠️ Server restarting in ${minutes} minute${minutes === 1 ? "" : "s"
                        } ⚠️`,
                    };
                    sendPacket(player.wt, packetManager.notify(notifyData));
                  });
                }, RESTART_DELAY - minutes * 60 * 1000)
              );
            });

            secondIntervals.forEach((seconds) => {
              restartTimers.push(
                setTimeout(() => {
                  const players = Object.values(playerCache.list());
                  players.forEach((player) => {
                    const notifyData = {
                      message: `⚠️ Server restarting in ${seconds} second${seconds === 1 ? "" : "s"
                        } ⚠️`,
                    };
                    sendPacket(player.wt, packetManager.notify(notifyData));
                  });
                }, RESTART_DELAY - seconds * 1000)
              );
            });

            restartTimers.push(
              setTimeout(() => {
                const players = Object.values(playerCache.list());
                players.forEach((player) => {
                  player.wt.close(1000, "Server is restarting");
                });

                const checkInterval = setInterval(async () => {
                  const remainingPlayers = Object.values(playerCache.list());
                  remainingPlayers.forEach((player) => {
                    player.wt.close(1000, "Server is restarting");
                  });

                  if (remainingPlayers.length === 0) {
                    clearInterval(checkInterval);
                    await player.clear();
                    Bun.spawn(["bun", "transpile-production"]);
                  }
                }, 100);
              }, RESTART_DELAY)
            );
            break;
          }

          case "RESPAWN": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.respawn" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            const identifier = args[0].toLowerCase() || null;

            if (!identifier) {
              targetPlayer = currentPlayer;
            } else {

              const players = Object.values(playerCache.list());
              if (isNaN(Number(identifier))) {

                targetPlayer = players.find(
                  (p) => p.username.toLowerCase() === identifier.toLowerCase()
                );
              } else {

                targetPlayer = playerCache.get(identifier);
              }

              if (!targetPlayer) {
                const dbPlayer = (await player.findPlayerInDatabase(
                  identifier
                )) as { username: string }[];
                targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
              }

              if (!targetPlayer) {
                const notifyData = {
                  message: "Player not found",
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
            }

            const defaultMapProps = mapPropertiesCache.find(
              (m: any) => m.name === `${defaultMap}.json`
            );
            const centerX = defaultMapProps
              ? (defaultMapProps.width * defaultMapProps.tileWidth) / 2
              : 0;
            const centerY = defaultMapProps
              ? (defaultMapProps.height * defaultMapProps.tileHeight) / 2
              : 0;

            await player.setLocation(targetPlayer.username, `${defaultMap}`, {
              x: centerX,
              y: centerY,
              direction: "down",
            });

            if (playerCache.get(targetPlayer.id)) {
              targetPlayer.location.position = {
                x: Math.round(centerX),
                y: Math.round(centerY),
                direction: "down",
              };
              // Admin respawn releases any death state: corpse/ghost cleared,
              // full health, position is the respawn point.
              targetPlayer.isDead = false;
              targetPlayer.isGhost = false;
              targetPlayer.corpse = null;
              targetPlayer.reviveOffered = false;
              targetPlayer.ghostTeleportPending = false;
              resurrection.clearSickness(targetPlayer);
              const respawnSynced = await player.synchronizeStats(targetPlayer.username);
              if (respawnSynced) {
                targetPlayer.stats = respawnSynced;
              }
              if (targetPlayer.stats) {
                targetPlayer.stats.health = targetPlayer.stats.total_max_health;
                targetPlayer.stats.stamina = targetPlayer.stats.total_max_stamina;
              }
              playerCache.set(targetPlayer.id, targetPlayer);
              try {
                await player.setDeadState(targetPlayer.username, 0, null);
              } catch (e: any) {
                log.error(`Failed to clear death state for ${targetPlayer.username}: ${e?.message || e}`);
              }
              const playersInMap = filterPlayersByMap(
                targetPlayer.location.map
              );
              globalStateRevision++;
              playersInMap.forEach((player) => {
                const moveData = {
                  i: targetPlayer.id,
                  d: {
                    x: Number(targetPlayer.location.position.x),
                    y: Number(targetPlayer.location.position.y),
                    dr: targetPlayer.location.position.direction
                  },
                  r: globalStateRevision,
                  s: targetPlayer.isStealth ? 1 : 0
                };
                sendPacket(player.wt, packetManager.moveXY(moveData));
                sendPacket(player.wt, packetManager.playerGhost({ id: targetPlayer.id, ghost: false }));
                if (targetPlayer.stats) {
                  sendPacket(player.wt, packetManager.revive({
                    id: targetPlayer.id,
                    target: targetPlayer.id,
                    stats: targetPlayer.stats,
                  }));
                }
              });
              spellEffects.broadcastEffectsUpdate(targetPlayer);
            }

            const notifyData = {
              message: `Respawned ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                }`,
            };
            sendPacket(wt, packetManager.notify(notifyData));
            listener.emit(Events.PLAYER_RESPAWN, { player: targetPlayer, mapName: targetPlayer.location.map, x: targetPlayer.location.position.x, y: targetPlayer.location.position.y });
            break;
          }

          case "REVIVE": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.revive" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const reviveIdentifier = args[0]?.toLowerCase() || null;

            let reviveTarget: any = null;
            if (!reviveIdentifier) {
              reviveTarget = currentPlayer;
            } else {
              const players = Object.values(playerCache.list());
              if (isNaN(Number(reviveIdentifier))) {
                reviveTarget = players.find(
                  (p) => p.username.toLowerCase() === reviveIdentifier.toLowerCase()
                );
              } else {
                reviveTarget = playerCache.get(reviveIdentifier);
              }
            }

            const onlineTarget = reviveTarget ? playerCache.get(reviveTarget.id) : null;
            if (!onlineTarget) {
              sendPacket(wt, packetManager.notify({ message: "Player must be online to revive" }));
              break;
            }

            if (!onlineTarget.isDead && !onlineTarget.isGhost) {
              const notifyData = {
                message: `${onlineTarget.username.charAt(0).toUpperCase() + onlineTarget.username.slice(1)} is not dead`,
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // Revive in place at full health: clear corpse/ghost state and any
            // Resurrection Sickness, then recompute clean totals.
            onlineTarget.isDead = false;
            onlineTarget.isGhost = false;
            onlineTarget.corpse = null;
            onlineTarget.reviveOffered = false;
            onlineTarget.ghostTeleportPending = false;
            resurrection.clearSickness(onlineTarget);
            const reviveSynced = await player.synchronizeStats(onlineTarget.username);
            if (reviveSynced) {
              onlineTarget.stats = reviveSynced;
            }
            onlineTarget.stats.health = onlineTarget.stats.total_max_health;
            onlineTarget.stats.stamina = onlineTarget.stats.total_max_stamina;
            playerCache.set(onlineTarget.id, onlineTarget);
            try {
              await player.setDeadState(onlineTarget.username, 0, null);
            } catch (e: any) {
              log.error(`Failed to clear death state for ${onlineTarget.username}: ${e?.message || e}`);
            }

            globalStateRevision++;
            filterPlayersByMap(onlineTarget.location.map).forEach((player) => {
              sendPacket(player.wt, packetManager.playerGhost({ id: onlineTarget.id, ghost: false }));
              sendPacket(player.wt, packetManager.revive({
                id: onlineTarget.id,
                target: onlineTarget.id,
                stats: onlineTarget.stats,
              }));
            });
            spellEffects.broadcastEffectsUpdate(onlineTarget);
            sendStatsToPartyMembers(onlineTarget.username, onlineTarget.id, onlineTarget.stats);

            sendPacket(wt, packetManager.notify({
              message: `Revived ${onlineTarget.username.charAt(0).toUpperCase() + onlineTarget.username.slice(1)}`,
            }));
            listener.emit(Events.PLAYER_REVIVED, { player: onlineTarget });
            break;
          }

          case "KILL": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.kill" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const killIdentifier = args[0]?.toLowerCase() || null;

            let killTarget: any = null;
            if (!killIdentifier) {
              killTarget = currentPlayer;
            } else {
              const players = Object.values(playerCache.list());
              if (isNaN(Number(killIdentifier))) {
                killTarget = players.find(
                  (p) => p.username.toLowerCase() === killIdentifier.toLowerCase()
                );
              } else {
                killTarget = playerCache.get(killIdentifier);
              }
            }

            const onlineTarget = killTarget ? playerCache.get(killTarget.id) : null;
            if (!onlineTarget) {
              sendPacket(wt, packetManager.notify({ message: "Player must be online to kill" }));
              break;
            }

            if (onlineTarget.isDead || onlineTarget.isGhost) {
              const notifyData = {
                message: `${onlineTarget.username.charAt(0).toUpperCase() + onlineTarget.username.slice(1)} is already dead`,
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // Force the standard death flow: skeleton, corpse persistence,
            // Release Spirit popup, full server-side locks.
            await handlePlayerDeath(onlineTarget, currentPlayer, {
              damage: onlineTarget.stats?.health || 0,
              isCrit: false,
            });

            sendPacket(wt, packetManager.notify({
              message: `Killed ${onlineTarget.username.charAt(0).toUpperCase() + onlineTarget.username.slice(1)}`,
            }));
            break;
          }

          case "PERMISSION":
          case "PERMISSIONS": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.permission" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const mode = args[0]?.toUpperCase() || null;
            if (!mode) {
              const notifyData = {
                message: "Please provide a mode",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (
              mode !== "ADD" &&
              mode !== "REMOVE" &&
              mode !== "SET" &&
              mode !== "CLEAR" &&
              mode !== "LIST"
            ) {
              const notifyData = {
                message: "Invalid mode",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            const identifier = args[1]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const players = Object.values(playerCache.list());
            if (isNaN(Number(identifier))) {

              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {

              targetPlayer = playerCache.get(identifier);
            }

            if (!targetPlayer) {
              const dbPlayer = (await player.findPlayerInDatabase(
                identifier
              )) as { username: string }[];
              targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // SECURITY: Permission checks FIRST before any other logic
            let hasPermissionToModify = false;
            let requiredPermission = "";

            if (mode === "ADD" || mode === "SET") {
              requiredPermission = "permission.add";
            } else if (mode === "REMOVE" || mode === "CLEAR") {
              requiredPermission = "permission.remove";
            } else if (mode === "LIST") {
              requiredPermission = "permission.list";
            }

            // Check if user has required permission
            hasPermissionToModify = currentPlayer.permissions.some(
              (p: string) =>
                p === requiredPermission || p === "permission.*"
            );

            if (!hasPermissionToModify) {
              const notifyData = {
                message: "Insufficient permissions for this operation",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // SECURITY: Always prevent self-modification regardless of permission level
            if (targetPlayer?.id === currentPlayer.id && mode !== "LIST") {
              const notifyData = {
                message: "You cannot modify your own permissions",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // Check database if target player is an admin
            // Do not rely on cache for this check
            if(!player.isAdmin(targetPlayer.username)) {
              const notifyData = {
                message: "You can only modify permissions for admin players",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let access;
            let permissionsArray: string[] = [];
            if (mode !== "CLEAR" && mode !== "LIST") {
              access = args.slice(2).join(" ");

              const validPermissions = await permissions.list();

              permissionsArray = access.split(",").map((p: string) => p.trim());

              // Validate all permissions exist
              for (const permission of permissionsArray) {
                if (!validPermissions.includes(permission)) {
                  const notifyData = {
                    message: `Invalid permission: ${permission}`,
                  };
                  sendPacket(wt, packetManager.notify(notifyData));
                  return;
                }
              }

              // SECURITY: Validate user can only grant permissions they have
              for (const permission of permissionsArray) {
                const userHasPermission = currentPlayer.permissions.some(
                  (p: string) =>
                    p === permission ||
                    p === "permission.*" ||
                    p === "server.*"
                );

                if (!userHasPermission) {
                  const notifyData = {
                    message: `You cannot grant the ${permission} permission`,
                  };
                  sendPacket(wt, packetManager.notify(notifyData));
                  return;
                }
              }
            }

            // Perform the permission modification
            switch (mode) {
              case "ADD": {
                await permissions.add(targetPlayer.username, permissionsArray.join(","));

                if (targetPlayer.wt) {
                  const existingPerms = targetPlayer.permissions || [];
                  targetPlayer.permissions = [
                    ...new Set([...existingPerms, ...permissionsArray])
                  ];
                  playerCache.set(targetPlayer.id, targetPlayer);
                }

                // Audit log
                log.info(
                  `[PERMISSION_AUDIT] ${currentPlayer.username} (${currentPlayer.id}) added permissions [${permissionsArray.join(
                    ", "
                  )}] to ${targetPlayer.username}`
                );

                const notifyData = {
                  message: `Permissions \`${permissionsArray.join(
                    ", "
                  )}\` added to ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)}`,
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
              case "REMOVE": {
                await permissions.remove(
                  targetPlayer.username,
                  permissionsArray.join(",")
                );

                if (targetPlayer.wt) {
                  targetPlayer.permissions = (targetPlayer.permissions || []).filter(
                    (p: string) => !permissionsArray.includes(p)
                  );
                  playerCache.set(targetPlayer.id, targetPlayer);
                }

                // Audit log
                log.info(
                  `[PERMISSION_AUDIT] ${currentPlayer.username} (${currentPlayer.id}) removed permissions [${permissionsArray.join(
                    ", "
                  )}] from ${targetPlayer.username}`
                );

                const notifyData = {
                  message: `Permissions removed from ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)}`,
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
              case "SET": {
                await permissions.set(targetPlayer.username, permissionsArray);

                if (targetPlayer.wt) {
                  targetPlayer.permissions = permissionsArray;
                  playerCache.set(targetPlayer.id, targetPlayer);
                }

                // Audit log
                log.info(
                  `[PERMISSION_AUDIT] ${currentPlayer.username} (${currentPlayer.id}) set permissions to [${permissionsArray.join(
                    ", "
                  )}] for ${targetPlayer.username}`
                );

                const notifyData = {
                  message: `Permissions set for ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)}`,
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
              case "CLEAR": {
                await permissions.clear(targetPlayer.username);

                targetPlayer.permissions = [];
                const p = playerCache.get(targetPlayer.id);
                if (p && p.wt) {
                  playerCache.set(targetPlayer.id, targetPlayer);
                }

                // Audit log
                log.info(
                  `[PERMISSION_AUDIT] ${currentPlayer.username} (${currentPlayer.id}) cleared all permissions for ${targetPlayer.username}`
                );

                const notifyData = {
                  message: `Permissions cleared for ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)}`,
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
              case "LIST": {
                const response =
                  ((await permissions.get(targetPlayer.username)) as string) ||
                  "No permissions found";
                const notifyData = {
                  message: `Permissions for ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)}: ${response.replaceAll(
                    ",",
                    ", "
                  )}`,
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
            }
            break;
          }
          case "RELOADMAP": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.reloadmap" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const mapName = args[0]?.toLowerCase() || null;
            if (!mapName) {
              const notifyData = {
                message: "Please provide a map name",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const map = (maps as any[]).find(
              (m) => m.name === `${mapName}.json`
            );
            if (!map) {
              const notifyData = {
                message: `Map ${mapName} not found`,
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const result = (await reloadMap(mapName)) as MapData | null;
            if (result) {
              const notifyData = {
                message: `Map ${mapName} reloaded successfully`,
              };
              sendPacket(wt, packetManager.notify(notifyData));

              map.compressed = result.compressed;
              map.data = result.data;

              const playersInMap = filterPlayersByMap(mapName);

              playersInMap.forEach((player) => {
                const mapMetadata = constructMapMetadata(
                  mapName,
                  player.location.position?.x || 0,
                  player.location.position?.y || 0,
                  player.location.position?.direction || "down",
                  maps,
                  mapPropertiesCache
                );
                sendPacket(player.wt, packetManager.loadMap(mapMetadata));
              });
            } else {
              log.error(`Failed to reload map ${mapName}`);
              const notifyData = {
                message: `Failed to reload map ${mapName}`,
              };
              sendPacket(wt, packetManager.notify(notifyData));
            }
            break;
          }
          case "WARP": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.warp" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const currentMapName = currentPlayer.location.map;

            const mapName = args[0]?.toLowerCase() || null;
            if (!mapName) {
              const notifyData = {
                message: "Please provide a map name",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (mapName === currentMapName) {
              const notifyData = {
                message: "You are already in this map",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const map = (maps as any[]).find(
              (map: MapData) => map.name === `${mapName}.json`
            );

            if (!map) {
              const notifyData = {
                message: "Map not found",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const identifier = args[1]?.toLowerCase() || null;

            if (!identifier) {

              const mapProps = mapPropertiesCache.find((m: any) => m.name === `${mapName}.json`);
              const centerX = mapProps
                ? (mapProps.width * mapProps.tileWidth) / 2
                : 0;
              const centerY = mapProps
                ? (mapProps.height * mapProps.tileHeight) / 2
                : 0;

              const result = await player.setLocation(
                currentPlayer.id,
                mapName,
                {
                  x: centerX,
                  y: centerY,
                  direction: currentPlayer.location.position?.direction || "down",
                }
              );

              if (
                result &&
                typeof result === "object" &&
                "affectedRows" in result &&
                (result as { affectedRows: number }).affectedRows != 0
              ) {
                await transitionPlayerToMap(
                  currentPlayer,
                  mapName,
                  {
                    x: centerX,
                    y: centerY,
                    direction: currentPlayer.location.position?.direction || "down",
                  },
                  wt,
                  spawnBatchQueue,
                  despawnBatchQueue
                );
              } else {
                const notifyData = {
                  message: "Failed to update location",
                };
                sendPacket(wt, packetManager.notify(notifyData));
            }
            listener.emit(Events.GUILD_CHANGED, { type: "join", guildId: currentPlayer.guild_id, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username });
            break;
        }
        listener.emit(Events.PLAYER_DISCONNECT, { player: currentPlayer });

        break;
          }
          case "WEATHER": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.weather" || p === "admin.*"
              )
            ) {
              sendPacket(
                wt,
                packetManager.notify({ message: "You don't have permission to use this command" })
              );
              break;
            }

            const weatherName = args[0]?.toLowerCase() || null;
            if (!weatherName) {
              sendPacket(
                wt,
                packetManager.notify({ message: "Usage: /weather <weather_name|clear|random>" })
              );
              break;
            }

            if (weatherName !== "clear" && weatherName !== "random") {
              const allWeathers = await assetCache.get("weather") as WeatherData[];
              if (!allWeathers?.find((w: WeatherData) => w.name === weatherName)) {
                sendPacket(
                  wt,
                  packetManager.notify({ message: `Weather '${weatherName}' not found` })
                );
                break;
              }
            }

            const currentMapName = currentPlayer.location.map;

            const existingWorld = worldsCache.find((w) => w.name === currentMapName);
            await worlds.update({ name: currentMapName, weather: weatherName, players: existingWorld?.players || 0 });

            if (existingWorld) {
              existingWorld.weather = weatherName;
            }

            resolvedWeatherCache.delete(currentMapName);

            let weatherData = null;
            let resolvedWeatherName = weatherName;
            if (weatherName === "random") {
              const allWeathers = await assetCache.get("weather") as WeatherData[];
              if (allWeathers?.length) {
                const randomWeather = allWeathers[Math.floor(Math.random() * allWeathers.length)];
                weatherData = randomWeather;
                resolvedWeatherName = randomWeather.name;
                resolvedWeatherCache.set(currentMapName, { weather: resolvedWeatherName, weatherData: randomWeather });
              } else {
                resolvedWeatherName = "clear";
              }
            } else if (weatherName !== "clear") {
              const allWeathers = await assetCache.get("weather") as WeatherData[];
              weatherData = allWeathers?.find((w: WeatherData) => w.name === weatherName) || null;
            }

            const playerIds = mapIndex.getPlayersOnMap(currentMapName);
            for (const playerId of playerIds) {
              const player = playerCache.get(playerId);
              if (player?.wt && player.wt.readyState === 1) {
                sendPacket(
                  player.wt,
                  packetManager.changeWeather({ weather: resolvedWeatherName, weatherData })
                );
              }
            }

            sendPacket(
              wt,
              packetManager.notify({ message: `Weather changed to '${weatherName}' for world '${currentMapName}'` })
            );
            break;
          }
          case "GIVE": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.items" || p === "admin.*"
              )
            ) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }

            const targetIdentifier = args[0]?.toLowerCase() || null;
            const itemName = args[1] || null;
            const quantity = parseInt(args[2]) || 1;

            if (!targetIdentifier || !itemName) {
              sendPacket(wt, packetManager.notify({ message: "Usage: /give <user> <item> <amount>" }));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(targetIdentifier))) {
              const players = Object.values(playerCache.list());
              targetPlayer = players.find((p: any) => p.username.toLowerCase() === targetIdentifier.toLowerCase());
            } else {
              targetPlayer = playerCache.get(targetIdentifier);
            }

            if (!targetPlayer) {
              const dbPlayer = await player.findPlayerInDatabase(targetIdentifier, undefined) as { username: string }[];
              targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
            }

            if (!targetPlayer) {
              sendPacket(wt, packetManager.notify({ message: "Player not found" }));
              break;
            }

            const targetName = targetPlayer.username;

            const items = await assetCache.get("items") as Item[];
            const itemDef = Array.isArray(items) ? items.find((i: any) => i.name.toLowerCase() === itemName.toLowerCase()) : null;
            if (!itemDef) {
              sendPacket(wt, packetManager.notify({ message: `Item '${itemName}' does not exist` }));
              break;
            }

            await inventory.add(targetName, { name: itemDef.name, quantity });

            const cachedTarget = playerCache.get(targetPlayer.id);
            if (cachedTarget) {
              if (!Array.isArray(cachedTarget.inventory)) cachedTarget.inventory = [];
              const existing = cachedTarget.inventory.find((i: any) => i.name.toLowerCase() === itemDef.name.toLowerCase());
              if (existing) {
                existing.quantity += quantity;
                if (cachedTarget.wt) {
                  sendPacket(cachedTarget.wt, packetManager.addInventoryItem(existing));
                  sendPacket(cachedTarget.wt, packetManager.notify({ message: `You received ${quantity}x ${itemDef.name}` }));
                }
              } else {
                const newItem = {
                  name: itemDef.name,
                  quantity,
                  equipped: false,
                  slot: null,
                  bag_slot: null,
                  type: itemDef?.type || '',
                  quality: itemDef?.quality || 'common',
                  iconUrl: getIconUrl(itemDef?.icon),
                  equipment_slot: itemDef?.equipment_slot || null,
                  bag_slots: itemDef?.bag_slots ?? null,
                  stat_health: itemDef?.stat_health ?? null,
                  stat_stamina: itemDef?.stat_stamina ?? null,
                  stat_armor: itemDef?.stat_armor ?? null,
                  stat_damage: itemDef?.stat_damage ?? null,
                  stat_critical_chance: itemDef?.stat_critical_chance ?? null,
                  stat_critical_damage: itemDef?.stat_critical_damage ?? null,
                  stat_avoidance: itemDef?.stat_avoidance ?? null,
                  level_requirement: itemDef?.level_requirement ?? null,
                  description: itemDef?.description || '',
                };
                cachedTarget.inventory.push(newItem);
                if (cachedTarget.wt) {
                  sendPacket(cachedTarget.wt, packetManager.addInventoryItem(newItem));
                  sendPacket(cachedTarget.wt, packetManager.notify({ message: `You received ${quantity}x ${itemDef.name}` }));
                }
              }
              playerCache.set(cachedTarget.id, cachedTarget);
            }

            sendPacket(wt, packetManager.notify({ message: `Gave ${quantity}x ${itemDef.name} to ${targetName}` }));
            break;
          }
          case "DROP": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.items" || p === "admin.*"
              )
            ) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }

            const dropItem = args[0] || null;
            const dropQty = Math.min(parseInt(args[1]) || 1, 9999);

            if (!dropItem) {
              sendPacket(wt, packetManager.notify({ message: "Usage: /drop <item> [amount]" }));
              break;
            }

            const dropItems = await assetCache.get("items") as Item[];
            const dropDef = Array.isArray(dropItems) ? dropItems.find((i: any) => i.name.toLowerCase() === dropItem.toLowerCase()) : null;
            if (!dropDef) {
              sendPacket(wt, packetManager.notify({ message: `Item '${dropItem}' does not exist` }));
              break;
            }

            const iconUrl = getIconUrl(dropDef.icon) || "";
            const quality = dropDef.quality || "common";
            const spawnedLoot = loot.create(currentPlayer, dropDef.name, dropQty, iconUrl, quality);

            const spawnData = {
              id: spawnedLoot.id,
              item: spawnedLoot.item,
              quantity: spawnedLoot.quantity,
              quality: spawnedLoot.quality,
              iconUrl: spawnedLoot.iconUrl,
              x: spawnedLoot.x,
              y: spawnedLoot.y,
              ownerId: spawnedLoot.ownerId,
              ownerName: spawnedLoot.ownerName,
            };
            const playerIds = mapIndex.getPlayersOnMap(spawnedLoot.map);
            for (const playerId of playerIds) {
              const p = playerCache.get(playerId);
              if (p?.wt && p.wt.readyState === 1) {
                sendPacket(p.wt, packetManager.lootSpawn(spawnData));
              }
            }

            sendPacket(wt, packetManager.notify({ message: `Dropped ${dropQty}x ${dropDef.name}.` }));
            break;
          }
          case "SPAWNCHEST": {
            if (!currentPlayer.permissions.some((p: string) => p === "admin.items" || p === "admin.*")) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            const mode = args[0]?.toLowerCase() || null;
            if (!mode || (mode !== "table" && mode !== "inline")) {
              sendPacket(wt, packetManager.notify({ message: "Usage: /spawnchest table <loot_table_id> or /spawnchest inline <item> <min> <max> <chance> ..." }));
              break;
            }
            const playerPos = typeof currentPlayer.location.position === 'string'
              ? { x: Number(currentPlayer.location.position.split(',')[0]), y: Number(currentPlayer.location.position.split(',')[1]) }
              : (currentPlayer.location.position as any);
            if (mode === "table") {
              const tableId = parseInt(args[1]);
              if (!tableId || isNaN(tableId)) { sendPacket(wt, packetManager.notify({ message: "Usage: /spawnchest table <loot_table_id>" })); break; }
              const table = await lootTable.get(tableId);
              if (!table) { sendPacket(wt, packetManager.notify({ message: `Loot table ${tableId} not found.` })); break; }
              const chestId = lootChest.spawn(currentPlayer.location.map, playerPos.x, playerPos.y, tableId, undefined, currentPlayer.username);
              const chestData = { id: chestId, x: playerPos.x, y: playerPos.y, iconUrl: getIconUrl("loot_chest"), map: currentPlayer.location.map };
              const playerIds = mapIndex.getPlayersOnMap(currentPlayer.location.map);
              for (const pid of playerIds) { const p = playerCache.get(pid); if (p?.wt && p.wt.readyState === 1) { sendPacket(p.wt, packetManager.lootChestSpawn(chestData)); } }
              sendPacket(wt, packetManager.notify({ message: `Loot chest spawned using table "${table.name}".` }));
            } else {
              const itemArgs = args.slice(1);
              if (itemArgs.length < 4 || itemArgs.length % 4 !== 0) {
                sendPacket(wt, packetManager.notify({ message: "Usage: /spawnchest inline <item> <min> <max> <chance> ..." }));
                break;
              }
              const inlineEntries: any[] = [];
              for (let i = 0; i < itemArgs.length; i += 4) {
                const itemName = itemArgs[i]; const minQty = parseInt(itemArgs[i + 1]); const maxQty = parseInt(itemArgs[i + 2]); const chance = parseFloat(itemArgs[i + 3]);
                if (!itemName || isNaN(minQty) || isNaN(maxQty) || isNaN(chance)) { sendPacket(wt, packetManager.notify({ message: `Invalid entry at position ${i}` })); break; }
                inlineEntries.push({ itemName, minQuantity: minQty, maxQuantity: maxQty, dropChance: chance, quality: "common" });
              }
              if (inlineEntries.length === 0) break;
              const chestId = lootChest.spawn(currentPlayer.location.map, playerPos.x, playerPos.y, undefined, inlineEntries, currentPlayer.username);
              const chestData = { id: chestId, x: playerPos.x, y: playerPos.y, iconUrl: getIconUrl("loot_chest"), map: currentPlayer.location.map };
              const playerIds = mapIndex.getPlayersOnMap(currentPlayer.location.map);
              for (const pid of playerIds) { const p = playerCache.get(pid); if (p?.wt && p.wt.readyState === 1) { sendPacket(p.wt, packetManager.lootChestSpawn(chestData)); } }
              sendPacket(wt, packetManager.notify({ message: `Loot chest spawned with ${inlineEntries.length} inline entries.` }));
            }
            break;
          }
          case "LOOTTABLE": {
            if (!currentPlayer.permissions.some((p: string) => p === "admin.loot" || p === "admin.*")) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            const sub = args[0]?.toLowerCase() || null;
            if (!sub) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable list|create|delete|info|additem|removeitem ..." })); break; }
            if (sub === "list") {
              const tables = await lootTable.list();
              const names = tables.length ? tables.map((t: any) => `#${t.id} ${t.name} (${t.items.length} items)`).join(", ") : "No loot tables found.";
              sendPacket(wt, packetManager.notify({ message: `Loot tables: ${names}` }));
            } else if (sub === "create") {
              const name = args[1]; if (!name) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable create <name>" })); break; }
              const r = await lootTable.create(name);
              sendPacket(wt, packetManager.notify({ message: r ? `Loot table "${name}" created.` : `Table "${name}" already exists.` }));
            } else if (sub === "delete") {
              const id = parseInt(args[1]); if (!id || isNaN(id)) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable delete <id>" })); break; }
              await lootTable.delete(id); sendPacket(wt, packetManager.notify({ message: `Loot table ${id} deleted.` }));
            } else if (sub === "info") {
              const id = parseInt(args[1]); if (!id || isNaN(id)) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable info <id>" })); break; }
              const table = await lootTable.get(id);
              if (!table) { sendPacket(wt, packetManager.notify({ message: `Loot table ${id} not found.` })); break; }
              const lines = table.items.map((it: any) => `  #${it.id} ${it.item_name} (${it.min_quantity}-${it.max_quantity}, ${it.drop_chance}%, ${it.quality})`).join("\n");
              sendPacket(wt, packetManager.notify({ message: `Table #${table.id} "${table.name}":\n${lines || "  (no items)"}` }));
            } else if (sub === "additem") {
              const tableId = parseInt(args[1]); const itemName = args[2];
              const minQty = parseInt(args[3]) || 1; const maxQty = parseInt(args[4]) || 1;
              const chance = parseFloat(args[5]) || 100; const quality = args[6] || "common";
              if (!tableId || isNaN(tableId) || !itemName) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable additem <tableId> <item> <min> <max> <chance> [quality]" })); break; }
              const r = await lootTable.addItem(tableId, itemName, minQty, maxQty, chance, quality);
              if (r && (r as any).error) { sendPacket(wt, packetManager.notify({ message: (r as any).error })); break; }
              sendPacket(wt, packetManager.notify({ message: `Added "${itemName}" to loot table ${tableId}.` }));
            } else if (sub === "removeitem") {
              const itemId = parseInt(args[1]); if (!itemId || isNaN(itemId)) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable removeitem <itemId>" })); break; }
              await lootTable.removeItem(itemId); sendPacket(wt, packetManager.notify({ message: `Item ${itemId} removed from loot table.` }));
            } else if (sub === "updateitem") {
              const itemId = parseInt(args[1]); const minQty = parseInt(args[2]) || 1; const maxQty = parseInt(args[3]) || 1;
              const chance = parseFloat(args[4]) || 100; const quality = args[5] || "common";
              if (!itemId || isNaN(itemId)) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable updateitem <itemId> <min> <max> <chance> [quality]" })); break; }
              await lootTable.updateItem(itemId, minQty, maxQty, chance, quality);
              sendPacket(wt, packetManager.notify({ message: `Item ${itemId} updated.` }));
            } else { sendPacket(wt, packetManager.notify({ message: "Unknown sub-command. Use: list|create|delete|info|additem|removeitem|updateitem" })); }
            break;
          }
          case "LE":
          case "LOOTEDITOR": {
            if (!currentPlayer.permissions.some((p: string) => p === "admin.loot" || p === "admin.*")) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleLootEditor());
            break;
          }
          default: {
            const notifyData = {
              message: "Invalid command",
            };
            sendPacket(wt, packetManager.notify(notifyData));
            break;
          }
        }
        break;
      }
      case "KICK_PARTY_MEMBER": {
        if (!currentPlayer) return;

        const partyId = await parties.getPartyId(currentPlayer.username);
        if (!partyId) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const isLeader = await parties.isPartyLeader(currentPlayer.username);
        if (!isLeader) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You are not the party leader" })
          );
          return;
        }

        const member = (data as any)?.username;
        if (!member) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Please provide a username" })
          );
          return;
        }

        const members = await parties.getPartyMembers(partyId);
        if (!members || members?.length === 0) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        if (!members.includes(member)) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${member.charAt(0).toUpperCase() + member.slice(1)
                } is not in your party`,
            })
          );
          return;
        }

        const result = await parties.remove(member);

        if (typeof result === "boolean" && !result) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `Failed to kick ${member.charAt(0).toUpperCase() + member.slice(1)
                } from the party`,
            })
          );
          return;
        }

        if (typeof result === "boolean" && result) {

          members.forEach(async (m: string) => {
            const session_id = await player.getSessionIdByUsername(m);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              sendPacket(p.wt, packetManager.updateParty({ members: [] }));
              sendPacket(
                p.wt,
                packetManager.notify({
                  message: "The party has been disbanded",
                })
              );
              p.party = [];
              playerCache.set(p.id, p);
            }
          });
          listener.emit(Events.PARTY_CHANGED, { type: "disband", members });
          return;
        }

        if (Array.isArray(result) && result.length > 0) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${member.charAt(0).toUpperCase() + member.slice(1)
                } has been kicked from the party`,
            })
          );
          currentPlayer.party = [];
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(wt, packetManager.updateParty({ members: [] }));

          result.forEach(async (m: string) => {
            const session_id = await player.getSessionIdByUsername(m);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              if (m !== member) {
                sendPacket(
                  p.wt,
                  packetManager.updateParty({ members: result })
                );
                sendPacket(
                  p.wt,
                  packetManager.notify({
                    message: `${currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1)
                      } has kicked ${member.charAt(0).toUpperCase() + member.slice(1)
                      } from the party`,
                  })
                );
                p.party = result;
              } else {
                sendPacket(p.wt, packetManager.updateParty({ members: [] }));
                sendPacket(
                  p.wt,
                  packetManager.notify({
                    message: `You have been kicked from the party`,
                  })
                );
                p.party = [];
              }
              playerCache.set(p.id, p);
            }
          });

          const partyLeader = await parties.getPartyLeader(currentPlayer.party_id as number);
          if (partyLeader && result.length > 0) {
            await syncPartyLayers(partyLeader, result, playerCache, sendAnimationTo);
          }

          const kickedSessionId = await player.getSessionIdByUsername(member);
          const kickedPlayer = kickedSessionId && playerCache.get(kickedSessionId);
          if (kickedPlayer) {
            listener.emit(Events.PARTY_CHANGED, { type: "kick", username: currentPlayer.username, kickedUsername: member, members: [member] });
          }
        }

        break;
      }
      case "LEAVE_PARTY": {
        if (!currentPlayer) return;

        const partyId = await parties.getPartyId(currentPlayer.username);
        if (!partyId) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const members = await parties.getPartyMembers(partyId);
        if (!members || members?.length === 0) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const result = await parties.leave(currentPlayer.username);

        const type = typeof result;
        if (type === "boolean" && !result) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Failed to leave party" })
          );
          return;
        }

        if (type === "boolean" && result) {
          members.forEach(async (member: string) => {
            const session_id = await player.getSessionIdByUsername(member);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              sendPacket(p.wt, packetManager.updateParty({ members: [] }));
              sendPacket(
                p.wt,
                packetManager.notify({
                  message: "The party has been disbanded",
                })
              );
              p.party = [];
              playerCache.set(p.id, p);
            }
          });
          listener.emit(Events.PARTY_CHANGED, { type: "disband", members });
          if (currentPlayer.isVanished) {
            for (const member of members) {
              const session_id = await player.getSessionIdByUsername(member);
              const pm = session_id && playerCache.get(session_id);
              if (pm && pm.wt && pm.id !== currentPlayer.id) sendPacket(pm.wt, packetManager.despawnPlayer(currentPlayer.id));
            }
          }
          return;
        }

        if (type === "object" && (result as string[]).length > 0) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You have left the party" })
          );
          currentPlayer.party = [];
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(wt, packetManager.updateParty({ members: [] }));
          listener.emit(Events.PARTY_CHANGED, { type: "leave", username: currentPlayer.username, members: [currentPlayer.username] });

          (result as string[]).forEach(async (member: string) => {
            const session_id = await player.getSessionIdByUsername(member);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              sendPacket(p.wt, packetManager.updateParty({ members: result }));
              sendPacket(
                p.wt,
                packetManager.notify({
                  message: `${currentPlayer.username.charAt(0).toUpperCase() +
                    currentPlayer.username.slice(1)
                    } has left the party`,
                })
              );
              p.party = result;
              playerCache.set(p.id, p);
            }
          });

          if ((result as string[]).length > 0) {
            const remainingPartyId = await parties.getPartyId((result as string[])[0]);
            if (remainingPartyId) {
              const partyLeader = await parties.getPartyLeader(remainingPartyId);
              if (partyLeader) {
                await syncPartyLayers(partyLeader, result as string[], playerCache, sendAnimationTo);
              }
            }
          }
          // Vanish: former party members can no longer see the vanished player
          if (currentPlayer.isVanished) {
            for (const member of (result as string[])) {
              const session_id = await player.getSessionIdByUsername(member);
              const pm = session_id && playerCache.get(session_id);
              if (pm && pm.wt && pm.id !== currentPlayer.id) sendPacket(pm.wt, packetManager.despawnPlayer(currentPlayer.id));
            }
          }
        }
        break;
      }
      case "DISBAND_GUILD": {
        if (!currentPlayer) return;

        const guildId = currentPlayer.guild_id;
        if (!guildId) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        const isLeader = await guilds.isGuildLeader(currentPlayer.username);
        if (!isLeader) {
          sendPacket(wt, packetManager.notify({ message: "You are not the guild leader" }));
          return;
        }

        const members = await guilds.getGuildMembers(guildId);
        if (!members || members.length === 0) {
          sendPacket(wt, packetManager.notify({ message: "Your guild has no members" }));
          return;
        }

        for (const member of members) {
          const session_id = await player.getSessionIdByUsername(member);
          const p = session_id && playerCache.get(session_id);
          if (p) {
            sendPacket(p.wt, packetManager.updateGuild({ members: [] }));
            if (p.id !== currentPlayer.id) {
              sendPacket(p.wt, packetManager.notify({ message: "The guild has been disbanded" }));
            }
            p.guild_id = null;
            p.guild = [];
            p.guild_name = null;
            playerCache.set(p.id, p);
            broadcastPlayerUpdate(p);
          }
        }

        await guilds.disband(currentPlayer.username);
        listener.emit(Events.GUILD_CHANGED, { type: "disband", guildId, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username });

        break;
      }
      case "LEAVE_GUILD": {
        if (!currentPlayer) return;

        const guildId = currentPlayer.guild_id;
        if (!guildId) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        const isLeader = await guilds.isGuildLeader(currentPlayer.username);
        if (isLeader) {
          sendPacket(wt, packetManager.notify({ message: "You cannot leave your own guild." }));
          return;
        }

        const members = await guilds.getGuildMembers(guildId);
        if (!members || members.length === 0) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        const result = await guilds.leave(currentPlayer.username);

        if (typeof result === "boolean" && !result) {
          sendPacket(wt, packetManager.notify({ message: "Failed to leave guild" }));
          return;
        }

        listener.emit(Events.GUILD_CHANGED, { type: "leave", guildId, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username });

        currentPlayer.guild_id = null;
        currentPlayer.guild = [];
        currentPlayer.guild_name = null;
        playerCache.set(currentPlayer.id, currentPlayer);

        broadcastPlayerUpdate(currentPlayer);
        sendPacket(wt, packetManager.updateGuild({ members: [] }));

        if (Array.isArray(result) && result.length > 0) {
          for (const member of result) {
            const session_id = await player.getSessionIdByUsername(member);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              if (p.id !== currentPlayer.id) {
                sendPacket(p.wt, packetManager.updateGuild({ members: result, guild_name: currentPlayer.guild_name || await guilds.getGuildName(guildId) }));
              }
            }
          }
        }

        break;
      }
      case "KICK_GUILD_MEMBER": {
        if (!currentPlayer) return;

        const guildId = currentPlayer.guild_id;
        if (!guildId) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        const isLeader = await guilds.isGuildLeader(currentPlayer.username);
        if (!isLeader) {
          sendPacket(wt, packetManager.notify({ message: "You are not the guild leader" }));
          return;
        }

        const memberUsername = (data as any)?.username;
        if (!memberUsername) {
          sendPacket(wt, packetManager.notify({ message: "Please provide a username" }));
          return;
        }

        const members = await guilds.getGuildMembers(guildId);
        if (!members || members.length === 0) {
          sendPacket(wt, packetManager.notify({ message: "Your guild has no members" }));
          return;
        }

        if (!members.includes(memberUsername)) {
          sendPacket(wt, packetManager.notify({
            message: `${memberUsername} is not in your guild`,
          }));
          return;
        }

        if (memberUsername.toLowerCase() === currentPlayer.username.toLowerCase()) {
          sendPacket(wt, packetManager.notify({ message: "You cannot kick yourself." }));
          return;
        }

        const result = await guilds.remove(memberUsername);

        if (typeof result === "boolean" && !result) {
          sendPacket(wt, packetManager.notify({ message: `Failed to kick ${memberUsername} from the guild` }));
          return;
        }

        sendPacket(wt, packetManager.notify({ message: `${memberUsername} has been kicked from the guild` }));

        if (Array.isArray(result) && result.length > 0) {
          for (const member of result) {
            const session_id = await player.getSessionIdByUsername(member);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              sendPacket(p.wt, packetManager.updateGuild({ members: result, guild_name: currentPlayer.guild_name }));
              p.guild = result;
              playerCache.set(p.id, p);
            }
          }
        }

        const kickedSessionId = await player.getSessionIdByUsername(memberUsername);
        const kickedPlayer = kickedSessionId && playerCache.get(kickedSessionId);
        if (kickedPlayer) {
          sendPacket(kickedPlayer.wt, packetManager.updateGuild({ members: [] }));
          sendPacket(kickedPlayer.wt, packetManager.notify({ message: "You have been kicked from the guild" }));
          kickedPlayer.guild_id = null;
          kickedPlayer.guild = [];
          kickedPlayer.guild_name = null;
          playerCache.set(kickedPlayer.id, kickedPlayer);
        }
        listener.emit(Events.GUILD_CHANGED, { type: "kick", guildId, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username, kickedUsername: memberUsername });

        break;
      }
      case "CREATE_GUILD": {
        if (!currentPlayer) return;
        if (currentPlayer.isGuest) {
          sendPacket(wt, packetManager.notify({ message: "Please create an account to use that feature." }));
          return;
        }

        const guildName = (data as any)?.name;
        if (!guildName || !guildName.trim()) {
          sendPacket(wt, packetManager.notify({ message: "Please provide a guild name" }));
          return;
        }

        const alreadyInGuild = await guilds.isInGuild(currentPlayer.username);
        if (alreadyInGuild) {
          sendPacket(wt, packetManager.notify({ message: "You are already in a guild" }));
          return;
        }

        const nameExists = await guilds.exists(guildName.trim());
        if (nameExists) {
          sendPacket(wt, packetManager.notify({ message: "A guild with that name already exists" }));
          return;
        }

        const result = await guilds.create(currentPlayer.username.toLowerCase(), guildName.trim());
        if (!result) {
          sendPacket(wt, packetManager.notify({ message: "Failed to create guild" }));
          return;
        }

        const guildId = await guilds.getGuildId(currentPlayer.username);
        currentPlayer.guild_id = guildId;
        currentPlayer.guild = result as string[];
        currentPlayer.guild_name = guildName.trim();
        playerCache.set(currentPlayer.id, currentPlayer);

        broadcastPlayerUpdate(currentPlayer);
        sendPacket(wt, packetManager.updateGuild({ members: result, guild_name: guildName.trim() }));
        sendPacket(wt, packetManager.notify({ message: `Guild "${guildName.trim()}" created successfully` }));
        listener.emit(Events.GUILD_CHANGED, { type: "create", guildId: currentPlayer.guild_id, guildName: guildName.trim(), playerUsername: currentPlayer.username });
        break;
      }
      case "INVITE_GUILD": {
        const invited_user = (data as any).id;
        const invitedUser = playerCache.get(invited_user);
        const invitedUserUsername = invitedUser?.username || invited_user;
        if (!currentPlayer || !invited_user || !invitedUserUsername) return;

        if (currentPlayer.isGuest) {
          sendPacket(wt, packetManager.notify({ message: "Please create an account to use that feature." }));
          return;
        }

        if (invitedUser.isGuest) {
          sendPacket(wt, packetManager.notify({
            message: `${invitedUserUsername.charAt(0).toUpperCase() + invitedUserUsername.slice(1)} is a guest and cannot join a guild.`,
          }));
          return;
        }

        const guildId = currentPlayer.guild_id;
        if (!guildId) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        const isLeader = await guilds.isGuildLeader(currentPlayer.username);
        if (!isLeader) {
          sendPacket(wt, packetManager.notify({ message: "You are not the guild leader" }));
          return;
        }

        const invitedUserInGuild = await guilds.isInGuild(invitedUserUsername);
        if (invitedUserInGuild) {
          sendPacket(wt, packetManager.notify({
            message: `${invitedUserUsername.charAt(0).toUpperCase() + invitedUserUsername.slice(1)} is already in a guild`,
          }));
          return;
        }

        const player_username =
          currentPlayer.username.charAt(0).toUpperCase() +
          currentPlayer.username.slice(1);

        const guildName = currentPlayer.guild_name || "Unknown Guild";

        const invite_data = {
          action: "INVITE_GUILD",
          message: `${player_username} wants to invite you to join "${guildName}"`,
          originator: currentPlayer.id.toString(),
          authorization: randomBytes(16).toString(),
        };

        currentPlayer.invitations.push({
          action: invite_data.action,
          originator: invite_data.originator,
          authorization: invite_data.authorization,
        });

        playerCache.set(currentPlayer.id, currentPlayer);

        sendPacket(invitedUser.wt, packetManager.invitation(invite_data));
        sendPacket(
          wt,
          packetManager.notify({
            message: `Invitation sent to ${invitedUserUsername.charAt(0).toUpperCase() + invitedUserUsername.slice(1)}`,
          })
        );
        break;
      }
      case "GUILD_CHAT": {
        if (!currentPlayer) return;

        const { message } = data as any;
        if (!message) return;

        const guildId = currentPlayer.guild_id;
        if (!guildId) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        const guildMembers = await guilds.getGuildMembers(guildId);
        if (!guildMembers || guildMembers.length === 0) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        for (const member of guildMembers) {
          const session_id = await player.getSessionIdByUsername(member);
          const memberPlayer = playerCache.get(session_id);
          if (memberPlayer) {
            sendPacket(
              memberPlayer.wt,
              packetManager.guildChat({
                id: wt.data.id,
                message,
                username:
                  currentPlayer.username.charAt(0).toUpperCase() +
                  currentPlayer.username.slice(1),
              })
            );
          }
        }

        listener.emit(Events.GUILD_CHAT, { player: currentPlayer, message, guildMembers, guildId } as any);
        break;
      }
      case "INVITE_PARTY": {
        const invited_user = (data as any).id;
        const invitedUser = playerCache.get(invited_user);
        const invitedUserUsername = invitedUser?.username || invited_user;
        if (!currentPlayer || !invited_user || !invitedUserUsername) return;

        if (currentPlayer.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }

        if (invitedUser.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is a guest and cannot be invited to a party.`,
            })
          );
          return;
        }

        const partyId = await parties.getPartyId(currentPlayer.username);
        if (partyId) {

          const isLeader = await parties.isPartyLeader(currentPlayer.username);
          if (!isLeader) {
            sendPacket(
              wt,
              packetManager.notify({ message: "You are not the party leader" })
            );
            return;
          }
        }

        const invitedUserPartyId = await parties.getPartyId(
          invitedUserUsername
        );

        if (invitedUserPartyId) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is already in a party`,
            })
          );
          return;
        }

        const invitedUserLeader = await parties.isPartyLeader(
          invitedUserUsername
        );
        if (invitedUserLeader) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is already in a party`,
            })
          );
          return;
        }

        const player_username =
          currentPlayer.username.charAt(0).toUpperCase() +
          currentPlayer.username.slice(1);

        const invite_data = {
          action: "INVITE_PARTY",
          message: `${player_username} wants to invite you to their party`,
          originator: currentPlayer.id.toString(),
          authorization: randomBytes(16).toString(),
        };

        if (!invitedUser) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is not online`,
            })
          );
          return;
        }

        currentPlayer.invitations.push({
          action: invite_data.action,
          originator: invite_data.originator,
          authorization: invite_data.authorization,
        });

        playerCache.set(currentPlayer.id, currentPlayer);

        sendPacket(invitedUser.wt, packetManager.invitation(invite_data));
        sendPacket(
          wt,
          packetManager.notify({
            message: `Invitation sent to ${invitedUserUsername.charAt(0).toUpperCase() +
              invitedUserUsername.slice(1)
              }`,
          })
        );
        listener.emit(Events.PARTY_INVITE, { inviterUsername: currentPlayer.username, invitedUsername: invitedUserUsername });
        break;
      }
      case "ADD_FRIEND": {
        const id = (data as any).id;
        if (!id) return;

        if (!currentPlayer) return;

        if (currentPlayer.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }

        const get_friend = playerCache.get(id);
        if (!get_friend) return;

        if (get_friend.id === currentPlayer.id || get_friend.username.toLowerCase() === currentPlayer.username.toLowerCase()) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "You cannot add yourself as a friend.",
            })
          );
          return;
        }

        const player_username =
          currentPlayer.username.charAt(0).toUpperCase() +
          currentPlayer.username.slice(1);

        if (get_friend.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${get_friend.username.charAt(0).toUpperCase() +
                get_friend.username.slice(1)
                } is a guest and cannot be added as a friend.`,
            })
          );
          return;
        }

        const invite_data = {
          action: "FRIEND_REQUEST",
          message: `${player_username} wants to add you as a friend`,
          originator: currentPlayer.id.toString(),
          authorization: randomBytes(16).toString(),
        };

        currentPlayer.invitations.push({
          action: invite_data.action,
          originator: invite_data.originator,
          authorization: invite_data.authorization,
        });

        playerCache.set(currentPlayer.id, currentPlayer);

        sendPacket(get_friend.wt, packetManager.invitation(invite_data));
        break;
      }
      case "INVITATION_RESPONSE": {
        const { action, originator, authorization, response } = data as any;
        if (!action || !originator || !authorization || !response) return;

        log.info(
          `Invitation response received: ${action}, ${originator}, ${authorization}, ${response}`
        );

        const inviter = playerCache.get(originator);

        if (!inviter) {

          sendPacket(
            wt,
            packetManager.notify({
              message:
                "Unable to process invitation - user not found or has disconnected",
            })
          );
          return;
        }

        const invitationByAuth = new Map<any, any>(inviter.invitations.map((inv: any) => [inv.authorization, inv]));
        const invite = invitationByAuth.get(authorization);

        if (!invite || invite.action !== action || invite.originator !== originator) {

          const notifyData = {
            message: "Invitation not found or has already been processed",
          };
          sendPacket(wt, packetManager.notify(notifyData));
          return;
        }

        inviter.invitations = inviter.invitations.filter((inv: any) => inv.authorization !== authorization);
        playerCache.set(inviter.id, inviter);

        switch (action.toUpperCase()) {

          case "FRIEND_REQUEST": {
            if (response.toUpperCase() === "ACCEPT") {

              const updatedCurrentPlayersFriendsList = await friends.add(
                currentPlayer.username.toLowerCase(),
                inviter.username.toLowerCase()
              );

              const updatedFriendsList = await friends.add(
                inviter.username.toLowerCase(),
                currentPlayer.username.toLowerCase()
              );

              sendPacket(
                wt,
                packetManager.notify({
                  message: `You are now friends with ${inviter.username.charAt(0).toUpperCase() +
                    inviter.username.slice(1)
                    }`,
                })
              );
              sendPacket(
                wt,
                packetManager.updateFriends({
                  friends: updatedCurrentPlayersFriendsList,
                })
              );

              sendPacket(
                inviter.wt,
                packetManager.notify({
                  message: `You are now friends with ${currentPlayer.username.charAt(0).toUpperCase() +
                    currentPlayer.username.slice(1)
                    }`,
                })
              );

              sendPacket(
                inviter.wt,
                packetManager.updateFriends({ friends: updatedFriendsList })
              );
            }
            listener.emit(Events.FRIEND_ADDED, { type: "add", playerUsername: currentPlayer.username, friendUsername: inviter.username });
            break;
          }
          case "INVITE_PARTY": {

            const partyId = await parties.getPartyId(inviter.username);
            let updatedPartyMembers: string[] | boolean = false;
            if (response.toUpperCase() === "ACCEPT") {

              if (partyId) {

                updatedPartyMembers = await parties.add(
                  currentPlayer.username.toLowerCase(),
                  partyId
                );
                if (!updatedPartyMembers) {
                  sendPacket(
                    wt,
                    packetManager.notify({ message: "Failed to join party" })
                  );
                  return;
                }
                sendPacket(
                  wt,
                  packetManager.notify({
                    message: `You have joined ${inviter.username.charAt(0).toUpperCase() +
                      inviter.username.slice(1)
                      }'s party`,
                  })
                );
                sendPacket(
                  inviter.wt,
                  packetManager.notify({
                    message: `${currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1)
                      } has joined your party`,
                  })
                );

                for (const member of (updatedPartyMembers as string[])) {
                  const session_id = await player.getSessionIdByUsername(member);
                  const p = session_id && playerCache.get(session_id);
                  if (p) {
                    sendPacket(p.wt, packetManager.updateParty({ members: updatedPartyMembers }));
                    p.party = updatedPartyMembers;
                    playerCache.set(p.id, p);
                  }
                }

                const partyLeader = await parties.getPartyLeader(partyId);
                if (partyLeader && updatedPartyMembers.length > 0) {
                  await syncPartyLayers(partyLeader, updatedPartyMembers as string[], playerCache, sendAnimationTo);
                }

                // Vanish: spawn all vanished party members to all other online party members
                for (const memberUsername of (updatedPartyMembers as string[])) {
                  const memberSessionId = await player.getSessionIdByUsername(memberUsername);
                  const memberPlayer = memberSessionId && playerCache.get(memberSessionId);
                  if (!memberPlayer || !memberPlayer.isVanished) continue;
                  const sd = queueSpawnPlayerPacket(memberPlayer);
                  if (!sd) continue;
                  const an = getAnimationNameForDirection(memberPlayer.location.position?.direction || "down", !!memberPlayer.moving, !!memberPlayer.mounted, memberPlayer.mount_type, !!memberPlayer.casting);
                  const ss = await getPlayerSpriteSheetData(an, memberPlayer.equipment || null);
                  const ms = memberPlayer.mount_type ? getMountSpriteUrl(memberPlayer.mount_type) : null;
                  if (ss?.bodySprite || ss?.headSprite || ms) {
                    (sd as any).spriteData = { mountSprite: ms, bodySprite: ss.bodySprite || null, headSprite: ss.headSprite || null, armorHelmetSprite: ss.armorHelmetSprite || null, armorShoulderguardsSprite: ss.armorShoulderguardsSprite || null, armorNeckSprite: ss.armorNeckSprite || null, armorHandsSprite: ss.armorHandsSprite || null, armorChestSprite: ss.armorChestSprite || null, armorFeetSprite: ss.armorFeetSprite || null, armorLegsSprite: ss.armorLegsSprite || null, armorWeaponSprite: ss.armorWeaponSprite || null, animationState: ss.animationState };
                  }
                  const fx = spellEffects.getEffectsPayload(memberPlayer);
                  if (fx.length > 0) (sd as any).effects = fx;
                  const receivers: any[] = [];
                  for (const otherUsername of (updatedPartyMembers as string[])) {
                    if (otherUsername.toLowerCase() === memberUsername.toLowerCase()) continue;
                    const otherSessionId = await player.getSessionIdByUsername(otherUsername);
                    const otherPlayer = otherSessionId && playerCache.get(otherSessionId);
                    if (otherPlayer && otherPlayer.wt) receivers.push(otherPlayer);
                  }
                  queueSpawnForReceivers(memberPlayer, receivers, (sd as any).spriteData);
                }
              } else {

                updatedPartyMembers = await parties.create(
                  inviter.username.toLowerCase(),
                  currentPlayer.username.toLowerCase()
                );
                if (!updatedPartyMembers) {
                  sendPacket(
                    wt,
                    packetManager.notify({ message: "Failed to create party" })
                  );
                  return;
                }
                sendPacket(
                  wt,
                  packetManager.notify({
                    message: `You have joined ${inviter.username.charAt(0).toUpperCase() +
                      inviter.username.slice(1)
                      }'s party`,
                  })
                );
                sendPacket(
                  inviter.wt,
                  packetManager.notify({
                    message: `${currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1)
                      } has joined your party`,
                  })
                );
                sendPacket(
                  inviter.wt,
                  packetManager.updateParty({ members: updatedPartyMembers })
                );
                sendPacket(
                  wt,
                  packetManager.updateParty({ members: updatedPartyMembers })
                );
                for (const member of (updatedPartyMembers as string[])) {
                  const session_id = await player.getSessionIdByUsername(member);
                  const p = session_id && playerCache.get(session_id);
                  if (p) {
                    sendPacket(p.wt, packetManager.updateParty({ members: updatedPartyMembers }));
                    p.party = updatedPartyMembers;
                    playerCache.set(p.id, p);
                  }
                }

                if (Array.isArray(updatedPartyMembers) && updatedPartyMembers.length > 0) {
                  await syncPartyLayers(inviter.username.toLowerCase(), updatedPartyMembers as string[], playerCache, sendAnimationTo);
                }

                // Vanish: spawn all vanished party members to all other online party members
                for (const memberUsername of (updatedPartyMembers as string[])) {
                  const memberSessionId = await player.getSessionIdByUsername(memberUsername);
                  const memberPlayer = memberSessionId && playerCache.get(memberSessionId);
                  if (!memberPlayer || !memberPlayer.isVanished) continue;
                  const sd = queueSpawnPlayerPacket(memberPlayer);
                  if (!sd) continue;
                  const an = getAnimationNameForDirection(memberPlayer.location.position?.direction || "down", !!memberPlayer.moving, !!memberPlayer.mounted, memberPlayer.mount_type, !!memberPlayer.casting);
                  const ss = await getPlayerSpriteSheetData(an, memberPlayer.equipment || null);
                  const ms = memberPlayer.mount_type ? getMountSpriteUrl(memberPlayer.mount_type) : null;
                  if (ss?.bodySprite || ss?.headSprite || ms) {
                    (sd as any).spriteData = { mountSprite: ms, bodySprite: ss.bodySprite || null, headSprite: ss.headSprite || null, armorHelmetSprite: ss.armorHelmetSprite || null, armorShoulderguardsSprite: ss.armorShoulderguardsSprite || null, armorNeckSprite: ss.armorNeckSprite || null, armorHandsSprite: ss.armorHandsSprite || null, armorChestSprite: ss.armorChestSprite || null, armorFeetSprite: ss.armorFeetSprite || null, armorLegsSprite: ss.armorLegsSprite || null, armorWeaponSprite: ss.armorWeaponSprite || null, animationState: ss.animationState };
                  }
                  const fx = spellEffects.getEffectsPayload(memberPlayer);
                  if (fx.length > 0) (sd as any).effects = fx;
                  const receivers: any[] = [];
                  for (const otherUsername of (updatedPartyMembers as string[])) {
                    if (otherUsername.toLowerCase() === memberUsername.toLowerCase()) continue;
                    const otherSessionId = await player.getSessionIdByUsername(otherUsername);
                    const otherPlayer = otherSessionId && playerCache.get(otherSessionId);
                    if (otherPlayer && otherPlayer.wt) receivers.push(otherPlayer);
                  }
                  queueSpawnForReceivers(memberPlayer, receivers, (sd as any).spriteData);
                }

              }
            }
            listener.emit(Events.PARTY_CHANGED, { type: "join", username: currentPlayer.username, members: updatedPartyMembers as string[] } as any);
            break;
          }
          case "INVITE_GUILD": {
            if (response.toUpperCase() === "ACCEPT") {

              const guildId = await guilds.getGuildId(inviter.username);
              if (!guildId) {
                sendPacket(wt, packetManager.notify({ message: "That guild no longer exists" }));
                return;
              }

              const isLeader = await guilds.isGuildLeader(inviter.username);
              if (!isLeader) {
                sendPacket(wt, packetManager.notify({ message: "The inviter is no longer the guild leader" }));
                return;
              }

              const targetInGuild = await guilds.isInGuild(currentPlayer.username);
              if (targetInGuild) {
                sendPacket(wt, packetManager.notify({ message: "You are already in a guild" }));
                return;
              }

              const updatedGuildMembers = await guilds.add(
                currentPlayer.username.toLowerCase(),
                guildId
              );
              if (!updatedGuildMembers || updatedGuildMembers.length === 0) {
                sendPacket(wt, packetManager.notify({ message: "Failed to join guild" }));
                return;
              }

              const guildName = await guilds.getGuildName(guildId);

              sendPacket(wt, packetManager.notify({
                message: `You have joined "${guildName}"`,
              }));
              sendPacket(inviter.wt, packetManager.notify({
                message: `${currentPlayer.username} has joined your guild`,
              }));

              currentPlayer.guild_id = guildId;
              currentPlayer.guild = updatedGuildMembers;
              currentPlayer.guild_name = guildName;
              playerCache.set(currentPlayer.id, currentPlayer);

              broadcastPlayerUpdate(currentPlayer);
              sendPacket(wt, packetManager.updateGuild({ members: updatedGuildMembers, guild_name: guildName }));

              for (const member of updatedGuildMembers) {
                const session_id = await player.getSessionIdByUsername(member);
                const p = session_id && playerCache.get(session_id);
                if (p && p.id !== currentPlayer.id) {
                  sendPacket(p.wt, packetManager.updateGuild({ members: updatedGuildMembers, guild_name: guildName }));
                  p.guild = updatedGuildMembers;
                  playerCache.set(p.id, p);
                }
              }
            }
            break;
          }
        }
        break;
      }
      case "REMOVE_FRIEND": {
        const id = (data as any).id;
        const username = (data as any).username;

        if (!currentPlayer) return;

        let get_friend;
        if (id) {
          get_friend = playerCache.get(id);
        } else if (username) {

          get_friend = Object.values(playerCache.list()).find(
            (p: any) => p.username.toLowerCase() === username.toLowerCase()
          );

          if (!get_friend) {
            get_friend = await player.findPlayerInDatabase(username);

            if (Array.isArray(get_friend) && get_friend.length > 0) {
              get_friend = get_friend[0];
            }
          }
        }

        const updatedFriendsList = await friends.remove(
          currentPlayer.username.toLowerCase(),
          get_friend?.username?.toLowerCase() || username.toLowerCase()
        );

        const updatedCurrentPlayersFriendsList = await friends.remove(
          get_friend?.username?.toLowerCase() || username.toLowerCase(),
          currentPlayer.username.toLowerCase()
        );

        if (get_friend?.wt) {

          sendPacket(
            get_friend.wt,
            packetManager.updateFriends({
              friends: updatedCurrentPlayersFriendsList,
            })
          );
        }

        sendPacket(
          wt,
          packetManager.updateFriends({ friends: updatedFriendsList })
        );
        sendPacket(
          wt,
          packetManager.notify({
            message: `You have removed ${get_friend.username.charAt(0).toUpperCase() +
              get_friend.username.slice(1)
              } from your friends list`,
          })
        );
        listener.emit(Events.FRIEND_REMOVED, { type: "remove", playerUsername: currentPlayer.username, friendUsername: get_friend.username });
        break;
      }
      case "MOUNT": {
        if (!currentPlayer) return;

        // Dismounting if mounted is already true
        const dismounting = currentPlayer.mounted === true;


        // Prevent mounting while casting
        if (currentPlayer.casting && !dismounting) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Cannot mount while casting." })
          );
          return;
        }

        // Prevent mounting when PvP flag is enabled or vanished
        if ((currentPlayer.pvp || currentPlayer.isVanished) && !dismounting) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Cannot mount while in PvP." })
          );
          return;
        }

        // Corpses and ghosts cannot mount.
        if ((currentPlayer.isDead || currentPlayer.isGhost) && !dismounting) {
          return;
        }

        const canMount = player.canMount(currentPlayer);
        const mount = (data as any).mount;
        if (!mount) {
          sendPacket(
            wt,
            packetManager.notify({ message: "No mount type specified." })
          );
          break;
        }

        if (!canMount) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Mount feature is currently locked.",
              })
            );

            break;
          }

        if (!dismounting) {
          const hasMount = currentPlayer.collectables.some((c: any) => c.type === "mount" && c.item === mount);
          if (!hasMount) {
            sendPacket(
              wt,
              packetManager.notify({ message: "You do not have the specified mount." })
            );
            break;
          }
        }

        currentPlayer.mounted = !currentPlayer.mounted;

        if (currentPlayer.mounted) {
          currentPlayer.mount_type = mount;
        } else {
          currentPlayer.mount_type = null;
        }

        const direction = currentPlayer.location.position?.direction || "down";
        const walking = currentPlayer.moving || false;
        const mounted = currentPlayer.mounted;

        globalStateRevision++;

        await sendPositionAnimation(
          wt,
          direction,
          walking,
          mounted,
          currentPlayer.mount_type,
          currentPlayer.id,
          globalStateRevision,
          currentPlayer.casting || false
        );

        if (gameLoop.isPlayerMoving(currentPlayer.id)) {

          const moveDirection = currentPlayer.location.position?.direction || "down";

          await packetReceiver(server, wt, JSON.stringify({ type: "MOVEXY", data: moveDirection }));
        }
        listener.emit(Events.PLAYER_MOUNT, { player: currentPlayer, mounted: currentPlayer.mounted, mountType: currentPlayer.mount_type });
        break;
      }
      case "RELEASE_SPIRIT": {
        if (!currentPlayer) return;
        // Only a corpse awaiting release can release. Ghosts are already out.
        if (!currentPlayer.isDead || currentPlayer.isGhost || currentPlayer.ghostTeleportPending) return;

        const spawn = findGraveyardSpawn(
          currentPlayer.location.map,
          currentPlayer.location.position.x,
          currentPlayer.location.position.y
        );
        currentPlayer.stats.health = 0;
        currentPlayer.stats.stamina = 0;
        // Belt and braces: ghosts move at mounted speed with no lingering
        // combat modifiers (death already resets these, keep them clean here).
        currentPlayer.slowPercent = 0;
        currentPlayer.slowMultiplier = 1;
        currentPlayer.stunnedUntil = 0;
        currentPlayer.isDead = false;
        currentPlayer.isGhost = true;
        currentPlayer.reviveOffered = false;
        currentPlayer.ghostTeleportPending = true;
        await forceStopPlayerMovement(currentPlayer);
        // Server state moves now so SAVE/logout/disconnect all agree on the
        // graveyard (relog lands there). Only the moveXY broadcast waits for
        // the client's mid-black moment below.
        currentPlayer.location.position = { x: spawn.x, y: spawn.y, direction: "down" };
        playerCache.set(currentPlayer.id, currentPlayer);
        try {
          await player.setDeadState(currentPlayer.username, 2, currentPlayer.corpse);
        } catch (e: any) {
          log.error(`Failed to persist ghost state for ${currentPlayer.username}: ${e?.message || e}`);
        }

        // Announce ghost form immediately: it starts the client's ~5s release
        // cinematic and carries the destination so graveyard chunks preload.
        // pendingTeleport keeps observers from rendering the ghost at the
        // corpse; the confirm at teleport time is their spawn signal.
        globalStateRevision++;
        const releaseMap = currentPlayer.location.map;
        const releaseId = currentPlayer.id;
        filterPlayersByMap(releaseMap).forEach((p) => {
          sendPacket(
            p.wt,
            packetManager.playerGhost({ id: releaseId, ghost: true, x: spawn.x, y: spawn.y, map: releaseMap, pendingTeleport: true })
          );
        });
        listener.emit(Events.PLAYER_GHOST_RELEASED, { player: currentPlayer });

        setTimeout(() => {
          const p = playerCache.get(releaseId);
          if (!p || !p.isGhost || !p.ghostTeleportPending) return;
          p.ghostTeleportPending = false;
          playerCache.set(p.id, p);
          globalStateRevision++;
          filterPlayersByMap(p.location.map).forEach((v) => {
            sendPacket(
              v.wt,
              packetManager.moveXY({
                i: p.id,
                d: { x: spawn.x, y: spawn.y, dr: "down" },
                r: globalStateRevision,
                s: p.isStealth ? 1 : 0
              })
            );
            // Ghost spawn signal: render from here, at the graveyard.
            sendPacket(
              v.wt,
              packetManager.playerGhost({ id: p.id, ghost: true, x: spawn.x, y: spawn.y, map: p.location.map })
            );
          });
        }, GHOST_TELEPORT_DELAY_MS);
        break;
      }
      case "CONFIRM_REVIVE": {
        if (!currentPlayer) return;
        // Rejecting a confirm revokes the offer client-side so a stale popup
        // can never linger: it only hides on this verdict or on REVIVE.
        const denyRevive = () => {
          currentPlayer.reviveOffered = false;
          if (currentPlayer.wt) {
            sendPacket(currentPlayer.wt, packetManager.reviveOffer({ revoked: true }));
          }
        };
        // Only a ghost standing at its own corpse can revive.
        if (!currentPlayer.isGhost) return;
        if (!currentPlayer.corpse) {
          denyRevive();
          return;
        }
        if (currentPlayer.corpse.map !== currentPlayer.location.map) {
          denyRevive();
          return;
        }
        const dx = currentPlayer.location.position.x - currentPlayer.corpse.x;
        const dy = currentPlayer.location.position.y - currentPlayer.corpse.y;
        if (dx * dx + dy * dy > REVIVE_OFFER_RADIUS * REVIVE_OFFER_RADIUS) {
          denyRevive();
          return;
        }

        currentPlayer.stats.health = Math.round(currentPlayer.stats.total_max_health * 0.5);
        currentPlayer.stats.stamina = Math.round(currentPlayer.stats.total_max_stamina * 0.5);
        currentPlayer.isDead = false;
        currentPlayer.isGhost = false;
        currentPlayer.corpse = null;
        currentPlayer.reviveOffered = false;
        playerCache.set(currentPlayer.id, currentPlayer);
        try {
          await player.setDeadState(currentPlayer.username, 0, null);
        } catch (e: any) {
          log.error(`Failed to clear death state for ${currentPlayer.username}: ${e?.message || e}`);
        }

        globalStateRevision++;
        const playersInMap = filterPlayersByMap(currentPlayer.location.map);
        playersInMap.forEach((p) => {
          sendPacket(
            p.wt,
            packetManager.playerGhost({ id: currentPlayer.id, ghost: false })
          );
          sendPacket(
            p.wt,
            packetManager.revive({
              id: currentPlayer.id,
              target: currentPlayer.id,
              stats: currentPlayer.stats,
            })
          );
        });
        sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
        listener.emit(Events.PLAYER_REVIVED, { player: currentPlayer });
        break;
      }
      case "CONFIRM_GRAVEYARD_REVIVE": {
        if (!currentPlayer) return;
        // Only a ghost may resurrect at the graveyard. No distance check:
        // skipping the corpse run is the point, Resurrection Sickness is
        // the price (15 min: -20% health, -10% all other stats).
        if (!currentPlayer.isGhost || currentPlayer.isDead) return;

        resurrection.applySickness(currentPlayer);
        const synced = await player.synchronizeStats(currentPlayer.username);
        if (synced) {
          currentPlayer.stats = synced;
        }
        currentPlayer.stats.health = Math.round(currentPlayer.stats.total_max_health * 0.5);
        currentPlayer.stats.stamina = Math.round(currentPlayer.stats.total_max_stamina * 0.5);
        currentPlayer.isDead = false;
        currentPlayer.isGhost = false;
        currentPlayer.corpse = null;
        currentPlayer.reviveOffered = false;
        currentPlayer.ghostTeleportPending = false;
        playerCache.set(currentPlayer.id, currentPlayer);
        try {
          await player.setDeadState(currentPlayer.username, 0, null);
        } catch (e: any) {
          log.error(`Failed to clear death state for ${currentPlayer.username}: ${e?.message || e}`);
        }

        globalStateRevision++;
        filterPlayersByMap(currentPlayer.location.map).forEach((p) => {
          sendPacket(
            p.wt,
            packetManager.playerGhost({ id: currentPlayer.id, ghost: false })
          );
          sendPacket(
            p.wt,
            packetManager.revive({
              id: currentPlayer.id,
              target: currentPlayer.id,
              stats: currentPlayer.stats,
            })
          );
        });
        spellEffects.broadcastEffectsUpdate(currentPlayer);
        sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
        sendPacket(
          currentPlayer.wt,
          packetManager.notify({ message: "You have been resurrected with Resurrection Sickness (15 min)." })
        );
        listener.emit(Events.PLAYER_REVIVED, { player: currentPlayer });
        break;
      }
      case "EQUIP_ITEM": {
        if (!currentPlayer) return;
        const item = (data as any).item;
        const slotIndex = (data as any).slotIndex;
        if (!item) return;
        const equipmentItems = currentPlayer.inventory.filter((invItem: any) => invItem.type === "equipment");
        const foundEquipment = equipmentItems.find((invItem: any) => invItem.name.toLowerCase() === item.toLowerCase());
        const slot = foundEquipment?.equipment_slot;

        if (foundEquipment?.level_requirement) {
          const playerLevel = currentPlayer.stats.level || 1;
          if (playerLevel < foundEquipment.level_requirement) return;
        }

        const previouslyEquippedItem = currentPlayer.equipment[slot];

        const result = await equipment.equipItem(currentPlayer.username, slot, item);
        if (result) {

          const canonicalName = foundEquipment?.name || item;

          if (previouslyEquippedItem) {
            const previousItem = currentPlayer.inventory.find((invItem: any) => invItem.name.toLowerCase() === previouslyEquippedItem.toLowerCase());
            if (previousItem) {
              previousItem.equipped = false;
            }
          }

          currentPlayer.equipment[slot] = canonicalName;

          const inventoryItem = currentPlayer.inventory.find((invItem: any) => invItem.name.toLowerCase() === item.toLowerCase());
          if (inventoryItem) {
            inventoryItem.equipped = true;
          }

          if (slotIndex !== undefined) {

            const freshConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = freshConfig;

            const config = currentPlayer.config && currentPlayer.config.length > 0 ? currentPlayer.config[0] : null;

            const inventoryConfig = config?.inventory_config || {};

            if (previouslyEquippedItem) {
              inventoryConfig[slotIndex.toString()] = previouslyEquippedItem;
            }

            for (const key in inventoryConfig) {
              if (inventoryConfig[key] && inventoryConfig[key].toLowerCase() === item.toLowerCase()) {
                delete inventoryConfig[key];
                break;
              }
            }

            for (const key in inventoryConfig) {
              if (inventoryConfig[key] === null) {
                delete inventoryConfig[key];
              }
            }

            await player.saveInventoryConfig(currentPlayer.username, inventoryConfig);

            const updatedConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = updatedConfig;
            playerCache.set(currentPlayer.id, currentPlayer);
          }

          playerCache.set(currentPlayer.id, currentPlayer);

          const stats = await player.synchronizeStats(currentPlayer.username);
          if (stats) {
            const currentHealth = currentPlayer.stats.health;
            const currentStamina = currentPlayer.stats.stamina;

            currentPlayer.stats = stats;

            currentPlayer.stats.health = Math.min(currentHealth, stats.total_max_health);
            currentPlayer.stats.stamina = Math.min(currentStamina, stats.total_max_stamina);

            playerCache.set(currentPlayer.id, currentPlayer);

            sendPacket(
              wt,
              packetManager.updateStats({
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );

            await sendStatsToPartyMembers(
              currentPlayer.username,
              currentPlayer.id,
              currentPlayer.stats
            );

            broadcastToAOIBestEffort(
              currentPlayer,
              packetManager.updateStats({
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );

            if (slotIndex !== undefined) {
              sendPacket(
                wt,
                packetManager.clientConfig(currentPlayer.config || [])
              );
            }

            sendPacket(
              wt,
              packetManager.equipment(currentPlayer.equipment)
            );
            sendPacket(
              wt,
              packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer))
            );

            currentPlayer.equipmentRevision = (currentPlayer.equipmentRevision || 0) + 1;

            const currentAnimationName = getAnimationNameForDirection(
              currentPlayer.location.position?.direction || "down",
              !!currentPlayer.moving,
              !!currentPlayer.mounted,
              currentPlayer.mount_type || undefined,
              !!currentPlayer.casting
            );
            await sendSpriteSheetAnimation(wt, currentAnimationName, currentPlayer.id);
          }
        }
        listener.emit(Events.ITEM_EQUIP, { player: currentPlayer, item: foundEquipment, slot });
        break;
      }
      case "UNEQUIP_ITEM": {
        if (!currentPlayer) return;
        const slot = (data as any).slot;
        const targetSlotIndex = (data as any).targetSlotIndex;
        if (!slot) return;

        const equippedItemName = currentPlayer.equipment[slot];
        if (!equippedItemName) return;

        const result = await equipment.unEquipItem(currentPlayer.username, slot, equippedItemName);
        if (result) {

          const inventoryItem = currentPlayer.inventory.find((invItem: any) => invItem.name.toLowerCase() === equippedItemName.toLowerCase());
          if (inventoryItem) {
            const maxSlots = await getInventorySlots(currentPlayer);
            const bagBoundaries = await getBagBoundaries(currentPlayer.username);
            const occupied = new Set<number>();
            for (const inv of currentPlayer.inventory) {
              if (inv !== inventoryItem && !inv.equipped && inv.slot != null) occupied.add(inv.slot);
            }

            let chosen = inventoryItem.slot;
            if (chosen == null || chosen < 0 || chosen >= maxSlots || occupied.has(chosen)) {
              chosen = targetSlotIndex;
            }
            if (chosen == null || chosen < 0 || chosen >= maxSlots || occupied.has(chosen)) {
              chosen = 0;
              while (occupied.has(chosen) && chosen < maxSlots) chosen++;
            }
            if (chosen < maxSlots) {
              inventoryItem.slot = chosen;
              inventoryItem.bag_slot = computeBagSlot(chosen, bagBoundaries);
              await inventory.setUnequippedSlot(currentPlayer.username, equippedItemName, chosen, inventoryItem.bag_slot);
            }
            inventoryItem.equipped = false;
          }

          currentPlayer.equipment[slot] = null;

          if (targetSlotIndex !== undefined) {

            const freshConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = freshConfig;

            const config = currentPlayer.config && currentPlayer.config.length > 0 ? currentPlayer.config[0] : null;

            const inventoryConfig = config?.inventory_config || {};

            inventoryConfig[targetSlotIndex.toString()] = equippedItemName;

            for (const key in inventoryConfig) {
              if (inventoryConfig[key] === null) {
                delete inventoryConfig[key];
              }
            }

            await player.saveInventoryConfig(currentPlayer.username, inventoryConfig);

            const updatedConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = updatedConfig;
          }

          playerCache.set(currentPlayer.id, currentPlayer);

          const stats = await player.synchronizeStats(currentPlayer.username);
          if (stats) {
            const currentHealth = currentPlayer.stats.health;
            const currentStamina = currentPlayer.stats.stamina;

            currentPlayer.stats = stats;

            currentPlayer.stats.health = Math.min(currentHealth, stats.total_max_health);
            currentPlayer.stats.stamina = Math.min(currentStamina, stats.total_max_stamina);

            playerCache.set(currentPlayer.id, currentPlayer);

            sendPacket(
              wt,
              packetManager.updateStats({
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );

            await sendStatsToPartyMembers(
              currentPlayer.username,
              currentPlayer.id,
              currentPlayer.stats
            );

            broadcastToAOIBestEffort(
              currentPlayer,
              packetManager.updateStats({
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );

            sendPacket(
              wt,
              packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer))
            );
            sendPacket(
              wt,
              packetManager.equipment(currentPlayer.equipment)
            );

            currentPlayer.equipmentRevision = (currentPlayer.equipmentRevision || 0) + 1;

            const currentAnimationName = getAnimationNameForDirection(
              currentPlayer.location.position?.direction || "down",
              !!currentPlayer.moving,
              !!currentPlayer.mounted,
              currentPlayer.mount_type || undefined,
              !!currentPlayer.casting
            );
            await sendSpriteSheetAnimation(wt, currentAnimationName, currentPlayer.id);
          }
        }
        listener.emit(Events.ITEM_UNEQUIP, { player: currentPlayer, slot });
        break;
      }
      case "BAG_EQUIP": {
        if (!currentPlayer) return;
        const item = (data as any).item;
        const bagSlot = (data as any).slot;
        if (!item || !bagSlot) return;
        if (!bags.SLOTS.includes(bagSlot)) return;

        const inventoryItem = currentPlayer.inventory.find((invItem: any) =>
          invItem.name.toLowerCase() === String(item).toLowerCase() &&
          invItem.bag_slots != null &&
          invItem.bag_slots > 0
        );
        if (!inventoryItem) return;

        const existingBags = await bags.ensure(currentPlayer.username);
        if (existingBags[bagSlot] && existingBags[bagSlot].toLowerCase() === String(item).toLowerCase()) return;

        const alreadyEquippedCount = bags.SLOTS.filter((s: string) =>
          existingBags[s] && existingBags[s].toLowerCase() === String(item).toLowerCase()
        ).length;
        if (alreadyEquippedCount >= inventoryItem.quantity) return;

        const canonicalName = inventoryItem.name;

        await bags.setBag(currentPlayer.username, bagSlot, canonicalName);
        await inventory.setEquipped(currentPlayer.username, canonicalName, true);
        if (alreadyEquippedCount + 1 >= inventoryItem.quantity) {
          await query(
            "UPDATE inventory SET slot = NULL, bag_slot = NULL WHERE item = ? AND username = ?",
            [canonicalName, currentPlayer.username]
          );
        }
        const freshInventory = await inventory.get(currentPlayer.username);
        currentPlayer.inventory = await patchInventoryBagSlots(freshInventory, currentPlayer.username);
        playerCache.set(currentPlayer.id, currentPlayer);
        sendPacket(wt, packetManager.bags(await bags.ensure(currentPlayer.username)));
        sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        break;
      }
      case "BAG_UNEQUIP": {
        if (!currentPlayer) return;
        const bagSlot = (data as any).slot;
        if (!bagSlot) return;
        if (!bags.SLOTS.includes(bagSlot)) return;

        const bagRow = await bags.ensure(currentPlayer.username);
        const itemName = bagRow[bagSlot];
        if (!itemName) return;

        // Temporarily remove to calculate new max
        await bags.setBag(currentPlayer.username, bagSlot, null);
        const newMax = await getInventorySlots(currentPlayer);
        await bags.setBag(currentPlayer.username, bagSlot, itemName); // restore

        const freshInv = await inventory.get(currentPlayer.username);
        const itemsBeyond = (freshInv || []).filter((i: any) => !i.equipped && i.slot != null && i.slot >= newMax);
        if (itemsBeyond.length > 0) {
          sendPacket(wt, packetManager.notify({ message: `Cannot unequip bag - ${itemsBeyond.length} item(s) occupy the extra slots. Move them to free up space first.` }));
          break;
        }

        await bags.setBag(currentPlayer.username, bagSlot, null);
        const updatedBags = await bags.ensure(currentPlayer.username);
        const stillEquipped = bags.SLOTS.some((s: string) =>
          updatedBags[s] && updatedBags[s].toLowerCase() === itemName.toLowerCase()
        );
        if (itemName && !stillEquipped) {
          const invItem = currentPlayer.inventory.find((i: any) => i.name.toLowerCase() === itemName.toLowerCase());
          await inventory.setUnequippedSlot(currentPlayer.username, itemName, invItem?.slot ?? null, invItem?.bag_slot ?? null);
        }
        currentPlayer.inventory = await patchInventoryBagSlots(await inventory.get(currentPlayer.username), currentPlayer.username);
        playerCache.set(currentPlayer.id, currentPlayer);
        sendPacket(wt, packetManager.bags(await bags.ensure(currentPlayer.username)));
        sendPacket(wt, packetManager.inventory(currentPlayer.inventory, newMax));
        break;
      }
      case "SAVE_INVENTORY_SLOTS": {
        if (!currentPlayer) return;
        const slots = (data as any)?.slots;
        if (!Array.isArray(slots)) return;

        const maxSlots = await getInventorySlots(currentPlayer);
        const boundaries = await getBagBoundaries(currentPlayer.username);
        const seen = new Set<number>();
        const validItems = new Map<string, string>();
        if (Array.isArray(currentPlayer.inventory)) {
          for (const inv of currentPlayer.inventory) {
            validItems.set(inv.name.toLowerCase(), inv.name);
          }
        }
        for (const s of slots) {
          if (typeof s.slot !== "number" || s.slot < 0 || s.slot >= maxSlots) return;
          if (seen.has(s.slot)) return;
          seen.add(s.slot);
          if (!s.item || typeof s.item !== "string") return;
          const canonical = validItems.get(s.item.toLowerCase());
          if (!canonical) return;
        }

        const patched = slots.map((s: any) => {
          const canonical = validItems.get(s.item.toLowerCase()) || s.item;
          return {
            ...s,
            item: canonical,
            bag_slot: computeBagSlot(s.slot, boundaries),
          };
        });

        await inventory.saveSlots(currentPlayer.username, patched);

        const slotMap = new Map(patched.map((s: any) => [s.item.toLowerCase(), s]));
        if (Array.isArray(currentPlayer.inventory)) {
          for (const inv of currentPlayer.inventory) {
            const s = slotMap.get(inv.name.toLowerCase());
            if (s) {
              inv.slot = s.slot;
              inv.bag_slot = s.bag_slot;
            }
          }
        }
        playerCache.set(currentPlayer.id, currentPlayer);
        break;
      }
      case "DELETE_ITEM": {
        if (!currentPlayer) return;
        const itemName = (data as any)?.item;
        const from = (data as any)?.from;
        const slot = (data as any)?.slot;
        if (!itemName || !from) return;

        if (from === "inventory") {
          const invItem = currentPlayer.inventory.find((i: any) =>
            i.name.toLowerCase() === String(itemName).toLowerCase()
          );
          if (!invItem) return;

          await inventory.delete(currentPlayer.username, { name: invItem.name, quantity: 0 });
          currentPlayer.inventory = currentPlayer.inventory.filter((i: any) => i !== invItem);
          playerCache.set(currentPlayer.id, currentPlayer);

          sendPacket(wt, packetManager.removeInventoryItem({ name: invItem.name }));
          sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        } else if (from === "equipment" && slot) {
          const equippedName = currentPlayer.equipment[slot];
          if (!equippedName || equippedName.toLowerCase() !== String(itemName).toLowerCase()) return;

          await equipment.unEquipItem(currentPlayer.username, slot, equippedName);
          await inventory.delete(currentPlayer.username, { name: equippedName, quantity: 0 });
          currentPlayer.equipment[slot] = null;

          currentPlayer.inventory = currentPlayer.inventory.filter((i: any) =>
            i.name.toLowerCase() !== equippedName.toLowerCase()
          );
          playerCache.set(currentPlayer.id, currentPlayer);

          sendPacket(wt, packetManager.removeInventoryItem({ name: equippedName }));
          sendPacket(wt, packetManager.equipment(currentPlayer.equipment));
          sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));

          const stats = await player.synchronizeStats(currentPlayer.username);
          if (stats) {
            currentPlayer.stats = stats;
            playerCache.set(currentPlayer.id, currentPlayer);
            sendPacket(wt, packetManager.updateStats({ target: currentPlayer.id, stats: currentPlayer.stats }));
          }
        }
        break;
      }
      case "PICKUP_LOOT": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot pick up loot.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        const lootId = (data as any)?.id;
        if (!lootId) return;

        const result = loot.pickup(currentPlayer, lootId);
        if (!result.success || !result.item) {
          sendPacket(wt, packetManager.notify({ message: result.message || "Could not pick up loot." }));
          break;
        }

        const lootItem = result.item;
        const addResult = await inventory.add(currentPlayer.username, { name: lootItem.item, quantity: lootItem.quantity });
        if (!addResult) break;

        const invEntry = currentPlayer.inventory.find((i: any) =>
          i.name.toLowerCase() === lootItem.item.toLowerCase()
        );
        if (invEntry) {
          invEntry.quantity = (invEntry.quantity || 0) + lootItem.quantity;
        } else {
          currentPlayer.inventory.push({
            name: lootItem.item,
            quantity: lootItem.quantity,
            equipped: false,
            slot: null,
            bag_slot: null,
          });
        }
        playerCache.set(currentPlayer.id, currentPlayer);
        sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        break;
      }
      case "BATCH_PICKUP_LOOT": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot pick up loot.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;

        const items = loot.pickupAllNearby(currentPlayer);
        if (items.length === 0) break;

        for (const item of items) {
          const addResult = await inventory.add(currentPlayer.username, { name: item.item, quantity: item.quantity });
          if (!addResult) continue;

          const invEntry = currentPlayer.inventory.find((i: any) =>
            i.name.toLowerCase() === item.item.toLowerCase()
          );
          if (invEntry) {
            invEntry.quantity = (invEntry.quantity || 0) + item.quantity;
          } else {
            currentPlayer.inventory.push({
              name: item.item,
              quantity: item.quantity,
              equipped: false,
              slot: null,
              bag_slot: null,
            });
          }
        }

        playerCache.set(currentPlayer.id, currentPlayer);
        sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        sendPacket(wt, packetManager.notify({ message: `Picked up ${items.length} item(s).` }));
        break;
      }
      case "OPEN_LOOT_CHEST": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot open chests.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        const chestId = (data as any)?.chestId;
        if (!chestId) return;
        const chest = lootChest.getChest(chestId);
        if (!chest) { sendPacket(wt, packetManager.notify({ message: "Chest not found." })); break; }
        if (chest.map !== currentPlayer.location.map) { sendPacket(wt, packetManager.notify({ message: "Chest is on a different map." })); break; }
        const playerPos = currentPlayer.location.position;
        const playerX = typeof playerPos === 'string' ? Number(playerPos.split(',')[0]) : (playerPos as any).x;
        const playerY = typeof playerPos === 'string' ? Number(playerPos.split(',')[1]) : (playerPos as any).y;
        if (!lootChest.isWithinRange(chestId, playerX, playerY)) { sendPacket(wt, packetManager.notify({ message: "You are too far from the chest." })); break; }
        const result = await lootChest.open(chestId, String(currentPlayer.id));
        if (!result) { sendPacket(wt, packetManager.notify({ message: "Could not open chest." })); break; }
        if (result.items.length === 0) { sendPacket(wt, packetManager.notify({ message: "This chest is empty for you." })); break; }
        sendPacket(wt, packetManager.lootChestContents({ chestId, items: result.items }));
        break;
      }
      case "TAKE_CHEST_ITEMS": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot take chest items.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        const chestId = (data as any)?.chestId;
        const indices = (data as any)?.indices;
        if (!chestId || !Array.isArray(indices) || indices.length === 0) return;
        const result = await lootChest.takeItems(chestId, String(currentPlayer.id), currentPlayer.username, indices);
        if (!result) { sendPacket(wt, packetManager.notify({ message: "Could not take items." })); break; }
        currentPlayer.inventory = await inventory.get(currentPlayer.username);
        playerCache.set(currentPlayer.id, currentPlayer);
        const invSlots = await getInventorySlots(currentPlayer);
        sendPacket(wt, packetManager.inventory(currentPlayer.inventory, invSlots));
        if (result.allTaken) {
          sendPacket(wt, packetManager.lootChestDespawn(chestId));
          sendPacket(wt, packetManager.notify({ message: `Took ${result.taken.length} item(s). Chest emptied.` }));
        } else {
          sendPacket(wt, packetManager.notify({ message: `Took ${result.taken.length} item(s). ${result.remaining.length} item(s) remain.` }));
        }
        break;
      }
      case "TAKE_ALL_CHEST_ITEMS": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot take chest items.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        const chestId = (data as any)?.chestId;
        if (!chestId) return;
        const result = await lootChest.takeAllItems(chestId, String(currentPlayer.id), currentPlayer.username);
        if (!result) { sendPacket(wt, packetManager.notify({ message: "Could not take items." })); break; }
        currentPlayer.inventory = await inventory.get(currentPlayer.username);
        playerCache.set(currentPlayer.id, currentPlayer);
        const invSlots = await getInventorySlots(currentPlayer);
        sendPacket(wt, packetManager.inventory(currentPlayer.inventory, invSlots));
        sendPacket(wt, packetManager.lootChestDespawn(chestId));
        sendPacket(wt, packetManager.notify({ message: `Took all ${result.taken.length} item(s).` }));
        break;
      }
      case "LIST_LOOT_TABLES": {
        if (!currentPlayer) return;
        const tables = await lootTable.list();
        sendPacket(wt, packetManager.lootTableList(tables));
        break;
      }
      case "GET_ONLINE_PLAYERS": {
        if (!currentPlayer?.isAdmin) return;

        const allPlayers = Object.values(playerCache.list());
        const playerList = allPlayers.map((p: any) => ({
          username: p.username,
          map: p.location.map.replace(".json", ""),
          isAdmin: p.isAdmin || false
        }));

        sendPacket(wt, packetManager.onlinePlayersList(playerList));
        break;
      }

      default: {
        log.error(`Unknown packet type: ${type}`);
        break;
      }
    }
  } catch (e) {
    log.error(e as string);
  }
}

// Force a player to stop moving server-side, independent of any client ABORT.
// Used by the MOVEXY "abort" branch, on-collision, and when a stun lands on a
// player who is mid-movement (the client may never send ABORT in that case).
async function forceStopPlayerMovement(target: any) {
  if (!target) return;

  gameLoop.unregisterMovingPlayer(target.id);
  target.moving = false;
  if (target._movementState) {
    target._movementState = undefined;
  }

  const cached = playerCache.get(target.id);
  if (cached && cached !== target) {
    cached.moving = false;
    cached._movementState = undefined;
  }

  const wt = target.wt;
  if (wt && wt.readyState === 1) {
    globalStateRevision++;
    await sendPositionAnimation(
      wt,
      target.location?.position?.direction || "down",
      false,
      target.mounted,
      target.mount_type || "unicorn",
      undefined,
      globalStateRevision,
      target.casting || false
    );
  }
}

// Interrupt a player's in-progress cast: aborts the pending cast promise via castId,
// broadcasts the interrupted cast bar, and reverts the casting animation.
async function interruptPlayerCast(target: any) {
  target.casting = false;
  target.castId = (target.castId || 0) + 1;
  target.lastInterruptTime = performance.now();

  if (target.castingSpellId && target.spellCooldowns) {
    delete target.spellCooldowns[target.castingSpellId];
    cooldownManager.deleteCooldown(target.username, target.castingSpellId);
    target.castingSpellId = undefined;
  }

  const cached = playerCache.get(target.id);
  if (cached && cached !== target) {
    cached.casting = false;
    cached.castId = target.castId;
    cached.lastInterruptTime = target.lastInterruptTime;
    if (cached.castingSpellId && cached.spellCooldowns) {
      delete cached.spellCooldowns[cached.castingSpellId];
    }
    cached.castingSpellId = undefined;
    playerCache.set(cached.id, cached);
  }

  const playersInMap = filterPlayersByMap(target.location.map);
  broadcastCastToMap(
    playersInMap,
    target.id,
    packetManager.castSpell({ id: target.id, spell: 'interrupted', time: 1 })
  );
  playersInMap.forEach((p) => {
    sendPacket(
      p.wt,
      packetManager.groundAoeDespawn({ id: target.id + "_casting" })
    );
  });

  globalStateRevision++;
  if (target.wt) {
    await sendPositionAnimation(
      target.wt,
      target.location.position?.direction || "down",
      false,
      target.mounted,
      target.mount_type || "unicorn",
      undefined,
      globalStateRevision,
      false
    );
  }
}

// Spirit-tongue for ghosts: random short O-words ("OooOoo ooOoo Oooo").
// Word count and lengths are purely random so nothing leaks about the real
// message's length.
function generateGhostSpeak(): string {
  const wordCount = 1 + Math.floor(Math.random() * 4);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    const len = 2 + Math.floor(Math.random() * 5);
    let word = "";
    for (let j = 0; j < len; j++) {
      word += Math.random() < 0.5 ? "o" : "O";
    }
    words.push(word);
  }
  const message = words.join(" ");
  return message.charAt(0).toUpperCase() + message.slice(1);
}

// Shared player death handling: mark dead-awaiting-release at 0 HP, leave a
// skeleton marker, and notify the victim (Release Spirit popup). The corpse
// stays where it fell until release; the graveyard teleport happens in the
// RELEASE_SPIRIT handler. Used by direct spell damage and DoT ticks.
const REVIVE_OFFER_RADIUS = 100;
// Release timing: the client plays a ~5s cinematic (orb + fade) on release.
// The teleport lands mid-black at +3s so it is never seen.
const GHOST_TELEPORT_DELAY_MS = 3000;
// Hide band: wider than the offer radius so small client/server position
// desync at the boundary can't flap the popup. Re-entry re-offers.
const REVIVE_OFFER_HIDE_RADIUS = 120;

function checkGhostReviveProximity(player: any): void {
  if (!player.isGhost || !player.corpse) return;
  if (player.corpse.map !== player.location.map) {
    player.reviveOffered = false;
    return;
  }
  const dx = player.location.position.x - player.corpse.x;
  const dy = player.location.position.y - player.corpse.y;
  const dist2 = dx * dx + dy * dy;
  if (dist2 <= REVIVE_OFFER_RADIUS * REVIVE_OFFER_RADIUS) {
    if (!player.reviveOffered && player.wt) {
      player.reviveOffered = true;
      sendPacket(player.wt, packetManager.reviveOffer({ x: player.corpse.x, y: player.corpse.y }));
    }
  } else if (dist2 > REVIVE_OFFER_HIDE_RADIUS * REVIVE_OFFER_HIDE_RADIUS) {
    // Outside the hide band: re-arm so walking back in re-offers. The client
    // hides its popup itself once past the same radius.
    player.reviveOffered = false;
  }
  // Between offer and hide radius: sticky, neither offer nor re-arm.
}

function findGraveyardSpawn(mapName: string, x: number, y: number): { x: number; y: number } {
  const mapProps = mapPropertiesCache.find((m: any) => m.name === `${mapName}.json`);
  if (mapProps?.graveyards && Array.isArray(mapProps.graveyards) && mapProps.graveyards.length > 0) {
    let closest = mapProps.graveyards[0];
    let closestDistance = Math.sqrt(
      Math.pow(x - closest.position.x, 2) + Math.pow(y - closest.position.y, 2)
    );
    for (const graveyard of mapProps.graveyards) {
      const distance = Math.sqrt(
        Math.pow(x - graveyard.position.x, 2) + Math.pow(y - graveyard.position.y, 2)
      );
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = graveyard;
      }
    }
    return { x: Math.round(closest.position.x), y: Math.round(closest.position.y) };
  }
  const defaultMapProps = mapPropertiesCache.find((m: any) => m.name === `${defaultMap}.json`);
  return {
    x: defaultMapProps ? Math.round((defaultMapProps.width * defaultMapProps.tileWidth) / 2) : 0,
    y: defaultMapProps ? Math.round((defaultMapProps.height * defaultMapProps.tileHeight) / 2) : 0,
  };
}

export async function handlePlayerDeath(target: any, killer: any, info: { damage: number; isCrit: boolean }) {
  // Already dead or a ghost: damage-over-time ticks must not re-kill.
  if (target.isDead || target.isGhost) return;

  const deathMap = target.location.map;
  const deathX = Math.round(target.location.position.x);
  const deathY = Math.round(target.location.position.y);

  // Leave a skeleton marker where the player died.
  skeletons.spawn(deathMap, deathX, deathY, target.username, layerManager.getPlayerLayer(target.id));

  // Dead-awaiting-release: no teleport, no revive yet. The corpse stays where
  // it fell at 0 HP until the player releases their spirit.
  target.stats.health = 0;
  target.stats.stamina = 0;
  target.mounted = false;
  await forceStopPlayerMovement(target);
  if (target.casting) {
    await interruptPlayerCast(target);
  }
  spellEffects.clearBarriers(target);
  dots.clearDots(target.id);
  spellEffects.clearStuns(target.id);
  spellEffects.clearSlows(target.id);
  spellEffects.clearVanishes(target.id);
  // Death clears the effect lists, but the derived combat stats baked into
  // the player object survive unless reset here. A lingering slow would
  // otherwise shrink the ghost's movement speed forever.
  target.slowPercent = 0;
  target.slowMultiplier = 1;
  target.stunnedUntil = 0;
  spellEffects.broadcastEffectsUpdate(target);

  target.isDead = true;
  target.isGhost = false;
  target.corpse = { map: deathMap, x: deathX, y: deathY };
  target.reviveOffered = false;
  playerCache.set(target.id, target);
  // Persistence must never break the live death flow: if the accounts
  // migration hasn't run, the session still works and only relog-restore
  // degrades until the columns exist.
  try {
    await player.setDeadState(target.username, 1, target.corpse);
  } catch (e: any) {
    log.error(`Failed to persist death state for ${target.username}: ${e?.message || e}`);
  }

  const deathStats = { ...target.stats, health: 0, stamina: 0 };

  if (killer && killer.id !== target.id) {
    const syncedStats = await player.synchronizeStats(killer.username);
    if (syncedStats) {
      killer.stats = syncedStats;
    }
    playerCache.set(killer.id, killer);
    if (killer.wt) {
      sendPacket(
        killer.wt,
        packetManager.updateStats({
          target: killer.id,
          stats: killer.stats,
        })
      );
    }
  }

  globalStateRevision++;
  const playersInMap = filterPlayersByMap(target.location.map);
  playersInMap.forEach((p) => {

    sendPacket(
      p.wt,
      packetManager.updateStats({
        id: killer?.id,
        target: target.id,
        stats: deathStats,
        isCrit: info.isCrit,
        damage: info.damage,
      })
    );
  });

  // The victim stays a corpse at 0 HP until they release. No teleport, no
  // revive yet — the client shows the Release Spirit popup from this.
  // Corpse included so the client can mark it past skeleton expiry.
  if (target.wt) {
    sendPacket(target.wt, packetManager.playerDied({ id: target.id, corpse: target.corpse }));
  }

  if (killer) {
    sendStatsToPartyMembers(killer.username, killer.id, killer.stats);
  }
  sendStatsToPartyMembers(target.username, target.id, target.stats);
  listener.emit(Events.PLAYER_DEATH, { player: target, killer });
}

/**
 * Single-target damage spell cast at a server-authoritative creature. Mirrors
 * the player spell flow (cooldown, mana, cast bar, cancel/move interrupts) but
 * resolves the hit through the creature combat system (threat, evade, death).
 */
/**
 * AoE and splash damage from a player spell onto creatures around a point.
 * Rolls spell hit and damage per creature like a direct cast, then applies
 * the spell's effects. Healing spells never touch creatures.
 */
function splashCreatures(caster: any, spell: SpellData, x: number, y: number, radius: number, excludeCreatureId: number | null) {
  const base = Number(spell.damage) || 0;
  if (base < 0 || !radius || radius <= 0) return;
  const level = caster.stats?.level || 1;
  const now = Date.now();
  for (const creature of creatures.creaturesInRadius(caster, x, y, radius)) {
    if (creature.id === excludeCreatureId) continue;
    if (creature.state === "evading") {
      // Immune while evading: this shows "Evading" and does nothing else.
      creatures.combat.damageCreature(creature, caster.id, 0, now);
      continue;
    }
    const text = { creatureId: creature.id, targetId: `creature:${creature.id}`, sourceId: caster.id };
    if (Math.random() * 100 < spellMissChance(level, creature.level)) {
      creatures.combat.damageCreature(creature, caster.id, 0, now);
      creatures.combat.emitCombatText({ ...text, kind: "resist", amount: 0 });
      continue;
    }
    if (base > 0) {
      const min = base + (level - 1) * 2;
      const max = base + (level - 1) * 5;
      const amount = Math.floor(Math.random() * (max - min + 1)) + min + (caster.stats?.stat_damage || 0);
      const dealt = creatures.combat.damageCreature(creature, caster.id, amount, now);
      creatures.combat.emitCombatText({ ...text, kind: "spell", amount: dealt });
    } else {
      creatures.combat.damageCreature(creature, caster.id, 0, now);
    }
    creatures.combat.applySpellToCreature(creature, caster.id, spell, now);
  }
}

/** 8-way facing from one point toward another (the sprite directions). */
function directionToward(fromX: number, fromY: number, toX: number, toY: number): string {
  const ang = Math.atan2(toY - fromY, toX - fromX) * (180 / Math.PI);
  if (ang >= -22.5 && ang < 22.5) return "right";
  if (ang >= 22.5 && ang < 67.5) return "downright";
  if (ang >= 67.5 && ang < 112.5) return "down";
  if (ang >= 112.5 && ang < 157.5) return "downleft";
  if (ang >= 157.5 || ang < -157.5) return "left";
  if (ang >= -157.5 && ang < -112.5) return "upleft";
  if (ang >= -112.5 && ang < -67.5) return "up";
  return "upright";
}

/**
 * Turn a caster to face their spell target, as WoW does when you cast at
 * something behind you, so the cast never fails for facing the wrong way.
 * Only the stored facing changes; the cast's animation packets show it.
 */
function faceToward(caster: any, x: number, y: number): void {
  const pos = caster?.location?.position;
  if (!pos || !Number.isFinite(x) || !Number.isFinite(y)) return;
  if (pos.x === x && pos.y === y) return;
  pos.direction = directionToward(pos.x, pos.y, x, y);
  playerCache.set(caster.id, caster);
}

async function castSpellOnCreature(wt: any, currentPlayer: any, spell: SpellData, creatureId: number) {
  const spellId = spell.id as number;
  const fail = (reason: string, message?: string) => {
    if (message) sendPacket(wt, packetManager.notify({ message }));
    listener.emit(Events.SPELL_FAILED, { player: currentPlayer, target: null, spellName: spell.name, reason } as any);
  };
  const resetCooldown = () => {
    const fresh = playerCache.get(currentPlayer.id);
    if (fresh?.spellCooldowns) {
      delete fresh.spellCooldowns[spellId];
      cooldownManager.deleteCooldown(fresh.username, spellId);
      playerCache.set(fresh.id, fresh);
    }
  };
  const inRangeWithSight = (creature: any): string | null => {
    if (!creatures.isTargetableBy(currentPlayer, creature)) return "invalid_target";
    const pos = currentPlayer.location.position;
    if (Math.hypot(pos.x - creature.x, pos.y - creature.y) > (spell.range || 100)) return "range";
    if (!creatures.hasLineOfSight(currentPlayer, creature)) return "path_blocked";
    return null;
  };

  const creature = creatures.getCreature(creatureId);
  if (!creature || !creatures.isTargetableBy(currentPlayer, creature)) return fail("invalid_target", "Target not found.");
  const spellDamage = Number(spell.damage) || 0;
  const creatureEffects = new Set(["damage_over_time", "stun", "slow", "interrupt", "taunt", "threat"]);
  const hasCreatureEffects = Array.isArray(spell.effects) && spell.effects.some((e) => creatureEffects.has(e?.type));
  if (spellDamage < 0 || (spellDamage === 0 && !hasCreatureEffects)) return fail("invalid_target", "You can't cast that on this target.");
  if ((spell.aoe_radius && spell.aoe_radius > 0) || spell.ground_aoe) return fail("invalid_target", "That spell can't be used on this target yet.");

  currentPlayer.spellCooldowns = currentPlayer.spellCooldowns || {};
  if ((currentPlayer.spellCooldowns[spellId] || 0) > performance.now()) return fail("cooldown");

  currentPlayer.interruptableSpell = !spell.can_move;
  // Pressed while moving: nothing started, so nothing happens or shows.
  if (!spell.can_move && currentPlayer.moving) return fail("moving");

  const manaCost = spellManaCost(spell.mana || 0, currentPlayer.stats);
  if ((currentPlayer.stats.stamina || 0) < manaCost) return fail("mana");

  const preflight = inRangeWithSight(creature);
  if (preflight === "range") return fail("range", "Target is out of range");
  if (preflight === "path_blocked") return fail("path_blocked", "Target is not in line of sight");
  if (preflight) return fail(preflight, "Target not found.");

  const cooldownEnd = performance.now() + (spell.cooldown || 0) * 1000;
  currentPlayer.spellCooldowns[spellId] = cooldownEnd;
  cooldownManager.setCooldown(currentPlayer.username, spellId, cooldownEnd);
  currentPlayer.lastCastTime = performance.now();
  currentPlayer.castingSpellId = spellId;
  currentPlayer.casting = true;
  currentPlayer.castId = (currentPlayer.castId || 0) + 1;
  currentPlayer.mounted = false;
  const thisCastId = currentPlayer.castId;
  const castStart = performance.now();
  playerCache.set(currentPlayer.id, currentPlayer);

  // Face the creature, as with player targets, so the cast is aimed at it.
  faceToward(currentPlayer, creature.x, creature.y);
  const direction = currentPlayer.location.position?.direction || "down";
  globalStateRevision++;
  await sendPositionAnimation(wt, direction, currentPlayer.moving || false, false, currentPlayer.mount_type || "unicorn", undefined, globalStateRevision, true);
  broadcastCastToMap(filterPlayersByMap(currentPlayer.location.map), currentPlayer.id, packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: spell.cast_time }));

  await new Promise((resolve) => setTimeout(resolve, (spell.cast_time || 0) * 1000));

  const after = playerCache.get(currentPlayer.id);
  if (!after || after.castId !== thisCastId) return;
  if (after.manualSpellCancel && after.manualSpellCancel >= castStart) {
    delete after.manualSpellCancel;
    after.casting = false;
    playerCache.set(after.id, after);
    return resetCooldown();
  }
  if (!spell.can_move && !after.casting) return resetCooldown();
  after.casting = false;
  playerCache.set(after.id, after);
  // The creature may have moved during the cast: finish facing where it is now.
  const creatureNow = creatures.getCreature(creatureId);
  if (creatureNow) faceToward(after, creatureNow.x, creatureNow.y);
  globalStateRevision++;
  await sendPositionAnimation(wt, after.location.position?.direction || direction, after.moving || false, false, after.mount_type || "unicorn", undefined, globalStateRevision, false);

  // Re-validate at completion: the creature may have died, evaded, moved or broken sight.
  const target = creatures.getCreature(creatureId);
  const finalCheck = target ? inRangeWithSight(target) : "invalid_target";
  if (!target || finalCheck || after.isDead) {
    broadcastCastToMap(filterPlayersByMap(after.location.map), after.id, packetManager.castSpell({ id: after.id, spell: "failed", time: 1 }));
    resetCooldown();
    return fail(finalCheck || "invalid_target", finalCheck === "range" ? "Target is out of range" : finalCheck === "path_blocked" ? "Target is not in line of sight" : undefined);
  }
  if ((after.stats.stamina || 0) < manaCost) {
    resetCooldown();
    return fail("mana");
  }
  after.stats.stamina = Math.max(0, after.stats.stamina - manaCost);

  if (after.isVanished) {
    const vanishId = spellEffects.getVanishedEffectId(after);
    if (vanishId) {
      cancelEffect(after, vanishId);
      spellEffects.broadcastEffectsUpdate(after);
    }
  }

  // Projectile visual from the caster to the creature, same as player targets:
  // travel time scales with distance and the damage lands when it arrives.
  const travelMs = projectileTravelMs(Math.hypot(after.location.position.x - target.x, after.location.position.y - target.y));
  const creatureParticles = resolveSpellParticles(spell, (await assetCache.get("particles")) as Particle[] | null);
  const projectile = packetManager.projectile({
    id: after.id,
    time: travelMs / 1000,
    target_id: `c:${target.id}`,
    spell: spell.name,
    icon: getIconUrl(spell.icon),
    creature: true,
    particles: creatureParticles,
  });
  if (projectile.length) {
    for (const p of filterPlayersByMap(after.location.map)) sendPacketBestEffort(p.wt, projectile);
  }

  if (travelMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, travelMs));
    // The creature may have died while the projectile was in flight.
    const stillThere = creatures.getCreature(creatureId);
    if (!stillThere || stillThere.state === "dead") return;
  }

  // Evading creatures are immune: the hit lands as "Evading", nothing else.
  if (target.state === "evading") {
    creatures.combat.damageCreature(target, after.id, 0, Date.now());
    return;
  }

  const now = Date.now();
  const playerLevel = after.stats.level || 1;
  const textBase = { creatureId: target.id, targetId: `creature:${target.id}`, sourceId: after.id };
  if (Math.random() * 100 < spellMissChance(playerLevel, target.level)) {
    // A resisted spell still pulls the creature.
    creatures.combat.damageCreature(target, after.id, 0, now);
    creatures.combat.emitCombatText({ ...textBase, kind: "resist", amount: 0 });
  } else if (spellDamage === 0) {
    creatures.combat.damageCreature(target, after.id, 0, now);
    creatures.combat.applySpellToCreature(target, after.id, spell, now);
  } else {
    const minDamage = spellDamage + (playerLevel - 1) * 2;
    const maxDamage = spellDamage + (playerLevel - 1) * 5;
    const rolled = Math.floor(Math.random() * (maxDamage - minDamage + 1)) + minDamage + (after.stats.stat_damage || 0);
    const isCrit = Math.random() * 100 < (after.stats.stat_critical_chance || 0);
    const amount = Math.round(isCrit ? rolled * (1.5 + (after.stats.stat_critical_damage || 0) / 100) : rolled);
    const dealt = creatures.combat.damageCreature(target, after.id, amount, now);
    creatures.combat.emitCombatText({ ...textBase, kind: isCrit ? "crit" : "spell", amount: dealt });
    if (hasCreatureEffects) creatures.combat.applySpellToCreature(target, after.id, spell, now);
  }

  playerCache.set(after.id, after);
  broadcastToAOIBestEffort(after, packetManager.updateStats({ id: after.id, target: after.id, stats: after.stats }));
  sendStatsToPartyMembers(after.username, after.id, after.stats);
  listener.emit(Events.SPELL_CAST, { player: after, spellName: spell.name, target: null, isEntityTarget: false, creatureId: target.id } as any);
}

dots.setPlayerDeathHandler(handlePlayerDeath);

setCreatureEngineBridge({
  damagePlayer: async (target, amount, info) => {
    if (target.isDead || target.isGhost || !target.stats) return;
    const absorbed = spellEffects.consumeBarrier(target, amount);
    if (absorbed > 0) spellEffects.broadcastEffectsUpdate(target);
    target.stats.health = Math.max(0, Math.round(target.stats.health - (amount - absorbed)));
    const attacker = { id: `creature:${info.creatureId}`, username: info.creatureName, isCreature: true };
    listener.emit(Events.PLAYER_DAMAGED, { attacker, target, damage: amount, isCrit: info.isCrit });
    playerCache.set(target.id, target);
    if (target.stats.health <= 0) {
      await handlePlayerDeath(target, null, { damage: amount, isCrit: info.isCrit });
      return;
    }
    broadcastStatsUpdateToAOI(
      target,
      target,
      packetManager.updateStats({ id: target.id, target: target.id, stats: target.stats, isCrit: info.isCrit, damage: amount, absorb: absorbed })
    );
    sendStatsToPartyMembers(target.username, target.id, target.stats);
  },
  dazePlayer: async (target) => {
    if (target.isDead || target.isGhost) return;
    const dazed = { name: "dazed", icon: null, effects: [{ type: "slow", value: 50, duration: 4 }] } as unknown as SpellData;
    await spellEffects.applySpellEffects(dazed, target, target, () => {}, (p: any) => spellEffects.broadcastEffectsUpdate(p));
  },
  applySpellEffects: async (target, caster, spell) => {
    if (target.isDead || target.isGhost) return;
    await spellEffects.applySpellEffects(
      spell,
      caster,
      target,
      (p: any) => broadcastStatsUpdateToAOI(p, p, packetManager.updateStats({ id: p.id, target: p.id, stats: p.stats })),
      (p: any) => spellEffects.broadcastEffectsUpdate(p)
    );
  },
});
setPlayerDeathHandler(handlePlayerDeath);

// When a stun lands on a moving player, stop their movement server-side
// immediately - the client may never send a MOVEXY "abort".
spellEffects.setStunMovementHandler(forceStopPlayerMovement);

spellEffects.setVanishRemovedHandler(async (player) => {
  const map = player.location?.map;
  if (!map) return;
  const spawnData = queueSpawnPlayerPacket(player);
  if (!spawnData) return;

  // Fetch sprite data like the stealth handler does
  const animationName = getAnimationNameForDirection(
    player.location.position?.direction || "down",
    !!player.moving,
    !!player.mounted,
    player.mount_type,
    !!player.casting
  );
  const playerSpriteData = await getPlayerSpriteSheetData(animationName, player.equipment || null);
  const mountSpriteForBatch = player.mount_type ? getMountSpriteUrl(player.mount_type) : null;
  if (playerSpriteData?.bodySprite || playerSpriteData?.headSprite || mountSpriteForBatch) {
    (spawnData as any).spriteData = {
      mountSprite: mountSpriteForBatch,
      bodySprite: playerSpriteData.bodySprite || null,
      headSprite: playerSpriteData.headSprite || null,
      armorHelmetSprite: playerSpriteData.armorHelmetSprite || null,
      armorShoulderguardsSprite: playerSpriteData.armorShoulderguardsSprite || null,
      armorNeckSprite: playerSpriteData.armorNeckSprite || null,
      armorHandsSprite: playerSpriteData.armorHandsSprite || null,
      armorChestSprite: playerSpriteData.armorChestSprite || null,
      armorFeetSprite: playerSpriteData.armorFeetSprite || null,
      armorLegsSprite: playerSpriteData.armorLegsSprite || null,
      armorWeaponSprite: playerSpriteData.armorWeaponSprite || null,
      animationState: playerSpriteData.animationState,
    };
  }

  const spawnPacket = packetManager.spawnPlayer(spawnData);
  if (!Array.isArray(spawnPacket)) return;
  const allOnMap = filterPlayersByMap(map);
  allOnMap.forEach((p) => {
    if (p.id === player.id) return;
    sendPacket(p.wt, spawnPacket);
  });
});

const DEFAULT_INTERRUPT_LOCKOUT_SECONDS = 3;

// Interrupt spell effect: cancels the target's in-progress cast and locks out
// all of their spell casting for the effect's duration.
// Only applies when the target is actually casting an interruptable spell.
registerSpellEffect("interrupt", ({ target, effect }) => {
  if (!target?.stats) return; // players only - entities do not cast
  const fresh = playerCache.get(target.id) || target;
  if (!fresh.casting || !fresh.interruptableSpell) return;

  interruptPlayerCast(fresh).catch((e) => log.error(`Failed to interrupt cast: ${e}`));

  const lockoutSec = effect.duration && effect.duration > 0 ? effect.duration : DEFAULT_INTERRUPT_LOCKOUT_SECONDS;
  fresh.spellLockoutUntil = performance.now() + lockoutSec * 1000;
  cooldownManager.setLockout(fresh.username, performance.now() + lockoutSec * 1000);
  playerCache.set(fresh.id, fresh);

  if (fresh.wt) {
    sendPacket(fresh.wt, packetManager.spellLockout({ duration: lockoutSec }));
  }
  listener.emit(Events.SPELL_INTERRUPTED, { player: fresh });
});

listener.on(Events.SPELL_INTERRUPTED, async ({ player }) => {
  if (!player?.casting || !player?.interruptableSpell) return;
  await interruptPlayerCast(player);
});

function filterPlayersByMap(map: string) {

  const playerIds = mapIndex.getPlayersOnMap(map);
  const players: any[] = [];
  for (const playerId of playerIds) {
    const player = playerCache.get(playerId);
    if (player) {
      players.push(player);
    }
  }
  return players;
}

function parsePos(pos: any): { x: number; y: number } {
  if (typeof pos === 'string') {
    const [x, y] = pos.split(',');
    return { x: Number(x), y: Number(y) };
  }
  return { x: pos?.x ?? 0, y: pos?.y ?? 0 };
}

// Players within `distance` of the caller, on the caller's own layer (players
// on other layers of the same map are separate instances - they can't see or
// interact with each other, so targeting/attack range must not consider them).
// The caller IS included in the result when within range of itself (distance 0)
// - callers that don't want self filter it out (see TARGETCLOSEST); the
// attack-range check relies on self being present for self-targeted spells.
//
// Iterates the caller's layer membership, which is capped at
// MAX_PLAYERS_PER_LAYER (~50). The previous implementation scanned every player
// on the map: at high pop with everyone clustered on one map that was O(1000s)
// per call, and TARGETCLOSEST / SELECTPLAYER / attack-range fire it per packet,
// so the inbound queue collapsed under it (~4ms/call, count climbing).
function filterPlayersByDistance(wt: any, distance: number, _map: string) {
  const currentPlayer = playerCache.get(wt.data.id);
  if (!currentPlayer) return [];

  const currPos = parsePos(currentPlayer.location.position);
  const distanceSq = distance * distance;

  const layerId =
    currentPlayer.aoi?.layerId || layerManager.getPlayerLayer(currentPlayer.id);
  const candidateIds = layerId
    ? layerManager.getPlayersInLayer(layerId)
    : mapIndex.getPlayersOnMap(currentPlayer.location.map.replaceAll(".json", ""));

  const result: any[] = [];
  for (const playerId of candidateIds) {
    const p = playerCache.get(playerId);
    if (!p || !p.location) continue;
    const pPos = parsePos(p.location.position);
    const dx = pPos.x - currPos.x;
    const dy = pPos.y - currPos.y;
    if (dx * dx + dy * dy <= distanceSq) {
      result.push(p);
    }
  }
  return result;
}

function tryParsePacket(data: any) {
  try {
    return JSON.parse(data.toString());
  } catch (e) {
    log.error(e as string);
    return undefined;
  }
}

function sendPacket(wt: any, packets: any[]) {
  if (!wt || !wt.send || wt.readyState !== 1) {

    return;
  }
  try {
    packets.forEach((packet) => {
      wt.send(packet);
    });
  } catch (error) {
    log.error(`Failed to send packet: ${error}`);
  }
}

function sendPacketBestEffort(wt: any, packets: any[]) {
  if (!wt || typeof wt.sendBestEffort !== "function" || wt.readyState !== 1) {
    return;
  }
  try {
    packets.forEach((packet) => {
      wt.sendBestEffort(packet);
    });
  } catch (error) {
    log.debug(`Best-effort packet send failed: ${error}`);
  }
}

/**
 * Broadcast a cosmetic cast-state packet (CAST_SPELL variants) to a map's
 * players with split delivery: the caster's own copy stays on the reliable
 * stream (their cast bar / cooldown UI must not lose the "interrupted"
 * packet), while every observer gets it as a loss-tolerant datagram.
 */
function broadcastCastToMap(playersInMap: any[], casterId: string, packets: any[]) {
  for (const player of playersInMap) {
    if (!player?.wt || player.wt.readyState !== 1) continue;
    if (player.id === casterId) {
      sendPacket(player.wt, packets);
    } else {
      sendPacketBestEffort(player.wt, packets);
    }
  }
}

loot.setOnDespawn((lootItem) => {
  const playerIds = mapIndex.getPlayersOnMap(lootItem.map);
  for (const playerId of playerIds) {
    const p = playerCache.get(playerId);
    if (p?.wt && p.wt.readyState === 1) {
      sendPacket(p.wt, packetManager.lootDespawn(lootItem.id));
    }
  }
});

function toSkeletonPacket(skeleton: any) {
  return {
    id: skeleton.id,
    username: skeleton.username,
    map: skeleton.map,
    x: skeleton.x,
    y: skeleton.y,
    createdAt: skeleton.createdAt,
    expiresAt: skeleton.expiresAt,
  };
}

// Death skeletons are position-static, low importance markers, so both spawn
// and expiry fan out as datagrams to exactly the players whose AOI radius
// covers the marker.
/** Resend the death markers a player should see on their current map and layer. */
function resyncSkeletonsFor(playerId: string): void {
  const viewer = playerCache.get(playerId);
  const pos = viewer?.location?.position;
  if (!viewer?.wt || !pos) return;
  const map = String(viewer.location.map || "").replaceAll(".json", "");
  const radius = viewer.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS;
  const visible = skeletons.getInRadius(map, pos.x, pos.y, radius, layerManager.getPlayerLayer(playerId));
  sendPacketBestEffort(viewer.wt, packetManager.loadSkeletons(visible.map((s) => toSkeletonPacket(s))));
}

// Layer moves (party sync, layer condensation, warps) change which markers a
// player should see, so the list is rebuilt for them.
setLayerChangeHandler(resyncSkeletonsFor);

skeletons.setOnSpawn((skeleton) => {
  broadcastToAOIBestEffortAtPosition(
    skeleton.x,
    skeleton.y,
    skeleton.map,
    packetManager.skeletonSpawn(toSkeletonPacket(skeleton)),
    skeleton.layerId
  );
});

skeletons.setOnDespawn((skeleton) => {
  broadcastToAOIBestEffortAtPosition(
    skeleton.x,
    skeleton.y,
    skeleton.map,
    packetManager.skeletonDespawn(skeleton.id),
    skeleton.layerId
  );
});

// When Resurrection Sickness wears off, recompute clean totals and push
// fresh stats + effects to the player, their map, and their party.
resurrection.setOnSicknessExpiry(async (p) => {
  const synced = await player.synchronizeStats(p.username);
  if (!synced) return;
  p.stats = synced;
  playerCache.set(p.id, p);
  globalStateRevision++;
  filterPlayersByMap(p.location.map).forEach((v) => {
    sendPacket(
      v.wt,
      packetManager.updateStats({ id: p.id, target: p.id, stats: p.stats })
    );
  });
  spellEffects.broadcastEffectsUpdate(p);
  sendStatsToPartyMembers(p.username, p.id, p.stats);
});

async function sendStatsToPartyMembers(playerUsername: string, playerId: string, stats: any) {
  const partyId = await parties.getPartyId(playerUsername);
  if (!partyId) return;

  const partyMembers = await parties.getPartyMembers(partyId);
  if (!partyMembers || partyMembers.length === 0) return;

  for (const memberName of partyMembers) {
    if (memberName.toLowerCase() === playerUsername.toLowerCase()) continue;

    const sessionId = await player.getSessionIdByUsername(memberName);
    const partyMember = sessionId && playerCache.get(sessionId);

    if (partyMember && partyMember.wt) {
      sendPacketBestEffort(
        partyMember.wt,
        packetManager.updateStats({
          target: playerId,
          username: playerUsername,
          stats: stats,
        })
      );
    }
  }
}

async function sendSpriteSheetAnimation(wt: any, name: string, playerId?: string, revision?: number) {
  const currentPlayer = playerCache.get(playerId || wt.data.id);
  if (!currentPlayer) return;

  const playerEquipment = currentPlayer.equipment || null;

  const spriteSheetData = await getPlayerSpriteSheetData(name, playerEquipment);

  if (!spriteSheetData.bodySprite && !spriteSheetData.headSprite) {
    log.warn(`No sprite sheet layers available for animation "${name}", player ${currentPlayer.id}`);
    return;
  }

  // Sprite URLs are now sent directly to the client
  const spriteSheetPacketData = {
    id: currentPlayer.id,
    mountSprite: currentPlayer.mounted && currentPlayer.mount_type ? getMountSpriteUrl(currentPlayer.mount_type) : null,
    bodySprite: spriteSheetData.bodySprite || null,
    headSprite: spriteSheetData.headSprite || null,
    armorHelmetSprite: spriteSheetData.armorHelmetSprite || null,
    armorShoulderguardsSprite: spriteSheetData.armorShoulderguardsSprite || null,
    armorNeckSprite: spriteSheetData.armorNeckSprite || null,
    armorHandsSprite: spriteSheetData.armorHandsSprite || null,
    armorChestSprite: spriteSheetData.armorChestSprite || null,
    armorFeetSprite: spriteSheetData.armorFeetSprite || null,
    armorLegsSprite: spriteSheetData.armorLegsSprite || null,
    armorWeaponSprite: spriteSheetData.armorWeaponSprite || null,
    animationState: spriteSheetData.animationState,
    revision: revision,
  };

  // Split delivery: the player's own copy rides the reliable stream (their
  // sprite state must never desync). Observers also get the reliable stream:
  // animation is state, not latest-wins data - a single lost walk/idle
  // datagram would stick the wrong pose until the next direction change.
  if (currentPlayer.wt) {
    sendPacket(currentPlayer.wt, packetManager.spriteSheetAnimation(spriteSheetPacketData));
  }
  broadcastToAOI(currentPlayer, packetManager.spriteSheetAnimation(spriteSheetPacketData), false);
}

async function sendAnimation(wt: any, name: string, playerId?: string, revision?: number) {
  const currentPlayer = playerCache.get(playerId || wt.data.id);
  if (!currentPlayer) return;

  if (!useSpriteSheets) {
    log.warn(`Sprite sheet system disabled in config for player ${currentPlayer.id}`);
    return;
  }

  if (!(await isSpriteSheetSystemAvailable())) {
    log.warn(`Sprite sheet system not available for player ${currentPlayer.id}`);
    return;
  }

  await sendSpriteSheetAnimation(wt, name, playerId, revision);
}

function getAnimationNameForDirection(
  direction: string,
  walking: boolean,
  mounted: boolean = false,
  mount_type?: string,
  casting: boolean = false
): string {
  const normalized = normalizeDirection(direction);

  if (casting) {
    const castAction = walking ? "cast_walk" : "cast_idle";
    return `player_${castAction}_${normalized}.png`;
  }

  const action = walking ? "walk" : "idle";
  if (mounted) {
    mount_type = mount_type || "unicorn";
    return `mount_${mount_type}_${action}_${normalized}.png`;
  }
  return `player_${action}_${normalized}.png`;
}

async function sendPositionAnimation(
  wt: any,
  direction: string,
  walking: boolean,
  mounted: boolean = false,
  mount_type: string = "",
  playerId?: string,
  revision?: number,
  casting: boolean = false
) {
  const animation = getAnimationNameForDirection(direction, walking, mounted, mount_type, casting);
  await sendAnimation(wt, animation, playerId, revision);
}

function normalizeDirection(direction: string): string {

  const validDirections = ["down", "up", "left", "right", "downleft", "downright", "upleft", "upright"];
  if (validDirections.includes(direction)) {
    return direction;
  }
  return "down";
}

async function getAnimationData(name: string, playerId: string, revision?: number): Promise<any | null> {
  const targetPlayer = playerCache.get(playerId);
  if (!targetPlayer) return null;

  if (!useSpriteSheets || !(await isSpriteSheetSystemAvailable())) {
    return null;
  }

  const playerEquipment = targetPlayer.equipment || null;
  const spriteSheetData = await getPlayerSpriteSheetData(name, playerEquipment);

  if (!spriteSheetData.bodySprite && !spriteSheetData.headSprite) {
    return null;
  }

  // Sprite URLs are now sent directly to the client
  return {
    id: targetPlayer.id,
    mountSprite: targetPlayer.mounted && targetPlayer.mount_type ? getMountSpriteUrl(targetPlayer.mount_type) : null,
    bodySprite: spriteSheetData.bodySprite || null,
    headSprite: spriteSheetData.headSprite || null,
    armorHelmetSprite: spriteSheetData.armorHelmetSprite || null,
    armorShoulderguardsSprite: spriteSheetData.armorShoulderguardsSprite || null,
    armorNeckSprite: spriteSheetData.armorNeckSprite || null,
    armorHandsSprite: spriteSheetData.armorHandsSprite || null,
    armorChestSprite: spriteSheetData.armorChestSprite || null,
    armorFeetSprite: spriteSheetData.armorFeetSprite || null,
    armorLegsSprite: spriteSheetData.armorLegsSprite || null,
    armorWeaponSprite: spriteSheetData.armorWeaponSprite || null,
    animationState: spriteSheetData.animationState,
    revision: revision,
  };
}

export async function sendAnimationTo(targetWs: any, name: string, playerId?: string, revision?: number) {
  const targetPlayer = playerCache.get(playerId || targetWs.data.id);
  if (!targetPlayer) return;

  if (!useSpriteSheets || !(await isSpriteSheetSystemAvailable())) {
    log.warn(`Sprite sheet system not available for player ${targetPlayer.id}`);
    return;
  }

  const playerEquipment = targetPlayer.equipment || null;

  const spriteSheetData = await getPlayerSpriteSheetData(name, playerEquipment);

  if (!spriteSheetData.bodySprite && !spriteSheetData.headSprite) {
    log.debug(`No sprite sheet layers available for animation "${name}", player ${targetPlayer.id} - will send empty sprite data`);

  }

  // Sprite URLs are now sent directly to the client
  const spriteSheetPacketData = {
    id: targetPlayer.id,
    mountSprite: targetPlayer.mounted && targetPlayer.mount_type ? getMountSpriteUrl(targetPlayer.mount_type) : null,
    bodySprite: spriteSheetData.bodySprite || null,
    headSprite: spriteSheetData.headSprite || null,
    armorHelmetSprite: spriteSheetData.armorHelmetSprite || null,
    armorShoulderguardsSprite: spriteSheetData.armorShoulderguardsSprite || null,
    armorNeckSprite: spriteSheetData.armorNeckSprite || null,
    armorHandsSprite: spriteSheetData.armorHandsSprite || null,
    armorChestSprite: spriteSheetData.armorChestSprite || null,
    armorFeetSprite: spriteSheetData.armorFeetSprite || null,
    armorLegsSprite: spriteSheetData.armorLegsSprite || null,
    armorWeaponSprite: spriteSheetData.armorWeaponSprite || null,
    animationState: spriteSheetData.animationState,
    revision: revision,
  };

  sendPacket(targetWs, packetManager.spriteSheetAnimation(spriteSheetPacketData));
}

function scheduleLightning() {
  const delay = 2000 + Math.random() * 3000;
  setTimeout(async () => {
    try {
      for (const world of worldsCache) {
        const resolved = resolvedWeatherCache.get(world.name);
        const activeWeather = resolved ? resolved.weather : world.weather;
        if (activeWeather !== "thunderstorm") continue;
        const playersOnMap = mapIndex.getPlayersOnMap(world.name);
        if (playersOnMap.size === 0) continue;

        const playerIds = Array.from(playersOnMap);
        const randomId = playerIds[Math.floor(Math.random() * playerIds.length)];
        const player = playerCache.get(randomId);
        if (!player?.location?.position) continue;

        const strikeX = player.location.position.x + (Math.random() * 600 - 300);
        const strikeY = player.location.position.y + (Math.random() * 400 - 200);

        broadcastToAOIBestEffort(
          player,
          packetManager.lightning({ x: Math.round(strikeX), y: Math.round(strikeY), map: world.name }),
          true
        );
      }
    } catch (e) {
      // silently ignore
    }
    scheduleLightning();
  }, delay);
}

scheduleLightning();

function scheduleWeatherCycle() {
  setTimeout(async () => {
    try {
      for (const world of worldsCache) {
        if (world.weather !== "random") continue;

        const allWeathers = await assetCache.get("weather") as WeatherData[];
        if (!allWeathers?.length) continue;

        const randomWeather = allWeathers[Math.floor(Math.random() * allWeathers.length)];
        resolvedWeatherCache.set(world.name, { weather: randomWeather.name, weatherData: randomWeather });

        const playerIds = mapIndex.getPlayersOnMap(world.name);
        for (const playerId of playerIds) {
          const player = playerCache.get(playerId);
          if (player?.wt && player.wt.readyState === 1) {
            sendPacket(
              player.wt,
              packetManager.changeWeather({ weather: randomWeather.name, weatherData: randomWeather })
            );
          }
        }
      }
    } catch (e) {
      // silently ignore
    }
    scheduleWeatherCycle();
  }, 30 * 60 * 1000);
}

scheduleWeatherCycle();

