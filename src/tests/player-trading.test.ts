import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";
import { GuardError } from "../controllers/sqltransaction";

// Two players trading: the window's rules, and the swap. The real trade,
// inventory, currency and trade log systems run against a fake database, and
// after a trade what each player holds there is compared with what was offered.
//
// Named to run before questrewards.test.ts, which stands in for the inventory
// and currency systems in every file that runs after it.

mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// ------------------------------------------------------------ fake database

type Row = Record<string, any>;
let tables: { inventory: Row[]; currency: Row[]; trade_log: Row[]; equipment: Row[]; bags: Row[] };
let nextId: number;
/** How many transactions were sent. */
let transactions: number;
/** Every statement sent, in order. */
let queries: string[];
/** Statements that are refused. */
let failing: ((sql: string) => boolean) | null;
/** Run before the next transaction is carried out: what another part of the server did in the meantime. */
let beforeTransaction: (() => void) | null;

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
  if (text === "SELECT id, player_a, player_b, a_gave, b_gave, created_at FROM trade_log ORDER BY id DESC LIMIT ?") {
    return [...tables.trade_log].sort((a, b) => b.id - a.id).slice(0, params[0]).map((row) => ({ ...row }));
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
  if (text === "UPDATE inventory SET equipped = 1 WHERE item = ? AND username = ?") {
    const [item, username] = params;
    const rows = tables.inventory.filter((row) => mine(username)(row) && fold(row.item) === fold(item));
    rows.forEach((row) => { row.equipped = 1; });
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
  if (text === "INSERT INTO trade_log (player_a, player_b, a_gave, b_gave, created_at) VALUES (?, ?, ?, ?, ?)") {
    const [player_a, player_b, a_gave, b_gave, created_at] = params;
    const row = { id: nextId++, player_a, player_b, a_gave, b_gave, created_at };
    tables.trade_log.push(row);
    return { affectedRows: 1, lastInsertRowid: row.id };
  }
  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => run(sql, params),
  // All of its statements or none.
  transaction: async (statements: Array<{ sql: string; values?: any[]; mustChange?: boolean }>) => {
    transactions++;
    beforeTransaction?.();
    beforeTransaction = null;
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

const item = (name: string, type = "material") => ({ name, quality: "common", type, description: "", icon: `${fold(name).replace(/ /g, "_")}.png`, equipment_slot: null, bag_slots: null });
const assets = new Map<string, any>([
  ["items", [
    item("Iron Ore"), item("Rat Tail"), item("Health Potion", "consumable"), item("Iron Helmet", "equipment"),
    item("Small Pouch", "equipment"), item("Sealed Letter", "quest"), { ...item("Home Stone", "consumable"), teleports_home: true },
    ...Array.from({ length: 9 }, (_, index) => item(`Gem ${index + 1}`)),
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

const { clearCaches, dropRows, loadTables } = await import("../services/datacache");
const { default: inventory } = await import("../systems/inventory");
const { default: currency, coinsWorth } = await import("../systems/currency");
const { atomically } = await import("../services/batch");
const { default: tradeLog, TRADES_KEPT } = await import("../systems/tradelog");
const { default: trades, cannotTrade, TRADE_RANGE, TRADE_ITEMS_MAX, ACCEPT_DELAY_MS } = await import("../systems/trades");

// ------------------------------------------------------------------ fixtures

const NOW = 1_800_000_000_000;
/** Late enough after an offer changed for it to be accepted. */
const LATER = NOW + ACCEPT_DELAY_MS;

let online: Map<string, any>;
const find = (username: string) => online.get(fold(username));
const person = (username: string, over: Row = {}) => {
  const made = { id: `id-${username}`, username, isGuest: false, isDead: false, isGhost: false, pvp: false, location: { map: "overworld", position: { x: 100, y: 100 } }, ...over };
  online.set(username, made);
  return made;
};
let hero: any;
let ally: any;

const coins = (gold = 0, silver = 0, copper = 0) => ({ gold, silver, copper });
const offering = (items: Array<[string, number]> = [], money = coins()) => ({ items: items.map(([name, quantity]) => ({ name, quantity })), coins: money });
/** What a player holds in the database: item to quantity. */
const holds = (username: string) => Object.fromEntries(tables.inventory.filter(mine(username)).map((row) => [row.item, row.quantity]));
const purse = (username: string) => {
  const row = tables.currency.find(mine(username));
  return row ? coins(row.gold, row.silver, row.copper) : null;
};

beforeEach(async () => {
  nextId = 100;
  transactions = 0;
  queries = [];
  failing = null;
  beforeTransaction = null;
  tables = {
    inventory: [
      { id: 1, username: "hero", item: "Iron Ore", quantity: 10, equipped: 0, slot: 0, bag_slot: 0 },
      { id: 2, username: "hero", item: "Iron Helmet", quantity: 1, equipped: 1, slot: null, bag_slot: null },
      { id: 3, username: "hero", item: "Sealed Letter", quantity: 1, equipped: 0, slot: 1, bag_slot: 0 },
      { id: 4, username: "hero", item: "Small Pouch", quantity: 2, equipped: 1, slot: 2, bag_slot: 0 },
      { id: 5, username: "ally", item: "Health Potion", quantity: 5, equipped: 0, slot: 0, bag_slot: 0 },
      { id: 6, username: "ally", item: "Iron Ore", quantity: 2, equipped: 0, slot: 1, bag_slot: 0 },
      ...Array.from({ length: 9 }, (_, index) => ({ id: 20 + index, username: "hero", item: `Gem ${index + 1}`, quantity: 1, equipped: 0, slot: 5 + index, bag_slot: 0 })),
    ],
    currency: [{ username: "hero", copper: 50, silver: 2, gold: 1 }, { username: "ally", copper: 0, silver: 0, gold: 30 }],
    trade_log: [],
    // Hero wears the helmet, and one of the two pouches is in a bag slot.
    equipment: [{ id: 1, username: "hero", helmet: "Iron Helmet", weapon: null }],
    bags: [{ id: 1, username: "hero", slot_1: "Small Pouch", slot_2: null, slot_3: null, slot_4: null }],
  };
  await clearCaches();
  await loadTables();
  trades.reset();
  online = new Map();
  hero = person("hero");
  ally = person("ally");
});

/** A trade between hero and ally, opened at NOW. */
const opened = () => {
  const trade = trades.open(hero, ally, NOW);
  if (typeof trade === "string") throw new Error(trade);
  return trade;
};
/** Both accept, late enough: what the second accept answered. */
const bothAccept = async (at = LATER) => {
  await trades.accept("hero", find, at);
  return trades.accept("ally", find, at);
};
/** A trade that ended with nothing exchanged, and both told the same thing. */
const failedWith = (message: string) => ({ state: "failed", reasons: { hero: message, ally: message } });

// ------------------------------------------------------------- who may trade

describe("who may trade", () => {
  test("two players standing together may", () => {
    expect(cannotTrade(hero, ally)).toBeNull();
  });

  test("nobody trades with themselves, or with someone who is not there", () => {
    expect(cannotTrade(hero, hero)).toBe("You cannot trade with yourself.");
    expect(cannotTrade(hero, undefined)).toBe("That player is not online.");
  });

  test("guests do not trade", () => {
    expect(cannotTrade(person("visitor", { isGuest: true }), ally)).toBe("Please create an account to use that feature.");
    expect(cannotTrade(hero, person("visitor", { isGuest: true }))).toBe("Visitor is a guest and cannot trade.");
  });

  test("the dead do not trade, as a corpse or as a ghost", () => {
    expect(cannotTrade(person("hero", { isDead: true }), ally)).toBe("You cannot trade while dead.");
    expect(cannotTrade(person("hero", { isGhost: true }), ally)).toBe("You cannot trade while dead.");
    expect(cannotTrade(person("hero"), person("ally", { isGhost: true }))).toBe("Ally is dead.");
  });

  test("nobody trades in combat", () => {
    expect(cannotTrade(person("hero", { pvp: true }), ally)).toBe("You cannot trade while in combat.");
    expect(cannotTrade(person("hero"), person("ally", { pvp: true }))).toBe("Ally is in combat.");
  });

  test("they must be on the same map and within reach", () => {
    const at = (x: number, y: number, map = "overworld") => ({ location: { map, position: { x, y } } });
    expect(cannotTrade(hero, person("ally", at(100 + TRADE_RANGE, 100)))).toBeNull();
    expect(cannotTrade(hero, person("ally", at(101 + TRADE_RANGE, 100)))).toBe("Ally is too far away to trade.");
    expect(cannotTrade(hero, person("ally", at(100, 100, "cave")))).toBe("Ally is too far away to trade.");
  });

  test("a position kept as text is read the same", () => {
    expect(cannotTrade(hero, person("ally", { location: { map: "overworld", position: "150,100" } }))).toBeNull();
    expect(cannotTrade(hero, person("ally", { location: { map: "overworld", position: "900,100" } }))).toBe("Ally is too far away to trade.");
  });
});

// ------------------------------------------------------------------- opening

describe("opening a trade", () => {
  test("starts with nothing offered and nobody accepted", () => {
    const trade = opened();
    expect(trade.players).toEqual(["hero", "ally"]);
    expect(trade.offers.hero).toEqual(offering());
    expect(trade.offers.ally).toEqual(offering());
    expect(trade.accepted).toEqual({ hero: false, ally: false });
    expect(trades.of("HERO")).toBe(trade);
    expect(trades.of("ally")).toBe(trade);
    expect(trades.partnerOf("ally")).toBe("hero");
  });

  test("is refused for players who may not trade", () => {
    ally.pvp = true;
    expect(trades.open(hero, ally, NOW)).toBe("Ally is in combat.");
    expect(trades.of("hero")).toBeNull();
  });

  test("is one at a time for each player", () => {
    opened();
    const other = person("other");
    expect(trades.open(other, hero, NOW)).toBe("Hero is already trading.");
    expect(trades.open(hero, other, NOW)).toBe("You are already trading.");
    expect(trades.of("other")).toBeNull();
  });
});

// ------------------------------------------------------------------ offering

describe("offering", () => {
  test("puts items and coins on the player's side, under the item's own name", async () => {
    const trade = opened();
    const answer = await trades.offer("hero", offering([["iron ore", 4]], coins(1, 2, 3)), NOW + 10);
    expect(answer.ok).toBe(true);
    expect(trade.offers.hero).toEqual(offering([["Iron Ore", 4]], coins(1, 2, 3)));
    expect(trade.offers.ally).toEqual(offering());
  });

  test("is refused without a trade", async () => {
    expect(await trades.offer("hero", offering([["Iron Ore", 1]]), NOW)).toEqual({ ok: false, message: "You are not trading." });
  });

  test("refuses the home item, which stays with its player", async () => {
    tables.inventory.push({ id: 90, username: "hero", item: "Home Stone", quantity: 1, equipped: 0, slot: 20, bag_slot: 0 });
    await clearCaches();
    opened();
    expect(await trades.offer("hero", offering([["Home Stone", 1]]), NOW)).toEqual({ ok: false, message: "Home Stone cannot be traded." });
  });

  const REFUSED: Array<[string, any, string]> = [
    ["more of an item than is held", offering([["Iron Ore", 11]]), "You do not have 11 Iron Ore."],
    ["an item that is not held", offering([["Health Potion", 1]]), "You do not have 1 Health Potion."],
    ["an item that does not exist", offering([["Moon Rock", 1]]), "You do not have 1 Moon Rock."],
    ["a quest item", offering([["Sealed Letter", 1]]), "Sealed Letter is a quest item and cannot be traded."],
    ["an item being worn", offering([["Iron Helmet", 1]]), "Iron Helmet is in use and cannot be traded."],
    ["more of a bag than is spare", offering([["Small Pouch", 2]]), "Only 1 Small Pouch can be traded: the rest is in use."],
    ["the same item twice", offering([["Iron Ore", 1], ["iron ore", 2]]), "Iron Ore is in the offer twice."],
    ["no amount", offering([["Iron Ore", 0]]), "That is not an amount."],
    ["part of an item", offering([["Iron Ore", 1.5]]), "That is not an amount."],
    ["more coins than are held", offering([], coins(1, 2, 51)), "You do not have that many coins."],
    ["less than no coins", offering([], coins(0, 0, -1)), "That is not an amount."],
    ["more copper than a balance writes", offering([], coins(0, 0, 100)), "That is not an amount."],
    ["something that is not an offer", { items: "all of it" }, "That is not an offer."],
    ["nothing", null, "That is not an offer."],
  ];
  for (const [what, offer, message] of REFUSED) {
    test(`refuses ${what}, and leaves the offer as it was`, async () => {
      const trade = opened();
      await trades.offer("hero", offering([["Iron Ore", 2]]), NOW + 10);
      expect(await trades.offer("hero", offer, NOW + 20)).toEqual({ ok: false, message });
      expect(trade.offers.hero).toEqual(offering([["Iron Ore", 2]]));
      expect(trade.changedAt).toBe(NOW + 10);
    });
  }

  test(`holds ${8} different items and no more`, async () => {
    expect(TRADE_ITEMS_MAX).toBe(8);
    opened();
    const gems = (count: number) => offering(Array.from({ length: count }, (_, index) => [`Gem ${index + 1}`, 1] as [string, number]));
    expect((await trades.offer("hero", gems(8), NOW)).ok).toBe(true);
    expect(await trades.offer("hero", gems(9), NOW)).toEqual({ ok: false, message: "A trade holds 8 different items at most." });
  });

  test("what is spare of an item in use can be offered: the rest of a stack one is worn from", async () => {
    tables.inventory.find((row) => row.item === "Iron Helmet")!.quantity = 3;
    await clearCaches();
    opened();
    expect((await trades.offer("hero", offering([["Iron Helmet", 2]]), NOW)).ok).toBe(true);
    expect(await trades.offer("hero", offering([["Iron Helmet", 3]]), NOW)).toEqual({ ok: false, message: "Only 2 Iron Helmet can be traded: the rest is in use." });
  });

  test("a bag is in use once for each bag slot it is in", async () => {
    const trade = opened();
    expect((await trades.offer("hero", offering([["Small Pouch", 1]]), NOW)).ok).toBe(true);
    expect(trade.offers.hero).toEqual(offering([["Small Pouch", 1]]));

    trades.cancel("hero");
    tables.bags[0].slot_3 = "small pouch";
    await clearCaches();
    opened();
    expect(await trades.offer("hero", offering([["Small Pouch", 1]]), NOW)).toEqual({ ok: false, message: "Small Pouch is in use and cannot be traded." });
  });

  test("an item marked as in use is, whether or not a slot is found holding it", async () => {
    tables.equipment = [];
    await clearCaches();
    opened();
    expect(await trades.offer("hero", offering([["Iron Helmet", 1]]), NOW)).toEqual({ ok: false, message: "Iron Helmet is in use and cannot be traded." });
  });

  test("all the coins a player has can be offered, however they are counted out", async () => {
    opened();
    // 1 gold, 2 silver, 50 copper is 10250 copper.
    expect((await trades.offer("hero", offering([], coins(0, 99, 99)), NOW)).ok).toBe(true);
    expect((await trades.offer("hero", offering([], coins(1, 2, 50)), NOW)).ok).toBe(true);
    expect((await trades.offer("hero", offering([], coins(1, 2, 51)), NOW)).ok).toBe(false);
  });

  test("a change takes back both accepts", async () => {
    const trade = opened();
    await trades.accept("hero", find, LATER);
    expect(trade.accepted.hero).toBe(true);
    const answer = await trades.offer("ally", offering([["Health Potion", 1]]), LATER + 5);
    expect(answer).toMatchObject({ ok: true, changed: true });
    expect(trade.accepted).toEqual({ hero: false, ally: false });
    expect(trade.changedAt).toBe(LATER + 5);
  });

  test("the same offer again changes nothing, and takes back no accept", async () => {
    const trade = opened();
    await trades.offer("ally", offering([["Health Potion", 1]], coins(2)), NOW + 5);
    await trades.accept("hero", find, LATER + 5);
    const answer = await trades.offer("ally", offering([["health potion", 1]], coins(2)), LATER + 50);
    expect(answer).toMatchObject({ ok: true, changed: false });
    expect(trade.accepted.hero).toBe(true);
    expect(trade.changedAt).toBe(NOW + 5);
  });
});

// ----------------------------------------------------------------- accepting

describe("accepting", () => {
  test("is refused without a trade", async () => {
    expect(await trades.accept("hero", find, NOW)).toEqual({ state: "none" });
  });

  test("waits for the other player", async () => {
    const trade = opened();
    await trades.offer("hero", offering([["Iron Ore", 1]]), NOW);
    expect(await trades.accept("hero", find, LATER)).toMatchObject({ state: "accepted" });
    expect(trade.accepted).toEqual({ hero: true, ally: false });
    expect(transactions).toBe(0);
    expect(trades.of("hero")).toBe(trade);
  });

  test("is refused just after an offer changed, for either player", async () => {
    const trade = opened();
    await trades.offer("hero", offering([["Iron Ore", 1]]), NOW + 100);
    for (const who of ["hero", "ally"]) {
      expect(await trades.accept(who, find, NOW + 100 + ACCEPT_DELAY_MS - 1)).toEqual({ state: "wait", message: "The offer just changed. Look it over, then accept." });
    }
    expect(trade.accepted).toEqual({ hero: false, ally: false });
    expect(await trades.accept("ally", find, NOW + 100 + ACCEPT_DELAY_MS)).toMatchObject({ state: "accepted" });
  });

  test("a just opened trade waits the same", async () => {
    opened();
    expect((await trades.accept("hero", find, NOW + 1)).state).toBe("wait");
  });
});

// ------------------------------------------------------------------ the swap

describe("the swap", () => {
  test("moves both offers, items and coins, in one transaction", async () => {
    opened();
    await trades.offer("hero", offering([["Iron Ore", 4]], coins(0, 1, 60)), NOW);
    await trades.offer("ally", offering([["Health Potion", 5]], coins(3)), NOW);
    const answer = await bothAccept();

    expect(answer.state).toBe("completed");
    expect(transactions).toBe(1);
    expect(holds("hero")).toMatchObject({ "Iron Ore": 6, "Health Potion": 5 });
    expect(holds("ally")).toEqual({ "Iron Ore": 6 });
    // 1g 2s 50c less 1s 60c is 1g 0s 90c, and 3 gold more.
    expect(purse("hero")).toEqual(coins(4, 0, 90));
    expect(purse("ally")).toEqual(coins(27, 1, 60));
    expect(trades.of("hero")).toBeNull();
    expect(trades.of("ally")).toBeNull();
  });

  test("leaves the systems answering what the database holds", async () => {
    opened();
    await trades.offer("hero", offering([["Iron Ore", 10]], coins(1)), NOW);
    await trades.offer("ally", offering([["Health Potion", 2]]), NOW);
    await bothAccept();

    const held = async (username: string) => Object.fromEntries((await inventory.get(username)).map((row: any) => [row.name, row.quantity]));
    expect(await held("hero")).toEqual(holds("hero"));
    expect(await held("ally")).toEqual(holds("ally"));
    expect(holds("hero")["Iron Ore"]).toBeUndefined();
    expect(holds("ally")).toEqual({ "Iron Ore": 12, "Health Potion": 3 });
    expect(await currency.get("hero")).toEqual(purse("hero")!);
    expect(await currency.get("ally")).toEqual(purse("ally")!);
    // A new row is held with the id the database gave it.
    const potion = (await inventory.find("hero", { name: "Health Potion", quantity: 0 }))![0];
    expect(potion.id).toBe(tables.inventory.find((row) => row.username === "hero" && row.item === "Health Potion")!.id);
  });

  test("neither side loses or gains a coin in all", async () => {
    opened();
    await trades.offer("hero", offering([], coins(0, 2, 99)), NOW);
    await trades.offer("ally", offering([], coins(12, 34, 56)), NOW);
    const before = coinsWorth(purse("hero")!) + coinsWorth(purse("ally")!);
    expect((await bothAccept()).state).toBe("completed");
    expect(coinsWorth(purse("hero")!) + coinsWorth(purse("ally")!)).toBe(before);
    expect(coinsWorth(purse("hero")!)).toBe(10250 - 299 + 123456);
  });

  test("a gift is a trade with one empty side", async () => {
    opened();
    await trades.offer("ally", offering([["Health Potion", 1]]), NOW);
    expect((await bothAccept()).state).toBe("completed");
    expect(holds("hero")["Health Potion"]).toBe(1);
    expect(holds("ally")["Health Potion"]).toBe(4);
    // Coins nobody offered are not written.
    expect(purse("hero")).toEqual(coins(1, 2, 50));
  });

  test("with nothing offered on either side, nothing is written", async () => {
    opened();
    const answer = await bothAccept();
    expect(answer).toMatchObject({ state: "completed", record: null });
    expect(transactions).toBe(0);
    expect(tables.trade_log).toEqual([]);
    expect(trades.of("hero")).toBeNull();
  });

  test("is refused when a player no longer holds what they offered, and nothing moves", async () => {
    opened();
    await trades.offer("hero", offering([["Iron Ore", 8]]), NOW);
    await trades.offer("ally", offering([["Health Potion", 5]], coins(3)), NOW);
    // Hero uses up ore elsewhere after offering it.
    await inventory.remove("hero", { name: "Iron Ore", quantity: 5 });
    const before = structuredClone(tables);

    const answer = await bothAccept();
    expect(answer).toMatchObject(failedWith("Hero no longer has 8 Iron Ore. Nothing was traded."));
    expect(transactions).toBe(0);
    expect(tables).toEqual(before);
    expect(trades.of("hero")).toBeNull();
    expect(trades.of("ally")).toBeNull();
  });

  test("is refused when an offered item was put on in the meantime", async () => {
    opened();
    await trades.offer("hero", offering([["Gem 1", 1]]), NOW);
    await inventory.setEquipped("hero", "Gem 1", true);
    expect(await bothAccept()).toMatchObject(failedWith("Hero no longer has 1 Gem 1. Nothing was traded."));
    expect(holds("ally")["Gem 1"]).toBeUndefined();
  });

  test("the spare of an item in use changes hands, and the one in use stays where it is", async () => {
    opened();
    await trades.offer("hero", offering([["Small Pouch", 1]]), NOW);
    expect((await bothAccept()).state).toBe("completed");
    expect(tables.inventory.find((row) => row.username === "hero" && row.item === "Small Pouch")).toMatchObject({ quantity: 1, equipped: 1 });
    expect(tables.inventory.find((row) => row.username === "ally" && row.item === "Small Pouch")).toMatchObject({ quantity: 1, equipped: 0 });
    expect(tables.bags[0].slot_1).toBe("Small Pouch");
  });

  test("is refused when the spare that was offered has been put to use in the meantime", async () => {
    opened();
    await trades.offer("hero", offering([["Small Pouch", 1]]), NOW);
    tables.bags[0].slot_2 = "Small Pouch";
    await dropRows("bags", "hero");
    expect(await bothAccept()).toMatchObject(failedWith("Hero no longer has 1 Small Pouch. Nothing was traded."));
    expect(holds("hero")["Small Pouch"]).toBe(2);
    expect(holds("ally")["Small Pouch"]).toBeUndefined();
  });

  test("is refused when a player no longer has the coins they offered", async () => {
    opened();
    await trades.offer("ally", offering([], coins(30)), NOW);
    await currency.remove("ally", coins(1));
    const before = structuredClone(tables);
    expect(await bothAccept()).toMatchObject(failedWith("Ally no longer has the coins they offered. Nothing was traded."));
    expect(tables).toEqual(before);
  });

  test("is refused when the coins would not fit in the other player's purse", async () => {
    tables.currency.find(mine("ally"))!.gold = 9_999_999;
    await clearCaches();
    opened();
    await trades.offer("hero", offering([["Iron Ore", 1]], coins(1)), NOW);
    const before = structuredClone(tables);
    expect(await bothAccept()).toMatchObject(failedWith("Ally cannot hold that many coins. Nothing was traded."));
    expect(tables).toEqual(before);
  });

  test("coins that fit only because of what is given in return are let through", async () => {
    tables.currency.find(mine("ally"))!.gold = 9_999_999;
    await clearCaches();
    opened();
    await trades.offer("hero", offering([], coins(1)), NOW);
    await trades.offer("ally", offering([], coins(2)), NOW);
    expect((await bothAccept()).state).toBe("completed");
    expect(purse("ally")).toEqual(coins(9_999_998, 0, 0));
    expect(purse("hero")).toEqual(coins(2, 2, 50));
  });

  test("is refused when the players may no longer trade", async () => {
    opened();
    await trades.offer("hero", offering([["Iron Ore", 1]]), NOW);
    await trades.accept("hero", find, LATER);
    ally.location = { map: "cave", position: { x: 100, y: 100 } };
    const answer = await trades.accept("ally", find, LATER);
    expect(answer).toMatchObject({ state: "failed", reasons: { hero: "Ally is too far away to trade.", ally: "Hero is too far away to trade." } });
    expect(holds("ally")["Iron Ore"]).toBe(2);
    expect(trades.of("hero")).toBeNull();
  });

  test("when the database refuses it, nothing moves and nothing is held that it does not hold", async () => {
    opened();
    await trades.offer("hero", offering([["Iron Ore", 4]], coins(1)), NOW);
    await trades.offer("ally", offering([["Health Potion", 5]]), NOW);
    const before = structuredClone(tables);
    failing = (sql) => sql.startsWith("INSERT INTO trade_log");

    const answer = await bothAccept();
    expect(answer).toMatchObject(failedWith("The trade could not be completed. Nothing was traded."));
    failing = null;
    expect(tables).toEqual(before);
    expect((await inventory.find("hero", { name: "Iron Ore", quantity: 0 }))![0].quantity).toBe(10);
    expect(await inventory.find("hero", { name: "Health Potion", quantity: 0 })).toEqual([]);
    expect(await currency.get("hero")).toEqual(coins(1, 2, 50));
    expect(trades.of("hero")).toBeNull();
  });

  test("a row that changed under the transaction rolls the whole trade back", async () => {
    opened();
    await trades.offer("hero", offering([["Iron Ore", 10]]), NOW);
    await trades.offer("ally", offering([["Health Potion", 5]]), NOW);
    // The row is gone by the time the transaction runs: its DELETE changes nothing.
    beforeTransaction = () => { tables.inventory = tables.inventory.filter((row) => !(row.username === "hero" && row.item === "Iron Ore")); };
    const answer = await bothAccept();
    expect(answer.state).toBe("failed");
    expect(holds("ally")).toEqual({ "Health Potion": 5, "Iron Ore": 2 });
    expect(holds("hero")["Health Potion"]).toBeUndefined();
    expect(tables.trade_log).toEqual([]);
  });

  test("nothing changes an offer or ends the trade while it is being swapped", async () => {
    const trade = opened();
    await trades.offer("hero", offering([["Iron Ore", 4]]), NOW);
    await trades.accept("hero", find, LATER);
    const swapping = trades.accept("ally", find, LATER);
    expect(trade.settling).toBe(true);
    expect(await trades.offer("hero", offering([["Iron Ore", 1]]), LATER + 1)).toEqual({ ok: false, message: "The trade is being completed." });
    expect(trades.cancel("hero")).toBeNull();
    expect(trades.sweep(() => undefined)).toEqual([]);
    expect((await swapping).state).toBe("completed");
    expect(holds("ally")["Iron Ore"]).toBe(6);
  });

  test("the same item can cross both ways", async () => {
    opened();
    await trades.offer("hero", offering([["Iron Ore", 10]]), NOW);
    await trades.offer("ally", offering([["Iron Ore", 2]]), NOW);
    expect((await bothAccept()).state).toBe("completed");
    expect(holds("hero")["Iron Ore"]).toBe(2);
    expect(holds("ally")["Iron Ore"]).toBe(10);
  });

  test("a batch of its own for one of the players waits for the swap, and works from what it left", async () => {
    opened();
    await trades.offer("hero", offering([["Iron Ore", 4]]), NOW);
    await trades.accept("hero", find, LATER);
    const swapping = trades.accept("ally", find, LATER);
    const reward = atomically(["ally"], async (batch) => { await inventory.add("ally", { name: "Iron Ore", quantity: 1 }, batch); });
    await Promise.all([swapping, reward]);
    expect(holds("ally")["Iron Ore"]).toBe(7);
  });
});

// ------------------------------------------------------------------- ending

describe("ending a trade", () => {
  test("either player can cancel", () => {
    const trade = opened();
    expect(trades.cancel("ALLY")).toBe(trade);
    expect(trades.of("hero")).toBeNull();
    expect(trades.of("ally")).toBeNull();
    expect(trades.cancel("ally")).toBeNull();
  });

  test("a new trade can be opened after one ended", () => {
    opened();
    trades.cancel("hero");
    expect(typeof trades.open(ally, hero, NOW)).toBe("object");
  });

  test("the sweep leaves a trade alone while both may trade", () => {
    opened();
    expect(trades.sweep(find)).toEqual([]);
    expect(trades.of("hero")).not.toBeNull();
  });

  const ENDS: Array<[string, () => void, string, string]> = [
    ["one walks away", () => { ally.location.position = { x: 900, y: 100 }; }, "Ally is too far away to trade.", "Hero is too far away to trade."],
    ["one changes map", () => { hero.location = { map: "cave", position: { x: 100, y: 100 } }; }, "Ally is too far away to trade.", "Hero is too far away to trade."],
    ["one enters combat", () => { hero.pvp = true; }, "You cannot trade while in combat.", "Hero is in combat."],
    ["one dies", () => { ally.isDead = true; }, "Ally is dead.", "You cannot trade while dead."],
    ["one logs out", () => { online.delete("ally"); }, "Ally is no longer online.", "Ally is no longer online."],
  ];
  for (const [what, happens, toHero, toAlly] of ENDS) {
    test(`the sweep ends it when ${what}, and says why to each`, () => {
      const trade = opened();
      happens();
      expect(trades.sweep(find)).toEqual([{ trade, reasons: { hero: toHero, ally: toAlly } }]);
      expect(trades.of("hero")).toBeNull();
      expect(trades.of("ally")).toBeNull();
    });
  }

  test("the sweep looks at every trade", () => {
    opened();
    const third = person("third");
    const fourth = person("fourth");
    trades.open(third, fourth, NOW);
    fourth.pvp = true;
    expect(trades.sweep(find).map((ended) => ended.trade.players)).toEqual([["third", "fourth"]]);
    expect(trades.count).toBe(1);
  });
});

// ---------------------------------------------------------- what a player sees

describe("what a player is shown", () => {
  test("is their side, the other side with what each item is, and who has accepted", async () => {
    const trade = opened();
    await trades.offer("hero", offering([["Iron Ore", 4]], coins(0, 1)), NOW);
    await trades.offer("ally", offering([["Health Potion", 2]]), NOW);
    await trades.accept("ally", find, LATER);

    const view = await trades.view(trade, "hero", LATER);
    expect(view).toEqual({
      partner: "ally",
      mine: { items: [{ ...item("Iron Ore"), quantity: 4 }], coins: coins(0, 1) },
      theirs: { items: [{ ...item("Health Potion", "consumable"), quantity: 2 }], coins: coins() },
      accepted: { mine: false, theirs: true },
      acceptIn: 0,
    });
    expect((await trades.view(trade, "ally", LATER)).accepted).toEqual({ mine: true, theirs: false });
  });

  test("says how long until the offer can be accepted", async () => {
    const trade = opened();
    expect((await trades.view(trade, "hero", NOW + 500)).acceptIn).toBe(ACCEPT_DELAY_MS - 500);
  });
});

// ------------------------------------------------------------- the trade log

describe("the trade log", () => {
  test("a completed trade is written with the swap, and held", async () => {
    opened();
    await trades.offer("hero", offering([["Iron Ore", 4]], coins(0, 1, 60)), NOW);
    await trades.offer("ally", offering([["Health Potion", 5]]), NOW);
    const answer = await bothAccept(LATER + 7);

    const record = { player_a: "hero", player_b: "ally", a_gave: offering([["Iron Ore", 4]], coins(0, 1, 60)), b_gave: offering([["Health Potion", 5]]), created_at: LATER + 7 };
    expect(tables.trade_log).toHaveLength(1);
    const id = tables.trade_log[0].id;
    expect(answer).toMatchObject({ state: "completed", record: { ...record, id } });
    const written = tables.trade_log[0];
    expect({ ...written, a_gave: JSON.parse(written.a_gave), b_gave: JSON.parse(written.b_gave) } as Row).toEqual({ ...record, id });
    expect(await tradeLog.of("hero")).toEqual([{ ...record, id }]);
    expect(await tradeLog.of("ALLY")).toHaveLength(1);
    expect(await tradeLog.of("third")).toEqual([]);
  });

  test("a trade that was refused is not written", async () => {
    opened();
    await trades.offer("hero", offering([["Iron Ore", 8]]), NOW);
    await inventory.remove("hero", { name: "Iron Ore", quantity: 5 });
    await bothAccept();
    expect(tables.trade_log).toEqual([]);
    expect(await tradeLog.of("hero")).toEqual([]);
  });

  test("is read once, the newest first, and answered from what is held", async () => {
    const gave = JSON.stringify(offering());
    tables.trade_log = [
      { id: 1, player_a: "hero", player_b: "ally", a_gave: JSON.stringify(offering([["Iron Ore", 1]])), b_gave: gave, created_at: NOW - 3000 },
      { id: 2, player_a: "third", player_b: "ally", a_gave: gave, b_gave: gave, created_at: NOW - 2000 },
      { id: 3, player_a: "third", player_b: "hero", a_gave: gave, b_gave: gave, created_at: NOW - 1000 },
    ];
    await clearCaches();
    await loadTables();
    queries = [];
    expect((await tradeLog.of("hero")).map((record) => record.id)).toEqual([3, 1]);
    expect((await tradeLog.of("hero", 1)).map((record) => record.id)).toEqual([3]);
    expect((await tradeLog.of("hero"))[1].a_gave).toEqual(offering([["Iron Ore", 1]]));
    expect(queries).toEqual([]);
  });

  test(`holds the latest ${500} and lets go of older ones`, async () => {
    expect(TRADES_KEPT).toBe(500);
    const gave = JSON.stringify(offering());
    tables.trade_log = Array.from({ length: TRADES_KEPT }, (_, index) => ({ id: index + 1, player_a: "third", player_b: "fourth", a_gave: gave, b_gave: gave, created_at: NOW - 10_000 + index }));
    nextId = 1000;
    await clearCaches();
    await loadTables();

    opened();
    await trades.offer("hero", offering([["Iron Ore", 1]]), NOW);
    await bothAccept();
    const third = await tradeLog.of("third", TRADES_KEPT + 10);
    expect(third).toHaveLength(TRADES_KEPT - 1);
    expect(third.at(-1)!.id).toBe(2);
    expect(await tradeLog.of("hero")).toHaveLength(1);
    // The table keeps them all.
    expect(tables.trade_log).toHaveLength(TRADES_KEPT + 1);
  });
});
