import playerCache from "../services/playermanager";
import log from "../modules/logger";

type BroadcastStatsFn = (player: any) => void;
type BroadcastEffectsFn = (player: any) => void;

type SpellEffectResult = { absorb?: number };

type SpellEffectHandler = (params: {
  caster: any;
  target: any;
  spell: SpellData;
  effect: SpellEffect;
  broadcastStats: BroadcastStatsFn;
  broadcastEffects: BroadcastEffectsFn;
}) => SpellEffectResult | void;

interface BarrierInstance {
  id: string;
  spell: string;
  amount: number;
  duration: number;
  expiresAt: number;
  token: number;
}

const handlers: Record<string, SpellEffectHandler> = Object.create(null);

export function registerSpellEffect(type: string, handler: SpellEffectHandler) {
  handlers[type] = handler;
}

function getBarriers(player: any): BarrierInstance[] {
  if (!Array.isArray(player.barriers)) player.barriers = [];
  return player.barriers;
}

function recomputeAbsorbtion(player: any) {
  if (!player?.stats) return;
  const total = getBarriers(player).reduce((sum, b) => sum + Math.max(0, b.amount), 0);
  player.stats.absorbtion = total;
}

// Client buff-bar payload: only timed barriers (with an active timer) are shown.
export function getEffectsPayload(player: any) {
  const now = Date.now();
  return getBarriers(player)
    .filter((b) => b.amount > 0 && b.expiresAt > 0)
    .map((b) => ({
      id: b.id,
      spell: b.spell,
      duration: b.duration,
      remaining: Math.max(0, Math.ceil((b.expiresAt - now) / 1000)),
    }));
}

// Subtract incoming damage from active barriers (soonest-expiring first).
// Returns the amount absorbed. Depleted barriers are removed.
export function consumeBarrier(player: any, damage: number): number {
  if (!player?.stats || damage <= 0) return 0;
  const list = getBarriers(player);
  if (list.length === 0) {
    const legacy = Math.min(player.stats.absorbtion || 0, damage);
    player.stats.absorbtion = (player.stats.absorbtion || 0) - legacy;
    return legacy;
  }
  list.sort((a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity));
  let remaining = damage;
  let absorbed = 0;
  for (const b of list) {
    if (remaining <= 0) break;
    const take = Math.min(b.amount, remaining);
    b.amount -= take;
    remaining -= take;
    absorbed += take;
  }
  player.barriers = list.filter((b) => b.amount > 0);
  recomputeAbsorbtion(player);
  return absorbed;
}

export function clearBarriers(player: any) {
  player.barriers = [];
  if (player.stats) player.stats.absorbtion = 0;
}

let barrierToken = 0;

// Applies a barrier from a source spell. Different spells stack; the same spell
// refreshes its own barrier (amount + timer) instead of stacking a duplicate.
function applyBarrier(
  player: any,
  spellName: string,
  amount: number,
  durationSec: number,
  broadcastStats: BroadcastStatsFn,
  broadcastEffects: BroadcastEffectsFn
) {
  if (!player?.stats) return;
  const cap = player.stats.total_max_health || player.stats.max_health || amount;
  const cappedAmount = Math.min(cap, amount);

  const list = getBarriers(player);
  const token = ++barrierToken;
  const durationMs = durationSec > 0 ? durationSec * 1000 : 0;
  const expiresAt = durationMs > 0 ? Date.now() + durationMs : 0;

  const existing = list.find((b) => b.id === spellName);
  if (existing) {
    // Same source spell still active: top the barrier back up to full and refresh its timer
    // (do not stack a duplicate of the same spell).
    existing.amount = cappedAmount;
    existing.duration = durationSec;
    existing.expiresAt = expiresAt;
    existing.token = token;
  } else {
    list.push({ id: spellName, spell: spellName, amount: cappedAmount, duration: durationSec, expiresAt, token });
  }

  recomputeAbsorbtion(player);
  broadcastEffects(player);

  if (durationMs > 0) {
    setTimeout(() => {
      const fresh = playerCache.get(player.id);
      if (!fresh) return;
      const arr = getBarriers(fresh);
      // A recast bumps the token; a consumed barrier is already gone.
      const idx = arr.findIndex((b) => b.id === spellName && b.token === token);
      if (idx === -1) return;
      arr.splice(idx, 1);
      recomputeAbsorbtion(fresh);
      broadcastEffects(fresh);
      broadcastStats(fresh);
    }, durationMs);
  }
}

export function applySpellEffects(
  spell: SpellData,
  caster: any,
  target: any,
  broadcastStats: BroadcastStatsFn,
  broadcastEffects: BroadcastEffectsFn
): SpellEffectResult {
  const result: SpellEffectResult = {};
  if (!spell || !Array.isArray(spell.effects) || spell.effects.length === 0) return result;
  for (const effect of spell.effects) {
    if (!effect || !effect.type) continue;
    const handler = handlers[effect.type];
    if (!handler) continue;
    try {
      const r = handler({ caster, target, spell, effect, broadcastStats, broadcastEffects });
      if (r && typeof r.absorb === "number") {
        result.absorb = (result.absorb || 0) + r.absorb;
      }
    } catch (e) {
      log.error(`Spell effect handler '${effect.type}' failed: ${e}`);
    }
  }
  return result;
}

registerSpellEffect("absorbtion", ({ target, spell, effect, broadcastStats, broadcastEffects }) => {
  if (!target?.stats) return;
  const value = Number(effect.value) || 0;
  if (value <= 0) return;

  const durationSec = effect.duration && effect.duration > 0 ? effect.duration : 0;
  const spellName = spell?.name || "absorbtion";

  applyBarrier(target, spellName, value, durationSec, broadcastStats, broadcastEffects);

  return { absorb: value };
});

export default { registerSpellEffect, applySpellEffects, consumeBarrier, clearBarriers, getEffectsPayload };
