import { beforeEach, expect, spyOn, test } from "bun:test";
import { migrateGuildRanks } from "../utility/guild_ranks_migration";
import { DEFAULT_RANKS } from "../systems/guildranks";
import log from "../modules/logger";

let guilds: any[];
let ranks: any[];
let members: any[];

async function ask(sql: string, values: any[] = []): Promise<any> {
  switch (sql) {
    case "SELECT id, leader, members FROM guilds":
      return guilds.map((row) => ({ ...row }));
    case "SELECT DISTINCT guild_id FROM guild_ranks":
      return [...new Set(ranks.map((row) => row.guild_id))].map((guild_id) => ({ guild_id }));
    case "SELECT username FROM guild_members":
      return members.map((row) => ({ username: row.username }));
    case "INSERT INTO guild_ranks (guild_id, rank_index, name, permissions) VALUES (?, ?, ?, ?)":
      if (ranks.some((row) => row.guild_id === values[0] && row.rank_index === values[1])) throw new Error("duplicate rank key");
      ranks.push({ guild_id: values[0], rank_index: values[1], name: values[2], permissions: values[3] });
      return { affectedRows: 1 };
    case "INSERT INTO guild_members (username, guild_id, rank_index, public_note, officer_note) VALUES (?, ?, ?, '', '')":
      if (members.some((row) => String(row.username).toLowerCase() === String(values[0]).toLowerCase())) throw new Error("duplicate member key");
      members.push({ username: values[0], guild_id: values[1], rank_index: values[2] });
      return { affectedRows: 1 };
  }
  throw new Error(`unexpected: ${sql}`);
}

// Like a transaction: all of the statements are kept, or none
async function runAll(statements: Array<{ sql: string; values: any[] }>): Promise<void> {
  const savedRanks = [...ranks];
  const savedMembers = [...members];
  try {
    for (const statement of statements) await ask(statement.sql, statement.values);
  } catch (error) {
    ranks = savedRanks;
    members = savedMembers;
    throw error;
  }
}

beforeEach(() => {
  guilds = [
    { id: 1, leader: "alice", members: "alice, bob, carol" },
    { id: 2, leader: "dave", members: "dave" },
  ];
  ranks = [];
  members = [];
});

test("every guild gets the default ranks; the leader rank 0, the rest the lowest rank", async () => {
  expect(await migrateGuildRanks(ask, runAll)).toBe(2);
  expect(ranks.filter((row) => row.guild_id === 1).map((row) => row.name)).toEqual(DEFAULT_RANKS.map((rank) => rank.name));
  expect(members.filter((row) => row.guild_id === 1)).toEqual([
    { username: "alice", guild_id: 1, rank_index: 0 },
    { username: "bob", guild_id: 1, rank_index: 4 },
    { username: "carol", guild_id: 1, rank_index: 4 },
  ]);
  expect(members.filter((row) => row.guild_id === 2)).toEqual([{ username: "dave", guild_id: 2, rank_index: 0 }]);
});

test("a leader missing from the list is still added at rank 0", async () => {
  guilds = [{ id: 3, leader: "erin", members: "frank" }];
  await migrateGuildRanks(ask, runAll);
  expect(members).toEqual([
    { username: "erin", guild_id: 3, rank_index: 0 },
    { username: "frank", guild_id: 3, rank_index: 4 },
  ]);
});

test("running it again changes nothing", async () => {
  await migrateGuildRanks(ask, runAll);
  const before = { ranks: ranks.length, members: members.length };
  expect(await migrateGuildRanks(ask, runAll)).toBe(0);
  expect({ ranks: ranks.length, members: members.length }).toEqual(before);
});

test("a name listed twice, in any case, is added once", async () => {
  guilds = [{ id: 4, leader: "gus", members: "gus, Hal, hal" }];
  await migrateGuildRanks(ask, runAll);
  expect(members.map((row) => row.username)).toEqual(["gus", "Hal"]);
});

test("a name on two guilds stays with the newest guild; the older guild still migrates", async () => {
  guilds = [
    { id: 1, leader: "alice", members: "alice, bob, carol" },
    { id: 2, leader: "dave", members: "dave, Bob" },
  ];
  expect(await migrateGuildRanks(ask, runAll)).toBe(2);
  expect(members.find((row) => row.username.toLowerCase() === "bob")).toEqual({ username: "Bob", guild_id: 2, rank_index: 4 });
  expect(members.filter((row) => row.guild_id === 1).map((row) => row.username)).toEqual(["alice", "carol"]);
  expect(ranks.filter((row) => row.guild_id === 1)).toHaveLength(DEFAULT_RANKS.length);
  expect(ranks.filter((row) => row.guild_id === 2)).toHaveLength(DEFAULT_RANKS.length);
});

test("a guild that has rank rows from an earlier partial run is not inserted again", async () => {
  ranks = DEFAULT_RANKS.map((rank) => ({ guild_id: 1, rank_index: rank.index, name: rank.name, permissions: rank.permissions }));
  expect(await migrateGuildRanks(ask, runAll)).toBe(1);
  expect(ranks.filter((row) => row.guild_id === 1)).toHaveLength(DEFAULT_RANKS.length);
  expect(members.filter((row) => row.guild_id === 1)).toEqual([]);
  expect(members.filter((row) => row.guild_id === 2)).toEqual([{ username: "dave", guild_id: 2, rank_index: 0 }]);
});

test("a leader who is also on their own list is not warned about", async () => {
  guilds = [{ id: 5, leader: "alice", members: "alice, bob" }];
  const warned = spyOn(log, "warn").mockImplementation(() => {});
  try {
    await migrateGuildRanks(ask, runAll);
    expect(warned).not.toHaveBeenCalled();
  } finally {
    warned.mockRestore();
  }
  expect(members).toEqual([
    { username: "alice", guild_id: 5, rank_index: 0 },
    { username: "bob", guild_id: 5, rank_index: 4 },
  ]);
});

test("a name on two guilds is still warned about", async () => {
  guilds = [
    { id: 1, leader: "alice", members: "alice, bob" },
    { id: 2, leader: "dave", members: "dave, bob" },
  ];
  const warned = spyOn(log, "warn").mockImplementation(() => {});
  try {
    await migrateGuildRanks(ask, runAll);
    expect(warned).toHaveBeenCalledTimes(1);
  } finally {
    warned.mockRestore();
  }
});

test("a name already in guild_members from before is skipped", async () => {
  members = [{ username: "Bob", guild_id: 9, rank_index: 1 }];
  await migrateGuildRanks(ask, runAll);
  expect(members.filter((row) => row.username.toLowerCase() === "bob")).toEqual([{ username: "Bob", guild_id: 9, rank_index: 1 }]);
  expect(members.filter((row) => row.guild_id === 1).map((row) => row.username)).toEqual(["alice", "carol"]);
});
