import AOI_CONFIG from "../config/aoi.json";
import playerCache from "../services/playermanager";
import layerManager from "../services/layermanager";
import parties from "../systems/parties";
import { packetManager } from "./packet_manager";
import log from "../modules/logger";

// Player AOI state interface
export interface PlayerAOIState {
  // Set of player IDs currently in this player's AOI
  playersInAOI: Set<string>;

  // Grid cell coordinates for spatial indexing (optional optimization)
  gridX: number;
  gridY: number;

  // AOI radius in pixels
  aoiRadius: number;

  // Last position where AOI was updated (for change detection)
  lastAOIUpdatePosition: { x: number; y: number };

  // Threshold distance to trigger AOI recalculation
  updateThreshold: number;

  // Map change sequence number to handle rapid map changes
  mapChangeSequence: number;

  // Layer ID for this player (e.g., "main:layer_1")
  layerId: string | null;
}

/**
 * Initialize AOI state for a player
 */
export async function initializePlayerAOI(player: any): Promise<void> {
  const pos = player.location.position;
  const mapName = player.location.map.replaceAll(".json", "");

  let layerId: string;

  // Check if player is in a party - if so, try to join party's existing layer
  if (player.party_id) {
    const partyId = player.party_id;
    const partyLeader = await parties.getPartyLeader(partyId);
    const partyMembers = await parties.getPartyMembers(partyId);
    const isLeader = partyLeader?.toLowerCase() === player.username?.toLowerCase();

    // Find online party members and their layers
    const allPlayers = playerCache.list();
    const onlinePartyPlayers = Object.values(allPlayers).filter((p: any) =>
      p.username && partyMembers.some((m: string) => m.toLowerCase() === p.username.toLowerCase()) &&
      p.aoi?.layerId &&
      p.location.map.replaceAll(".json", "") === mapName
    );

    if (onlinePartyPlayers.length > 0) {
      if (isLeader) {
        // Leader joins the layer where party members are
        // Find the most common layer among party members
        const layerCounts = new Map<string, number>();
        onlinePartyPlayers.forEach((p: any) => {
          if (p.aoi?.layerId) {
            layerCounts.set(p.aoi.layerId, (layerCounts.get(p.aoi.layerId) || 0) + 1);
          }
        });

        // Get layer with most members
        let maxCount = 0;
        let targetLayer = null;
        for (const [layer, count] of layerCounts.entries()) {
          if (count > maxCount) {
            maxCount = count;
            targetLayer = layer;
          }
        }

        if (targetLayer) {
          // Manually assign to the party's layer
          const targetLayerInfo = layerManager.getLayerInfo(targetLayer);
          if (targetLayerInfo && targetLayerInfo.playerCount < AOI_CONFIG.MAX_PLAYERS_PER_LAYER) {
            layerId = targetLayer;
            layerManager.removePlayerFromLayer(player.id); // Remove from any existing layer
            const layer = layerManager.getLayerInfo(targetLayer)!;
            layer.players.add(player.id);
            layer.playerCount++;
            log.info(`[LAYER] Leader ${player.username} rejoining party layer ${layerId}`);
          } else {
            // Party layer is full, assign normally
            layerId = layerManager.assignPlayerToLayer(player.id, mapName);
            log.info(`[LAYER] Leader ${player.username} - party layer full, assigned to ${layerId}`);
          }
        } else {
          layerId = layerManager.assignPlayerToLayer(player.id, mapName);
        }
      } else {
        // Member joins leader's layer
        const leaderPlayer = onlinePartyPlayers.find((p: any) =>
          p.username?.toLowerCase() === partyLeader?.toLowerCase()
        );

        if (leaderPlayer && leaderPlayer.aoi?.layerId) {
          const leaderLayerId = leaderPlayer.aoi.layerId;
          const leaderLayerInfo = layerManager.getLayerInfo(leaderLayerId);

          if (leaderLayerInfo && leaderLayerInfo.playerCount < AOI_CONFIG.MAX_PLAYERS_PER_LAYER) {
            layerId = leaderLayerId;
            layerManager.removePlayerFromLayer(player.id); // Remove from any existing layer
            const layer = layerManager.getLayerInfo(leaderLayerId)!;
            layer.players.add(player.id);
            layer.playerCount++;
            log.info(`[LAYER] Member ${player.username} joining leader's layer ${layerId}`);
          } else {
            // Leader's layer is full, assign normally
            layerId = layerManager.assignPlayerToLayer(player.id, mapName);
            log.info(`[LAYER] Member ${player.username} - leader's layer full, assigned to ${layerId}`);
          }
        } else {
          // Leader not online, assign normally
          layerId = layerManager.assignPlayerToLayer(player.id, mapName);
        }
      }
    } else {
      // No party members online on this map, assign normally
      layerId = layerManager.assignPlayerToLayer(player.id, mapName);
    }
  } else {
    // Not in a party, assign normally
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

  if (AOI_CONFIG.DEBUG) {
    log.info(`[AOI] Initialized AOI for player ${player.id} at (${pos.x}, ${pos.y}) on layer ${layerId}`);
  }
}

/**
 * Filter players by distance - optimized version with squared distance
 * Now includes layer filtering: only players on same map AND same layer
 */
function filterPlayersByDistance(
  sourcePlayer: any,
  radius: number,
  map: string
): any[] {
  const radiusSquared = radius * radius;
  const players = playerCache.list();
  const result: any[] = [];

  const sourcePos = sourcePlayer.location.position;
  const sourceLayerId = sourcePlayer.aoi?.layerId;

  for (const playerId in players) {
    const player = players[playerId];

    // Skip self
    if (player.id === sourcePlayer.id) continue;

    // Must be on same map
    const playerMap = player.location.map.replaceAll(".json", "");
    const sourceMap = map.replaceAll(".json", "");
    if (playerMap !== sourceMap) continue;

    // Must be on same layer
    const playerLayerId = player.aoi?.layerId;
    if (playerLayerId !== sourceLayerId) continue;

    // Check distance (squared to avoid sqrt)
    const dx = player.location.position.x - sourcePos.x;
    const dy = player.location.position.y - sourcePos.y;
    const distSquared = dx * dx + dy * dy;

    if (distSquared <= radiusSquared) {
      result.push(player);
    }
  }

  return result;
}

/**
 * Send packet helper
 */
function sendPacket(ws: any, packets: any[]) {
  if (!ws || !ws.send || ws.readyState !== 1) return;
  try {
    packets.forEach((packet) => {
      ws.send(packet);
    });
  } catch (error) {
    // Silently ignore errors when sending to closed websockets
  }
}

/**
 * Queue SPAWN_PLAYER data for batching
 * Returns spawn data to be added to batch queue
 */
export function queueSpawnPlayerPacket(
  spawnedPlayer: any
): any {
  if (!spawnedPlayer) return null;

  try {
    // Build spawn data structure
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
    };

    if (AOI_CONFIG.DEBUG) {
      log.info(`[AOI] Queued SPAWN_PLAYER for ${spawnedPlayer.id}`);
    }

    return spawnData;
  } catch (error) {
    log.error(`[AOI] Error queueing spawn player packet: ${error}`);
    return null;
  }
}

/**
 * Calculate and update a player's Area of Interest
 * Queues SPAWN_PLAYER and DESPAWN_PLAYER packets for batching
 */
export async function updatePlayerAOI(
  player: any,
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>,
  spawnBatchQueue?: Map<string, Map<string, any>>,
  despawnBatchQueue?: Map<string, Set<string>>
): Promise<void> {
  if (!player || !player.aoi) {
    if (AOI_CONFIG.DEBUG) {
      log.warn(`[AOI] Cannot update AOI for player without AOI state`);
    }
    return;
  }

  const currentMap = player.location.map;
  const currentPos = player.location.position;
  const aoiRadius = player.aoi.aoiRadius;
  const currentSequence = player.aoi.mapChangeSequence;

  try {
    // Step 1: Find all players currently in range on same map
    const playersInRange = filterPlayersByDistance(
      player,
      aoiRadius,
      currentMap
    );

    // Check if map changed during async operation
    if (player.aoi.mapChangeSequence !== currentSequence) {
      if (AOI_CONFIG.DEBUG) {
        log.info(`[AOI] Map changed during AOI update for ${player.id}, aborting`);
      }
      return;
    }

    const newAOISet = new Set(playersInRange.map((p) => p.id));
    const oldAOISet = player.aoi.playersInAOI;

    // Step 2: Determine who entered AOI (in new but not in old)
    const enteredAOI: string[] = [];
    newAOISet.forEach((playerId) => {
      if (!oldAOISet.has(playerId)) {
        enteredAOI.push(playerId);
      }
    });

    // Step 3: Determine who exited AOI (in old but not in new)
    const exitedAOI: string[] = [];
    oldAOISet.forEach((playerId: string) => {
      if (!newAOISet.has(playerId)) {
        exitedAOI.push(playerId);
      }
    });

    if (AOI_CONFIG.DEBUG && (enteredAOI.length > 0 || exitedAOI.length > 0)) {
      log.info(
        `[AOI] Player ${player.id}: ${enteredAOI.length} entered, ${exitedAOI.length} exited`
      );
    }

    // Step 4: Queue SPAWN_PLAYER for entries (bidirectional)
    for (const enteredPlayerId of enteredAOI) {
      const enteredPlayer = playerCache.get(enteredPlayerId);
      if (!enteredPlayer) continue;

      // Check visibility based on stealth and force visibility flag
      const playerForceSeeEntered = player.forceVisibleTo?.has(enteredPlayer.id);
      const enteredPlayerForceSeePlayer = enteredPlayer.forceVisibleTo?.has(player.id);
      const canSeeEntered = !enteredPlayer.isStealth || player.isAdmin || playerForceSeeEntered;
      const canSeePlayer = !player.isStealth || enteredPlayer.isAdmin || enteredPlayerForceSeePlayer;

      // Queue entered player's spawn data to current player
      if (canSeeEntered && spawnBatchQueue) {
        const spawnData = queueSpawnPlayerPacket(enteredPlayer);
        if (spawnData) {
          if (!spawnBatchQueue.has(player.id)) {
            spawnBatchQueue.set(player.id, new Map());
          }
          spawnBatchQueue.get(player.id)!.set(enteredPlayer.id, spawnData);
        }
      }

      // Queue current player's spawn data to entered player (reciprocal)
      if (canSeePlayer && spawnBatchQueue) {
        const spawnData = queueSpawnPlayerPacket(player);
        if (spawnData) {
          if (!spawnBatchQueue.has(enteredPlayer.id)) {
            spawnBatchQueue.set(enteredPlayer.id, new Map());
          }
          spawnBatchQueue.get(enteredPlayer.id)!.set(player.id, spawnData);
        }
      }

      // Update entered player's AOI tracking (bidirectional)
      if (!enteredPlayer.aoi) {
        await initializePlayerAOI(enteredPlayer);
      }
      enteredPlayer.aoi.playersInAOI.add(player.id);
      playerCache.set(enteredPlayer.id, enteredPlayer);
    }

    // Step 5: Queue DESPAWN_PLAYER for exits (bidirectional)
    for (const exitedPlayerId of exitedAOI) {
      const exitedPlayer = playerCache.get(exitedPlayerId);

      // Queue despawn to current player
      if (despawnBatchQueue) {
        if (!despawnBatchQueue.has(player.id)) {
          despawnBatchQueue.set(player.id, new Set());
        }
        despawnBatchQueue.get(player.id)!.add(exitedPlayerId);
      } else {
        sendPacket(player.ws, packetManager.despawnPlayer(exitedPlayerId, "distance"));
      }

      // Queue despawn to exited player (reciprocal)
      if (exitedPlayer && exitedPlayer.ws) {
        if (despawnBatchQueue) {
          if (!despawnBatchQueue.has(exitedPlayer.id)) {
            despawnBatchQueue.set(exitedPlayer.id, new Set());
          }
          despawnBatchQueue.get(exitedPlayer.id)!.add(player.id);
        } else {
          sendPacket(
            exitedPlayer.ws,
            packetManager.despawnPlayer(player.id, "distance")
          );
        }

        // Update exited player's AOI tracking
        if (exitedPlayer.aoi) {
          exitedPlayer.aoi.playersInAOI.delete(player.id);
          playerCache.set(exitedPlayer.id, exitedPlayer);
        }
      }
    }

    // Step 6: Update current player's AOI state
    player.aoi.playersInAOI = newAOISet;
    player.aoi.lastAOIUpdatePosition = { x: currentPos.x, y: currentPos.y };
    player.aoi.gridX = Math.floor(currentPos.x / AOI_CONFIG.GRID_CELL_SIZE);
    player.aoi.gridY = Math.floor(currentPos.y / AOI_CONFIG.GRID_CELL_SIZE);
    playerCache.set(player.id, player);
  } catch (error) {
    log.error(`[AOI] Error updating AOI for player ${player.id}: ${error}`);
  }
}

/**
 * Check if player should update AOI based on distance moved
 */
export function shouldUpdateAOI(player: any): boolean {
  if (!player || !player.aoi) return false;

  const currentPos = player.location.position;
  const lastPos = player.aoi.lastAOIUpdatePosition;

  const dx = currentPos.x - lastPos.x;
  const dy = currentPos.y - lastPos.y;
  const distanceMoved = Math.sqrt(dx * dx + dy * dy);

  return distanceMoved > player.aoi.updateThreshold;
}

/**
 * Broadcast animation/sprite sheet to players in AOI
 * Always includes self for client-side prediction validation
 */
export function broadcastToAOI(
  sourcePlayer: any,
  packetData: any[],
  includeSelf: boolean = true
): void {
  if (!sourcePlayer || !sourcePlayer.aoi) {
    if (AOI_CONFIG.DEBUG) {
      log.warn(`[AOI] Cannot broadcast for player without AOI state`);
    }
    return;
  }

  try {
    // Always send to self if requested (required for client feedback)
    if (includeSelf && sourcePlayer.ws) {
      sendPacket(sourcePlayer.ws, packetData);
    }

    // Get players in AOI
    const playersInAOI = Array.from(sourcePlayer.aoi.playersInAOI)
      .map((id) => playerCache.get(id as string))
      .filter((p) => p && p.ws);

    // Handle stealth mode
    if (sourcePlayer.isStealth) {
      // Only admins can see stealth players
      const visibleTo = playersInAOI.filter((p) => p.isAdmin);
      visibleTo.forEach((player) => {
        sendPacket(player.ws, packetData);
      });
    } else {
      // Normal broadcast to all players in AOI
      playersInAOI.forEach((player) => {
        sendPacket(player.ws, packetData);
      });
    }
  } catch (error) {
    log.error(`[AOI] Error broadcasting to AOI: ${error}`);
  }
}

/**
 * Find all players who have targetId in their AOI
 */
export function findPlayersWithTargetInAOI(targetId: string): any[] {
  const allPlayers = Object.values(playerCache.list());
  return allPlayers.filter(
    (player) => player.aoi && player.aoi.playersInAOI.has(targetId)
  );
}

/**
 * Remove a player from everyone's AOI (used on disconnect/map change)
 * Queues despawn packets for batching
 */
export function despawnPlayerFromAllAOI(
  departingPlayer: any,
  reason: "map_change" | "disconnect" = "map_change",
  despawnBatchQueue?: Map<string, Set<string>>
): void {
  if (!departingPlayer || !departingPlayer.aoi) return;

  try {
    // Find all players who have this player in their AOI
    const affectedPlayers = findPlayersWithTargetInAOI(departingPlayer.id);

    if (affectedPlayers.length > 0) {
      log.debug(`[DESPAWN] Queuing ${departingPlayer.id} to ${affectedPlayers.length} players`);
    }

    affectedPlayers.forEach((player) => {
      if (despawnBatchQueue) {
        // Queue despawn for batching
        if (!despawnBatchQueue.has(player.id)) {
          despawnBatchQueue.set(player.id, new Set());
        }
        despawnBatchQueue.get(player.id)!.add(departingPlayer.id);
      } else {
        // Send despawn packet immediately (no batch queue provided)
        sendPacket(
          player.ws,
          packetManager.despawnPlayer(departingPlayer.id, reason)
        );
      }

      // Update AOI tracking
      if (player.aoi) {
        player.aoi.playersInAOI.delete(departingPlayer.id);
        playerCache.set(player.id, player);
      }
    });

    // Clear departing player's AOI only on disconnect
    // For map_change/layer_change, keep the AOI so updatePlayerAOI can calculate the diff
    if (reason === "disconnect") {
      departingPlayer.aoi.playersInAOI.clear();
      layerManager.removePlayerFromLayer(departingPlayer.id);
    }

    if (AOI_CONFIG.DEBUG) {
      log.info(
        `[AOI] Despawned player ${departingPlayer.id} from ${affectedPlayers.length} players (${reason})`
      );
    }
  } catch (error) {
    log.error(`[AOI] Error despawning player from all AOI: ${error}`);
  }
}

/**
 * Handle map change for player AOI
 */
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
    // Initialize AOI if not present
    if (!player.aoi) {
      await initializePlayerAOI(player);
    }

    const oldMapName = player.location.map;

    // Only process if actually changing maps
    const oldMap = oldMapName.replaceAll(".json", "");
    const newMap = newMapName.replaceAll(".json", "");

    if (oldMap !== newMap) {
      // Increment sequence to invalidate any in-flight AOI updates
      player.aoi.mapChangeSequence++;

      // Despawn from all players on old map (map changes send immediately, no batching)
      despawnPlayerFromAllAOI(player, "map_change", undefined);

      // Reassign player to a new layer on the new map
      const newLayerId = layerManager.assignPlayerToLayer(player.id, newMap);
      player.aoi.layerId = newLayerId;

      if (AOI_CONFIG.DEBUG) {
        log.info(`[AOI] Player ${player.id} changing map from ${oldMap} to ${newMap}, assigned to ${newLayerId}`);
      }
    }

    // Update position and grid cell
    player.location.map = newMapName;
    player.location.position.x = newPosition.x;
    player.location.position.y = newPosition.y;
    player.aoi.gridX = Math.floor(newPosition.x / AOI_CONFIG.GRID_CELL_SIZE);
    player.aoi.gridY = Math.floor(newPosition.y / AOI_CONFIG.GRID_CELL_SIZE);
    player.aoi.lastAOIUpdatePosition = { x: newPosition.x, y: newPosition.y };
    playerCache.set(player.id, player);

    // Discover new AOI on new map
    await updatePlayerAOI(player, sendAnimationToFn, spawnBatchQueue, despawnBatchQueue);
  } catch (error) {
    log.error(`[AOI] Error handling map change: ${error}`);
  }
}

/**
 * Get layer information for a player
 */
export function getPlayerLayerInfo(playerId: string): { layerId: string | null; layerName: string | null } {
  const player = playerCache.get(playerId);
  if (!player || !player.aoi) {
    return { layerId: null, layerName: null };
  }

  const layerId = player.aoi.layerId;
  const layerName = layerId ? layerManager.getLayerName(layerId) : null;

  return { layerId, layerName };
}

/**
 * Export layer manager for direct access if needed
 */
export { layerManager };

/**
 * Synchronize party members to the same layer and update their AOIs
 * Called when party composition changes
 */
export async function syncPartyLayers(
  partyLeaderUsername: string,
  partyMemberUsernames: string[],
  playerCache: any,
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): Promise<void> {
  try {
    // Get player objects for leader and members
    const allPlayers = playerCache.list();

    const leaderPlayer = Object.values(allPlayers).find((p: any) =>
      p.username && p.username.toLowerCase() === partyLeaderUsername.toLowerCase()
    );

    if (!leaderPlayer || !leaderPlayer.aoi) {
      log.debug(`[LAYER] Party leader ${partyLeaderUsername} not online or no AOI`);
      return;
    }

    // Get online party members
    const onlineMembers: any[] = [];
    const memberPlayerIds: string[] = [];

    for (const memberUsername of partyMemberUsernames) {
      if (memberUsername.toLowerCase() === partyLeaderUsername.toLowerCase()) {
        continue; // Skip leader, already have them
      }

      const memberPlayer = Object.values(allPlayers).find((p: any) =>
        p.username && p.username.toLowerCase() === memberUsername.toLowerCase()
      );

      if (memberPlayer && memberPlayer.aoi) {
        onlineMembers.push(memberPlayer);
        memberPlayerIds.push(memberPlayer.id);
      }
    }

    if (onlineMembers.length === 0) {
      log.debug(`[LAYER] No online party members to sync for ${partyLeaderUsername}`);
      return;
    }

    const mapName = leaderPlayer.location.map.replaceAll(".json", "");

    // Filter members to only those on the same map as leader
    const membersOnSameMap = onlineMembers.filter(m =>
      m.location.map.replaceAll(".json", "") === mapName
    );

    if (membersOnSameMap.length === 0) {
      log.debug(`[LAYER] No party members on same map as leader (${mapName})`);
      return;
    }

    const memberIdsOnSameMap = membersOnSameMap.map(m => m.id);

    // Sync party to leader's layer
    const targetLayerId = layerManager.syncPartyToLeaderLayer(
      leaderPlayer.id,
      memberIdsOnSameMap,
      mapName
    );

    if (!targetLayerId) {
      log.error(`[LAYER] Failed to sync party to leader layer`);
      return;
    }

    // Create batch queues for spawning/despawning players efficiently
    const spawnBatchQueue = new Map<string, Map<string, any>>();
    const despawnBatchQueue = new Map<string, Set<string>>();

    // Track which players need AOI updates
    const playersNeedingUpdate: any[] = [];

    // STEP 1: Update all layer IDs FIRST (before any AOI operations)
    // This ensures all players are on their target layer before we calculate who can see whom
    const leaderOldLayerId = leaderPlayer.aoi?.layerId;

    if (leaderPlayer.aoi) {
      playersNeedingUpdate.push({ player: leaderPlayer, oldLayerId: leaderOldLayerId });

      if (leaderOldLayerId !== targetLayerId) {
        log.info(`[LAYER] Leader ${leaderPlayer.username} changing from ${leaderOldLayerId} to ${targetLayerId}`);
      } else {
        log.info(`[LAYER] Leader ${leaderPlayer.username} staying on ${targetLayerId}, refreshing AOI for new members`);
      }

      leaderPlayer.aoi.layerId = targetLayerId;
      playerCache.set(leaderPlayer.id, leaderPlayer);
    }

    for (const member of membersOnSameMap) {
      const oldLayerId = member.aoi?.layerId;

      if (member.aoi) {
        playersNeedingUpdate.push({ player: member, oldLayerId: oldLayerId });

        if (oldLayerId !== targetLayerId) {
          log.info(`[LAYER] Member ${member.username} changing from ${oldLayerId} to ${targetLayerId}`);
        }

        member.aoi.layerId = targetLayerId;
        playerCache.set(member.id, member);
      }
    }

    // STEP 2: Despawn players from old layers
    // This tells old layer players to remove these players from their screens
    for (const { player, oldLayerId } of playersNeedingUpdate) {
      if (oldLayerId !== targetLayerId) {
        // Player changed layers - despawn them from old layer players' AOIs
        despawnPlayerFromAllAOI(player, "map_change", despawnBatchQueue);
      }
    }

    // STEP 3: Update AOI for all affected players
    // Now that all layer IDs are updated, calculate new AOIs based on new layers
    for (const { player, oldLayerId } of playersNeedingUpdate) {
      // updatePlayerAOI will:
      // - Find players in range on NEW layer (already updated)
      // - Compare with old playersInAOI
      // - Despawn old layer players from this player's view
      // - Spawn new layer players to this player's view
      await updatePlayerAOI(player, sendAnimationToFn, spawnBatchQueue, despawnBatchQueue);
    }

    // Flush batched spawn packets
    let totalSpawns = 0;
    let totalDespawns = 0;

    for (const [playerId, spawnsMap] of spawnBatchQueue.entries()) {
      const player = playerCache.get(playerId);
      if (player && player.ws) {
        const spawnsArray = Array.from(spawnsMap.values());
        if (spawnsArray.length > 0) {
          totalSpawns += spawnsArray.length;
          sendPacket(player.ws, packetManager.loadPlayers({ players: spawnsArray, snapshotRevision: null }));

          // Send animations for each spawned player
          for (const spawnData of spawnsArray) {
            const spawnedPlayer = playerCache.get(spawnData.id);
            if (spawnedPlayer && spawnedPlayer.location?.position?.direction) {
              // Determine animation name based on player state
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

    // Flush batched despawn packets
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

    // Log positions for debugging visibility issues
    const positionInfo = playersNeedingUpdate.map(({ player }) => {
      const pos = player.location?.position;
      return `${player.username}(${pos?.x},${pos?.y})`;
    }).join(", ");

    log.info(`[LAYER] Synced party of ${partyLeaderUsername} to layer ${layerManager.getLayerName(targetLayerId)}`);
    log.info(`[LAYER] Positions: ${positionInfo}`);
    log.info(`[LAYER] Sent ${totalSpawns} spawns, ${totalDespawns} despawns to ${playersNeedingUpdate.length} players`);
  } catch (error) {
    log.error(`[LAYER] Error syncing party layers: ${error}`);
  }
}

/**
 * Periodically check all parties and sync layers if they're out of sync
 * Runs every 15 seconds
 */
export function startAutoPartyLayerSync(
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): void {
  setInterval(async () => {
    try {
      // Get all active parties
      const allParties = await parties.getAllParties();

      if (!allParties || allParties.length === 0) {
        return;
      }

      const allPlayers = playerCache.list();

      for (const party of allParties) {
        if (!party.leader || !party.members || party.members.length === 0) {
          continue;
        }

        // Find online leader
        const leaderPlayer = Object.values(allPlayers).find((p: any) =>
          p.username && p.username.toLowerCase() === party.leader.toLowerCase()
        );

        if (!leaderPlayer || !leaderPlayer.aoi?.layerId) {
          continue;
        }

        const leaderLayerId = leaderPlayer.aoi.layerId;
        const leaderMapName = leaderPlayer.location.map.replaceAll(".json", "");

        // Find online members on the same map
        const onlineMembers: any[] = [];
        let needsSync = false;

        for (const memberUsername of party.members) {
          if (memberUsername.toLowerCase() === party.leader.toLowerCase()) {
            continue; // Skip leader
          }

          const memberPlayer = Object.values(allPlayers).find((p: any) =>
            p.username && p.username.toLowerCase() === memberUsername.toLowerCase()
          );

          if (memberPlayer && memberPlayer.aoi?.layerId) {
            const memberMapName = memberPlayer.location.map.replaceAll(".json", "");

            // Only check members on the same map as leader
            if (memberMapName === leaderMapName) {
              onlineMembers.push(memberPlayer);

              // Check if member is on a different layer than leader
              if (memberPlayer.aoi.layerId !== leaderLayerId) {
                needsSync = true;
              }
            }
          }
        }

        // If any members are out of sync, sync the entire party
        if (needsSync && onlineMembers.length > 0) {
          log.info(`[LAYER] Auto-syncing party ${party.leader} - members out of sync`);
          await syncPartyLayers(
            party.leader,
            party.members,
            playerCache,
            sendAnimationToFn
          );
        }
      }
    } catch (error) {
      log.error(`[LAYER] Error in auto party layer sync: ${error}`);
    }
  }, 15000); // Run every 15 seconds

  log.info(`[LAYER] Auto party layer sync started (15 second interval)`);
}

/**
 * Condense layers by merging players from less populated layers into fuller layers
 * Runs every 5 minutes to optimize layer usage
 */
export function startAutoLayerCondensation(
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): void {
  setInterval(async () => {
    try {
      const stats = layerManager.getStats();

      if (stats.totalLayers <= 1) {
        return; // Nothing to condense
      }

      // Get layers grouped by map
      const layersByMap = new Map<string, Array<{ layerId: string; playerCount: number; players: string[] }>>();

      // Group all layers by their map
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

      // Process each map
      for (const [mapName, layers] of layersByMap.entries()) {
        if (layers.length <= 1) {
          continue; // Only one layer, nothing to condense
        }

        // Sort layers by player count (ascending) - we'll try to empty smaller layers first
        layers.sort((a, b) => a.playerCount - b.playerCount);

        let condensed = false;
        const spawnBatchQueue = new Map<string, Map<string, any>>();
        const despawnBatchQueue = new Map<string, Set<string>>();

        // Try to move players from smaller layers to larger ones
        for (let i = 0; i < layers.length - 1; i++) {
          const sourceLayer = layers[i];

          if (sourceLayer.playerCount === 0) continue;

          // Try to find a target layer that can accommodate these players
          for (let j = i + 1; j < layers.length; j++) {
            const targetLayer = layers[j];
            const availableSpace = AOI_CONFIG.MAX_PLAYERS_PER_LAYER - targetLayer.playerCount;

            if (availableSpace >= sourceLayer.playerCount) {
              // We can move all players from source to target
              log.info(`[LAYER] Condensing ${sourceLayer.playerCount} players from ${layerManager.getLayerName(sourceLayer.layerId)} to ${layerManager.getLayerName(targetLayer.layerId)} on map ${mapName}`);

              // Move each player
              for (const playerId of sourceLayer.players) {
                const player = playerCache.get(playerId);
                if (!player || !player.aoi) continue;

                const oldLayerId = player.aoi.layerId;

                // Update layer assignment in layer manager
                layerManager.removePlayerFromLayer(playerId);
                const targetLayerInfo = layerManager.getLayerInfo(targetLayer.layerId);
                if (targetLayerInfo) {
                  targetLayerInfo.players.add(playerId);
                  targetLayerInfo.playerCount++;
                  // Also update the playerToLayer map
                  (layerManager as any).playerToLayer.set(playerId, targetLayer.layerId);
                }

                // Update player's layer ID
                player.aoi.layerId = targetLayer.layerId;
                playerCache.set(playerId, player);

                // Despawn from old layer players
                despawnPlayerFromAllAOI(player, "map_change", despawnBatchQueue);

                // Update AOI to spawn on new layer
                await updatePlayerAOI(player, sendAnimationToFn, spawnBatchQueue, despawnBatchQueue);
              }

              // Update our tracking
              targetLayer.playerCount += sourceLayer.playerCount;
              targetLayer.players.push(...sourceLayer.players);
              sourceLayer.playerCount = 0;
              sourceLayer.players = [];
              condensed = true;
              break; // Found a home for this layer's players
            }
          }
        }

        if (condensed) {
          // Flush batched packets
          for (const [playerId, spawnsMap] of spawnBatchQueue.entries()) {
            const player = playerCache.get(playerId);
            if (player && player.ws) {
              const spawnsArray = Array.from(spawnsMap.values());
              if (spawnsArray.length > 0) {
                sendPacket(player.ws, packetManager.loadPlayers({ players: spawnsArray, snapshotRevision: null }));

                // Send animations for spawned players
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

          // Flush despawn packets
          for (const [playerId, despawnSet] of despawnBatchQueue.entries()) {
            const player = playerCache.get(playerId);
            if (player && player.ws && despawnSet.size > 0) {
              despawnSet.forEach((despawnPlayerId) => {
                sendPacket(player.ws, packetManager.despawnPlayer(despawnPlayerId, "map_change"));
              });
            }
          }

          log.info(`[LAYER] Condensation complete for map ${mapName}`);
        }
      }
    } catch (error) {
      log.error(`[LAYER] Error in auto layer condensation: ${error}`);
    }
  }, 300000); // Run every 5 minutes (300000ms)

  log.info(`[LAYER] Auto layer condensation started (5 minute interval)`);
}
