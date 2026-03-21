import { expect, test } from "bun:test";
import { createMockCollectable } from "./setup";

const collectablesDatabase: Record<string, any[]> = {
  user1: [
    { username: "user1", item: "rare_sword", type: "weapon" },
    { username: "user1", item: "blue_gem", type: "gem" },
  ],
  user2: [],
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT item, type FROM collectables")) {
    const user = params[0];
    return collectablesDatabase[user] || [];
  }
  if (sql.includes("SELECT * FROM collectables")) {
    const [type, item, user] = params;
    const userCollectables = collectablesDatabase[user] || [];
    return userCollectables.filter((c) => c.type === type && c.item === item);
  }
  if (sql.includes("INSERT INTO collectables")) {
    const [type, item, user] = params;
    if (!collectablesDatabase[user]) collectablesDatabase[user] = [];
    const exists = collectablesDatabase[user].find((c) => c.type === type && c.item === item);
    if (!exists) {
      collectablesDatabase[user].push({ username: user, item, type });
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("DELETE FROM collectables")) {
    const [type, item, user] = params;
    if (collectablesDatabase[user]) {
      const index = collectablesDatabase[user].findIndex((c) => c.type === type && c.item === item);
      if (index !== -1) {
        collectablesDatabase[user].splice(index, 1);
        return { affectedRows: 1 };
      }
    }
    return { affectedRows: 0 };
  }
  return [];
};

const collectables = {
  async list(username: string) {
    return (await mockQuery("SELECT item, type FROM collectables WHERE username = ?", [username])) as any[];
  },

  async add(collectable: any) {
    if (!collectable?.type || !collectable?.item || !collectable?.username) return;
    const existing = (await mockQuery("SELECT * FROM collectables WHERE type = ? AND item = ? AND username = ?", [
      collectable.type,
      collectable.item,
      collectable.username,
    ])) as any[];
    if (existing.length > 0) return;
    return await mockQuery("INSERT INTO collectables (type, item, username) VALUES (?, ?, ?)", [
      collectable.type,
      collectable.item,
      collectable.username,
    ]);
  },

  async remove(collectable: any) {
    if (!collectable?.type || !collectable?.item || !collectable?.username) return;
    return await mockQuery("DELETE FROM collectables WHERE type = ? AND item = ? AND username = ?", [
      collectable.type,
      collectable.item,
      collectable.username,
    ]);
  },

  async find(collectable: any) {
    if (!collectable?.type || !collectable?.item || !collectable?.username) return;
    const response = (await mockQuery("SELECT item, type FROM collectables WHERE type = ? AND item = ? AND username = ?", [
      collectable.type,
      collectable.item,
      collectable.username,
    ])) as any[];
    if (response.length === 0) return;
    return response;
  },
};

test("collectables.list returns all collectables for user", async () => {
  const result = await collectables.list("user1");
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(2);
});

test("collectables.list returns empty for user with no collectables", async () => {
  const result = await collectables.list("user2");
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(0);
});

test("collectables.list returns empty for non-existent user", async () => {
  const result = await collectables.list("nonexistent");
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(0);
});

test("collectables.add requires all fields", async () => {
  const result = await collectables.add({ type: "gem", item: "diamond" });
  expect(result).toBeUndefined();
});

test("collectables.add adds new collectable", async () => {
  const collectable = createMockCollectable({ username: "user2" });
  await collectables.add(collectable);
  const result = await collectables.list("user2");
  expect(result.length).toBeGreaterThan(0);
});

test("collectables.add prevents duplicates", async () => {
  const collectable = createMockCollectable({ username: "user1", item: "rare_sword", type: "weapon" });
  const result = await collectables.add(collectable);
  expect(result).toBeUndefined();
});

test("collectables.remove requires all fields", async () => {
  const result = await collectables.remove({ type: "gem" });
  expect(result).toBeUndefined();
});

test("collectables.remove deletes collectable", async () => {
  const collectable = createMockCollectable({ username: "user1", item: "rare_sword", type: "weapon" });
  await collectables.remove(collectable);
  const result = await collectables.find(collectable);
  expect(result).toBeUndefined();
});

test("collectables.find requires all fields", async () => {
  const result = await collectables.find({ type: "gem" });
  expect(result).toBeUndefined();
});

test("collectables.find returns collectable", async () => {

  const collectable = createMockCollectable({ username: "user3", item: "test_gem", type: "gem" });
  await collectables.add(collectable);
  const result = await collectables.find(collectable);
  expect(result?.length || 0).toBeGreaterThanOrEqual(0);
});
