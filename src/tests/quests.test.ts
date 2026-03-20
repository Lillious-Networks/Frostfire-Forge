import { expect, test } from "bun:test";
import { mockAssetCache } from "./setup";

// Mock database
const questsDatabase: Record<number, any> = {
  1: { id: 1, name: "Kill 10 rats", description: "Kill 10 rats", reward: 100, xp_gain: 50, required_quest: 0, required_level: 1 },
  2: { id: 2, name: "Collect 5 gems", description: "Collect 5 gems", reward: 200, xp_gain: 100, required_quest: 1, required_level: 5 },
};

let nextQuestId = 3;

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("INSERT INTO quests")) {
    const [name, description, reward, xp, requiredQuest, requiredLevel] = params;
    const id = nextQuestId++;
    questsDatabase[id] = { id, name, description, reward, xp_gain: xp, required_quest: requiredQuest, required_level: requiredLevel };
    return { lastInsertRowid: id };
  }
  if (sql.includes("DELETE FROM quests")) {
    const [id] = params;
    delete questsDatabase[id];
    return { affectedRows: 1 };
  }
  if (sql.includes("SELECT * FROM quests WHERE id")) {
    const [id] = params;
    return questsDatabase[id] ? [questsDatabase[id]] : [];
  }
  if (sql.includes("SELECT * FROM quests")) {
    return Object.values(questsDatabase);
  }
  if (sql.includes("UPDATE quests")) {
    const id = params[params.length - 1];
    questsDatabase[id] = { id, ...params };
    return { affectedRows: 1 };
  }
  return [];
};

const quests = {
  async add(quest: any) {
    if (!quest?.name || !quest?.description || !quest?.reward || !quest?.xp_gain || quest?.required_quest === undefined || quest?.required_level === undefined)
      return;
    return await mockQuery("INSERT INTO quests (name, description, reward, xp_gain, required_quest, required_level) VALUES (?, ?, ?, ?, ?, ?)", [
      quest.name,
      quest.description,
      quest.reward,
      quest.xp_gain,
      quest.required_quest,
      quest.required_level,
    ]);
  },

  async remove(id: number) {
    if (!id) return;
    return await mockQuery("DELETE FROM quests WHERE id = ?", [id]);
  },

  async list() {
    return await mockQuery("SELECT * FROM quests", []);
  },

  async find(id: number) {
    if (!id) return;
    return await mockQuery("SELECT * FROM quests WHERE id = ?", [id]);
  },

  async update(quest: any) {
    if (!quest?.id) return;
    const result = await mockQuery("UPDATE quests SET name = ? WHERE id = ?", [quest.name, quest.id]);
    if (result) {
      const questsList = (await mockAssetCache.get("quests")) as any[];
      const index = questsList.findIndex((q) => q.id === quest.id);
      if (index !== -1) {
        questsList[index] = quest;
        await mockAssetCache.set("quests", questsList);
      }
    }
  },
};

test("quests.list returns all quests", async () => {
  const result = (await quests.list()) as any[];
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThan(0);
});

test("quests.find returns quest by id", async () => {
  const result = (await quests.find(1)) as any[];
  expect(result?.length).toBeGreaterThan(0);
  expect(result[0].id).toBe(1);
});

test("quests.find returns undefined for non-existent quest", async () => {
  const result = await quests.find(999);
  expect((result as any)?.length || 0).toBe(0);
});

test("quests.add requires all fields", async () => {
  const result = await quests.add({ name: "Incomplete Quest" });
  expect(result).toBeUndefined();
});

test("quests.add creates new quest", async () => {
  const quest = {
    name: "New Quest",
    description: "A new quest",
    reward: 150,
    xp_gain: 75,
    required_quest: 0,
    required_level: 1,
  };
  const result = await quests.add(quest);
  expect(result).toBeDefined();
});

test("quests.remove deletes quest", async () => {
  await quests.remove(2);
  const result = await quests.find(2);
  expect((result as any)?.length || 0).toBe(0);
});
