import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import { rowCache, turns } from "../services/datacache";
import log from "../modules/logger";

async function getItems(): Promise<Item[]> {
  return await assetCache.get("items") as Item[] || [];
}

/** A row of the inventory table. */
interface InventoryRow {
  id: number;
  username: string;
  item: string;
  quantity: number;
  equipped: number;
  slot: number | null;
  bag_slot: number | null;
}

// Each player's rows, as the table has them.
const rows = rowCache<InventoryRow[]>("inventory", async (username) =>
  (await query("SELECT * FROM inventory WHERE username = ?", [username])) as InventoryRow[] || []
, { perPlayer: true });

// One change to a player's rows at a time. Each works from the rows held and puts back what its write left, so two
// running side by side would each put back rows without the other's change; and statements sent side by side reach
// the database in no set order.
const oneAtATime = turns();

/**
 * A change to a player's rows, in its turn. When it fails, the rows held are forgotten and the next read loads them:
 * a write that threw may still have been made (one that timed out, say), so what is held can be trusted no longer.
 */
function change<T>(username: string, work: () => Promise<T>): Promise<T> {
  return oneAtATime(username, async () => {
    try {
      return await work();
    } catch (error) {
      await rows.drop(username);
      throw error;
    }
  });
}

// The rows a WHERE on a name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: string, b: string) =>
  (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

/** The rows as an UPDATE ... WHERE item = ? leaves them: `fields` on every row of that item. */
const changed = (held: InventoryRow[], item: string, fields: Partial<InventoryRow>) =>
  held.map((row) => (sameName(row.item, item) ? { ...row, ...fields } : row));

/** The rows as a DELETE ... WHERE item = ? leaves them. */
const without = (held: InventoryRow[], item: string) => held.filter((row) => !sameName(row.item, item));

/** The id the database gave the row an INSERT made, when its answer says. */
function insertedId(result: any): number | null {
  const id = Number(result?.lastInsertRowid);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Whether an INT column holds `value` as it was given. Any other number the database rounds or clips its own way. */
const storedAsGiven = (value: unknown) => value == null || (Number.isInteger(value) && Math.abs(value as number) <= 2147483647);

/**
 * After a write: `next` is what the player's rows have become. Unless a number that was written is one the database
 * does not store as given: what it holds then cannot be worked out here, so the rows are read again instead.
 */
async function hold(username: string, next: InventoryRow[], written: unknown[] = []) {
  if (written.every(storedAsGiven)) await rows.set(username, next);
  else await rows.drop(username);
}

/** An UPDATE of one item's rows, then the same `fields` on the rows held. `values` are what its SET is given, in order. */
function update(username: string, item: string, sql: string, values: unknown[], fields: Partial<InventoryRow>) {
  return change(username, async () => {
    const result = await query(sql, [...values, item, username]);
    await hold(username, changed((await rows.get(username)) ?? [], item, fields), values);
    return result;
  });
}

const inventory = {
  async find(name: string, item: InventoryItem) {
    if (!name || !item.name) return;
    return ((await rows.get(name)) ?? []).filter((row) => sameName(row.item, item.name));
  },
  async add(name: string, item: InventoryItem) {
    if (!name || !item?.quantity || !item?.name) return;
    if (Number(item.quantity) <= 0) return;
    const items = await getItems();
    const matchedItem = items.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
    if (!matchedItem) return;
    const resolvedName = matchedItem.name;

    const result = await change(name, async () => {
      const held = (await rows.get(name)) ?? [];
      const response = held.filter((row) => sameName(row.item, resolvedName));

      if (response.length === 0) {
        const quantity = Number(item.quantity);
        const result = await query(
          "INSERT IGNORE INTO inventory (username, item, quantity) VALUES (?, ?, ?)",
          [name, resolvedName, quantity]
        );
        // The new row is what was written, the table's defaults for the rest, and the id the database answered
        // with. An answer without one leaves the row unknown, so the rows are read again.
        const id = insertedId(result);
        if (id === null) await rows.drop(name);
        else await hold(name, [...held, { id, username: name, item: resolvedName, quantity, equipped: 0, slot: null, bag_slot: null }], [quantity]);
        return result;
      }

      const quantity = Number(response[0].quantity) + Number(item.quantity);
      const result = await query(
        "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?",
        [
          quantity.toString(),
          resolvedName,
          name,
        ]
      );
      await hold(name, changed(held, resolvedName, { quantity }), [quantity]);
      return result;
    });
    // Collect objectives treat the inventory as the source of truth: sync the
    // new total so picking up quest items credits immediately.
    try {
      const { sync: syncObjective } = await import("./quests/objectives");
      const stacks = await inventory.find(name, { name: resolvedName, quantity: 0 });
      const total = stacks?.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0) ?? 0;
      await syncObjective(name, "collect", resolvedName, total);
    } catch {
      // Quest sync is best-effort on the inventory path.
    }
    return result;
  },
  async setEquipped(name: string, item: string, equipped: boolean, targetSlot?: number, targetBagSlot?: number) {
    if (!name || !item || typeof equipped !== "boolean") return;
    if (equipped) {
      return await update(name, item,
        "UPDATE inventory SET equipped = 1 WHERE item = ? AND username = ?",
        [], { equipped: 1 }
      );
    } else {
      return await update(name, item,
        "UPDATE inventory SET equipped = 0, slot = ?, bag_slot = ? WHERE item = ? AND username = ?",
        [targetSlot ?? null, targetBagSlot ?? null], { equipped: 0, slot: targetSlot ?? null, bag_slot: targetBagSlot ?? null }
      );
    }
  },
  async setUnequippedSlot(name: string, item: string, slot: number | null, bagSlot: number | null) {
    if (!name || !item) return;
    return await update(name, item,
      "UPDATE inventory SET equipped = 0, slot = ?, bag_slot = ? WHERE item = ? AND username = ?",
      [slot, bagSlot ?? null], { equipped: 0, slot: slot ?? null, bag_slot: bagSlot ?? null }
    );
  },
  /** The item takes up no slot of the grid any more (every one of it is in use as a bag). */
  async clearSlot(name: string, item: string) {
    if (!name || !item) return;
    return await update(name, item,
      "UPDATE inventory SET slot = NULL, bag_slot = NULL WHERE item = ? AND username = ?",
      [], { slot: null, bag_slot: null }
    );
  },
  async saveSlots(username: string, slots: Array<{ item: string; slot: number; bag_slot: number }>) {
    if (!username) return;
    await change(username, async () => {
      let held = (await rows.get(username)) ?? [];
      const written: unknown[] = [];
      for (const s of slots) {
        await query(
          "UPDATE inventory SET slot = ?, bag_slot = ? WHERE item = ? AND username = ?",
          [s.slot, s.bag_slot ?? null, s.item, username]
        );
        held = changed(held, s.item, { slot: s.slot ?? null, bag_slot: s.bag_slot ?? null });
        written.push(s.slot, s.bag_slot);
      }
      if (written.length > 0) await hold(username, held, written);
    });
  },
  async remove(name: string, item: InventoryItem) {
    if (!name || !item?.quantity || !item?.name) return;
    if (Number(item.quantity) <= 0) return;
    const items = await getItems();
    const matchedItem = items.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
    if (!matchedItem) return;
    const resolvedName = matchedItem.name;

    const removed = await change(name, async () => {
      const held = (await rows.get(name)) ?? [];
      const response = held.filter((row) => sameName(row.item, resolvedName));
      if (response.length === 0) return null;

      if (Number(item.quantity) >= Number(response[0].quantity)) {
        const result = await query(
          "DELETE FROM inventory WHERE item = ? AND username = ?",
          [resolvedName, name]
        );
        await rows.set(name, without(held, resolvedName));
        return { result };
      }

      const quantity = Number(response[0].quantity) - Number(item.quantity);
      const result = await query(
        "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?",
        [
          quantity.toString(),
          resolvedName,
          name,
        ]
      );
      await hold(name, changed(held, resolvedName, { quantity }), [quantity]);
      return { result };
    });
    if (!removed) return;
    // Dropping or using a quest item walks progress back down.
    try {
      const { sync: syncObjective } = await import("./quests/objectives");
      const stacks = await inventory.find(name, { name: resolvedName, quantity: 0 });
      const total = stacks?.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0) ?? 0;
      await syncObjective(name, "collect", resolvedName, total);
    } catch {
      // Quest sync is best-effort on the inventory path.
    }
    return removed.result;
  },
  async delete(name: string, item: InventoryItem) {
    if (!name || !item.name) return;
    return await change(name, async () => {
      const result = await query(
        "DELETE FROM inventory WHERE item = ? AND username = ?",
        [item.name, name]
      );
      await rows.set(name, without((await rows.get(name)) ?? [], item.name));
      return result;
    });
  },
  async get(name: string) {
    if (!name) return [];

    const _items = ((await rows.get(name)) ?? []).map(({ item, quantity, equipped, slot, bag_slot }) => ({ item, quantity, equipped, slot, bag_slot })) as any[];

    if (!_items || _items.length === 0) return [];

    const items = await getItems();
    const itemsByName = new Map(items.map((i: any) => [i.name, i]));

    const details = await Promise.all(
      _items.map(async (item: any) => {

        const itemDetails = itemsByName.get(item.item);
        if (itemDetails) {
          return {
            ...itemDetails,
            ...item,
          };
        } else {

          log.error(`Item details not found for: ${item.item}`);
          return {
            ...item,
            name: item.item,
            quality: "unknown",
            description: "unknown",
            icon: null,
          };
        }

      })
    );
    return details;
  }
};

export default inventory;
