import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import { rowCache, turns } from "../services/datacache";

const BAG_SLOTS = ["slot_1", "slot_2", "slot_3", "slot_4"] as const;

/** Inventory slots a player has with no bag equipped. */
const BASE_INVENTORY_SLOTS = 25;

// Each player's bags row (null: not made yet, see ensure).
const rows = rowCache<any>("bags", async (username) => {
  const found = await query("SELECT * FROM bags WHERE username = ?", [username]) as any[];
  return found[0] ?? null;
}, { perPlayer: true });

// One change to a player's row at a time: two ensures side by side would both find no row and both insert, and
// statements sent side by side reach the database in no set order, so two for one slot could leave the row held
// with one bag and the database with the other.
const oneAtATime = turns();

/**
 * A change to a player's row, in its turn. When it fails, the row held is forgotten and the next read loads it: a
 * write that threw may still have been made (one that timed out, say), so what is held can be trusted no longer.
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

const bags = {
  async get(username: string) {
    if (!username) return null;
    return await rows.get(username);
  },

  async ensure(username: string) {
    return change(username, async () => {
      let row = await bags.get(username);
      if (!row) {
        const result: any = await query("INSERT INTO bags (username) VALUES (?)", [username]);
        // The new row is the name it was given, an empty bag in every slot, and the id the database answered
        // with. An answer without one leaves the row unknown, so it is read.
        const id = Number(result?.lastInsertRowid);
        if (Number.isInteger(id) && id > 0) {
          row = { id, username, slot_1: null, slot_2: null, slot_3: null, slot_4: null };
          await rows.set(username, row);
        } else {
          await rows.drop(username);
          row = await bags.get(username);
        }
      }
      return row;
    });
  },

  async setBag(username: string, slot: string, itemName: string | null) {
    await bags.ensure(username);
    if (!BAG_SLOTS.includes(slot as any)) return false;
    await change(username, async () => {
      await query(`UPDATE bags SET ${slot} = ? WHERE username = ?`, [itemName, username]);
      await rows.patch(username, { [slot]: itemName });
    });
    return true;
  },

  async getTotalBagSlots(username: string) {
    const row = await bags.get(username);
    if (!row) return 0;
    let extra = 0;
    for (const slot of BAG_SLOTS) {
      if (row[slot]) extra += 1;
    }
    return extra;
  },

  /** Inventory slots the player has in all: the base grid plus what each equipped bag adds. */
  async capacity(username: string) {
    let slots = BASE_INVENTORY_SLOTS;
    const row = await bags.get(username);
    if (!row) return slots;
    const items = await assetCache.get("items") as Item[];
    for (const slot of BAG_SLOTS) {
      const itemName = row[slot];
      if (!itemName) continue;
      const item = Array.isArray(items) ? items.find((i) => i.name === itemName) : null;
      slots += item?.bag_slots != null ? Number(item.bag_slots) : 10;
    }
    return slots;
  },

  SLOTS: BAG_SLOTS,
};

export default bags;
