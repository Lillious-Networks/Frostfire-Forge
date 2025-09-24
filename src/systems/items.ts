import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

const items = {
  async add(item: Item) {
    if (!item?.name || !item?.quality || !item?.description) return;
    return await query(
      "INSERT IGNORE INTO items (name, quality, description, icon) VALUES (?, ?, ?, ?)",
      [item.name, item.quality, item.description, item.icon || null]
    );
  },
  async remove(item: Item) {
    if (!item?.name) return;
    return await query("DELETE FROM items WHERE name = ?", [item.name]);
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
    if (!item?.name || !item?.quality || !item?.description) return;
    const result = await query(
      "UPDATE items SET quality = ?, description = ?, icon = ? WHERE name = ?",
      [item.quality, item.description, item.name, item.icon || null]
    );
    if (result) {
      const items = await assetCache.get("items") as Item[];
      const index = items.findIndex((i) => i.name === item.name);
      items[index] = item;
      assetCache.set("items", items);
    }
  }
};

export default items;
