import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule, standInFor } from "./setup";

// ------------------------------------------------------------ fake database
// The statements the loot tables send, run against in-memory tables. A
// statement it does not know is an error, so a read that is not the load of
// the tables fails the test that made it.

type Row = Record<string, any>;
let tablesTable: Row[];
let itemsTable: Row[];
let nextId: number;
/** Every statement sent, with its values, in order. */
let queries: Array<[string, any[]]>;
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null;
/** The refused statement was applied all the same, as one that timed out may have been. */
let appliedAnyway: boolean;
/** Whether an INSERT reports the id it gave the row. */
let reportsInsertId: boolean;
/** A database set up without the loot tables. */
let withoutTables: boolean;

const LOAD = ["SELECT * FROM loot_tables ORDER BY id DESC", "SELECT * FROM loot_table_items ORDER BY id"];
const INSERT_TABLE = "INSERT INTO loot_tables (name) VALUES (?)";
const INSERT_ITEM = "INSERT INTO loot_table_items (loot_table_id, item_name, min_quantity, max_quantity, drop_chance, quality) VALUES (?, ?, ?, ?, ?, ?)";
const UPDATE_ITEM = "UPDATE loot_table_items SET min_quantity = ?, max_quantity = ?, drop_chance = ?, quality = ? WHERE id = ?";
const DELETE_ITEM = "DELETE FROM loot_table_items WHERE id = ?";
const DELETE_ITEMS = "DELETE FROM loot_table_items WHERE loot_table_id = ?";
const DELETE_TABLE = "DELETE FROM loot_tables WHERE id = ?";

/** DECIMAL(5,2): kept to two places, and handed back as text, as MySQL hands it back. */
const decimal = (value: unknown) => (value === null || value === undefined ? null : Number(value).toFixed(2));
// MySQL compares names without regard to case.
const sameName = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

function apply(sql: string, params: any[]): any {
  switch (sql) {
    case LOAD[0]:
      return [...tablesTable].sort((a, b) => b.id - a.id).map((row) => ({ ...row }));
    case LOAD[1]:
      return [...itemsTable].sort((a, b) => a.id - b.id).map((row) => ({ ...row }));
    case INSERT_TABLE: {
      if (tablesTable.some((row) => sameName(row.name, params[0]))) throw new Error(`Duplicate entry '${params[0]}' for key 'name'`);
      const id = nextId++;
      tablesTable.push({ id, name: params[0], created_at: "2026-10-05 12:00:00" });
      return reportsInsertId ? { lastInsertRowid: id, affectedRows: 1 } : { affectedRows: 1 };
    }
    case INSERT_ITEM: {
      const [loot_table_id, item_name, min_quantity, max_quantity, drop_chance, quality] = params;
      const id = nextId++;
      itemsTable.push({ id, loot_table_id, item_name, min_quantity, max_quantity, drop_chance: decimal(drop_chance), quality });
      return reportsInsertId ? { lastInsertRowid: id, affectedRows: 1 } : { affectedRows: 1 };
    }
    case UPDATE_ITEM: {
      const [min_quantity, max_quantity, drop_chance, quality, id] = params;
      for (const row of itemsTable) if (row.id === id) Object.assign(row, { min_quantity, max_quantity, drop_chance: decimal(drop_chance), quality });
      return { affectedRows: 1 };
    }
    case DELETE_ITEM:
      itemsTable = itemsTable.filter((row) => row.id !== params[0]);
      return { affectedRows: 1 };
    case DELETE_ITEMS:
      itemsTable = itemsTable.filter((row) => row.loot_table_id !== params[0]);
      return { affectedRows: 1 };
    case DELETE_TABLE:
      tablesTable = tablesTable.filter((row) => row.id !== params[0]);
      return { affectedRows: 1 };
  }
  throw new Error(`The fake database does not understand: ${sql}`);
}

async function database(sql: string, params: any[] = []): Promise<any> {
  queries.push([sql, params]);
  if (withoutTables) throw new Error("no such table: loot_tables");
  if (failing?.test(sql)) {
    if (appliedAnyway) apply(sql, params);
    throw new Error("connection lost");
  }
  return apply(sql, params);
}

mock.module("../controllers/sqldatabase", () => databaseModule({ default: database }));
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => (key === "items" ? [{ name: "Iron Sword", quality: "common" }, { name: "Wolf Pelt", quality: "common" }, { name: "Frostbite", quality: "epic" }] : undefined),
  },
}));
await standInFor("../modules/spriteSheetManager", () => ({ getIconUrl: (name: string) => `icon:${name}` }));

const datacache = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
const { default: lootTable } = await import("../systems/lootTable");

const statements = () => queries.map(([sql]) => sql);
const reads = () => statements().filter((sql) => sql.startsWith("SELECT"));
const writes = () => queries.filter(([sql]) => !sql.startsWith("SELECT"));

/** The tables as the database holds them, in the shape list() gives. */
const stored = () =>
  [...tablesTable].sort((a, b) => b.id - a.id).map((table) => ({
    id: table.id,
    name: table.name,
    created_at: table.created_at,
    items: itemsTable
      .filter((item) => item.loot_table_id === table.id)
      .sort((a, b) => a.id - b.id)
      .map((item) => ({ id: item.id, item_name: item.item_name, min_quantity: item.min_quantity, max_quantity: item.max_quantity, drop_chance: item.drop_chance, quality: item.quality || "common" })),
  }));

// The engine decides how names are compared: these tests are of MySQL's way unless one says otherwise.
const configuredEngine = process.env.DATABASE_ENGINE;
let logged: Array<ReturnType<typeof spyOn>>;
beforeAll(() => {
  delete process.env.DATABASE_ENGINE;
  logged = [spyOn(log, "info"), spyOn(log, "warn"), spyOn(log, "error")].map((spy) => spy.mockImplementation(() => {}));
});
afterAll(() => {
  if (configuredEngine !== undefined) process.env.DATABASE_ENGINE = configuredEngine;
  for (const spy of logged) spy.mockRestore();
});

beforeEach(async () => {
  tablesTable = [
    { id: 3, name: "Bandit Camp", created_at: "2026-01-01 09:00:00" },
    { id: 7, name: "Frost Wolves", created_at: "2026-02-02 09:00:00" },
  ];
  itemsTable = [
    { id: 31, loot_table_id: 3, item_name: "Iron Sword", min_quantity: 1, max_quantity: 1, drop_chance: "12.00", quality: "common" },
    // A row saved before qualities: it reads as common.
    { id: 32, loot_table_id: 3, item_name: "Odd Trinket", min_quantity: 1, max_quantity: 3, drop_chance: "45.50", quality: null },
    { id: 71, loot_table_id: 7, item_name: "Wolf Pelt", min_quantity: 2, max_quantity: 4, drop_chance: "100.00", quality: "common" },
  ];
  nextId = 100;
  queries = [];
  failing = null;
  appliedAnyway = false;
  reportsInsertId = true;
  withoutTables = false;
  await datacache.clearCaches();
  for (const spy of logged) spy.mockClear();
});

// ------------------------------------------------------- one read of the tables

describe("the loot tables are read from the database once", () => {
  test("every question is answered from that one read", async () => {
    expect(await lootTable.list()).toEqual(stored());
    expect(await lootTable.list()).toEqual(stored());
    expect(await lootTable.get(7)).toEqual(stored()[0]);
    expect(await lootTable.get(3)).toEqual(stored()[1]);
    expect(await lootTable.getItem(32)).toEqual({ id: 32, loot_table_id: 3, item_name: "Odd Trinket", min_quantity: 1, max_quantity: 3, drop_chance: "45.50", quality: "common" });
    // The name check of create.
    expect(await lootTable.create("bandit camp")).toBeNull();

    const random = spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(await lootTable.roll(7)).toEqual([{ index: 0, itemName: "Wolf Pelt", quantity: 2, quality: "common", iconUrl: "icon:Wolf Pelt" }]);
      expect(await lootTable.roll(3)).toHaveLength(2);
    } finally {
      random.mockRestore();
    }

    expect(statements()).toEqual(LOAD);
  });

  test("the read at startup is the only one", async () => {
    // What startup's loadTables does for this table (loadTables itself would read every other system's table too).
    await datacache.reloadTable("loot_tables");
    expect(statements()).toEqual(LOAD);
    queries = [];
    expect(await lootTable.list()).toEqual(stored());
    expect(await lootTable.get(3)).toEqual(stored()[1]);
    expect(statements()).toEqual([]);
  });

  test("asked by several at once, they are read once", async () => {
    await Promise.all([lootTable.list(), lootTable.get(3), lootTable.getItem(71), lootTable.roll(7)]);
    expect(statements()).toEqual(LOAD);
  });

  test("the list is newest first, with each table's rows in the order they were added", async () => {
    const tables = await lootTable.list();
    expect(tables.map((table) => table.id)).toEqual([7, 3]);
    expect(tables[1].items.map((item) => item.id)).toEqual([31, 32]);
  });

  test("what is not there is null, or rolls nothing", async () => {
    expect(await lootTable.get(44)).toBeNull();
    expect(await lootTable.get(undefined as any)).toBeNull();
    expect(await lootTable.getItem(999)).toBeNull();
    expect(await lootTable.roll(44)).toEqual([]);
    expect(statements()).toEqual(LOAD);
  });

  test("an answer can be changed without changing what is held", async () => {
    const tables = await lootTable.list();
    tables[0].name = "mine";
    tables[1].items.length = 0;
    const table = (await lootTable.get(3))!;
    table.items[0].drop_chance = 0;
    expect(await lootTable.list()).toEqual(stored());
  });

  test("a database set up without the loot tables has none, and is not asked again", async () => {
    withoutTables = true;
    expect(await lootTable.list()).toEqual([]);
    expect(await lootTable.get(3)).toBeNull();
    expect(await lootTable.roll(3)).toEqual([]);
    expect(statements()).toEqual([LOAD[0]]);
  });

  test("a read that fails for any other reason is not taken for an empty database", async () => {
    failing = /^SELECT/;
    await expect(lootTable.list()).rejects.toThrow("connection lost");
    failing = null;
    expect(await lootTable.list()).toEqual(stored());
  });
});

// --------------------------------------------- a write: database, then cache

describe("a loot table change is written to the database, then to the tables held", () => {
  beforeEach(async () => {
    await lootTable.list();
    queries = [];
  });

  test("create writes the table, and the next read has it with the id and the date the database gave it", async () => {
    const answer = await lootTable.create("Ember Spiders");
    expect(answer).toBeTruthy();
    expect(writes()).toEqual([[INSERT_TABLE, ["Ember Spiders"]]]);

    expect((await lootTable.list())[0]).toEqual({ id: 100, name: "Ember Spiders", created_at: "2026-10-05 12:00:00", items: [] });
    expect(await lootTable.get(100)).toEqual({ id: 100, name: "Ember Spiders", created_at: "2026-10-05 12:00:00", items: [] });
    expect(await lootTable.list()).toEqual(stored());
    // The date is the database's own, so the tables were read again, once.
    expect(reads()).toEqual(LOAD);
  });

  test("create refuses a name that is taken, in any case, and no name, without the database", async () => {
    expect(await lootTable.create("Bandit Camp")).toBeNull();
    expect(await lootTable.create("BANDIT CAMP")).toBeNull();
    expect(await lootTable.create("")).toBeNull();
    expect(queries).toEqual([]);
  });

  test("create sees a name taken a moment ago, and one freed a moment ago", async () => {
    await lootTable.create("Ember Spiders");
    expect(await lootTable.create("ember spiders")).toBeNull();
    await lootTable.delete(3);
    expect(await lootTable.create("Bandit Camp")).toBeTruthy();
    expect(writes().filter(([sql]) => sql === INSERT_TABLE)).toHaveLength(2);
  });

  test("create compares names exactly on an engine that does", async () => {
    process.env.DATABASE_ENGINE = "sqlite";
    try {
      expect(await lootTable.create("Bandit Camp")).toBeNull();
      expect(queries).toEqual([]);
      // The fake database is MySQL's: it refuses the name itself, which shows the check let it through.
      await expect(lootTable.create("bandit camp")).rejects.toThrow("Duplicate entry");
    } finally {
      delete process.env.DATABASE_ENGINE;
    }
  });

  test("the same create sent twice at the same moment makes one table", async () => {
    const [first, second] = await Promise.all([lootTable.create("Ember Spiders"), lootTable.create("Ember Spiders")]);
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(tablesTable.filter((row) => row.name === "Ember Spiders")).toHaveLength(1);
  });

  test("delete removes the table and its rows, and the next read knows without asking", async () => {
    await lootTable.delete(3);
    expect(writes()).toEqual([[DELETE_ITEMS, [3]], [DELETE_TABLE, [3]]]);

    expect(await lootTable.get(3)).toBeNull();
    expect(await lootTable.getItem(31)).toBeNull();
    expect(await lootTable.roll(3)).toEqual([]);
    expect(await lootTable.list()).toEqual(stored());
    expect(reads()).toEqual([]);
  });

  test("addItem writes the row, and the next read has it under the id the database gave it", async () => {
    expect(await lootTable.addItem(7, "frostbite", 2, 5, 12.5)).toBeUndefined();
    expect(writes()).toEqual([[INSERT_ITEM, [7, "Frostbite", 2, 5, 12.5, "epic"]]]);

    expect(await lootTable.getItem(100)).toEqual({ id: 100, loot_table_id: 7, item_name: "Frostbite", min_quantity: 2, max_quantity: 5, drop_chance: 12.5, quality: "epic" });
    expect((await lootTable.get(7))!.items.map((item) => item.id)).toEqual([71, 100]);
    expect(reads()).toEqual([]);

    // What is held is what a restart would read, but for how the database spells a number.
    const held = await lootTable.list();
    await datacache.clearCaches();
    expect((await lootTable.list()).map((table) => ({ ...table, items: table.items.map((item) => ({ ...item, drop_chance: Number(item.drop_chance) })) })))
      .toEqual(held.map((table) => ({ ...table, items: table.items.map((item) => ({ ...item, drop_chance: Number(item.drop_chance) })) })));
  });

  test("addItem keeps a chance of 0, and fills in the numbers and the quality it is not given", async () => {
    await lootTable.addItem(7, "Wolf Pelt", 0, 0, 0, "rare");
    await lootTable.addItem(7, "Wolf Pelt", 3, 6, undefined as any);
    expect(writes().map(([, values]) => values)).toEqual([[7, "Wolf Pelt", 1, 1, 0, "rare"], [7, "Wolf Pelt", 3, 6, 100, "common"]]);
    expect((await lootTable.get(7))!.items.slice(1)).toEqual([
      { id: 100, item_name: "Wolf Pelt", min_quantity: 1, max_quantity: 1, drop_chance: 0, quality: "rare" },
      { id: 101, item_name: "Wolf Pelt", min_quantity: 3, max_quantity: 6, drop_chance: 100, quality: "common" },
    ]);
    expect(reads()).toEqual([]);
  });

  test("addItem whose answer carries no id has the tables read again, rather than hold a row without one", async () => {
    reportsInsertId = false;
    await lootTable.addItem(7, "Frostbite", 2, 5, 12.5);
    expect(reads()).toEqual([]);

    expect((await lootTable.get(7))!.items.at(-1)).toEqual({ id: 100, item_name: "Frostbite", min_quantity: 2, max_quantity: 5, drop_chance: "12.50", quality: "epic" });
    expect(await lootTable.list()).toEqual(stored());
    expect(reads()).toEqual(LOAD);
  });

  test("addItem refuses an item the server does not have, and no table or no item, without the database", async () => {
    expect(await lootTable.addItem(7, "Dragon Scale", 1, 1, 100)).toEqual({ error: "Item \"Dragon Scale\" not found" });
    expect(await lootTable.addItem(0, "Wolf Pelt", 1, 1, 100)).toBeNull();
    expect(await lootTable.addItem(7, "", 1, 1, 100)).toBeNull();
    expect(queries).toEqual([]);
  });

  test("addItem refuses a table that is not there, without the database: no row is left in no table", async () => {
    expect(await lootTable.addItem(44, "Wolf Pelt", 1, 1, 100)).toEqual({ error: "Loot table 44 not found" });
    await lootTable.delete(3);
    queries = [];
    expect(await lootTable.addItem(3, "Wolf Pelt", 1, 1, 100)).toEqual({ error: "Loot table 3 not found" });
    expect(queries).toEqual([]);
    expect(itemsTable.map((row) => row.loot_table_id)).toEqual([7]);
  });

  test("removeItem deletes the row, and the next read knows without asking", async () => {
    await lootTable.removeItem(31);
    expect(writes()).toEqual([[DELETE_ITEM, [31]]]);

    expect(await lootTable.getItem(31)).toBeNull();
    expect((await lootTable.get(3))!.items.map((item) => item.id)).toEqual([32]);
    expect(await lootTable.list()).toEqual(stored());
    expect(reads()).toEqual([]);
  });

  test("updateItem writes the numbers, and the next read and the next roll have them without asking", async () => {
    await lootTable.updateItem(71, 5, 5, 0, "rare");
    expect(writes()).toEqual([[UPDATE_ITEM, [5, 5, 0, "rare", 71]]]);

    expect(await lootTable.getItem(71)).toEqual({ id: 71, loot_table_id: 7, item_name: "Wolf Pelt", min_quantity: 5, max_quantity: 5, drop_chance: 0, quality: "rare" });
    const random = spyOn(Math, "random").mockReturnValue(0);
    try {
      // A chance of 0 never drops.
      expect(await lootTable.roll(7)).toEqual([]);
      await lootTable.updateItem(71, 5, 5, 100, "rare");
      expect(await lootTable.roll(7)).toEqual([{ index: 0, itemName: "Wolf Pelt", quantity: 5, quality: "rare", iconUrl: "icon:Wolf Pelt" }]);
    } finally {
      random.mockRestore();
    }
    expect(reads()).toEqual([]);
  });

  test("a number the database stores its own way is read back, not guessed", async () => {
    // DECIMAL(5,2) keeps two places.
    await lootTable.updateItem(71, 2, 4, 33.333, "common");
    expect(reads()).toEqual([]);
    expect((await lootTable.getItem(71))!.drop_chance).toBe("33.33");
    expect(reads()).toEqual(LOAD);

    await lootTable.addItem(7, "Frostbite", 1, 1, 0.125);
    expect((await lootTable.get(7))!.items.at(-1)!.drop_chance).toBe("0.13");
    expect(await lootTable.list()).toEqual(stored());
    expect(reads()).toEqual([...LOAD, ...LOAD]);
  });

  test("a change to a row that is not there is sent to the database and changes nothing held", async () => {
    await lootTable.removeItem(999);
    await lootTable.updateItem(999, 1, 2, 50, "common");
    expect(writes()).toHaveLength(2);
    expect(await lootTable.list()).toEqual(stored());
    expect(reads()).toEqual([]);
  });

  test("changes made at the same moment all land", async () => {
    await Promise.all([
      lootTable.addItem(3, "Wolf Pelt", 1, 1, 10),
      lootTable.addItem(3, "Frostbite", 1, 1, 20),
      lootTable.removeItem(31),
      lootTable.updateItem(32, 2, 2, 50, "rare"),
      lootTable.addItem(7, "Iron Sword", 1, 1, 30),
    ]);
    expect((await lootTable.get(3))!.items.map((item) => [item.id, item.item_name, Number(item.drop_chance)]))
      .toEqual([[32, "Odd Trinket", 50], [100, "Wolf Pelt", 10], [101, "Frostbite", 20]]);
    expect((await lootTable.get(7))!.items.map((item) => item.id)).toEqual([71, 102]);
    expect(reads()).toEqual([]);
  });
});

// ------------------------------------------------- a write the database refused

describe("a loot table write the database refused", () => {
  const refused: Array<[string, RegExp, () => Promise<unknown>]> = [
    ["create", /^INSERT INTO loot_tables/, () => lootTable.create("Ember Spiders")],
    ["delete (the rows)", /^DELETE FROM loot_table_items WHERE loot_table_id/, () => lootTable.delete(3)],
    ["delete (the table)", /^DELETE FROM loot_tables/, () => lootTable.delete(3)],
    ["addItem", /^INSERT INTO loot_table_items/, () => lootTable.addItem(7, "Frostbite", 2, 5, 12.5)],
    ["removeItem", /^DELETE FROM loot_table_items WHERE id/, () => lootTable.removeItem(31)],
    ["updateItem", /^UPDATE loot_table_items/, () => lootTable.updateItem(71, 5, 5, 0, "rare")],
  ];

  for (const applied of [false, true]) {
    for (const [name, statement, change] of refused) {
      test(`${name}${applied ? ", though the database had applied it" : ""}: the next read asks the database once and answers what it holds`, async () => {
        await lootTable.list();
        queries = [];
        failing = statement;
        appliedAnyway = applied;
        await expect(change()).rejects.toThrow("connection lost");
        failing = null;
        // The tables are read by the next read, not by the write that failed.
        expect(reads()).toEqual([]);

        expect(await lootTable.list()).toEqual(stored());
        expect(await lootTable.get(3)).toEqual(stored().find((table) => table.id === 3) ?? null);
        expect((await lootTable.getItem(71))?.min_quantity).toBe(itemsTable.find((row) => row.id === 71)!.min_quantity);
        expect(reads()).toEqual(LOAD);
      });
    }
  }

  test("a delete that removed the rows and then failed leaves the table held with none, as the database has it", async () => {
    await lootTable.list();
    failing = /^DELETE FROM loot_tables/;
    await expect(lootTable.delete(3)).rejects.toThrow("connection lost");
    failing = null;
    expect(await lootTable.get(3)).toEqual({ id: 3, name: "Bandit Camp", created_at: "2026-01-01 09:00:00", items: [] });
  });

  test("while the database cannot be read either, a read fails rather than answer from before; the first that can, reads it", async () => {
    await lootTable.list();
    queries = [];
    failing = /^(DELETE|SELECT)/;
    appliedAnyway = true;
    await expect(lootTable.removeItem(31)).rejects.toThrow("connection lost");
    appliedAnyway = false;
    await expect(lootTable.getItem(31)).rejects.toThrow("connection lost");
    await expect(lootTable.roll(3)).rejects.toThrow("connection lost");

    failing = null;
    expect(await lootTable.getItem(31)).toBeNull();
    expect(await lootTable.list()).toEqual(stored());
    expect(reads().slice(-2)).toEqual(LOAD);
  });

  test("a change behind the one that failed is made to what the database holds", async () => {
    await lootTable.list();
    failing = /^DELETE FROM loot_table_items WHERE id/;
    appliedAnyway = true;
    const [first] = await Promise.allSettled([lootTable.removeItem(31), lootTable.updateItem(32, 2, 2, 50, "rare")]);
    failing = null;
    expect(first.status).toBe("rejected");
    expect((await lootTable.get(3))!.items).toEqual([{ id: 32, item_name: "Odd Trinket", min_quantity: 2, max_quantity: 2, drop_chance: 50, quality: "rare" }]);
    expect(itemsTable.filter((row) => row.loot_table_id === 3).map((row) => [row.id, row.drop_chance])).toEqual([[32, "50.00"]]);
  });
});
