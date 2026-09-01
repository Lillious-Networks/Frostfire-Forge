import AOI_CONFIG from "../config/aoi.json";
import log from "../modules/logger";
import playerCache from "../services/playermanager";
import layerManager from "../services/layermanager";
import { getEffectsPayload } from "../systems/spelleffects";
import mapIndex from "../services/mapindex";
import parties from "../systems/parties";
import { packetManager } from "./packet_manager";
import spatialGrid from "../services/spatialgrid";
import * as aoiReverse from "../services/aoiReverseIndex";

// A player is only removed from an AOI once they are this many times the AOI
// radius away - not the instant they cross it. Prevents despawn/respawn packet
// churn for players lingering near the boundary. Enter still uses the plain
// radius, so the band between 1.0x and this value is "sticky, don't re-add".
const AOI_EXIT_HYSTERESIS = (AOI_CONFIG as any).EXIT_HYSTERESIS ?? 1.25;

export interface PlayerAOIState {

  playersInAOI: Set<string>;

  gridX: number;
  gridY: number;

  aoiRadius: number;

  lastAOIUpdatePosition: { x: number; y: number };

  updateThreshold: number;

  mapChangeSequence: number;

  layerId: string | null;
}

// Chunk loadPlayers frames: a single frame with many sprite-laden players can
// exceed the transport's per-stream queue limit (~256KB) and destroy the
// stream. Splitting keeps each frame below that ceiling.
export function sendLoadPlayersChunked(
  sendPacket: (ws: any, packets: any) => void,
  ws: any,
  players: any[],
  snapshotRevision: number | null,
  chunkSize = 8
): void {
  for (let i = 0; i < players.length; i += chunkSize) {
    sendPacket(ws, packetManager.loadPlayers({ players: players.slice(i, i + chunkSize), snapshotRevision }));
  }
}

export async function initializePlayerAOI(player: any): Promise<void> {
  const pos = player.location.position;
  const mapName = player.location.map.replaceAll(".json", "");

  let layerId: string;

  if (player.party_id) {
    const partyId = player.party_id;
    const partyLeader = await parties.getPartyLeader(partyId);
    const partyMembers = await parties.getPartyMembers(partyId);
    const isLeader = partyLeader?.toLowerCase() === player.username?.toLowerCase();

    const allPlayers = playerCache.list();
    const memberSet = new Set(partyMembers.map((m: string) => m.toLowerCase()));
    const onlinePartyPlayers = Object.values(allPlayers).filter((p: any) =>
      p.username && memberSet.has(p.username.toLowerCase()) &&
      p.aoi?.layerId &&
      p.location.map.replaceAll(".json", "") === mapName
    );

    if (onlinePartyPlayers.length > 0) {
      if (isLeader) {

        const layerCounts = new Map<string, number>();
        onlinePartyPlayers.forEach((p: any) => {
          if (p.aoi?.layerId) {
            layerCounts.set(p.aoi.layerId, (layerCounts.get(p.aoi.layerId) || 0) + 1);
          }
        });

        let maxCount = 0;
        let targetLayer = null;
        for (const [layer, count] of layerCounts.entries()) {
          if (count > maxCount) {
            maxCount = count;
            targetLayer = layer;
          }
        }

        if (targetLayer) {
          const targetLayerInfo = layerManager.getLayerInfo(targetLayer);
          if (targetLayerInfo && targetLayerInfo.playerCount < AOI_CONFIG.MAX_PLAYERS_PER_LAYER) {
            layerId = layerManager.assignPlayerToLayer(player.id, mapName, targetLayer);
          } else {
            layerId = layerManager.assignPlayerToLayer(player.id, mapName);
          }
        } else {
          layerId = layerManager.assignPlayerToLayer(player.id, mapName);
        }
      } else {

        const leaderPlayer = onlinePartyPlayers.find((p: any) =>
          p.username?.toLowerCase() === partyLeader?.toLowerCase()
        );

        if (leaderPlayer && leaderPlayer.aoi?.layerId) {
          const leaderLayerId = leaderPlayer.aoi.layerId;
          const leaderLayerInfo = layerManager.getLayerInfo(leaderLayerId);

          if (leaderLayerInfo && leaderLayerInfo.playerCount < AOI_CONFIG.MAX_PLAYERS_PER_LAYER) {
            layerId = layerManager.assignPlayerToLayer(player.id, mapName, leaderLayerId);
          } else {

            layerId = layerManager.assignPlayerToLayer(player.id, mapName);
          }
        } else {

          layerId = layerManager.assignPlayerToLayer(player.id, mapName);
        }
      }
    } else {

      layerId = layerManager.assignPlayerToLayer(player.id, mapName);
    }
  } else {

    layerId = layerManager.assignPlayerToLayer(player.id, mapName);
  }

  if (player.aoi) return;

  player.aoi = {
    playersInAOI: new Set<string>(),
    gridX: Math.floor(pos.x / AOI_CONFIG.GRID_CELL_SIZE),
    gridY: Math.floor(pos.y / AOI_CONFIG.GRID_CELL_SIZE),
    aoiRadius: AOI_CONFIG.DEFAULT_RADIUS,
    lastAOIUpdatePosition: { x: pos.x, y: pos.y },
    updateThreshold: AOI_CONFIG.UPDATE_THRESHOLD,
    mapChangeSequence: 0,
    layerId: layerId,
    revision: 0,
  };

  if (AOI_CONFIG.USE_SPATIAL_GRID) {
    spatialGrid.addPlayer(player.id, pos.x, pos.y, mapName);
  }
}

function filterPlayersByDistance(
  sourcePlayer: any,
  radius: number,
  map: string
): any[] {
  const radiusSquared = radius * radius;
  const sourcePos = sourcePlayer.location.position;
  const sourceLayerId = sourcePlayer.aoi?.layerId;
  const sourceMap = map.replaceAll(".json", "");
  const result: any[] = [];

  // AOI candidates are always same-layer (players on other layers are separate
  // instances). Iterate the layer's membership - capped at
  // MAX_PLAYERS_PER_LAYER (~50) - rather than a spatial-grid radius query.
  //
  // With the DEFAULT_RADIUS of 1000 and a 512px grid cell, a radius query pulls
  // a 5x5 cell block; at a spawn hotspot with thousands of players clustered
  // that block holds thousands of candidates, nearly all on other layers. The
  // old code scanned every one of them (playerCache.get + layer check + dist)
  // just to arrive at a <=50-entry result. That was ~57ms per AOI update at
  // high pop and it ran per moving player per throttle window - the loop fell
  // ~10x behind budget.
  if (sourceLayerId) {
    for (const playerId of layerManager.getPlayersInLayer(sourceLayerId)) {
      if (playerId === sourcePlayer.id) continue;
      const player = playerCache.get(playerId);
      if (!player || !player.location) continue;

      const dx = player.location.position.x - sourcePos.x;
      const dy = player.location.position.y - sourcePos.y;
      if (dx * dx + dy * dy <= radiusSquared) {
        result.push(player);
      }
    }
    return result;
  }

  // No layer assigned (shouldn't normally happen): fall back to a map scan.
  const players = playerCache.list();
  for (const playerId in players) {
    const player = players[playerId];
    if (player.id === sourcePlayer.id) continue;

    const playerMap = player.location.map.replaceAll(".json", "");
    if (playerMap !== sourceMap) continue;
    if (player.aoi?.layerId) continue;

    const dx = player.location.position.x - sourcePos.x;
    const dy = player.location.position.y - sourcePos.y;
    if (dx * dx + dy * dy <= radiusSquared) {
      result.push(player);
    }
  }

  return result;
}

function sendPacket(ws: any, packets: any[]) {
  if (!ws || !ws.send || ws.readyState !== 1) return;
  try {
    packets.forEach((packet) => {
      ws.send(packet);
    });
  } catch (error) {
    // Silently ignore packet send errors
  }
}

export function queueSpawnPlayerPacket(
  spawnedPlayer: any
): any {
  if (!spawnedPlayer) return null;

  try {

    const spawnData = {
      id: spawnedPlayer.id,
      userid: spawnedPlayer.userid,
      location: {
        map: spawnedPlayer.location.map,
        x: spawnedPlayer.location.position.x,
        y: spawnedPlayer.location.position.y,
        direction: spawnedPlayer.location.position.direction,
        moving: spawnedPlayer.moving || false,
      },
      username: spawnedPlayer.username,
      isAdmin: spawnedPlayer.isAdmin,
      isGuest: spawnedPlayer.isGuest,
      isStealth: spawnedPlayer.isStealth,
      isVanished: spawnedPlayer.isVanished,
      isNoclip: spawnedPlayer.isNoclip,
      stats: spawnedPlayer.stats,
      mounted: spawnedPlayer.mounted,
      animation: null,
      spriteData: null,
      guild: spawnedPlayer.guild || [],
      guild_name: spawnedPlayer.guild_name || null,
      effects: getEffectsPayload(spawnedPlayer),
    };

    return spawnData;
  } catch (error) {
    return null;
  }
}

export function broadcastPlayerUpdate(player: any): void {
  if (!player || !player.aoi) return;

  const spawnData = queueSpawnPlayerPacket(player);
  if (!spawnData) return;

  // Encode once - the frame is byte-identical for every viewer.
  const spawnFrames = packetManager.spawnPlayer(spawnData);

  const viewers = findPlayersWithTargetInAOI(player.id);
  for (const viewer of viewers) {
    if (viewer.ws) {
      sendPacket(viewer.ws, spawnFrames);
    }
  }
}

export const aoiProf = {
  calls: 0,
  filterMs: 0,
  enteredLoopMs: 0,
  exitedLoopMs: 0,
  tailMs: 0,
  candidateTotal: 0,
  enteredTotal: 0,
  exitedTotal: 0,
  maxCandidates: 0,
};
const AOI_PROFILE =
  process.env.BENCHMARK_PROFILE === "1" || process.env.BENCHMARK_PROFILE === "true";

export async function updatePlayerAOI(
  player: any,
  spawnBatchQueue?: Map<string, Map<string, any>>,
  despawnBatchQueue?: Map<string, Set<string>>
): Promise<void> {
  if (!player || !player.aoi) {
    return;
  }

  const currentMap = player.location.map;
  const currentPos = player.location.position;
  const aoiRadius = player.aoi.aoiRadius;
  const currentSequence = player.aoi.mapChangeSequence;

  try {
    const _p0 = AOI_PROFILE ? performance.now() : 0;

    const playersInRange = filterPlayersByDistance(
      player,
      aoiRadius,
      currentMap
    );

    const _p1 = AOI_PROFILE ? performance.now() : 0;

    if (AOI_CONFIG.USE_SPATIAL_GRID) {
      spatialGrid.updatePlayer(player.id, currentPos.x, currentPos.y, currentMap);
    }

    if (player.aoi.mapChangeSequence !== currentSequence) {
      return;
    }

    const newAOISet = new Set(playersInRange.map((p) => p.id));
    const oldAOISet = player.aoi.playersInAOI;

    const enteredAOI: string[] = [...newAOISet].filter(id => !oldAOISet.has(id));

    // Exit hysteresis: a player who has merely crossed the AOI radius is NOT
    // dropped until they are past radius * AOI_EXIT_HYSTERESIS. Without this, a
    // player jittering back and forth across the boundary (very common - normal
    // wandering near another player) generates a despawn + re-spawn packet pair
    // on every AOI update. At scale that was ~19k exit events per 5s, each an
    // encode + send + reverse-index mutation, and it dominated the AOI cost.
    //
    // Skipped entirely when the visible set changed wholesale (a warp / map
    // change - oldAOISet is from the old map, none of it is "near the boundary"
    // in any meaningful sense; treating it as sticky just makes a big pointless
    // loop and keeps stale cross-map viewers around for a frame).
    const wholesaleChange =
      oldAOISet.size > 0 && enteredAOI.length === newAOISet.size;
    const exitRadiusSq = aoiRadius * aoiRadius * (AOI_EXIT_HYSTERESIS * AOI_EXIT_HYSTERESIS);
    const exitedAOI: string[] = [];
    for (const id of oldAOISet) {
      if (newAOISet.has(id)) continue;
      if (!wholesaleChange) {
        const other = playerCache.get(id as string);
        if (other && other.location && other.aoi?.layerId === player.aoi.layerId) {
          const ex = other.location.position.x - currentPos.x;
          const ey = other.location.position.y - currentPos.y;
          if (ex * ex + ey * ey <= exitRadiusSq) {
            // Still within the hysteresis band - keep them visible.
            newAOISet.add(id as string);
            continue;
          }
        }
      }
      exitedAOI.push(id as string);
    }

    const _p2 = AOI_PROFILE ? performance.now() : 0;

    for (const enteredPlayerId of enteredAOI) {
      const enteredPlayer = playerCache.get(enteredPlayerId);
      if (!enteredPlayer) {
        continue;
      }

      const playerForceSeeEntered = player.forceVisibleTo?.has(enteredPlayer.id);
      const enteredPlayerForceSeePlayer = enteredPlayer.forceVisibleTo?.has(player.id);
      const canSeeEntered = !enteredPlayer.isStealth && !enteredPlayer.isVanished || player.isAdmin || playerForceSeeEntered || player.party?.includes(enteredPlayer.username);
      const canSeePlayer = !player.isStealth && !player.isVanished || enteredPlayer.isAdmin || enteredPlayerForceSeePlayer || enteredPlayer.party?.includes(player.username);

      if (canSeeEntered && spawnBatchQueue) {
        const spawnData = queueSpawnPlayerPacket(enteredPlayer);
        if (spawnData) {
          if (!spawnBatchQueue.has(player.id)) {
            spawnBatchQueue.set(player.id, new Map());
          }
          spawnBatchQueue.get(player.id)!.set(enteredPlayer.id, spawnData);
        }
      }

      if (canSeePlayer && spawnBatchQueue) {
        const spawnData = queueSpawnPlayerPacket(player);
        if (spawnData) {
          if (!spawnBatchQueue.has(enteredPlayer.id)) {
            spawnBatchQueue.set(enteredPlayer.id, new Map());
          }
          spawnBatchQueue.get(enteredPlayer.id)!.set(player.id, spawnData);
        }
      }

      if (!enteredPlayer.aoi) {
        await initializePlayerAOI(enteredPlayer);
      }
      enteredPlayer.aoi.playersInAOI.add(player.id);
      // enteredPlayer can now see `player`.
      aoiReverse.addViewer(player.id, enteredPlayer.id);
      enteredPlayer.aoi.revision = (enteredPlayer.aoi.revision || 0) + 1;
      playerCache.set(enteredPlayer.id, enteredPlayer);

    }

    const _p3 = AOI_PROFILE ? performance.now() : 0;
    if (AOI_PROFILE) {
      const c = playersInRange.length;
      aoiProf.calls++;
      aoiProf.filterMs += _p1 - _p0;
      aoiProf.enteredLoopMs += _p3 - _p2;
      aoiProf.candidateTotal += c;
      aoiProf.enteredTotal += enteredAOI.length;
      aoiProf.exitedTotal += exitedAOI.length;
      if (c > aoiProf.maxCandidates) aoiProf.maxCandidates = c;
    }

    for (const exitedPlayerId of exitedAOI) {
      const exitedPlayer = playerCache.get(exitedPlayerId);

      if (despawnBatchQueue) {
        if (!despawnBatchQueue.has(player.id)) {
          despawnBatchQueue.set(player.id, new Set());
        }
        despawnBatchQueue.get(player.id)!.add(exitedPlayerId);
      } else {
        sendPacket(player.ws, packetManager.despawnPlayer(exitedPlayerId, "distance"));
      }

      if (exitedPlayer && exitedPlayer.ws) {

        if (exitedPlayer.ws && exitedPlayer.ws.readyState === 1) {
          sendPacket(
            exitedPlayer.ws,
            packetManager.despawnPlayer(player.id, "distance")
          );
        } else if (despawnBatchQueue) {

          if (!despawnBatchQueue.has(exitedPlayer.id)) {
            despawnBatchQueue.set(exitedPlayer.id, new Set());
          }
          despawnBatchQueue.get(exitedPlayer.id)!.add(player.id);
        }

        if (exitedPlayer.aoi) {
          exitedPlayer.aoi.playersInAOI.delete(player.id);
          // exitedPlayer can no longer see `player`.
          aoiReverse.removeViewer(player.id, exitedPlayer.id);
          exitedPlayer.aoi.revision = (exitedPlayer.aoi.revision || 0) + 1;
          playerCache.set(exitedPlayer.id, exitedPlayer);
        }
      }
    }

    // `player`'s own visible set is being replaced wholesale; reindex the diff
    // so the reverse index reflects who `player` can now see.
    aoiReverse.replaceVisibleSet(player.id, oldAOISet, newAOISet);
    player.aoi.playersInAOI = newAOISet;
    if (enteredAOI.length > 0 || exitedAOI.length > 0) {
      player.aoi.revision = (player.aoi.revision || 0) + 1;
    }
    player.aoi.lastAOIUpdatePosition = { x: currentPos.x, y: currentPos.y };
    player.aoi.gridX = Math.floor(currentPos.x / AOI_CONFIG.GRID_CELL_SIZE);
    player.aoi.gridY = Math.floor(currentPos.y / AOI_CONFIG.GRID_CELL_SIZE);

    playerCache.set(player.id, player);

    if (AOI_PROFILE) {
      const now = performance.now();
      aoiProf.exitedLoopMs += now - _p3;
      // tailMs: replaceVisibleSet + assignments after the exited loop.
    }
  } catch (error) {
    // Silently ignore AOI update errors
  }
}

export function shouldUpdateAOI(player: any): boolean {
  if (!player || !player.aoi) return false;

  const currentPos = player.location.position;
  const lastPos = player.aoi.lastAOIUpdatePosition;

  const dx = currentPos.x - lastPos.x;
  const dy = currentPos.y - lastPos.y;
  const distanceMoved = Math.sqrt(dx * dx + dy * dy);

  const shouldUpdate = distanceMoved > player.aoi.updateThreshold;
  return shouldUpdate;
}

export function broadcastToAOI(
  sourcePlayer: any,
  packetData: any[],
  includeSelf: boolean = true
): void {
  if (!sourcePlayer || !sourcePlayer.aoi) {
    return;
  }

  try {

    if (includeSelf && sourcePlayer.ws) {
      sendPacket(sourcePlayer.ws, packetData);
    }

    const playersInAOI = Array.from(sourcePlayer.aoi.playersInAOI)
      .map((id) => playerCache.get(id as string))
      .filter((p) => p && p.ws);

    if (sourcePlayer.isStealth || sourcePlayer.isVanished) {

      const visibleTo = playersInAOI.filter((p) => p.isAdmin || p.party?.includes(sourcePlayer.username));
      visibleTo.forEach((player) => {
        sendPacket(player.ws, packetData);
      });
    } else {

      playersInAOI.forEach((player) => {
        sendPacket(player.ws, packetData);
      });
    }
  } catch (error) {
    // Silently ignore broadcast errors
  }
}

function sendPacketBestEffort(ws: any, packetData: any[]) {
  if (!ws || typeof ws.sendBestEffort !== "function" || ws.readyState !== 1) return;
  try {
    packetData.forEach((packet) => {
      ws.sendBestEffort(packet);
    });
  } catch (error) {
    // Silently ignore best-effort send errors
  }
}

/**
 * Like broadcastToAOI but delivered as unreliable datagrams (loss-tolerant
 * packets: stats, cast bars, animations, etc.). Datagrams bypass the stream
 * backpressure queue, so callers must only send latest-wins payloads.
 */
export function broadcastToAOIBestEffort(
  sourcePlayer: any,
  packetData: any[],
  includeSelf: boolean = true
): void {
  if (!sourcePlayer || !sourcePlayer.aoi) {
    return;
  }

  try {
    const receivers = new Set<any>();

    if (includeSelf && sourcePlayer.ws) {
      receivers.add(sourcePlayer);
    }

    const playersInAOI = Array.from(sourcePlayer.aoi.playersInAOI)
      .map((id) => playerCache.get(id as string))
      .filter((p) => p && p.ws);

    const visibleTo = sourcePlayer.isStealth || sourcePlayer.isVanished
      ? playersInAOI.filter((p) => p.isAdmin || p.party?.includes(sourcePlayer.username))
      : playersInAOI;

    for (const player of visibleTo) {
      receivers.add(player);
    }

    for (const player of receivers) {
      sendPacketBestEffort(player.ws, packetData);
    }
  } catch (error) {
    // Silently ignore broadcast errors
  }
}

/**
 * Broadcast a stats update (UPDATESTATS) as datagrams to the union of the
 * target's and caster's AOI sets, deduplicated. Replaces map-wide broadcasts:
 * observers who can see either combatant get the damage popup and fresh
 * absolute stats, everyone else self-corrects via the 1Hz regen tick.
 */
export function broadcastStatsUpdateToAOI(
  target: any,
  caster: any,
  packetData: any[]
): void {
  const receivers = new Map<string, any>();

  const collect = (source: any) => {
    if (!source || !source.aoi) return;
    if (source.ws) receivers.set(String(source.id), source);
    for (const id of source.aoi.playersInAOI) {
      const p = playerCache.get(id as string);
      if (p && p.ws) receivers.set(String(id), p);
    }
  };

  try {
    collect(target);
    collect(caster);
    for (const player of receivers.values()) {
      sendPacketBestEffort(player.ws, packetData);
    }
  } catch (error) {
    // Silently ignore broadcast errors
  }
}

/**
 * Broadcast a packet as datagrams to players on a map whose AOI radius covers
 * the given position. Used for entity-targeted stats broadcasts (entities are
 * not tracked in playersInAOI, so position distance stands in for visibility).
 */
export function broadcastToAOIBestEffortAtPosition(
  x: number,
  y: number,
  map: string,
  packetData: any[]
): void {
  if (!map) return;

  const playerIds = mapIndex.getPlayersOnMap(map);
  for (const playerId of playerIds) {
    const p = playerCache.get(playerId);
    if (!p || !p.ws || p.ws.readyState !== 1) continue;
    const pos = p.location?.position;
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") continue;
    const radius = p.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS;
    const dx = pos.x - x;
    const dy = pos.y - y;
    if (dx * dx + dy * dy > radius * radius) continue;
    sendPacketBestEffort(p.ws, packetData);
  }
}

export function findPlayersWithTargetInAOI(targetId: number | string): any[] {
  // O(viewers) via the reverse index instead of an O(all players) cache scan.
  // The index is the source of truth (it normalises ids to strings, which the
  // raw `playersInAOI.has()` check did not); we only re-validate that the
  // viewer still exists and is a live AOI participant.
  const result: any[] = [];
  for (const viewerId of aoiReverse.getViewers(targetId)) {
    const player = playerCache.get(viewerId);
    if (player && player.aoi) {
      result.push(player);
    }
  }
  return result;
}

export function despawnPlayerFromAllAOI(
  departingPlayer: any,
  reason: "map_change" | "disconnect" = "map_change",
  despawnBatchQueue?: Map<string, Set<string>>
): void {
  if (!departingPlayer || !departingPlayer.aoi) return;

  try {

    const affectedPlayers = findPlayersWithTargetInAOI(departingPlayer.id);

    affectedPlayers.forEach((player) => {
      if (despawnBatchQueue) {

        if (!despawnBatchQueue.has(player.id)) {
          despawnBatchQueue.set(player.id, new Set());
        }
        despawnBatchQueue.get(player.id)!.add(departingPlayer.id);
      } else {

        sendPacket(
          player.ws,
          packetManager.despawnPlayer(departingPlayer.id, reason)
        );
      }

      if (player.aoi) {
        player.aoi.playersInAOI.delete(departingPlayer.id);
        // `player` can no longer see the departing player.
        aoiReverse.removeViewer(departingPlayer.id, player.id);
        player.aoi.revision = (player.aoi.revision || 0) + 1;
        playerCache.set(player.id, player);
      }
    });

    // Nobody sees the departing player any more, on either map. Also drop the
    // departing player as a viewer of everyone else: on disconnect its forward
    // set is cleared below; on map_change it keeps a stale set that the
    // follow-up updatePlayerAOI would otherwise diff against, but clearing here
    // keeps the reverse index tight regardless.
    aoiReverse.clearViewed(departingPlayer.id);
    aoiReverse.clearViewer(departingPlayer.id);

    if (reason === "disconnect") {
      departingPlayer.aoi.playersInAOI.clear();
      departingPlayer.aoi.revision = (departingPlayer.aoi.revision || 0) + 1;
      layerManager.removePlayerFromLayer(departingPlayer.id);

      if (AOI_CONFIG.USE_SPATIAL_GRID) {
        spatialGrid.removePlayer(departingPlayer.id);
      }
    }
  } catch (error) {
    // Silently ignore despawn errors
  }
}

export async function handleMapChangeAOI(
  player: any,
  newMapName: string,
  newPosition: { x: number; y: number },
  spawnBatchQueue?: Map<string, Map<string, any>>,
  despawnBatchQueue?: Map<string, Set<string>>
): Promise<void> {
  if (!player) return;

  try {

    if (!player.aoi) {
      await initializePlayerAOI(player);
    }

    const oldMapName = player.location.map;

    const oldMap = oldMapName.replaceAll(".json", "");
    const newMap = newMapName.replaceAll(".json", "");

    if (oldMap !== newMap) {

      player.aoi.mapChangeSequence++;

      despawnPlayerFromAllAOI(player, "map_change", undefined);

      const newLayerId = layerManager.assignPlayerToLayer(player.id, newMap);
      player.aoi.layerId = newLayerId;

      if (AOI_CONFIG.USE_SPATIAL_GRID) {
        spatialGrid.removePlayer(player.id);
        spatialGrid.addPlayer(player.id, newPosition.x, newPosition.y, newMap);
      }
    }

    const oldMapForIndex = player.location.map;
    player.location.map = newMapName;
    player.location.position.x = Math.round(newPosition.x);
    player.location.position.y = Math.round(newPosition.y);

    if (oldMap !== newMap) {
      mapIndex.movePlayer(player.id, oldMapForIndex, newMapName);
    }
    player.aoi.gridX = Math.floor(newPosition.x / AOI_CONFIG.GRID_CELL_SIZE);
    player.aoi.gridY = Math.floor(newPosition.y / AOI_CONFIG.GRID_CELL_SIZE);
    player.aoi.lastAOIUpdatePosition = { x: newPosition.x, y: newPosition.y };
    playerCache.set(player.id, player);

    const _mcStart = AOI_PROFILE ? performance.now() : 0;
    await updatePlayerAOI(player, spawnBatchQueue, despawnBatchQueue);
    if (AOI_PROFILE) {
      const dt = performance.now() - _mcStart;
      if (dt > 20) {
        log.info(`[profile:mapchange] updatePlayerAOI ${oldMap}->${newMap} took ${dt.toFixed(0)}ms`);
      }
    }
  } catch (error) {
    // Silently ignore map change errors
  }
}

export function getPlayerLayerInfo(playerId: string): { layerId: string | null; layerName: string | null } {
  const player = playerCache.get(playerId);
  if (!player || !player.aoi) {
    return { layerId: null, layerName: null };
  }

  const layerId = player.aoi.layerId;
  const layerName = layerId ? layerManager.getLayerName(layerId) : null;

  return { layerId, layerName };
}

export { layerManager };

interface AOIPlayer {
  id: string;
  username: string;
  aoi?: PlayerAOIState;
  ws?: any;
  location: { map: string; position: { x: number; y: number; direction?: string } };
  moving?: boolean;
  mounted?: boolean;
  mount_type?: string;
  casting?: boolean;
  isAdmin?: boolean;
  forceVisibleTo?: Set<string>;
  isStealth?: boolean;
  isNoclip?: boolean;
  stats?: any;
  isGuest?: boolean;
  userid?: string;
}

export async function syncPartyLayers(
  partyLeaderUsername: string,
  partyMemberUsernames: string[],
  playerCache: any,
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): Promise<void> {
  try {

    const allPlayers: { [id: string]: AOIPlayer } = playerCache.list();

    const leaderPlayer = Object.values(allPlayers).find((p: AOIPlayer) =>
      p.username && p.username.toLowerCase() === partyLeaderUsername.toLowerCase()
    );

    if (!leaderPlayer || !leaderPlayer.aoi) {
      return;
    }

    const onlineMembers: any[] = [];
    const memberPlayerIds: string[] = [];

    const usernameIndex = new Map<string, any>();
    for (const player of Object.values(allPlayers)) {
      if (player.username) {
        usernameIndex.set(player.username.toLowerCase(), player);
      }
    }

    const leaderLower = partyLeaderUsername.toLowerCase();
    for (const memberUsername of partyMemberUsernames) {
      if (memberUsername.toLowerCase() === leaderLower) {
        continue;
      }

      const memberPlayer = usernameIndex.get(memberUsername.toLowerCase());

      if (memberPlayer && memberPlayer.aoi) {
        onlineMembers.push(memberPlayer);
        memberPlayerIds.push(memberPlayer.id);
      }
    }

    if (onlineMembers.length === 0) {
      return;
    }

    const mapName = leaderPlayer.location.map.replaceAll(".json", "");

    const membersOnSameMap = onlineMembers.filter(m =>
      m.location.map.replaceAll(".json", "") === mapName
    );

    if (membersOnSameMap.length === 0) {
      return;
    }

    const memberIdsOnSameMap = membersOnSameMap.map(m => m.id);

    const targetLayerId = layerManager.syncPartyToLeaderLayer(
      leaderPlayer.id,
      memberIdsOnSameMap,
      mapName
    );

    if (!targetLayerId) {
      return;
    }

    const spawnBatchQueue = new Map<string, Map<string, any>>();
    const despawnBatchQueue = new Map<string, Set<string>>();

    const movedPlayers: any[] = [];

    for (const member of membersOnSameMap) {
      const oldLayerId = member.aoi?.layerId;
      const actualLayerId = layerManager.getPlayerLayer(member.id);

      if (actualLayerId && actualLayerId !== oldLayerId && member.aoi) {
        member.aoi.layerId = actualLayerId;
        playerCache.set(member.id, member);
        movedPlayers.push({ player: member, oldLayerId });
      }
    }

    for (const { player } of movedPlayers) {
      despawnPlayerFromAllAOI(player, "map_change", despawnBatchQueue);
    }

    for (const { player } of movedPlayers) {
      await updatePlayerAOI(player, spawnBatchQueue, despawnBatchQueue);
    }

    let totalSpawns = 0;
    let totalDespawns = 0;

    for (const [playerId, spawnsMap] of spawnBatchQueue.entries()) {
      const player = playerCache.get(playerId);
      if (player && player.ws) {
        const spawnsArray = Array.from(spawnsMap.values());
        if (spawnsArray.length > 0) {
          totalSpawns += spawnsArray.length;
          sendLoadPlayersChunked(sendPacket, player.ws, spawnsArray, null);

          for (const spawnData of spawnsArray) {
            const spawnedPlayer = playerCache.get(spawnData.id);
            if (spawnedPlayer && spawnedPlayer.location?.position?.direction) {

              const direction = spawnedPlayer.location.position.direction;
              const walking = spawnedPlayer.moving || false;
              const mounted = spawnedPlayer.mounted || false;
              const mountType = spawnedPlayer.mount_type || "unicorn";
              const casting = spawnedPlayer.casting || false;

              let animationName: string;

              if (casting) {
                const castAction = walking ? "cast_walk" : "cast_idle";
                animationName = `player_${castAction}_${direction}.png`;
              } else if (mounted) {
                const action = walking ? "walk" : "idle";
                animationName = `mount_${mountType}_${action}_${direction}.png`;
              } else {
                const action = walking ? "walk" : "idle";
                animationName = `player_${action}_${direction}.png`;
              }

              await sendAnimationToFn(player.ws, animationName, spawnedPlayer.id);
            }
          }
        }
      }
    }

    for (const [playerId, despawnSet] of despawnBatchQueue.entries()) {
      const player = playerCache.get(playerId);
      if (player && player.ws) {
        if (despawnSet.size > 0) {
          totalDespawns += despawnSet.size;
          despawnSet.forEach((despawnPlayerId) => {
            sendPacket(player.ws, packetManager.despawnPlayer(despawnPlayerId, "map_change"));
          });
        }
      }
    }

  } catch (error) {
    // Silently ignore party layer sync errors
  }
}

export function startAutoPartyLayerSync(
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): void {
  setInterval(async () => {
    try {

      const allParties = await parties.getAllParties();

      if (!allParties || allParties.length === 0) {
        return;
      }

      const allPlayers = playerCache.list();

      const usernameIndex = new Map<string, any>();
      for (const player of Object.values(allPlayers)) {
        if (player.username) {
          usernameIndex.set(player.username.toLowerCase(), player);
        }
      }

      for (const party of allParties) {
        if (!party.leader || !party.members || party.members.length === 0) {
          continue;
        }

        const leaderPlayer = usernameIndex.get(party.leader.toLowerCase());

        if (!leaderPlayer || !leaderPlayer.aoi?.layerId) {
          continue;
        }

        const leaderLayerId = leaderPlayer.aoi.layerId;
        const leaderMapName = leaderPlayer.location.map.replaceAll(".json", "");

        const onlineMembers: any[] = [];
        let needsSync = false;
        const leaderLower = party.leader.toLowerCase();

        for (const memberUsername of party.members) {
          if (memberUsername.toLowerCase() === leaderLower) {
            continue;
          }

          const memberPlayer = usernameIndex.get(memberUsername.toLowerCase());

          if (memberPlayer && memberPlayer.aoi?.layerId) {
            const memberMapName = memberPlayer.location.map.replaceAll(".json", "");

            if (memberMapName === leaderMapName) {
              onlineMembers.push(memberPlayer);

              if (memberPlayer.aoi.layerId !== leaderLayerId) {
                needsSync = true;
              }
            }
          }
        }

        if (needsSync && onlineMembers.length > 0) {
          await syncPartyLayers(
            party.leader,
            party.members,
            playerCache,
            sendAnimationToFn
          );
        }
      }
    } catch (error) {
      // Silently ignore auto party sync errors
    }
  }, 15000);
}

export function startAutoLayerCondensation(
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): void {
  setInterval(async () => {
    try {
      const stats = layerManager.getStats();

      if (stats.totalLayers <= 1) {
        return;
      }

      const layersByMap = new Map<string, Array<{ layerId: string; playerCount: number; players: string[] }>>();

      for (const [layerId, layerInfo] of layerManager.getAllLayers().entries()) {
        const mapName = layerInfo.mapName;
        if (!layersByMap.has(mapName)) {
          layersByMap.set(mapName, []);
        }
        layersByMap.get(mapName)!.push({
          layerId: layerId,
          playerCount: layerInfo.playerCount,
          players: Array.from(layerInfo.players)
        });
      }

      for (const [_, layers] of layersByMap.entries()) {
        if (layers.length <= 1) {
          continue;
        }

        layers.sort((a, b) => a.playerCount - b.playerCount);

        // Only condense if we have layers that are significantly underfilled
        const underfilled = layers.filter(l => l.playerCount < 25).length;
        if (underfilled === 0) {
          continue; // No need to condense if all layers are reasonably filled
        }

        let condensed = false;
        const spawnBatchQueue = new Map<string, Map<string, any>>();
        const despawnBatchQueue = new Map<string, Set<string>>();

        for (let i = 0; i < layers.length - 1; i++) {
          const sourceLayer = layers[i];

          // Skip empty layers and layers with reasonable population
          if (sourceLayer.playerCount === 0 || sourceLayer.playerCount >= 25) {
            continue;
          }

          // Find a suitable target: must have space and not be over-full after merge
          let targetLayerIndex = -1;
          for (let j = i + 1; j < layers.length; j++) {
            const targetLayer = layers[j];
            // Check actual layerManager to get current state, not the temporary array
            const actualLayerInfo = layerManager.getLayerInfo(targetLayer.layerId);
            if (!actualLayerInfo) continue;

            const actualAvailableSpace = AOI_CONFIG.MAX_PLAYERS_PER_LAYER - actualLayerInfo.playerCount;
            const resultingSize = actualLayerInfo.playerCount + sourceLayer.playerCount;

            // Only merge if: 1) source fits, and 2) result won't be over-full
            if (actualAvailableSpace >= sourceLayer.playerCount && resultingSize <= AOI_CONFIG.MAX_PLAYERS_PER_LAYER) {
              targetLayerIndex = j;
              break; // Take the first suitable target
            }
          }

          if (targetLayerIndex === -1) {
            continue; // No suitable target found
          }

          const targetLayer = layers[targetLayerIndex];

          for (const playerId of sourceLayer.players) {
            const player = playerCache.get(playerId);
            if (!player || !player.aoi) continue;

            layerManager.removePlayerFromLayer(playerId);
            const targetLayerInfo = layerManager.getLayerInfo(targetLayer.layerId);
            if (targetLayerInfo) {
              targetLayerInfo.players.add(playerId);
              targetLayerInfo.playerCount++;

              (layerManager as any).playerToLayer.set(playerId, targetLayer.layerId);
            }

            player.aoi.layerId = targetLayer.layerId;
            playerCache.set(playerId, player);

            despawnPlayerFromAllAOI(player, "map_change", despawnBatchQueue);

            await updatePlayerAOI(player, spawnBatchQueue, despawnBatchQueue);
          }

          // Update actual layerManager state instead of temporary array
          const actualTargetInfo = layerManager.getLayerInfo(targetLayer.layerId);
          if (actualTargetInfo) {
            targetLayer.playerCount = actualTargetInfo.playerCount;
            targetLayer.players = Array.from(actualTargetInfo.players);
          }

          sourceLayer.playerCount = 0;
          sourceLayer.players = [];
          condensed = true;
        }

        if (condensed) {

          for (const [playerId, spawnsMap] of spawnBatchQueue.entries()) {
            const player = playerCache.get(playerId);
            if (player && player.ws) {
              const spawnsArray = Array.from(spawnsMap.values());
              if (spawnsArray.length > 0) {
                sendLoadPlayersChunked(sendPacket, player.ws, spawnsArray, null);

                for (const spawnData of spawnsArray) {
                  const spawnedPlayer = playerCache.get(spawnData.id);
                  if (spawnedPlayer && spawnedPlayer.location?.position?.direction) {
                    const direction = spawnedPlayer.location.position.direction;
                    const walking = spawnedPlayer.moving || false;
                    const mounted = spawnedPlayer.mounted || false;
                    const mountType = spawnedPlayer.mount_type || "unicorn";
                    const casting = spawnedPlayer.casting || false;

                    let animationName: string;
                    if (casting) {
                      const castAction = walking ? "cast_walk" : "cast_idle";
                      animationName = `player_${castAction}_${direction}.png`;
                    } else if (mounted) {
                      const action = walking ? "walk" : "idle";
                      animationName = `mount_${mountType}_${action}_${direction}.png`;
                    } else {
                      const action = walking ? "walk" : "idle";
                      animationName = `player_${action}_${direction}.png`;
                    }

                    await sendAnimationToFn(player.ws, animationName, spawnedPlayer.id);
                  }
                }
              }
            }
          }

          for (const [playerId, despawnSet] of despawnBatchQueue.entries()) {
            const player = playerCache.get(playerId);
            if (player && player.ws && despawnSet.size > 0) {
              despawnSet.forEach((despawnPlayerId) => {
                sendPacket(player.ws, packetManager.despawnPlayer(despawnPlayerId, "map_change"));
              });
            }
          }

        }
      }
    } catch (error) {
      // Silently ignore auto layer condensation errors
    }
  }, 300000);
}
