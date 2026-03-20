import { expect, test } from "bun:test";

// Mock database
const accountsDatabase: Record<string, any> = {
  user1: { username: "user1", guild_id: 1 },
  user2: { username: "user2", guild_id: 1 },
  user3: { username: "user3", guild_id: null },
};

const guildsDatabase: Record<number, any> = {
  1: { id: 1, name: "Dragon Slayers", leader: "user1", members: "user1, user2" },
};

let nextGuildId = 2;

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT guild_id FROM accounts")) {
    const user = params[0];
    return accountsDatabase[user] ? [accountsDatabase[user]] : [];
  }
  if (sql.includes("SELECT id FROM guilds WHERE leader")) {
    const leader = params[0];
    const guild = Object.values(guildsDatabase).find((g) => g.leader === leader);
    return guild ? [guild] : [];
  }
  if (sql.includes("SELECT name FROM guilds")) {
    const guildId = params[0];
    return [guildsDatabase[guildId] || { name: null }];
  }
  if (sql.includes("SELECT members FROM guilds")) {
    const guildId = params[0];
    return [guildsDatabase[guildId] || { members: "" }];
  }
  if (sql.includes("SELECT leader FROM guilds")) {
    const guildId = params[0];
    return [guildsDatabase[guildId] || { leader: null }];
  }
  if (sql.includes("SELECT id FROM guilds WHERE name")) {
    const name = params[0];
    const guild = Object.values(guildsDatabase).find((g) => g.name === name);
    return guild ? [guild] : [];
  }
  if (sql.includes("INSERT INTO guilds")) {
    const [leader, name, members] = params;
    const guildId = nextGuildId++;
    guildsDatabase[guildId] = { id: guildId, name, leader, members };
    return { lastInsertRowid: guildId, affectedRows: 1 };
  }
  if (sql.includes("UPDATE accounts SET guild_id")) {
    const [guildId, user] = params;
    if (accountsDatabase[user]) accountsDatabase[user].guild_id = guildId;
    return { affectedRows: 1 };
  }
  if (sql.includes("UPDATE guilds SET members")) {
    const [members, guildId] = params;
    if (guildsDatabase[guildId]) guildsDatabase[guildId].members = members;
    return { affectedRows: 1 };
  }
  if (sql.includes("DELETE FROM guilds")) {
    const [guildId] = params;
    delete guildsDatabase[guildId];
    return { affectedRows: 1 };
  }
  return [];
};

const guilds = {
  async isInGuild(username: string) {
    if (!username) return false;
    const result = (await mockQuery("SELECT guild_id FROM accounts WHERE username = ?", [username])) as any[];
    return result.length > 0;
  },

  async isGuildLeader(username: string) {
    if (!username) return false;
    const result = (await mockQuery("SELECT id FROM guilds WHERE leader = ?", [username])) as any[];
    return result.length > 0;
  },

  async getGuildId(username: string) {
    if (!username) return null;
    const result = (await mockQuery("SELECT guild_id FROM accounts WHERE username = ?", [username])) as any[];
    if (result.length === 0 || !result[0].guild_id) return null;
    return result[0].guild_id;
  },

  async getGuildName(guildId: number) {
    if (!guildId) return null;
    const result = (await mockQuery("SELECT name FROM guilds WHERE id = ?", [guildId])) as any[];
    if (result.length === 0 || !result[0].name) return null;
    return result[0].name;
  },

  async getGuildMembers(guildId: number) {
    if (!guildId) return [];
    const result = (await mockQuery("SELECT members FROM guilds WHERE id = ?", [guildId])) as any[];
    if (result.length === 0 || !result[0].members) return [];
    const members = result[0].members.split(",").map((m: string) => m.trim());
    return members.filter((m: string) => m);
  },

  async getGuildLeader(guildId: number) {
    if (!guildId) return null;
    const result = (await mockQuery("SELECT leader FROM guilds WHERE id = ?", [guildId])) as any[];
    if (result.length === 0 || !result[0].leader) return null;
    return result[0].leader;
  },

  async exists(name: string) {
    if (!name) return false;
    const result = (await mockQuery("SELECT id FROM guilds WHERE name = ?", [name])) as any[];
    return result.length > 0;
  },
};

test("guilds.isInGuild returns true for guild members", async () => {
  const result = await guilds.isInGuild("user1");
  expect(result).toBe(true);
});

test("guilds.isInGuild returns false for non-members", async () => {
  const result = await guilds.isInGuild("nonexistent_user");
  expect(result).toBe(false);
});

test("guilds.isGuildLeader returns true for leaders", async () => {
  const result = await guilds.isGuildLeader("user1");
  expect(result).toBe(true);
});

test("guilds.isGuildLeader returns false for non-leaders", async () => {
  const result = await guilds.isGuildLeader("user2");
  expect(result).toBe(false);
});

test("guilds.getGuildId returns guild id", async () => {
  const result = await guilds.getGuildId("user1");
  expect(result).toBe(1);
});

test("guilds.getGuildId returns null for non-members", async () => {
  const result = await guilds.getGuildId("user3");
  expect(result).toBeNull();
});

test("guilds.getGuildName returns guild name", async () => {
  const result = await guilds.getGuildName(1);
  expect(result).toBe("Dragon Slayers");
});

test("guilds.getGuildMembers returns members list", async () => {
  const result = await guilds.getGuildMembers(1);
  expect(result).toContain("user1");
  expect(result).toContain("user2");
});

test("guilds.getGuildLeader returns leader name", async () => {
  const result = await guilds.getGuildLeader(1);
  expect(result).toBe("user1");
});

test("guilds.exists returns true for existing guild", async () => {
  const result = await guilds.exists("Dragon Slayers");
  expect(result).toBe(true);
});

test("guilds.exists returns false for non-existent guild", async () => {
  const result = await guilds.exists("Nonexistent");
  expect(result).toBe(false);
});
