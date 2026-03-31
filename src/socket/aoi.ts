import AOI_CONFIG from "../config/aoi.json";
import playerCache from "../services/playermanager";
import layerManager from "../services/layermanager";
import mapIndex from "../services/mapindex";
import parties from "../systems/parties";
import { packetManager } from "./packet_manager";
import log from "../modules/logger";
import spatialGrid from "../services/spatialgrid";

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
            layerId = targetLayer;
            layerManager.removePlayerFromLayer(player.id);
            const layer = layerManager.getLayerInfo(targetLayer)!;
            layer.players.add(player.id);
            layer.playerCount++;
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
            layerId = leaderLayerId;
            layerManager.removePlayerFromLayer(player.id);
            const layer = layerManager.getLayerInfo(leaderLayerId)!;
            layer.players.add(player.id);
            layer.playerCount++;
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

  player.aoi = {
    playersInAOI: new Set<string>(),
    gridX: Math.floor(pos.x / AOI_CONFIG.GRID_CELL_SIZE),
    gridY: Math.floor(pos.y / AOI_CONFIG.GRID_CELL_SIZE),
    aoiRadius: AOI_CONFIG.DEFAULT_RADIUS,
    lastAOIUpdatePosition: { x: pos.x, y: pos.y },
    updateThreshold: AOI_CONFIG.UPDATE_THRESHOLD,
    mapChangeSequence: 0,
    layerId: layerId,
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

  if (AOI_CONFIG.USE_SPATIAL_GRID) {

    const candidateIds = spatialGrid.getPlayersInRadius(
      sourcePos.x,
      sourcePos.y,
      radius,
      sourceMap
    );

    for (const playerId of candidateIds) {
      const player = playerCache.get(playerId);
      if (!player) continue;

      if (player.id === sourcePlayer.id) continue;

      const playerLayerId = player.aoi?.layerId;
      if (playerLayerId !== sourceLayerId) continue;

      const dx = player.location.position.x - sourcePos.x;
      const dy = player.location.position.y - sourcePos.y;
      const distSquared = dx * dx + dy * dy;

      if (distSquared <= radiusSquared) {
        result.push(player);
      }
    }
  } else {

    const players = playerCache.list();

    for (const playerId in players) {
      const player = players[playerId];

      if (player.id === sourcePlayer.id) continue;

      const playerMap = player.location.map.replaceAll(".json", "");
      if (playerMap !== sourceMap) continue;

      const playerLayerId = player.aoi?.layerId;
      if (playerLayerId !== sourceLayerId) continue;

      const dx = player.location.position.x - sourcePos.x;
      const dy = player.location.position.y - sourcePos.y;
      const distSquared = dx * dx + dy * dy;

      if (distSquared <= radiusSquared) {
        result.push(player);
      }
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
      isNoclip: spawnedPlayer.isNoclip,
      stats: spawnedPlayer.stats,
      mounted: spawnedPlayer.mounted,
      animation: null,
      spriteData: null,
    };

    return spawnData;
  } catch (error) {
    return null;
  }
}

export async function updatePlayerAOI(
  player: any,
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>,
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

    const playersInRange = filterPlayersByDistance(
      player,
      aoiRadius,
      currentMap
    );

    if (player.aoi.mapChangeSequence !== currentSequence) {
      return;
    }

    const newAOISet = new Set(playersInRange.map((p) => p.id));
    const oldAOISet = player.aoi.playersInAOI;

    const enteredAOI: string[] = [...newAOISet].filter(id => !oldAOISet.has(id));
    const exitedAOI: string[] = [...oldAOISet].filter(id => !newAOISet.has(id));

    for (const enteredPlayerId of enteredAOI) {
      const enteredPlayer = playerCache.get(enteredPlayerId);
      if (!enteredPlayer) {
        continue;
      }

      const playerForceSeeEntered = player.forceVisibleTo?.has(enteredPlayer.id);
      const enteredPlayerForceSeePlayer = enteredPlayer.forceVisibleTo?.has(player.id);
      const canSeeEntered = !enteredPlayer.isStealth || player.isAdmin || playerForceSeeEntered;
      const canSeePlayer = !player.isStealth || enteredPlayer.isAdmin || enteredPlayerForceSeePlayer;

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
      playerCache.set(enteredPlayer.id, enteredPlayer);

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
          playerCache.set(exitedPlayer.id, exitedPlayer);
        }
      }
    }

    player.aoi.playersInAOI = newAOISet;
    player.aoi.lastAOIUpdatePosition = { x: currentPos.x, y: currentPos.y };
    player.aoi.gridX = Math.floor(currentPos.x / AOI_CONFIG.GRID_CELL_SIZE);
    player.aoi.gridY = Math.floor(currentPos.y / AOI_CONFIG.GRID_CELL_SIZE);

    if (AOI_CONFIG.USE_SPATIAL_GRID) {
      const mapName = currentMap.replaceAll(".json", "");
      const cellChanged = spatialGrid.updatePlayer(player.id, currentPos.x, currentPos.y, mapName);
    }

    playerCache.set(player.id, player);
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

    if (sourcePlayer.isStealth) {

      const visibleTo = playersInAOI.filter((p) => p.isAdmin);
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

export function findPlayersWithTargetInAOI(targetId: string): any[] {
  const allPlayers = Object.values(playerCache.list());
  return allPlayers.filter(
    (player) => player.aoi && player.aoi.playersInAOI.has(targetId)
  );
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
        playerCache.set(player.id, player);
      }
    });

    if (reason === "disconnect") {
      departingPlayer.aoi.playersInAOI.clear();
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
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>,
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

    await updatePlayerAOI(player, sendAnimationToFn, spawnBatchQueue, despawnBatchQueue);
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

    const playersNeedingUpdate: any[] = [];

    const leaderOldLayerId = leaderPlayer.aoi?.layerId;

    if (leaderPlayer.aoi) {
      playersNeedingUpdate.push({ player: leaderPlayer, oldLayerId: leaderOldLayerId });

      leaderPlayer.aoi.layerId = targetLayerId;
      playerCache.set(leaderPlayer.id, leaderPlayer);
    }

    for (const member of membersOnSameMap) {
      const oldLayerId = member.aoi?.layerId;

      if (member.aoi) {
        playersNeedingUpdate.push({ player: member, oldLayerId: oldLayerId });

        member.aoi.layerId = targetLayerId;
        playerCache.set(member.id, member);
      }
    }

    for (const { player, oldLayerId } of playersNeedingUpdate) {
      if (oldLayerId !== targetLayerId) {

        despawnPlayerFromAllAOI(player, "map_change", despawnBatchQueue);
      }
    }

    for (const { player } of playersNeedingUpdate) {

      await updatePlayerAOI(player, sendAnimationToFn, spawnBatchQueue, despawnBatchQueue);
    }

    let totalSpawns = 0;
    let totalDespawns = 0;

    for (const [playerId, spawnsMap] of spawnBatchQueue.entries()) {
      const player = playerCache.get(playerId);
      if (player && player.ws) {
        const spawnsArray = Array.from(spawnsMap.values());
        if (spawnsArray.length > 0) {
          totalSpawns += spawnsArray.length;
          sendPacket(player.ws, packetManager.loadPlayers({ players: spawnsArray, snapshotRevision: null }));

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

      for (const [mapName, layers] of layersByMap.entries()) {
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

            await updatePlayerAOI(player, sendAnimationToFn, spawnBatchQueue, despawnBatchQueue);
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
                sendPacket(player.ws, packetManager.loadPlayers({ players: spawnsArray, snapshotRevision: null }));

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
