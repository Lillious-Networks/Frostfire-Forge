import { describe, expect, mock, test } from "bun:test";

const queries: Array<{ sql: string; params: any[] }> = [];
let itemRows: any[] = [];

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    if (sql.startsWith("SELECT name FROM items")) {
      return itemRows.filter((i) => i.name === params[0]).map((i) => ({ name: i.name }));
    }
    return [];
  },
}));

const cache = new Map<string, any>();
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => cache.get(key),
    set: async (key: string, value: any) => cache.set(key, value),
    add: async (key: string, value: any) => cache.set(key, value),
  },
}));

const editor = await import("../systems/itemeditor");

const weapon = (over: Partial<Item> = {}) => ({
  name: "wooden staff",
  quality: "common",
  type: "equipment",
  description: "A stick.",
  icon: "wooden_staff",
  equipable: true,
  equipment_slot: "weapon",
  level_requirement: 1,
  damage_min: 8,
  damage_max: 14,
  attack_speed_ms: 2600,
  ...over,
});

const names = (...list: string[]) => new Set(list.map((n) => n.toLowerCase()));

describe("item editor permissions", () => {
  test("admins, the item permission and wildcards pass; others do not", () => {
    expect(editor.canUseEditor({ isAdmin: true })).toBe(true);
    expect(editor.canUseEditor({ permissions: ["tools.item_editor"] })).toBe(true);
    expect(editor.canUseEditor({ permissions: ["tools.*"] })).toBe(true);
    expect(editor.canUseEditor({ permissions: ["server.*"] })).toBe(true);
    expect(editor.canUseEditor({ permissions: ["tools.npc_editor"] })).toBe(false);
    expect(editor.canUseEditor({ permissions: [] })).toBe(false);
    expect(editor.canUseEditor(null)).toBe(false);
  });
});

describe("item validation", () => {
  test("a valid weapon passes", () => {
    expect(editor.validateItem(weapon(), names(), null)).toEqual([]);
  });

  test("names are required and cannot collide with an existing item", () => {
    expect(editor.validateItem(weapon({ name: "  " }), names(), null)).toContain("Name is required.");
    // New item taking a used name.
    expect(editor.validateItem(weapon(), names("wooden staff"), null))
      .toContain("An item with that name already exists.");
    // Saving an existing item under its own name is fine.
    expect(editor.validateItem(weapon(), names("wooden staff"), "wooden staff")).toEqual([]);
    // Renaming onto another item's name is not.
    expect(editor.validateItem(weapon({ name: "silver helmet" }), names("silver helmet"), "wooden staff"))
      .toContain("An item with that name already exists.");
  });

  test("equipable items need a slot, and only equipment can be equipable", () => {
    expect(editor.validateItem(weapon({ equipment_slot: null }), names(), null))
      .toContain("Equipable items need an equipment slot.");
    expect(editor.validateItem(weapon({ type: "consumable" }), names(), null))
      .toContain("Only equipment can be equipable.");
  });

  test("weapon damage must be a sane range on a weapon-slot item", () => {
    expect(editor.validateItem(weapon({ damage_min: 20, damage_max: 5 }), names(), null))
      .toContain("Maximum damage cannot be below minimum damage.");
    expect(editor.validateItem(weapon({ attack_speed_ms: 100 }), names(), null))
      .toContain("Attack speed must be at least 500ms.");
    expect(editor.validateItem(weapon({ equipment_slot: "helmet" }), names(), null))
      .toContain("Weapon damage and speed only apply to items in the weapon slot.");
  });
});

describe("item normalization", () => {
  test("blank numbers become null and non-equipment loses its slot", () => {
    const item = editor.normalizeItem({
      name: " Red Apple ", type: "consumable", quality: "uncommon", description: "Tasty.",
      stat_health: "", stat_stamina: "12", equipable: true, equipment_slot: "weapon",
    });
    expect(item.name).toBe("Red Apple");
    expect(item.stat_health).toBeNull();
    expect(item.stat_stamina).toBe(12);
    // Equipable is only meaningful for equipment, so the slot goes too.
    expect(item.equipable).toBe(false);
    expect(item.equipment_slot).toBeNull();
  });

  test("unknown type and quality fall back instead of reaching the database", () => {
    const item = editor.normalizeItem({ name: "x", type: "nonsense", quality: "mythic" });
    expect(item.type).toBe("miscellaneous");
    expect(item.quality).toBe("common");
  });
});

describe("saving", () => {
  test("a new item inserts and lands in the cache", async () => {
    queries.length = 0;
    itemRows = [];
    cache.set("items", []);

    await editor.saveItem(weapon(), null);

    expect(queries.some((q) => q.sql.startsWith("INSERT INTO items"))).toBe(true);
    const items = cache.get("items") as Item[];
    expect(items).toHaveLength(1);
    expect(items[0]?.damage_max).toBe(14);
  });

  test("a rename updates the existing row in place and replaces it in the cache", async () => {
    queries.length = 0;
    itemRows = [{ name: "wooden staff" }];
    cache.set("items", [editor.normalizeItem(weapon())]);

    await editor.saveItem(weapon({ name: "oak staff" }), "wooden staff");

    const update = queries.find((q) => q.sql.startsWith("UPDATE items"));
    expect(update).toBeDefined();
    // The WHERE clause still targets the old name.
    expect(update?.params.at(-1)).toBe("wooden staff");
    const items = cache.get("items") as Item[];
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe("oak staff");
  });

  test("deleting removes the row and the cache entry", async () => {
    queries.length = 0;
    cache.set("items", [editor.normalizeItem(weapon())]);

    await editor.deleteItem("wooden staff");

    expect(queries.some((q) => q.sql.startsWith("DELETE FROM items"))).toBe(true);
    expect(cache.get("items")).toHaveLength(0);
  });
});

describe("searching", () => {
  const named = (...list: string[]) => list.map((name) => editor.normalizeItem({ ...weapon(), name }));

  test("an empty query returns nothing, so the editor never lists every item", async () => {
    cache.set("items", named("wooden staff", "silver helmet"));
    const result = await editor.searchItems("");
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(0);
  });

  test("an empty query still returns the item being edited", async () => {
    cache.set("items", named("wooden staff", "silver helmet"));
    const result = await editor.searchItems("", "silver helmet");
    expect(result.items.map((i) => i.name)).toEqual(["silver helmet"]);
  });

  test("matches anywhere in the name, with prefix matches first", async () => {
    cache.set("items", named("iron staff", "staff of fire", "oak stick"));
    const result = await editor.searchItems("staff");
    expect(result.items.map((i) => i.name)).toEqual(["staff of fire", "iron staff"]);
  });

  test("case does not matter and results are capped", async () => {
    cache.set("items", named(...Array.from({ length: editor.SEARCH_LIMIT + 5 }, (_, i) => `potion ${i}`)));
    const result = await editor.searchItems("POTION");
    expect(result.items).toHaveLength(editor.SEARCH_LIMIT);
    expect(result.truncated).toBe(5);
  });
});

describe("editor packets", () => {
  test("opening the editor sends metadata and a count, not the items", async () => {
    cache.set("items", [editor.normalizeItem(weapon())]);
    const result = await editor.handleEditorPacket("ITEM_EDITOR_LIST", null);
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect(result.data.itemCount).toBe(1);
      expect((result.data as any).items).toBeUndefined();
      expect(result.data.slots).toContain("weapon");
    }
  });

  test("search packets return matches", async () => {
    cache.set("items", [editor.normalizeItem(weapon())]);
    const result = await editor.handleEditorPacket("ITEM_EDITOR_SEARCH", { query: "wood" });
    expect(result.kind).toBe("search");
    if (result.kind === "search") expect(result.data.items.map((i) => i.name)).toEqual(["wooden staff"]);
  });


  test("saving a duplicate name reports errors and writes nothing", async () => {
    cache.set("items", [editor.normalizeItem(weapon())]);
    queries.length = 0;

    const result = await editor.handleEditorPacket("ITEM_EDITOR_SAVE", weapon());

    expect(result.kind).toBe("result");
    if (result.kind === "result") {
      expect(result.ok).toBe(false);
      expect(result.errors).toContain("An item with that name already exists.");
    }
    expect(queries.some((q) => q.sql.startsWith("INSERT") || q.sql.startsWith("UPDATE"))).toBe(false);
  });

  test("an unknown action is rejected", async () => {
    const result = await editor.handleEditorPacket("ITEM_EDITOR_NONSENSE", {});
    expect(result.kind).toBe("result");
    if (result.kind === "result") expect(result.ok).toBe(false);
  });
});
