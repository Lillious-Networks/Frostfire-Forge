import { linkCalls } from "./linkcalls";

// APPLY_EFFECT (spec §4): a change to an entity this node does not own goes to
// its owner, which checks it and applies it, and answers what happened. Each
// op has one applier, registered by the module that owns that kind of entity.
// The answer of an APPLY_EFFECT call is its EFFECT_RESULT.

export type EffectOp = "creature_hit" | "creature_threat" | "creature_on_player" | "player_hit";
/** `stats` and `absorb` come with a player_hit that landed: the caster's node shows the damage numbers from them. */
export type EffectResult = { outcome: "applied" | "killed" | "refused" | "missing"; reason?: string; stats?: unknown; absorb?: number };
export type Effect = { op: EffectOp; target: string | number; body: unknown };
export type EffectApplier = (target: string | number, body: any, from: string) => EffectResult | Promise<EffectResult>;

const appliers = new Map<EffectOp, EffectApplier>();

/** The applier of `op` here. Throws on a second one; the returned function removes this one. */
export function onApplyEffect(op: EffectOp, fn: EffectApplier): () => void {
  if (appliers.has(op)) throw new Error(`Effect ${op} already has an applier`);
  appliers.set(op, fn);
  return () => { if (appliers.get(op) === fn) appliers.delete(op); };
}

/**
 * Tests only: replaces the applier of `op` (or clears it with null) and returns a function that puts
 * the previous one back. Modules register their real ops at load, and every test file shares one
 * process, so a test that needs an op of its own swaps it rather than registering a second applier.
 */
export function swapApplierForTest(op: EffectOp, fn: EffectApplier | null): () => void {
  const previous = appliers.get(op);
  if (fn) appliers.set(op, fn);
  else appliers.delete(op);
  return () => {
    if (previous) appliers.set(op, previous);
    else appliers.delete(op);
  };
}

// Registered once at load; it runs only when the links are attached (the cluster is on).
linkCalls.handle("APPLY_EFFECT", (effect: Effect, from: string): EffectResult | Promise<EffectResult> => {
  const fn = effect && appliers.get(effect.op);
  return fn ? fn(effect.target, effect.body, from) : { outcome: "missing" };
});

/** Send `effect` to its owner `peer`. Null when the link is down, the call timed out, or the owner failed. */
export async function sendEffect(peer: string, effect: Effect): Promise<EffectResult | null> {
  const outcome = await linkCalls.call<EffectResult>(peer, "APPLY_EFFECT", effect);
  return outcome.ok ? outcome.answer : null;
}
