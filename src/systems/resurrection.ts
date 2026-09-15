import playerCache from "../services/playermanager";
import log from "../modules/logger";
import { registerEffectsPayloadProvider } from "./spelleffects";
import { getIconUrl } from "../modules/spriteSheetManager";

// Resurrection Sickness: the price of resurrecting at the graveyard instead
// of walking back to the corpse. In-memory only (timers like loot/skeleton
// expiry) — it does not need to survive server restarts.
export const SICKNESS_DURATION_MS = 15 * 60 * 1000;
export const SICKNESS_DURATION_SEC = 15 * 60;
// 20% health reduction, 10% reduction on everything else.
export const SICKNESS_HEALTH_MULT = 0.8;
export const SICKNESS_STAT_MULT = 0.9;

const SICK_EFFECT_ID = "resurrection-sickness";

const expiryTimers = new Map<string, NodeJS.Timeout>();
// Username-keyed handoff so sickness survives relog (player ids are
// per-session). In-memory like effectManager: gone on server restart.
const sickByUsername = new Map<string, number>();
let onExpiry: ((player: any) => void) | null = null;

export function setOnSicknessExpiry(fn: (player: any) => void): void {
  onExpiry = fn;
}

export function isSick(player: any): boolean {
  const until = Number(player?.resurrectionSickUntil) || 0;
  return until > 0 && Date.now() < until;
}

export function sicknessRemainingSec(player: any): number {
  const until = Number(player?.resurrectionSickUntil) || 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

// Scales rolled-up totals (never base components, so repeated recomputes
// can't double-dip) and clamps current values into the reduced maximums.
export function applySicknessToStats(stats: any): any {
  if (!stats) return stats;
  stats.total_max_health = Math.max(
    1,
    Math.floor((stats.total_max_health || 0) * SICKNESS_HEALTH_MULT)
  );
  stats.total_max_stamina = Math.max(
    1,
    Math.floor((stats.total_max_stamina || 0) * SICKNESS_STAT_MULT)
  );
  for (const key of [
    "stat_damage",
    "stat_armor",
    "stat_critical_chance",
    "stat_critical_damage",
    "stat_avoidance",
  ]) {
    stats[key] = Math.floor((stats[key] || 0) * SICKNESS_STAT_MULT);
  }
  stats.health = Math.min(stats.health ?? 0, stats.total_max_health);
  stats.stamina = Math.min(stats.stamina ?? 0, stats.total_max_stamina);
  return stats;
}

function usernameKey(player: any): string {
  return String(player?.username || "").toLowerCase();
}

function scheduleExpiry(player: any): void {
  const key = String(player.id);
  const existing = expiryTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    expiryTimers.delete(key);
  }
  const until = Number(player.resurrectionSickUntil || 0);
  const remaining = until - Date.now();
  if (remaining <= 0) return;
  const timer = setTimeout(() => {
    expiryTimers.delete(key);
    // Drop the relog handoff only once it is actually spent, so a stale
    // timer from a previous session can't strand a live one.
    const mapped = sickByUsername.get(usernameKey(player));
    if (mapped && mapped <= Date.now()) {
      sickByUsername.delete(usernameKey(player));
    }
    const fresh = playerCache.get(player.id);
    if (!fresh || !fresh.resurrectionSickUntil) return;
    if (Date.now() < fresh.resurrectionSickUntil) return;
    fresh.resurrectionSickUntil = 0;
    playerCache.set(fresh.id, fresh);
    if (onExpiry) {
      try {
        onExpiry(fresh);
      } catch (e: any) {
        log.error(`Resurrection sickness expiry handler failed: ${e?.message || e}`);
      }
    }
  }, remaining);
  expiryTimers.set(key, timer);
}

export function applySickness(player: any): number {
  const until = Date.now() + SICKNESS_DURATION_MS;
  player.resurrectionSickUntil = until;
  playerCache.set(player.id, player);
  sickByUsername.set(usernameKey(player), until);
  scheduleExpiry(player);
  return until;
}

export function clearSickness(player: any): void {
  const timer = expiryTimers.get(String(player.id));
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(String(player.id));
  }
  sickByUsername.delete(usernameKey(player));
  player.resurrectionSickUntil = 0;
  playerCache.set(player.id, player);
}

// Disconnect handoff (mirrors effectManager.saveSlows): the live flag moves
// to the username map so a relog restores it. Called with the disconnecting
// player object.
export function saveOnDisconnect(player: any): void {
  const key = usernameKey(player);
  if (!key) return;
  if (isSick(player)) {
    sickByUsername.set(key, Number(player.resurrectionSickUntil));
  } else {
    sickByUsername.delete(key);
  }
}

// Login restore (mirrors the effectManager.load* block): re-arms the flag,
// timer, and scaled totals on the fresh session object. Returns true when
// sickness was restored.
export function restoreOnLogin(cachedPlayer: any): boolean {
  const key = usernameKey(cachedPlayer);
  if (!key) return false;
  const until = Number(sickByUsername.get(key)) || 0;
  if (until <= Date.now()) {
    sickByUsername.delete(key);
    cachedPlayer.resurrectionSickUntil = 0;
    return false;
  }
  cachedPlayer.resurrectionSickUntil = until;
  playerCache.set(cachedPlayer.id, cachedPlayer);
  scheduleExpiry(cachedPlayer);
  applySicknessToStats(cachedPlayer.stats);
  return true;
}

registerEffectsPayloadProvider((player: any) => {
  if (!isSick(player)) return [];
  return [
    {
      id: SICK_EFFECT_ID,
      spell: "Resurrection Sickness",
      kind: "sickness",
      duration: SICKNESS_DURATION_SEC,
      remaining: sicknessRemainingSec(player),
      description: "-20% max health, -10% all other stats",
      icon: getIconUrl("skeleton"),
      isDebuff: true,
    },
  ];
});
