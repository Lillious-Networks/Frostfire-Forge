/** WoW proximity-aggro rules. Pure functions. */

export const BASE_AGGRO_RADIUS_YD = 20;
export const MIN_AGGRO_RADIUS_YD = 5;
export const MAX_AGGRO_RADIUS_YD = 45;
/** Stealth is broken by walking this close to any creature. */
export const STEALTH_DETECT_YD = 2;

/** WoW grey level: creatures at or below this level are trivial to the player. */
export function greyLevel(playerLevel: number): number {
  if (playerLevel <= 5) return 0;
  if (playerLevel <= 39) return playerLevel - Math.floor(playerLevel / 10) - 5;
  if (playerLevel <= 59) return playerLevel - Math.floor(playerLevel / 5) - 1;
  return playerLevel - 9;
}

export function isGreyToPlayer(creatureLevel: number, playerLevel: number): boolean {
  return creatureLevel <= greyLevel(playerLevel);
}

/** Aggro radius in yards: base 20 (or override), +/-1 per level difference, clamped 5..45. */
export function aggroRadiusYards(creatureLevel: number, playerLevel: number, override: number | null = null): number {
  const base = override ?? BASE_AGGRO_RADIUS_YD;
  const radius = base + (creatureLevel - playerLevel);
  return Math.min(MAX_AGGRO_RADIUS_YD, Math.max(MIN_AGGRO_RADIUS_YD, radius));
}

export interface AggroCandidate {
  level: number;
  alive: boolean;
  /** GM invisibility: never aggroed. */
  gmHidden: boolean;
  /** Rogue-style stealth. */
  stealthed: boolean;
}

/**
 * Whether a creature may proximity-aggro this player at `distanceYd`
 * (line of sight is checked separately by the caller).
 */
export function canProximityAggro(
  creatureLevel: number,
  aggroOverride: number | null,
  detectsStealth: boolean,
  player: AggroCandidate,
  distanceYd: number
): boolean {
  if (!player.alive || player.gmHidden) return false;
  if (isGreyToPlayer(creatureLevel, player.level)) return false;
  if (player.stealthed && !(detectsStealth && distanceYd <= STEALTH_DETECT_YD)) return false;
  return distanceYd <= aggroRadiusYards(creatureLevel, player.level, aggroOverride);
}
