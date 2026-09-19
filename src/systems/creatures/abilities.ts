/** Creature ability scheduling: which ability is ready now. Pure functions. */
import { randInt, type Rng } from "./constants";
import type { CreatureAbility } from "./types";

export type AbilityTrigger = "combat_timer" | "hp_below" | "on_aggro" | "on_death" | "on_evade" | "target_casting" | "ooc_timer";

export interface AbilityState {
  nextReadyAt: number;
  /** One-shot triggers (hp_below, on_aggro) fire once per combat. */
  fired: boolean;
}

export function rollCooldown(ability: CreatureAbility, r: Rng): number {
  return randInt(ability.cooldown_min_ms, Math.max(ability.cooldown_min_ms, ability.cooldown_max_ms), r);
}

export function rollInitialDelay(ability: CreatureAbility, r: Rng): number {
  return randInt(ability.initial_cd_min_ms, Math.max(ability.initial_cd_min_ms, ability.initial_cd_max_ms), r);
}

/** Reset per-combat scheduling (called when a creature enters combat, and on evade). */
export function resetAbilityStates(states: Map<number, AbilityState>, abilities: CreatureAbility[], now: number, r: Rng): void {
  states.clear();
  for (const a of abilities) {
    const delay = a.trigger === "combat_timer" || a.trigger === "target_casting" || a.trigger === "ooc_timer" ? rollInitialDelay(a, r) : 0;
    states.set(a.id, { nextReadyAt: now + delay, fired: false });
  }
}

export interface AbilityConditions {
  now: number;
  healthPct: number;
  inCombat: boolean;
  victimCasting: boolean;
}

/** Whether a single ability's trigger condition holds (ignores chance and targeting). */
export function isTriggered(ability: CreatureAbility, state: AbilityState | undefined, c: AbilityConditions): boolean {
  if (!state || c.now < state.nextReadyAt) return false;
  switch (ability.trigger as AbilityTrigger) {
    case "combat_timer":
      return c.inCombat;
    case "hp_below":
      return c.inCombat && !state.fired && c.healthPct <= ability.trigger_value;
    case "on_aggro":
      return c.inCombat && !state.fired;
    case "target_casting":
      return c.inCombat && c.victimCasting;
    case "ooc_timer":
      return !c.inCombat;
    default:
      // on_death / on_evade fire from their events, never from the scheduler.
      return false;
  }
}

/** Triggered abilities, highest priority first (ties keep table order). */
export function readyAbilities(abilities: CreatureAbility[], states: Map<number, AbilityState>, c: AbilityConditions): CreatureAbility[] {
  return abilities
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => isTriggered(a, states.get(a.id), c))
    .sort((x, y) => y.a.priority - x.a.priority || x.i - y.i)
    .map(({ a }) => a);
}

/** Record that an ability was used (or skipped by its chance roll): start its cooldown. */
export function markUsed(ability: CreatureAbility, states: Map<number, AbilityState>, now: number, r: Rng): void {
  const state = states.get(ability.id) ?? { nextReadyAt: 0, fired: false };
  state.fired = true;
  state.nextReadyAt = now + rollCooldown(ability, r);
  states.set(ability.id, state);
}
