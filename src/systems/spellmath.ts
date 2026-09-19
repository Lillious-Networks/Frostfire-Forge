// Spell healing and mana cost, modelled on classic World of Warcraft.
//
// Healing: the spell's value rolled with the caster's level (the same roll
// damage uses), plus a share of the caster's damage stat scaled by cast time:
// cast time / 3.5s, with instant casts counted as the 1.5s global cooldown.
// Heals crit for 150%. Armor and avoidance never reduce a heal, and anything
// past the target's max health is wasted (callers cap health).
//
// Damage and heal over time: each tick also gets a share of the caster's damage
// stat - duration / 15s of it (capped at all of it), split across the ticks.
//
// Mana: a spell's `mana` is a percentage of the caster's BASE stamina (from
// level alone), not of the gear-boosted total - so gear that adds stamina
// makes spells relatively cheaper, as in WoW.

export type Rng = () => number;

/** Cast time that earns the full bonus coefficient (classic WoW). */
export const FULL_COEFFICIENT_CAST_S = 3.5;
/** Instant spells are treated as a global-cooldown-length cast. */
export const GCD_S = 1.5;
/** Critical heals restore this multiple of the rolled amount. */
export const HEAL_CRIT_MULTIPLIER = 1.5;

/**
 * The level roll every spell uses: `base` plus 2-5 per level past 1, uniform.
 * Takes and returns a magnitude (callers apply the sign).
 */
export function levelRoll(base: number, level: number, rng: Rng = Math.random): number {
  const magnitude = Math.abs(Number(base) || 0);
  const steps = Math.max(0, (Number(level) || 1) - 1);
  const min = magnitude + steps * 2;
  const max = magnitude + steps * 5;
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Share of the caster's bonus stat a spell of this cast time receives. */
export function castTimeCoefficient(castTimeSeconds: number): number {
  const effective = Math.max(GCD_S, Number(castTimeSeconds) || 0);
  return Math.min(1, effective / FULL_COEFFICIENT_CAST_S);
}

export interface HealRoll {
  /** Health restored before the max-health cap (always >= 0). */
  amount: number;
  isCrit: boolean;
}

/**
 * Amount a heal spell restores. `spellValue` is the spell's `damage` column
 * (negative for heals; the magnitude is used either way).
 */
export function rollHeal(
  spellValue: number,
  caster: { level?: number; stat_damage?: number; stat_critical_chance?: number } | undefined,
  castTimeSeconds: number,
  rng: Rng = Math.random
): HealRoll {
  const base = levelRoll(spellValue, caster?.level || 1, rng);
  const bonus = Math.max(0, Number(caster?.stat_damage) || 0) * castTimeCoefficient(castTimeSeconds);
  const isCrit = rng() * 100 < (Number(caster?.stat_critical_chance) || 0);
  const amount = Math.floor((base + bonus) * (isCrit ? HEAL_CRIT_MULTIPLIER : 1));
  return { amount: Math.max(0, amount), isCrit };
}

/** Duration that earns a periodic effect the full bonus coefficient (classic WoW). */
export const PERIODIC_FULL_COEFFICIENT_S = 15;

/**
 * Extra amount each tick of a damage/heal-over-time effect gets from the
 * caster's damage stat: the stat x (duration / 15s, capped at 1), spread
 * evenly across the effect's ticks - classic WoW's rule for DoTs and HoTs.
 */
export function periodicBonusPerTick(statDamage: number, durationSeconds: number, intervalSeconds: number): number {
  const duration = Number(durationSeconds) || 0;
  const interval = Number(intervalSeconds) || 0;
  if (duration <= 0 || interval <= 0) return 0;
  const ticks = Math.max(1, Math.floor(duration / interval));
  const coefficient = Math.min(1, duration / PERIODIC_FULL_COEFFICIENT_S);
  return Math.floor((Math.max(0, Number(statDamage) || 0) * coefficient) / ticks);
}

/**
 * A damage/heal-over-time effect with the caster's bonus folded into its
 * per-tick `value`, fixed at the moment it is applied (classic snapshots the
 * caster's power on application). Other effects, and effects with no base
 * value, come back unchanged. The value's sign is kept.
 */
export function withPeriodicBonus<T extends { type?: string; value?: unknown; duration?: unknown; interval?: unknown }>(effect: T, statDamage: number): T {
  if (effect?.type !== "damage_over_time" && effect?.type !== "heal_over_time") return effect;
  const value = Number(effect.value) || 0;
  if (value === 0) return effect;
  const bonus = periodicBonusPerTick(statDamage, Number(effect.duration), Number(effect.interval) || 1);
  if (bonus === 0) return effect;
  return { ...effect, value: Math.sign(value) * (Math.abs(value) + bonus) };
}

/** Mana a spell costs: its `mana` percentage of the caster's base stamina. */
export function spellManaCost(manaPct: number, stats: { max_stamina?: number; total_max_stamina?: number } | undefined): number {
  const base = Number(stats?.max_stamina) || Number(stats?.total_max_stamina) || 0;
  return Math.floor(base * (Math.max(0, Number(manaPct) || 0) / 100));
}
