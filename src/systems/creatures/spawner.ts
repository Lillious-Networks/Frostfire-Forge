import { POOL_RETRY_MS, RESPAWN_MULTIPLIER, randInt, rng, type Rng } from "./constants";
import { CreatureRegistry } from "./registry";
import { createAuras } from "./auras";
import { createCombatState } from "./threat";
import {
  AIState,
  type CreatureInstance,
  type CreatureSpawn,
  type CreatureSpawnPool,
  type CreatureTemplate,
} from "./types";

export interface SpawnerData {
  templates: Map<number, CreatureTemplate>;
  spawns: Map<number, CreatureSpawn>;
  pools: Map<number, CreatureSpawnPool>;
}

export interface SpawnerHooks {
  onSpawn?(instance: CreatureInstance): void;
  onDespawn?(instance: CreatureInstance): void;
}

export function computeMaxHealth(template: CreatureTemplate, level: number): number {
  return Math.max(1, Math.round(template.health_base + template.health_per_level * (level - 1)));
}

export function rollLevel(template: CreatureTemplate, r: Rng = rng): number {
  return randInt(template.level_min, template.level_max, r);
}

export function rollRespawnMs(spawn: CreatureSpawn, multiplier: number = RESPAWN_MULTIPLIER, r: Rng = rng): number {
  const seconds = spawn.respawn_min_s + r() * (spawn.respawn_max_s - spawn.respawn_min_s);
  return Math.max(0, Math.round(seconds * 1000 * multiplier));
}

/**
 * Picks which template a spawn point produces. Pools with a rare template roll
 * rare_chance_pct, but never produce a second rare while one is alive.
 */
export function pickTemplateId(
  spawn: CreatureSpawn,
  pool: CreatureSpawnPool | undefined,
  rareAlive: boolean,
  r: Rng = rng
): number {
  if (pool && pool.rare_template_id !== null && !rareAlive && pool.rare_chance_pct > 0) {
    if (r() * 100 < pool.rare_chance_pct) return pool.rare_template_id;
  }
  return spawn.template_id;
}

/** A spawn point materialised on one layer (or shared across all, layerId null). */
/**
 * Creatures spawned in one tick. Spawns due together are common - a new layer
 * gets a copy of every per-layer spawn point on its map at once - and each one
 * also costs a visibility check against every player. The overflow waits for
 * the next tick 100ms later, so a busy map fills in over a second or so.
 */
const MAX_SPAWNS_PER_TICK = 100;

/** Whether two map -> layer-id sets hold exactly the same layers. */
function sameLayers(a: Map<string, Set<string>>, b: Map<string, Set<string>>): boolean {
  if (a.size !== b.size) return false;
  for (const [map, ids] of a) {
    const other = b.get(map);
    if (!other || other.size !== ids.size) return false;
    for (const id of ids) if (!other.has(id)) return false;
  }
  return true;
}

const slotKey = (spawnId: number, layerId: string | null) => `${spawnId}|${layerId ?? "*"}`;
const poolKey = (poolId: number, layerId: string | null) => `${poolId}|${layerId ?? "*"}`;

interface PendingSlot {
  spawnId: number;
  layerId: string | null;
  dueAt: number;
}

export class CreatureSpawner {
  private data: SpawnerData = { templates: new Map(), spawns: new Map(), pools: new Map() };
  /** slot -> live instance id */
  private live = new Map<string, number>();
  /** layer id -> its live slot keys, so a vanished layer is cleaned without a full scan. */
  private liveByLayer = new Map<string, Set<string>>();
  private pending = new Map<string, PendingSlot>();
  /** pool slot -> live instance ids */
  private poolMembers = new Map<string, Set<number>>();
  /** map -> per_layer spawn ids */
  private perLayerSpawnsByMap = new Map<string, number[]>();
  /** map -> active layer ids, as last reported by setLayers */
  private layers = new Map<string, Set<string>>();

  constructor(
    private readonly registry: CreatureRegistry,
    private readonly hooks: SpawnerHooks = {},
    private readonly r: Rng = rng,
    private readonly respawnMultiplier: number = RESPAWN_MULTIPLIER
  ) {}

  /** Replace all data and (re)spawn every slot immediately. */
  load(data: SpawnerData, now: number): void {
    for (const instanceId of [...this.live.values()]) {
      this.despawn(instanceId, now, { respawn: false });
    }
    this.pending.clear();
    this.liveByLayer.clear();
    this.data = data;
    this.perLayerSpawnsByMap.clear();
    for (const spawn of data.spawns.values()) {
      if (spawn.layer_policy === "shared") {
        this.schedule(spawn.id, null, now);
      } else {
        const list = this.perLayerSpawnsByMap.get(spawn.map) ?? [];
        list.push(spawn.id);
        this.perLayerSpawnsByMap.set(spawn.map, list);
      }
    }
    this.reconcileLayers(now);
    this.tick(now);
  }

  /**
   * Swap in new data without touching creatures that are still valid. New
   * spawn points spawn immediately; creatures of deleted spawn points are
   * removed. Callers refresh changed creatures themselves.
   */
  updateData(data: SpawnerData, now: number): void {
    this.data = data;
    this.perLayerSpawnsByMap.clear();
    for (const spawn of data.spawns.values()) {
      if (spawn.layer_policy === "shared") {
        const key = slotKey(spawn.id, null);
        if (!this.live.has(key) && !this.pending.has(key)) this.schedule(spawn.id, null, now);
      } else {
        const list = this.perLayerSpawnsByMap.get(spawn.map) ?? [];
        list.push(spawn.id);
        this.perLayerSpawnsByMap.set(spawn.map, list);
      }
    }
    this.reconcileLayers(now);
    this.tick(now);
  }

  /** Maps that have per-layer spawn points (the only ones setLayers needs to report). */
  perLayerMaps(): IterableIterator<string> {
    return this.perLayerSpawnsByMap.keys();
  }

  /**
   * Report the live layers per map. New layers get their own copies of every
   * per_layer spawn; creatures on layers that no longer exist are removed.
   */
  setLayers(layersByMap: Map<string, Iterable<string>>, now: number): void {
    const next = new Map<string, Set<string>>();
    for (const [map, ids] of layersByMap) next.set(map, new Set(ids));

    // Reconciliation walks every live creature and pending spawn, which is the
    // most expensive thing the spawner does. Layers only change when players
    // arrive, leave or get condensed, so skip it entirely when the set is the
    // same as last time - the common case, several times a second.
    if (sameLayers(this.layers, next)) return;

    // Only the layers that actually appeared or disappeared need work.
    const gone: string[] = [];
    const added: Array<{ map: string; layerId: string }> = [];
    for (const [map, ids] of this.layers) {
      const other = next.get(map);
      for (const id of ids) if (!other?.has(id)) gone.push(id);
    }
    for (const [map, ids] of next) {
      const before = this.layers.get(map);
      for (const id of ids) if (!before?.has(id)) added.push({ map, layerId: id });
    }

    this.layers = next;

    for (const layerId of gone) this.dropLayer(layerId, now);
    for (const { map, layerId } of added) {
      for (const spawnId of this.perLayerSpawnsByMap.get(map) ?? []) {
        const key = slotKey(spawnId, layerId);
        if (!this.live.has(key) && !this.pending.has(key)) this.schedule(spawnId, layerId, now);
      }
    }
  }

  /** Remove every creature and pending spawn belonging to a layer that is gone. */
  private dropLayer(layerId: string, now: number): void {
    for (const key of [...(this.liveByLayer.get(layerId) ?? [])]) {
      const instanceId = this.live.get(key);
      if (instanceId !== undefined) this.despawn(instanceId, now, { respawn: false });
    }
    this.liveByLayer.delete(layerId);
    for (const [key, slot] of [...this.pending]) {
      if (slot.layerId === layerId) this.pending.delete(key);
    }
  }

  tick(now: number): void {
    let budget = MAX_SPAWNS_PER_TICK;
    for (const [key, slot] of this.pending) {
      if (slot.dueAt > now) continue;
      this.pending.delete(key);
      this.trySpawn(slot.spawnId, slot.layerId, now);
      // Overdue slots keep their place in `pending` and spawn on later ticks.
      if (--budget <= 0) return;
    }
  }

  getLiveInstanceId(spawnId: number, layerId: string | null = null): number | undefined {
    return this.live.get(slotKey(spawnId, layerId));
  }

  getPendingAt(spawnId: number, layerId: string | null = null): number | undefined {
    return this.pending.get(slotKey(spawnId, layerId))?.dueAt;
  }

  activeInPool(poolId: number, layerId: string | null = null): number {
    return this.poolMembers.get(poolKey(poolId, layerId))?.size ?? 0;
  }

  getSpawn(spawnId: number): CreatureSpawn | undefined {
    return this.data.spawns.get(spawnId);
  }

  getTemplate(templateId: number): CreatureTemplate | undefined {
    return this.data.templates.get(templateId);
  }

  /**
   * Remove a live creature. By default schedules its slot to respawn after the
   * rolled respawn window (or `delayMs` if given).
   */
  despawn(instanceId: number, now: number, opts: { respawn?: boolean; delayMs?: number } = {}): void {
    const instance = this.registry.remove(instanceId);
    if (!instance) return;
    const key = slotKey(instance.spawnId, instance.layerId);
    if (this.live.get(key) === instanceId) {
      this.live.delete(key);
      if (instance.layerId !== null) this.liveByLayer.get(instance.layerId)?.delete(key);
    }
    if (instance.poolId !== null) {
      const pk = poolKey(instance.poolId, instance.layerId);
      const members = this.poolMembers.get(pk);
      members?.delete(instanceId);
      if (members && members.size === 0) this.poolMembers.delete(pk);
    }
    this.hooks.onDespawn?.(instance);

    if (opts.respawn === false) return;
    const spawn = this.data.spawns.get(instance.spawnId);
    if (!spawn || !this.slotShouldExist(spawn, instance.layerId)) return;
    this.schedule(spawn.id, instance.layerId, now + (opts.delayMs ?? rollRespawnMs(spawn, this.respawnMultiplier, this.r)));
  }

  private schedule(spawnId: number, layerId: string | null, dueAt: number): void {
    this.pending.set(slotKey(spawnId, layerId), { spawnId, layerId, dueAt });
  }

  private slotShouldExist(spawn: CreatureSpawn, layerId: string | null): boolean {
    if (spawn.layer_policy === "shared") return layerId === null;
    return layerId !== null && (this.layers.get(spawn.map)?.has(layerId) ?? false);
  }

  private reconcileLayers(now: number): void {
    // Drop copies and pending respawns on layers that are gone.
    for (const [key, instanceId] of [...this.live]) {
      const instance = this.registry.get(instanceId);
      const spawn = instance ? this.data.spawns.get(instance.spawnId) : undefined;
      if (!instance) {
        this.live.delete(key);
        for (const keys of this.liveByLayer.values()) keys.delete(key);
        continue;
      }
      if (!spawn) {
        // Spawn point was deleted: remove its creature for good.
        this.despawn(instanceId, now, { respawn: false });
        continue;
      }
      if (!this.slotShouldExist(spawn, instance.layerId)) this.despawn(instanceId, now, { respawn: false });
    }
    for (const [key, slot] of [...this.pending]) {
      const spawn = this.data.spawns.get(slot.spawnId);
      if (!spawn || !this.slotShouldExist(spawn, slot.layerId)) this.pending.delete(key);
    }
    // Give every live layer its copies.
    for (const [map, spawnIds] of this.perLayerSpawnsByMap) {
      const layerIds = this.layers.get(map);
      if (!layerIds) continue;
      for (const layerId of layerIds) {
        for (const spawnId of spawnIds) {
          const key = slotKey(spawnId, layerId);
          if (!this.live.has(key) && !this.pending.has(key)) this.schedule(spawnId, layerId, now);
        }
      }
    }
  }

  private trySpawn(spawnId: number, layerId: string | null, now: number): CreatureInstance | null {
    const key = slotKey(spawnId, layerId);
    if (this.live.has(key)) return null;
    const spawn = this.data.spawns.get(spawnId);
    if (!spawn || !this.slotShouldExist(spawn, layerId)) return null;

    const pool = spawn.pool_id !== null ? this.data.pools.get(spawn.pool_id) : undefined;
    if (pool && this.activeInPool(pool.id, layerId) >= pool.max_active) {
      this.schedule(spawnId, layerId, now + POOL_RETRY_MS);
      return null;
    }

    const rareAlive = pool ? this.isRareAlive(pool, layerId) : false;
    const template = this.data.templates.get(pickTemplateId(spawn, pool, rareAlive, this.r))
      ?? this.data.templates.get(spawn.template_id);
    if (!template) return null;

    const level = rollLevel(template, this.r);
    const maxHealth = computeMaxHealth(template, level);
    const instance: CreatureInstance = {
      id: this.registry.allocateId(),
      templateId: template.id,
      spawnId: spawn.id,
      poolId: pool ? pool.id : null,
      map: spawn.map,
      layerId,
      x: spawn.x,
      y: spawn.y,
      dir: spawn.direction,
      homeX: spawn.x,
      homeY: spawn.y,
      level,
      health: maxHealth,
      maxHealth,
      state: AIState.IDLE,
      spawnedAt: now,
      move: null,
      // Stagger first wander/patrol moves so a map's creatures don't all step at once.
      waitUntil: now + Math.floor(this.r() * 3000),
      patrolIndex: 0,
      patrolForward: true,
      sentX: spawn.x,
      sentY: spawn.y,
      sentDir: spawn.direction,
      sentMoving: false,
      combat: createCombatState(),
      auras: createAuras(),
      casting: null,
      abilityStates: new Map(),
    };

    this.registry.add(instance);
    this.live.set(key, instance.id);
    if (layerId !== null) {
      const keys = this.liveByLayer.get(layerId) ?? new Set<string>();
      keys.add(key);
      this.liveByLayer.set(layerId, keys);
    }
    if (pool) {
      const pk = poolKey(pool.id, layerId);
      let members = this.poolMembers.get(pk);
      if (!members) {
        members = new Set();
        this.poolMembers.set(pk, members);
      }
      members.add(instance.id);
    }
    this.hooks.onSpawn?.(instance);
    return instance;
  }

  private isRareAlive(pool: CreatureSpawnPool, layerId: string | null): boolean {
    if (pool.rare_template_id === null) return false;
    for (const id of this.poolMembers.get(poolKey(pool.id, layerId)) ?? []) {
      if (this.registry.get(id)?.templateId === pool.rare_template_id) return true;
    }
    return false;
  }
}
