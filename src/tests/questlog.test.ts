import { expect, test } from "bun:test";

// Mock database
const questLogDatabase: Record<string, any> = {
  user1: { completed_quests: "1,2", incomplete_quests: "3,4" },
  user2: { completed_quests: "", incomplete_quests: "1" },
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT completed_quests")) {
    const [username] = params;
    return [questLogDatabase[username] || { completed_quests: "", incomplete_quests: "" }];
  }
  if (sql.includes("UPDATE quest_log")) {
    const [completed, incomplete, username] = params;
    questLogDatabase[username] = { completed_quests: completed, incomplete_quests: incomplete };
    return { affectedRows: 1 };
  }
  return [];
};

const quests = {
  async find(id: number) {
    return id > 0 ? { id } : null;
  },
};

const questlog = {
  async get(username: string) {
    const result = (await mockQuery("SELECT completed_quests, incomplete_quests FROM quest_log WHERE username = ?", [username])) as any[];
    if (!result || !result[0]) {
      return { completed: [], incomplete: [] };
    }
    const completed = result[0].completed_quests ? result[0].completed_quests.split(",").map((q: string) => parseInt(q)) : [];
    const incomplete = result[0].incomplete_quests ? result[0].incomplete_quests.split(",").map((q: string) => parseInt(q)) : [];
    return { completed, incomplete };
  },

  async startQuest(username: string, id: number) {
    const quest = await quests.find(id);
    if (!quest) return;
    const questLog = await this.get(username);
    questLog.incomplete.push(id);
    await this.updateQuestLog(username, questLog);
  },

  async updateQuestLog(username: string, questLog: any) {
    return await mockQuery("UPDATE quest_log SET completed_quests = ?, incomplete_quests = ? WHERE username = ?", [
      questLog.completed.join(","),
      questLog.incomplete.join(","),
      username,
    ]);
  },

  async completeQuest(username: string, id: number) {
    const quest = await quests.find(id);
    if (!quest) return;
    const questLog = await this.get(username);
    if (questLog.incomplete.includes(id)) {
      questLog.incomplete.splice(questLog.incomplete.indexOf(id), 1);
      questLog.completed.push(id);
      await this.updateQuestLog(username, questLog);
    }
  },
};

test("questlog.get returns quest log for user", async () => {
  const result = await questlog.get("user1");
  expect(Array.isArray(result.completed)).toBe(true);
  expect(Array.isArray(result.incomplete)).toBe(true);
});

test("questlog.get returns empty arrays for non-existent user", async () => {
  const result = await questlog.get("nonexistent");
  expect(result.completed).toEqual([]);
  expect(result.incomplete).toEqual([]);
});

test("questlog.startQuest adds quest to incomplete list", async () => {
  await questlog.startQuest("user1", 5);
  const result = await questlog.get("user1");
  expect(result.incomplete).toContain(5);
});

test("questlog.startQuest does nothing for invalid quest", async () => {
  const before = await questlog.get("user1");
  await questlog.startQuest("user1", -1);
  const after = await questlog.get("user1");
  expect(before).toEqual(after);
});

test("questlog.completeQuest moves quest from incomplete to completed", async () => {
  await questlog.completeQuest("user1", 3);
  const result = await questlog.get("user1");
  expect(result.incomplete).not.toContain(3);
  expect(result.completed).toContain(3);
});

test("questlog.completeQuest does nothing for non-existent quest", async () => {
  const before = await questlog.get("user1");
  await questlog.completeQuest("user1", 999);
  const after = await questlog.get("user1");
  expect(before).toEqual(after);
});

test("questlog.updateQuestLog updates quest log", async () => {
  const questLog = { completed: [1, 2, 3], incomplete: [4, 5] };
  await questlog.updateQuestLog("user1", questLog);
  const result = await questlog.get("user1");
  expect(result.completed).toContain(3);
  expect(result.incomplete).toContain(5);
});
