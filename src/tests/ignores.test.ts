import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// ------------------------------------------------------------ fake database
// The statements the ignore system sends, run against an in-memory table, and
// the read the player system makes of an account. A statement it does not
// know is an error, so a read that is not a cache filling itself fails the
// test that made it.

type Row = Record<string, any>;
let table: Row[];
let accounts: string[];
/** The accounts that are admins. */
let admins: string[];
/** Every statement sent, in order. */
let queries: string[];
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null;
/** The refused statement was written all the same: its answer is what was lost. */
let lostAfterWriting: boolean;

const LOAD = "SELECT ignored FROM ignores WHERE username = ?";
const INSERT = "INSERT INTO ignores (username, ignored, created_at) VALUES (?, ?, ?)";
const DELETE = "DELETE FROM ignores WHERE username = ? AND ignored = ?";
const ACCOUNT = /^SELECT .+ FROM accounts WHERE username = \?$/;

function run(sql: string, params: any[]): any {
  if (sql === LOAD) return table.filter((row) => row.username === params[0]).map((row) => ({ ignored: row.ignored }));
  if (ACCOUNT.test(sql)) return accounts.filter((name) => name === params[0]).map((username, index) => ({ id: index + 1, username, role: admins.includes(username) ? 1 : 0 }));
  // A login has every system's player cache fill itself: the others' tables are not this file's, and hold nothing.
  if (sql.startsWith("SELECT ") && !sql.includes("ignores")) return [];
  if (sql === INSERT) {
    const [username, ignored, created_at] = params;
    if (table.some((row) => row.username === username && row.ignored === ignored)) throw new Error("Duplicate entry");
    table.push({ username, ignored, created_at });
    return { affectedRows: 1 };
  }
  if (sql === DELETE) {
    const before = table.length;
    table = table.filter((row) => !(row.username === params[0] && row.ignored === params[1]));
    return { affectedRows: before - table.length };
  }
  throw new Error(`The fake database does not understand: ${sql}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    queries.push(sql);
    if (failing?.test(sql)) {
      if (lostAfterWriting) run(sql, params);
      throw new Error("connection lost");
    }
    return run(sql, params);
  },
}));

const datacache = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
const { default: ignores, IGNORE_LIMIT } = await import("../systems/ignores");

const ignoreReads = () => queries.filter((sql) => sql === LOAD);
const writes = () => queries.filter((sql) => !sql.startsWith("SELECT"));
const ignoredBy = (username: string) => table.filter((row) => row.username === username).map((row) => row.ignored);

let logged: Array<ReturnType<typeof spyOn>>;
beforeAll(() => {
  logged = [spyOn(log, "info"), spyOn(log, "warn"), spyOn(log, "error")].map((spy) => spy.mockImplementation(() => {}));
});
afterAll(async () => {
  for (const spy of logged) spy.mockRestore();
  await datacache.clearCaches();
});

beforeEach(async () => {
  table = [];
  accounts = ["hero", "ally", "rogue", "troll", "boss"];
  admins = ["boss"];
  queries = [];
  failing = null;
  lostAfterWriting = false;
  await datacache.clearCaches();
});

describe("ignores", () => {
  test("a player's list is read once, and an empty one is an answer too", async () => {
    table.push({ username: "hero", ignored: "troll", created_at: 1 });

    expect(await ignores.list("Hero")).toEqual(["troll"]);
    expect(await ignores.list("hero")).toEqual(["troll"]);
    expect(await ignores.list("ally")).toEqual([]);
    expect(await ignores.list("ally")).toEqual([]);
    expect(ignoreReads()).toHaveLength(2);
  });

  test("what a caller does to the list it was given changes nothing held", async () => {
    table.push({ username: "hero", ignored: "troll", created_at: 1 });

    (await ignores.list("hero")).push("ally");

    expect(await ignores.list("hero")).toEqual(["troll"]);
  });

  test("a player ignored is on the list and in the table, by the name the account has", async () => {
    expect(await ignores.add("Hero", "TROLL", 5000)).toBe("added");

    expect(table).toEqual([{ username: "hero", ignored: "troll", created_at: 5000 }]);
    expect(await ignores.list("hero")).toEqual(["troll"]);
    expect(await ignores.isIgnoring("hero", "Troll")).toBe(true);
    expect(await ignores.isIgnoring("troll", "hero")).toBe(false);
  });

  test("ignoring someone twice changes nothing the second time", async () => {
    await ignores.add("hero", "troll");
    queries = [];

    expect(await ignores.add("hero", "Troll")).toBe("already");
    expect(writes()).toEqual([]);
    expect(ignoredBy("hero")).toEqual(["troll"]);
  });

  test("a player cannot ignore themselves, or a name no account has", async () => {
    expect(await ignores.add("hero", "Hero")).toBe("self");
    expect(await ignores.add("hero", "nobody")).toBe("unknown");
    expect(await ignores.add("hero", "")).toBe("unknown");
    expect(table).toEqual([]);
  });

  test("a player cannot ignore an admin, and an admin cannot ignore anyone", async () => {
    expect(await ignores.add("hero", "Boss")).toBe("admin");
    expect(await ignores.add("boss", "troll")).toBe("staff");
    expect(table).toEqual([]);
  });

  test("an admin is heard by a player who ignored them before they were one", async () => {
    table.push({ username: "hero", ignored: "boss", created_at: 1 });

    expect(await ignores.blocks("hero", "boss")).toBe(false);
    expect(await ignores.notIgnoring("boss", ["hero", "ally"])).toEqual(["hero", "ally"]);
  });

  test("a list an admin still has from before they were one holds nothing back", async () => {
    table.push({ username: "boss", ignored: "troll", created_at: 1 });

    expect(await ignores.blocks("boss", "troll")).toBe(false);
    expect(await ignores.notIgnoring("troll", ["boss"])).toEqual(["boss"]);
    // It is still theirs to see and to clear.
    expect(await ignores.list("boss")).toEqual(["troll"]);
    expect(await ignores.remove("boss", "troll")).toBe(true);
  });

  test("between two players, the one ignored is held back from the one who ignores", async () => {
    await ignores.add("hero", "troll");

    expect(await ignores.blocks("Hero", "Troll")).toBe(true);
    expect(await ignores.blocks("troll", "hero")).toBe(false);
  });

  test("a full list takes no more", async () => {
    accounts.push(...Array.from({ length: IGNORE_LIMIT }, (_, index) => `pest${index}`));
    table.push(...Array.from({ length: IGNORE_LIMIT }, (_, index) => ({ username: "hero", ignored: `pest${index}`, created_at: 1 })));

    expect(await ignores.add("hero", "troll")).toBe("full");
    expect(ignoredBy("hero")).toHaveLength(IGNORE_LIMIT);
  });

  test("a player no longer ignored is off the list, and one who never was changes nothing", async () => {
    await ignores.add("hero", "troll");
    await ignores.add("hero", "rogue");
    queries = [];

    expect(await ignores.remove("Hero", "Troll")).toBe(true);
    expect(await ignores.list("hero")).toEqual(["rogue"]);
    expect(ignoredBy("hero")).toEqual(["rogue"]);

    expect(await ignores.remove("hero", "troll")).toBe(false);
    expect(await ignores.remove("hero", "ally")).toBe(false);
    expect(writes()).toEqual([DELETE]);
  });

  test("of the players a line would go to, the ones who ignore its sender are left out", async () => {
    await ignores.add("ally", "troll");
    await ignores.add("rogue", "hero");

    expect(await ignores.notIgnoring("troll", ["hero", "Ally", "rogue"])).toEqual(["hero", "rogue"]);
    expect(await ignores.notIgnoring("hero", ["ally", "rogue", "troll"])).toEqual(["ally", "troll"]);
    expect(await ignores.notIgnoring("ally", [])).toEqual([]);
  });

  test("players ignored at the same moment are all on the list", async () => {
    expect(await Promise.all([ignores.add("hero", "troll"), ignores.add("hero", "rogue"), ignores.add("hero", "ally")])).toEqual(["added", "added", "added"]);

    expect(await ignores.list("hero")).toEqual(["troll", "rogue", "ally"]);
    expect(ignoredBy("hero")).toEqual(["troll", "rogue", "ally"]);
  });

  for (const made of [false, true]) {
    test(`a write the database ${made ? "made but never answered" : "refused"} has the list read again`, async () => {
      await ignores.list("hero");
      failing = /^INSERT INTO ignores/;
      lostAfterWriting = made;

      await expect(ignores.add("hero", "troll")).rejects.toThrow("connection lost");
      failing = null;
      queries = [];

      expect(await ignores.list("hero")).toEqual(made ? ["troll"] : []);
      expect(ignoreReads()).toHaveLength(1);
    });
  }
});
