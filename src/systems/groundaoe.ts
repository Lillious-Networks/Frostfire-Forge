import AOI_CONFIG from "../config/aoi.json";
import playerCache from "../services/playermanager";
import layerManager from "../services/layermanager";
import { consumeBarrier, broadcastEffectsUpdate, applySpellEffects, cancelEffect, getVanishedEffectId } from "./spelleffects";
import { packetManager } from "../socket/packet_manager";
import log from "../modules/logger";
import { setPlayerPvp, listener, Events } from "./events";
import { broadcastToAOIBestEffort, getPlayersNearPoint } from "../socket/aoi";
import playerSystem from "./player";
import { areaSpellHarms, PVP_BODY } from "./pvpzone";
import { nextEntityId } from "../cluster/entityids";

export interface GroundAoeZone {
  id: string;
  spellId: number;
  spellName: string;
  casterId: string;
  casterUsername: string;
  /** Without ".json": the key players are filed under. */
  mapName: string;
  /** The caster's layer when it was cast: only that layer's players see it or are hit by it. Null: no layer. */
  layerId: string | null;
  position: { x: number; y: number };
  radius: number;
  duration: number;
  tickInterval: number;
  damagePerTick: number;
  damageType: "damage" | "heal";
  particles: string[] | null;
  effects: any[] | null;
  spell: any;
  /** The players this zone has been shown to (and not yet removed from): the ones its despawn must reach. */
  viewers: Set<string>;
  createdAt: number;
  expiresAt: number;
  nextTickAt: number;
}

const SCHEDULER_INTERVAL_MS = 250;
let schedulerInterval: ReturnType<typeof setInterval> | null = null;

const zonesByMap = new Map<string, GroundAoeZone[]>();
const zoneOccupants = new Map<string, Set<string>>();
// Cluster mode: zones another node owns near the border. Shown to the players here and never ticked:
// their owner applies their effects (phase 5).
const remoteZones = new Map<string, GroundAoeZone>();

let playerDeathHandler: ((player: any, attacker: any, damageInfo: { damage: number; isCrit: boolean }) => Promise<void>) | null = null;

/** Applies a zone tick to creatures inside it; registered by the creature system. */
type CreatureZoneHandler = (zone: GroundAoeZone, caster: any) => void;
let creatureZoneHandler: CreatureZoneHandler | null = null;

export function setCreatureZoneHandler(handler: CreatureZoneHandler) {
  creatureZoneHandler = handler;
}

export function setPlayerDeathHandler(handler: typeof playerDeathHandler) {
  playerDeathHandler = handler;
}

// Who should be seeing a zone: players near its centre on its layer, whose own sight radius covers the centre. A
// zone with no layer is for players with no layer, as getPlayersNearPoint treats null.
function zoneAudience(zone: GroundAoeZone): any[] {
  const { x, y } = zone.position;
  return getPlayersNearPoint(x, y, zone.mapName, AOI_CONFIG.DEFAULT_RADIUS, zone.layerId).filter((player) => {
    const pPos = player.location.position;
    const sight = player.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS;
    return (pPos.x - x) ** 2 + (pPos.y - y) ** 2 <= sight * sight;
  });
}

// Reliable: a lost spawn leaves a zone nobody sees, a lost despawn one that never ends.
function sendTo(player: any, packets: any[]) {
  if (!player?.wt || player.wt.readyState !== 1) return;
  // A send that throws (a stream that just closed) must not stop the pass: the zones after this one still tick.
  try {
    for (const packet of packets) player.wt.send(packet);
  } catch (error) {
    log.debug(`Ground AoE packet not sent to ${player.id}: ${error}`);
  }
}

function spawnPacket(zone: GroundAoeZone) {
  return packetManager.groundAoeSpawn({
    id: zone.id,
    spell: zone.spellName,
    casterId: zone.casterId,
    x: zone.position.x,
    y: zone.position.y,
    radius: zone.radius,
    duration: Math.max(0, Math.ceil((zone.expiresAt - Date.now()) / 1000)),
    damageType: zone.damageType,
    particles: zone.particles,
    casterUsername: zone.casterUsername,
  });
}

// The despawn goes to everyone the zone was shown to, wherever they have walked since (connected ones only).
function despawnToViewers(zone: GroundAoeZone) {
  const packet = packetManager.groundAoeDespawn({ id: zone.id });
  for (const playerId of zone.viewers) sendTo(playerCache.get(playerId), packet);
  zone.viewers.clear();
}

// Brings a zone's viewers up to date: players who came into view get the spawn, players who left get the despawn.
// Spawns reach only who is near, so someone walking in later would otherwise take its damage without seeing it.
function syncViewers(zone: GroundAoeZone) {
  const audience = new Map<string, any>();
  for (const player of zoneAudience(zone)) audience.set(String(player.id), player);
  for (const [playerId, player] of audience) {
    if (zone.viewers.has(playerId)) continue;
    zone.viewers.add(playerId);
    sendTo(player, spawnPacket(zone));
  }
  const despawn = packetManager.groundAoeDespawn({ id: zone.id });
  for (const playerId of zone.viewers) {
    if (audience.has(playerId)) continue;
    zone.viewers.delete(playerId);
    sendTo(playerCache.get(playerId), despawn);
  }
}

/**
 * Brings the zones a player sees up to date after they arrive or change layer or map: zones they were shown that are
 * no longer theirs (another layer or map) are despawned for them, and the zones of their layer in range are sent.
 * `fresh` is a new login: whatever the zones remember of that player's id is from a connection that is gone.
 */
export function resyncZonesFor(player: any, fresh = false): void {
  if (!player?.wt) return;
  const playerId = String(player.id);
  const mapName = String(player.location?.map ?? "").replaceAll(".json", "");
  const layerId = layerManager.getPlayerLayer(playerId);
  const despawn = (zone: GroundAoeZone) => packetManager.groundAoeDespawn({ id: zone.id });
  for (const zone of [...getAllZones(), ...remoteZones.values()]) {
    if (fresh) zone.viewers.delete(playerId);
    else if (zone.viewers.has(playerId) && (zone.layerId !== layerId || zone.mapName !== mapName)) {
      zone.viewers.delete(playerId);
      sendTo(player, despawn(zone));
    }
  }
  const pos = player.location?.position;
  if (!pos) return;
  const sight = player.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS;
  const inRange = (z: GroundAoeZone) => z.mapName === mapName && z.layerId === layerId && (z.position.x - pos.x) ** 2 + (z.position.y - pos.y) ** 2 <= sight * sight;
  for (const zone of [...getZonesInRange(mapName, layerId, pos.x, pos.y, sight), ...[...remoteZones.values()].filter(inRange)]) {
    if (zone.viewers.has(playerId)) continue;
    zone.viewers.add(playerId);
    sendTo(player, spawnPacket(zone));
  }
}

/**
 * A mirror of a zone another node owns (its GHOST_SPAWN record). False when the id is a zone of this node's own. A
 * record sent again replaces the zone and keeps who it was shown to. `duration` is in ms, as the owner keeps it.
 */
export function addRemoteZone(r: any): boolean {
  if (findZoneById(String(r.id))) return false;
  const zone: GroundAoeZone = {
    id: String(r.id),
    spellId: Number(r.spellId) || 0,
    spellName: String(r.spellName ?? ""),
    casterId: String(r.casterId ?? ""),
    casterUsername: String(r.casterUsername ?? ""),
    mapName: String(r.mapName ?? "").replaceAll(".json", ""),
    layerId: r.layerId ?? null,
    position: { x: Number(r.x) || 0, y: Number(r.y) || 0 },
    radius: Number(r.radius) || 0,
    duration: Number(r.duration) || 0,
    // Never ticked here: no interval, damage, effects or spell.
    tickInterval: 0,
    damagePerTick: 0,
    damageType: r.damageType === "heal" ? "heal" : "damage",
    particles: Array.isArray(r.particles) ? r.particles : null,
    effects: null,
    spell: null,
    viewers: remoteZones.get(String(r.id))?.viewers ?? new Set<string>(),
    createdAt: Number(r.createdAt) || Date.now(),
    expiresAt: Number(r.expiresAt) || 0,
    nextTickAt: Infinity,
  };
  remoteZones.set(zone.id, zone);
  syncViewers(zone);
  startScheduler();
  return true;
}

export function removeRemoteZone(id: string): void {
  const zone = remoteZones.get(id);
  if (!zone) return;
  remoteZones.delete(id);
  despawnToViewers(zone);
  if (getTotalZoneCount() === 0) stopScheduler();
}

function generateZoneId(): string {
  return `groundaoe_${nextEntityId()}`;
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
  const mapName = String(zoneData.mapName ?? "").replaceAll(".json", "");
  const durationMs = zoneData.duration * 1000;
  const tickIntervalMs = (zoneData.tickInterval || 1) * 1000;

  const zone: GroundAoeZone = {
    id: generateZoneId(),
    spellId: zoneData.spellId,
    spellName: zoneData.spellName,
    casterId: zoneData.casterId,
    casterUsername: zoneData.casterUsername,
    mapName,
    layerId: layerManager.getPlayerLayer(zoneData.casterId),
    position: zoneData.position,
    radius: zoneData.radius,
    duration: durationMs,
    tickInterval: tickIntervalMs,
    damagePerTick: zoneData.damagePerTick,
    damageType: zoneData.damageType,
    particles: zoneData.particles,
    effects: zoneData.effects,
    spell: zoneData.spell,
    viewers: new Set<string>(),
    createdAt: now,
    expiresAt: now + durationMs,
    nextTickAt: now + tickIntervalMs,
  };

  if (!zonesByMap.has(zone.mapName)) {
    zonesByMap.set(zone.mapName, []);
  }
  zonesByMap.get(zone.mapName)!.push(zone);

  const initialOccupants = new Set<string>();
  for (const player of getPlayersNearPoint(zone.position.x, zone.position.y, zone.mapName, zone.radius, zone.layerId)) {
    initialOccupants.add(player.id);
  }
  zoneOccupants.set(zone.id, initialOccupants);

  syncViewers(zone);

  startScheduler();

  return zone;
}

export function removeZone(zoneId: string): boolean {
  let found = false;
  for (const [mapName, zones] of zonesByMap.entries()) {
    const idx = zones.findIndex((z) => z.id === zoneId);
    if (idx !== -1) {
      const [zone] = zones.splice(idx, 1);
      if (zones.length === 0) {
        zonesByMap.delete(mapName);
      }
      despawnToViewers(zone);
      found = true;
      break;
    }
  }

  const occupants = zoneOccupants.get(zoneId);
  if (occupants) {
    const zone = findZoneById(zoneId);
    for (const playerId of occupants) {
      const player = playerCache.get(playerId);
      if (player) {
        listener.emit(Events.PLAYER_LEFT_AOE, { player, zoneId, spellName: zone?.spellName || "" } as any);
      }
    }
    zoneOccupants.delete(zoneId);
  }

  if (found && getTotalZoneCount() === 0) {
    stopScheduler();
  }
  return found;
}

export function clearZonesForMap(map: string): void {
  const mapName = String(map ?? "").replaceAll(".json", "");
  const zones = zonesByMap.get(mapName);
  if (zones && zones.length > 0) {
    for (const zone of zones) {
      despawnToViewers(zone);
      const occupants = zoneOccupants.get(zone.id);
      if (occupants) {
        for (const playerId of occupants) {
          const player = playerCache.get(playerId);
          if (player) {
            listener.emit(Events.PLAYER_LEFT_AOE, { player, zoneId: zone.id, spellName: zone.spellName } as any);
          }
        }
        zoneOccupants.delete(zone.id);
      }
    }
  }
  zonesByMap.delete(mapName);
  if (getTotalZoneCount() === 0) {
    stopScheduler();
  }
}

/** The maps that have zones of this node's own. */
export function zoneMaps(): string[] {
  return [...zonesByMap.keys()];
}

export function getZonesOnMap(mapName: string): GroundAoeZone[] {
  return zonesByMap.get(String(mapName ?? "").replaceAll(".json", "")) || [];
}

/**
 * The zones a player at (x, y) on a layer should be showing: that layer's zones whose centre is within `radius` (the
 * player's sight radius), which is who a spawn reaches. For a player who has just arrived or changed layer.
 */
export function getZonesInRange(mapName: string, layerId: string | null, x: number, y: number, radius: number): GroundAoeZone[] {
  return getZonesOnMap(mapName).filter(
    (z) => z.layerId === layerId && (z.position.x - x) ** 2 + (z.position.y - y) ** 2 <= radius * radius
  );
}

export function getAllZones(): GroundAoeZone[] {
  const all: GroundAoeZone[] = [];
  for (const zones of zonesByMap.values()) {
    all.push(...zones);
  }
  return all;
}

function getTotalZoneCount(): number {
  // Remote zones keep the scheduler running for their viewer pass.
  let count = remoteZones.size;
  for (const zones of zonesByMap.values()) {
    count += zones.length;
  }
  return count;
}

export function findZoneById(zoneId: string): GroundAoeZone | undefined {
  for (const zones of zonesByMap.values()) {
    const found = zones.find((z) => z.id === zoneId);
    if (found) return found;
  }
  return undefined;
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

/** Exported for tests; the scheduler calls it. */
export async function processZoneTicks(): Promise<void> {
  const now = Date.now();
  const zonesToRemove: string[] = [];

  for (const [mapName, zones] of zonesByMap.entries()) {
    for (let i = zones.length - 1; i >= 0; i--) {
      const zone = zones[i];

      if (now >= zone.expiresAt) {
        zonesToRemove.push(zone.id);
        continue;
      }

      // Every pass, not only on the zone's own tick: someone who walks into view should see it at once.
      syncViewers(zone);

      if (zone.nextTickAt <= now) {
        zone.nextTickAt += zone.tickInterval;

        const caster = playerCache.get(zone.casterId);
        const isHeal = zone.damageType === "heal";

        const affectedPlayers: any[] = [];
        const currentOccupants = new Set<string>();
        // Only this layer's players within the radius can be hit.
        for (const player of getPlayersNearPoint(zone.position.x, zone.position.y, mapName, zone.radius, zone.layerId)) {
          if (player.isGuest) continue;
          // Ghosts and corpses are unaffected by ground effects.
          if (player.isGhost || player.isDead) continue;
          // An admin in stealth is out of the game for everyone else: the zone neither touches nor counts them.
          if (player.isStealth) continue;
          const pPos = player.location.position;

          currentOccupants.add(player.id);

          const inParty = caster?.party?.includes(player.username) || false;

          if (isHeal) {
            if (player.id !== zone.casterId && !inParty) continue;
          } else {
            if (player.id === zone.casterId || inParty) continue;
            // A hostile zone harms nobody standing in a no-PvP zone, nor anyone while its caster stands in one.
            const allowed = (position: { x: number; y: number }) => playerSystem.isInPvPZone(mapName, position as PositionData, PVP_BODY);
            if (!(await areaSpellHarms(caster?.location?.position, pPos, allowed))) continue;
          }
          affectedPlayers.push(player);
        }

        const prevOccupants = zoneOccupants.get(zone.id) || new Set<string>();
        for (const playerId of currentOccupants) {
          if (!prevOccupants.has(playerId)) {
            const entered = playerCache.get(playerId);
            if (entered) {
              listener.emit(Events.PLAYER_ENTER_AOE, { player: entered, zoneId: zone.id, spellName: zone.spellName } as any);
            }
          }
        }
        for (const playerId of prevOccupants) {
          if (!currentOccupants.has(playerId)) {
            const left = playerCache.get(playerId);
            if (left) {
              listener.emit(Events.PLAYER_LEFT_AOE, { player: left, zoneId: zone.id, spellName: zone.spellName } as any);
            }
          }
        }
        zoneOccupants.set(zone.id, currentOccupants);

        // Creatures standing in the zone take the tick too (hostile zones only).
        if (!isHeal && creatureZoneHandler) {
          try {
            creatureZoneHandler(zone, caster || null);
          } catch (e) {
            log.error(`Ground AoE creature tick failed: ${e}`);
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
            setPlayerPvp(player, true);
            player.last_attack = performance.now();
            if (caster) {
              setPlayerPvp(caster, true);
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
            broadcastToAOIBestEffort(player, packetManager.updateStats({
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

  // Remote zones: the viewer pass only. An expired one waits for its owner's despawn.
  for (const zone of remoteZones.values()) {
    if (now < zone.expiresAt) syncViewers(zone);
  }
}

