import { beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

// USER REQUEST 2026-10-14: character classes (systems/classes.ts) and the class editor (systems/classeditor.ts).

// ------------------------------------------------------------ fake database
// The statements the two systems send, run against in-memory tables. Anything else is an error.

type Row = Record<string, any>;
let tables: { classes: Row[]; permissions: Row[]; learned_spells: Row[] };
let nextId: number;
const queries: string[] = [];

function run(sql: string, params: any[] = []): any {
  const text = sql.replace(/\s+/g, " ").trim();
  queries.push(text);
  if (text.startsWith("CREATE TABLE IF NOT EXISTS classes")) return [];
  if (text.includes("INFORMATION_SCHEMA.COLUMNS") && (params[1] === "class_id" || params[1] === "items")) return [{ count: 1 }];
  if (text === "SELECT permissions FROM permissions WHERE username = ?") return tables.permissions.filter((r) => r.username === params[0]);
  if (text === "SELECT * FROM classes") return tables.classes.map((r) => ({ ...r }));
  if (text.startsWith("INSERT INTO classes")) {
    const columns = text.match(/\((.+?)\) VALUES/)![1]!.split(", ");
    const row: Row = { id: nextId++ };
    columns.forEach((c, i) => { row[c] = params[i]; });
    if (tables.classes.some((r) => String(r.name).toLowerCase() === String(row.name).toLowerCase())) throw new Error("Duplicate entry for key 'name'");
    tables.classes.push(row);
    return { lastInsertRowid: row.id, affectedRows: 1 };
  }
  if (text.startsWith("UPDATE classes SET")) {
    const columns = text.match(/SET (.+) WHERE/)![1]!.split(", ").map((p) => p.replace(" = ?", ""));
    const id = params[params.length - 1];
    for (const row of tables.classes.filter((r) => r.id === id)) columns.forEach((c, i) => { row[c] = params[i]; });
    return { affectedRows: 1 };
  }
  if (text === "DELETE FROM classes WHERE id = ?") {
    tables.classes = tables.classes.filter((r) => r.id !== params[0]);
    return { affectedRows: 1 };
  }
  if (text === "SELECT spell FROM learned_spells WHERE username = ?") return tables.learned_spells.filter((r) => r.username === params[0]).map((r) => ({ spell: r.spell }));
  if (text === "INSERT IGNORE INTO learned_spells (username, spell) VALUES (?, ?)") {
    if (tables.learned_spells.some((r) => r.username === params[0] && r.spell === params[1])) return { affectedRows: 0 };
    tables.learned_spells.push({ username: params[0], spell: params[1] });
    return { affectedRows: 1 };
  }
  // a read of another system's table, by a cache another test file left behind
  if (text.startsWith("SELECT")) return [];
  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => run(sql, params),
}));

const cache = new Map<string, any>();
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => cache.get(key),
    set: async (key: string, value: any) => cache.set(key, value),
    add: async (key: string, value: any) => cache.set(key, value),
  },
}));

const { clearCaches } = await import("../services/datacache");
const { default: classes, ensureClassSchema, parseItems, parseSpells } = await import("../systems/classes");
const editor = await import("../systems/classeditor");
const { Events, listener } = await import("../systems/events");

const SPELLS = [
  { name: "frost_bolt", icon: "frost_bolt", description: "A bolt of ice.", type: "damage" },
  { name: "heal", icon: "heal", description: "Mends wounds.", type: "heal" },
  { name: "fireball", icon: null, description: "Burns.", type: "damage" },
];
const ITEMS = [
  { name: "wooden_staff", icon: "wooden_staff", description: "A plain staff.", quality: "common" },
  { name: "health_potion", icon: null, description: "Heals.", quality: "common" },
];
const ADMIN = { id: "c-1", username: "boss", isGuest: false, isAdmin: true, permissions: [] };
const BUILDER = { id: "c-2", username: "builder", isGuest: false, permissions: ["tools.class_editor"] };
const PLAYER = { id: "c-3", username: "pleb", isGuest: false, permissions: [] };

const classOf = (over: Row = {}): Row => ({
  name: "Mage", description: "Casts spells.",
  max_health: 80, max_stamina: 120, stat_damage: 2, stat_armor: 0, stat_critical_chance: 10, stat_critical_damage: 50, stat_avoidance: 5,
  spells: [{ spell: "frost_bolt", level: 1 }, { spell: "fireball", level: 5 }],
  ...over,
});

beforeEach(async () => {
  tables = { classes: [], permissions: [{ username: "builder", permissions: "tools.class_editor" }], learned_spells: [] };
  nextId = 1;
  queries.length = 0;
  cache.set("spells", SPELLS.map((s) => ({ ...s })));
  cache.set("items", ITEMS.map((i) => ({ ...i })));
  await clearCaches();
  await ensureClassSchema();
});

describe("classes", () => {
  test("the spells column is read from text or parsed, and what is not a spell at a level is dropped", () => {
    expect(parseSpells('[{"spell":"heal","level":3},{"spell":"frost_bolt","level":1}]')).toEqual([{ spell: "frost_bolt", level: 1 }, { spell: "heal", level: 3 }]);
    expect(parseSpells([{ spell: "heal", level: "2.7" }, { spell: "", level: 1 }, { level: 4 }, null])).toEqual([{ spell: "heal", level: 2 }]);
    expect(parseSpells("not json")).toEqual([]);
    expect(parseSpells(null)).toEqual([]);
  });

  test("the items column is read as the spells column is, and a class without one starts with nothing", () => {
    expect(parseItems('[{"item":"health_potion","quantity":5}]')).toEqual([{ item: "health_potion", quantity: 5 }]);
    expect(parseItems([{ item: "wooden_staff", quantity: "0" }, { item: "", quantity: 1 }, { quantity: 2 }, null])).toEqual([{ item: "wooden_staff", quantity: 1 }]);
    expect(parseItems(null)).toEqual([]);
  });

  test("a character is asked for only while the account has none and there is a class to choose", async () => {
    expect(await classes.characterRequired(null)).toBe(false); // no classes yet: everyone plays as before
    tables.classes.push({ id: 7, ...classOf(), spells: JSON.stringify(classOf().spells) });
    await clearCaches();
    expect(await classes.characterRequired(null)).toBe(true);
    expect(await classes.characterRequired(undefined)).toBe(true);
    expect(await classes.characterRequired(7)).toBe(false);
    expect(await classes.characterRequired(0)).toBe(false); // made without a class (benchmark clients, or a deleted class)
  });

  test("a character learns its class's spells up to its level, once each, and passes over spells that are gone", async () => {
    tables.classes.push({ id: 3, ...classOf({ spells: JSON.stringify([{ spell: "frost_bolt", level: 1 }, { spell: "gone_spell", level: 1 }, { spell: "fireball", level: 5 }]) }) });
    await clearCaches();
    expect(await classes.learnUpTo("hero", 3, 1)).toEqual(["frost_bolt"]);
    expect(await classes.learnUpTo("hero", 3, 1)).toEqual([]);
    expect(await classes.learnUpTo("hero", 3, 9)).toEqual(["fireball"]);
    expect(tables.learned_spells.map((r) => r.spell).sort()).toEqual(["fireball", "frost_bolt"]);
    expect(await classes.learnUpTo("hero", 99, 50)).toEqual([]); // no such class
  });

  test("reaching a level teaches a live character the class's spells for it, and sends the spell book", async () => {
    tables.classes.push({ id: 4, ...classOf({ spells: JSON.stringify([{ spell: "heal", level: 2 }]) }) });
    await clearCaches();
    const sent: any[] = [];
    const player = { username: "climber", characterClass: 4, stats: { level: 2 }, wt: { readyState: 1, send: (p: any) => sent.push(p) } };
    listener.emit(Events.PLAYER_LEVEL_UP, { player, level: 2 });
    for (let i = 0; i < 20 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(tables.learned_spells).toEqual([{ username: "climber", spell: "heal" }]);
    expect(Object.keys((player as any).learnedSpells ?? {})).toEqual(["heal"]);
    expect(sent.length).toBeGreaterThanOrEqual(2); // the spell book, and "You have learned heal."
  });
});

describe("the class editor", () => {
  test("is the admins' and the class editor permission's, asked on every packet", async () => {
    expect(await editor.canUseEditor(ADMIN)).toBe(true);
    expect(await editor.canUseEditor(BUILDER)).toBe(true);
    expect(await editor.canUseEditor(PLAYER)).toBe(false);
    expect(await editor.canUseEditor({ ...ADMIN, isGuest: true })).toBe(false);
    const refused = await editor.handleEditorPacket(PLAYER, "CLASS_EDITOR_SAVE", classOf());
    expect(refused).toMatchObject({ kind: "result", ok: false, denied: true, data: null });
    expect(queries.some((q) => q.startsWith("INSERT INTO classes"))).toBe(false);
  });

  test("lists the classes with the spells to pick from and the rules", async () => {
    const answer = await editor.handleEditorPacket(ADMIN, "CLASS_EDITOR_LIST", null);
    expect(answer.kind).toBe("data");
    const data = (answer as any).data;
    expect(data.classes).toEqual([]);
    expect(data.spells.map((s: any) => s.name)).toEqual(["fireball", "frost_bolt", "heal"]);
    expect(data.items.map((i: any) => i.name)).toEqual(["health_potion", "wooden_staff"]);
    expect(data.numbers.max_health).toMatchObject({ min: 1 });
    expect(data.ready).toBe(true);
  });

  test("saves a new class, then an edit of it (a new name included), and the list holds it", async () => {
    const made = await editor.handleEditorPacket(BUILDER, "CLASS_EDITOR_SAVE", classOf()) as any;
    expect(made).toMatchObject({ ok: true, name: "Mage", changed: true });
    expect(made.data.classes).toHaveLength(1);
    const id = made.data.classes[0].id;
    expect(tables.classes[0]).toMatchObject({ id, name: "Mage", max_health: 80, spells: JSON.stringify([{ spell: "frost_bolt", level: 1 }, { spell: "fireball", level: 5 }]) });

    const edited = await editor.handleEditorPacket(ADMIN, "CLASS_EDITOR_SAVE", classOf({ id, name: "Sorcerer", max_health: 90, spells: [{ spell: "heal", level: 2 }] })) as any;
    expect(edited.ok).toBe(true);
    expect(tables.classes).toHaveLength(1);
    expect(tables.classes[0]).toMatchObject({ id, name: "Sorcerer", max_health: 90 });
    expect((await classes.get(id))?.spells).toEqual([{ spell: "heal", level: 2 }]);
  });

  test("saves starter items, and refuses ones that are not items, twice in the list, or of no quantity", async () => {
    const items = [{ item: "wooden_staff", quantity: 1 }, { item: "health_potion", quantity: 5 }];
    const made = await editor.handleEditorPacket(ADMIN, "CLASS_EDITOR_SAVE", classOf({ items })) as any;
    expect(made.ok).toBe(true);
    expect(tables.classes[0].items).toBe(JSON.stringify(items));
    expect((await classes.get(made.data.classes[0].id))?.items).toEqual(items);

    const bad = await editor.handleEditorPacket(ADMIN, "CLASS_EDITOR_SAVE", classOf({
      name: "Rogue", items: [{ item: "wooden_staff", quantity: 1 }, { item: "wooden_staff", quantity: 1 }, { item: "nope", quantity: 1 }, { item: "health_potion", quantity: 0 }],
    })) as any;
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.fields).sort()).toEqual(["items.1", "items.2", "items.3"]);
  });

  test("refuses what is wrong, field by field, and writes nothing", async () => {
    await editor.handleEditorPacket(ADMIN, "CLASS_EDITOR_SAVE", classOf());
    queries.length = 0;
    const bad = await editor.handleEditorPacket(ADMIN, "CLASS_EDITOR_SAVE", classOf({
      name: "mage", max_health: 0, stat_critical_chance: 101, stat_armor: 1.5,
      spells: [{ spell: "frost_bolt", level: 1 }, { spell: "frost_bolt", level: 2 }, { spell: "nope", level: 1 }, { spell: "heal", level: 0 }],
    })) as any;
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.fields).sort()).toEqual(["max_health", "name", "spells.1", "spells.2", "spells.3", "stat_armor", "stat_critical_chance"].sort());
    expect(queries.some((q) => q.startsWith("INSERT") || q.startsWith("UPDATE"))).toBe(false);
  });

  test("deletes a class; one that is gone is said to be", async () => {
    const made = await editor.handleEditorPacket(ADMIN, "CLASS_EDITOR_SAVE", classOf()) as any;
    const id = made.data.classes[0].id;
    const gone = await editor.handleEditorPacket(ADMIN, "CLASS_EDITOR_DELETE", { id }) as any;
    expect(gone).toMatchObject({ ok: true, name: "Mage" });
    expect(gone.notes.join(" ")).toContain("no classes left");
    expect(tables.classes).toEqual([]);
    expect((await editor.handleEditorPacket(ADMIN, "CLASS_EDITOR_DELETE", { id }) as any).ok).toBe(false);
  });
});
