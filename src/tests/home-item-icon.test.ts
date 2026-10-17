import { describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

// The items table, held here: only what the start step reads and writes.
let items: Array<{ name: string; icon: string | null; teleports_home: number }> = [];
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, values: any[] = []) => {
    if (sql.startsWith("UPDATE items SET icon = ? WHERE teleports_home = 1 AND (icon IS NULL OR icon = '')")) {
      let changed = 0;
      for (const row of items) {
        if (row.teleports_home === 1 && (row.icon === null || row.icon === "")) {
          row.icon = values[0];
          changed++;
        }
      }
      return { affectedRows: changed };
    }
    throw new Error(`The fake database does not understand: ${sql}`);
  },
}));

const { ensureHomeItemIcon, HOME_ITEM_ICON } = await import("../systems/items");

describe("ensureHomeItemIcon", () => {
  test("a home item with no icon gets home_stone", async () => {
    items = [{ name: "Home Stone", icon: null, teleports_home: 1 }, { name: "Rat Tail", icon: null, teleports_home: 0 }];
    await ensureHomeItemIcon();
    expect(HOME_ITEM_ICON).toBe("home_stone");
    expect(items[0]!.icon).toBe("home_stone");
    expect(items[1]!.icon).toBeNull();
  });

  test("an empty icon counts as none", async () => {
    items = [{ name: "Home Stone", icon: "", teleports_home: 1 }];
    await ensureHomeItemIcon();
    expect(items[0]!.icon).toBe("home_stone");
  });

  test("an icon chosen in the item editor is kept", async () => {
    items = [{ name: "Hearth Rune", icon: "rune", teleports_home: 1 }];
    await ensureHomeItemIcon();
    expect(items[0]!.icon).toBe("rune");
  });
});
