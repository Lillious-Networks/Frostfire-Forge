/**
 * Achievements: players earn them by doing things in the game (killing creatures, completing quests, gathering,
 * looting, collecting mounts and more), counted from the engine's events (systems/events.ts) from the moment this
 * shipped: nothing done before is counted. Earning one shows a popup, tells the party and the guild, and can give an
 * item and a mount. Admins make them with the achievement editor (/achievements). There are no titles and no points.
 * Design: docs/superpowers/specs/2026-10-17-achievements-design.md.
 */

/** The lists a target is picked from in the editor. */
export type PickList = "creatures" | "quests" | "items" | "mounts" | "maps" | "spells";
/** Whether a criterion has a target: none, one that may be left as "any" (null), or one it must have. */
export type TargetRule = "none" | "optional" | "required";

export type CriterionType =
  | "creature_kill" | "pvp_kill" | "death" | "quest_complete" | "level" | "gather" | "loot"
  | "collectable" | "map_visit" | "spell_cast" | "trade" | "friend_add" | "guild_join" | "mount_ride";

export interface Criterion {
  /** What the editor calls it. */
  label: string;
  target: TargetRule;
  /** Where its target is picked from, or null when it has none. */
  pick: PickList | null;
}

/** Every kind of deed an achievement can count. See criteria.ts for the event each is read from. */
export const CRITERIA: Record<CriterionType, Criterion> = {
  creature_kill: { label: "Kill creatures", target: "optional", pick: "creatures" },
  pvp_kill: { label: "Kill players", target: "none", pick: null },
  death: { label: "Die", target: "none", pick: null },
  quest_complete: { label: "Complete quests", target: "optional", pick: "quests" },
  level: { label: "Reach a level", target: "none", pick: null },
  gather: { label: "Gather items", target: "optional", pick: "items" },
  loot: { label: "Loot items", target: "optional", pick: "items" },
  collectable: { label: "Collect mounts", target: "optional", pick: "mounts" },
  map_visit: { label: "Visit a map", target: "required", pick: "maps" },
  spell_cast: { label: "Cast spells", target: "optional", pick: "spells" },
  trade: { label: "Complete trades", target: "none", pick: null },
  friend_add: { label: "Add friends", target: "none", pick: null },
  guild_join: { label: "Join or make a guild", target: "none", pick: null },
  mount_ride: { label: "Ride a mount", target: "optional", pick: "mounts" },
};

export const CRITERION_TYPES = Object.keys(CRITERIA) as CriterionType[];

export function isCriterion(value: unknown): value is CriterionType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CRITERIA, value);
}

/** Criteria whose target is an id (a creature template, a quest), compared as a number. The others name things, compared without regard to case. */
export const ID_TARGETS: ReadonlySet<CriterionType> = new Set<CriterionType>(["creature_kill", "quest_complete"]);

export const LIMITS = { nameMax: 100, descriptionMax: 500, iconMax: 255, countMax: 1_000_000, quantityMax: 999 } as const;

/** One row of the achievements table, as the rest of the engine reads it. */
export interface AchievementDef {
  id: number;
  name: string;
  description: string;
  /** Icon name on the asset server (/icons), or none. */
  icon: string | null;
  type: CriterionType;
  /** What is counted: a creature template id or a quest id as text, or a name. Null is "any". */
  target: string | null;
  /** How many are needed; for `level`, the level to reach. */
  count: number;
  reward_item: string | null;
  reward_quantity: number;
  /** A mount name: added to the collectables as type "mount". */
  reward_mount: string | null;
  enabled: boolean;
}

export type AchievementInput = Omit<AchievementDef, "id">;

/** One row of player_achievements, as held. `completed_at` is ms since the epoch, null until it is earned. */
export interface PlayerAchievement {
  achievement_id: number;
  progress: number;
  completed_at: number | null;
}

/** Something a player did that achievements may count. */
export interface Deed {
  username: string;
  type: CriterionType;
  target: string | number | null;
  /** How much it adds; for `level`, the level reached. */
  amount: number;
}

/** What the earner's popup is sent (ACHIEVEMENT_EARNED). */
export interface EarnedView {
  id: number;
  name: string;
  description: string;
  icon: string | null;
  rewardItem: string | null;
  rewardQuantity: number;
  rewardMount: string | null;
  /** The item did not fit in the bags and was mailed. */
  mailed: boolean;
}

/** One line of a player's achievements window (ACHIEVEMENTS). */
export interface AchievementView {
  id: number;
  name: string;
  description: string;
  icon: string | null;
  type: CriterionType;
  count: number;
  progress: number;
  completedAt: number | null;
  rewardItem: string | null;
  rewardQuantity: number;
  rewardMount: string | null;
}
