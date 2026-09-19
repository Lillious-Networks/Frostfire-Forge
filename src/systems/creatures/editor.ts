/**
 * Creature editor: validation and CRUD dispatch for the admin editor window.
 * Every packet is permission-checked by the caller and validated here before
 * anything is written.
 */
import assetCache from "../../services/assetCache";
import log from "../../modules/logger";
import { serverFetch } from "../../modules/https_servers.ts";
import lootTable from "../lootTable";
import { yards } from "./constants";
import type { NavGridCache } from "./navgrid";
import repository from "./repository";
import type { CreatureAbility, CreaturePatrolPath, CreatureSpawn, CreatureSpawnPool, CreatureTemplate } from "./types";

export const EDITOR_PERMISSION = "tools.creature_editor";
export const EDITOR_WILDCARD = "tools.*";

const STANCES = new Set(["aggressive", "neutral", "passive"]);
const RANKS = new Set(["normal", "elite", "rare", "rare_elite", "boss"]);
const MOVEMENT_TYPES = new Set(["idle", "wander", "patrol"]);
const LAYER_POLICIES = new Set(["per_layer", "shared"]);
export const ABILITY_TRIGGERS = ["combat_timer", "hp_below", "on_aggro", "on_death", "on_evade", "target_casting", "ooc_timer"];
export const ABILITY_TARGET_MODES = ["current", "random", "random_not_top", "farthest", "lowest_hp_ally", "self"];

/** Admins and holders of tools.creature_editor / tools.* may use the editor. */
export function canUseEditor(player: any): boolean {
  if (!player) return false;
  if (player.isAdmin) return true;
  const permissions: string[] = Array.isArray(player.permissions) ? player.permissions : [];
  return permissions.some((p) => p === EDITOR_PERMISSION || p === EDITOR_WILDCARD || p === "server.*");
}

export interface EditorData {
  templates: CreatureTemplate[];
  abilities: CreatureAbility[];
  spawns: CreatureSpawn[];
  patrolPaths: CreaturePatrolPath[];
  linkGroups: Array<{ id: number; name: string }>;
  pools: CreatureSpawnPool[];
  spells: Array<{ id: number; name: string; icon: string | null }>;
  lootTables: Array<{ id: number; name: string }>;
  maps: string[];
  triggers: string[];
  targetModes: string[];
  /** Sprite sheets the asset server has, grouped by slot, with preview images. */
  spriteSheets: Record<string, SpriteSheetOption[]>;
  /** Icons the asset server has, for static creature sprites. */
  icons: SpriteSheetOption[];
}

export interface SpriteSheetOption {
  name: string;
  /** Preview image URL, or null when the sheet is template-only. */
  image: string | null;
}

/**
 * Editor image URLs are asset-server PATHS, not absolute URLs: the game server
 * reaches the asset server on an internal address (a container name in Docker)
 * that a browser cannot resolve. The editor window prefixes these with the
 * asset server URL the client was configured with.
 */
const iconPath = (name: string | null): string | null =>
  name ? `/icon?name=${encodeURIComponent(name.replace(/\.(png|jpg|jpeg|gif)$/i, ""))}` : null;

const spritePath = (name: string | null): string | null =>
  name ? `/sprite?name=${encodeURIComponent(name.replace(/\.(png|jpg|jpeg|gif)$/i, ""))}` : null;

/** Sprite sheets by slot, cached after the first successful fetch. */
let spriteSheetCache: Record<string, SpriteSheetOption[]> | null = null;

/** Ask the asset server which sprite sheets exist, so the editor can offer them per slot. */
export async function listSpriteSheets(force = false): Promise<Record<string, SpriteSheetOption[]>> {
  if (spriteSheetCache && !force) return spriteSheetCache;
  const assetServerUrl = process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL;
  if (!assetServerUrl) return {};
  try {
    const response = await serverFetch(`${assetServerUrl}/sprite-sheets`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const body = (await response.json()) as { spriteSheets?: Array<{ name: string; slot?: string; icon?: string | null; hasImage?: boolean }> };
    // Equipment sheets are named after the item that wears them, so the item's
    // own icon is the right preview. A sheet image is a strip of frames and is
    // unreadable as a thumbnail, so it is never used.
    const items = ((await assetCache.get("items")) || []) as Item[];
    const iconByItem = new Map(items.filter((i) => i?.name).map((i) => [i.name.toLowerCase(), iconPath(i.icon ?? null)]));

    const bySlot: Record<string, SpriteSheetOption[]> = {};
    for (const sheet of body?.spriteSheets ?? []) {
      if (!sheet?.name || sheet.hasImage === false) continue;
      const slot = sheet.slot || "other";
      const itemIcon = iconByItem.get(sheet.name.toLowerCase()) ?? null;
      (bySlot[slot] ??= []).push({
        name: sheet.name,
        image: itemIcon ?? iconPath(sheet.icon ?? null),
      });
    }
    for (const sheets of Object.values(bySlot)) sheets.sort((a, b) => a.name.localeCompare(b.name));
    spriteSheetCache = bySlot;
    return bySlot;
  } catch (error) {
    // The editor still works with free-text sprite names when the asset server is unreachable.
    log.warn(`Could not list sprite sheets for the creature editor: ${(error as Error).message}`);
    return spriteSheetCache ?? {};
  }
}

/** Icons, cached after the first successful fetch. */
let iconCache: SpriteSheetOption[] | null = null;

/** Ask the asset server which icons exist, so static sprites can be picked visually. */
export async function listIcons(force = false): Promise<SpriteSheetOption[]> {
  if (iconCache && !force) return iconCache;
  const assetServerUrl = process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL;
  if (!assetServerUrl) return [];
  try {
    const response = await serverFetch(`${assetServerUrl}/icons`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const body = (await response.json()) as { icons?: Array<{ name: string }> };
    iconCache = (body?.icons ?? [])
      .filter((i) => i?.name)
      .map((i) => ({ name: i.name, image: iconPath(i.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (iconCache.length === 0) {
      // An older asset server has no /icons route and redirects to its homepage.
      log.warn(`Asset server returned no icons for the editors (${assetServerUrl}/icons) - is it running the current build?`);
    }
    return iconCache;
  } catch (error) {
    log.warn(`Could not list icons for the creature editor: ${(error as Error).message}`);
    return iconCache ?? [];
  }
}

/** Everything the editor window needs in one payload. */
export async function buildEditorData(): Promise<EditorData> {
  const [templates, abilities, spawns, patrolPaths, linkGroups, pools] = await Promise.all([
    repository.listTemplates(),
    repository.listAbilities(),
    repository.listSpawns(),
    repository.listPatrolPaths(),
    repository.listLinkGroups(),
    repository.listSpawnPools(),
  ]);
  const spells = (((await assetCache.get("spells")) || []) as SpellData[])
    .filter((s) => s?.id != null)
    .map((s) => ({ id: Number(s.id), name: s.name, icon: spritePath((s as any).icon ?? null) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  let lootTables: Array<{ id: number; name: string }> = [];
  try {
    lootTables = ((await lootTable.list()) as any[]).map((t) => ({ id: Number(t.id), name: String(t.name) }));
  } catch {
    lootTables = [];
  }
  const maps = (((await assetCache.get("mapProperties")) || []) as any[])
    .map((m) => String(m?.name ?? "").replace(".json", ""))
    .filter(Boolean)
    .sort();

  const [spriteSheets, icons] = await Promise.all([listSpriteSheets(), listIcons()]);

  return { templates, abilities, spawns, patrolPaths, linkGroups, pools, spells, lootTables, maps, triggers: ABILITY_TRIGGERS, targetModes: ABILITY_TARGET_MODES, spriteSheets, icons };
}

const num = (v: any) => Number(v);
const isInt = (v: any) => Number.isFinite(num(v));

export interface ValidationContext {
  templateIds: Set<number>;
  spellIds: Set<number>;
  lootTableIds: Set<number>;
  pathIds: Map<number, string>;
  linkGroupIds: Set<number>;
  poolIds: Set<number>;
  maps: Set<string>;
  navGrids: NavGridCache;
}

export function validateTemplate(input: any, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const name = String(input?.name ?? "").trim();
  if (!name) errors.push("Name is required.");
  if (name.length > 255) errors.push("Name must be 255 characters or fewer.");
  if (!isInt(input?.level_min) || num(input.level_min) < 1) errors.push("Minimum level must be at least 1.");
  if (num(input?.level_max) < num(input?.level_min)) errors.push("Maximum level cannot be below minimum level.");
  if (!STANCES.has(String(input?.stance))) errors.push("Stance must be aggressive, neutral or passive.");
  if (!RANKS.has(String(input?.rank))) errors.push("Rank is not valid.");
  if (num(input?.health_base) < 1) errors.push("Base health must be at least 1.");
  if (num(input?.scale) <= 0) errors.push("Scale must be greater than 0.");
  if (num(input?.flee_at_hp_pct) < 0 || num(input?.flee_at_hp_pct) > 100) errors.push("Flee health must be between 0 and 100.");
  if (num(input?.gold_max) < num(input?.gold_min)) errors.push("Maximum money cannot be below minimum money.");
  const spriteType = String(input?.sprite_type ?? "none");
  if (!["animated", "static", "none"].includes(spriteType)) errors.push("Sprite type must be animated, static or none.");
  else if (spriteType !== "none" && !String(input?.sprite ?? "").trim()) errors.push("A sprite name is required unless the sprite type is none.");
  const lootTableId = input?.loot_table_id;
  if (lootTableId !== null && lootTableId !== undefined && lootTableId !== "" && !ctx.lootTableIds.has(num(lootTableId))) {
    errors.push("Loot table does not exist.");
  }
  return errors;
}

export function validateAbility(input: any, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  if (!ctx.templateIds.has(num(input?.template_id))) errors.push("Creature template does not exist.");
  if (!ctx.spellIds.has(num(input?.spell_id))) errors.push("Spell does not exist.");
  if (!ABILITY_TRIGGERS.includes(String(input?.trigger))) errors.push("Trigger is not valid.");
  if (!ABILITY_TARGET_MODES.includes(String(input?.target_mode))) errors.push("Target mode is not valid.");
  if (num(input?.cooldown_max_ms) < num(input?.cooldown_min_ms)) errors.push("Maximum cooldown cannot be below minimum cooldown.");
  if (num(input?.initial_cd_max_ms) < num(input?.initial_cd_min_ms)) errors.push("Maximum initial delay cannot be below minimum.");
  if (num(input?.chance_pct) < 0 || num(input?.chance_pct) > 100) errors.push("Chance must be between 0 and 100.");
  if (String(input?.trigger) === "hp_below" && (num(input?.trigger_value) <= 0 || num(input?.trigger_value) > 100)) {
    errors.push("Health threshold must be between 1 and 100.");
  }
  return errors;
}

export interface AbilitySetPlan {
  errors: string[];
  /** Abilities to write, in order, all bound to the template. id 0 = insert. */
  upserts: any[];
  /** Existing abilities of the template that are no longer in the set. */
  deleteIds: number[];
}

/**
 * Replace a creature's whole ability list with `incoming` (the editor saves a
 * creature's abilities together). Every entry is validated first; errors name
 * the entry by position and spell. An incoming id is only kept when it is one
 * of this template's own abilities - anything else is inserted fresh, so an
 * edit can never rewrite another creature's ability.
 */
export function planAbilitySet(
  templateId: number,
  incoming: unknown,
  existing: Array<{ id: number; template_id: number }>,
  ctx: ValidationContext,
  spellName: (spellId: number) => string | undefined
): AbilitySetPlan {
  if (!ctx.templateIds.has(templateId)) return { errors: ["Creature template does not exist."], upserts: [], deleteIds: [] };
  const list: any[] = Array.isArray(incoming) ? incoming : [];
  const own = new Set(existing.filter((a) => a.template_id === templateId).map((a) => a.id));

  const errors: string[] = [];
  list.forEach((ability, i) => {
    const name = spellName(num(ability?.spell_id)) ?? "no spell";
    for (const error of validateAbility({ ...ability, template_id: templateId }, ctx)) {
      errors.push(`Ability ${i + 1} (${name}): ${error}`);
    }
  });
  if (errors.length) return { errors, upserts: [], deleteIds: [] };

  const upserts = list.map((ability) => ({
    ...ability,
    template_id: templateId,
    id: own.has(num(ability?.id)) ? num(ability.id) : 0,
  }));
  const kept = new Set(upserts.map((a) => a.id).filter(Boolean));
  const deleteIds = [...own].filter((id) => !kept.has(id));
  return { errors: [], upserts, deleteIds };
}

export function validateSpawn(input: any, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const map = String(input?.map ?? "").replace(".json", "");
  if (!ctx.templateIds.has(num(input?.template_id))) errors.push("Creature template does not exist.");
  if (!ctx.maps.has(map)) errors.push(`Map "${map}" does not exist.`);
  if (!isInt(input?.x) || !isInt(input?.y)) errors.push("Position must be numeric.");
  if (!LAYER_POLICIES.has(String(input?.layer_policy))) errors.push("Layer policy is not valid.");
  if (!MOVEMENT_TYPES.has(String(input?.movement_type))) errors.push("Movement type is not valid.");
  if (num(input?.respawn_max_s) < num(input?.respawn_min_s)) errors.push("Maximum respawn cannot be below minimum respawn.");
  if (String(input?.movement_type) === "wander" && num(input?.wander_radius) <= 0) errors.push("Wander movement needs a wander radius.");

  const pathId = input?.patrol_path_id;
  if (pathId !== null && pathId !== undefined && pathId !== "") {
    const pathMap = ctx.pathIds.get(num(pathId));
    if (pathMap === undefined) errors.push("Patrol path does not exist.");
    else if (pathMap !== map) errors.push("Patrol path belongs to a different map.");
  } else if (String(input?.movement_type) === "patrol") {
    errors.push("Patrol movement needs a patrol path.");
  }
  if (input?.link_group_id && !ctx.linkGroupIds.has(num(input.link_group_id))) errors.push("Link group does not exist.");
  if (input?.pool_id && !ctx.poolIds.has(num(input.pool_id))) errors.push("Spawn pool does not exist.");

  const grid = ctx.navGrids.get(map);
  if (grid && isInt(input?.x) && isInt(input?.y) && !grid.isWalkable(num(input.x), num(input.y))) {
    errors.push("That position is inside collision.");
  }
  return errors;
}

export function validatePatrolPath(input: any, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const map = String(input?.map ?? "").replace(".json", "");
  if (!ctx.maps.has(map)) errors.push(`Map "${map}" does not exist.`);
  // The editor sends points as an array; accept a points_json string/array too
  // so no client shape is rejected outright.
  let points = Array.isArray(input?.points) ? input.points : [];
  if (points.length === 0 && input?.points_json !== undefined && input?.points_json !== null && input?.points_json !== "") {
    if (Array.isArray(input.points_json)) points = input.points_json;
    else if (typeof input.points_json === "string") {
      try {
        const parsed = JSON.parse(input.points_json);
        if (Array.isArray(parsed)) points = parsed;
      } catch {
        // Falls through to the length check below.
      }
    }
  }
  if (points.length < 2) errors.push("A patrol path needs at least two points.");
  const grid = ctx.navGrids.get(map);
  points.forEach((p: any, i: number) => {
    if (!isInt(p?.x) || !isInt(p?.y)) errors.push(`Point ${i + 1} has an invalid position.`);
    else if (grid && !grid.isWalkable(num(p.x), num(p.y))) errors.push(`Point ${i + 1} is inside collision.`);
  });
  return errors;
}

export function validatePool(input: any, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  if (num(input?.max_active) < 1) errors.push("Max active must be at least 1.");
  if (num(input?.rare_chance_pct) < 0 || num(input?.rare_chance_pct) > 100) errors.push("Rare chance must be between 0 and 100.");
  const rare = input?.rare_template_id;
  if (rare !== null && rare !== undefined && rare !== "" && !ctx.templateIds.has(num(rare))) errors.push("Rare template does not exist.");
  return errors;
}

export function validateLinkGroup(input: any): string[] {
  return String(input?.name ?? "").trim() ? [] : ["Link group name is required."];
}

/** Aggro/leash/assist circles the client draws, in pixels. */
export function debugRadii(template: CreatureTemplate, viewerLevel: number, creatureLevel: number, spawn: CreatureSpawn | undefined) {
  const base = template.aggro_radius_override ?? 20;
  const aggroYd = Math.min(45, Math.max(5, base + (creatureLevel - viewerLevel)));
  return {
    aggro: yards(aggroYd),
    assist: yards(template.assist_radius),
    callForHelp: yards(template.call_for_help_radius),
    leash: yards(template.leash_override ?? 60),
    wander: yards(spawn?.wander_radius ?? 0),
  };
}
