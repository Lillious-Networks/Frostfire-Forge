import { markUsed, readyAbilities, resetAbilityStates, type AbilityTrigger } from "./abilities";
import { canProximityAggro, MAX_AGGRO_RADIUS_YD } from "./aggro";
import {
  applyCastLockout,
  applyDot,
  applySlow,
  applyStun,
  clearAuras,
  collectDotTicks,
  DEFAULT_LOCKOUT_MS,
  hasAuras,
  isCastLockedOut,
  isStunned,
  slowMultiplier,
} from "./auras";
import { tickCreature } from "./ai";
import {
  CreatureFlags,
  CORPSE_EMPTY_MS,
  randInt,
  speedPxPerSec,
  TICK_MS,
  YARD_PX,
  yards,
  type Rng,
} from "./constants";
import {
  armorReduction,
  spellMissChance,
  isInFront,
  PLAYER_SWING_MS,
  playerMeleeDamageRange,
  playerVsCreatureTable,
  rollPlayerVsCreature,
  type MeleeOutcome,
  type WeaponProfile,
} from "./combat";
import { advance, directionFor, setDestination, stop } from "./movement";
import type { NavGrid } from "./navgrid";
import { CreatureRegistry } from "./registry";
import { PROXIMITY_THREAT } from "./threat";
import { projectileTravelMs } from "./projectile";
import { withPeriodicBonus } from "../spellmath";
import {
  AIState,
  type CreatureAbility,
  type CreatureCast,
  type CreatureInstance,
  type CreaturePatrolPath,
  type CreatureSpawn,
  type CreatureTemplate,
} from "./types";

export const DEFAULT_LEASH_YD = 60;
export const MELEE_RANGE_YD = 5;
export const RANGED_ATTACK_YD = 30;
/** A threat-table unit the creature cannot reach for this long is dropped. */
export const UNREACHABLE_DROP_MS = 5000;
/** Evading creatures that still haven't reached home after this long are snapped back. */
export const EVADE_TIMEOUT_MS = 10000;
const REPATH_MS = 300;
const COMBAT_PATH_MAX_NODES = 4000;
const AGGRO_SCAN_MS = 200;
const COMBAT_PULSE_MS = 500;
/** Out-of-combat regeneration, fraction of max health per second. */
const OOC_REGEN_PER_SEC = 0.04;
const FLEE_DISTANCE_YD = 12;
const LOW_HP_FLEE_SPEED_MULT = 0.66;
const PASSIVE_FLEE_MS = 4000;

export type CombatTextKind = MeleeOutcome | "evade" | "immune" | "spell" | "resist" | "heal" | "interrupted";
export type CastResult = "success" | "interrupted" | "failed";
export type CastTarget = CreatureCast["target"];
/** Spell crit chance and multiplier for creature casts. */
const CREATURE_SPELL_CRIT_PCT = 5;
const SPELL_CRIT_MULTIPLIER = 1.5;
/** A finishing cast still lands if the target drifted up to this much past range. */
const CAST_RANGE_TOLERANCE = 1.25;

export interface PlayerUnit {
  id: string;
  username: string;
  map: string;
  layerId: string | null;
  x: number;
  y: number;
  dir: string;
  level: number;
  alive: boolean;
  gmHidden: boolean;
  stealthed: boolean;
  casting: boolean;
  dodgePct: number;
  critPct: number;
  critDamagePct: number;
  statDamage: number;
  armorPct: number;
  /** Equipped weapon's swing profile; null means bare-handed. */
  weapon: WeaponProfile | null;
}

export interface CombatText {
  creatureId: number;
  /** Who took the hit: a player id, or `creature:<id>`. */
  targetId: string;
  sourceId: string;
  kind: CombatTextKind;
  amount: number;
}

export interface CombatWorld {
  rng: Rng;
  template(id: number): CreatureTemplate | undefined;
  spawn(id: number): CreatureSpawn | undefined;
  patrol(spawn: CreatureSpawn | undefined): CreaturePatrolPath | undefined;
  grid(map: string): NavGrid | undefined;
  getPlayer(id: string): PlayerUnit | null;
  playersNear(map: string, x: number, y: number, radiusPx: number): PlayerUnit[];
  /** Apply final damage to a player (barriers, death handling, stat broadcast). */
  damagePlayer(creature: CreatureInstance, playerId: string, amount: number, outcome: MeleeOutcome): void;
  dazePlayer(playerId: string): void;
  markPlayerInCombat(playerId: string): void;
  onHealthChanged(creature: CreatureInstance): void;
  onStateChanged(creature: CreatureInstance): void;
  onCombatText(text: CombatText): void;
  onDied(creature: CreatureInstance, killerId: string | null): void;
  onAutoAttackStopped(playerId: string, creatureId: number): void;
  /** Tapper set (first hostile action) or cleared (evade). */
  onTapChanged(creature: CreatureInstance): void;
  spell(id: number): SpellData | undefined;
  abilities(templateId: number): CreatureAbility[];
  /** Run engine spell effects (DoT, stun, slow...) from a creature on a player. */
  applySpellEffectsToPlayer(creature: CreatureInstance, playerId: string, spell: SpellData): void;
  onCastStart(creature: CreatureInstance): void;
  /** Run a callback after a delay (projectile flight). Without it, spells land instantly. */
  later?(ms: number, fn: () => void): void;
  /** A spell left the creature: clients draw the projectile/particles. */
  onSpellLaunch?(creature: CreatureInstance, spell: SpellData, target: CastTarget): void;
  onCastEnd(creature: CreatureInstance, spellName: string, result: CastResult): void;
  onAurasChanged(creature: CreatureInstance): void;
  /** Other live creatures in this creature's link group (same layer). */
  linkedCreatures(creature: CreatureInstance): CreatureInstance[];
}

export const creatureUnitId = (id: number) => `creature:${id}`;

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

export function meleeRangePx(template: CreatureTemplate): number {
  return yards(MELEE_RANGE_YD) * Math.max(1, template.scale);
}

export function leashRangePx(template: CreatureTemplate): number {
  return yards(template.leash_override ?? DEFAULT_LEASH_YD);
}

const sameLayer = (c: CreatureInstance, p: PlayerUnit) => c.layerId === null || c.layerId === p.layerId;

/** Engine-facing creature combat: threat, aggro, melee both ways, leash/evade, flee, death. */
export class CreatureCombatSystem {
  /** player id -> creatures whose threat table contains them */
  private unitIndex = new Map<string, Set<number>>();
  /** creatures currently in combat, evading or fleeing (ticked even when unobserved) */
  private active = new Set<number>();
  /** player id -> auto-attack state */
  private autoAttacks = new Map<string, { creatureId: number; nextSwingAt: number }>();

  constructor(private readonly registry: CreatureRegistry, private readonly world: CombatWorld) {}

  activeIds(): IterableIterator<number> {
    return this.active.keys();
  }

  isInCombatWith(playerId: string): boolean {
    return (this.unitIndex.get(playerId)?.size ?? 0) > 0;
  }

  creaturesEngagedWith(playerId: string): ReadonlySet<number> {
    return this.unitIndex.get(playerId) ?? new Set();
  }

  autoAttackTarget(playerId: string): number | null {
    return this.autoAttacks.get(playerId)?.creatureId ?? null;
  }

  emitCombatText(text: CombatText): void {
    this.world.onCombatText(text);
  }

  // ---------------------------------------------------------------- ticking

  tick(creature: CreatureInstance, now: number, dtMs: number = TICK_MS): void {
    const template = this.world.template(creature.templateId);
    if (!template) return;

    if (creature.state !== AIState.DEAD && creature.state !== AIState.EVADING) {
      this.tickAuras(creature, now);
      if ((creature.state as AIState) === AIState.DEAD) return;
    }

    switch (creature.state) {
      case AIState.DEAD:
        return;
      case AIState.COMBAT:
        this.tickCombat(creature, template, now, dtMs);
        return;
      case AIState.EVADING:
        this.tickEvade(creature, template, now, dtMs);
        return;
      case AIState.FLEEING:
        this.tickFlee(creature, template, now, dtMs);
        return;
      default:
        this.tickOutOfCombat(creature, template, now, dtMs);
    }
  }

  private tickOutOfCombat(creature: CreatureInstance, template: CreatureTemplate, now: number, dtMs: number): void {
    if (template.regen_ooc && creature.health < creature.maxHealth) {
      const regen = Math.max(1, Math.round(creature.maxHealth * OOC_REGEN_PER_SEC * (dtMs / 1000)));
      creature.health = Math.min(creature.maxHealth, creature.health + regen);
      this.world.onHealthChanged(creature);
    }

    if (template.stance === "aggressive" && now >= creature.combat.nextAggroScanAt) {
      // Stagger scans across creatures so they don't all land on the same tick.
      creature.combat.nextAggroScanAt = now + AGGRO_SCAN_MS + (creature.id % 2) * TICK_MS;
      const target = this.findProximityTarget(creature, template);
      if (target) {
        this.addThreat(creature, target.id, PROXIMITY_THREAT, now);
        this.enterCombat(creature, now);
        return;
      }
    }

    if (isStunned(creature.auras, now)) {
      stop(creature);
      return;
    }
    this.tryOutOfCombatAbilities(creature, template, now);

    const spawn = this.world.spawn(creature.spawnId);
    tickCreature(creature, {
      now,
      dtMs,
      grid: this.world.grid(creature.map),
      template,
      spawn,
      patrol: this.world.patrol(spawn),
      rng: this.world.rng,
      place: (c, x, y) => this.registry.move(c, x, y),
    });
  }

  /** Nearest player this aggressive creature would notice right now. */
  findProximityTarget(creature: CreatureInstance, template: CreatureTemplate): PlayerUnit | null {
    const grid = this.world.grid(creature.map);
    const candidates = this.world.playersNear(creature.map, creature.x, creature.y, yards(MAX_AGGRO_RADIUS_YD));
    let best: PlayerUnit | null = null;
    let bestDist = Infinity;
    const detects = (template.flags & CreatureFlags.DETECT_STEALTH) !== 0;
    for (const p of candidates) {
      if (!sameLayer(creature, p)) continue;
      const d = dist(creature.x, creature.y, p.x, p.y);
      if (d >= bestDist) continue;
      if (!canProximityAggro(creature.level, template.aggro_radius_override, detects, p, d / YARD_PX)) continue;
      if (grid && !grid.lineOfSight(creature, p)) continue;
      best = p;
      bestDist = d;
    }
    return best;
  }

  private tickCombat(creature: CreatureInstance, template: CreatureTemplate, now: number, dtMs: number): void {
    const combat = creature.combat;
    const threat = combat.threat;

    // Drop units that are gone, dead, hidden, or left the creature's map/layer.
    for (const unitId of [...threat.units()]) {
      const p = this.world.getPlayer(unitId);
      const entry = threat.get(unitId);
      const unreachable = entry?.unreachableSince != null && now - entry.unreachableSince >= UNREACHABLE_DROP_MS;
      // Stealth (player vanish) and GM invisibility break combat, like WoW's
      // vanish: the creature loses its target and evades if nothing else is on
      // the table.
      const hidden = !!p && (p.gmHidden || p.stealthed);
      if (!p || !p.alive || hidden || p.map !== creature.map || !sameLayer(creature, p) || unreachable) {
        this.removeThreat(creature, unitId);
      }
    }
    if (threat.isEmpty()) return this.evade(creature, now);

    if ((template.flags & CreatureFlags.NO_LEASH) === 0 && dist(creature.x, creature.y, combat.startX, combat.startY) > leashRangePx(template)) {
      return this.evade(creature, now);
    }

    if (now >= combat.nextCombatPulseAt) {
      combat.nextCombatPulseAt = now + COMBAT_PULSE_MS;
      for (const unitId of threat.units()) this.world.markPlayerInCombat(unitId);
    }

    if (isStunned(creature.auras, now)) {
      stop(creature);
      return;
    }

    if (creature.casting) {
      stop(creature);
      this.progressCast(creature, template, now);
      return;
    }

    if (this.shouldFleeLowHealth(creature, template)) {
      combat.fledThisCombat = true;
      return this.startFlee(creature, template, threat.victimId, now, template.flee_duration_ms, LOW_HP_FLEE_SPEED_MULT);
    }

    const melee = meleeRangePx(template);
    const previousVictim = threat.victimId;
    const victimId = threat.selectVictim(
      now,
      (id) => {
        const p = this.world.getPlayer(id);
        return !!p && dist(creature.x, creature.y, p.x, p.y) <= melee;
      },
    );
    if (victimId !== previousVictim) this.world.onStateChanged(creature);
    const victim = victimId ? this.world.getPlayer(victimId) : null;
    if (!victim) return;

    if (this.tryCombatAbilities(creature, template, victim, now)) return;

    const grid = this.world.grid(creature.map);
    const d = dist(creature.x, creature.y, victim.x, victim.y);
    const rangedOk = template.ranged && d <= yards(RANGED_ATTACK_YD) && (!grid || grid.lineOfSight(creature, victim));

    // Creatures have no automatic attack: every hit they land is one of their
    // abilities (tryCombatAbilities above). In reach, they hold position and
    // face the victim until an ability is ready.
    if (d <= melee || rangedOk) {
      stop(creature);
      threat.get(victim.id)!.unreachableSince = null;
      creature.dir = directionFor(victim.x - creature.x, victim.y - creature.y, creature.dir);
      return;
    }

    this.chase(creature, template, victim, now, dtMs, melee);
  }

  private chase(creature: CreatureInstance, template: CreatureTemplate, victim: PlayerUnit, now: number, dtMs: number, melee: number): void {
    const combat = creature.combat;
    const entry = combat.threat.get(victim.id)!;
    const grid = this.world.grid(creature.map);
    if (!grid) {
      entry.unreachableSince ??= now;
      this.dropIfUnreachable(creature, victim.id, now);
      return;
    }

    const targetMoved = dist(combat.pathTargetX, combat.pathTargetY, victim.x, victim.y) > grid.tileW;
    if ((!creature.move || targetMoved) && now - combat.lastRepathAt >= REPATH_MS) {
      combat.lastRepathAt = now;
      combat.pathTargetX = victim.x;
      combat.pathTargetY = victim.y;
      const ok = setDestination(creature, grid, victim, speedPxPerSec(template.move_speed_run), COMBAT_PATH_MAX_NODES);
      if (!ok) {
        entry.unreachableSince ??= now;
        this.dropIfUnreachable(creature, victim.id, now);
        return;
      }
      entry.unreachableSince = null;
    }

    if (creature.move) {
      creature.move.speed = speedPxPerSec(template.move_speed_run) * slowMultiplier(creature.auras, now);
      const result = advance(creature, grid, dtMs, (x, y) => this.registry.move(creature, x, y));
      if (result === "stuck") entry.unreachableSince ??= now;
      if (dist(creature.x, creature.y, victim.x, victim.y) <= melee * 0.9) stop(creature);
    }
    this.dropIfUnreachable(creature, victim.id, now);
  }

  private dropIfUnreachable(creature: CreatureInstance, unitId: string, now: number): void {
    const entry = creature.combat.threat.get(unitId);
    if (entry?.unreachableSince != null && now - entry.unreachableSince >= UNREACHABLE_DROP_MS) {
      this.removeThreat(creature, unitId);
      if (creature.combat.threat.isEmpty()) this.evade(creature, now);
    }
  }

  private shouldFleeLowHealth(creature: CreatureInstance, template: CreatureTemplate): boolean {
    if (template.flee_at_hp_pct <= 0 || creature.combat.fledThisCombat) return false;
    if ((template.flags & CreatureFlags.NEVER_FLEE) !== 0) return false;
    return (creature.health / creature.maxHealth) * 100 <= template.flee_at_hp_pct;
  }

  // ------------------------------------------------------------ flee/evade

  private startFlee(creature: CreatureInstance, template: CreatureTemplate, fromId: string | null, now: number, durationMs: number, speedMult: number): void {
    creature.state = AIState.FLEEING;
    creature.combat.fleeUntil = now + durationMs;
    creature.combat.fleeFromId = fromId;
    this.active.add(creature.id);
    stop(creature);
    this.pickFleeDestination(creature, template, speedMult);
    this.world.onStateChanged(creature);
    // Fleeing at low health calls nearby allies into the fight.
    if (template.stance !== "passive") this.callForHelp(creature, template, now);
  }

  private pickFleeDestination(creature: CreatureInstance, template: CreatureTemplate, speedMult: number): void {
    const grid = this.world.grid(creature.map);
    if (!grid) return;
    const from = creature.combat.fleeFromId ? this.world.getPlayer(creature.combat.fleeFromId) : null;
    const r = this.world.rng;
    const baseAngle = from ? Math.atan2(creature.y - from.y, creature.x - from.x) : r() * Math.PI * 2;
    const distance = yards(FLEE_DISTANCE_YD);
    for (const offset of [0, 0.6, -0.6, 1.2, -1.2, Math.PI]) {
      const a = baseAngle + offset;
      const target = { x: creature.x + Math.cos(a) * distance, y: creature.y + Math.sin(a) * distance };
      if (!grid.isWalkable(target.x, target.y)) continue;
      if (setDestination(creature, grid, target, speedPxPerSec(template.move_speed_run) * speedMult, 400)) return;
    }
  }

  private tickFlee(creature: CreatureInstance, template: CreatureTemplate, now: number, dtMs: number): void {
    const grid = this.world.grid(creature.map);
    if (now >= creature.combat.fleeUntil) {
      stop(creature);
      if (template.stance === "passive" || creature.combat.threat.isEmpty()) {
        this.clearThreat(creature);
        creature.state = AIState.IDLE;
        creature.waitUntil = now + 1000;
        this.active.delete(creature.id);
      } else {
        creature.state = AIState.COMBAT;
      }
      this.world.onStateChanged(creature);
      return;
    }
    if (!grid) return;
    if (isStunned(creature.auras, now)) {
      stop(creature);
      return;
    }
    const speedMult = template.stance === "passive" ? 1 : LOW_HP_FLEE_SPEED_MULT;
    if (!creature.move) this.pickFleeDestination(creature, template, speedMult);
    if (creature.move) {
      creature.move.speed = speedPxPerSec(template.move_speed_run) * speedMult * slowMultiplier(creature.auras, now);
      advance(creature, grid, dtMs, (x, y) => this.registry.move(creature, x, y));
    }
  }

  evade(creature: CreatureInstance, now: number): void {
    this.cancelCast(creature, "interrupted");
    this.clearThreat(creature);
    if (hasAuras(creature.auras, now)) {
      clearAuras(creature.auras);
      this.world.onAurasChanged(creature);
    }
    this.fireEventAbilities(creature, "on_evade", null, now);
    if (creature.combat.tapper) {
      creature.combat.tapper = null;
      this.world.onTapChanged(creature);
    }
    creature.state = AIState.EVADING;
    creature.combat.evadeStartedAt = now;
    creature.combat.fledThisCombat = false;
    this.active.add(creature.id);
    stop(creature);
    const template = this.world.template(creature.templateId);
    const grid = this.world.grid(creature.map);
    const home = this.resetPoint(creature);
    if (!template || !grid || !setDestination(creature, grid, home, speedPxPerSec(template.move_speed_run), COMBAT_PATH_MAX_NODES)) {
      this.finishEvade(creature, now, true);
      return;
    }
    this.world.onStateChanged(creature);
  }

  private resetPoint(creature: CreatureInstance): { x: number; y: number } {
    const spawn = this.world.spawn(creature.spawnId);
    // Patrolling creatures reset to where they were pulled; everyone else to their spawn.
    if (spawn?.movement_type === "patrol" && creature.combat.startedAt > 0) {
      return { x: creature.combat.startX, y: creature.combat.startY };
    }
    return { x: creature.homeX, y: creature.homeY };
  }

  private tickEvade(creature: CreatureInstance, _template: CreatureTemplate, now: number, dtMs: number): void {
    const grid = this.world.grid(creature.map);
    if (!grid || now - creature.combat.evadeStartedAt >= EVADE_TIMEOUT_MS) {
      this.finishEvade(creature, now, true);
      return;
    }
    const result = creature.move ? advance(creature, grid, dtMs, (x, y) => this.registry.move(creature, x, y)) : "arrived";
    if (result === "arrived") this.finishEvade(creature, now, false);
    else if (result === "stuck") this.finishEvade(creature, now, true);
  }

  private finishEvade(creature: CreatureInstance, now: number, snap: boolean): void {
    if (snap) {
      const home = this.resetPoint(creature);
      stop(creature);
      this.registry.move(creature, home.x, home.y);
    }
    creature.health = creature.maxHealth;
    creature.state = AIState.IDLE;
    creature.waitUntil = now + 1000;
    creature.combat.startedAt = 0;
    this.active.delete(creature.id);
    this.world.onHealthChanged(creature);
    this.world.onStateChanged(creature);
  }

  // ------------------------------------------------------------- threat ops

  /**
   * Put a creature in combat. Unless `social` is false, nearby same-type
   * creatures (assist radius) and every member of its link group join too.
   */
  enterCombat(creature: CreatureInstance, now: number, social = true): void {
    if (creature.state === AIState.COMBAT || creature.state === AIState.DEAD || creature.state === AIState.EVADING) return;
    const template = this.world.template(creature.templateId);
    if (!template || template.stance === "passive") return;
    const combat = creature.combat;
    const fresh = creature.state !== AIState.FLEEING;
    if (fresh) {
      combat.startX = creature.x;
      combat.startY = creature.y;
      combat.startedAt = now;
      combat.fledThisCombat = false;
      resetAbilityStates(creature.abilityStates, this.world.abilities(creature.templateId), now, this.world.rng);
    }
    creature.state = AIState.COMBAT;
    stop(creature);
    this.active.add(creature.id);
    for (const unitId of combat.threat.units()) this.world.markPlayerInCombat(unitId);
    this.world.onStateChanged(creature);
    if (social && fresh) this.pullAllies(creature, template, now);
  }

  // ----------------------------------------------------------- social aggro

  /** Out-of-combat creature that could be pulled into a fight. */
  private isIdle(c: CreatureInstance): boolean {
    return c.state === AIState.IDLE || c.state === AIState.WANDER || c.state === AIState.PATROL;
  }

  /** Whether `other` answers `source`'s call: same kind of creature, idle, same world slice, in sight. */
  canAssist(source: CreatureInstance, sourceTemplate: CreatureTemplate, other: CreatureInstance): boolean {
    if (other.id === source.id || !this.isIdle(other)) return false;
    if (other.map !== source.map || other.layerId !== source.layerId) return false;
    const otherTemplate = this.world.template(other.templateId);
    if (!otherTemplate || otherTemplate.stance === "passive") return false;
    if ((otherTemplate.flags & CreatureFlags.NO_SOCIAL_AGGRO) !== 0) return false;
    const sameKind = other.templateId === source.templateId
      || (otherTemplate.creature_type === sourceTemplate.creature_type && sourceTemplate.creature_type !== "critter");
    if (!sameKind) return false;
    const grid = this.world.grid(source.map);
    return !grid || grid.lineOfSight(source, other);
  }

  private pullAllies(creature: CreatureInstance, template: CreatureTemplate, now: number): void {
    if ((template.flags & CreatureFlags.NO_SOCIAL_AGGRO) !== 0) return;
    const helpers = new Map<number, CreatureInstance>();
    const assist = yards(template.assist_radius);
    if (assist > 0) {
      for (const other of this.registry.queryRadius(creature.map, creature.x, creature.y, assist)) {
        if (this.canAssist(creature, template, other)) helpers.set(other.id, other);
      }
    }
    // Linked pulls ignore distance, sight and creature type.
    for (const other of this.world.linkedCreatures(creature)) {
      if (other.id !== creature.id && this.isIdle(other) && other.map === creature.map && other.layerId === creature.layerId) {
        helpers.set(other.id, other);
      }
    }
    for (const helper of helpers.values()) this.joinFight(helper, creature, now);
  }

  private callForHelp(creature: CreatureInstance, template: CreatureTemplate, now: number): void {
    if ((template.flags & CreatureFlags.NO_SOCIAL_AGGRO) !== 0) return;
    const radius = yards(template.call_for_help_radius);
    if (radius <= 0) return;
    for (const other of this.registry.queryRadius(creature.map, creature.x, creature.y, radius)) {
      if (this.canAssist(creature, template, other)) this.joinFight(other, creature, now);
    }
  }

  /** Helper copies the caller's attackers onto its own threat table and engages (no chain pulls). */
  private joinFight(helper: CreatureInstance, caller: CreatureInstance, now: number): void {
    for (const unitId of caller.combat.threat.units()) this.addThreat(helper, unitId, PROXIMITY_THREAT, now);
    if (!helper.combat.threat.isEmpty()) this.enterCombat(helper, now, false);
  }

  addThreat(creature: CreatureInstance, unitId: string, amount: number, now: number): void {
    if (creature.state === AIState.DEAD || creature.state === AIState.EVADING) return;
    creature.combat.threat.add(unitId, amount, now);
    let set = this.unitIndex.get(unitId);
    if (!set) {
      set = new Set();
      this.unitIndex.set(unitId, set);
    }
    set.add(creature.id);
  }

  removeThreat(creature: CreatureInstance, unitId: string): void {
    creature.combat.threat.remove(unitId);
    const set = this.unitIndex.get(unitId);
    if (set) {
      set.delete(creature.id);
      if (set.size === 0) this.unitIndex.delete(unitId);
    }
  }

  private clearThreat(creature: CreatureInstance): void {
    for (const unitId of [...creature.combat.threat.units()]) this.removeThreat(creature, unitId);
    creature.combat.threat.clear();
  }

  /** A player died, logged out or left: remove them from every threat table. */
  removeUnit(unitId: string, now: number): void {
    const creatures = this.unitIndex.get(unitId);
    this.stopAutoAttack(unitId, false);
    if (!creatures) return;
    for (const id of [...creatures]) {
      const c = this.registry.get(id);
      if (!c) continue;
      this.removeThreat(c, unitId);
      if (c.state === AIState.COMBAT && c.combat.threat.isEmpty()) this.evade(c, now);
    }
    this.unitIndex.delete(unitId);
  }

  /**
   * Healing generates 0.5 threat per point, split across every creature
   * already fighting the healed unit. The healer joins those threat tables.
   */
  onPlayerHealed(casterId: string, targetId: string, amount: number, now: number): void {
    if (amount <= 0) return;
    const engaged = this.unitIndex.get(targetId);
    if (!engaged || engaged.size === 0) return;
    const creatures = [...engaged].map((id) => this.registry.get(id)).filter((c): c is CreatureInstance => !!c && c.state === AIState.COMBAT);
    if (creatures.length === 0) return;
    const share = (amount * 0.5) / creatures.length;
    for (const c of creatures) this.addThreat(c, casterId, share, now);
  }

  // ---------------------------------------------------------------- damage

  /**
   * Apply damage from a player to a creature. Handles evade immunity, threat,
   * stance reactions and death. Returns the damage actually dealt.
   */
  damageCreature(creature: CreatureInstance, attackerId: string, amount: number, now: number, threatMultiplier = 1): number {
    if (creature.state === AIState.DEAD) return 0;
    if (creature.state === AIState.EVADING) {
      this.world.onCombatText({ creatureId: creature.id, targetId: creatureUnitId(creature.id), sourceId: attackerId, kind: "evade", amount: 0 });
      return 0;
    }
    const template = this.world.template(creature.templateId);
    if (!template) return 0;

    const dealt = Math.max(0, Math.min(creature.health, Math.round(amount)));
    creature.health -= dealt;
    this.addThreat(creature, attackerId, Math.max(amount, 0) * threatMultiplier, now);
    this.tag(creature, attackerId);
    this.world.markPlayerInCombat(attackerId);
    this.world.onHealthChanged(creature);

    if (creature.health <= 0) {
      this.die(creature, attackerId, now);
      return dealt;
    }

    if (template.stance === "passive") {
      if (creature.state !== AIState.FLEEING) this.startFlee(creature, template, attackerId, now, PASSIVE_FLEE_MS, 1);
      else creature.combat.fleeUntil = now + PASSIVE_FLEE_MS;
    } else if (creature.state !== AIState.COMBAT && creature.state !== AIState.FLEEING) {
      this.enterCombat(creature, now);
    }
    return dealt;
  }

  /** First hostile action by a player taps the creature. */
  private tag(creature: CreatureInstance, playerId: string): void {
    if (creature.combat.tapper) return;
    const tapper = this.world.getPlayer(playerId);
    if (!tapper) return;
    creature.combat.tapper = { playerId: tapper.id, username: String(tapper.username || "").toLowerCase() };
    this.world.onTapChanged(creature);
  }

  die(creature: CreatureInstance, killerId: string | null, now: number): void {
    // A cast cut short by death just stops; it is not reported as interrupted.
    this.cancelCast(creature, "failed");
    // Death abilities (e.g. a final explosion) fire before the threat table is gone.
    const lastVictim = creature.combat.threat.victimId ?? creature.combat.threat.top();
    creature.state = AIState.DEAD;
    this.fireEventAbilities(creature, "on_death", lastVictim, now);
    clearAuras(creature.auras);
    this.clearThreat(creature);
    stop(creature);
    creature.health = 0;
    creature.state = AIState.DEAD;
    creature.combat.corpseUntil = now + CORPSE_EMPTY_MS;
    this.active.delete(creature.id);
    for (const [playerId, attack] of [...this.autoAttacks]) {
      if (attack.creatureId === creature.id) this.stopAutoAttack(playerId, true);
    }
    this.world.onHealthChanged(creature);
    this.world.onStateChanged(creature);
    this.world.onDied(creature, killerId);
  }

  /** Creature left the world (despawn/reload): drop all bookkeeping. */
  forget(creature: CreatureInstance): void {
    creature.casting = null;
    this.clearThreat(creature);
    this.active.delete(creature.id);
    for (const [playerId, attack] of [...this.autoAttacks]) {
      if (attack.creatureId === creature.id) this.stopAutoAttack(playerId, true);
    }
  }

  // ------------------------------------------------------ player auto-attack

  /** Returns an error reason, or null when auto-attack started. */
  startAutoAttack(playerId: string, creatureId: number, now: number): string | null {
    const player = this.world.getPlayer(playerId);
    const creature = this.registry.get(creatureId);
    if (!player || !player.alive) return "dead";
    if (!creature || creature.state === AIState.DEAD) return "invalid_target";
    if (creature.map !== player.map || !sameLayer(creature, player)) return "invalid_target";
    const existing = this.autoAttacks.get(playerId);
    // Re-targeting keeps the swing timer (no free instant swing by toggling).
    this.autoAttacks.set(playerId, { creatureId, nextSwingAt: existing ? Math.max(existing.nextSwingAt, now) : now });
    return null;
  }

  stopAutoAttack(playerId: string, notify: boolean): void {
    const attack = this.autoAttacks.get(playerId);
    if (!attack) return;
    this.autoAttacks.delete(playerId);
    if (notify) this.world.onAutoAttackStopped(playerId, attack.creatureId);
  }

  tickPlayerAttacks(now: number): void {
    for (const [playerId, attack] of [...this.autoAttacks]) {
      const player = this.world.getPlayer(playerId);
      const creature = this.registry.get(attack.creatureId);
      if (!player || !player.alive || !creature || creature.state === AIState.DEAD || creature.map !== player.map || !sameLayer(creature, player)) {
        this.stopAutoAttack(playerId, true);
        continue;
      }
      if (player.casting || now < attack.nextSwingAt) continue;
      const template = this.world.template(creature.templateId);
      if (!template) continue;
      if (dist(player.x, player.y, creature.x, creature.y) > meleeRangePx(template)) continue;
      attack.nextSwingAt = now + (player.weapon?.swingMs ?? PLAYER_SWING_MS);
      this.playerSwing(player, creature, template, now);
    }
  }

  private playerSwing(player: PlayerUnit, creature: CreatureInstance, template: CreatureTemplate, now: number): void {
    const r = this.world.rng;
    if (creature.state === AIState.EVADING) {
      this.damageCreature(creature, player.id, 0, now);
      return;
    }
    const inFront = isInFront(creature, creature.dir, player);
    const table = playerVsCreatureTable(player.level, creature.level, template.creature_type, inFront, player.critPct);
    const roll = rollPlayerVsCreature(table, 2 + player.critDamagePct / 100, r);
    const text = { creatureId: creature.id, targetId: creatureUnitId(creature.id), sourceId: player.id };
    if (roll.multiplier === 0) {
      this.world.onCombatText({ ...text, kind: roll.outcome, amount: 0 });
      // An avoided swing still pulls and taps the creature.
      this.addThreat(creature, player.id, 0, now);
      this.tag(creature, player.id);
      this.world.markPlayerInCombat(player.id);
      if (template.stance === "passive") {
        if (creature.state !== AIState.FLEEING) this.startFlee(creature, template, player.id, now, PASSIVE_FLEE_MS, 1);
      } else {
        this.enterCombat(creature, now);
      }
      return;
    }
    const [min, max] = playerMeleeDamageRange(player.level, player.statDamage, player.weapon);
    const raw = randInt(min, max, r) * roll.multiplier;
    const amount = Math.max(1, Math.round(raw * (1 - armorReduction(template.armor, player.level))));
    const dealt = this.damageCreature(creature, player.id, amount, now);
    this.world.onCombatText({ ...text, kind: roll.outcome, amount: dealt });
  }

  // ------------------------------------------------------- auras and spells

  private tickAuras(creature: CreatureInstance, now: number): void {
    const auras = creature.auras;
    if (auras.dots.length === 0) return;
    const before = auras.dots.length;
    for (const { dot, amount } of collectDotTicks(auras, now)) {
      if (creature.state === AIState.DEAD) return;
      if (amount > 0) {
        const dealt = this.damageCreature(creature, dot.casterId, amount, now);
        if (dealt > 0) this.world.onCombatText({ creatureId: creature.id, targetId: creatureUnitId(creature.id), sourceId: dot.casterId, kind: "spell", amount: dealt });
      } else {
        this.healCreature(creature, -amount, dot.casterId);
      }
    }
    if (creature.state !== AIState.DEAD && auras.dots.length !== before) this.world.onAurasChanged(creature);
  }

  private healCreature(creature: CreatureInstance, amount: number, sourceId: string): void {
    if (creature.state === AIState.DEAD || amount <= 0) return;
    const healed = Math.min(creature.maxHealth - creature.health, Math.round(amount));
    if (healed <= 0) return;
    creature.health += healed;
    this.world.onHealthChanged(creature);
    this.world.onCombatText({ creatureId: creature.id, targetId: creatureUnitId(creature.id), sourceId, kind: "heal", amount: healed });
  }

  /** Stop a cast in progress. Returns true if one was cancelled. */
  cancelCast(creature: CreatureInstance, result: CastResult): boolean {
    const cast = creature.casting;
    if (!cast) return false;
    creature.casting = null;
    this.world.onCastEnd(creature, cast.spellName, result);
    return true;
  }

  /** Interrupt effect: only interruptible casts, then lock out casting. */
  interruptCreature(creature: CreatureInstance, lockoutMs: number, now: number, spellName = ""): boolean {
    if (!creature.casting?.interruptible) return false;
    this.cancelCast(creature, "interrupted");
    applyCastLockout(creature.auras, lockoutMs, now, spellName);
    this.world.onAurasChanged(creature);
    return true;
  }

  /**
   * A player's spell effects landing on a creature. Supports damage/heal over
   * time, stun, slow, interrupt, taunt and threat modification.
   */
  applySpellToCreature(creature: CreatureInstance, sourceId: string, spell: SpellData, now: number): void {
    if (creature.state === AIState.DEAD || creature.state === AIState.EVADING) return;
    if (!Array.isArray(spell?.effects)) return;
    const template = this.world.template(creature.templateId);
    if (!template) return;
    const immune = () => this.world.onCombatText({ creatureId: creature.id, targetId: creatureUnitId(creature.id), sourceId, kind: "immune", amount: 0 });
    // A player caster's damage stat adds to their DoT/HoT ticks (classic WoW);
    // creature sources are not players and get no bonus.
    const casterStat = this.world.getPlayer(sourceId)?.statDamage ?? 0;
    let changed = false;
    for (const rawEffect of spell.effects) {
      const effect = withPeriodicBonus(rawEffect, casterStat);
      const durationMs = (Number(effect?.duration) || 0) * 1000;
      switch (effect?.type) {
        case "damage_over_time":
          changed = applyDot(creature.auras, spell.name, sourceId, effect, now) || changed;
          break;
        case "heal_over_time":
          changed = applyDot(creature.auras, spell.name, sourceId, { ...effect, value: -Math.abs(Number(effect.value) || 0) }, now) || changed;
          break;
        case "stun":
          if (durationMs <= 0) break;
          if ((template.flags & CreatureFlags.IMMUNE_STUN) !== 0) {
            immune();
            break;
          }
          applyStun(creature.auras, durationMs, now, spell.name);
          this.cancelCast(creature, "interrupted");
          stop(creature);
          changed = true;
          break;
        case "slow":
          if (durationMs <= 0) break;
          if ((template.flags & CreatureFlags.IMMUNE_ROOT) !== 0) {
            immune();
            break;
          }
          applySlow(creature.auras, `slow:${spell.name}`, Number(effect.value) || 1, durationMs, now);
          changed = true;
          break;
        case "interrupt":
          if (this.interruptCreature(creature, durationMs > 0 ? durationMs : DEFAULT_LOCKOUT_MS, now, spell.name)) {
            this.world.onCombatText({ creatureId: creature.id, targetId: creatureUnitId(creature.id), sourceId, kind: "interrupted", amount: 0 });
          }
          break;
        case "taunt":
          if ((template.flags & CreatureFlags.NO_TAUNT) !== 0) {
            immune();
            break;
          }
          this.addThreat(creature, sourceId, 0, now);
          creature.combat.threat.taunt(sourceId, now, durationMs > 0 ? durationMs : undefined);
          this.tag(creature, sourceId);
          this.enterCombat(creature, now);
          this.world.onStateChanged(creature);
          break;
        case "threat":
          creature.combat.threat.modify(sourceId, Math.max(0, 1 + (Number(effect.value) || 0) / 100));
          break;
      }
    }
    if (changed) this.world.onAurasChanged(creature);
  }

  /** Feign death: drop off every threat table unless a higher-level creature resists (10% per level). */
  feignDeath(playerId: string, playerLevel: number, now: number): number {
    let resisted = 0;
    for (const id of [...(this.unitIndex.get(playerId) ?? [])]) {
      const c = this.registry.get(id);
      if (!c) continue;
      const resistPct = Math.max(0, c.level - playerLevel) * 10;
      if (this.world.rng() * 100 < resistPct) {
        resisted++;
        continue;
      }
      this.removeThreat(c, playerId);
      if (c.state === AIState.COMBAT && c.combat.threat.isEmpty()) this.evade(c, now);
    }
    this.stopAutoAttack(playerId, true);
    return resisted;
  }

  /** Scale a player's threat on every creature fighting them (e.g. -50 for Fade). */
  modifyThreatEverywhere(playerId: string, percentChange: number): void {
    const multiplier = Math.max(0, 1 + percentChange / 100);
    for (const id of this.unitIndex.get(playerId) ?? []) this.registry.get(id)?.combat.threat.modify(playerId, multiplier);
  }

  // --------------------------------------------------------------- abilities

  private tryCombatAbilities(creature: CreatureInstance, template: CreatureTemplate, victim: PlayerUnit, now: number): boolean {
    const abilities = this.world.abilities(creature.templateId);
    if (abilities.length === 0 || isCastLockedOut(creature.auras, now)) return false;
    const ready = readyAbilities(abilities, creature.abilityStates, {
      now,
      healthPct: (creature.health / creature.maxHealth) * 100,
      inCombat: true,
      victimCasting: victim.casting,
    });
    return this.useFirstAbility(creature, template, ready, victim, now, true);
  }

  private tryOutOfCombatAbilities(creature: CreatureInstance, template: CreatureTemplate, now: number): void {
    const abilities = this.world.abilities(creature.templateId).filter((a) => a.trigger === "ooc_timer");
    if (abilities.length === 0 || isCastLockedOut(creature.auras, now)) return;
    for (const a of abilities) {
      if (!creature.abilityStates.has(a.id)) creature.abilityStates.set(a.id, { nextReadyAt: now, fired: false });
    }
    const ready = readyAbilities(abilities, creature.abilityStates, { now, healthPct: 100, inCombat: false, victimCasting: false });
    // Out of combat abilities are always instant.
    this.useFirstAbility(creature, template, ready, null, now, false);
  }

  private useFirstAbility(
    creature: CreatureInstance,
    template: CreatureTemplate,
    ready: CreatureAbility[],
    victim: PlayerUnit | null,
    now: number,
    allowCastTime: boolean
  ): boolean {
    const r = this.world.rng;
    for (const ability of ready) {
      const spell = this.world.spell(ability.spell_id);
      if (!spell || r() * 100 >= ability.chance_pct) {
        markUsed(ability, creature.abilityStates, now, r);
        continue;
      }
      const target = this.pickAbilityTarget(creature, template, ability, spell, victim);
      if (!target) continue;
      markUsed(ability, creature.abilityStates, now, r);
      this.beginCast(creature, ability, spell, target, now, allowCastTime);
      return true;
    }
    return false;
  }

  /** Fire on_death / on_evade abilities instantly. */
  private fireEventAbilities(creature: CreatureInstance, trigger: AbilityTrigger, victimId: string | null, now: number): void {
    const template = this.world.template(creature.templateId);
    if (!template) return;
    const victim = victimId ? this.world.getPlayer(victimId) : null;
    for (const ability of this.world.abilities(creature.templateId)) {
      if (ability.trigger !== trigger || this.world.rng() * 100 >= ability.chance_pct) continue;
      const spell = this.world.spell(ability.spell_id);
      if (!spell) continue;
      const target = this.pickAbilityTarget(creature, template, ability, spell, victim);
      if (target) this.resolveSpell(creature, spell, target, now);
    }
  }

  private abilityRangePx(ability: CreatureAbility, spell: SpellData, template: CreatureTemplate): number {
    if (ability.max_range > 0) return yards(ability.max_range);
    return Number(spell.range) > 0 ? Number(spell.range) : meleeRangePx(template);
  }

  pickAbilityTarget(
    creature: CreatureInstance,
    template: CreatureTemplate,
    ability: CreatureAbility,
    spell: SpellData,
    victim: PlayerUnit | null
  ): CastTarget | null {
    const range = this.abilityRangePx(ability, spell, template);
    const grid = this.world.grid(creature.map);
    const reachable = (p: PlayerUnit | null): p is PlayerUnit =>
      !!p && p.alive && p.map === creature.map && sameLayer(creature, p)
      && dist(creature.x, creature.y, p.x, p.y) <= range && (!grid || grid.lineOfSight(creature, p));
    const threatPlayers = () => [...creature.combat.threat.units()].map((id) => this.world.getPlayer(id)).filter(reachable);
    const pick = (list: PlayerUnit[]): CastTarget | null =>
      list.length ? { kind: "player", id: list[Math.floor(this.world.rng() * list.length)].id } : null;

    switch (ability.target_mode) {
      case "self":
        return { kind: "creature", id: String(creature.id) };
      case "random":
        return pick(threatPlayers());
      case "random_not_top":
        return pick(threatPlayers().filter((p) => p.id !== creature.combat.threat.victimId));
      case "farthest": {
        const list = threatPlayers().sort((a, b) => dist(creature.x, creature.y, b.x, b.y) - dist(creature.x, creature.y, a.x, a.y));
        return list.length ? { kind: "player", id: list[0].id } : null;
      }
      case "lowest_hp_ally": {
        let best: CreatureInstance | null = null;
        let bestPct = 1;
        for (const c of this.registry.queryRadius(creature.map, creature.x, creature.y, range)) {
          if (c.state === AIState.DEAD || c.layerId !== creature.layerId) continue;
          const pct = c.health / c.maxHealth;
          if (pct < bestPct) {
            best = c;
            bestPct = pct;
          }
        }
        return best ? { kind: "creature", id: String(best.id) } : null;
      }
      default:
        return reachable(victim) ? { kind: "player", id: victim.id } : null;
    }
  }

  private beginCast(creature: CreatureInstance, ability: CreatureAbility, spell: SpellData, target: CastTarget, now: number, allowCastTime: boolean): void {
    const castMs = allowCastTime ? Math.max(0, (Number(spell.cast_time) || 0) * 1000) : 0;
    const targetPos = this.targetPosition(target);
    if (targetPos) creature.dir = directionFor(targetPos.x - creature.x, targetPos.y - creature.y, creature.dir);
    if (castMs <= 0) {
      this.resolveSpell(creature, spell, target, now);
      return;
    }
    stop(creature);
    creature.casting = {
      abilityId: ability.id,
      spellId: ability.spell_id,
      spellName: spell.name,
      target,
      startedAt: now,
      endsAt: now + castMs,
      interruptible: ability.interruptible,
    };
    this.world.onCastStart(creature);
  }

  private targetPosition(target: CastTarget): { x: number; y: number } | null {
    if (target.kind === "player") return this.world.getPlayer(target.id);
    return this.registry.get(Number(target.id)) ?? null;
  }

  private progressCast(creature: CreatureInstance, template: CreatureTemplate, now: number): void {
    const cast = creature.casting!;
    const pos = this.targetPosition(cast.target);
    const targetAlive = cast.target.kind === "player"
      ? !!this.world.getPlayer(cast.target.id)?.alive
      : !!pos && this.registry.get(Number(cast.target.id))?.state !== AIState.DEAD;
    if (!pos || !targetAlive) {
      this.cancelCast(creature, "failed");
      return;
    }
    if (now < cast.endsAt) return;

    const spell = this.world.spell(cast.spellId);
    const ability = this.world.abilities(creature.templateId).find((a) => a.id === cast.abilityId);
    const range = spell && ability ? this.abilityRangePx(ability, spell, template) : 0;
    const grid = this.world.grid(creature.map);
    const inRange = dist(creature.x, creature.y, pos.x, pos.y) <= range * CAST_RANGE_TOLERANCE;
    const inSight = cast.target.kind === "creature" || !grid || grid.lineOfSight(creature, pos);
    if (!spell || !inRange || !inSight) {
      this.cancelCast(creature, "failed");
      return;
    }
    creature.casting = null;
    this.world.onCastEnd(creature, cast.spellName, "success");
    this.resolveSpell(creature, spell, cast.target, now);
  }

  /** Apply a creature spell: direct damage/heal (single target or AoE) plus effects. */
  resolveSpell(creature: CreatureInstance, spell: SpellData, target: CastTarget, now: number): void {
    this.world.onSpellLaunch?.(creature, spell, target);

    // Spells with a projectile land when it arrives, not the instant they are
    // cast, so the damage matches what players see flying at them.
    const targetPos = this.targetPosition(target);
    const travelMs = targetPos && this.world.later
      ? projectileTravelMs(dist(creature.x, creature.y, targetPos.x, targetPos.y))
      : 0;
    if (travelMs > 0) {
      this.world.later!(travelMs, () => {
        // Evading resets the fight, so a shot in flight is cancelled. Dying does
        // not: on_death abilities are cast as the creature falls and must land.
        if (creature.state === AIState.EVADING) return;
        this.applySpell(creature, spell, target, Date.now());
      });
      return;
    }
    this.applySpell(creature, spell, target, now);
  }

  /** Lands a creature spell on its target(s). */
  private applySpell(creature: CreatureInstance, spell: SpellData, target: CastTarget, now: number): void {
    const r = this.world.rng;
    const base = Number(spell.damage) || 0;
    const radius = Number(spell.aoe_radius) || 0;
    const levelBonus = () => randInt((creature.level - 1) * 2, (creature.level - 1) * 5, r);
    const source = creatureUnitId(creature.id);
    const effects = Array.isArray(spell.effects) ? spell.effects : [];

    if (target.kind === "player") {
      const primary = this.world.getPlayer(target.id);
      if (!primary) return;
      const victims = radius > 0
        ? this.world
            .playersNear(creature.map, primary.x, primary.y, radius)
            // Hidden players are not splashed by a creature's AoE.
            .filter((p) => p.alive && !p.gmHidden && !p.stealthed && sameLayer(creature, p))
        : [primary];
      for (const v of victims) {
        if (r() * 100 < spellMissChance(creature.level, v.level)) {
          this.world.onCombatText({ creatureId: creature.id, targetId: v.id, sourceId: source, kind: "resist", amount: 0 });
          continue;
        }
        if (base > 0) {
          const crit = r() * 100 < CREATURE_SPELL_CRIT_PCT;
          const amount = Math.max(1, Math.round((base + levelBonus()) * (crit ? SPELL_CRIT_MULTIPLIER : 1)));
          this.world.damagePlayer(creature, v.id, amount, crit ? "crit" : "hit");
        }
        if (effects.length) this.world.applySpellEffectsToPlayer(creature, v.id, spell);
      }
      return;
    }

    const primary = this.registry.get(Number(target.id));
    if (!primary || primary.state === AIState.DEAD) return;
    const allies = radius > 0
      ? this.registry.queryRadius(primary.map, primary.x, primary.y, radius).filter((c) => c.state !== AIState.DEAD && c.layerId === creature.layerId)
      : [primary];
    // Friendly effects only (HoTs); hostile effects are meant for players.
    const friendly = effects.filter((e) => e?.type === "heal_over_time");
    for (const ally of allies) {
      if (base < 0) this.healCreature(ally, Math.abs(base) + levelBonus(), source);
      if (friendly.length) this.applySpellToCreature(ally, source, { ...spell, effects: friendly }, now);
    }
  }
}
