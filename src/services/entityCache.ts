/**
 * In-memory entity cache service
 * Stores entities loaded at server startup and provides fast access without database calls
 */

import log from "../modules/logger";

let cachedEntities: Entity[] = [];
let isLoaded = false;

const entityCache = {
  /**
   * Initialize the cache with entities from the system
   */
  async initialize(entitySystem: any): Promise<Entity[]> {
    try {
      const entities = await entitySystem.list();
      // Set all entities to max health (health is only stored in cache, not database)
      // Set isMoving to false (entities start idle)
      cachedEntities = entities.map((entity: any) => ({
        ...entity,
        health: entity.max_health,
        isMoving: false,
      })) || [];
      isLoaded = true;
      log.success(`Entity cache initialized with ${cachedEntities.length} entities`);
      return cachedEntities;
    } catch (error: any) {
      log.error(`Error initializing entity cache: ${error.message}`);
      isLoaded = false;
      return [];
    }
  },

  /**
   * Get all cached entities
   */
  getAll(): Entity[] {
    return cachedEntities;
  },

  /**
   * Get entities by map
   */
  getByMap(mapName: string): Entity[] {
    return cachedEntities.filter((entity) => entity.map === mapName);
  },

  /**
   * Get a single entity by ID
   */
  getById(entityId: number): Entity | null {
    return cachedEntities.find((entity) => entity.id === entityId) || null;
  },

  /**
   * Update entity health in cache (called when entity takes damage)
   */
  updateHealth(entityId: number, health: number): void {
    const entity = cachedEntities.find((e) => e.id === entityId);
    if (entity) {
      entity.health = Math.max(0, health); // Clamp to 0
    }
  },

  /**
   * Update entity position in cache (called during entity movement)
   */
  updatePosition(entityId: number, x: number, y: number): void {
    const entity = cachedEntities.find((e) => e.id === entityId);
    if (entity) {
      entity.position.x = x;
      entity.position.y = y;
    }
  },

  /**
   * Reset entity health to max (used for respawn)
   */
  resetHealth(entityId: number): void {
    const entity = cachedEntities.find((e) => e.id === entityId);
    if (entity) {
      entity.health = entity.max_health;
    }
  },

  /**
   * Remove entity from cache (called when despawned)
   */
  remove(entityId: number): void {
    const index = cachedEntities.findIndex((e) => e.id === entityId);
    if (index !== -1) {
      cachedEntities.splice(index, 1);
    }
  },

  /**
   * Add entity back to cache (called when respawned)
   */
  add(entity: Entity): void {
    // Check if already exists to avoid duplicates
    const existingIndex = cachedEntities.findIndex((e) => e.id === entity.id);
    if (existingIndex !== -1) {
      cachedEntities[existingIndex] = entity;
    } else {
      cachedEntities.push(entity);
    }
  },

  /**
   * Check if cache is loaded
   */
  isReady(): boolean {
    return isLoaded;
  },
};

export default entityCache;
