import playerCache from "../services/playermanager";
import entityCache from "../services/entityCache";
import mapIndex from "../services/mapindex";
import entityAI from "./entityAI";
import { consumeBarrier, broadcastEffectsUpdate, applySpellEffects, cancelEffect, getVanishedEffectId } from "./spelleffects";
import { packetManager } from "../socket/packet_manager";
import log from "../modules/logger";

export interface GroundAoeZone {
  id: string;
  spellId: number;
  spellName: string;
  casterId: string;
  casterUsername: string;
  mapName: string;
  position: { x: number; y: number };
  radius: number;
  duration: number;
  tickInterval: number;
  damagePerTick: number;
  damageType: "damage" | "heal";
  particles: string[] | null;
  effects: any[] | null;
  spell: any;
  createdAt: number;
  expiresAt: number;
  nextTickAt: number;
}

const SCHEDULER_INTERVAL_MS = 250;
let schedulerInterval: ReturnType<typeof setInterval> | null = null;

const zonesByMap = new Map<string, GroundAoeZone[]>();
let zoneIdCounter = 0;

let playerDeathHandler: ((player: any, attacker: any, damageInfo: { damage: number; isCrit: boolean }) => Promise<void>) | null = null;

export function setPlayerDeathHandler(handler: typeof playerDeathHandler) {
  playerDeathHandler = handler;
}

function broadcastToMap(map: string, packets: any[]) {
  if (!map) return;
  const playerIds = mapIndex.getPlayersOnMap(map);
  for (const playerId of playerIds) {
    const player = playerCache.get(playerId);
    if (player) {
      for (const p of packets) {
        if (Array.isArray(p)) {
          for (const sub of p) {
            player.ws.send(sub);
          }
        } else {
          player.ws.send(p);
        }
      }
    }
  }
}

function generateZoneId(): string {
  zoneIdCounter++;
  return `groundaoe_${zoneIdCounter}_${Date.now()}`;
}

export function spawnZone(zoneData: {
  spellId: number;
  spellName: string;
  casterId: string;
  casterUsername: string;
  mapName: string;
  position: { x: number; y: number };
  radius: number;
  duration: number;
  tickInterval: number;
  damagePerTick: number;
  damageType: "damage" | "heal";
  particles: string[] | null;
  effects: any[] | null;
  spell: any;
}): GroundAoeZone {
  const now = Date.now();
  const durationMs = zoneData.duration * 1000;
  const tickIntervalMs = (zoneData.tickInterval || 1) * 1000;

  const zone: GroundAoeZone = {
    id: generateZoneId(),
    spellId: zoneData.spellId,
    spellName: zoneData.spellName,
    casterId: zoneData.casterId,
    casterUsername: zoneData.casterUsername,
    mapName: zoneData.mapName,
    position: zoneData.position,
    radius: zoneData.radius,
    duration: durationMs,
    tickInterval: tickIntervalMs,
    damagePerTick: zoneData.damagePerTick,
    damageType: zoneData.damageType,
    particles: zoneData.particles,
    effects: zoneData.effects,
    spell: zoneData.spell,
    createdAt: now,
    expiresAt: now + durationMs,
    nextTickAt: now + tickIntervalMs,
  };

  if (!zonesByMap.has(zone.mapName)) {
    zonesByMap.set(zone.mapName, []);
  }
  zonesByMap.get(zone.mapName)!.push(zone);

  broadcastToMap(zone.mapName, packetManager.groundAoeSpawn({
    id: zone.id,
    spell: zone.spellName,
    casterId: zone.casterId,
    x: zone.position.x,
    y: zone.position.y,
    radius: zone.radius,
    duration: zoneData.duration,
    damageType: zone.damageType,
    particles: zone.particles,
    casterUsername: zone.casterUsername,
  }));

  startScheduler();

  return zone;
}

export function removeZone(zoneId: string): boolean {
  let found = false;
  for (const [mapName, zones] of zonesByMap.entries()) {
    const idx = zones.findIndex((z) => z.id === zoneId);
    if (idx !== -1) {
      zones.splice(idx, 1);
      if (zones.length === 0) {
        zonesByMap.delete(mapName);
      }
      broadcastToMap(mapName, packetManager.groundAoeDespawn({ id: zoneId }));
      found = true;
      break;
    }
  }
  if (found && getTotalZoneCount() === 0) {
    stopScheduler();
  }
  return found;
}

export function clearZonesForMap(mapName: string): void {
  const zones = zonesByMap.get(mapName);
  if (zones && zones.length > 0) {
    for (const zone of zones) {
      broadcastToMap(mapName, packetManager.groundAoeDespawn({ id: zone.id }));
    }
  }
  zonesByMap.delete(mapName);
  if (getTotalZoneCount() === 0) {
    stopScheduler();
  }
}

export function getZonesOnMap(mapName: string): GroundAoeZone[] {
  return zonesByMap.get(mapName) || [];
}

export function getAllZones(): GroundAoeZone[] {
  const all: GroundAoeZone[] = [];
  for (const zones of zonesByMap.values()) {
    all.push(...zones);
  }
  return all;
}

function getTotalZoneCount(): number {
  let count = 0;
  for (const zones of zonesByMap.values()) {
    count += zones.length;
  }
  return count;
}

function startScheduler(): void {
  if (schedulerInterval) return;
  schedulerInterval = setInterval(() => {
    processZoneTicks().catch((err) => {
      log.error(`GroundAoe tick error: ${err}`);
    });
  }, SCHEDULER_INTERVAL_MS);
}

function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

async function processZoneTicks(): Promise<void> {
  const now = Date.now();
  const zonesToRemove: string[] = [];

  for (const [mapName, zones] of zonesByMap.entries()) {
    for (let i = zones.length - 1; i >= 0; i--) {
      const zone = zones[i];

      if (now >= zone.expiresAt) {
        zonesToRemove.push(zone.id);
        continue;
      }

      if (zone.nextTickAt <= now) {
        zone.nextTickAt += zone.tickInterval;

        const caster = playerCache.get(zone.casterId);
        const isHeal = zone.damageType === "heal";

        const playerIds = mapIndex.getPlayersOnMap(mapName);
        const affectedPlayers: any[] = [];
        for (const playerId of playerIds) {
          const player = playerCache.get(playerId);
          if (!player || player.isGuest) continue;
          const pPos = player.location?.position;
          if (!pPos) continue;
          const dist = Math.sqrt((pPos.x - zone.position.x) ** 2 + (pPos.y - zone.position.y) ** 2);
          if (dist > zone.radius) continue;

          const inParty = caster?.party?.includes(player.username) || false;

          if (isHeal) {
            if (player.id !== zone.casterId && !inParty) continue;
          } else {
            if (player.id === zone.casterId || inParty) continue;
          }
          affectedPlayers.push(player);
        }

        const mapEntities = entityCache.getByMap(mapName);
        for (const entity of mapEntities) {
          if (isHeal) continue;
          if (entity.aggro_type === "friendly") continue;
          const ePos = entity.position;
          if (!ePos) continue;
          const dist = Math.sqrt((ePos.x - zone.position.x) ** 2 + (ePos.y - zone.position.y) ** 2);
          if (dist > zone.radius) continue;

          const entityState = entityAI.getEntityAIState(String(entity.id));
          if (entityState?.combatState === "returning") continue;

          const tickDamage = zone.damagePerTick;
          if (tickDamage > 0) {
            entityAI.applyDamageToEntity(entity, tickDamage, caster || { username: "Ground AoE" });
          }
          if (entity.health == null || entity.health < 0) entity.health = 0;
          const entityHealth = entity.health ?? 0;
          if (entity.id != null) {
            entityCache.updateHealth(entity.id, entityHealth);
          }

          if (tickDamage !== 0) {
            broadcastToMap(mapName, packetManager.updateStats({
              id: zone.casterId,
              target: entity.id,
              stats: { health: entity.health, total_max_health: entity.max_health },
              isCrit: false,
              damage: tickDamage,
              entity: true,
            }));
          }

          if (entity.health <= 0 && entity.id != null) {
            broadcastToMap(mapName, packetManager.despawnEntity(String(entity.id), 30));
            entityCache.remove(entity.id);
          }

          if (caster && zone.spell && zone.effects && zone.effects.length > 0 && entity.health > 0) {
            applySpellEffects(zone.spell, caster, entity, () => {}, () => {});
          }
        }

        for (const player of affectedPlayers) {
          let tickDamage = zone.damagePerTick;

          if (tickDamage > 0 && !isHeal) {
            const av = player.stats?.stat_avoidance || 0;
            if (Math.random() * 100 < av) tickDamage = 0;
            if (tickDamage > 0) {
              const ar = player.stats?.stat_armor || 0;
              tickDamage = Math.floor(tickDamage * (1 - Math.min(ar, 75) / 100));
            }
          }

          if (tickDamage > 0 && !isHeal) {
            const absorbed = consumeBarrier(player, tickDamage);
            tickDamage -= absorbed;
            if (absorbed > 0) broadcastEffectsUpdate(player);
          }

          player.stats.health = Math.round((player.stats.health || 0) - tickDamage);
          if (isHeal && player.stats.health > player.stats.total_max_health) {
            player.stats.health = player.stats.total_max_health;
          }

          if (!isHeal && tickDamage !== 0) {
            player.pvp = true;
            player.last_attack = performance.now();
            if (caster) {
              caster.pvp = true;
              caster.last_attack = performance.now();
            }
          }

          if (!isHeal && tickDamage > 0 && player.isVanished) {
            const vanishId = getVanishedEffectId(player);
            if (vanishId) {
              cancelEffect(player, vanishId);
              broadcastEffectsUpdate(player);
            }
          }

          if (player.stats.health <= 0) {
            if (playerDeathHandler && caster) {
              try {
                await playerDeathHandler(player, caster, { damage: tickDamage, isCrit: false });
              } catch (e) {
                log.error(`GroundAoe death handler failed: ${e}`);
              }
            } else if (player.stats.health <= 0) {
              player.stats.health = 1;
            }
          }

          if (tickDamage !== 0) {
            broadcastToMap(mapName, packetManager.updateStats({
              id: zone.casterId,
              target: player.id,
              stats: player.stats,
              isCrit: false,
              damage: tickDamage,
            }));
          }

          if (caster && zone.spell && zone.effects && zone.effects.length > 0 && player.stats.health! > 0) {
            await applySpellEffects(zone.spell, caster, player, () => {}, () => {});
          }
        }
      }
    }
  }

  for (const zoneId of zonesToRemove) {
    removeZone(zoneId);
  }
}
