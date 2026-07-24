import query from "../controllers/sqldatabase";

const BAG_SLOTS = ["slot_1", "slot_2", "slot_3", "slot_4"] as const;

const bags = {
  async get(username: string) {
    const rows = await query("SELECT * FROM bags WHERE username = ?", [username]) as any[];
    if (rows.length === 0) return null;
    return rows[0];
  },

  async ensure(username: string) {
    let row = await bags.get(username);
    if (!row) {
      await query("INSERT INTO bags (username) VALUES (?)", [username]);
      row = await bags.get(username);
    }
    return row;
  },

  async setBag(username: string, slot: string, itemName: string | null) {
    await bags.ensure(username);
    if (!BAG_SLOTS.includes(slot as any)) return false;
    await query(`UPDATE bags SET ${slot} = ? WHERE username = ?`, [itemName, username]);
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

  SLOTS: BAG_SLOTS,
};

export default bags;
