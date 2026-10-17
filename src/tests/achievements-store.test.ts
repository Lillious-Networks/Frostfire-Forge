import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sqlWrapper } from "../controllers/sqlescape";
import { databaseModule } from "./setup";
import type { AchievementInput } from "../systems/achievements/types";

// The achievements and player_achievements tables, held here.
type Row = Record<string, any>;
let achievements: Row[] = [];
let progress: Row[] = [];
let nextId = 1;
/** Progress statements written. */
let writes = 0;
/** Reads of one player's rows. */
let rowReads = 0;
let failing: ((sql: string) => boolean) | null = null;
/** When set, a progress statement waits for it before it is applied. */
let gate: Promise<void> | null = null;

const DEF_SELECT = "SELECT id, name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled FROM achievements";
const ROWS_SELECT = "SELECT achievement_id, progress, completed_at FROM player_achievements WHERE username = ?";
const PROGRESS = "INSERT INTO player_achievements (username, achievement_id, progress) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE progress = CASE WHEN completed_at IS NULL AND ? > progress THEN ? ELSE progress END";
const ROW = "INSERT IGNORE INTO player_achievements (username, achievement_id, progress, completed_at) VALUES (?, ?, 0, NULL)";
const COMPLETED = "UPDATE player_achievements SET progress = ?, completed_at = ? WHERE username = ? AND achievement_id = ? AND completed_at IS NULL";

function upsert(username: string, id: number, fields: Row) {
  const row = progress.find((r) => r.username === username && r.achievement_id === id);
  if (row) Object.assign(row, fields);
  else progress.push({ username, achievement_id: id, progress: 0, completed_at: null, ...fields });
  return { affectedRows: row ? 2 : 1 };
}

function run(sql: string, values: any[] = []): any {
  const text = sql.replace(/\s+/g, " ").trim();
  if (failing?.(text)) throw new Error("database gone");
  if (text.startsWith("CREATE ") || text.includes("permission_types")) return [];
  if (text === DEF_SELECT) return achievements.map((r) => ({ ...r }));
  if (text === ROWS_SELECT) {
    rowReads++;
    return progress.filter((r) => r.username === values[0]).map(({ achievement_id, progress, completed_at }) => ({ achievement_id, progress, completed_at }));
  }
  if (text === PROGRESS) {
    writes++;
    // progress = CASE WHEN completed_at IS NULL AND ? > progress THEN ? ELSE progress END
    const held = progress.find((r) => r.username === values[0] && r.achievement_id === values[1]);
    if (!held) return upsert(values[0], values[1], { progress: values[2] });
    return upsert(values[0], values[1], held.completed_at === null && values[3] > held.progress ? { progress: values[4] } : {});
  }
  if (text === ROW) {
    const held = progress.find((r) => r.username === values[0] && r.achievement_id === values[1]);
    return held ? { affectedRows: 0 } : upsert(values[0], values[1], {});
  }
  if (text === COMPLETED) {
    // only a row that is not completed yet
    const held = progress.find((r) => r.username === values[2] && r.achievement_id === values[3] && r.completed_at === null);
    if (!held) return { affectedRows: 0 };
    Object.assign(held, { progress: values[0], completed_at: values[1] });
    return { affectedRows: 1 };
  }
  if (text.startsWith("INSERT INTO achievements")) {
    const [name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled] = values;
    if (achievements.some((r) => String(r.name).toLowerCase() === String(name).toLowerCase())) throw new Error("Duplicate entry for key 'name'");
    const id = nextId++;
    achievements.push({ id, name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled });
    return { lastInsertRowid: id, affectedRows: 1 };
  }
  if (text.startsWith("UPDATE achievements SET")) {
    const id = values[values.length - 1];
    const row = achievements.find((r) => r.id === id);
    if (!row) return { affectedRows: 0 };
    const [name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled] = values;
    Object.assign(row, { name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled });
    return { affectedRows: 1 };
  }
  if (text === "DELETE FROM player_achievements WHERE achievement_id = ? AND completed_at IS NULL") {
    progress = progress.filter((r) => !(r.achievement_id === values[0] && r.completed_at === null));
    return { affectedRows: 1 };
  }
  if (text === "DELETE FROM player_achievements WHERE achievement_id = ?") {
    progress = progress.filter((r) => r.achievement_id !== values[0]);
    return { affectedRows: 1 };
  }
  if (text === "DELETE FROM achievements WHERE id = ?") {
    achievements = achievements.filter((r) => r.id !== values[0]);
    return { affectedRows: 1 };
  }
  // a read of another system's table, by a cache another test file left behind
  if (text.startsWith("SELECT")) return [];
  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, values: any[] = []) => {
    if (gate && sql.startsWith("INSERT INTO player_achievements (username, achievement_id, progress) ")) await gate;
    return run(sql, values);
  },
}));

const store = await import("../systems/achievements/store");
const { transaction } = await import("../controllers/sqldatabase");
const { clearCaches, refreshPlayer, reloadTable } = await import("../services/datacache");
const { default: log } = await import("../modules/logger");

const input = (): AchievementInput => ({
  name: "Wolf Slayer", description: "Slay 10 wolves.", icon: "wolf", type: "creature_kill", target: "7", count: 10,
  reward_item: "Copper Ore", reward_quantity: 3, reward_mount: null, enabled: true,
});

let spies: Array<ReturnType<typeof spyOn>> = [];
beforeAll(async () => {
  spies = [spyOn(log, "warn").mockImplementation(() => {}), spyOn(log, "error").mockImplementation(() => {})];
  expect(await store.ensureAchievementSchema()).toBe(true);
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

beforeEach(async () => {
  achievements = [];
  progress = [];
  nextId = 1;
  writes = 0;
  rowReads = 0;
  failing = null;
  gate = null;
  store.resetChanges();
  await clearCaches();
});

describe("definitions", () => {
  test("are read from the table: numbers as numbers, empty text as none, unknown types left out", async () => {
    achievements.push(
      { id: 2, name: "Pelts", description: "Loot pelts.", icon: "", type: "loot", target: "Wolf Pelt", count: "5", reward_item: null, reward_quantity: 0, reward_mount: "", enabled: 1 },
      { id: 1, name: "Kills", description: "", icon: "sword", type: "creature_kill", target: null, count: 10, reward_item: "Copper Ore", reward_quantity: 3, reward_mount: null, enabled: 0 },
      { id: 3, name: "Dance", description: "", icon: null, type: "dance", target: null, count: 1, reward_item: null, reward_quantity: 1, reward_mount: null, enabled: 1 },
    );
    await reloadTable("achievements");
    expect(await store.definitions()).toEqual([
      { id: 1, name: "Kills", description: "", icon: "sword", type: "creature_kill", target: null, count: 10, reward_item: "Copper Ore", reward_quantity: 3, reward_mount: null, enabled: false },
      { id: 2, name: "Pelts", description: "Loot pelts.", icon: null, type: "loot", target: "Wolf Pelt", count: 5, reward_item: null, reward_quantity: 1, reward_mount: null, enabled: true },
    ]);
  });

  test("a save is written to the table, then to the cache; a save with its id changes the same row", async () => {
    const saved = await store.saveDefinition(null, input());
    expect(saved).toMatchObject({ ok: true, def: { id: 1, name: "Wolf Slayer", target: "7" } });
    const again = await store.saveDefinition(1, { ...input(), count: 20 });
    expect(again.ok).toBe(true);
    expect(achievements).toHaveLength(1);
    expect(achievements[0]!.count).toBe(20);
    expect((await store.definitions()).map((d) => d.count)).toEqual([20]);
  });

  test("changing what counts starts partial progress again, held or waiting; completed rows stay", async () => {
    await store.saveDefinition(null, input());
    const done = "2026-10-17T12:00:00.000Z";
    progress.push(
      { username: "alice", achievement_id: 1, progress: 4, completed_at: null },
      { username: "bob", achievement_id: 1, progress: 10, completed_at: done },
    );
    expect(await store.rowsOf("alice")).toHaveLength(1);
    expect(await store.rowsOf("bob")).toHaveLength(1);
    store.markChanged("carol", 1, 2);
    store.markChanged("carol", 5, 3);
    const saved = await store.saveDefinition(1, { ...input(), type: "level", target: null });
    expect(saved).toMatchObject({ ok: true, reset: true, def: { type: "level", target: null } });
    expect(progress).toEqual([{ username: "bob", achievement_id: 1, progress: 10, completed_at: done }]);
    expect(await store.rowsOf("alice")).toEqual([]);
    expect(await store.rowsOf("bob")).toEqual([{ achievement_id: 1, progress: 10, completed_at: Date.parse(done) }]);
    expect([...store.changedOf("carol")]).toEqual([[5, 3]]);
    // a flush of nothing toward it writes nothing back
    await store.flushAll();
    expect(progress.filter((r) => r.achievement_id === 1).map((r) => r.username)).toEqual(["bob"]);
  });

  test("a new target starts it again too; a save that changes the name, the count or a target's case keeps progress", async () => {
    await store.saveDefinition(null, input());
    progress.push({ username: "alice", achievement_id: 1, progress: 4, completed_at: null });
    store.markChanged("alice", 1, 5);
    for (const over of [{ name: "Wolf Hunter" }, { count: 20 }, { description: "Slay wolves." }]) {
      expect(await store.saveDefinition(1, { ...input(), ...over })).toMatchObject({ ok: true, reset: false });
    }
    expect(progress).toEqual([{ username: "alice", achievement_id: 1, progress: 4, completed_at: null }]);
    expect(store.changedOf("alice").get(1)).toBe(5);
    expect(await store.saveDefinition(1, { ...input(), type: "gather", target: "Copper Ore" })).toMatchObject({ ok: true, reset: true });
    expect(await store.saveDefinition(1, { ...input(), type: "gather", target: "copper ore" })).toMatchObject({ ok: true, reset: false });
    expect(progress).toEqual([]);
    expect(store.changedOf("alice").size).toBe(0);
  });

  test("a delete takes every player's progress toward it, held or waiting to be written", async () => {
    await store.saveDefinition(null, input());
    progress.push({ username: "alice", achievement_id: 1, progress: 4, completed_at: null });
    expect(await store.rowsOf("alice")).toHaveLength(1);
    store.markChanged("bob", 1, 2);
    expect(await store.deleteDefinition(1)).toEqual({ ok: true });
    expect(achievements).toEqual([]);
    expect(progress).toEqual([]);
    expect(await store.rowsOf("alice")).toEqual([]);
    expect(store.changedOf("bob").size).toBe(0);
    expect(await store.definitions()).toEqual([]);
  });
});

describe("player rows", () => {
  test("are read once per player, in any case, with the date as milliseconds", async () => {
    progress.push(
      { username: "alice", achievement_id: 1, progress: 10, completed_at: "2026-10-17T12:00:00.000Z" },
      { username: "alice", achievement_id: 2, progress: 3, completed_at: null },
    );
    expect(await store.rowsOf("Alice")).toEqual([
      { achievement_id: 1, progress: 10, completed_at: Date.UTC(2026, 9, 17, 12) },
      { achievement_id: 2, progress: 3, completed_at: null },
    ]);
    await store.rowsOf("ALICE");
    expect(rowReads).toBe(1);
  });

  test("progress counted and not written yet is kept when the rows are read again (a quick relog)", async () => {
    progress.push({ username: "alice", achievement_id: 1, progress: 2, completed_at: null });
    store.markChanged("alice", 1, 5);
    store.markChanged("alice", 2, 1);
    await refreshPlayer("alice");
    expect(await store.rowsOf("alice")).toEqual([
      { achievement_id: 1, progress: 5, completed_at: null },
      { achievement_id: 2, progress: 1, completed_at: null },
    ]);
  });
});

describe("saving", () => {
  test("flush writes that player's changed progress and nothing else", async () => {
    store.markChanged("alice", 1, 3);
    store.markChanged("bob", 1, 7);
    await store.flush("Alice");
    expect(progress).toEqual([{ username: "alice", achievement_id: 1, progress: 3, completed_at: null }]);
    expect(writes).toBe(1);
    await store.flush("alice");
    expect(writes).toBe(1);
    expect(store.changedOf("bob").get(1)).toBe(7);
  });

  test("flushAll writes every player's changes", async () => {
    store.markChanged("alice", 1, 3);
    store.markChanged("bob", 2, 7);
    await store.flushAll();
    expect(progress.map((r) => [r.username, r.achievement_id, r.progress])).toEqual([["alice", 1, 3], ["bob", 2, 7]]);
    expect(store.changedOf("alice").size + store.changedOf("bob").size).toBe(0);
  });

  test("a write that fails keeps the changes for the next save", async () => {
    store.markChanged("alice", 1, 3);
    failing = (sql) => sql.startsWith("INSERT INTO player_achievements");
    await store.flush("alice");
    expect(progress).toEqual([]);
    expect(store.changedOf("alice").get(1)).toBe(3);
    failing = null;
    await store.flush("alice");
    expect(progress).toHaveLength(1);
  });

  test("a completion makes the row if needed and dates it", async () => {
    await transaction(store.completionStatements("Alice", 4, 10, Date.UTC(2026, 9, 17, 12)));
    expect(progress).toEqual([{ username: "alice", achievement_id: 4, progress: 10, completed_at: "2026-10-17T12:00:00.000Z" }]);
  });
});

describe("completed rows", () => {
  const done = "2026-10-17T12:00:00.000Z";

  test("stale progress flushed over a completed row changes neither its progress nor its date", async () => {
    progress.push({ username: "alice", achievement_id: 1, progress: 10, completed_at: done });
    store.markChanged("alice", 1, 4);
    await store.flush("alice");
    expect(writes).toBe(1);
    expect(progress).toEqual([{ username: "alice", achievement_id: 1, progress: 10, completed_at: done }]);
  });

  test("a flush of a lower value over a higher one stored keeps the higher one (a relog read before a write landed)", async () => {
    progress.push({ username: "alice", achievement_id: 1, progress: 7, completed_at: null });
    store.markChanged("alice", 1, 4);
    await store.flush("alice");
    expect(writes).toBe(1);
    expect(progress).toEqual([{ username: "alice", achievement_id: 1, progress: 7, completed_at: null }]);
    store.markChanged("alice", 1, 9);
    await store.flush("alice");
    expect(progress).toEqual([{ username: "alice", achievement_id: 1, progress: 9, completed_at: null }]);
  });

  test("on SQLite the progress write is translated and never lowers progress or touches a completed row", () => {
    const db = new Database(":memory:");
    try {
      for (const sql of store.ACHIEVEMENT_TABLES.sqlite) db.run(sql);
      const write = (username: string, id: number, value: number) => db.run(sqlWrapper(PROGRESS, [username, id, value, value, value], "sqlite"));
      expect(sqlWrapper(PROGRESS, ["alice", 1, 4, 4, 4], "sqlite")).toBe(
        "INSERT INTO player_achievements (username, achievement_id, progress) VALUES ('alice', 1, 4) ON CONFLICT DO UPDATE SET progress = CASE WHEN completed_at IS NULL AND 4 > progress THEN 4 ELSE progress END",
      );
      write("alice", 1, 4);
      write("alice", 1, 2);
      write("alice", 1, 6);
      db.run("INSERT INTO player_achievements (username, achievement_id, progress, completed_at) VALUES ('alice', 2, 10, '2026-10-17T12:00:00.000Z')");
      write("alice", 2, 12);
      expect(db.query("SELECT achievement_id, progress, completed_at FROM player_achievements ORDER BY achievement_id").all()).toEqual([
        { achievement_id: 1, progress: 6, completed_at: null },
        { achievement_id: 2, progress: 10, completed_at: "2026-10-17T12:00:00.000Z" },
      ]);
    } finally {
      db.close();
    }
  });

  test("completing twice is refused and keeps the first date", async () => {
    await transaction(store.completionStatements("alice", 4, 10, Date.UTC(2026, 9, 17, 12)));
    await expect(transaction(store.completionStatements("alice", 4, 10, Date.UTC(2026, 9, 18, 8)))).rejects.toThrow();
    expect(progress).toEqual([{ username: "alice", achievement_id: 4, progress: 10, completed_at: done }]);
  });
});

describe("saving while a write is waiting", () => {
  test("progress counted while a flush's write is awaited is written by the next flush", async () => {
    let open!: () => void;
    gate = new Promise<void>((resolve) => { open = resolve; });
    store.markChanged("alice", 1, 3);
    const first = store.flush("alice");
    // let the flush reach its write, which waits at the gate
    await new Promise((resolve) => setTimeout(resolve, 10));
    store.markChanged("alice", 1, 5);
    store.markChanged("alice", 2, 1);
    open();
    await first;
    expect(progress.map((r) => [r.achievement_id, r.progress])).toEqual([[1, 3]]);
    expect([...store.changedOf("alice")]).toEqual([[1, 5], [2, 1]]);
    gate = null;
    await store.flush("alice");
    expect(progress.map((r) => [r.achievement_id, r.progress])).toEqual([[1, 5], [2, 1]]);
    expect(store.changedOf("alice").size).toBe(0);
  });
});

describe("missing tables", () => {
  test("leave achievements off: nothing is read and nothing is saved", async () => {
    failing = (sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS player_achievements");
    expect(await store.ensureAchievementSchema()).toBe(false);
    expect(store.isReady()).toBe(false);
    expect(await store.definitions()).toEqual([]);
    expect((await store.saveDefinition(null, input())).ok).toBe(false);
    failing = null;
    expect(await store.ensureAchievementSchema()).toBe(true);
  });
});
