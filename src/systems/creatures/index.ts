import AOI_CONFIG from "../../config/aoi.json";
import log from "../../modules/logger";
import assetCache from "../../services/assetCache";
import { weaponProfile, type WeaponProfile } from "./combat";
import layerManager from "../../services/layermanager";
import mapIndex from "../../services/mapindex";
import playerCache from "../../services/playermanager";
import spatialGrid from "../../services/spatialgrid";
import { packetManager } from "../../socket/packet_manager";
import { Events, listener, setPlayerPvp } from "../events";
import lootTable from "../lootTable";
import { getCreatureEngineBridge } from "./bridge";
import {
  buildEditorData,
  canUseEditor,
  debugRadii,
  validateAbility,
  planAbilitySet,
  validateLinkGroup,
  validatePatrolPath,
  validatePool,
  validateSpawn,
  validateTemplate,
  type ValidationContext,
} from "./editor";
import { corpseLoot, handleKill, openCorpse, takeCorpseLoot, tapStateFor } from "./kill";
import { DEBUG_EVERY_TICKS, LAYER_SYNC_EVERY_TICKS, SYNC_EVERY_TICKS, TICK_MS, rng } from "./constants";
import { CreatureCombatSystem, type CombatText, type PlayerUnit } from "./engine";
import { NavGridCache } from "./navgrid";
import registry from "./registry";
import repository, { CACHE_KEYS } from "./repository";
import { CreatureSpawner, type SpawnerData } from "./spawner";
import { CreatureSync, type SyncPlayer } from "./sync";
import { AIState, type CreatureAbility, type CreatureInstance, type CreaturePatrolPath, type CreatureSpawn, type CreatureSpawnPool, type CreatureTemplate } from "./types";
import { aurasPayload } from "./auras";
import { registerHostileEffectType, registerSpellEffect } from "../spelleffects";
import { setCreatureZoneHandler } from "../groundaoe";
import { getIconUrl, getNpcSpriteLayers, getSpriteUrl } from "../../modules/spriteSheetManager";

let templates = new Map<number, CreatureTemplate>();
let patrolPaths = new Map<number, CreaturePatrolPath>();
let abilitiesByTemplate = new Map<number, CreatureAbility[]>();
let spellsById = new Map<number, SpellData>();
const NO_ABILITIES: CreatureAbility[] = [];
export const navGrids = new NavGridCache();

function send(wt: any, packets: any[]): void {
  if (!wt || !wt.send || wt.readyState !== 1) return;
  try {
    for (const p of packets) wt.send(p);
  } catch {
    // Connection closing; the next refresh drops the viewer.
  }
}

function sendBestEffort(wt: any, packets: any[]): void {
  if (!wt || wt.readyState !== 1) return;
  if (typeof wt.sendBestEffort !== "function") return send(wt, packets);
  try {
    for (const p of packets) wt.sendBestEffort(p);
  } catch {
    // Datagram dropped; the next move supersedes it.
  }
}

const normMap = (map: any) => String(map || "").replaceAll(".json", "");

function resolvePlayer(id: string): SyncPlayer | null {
  const p = playerCache.get(id);
  const pos = p?.location?.position;
  if (!p || !p.wt || p.wt.readyState !== 1 || !pos) return null;
  if (typeof pos.x !== "number" || typeof pos.y !== "number") return null;
  return {
    id,
    wt: p.wt,
    map: normMap(p.location.map),
    layerId: layerManager.getPlayerLayer(id),
    x: pos.x,
    y: pos.y,
    radius: p.aoi?.aoiRadius || (AOI_CONFIG as any).DEFAULT_RADIUS || 1000,
  };
}

function toPlayerUnit(id: string, p: any): PlayerUnit | null {
  const pos = p?.location?.position;
  if (!p || !pos || typeof pos.x !== "number" || typeof pos.y !== "number") return null;
  const stats = p.stats || {};
  return {
    id,
    username: p.username,
    map: normMap(p.location.map),
    layerId: layerManager.getPlayerLayer(id),
    x: pos.x,
    y: pos.y,
    dir: pos.direction || "down",
    level: Number(stats.level) || 1,
    alive: !p.isDead && !p.isGhost && (stats.health ?? 1) > 0,
    gmHidden: !!p.isStealth,
    stealthed: !!p.isVanished,
    casting: !!p.casting,
    dodgePct: Number(stats.stat_avoidance) || 0,
    critPct: Number(stats.stat_critical_chance) || 0,
    critDamagePct: Number(stats.stat_critical_damage) || 0,
    statDamage: Number(stats.stat_damage) || 0,
    armorPct: Number(stats.stat_armor) || 0,
    weapon: equippedWeapon(p),
  };
}

/** The item in the player's weapon slot, as a swing profile. */
function equippedWeapon(p: any): WeaponProfile | null {
  const name = p?.equipment?.weapon;
  if (!name || name === "null") return null;
  const item = itemsByName.get(String(name).toLowerCase());
  return weaponProfile(item);
}

/** item name (lowercase) -> item, for weapon lookups on every swing */
let itemsByName = new Map<string, Item>();

/** Items are editable at runtime; refresh the weapon lookup with the spell cache. */
async function refreshItems(): Promise<void> {
  const list = ((await assetCache.get("items")) || []) as Item[];
  itemsByName = new Map(list.filter((i) => i?.name).map((i) => [i.name.toLowerCase(), i]));
}

export const sync = new CreatureSync({
  registry,
  getTemplate: (id) => templates.get(id),
  playersOnMap: (map) => mapIndex.getPlayersOnMap(map),
  resolvePlayer,
  sendSpawn: (wt, snapshots) => send(wt, packetManager.creatureSpawn(snapshots)),
  sendDespawn: (wt, ids) => send(wt, packetManager.creatureDespawn(ids)),
  sendMoves: (wt, entries, reliable) =>
    (reliable ? send : sendBestEffort)(wt, packetManager.creatureMove(entries)),
  decorate: (snapshot, creature, playerId) => {
    snapshot.spriteLayers = spriteLayersByTemplate.get(creature.templateId) ?? null;
    snapshot.auras = aurasPayload(creature.auras, Date.now(), spellIcon);
    snapshot.tap = tapStateFor(creature, playerId);
    const username = playerCache.get(playerId)?.username;
    snapshot.lootable = creature.state === AIState.DEAD && !!username && corpseLoot.canLoot(creature.id, username);
  },
});

/** link group id -> spawn ids */
let linkGroups = new Map<number, number[]>();
/** template id -> resolved sprite sheet URLs (null when the template has no sprite) */
let spriteLayersByTemplate = new Map<number, unknown>();

function sendTapStates(creature: CreatureInstance): void {
  for (const playerId of sync.viewersOf(creature.id)) {
    const player = playerCache.get(playerId);
    if (player?.wt) send(player.wt, packetManager.creatureTap({ id: creature.id, tap: tapStateFor(creature, playerId) }));
  }
}

/** Creatures whose health changed this tick; flushed once per tick. */
const healthDirty = new Set<number>();

export const combat = new CreatureCombatSystem(registry, {
  rng,
  template: (id) => templates.get(id),
  spawn: (id) => spawner.getSpawn(id),
  patrol: (spawn) => (spawn?.patrol_path_id != null ? patrolPaths.get(spawn.patrol_path_id) : undefined),
  grid: (map) => navGrids.get(map),
  getPlayer: (id) => toPlayerUnit(id, playerCache.get(id)),
  playersNear: (map, x, y, radius) => {
    // Grid cells lag real positions by the AOI update threshold; pad the query.
    const ids = spatialGrid.getPlayersInRadius(x, y, radius + 128, map);
    const out: PlayerUnit[] = [];
    for (const id of ids) {
      const unit = toPlayerUnit(id, playerCache.get(id));
      if (unit && unit.map === map && Math.hypot(unit.x - x, unit.y - y) <= radius) out.push(unit);
    }
    return out;
  },
  damagePlayer: (creature, playerId, amount, outcome) => {
    const player = playerCache.get(playerId);
    const bridge = getCreatureEngineBridge();
    if (!player || !bridge) return;
    const name = templates.get(creature.templateId)?.name ?? "Creature";
    Promise.resolve(bridge.damagePlayer(player, amount, { isCrit: outcome === "crit" || outcome === "crush", creatureId: creature.id, creatureName: name }))
      .catch((error) => log.error(`Creature damage to player failed: ${error}`));
  },
  dazePlayer: (playerId) => {
    const player = playerCache.get(playerId);
    const bridge = getCreatureEngineBridge();
    if (player && bridge) Promise.resolve(bridge.dazePlayer(player)).catch(() => {});
  },
  markPlayerInCombat: (playerId) => {
    const player = playerCache.get(playerId);
    if (!player) return;
    setPlayerPvp(player, true);
    player.last_attack = performance.now();
  },
  onHealthChanged: (creature) => healthDirty.add(creature.id),
  onStateChanged: (creature) => {
    const packets = packetManager.creatureState({
      id: creature.id,
      state: creature.state,
      victimId: creature.combat.threat.victimId,
    });
    sync.sendToViewers(creature.id, (wt) => send(wt, packets));
  },
  onCombatText: (text: CombatText) => {
    const packets = packetManager.creatureCombatText(text);
    sync.sendToViewers(text.creatureId, (wt) => sendBestEffort(wt, packets));
  },
  onDied: (creature, killerId) => {
    const template = templates.get(creature.templateId);
    listener.emit(Events.CREATURE_KILLED, {
      creature,
      template,
      killer: killerId ? playerCache.get(killerId) ?? null : null,
      tapper: creature.combat.tapper,
    });
    if (template) handleKill(creature, template).catch((error) => log.error(`Creature kill rewards failed: ${error}`));
  },
  onAutoAttackStopped: (playerId, creatureId) => {
    const player = playerCache.get(playerId);
    if (player?.wt) send(player.wt, packetManager.creatureAttackStopped(creatureId));
  },
  onTapChanged: (creature) => sendTapStates(creature),
  spell: (id) => spellsById.get(id),
  abilities: (templateId) => abilitiesByTemplate.get(templateId) ?? NO_ABILITIES,
  applySpellEffectsToPlayer: (creature, playerId, spell) => {
    const player = playerCache.get(playerId);
    const bridge = getCreatureEngineBridge();
    if (!player || !bridge) return;
    const caster = { id: `creature:${creature.id}`, username: templates.get(creature.templateId)?.name ?? "Creature", isCreature: true };
    Promise.resolve(bridge.applySpellEffects(player, caster, spell)).catch((error) => log.error(`Creature spell effects failed: ${error}`));
  },
  // Projectile flight: spells land when the visual arrives, not on cast.
  later: (ms, fn) => {
    setTimeout(() => {
      try {
        fn();
      } catch (error) {
        log.error(`Creature spell impact failed: ${error}`);
      }
    }, ms);
  },
  onCastStart: (creature) => {
    const cast = creature.casting;
    if (!cast) return;
    const packets = packetManager.creatureCast({
      id: creature.id,
      spell: cast.spellName,
      durationMs: cast.endsAt - cast.startedAt,
      targetId: cast.target.kind === "creature" ? `creature:${cast.target.id}` : cast.target.id,
    });
    sync.sendToViewers(creature.id, (wt) => send(wt, packets));
  },
  onSpellLaunch: (creature, spell, target) => {
    const packets = packetManager.projectile({
      id: creatureUnitKey(creature.id),
      time: CREATURE_PROJECTILE_SECONDS,
      target_id: target.kind === "creature" ? creatureUnitKey(Number(target.id)) : target.id,
      spell: spell.name,
      icon: getIconUrl((spell as any).icon ?? null),
      creature: true,
      particles: spellParticles(spell),
    });
    if (packets.length) sync.sendToViewers(creature.id, (wt) => sendBestEffort(wt, packets));
  },
  onCastEnd: (creature, spell, result) => {
    const packets = packetManager.creatureCastEnd({ id: creature.id, spell, result });
    sync.sendToViewers(creature.id, (wt) => send(wt, packets));
  },
  onAurasChanged: (creature) => {
    const packets = packetManager.creatureAuras({ id: creature.id, auras: aurasPayload(creature.auras, Date.now(), spellIcon) });
    sync.sendToViewers(creature.id, (wt) => send(wt, packets));
  },
  linkedCreatures: (creature) => {
    const spawn = spawner.getSpawn(creature.spawnId);
    if (spawn?.link_group_id == null) return [];
    const out: CreatureInstance[] = [];
    for (const spawnId of linkGroups.get(spawn.link_group_id) ?? []) {
      if (spawnId === creature.spawnId) continue;
      const linked = spawner.getSpawn(spawnId);
      const layer = linked?.layer_policy === "shared" ? null : creature.layerId;
      const id = spawner.getLiveInstanceId(spawnId, layer);
      const instance = id !== undefined ? registry.get(id) : undefined;
      if (instance) out.push(instance);
    }
    return out;
  },
});

export const spawner = new CreatureSpawner(registry, {
  onSpawn: (instance) => sync.onSpawn(instance),
  onDespawn: (instance) => {
    combat.forget(instance);
    corpseLoot.remove(instance.id);
    healthDirty.delete(instance.id);
    sync.onDespawn(instance);
  },
});

function flushHealth(): void {
  for (const id of healthDirty) {
    const c = registry.get(id);
    if (!c) continue;
    const packets = packetManager.creatureHealth({ id: c.id, health: c.health, maxHealth: c.maxHealth });
    sync.sendToViewers(id, (wt) => send(wt, packets));
  }
  healthDirty.clear();
}

/** Spells are editable at runtime; keep a synchronous id lookup for the tick loop. */
async function refreshSpells(): Promise<void> {
  const list = ((await assetCache.get("spells")) || []) as SpellData[];
  spellsById = new Map(list.filter((s) => s?.id != null).map((s) => [Number(s.id), s]));
  spellIcons = new Map(list.filter((s) => s?.name).map((s) => [s.name, getSpriteUrl((s as any).icon ?? null)]));
  const particles = ((await assetCache.get("particles")) || []) as Array<Record<string, unknown>>;
  particlesByName = new Map(particles.filter((p) => p?.name).map((p) => [String(p.name).toLowerCase(), p]));
}

/** Creatures apply spells instantly; the projectile is a short cosmetic flight. */
const CREATURE_PROJECTILE_SECONDS = 0.3;

/** Client-side id for a creature, matching the client's creature target keys. */
const creatureUnitKey = (id: number) => `c:${id}`;

/** Particle definitions named by a spell, resolved against the cached particle list. */
function spellParticles(spell: SpellData): unknown[] | null {
  const names = String((spell as any).particles ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return null;
  const resolved = names
    .map((name) => particlesByName.get(name.toLowerCase()))
    .filter((p): p is Record<string, unknown> => p != null);
  return resolved.length > 0 ? resolved : null;
}

/** particle name (lowercase) -> particle definition */
let particlesByName = new Map<string, Record<string, unknown>>();

/** spell name -> icon URL, for creature buff/debuff icons */
let spellIcons = new Map<string, string | null>();
const spellIcon = (spell: string): string | null => spellIcons.get(spell) ?? null;

async function buildSpawnerData(): Promise<SpawnerData> {
  const tList = ((await assetCache.get(CACHE_KEYS.templates)) || []) as CreatureTemplate[];
  const sList = ((await assetCache.get(CACHE_KEYS.spawns)) || []) as CreatureSpawn[];
  const pList = ((await assetCache.get(CACHE_KEYS.pools)) || []) as CreatureSpawnPool[];
  const ppList = ((await assetCache.get(CACHE_KEYS.patrolPaths)) || []) as CreaturePatrolPath[];
  templates = new Map(tList.map((t) => [t.id, t]));
  spriteLayersByTemplate = new Map(
    tList.map((t) => [
      t.id,
      t.sprite_type === "none" || !t.sprite
        ? null
        : getNpcSpriteLayers({
            sprite_type: t.sprite_type,
            sprite_body: t.sprite,
            sprite_head: t.sprite_head,
            sprite_helmet: t.sprite_helmet,
            sprite_shoulderguards: t.sprite_shoulderguards,
            sprite_neck: t.sprite_neck,
            sprite_hands: t.sprite_hands,
            sprite_chest: t.sprite_chest,
            sprite_feet: t.sprite_feet,
            sprite_legs: t.sprite_legs,
            sprite_weapon: t.sprite_weapon,
          }),
    ])
  );
  patrolPaths = new Map(ppList.map((p) => [p.id, p]));
  const aList = ((await assetCache.get(CACHE_KEYS.abilities)) || []) as CreatureAbility[];
  abilitiesByTemplate = new Map();
  for (const a of aList) {
    const list = abilitiesByTemplate.get(a.template_id) ?? [];
    list.push(a);
    abilitiesByTemplate.set(a.template_id, list);
  }
  await refreshSpells();
  await refreshItems();
  linkGroups = new Map();
  for (const s of sList) {
    if (s.link_group_id == null) continue;
    const list = linkGroups.get(s.link_group_id) ?? [];
    list.push(s.id);
    linkGroups.set(s.link_group_id, list);
  }
  return {
    templates,
    spawns: new Map(sList.map((s) => [s.id, s])),
    pools: new Map(pList.map((p) => [p.id, p])),
  };
}

/** Rebuild navigation grids for every map that has creature spawns (no-op if unchanged). */
async function refreshNavGrids(spawns: Iterable<CreatureSpawn>): Promise<void> {
  const maps = new Set<string>();
  for (const s of spawns) maps.add(s.map);
  if (maps.size === 0) return;
  const props = ((await assetCache.get("mapProperties")) || []) as any[];
  for (const map of maps) {
    const prop = props.find((m) => normMap(m?.name) === map);
    const rle = await assetCache.getNested(map, "collision");
    const built = navGrids.update(map, Array.isArray(rle) ? rle : null, Number(prop?.tileWidth) || 32, Number(prop?.tileHeight) || 32);
    if (built) log.debug(`Creature nav grid built for ${map}`);
    else if (!navGrids.get(map)) log.warn(`No collision data for creature map "${map}"; creatures there will not move`);
  }
}

function currentLayers(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const map of spawner.perLayerMaps()) {
    result.set(map, layerManager.getLayersForMap(map).map((l) => l.layerId));
  }
  return result;
}

let spawnCache: CreatureSpawn[] = [];

/** Re-read creature tables from the database and respawn everything. */
export async function reload(): Promise<void> {
  await repository.loadIntoCache();
  const data = await buildSpawnerData();
  spawnCache = [...data.spawns.values()];
  await refreshNavGrids(spawnCache);
  spawner.load(data, Date.now());
  spawner.setLayers(currentLayers(), Date.now());
  log.info(`Creatures reloaded: ${templates.size} template(s), ${registry.size} live`);
}

export interface CreatureDataChange {
  templateIds?: number[];
  spawnIds?: number[];
  patrolPathIds?: number[];
}

const isOutOfCombat = (c: CreatureInstance) =>
  c.state === AIState.IDLE || c.state === AIState.WANDER || c.state === AIState.PATROL;

/**
 * Apply an editor change: reload data, spawn new spawn points, remove deleted
 * ones, and respawn only the creatures the change affects. Creatures that are
 * fighting finish their fight first.
 */
export async function applyDataChange(change: CreatureDataChange): Promise<void> {
  await repository.loadIntoCache();
  const data = await buildSpawnerData();
  spawnCache = [...data.spawns.values()];
  await refreshNavGrids(spawnCache);
  const now = Date.now();
  spawner.updateData(data, now);

  const templateIds = new Set(change.templateIds ?? []);
  const spawnIds = new Set(change.spawnIds ?? []);
  const pathIds = new Set(change.patrolPathIds ?? []);
  let refreshed = 0;
  for (const creature of [...registry.all()]) {
    const spawn = spawner.getSpawn(creature.spawnId);
    const affected =
      templateIds.has(creature.templateId) ||
      spawnIds.has(creature.spawnId) ||
      (spawn?.patrol_path_id != null && pathIds.has(spawn.patrol_path_id));
    if (!affected || creature.state === AIState.DEAD) continue;
    refreshed++;
    if (isOutOfCombat(creature)) spawner.despawn(creature.id, now, { delayMs: 0 });
    else creature.pendingRefresh = true;
  }
  log.info(`Creature data updated: ${refreshed} creature(s) refreshed, ${registry.size} live`);
}

// ------------------------------------------------------------ tick profiling

/** Ring buffer of recent tick durations in ms, for the load test's percentiles. */
const TICK_SAMPLES = 3000;
const tickSamples = new Float64Array(TICK_SAMPLES);
let tickSampleCount = 0;
let tickCursor = 0;
let ticksTotal = 0;
let tickedCreatures = 0;
let statsSince = Date.now();

type PhaseName = "layers" | "spawner" | "ai" | "sync" | "debug";

/** Per-phase totals, so a tick spike can be attributed instead of guessed at. */
const phaseStats: Record<PhaseName, { total: number; max: number; calls: number }> = {
  layers: { total: 0, max: 0, calls: 0 },
  spawner: { total: 0, max: 0, calls: 0 },
  ai: { total: 0, max: 0, calls: 0 },
  sync: { total: 0, max: 0, calls: 0 },
  debug: { total: 0, max: 0, calls: 0 },
};

function recordPhase(name: PhaseName, ms: number): void {
  const stat = phaseStats[name];
  stat.total += ms;
  stat.calls++;
  if (ms > stat.max) stat.max = ms;
}

function recordTick(ms: number): void {
  tickSamples[tickCursor] = ms;
  tickCursor = (tickCursor + 1) % TICK_SAMPLES;
  if (tickSampleCount < TICK_SAMPLES) tickSampleCount++;
  ticksTotal++;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * Creature system health: tick cost and how much of the world is awake.
 * Read by the load test through the game server's /creature-stats route.
 */
export function stats(): Record<string, unknown> {
  const samples = Array.from(tickSamples.slice(0, tickSampleCount)).sort((a, b) => a - b);
  const observedIds = [...sync.observedIds()];
  const activeIds = [...combat.activeIds()];
  const awake = new Set<number>([...observedIds, ...activeIds]).size;
  return {
    creatures: registry.size,
    // Dormant creatures are skipped entirely: nobody can see them and they are not fighting.
    awake,
    dormant: Math.max(0, registry.size - awake),
    observed: observedIds.length,
    inCombat: activeIds.length,
    maps: [...registry.mapsWithCreatures()].length,
    templates: templates.size,
    tick: {
      ms: TICK_MS,
      count: ticksTotal,
      avgCreaturesPerTick: ticksTotal > 0 ? Number((tickedCreatures / ticksTotal).toFixed(1)) : 0,
      p50: Number(percentile(samples, 50).toFixed(3)),
      p95: Number(percentile(samples, 95).toFixed(3)),
      p99: Number(percentile(samples, 99).toFixed(3)),
      max: Number((samples.at(-1) ?? 0).toFixed(3)),
      // Share of the 100ms budget spent on creatures at p95.
      budgetPctP95: Number(((percentile(samples, 95) / TICK_MS) * 100).toFixed(1)),
      samples: tickSampleCount,
      sinceMs: Date.now() - statsSince,
    },
    phases: Object.fromEntries(
      Object.entries(phaseStats).map(([name, stat]) => [
        name,
        {
          avg: stat.calls > 0 ? Number((stat.total / stat.calls).toFixed(3)) : 0,
          max: Number(stat.max.toFixed(3)),
          calls: stat.calls,
        },
      ])
    ),
  };
}

/** Drop collected samples, so a measurement window can start clean. */
export function resetStats(): void {
  for (const stat of Object.values(phaseStats)) {
    stat.total = 0;
    stat.max = 0;
    stat.calls = 0;
  }
  tickSampleCount = 0;
  tickCursor = 0;
  ticksTotal = 0;
  tickedCreatures = 0;
  statsSince = Date.now();
}

function tickCreatures(now: number): void {
  // Creatures that someone can see, plus anything mid-fight/evade/flee (which
  // must finish even if every observer walked away).
  const ids = new Set<number>(sync.observedIds());
  for (const id of combat.activeIds()) ids.add(id);

  const ticked: CreatureInstance[] = [];
  for (const id of ids) {
    const creature = registry.get(id);
    if (!creature) continue;
    if (creature.state === AIState.DEAD) {
      if (now >= creature.combat.corpseUntil) spawner.despawn(creature.id, now);
      continue;
    }
    if (creature.pendingRefresh && isOutOfCombat(creature)) {
      spawner.despawn(creature.id, now, { delayMs: 0 });
      continue;
    }
    combat.tick(creature, now, TICK_MS);
    ticked.push(creature);
  }
  tickedCreatures += ticked.length;
  combat.tickPlayerAttacks(now);
  sync.flushMoves(ticked);
  flushHealth();
}

/** Corpses nobody can see still need to despawn so their spawn point respawns. */
function sweepUnobservedCorpses(now: number): void {
  for (const creature of registry.all()) {
    if (creature.state === AIState.DEAD && now >= creature.combat.corpseUntil && !sync.isObserved(creature.id)) {
      spawner.despawn(creature.id, now);
    }
  }
}

// ------------------------------------------------------------ player API

/** Validate and start auto-attacking a creature. Returns an error reason or null. */
export function startAutoAttack(player: any, creatureId: number): string | null {
  if (!player?.id) return "invalid_player";
  return combat.startAutoAttack(player.id, creatureId, Date.now());
}

export function stopAutoAttack(player: any): void {
  if (player?.id) combat.stopAutoAttack(player.id, false);
}

export function getCreature(id: number): CreatureInstance | undefined {
  return registry.get(id);
}

export function getTemplate(id: number): CreatureTemplate | undefined {
  return templates.get(id);
}

/** Same map and layer, and alive: the creature can be targeted by this player. */
export function isTargetableBy(player: any, creature: CreatureInstance): boolean {
  if (!player?.location || creature.state === AIState.DEAD) return false;
  // GM stealth is meant to be non-interactive: an invisible admin cannot be
  // seen or hit, so they cannot attack, cast on or tab-target creatures either.
  if (player.isStealth) return false;
  if (normMap(player.location.map) !== creature.map) return false;
  return creature.layerId === null || creature.layerId === layerManager.getPlayerLayer(player.id);
}

/** Tile line of sight between a player and a creature (true when the map has no grid). */
export function openCorpseFor(player: any, creatureId: number) {
  return openCorpse(player, registry.get(creatureId));
}

export function takeCorpseLootFor(player: any, creatureId: number, indices: number[] | null) {
  return takeCorpseLoot(player, registry.get(creatureId), indices);
}

/** Living, targetable creatures within `radius` of a point, for AoE splash. */
export function creaturesInRadius(player: any, x: number, y: number, radius: number): CreatureInstance[] {
  return registry.queryRadius(normMap(player?.location?.map), x, y, radius).filter((c) => isTargetableBy(player, c));
}

/** Creatures in the player's facing cone, closest first (tab targeting). */
export function coneTargets(player: any, range: number, coneAngleDeg: number): Array<{ id: number; distance: number }> {
  const pos = player?.location?.position;
  if (!pos) return [];
  const facing: Record<string, number> = { right: 0, downright: 45, down: 90, downleft: 135, left: 180, upleft: -135, up: -90, upright: -45 };
  const facingAngle = facing[pos.direction || "down"] ?? 90;
  const half = coneAngleDeg / 2;
  const out: Array<{ id: number; distance: number }> = [];
  for (const c of creaturesInRadius(player, pos.x, pos.y, range)) {
    const angle = (Math.atan2(c.y - pos.y, c.x - pos.x) * 180) / Math.PI;
    let diff = Math.abs(angle - facingAngle) % 360;
    if (diff > 180) diff = 360 - diff;
    if (diff <= half) out.push({ id: c.id, distance: Math.hypot(c.x - pos.x, c.y - pos.y) });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

export function hasLineOfSight(player: any, creature: CreatureInstance): boolean {
  const grid = navGrids.get(creature.map);
  const pos = player?.location?.position;
  if (!grid || !pos) return true;
  return grid.lineOfSight(pos, creature);
}

/**
 * Player spell effects that act on creature threat. Taunt is resolved when a
 * spell lands on a creature (applySpellToCreature); these handle self-cast
 * threat drops that affect every creature the caster is fighting.
 */
function registerPlayerThreatEffects(): void {
  registerHostileEffectType("taunt");
  registerSpellEffect("taunt", () => {});
  registerSpellEffect("feign_death", ({ caster }) => {
    if (!caster?.id || !caster.stats) return;
    const resisted = combat.feignDeath(caster.id, Number(caster.stats.level) || 1, Date.now());
    if (resisted > 0 && caster.wt) send(caster.wt, packetManager.notify({ message: "Feign Death was resisted." }));
  });
  registerSpellEffect("threat", ({ caster, target, effect }) => {
    if (!caster?.id || !caster.stats || target?.id !== caster.id) return;
    combat.modifyThreatEverywhere(caster.id, Number(effect.value) || 0);
  });
}


// ----------------------------------------------------------------- editor

/** Players with the editor window open (they receive change broadcasts). */
const editorViewers = new Set<string>();
/** Players with the in-world debug overlay enabled. */
const debugViewers = new Set<string>();

export const editorViewerIds = (): string[] => [...editorViewers];

/**
 * The player's client has dropped every creature (it loaded a map, even the
 * same one again): forget what they were sent so the next sync pass sends
 * everything around them afresh. Otherwise the server would think they still
 * have those creatures and they would stay invisible.
 */
export function resyncPlayer(playerId: string): void {
  sync.forget(playerId);
}

export function closeEditorFor(playerId: string): void {
  editorViewers.delete(playerId);
  debugViewers.delete(playerId);
}

export function setDebugSubscription(playerId: string, on: boolean): void {
  if (on) debugViewers.add(playerId);
  else debugViewers.delete(playerId);
}

async function validationContext(): Promise<ValidationContext> {
  const [paths, groups, pools, lootTables] = await Promise.all([
    repository.listPatrolPaths(),
    repository.listLinkGroups(),
    repository.listSpawnPools(),
    lootTable.list().catch(() => [] as any[]),
  ]);
  const maps = (((await assetCache.get("mapProperties")) || []) as any[]).map((m) => normMap(m?.name)).filter(Boolean);
  return {
    templateIds: new Set(templates.keys()),
    spellIds: new Set(spellsById.keys()),
    lootTableIds: new Set((lootTables as any[]).map((t) => Number(t.id))),
    pathIds: new Map(paths.map((p) => [p.id, p.map])),
    linkGroupIds: new Set(groups.map((g) => g.id)),
    poolIds: new Set(pools.map((p) => p.id)),
    maps: new Set(maps),
    navGrids,
  };
}

export interface EditorResult {
  kind: "data" | "result" | "goto" | "none";
  ok: boolean;
  errors: string[];
  id?: number;
  data?: unknown;
  goto?: { map: string; x: number; y: number };
}

const fail = (errors: string[]): EditorResult => ({ kind: "result", ok: false, errors });
const done = (id?: number): EditorResult => ({ kind: "result", ok: true, errors: [], id });

/**
 * Handle one editor packet. Validation runs first; a successful write reloads
 * every creature from the database so the world matches the editor.
 */
export async function handleEditorPacket(player: any, type: string, data: any): Promise<EditorResult> {
  if (!canUseEditor(player)) return fail(["You do not have permission to use the creature editor."]);
  const id = Number(data?.id) || 0;

  switch (type) {
    case "CREATURE_EDITOR_LIST": {
      editorViewers.add(player.id);
      return { kind: "data", ok: true, errors: [], data: await buildEditorData() };
    }
    case "CREATURE_EDITOR_CLOSE": {
      closeEditorFor(player.id);
      return { kind: "none", ok: true, errors: [] };
    }
    case "CREATURE_EDITOR_SAVE_TEMPLATE": {
      const errors = validateTemplate(data, await validationContext());
      if (errors.length) return fail(errors);
      const savedId = await repository.saveTemplate(data);
      await applyDataChange({ templateIds: [savedId] });
      return done(savedId);
    }
    case "CREATURE_EDITOR_DELETE_TEMPLATE": {
      if (!id) return fail(["Nothing selected."]);
      await repository.deleteTemplate(id);
      await applyDataChange({ templateIds: [id] });
      return done(id);
    }
    case "CREATURE_EDITOR_SAVE_ABILITY": {
      const errors = validateAbility(data, await validationContext());
      if (errors.length) return fail(errors);
      const savedId = await repository.saveAbility(data);
      // Abilities are read live; no respawn needed.
      await applyDataChange({});
      return done(savedId);
    }
    case "CREATURE_EDITOR_DELETE_ABILITY": {
      if (!id) return fail(["Nothing selected."]);
      await repository.deleteAbility(id);
      await applyDataChange({});
      return done(id);
    }
    case "CREATURE_EDITOR_SAVE_ABILITIES": {
      // A creature's full ability list, saved as one: added, changed and
      // removed abilities all go through together or not at all (validation).
      const templateId = Number(data?.template_id) || 0;
      const plan = planAbilitySet(
        templateId,
        data?.abilities,
        await repository.listAbilities(),
        await validationContext(),
        (spellId) => spellsById.get(spellId)?.name
      );
      if (plan.errors.length) return fail(plan.errors);
      for (const ability of plan.upserts) await repository.saveAbility(ability);
      for (const abilityId of plan.deleteIds) await repository.deleteAbility(abilityId);
      // Abilities are read live; no respawn needed.
      await applyDataChange({});
      return done(templateId);
    }
    case "CREATURE_EDITOR_SAVE_SPAWN": {
      const errors = validateSpawn(data, await validationContext());
      if (errors.length) return fail(errors);
      const savedId = await repository.saveSpawn(data);
      await applyDataChange({ spawnIds: [savedId] });
      return done(savedId);
    }
    case "CREATURE_EDITOR_DELETE_SPAWN": {
      if (!id) return fail(["Nothing selected."]);
      await repository.deleteSpawn(id);
      await applyDataChange({ spawnIds: [id] });
      return done(id);
    }
    case "CREATURE_EDITOR_SAVE_PATH": {
      const errors = validatePatrolPath(data, await validationContext());
      if (errors.length) return fail(errors);
      const savedId = await repository.savePatrolPath(data);
      await applyDataChange({ patrolPathIds: [savedId] });
      return done(savedId);
    }
    case "CREATURE_EDITOR_DELETE_PATH": {
      if (!id) return fail(["Nothing selected."]);
      await repository.deletePatrolPath(id);
      await applyDataChange({ patrolPathIds: [id] });
      return done(id);
    }
    case "CREATURE_EDITOR_SAVE_LINKGROUP": {
      const errors = validateLinkGroup(data);
      if (errors.length) return fail(errors);
      const savedId = await repository.saveLinkGroup(data);
      await applyDataChange({});
      return done(savedId);
    }
    case "CREATURE_EDITOR_DELETE_LINKGROUP": {
      if (!id) return fail(["Nothing selected."]);
      await repository.deleteLinkGroup(id);
      await applyDataChange({});
      return done(id);
    }
    case "CREATURE_EDITOR_SAVE_POOL": {
      const errors = validatePool(data, await validationContext());
      if (errors.length) return fail(errors);
      const savedId = await repository.saveSpawnPool(data);
      // Pool limits apply to the next spawn attempt.
      await applyDataChange({});
      return done(savedId);
    }
    case "CREATURE_EDITOR_DELETE_POOL": {
      if (!id) return fail(["Nothing selected."]);
      await repository.deleteSpawnPool(id);
      await applyDataChange({});
      return done(id);
    }
    case "CREATURE_EDITOR_ACTION":
      return handleEditorAction(player, data);
    default:
      return fail(["Unknown editor action."]);
  }
}

/** Live world actions from the editor: kill, respawn, reset, teleport to a spawn. */
async function handleEditorAction(player: any, data: any): Promise<EditorResult> {
  const action = String(data?.action ?? "");
  const now = Date.now();
  const creature = data?.creatureId != null ? registry.get(Number(data.creatureId)) : undefined;

  switch (action) {
    case "kill":
      if (!creature || creature.state === AIState.DEAD) return fail(["That creature is not alive."]);
      combat.die(creature, null, now);
      return done(creature.id);
    case "reset":
      if (!creature || creature.state === AIState.DEAD) return fail(["That creature is not alive."]);
      combat.evade(creature, now);
      return done(creature.id);
    case "respawn": {
      if (creature) {
        spawner.despawn(creature.id, now, { delayMs: 0 });
        return done(creature.id);
      }
      const spawnId = Number(data?.spawnId) || 0;
      if (!spawnId) return fail(["Nothing selected."]);
      const live = spawner.getLiveInstanceId(spawnId, layerManager.getPlayerLayer(player.id));
      if (live !== undefined) spawner.despawn(live, now, { delayMs: 0 });
      return done(spawnId);
    }
    case "goto": {
      const spawn = spawner.getSpawn(Number(data?.spawnId) || 0);
      if (!spawn) return fail(["Spawn point not found."]);
      return { kind: "goto", ok: true, errors: [], goto: { map: spawn.map, x: spawn.x, y: spawn.y } };
    }
    default:
      return fail(["Unknown editor action."]);
  }
}

/** Debug overlay payload for one admin: creatures they can see, with AI internals. */
export function buildDebugPayload(playerId: string): { creatures: any[] } | null {
  if (!debugViewers.has(playerId)) return null;
  const viewer = playerCache.get(playerId);
  const level = Number(viewer?.stats?.level) || 1;
  const out: any[] = [];
  for (const id of sync.knownBy(playerId)) {
    const creature = registry.get(id);
    const template = creature ? templates.get(creature.templateId) : undefined;
    if (!creature || !template) continue;
    const spawn = spawner.getSpawn(creature.spawnId);
    out.push({
      id: creature.id,
      spawnId: creature.spawnId,
      state: creature.state,
      layerId: creature.layerId,
      home: { x: Math.round(creature.homeX), y: Math.round(creature.homeY) },
      combatStart: creature.combat.startedAt > 0 ? { x: Math.round(creature.combat.startX), y: Math.round(creature.combat.startY) } : null,
      radii: debugRadii(template, level, creature.level, spawn),
      path: creature.move ? creature.move.path.slice(creature.move.index).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) : [],
      victimId: creature.combat.threat.victimId,
      threat: creature.combat.threat.snapshot().map((entry) => ({
        ...entry,
        name: playerCache.get(entry.unitId)?.username ?? entry.unitId,
      })),
    });
  }
  return { creatures: out };
}

function flushDebug(): void {
  for (const playerId of debugViewers) {
    const player = playerCache.get(playerId);
    if (!player?.wt) continue;
    const payload = buildDebugPayload(playerId);
    if (payload) sendBestEffort(player.wt, packetManager.creatureDebug(payload));
  }
}

let initialized = false;

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const data = await buildSpawnerData();
  spawnCache = [...data.spawns.values()];
  await refreshNavGrids(spawnCache);
  spawner.load(data, Date.now());
  spawner.setLayers(currentLayers(), Date.now());
  log.success(`Creature system started: ${templates.size} template(s), ${registry.size} creature(s) spawned`);

  let tick = 0;
  listener.on(Events.FIXED_UPDATE, () => {
    const started = performance.now();
    try {
      const now = Date.now();
      tick++;
      // Each phase is timed separately: the periodic ones (layers, AOI refresh)
      // are the usual cause of a tick spiking well past the others.
      let mark = started;
      const phase = (name: PhaseName) => {
        const at = performance.now();
        recordPhase(name, at - mark);
        mark = at;
      };
      if (tick % LAYER_SYNC_EVERY_TICKS === 0) {
        spawner.setLayers(currentLayers(), now);
        phase("layers");
      }
      spawner.tick(now);
      phase("spawner");
      tickCreatures(now);
      phase("ai");
      // One slice of players per tick: every player is still refreshed every
      // SYNC_EVERY_TICKS, but the cost is spread instead of spiking.
      sync.refresh(tick % SYNC_EVERY_TICKS, SYNC_EVERY_TICKS);
      phase("sync");
      if (tick % DEBUG_EVERY_TICKS === 0) {
        flushDebug();
        phase("debug");
      }
    } catch (error) {
      log.error(`Creature tick failed: ${error}`);
    } finally {
      recordTick(performance.now() - started);
    }
  });

  registerPlayerThreatEffects();

  // Ground AoE zones (e.g. blizzard-style spells) tick on creatures inside them.
  setCreatureZoneHandler((zone, caster) => {
    const now = Date.now();
    // A zone laid down before its caster went into GM stealth stops hurting
    // creatures once they are hidden, same as every other attack path.
    if (caster?.isStealth) return;
    const sourceId = String(caster?.id ?? zone.casterId);
    const casterLayer = caster?.id ? layerManager.getPlayerLayer(caster.id) : null;
    for (const creature of registry.queryRadius(normMap(zone.mapName), zone.position.x, zone.position.y, zone.radius)) {
      if (creature.state === AIState.DEAD) continue;
      if (creature.layerId !== null && creature.layerId !== casterLayer) continue;
      if (zone.damagePerTick > 0) {
        const dealt = combat.damageCreature(creature, sourceId, zone.damagePerTick, now);
        if (dealt > 0) combat.emitCombatText({ creatureId: creature.id, targetId: `creature:${creature.id}`, sourceId, kind: "spell", amount: dealt });
      }
      if (zone.spell && Array.isArray(zone.effects) && zone.effects.length > 0 && (creature.state as AIState) !== AIState.DEAD) {
        combat.applySpellToCreature(creature, sourceId, { ...zone.spell, effects: zone.effects }, now);
      }
    }
  });

  listener.on(Events.SERVER_TICK, () => {
    refreshSpells().catch(() => {});
    sweepUnobservedCorpses(Date.now());
    refreshNavGrids(spawnCache).catch((error) => log.error(`Creature nav grid refresh failed: ${error}`));
  });

  const leaveWorld = (payload: any) => {
    const id = payload?.player?.id;
    if (!id) return;
    closeEditorFor(id);
    combat.removeUnit(id, Date.now());
    sync.forget(id);
  };
  listener.on(Events.PLAYER_LOGOUT, leaveWorld);
  listener.on(Events.PLAYER_DISCONNECT, leaveWorld);
  listener.on(Events.PLAYER_DEATH, (payload: any) => {
    const id = payload?.player?.id;
    if (id) combat.removeUnit(id, Date.now());
  });
  // Party changes can flip who "owns" a tapped creature.
  listener.on(Events.PARTY_CHANGED, () => {
    for (const creature of registry.all()) {
      if (creature.combat.tapper && creature.state !== AIState.DEAD) sendTapStates(creature);
    }
  });
  listener.on(Events.PLAYER_HEALED, (payload: any) => {
    const casterId = payload?.caster?.id;
    const targetId = payload?.target?.id;
    if (casterId && targetId) combat.onPlayerHealed(casterId, targetId, Number(payload.amount) || 0, Date.now());
  });
}

export default {
  init,
  reload,
  applyDataChange,
  registry,
  spawner,
  sync,
  combat,
  navGrids,
  startAutoAttack,
  stopAutoAttack,
  getCreature,
  getTemplate,
  isTargetableBy,
  hasLineOfSight,
  creaturesInRadius,
  coneTargets,
  handleEditorPacket,
  editorViewerIds,
  closeEditorFor,
  resyncPlayer,
  setDebugSubscription,
  canUseEditor,
  openCorpseFor,
  takeCorpseLootFor,
  stats,
  resetStats,
};
