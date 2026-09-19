/** Shared projectile flight timing, so spell visuals and damage agree. */

/** Milliseconds for a projectile to cross `distance` pixels: 1px/ms, capped. */
export const MAX_PROJECTILE_TRAVEL_MS = 500;

export function projectileTravelMs(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  return Math.min(MAX_PROJECTILE_TRAVEL_MS, Math.round(distance));
}
