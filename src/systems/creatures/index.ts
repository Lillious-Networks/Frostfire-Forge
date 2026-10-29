import AOI_CONFIG from "../../config/aoi.json";
import { clusterBlocks, onBlocksChanged, reportCreaturesFrom, spawnsHere, usePeerDeathHandlers } from "../../cluster";
import { blockAt } from "../../cluster/blocks";
import { registerCreatureSlots } from "../../cluster/kinds/creatureparts";
import { onApplyEffect, sendEffect, type EffectResult } from "../../cluster/effects";
import { creatureHandoff, type CreatureHandoffDeps, type SerializedCreature } from "../../cluster/creaturehandoff";
import { forwardTable } from "../../cluster/forwarding";
import { ghosts, type GhostKind } from "../../cluster/ghosts";
import { HANDOFFS_PER_TICK, handoffTarget } from "../../cluster/handoffwatch";
import { onLinksAttached, type LinkContext } from "../../cluster/linkhooks";
import { FLAG_MOVING, directionCode, directionName } from "../../cluster/linkproto";
import { bareMap, entityById, mirrorOwner, mirrorsNearPoint, playerLayer } from "../../cluster/mirrors";
import log from "../../modules/logger";
import assetCache from "../../services/assetCache";
import { getWorldMap } from "../../modules/worldmaps";
import { readHeldList, streamSource } from "../npcStreaming";
import { weaponProfile, type WeaponProfile } from "./combat";
import layerManager, { blockOf } from "../../services/layermanager";
import mapIndex from "../../services/mapindex";
import playerCache from "../../services/playermanager";
import spatialGrid from "../../services/spatialgrid";
import { packetManager } from "../../socket/packet_manager";
import { CREATURE_MOVE_MAX_ENTRIES } from "../../socket/creature_move_codec";
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
import { corpseLoot, handleKill, openCorpse, setKnownTemplates, takeCorpseLoot, tapStateFor } from "./kill";
import { setSpellLookup } from "../../cluster/playerhits";
import type { BagRoom } from "../../cluster/remoteitems";
import { DEBUG_EVERY_TICKS, LAYER_SYNC_EVERY_TICKS, SYNC_EVERY_TICKS, TICK_MS, rng } from "./constants";
import { COMBAT_TEXT_KINDS, CreatureCombatSystem, type CombatText, type ForwardedHit, type PlayerUnit } from "./engine";
import { NavGridCache } from "./navgrid";
import registry from "./registry";
import repository, { CACHE_KEYS } from "./repository";
import { CreatureSpawner, isOutOfCombat, type SpawnerData } from "./spawner";
import { CreatureSync, type SyncPlayer } from "./sync";
import { AIState, type CreatureAbility, type CreatureInstance, type CreatureMoveState, type CreaturePatrolPath, type CreatureSpawn, type CreatureSpawnPool, type CreatureTemplate } from "./types";
import { auraStatePayload, aurasPayload, aurasState, createAuras, type AuraState, type CreatureAuras } from "./auras";
import { ThreatTable, createCombatState } from "./threat";
import { registerHostileEffectType, registerSpellEffect } from "../spelleffects";
import { setCreatureZoneHandler } from "../groundaoe";
import { getIconUrl, getNpcSpriteLayers, getSpriteUrl } from "../../modules/spriteSheetManager";
// The writer of durable grants registers itself at load (Task 18). Kills and gathering park grants for it.
import "../grantwriter";

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

/** A player's grid cell is refreshed only after moving UPDATE_THRESHOLD px. */
const GRID_LAG_PAD_PX = Math.max(128, (Number((AOI_CONFIG as any).UPDATE_THRESHOLD) || 100) + 32);

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
    layerId: playerLayer(id) ?? null,
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
  sendMoves: (wt, _entries, reliable, json) =>
    (reliable ? send : sendBestEffort)(wt, packetManager.creatureMoveJson(json)),
  // Moving creatures ride as binary datagrams; the transport splits what does not fit one (TransportConnection.sendBestEffort).
  sendBinaryMoves: (wt, records) => {
    for (let at = 0; at < records.length; at += CREATURE_MOVE_MAX_ENTRIES) {
      sendBestEffort(wt, packetManager.creatureMoveBinary(records.slice(at, at + CREATURE_MOVE_MAX_ENTRIES)));
    }
  },
  decorate: (snapshot, creature, playerId) => {
    snapshot.spriteLayers = spriteLayersByTemplate.get(creature.templateId) ?? null;
    snapshot.auras = creature.remote
      ? auraStatePayload((creature.mirrorAuras ?? []) as AuraState[], Date.now(), spellIcon)
      : aurasPayload(creature.auras, Date.now(), spellIcon);
    snapshot.tap = tapStateFor(creature, playerId);
    const username = playerCache.get(playerId)?.username;
    // A mirror's corpse loot stays with its owner (phase 5).
    snapshot.lootable = !creature.remote && creature.state === AIState.DEAD && !!username && corpseLoot.canLoot(creature.id, username);
  },
});

/** link group id -> spawn ids */
let linkGroups = new Map<number, number[]>();
/** template id -> resolved sprite sheet URLs (null when the template has no sprite) */
let spriteLayersByTemplate = new Map<number, unknown>();

function sendTapStates(creature: CreatureInstance): void {
  // A mirror's tapper is on its owner node, so its party is not known here: until phase 5 its party members see "other".
  for (const playerId of sync.viewersOf(creature.id)) {
    const player = playerCache.get(playerId);
    if (player?.wt) send(player.wt, packetManager.creatureTap({ id: creature.id, tap: tapStateFor(creature, playerId) }));
  }
}

/**
 * Sends to the creature's viewers here and, in cluster mode, to its mirrors' viewers on neighbouring nodes. Takes the
 * id (the combat-text callback has no instance); relay is given the registry's number, as the kind's candidates are.
 */
function toViewers(id: number, packets: any[], bestEffort = false): void {
  sync.sendToViewers(id, (wt) => (bestEffort ? sendBestEffort : send)(wt, packets));
  if (!registry.get(id)?.remote) ghosts.relay("creature", id, packets, bestEffort);
}

/** Creatures whose health changed this tick; flushed once per tick. */
const healthDirty = new Set<number>();

/**
 * What a creature here does to a player another node owns: sent to that node, which applies it (spec §4).
 * `map` and `layerId` are the creature's own, so the target's node can check they are the player's.
 */
type CreatureOnPlayer = {
  kind: "damage" | "daze" | "spell";
  creatureId: number;
  creatureName: string;
  amount?: number;
  isCrit?: boolean;
  spell?: SpellData;
  map?: string;
  layerId?: string | null;
};

/** A player's threat change, sent to the nodes whose creatures fight that player across a border. */
type ThreatOp =
  | { kind: "feign"; playerId: string; level: number }
  | { kind: "modify"; playerId: string; percent: number }
  | { kind: "heal"; casterId: string; targetId: string; amount: number };

/** The attacking creature is passed in, not looked up: a spell that lands after a projectile flight may outlive it. */
function onMirroredPlayer(playerId: string, body: CreatureOnPlayer, creature?: CreatureInstance): void {
  const owner = mirrorOwner(playerId);
  if (!owner) return;
  const sent: CreatureOnPlayer = creature ? { ...body, map: bareMap(creature.map), layerId: creature.layerId } : body;
  void sendEffect(owner, { op: "creature_on_player", target: playerId, body: sent })
    .then((result) => {
      // The player died on its owner. No PLAYER_DEATH for a mirror is heard here, so it leaves the threat tables now.
      if (result?.outcome === "killed") combat.removeUnit(playerId, Date.now());
    })
    .catch(() => {});
}

export const combat = new CreatureCombatSystem(registry, {
  rng,
  template: (id) => templates.get(id),
  spawn: (id) => spawner.getSpawn(id),
  patrol: (spawn) => (spawn?.patrol_path_id != null ? patrolPaths.get(spawn.patrol_path_id) : undefined),
  grid: (map) => navGrids.get(map),
  // A player of a neighbouring node, mirrored here, can be aggroed and fought like a local one; what a creature
  // does to it is sent to its owner (onMirroredPlayer).
  getPlayer: (id) => toPlayerUnit(id, entityById(id)),
  playersNear: (map, x, y, radius) => {
    // aoi.ts only maintains the spatial grid when USE_SPATIAL_GRID is on, and
    // aoi.json is never regenerated once it exists, so an older config can have
    // it off. Fall back to the map index then, or aggro scans see nobody.
    // Grid cells lag real positions by the AOI update threshold; pad by that.
    const ids = AOI_CONFIG.USE_SPATIAL_GRID
      ? spatialGrid.getPlayersInRadius(x, y, radius + GRID_LAG_PAD_PX, map)
      : mapIndex.getPlayersOnMap(map);
    const out: PlayerUnit[] = [];
    // The grid holds mirrored players too (phase 4); the map index holds only this node's, so with no grid
    // the mirrors come from their own store.
    for (const id of ids) {
      const unit = toPlayerUnit(id, entityById(id));
      if (unit && unit.map === map && Math.hypot(unit.x - x, unit.y - y) <= radius) out.push(unit);
    }
    if (!AOI_CONFIG.USE_SPATIAL_GRID) {
      for (const mirror of mirrorsNearPoint(map, x, y, radius)) {
        const unit = toPlayerUnit(String(mirror.id), mirror);
        if (unit) out.push(unit);
      }
    }
    return out;
  },
  damagePlayer: (creature, playerId, amount, outcome) => {
    const name = templates.get(creature.templateId)?.name ?? "Creature";
    if (!playerCache.get(playerId)) {
      onMirroredPlayer(playerId, { kind: "damage", creatureId: creature.id, creatureName: name, amount, isCrit: outcome === "crit" || outcome === "crush" }, creature);
      return;
    }
    const player = playerCache.get(playerId);
    const bridge = getCreatureEngineBridge();
    if (!player || !bridge) return;
    Promise.resolve(bridge.damagePlayer(player, amount, { isCrit: outcome === "crit" || outcome === "crush", creatureId: creature.id, creatureName: name }))
      .catch((error) => log.error(`Creature damage to player failed: ${error}`));
  },
  dazePlayer: (playerId, creature) => {
    if (!playerCache.get(playerId)) {
      onMirroredPlayer(playerId, { kind: "daze", creatureId: creature.id, creatureName: templates.get(creature.templateId)?.name ?? "Creature" }, creature);
      return;
    }
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
    toViewers(creature.id, packets);
  },
  onCombatText: (text: CombatText) => {
    const packets = packetManager.creatureCombatText(text);
    toViewers(text.creatureId, packets, true);
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
  forwardHit: (creature, hit) => {
    const owner = ghosts.ownerOf("creature", creature.id);
    if (!owner) return;
    void sendEffect(owner, { op: "creature_hit", target: creature.id, body: hit })
      .then((result) => {
        // A swing the owner turned away (or never heard) would be sent again every swing: the auto-attack ends.
        // A spell or a zone tick is not an auto-attack, and a refusal of one changes nothing here.
        if (hit.spell || combat.autoAttackTarget(hit.attackerId) !== creature.id) return;
        const gone = !result || result.outcome === "missing" || (result.outcome === "refused" && ["layer", "attacker", "dead"].includes(String(result.reason)));
        if (gone) combat.stopAutoAttack(hit.attackerId, true);
      })
      .catch(() => {});
  },
  spell: (id) => spellsById.get(id),
  abilities: (templateId) => abilitiesByTemplate.get(templateId) ?? NO_ABILITIES,
  applySpellEffectsToPlayer: (creature, playerId, spell) => {
    if (!playerCache.get(playerId)) {
      onMirroredPlayer(playerId, { kind: "spell", creatureId: creature.id, creatureName: templates.get(creature.templateId)?.name ?? "Creature", spell }, creature);
      return;
    }
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
    toViewers(creature.id, packets);
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
    if (packets.length) toViewers(creature.id, packets, true);
  },
  onCastEnd: (creature, spell, result) => {
    const packets = packetManager.creatureCastEnd({ id: creature.id, spell, result });
    toViewers(creature.id, packets);
  },
  onAurasChanged: (creature) => {
    const packets = packetManager.creatureAuras({ id: creature.id, auras: aurasPayload(creature.auras, Date.now(), spellIcon) });
    toViewers(creature.id, packets);
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
  // A creature whose spawn slot is on another node left the world here: its home frees and respawns the slot
  // (CREATURE_DIED, cluster/creaturehandoff.ts). Only a creature handed over here is foreign, so only cluster mode calls it.
  onForeignGone: (instance, home, opts) => creatureHandoff.died(instance.id, instance.templateId, home, opts),
  playersInBlock: (layerId, x, y) => layerManager.countInBlock(layerId, blockOf(x, y)),
  spawnsHere,
});

// Cluster mode: spawn points skipped for another node's block are looked at again when the block table changes,
// and the load report counts the creatures. Outside cluster mode neither is ever called.
onBlocksChanged(() => spawner.reviewOwnership(Date.now()));
/** The ids of the awake creatures: observed by a player, or in combat. The ones tickCreatures ticks. */
function awakeIds(): Set<number> {
  const ids = new Set<number>(sync.observedIds());
  for (const id of combat.activeIds()) ids.add(id);
  return ids;
}

/**
 * The creatures the load report counts: this node's own awake ones (observed, or in combat: the ones tickCreatures
 * ticks), never mirrors. A dormant creature costs no tick, and it stays on the node when its block moves away, so
 * counting it made a node's load answer to nothing the rebalancer did (spec §2: "active creatures").
 */
export function* reportedCreatures(): IterableIterator<CreatureInstance> {
  for (const id of awakeIds()) {
    const creature = registry.get(id);
    if (creature && !creature.remote) yield creature;
  }
}
/** Every live creature of this node's, awake or not: what a harness checks that none was doubled or lost. */
export function reportedCreatureTotal(): number {
  let total = 0;
  for (const creature of registry.all()) if (!creature.remote && creature.state !== AIState.DEAD) total++;
  return total;
}
reportCreaturesFrom(reportedCreatures, reportedCreatureTotal);

function flushHealth(): void {
  for (const id of healthDirty) {
    const c = registry.get(id);
    if (!c) continue;
    const packets = packetManager.creatureHealth({ id: c.id, health: c.health, maxHealth: c.maxHealth });
    toViewers(id, packets);
  }
  healthDirty.clear();
}

// The spell a player_hit from a neighbouring node names is looked up here, as a creature's spell is: in this
// node's own map, which refreshSpells keeps current, so no hit reads the asset cache.
setSpellLookup((id) => spellsById.get(id));

/** The abilities of each template, as the cache holds them (a creature's spells are looked up here). */
export async function refreshAbilities(): Promise<void> {
  const aList = ((await assetCache.get(CACHE_KEYS.abilities)) || []) as CreatureAbility[];
  abilitiesByTemplate = new Map();
  for (const a of aList) {
    const list = abilitiesByTemplate.get(a.template_id) ?? [];
    list.push(a);
    abilitiesByTemplate.set(a.template_id, list);
  }
}

/** The lists refreshSpells last built its maps from. */
let lastSpellList: SpellData[] | null = null;
let lastParticleList: Array<Record<string, unknown>> | null = null;

/** Spells are editable at runtime; keep a synchronous id lookup for the tick loop. */
export async function refreshSpells(): Promise<void> {
  // The held lists (npcStreaming): read only here, and the same arrays come back until they change, so a second
  // with nothing changed costs no Redis read and no rebuild. With CACHE=memory the lists are rebuilt as always.
  const list = ((await readHeldList<SpellData>("spells")) || []) as SpellData[];
  const particles = ((await readHeldList<Record<string, unknown>>("particles")) || []) as Array<Record<string, unknown>>;
  if (streamSource.redis() && list === lastSpellList && particles === lastParticleList) return;
  lastSpellList = list;
  lastParticleList = particles;
  spellsById = new Map(list.filter((s) => s?.id != null).map((s) => [Number(s.id), s]));
  spellIcons = new Map(list.filter((s) => s?.name).map((s) => [s.name, getSpriteUrl((s as any).icon ?? null)]));
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
  // Rewards and grants from neighbouring nodes are checked against these, with no read of the asset cache.
  setKnownTemplates(templates);
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
  await refreshAbilities();
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
    patrolPaths,
  };
}

/** Maps another system (gathering) needs a nav grid for, besides those with creature spawns. */
const extraNavMaps = new Set<string>();

/** Builds (or keeps fresh, every server tick) the nav grids of these maps too. */
export async function wantNavGrids(maps: Iterable<string>): Promise<void> {
  for (const map of maps) extraNavMaps.add(normMap(map));
  await refreshNavGrids(spawnCache);
}

/** Rebuild navigation grids for every map that has creature spawns (no-op if unchanged). */
async function refreshNavGrids(spawns: Iterable<CreatureSpawn>): Promise<void> {
  const maps = new Set<string>();
  for (const s of spawns) maps.add(s.map);
  const creatureMaps = new Set(maps);
  for (const map of extraNavMaps) maps.add(map);
  if (maps.size === 0) return;
  const props = ((await readHeldList("mapProperties")) || []) as any[]; // held list: read only
  for (const map of maps) {
    const prop = props.find((m) => normMap(m?.name) === map);
    // A world (modules/worldmaps.ts) has a collision bitset, not run lengths: its grid searches inside a window
    const world = getWorldMap(map);
    if (world) {
      if (navGrids.useBits(map, world.collision, world.width, world.height, world.tileWidth, world.tileHeight)) log.debug(`Creature nav grid built for world ${map}`);
      continue;
    }
    const rle = await assetCache.getNested(map, "collision");
    const built = navGrids.update(map, Array.isArray(rle) ? rle : null,Number(prop?.tileWidth) || 32, Number(prop?.tileHeight) || 32);
    if (built) log.debug(`Creature nav grid built for ${map}`);
    // gathering-only maps are warned about once, by gathering (reloadAreas)
    else if (creatureMaps.has(map) && !navGrids.get(map)) log.warn(`No collision data for creature map "${map}"; creatures there will not move`);
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
  log.info(`Creatures reloaded: ${templates.size} template(s), ${localCreatureCount()} live`);
}

export interface CreatureDataChange {
  templateIds?: number[];
  spawnIds?: number[];
  patrolPathIds?: number[];
}

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
    if (creature.remote) continue;
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
  log.info(`Creature data updated: ${refreshed} creature(s) refreshed, ${localCreatureCount()} live`);
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
  // Mirrors of other nodes' creatures are not this node's: they are counted apart.
  let awake = 0;
  for (const id of awakeIds()) if (!registry.get(id)?.remote) awake++;
  const local = localCreatureCount();
  return {
    creatures: local,
    mirrors: mirrorCount,
    // Dormant creatures are skipped entirely: nobody can see them and they are not fighting.
    awake,
    dormant: Math.max(0, local - awake),
    observed: observedIds.filter((id) => !registry.get(id)?.remote).length,
    inCombat: activeIds.length,
    maps: mirrorCount === 0 ? [...registry.mapsWithCreatures()].length : localMaps().length,
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

/** One creature tick. Exported for the tests, which run it without the global FIXED_UPDATE event. */
export function tickCreatures(now: number): void {
  // Creatures that someone can see, plus anything mid-fight/evade/flee (which
  // must finish even if every observer walked away).
  const ids = awakeIds();

  const ticked: CreatureInstance[] = [];
  for (const id of ids) {
    const creature = registry.get(id);
    if (!creature || creature.remote) continue;
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
  // Cluster mode (cells phase 6): a creature that walked into another node's block is handed to that node, at most
  // HANDOFFS_PER_TICK a tick. `ticked` holds this node's own creatures only at this point. handoffCtx is null
  // outside cluster mode, so this never runs there.
  if (handoffCtx) watchHandoffs(ticked, handoffCtx);
  if (handoffCtx && foreignSweepDue(now)) sweepForeign(now, handoffCtx);
  if (movedMirrors.size > 0) {
    for (const mirror of movedMirrors) ticked.push(mirror);
    movedMirrors.clear();
  }
  combat.tickPlayerAttacks(now);
  sync.flushMoves(ticked);
  flushHealth();
}

/** How often the foreign creatures are offered to the handoff watch. */
export const FOREIGN_SWEEP_MS = 1_000;
let nextForeignSweepAt = 0;

/** Due once a second; a clock stepped back by more than a period starts a sweep at once, not after the step. */
function foreignSweepDue(now: number): boolean {
  return now >= nextForeignSweepAt || now < nextForeignSweepAt - FOREIGN_SWEEP_MS;
}

/**
 * Cluster mode: a block that moved out leaves its creatures here, foreign (spawner.exportSlots), for the handoff watch
 * to move. The watch sees only the creatures ticked, and one nobody observes and nobody fights is never ticked, so it
 * would stay live here for good. Once a second the foreign creatures go through the same watch (its cap, its
 * cooldown, its isUp check). One that was ticked this tick may be offered twice: handOff sets creature.handoff before
 * its first await, and the watch skips such a creature, so the second offer starts nothing. The spawner's foreign set
 * is the pending set: exportSlots fills it, dropForeign and despawn empty it, and a creature whose target is down
 * stays in it for the next pass.
 */
function sweepForeign(now: number, ctx: LinkContext): void {
  nextForeignSweepAt = now + FOREIGN_SWEEP_MS;
  if (spawner.foreignCount() === 0) return;
  function* foreign(): IterableIterator<CreatureInstance> {
    for (const id of spawner.foreignIds()) {
      const creature = registry.get(id);
      if (creature && !creature.remote) yield creature;
    }
  }
  watchHandoffs(foreign(), ctx);
}

/** Corpses nobody can see still need to despawn so their spawn point respawns. */
function sweepUnobservedCorpses(now: number): void {
  for (const creature of registry.all()) {
    if (creature.remote) continue;
    if (creature.state === AIState.DEAD && now >= creature.combat.corpseUntil && !sync.isObserved(creature.id)) {
      spawner.despawn(creature.id, now);
    }
  }
}

// ------------------------------------------------------------ player API

/** Validate and start auto-attacking a creature. Returns an error reason or null. */
export function startAutoAttack(player: any, creatureId: number): string | null {
  if (!player?.id) return "invalid_player";
  // A mirror may be auto-attacked: each swing is rolled here and sent to its owner.
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
  // A mirror is targetable: what is done to it is sent to its owner (spec §4).
  if (!player?.location || creature.state === AIState.DEAD) return false;
  // GM stealth is meant to be non-interactive: an invisible admin cannot be
  // seen or hit, so they cannot attack, cast on or tab-target creatures either.
  if (player.isStealth) return false;
  if (normMap(player.location.map) !== creature.map) return false;
  return creature.layerId === null || creature.layerId === layerManager.getPlayerLayer(player.id);
}

/** Tile line of sight between a player and a creature (true when the map has no grid). */
export function openCorpseFor(player: any, creatureId: number) {
  return openCorpse(player, localCreature(creatureId));
}

export function takeCorpseLootFor(player: any, creatureId: number, indices: number[] | null, room?: BagRoom) {
  return takeCorpseLoot(player, localCreature(creatureId), indices, room);
}

/** A creature this node owns; a mirror's corpse is its owner's to loot (phase 5). */
function localCreature(id: number): CreatureInstance | undefined {
  const creature = registry.get(id);
  return creature?.remote ? undefined : creature;
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
    const level = Number(caster.stats.level) || 1;
    const resisted = combat.feignDeath(caster.id, level, Date.now());
    if (resisted > 0 && caster.wt) send(caster.wt, packetManager.notify({ message: "Feign Death was resisted." }));
    // Creatures across a border drop the caster on their own nodes; one notice is enough.
    void forwardThreat(caster, { kind: "feign", playerId: caster.id, level }).then((results) => {
      if (resisted === 0 && caster.wt && results.some((r) => Number(r?.reason) > 0)) send(caster.wt, packetManager.notify({ message: "Feign Death was resisted." }));
    });
  });
  registerSpellEffect("threat", ({ caster, target, effect }) => {
    if (!caster?.id || !caster.stats || target?.id !== caster.id) return;
    combat.modifyThreatEverywhere(caster.id, Number(effect.value) || 0);
    void forwardThreat(caster, { kind: "modify", playerId: caster.id, percent: Number(effect.value) || 0 });
  });
}

/** How far from a player a creature fighting them may be: its threat changes go to the owners of mirrors in it. */
const THREAT_FORWARD_RADIUS_PX = (AOI_CONFIG as any).DEFAULT_RADIUS || 1000;

/**
 * Sends a player's threat change to every node that owns a mirrored creature in combat near the player.
 * Each owner applies it to its own creatures; this node already applied it to its own.
 */
function forwardThreat(player: any, op: ThreatOp): Promise<Array<EffectResult | null>> {
  const pos = player?.location?.position;
  if (player?.remote || !pos || ghosts.mirrorCount() === 0) return Promise.resolve([]);
  const owners = new Set<string>();
  for (const c of registry.queryRadius(normMap(player.location.map), pos.x, pos.y, THREAT_FORWARD_RADIUS_PX)) {
    if (!c.remote || c.state !== AIState.COMBAT) continue;
    const owner = ghosts.ownerOf("creature", c.id);
    if (owner) owners.add(owner);
  }
  const target = op.kind === "heal" ? op.targetId : op.playerId;
  return Promise.all([...owners].map((owner) => sendEffect(owner, { op: "creature_threat", target, body: op })));
}

// Actions across a border (spec §4), run here for the node that holds the mirror. They are reached only
// through the links, so never with the cluster off.

/** The range of a threat spell's value (spelleditor.ts, the "threat" effect): -100 clears the caster's threat, 1000 is the most it adds. */
const THREAT_PERCENT_MIN = -100;
const THREAT_PERCENT_MAX = 1000;

/** The most a threat multiplier is held to: spells and swings all use 1 (damageCreature's default), so 10 leaves room for tuning. */
const MAX_THREAT_MULTIPLIER = 10;
/** The ceiling of a player's stat or a heal (playereditor.ts VALUE_MAX): what a peer says of a caster's damage stat or a heal is held to it. */
const STAT_CEILING = 1_000_000;

/** `value` as a number from 0 to `most`: not a number is 0, and a negative one is 0 too. */
function clampedTo(value: unknown, most: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, Number.isFinite(most) && most >= 0 ? most : 0);
}

/**
 * The spell a mirrored creature of a neighbouring node casts at a player here: this node's copy of it, when it is one
 * of the abilities of the creature's template. A spell that is not is not a spell that creature has.
 */
function creatureSpell(creatureId: number, sent: SpellData | undefined): SpellData | undefined {
  const creature = registry.get(creatureId);
  const spellId = Number(sent?.id);
  if (!creature || !Number.isFinite(spellId)) return undefined;
  return (abilitiesByTemplate.get(creature.templateId) ?? NO_ABILITIES).some((a) => a.spell_id === spellId) ? spellsById.get(spellId) : undefined;
}

// A player of the asking node hit a creature this node owns.
onApplyEffect("creature_hit", (target, hit: ForwardedHit, from): EffectResult => {
  const creature = registry.get(Number(target));
  if (!creature || creature.remote) return { outcome: "missing" };
  if (creature.state === AIState.DEAD) return { outcome: "refused", reason: "dead" };
  // The attacker is a player of the asking node, mirrored here, on the creature's layer.
  if (mirrorOwner(hit?.attackerId) !== from) return { outcome: "refused", reason: "attacker" };
  if (creature.layerId !== null && creature.layerId !== (playerLayer(hit.attackerId) ?? null)) return { outcome: "refused", reason: "layer" };
  // What the peer sent is not used as it is: the spell is this node's own, and the numbers are held to what play can reach.
  const spell = hit.spell == null ? undefined : spellsById.get(Number(hit.spell.id));
  if (hit.spell != null && !spell) return { outcome: "refused", reason: "spell" };
  // The text of a hit is one of the known kinds, or none.
  if (hit.textKind != null && !COMBAT_TEXT_KINDS.has(hit.textKind)) return { outcome: "refused", reason: "text" };
  const clean: ForwardedHit = {
    attackerId: hit.attackerId,
    amount: clampedTo(hit.amount, creature.maxHealth),
    threatMultiplier: clampedTo(hit.threatMultiplier, MAX_THREAT_MULTIPLIER),
    textKind: hit.textKind,
  };
  if (hit.avoided) clean.avoided = true;
  if (spell) {
    clean.spell = spell;
    clean.casterStat = clampedTo(hit.casterStat, STAT_CEILING);
  }
  const { landed, killed } = combat.applyForwardedHit(creature, clean, Date.now());
  return { outcome: killed ? "killed" : landed ? "applied" : "refused" };
});

// A creature of the asking node attacked a player this node owns. Immunity is decided here, at the target.
onApplyEffect("creature_on_player", async (target, body: CreatureOnPlayer, from): Promise<EffectResult> => {
  const player = playerCache.get(String(target));
  const bridge = getCreatureEngineBridge();
  if (!player || !bridge) return { outcome: "missing" };
  // Every kind, a daze too, names a creature the asker owns.
  if (ghosts.ownerOf("creature", body?.creatureId) !== from) return { outcome: "refused", reason: "creature" };
  // The player must still be where the creature is: same map, and the creature's layer or a shared one.
  const sameMap = body.map !== undefined && bareMap(body.map) === bareMap(player.location?.map);
  const layer = body.layerId ?? null;
  if (!sameMap || (layer !== null && layer !== layerManager.getPlayerLayer(player.id))) return { outcome: "missing", reason: "layer" };
  // A creature's spell is one of its template's abilities, and is this node's own copy of that spell.
  let spell: SpellData | undefined;
  if (body.kind === "spell") {
    spell = creatureSpell(Number(body.creatureId), body.spell);
    if (!spell) return { outcome: "refused", reason: "spell" };
  }
  if (player.isDead || player.isGhost || player.isStealth) return { outcome: "refused", reason: "immune" };
  // The creature's node holds no threat entry for it here, so the player is put in combat as a local creature would.
  if (body.kind !== "daze") {
    setPlayerPvp(player, true);
    player.last_attack = performance.now();
  }
  if (body.kind === "damage") {
    // Not below 0: a negative amount would heal the player.
    await bridge.damagePlayer(player, Math.max(0, Number(body.amount) || 0), { isCrit: !!body.isCrit, creatureId: body.creatureId, creatureName: body.creatureName });
  } else if (body.kind === "daze") {
    await bridge.dazePlayer(player);
  } else if (spell) {
    await bridge.applySpellEffects(player, { id: `creature:${body.creatureId}`, username: body.creatureName, isCreature: true }, spell);
  }
  return { outcome: player.isDead || Number(player.stats?.health ?? 1) <= 0 ? "killed" : "applied" };
});

// A player of the asking node changed their threat (feign death, a threat spell, a heal).
onApplyEffect("creature_threat", (_target, op: ThreatOp, from): EffectResult => {
  const playerId = op?.kind === "heal" ? op.casterId : op?.playerId;
  if (!playerId || mirrorOwner(playerId) !== from) return { outcome: "refused", reason: "player" };
  const now = Date.now();
  if (op.kind === "feign") return { outcome: "applied", reason: String(combat.feignDeath(op.playerId, Number(op.level) || 1, now)) };
  if (op.kind === "modify") combat.modifyThreatEverywhere(op.playerId, Math.max(THREAT_PERCENT_MIN, Math.min(THREAT_PERCENT_MAX, Number(op.percent) || 0)));
  else combat.onPlayerHealed(op.casterId, op.targetId, clampedTo(op.amount, STAT_CEILING), now);
  return { outcome: "applied" };
});


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
  if (creature?.remote) return fail(["That creature is on another node."]);

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
  log.success(`Creature system started: ${templates.size} template(s), ${localCreatureCount()} creature(s) spawned`);

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
      // A mirror inside the zone takes the tick on its owner, which shows the text.
      if (zone.damagePerTick > 0) combat.damageCreature(creature, sourceId, zone.damagePerTick, now, 1, "spell");
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
    // Mirrors too: their tap state is shown from this node's own parties, and this only sends.
    for (const creature of registry.all()) {
      if (creature.combat.tapper && creature.state !== AIState.DEAD) sendTapStates(creature);
    }
  });
  listener.on(Events.PLAYER_HEALED, (payload: any) => {
    const casterId = payload?.caster?.id;
    const targetId = payload?.target?.id;
    if (!casterId || !targetId) return;
    const amount = Number(payload.amount) || 0;
    combat.onPlayerHealed(casterId, targetId, amount, Date.now());
    // Creatures across a border that fight the healed player take their share on their own nodes (split per node).
    if (amount > 0) void forwardThreat(payload.target, { kind: "heal", casterId: String(casterId), targetId: String(targetId), amount });
  });
}

export { registry };

export default {
  init,
  reload,
  applyDataChange,
  registry,
  spawner,
  sync,
  combat,
  navGrids,
  wantNavGrids,
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

// Cluster mode: creatures this node owns are mirrored to neighbouring nodes near a border, and their creatures are
// mirrored here. A mirror sits in the shared registry with `remote: true` so the grid and CreatureSync show it to the
// players here with no special case; every writer above skips it.

/** Stands in for a mirror's path: CreatureSync only asks whether a creature is moving. */
const MIRROR_MOVING: CreatureMoveState = { path: [], index: 0, speed: 0, stuckTicks: 0 };
/** Mirrors moved since the last tick; tickCreatures flushes them with the local moves. */
const movedMirrors = new Set<CreatureInstance>();
/** Mirrors in the registry: the stats and log lines count this node's own creatures only. */
let mirrorCount = 0;

function localCreatureCount(): number {
  return registry.size - mirrorCount;
}

function localMaps(): string[] {
  const maps: string[] = [];
  for (const map of registry.mapsWithCreatures()) {
    for (const c of registry.onMap(map)) {
      if (c.remote) continue;
      maps.push(map);
      break;
    }
  }
  return maps;
}

function creatureShown(c: CreatureInstance) {
  return {
    health: c.health,
    maxHealth: c.maxHealth,
    state: c.state,
    victimId: c.combat.threat.victimId ?? null,
    tapper: c.combat.tapper,
    casting: c.casting,
    // Absolute expiries: the field changes when the auras do, not on every scan.
    auras: aurasState(c.auras, Date.now()),
  };
}

/**
 * Copies the shown fields onto a mirror. A GHOST_STATE change set only names what changed (null clears a field);
 * a GHOST_SPAWN sent again is the whole record, so a field it leaves out goes back to its default.
 */
function applyMirror(c: CreatureInstance, r: any, whole: boolean): void {
  if (whole || "health" in r) c.health = Number(r.health) || 0;
  if (whole || "maxHealth" in r) c.maxHealth = Number(r.maxHealth) || 0;
  if (whole || "state" in r) c.state = r.state ?? AIState.IDLE;
  if (whole || "casting" in r) c.casting = r.casting ?? null;
  if (whole || "tapper" in r) c.combat.tapper = r.tapper ?? null;
  if (whole || "auras" in r) c.mirrorAuras = Array.isArray(r.auras) ? r.auras : [];
  if (whole || "victimId" in r) c.combat.threat.victimId = r.victimId ?? null;
}

/** Sends a mirror's shown state to its viewers here, after a full resend replaced it. */
function resendMirror(c: CreatureInstance): void {
  const auras = auraStatePayload((c.mirrorAuras ?? []) as AuraState[], Date.now(), spellIcon);
  const packets = [
    ...packetManager.creatureHealth({ id: c.id, health: c.health, maxHealth: c.maxHealth }),
    ...packetManager.creatureState({ id: c.id, state: c.state, victimId: c.combat.threat.victimId ?? null }),
    ...packetManager.creatureAuras({ id: c.id, auras }),
  ];
  sync.sendToViewers(c.id, (wt) => send(wt, packets));
  sendTapStates(c);
}

/** Whether a spawn record from the wire has a creature's shape: its numbers are finite, and its map and layer are what a lookup takes. */
function mirrorRecordOk(r: any): boolean {
  const finite = (...values: unknown[]) => values.every((value) => typeof value === "number" && Number.isFinite(value));
  return finite(r.id, r.templateId, r.x, r.y) && typeof r.map === "string" && (r.layerId == null || typeof r.layerId === "string");
}

function newMirror(r: any): CreatureInstance {
  const dir = typeof r.dir === "string" ? r.dir : "down";
  const instance: CreatureInstance = {
    id: Number(r.id),
    templateId: Number(r.templateId),
    spawnId: Number(r.spawnId) || 0,
    poolId: null,
    map: r.map,
    layerId: r.layerId ?? null,
    x: r.x,
    y: r.y,
    dir,
    homeX: r.x,
    homeY: r.y,
    level: Number(r.level) || 1,
    health: 0,
    maxHealth: 0,
    state: AIState.IDLE,
    spawnedAt: Date.now(),
    move: r.moving ? MIRROR_MOVING : null,
    waitUntil: Infinity,
    patrolIndex: 0,
    patrolForward: true,
    sentX: r.x,
    sentY: r.y,
    sentDir: dir,
    sentMoving: !!r.moving,
    combat: createCombatState(),
    auras: createAuras(),
    casting: null,
    abilityStates: new Map(),
    remote: true,
    mirrorAuras: [],
  };
  applyMirror(instance, r, true);
  return instance;
}

function removeMirror(c: CreatureInstance): void {
  movedMirrors.delete(c);
  if (registry.remove(c.id)) mirrorCount--;
  sync.onDespawn(c);
}

// ------------------------------------------------------------ handoff (cells phase 6)

const finiteOr = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const AI_STATES: ReadonlySet<string> = new Set(Object.values(AIState));

/**
 * A live creature as it travels to another node (cluster/creaturehandoff.ts): every field, the threat table as JSON
 * and the ability timers as entries. Its path and cast stay here (a casting creature is never handed off, and a path
 * is planned again there). `remote`, `handoff` and `mirrorAuras` are this node's own bookkeeping.
 */
export function serializeCreature(c: CreatureInstance): SerializedCreature {
  return {
    id: c.id, templateId: c.templateId, spawnId: c.spawnId, poolId: c.poolId,
    map: c.map, layerId: c.layerId, x: c.x, y: c.y, dir: c.dir, homeX: c.homeX, homeY: c.homeY,
    level: c.level, health: c.health, maxHealth: c.maxHealth, state: c.state, spawnedAt: c.spawnedAt,
    // Infinity is not JSON.
    waitUntil: Number.isFinite(c.waitUntil) ? c.waitUntil : null,
    patrolIndex: c.patrolIndex, patrolForward: c.patrolForward,
    sentX: c.sentX, sentY: c.sentY, sentDir: c.sentDir, sentMoving: c.sentMoving,
    combat: { ...c.combat, threat: c.combat.threat.toJSON(), tapper: c.combat.tapper ? { ...c.combat.tapper } : null },
    pendingRefresh: !!c.pendingRefresh,
    auras: { ...c.auras, dots: c.auras.dots.map((dot) => ({ ...dot })), slows: c.auras.slows.map((slow) => ({ ...slow })) },
    abilityStates: [...c.abilityStates.entries()].map(([id, state]) => [id, { ...state }]),
  };
}

/** The combat state of an arriving creature: a number, flag or id the record does not carry (or carries badly) keeps its fresh default. */
function arrivedCombat(r: any): CreatureInstance["combat"] {
  const base = createCombatState();
  const into: Record<string, unknown> = base as any;
  for (const [key, fallback] of Object.entries(base)) {
    if (key === "threat" || key === "tapper") continue;
    const value = r[key];
    if (typeof fallback === "number") into[key] = finiteOr(value, fallback);
    else if (typeof fallback === "boolean") into[key] = typeof value === "boolean" ? value : fallback;
    else if (fallback === null && typeof value === "string") into[key] = value;
  }
  const tapper = r.tapper;
  base.tapper = tapper && typeof tapper.playerId === "string" && typeof tapper.username === "string" ? { playerId: tapper.playerId, username: tapper.username } : null;
  base.threat = ThreatTable.fromJSON(r.threat);
  return base;
}

/** The auras of an arriving creature: only whole DoTs and slows are kept, so a bad entry cannot stall the tick. */
function arrivedAuras(r: any): CreatureAuras {
  const base = createAuras();
  const into: Record<string, unknown> = base as any;
  for (const [key, fallback] of Object.entries(base)) {
    if (typeof fallback === "number") into[key] = finiteOr(r[key], fallback);
    else if (typeof fallback === "string") into[key] = typeof r[key] === "string" ? r[key] : fallback;
  }
  const isNumbers = (e: any, ...keys: string[]) => !!e && typeof e === "object" && keys.every((key) => typeof e[key] === "number" && Number.isFinite(e[key]));
  base.dots = (Array.isArray(r.dots) ? r.dots : [])
    .filter((e: any) => isNumbers(e, "amountPerTick", "intervalMs", "expiresAt", "nextTickAt", "stacks", "maxStacks") && e.intervalMs > 0 && typeof e.id === "string" && typeof e.casterId === "string")
    .map((e: any) => ({ ...e }));
  base.slows = (Array.isArray(r.slows) ? r.slows : [])
    .filter((e: any) => isNumbers(e, "pct", "expiresAt") && typeof e.id === "string")
    .map((e: any) => ({ ...e }));
  return base;
}

/**
 * A creature handed over to this node becomes live here (cluster/creaturehandoff.ts). `home` is the node that owns
 * its spawn slot; null when this node does. The mirror this node showed of it gives up its place with no despawn,
 * so its viewers keep the entry; the creature is announced when there was no mirror, or when the mirror differs in
 * map, layer or template (the client treats that as a new creature). False, with nothing changed, when a live copy
 * is already here, the record is not a living creature of a known template, or the spawner refuses it. The caller
 * (onCommit) logs the loss by name and the home respawns the slot.
 */
function arriveCreature(s: SerializedCreature, home: string | null): boolean {
  const r: any = s;
  if (!mirrorRecordOk(r) || !r.combat || typeof r.combat !== "object" || !r.auras || typeof r.auras !== "object") return false;
  const existing = registry.get(Number(r.id));
  if (existing && !existing.remote) {
    log.warn(`Creature ${r.id} was handed over here, but it is already live here: the arrival is dropped`);
    return false;
  }
  const refuse = (why: string): false => {
    log.warn(`Creature ${r.id} handed over here was refused: ${why}`);
    return false;
  };
  // A creature that cannot be fought, killed or shown is not made live: its loss is logged, and its home respawns it.
  if (r.state === AIState.DEAD) return refuse("it is dead");
  if (!templates.has(r.templateId)) return refuse(`template ${r.templateId} is not known here`);
  const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (!positive(r.health) || !positive(r.maxHealth)) return refuse("its health is not a positive number");
  if (!Number.isInteger(r.level) || r.level < 1) return refuse("its level is not a positive integer");
  if (!Number.isInteger(r.spawnId ?? 0) || (r.poolId != null && !Number.isInteger(r.poolId))) return refuse("its spawn or pool id is not an integer");
  if (home === null) {
    // Coming home: it must be the creature the away slot here holds, so a later despawn frees that very slot.
    const slot = spawner.awaySlots().find((a) => a.instanceId === r.id);
    if (slot && (slot.spawnId !== (r.spawnId ?? 0) || slot.layerId !== (r.layerId ?? null) || slot.poolId !== (r.poolId ?? null) || slot.templateId !== r.templateId)) {
      return refuse("its spawn, layer, pool or template is not that of the away slot held for it");
    }
  }
  const instance: CreatureInstance = {
    id: Number(r.id),
    templateId: Number(r.templateId),
    spawnId: r.spawnId ?? 0,
    poolId: r.poolId ?? null,
    map: r.map,
    layerId: r.layerId ?? null,
    x: r.x,
    y: r.y,
    dir: typeof r.dir === "string" ? r.dir : "down",
    homeX: finiteOr(r.homeX, r.x),
    homeY: finiteOr(r.homeY, r.y),
    level: r.level,
    health: Math.min(r.health, r.maxHealth),
    maxHealth: r.maxHealth,
    state: AI_STATES.has(r.state) ? r.state : AIState.IDLE,
    spawnedAt: finiteOr(r.spawnedAt, Date.now()),
    // A path is planned again at the next AI tick, and a cast never travels.
    move: null,
    // Infinity travels as null: the AI acts at once.
    waitUntil: finiteOr(r.waitUntil, 0),
    patrolIndex: finiteOr(r.patrolIndex, 0),
    patrolForward: r.patrolForward !== false,
    sentX: finiteOr(r.sentX, r.x),
    sentY: finiteOr(r.sentY, r.y),
    sentDir: typeof r.sentDir === "string" ? r.sentDir : "down",
    sentMoving: !!r.sentMoving,
    combat: arrivedCombat(r.combat),
    pendingRefresh: !!r.pendingRefresh,
    auras: arrivedAuras(r.auras),
    casting: null,
    abilityStates: new Map(
      (Array.isArray(r.abilityStates) ? r.abilityStates : [])
        .filter((e: any) => Array.isArray(e) && Number.isFinite(e[0]) && e[1] && Number.isFinite(e[1].nextReadyAt))
        .map((e: any) => [Number(e[0]), { ...e[1], fired: e[1].fired === true }]),
    ),
  };
  // The spawner takes the mirror out of the registry itself and puts the creature in its place; it refuses before
  // changing anything, so the mirror is left alone then. Only after it said yes is the mirror's bookkeeping settled.
  if (!spawner.adopt(instance, home, { announce: !existing })) return false;
  if (existing) {
    movedMirrors.delete(existing);
    mirrorCount--;
    // The client keys a creature's sprite and layer on its template and map: a mirror that differed is a new creature to it.
    if (existing.map !== instance.map || existing.layerId !== instance.layerId || existing.templateId !== instance.templateId) {
      sync.onDespawn(existing);
      sync.onSpawn(instance);
    }
  }
  combat.adopt(instance);
  // The creature is this node's own now: no ghost record of a mirror, and no forwarding of its calls.
  ghosts.dropMirror("creature", instance.id);
  forwardTable.forgetCreature(instance.id);
  return true;
}

/**
 * The creature was handed to `to` (cluster/creaturehandoff.ts): this node keeps it as a mirror of the copy there, in
 * place, so its viewers here see no change. Its slot and its mirrors elsewhere were already handed over.
 */
function creatureToMirror(c: CreatureInstance, to: string): void {
  if (c.remote) return;
  // Together and first: the copy is a mirror from here on, and counted as one, whatever fails below.
  c.remote = true;
  mirrorCount++;
  c.handoff = false;
  combat.release(c);
  healthDirty.delete(c.id);
  c.mirrorAuras = aurasState(c.auras, Date.now());
  c.move = c.move ? MIRROR_MOVING : null;
  c.casting = null;
  log.debug(`Creature ${c.id} is now held by ${to}; this node shows it as a mirror`);
}

/** Handoffs wait while the shared store is unreachable (spec §7). A context that carries no store counts as up. */
export function handoffPaused(ctx: LinkContext): boolean {
  return ctx.store?.isUp?.() === false;
}

/**
 * Cluster mode: hands the creatures that walked into another node's block to that node, at most HANDOFFS_PER_TICK a
 * call, and none while the store is down (the pause is read once). A tick calls it for the creatures it ticked, and
 * once a second more for the foreign ones (sweepForeign), so a sweep tick can start up to twice that. `ticked` holds
 * this node's own creatures. The
 * checks here only spare a call: handOff makes them again.
 */
export function watchHandoffs(
  ticked: Iterable<CreatureInstance>,
  ctx: LinkContext,
  start: (c: CreatureInstance, target: string) => Promise<unknown> = (c, target) => creatureHandoff.handOff(c, target),
): void {
  if (handoffPaused(ctx)) return;
  let started = 0;
  for (const creature of ticked) {
    if (started >= HANDOFFS_PER_TICK) break;
    if (creature.remote || creature.handoff || creature.casting || creature.state === AIState.DEAD) continue;
    if (creatureHandoff.coolingDown(creature.id)) continue;
    const target = handoffTarget(creature.map, creature.x, creature.y, ctx.ownerAt, ctx.self);
    if (!target || !ctx.calls.isUp(target)) continue;
    started++;
    void start(creature, target).catch((error) => {
      log.error(`The handoff of creature ${creature.id} to ${target} failed: ${error}`);
    });
  }
}

/** What the creature handoff (cluster/creaturehandoff.ts) needs of this node's creatures. */
export function creatureHandoffDeps(ctx: LinkContext): CreatureHandoffDeps {
  return {
    calls: ctx.calls,
    ghosts,
    self: ctx.self,
    ownerAt: ctx.ownerAt,
    now: () => Date.now(),
    creature: (id) => {
      const c = registry.get(Number(id));
      return c && !c.remote ? c : null;
    },
    serialize: serializeCreature,
    arrive: arriveCreature,
    toMirror: creatureToMirror,
    // Taken before toMirror: a mirror has no snapshot.
    ghostRecord: (c) => creatureGhostKind.snapshot(c.id),
    templateKnown: (templateId) => templates.has(templateId),
    templateName: (templateId) => templates.get(templateId)?.name ?? `creature template ${templateId}`,
    ownsSlot: (c) => c.spawnId > 0 && spawner.getLiveInstanceId(c.spawnId, c.layerId) === c.id,
    spawner,
    despawnForeign: (id) => {
      // Dropped first, so the despawn does not send a CREATURE_DIED for a slot the home no longer has.
      spawner.dropForeign(id);
      spawner.despawn(id, Date.now(), { respawn: false });
    },
    forward: (id, to) => forwardTable.addCreature(id, to),
  };
}

export const creatureGhostKind: GhostKind = {
  name: "creature",
  // Map by map: a map whose every block is this node's is skipped, and with a band so are the cells outside it.
  *candidates(band) {
    for (const map of registry.mapsWithCreatures()) {
      if (band && !band.hasBorder(map)) continue;
      // The cells that pass are kept between scans, until the map's band is rebuilt (its token changes).
      const creatures = band
        ? registry.onBandCells(map, band.token(map), (left, top, size) => band.nearRect(map, left, top, left + size, top + size))
        : registry.onMap(map);
      for (const c of creatures) {
        if (!c.remote) yield { id: c.id, num: c.id, map: c.map, layerId: c.layerId, x: c.x, y: c.y };
      }
    }
  },
  snapshot: (id) => {
    const c = registry.get(Number(id));
    if (!c || c.remote) return null;
    return {
      id: c.id, templateId: c.templateId, spawnId: c.spawnId, map: c.map, layerId: c.layerId, x: c.x, y: c.y,
      dir: c.dir, moving: !!c.move, level: c.level, ...creatureShown(c),
    };
  },
  state: (id) => {
    const c = registry.get(Number(id));
    return c && !c.remote ? creatureShown(c) : null;
  },
  // Creature movement reports through registry.onMoved (set below), so the tick reads only the creatures that moved.
  dirtyMarks: true,
  motion: (id) => {
    const c = registry.get(Number(id));
    return c && !c.remote ? { x: c.x, y: c.y, dir: directionCode(c.dir), flags: c.move ? FLAG_MOVING : 0 } : null;
  },
  spawn: (r) => {
    // Refused with nothing stored, so a bad record cannot put a creature in a bad cell of the grid.
    if (!mirrorRecordOk(r)) return false;
    const existing = registry.get(Number(r.id));
    // Never replace a creature this node owns; Ghosts then records nothing for the id.
    if (existing && !existing.remote) return false;
    if (existing) {
      // The client keys a creature's sprite and layer on its template; a change there is a new creature to it.
      if (existing.map !== r.map || existing.layerId !== (r.layerId ?? null) || existing.templateId !== Number(r.templateId)) {
        removeMirror(existing);
      } else {
        registry.move(existing, r.x, r.y);
        existing.dir = typeof r.dir === "string" ? r.dir : "down";
        existing.move = r.moving ? MIRROR_MOVING : null;
        existing.level = Number(r.level) || 1;
        existing.spawnId = Number(r.spawnId) || 0;
        applyMirror(existing, r, true);
        movedMirrors.add(existing);
        resendMirror(existing);
        return true;
      }
    }
    const instance = newMirror(r);
    registry.add(instance);
    mirrorCount++;
    sync.onSpawn(instance);
    return true;
  },
  move: (id, x, y, dir, flags) => {
    const c = registry.get(Number(id));
    if (!c?.remote || !Number.isFinite(x) || !Number.isFinite(y)) return;
    registry.move(c, x, y);
    c.dir = directionName(dir);
    c.move = flags & FLAG_MOVING ? MIRROR_MOVING : null;
    movedMirrors.add(c);
  },
  update: (id, changes) => {
    const c = registry.get(Number(id));
    if (!c?.remote) return;
    const tapper = c.combat.tapper;
    applyMirror(c, changes, false);
    // Tap packets are per viewer and not relayed, so each node tells its own viewers.
    if (c.combat.tapper?.playerId !== tapper?.playerId) sendTapStates(c);
  },
  relay: (id, packets, bestEffort) => {
    sync.sendToViewers(Number(id), (wt) => (bestEffort ? sendBestEffort : send)(wt, packets));
  },
  despawn: (id) => {
    const c = registry.get(Number(id));
    if (c?.remote) removeMirror(c);
  },
};

ghosts.register(creatureGhostKind);
// Ghosts.touch does nothing while the ghosts are not attached (cluster off), so this costs a branch per move.
registry.onMoved = (c) => { if (!c.remote) ghosts.touch("creature", c.id); };

// A node that died (cells phase 7, Task 13): the away slots it held respawn here, and creatures here whose home it
// was are dropped (their home's blocks went to other nodes, which spawn their own). The slots this node sent it in a
// block move are forgotten with them (Task 15).
usePeerDeathHandlers({
  releaseAwayHeldBy: (peer) => spawner.releaseAwayHeldBy(peer, Date.now()),
  dropForeignFrom: (home) => {
    spawner.forgetOutgoingTo(home);
    return spawner.dropForeignFrom(home);
  },
});

/** How often the creature handoff's sweeps run while the links are attached. */
export const CREATURE_SWEEP_MS = 5_000;

/** The links while they are attached (cluster mode); null otherwise, and then no creature is handed off. */
let handoffCtx: LinkContext | null = null;

/** The creature slots' part while it is registered; a later attach replaces it. */
let undoSlots: (() => void) | null = null;

/** Starts the creature handoff on the attached links; what it returns stops it. Exported for the tests. */
export function attachCreatureHandoff(ctx: LinkContext): () => void {
  creatureHandoff.start(creatureHandoffDeps(ctx));
  handoffCtx = ctx;
  // Phase 7: a block's spawn slots go with it when it moves to another node (Task 15). The spawner itself is the
  // part's spawner, so a move lost at the deadline can drop or despawn what it took out. A later attach owns the
  // part: the earlier one is taken off first, since a second part of one name is refused.
  undoSlots?.();
  const undo = registerCreatureSlots({
    self: ctx.self,
    now: Date.now,
    spawner,
    tellHome: (holder, id, home) => creatureHandoff.tellHome(holder, id, home),
    // The table clamps at the map's edge; it is there whenever a move runs.
    blockOf: (map, x, y) => clusterBlocks()?.blockOf(map, x, y) ?? blockAt(x, y),
  });
  undoSlots = undo;
  const sweep = setInterval(() => {
    void creatureHandoff.sweep().catch((error) => log.error(`The creature handoff sweep failed: ${error}`));
  }, CREATURE_SWEEP_MS);
  sweep.unref?.();
  return () => {
    clearInterval(sweep);
    undo();
    if (undoSlots === undo) undoSlots = null;
    if (handoffCtx === ctx) handoffCtx = null;
    creatureHandoff.stop();
  };
}

// The creature handoff runs only while startCluster has the links attached (cells phase 6).
onLinksAttached(attachCreatureHandoff);
