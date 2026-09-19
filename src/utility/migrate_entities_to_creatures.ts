/**
 * One-off migration from the legacy entity system to creatures.
 *
 *   bun --env-file=.env.development ./src/utility/migrate_entities_to_creatures.ts [--dry-run] [--drop-legacy]
 *
 * --drop-legacy drops `entities` and `entity_spawn_points` after the migration
 * succeeds. It is ignored with --dry-run and cannot be undone.
 *
 * Every `entities` row becomes a creature template plus a spawn at the
 * entity's own position. Every `entity_spawn_points` row becomes an extra
 * spawn for the template created from its entity. Rows that were already
 * migrated (same name, map and level as an existing template) are skipped, so
 * the script is safe to run more than once. Anything that cannot be carried
 * over exactly is logged.
 */
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { YARD_PX, PLAYER_RUN_PX_PER_SEC, WOW_RUN_YD_PER_SEC } from "../systems/creatures/constants";
import repository from "../systems/creatures/repository";

const dryRun = process.argv.includes("--dry-run");
const dropLegacy = process.argv.includes("--drop-legacy");

/** The legacy AI ticked every 16ms and moved `speed` pixels per tick. */
const LEGACY_TICK_MS = 16;
const LEGACY_ATTACK_MS = 1000;
const LEGACY_RESPAWN_S = 30;
const WALK_TO_RUN_RATIO = 2.5 / 7;

export interface LegacyEntityRow {
  id: number;
  name: string | null;
  map: string;
  position: string;
  direction?: string | null;
  aggro_type?: string | null;
  level?: number | null;
  max_health?: number | null;
  aggro_range?: number | null;
  speed?: number | string | null;
  aggro_leash?: number | null;
  entity_type?: string | null;
  loot_table_id?: number | null;
  sprite_body?: string | null;
  sprite_head?: string | null;
  sprite_type?: string | null;
}

export interface LegacySpawnPointRow {
  id: number;
  entity_template_id: number;
  map: string;
  position: string;
  respawn_time?: number | null;
  max_spawns?: number | null;
}

const parsePosition = (raw: string): { x: number; y: number } => {
  const [x, y] = String(raw ?? "0,0").split(",").map((n) => Number(n) || 0);
  return { x, y };
};

/** Legacy stance names -> creature stances. Friendly entities could not be attacked; passive is the closest fit. */
export function mapStance(aggroType: string | null | undefined, warnings: string[], label: string): "aggressive" | "neutral" | "passive" {
  switch (String(aggroType ?? "neutral").toLowerCase()) {
    case "aggressive":
    case "hostile":
      return "aggressive";
    case "friendly":
    case "passive":
      if (String(aggroType).toLowerCase() === "friendly") {
        warnings.push(`${label}: was "friendly" (unattackable); migrated as passive, which players can attack.`);
      }
      return "passive";
    default:
      return "neutral";
  }
}

/** Convert one legacy entity row into a creature template input. */
export function entityToTemplate(row: LegacyEntityRow, warnings: string[]): Record<string, unknown> {
  const label = `entity #${row.id} (${row.name ?? "unnamed"})`;
  const level = Math.max(1, Number(row.level) || 1);
  const legacySpeed = Number(row.speed) || 2;
  const runPxPerSec = (legacySpeed * 1000) / LEGACY_TICK_MS;
  const runYdPerSec = Math.round(((runPxPerSec * WOW_RUN_YD_PER_SEC) / PLAYER_RUN_PX_PER_SEC) * 100) / 100;
  const legacyDamage = Math.round(5 + level * 1.5);
  const rank = String(row.entity_type ?? "normal").toLowerCase() === "boss" ? "boss" : "normal";

  if (row.entity_type && !["normal", "boss"].includes(String(row.entity_type).toLowerCase())) {
    warnings.push(`${label}: unknown entity_type "${row.entity_type}" migrated as normal.`);
  }

  return {
    id: 0,
    name: String(row.name ?? "").trim() || `Creature ${row.id}`,
    subname: null,
    level_min: level,
    level_max: level,
    rank,
    creature_type: "humanoid",
    stance: mapStance(row.aggro_type, warnings, label),
    health_base: Math.max(1, Number(row.max_health) || 100),
    health_per_level: 0,
    armor: 0,
    damage_min: Math.max(1, legacyDamage - 2),
    damage_max: legacyDamage + 2,
    attack_speed_ms: LEGACY_ATTACK_MS,
    ranged: false,
    move_speed_walk: Math.round(runYdPerSec * WALK_TO_RUN_RATIO * 100) / 100,
    move_speed_run: runYdPerSec,
    aggro_radius_override: row.aggro_range ? Math.round((Number(row.aggro_range) / YARD_PX) * 10) / 10 : null,
    assist_radius: 10,
    call_for_help_radius: 15,
    flee_at_hp_pct: 0,
    flee_duration_ms: 4000,
    leash_override: row.aggro_leash ? Math.round((Number(row.aggro_leash) / YARD_PX) * 10) / 10 : null,
    regen_ooc: true,
    xp_mult: 1,
    loot_table_id: row.loot_table_id ?? null,
    gold_min: 0,
    gold_max: 0,
    sprite_type: row.sprite_body ? (row.sprite_type === "static" ? "static" : "animated") : "none",
    sprite: row.sprite_body ?? null,
    sprite_head: row.sprite_head ?? null,
    scale: 1,
    flags: 0,
  };
}

export function spawnInput(templateId: number, map: string, position: string, direction: string | null | undefined, respawnSeconds: number): Record<string, unknown> {
  const { x, y } = parsePosition(position);
  return {
    id: 0,
    template_id: templateId,
    map: String(map).replace(".json", ""),
    x,
    y,
    direction: direction || "down",
    layer_policy: "per_layer",
    respawn_min_s: respawnSeconds,
    respawn_max_s: respawnSeconds,
    wander_radius: 0,
    movement_type: "idle",
    patrol_path_id: null,
    link_group_id: null,
    pool_id: null,
  };
}

async function tableExists(table: string): Promise<boolean> {
  try {
    await query(`SELECT 1 FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

async function migrate(): Promise<void> {
  if (!(await tableExists("entities"))) {
    log.info("No legacy entities table found; nothing to migrate.");
    return;
  }
  if (!(await tableExists("creature_templates"))) {
    throw new Error("creature_templates is missing. Run the database setup script first.");
  }

  const entities = (await query("SELECT * FROM entities")) as LegacyEntityRow[];
  const spawnPoints = (await tableExists("entity_spawn_points"))
    ? ((await query("SELECT * FROM entity_spawn_points")) as LegacySpawnPointRow[])
    : [];
  const existing = await repository.listTemplates();
  const existingSpawns = await repository.listSpawns();

  const warnings: string[] = [];
  const templateForEntity = new Map<number, number>();
  let templatesCreated = 0;
  let spawnsCreated = 0;
  let skipped = 0;

  for (const row of entities) {
    const input = entityToTemplate(row, warnings);
    const map = String(row.map).replace(".json", "");
    const already = existing.find((t) => t.name === input.name && t.level_min === input.level_min);
    const { x, y } = parsePosition(row.position);
    const spawnExists = already && existingSpawns.some((s) => s.template_id === already.id && s.map === map && s.x === x && s.y === y);

    if (already && spawnExists) {
      templateForEntity.set(row.id, already.id);
      skipped++;
      continue;
    }

    let templateId = already?.id ?? 0;
    if (!already) {
      if (dryRun) {
        templateId = -row.id;
      } else {
        templateId = await repository.saveTemplate(input);
        existing.push({ ...(input as any), id: templateId });
      }
      templatesCreated++;
    }
    templateForEntity.set(row.id, templateId);

    const pointsForEntity = spawnPoints.filter((p) => p.entity_template_id === row.id);
    const respawn = pointsForEntity[0]?.respawn_time ? Math.round(Number(pointsForEntity[0].respawn_time) / 1000) : LEGACY_RESPAWN_S;
    if (!dryRun) await repository.saveSpawn(spawnInput(templateId, map, row.position, row.direction, respawn));
    spawnsCreated++;
  }

  for (const point of spawnPoints) {
    const templateId = templateForEntity.get(point.entity_template_id);
    if (templateId === undefined) {
      warnings.push(`spawn point #${point.id}: entity #${point.entity_template_id} no longer exists; skipped.`);
      continue;
    }
    if ((Number(point.max_spawns) || 1) > 1) {
      warnings.push(`spawn point #${point.id}: max_spawns ${point.max_spawns} became a single spawn; add more spawns in the editor if needed.`);
    }
    const { x, y } = parsePosition(point.position);
    const map = String(point.map).replace(".json", "");
    if (existingSpawns.some((s) => s.template_id === templateId && s.map === map && s.x === x && s.y === y)) {
      skipped++;
      continue;
    }
    const respawn = Math.max(1, Math.round((Number(point.respawn_time) || LEGACY_RESPAWN_S * 1000) / 1000));
    if (!dryRun) await repository.saveSpawn(spawnInput(templateId, map, point.position, "down", respawn));
    spawnsCreated++;
  }

  if (entities.some((e) => (e as any).particles)) {
    warnings.push("Entity particles are not supported by creatures and were not migrated.");
  }
  warnings.push("Creature type defaulted to humanoid for all migrated creatures; adjust beasts/critters in the editor.");

  for (const w of warnings) log.warn(w);
  if (dropLegacy && !dryRun) {
    if (await tableExists("entity_spawn_points")) await query("DROP TABLE entity_spawn_points");
    await query("DROP TABLE entities");
    log.warn("Dropped legacy tables entities and entity_spawn_points.");
  }

  log.success(
    `${dryRun ? "[dry run] " : ""}Migrated ${entities.length} entit(ies) and ${spawnPoints.length} spawn point(s): ` +
      `${templatesCreated} template(s) and ${spawnsCreated} spawn(s) created, ${skipped} already migrated.`
  );
}

if (import.meta.main) {
  try {
    await migrate();
    process.exit(0);
  } catch (error) {
    log.error(`Entity migration failed: ${error}`);
    process.exit(1);
  }
}
