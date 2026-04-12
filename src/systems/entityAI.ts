import { broadcastToAOI } from "../socket/aoi";
import entitySystem from "./entities";
import entityCache from "../services/entityCache.ts";
import playerCache from "../services/playermanager";
import log from "../modules/logger";
import { packetManager } from "../socket/packet_manager";
import { getEntitySpriteLayers, getIconUrl } from "../modules/spriteSheetManager";
import assetCache from "../services/assetCache";
import * as settings from "../config/settings.json";
import {
  hasLineOfSight,
  getDistance,
  clearPathState as clearPathStateImpl,
  steerTowards,
  type PathState,
} from "./entityPathfinding";

const defaultMap = (settings as any).default_map?.replace(".json", "") || "main";

/**
 * Entity AI State - tracks combat and movement
 */
interface EntityAIState {
  id: string;
  target: Nullable<string>;
  combatState: 'idle' | 'aggro' | 'dead' | 'returning';
  lastAttackTime: number;
  nextCastTime: number;
  aggroRange: number;
  attackCooldown: number;
  attackRange: number;
  damage: number;
  threatTable: Map<string, number>;
  stuckFrameCount: number;
  lastStuckCheckDistance: number;
  lastValidDirection: { x: number; y: number } | null;
  invalidDirectionFrames: number;
  path: Array<{ x: number; y: number }>;
  pathIndex: number;
  lastPathTargetTile: string | null;
  isCasting: boolean;
  castStartTime: number;
  castingProgress: number;
}

const entityAIStates = new Map<string, EntityAIState>();
const entitySpawnData = new Map<string, any>();
const entityRespawnTimers = new Map<string, NodeJS.Timeout>();
const aggroMap = new Map<string, Set<string>>();

// Constants
const TICK_INTERVAL = 16; // 60fps
const DEFAULT_AGGRO_RANGE = 300;
const DEFAULT_ATTACK_RANGE = 500;
const DEFAULT_ATTACK_COOLDOWN = 1000;
const DEFAULT_RESPAWN_TIME = 30;
const STUCK_FRAME_THRESHOLD = 180; // 3 seconds at 60fps

/**
 * Initialize AI state for an entity
 */
export function initializeEntityAI(entity: any): EntityAIState {
  const aiState: EntityAIState = {
    id: entity.id,
    target: null,
    combatState: 'idle',
    lastAttackTime: 0,
    nextCastTime: 0,
    aggroRange: DEFAULT_AGGRO_RANGE,
    attackCooldown: DEFAULT_ATTACK_COOLDOWN,
    attackRange: DEFAULT_ATTACK_RANGE,
    damage: Math.round(5 + entity.level * 1.5),
    threatTable: new Map(),
    stuckFrameCount: 0,
    lastStuckCheckDistance: Infinity,
    lastValidDirection: null,
    invalidDirectionFrames: 0,
    path: [],
    pathIndex: 0,
    lastPathTargetTile: null,
    isCasting: false,
    castStartTime: 0,
    castingProgress: 0,
  };

  const entityKey = String(entity.id);
  entityAIStates.set(entityKey, aiState);

  if (!entitySpawnData.has(entityKey)) {
    entitySpawnData.set(entityKey, {
      name: entity.name,
      map: entity.map,
      position: { ...entity.position },
      level: entity.level,
      health: entity.max_health,
      max_health: entity.max_health,
      aggro_type: entity.aggro_type,
      sprite_type: entity.sprite_type,
      spriteLayers: entity.spriteLayers,
      particles: entity.particles,
    });
  }

  return aiState;
}

function clearPathState(aiState: EntityAIState): void {
  clearPathStateImpl(aiState);
}

async function findNearestPlayer(entity: any, aggroRange: number, requireLineOfSight: boolean = true): Promise<{ player: any; distance: number } | null> {
  let nearest = null;
  let nearestDistance = aggroRange;

  const allPlayers = Object.values(playerCache.list()) as any[];
  for (const player of allPlayers) {
    if (player.location.map !== entity.map) continue;

    // Never aggro on stealthed admins
    if (player.isStealth && player.isAdmin) {
      continue;
    }

    const playerPos = typeof player.location.position === 'string'
      ? { x: Number(player.location.position.split(',')[0]), y: Number(player.location.position.split(',')[1]) }
      : player.location.position;

    const distance = getDistance(
      entity.position.x,
      entity.position.y,
      playerPos?.x ?? 0,
      playerPos?.y ?? 0
    );

    if (distance < nearestDistance) {
      // Only check line of sight when initiating aggro, not when already in combat
      if (requireLineOfSight) {
        const hasLOS = await hasLineOfSight(entity, playerPos);
        if (hasLOS) {
          nearest = player;
          nearestDistance = distance;
        }
      } else {
        nearest = player;
        nearestDistance = distance;
      }
    }
  }

  return nearest ? { player: nearest, distance: nearestDistance } : null;
}

/**
 * Handle entity returning to spawn when target goes stealth
 */
function handleStealthReturn(entity: any, aiState: EntityAIState, targetPlayerId: string | null): void {
  aiState.combatState = 'returning';
  aiState.target = null;
  aiState.threatTable.clear();
  aiState.stuckFrameCount = 0;
  aiState.lastStuckCheckDistance = Infinity;
  aiState.lastValidDirection = null;
  aiState.invalidDirectionFrames = 0;
  aiState.isCasting = false;
  aiState.castingProgress = 0;
  clearPathState(aiState);

  // Remove from aggro map if applicable (for aggressive entities)
  if (targetPlayerId) {
    const targetPlayer = playerCache.get(targetPlayerId);
    if (targetPlayer) {
      aggroMap.get(targetPlayerId)?.delete(String(entity.id));
      if (!aggroMap.get(targetPlayerId) || aggroMap.get(targetPlayerId)!.size === 0) {
        targetPlayer.pvp = false;
        aggroMap.delete(targetPlayerId);
      }
    }
  }

  if (entity.isMoving) {
    entity.isMoving = false;
    entity.hasMoved = true;
  }
}

function checkLeashRange(entity: any, aiState: EntityAIState): void {
  const entityKey = String(entity.id);
  const spawnData = entitySpawnData.get(entityKey);
  if (!spawnData) return;

  const leashRange = (entity as any).aggro_leash || 600;
  const spawnPos = spawnData.position;

  const distance = getDistance(
    entity.position.x,
    entity.position.y,
    spawnPos.x,
    spawnPos.y
  );

  if (distance > leashRange && aiState.combatState !== 'idle' && aiState.combatState !== 'returning') {
    const oldTargetId = aiState.target;
    aiState.combatState = 'returning';
    aiState.target = null;
    aiState.threatTable.clear();
    aiState.stuckFrameCount = 0;
    aiState.lastStuckCheckDistance = Infinity;
    aiState.lastValidDirection = null;
    aiState.invalidDirectionFrames = 0;
    aiState.isCasting = false;
    aiState.castingProgress = 0;
    clearPathState(aiState);

    if (oldTargetId) {
      const targetPlayer = playerCache.get(oldTargetId);
      if (targetPlayer) {
        aggroMap.get(oldTargetId)?.delete(String(entity.id));
        if (!aggroMap.get(oldTargetId) || aggroMap.get(oldTargetId)!.size === 0) {
          targetPlayer.pvp = false;
          aggroMap.delete(oldTargetId);
        }
      }
    }

    if (entity.isMoving) {
      entity.isMoving = false;
      entity.hasMoved = true;
    }
  }
}

async function updateAggroState(entity: any, aiState: EntityAIState): Promise<void> {
  // Don't update aggro while returning to spawn
  if (aiState.combatState === 'returning') {
    return;
  }

  if (entity.aggro_type === 'friendly') {
    if (aiState.combatState !== 'idle') {
      aiState.combatState = 'idle';
      aiState.target = null;
      aiState.threatTable.clear();
      aiState.stuckFrameCount = 0;
      aiState.lastStuckCheckDistance = Infinity;
      aiState.lastValidDirection = null;
      aiState.invalidDirectionFrames = 0;
      aiState.isCasting = false;
      aiState.castingProgress = 0;
      clearPathState(aiState);

      if (entity.isMoving) {
        entity.isMoving = false;
        entity.hasMoved = true;
      }
    }
    return;
  }

  if (entity.aggro_type === 'aggressive') {
    const aggroRange = (entity as any).aggro_range || DEFAULT_AGGRO_RANGE;

    if (!aiState.target) {
      // When initiating aggro, require line of sight
      const nearest = await findNearestPlayer(entity, aggroRange, true);

      if (nearest) {
        const playerId = String(nearest.player.id);
        aiState.target = playerId;
        aiState.combatState = 'aggro';
        aiState.threatTable.set(playerId, 100);
        aiState.stuckFrameCount = 0;
        aiState.lastStuckCheckDistance = Infinity;
        aiState.lastValidDirection = null;
        aiState.invalidDirectionFrames = 0;
        clearPathState(aiState);

        if (!aggroMap.has(playerId)) {
          aggroMap.set(playerId, new Set());
        }
        aggroMap.get(playerId)!.add(String(entity.id));
        nearest.player.pvp = true;
      }
    } else if (aiState.combatState === 'aggro') {
      // Check if current target went stealth as an admin
      if (aiState.target) {
        const targetPlayer = playerCache.get(aiState.target);
        if (targetPlayer && targetPlayer.isStealth && targetPlayer.isAdmin) {
          // Drop aggro immediately if target goes into stealth as admin - return to spawn like out of range
          handleStealthReturn(entity, aiState, aiState.target);
          return;
        }
      }

      // When already in combat, don't require line of sight to follow
      const nearest = await findNearestPlayer(entity, aggroRange * 2, false);

      if (!nearest) {
      const oldTargetId = aiState.target;
      aiState.combatState = 'returning';
      aiState.target = null;
      aiState.threatTable.clear();
      aiState.stuckFrameCount = 0;
      aiState.lastStuckCheckDistance = Infinity;
      aiState.lastValidDirection = null;
      aiState.invalidDirectionFrames = 0;
      aiState.isCasting = false;
      aiState.castingProgress = 0;
      clearPathState(aiState);

      if (oldTargetId) {
        const targetPlayer = playerCache.get(oldTargetId);
        if (targetPlayer) {
          aggroMap.get(oldTargetId)?.delete(String(entity.id));
          if (!aggroMap.get(oldTargetId) || aggroMap.get(oldTargetId)!.size === 0) {
            targetPlayer.pvp = false;
            aggroMap.delete(oldTargetId);
          }
        }
      }

      if (entity.isMoving) {
        entity.isMoving = false;
        entity.hasMoved = true;
      }
      }
    }
  }

  if (entity.aggro_type === 'neutral' && aiState.target) {
    const targetPlayer = playerCache.get(aiState.target);

    if (targetPlayer) {
      // Drop aggro if target is a stealthed admin - return to spawn like out of range
      if (targetPlayer.isStealth && targetPlayer.isAdmin) {
        handleStealthReturn(entity, aiState, aiState.target);
        return;
      }

      const targetPos = typeof targetPlayer.location.position === 'string'
        ? { x: Number(targetPlayer.location.position.split(',')[0]), y: Number(targetPlayer.location.position.split(',')[1]) }
        : targetPlayer.location.position;

      const distance = getDistance(
        entity.position.x,
        entity.position.y,
        targetPos?.x ?? 0,
        targetPos?.y ?? 0
      );

      if (distance < aiState.aggroRange) {
        if (aiState.combatState !== 'aggro') {
          aiState.combatState = 'aggro';
          // Set PvP flag when entering aggro
          if (!aggroMap.has(aiState.target)) {
            aggroMap.set(aiState.target, new Set());
          }
          aggroMap.get(aiState.target)!.add(String(entity.id));
          targetPlayer.pvp = true;
        }
      } else if (aiState.combatState === 'aggro') {
        // Drop aggro if target goes out of range
        const oldTargetId = aiState.target;
        aiState.combatState = 'returning';
        aiState.target = null;
        aiState.threatTable.clear();

        if (oldTargetId) {
          aggroMap.get(oldTargetId)?.delete(String(entity.id));
          if (!aggroMap.get(oldTargetId) || aggroMap.get(oldTargetId)!.size === 0) {
            targetPlayer.pvp = false;
            aggroMap.delete(oldTargetId);
          }
        }
      }
    } else {
      const oldTargetId = aiState.target;
      aiState.target = null;
      aiState.threatTable.clear();
      aiState.stuckFrameCount = 0;
      aiState.lastStuckCheckDistance = Infinity;
      aiState.lastValidDirection = null;
      aiState.invalidDirectionFrames = 0;
      aiState.isCasting = false;
      aiState.castingProgress = 0;
      clearPathState(aiState);

      // Remove from aggro map when target no longer exists
      if (oldTargetId) {
        aggroMap.get(oldTargetId)?.delete(String(entity.id));
        if (!aggroMap.get(oldTargetId) || aggroMap.get(oldTargetId)!.size === 0) {
          const targetPlayerRef = playerCache.get(oldTargetId);
          if (targetPlayerRef) {
            targetPlayerRef.pvp = false;
          }
          aggroMap.delete(oldTargetId);
        }
      }

      if (entity.isMoving) {
        entity.isMoving = false;
        entity.hasMoved = true;
      }
    }
  }
}

async function processCombat(entity: any, aiState: EntityAIState): Promise<void> {
  if (!aiState.target || aiState.combatState !== 'aggro') return;

  const targetPlayer = playerCache.get(aiState.target);
  if (!targetPlayer) {
    aiState.target = null;
    return;
  }

  const targetPos = typeof targetPlayer.location.position === 'string'
    ? { x: Number(targetPlayer.location.position.split(',')[0]), y: Number(targetPlayer.location.position.split(',')[1]) }
    : targetPlayer.location.position;

  const distance = getDistance(
    entity.position.x,
    entity.position.y,
    targetPos?.x ?? 0,
    targetPos?.y ?? 0
  );

  const dx = (targetPos?.x ?? 0) - entity.position.x;
  const dy = (targetPos?.y ?? 0) - entity.position.y;

  const now = performance.now();
  const castDuration = 1000;
  const projectileTime = 500;
  const desiredCombatDistance = Math.min(aiState.attackRange - 40, 180);

  if (aiState.isCasting) {
    // Face player while casting
    if (Math.abs(dx) > Math.abs(dy)) {
      entity.position.direction = dx >= 0 ? 'right' : 'left';
    } else {
      entity.position.direction = dy >= 0 ? 'down' : 'up';
    }

    if (distance > aiState.attackRange) {
      aiState.isCasting = false;
      aiState.castingProgress = 0;
      entity.hasMoved = true;
      return;
    }

    const elapsed = now - aiState.castStartTime;
    aiState.castingProgress = Math.min(elapsed / castDuration, 1);

    if (elapsed >= castDuration && now - aiState.lastAttackTime >= aiState.attackCooldown) {
      const hasLOS = await hasLineOfSight(entity, targetPos);
      if (distance <= aiState.attackRange && distance <= desiredCombatDistance && hasLOS) {
        const damageAmount = aiState.damage + Math.floor(Math.random() * 5) - 2;

        const allPlayers = Object.values(playerCache.list()) as any[];
        const playersOnMap = allPlayers.filter((p: any) => p && p.location && p.location.map === entity.map);

        if (playersOnMap.length > 0) {
          const projectilePacket = packetManager.projectile({
            id: entity.id,
            time: projectileTime / 1000,
            target_id: targetPlayer.id,
            spell: 'frost_bolt',
            icon: getIconUrl('frost_bolt'),
            entity: false,
            damage: damageAmount,
          });

          broadcastToAOI(playersOnMap[0], projectilePacket, true);
        }

        setTimeout(async () => {
          if (!aiState.target) return;
          const freshTarget = playerCache.get(aiState.target);
          if (freshTarget && freshTarget.stats) {
            freshTarget.stats.health = Math.max(0, freshTarget.stats.health - damageAmount);

            const allPlayers = Object.values(playerCache.list()) as any[];
            const playersOnMap = allPlayers.filter((p: any) => p && p.location && p.location.map === entity.map);

            if (freshTarget.stats.health <= 0) {
              freshTarget.stats.health = 0;
              freshTarget.stats.health = freshTarget.stats.total_max_health;
              freshTarget.stats.stamina = freshTarget.stats.total_max_stamina;

              // Immediately untarget the player when killed
              const killedTargetId = aiState.target;
              aiState.target = null;
              aiState.combatState = 'idle';
              aiState.threatTable.clear();

              // Clean up aggro map
              if (killedTargetId) {
                aggroMap.get(killedTargetId)?.delete(String(entity.id));
                if (!aggroMap.get(killedTargetId) || aggroMap.get(killedTargetId)!.size === 0) {
                  freshTarget.pvp = false;
                  aggroMap.delete(killedTargetId);
                }
              }

              const currentMapName = freshTarget.location.map;
              const mapPropertiesCache = await assetCache.get("mapProperties");
              const mapProps = mapPropertiesCache.find((m: any) => m.name === `${currentMapName}.json`);

              let respawnX: number;
              let respawnY: number;

              if (mapProps?.graveyards && Array.isArray(mapProps.graveyards) && mapProps.graveyards.length > 0) {
                let closestGraveyard = mapProps.graveyards[0];
                let closestDistance = Math.sqrt(
                  Math.pow(freshTarget.location.position.x - closestGraveyard.position.x, 2) +
                  Math.pow(freshTarget.location.position.y - closestGraveyard.position.y, 2)
                );

                for (const graveyard of mapProps.graveyards) {
                  const distance = Math.sqrt(
                    Math.pow(freshTarget.location.position.x - graveyard.position.x, 2) +
                    Math.pow(freshTarget.location.position.y - graveyard.position.y, 2)
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
                log.warn(`No graveyards found on map ${currentMapName}, using default map center`);
              }

              freshTarget.location.position = { x: Math.round(respawnX), y: Math.round(respawnY), direction: "down" };
              playerCache.set(freshTarget.id, freshTarget);

              if (playersOnMap.length > 0) {
                playersOnMap.forEach((player) => {
                  broadcastToAOI(player, packetManager.moveXY({
                    i: freshTarget.id,
                    d: {
                      x: Number(freshTarget.location.position.x),
                      y: Number(freshTarget.location.position.y),
                      dr: freshTarget.location.position.direction
                    },
                    r: 0,
                    s: freshTarget.isStealth ? 1 : 0
                  }), true);

                  broadcastToAOI(player, packetManager.revive({
                    id: freshTarget.id,
                    target: freshTarget.id,
                    stats: freshTarget.stats,
                  }), true);
                });
              }
            } else if (playersOnMap.length > 0) {
              const updateStatsPacket = packetManager.updateStats({
                id: entity.id,
                target: freshTarget.id,
                stats: { health: freshTarget.stats.health, total_max_health: freshTarget.stats.total_max_health },
                isCrit: false,
                damage: damageAmount,
                entity: false,
              });
              broadcastToAOI(playersOnMap[0], updateStatsPacket, true);
            }
          }
        }, projectileTime);
      }

      aiState.isCasting = false;
      aiState.castingProgress = 0;
      aiState.lastAttackTime = now;
      entity.hasMoved = true;
    }
  } else {
    if (distance <= desiredCombatDistance && now >= aiState.nextCastTime) {
      const hasLOS = await hasLineOfSight(entity, targetPos);
      if (hasLOS) {
        // Face player when starting to cast
        if (Math.abs(dx) > Math.abs(dy)) {
          entity.position.direction = dx >= 0 ? 'right' : 'left';
        } else {
          entity.position.direction = dy >= 0 ? 'down' : 'up';
        }

        aiState.isCasting = true;
        (entity as any).castingSpell = 'frost_bolt';
        aiState.castStartTime = now;
        (entity as any).castDuration = castDuration;
        entity.isMoving = false;
        entity.hasMoved = true;

        aiState.nextCastTime = now + aiState.attackCooldown;
      }
    }
  }
}

async function moveTowardsSpawn(entity: any, aiState?: EntityAIState): Promise<void> {
  const entityKey = String(entity.id);
  const spawnData = entitySpawnData.get(entityKey);
  if (!spawnData) return;

  const spawnPos = spawnData.position;
  const dx = spawnPos.x - entity.position.x;
  const dy = spawnPos.y - entity.position.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  const threshold = 10;

  // If entity is close to spawn, snap it to exact spawn position and stop moving
  if (distance < threshold) {
    if (entity.position.x !== spawnPos.x || entity.position.y !== spawnPos.y || entity.isMoving) {
      entity.position.x = spawnPos.x;
      entity.position.y = spawnPos.y;
      entity.position.direction = spawnPos.direction || 'down';
      entity.isMoving = false;
      entity.hasMoved = true;
      entity.action = 'idle';
      entity.velocity = { x: 0, y: 0 };
      entityCache.updatePosition(entity.id, entity.position.x, entity.position.y);
    }
  }

  // Only process return-to-spawn logic if entity is actually in "returning" state
  if (aiState && aiState.combatState === 'returning' && distance < threshold) {
    // Entity reached spawn - transition to idle
    entity.isCasting = false;
    entity.castingProgress = 0;
    entity.action = 'idle';

    aiState.combatState = 'idle';
    aiState.isCasting = false;
    aiState.castingProgress = 0;
    clearPathState(aiState);

    // Broadcast entity state reset to all players
    const allPlayers = Object.values(playerCache.list()) as any[];
    const playersOnMap = allPlayers.filter((p: any) => p && p.location && p.location.map === entity.map && p.ws);

    if (playersOnMap.length > 0) {
      // Send entity update with direction and idle combat state
      const updatePacket = packetManager.updateEntity({
        id: entity.id,
        combatState: 'idle',
        direction: entity.position.direction,
        position: { x: entity.position.x, y: entity.position.y, direction: entity.position.direction },
        isMoving: false,
        velocity: { x: 0, y: 0 },
        isCasting: false,
        castingProgress: 0,
        action: 'idle'
      });
      broadcastToAOI(playersOnMap[0], updatePacket, true);
    }

    // Restore health to full when returning to spawn
    if (entity.health < entity.max_health) {
      entityCache.resetHealth(entity.id);
      entity.health = entity.max_health;

      if (playersOnMap.length > 0) {
        const healthPacket = packetManager.updateEntityHealth(entity.id, entity.health, entity.max_health);
        broadcastToAOI(playersOnMap[0], healthPacket, true);
      }
    }
    return;
  }

  // Check if there are any players in AOI
  const allPlayers = Object.values(playerCache.list()) as any[];
  const playersOnMap = allPlayers.filter((p: any) => p && p.location && p.location.map === entity.map);

  // If no players on map, teleport back to spawn
  if (playersOnMap.length === 0) {
    entity.position.x = spawnPos.x;
    entity.position.y = spawnPos.y;
    entity.position.direction = spawnPos.direction || 'down';
    entity.health = entity.max_health;
    if (entity.isMoving) {
      entity.isMoving = false;
      entity.hasMoved = true;
    }
    if (aiState && aiState.combatState === 'returning') {
      aiState.combatState = 'idle';
      aiState.isCasting = false;
      aiState.castingProgress = 0;
    }
    entityCache.resetHealth(entity.id);
    entity.health = entity.max_health;
    entity.hasMoved = true;
    return;
  }

  const moveSpeed = (entity as any).speed || 2;
  const prevX = entity.position.x;
  const prevY = entity.position.y;

  // Heal entity while returning to spawn
  const healAmount = Math.ceil(entity.max_health / 30); // Heal to full in ~30 ticks (~0.5 seconds)
  if (entity.health < entity.max_health) {
    entity.health = Math.min(entity.health + healAmount, entity.max_health);
    entityCache.resetHealth(entity.id);

    // Broadcast health update to players
    const allPlayers = Object.values(playerCache.list()) as any[];
    const playersOnMap = allPlayers.filter((p: any) => p && p.location && p.location.map === entity.map && p.ws);
    if (playersOnMap.length > 0) {
      const healthPacket = packetManager.updateEntityHealth(entity.id, entity.health, entity.max_health);
      broadcastToAOI(playersOnMap[0], healthPacket, true);
    }
  }

  // Use pathfinding to navigate back to spawn
  const pathState: PathState = {
    path: aiState?.path || [],
    pathIndex: aiState?.pathIndex || 0,
    lastPathTargetTile: aiState?.lastPathTargetTile || null,
  };

  const nextStep = await steerTowards(entity, spawnPos, moveSpeed, pathState, 500);

  if (aiState) {
    aiState.path = pathState.path;
    aiState.pathIndex = pathState.pathIndex;
    aiState.lastPathTargetTile = pathState.lastPathTargetTile;
  }

  if (nextStep) {
    const moveX = nextStep.x - prevX;
    const moveY = nextStep.y - prevY;

    if (Math.abs(moveX) > Math.abs(moveY)) {
      if (Math.abs(moveX) > 0.1) {
        entity.position.direction = moveX > 0 ? 'right' : 'left';
      }
    } else {
      if (Math.abs(moveY) > 0.1) {
        entity.position.direction = moveY > 0 ? 'down' : 'up';
      }
    }

    entity.position.x = Math.round(nextStep.x);
    entity.position.y = Math.round(nextStep.y);

    entity.isMoving = true;
    entity.hasMoved = true;
    entityCache.updatePosition(entity.id, entity.position.x, entity.position.y);

    // Reset stuck counter when making any progress
    if (aiState) {
      aiState.stuckFrameCount = 0;
    }
  } else {
    if (entity.isMoving) {
      entity.isMoving = false;
      entity.hasMoved = true;
    }
    // Increment stuck counter only when can't move at all, but only if we're not already very close to spawn
    if (aiState) {
      const closeToSpawnThreshold = 50; // 50 pixels
      if (distance > closeToSpawnThreshold) {
        aiState.stuckFrameCount++;
        // If truly stuck (can't move) for too long while returning, teleport to spawn
        if (aiState.stuckFrameCount > 60) { // ~3 seconds
          entity.position.x = spawnPos.x;
          entity.position.y = spawnPos.y;
          entity.position.direction = spawnPos.direction || 'down';
          entity.hasMoved = true;
          aiState.stuckFrameCount = 0;
          clearPathState(aiState);
        }
      } else {
        // Close to spawn, don't teleport yet - let the threshold check at the top handle it
        aiState.stuckFrameCount = 0;
      }
    }
  }
}

async function moveTowardsTarget(entity: any, aiState: EntityAIState): Promise<void> {
  if (!aiState.target) return;

  const targetPlayer = playerCache.get(aiState.target);
  if (!targetPlayer) return;

  const targetPos = typeof targetPlayer.location.position === 'string'
    ? { x: Number(targetPlayer.location.position.split(',')[0]), y: Number(targetPlayer.location.position.split(',')[1]) }
    : targetPlayer.location.position;

  const dx = (targetPos?.x ?? 0) - entity.position.x;
  const dy = (targetPos?.y ?? 0) - entity.position.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const desiredCombatDistance = Math.min(aiState.attackRange - 40, 180);

  const hasLOS = await hasLineOfSight(entity, targetPos);

  // Only stop movement when we have BOTH line of sight AND we're in combat range.
  // This prevents the entity from stopping when there are obstacles between them and the player.
  if (hasLOS && distance <= desiredCombatDistance) {
    aiState.stuckFrameCount = 0;
    aiState.lastStuckCheckDistance = distance;
    aiState.invalidDirectionFrames = 0;
    clearPathState(aiState);

    if (entity.isMoving) {
      entity.isMoving = false;
      entity.hasMoved = true;
    }

    if ((entity as any).isCasting) {
      (entity as any).isCasting = false;
      (entity as any).castingProgress = 0;
    }
    return;
  }

  if ((entity as any).isCasting) {
    (entity as any).isCasting = false;
    (entity as any).castingProgress = 0;
  }

  const moveSpeed = (entity as any).speed || 2;
  const prevX = entity.position.x;
  const prevY = entity.position.y;

  // Create a pathState wrapper for the module functions
  const pathState: PathState = {
    path: aiState.path,
    pathIndex: aiState.pathIndex,
    lastPathTargetTile: aiState.lastPathTargetTile,
  };

  const nextStep = await steerTowards(entity, targetPos, moveSpeed, pathState, aiState.attackRange);

  // Sync path state back to aiState
  aiState.path = pathState.path;
  aiState.pathIndex = pathState.pathIndex;
  aiState.lastPathTargetTile = pathState.lastPathTargetTile;

  // Update direction tracking for stuck detection
  if (nextStep) {
    aiState.lastValidDirection = nextStep;
    aiState.invalidDirectionFrames = 0;
    aiState.stuckFrameCount = 0; // Reset stuck counter when we successfully move
  } else {
    aiState.invalidDirectionFrames++;
  }

  if (nextStep) {
    // Calculate direction from unrounded movement
    const moveX = nextStep.x - prevX;
    const moveY = nextStep.y - prevY;
    const actualMovementDistance = Math.sqrt(moveX * moveX + moveY * moveY);

    // Set direction based on the actual movement vector (supports diagonal directions)
    const hasHorizontalMovement = Math.abs(moveX) > 0.1;
    const hasVerticalMovement = Math.abs(moveY) > 0.1;

    if (hasHorizontalMovement && hasVerticalMovement) {
      // Diagonal movement
      const horizontalDir = moveX > 0 ? 'right' : 'left';
      const verticalDir = moveY > 0 ? 'down' : 'up';
      entity.position.direction = (verticalDir + horizontalDir) as any;
    } else if (hasHorizontalMovement) {
      // Horizontal-only movement
      entity.position.direction = moveX > 0 ? 'right' : 'left';
    } else if (hasVerticalMovement) {
      // Vertical-only movement
      entity.position.direction = moveY > 0 ? 'down' : 'up';
    }

    entity.position.x = Math.round(nextStep.x);
    entity.position.y = Math.round(nextStep.y);

    entity.isMoving = true;
    entity.hasMoved = true;
    entityCache.updatePosition(entity.id, entity.position.x, entity.position.y);

    // Check if entity is making progress: if no LOS and barely moving (< 1 tile per tick), return to spawn
    if (!hasLOS && actualMovementDistance < 32) { // 32 pixels ≈ 1 tile
      aiState.stuckFrameCount++;
      if (aiState.stuckFrameCount > 30) { // ~1.5 seconds at 20 ticks/sec
        aiState.combatState = 'returning';
        aiState.target = null;
        aiState.threatTable.clear();
        aiState.stuckFrameCount = 0;
        aiState.isCasting = false;
        aiState.castingProgress = 0;
        clearPathState(aiState);
      }
    } else {
      aiState.stuckFrameCount = 0;
    }
  } else {
    // Only increment stuck counter if we genuinely can't move
    aiState.stuckFrameCount++;
    if (entity.isMoving) {
      entity.isMoving = false;
      entity.hasMoved = true;
    }
    // Don't spam direction changes when stuck - keep last known direction
    // Direction will only update when entity successfully moves
  }

  // Increase threshold for giving up - entities should pursue harder
  const AGGRESSIVE_STUCK_THRESHOLD = STUCK_FRAME_THRESHOLD * 2; // 6 seconds instead of 3

  if (aiState.stuckFrameCount >= AGGRESSIVE_STUCK_THRESHOLD) {
    const oldTargetId = aiState.target;
    aiState.combatState = 'idle';
    aiState.target = null;
    aiState.threatTable.clear();
    aiState.stuckFrameCount = 0;
    aiState.lastStuckCheckDistance = Infinity;
    aiState.lastValidDirection = null;
    aiState.invalidDirectionFrames = 0;
    clearPathState(aiState);

    if (oldTargetId) {
      const targetPlayerRef = playerCache.get(oldTargetId);
      if (targetPlayerRef) {
        aggroMap.get(oldTargetId)?.delete(String(entity.id));
        if (!aggroMap.get(oldTargetId) || aggroMap.get(oldTargetId)!.size === 0) {
          targetPlayerRef.pvp = false;
          aggroMap.delete(oldTargetId);
        }
      }
    }

    if (entity.isMoving) {
      entity.isMoving = false;
      entity.hasMoved = true;
    }
  }
}

export async function tickEntityAI(): Promise<void> {
  try {
    const allEntities = entityCache.getAll();
    const mapPropertiesCache = await assetCache.get("mapProperties");

    for (const entity of allEntities) {
      if (!entity.health || entity.health <= 0) continue;

      // Add tile size from map properties if not already set
      if (!entity.tileSize) {
        const mapProps = mapPropertiesCache.find((m: any) => m.name === `${entity.map}.json`);
        entity.tileSize = mapProps?.tileWidth || 32;
      }

      const entityKey = String(entity.id);
      let aiState = entityAIStates.get(entityKey);
      if (!aiState) {
        aiState = initializeEntityAI(entity);
      }

      checkLeashRange(entity, aiState);

      if (aiState.combatState === 'returning') {
        // Don't update aggro while returning to spawn
        await moveTowardsSpawn(entity, aiState);
      } else {
        await updateAggroState(entity, aiState);

        if (aiState.combatState === 'aggro' && aiState.target) {
          if (!aiState.isCasting) {
            await moveTowardsTarget(entity, aiState);
          }
        } else if (aiState.combatState === 'idle') {
          await moveTowardsSpawn(entity, aiState);
        }
      }

      if (aiState.combatState === 'aggro') {
        await processCombat(entity, aiState);
      }

      broadcastEntityStateToAOI(entity);
    }
  } catch (error: any) {
    log.error(`Error in entity AI tick: ${error.message}`);
  }
}

function broadcastEntityStateToAOI(entity: Entity): void {
  if (!(entity as any).hasMoved) {
    return;
  }

  const entityKey = String(entity.id);
  const aiState = entityAIStates.get(entityKey);

  const allPlayers = Object.values(playerCache.list()) as any[];
  const playersOnMap = allPlayers.filter((p: any) => p && p.location && p.location.map === entity.map && p.ws);

  if (playersOnMap.length === 0) return;

  const movePacket = packetManager.moveXY({
    i: entity.id,
    d: {
      x: entity.position.x,
      y: entity.position.y,
      dr: entity.position.direction,
    },
    s: aiState?.isCasting ? 1 : 0, // Use stealth field to indicate casting for entities
  });

  broadcastToAOI(playersOnMap[0], movePacket, true);
  (entity as any).hasMoved = false;
}

export function applyDamageToEntity(entity: any, damage: number, attacker: any): void {
  if (entity.aggro_type === 'friendly') {
    return;
  }

  const entityKey = String(entity.id);
  let aiState = entityAIStates.get(entityKey);
  if (!aiState) {
    aiState = initializeEntityAI(entity);
    entityAIStates.set(entityKey, aiState);
  }

  entity.health = Math.max(0, entity.health - damage);

  const playerId = String(attacker.id);
  const currentThreat = aiState.threatTable.get(playerId) || 0;
  aiState.threatTable.set(playerId, currentThreat + damage);

  if (
    (entity.aggro_type === 'neutral' || entity.aggro_type === 'aggressive') &&
    (aiState.combatState === 'idle' || aiState.combatState === 'returning')
  ) {
    aiState.target = playerId;
    aiState.combatState = 'aggro';
    aiState.stuckFrameCount = 0;
    aiState.lastStuckCheckDistance = Infinity;
    aiState.lastValidDirection = null;
    aiState.invalidDirectionFrames = 0;
    clearPathState(aiState);

    if (!aggroMap.has(playerId)) {
      aggroMap.set(playerId, new Set());
    }
    aggroMap.get(playerId)!.add(String(entity.id));
    attacker.pvp = true;
  }

  if (entity.health <= 0) {
    aiState.combatState = 'dead';
    handleEntityDeath(entity);
  }
}

async function respawnEntity(entityId: string | number): Promise<void> {
  try {
    const entityKey = String(entityId);
    const spawnData = entitySpawnData.get(entityKey);
    if (!spawnData) {
      log.warn(`No spawn data found for entity ${entityId}, cannot respawn`);
      return;
    }

    const allEntities = await entitySystem.list();
    const entityFromDb = allEntities.find((e: any) => e.id === entityId);

    if (entityFromDb) {
      entityFromDb.health = entityFromDb.max_health;
      entityCache.add(entityFromDb);
      initializeEntityAI(entityFromDb);

      const spriteLayers = getEntitySpriteLayers(entityFromDb as any);

      const spawnPacketData = {
        id: entityFromDb.id,
        name: entityFromDb.name,
        position: { x: entityFromDb.position.x, y: entityFromDb.position.y, direction: entityFromDb.position.direction },
        health: entityFromDb.health,
        max_health: entityFromDb.max_health,
        level: entityFromDb.level,
        aggro_type: entityFromDb.aggro_type,
        sprite_type: entityFromDb.sprite_type,
        spriteLayers: spriteLayers,
        particles: entityFromDb.particles,
      };

      const spawnPacket = packetManager.spawnEntity(spawnPacketData);

      const playerCacheData = playerCache.list();
      const allPlayers = Object.values(playerCacheData) as any[];
      const playerOnMap = allPlayers.find((p: any) => p && p.location && p.location.map === entityFromDb.map);

      if (playerOnMap && playerOnMap.aoi) {
        broadcastToAOI(playerOnMap, spawnPacket, true);
      } else {
        log.warn(`[RESPAWN] No player on map ${entityFromDb.map} to broadcast entity spawn`);
      }

      log.debug(`Entity ${entityId} respawned with full health at map ${entityFromDb.map}`);
    } else {
      log.warn(`Entity ${entityId} not found in database for respawn`);
    }
  } catch (error: any) {
    log.error(`Error respawning entity ${entityId}: ${error.message}`);
  }
}

async function handleEntityDeath(entity: any): Promise<void> {
  try {
    const entityKey = String(entity.id);
    const aiState = entityAIStates.get(entityKey);

    if (aiState && aiState.target) {
      const targetPlayer = playerCache.get(aiState.target);
      if (targetPlayer) {
        aggroMap.get(aiState.target)?.delete(entityKey);
        if (!aggroMap.get(aiState.target) || aggroMap.get(aiState.target)!.size === 0) {
          targetPlayer.pvp = false;
          aggroMap.delete(aiState.target);
        }
      }
    }

    entityAIStates.delete(entity.id);

    const existingTimer = entityRespawnTimers.get(entity.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const respawnTimer = setTimeout(async () => {
      await respawnEntity(entity.id);
      entityRespawnTimers.delete(entity.id);
    }, DEFAULT_RESPAWN_TIME * 1000);

    entityRespawnTimers.set(entity.id, respawnTimer);

    log.debug(`Entity ${entity.id} died. Will respawn in ${DEFAULT_RESPAWN_TIME} seconds`);
  } catch (error: any) {
    log.error(`Error handling entity death: ${error.message}`);
  }
}

export function getEntityAIState(entityId: string): EntityAIState | undefined {
  return entityAIStates.get(entityId);
}

export function clearAllAIStates(): void {
  entityAIStates.clear();
}

export function updateEntitySpawnPoint(entityId: string, position: any): void {
  const entityKey = String(entityId);
  entitySpawnData.set(entityKey, {
    position: { x: position.x, y: position.y, direction: position.direction || 'down' }
  });
}

export function getEntitySpawnData(entityId: string | number): any {
  const entityKey = String(entityId);
  return entitySpawnData.get(entityKey);
}

export function resetEntityAI(entityId: string | number): void {
  const entityKey = String(entityId);
  const aiState = entityAIStates.get(entityKey);

  if (aiState) {
    // Clear aggro state
    if (aiState.target) {
      const oldTargetId = aiState.target;
      aggroMap.get(oldTargetId)?.delete(entityKey);
      if (!aggroMap.get(oldTargetId) || aggroMap.get(oldTargetId)!.size === 0) {
        const targetPlayer = playerCache.get(oldTargetId);
        if (targetPlayer) {
          targetPlayer.pvp = false;
        }
        aggroMap.delete(oldTargetId);
      }
    }

    // Reset AI state
    aiState.combatState = 'idle';
    aiState.target = null;
    aiState.threatTable.clear();
    aiState.isCasting = false;
    aiState.castingProgress = 0;
    aiState.stuckFrameCount = 0;
    aiState.lastStuckCheckDistance = Infinity;
    aiState.lastValidDirection = null;
    aiState.invalidDirectionFrames = 0;
    clearPathState(aiState);
  }
}

setInterval(() => {
  tickEntityAI().catch((error: any) => {
    log.error(`Unhandled error in entity AI loop: ${error.message}`);
  });
}, TICK_INTERVAL);

export default {
  initializeEntityAI,
  applyDamageToEntity,
  getEntityAIState,
  clearAllAIStates,
  tickEntityAI,
  respawnEntity,
  updateEntitySpawnPoint,
  getEntitySpawnData,
  resetEntityAI,
};