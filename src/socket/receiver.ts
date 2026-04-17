import { packetTypes } from "./types";
import { packetManager } from "./packet_manager";
import log from "../modules/logger";
import player, { clearMapCache } from "../systems/player.ts";
import permissions from "../systems/permissions";
import { getAuthWorker } from "./authentication_pool.ts";
const authentication_queue = new Set<string>();
const authentication_session_queue = new Set<string>();

const pendingAuthentications = new Map<string, { ws: any; token: string; language: string }>();

// Track current target for target cycling
const currentTargetMap = new Map<string, string | null>();

import playerCache from "../services/playermanager.ts";
import layerManager from "../services/layermanager";
import mapIndex from "../services/mapindex";
import gameLoop from "../services/gameloop";
import assetCache from "../services/assetCache";
import entityCache from "../services/entityCache.ts";
import { reloadMap } from "../modules/assetloader";
import language from "../systems/language";
import quests from "../systems/quests";
import friends from "../systems/friends";
import parties from "../systems/parties.ts";
import spells from "../systems/spells";
import equipment from "../systems/equipment.ts";
import inventory from "../systems/inventory";
import particles from "../systems/particles";
import npcSystem from "../systems/npcs";
import entitySystem from "../systems/entities";
import entityAI from "../systems/entityAI";
const maps = await assetCache.get("maps");
const worldsCache = await assetCache.get("worlds") as WorldData[];
const mapPropertiesCache = await assetCache.get("mapProperties");
import { decryptPrivateKey, decryptRsa, _privateKey } from "../modules/cipher";

import * as settings from "../config/settings.json";
import { randomBytes } from "../modules/hash";
import { saveMapChunks, saveMapProperties } from "../modules/assetloader";
import { getPlayerSpriteSheetData, isSpriteSheetSystemAvailable, getIconUrl, getMountSpriteUrl, getNpcSpriteLayers, getEntitySpriteLayers } from "../modules/spriteSheetManager";
import { initializePlayerAOI, updatePlayerAOI, shouldUpdateAOI, broadcastToAOI, handleMapChangeAOI, syncPartyLayers } from "./aoi";
import { realmWhitelist, isWhitelistEnabled } from "./server.ts";
const defaultMap = (settings as any).default_map?.replace(".json", "") || "main";

const useSpriteSheets = (settings as any).animation_system?.use_sprite_sheets ?? true;

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

export const movementBatchQueue = new Map<string, Map<string, any>>();

let BATCH_INTERVAL = 8; // Will be set dynamically based on flush latency

const MAX_BUFFER_BACKPRESSURE = 1024 * 32; // 32KB - aggressive at high loads

let lastFlushTime = Date.now();
let flushCount = 0;

// Track recent flush latencies for adaptive batch scheduling
const LATENCY_HISTORY_SIZE = 20; // Keep last 20 flushes
const recentFlushLatencies: number[] = [];

/**
 * Calculate average flush latency from recent history
 */
function getAverageFlushLatency(): number {
  if (recentFlushLatencies.length === 0) return 0;
  const sum = recentFlushLatencies.reduce((a, b) => a + b, 0);
  return sum / recentFlushLatencies.length;
}

/**
 * Calculate adaptive batch interval based on actual flush latency
 * Higher latency = more aggressive throttling
 * This dynamically adapts to real server load instead of player count
 */
function getAdaptiveBatchInterval(): number {
  const avgLatency = getAverageFlushLatency();

  // Thresholds based on flush latency (in milliseconds)
  if (avgLatency < 5) {
    return 25; // <5ms: 40 Hz - very responsive
  } else if (avgLatency < 10) {
    return 30; // 5-10ms: 33 Hz - responsive
  } else if (avgLatency < 15) {
    return 35; // 10-15ms: 28 Hz - good balance
  } else if (avgLatency < 20) {
    return 45; // 15-20ms: 22 Hz - starting to reduce
  } else if (avgLatency < 30) {
    return 70; // 20-30ms: 14 Hz - moderate throttling
  } else if (avgLatency < 40) {
    return 100; // 30-40ms: 10 Hz - aggressive throttling
  } else if (avgLatency < 50) {
    return 130; // 40-50ms: 7 Hz - very aggressive
  } else {
    return 170; // 50+ms: 5 Hz - maximum stability
  }
}

function flushMovementBatches() {
  const startTime = Date.now();

  const timeSinceLastFlush = startTime - lastFlushTime;
  lastFlushTime = startTime;

  const avgLatency = getAverageFlushLatency();

  // Overloaded if current cycle is taking longer than average or latency is building
  const isOverloaded = timeSinceLastFlush > 30 || avgLatency > 25;

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
    log.debug(`[MOVEMENT] Dropped ${toDrop} movement batches due to queue overflow (latency: ${Math.round(avgLatency)}ms)`);
  }

  for (const [_mapName, playerMovements] of movementBatchQueue.entries()) {
    if (playerMovements.size === 0) continue;

    const allPlayers = playerCache.list();

    const receiverSets = new Map<string, Set<string>>();

    for (const playerId in allPlayers) {
      const player = allPlayers[playerId];
      if (!player || !player.aoi) continue;

      const receivers = new Set<string>([playerId]);
      if (player.aoi.playersInAOI) {
        for (const aoiPlayerId of player.aoi.playersInAOI) {
          receivers.add(aoiPlayerId as string);
        }
      }
      receiverSets.set(playerId, receivers);
    }

    const receiverMovements = new Map<string, any[]>();

    for (const [movingPlayerId, movementData] of playerMovements.entries()) {
      const movingPlayer = allPlayers[movingPlayerId];
      if (!movingPlayer || !movingPlayer.aoi) continue;

      for (const [potentialReceiverId, receiversForPlayer] of receiverSets.entries()) {
        if (!receiversForPlayer.has(movingPlayerId)) continue;

        if (movementData.isStealth) {
          const receiver = allPlayers[potentialReceiverId];
          if (!receiver || !receiver.isAdmin) continue;
        }

        if (!receiverMovements.has(potentialReceiverId)) {
          receiverMovements.set(potentialReceiverId, []);
        }
        receiverMovements.get(potentialReceiverId)!.push(movementData);
      }
    }

    let sentCount = 0;
    const receiverArray = Array.from(receiverMovements.entries());

    receiverArray.sort((a, b) => a[1].length - b[1].length);

    for (const [receiverId, movements] of receiverArray) {
      const receiver = allPlayers[receiverId];
      if (!receiver || !receiver.ws || receiver.ws.readyState !== 1) continue;

      const bufferedAmount = receiver.ws.bufferedAmount;

      // Dynamic backpressure threshold based on latency
      const backpressureThreshold = avgLatency > 35 ? 1024 * 16 : (avgLatency > 20 ? 1024 * 24 : MAX_BUFFER_BACKPRESSURE);

      if (bufferedAmount > backpressureThreshold) {
        skippedDueToLoad++;
        continue;
      }

      const batchPacket = packetManager.batchMoveXY(movements);
      sendPacket(receiver.ws, batchPacket);
      sentCount++;

      // Early-exit thresholds based on latency
      let sentThreshold = 200;
      let timeThreshold = 40;

      if (avgLatency > 40) {
        sentThreshold = 50;
        timeThreshold = 20;
      } else if (avgLatency > 25) {
        sentThreshold = 100;
        timeThreshold = 30;
      }

      if (isOverloaded && sentCount > sentThreshold && Date.now() - startTime > timeThreshold) {
        skippedDueToLoad += receiverArray.length - sentCount;
        break;
      }
    }
  }

  movementBatchQueue.clear();

  // Track this flush's latency
  const flushLatency = Date.now() - startTime;
  recentFlushLatencies.push(flushLatency);
  if (recentFlushLatencies.length > LATENCY_HISTORY_SIZE) {
    recentFlushLatencies.shift();
  }

  flushCount++;
  if (flushCount % 100 === 0) {
    const playerCount = Object.keys(playerCache.list()).length;

    const allPlayersForStats = playerCache.list();
    const allPlayersList = Object.values(allPlayersForStats);
    const connectedPlayers = allPlayersList.filter(p => p?.ws && p.ws.readyState === 1);
    const avgBuffered = connectedPlayers.length > 0
      ? Math.round(connectedPlayers.reduce((sum, p) => sum + (p.ws?.bufferedAmount || 0), 0) / connectedPlayers.length / 1024)
      : 0;

    if (skippedDueToLoad > 0 || avgBuffered > 24) {
      log.warn(`[MOVEMENT] ${playerCount} players | Skipped ${skippedDueToLoad} updates | Avg buffer: ${avgBuffered}KB | Flush latency: ${Math.round(avgLatency)}ms | Rate: ${Math.round(1000/BATCH_INTERVAL)}Hz`);
    }
  }
}

export const spawnBatchQueue = new Map<string, Map<string, any>>();

async function flushSpawnBatches() {
  if (spawnBatchQueue.size === 0) return;

  const allPlayers = playerCache.list();

  for (const [receivingPlayerId, spawnedPlayers] of spawnBatchQueue.entries()) {
    if (spawnedPlayers.size === 0) {
      continue;
    }

    const receivingPlayer = allPlayers[receivingPlayerId];

    if (!receivingPlayer) {
      continue;
    }
    if (!receivingPlayer.ws) {
      continue;
    }
    if (receivingPlayer.ws.readyState !== 1) {
      continue;
    }

    if (receivingPlayer.ws.bufferedAmount > MAX_BUFFER_BACKPRESSURE) {
      continue;
    }

    const spawnsForThisPlayer = Array.from(spawnedPlayers.values());

    if (spawnsForThisPlayer.length > 0) {

      const playersWithSprites = await Promise.all(
        spawnsForThisPlayer.map(async (queuedPlayer) => {

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
          const playerSpriteData = await getPlayerSpriteSheetData(animationName, fullPlayer.equipment || null);

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

      const loadPlayersData = {
        players: playersWithSprites,
        snapshotRevision: globalStateRevision
      };

      const packets = packetManager.loadPlayers(loadPlayersData);
      sendPacket(receivingPlayer.ws, packets);

      const animationPromises = playersWithSprites.map(async (spawnData) => {
        const spawnedPlayer = allPlayers[spawnData.id];
        if (!spawnedPlayer) {
          return null;
        }

        const animationName = getAnimationNameForDirection(
          spawnedPlayer.location.position.direction,
          spawnedPlayer.moving,
          spawnedPlayer.mounted,
          spawnedPlayer.mount_type,
          spawnedPlayer.casting || false
        );

        const animData = await getAnimationData(animationName, spawnData.id);
        return animData;
      });

      const animationDataArray = (await Promise.all(animationPromises)).filter(a => a !== null);

      if (animationDataArray.length > 0) {
        sendPacket(receivingPlayer.ws, packetManager.batchSpriteSheetAnimation(animationDataArray));
      }
    }
  }

  spawnBatchQueue.clear();
}

export const despawnBatchQueue = new Map<string, Set<string>>();

function flushDespawnBatches() {
  if (despawnBatchQueue.size === 0) return;

  const allPlayers = playerCache.list();

  for (const [receivingPlayerId, despawnedPlayerIds] of despawnBatchQueue.entries()) {
    if (despawnedPlayerIds.size === 0) continue;

    const receivingPlayer = allPlayers[receivingPlayerId];

    if (!receivingPlayer || !receivingPlayer.ws || receivingPlayer.ws.readyState !== 1) continue;

    if (receivingPlayer.ws.bufferedAmount > MAX_BUFFER_BACKPRESSURE) continue;

    const despawnsArray = Array.from(despawnedPlayerIds);

    if (despawnsArray.length > 0) {

      const despawnData = despawnsArray.map(playerId => ({ id: playerId, reason: "disconnect" }));
      sendPacket(receivingPlayer.ws, packetManager.batchDisconnectPlayer(despawnData));
    }
  }

  despawnBatchQueue.clear();
}

async function flushAllBatches() {
  flushMovementBatches();
  await flushSpawnBatches();
  flushDespawnBatches();
}

let batchTimer: ReturnType<typeof setTimeout> | null = null;

async function scheduleBatchFlush() {
  try {
    await flushAllBatches();
  } catch (error) {
    // Silently ignore batch flush errors
  } finally {
    if (batchTimer) clearTimeout(batchTimer);
    // Use adaptive interval based on current player count
    const adaptiveInterval = getAdaptiveBatchInterval();
    BATCH_INTERVAL = adaptiveInterval;
    batchTimer = setTimeout(scheduleBatchFlush, adaptiveInterval);
  }
}

// Initialize with adaptive interval
const initialInterval = getAdaptiveBatchInterval();
BATCH_INTERVAL = initialInterval;
batchTimer = setTimeout(scheduleBatchFlush, initialInterval);

export function clearBatchQueuesForPlayer(playerId: string, mapName: string) {

  const mapMovements = movementBatchQueue.get(mapName);
  if (mapMovements) {
    mapMovements.delete(playerId);
    if (mapMovements.size === 0) {
      movementBatchQueue.delete(mapName);
    }
  }

  const spawnsToPlayer = spawnBatchQueue.get(playerId);
  if (spawnsToPlayer && spawnsToPlayer.size > 0) {
    log.debug(`[CLEAR] Removing ${spawnsToPlayer.size} queued spawns TO ${playerId}`);
  }
  spawnBatchQueue.delete(playerId);

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
  if (clearedSpawnsFrom > 0) {
    log.debug(`[CLEAR] Removed spawn of ${playerId} FROM ${clearedSpawnsFrom} player queues`);
  }

  despawnBatchQueue.delete(playerId);

}

/**
 * Clean up target cycling state when a player disconnects
 */
export function clearPlayerTarget(playerId: string) {
  currentTargetMap.delete(playerId);
}

const authWorker = await getAuthWorker();
authWorker.on("message", async (result: any) => {
  const status = result as Authentication;
  const sessionId = result.id;

  const pending = pendingAuthentications.get(sessionId);
  if (!pending) return;

  const { ws, token, language } = pending;

  pendingAuthentications.delete(sessionId);
  authentication_queue.delete(token);
  authentication_session_queue.delete(sessionId);

  if (status.error && !status.authenticated) {
    sendPacket(ws, packetManager.loginFailed());
    ws.close(1008, status.error);
    return;
  }

  if (status.authenticated && status.completed && status.error) {
    sendPacket(ws, packetManager.loginFailed());
    ws.close(1008, status.error);
    return;
  }

  const playerData = status.data as PlayerData;
  if (status.authenticated && status.completed && playerData) {
    // Check realm whitelist
    if (isWhitelistEnabled && !realmWhitelist.has(playerData.username.toLowerCase())) {
      log.warn(`[Whitelist] Access denied for ${playerData.username} - not in whitelist`);
      sendPacket(ws, packetManager.loginFailed());
      ws.close(1008, "Username not whitelisted on this realm");
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

    const default_map_properties = mapPropertiesCache.find((m: any) => m.name === `${defaultMap}.json`);
    const default_map_spawnpoint_x = default_map_properties ? (default_map_properties.width * default_map_properties.tileWidth) / 2 : 0;
    const default_map_spawnpoint_y = default_map_properties ? (default_map_properties.height * default_map_properties.tileHeight) / 2 : 0;
    const default_map_spawnpoint = { map: `${defaultMap}.json`, x: default_map_spawnpoint_x, y: default_map_spawnpoint_y, direction: "down" };
    const player_map_properties = mapPropertiesCache.find((m: any) => m.name === `${playerData.location?.map}.json`) || default_map_properties;

    const position = playerData.location?.position as PositionData;
    let spawnLocation = default_map_spawnpoint;

    if (playerData.location && position) {
      spawnLocation = {
        map: `${playerData.location.map}.json`,
        x: position.x || (player_map_properties ? (player_map_properties.width * player_map_properties.tileWidth) / 2 : 0),
        y: position.y || (player_map_properties ? (player_map_properties.height * player_map_properties.tileHeight) / 2 : 0),
        direction: position.direction || "down",
      };
    }

    const map =
      maps.find((m: MapData) => m.name === spawnLocation.map) ||
      maps.find((m: MapData) => m.name === `${defaultMap}.json`);
    if (!map) return;

    spawnLocation.map = map.name;

    const incompleteQuest = (playerData.questlog?.incomplete as unknown as Quest[]) || [];
    const completedQuest = (playerData.questlog?.completed as unknown as Quest[]) || [];

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

    const playerCount = (world?.players || 0) + 1;
    const maxPlayers = world?.max_players || 100;
    if (world && maxPlayers && playerCount > maxPlayers) {
      ws.close(1008, "World is full");
      return;
    }

    if (world) {
      world.players = (world.players || 0) + 1;

      assetCache.set("worlds", JSON.stringify(worldData)).catch(err =>
        log.error(`Failed to update world player count: ${err}`)
      );
    }

    const weather = world?.weather || "clear";
    if (weather) {
      sendPacket(ws, packetManager.weather({ weather }));
    }

    const limitedInventory = Array.isArray(playerData.inventory) ? playerData.inventory.slice(0, 30) : [];
    const limitedFriends = Array.isArray(playerData.friends) ? playerData.friends.slice(0, 100) : [];
    const limitedCollectables = Array.isArray(playerData.collectables) ? playerData.collectables.slice(0, 50) : [];
    const limitedLearnedSpells = Array.isArray(playerData.learnedSpells) ? playerData.learnedSpells.slice(0, 100) : (playerData.learnedSpells || []);

    playerCache.add(ws.data.id, {
      username: playerData.username,
      animation: null,
      isAdmin: playerData.isAdmin,
      isStealth: playerData.isStealth,
      isNoclip: playerData.isNoclip,
      id: ws.data.id,
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
      ws,
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
      currency: playerData.currency || { copper: 0, silver: 0, gold: 0 },
      isGuest: playerData.isGuest,
      created: performance.now(),
      lastUpdated: performance.now(),
      mounted: false,
      mount_type: null,
      collectables: limitedCollectables,
      spellCooldowns: {},
      casting: false,
      lastInterruptTime: 0,
      interruptableSpell: false,
      learnedSpells: limitedLearnedSpells,
      inventory: limitedInventory,
      equipment: playerData.equipment || {},
    });

    const stats = await player.synchronizeStats(playerData.username);

    if (!stats) {
      sendPacket(ws, packetManager.loginFailed());
      ws.close(1008, "Failed to load player stats");
      return;
    }

    if (stats.stamina > stats.total_max_stamina) {
      stats.stamina = stats.total_max_stamina;
    }

    if (stats.health > stats.total_max_health) {
      stats.health = stats.total_max_health;
    }

    const _pcache = playerCache.get(ws.data.id);
    if (_pcache) {
      _pcache.stats = stats;
      playerCache.set(_pcache.id, _pcache);

      await initializePlayerAOI(_pcache);
      playerCache.set(_pcache.id, _pcache);

      mapIndex.addPlayer(_pcache.id, _pcache.location.map);
    }

    // Extract object layers from map data
    const objectLayers = (map?.data?.layers || [])
      .filter((layer: any) => layer.type === "objectgroup")
      .map((layer: any) => ({ name: layer.name }));

    // Send map chunk metadata instead of full map
    const mapMetadata = {
      name: spawnLocation?.map,
      assetServerUrl,
      width: map?.data?.width || 0,
      height: map?.data?.height || 0,
      tilewidth: map?.data?.tilewidth || 32,
      tileheight: map?.data?.tileheight || 32,
      tilesets: map?.data?.tilesets || [], // Tileset metadata (not images, just definitions)
      spawnX: position?.x || 0,
      spawnY: position?.y || 0,
      direction: position?.direction || "down",
      chunks: null, // Client will fetch from asset server
      warps: player_map_properties?.warps || null,
      graveyards: player_map_properties?.graveyards || null,
      objectLayers: objectLayers,
    };

    sendPacket(ws, packetManager.loadMap(mapMetadata));

    setImmediate(async () => {

      const currentPlayer = playerCache.get(ws.data.id);
      if (!currentPlayer) return;

      await updatePlayerAOI(currentPlayer, sendAnimationTo, spawnBatchQueue, despawnBatchQueue);

      const animationName = getAnimationNameForDirection(position?.direction || "down", false, false, undefined, false);
      const selfSpriteData = await getPlayerSpriteSheetData(animationName, _pcache?.equipment || null);

      let spriteDataForSelf = null;
      if (selfSpriteData.bodySprite || selfSpriteData.headSprite) {
        // Sprite URLs are now sent to the client, which fetches them from the asset server
        spriteDataForSelf = {
          bodySprite: selfSpriteData.bodySprite || null,
          headSprite: selfSpriteData.headSprite || null,
          animationState: selfSpriteData.animationState,
        };
      }

      const spawnDataForAll = {
        id: ws.data.id,
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
        stats: stats || {},
        animation: null,
        spriteData: spriteDataForSelf,
        friends: playerData.friends || [],
        party_id: playerData.party_id ? Number(playerData.party_id) : null,
        party: playerData.party || [],
        currency: playerData.currency || { copper: 0, silver: 0, gold: 0 },
      };
      sendPacket(ws, packetManager.spawnPlayer(spawnDataForAll));

      const snapshotRevision = globalStateRevision;

      const playerDataForLoad: any[] = [];
      const playersInAOI = Array.from(currentPlayer.aoi.playersInAOI)
        .map(id => playerCache.get(id as string))
        .filter(p => p && p.ws);

      for (const p of playersInAOI) {

        const animationName = getAnimationNameForDirection(p.location.position?.direction || "down", !!p.moving, !!p.mounted, p.mount_type, !!p.casting);
        const playerSpriteData = await getPlayerSpriteSheetData(animationName, p.equipment || null);

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
          isNoclip: p.isNoclip,
          stats: p.stats,
          animation: null,
          spriteData: spriteData,
          mounted: p.mounted,
        }
        playerDataForLoad.push(loadPlayerData);
      }

      const loadPlayersData = {
        players: playerDataForLoad,
        snapshotRevision: snapshotRevision
      };

      sendPacket(ws, packetManager.loadPlayers(loadPlayersData));

      if (playerDataForLoad.length > 0) {
        playerDataForLoad.forEach(async (pl) => {
          if (pl.id !== ws.data.id && pl.location.direction) {
            const pcache = playerCache.get(pl.id);
            await sendAnimationTo(
              ws,
              getAnimationNameForDirection(pl.location.direction, !!pcache?.moving, !!pcache?.mounted, pcache?.mount_type, !!pcache?.casting),
              pl.id
            );
          }
        });
      }

      const mapName = currentPlayer.location.map;
      const queuedMovements = movementBatchQueue.get(mapName);
      if (queuedMovements && queuedMovements.size > 0) {
        const movementsForNewPlayer: any[] = [];

        for (const playerId of currentPlayer.aoi.playersInAOI) {
          const movement = queuedMovements.get(playerId as string);
          if (movement) {
            movementsForNewPlayer.push(movement);
          }
        }

        if (movementsForNewPlayer.length > 0) {
          sendPacket(ws, packetManager.batchMoveXY(movementsForNewPlayer));
        }
      }

      if (position?.direction) {
        await sendAnimationTo(
          ws,
          getAnimationNameForDirection(position.direction, false, false, undefined, false),
          ws.data.id
        );

        const animationData = packetManager.animation({
          id: ws.data.id,
          name: getAnimationNameForDirection(position.direction, false, false, undefined, false)
        });
        broadcastToAOI(currentPlayer, animationData, false);
      }

    });
    setImmediate(() => {

      const currentPlayerData = playerCache.get(ws.data.id);
      if (!currentPlayerData) return;

      const allPlayers = playerCache.list();
      const usernameIndex = new Map<string, any>();

      for (const player of Object.values(allPlayers)) {
        if (player.ws && player.username) {
          usernameIndex.set(player.username.toLowerCase(), player);
        }
      }

      const newPlayerFriends = currentPlayerData.friends || [];

      for (const friendUsername of newPlayerFriends) {

        const onlineFriend = usernameIndex.get(friendUsername.toLowerCase());

        if (onlineFriend) {

          sendPacket(
            onlineFriend.ws,
            packetManager.updateOnlineStatus({
              online: true,
              username: currentPlayerData.username,
            })
          );

          sendPacket(
            currentPlayerData.ws,
            packetManager.updateOnlineStatus({
              online: true,
              username: onlineFriend.username,
            })
          );
        }
      }
    });

    setImmediate(async () => {
      const npcsData = await assetCache.get("npcs") as Npc[];
      const npcsInMap = npcsData.filter(
        (npc: Npc) => npc.map === spawnLocation.map.replace(".json", "")
      );
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
            particles: particleArray,
            quest: npc.quest,
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
        sendPacket(ws, npcPackets);
      }
    });

    // Send entities on map spawn (from in-memory cache, no database calls)
    setImmediate(async () => {
      try {
        const mapName = spawnLocation.map.replace(".json", "");
        const entitiesInMap = entityCache.getByMap(mapName);
        const particlesCache = await assetCache.get("particles") as Particle[] | null;
        const entityPackets = await entitiesInMap.reduce(
          async (packetsPromise: Promise<any[]>, entity: any) => {
            const packets = await packetsPromise;
            const particleArray =
              typeof entity.particles === "string" && particlesCache
                ? (
                  (entity.particles as string)
                    .split(",")
                    .map((name) =>
                      particlesCache.find((p: Particle) => p.name === name.trim())
                    )
                ).filter(Boolean)
                : [];
            const entityData = {
              id: entity.id,
              last_updated: entity.last_updated,
              name: entity.name || null,
              location: {
                x: entity.position.x,
                y: entity.position.y,
                direction: entity.position.direction || "down",
              },
              health: entity.health,
              max_health: entity.max_health,
              level: entity.level,
              aggro_type: entity.aggro_type,
              particles: particleArray,
              map: entity.map,
              position: entity.position,
              sprite_type: entity.sprite_type || 'animated',
              spriteLayers: getEntitySpriteLayers(entity),
            };
            return [...packets, ...packetManager.createEntity(entityData as any)];
          },
          Promise.resolve([] as any[])
        );
        if (entityPackets.length) {
          sendPacket(ws, entityPackets);
        }
      } catch (error: any) {
        log.warn(`Error loading entities: ${error.message}`);
      }
    });

    sendPacket(ws, packetManager.clientConfig(playerData.config || []));

    // Convert icon names to Asset Server URLs for inventory items
    const inventoryWithIconUrls = playerData.inventory?.map((item: any) => ({
      ...item,
      iconUrl: getIconUrl(item.icon),
      icon: undefined // Remove the old icon field
    })) || [];

    // Convert icon names to Asset Server sprite URLs for spells (icons and sprites share the same name)
    const spellsWithSpriteUrls: Record<string, any> = {};
    if (playerData.learnedSpells && typeof playerData.learnedSpells === 'object') {
      for (const [spellName, spellData] of Object.entries(playerData.learnedSpells)) {
        spellsWithSpriteUrls[spellName] = {
          spriteUrl: (spellData as any).icon ? `${assetServerUrl}/sprite?name=${encodeURIComponent((spellData as any).icon)}` : null
        };
      }
    }

    // Convert icon names to Asset Server URLs for collectables (mounts)
    const collectablesWithIconUrls = playerData.collectables?.map((collectable: any) => ({
      ...collectable,
      iconUrl: getIconUrl(collectable.icon),
      icon: undefined // Remove the old icon field
    })) || [];

    sendPacket(ws, packetManager.inventory(inventoryWithIconUrls));
    sendPacket(ws, packetManager.equipment(playerData.equipment || {}));
    sendPacket(ws, packetManager.collectables(collectablesWithIconUrls));
    sendPacket(ws, packetManager.spells(spellsWithSpriteUrls));
    sendPacket(ws, packetManager.questlog(completedQuest, incompleteQuest));
  }
});

export default async function packetReceiver(
  server: any,
  ws: any,
  message: string
) {
  try {

    if (!message) return ws.close(1008, "Empty message");

    const parsedMessage: Packet = tryParsePacket(message) as Packet;
    if (
      message.length >
      (1024 * 1024 * settings?.websocket?.maxPayloadMB || 1024 * 1024) &&
      parsedMessage.type !== "BENCHMARK" &&
      !settings?.websocket?.benchmarkenabled
    )
      return ws.close(1009, "Message too large");

    if (!parsedMessage) return ws.close(1007, "Malformed message");
    const data = parsedMessage?.data;
    const type = parsedMessage?.type;

    if (!type || (!data && data != null))
      return ws.close(1007, "Malformed message");

    if (
      Object.values(packetTypes).indexOf(
        parsedMessage?.type as unknown as string
      ) === -1
    ) {
      ws.close(1007, "Invalid packet type");
    }

    const currentPlayer = playerCache.get(ws.data.id) || null;

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
        sendPacket(ws, packetManager.benchmark(data));
        break;
      }
      case "PING": {
        sendPacket(ws, packetManager.ping(data));
        break;
      }
      case "PONG": {
        sendPacket(ws, packetManager.pong(data));
        break;
      }
      case "LOGIN": {
        sendPacket(ws, packetManager.login(ws));
        break;
      }
      case "TIME_SYNC": {
        if (!currentPlayer) return;

        currentPlayer.lastUpdated = performance.now();

        sendPacket(ws, packetManager.timeSync(data));
        break;
      }
      case "AUTH": {
        const token = data?.toString() as string;

        if (!token) {
          sendPacket(ws, packetManager.loginFailed());
          ws.close(1008, "Invalid token");
          break;
        }

        if (authentication_queue.has(token)) {
          sendPacket(ws, packetManager.loginFailed());
          ws.close(1008, "Authentication already in progress");
          break;
        }

        if (authentication_session_queue.has(ws.data.id)) {
          sendPacket(ws, packetManager.loginFailed());
          ws.close(1008, "Session authentication already in progress");
          break;
        }

        authentication_queue.add(token);
        authentication_session_queue.add(ws.data.id);

        pendingAuthentications.set(ws.data.id, { ws, token, language: parsedMessage?.language || "en" });

        authWorker.postMessage({ token, id: ws.data.id });

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
        break;
      }
      case "MOVEXY": {
        if (!currentPlayer) return;

        const baseSpeed = 6;
        const mountSpeedMultiplier = 1.35;
        const speed = currentPlayer.mounted ? baseSpeed * mountSpeedMultiplier : baseSpeed;
        const lastDirection =
          currentPlayer.location.position?.direction || "down";

        const direction = data.toString().toLowerCase();

        const directions = [
          "up",
          "down",
          "left",
          "right",
          "upleft",
          "upright",
          "downleft",
          "downright",
        ];

        if (direction === "abort") {

          gameLoop.unregisterMovingPlayer(currentPlayer.id);
          currentPlayer.moving = false;
          // Clean up movement state
          if (currentPlayer._movementState) {
            currentPlayer._movementState = undefined;
          }

          globalStateRevision++;
          await sendPositionAnimation(
            ws,
            lastDirection,
            false,
            currentPlayer.mounted,
            currentPlayer.mount_type || "unicorn",
            undefined,
            globalStateRevision,
            currentPlayer.casting || false
          );
          return;
        }

        if (currentPlayer.casting && currentPlayer.interruptableSpell) {
          currentPlayer.casting = false;
          currentPlayer.lastInterruptTime = performance.now();

          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.castSpell({ id: currentPlayer.id, spell: 'interrupted', time: 1 })
            );
          });

          globalStateRevision++;
          await sendPositionAnimation(
            ws,
            currentPlayer.location.position?.direction || direction,
            false,
            currentPlayer.mounted,
            currentPlayer.mount_type || "unicorn",
            undefined,
            globalStateRevision,
            false
          );
        }

        if (!directions.includes(direction)) return;

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
          ws,
          direction,
          true,
          currentPlayer.mounted,
          currentPlayer.mount_type || "unicorn",
          undefined,
          globalStateRevision,
          currentPlayer.casting || false
        );

        if (gameLoop.isPlayerMoving(currentPlayer.id)) {
          gameLoop.unregisterMovingPlayer(currentPlayer.id);
        }

        const movePlayer = async () => {

          if (!ws || ws.readyState !== 1) {
            gameLoop.unregisterMovingPlayer(currentPlayer.id);
            return;
          }

          const tempPosition = { ...currentPlayer.location.position };
          const playerHeight = 40;
          const playerWidth = 24;

          const directionOffsets: Record<string, { dx: number; dy: number }> = {
            up: { dx: 0, dy: -speed },
            down: { dx: 0, dy: speed },
            left: { dx: -speed, dy: 0 },
            right: { dx: speed, dy: 0 },
            upleft: { dx: -speed, dy: -speed },
            upright: { dx: speed, dy: -speed },
            downleft: { dx: -speed, dy: speed },
            downright: { dx: speed, dy: speed },
          };

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
          const collision = await player.checkIfWouldCollide(
            currentPlayer.location.map,
            {
              x: Math.round(tempPosition.x),
              y: Math.round(tempPosition.y),
              direction,
            },
            {
              width: playerWidth,
              height: playerHeight,
            },
            mapPropertiesCache
          );

          const isColliding = collision?.value === true;

          if (!isColliding || currentPlayer.isNoclip) {
            currentPlayer.location.position.x = Math.round(tempPosition.x);
            currentPlayer.location.position.y = Math.round(tempPosition.y);
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
              ws,
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
              sendPacket(ws, packetManager.collisionDebug({
                tileX: collision.tile.x,
                tileY: collision.tile.y
              }));
            }

            if (reason === "warp_collision" && collision?.warp) {
              const currentMap = currentPlayer.location.map;
              const warp = collision.warp as {
                map: string;
                x: number;
                y: number;
              };

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

                await handleMapChangeAOI(currentPlayer, newMap, newPosition, sendAnimationTo, spawnBatchQueue, despawnBatchQueue);

                currentPlayer.location.position.direction = currentPlayer.location.position?.direction || "down";

                if (currentMap !== warp.map) {
                  sendPacket(ws, packetManager.reconnect());
                } else {
                  globalStateRevision++;

                  const movementData = {
                    i: ws.data.id,
                    d: {
                      x: Number(currentPlayer.location.position.x),
                      y: Number(currentPlayer.location.position.y),
                      dr: currentPlayer.location.position.direction
                    },
                    r: globalStateRevision,
                    s: currentPlayer.isStealth ? 1 : 0
                  };
                  sendPacket(ws, packetManager.moveXY(movementData));
                }
              }
            }

            return;
          }

          globalStateRevision++;

          const aoiUpdateCounter = gameLoop.getAOIUpdateCounter(currentPlayer.id);
          if (aoiUpdateCounter % 10 === 0 && shouldUpdateAOI(currentPlayer)) {
            await updatePlayerAOI(currentPlayer, sendAnimationTo, spawnBatchQueue, despawnBatchQueue);
          }

          const movementData = {
            i: ws.data.id,
            d: {
              x: Number(currentPlayer.location.position.x),
              y: Number(currentPlayer.location.position.y),
              dr: currentPlayer.location.position.direction
            },
            r: globalStateRevision,
            s: currentPlayer.isStealth ? 1 : 0
          };

          sendPacket(ws, packetManager.moveXY(movementData));

          if (ws.readyState === 1) {
            const mapName = currentPlayer.location.map;
            if (!movementBatchQueue.has(mapName)) {
              movementBatchQueue.set(mapName, new Map());
            }
            movementBatchQueue.get(mapName)!.set(currentPlayer.id, movementData);
          }
        };

        await movePlayer();

        gameLoop.registerMovingPlayer(currentPlayer.id, movePlayer);
        break;
      }
      case "TELEPORTXY": {
        if (!currentPlayer?.isAdmin) return;
        currentPlayer.location.position = data;
        currentPlayer.location.position.direction = "down";

        currentPlayer.location.position.x = Math.round(
          Number(currentPlayer.location.position.x)
        );
        currentPlayer.location.position.y = Math.round(
          Number(currentPlayer.location.position.y)
        );
        globalStateRevision++;

        if (shouldUpdateAOI(currentPlayer)) {
          await updatePlayerAOI(currentPlayer, sendAnimationTo, spawnBatchQueue, despawnBatchQueue);
        }

        const movementData = {
          i: ws.data.id,
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
        if (currentPlayer.isGuest) {
          sendPacket(
            ws,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }
        const messageData = data as any;
        const message = messageData?.message;
        const mode = messageData?.mode;

        const sendMessageToPlayer = (playerWs: any, message: string) => {
          const chatData = {
            id: ws.data.id,
            message,
            username: currentPlayer.username,
          };
          sendPacket(playerWs, packetManager.chat(chatData));
        };

        if (message == null) {
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          playersInMap.forEach((player) => {
            sendMessageToPlayer(player.ws, "");
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

        sendMessageToPlayer(ws, decryptedMessage as string);

        const cache = playerCache.list();
        let playersInMap = Object.values(cache).filter(
          (p) =>
            p.location.map === currentPlayer.location.map && p.id !== ws.data.id
        );

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
            id: ws.data.id,
            message: translations[player.language],
            username: currentPlayer.username,
          };

          sendPacket(player.ws, packetManager.chat(chatData));
        });
        break;
      }
      case "TYPING": {
        if (!currentPlayer || currentPlayer?.isGuest) return;
        const typingData = {
          id: ws.data.id,
        };
        let playersInMap = filterPlayersByMap(currentPlayer.location.map);
        if (currentPlayer.isStealth) {
          playersInMap = playersInMap.filter((p) => p.isAdmin);
        }
        playersInMap.forEach((player) => {
          sendPacket(player.ws, packetManager.typing(typingData));
        });
        break;
      }
      case "CLIENTCONFIG": {
        if (!currentPlayer) return;
        await player.setConfig(ws.data.id, data);
        break;
      }
      case "SELECTPLAYER": {
        if (!currentPlayer) return;
        const location = data as unknown as LocationData;
        const cache = playerCache.list();

        const players = Object.values(cache).filter(
          (p) => p.location.map === currentPlayer.location.map
        );

        const selectedPlayer = players.find(
          (p) =>
            Math.abs(p.location.position.x - Math.floor(Number(location.x))) <
            25 &&
            Math.abs(p.location.position.y - Math.floor(Number(location.y))) <
            25
        );

        if (!selectedPlayer) break;
        if (selectedPlayer.isStealth && !currentPlayer.isAdmin) {
          const selectPlayerData = {
            id: ws.data.id,
            data: null,
          };
          sendPacket(ws, packetManager.selectPlayer(selectPlayerData));
          break;
        } else {
          const selectPlayerData = {
            id: selectedPlayer.id,
            username: selectedPlayer.username,
            stats: selectedPlayer.stats,
          };
          sendPacket(ws, packetManager.selectPlayer(selectPlayerData));
        }
        break;
      }
      case "TARGETCLOSEST": {
        if (!currentPlayer) return;

        const TARGETING_RANGE = 500;
        const CONE_ANGLE = 90; // 90 degree cone (45 degrees on each side of facing direction)

        // Get all players on the same map
        const playersInRange = filterPlayersByDistance(
          ws,
          TARGETING_RANGE,
          currentPlayer.location.map
        ).filter((p) => !p.isStealth && p.id !== currentPlayer.id);

        // Find next player target using cone-based directional targeting with cycling
        const currentTargetId = currentTargetMap.get(currentPlayer.id) || null;
        const nextPlayer = player.getNextTargetInCone(
          currentPlayer,
          playersInRange,
          TARGETING_RANGE,
          currentTargetId,
          CONE_ANGLE
        );

        // Also check for closest entity in facing cone (from in-memory cache)
        const entitiesInMap = entityCache.getByMap(currentPlayer.location.map);
        const entitiesInCone: any[] = [];

        if (entitiesInMap && entitiesInMap.length > 0) {
          const selfPosition = currentPlayer.location.position as any;
          const direction = selfPosition.direction || "down";

          const directionAngles: { [key: string]: number } = {
            right: 0,
            downright: 45,
            down: 90,
            downleft: 135,
            left: 180,
            upleft: -135,
            up: -90,
            upright: -45,
          };

          const facingAngle = directionAngles[direction] ?? 90;
          const tolerance = CONE_ANGLE / 2;

          const isFacingTarget = (targetAngle: number): boolean => {
            const minAngle = facingAngle - tolerance;
            const maxAngle = facingAngle + tolerance;

            if (minAngle < -180) {
              return targetAngle >= (minAngle + 360) || targetAngle <= maxAngle;
            } else if (maxAngle > 180) {
              return targetAngle >= minAngle || targetAngle <= (maxAngle - 360);
            }

            return targetAngle >= minAngle && targetAngle <= maxAngle;
          };

          for (const entity of entitiesInMap) {
            // Skip dead entities - check both health and combatState
            if ((entity.health ?? 0) <= 0 || (entity as any).combatState === 'dead') continue;

            const dx = entity.position.x - selfPosition.x;
            const dy = entity.position.y - selfPosition.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance > TARGETING_RANGE) continue;

            const angle = Math.atan2(dy, dx) * (180 / Math.PI);

            if (isFacingTarget(angle)) {
              entitiesInCone.push({
                ...entity,
                distance: distance,
              });
            }
          }

          // Sort entities by distance (closest first)
          entitiesInCone.sort((a, b) => a.distance - b.distance);
        }

        // Get next entity target (cycling through cone)
        let nextEntity: any = null;
        if (entitiesInCone.length > 0) {
          const currentTargetId = currentTargetMap.get(currentPlayer.id) || null;
          if (!currentTargetId) {
            nextEntity = entitiesInCone[0];
          } else {
            const currentIndex = entitiesInCone.findIndex((e) => e.id === currentTargetId);
            if (currentIndex === -1 || currentIndex === entitiesInCone.length - 1) {
              nextEntity = entitiesInCone[0];
            } else {
              nextEntity = entitiesInCone[currentIndex + 1];
            }
          }
        }

        // Determine which target is closer (player vs entity)
        let targetToSelect: any = null;
        if (nextPlayer && nextEntity) {
          const playerPos = nextPlayer?.location?.position as any;
          const playerDistance = Math.sqrt(
            Math.pow(currentPlayer.location.position.x - playerPos.x, 2) +
            Math.pow(currentPlayer.location.position.y - playerPos.y, 2)
          );
          targetToSelect = playerDistance < nextEntity.distance ? nextPlayer : nextEntity;
        } else if (nextPlayer) {
          targetToSelect = nextPlayer;
        } else if (nextEntity) {
          targetToSelect = nextEntity;
        }

        if (targetToSelect) {
          // Update current target for cycling
          currentTargetMap.set(currentPlayer.id, targetToSelect.id);

          if (targetToSelect.stats) {
            // It's a player
            const selectPlayerData = {
              id: targetToSelect.id || null,
              username: targetToSelect.username || null,
              stats: targetToSelect.stats || null,
            };
            sendPacket(ws, packetManager.selectPlayer(selectPlayerData));
          } else {
            // It's an entity
            const selectEntityData = {
              id: targetToSelect.id || null,
            };
            sendPacket(ws, packetManager.selectPlayer(selectEntityData));
          }
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
            sendPacket(ws, packetManager.inspectPlayer(inspectPlayerData));
          }
        }
        break;
      }
      case "NOCLIP": {
        if (!currentPlayer?.isAdmin) return;
        const isNoclip = await player.toggleNoclip(currentPlayer.username);
        currentPlayer.isNoclip = isNoclip;
        const noclipData = {
          id: ws.data.id,
          isNoclip: currentPlayer.isNoclip,
        };
        sendPacket(ws, packetManager.noclip(noclipData));
        break;
      }
      case "STEALTH": {
        if (!currentPlayer?.isAdmin) return;
        const isStealth = await player.toggleStealth(currentPlayer.username);
        currentPlayer.isStealth = isStealth;
        const playersInMap = filterPlayersByMap(currentPlayer.location.map);
        const stealthData = {
          id: ws.data.id,
          isStealth: currentPlayer.isStealth,
        };
        sendPacket(ws, packetManager.stealth(stealthData));
        playersInMap.forEach((player) => {
          const stealthData = {
            id: ws.data.id,
            isStealth: currentPlayer.isStealth,
          };
          sendPacket(player.ws, packetManager.stealth(stealthData));
        });
        if (!isStealth) {
          globalStateRevision++;
          playersInMap.forEach(async (player) => {
            const moveXYData = {
              i: ws.data.id,
              d: {
                x: Number(currentPlayer.location.position.x),
                y: Number(currentPlayer.location.position.y),
                dr: currentPlayer.location.position.direction
              },
              r: globalStateRevision,
              s: currentPlayer.isStealth ? 1 : 0
            };

            if (currentPlayer.location.position?.direction) {
              await sendPositionAnimation(
                ws,
                currentPlayer.location.position?.direction,
                false,
                currentPlayer.mounted,
                currentPlayer.mount_type || "unicorn",
                undefined,
                globalStateRevision,
                currentPlayer.casting || false
              );
              sendPacket(player.ws, packetManager.moveXY(moveXYData));
            }
          });
        }
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
      case "HOTBAR": {
        if (!currentPlayer) return;
        if (currentPlayer.isGuest) {
          sendPacket(
            ws,
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

        const spell_identifier = (data as any).spell;
        const targetId = (data as any).target?.id;
        const isEntityRequest = (data as any).entity === true;

        log.debug(`[ATTACK] Spell cast request - spell=${spell_identifier}, targetId=${targetId}, isEntityRequest=${isEntityRequest}`);

        const spell = await spells.find(spell_identifier);
        const spell_id = spell?.id;
        if (!spell || !spell_id) {
          sendPacket(
            ws,
            packetManager.notify({ message: "Invalid spell selected." })
          );
          break;
        }

        if (!spell_identifier) {
          sendPacket(
            ws,
            packetManager.notify({ message: "No spell selected." })
          );
          break;
        }

        if (!currentPlayer.learnedSpells?.[spell.name]) {
          sendPacket(ws, packetManager.notify({ message: "You have not learned this spell." }));
          return;
        }

        log.debug(`[ATTACK] Looking for target ID: ${targetId}`);
        let target = null;

        if (isEntityRequest) {
          // Looking for an entity target (from in-memory cache)
          log.debug(`[ATTACK] Entity request detected, looking in entity cache...`);
          target = entityCache.getById(targetId);
          if (target) {
            log.debug(`[ATTACK] Found target as entity ${target.id} with aggro_type=${target.aggro_type}`);
          } else {
            log.debug(`[ATTACK] Entity target not found in cache: ${targetId}`);
          }
        } else {
          // Looking for a player target
          target = playerCache.get(targetId);
          if (target) {
            log.debug(`[ATTACK] Found target as player: ${target.username}`);
          } else if (targetId) {
            log.debug(`[ATTACK] Player target not found in cache: ${targetId}`);
          }
        }

        if (!target && !targetId) {
          // Only default to self if no target was specified
          target = currentPlayer;
          log.debug(`[ATTACK] No target specified, defaulting to self`);
        }

        if (!target?.id) {
          log.debug(`[ATTACK] Player ${currentPlayer.username} attempted attack with invalid target: ${targetId}`);
          sendPacket(
            ws,
            packetManager.notify({ message: "Target not found." })
          );
          return;
        }

        // Only guests check applies to players, not entities
        if (target.isGuest) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You cannot attack guests." })
          );
          return;
        }

        const freshPlayerForCooldown = playerCache.get(currentPlayer.id);
        if (!freshPlayerForCooldown) return;
        freshPlayerForCooldown.spellCooldowns = freshPlayerForCooldown.spellCooldowns || {};
        const spellCooldownEnd = freshPlayerForCooldown.spellCooldowns[spell_id] || 0;
        if (spellCooldownEnd > performance?.now()) {
          return;
        }

        const spell_range = spell.range || 100;
        const spell_damage = spell?.damage;
        const spell_mana = spell?.mana || 0;

        currentPlayer.interruptableSpell = !spell?.can_move || false;

        if (!spell?.can_move && currentPlayer.moving) {

          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.castSpell({ id: currentPlayer.id, spell: 'interrupted', time: 1 })
            );
          });
          currentPlayer.lastInterruptTime = performance.now();

          return;
        }

        const freshPlayerForMana = playerCache.get(currentPlayer.id);
        if (!freshPlayerForMana) return;

        const actualManaCost = Math.floor(freshPlayerForMana.stats.total_max_stamina * (spell_mana / 100));
        if ((freshPlayerForMana.stats.stamina || 0) < actualManaCost) {
          return;
        }

        if (!spell_damage) return;

        // ATOMIC: Set cooldown immediately to prevent race condition with mana deduction
        // This must happen before any other async operations
        // Only apply spell cooldown (not cast_time) for faster feel
        freshPlayerForMana.spellCooldowns = freshPlayerForMana.spellCooldowns || {};
        const spellCooldownTime = spell.cooldown * 1000;
        freshPlayerForMana.spellCooldowns[spell_id] = performance.now() + spellCooldownTime;
        freshPlayerForMana.lastCastTime = performance.now();

        playerCache.set(freshPlayerForMana.id, freshPlayerForMana);

        currentPlayer.stats = freshPlayerForMana.stats;
        currentPlayer.lastCastTime = freshPlayerForMana.lastCastTime;
        currentPlayer.spellCooldowns = freshPlayerForMana.spellCooldowns;

        const isInParty = currentPlayer?.party?.includes(target?.username) || null;

        if (isInParty && spell_damage > 0) {
          sendPacket(
            ws,
            packetManager.notify({
              message: "You cannot attack your party members",
            })
          );
          return;
        }

        if (spell_damage < 0 && target.id !== currentPlayer.id && !isInParty) return;

        const playersInMap = filterPlayersByMap(currentPlayer.location.map);

        const playersInAttackRange = filterPlayersByDistance(
          ws,
          spell_range,
          currentPlayer.location.map
        );

        // Determine if target is an entity or a player
        const isEntityTarget = target.aggro_type !== undefined && target.health !== undefined && !target.stats;

        if (isEntityTarget) {
          log.debug(`[ATTACK] Identified target as entity. aggro_type=${target.aggro_type}, health=${target.health}, has_stats=${!!target.stats}`);

          // Prevent casting on friendly entities
          if (target.aggro_type === 'friendly') {
            return;
          }
        } else {
          log.debug(`[ATTACK] Identified target as player. username=${target.username}`);
        }

        let canAttack: any = { value: true };

        if (isEntityTarget) {
          // For entity targets, check map first
          if (target.map !== currentPlayer.location.map) {
            canAttack = { value: false, reason: "different_map" };
          } else {
            // Check if entity is in returning state (invulnerable)
            const entityState = entityAI.getEntityAIState(target.id);
            if (entityState && entityState.combatState === 'returning') {
              canAttack = { value: false, reason: "entity_returning" };
            } else {
              // Convert entity to player-like format for canAttack
              const entityAsPlayer = {
                ...target,
                location: {
                  map: target.map,
                  position: target.position
                },
                stats: { health: target.health }
              };
              canAttack = await player.canAttack(currentPlayer, entityAsPlayer,
                {
                  width: 24,
                  height: 40,
                },
                spell_range
              );
            }
          }
        } else {
          // Perform canAttack check for player targets
          canAttack = await player.canAttack(currentPlayer, target,
            {
              width: 24,
              height: 40,
            },
            spell_range
          );
        }
        log.debug(`[ATTACK] canAttack result: ${JSON.stringify(canAttack)}`);

        // Handle both player targets (location.position) and entity targets (position)
        const targetX = target.location?.position?.x || target.position?.x || 0;
        const targetY = target.location?.position?.y || target.position?.y || 0;

        const distance = Math.sqrt(
          Math.pow(currentPlayer.location.position.x - targetX, 2) +
          Math.pow(currentPlayer.location.position.y - targetY, 2)
        );

        // Check range for entities and players
        log.debug(`[ATTACK] Distance to target: ${distance}, spell_range: ${spell_range}`);
        if (isEntityTarget && distance > spell_range) {
          log.debug(`[ATTACK] Entity target out of range. distance=${distance} > spell_range=${spell_range}`);
          sendPacket(
            ws,
            packetManager.notify({ message: "Target is out of range" })
          );
          return;
        }

        if (target.id === currentPlayer.id && spell_damage < 0) {
          playersInAttackRange.push(target);
        } else if (!canAttack?.value) {
          if (canAttack?.reason == "nopvp") {
            sendPacket(
              ws,
              packetManager.notify({ message: "You are not in a PvP area" })
            );
          }
          if (canAttack?.reason == "path_blocked") {
            sendPacket(
              ws,
              packetManager.notify({ message: "Target is not in line of sight" })
            );
          }
          if (canAttack?.reason == "entity_returning") {
            sendPacket(
              ws,
              packetManager.notify({ message: "The entity is returning to its home" })
            );
          }
          return;
        } else if (!isEntityTarget && !playersInAttackRange.includes(target)) {
          return;
        }

        let delay = 0;
        if (target.id !== currentPlayer.id) {
          const maxTravelTime = 500;
          const speedMultiplier = 1000;

          const calculatedDelay = (distance / speedMultiplier) * 1000;

          delay = Math.min(calculatedDelay, maxTravelTime);
        }

        currentPlayer.casting = true;
        const spellStartTime = performance.now();

        // Dismount player if they're mounted
        if (currentPlayer.mounted) {
          currentPlayer.mounted = false;
          playerCache.set(currentPlayer.id, currentPlayer);
        }

        globalStateRevision++;
        await sendPositionAnimation(
          ws,
          currentPlayer.location.position?.direction || "down",
          currentPlayer.moving || false,
          false,
          currentPlayer.mount_type || "unicorn",
          undefined,
          globalStateRevision,
          true
        );

        playersInMap.forEach((player) => {
          sendPacket(
            player.ws,
            packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: spell.cast_time })
          );
        });
        await new Promise((resolve) => setTimeout(resolve, spell.cast_time * 1000));

        // Check if spell was manually cancelled via ESC during cast time
        const updatedPlayer = playerCache.get(currentPlayer.id);
        if (updatedPlayer && updatedPlayer.manualSpellCancel && updatedPlayer.manualSpellCancel >= spellStartTime) {
          // Spell was cancelled during cast time, abort execution
          // Clear the manual cancel flag so next cast is allowed
          if (updatedPlayer.spellCooldowns) {
            delete updatedPlayer.spellCooldowns[spell_id];
          }
          delete updatedPlayer.manualSpellCancel;
          updatedPlayer.casting = false;
          playerCache.set(updatedPlayer.id, updatedPlayer);
          // Sync back to currentPlayer so ws.data stays current
          currentPlayer.spellCooldowns = updatedPlayer.spellCooldowns;
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
        // After cast, mounted should always be false (player was dismounted at start of cast)
        currentPlayer.mounted = false;
        playerCache.set(currentPlayer.id, currentPlayer);

        globalStateRevision++;
        await sendPositionAnimation(
          ws,
          currentPlayer.location.position?.direction || "down",
          currentPlayer.moving || false,
          false,
          currentPlayer.mount_type || "unicorn",
          undefined,
          globalStateRevision,
          false
        );

        let canAttack2: any = { value: true };

        if (isEntityTarget) {
          // Check if entity is still in returning state
          const entityState = entityAI.getEntityAIState(target.id);
          if (entityState && entityState.combatState === 'returning') {
            canAttack2 = { value: false, reason: "entity_returning" };
          } else {
            const entityAsPlayer = {
              ...target,
              location: {
                map: target.map,
                position: target.position
              },
              stats: { health: target.health }
            };
            canAttack2 = await player.canAttack(currentPlayer, entityAsPlayer,
              {
                width: 24,
                height: 40,
              },
              spell_range
            );
          }
        } else {
          canAttack2 = await player.canAttack(currentPlayer, target,
            {
              width: 24,
              height: 40,
            },
            spell_range
          );
        }

        if (canAttack2?.reason == "nopvp") {
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
            );
          });

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          return;
        }

        if (canAttack2?.reason == "path_blocked") {
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
            );
          });

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          return;
        }

        if (canAttack2?.reason == "direction") {
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
            );
          });

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          return;
        }

        if (canAttack2?.reason == "entity_returning") {
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
            );
          });

          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          return;
        }

        // If canAttack validation failed for any other reason, abort
        if (!canAttack2?.value) {
          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          return;
        }

        if (target.id !== currentPlayer.id) {
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.projectile({ id: currentPlayer.id, time: delay / 1000, target_id: target.id, spell: spell.name, icon: getIconUrl(spell.icon), entity: isEntityTarget })
            );
          });
        }
        await new Promise((resolve) => setTimeout(resolve, delay));

        const playerLevel = currentPlayer.stats.level || 1;

        const minDamage = spell_damage < 0 ?
          spell_damage - (playerLevel - 1) * 2 :
          spell_damage + (playerLevel - 1) * 2;
        const maxDamage = spell_damage < 0 ?
          spell_damage - (playerLevel - 1) * 5 :
          spell_damage + (playerLevel - 1) * 5;
        const spellDamage = Math.floor(Math.random() * (Math.abs(maxDamage - minDamage) + 1)) + Math.min(minDamage, maxDamage);

        const attackerDamageBonus = currentPlayer.stats.stat_damage || 0;
        const baseDamage = spellDamage + attackerDamageBonus;

        const critChance = currentPlayer.stats.stat_critical_chance || 0;
        const critDamage = currentPlayer.stats.stat_critical_damage || 0;
        const critRoll = Math.random() * 100;
        const isCrit = critRoll < critChance;

        let finalDamage = baseDamage;
        if (isCrit) {

          finalDamage = Math.floor(baseDamage * (1 + critDamage / 100));
        }

        log.debug(`[ATTACK] Damage calculation: spell=${spell_damage}, bonus=${attackerDamageBonus}, base=${baseDamage}, crit=${isCrit}, final=${finalDamage}`);

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
            playerCache.set(finalManaCheck.id, finalManaCheck);
          }
          return;
        }

        currentPlayer.stats.stamina = finalManaCheck.stats.stamina;
        currentPlayer.stats.stamina -= actualManaCost;

        if (currentPlayer.stats.stamina < 0) {
          currentPlayer.stats.stamina = 0;
        }

        if (isEntityTarget) {
          // Apply damage to entity using AI system with same calculation as players
          log.debug(`[ATTACK] Applying ${finalDamage} damage to entity ${target.id}. Current health: ${target.health}`);
          entityAI.applyDamageToEntity(target, finalDamage, currentPlayer);

          log.debug(`[ATTACK] Entity health after damage: ${target.health}`);

          // Clamp health to 0 if negative
          if (target.health < 0) {
            target.health = 0;
          }

          // Update entity health in cache only (not database - database is only updated on respawn/init)
          entityCache.updateHealth(target.id, target.health);

          // Broadcast entity damage to all players on the map
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          log.debug(`[ATTACK] Broadcasting damage to ${playersInMap.length} players on map`);
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.updateStats({
                id: ws.data.id,
                target: target.id,
                stats: { health: target.health, total_max_health: target.max_health },
                isCrit: isCrit,
                damage: finalDamage,
                entity: true,
              })
            );
          });

          // If entity died, broadcast despawn and remove from cache
          if (target.health <= 0) {
            log.debug(`[ATTACK] Entity ${target.id} died, broadcasting despawn`);
            const respawnTime = 30; // 30 seconds respawn time
            playersInMap.forEach((player) => {
              sendPacket(
                player.ws,
                packetManager.despawnEntity(target.id, respawnTime)
              );
            });
            // Remove entity from cache when despawned
            entityCache.remove(target.id);
          }
        } else {
          // Apply damage to player target
          target.stats.health = Math.round(target.stats.health - finalDamage);

          playerCache.set(currentPlayer.id, currentPlayer);

          if (target.stats.health > target.stats.total_max_health) {
            target.stats.health = target.stats.total_max_health;
          }

          if (target.stats.health <= 0) {

          const deathStats = { ...target.stats };

          target.stats.health = target.stats.total_max_health;
          target.stats.stamina = target.stats.total_max_stamina;

          const currentMapName = target.location.map;
          const respawnMapProps = mapPropertiesCache.find((m: any) => m.name === `${currentMapName}.json`);

          let respawnX: number;
          let respawnY: number;

          if (respawnMapProps?.graveyards && Array.isArray(respawnMapProps.graveyards) && respawnMapProps.graveyards.length > 0) {

            let closestGraveyard = respawnMapProps.graveyards[0];
            let closestDistance = Math.sqrt(
              Math.pow(target.location.position.x - closestGraveyard.position.x, 2) +
              Math.pow(target.location.position.y - closestGraveyard.position.y, 2)
            );

            for (const graveyard of respawnMapProps.graveyards) {
              const distance = Math.sqrt(
                Math.pow(target.location.position.x - graveyard.position.x, 2) +
                Math.pow(target.location.position.y - graveyard.position.y, 2)
              );

              if (distance < closestDistance) {
                closestDistance = distance;
                closestGraveyard = graveyard;
              }
            }

            respawnX = closestGraveyard.position.x;
            respawnY = closestGraveyard.position.y;
          } else {

            const defaultMapProps = mapPropertiesCache.find((m: any) => m.name === `${defaultMap}.json`);
            respawnX = defaultMapProps
              ? (defaultMapProps.width * defaultMapProps.tileWidth) / 2
              : 0;
            respawnY = defaultMapProps
              ? (defaultMapProps.height * defaultMapProps.tileHeight) / 2
              : 0;
          }

          target.location.position = { x: Math.round(respawnX), y: Math.round(respawnY), direction: "down" };

          const xp = 10;
          const xpResult = await player.increaseXp(currentPlayer.username, xp);

          const syncedStats = await player.synchronizeStats(currentPlayer.username);

          if (syncedStats) {
            currentPlayer.stats = syncedStats;
          }

          if (xpResult && typeof xpResult === 'object' && 'xp' in xpResult) {
            currentPlayer.stats.xp = xpResult.xp;
            currentPlayer.stats.level = xpResult.level;
            currentPlayer.stats.max_xp = xpResult.max_xp;
          }

          playerCache.set(currentPlayer.id, currentPlayer);

          sendPacket(
            ws,
            packetManager.updateXp({
              id: currentPlayer.id,
              xp: currentPlayer.stats.xp,
              level: currentPlayer.stats.level,
              max_xp: currentPlayer.stats.max_xp,
            })
          );

          sendPacket(
            ws,
            packetManager.updateStats({
              target: currentPlayer.id,
              stats: currentPlayer.stats,
            })
          );

          globalStateRevision++;
          playersInMap.forEach((player) => {

            sendPacket(
              player.ws,
              packetManager.updateStats({
                id: ws.data.id,
                target: target.id,
                stats: deathStats,
                isCrit: isCrit,
                damage: finalDamage,
              })
            );

            sendPacket(
              player.ws,
              packetManager.moveXY({
                i: target.id,
                d: {
                  x: Number(target.location.position.x),
                  y: Number(target.location.position.y),
                  dr: target.location.position.direction
                },
                r: globalStateRevision,
                s: target.isStealth ? 1 : 0
              })
            );

            sendPacket(
              player.ws,
              packetManager.revive({
                id: target.id,
                target: target.id,
                stats: target.stats,
              })
            );
          });

          sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
          sendStatsToPartyMembers(target.username, target.id, target.stats);
        } else {

          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.updateStats({
                id: ws.data.id,
                target: target.id,
                stats: target.stats,
                isCrit: isCrit,
                damage: finalDamage,
              })
            );

            sendPacket(
              player.ws,
              packetManager.updateStats({
                id: currentPlayer.id,
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );
          });

          sendStatsToPartyMembers(target.username, target.id, target.stats);
          sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
        }
        }

        // Update attacker stats regardless of target type
        playerCache.set(currentPlayer.id, currentPlayer);

        if (!isInParty && !isEntityTarget) {
          currentPlayer.pvp = true;
          target.pvp = true;
        }

        currentPlayer.last_attack = performance.now();
        if (!isEntityTarget) {
          target.last_attack = performance.now();
        }

        break;
      }
      case "CANCEL_SPELL": {
        if (!currentPlayer) return;

        // Treat ESC cancel as spell interruption
        const playersInMap = filterPlayersByMap(currentPlayer.location.map);
        playersInMap.forEach((player) => {
          sendPacket(
            player.ws,
            packetManager.castSpell({ id: currentPlayer.id, spell: 'interrupted', time: 1 })
          );
        });
        // Mark this as a manual cancel (not a movement interrupt)
        // Don't set lastInterruptTime to allow immediate recast
        currentPlayer.manualSpellCancel = performance.now();

        // Also update in playerCache so spell execution can detect it
        const cachedPlayer = playerCache.get(currentPlayer.id);
        if (cachedPlayer) {
          cachedPlayer.manualSpellCancel = performance.now();
          playerCache.set(cachedPlayer.id, cachedPlayer);
        }

        log.debug(`[SPELL] Player ${currentPlayer.username} cancelled spell via ESC`);
        break;
      }
      case "QUESTDETAILS": {
        const questId = data as unknown as number;
        const quest = await quests.find(questId);
        sendPacket(ws, packetManager.questDetails(quest));
        break;
      }
      case "STOPTYPING": {
        if (!currentPlayer || currentPlayer.isGuest) return;
        let playersInMap = filterPlayersByMap(currentPlayer.location.map);
        const stopTypingData = {
          id: ws.data.id,
        };
        if (currentPlayer.isStealth) {
          playersInMap = playersInMap.filter((p) => p.isAdmin);
        }
        playersInMap.forEach((player) => {
          sendPacket(player.ws, packetManager.stopTyping(stopTypingData));
        });
        break;
      }
      case "SAVE_MAP": {
        if (!currentPlayer) return;

        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        const hasPermission = perms.includes('server.admin') || perms.includes('server.*');

        if (!hasPermission) {
          sendPacket(ws, packetManager.notify({
            message: 'You do not have permission to save map changes.'
          }));
          return;
        }

        const saveData = data as unknown as { mapName: string, chunks: any[], graveyards?: any, warps?: any };

        try {
          log.info(`Map save requested by ${currentPlayer.username} for map: ${saveData.mapName}, ${saveData.chunks.length} chunks modified`);

          // Forward chunks to asset server via HTTP
          const assetServerUrl = process.env.ASSET_SERVER_URL || "http://localhost:8081";
          const authKey = process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY;

          const response = await fetch(`${assetServerUrl}/save-map-chunks`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              mapName: saveData.mapName,
              chunks: saveData.chunks,
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
              const syncResponse = await fetch(`${assetServerUrl}/save-map-properties`, {
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

          if (mapIndex !== -1) {
            // Update actual map layers with chunk data
            const mapData = cachedMaps[mapIndex].data;
            saveData.chunks.forEach((chunkData: any) => {
              const startX = chunkData.chunkX * chunkData.width;
              const startY = chunkData.chunkY * chunkData.height;

              for (const chunkLayer of chunkData.layers) {
                const mapLayer = mapData.layers.find((l: any) => l.name === chunkLayer.name);
                if (mapLayer && mapLayer.data) {
                  for (let y = 0; y < chunkData.height; y++) {
                    for (let x = 0; x < chunkData.width; x++) {
                      const chunkIndex = y * chunkData.width + x;
                      const mapX = startX + x;
                      const mapY = startY + y;
                      const mapIndex = mapY * mapLayer.width + mapX;
                      if (mapIndex < mapLayer.data.length && chunkIndex < chunkLayer.data.length) {
                        mapLayer.data[mapIndex] = chunkLayer.data[chunkIndex];
                      }
                    }
                  }
                }
              }
            });

            // Update graveyards and warps in the map data
            if (saveData.graveyards !== undefined) {
              cachedMaps[mapIndex].data.graveyards = saveData.graveyards;
            }
            if (saveData.warps !== undefined) {
              cachedMaps[mapIndex].data.warps = saveData.warps;
            }

            assetCache.add("maps", cachedMaps);

            // Also save chunks to disk locally for persistence
            try {
              await saveMapChunks(saveData.mapName, saveData.chunks);
            } catch (diskError) {
              log.warn(`Failed to save chunks to disk locally: ${diskError}`);
              // Don't fail the request if local disk save fails, asset server has the data
            }

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

            // Refresh collision cache since collision layer may have been updated
            try {
              const { reloadMap } = await import("../modules/assetloader");
              await reloadMap(saveData.mapName);
              // Clear the player.ts local map cache so collision checks fetch fresh data
              clearMapCache(saveData.mapName);
            } catch (reloadError) {
              log.warn(`Failed to reload map collision cache: ${reloadError}`);
            }
          }

          sendPacket(ws, packetManager.notify({
            message: `Map saved successfully! ${saveData.chunks.length} chunks updated.`
          }));

          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          const chunkCoords = saveData.chunks.map((chunk: any) => ({
            chunkX: chunk.chunkX,
            chunkY: chunk.chunkY
          }));

          playersInMap.forEach((player) => {
            sendPacket(player.ws, packetManager.updateChunks(chunkCoords));
          });
        } catch (error: any) {
          log.error(`Error saving map: ${error.message}`);
          sendPacket(ws, packetManager.notify({
            message: 'Error saving map changes.'
          }));
        }
        break;
      }
      case "SAVE_PARTICLE": {
        if (!currentPlayer) return;

        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        const hasPermission = perms.includes('server.admin') || perms.includes('server.*');

        if (!hasPermission) {
          sendPacket(ws, packetManager.notify({
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
              if (player.ws && player.ws.readyState === 1) { // readyState 1 = OPEN
                sendPacket(player.ws, updatePacket);
              }
            }
          }

          sendPacket(ws, packetManager.notify({
            message: 'Particle saved successfully'
          }));
        } catch (error: any) {
          log.error(`Error saving particle: ${error.message}`);
          sendPacket(ws, packetManager.notify({
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
          sendPacket(ws, packetManager.notify({
            message: 'You do not have permission to delete particles.'
          }));
          return;
        }

        try {
          const { name } = data as unknown as { name: string };
          await particles.remove({ name } as any);
          log.info(`Particle deleted by ${currentPlayer.username}: ${name}`);

          sendPacket(ws, packetManager.notify({
            message: 'Particle deleted successfully'
          }));
        } catch (error: any) {
          log.error(`Error deleting particle: ${error.message}`);
          sendPacket(ws, packetManager.notify({
            message: 'Error deleting particle.'
          }));
        }
        break;
      }
      case "LIST_PARTICLES": {
        if (!currentPlayer) return;

        try {
          const particleList = await particles.list();
          sendPacket(ws, packetManager.custom({
            type: "PARTICLE_LIST",
            data: particleList
          }));
        } catch (error: any) {
          log.error(`Error listing particles: ${error.message}`);
          sendPacket(ws, packetManager.notify({
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
          sendPacket(ws, packetManager.npcList(npcsInMap));
        } catch (error: any) {
          log.error(`Error listing NPCs: ${error.message}`);
          sendPacket(ws, packetManager.notify({ message: "Error loading NPCs." }));
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
          sendPacket(ws, packetManager.notify({ message: "You do not have permission to add NPCs." }));
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
            particles: clientData?.particles ?? [],
            quest: clientData?.quest ?? null,
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

          if (createdNpc) {
            const resolvedNpc = await resolveNpcForClient(createdNpc);
            const updatePacket = packetManager.npcUpdated(resolvedNpc);
            const playersInMap = filterPlayersByMap(mapName);
            for (const p of playersInMap) {
              if (p.ws && p.ws.readyState === 1) {
                sendPacket(p.ws, updatePacket);
              }
            }
          }

          log.info(`NPC added by ${currentPlayer.username} on map ${mapName}`);
        } catch (error: any) {
          log.error(`Error adding NPC: ${error.message}`);
          sendPacket(ws, packetManager.notify({ message: "Error adding NPC." }));
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
          sendPacket(ws, packetManager.notify({ message: "You do not have permission to save NPCs." }));
          return;
        }

        try {
          const npcData = data as unknown as Npc;
          if (!npcData?.id) {
            sendPacket(ws, packetManager.notify({ message: "Invalid NPC data." }));
            return;
          }

          await npcSystem.update(npcData);
          const updatedNpcs = await npcSystem.list();
          await assetCache.set("npcs", updatedNpcs);

          const updatedNpc = updatedNpcs.find((n: Npc) => n.id === npcData.id);
          if (updatedNpc) {
            const resolvedNpc = await resolveNpcForClient(updatedNpc);
            const updatePacket = packetManager.npcUpdated(resolvedNpc);
            const playersInMap = filterPlayersByMap(resolvedNpc.map);
            for (const p of playersInMap) {
              if (p.ws && p.ws.readyState === 1) {
                sendPacket(p.ws, updatePacket);
              }
            }
          }

          sendPacket(ws, packetManager.notify({ message: "NPC saved successfully." }));
          log.info(`NPC ${npcData.id} saved by ${currentPlayer.username}`);
        } catch (error: any) {
          log.error(`Error saving NPC: ${error.message}`);
          sendPacket(ws, packetManager.notify({ message: "Error saving NPC." }));
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
          sendPacket(ws, packetManager.notify({ message: "You do not have permission to move NPCs." }));
          return;
        }

        try {
          const { id, position } = data as unknown as { id: number; position: { x: number; y: number } };
          if (!id || !position) {
            sendPacket(ws, packetManager.notify({ message: "Invalid NPC move data." }));
            return;
          }

          const allNpcs = await assetCache.get("npcs") as Npc[];
          const existingNpc = (allNpcs || []).find((n: Npc) => n.id === id);
          if (!existingNpc) {
            sendPacket(ws, packetManager.notify({ message: "NPC not found." }));
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
              if (p.ws && p.ws.readyState === 1) {
                sendPacket(p.ws, updatePacket);
              }
            }
          }

          log.info(`NPC ${id} moved by ${currentPlayer.username}`);
        } catch (error: any) {
          log.error(`Error moving NPC: ${error.message}`);
          sendPacket(ws, packetManager.notify({ message: "Error moving NPC." }));
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
          sendPacket(ws, packetManager.notify({ message: "You do not have permission to delete NPCs." }));
          return;
        }

        try {
          const { id } = data as unknown as { id: number };
          if (!id) {
            sendPacket(ws, packetManager.notify({ message: "Invalid NPC ID." }));
            return;
          }

          const allNpcs = await assetCache.get("npcs") as Npc[];
          const existingNpc = (allNpcs || []).find((n: Npc) => n.id === id);
          if (!existingNpc) {
            sendPacket(ws, packetManager.notify({ message: "NPC not found." }));
            return;
          }

          const mapName = existingNpc.map;
          await npcSystem.remove({ id } as Npc);
          const updatedNpcs = await npcSystem.list();
          await assetCache.set("npcs", updatedNpcs);

          const removePacket = packetManager.npcRemoved(id);
          const playersInMap = filterPlayersByMap(mapName);
          for (const p of playersInMap) {
            if (p.ws && p.ws.readyState === 1) {
              sendPacket(p.ws, removePacket);
            }
          }

          sendPacket(ws, packetManager.notify({ message: "NPC deleted successfully." }));
          log.info(`NPC ${id} deleted by ${currentPlayer.username}`);
        } catch (error: any) {
          log.error(`Error deleting NPC: ${error.message}`);
          sendPacket(ws, packetManager.notify({ message: "Error deleting NPC." }));
        }
        break;
      }
      case "LIST_ENTITIES": {
        if (!currentPlayer) return;

        try {
          let allEntities = await assetCache.get("entities") as any[];
          if (!allEntities || allEntities.length === 0) {
            allEntities = await entitySystem.list();
          }
          const mapName = currentPlayer.location.map.replace(".json", "");
          const entitiesInMap = (allEntities || []).filter((e: any) => e.map === mapName);
          sendPacket(ws, packetManager.entityList(entitiesInMap));
        } catch (error: any) {
          log.error(`Error listing entities: ${error.message}`);
          sendPacket(ws, packetManager.notify({ message: "Error loading entities." }));
        }
        break;
      }
      case "ADD_ENTITY": {
        if (!currentPlayer) return;

        if (
          !currentPlayer.permissions.some(
            (p: string) => p === "server.admin" || p === "server.*"
          )
        ) {
          sendPacket(ws, packetManager.notify({ message: "You do not have permission to add entities." }));
          return;
        }

        try {
          const mapName = currentPlayer.location.map.replace(".json", "");
          const clientData = data as any;
          const newEntity: any = {
            id: null,
            last_updated: null,
            map: mapName,
            name: clientData?.name ?? null,
            position: {
              x: clientData?.position?.x ?? currentPlayer.location.position.x,
              y: clientData?.position?.y ?? currentPlayer.location.position.y,
              direction: clientData?.position?.direction ?? "down",
            },
            max_health: clientData?.max_health ?? 100,
            level: clientData?.level ?? 1,
            aggro_type: clientData?.aggro_type ?? 'neutral',
            aggro_range: clientData?.aggro_range ?? 300,
            speed: clientData?.speed ?? 2.0,
            aggro_leash: clientData?.aggro_leash ?? 600,
            particles: clientData?.particles ?? [],
            sprite_type: clientData?.sprite_type ?? 'animated',
            sprite_body: clientData?.sprite_body ?? 'player_body_base',
            sprite_head: clientData?.sprite_head ?? 'player_head_base',
            sprite_helmet: clientData?.sprite_helmet ?? null,
            sprite_shoulderguards: clientData?.sprite_shoulderguards ?? null,
            sprite_neck: clientData?.sprite_neck ?? null,
            sprite_hands: clientData?.sprite_hands ?? null,
            sprite_chest: clientData?.sprite_chest ?? null,
            sprite_feet: clientData?.sprite_feet ?? null,
            sprite_legs: clientData?.sprite_legs ?? null,
            sprite_weapon: clientData?.sprite_weapon ?? null,
          };

          await entitySystem.add(newEntity);
          const updatedEntities = await entitySystem.list();
          await assetCache.set("entities", updatedEntities);

          const createdEntity = updatedEntities
            .filter((e: any) => e.map === mapName)
            .sort((a: any, b: any) => (b.id ?? 0) - (a.id ?? 0))[0];

          if (createdEntity) {
            // Initialize AI and spawn data for the new entity
            entityAI.initializeEntityAI(createdEntity);

            // Add the new entity to the in-memory cache with health = max_health and isMoving = false
            const entityWithHealth = { ...createdEntity, health: createdEntity.max_health, isMoving: false };
            entityCache.add(entityWithHealth);

            // Broadcast entity with a small delay to ensure sprite data is ready
            setTimeout(() => {
              const resolvedEntity = { ...createdEntity, sprite_type: (createdEntity as any).sprite_type || 'animated', spriteLayers: getEntitySpriteLayers(createdEntity as any) };
              const updatePacket = packetManager.createEntity(resolvedEntity as any);
              const playersInMap = filterPlayersByMap(mapName);
              for (const p of playersInMap) {
                if (p.ws && p.ws.readyState === 1) {
                  sendPacket(p.ws, updatePacket);
                }
              }
            }, 100);
          }

          log.info(`Entity added by ${currentPlayer.username} on map ${mapName}`);
        } catch (error: any) {
          log.error(`Error adding entity: ${error.message}`);
          sendPacket(ws, packetManager.notify({ message: "Error adding entity." }));
        }
        break;
      }
      case "SAVE_ENTITY": {
        if (!currentPlayer) return;

        if (
          !currentPlayer.permissions.some(
            (p: string) => p === "server.admin" || p === "server.*"
          )
        ) {
          sendPacket(ws, packetManager.notify({ message: "You do not have permission to save entities." }));
          return;
        }

        try {
          const entityData = data as unknown as any;
          if (!entityData?.id) {
            sendPacket(ws, packetManager.notify({ message: "Invalid entity ID." }));
            return;
          }

          await entitySystem.update(entityData);
          const updatedEntities = await entitySystem.list();
          await assetCache.set("entities", updatedEntities);

          const mapName = entityData.map;
          const updatedEntity = updatedEntities.find((e: any) => e.id === entityData.id);
          if (updatedEntity) {
            // Update the entity in the in-memory cache (reset health to max_health)
            const cachedEntity = entityCache.getById(entityData.id);
            if (cachedEntity) {
              // Update properties from database and reset health to max_health
              Object.assign(cachedEntity, {
                ...updatedEntity,
                health: updatedEntity.max_health // Reset health to max_health when saving
              });
              // Reset hasMoved so the entity won't broadcast unless it actually moves
              (cachedEntity as any).hasMoved = false;
            } else {
              // Entity not in cache yet, add it with health = max_health and isMoving = false
              entityCache.add({ ...updatedEntity, health: updatedEntity.max_health, isMoving: false, hasMoved: false });
            }

            // Reset entity to its original spawn position
            const spawnData = entityAI.getEntitySpawnData(entityData.id);
            if (spawnData && spawnData.position && cachedEntity) {
              cachedEntity.position = {
                x: spawnData.position.x,
                y: spawnData.position.y,
                direction: spawnData.position.direction || 'down'
              };
            }

            // Reset entity AI state (aggro, target, etc.) when saving
            entityAI.resetEntityAI(entityData.id);

            // Include the in-memory health in the update packet to preserve health
            const resolvedEntity = {
              ...updatedEntity,
              sprite_type: (updatedEntity as any).sprite_type || 'animated',
              spriteLayers: getEntitySpriteLayers(updatedEntity as any),
              health: cachedEntity ? cachedEntity.health : updatedEntity.max_health
            };
            const updatePacket = packetManager.updateEntity(resolvedEntity as any);
            const playersInMap = filterPlayersByMap(mapName);
            for (const p of playersInMap) {
              if (p.ws && p.ws.readyState === 1) {
                sendPacket(p.ws, updatePacket);
              }
            }
          }

          log.info(`Entity ${entityData.id} saved by ${currentPlayer.username}`);
        } catch (error: any) {
          log.error(`Error saving entity: ${error.message}`);
          sendPacket(ws, packetManager.notify({ message: "Error saving entity." }));
        }
        break;
      }
      case "DELETE_ENTITY": {
        if (!currentPlayer) return;

        if (
          !currentPlayer.permissions.some(
            (p: string) => p === "server.admin" || p === "server.*"
          )
        ) {
          sendPacket(ws, packetManager.notify({ message: "You do not have permission to delete entities." }));
          return;
        }

        try {
          const { id } = data as unknown as { id: number };
          if (!id) {
            sendPacket(ws, packetManager.notify({ message: "Invalid entity ID." }));
            return;
          }

          const allEntities = await assetCache.get("entities") as any[];
          const existingEntity = (allEntities || []).find((e: any) => e.id === id);
          if (!existingEntity) {
            sendPacket(ws, packetManager.notify({ message: "Entity not found." }));
            return;
          }

          const mapName = existingEntity.map;
          await entitySystem.remove({ id } as any);
          const updatedEntities = await entitySystem.list();
          await assetCache.set("entities", updatedEntities);

          // Remove entity from in-memory cache
          entityCache.remove(id);

          const removePacket = packetManager.entityDied(id.toString());
          const playersInMap = filterPlayersByMap(mapName);
          for (const p of playersInMap) {
            if (p.ws && p.ws.readyState === 1) {
              sendPacket(p.ws, removePacket);
            }
          }

          sendPacket(ws, packetManager.notify({ message: "Entity deleted successfully." }));
          log.info(`Entity ${id} deleted by ${currentPlayer.username}`);
        } catch (error: any) {
          log.error(`Error deleting entity: ${error.message}`);
          sendPacket(ws, packetManager.notify({ message: "Error deleting entity." }));
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
            sendPacket(player.ws, packetManager.custom({
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
        if (currentPlayer.isGuest) {
          sendPacket(
            ws,
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
                ws,
                packetManager.notify({ message: "Please provide a message" })
              );
              break;
            }

            const partyId = await player.getPartyIdByUsername(
              currentPlayer.username
            );
            if (!partyId) {
              sendPacket(
                ws,
                packetManager.notify({ message: "You are not in a party" })
              );
              break;
            }

            const partyMembers = await parties.getPartyMembers(partyId);
            if (partyMembers.length === 0 || !partyMembers) {
              sendPacket(
                ws,
                packetManager.notify({ message: "You are not in a party" })
              );
              break;
            }

            partyMembers.forEach(async (member: any) => {
              const session_id = await player.getSessionIdByUsername(member);
              const memberPlayer = playerCache.get(session_id);
              if (memberPlayer) {
                sendPacket(
                  memberPlayer.ws,
                  packetManager.partyChat({
                    id: ws.data.id,
                    message,
                    username:
                      currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1),
                  })
                );
              }
            });

            break;
          }

          case "W":
          case "WHISPER": {
            const username = args[0]?.toLowerCase() || null;
            if (!username) {
              const notifyData = {
                message: "Please provide a username",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            sendPacket(
              targetPlayer.ws,
              packetManager.whisper({
                id: ws.data.id,
                message: args.slice(1).join(" "),

                username: `<- ${currentPlayer.username.charAt(0).toUpperCase() +
                  currentPlayer.username.slice(1)
                  }`,
              })
            );

            sendPacket(
              ws,
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
                ws,
                packetManager.notify({
                  message: "Usage: /invite <username>",
                })
              );
              break;
            }

            if (username === currentPlayer.username.toLowerCase()) {
              sendPacket(
                ws,
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
                ws,
                packetManager.notify({
                  message: `Player ${username} is not online.`,
                })
              );
              break;
            }

            if (targetPlayer.id === currentPlayer.id) {
              sendPacket(
                ws,
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
                ws,
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

            sendPacket(targetPlayer.ws, packetManager.invitation(invite_data));

            sendPacket(
              ws,
              packetManager.notify({
                message: `Invitation sent to ${targetPlayer.username.charAt(0).toUpperCase() +
                  targetPlayer.username.slice(1)
                  }`,
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const identifier = args[0]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot summon yourself",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.isAdmin) {
              const notifyData = {
                message: "You cannot summon other admins",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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

                targetPlayer.location.map = currentPlayer.location.map;
                targetPlayer.location.position = {
                  x: Math.round(currentPlayer.location.position.x),
                  y: Math.round(currentPlayer.location.position.y),
                  direction: targetPlayer.location.position?.direction || "down",
                };

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

                sendPacket(targetPlayer.ws, packetManager.reconnect());

                sendPacket(
                  targetPlayer.ws,
                  packetManager.notify({
                    message: `You have been summoned by an admin`,
                  })
                );

                sendPacket(
                  ws,
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
                sendPacket(ws, packetManager.notify(notifyData));
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
                    log.info(`[SUMMON] ${targetPlayer.username} moved to admin's layer ${adminLayerId}`);
                  }
                }
              }

              playerCache.set(targetPlayer.id, targetPlayer);

              await updatePlayerAOI(targetPlayer, sendAnimationTo, spawnBatchQueue, despawnBatchQueue);
              await updatePlayerAOI(currentPlayer, sendAnimationTo, spawnBatchQueue, despawnBatchQueue);

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
              };

              sendPacket(ws, packetManager.loadPlayers({
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
              await sendAnimationTo(ws, targetAnimationName, targetPlayer.id);

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
              sendPacket(targetPlayer.ws, packetManager.moveXY(targetMovementData));

              sendPacket(ws, packetManager.moveXY(targetMovementData));

              const allPlayers = playerCache.list();
              for (const playerId of currentPlayer.aoi.playersInAOI) {
                const otherPlayer = allPlayers[playerId as string];
                if (!otherPlayer || !otherPlayer.ws || otherPlayer.id === targetPlayer.id || otherPlayer.id === currentPlayer.id) continue;

                const canSeeTarget = !targetPlayer.isStealth || otherPlayer.isAdmin;
                if (canSeeTarget) {
                  sendPacket(otherPlayer.ws, packetManager.moveXY(targetMovementData));
                }
              }

              sendPacket(
                targetPlayer.ws,
                packetManager.notify({
                  message: `You have been summoned by an admin`,
                })
              );

              sendPacket(
                ws,
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const identifier = args[0]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot teleport to yourself",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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

                currentPlayer.location.map = targetPlayer.location.map;
                currentPlayer.location.position = {
                  x: Math.round(targetPlayer.location.position.x),
                  y: Math.round(targetPlayer.location.position.y),
                  direction: currentPlayer.location.position?.direction || "down",
                };

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

                sendPacket(ws, packetManager.reconnect());

                sendPacket(
                  ws,
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
                sendPacket(ws, packetManager.notify(notifyData));
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
                    log.info(`[TELEPORT] Admin ${currentPlayer.username} moved to target's layer ${targetLayerId}`);
                  }
                }
              }

              playerCache.set(currentPlayer.id, currentPlayer);

              await updatePlayerAOI(currentPlayer, sendAnimationTo, spawnBatchQueue, despawnBatchQueue);
              await updatePlayerAOI(targetPlayer, sendAnimationTo, spawnBatchQueue, despawnBatchQueue);

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
              };

              sendPacket(ws, packetManager.loadPlayers({
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
              await sendAnimationTo(ws, targetAnimationNameTeleport, targetPlayer.id);

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
              sendPacket(ws, packetManager.moveXY(adminMovementData));

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
              sendPacket(targetPlayer.ws, packetManager.moveXY(targetMovementData));

              broadcastToAOI(currentPlayer, packetManager.moveXY(adminMovementData), true);
              broadcastToAOI(targetPlayer, packetManager.moveXY(targetMovementData), true);

              sendPacket(
                ws,
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0].toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.isAdmin) {
              const notifyData = {
                message: "You cannot disconnect other admins",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            player.kick(targetPlayer.username, targetPlayer.ws);
            const notifyData = {
              message: `Disconnected ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } from the server`,
            };
            sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
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
                  sendPacket(player.ws, packetManager.notify(notifyData));
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
                  sendPacket(player.ws, packetManager.notify(notifyData));
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
                  sendPacket(player.ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0].toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot ban yourself",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.isAdmin) {
              const notifyData = {
                message: "You cannot ban other admins",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.banned) {
              const notifyData = {
                message: `${targetPlayer.username.charAt(0).toUpperCase() +
                  targetPlayer.username.slice(1)
                  } is already banned`,
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            await player.ban(targetPlayer.username, targetPlayer.ws);
            const notifyData = {
              message: `Banned ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } from the server`,
            };
            sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0] || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const targetPlayer = (await player.findPlayerInDatabase(
              identifier
            )) as { username: string; banned: number }[] as any[];
            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer[0].id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot unban yourself",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            await player.unban(targetPlayer[0].username);
            const notifyData = {
              message: `Unbanned ${targetPlayer[0].username} from the server`,
            };
            sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0].toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const admin = await player.toggleAdmin(targetPlayer.username);

            if (targetPlayer && targetPlayer.ws) {
              targetPlayer.isAdmin = admin;
              playerCache.set(targetPlayer.id, targetPlayer);
            }
            const notifyData = {
              message: `${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } is now ${admin ? "an admin" : "not an admin"}`,
            };

            if (targetPlayer?.ws) {
              sendPacket(targetPlayer.ws, packetManager.reconnect());
            }
            sendPacket(ws, packetManager.notify(notifyData));
            break;
          }

          case "WHITELIST": {
            // Check if whitelist is enabled
            const { isWhitelistEnabled } = await import("../socket/server.ts");
            if (!isWhitelistEnabled) {
              const notifyData = {
                message: "Whitelist is not enabled on this realm",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const whitelistMode = args[0]?.toLowerCase() || null;
            const whitelistUsername = args[1] || null;

            if (!whitelistMode || !["add", "remove"].includes(whitelistMode)) {
              const notifyData = {
                message: "Usage: /whitelist add|remove [username]",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (!whitelistUsername) {
              const notifyData = {
                message: `Usage: /whitelist ${whitelistMode} [username]`,
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            try {
              if (whitelistMode === "add") {
                if (whitelistUsername.toLowerCase() === currentPlayer.username.toLowerCase()) {
                  const notifyData = {
                    message: "You cannot add yourself to the whitelist",
                  };
                  sendPacket(ws, packetManager.notify(notifyData));
                  break;
                }
                const result = await player.whitelistAdd(whitelistUsername);
                const notifyData = {
                  message: result.message,
                };
                sendPacket(ws, packetManager.notify(notifyData));
              } else if (whitelistMode === "remove") {
                if (whitelistUsername.toLowerCase() === currentPlayer.username.toLowerCase()) {
                  const notifyData = {
                    message: "You cannot remove yourself from the whitelist",
                  };
                  sendPacket(ws, packetManager.notify(notifyData));
                  break;
                }
                const result = await player.whitelistRemove(whitelistUsername);
                const notifyData = {
                  message: result.message,
                };
                sendPacket(ws, packetManager.notify(notifyData));
              }
            } catch (error) {
              log.error(`Whitelist command error: ${error}`);
              const notifyData = {
                message: "An error occurred while processing the whitelist command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const players = Object.values(playerCache.list());
            players.forEach((player) => {
              const notifyData = {
                message:
                  "⚠️ Server shutting down - please reconnect in a few minutes ⚠️",
              };
              sendPacket(player.ws, packetManager.notify(notifyData));
            });

            await new Promise((resolve) => setTimeout(resolve, 5000));
            players.forEach((player) => {
              player.ws.close(1000, "Server is restarting");
            });

            const checkInterval = setInterval(async () => {
              const remainingPlayers = Object.values(playerCache.list());
              remainingPlayers.forEach((player) => {
                player.ws.close(1000, "Server is restarting");
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            sendPacket(ws, packetManager.toggleTileEditor());
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            sendPacket(ws, packetManager.toggleParticleEditor());
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            sendPacket(ws, packetManager.toggleNpcEditor());
            break;
          }

          case "EE":
          case "ENTITYEDITOR": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "tools.entity_editor" || p === "tools.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            sendPacket(ws, packetManager.toggleEntityEditor());
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
              sendPacket(ws, packetManager.notify(notifyData));
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
                sendPacket(player.ws, packetManager.notify(notifyData));
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
                    sendPacket(player.ws, packetManager.notify(notifyData));
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
                    sendPacket(player.ws, packetManager.notify(notifyData));
                  });
                }, RESTART_DELAY - seconds * 1000)
              );
            });

            restartTimers.push(
              setTimeout(() => {
                const players = Object.values(playerCache.list());
                players.forEach((player) => {
                  player.ws.close(1000, "Server is restarting");
                });

                const checkInterval = setInterval(async () => {
                  const remainingPlayers = Object.values(playerCache.list());
                  remainingPlayers.forEach((player) => {
                    player.ws.close(1000, "Server is restarting");
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
              sendPacket(ws, packetManager.notify(notifyData));
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
                sendPacket(ws, packetManager.notify(notifyData));
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
              playerCache.set(targetPlayer.id, targetPlayer);
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
                sendPacket(player.ws, packetManager.moveXY(moveData));
              });
            }

            const notifyData = {
              message: `Respawned ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                }`,
            };
            sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const mode = args[0]?.toUpperCase() || null;
            if (!mode) {
              const notifyData = {
                message: "Please provide a mode",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            const identifier = args[1]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // SECURITY: Always prevent self-modification regardless of permission level
            if (targetPlayer?.id === currentPlayer.id && mode !== "LIST") {
              const notifyData = {
                message: "You cannot modify your own permissions",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
                  sendPacket(ws, packetManager.notify(notifyData));
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
                  sendPacket(ws, packetManager.notify(notifyData));
                  return;
                }
              }
            }

            // Perform the permission modification
            switch (mode) {
              case "ADD": {
                await permissions.add(targetPlayer.username, permissionsArray.join(","));

                if (targetPlayer.ws) {
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
                sendPacket(ws, packetManager.notify(notifyData));
                break;
              }
              case "REMOVE": {
                await permissions.remove(
                  targetPlayer.username,
                  permissionsArray.join(",")
                );

                if (targetPlayer.ws) {
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
                sendPacket(ws, packetManager.notify(notifyData));
                break;
              }
              case "SET": {
                await permissions.set(targetPlayer.username, permissionsArray);

                if (targetPlayer.ws) {
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
                sendPacket(ws, packetManager.notify(notifyData));
                break;
              }
              case "CLEAR": {
                await permissions.clear(targetPlayer.username);

                targetPlayer.permissions = [];
                const p = playerCache.get(targetPlayer.id);
                if (p && p.ws) {
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
                sendPacket(ws, packetManager.notify(notifyData));
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
                sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const mapName = args[0]?.toLowerCase() || null;
            if (!mapName) {
              const notifyData = {
                message: "Please provide a map name",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const map = (maps as any[]).find(
              (m) => m.name === `${mapName}.json`
            );
            if (!map) {
              const notifyData = {
                message: `Map ${mapName} not found`,
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const result = (await reloadMap(mapName)) as MapData | null;
            if (result) {
              const notifyData = {
                message: `Map ${mapName} reloaded successfully`,
              };
              sendPacket(ws, packetManager.notify(notifyData));

              map.compressed = result.compressed;
              map.data = result.data;

              const playersInMap = filterPlayersByMap(mapName);
              const assetServerUrl = process.env.ASSET_SERVER_URL || "http://localhost:8081";
              const reloadedMapProps = mapPropertiesCache.find((m: any) => m.name === `${mapName}.json`);

              // Extract object layers from reloaded map data
              const reloadedObjectLayers = (result?.data?.layers || [])
                .filter((layer: any) => layer.type === "objectgroup")
                .map((layer: any) => ({ name: layer.name }));

              playersInMap.forEach((player) => {
                const mapMetadata = {
                  name: mapName,
                  assetServerUrl,
                  width: result?.data?.width || 0,
                  height: result?.data?.height || 0,
                  tilewidth: result?.data?.tilewidth || 32,
                  tileheight: result?.data?.tileheight || 32,
                  tilesets: result?.data?.tilesets || [], // Tileset metadata (not images, just definitions)
                  spawnX: player.location.position?.x || 0,
                  spawnY: player.location.position?.y || 0,
                  direction: player.location.position?.direction || "down",
                  chunks: null,
                  warps: reloadedMapProps?.warps || null,
                  graveyards: reloadedMapProps?.graveyards || null,
                  objectLayers: reloadedObjectLayers,
                };
                sendPacket(player.ws, packetManager.loadMap(mapMetadata));
              });
            } else {
              log.error(`Failed to reload map ${mapName}`);
              const notifyData = {
                message: `Failed to reload map ${mapName}`,
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const currentMapName = currentPlayer.location.map;

            const mapName = args[0]?.toLowerCase() || null;
            if (!mapName) {
              const notifyData = {
                message: "Please provide a map name",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (mapName === currentMapName) {
              const notifyData = {
                message: "You are already in this map",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const map = (maps as any[]).find(
              (map: MapData) => map.name === `${mapName}.json`
            );

            if (!map) {
              const notifyData = {
                message: "Map not found",
              };
              sendPacket(ws, packetManager.notify(notifyData));
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
                currentPlayer.location = {
                  map: mapName,
                  x: centerX,
                  y: centerY,
                  direction: currentPlayer.location.position?.direction || "down",
                };

                sendPacket(ws, packetManager.reconnect());
              } else {
                const notifyData = {
                  message: "Failed to update location",
                };
                sendPacket(ws, packetManager.notify(notifyData));
              }
              break;
            }

            break;
          }
          default: {
            const notifyData = {
              message: "Invalid command",
            };
            sendPacket(ws, packetManager.notify(notifyData));
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
            ws,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const isLeader = await parties.isPartyLeader(currentPlayer.username);
        if (!isLeader) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You are not the party leader" })
          );
          return;
        }

        const member = (data as any)?.username;
        if (!member) {
          sendPacket(
            ws,
            packetManager.notify({ message: "Please provide a username" })
          );
          return;
        }

        const members = await parties.getPartyMembers(partyId);
        if (!members || members?.length === 0) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        if (!members.includes(member)) {
          sendPacket(
            ws,
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
            ws,
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
              sendPacket(p.ws, packetManager.updateParty({ members: [] }));
              sendPacket(
                p.ws,
                packetManager.notify({
                  message: "The party has been disbanded",
                })
              );
              p.party = [];
              playerCache.set(p.id, p);
            }
          });
          return;
        }

        if (Array.isArray(result) && result.length > 0) {
          sendPacket(
            ws,
            packetManager.notify({
              message: `${member.charAt(0).toUpperCase() + member.slice(1)
                } has been kicked from the party`,
            })
          );
          currentPlayer.party = [];
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(ws, packetManager.updateParty({ members: [] }));

          result.forEach(async (m: string) => {
            const session_id = await player.getSessionIdByUsername(m);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              if (m !== member) {
                sendPacket(
                  p.ws,
                  packetManager.updateParty({ members: result })
                );
                sendPacket(
                  p.ws,
                  packetManager.notify({
                    message: `${currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1)
                      } has kicked ${member.charAt(0).toUpperCase() + member.slice(1)
                      } from the party`,
                  })
                );
                p.party = result;
              } else {
                sendPacket(p.ws, packetManager.updateParty({ members: [] }));
                sendPacket(
                  p.ws,
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
        }

        break;
      }
      case "LEAVE_PARTY": {
        if (!currentPlayer) return;

        const partyId = await parties.getPartyId(currentPlayer.username);
        if (!partyId) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const members = await parties.getPartyMembers(partyId);
        if (!members || members?.length === 0) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const result = await parties.leave(currentPlayer.username);

        const type = typeof result;
        if (type === "boolean" && !result) {
          sendPacket(
            ws,
            packetManager.notify({ message: "Failed to leave party" })
          );
          return;
        }

        if (type === "boolean" && result) {
          members.forEach(async (member: string) => {
            const session_id = await player.getSessionIdByUsername(member);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              sendPacket(p.ws, packetManager.updateParty({ members: [] }));
              sendPacket(
                p.ws,
                packetManager.notify({
                  message: "The party has been disbanded",
                })
              );
              p.party = [];
              playerCache.set(p.id, p);
            }
          });
          return;
        }

        if (type === "object" && (result as string[]).length > 0) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You have left the party" })
          );
          currentPlayer.party = [];
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(ws, packetManager.updateParty({ members: [] }));

          (result as string[]).forEach(async (member: string) => {
            const session_id = await player.getSessionIdByUsername(member);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              sendPacket(p.ws, packetManager.updateParty({ members: result }));
              sendPacket(
                p.ws,
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
        }
        break;
      }
      case "INVITE_PARTY": {
        const invited_user = (data as any).id;
        const invitedUser = playerCache.get(invited_user);
        const invitedUserUsername = invitedUser?.username || invited_user;
        if (!currentPlayer || !invited_user || !invitedUserUsername) return;

        if (currentPlayer.isGuest) {
          sendPacket(
            ws,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }

        if (invitedUser.isGuest) {
          sendPacket(
            ws,
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
              ws,
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
            ws,
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
            ws,
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
            ws,
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

        sendPacket(invitedUser.ws, packetManager.invitation(invite_data));
        sendPacket(
          ws,
          packetManager.notify({
            message: `Invitation sent to ${invitedUserUsername.charAt(0).toUpperCase() +
              invitedUserUsername.slice(1)
              }`,
          })
        );
        break;
      }
      case "ADD_FRIEND": {
        const id = (data as any).id;
        if (!id) return;

        if (!currentPlayer) return;

        if (currentPlayer.isGuest) {
          sendPacket(
            ws,
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
            ws,
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
            ws,
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

        sendPacket(get_friend.ws, packetManager.invitation(invite_data));
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
            ws,
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
          sendPacket(ws, packetManager.notify(notifyData));
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
                ws,
                packetManager.notify({
                  message: `You are now friends with ${inviter.username.charAt(0).toUpperCase() +
                    inviter.username.slice(1)
                    }`,
                })
              );
              sendPacket(
                ws,
                packetManager.updateFriends({
                  friends: updatedCurrentPlayersFriendsList,
                })
              );

              sendPacket(
                inviter.ws,
                packetManager.notify({
                  message: `You are now friends with ${currentPlayer.username.charAt(0).toUpperCase() +
                    currentPlayer.username.slice(1)
                    }`,
                })
              );

              sendPacket(
                inviter.ws,
                packetManager.updateFriends({ friends: updatedFriendsList })
              );
            }
            break;
          }
          case "INVITE_PARTY": {

            const partyId = await parties.getPartyId(inviter.username);
            if (response.toUpperCase() === "ACCEPT") {

              if (partyId) {

                const updatedPartyMembers = await parties.add(
                  currentPlayer.username.toLowerCase(),
                  partyId
                );
                if (!updatedPartyMembers) {
                  sendPacket(
                    ws,
                    packetManager.notify({ message: "Failed to join party" })
                  );
                  return;
                }
                sendPacket(
                  ws,
                  packetManager.notify({
                    message: `You have joined ${inviter.username.charAt(0).toUpperCase() +
                      inviter.username.slice(1)
                      }'s party`,
                  })
                );
                sendPacket(
                  inviter.ws,
                  packetManager.notify({
                    message: `${currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1)
                      } has joined your party`,
                  })
                );

                updatedPartyMembers.forEach(async (member: string) => {
                  const session_id = await player.getSessionIdByUsername(
                    member
                  );
                  const p = session_id && playerCache.get(session_id);
                  if (p) {
                    sendPacket(
                      p.ws,
                      packetManager.updateParty({
                        members: updatedPartyMembers,
                      })
                    );
                    p.party = updatedPartyMembers;
                    playerCache.set(p.id, p);
                  }
                });

                const partyLeader = await parties.getPartyLeader(partyId);
                if (partyLeader && updatedPartyMembers.length > 0) {
                  await syncPartyLayers(partyLeader, updatedPartyMembers as string[], playerCache, sendAnimationTo);
                }
              } else {

                const updatedPartyMembers = await parties.create(
                  inviter.username.toLowerCase(),
                  currentPlayer.username.toLowerCase()
                );
                if (!updatedPartyMembers) {
                  sendPacket(
                    ws,
                    packetManager.notify({ message: "Failed to create party" })
                  );
                  return;
                }
                sendPacket(
                  ws,
                  packetManager.notify({
                    message: `You have joined ${inviter.username.charAt(0).toUpperCase() +
                      inviter.username.slice(1)
                      }'s party`,
                  })
                );
                sendPacket(
                  inviter.ws,
                  packetManager.notify({
                    message: `${currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1)
                      } has joined your party`,
                  })
                );
                sendPacket(
                  inviter.ws,
                  packetManager.updateParty({ members: updatedPartyMembers })
                );
                sendPacket(
                  ws,
                  packetManager.updateParty({ members: updatedPartyMembers })
                );
                (updatedPartyMembers as string[]).forEach(
                  async (member: string) => {
                    const session_id = await player.getSessionIdByUsername(
                      member
                    );
                    const p = session_id && playerCache.get(session_id);
                    if (p) {
                      sendPacket(
                        p.ws,
                        packetManager.updateParty({
                          members: updatedPartyMembers,
                        })
                      );
                      p.party = updatedPartyMembers;
                      playerCache.set(p.id, p);
                    }
                  }
                );

                if (Array.isArray(updatedPartyMembers) && updatedPartyMembers.length > 0) {
                  await syncPartyLayers(inviter.username.toLowerCase(), updatedPartyMembers as string[], playerCache, sendAnimationTo);
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

        if (get_friend?.ws) {

          sendPacket(
            get_friend.ws,
            packetManager.updateFriends({
              friends: updatedCurrentPlayersFriendsList,
            })
          );
        }

        sendPacket(
          ws,
          packetManager.updateFriends({ friends: updatedFriendsList })
        );
        sendPacket(
          ws,
          packetManager.notify({
            message: `You have removed ${get_friend.username.charAt(0).toUpperCase() +
              get_friend.username.slice(1)
              } from your friends list`,
          })
        );
        break;
      }
      case "MOUNT": {
        if (!currentPlayer) return;

        // Prevent mounting while casting
        if (currentPlayer.casting) {
          sendPacket(
            ws,
            packetManager.notify({ message: "Cannot mount while casting." })
          );
          return;
        }

        // Prevent mounting when PvP flag is enabled
        if (currentPlayer.pvp) {
          sendPacket(
            ws,
            packetManager.notify({ message: "Cannot mount while in PvP." })
          );
          return;
        }

        const canMount = player.canMount(currentPlayer);
        const mount = (data as any).mount;
        if (!mount) {
          sendPacket(
            ws,
            packetManager.notify({ message: "No mount type specified." })
          );
          break;
        }

        if (!canMount) {
          sendPacket(
            ws,
            packetManager.notify({
              message: "Mount feature is currently locked.",
            })
          );
          break;
        }

        if (!currentPlayer.mounted) {

          const hasMount = currentPlayer.collectables.some((c: any) => c.type === "mount" && c.item === mount);
          if (!hasMount) {
            sendPacket(
              ws,
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
          ws,
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

          await packetReceiver(server, ws, JSON.stringify({ type: "MOVEXY", data: moveDirection }));
        }
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

          if (previouslyEquippedItem) {
            const previousItem = currentPlayer.inventory.find((invItem: any) => invItem.name.toLowerCase() === previouslyEquippedItem.toLowerCase());
            if (previousItem) {
              previousItem.equipped = false;
            }
          }

          currentPlayer.equipment[slot] = item;

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
              ws,
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

            const playersInMap = filterPlayersByMap(currentPlayer.location.map);

            playersInMap.forEach((player) => {
              sendPacket(
                player.ws,
                packetManager.updateStats({
                  target: currentPlayer.id,
                  stats: currentPlayer.stats,
                })
              );
            });

            if (slotIndex !== undefined) {
              sendPacket(
                ws,
                packetManager.clientConfig(currentPlayer.config || [])
              );
            }

            const freshInventory = await inventory.get(currentPlayer.username);
            currentPlayer.inventory = freshInventory;
            playerCache.set(currentPlayer.id, currentPlayer);

            sendPacket(
              ws,
              packetManager.inventory(currentPlayer.inventory)
            );
            sendPacket(
              ws,
              packetManager.equipment(currentPlayer.equipment)
            );

            const currentAnimationName = getAnimationNameForDirection(
              currentPlayer.location.position?.direction || "down",
              !!currentPlayer.moving,
              !!currentPlayer.mounted,
              currentPlayer.mount_type || undefined,
              !!currentPlayer.casting
            );
            await sendSpriteSheetAnimation(ws, currentAnimationName, currentPlayer.id);
          }
        }
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
              ws,
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

            const playersInMap = filterPlayersByMap(currentPlayer.location.map);

            playersInMap.forEach((player) => {
              sendPacket(
                player.ws,
                packetManager.updateStats({
                  target: currentPlayer.id,
                  stats: currentPlayer.stats,
                })
              );
            });

            if (targetSlotIndex !== undefined) {
              sendPacket(
                ws,
                packetManager.clientConfig(currentPlayer.config || [])
              );
            }

            const freshInventory = await inventory.get(currentPlayer.username);
            currentPlayer.inventory = freshInventory;
            playerCache.set(currentPlayer.id, currentPlayer);

            sendPacket(
              ws,
              packetManager.inventory(currentPlayer.inventory)
            );
            sendPacket(
              ws,
              packetManager.equipment(currentPlayer.equipment)
            );

            const currentAnimationName = getAnimationNameForDirection(
              currentPlayer.location.position?.direction || "down",
              !!currentPlayer.moving,
              !!currentPlayer.mounted,
              currentPlayer.mount_type || undefined,
              !!currentPlayer.casting
            );
            await sendSpriteSheetAnimation(ws, currentAnimationName, currentPlayer.id);
          }
        }
        break;
      }
      case "RESPAWN_ENTITY": {
        // This is a client-side notification that entity respawn timer has expired
        // The actual respawn is handled server-side by the entityAI system
        // This handler just validates the request
        if (!data || !(data as any).id) return;

        log.debug(`Client requested respawn for entity ${(data as any).id}`);
        // Server-side respawn is already handled by entityAI setTimeout in handleEntityDeath
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

        sendPacket(ws, packetManager.onlinePlayersList(playerList));
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

function filterPlayersByDistance(ws: any, distance: number, map: string) {
  const players = filterPlayersByMap(map);
  const currentPlayer = playerCache.get(ws.data.id);
  return players.filter((p) => {
    const pPos = typeof p.location.position === 'string'
      ? { x: Number(p.location.position.split(',')[0]), y: Number(p.location.position.split(',')[1]) }
      : p.location.position;
    const currPos = typeof currentPlayer.location.position === 'string'
      ? { x: Number(currentPlayer.location.position.split(',')[0]), y: Number(currentPlayer.location.position.split(',')[1]) }
      : currentPlayer.location.position;
    const dx = (pPos?.x ?? 0) - (currPos?.x ?? 0);
    const dy = (pPos?.y ?? 0) - (currPos?.y ?? 0);
    return Math.sqrt(dx * dx + dy * dy) <= distance;
  });
}

function tryParsePacket(data: any) {
  try {
    return JSON.parse(data.toString());
  } catch (e) {
    log.error(e as string);
    return undefined;
  }
}

function sendPacket(ws: any, packets: any[]) {
  if (!ws || !ws.send || ws.readyState !== 1) {

    return;
  }
  try {
    packets.forEach((packet) => {
      ws.send(packet);
    });
  } catch (error) {
    log.error(`Failed to send packet: ${error}`);
  }
}

async function sendStatsToPartyMembers(playerUsername: string, playerId: string, stats: any) {

  const partyId = await parties.getPartyId(playerUsername);
  if (!partyId) return;

  const partyMembers = await parties.getPartyMembers(partyId);
  if (!partyMembers || partyMembers.length === 0) return;

  for (const memberName of partyMembers) {
    if (memberName.toLowerCase() === playerUsername.toLowerCase()) continue;

    const sessionId = await player.getSessionIdByUsername(memberName);
    const partyMember = sessionId && playerCache.get(sessionId);

    if (partyMember && partyMember.ws) {
      sendPacket(
        partyMember.ws,
        packetManager.updateStats({
          target: playerId,
          username: playerUsername,
          stats: stats,
        })
      );
    }
  }
}

async function sendSpriteSheetAnimation(ws: any, name: string, playerId?: string, revision?: number) {
  const currentPlayer = playerCache.get(playerId || ws.data.id);
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

  broadcastToAOI(currentPlayer, packetManager.spriteSheetAnimation(spriteSheetPacketData), true);
}

async function sendAnimation(ws: any, name: string, playerId?: string, revision?: number) {
  const currentPlayer = playerCache.get(playerId || ws.data.id);
  if (!currentPlayer) return;

  if (!useSpriteSheets) {
    log.warn(`Sprite sheet system disabled in config for player ${currentPlayer.id}`);
    return;
  }

  if (!(await isSpriteSheetSystemAvailable())) {
    log.warn(`Sprite sheet system not available for player ${currentPlayer.id}`);
    return;
  }

  await sendSpriteSheetAnimation(ws, name, playerId, revision);
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
  ws: WebSocket,
  direction: string,
  walking: boolean,
  mounted: boolean = false,
  mount_type: string = "",
  playerId?: string,
  revision?: number,
  casting: boolean = false
) {
  const animation = getAnimationNameForDirection(direction, walking, mounted, mount_type, casting);
  await sendAnimation(ws, animation, playerId, revision);
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