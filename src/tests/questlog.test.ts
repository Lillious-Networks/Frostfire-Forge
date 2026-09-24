import { describe, expect, mock, test } from "bun:test";

const makeQuest = (over: Partial<Quest> = {}): Quest => ({
  id: 1,
  name: "Rats in the Cellar",
  zone: "overworld",
  offer_text: "Offer",
  description: "Desc",
  progress_text: "Prog",
  completion_text: "Done",
  required_level: 1,
  quest_level: 1,
  xp_reward: 50,
  copper_reward: 100,
  repeatable: "none",
  next_quest_id: 2,
  sort_order: 0,
  objectives: [
    { id: 101, quest_id: 1, sort_order: 0, type: "kill", target: "1", required_count: 3, target_x: null, target_y: null, target_radius: null, description: "Rats slain" },
  ],
  rewards: [],
  prerequisites: [],
  ...over,
});

const quest1 = makeQuest();
const quest2 = makeQuest({
  id: 2, name: "Aftermath", quest_level: 2, next_quest_id: null,
  objectives: [
    { id: 201, quest_id: 2, sort_order: 0, type: "talk", target: "2", required_count: 1, target_x: null, target_y: null, target_radius: null, description: null },
  ],
  prerequisites: [1],
});
const highLevelQuest = makeQuest({ id: 3, name: "Dragon", required_level: 50, objectives: [], prerequisites: [] });
const collectQuest = makeQuest({
  id: 4, name: "Tails", objectives: [
    { id: 401, quest_id: 4, sort_order: 0, type: "collect", target: "Rat Tail", required_count: 2, target_x: null, target_y: null, target_radius: null, description: null },
  ],
  prerequisites: [],
});
const allQuests = [quest1, quest2, highLevelQuest, collectQuest];
const npcLinks = [
  { npc_id: 1, quest_id: 1, role: "giver" },
  { npc_id: 1, quest_id: 1, role: "ender" },
  { npc_id: 2, quest_id: 2, role: "giver" },
  { npc_id: 2, quest_id: 2, role: "ender" },
  { npc_id: 1, quest_id: 3, role: "giver" },
  { npc_id: 1, quest_id: 4, role: "giver" },
  { npc_id: 1, quest_id: 4, role: "ender" },
];

// In-memory tables.
let logRows: Array<{ username: string; quest_id: number; state: string; accepted_at: number; completed_at: number; times_completed: number }>;
let progressRows: Array<{ username: string; quest_id: number; objective_id: number; count: number }>;
let inventoryRows: Array<{ username: string; item: string; quantity: number }>;
const queries: string[] = [];

function resetDb() {
  logRows = [];
  progressRows = [];
  inventoryRows = [];
  queries.length = 0;
}
resetDb();

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, params: any[] = []) => {
    queries.push(sql);
    if (sql.startsWith("SELECT") && sql.includes("FROM quest_log WHERE username = ? AND quest_id = ?")) {
      return logRows.filter((r) => r.username === params[0] && r.quest_id === params[1]);
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM quest_log WHERE username = ?")) {
      return logRows.filter((r) => r.username === params[0]);
    }
    if (sql.includes("UPDATE quest_log SET state = ?")) {
      const [state, accepted, uname, qid] = params;
      const row = logRows.find((r) => r.username === uname && r.quest_id === qid);
      if (row) {
        row.state = state;
        row.accepted_at = accepted;
      }
      return { affectedRows: 1 };
    }
    if (sql.includes("UPDATE quest_log SET state = 'ready'")) {
      const [uname, qid] = params;
      const row = logRows.find((r) => r.username === uname && r.quest_id === qid);
      if (row) row.state = "ready";
      return { affectedRows: 1 };
    }
    if (sql.includes("UPDATE quest_log SET state = 'active'")) {
      const [uname, qid] = params;
      const row = logRows.find((r) => r.username === uname && r.quest_id === qid);
      if (row) row.state = "active";
      return { affectedRows: 1 };
    }
    if (sql.includes("UPDATE quest_log SET state = 'completed'")) {
      const [completedAt, times, uname, qid] = params;
      const row = logRows.find((r) => r.username === uname && r.quest_id === qid);
      if (row) {
        row.state = "completed";
        row.completed_at = completedAt;
        row.times_completed = times;
      }
      return { affectedRows: 1 };
    }
    if (sql.includes("INSERT INTO quest_log")) {
      const [username, quest_id, state, accepted_at, completed_at, times_completed] = params;
      logRows.push({ username, quest_id, state, accepted_at, completed_at, times_completed });
      return { affectedRows: 1 };
    }
    if (sql.includes("DELETE FROM quest_log")) {
      const [uname, qid] = params;
      logRows = logRows.filter((r) => !(r.username === uname && r.quest_id === qid && r.state !== "completed"));
      return { affectedRows: 1 };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM quest_objective_progress WHERE username = ? AND quest_id = ? AND objective_id = ?")) {
      return progressRows.filter((r) => r.username === params[0] && r.quest_id === params[1] && r.objective_id === params[2]);
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM quest_objective_progress WHERE username = ?")) {
      return progressRows.filter((r) => r.username === params[0]);
    }
    if (sql.includes("UPDATE quest_objective_progress SET count")) {
      const [count, uname, qid, oid] = params;
      const row = progressRows.find((r) => r.username === uname && r.quest_id === qid && r.objective_id === oid);
      if (row) row.count = count;
      return { affectedRows: 1 };
    }
    if (sql.includes("INSERT INTO quest_objective_progress")) {
      const [username, quest_id, objective_id, count] = params;
      progressRows.push({ username, quest_id, objective_id, count });
      return { affectedRows: 1 };
    }
    if (sql.includes("DELETE FROM quest_objective_progress")) {
      const [uname, qid] = params;
      progressRows = progressRows.filter((r) => !(r.username === uname && r.quest_id === qid));
      return { affectedRows: 1 };
    }
    if (sql.includes("SELECT level FROM stats")) {
      return [{ level: 5 }];
    }
    if (sql.includes("SELECT quantity FROM inventory")) {
      return inventoryRows
        .filter((r) => r.username === params[0] && r.item === params[1])
        .map((r) => ({ quantity: r.quantity }));
    }
    if (sql.includes("SELECT item FROM inventory")) {
      return inventoryRows.filter((r) => r.username === params[0]).map((r) => ({ item: r.item }));
    }
    if (sql.includes("SELECT * FROM inventory WHERE item")) {
      return inventoryRows
        .filter((r) => r.item === params[0] && r.username === params[1])
        .map((r) => ({ item: r.item, quantity: r.quantity }));
    }
    if (sql.includes("SELECT * FROM bags")) {
      return [];
    }
    if (sql.includes("SELECT copper, silver, gold FROM currency")) {
      return [{ copper: 0, silver: 0, gold: 0 }];
    }
    if (sql.includes("INSERT INTO currency") || sql.includes("UPDATE stats") || sql.includes("INSERT IGNORE INTO inventory") || sql.includes("UPDATE inventory")) {
      return { affectedRows: 1 };
    }
    return [];
  },
}));

const assetData = new Map<string, any>([
  ["items", [{ name: "Bread" }, { name: "Rat Tail" }]],
]);
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => assetData.get(key) ?? null,
    set: async (key: string, value: any) => assetData.set(key, value),
    add: async (key: string, value: any) => assetData.set(key, value),
  },
}));

const players = new Map<string, any>();
mock.module("../services/playermanager", () => ({
  default: {
    list: () => Object.fromEntries(players),
    get: (id: string) => players.get(id),
    set: (id: string, value: any) => players.set(id, value),
    add: (id: string, value: any) => players.set(id, value),
    remove: (id: string) => players.delete(id),
    clear: () => players.clear(),
    addNested: (id: string, nestedKey: string, value: any) => players.set(id, { ...(players.get(id) || {}), [nestedKey]: value }),
    setNested: (id: string, nestedKey: string, value: any) => players.set(id, { ...(players.get(id) || {}), [nestedKey]: value }),
  },
}));

const defs = await import("../systems/quests/definitions");
const questLog = await import("../systems/quests/log");

function seedPlayer() {
  players.clear();
  players.set("conn1", { id: "conn1", username: "hero", stats: { level: 5 }, questlog: null as any });
}

describe("quest eligibility matrix", () => {
  test("unknown quest, available, level gate and prerequisite gate", async () => {
    resetDb();
    seedPlayer();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    await questLog.load("hero");
    expect(await questLog.eligibility("hero", 999)).toBe("unknown_quest");
    expect(await questLog.eligibility("hero", 1)).toBe("available");
    expect(await questLog.eligibility("hero", 3)).toBe("level_too_low");
    expect(await questLog.eligibility("hero", 2)).toBe("missing_prerequisite");
  });

  test("log cap blocks new accepts", async () => {
    resetDb();
    seedPlayer();
    const many = Array.from({ length: 25 }, (_u, i) =>
      makeQuest({ id: 100 + i, name: `Filler ${i}`, objectives: [], prerequisites: [] })
    );
    defs.setCachedQuestsSync([...allQuests, ...many]);
    defs.setIndexesForTests(defs.buildIndexes([...allQuests, ...many], npcLinks));
    const now = Date.now();
    many.forEach((q) => {
      logRows.push({ username: "hero", quest_id: q.id, state: "active", accepted_at: now, completed_at: 0, times_completed: 0 });
    });
    await questLog.load("hero");
    expect(await questLog.eligibility("hero", 1)).toBe("log_full");
  });
});

describe("accept and abandon", () => {
  test("accept inserts the row and survives a relog", async () => {
    resetDb();
    seedPlayer();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    await questLog.load("hero");
    const result = await questLog.accept("hero", 1, 1);
    expect(result.ok).toBe(true);
    expect(result.entry?.quest_id).toBe(1);
    expect(logRows.some((r) => r.quest_id === 1 && r.state === "active")).toBe(true);
    // Relog: drop the cache entry and reload from the DB.
    players.set("conn1", { id: "conn1", username: "hero", stats: { level: 5 }, questlog: null as any });
    const reloaded = await questLog.load("hero");
    expect(reloaded.active.map((e) => e.quest_id)).toContain(1);
  });

  test("accept rejects when the npc is not a giver", async () => {
    resetDb();
    seedPlayer();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    await questLog.load("hero");
    const result = await questLog.accept("hero", 1, 999);
    expect(result.ok).toBe(false);
  });

  test("abandon deletes the row and its progress", async () => {
    resetDb();
    seedPlayer();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    await questLog.load("hero");
    await questLog.accept("hero", 1, 1);
    progressRows.push({ username: "hero", quest_id: 1, objective_id: 101, count: 2 });
    await questLog.abandon("hero", 1);
    expect(logRows.some((r) => r.quest_id === 1)).toBe(false);
    expect(progressRows.some((r) => r.quest_id === 1)).toBe(false);
    expect(await questLog.eligibility("hero", 1)).toBe("available");
  });

  test("accepting a collect quest while holding the items credits immediately", async () => {
    resetDb();
    seedPlayer();
    inventoryRows.push({ username: "hero", item: "Rat Tail", quantity: 2 });
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    await questLog.load("hero");
    const result = await questLog.accept("hero", 4, 1);
    expect(result.ok).toBe(true);
    expect(result.entry?.progress[401]).toBe(2);
    expect(result.entry?.state).toBe("ready");
  });

  test("offersFor lists the npc quests relevant to the player", async () => {
    resetDb();
    seedPlayer();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    await questLog.load("hero");
    const offers = await questLog.offersFor("hero", 1);
    const ids = offers.map((o) => o.questId);
    expect(ids).toContain(1);
    expect(ids).toContain(4);
    expect(offers.find((o) => o.questId === 1)?.action).toBe("offer");
  });
});
