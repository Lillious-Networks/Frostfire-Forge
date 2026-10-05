import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ------------------------------------------------------------ fake database
// The statements lootTable sends, run against in-memory tables, with a pause
// in each one so that two requests sent together really do interleave. The
// only reads it knows are the two that load every table: a check that asked
// the database instead of the tables held would fail the test that made it.

type Row = Record<string, any>;
let db: { loot_tables: Row[]; loot_table_items: Row[] };
let nextId: number;
/** Statements that fail as a lost connection would. */
let failing: RegExp | null;
/** Whether an INSERT reports the id it gave the row. */
let reportsInsertId: boolean;
const queries: Array<{ sql: string; params: any[] }> = [];

const LOAD = ["SELECT * FROM loot_tables ORDER BY id DESC", "SELECT * FROM loot_table_items ORDER BY id"];
const copy = (row: Row): Row => ({ ...row });
/** What an INSERT answers: no rows, and the new row's id when the database says it. */
const inserted = (id: number) => (reportsInsertId ? Object.assign([], { lastInsertRowid: id, affectedRows: 1 }) : []);

async function run(sql: string, params: any[] = []): Promise<any> {
  const text = sql.replace(/\s+/g, " ").trim();
  queries.push({ sql: text, params });
  await new Promise((resolve) => setTimeout(resolve, 1));
  if (failing?.test(text)) throw new Error("Connection lost");

  if (text === LOAD[0]) return [...db.loot_tables].sort((a, b) => b.id - a.id).map(copy);
  if (text === LOAD[1]) return [...db.loot_table_items].sort((a, b) => a.id - b.id).map(copy);
  if (text === "INSERT INTO loot_tables (name) VALUES (?)") {
    const id = nextId++;
    db.loot_tables.push({ id, name: params[0], created_at: null });
    return inserted(id);
  }
  if (text === "DELETE FROM loot_tables WHERE id = ?") {
    db.loot_tables = db.loot_tables.filter((r) => r.id !== params[0]);
    return [];
  }
  if (text === "DELETE FROM loot_table_items WHERE loot_table_id = ?") {
    db.loot_table_items = db.loot_table_items.filter((r) => r.loot_table_id !== params[0]);
    return [];
  }
  if (text === "DELETE FROM loot_table_items WHERE id = ?") {
    db.loot_table_items = db.loot_table_items.filter((r) => r.id !== params[0]);
    return [];
  }
  if (text === "INSERT INTO loot_table_items (loot_table_id, item_name, min_quantity, max_quantity, drop_chance, quality) VALUES (?, ?, ?, ?, ?, ?)") {
    const [loot_table_id, item_name, min_quantity, max_quantity, drop_chance, quality] = params;
    const id = nextId++;
    db.loot_table_items.push({ id, loot_table_id, item_name, min_quantity, max_quantity, drop_chance, quality });
    return inserted(id);
  }
  if (text === "UPDATE loot_table_items SET min_quantity = ?, max_quantity = ?, drop_chance = ?, quality = ? WHERE id = ?") {
    const [min_quantity, max_quantity, drop_chance, quality, id] = params;
    for (const row of db.loot_table_items.filter((r) => r.id === id)) Object.assign(row, { min_quantity, max_quantity, drop_chance, quality });
    return [];
  }
  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => ({
  default: (sql: string, params: any[] = []) => run(sql, params),
}));

const cache = new Map<string, any>();
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => cache.get(key),
    set: async (key: string, value: any) => cache.set(key, value),
    add: async (key: string, value: any) => cache.set(key, value),
  },
}));

const { default: log } = await import("../modules/logger");
const { clearCaches } = await import("../services/datacache");
const { default: lootTable } = await import("../systems/lootTable");
const editor = await import("../systems/looteditor");

// ------------------------------------------------------------------ fixtures

const KEEPER = { id: "le-1", username: "keeper", permissions: ["admin.loot"] };
const MODERATOR = { id: "le-2", username: "mod", permissions: ["admin.*"] };
// The admin role and the other editors' permissions: /loottable asks for neither.
const BUILDER = { id: "le-3", username: "builder", isAdmin: true, permissions: ["tools.*", "server.*", "admin.items"] };

const CHANGES = ["LOOT_EDITOR_CREATE_TABLE", "LOOT_EDITOR_DELETE_TABLE", "LOOT_EDITOR_ADD_ITEM", "LOOT_EDITOR_REMOVE_ITEM", "LOOT_EDITOR_UPDATE_ITEM"];

function resetWorld() {
  nextId = 100;
  failing = null;
  reportsInsertId = true;
  queries.length = 0;
  db = {
    loot_tables: [
      { id: 3, name: "Bandit Camp", created_at: null },
      { id: 7, name: "Frost Wolves", created_at: null },
    ],
    loot_table_items: [
      { id: 31, loot_table_id: 3, item_name: "Iron Sword", min_quantity: 1, max_quantity: 1, drop_chance: 12, quality: "common" },
      // A quality the game no longer has: the row keeps it.
      { id: 32, loot_table_id: 3, item_name: "Odd Trinket", min_quantity: 1, max_quantity: 3, drop_chance: 45, quality: "mythic" },
      { id: 71, loot_table_id: 7, item_name: "Wolf Pelt", min_quantity: 1, max_quantity: 2, drop_chance: 60, quality: "common" },
    ],
  };
  cache.set("items", [
    { name: "Iron Sword", quality: "common" },
    { name: "Wolf Pelt", quality: "common" },
    { name: "Frostbite", quality: "epic" },
  ]);
}

const act = (type: string, data: any, player: any = KEEPER) => editor.handleEditorPacket(player, type, data);
const writes = () => queries.filter((q) => /^(INSERT|UPDATE|DELETE)/.test(q.sql));
const rowsOf = (tableId: number) => db.loot_table_items.filter((r) => r.loot_table_id === tableId);
const numbers = (min: unknown, max: unknown, chance: unknown) => ({ minQuantity: min, maxQuantity: max, dropChance: chance });

const AMOUNTS = `The fewest and the most must be whole numbers from 1 to ${editor.QUANTITY_MAX}.`;
const ORDER = "The fewest cannot be more than the most.";
const CHANCE = "The chance must be from 0 to 100.";
const GONE_TABLE = "That loot table is no longer there.";
const GONE_ROW = "That row is no longer in its table.";

/** Numbers the server will not store, and what it says of each. */
const BAD_NUMBERS: Array<[data: Row, errors: string[]]> = [
  [numbers(0, 1, 100), [AMOUNTS]],
  [numbers(1, editor.QUANTITY_MAX + 1, 100), [AMOUNTS]],
  [numbers(1.5, 2, 100), [AMOUNTS]],
  [numbers("1", 2, 100), [AMOUNTS]],
  [numbers(1, undefined, 100), [AMOUNTS]],
  [numbers(5, 2, 100), [ORDER]],
  [numbers(1, 1, -0.1), [CHANCE]],
  [numbers(1, 1, 100.1), [CHANCE]],
  [numbers(1, 1, "50"), [CHANCE]],
  [numbers(1, 1, undefined), [CHANCE]],
  [numbers(0, 1, 250), [AMOUNTS, CHANCE]],
];

// A table's name is compared as the database engine compares it: these tests are of MySQL's way, without regard to case.
const configuredEngine = process.env.DATABASE_ENGINE;
beforeAll(() => { delete process.env.DATABASE_ENGINE; });
afterAll(() => { if (configuredEngine !== undefined) process.env.DATABASE_ENGINE = configuredEngine; });

// Each test starts from a different database: what was held of the last one is forgotten.
beforeEach(async () => {
  resetWorld();
  await clearCaches();
});

// ------------------------------------------------------------------- tests

describe("loot editor permission", () => {
  test("the /loottable rule: admin.loot or admin.*, and nothing else", () => {
    expect(editor.canUseEditor(KEEPER)).toBe(true);
    expect(editor.canUseEditor(MODERATOR)).toBe(true);
    expect(editor.canUseEditor(BUILDER)).toBe(false);
    expect(editor.canUseEditor({ username: "stranger", permissions: [] })).toBe(false);
    expect(editor.canUseEditor({ username: "stranger" })).toBe(false);
    expect(editor.canUseEditor(null)).toBe(false);
  });

  test("every packet is refused without the permission, and nothing is read or written", async () => {
    for (const type of CHANGES) {
      const result = await act(type, { name: "Mine", id: 3, tableId: 3, itemId: 31, itemName: "Wolf Pelt", ...numbers(1, 1, 100), request: 4 }, BUILDER);
      expect(result).toEqual({ ok: false, errors: [editor.DENIED], request: 4, tables: null });
    }
    expect(queries).toEqual([]);
  });
});

describe("the answer", () => {
  test("carries every table as LIST_LOOT_TABLES sends them, after the change", async () => {
    const result = await act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 31 });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.tables).toEqual(await lootTable.list());
    expect(result.tables).toEqual([
      { id: 7, name: "Frost Wolves", created_at: null, items: [{ id: 71, item_name: "Wolf Pelt", min_quantity: 1, max_quantity: 2, drop_chance: 60, quality: "common" }] },
      { id: 3, name: "Bandit Camp", created_at: null, items: [{ id: 32, item_name: "Odd Trinket", min_quantity: 1, max_quantity: 3, drop_chance: 45, quality: "mythic" }] },
    ]);
  });

  test("carries the tables when the change is refused too", async () => {
    const result = await act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 999 });
    expect(result.ok).toBe(false);
    expect(result.tables).toEqual(await lootTable.list());
  });

  test("hands back the number the editor gave its request, and only a number", async () => {
    expect((await act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 31, request: 12 })).request).toBe(12);
    expect((await act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 999, request: 13 })).request).toBe(13);
    expect((await act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 32 })).request).toBeUndefined();
    expect((await act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 71, request: "14" })).request).toBeUndefined();
  });

  test("an unknown action is refused", async () => {
    const result = await act("LOOT_EDITOR_NONSENSE", {});
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["Unknown loot editor action: LOOT_EDITOR_NONSENSE"]);
    expect(writes()).toEqual([]);
  });

  test("a change the database fails is answered as not made, with the tables as the database then holds them", async () => {
    await lootTable.list();
    queries.length = 0;
    failing = /^DELETE FROM loot_table_items WHERE id/;
    const logged = spyOn(log, "error").mockImplementation(() => {});
    try {
      const result = await act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 31 });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(["The server could not do that: Connection lost"]);
      expect(result.tables!.find((t) => t.id === 3)!.items.map((i) => i.id)).toEqual([31, 32]);
      expect(logged).toHaveBeenCalledTimes(1);
      // A statement that failed may still have been applied, so the answer was read from the database, not from what was held.
      expect(queries.map((q) => q.sql)).toEqual(["DELETE FROM loot_table_items WHERE id = ?", ...LOAD]);
    } finally {
      logged.mockRestore();
    }
  });

  test("no answer is made up when the tables cannot be read back", async () => {
    await lootTable.list();
    failing = /^(DELETE FROM loot_table_items WHERE id|SELECT \* FROM loot_tables ORDER BY)/;
    const logged = spyOn(log, "error").mockImplementation(() => {});
    try {
      await expect(act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 31 })).rejects.toThrow("Connection lost");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("the tables held", () => {
  beforeEach(async () => {
    await lootTable.list();
    queries.length = 0;
  });

  test("a change is checked against them and answered from them: the database is sent the write and nothing else", async () => {
    expect((await act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 31 })).ok).toBe(true);
    expect((await act("LOOT_EDITOR_UPDATE_ITEM", { itemId: 32, ...numbers(2, 9, 0.5) })).ok).toBe(true);
    expect((await act("LOOT_EDITOR_ADD_ITEM", { tableId: 7, itemName: "Frostbite", ...numbers(1, 2, 50) })).ok).toBe(true);
    const result = await act("LOOT_EDITOR_DELETE_TABLE", { id: 3 });
    expect(result.ok).toBe(true);

    expect(queries.map((q) => q.sql.split(" ").slice(0, 3).join(" "))).toEqual([
      "DELETE FROM loot_table_items", "UPDATE loot_table_items SET", "INSERT INTO loot_table_items", "DELETE FROM loot_table_items", "DELETE FROM loot_tables",
    ]);
    expect(result.tables).toEqual([{
      id: 7, name: "Frost Wolves", created_at: null, items: [
        { id: 71, item_name: "Wolf Pelt", min_quantity: 1, max_quantity: 2, drop_chance: 60, quality: "common" },
        { id: 100, item_name: "Frostbite", min_quantity: 1, max_quantity: 2, drop_chance: 50, quality: "epic" },
      ],
    }]);
  });

  test("a refused change asks the database nothing", async () => {
    await act("LOOT_EDITOR_CREATE_TABLE", { name: "bandit camp" });
    await act("LOOT_EDITOR_DELETE_TABLE", { id: 44 });
    await act("LOOT_EDITOR_ADD_ITEM", { tableId: 44, itemName: "Wolf Pelt", ...numbers(1, 1, 100) });
    await act("LOOT_EDITOR_ADD_ITEM", { tableId: 7, itemName: "Dragon Scale", ...numbers(1, 1, 100) });
    await act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 999 });
    await act("LOOT_EDITOR_UPDATE_ITEM", { itemId: 999, ...numbers(1, 2, 50) });
    expect(queries).toEqual([]);
  });

  test("a new table is read back with the id the database gave it, whether or not the INSERT's answer says it", async () => {
    for (const [reports, name, id] of [[true, "Ember Spiders", 100], [false, "Marsh Toads", 101]] as const) {
      reportsInsertId = reports;
      queries.length = 0;
      const result = await act("LOOT_EDITOR_CREATE_TABLE", { name });
      expect(result.id).toBe(id);
      expect(result.tables![0]).toEqual({ id, name, created_at: null, items: [] });
      expect(queries.map((q) => q.sql)).toEqual(["INSERT INTO loot_tables (name) VALUES (?)", ...LOAD]);
    }
  });

  test("a new row whose INSERT does not say its id is read back with it", async () => {
    reportsInsertId = false;
    const result = await act("LOOT_EDITOR_ADD_ITEM", { tableId: 7, itemName: "Frostbite", ...numbers(1, 2, 50) });
    expect(result.tables!.find((t) => t.id === 7)!.items.map((i) => i.id)).toEqual([71, 100]);
    expect(queries.map((q) => q.sql.split(" ").slice(0, 3).join(" "))).toEqual(["INSERT INTO loot_table_items", "SELECT * FROM", "SELECT * FROM"]);
    // The row can be changed by that id straight away.
    expect((await act("LOOT_EDITOR_UPDATE_ITEM", { itemId: 100, ...numbers(3, 3, 5) })).ok).toBe(true);
    expect(db.loot_table_items.find((r) => r.id === 100)).toMatchObject({ min_quantity: 3, max_quantity: 3, drop_chance: 5 });
  });
});

describe("creating a table", () => {
  test("makes it and says which one it is", async () => {
    const result = await act("LOOT_EDITOR_CREATE_TABLE", { name: "Ember Spiders" });
    expect(result.ok).toBe(true);
    expect(result.id).toBe(100);
    expect(result.tables![0]).toEqual({ id: 100, name: "Ember Spiders", created_at: null, items: [] });
    expect(db.loot_tables.map((t) => t.name)).toEqual(["Bandit Camp", "Frost Wolves", "Ember Spiders"]);
  });

  test("a name is kept as it was typed, but for the space around it and control characters in it", async () => {
    expect((await act("LOOT_EDITOR_CREATE_TABLE", { name: "  The \"Old\" Mill's\tchest \n" })).ok).toBe(true);
    expect(db.loot_tables.at(-1)!.name).toBe("The \"Old\" Mill's chest");
  });

  test("a name that is taken is refused, whatever its case", async () => {
    for (const name of ["Bandit Camp", "bandit camp"]) {
      const result = await act("LOOT_EDITOR_CREATE_TABLE", { name });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual([`A loot table named "${name}" already exists.`]);
      expect(result.id).toBeUndefined();
    }
    expect(writes()).toEqual([]);
    expect(db.loot_tables).toHaveLength(2);
  });

  test("no name, a name that is not text and one too long are refused", async () => {
    for (const name of ["", "   ", undefined, null, 12, ["Mine"], { name: "Mine" }]) {
      expect((await act("LOOT_EDITOR_CREATE_TABLE", { name })).errors).toEqual(["Give the loot table a name."]);
    }
    expect((await act("LOOT_EDITOR_CREATE_TABLE", null)).errors).toEqual(["Give the loot table a name."]);
    expect((await act("LOOT_EDITOR_CREATE_TABLE", { name: "x".repeat(editor.NAME_MAX + 1) })).errors)
      .toEqual([`The name must be ${editor.NAME_MAX} characters or fewer.`]);
    expect((await act("LOOT_EDITOR_CREATE_TABLE", { name: "x".repeat(editor.NAME_MAX) })).ok).toBe(true);
    expect(writes()).toHaveLength(1);
  });

  test("the same request sent twice makes one table", async () => {
    const [first, second] = await Promise.all([
      act("LOOT_EDITOR_CREATE_TABLE", { name: "Ember Spiders" }),
      act("LOOT_EDITOR_CREATE_TABLE", { name: "Ember Spiders" }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.errors).toEqual(["A loot table named \"Ember Spiders\" already exists."]);
    expect(db.loot_tables.filter((t) => t.name === "Ember Spiders")).toHaveLength(1);
  });
});

describe("deleting a table", () => {
  test("removes the table and its rows", async () => {
    const result = await act("LOOT_EDITOR_DELETE_TABLE", { id: 3 });
    expect(result.ok).toBe(true);
    expect(result.tables!.map((t) => t.id)).toEqual([7]);
    expect(rowsOf(3)).toEqual([]);
    expect(rowsOf(7)).toHaveLength(1);
  });

  test("a table that is no longer there is refused", async () => {
    const result = await act("LOOT_EDITOR_DELETE_TABLE", { id: 44 });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([GONE_TABLE]);
    expect(writes()).toEqual([]);
  });

  test("the same request sent twice is refused the second time", async () => {
    const [first, second] = await Promise.all([act("LOOT_EDITOR_DELETE_TABLE", { id: 3 }), act("LOOT_EDITOR_DELETE_TABLE", { id: 3 })]);
    expect(first.ok).toBe(true);
    expect(second.errors).toEqual([GONE_TABLE]);
  });

  test("anything that is not a table's id is refused", async () => {
    for (const id of [0, -3, 1.5, "3", null, undefined, [3]]) {
      expect((await act("LOOT_EDITOR_DELETE_TABLE", { id })).errors).toEqual(["Pick a loot table."]);
    }
    // The tables were read once, to answer the first of them, and nothing was written.
    expect(queries.map((q) => q.sql)).toEqual(LOAD);
  });
});

describe("adding an item", () => {
  test("adds the row under the item's own name and quality", async () => {
    const result = await act("LOOT_EDITOR_ADD_ITEM", { tableId: 7, itemName: "frostbite", ...numbers(2, 5, 12.5) });
    expect(result.ok).toBe(true);
    expect(rowsOf(7).at(-1)).toEqual({ id: 100, loot_table_id: 7, item_name: "Frostbite", min_quantity: 2, max_quantity: 5, drop_chance: 12.5, quality: "epic" });
    expect(result.tables!.find((t) => t.id === 7)!.items.map((i) => i.item_name)).toEqual(["Wolf Pelt", "Frostbite"]);
  });

  test("an item the server does not have is refused", async () => {
    const result = await act("LOOT_EDITOR_ADD_ITEM", { tableId: 7, itemName: "Dragon Scale", ...numbers(1, 1, 100) });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["There is no item named \"Dragon Scale\"."]);
    expect(writes()).toEqual([]);
  });

  test("a table that is no longer there is refused, and no row is left without one", async () => {
    const result = await act("LOOT_EDITOR_ADD_ITEM", { tableId: 44, itemName: "Wolf Pelt", ...numbers(1, 1, 100) });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([GONE_TABLE]);
    expect(writes()).toEqual([]);
  });

  test("numbers out of range are refused, each in its own words", async () => {
    for (const [data, errors] of BAD_NUMBERS) {
      expect((await act("LOOT_EDITOR_ADD_ITEM", { tableId: 7, itemName: "Wolf Pelt", ...data })).errors).toEqual(errors);
    }
    expect(writes()).toEqual([]);
  });

  test("the ends of each range are let through, and a row may never drop", async () => {
    expect((await act("LOOT_EDITOR_ADD_ITEM", { tableId: 7, itemName: "Wolf Pelt", ...numbers(1, editor.QUANTITY_MAX, 0) })).ok).toBe(true);
    expect(rowsOf(7).at(-1)).toMatchObject({ min_quantity: 1, max_quantity: editor.QUANTITY_MAX, drop_chance: 0 });
    expect((await act("LOOT_EDITOR_ADD_ITEM", { tableId: 7, itemName: "Wolf Pelt", ...numbers(editor.QUANTITY_MAX, editor.QUANTITY_MAX, 100) })).ok).toBe(true);
  });

  test("no table and no item are refused", async () => {
    expect((await act("LOOT_EDITOR_ADD_ITEM", { tableId: "7", itemName: "Wolf Pelt", ...numbers(1, 1, 100) })).errors).toEqual(["Pick a loot table."]);
    for (const itemName of ["", "  ", undefined, 5, ["Wolf Pelt"], "x".repeat(editor.ITEM_NAME_MAX + 1)]) {
      expect((await act("LOOT_EDITOR_ADD_ITEM", { tableId: 7, itemName, ...numbers(1, 1, 100) })).errors).toEqual(["Pick an item."]);
    }
    expect(writes()).toEqual([]);
  });
});

describe("removing a row", () => {
  test("removes that row and no other", async () => {
    const result = await act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 31 });
    expect(result.ok).toBe(true);
    expect(db.loot_table_items.map((r) => r.id)).toEqual([32, 71]);
  });

  test("a row that is no longer there is refused", async () => {
    const result = await act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 999 });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([GONE_ROW]);
    expect(writes()).toEqual([]);
  });

  test("the same request sent twice is refused the second time", async () => {
    const [first, second] = await Promise.all([act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 31 }), act("LOOT_EDITOR_REMOVE_ITEM", { itemId: 31 })]);
    expect(first.ok).toBe(true);
    expect(second.errors).toEqual([GONE_ROW]);
  });

  test("anything that is not a row's id is refused", async () => {
    for (const itemId of [0, 2.5, "31", null, undefined]) {
      expect((await act("LOOT_EDITOR_REMOVE_ITEM", { itemId })).errors).toEqual(["Pick a row of the loot table."]);
    }
    expect(writes()).toEqual([]);
  });
});

describe("updating a row", () => {
  test("stores the numbers and leaves the row's quality as it is", async () => {
    const result = await act("LOOT_EDITOR_UPDATE_ITEM", { itemId: 32, ...numbers(2, 9, 0.5), quality: "common" });
    expect(result.ok).toBe(true);
    expect(db.loot_table_items.find((r) => r.id === 32)).toEqual({ id: 32, loot_table_id: 3, item_name: "Odd Trinket", min_quantity: 2, max_quantity: 9, drop_chance: 0.5, quality: "mythic" });
    expect(result.tables!.find((t) => t.id === 3)!.items.find((i) => i.id === 32)).toMatchObject({ min_quantity: 2, max_quantity: 9, drop_chance: 0.5 });
  });

  test("a chance of 0 is stored as 0", async () => {
    expect((await act("LOOT_EDITOR_UPDATE_ITEM", { itemId: 31, ...numbers(1, 1, 0) })).ok).toBe(true);
    expect(db.loot_table_items.find((r) => r.id === 31)!.drop_chance).toBe(0);
  });

  test("a row that is no longer there is refused", async () => {
    const result = await act("LOOT_EDITOR_UPDATE_ITEM", { itemId: 999, ...numbers(1, 2, 50) });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([GONE_ROW]);
    expect(writes()).toEqual([]);
  });

  test("numbers out of range are refused, each in its own words, and the row is left alone", async () => {
    for (const [data, errors] of BAD_NUMBERS) {
      expect((await act("LOOT_EDITOR_UPDATE_ITEM", { itemId: 31, ...data })).errors).toEqual(errors);
    }
    expect(writes()).toEqual([]);
    expect(db.loot_table_items.find((r) => r.id === 31)).toMatchObject({ min_quantity: 1, max_quantity: 1, drop_chance: 12 });
  });

  test("anything that is not a row's id is refused", async () => {
    expect((await act("LOOT_EDITOR_UPDATE_ITEM", { itemId: "31", ...numbers(1, 2, 50) })).errors).toEqual(["Pick a row of the loot table."]);
    expect(writes()).toEqual([]);
  });
});
