import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

// Rows the mocked database returns for loot_table_items, and what was written.
let tableItems: any[] = [];
let written: any[][] = [];

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, params: any[] = []) => {
    if (sql.startsWith("SELECT * FROM loot_tables WHERE id")) return [{ id: 1, name: "Wolf drops", created_at: null }];
    if (sql.startsWith("SELECT * FROM loot_table_items")) return tableItems;
    if (sql.startsWith("INSERT INTO loot_table_items") || sql.startsWith("UPDATE loot_table_items")) written.push(params);
    return [];
  },
}));
mock.module("../services/assetCache", () => ({
  default: { get: async () => [{ name: "Wolf Pelt", quality: "common" }] },
}));
mock.module("../modules/spriteSheetManager", () => ({ getIconUrl: () => "" }));

const { default: lootTable, normalizeDropChance } = await import("../systems/lootTable");

const row = (drop_chance: unknown) => ({ id: 1, item_name: "Wolf Pelt", min_quantity: 1, max_quantity: 1, drop_chance, quality: "common" });

afterEach(() => {
  tableItems = [];
  written = [];
  mock.restore();
});

describe("drop chance", () => {
  test("0 stays 0; only a missing value means 100", () => {
    expect(normalizeDropChance(0)).toBe(0);
    expect(normalizeDropChance("0.00")).toBe(0);
    expect(normalizeDropChance(25.5)).toBe(25.5);
    expect(normalizeDropChance("50.00")).toBe(50);
    expect(normalizeDropChance(undefined)).toBe(100);
    expect(normalizeDropChance(null)).toBe(100);
    expect(normalizeDropChance("")).toBe(100);
    expect(normalizeDropChance("abc")).toBe(100);
    expect(normalizeDropChance(250)).toBe(100);
    expect(normalizeDropChance(-5)).toBe(0);
  });

  test("a 0% drop is stored as 0 on add and update", async () => {
    await lootTable.addItem(1, "Wolf Pelt", 1, 1, 0, "common");
    await lootTable.updateItem(7, 1, 2, 0, "common");
    expect(written[0][4]).toBe(0);
    expect(written[1][2]).toBe(0);
  });

  test("a 0% drop never rolls, even on the luckiest roll", async () => {
    tableItems = [row("0.00")];
    const random = spyOn(Math, "random").mockReturnValue(0);
    expect(await lootTable.roll(1)).toEqual([]);
    random.mockRestore();
  });

  test("100% always drops and a missing chance counts as 100%", async () => {
    tableItems = [row("100.00"), row(null)];
    const random = spyOn(Math, "random").mockReturnValue(0.999);
    expect((await lootTable.roll(1)).length).toBe(2);
    random.mockRestore();
  });
});
