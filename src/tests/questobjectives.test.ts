import { describe, expect, mock, test } from "bun:test";

const killQuest: Quest = {
  id: 1, name: "Rats", zone: null, offer_text: "", description: "", progress_text: "", completion_text: "",
  required_level: 1, quest_level: 1, xp_reward: 0, copper_reward: 0,
  repeatable: "none", next_quest_id: null, sort_order: 0,
  objectives: [
    { id: 101, quest_id: 1, sort_order: 0, type: "kill", target: "1", required_count: 3, target_x: null, target_y: null, target_radius: null, description: null },
  ],
  rewards: [], prerequisites: [],
};

const multiQuest: Quest = {
  ...killQuest, id: 2, name: "Mixed",
  objectives: [
    { id: 201, quest_id: 2, sort_order: 0, type: "kill", target: "7", required_count: 2, target_x: null, target_y: null, target_radius: null, description: null },
    { id: 202, quest_id: 2, sort_order: 1, type: "collect", target: "Gem", required_count: 2, target_x: null, target_y: null, target_radius: null, description: null },
    { id: 203, quest_id: 2, sort_order: 2, type: "talk", target: "9", required_count: 1, target_x: null, target_y: null, target_radius: null, description: null },
    { id: 204, quest_id: 2, sort_order: 3, type: "explore", target: "overworld", required_count: 1, target_x: null, target_y: null, target_radius: null, description: null },
  ],
};

const radiusQuest: Quest = {
  ...killQuest, id: 3, name: "Radius",
  objectives: [
    { id: 301, quest_id: 3, sort_order: 0, type: "explore", target: "overworld", required_count: 1, target_x: 100, target_y: 100, target_radius: 60, description: null },
  ],
};

const allQuests = [killQuest, multiQuest, radiusQuest];
const npcLinks: Array<{ npc_id: number; quest_id: number; role: string }> = [];

let progressRows: Array<{ username: string; quest_id: number; objective_id: number; count: number }>;
let writeCount = 0;

function resetDb() {
  progressRows = [];
  writeCount = 0;
}
resetDb();

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, params: any[] = []) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM quest_objective_progress WHERE username = ? AND quest_id = ? AND objective_id = ?")) {
      return progressRows.filter((r) => r.username === params[0] && r.quest_id === params[1] && r.objective_id === params[2]);
    }
    if (sql.includes("UPDATE quest_objective_progress SET count")) {
      writeCount++;
      const [count, uname, qid, oid] = params;
      const row = progressRows.find((r) => r.username === uname && r.quest_id === qid && r.objective_id === oid);
      if (row) row.count = count;
      return { affectedRows: 1 };
    }
    if (sql.includes("INSERT INTO quest_objective_progress")) {
      writeCount++;
      const [username, quest_id, objective_id, count] = params;
      progressRows.push({ username, quest_id, objective_id, count });
      return { affectedRows: 1 };
    }
    if (sql.includes("DELETE FROM quest_objective_progress")) {
      const [uname, qid] = params;
      progressRows = progressRows.filter((r) => !(r.username === uname && r.quest_id === qid));
      return { affectedRows: 1 };
    }
    if (sql.includes("UPDATE quest_log SET state")) {
      return { affectedRows: 1 };
    }
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
const objectives = await import("../systems/quests/objectives");
const questLog = await import("../systems/quests/log");

function seedActive(questIds: number[]) {
  players.clear();
  objectives.clearRadiusPlayersForTests();
  players.set("conn1", {
    id: "conn1",
    username: "hero",
    stats: { level: 5 },
    location: { map: "overworld", position: { x: 0, y: 0 } },
    questlog: {
      active: questIds.map((qid) => ({
        quest_id: qid, state: "active", accepted_at: Date.now(), completed_at: 0, times_completed: 0, progress: {},
      })),
      completed: [],
    } as QuestLogData,
  });
}

describe("objective credit funnel", () => {
  test("kill credit clamps at the cap and flips the quest to ready", async () => {
    resetDb();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    seedActive([1]);
    let updates = await objectives.credit("hero", "kill", "1", 1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.count).toBe(1);
    expect(updates[0]!.questReady).toBe(false);
    updates = await objectives.credit("hero", "kill", "1", 5);
    expect(updates[0]!.count).toBe(3);
    expect(updates[0]!.questReady).toBe(true);
    expect(objectives.isComplete("hero", 1)).toBe(true);
  });

  test("killing past the cap performs no DB write", async () => {
    resetDb();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    seedActive([1]);
    await objectives.credit("hero", "kill", "1", 3);
    const writesAfterCap = writeCount;
    const updates = await objectives.credit("hero", "kill", "1", 1);
    expect(updates).toHaveLength(0);
    expect(writeCount).toBe(writesAfterCap);
  });

  test("credit ignores quests the player has not accepted", async () => {
    resetDb();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    seedActive([]);
    const updates = await objectives.credit("hero", "kill", "1", 1);
    expect(updates).toHaveLength(0);
    expect(writeCount).toBe(0);
  });

  test("talk and map explore credit through the same funnel", async () => {
    resetDb();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    seedActive([2]);
    const talk = await objectives.credit("hero", "talk", "9", 1);
    expect(talk).toHaveLength(1);
    expect(talk[0]!.count).toBe(1);
    const explore = await objectives.sync("hero", "explore", "overworld", 1);
    expect(explore.some((u) => u.objectiveId === 204)).toBe(true);
  });

  test("collect sync walks progress back down and reverts ready", async () => {
    resetDb();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    seedActive([2]);
    await objectives.sync("hero", "kill", "7", 2);
    await objectives.sync("hero", "collect", "Gem", 2);
    await objectives.credit("hero", "talk", "9", 1);
    await objectives.sync("hero", "explore", "overworld", 1);
    const cached = questLog.getCachedLog("hero")!;
    expect(cached.active.find((e) => e.quest_id === 2)?.state).toBe("ready");
    // Drop a gem: progress decreases and ready reverts to active.
    const down = await objectives.sync("hero", "collect", "Gem", 1);
    expect(down).toHaveLength(1);
    expect(down[0]!.count).toBe(1);
    expect(questLog.getCachedLog("hero")!.active.find((e) => e.quest_id === 2)?.state).toBe("active");
    expect(objectives.isComplete("hero", 2)).toBe(false);
  });

  test("radius explore credits only inside the radius", async () => {
    resetDb();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    seedActive([3]);
    const far = await objectives.checkExplorePosition("hero", "overworld", 500, 500);
    expect(far).toHaveLength(0);
    const near = await objectives.checkExplorePosition("hero", "overworld", 120, 110);
    expect(near).toHaveLength(1);
    expect(near[0]!.questReady).toBe(true);
  });

  test("clear wipes progress for abandon and re-accept", async () => {
    resetDb();
    defs.setCachedQuestsSync(allQuests);
    defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
    seedActive([1]);
    await objectives.credit("hero", "kill", "1", 2);
    await objectives.clear("hero", 1);
    expect(questLog.getCachedLog("hero")!.active.find((e) => e.quest_id === 1)?.progress).toEqual({});
    expect(progressRows).toHaveLength(0);
  });
});
