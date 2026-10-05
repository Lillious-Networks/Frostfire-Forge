import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// ------------------------------------------------------------ fake database
// The few statement shapes the quest system and the inventory and bags behind
// it send, run against in-memory tables: what a test then finds in a table is
// what the statements left there, and the caches are held up against it. A
// statement on a quest table that is not understood is an error, so a read
// that is not a cache filling itself fails the test that made it.

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let nextId: number;
/** Every statement sent, with its values, in order. */
let queries: Array<[string, any[]]>;
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null;
/** The refused statement was written all the same: its answer is what was lost. */
let lostAfterWriting: boolean;
/** The first statement matching `match` waits, once sent, until it is released. */
let gate: { match: RegExp; reached: Promise<void>; arrive: () => void; open: Promise<void>; release: () => void } | null;

const LOG_LOAD = "SELECT quest_id, state, accepted_at, completed_at, times_completed FROM quest_log WHERE username = ?";
const PROGRESS_LOAD = "SELECT quest_id, objective_id, count FROM quest_objective_progress WHERE username = ?";
const QUEST_TABLE = /\b(quest_log|quest_objective_progress)\b/;
// The definitions are seeded by hand here: their tables hold nothing, and take any write.
const DEFINITION_TABLE = /(FROM|INTO|UPDATE) (quests|quest_objectives|quest_rewards|quest_prerequisites|npc_quests)\b/;
// The tables this file fills. A login has every system's player cache fill itself: a read of any other table finds nothing.
const READ_HERE = /FROM (quest_log|quest_objective_progress|inventory|bags|stats)\b/;

/** Columns that make a row unique: a second row of the same key is refused. */
const KEYS: Record<string, string[]> = {
  quest_log: ["username", "quest_id"],
  quest_objective_progress: ["username", "quest_id", "objective_id"],
};
/** What a new row has in the columns an INSERT does not name. */
const DEFAULTS: Record<string, () => Row> = {
  inventory: () => ({ id: nextId++, equipped: 0, slot: null, bag_slot: null }),
};
/** Whole-number columns: text handed to one is stored as the number. */
const NUMBERS = new Set(["quantity", "count"]);

function literal(token: string, args: any[]): any {
  if (token === "?") return args.shift();
  if (token === "NULL") return null;
  if (token.startsWith("'")) return token.slice(1, -1);
  return Number(token);
}

const stored = (column: string, value: any) => (NUMBERS.has(column) && typeof value === "string" ? Number(value) : value);

function where(clause: string | undefined, args: any[]): (row: Row) => boolean {
  if (!clause) return () => true;
  const tests = clause.split(" AND ").map((part) => {
    const [, column, op, rhs] = part.match(/^(\w+) (=|!=) (.+)$/)!;
    const wanted = literal(rhs, args);
    // Loose on purpose: ids arrive as numbers and as strings.
    return (row: Row) => (op === "=") === (row[column] == wanted);
  });
  return (row) => tests.every((passes) => passes(row));
}

function run(text: string, params: any[]): any {
  const args = [...params];
  if (DEFINITION_TABLE.test(text)) return text.startsWith("SELECT") ? [] : { affectedRows: 0 };
  if (text.startsWith("SELECT") && !READ_HERE.test(text)) return [];

  const select = text.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (.+))?$/);
  if (select) {
    const [, columns, table, clause] = select;
    const rows = (tables[table] || []).filter(where(clause, args));
    if (columns === "*") return rows.map((row) => ({ ...row }));
    return rows.map((row) => Object.fromEntries(columns.split(", ").map((column) => [column, row[column]])));
  }

  const insert = text.match(/^INSERT (IGNORE )?INTO (\w+) \((.+?)\) VALUES \((.+?)\)$/);
  if (insert) {
    const [, , table, columns, values] = insert;
    const tokens = values.split(", ");
    const row: Row = DEFAULTS[table]?.() ?? {};
    columns.split(", ").forEach((column, i) => { row[column] = stored(column, literal(tokens[i], args)); });
    if (KEYS[table] && (tables[table] || []).some((other) => KEYS[table].every((key) => other[key] == row[key]))) {
      throw new Error(`Duplicate entry for ${table}`);
    }
    (tables[table] ||= []).push(row);
    return { affectedRows: 1, lastInsertRowid: row.id };
  }

  const update = text.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/);
  if (update) {
    const [, table, sets, clause] = update;
    const assign = sets.split(", ").map((part) => {
      const [, column, rhs] = part.match(/^(\w+) = (.+)$/)!;
      return [column, stored(column, literal(rhs, args))] as const;
    });
    const rows = (tables[table] || []).filter(where(clause, args));
    for (const row of rows) for (const [column, value] of assign) row[column] = value;
    return { affectedRows: rows.length };
  }

  const remove = text.match(/^DELETE FROM (\w+) WHERE (.+)$/);
  if (remove) {
    const [, table, clause] = remove;
    const matches = where(clause, args);
    const before = (tables[table] || []).length;
    tables[table] = (tables[table] || []).filter((row) => !matches(row));
    return { affectedRows: before - tables[table].length };
  }

  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, params: any[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    queries.push([text, params]);
    if (gate?.match.test(text)) {
      const held = gate;
      gate = null;
      held.arrive();
      await held.open;
    }
    if (failing?.test(text)) {
      if (lostAfterWriting) run(text, params);
      throw new Error("connection lost");
    }
    return run(text, params);
  },
}));

const item = (name: string, over: Row = {}): Row => ({ name, quality: "common", type: "material", description: "", icon: null, bag_slots: null, ...over });
const JUNK = Array.from({ length: 25 }, (_, i) => `Junk ${i}`);
const assets = new Map<string, any>([
  ["items", [item("Bread"), item("Rat Tail"), item("Lantern"), item("Torch"), item("Small Pouch", { type: "bag", bag_slots: 4 }), ...JUNK.map((name) => item(name))]],
]);
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => assets.get(key) ?? null,
    set: async (key: string, value: any) => assets.set(key, value),
    add: async (key: string, value: any) => assets.set(key, value),
  },
}));

const datacache = await import("../services/datacache");
const { default: playerCache } = await import("../services/playermanager");
const { default: log } = await import("../modules/logger");
const { listener } = await import("../modules/event_bus");
const { Events } = await import("../systems/events");
const defs = await import("../systems/quests/definitions");
const questLog = await import("../systems/quests/log");
const objectives = await import("../systems/quests/objectives");
const editor = await import("../systems/quests/editor");
const { default: inventory } = await import("../systems/inventory");

// ------------------------------------------------------------------ fixtures

const objective = (id: number, quest_id: number, type: QuestObjectiveType, target: string, required_count: number, over: Partial<QuestObjective> = {}): QuestObjective => ({
  id, quest_id, sort_order: id, type, target, required_count, target_x: null, target_y: null, target_radius: null, description: null, ...over,
});
const quest = (id: number, name: string, over: Partial<Quest> = {}): Quest => ({
  id, name, zone: null, offer_text: "", description: "", progress_text: "", completion_text: "",
  required_level: 1, quest_level: 1, xp_reward: 0, copper_reward: 0, repeatable: "none", next_quest_id: null, sort_order: id,
  objectives: [], rewards: [], prerequisites: [], ...over,
});
const reward = (quest_id: number, item_name: string): QuestReward => ({ id: quest_id * 10, quest_id, item_name, quantity: 1, is_choice: false, sort_order: 0 });

const QUESTS: Quest[] = [
  quest(1, "Rats in the Cellar", { objectives: [objective(101, 1, "kill", "1", 3)] }),
  quest(4, "Tails", { objectives: [objective(401, 4, "collect", "Rat Tail", 2)] }),
  quest(10, "Rat Catcher", {
    repeatable: "repeatable",
    objectives: [objective(1001, 10, "kill", "5", 2), objective(1002, 10, "collect", "Rat Tail", 2)],
    rewards: [reward(10, "Bread")],
  }),
  quest(11, "Daily Bread", { repeatable: "daily", objectives: [objective(1101, 11, "kill", "5", 1)] }),
  quest(20, "Lookout", { objectives: [objective(2001, 20, "explore", "overworld", 1, { target_x: 100, target_y: 100, target_radius: 60 })] }),
  quest(30, "Supplies", { rewards: [reward(30, "Lantern")] }),
  quest(50, "Dragon", { required_level: 50 }),
];
const NPC = 1;
const LINKS = QUESTS.flatMap((q) => [{ npc_id: NPC, quest_id: q.id, role: "giver" }, { npc_id: NPC, quest_id: q.id, role: "ender" }]);

const SESSIONS: Record<string, string> = { hero: "8201", ally: "8202" };

const logRow = (username: string, quest_id: number, state = "active", over: Row = {}): Row =>
  ({ username, quest_id, state, accepted_at: 1000, completed_at: state === "completed" ? 2000 : 0, times_completed: state === "completed" ? 1 : 0, ...over });
const count = (username: string, quest_id: number, objective_id: number, value: number): Row => ({ username, quest_id, objective_id, count: value });

/** Put a player online and build the log they carry from their rows, as a login does. */
async function login(username = "hero"): Promise<any> {
  const live: Row = {
    id: SESSIONS[username], username, stats: { level: 5 },
    location: { map: "overworld", position: { x: 0, y: 0 } }, questlog: null,
  };
  playerCache.add(live.id, live);
  await questLog.load(username);
  return live;
}

const byQuest = (a: Row, b: Row) => a.quest_id - b.quest_id || (a.objective_id ?? 0) - (b.objective_id ?? 0);
const pick = (row: Row, columns: string[]) => Object.fromEntries(columns.map((column) => [column, row[column]]));

/** A player's rows as the tables have them. */
const inTables = (username: string): { log: Row[]; progress: Row[] } => ({
  log: (tables.quest_log || []).filter((row) => row.username === username)
    .map((row) => pick(row, ["quest_id", "state", "accepted_at", "completed_at", "times_completed"])).sort(byQuest),
  progress: (tables.quest_objective_progress || []).filter((row) => row.username === username)
    .map((row) => pick(row, ["quest_id", "objective_id", "count"])).sort(byQuest),
});

/** The log a player should be carrying, worked out from the tables here rather than by the code under test. */
function logOf(username: string) {
  const rows = inTables(username);
  const counts = (questId: number) => Object.fromEntries(rows.progress.filter((row) => row.quest_id === questId).map((row) => [row.objective_id, row.count]));
  return {
    active: rows.log.filter((row) => row.state !== "completed").map((row) => ({ ...row, progress: counts(row.quest_id) })),
    completed: rows.log.filter((row) => row.state === "completed").map((row) => row.quest_id),
  };
}

/** The log a player is carrying, in the same order. */
const carried = (live: any) => ({
  active: live.questlog.active.map((entry: Row) => ({ ...entry, progress: { ...entry.progress } })).sort(byQuest),
  completed: [...live.questlog.completed].sort((a: number, b: number) => a - b),
});

const questReads = (since = 0) => queries.slice(since).map(([sql]) => sql).filter((sql) => sql.startsWith("SELECT") && QUEST_TABLE.test(sql));
const sent = (match: RegExp, since = 0) => queries.slice(since).map(([sql]) => sql).filter((sql) => match.test(sql));
const snapshot = () => structuredClone({ log: tables.quest_log, progress: tables.quest_objective_progress });

/** A player's rows as the quest system answers them, in the order the tables are compared in. */
async function rowsOf(username: string): Promise<{ log: Row[]; progress: Row[] }> {
  const rows = await questLog.rowsOf(username);
  return { log: [...rows.log].sort(byQuest), progress: [...rows.progress].sort(byQuest) };
}

/** The rows held of a player, having checked they were answered without the database. */
async function heldRows(username: string) {
  const before = queries.length;
  const rows = await rowsOf(username);
  expect(queries.slice(before)).toEqual([]);
  return rows;
}

/** The rows held of each player are what the tables have, and so is the log each one carries. */
async function inStep(...lives: any[]) {
  for (const live of lives) {
    expect(await heldRows(live.username)).toEqual(inTables(live.username));
    expect(carried(live)).toEqual(logOf(live.username));
  }
}

/** Hold the first statement matching `match` until released. */
function hold(match: RegExp) {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  const open = new Promise<void>((resolve) => { release = resolve; });
  gate = { match, reached, arrive, open, release };
  return gate;
}

/** Long enough for anything not waiting on a held statement to have sent its own. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

const emitted = (event: string) => emit.mock.calls.filter(([name]: any[]) => name === event).map(([, data]: any[]) => data);

/** Nobody this file names is online. The player cache is shared: other test files leave their players in it. */
function logEveryoneOut() {
  for (const [id, live] of Object.entries(playerCache.list() as Record<string, any>)) {
    if (["hero", "ally", "ghost"].includes(String(live?.username).toLowerCase())) playerCache.remove(id);
  }
}

let emit: ReturnType<typeof spyOn>;
let logged: Array<ReturnType<typeof spyOn>>;
/** The players other test files left online in the shared cache: out of it while this file runs, and put back after. */
let others: Array<[string, any]>;
beforeAll(() => {
  others = Object.entries(playerCache.list() as Record<string, any>);
  for (const [id] of others) playerCache.remove(id);
  emit = spyOn(listener, "emit");
  logged = [spyOn(log, "info"), spyOn(log, "warn"), spyOn(log, "error"), spyOn(log, "success")].map((spy) => spy.mockImplementation(() => {}));
});
afterAll(async () => {
  emit.mockRestore();
  for (const spy of logged) spy.mockRestore();
  logEveryoneOut();
  for (const [id, live] of others) playerCache.add(id, live);
  // What this file's database answered is not for the files that follow.
  await datacache.clearCaches();
});

beforeEach(async () => {
  logEveryoneOut();
  await datacache.clearCaches();
  objectives.clearRadiusPlayersForTests();
  defs.setCachedQuestsSync(QUESTS);
  defs.setIndexesForTests(defs.buildIndexes(QUESTS, LINKS));
  tables = { quest_log: [], quest_objective_progress: [], inventory: [], bags: [], stats: [] };
  nextId = 500;
  queries = [];
  failing = null;
  lostAfterWriting = false;
  gate = null;
  emit.mockClear();
});

// ------------------------------------------------------------ reads, read once

describe("a player's quest rows are read once and then held", () => {
  test("the log is built from the rows held: asked for again, the database is not", async () => {
    tables.quest_log.push(logRow("hero", 1), logRow("hero", 4, "ready"), logRow("hero", 10, "completed"));
    tables.quest_objective_progress.push(count("hero", 1, 101, 2), count("hero", 4, 401, 2));

    const first = await questLog.load("hero");
    expect(first).toEqual({
      active: [
        { quest_id: 1, state: "active", accepted_at: 1000, completed_at: 0, times_completed: 0, progress: { 101: 2 } },
        { quest_id: 4, state: "ready", accepted_at: 1000, completed_at: 0, times_completed: 0, progress: { 401: 2 } },
      ],
      completed: [10],
    });
    expect(await questLog.load("hero")).toEqual(first);
    expect(await questLog.load("HERO")).toEqual(first);
    expect(queries).toEqual([[LOG_LOAD, ["hero"]], [PROGRESS_LOAD, ["hero"]]]);
  });

  test("a player with no quests has an empty log, and is not asked about twice", async () => {
    expect(await questLog.load("hero")).toEqual({ active: [], completed: [] });
    expect(await questLog.load("hero")).toEqual({ active: [], completed: [] });
    expect(queries).toEqual([[LOG_LOAD, ["hero"]], [PROGRESS_LOAD, ["hero"]]]);
  });

  test("what the rows answer is a copy: changing it changes nothing held", async () => {
    tables.quest_log.push(logRow("hero", 1));
    (await questLog.rowsOf("hero")).log[0].state = "completed";
    (await questLog.load("hero")).active.length = 0;
    expect((await questLog.rowsOf("hero")).log[0].state).toBe("active");
  });

  test("a player's rows are read again when they log in, and forgotten when they leave", async () => {
    await questLog.rowsOf("hero");
    // Written while they were away, by something that is not this server.
    tables.quest_log.push(logRow("hero", 1));
    const asked = queries.length;
    await datacache.refreshPlayer("hero");
    expect(await heldRows("hero")).toEqual(inTables("hero"));
    expect(questReads(asked).sort()).toEqual([PROGRESS_LOAD, LOG_LOAD]);

    await datacache.forgetPlayer("hero");
    await questLog.rowsOf("hero");
    expect(questReads()).toHaveLength(6);
  });

  test("the rows are known by their agreed names: told to forget a player, they are read again", async () => {
    await questLog.rowsOf("hero");
    tables.quest_log.push(logRow("hero", 1));
    tables.quest_objective_progress.push(count("hero", 1, 101, 1));
    await datacache.dropRows("quest_log", "hero");
    await datacache.dropRows("quest_progress", "hero");
    expect(await rowsOf("hero")).toEqual(inTables("hero"));
    expect(questReads()).toEqual([LOG_LOAD, PROGRESS_LOAD, LOG_LOAD, PROGRESS_LOAD]);
  });

  test("when a daily quest was last completed is answered from the rows held", async () => {
    const reset = questLog.lastResetBoundary();
    tables.quest_log.push(logRow("hero", 11, "completed", { completed_at: reset + 1000 }));
    await login();
    const asked = queries.length;
    expect(await questLog.eligibility("hero", 11)).toBe("daily_not_reset");
    expect(await questLog.offersFor("hero", NPC)).toContainEqual(expect.objectContaining({ questId: 11, reason: "daily_not_reset" }));
    expect(queries.slice(asked)).toEqual([]);
  });

  test("a daily quest completed before the last reset can be taken again", async () => {
    tables.quest_log.push(logRow("hero", 11, "completed", { completed_at: questLog.lastResetBoundary() - 1000 }));
    await login();
    expect(await questLog.eligibility("hero", 11)).toBe("available");
  });

  test("an offline player's level is asked of the player system, which reads their stats once", async () => {
    tables.stats.push({ username: "ghost", level: 5, health: 100, max_health: 100, stamina: 100, max_stamina: 100, xp: 0, max_xp: 100 });
    expect(await questLog.eligibility("ghost", 50)).toBe("level_too_low");
    expect(await questLog.eligibility("ghost", 1)).toBe("available");
    tables.stats[0].level = 60;
    // Still the level that was read: the stats are the player system's to keep in step.
    expect(await questLog.eligibility("ghost", 50)).toBe("level_too_low");
    expect(sent(/FROM stats/)).toEqual(["SELECT * FROM stats WHERE username = ?"]);
    expect(sent(/SELECT level FROM stats/)).toEqual([]);
  });
});

// --------------------------------------------------- the life of a quest, in step

describe("through a quest's whole life the rows held are what the tables hold", () => {
  test("accept, progress twice, complete, hand in, and take the repeatable again", async () => {
    const hero = await login();
    await inStep(hero);

    // Accepted from its giver.
    const accepted = await questLog.accept("hero", 10, NPC);
    expect(accepted).toMatchObject({ ok: true, entry: { quest_id: 10, state: "active", progress: {} } });
    expect(tables.quest_log).toEqual([expect.objectContaining({ username: "hero", quest_id: 10, state: "active", times_completed: 0 })]);
    await inStep(hero);

    // Two kills: the first makes the count's row, the second changes it.
    expect(await objectives.credit("hero", "kill", "5", 1)).toEqual([expect.objectContaining({ objectiveId: 1001, count: 1, questReady: false })]);
    expect(tables.quest_objective_progress).toEqual([count("hero", 10, 1001, 1)]);
    await inStep(hero);
    expect(await objectives.credit("hero", "kill", "5", 1)).toEqual([expect.objectContaining({ objectiveId: 1001, count: 2, questReady: false })]);
    expect(tables.quest_objective_progress).toEqual([count("hero", 10, 1001, 2)]);
    await inStep(hero);

    // Picking up the tails completes it: the inventory tells the quest what the player now holds.
    await inventory.add("hero", { name: "Rat Tail", quantity: 2 } as any);
    expect(tables.quest_objective_progress).toContainEqual(count("hero", 10, 1002, 2));
    expect(tables.quest_log[0].state).toBe("ready");
    expect(objectives.isComplete("hero", 10)).toBe(true);
    await inStep(hero);

    // Handed in: the reward arrives and the quest is history.
    const handedIn = await questLog.turnIn("hero", 10, NPC);
    expect(handedIn).toMatchObject({ ok: true, questId: 10, items: [{ name: "Bread", quantity: 1 }] });
    expect(tables.quest_log[0]).toMatchObject({ state: "completed", times_completed: 1 });
    expect(tables.inventory).toContainEqual(expect.objectContaining({ username: "hero", item: "Bread", quantity: 1 }));
    expect(hero.questlog).toEqual({ active: [], completed: [10] });
    await inStep(hero);

    // Taken again: the old counts go, and the tails still held count at once.
    expect(await questLog.eligibility("hero", 10)).toBe("available");
    const again = await questLog.accept("hero", 10, NPC);
    expect(again).toMatchObject({ ok: true, entry: { quest_id: 10, state: "active", times_completed: 1, progress: { 1002: 2 } } });
    expect(tables.quest_log).toEqual([expect.objectContaining({ quest_id: 10, state: "active", completed_at: 0, times_completed: 1 })]);
    expect(tables.quest_objective_progress).toEqual([count("hero", 10, 1002, 2)]);
    await inStep(hero);

    // And through to the second hand-in.
    await objectives.credit("hero", "kill", "5", 1);
    await inStep(hero);
    expect(await objectives.credit("hero", "kill", "5", 1)).toEqual([expect.objectContaining({ count: 2, questReady: true })]);
    await inStep(hero);
    expect((await questLog.turnIn("hero", 10, NPC)).ok).toBe(true);
    expect(tables.quest_log[0]).toMatchObject({ state: "completed", times_completed: 2 });
    expect(tables.inventory).toContainEqual(expect.objectContaining({ item: "Bread", quantity: 2 }));
    await inStep(hero);

    // All of it from the one read of each table the login made.
    expect(questReads()).toEqual([LOG_LOAD, PROGRESS_LOAD]);
  });

  test("the same steps leave a player who logs in again with the log they left with", async () => {
    const hero = await login();
    await questLog.accept("hero", 1, NPC);
    await objectives.credit("hero", "kill", "1", 2);
    await questLog.accept("hero", 30, NPC);
    await questLog.turnIn("hero", 30, NPC);
    const left = carried(hero);

    logEveryoneOut();
    await datacache.forgetPlayer("hero");
    expect(carried(await login())).toEqual(left);
  });

  test("abandoning takes the quest and its counts away, and keeps a completed quest's history", async () => {
    tables.quest_log.push(logRow("hero", 10, "completed"));
    const hero = await login();
    await questLog.accept("hero", 1, NPC);
    await objectives.credit("hero", "kill", "1", 2);

    await questLog.abandon("hero", 1);
    expect(inTables("hero")).toEqual({ log: [expect.objectContaining({ quest_id: 10, state: "completed" })], progress: [] });
    expect(emitted(Events.QUEST_ABANDONED)).toEqual([{ username: "hero", questId: 1 }]);
    await inStep(hero);

    // Not in the log: nothing of the completed quest is taken.
    await questLog.abandon("hero", 10);
    expect(tables.quest_log).toHaveLength(1);
    await inStep(hero);
  });

  test("the admin tools start, complete and forget a quest for a player who is offline", async () => {
    expect((await questLog.forceAccept("ghost", 1)).ok).toBe(true);
    expect(await heldRows("ghost")).toEqual(inTables("ghost"));
    expect(inTables("ghost").log).toEqual([expect.objectContaining({ quest_id: 1, state: "active" })]);

    expect(await questLog.forceComplete("ghost", 1)).toEqual({ ok: true });
    expect(await heldRows("ghost")).toEqual(inTables("ghost"));
    expect(inTables("ghost").log).toEqual([expect.objectContaining({ quest_id: 1, state: "completed", times_completed: 1 })]);
    expect(await questLog.forceComplete("ghost", 1)).toMatchObject({ ok: false, code: "completed" });

    // Completed without ever being in the log.
    expect(await questLog.forceComplete("ghost", 4)).toEqual({ ok: true });
    expect(await heldRows("ghost")).toEqual(inTables("ghost"));

    await questLog.forget("ghost", 1);
    expect(await heldRows("ghost")).toEqual(inTables("ghost"));
    expect(inTables("ghost").log.map((row) => row.quest_id)).toEqual([4]);
    expect(questReads()).toEqual([LOG_LOAD, PROGRESS_LOAD]);
  });

  test("the admin tools do the same to the log an online player carries", async () => {
    const hero = await login();
    await questLog.forceAccept("hero", 1);
    await objectives.credit("hero", "kill", "1", 2);
    await inStep(hero);
    await questLog.forceComplete("hero", 1);
    expect(hero.questlog).toEqual({ active: [], completed: [1] });
    expect(tables.quest_objective_progress).toEqual([]);
    await inStep(hero);
    await questLog.forget("hero", 1);
    expect(hero.questlog).toEqual({ active: [], completed: [] });
    await inStep(hero);
  });

  test("a collect count follows the inventory down again, and the quest stops being ready", async () => {
    const hero = await login();
    await questLog.accept("hero", 4, NPC);
    await inventory.add("hero", { name: "Rat Tail", quantity: 3 } as any);
    expect(inTables("hero")).toEqual({ log: [expect.objectContaining({ quest_id: 4, state: "ready" })], progress: [{ quest_id: 4, objective_id: 401, count: 2 }] });
    await inStep(hero);

    await inventory.remove("hero", { name: "Rat Tail", quantity: 2 } as any);
    expect(inTables("hero")).toEqual({ log: [expect.objectContaining({ quest_id: 4, state: "active" })], progress: [{ quest_id: 4, objective_id: 401, count: 1 }] });
    await inStep(hero);
  });

  test("standing in an explore objective's radius completes it", async () => {
    const hero = await login();
    await questLog.accept("hero", 20, NPC);
    expect(objectives.getRadiusPlayers()).toEqual(["hero"]);
    expect(await objectives.checkExplorePosition("hero", "overworld", 500, 500)).toEqual([]);
    expect(await objectives.checkExplorePosition("hero", "overworld", 110, 105)).toEqual([expect.objectContaining({ objectiveId: 2001, count: 1, questReady: true })]);
    expect(inTables("hero").log[0].state).toBe("ready");
    await inStep(hero);
  });

  test("clearing a quest's progress takes its counts from the table and from the log", async () => {
    tables.quest_log.push(logRow("hero", 1, "ready"));
    tables.quest_objective_progress.push(count("hero", 1, 101, 3));
    const hero = await login();
    await objectives.clear("hero", 1);
    expect(tables.quest_objective_progress).toEqual([]);
    // With no counts it is no longer ready, in the table as on the entry.
    expect(hero.questlog.active[0]).toMatchObject({ state: "active", progress: {} });
    await inStep(hero);
  });

  test("clearing the progress of a quest with no objectives leaves it ready", async () => {
    tables.quest_log.push(logRow("hero", 30, "ready"));
    const hero = await login();
    await objectives.clear("hero", 30);
    expect(hero.questlog.active[0].state).toBe("ready");
    await inStep(hero);
  });

  test("taking a repeatable again clears its old counts before it is active again", async () => {
    tables.quest_log.push(logRow("hero", 10, "completed"));
    tables.quest_objective_progress.push(count("hero", 10, 1001, 2), count("hero", 10, 1002, 2));
    await login();
    const asked = queries.length;
    await questLog.accept("hero", 10, NPC);
    expect(queries.slice(asked).map(([sql]) => sql).filter((sql) => !sql.startsWith("SELECT"))).toEqual([
      "DELETE FROM quest_objective_progress WHERE username = ? AND quest_id = ?",
      "UPDATE quest_log SET state = ?, accepted_at = ?, completed_at = 0 WHERE username = ? AND quest_id = ?",
    ]);
  });

  test("changes made side by side leave the rows held as the tables have them", async () => {
    const hero = await login();
    await Promise.all([questLog.accept("hero", 1, NPC), questLog.accept("hero", 4, NPC), questLog.accept("hero", 10, NPC)]);
    await Promise.all([
      objectives.credit("hero", "kill", "1", 1),
      objectives.credit("hero", "kill", "5", 1),
      inventory.add("hero", { name: "Rat Tail", quantity: 1 } as any),
      questLog.abandon("hero", 4),
    ]);
    expect(await heldRows("hero")).toEqual(inTables("hero"));
    expect(inTables("hero").log.map((row) => row.quest_id)).toEqual([1, 10]);
    expect(hero.questlog.active.map((entry: Row) => entry.quest_id).sort((a: number, b: number) => a - b)).toEqual([1, 10]);
    expect(questReads()).toEqual([LOG_LOAD, PROGRESS_LOAD]);
  });
});

// ------------------------------------------------- a write the database refuses

interface FailingWrite {
  name: string;
  /** The tables as they are before the player logs in. */
  seed: () => void;
  act: () => Promise<unknown>;
  /** The statement that fails. */
  fails: RegExp;
  /** A statement before the failing one is written, so a refusal still leaves the tables changed. */
  partial?: boolean;
}

const oneActive = () => {
  tables.quest_log.push(logRow("hero", 1));
  tables.quest_objective_progress.push(count("hero", 1, 101, 2));
};
const collectReady = () => {
  tables.quest_log.push(logRow("hero", 4, "ready"));
  tables.quest_objective_progress.push(count("hero", 4, 401, 2));
};
const repeatableDone = () => {
  tables.quest_log.push(logRow("hero", 10, "completed"));
  tables.quest_objective_progress.push(count("hero", 10, 1001, 2), count("hero", 10, 1002, 2));
};
const everyone = () => {
  oneActive();
  tables.quest_log.push(logRow("hero", 4), logRow("ally", 1, "completed"), logRow("ally", 4));
  tables.quest_objective_progress.push(count("ally", 4, 401, 1));
};

const COUNTS_OF_ONE = /^DELETE FROM quest_objective_progress WHERE username/;
const QUEST_OF_ONE = /^DELETE FROM quest_log WHERE username/;

const FAILING_WRITES: FailingWrite[] = [
  { name: "accept, adding the quest", seed: () => {}, act: () => questLog.accept("hero", 1, NPC), fails: /^INSERT INTO quest_log/ },
  { name: "accept of a repeatable again, clearing its old counts", seed: repeatableDone, act: () => questLog.accept("hero", 10, NPC), fails: COUNTS_OF_ONE },
  { name: "accept of a repeatable again, making it active", seed: repeatableDone, act: () => questLog.accept("hero", 10, NPC), fails: /^UPDATE quest_log SET state = \?/, partial: true },
  { name: "abandon, clearing the counts", seed: oneActive, act: () => questLog.abandon("hero", 1), fails: COUNTS_OF_ONE },
  { name: "abandon, removing the quest", seed: oneActive, act: () => questLog.abandon("hero", 1), fails: QUEST_OF_ONE, partial: true },
  { name: "force-complete of a quest in the log", seed: oneActive, act: () => questLog.forceComplete("hero", 1), fails: /^UPDATE quest_log SET state = 'completed'/ },
  { name: "force-complete of a quest never taken", seed: () => {}, act: () => questLog.forceComplete("hero", 1), fails: /^INSERT INTO quest_log/ },
  { name: "force-complete, clearing the counts", seed: oneActive, act: () => questLog.forceComplete("hero", 1), fails: COUNTS_OF_ONE, partial: true },
  { name: "forget, clearing the counts", seed: repeatableDone, act: () => questLog.forget("hero", 10), fails: COUNTS_OF_ONE },
  { name: "forget, removing the quest", seed: repeatableDone, act: () => questLog.forget("hero", 10), fails: QUEST_OF_ONE, partial: true },
  {
    name: "hand-in", fails: /^UPDATE quest_log SET state = 'completed'/,
    seed: () => { tables.quest_log.push(logRow("hero", 1, "ready")); tables.quest_objective_progress.push(count("hero", 1, 101, 3)); },
    act: () => questLog.turnIn("hero", 1, NPC),
  },
  { name: "an objective's first count", seed: () => { tables.quest_log.push(logRow("hero", 1)); }, act: () => objectives.credit("hero", "kill", "1", 1), fails: /^INSERT INTO quest_objective_progress/ },
  {
    name: "an objective's next count", fails: /^UPDATE quest_objective_progress/,
    seed: () => { tables.quest_log.push(logRow("hero", 1)); tables.quest_objective_progress.push(count("hero", 1, 101, 1)); },
    act: () => objectives.credit("hero", "kill", "1", 1),
  },
  { name: "the count that completes, making the quest ready", seed: oneActive, act: () => objectives.credit("hero", "kill", "1", 1), fails: /^UPDATE quest_log SET state = 'ready'/, partial: true },
  { name: "a collect count going down", seed: collectReady, act: () => objectives.sync("hero", "collect", "Rat Tail", 1), fails: /^UPDATE quest_objective_progress/ },
  { name: "a collect count going down, making the quest active again", seed: collectReady, act: () => objectives.sync("hero", "collect", "Rat Tail", 1), fails: /^UPDATE quest_log SET state = 'active'/, partial: true },
  { name: "an explore radius reached", seed: () => { tables.quest_log.push(logRow("hero", 20)); }, act: () => objectives.checkExplorePosition("hero", "overworld", 110, 105), fails: /^INSERT INTO quest_objective_progress/ },
  { name: "an explore radius reached, making the quest ready", seed: () => { tables.quest_log.push(logRow("hero", 20)); }, act: () => objectives.checkExplorePosition("hero", "overworld", 110, 105), fails: /^UPDATE quest_log SET state = 'ready'/, partial: true },
  { name: "a quest's progress cleared", seed: oneActive, act: () => objectives.clear("hero", 1), fails: COUNTS_OF_ONE },
  { name: "a quest deleted in the editor, its counts", seed: everyone, act: () => questLog.removeFromEveryLog(1).catch(() => {}), fails: /^DELETE FROM quest_objective_progress WHERE quest_id/ },
  { name: "a quest deleted in the editor, its place in every log", seed: everyone, act: () => questLog.removeFromEveryLog(1).catch(() => {}), fails: /^DELETE FROM quest_log WHERE quest_id/, partial: true },
];

describe("a quest write that fails: the database is asked once, and what it holds is what is held", () => {
  for (const write of FAILING_WRITES) {
    test(`${write.name}: refused`, async () => {
      write.seed();
      const hero = await login();
      const before = snapshot();
      const asked = queries.length;

      failing = write.fails;
      await write.act();
      failing = null;

      // The one read of each table, made to put the log the player carries back in step.
      expect(questReads(asked)).toEqual([LOG_LOAD, PROGRESS_LOAD]);
      await inStep(hero);
      if (!write.partial) expect(snapshot()).toEqual(before);
    });

    test(`${write.name}: written, but its answer lost`, async () => {
      write.seed();
      const hero = await login();
      const before = snapshot();
      const asked = queries.length;

      failing = write.fails;
      lostAfterWriting = true;
      await write.act();
      failing = null;

      expect(snapshot()).not.toEqual(before);
      expect(questReads(asked)).toEqual([LOG_LOAD, PROGRESS_LOAD]);
      await inStep(hero);
    });

    // Nothing can be read either: what the player carries is all there is to go on, and it must not have moved.
    test(`${write.name}: with the database gone, the log the player carries is as it was`, async () => {
      write.seed();
      const hero = await login();
      const before = snapshot();
      const carriedBefore = carried(hero);

      failing = /./;
      await write.act();
      failing = null;

      expect(carried(hero)).toEqual(carriedBefore);
      expect(snapshot()).toEqual(before);
      // Back again: the rows are asked for once, and are what the tables hold.
      const asked = queries.length;
      expect(await questLog.rowsOf("hero")).toBeDefined();
      expect(questReads(asked)).toEqual([LOG_LOAD, PROGRESS_LOAD]);
      await inStep(hero);
    });
  }

  const OFFLINE: Array<[string, () => Promise<unknown>, RegExp]> = [
    ["force-accept", () => questLog.forceAccept("ghost", 4), /^INSERT INTO quest_log/],
    ["force-complete", () => questLog.forceComplete("ghost", 1), /^UPDATE quest_log SET state = 'completed'/],
    ["abandon", () => questLog.abandon("ghost", 1), QUEST_OF_ONE],
    ["forget", () => questLog.forget("ghost", 1), QUEST_OF_ONE],
  ];
  for (const [name, act, fails] of OFFLINE) {
    for (const lost of [false, true]) {
      test(`${name} for a player who is offline, ${lost ? "written but its answer lost" : "refused"}: their next read asks once`, async () => {
        tables.quest_log.push(logRow("ghost", 1));
        tables.quest_objective_progress.push(count("ghost", 1, 101, 2));
        await questLog.rowsOf("ghost");

        failing = fails;
        lostAfterWriting = lost;
        await act();
        failing = null;

        const asked = queries.length;
        expect(await rowsOf("ghost")).toEqual(inTables("ghost"));
        expect(await heldRows("ghost")).toEqual(inTables("ghost"));
        expect(questReads(asked)).toEqual([LOG_LOAD, PROGRESS_LOAD]);
      });
    }
  }
});

// ------------------------------- what the player is told when a write fails

describe("a quest write that fails changes nothing the player carries, and says so", () => {
  test("accept answers that it could not, and the quest can be accepted once the database is back", async () => {
    const hero = await login();
    failing = /^INSERT INTO quest_log/;
    expect(await questLog.accept("hero", 1, NPC)).toMatchObject({ ok: false, code: "db_error" });
    failing = null;
    expect(hero.questlog).toEqual({ active: [], completed: [] });
    expect(emitted(Events.QUEST_ACCEPTED)).toEqual([]);

    expect((await questLog.accept("hero", 1, NPC)).ok).toBe(true);
    await inStep(hero);
  });

  test("a repeatable that could not be made active again is still completed, with its old counts gone", async () => {
    repeatableDone();
    const hero = await login();
    failing = /^UPDATE quest_log SET state = \?/;
    expect(await questLog.accept("hero", 10, NPC)).toMatchObject({ ok: false, code: "db_error" });
    failing = null;
    expect(hero.questlog).toEqual({ active: [], completed: [10] });
    expect(inTables("hero")).toEqual({ log: [expect.objectContaining({ quest_id: 10, state: "completed" })], progress: [] });
  });

  test("abandon that could not be written leaves the quest in the log, and is not announced", async () => {
    oneActive();
    const hero = await login();
    failing = COUNTS_OF_ONE;
    await questLog.abandon("hero", 1);
    failing = null;
    expect(hero.questlog.active).toEqual([expect.objectContaining({ quest_id: 1, state: "active", progress: { 101: 2 } })]);
    expect(emitted(Events.QUEST_ABANDONED)).toEqual([]);

    await questLog.abandon("hero", 1);
    expect(hero.questlog.active).toEqual([]);
    expect(emitted(Events.QUEST_ABANDONED)).toHaveLength(1);
    await inStep(hero);
  });

  test("forget that could not be written leaves the quest's history in the log", async () => {
    repeatableDone();
    const hero = await login();
    failing = COUNTS_OF_ONE;
    await questLog.forget("hero", 10);
    failing = null;
    expect(hero.questlog).toEqual({ active: [], completed: [10] });
    await inStep(hero);
  });

  test("a kill that could not be written does not count, is not reported, and counts the next time", async () => {
    oneActive();
    const hero = await login();
    failing = /^UPDATE quest_objective_progress/;
    expect(await objectives.credit("hero", "kill", "1", 1)).toEqual([]);
    failing = null;
    expect(hero.questlog.active[0]).toMatchObject({ state: "active", progress: { 101: 2 } });
    expect(emitted(Events.QUEST_OBJECTIVE_PROGRESS)).toEqual([]);
    expect(emitted(Events.QUEST_READY)).toEqual([]);

    expect(await objectives.credit("hero", "kill", "1", 1)).toEqual([expect.objectContaining({ count: 3, questReady: true })]);
    await inStep(hero);
  });

  test("a kill written though its answer was lost is in the log, and the next kill carries on from it", async () => {
    tables.quest_log.push(logRow("hero", 1));
    const hero = await login();
    failing = /^INSERT INTO quest_objective_progress/;
    lostAfterWriting = true;
    expect(await objectives.credit("hero", "kill", "1", 1)).toEqual([]);
    failing = null;
    lostAfterWriting = false;
    expect(hero.questlog.active[0].progress).toEqual({ 101: 1 });

    // The row is there: a second INSERT of it would be refused.
    expect(await objectives.credit("hero", "kill", "1", 1)).toEqual([expect.objectContaining({ count: 2 })]);
    expect(tables.quest_objective_progress).toEqual([count("hero", 1, 101, 2)]);
    await inStep(hero);
  });

  test("a quest that could not be made ready is not ready, and the next kill makes it so", async () => {
    oneActive();
    const hero = await login();
    failing = /^UPDATE quest_log SET state = 'ready'/;
    // The count was written, and is reported; the quest is not ready.
    expect(await objectives.credit("hero", "kill", "1", 1)).toEqual([expect.objectContaining({ objectiveId: 101, count: 3, questReady: false })]);
    failing = null;
    expect(hero.questlog.active[0]).toMatchObject({ state: "active", progress: { 101: 3 } });
    expect(objectives.isComplete("hero", 1)).toBe(true);
    expect(await questLog.turnIn("hero", 1, NPC)).toMatchObject({ ok: false, code: "not_ready" });
    expect(emitted(Events.QUEST_READY)).toEqual([]);
    await inStep(hero);

    // Nothing to add to the count, but the quest is complete: it is made ready now.
    expect(await objectives.credit("hero", "kill", "1", 1)).toEqual([
      { questId: 1, objectiveId: 101, type: "kill", target: "1", count: 3, required: 3, questReady: true },
    ]);
    expect(hero.questlog.active[0].state).toBe("ready");
    expect(emitted(Events.QUEST_READY)).toEqual([{ username: "hero", questId: 1 }]);
    expect(emitted(Events.QUEST_OBJECTIVE_PROGRESS)).toHaveLength(1);
    await inStep(hero);

    // Ready: a kill past the count writes nothing.
    const asked = queries.length;
    expect(await objectives.credit("hero", "kill", "1", 1)).toEqual([]);
    expect(queries.slice(asked)).toEqual([]);
    expect((await questLog.turnIn("hero", 1, NPC)).ok).toBe(true);
  });

  // The entry is all there is to go on when the tables cannot be read back either: it must not say what was not written.
  const AND_NO_READS = "|^SELECT";

  test("a quest that could not be made ready, with nothing to be read either, is not ready on the entry", async () => {
    oneActive();
    const hero = await login();
    failing = new RegExp(/^UPDATE quest_log SET state = 'ready'/.source + AND_NO_READS);
    expect(await objectives.credit("hero", "kill", "1", 1)).toEqual([expect.objectContaining({ count: 3, questReady: false })]);
    failing = null;
    // The count was written and is on the entry; the state was not, and is not.
    expect(hero.questlog.active[0]).toMatchObject({ state: "active", progress: { 101: 3 } });
    expect(emitted(Events.QUEST_READY)).toEqual([]);

    expect(await objectives.credit("hero", "kill", "1", 1)).toEqual([expect.objectContaining({ count: 3, questReady: true })]);
    await inStep(hero);
  });

  test("a quest that could not be made active again, with nothing to be read either, is still ready on the entry", async () => {
    collectReady();
    const hero = await login();
    failing = new RegExp(/^UPDATE quest_log SET state = 'active'/.source + AND_NO_READS);
    await objectives.sync("hero", "collect", "Rat Tail", 1);
    failing = null;
    expect(hero.questlog.active[0]).toMatchObject({ state: "ready", progress: { 401: 1 } });

    await objectives.sync("hero", "collect", "Rat Tail", 1);
    expect(hero.questlog.active[0].state).toBe("active");
    await inStep(hero);
  });

  test("an explore radius that could not be made ready, with nothing to be read either, is not ready on the entry", async () => {
    tables.quest_log.push(logRow("hero", 20));
    const hero = await login();
    failing = new RegExp(/^UPDATE quest_log SET state = 'ready'/.source + AND_NO_READS);
    expect(await objectives.checkExplorePosition("hero", "overworld", 110, 105)).toEqual([expect.objectContaining({ count: 1, questReady: false })]);
    failing = null;
    expect(hero.questlog.active[0]).toMatchObject({ state: "active", progress: { 2001: 1 } });
  });

  test("progress cleared from a ready quest that could not then be made active leaves it ready on the entry", async () => {
    collectReady();
    const hero = await login();
    failing = new RegExp(/^UPDATE quest_log SET state = 'active'/.source + AND_NO_READS);
    await objectives.clear("hero", 4);
    failing = null;
    expect(hero.questlog.active[0]).toMatchObject({ state: "ready", progress: {} });
    expect(tables.quest_log[0].state).toBe("ready");
  });

  test("a quest made ready though the answer was lost is reported ready", async () => {
    oneActive();
    const hero = await login();
    failing = /^UPDATE quest_log SET state = 'ready'/;
    lostAfterWriting = true;
    expect(await objectives.credit("hero", "kill", "1", 1)).toEqual([expect.objectContaining({ count: 3, questReady: true })]);
    failing = null;
    expect(hero.questlog.active[0].state).toBe("ready");
    expect(emitted(Events.QUEST_READY)).toEqual([{ username: "hero", questId: 1 }]);
    await inStep(hero);
  });

  test("a quest that could not be made active again is still ready, and the next sync of the same count makes it active", async () => {
    collectReady();
    const hero = await login();
    failing = /^UPDATE quest_log SET state = 'active'/;
    expect(await objectives.sync("hero", "collect", "Rat Tail", 1)).toEqual([expect.objectContaining({ count: 1, questReady: false })]);
    failing = null;
    expect(hero.questlog.active[0]).toMatchObject({ state: "ready", progress: { 401: 1 } });
    await inStep(hero);

    expect(await objectives.sync("hero", "collect", "Rat Tail", 1)).toEqual([]);
    expect(hero.questlog.active[0].state).toBe("active");
    expect(tables.quest_log[0].state).toBe("active");
    await inStep(hero);
  });

  test("an explore radius whose ready write failed is made ready by the next check of the position", async () => {
    tables.quest_log.push(logRow("hero", 20));
    const hero = await login();
    objectives.trackRadiusPlayer("hero");
    failing = /^UPDATE quest_log SET state = 'ready'/;
    expect(await objectives.checkExplorePosition("hero", "overworld", 110, 105)).toEqual([expect.objectContaining({ count: 1, questReady: false })]);
    failing = null;
    expect(hero.questlog.active[0].state).toBe("active");
    // Still watched: the tick that checks positions comes round again.
    expect(objectives.getRadiusPlayers()).toEqual(["hero"]);

    hero.location.position = { x: 110, y: 105 };
    const ticked = await objectives.tickRadiusObjectives();
    expect(ticked.get("hero")).toEqual([expect.objectContaining({ objectiveId: 2001, count: 1, questReady: true })]);
    expect(hero.questlog.active[0].state).toBe("ready");
    await inStep(hero);
  });

  test("progress that could not be cleared is still on the entry", async () => {
    oneActive();
    const hero = await login();
    failing = COUNTS_OF_ONE;
    await objectives.clear("hero", 1);
    failing = null;
    expect(hero.questlog.active[0].progress).toEqual({ 101: 2 });
    await inStep(hero);
  });

  test("a hand-in whose state could not be saved leaves the quest ready", async () => {
    tables.quest_log.push(logRow("hero", 1, "ready"));
    tables.quest_objective_progress.push(count("hero", 1, 101, 3));
    const hero = await login();
    failing = /^UPDATE quest_log SET state = 'completed'/;
    expect(await questLog.turnIn("hero", 1, NPC)).toMatchObject({ ok: false, code: "db_error" });
    failing = null;
    expect(hero.questlog).toEqual({ active: [expect.objectContaining({ quest_id: 1, state: "ready" })], completed: [] });
    expect(emitted(Events.QUEST_COMPLETED)).toEqual([]);
    await inStep(hero);
  });

  test("a hand-in saved though its answer was lost is not there to hand in twice", async () => {
    tables.quest_log.push(logRow("hero", 1, "ready"));
    tables.quest_objective_progress.push(count("hero", 1, 101, 3));
    const hero = await login();
    failing = /^UPDATE quest_log SET state = 'completed'/;
    lostAfterWriting = true;
    await questLog.turnIn("hero", 1, NPC);
    failing = null;
    expect(hero.questlog).toEqual({ active: [], completed: [1] });
    expect(await questLog.turnIn("hero", 1, NPC)).toMatchObject({ ok: false, code: "not_active" });
    expect(tables.quest_log[0].times_completed).toBe(1);
  });

  test("a failed write stops the credit there: quests after it are left for the next one", async () => {
    tables.quest_log.push(logRow("hero", 10), logRow("hero", 11));
    const hero = await login();
    failing = /^INSERT INTO quest_objective_progress/;
    expect(await objectives.credit("hero", "kill", "5", 1)).toEqual([]);
    failing = null;
    expect(sent(/^INSERT INTO quest_objective_progress/)).toHaveLength(1);

    expect((await objectives.credit("hero", "kill", "5", 1)).map((update) => update.questId).sort((a, b) => a - b)).toEqual([10, 11]);
    await inStep(hero);
  });
});

// ------------------------------------------- a quest deleted from every log

describe("a quest deleted in the editor leaves every player's rows and log", () => {
  test("online players' rows and logs lose it without a read; an offline player's rows are read again", async () => {
    everyone();
    tables.quest_log.push(logRow("ghost", 1), logRow("ghost", 4, "completed"));
    tables.quest_objective_progress.push(count("ghost", 1, 101, 1));
    const [hero, ally] = [await login("hero"), await login("ally")];
    await questLog.rowsOf("ghost");
    const asked = queries.length;

    await questLog.removeFromEveryLog(1);

    expect(queries.slice(asked)).toEqual([
      ["DELETE FROM quest_objective_progress WHERE quest_id = ?", [1]],
      ["DELETE FROM quest_log WHERE quest_id = ?", [1]],
    ]);
    expect([...tables.quest_log, ...tables.quest_objective_progress].filter((row) => row.quest_id === 1)).toEqual([]);
    expect(hero.questlog).toEqual({ active: [expect.objectContaining({ quest_id: 4 })], completed: [] });
    expect(ally.questlog).toEqual({ active: [expect.objectContaining({ quest_id: 4, progress: { 401: 1 } })], completed: [] });
    await inStep(hero, ally);

    const before = queries.length;
    expect(await rowsOf("ghost")).toEqual({ log: [expect.objectContaining({ quest_id: 4, state: "completed" })], progress: [] });
    expect(questReads(before)).toEqual([LOG_LOAD, PROGRESS_LOAD]);
    expect(await heldRows("ghost")).toEqual(inTables("ghost"));
  });

  test("a player only watched for the deleted quest's radius is watched no longer", async () => {
    const hero = await login();
    await questLog.accept("hero", 20, NPC);
    expect(objectives.getRadiusPlayers()).toEqual(["hero"]);
    await questLog.removeFromEveryLog(20);
    expect(objectives.getRadiusPlayers()).toEqual([]);
    expect(hero.questlog.active).toEqual([]);
    await inStep(hero);
  });

  test("the editor's delete goes through it", async () => {
    everyone();
    const [hero, ally] = [await login("hero"), await login("ally")];
    const asked = queries.length;
    await editor.remove(1);
    expect(sent(/quest_id = \?$/, asked).filter((sql) => QUEST_TABLE.test(sql))).toEqual([
      "DELETE FROM quest_objective_progress WHERE quest_id = ?",
      "DELETE FROM quest_log WHERE quest_id = ?",
    ]);
    expect(hero.questlog.active.map((entry: Row) => entry.quest_id)).toEqual([4]);
    expect(ally.questlog.completed).toEqual([]);
    await inStep(hero, ally);
  });

  test("an editor delete that fails there is passed on, with everyone's rows and logs in step", async () => {
    everyone();
    const [hero, ally] = [await login("hero"), await login("ally")];
    failing = /^DELETE FROM quest_log WHERE quest_id/;
    await expect(editor.remove(1)).rejects.toThrow("connection lost");
    failing = null;
    // The quest's counts went; its place in each log did not.
    expect(hero.questlog.active.find((entry: Row) => entry.quest_id === 1)).toMatchObject({ state: "active", progress: {} });
    expect(ally.questlog.completed).toEqual([1]);
    await inStep(hero, ally);
  });

  test("a write to one player's rows that is under way is finished first", async () => {
    everyone();
    tables.quest_objective_progress[0].count = 1;
    const [hero, ally] = [await login("hero"), await login("ally")];
    const held = hold(/^UPDATE quest_objective_progress SET count/);
    const asked = queries.length;

    const crediting = objectives.credit("hero", "kill", "1", 1);
    await held.reached;
    const removing = questLog.removeFromEveryLog(1);
    await settled();
    const sentWhileHeld = sent(/WHERE quest_id = \?$/, asked);

    held.release();
    await Promise.all([crediting, removing]);
    expect(sentWhileHeld).toEqual([]);
    expect(queries.slice(asked).map(([sql]) => sql)).toEqual([
      "UPDATE quest_objective_progress SET count = ? WHERE username = ? AND quest_id = ? AND objective_id = ?",
      "DELETE FROM quest_objective_progress WHERE quest_id = ?",
      "DELETE FROM quest_log WHERE quest_id = ?",
    ]);
    expect([...tables.quest_log, ...tables.quest_objective_progress].filter((row) => row.quest_id === 1)).toEqual([]);
    await inStep(hero, ally);
  });

  test("a write to one player's rows that comes while it runs waits for it", async () => {
    everyone();
    tables.quest_log.push(logRow("hero", 10));
    const [hero, ally] = [await login("hero"), await login("ally")];
    const held = hold(/^DELETE FROM quest_objective_progress WHERE quest_id/);
    const asked = queries.length;

    const removing = questLog.removeFromEveryLog(1);
    await held.reached;
    const crediting = objectives.credit("hero", "kill", "5", 1);
    const accepting = questLog.forceAccept("ally", 11);
    await settled();
    const sentWhileHeld = queries.slice(asked).map(([sql]) => sql);

    held.release();
    await Promise.all([removing, crediting, accepting]);
    expect(sentWhileHeld).toEqual(["DELETE FROM quest_objective_progress WHERE quest_id = ?"]);
    expect(queries.slice(asked, asked + 2).map(([sql]) => sql)).toEqual([
      "DELETE FROM quest_objective_progress WHERE quest_id = ?",
      "DELETE FROM quest_log WHERE quest_id = ?",
    ]);
    expect(tables.quest_objective_progress).toContainEqual(count("hero", 10, 1001, 1));
    expect(inTables("ally").log.map((row) => row.quest_id)).toEqual([4, 11]);
    await inStep(hero, ally);
  });

  test("two deletes at once run one after the other", async () => {
    everyone();
    const [hero, ally] = [await login("hero"), await login("ally")];
    const asked = queries.length;
    await Promise.all([questLog.removeFromEveryLog(1), questLog.removeFromEveryLog(4)]);
    expect(queries.slice(asked).map(([, params]) => params[0])).toEqual([1, 1, 4, 4]);
    expect(tables.quest_log).toEqual([]);
    expect(hero.questlog).toEqual({ active: [], completed: [] });
    await inStep(hero, ally);
  });
});

// ------------------------------- what the player holds, asked of its owners

describe("what a player holds is asked of the inventory and the bags, which read it once", () => {
  const INVENTORY_LOAD = "SELECT * FROM inventory WHERE username = ?";
  const BAGS_LOAD = "SELECT * FROM bags WHERE username = ?";
  const holding = (username: string, name: string, quantity = 1): Row => ({ id: nextId++, username, item: name, quantity, equipped: 0, slot: null, bag_slot: null });

  test("accepting a collect quest counts what is already held, from the inventory's rows", async () => {
    tables.inventory.push(holding("hero", "Rat Tail", 2), holding("hero", "Bread", 5), holding("ally", "Rat Tail", 9));
    const hero = await login();
    const accepted = await questLog.accept("hero", 4, NPC);
    expect(accepted).toMatchObject({ ok: true, entry: { state: "ready", progress: { 401: 2 } } });
    await inStep(hero);

    // A second quest wanting the same item asks the rows held, not the database.
    expect(await questLog.accept("hero", 10, NPC)).toMatchObject({ ok: true, entry: { state: "active", progress: { 1002: 2 } } });
    expect(sent(/FROM inventory/)).toEqual([INVENTORY_LOAD]);
    expect(queries.find(([sql]) => sql === INVENTORY_LOAD)).toEqual([INVENTORY_LOAD, ["hero"]]);
    await inStep(hero);
  });

  test("a stack that does not reach the count is counted as far as it goes, and none held counts nothing", async () => {
    tables.inventory.push(holding("hero", "Rat Tail", 1));
    const hero = await login();
    expect(await questLog.accept("hero", 4, NPC)).toMatchObject({ ok: true, entry: { state: "active", progress: { 401: 1 } } });
    await login("ally");
    expect(await questLog.accept("ally", 4, NPC)).toMatchObject({ ok: true, entry: { state: "active", progress: {} } });
    await inStep(hero);
  });

  test("what was picked up since the inventory was read counts too", async () => {
    const hero = await login();
    await inventory.add("hero", { name: "Rat Tail", quantity: 2 } as any);
    expect(await questLog.accept("hero", 4, NPC)).toMatchObject({ ok: true, entry: { state: "ready", progress: { 401: 2 } } });
    expect(sent(/FROM inventory/)).toEqual([INVENTORY_LOAD]);
    await inStep(hero);
  });

  test("a reward that needs a slot is refused when every slot is taken, and nothing is granted", async () => {
    tables.inventory.push(...JUNK.map((name) => holding("hero", name)));
    const hero = await login();
    await questLog.accept("hero", 30, NPC);
    expect(await questLog.turnIn("hero", 30, NPC)).toMatchObject({ ok: false, code: "bag_full" });
    expect(await questLog.turnIn("hero", 30, NPC)).toMatchObject({ ok: false, code: "bag_full" });
    expect(tables.inventory.some((row) => row.item === "Lantern")).toBe(false);
    expect(hero.questlog.active[0]).toMatchObject({ quest_id: 30, state: "ready" });
    // The inventory and the bags row were each read once for the two attempts.
    expect(sent(/FROM (inventory|bags)/)).toEqual([INVENTORY_LOAD, BAGS_LOAD]);
    expect(queries.find(([sql]) => sql === BAGS_LOAD)).toEqual([BAGS_LOAD, ["hero"]]);
    await inStep(hero);
  });

  test("an equipped bag's slots make room for it", async () => {
    tables.inventory.push(...JUNK.map((name) => holding("hero", name)));
    tables.bags.push({ id: 1, username: "hero", slot_1: "Small Pouch", slot_2: null, slot_3: null, slot_4: null });
    const hero = await login();
    await questLog.accept("hero", 30, NPC);
    expect(await questLog.turnIn("hero", 30, NPC)).toMatchObject({ ok: true, items: [{ name: "Lantern", quantity: 1 }] });
    expect(tables.inventory).toContainEqual(expect.objectContaining({ username: "hero", item: "Lantern", quantity: 1 }));
    await inStep(hero);
  });

  test("a bag adds the slots its item says, and no more", async () => {
    // The pouch's four slots hold four more things: 29 are held, so the lantern is one too many.
    tables.inventory.push(...JUNK.map((name) => holding("hero", name)), ...["Bread", "Rat Tail", "Small Pouch", "Torch"].map((name) => holding("hero", name)));
    tables.bags.push({ id: 1, username: "hero", slot_1: "Small Pouch", slot_2: null, slot_3: null, slot_4: null });
    await login();
    await questLog.accept("hero", 30, NPC);
    expect(await questLog.turnIn("hero", 30, NPC)).toMatchObject({ ok: false, code: "bag_full" });
  });

  test("a reward that stacks onto what is held needs no slot", async () => {
    tables.inventory.push(...JUNK.slice(0, 24).map((name) => holding("hero", name)), holding("hero", "Lantern"));
    const hero = await login();
    await questLog.accept("hero", 30, NPC);
    expect((await questLog.turnIn("hero", 30, NPC)).ok).toBe(true);
    expect(tables.inventory.find((row) => row.item === "Lantern")!.quantity).toBe(2);
    await inStep(hero);
  });
});
