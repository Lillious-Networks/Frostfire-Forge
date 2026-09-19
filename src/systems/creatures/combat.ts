/** WoW (Classic) attack tables and mitigation. Pure functions, RNG injected. */
import type { Rng } from "./constants";

export type MeleeOutcome = "miss" | "dodge" | "parry" | "glancing" | "crit" | "crush" | "hit";

export interface AttackRoll {
  outcome: MeleeOutcome;
  /** Damage multiplier for the outcome (0 for avoided attacks). */
  multiplier: number;
}

/** Weapon/defense skill is 5 per level. */
const SKILL_PER_LEVEL = 5;

const clampPct = (v: number) => Math.max(0, Math.min(100, v));

/** Creature types that never parry. */
const NO_PARRY_TYPES = new Set(["beast", "critter", "elemental", "mechanical", "totem"]);

export interface CreatureAttackTable {
  miss: number;
  dodge: number;
  parry: number;
  crit: number;
  crush: number;
}

/**
 * Creature attacking a player. `d` = creature level - player level.
 * Dodge only works when the player faces the attacker.
 */
export function creatureVsPlayerTable(creatureLevel: number, playerLevel: number, playerDodgePct: number, playerFacing: boolean): CreatureAttackTable {
  const d = creatureLevel - playerLevel;
  const skillDiff = d * SKILL_PER_LEVEL;
  return {
    miss: clampPct(5 - skillDiff * 0.04),
    dodge: playerFacing ? clampPct(playerDodgePct - skillDiff * 0.04) : 0,
    parry: 0,
    crit: clampPct(5 + skillDiff * 0.04),
    // Crushing blows need a 15+ skill advantage (3 levels): 2% per skill point - 15%.
    crush: skillDiff >= 15 ? clampPct(skillDiff * 2 - 15) : 0,
  };
}

export function rollCreatureVsPlayer(table: CreatureAttackTable, r: Rng): AttackRoll {
  const roll = r() * 100;
  let edge = table.miss;
  if (roll < edge) return { outcome: "miss", multiplier: 0 };
  if (roll < (edge += table.dodge)) return { outcome: "dodge", multiplier: 0 };
  if (roll < (edge += table.parry)) return { outcome: "parry", multiplier: 0 };
  if (roll < (edge += table.crit)) return { outcome: "crit", multiplier: 2 };
  if (roll < (edge += table.crush)) return { outcome: "crush", multiplier: 1.5 };
  return { outcome: "hit", multiplier: 1 };
}

export interface PlayerAttackTable {
  miss: number;
  dodge: number;
  parry: number;
  glancing: number;
  crit: number;
}

/**
 * Player auto-attacking a creature. `d` = creature level - player level.
 * Parry only from the front, and never for beasts/critters and similar.
 */
export function playerVsCreatureTable(
  playerLevel: number,
  creatureLevel: number,
  creatureType: string,
  attackerInFront: boolean,
  playerCritPct: number
): PlayerAttackTable {
  const d = creatureLevel - playerLevel;
  const skillDiff = d * SKILL_PER_LEVEL;
  const miss = skillDiff > 10 ? 7 + (skillDiff - 10) * 0.4 : 5 + skillDiff * 0.1;
  const canParry = attackerInFront && !NO_PARRY_TYPES.has(creatureType);
  return {
    miss: clampPct(miss),
    dodge: clampPct(5 + skillDiff * 0.1),
    parry: canParry ? clampPct(5 + skillDiff * 0.1) : 0,
    // Glancing blows only against same-level or higher creatures.
    glancing: d >= 0 ? clampPct(10 + skillDiff * 2) : 0,
    crit: clampPct(playerCritPct - (skillDiff > 0 ? skillDiff * 0.2 : 0)),
  };
}

export const GLANCING_MULTIPLIER = 0.7;

export function rollPlayerVsCreature(table: PlayerAttackTable, critMultiplier: number, r: Rng): AttackRoll {
  const roll = r() * 100;
  let edge = table.miss;
  if (roll < edge) return { outcome: "miss", multiplier: 0 };
  if (roll < (edge += table.dodge)) return { outcome: "dodge", multiplier: 0 };
  if (roll < (edge += table.parry)) return { outcome: "parry", multiplier: 0 };
  if (roll < (edge += table.glancing)) return { outcome: "glancing", multiplier: GLANCING_MULTIPLIER };
  if (roll < (edge += table.crit)) return { outcome: "crit", multiplier: critMultiplier };
  return { outcome: "hit", multiplier: 1 };
}

/** Spell hit vs level difference: 96/95/94% at +0/+1/+2, then -11% per level. */
export function spellMissChance(casterLevel: number, targetLevel: number): number {
  const d = targetLevel - casterLevel;
  if (d <= 0) return 4;
  if (d <= 2) return 4 + d;
  return Math.min(99, 6 + (d - 2) * 11);
}

/** WoW armor mitigation, capped at 75%. */
export function armorReduction(armor: number, attackerLevel: number): number {
  if (armor <= 0) return 0;
  return Math.min(0.75, armor / (armor + 400 + 85 * attackerLevel));
}

/** Players store armor as a direct percentage (engine convention), capped at 75%. */
export function playerArmorReduction(statArmor: number): number {
  return Math.min(75, Math.max(0, statArmor || 0)) / 100;
}

/** True when `observer` (facing `dir`) has `other` within its front 180 degrees. */
export function isInFront(observer: { x: number; y: number }, dir: string, other: { x: number; y: number }): boolean {
  const facing = DIR_VECTORS[dir] ?? DIR_VECTORS.down;
  const dx = other.x - observer.x;
  const dy = other.y - observer.y;
  if (dx === 0 && dy === 0) return true;
  return facing[0] * dx + facing[1] * dy >= 0;
}

const INV_SQRT2 = Math.SQRT1_2;
const DIR_VECTORS: Record<string, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
  upleft: [-INV_SQRT2, -INV_SQRT2],
  upright: [INV_SQRT2, -INV_SQRT2],
  downleft: [-INV_SQRT2, INV_SQRT2],
  downright: [INV_SQRT2, INV_SQRT2],
};

/** The equipped weapon's swing, as the combat code needs it. */
export interface WeaponProfile {
  damageMin: number;
  damageMax: number;
  swingMs: number;
}

/** Bare-handed swing: weak and fast, like WoW's unarmed. */
export const UNARMED: WeaponProfile = { damageMin: 1, damageMax: 2, swingMs: 2000 };

export const PLAYER_SWING_MS = UNARMED.swingMs;

/**
 * Swing damage: the weapon's own range plus damage stats scaled by swing speed,
 * so a slow weapon hits proportionally harder for the same damage per second.
 */
export function playerMeleeDamageRange(level: number, statDamage: number, weapon?: WeaponProfile | null): [number, number] {
  const w = weapon ?? UNARMED;
  const bonus = Math.max(0, statDamage || 0) * (w.swingMs / UNARMED.swingMs);
  // Unarmed still scales with level; a weapon's own range is its damage.
  const levelBonus = weapon ? 0 : level;
  return [
    Math.max(1, Math.round(w.damageMin + levelBonus + bonus)),
    Math.max(1, Math.round(w.damageMax + levelBonus * 2 + bonus)),
  ];
}

/**
 * Weapon stats -> swing profile. Items that carry no damage range fall back to
 * their flat damage stat so older weapons keep working.
 */
export function weaponProfile(item: {
  damage_min?: number | null;
  damage_max?: number | null;
  attack_speed_ms?: number | null;
  stat_damage?: number | null;
} | null | undefined): WeaponProfile | null {
  if (!item) return null;
  const swingMs = Math.max(500, Number(item.attack_speed_ms) || UNARMED.swingMs);
  const min = Number(item.damage_min) || 0;
  const max = Number(item.damage_max) || 0;
  if (min > 0 || max > 0) {
    const low = Math.max(1, Math.min(min || max, max || min));
    const high = Math.max(low, max || min);
    return { damageMin: low, damageMax: high, swingMs };
  }
  const flat = Number(item.stat_damage) || 0;
  if (flat > 0) return { damageMin: flat, damageMax: Math.max(flat, Math.round(flat * 1.5)), swingMs };
  return null;
}
/** Chance a melee hit from behind dazes the player. */
export const DAZE_CHANCE_PCT = 20;
export const DAZE_SLOW_PCT = 50;
export const DAZE_DURATION_S = 4;
