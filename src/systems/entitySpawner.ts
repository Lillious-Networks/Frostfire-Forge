import query from "../controllers/sqldatabase";
import entitySystem from "./entities";
import { initializeEntityAI } from "./entityAI";
import log from "../modules/logger";
import playerCache from "../services/playermanager";
import { packetManager } from "../socket/packet_manager";
import { broadcastToAOI } from "../socket/aoi";

interface SpawnPoint {
  id: number;
  entity_template_id: number;
  map: string;
  position: { x: number; y: number };
  respawn_time: number; // milliseconds
  max_spawns: number;
  created_at: string;
}

interface ActiveSpawn {
  entity_id: string;
  spawn_point_id: number;
  spawn_time: number;
  death_time: Nullable<number>;
}

// Track active spawned entities
const activeSpawns = new Map<number, ActiveSpawn[]>(); // spawn_point_id -> array of active spawns

/**
 * Load all spawn points from database
 */
export async function loadSpawnPoints(): Promise<SpawnPoint[]> {
  try {
    const results = (await query(
      "SELECT * FROM entity_spawn_points"
    )) as any[];

    const spawnPoints: SpawnPoint[] = results.map((row) => ({
      id: row.id,
      entity_template_id: row.entity_template_id,
      map: row.map,
      position: {
        x: Number(row.position.split(",")[0]),
        y: Number(row.position.split(",")[1]),
      },
      respawn_time: row.respawn_time || 30000,
      max_spawns: row.max_spawns || 1,
      created_at: row.created_at,
    }));

    log.info(`Loaded ${spawnPoints.length} entity spawn points`);
    return spawnPoints;
  } catch (error: any) {
    log.error(`Error loading spawn points: ${error.message}`);
    return [];
  }
}

/**
 * Initialize spawn point tracking
 */
export async function initializeSpawner(): Promise<void> {
  const spawnPoints = await loadSpawnPoints();

  for (const spawnPoint of spawnPoints) {
    activeSpawns.set(spawnPoint.id, []);

    // Spawn initial entities for this point
    for (let i = 0; i < spawnPoint.max_spawns; i++) {
      await spawnEntityAtPoint(spawnPoint);
    }
  }

  // Start respawn tick loop
  startRespawnTick();
}

/**
 * Spawn an entity at a spawn point
 */
export async function spawnEntityAtPoint(spawnPoint: SpawnPoint): Promise<any> {
  try {
    const templateEntityResult = await entitySystem.find({ id: spawnPoint.entity_template_id } as any);
    const templateEntity = Array.isArray(templateEntityResult) ? templateEntityResult[0] : templateEntityResult;
    if (!templateEntity) {
      log.warn(`Template entity ${spawnPoint.entity_template_id} not found`);
      return null;
    }

    // Create new entity instance from template
    const newEntity : Entity = {
      id: null,
      last_updated: null,
      map: spawnPoint.map,
      name: (templateEntity as any).name,
      position: {
        x: spawnPoint.position.x + (Math.random() - 0.5) * 20, // Small random offset
        y: spawnPoint.position.y + (Math.random() - 0.5) * 20,
        direction: "down",
      },
      health: (templateEntity as any).max_health,
      max_health: (templateEntity as any).max_health,
      level: (templateEntity as any).level,
      aggro_type: (templateEntity as any).aggro_type,
      particles: (templateEntity as any).particles || [],
      sprite_type: (templateEntity as any).sprite_type,
      sprite_body: (templateEntity as any).sprite_body,
      sprite_head: (templateEntity as any).sprite_head,
      sprite_helmet: (templateEntity as any).sprite_helmet,
      sprite_shoulderguards: (templateEntity as any).sprite_shoulderguards,
      sprite_neck: (templateEntity as any).sprite_neck,
      sprite_hands: (templateEntity as any).sprite_hands,
      sprite_chest: (templateEntity as any).sprite_chest,
      sprite_feet: (templateEntity as any).sprite_feet,
      sprite_legs: (templateEntity as any).sprite_legs,
      sprite_weapon: (templateEntity as any).sprite_weapon,
    };

    // Add to database
    await entitySystem.add(newEntity as any);
    const allEntities = await entitySystem.list();
    const spawnedEntity = allEntities
      .filter((e) => e.map === spawnPoint.map)
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];

    if (spawnedEntity && spawnedEntity.id) {
      // Initialize AI for this entity
      initializeEntityAI(spawnedEntity);

      // Track this spawn
      const activeList = activeSpawns.get(spawnPoint.id) || [];
      activeList.push({
        entity_id: spawnedEntity.id.toString(),
        spawn_point_id: spawnPoint.id,
        spawn_time: Date.now(),
        death_time: null,
      });
      activeSpawns.set(spawnPoint.id, activeList);

      // Broadcast to players on map
      broadcastEntitySpawn(spawnedEntity, spawnPoint.map);

      log.debug(
        `Spawned entity ${spawnedEntity.id} at spawn point ${spawnPoint.id}`
      );
      return spawnedEntity;
    }

    return null;
  } catch (error: any) {
    log.error(`Error spawning entity at point ${spawnPoint.id}: ${error.message}`);
    return null;
  }
}

/**
 * Broadcast entity spawn to players on map
 */
function broadcastEntitySpawn(entity: any, mapName: string): void {
  const allPlayers = Object.values(playerCache.list()) as any[];
  const playerOnMap = allPlayers.find((p: any) => p && p.location && p.location.map === mapName);

  if (!playerOnMap) return;

  const entityData = {
    id: entity.id,
    last_updated: entity.last_updated,
    name: entity.name,
    location: {
      x: entity.position.x,
      y: entity.position.y,
      direction: entity.position.direction || "down",
    },
    health: entity.health,
    max_health: entity.max_health,
    level: entity.level,
    aggro_type: entity.aggro_type,
    particles: entity.particles,
    map: entity.map,
    position: entity.position,
    sprite_type: entity.sprite_type || 'none',
    spriteLayers: entity.spriteLayers,
  };

  broadcastToAOI(playerOnMap, packetManager.createEntity(entityData as any), true);
}

/**
 * Mark entity as dead and start respawn timer
 */
export async function entityDied(entityId: string, spawnPointId: number): Promise<void> {
  const activeList = activeSpawns.get(spawnPointId) || [];
  const spawnRecord = activeList.find((s) => s.entity_id === entityId);

  if (spawnRecord) {
    spawnRecord.death_time = Date.now();
  }

  log.debug(`Entity ${entityId} marked for respawn from point ${spawnPointId}`);
}

/**
 * Respawn tick - check for entities that need respawning
 */
async function respawnTick(): Promise<void> {
  const now = Date.now();
  const spawnPoints = await loadSpawnPoints();

  for (const spawnPoint of spawnPoints) {
    const activeList = activeSpawns.get(spawnPoint.id) || [];

    // Check for spawns ready to respawn
    const deadSpawns = activeList.filter(
      (s) =>
        s.death_time !== null &&
        now - s.death_time >= spawnPoint.respawn_time
    );

    for (const deadSpawn of deadSpawns) {
      // Remove dead entity from database
      try {
        const deadEntity = { id: deadSpawn.entity_id } as any;
        await entitySystem.remove(deadEntity);
      } catch (error: any) {
        log.warn(`Error removing dead entity ${deadSpawn.entity_id}: ${error.message}`);
      }

      // Remove from active list
      const index = activeList.indexOf(deadSpawn);
      if (index > -1) {
        activeList.splice(index, 1);
      }

      // Spawn replacement
      await spawnEntityAtPoint(spawnPoint);
    }

    activeSpawns.set(spawnPoint.id, activeList);
  }
}

/**
 * Start respawn tick loop
 */
let respawnTickInterval: NodeJS.Timeout;

export function startRespawnTick(): void {
  const RESPAWN_CHECK_INTERVAL = 5000; // Check every 5 seconds
  respawnTickInterval = setInterval(() => {
    respawnTick().catch((error: any) => {
      log.error(`Error in respawn tick: ${error.message}`);
    });
  }, RESPAWN_CHECK_INTERVAL);
}

/**
 * Stop respawn tick
 */
export function stopRespawnTick(): void {
  if (respawnTickInterval) {
    clearInterval(respawnTickInterval);
  }
}

/**
 * Get active spawns for a spawn point
 */
export function getActiveSpawns(spawnPointId: number): ActiveSpawn[] {
  return activeSpawns.get(spawnPointId) || [];
}

/**
 * Get all active spawns
 */
export function getAllActiveSpawns(): Map<number, ActiveSpawn[]> {
  return activeSpawns;
}

/**
 * Clear spawner state (for cleanup)
 */
export function clearSpawnerState(): void {
  activeSpawns.clear();
  stopRespawnTick();
}

export default {
  loadSpawnPoints,
  initializeSpawner,
  spawnEntityAtPoint,
  entityDied,
  getActiveSpawns,
  getAllActiveSpawns,
  clearSpawnerState,
  startRespawnTick,
  stopRespawnTick,
};
