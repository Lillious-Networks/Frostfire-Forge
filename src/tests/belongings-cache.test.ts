import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// What a player owns (inventory, equipment, bags, currency, collectables) is
// read from caches, and written to the database and the cache together. These
// run the real systems against a fake database and compare, after every
// change, what the systems answer with what that database holds.

// ------------------------------------------------------------ fake database
// The five tables, run the way MySQL runs them: names compared without regard
// to case, INT columns holding whole numbers whatever they were given, ids and
// defaults filled in by an INSERT.

type Row = Record<string, any>;

const EQUIPMENT_SLOTS = [
  "helmet", "necklace", "shoulderguards", "cape", "chestplate", "wristguards", "gloves", "belt",
  "pants", "boots", "ring_1", "ring_2", "trinket_1", "trinket_2", "weapon", "off_hand_weapon",
];

/** Each table's columns, in order, with what an INSERT stores in the ones it leaves out. */
const TABLES: Record<string, Row> = {
  inventory: { id: null, username: null, item: null, quantity: null, equipped: 0, slot: null, bag_slot: null },
  equipment: { id: null, username: null, head: "player_head_default", body: "player_body_default", ...Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => [slot, null])) },
  bags: { id: null, username: null, slot_1: null, slot_2: null, slot_3: null, slot_4: null },
  currency: { username: null, copper: 0, silver: 0, gold: 0 },
  collectables: { id: null, type: null, item: null, username: null },
};
/** Tables with one row per player. */
const ONE_ROW = ["equipment", "bags", "currency"];
const WHOLE = ["quantity", "equipped", "slot", "bag_slot", "copper", "silver", "gold"];

let tables: Record<string, Row[]>;
let nextId: number;
/** Every statement on the five tables, in order. */
let queries: string[];
/** Statements that fail: refused, or (lostAfterRunning) run with the answer never coming, as one that timed out can have been. */
let failing: ((sql: string) => boolean) | null;
let lostAfterRunning: boolean;
/** Whether an INSERT's answer says which id the row was given. */
let answersWithId: boolean;
/** How long each coming statement takes to run, and then to answer (ms). */
let lag: Array<{ run: number; answer: number }>;

const fold = (value: any) => String(value).toLowerCase();
/** MySQL's `=`: text without regard to case, and never true of NULL. */
const equal = (a: any, b: any) => a !== null && b !== null && b !== undefined && (typeof a === "string" ? fold(a) === fold(b) : a == b);
/** What a column holds once given `value`: an INT column rounds, and takes a number written as text. */
const stored = (column: string, value: any) => (value === null || value === undefined ? null : WHOLE.includes(column) ? Math.round(Number(value)) : value);

function run(sql: string, params: any[]): any {
  const text = sql.replace(/\s+/g, " ").trim();
  const table = text.match(/(?:FROM|INTO|UPDATE) (\w+)/)?.[1] ?? "";
  // Any other table (the quest log an inventory change reports to) holds nothing.
  if (!(table in TABLES)) return [];
  queries.push(text);
  const fails = failing?.(text) ?? false;
  if (fails && !lostAfterRunning) throw new Error("database gone");
  const answer = execute(text, table, params);
  if (fails) throw new Error("database gone");
  return answer;
}

function execute(text: string, table: string, params: any[]): any {
  const args = [...params];
  const value = (token: string) => (token === "?" ? args.shift() : token === "NULL" ? null : Number(token));
  const where = (clause: string) => {
    const tests = clause.split(" AND ").map((part) => {
      const [column, token] = part.split(" = ");
      const wanted = value(token);
      return (row: Row) => equal(row[column], wanted);
    });
    return (row: Row) => tests.every((passes) => passes(row));
  };
  const assign = (clause: string) => {
    const sets = clause.split(", ").map((part) => {
      const [column, token] = part.split(" = ");
      return [column, stored(column, value(token))] as const;
    });
    return (row: Row) => { for (const [column, to] of sets) row[column] = to; };
  };

  const select = text.match(/^SELECT (.+) FROM \w+ WHERE (.+)$/);
  if (select) {
    const columns = select[1] === "*" ? Object.keys(TABLES[table]) : select[1].split(", ");
    return tables[table].filter(where(select[2])).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
  }

  const insert = text.match(/^INSERT (?:IGNORE )?INTO \w+ \((.+?)\) VALUES \((.+?)\)(?: ON DUPLICATE KEY UPDATE (.+))?$/);
  if (insert) {
    const tokens = insert[2].split(", ");
    const row: Row = { ...TABLES[table] };
    insert[1].split(", ").forEach((column, i) => { row[column] = stored(column, value(tokens[i])); });
    const existing = ONE_ROW.includes(table) ? tables[table].find((other) => equal(other.username, row.username)) : undefined;
    if (existing) {
      if (!insert[3]) throw new Error(`Duplicate entry '${row.username}' for key '${table}.username'`);
      assign(insert[3])(existing);
      return Object.assign([], { affectedRows: 2 });
    }
    if ("id" in row) row.id = nextId++;
    tables[table].push(row);
    return Object.assign([], answersWithId && "id" in row ? { affectedRows: 1, lastInsertRowid: row.id } : { affectedRows: 1 });
  }

  const update = text.match(/^UPDATE \w+ SET (.+) WHERE (.+)$/);
  if (update) {
    const change = assign(update[1]);
    const rows = tables[table].filter(where(update[2]));
    rows.forEach(change);
    return Object.assign([], { affectedRows: rows.length });
  }

  const remove = text.match(/^DELETE FROM \w+ WHERE (.+)$/);
  if (remove) {
    const gone = where(remove[1]);
    const before = tables[table].length;
    tables[table] = tables[table].filter((row) => !gone(row));
    return Object.assign([], { affectedRows: before - tables[table].length });
  }

  throw new Error(`The fake database does not understand: ${text}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, params: any[] = []) => {
    const wait = lag.shift();
    if (!wait) return run(sql, params);
    await sleep(wait.run);
    const answer = run(sql, params);
    await sleep(wait.answer);
    return answer;
  },
}));

const item = (name: string, over: Row = {}) => ({
  name, quality: "common", type: "equipment", description: "", icon: null, equipment_slot: null, bag_slots: null, ...over,
});
const assets = new Map<string, any>([
  ["items", [
    item("Iron Helmet", { equipment_slot: "helmet" }),
    item("Leather Cap", { equipment_slot: "helmet" }),
    item("Health Potion", { type: "consumable" }),
    item("Rat Tail", { type: "material" }),
    item("Small Pouch", { bag_slots: 6 }),
    item("Old Sack"),
  ]],
]);
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => assets.get(key) ?? null,
    set: async (key: string, value: any) => assets.set(key, value),
    add: async (key: string, value: any) => assets.set(key, value),
  },
}));

// The systems compare names the way the configured database does: these tests are of MySQL, the default.
const configuredEngine = process.env.DATABASE_ENGINE;
delete process.env.DATABASE_ENGINE;
afterAll(() => {
  if (configuredEngine !== undefined) process.env.DATABASE_ENGINE = configuredEngine;
});

const { clearCaches, dropRows, forgetPlayer, refreshPlayer } = await import("../services/datacache");
const { default: inventory } = await import("../systems/inventory");
const { default: equipment } = await import("../systems/equipment");
const { default: bags } = await import("../systems/bags");
const { default: currency } = await import("../systems/currency");
const { default: collectables } = await import("../systems/collectables");

// ------------------------------------------------------------------ fixtures

beforeEach(async () => {
  nextId = 100;
  queries = [];
  failing = null;
  lostAfterRunning = false;
  answersWithId = true;
  lag = [];
  tables = {
    inventory: [
      { id: 1, username: "hero", item: "Health Potion", quantity: 3, equipped: 0, slot: 0, bag_slot: 0 },
      { id: 2, username: "hero", item: "Iron Helmet", quantity: 1, equipped: 0, slot: 1, bag_slot: 0 },
      { id: 3, username: "hero", item: "Leather Cap", quantity: 1, equipped: 0, slot: 2, bag_slot: 0 },
      { id: 4, username: "ally", item: "Health Potion", quantity: 9, equipped: 0, slot: 0, bag_slot: 0 },
    ],
    equipment: [{ ...TABLES.equipment, id: 1, username: "hero" }, { ...TABLES.equipment, id: 2, username: "ally" }],
    bags: [],
    currency: [{ username: "hero", copper: 50, silver: 2, gold: 1 }],
    collectables: [{ id: 1, type: "mount", item: "unicorn", username: "hero" }],
  };
  await clearCaches();
});

const reads = () => queries.filter((sql) => sql.startsWith("SELECT"));
const writes = () => queries.filter((sql) => !sql.startsWith("SELECT"));
/** Writes fail from here on: refused, or `made` but never answered. */
const failWrites = (made = false) => {
  failing = (sql) => !sql.startsWith("SELECT");
  lostAfterRunning = made;
};
/** The two ways a write fails, for a test of each. */
const FAILURES: Array<[string, boolean]> = [["refused", false], ["made but never answered", true]];
/** A player's rows in the database. */
const of = (table: string, username: string) => tables[table].filter((row) => fold(row.username) === fold(username));
const stack = (name: string, username = "hero") => of("inventory", username).find((row) => row.item === name);
const byId = (a: Row, b: Row) => a.id - b.id;
const five = ({ item: name, quantity, equipped, slot, bag_slot }: Row) => ({ item: name, quantity, equipped, slot, bag_slot });
const NOTHING: Currency = { copper: 0, silver: 0, gold: 0 };
const INVENTORY_READ = "SELECT * FROM inventory WHERE username = ?";

/** Run `read`, which must be answered without asking the database anything. */
async function fromCache<T>(read: () => Promise<T>): Promise<T> {
  const asked = queries.length;
  const answer = await read();
  expect(queries.slice(asked)).toEqual([]);
  return answer;
}

// What each system answers for a player must be what the database holds for them.

async function inventoryIsDatabase(username: string) {
  const rows = of("inventory", username);
  expect(((await inventory.get(username)) as Row[]).map(five)).toEqual(rows.map(five));
  const found: Row[] = [];
  for (const name of new Set(rows.map((row) => fold(row.item)))) {
    found.push(...((await inventory.find(username, { name, quantity: 0 })) as Row[]));
  }
  expect(found.sort(byId)).toEqual([...rows].sort(byId));
}

async function equipmentIsDatabase(username: string) {
  expect(await equipment.list(username)).toEqual(of("equipment", username)[0] ?? null);
}

async function bagsIsDatabase(username: string) {
  expect(await bags.get(username)).toEqual(of("bags", username)[0] ?? null);
}

async function currencyIsDatabase(username: string) {
  const [row] = of("currency", username);
  expect(await currency.get(username)).toEqual(row ? { copper: row.copper, silver: row.silver, gold: row.gold } : NOTHING);
}

async function collectablesIsDatabase(username: string) {
  expect(await collectables.list(username)).toEqual(of("collectables", username).map((row) => ({ item: row.item, type: row.type })));
}

async function everythingIsDatabase(username: string) {
  await inventoryIsDatabase(username);
  await equipmentIsDatabase(username);
  await bagsIsDatabase(username);
  await currencyIsDatabase(username);
  await collectablesIsDatabase(username);
}

/** Read everything a player owns, so all of it is held. */
const readAll = (username: string) => Promise.all([
  inventory.get(username), equipment.list(username), bags.get(username), currency.get(username), collectables.list(username),
]);

// --------------------------------------------------------------------- tests

describe("inventory", () => {
  test("is read from the database once, by whichever read comes first", async () => {
    expect((await inventory.find("hero", { name: "Health Potion", quantity: 0 })) as Row[]).toEqual([tables.inventory[0]]);
    expect(((await inventory.get("hero")) as Row[]).map((entry) => [entry.name, entry.quantity, entry.type])).toEqual([
      ["Health Potion", 3, "consumable"], ["Iron Helmet", 1, "equipment"], ["Leather Cap", 1, "equipment"],
    ]);
    await inventory.get("HERO");
    await inventory.find("Hero", { name: "Iron Helmet", quantity: 0 });
    expect(queries).toEqual([INVENTORY_READ]);
  });

  test("the list has the columns it always had, and no others", async () => {
    const [first] = (await inventory.get("hero")) as Row[];
    expect(first).toEqual({ ...item("Health Potion", { type: "consumable" }), item: "Health Potion", quantity: 3, equipped: 0, slot: 0, bag_slot: 0 });
  });

  test("an empty inventory is an answer too, and is not asked for again", async () => {
    expect(await inventory.get("nobody")).toEqual([]);
    expect(await inventory.find("nobody", { name: "Rat Tail", quantity: 0 })).toEqual([]);
    expect(await inventory.get("nobody")).toEqual([]);
    expect(queries).toEqual([INVENTORY_READ]);
  });

  test("what a caller does to the rows it was given changes nothing held", async () => {
    const list = (await inventory.get("hero")) as Row[];
    list.reverse();
    list[0].quantity = 999;
    list.pop();
    const found = (await inventory.find("hero", { name: "Iron Helmet", quantity: 0 })) as Row[];
    found[0].equipped = 1;
    found.push({ item: "mine" });
    await fromCache(() => inventoryIsDatabase("hero"));
  });

  test("a stack through its life: gained, added to, used in part, used up", async () => {
    await inventory.get("hero");
    queries = [];

    await inventory.add("hero", { name: "Rat Tail", quantity: 2 });
    // The id is the one the database answered the INSERT with; the rest is what was written and the table's defaults.
    expect(stack("Rat Tail")).toEqual({ id: 100, username: "hero", item: "Rat Tail", quantity: 2, equipped: 0, slot: null, bag_slot: null });
    expect((await fromCache(() => inventory.find("hero", { name: "Rat Tail", quantity: 0 }))) as Row[]).toEqual([stack("Rat Tail")!]);
    await fromCache(() => inventoryIsDatabase("hero"));

    // Written as text ("7"): the database holds the number, and so does the cache.
    await inventory.add("hero", { name: "rat tail", quantity: 5 });
    expect(stack("Rat Tail")!.quantity).toBe(7);
    await fromCache(() => inventoryIsDatabase("hero"));

    await inventory.remove("hero", { name: "Rat Tail", quantity: 3 });
    expect(stack("Rat Tail")!.quantity).toBe(4);
    await fromCache(() => inventoryIsDatabase("hero"));

    await inventory.remove("hero", { name: "Rat Tail", quantity: 4 });
    expect(stack("Rat Tail")).toBeUndefined();
    await fromCache(() => inventoryIsDatabase("hero"));

    // Nothing left to remove: nothing is written.
    expect(await inventory.remove("hero", { name: "Rat Tail", quantity: 1 })).toBeUndefined();
    await fromCache(() => inventoryIsDatabase("hero"));

    expect(queries).toEqual([
      "INSERT IGNORE INTO inventory (username, item, quantity) VALUES (?, ?, ?)",
      "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?",
      "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?",
      "DELETE FROM inventory WHERE item = ? AND username = ?",
    ]);
  });

  test("removing more than is held removes the stack, and leaves other players' alone", async () => {
    await readAll("hero");
    await inventory.remove("hero", { name: "Health Potion", quantity: 50 });
    expect(stack("Health Potion")).toBeUndefined();
    expect(stack("Health Potion", "ally")!.quantity).toBe(9);
    await fromCache(() => inventoryIsDatabase("hero"));
    await inventoryIsDatabase("ally");
  });

  test("an INSERT answered without an id: the rows are read again, once", async () => {
    await inventory.get("hero");
    answersWithId = false;
    queries = [];

    await inventory.add("hero", { name: "Rat Tail", quantity: 2 });
    await inventoryIsDatabase("hero");
    await fromCache(() => inventoryIsDatabase("hero"));
    expect(reads()).toEqual([INVENTORY_READ]);
  });

  test("a quantity the database does not store as given is read back, not guessed", async () => {
    await inventory.get("hero");
    queries = [];

    // 3 + 1.5: an INT column rounds it.
    await inventory.add("hero", { name: "Health Potion", quantity: 1.5 });
    expect(stack("Health Potion")!.quantity).toBe(5);
    await inventoryIsDatabase("hero");
    await fromCache(() => inventoryIsDatabase("hero"));
    expect(reads()).toEqual([INVENTORY_READ]);
  });

  test("worn, taken off, moved and dropped: every change is in both", async () => {
    await inventory.get("hero");
    queries = [];

    await inventory.setEquipped("hero", "Iron Helmet", true);
    expect(stack("Iron Helmet")).toMatchObject({ equipped: 1, slot: 1, bag_slot: 0 });
    await fromCache(() => inventoryIsDatabase("hero"));

    await inventory.setEquipped("hero", "Iron Helmet", false, 7, 1);
    expect(stack("Iron Helmet")).toMatchObject({ equipped: 0, slot: 7, bag_slot: 1 });
    await fromCache(() => inventoryIsDatabase("hero"));

    await inventory.setEquipped("hero", "Iron Helmet", false);
    expect(stack("Iron Helmet")).toMatchObject({ equipped: 0, slot: null, bag_slot: null });
    await fromCache(() => inventoryIsDatabase("hero"));

    await inventory.setUnequippedSlot("hero", "Iron Helmet", 4, null);
    expect(stack("Iron Helmet")).toMatchObject({ equipped: 0, slot: 4, bag_slot: null });
    await fromCache(() => inventoryIsDatabase("hero"));

    await inventory.saveSlots("hero", [{ item: "Health Potion", slot: 9, bag_slot: 0 }, { item: "Iron Helmet", slot: 30, bag_slot: 1 }]);
    expect(stack("Health Potion")).toMatchObject({ slot: 9, bag_slot: 0 });
    expect(stack("Iron Helmet")).toMatchObject({ slot: 30, bag_slot: 1 });
    await fromCache(() => inventoryIsDatabase("hero"));

    await inventory.clearSlot("hero", "Iron Helmet");
    expect(stack("Iron Helmet")).toMatchObject({ slot: null, bag_slot: null });
    await fromCache(() => inventoryIsDatabase("hero"));

    await inventory.delete("hero", { name: "Health Potion", quantity: 0 });
    expect(stack("Health Potion")).toBeUndefined();
    await fromCache(() => inventoryIsDatabase("hero"));

    expect(queries).toEqual([
      "UPDATE inventory SET equipped = 1 WHERE item = ? AND username = ?",
      "UPDATE inventory SET equipped = 0, slot = ?, bag_slot = ? WHERE item = ? AND username = ?",
      "UPDATE inventory SET equipped = 0, slot = ?, bag_slot = ? WHERE item = ? AND username = ?",
      "UPDATE inventory SET equipped = 0, slot = ?, bag_slot = ? WHERE item = ? AND username = ?",
      "UPDATE inventory SET slot = ?, bag_slot = ? WHERE item = ? AND username = ?",
      "UPDATE inventory SET slot = ?, bag_slot = ? WHERE item = ? AND username = ?",
      "UPDATE inventory SET slot = NULL, bag_slot = NULL WHERE item = ? AND username = ?",
      "DELETE FROM inventory WHERE item = ? AND username = ?",
    ]);
  });

  test("a slot the database does not store as given is read back", async () => {
    await inventory.get("hero");
    queries = [];

    await inventory.saveSlots("hero", [{ item: "Health Potion", slot: 2.5, bag_slot: 0 }]);
    expect(stack("Health Potion")!.slot).toBe(3);
    await inventoryIsDatabase("hero");
    expect(reads()).toEqual([INVENTORY_READ]);
  });

  const INVENTORY_WRITES: Array<[string, () => Promise<unknown>]> = [
    ["add (a new stack)", () => inventory.add("hero", { name: "Rat Tail", quantity: 2 })],
    ["add (to a stack)", () => inventory.add("hero", { name: "Health Potion", quantity: 2 })],
    ["remove (part)", () => inventory.remove("hero", { name: "Health Potion", quantity: 1 })],
    ["remove (all)", () => inventory.remove("hero", { name: "Health Potion", quantity: 3 })],
    ["delete", () => inventory.delete("hero", { name: "Health Potion", quantity: 0 })],
    ["setEquipped (on)", () => inventory.setEquipped("hero", "Iron Helmet", true)],
    ["setEquipped (off)", () => inventory.setEquipped("hero", "Iron Helmet", false, 5, 0)],
    ["setUnequippedSlot", () => inventory.setUnequippedSlot("hero", "Iron Helmet", 5, 0)],
    ["saveSlots", () => inventory.saveSlots("hero", [{ item: "Iron Helmet", slot: 5, bag_slot: 0 }])],
    ["clearSlot", () => inventory.clearSlot("hero", "Iron Helmet")],
  ];
  for (const [name, write] of INVENTORY_WRITES) {
    for (const [how, made] of FAILURES) {
      test(`${name}: ${how} by the database, the rows are read again`, async () => {
        await inventory.get("hero");
        const before = structuredClone(tables.inventory);
        failWrites(made);
        await expect(write()).rejects.toThrow("database gone");
        failing = null;

        expect(writes()).toHaveLength(1);
        // Refused, the database holds what it held. Made, it holds a change nothing here was told of.
        if (made) expect(tables.inventory).not.toEqual(before);
        else expect(tables.inventory).toEqual(before);

        // The next read asks the database, once, and answers what it holds.
        queries = [];
        await inventoryIsDatabase("hero");
        await fromCache(() => inventoryIsDatabase("hero"));
        expect(queries).toEqual([INVENTORY_READ]);
      });
    }
  }

  test("a stack gained with the answer never coming is added to, not made a second time", async () => {
    await inventory.get("hero");
    failWrites(true);
    await expect(inventory.add("hero", { name: "Rat Tail", quantity: 2 })).rejects.toThrow("database gone");
    failing = null;

    await inventory.add("hero", { name: "Rat Tail", quantity: 3 });
    expect(of("inventory", "hero").filter((row) => row.item === "Rat Tail").map((row) => row.quantity)).toEqual([5]);
    await fromCache(() => inventoryIsDatabase("hero"));
  });

  test("slots saved until one fails: the rows are read again, with the ones that were written", async () => {
    await inventory.get("hero");
    let saved = 0;
    failing = (sql) => sql.startsWith("UPDATE inventory SET slot") && ++saved === 2;
    await expect(inventory.saveSlots("hero", [
      { item: "Health Potion", slot: 11, bag_slot: 0 }, { item: "Iron Helmet", slot: 12, bag_slot: 0 }, { item: "Leather Cap", slot: 13, bag_slot: 0 },
    ])).rejects.toThrow("database gone");
    failing = null;

    expect(of("inventory", "hero").map((row) => row.slot)).toEqual([11, 1, 2]);
    queries = [];
    await inventoryIsDatabase("hero");
    await fromCache(() => inventoryIsDatabase("hero"));
    expect(queries).toEqual([INVENTORY_READ]);
  });

  test("changes made at the same moment all land, in the database and in the cache", async () => {
    await Promise.all([
      inventory.add("hero", { name: "Rat Tail", quantity: 1 }),
      inventory.add("hero", { name: "Old Sack", quantity: 1 }),
      inventory.add("hero", { name: "Rat Tail", quantity: 2 }),
      inventory.remove("hero", { name: "Health Potion", quantity: 1 }),
      inventory.setEquipped("hero", "Iron Helmet", true),
      inventory.delete("hero", { name: "Leather Cap", quantity: 0 }),
    ]);
    expect(of("inventory", "hero").map((row) => [row.item, row.quantity, row.equipped])).toEqual([
      ["Health Potion", 2, 0], ["Iron Helmet", 1, 1], ["Rat Tail", 3, 0], ["Old Sack", 1, 0],
    ]);
    await fromCache(() => inventoryIsDatabase("hero"));
  });

  test("names are matched the way the database matches them", async () => {
    await inventory.get("hero");
    await inventory.setEquipped("HERO", "iron helmet", true);
    expect(stack("Iron Helmet")!.equipped).toBe(1);
    await fromCache(() => inventoryIsDatabase("hero"));

    // An engine that compares exactly finds no such row, and then neither does the cache.
    process.env.DATABASE_ENGINE = "sqlite";
    try {
      expect(await inventory.find("hero", { name: "iron helmet", quantity: 0 })).toEqual([]);
      expect(await inventory.find("hero", { name: "Iron Helmet", quantity: 0 })).toHaveLength(1);
    } finally {
      delete process.env.DATABASE_ENGINE;
    }
  });
});

describe("equipment", () => {
  test("the row is read once, and so is there being none", async () => {
    expect(await equipment.list("hero")).toEqual(tables.equipment[0]);
    expect(await equipment.list("Hero")).toEqual(tables.equipment[0]);
    expect(await equipment.list("nobody")).toBeNull();
    expect(await equipment.list("nobody")).toBeNull();
    expect(queries).toEqual(["SELECT * FROM equipment WHERE username = ?", "SELECT * FROM equipment WHERE username = ?"]);
  });

  test("what a caller does to the row it was given changes nothing held", async () => {
    const row = await equipment.list("hero");
    row.helmet = "mine";
    await fromCache(() => equipmentIsDatabase("hero"));
  });

  test("an item put on, swapped and taken off is in both, with its inventory row", async () => {
    await readAll("hero");
    queries = [];

    expect(await equipment.equipItem("hero", "helmet", "iron helmet")).toBe(true);
    expect(tables.equipment[0].helmet).toBe("Iron Helmet");
    expect(stack("Iron Helmet")!.equipped).toBe(1);
    await fromCache(() => everythingIsDatabase("hero"));

    // Another helmet: the first comes off.
    expect(await equipment.equipItem("hero", "helmet", "Leather Cap")).toBe(true);
    expect(tables.equipment[0].helmet).toBe("Leather Cap");
    expect(stack("Iron Helmet")).toMatchObject({ equipped: 0, slot: null, bag_slot: null });
    expect(stack("Leather Cap")!.equipped).toBe(1);
    await fromCache(() => everythingIsDatabase("hero"));

    expect(await equipment.unEquipItem("hero", "helmet", "Leather Cap")).toBe(true);
    expect(tables.equipment[0].helmet).toBeNull();
    expect(stack("Leather Cap")!.equipped).toBe(0);
    await fromCache(() => everythingIsDatabase("hero"));

    expect(reads()).toEqual([]);
    expect(writes().filter((sql) => sql.startsWith("UPDATE equipment"))).toEqual([
      "UPDATE equipment SET helmet = ? WHERE username = ?",
      "UPDATE equipment SET helmet = NULL WHERE username = ?",
      "UPDATE equipment SET helmet = ? WHERE username = ?",
      "UPDATE equipment SET helmet = NULL WHERE username = ?",
    ]);
  });

  for (const [how, made] of FAILURES) {
    test(`a write ${how} by the database is reported, and the row is read again`, async () => {
      const EQUIPMENT_READ = "SELECT * FROM equipment WHERE username = ?";
      tables.equipment[0].weapon = "Wooden Staff";
      await readAll("hero");
      const failEquipment = () => {
        queries = [];
        failing = (sql) => sql.startsWith("UPDATE equipment");
        lostAfterRunning = made;
      };

      failEquipment();
      expect(await equipment.equipItem("hero", "helmet", "Iron Helmet")).toBe(false);
      failing = null;
      // It was tried, and did not go on to the inventory.
      expect(queries).toEqual(["UPDATE equipment SET helmet = ? WHERE username = ?"]);
      expect(tables.equipment[0].helmet).toBe(made ? "Iron Helmet" : null);
      // The next read asks the database, once, and answers what it holds.
      queries = [];
      await equipmentIsDatabase("hero");
      await fromCache(() => everythingIsDatabase("hero"));
      expect(queries).toEqual([EQUIPMENT_READ]);

      failEquipment();
      expect(await equipment.unEquipItem("hero", "weapon", "Wooden Staff")).toBe(false);
      failing = null;
      expect(queries).toEqual(["UPDATE equipment SET weapon = NULL WHERE username = ?"]);
      expect(tables.equipment[0].weapon).toBe(made ? null : "Wooden Staff");
      queries = [];
      await equipmentIsDatabase("hero");
      await fromCache(() => everythingIsDatabase("hero"));
      expect(queries).toEqual([EQUIPMENT_READ]);
    });
  }

  test("what cannot be worn there is refused before anything is written", async () => {
    await readAll("hero");
    expect(await equipment.equipItem("hero", "hat", "Iron Helmet")).toBe(false);
    expect(await equipment.equipItem("hero", "weapon", "Iron Helmet")).toBe(false);
    expect(await equipment.unEquipItem("hero", "hat", "Iron Helmet")).toBe(false);
    expect(writes()).toEqual([]);
    await fromCache(() => everythingIsDatabase("hero"));
  });

  test("a write for a player held as having no row does not leave that held", async () => {
    expect(await equipment.list("nobody")).toBeNull();
    // The account is made (by the gateway), and then something is put on.
    tables.equipment.push({ ...TABLES.equipment, id: 9, username: "nobody" });
    expect(await equipment.equipItem("nobody", "helmet", "Iron Helmet")).toBe(true);

    expect((await equipment.list("nobody")).helmet).toBe("Iron Helmet");
    await fromCache(() => equipmentIsDatabase("nobody"));
  });

  test("slots changed at the same moment all land", async () => {
    tables.equipment[0].weapon = "Wooden Staff";
    tables.equipment[0].belt = "Rope Belt";
    await readAll("hero");
    await Promise.all([
      equipment.equipItem("hero", "helmet", "Iron Helmet"),
      equipment.unEquipItem("hero", "weapon", "Wooden Staff"),
      equipment.unEquipItem("hero", "belt", "Rope Belt"),
    ]);
    expect(tables.equipment[0]).toMatchObject({ helmet: "Iron Helmet", weapon: null, belt: null });
    await fromCache(() => everythingIsDatabase("hero"));
  });
});

describe("bags", () => {
  test("the row is read once, and so is there being none", async () => {
    tables.bags.push({ ...TABLES.bags, id: 5, username: "ally", slot_1: "Old Sack" });
    expect(await bags.get("ally")).toEqual(tables.bags[0]);
    expect(await bags.get("ALLY")).toEqual(tables.bags[0]);
    expect(await bags.get("hero")).toBeNull();
    expect(await bags.get("hero")).toBeNull();
    expect(await bags.getTotalBagSlots("ally")).toBe(1);
    expect(await bags.capacity("ally")).toBe(35);
    expect(await bags.capacity("hero")).toBe(25);
    expect(queries).toEqual(["SELECT * FROM bags WHERE username = ?", "SELECT * FROM bags WHERE username = ?"]);
  });

  test("ensure makes the row once, and holds it as the database has it", async () => {
    const made = await bags.ensure("hero");
    // The id is the one the database answered the INSERT with.
    expect(made).toEqual({ id: 100, username: "hero", slot_1: null, slot_2: null, slot_3: null, slot_4: null });
    expect(tables.bags).toEqual([made]);

    expect(await bags.ensure("hero")).toEqual(made);
    expect(await bags.get("HERO")).toEqual(made);
    expect(queries).toEqual(["SELECT * FROM bags WHERE username = ?", "INSERT INTO bags (username) VALUES (?)"]);
  });

  test("ensure asked for twice at the same moment makes one row", async () => {
    const [first, second] = await Promise.all([bags.ensure("hero"), bags.ensure("hero")]);
    expect(first).toEqual(second);
    expect(tables.bags).toHaveLength(1);
    expect(writes()).toHaveLength(1);
  });

  test("an INSERT answered without an id: the new row is read, once", async () => {
    answersWithId = false;
    expect(await bags.ensure("hero")).toEqual(tables.bags[0]);
    await fromCache(() => bagsIsDatabase("hero"));
    expect(queries).toEqual(["SELECT * FROM bags WHERE username = ?", "INSERT INTO bags (username) VALUES (?)", "SELECT * FROM bags WHERE username = ?"]);
  });

  test("a bag put in a slot and taken out is in both, and so is the room it gives", async () => {
    await bags.ensure("hero");
    queries = [];

    expect(await bags.setBag("hero", "slot_2", "Small Pouch")).toBe(true);
    expect(tables.bags[0].slot_2).toBe("Small Pouch");
    expect(await bags.getTotalBagSlots("hero")).toBe(1);
    expect(await bags.capacity("hero")).toBe(31);
    await fromCache(() => bagsIsDatabase("hero"));

    expect(await bags.setBag("hero", "slot_3", "Old Sack")).toBe(true);
    expect(await bags.capacity("hero")).toBe(41);
    await fromCache(() => bagsIsDatabase("hero"));

    expect(await bags.setBag("hero", "slot_2", null)).toBe(true);
    expect(tables.bags[0]).toMatchObject({ slot_2: null, slot_3: "Old Sack" });
    expect(await bags.getTotalBagSlots("hero")).toBe(1);
    expect(await bags.capacity("hero")).toBe(35);
    await fromCache(() => bagsIsDatabase("hero"));

    expect(await bags.setBag("hero", "slot_9", "Old Sack")).toBe(false);
    expect(queries).toEqual([
      "UPDATE bags SET slot_2 = ? WHERE username = ?",
      "UPDATE bags SET slot_3 = ? WHERE username = ?",
      "UPDATE bags SET slot_2 = ? WHERE username = ?",
    ]);
  });

  test("a bag for a player with no row yet makes the row first", async () => {
    expect(await bags.setBag("hero", "slot_1", "Old Sack")).toBe(true);
    expect(tables.bags).toEqual([{ id: 100, username: "hero", slot_1: "Old Sack", slot_2: null, slot_3: null, slot_4: null }]);
    await fromCache(() => bagsIsDatabase("hero"));
  });

  for (const [how, made] of FAILURES) {
    test(`writes ${how} by the database have the row read again`, async () => {
      const BAGS_READ = "SELECT * FROM bags WHERE username = ?";
      failWrites(made);
      await expect(bags.ensure("hero")).rejects.toThrow("database gone");
      failing = null;
      expect(writes()).toHaveLength(1);
      expect(tables.bags).toHaveLength(made ? 1 : 0);

      // Asked for again, the row is the one the database holds: made at the first try after all, or made now.
      queries = [];
      expect(await bags.ensure("hero")).toEqual(tables.bags[0]);
      expect(tables.bags).toHaveLength(1);
      expect(queries).toEqual(made ? [BAGS_READ] : [BAGS_READ, "INSERT INTO bags (username) VALUES (?)"]);

      queries = [];
      failWrites(made);
      await expect(bags.setBag("hero", "slot_1", "Old Sack")).rejects.toThrow("database gone");
      failing = null;
      expect(queries).toEqual(["UPDATE bags SET slot_1 = ? WHERE username = ?"]);
      expect(tables.bags[0].slot_1).toBe(made ? "Old Sack" : null);
      // The next read asks the database, once, and answers what it holds.
      queries = [];
      await bagsIsDatabase("hero");
      await fromCache(() => bagsIsDatabase("hero"));
      expect(queries).toEqual([BAGS_READ]);
    });
  }

  test("bags changed at the same moment all land", async () => {
    await Promise.all([bags.setBag("hero", "slot_1", "Old Sack"), bags.setBag("hero", "slot_2", "Small Pouch"), bags.setBag("hero", "slot_4", "Old Sack")]);
    expect(tables.bags).toEqual([{ id: 100, username: "hero", slot_1: "Old Sack", slot_2: "Small Pouch", slot_3: null, slot_4: "Old Sack" }]);
    await fromCache(() => bagsIsDatabase("hero"));
  });
});

describe("currency", () => {
  test("a balance is read once, and a player with no row has nothing", async () => {
    expect(await currency.get("hero")).toEqual({ copper: 50, silver: 2, gold: 1 });
    expect(await currency.get("HERO")).toEqual({ copper: 50, silver: 2, gold: 1 });
    expect(await currency.get("nobody")).toEqual(NOTHING);
    expect(await currency.get("nobody")).toEqual(NOTHING);
    expect(queries).toEqual(["SELECT copper, silver, gold FROM currency WHERE username = ?", "SELECT copper, silver, gold FROM currency WHERE username = ?"]);
  });

  test("what a caller does to the balance it was given changes nothing held", async () => {
    const balance = await currency.get("hero");
    balance.gold = 9999;
    await fromCache(() => currencyIsDatabase("hero"));
  });

  test("received, paid and overdrawn: after every step the cache is the database", async () => {
    await currency.get("hero");
    queries = [];

    // Copper carries into silver.
    expect(await currency.add("hero", { copper: 70, silver: 0, gold: 0 })).toEqual({ copper: 20, silver: 3, gold: 1 });
    expect(tables.currency[0]).toEqual({ username: "hero", copper: 20, silver: 3, gold: 1 });
    await fromCache(() => currencyIsDatabase("hero"));

    // And silver into gold.
    expect(await currency.add("hero", { copper: 0, silver: 98, gold: 2 })).toEqual({ copper: 20, silver: 1, gold: 4 });
    expect(tables.currency[0]).toEqual({ username: "hero", copper: 20, silver: 1, gold: 4 });
    await fromCache(() => currencyIsDatabase("hero"));

    // Paying borrows from the coin above.
    expect(await currency.remove("hero", { copper: 30, silver: 0, gold: 0 })).toEqual({ copper: 90, silver: 0, gold: 4 });
    expect(tables.currency[0]).toEqual({ username: "hero", copper: 90, silver: 0, gold: 4 });
    await fromCache(() => currencyIsDatabase("hero"));

    expect(await currency.remove("hero", { copper: 0, silver: 5, gold: 0 })).toEqual({ copper: 90, silver: 95, gold: 3 });
    expect(tables.currency[0]).toEqual({ username: "hero", copper: 90, silver: 95, gold: 3 });
    await fromCache(() => currencyIsDatabase("hero"));

    // More gold than is held.
    expect(await currency.remove("hero", { copper: 0, silver: 0, gold: 10 })).toEqual({ copper: 90, silver: 95, gold: 0 });
    expect(tables.currency[0]).toEqual({ username: "hero", copper: 90, silver: 95, gold: 0 });
    await fromCache(() => currencyIsDatabase("hero"));

    await currency.set("hero", { copper: 1, silver: 2, gold: 3 });
    expect(tables.currency[0]).toEqual({ username: "hero", copper: 1, silver: 2, gold: 3 });
    await fromCache(() => currencyIsDatabase("hero"));

    expect(reads()).toEqual([]);
    expect(writes()).toHaveLength(6);
  });

  test("a negative amount changes nothing", async () => {
    await currency.get("hero");
    expect(await currency.add("hero", { copper: -5, silver: 0, gold: 0 })).toEqual(NOTHING);
    expect(await currency.remove("hero", { copper: 0, silver: 0, gold: -1 })).toEqual(NOTHING);
    expect(writes()).toEqual([]);
    await fromCache(() => currencyIsDatabase("hero"));
  });

  test("a player with no row gets one with their first coins", async () => {
    expect(await currency.add("ally", { copper: 5, silver: 0, gold: 0 })).toEqual({ copper: 5, silver: 0, gold: 0 });
    expect(of("currency", "ally")).toEqual([{ username: "ally", copper: 5, silver: 0, gold: 0 }]);
    await fromCache(() => currencyIsDatabase("ally"));
  });

  test("coins received at the same moment are all counted", async () => {
    await Promise.all([1, 2, 3, 4].map((copper) => currency.add("hero", { copper, silver: 0, gold: 0 })));
    expect(tables.currency[0]).toEqual({ username: "hero", copper: 60, silver: 2, gold: 1 });
    await fromCache(() => currencyIsDatabase("hero"));
  });

  test("answers that come back out of order do not leave an older balance held", async () => {
    await currency.get("hero");
    // Sent side by side, the second would run after the first and be answered before it.
    lag = [{ run: 5, answer: 40 }, { run: 15, answer: 5 }];
    await Promise.all([
      currency.set("hero", { copper: 1, silver: 1, gold: 1 }),
      currency.set("hero", { copper: 2, silver: 2, gold: 2 }),
    ]);
    lag = [];
    expect(tables.currency[0]).toEqual({ username: "hero", copper: 2, silver: 2, gold: 2 });
    await fromCache(() => currencyIsDatabase("hero"));
  });

  const CURRENCY_WRITES: Array<[string, () => Promise<unknown>]> = [
    ["set", () => currency.set("hero", { copper: 1, silver: 1, gold: 1 })],
    ["add", () => currency.add("hero", { copper: 1, silver: 0, gold: 0 })],
    ["remove", () => currency.remove("hero", { copper: 1, silver: 0, gold: 0 })],
  ];
  for (const [name, write] of CURRENCY_WRITES) {
    for (const [how, made] of FAILURES) {
      test(`${name}: ${how} by the database, the balance is read again`, async () => {
        const before = { username: "hero", copper: 50, silver: 2, gold: 1 };
        await currency.get("hero");
        failWrites(made);
        await expect(write()).rejects.toThrow("database gone");
        failing = null;

        expect(writes()).toHaveLength(1);
        if (made) expect(tables.currency[0]).not.toEqual(before);
        else expect(tables.currency[0]).toEqual(before);

        // The next read asks the database, once, and answers what it holds.
        queries = [];
        await currencyIsDatabase("hero");
        await fromCache(() => currencyIsDatabase("hero"));
        expect(queries).toEqual(["SELECT copper, silver, gold FROM currency WHERE username = ?"]);
      });
    }
  }

  test("coins received after a payment whose answer never came are added to what the database holds", async () => {
    await currency.get("hero");
    failWrites(true);
    await expect(currency.add("hero", { copper: 10, silver: 0, gold: 0 })).rejects.toThrow("database gone");
    failing = null;

    expect(await currency.add("hero", { copper: 5, silver: 0, gold: 0 })).toEqual({ copper: 65, silver: 2, gold: 1 });
    expect(tables.currency[0]).toEqual({ username: "hero", copper: 65, silver: 2, gold: 1 });
    await fromCache(() => currencyIsDatabase("hero"));
  });

  test("an amount the database does not store as given is read back, not guessed", async () => {
    await currency.get("hero");
    queries = [];

    await currency.add("hero", { copper: 0.5, silver: 0, gold: 0 });
    expect(tables.currency[0].copper).toBe(51);
    await currencyIsDatabase("hero");
    await fromCache(() => currencyIsDatabase("hero"));
    expect(reads()).toHaveLength(1);
  });
});

describe("collectables", () => {
  const mount = (name: string, username = "hero"): Collectable => ({ type: "mount", item: name, username, icon: null });

  test("a player's list is read once, and an empty one is kept", async () => {
    expect(await collectables.list("hero")).toEqual([{ item: "unicorn", type: "mount" }]);
    expect(await collectables.list("HERO")).toEqual([{ item: "unicorn", type: "mount" }]);
    expect(await collectables.find(mount("unicorn"))).toEqual([{ item: "unicorn", type: "mount" }]);
    expect(await collectables.find(mount("wolf"))).toBeUndefined();
    expect(await collectables.list("ally")).toEqual([]);
    expect(await collectables.list("ally")).toEqual([]);
    expect(queries).toEqual(["SELECT item, type FROM collectables WHERE username = ?", "SELECT item, type FROM collectables WHERE username = ?"]);
  });

  test("what a caller does to the list it was given changes nothing held", async () => {
    const list = await collectables.list("hero");
    list.splice(0, 1);
    list.push({ item: "mine", type: "mount" });
    await fromCache(() => collectablesIsDatabase("hero"));
  });

  test("given, found, given again and taken away: every change is in both", async () => {
    await collectables.list("hero");
    queries = [];

    await collectables.add(mount("wolf"));
    expect(tables.collectables.at(-1)).toEqual({ id: 100, type: "mount", item: "wolf", username: "hero" });
    expect(await collectables.find(mount("wolf"))).toEqual([{ item: "wolf", type: "mount" }]);
    await fromCache(() => collectablesIsDatabase("hero"));

    // Already owned: not given a second time.
    expect(await collectables.add(mount("wolf"))).toBeUndefined();
    expect(of("collectables", "hero")).toHaveLength(2);

    await collectables.remove(mount("unicorn"));
    expect(of("collectables", "hero").map((row) => row.item)).toEqual(["wolf"]);
    expect(await collectables.find(mount("unicorn"))).toBeUndefined();
    await fromCache(() => collectablesIsDatabase("hero"));

    expect(queries).toEqual([
      "INSERT INTO collectables (type, item, username) VALUES (?, ?, ?)",
      "DELETE FROM collectables WHERE type = ? AND item = ? AND username = ?",
    ]);
  });

  test("the same collectable given twice at the same moment is given once", async () => {
    await Promise.all([collectables.add(mount("wolf")), collectables.add(mount("wolf")), collectables.add(mount("bear"))]);
    expect(of("collectables", "hero").map((row) => row.item)).toEqual(["unicorn", "wolf", "bear"]);
    await fromCache(() => collectablesIsDatabase("hero"));
  });

  for (const [how, made] of FAILURES) {
    test(`writes ${how} by the database have the list read again`, async () => {
      const owned = () => of("collectables", "hero").map((row) => row.item);
      await collectables.list("hero");
      failWrites(made);
      await expect(collectables.add(mount("wolf"))).rejects.toThrow("database gone");
      failing = null;
      expect(writes()).toHaveLength(1);
      expect(owned()).toEqual(made ? ["unicorn", "wolf"] : ["unicorn"]);

      // Given again, it is given only where the database does not have it after all: read once to find out.
      queries = [];
      await collectables.add(mount("wolf"));
      expect(owned()).toEqual(["unicorn", "wolf"]);
      expect(reads()).toEqual(["SELECT item, type FROM collectables WHERE username = ?"]);
      expect(writes()).toHaveLength(made ? 0 : 1);

      failWrites(made);
      await expect(collectables.remove(mount("unicorn"))).rejects.toThrow("database gone");
      failing = null;
      expect(owned()).toEqual(made ? ["wolf"] : ["unicorn", "wolf"]);
      // The next read asks the database, once, and answers what it holds.
      queries = [];
      await collectablesIsDatabase("hero");
      await fromCache(() => collectablesIsDatabase("hero"));
      expect(queries).toEqual(["SELECT item, type FROM collectables WHERE username = ?"]);
    });
  }
});

describe("the caches", () => {
  test("go by the agreed names, so another writer can have a player's rows read again", async () => {
    for (const name of ["inventory", "equipment", "bags", "currency", "collectables"]) {
      await readAll("hero");
      queries = [];
      await dropRows(name, "Hero");
      await readAll("hero");
      expect(queries).toEqual([expect.stringContaining(` FROM ${name} WHERE username = ?`)]);
    }
  });

  test("are a player's own: read again at login, forgotten when they leave", async () => {
    await readAll("hero");
    // Written while the player was away, by something else.
    tables.currency[0].gold = 500;
    tables.inventory.push({ id: 50, username: "hero", item: "Rat Tail", quantity: 8, equipped: 0, slot: 3, bag_slot: 0 });
    tables.collectables.push({ id: 51, type: "mount", item: "wolf", username: "hero" });
    tables.equipment[0].weapon = "Iron Helmet";
    tables.bags.push({ ...TABLES.bags, id: 52, username: "hero", slot_1: "Old Sack" });
    queries = [];

    await refreshPlayer("Hero");
    expect(reads()).toHaveLength(5);
    await fromCache(() => everythingIsDatabase("hero"));

    await forgetPlayer("hero");
    await readAll("hero");
    expect(reads()).toHaveLength(10);
  });
});
