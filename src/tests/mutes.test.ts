import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// ------------------------------------------------------------ fake database
// The statements the mute system sends, run against an in-memory table. A
// statement it does not know is an error, so a read that is not the cache
// filling itself fails the test that made it.

type Row = Record<string, any>;
let table: Row[];
/** Every statement sent, in order. */
let queries: string[];
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null;
/** The refused statement was written all the same: its answer is what was lost. */
let lostAfterWriting: boolean;

const LOAD = "SELECT username, muted_by, reason, created_at, expires_at FROM mutes";
const DELETE = "DELETE FROM mutes WHERE username = ?";
const INSERT = "INSERT INTO mutes (username, muted_by, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?)";

function run(sql: string, params: any[]): any {
  if (sql === LOAD) return table.map((row) => ({ ...row }));
  if (sql === DELETE) {
    const before = table.length;
    table = table.filter((row) => row.username !== params[0]);
    return { affectedRows: before - table.length };
  }
  if (sql === INSERT) {
    const [username, muted_by, reason, created_at, expires_at] = params;
    if (table.some((row) => row.username === username)) throw new Error(`Duplicate entry '${username}'`);
    table.push({ username, muted_by, reason, created_at, expires_at });
    return { affectedRows: 1 };
  }
  throw new Error(`The fake database does not understand: ${sql}`);
}

async function database(sql: string, params: any[] = []): Promise<any> {
  queries.push(sql);
  if (failing?.test(sql)) {
    if (lostAfterWriting) run(sql, params);
    throw new Error("connection lost");
  }
  return run(sql, params);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: database,
  // All of its statements or none: one that is refused puts the table back. One written with its
  // answer lost stands for a transaction kept whole and never answered.
  transaction: async (statements: Array<{ sql: string; values?: any[] }>) => {
    const before = structuredClone(table);
    const results: any[] = [];
    let lost: unknown = null;
    for (const statement of statements) {
      try {
        results.push(await database(statement.sql, statement.values));
      } catch (error) {
        if (!lostAfterWriting) {
          table = before;
          throw error;
        }
        lost = error;
      }
    }
    if (lost) throw lost;
    return results;
  },
}));

const datacache = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
const { default: mutes, parseDuration } = await import("../systems/mutes");

const reads = () => queries.filter((sql) => sql.startsWith("SELECT"));
const writes = () => queries.filter((sql) => !sql.startsWith("SELECT"));

const MINUTE = 60_000;
const NOON = 1_800_000_000_000;

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
  queries = [];
  failing = null;
  lostAfterWriting = false;
  await datacache.clearCaches();
});

describe("a duration as a moderator types it", () => {
  test("is a number and a unit: seconds, minutes, hours, days or weeks", () => {
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("30m")).toBe(30 * MINUTE);
    expect(parseDuration("2h")).toBe(120 * MINUTE);
    expect(parseDuration("7d")).toBe(7 * 24 * 60 * MINUTE);
    expect(parseDuration("1w")).toBe(7 * 24 * 60 * MINUTE);
    expect(parseDuration("2H")).toBe(120 * MINUTE);
  });

  test("anything else is not a duration, so it can be read as the start of a reason", () => {
    for (const text of ["", "spam", "10", "m", "0m", "-5m", "1.5h", "5 m", "3mo", "10minutes", undefined, null]) {
      expect(parseDuration(text as any)).toBeNull();
    }
  });
});

describe("mutes", () => {
  test("a muted player is muted until the time given, and the table says by whom and why", async () => {
    const mute = await mutes.mute("Hero", "Boss", 30 * MINUTE, "spamming", NOON);

    expect(mute).toEqual({ username: "hero", muted_by: "boss", reason: "spamming", created_at: NOON, expires_at: NOON + 30 * MINUTE });
    expect(table).toEqual([mute]);
    expect(await mutes.get("HERO", NOON + MINUTE)).toEqual(mute);
    expect(await mutes.isMuted("hero", NOON + 29 * MINUTE)).toBe(true);
    expect(await mutes.isMuted("ally", NOON)).toBe(false);
  });

  test("without a duration the mute lasts until it is lifted", async () => {
    await mutes.mute("hero", "boss", null, null, NOON);

    expect(table[0]).toMatchObject({ reason: null, expires_at: null });
    expect(await mutes.isMuted("hero", NOON + 10 * 365 * 24 * 60 * MINUTE)).toBe(true);
  });

  test("whether a player is muted is answered from the rows held, read once", async () => {
    table.push({ username: "hero", muted_by: "boss", reason: null, created_at: NOON, expires_at: null });

    for (let line = 0; line < 5; line++) {
      expect(await mutes.isMuted("hero", NOON)).toBe(true);
      expect(await mutes.isMuted("ally", NOON)).toBe(false);
    }

    expect(queries).toEqual([LOAD]);
  });

  test("a mute whose time has passed is over, and its row is taken out", async () => {
    await mutes.mute("hero", "boss", 30 * MINUTE, null, NOON);
    queries = [];

    expect(await mutes.isMuted("hero", NOON + 30 * MINUTE)).toBe(false);
    expect(await mutes.get("hero", NOON + 31 * MINUTE)).toBeNull();

    expect(table).toEqual([]);
    expect(writes()).toEqual([DELETE]);
  });

  test("muting a muted player replaces the mute: there is one row", async () => {
    await mutes.mute("hero", "boss", 30 * MINUTE, "spamming", NOON);
    await mutes.mute("hero", "mod", null, "and again", NOON + MINUTE);

    expect(table).toEqual([{ username: "hero", muted_by: "mod", reason: "and again", created_at: NOON + MINUTE, expires_at: null }]);
    expect(await mutes.get("hero", NOON + 60 * MINUTE)).toMatchObject({ muted_by: "mod" });
  });

  test("a mute that is lifted is gone, and lifting one that is not there writes nothing", async () => {
    await mutes.mute("hero", "boss", null, null, NOON);
    queries = [];

    expect(await mutes.unmute("Hero", NOON)).toBe(true);
    expect(await mutes.isMuted("hero", NOON)).toBe(false);
    expect(table).toEqual([]);

    expect(await mutes.unmute("hero", NOON)).toBe(false);
    expect(await mutes.unmute("ally", NOON)).toBe(false);
    expect(writes()).toEqual([DELETE]);
  });

  test("lists the mutes that are in force, soonest over first and the lasting ones last", async () => {
    await mutes.mute("hero", "boss", 60 * MINUTE, null, NOON);
    await mutes.mute("ally", "boss", null, null, NOON);
    await mutes.mute("rogue", "boss", 10 * MINUTE, null, NOON);
    await mutes.mute("gone", "boss", MINUTE, null, NOON);

    expect((await mutes.list(NOON + 5 * MINUTE)).map((mute) => mute.username)).toEqual(["rogue", "hero", "ally"]);
  });

  test("a mute the database refused did not happen, and the table is read again", async () => {
    await mutes.isMuted("hero", NOON);
    failing = /^INSERT INTO mutes/;
    queries = [];

    await expect(mutes.mute("hero", "boss", null, null, NOON)).rejects.toThrow("connection lost");
    failing = null;

    expect(await mutes.isMuted("hero", NOON)).toBe(false);
    expect(table).toEqual([]);
    expect(reads()).toEqual([LOAD]);
  });

  test("a mute written though its answer was lost is in force", async () => {
    await mutes.isMuted("hero", NOON);
    failing = /^INSERT INTO mutes/;
    lostAfterWriting = true;

    await expect(mutes.mute("hero", "boss", null, null, NOON)).rejects.toThrow("connection lost");
    failing = null;

    expect(await mutes.isMuted("hero", NOON)).toBe(true);
  });

  test("a mute that could not be lifted is still in force", async () => {
    await mutes.mute("hero", "boss", null, null, NOON);
    failing = /^DELETE FROM mutes/;

    await expect(mutes.unmute("hero", NOON)).rejects.toThrow("connection lost");
    failing = null;

    expect(await mutes.isMuted("hero", NOON)).toBe(true);
  });
});
