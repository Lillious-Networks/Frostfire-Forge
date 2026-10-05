import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { getIconUrl } from "../modules/spriteSheetManager";
import assetCache from "../services/assetCache";
import { tableCache } from "../services/datacache";

/**
 * A drop chance as a percentage, 0-100. Only a missing or non-numeric value
 * defaults to 100: 0 is a real setting (never drops), not "unset".
 * DECIMAL columns come back from MySQL as strings, hence Number().
 */
export function normalizeDropChance(value: unknown): number {
  if (value === null || value === undefined || value === "") return 100;
  const chance = Number(value);
  if (!Number.isFinite(chance)) return 100;
  return Math.min(100, Math.max(0, chance));
}

/** A row of a loot table, as list() and get() give it. The chance is text where the database hands a DECIMAL back as text. */
interface LootRow { id: number; item_name: string; min_quantity: number; max_quantity: number; drop_chance: any; quality: string }
/** A loot table with its rows, as list() and get() give it. */
interface LootTable { id: number; name: string; created_at: any; items: LootRow[] }

// Every loot table with its rows. Reads are answered from these, and every
// change below is written to the database and then to them.
const rows = tableCache<LootTable>("loot_tables", async () => {
  let tables: any[];
  let items: any[];
  try {
    tables = await query("SELECT * FROM loot_tables ORDER BY id DESC") as any[];
    items = await query("SELECT * FROM loot_table_items ORDER BY id") as any[];
  } catch (error) {
    // A database set up without the loot tables has none, and must not stop the server from starting.
    if (!/no such table|doesn't exist|does not exist/i.test(String((error as Error)?.message ?? error))) throw error;
    log.warn(`Could not read the loot tables (run the database setup script): ${error}`);
    return [];
  }
  const rowsOf = new Map<number, LootRow[]>();
  for (const item of items || []) {
    const tableId = Number(item.loot_table_id);
    if (!rowsOf.has(tableId)) rowsOf.set(tableId, []);
    rowsOf.get(tableId)!.push({ id: item.id, item_name: item.item_name, min_quantity: item.min_quantity, max_quantity: item.max_quantity, drop_chance: item.drop_chance, quality: item.quality || "common" });
  }
  return (tables || []).map((table) => ({ id: table.id, name: table.name, created_at: table.created_at, items: rowsOf.get(Number(table.id)) ?? [] }));
});

const byId = (id: number) => (table: LootTable) => Number(table.id) === Number(id);
const isRow = (itemId: number) => (row: LootRow) => Number(row.id) === Number(itemId);
/** The table a row is in. */
const holding = (itemId: number) => (table: LootTable) => table.items.some(isRow(itemId));

// The tables a WHERE on a name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: string, b: string) =>
  (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

/**
 * Whether the database stores a row's numbers and quality as they were given:
 * whole numbers in the INT columns, a chance of at most two decimal places in
 * DECIMAL(5,2), a quality that fits VARCHAR(50). Anything else it rounds or
 * clips its own way, and what it holds then cannot be worked out here.
 */
const storedAsGiven = (row: { min_quantity: number; max_quantity: number; drop_chance: number; quality: string }) =>
  [row.min_quantity, row.max_quantity].every((n) => Number.isInteger(n) && Math.abs(n) <= 2147483647) &&
  Math.round(row.drop_chance * 100) / 100 === row.drop_chance &&
  String(row.quality).length <= 50;

// One change at a time. Each works from the table held and puts back what its
// write left, so two running side by side would each put a table back without
// the other's change; and create is a check followed by a write.
let changing: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(change: () => Promise<T>): Promise<T> {
  const run = changing.then(change, change);
  changing = run.catch(() => {});
  return run;
}

/**
 * A statement that changes the tables. One that throws may still have been
 * applied (a timeout, say), so what is held is no longer known to be what the
 * database holds: it is forgotten, and the next read loads the tables again.
 */
async function write(sql: string, values: any[]): Promise<any> {
  try {
    return await query(sql, values);
  } catch (error) {
    await rows.drop();
    throw error;
  }
}

/** After a write to one table's rows: the same change to the rows held. A table that is not held has none to change. */
async function change(which: (table: LootTable) => boolean, items: (held: LootRow[]) => LootRow[]): Promise<void> {
  const table = await rows.find(which);
  if (table) await rows.put({ ...table, items: items(table.items) }, byId(table.id));
}

const lootTable = {
  /** Every table with its rows, the newest table first. */
  async list() {
    return (await rows.all()).sort((a, b) => Number(b.id) - Number(a.id));
  },
  async get(id: number) {
    return await rows.find(byId(id));
  },
  async create(name: string) {
    if (!name) return null;
    return oneAtATime(async () => {
      if (await rows.find((table) => sameName(table.name, name))) return null;
      const result = await write("INSERT INTO loot_tables (name) VALUES (?)", [name]);
      // The new table's id and created_at are the database's own: the next read loads the tables, this one among them.
      await rows.drop();
      return result;
    });
  },
  async delete(id: number) {
    await oneAtATime(async () => {
      await write("DELETE FROM loot_table_items WHERE loot_table_id = ?", [id]);
      await write("DELETE FROM loot_tables WHERE id = ?", [id]);
      await rows.remove(byId(id));
    });
  },
  async addItem(tableId: number, itemName: string, minQuantity: number, maxQuantity: number, dropChance: number, quality?: string) {
    if (!tableId || !itemName) return null;
    const items = await assetCache.get("items") as any[];
    const matchedItem = items?.find((i: any) => i.name.toLowerCase() === itemName.toLowerCase());
    if (!matchedItem) return { error: `Item "${itemName}" not found` };
    const row = { item_name: matchedItem.name as string, min_quantity: minQuantity || 1, max_quantity: maxQuantity || 1, drop_chance: normalizeDropChance(dropChance), quality: (quality || matchedItem.quality || "common") as string };
    return oneAtATime(async () => {
      // A row for a table that is not there would be in no table at all, where nothing could show or remove it.
      if (!(await rows.find(byId(tableId)))) return { error: `Loot table ${tableId} not found` };
      const result = await write("INSERT INTO loot_table_items (loot_table_id, item_name, min_quantity, max_quantity, drop_chance, quality) VALUES (?, ?, ?, ?, ?, ?)", [tableId, row.item_name, row.min_quantity, row.max_quantity, row.drop_chance, row.quality]);
      // The new row is what was written and the id the database answered with. An answer without one, or a number
      // the database stores its own way, leaves the row unknown: the next read loads the tables again.
      const id = Number(result?.lastInsertRowid);
      if (Number.isInteger(id) && id > 0 && storedAsGiven(row)) await change(byId(tableId), (held) => [...held, { id, ...row }]);
      else await rows.drop();
    });
  },
  /** One row by its own id, or null when there is none: removeItem and updateItem do not say whether they found it. */
  async getItem(itemId: number) {
    const table = await rows.find(holding(itemId));
    const item = table?.items.find(isRow(itemId));
    if (!table || !item) return null;
    return { id: item.id, loot_table_id: table.id, item_name: item.item_name, min_quantity: item.min_quantity, max_quantity: item.max_quantity, drop_chance: item.drop_chance, quality: item.quality };
  },
  async removeItem(itemId: number) {
    await oneAtATime(async () => {
      await write("DELETE FROM loot_table_items WHERE id = ?", [itemId]);
      await change(holding(itemId), (held) => held.filter((row) => !isRow(itemId)(row)));
    });
  },
  async updateItem(itemId: number, minQuantity: number, maxQuantity: number, dropChance: number, quality: string) {
    const numbers = { min_quantity: minQuantity || 1, max_quantity: maxQuantity || 1, drop_chance: normalizeDropChance(dropChance), quality: quality || "common" };
    await oneAtATime(async () => {
      await write("UPDATE loot_table_items SET min_quantity = ?, max_quantity = ?, drop_chance = ?, quality = ? WHERE id = ?", [numbers.min_quantity, numbers.max_quantity, numbers.drop_chance, numbers.quality, itemId]);
      if (storedAsGiven(numbers)) await change(holding(itemId), (held) => held.map((row) => (isRow(itemId)(row) ? { ...row, ...numbers } : row)));
      else await rows.drop();
    });
  },
  async roll(lootTableId?: number, inlineEntries?: LootTableEntry[]): Promise<LootRollResult[]> {
    let entries: any[];
    if (lootTableId) { const t = await this.get(lootTableId); if (!t) return []; entries = t.items.map((i: any) => ({ item_name: i.item_name, min_quantity: i.min_quantity, max_quantity: i.max_quantity, drop_chance: i.drop_chance, quality: i.quality })); }
    else if (inlineEntries?.length) { entries = inlineEntries.map((e: any) => ({ item_name: e.itemName, min_quantity: e.minQuantity, max_quantity: e.maxQuantity, drop_chance: e.dropChance, quality: e.quality })); }
    else { return []; }
    const results: LootRollResult[] = []; let idx = 0;
    for (const e of entries) { const chance = normalizeDropChance(e.drop_chance); if (chance <= 0 || Math.random() * 100 > chance) continue; const q = Math.floor(Math.random() * (e.max_quantity - e.min_quantity + 1)) + e.min_quantity; if (q <= 0) continue; results.push({ index: idx++, itemName: e.item_name, quantity: q, quality: e.quality || "common", iconUrl: getIconUrl(e.item_name) || "" }); }
    return results;
  },
};
export default lootTable;
