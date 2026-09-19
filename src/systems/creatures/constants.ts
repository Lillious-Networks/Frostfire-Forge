import * as settings from "../../config/settings.json";

// Optional overrides from settings.json -> "creatures". Everything has a
// WoW-derived default so the system runs without any config.
const cfg: Record<string, any> = (settings as any)?.creatures || {};

/** Pixels per WoW yard. Tiles are 32px, so the default makes 1 tile = 4 yards. */
export const YARD_PX: number = Number(cfg.yardPx) || 8;

export const yards = (y: number): number => y * YARD_PX;

/**
 * Speeds are converted against the player's run speed rather than YARD_PX so
 * WoW's speed relationships hold: a creature at the WoW run speed (7 yd/s)
 * moves exactly as fast as an unmounted player (6px per 30Hz tick).
 */
export const PLAYER_RUN_PX_PER_SEC = 180;
export const WOW_RUN_YD_PER_SEC = 7;
export const speedPxPerSec = (ydPerSec: number): number => (ydPerSec * PLAYER_RUN_PX_PER_SEC) / WOW_RUN_YD_PER_SEC;

/** Wander pauses between moves (WoW random-movement idle window). */
export const WANDER_WAIT_MIN_MS = 3000;
export const WANDER_WAIT_MAX_MS = 10000;

/** A* expansion budget for out-of-combat movement. */
export const IDLE_PATH_MAX_NODES = 1500;

/** How often per-layer spawn slots are reconciled with the layer manager, in ticks. */
export const LAYER_SYNC_EVERY_TICKS = 5;

/** AI tick interval; the system runs on Events.FIXED_UPDATE (100ms). */
export const TICK_MS = 100;

/** Debug overlay push cadence, in ticks (250ms). */
export const DEBUG_EVERY_TICKS = 3;

/** Visibility (spawn/despawn to clients) refresh cadence, in ticks. */
export const SYNC_EVERY_TICKS = 3;

/** Players stay subscribed to a creature until it is this many times their AOI radius away. */
export const SYNC_EXIT_HYSTERESIS = 1.25;

/** Spatial bucket size for creature lookups. */
export const CREATURE_CELL_PX = 512;

/** Multiplier applied to every rolled respawn time. */
export const RESPAWN_MULTIPLIER: number = Number(cfg.respawnMultiplier) || 1;

/** When a pool is full, retry the spawn after this long. */
export const POOL_RETRY_MS = 30_000;

/** Corpse lifetime with / without remaining loot (used from Phase 4). */
export const CORPSE_WITH_LOOT_MS = 5 * 60_000;
export const CORPSE_EMPTY_MS = 60_000;

/** Seedable RNG so tests can make rolls deterministic. */
export type Rng = () => number;
let activeRng: Rng = Math.random;
export const rng: Rng = () => activeRng();
export function setRng(next: Rng | null): void {
  activeRng = next ?? Math.random;
}

/** Inclusive integer in [min, max]. */
export function randInt(min: number, max: number, r: Rng = rng): number {
  if (max < min) [min, max] = [max, min];
  return min + Math.floor(r() * (max - min + 1));
}

export const CreatureFlags = {
  NO_TAUNT: 1 << 0,
  IMMUNE_STUN: 1 << 1,
  IMMUNE_ROOT: 1 << 2,
  NO_XP: 1 << 3,
  NO_LEASH: 1 << 4,
  NEVER_FLEE: 1 << 5,
  CAN_SWIM: 1 << 6,
  DETECT_STEALTH: 1 << 7,
  NO_SOCIAL_AGGRO: 1 << 8,
} as const;
