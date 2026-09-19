/**
 * Item editor: validation and CRUD for the admin item editor window.
 * Items are keyed by name, so a rename creates a new row - the editor sends the
 * original name along with a save so a rename can update in place instead.
 */
import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import { listIcons, type SpriteSheetOption } from "./creatures/editor";

export const EDITOR_PERMISSION = "tools.item_editor";
export const EDITOR_WILDCARD = "tools.*";

export const ITEM_TYPES: ItemType[] = ["consumable", "equipment", "material", "quest", "miscellaneous"];
export const ITEM_QUALITIES: ItemQuality[] = ["common", "uncommon", "rare", "epic", "legendary"];
export const ITEM_SLOTS: ItemSlot[] = [
  "helmet", "necklace", "shoulderguards", "cape", "chestplate", "wristguards", "gloves",
  "belt", "pants", "boots", "ring_1", "ring_2", "trinket_1", "trinket_2", "weapon", "bag",
];

/** Admins and holders of tools.item_editor / tools.* may use the editor. */
export function canUseEditor(player: any): boolean {
  if (!player) return false;
  if (player.isAdmin) return true;
  const permissions: string[] = Array.isArray(player.permissions) ? player.permissions : [];
  return permissions.some((p) => p === EDITOR_PERMISSION || p === EDITOR_WILDCARD || p === "server.*");
}

/** Results per search. Editors search rather than browse, so this stays small. */
export const SEARCH_LIMIT = 50;

export interface ItemEditorData {
  types: string[];
  qualities: string[];
  slots: string[];
  /** Icons the asset server has, for the icon picker. */
  icons: SpriteSheetOption[];
  itemCount: number;
}

/** The editor opens with no items: they are fetched by search. */
export async function buildEditorData(): Promise<ItemEditorData> {
  const items = ((await assetCache.get("items")) || []) as Item[];
  return {
    types: ITEM_TYPES,
    qualities: ITEM_QUALITIES,
    slots: ITEM_SLOTS,
    icons: await listIcons(),
    itemCount: items.length,
  };
}

export interface ItemSearchResult {
  query: string;
  items: Item[];
  /** Matches beyond the ones returned, so the editor can say "narrow it down". */
  truncated: number;
}

/**
 * Name search over the cached items. An empty query returns nothing rather than
 * everything: the editor is for finding a known item, not browsing the table.
 */
export async function searchItems(rawQuery: unknown, exactName?: string | null): Promise<ItemSearchResult> {
  const query = String(rawQuery ?? "").trim().toLowerCase();
  const all = ((await assetCache.get("items")) || []) as Item[];
  if (!query) {
    // Still return a named item so a freshly saved one can stay selected.
    const exact = exactName ? all.filter((i) => i.name.toLowerCase() === exactName.toLowerCase()) : [];
    return { query: "", items: exact, truncated: 0 };
  }

  const matches = all
    .filter((i) => i.name.toLowerCase().includes(query))
    .sort((a, b) => {
      // Names that start with the query are what the user usually means.
      const aStarts = a.name.toLowerCase().startsWith(query);
      const bStarts = b.name.toLowerCase().startsWith(query);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return {
    query,
    items: matches.slice(0, SEARCH_LIMIT),
    truncated: Math.max(0, matches.length - SEARCH_LIMIT),
  };
}

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** Shapes editor input into a row, dropping anything the table does not hold. */
export function normalizeItem(input: any): Item {
  const type = ITEM_TYPES.includes(input?.type) ? input.type : "miscellaneous";
  const equipable = !!input?.equipable && type === "equipment";
  const slot = ITEM_SLOTS.includes(input?.equipment_slot) ? (input.equipment_slot as ItemSlot) : null;
  return {
    name: String(input?.name ?? "").trim(),
    quality: ITEM_QUALITIES.includes(input?.quality) ? input.quality : "common",
    type,
    description: String(input?.description ?? "").trim(),
    icon: input?.icon ? String(input.icon) : null,
    stat_armor: num(input?.stat_armor),
    stat_damage: num(input?.stat_damage),
    stat_critical_chance: num(input?.stat_critical_chance),
    stat_critical_damage: num(input?.stat_critical_damage),
    stat_health: num(input?.stat_health),
    stat_stamina: num(input?.stat_stamina),
    stat_avoidance: num(input?.stat_avoidance),
    level_requirement: num(input?.level_requirement),
    equipable,
    equipment_slot: equipable ? slot : null,
    bag_slots: num(input?.bag_slots),
    damage_min: num(input?.damage_min),
    damage_max: num(input?.damage_max),
    attack_speed_ms: num(input?.attack_speed_ms),
  };
}

export function validateItem(input: any, existingNames: Set<string>, originalName: string | null): string[] {
  const errors: string[] = [];
  const item = normalizeItem(input);

  if (!item.name) errors.push("Name is required.");
  if (item.name.length > 255) errors.push("Name must be 255 characters or fewer.");
  // Names are the primary key, so a new or renamed item cannot take a used one.
  const renamed = originalName !== null && originalName.toLowerCase() !== item.name.toLowerCase();
  if ((originalName === null || renamed) && existingNames.has(item.name.toLowerCase())) {
    errors.push("An item with that name already exists.");
  }
  if (!ITEM_TYPES.includes(item.type)) errors.push("Type is not valid.");
  if (!ITEM_QUALITIES.includes(item.quality)) errors.push("Quality is not valid.");
  if (item.description.length > 255) errors.push("Description must be 255 characters or fewer.");
  if (item.equipable && !item.equipment_slot) errors.push("Equipable items need an equipment slot.");
  if (!!input?.equipable && item.type !== "equipment") errors.push("Only equipment can be equipable.");
  if (item.level_requirement !== null && item.level_requirement < 1) errors.push("Level requirement must be at least 1.");
  if (item.bag_slots !== null && item.bag_slots < 0) errors.push("Bag slots cannot be negative.");

  const min = item.damage_min;
  const max = item.damage_max;
  if (min !== null && min < 1) errors.push("Minimum damage must be at least 1.");
  if (max !== null && max < 1) errors.push("Maximum damage must be at least 1.");
  if (min !== null && max !== null && max < min) errors.push("Maximum damage cannot be below minimum damage.");
  if (item.attack_speed_ms !== null && item.attack_speed_ms < 500) errors.push("Attack speed must be at least 500ms.");
  if ((min !== null || max !== null || item.attack_speed_ms !== null) && item.equipment_slot !== "weapon") {
    errors.push("Weapon damage and speed only apply to items in the weapon slot.");
  }
  return errors;
}

const COLUMNS = [
  "name", "quality", "type", "description", "icon", "stat_armor", "stat_damage",
  "stat_critical_chance", "stat_critical_damage", "stat_health", "stat_stamina",
  "stat_avoidance", "level_requirement", "equipable", "equipment_slot",
  "damage_min", "damage_max", "attack_speed_ms",
];

const values = (item: Item) => [
  item.name, item.quality, item.type, item.description, item.icon, item.stat_armor, item.stat_damage,
  item.stat_critical_chance, item.stat_critical_damage, item.stat_health, item.stat_stamina,
  item.stat_avoidance, item.level_requirement, item.equipable ? 1 : 0, item.equipment_slot,
  item.damage_min, item.damage_max, item.attack_speed_ms,
];

/** Insert or update by name, then refresh the cache every system reads from. */
export async function saveItem(input: any, originalName: string | null): Promise<Item> {
  const item = normalizeItem(input);
  const existing = originalName ?? item.name;
  const rows = (await query("SELECT name FROM items WHERE name = ?", [existing])) as any[];

  if (rows.length > 0) {
    await query(
      `UPDATE items SET ${COLUMNS.map((c) => `${c} = ?`).join(", ")} WHERE name = ?`,
      [...values(item), existing]
    );
  } else {
    await query(
      `INSERT INTO items (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
      values(item)
    );
  }

  const items = ((await assetCache.get("items")) || []) as Item[];
  const index = items.findIndex((i) => i.name.toLowerCase() === existing.toLowerCase());
  if (index === -1) items.push(item);
  else items[index] = item;
  await assetCache.set("items", items);
  return item;
}

export async function deleteItem(name: string): Promise<void> {
  await query("DELETE FROM items WHERE name = ?", [name]);
  const items = ((await assetCache.get("items")) || []) as Item[];
  const index = items.findIndex((i) => i.name.toLowerCase() === name.toLowerCase());
  if (index !== -1) {
    items.splice(index, 1);
    await assetCache.set("items", items);
  }
}

export type EditorResult =
  | { kind: "data"; data: ItemEditorData }
  | { kind: "search"; data: ItemSearchResult }
  | { kind: "result"; ok: boolean; errors: string[]; name?: string };

/** Dispatch for every ITEM_EDITOR_* packet. The caller checks permission first. */
export async function handleEditorPacket(type: string, data: any): Promise<EditorResult> {
  switch (type) {
    case "ITEM_EDITOR_LIST":
      return { kind: "data", data: await buildEditorData() };

    case "ITEM_EDITOR_SEARCH":
      return { kind: "search", data: await searchItems(data?.query, data?.name) };

    case "ITEM_EDITOR_SAVE": {
      const items = ((await assetCache.get("items")) || []) as Item[];
      const originalName = data?.originalName ? String(data.originalName) : null;
      const names = new Set(items.map((i) => i.name.toLowerCase()));
      const errors = validateItem(data, names, originalName);
      if (errors.length) return { kind: "result", ok: false, errors };
      const saved = await saveItem(data, originalName);
      return { kind: "result", ok: true, errors: [], name: saved.name };
    }

    case "ITEM_EDITOR_DELETE": {
      const name = String(data?.name ?? "").trim();
      if (!name) return { kind: "result", ok: false, errors: ["Nothing selected."] };
      await deleteItem(name);
      return { kind: "result", ok: true, errors: [], name };
    }

    default:
      return { kind: "result", ok: false, errors: [`Unknown item editor action: ${type}`] };
  }
}
