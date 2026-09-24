import { describe, expect, mock, test } from "bun:test";

let questTable: Array<any>;
let objectiveTable: Array<any>;
let rewardTable: Array<any>;
let prereqTable: Array<{ quest_id: number; required_quest_id: number }>;
let npcLinkTable: Array<{ npc_id: number; quest_id: number; role: string }>;
let nextId: number;

function resetDb() {
  questTable = [
    { id: 1, name: "Existing Quest", zone: null, offer_text: "", description: "", progress_text: "", completion_text: "", required_level: 1, quest_level: 1, xp_reward: 0, copper_reward: 0, repeatable: "none", next_quest_id: null, sort_order: 0 },
    { id: 2, name: "Second Quest", zone: null, offer_text: "", description: "", progress_text: "", completion_text: "", required_level: 1, quest_level: 1, xp_reward: 0, copper_reward: 0, repeatable: "none", next_quest_id: null, sort_order: 1 },
  ];
  objectiveTable = [];
  rewardTable = [];
  prereqTable = [{ quest_id: 2, required_quest_id: 1 }];
  npcLinkTable = [];
  nextId = 100;
}
resetDb();

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, params: any[] = []) => {
    if (sql.includes("UPDATE quests SET")) {
      const row = questTable.find((q) => q.id === params[params.length - 1]);
      if (row) Object.assign(row, { name: params[0] });
      return { affectedRows: 1 };
    }
    if (sql.includes("INSERT INTO quests")) {
      const id = nextId++;
      questTable.push({ id, name: params[0] });
      return { lastInsertRowid: id, insertId: id };
    }
    if (sql.includes("SELECT id FROM quests WHERE name")) {
      return questTable.filter((q) => q.name === params[0]).map((q) => ({ id: q.id }));
    }
    if (sql.includes("FROM quests ORDER BY") || sql === "SELECT * FROM quests") {
      return questTable;
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM quest_objectives")) return objectiveTable;
    if (sql.startsWith("SELECT") && sql.includes("FROM quest_rewards")) return rewardTable;
    if (sql.startsWith("SELECT") && sql.includes("FROM quest_prerequisites")) return prereqTable;
    if (sql.startsWith("SELECT") && sql.includes("FROM npc_quests")) return npcLinkTable;
    if (sql.startsWith("DELETE FROM quest_objectives")) {
      objectiveTable = objectiveTable.filter((o) => o.quest_id !== params[0]);
      return { affectedRows: 1 };
    }
    if (sql.includes("INSERT INTO quest_objectives")) {
      objectiveTable.push({ id: nextId++, quest_id: params[0] });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("DELETE FROM quest_rewards")) {
      rewardTable = rewardTable.filter((r) => r.quest_id !== params[0]);
      return { affectedRows: 1 };
    }
    if (sql.includes("INSERT INTO quest_rewards")) {
      rewardTable.push({ id: nextId++, quest_id: params[0] });
      return { affectedRows: 1 };
    }
    if (sql.includes("DELETE FROM quest_prerequisites")) {
      prereqTable = prereqTable.filter((r) => r.quest_id !== params[0]);
      return { affectedRows: 1 };
    }
    if (sql.includes("INSERT INTO quest_prerequisites")) {
      prereqTable.push({ quest_id: params[0], required_quest_id: params[1] });
      return { affectedRows: 1 };
    }
    if (sql.includes("DELETE FROM npc_quests")) {
      if (sql.includes("quest_id = ? AND `role`") || sql.includes("quest_id = ? AND role")) {
        npcLinkTable = npcLinkTable.filter((r) => !(r.quest_id === params[0] && r.role === (sql.includes("giver") ? "giver" : "ender")));
      } else if (sql.includes("npc_id = ?")) {
        npcLinkTable = npcLinkTable.filter((r) => r.npc_id !== params[0]);
      } else {
        npcLinkTable = npcLinkTable.filter((r) => r.quest_id !== params[0]);
      }
      return { affectedRows: 1 };
    }
    if (sql.includes("INSERT INTO npc_quests")) {
      // The role is a literal in the SQL, not a bound parameter.
      npcLinkTable.push({ npc_id: params[0], quest_id: params[1], role: params[2] ?? (sql.includes("'giver'") ? "giver" : "ender") });
      return { affectedRows: 1 };
    }
    if (sql.includes("DELETE FROM quest_objective_progress") || sql.includes("DELETE FROM quest_log") || sql.includes("DELETE FROM quests") || sql.includes("UPDATE quests SET next_quest_id = NULL")) {
      if (sql.includes("DELETE FROM quests WHERE id")) {
        questTable = questTable.filter((q) => q.id !== params[0]);
      }
      return { affectedRows: 1 };
    }
    return [];
  },
}));

const assetData = new Map<string, any>([
  ["creatureTemplates", [{ id: 1, name: "Rat" }, { id: 2, name: "Wolf" }]],
  ["items", [{ name: "Bread" }, { name: "Apple", quality: "uncommon" }, { name: "Sword", quality: "epic" }]],
  ["npcs", [
    { id: 1, name: "Innkeeper", map: "overworld", quest_giver: true },
    { id: 2, name: "Guard", map: "overworld", quest_giver: false },
  ]],
  ["mapProperties", [{ name: "overworld.json" }]],
]);
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => assetData.get(key) ?? null,
    set: async (key: string, value: any) => assetData.set(key, value),
    add: async (key: string, value: any) => assetData.set(key, value),
  },
}));

const editor = await import("../systems/quests/editor");
const defs = await import("../systems/quests/definitions");

async function seedCache() {
  await defs.reload();
}

const validPayload = (): any => ({
  name: "New Quest",
  required_level: 1,
  repeatable: "none",
  objectives: [{ type: "kill", target: "1", required_count: 3 }],
  rewards: [{ item_name: "Bread", quantity: 1 }],
  prerequisites: [],
});

describe("quest editor permissions", () => {
  test("admins, the quest permission and wildcards pass; others do not", () => {
    expect(editor.canUseEditor({ isAdmin: true })).toBe(true);
    expect(editor.canUseEditor({ permissions: ["tools.quest_editor"] })).toBe(true);
    expect(editor.canUseEditor({ permissions: ["tools.*"] })).toBe(true);
    expect(editor.canUseEditor({ permissions: ["server.*"] })).toBe(true);
    expect(editor.canUseEditor({ permissions: ["tools.npc_editor"] })).toBe(false);
    expect(editor.canUseEditor(null)).toBe(false);
  });
});

describe("quest editor validation", () => {
  test("a valid quest passes", async () => {
    resetDb();
    await seedCache();
    expect(await editor.validateQuest(validPayload())).toEqual([]);
  });

  test("objective targets must resolve per type", async () => {
    resetDb();
    await seedCache();
    expect(await editor.validateQuest({ ...validPayload(), objectives: [{ type: "kill", target: "999", required_count: 1 }] }))
      .toContain("Objective 1: kill target does not match a creature template id.");
    expect(await editor.validateQuest({ ...validPayload(), objectives: [{ type: "collect", target: "Nope", required_count: 1 }] }))
      .toContain("Objective 1: collect target does not match an item name.");
    expect(await editor.validateQuest({ ...validPayload(), objectives: [{ type: "talk", target: "999", required_count: 1 }] }))
      .toContain("Objective 1: talk target does not match an NPC id.");
    expect(await editor.validateQuest({ ...validPayload(), objectives: [{ type: "explore", target: "nowhere", required_count: 1 }] }))
      .toContain("Objective 1: explore target does not match a map name.");
  });

  test("radius requires a point and counts must be at least 1", async () => {
    resetDb();
    await seedCache();
    expect(
      await editor.validateQuest({ ...validPayload(), objectives: [{ type: "explore", target: "overworld", required_count: 1, target_radius: 50 }] })
    ).toContain("Objective 1: a radius requires both target_x and target_y.");
    expect(await editor.validateQuest({ ...validPayload(), objectives: [{ type: "kill", target: "1", required_count: 0 }] }))
      .toContain("Objective 1: required count must be an integer of at least 1.");
  });

  test("reward items must exist with a sane quantity", async () => {
    resetDb();
    await seedCache();
    expect(await editor.validateQuest({ ...validPayload(), rewards: [{ item_name: "Nope", quantity: 1 }] }))
      .toContain('Reward 1: item "Nope" does not exist.');
    expect(await editor.validateQuest({ ...validPayload(), rewards: [{ item_name: "Bread", quantity: 0 }] }))
      .toContain("Reward 1: quantity must be an integer of at least 1.");
  });

  test("prerequisite cycles and self-references are rejected", async () => {
    resetDb();
    await seedCache();
    // Quest 2 already requires quest 1: making 1 require 2 is a cycle.
    expect(await editor.validateQuest({ ...validPayload(), id: 1, prerequisites: [2] }))
      .toContain("Prerequisite 2 would create a cycle.");
    expect(await editor.validateQuest({ ...validPayload(), id: 1, prerequisites: [1] }))
      .toContain("A quest cannot require itself.");
    expect(await editor.validateQuest({ ...validPayload(), id: 1, prerequisites: [999] }))
      .toContain("Prerequisite quest 999 does not exist.");
  });

  test("next quest must exist and cannot be self-referential", async () => {
    resetDb();
    await seedCache();
    expect(await editor.validateQuest({ ...validPayload(), id: 1, next_quest_id: 1 }))
      .toContain("A quest cannot chain into itself.");
    expect(await editor.validateQuest({ ...validPayload(), next_quest_id: 999 }))
      .toContain("Next quest does not exist.");
  });

  test("quest links require NPCs flagged as quest givers", async () => {
    resetDb();
    await seedCache();
    expect(await editor.validateQuest({ ...validPayload(), givers: [1], enders: [1] })).toEqual([]);
    expect(await editor.validateQuest({ ...validPayload(), givers: [2] }))
      .toContain("NPC 2 in givers is not marked as a quest giver.");
    expect(await editor.validateQuest({ ...validPayload(), enders: [999] }))
      .toContain("NPC 999 in enders does not exist.");
  });
});

describe("quest editor data", () => {
  test("items carry their quality for the reward icon frames", async () => {
    resetDb();
    await seedCache();
    const data = await editor.buildEditorData();
    const byName = new Map(data.items.map((i: any) => [i.name, i.quality]));
    expect(byName.get("Sword")).toBe("epic");
    expect(byName.get("Apple")).toBe("uncommon");
    // An item without a stored quality shows as common.
    expect(byName.get("Bread")).toBe("common");
  });
});

describe("quest editor saving", () => {
  test("saving persists children and reloads the cache", async () => {
    resetDb();
    await seedCache();
    const result = await editor.save({
      ...validPayload(),
      prerequisites: [],
      givers: [1],
      enders: [1],
    });
    expect(result.ok).toBe(true);
    expect(result.id).toBeDefined();
    expect(defs.find(result.id!)?.name).toBe("New Quest");
    expect(npcLinkTable.filter((r) => r.quest_id === result.id)).toHaveLength(2);
  });

  test("saving drops links to deleted NPCs instead of failing", async () => {
    resetDb();
    await seedCache();
    const result = await editor.save({ ...validPayload(), id: 1, givers: [1, 999], enders: [998, 1] });
    expect(result.ok).toBe(true);
    const links = npcLinkTable.filter((r) => r.quest_id === 1);
    expect(links.map((r) => r.npc_id).sort()).toEqual([1, 1]);
    expect(links.map((r) => r.role).sort()).toEqual(["ender", "giver"]);
  });

  test("an unreadable NPC list never wipes quest links", async () => {
    resetDb();
    await seedCache();
    npcLinkTable = [{ npc_id: 1, quest_id: 1, role: "giver" }];
    const npcs = assetData.get("npcs");
    assetData.delete("npcs");
    try {
      const result = await editor.save({ ...validPayload(), id: 1, givers: [1] });
      expect(result.ok).toBe(false);
      expect(npcLinkTable).toEqual([{ npc_id: 1, quest_id: 1, role: "giver" }]);
    } finally {
      assetData.set("npcs", npcs);
    }
  });

  test("concurrent saves for one quest do not duplicate objectives", async () => {
    resetDb();
    await seedCache();
    const payload = {
      ...validPayload(),
      id: 1,
      objectives: [{ type: "kill", target: "1", required_count: 3 }],
      rewards: [{ item_name: "Bread", quantity: 1 }],
      prerequisites: [],
    };
    const [first, second] = await Promise.all([editor.save(payload), editor.save(payload)]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(objectiveTable.filter((o) => o.quest_id === 1)).toHaveLength(1);
    expect(rewardTable.filter((r) => r.quest_id === 1)).toHaveLength(1);
  });

  test("concurrent creates sharing a clientKey insert only one quest", async () => {
    resetDb();
    await seedCache();
    const payload = {
      ...validPayload(),
      id: null,
      clientKey: "draft-123",
      name: "Brand New Quest",
      objectives: [{ type: "kill", target: "1", required_count: 3 }],
      rewards: [{ item_name: "Bread", quantity: 1 }],
      prerequisites: [],
    };
    const [first, second] = await Promise.all([editor.save(payload), editor.save(payload)]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.id).toBe(second.id);
    expect(questTable.filter((q) => q.name === "Brand New Quest")).toHaveLength(1);
    expect(objectiveTable.filter((o) => o.quest_id === first.id)).toHaveLength(1);
  });

  test("search finds by name and caps results", async () => {
    resetDb();
    await seedCache();
    const result = await editor.search("existing");
    expect(result.quests.map((q) => q.name)).toEqual(["Existing Quest"]);
  });

  test("an empty query browses everything so entries show without searching", async () => {
    resetDb();
    await seedCache();
    const result = await editor.search("");
    expect(result.quests.map((q) => q.name).sort()).toEqual(["Existing Quest", "Second Quest"]);
    expect(result.truncated).toBe(0);
  });

  test("removing deletes the quest and its children", async () => {
    resetDb();
    await seedCache();
    await editor.remove(2);
    expect(questTable.some((q) => q.id === 2)).toBe(false);
    expect(defs.find(2)).toBeUndefined();
  });
});
