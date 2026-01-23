import { AOI_CONFIG } from "../config/aoi";
import playerCache from "../services/playermanager";
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
}

/**
 * Initialize AOI state for a player
 */
export function initializePlayerAOI(player: any): void {
  const pos = player.location.position;
  player.aoi = {
    playersInAOI: new Set<string>(),
    gridX: Math.floor(pos.x / AOI_CONFIG.GRID_CELL_SIZE),
    gridY: Math.floor(pos.y / AOI_CONFIG.GRID_CELL_SIZE),
    aoiRadius: AOI_CONFIG.DEFAULT_RADIUS,
    lastAOIUpdatePosition: { x: pos.x, y: pos.y },
    updateThreshold: AOI_CONFIG.UPDATE_THRESHOLD,
    mapChangeSequence: 0,
  };

  if (AOI_CONFIG.DEBUG) {
    log.info(`[AOI] Initialized AOI for player ${player.id} at (${pos.x}, ${pos.y})`);
  }
}

/**
 * Filter players by distance - optimized version with squared distance
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

  for (const playerId in players) {
    const player = players[playerId];

    // Skip self
    if (player.id === sourcePlayer.id) continue;

    // Must be on same map
    const playerMap = player.location.map.replaceAll(".json", "");
    const sourceMap = map.replaceAll(".json", "");
    if (playerMap !== sourceMap) continue;

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
  if (!ws || !ws.send) return;
  packets.forEach((packet) => {
    ws.send(packet);
  });
}

/**
 * Get animation name for direction
 */
function getAnimationNameForDirection(
  direction: string,
  walking: boolean,
  mounted: boolean = false,
  mount_type?: string,
  casting: boolean = false
): string {
  const normalized = normalizeDirection(direction);

  // If casting, use cast_idle (stationary) or cast_walk (moving)
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

/**
 * Normalize direction
 */
function normalizeDirection(direction: string): string {
  const validDirections = ["down", "up", "left", "right", "downleft", "downright", "upleft", "upright"];
  if (validDirections.includes(direction)) {
    return direction;
  }
  return "down"; // safe fallback for invalid directions
}

/**
 * Send SPAWN_PLAYER packet with all required animation/sprite data
 */
export async function sendSpawnPlayerPacket(
  targetWs: any,
  spawnedPlayer: any,
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): Promise<void> {
  if (!targetWs || !spawnedPlayer) return;

  try {
    // Get current animation state
    const animationName = getAnimationNameForDirection(
      spawnedPlayer.location.position.direction,
      spawnedPlayer.moving,
      spawnedPlayer.mounted,
      spawnedPlayer.mount_type,
      spawnedPlayer.casting || false
    );

    // Send basic SPAWN_PLAYER packet
    const spawnData = {
      id: spawnedPlayer.id,
      userid: spawnedPlayer.userid,
      location: {
        map: spawnedPlayer.location.map,
        x: spawnedPlayer.location.position.x,
        y: spawnedPlayer.location.position.y,
        direction: spawnedPlayer.location.position.direction,
      },
      username: spawnedPlayer.username,
      isAdmin: spawnedPlayer.isAdmin,
      isGuest: spawnedPlayer.isGuest,
      isStealth: spawnedPlayer.isStealth,
      stats: spawnedPlayer.stats,
      sprite: spawnedPlayer.sprite,
      mounted: spawnedPlayer.mounted,
      ...(spawnedPlayer.friends ? { friends: spawnedPlayer.friends } : {}),
      ...(spawnedPlayer.party ? { party: spawnedPlayer.party } : {}),
      ...(spawnedPlayer.currency
        ? { currency: spawnedPlayer.currency }
        : { currency: { copper: 0, silver: 0, gold: 0 } }),
    };

    sendPacket(targetWs, packetManager.spawnPlayer(spawnData));

    // Send animation packet immediately after spawn
    await sendAnimationToFn(targetWs, animationName, spawnedPlayer.id);

    if (AOI_CONFIG.DEBUG) {
      log.info(`[AOI] Sent SPAWN_PLAYER and animation for ${spawnedPlayer.id} to client`);
    }
  } catch (error) {
    log.error(`[AOI] Error sending spawn player packet: ${error}`);
  }
}

/**
 * Calculate and update a player's Area of Interest
 * Sends SPAWN_PLAYER and DESPAWN_PLAYER packets based on AOI changes
 */
export async function updatePlayerAOI(
  player: any,
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
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

    // Step 4: Send SPAWN_PLAYER for entries (bidirectional)
    for (const enteredPlayerId of enteredAOI) {
      const enteredPlayer = playerCache.get(enteredPlayerId);
      if (!enteredPlayer) continue;

      // Check visibility based on stealth
      const canSeeEntered = !enteredPlayer.isStealth || player.isAdmin;
      const canSeePlayer = !player.isStealth || enteredPlayer.isAdmin;

      // Send entered player's data to current player
      if (canSeeEntered) {
        await sendSpawnPlayerPacket(player.ws, enteredPlayer, sendAnimationToFn);
      }

      // Send current player's data to entered player (reciprocal)
      if (canSeePlayer) {
        await sendSpawnPlayerPacket(enteredPlayer.ws, player, sendAnimationToFn);
      }

      // Update entered player's AOI tracking (bidirectional)
      if (!enteredPlayer.aoi) {
        initializePlayerAOI(enteredPlayer);
      }
      enteredPlayer.aoi.playersInAOI.add(player.id);
      playerCache.set(enteredPlayer.id, enteredPlayer);
    }

    // Step 5: Send DESPAWN_PLAYER for exits (bidirectional)
    for (const exitedPlayerId of exitedAOI) {
      const exitedPlayer = playerCache.get(exitedPlayerId);

      // Send despawn to current player
      sendPacket(player.ws, packetManager.despawnPlayer(exitedPlayerId, "distance"));

      // Send despawn to exited player (reciprocal)
      if (exitedPlayer && exitedPlayer.ws) {
        sendPacket(
          exitedPlayer.ws,
          packetManager.despawnPlayer(player.id, "distance")
        );

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
 */
export function despawnPlayerFromAllAOI(
  departingPlayer: any,
  reason: "map_change" | "disconnect" = "map_change"
): void {
  if (!departingPlayer || !departingPlayer.aoi) return;

  try {
    // Find all players who have this player in their AOI
    const affectedPlayers = findPlayersWithTargetInAOI(departingPlayer.id);

    affectedPlayers.forEach((player) => {
      // Send despawn packet
      sendPacket(
        player.ws,
        packetManager.despawnPlayer(departingPlayer.id, reason)
      );

      // Update AOI tracking
      if (player.aoi) {
        player.aoi.playersInAOI.delete(departingPlayer.id);
        playerCache.set(player.id, player);
      }
    });

    // Clear departing player's AOI
    departingPlayer.aoi.playersInAOI.clear();

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
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): Promise<void> {
  if (!player) return;

  try {
    // Initialize AOI if not present
    if (!player.aoi) {
      initializePlayerAOI(player);
    }

    const oldMapName = player.location.map;

    // Only process if actually changing maps
    const oldMap = oldMapName.replaceAll(".json", "");
    const newMap = newMapName.replaceAll(".json", "");

    if (oldMap !== newMap) {
      // Increment sequence to invalidate any in-flight AOI updates
      player.aoi.mapChangeSequence++;

      // Despawn from all players on old map
      despawnPlayerFromAllAOI(player, "map_change");

      if (AOI_CONFIG.DEBUG) {
        log.info(`[AOI] Player ${player.id} changing map from ${oldMap} to ${newMap}`);
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
    await updatePlayerAOI(player, sendAnimationToFn);
  } catch (error) {
    log.error(`[AOI] Error handling map change: ${error}`);
  }
}
