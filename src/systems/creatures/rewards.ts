/** WoW Classic kill XP. Pure functions. */
import { greyLevel } from "./aggro";
import type { CreatureRank } from "./types";

/** Party members farther than this from the corpse get nothing. */
export const REWARD_RANGE_YD = 100;

/** Zero-difference value: how many levels below the player a creature can be before it gives no XP. */
export function zeroDifference(playerLevel: number): number {
  if (playerLevel <= 7) return 5;
  if (playerLevel <= 9) return 6;
  if (playerLevel <= 11) return 7;
  if (playerLevel <= 15) return 8;
  if (playerLevel <= 19) return 9;
  if (playerLevel <= 29) return 10;
  if (playerLevel <= 39) return 11;
  if (playerLevel <= 44) return 12;
  if (playerLevel <= 49) return 13;
  if (playerLevel <= 54) return 14;
  if (playerLevel <= 59) return 15;
  return 16;
}

/** Base XP a single player of `playerLevel` earns for a normal creature of `creatureLevel`. */
export function baseKillXp(playerLevel: number, creatureLevel: number): number {
  if (creatureLevel <= greyLevel(playerLevel)) return 0;
  const base = playerLevel * 5 + 45;
  const d = creatureLevel - playerLevel;
  if (d >= 0) return base * (1 + 0.05 * Math.min(d, 4));
  return Math.max(0, base * (1 - (playerLevel - creatureLevel) / zeroDifference(playerLevel)));
}

export function rankMultiplier(rank: CreatureRank): number {
  const elite = rank === "elite" || rank === "rare_elite" || rank === "boss" ? 2 : 1;
  const rare = rank === "rare" || rank === "rare_elite" ? 2 : 1;
  return elite * rare;
}

/** Group bonus for 1..5 members (Classic); larger groups get no bonus. */
export function groupBonus(members: number): number {
  switch (members) {
    case 3: return 1.166;
    case 4: return 1.3;
    case 5: return 1.4;
    default: return 1;
  }
}

export interface XpMember {
  username: string;
  level: number;
}

/**
 * XP per member. The kill is valued as if the highest-level member killed it
 * (so a high-level helper can make the creature grey for everyone), multiplied
 * by the group bonus, then split by each member's share of the total levels.
 */
export function distributeKillXp(
  members: XpMember[],
  creatureLevel: number,
  rank: CreatureRank,
  xpMultiplier: number
): Map<string, number> {
  const result = new Map<string, number>();
  if (members.length === 0 || xpMultiplier <= 0) return result;
  const highest = members.reduce((max, m) => Math.max(max, m.level), 0);
  const total = baseKillXp(highest, creatureLevel) * rankMultiplier(rank) * xpMultiplier * groupBonus(members.length);
  const levelSum = members.reduce((sum, m) => sum + m.level, 0);
  for (const m of members) {
    const share = members.length === 1 ? total : (total * m.level) / levelSum;
    result.set(m.username, Math.max(0, Math.round(share)));
  }
  return result;
}
