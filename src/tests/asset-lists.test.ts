import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// The lists the asset cache holds of whole tables (items, mounts, weather,
// worlds, npcs, particles): read from the database at startup, answered from
// what is held after that, and kept in step by each write.

// ------------------------------------------------------------ fake database
// A few statement shapes, run against in-memory tables the way MySQL would:
// names are compared without regard to case, a flag is kept as 0 or 1, and a
// number column keeps a number. A statement it does not know is an error.

type Row = Record<string, any>;
let db: Record<string, Row[]>;
let nextId: number;
/** Every statement sent, with its values, in order. */
let queries: Array<[string, any[]]> = [];
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null = null;
/** The refused statement was applied all the same, as one that timed out may have been. */
let appliedAnyway = false;
/** Whether an INSERT reports the id it gave the row. */
let reportsInsertId = true;

const NUMBERED = ["npcs", "mounts", "items"];
const WHOLE = ["size", "lifetime", "visible", "amount", "interval", "affected_by_weather", "zIndex", "static_light", "affected_by_time", "hidden", "quest_giver"];
const FRACTION = ["opacity", "staggertime", "glow_intensity", "glow_radius", "brightness"];

/** A value as a column keeps it. */
function kept(column: string, value: any): any {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (WHOLE.includes(column)) return Math.round(Number(value));
  if (FRACTION.includes(column)) return Number(value);
  return typeof value === "number" ? value : String(value);
}

const same = (a: unknown, b: unknown) => (typeof a === "string" || typeof b === "string" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
const columnsOf = (list: string) => list.split(",").map((column) => column.trim().replaceAll("`", ""));

function apply(sql: string, params: any[]): any {
  const text = sql.replace(/\s+/g, " ").trim();
  let m: RegExpExecArray | null;

  if ((m = /^SELECT \* FROM (\w+)$/.exec(text)) && db[m[1]]) return db[m[1]].map((row) => ({ ...row }));
  // Whether a column exists: they all do.
  if (/^SELECT \w+ FROM particles LIMIT 1$/.test(text)) return [];

  if ((m = /^INSERT (IGNORE )?INTO (\w+) \((.+?)\) VALUES \(/.exec(text)) && db[m[2]]) {
    const [, ignore, table, list] = m;
    const row: Row = NUMBERED.includes(table) ? { id: nextId } : {};
    columnsOf(list).forEach((column, i) => { row[column] = kept(column, params[i]); });
    if (db[table].some((held) => held.name !== null && table !== "npcs" && same(held.name, row.name))) {
      if (ignore) return { affectedRows: 0 };
      throw new Error(`Duplicate entry '${row.name}' for key 'name'`);
    }
    if (NUMBERED.includes(table)) nextId++;
    db[table].push(row);
    return reportsInsertId && NUMBERED.includes(table) ? { affectedRows: 1, lastInsertRowid: row.id } : { affectedRows: 1 };
  }
  if ((m = /^DELETE FROM (\w+) WHERE (\w+) = \?$/.exec(text)) && db[m[1]]) {
    const [, table, key] = m;
    const before = db[table].length;
    db[table] = db[table].filter((row) => !same(row[key], params[0]));
    return { affectedRows: before - db[table].length };
  }
  if ((m = /^UPDATE (\w+) SET (.+) WHERE (\w+) = \?$/.exec(text)) && db[m[1]]) {
    const [, table, assignments, key] = m;
    const columns = columnsOf(assignments.replaceAll(" = ?", ""));
    const rows = db[table].filter((row) => same(row[key], params[columns.length]));
    for (const row of rows) columns.forEach((column, i) => { row[column] = kept(column, params[i]); });
    return { affectedRows: rows.length };
  }
  throw new Error(`The fake database does not understand: ${text}`);
}

async function database(sql: string, params: any[] = []): Promise<any> {
  queries.push([sql.replace(/\s+/g, " ").trim(), params]);
  if (failing?.test(sql.replace(/\s+/g, " ").trim())) {
    if (appliedAnyway) apply(sql, params);
    throw new Error("connection lost");
  }
  return apply(sql, params);
}

function resetDatabase() {
  nextId = 100;
  db = {
    items: [
      { id: 1, name: "Iron Sword", quality: "common", type: "equipment", description: "A sword.", icon: null, level_requirement: 1, equipable: 1, equipment_slot: "weapon" },
      { id: 2, name: "Wolf Pelt", quality: "common", type: "material", description: "A pelt.", icon: null, level_requirement: 1, equipable: 0, equipment_slot: null },
    ],
    mounts: [
      { id: 1, name: "horse", description: "A horse.", particles: null, icon: "horse" },
      { id: 2, name: "ember steed", description: "Burns.", particles: "smoke, ember", icon: null },
    ],
    weather: [
      { name: "clear", ambience: 0, wind_direction: "none", wind_speed: 0, humidity: 30, temperature: 68, precipitation: 0 },
      { name: "rainy", ambience: 0.5, wind_direction: "left", wind_speed: 4, humidity: 90, temperature: 55, precipitation: 0.8 },
    ],
    worlds: [
      { name: "overworld", weather: "rainy" },
      { name: "cave", weather: "none" },
    ],
    npcs: [
      {
        id: 5, last_updated: "2026-01-01 09:00:00", name: "Guard", map: "overworld", position: "120,80", direction: "left", dialog: "Halt.", gossip: null,
        hidden: 0, script: null, particles: "ember", quest_giver: 1, sprite_type: "animated", sprite_body: "guard", sprite_head: null, sprite_helmet: null,
        sprite_shoulderguards: null, sprite_neck: null, sprite_hands: null, sprite_chest: null, sprite_feet: null, sprite_legs: null, sprite_weapon: null,
      },
      {
        id: 9, last_updated: "2026-01-02 09:00:00", name: null, map: "cave", position: "10,20", direction: "down", dialog: null, gossip: null,
        hidden: 1, script: null, particles: "smoke,ember", quest_giver: 0, sprite_type: "none", sprite_body: null, sprite_head: null, sprite_helmet: null,
        sprite_shoulderguards: null, sprite_neck: null, sprite_hands: null, sprite_chest: null, sprite_feet: null, sprite_legs: null, sprite_weapon: null,
      },
    ],
    particles: [
      {
        name: "ember", size: 3, color: "orange", velocity: "0,-1", lifetime: 900, opacity: 0.8, visible: 1, gravity: "0,0.5", localposition: "4,8", amount: 6,
        interval: 100, staggertime: 0, spread: "2,2", affected_by_weather: 1, zIndex: 2, glow_intensity: 1.5, glow_radius: 12, static_light: 0, brightness: 1,
        affected_by_time: 0, time_on: null, time_off: null, image: null,
      },
      {
        name: "smoke", size: 5, color: "grey", velocity: "0,-0.5", lifetime: 2000, opacity: 0.4, visible: 1, gravity: "0,0", localposition: "0,0", amount: 2,
        interval: 300, staggertime: 0.5, spread: "6,1", affected_by_weather: 0, zIndex: 0, glow_intensity: 0, glow_radius: 0, static_light: 0, brightness: 1,
        affected_by_time: 1, time_on: "18:00", time_off: "06:00", image: "puff.png",
      },
    ],
    spells: [
      { id: 1, name: "fire_bolt", particles: "ember" },
      { id: 2, name: "frost_bolt", particles: null },
    ],
  };
}

resetDatabase();
mock.module("../controllers/sqldatabase", () => ({ default: database }));

const cache = new Map<string, any>();
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => cache.get(key),
    set: async (key: string, value: any) => { cache.set(key, value); },
    add: async (key: string, value: any) => { cache.set(key, value); },
  },
}));

const { default: log } = await import("../modules/logger");
const { default: items } = await import("../systems/items");
const { default: mounts } = await import("../systems/mounts");
const { default: weather } = await import("../systems/weather");
const { default: worlds } = await import("../systems/worlds");
const { default: npcs } = await import("../systems/npcs");
const { default: particles } = await import("../systems/particles");

const statements = () => queries.map(([sql]) => sql);
const reads = () => statements().filter((sql) => sql.startsWith("SELECT"));
const writes = () => statements().filter((sql) => !sql.startsWith("SELECT"));
const held = <T = any>(key: string): T[] => {
  const list = cache.get(key);
  return (typeof list === "string" ? JSON.parse(list) : list) as T[];
};
const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const RAINY = { name: "rainy", ambience: 0.5, wind_direction: "left", wind_speed: 4, humidity: 90, temperature: 55, precipitation: 0.8 };

/** The particles of the fixture, as the server holds them. */
const EMBER = {
  name: "ember", size: 3, color: "orange", lifetime: 900, opacity: 0.8, visible: true, gravity: { x: 0, y: 0.5 }, localposition: { x: 4, y: 8 },
  velocity: { x: 0, y: -1 }, interval: 100, amount: 6, staggertime: 0, spread: { x: 2, y: 2 }, currentLife: null, initialVelocity: null,
  weather: RAINY, affected_by_weather: true, zIndex: 2, glow_intensity: 1.5, glow_radius: 12, static_light: false, brightness: 1,
  affected_by_time: false, time_on: null, time_off: null, image: null,
};
const SMOKE = {
  name: "smoke", size: 5, color: "grey", lifetime: 2000, opacity: 0.4, visible: true, gravity: { x: 0, y: 0 }, localposition: { x: 0, y: 0 },
  velocity: { x: 0, y: -0.5 }, interval: 300, amount: 2, staggertime: 0.5, spread: { x: 6, y: 1 }, currentLife: null, initialVelocity: null,
  weather: "none", affected_by_weather: false, zIndex: 0, glow_intensity: 0, glow_radius: 0, static_light: false, brightness: 1,
  affected_by_time: true, time_on: "18:00", time_off: "06:00", image: "puff.png",
};
/** A particle as the particle editor sends it: pairs as "x,y" text. */
const sent = (over: Row = {}) => ({
  name: "spark", size: 2, color: "yellow", velocity: "1,-2", lifetime: 400, opacity: 1, visible: true, gravity: "0,1", localposition: "0,0", interval: 50,
  amount: 12, staggertime: 0.25, spread: "3,3", affected_by_weather: false, zIndex: 1, glow_intensity: 2, glow_radius: 0, static_light: false, brightness: 1.5,
  affected_by_time: false, time_on: "", time_off: "", image: null, ...over,
} as unknown as Particle);
const SPARK = {
  name: "spark", size: 2, color: "yellow", lifetime: 400, opacity: 1, visible: true, gravity: { x: 0, y: 1 }, localposition: { x: 0, y: 0 },
  velocity: { x: 1, y: -2 }, interval: 50, amount: 12, staggertime: 0.25, spread: { x: 3, y: 3 }, currentLife: null, initialVelocity: null,
  weather: "none", affected_by_weather: false, zIndex: 1, glow_intensity: 2, glow_radius: 0, static_light: false, brightness: 1.5,
  affected_by_time: false, time_on: null, time_off: null, image: null,
};

const GUARD = {
  id: 5, last_updated: "2026-01-01 09:00:00", map: "overworld", name: "Guard", position: { x: 120, y: 80, direction: "left" }, hidden: false, script: null,
  dialog: "Halt.", gossip: null, particles: "ember", quest_giver: true, sprite_type: "animated", sprite_body: "guard", sprite_head: null, sprite_helmet: null,
  sprite_shoulderguards: null, sprite_neck: null, sprite_hands: null, sprite_chest: null, sprite_feet: null, sprite_legs: null, sprite_weapon: null,
};
const LURKER = {
  id: 9, last_updated: "2026-01-02 09:00:00", map: "cave", name: null, position: { x: 10, y: 20, direction: "down" }, hidden: true, script: null,
  dialog: null, gossip: null, particles: "smoke,ember", quest_giver: false, sprite_type: "none", sprite_body: null, sprite_head: null, sprite_helmet: null,
  sprite_shoulderguards: null, sprite_neck: null, sprite_hands: null, sprite_chest: null, sprite_feet: null, sprite_legs: null, sprite_weapon: null,
};
/** A particle emitter a map places: never a database row. */
const TORCH = { ...LURKER, id: -1, map: "overworld", particles: "ember", hidden: false } as unknown as Npc;
const npc = (over: Row = {}) => ({
  id: null, last_updated: null, map: "overworld", name: "Smith", position: { x: 300, y: 40, direction: "right" }, hidden: false, script: null, dialog: "Hot.",
  gossip: null, particles: "ember,smoke", quest_giver: false, sprite_type: "animated", sprite_body: "smith", sprite_head: null, sprite_helmet: null,
  sprite_shoulderguards: null, sprite_neck: null, sprite_hands: null, sprite_chest: null, sprite_feet: null, sprite_legs: null, sprite_weapon: null, ...over,
} as unknown as Npc);
/** An NPC as held, but for when it was written. */
const timeless = (list: any[]) => list.map((entry) => ({ ...entry, last_updated: null }));

// MySQL's way with names is what these tests are of.
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

// Startup, as the asset loader does it: each table read once into the cache.
beforeEach(async () => {
  resetDatabase();
  failing = null;
  appliedAnyway = false;
  reportsInsertId = true;
  cache.clear();
  cache.set("items", await items.list());
  cache.set("mounts", await mounts.list());
  cache.set("weather", await weather.list());
  cache.set("worlds", await worlds.list());
  cache.set("spells", db.spells.map((row) => ({ ...row })));
  npcs.setMapNpcs([]);
  await npcs.reload();
  await particles.reload();
  queries = [];
});

/** A write the database refuses, which reads the table again: what is then held is what a restart would hold. */
async function reread(table: string): Promise<void> {
  failing = new RegExp(`^DELETE FROM ${table} `);
  const key = table === "npcs" ? "id" : "name";
  const module: any = { items, mounts, weather, worlds, npcs, particles }[table];
  await expect(module.remove({ [key]: table === "npcs" ? 987654 : "nothing of this name" })).rejects.toThrow("connection lost");
  failing = null;
}

// -------------------------------------------------------------------- items

describe("items", () => {
  test("find answers from the items held, in any case, without the database", async () => {
    expect(await items.find({ name: "wolf pelt" } as Item)).toEqual([db.items[1]] as any);
    expect(await items.find({ name: "Dragon Scale" } as Item)).toBeUndefined();
    expect(await items.find({} as Item)).toBeUndefined();
    expect(queries).toEqual([]);
  });

  const dagger = { name: "Dagger", quality: "common", description: "Sharp.", type: "equipment", level_requirement: 1, equipable: true, equipment_slot: "weapon" } as unknown as Item;

  test("add, update and remove are written to the database and then to the items held", async () => {
    await items.add(dagger);
    expect(held("items").map((item) => item.name)).toEqual(["Iron Sword", "Wolf Pelt", "Dagger"]);
    expect(await items.find({ name: "dagger" } as Item)).toEqual([dagger]);

    await items.update({ ...dagger, description: "Sharper." });
    expect((await items.find(dagger))![0].description).toBe("Sharper.");
    expect(db.items.find((row) => row.name === "Dagger")!.description).toBe("Sharper.");

    await items.remove({ name: "Wolf Pelt" } as Item);
    expect(held("items").map((item) => item.name)).toEqual(["Iron Sword", "Dagger"]);
    expect(db.items.map((row) => row.name)).toEqual(["Iron Sword", "Dagger"]);
    expect(writes()).toHaveLength(3);
    expect(reads()).toEqual([]);
  });

  test("add of a name that is taken adds nothing, and update of an item that is not there changes nothing", async () => {
    await items.add({ ...dagger, name: "iron sword" });
    await items.update({ ...dagger, name: "Nothing" });
    expect(held("items")).toEqual(db.items);
    expect(held("items")).toHaveLength(2);
    expect(Object.keys(held("items"))).toEqual(["0", "1"]);
  });

  for (const applied of [false, true]) {
    test(`a write the database refused${applied ? ", though it had applied it" : ""}: the table is read again, once, and what is held is what it holds`, async () => {
      failing = /^(INSERT IGNORE INTO|UPDATE|DELETE FROM) items/;
      appliedAnyway = applied;
      await expect(items.add(dagger)).rejects.toThrow("connection lost");
      expect(statements().slice(-1)).toEqual(["SELECT * FROM items"]);
      expect(held("items")).toEqual(db.items);
      await expect(items.remove({ name: "Wolf Pelt" } as Item)).rejects.toThrow("connection lost");
      await expect(items.update({ ...dagger, name: "Iron Sword" })).rejects.toThrow("connection lost");
      failing = null;

      expect(held("items")).toEqual(db.items);
      expect(Boolean(await items.find({ name: "Dagger" } as Item))).toBe(applied);
      expect(Boolean(await items.find({ name: "Wolf Pelt" } as Item))).toBe(!applied);
      expect(reads()).toEqual(["SELECT * FROM items", "SELECT * FROM items", "SELECT * FROM items"]);
    });
  }
});

// ------------------------------------------------------------------- mounts

describe("mounts", () => {
  test("find answers from the mounts held, without the database", async () => {
    expect(await mounts.find({ name: "Horse" } as Mount)).toEqual([db.mounts[0]] as any);
    expect(await mounts.find({ name: "griffin" } as Mount)).toBeUndefined();
    expect(await mounts.find({} as Mount)).toBeUndefined();
    expect(queries).toEqual([]);
  });

  test("add, update and remove are written to the database and then to the mounts held", async () => {
    await mounts.add({ name: "griffin", description: "Flies.", particles: "", icon: "griffin" } as Mount);
    expect(held("mounts")).toEqual(db.mounts);
    expect(await mounts.find({ name: "griffin" } as Mount)).toEqual([{ id: 100, name: "griffin", description: "Flies.", particles: null, icon: "griffin" }] as any);

    await mounts.update({ name: "griffin", description: "Flies far.", particles: "ember", icon: null } as Mount);
    expect((await mounts.find({ name: "griffin" } as Mount))![0]).toMatchObject({ description: "Flies far.", particles: "ember", icon: null });
    expect(db.mounts.at(-1)).toMatchObject({ description: "Flies far.", particles: "ember", icon: null });

    await mounts.remove({ name: "horse" } as Mount);
    expect(held("mounts").map((mount) => mount.name)).toEqual(["ember steed", "griffin"]);
    expect(db.mounts.map((row) => row.name)).toEqual(["ember steed", "griffin"]);
    expect(writes()).toHaveLength(3);
    expect(reads()).toEqual([]);
  });

  test("add of a name that is taken adds nothing", async () => {
    await mounts.add({ name: "HORSE", description: "Another." } as Mount);
    expect(held("mounts")).toEqual(db.mounts);
    expect(held("mounts")).toHaveLength(2);
  });

  test("a write the database refused: the table is read again, and what is held is what it holds", async () => {
    failing = /^DELETE FROM mounts/;
    appliedAnyway = true;
    await expect(mounts.remove({ name: "horse" } as Mount)).rejects.toThrow("connection lost");
    failing = null;
    expect(held("mounts")).toEqual(db.mounts);
    expect(await mounts.find({ name: "horse" } as Mount)).toBeUndefined();
    expect(reads()).toEqual(["SELECT * FROM mounts"]);
  });
});

// ------------------------------------------------------------------ weather

describe("weather", () => {
  const storm = { name: "storm", temperature: 50, humidity: 95, wind_speed: 9, wind_direction: "right", precipitation: 1, ambience: 0.9 };

  test("add, update and remove are written to the database and then to the weather held, which stays the whole list", async () => {
    await weather.add(storm);
    expect(held("weather").map((w) => w.name)).toEqual(["clear", "rainy", "storm"]);
    expect(await weather.find({ name: "storm" } as WeatherData)).toEqual(storm);

    await weather.update({ ...storm, wind_speed: 12 });
    expect((await weather.find({ name: "storm" } as WeatherData))!.wind_speed).toBe(12);

    await weather.remove({ name: "clear" } as WeatherData);
    expect(held("weather").map((w) => w.name)).toEqual(["rainy", "storm"]);
    expect(await weather.random()).toBeTruthy();
    expect(writes()).toHaveLength(3);
    expect(reads()).toEqual([]);

    await reread("weather");
    expect(reads()).toEqual(["SELECT * FROM weather"]);
    expect(held("weather").map((w) => w.name)).toEqual(["rainy", "storm"]);
    expect(held("weather").find((w) => w.name === "storm")).toMatchObject({ wind_speed: 12, ambience: 0.9 });
  });

  test("a write the database refused, though it had applied it: what is held is what the database holds", async () => {
    failing = /^INSERT INTO weather/;
    appliedAnyway = true;
    await expect(weather.add(storm)).rejects.toThrow("connection lost");
    failing = null;
    expect(held("weather").map((w) => w.name)).toEqual(["clear", "rainy", "storm"]);
    expect(reads()).toEqual(["SELECT * FROM weather"]);
  });
});

// ------------------------------------------------------------------- worlds

describe("worlds", () => {
  /** The worlds as a player joining leaves them held: as text, with the count. */
  const withPlayers = (count: number) => cache.set("worlds", JSON.stringify([{ name: "overworld", weather: "rainy", players: count }, { name: "cave", weather: "none", players: 0 }]));

  test("get and the current weather answer from the worlds held, also in the form a player count leaves them", async () => {
    expect(await worlds.get("cave")).toEqual({ name: "cave", weather: "none", players: 0 });
    withPlayers(1);
    expect(await worlds.get("overworld")).toEqual({ name: "overworld", weather: "rainy", players: 1 });
    expect(await worlds.getCurrentWeather("overworld")).toBe("rainy");
    expect(await worlds.getCurrentWeather("nowhere")).toBe("clear");
    expect(queries).toEqual([]);
  });

  test("add, update and remove are written to the database and then to the worlds held, and the player counts are kept", async () => {
    withPlayers(3);
    await worlds.add({ name: "arena", weather: "clear", players: null });
    expect(held("worlds")).toEqual([{ name: "overworld", weather: "rainy", players: 3 }, { name: "cave", weather: "none", players: 0 }, { name: "arena", weather: "clear", players: 0 }]);

    await worlds.update({ name: "overworld", weather: "clear", players: 0 });
    expect(await worlds.get("overworld")).toEqual({ name: "overworld", weather: "clear", players: 3 });
    expect(db.worlds[0]).toEqual({ name: "overworld", weather: "clear" });

    await worlds.remove({ name: "cave", weather: "none", players: null });
    expect(held("worlds").map((world) => world.name)).toEqual(["overworld", "arena"]);
    expect(db.worlds.map((row) => row.name)).toEqual(["overworld", "arena"]);
    expect(writes()).toHaveLength(3);
    expect(reads()).toEqual([]);
  });

  test("a write the database refused, though it had applied it: the table is read again, and the player counts are kept", async () => {
    withPlayers(2);
    failing = /^UPDATE worlds/;
    appliedAnyway = true;
    await expect(worlds.update({ name: "overworld", weather: "clear", players: 0 })).rejects.toThrow("connection lost");
    failing = null;
    expect(held("worlds")).toEqual([{ name: "overworld", weather: "clear", players: 2 }, { name: "cave", weather: "none", players: 0 }]);
    expect(reads()).toEqual(["SELECT * FROM worlds"]);
  });
});

// --------------------------------------------------------------------- npcs

describe("npcs", () => {
  test("the list is the NPCs held and the maps' own, without the database", async () => {
    npcs.setMapNpcs([TORCH]);
    expect(await npcs.list()).toEqual([GUARD, LURKER, TORCH] as any);
    expect(await npcs.list()).toEqual([GUARD, LURKER, TORCH] as any);
    expect(queries).toEqual([]);
  });

  test("the first list of a server is read from the database", async () => {
    // What reload() is to these tests, list() is to the asset loader at startup: one read of the table.
    expect(await npcs.reload()).toEqual([GUARD, LURKER] as any);
    expect(statements()).toEqual(["SELECT * FROM npcs"]);
  });

  test("find answers from the NPCs held", async () => {
    expect(await npcs.find({ id: 9 } as Npc)).toEqual([LURKER] as any);
    expect(await npcs.find({ id: 77 } as Npc)).toEqual([]);
    expect(await npcs.find({} as Npc)).toBeUndefined();
    expect(queries).toEqual([]);
  });

  test("add writes the NPC, and the list has it under the id the database gave it, without asking", async () => {
    npcs.setMapNpcs([TORCH]);
    await npcs.add(npc());
    expect(writes()).toHaveLength(1);
    expect(db.npcs.at(-1)).toMatchObject({ id: 100, map: "overworld", name: "Smith", position: "300,40", direction: "right", hidden: 0, particles: "ember,smoke", quest_giver: 0 });

    const list = await npcs.list();
    expect(timeless(list)).toEqual(timeless([GUARD, LURKER, { ...npc(), id: 100 }, TORCH]));
    expect(list[2].last_updated).toBeInstanceOf(Date);
    // The asset cache holds the whole list too: before, it held the INSERT's answer until the list was next read.
    expect(timeless(held("npcs"))).toEqual(timeless([GUARD, LURKER, { ...npc(), id: 100 }, TORCH]));
    expect(reads()).toEqual([]);
  });

  test("an NPC added with particles in a list, no name and no direction is held as the table keeps it", async () => {
    await npcs.add(npc({ name: "", particles: ["ember", "smoke"], position: { x: 0, y: 0, direction: null }, quest_giver: true, hidden: true, sprite_type: undefined }));
    expect(timeless(await npcs.list()).at(-1)).toEqual({ ...npc(), id: 100, name: null, particles: "ember,smoke", position: { x: 0, y: 0, direction: "down" }, quest_giver: true, hidden: true, sprite_type: "none" });
  });

  test("add whose answer carries no id reads the table again, rather than hold an NPC nothing could address", async () => {
    reportsInsertId = false;
    await npcs.add(npc());
    expect(reads()).toEqual(["SELECT * FROM npcs"]);
    expect((await npcs.list()).map((entry) => entry.id)).toEqual([5, 9, 100]);
  });

  test("update writes every column, and the list has them without asking", async () => {
    await npcs.update({ ...GUARD, name: "Captain", position: { x: 1, y: 2, direction: "up" }, hidden: true, particles: "smoke", quest_giver: false } as unknown as Npc);
    expect(writes()).toHaveLength(1);
    expect(db.npcs[0]).toMatchObject({ name: "Captain", position: "1,2", direction: "up", hidden: 1, particles: "smoke", quest_giver: 0 });
    expect(timeless(await npcs.list())).toEqual(timeless([{ ...GUARD, name: "Captain", position: { x: 1, y: 2, direction: "up" }, hidden: true, particles: "smoke", quest_giver: false }, LURKER]));
    expect(reads()).toEqual([]);
  });

  test("move writes the position where the list reads it, and keeps the direction", async () => {
    await npcs.move({ id: 5, position: { x: 7, y: 8, direction: null } } as unknown as Npc);
    expect(db.npcs[0].position).toBe("7,8");
    expect(timeless(await npcs.list())).toEqual(timeless([{ ...GUARD, position: { x: 7, y: 8, direction: "left" } }, LURKER]));
    expect(reads()).toEqual([]);
  });

  test("remove deletes the NPC, and the list knows without asking", async () => {
    await npcs.remove({ id: 5 } as Npc);
    expect(db.npcs.map((row) => row.id)).toEqual([9]);
    expect(await npcs.list()).toEqual([LURKER] as any);
    expect(reads()).toEqual([]);
  });

  test("after its writes, what is held is what the table holds", async () => {
    await npcs.add(npc({ particles: ["ember"], hidden: true }));
    await npcs.update({ ...LURKER, name: "Lurker", dialog: "..." } as unknown as Npc);
    await npcs.move({ id: 5, position: { x: 7, y: 8 } } as unknown as Npc);
    const before = timeless(copyOf(await npcs.list()));
    await reread("npcs");
    expect(timeless(copyOf(await npcs.list()))).toEqual(before);
  });

  for (const applied of [false, true]) {
    test(`a write the database refused${applied ? ", though it had applied it" : ""}: the table is read again, once, and the list is what it holds`, async () => {
      failing = /^DELETE FROM npcs/;
      appliedAnyway = applied;
      await expect(npcs.remove({ id: 5 } as Npc)).rejects.toThrow("connection lost");
      failing = null;
      expect(reads()).toEqual(["SELECT * FROM npcs"]);
      expect((await npcs.list()).map((entry) => entry.id)).toEqual(applied ? [9] : [5, 9]);
      expect(held("npcs").map((entry) => entry.id)).toEqual(applied ? [9] : [5, 9]);
      expect(reads()).toEqual(["SELECT * FROM npcs"]);
    });
  }

  test("when the table cannot be read again either, the next list reads it", async () => {
    failing = /^(DELETE FROM|SELECT \* FROM) npcs/;
    appliedAnyway = true;
    await expect(npcs.remove({ id: 5 } as Npc)).rejects.toThrow("connection lost");
    appliedAnyway = false;
    await expect(npcs.list()).rejects.toThrow("connection lost");
    failing = null;
    expect((await npcs.list()).map((entry) => entry.id)).toEqual([9]);
    queries = [];
    await npcs.list();
    expect(queries).toEqual([]);
  });
});

// ---------------------------------------------------------------- particles

describe("particles", () => {
  test("remove deletes the particle, and the list knows without asking: it is no longer wiped", async () => {
    await particles.remove({ name: "ember" } as Particle);
    expect(db.particles.map((row) => row.name)).toEqual(["smoke"]);
    expect(await particles.list()).toEqual([SMOKE] as any);
    expect(held("particles")).toEqual([SMOKE]);
    expect(reads()).toEqual([]);
  });

  test("numbers sent as text, a pair sent as an object and a bad image are held as the table keeps them", async () => {
    await particles.add(sent({ size: "4", opacity: "0.5", lifetime: "250.6", velocity: { x: 1, y: 2 }, zIndex: undefined, glow_intensity: undefined, brightness: "", image: "../secret.png" }));
    const before = copyOf(await particles.list());
    expect(before.at(-1)).toMatchObject({ size: 4, opacity: 0.5, lifetime: 251, velocity: { x: 0, y: 0 }, zIndex: 0, glow_intensity: 0, brightness: 1, image: null });
    await reread("particles");
    expect(copyOf(await particles.list())).toEqual(before);
  });

  test("after its writes, what is held is what the table holds", async () => {
    await particles.add(sent());
    await particles.update(sent({ name: "ember", size: 9, affected_by_weather: true }));
    await particles.remove({ name: "smoke" } as Particle);
    const before = copyOf(await particles.list());
    await reread("particles");
    expect(copyOf(await particles.list())).toEqual(before);
    expect(before.map((particle: any) => particle.name)).toEqual(["ember", "spark"]);
  });

  test("when the table cannot be read again either, the next list reads it", async () => {
    failing = /^(DELETE FROM|SELECT \* FROM) particles/;
    appliedAnyway = true;
    await expect(particles.remove({ name: "ember" } as Particle)).rejects.toThrow("connection lost");
    appliedAnyway = false;
    await expect(particles.list()).rejects.toThrow("connection lost");
    failing = null;
    expect(await particles.list()).toEqual([SMOKE] as any);
    queries = [];
    await particles.list();
    expect(queries).toEqual([]);
  });
});

describe("renaming a particle", () => {
  test("renames it and every database row that names it, found in the lists held and not asked of the database", async () => {
    npcs.setMapNpcs([TORCH]);
    cache.get("spells").unshift({ name: "plugin_nova", particles: "ember" });

    expect(await particles.rename("ember", "cinder")).toEqual({ npcs: 2, spells: 1, mounts: 1 });

    expect(reads()).toEqual([]);
    expect(writes()).toEqual([
      "UPDATE particles SET name = ? WHERE name = ?",
      "UPDATE npcs SET particles = ? WHERE id = ?", "UPDATE npcs SET particles = ? WHERE id = ?",
      "UPDATE spells SET particles = ? WHERE name = ?",
      "UPDATE mounts SET particles = ? WHERE name = ?",
    ]);
    expect(db.particles.map((row) => row.name)).toEqual(["cinder", "smoke"]);
    expect(db.npcs.map((row) => row.particles)).toEqual(["cinder", "smoke,cinder"]);
    expect(db.spells.map((row) => row.particles)).toEqual(["cinder", null]);
    expect(db.mounts.map((row) => row.particles)).toEqual([null, "smoke,cinder"]);
    // A map's own emitter and a plugin's spell are no database rows: whoever renames (the receiver) changes them in memory.
    expect(TORCH.particles as unknown).toBe("ember");
  });

  test("a name that is only part of another is left alone", async () => {
    db.npcs[0].particles = "embers";
    await npcs.reload();
    queries = [];
    expect(await particles.rename("ember", "cinder")).toEqual({ npcs: 1, spells: 1, mounts: 1 });
    expect(db.npcs.map((row) => row.particles)).toEqual(["embers", "smoke,cinder"]);
  });

  test("a rename the database refused part way: every list it touches is read again, and holds what the database holds", async () => {
    failing = /^UPDATE mounts/;
    await expect(particles.rename("ember", "cinder")).rejects.toThrow("connection lost");
    failing = null;

    expect(reads().sort()).toEqual(["SELECT * FROM mounts", "SELECT * FROM npcs", "SELECT * FROM particles", "SELECT * FROM spells"]);
    expect((await particles.list()).map((particle) => particle.name)).toEqual(["cinder", "smoke"]);
    expect(held("npcs").map((entry) => entry.particles)).toEqual(["cinder", "smoke,cinder"]);
    expect(held("spells").map((spell) => spell.particles)).toEqual(["cinder", null]);
    expect(held("mounts")).toEqual(db.mounts);
    expect(held("mounts").map((mount) => mount.particles)).toEqual([null, "smoke, ember"]);
  });

  test("a reference the database refused, though it had applied it, is held as the database has it", async () => {
    cache.get("spells").unshift({ name: "plugin_nova", particles: "ember" });
    failing = /^UPDATE spells/;
    appliedAnyway = true;
    await expect(particles.rename("ember", "cinder")).rejects.toThrow("connection lost");
    failing = null;
    // The stored spell is as the database has it; the plugin's own, which the database never had, is as it was.
    expect(held("spells").map((spell) => [spell.name, spell.particles])).toEqual([["plugin_nova", "ember"], ["fire_bolt", "cinder"], ["frost_bolt", null]]);
    expect(held("mounts").map((mount) => mount.particles)).toEqual([null, "smoke, ember"]);
  });
});
