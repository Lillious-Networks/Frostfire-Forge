import playerCache from "../services/playermanager";
import entityCache from "../services/entityCache";
import mapIndex from "../services/mapindex";
import entityAI from "./entityAI";
import { registerSpellEffect, registerEffectsPayloadProvider, consumeBarrier, broadcastEffectsUpdate, resolveParticleNames } from "./spelleffects";
import { packetManager } from "../socket/packet_manager";
import { getSpriteUrl } from "../modules/spriteSheetManager";
import { listener } from "../modules/event_bus";
import { Events } from "./events";
import log from "../modules/logger";

interface DotInstance {
  id: string;
  spell: string;
  icon: string | null;
  casterId: string;
  casterUsername: string;
  damagePerTick: number;
  interval: number;
  duration: number;
  stackable: boolean;
  maxStacks: number;
  stacks: number;
  expiresAt: number;
  nextTickAt: number;
  particles: Particle[] | null;
}

const DEFAULT_MAX_STACKS = 5;
const SCHEDULER_INTERVAL_MS = 250;

const playerDots = new Map<string, DotInstance[]>();
const entityDots = new Map<string | number, DotInstance[]>();

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

type PlayerDeathHandler = (target: any, killer: any, info: { damage: number; isCrit: boolean }) => Promise<void>;
let playerDeathHandler: PlayerDeathHandler | null = null;

export function setPlayerDeathHandler(fn: PlayerDeathHandler) {
  playerDeathHandler = fn;
}

function sendPacket(ws: any, packets: any[]) {
  if (!ws || !ws.send || ws.readyState !== 1) return;
  try {
    packets.forEach((packet) => ws.send(packet));
  } catch (error) {
    log.error(`Failed to send packet: ${error}`);
  }
}

function broadcastToMap(map: string, packets: any[]) {
  if (!map) return;
  const playerIds = mapIndex.getPlayersOnMap(map);
  for (const playerId of playerIds) {
    const p = playerCache.get(playerId);
    if (p?.ws) sendPacket(p.ws, packets);
  }
}

function sendEffectsToTarget(target: any) {
  broadcastEffectsUpdate(target);
}

function ensureScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(processDotTicks, SCHEDULER_INTERVAL_MS);
}

function stopSchedulerIfIdle() {
  if (playerDots.size === 0 && entityDots.size === 0 && schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

function isEntityTarget(target: any): boolean {
  return target?.aggro_type !== undefined && target?.health !== undefined && !target?.stats;
}

export async function applyDot(caster: any, target: any, spell: SpellData, effect: SpellEffect) {
  const valuePerTick = Math.floor(Number(effect.value) || 0);
  const durationSec = Number(effect.duration) || 0;
  const intervalSec = Number(effect.interval) || 1;
  if (valuePerTick === 0 || durationSec <= 0 || intervalSec <= 0) return;

  const spellName = spell?.name || "damage_over_time";
  const stackable = effect.stackable === true;
  const maxStacks = stackable ? Math.max(1, Number(effect.max_stacks) || DEFAULT_MAX_STACKS) : 1;
  const now = Date.now();

  const resolvedParticles = await resolveParticleNames(effect.target_particles);

  const entity = isEntityTarget(target);
  const key = entity ? target.id : String(target.id);
  const store = entity ? entityDots : playerDots;
  let list = store.get(key);
  if (!list) {
    list = [];
    store.set(key, list);
  }

  const existing = list.find((d) => d.id === spellName);
  if (existing) {
    // Shared timer: reapplying refreshes the duration; stackable
    // DoTs also increment the stack count up to their cap.
    // The tick schedule is preserved so reapplying never delays the next tick.
    existing.stacks = stackable ? Math.min(existing.stacks + 1, maxStacks) : 1;
    existing.damagePerTick = valuePerTick;
    existing.interval = intervalSec;
    existing.duration = durationSec;
    existing.expiresAt = now + durationSec * 1000;
    existing.casterId = String(caster?.id ?? existing.casterId);
    existing.casterUsername = caster?.username || existing.casterUsername;
    if (resolvedParticles) existing.particles = resolvedParticles;
  } else {
    list.push({
      id: spellName,
      spell: spellName,
      icon: getSpriteUrl(spell?.icon || null),
      casterId: String(caster?.id ?? ""),
      casterUsername: caster?.username || "",
      damagePerTick: valuePerTick,
      interval: intervalSec,
      duration: durationSec,
      stackable,
      maxStacks,
      stacks: 1,
      expiresAt: now + durationSec * 1000,
      nextTickAt: now + intervalSec * 1000,
      particles: resolvedParticles,
    });
  }

  ensureScheduler();
  if (!entity) sendEffectsToTarget(target);
}

export function clearDots(targetId: string | number) {  const key = String(targetId);
  if (playerDots.delete(key)) {
    const target = playerCache.get(key);
    if (target) sendEffectsToTarget(target);
  }
  stopSchedulerIfIdle();
}

export function clearEntityDots(entityId: string | number) {
  entityDots.delete(entityId);
  stopSchedulerIfIdle();
}

export function getDotsPayload(player: any) {
  const list = playerDots.get(String(player?.id));
  if (!list || list.length === 0) return [];
  const now = Date.now();
  return list
    .filter((d) => d.expiresAt > now)
    .map((d) => ({
      id: `dot:${d.spell}`,
      spell: d.spell,
      icon: d.icon,
      duration: d.duration,
      remaining: Math.max(0, Math.ceil((d.expiresAt - now) / 1000)),
      interval: d.interval,
      stacks: d.stacks,
      value: Math.abs(d.damagePerTick),
      particles: d.particles || null,
      isDebuff: d.damagePerTick > 0,
    }));
}

async function tickPlayerDot(targetKey: string, dot: DotInstance): Promise<boolean> {
  const target = playerCache.get(targetKey);
  if (!target?.stats || target.stats.health <= 0) return false;

  const caster = playerCache.get(dot.casterId);
  const isHeal = dot.damagePerTick < 0;
  const amount = Math.abs(dot.damagePerTick) * dot.stacks;

  if (isHeal) {
    target.stats.health = Math.round(Math.min(target.stats.health + amount, target.stats.total_max_health));
    broadcastToMap(target.location?.map, packetManager.updateStats({
      id: dot.casterId,
      target: target.id,
      stats: target.stats,
      isCrit: false,
      damage: -amount,
    }));
    return true;
  }

  // Avoidance check — DoT ticks can be dodged like direct damage
  let damage = amount;
  const targetAvoidance = target.stats?.stat_avoidance || 0;
  if (Math.random() * 100 < targetAvoidance) {
    damage = 0;
  }

  // Armor mitigation
  if (damage > 0) {
    const targetArmor = target.stats?.stat_armor || 0;
    damage = Math.floor(damage * (1 - Math.min(targetArmor, 75) / 100));
  }

  const absorbed = consumeBarrier(target, damage);
  const damageToHealth = damage - absorbed;
  if (absorbed > 0) sendEffectsToTarget(target);

  target.stats.health = Math.round(target.stats.health - damageToHealth);

  listener.emit(Events.PLAYER_DAMAGED, { attacker: caster || null, target, damage, isCrit: false });

  if (caster && caster.id !== target.id) {
    target.pvp = true;
    target.last_attack = performance.now();
    caster.pvp = true;
    caster.last_attack = performance.now();
  }

  if (target.stats.health <= 0) {
    playerDots.delete(targetKey);
    if (playerDeathHandler) {
      try {
        await playerDeathHandler(target, caster || null, { damage, isCrit: false });
      } catch (e) {
        log.error(`DoT death handler failed: ${e}`);
      }
    } else {
      target.stats.health = 1;
    }
    return false;
  }

  broadcastToMap(target.location?.map, packetManager.updateStats({
    id: dot.casterId,
    target: target.id,
    stats: target.stats,
    isCrit: false,
    damage,
  }));
  return true;
}

function tickEntityDot(entityKey: string | number, dot: DotInstance): boolean {
  const entity: any = entityCache.getById(entityKey as number);
  if (!entity || entity.health <= 0) {
    entityDots.delete(entityKey);
    return false;
  }

  const caster = playerCache.get(dot.casterId);
  const damage = dot.damagePerTick * dot.stacks;

  if (caster) {
    entityAI.applyDamageToEntity(entity, damage, caster);
  } else {
    entity.health = Math.max(0, entity.health - damage);
  }

  if (entity.health < 0) entity.health = 0;
  entityCache.updateHealth(entity.id, entity.health);

  broadcastToMap(entity.map, packetManager.updateStats({
    id: dot.casterId,
    target: entity.id,
    stats: { health: entity.health, total_max_health: entity.max_health },
    isCrit: false,
    damage,
    entity: true,
  }));

  if (entity.health <= 0) {
    const respawnTime = 30;
    broadcastToMap(entity.map, packetManager.despawnEntity(entity.id, respawnTime));
    entityCache.remove(entity.id);
    entityDots.delete(entityKey);
    return false;
  }
  return true;
}

async function processDotTicks() {
  const now = Date.now();

  for (const [key, list] of playerDots) {
    if (!playerCache.get(key)) {
      playerDots.delete(key);
      continue;
    }
    let changed = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const dot = list[i];
      if (dot.nextTickAt <= now && dot.expiresAt >= dot.nextTickAt) {
        dot.nextTickAt += dot.interval * 1000;
        const alive = await tickPlayerDot(key, dot);
        if (!alive) break;
      }
      if (dot.expiresAt <= now) {
        list.splice(i, 1);
        changed = true;
      }
    }
    if (playerDots.has(key) && list.length === 0) {
      playerDots.delete(key);
      changed = true;
    }
    if (changed) {
      const target = playerCache.get(key);
      if (target) sendEffectsToTarget(target);
    }
  }

  for (const [key, list] of entityDots) {
    for (let i = list.length - 1; i >= 0; i--) {
      const dot = list[i];
      if (dot.nextTickAt <= now && dot.expiresAt >= dot.nextTickAt) {
        dot.nextTickAt += dot.interval * 1000;
        const alive = tickEntityDot(key, dot);
        if (!alive) break;
      }
      if (dot.expiresAt <= now) {
        list.splice(i, 1);
      }
    }
    if (entityDots.has(key) && list.length === 0) {
      entityDots.delete(key);
    }
  }

  stopSchedulerIfIdle();
}

registerEffectsPayloadProvider(getDotsPayload);

registerSpellEffect("damage_over_time", ({ caster, target, spell, effect }) => {
  if (!target) return;
  applyDot(caster, target, spell, effect);
});

registerSpellEffect("heal_over_time", ({ caster, target, spell, effect }) => {
  if (!target) return;
  // Healing uses negative damage internally; force the value negative
  // so the payload renders as a buff (isDebuff: false).
  const healEffect = { ...effect, value: -Math.abs(Number(effect.value) || 0) };
  applyDot(caster, target, spell, healEffect);
});

export default { applyDot, clearDots, clearEntityDots, getDotsPayload, setPlayerDeathHandler };
