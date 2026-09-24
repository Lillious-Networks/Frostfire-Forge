import { describe, expect, mock, test } from "bun:test";

const repeatable: Quest = {
  id: 10, name: "Daily Grind", zone: null, offer_text: "", description: "", progress_text: "", completion_text: "",
  required_level: 1, quest_level: 1, xp_reward: 10, copper_reward: 0,
  repeatable: "repeatable", next_quest_id: null, sort_order: 0,
  objectives: [
    { id: 1001, quest_id: 10, sort_order: 0, type: "kill", target: "5", required_count: 2, target_x: null, target_y: null, target_radius: null, description: null },
  ],
  rewards: [], prerequisites: [],
};

const daily: Quest = {
  ...repeatable, id: 11, name: "Daily Bread", repeatable: "daily",
  objectives: [
    { id: 1101, quest_id: 11, sort_order: 0, type: "kill", target: "5", required_count: 1, target_x: null, target_y: null, target_radius: null, description: null },
  ],
};

const allQuests = [repeatable, daily];
const npcLinks = [
  { npc_id: 1, quest_id: 10, role: "giver" },
  { npc_id: 1, quest_id: 10, role: "ender" },
  { npc_id: 1, quest_id: 11, role: "giver" },
  { npc_id: 1, quest_id: 11, role: "ender" },
];

let logRows: Array<{ username: string; quest_id: number; state: string; accepted_at: number; completed_at: number; times_completed: number }>;
let progressRows: Array<{ username: string; quest_id: number; objective_id: number; count: number }>;

function resetDb() {
  logRows = [];
  progressRows = [];
}
resetDb();

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, params: any[] = []) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM quest_log WHERE username = ? AND quest_id = ?")) {
      return logRows.filter((r) => r.username === params[0] && r.quest_id === params[1]);
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM quest_log WHERE username = ?")) {
      return logRows.filter((r) => r.username === params[0]);
    }
    if (sql.includes("INSERT INTO quest_log")) {
      const [username, quest_id, state, accepted_at, completed_at, times_completed] = params;
      logRows.push({ username, quest_id, state, accepted_at, completed_at, times_completed });
      return { affectedRows: 1 };
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
    if (sql.includes("UPDATE quest_log SET state = 'ready'")) {
      const [uname, qid] = params;
      const row = logRows.find((r) => r.username === uname && r.quest_id === qid);
      if (row) row.state = "ready";
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
    if (sql.includes("SELECT level FROM stats")) return [{ level: 5 }];
    if (sql.includes("SELECT quantity FROM inventory")) return [];
    if (sql.includes("SELECT * FROM bags")) return [];
    return [];
  },
}));

mock.module("../services/assetCache", () => ({
  default: {
    get: async (_key: string) => null,
    set: async (_key: string, _value: any) => {},
    add: async (_key: string, _value: any) => {},
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

function seed() {
  players.clear();
  players.set("conn1", { id: "conn1", username: "hero", stats: { level: 5 }, questlog: null as any });
  defs.setCachedQuestsSync(allQuests);
  defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
}

describe("daily reset boundary", () => {
  test("boundary sits at 03:00 UTC and the previous day applies before it", () => {
    // 2026-09-19T04:00:00Z -> boundary is 03:00 the same day.
    const after = Date.UTC(2026, 8, 19, 4, 0, 0);
    expect(questLog.lastResetBoundary(after)).toBe(Date.UTC(2026, 8, 19, 3, 0, 0));
    // 2026-09-19T02:00:00Z -> boundary is 03:00 the previous day.
    const before = Date.UTC(2026, 8, 19, 2, 0, 0);
    expect(questLog.lastResetBoundary(before)).toBe(Date.UTC(2026, 8, 18, 3, 0, 0));
  });
});

describe("repeatable and daily re-accept", () => {
  test("repeatable re-accept clears progress and keeps history", async () => {
    resetDb();
    seed();
    await questLog.load("hero");
    const first = await questLog.accept("hero", 10, 1);
    expect(first.ok).toBe(true);
    // Complete it manually, then re-accept.
    const row = logRows.find((r) => r.quest_id === 10)!;
    row.state = "completed";
    row.completed_at = Date.now();
    row.times_completed = 1;
    progressRows.push({ username: "hero", quest_id: 10, objective_id: 1001, count: 2 });
    players.set("conn1", { id: "conn1", username: "hero", stats: { level: 5 }, questlog: null as any });
    await questLog.load("hero");
    expect(await questLog.eligibility("hero", 10)).toBe("available");
    const second = await questLog.accept("hero", 10, 1);
    expect(second.ok).toBe(true);
    expect(second.entry?.progress).toEqual({});
    expect(second.entry?.times_completed).toBe(1);
    expect(progressRows.filter((r) => r.quest_id === 10)).toHaveLength(0);
  });

  test("daily is blocked before the reset and open after it", async () => {
    resetDb();
    seed();
    await questLog.load("hero");
    const now = Date.now();
    const boundary = questLog.lastResetBoundary(now);
    // Completed after the most recent reset: not yet available.
    logRows.push({ username: "hero", quest_id: 11, state: "completed", accepted_at: now - 1000, completed_at: boundary + 1000, times_completed: 1 });
    players.set("conn1", { id: "conn1", username: "hero", stats: { level: 5 }, questlog: null as any });
    await questLog.load("hero");
    expect(await questLog.eligibility("hero", 11)).toBe("daily_not_reset");
    // Completed before the reset: available again.
    logRows.find((r) => r.quest_id === 11)!.completed_at = boundary - 1000;
    players.set("conn1", { id: "conn1", username: "hero", stats: { level: 5 }, questlog: null as any });
    await questLog.load("hero");
    expect(await questLog.eligibility("hero", 11)).toBe("available");
  });
});
