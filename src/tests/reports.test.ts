import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// ------------------------------------------------------------ fake database
// The statements the report system sends, run against an in-memory table, and
// the read the player system makes of an account. A statement it does not
// know is an error.

type Row = Record<string, any>;
let table: Row[];
let accounts: string[];
let nextId: number;
/** Every statement sent, in order. */
let queries: string[];
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null;
/** The refused statement was written all the same: its answer is what was lost. */
let lostAfterWriting: boolean;
/** Whether an INSERT's answer says which id the row was given. */
let answersWithId: boolean;

const COLUMNS = "id, reporter, target, category, details, chat_log, map, x, y, target_map, target_x, target_y, created_at, status, resolved_by, resolved_at, resolution";
const LOAD_OPEN = `SELECT ${COLUMNS} FROM reports WHERE status = 'open'`;
const LOAD_RESOLVED = `SELECT ${COLUMNS} FROM reports WHERE status = 'resolved' ORDER BY resolved_at DESC LIMIT ?`;
const INSERT = "INSERT INTO reports (reporter, target, category, details, chat_log, map, x, y, target_map, target_x, target_y, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')";
const RESOLVE = "UPDATE reports SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ? AND status = 'open'";
const ACCOUNT = /^SELECT .+ FROM accounts WHERE username = \?$/;

function run(sql: string, params: any[]): any {
  if (sql === LOAD_OPEN) return table.filter((row) => row.status === "open").map((row) => ({ ...row }));
  if (sql === LOAD_RESOLVED) {
    return table.filter((row) => row.status === "resolved").sort((a, b) => b.resolved_at - a.resolved_at).slice(0, params[0]).map((row) => ({ ...row }));
  }
  if (ACCOUNT.test(sql)) return accounts.filter((name) => name === params[0]).map((username, index) => ({ id: index + 1, username }));
  if (sql.startsWith("SELECT ") && !sql.includes("reports")) return [];
  if (sql === INSERT) {
    const [reporter, target, category, details, chat_log, map, x, y, target_map, target_x, target_y, created_at] = params;
    const row = { id: nextId++, reporter, target, category, details, chat_log, map, x, y, target_map, target_x, target_y, created_at, status: "open", resolved_by: null, resolved_at: null, resolution: null };
    table.push(row);
    return answersWithId ? { affectedRows: 1, lastInsertRowid: row.id } : { affectedRows: 1 };
  }
  if (sql === RESOLVE) {
    const [resolved_by, resolved_at, resolution, id] = params;
    const row = table.find((entry) => entry.id === id && entry.status === "open");
    if (row) Object.assign(row, { status: "resolved", resolved_by, resolved_at, resolution });
    return { affectedRows: row ? 1 : 0 };
  }
  throw new Error(`The fake database does not understand: ${sql}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    queries.push(text);
    if (failing?.test(text)) {
      if (lostAfterWriting) run(text, params);
      throw new Error("connection lost");
    }
    return run(text, params);
  },
}));

const datacache = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
const { default: reports, REPORTS_PER_HOUR, RESOLVED_KEPT, DETAILS_MAX } = await import("../systems/reports");

const NOON = 1_800_000_000_000;
const MINUTE = 60_000;
const line = (text: string, at = NOON) => ({ at, channel: "say" as const, text });
const filing = (over: Row = {}) => ({
  reporter: "hero", target: "troll", category: "harassment", details: "keeps following me",
  lines: [line("you again")], reporterAt: { map: "overworld", x: 10, y: 20 }, targetAt: { map: "overworld", x: 12, y: 21 }, ...over,
});
const writes = () => queries.filter((sql) => !sql.startsWith("SELECT"));

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
  accounts = ["hero", "ally", "rogue", "troll", "boss", ...Array.from({ length: 10 }, (_, index) => `pest${index}`)];
  nextId = 1;
  queries = [];
  failing = null;
  lostAfterWriting = false;
  answersWithId = true;
  await datacache.clearCaches();
});

describe("a report", () => {
  test("is filed with what was said, where both players were and the lines attached", async () => {
    const filed = await reports.file(filing({ reporter: "Hero", target: "TROLL" }), NOON);

    expect(filed).toEqual({
      ok: true,
      report: {
        id: 1, reporter: "hero", target: "troll", category: "harassment", details: "keeps following me",
        chat_log: [line("you again")], map: "overworld", x: 10, y: 20, target_map: "overworld", target_x: 12, target_y: 21,
        created_at: NOON, status: "open", resolved_by: null, resolved_at: null, resolution: null,
      },
    });
    expect(table).toHaveLength(1);
    expect(JSON.parse(table[0].chat_log)).toEqual([line("you again")]);
    expect(await reports.get(1)).toEqual((filed as any).report);
  });

  test("of a player who is offline has no place for them, and details are not needed", async () => {
    const filed = await reports.file(filing({ details: "   ", targetAt: null, lines: [] }), NOON) as any;

    expect(filed.report).toMatchObject({ details: null, chat_log: [], target_map: null, target_x: null, target_y: null });
  });

  test("keeps of each line when it was said, where and what: not who else it reached", async () => {
    const heard = { ...line("you again"), to: ["hero", "ally"], muted: false };

    const filed = await reports.file(filing({ lines: [heard] }), NOON) as any;

    expect(filed.report.chat_log).toEqual([line("you again")]);
    expect(JSON.parse(table[0].chat_log)).toEqual([line("you again")]);
  });

  test("keeps no more of the details than their limit", async () => {
    const filed = await reports.file(filing({ details: "x".repeat(DETAILS_MAX + 50) }), NOON) as any;

    expect(filed.report.details).toHaveLength(DETAILS_MAX);
  });

  test("is refused of oneself, and under a category there is not", async () => {
    expect(await reports.file(filing({ target: "Hero" }), NOON)).toEqual({ ok: false, code: "self" });
    expect(await reports.file(filing({ category: "boring" }), NOON)).toEqual({ ok: false, code: "category" });
    expect(table).toEqual([]);
  });

  test("of the same player is not filed twice while the first is open, and is again once it is resolved", async () => {
    await reports.file(filing(), NOON);

    expect(await reports.file(filing({ category: "spam" }), NOON + MINUTE)).toEqual({ ok: false, code: "duplicate" });
    expect(table).toHaveLength(1);

    await reports.resolve(1, "boss", "warned", NOON + 2 * MINUTE);
    expect((await reports.file(filing(), NOON + 3 * MINUTE)).ok).toBe(true);
  });

  test("is refused once a player has filed their share for the hour, and taken again an hour on", async () => {
    for (let index = 0; index < REPORTS_PER_HOUR; index++) {
      expect((await reports.file(filing({ target: `pest${index}` }), NOON + index * MINUTE)).ok).toBe(true);
    }

    expect(await reports.file(filing(), NOON + 30 * MINUTE)).toEqual({ ok: false, code: "limit" });
    // Another player's share is their own.
    expect((await reports.file(filing({ reporter: "ally" }), NOON + 30 * MINUTE)).ok).toBe(true);
    expect((await reports.file(filing(), NOON + 61 * MINUTE)).ok).toBe(true);
  });

  test("filed twice at the same moment is filed once", async () => {
    const filed = await Promise.all([reports.file(filing(), NOON), reports.file(filing(), NOON)]);

    expect(filed.map((result) => result.ok).sort()).toEqual([false, true]);
    expect(table).toHaveLength(1);
  });
});

describe("the reports held", () => {
  test("are read once: the open ones, and the latest that were resolved", async () => {
    table.push(
      { id: 1, reporter: "hero", target: "troll", category: "spam", details: null, chat_log: JSON.stringify([line("buy gold")]), map: "overworld", x: 1, y: 2, target_map: null, target_x: null, target_y: null, created_at: NOON, status: "open", resolved_by: null, resolved_at: null, resolution: null },
      { id: 2, reporter: "ally", target: "troll", category: "other", details: "rude", chat_log: "[]", map: null, x: null, y: null, target_map: null, target_x: null, target_y: null, created_at: NOON - MINUTE, status: "resolved", resolved_by: "boss", resolved_at: NOON, resolution: "muted" },
    );

    expect((await reports.open()).map((report) => report.id)).toEqual([1]);
    expect((await reports.open())[0].chat_log).toEqual([line("buy gold")]);
    expect((await reports.resolved()).map((report) => report.id)).toEqual([2]);
    expect(await reports.get(2)).toMatchObject({ resolved_by: "boss", resolution: "muted" });
    expect(await reports.get(99)).toBeNull();
    expect(queries).toEqual([LOAD_OPEN, LOAD_RESOLVED]);
  });

  test("list the open ones newest first, and count them for a player", async () => {
    await reports.file(filing(), NOON);
    await reports.file(filing({ reporter: "ally" }), NOON + MINUTE);
    await reports.file(filing({ reporter: "rogue", target: "pest1" }), NOON + 2 * MINUTE);

    expect((await reports.open()).map((report) => [report.reporter, report.target])).toEqual([["rogue", "pest1"], ["ally", "troll"], ["hero", "troll"]]);
    expect(await reports.openAgainst("Troll")).toBe(2);
    expect(await reports.openAgainst("hero")).toBe(0);
  });

  test("a report resolved says by whom, when and how, and is open no longer", async () => {
    await reports.file(filing(), NOON);

    const resolved = await reports.resolve(1, "Boss", "  muted for a day  ", NOON + MINUTE);

    expect(resolved).toMatchObject({ id: 1, status: "resolved", resolved_by: "boss", resolved_at: NOON + MINUTE, resolution: "muted for a day" });
    expect(table[0]).toMatchObject({ status: "resolved", resolved_by: "boss", resolution: "muted for a day" });
    expect(await reports.open()).toEqual([]);
    expect((await reports.resolved()).map((report) => report.id)).toEqual([1]);
  });

  test("a report that is not open cannot be resolved", async () => {
    await reports.file(filing(), NOON);
    await reports.resolve(1, "boss", null, NOON + MINUTE);
    queries = [];

    expect(await reports.resolve(1, "mod", "again", NOON + 2 * MINUTE)).toBeNull();
    expect(await reports.resolve(42, "mod", null, NOON)).toBeNull();
    expect(writes()).toEqual([]);
    expect(table[0].resolved_by).toBe("boss");
  });

  test("only the latest resolved ones are held", async () => {
    for (let index = 0; index < RESOLVED_KEPT + 3; index++) {
      await reports.file(filing({ reporter: `r${index}` }), NOON + index * 61 * MINUTE);
      await reports.resolve(index + 1, "boss", null, NOON + index * 61 * MINUTE + 1);
    }

    const held = await reports.resolved();
    expect(held).toHaveLength(RESOLVED_KEPT);
    expect(held[0].id).toBe(RESOLVED_KEPT + 3);
    expect(held.at(-1)!.id).toBe(4);
    expect(table).toHaveLength(RESOLVED_KEPT + 3);
  });

  test("an INSERT answered without an id: the report is found by reading the table again", async () => {
    answersWithId = false;

    const filed = await reports.file(filing(), NOON) as any;

    expect(filed.report.id).toBe(1);
    expect((await reports.open()).map((report) => report.id)).toEqual([1]);
  });

  for (const made of [false, true]) {
    test(`a report the database ${made ? "took but never answered" : "refused"} is the caller's error, and the table is read again`, async () => {
      await reports.open();
      failing = /^INSERT INTO reports/;
      lostAfterWriting = made;

      await expect(reports.file(filing(), NOON)).rejects.toThrow("connection lost");
      failing = null;

      expect(await reports.open()).toHaveLength(made ? 1 : 0);
    });
  }
});
