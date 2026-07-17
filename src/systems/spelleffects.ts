import playerCache from "../services/playermanager";
import mapIndex from "../services/mapindex";
import { packetManager } from "../socket/packet_manager";
import assetCache from "../services/assetCache";
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
}) => SpellEffectResult | void | Promise<SpellEffectResult | void>;

interface BarrierInstance {
  id: string;
  spell: string;
  amount: number;
  duration: number;
  expiresAt: number;
  token: number;
  particles: Particle[] | null;
}

// Lightweight visual-only effect (no gameplay impact, just particles)
interface VisualEffectInstance {
  id: string;
  spell: string;
  duration: number;
  expiresAt: number;
  token: number;
  particles: Particle[] | null;
}

const handlers: Record<string, SpellEffectHandler> = Object.create(null);

export function registerSpellEffect(type: string, handler: SpellEffectHandler) {
  handlers[type] = handler;
}

// Effect types that are harmful and may only be cast on hostile targets
const hostileEffectTypes = new Set<string>(["damage_over_time", "interrupt"]);

export function registerHostileEffectType(type: string) {
  hostileEffectTypes.add(type);
}

export function spellHasHostileEffects(spell: SpellData): boolean {
  if (!spell || !Array.isArray(spell.effects)) return false;
  return spell.effects.some((e) => e && hostileEffectTypes.has(e.type));
}

// Additional buff/debuff bar payload sources (e.g. DoTs) merged into getEffectsPayload
type EffectsPayloadProvider = (player: any) => any[];
const effectsPayloadProviders: EffectsPayloadProvider[] = [];

export function registerEffectsPayloadProvider(provider: EffectsPayloadProvider) {
  effectsPayloadProviders.push(provider);
}

function getBarriers(player: any): BarrierInstance[] {
  if (!Array.isArray(player.barriers)) player.barriers = [];
  return player.barriers;
}

function getVisuals(player: any): VisualEffectInstance[] {
  if (!Array.isArray(player.visualEffects)) player.visualEffects = [];
  return player.visualEffects;
}

function recomputeAbsorbtion(player: any) {
  if (!player?.stats) return;
  const total = getBarriers(player).reduce((sum, b) => sum + Math.max(0, b.amount), 0);
  player.stats.absorbtion = total;
}

// Resolve comma-separated particle names against the particle cache
async function resolveParticleNames(targetParticles: string | undefined): Promise<Particle[] | null> {
  if (!targetParticles) return null;
  const particleCache = await assetCache.get("particles") as Particle[] | null;
  if (!particleCache || particleCache.length === 0) return null;
  const names = targetParticles.split(",").map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return null;
  const resolved = names
    .map((name) => particleCache.find((p) => p.name && p.name.toLowerCase() === name.toLowerCase()))
    .filter((p): p is Particle => p != null);
  return resolved.length > 0 ? resolved : null;
}

export { resolveParticleNames };

// Client buff-bar payload: only timed barriers (with an active timer) are shown.
export function getEffectsPayload(player: any) {
  const now = Date.now();
  const payload = getBarriers(player)
    .filter((b) => b.amount > 0 && b.expiresAt > 0)
    .map((b) => ({
      id: b.id,
      spell: b.spell,
      duration: b.duration,
      remaining: Math.max(0, Math.ceil((b.expiresAt - now) / 1000)),
      particles: b.particles || null,
    })) as any[];
  for (const provider of effectsPayloadProviders) {
    try {
      const extra = provider(player);
      if (Array.isArray(extra) && extra.length > 0) payload.push(...extra);
    } catch (e) {
      log.error(`Effects payload provider failed: ${e}`);
    }
  }
  return payload;
}

// Broadcast a player's current effects to everyone on their map so effects
// (e.g. debuffs) can be rendered above the affected player's head.
export function broadcastEffectsUpdate(player: any) {  if (!player?.id) return;
  const packets = packetManager.effects({ id: player.id, effects: getEffectsPayload(player) });
  const map = player.location?.map;
  if (!map) {
    if (player.ws?.readyState === 1) {
      try {
        packets.forEach((pk: any) => player.ws.send(pk));
      } catch (e) {
        log.error(`Failed to send effects update: ${e}`);
      }
    }
    return;
  }
  const playerIds = mapIndex.getPlayersOnMap(map);
  for (const playerId of playerIds) {
    const p = playerCache.get(playerId);
    if (p?.ws?.readyState === 1) {
      try {
        packets.forEach((pk: any) => p.ws.send(pk));
      } catch (e) {
        log.error(`Failed to send effects update: ${e}`);
      }
    }
  }
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

let visualToken = 0;

async function applyVisualEffect(
  player: any,
  spellName: string,
  durationSec: number,
  resolveParticles: SpellEffect | null,
  broadcastEffects: BroadcastEffectsFn
) {
  if (!player?.stats) return;
  const durationMs = durationSec > 0 ? durationSec * 1000 : 0;
  if (durationMs <= 0) return;
  const expiresAt = Date.now() + durationMs;
  const token = ++visualToken;

  const particles = resolveParticles?.target_particles
    ? await resolveParticleNames(resolveParticles.target_particles)
    : null;

  const list = getVisuals(player);
  const existing = list.find((v) => v.id === `visual:${spellName}`);
  if (existing) {
    existing.duration = durationSec;
    existing.expiresAt = expiresAt;
    existing.token = token;
    existing.particles = particles;
  } else {
    list.push({
      id: `visual:${spellName}`,
      spell: spellName,
      duration: durationSec,
      expiresAt,
      token,
      particles,
    });
  }

  broadcastEffects(player);

  setTimeout(() => {
    const fresh = playerCache.get(player.id);
    if (!fresh) return;
    const arr = getVisuals(fresh);
    const idx = arr.findIndex((v) => v.id === `visual:${spellName}` && v.token === token);
    if (idx === -1) return;
    arr.splice(idx, 1);
    broadcastEffects(fresh);
  }, durationMs);
}

registerSpellEffect("visual", async ({ target, spell, effect, broadcastEffects }) => {
  if (!target?.stats) return;
  const durationSec = effect.duration && effect.duration > 0 ? effect.duration : 0;
  if (durationSec <= 0) return;
  await applyVisualEffect(target, spell?.name || "visual", durationSec, effect, broadcastEffects);
});

registerEffectsPayloadProvider((player: any) => {
  const now = Date.now();
  return getVisuals(player)
    .filter((v) => v.expiresAt > 0 && v.expiresAt > now)
    .map((v) => ({
      id: v.id,
      spell: v.spell,
      duration: v.duration,
      remaining: Math.max(0, Math.ceil((v.expiresAt - now) / 1000)),
      particles: v.particles || null,
      isVisual: true,
    }));
});

let barrierToken = 0;

// Applies a barrier from a source spell. Different spells stack; the same spell
// refreshes its own barrier (amount + timer) instead of stacking a duplicate.
async function applyBarrier(
  player: any,
  spell: SpellData,
  amount: number,
  durationSec: number,
  broadcastStats: BroadcastStatsFn,
  broadcastEffects: BroadcastEffectsFn
) {
  if (!player?.stats) return;
  const cap = player.stats.total_max_health || player.stats.max_health || amount;
  const cappedAmount = Math.min(cap, amount);

  const spellName = spell?.name || "absorbtion";
  const effect = Array.isArray(spell?.effects)
    ? spell.effects.find((e: SpellEffect) => e.type === "absorbtion")
    : null;
  const resolvedParticles = await resolveParticleNames(effect?.target_particles);

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
    existing.particles = resolvedParticles;
  } else {
    list.push({ id: spellName, spell: spellName, amount: cappedAmount, duration: durationSec, expiresAt, token, particles: resolvedParticles });
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

export async function applySpellEffects(
  spell: SpellData,
  caster: any,
  target: any,
  broadcastStats: BroadcastStatsFn,
  broadcastEffects: BroadcastEffectsFn
): Promise<SpellEffectResult> {
  const result: SpellEffectResult = {};
  if (!spell || !Array.isArray(spell.effects) || spell.effects.length === 0) return result;
  for (const effect of spell.effects) {
    if (!effect || !effect.type) continue;
    const handler = handlers[effect.type];
    if (!handler) continue;
    try {
      const r = await handler({ caster, target, spell, effect, broadcastStats, broadcastEffects });
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
  applyBarrier(target, spell, value, durationSec, broadcastStats, broadcastEffects);

  return { absorb: value };
});

export default { registerSpellEffect, applySpellEffects, consumeBarrier, clearBarriers, getEffectsPayload, registerEffectsPayloadProvider, registerHostileEffectType, spellHasHostileEffects, broadcastEffectsUpdate };
