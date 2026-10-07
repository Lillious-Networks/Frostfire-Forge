import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

const queries: Array<{ sql: string; params: any[] }> = [];
/** The items table, for the one read the editor ever makes of it: all of it, after a write that failed. */
let itemRows: any[] = [];
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null = null;

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    if (failing?.test(sql)) throw new Error("Connection lost");
    if (sql === "SELECT * FROM items") return itemRows.map((row) => ({ ...row }));
    if (sql.startsWith("SELECT")) throw new Error(`The item editor asked the database: ${sql}`);
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

// Item names in the cache each time the login workers were handed the list.
const handedToLoginWorkers: string[][] = [];
let loginWorkersFail = false;
mock.module("../socket/authentication_pool", () => ({
  refreshAuthItems: async () => {
    if (loginWorkersFail) throw new Error("worker gone");
    handedToLoginWorkers.push(((cache.get("items") || []) as Item[]).map((i) => i.name));
  },
  refreshAuthSpells: async () => {},
  getAuthWorker: async () => null,
  resetAuthWorker: () => {},
}));

const { default: log } = await import("../modules/logger");
const editor = await import("../systems/itemeditor");

beforeEach(() => {
  handedToLoginWorkers.length = 0;
  loginWorkersFail = false;
  failing = null;
});

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

  test("what a vendor pays for it is a whole number of copper a purse can hold, 0 or more", () => {
    expect(editor.validateItem(weapon({ sell_price: 0 }), names(), null)).toEqual([]);
    expect(editor.validateItem(weapon({ sell_price: 12_345 }), names(), null)).toEqual([]);
    expect(editor.validateItem(weapon({ sell_price: -1 }), names(), null)).toContain("Vendor sell price cannot be negative.");
    expect(editor.validateItem(weapon({ sell_price: editor.SELL_PRICE_MAX }), names(), null)).toEqual([]);
    expect(editor.validateItem(weapon({ sell_price: editor.SELL_PRICE_MAX + 1 }), names(), null)).toContain("Vendor sell price is too high.");
  });
});

describe("a consumable", () => {
  const potion = (over: Record<string, any> = {}) => ({ name: "Health Potion", quality: "common", type: "consumable", description: "", restore_health: 50, ...over });

  test("keeps what it restores, whether it can be used in combat and whether it is the home item", () => {
    expect(editor.normalizeItem(potion({ restore_health: "50", restore_stamina: 12.9, no_combat: 1 }))).toMatchObject({ restore_health: 50, restore_stamina: 12, no_combat: true, teleports_home: false });
    expect(editor.normalizeItem(potion({ restore_health: "", restore_stamina: null }))).toMatchObject({ restore_health: 0, restore_stamina: 0, no_combat: false });
    // The home item only takes its player home.
    expect(editor.normalizeItem(potion({ teleports_home: true, restore_stamina: 5 }))).toMatchObject({ teleports_home: true, restore_health: 0, restore_stamina: 0 });
  });

  test("is the only kind of item with a use", () => {
    expect(editor.normalizeItem(weapon({ restore_health: 50, restore_stamina: 5, no_combat: true, teleports_home: true })))
      .toMatchObject({ restore_health: 0, restore_stamina: 0, no_combat: false, teleports_home: false });
  });

  test("has to restore something, or be the home item", () => {
    expect(editor.validateItem(potion(), names(), null)).toEqual([]);
    expect(editor.validateItem(potion({ restore_health: 0, restore_stamina: 30 }), names(), null)).toEqual([]);
    expect(editor.validateItem(potion({ restore_health: 0, teleports_home: true }), names(), null)).toEqual([]);
    expect(editor.validateItem(potion({ restore_health: 0 }), names(), null)).toContain("A consumable must restore health or stamina, or be the home item.");
    expect(editor.validateItem(potion({ restore_health: -5 }), names(), null)).toContain("What a consumable restores cannot be negative.");
    expect(editor.validateItem(potion({ restore_stamina: -1 }), names(), null)).toContain("What a consumable restores cannot be negative.");
    expect(editor.validateItem(potion({ restore_health: editor.RESTORE_MAX + 1 }), names(), null)).toContain("What a consumable restores is too high.");
  });

  test("cannot be the home item while another item is", () => {
    const stone = potion({ name: "Home Stone", restore_health: 0, teleports_home: true });
    expect(editor.validateItem(stone, names("home stone"), "Home Stone", "Home Stone")).toEqual([]);
    // Renamed, it is still the item it was.
    expect(editor.validateItem({ ...stone, name: "Hearth Rune" }, names("home stone"), "home stone", "Home Stone")).toEqual([]);
    expect(editor.validateItem({ ...stone, name: "Second Stone" }, names("home stone"), null, "Home Stone")).toContain("Home Stone is already the home item. Only one item can be.");
    expect(editor.validateItem(potion({ teleports_home: true }), names("home stone", "health potion"), "Health Potion", "Home Stone"))
      .toContain("Home Stone is already the home item. Only one item can be.");
    // Any other item saves as before.
    expect(editor.validateItem(potion(), names("home stone"), null, "Home Stone")).toEqual([]);
  });

  test("is written with its use, new or changed", async () => {
    cache.set("items", []);
    queries.length = 0;
    await editor.saveItem(potion({ restore_stamina: 5, no_combat: true }), null);
    await editor.saveItem(potion({ name: "Home Stone", restore_health: 0, teleports_home: true }), null);
    const [first, second] = queries.filter((q) => q.sql.startsWith("INSERT INTO items"));
    const columns = first!.sql.slice(first!.sql.indexOf("(") + 1, first!.sql.indexOf(")")).split(", ");
    const written = (q: { params: any[] }, column: string) => q.params[columns.indexOf(column)];
    expect(["restore_health", "restore_stamina", "no_combat", "teleports_home"].map((column) => written(first!, column))).toEqual([50, 5, 1, 0]);
    expect(["restore_health", "restore_stamina", "no_combat", "teleports_home"].map((column) => written(second!, column))).toEqual([0, 0, 0, 1]);

    await editor.saveItem(potion({ restore_health: 75 }), "Health Potion");
    const update = queries.find((q) => q.sql.startsWith("UPDATE items SET"));
    expect(update!.sql).toMatch(/\brestore_health = \?.*\brestore_stamina = \?.*\bno_combat = \?.*\bteleports_home = \?/);
    expect((cache.get("items") as Item[]).find((i) => i.name === "Health Potion")).toMatchObject({ restore_health: 75, restore_stamina: 0, no_combat: false });
  });

  test("a save through the editor is refused a second home item", async () => {
    cache.set("items", [editor.normalizeItem(potion({ name: "Home Stone", restore_health: 0, teleports_home: true }))]);
    queries.length = 0;
    const answer = await editor.handleEditorPacket("ITEM_EDITOR_SAVE", potion({ name: "Other Stone", restore_health: 0, teleports_home: true }));
    expect(answer).toEqual({ kind: "result", ok: false, errors: ["Home Stone is already the home item. Only one item can be."] });
    expect(queries).toHaveLength(0);
    // The home item itself saves.
    expect(await editor.handleEditorPacket("ITEM_EDITOR_SAVE", { ...potion({ name: "Home Stone", restore_health: 0, teleports_home: true }), originalName: "Home Stone" }))
      .toMatchObject({ ok: true });
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

  test("an item sells for one copper unless it says otherwise", () => {
    expect(editor.normalizeItem({ name: "x" }).sell_price).toBe(1);
    expect(editor.normalizeItem({ name: "x", sell_price: "" }).sell_price).toBe(1);
    expect(editor.normalizeItem({ name: "x", sell_price: null }).sell_price).toBe(1);
    expect(editor.normalizeItem({ name: "x", sell_price: "250" }).sell_price).toBe(250);
    expect(editor.normalizeItem({ name: "x", sell_price: 12.9 }).sell_price).toBe(12);
    // Nothing is a price too: an item vendors do not buy.
    expect(editor.normalizeItem({ name: "x", sell_price: 0 }).sell_price).toBe(0);
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

  test("what a vendor pays is written with the rest of the item, new or changed", async () => {
    queries.length = 0;
    itemRows = [];
    cache.set("items", []);

    await editor.saveItem(weapon({ sell_price: 340 }), null);
    await editor.saveItem(weapon({ sell_price: 0 }), "wooden staff");

    const [insert, update] = queries;
    expect(insert!.sql).toMatch(/^INSERT INTO items \(.*\bsell_price\b.*\)/);
    expect(insert!.params).toContain(340);
    expect(update!.sql).toMatch(/^UPDATE items SET .*\bsell_price = \?/);
    expect(update!.params.at(-2)).toBe(0);
    expect((cache.get("items") as Item[])[0]?.sell_price).toBe(0);
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

  test("whether a save is of a new item is read from the items held: the database is sent the write and nothing else", async () => {
    queries.length = 0;
    cache.set("items", [editor.normalizeItem(weapon())]);

    await editor.saveItem(weapon({ name: "oak staff" }), null);
    // The item is found whatever case its name comes in, as the table would find it.
    await editor.saveItem(weapon({ description: "A better stick." }), "WOODEN STAFF");
    await editor.deleteItem("oak staff");

    expect(queries.map((q) => q.sql.split(" ").slice(0, 3).join(" "))).toEqual(["INSERT INTO items", "UPDATE items SET", "DELETE FROM items"]);
    expect(queries[1]!.params.at(-1)).toBe("WOODEN STAFF");
    expect((cache.get("items") as Item[]).map((i) => [i.name, i.description])).toEqual([["wooden staff", "A better stick."]]);
  });

  for (const [what, statement, change] of [
    ["save of a new item", /^INSERT INTO items/, () => editor.saveItem(weapon({ name: "oak staff" }), null)],
    ["save of an item that is there", /^UPDATE items/, () => editor.saveItem(weapon({ description: "A better stick." }), "wooden staff")],
    ["delete", /^DELETE FROM items/, () => editor.deleteItem("wooden staff")],
  ] as Array<[string, RegExp, () => Promise<unknown>]>) {
    test(`a ${what} the database refused: the table is read again, once, and what is held and handed to the login workers is what it holds`, async () => {
      queries.length = 0;
      cache.set("items", [editor.normalizeItem(weapon())]);
      // What the table holds afterwards: the statement may have been applied all the same (one that timed out, say).
      itemRows = [{ name: "wooden staff", description: "As the database has it." }, { name: "iron sword", description: "Only the database knew." }];
      failing = statement;

      await expect(change()).rejects.toThrow("Connection lost");

      expect(queries.map((q) => q.sql).slice(1)).toEqual(["SELECT * FROM items"]);
      expect(cache.get("items")).toEqual(itemRows);
      expect(handedToLoginWorkers).toEqual([["wooden staff", "iron sword"]]);
    });
  }

  test("a write the database refused while the table cannot be read either leaves the error the write's own, and the items as they were", async () => {
    cache.set("items", [editor.normalizeItem(weapon())]);
    failing = /^(DELETE FROM|SELECT \* FROM) items/;
    const logged = spyOn(log, "error").mockImplementation(() => {});
    try {
      await expect(editor.deleteItem("wooden staff")).rejects.toThrow("Connection lost");
      expect(cache.get("items")).toHaveLength(1);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("login workers", () => {
  test("a saved item is handed to the login workers once it is in the cache", async () => {
    itemRows = [];
    cache.set("items", []);

    await editor.saveItem(weapon(), null);

    expect(handedToLoginWorkers).toEqual([["wooden staff"]]);
  });

  test("a deleted item is handed over as gone", async () => {
    cache.set("items", [editor.normalizeItem(weapon())]);

    await editor.deleteItem("wooden staff");

    expect(handedToLoginWorkers).toEqual([[]]);
  });

  test("a save still succeeds when the login workers cannot be reached", async () => {
    itemRows = [];
    cache.set("items", []);
    loginWorkersFail = true;
    const logged = spyOn(log, "error").mockImplementation(() => {});

    try {
      const saved = await editor.saveItem(weapon(), null);

      expect(saved.name).toBe("wooden staff");
      expect(cache.get("items")).toHaveLength(1);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
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
    expect(handedToLoginWorkers).toEqual([]);
  });

  test("an unknown action is rejected", async () => {
    const result = await editor.handleEditorPacket("ITEM_EDITOR_NONSENSE", {});
    expect(result.kind).toBe("result");
    if (result.kind === "result") expect(result.ok).toBe(false);
  });
});
