import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";
import { GuardError } from "../controllers/sqltransaction";

// Using an item, and going home. The real consumable, home, inventory and bag
// systems run against a fake database: after each use, what the player holds
// there and the stats they carry are compared with what the use should have
// done.

// ------------------------------------------------------------ fake database

type Row = Record<string, any>;
let tables: { inventory: Row[]; bags: Row[]; player_home: Row[] };
let nextId: number;
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
  if (text === "SELECT * FROM bags WHERE username = ?") return tables.bags.filter(mine(params[0])).map((row) => ({ ...row }));
  if (text === "SELECT npc_id, offset_x, offset_y, used_at FROM player_home WHERE username = ?") {
    return tables.player_home.filter(mine(params[0])).map(({ npc_id, offset_x, offset_y, used_at }) => ({ npc_id, offset_x, offset_y, used_at }));
  }
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
  if (text === "INSERT INTO player_home (username, npc_id, offset_x, offset_y) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE npc_id = ?, offset_x = ?, offset_y = ?") {
    const [username, npc_id, offset_x, offset_y] = params;
    const row = tables.player_home.find(mine(username));
    if (row) Object.assign(row, { npc_id, offset_x, offset_y });
    else tables.player_home.push({ username, npc_id, offset_x, offset_y, used_at: 0 });
    return { affectedRows: row ? 2 : 1 };
  }
  if (text === "INSERT INTO player_home (username, used_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE used_at = ?") {
    const [username, used_at] = params;
    const row = tables.player_home.find(mine(username));
    if (row) row.used_at = used_at;
    else tables.player_home.push({ username, npc_id: null, offset_x: 0, offset_y: 0, used_at });
    return { affectedRows: row ? 2 : 1 };
  }
  if (text === "UPDATE player_home SET npc_id = NULL WHERE npc_id = ?") {
    const rows = tables.player_home.filter((row) => Number(row.npc_id) === Number(params[0]));
    rows.forEach((row) => { row.npc_id = null; });
    return { affectedRows: rows.length };
  }
  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => run(sql, params),
  // All of its statements or none.
  transaction: async (statements: Array<{ sql: string; values?: any[]; mustChange?: boolean }>) => {
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

const item = (name: string, over: Row = {}): any => ({
  name, quality: "common", type: "consumable", description: "", icon: `${fold(name).replace(/ /g, "_")}.png`, equipment_slot: null, bag_slots: null,
  level_requirement: null, restore_health: 0, restore_stamina: 0, no_combat: false, teleports_home: false, ...over,
});
const STONE = item("Home Stone", { teleports_home: true });
const ITEMS = [
  item("Health Potion", { restore_health: 50 }), item("Stamina Draught", { restore_stamina: 30 }),
  item("Hearty Stew", { restore_health: 20, restore_stamina: 20, no_combat: true }), item("Elder Elixir", { restore_health: 500, level_requirement: 10 }),
  item("Empty Vial"), item("Iron Ore", { type: "material", restore_health: 50 }), STONE,
  ...Array.from({ length: 30 }, (_, index) => item(`Gem ${index + 1}`, { type: "material" })),
];
const inn = (over: Row = {}): any => ({ id: 7, name: "The Rusty Anchor", map: "harbor.json", hidden: false, innkeeper: true, position: { x: 400, y: 300, direction: "down" }, ...over });
const assets = new Map<string, any>();
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
const { default: log } = await import("../modules/logger");
const { default: consumables, CONSUMABLE_COOLDOWN_MS, isKept, teleportsHome } = await import("../systems/consumables");
const { default: cooldownManager } = await import("../services/cooldownmanager");
const { resetCooldowns } = await import("../systems/cooldowns");
const { caveMarkers, houseMarkers, innMarkers, mapMarkers, merchantMarkers } = await import("../systems/mapmarkers");
const { default: homes, cannotSetHome, isInnkeeper, HOME_COOLDOWN_MS, HOME_CAST_MS, INN_RANGE } = await import("../systems/homes");

// ------------------------------------------------------------------ fixtures

const NOW = 5_000_000;
/** What a player holds in the database: item to quantity. */
const holds = (username: string) => Object.fromEntries(tables.inventory.filter(mine(username)).map((row) => [row.item, row.quantity]));
const person = (username = "hero", over: Row = {}): any => ({
  username, isDead: false, isGhost: false, pvp: false, stunnedUntil: 0,
  location: { map: "harbor", position: { x: 430, y: 340 } },
  ...over,
  stats: { health: 40, max_health: 100, total_max_health: 100, stamina: 10, max_stamina: 50, total_max_stamina: 50, level: 5, ...(over.stats ?? {}) },
});
const use = (player: any, name: string, state: Row = {}) => consumables.use(player, name, { now: NOW, ...state });

beforeEach(async () => {
  nextId = 100;
  queries = [];
  failing = null;
  assets.set("items", structuredClone(ITEMS));
  assets.set("npcs", [inn(), inn({ id: 8, name: "Smith", innkeeper: false }), inn({ id: 9, name: "The Hidden Cellar", hidden: true })]);
  tables = {
    inventory: [
      { id: 1, username: "hero", item: "Health Potion", quantity: 3, equipped: 0, slot: 0, bag_slot: 0 },
      { id: 2, username: "hero", item: "Stamina Draught", quantity: 1, equipped: 0, slot: 1, bag_slot: 0 },
      { id: 3, username: "hero", item: "Hearty Stew", quantity: 2, equipped: 0, slot: 2, bag_slot: 0 },
      { id: 4, username: "hero", item: "Elder Elixir", quantity: 1, equipped: 0, slot: 3, bag_slot: 0 },
      { id: 5, username: "hero", item: "Empty Vial", quantity: 1, equipped: 0, slot: 4, bag_slot: 0 },
      { id: 6, username: "hero", item: "Iron Ore", quantity: 9, equipped: 0, slot: 5, bag_slot: 0 },
      { id: 7, username: "hero", item: "Home Stone", quantity: 1, equipped: 0, slot: 6, bag_slot: 0 },
      // Every one of the 25 slots a player has without a bag is taken.
      ...Array.from({ length: 25 }, (_, index) => ({ id: 30 + index, username: "packrat", item: `Gem ${index + 1}`, quantity: 1, equipped: 0, slot: index, bag_slot: 0 })),
    ],
    bags: [],
    player_home: [],
  };
  await clearCaches();
  consumables.reset();
});

// -------------------------------------------------------------- what is used

describe("using a consumable", () => {
  test("restores its health, takes one from the bags and starts the cooldown", async () => {
    const hero = person();
    expect(await use(hero, "health potion")).toEqual({ ok: true, kind: "restore", item: "Health Potion", health: 50, stamina: 0, cooldown: CONSUMABLE_COOLDOWN_MS });
    expect(hero.stats.health).toBe(90);
    expect(hero.stats.stamina).toBe(10);
    expect(holds("hero")["Health Potion"]).toBe(2);
    expect(consumables.cooldownLeft("HERO", NOW + 1000)).toBe(CONSUMABLE_COOLDOWN_MS - 1000);
  });

  test("never restores past the most the player can have, and says what it did restore", async () => {
    const hero = person("hero", { stats: { health: 80 } });
    expect(await use(hero, "Health Potion")).toMatchObject({ ok: true, health: 20, stamina: 0 });
    expect(hero.stats.health).toBe(100);
  });

  test("counts what gear adds to the most a player can have", async () => {
    const hero = person("hero", { stats: { health: 100, total_max_health: 130 } });
    expect(await use(hero, "Health Potion")).toMatchObject({ ok: true, health: 30 });
    expect(hero.stats.health).toBe(130);
  });

  test("restores stamina, and both when the item has both", async () => {
    const hero = person();
    expect(await use(hero, "Stamina Draught")).toMatchObject({ ok: true, health: 0, stamina: 30 });
    expect(hero.stats).toMatchObject({ health: 40, stamina: 40 });
    expect(holds("hero")["Stamina Draught"]).toBeUndefined();

    const other = person();
    expect(await consumables.use(other, "Hearty Stew", { now: NOW + CONSUMABLE_COOLDOWN_MS })).toMatchObject({ ok: true, health: 20, stamina: 20 });
    expect(other.stats).toMatchObject({ health: 60, stamina: 30 });
  });

  test("works when only one of the two it restores is full", async () => {
    const hero = person("hero", { stats: { health: 100 } });
    expect(await use(hero, "Hearty Stew")).toMatchObject({ ok: true, health: 0, stamina: 20 });
    expect(holds("hero")["Hearty Stew"]).toBe(1);
  });
});

describe("a use is refused, and nothing is taken", () => {
  const refused = async (player: any, name: string, message: string, state: Row = {}) => {
    const before = { held: holds(player.username), stats: { ...player.stats } };
    expect(await use(player, name, state)).toEqual({ ok: false, message });
    expect(holds(player.username)).toEqual(before.held);
    expect(player.stats).toEqual(before.stats);
    expect(consumables.cooldownLeft(player.username, NOW)).toBe(0);
  };

  test("while dead or a ghost", async () => {
    await refused(person("hero", { isDead: true }), "Health Potion", "You cannot use items while dead.");
    await refused(person("hero", { isGhost: true }), "Health Potion", "You cannot use items while dead.");
  });

  test("while stunned", async () => {
    await refused(person("hero", { stunnedUntil: NOW + 1 }), "Health Potion", "You cannot do that while stunned.");
    expect(await use(person("hero", { stunnedUntil: NOW - 1 }), "Health Potion")).toMatchObject({ ok: true });
  });

  test("while trading", async () => {
    await refused(person(), "Health Potion", "You cannot use items while trading.", { trading: true });
  });

  test("for an item the player does not hold, or that does not exist", async () => {
    await refused(person("packrat"), "Health Potion", "You do not have that.");
    await refused(person(), "Moon Rock", "You do not have that.");
    await refused(person(), "", "You do not have that.");
    await refused(person(), 12 as any, "You do not have that.");
  });

  test("for an item that is not a consumable, or restores nothing", async () => {
    await refused(person(), "Iron Ore", "Iron Ore cannot be used.");
    await refused(person(), "Empty Vial", "Empty Vial cannot be used.");
  });

  test("below the item's level", async () => {
    await refused(person(), "Elder Elixir", "You must be level 10 to use Elder Elixir.");
    expect(await use(person("hero", { stats: { level: 10 } }), "Elder Elixir")).toMatchObject({ ok: true });
  });

  test("in combat, for an item that cannot be used there", async () => {
    await refused(person("hero", { pvp: true }), "Hearty Stew", "Hearty Stew cannot be used in combat.");
    expect(await use(person("hero", { pvp: true }), "Health Potion")).toMatchObject({ ok: true });
    expect(await consumables.use(person(), "Hearty Stew", { now: NOW + CONSUMABLE_COOLDOWN_MS })).toMatchObject({ ok: true });
  });

  test("when everything it restores is already full", async () => {
    await refused(person("hero", { stats: { health: 100 } }), "Health Potion", "Your health is already full.");
    await refused(person("hero", { stats: { stamina: 50 } }), "Stamina Draught", "Your stamina is already full.");
    await refused(person("hero", { stats: { health: 100, stamina: 50 } }), "Hearty Stew", "Your health and stamina are already full.");
  });

  test("when the write fails: the player is told, and can try again at once", async () => {
    failing = (sql) => sql.startsWith("UPDATE inventory");
    const logged = spyOn(log, "error").mockImplementation(() => {});
    await refused(person(), "Health Potion", "That could not be used. Nothing changed.");
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
    failing = null;
    expect(await use(person(), "Health Potion")).toMatchObject({ ok: true });
  });
});

describe("the cooldown every consumable shares", () => {
  test("refuses any other consumable until it is over", async () => {
    const hero = person();
    expect(await use(hero, "Health Potion")).toMatchObject({ ok: true });
    expect(await consumables.use(hero, "Stamina Draught", { now: NOW + CONSUMABLE_COOLDOWN_MS - 1 })).toEqual({ ok: false, message: "You cannot use another item yet." });
    expect(holds("hero")["Stamina Draught"]).toBe(1);
    expect(await consumables.use(hero, "Stamina Draught", { now: NOW + CONSUMABLE_COOLDOWN_MS })).toMatchObject({ ok: true });
  });

  test("is each player's own, and is not lost when they leave", async () => {
    tables.inventory.push({ id: 90, username: "ally", item: "Health Potion", quantity: 1, equipped: 0, slot: 0, bag_slot: 0 });
    expect(await use(person(), "Health Potion")).toMatchObject({ ok: true });
    expect(consumables.cooldownLeft("ally", NOW)).toBe(0);
    expect(await use(person("ally"), "Health Potion")).toMatchObject({ ok: true });
    // Nothing forgets it but time.
    expect(consumables.cooldownLeft("hero", NOW + 10)).toBe(CONSUMABLE_COOLDOWN_MS - 10);
    expect(consumables.cooldownLeft("hero", NOW + CONSUMABLE_COOLDOWN_MS)).toBe(0);
  });

  test("lets one of two uses sent together through", async () => {
    tables.inventory.find((row) => row.item === "Health Potion")!.quantity = 1;
    const hero = person();
    const answers = await Promise.all([use(hero, "Health Potion"), use(hero, "Health Potion")]);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(hero.stats.health).toBe(90);
    expect(holds("hero")["Health Potion"]).toBeUndefined();
  });
});

// ------------------------------------------------------ cooldowns, taken away

describe("an admin resets a player's cooldowns", () => {
  test("the one consumables share ends at once, for that player only", async () => {
    tables.inventory.push({ id: 90, username: "ally", item: "Health Potion", quantity: 2, equipped: 0, slot: 0, bag_slot: 0 });
    const hero = person();
    await use(hero, "Health Potion");
    await use(person("ally"), "Health Potion");
    consumables.clearCooldown("HERO");
    expect(consumables.cooldownLeft("hero", NOW)).toBe(0);
    expect(consumables.cooldownLeft("ally", NOW)).toBe(CONSUMABLE_COOLDOWN_MS);
    expect(await use(hero, "Health Potion")).toMatchObject({ ok: true });
  });

  test("the home item's hour ends at once, in the database too, and the home stays", async () => {
    await homes.set(person(), inn());
    await homes.arrive("hero", NOW);
    await homes.clearCooldown("Hero");
    expect(await homes.cooldownLeft("hero", NOW)).toBe(0);
    expect(tables.player_home).toEqual([{ username: "hero", npc_id: 7, offset_x: 30, offset_y: 40, used_at: 0 }]);
    await clearCaches();
    expect(await homes.cooldownLeft("hero", NOW)).toBe(0);
    expect(await homes.where("hero")).toEqual({ map: "harbor", x: 430, y: 340, inn: "The Rusty Anchor" });
  });

  test("a player who never went home has nothing written", async () => {
    await homes.clearCooldown("ally");
    expect(tables.player_home).toEqual([]);
    expect(queries.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  });

  test("every cooldown goes together: spells, the lockout after an interrupt, consumables and the way home", async () => {
    const hero = person("hero", { id: "p1", spellCooldowns: { 3: performance.now() + 60_000 }, spellLockoutUntil: performance.now() + 5000 });
    cooldownManager.setCooldown("hero", 3, performance.now() + 60_000);
    cooldownManager.setLockout("hero", performance.now() + 5000);
    cooldownManager.setCooldown("ally", 3, performance.now() + 60_000);
    await use(hero, "Health Potion");
    await homes.arrive("hero", NOW);

    await resetCooldowns(hero);

    expect(cooldownManager.hasCooldown("hero", 3)).toBe(false);
    expect(cooldownManager.getLockout("hero")).toBe(0);
    expect(hero.spellCooldowns).toEqual({});
    expect(hero.spellLockoutUntil).toBe(0);
    expect(consumables.cooldownLeft("hero", NOW)).toBe(0);
    expect(await homes.cooldownLeft("hero", NOW)).toBe(0);
    // Nobody else's are touched.
    expect(cooldownManager.hasCooldown("ally", 3)).toBe(true);
    cooldownManager.removePlayer("ally");
  });

  test("the rest are reset when the way home could not be written, and the error is the caller's", async () => {
    const hero = person();
    await use(hero, "Health Potion");
    await homes.arrive("hero", NOW);
    failing = (sql) => sql.startsWith("INSERT INTO player_home");
    await expect(resetCooldowns(hero)).rejects.toThrow("database gone");
    failing = null;
    expect(consumables.cooldownLeft("hero", NOW)).toBe(0);
    expect(await homes.cooldownLeft("hero", NOW)).toBe(HOME_COOLDOWN_MS);
  });
});

// ---------------------------------------------------------------- the stone

describe("the home item", () => {
  test("is the consumable that teleports home, and is kept for good", () => {
    expect(teleportsHome(STONE)).toBe(true);
    expect(isKept(STONE)).toBe(true);
    expect(teleportsHome(item("Health Potion", { restore_health: 50 }))).toBe(false);
    expect(isKept(item("Health Potion", { restore_health: 50 }))).toBe(false);
    // Only a consumable is one, whatever the switch says.
    expect(teleportsHome(item("Odd", { type: "material", teleports_home: true }))).toBe(false);
    expect(isKept(null)).toBe(false);
  });

  test("is found among the items", async () => {
    expect((await consumables.homeItem())?.name).toBe("Home Stone");
    assets.set("items", ITEMS.filter((held) => held !== STONE));
    expect(await consumables.homeItem()).toBeNull();
  });

  test("when used, answers that a cast home starts: nothing is taken and no cooldown starts", async () => {
    const hero = person();
    expect(await use(hero, "home stone")).toEqual({ ok: true, kind: "home", item: "Home Stone", cast: HOME_CAST_MS });
    expect(holds("hero")["Home Stone"]).toBe(1);
    expect(consumables.cooldownLeft("hero", NOW)).toBe(0);
    expect(await homes.cooldownLeft("hero", NOW)).toBe(0);
  });

  test("is not held up by the cooldown consumables share, and does not start it", async () => {
    const hero = person();
    expect(await use(hero, "Health Potion")).toMatchObject({ ok: true });
    expect(await use(hero, "Home Stone")).toMatchObject({ ok: true, kind: "home" });
  });

  test("is refused while it is on its own cooldown", async () => {
    await homes.arrive("hero", NOW);
    expect(await consumables.use(person(), "Home Stone", { now: NOW + HOME_COOLDOWN_MS - 1 })).toEqual({ ok: false, message: "Home Stone is not ready yet." });
    expect(await consumables.use(person(), "Home Stone", { now: NOW + HOME_COOLDOWN_MS })).toMatchObject({ ok: true, kind: "home" });
  });

  test("is refused as any consumable is: dead, stunned, trading, not held", async () => {
    expect(await use(person("hero", { isDead: true }), "Home Stone")).toEqual({ ok: false, message: "You cannot use items while dead." });
    expect(await use(person("hero", { stunnedUntil: NOW + 5 }), "Home Stone")).toEqual({ ok: false, message: "You cannot do that while stunned." });
    expect(await use(person(), "Home Stone", { trading: true })).toEqual({ ok: false, message: "You cannot use items while trading." });
    expect(await use(person("packrat"), "Home Stone")).toEqual({ ok: false, message: "You do not have that." });
  });

  test("is given to a player who holds none, once", async () => {
    expect(await consumables.giveHomeItem("ally")).toBe(true);
    expect(holds("ally")).toEqual({ "Home Stone": 1 });
    expect(await consumables.giveHomeItem("ally")).toBe(false);
    expect(await consumables.giveHomeItem("hero")).toBe(false);
    expect(holds("ally")).toEqual({ "Home Stone": 1 });
    expect(holds("hero")["Home Stone"]).toBe(1);
  });

  test("is not given when there is no home item, or no slot for it", async () => {
    expect(await consumables.giveHomeItem("packrat")).toBe(false);
    expect(holds("packrat")["Home Stone"]).toBeUndefined();
    assets.set("items", ITEMS.filter((held) => held !== STONE));
    expect(await consumables.giveHomeItem("ally")).toBe(false);
    expect(holds("ally")).toEqual({});
  });
});

// ---------------------------------------------------------------- the inns

describe("an innkeeper", () => {
  test("is an NPC marked as one", () => {
    expect(isInnkeeper(inn())).toBe(true);
    expect(isInnkeeper(inn({ innkeeper: false }))).toBe(false);
    expect(isInnkeeper(null)).toBe(false);
  });

  test("makes the inn a player's home when they stand within reach, alive", () => {
    expect(cannotSetHome(person(), inn())).toBeNull();
    expect(cannotSetHome(person("hero", { location: { map: "harbor.json", position: `${400 + INN_RANGE},300` } }), inn())).toBeNull();
    expect(cannotSetHome(person("hero", { location: { map: "harbor", position: { x: 400 + INN_RANGE + 1, y: 300 } } }), inn())).toBe("You are too far from the innkeeper.");
    expect(cannotSetHome(person("hero", { location: { map: "forest", position: { x: 400, y: 300 } } }), inn())).toBe("You are too far from the innkeeper.");
    expect(cannotSetHome(person("hero", { location: undefined }), inn())).toBe("You are too far from the innkeeper.");
    expect(cannotSetHome(person("hero", { isDead: true }), inn())).toBe("You cannot do that while dead.");
    expect(cannotSetHome(person("hero", { isGhost: true }), inn())).toBe("You cannot do that while dead.");
    expect(cannotSetHome(person(), inn({ innkeeper: false }))).toBe("They are not an innkeeper.");
    expect(cannotSetHome(person(), inn({ hidden: true }))).toBe("They are not an innkeeper.");
    expect(cannotSetHome(person(), null)).toBe("They are not an innkeeper.");
  });
});

describe("where a map's inns are marked", () => {
  const warp = (name: string, to: string, x: number, y: number, width = 16, height = 16): any => ({ name, map: to, x: 100, y: 200, position: { x, y }, size: { width, height }, layer: null });
  const keepers = [
    inn({ id: 1, name: "The Rusty Anchor", map: "house_12_58.json" }),
    inn({ id: 2, name: "Leaf Lodge", map: "house_30_10" }),
    inn({ id: 3, name: "Camp Cook", map: "overworld", position: { x: 5000, y: 6000, direction: "down" } }),
    inn({ id: 4, name: "Closed Inn", map: "house_77_77", hidden: true }),
    inn({ id: 5, name: "Smith", map: "house_40_40", innkeeper: false }),
  ];
  const doors = [
    warp("Door", "house_12_58", 1000, 2000), warp("Door", "house_30_10.json", 3000, 4000, 32, 16), warp("Door", "house_77_77", 10, 10),
    warp("Door", "house_40_40", 20, 20), warp("Cave", "underworld", 30, 30),
  ];

  /** The open country of this world: every other map is the inside of something. */
  const outdoors = (map: string) => map === "overworld" || map === "underworld";

  test("on the door of each house an innkeeper is in: the middle of its top edge, under the innkeeper's name", () => {
    expect(innMarkers("overworld.json", keepers.filter((npc) => npc.id !== 3), doors, outdoors)).toEqual([
      { x: 1008, y: 2000, name: "The Rusty Anchor" },
      { x: 3016, y: 4000, name: "Leaf Lodge" },
    ]);
  });

  test("an innkeeper out in the open is marked where it stands", () => {
    expect(innMarkers("overworld", keepers, doors, outdoors)).toEqual([
      { x: 1008, y: 2000, name: "The Rusty Anchor" },
      { x: 3016, y: 4000, name: "Leaf Lodge" },
      { x: 5000, y: 6000, name: "Camp Cook" },
    ]);
  });

  test("inside its house an innkeeper is not marked, and neither is the door back out to a map with one in the open", () => {
    expect(innMarkers("house_12_58", keepers, [warp("Door", "overworld", 336, 544)], outdoors)).toEqual([]);
    // Nor the way from one open map to another that has an innkeeper standing in it.
    expect(innMarkers("underworld", keepers, [warp("Shaft", "overworld", 50, 60)], outdoors)).toEqual([]);
  });

  test("a house with two doors is marked once, and warps kept by name are read like a list", () => {
    const twice = { front: warp("Front", "house_12_58", 1000, 2000), back: warp("Back", "house_12_58", 1100, 1900) };
    expect(innMarkers("overworld", keepers.slice(0, 2), twice, outdoors)).toEqual([{ x: 1008, y: 2000, name: "The Rusty Anchor" }]);
  });

  test("a map with no warps, or no innkeepers anywhere, has none", () => {
    expect(innMarkers("overworld", keepers.slice(0, 2), null, outdoors)).toEqual([]);
    expect(innMarkers("overworld", keepers.slice(0, 2), undefined, outdoors)).toEqual([]);
    expect(innMarkers("overworld", [], doors, outdoors)).toEqual([]);
    // A warp that does not say where it is cannot be marked.
    expect(innMarkers("overworld", keepers.slice(0, 2), [{ name: "Door", map: "house_12_58" } as any], outdoors)).toEqual([]);
  });
});

describe("what a map marks on the minimap", () => {
  const warp = (name: string, to: string, x: number, y: number, width = 64, height = 48): any => ({ name, map: to, x: 1, y: 2, position: { x, y }, size: { width, height }, layer: null });
  const outdoors = (map: string) => map === "overworld" || map === "underworld";
  const keeper = inn({ id: 1, name: "The Rusty Anchor", map: "house_12_58" });

  test("a cave is a way from one open map into another: marked at the middle of its top edge", () => {
    const warps = [warp("Warp_1", "underworld", 8000, 2500), warp("Warp_2", "underworld.json", 100, 200, 64, 64), warp("House_1", "house_12_58", 1000, 2000, 32, 32)];
    expect(caveMarkers("overworld", warps, outdoors)).toEqual([{ x: 8032, y: 2500 }, { x: 132, y: 200 }]);
    // The way back up is one too.
    expect(caveMarkers("underworld.json", [warp("Warp_1", "overworld", 500, 600, 64, 64)], outdoors)).toEqual([{ x: 532, y: 600 }]);
  });

  test("a way to another place on the same map, into a house or out of one is no cave", () => {
    expect(caveMarkers("underworld", [warp("Warp_9", "underworld", 10, 10)], outdoors)).toEqual([]);
    expect(caveMarkers("overworld", [warp("House_1", "house_12_58", 10, 10)], outdoors)).toEqual([]);
    expect(caveMarkers("house_12_58", [warp("Door", "overworld", 10, 10)], outdoors)).toEqual([]);
    expect(caveMarkers("overworld", null, outdoors)).toEqual([]);
    expect(caveMarkers("overworld", [{ name: "Warp_1", map: "underworld" } as any], outdoors)).toEqual([]);
  });

  test("warps kept by name are read like a list", () => {
    expect(caveMarkers("overworld", { a: warp("Warp_1", "underworld", 0, 0) }, outdoors)).toEqual([{ x: 32, y: 0 }]);
  });

  test("a house is a door from open country into a map that is indoors: marked once, at the middle of the door's top edge", () => {
    const warps = [
      warp("House_1", "house_12_58", 1000, 2000, 32, 32), warp("House_2", "house_30_10.json", 3000, 4000, 32, 32),
      warp("House_1_back", "house_12_58", 1100, 1900, 32, 32), warp("Warp_1", "underworld", 8000, 2500), warp("Warp_2", "overworld", 50, 60),
    ];
    expect(houseMarkers("overworld", warps, outdoors)).toEqual([{ x: 1016, y: 2000 }, { x: 3016, y: 4000 }]);
    // From inside, the door back out is no house, and neither is a door from one room to the next.
    expect(houseMarkers("house_12_58", [warp("Door", "overworld", 336, 544), warp("Stairs", "house_12_58_upstairs", 10, 10)], outdoors)).toEqual([]);
    expect(houseMarkers("overworld", null, outdoors)).toEqual([]);
    expect(houseMarkers("overworld", [{ name: "House_1", map: "house_12_58" } as any], outdoors)).toEqual([]);
  });

  test("a merchant is marked as an inn is: on the door of the house it sells in, or where it stands in the open", () => {
    const sells = [{ item: "Bread", price: 5 }];
    const npcs = [
      inn({ id: 11, name: "Baker", map: "house_30_10", innkeeper: false, vendor_items: sells }),
      inn({ id: 12, name: "Pedlar", map: "overworld", innkeeper: false, vendor_items: sells, position: { x: 700, y: 900, direction: "down" } }),
      inn({ id: 13, name: "Shut Shop", map: "house_77_77", innkeeper: false, vendor_items: sells, hidden: true }),
      inn({ id: 14, name: "Idler", map: "house_40_40", innkeeper: false, vendor_items: [] }),
      keeper,
    ];
    const warps = [warp("House_2", "house_30_10", 3000, 4000, 32, 32), warp("House_1", "house_12_58", 1000, 2000, 32, 32), warp("House_3", "house_77_77", 10, 10), warp("House_4", "house_40_40", 20, 20)];
    expect(merchantMarkers("overworld", npcs, warps, outdoors)).toEqual([
      { x: 3016, y: 4000, name: "Baker" },
      { x: 700, y: 900, name: "Pedlar" },
    ]);
    expect(merchantMarkers("house_30_10", npcs, [warp("Door", "overworld", 336, 544)], outdoors)).toEqual([]);
  });

  test("everything a map marks, each of its kind: a house with an inn or a merchant in it is marked as both", () => {
    const baker = inn({ id: 11, name: "Baker", map: "house_30_10", innkeeper: false, vendor_items: [{ item: "Bread", price: 5 }] });
    const warps = [warp("Warp_1", "underworld", 8000, 2500), warp("House_1", "house_12_58", 1000, 2000, 32, 32), warp("House_2", "house_30_10", 3000, 4000, 32, 32)];
    expect(mapMarkers("overworld", [keeper, baker], warps, outdoors)).toEqual([
      { kind: "inn", x: 1016, y: 2000, name: "The Rusty Anchor" },
      { kind: "merchant", x: 3016, y: 4000, name: "Baker" },
      { kind: "cave", x: 8032, y: 2500, name: null },
      { kind: "house", x: 1016, y: 2000, name: null },
      { kind: "house", x: 3016, y: 4000, name: null },
    ]);
    expect(mapMarkers("house_12_58", [keeper, baker], [warp("Door", "overworld", 336, 544, 48, 16)], outdoors)).toEqual([]);
  });
});

describe("a player's home", () => {
  test("is nowhere until one is set", async () => {
    expect(await homes.where("hero")).toBeNull();
    expect(await homes.of("hero")).toEqual({ npc_id: null, offset_x: 0, offset_y: 0, used_at: 0 });
  });

  test("is where they stood by the innkeeper when they set it", async () => {
    await homes.set(person(), inn());
    expect(tables.player_home).toEqual([{ username: "hero", npc_id: 7, offset_x: 30, offset_y: 40, used_at: 0 }]);
    expect(await homes.where("HERO")).toEqual({ map: "harbor", x: 430, y: 340, inn: "The Rusty Anchor" });
  });

  test("reads a position kept as text", async () => {
    await homes.set(person("hero", { location: { map: "harbor", position: "390,310" } }), inn());
    expect(await homes.where("hero")).toEqual({ map: "harbor", x: 390, y: 310, inn: "The Rusty Anchor" });
  });

  test("follows the innkeeper when it is moved", async () => {
    await homes.set(person(), inn());
    assets.set("npcs", [inn({ map: "forest.json", position: { x: 1000, y: 2000, direction: "down" } })]);
    expect(await homes.where("hero")).toEqual({ map: "forest", x: 1030, y: 2040, inn: "The Rusty Anchor" });
  });

  test("is nowhere once the innkeeper is gone, hidden or no innkeeper any more", async () => {
    await homes.set(person(), inn());
    for (const npcs of [[], [inn({ hidden: true })], [inn({ innkeeper: false })]]) {
      assets.set("npcs", npcs);
      expect(await homes.where("hero")).toBeNull();
    }
  });

  test("is replaced by the next one set, which leaves the cooldown as it was", async () => {
    await homes.set(person(), inn());
    await homes.arrive("hero", NOW);
    await homes.set(person("hero", { location: { map: "forest", position: { x: 10, y: 10 } } }), inn({ id: 12, name: "Leaf Lodge", map: "forest", position: { x: 0, y: 0 } }));
    expect(tables.player_home).toEqual([{ username: "hero", npc_id: 12, offset_x: 10, offset_y: 10, used_at: NOW }]);
    expect(await homes.cooldownLeft("hero", NOW + 1000)).toBe(HOME_COOLDOWN_MS - 1000);
  });

  test("is as it was when it could not be written", async () => {
    await homes.set(person(), inn());
    failing = (sql) => sql.startsWith("INSERT INTO player_home");
    await expect(homes.set(person("hero", { location: { map: "harbor", position: { x: 400, y: 300 } } }), inn())).rejects.toThrow("database gone");
    failing = null;
    expect(await homes.where("hero")).toEqual({ map: "harbor", x: 430, y: 340, inn: "The Rusty Anchor" });
  });

  test("is forgotten by everyone who had it at an innkeeper that was deleted", async () => {
    await homes.set(person(), inn());
    await homes.set(person("ally"), inn());
    await homes.set(person("rival"), inn({ id: 12 }));
    await homes.innGone(7);
    expect(tables.player_home.map((row) => row.npc_id)).toEqual([null, null, 12]);
    // An NPC made later under the same id is not their home.
    expect(await homes.where("hero")).toBeNull();
    expect((await homes.of("rival")).npc_id).toBe(12);
  });
});

describe("going home", () => {
  test("answers where home is and starts the hour", async () => {
    await homes.set(person(), inn());
    expect(await homes.arrive("hero", NOW)).toEqual({ map: "harbor", x: 430, y: 340, inn: "The Rusty Anchor" });
    expect(tables.player_home[0].used_at).toBe(NOW);
    expect(await homes.cooldownLeft("hero", NOW)).toBe(HOME_COOLDOWN_MS);
    expect(await homes.cooldownLeft("hero", NOW + HOME_COOLDOWN_MS - 5)).toBe(5);
    expect(await homes.cooldownLeft("hero", NOW + HOME_COOLDOWN_MS + 5)).toBe(0);
  });

  test("with no home answers nowhere, for the world's spawn, and still starts the hour", async () => {
    expect(await homes.arrive("hero", NOW)).toBeNull();
    expect(tables.player_home).toEqual([{ username: "hero", npc_id: null, offset_x: 0, offset_y: 0, used_at: NOW }]);
    expect(await homes.cooldownLeft("hero", NOW + 1)).toBe(HOME_COOLDOWN_MS - 1);
  });

  test("keeps its cooldown through a restart", async () => {
    await homes.arrive("hero", NOW);
    await clearCaches();
    expect(await homes.cooldownLeft("hero", NOW + 60_000)).toBe(HOME_COOLDOWN_MS - 60_000);
  });

  test("reads a time the database hands back as text", async () => {
    tables.player_home.push({ username: "hero", npc_id: 7, offset_x: "3", offset_y: "4", used_at: String(NOW) });
    expect(await homes.cooldownLeft("hero", NOW + 1)).toBe(HOME_COOLDOWN_MS - 1);
    expect(await homes.where("hero")).toEqual({ map: "harbor", x: 403, y: 304, inn: "The Rusty Anchor" });
  });

  test("starts no hour when the time could not be written", async () => {
    failing = (sql) => sql.startsWith("INSERT INTO player_home");
    await expect(homes.arrive("hero", NOW)).rejects.toThrow("database gone");
    failing = null;
    expect(await homes.cooldownLeft("hero", NOW)).toBe(0);
  });
});
