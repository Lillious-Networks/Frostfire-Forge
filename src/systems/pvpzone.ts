// A harmful spell cast at a target is refused by player.canAttack when the
// caster or the target stands in a no-PvP zone. A harmful spell with no target
// - an area around the caster, or one placed on the ground - has to ask for
// itself, and for every player in its reach. These are its rules.

type Point = { x: number; y: number };

/** Whether PvP is allowed for a character standing at a position (player.isInPvPZone on the spell's map). */
export type PvpAllowed = (position: Point) => Promise<boolean>;

/** The character box the zone is asked with; player.canAttack is called with the same. */
export const PVP_BODY = { width: 24, height: 40 };

/**
 * Why a harmful area spell may not be cast, or null when it may: not by a
 * caster standing in a no-PvP zone, and not placed inside one (`aim` is the
 * ground point of a ground-targeted spell, null for one around the caster).
 */
export async function areaCastRefusal(caster: Point, aim: Point | null, allowed: PvpAllowed): Promise<"caster" | "aim" | null> {
  if (!(await allowed(caster))) return "caster";
  if (aim && !(await allowed(aim))) return "aim";
  return null;
}

/**
 * Whether a harmful area spell harms a player standing at `victim`: never
 * inside a no-PvP zone, and never while its caster stands in one. `caster` is
 * undefined once the caster has left the game; the zone a lingering spell left
 * behind then asks for the victim alone.
 */
export async function areaSpellHarms(caster: Point | undefined, victim: Point, allowed: PvpAllowed): Promise<boolean> {
  if (caster && !(await allowed(caster))) return false;
  return allowed(victim);
}
