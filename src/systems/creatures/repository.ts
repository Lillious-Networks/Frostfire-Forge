import query from "../../controllers/sqldatabase";
import log from "../../modules/logger";
import assetCache from "../../services/assetCache";
import type {
  CreatureAbility,
  CreatureLinkGroup,
  CreatureMovementType,
  CreaturePatrolPath,
  CreaturePatrolPoint,
  CreatureRank,
  CreatureSpawn,
  CreatureSpawnPool,
  CreatureSpriteType,
  CreatureStance,
  CreatureTemplate,
  LayerPolicy,
} from "./types";

export const CACHE_KEYS = {
  templates: "creatureTemplates",
  abilities: "creatureAbilities",
  spawns: "creatureSpawns",
  patrolPaths: "creaturePatrolPaths",
  linkGroups: "creatureLinkGroups",
  pools: "creatureSpawnPools",
} as const;

const STANCES: CreatureStance[] = ["aggressive", "neutral", "passive"];
const RANKS: CreatureRank[] = ["normal", "elite", "rare", "rare_elite", "boss"];
const MOVEMENT_TYPES: CreatureMovementType[] = ["idle", "wander", "patrol"];
const LAYER_POLICIES: LayerPolicy[] = ["per_layer", "shared"];
const SPRITE_TYPES: CreatureSpriteType[] = ["animated", "static", "none"];

const num = (v: any, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const nullableNum = (v: any): number | null =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const bool = (v: any): boolean => v === true || v === 1 || v === "1" || v === "true";
const oneOf = <T extends string>(v: any, allowed: T[], fallback: T): T =>
  allowed.includes(v) ? (v as T) : fallback;
const json = <T>(v: any, fallback: T): T => {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

export function normalizeTemplate(row: any): CreatureTemplate {
  const levelMin = Math.max(1, num(row.level_min, 1));
  return {
    id: num(row.id, 0),
    name: String(row.name ?? "Unknown"),
    subname: row.subname ? String(row.subname) : null,
    level_min: levelMin,
    level_max: Math.max(levelMin, num(row.level_max, levelMin)),
    rank: oneOf(row.rank, RANKS, "normal"),
    creature_type: String(row.creature_type ?? "beast"),
    stance: oneOf(row.stance, STANCES, "aggressive"),
    health_base: Math.max(1, num(row.health_base, 50)),
    health_per_level: Math.max(0, num(row.health_per_level, 10)),
    armor: Math.max(0, num(row.armor, 0)),
    resist: json<Record<string, number>>(row.resist_json, {}),
    damage_min: Math.max(0, num(row.damage_min, 1)),
    damage_max: Math.max(0, num(row.damage_max, 3)),
    attack_speed_ms: Math.max(100, num(row.attack_speed_ms, 2000)),
    ranged: bool(row.ranged),
    move_speed_walk: Math.max(0, num(row.move_speed_walk, 2.5)),
    move_speed_run: Math.max(0, num(row.move_speed_run, 7)),
    aggro_radius_override: nullableNum(row.aggro_radius_override),
    assist_radius: Math.max(0, num(row.assist_radius, 10)),
    call_for_help_radius: Math.max(0, num(row.call_for_help_radius, 15)),
    flee_at_hp_pct: Math.min(100, Math.max(0, num(row.flee_at_hp_pct, 0))),
    flee_duration_ms: Math.max(0, num(row.flee_duration_ms, 4000)),
    leash_override: nullableNum(row.leash_override),
    regen_ooc: row.regen_ooc === undefined ? true : bool(row.regen_ooc),
    xp_mult: Math.max(0, num(row.xp_mult, 1)),
    loot_table_id: nullableNum(row.loot_table_id),
    gold_min: Math.max(0, num(row.gold_min, 0)),
    gold_max: Math.max(0, num(row.gold_max, 0)),
    sprite_type: oneOf(row.sprite_type, SPRITE_TYPES, row.sprite ? "animated" : "none"),
    sprite: row.sprite ? String(row.sprite) : null,
    sprite_head: row.sprite_head ? String(row.sprite_head) : null,
    sprite_helmet: row.sprite_helmet ? String(row.sprite_helmet) : null,
    sprite_shoulderguards: row.sprite_shoulderguards ? String(row.sprite_shoulderguards) : null,
    sprite_neck: row.sprite_neck ? String(row.sprite_neck) : null,
    sprite_hands: row.sprite_hands ? String(row.sprite_hands) : null,
    sprite_chest: row.sprite_chest ? String(row.sprite_chest) : null,
    sprite_feet: row.sprite_feet ? String(row.sprite_feet) : null,
    sprite_legs: row.sprite_legs ? String(row.sprite_legs) : null,
    sprite_weapon: row.sprite_weapon ? String(row.sprite_weapon) : null,
    scale: Math.max(0.1, num(row.scale, 1)),
    flags: Math.max(0, Math.trunc(num(row.flags, 0))),
  };
}

export function normalizeAbility(row: any): CreatureAbility {
  return {
    id: num(row.id, 0),
    template_id: num(row.template_id, 0),
    spell_id: num(row.spell_id, 0),
    trigger: String(row.trigger ?? "combat_timer"),
    trigger_value: num(row.trigger_value, 0),
    initial_cd_min_ms: Math.max(0, num(row.initial_cd_min_ms, 0)),
    initial_cd_max_ms: Math.max(0, num(row.initial_cd_max_ms, 0)),
    cooldown_min_ms: Math.max(0, num(row.cooldown_min_ms, 10000)),
    cooldown_max_ms: Math.max(0, num(row.cooldown_max_ms, 10000)),
    chance_pct: Math.min(100, Math.max(0, num(row.chance_pct, 100))),
    target_mode: String(row.target_mode ?? "current"),
    max_range: Math.max(0, num(row.max_range, 30)),
    interruptible: row.interruptible === undefined ? true : bool(row.interruptible),
    priority: num(row.priority, 0),
  };
}

export function normalizeSpawn(row: any): CreatureSpawn {
  const respawnMin = Math.max(0, num(row.respawn_min_s, 300));
  return {
    id: num(row.id, 0),
    template_id: num(row.template_id, 0),
    map: String(row.map ?? "").replaceAll(".json", ""),
    x: num(row.x, 0),
    y: num(row.y, 0),
    direction: String(row.direction ?? "down"),
    layer_policy: oneOf(row.layer_policy, LAYER_POLICIES, "per_layer"),
    respawn_min_s: respawnMin,
    respawn_max_s: Math.max(respawnMin, num(row.respawn_max_s, respawnMin)),
    wander_radius: Math.max(0, num(row.wander_radius, 0)),
    movement_type: oneOf(row.movement_type, MOVEMENT_TYPES, "idle"),
    patrol_path_id: nullableNum(row.patrol_path_id),
    link_group_id: nullableNum(row.link_group_id),
    pool_id: nullableNum(row.pool_id),
  };
}

export function normalizePatrolPath(row: any): CreaturePatrolPath {
  // Database rows carry points_json (a JSON string); editor saves carry points
  // (an array). Accept both, or every editor save would wipe the path to [].
  const raw = Array.isArray(row?.points) ? row.points : json<any[]>(row.points_json, []);
  const points: CreaturePatrolPoint[] = Array.isArray(raw)
    ? raw
        .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
        .map((p) => ({ x: Number(p.x), y: Number(p.y), wait_ms: Math.max(0, num(p.wait_ms, 0)) }))
    : [];
  return {
    id: num(row.id, 0),
    map: String(row.map ?? "").replaceAll(".json", ""),
    loop: bool(row.loop),
    points,
  };
}

export function normalizeSpawnPool(row: any): CreatureSpawnPool {
  return {
    id: num(row.id, 0),
    max_active: Math.max(1, num(row.max_active, 1)),
    rare_chance_pct: Math.min(100, Math.max(0, num(row.rare_chance_pct, 0))),
    rare_template_id: nullableNum(row.rare_template_id),
  };
}

export function normalizeLinkGroup(row: any): CreatureLinkGroup {
  return { id: num(row.id, 0), name: String(row.name ?? "") };
}


// ------------------------------------------------------------------- writes

/** Column lists kept in one place so insert and update stay in step. */
const TEMPLATE_COLUMNS = [
  "name", "subname", "level_min", "level_max", "rank", "creature_type", "stance", "health_base", "health_per_level",
  "armor", "resist_json", "damage_min", "damage_max", "attack_speed_ms", "ranged", "move_speed_walk", "move_speed_run",
  "aggro_radius_override", "assist_radius", "call_for_help_radius", "flee_at_hp_pct", "flee_duration_ms",
  "leash_override", "regen_ooc", "xp_mult", "loot_table_id", "gold_min", "gold_max", "sprite_type", "sprite", "sprite_head", "sprite_helmet", "sprite_shoulderguards", "sprite_neck", "sprite_hands", "sprite_chest", "sprite_feet", "sprite_legs", "sprite_weapon", "scale", "flags",
] as const;

const ABILITY_COLUMNS = [
  "template_id", "spell_id", "trigger", "trigger_value", "initial_cd_min_ms", "initial_cd_max_ms",
  "cooldown_min_ms", "cooldown_max_ms", "chance_pct", "target_mode", "max_range", "interruptible", "priority",
] as const;

const SPAWN_COLUMNS = [
  "template_id", "map", "x", "y", "direction", "layer_policy", "respawn_min_s", "respawn_max_s",
  "wander_radius", "movement_type", "patrol_path_id", "link_group_id", "pool_id",
] as const;

const PATH_COLUMNS = ["map", "loop", "points_json"] as const;
const POOL_COLUMNS = ["max_active", "rare_chance_pct", "rare_template_id"] as const;

/** Reserved words differ per engine; quote every column the same way. */
const quote = (column: string) => (process.env.DATABASE_ENGINE === "sqlite" ? `"${column}"` : `\`${column}\``);

function templateValues(t: CreatureTemplate): any[] {
  return [
    t.name, t.subname, t.level_min, t.level_max, t.rank, t.creature_type, t.stance, t.health_base, t.health_per_level,
    t.armor, JSON.stringify(t.resist || {}), t.damage_min, t.damage_max, t.attack_speed_ms, t.ranged ? 1 : 0,
    t.move_speed_walk, t.move_speed_run, t.aggro_radius_override, t.assist_radius, t.call_for_help_radius,
    t.flee_at_hp_pct, t.flee_duration_ms, t.leash_override, t.regen_ooc ? 1 : 0, t.xp_mult, t.loot_table_id,
    t.gold_min, t.gold_max, t.sprite_type, t.sprite, t.sprite_head, t.sprite_helmet, t.sprite_shoulderguards, t.sprite_neck, t.sprite_hands, t.sprite_chest, t.sprite_feet, t.sprite_legs, t.sprite_weapon, t.scale, t.flags,
  ];
}

function abilityValues(a: CreatureAbility): any[] {
  return [
    a.template_id, a.spell_id, a.trigger, a.trigger_value, a.initial_cd_min_ms, a.initial_cd_max_ms,
    a.cooldown_min_ms, a.cooldown_max_ms, a.chance_pct, a.target_mode, a.max_range, a.interruptible ? 1 : 0, a.priority,
  ];
}

function spawnValues(s: CreatureSpawn): any[] {
  return [
    s.template_id, s.map, Math.round(s.x), Math.round(s.y), s.direction, s.layer_policy, s.respawn_min_s,
    s.respawn_max_s, s.wander_radius, s.movement_type, s.patrol_path_id, s.link_group_id, s.pool_id,
  ];
}

/** Insert when id is missing, update otherwise. Returns the row id. */
async function upsert(table: string, columns: readonly string[], values: any[], id: number | null): Promise<number> {
  if (id && id > 0) {
    const assignments = columns.map((c) => `${quote(c)} = ?`).join(", ");
    await query(`UPDATE ${table} SET ${assignments} WHERE id = ?`, [...values, id]);
    return id;
  }
  const placeholders = columns.map(() => "?").join(", ");
  const result = (await query(
    `INSERT INTO ${table} (${columns.map(quote).join(", ")}) VALUES (${placeholders})`,
    values
  )) as any;
  return Number(result?.lastInsertRowid ?? result?.insertId ?? 0);
}

async function select(table: string): Promise<any[]> {
  try {
    const rows = await query<any>(`SELECT * FROM ${table}`);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    // An existing database that predates the creature tables must not stop
    // the server from booting; the setup script creates them.
    log.warn(`Could not read ${table} (run the database setup script): ${error}`);
    return [];
  }
}

const repository = {
  async listTemplates(): Promise<CreatureTemplate[]> {
    return (await select("creature_templates")).map(normalizeTemplate);
  },
  async listAbilities(): Promise<CreatureAbility[]> {
    return (await select("creature_abilities")).map(normalizeAbility);
  },
  async listSpawns(): Promise<CreatureSpawn[]> {
    return (await select("creature_spawns")).map(normalizeSpawn);
  },
  async listPatrolPaths(): Promise<CreaturePatrolPath[]> {
    return (await select("creature_patrol_paths")).map(normalizePatrolPath);
  },
  async listLinkGroups(): Promise<CreatureLinkGroup[]> {
    return (await select("creature_link_groups")).map(normalizeLinkGroup);
  },
  async listSpawnPools(): Promise<CreatureSpawnPool[]> {
    return (await select("creature_spawn_pools")).map(normalizeSpawnPool);
  },


  async saveTemplate(input: any): Promise<number> {
    const template = normalizeTemplate(input);
    return upsert("creature_templates", TEMPLATE_COLUMNS, templateValues(template), template.id || null);
  },
  async deleteTemplate(id: number): Promise<void> {
    await query("DELETE FROM creature_abilities WHERE template_id = ?", [id]);
    await query("DELETE FROM creature_spawns WHERE template_id = ?", [id]);
    await query("DELETE FROM creature_templates WHERE id = ?", [id]);
  },

  async saveAbility(input: any): Promise<number> {
    const ability = normalizeAbility(input);
    return upsert("creature_abilities", ABILITY_COLUMNS, abilityValues(ability), ability.id || null);
  },
  async deleteAbility(id: number): Promise<void> {
    await query("DELETE FROM creature_abilities WHERE id = ?", [id]);
  },

  async saveSpawn(input: any): Promise<number> {
    const spawn = normalizeSpawn(input);
    return upsert("creature_spawns", SPAWN_COLUMNS, spawnValues(spawn), spawn.id || null);
  },
  async deleteSpawn(id: number): Promise<void> {
    await query("DELETE FROM creature_spawns WHERE id = ?", [id]);
  },

  async savePatrolPath(input: any): Promise<number> {
    const path = normalizePatrolPath(input);
    return upsert("creature_patrol_paths", PATH_COLUMNS, [path.map, path.loop ? 1 : 0, JSON.stringify(path.points)], path.id || null);
  },
  async deletePatrolPath(id: number): Promise<void> {
    await query("UPDATE creature_spawns SET patrol_path_id = NULL WHERE patrol_path_id = ?", [id]);
    await query("DELETE FROM creature_patrol_paths WHERE id = ?", [id]);
  },

  async saveLinkGroup(input: any): Promise<number> {
    const name = String(input?.name ?? "").slice(0, 255);
    const id = Number(input?.id) || 0;
    return upsert("creature_link_groups", ["name"], [name], id || null);
  },
  async deleteLinkGroup(id: number): Promise<void> {
    await query("UPDATE creature_spawns SET link_group_id = NULL WHERE link_group_id = ?", [id]);
    await query("DELETE FROM creature_link_groups WHERE id = ?", [id]);
  },

  async saveSpawnPool(input: any): Promise<number> {
    const pool = normalizeSpawnPool(input);
    return upsert("creature_spawn_pools", POOL_COLUMNS, [pool.max_active, pool.rare_chance_pct, pool.rare_template_id], pool.id || null);
  },
  async deleteSpawnPool(id: number): Promise<void> {
    await query("UPDATE creature_spawns SET pool_id = NULL WHERE pool_id = ?", [id]);
    await query("DELETE FROM creature_spawn_pools WHERE id = ?", [id]);
  },

  /** Load every creature table into assetCache. */
  async loadIntoCache(): Promise<void> {
    const [templates, abilities, spawns, patrolPaths, linkGroups, pools] = await Promise.all([
      this.listTemplates(),
      this.listAbilities(),
      this.listSpawns(),
      this.listPatrolPaths(),
      this.listLinkGroups(),
      this.listSpawnPools(),
    ]);
    await assetCache.add(CACHE_KEYS.templates, templates);
    await assetCache.add(CACHE_KEYS.abilities, abilities);
    await assetCache.add(CACHE_KEYS.spawns, spawns);
    await assetCache.add(CACHE_KEYS.patrolPaths, patrolPaths);
    await assetCache.add(CACHE_KEYS.linkGroups, linkGroups);
    await assetCache.add(CACHE_KEYS.pools, pools);
  },
};

export default repository;
