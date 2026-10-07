/**
 * Item editor: validation and CRUD for the admin item editor window.
 * Items are keyed by name, so a rename creates a new row - the editor sends the
 * original name along with a save so a rename can update in place instead.
 */
import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import log from "../modules/logger";
import { refreshAuthItems } from "../socket/authentication_pool";
import { listIcons, type SpriteSheetOption } from "./creatures/editor";
import itemTable from "./items";

/** The most copper a vendor pays for one item. */
export const SELL_PRICE_MAX = 2147483647;
/** The most health or stamina one consumable restores. */
export const RESTORE_MAX = 1_000_000;

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
  // Only a consumable has a use, and the home item's only use is the way home.
  const consumable = type === "consumable";
  const teleports_home = consumable && !!input?.teleports_home;
  const restores = consumable && !teleports_home;
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
    // What a vendor pays for one, in copper: one unless the item says otherwise. Nothing (0) is an item vendors do not buy.
    sell_price: num(input?.sell_price) ?? 1,
    restore_health: restores ? num(input?.restore_health) ?? 0 : 0,
    restore_stamina: restores ? num(input?.restore_stamina) ?? 0 : 0,
    no_combat: consumable && !!input?.no_combat,
    teleports_home,
  };
}

/**
 * What is wrong with an item an editor sent. `homeItem` is the name of the item that is the home
 * item now, when there is one: no other item can become it.
 */
export function validateItem(input: any, existingNames: Set<string>, originalName: string | null, homeItem: string | null = null): string[] {
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
  const price = item.sell_price ?? 1;
  if (price < 0) errors.push("Vendor sell price cannot be negative.");
  // The most its column holds: a little under 214,749 gold.
  if (price > SELL_PRICE_MAX) errors.push("Vendor sell price is too high.");

  if (item.type === "consumable") {
    const restores = [item.restore_health ?? 0, item.restore_stamina ?? 0];
    if (restores.some((amount) => amount < 0)) errors.push("What a consumable restores cannot be negative.");
    if (restores.some((amount) => amount > RESTORE_MAX)) errors.push("What a consumable restores is too high.");
    if (!item.teleports_home && restores.every((amount) => amount === 0)) errors.push("A consumable must restore health or stamina, or be the home item.");
    // The item being saved is the home item under the name it had before this save.
    const isHomeItem = homeItem !== null && originalName !== null && originalName.toLowerCase() === homeItem.toLowerCase();
    if (item.teleports_home && homeItem !== null && !isHomeItem) errors.push(`${homeItem} is already the home item. Only one item can be.`);
  }

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
  "damage_min", "damage_max", "attack_speed_ms", "sell_price",
  "restore_health", "restore_stamina", "no_combat", "teleports_home",
];

const values = (item: Item) => [
  item.name, item.quality, item.type, item.description, item.icon, item.stat_armor, item.stat_damage,
  item.stat_critical_chance, item.stat_critical_damage, item.stat_health, item.stat_stamina,
  item.stat_avoidance, item.level_requirement, item.equipable ? 1 : 0, item.equipment_slot,
  item.damage_min, item.damage_max, item.attack_speed_ms, item.sell_price ?? 1,
  item.restore_health ?? 0, item.restore_stamina ?? 0, item.no_combat ? 1 : 0, item.teleports_home ? 1 : 0,
];

/**
 * The cached item list changed. The login workers build a player's inventory
 * from their own copy of the list, so hand them the new one.
 */
async function itemsChanged(): Promise<void> {
  try {
    await refreshAuthItems();
  } catch (error) {
    log.error(`Could not hand the changed items to the login workers: ${error}`);
  }
}

/**
 * A statement that changes the items table. One that throws may still have
 * been applied (a timeout, say), so the table is read again and the login
 * workers are handed what it holds: the items held are then the database's,
 * not what they were before.
 */
async function write(sql: string, params: any[]): Promise<void> {
  try {
    await query(sql, params);
  } catch (error) {
    try {
      await assetCache.set("items", await itemTable.list());
      await itemsChanged();
    } catch (again) {
      log.error(`Could not read the items again after a write that failed: ${again}`);
    }
    throw error;
  }
}

/** Insert or update by name, then put the item into the cache every system reads from. */
export async function saveItem(input: any, originalName: string | null): Promise<Item> {
  const item = normalizeItem(input);
  const existing = originalName ?? item.name;
  const isRow = (i: Item) => i.name.toLowerCase() === existing.toLowerCase();
  // The items held are every row of the table: whether this one is there is read from them.
  const held = ((await assetCache.get("items")) || []) as Item[];

  if (held.some(isRow)) {
    await write(
      `UPDATE items SET ${COLUMNS.map((c) => `${c} = ?`).join(", ")} WHERE name = ?`,
      [...values(item), existing]
    );
  } else {
    await write(
      `INSERT INTO items (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
      values(item)
    );
  }

  const items = ((await assetCache.get("items")) || []) as Item[];
  const index = items.findIndex(isRow);
  if (index === -1) items.push(item);
  else items[index] = item;
  await assetCache.set("items", items);
  await itemsChanged();
  return item;
}

export async function deleteItem(name: string): Promise<void> {
  await write("DELETE FROM items WHERE name = ?", [name]);
  const items = ((await assetCache.get("items")) || []) as Item[];
  const index = items.findIndex((i) => i.name.toLowerCase() === name.toLowerCase());
  if (index !== -1) {
    items.splice(index, 1);
    await assetCache.set("items", items);
    await itemsChanged();
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
      const homeItem = items.find((i) => i.type === "consumable" && !!i.teleports_home)?.name ?? null;
      const errors = validateItem(data, names, originalName, homeItem);
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
