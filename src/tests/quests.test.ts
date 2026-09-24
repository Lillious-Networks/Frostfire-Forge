import { describe, expect, mock, test } from "bun:test";

const questRows = [
  {
    id: 1, name: "Rats in the Cellar", zone: "overworld",
    offer_text: "Offer", description: "Desc", progress_text: "Prog", completion_text: "Done",
    required_level: 1, quest_level: 1, xp_reward: 50, copper_reward: 100,
    repeatable: "none", next_quest_id: 2, sort_order: 0,
  },
  {
    id: 2, name: "The Cellar Aftermath", zone: "overworld",
    offer_text: "Offer", description: "Desc", progress_text: "Prog", completion_text: "Done",
    required_level: 1, quest_level: 2, xp_reward: 100, copper_reward: 200,
    repeatable: "none", next_quest_id: null, sort_order: 1,
  },
];

const objectiveRows = [
  { id: 101, quest_id: 1, sort_order: 0, type: "kill", target: "1", required_count: 3, target_x: null, target_y: null, target_radius: null, description: "Rats slain" },
  { id: 102, quest_id: 1, sort_order: 1, type: "collect", target: "Rat Tail", required_count: 2, target_x: null, target_y: null, target_radius: null, description: null },
  { id: 201, quest_id: 2, sort_order: 0, type: "talk", target: "2", required_count: 1, target_x: null, target_y: null, target_radius: null, description: null },
];

const rewardRows = [
  { id: 301, quest_id: 1, item_name: "Bread", quantity: 1, is_choice: 0, sort_order: 0 },
  { id: 302, quest_id: 2, item_name: "Bread", quantity: 1, is_choice: 1, sort_order: 0 },
  { id: 303, quest_id: 2, item_name: "Apple", quantity: 1, is_choice: 1, sort_order: 1 },
];

const prereqRows = [{ quest_id: 2, required_quest_id: 1 }];
const npcLinks = [
  { npc_id: 1, quest_id: 1, role: "giver" },
  { npc_id: 1, quest_id: 1, role: "ender" },
  { npc_id: 2, quest_id: 2, role: "giver" },
];

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, _params: any[] = []) => {
    if (sql.includes("FROM quests")) return questRows;
    if (sql.includes("FROM quest_objectives")) return objectiveRows;
    if (sql.includes("FROM quest_rewards")) return rewardRows;
    if (sql.includes("FROM quest_prerequisites")) return prereqRows;
    if (sql.includes("FROM npc_quests")) return npcLinks;
    return [];
  },
}));

const cache = new Map<string, any>();
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => cache.get(key) ?? null,
    set: async (key: string, value: any) => cache.set(key, value),
    add: async (key: string, value: any) => cache.set(key, value),
  },
}));

const defs = await import("../systems/quests/definitions");

describe("quest definitions", () => {
  test("list hydrates objectives, rewards and prerequisites", async () => {
    const quests = await defs.list();
    expect(quests).toHaveLength(2);
    const first = quests.find((q) => q.id === 1)!;
    expect(first.objectives).toHaveLength(2);
    expect(first.objectives[0]!.type).toBe("kill");
    expect(first.rewards).toHaveLength(1);
    expect(first.rewards[0]!.item_name).toBe("Bread");
    expect(first.rewards[0]!.is_choice).toBe(false);
    expect(first.prerequisites).toEqual([]);
    const second = quests.find((q) => q.id === 2)!;
    expect(second.prerequisites).toEqual([1]);
    expect(second.rewards.filter((r) => r.is_choice)).toHaveLength(2);
    expect(first.next_quest_id).toBe(2);
  });

  test("find reads synchronously from the cache", async () => {
    await defs.list();
    expect(defs.find(1)?.name).toBe("Rats in the Cellar");
    expect(defs.find(999)).toBeUndefined();
  });

  test("indexes map every objective type and npc role", async () => {
    await defs.list();
    const idx = defs.indexes();
    expect(idx.byKillTarget.get("1")).toEqual([1]);
    expect(idx.byCollectTarget.get("rat tail")).toEqual([1]);
    expect(idx.byTalkTarget.get("2")).toEqual([2]);
    expect(idx.byGiverNpc.get(1)).toEqual([1]);
    expect(idx.byEnderNpc.get(1)).toEqual([1]);
    expect(idx.byGiverNpc.get(2)).toEqual([2]);
    expect(defs.isGiver(1, 1)).toBe(true);
    expect(defs.isEnder(1, 1)).toBe(true);
    expect(defs.isEnder(2, 2)).toBe(false);
  });

  test("reload rebuilds the cache and indexes", async () => {
    await defs.reload();
    expect(defs.getCachedQuestsSync()).toHaveLength(2);
    expect(defs.indexes().byKillTarget.get("1")).toEqual([1]);
  });
});
