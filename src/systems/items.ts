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
