import { expect, test } from "bun:test";

const accountsDatabase: Record<string, any> = {
  user1: { username: "user1", guild_id: 1 },
  user2: { username: "user2", guild_id: 1 },
  user3: { username: "user3", guild_id: 2 },
  user4: { username: "user4", guild_id: null },
  user5: { username: "user5", guild_id: null },
};

const guildsDatabase: Record<number, any> = {
  1: { id: 1, name: "Dragon Slayers", leader: "user1", members: "user1, user2" },
  2: { id: 2, name: "Shadow Guild", leader: "user3", members: "user3" },
};

let nextGuildId = 3;

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT guild_id FROM accounts WHERE username")) {
    const user = params[0];
    return [accountsDatabase[user] || { guild_id: null }];
  }
  if (sql.includes("SELECT id FROM guilds WHERE leader")) {
    const leader = params[0];
    const guild = Object.values(guildsDatabase).find((g: any) => g.leader === leader);
    return guild ? [guild] : [];
  }
  if (sql.includes("SELECT name FROM guilds WHERE id")) {
    const guildId = params[0];
    return [guildsDatabase[guildId] || { name: null }];
  }
  if (sql.includes("SELECT members FROM guilds WHERE id")) {
    const guildId = params[0];
    return [guildsDatabase[guildId] || { members: "" }];
  }
  if (sql.includes("SELECT leader FROM guilds WHERE id")) {
    const guildId = params[0];
    return [guildsDatabase[guildId] || { leader: null }];
  }
  if (sql.includes("SELECT id FROM guilds WHERE LOWER(name)")) {
    const name = params[0];
    const guild = Object.values(guildsDatabase).find((g: any) => g.name.toLowerCase() === name.toLowerCase());
    return guild ? [guild] : [];
  }
  if (sql.includes("INSERT INTO guilds")) {
    const [leader, name, members] = params;
    const guildId = nextGuildId++;
    guildsDatabase[guildId] = { id: guildId, leader, name, members };
    return { lastInsertRowid: guildId, affectedRows: 1 };
  }
  if (sql.includes("UPDATE accounts SET guild_id") && sql.includes("WHERE username")) {
    const [guildId, username] = params;
    if (accountsDatabase[username]) {
      accountsDatabase[username].guild_id = guildId;
    }
    return { affectedRows: 1 };
  }
  if (sql.includes("UPDATE accounts SET guild_id = NULL WHERE guild_id")) {
    const [guildId] = params;
    Object.values(accountsDatabase).forEach((account: any) => {
      if (account.guild_id === guildId) {
        account.guild_id = null;
      }
    });
    return { affectedRows: 1 };
  }
  if (sql.includes("UPDATE guilds SET members")) {
    const [members, guildId] = params;
    if (guildsDatabase[guildId]) {
      guildsDatabase[guildId].members = members;
    }
    return { affectedRows: 1 };
  }
  if (sql.includes("DELETE FROM guilds WHERE id")) {
    const [guildId] = params;
    delete guildsDatabase[guildId];
    return { affectedRows: 1 };
  }
  return [];
};

const guilds = {
  async isInGuild(username: string): Promise<boolean> {
    if (!username) return false;
    try {
      const result = (await mockQuery("SELECT guild_id FROM accounts WHERE username = ?", [username])) as any[];
      if (result.length === 0) return false;
      return result[0].guild_id != null;
    } catch (error) {
      return false;
    }
  },

  async isGuildLeader(username: string): Promise<boolean> {
    if (!username) return false;
    try {
      const result = (await mockQuery("SELECT id FROM guilds WHERE leader = ?", [username])) as any[];
      return result.length > 0;
    } catch (error) {
      return false;
    }
  },

  async getGuildId(username: string): Promise<number | null> {
    if (!username) return null;
    try {
      const result = (await mockQuery("SELECT guild_id FROM accounts WHERE username = ?", [username])) as any[];
      if (result.length === 0 || !result[0].guild_id) return null;
      return result[0].guild_id;
    } catch (error) {
      return null;
    }
  },

  async getGuildName(guildId: number): Promise<string | null> {
    if (!guildId) return null;
    try {
      const result = (await mockQuery("SELECT name FROM guilds WHERE id = ?", [guildId])) as any[];
      if (result.length === 0 || !result[0].name) return null;
      return result[0].name;
    } catch (error) {
      return null;
    }
  },

  async getGuildMembers(guildId: number): Promise<string[]> {
    if (!guildId) return [];
    try {
      const result = (await mockQuery("SELECT members FROM guilds WHERE id = ?", [guildId])) as any[];
      if (result.length === 0 || !result[0].members) return [];
      const members = result[0].members.split(",").map((member: any) => member.trim());
      return members.filter((member: any) => member);
    } catch (error) {
      return [];
    }
  },

  async getGuildLeader(guildId: number): Promise<string | null> {
    if (!guildId) return null;
    try {
      const result = (await mockQuery("SELECT leader FROM guilds WHERE id = ?", [guildId])) as any[];
      if (result.length === 0 || !result[0].leader) return null;
      return result[0].leader;
    } catch (error) {
      return null;
    }
  },

  async exists(name: string): Promise<boolean> {
    if (!name) return false;
    try {
      const result = (await mockQuery("SELECT id FROM guilds WHERE LOWER(name) = LOWER(?)", [name])) as any[];
      return result.length > 0;
    } catch (error) {
      return false;
    }
  },

  async add(username: string, guildId: number): Promise<string[]> {
    if (!username) return [];
    try {
      const existingGuild = await this.isInGuild(username);
      if (existingGuild) return [];

      const members = (await this.getGuildMembers(guildId)) as string[];
      if (!members || members?.length === 0) return [];

      if (members.length >= 500) return [];

      if (members.includes(username)) return [];

      await mockQuery("UPDATE accounts SET guild_id = ? WHERE username = ?", [guildId, username]);
      const updatedMembers = [...members, username].join(", ");
      await mockQuery("UPDATE guilds SET members = ? WHERE id = ?", [updatedMembers, guildId]);
      return updatedMembers.split(", ").map((member: string) => member.trim());
    } catch (error) {
      return [];
    }
  },

  async remove(username: string): Promise<string[] | boolean> {
    if (!username) return [];
    try {
      const guildId = await this.getGuildId(username);
      if (!guildId) return [];

      await mockQuery("UPDATE accounts SET guild_id = NULL WHERE username = ?", [username]);

      const members = await this.getGuildMembers(guildId);

      const updatedMembers = members.filter((member: string) => member !== username).join(", ");
      await mockQuery("UPDATE guilds SET members = ? WHERE id = ?", [updatedMembers, guildId]);
      const memberArray = updatedMembers.split(",").map((member: string) => member.trim());
      return memberArray.map((member: string) => member.trim());
    } catch (error) {
      return [];
    }
  },

  async delete(guildId: number): Promise<boolean> {
    if (!guildId) return false;
    try {
      await mockQuery("DELETE FROM guilds WHERE id = ?", [guildId]);
      await mockQuery("UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", [guildId]);
      return true;
    } catch (error) {
      return false;
    }
  },

  async leave(username: string): Promise<boolean | string[]> {
    if (!username) return false;
    try {
      const guildId = await this.getGuildId(username);
      if (!guildId) return false;

      const isLeader = await this.isGuildLeader(username);
      if (isLeader) {
        return false;
      }
      return await this.remove(username);
    } catch (error) {
      return false;
    }
  },

  async disband(username: string): Promise<boolean> {
    if (!username) return false;
    try {
      const guildId = await this.getGuildId(username);
      if (!guildId) return false;

      const isLeader = await this.isGuildLeader(username);
      if (!isLeader) return false;

      const members = await this.getGuildMembers(guildId);
      if (members.length === 0) return false;

      await mockQuery("UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", [guildId]);

      return await this.delete(guildId);
    } catch (error) {
      return false;
    }
  },

  async create(username: string, name: string): Promise<string[] | boolean> {
    if (!username || !name) return false;
    try {
      const trimmed = name.trim();
      if (trimmed.length === 0 || trimmed.length > 20) return false;
      if (!/^[A-Za-z ]+$/.test(trimmed)) return false;

      const existingGuild = await this.exists(trimmed);
      if (existingGuild) return false;

      const inGuild = await this.isInGuild(username);
      if (inGuild) return false;

      const members = username;
      const result = (await mockQuery("INSERT INTO guilds (leader, name, members) VALUES (?, ?, ?)", [username, trimmed, members])) as any;
      const guildId = result.lastInsertRowid;

      await mockQuery("UPDATE accounts SET guild_id = ? WHERE username = ?", [guildId, username]);
      return members.split(", ").map((member: string) => member.trim());
    } catch (error) {
      return false;
    }
  },
};

test("guilds.isInGuild returns true for members", async () => {
  const result = await guilds.isInGuild("user1");
  expect(result).toBe(true);
});

test("guilds.isInGuild returns false for non-members", async () => {
  const result = await guilds.isInGuild("user4");
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
  const result = await guilds.getGuildId("user4");
  expect(result).toBeNull();
});

test("guilds.getGuildName returns guild name", async () => {
  const result = await guilds.getGuildName(1);
  expect(result).toBe("Dragon Slayers");
});

test("guilds.getGuildMembers returns members", async () => {
  const result = await guilds.getGuildMembers(1);
  expect(result).toContain("user1");
  expect(result).toContain("user2");
});

test("guilds.getGuildLeader returns leader name", async () => {
  const result = await guilds.getGuildLeader(1);
  expect(result).toBe("user1");
});

test("guilds.exists returns true for existing", async () => {
  const result = await guilds.exists("Dragon Slayers");
  expect(result).toBe(true);
});

test("guilds.exists returns false for non-existent", async () => {
  const result = await guilds.exists("Nonexistent");
  expect(result).toBe(false);
});

test("guilds.exists is case-insensitive", async () => {
  const result = await guilds.exists("dragon slayers");
  expect(result).toBe(true);
});

test("guilds.add adds user to guild", async () => {
  const result = await guilds.add("user4", 1);
  expect(result).toContain("user4");
});

test("guilds.add rejects duplicate members", async () => {
  const result = await guilds.add("user1", 1);
  expect(result.length).toBe(0);
});

test("guilds.remove removes user from guild", async () => {
  const result = await guilds.remove("user2");
  expect(result).not.toContain("user2");
});

test("guilds.leave prevents leader from leaving", async () => {
  const result = await guilds.leave("user1");
  expect(result).toBe(false);
});

test("guilds.leave allows members to leave", async () => {
  const result = await guilds.leave("user2");
  expect(Array.isArray(result)).toBe(true);
});

test("guilds.disband removes all members", async () => {
  const result = await guilds.disband("user3");
  expect(result).toBe(true);
});

test("guilds.disband prevents non-leaders", async () => {
  const result = await guilds.disband("user2");
  expect(result).toBe(false);
});

test("guilds.create makes new guild", async () => {
  const result = await guilds.create("newuser1", "New Guild");
  expect(Array.isArray(result)).toBe(true);
});

test("guilds.create rejects duplicates", async () => {
  const result = await guilds.create("user5", "Dragon Slayers");
  expect(result).toBe(false);
});

test("guilds.create validates name length", async () => {
  const result = await guilds.create("user4", "This is a very long guild name that exceeds twenty characters");
  expect(result).toBe(false);
});

test("guilds.create validates letters only", async () => {
  const result = await guilds.create("user4", "Guild123");
  expect(result).toBe(false);
});

test("guilds.create allows letters and spaces", async () => {
  const result = await guilds.create("newuser2", "Valid Guild");
  expect(Array.isArray(result)).toBe(true);
});

test("guilds.create trims whitespace", async () => {
  const result = await guilds.create("user5", "   Guild Name   ");
  expect(Array.isArray(result)).toBe(true);
});
