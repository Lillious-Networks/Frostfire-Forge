import { expect, test } from "bun:test";

const accountsDatabase: Record<string, any> = {
  user1: { username: "user1", party_id: 1 },
  user2: { username: "user2", party_id: 1 },
  user3: { username: "user3", party_id: null },
};

const partiesDatabase: Record<number, any> = {
  1: { id: 1, leader: "user1", members: "user1, user2" },
};

let nextPartyId = 2;

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT party_id FROM accounts")) {
    const user = params[0];
    return [accountsDatabase[user] || { party_id: null }];
  }
  if (sql.includes("SELECT id FROM parties WHERE leader")) {
    const leader = params[0];
    const party = Object.values(partiesDatabase).find((p) => p.leader === leader);
    return party ? [party] : [];
  }
  if (sql.includes("SELECT members FROM parties")) {
    const partyId = params[0];
    return [partiesDatabase[partyId] || { members: "" }];
  }
  if (sql.includes("SELECT leader FROM parties")) {
    const partyId = params[0];
    return [partiesDatabase[partyId] || { leader: null }];
  }
  if (sql.includes("SELECT id, leader, members FROM parties")) {
    return Object.values(partiesDatabase);
  }
  if (sql.includes("INSERT INTO parties")) {
    const [leader, members] = params;
    const partyId = nextPartyId++;
    partiesDatabase[partyId] = { id: partyId, leader, members };
    return { lastInsertRowid: partyId, affectedRows: 1 };
  }
  if (sql.includes("UPDATE accounts SET party_id")) {
    const [partyId, ...users] = params;
    users.forEach((user) => {
      if (accountsDatabase[user]) accountsDatabase[user].party_id = partyId;
    });
    return { affectedRows: 1 };
  }
  if (sql.includes("UPDATE parties SET members")) {
    const [members, partyId] = params;
    if (partiesDatabase[partyId]) {
      partiesDatabase[partyId].members = members;
    }
    return { affectedRows: 1 };
  }
  if (sql.includes("DELETE FROM parties")) {
    const [partyId] = params;
    delete partiesDatabase[partyId];
    return { affectedRows: 1 };
  }
  return [];
};

const parties = {
  async isInParty(username: string) {
    if (!username) return false;
    const result = (await mockQuery("SELECT party_id FROM accounts WHERE username = ?", [username])) as any[];
    return result.length > 0 && result[0].party_id !== null;
  },

  async isPartyLeader(username: string) {
    if (!username) return false;
    const result = (await mockQuery("SELECT id FROM parties WHERE leader = ?", [username])) as any[];
    return result.length > 0;
  },

  async getPartyId(username: string) {
    if (!username) return null;
    const result = (await mockQuery("SELECT party_id FROM accounts WHERE username = ?", [username])) as any[];
    if (result.length === 0 || !result[0].party_id) return null;
    return result[0].party_id;
  },

  async getPartyMembers(partyId: number) {
    if (!partyId) return [];
    const result = (await mockQuery("SELECT members FROM parties WHERE id = ?", [partyId])) as any[];
    if (result.length === 0 || !result[0].members) return [];
    const members = result[0].members.split(",").map((m: string) => m.trim());
    return members.filter((m: string) => m);
  },

  async getPartyLeader(partyId: number) {
    if (!partyId) return null;
    const result = (await mockQuery("SELECT leader FROM parties WHERE id = ?", [partyId])) as any[];
    if (result.length === 0 || !result[0].leader) return null;
    return result[0].leader;
  },

  async exists(username: string) {
    if (!username) return false;
    const result = await this.getPartyId(username);
    return result !== null;
  },

  async getAllParties() {
    try {
      const result = (await mockQuery("SELECT id, leader, members FROM parties", [])) as any[];
      if (!result || result.length === 0) return [];
      return result.map((row: any) => ({
        id: row.id,
        leader: row.leader,
        members: row.members ? row.members.split(",").map((m: string) => m.trim()).filter((m: string) => m) : [],
      }));
    } catch {
      return [];
    }
  },
};

test("parties.isInParty returns true for users in party", async () => {
  const result = await parties.isInParty("user1");
  expect(result).toBe(true);
});

test("parties.isInParty returns false for users not in party", async () => {
  const result = await parties.isInParty("user3");
  expect(result).toBe(false);
});

test("parties.isPartyLeader returns true for party leaders", async () => {
  const result = await parties.isPartyLeader("user1");
  expect(result).toBe(true);
});

test("parties.isPartyLeader returns false for non-leaders", async () => {
  const result = await parties.isPartyLeader("user2");
  expect(result).toBe(false);
});

test("parties.getPartyId returns party id", async () => {
  const result = await parties.getPartyId("user1");
  expect(result).toBe(1);
});

test("parties.getPartyId returns null for non-members", async () => {
  const result = await parties.getPartyId("user3");
  expect(result).toBeNull();
});

test("parties.getPartyMembers returns members list", async () => {
  const result = await parties.getPartyMembers(1);
  expect(result).toContain("user1");
  expect(result).toContain("user2");
});

test("parties.getPartyLeader returns leader name", async () => {
  const result = await parties.getPartyLeader(1);
  expect(result).toBe("user1");
});

test("parties.getAllParties returns all parties", async () => {
  const result = await parties.getAllParties();
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThan(0);
});
