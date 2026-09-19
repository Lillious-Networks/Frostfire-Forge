/** Effects living on a creature: damage/heal over time, stuns, slows, cast lockouts. Pure state. */

export const DEFAULT_DOT_MAX_STACKS = 5;
export const DEFAULT_LOCKOUT_MS = 3000;

export interface CreatureDot {
  /** Spell name; one DoT per spell per creature (stacks refresh it). */
  id: string;
  casterId: string;
  /** Per tick, per stack. Negative values heal. */
  amountPerTick: number;
  intervalMs: number;
  expiresAt: number;
  nextTickAt: number;
  stacks: number;
  maxStacks: number;
}

export interface CreatureSlow {
  id: string;
  pct: number;
  expiresAt: number;
}

export interface CreatureAuras {
  dots: CreatureDot[];
  stunUntil: number;
  /** Spell that applied the current stun / lockout, so clients can show its icon. */
  stunSpell: string;
  slows: CreatureSlow[];
  castLockoutUntil: number;
  lockoutSpell: string;
}

export function createAuras(): CreatureAuras {
  return { dots: [], stunUntil: 0, stunSpell: "", slows: [], castLockoutUntil: 0, lockoutSpell: "" };
}

export function clearAuras(auras: CreatureAuras): void {
  auras.dots.length = 0;
  auras.slows.length = 0;
  auras.stunUntil = 0;
  auras.stunSpell = "";
  auras.castLockoutUntil = 0;
  auras.lockoutSpell = "";
}

export function hasAuras(auras: CreatureAuras, now: number): boolean {
  return auras.dots.length > 0 || auras.slows.some((s) => s.expiresAt > now) || auras.stunUntil > now || auras.castLockoutUntil > now;
}

/** Apply or refresh a DoT/HoT. Refreshing keeps the tick schedule; stackable DoTs gain a stack. */
export function applyDot(auras: CreatureAuras, spellName: string, casterId: string, effect: SpellEffect, now: number): boolean {
  const amount = Math.trunc(Number(effect.value) || 0);
  const durationMs = (Number(effect.duration) || 0) * 1000;
  const intervalMs = (Number(effect.interval) || 1) * 1000;
  if (amount === 0 || durationMs <= 0 || intervalMs <= 0) return false;
  const stackable = effect.stackable === true;
  const maxStacks = stackable ? Math.max(1, Number(effect.max_stacks) || DEFAULT_DOT_MAX_STACKS) : 1;

  const existing = auras.dots.find((d) => d.id === spellName);
  if (existing) {
    existing.stacks = stackable ? Math.min(existing.stacks + 1, maxStacks) : 1;
    existing.amountPerTick = amount;
    existing.intervalMs = intervalMs;
    existing.maxStacks = maxStacks;
    existing.expiresAt = now + durationMs;
    existing.casterId = casterId;
    return true;
  }
  auras.dots.push({ id: spellName, casterId, amountPerTick: amount, intervalMs, expiresAt: now + durationMs, nextTickAt: now + intervalMs, stacks: 1, maxStacks });
  return true;
}

/** Due ticks since the last call (removing expired DoTs). Amount already includes stacks. */
export function collectDotTicks(auras: CreatureAuras, now: number): Array<{ dot: CreatureDot; amount: number }> {
  const ticks: Array<{ dot: CreatureDot; amount: number }> = [];
  for (let i = auras.dots.length - 1; i >= 0; i--) {
    const dot = auras.dots[i];
    while (dot.nextTickAt <= now && dot.nextTickAt <= dot.expiresAt) {
      ticks.push({ dot, amount: dot.amountPerTick * dot.stacks });
      dot.nextTickAt += dot.intervalMs;
    }
    if (dot.expiresAt <= now) auras.dots.splice(i, 1);
  }
  return ticks;
}

export function applyStun(auras: CreatureAuras, durationMs: number, now: number, spellName = ""): void {
  if (now + durationMs >= auras.stunUntil) auras.stunSpell = spellName;
  auras.stunUntil = Math.max(auras.stunUntil, now + durationMs);
}

export function isStunned(auras: CreatureAuras, now: number): boolean {
  return auras.stunUntil > now;
}

export function applySlow(auras: CreatureAuras, id: string, pct: number, durationMs: number, now: number): void {
  const clamped = Math.min(99, Math.max(1, Math.floor(pct)));
  const existing = auras.slows.find((s) => s.id === id);
  if (existing) {
    existing.pct = clamped;
    existing.expiresAt = now + durationMs;
  } else {
    auras.slows.push({ id, pct: clamped, expiresAt: now + durationMs });
  }
}

/** Movement multiplier: the strongest active slow wins. */
export function slowMultiplier(auras: CreatureAuras, now: number): number {
  let strongest = 0;
  for (let i = auras.slows.length - 1; i >= 0; i--) {
    const s = auras.slows[i];
    if (s.expiresAt <= now) {
      auras.slows.splice(i, 1);
      continue;
    }
    strongest = Math.max(strongest, s.pct);
  }
  return 1 - strongest / 100;
}

export function applyCastLockout(auras: CreatureAuras, durationMs: number, now: number, spellName = ""): void {
  if (now + durationMs >= auras.castLockoutUntil) auras.lockoutSpell = spellName;
  auras.castLockoutUntil = Math.max(auras.castLockoutUntil, now + durationMs);
}

export function isCastLockedOut(auras: CreatureAuras, now: number): boolean {
  return auras.castLockoutUntil > now;
}

export interface AuraPayload {
  id: string;
  kind: "dot" | "hot" | "stun" | "slow" | "lockout";
  /** Spell name the client uses to look up the icon ("" when unknown). */
  spell: string;
  /** Debuffs get a red border on the client, buffs (HoTs) a blue one. */
  debuff: boolean;
  /** Icon URL, filled in by the caller that knows the spell data. */
  icon: string | null;
  remainingMs: number;
  stacks: number;
}

export function aurasPayload(auras: CreatureAuras, now: number, iconFor: (spell: string) => string | null = () => null): AuraPayload[] {
  const out: Array<Omit<AuraPayload, "icon">> = [];
  for (const d of auras.dots) {
    const hot = d.amountPerTick < 0;
    out.push({ id: d.id, kind: hot ? "hot" : "dot", spell: d.id, debuff: !hot, remainingMs: Math.max(0, d.expiresAt - now), stacks: d.stacks });
  }
  if (auras.stunUntil > now) out.push({ id: "stun", kind: "stun", spell: auras.stunSpell, debuff: true, remainingMs: auras.stunUntil - now, stacks: 1 });
  for (const s of auras.slows) {
    if (s.expiresAt > now) out.push({ id: s.id, kind: "slow", spell: s.id.replace(/^slow:/, ""), debuff: true, remainingMs: s.expiresAt - now, stacks: 1 });
  }
  if (auras.castLockoutUntil > now) out.push({ id: "lockout", kind: "lockout", spell: auras.lockoutSpell, debuff: true, remainingMs: auras.castLockoutUntil - now, stacks: 1 });
  return out.map((a) => ({ ...a, icon: a.spell ? iconFor(a.spell) : null }));
}
