import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

const items = {
  async add(item: Item) {
    if (!item?.name || !item?.quality || !item?.description || !item?.type || !item?.level_requirement || !item?.equipable) return;
    const result = await query(
      "INSERT IGNORE INTO items (name, quality, description, icon, type, stat_armor, stat_damage, stat_critical_chance, stat_critical_damage, stat_health, stat_stamina, stat_avoidance, level_requirement, equipable, equipment_slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [item.name, item.quality, item.description, item.icon || null, item.type, item.stat_armor || null, item.stat_damage || null, item.stat_critical_chance || null, item.stat_critical_damage || null, item.stat_health || null, item.stat_stamina || null, item.stat_avoidance || null, item.level_requirement || null, item.equipable, item.equipment_slot || null]
    ) as any;
    // Update cache if insert was successful
    if (result.affectedRows > 0) {
      const items = await assetCache.get("items") as Item[];
      items.push(item);
      assetCache.set("items", items);
    }
  },
  async remove(item: Item) {
    if (!item?.name) return;
    const result = await query("DELETE FROM items WHERE name = ?", [item.name]) as any;
    // Update cache if delete was successful
    if (result.affectedRows > 0) {
      const items = await assetCache.get("items") as Item[];
      const index = items.findIndex((i) => i.name === item.name);
      if (index !== -1) {
        items.splice(index, 1);
        assetCache.set("items", items);
      }
    }
  },
  async list() {
    return await query("SELECT * FROM items");
  },
  async find(item: Item) {
    if (!item?.name) return;
    const response = await query("SELECT * FROM items WHERE name = ?", [item.name]) as any;
    if (response.length === 0) return;
    return response;
  },
  async update(item: Item) {
    if (!item?.name || !item?.quality || !item?.description || !item?.type || !item?.level_requirement || !item?.equipable) return;
    const result = await query(
      "UPDATE items SET quality = ?, description = ?, icon = ?, type = ?, stat_armor = ?, stat_damage = ?, stat_critical_chance = ?, stat_critical_damage = ?, stat_health = ?, stat_stamina = ?, stat_avoidance = ?, level_requirement = ?, equipable = ?, equipment_slot = ? WHERE name = ?",
      [item.quality, item.description, item.icon || null, item.type, item.stat_armor || null, item.stat_damage || null, item.stat_critical_chance || null, item.stat_critical_damage || null, item.stat_health || null, item.stat_stamina || null, item.stat_avoidance || null, item.level_requirement || null, item.equipable, item.equipment_slot || null, item.name]
    );
    if (result) {
      const items = await assetCache.get("items") as Item[];
      const index = items.findIndex((i) => i.name === item.name);
      items[index] = item;
      assetCache.set("items", items);
    }
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
