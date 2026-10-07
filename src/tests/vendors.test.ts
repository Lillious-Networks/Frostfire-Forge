import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";
import { GuardError } from "../controllers/sqltransaction";

// Buying from and selling to an NPC. The real vendor, inventory, currency, bag
// and equipment systems run against a fake database, and after each deal what
// the player holds there is compared with what the deal should have moved.

// ------------------------------------------------------------ fake database

type Row = Record<string, any>;
let tables: { inventory: Row[]; currency: Row[]; equipment: Row[]; bags: Row[] };
let nextId: number;
/** How many transactions were sent. */
let transactions: number;
/** Every statement sent, in order. */
let queries: string[];
/** Statements that are refused. */
let failing: ((sql: string) => boolean) | null;

const fold = (value: any) => String(value).toLowerCase();
const mine = (username: string) => (row: Row) => fold(row.username) === fold(username);

function run(sql: string, params: any[] = []): any {
  const text = sql.replace(/\s+/g, " ").trim();
  queries.push(text);
  if (failing?.(text)) throw new Error("database gone");

  if (text === "SELECT * FROM inventory WHERE username = ?") return tables.inventory.filter(mine(params[0])).map((row) => ({ ...row }));
  if (text === "SELECT copper, silver, gold FROM currency WHERE username = ?") {
    return tables.currency.filter(mine(params[0])).map(({ copper, silver, gold }) => ({ copper, silver, gold }));
  }
  if (text === "SELECT * FROM equipment WHERE username = ?") return tables.equipment.filter(mine(params[0])).map((row) => ({ ...row }));
  if (text === "SELECT * FROM bags WHERE username = ?") return tables.bags.filter(mine(params[0])).map((row) => ({ ...row }));
  // Any other table (the quest log an inventory change reports to) holds nothing.
  if (text.startsWith("SELECT ")) return [];

  if (text === "INSERT IGNORE INTO inventory (username, item, quantity) VALUES (?, ?, ?)") {
    const [username, item, quantity] = params;
    const row = { id: nextId++, username, item, quantity: Number(quantity), equipped: 0, slot: null, bag_slot: null };
    tables.inventory.push(row);
    return { affectedRows: 1, lastInsertRowid: row.id };
  }
  if (text === "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?") {
    const [quantity, item, username] = params;
    const rows = tables.inventory.filter((row) => mine(username)(row) && fold(row.item) === fold(item) && row.quantity !== Number(quantity));
    rows.forEach((row) => { row.quantity = Number(quantity); });
    return { affectedRows: rows.length };
  }
  if (text === "DELETE FROM inventory WHERE item = ? AND username = ?") {
    const [item, username] = params;
    const before = tables.inventory.length;
    tables.inventory = tables.inventory.filter((row) => !(mine(username)(row) && fold(row.item) === fold(item)));
    return { affectedRows: before - tables.inventory.length };
  }
  if (text.startsWith("INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE")) {
    const [username, copper, silver, gold] = params;
    const row = tables.currency.find(mine(username));
    if (row) Object.assign(row, { copper, silver, gold });
    else tables.currency.push({ username, copper, silver, gold });
    return { affectedRows: row ? 2 : 1 };
  }
  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => run(sql, params),
  // All of its statements or none.
  transaction: async (statements: Array<{ sql: string; values?: any[]; mustChange?: boolean }>) => {
    transactions++;
    const before = structuredClone({ tables, nextId });
    try {
      return statements.map((statement, index) => {
        const answer = run(statement.sql, statement.values);
        if (statement.mustChange && answer.affectedRows === 0) throw new GuardError(index);
        return answer;
      });
    } catch (error) {
      ({ tables, nextId } = before);
      throw error;
    }
  },
}));

const item = (name: string, sell_price: number | undefined, over: Row = {}): any => ({
  name, quality: "common", type: "material", description: "", icon: `${fold(name).replace(/ /g, "_")}.png`, equipment_slot: null, bag_slots: null,
  ...(sell_price === undefined ? {} : { sell_price }), ...over,
});
const assets = new Map<string, any>([
  ["items", [
    item("Iron Ore", 5), item("Health Potion", 12, { type: "consumable" }), item("Iron Helmet", 250, { type: "equipment", equipment_slot: "helmet" }),
    item("Small Pouch", 40, { type: "equipment", bag_slots: 6 }), item("Sealed Letter", 30, { type: "quest" }),
    item("Broken Twig", 0), item("Old Coin", undefined), item("Dragon Hoard", 2_000_000),
    ...Array.from({ length: 30 }, (_, index) => item(`Gem ${index + 1}`, 1)),
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

const { clearCaches } = await import("../services/datacache");
const { default: inventory } = await import("../systems/inventory");
const { default: currency, coinsWorth } = await import("../systems/currency");
const { default: vendors, readVendorItems, cannotShop, sellPriceOf, VENDOR_ITEMS_MAX, BUYBACK_KEPT, BUY_AMOUNT_MAX, VENDOR_RANGE } = await import("../systems/vendors");

// ------------------------------------------------------------------ fixtures

const coins = (gold = 0, silver = 0, copper = 0) => ({ gold, silver, copper });
/** What a player holds in the database: item to quantity. */
const holds = (username: string) => Object.fromEntries(tables.inventory.filter(mine(username)).map((row) => [row.item, row.quantity]));
/** A player's coins in the database, counted in copper. */
const purse = (username: string) => {
  const row = tables.currency.find(mine(username));
  return row ? coinsWorth(coins(row.gold, row.silver, row.copper)) : 0;
};

const smith: any = {
  id: 7, name: "Smith", map: "overworld", hidden: false, position: { x: 100, y: 100, direction: "down" },
  vendor_items: [{ item: "Health Potion", price: 50 }, { item: "Iron Helmet", price: 1200 }, { item: "Broken Twig", price: 0 }, { item: "Gem 30", price: 3 }],
};
const person = (username: string, over: Row = {}) => ({
  username, isDead: false, isGhost: false, location: { map: "overworld", position: { x: 120, y: 100 } }, ...over,
});

beforeEach(async () => {
  nextId = 100;
  transactions = 0;
  queries = [];
  failing = null;
  tables = {
    inventory: [
      { id: 1, username: "hero", item: "Iron Ore", quantity: 10, equipped: 0, slot: 0, bag_slot: 0 },
      { id: 2, username: "hero", item: "Iron Helmet", quantity: 1, equipped: 1, slot: null, bag_slot: null },
      { id: 3, username: "hero", item: "Sealed Letter", quantity: 1, equipped: 0, slot: 1, bag_slot: 0 },
      { id: 4, username: "hero", item: "Small Pouch", quantity: 3, equipped: 1, slot: 2, bag_slot: 0 },
      { id: 5, username: "hero", item: "Broken Twig", quantity: 4, equipped: 0, slot: 3, bag_slot: 0 },
      { id: 6, username: "hero", item: "Old Coin", quantity: 2, equipped: 0, slot: 4, bag_slot: 0 },
      // Every one of the 25 slots a player has without a bag is taken.
      ...Array.from({ length: 25 }, (_, index) => ({ id: 30 + index, username: "packrat", item: `Gem ${index + 1}`, quantity: 1, equipped: 0, slot: index, bag_slot: 0 })),
    ],
    // 1 gold 2 silver 50 copper is 10250 copper.
    currency: [{ username: "hero", copper: 50, silver: 2, gold: 1 }, { username: "packrat", copper: 0, silver: 0, gold: 5 }],
    equipment: [{ id: 1, username: "hero", helmet: "Iron Helmet", weapon: null }],
    bags: [{ id: 1, username: "hero", slot_1: "Small Pouch", slot_2: null, slot_3: null, slot_4: null }],
  };
  await clearCaches();
  vendors.reset();
});

// ------------------------------------------------------------ what is priced

describe("what an item sells for", () => {
  test("is its sell price, in copper, and one copper when it has none", () => {
    expect(sellPriceOf(item("Iron Ore", 5) as any)).toBe(5);
    expect(sellPriceOf(item("Old Coin", undefined) as any)).toBe(1);
    expect(sellPriceOf(item("Broken Twig", 0) as any)).toBe(0);
    expect(sellPriceOf({ ...item("Odd", 1), sell_price: null } as any)).toBe(1);
    expect(sellPriceOf({ ...item("Odd", 1), sell_price: "12" } as any)).toBe(12);
    expect(sellPriceOf({ ...item("Odd", 1), sell_price: -4 } as any)).toBe(0);
  });
});

// --------------------------------------------------------- a vendor's stock

describe("a vendor's stock, as an editor sends it", () => {
  const names = ["Iron Ore", "Health Potion", "Iron Helmet"];

  test("is kept under each item's own name, with whole prices in copper", () => {
    expect(readVendorItems([{ item: "iron ore", price: 20 }, { item: "Health Potion", price: "150" }, { item: "Iron Helmet", price: 0 }], names))
      .toEqual({ items: [{ item: "Iron Ore", price: 20 }, { item: "Health Potion", price: 150 }, { item: "Iron Helmet", price: 0 }], errors: [] });
  });

  test("nothing, or an empty list, is no stock", () => {
    for (const none of [undefined, null, [], ""]) expect(readVendorItems(none, names)).toEqual({ items: [], errors: [] });
  });

  test("says what is wrong with an entry, and leaves it out", () => {
    const read = readVendorItems([
      { item: "Moon Rock", price: 5 }, { item: "Iron Ore", price: -1 }, { item: "Iron Ore", price: 1.5 }, { item: "Health Potion", price: 5 },
      { item: "health potion", price: 9 }, { price: 3 }, "Iron Helmet", { item: "Iron Helmet", price: 100_000_000_000 },
    ], names);
    expect(read.items).toEqual([{ item: "Health Potion", price: 5 }]);
    expect(read.errors).toEqual([
      "Moon Rock is not an item.",
      "The price of Iron Ore must be a whole number of copper, 0 or more.",
      "The price of Iron Ore must be a whole number of copper, 0 or more.",
      "Health Potion is in the stock twice.",
      "A stock entry names no item.",
      "A stock entry names no item.",
      "The price of Iron Helmet is more coins than a player can hold.",
    ]);
  });

  test("something that is not a list is refused whole", () => {
    expect(readVendorItems({ item: "Iron Ore", price: 1 }, names)).toEqual({ items: [], errors: ["A vendor's stock is a list of items and prices."] });
  });

  test(`holds ${40} items and no more`, () => {
    expect(VENDOR_ITEMS_MAX).toBe(40);
    const many = Array.from({ length: 41 }, (_, index) => `Thing ${index}`);
    const read = readVendorItems(many.map((name) => ({ item: name, price: 1 })), many);
    expect(read.items).toHaveLength(40);
    expect(read.errors).toEqual(["A vendor stocks 40 items at most."]);
  });
});

// ------------------------------------------------------------- who may shop

describe("who may use a vendor", () => {
  test("a living player beside one", () => {
    expect(vendors.isVendor(smith)).toBe(true);
    expect(cannotShop(person("hero"), smith)).toBeNull();
  });

  test("an NPC with nothing in stock is not a vendor", () => {
    for (const stock of [[], null, undefined]) {
      const npc = { ...smith, vendor_items: stock };
      expect(vendors.isVendor(npc)).toBe(false);
      expect(cannotShop(person("hero"), npc)).toBe("They have nothing to sell.");
    }
    expect(cannotShop(person("hero"), undefined)).toBe("They have nothing to sell.");
  });

  test("not a hidden one, the dead, or from too far away", () => {
    expect(cannotShop(person("hero"), { ...smith, hidden: true })).toBe("They have nothing to sell.");
    expect(cannotShop(person("hero", { isDead: true }), smith)).toBe("You cannot trade with a vendor while dead.");
    expect(cannotShop(person("hero", { isGhost: true }), smith)).toBe("You cannot trade with a vendor while dead.");
    expect(cannotShop(person("hero", { location: { map: "overworld", position: { x: 100 + VENDOR_RANGE, y: 100 } } }), smith)).toBeNull();
    expect(cannotShop(person("hero", { location: { map: "overworld", position: { x: 101 + VENDOR_RANGE, y: 100 } } }), smith)).toBe("You are too far from that vendor.");
    expect(cannotShop(person("hero", { location: { map: "cave", position: { x: 100, y: 100 } } }), smith)).toBe("You are too far from that vendor.");
  });

  test("a map is the same map with or without its file ending, and a position kept as text is read the same", () => {
    expect(cannotShop(person("hero", { location: { map: "overworld.json", position: "110,100" } }), smith)).toBeNull();
    expect(cannotShop(person("hero"), { ...smith, map: "overworld.json" })).toBeNull();
  });
});

describe("what a vendor shows", () => {
  test("is each item it stocks with what the item is, and its price", async () => {
    expect(await vendors.stock(smith)).toEqual([
      { ...item("Health Potion", 12, { type: "consumable" }), price: 50 },
      { ...item("Iron Helmet", 250, { type: "equipment", equipment_slot: "helmet" }), price: 1200 },
      { ...item("Broken Twig", 0), price: 0 },
      { ...item("Gem 30", 1), price: 3 },
    ]);
  });

  test("nothing is sold for less than a vendor pays for it: bought and sold back, it would be coins from nowhere", async () => {
    const careless = { ...smith, vendor_items: [{ item: "Iron Helmet", price: 10 }, { item: "Old Coin", price: 0 }, { item: "Sealed Letter", price: 0 }, { item: "Health Potion", price: 12 }] };
    expect((await vendors.stock(careless)).map((stocked) => [stocked.name, stocked.price])).toEqual([
      // Sells for 250, and for one copper when the item has no price of its own.
      ["Iron Helmet", 250], ["Old Coin", 1],
      // A quest item is never bought back, so it can cost nothing.
      ["Sealed Letter", 0], ["Health Potion", 12],
    ]);

    expect(await vendors.buy("hero", careless, "Iron Helmet", 2)).toEqual({ ok: true, item: "Iron Helmet", quantity: 2, coins: 500 });
    expect(purse("hero")).toBe(10250 - 500);
    // Selling the two spare ones back returns what was paid, and no more.
    expect(await vendors.sell("hero", "Iron Helmet")).toEqual({ ok: true, item: "Iron Helmet", quantity: 2, coins: 500 });
    expect(purse("hero")).toBe(10250);
  });

  test("an item that no longer exists is left out", async () => {
    expect(await vendors.stock({ ...smith, vendor_items: [{ item: "Moon Rock", price: 1 }, { item: "Health Potion", price: 50 }] }))
      .toEqual([{ ...item("Health Potion", 12, { type: "consumable" }), price: 50 }]);
    expect(await vendors.stock({ ...smith, vendor_items: null })).toEqual([]);
  });
});

// -------------------------------------------------------------------- buying

describe("buying", () => {
  test("takes the price and gives the item, in one transaction", async () => {
    const answer = await vendors.buy("hero", smith, "health potion", 3);
    expect(answer).toEqual({ ok: true, item: "Health Potion", quantity: 3, coins: 150 });
    expect(transactions).toBe(1);
    expect(holds("hero")["Health Potion"]).toBe(3);
    expect(purse("hero")).toBe(10250 - 150);
  });

  test("leaves the systems answering what the database holds", async () => {
    await vendors.buy("hero", smith, "Health Potion", 2);
    expect((await inventory.find("hero", { name: "Health Potion", quantity: 0 }))![0]).toMatchObject({ quantity: 2, id: tables.inventory.find((row) => row.item === "Health Potion")!.id });
    expect(coinsWorth(await currency.get("hero"))).toBe(purse("hero"));
  });

  test("one is bought when no amount is given", async () => {
    expect(await vendors.buy("hero", smith, "Health Potion")).toMatchObject({ ok: true, quantity: 1, coins: 50 });
  });

  test("an item priced at nothing is given, and no coins are written", async () => {
    expect(await vendors.buy("hero", smith, "Broken Twig", 5)).toEqual({ ok: true, item: "Broken Twig", quantity: 5, coins: 0 });
    expect(holds("hero")["Broken Twig"]).toBe(9);
    expect(queries.filter((sql) => sql.startsWith("INSERT INTO currency"))).toEqual([]);
  });

  test("everything a player has can be spent, and not a copper more", async () => {
    const pricey = { ...smith, vendor_items: [{ item: "Health Potion", price: 10250 }, { item: "Iron Ore", price: 10251 }] };
    expect(await vendors.buy("hero", pricey, "Iron Ore", 1)).toEqual({ ok: false, message: "You cannot afford that." });
    expect((await vendors.buy("hero", pricey, "Health Potion", 1)).ok).toBe(true);
    expect(purse("hero")).toBe(0);
  });

  const REFUSED: Array<[string, string, any, string]> = [
    ["an item the vendor does not stock", "Iron Ore", 1, "They do not sell that."],
    ["an item that does not exist", "Moon Rock", 1, "They do not sell that."],
    ["no amount at all", "Health Potion", 0, "That is not an amount."],
    ["part of an item", "Health Potion", 1.5, "That is not an amount."],
    ["less than nothing", "Health Potion", -2, "That is not an amount."],
    ["something that is not a number", "Health Potion", "many", "That is not an amount."],
    ["more at once than a vendor hands over", "Health Potion", 1000, "That is not an amount."],
    ["more than can be paid for", "Iron Helmet", 9, "You cannot afford that."],
  ];
  for (const [what, name, amount, message] of REFUSED) {
    test(`refuses ${what}, and nothing changes`, async () => {
      const before = structuredClone(tables);
      expect(await vendors.buy("hero", smith, name, amount)).toEqual({ ok: false, message });
      expect(tables).toEqual(before);
      expect(transactions).toBe(0);
    });
  }

  test(`${999} at once is the most`, () => {
    expect(BUY_AMOUNT_MAX).toBe(999);
  });

  test("needs a free slot for an item the player does not hold yet", async () => {
    const before = structuredClone(tables);
    expect(await vendors.buy("packrat", smith, "Health Potion", 1)).toEqual({ ok: false, message: "Your bags are full." });
    expect(tables).toEqual(before);
  });

  test("more of an item already held needs no slot", async () => {
    tables.inventory.push({ id: 90, username: "packrat", item: "Gem 30", quantity: 1, equipped: 0, slot: null, bag_slot: null });
    tables.inventory = tables.inventory.filter((row) => !(row.username === "packrat" && row.item === "Gem 25"));
    await clearCaches();
    expect((await vendors.buy("packrat", smith, "Gem 30", 4)).ok).toBe(true);
    expect(holds("packrat")["Gem 30"]).toBe(5);
  });

  test("a bag in a bag slot is room for more", async () => {
    tables.bags.push({ id: 2, username: "packrat", slot_1: "Small Pouch", slot_2: null, slot_3: null, slot_4: null });
    await clearCaches();
    expect((await vendors.buy("packrat", smith, "Health Potion", 1)).ok).toBe(true);
  });

  test("when the database refuses it, the coins stay and nothing is held that it does not hold", async () => {
    const before = structuredClone(tables);
    failing = (sql) => sql.startsWith("INSERT IGNORE INTO inventory");
    expect(await vendors.buy("hero", smith, "Health Potion", 2)).toEqual({ ok: false, message: "The vendor could not complete that. Nothing changed." });
    failing = null;
    expect(tables).toEqual(before);
    expect(coinsWorth(await currency.get("hero"))).toBe(10250);
    expect(await inventory.find("hero", { name: "Health Potion", quantity: 0 })).toEqual([]);
  });

  test("two purchases at the same moment cannot both spend the same coins", async () => {
    const pricey = { ...smith, vendor_items: [{ item: "Health Potion", price: 6000 }] };
    const answers = await Promise.all([vendors.buy("hero", pricey, "Health Potion", 1), vendors.buy("hero", pricey, "Health Potion", 1)]);
    expect(answers.map((answer) => answer.ok).sort()).toEqual([false, true]);
    expect(holds("hero")["Health Potion"]).toBe(1);
    expect(purse("hero")).toBe(4250);
  });
});

// ------------------------------------------------------------------- selling

describe("selling", () => {
  test("takes the whole stack and pays its sell price for each, in one transaction", async () => {
    const answer = await vendors.sell("hero", "iron ore");
    expect(answer).toEqual({ ok: true, item: "Iron Ore", quantity: 10, coins: 50 });
    expect(transactions).toBe(1);
    expect(holds("hero")["Iron Ore"]).toBeUndefined();
    expect(purse("hero")).toBe(10250 + 50);
  });

  test("takes only as many as were asked for", async () => {
    expect(await vendors.sell("hero", "Iron Ore", 4)).toEqual({ ok: true, item: "Iron Ore", quantity: 4, coins: 20 });
    expect(holds("hero")["Iron Ore"]).toBe(6);
  });

  test("an item with no price of its own sells for one copper", async () => {
    expect(await vendors.sell("hero", "Old Coin")).toEqual({ ok: true, item: "Old Coin", quantity: 2, coins: 2 });
  });

  test("what is worn or in a bag slot stays: only what is spare of it is sold", async () => {
    expect(await vendors.sell("hero", "Small Pouch")).toEqual({ ok: true, item: "Small Pouch", quantity: 2, coins: 80 });
    expect(tables.inventory.find((row) => row.username === "hero" && row.item === "Small Pouch")).toMatchObject({ quantity: 1, equipped: 1 });
    expect(await vendors.sell("hero", "Small Pouch")).toEqual({ ok: false, message: "Small Pouch is in use and cannot be sold." });
    expect(await vendors.sell("hero", "Iron Helmet")).toEqual({ ok: false, message: "Iron Helmet is in use and cannot be sold." });
  });

  test("refuses the home item, which stays with its player", async () => {
    assets.set("items", [...assets.get("items"), item("Home Stone", 25, { type: "consumable", teleports_home: true })]);
    tables.inventory.push({ id: 90, username: "hero", item: "Home Stone", quantity: 1, equipped: 0, slot: 20, bag_slot: 0 });
    await clearCaches();
    expect(await vendors.sell("hero", "Home Stone")).toEqual({ ok: false, message: "Home Stone cannot be sold." });
    expect(holds("hero")["Home Stone"]).toBe(1);
    expect(purse("hero")).toBe(10250);
  });

  const REFUSED: Array<[string, string, any, string]> = [
    ["a quest item", "Sealed Letter", undefined, "Sealed Letter is a quest item and cannot be sold."],
    ["an item priced at nothing", "Broken Twig", undefined, "The vendor does not want Broken Twig."],
    ["an item that is not held", "Health Potion", undefined, "You do not have that."],
    ["an item that does not exist", "Moon Rock", undefined, "You do not have that."],
    ["more than is held", "Iron Ore", 11, "You do not have 11 Iron Ore to sell."],
    ["more than is spare", "Small Pouch", 3, "You do not have 3 Small Pouch to sell."],
    ["no amount at all", "Iron Ore", 0, "That is not an amount."],
    ["part of an item", "Iron Ore", 2.5, "That is not an amount."],
  ];
  for (const [what, name, amount, message] of REFUSED) {
    test(`refuses ${what}, and nothing changes`, async () => {
      const before = structuredClone(tables);
      expect(await vendors.sell("hero", name, amount)).toEqual({ ok: false, message });
      expect(tables).toEqual(before);
      expect(vendors.sold("hero")).toEqual([]);
    });
  }

  test("is refused when the coins would not fit in the player's purse", async () => {
    tables.inventory.push({ id: 91, username: "hero", item: "Dragon Hoard", quantity: 60_000, equipped: 0, slot: 6, bag_slot: 0 });
    await clearCaches();
    const before = structuredClone(tables);
    expect(await vendors.sell("hero", "Dragon Hoard")).toEqual({ ok: false, message: "You cannot hold that many coins." });
    expect(tables).toEqual(before);
    // Fewer of them fit.
    expect((await vendors.sell("hero", "Dragon Hoard", 10)).ok).toBe(true);
  });

  test("when the database refuses it, the item stays and nothing is on the buyback list", async () => {
    const before = structuredClone(tables);
    failing = (sql) => sql.startsWith("INSERT INTO currency");
    expect(await vendors.sell("hero", "Iron Ore")).toEqual({ ok: false, message: "The vendor could not complete that. Nothing changed." });
    failing = null;
    expect(tables).toEqual(before);
    expect((await inventory.find("hero", { name: "Iron Ore", quantity: 0 }))![0].quantity).toBe(10);
    expect(vendors.sold("hero")).toEqual([]);
  });

  test("the same stack sold twice at the same moment is paid for once", async () => {
    const answers = await Promise.all([vendors.sell("hero", "Iron Ore"), vendors.sell("hero", "Iron Ore")]);
    expect(answers.map((answer) => answer.ok).sort()).toEqual([false, true]);
    expect(purse("hero")).toBe(10300);
  });
});

// ------------------------------------------------------------------- buyback

describe("buying back", () => {
  test("what was sold is listed, the last sale first, with what the item is", async () => {
    await vendors.sell("hero", "Iron Ore", 4);
    await vendors.sell("hero", "Old Coin");
    expect(vendors.sold("hero")).toEqual([{ item: "Old Coin", quantity: 2, price: 2 }, { item: "Iron Ore", quantity: 4, price: 20 }]);
    expect(await vendors.buybackList("HERO")).toEqual([
      { ...item("Old Coin", undefined), quantity: 2, price: 2 },
      { ...item("Iron Ore", 5), quantity: 4, price: 20 },
    ]);
    expect(vendors.sold("packrat")).toEqual([]);
  });

  test("returns the items for what was paid, and takes the sale off the list", async () => {
    await vendors.sell("hero", "Iron Ore", 4);
    await vendors.sell("hero", "Old Coin");
    transactions = 0;
    expect(await vendors.buyback("hero", 1)).toEqual({ ok: true, item: "Iron Ore", quantity: 4, coins: 20 });
    expect(transactions).toBe(1);
    expect(holds("hero")["Iron Ore"]).toBe(10);
    expect(purse("hero")).toBe(10250 + 2);
    expect(vendors.sold("hero")).toEqual([{ item: "Old Coin", quantity: 2, price: 2 }]);
  });

  test("is refused for a sale that is not on the list", async () => {
    await vendors.sell("hero", "Old Coin");
    for (const index of [1, -1, 0.5, "0", undefined]) {
      expect(await vendors.buyback("hero", index as any)).toEqual({ ok: false, message: "That is no longer there to buy back." });
    }
    expect(vendors.sold("hero")).toHaveLength(1);
  });

  test("is refused when it cannot be paid for, and stays on the list", async () => {
    await vendors.sell("hero", "Iron Ore");
    await currency.set("hero", coins(0, 0, 49));
    expect(await vendors.buyback("hero", 0)).toEqual({ ok: false, message: "You cannot afford that." });
    expect(holds("hero")["Iron Ore"]).toBeUndefined();
    expect(vendors.sold("hero")).toHaveLength(1);
  });

  test("needs a free slot like any other purchase", async () => {
    await vendors.sell("packrat", "Gem 1");
    tables.inventory.push({ id: 92, username: "packrat", item: "Iron Ore", quantity: 1, equipped: 0, slot: 0, bag_slot: 0 });
    await clearCaches();
    expect(await vendors.buyback("packrat", 0)).toEqual({ ok: false, message: "Your bags are full." });
    expect(vendors.sold("packrat")).toHaveLength(1);
  });

  test("when the database refuses it, the sale stays on the list", async () => {
    await vendors.sell("hero", "Iron Ore");
    const before = structuredClone(tables);
    failing = (sql) => sql.startsWith("INSERT IGNORE INTO inventory");
    expect(await vendors.buyback("hero", 0)).toEqual({ ok: false, message: "The vendor could not complete that. Nothing changed." });
    failing = null;
    expect(tables).toEqual(before);
    expect(vendors.sold("hero")).toHaveLength(1);
  });

  test(`keeps the last ${8} sales and lets go of older ones`, async () => {
    expect(BUYBACK_KEPT).toBe(8);
    for (let index = 1; index <= 10; index++) await vendors.sell("packrat", `Gem ${index}`);
    expect(vendors.sold("packrat").map((sale) => sale.item)).toEqual(["Gem 10", "Gem 9", "Gem 8", "Gem 7", "Gem 6", "Gem 5", "Gem 4", "Gem 3"]);
  });

  test("a player who leaves takes their list with them", async () => {
    await vendors.sell("hero", "Iron Ore");
    vendors.forget("HERO");
    expect(vendors.sold("hero")).toEqual([]);
    expect(await vendors.buyback("hero", 0)).toEqual({ ok: false, message: "That is no longer there to buy back." });
  });

  test("the same sale bought back twice at the same moment comes back once", async () => {
    await vendors.sell("hero", "Iron Ore");
    const answers = await Promise.all([vendors.buyback("hero", 0), vendors.buyback("hero", 0)]);
    expect(answers.map((answer) => answer.ok).sort()).toEqual([false, true]);
    expect(holds("hero")["Iron Ore"]).toBe(10);
    expect(purse("hero")).toBe(10250);
  });
});
