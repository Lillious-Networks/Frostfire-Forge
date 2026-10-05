import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// ------------------------------------------------------------ fake database
// A few statement shapes are all the systems use, so the fake runs them for
// real against in-memory tables instead of answering query by query.

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let nextId: number;
const queries: string[] = [];

/** Columns that make a row unique, for INSERT IGNORE / ON DUPLICATE KEY. */
const KEYS: Record<string, string[]> = {
  permissions: ["username"],
  currency: ["username"],
  friendslist: ["username"],
  quest_log: ["username", "quest_id"],
};

function literal(token: string, args: any[]): any {
  if (token === "?") return args.shift();
  if (token === "NULL") return null;
  if (token.startsWith("'")) return token.slice(1, -1);
  return Number(token);
}

function where(clause: string | undefined, args: any[]): (row: Row) => boolean {
  if (!clause) return () => true;
  const tests = clause.split(" AND ").map((part) => {
    const [, column, op, rhs] = part.match(/^(?:\w+\.)?(\w+) (=|!=|LIKE|IN) (.+)$/)!;
    if (op === "IN") {
      const values = rhs.slice(1, -1).split(", ").map((token) => literal(token, args));
      return (row: Row) => values.includes(row[column]);
    }
    const wanted = literal(rhs, args);
    if (op === "LIKE") return (row: Row) => String(row[column]).includes(String(wanted).replaceAll("%", ""));
    // Loose on purpose: ids arrive as numbers and as strings.
    return (row: Row) => (op === "=") === (row[column] == wanted);
  });
  return (row) => tests.every((passes) => passes(row));
}

function assignments(clause: string, args: any[]): Array<(row: Row) => void> {
  return clause.split(", ").map((part) => {
    const [, column, rhs] = part.match(/^(\w+) = (.+)$/)!;
    if (rhs.startsWith("!")) return (row: Row) => { row[column] = row[rhs.slice(1)] ? 0 : 1; };
    const value = literal(rhs, args);
    return (row: Row) => { row[column] = value; };
  });
}

/** Statements the fake database refuses, for a test of a write that fails. */
let refused: RegExp | null = null;

function run(sql: string, params: any[] = []): any {
  const text = sql.replace(/\s+/g, " ").trim();
  const args = [...params];
  queries.push(text);
  if (refused?.test(text)) throw new Error("database gone");

  const select = text.match(/^SELECT (.+?) FROM (\w+)(?: \w+)?(?: WHERE (.+?))?(?: ORDER BY .+?)?(?: LIMIT (\d+))?$/);
  if (select) {
    const [, columns, table, clause, limit] = select;
    const aliases = columns.split(", ").map((c) => c.match(/^(?:\w+\.)?(\w+) AS (\w+)$/i)).filter(Boolean) as RegExpMatchArray[];
    const rows = (tables[table] || []).filter(where(clause, args)).map((row) => {
      const copy = { ...row };
      for (const [, column, alias] of aliases) copy[alias] = row[column];
      return copy;
    });
    return limit ? rows.slice(0, Number(limit)) : rows;
  }

  const insert = text.match(/^INSERT (IGNORE )?INTO (\w+) \((.+?)\) VALUES \((.+?)\)(?: ON DUPLICATE KEY UPDATE (.+))?$/);
  if (insert) {
    const [, ignore, table, columns, values, onDuplicate] = insert;
    const tokens = values.split(", ");
    const row: Row = {};
    columns.split(", ").forEach((column, i) => { row[column] = literal(tokens[i], args); });
    const existing = KEYS[table] && tables[table].find((r) => KEYS[table].every((key) => r[key] == row[key]));
    if (existing && ignore) return { affectedRows: 0 };
    if (existing && onDuplicate) {
      for (const assign of assignments(onDuplicate, args)) assign(existing);
      return { affectedRows: 2 };
    }
    const id = nextId++;
    if (table === "parties" || table === "guilds") row.id = id;
    tables[table].push(row);
    return { affectedRows: 1, lastInsertRowid: id };
  }

  const update = text.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/);
  if (update) {
    const [, table, sets, clause] = update;
    const apply = assignments(sets, args);
    const rows = tables[table].filter(where(clause, args));
    for (const row of rows) for (const assign of apply) assign(row);
    return { affectedRows: rows.length };
  }

  const remove = text.match(/^DELETE FROM (\w+) WHERE (.+)$/);
  if (remove) {
    const [, table, clause] = remove;
    const matches = where(clause, args);
    const before = tables[table].length;
    tables[table] = tables[table].filter((row) => !matches(row));
    return { affectedRows: before - tables[table].length };
  }

  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, params: any[] = []) => run(sql, params),
}));

const item = (name: string, over: Partial<Item> = {}): Item => ({
  name, quality: "common", type: "equipment", description: "", icon: name.toLowerCase().replaceAll(" ", "_"),
  stat_armor: null, stat_damage: null, stat_critical_chance: null, stat_critical_damage: null, stat_health: null,
  stat_stamina: null, stat_avoidance: null, level_requirement: 1, equipable: true, equipment_slot: null,
  bag_slots: null, damage_min: null, damage_max: null, attack_speed_ms: null, ...over,
});

const quest = (id: number, name: string): Quest => ({
  id, name, zone: null, offer_text: "", description: "", progress_text: "", completion_text: "",
  required_level: 1, quest_level: 1, xp_reward: 0, copper_reward: 0, repeatable: "none", next_quest_id: null, sort_order: 0,
  objectives: [{ id: id * 10, quest_id: id, sort_order: 0, type: "kill", target: "1", required_count: 3, target_x: null, target_y: null, target_radius: null, description: "Rats slain" }],
  rewards: [], prerequisites: [],
});

const assets = new Map<string, any>([
  ["items", [
    item("Iron Helmet", { equipment_slot: "helmet", stat_health: 20, stat_armor: 5 }),
    item("Leather Cap", { equipment_slot: "helmet" }),
    item("Wooden Staff", { equipment_slot: "weapon" }),
    item("Health Potion", { type: "consumable", equipable: false }),
  ]],
  ["mounts", [{ name: "unicorn", description: "", particles: null, icon: "mount_unicorn" }, { name: "wolf", description: "", particles: null, icon: null }]],
  ["spells", [{ id: 1, name: "frost_bolt", icon: "frost_bolt", mana: 5 }, { id: 2, name: "fireball", icon: "fireball", mana: 10 }]],
  ["mapProperties", [{ name: "overworld.json", width: 100, height: 50, tileWidth: 32, tileHeight: 32 }]],
  ["npcs", []],
]);
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => assets.get(key),
    set: async (key: string, value: any) => assets.set(key, value),
    add: async (key: string, value: any) => assets.set(key, value),
  },
}));

const { default: playerCache } = await import("../services/playermanager");
const { clearCaches } = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
const { listener, Events } = await import("../systems/events");
const defs = await import("../systems/quests/definitions");
const editor = await import("../systems/playereditor");
const { default: permissions } = await import("../systems/permissions");
const { default: player } = await import("../systems/player");

const quests = [quest(1, "Rats in the Cellar"), quest(2, "Aftermath")];
defs.setCachedQuestsSync(quests);
defs.setIndexesForTests(defs.buildIndexes(quests, []));

// ------------------------------------------------------------------ fixtures

const account = (id: number, username: string, over: Row = {}): Row => ({
  id, username, session_id: null, banned: 0, role: 0, guest_mode: 0, stealth: 0, noclip: 0, party_id: null,
  guild_id: null, is_dead: 0, corpse_map: null, corpse_x: null, corpse_y: null, map: "overworld", position: "320,480", direction: "down", ...over,
});
const stats = (username: string): Row => ({
  username, health: 80, max_health: 100, stamina: 60, max_stamina: 100, xp: 40, max_xp: 100, level: 1,
  stat_critical_damage: 10, stat_critical_chance: 10, stat_armor: 0, stat_damage: 0, stat_health: 0, stat_stamina: 0, stat_avoidance: 0,
});
const equipmentRow = (username: string): Row => ({
  id: 1, username, head: "player_head_default", body: "player_body_default",
  ...Object.fromEntries(["helmet", "necklace", "shoulderguards", "cape", "chestplate", "wristguards", "gloves", "belt", "pants", "boots", "ring_1", "ring_2", "trinket_1", "trinket_2", "weapon", "off_hand_weapon"].map((slot) => [slot, null])),
});

const ADMIN = { id: "9001", username: "boss", isGuest: false, permissions: [] };
const MODERATOR = { id: "9002", username: "mod", isGuest: false, permissions: ["server.*"] };

/** The calls the socket layer would get, in order. */
let bridged: string[];

/** Nobody in the tables is online. The cache is shared: other test files leave their players in it. */
function logEveryoneOut() {
  const names = (tables?.accounts || []).map((row) => row.username);
  for (const [id, cachedPlayer] of Object.entries(playerCache.list() as Record<string, any>)) {
    if (names.includes(cachedPlayer?.username)) playerCache.remove(id);
  }
}

function resetWorld() {
  nextId = 100;
  queries.length = 0;
  bridged = [];
  tables = {
    // Ids no connection in the shared player cache will have: other test files leave players in it.
    accounts: [account(4201, "boss", { role: 1 }), account(4202, "mod", { role: 1 }), account(4203, "hero"), account(4204, "ally"), account(4205, "guest_7", { guest_mode: 1 })],
    stats: [stats("hero"), stats("ally")],
    permissions: [
      { username: "boss", permissions: "server.admin,permission.add,permission.remove,admin.kick" },
      // An admin of everything but the server itself: not enough for this editor.
      { username: "mod", permissions: "admin.*,tools.*,permission.*" },
    ],
    permission_types: ["admin.*", "admin.kick", "admin.ban", "permission.add", "permission.remove", "permission.*", "server.admin", "server.*", "tools.*"].map((name) => ({ name })),
    currency: [{ username: "hero", copper: 5, silver: 2, gold: 1 }],
    friendslist: [],
    clientconfig: [],
    quest_log: [],
    quest_objective_progress: [],
    equipment: [equipmentRow("hero")],
    guilds: [{ id: 7, name: "Frostguard", leader: "ally", members: "ally" }],
    parties: [],
    inventory: [{ username: "hero", item: "Health Potion", quantity: 3, equipped: 0, slot: 0, bag_slot: 0 }],
    collectables: [{ username: "hero", type: "mount", item: "unicorn" }],
    learned_spells: [{ username: "hero", spell: "frost_bolt" }],
    bags: [],
  };
  tables.accounts[3].guild_id = 7;
  logEveryoneOut();
}

/** Put a player online: a cache entry with a connection that records what it is sent. */
function login(username: string, sessionId: string, over: Row = {}) {
  const sent: any[] = [];
  const row = tables.accounts.find((a) => a.username === username)!;
  row.session_id = sessionId;
  const base = tables.stats.find((s) => s.username === username) || stats(username);
  const live: Row = {
    id: sessionId, userid: row.id, username,
    wt: { readyState: 1, data: { id: sessionId }, send: (frame: Uint8Array) => sent.push(JSON.parse(new TextDecoder().decode(frame))) },
    location: { map: "overworld", position: { x: 900, y: 700, direction: "left" } },
    stats: { ...base, total_max_health: base.max_health, total_max_stamina: base.max_stamina },
    equipment: { helmet: null, weapon: null }, inventory: [], collectables: [], learnedSpells: {}, friends: [],
    currency: { copper: 0, silver: 0, gold: 0 }, permissions: [], party: [], guild: [], questlog: { active: [], completed: [] },
    ...over,
  };
  playerCache.add(sessionId, live);
  return { live, sent, types: () => sent.map((p) => p.type) };
}

editor.setPlayerEditorBridge({
  syncInventory: async (target) => {
    bridged.push("syncInventory");
    const { default: inventory } = await import("../systems/inventory");
    target.inventory = await inventory.get(target.username);
  },
  broadcastStats: async () => { bridged.push("broadcastStats"); },
  refreshAppearance: async () => { bridged.push("refreshAppearance"); },
  sendCollectables: () => { bridged.push("sendCollectables"); },
  sendSpells: () => { bridged.push("sendSpells"); },
  announce: () => { bridged.push("announce"); },
  syncPartyLayers: async (leader, members) => { bridged.push(`syncPartyLayers:${leader}:${members.join("+")}`); },
  relocate: async (_target, map, x, y, direction) => { bridged.push(`relocate:${map}:${x}:${y}:${direction}`); },
});

const writes = () => queries.filter((q) => !q.startsWith("SELECT"));
const act = async (action: string, data: Row = {}, target = "hero", admin: any = ADMIN) => {
  const result = await editor.handleEditorPacket(admin, "PLAYER_EDITOR_ACTION", { target, action, ...data });
  if (result.kind !== "result") throw new Error("An action answers with a result");
  return result;
};
/** The change was refused with this message, and nothing was written. */
const expectRefused = async (action: string, data: Row, message: string | RegExp, target = "hero") => {
  queries.length = 0;
  const result = await act(action, data, target);
  expect(result.ok).toBe(false);
  expect(result.errors.join(" | ")).toMatch(message);
  expect(writes()).toEqual([]);
  return result;
};
const heroRow = (table: string) => tables[table].find((row) => row.username === "hero")!;

// Every change is written to the audit log, and the friends system logs its queries.
let consoleLog: ReturnType<typeof spyOn>;
beforeAll(() => {
  consoleLog = spyOn(console, "log").mockImplementation(() => {});
});
// The tables are new for every test, so nothing cached from the last one still holds.
beforeEach(async () => {
  resetWorld();
  await clearCaches();
});
afterAll(() => {
  consoleLog.mockRestore();
  logEveryoneOut();
  editor.setPlayerEditorBridge(null);
});

// --------------------------------------------------------------------- tests

describe("player editor permissions", () => {
  test("only server admins pass, and the permissions table decides, not the login-time copy", async () => {
    expect(await editor.canUseEditor(ADMIN)).toBe(true);
    await permissions.set("boss", ["server.*"]);
    expect(await editor.canUseEditor(ADMIN)).toBe(true);
    // The list on the player says server.*, the table says otherwise.
    expect(await editor.canUseEditor(MODERATOR)).toBe(false);
    expect(await editor.canUseEditor({ username: "hero" })).toBe(false);
    expect(await editor.canUseEditor({ username: "boss", isGuest: true })).toBe(false);
    expect(await editor.canUseEditor(null)).toBe(false);
  });

  test("every packet type is refused without it, with nothing read back or written", async () => {
    queries.length = 0;
    for (const [type, data] of [
      ["PLAYER_EDITOR_LOAD", { target: "hero" }],
      ["PLAYER_EDITOR_SEARCH", { kind: "players", query: "her" }],
      ["PLAYER_EDITOR_ACTION", { target: "hero", action: "currency.set", gold: 999, silver: 0, copper: 0 }],
    ] as Array<[string, Row]>) {
      const result = await editor.handleEditorPacket(MODERATOR, type, data);
      expect(result.kind).toBe("result");
      if (result.kind !== "result") continue;
      expect(result.ok).toBe(false);
      expect(result.denied).toBe(true);
      expect(result.errors).toEqual([editor.DENIED]);
      expect(result.snapshot).toBeNull();
    }
    // The permission lookup is the only query that ran, and the row it read answered all three packets.
    expect(queries).toEqual(["SELECT permissions FROM permissions WHERE username = ?"]);
    expect(heroRow("currency").gold).toBe(1);
  });

  test("losing the permission stops the very next packet", async () => {
    expect((await act("currency.set", { gold: 2, silver: 0, copper: 0 })).ok).toBe(true);
    // As the server takes a permission away: through the permissions system, which holds the row the editor asks.
    await permissions.set("boss", ["admin.kick"]);
    const result = await act("currency.set", { gold: 3, silver: 0, copper: 0 });
    expect(result.denied).toBe(true);
    expect(heroRow("currency").gold).toBe(2);
  });
});

describe("player editor targets", () => {
  test("a username, an account id or an online connection id all find the player", async () => {
    expect(await editor.resolveTarget("Hero")).toEqual({ username: "hero", userid: 4203 });
    expect(await editor.resolveTarget("4203")).toEqual({ username: "hero", userid: 4203 });
    expect(await editor.resolveTarget(4203)).toEqual({ username: "hero", userid: 4203 });
    login("ally", "7002");
    expect(await editor.resolveTarget("7002")).toEqual({ username: "ally", userid: 4204 });
    expect(await editor.resolveTarget("nobody")).toBeNull();
    expect(await editor.resolveTarget("4299")).toBeNull();
  });

  test("anything that is not a username or a number never reaches a query", async () => {
    for (const hostile of ["hero' OR '1'='1", "hero\\", "he ro", "", null, undefined, {}, ["hero"], "x".repeat(65)]) {
      queries.length = 0;
      expect(await editor.resolveTarget(hostile)).toBeNull();
      expect(queries).toEqual([]);
    }
  });

  test("loading an unknown player reports it", async () => {
    const result = await editor.handleEditorPacket(ADMIN, "PLAYER_EDITOR_LOAD", { target: "nobody" });
    expect(result).toMatchObject({ kind: "result", ok: false, errors: ["Player not found."] });
  });
});

describe("player editor snapshot", () => {
  test("an offline player loads in full from the database", async () => {
    tables.quest_log.push({ username: "hero", quest_id: 1, state: "active", accepted_at: 1, completed_at: 0, times_completed: 0 });
    tables.quest_objective_progress.push({ username: "hero", quest_id: 1, objective_id: 10, count: 2 });
    const result = await editor.handleEditorPacket(ADMIN, "PLAYER_EDITOR_LOAD", { target: "hero" });
    expect(result.kind).toBe("data");
    if (result.kind !== "data") return;
    const { snapshot, options } = result.data;

    expect(snapshot).toMatchObject({
      username: "hero", userid: 4203, online: false, sessionId: null, isAdmin: false, banned: false, dead: 0,
      location: { map: "overworld", x: 320, y: 480, direction: "down" },
      currency: { copper: 5, silver: 2, gold: 1 },
      inventorySlots: 25,
      spells: ["frost_bolt"],
      totals: null,
      guild: null,
      party: null,
    });
    expect(snapshot.stats).toMatchObject({ level: 1, xp: 40, max_xp: 100, health: 80, max_health: 100 });
    expect(snapshot.inventory).toEqual([
      { name: "Health Potion", quantity: 3, equipped: false, quality: "common", type: "consumable", icon: "health_potion", equipment_slot: null, level_requirement: 1, known: true },
    ]);
    expect(snapshot.equipment.helmet).toBeNull();
    expect(Object.keys(snapshot.equipment)).toHaveLength(16);
    expect(snapshot.collectables).toEqual([{ type: "mount", item: "unicorn", icon: "mount_unicorn", known: true }]);
    expect(snapshot.quests.active).toEqual([
      { id: 1, name: "Rats in the Cellar", state: "active", objectives: [{ id: 10, label: "Rats slain", count: 2, required: 3 }] },
    ]);

    expect(options.editor).toBe("boss");
    expect(options.maps).toEqual([{ name: "overworld", width: 3200, height: 1600 }]);
    expect(options.guilds).toEqual([{ id: 7, name: "Frostguard", leader: "ally", members: 1 }]);
    expect(options.quests.map((q) => q.name)).toEqual(["Rats in the Cellar", "Aftermath"]);
    expect(options.permissionTypes).toContain("server.admin");
    // 100 * 1.1^(level - 1) stops fitting a 32-bit column after this level.
    expect(options.limits.level).toBe(178);
  });

  test("an online player's vitals and position come from their live copy", async () => {
    const { live } = login("hero", "7001");
    live.stats.health = 33;
    live.stats.xp = 77;
    const result = await editor.handleEditorPacket(ADMIN, "PLAYER_EDITOR_LOAD", { target: "7001" });
    if (result.kind !== "data") throw new Error("expected data");
    expect(result.data.snapshot).toMatchObject({
      online: true, sessionId: "7001",
      location: { map: "overworld", x: 900, y: 700, direction: "left" },
    });
    expect(result.data.snapshot.stats).toMatchObject({ health: 33, xp: 77 });
    expect(result.data.snapshot.totals).toMatchObject({ max_health: 100 });
  });

  test("is put together from what the systems hold: opened again, it reads nothing", async () => {
    tables.quest_log.push({ username: "hero", quest_id: 1, state: "active", accepted_at: 1, completed_at: 0, times_completed: 0 });
    for (const username of ["hero", "ally"]) {
      const first = await editor.buildSnapshot(username);
      queries.length = 0;
      expect(await editor.buildSnapshot(username)).toEqual(first);
      expect(queries).toEqual([]);
    }

    // The same for a player who is online.
    login("hero", "7001");
    const first = await editor.buildSnapshot("hero");
    queries.length = 0;
    expect(await editor.buildSnapshot("hero")).toEqual(first);
    expect(queries).toEqual([]);
  });

  test("shows of an account what a login reads of it", async () => {
    Object.assign(heroRow("accounts"), { is_dead: 2, map: "overworld.json", position: "12.5,7", direction: null });
    tables.friendslist.push({ username: "hero", friends: " ally , boss,," });
    tables.permissions.push({ username: "hero", permissions: "admin.kick, admin.ban" });
    tables.quest_log.push(
      { username: "hero", quest_id: 1, state: "ready", accepted_at: 1, completed_at: 0, times_completed: 0 },
      { username: "hero", quest_id: 2, state: "completed", accepted_at: 1, completed_at: 5, times_completed: 1 },
      { username: "hero", quest_id: 2, state: "completed", accepted_at: 6, completed_at: 9, times_completed: 2 },
    );
    tables.quest_objective_progress.push({ username: "hero", quest_id: 1, objective_id: 10, count: 3 });

    // An account with every row, one with no stats or currency of its own, and a guest.
    for (const username of ["hero", "boss", "guest_7"]) {
      const data = (await player.GetPlayerLoginData(username)) as any;
      const snapshot = (await editor.buildSnapshot(username))!;
      expect(snapshot).toMatchObject({
        username: data.username,
        userid: Number(data.id),
        isAdmin: !!data.isAdmin,
        isGuest: !!data.isGuest,
        dead: Number(data.isDead) || 0,
        location: { map: String(data.location.map).replaceAll(".json", ""), x: data.location.position.x, y: data.location.position.y, direction: data.location.position.direction },
        currency: data.currency,
        friends: data.friends,
        permissions: String(data.permissions || "").split(",").map((p: string) => p.trim()).filter(Boolean),
      });
      expect(snapshot.stats).toEqual({
        level: Number(data.stats.level) || 1, xp: Number(data.stats.xp) || 0, max_xp: Number(data.stats.max_xp) || 0,
        health: Number(data.stats.health) || 0, max_health: Number(data.stats.max_health) || 0,
        stamina: Number(data.stats.stamina) || 0, max_stamina: Number(data.stats.max_stamina) || 0,
        stat_damage: Number(data.stats.stat_damage) || 0, stat_armor: Number(data.stats.stat_armor) || 0,
        stat_critical_chance: Number(data.stats.stat_critical_chance) || 0, stat_critical_damage: Number(data.stats.stat_critical_damage) || 0,
        stat_avoidance: Number(data.stats.stat_avoidance) || 0,
      });
      expect(snapshot.quests.completed.map((quest) => quest.id)).toEqual(data.questlog.completed);
      expect(snapshot.quests.active.map((quest) => ({ id: quest.id, state: quest.state, counts: quest.objectives.map((o) => o.count) })))
        .toEqual(data.questlog.active.map((entry: any) => ({ id: entry.quest_id, state: entry.state, counts: [Number(entry.progress[entry.quest_id * 10]) || 0] })));
    }

    const hero = (await editor.buildSnapshot("hero"))!;
    expect(hero).toMatchObject({
      dead: 2, location: { map: "overworld", x: 12.5, y: 7, direction: "down" }, friends: ["ally", "boss"], permissions: ["admin.kick", "admin.ban"],
    });
    expect(hero.quests).toMatchObject({ active: [{ id: 1, state: "ready", objectives: [{ id: 10, count: 3 }] }], completed: [{ id: 2, name: "Aftermath" }] });
    expect((await editor.buildSnapshot("boss"))!).toMatchObject({ isAdmin: true, currency: { copper: 0, silver: 0, gold: 0 }, stats: { level: 1, health: 0 } });
    expect((await editor.buildSnapshot("guest_7"))!.isGuest).toBe(true);
    expect(await editor.buildSnapshot("nobody")).toBeNull();
  });
});

describe("player editor dispatch", () => {
  test("unknown actions are rejected, inherited object keys included", async () => {
    for (const action of ["inventory.duplicate", "constructor", "toString", "__proto__", ""]) {
      await expectRefused(action, {}, /Unknown player editor action/);
    }
    const result = await editor.handleEditorPacket(ADMIN, "PLAYER_EDITOR_NONSENSE", { target: "hero" });
    expect(result).toMatchObject({ kind: "result", ok: false });
  });

  test("an action on an unknown player changes nothing", async () => {
    const result = await act("currency.set", { gold: 1, silver: 1, copper: 1 }, "nobody");
    expect(result).toMatchObject({ ok: false, errors: ["Player not found."], snapshot: null });
  });

  test("a change answers with the fresh snapshot, and so does a refusal", async () => {
    const changed = await act("currency.set", { gold: 9, silver: 8, copper: 7 });
    expect(changed).toMatchObject({ ok: true, errors: [], action: "currency.set" });
    expect(changed.snapshot?.currency).toEqual({ gold: 9, silver: 8, copper: 7 });
    const refused = await act("currency.set", { gold: -1, silver: 8, copper: 7 });
    expect(refused.ok).toBe(false);
    expect(refused.snapshot?.currency).toEqual({ gold: 9, silver: 8, copper: 7 });
  });
});

describe("stats", () => {
  test("numbers must be whole and in range", async () => {
    await expectRefused("stats.set", {}, /No stats were given/);
    await expectRefused("stats.set", { stats: { level: 0 } }, /Level must be a whole number from 1 to 178/);
    await expectRefused("stats.set", { stats: { level: 179 } }, /Level must be/);
    for (const bad of [1.5, -3, "abc", "", null, true, NaN, Infinity, [5], {}]) {
      await expectRefused("stats.set", { stats: { stat_damage: bad } }, /Damage must be a whole number/);
    }
    await expectRefused("stats.set", { stats: { health: 0 } }, /Health must be a whole number from 1/);
    await expectRefused("stats.set", { stats: { health: 101 } }, /Health cannot be above the maximum of 100/);
    await expectRefused("stats.set", { stats: { xp: 100 } }, /XP must be below 100/);
    await expectRefused("stats.set", { stats: { max_xp: 5 } }, /Unknown stat: max_xp/);
    await expectRefused("stats.set", { stats: { role: 1 } }, /Unknown stat: role/);
    await expectRefused("stats.set", { stats: JSON.parse('{"__proto__": 5, "constructor": 5}') }, /Unknown stat: __proto__.*Unknown stat: constructor/);
  });

  test("an offline player's row is rewritten, with the level's XP and maximums following it", async () => {
    expect((await act("stats.set", { stats: { level: 5, stat_damage: 12 } })).ok).toBe(true);
    expect(heroRow("stats")).toMatchObject({
      level: 5, max_xp: 146, max_health: 155, max_stamina: 133, stat_damage: 12,
      // Untouched values stay, under the new maximums.
      xp: 40, health: 80, stamina: 60, stat_critical_chance: 10,
    });
  });

  test("going down a level pulls XP and health back under the new maximums", async () => {
    Object.assign(heroRow("stats"), { level: 5, max_xp: 146, xp: 140, max_health: 155, health: 150 });
    expect((await act("stats.set", { stats: { level: 1 } })).ok).toBe(true);
    // Level 1 by the engine's own curve: 100 + 1^1.5 * 5.
    expect(heroRow("stats")).toMatchObject({ level: 1, max_xp: 100, xp: 99, max_health: 105, health: 105 });
  });

  test("an online player's live stats, client and onlookers are updated", async () => {
    const { live, sent, types } = login("hero", "7001");
    const levels: number[] = [];
    const onLevel = (event: any) => levels.push(event.level);
    listener.on(Events.PLAYER_LEVEL_UP, onLevel);
    const result = await act("stats.set", { stats: { level: 3, health: 50 } });
    listener.off(Events.PLAYER_LEVEL_UP, onLevel);

    expect(result.ok).toBe(true);
    expect(live.stats).toMatchObject({ level: 3, max_xp: 121, health: 50, max_health: 125, total_max_health: 125 });
    expect(heroRow("stats")).toMatchObject({ level: 3, health: 50 });
    expect(types()).toEqual(["UPDATESTATS", "UPDATE_XP", "QUEST_MARKERS"]);
    expect(sent[0].data).toMatchObject({ target: "7001", stats: { level: 3, health: 50 } });
    expect(sent[1].data).toEqual({ id: "7001", xp: 40, level: 3, max_xp: 121 });
    expect(bridged).toEqual(["broadcastStats"]);
    expect(levels).toEqual([3]);
  });

  test("a dead player's stats are left to the death flow", async () => {
    heroRow("accounts").is_dead = 1;
    await expectRefused("stats.set", { stats: { level: 2 } }, /revive them/);
    heroRow("accounts").is_dead = 0;
    login("hero", "7001", { isGhost: true });
    await expectRefused("stats.set", { stats: { level: 2 } }, /revive them/);
  });
});

describe("currency", () => {
  test("each coin has its own range", async () => {
    await expectRefused("currency.set", { gold: 1, silver: 100, copper: 0 }, /Silver must be a whole number from 0 to 99/);
    await expectRefused("currency.set", { gold: 10000000, silver: 0, copper: 0 }, /Gold must be/);
    await expectRefused("currency.set", { gold: 1 }, /Silver must be.*Copper must be/);
  });

  test("the balance is set, and an online player sees it", async () => {
    const { live, sent } = login("hero", "7001");
    expect((await act("currency.set", { gold: 12, silver: 34, copper: 56 })).ok).toBe(true);
    expect(heroRow("currency")).toMatchObject({ gold: 12, silver: 34, copper: 56 });
    expect(live.currency).toEqual({ gold: 12, silver: 34, copper: 56 });
    expect(sent).toEqual([{ type: "CURRENCY", data: { gold: 12, silver: 34, copper: 56 } }]);
  });
});

describe("inventory", () => {
  const held = (name: string) => tables.inventory.find((row) => row.username === "hero" && row.item === name)?.quantity;

  test("items must exist and quantities must be whole and positive", async () => {
    await expectRefused("inventory.add", { item: "Sword of Lies", quantity: 1 }, /does not exist/);
    await expectRefused("inventory.add", { item: "Health Potion' --", quantity: 1 }, /does not exist/);
    for (const bad of [0, -1, 2.5, "many", null, undefined, 1000001]) {
      await expectRefused("inventory.add", { item: "Health Potion", quantity: bad }, /Quantity must be a whole number/);
    }
    await expectRefused("inventory.add", { item: "Health Potion", quantity: 999998 }, /A stack holds at most/);
    await expectRefused("inventory.remove", { item: "Wooden Staff" }, /does not have that item/);
    await expectRefused("inventory.set", { item: "Health Potion", quantity: -2 }, /Quantity must be/);
  });

  test("adding stacks onto what is held, by the item's own name whatever case was sent", async () => {
    expect((await act("inventory.add", { item: "health potion", quantity: 4 })).ok).toBe(true);
    expect(held("Health Potion")).toBe("7");
    const result = await act("inventory.add", { item: "WOODEN STAFF", quantity: 1 });
    expect(held("Wooden Staff")).toBe(1);
    expect(result.snapshot?.inventory.map((i) => `${i.quantity}x ${i.name}`)).toEqual(["7x Health Potion", "1x Wooden Staff"]);
  });

  test("removing takes some or all, and setting goes either way", async () => {
    await act("inventory.remove", { item: "Health Potion", quantity: 2 });
    expect(held("Health Potion")).toBe("1");
    await act("inventory.set", { item: "Health Potion", quantity: 9 });
    expect(held("Health Potion")).toBe("9");
    await act("inventory.set", { item: "Health Potion", quantity: 4 });
    expect(held("Health Potion")).toBe("4");
    await act("inventory.remove", { item: "Health Potion" });
    expect(held("Health Potion")).toBeUndefined();
  });

  test("a full inventory takes no new item, but existing stacks still grow", async () => {
    const items = assets.get("items");
    const junk = Array.from({ length: 24 }, (_, i) => item(`Junk ${i}`, { type: "miscellaneous", equipable: false }));
    assets.set("items", [...items, ...junk]);
    for (const [i, { name }] of junk.entries()) tables.inventory.push({ username: "hero", item: name, quantity: 1, equipped: 0, slot: i + 1, bag_slot: 0 });
    await expectRefused("inventory.add", { item: "Wooden Staff", quantity: 1 }, /inventory is full/);
    expect((await act("inventory.add", { item: "Health Potion", quantity: 1 })).ok).toBe(true);
    assets.set("items", items);
  });

  test("an equipped item cannot be removed from under its slot", async () => {
    tables.inventory.push({ username: "hero", item: "Iron Helmet", quantity: 1, equipped: 1, slot: null, bag_slot: null });
    heroRow("equipment").helmet = "Iron Helmet";
    await expectRefused("inventory.remove", { item: "Iron Helmet" }, /unequip it before removing it/);
    await expectRefused("inventory.set", { item: "Iron Helmet", quantity: 0 }, /unequip it/);
  });

  test("a row whose item was deleted can still be cleared out, whole", async () => {
    tables.inventory.push({ username: "hero", item: "Lost Relic", quantity: 2, equipped: 0, slot: 3, bag_slot: 0 });
    await expectRefused("inventory.add", { item: "Lost Relic", quantity: 1 }, /can only be removed/);
    expect((await act("inventory.remove", { item: "Lost Relic" })).ok).toBe(true);
    expect(held("Lost Relic")).toBeUndefined();
  });

  test("an online player's list is rebuilt and sent, with their quest log", async () => {
    const { live, types } = login("hero", "7001");
    expect((await act("inventory.add", { item: "Wooden Staff", quantity: 2 })).ok).toBe(true);
    expect(bridged).toEqual(["syncInventory"]);
    expect(live.inventory.map((i: any) => i.name)).toEqual(["Health Potion", "Wooden Staff"]);
    expect(types()).toEqual(["QUEST_LOG", "QUEST_MARKERS"]);
  });
});

describe("equipment", () => {
  test("slots must be real and the item must belong in the slot", async () => {
    await expectRefused("equipment.equip", { slot: "tail", item: "Iron Helmet" }, /not an equipment slot/);
    await expectRefused("equipment.equip", { slot: "username", item: "Iron Helmet" }, /not an equipment slot/);
    await expectRefused("equipment.equip", { slot: "helmet", item: "Nothing" }, /does not exist/);
    await expectRefused("equipment.equip", { slot: "weapon", item: "Iron Helmet" }, /does not go in the weapon slot/);
    await expectRefused("equipment.equip", { slot: "helmet", item: "Health Potion" }, /does not go in the helmet slot/);
    await expectRefused("equipment.unequip", { slot: "helmet" }, /Nothing is equipped/);
    await expectRefused("equipment.unequip", { slot: "id" }, /not an equipment slot/);
  });

  test("equipping gives the item if needed, and swaps out what was worn", async () => {
    expect((await act("equipment.equip", { slot: "helmet", item: "leather cap" })).ok).toBe(true);
    expect(heroRow("equipment").helmet).toBe("Leather Cap");
    const result = await act("equipment.equip", { slot: "helmet", item: "Iron Helmet" });
    expect(heroRow("equipment").helmet).toBe("Iron Helmet");
    expect(result.snapshot?.inventory.filter((i) => i.equipped).map((i) => i.name)).toEqual(["Iron Helmet"]);
    expect(result.snapshot?.inventory.map((i) => i.name)).toContain("Leather Cap");
    await expectRefused("equipment.equip", { slot: "helmet", item: "Iron Helmet" }, /already equipped/);
  });

  test("an online player gets the item's stats, both lists and a redrawn sprite", async () => {
    const { live, sent, types } = login("hero", "7001");
    const equipped: string[] = [];
    const onEquip = (event: any) => equipped.push(`${event.slot}=${event.item.name}`);
    listener.on(Events.ITEM_EQUIP, onEquip);
    expect((await act("equipment.equip", { slot: "helmet", item: "Iron Helmet" })).ok).toBe(true);
    listener.off(Events.ITEM_EQUIP, onEquip);

    expect(live.equipment.helmet).toBe("Iron Helmet");
    expect(live.equipmentRevision).toBe(1);
    // Base 100 plus the helmet's 20; armor comes from the helmet too.
    expect(live.stats).toMatchObject({ max_health: 100, total_max_health: 120, stat_armor: 5 });
    expect(bridged).toEqual(["syncInventory", "broadcastStats", "refreshAppearance"]);
    expect(types()).toEqual(["UPDATESTATS", "UPDATE_XP", "EQUIPMENT"]);
    expect(sent[2].data.helmet).toBe("Iron Helmet");
    expect(equipped).toEqual(["helmet=Iron Helmet"]);

    // Taking it off drops the totals again, and health with them.
    live.stats.health = 120;
    expect((await act("equipment.unequip", { slot: "helmet" })).ok).toBe(true);
    expect(heroRow("equipment").helmet).toBeNull();
    expect(live.equipment.helmet).toBeNull();
    expect(live.stats).toMatchObject({ total_max_health: 100, health: 100, stat_armor: 0 });
    expect(tables.inventory.find((row) => row.item === "Iron Helmet")).toMatchObject({ equipped: 0 });
  });
});

describe("collections", () => {
  test("only known mounts can be given, once each", async () => {
    await expectRefused("collectable.add", { type: "pet", item: "wolf" }, /cannot be given from here/);
    await expectRefused("collectable.add", { type: "mount", item: "dragon" }, /does not exist/);
    await expectRefused("collectable.add", { type: "mount", item: "Unicorn" }, /already has unicorn/);
    await expectRefused("collectable.remove", { type: "mount", item: "wolf" }, /does not have that collectable/);
  });

  test("mounts are given and taken away, and an online player's list follows", async () => {
    const { live } = login("hero", "7001");
    expect((await act("collectable.add", { type: "mount", item: "WOLF" })).ok).toBe(true);
    expect(tables.collectables.map((c) => c.item)).toEqual(["unicorn", "wolf"]);
    expect(live.collectables).toEqual([{ type: "mount", item: "unicorn", icon: "mount_unicorn" }, { type: "mount", item: "wolf", icon: null }]);

    live.mounted = true;
    live.mount_type = "wolf";
    await expectRefused("collectable.remove", { type: "mount", item: "wolf" }, /riding that mount/);
    expect((await act("collectable.remove", { type: "mount", item: "unicorn" })).ok).toBe(true);
    expect(live.collectables.map((c: any) => c.item)).toEqual(["wolf"]);
    expect(bridged).toEqual(["sendCollectables", "sendCollectables"]);
  });

  test("spells are learned once and unlearned, in the live spell book too", async () => {
    await expectRefused("spell.learn", { spell: "meteor" }, /does not exist/);
    await expectRefused("spell.learn", { spell: "Frost_Bolt" }, /already knows frost_bolt/);
    await expectRefused("spell.unlearn", { spell: "fireball" }, /has not learned/);

    const { live } = login("hero", "7001");
    const learned = await act("spell.learn", { spell: "Fireball" });
    expect(learned.snapshot?.spells).toEqual(["frost_bolt", "fireball"]);
    expect(Object.keys(live.learnedSpells)).toEqual(["frost_bolt", "fireball"]);
    expect(live.learnedSpells.fireball).toMatchObject({ icon: "fireball", mana: 10 });

    await act("spell.unlearn", { spell: "frost_bolt" });
    expect(tables.learned_spells.map((s) => s.spell)).toEqual(["fireball"]);
    expect(Object.keys(live.learnedSpells)).toEqual(["fireball"]);
    expect(bridged).toEqual(["sendSpells", "sendSpells"]);
  });
});

describe("friends", () => {
  test("friendship is added and removed on both sides", async () => {
    await expectRefused("friend.add", { username: "nobody" }, /does not exist/);
    await expectRefused("friend.add", { username: "hero" }, /their own friend/);
    await expectRefused("friend.remove", { username: "ally" }, /not their friend/);

    const hero = login("hero", "7001");
    const ally = login("ally", "7002");
    expect((await act("friend.add", { username: "Ally" })).ok).toBe(true);
    expect(tables.friendslist).toEqual([{ username: "hero", friends: "ally" }, { username: "ally", friends: "hero" }]);
    expect(hero.live.friends).toEqual(["ally"]);
    expect(hero.sent).toEqual([
      { type: "UPDATE_FRIENDS", data: { friends: ["ally"] } },
      { type: "UPDATE_ONLINE_STATUS", data: { online: true, username: "ally" } },
    ]);
    expect(ally.types()).toEqual(["UPDATE_FRIENDS", "UPDATE_ONLINE_STATUS"]);
    await expectRefused("friend.add", { username: "ally" }, /already their friend/);

    const removed = await act("friend.remove", { username: "ally" });
    expect(removed.snapshot?.friends).toEqual([]);
    expect(tables.friendslist.map((row) => row.friends)).toEqual(["", ""]);
    expect(ally.live.friends).toEqual([]);
  });
});

describe("guild", () => {
  test("joining needs a real guild and a player who is free and not a guest", async () => {
    await expectRefused("guild.join", { guild: "Nobodies" }, /does not exist/);
    await expectRefused("guild.join", { guild: "Frostguard" }, /Guests cannot/, "guest_7");
    await expectRefused("guild.join", { guild: "Frostguard" }, /already in a guild/, "ally");
    await expectRefused("guild.leave", {}, /not in a guild/);
    await expectRefused("guild.leave", {}, /leads that guild/, "ally");
    await expectRefused("guild.disband", {}, /not in a guild/);
  });

  test("a member is added, made leader, and the guild disbanded through them", async () => {
    const hero = login("hero", "7001");
    const ally = login("ally", "7002", { guild_id: 7, guild: ["ally"], guild_name: "Frostguard" });

    const joined = await act("guild.join", { guild: "frostguard" });
    expect(joined.snapshot?.guild).toEqual({ id: 7, name: "Frostguard", leader: "ally", members: ["ally", "hero"] });
    expect(heroRow("accounts").guild_id).toBe(7);
    expect(hero.live).toMatchObject({ guild_id: 7, guild_name: "Frostguard", guild: ["ally", "hero"] });
    expect(ally.sent).toEqual([{ type: "UPDATE_GUILD", data: { members: ["ally", "hero"], guild_name: "Frostguard" } }]);
    expect(bridged).toEqual(["announce"]);
    await expectRefused("guild.disband", {}, /Only the guild's leader/);

    // The leader heads the member list.
    const led = await act("guild.lead");
    expect(led.snapshot?.guild).toMatchObject({ leader: "hero", members: ["hero", "ally"] });
    expect(ally.live.guild).toEqual(["hero", "ally"]);
    await expectRefused("guild.lead", {}, /already leads/);

    expect((await act("guild.disband")).ok).toBe(true);
    expect(tables.guilds).toEqual([]);
    expect(tables.accounts.map((a) => a.guild_id)).toEqual([null, null, null, null, null]);
    expect(ally.live).toMatchObject({ guild_id: null, guild: [], guild_name: null });
    expect(ally.sent.at(-1)).toEqual({ type: "NOTIFY", data: { message: "The guild has been disbanded" } });
  });

  test("a member who does not lead is removed, and those left are told", async () => {
    Object.assign(tables.guilds[0], { members: "ally, hero" });
    heroRow("accounts").guild_id = 7;
    const ally = login("ally", "7002");
    expect((await act("guild.leave")).ok).toBe(true);
    expect(tables.guilds[0].members).toBe("ally");
    expect(heroRow("accounts").guild_id).toBeNull();
    expect(ally.sent).toEqual([{ type: "UPDATE_GUILD", data: { members: ["ally"], guild_name: "Frostguard" } }]);
  });
});

describe("party", () => {
  test("a party is formed with another player, then left", async () => {
    await expectRefused("party.join", { username: "nobody" }, /does not exist/);
    await expectRefused("party.join", { username: "hero" }, /needs two/);
    await expectRefused("party.leave", {}, /not in a party/);

    const hero = login("hero", "7001");
    const ally = login("ally", "7002");
    const joined = await act("party.join", { username: "ally" });
    // The other player had no party, so they lead the new one.
    expect(joined.snapshot?.party).toMatchObject({ leader: "ally", members: ["ally", "hero"] });
    const partyId = tables.parties[0].id;
    expect(hero.live).toMatchObject({ party_id: partyId, party: ["ally", "hero"] });
    expect(ally.sent).toEqual([{ type: "UPDATE_PARTY", data: { members: ["ally", "hero"] } }]);
    expect(bridged).toEqual(["syncPartyLayers:ally:ally+hero"]);
    await expectRefused("party.join", { username: "ally" }, /already in a party/);

    const left = await act("party.leave");
    expect(left.ok).toBe(true);
    expect(left.snapshot?.party).toBeNull();
    expect(heroRow("accounts").party_id).toBeNull();
    expect(hero.live.party).toEqual([]);
    expect(hero.live.party_id).toBeNull();
  });

  /** A party of three that ally leads, with all three online. */
  function partyOfThree() {
    const members = ["ally", "mod", "hero"];
    tables.parties.push({ id: 50, leader: "ally", members: members.join(", ") });
    for (const row of tables.accounts) if (members.includes(row.username)) row.party_id = 50;
    const [ally, mod, hero] = members.map((name, i) => login(name, `700${i + 1}`, { party_id: 50, party: members }));
    return { ally, mod, hero };
  }
  const partyPackets = (player: { sent: any[] }) => player.sent.filter((p) => p.type === "UPDATE_PARTY" || p.type === "NOTIFY");

  test("a player taken out of a party of three is told they have none, and the two left get the new list", async () => {
    const { ally, mod, hero } = partyOfThree();

    const left = await act("party.leave");
    expect(left.ok).toBe(true);
    expect(left.snapshot?.party).toBeNull();
    expect(tables.parties).toEqual([{ id: 50, leader: "ally", members: "ally, mod" }]);
    expect(["ally", "mod", "hero"].map((name) => tables.accounts.find((row) => row.username === name)!.party_id)).toEqual([50, 50, null]);

    expect(hero.live).toMatchObject({ party_id: null, party: [] });
    expect(partyPackets(hero)).toEqual([
      { type: "UPDATE_PARTY", data: { members: [] } },
      { type: "NOTIFY", data: { message: "You have been removed from the party" } },
    ]);
    for (const stays of [ally, mod]) {
      expect(stays.live).toMatchObject({ party_id: 50, party: ["ally", "mod"] });
      expect(partyPackets(stays)).toEqual([{ type: "UPDATE_PARTY", data: { members: ["ally", "mod"] } }]);
    }
    expect(bridged).toEqual(["syncPartyLayers:ally:ally+mod"]);
  });

  test("a removal the party system could not make is reported, and nobody is told the player was removed", async () => {
    const { ally, hero } = partyOfThree();
    const { default: parties } = await import("../systems/parties");
    // What `leave` answers when the database did not take the removal.
    const leaving = spyOn(parties, "leave").mockResolvedValueOnce([]);

    const result = await act("party.leave");
    leaving.mockRestore();
    expect(result.ok).toBe(false);
    expect(result.errors.join(" | ")).toMatch(/Could not remove the player from the party/);
    expect(partyPackets(hero)).toEqual([]);
    expect(partyPackets(ally)).toEqual([]);
    expect(hero.live).toMatchObject({ party_id: 50, party: ["ally", "mod", "hero"] });
    expect(bridged).toEqual([]);
  });

  test("who is in which guild and party is read from the database once, whatever changes follow", async () => {
    login("hero", "7001");
    login("ally", "7002");
    queries.length = 0;
    for (const [action, data] of [["guild.join", { guild: "Frostguard" }], ["party.join", { username: "ally" }], ["guild.lead", {}], ["party.leave", {}], ["guild.disband", {}]] as const) {
      expect((await act(action, data)).ok).toBe(true);
    }
    // The two tables as wholes, and none of the questions that used to be asked one by one.
    const asked = queries.filter((q) => /^SELECT (guild_id|party_id) FROM accounts|^SELECT (id|name|leader|members|id, name, leader, members|id, leader, members) FROM (guilds|parties)\b/.test(q));
    expect(asked).toEqual(["SELECT id, name, leader, members FROM guilds", "SELECT id, leader, members FROM parties"]);
  });
});

describe("quests", () => {
  test("quests are started, completed without a turn-in, and forgotten", async () => {
    await expectRefused("quest.accept", { questId: 99 }, /does not exist/);
    await expectRefused("quest.accept", { questId: "1; DROP" }, /does not exist/);
    await expectRefused("quest.abandon", { questId: 1 }, /not in the player's log/);
    await expectRefused("quest.forget", { questId: 1 }, /no record of that quest/);

    const started = await act("quest.accept", { questId: 1 });
    expect(started.snapshot?.quests.active.map((q) => `${q.name}: ${q.state}`)).toEqual(["Rats in the Cellar: active"]);
    await expectRefused("quest.accept", { questId: 1 }, /already in your log/);

    const completed = await act("quest.complete", { questId: 1 });
    expect(completed.snapshot?.quests).toEqual({ active: [], completed: [{ id: 1, name: "Rats in the Cellar" }] });
    expect(tables.quest_log[0]).toMatchObject({ state: "completed", times_completed: 1 });
    await expectRefused("quest.complete", { questId: 1 }, /already completed/);

    const forgotten = await act("quest.forget", { questId: 1 });
    expect(forgotten.snapshot?.quests).toEqual({ active: [], completed: [] });
    expect(tables.quest_log).toEqual([]);
  });

  test("an abandon or a forget the database refused is answered as not done, and the quest is still there", async () => {
    await act("quest.accept", { questId: 2 });
    const said = spyOn(log, "error").mockImplementation(() => {});
    refused = /^DELETE FROM quest_log/;
    try {
      const abandoned = await act("quest.abandon", { questId: 2 });
      expect(abandoned.ok).toBe(false);
      expect(abandoned.errors).toEqual(["Could not abandon that quest."]);

      const forgotten = await act("quest.forget", { questId: 2 });
      expect(forgotten.ok).toBe(false);
      expect(forgotten.errors).toEqual(["Could not forget that quest."]);
    } finally {
      refused = null;
      said.mockRestore();
    }
    expect(tables.quest_log.map((row: any) => row.quest_id)).toEqual([2]);

    expect((await act("quest.abandon", { questId: 2 })).ok).toBe(true);
    expect(tables.quest_log).toEqual([]);
  });

  test("an online player's quest log follows each change", async () => {
    const { live, sent, types } = login("hero", "7001");
    await act("quest.accept", { questId: 2 });
    expect(live.questlog.active.map((e: any) => e.quest_id)).toEqual([2]);
    expect(types()).toEqual(["QUEST_LOG", "QUEST_MARKERS"]);
    expect(sent[0].data.definitions.map((q: any) => q.name)).toEqual(["Aftermath"]);

    await act("quest.abandon", { questId: 2 });
    expect(live.questlog.active).toEqual([]);
    expect(tables.quest_log).toEqual([]);
  });
});

describe("access", () => {
  const heroPermissions = () => tables.permissions.find((row) => row.username === "hero")?.permissions;

  test("permissions follow the /permission command's rules", async () => {
    await expectRefused("permissions.set", { permissions: ["admin.kick"] }, /your own permissions/, "boss");
    await expectRefused("permissions.set", { permissions: "admin.kick" }, /No permissions were given/);
    await expectRefused("permissions.set", { permissions: ["admin.fly"] }, /Invalid permission: admin.fly/);
    // boss holds admin.kick and server.admin, but neither admin.ban nor a wildcard.
    await expectRefused("permissions.set", { permissions: ["admin.ban"] }, /cannot grant the admin.ban permission/);
    await expectRefused("permissions.set", { permissions: ["server.*"] }, /cannot grant the server\.\* permission/);

    await permissions.set("boss", ["server.admin", "admin.kick"]);
    await expectRefused("permissions.set", { permissions: ["admin.kick"] }, /need permission.add/);
    await permissions.set("hero", ["admin.kick"]);
    await expectRefused("permissions.set", { permissions: [] }, /need permission.remove/);
  });

  test("a held permission is granted and taken away again", async () => {
    const { live } = login("hero", "7001");
    const granted = await act("permissions.set", { permissions: ["admin.kick", "admin.kick", " server.admin "] });
    expect(granted.snapshot?.permissions).toEqual(["admin.kick", "server.admin"]);
    expect(heroPermissions()).toBe("admin.kick,server.admin");
    expect(live.permissions).toEqual(["admin.kick", "server.admin"]);

    expect((await act("permissions.set", { permissions: [] })).ok).toBe(true);
    expect(heroPermissions()).toBeUndefined();
    expect(live.permissions).toEqual([]);
  });

  test("the admin role is switched for others, never for yourself", async () => {
    await expectRefused("admin.set", { value: true }, /your own admin status/, "boss");
    await expectRefused("admin.set", { value: "yes" }, /must be on or off/);

    const { live, types } = login("hero", "7001", { isStealth: true });
    const promoted = await act("admin.set", { value: true });
    expect(promoted.snapshot?.isAdmin).toBe(true);
    expect(heroRow("accounts").role).toBe(1);
    expect(live.isAdmin).toBe(true);
    expect(types()).toEqual(["RECONNECT"]);

    await act("admin.set", { value: false });
    expect(heroRow("accounts").role).toBe(0);
    expect(live).toMatchObject({ isAdmin: false, isStealth: false });
  });
});

// The creature editor's listener in the game window relayed every editor popup's requests a second time, so each
// player editor change reached the server twice, side by side: both passed the "already has it" check before either
// wrote. The mount and the spell were given twice (their tables have no unique key) and the admin role flipped on and
// straight back off. Changes to one player now run one after the other.
describe("a request that arrives twice", () => {
  const twice = (action: string, data: Row) => Promise.all([act(action, data), act(action, data)]);

  test("gives a mount or a spell once", async () => {
    const mount = await twice("collectable.add", { type: "mount", item: "wolf" });
    expect(mount.map((r) => r.ok).sort()).toEqual([false, true]);
    expect(tables.collectables.filter((c) => c.username === "hero" && c.item === "wolf")).toHaveLength(1);

    const spell = await twice("spell.learn", { spell: "fireball" });
    expect(spell.map((r) => r.ok).sort()).toEqual([false, true]);
    expect(tables.learned_spells.filter((s) => s.username === "hero" && s.spell === "fireball")).toHaveLength(1);
    expect(spell[1].snapshot?.spells).toEqual(["frost_bolt", "fireball"]);
  });

  test("leaves the admin role as asked, not flipped back", async () => {
    const on = await twice("admin.set", { value: true });
    expect(on.map((r) => r.ok)).toEqual([true, true]);
    expect(heroRow("accounts").role).toBe(1);
    expect(on[1].snapshot?.isAdmin).toBe(true);

    await twice("admin.set", { value: false });
    expect(heroRow("accounts").role).toBe(0);
  });

  // From the server log of 2026-10-04: "Quest accept failed ... Duplicate entry 'lillious-3' for key
  // 'quest_log.PRIMARY'" beside one "applied quest.accept", and every quest.forget applied twice.
  test("starts a quest once, with no second insert, and forgets it once", async () => {
    const started = await twice("quest.accept", { questId: 1 });
    expect(started.map((r) => r.ok)).toEqual([true, false]);
    expect(started[1].errors.join(" ")).toMatch(/already in your log/);
    expect(tables.quest_log.filter((row) => row.username === "hero" && row.quest_id === 1)).toHaveLength(1);
    expect(queries.filter((q) => q.startsWith("INSERT INTO quest_log"))).toHaveLength(1);

    const forgotten = await twice("quest.forget", { questId: 1 });
    expect(forgotten.map((r) => r.ok)).toEqual([true, false]);
    expect(forgotten[1].errors.join(" ")).toMatch(/no record of that quest/);
    expect(tables.quest_log).toEqual([]);
  });
});

describe("location", () => {
  test("the map must exist and the position must be inside it", async () => {
    await expectRefused("location.set", { map: "moon", x: 1, y: 1 }, /map does not exist/);
    await expectRefused("location.set", { map: "overworld", x: 3201, y: 1 }, /X must be a whole number from 0 to 3200/);
    await expectRefused("location.set", { map: "overworld", x: 1, y: -1 }, /Y must be a whole number from 0 to 1600/);
    await expectRefused("location.set", { map: "overworld", x: 1, y: 1, direction: "sideways" }, /not a direction/);
    heroRow("accounts").is_dead = 2;
    // Written behind the engine's back: the account it holds by now is read again.
    await clearCaches();
    await expectRefused("location.set", { map: "overworld", x: 1, y: 1 }, /revive them/);
  });

  test("an offline player is moved in the database, an online one through the socket layer", async () => {
    expect((await act("location.set", { map: "overworld.json", x: 64, y: 96, direction: "up" })).ok).toBe(true);
    expect(heroRow("accounts")).toMatchObject({ map: "overworld", position: "64,96", direction: "up" });

    login("hero", "7001");
    queries.length = 0;
    expect((await act("location.set", { map: "overworld", x: 10, y: 20 })).ok).toBe(true);
    expect(bridged).toEqual(["relocate:overworld:10:20:down"]);
    expect(writes()).toEqual([]);
  });
});

describe("search", () => {
  const find = async (data: Row) => {
    const result = await editor.handleEditorPacket(ADMIN, "PLAYER_EDITOR_SEARCH", data);
    if (result.kind !== "search") throw new Error("expected search results");
    return result.data;
  };

  test("players: whoever is online until something is typed, then every account", async () => {
    login("ally", "7002");
    // Contained, not equal: other test files leave players in the shared cache.
    const online = await find({ kind: "players", query: "" });
    expect(online.kind === "players" && online.players).toContainEqual({ username: "ally", userid: 4204, online: true });
    const typed = await find({ kind: "players", query: "  LL%' " });
    expect(typed.kind === "players" && typed.players).toEqual([{ username: "ally", userid: 4204, online: true }]);
    const both = await find({ kind: "players", query: "o" });
    expect(both.kind === "players" && both.players.map((p) => `${p.username}:${p.online}`)).toEqual(["boss:false", "hero:false", "mod:false"]);
    // Nothing a username can hold: no query is made of it.
    queries.length = 0;
    expect(await find({ kind: "players", query: "%%" })).toMatchObject({ players: [] });
    expect(queries.filter((q) => q.includes("LIKE"))).toEqual([]);
  });

  test("items: by name, or everything that fits a slot", async () => {
    expect(await find({ kind: "items", query: "" })).toMatchObject({ items: [] });
    const named = await find({ kind: "items", query: "HEL" });
    expect(named.kind === "items" && named.items.map((i) => i.name)).toEqual(["Iron Helmet"]);
    const slotted = await find({ kind: "items", query: "", slot: "helmet" });
    expect(slotted.kind === "items" && slotted.items.map((i) => i.name)).toEqual(["Iron Helmet", "Leather Cap"]);
    expect(await find({ kind: "items", query: "", slot: "username" })).toMatchObject({ slot: null, items: [] });
  });
});
