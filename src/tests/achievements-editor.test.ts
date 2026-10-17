import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule, standInFor } from "./setup";
import type { AchievementDef } from "../systems/achievements/types";

// The achievements table and the progress rows a delete takes, held here.
type Row = Record<string, any>;
let table: Row[] = [];
let progress: Row[] = [];
let nextId = 1;
let failing: ((sql: string) => boolean) | null = null;

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, values: any[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (failing?.(text)) throw new Error("database gone");
    if (text.startsWith("CREATE ") || text.includes("permission_types")) return [];
    if (text.startsWith("SELECT id, name, description")) return table.map((row) => ({ ...row }));
    if (text.startsWith("INSERT INTO achievements")) {
      const [name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled] = values;
      const id = nextId++;
      table.push({ id, name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled });
      return { lastInsertRowid: id, affectedRows: 1 };
    }
    if (text.startsWith("UPDATE achievements SET")) {
      const id = values[values.length - 1];
      const row = table.find((r) => r.id === id);
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
      table = table.filter((r) => r.id !== values[0]);
      return { affectedRows: 1 };
    }
    if (text.startsWith("SELECT")) return [];
    throw new Error(`The fake database does not understand: ${text}`);
  },
}));

const grants: Record<string, string> = { builder: "tools.achievement_editor" };
await standInFor("../systems/permissions", () => ({ default: { get: async (name: string) => grants[name] ?? "" } }));

const editor = await import("../systems/achievements/editor");
const store = await import("../systems/achievements/store");
const { reloadTable } = await import("../services/datacache");
const { default: log } = await import("../modules/logger");

const OPTIONS: import("../systems/achievements/editor").EditorOptions = {
  creatures: [{ value: "7", label: "Wolf (#7)" }],
  quests: [{ value: "12", label: "First Steps (#12)" }],
  items: [{ value: "Copper Ore", label: "Copper Ore", image: "icon:copper" }],
  mounts: [{ value: "Unicorn", label: "Unicorn", image: null }],
  maps: [{ value: "forest", label: "forest" }],
  spells: [{ value: "frost_bolt", label: "frost_bolt" }],
  icons: [{ value: "wolf", label: "wolf", image: "icon:wolf" }],
};
const world = { options: async () => OPTIONS };
const admin = { id: "a1", username: "builder" };
const input = (over: Row = {}) => ({
  name: "Wolf Slayer", description: "Slay 10 wolves.", icon: "wolf", type: "creature_kill", target: "7", count: 10,
  reward_item: "copper ore", reward_quantity: 3, reward_mount: "", enabled: true, ...over,
});

let spies: Array<ReturnType<typeof spyOn>> = [];
beforeAll(async () => {
  spies = [spyOn(log, "info").mockImplementation(() => {}), spyOn(log, "warn").mockImplementation(() => {})];
  expect(await store.ensureAchievementSchema()).toBe(true);
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

beforeEach(async () => {
  table = [];
  progress = [];
  nextId = 1;
  failing = null;
  await reloadTable("achievements");
});

describe("readAchievement", () => {
  test("accepts a whole achievement and writes its names as the lists do", () => {
    expect(editor.readAchievement(input(), OPTIONS, [])).toEqual({
      ok: true,
      achievement: {
        name: "Wolf Slayer", description: "Slay 10 wolves.", icon: "wolf", type: "creature_kill", target: "7", count: 10,
        reward_item: "Copper Ore", reward_quantity: 3, reward_mount: null, enabled: true,
      },
    });
  });

  test("a type without a target drops the one sent", () => {
    const read = editor.readAchievement(input({ type: "death", target: "7" }), OPTIONS, []);
    expect(read.ok && read.achievement.target).toBeNull();
  });

  test("an optional target left empty counts any", () => {
    const read = editor.readAchievement(input({ target: "" }), OPTIONS, []);
    expect(read.ok && read.achievement.target).toBeNull();
  });

  const wrong: Array<[string, Row, string]> = [
    ["no name", { name: "  " }, "name"],
    ["an unknown type", { type: "dance" }, "type"],
    ["a creature that does not exist", { target: "99" }, "target"],
    ["a map visit without a map", { type: "map_visit", target: "" }, "target"],
    ["a count under 1", { count: 0 }, "count"],
    ["a count that is not whole", { count: 2.5 }, "count"],
    ["an unknown reward item", { reward_item: "Gold Bar" }, "reward_item"],
    ["a quantity over 999", { reward_quantity: 1000 }, "reward_quantity"],
    ["an unknown mount", { reward_mount: "Dragon" }, "reward_mount"],
    ["a description too long", { description: "x".repeat(501) }, "description"],
    ["a name too long", { name: "x".repeat(101) }, "name"],
  ];
  for (const [what, over, field] of wrong) {
    test(`refuses ${what}`, () => {
      const read = editor.readAchievement(input(over), OPTIONS, []);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(Object.keys(read.fields)).toContain(field);
    });
  }

  test("refuses a name another achievement has, whatever its case", () => {
    const other: AchievementDef = {
      id: 5, name: "WOLF SLAYER", description: "", icon: null, type: "death", target: null, count: 1,
      reward_item: null, reward_quantity: 1, reward_mount: null, enabled: true,
    };
    const read = editor.readAchievement(input(), OPTIONS, [other]);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.fields["name"]).toContain("Another achievement");
  });
});

describe("handleEditorPacket", () => {
  const save = (data: Row) => editor.handleEditorPacket(admin, "ACHIEVEMENT_EDITOR_SAVE", data, world);

  test("refuses a player without the permission, and writes nothing", async () => {
    const answer = await editor.handleEditorPacket({ id: "v1", username: "visitor" }, "ACHIEVEMENT_EDITOR_SAVE", input(), world);
    expect(answer).toMatchObject({ kind: "result", ok: false, denied: true, data: null });
    expect(table).toEqual([]);
  });

  test("lists the achievements, the criteria and the pick lists", async () => {
    const answer = await editor.handleEditorPacket(admin, "ACHIEVEMENT_EDITOR_LIST", {}, world);
    expect(answer.kind).toBe("data");
    if (answer.kind !== "data") return;
    expect(answer.data.criteria).toHaveLength(14);
    expect(answer.data.criteria.find((c) => c.type === "map_visit")).toEqual({ type: "map_visit", label: "Visit a map", target: "required", pick: "maps" });
    expect(answer.data.options).toEqual(OPTIONS);
    expect(answer.data.ready).toBe(true);
  });

  test("saves a new achievement, and the counting sees it", async () => {
    const answer = await save(input());
    expect(answer).toMatchObject({ kind: "result", ok: true, changed: true, id: 1 });
    expect(table).toHaveLength(1);
    expect((await store.definitions()).map((d) => [d.id, d.name, d.target, d.reward_item])).toEqual([[1, "Wolf Slayer", "7", "Copper Ore"]]);
  });

  test("changes one that exists, and says progress is kept when what counts changed", async () => {
    await save(input());
    const answer = await save(input({ id: 1, count: 20 }));
    expect(answer.kind === "result" && answer.ok).toBe(true);
    expect(answer.kind === "result" ? answer.notes : []).toHaveLength(1);
    expect(table[0]!.count).toBe(20);
    expect(answer.kind === "result" ? answer.notes[0] : "").toContain("Progress made so far is kept");
  });

  test("changing what counts starts progress toward it again, and says so; who earned it keeps it", async () => {
    await save(input());
    const done = "2026-10-17T12:00:00.000Z";
    progress.push(
      { username: "alice", achievement_id: 1, progress: 4, completed_at: null },
      { username: "bob", achievement_id: 1, progress: 10, completed_at: done },
    );
    const answer = await save(input({ id: 1, type: "level", target: "", count: 10 }));
    expect(answer.kind === "result" && answer.ok).toBe(true);
    expect(answer.kind === "result" ? answer.notes : []).toEqual(["Players who earned it keep it. Progress made toward it so far is started again."]);
    expect(progress).toEqual([{ username: "bob", achievement_id: 1, progress: 10, completed_at: done }]);
  });

  test("a save that changes only the name keeps progress and says nothing of it", async () => {
    await save(input());
    progress.push({ username: "alice", achievement_id: 1, progress: 4, completed_at: null });
    const answer = await save(input({ id: 1, name: "Wolf Hunter" }));
    expect(answer.kind === "result" && answer.ok).toBe(true);
    expect(answer.kind === "result" ? answer.notes : ["x"]).toEqual([]);
    expect(progress).toEqual([{ username: "alice", achievement_id: 1, progress: 4, completed_at: null }]);
  });

  test("refuses to change one that does not exist", async () => {
    const answer = await save(input({ id: 42 }));
    expect(answer.kind === "result" && !answer.ok).toBe(true);
    expect(table).toEqual([]);
  });

  test("deletes one, with every player's progress toward it", async () => {
    await save(input());
    progress.push({ username: "alice", achievement_id: 1, progress: 4, completed_at: null });
    const answer = await editor.handleEditorPacket(admin, "ACHIEVEMENT_EDITOR_DELETE", { id: 1 }, world);
    expect(answer).toMatchObject({ kind: "result", ok: true, changed: true, id: 1 });
    expect(table).toEqual([]);
    expect(progress).toEqual([]);
    expect(await store.definitions()).toEqual([]);
  });

  test("refuses every change while the tables are missing", async () => {
    failing = (sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS achievements");
    expect(await store.ensureAchievementSchema()).toBe(false);
    const answer = await save(input());
    expect(answer.kind === "result" && !answer.ok).toBe(true);
    expect(table).toEqual([]);
    failing = null;
    expect(await store.ensureAchievementSchema()).toBe(true);
  });
});
