import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule, standInFor } from "./setup";

// The gathering_areas table, held here.
let table: any[] = [];
let nextId = 1;
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, values: any[] = []) => {
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE") || sql.includes("permission_types")) return [];
    // the column check of ensureGatheringSchema: no such column yet, so it is added
    if (sql.includes("INFORMATION_SCHEMA") || sql.includes("sqlite_master")) return [];
    if (sql.startsWith("SELECT")) return table.map((row) => ({ ...row }));
    if (sql.startsWith("INSERT INTO gathering_areas")) {
      const [map, x, y, radius, size, item, quantity_min, quantity_max, max_nodes, respawn_min_s, respawn_max_s, enabled] = values;
      const id = nextId++;
      table.push({ id, map, x, y, radius, size, item, quantity_min, quantity_max, max_nodes, respawn_min_s, respawn_max_s, enabled });
      return { lastInsertRowid: id, affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE gathering_areas")) {
      const id = values[values.length - 1];
      const row = table.find((r) => r.id === id);
      if (!row) return { affectedRows: 0 };
      const [map, x, y, radius, size, item, quantity_min, quantity_max, max_nodes, respawn_min_s, respawn_max_s, enabled] = values;
      Object.assign(row, { map, x, y, radius, size, item, quantity_min, quantity_max, max_nodes, respawn_min_s, respawn_max_s, enabled });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("DELETE FROM gathering_areas")) {
      const before = table.length;
      table = table.filter((r) => r.id !== values[0]);
      return { affectedRows: before - table.length };
    }
    throw new Error(`The fake database does not understand: ${sql}`);
  },
}));

const grants: Record<string, string> = { builder: "tools.gathering" };
await standInFor("../systems/permissions", () => ({ default: { get: async (name: string) => grants[name] ?? "" } }));

const editor = await import("../systems/gathering/editor");
const { reloadTable } = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
let infoSpy: ReturnType<typeof spyOn>;

const admin = { username: "builder", location: { map: "main.json" } };
const world = (spots: Array<{ x: number; y: number }> | null = [{ x: 1, y: 2 }]) => ({
  here: "main",
  items: async () => [{ name: "Copper Ore", image: "icon:copper" }],
  preview: async () => spots,
});
const input = (overrides: Record<string, unknown> = {}) => ({
  x: 500, y: 500, radius: 128, item: "copper ore", quantity_min: 1, quantity_max: 3, max_nodes: 6, respawn_min_s: 30, respawn_max_s: 60, enabled: true, ...overrides,
});

beforeAll(async () => {
  infoSpy = spyOn(log, "info").mockImplementation(() => {});
  expect(await editor.ensureGatheringSchema()).toBe(true);
});

afterAll(() => {
  infoSpy.mockRestore();
});

beforeEach(async () => {
  table = [];
  nextId = 1;
  await reloadTable("gathering_areas");
});

describe("readArea", () => {
  test("accepts a whole area and names the item as the items list does", () => {
    const read = editor.readArea(input(), ["Copper Ore"]);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.area.item).toBe("Copper Ore");
  });

  test("an area sent without a size is drawn at the default size", () => {
    const read = editor.readArea(input(), ["Copper Ore"]);
    expect(read.ok && read.area.size).toBe(editor.DEFAULT_SIZE);
  });

  const wrong: Array<[string, Record<string, unknown>, string]> = [
    ["an unknown item", { item: "Gold Bar" }, "item"],
    ["no item", { item: "" }, "item"],
    ["a radius under the least", { radius: 10 }, "radius"],
    ["more nodes than allowed", { max_nodes: 999 }, "max_nodes"],
    ["most less than least", { quantity_min: 5, quantity_max: 2 }, "quantity_max"],
    ["longest respawn shorter than shortest", { respawn_min_s: 60, respawn_max_s: 30 }, "respawn_max_s"],
    ["a coordinate that is not whole", { x: 1.5 }, "x"],
    ["a size under the least", { size: 4 }, "size"],
    ["a size over the most", { size: 300 }, "size"],
  ];
  for (const [what, overrides, field] of wrong) {
    test(`refuses ${what}`, () => {
      const read = editor.readArea(input(overrides), ["Copper Ore"]);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(Object.keys(read.fields)).toContain(field);
    });
  }
});

describe("handleEditorPacket", () => {
  test("refuses a player without the permission", async () => {
    const answer = await editor.handleEditorPacket({ username: "visitor" }, "GATHERING_EDITOR_LIST", {}, world());
    expect(answer.kind === "result" && answer.denied).toBe(true);
  });

  test("saves a new area on the admin's map and lists it", async () => {
    const answer = await editor.handleEditorPacket(admin, "GATHERING_EDITOR_SAVE", input(), world());
    expect(answer.kind).toBe("result");
    if (answer.kind !== "result") return;
    expect(answer.ok).toBe(true);
    expect(answer.changed).toBe(true);
    expect(answer.data?.areas.map((a) => [a.map, a.item, a.max_nodes])).toEqual([["main", "Copper Ore", 6]]);
    expect(table.length).toBe(1);
  });

  test("changes an area that exists", async () => {
    await editor.handleEditorPacket(admin, "GATHERING_EDITOR_SAVE", input(), world());
    const answer = await editor.handleEditorPacket(admin, "GATHERING_EDITOR_SAVE", input({ id: 1, max_nodes: 9 }), world());
    expect(answer.kind === "result" && answer.ok).toBe(true);
    expect(table[0].max_nodes).toBe(9);
    expect((await editor.allAreas())[0]!.max_nodes).toBe(9);
  });

  test("refuses to change an area that does not exist", async () => {
    const answer = await editor.handleEditorPacket(admin, "GATHERING_EDITOR_SAVE", input({ id: 42 }), world());
    expect(answer.kind === "result" && !answer.ok).toBe(true);
    expect(table.length).toBe(0);
  });

  test("saves the size nodes are drawn at", async () => {
    await editor.handleEditorPacket(admin, "GATHERING_EDITOR_SAVE", input({ size: 20 }), world());
    expect(table[0].size).toBe(20);
    expect((await editor.allAreas())[0]!.size).toBe(20);
  });

  test("deletes an area", async () => {
    await editor.handleEditorPacket(admin, "GATHERING_EDITOR_SAVE", input(), world());
    const answer = await editor.handleEditorPacket(admin, "GATHERING_EDITOR_DELETE", { id: 1 }, world());
    expect(answer.kind === "result" && answer.ok && answer.changed).toBe(true);
    expect(table.length).toBe(0);
    expect(await editor.allAreas()).toEqual([]);
  });

  test("previews where the nodes would stand, and says when fewer fit", async () => {
    const answer = await editor.handleEditorPacket(admin, "GATHERING_EDITOR_PREVIEW", input({ max_nodes: 3 }), world([{ x: 1, y: 2 }]));
    expect(answer).toEqual({ kind: "preview", spots: [{ x: 1, y: 2 }], wanted: 3, note: "Only 1 of 3 nodes fit: the area has no more free walkable tiles." });
  });

  test("a preview on a map without collision data is refused", async () => {
    const answer = await editor.handleEditorPacket(admin, "GATHERING_EDITOR_PREVIEW", input(), world(null));
    expect(answer.kind === "result" && !answer.ok).toBe(true);
  });
});
