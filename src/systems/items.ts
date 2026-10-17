import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import assetCache from "../services/assetCache";

// The items a WHERE on a name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: string, b: string) =>
  (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

/** The items held: every row of the table, read at startup and kept in step by each write of it. */
async function held(): Promise<Item[]> {
  return ((await assetCache.get("items")) || []) as Item[];
}

/**
 * A statement that changes the items table. One that throws may still have
 * been applied (a timeout, say), so the table is read again: what is held is
 * then what the database holds, not what it held before.
 */
async function write(sql: string, values: any[]): Promise<any> {
  try {
    return await query(sql, values);
  } catch (error) {
    try {
      await assetCache.set("items", await items.list());
    } catch (again) {
      log.error(`Could not read the items again after a write that failed: ${again}`);
    }
    throw error;
  }
}

/**
 * Start-time safety step: the setup scripts add items.soulbound, but a database that is already
 * live may not have had its setup run before this version starts, and the item editor writes the
 * column. Added here if it is missing. It never throws: when it cannot be added, one warning is
 * logged and no item reads as soulbound.
 */
export async function ensureSoulboundColumn(): Promise<boolean> {
  try {
    await ensureItemColumn("soulbound");
    return true;
  } catch (error) {
    log.warn(`[Items] The soulbound column could not be added to items, so no item is soulbound: ${error}`);
    return false;
  }
}

/** What a newly priced item costs at a vendor, as a multiple of what vendors pay for it: as the NPC editor priced a newly stocked item. */
export const BUY_PRICE_MARKUP = 4;

/**
 * The same for items.buy_price, what a vendor charges for an item where the NPC sets no price of
 * its own. Added after vendors were: when it is added here, each item's is set at BUY_PRICE_MARKUP
 * times what vendors pay for it. The prices NPCs already had stay theirs, so nothing a player pays
 * changes. When it cannot be added, one warning is logged and vendors charge what their NPC says.
 */
export async function ensureBuyPriceColumn(): Promise<boolean> {
  try {
    if (await ensureItemColumn("buy_price")) {
      await query(`UPDATE items SET buy_price = sell_price * ${BUY_PRICE_MARKUP}`);
      log.info(`[Items] Added items.buy_price, set at ${BUY_PRICE_MARKUP} times each item's sell price.`);
    }
    return true;
  } catch (error) {
    log.warn(`[Items] The buy_price column could not be added to items, so vendors charge only what their NPC says: ${error}`);
    return false;
  }
}

/** The icon (on the asset server, icons/home_stone.png) the home item is drawn with when it has none of its own. */
export const HOME_ITEM_ICON = "home_stone";

/**
 * Start-time step: the home item made by the setup scripts had no icon before they set one, so a home item with no
 * icon is given HOME_ITEM_ICON. An icon chosen in the item editor is never replaced. USER REQUEST 2026-10-17: "make
 * sure the home_stone has the icon home_stone.png". Never throws: when it cannot be set, one warning is logged.
 */
export async function ensureHomeItemIcon(): Promise<void> {
  try {
    await query("UPDATE items SET icon = ? WHERE teleports_home = 1 AND (icon IS NULL OR icon = '')", [HOME_ITEM_ICON]);
  } catch (error) {
    log.warn(`[Items] The home item could not be given the ${HOME_ITEM_ICON} icon: ${error}`);
  }
}

/** Adds a whole-number column to items, 0 by default, unless it is there. Whether it was added now. */
async function ensureItemColumn(name: string): Promise<boolean> {
  const lite = (process.env.DATABASE_ENGINE || "mysql") === "sqlite";
  const has = async () => {
    if (lite) {
      const rows = (await query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'`)) as any[];
      return new RegExp(`\\b${name}\\b`).test(String(rows?.[0]?.sql || ""));
    }
    const rows = (await query(
      `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'items' AND COLUMN_NAME = ?`,
      [name]
    )) as any[];
    return Number(rows?.[0]?.count) > 0;
  };
  if (await has()) return false;
  try {
    await query(`ALTER TABLE items ADD COLUMN ${name} ${lite ? "INTEGER" : "INT"} NOT NULL DEFAULT 0`);
    return true;
  } catch (error) {
    // another realm starting at the same moment may have added it first
    if (await has()) return false;
    throw error;
  }
}

const items = {
  async add(item: Item) {
    if (!item?.name || !item?.quality || !item?.description || !item?.type || !item?.level_requirement || !item?.equipable) return;
    // INSERT IGNORE adds nothing when the name is taken: the items held say whether it is.
    const taken = (await held()).some((i) => sameName(i.name, item.name));
    await write(
      "INSERT IGNORE INTO items (name, quality, description, icon, type, stat_armor, stat_damage, stat_critical_chance, stat_critical_damage, stat_health, stat_stamina, stat_avoidance, level_requirement, equipable, equipment_slot, damage_min, damage_max, attack_speed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [item.name, item.quality, item.description, item.icon || null, item.type, item.stat_armor || null, item.stat_damage || null, item.stat_critical_chance || null, item.stat_critical_damage || null, item.stat_health || null, item.stat_stamina || null, item.stat_avoidance || null, item.level_requirement || null, item.equipable, item.equipment_slot || null, item.damage_min ?? null, item.damage_max ?? null, item.attack_speed_ms ?? null]
    );

    if (!taken) {
      const items = await held();
      items.push(item);
      await assetCache.set("items", items);
    }
  },
  async remove(item: Item) {
    if (!item?.name) return;
    await write("DELETE FROM items WHERE name = ?", [item.name]);

    const items = await held();
    await assetCache.set("items", items.filter((i) => !sameName(i.name, item.name)));
  },
  async list() {
    return await query("SELECT * FROM items");
  },
  /** The items of that name, as the table has them; nothing when there is none. */
  async find(item: Item) {
    if (!item?.name) return;
    const response = (await held()).filter((i) => sameName(i.name, item.name));
    if (response.length === 0) return;
    return response;
  },
  async update(item: Item) {
    if (!item?.name || !item?.quality || !item?.description || !item?.type || !item?.level_requirement || !item?.equipable) return;
    await write(
      "UPDATE items SET quality = ?, description = ?, icon = ?, type = ?, stat_armor = ?, stat_damage = ?, stat_critical_chance = ?, stat_critical_damage = ?, stat_health = ?, stat_stamina = ?, stat_avoidance = ?, level_requirement = ?, equipable = ?, equipment_slot = ?, damage_min = ?, damage_max = ?, attack_speed_ms = ? WHERE name = ?",
      [item.quality, item.description, item.icon || null, item.type, item.stat_armor || null, item.stat_damage || null, item.stat_critical_chance || null, item.stat_critical_damage || null, item.stat_health || null, item.stat_stamina || null, item.stat_avoidance || null, item.level_requirement || null, item.equipable, item.equipment_slot || null, item.damage_min ?? null, item.damage_max ?? null, item.attack_speed_ms ?? null, item.name]
    );
    // The statement changes the rows of that name, but for the name itself, and adds none: so do the items held.
    const items = await held();
    await assetCache.set("items", items.map((i) => (sameName(i.name, item.name) ? { ...item, name: i.name } : i)));
  },
  async equipmentList() {
    const items = await assetCache.get("items") as Item[];
    return items.filter((item) => item.type === "equipment");
  },
  async consumableList() {
    const items = await assetCache.get("items") as Item[];
    return items.filter((item) => item.type === "consumable");
  },
  async materialList() {
    const items = await assetCache.get("items") as Item[];
    return items.filter((item) => item.type === "material");
  },
  async questList() {
    const items = await assetCache.get("items") as Item[];
    return items.filter((item) => item.type === "quest");
  },
  async miscellaneousList() {
    const items = await assetCache.get("items") as Item[];
    return items.filter((item) => item.type === "miscellaneous");
  }
};

export default items;
