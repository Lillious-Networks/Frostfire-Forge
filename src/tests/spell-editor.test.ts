import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ------------------------------------------------------------ fake database
// The spell editor uses a handful of statement shapes. The fake runs them
// against in-memory tables, with a pause in each one so that two requests
// sent together really do interleave. The reads it knows are the ones that
// fill a cache (the stored spells' ids, who knows a spell, the spells table
// read again after a write that failed) and the looks at the schema: a check
// that asked the database instead of what is held fails the test that made it.

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let nextId: number;
/** Round cast_time as a MySQL INT column does, to act as a database set up before cast times held fractions. */
let wholeCastTime: boolean;
/** The database account may not change tables. */
let lockedSchema: boolean;
/** Columns a database set up before they existed does not have. */
let missingColumns: Set<string>;
/** Whether a write's answer says what it did (the row it added, how many it changed), as MySQL's does. */
let answers: boolean;
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null;
/** The refused statement was applied all the same, as one that timed out may have been. */
let appliedAnyway: boolean;
const queries: Array<{ sql: string; params: any[] }> = [];

const STORED = "SELECT id, name FROM spells ORDER BY id";
const USAGE = "SELECT username FROM learned_spells WHERE spell = ?";
const REREAD = "SELECT * FROM spells";
/** What a write answers: no rows, and what it did when the database says. */
const answer = (did: Row) => (answers ? Object.assign([], did) : []);

const SPELL_COLUMNS = [
  "name", "damage", "mana", "range", "type", "cast_time", "cooldown", "can_move", "description", "icon",
  "effects", "particles", "aoe_radius", "ground_aoe", "ground_duration", "is_thrown", "charge_distance", "teleport_behind",
];

const sameName = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

async function run(sql: string, params: any[] = []): Promise<any> {
  const text = sql.replace(/\s+/g, " ").trim();
  queries.push({ sql: text, params });
  await new Promise((resolve) => setTimeout(resolve, 1));
  if (failing?.test(text)) {
    if (appliedAnyway) apply(text, params);
    throw new Error("Connection lost");
  }
  return apply(text, params);
}

function apply(text: string, params: any[]): any {
  if (text === "SELECT permissions FROM permissions WHERE username = ?") {
    return tables.permissions.filter((r) => r.username === params[0]);
  }
  const probed = /^SELECT (\w+) FROM spells LIMIT 1$/.exec(text);
  if (probed) {
    if (missingColumns.has(probed[1]!)) throw new Error(`Unknown column '${probed[1]}' in 'field list'`);
    return [];
  }
  const added = /^ALTER TABLE spells ADD COLUMN (\w+) /.exec(text);
  if (added) {
    if (lockedSchema) throw new Error("ALTER command denied");
    missingColumns.delete(added[1]!);
    return [];
  }
  if (text.startsWith("SELECT DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS") && text.includes("COLUMN_NAME = 'cast_time'")) {
    return [{ type: wholeCastTime ? "int" : "double" }];
  }
  if (text === "ALTER TABLE spells MODIFY COLUMN cast_time DOUBLE NULL DEFAULT 0") {
    if (lockedSchema) throw new Error("ALTER command denied");
    wholeCastTime = false;
    return [];
  }
  if (text === STORED) return [...tables.spells].sort((a, b) => a.id - b.id).map((r) => ({ id: r.id, name: r.name }));
  if (text === REREAD) return tables.spells.map((r) => ({ ...r }));
  if (text.startsWith("INSERT INTO spells (") && text.includes("WHERE NOT EXISTS (SELECT 1 FROM spells WHERE name = ?)")) {
    const listed = text.slice("INSERT INTO spells (".length, text.indexOf(")")).split(", ").map((c) => c.replaceAll("`", ""));
    expect(params).toHaveLength(listed.length + 1);
    if (tables.spells.some((r) => sameName(r.name, params.at(-1)))) return answer({ affectedRows: 0, lastInsertRowid: 0 });
    const row: Row = { id: nextId++ };
    listed.forEach((column, i) => { row[column] = params[i]; });
    if (wholeCastTime) row.cast_time = Math.round(row.cast_time);
    tables.spells.push(row);
    return answer({ affectedRows: 1, lastInsertRowid: row.id });
  }
  if (text.startsWith("UPDATE spells SET ") && text.endsWith(" WHERE name = ?")) {
    const listed = text.slice("UPDATE spells SET ".length, -" WHERE name = ?".length).split(", ").map((c) => c.replace(" = ?", "").replaceAll("`", ""));
    expect(params).toHaveLength(listed.length + 1);
    const rows = tables.spells.filter((r) => sameName(r.name, params.at(-1)));
    for (const row of rows) {
      listed.forEach((column, i) => { row[column] = params[i]; });
      if (wholeCastTime) row.cast_time = Math.round(row.cast_time);
    }
    return answer({ affectedRows: rows.length });
  }
  if (text.startsWith("DELETE FROM spells WHERE name = ? AND NOT EXISTS (SELECT 1 FROM learned_spells WHERE spell = ?) AND NOT EXISTS (SELECT 1 FROM creature_abilities WHERE spell_id IN (?))")) {
    const [name, spell, ids] = params;
    if (tables.learned_spells.some((r) => sameName(r.spell, spell))) return answer({ affectedRows: 0 });
    if (tables.creature_abilities.some((r) => ids.includes(r.spell_id))) return answer({ affectedRows: 0 });
    const before = tables.spells.length;
    tables.spells = tables.spells.filter((r) => !sameName(r.name, name));
    return answer({ affectedRows: before - tables.spells.length });
  }
  if (text === USAGE) {
    return tables.learned_spells.filter((r) => sameName(r.spell, params[0])).map((r) => ({ username: r.username }));
  }
  if (text === "SELECT spell FROM learned_spells WHERE username = ?") {
    return tables.learned_spells.filter((r) => r.username === params[0]).map((r) => ({ spell: r.spell }));
  }
  if (text === "INSERT IGNORE INTO learned_spells (username, spell) VALUES (?, ?)") {
    tables.learned_spells.push({ username: params[0], spell: params[1] });
    return [];
  }
  if (text === "DELETE FROM learned_spells WHERE username = ? AND spell = ?") {
    tables.learned_spells = tables.learned_spells.filter((r) => !(r.username === params[0] && sameName(r.spell, params[1])));
    return [];
  }
  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => ({
  default: (sql: string, params: any[] = []) => run(sql, params),
}));

const cache = new Map<string, any>();
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => cache.get(key),
    set: async (key: string, value: any) => cache.set(key, value),
    add: async (key: string, value: any) => cache.set(key, value),
  },
}));

let handedToLoginWorkers = 0;
mock.module("../socket/authentication_pool", () => ({
  refreshAuthSpells: async () => { handedToLoginWorkers++; },
  refreshAuthItems: async () => {},
  getAuthWorker: async () => null,
  resetAuthWorker: () => {},
}));

const { default: log } = await import("../modules/logger");
const { default: playerCache } = await import("../services/playermanager");
const { default: spells } = await import("../systems/spells");
const editor = await import("../systems/spelleditor");

// ------------------------------------------------------------------ fixtures

const ADMIN = { id: "se-1", username: "boss", isGuest: false, permissions: ["server.admin"] };
const BUILDER = { id: "se-2", username: "builder", isGuest: false, permissions: ["tools.*"] };
const MODERATOR = { id: "se-3", username: "mod", isGuest: false, permissions: ["admin.*"] };

const spell = (over: Row = {}): Row => ({
  name: "shadow_burst", damage: 12, mana: 15, range: 800, type: "spell", cast_time: 2, cooldown: 20, can_move: 0,
  description: "Unleashes a burst of shadow.", icon: "shadow_burst", effects: [{ type: "slow", value: 25, duration: 4 }],
  particles: "shadow", aoe_radius: 0, ground_aoe: 0, ground_duration: 0, is_thrown: 0, charge_distance: 0, teleport_behind: 0,
  ...over,
});

/** A row as the database holds it and its cached twin, as the asset loader makes them at startup. */
function stored(id: number, over: Row = {}) {
  const base = spell(over);
  const row = { id, ...base, effects: JSON.stringify(base.effects), aoe_radius: base.aoe_radius || null };
  return { row, cached: { ...row, effects: base.effects } };
}

function resetWorld() {
  nextId = 100;
  wholeCastTime = false;
  lockedSchema = false;
  missingColumns = new Set();
  answers = true;
  failing = null;
  appliedAnyway = false;
  editor.NUMBER_FIELDS.cast_time!.decimals = 2; // as after a schema check that found fractions kept
  queries.length = 0;
  handedToLoginWorkers = 0;
  const frost = stored(1, { name: "frost_bolt", damage: 10, effects: [], particles: null, icon: "frost_bolt" });
  const poison = stored(2, { name: "poison_bolt", damage: 5, icon: "poison_bolt", effects: [{ type: "damage_over_time", value: 4, duration: 12, interval: 3, stackable: true, max_stacks: 5 }] });
  tables = {
    permissions: [
      { username: "boss", permissions: "server.admin,admin.kick" },
      // Enough for the content editors, not for this one.
      { username: "builder", permissions: "tools.*,admin.*" },
      { username: "smith", permissions: "tools.spell_editor" },
      { username: "mod", permissions: "admin.*,permission.*" },
      { username: "owner", permissions: "server.*" },
    ],
    spells: [frost.row, poison.row],
    learned_spells: [{ username: "hero", spell: "frost_bolt" }],
    creature_abilities: [{ id: 1, template_id: 7, spell_id: 2 }],
    creature_templates: [{ id: 7, name: "Venom Spider" }],
  };
  cache.set("spells", [
    // A plugin spell: cached, never stored.
    { name: "plugin_nova", damage: 20, mana: 25, range: 500, type: "spell", cast_time: 2, cooldown: 30, can_move: 0, effects: [] },
    frost.cached,
    poison.cached,
  ]);
  cache.set("particles", [{ name: "shadow" }, { name: "Frost Mist" }, { name: "bad,name" }]);
  // The creature tables, as the server holds them: which creature casts a spell is read from these.
  cache.set("creatureAbilities", tables.creature_abilities.map((r) => ({ ...r })));
  cache.set("creatureTemplates", tables.creature_templates.map((r) => ({ ...r })));
  for (const id of ["se-1", "se-2", "se-hero"]) playerCache.remove(id);
}

const sqls = () => queries.map((q) => q.sql);
/** The reads of the database that are not of the sender's permissions or of the schema. */
const reads = () => sqls().filter((sql) => sql.startsWith("SELECT") && !sql.startsWith("SELECT permissions") && !/^SELECT (\w+ FROM spells LIMIT 1|DATA_TYPE)/.test(sql));
/** What the server holds of the stored spells, set against the table. */
const heldAsStored = (): Row[] => (cache.get("spells") as SpellData[]).filter((s) => s.id !== undefined).map((s) => ({ ...s, effects: JSON.stringify(s.effects) }));

/** Put a player online with a connection that records what it is sent. */
function login(id: string, username: string, learnedSpells: Row = {}) {
  const sent: any[] = [];
  const live: Row = {
    id, username, learnedSpells, permissions: [],
    wt: { readyState: 1, send: (frame: Uint8Array) => sent.push(JSON.parse(new TextDecoder().decode(frame))) },
  };
  playerCache.add(id, live);
  return { live, sent };
}

const ctx = (over: Partial<Parameters<typeof editor.validateSpell>[1]> = {}) => ({
  existingNames: new Set(["frost_bolt", "poison_bolt"]),
  originalName: null,
  particles: ["shadow", "Frost Mist"],
  icons: [] as string[],
  ...over,
});

const fieldsOf = (errors: Array<{ field: string }>) => errors.map((e) => e.field);
const messageFor = (errors: Array<{ field: string; message: string }>, field: string) => errors.find((e) => e.field === field)?.message;
const act = async (admin: any, type: string, data: any) => {
  const result = await editor.handleEditorPacket(admin, type, data);
  if (result.kind !== "result") throw new Error(`Expected a result, got ${result.kind}`);
  return result;
};
const writes = () => queries.filter((q) => /^(INSERT|UPDATE|DELETE)/.test(q.sql));

// Each test starts from a different database: what the caches held of the last one is forgotten.
beforeEach(async () => {
  resetWorld();
  await (await import("../services/datacache")).clearCaches();
});

// ------------------------------------------------------------------- tests

describe("spell editor permissions", () => {
  test("admins, the tool's own permission and the wildcards pass, as for the other editors; other permissions, guests and nobody do not", async () => {
    expect(await editor.canUseEditor(ADMIN)).toBe(true);
    expect(await editor.canUseEditor({ username: "owner" })).toBe(true);
    expect(await editor.canUseEditor(BUILDER)).toBe(true);
    expect(await editor.canUseEditor({ username: "smith" })).toBe(true);
    // the admin role, whatever permissions are stored
    expect(await editor.canUseEditor({ username: "stranger", isAdmin: true })).toBe(true);
    expect(await editor.canUseEditor(MODERATOR)).toBe(false);
    expect(await editor.canUseEditor({ username: "stranger" })).toBe(false);
    expect(await editor.canUseEditor({ username: "boss", isGuest: true })).toBe(false);
    expect(await editor.canUseEditor(null)).toBe(false);
  });

  test("the database decides, not the permissions copied at login", async () => {
    tables.permissions[0].permissions = "admin.kick";
    expect(await editor.canUseEditor(ADMIN)).toBe(false);
  });

  test("every packet is refused without the permission, and nothing is read or written", async () => {
    queries.length = 0;
    for (const type of ["SPELL_EDITOR_LIST", "SPELL_EDITOR_SEARCH", "SPELL_EDITOR_SAVE", "SPELL_EDITOR_DELETE", "SPELL_EDITOR_LEARN"]) {
      const result = await act(MODERATOR, type, { ...spell(), name: "frost_bolt", query: "" });
      expect(result.ok).toBe(false);
      expect(result.denied).toBe(true);
      expect(result.errors).toEqual([editor.DENIED]);
    }
    // The sender's permissions were read once, for the first of them, and are held since.
    expect(queries.map((q) => q.sql)).toEqual(["SELECT permissions FROM permissions WHERE username = ?"]);
    expect(tables.spells).toHaveLength(2);
  });

  test("the reload notice goes to players who hold the permission", () => {
    expect(editor.mayHaveEditorOpen(ADMIN)).toBe(true);
    expect(editor.mayHaveEditorOpen({ permissions: ["server.*"] })).toBe(true);
    expect(editor.mayHaveEditorOpen(BUILDER)).toBe(true);
    expect(editor.mayHaveEditorOpen({ isAdmin: true, permissions: [] })).toBe(true);
    expect(editor.mayHaveEditorOpen(MODERATOR)).toBe(false);
    expect(editor.mayHaveEditorOpen(null)).toBe(false);
  });
});

describe("spell validation", () => {
  test("a valid spell passes", () => {
    expect(editor.validateSpell(spell(), ctx())).toEqual([]);
  });

  test("a new name is required, well formed and unused", () => {
    expect(messageFor(editor.validateSpell(spell({ name: "  " }), ctx()), "name")).toBe("Name is required.");
    expect(fieldsOf(editor.validateSpell(spell({ name: "x".repeat(editor.NAME_MAX + 1) }), ctx()))).toContain("name");
    expect(fieldsOf(editor.validateSpell(spell({ name: "bad\\name" }), ctx()))).toContain("name");
    expect(fieldsOf(editor.validateSpell(spell({ name: 'quote"d' }), ctx()))).toContain("name");
    // Case does not make a name new.
    expect(messageFor(editor.validateSpell(spell({ name: "Frost_Bolt" }), ctx()), "name")).toBe("A spell with that name already exists.");
  });

  test("an existing spell keeps its name", () => {
    expect(editor.validateSpell(spell({ name: "frost_bolt" }), ctx({ originalName: "frost_bolt" }))).toEqual([]);
    expect(messageFor(editor.validateSpell(spell({ name: "ice_bolt" }), ctx({ originalName: "frost_bolt" })), "name"))
      .toBe("A spell's name cannot be changed. Duplicate it to make a renamed copy.");
  });

  test("every number has limits, and only cast time takes fractions", () => {
    const bad: Array<[string, unknown]> = [
      ["damage", 100001], ["damage", -100001], ["damage", 1.5], ["damage", "lots"],
      ["mana", -1], ["mana", 1001], ["mana", 2.5],
      ["range", -1], ["range", 5001], ["range", true],
      ["cast_time", -0.5], ["cast_time", 61], ["cast_time", 1.234],
      ["cooldown", -1], ["cooldown", 86401], ["cooldown", 1.5],
      ["aoe_radius", -1], ["aoe_radius", 2001], ["aoe_radius", 0.5],
      ["ground_duration", -1], ["ground_duration", 601],
      ["charge_distance", -1], ["charge_distance", 2001], ["charge_distance", {}],
    ];
    for (const [field, value] of bad) {
      expect(fieldsOf(editor.validateSpell(spell({ [field]: value }), ctx()))).toContain(field);
    }
    expect(editor.validateSpell(spell({ cast_time: 1.5 }), ctx())).toEqual([]);
    expect(editor.validateSpell(spell({ cast_time: "2.25", damage: "-40", mana: "" }), ctx())).toEqual([]);
    expect(editor.validateSpell(spell({ damage: -100000, mana: 1000, range: 5000, cast_time: 60, cooldown: 86400 }), ctx())).toEqual([]);
  });

  test("the 0/1 flags take on or off and nothing else", () => {
    for (const field of ["can_move", "ground_aoe", "is_thrown", "teleport_behind"]) {
      expect(fieldsOf(editor.validateSpell(spell({ [field]: 2 }), ctx()))).toContain(field);
      expect(fieldsOf(editor.validateSpell(spell({ [field]: "yes" }), ctx()))).toContain(field);
    }
    expect(editor.validateSpell(spell({ can_move: true, teleport_behind: "1", is_thrown: false }), ctx())).toEqual([]);
  });

  test("description, type, icon and particles are checked", () => {
    expect(fieldsOf(editor.validateSpell(spell({ description: "x".repeat(256) }), ctx()))).toContain("description");
    // The database layer escapes quotes only: a backslash must never reach it.
    expect(fieldsOf(editor.validateSpell(spell({ description: "ends in a backslash \\" }), ctx()))).toContain("description");
    expect(editor.validateSpell(spell({ description: "It's two lines?\nYes." }), ctx())).toEqual([]);

    expect(fieldsOf(editor.validateSpell(spell({ type: "curse" }), ctx()))).toContain("type");

    expect(fieldsOf(editor.validateSpell(spell({ icon: "../secret" }), ctx()))).toContain("icon");
    expect(messageFor(editor.validateSpell(spell({ icon: "missing" }), ctx({ icons: ["shadow_burst"] })), "icon")).toBe("That icon is not on the asset server.");
    // An icon the spell already uses stays allowed, and so does any icon when the list could not be fetched.
    expect(editor.validateSpell(spell({ icon: "old_icon" }), ctx({ icons: ["shadow_burst"], stored: { icon: "old_icon" } as SpellData }))).toEqual([]);
    expect(editor.validateSpell(spell({ icon: "anything" }), ctx())).toEqual([]);
    expect(editor.validateSpell(spell({ icon: "" }), ctx())).toEqual([]);

    expect(messageFor(editor.validateSpell(spell({ particles: "shadow, sparkle" }), ctx()), "particles")).toBe('Particle "sparkle" does not exist.');
    expect(editor.validateSpell(spell({ particles: ["shadow", "frost mist"] }), ctx())).toEqual([]);
  });

  test("a spell that does nothing, or a ground spell with no area, is refused", () => {
    expect(messageFor(editor.validateSpell(spell({ damage: 0, effects: [] }), ctx()), "damage"))
      .toBe("A spell with no damage, no healing and no effects cannot be cast: give it one of them.");
    expect(editor.validateSpell(spell({ damage: 0 }), ctx())).toEqual([]);
    expect(editor.validateSpell(spell({ damage: -8, effects: [] }), ctx())).toEqual([]);
    expect(fieldsOf(editor.validateSpell(spell({ ground_aoe: 1, aoe_radius: 0 }), ctx()))).toContain("aoe_radius");
    expect(editor.validateSpell(spell({ ground_aoe: 1, aoe_radius: 150, ground_duration: 6, is_thrown: 1 }), ctx())).toEqual([]);
  });
});

describe("effect validation", () => {
  const withEffects = (...effects: any[]) => editor.validateSpell(spell({ effects }), ctx());

  test("the editor offers exactly the effect types the engine handles", () => {
    expect(editor.EFFECT_TYPES.map((t) => t.type)).toEqual([
      "damage_over_time", "heal_over_time", "absorbtion", "stun", "slow", "vanish", "interrupt", "visual", "taunt", "feign_death", "threat",
    ]);
  });

  test("a valid example of every type passes", () => {
    const valid: any[] = [
      { type: "damage_over_time", value: 4, duration: 12, interval: 3, stackable: true, max_stacks: 5, target_particles: "shadow" },
      { type: "absorbtion", value: 50, duration: 0 },
      { type: "stun", duration: 1.5 },
      { type: "slow", value: 50, duration: 5 },
      { type: "vanish", duration: 0 },
      { type: "interrupt", duration: 3 },
      { type: "visual", duration: 5, target_particles: "Frost Mist" },
      { type: "taunt", duration: 0 },
      { type: "feign_death" },
      { type: "threat", value: -100 },
    ];
    expect(withEffects(...valid)).toEqual([]);
    expect(withEffects({ type: "heal_over_time", value: 5, duration: 10, interval: 2 })).toEqual([]);
  });

  test("unknown types, a list that is not a list and too many effects are refused", () => {
    expect(fieldsOf(withEffects({ type: "polymorph", value: 1 }))).toEqual(["effects.0.type"]);
    expect(fieldsOf(withEffects(null))).toEqual(["effects.0.type"]);
    expect(fieldsOf(editor.validateSpell(spell({ effects: "stun" }), ctx()))).toEqual(["effects"]);
    const many = Array.from({ length: editor.MAX_EFFECTS + 1 }, () => ({ type: "feign_death" }));
    expect(fieldsOf(editor.validateSpell(spell({ effects: many }), ctx()))).toContain("effects");
  });

  test("each type's own fields are range-checked, by position in the list", () => {
    const bad: Array<[any, string]> = [
      [{ type: "damage_over_time", value: 0, duration: 12, interval: 3 }, "value"],
      [{ type: "damage_over_time", value: 4, duration: 0, interval: 3 }, "duration"],
      [{ type: "damage_over_time", value: 4, duration: 12, interval: 0 }, "interval"],
      [{ type: "damage_over_time", value: 4, duration: 12, interval: 3, stackable: "maybe" }, "stackable"],
      [{ type: "damage_over_time", value: 4, duration: 12, interval: 3, stackable: true, max_stacks: 0 }, "max_stacks"],
      [{ type: "heal_over_time", value: 2.5, duration: 10, interval: 2 }, "value"],
      [{ type: "absorbtion", value: 0, duration: 8 }, "value"],
      [{ type: "absorbtion", value: 50, duration: -1 }, "duration"],
      [{ type: "stun", duration: 0 }, "duration"],
      [{ type: "slow", value: 100, duration: 5 }, "value"],
      [{ type: "slow", value: 50, duration: 0 }, "duration"],
      [{ type: "vanish", duration: 3601 }, "duration"],
      [{ type: "interrupt", duration: -3 }, "duration"],
      [{ type: "visual", duration: 0 }, "duration"],
      [{ type: "visual", duration: 5, target_particles: "sparkle" }, "target_particles"],
      [{ type: "taunt", duration: "long" }, "duration"],
      [{ type: "threat", value: -101 }, "value"],
    ];
    for (const [effect, field] of bad) {
      expect(fieldsOf(withEffects({ type: "feign_death" }, effect))).toEqual([`effects.1.${field}`]);
    }
  });

  test("fields a type does not use are not checked, and max stacks only counts when stacking", () => {
    expect(withEffects({ type: "stun", duration: 3, value: "ignored", interval: -5 })).toEqual([]);
    expect(withEffects({ type: "damage_over_time", value: 4, duration: 12, interval: 3, stackable: false, max_stacks: 0 })).toEqual([]);
  });

  test("one effect of a type per spell, and damage and healing over time do not mix", () => {
    expect(messageFor(withEffects({ type: "stun", duration: 1 }, { type: "stun", duration: 2 }), "effects.1.type"))
      .toBe("Only one Stun effect per spell: a second one replaces the first.");
    expect(fieldsOf(withEffects(
      { type: "damage_over_time", value: 4, duration: 12, interval: 3 },
      { type: "heal_over_time", value: 4, duration: 12, interval: 3 }
    ))).toEqual(["effects.1.type"]);
  });
});

describe("spell normalization", () => {
  test("blank numbers become 0, flags become 0/1 and the type is the only one there is", () => {
    const row = editor.normalizeSpell({ name: "  mend  ", damage: "-40", mana: "", cast_time: "1.5", can_move: true, type: "cast", icon: "", description: "  Heals.  " });
    expect(row).toMatchObject({ name: "mend", damage: -40, mana: 0, range: 0, cast_time: 1.5, cooldown: 0, can_move: 1, type: "spell", icon: null, description: "Heals.", effects: [], particles: null, aoe_radius: null });
  });

  test("ground-only fields are cleared on a spell that is not ground targeted", () => {
    expect(editor.normalizeSpell({ ground_aoe: 0, ground_duration: 6, is_thrown: 1, aoe_radius: 150 }))
      .toMatchObject({ ground_aoe: 0, ground_duration: 0, is_thrown: 0, aoe_radius: 150 });
    expect(editor.normalizeSpell({ ground_aoe: 1, ground_duration: 6, is_thrown: 1, aoe_radius: 150 }))
      .toMatchObject({ ground_aoe: 1, ground_duration: 6, is_thrown: 1, aoe_radius: 150 });
  });

  test("particles are stored as the particle is spelled, without blanks or repeats", () => {
    expect(editor.normalizeSpell({ particles: " frost mist, shadow ,, SHADOW" }, ["shadow", "Frost Mist"]).particles).toBe("Frost Mist,shadow");
    expect(editor.particleList(["a", " b ", "", "A"])).toEqual(["a", "b"]);
  });

  test("an effect keeps only what its type reads", () => {
    expect(editor.normalizeEffect({ type: "stun", value: 9, duration: "1.5", interval: 3, stackable: true, junk: "x" }))
      .toEqual({ type: "stun", value: 0, duration: 1.5 });
    expect(editor.normalizeEffect({ type: "damage_over_time", value: 4, duration: 12, interval: 3, stackable: false, max_stacks: 9 }))
      .toEqual({ type: "damage_over_time", value: 4, duration: 12, interval: 3 });
    expect(editor.normalizeEffect({ type: "damage_over_time", value: 4, duration: 12, interval: 3, stackable: 1, max_stacks: 5, target_particles: "SHADOW" }, ["shadow"]))
      .toEqual({ type: "damage_over_time", value: 4, duration: 12, interval: 3, stackable: true, max_stacks: 5, target_particles: "shadow" });
    expect(editor.normalizeEffect({ type: "feign_death", duration: 4 })).toEqual({ type: "feign_death", value: 0 });
  });
});

describe("saving", () => {
  test("a new spell is inserted with every column and lands in the cache with its id", async () => {
    const result = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({
      cast_time: 1.5, aoe_radius: 150, ground_aoe: 1, ground_duration: 6, is_thrown: 1, charge_distance: 40, teleport_behind: 1, can_move: 1,
      particles: "shadow,frost mist", originalName: null,
    }));
    expect(result).toMatchObject({ ok: true, errors: [], name: "shadow_burst", changed: true });

    const insert = queries.find((q) => q.sql.startsWith("INSERT INTO spells"))!;
    expect(insert.sql).toContain("(name, damage, mana, `range`, type, cast_time, cooldown, can_move, description, icon, effects, particles, aoe_radius, ground_aoe, ground_duration, is_thrown, charge_distance, teleport_behind)");
    expect(insert.params).toEqual([
      "shadow_burst", 12, 15, 800, "spell", 1.5, 20, 1, "Unleashes a burst of shadow.", "shadow_burst",
      '[{"type":"slow","value":25,"duration":4}]', "shadow,Frost Mist", 150, 1, 6, 1, 40, 1, "shadow_burst",
    ]);

    const row = tables.spells.find((r) => r.name === "shadow_burst")!;
    expect(Object.keys(row).sort()).toEqual(["id", ...SPELL_COLUMNS].sort());
    const cached = (cache.get("spells") as SpellData[]).find((s) => s.name === "shadow_burst")!;
    expect(cached).toMatchObject({ id: 100, cast_time: 1.5, aoe_radius: 150, ground_aoe: 1, is_thrown: 1, teleport_behind: 1, effects: [{ type: "slow", value: 25, duration: 4 }] });
    expect(cache.get("spells")).toHaveLength(4);
    expect(handedToLoginWorkers).toBe(1);
  });

  test("an existing spell is updated in one statement that writes every column but its name", async () => {
    const result = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({
      name: "frost_bolt", originalName: "frost_bolt", damage: 30, cast_time: 2.5, cooldown: 4, range: 900, mana: 12, can_move: 1,
      description: "Colder.", icon: "frost_bolt", particles: null, aoe_radius: 90, charge_distance: 60,
      effects: [{ type: "slow", value: 40, duration: 3, target_particles: "Frost Mist" }],
    }));
    expect(result).toMatchObject({ ok: true, name: "frost_bolt", changed: true });

    expect(writes()).toHaveLength(1);
    const update = writes()[0];
    expect(update.sql).toBe(`UPDATE spells SET ${SPELL_COLUMNS.slice(1).map((c) => (c === "range" ? "`range` = ?" : `${c} = ?`)).join(", ")} WHERE name = ?`);
    expect(update.params).toEqual([
      30, 12, 900, "spell", 2.5, 4, 1, "Colder.", "frost_bolt", '[{"type":"slow","value":40,"duration":3,"target_particles":"Frost Mist"}]',
      null, 90, 0, 0, 0, 60, 0, "frost_bolt",
    ]);

    const cached = (cache.get("spells") as SpellData[]).find((s) => s.name === "frost_bolt")!;
    // Same id: cooldowns and creature abilities refer to it.
    expect(cached).toMatchObject({ id: 1, damage: 30, cast_time: 2.5, aoe_radius: 90, charge_distance: 60 });
    expect(cached.effects).toEqual([{ type: "slow", value: 40, duration: 3, target_particles: "Frost Mist" }]);
    expect(cache.get("spells")).toHaveLength(3);
  });

  test("invalid input reports each field and writes nothing", async () => {
    const result = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ damage: "lots", mana: -1, effects: [{ type: "slow", value: 500, duration: 5 }], originalName: null }));
    expect(result.ok).toBe(false);
    expect(Object.keys(result.fields!).sort()).toEqual(["damage", "effects.0.value", "mana"]);
    expect(result.errors).toHaveLength(3);
    expect(writes()).toHaveLength(0);
    expect(handedToLoginWorkers).toBe(0);
  });

  test("a rename, a taken name and a spell that is gone are refused", async () => {
    const renamed = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ name: "ice_bolt", originalName: "frost_bolt" }));
    expect(renamed.fields).toEqual({ name: "A spell's name cannot be changed. Duplicate it to make a renamed copy." });

    const taken = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ name: "poison_bolt", originalName: null }));
    expect(taken.fields).toEqual({ name: "A spell with that name already exists." });

    const gone = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ name: "old_spell", originalName: "old_spell" }));
    expect(gone.ok).toBe(false);
    expect(writes()).toHaveLength(0);
    // Each was refused from the spells held: the database was not asked.
    expect(reads()).toEqual([]);
  });

  test("a name is taken in any case, as the database would find it", async () => {
    const taken = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ name: "Poison_Bolt", originalName: null }));
    expect(taken.fields).toEqual({ name: "A spell with that name already exists." });
    expect(writes()).toHaveLength(0);
  });

  test("a row put into the database by hand while the server runs is still not given a second: the statement refuses, and says so", async () => {
    await editor.searchSpells("");
    tables.spells.push({ id: 50, name: "by_hand" });
    const byHand = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ name: "by_hand", originalName: null }));
    expect(byHand.ok).toBe(false);
    expect(byHand.fields).toEqual({ name: "A spell with that name already exists." });
    expect(tables.spells.filter((r) => r.name === "by_hand")).toHaveLength(1);
    expect((cache.get("spells") as SpellData[]).some((s) => s.name === "by_hand")).toBe(false);
    expect(handedToLoginWorkers).toBe(0);
  });

  test("a new spell's id is the one the INSERT answers with; when its answer says nothing, the stored spells are read again for it", async () => {
    await editor.searchSpells("");
    queries.length = 0;
    expect((await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ originalName: null }))).ok).toBe(true);
    expect((cache.get("spells") as SpellData[]).find((s) => s.name === "shadow_burst")!.id).toBe(100);
    expect(reads()).toEqual([]);

    answers = false;
    expect((await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ name: "shadow_wave", originalName: null }))).ok).toBe(true);
    expect((cache.get("spells") as SpellData[]).find((s) => s.name === "shadow_wave")!.id).toBe(101);
    expect(reads()).toEqual([STORED]);
    // Both are stored spells now, by what is held.
    queries.length = 0;
    expect((await editor.searchSpells("shadow")).spells.map((s) => [s.name, s.id, s.plugin])).toEqual([["shadow_burst", 100, false], ["shadow_wave", 101, false]]);
    expect(reads()).toEqual([]);
  });

  test("what is held after a save is what the table holds", async () => {
    await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ cast_time: 1.5, aoe_radius: 150, ground_aoe: 1, ground_duration: 6, particles: "shadow,frost mist", originalName: null }));
    await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ name: "frost_bolt", originalName: "frost_bolt", damage: 30, description: "Colder.", effects: [{ type: "slow", value: 40, duration: 3 }] }));
    expect(heldAsStored()).toEqual(tables.spells);
    expect(heldAsStored()).toHaveLength(3);
  });

  for (const applied of [false, true]) {
    test(`a save the database refused${applied ? ", though it had applied it" : ""}: the spells are read again, and what is held and handed on is what the table holds`, async () => {
      await editor.searchSpells("");
      queries.length = 0;
      failing = /^(UPDATE spells|INSERT INTO spells)/;
      appliedAnyway = applied;
      const logged = spyOn(log, "error").mockImplementation(() => {});
      try {
        const changed = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ name: "frost_bolt", originalName: "frost_bolt", damage: 30 }));
        expect(changed.errors).toEqual(["The server could not do that: Connection lost"]);
        expect(reads()).toEqual([REREAD]);
        const added = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ originalName: null }));
        expect(added.ok).toBe(false);
      } finally {
        logged.mockRestore();
      }
      failing = null;

      expect(heldAsStored()).toEqual(tables.spells);
      expect((cache.get("spells") as SpellData[]).map((s) => [s.name, s.damage])).toEqual(
        applied ? [["plugin_nova", 20], ["frost_bolt", 30], ["poison_bolt", 5], ["shadow_burst", 12]] : [["plugin_nova", 20], ["frost_bolt", 10], ["poison_bolt", 5]]
      );
      expect(handedToLoginWorkers).toBe(2);
      // Which spells are stored is read again by whoever next asks, once.
      queries.length = 0;
      expect((await editor.searchSpells("")).spells.map((s) => [s.name, s.plugin])).toEqual(
        applied ? [["frost_bolt", false], ["plugin_nova", true], ["poison_bolt", false], ["shadow_burst", false]] : [["frost_bolt", false], ["plugin_nova", true], ["poison_bolt", false]]
      );
      await editor.searchSpells("");
      expect(reads()).toEqual([STORED]);
    });
  }

  test("the same create request arriving twice makes one row", async () => {
    const request = spell({ originalName: null });
    const [first, second] = await Promise.all([
      act(ADMIN, "SPELL_EDITOR_SAVE", request),
      act(ADMIN, "SPELL_EDITOR_SAVE", request),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.fields).toEqual({ name: "A spell with that name already exists." });
    expect(queries.filter((q) => q.sql.startsWith("INSERT INTO spells"))).toHaveLength(1);
    expect(tables.spells.filter((r) => r.name === "shadow_burst")).toHaveLength(1);
    expect((cache.get("spells") as SpellData[]).filter((s) => s.name === "shadow_burst")).toHaveLength(1);
  });

  test("two admins saving one spell at once both land whole, the later one last", async () => {
    const [first, second] = await Promise.all([
      act(ADMIN, "SPELL_EDITOR_SAVE", spell({ name: "frost_bolt", originalName: "frost_bolt", damage: 11, cooldown: 3 })),
      act({ username: "owner" }, "SPELL_EDITOR_SAVE", spell({ name: "frost_bolt", originalName: "frost_bolt", damage: 22, cooldown: 9 })),
    ]);
    expect(first.ok && second.ok).toBe(true);
    expect(tables.spells.filter((r) => r.name === "frost_bolt")).toHaveLength(1);
    expect(tables.spells.find((r) => r.name === "frost_bolt")).toMatchObject({ damage: 22, cooldown: 9 });
    expect((cache.get("spells") as SpellData[]).find((s) => s.name === "frost_bolt")).toMatchObject({ id: 1, damage: 22, cooldown: 9 });
  });

  test("the statement that inserts refuses a second row by itself", async () => {
    // What a second server process sharing the database would do in the gap between check and write.
    const params = ["dupe", 1, 0, 0, "spell", 0, 0, 0, "", null, "[]", null, null, 0, 0, 0, 0, 0, "dupe"];
    const sql = `INSERT INTO spells (${SPELL_COLUMNS.map((c) => (c === "range" ? "`range`" : c)).join(", ")}) SELECT * FROM (SELECT ${SPELL_COLUMNS.map((_, i) => `? AS c${i}`).join(", ")}) AS incoming WHERE NOT EXISTS (SELECT 1 FROM spells WHERE name = ?)`;
    await run(sql, params);
    await run(sql, params);
    expect(tables.spells.filter((r) => r.name === "dupe")).toHaveLength(1);
  });

  test("a database whose cast time holds whole seconds is changed when the editor opens, and 1.5 is then stored as 1.5", async () => {
    wholeCastTime = true;
    const opened = await editor.handleEditorPacket(ADMIN, "SPELL_EDITOR_LIST", null);
    expect(queries.some((q) => q.sql === "ALTER TABLE spells MODIFY COLUMN cast_time DOUBLE NULL DEFAULT 0")).toBe(true);
    expect((opened as any).data.numbers.cast_time.decimals).toBe(2);

    const result = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ cast_time: 1.5, originalName: null }));
    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(tables.spells.find((r) => r.name === "shadow_burst")!.cast_time).toBe(1.5);
    expect((cache.get("spells") as SpellData[]).find((s) => s.name === "shadow_burst")!.cast_time).toBe(1.5);
  });

  test("where that column cannot be changed the editor takes whole seconds: 1.5 is refused at the field and nothing is stored rounded", async () => {
    wholeCastTime = true;
    lockedSchema = true;
    const opened = await editor.handleEditorPacket(ADMIN, "SPELL_EDITOR_LIST", null);
    expect((opened as any).data.numbers.cast_time.decimals).toBe(0);

    const refused = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ cast_time: 1.5, originalName: null }));
    expect(refused.ok).toBe(false);
    expect(refused.fields).toEqual({ cast_time: "Cast time must be a whole number." });
    expect(tables.spells.some((r) => r.name === "shadow_burst")).toBe(false);

    const whole = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ cast_time: 2, originalName: null }));
    expect(whole.ok).toBe(true);
    expect(tables.spells.find((r) => r.name === "shadow_burst")!.cast_time).toBe(2);
  });

  test("columns the table was set up without are added when the editor opens", async () => {
    missingColumns = new Set(["is_thrown", "teleport_behind"]);
    await editor.handleEditorPacket(ADMIN, "SPELL_EDITOR_LIST", null);
    expect(queries.filter((q) => q.sql.startsWith("ALTER TABLE spells ADD COLUMN")).map((q) => q.sql)).toEqual([
      "ALTER TABLE spells ADD COLUMN is_thrown INT NULL DEFAULT 0",
      "ALTER TABLE spells ADD COLUMN teleport_behind INT NULL DEFAULT 0",
    ]);
    expect(missingColumns.size).toBe(0);
  });

  test("a plugin spell cannot be saved", async () => {
    const result = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ name: "plugin_nova", originalName: "plugin_nova" }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("comes from a plugin");
    expect(writes()).toHaveLength(0);
  });

  test("a database error is reported and leaves the cache alone", async () => {
    tables.spells = undefined as any;
    const result = await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ originalName: null }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("The server could not do that");
    expect(cache.get("spells")).toHaveLength(3);
  });

  test("online players who know the spell get their spell book again with the new values", async () => {
    const hero = login("se-hero", "hero", { frost_bolt: { icon: "frost_bolt", damage: 10, cooldown: 1 } });
    const bystander = login("se-2", "builder", {});

    await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ name: "frost_bolt", originalName: "frost_bolt", damage: 30, cooldown: 4, icon: "frost_bolt" }));

    expect(hero.sent.map((p) => p.type)).toEqual(["SPELLS"]);
    expect(hero.sent[0].data.frost_bolt).toMatchObject({ damage: 30, cooldown: 4 });
    expect(hero.live.learnedSpells.frost_bolt).toMatchObject({ damage: 30, cooldown: 4 });
    expect(bystander.sent).toEqual([]);
  });
});

describe("deleting", () => {
  test("a spell nobody knows and no creature casts is deleted, from the cache too", async () => {
    tables.spells.push(stored(3, { name: "old_spell" }).row);
    (cache.get("spells") as any[]).push(stored(3, { name: "old_spell" }).cached);

    const result = await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "old_spell" });

    expect(result).toMatchObject({ ok: true, name: "old_spell", changed: true });
    expect(tables.spells.map((r) => r.name)).toEqual(["frost_bolt", "poison_bolt"]);
    expect((cache.get("spells") as SpellData[]).map((s) => s.name)).toEqual(["plugin_nova", "frost_bolt", "poison_bolt"]);
    expect(handedToLoginWorkers).toBe(1);
  });

  test("a spell a player knows is kept, and the reply names them", async () => {
    tables.learned_spells.push({ username: "ally", spell: "frost_bolt" });
    const result = await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "frost_bolt" });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "frost_bolt is still in use and was not deleted.",
      "Known by 2 players: hero, ally. Remove it from them in the player editor first.",
    ]);
    expect(writes()).toHaveLength(0);
    expect(tables.spells).toHaveLength(2);
    expect(cache.get("spells")).toHaveLength(3);
  });

  test("a spell a creature casts is kept, and the reply names the creature", async () => {
    const result = await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "poison_bolt" });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "poison_bolt is still in use and was not deleted.",
      "Cast by 1 creature: Venom Spider. Remove the ability in the creature editor first.",
    ]);
    expect(writes()).toHaveLength(0);
  });

  test("the statement that deletes checks again, so a spell learned in between stays", async () => {
    tables.spells.push(stored(3, { name: "old_spell" }).row);
    await run(
      "DELETE FROM spells WHERE name = ? AND NOT EXISTS (SELECT 1 FROM learned_spells WHERE spell = ?) AND NOT EXISTS (SELECT 1 FROM creature_abilities WHERE spell_id IN (?))",
      ["frost_bolt", "frost_bolt", [1]]
    );
    expect(tables.spells.map((r) => r.name)).toContain("frost_bolt");
  });

  test("the same delete arriving twice deletes once and says so the second time", async () => {
    tables.spells.push(stored(3, { name: "old_spell" }).row);
    (cache.get("spells") as any[]).push(stored(3, { name: "old_spell" }).cached);
    const [first, second] = await Promise.all([
      act(ADMIN, "SPELL_EDITOR_DELETE", { name: "old_spell" }),
      act(ADMIN, "SPELL_EDITOR_DELETE", { name: "old_spell" }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  test("a plugin spell, an unknown spell and no name are refused", async () => {
    expect((await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "plugin_nova" })).errors[0]).toContain("comes from a plugin");
    expect((await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "nope" })).ok).toBe(false);
    expect((await act(ADMIN, "SPELL_EDITOR_DELETE", {})).errors).toEqual(["Nothing selected."]);
    expect(writes()).toHaveLength(0);
    expect(cache.get("spells")).toHaveLength(3);
  });

  /** A third stored spell, which nobody knows and no creature casts. */
  const withOldSpell = () => {
    tables.spells.push(stored(3, { name: "old_spell" }).row);
    (cache.get("spells") as any[]).push(stored(3, { name: "old_spell" }).cached);
  };

  test("who knows a spell is read from the database the first time it is asked, and not again", async () => {
    await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "frost_bolt" });
    expect(reads()).toEqual([STORED, USAGE]);
    const again = await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "frost_bolt" });
    expect(again.errors[1]).toBe("Known by 1 player: hero. Remove it from them in the player editor first.");
    expect(reads()).toEqual([STORED, USAGE]);
    // Which creature casts a spell is read from the creatures the server holds.
    await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "poison_bolt" });
    expect(reads()).toEqual([STORED, USAGE, USAGE]);
    expect(queries.filter((q) => q.sql === USAGE).map((q) => q.params)).toEqual([["frost_bolt"], ["poison_bolt"]]);
  });

  test("it is read again once anyone learns or unlearns the spell", async () => {
    withOldSpell();
    await spells.learnSpell("ally", "old_spell");
    expect((await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "old_spell" })).errors[1]).toBe("Known by 1 player: ally. Remove it from them in the player editor first.");

    await spells.learnSpell("hero", "old_spell");
    expect((await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "old_spell" })).errors[1]).toBe("Known by 2 players: ally, hero. Remove it from them in the player editor first.");

    await spells.unlearnSpell("ally", "old_spell");
    await spells.unlearnSpell("hero", "OLD_SPELL");
    expect(queries.filter((q) => q.sql === USAGE)).toHaveLength(2);
    expect((await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "old_spell" })).ok).toBe(true);
    expect(queries.filter((q) => q.sql === USAGE)).toHaveLength(3);
  });

  test("a save and a search are answered from what is held; a delete reads only who knows the spell, the first time it is asked", async () => {
    withOldSpell();
    // The stored spells are held from here on (in the server, from startup).
    await editor.searchSpells("");
    queries.length = 0;

    expect((await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ originalName: null }))).ok).toBe(true);
    expect((await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ originalName: "shadow_burst", damage: 40 }))).ok).toBe(true);
    expect((await editor.searchSpells("")).spells.map((s) => [s.name, s.plugin]))
      .toEqual([["frost_bolt", false], ["old_spell", false], ["plugin_nova", true], ["poison_bolt", false], ["shadow_burst", false]]);
    expect(reads()).toEqual([]);

    expect((await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "old_spell" })).ok).toBe(true);
    expect(reads()).toEqual([USAGE]);
    expect((await editor.searchSpells("old")).spells).toEqual([]);
    expect(reads()).toEqual([USAGE]);
    expect(writes().map((q) => q.sql.split(" ").slice(0, 3).join(" "))).toEqual(["INSERT INTO spells", "UPDATE spells SET", "DELETE FROM spells"]);
  });

  test("a delete whose answer does not say what it did has the stored spells read again to see", async () => {
    withOldSpell();
    answers = false;
    await editor.searchSpells("");
    queries.length = 0;
    expect((await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "old_spell" })).ok).toBe(true);
    expect(reads()).toEqual([USAGE, STORED]);
    expect((cache.get("spells") as SpellData[]).map((s) => s.name)).toEqual(["plugin_nova", "frost_bolt", "poison_bolt"]);
  });

  for (const said of [true, false]) {
    test(`a spell learned between the check and the statement stays, and the reply names who knows it${said ? "" : " (an answer that says nothing)"}`, async () => {
      withOldSpell();
      answers = said;
      // Asked about while a creature still cast it: nobody knew it then, and that is what is held.
      cache.get("creatureAbilities").push({ id: 2, template_id: 7, spell_id: 3 });
      expect((await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "old_spell" })).errors[1]).toContain("Cast by 1 creature");
      cache.get("creatureAbilities").pop();
      // Then learned where this server does not see it (on another server of the same database, say).
      tables.learned_spells.push({ username: "rival", spell: "old_spell" });

      const result = await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "old_spell" });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual([
        "old_spell is still in use and was not deleted.",
        "Known by 1 player: rival. Remove it from them in the player editor first.",
      ]);
      expect(tables.spells.some((r) => r.name === "old_spell")).toBe(true);
      expect((cache.get("spells") as SpellData[]).some((s) => s.name === "old_spell")).toBe(true);
      // It is still a stored spell, by what is held.
      expect((await editor.searchSpells("old")).spells.map((s) => [s.name, s.plugin])).toEqual([["old_spell", false]]);
    });
  }

  for (const applied of [false, true]) {
    test(`a delete the database refused${applied ? ", though it had applied it" : ""}: the spells are read again, and what is held is what the table holds`, async () => {
      withOldSpell();
      await editor.searchSpells("");
      failing = /^DELETE FROM spells/;
      appliedAnyway = applied;
      const logged = spyOn(log, "error").mockImplementation(() => {});
      try {
        const result = await act(ADMIN, "SPELL_EDITOR_DELETE", { name: "old_spell" });
        expect(result.errors).toEqual(["The server could not do that: Connection lost"]);
      } finally {
        logged.mockRestore();
      }
      failing = null;

      expect(heldAsStored()).toEqual(tables.spells);
      expect((cache.get("spells") as SpellData[]).map((s) => s.name)).toEqual(applied ? ["plugin_nova", "frost_bolt", "poison_bolt"] : ["plugin_nova", "frost_bolt", "poison_bolt", "old_spell"]);
      expect((await editor.searchSpells("old")).spells.map((s) => s.name)).toEqual(applied ? [] : ["old_spell"]);
    });
  }
});

describe("learning", () => {
  test("the admin learns a saved spell and gets their spell book", async () => {
    const boss = login("se-1", "boss");
    const result = await act(boss.live, "SPELL_EDITOR_LEARN", { name: "poison_bolt" });
    expect(result).toMatchObject({ ok: true, name: "poison_bolt" });
    expect(result.changed).toBeUndefined();
    expect(tables.learned_spells).toContainEqual({ username: "boss", spell: "poison_bolt" });
    expect(boss.live.learnedSpells.poison_bolt).toMatchObject({ damage: 5, icon: "poison_bolt" });
    expect(boss.sent.map((p) => p.type)).toEqual(["SPELLS"]);
    expect(Object.keys(boss.sent[0].data)).toEqual(["poison_bolt"]);
  });

  test("learning twice, even at once, makes one row", async () => {
    const boss = login("se-1", "boss");
    const [first, second] = await Promise.all([
      act(boss.live, "SPELL_EDITOR_LEARN", { name: "poison_bolt" }),
      act(boss.live, "SPELL_EDITOR_LEARN", { name: "poison_bolt" }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.errors).toEqual(["You already know poison_bolt."]);
    expect(tables.learned_spells.filter((r) => r.username === "boss")).toHaveLength(1);
  });

  test("a spell that was never saved cannot be learned", async () => {
    const result = await act(ADMIN, "SPELL_EDITOR_LEARN", { name: "draft" });
    expect(result.ok).toBe(false);
    expect(writes()).toHaveLength(0);
  });
});

describe("editor packets", () => {
  test("opening the editor sends the rules and pick lists, not the spells", async () => {
    const result = await editor.handleEditorPacket(ADMIN, "SPELL_EDITOR_LIST", null);
    expect(result.kind).toBe("data");
    if (result.kind !== "data") return;
    expect(result.data.spellCount).toBe(3);
    expect((result.data as any).spells).toBeUndefined();
    expect(result.data.types).toEqual(["spell"]);
    expect(result.data.effectTypes).toBe(editor.EFFECT_TYPES);
    expect(Object.keys(result.data.numbers)).toEqual(["damage", "mana", "range", "cast_time", "cooldown", "aoe_radius", "ground_duration", "charge_distance"]);
    // A particle whose name could not sit in a comma-separated list is not offered.
    expect(result.data.particles).toEqual(["Frost Mist", "shadow"]);
  });

  test("opening the editor asks the database for nothing but the shape of the spells table", async () => {
    const result = await editor.handleEditorPacket(ADMIN, "SPELL_EDITOR_LIST", null);
    expect(result.kind).toBe("data");
    expect(reads()).toEqual([]);
    expect(sqls().filter((sql) => /^SELECT \w+ FROM spells LIMIT 1$/.test(sql))).toHaveLength(5);
  });

  test("an empty search lists every spell, and plugin spells are marked", async () => {
    const result = await editor.handleEditorPacket(ADMIN, "SPELL_EDITOR_SEARCH", { query: "" });
    expect(result.kind).toBe("search");
    if (result.kind !== "search") return;
    expect(result.data.spells.map((s) => [s.name, s.plugin])).toEqual([["frost_bolt", false], ["plugin_nova", true], ["poison_bolt", false]]);
    expect(result.data.truncated).toBe(0);
    expect(result.data.spells[2]).toMatchObject({ id: 2, damage: 5, aoe_radius: 0, ground_aoe: 0, effects: [{ type: "damage_over_time" }] });
  });

  test("a search matches anywhere in the name, prefix matches first, whatever the case", async () => {
    const result = await editor.searchSpells("BOLT");
    expect(result.spells.map((s) => s.name)).toEqual(["frost_bolt", "poison_bolt"]);
    expect((await editor.searchSpells("po")).spells.map((s) => s.name)).toEqual(["poison_bolt"]);
    expect((await editor.searchSpells("zzz")).spells).toEqual([]);
  });

  test("a search also returns the open spell as it is now, whether or not it matches", async () => {
    const result = await editor.searchSpells("po", "frost_bolt");
    expect(result.spells.map((s) => s.name)).toEqual(["poison_bolt"]);
    expect(result.name).toBe("frost_bolt");
    expect(result.open).toMatchObject({ name: "frost_bolt", damage: 10, plugin: false });
    // Deleted from another editor meanwhile: named, but gone.
    expect(await editor.searchSpells("", "old_spell")).toMatchObject({ name: "old_spell", open: null });
    expect((await editor.searchSpells("")).name).toBeNull();
  });

  test("a new spell stops being marked as a plugin spell once it is saved", async () => {
    await editor.handleEditorPacket(ADMIN, "SPELL_EDITOR_LIST", null);
    await act(ADMIN, "SPELL_EDITOR_SAVE", spell({ originalName: null }));
    const result = await editor.searchSpells("shadow");
    expect(result.spells.map((s) => [s.name, s.plugin])).toEqual([["shadow_burst", false]]);
  });

  test("an unknown action is rejected", async () => {
    const result = await act(ADMIN, "SPELL_EDITOR_NONSENSE", {});
    expect(result.ok).toBe(false);
  });
});
