import playerCache from "../services/playermanager";
import mapIndex from "../services/mapindex";
import { packetManager } from "../socket/packet_manager";
import assetCache from "../services/assetCache";
import { getSpriteUrl } from "../modules/spriteSheetManager";
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
  icon: string | null;
}

// Lightweight visual-only effect (no gameplay impact, just particles)
interface VisualEffectInstance {
  id: string;
  spell: string;
  duration: number;
  expiresAt: number;
  token: number;
  particles: Particle[] | null;
  icon: string | null;
}

const handlers: Record<string, SpellEffectHandler> = Object.create(null);

export function registerSpellEffect(type: string, handler: SpellEffectHandler) {
  handlers[type] = handler;
}

// Effect types that are harmful and may only be cast on hostile targets
const hostileEffectTypes = new Set<string>(["damage_over_time", "interrupt", "stun", "slow"]);

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
      icon: b.icon || null,
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
    if (!p || p.id === player.id) continue;
    // Vanished players' effects are only visible to admins and party
    if (player.isVanished && !p.isAdmin && !p.party?.includes(player.username)) continue;
    if (p?.ws?.readyState === 1) {
      try {
        packets.forEach((pk: any) => p.ws.send(pk));
      } catch (e) {
        log.error(`Failed to send effects update: ${e}`);
      }
    }
  }
  // Always send to the player themselves
  if (player.ws?.readyState === 1) {
    try { packets.forEach((pk: any) => player.ws.send(pk)); } catch (e) { log.error(`Failed to send effects update: ${e}`); }
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
  broadcastEffects: BroadcastEffectsFn,
  iconUrl: string | null = null
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
    existing.icon = iconUrl;
  } else {
    list.push({
      id: `visual:${spellName}`,
      spell: spellName,
      duration: durationSec,
      expiresAt,
      token,
      particles,
      icon: iconUrl,
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
  await applyVisualEffect(target, spell?.name || "visual", durationSec, effect, broadcastEffects, getSpriteUrl(spell.icon));
});

// Stun effect: target cannot move or cast for the effect's duration.
// Multiple stuns from the same spell refresh the duration; different spells stack.
const playerStuns = new Map<string, Array<{ id: string; spell: string; duration: number; expiresAt: number; token: number; particles: Particle[] | null; icon: string | null }>>();
let stunToken = 0;

function getStuns(player: any) {
  const key = String(player.id);
  if (!playerStuns.has(key)) playerStuns.set(key, []);
  return playerStuns.get(key)!;
}

registerSpellEffect("stun", async ({ target, spell, effect, broadcastEffects }) => {
  if (!target?.stats) return;
  const durationSec = effect.duration && effect.duration > 0 ? effect.duration : 0;
  if (durationSec <= 0) return;

  const spellName = spell?.name || "stun";
  const id = `stun:${spellName}`;
  const token = ++stunToken;
  const expiresAt = Date.now() + durationSec * 1000;
  const particles = effect.target_particles ? await resolveParticleNames(effect.target_particles) : null;

  const list = getStuns(target);
  const existing = list.find((s) => s.id === id);
  if (existing) {
    existing.duration = durationSec;
    existing.expiresAt = expiresAt;
    existing.token = token;
    if (particles) existing.particles = particles;
    existing.icon = getSpriteUrl(spell.icon);
  } else {
    list.push({ id, spell: spellName, duration: durationSec, expiresAt, token, particles, icon: getSpriteUrl(spell.icon) });
  }

  // Update the hard-CC flag on the player; the longest stun wins
  const maxExpiry = Math.max(...list.map((s) => s.expiresAt));
  target.stunnedUntil = Math.max(target.stunnedUntil || 0, maxExpiry);

  broadcastEffects(target);

  // Grey out the hotbar while stunned (same visual as interrupt lockout)
  if (target.ws?.readyState === 1) {
    try {
      packetManager.spellLockout({ duration: durationSec }).forEach((pk: any) => target.ws.send(pk));
    } catch (e) { /* ignore */ }
  }

  setTimeout(() => {
    const fresh = playerCache.get(target.id);
    if (!fresh) return;
    const arr = getStuns(fresh);
    const idx = arr.findIndex((s) => s.id === id && s.token === token);
    if (idx === -1) return;
    arr.splice(idx, 1);
    fresh.stunnedUntil = arr.length > 0 ? Math.max(...arr.map((s) => s.expiresAt)) : 0;
    // Update lockout to match remaining stun time, or clear it
    if (fresh.ws?.readyState === 1) {
      try {
        const remaining = fresh.stunnedUntil ? Math.max(0, Math.ceil((fresh.stunnedUntil - Date.now()) / 1000)) : 0;
        packetManager.spellLockout({ duration: remaining }).forEach((pk: any) => fresh.ws.send(pk));
      } catch (e) { /* ignore */ }
    }
    broadcastEffects(fresh);
  }, durationSec * 1000);
});

// Stun payload provider: shows active stuns as debuffs in the EFFECTS packet
registerEffectsPayloadProvider((player: any) => {
  const now = Date.now();
  return getStuns(player)
    .filter((s) => s.expiresAt > 0 && s.expiresAt > now)
    .map((s) => ({
      id: s.id,
      spell: s.spell,
      duration: s.duration,
      remaining: Math.max(0, Math.ceil((s.expiresAt - now) / 1000)),
      icon: s.icon || null,
      particles: s.particles || null,
      isDebuff: true,
    }));
});

// Export for clearing stuns on death/disconnect
export function clearStuns(playerId: string | number) {
  playerStuns.delete(String(playerId));
}

// Vanish effect: target becomes invisible to all players except admins
// and party members. No name color change (unlike admin stealth).
const playerVanishes = new Map<string, Array<{ id: string; spell: string; duration: number; expiresAt: number; token: number; particles: Particle[] | null; icon: string | null }>>();
let vanishToken = 0;

function getVanishes(player: any) {
  const key = String(player.id);
  if (!playerVanishes.has(key)) playerVanishes.set(key, []);
  return playerVanishes.get(key)!;
}

registerSpellEffect("vanish", async ({ target, spell, effect, broadcastEffects }) => {
  if (!target?.stats) return;
  const durationSec = effect.duration ? Number(effect.duration) : 0;
  const isPermanent = durationSec <= 0;

  const spellName = spell?.name || "vanish";
  const id = `vanish:${spellName}`;
  const token = ++vanishToken;
  const expiresAt = isPermanent ? Number.MAX_SAFE_INTEGER : Date.now() + durationSec * 1000;
  const particles = effect.target_particles ? await resolveParticleNames(effect.target_particles) : null;

  const list = getVanishes(target);
  const existing = list.find((v) => v.id === id);
  if (existing) {
    existing.duration = durationSec;
    existing.expiresAt = expiresAt;
    existing.token = token;
    if (particles) existing.particles = particles;
    existing.icon = getSpriteUrl(spell.icon);
  } else {
    list.push({ id, spell: spellName, duration: durationSec, expiresAt, token, particles, icon: getSpriteUrl(spell.icon) });
  }

  target.isVanished = true;

  broadcastEffects(target);

  if (!isPermanent) {
    setTimeout(() => {
      const fresh = playerCache.get(target.id);
      if (!fresh) return;
      const arr = getVanishes(fresh);
      const idx = arr.findIndex((v) => v.id === id && v.token === token);
      if (idx === -1) return;
      arr.splice(idx, 1);
      fresh.isVanished = arr.length > 0;
      if (!fresh.isVanished && onVanishRemoved) onVanishRemoved(fresh);
      broadcastEffects(fresh);
    }, durationSec * 1000);
  }
});

registerEffectsPayloadProvider((player: any) => {
  const now = Date.now();
  return getVanishes(player)
    .filter((v) => v.expiresAt > 0 && v.expiresAt > now)
    .map((v) => ({
      id: v.id,
      spell: v.spell,
      duration: v.duration,
      remaining: Math.max(0, Math.ceil((v.expiresAt - now) / 1000)),
      icon: v.icon || null,
      particles: v.particles || null,
      isDebuff: false,
    }));
});

export function clearVanishes(playerId: string | number) {
  playerVanishes.delete(String(playerId));
}

export function getVanishedEffectId(player: any): string | null {
  const vanishes = getVanishes(player);
  return vanishes.length > 0 ? vanishes[0].id : null;
}

// Callback invoked when vanish ends (timer or cancel). Receiver registers
// a respawn handler.
let onVanishRemoved: ((player: any) => void | Promise<void>) | null = null;
export function setVanishRemovedHandler(fn: (player: any) => void | Promise<void>) {
  onVanishRemoved = fn;
}

// Remove a buff from all effect stores by ID. Used for right-click buff removal.
export function cancelEffect(player: any, effectId: string): boolean {
  if (!player) return false;
  let removed = false;

  // Barriers
  const barriers = getBarriers(player);
  const bIdx = barriers.findIndex((b) => b.id === effectId);
  if (bIdx !== -1) {
    barriers.splice(bIdx, 1);
    recomputeAbsorbtion(player);
    removed = true;
  }

  // Visual effects
  const visuals = getVisuals(player);
  const vIdx = visuals.findIndex((v) => v.id === effectId);
  if (vIdx !== -1) { visuals.splice(vIdx, 1); removed = true; }

  // Stuns
  const stuns = getStuns(player);
  const sIdx = stuns.findIndex((s) => s.id === effectId);
  if (sIdx !== -1) {
    stuns.splice(sIdx, 1);
    player.stunnedUntil = stuns.length > 0 ? Math.max(...stuns.map((s) => s.expiresAt)) : 0;
    removed = true;
  }

  // Slows
  const slows = getSlows(player);
  const slIdx = slows.findIndex((s) => s.id === effectId);
  if (slIdx !== -1) {
    slows.splice(slIdx, 1);
    if (slows.length === 0) { player.slowPercent = 0; player.slowMultiplier = 1; }
    else { const strongest = Math.max(...slows.map((s) => s.slowPercent)); player.slowPercent = strongest; player.slowMultiplier = 1 - strongest / 100; }
    removed = true;
  }

  // Vanishes
  const vanishes = getVanishes(player);
  const vaIdx = vanishes.findIndex((v) => v.id === effectId);
  if (vaIdx !== -1) {
    vanishes.splice(vaIdx, 1);
    const wasVanished = player.isVanished;
    player.isVanished = vanishes.length > 0;
    if (wasVanished && !player.isVanished && onVanishRemoved) onVanishRemoved(player);
    removed = true;
  }

  return removed;
}

// Slow effect: target's movement speed is reduced for the effect's duration.
// value = slow percentage (e.g. 50 = 50% slower, so 50% of normal speed).
// Multiple slows: the strongest (highest percentage) wins.
const playerSlows = new Map<string, Array<{ id: string; spell: string; duration: number; slowPercent: number; expiresAt: number; token: number; particles: Particle[] | null; icon: string | null }>>();
let slowToken = 0;

function getSlows(player: any) {
  const key = String(player.id);
  if (!playerSlows.has(key)) playerSlows.set(key, []);
  return playerSlows.get(key)!;
}

registerSpellEffect("slow", async ({ target, spell, effect, broadcastEffects }) => {
  if (!target?.stats) return;
  const durationSec = effect.duration && effect.duration > 0 ? effect.duration : 0;
  const slowPercent = Math.min(99, Math.max(1, Math.floor(Number(effect.value) || 1)));
  if (durationSec <= 0) return;

  const spellName = spell?.name || "slow";
  const id = `slow:${spellName}`;
  const token = ++slowToken;
  const expiresAt = Date.now() + durationSec * 1000;
  const particles = effect.target_particles ? await resolveParticleNames(effect.target_particles) : null;

  const list = getSlows(target);
  const existing = list.find((s) => s.id === id);
  if (existing) {
    existing.duration = durationSec;
    existing.slowPercent = slowPercent;
    existing.expiresAt = expiresAt;
    existing.token = token;
    if (particles) existing.particles = particles;
    existing.icon = getSpriteUrl(spell.icon);
  } else {
    list.push({ id, spell: spellName, duration: durationSec, slowPercent, expiresAt, token, particles, icon: getSpriteUrl(spell.icon) });
  }

  // Strongest slow wins for the movement multiplier
  const strongest = Math.max(...list.map((s) => s.slowPercent));
  target.slowPercent = strongest;
  target.slowMultiplier = 1 - strongest / 100;

  broadcastEffects(target);

  setTimeout(() => {
    const fresh = playerCache.get(target.id);
    if (!fresh) return;
    const arr = getSlows(fresh);
    const idx = arr.findIndex((s) => s.id === id && s.token === token);
    if (idx === -1) return;
    arr.splice(idx, 1);
    if (arr.length === 0) {
      fresh.slowPercent = 0;
      fresh.slowMultiplier = 1;
    } else {
      const strongest2 = Math.max(...arr.map((s) => s.slowPercent));
      fresh.slowPercent = strongest2;
      fresh.slowMultiplier = 1 - strongest2 / 100;
    }
    broadcastEffects(fresh);
  }, durationSec * 1000);
});

registerEffectsPayloadProvider((player: any) => {
  const now = Date.now();
  return getSlows(player)
    .filter((s) => s.expiresAt > 0 && s.expiresAt > now)
    .map((s) => ({
      id: s.id,
      spell: s.spell,
      duration: s.duration,
      remaining: Math.max(0, Math.ceil((s.expiresAt - now) / 1000)),
      value: s.slowPercent,
      icon: s.icon || null,
      particles: s.particles || null,
      isDebuff: true,
    }));
});

export function clearSlows(playerId: string | number) {
  playerSlows.delete(String(playerId));
}

registerEffectsPayloadProvider((player: any) => {
  const now = Date.now();
  return getVisuals(player)
    .filter((v) => v.expiresAt > 0 && v.expiresAt > now)
    .map((v) => ({
      id: v.id,
      spell: v.spell,
      duration: v.duration,
      remaining: Math.max(0, Math.ceil((v.expiresAt - now) / 1000)),
      icon: v.icon || null,
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
    existing.icon = getSpriteUrl(spell.icon);
  } else {
    list.push({ id: spellName, spell: spellName, amount: cappedAmount, duration: durationSec, expiresAt, token, particles: resolvedParticles, icon: getSpriteUrl(spell.icon) });
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

export default { registerSpellEffect, applySpellEffects, consumeBarrier, clearBarriers, clearStuns, clearSlows, clearVanishes, cancelEffect, setVanishRemovedHandler, getVanishedEffectId, getEffectsPayload, registerEffectsPayloadProvider, registerHostileEffectType, spellHasHostileEffects, broadcastEffectsUpdate };
