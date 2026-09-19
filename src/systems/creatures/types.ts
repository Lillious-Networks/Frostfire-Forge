import type { AbilityState } from "./abilities";
import type { AuraPayload, CreatureAuras } from "./auras";
import type { ThreatTable } from "./threat";

export type CreatureStance = "aggressive" | "neutral" | "passive";
export type CreatureRank = "normal" | "elite" | "rare" | "rare_elite" | "boss";
export type CreatureMovementType = "idle" | "wander" | "patrol";
export type LayerPolicy = "per_layer" | "shared";
export type CreatureSpriteType = "animated" | "static" | "none";

export const AIState = {
  IDLE: "idle",
  WANDER: "wander",
  PATROL: "patrol",
  COMBAT: "combat",
  FLEEING: "fleeing",
  EVADING: "evading",
  DEAD: "dead",
} as const;
export type AIState = (typeof AIState)[keyof typeof AIState];

export interface CreatureTemplate {
  id: number;
  name: string;
  subname: string | null;
  level_min: number;
  level_max: number;
  rank: CreatureRank;
  creature_type: string;
  stance: CreatureStance;
  health_base: number;
  health_per_level: number;
  armor: number;
  resist: Record<string, number>;
  damage_min: number;
  damage_max: number;
  attack_speed_ms: number;
  ranged: boolean;
  move_speed_walk: number;
  move_speed_run: number;
  aggro_radius_override: number | null;
  assist_radius: number;
  call_for_help_radius: number;
  flee_at_hp_pct: number;
  flee_duration_ms: number;
  leash_override: number | null;
  regen_ooc: boolean;
  xp_mult: number;
  loot_table_id: number | null;
  gold_min: number;
  gold_max: number;
  sprite_type: CreatureSpriteType;
  sprite: string | null;
  sprite_head: string | null;
  /** Equipment layers, same slots as players/NPCs (animated sprites only). */
  sprite_helmet: string | null;
  sprite_shoulderguards: string | null;
  sprite_neck: string | null;
  sprite_hands: string | null;
  sprite_chest: string | null;
  sprite_feet: string | null;
  sprite_legs: string | null;
  sprite_weapon: string | null;
  scale: number;
  flags: number;
}

export interface CreatureAbility {
  id: number;
  template_id: number;
  spell_id: number;
  trigger: string;
  trigger_value: number;
  initial_cd_min_ms: number;
  initial_cd_max_ms: number;
  cooldown_min_ms: number;
  cooldown_max_ms: number;
  chance_pct: number;
  target_mode: string;
  max_range: number;
  interruptible: boolean;
  priority: number;
}

export interface CreatureSpawn {
  id: number;
  template_id: number;
  map: string;
  x: number;
  y: number;
  direction: string;
  layer_policy: LayerPolicy;
  respawn_min_s: number;
  respawn_max_s: number;
  wander_radius: number;
  movement_type: CreatureMovementType;
  patrol_path_id: number | null;
  link_group_id: number | null;
  pool_id: number | null;
}

export interface CreaturePatrolPoint {
  x: number;
  y: number;
  wait_ms: number;
}

export interface CreaturePatrolPath {
  id: number;
  map: string;
  loop: boolean;
  points: CreaturePatrolPoint[];
}

export interface CreatureLinkGroup {
  id: number;
  name: string;
}

export interface CreatureSpawnPool {
  id: number;
  max_active: number;
  rare_chance_pct: number;
  rare_template_id: number | null;
}

/** Live, server-owned creature. Clients only ever see CreatureSnapshot. */
export interface CreatureInstance {
  id: number;
  templateId: number;
  spawnId: number;
  poolId: number | null;
  map: string;
  /** Layer this copy lives on; null for shared (visible from every layer). */
  layerId: string | null;
  x: number;
  y: number;
  dir: string;
  homeX: number;
  homeY: number;
  level: number;
  health: number;
  maxHealth: number;
  state: AIState;
  spawnedAt: number;
  move: CreatureMoveState | null;
  /** Earliest time the idle behaviour may pick a new destination. */
  waitUntil: number;
  patrolIndex: number;
  patrolForward: boolean;
  /** Last position/direction pushed to clients. */
  sentX: number;
  sentY: number;
  sentDir: string;
  sentMoving: boolean;
  combat: CreatureCombatState;
  /** Template or spawn changed in the editor; respawn once out of combat. */
  pendingRefresh?: boolean;
  auras: CreatureAuras;
  casting: CreatureCast | null;
  /** ability id -> scheduling state */
  abilityStates: Map<number, AbilityState>;
}

export interface CreatureCast {
  abilityId: number;
  spellId: number;
  spellName: string;
  target: { kind: "player" | "creature"; id: string };
  startedAt: number;
  endsAt: number;
  interruptible: boolean;
}

export interface CreatureCombatState {
  threat: ThreatTable;
  /** Where combat started; leash distance is measured from here. */
  startX: number;
  startY: number;
  startedAt: number;
  fleeUntil: number;
  fleeFromId: string | null;
  fledThisCombat: boolean;
  evadeStartedAt: number;
  nextAggroScanAt: number;
  nextCombatPulseAt: number;
  lastRepathAt: number;
  pathTargetX: number;
  pathTargetY: number;
  corpseUntil: number;
  /** First player to act against the creature; owns XP, loot and quest credit. */
  tapper: { playerId: string; username: string } | null;
}

export interface CreatureMoveState {
  path: Array<{ x: number; y: number }>;
  index: number;
  /** Pixels per second. */
  speed: number;
  stuckTicks: number;
}

export interface CreatureSnapshot {
  id: number;
  templateId: number;
  name: string;
  subname: string | null;
  level: number;
  rank: CreatureRank;
  stance: CreatureStance;
  creatureType: string;
  health: number;
  maxHealth: number;
  x: number;
  y: number;
  dir: string;
  moving: boolean;
  state: AIState;
  /** Player id the creature is attacking, when in combat. */
  victimId: string | null;
  /** Tap state from the receiving player's point of view. */
  tap: "none" | "mine" | "other";
  /** Whether the receiving player may loot this corpse. */
  lootable: boolean;
  casting: { spell: string; durationMs: number; remainingMs: number; targetId: string } | null;
  auras: AuraPayload[];
  spriteType: CreatureSpriteType;
  sprite: string | null;
  /** Resolved sprite sheet URLs (same shape as NPC sprite layers). */
  spriteLayers: unknown;
  scale: number;
}

/** [id, x, y, dir, moving] */
export type CreatureMoveEntry = [number, number, number, string, 0 | 1];
