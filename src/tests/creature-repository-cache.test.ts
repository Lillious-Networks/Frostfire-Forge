import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// The creature tables are read into the asset cache at startup and after each
// editor change (loadIntoCache). What the editor asks for in between is
// answered from what that read holds, not from the database.

type Row = Record<string, any>;
let db: Record<string, Row[]>;
let nextId: number;
let queries: string[] = [];
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null = null;
/** The refused statement was applied all the same, as one that timed out may have been. */
let appliedAnyway = false;

const TABLES = ["creature_templates", "creature_abilities", "creature_spawns", "creature_patrol_paths", "creature_link_groups", "creature_spawn_pools"];
const LOAD = TABLES.map((table) => `SELECT * FROM ${table}`);

function apply(sql: string, params: any[]): any {
  let m: RegExpExecArray | null;
  if ((m = /^SELECT \* FROM (\w+)$/.exec(sql)) && db[m[1]]) return db[m[1]].map((row) => ({ ...row }));
  if ((m = /^INSERT INTO (\w+) \((.+?)\) VALUES \(/.exec(sql)) && db[m[1]]) {
    const row: Row = { id: nextId++ };
    m[2].split(", ").forEach((column, i) => { row[column.replaceAll("`", "")] = params[i]; });
    db[m[1]].push(row);
    return { affectedRows: 1, lastInsertRowid: row.id };
  }
  if ((m = /^DELETE FROM (\w+) WHERE (\w+) = \?$/.exec(sql)) && db[m[1]]) {
    db[m[1]] = db[m[1]].filter((row) => row[m![2]] !== params[0]);
    return { affectedRows: 1 };
  }
  throw new Error(`The fake database does not understand: ${sql}`);
}

async function database(sql: string, params: any[] = []): Promise<any> {
  queries.push(sql);
  if (failing?.test(sql)) {
    if (appliedAnyway) apply(sql, params);
    throw new Error("connection lost");
  }
  return apply(sql, params);
}

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
const { default: repository, CACHE_KEYS } = await import("../systems/creatures/repository");

/** Every list the editor asks for. */
const lists = () => Promise.all([
  repository.listTemplates(), repository.listAbilities(), repository.listSpawns(),
  repository.listPatrolPaths(), repository.listLinkGroups(), repository.listSpawnPools(),
]);
const names = async () => (await repository.listLinkGroups()).map((group) => group.name);

let logged: Array<ReturnType<typeof spyOn>>;
beforeAll(() => {
  logged = [spyOn(log, "info"), spyOn(log, "warn"), spyOn(log, "error")].map((spy) => spy.mockImplementation(() => {}));
});
afterAll(() => {
  for (const spy of logged) spy.mockRestore();
});

beforeEach(() => {
  nextId = 100;
  failing = null;
  appliedAnyway = false;
  db = {
    creature_templates: [{ id: 1, name: "Wolf" }],
    creature_abilities: [{ id: 4, template_id: 1, spell_id: 2 }],
    creature_spawns: [{ id: 7, template_id: 1, map: "overworld", x: 10, y: 20 }],
    creature_patrol_paths: [{ id: 3, map: "overworld", loop: 1, points_json: "[]" }],
    creature_link_groups: [{ id: 5, name: "pack" }],
    creature_spawn_pools: [{ id: 6, max_active: 2 }],
  };
  queries = [];
});

describe("the creature tables", () => {
  // First: nothing in this process has loaded them yet.
  test("are read from the database by a script that runs without the server, each time it asks", async () => {
    expect(await names()).toEqual(["pack"]);
    await repository.saveLinkGroup({ name: "herd" });
    expect(await names()).toEqual(["pack", "herd"]);
    expect(queries.filter((sql) => sql.startsWith("SELECT"))).toEqual(["SELECT * FROM creature_link_groups", "SELECT * FROM creature_link_groups"]);
  });

  test("are read once by loadIntoCache, and every list is then answered from what it holds", async () => {
    await repository.loadIntoCache();
    expect([...queries].sort()).toEqual([...LOAD].sort());
    queries = [];

    const [templates, abilities, spawns, paths, groups, pools] = await lists();
    expect(templates.map((t) => [t.id, t.name])).toEqual([[1, "Wolf"]]);
    expect(abilities.map((a) => [a.id, a.template_id, a.spell_id])).toEqual([[4, 1, 2]]);
    expect(spawns.map((s) => [s.id, s.map, s.x, s.y])).toEqual([[7, "overworld", 10, 20]]);
    expect(paths.map((p) => p.id)).toEqual([3]);
    expect(groups).toEqual([{ id: 5, name: "pack" }]);
    expect(pools.map((p) => [p.id, p.max_active])).toEqual([[6, 2]]);
    await lists();
    expect(queries).toEqual([]);

    expect(templates).toEqual(cache.get(CACHE_KEYS.templates));
    // A list handed out is the caller's own: changing it changes nothing held.
    groups.push({ id: 99, name: "mine" });
    expect(await names()).toEqual(["pack"]);
  });

  test("hold a change once loadIntoCache has read it, as the editor does after each one", async () => {
    await repository.loadIntoCache();
    const id = await repository.saveLinkGroup({ name: "herd" });
    expect(id).toBe(100);
    // The write itself does not change what is held: the reload that follows it does.
    await repository.loadIntoCache();
    queries = [];
    expect(await names()).toEqual(["pack", "herd"]);
    await repository.deleteAbility(4);
    expect(queries).toEqual(["DELETE FROM creature_abilities WHERE id = ?"]);
  });

  for (const applied of [false, true]) {
    test(`a write the database refused${applied ? ", though it had applied it" : ""}: the tables are read again, and the lists are what they hold`, async () => {
      await repository.loadIntoCache();
      queries = [];
      failing = /^DELETE FROM creature_abilities WHERE id/;
      appliedAnyway = applied;
      await expect(repository.deleteAbility(4)).rejects.toThrow("connection lost");
      failing = null;

      expect(queries.filter((sql) => sql.startsWith("SELECT")).sort()).toEqual([...LOAD].sort());
      queries = [];
      expect((await repository.listAbilities()).map((a) => a.id)).toEqual(applied ? [] : [4]);
      expect(queries).toEqual([]);
    });
  }

  test("a write the database refused while the tables cannot be read either leaves the error the write's own", async () => {
    await repository.loadIntoCache();
    failing = /^(INSERT INTO|SELECT \* FROM) creature_/;
    await expect(repository.saveLinkGroup({ name: "herd" })).rejects.toThrow("connection lost");
    failing = null;
    // Nothing held was emptied, but it is in doubt: until the tables are loaded again, a list is read from the database.
    expect(cache.get(CACHE_KEYS.linkGroups)).toEqual([{ id: 5, name: "pack" }]);
    queries = [];
    expect(await names()).toEqual(["pack"]);
    expect(queries).toEqual(["SELECT * FROM creature_link_groups"]);

    await repository.loadIntoCache();
    queries = [];
    expect(await names()).toEqual(["pack"]);
    expect(queries).toEqual([]);
  });
});
