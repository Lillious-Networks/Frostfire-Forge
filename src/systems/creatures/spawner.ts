import { logNoIds, nextEntityId } from "../../cluster/entityids";
import { isBaseLayer } from "../../services/layermanager";
import log from "../../modules/logger";
import { POOL_RETRY_MS, RESPAWN_MULTIPLIER, randInt, rng, type Rng } from "./constants";
import { CreatureRegistry } from "./registry";
import { createAuras } from "./auras";
import { createCombatState } from "./threat";
import {
  AIState,
  type CreatureInstance,
  type CreaturePatrolPath,
  type CreatureSpawn,
  type CreatureSpawnPool,
  type CreatureTemplate,
} from "./types";

export interface SpawnerData {
  templates: Map<number, CreatureTemplate>;
  spawns: Map<number, CreatureSpawn>;
  pools: Map<number, CreatureSpawnPool>;
  /** Patrol paths by id, so patrol spawns start on their route. */
  patrolPaths?: Map<number, CreaturePatrolPath>;
}

/** Cluster mode, on a creature's home: a slot whose live creature was handed to another node. */
export interface AwaySlot {
  instanceId: number;
  spawnId: number;
  layerId: string | null;
  poolId: number | null;
  templateId: number;
  holder: string;
}

/**
 * Cluster mode: a spawn slot as it travels with its block (cells phase 7). A waiting slot carries the time it has
 * left; a held slot's creature lives on `holder`.
 */
export type MovedSlot =
  | { kind: "waiting"; spawnId: number; layerId: string | null; inMs: number }
  | { kind: "held"; spawnId: number; layerId: string | null; instanceId: number; poolId: number | null; templateId: number; holder: string };

/** How long the old owner of a moved slot answers for it: holders may still send it news of the creature. */
export const OUTGOING_KEEP_MS = 60_000;
/** The longest wait a moved slot may carry. */
const MAX_MOVED_WAIT_MS = 24 * 60 * 60_000;

export interface SpawnerHooks {
  onSpawn?(instance: CreatureInstance): void;
  onDespawn?(instance: CreatureInstance): void;
  /** A foreign creature (its spawn slot is on another node) left the world here: tell its home. */
  onForeignGone?(instance: CreatureInstance, home: string, opts: { respawn: boolean; delayMs: number | null }): void;
  /**
   * How many players of a layer stand in the block holding (x, y). Without it
   * every layer is filled everywhere; with it per_layer copies on an overflow
   * layer exist only in blocks where that layer has players.
   */
  playersInBlock?(layerId: string, x: number, y: number): number;
  /**
   * Cluster mode: whether this node spawns at (x, y) of the map (its block is
   * this node's; or no one's, once the start grace is over). A slot it says no
   * to is not spawned here and waits for reviewOwnership. Absent: always.
   */
  spawnsHere?(map: string, x: number, y: number): boolean;
}

/** How long an overflow-layer block stands empty before its per-layer creatures are removed. */
export const EMPTY_BLOCK_DESPAWN_MS = 60_000;
/** How often a per-layer slot waiting for a player in its block looks again. */
const DORMANT_RETRY_MS = 1_000;
/** How often live overflow-layer creatures are checked for an empty block. */
const EMPTY_SWEEP_MS = 1_000;

/** Idle, wandering or patrolling: not fighting, returning home or dead. */
export const isOutOfCombat = (c: CreatureInstance): boolean =>
  c.state === AIState.IDLE || c.state === AIState.WANDER || c.state === AIState.PATROL;

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
  /** overflow-layer slot -> when its block was first seen without a player of the layer */
  private emptySince = new Map<string, number>();
  /** Slots that came due where this node does not spawn (spawnsHere): not spawned, kept for when it does. */
  private elsewhere = new Map<string, PendingSlot>();
  /**
   * Cluster mode, on a creature's home: slots whose live creature was handed to another node. The slot stays
   * taken (never spawned again) until the holder reports the creature dead or lost (releaseAway).
   */
  private away = new Map<string, AwaySlot>();
  private awayIds = new Map<number, string>();
  /** Cluster mode, on a holder: creatures handed over here whose slot is on another node (their home). */
  private foreign = new Map<number, string>();
  /**
   * Cluster mode, on a block's old owner: slots that moved with the block, for OUTGOING_KEEP_MS. Each is also an
   * elsewhere slot here; reviewOwnership leaves it alone, as the block table says this node until the move commits.
   * `moving` holds from export until the move is sent (settleSlots); a restore removes the entry.
   */
  private outgoing = new Map<string, { to: string; until: number; instanceId: number | null; templateId: number | null; moving: boolean }>();
  private lastSweepAt = -Infinity;

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
    this.elsewhere.clear();
    this.outgoing.clear();
    // A reload starts every slot over. The holders find their creatures' slots gone at their next sweep.
    // Released one by one, so an away creature also leaves its pool and no pool is left counting it.
    for (const slot of this.awaySlots()) this.releaseAway(slot.instanceId, now, { respawn: false });
    // A foreign creature is gone here for good; its home is told to respawn it, which its own slot check may refuse.
    for (const id of [...this.foreign.keys()]) this.despawn(id, now);
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
        if (!this.isKnown(slotKey(spawn.id, null))) this.schedule(spawn.id, null, now);
      } else {
        const list = this.perLayerSpawnsByMap.get(spawn.map) ?? [];
        list.push(spawn.id);
        this.perLayerSpawnsByMap.set(spawn.map, list);
      }
    }
    this.reconcileLayers(now);
    // A deleted spawn point's creature is gone for good, also one that is away.
    for (const slot of this.awaySlots()) {
      if (!data.spawns.has(slot.spawnId)) this.releaseAway(slot.instanceId, now, { respawn: false });
    }
    // A skipped spawn point may have been moved into a block this node spawns in.
    this.reviewOwnership(now);
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
        if (!this.isKnown(slotKey(spawnId, layerId))) this.schedule(spawnId, layerId, now);
      }
    }
  }

  /**
   * Cluster mode, after the block table changed (or the start grace ended): skipped slots this node now spawns are
   * scheduled, at their own due time if it is still ahead. A slot that just moved off with its block is left alone:
   * the table still says this node until the coordinator commits the move.
   */
  reviewOwnership(now: number): void {
    this.pruneOutgoing(now);
    for (const [key, slot] of [...this.elsewhere]) {
      const spawn = this.data.spawns.get(slot.spawnId);
      if (!spawn || !this.slotShouldExist(spawn, slot.layerId)) {
        this.elsewhere.delete(key);
        continue;
      }
      if (this.outgoing.has(key)) continue;
      if (!this.spawnsHere(spawn)) continue;
      this.elsewhere.delete(key);
      if (!this.isKnown(key)) this.schedule(slot.spawnId, slot.layerId, Math.max(now, slot.dueAt));
    }
  }

  /** Live, waiting to spawn, skipped because this node does not spawn there, or handed to another node. */
  private isKnown(key: string): boolean {
    return this.live.has(key) || this.pending.has(key) || this.elsewhere.has(key) || this.away.has(key);
  }

  private spawnsHere(spawn: CreatureSpawn): boolean {
    if (!this.hooks.spawnsHere) return true;
    const home = this.homeOf(spawn);
    return this.hooks.spawnsHere(spawn.map, home.x, home.y);
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
    for (const [key, slot] of [...this.elsewhere]) {
      if (slot.layerId === layerId) this.elsewhere.delete(key);
    }
    for (const slot of this.awaySlots()) {
      if (slot.layerId === layerId) this.releaseAway(slot.instanceId, now, { respawn: false });
    }
    for (const id of [...this.foreign.keys()]) {
      if (this.registry.get(id)?.layerId === layerId) this.despawn(id, now);
    }
  }

  tick(now: number): void {
    this.sweepEmptyBlocks(now);
    let budget = MAX_SPAWNS_PER_TICK;
    for (const [key, slot] of this.pending) {
      if (slot.dueAt > now) continue;
      const spawn = this.data.spawns.get(slot.spawnId);
      // Not this node's part of the map (or not yet): the slot waits, out of `pending`, until it is.
      if (spawn && !this.spawnsHere(spawn)) {
        this.pending.delete(key);
        this.elsewhere.set(key, slot);
        continue;
      }
      // A copy on an overflow layer waits for a player of that layer in its
      // block; the check is cheap and does not use the spawn budget.
      if (this.waitsForPlayers(slot.spawnId, slot.layerId)) {
        slot.dueAt = now + DORMANT_RETRY_MS;
        continue;
      }
      this.pending.delete(key);
      this.trySpawn(slot.spawnId, slot.layerId, now);
      // Overdue slots keep their place in `pending` and spawn on later ticks.
      if (--budget <= 0) return;
    }
  }

  /** True for a per_layer slot on an overflow layer whose spawn block has no player of the layer. */
  private waitsForPlayers(spawnId: number, layerId: string | null): boolean {
    if (layerId === null || !this.hooks.playersInBlock || isBaseLayer(layerId)) return false;
    const spawn = this.data.spawns.get(spawnId);
    if (!spawn) return false;
    const home = this.homeOf(spawn);
    return this.hooks.playersInBlock(layerId, home.x, home.y) === 0;
  }

  /**
   * Overflow-layer creatures whose block (where they spawned, or where they
   * are now) has had no player of their layer for EMPTY_BLOCK_DESPAWN_MS are
   * removed, with no rewards. Only settled creatures go: one fighting (maybe
   * with a player just over the block edge) or dead (a corpse, maybe with
   * loot, which the corpse timer removes) is left alone and its empty time
   * starts again. The slot then respawns after its normal respawn roll, once
   * a player is back in the block, so leaving and returning is no quick reset.
   */
  private sweepEmptyBlocks(now: number): void {
    const playersInBlock = this.hooks.playersInBlock;
    if (!playersInBlock || now - this.lastSweepAt < EMPTY_SWEEP_MS) return;
    this.lastSweepAt = now;
    for (const [layerId, keys] of [...this.liveByLayer]) {
      if (isBaseLayer(layerId)) continue;
      for (const key of [...keys]) {
        const instanceId = this.live.get(key);
        const instance = instanceId !== undefined ? this.registry.get(instanceId) : undefined;
        if (!instance) continue;
        if (!isOutOfCombat(instance) ||
          playersInBlock(layerId, instance.homeX, instance.homeY) > 0 || playersInBlock(layerId, instance.x, instance.y) > 0) {
          this.emptySince.delete(key);
          continue;
        }
        const since = this.emptySince.get(key);
        if (since === undefined) {
          this.emptySince.set(key, now);
        } else if (now - since >= EMPTY_BLOCK_DESPAWN_MS) {
          this.despawn(instance.id, now);
        }
      }
    }
  }

  /** Where a spawn point's creature starts: a patrol's first point, else the placed position. */
  private homeOf(spawn: CreatureSpawn): { x: number; y: number } {
    if (spawn.movement_type === "patrol" && spawn.patrol_path_id !== null) {
      const first = this.data.patrolPaths?.get(spawn.patrol_path_id)?.points[0];
      if (first) return { x: first.x, y: first.y };
    }
    return { x: spawn.x, y: spawn.y };
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
    if (this.awayIds.has(instanceId)) {
      // The slot is away: this is its mirror here. The slot stays taken until the holder reports (releaseAway).
      this.hooks.onDespawn?.(instance);
      return;
    }
    const home = this.foreign.get(instanceId);
    if (home !== undefined) {
      // Not this node's slot: its home schedules the respawn.
      this.foreign.delete(instanceId);
      this.hooks.onDespawn?.(instance);
      this.hooks.onForeignGone?.(instance, home, { respawn: opts.respawn !== false, delayMs: opts.delayMs ?? null });
      return;
    }
    const key = slotKey(instance.spawnId, instance.layerId);
    if (this.live.get(key) === instanceId) {
      this.live.delete(key);
      this.emptySince.delete(key);
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

  /** The live creature `instanceId` was handed to `holder`: its slot stays taken, and is not spawned again. */
  markAway(instanceId: number, holder: string): boolean {
    const instance = this.registry.get(instanceId);
    if (!instance) return false;
    const key = slotKey(instance.spawnId, instance.layerId);
    if (this.live.get(key) !== instanceId) return false;
    this.live.delete(key);
    this.emptySince.delete(key);
    if (instance.layerId !== null) this.liveByLayer.get(instance.layerId)?.delete(key);
    // Pool membership stays: the creature still counts toward its pool, and as its rare.
    this.away.set(key, {
      instanceId, spawnId: instance.spawnId, layerId: instance.layerId, poolId: instance.poolId,
      templateId: instance.templateId, holder,
    });
    this.awayIds.set(instanceId, key);
    return true;
  }

  /** An away creature moved on from one holder to another. */
  moveAway(instanceId: number, holder: string): boolean {
    const key = this.awayIds.get(instanceId);
    const slot = key !== undefined ? this.away.get(key) : undefined;
    if (!slot) return false;
    slot.holder = holder;
    return true;
  }

  /** The away creature died or was lost: free its slot, and respawn it unless told not to. Idempotent. */
  releaseAway(instanceId: number, now: number, opts: { respawn?: boolean; delayMs?: number | null } = {}): boolean {
    const key = this.awayIds.get(instanceId);
    const slot = key !== undefined ? this.away.get(key) : undefined;
    if (key === undefined || !slot) return false;
    this.away.delete(key);
    this.awayIds.delete(instanceId);
    if (slot.poolId !== null) {
      const pk = poolKey(slot.poolId, slot.layerId);
      const members = this.poolMembers.get(pk);
      members?.delete(instanceId);
      if (members && members.size === 0) this.poolMembers.delete(pk);
    }
    if (opts.respawn === false) return true;
    const spawn = this.data.spawns.get(slot.spawnId);
    if (!spawn || !this.slotShouldExist(spawn, slot.layerId)) return true;
    this.schedule(spawn.id, slot.layerId, now + (opts.delayMs ?? rollRespawnMs(spawn, this.respawnMultiplier, this.r)));
    return true;
  }

  awaySlots(): AwaySlot[] {
    return [...this.away.values()].map((slot) => ({ ...slot }));
  }

  /**
   * Take in a creature handed over here. `home` is the node that owns its spawn slot (null: this node). Returns
   * false, taking in nothing, for a creature whose home is this node but whose away slot is gone (a reload, a
   * deleted spawn point or a vanished layer released it): its slot may already hold a fresh copy.
   */
  adopt(instance: CreatureInstance, home: string | null, opts: { announce?: boolean } = {}): boolean {
    const key = this.awayIds.get(instance.id);
    if (home === null && key === undefined) {
      log.warn(`[Creatures] ${this.data.templates.get(instance.templateId)?.name ?? "Creature"} #${instance.id} came back to its home with no slot held for it, and was lost`);
      return false;
    }
    // A mirror of it left here earlier may still be registered: replace it, so no cell keeps a stale id (the mirror count is the caller's).
    this.registry.remove(instance.id);
    this.registry.add(instance);
    if (key !== undefined) {
      // Back home: the away slot is live again.
      this.away.delete(key);
      this.awayIds.delete(instance.id);
      this.live.set(key, instance.id);
      if (instance.layerId !== null) {
        let keys = this.liveByLayer.get(instance.layerId);
        if (!keys) this.liveByLayer.set(instance.layerId, (keys = new Set()));
        keys.add(key);
      }
    } else if (home !== null) {
      this.foreign.set(instance.id, home);
    }
    if (opts.announce) this.hooks.onSpawn?.(instance);
    return true;
  }

  /** Stop holding a foreign creature with no despawn (it was handed on). */
  dropForeign(instanceId: number): void {
    this.foreign.delete(instanceId);
  }

  foreignHome(instanceId: number): string | null {
    return this.foreign.get(instanceId) ?? null;
  }

  /** How many foreign creatures this node holds; the handoff sweep of the dormant ones skips its walk at 0. */
  foreignCount(): number {
    return this.foreign.size;
  }

  /** The instance ids of the foreign creatures, without a copy (tickCreatures' sweep of the dormant ones). */
  foreignIds(): IterableIterator<number> {
    return this.foreign.keys();
  }

  foreignCreatures(): Array<{ instanceId: number; home: string }> {
    return [...this.foreign].map(([instanceId, home]) => ({ instanceId, home }));
  }

  /**
   * Cluster mode, a block moving to `to`: every slot whose spawn point lies in the block (`inBlock` of its home)
   * leaves this node. A waiting slot goes with the time it has left. A live slot goes held by this node (`self`):
   * its creature stays here, foreign now, with home `to`. An away slot goes with its holder. A held slot's pool
   * place goes with it. Each one stays here as an elsewhere slot, and as outgoing for OUTGOING_KEEP_MS.
   */
  exportSlots(inBlock: (map: string, x: number, y: number) => boolean, to: string, self: string, now: number): MovedSlot[] {
    this.pruneOutgoing(now);
    const inside = (spawnId: number) => {
      const spawn = this.data.spawns.get(spawnId);
      if (!spawn) return false;
      const home = this.homeOf(spawn);
      return inBlock(spawn.map, home.x, home.y);
    };
    const out: MovedSlot[] = [];
    const left = new Map<string, { slot: PendingSlot; instanceId: number | null; templateId: number | null }>();
    for (const [key, instanceId] of [...this.live]) {
      const instance = this.registry.get(instanceId);
      if (!instance || !inside(instance.spawnId)) continue;
      this.live.delete(key);
      this.emptySince.delete(key);
      if (instance.layerId !== null) this.liveByLayer.get(instance.layerId)?.delete(key);
      this.leavePool(instance.poolId, instance.layerId, instanceId);
      this.foreign.set(instanceId, to);
      out.push({ kind: "held", spawnId: instance.spawnId, layerId: instance.layerId, instanceId, poolId: instance.poolId, templateId: instance.templateId, holder: self });
      left.set(key, { slot: { spawnId: instance.spawnId, layerId: instance.layerId, dueAt: now }, instanceId, templateId: instance.templateId });
    }
    for (const [key, slot] of [...this.away]) {
      if (!inside(slot.spawnId)) continue;
      this.away.delete(key);
      this.awayIds.delete(slot.instanceId);
      this.leavePool(slot.poolId, slot.layerId, slot.instanceId);
      out.push({ kind: "held", ...slot });
      left.set(key, { slot: { spawnId: slot.spawnId, layerId: slot.layerId, dueAt: now }, instanceId: slot.instanceId, templateId: slot.templateId });
    }
    for (const waiting of [this.pending, this.elsewhere]) {
      for (const [key, slot] of [...waiting]) {
        if (!inside(slot.spawnId)) continue;
        waiting.delete(key);
        out.push({ kind: "waiting", spawnId: slot.spawnId, layerId: slot.layerId, inMs: Math.max(0, slot.dueAt - now) });
        left.set(key, { slot: { ...slot }, instanceId: null, templateId: null });
      }
    }
    for (const [key, { slot, instanceId, templateId }] of left) {
      this.elsewhere.set(key, slot);
      this.outgoing.set(key, { to, until: now + OUTGOING_KEEP_MS, instanceId, templateId, moving: true });
    }
    return out;
  }

  /**
   * Cluster mode: the move that took these slots out was sent, so their creatures may be handed on again (to the new
   * owner first of all). The slots stay outgoing for the rest of OUTGOING_KEEP_MS (or of the hold, holdSlots).
   */
  settleSlots(slots: MovedSlot[]): void {
    for (const slot of slots) {
      const entry = this.outgoing.get(slotKey(slot.spawnId, slot.layerId));
      if (entry) entry.moving = false;
    }
  }

  /**
   * Cluster mode: the move that took these slots out is not decided yet and its old owner keeps holding them (blockmove.ts,
   * UNDECIDED_HOLD_MS), past OUTGOING_KEEP_MS. They are answered for for `forMs` more from `now`, still moving: a creature
   * stays here, foreign, so a restore finds it, and no second one is spawned or handed on meanwhile.
   */
  holdSlots(slots: MovedSlot[], now: number, forMs: number): void {
    for (const slot of slots) {
      const entry = this.outgoing.get(slotKey(slot.spawnId, slot.layerId));
      if (entry) entry.until = Math.max(entry.until, now + forMs);
    }
  }

  /**
   * True while the slot of creature `instanceId` is moving out with its block: taken out (exportSlots), neither sent
   * nor put back. Its creature must stay here, foreign, so a restore finds it and no second one is spawned.
   */
  movingOut(instanceId: number, now: number): boolean {
    this.pruneOutgoing(now);
    for (const entry of this.outgoing.values()) if (entry.instanceId === instanceId) return entry.moving;
    return false;
  }

  /** The template of the creature whose slot moved out with its block, while this node answers for it; else null. */
  outgoingTemplate(instanceId: number): number | null {
    for (const entry of this.outgoing.values()) if (entry.instanceId === instanceId) return entry.templateId;
    return null;
  }

  /**
   * Cluster mode, a node died (node-dead): the slots that were sent to it are no longer answered for here, so their
   * holders' sweeps find them gone. Called with dropForeignFrom(to), which removes their creatures still here. A slot
   * still moving is kept: its move ends in a restore or a send. How many.
   */
  forgetOutgoingTo(to: string): number {
    let dropped = 0;
    for (const [key, entry] of [...this.outgoing]) {
      if (entry.to !== to || entry.moving) continue;
      this.outgoing.delete(key);
      dropped++;
    }
    return dropped;
  }

  /**
   * Cluster mode: take in the slots of a block that moved here (accept), or put back the ones a move that did not
   * happen took out (restore). `self` is this node. A slot this node already has live or away is not taken: the one
   * here keeps its creature. How many were taken.
   */
  importSlots(slots: MovedSlot[], now: number, self: string): number {
    let taken = 0;
    for (const slot of slots) {
      const key = slotKey(slot.spawnId, slot.layerId);
      const spawn = this.data.spawns.get(slot.spawnId);
      const templateId = slot.kind === "held" ? slot.templateId : (spawn?.template_id ?? 0);
      const name = `${this.data.templates.get(templateId)?.name ?? "Creature"} slot ${key}`;
      this.outgoing.delete(key);
      if (!spawn || !this.slotShouldExist(spawn, slot.layerId)) {
        log.warn(`[Creatures] ${name} moved here has no spawn point here, and was dropped`);
        continue;
      }
      if (this.live.has(key) || this.away.has(key)) {
        log.warn(`[Creatures] ${name} moved here is already held here: the one here is kept`);
        continue;
      }
      this.pending.delete(key);
      this.elsewhere.delete(key);
      taken++;
      if (slot.kind === "waiting") {
        const wait = Number.isFinite(slot.inMs) ? Math.min(Math.max(0, slot.inMs), MAX_MOVED_WAIT_MS) : 0;
        this.schedule(slot.spawnId, slot.layerId, now + wait);
        continue;
      }
      // Its creature is here as a foreign one: the old owner's, the new owner's on a restore, or one its holder
      // handed here before the slot arrived. Then the slot is held here, whatever its holder field says: an away slot
      // would name a node that no longer has the creature, and its sweep would spawn a second one.
      const instance = this.registry.get(slot.instanceId);
      const here = !!instance && !instance.remote && this.foreign.has(slot.instanceId);
      if (slot.holder !== self && !here) {
        this.away.set(key, {
          instanceId: slot.instanceId, spawnId: slot.spawnId, layerId: slot.layerId, poolId: slot.poolId,
          templateId: slot.templateId, holder: slot.holder,
        });
        this.awayIds.set(slot.instanceId, key);
        this.joinPool(slot.poolId, slot.layerId, slot.instanceId);
        continue;
      }
      if (instance && here) {
        this.foreign.delete(slot.instanceId);
        this.setLive(key, instance);
        this.joinPool(slot.poolId, slot.layerId, slot.instanceId);
      } else {
        // It died or was handed on while the block moved: the slot respawns on its own roll.
        this.schedule(slot.spawnId, slot.layerId, now + rollRespawnMs(spawn, this.respawnMultiplier, this.r));
      }
    }
    return taken;
  }

  /**
   * For OUTGOING_KEEP_MS after its slot moved with its block: the node the slot of creature `instanceId` went to.
   * Null while the move is not decided (still moving): a move put back keeps the slot here.
   */
  outgoingHome(instanceId: number, now: number): string | null {
    this.pruneOutgoing(now);
    for (const entry of this.outgoing.values()) if (entry.instanceId === instanceId) return entry.moving ? null : entry.to;
    return null;
  }

  /**
   * A foreign creature's slot moved with its block to `home` (CREATURE_HOME). home null: it moved to this node, which
   * holds it away for this creature, so the creature is this node's live one again. False when the creature is not
   * foreign here, or (home null) no away slot here is held for it.
   */
  rehome(instanceId: number, home: string | null): boolean {
    if (!this.foreign.has(instanceId)) return false;
    if (home !== null) {
      this.foreign.set(instanceId, home);
      return true;
    }
    const key = this.awayIds.get(instanceId);
    const instance = this.registry.get(instanceId);
    if (key === undefined || !instance) return false;
    this.foreign.delete(instanceId);
    this.away.delete(key);
    this.awayIds.delete(instanceId);
    // Pool membership stays: an away slot keeps it.
    this.setLive(key, instance);
    return true;
  }

  /** Cluster mode, a holder died (node-dead): every slot it held is freed and respawns here. How many. */
  releaseAwayHeldBy(holder: string, now: number): number {
    let freed = 0;
    for (const slot of this.awaySlots()) {
      if (slot.holder === holder && this.releaseAway(slot.instanceId, now, { respawn: true })) freed++;
    }
    return freed;
  }

  /**
   * Cluster mode, a home died (node-dead): its creatures held here are removed, with no CREATURE_DIED (no one is
   * there to hear it). Its blocks are refilled, and their slots respawn on the new owners. How many.
   */
  dropForeignFrom(home: string): number {
    let dropped = 0;
    for (const [instanceId, from] of [...this.foreign]) {
      if (from !== home) continue;
      this.foreign.delete(instanceId);
      const instance = this.registry.remove(instanceId);
      if (instance) this.hooks.onDespawn?.(instance);
      dropped++;
    }
    return dropped;
  }

  private pruneOutgoing(now: number): void {
    for (const [key, entry] of [...this.outgoing]) if (now > entry.until) this.outgoing.delete(key);
  }

  private setLive(key: string, instance: CreatureInstance): void {
    this.live.set(key, instance.id);
    if (instance.layerId !== null) {
      let keys = this.liveByLayer.get(instance.layerId);
      if (!keys) this.liveByLayer.set(instance.layerId, (keys = new Set()));
      keys.add(key);
    }
  }

  private joinPool(poolId: number | null, layerId: string | null, instanceId: number): void {
    if (poolId === null) return;
    const pk = poolKey(poolId, layerId);
    let members = this.poolMembers.get(pk);
    if (!members) this.poolMembers.set(pk, (members = new Set()));
    members.add(instanceId);
  }

  private leavePool(poolId: number | null, layerId: string | null, instanceId: number): void {
    if (poolId === null) return;
    const pk = poolKey(poolId, layerId);
    const members = this.poolMembers.get(pk);
    members?.delete(instanceId);
    if (members && members.size === 0) this.poolMembers.delete(pk);
  }

  private schedule(spawnId: number, layerId: string | null, dueAt: number): void {
    const key = slotKey(spawnId, layerId);
    this.elsewhere.delete(key);
    this.pending.set(key, { spawnId, layerId, dueAt });
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
    for (const waiting of [this.pending, this.elsewhere]) {
      for (const [key, slot] of [...waiting]) {
        const spawn = this.data.spawns.get(slot.spawnId);
        if (!spawn || !this.slotShouldExist(spawn, slot.layerId)) waiting.delete(key);
      }
    }
    // Give every live layer its copies.
    for (const [map, spawnIds] of this.perLayerSpawnsByMap) {
      const layerIds = this.layers.get(map);
      if (!layerIds) continue;
      for (const layerId of layerIds) {
        for (const spawnId of spawnIds) {
          if (!this.isKnown(slotKey(spawnId, layerId))) this.schedule(spawnId, layerId, now);
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

    // Ids are the world's: with none to give (the cluster's counter is unreachable) the spawn waits, as a full pool's does.
    let id: number;
    try {
      id = nextEntityId();
    } catch (error) {
      logNoIds("creatures", `[Creatures] Spawn ${spawnId} skipped, will retry: ${error}`);
      this.schedule(spawnId, layerId, now + POOL_RETRY_MS);
      return null;
    }

    const level = rollLevel(template, this.r);
    const maxHealth = computeMaxHealth(template, level);
    // A patrol spawn's spawnpoint is the first point of its path: the
    // creature starts on its route instead of walking in from the marker.
    // Anything else (no path, an empty path, another movement type) keeps the
    // placed position.
    const { x: homeX, y: homeY } = this.homeOf(spawn);
    const instance: CreatureInstance = {
      id,
      templateId: template.id,
      spawnId: spawn.id,
      poolId: pool ? pool.id : null,
      map: spawn.map,
      layerId,
      x: homeX,
      y: homeY,
      dir: spawn.direction,
      homeX,
      homeY,
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
      sentX: homeX,
      sentY: homeY,
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
      const awayKey = this.awayIds.get(id);
      const templateId = awayKey !== undefined ? this.away.get(awayKey)?.templateId : this.registry.get(id)?.templateId;
      if (templateId === pool.rare_template_id) return true;
    }
    return false;
  }
}
