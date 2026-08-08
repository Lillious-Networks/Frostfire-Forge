import query from "../controllers/sqldatabase";
import { getIconUrl } from "../modules/spriteSheetManager";
import assetCache from "../services/assetCache";

const lootTable = {
  async list() {
    const tables = await query("SELECT * FROM loot_tables ORDER BY id DESC") as any[];
    const result = [];
    for (const table of tables) {
      const items = await query("SELECT * FROM loot_table_items WHERE loot_table_id = ?", [table.id]) as any[];
      result.push({ id: table.id, name: table.name, created_at: table.created_at, items: items.map((item: any) => ({ id: item.id, item_name: item.item_name, min_quantity: item.min_quantity, max_quantity: item.max_quantity, drop_chance: item.drop_chance, quality: item.quality || "common" })) });
    }
    return result;
  },
  async get(id: number) {
    const tables = await query("SELECT * FROM loot_tables WHERE id = ?", [id]) as any[];
    if (!tables || tables.length === 0) return null;
    const items = await query("SELECT * FROM loot_table_items WHERE loot_table_id = ?", [id]) as any[];
    return { id: tables[0].id, name: tables[0].name, created_at: tables[0].created_at, items: items.map((item: any) => ({ id: item.id, item_name: item.item_name, min_quantity: item.min_quantity, max_quantity: item.max_quantity, drop_chance: item.drop_chance, quality: item.quality || "common" })) };
  },
  async create(name: string) {
    if (!name) return null;
    const existing = await query("SELECT id FROM loot_tables WHERE name = ?", [name]) as any[];
    if (existing && existing.length > 0) return null;
    return await query("INSERT INTO loot_tables (name) VALUES (?)", [name]);
  },
  async delete(id: number) {
    await query("DELETE FROM loot_table_items WHERE loot_table_id = ?", [id]);
    await query("DELETE FROM loot_tables WHERE id = ?", [id]);
  },
  async addItem(tableId: number, itemName: string, minQuantity: number, maxQuantity: number, dropChance: number, quality?: string) {
    if (!tableId || !itemName) return null;
    const items = await assetCache.get("items") as any[];
    const matchedItem = items?.find((i: any) => i.name.toLowerCase() === itemName.toLowerCase());
    if (!matchedItem) return { error: `Item "${itemName}" not found` };
    await query("INSERT INTO loot_table_items (loot_table_id, item_name, min_quantity, max_quantity, drop_chance, quality) VALUES (?, ?, ?, ?, ?, ?)", [tableId, matchedItem.name, minQuantity || 1, maxQuantity || 1, dropChance || 100, quality || matchedItem.quality || "common"]);
  },
  async removeItem(itemId: number) { await query("DELETE FROM loot_table_items WHERE id = ?", [itemId]); },
  async updateItem(itemId: number, minQuantity: number, maxQuantity: number, dropChance: number, quality: string) {
    await query("UPDATE loot_table_items SET min_quantity = ?, max_quantity = ?, drop_chance = ?, quality = ? WHERE id = ?", [minQuantity || 1, maxQuantity || 1, dropChance || 100, quality || "common", itemId]);
  },
  async roll(lootTableId?: number, inlineEntries?: LootTableEntry[]): Promise<LootRollResult[]> {
    let entries: any[];
    if (lootTableId) { const t = await this.get(lootTableId); if (!t) return []; entries = t.items.map((i: any) => ({ item_name: i.item_name, min_quantity: i.min_quantity, max_quantity: i.max_quantity, drop_chance: i.drop_chance, quality: i.quality })); }
    else if (inlineEntries?.length) { entries = inlineEntries.map((e: any) => ({ item_name: e.itemName, min_quantity: e.minQuantity, max_quantity: e.maxQuantity, drop_chance: e.dropChance, quality: e.quality })); }
    else { return []; }
    const results: LootRollResult[] = []; let idx = 0;
    for (const e of entries) { if (Math.random() * 100 > (e.drop_chance || 100)) continue; const q = Math.floor(Math.random() * (e.max_quantity - e.min_quantity + 1)) + e.min_quantity; if (q <= 0) continue; results.push({ index: idx++, itemName: e.item_name, quantity: q, quality: e.quality || "common", iconUrl: getIconUrl(e.item_name) || "" }); }
    return results;
  },
};
export default lootTable;
