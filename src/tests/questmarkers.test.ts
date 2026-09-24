import { describe, expect, mock, test } from "bun:test";

const base: Quest = {
  id: 1, name: "Rats", zone: null, offer_text: "", description: "", progress_text: "", completion_text: "",
  required_level: 1, quest_level: 1, xp_reward: 0, copper_reward: 0,
  repeatable: "none", next_quest_id: null, sort_order: 0,
  objectives: [
    { id: 101, quest_id: 1, sort_order: 0, type: "kill", target: "1", required_count: 3, target_x: null, target_y: null, target_radius: null, description: null },
  ],
  rewards: [], prerequisites: [],
};

const gated: Quest = {
  ...base, id: 2, name: "Gated", required_level: 50,
  objectives: [
    { id: 201, quest_id: 2, sort_order: 0, type: "kill", target: "2", required_count: 1, target_x: null, target_y: null, target_radius: null, description: null },
  ],
};

const allQuests = [base, gated];
// NPC 1 gives/ends quest 1; NPC 2 gives/ends quest 2; NPC 3 gives both.
const npcLinks = [
  { npc_id: 1, quest_id: 1, role: "giver" },
  { npc_id: 1, quest_id: 1, role: "ender" },
  { npc_id: 2, quest_id: 2, role: "giver" },
  { npc_id: 2, quest_id: 2, role: "ender" },
  { npc_id: 3, quest_id: 1, role: "giver" },
  { npc_id: 3, quest_id: 1, role: "ender" },
  { npc_id: 3, quest_id: 2, role: "giver" },
  { npc_id: 3, quest_id: 2, role: "ender" },
];

mock.module("../controllers/sqldatabase", () => ({
  default: async () => [],
}));

const npcBase = {
  last_updated: null, hidden: false, script: null, dialog: null, particles: null,
  quest_giver: true, sprite_type: "animated", sprite_body: null, sprite_head: null,
  sprite_helmet: null, sprite_shoulderguards: null, sprite_neck: null, sprite_hands: null,
  sprite_chest: null, sprite_feet: null, sprite_legs: null, sprite_weapon: null,
} as const;
const npcs: Npc[] = [
  { ...npcBase, id: 1, map: "overworld", name: "Innkeeper", position: { x: 0, y: 0, direction: "down" } },
  { ...npcBase, id: 2, map: "overworld", name: "Guard", position: { x: 10, y: 10, direction: "down" } },
  { ...npcBase, id: 3, map: "overworld", name: "Both", position: { x: 20, y: 20, direction: "down" } },
  { ...npcBase, id: 4, map: "dungeon", name: "Elsewhere", position: { x: 0, y: 0, direction: "down" } },
];

mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => (key === "npcs" ? npcs : null),
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
const markers = await import("../systems/quests/markers");

function seed(log: QuestLogData) {
  players.clear();
  players.set("conn1", { id: "conn1", username: "hero", stats: { level: 5 }, questlog: log });
  defs.setCachedQuestsSync(allQuests);
  defs.setIndexesForTests(defs.buildIndexes(allQuests, npcLinks));
}

describe("quest markers", () => {
  test("available shows gold ! and locked quests show no marker", async () => {
    seed({ active: [], completed: [] });
    const result = await markers.markersFor("hero", "overworld");
    expect(result[1]).toBe("available");
    expect(result[2]).toBeUndefined();
  });

  test("in-progress shows grey ? and ready shows gold ?", async () => {
    seed({
      active: [{ quest_id: 1, state: "active", accepted_at: 1, completed_at: 0, times_completed: 0, progress: { 101: 1 } }],
      completed: [],
    });
    expect((await markers.markersFor("hero", "overworld"))[1]).toBe("in_progress");
    seed({
      active: [{ quest_id: 1, state: "ready", accepted_at: 1, completed_at: 0, times_completed: 0, progress: { 101: 3 } }],
      completed: [],
    });
    expect((await markers.markersFor("hero", "overworld"))[1]).toBe("ready");
  });

  test("precedence: ready beats available on a shared npc", async () => {
    // NPC 3 has quest 1 (ready to turn in) and quest 2 (locked: no marker).
    seed({
      active: [{ quest_id: 1, state: "ready", accepted_at: 1, completed_at: 0, times_completed: 0, progress: { 101: 3 } }],
      completed: [],
    });
    const result = await markers.markersFor("hero", "overworld");
    expect(result[3]).toBe("ready");
    // Quest 1 available + quest 2 locked -> available wins.
    seed({ active: [], completed: [] });
    expect((await markers.markersFor("hero", "overworld"))[3]).toBe("available");
  });

  test("only npcs on the player's map are reported", async () => {
    seed({ active: [], completed: [] });
    const result = await markers.markersFor("hero", "dungeon");
    expect(result[1]).toBeUndefined();
    expect(result[4]).toBeUndefined();
  });

  test("sync variant matches the async computation", async () => {
    seed({ active: [], completed: [] });
    const syncResult = markers.markersForSync("hero", [{ id: 1 }, { id: 2 }]);
    expect(syncResult[1]).toBe("available");
    expect(syncResult[2]).toBeUndefined();
  });
});
