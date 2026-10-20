import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// ------------------------------------------------------------ fake database
// The statements the guild system sends, run against in-memory tables. A
// statement it does not know is an error, so a read that is not the load of
// a whole table fails the test that made it.

type Row = Record<string, any>;
let guildsTable: Row[];
let ranksTable: Row[];
let membersTable: Row[];
let accountsTable: Row[];
let nextGuildId: number;
/** Every statement sent, with its values, in order. */
let queries: Array<[string, any[]]>;
/** A statement matching this is not answered: the connection is lost. */
let failing: RegExp | null;
/** The statement that was not answered was still made, as one that timed out can have been. Otherwise it was refused. */
let lostAfterWriting: boolean;
/** Whether an INSERT reports the id it gave the row. */
let reportsInsertId: boolean;

const LOAD_GUILDS = "SELECT id, name, leader, motd FROM guilds";
const LOAD_RANKS = "SELECT guild_id, rank_index, name, permissions FROM guild_ranks";
const LOAD_MEMBERS = "SELECT username, guild_id, rank_index, public_note, officer_note FROM guild_members";
const LOADS = [LOAD_GUILDS, LOAD_RANKS, LOAD_MEMBERS];

const lower = (value: any) => String(value ?? "").toLowerCase();
const accountOf = (username: string) => accountsTable.find((row) => row.username === lower(username));
const guildNamed = (name: string) => guildsTable.find((row) => row.name === name);

async function database(sql: string, params: any[] = []): Promise<any> {
  queries.push([sql, params]);
  const lost = !!failing?.test(sql);
  if (lost && !lostAfterWriting) throw new Error("connection lost");
  const answer = run(sql, params);
  if (lost) throw new Error("connection lost");
  return answer;
}

function run(sql: string, params: any[]): any {
  switch (sql) {
    case LOAD_GUILDS: return guildsTable.map((row) => ({ ...row }));
    case LOAD_RANKS: return ranksTable.map((row) => ({ ...row }));
    case LOAD_MEMBERS: return membersTable.map((row) => ({ ...row }));
    case "INSERT INTO guilds (leader, name, motd) VALUES (?, ?, '')": {
      const id = nextGuildId++;
      guildsTable.push({ id, name: params[1], leader: params[0], motd: "" });
      return reportsInsertId ? { lastInsertRowid: id, affectedRows: 1 } : { affectedRows: 1 };
    }
    case "INSERT INTO guild_ranks (guild_id, rank_index, name, permissions) SELECT id, ?, ?, ? FROM guilds WHERE name = ?": {
      const guild = guildNamed(params[3]);
      if (guild) ranksTable.push({ guild_id: guild.id, rank_index: params[0], name: params[1], permissions: params[2] });
      return { affectedRows: guild ? 1 : 0 };
    }
    case "INSERT INTO guild_ranks (guild_id, rank_index, name, permissions) VALUES (?, ?, ?, ?)":
      ranksTable.push({ guild_id: params[0], rank_index: params[1], name: params[2], permissions: params[3] });
      return { affectedRows: 1 };
    case "INSERT INTO guild_members (username, guild_id, rank_index, public_note, officer_note) SELECT ?, id, 0, '', '' FROM guilds WHERE name = ?": {
      const guild = guildNamed(params[1]);
      if (guild) membersTable.push({ username: params[0], guild_id: guild.id, rank_index: 0, public_note: "", officer_note: "" });
      return { affectedRows: guild ? 1 : 0 };
    }
    case "INSERT INTO guild_members (username, guild_id, rank_index, public_note, officer_note) VALUES (?, ?, ?, '', '')":
      if (membersTable.some((row) => lower(row.username) === lower(params[0]))) throw new Error("duplicate key");
      membersTable.push({ username: params[0], guild_id: params[1], rank_index: params[2], public_note: "", officer_note: "" });
      return { affectedRows: 1 };
    case "UPDATE accounts SET guild_id = (SELECT id FROM guilds WHERE name = ?) WHERE username = ?": {
      const row = accountOf(params[1]);
      if (row) row.guild_id = guildNamed(params[0])?.id ?? null;
      return { affectedRows: row ? 1 : 0 };
    }
    case "UPDATE accounts SET guild_id = ? WHERE username = ?": {
      const row = accountOf(params[1]);
      if (row) row.guild_id = params[0];
      return { affectedRows: 1 };
    }
    case "UPDATE accounts SET guild_id = NULL WHERE username = ?": {
      const row = accountOf(params[0]);
      if (row) row.guild_id = null;
      return { affectedRows: 1 };
    }
    case "UPDATE accounts SET guild_id = NULL WHERE guild_id = ?":
      for (const row of accountsTable) if (row.guild_id === params[0]) row.guild_id = null;
      return { affectedRows: 1 };
    case "DELETE FROM guild_members WHERE username = ?":
      membersTable = membersTable.filter((row) => lower(row.username) !== lower(params[0]));
      return { affectedRows: 1 };
    case "DELETE FROM guild_members WHERE guild_id = ?":
      membersTable = membersTable.filter((row) => row.guild_id !== params[0]);
      return { affectedRows: 1 };
    case "DELETE FROM guild_ranks WHERE guild_id = ?":
      ranksTable = ranksTable.filter((row) => row.guild_id !== params[0]);
      return { affectedRows: 1 };
    case "DELETE FROM guild_ranks WHERE guild_id = ? AND rank_index = ?":
      ranksTable = ranksTable.filter((row) => !(row.guild_id === params[0] && row.rank_index === params[1]));
      return { affectedRows: 1 };
    case "DELETE FROM guilds WHERE id = ?":
      guildsTable = guildsTable.filter((row) => row.id !== params[0]);
      return { affectedRows: 1 };
    case "UPDATE guilds SET leader = ? WHERE id = ?":
      for (const row of guildsTable) if (row.id === params[1]) row.leader = params[0];
      return { affectedRows: 1 };
    case "UPDATE guilds SET motd = ? WHERE id = ?":
      for (const row of guildsTable) if (row.id === params[1]) row.motd = params[0];
      return { affectedRows: 1 };
    case "UPDATE guild_members SET rank_index = ? WHERE username = ?":
      for (const row of membersTable) if (lower(row.username) === lower(params[1])) row.rank_index = params[0];
      return { affectedRows: 1 };
    case "UPDATE guild_members SET public_note = ? WHERE username = ?":
      for (const row of membersTable) if (lower(row.username) === lower(params[1])) row.public_note = params[0];
      return { affectedRows: 1 };
    case "UPDATE guild_members SET officer_note = ? WHERE username = ?":
      for (const row of membersTable) if (lower(row.username) === lower(params[1])) row.officer_note = params[0];
      return { affectedRows: 1 };
    case "UPDATE guild_ranks SET name = ?, permissions = ? WHERE guild_id = ? AND rank_index = ?":
      for (const row of ranksTable) if (row.guild_id === params[2] && row.rank_index === params[3]) Object.assign(row, { name: params[0], permissions: params[1] });
      return { affectedRows: 1 };
  }
  throw new Error(`The fake database does not understand: ${sql}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({ default: database }));

const datacache = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
const { default: guilds } = await import("../systems/guild");
const { DEFAULT_RANKS, GuildPermission, ALL_PERMISSIONS } = await import("../systems/guildranks");

const ranksFor = (guild_id: number) => DEFAULT_RANKS.map((rank) => ({ guild_id, rank_index: rank.index, name: rank.name, permissions: rank.permissions }));
const member = (username: string, guild_id: number, rank_index: number) => ({ username, guild_id, rank_index, public_note: "", officer_note: "" });

const reads = () => queries.map(([sql]) => sql).filter((sql) => sql.startsWith("SELECT"));
const writes = () => queries.filter(([sql]) => !sql.startsWith("SELECT"));
/** Every read was the load of a whole table, and no table was loaded twice. */
const eachTableReadOnce = () => {
  expect(reads().every((sql) => LOADS.includes(sql))).toBe(true);
  expect(new Set(reads()).size).toBe(reads().length);
};
/** The accounts another system caches, that it was told to read again. */
const accountsDropped = () => dropRows.mock.calls.filter(([name]: any[]) => name === "accounts").map(([, key]: any[]) => key);
/** The guilds the fake database holds, as `list` answers them. */
const inDatabase = () => guildsTable
  .map((row) => ({
    id: row.id, name: row.name, leader: row.leader,
    members: membersTable.filter((m) => m.guild_id === row.id).sort((a, b) => a.rank_index - b.rank_index || lower(a.username).localeCompare(lower(b.username))).map((m) => m.username),
  }))
  .sort((a, b) => lower(a.name).localeCompare(lower(b.name)));

let dropRows: ReturnType<typeof spyOn>;
let logged: Array<ReturnType<typeof spyOn>>;
beforeAll(() => {
  dropRows = spyOn(datacache, "dropRows");
  logged = [spyOn(log, "info"), spyOn(log, "warn"), spyOn(log, "error")].map((spy) => spy.mockImplementation(() => {}));
});
afterAll(() => {
  dropRows.mockRestore();
  for (const spy of logged) spy.mockRestore();
});

beforeEach(async () => {
  guildsTable = [
    { id: 1, name: "Dragon Slayers", leader: "user1", motd: "" },
    { id: 2, name: "Shadow Guild", leader: "user3", motd: "" },
  ];
  ranksTable = [...ranksFor(1), ...ranksFor(2)];
  membersTable = [member("user1", 1, 0), member("user2", 1, 4), member("user3", 2, 0)];
  accountsTable = [
    { username: "user1", guild_id: 1 }, { username: "user2", guild_id: 1 }, { username: "user3", guild_id: 2 },
    { username: "user4", guild_id: null }, { username: "user5", guild_id: null },
  ];
  nextGuildId = 3;
  queries = [];
  failing = null;
  lostAfterWriting = false;
  reportsInsertId = true;
  await datacache.clearCaches();
  dropRows.mockClear();
});

// ------------------------------------------------- one read of the table

const questions: Array<[string, () => Promise<unknown>, unknown]> = [
  ["isInGuild", () => guilds.isInGuild("user2"), true],
  ["isGuildLeader", () => guilds.isGuildLeader("user1"), true],
  ["getGuildId", () => guilds.getGuildId("user2"), 1],
  ["getGuildName", () => guilds.getGuildName(1), "Dragon Slayers"],
  ["getGuildMembers", () => guilds.getGuildMembers(1), ["user1", "user2"]],
  ["getGuildLeader", () => guilds.getGuildLeader(1), "user1"],
  ["exists", () => guilds.exists("Shadow Guild"), true],
  ["list", () => guilds.list(), [
    { id: 1, name: "Dragon Slayers", leader: "user1", members: ["user1", "user2"] },
    { id: 2, name: "Shadow Guild", leader: "user3", members: ["user3"] },
  ]],
];

describe("a guild question is answered from the table, read once", () => {
  test.each(questions)("%s: asked again, the database is not", async (_name, ask, answer) => {
    expect(await ask()).toEqual(answer);
    expect(await ask()).toEqual(answer);
    eachTableReadOnce();
  });

  test("every question together costs that one read", async () => {
    for (const [, ask, answer] of questions) expect(await ask()).toEqual(answer);
    eachTableReadOnce();
  });

  test("names match in any case, as the database matched them", async () => {
    expect(await guilds.isInGuild("USER2")).toBe(true);
    expect(await guilds.getGuildId("User2")).toBe(1);
    expect(await guilds.isGuildLeader("USER3")).toBe(true);
    expect(await guilds.exists("shadow guild")).toBe(true);
  });

  test("who is in a guild is who guild_members names", async () => {
    // An account pointing at a guild guild_members does not put it in, and a member row for an account that points nowhere.
    accountOf("user4")!.guild_id = 1;
    accountOf("user2")!.guild_id = null;
    expect(await guilds.isInGuild("user4")).toBe(false);
    expect(await guilds.getGuildId("user4")).toBeNull();
    expect(await guilds.isInGuild("user2")).toBe(true);
    expect(await guilds.getGuildId("user2")).toBe(1);
    // Someone guild_members does not name, and someone the database has never heard of.
    expect(await guilds.isInGuild("user5")).toBe(false);
    expect(await guilds.isInGuild("nobody")).toBe(false);
    expect(await guilds.isInGuild("")).toBe(false);
    expect(await guilds.getGuildId("")).toBeNull();
  });

  test("a guild that is not there has no name, leader or members", async () => {
    expect(await guilds.getGuildName(9)).toBeNull();
    expect(await guilds.getGuildLeader(9)).toBeNull();
    expect(await guilds.getGuildMembers(9)).toEqual([]);
    expect(await guilds.getGuildName(0)).toBeNull();
    // An id that arrived as text finds the same guild.
    expect(await guilds.getGuildName("2" as any)).toBe("Shadow Guild");
    eachTableReadOnce();
  });

  test("the list is in name order whatever order the table gave", async () => {
    guildsTable.push({ id: 3, name: "alpha Wolves", leader: "user9", motd: "" });
    ranksTable.push(...ranksFor(3));
    membersTable.push(member("user9", 3, 0));
    expect((await guilds.list()).map((guild) => guild.name)).toEqual(["alpha Wolves", "Dragon Slayers", "Shadow Guild"]);
  });

  test("an answer is a copy: changing it changes nothing held", async () => {
    (await guilds.getGuildMembers(1)).push("intruder");
    const listed = await guilds.list();
    listed[0].leader = "intruder";
    listed[0].members.length = 0;
    expect(await guilds.getGuildMembers(1)).toEqual(["user1", "user2"]);
    expect(await guilds.list()).toEqual(questions[7][2] as any);
  });

  test("no guilds at all is an empty list, not asked for twice", async () => {
    guildsTable = [];
    ranksTable = [];
    membersTable = [];
    expect(await guilds.list()).toEqual([]);
    expect(await guilds.exists("Dragon Slayers")).toBe(false);
    expect(await guilds.isGuildLeader("user1")).toBe(false);
    eachTableReadOnce();
  });
});

describe("ranks, members and the message of the day are answered from the tables", () => {
  test("getRanks answers a guild's ranks in rank order", async () => {
    ranksTable.reverse();
    expect(await guilds.getRanks(1)).toEqual(DEFAULT_RANKS);
    expect(await guilds.getRanks(9)).toEqual([]);
    expect(await guilds.getRanks(0)).toEqual([]);
  });

  test("getMember answers the member row, in any case", async () => {
    membersTable[1].public_note = "healer";
    expect(await guilds.getMember("USER2")).toEqual({ username: "user2", guild_id: 1, rank_index: 4, public_note: "healer", officer_note: "" });
    expect(await guilds.getMember("user4")).toBeNull();
    expect(await guilds.getMember("")).toBeNull();
  });

  test("getMotd answers the guild's message, empty when there is none", async () => {
    guildsTable[0].motd = "Raid at eight";
    guildsTable[1].motd = null;
    expect(await guilds.getMotd(1)).toBe("Raid at eight");
    expect(await guilds.getMotd(2)).toBe("");
    expect(await guilds.getMotd(9)).toBe("");
  });

  test("can answers from the member's rank, and rank 0 can do everything", async () => {
    ranksTable.find((row) => row.guild_id === 1 && row.rank_index === 0)!.permissions = 0;
    expect(await guilds.can("user1", ALL_PERMISSIONS)).toBe(true);
    expect(await guilds.can("user2", GuildPermission.GUILD_CHAT_SPEAK)).toBe(true);
    expect(await guilds.can("user2", GuildPermission.INVITE)).toBe(false);
    expect(await guilds.can("user4", GuildPermission.GUILD_CHAT_LISTEN)).toBe(false);
  });

  test("listeners are the members whose rank has the permission, in roster order", async () => {
    membersTable.push(member("user4", 1, 1), member("user5", 1, 3));
    expect(await guilds.listeners(1, GuildPermission.OFFICER_CHAT_LISTEN)).toEqual(["user1", "user4"]);
    expect(await guilds.listeners(1, GuildPermission.GUILD_CHAT_LISTEN)).toEqual(["user1", "user4", "user5", "user2"]);
    expect(await guilds.listeners(9, GuildPermission.GUILD_CHAT_LISTEN)).toEqual([]);
  });
});

// ------------------------------------------- changes: database, then table

describe("a guild change is written to the database, then to the table held", () => {
  test("setLeader puts the new leader first", async () => {
    expect(await guilds.setLeader(1, "user2")).toEqual(["user2", "user1"]);
    expect(writes()).toEqual([
      ["UPDATE guilds SET leader = ? WHERE id = ?", ["user2", 1]],
      ["UPDATE guild_members SET rank_index = ? WHERE username = ?", [0, "user2"]],
      ["UPDATE guild_members SET rank_index = ? WHERE username = ?", [1, "user1"]],
    ]);
    expect(membersTable.find((row) => row.username === "user2")!.rank_index).toBe(0);
    expect(membersTable.find((row) => row.username === "user1")!.rank_index).toBe(1);
    expect(guildsTable[0].leader).toBe("user2");

    expect(await guilds.getGuildLeader(1)).toBe("user2");
    expect(await guilds.getGuildMembers(1)).toEqual(["user2", "user1"]);
    expect(await guilds.isGuildLeader("user2")).toBe(true);
    expect(await guilds.isGuildLeader("user1")).toBe(false);
    eachTableReadOnce();
  });

  test("setLeader refuses someone who is not a member, and a guild that is not there", async () => {
    expect(await guilds.setLeader(1, "user4")).toEqual([]);
    expect(await guilds.setLeader(9, "user1")).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("add puts the account and the member list in step", async () => {
    expect(await guilds.add("user4", 1)).toEqual(["user1", "user2", "user4"]);
    expect(writes()).toEqual([
      ["UPDATE accounts SET guild_id = ? WHERE username = ?", [1, "user4"]],
      ["INSERT INTO guild_members (username, guild_id, rank_index, public_note, officer_note) VALUES (?, ?, ?, '', '')", ["user4", 1, 4]],
    ]);
    expect(membersTable.find((row) => row.username === "user4")!.rank_index).toBe(4);
    expect(accountsDropped()).toEqual(["user4"]);

    expect(await guilds.getGuildMembers(1)).toEqual(["user1", "user2", "user4"]);
    expect(await guilds.getGuildId("user4")).toBe(1);
    expect(await guilds.isInGuild("user4")).toBe(true);
    eachTableReadOnce();
  });

  test("add refuses a member of any guild, a full guild and a guild that is not there", async () => {
    expect(await guilds.add("user3", 1)).toEqual([]);
    expect(await guilds.add("USER3", 1)).toEqual([]);
    expect(await guilds.add("user4", 9)).toEqual([]);
    expect(await guilds.add("", 1)).toEqual([]);
    membersTable.push(...Array.from({ length: 999 }, (_, i) => member(`member${i}`, 2, 4)));
    await datacache.clearCaches();
    expect(await guilds.add("user4", 2)).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("remove takes the member off the account and the list", async () => {
    expect(await guilds.remove("user2")).toEqual(["user1"]);
    expect(writes()).toEqual([
      ["UPDATE accounts SET guild_id = NULL WHERE username = ?", ["user2"]],
      ["DELETE FROM guild_members WHERE username = ?", ["user2"]],
    ]);
    expect(accountsDropped()).toEqual(["user2"]);

    expect(await guilds.isInGuild("user2")).toBe(false);
    expect(await guilds.getGuildId("user2")).toBeNull();
    expect(await guilds.getGuildMembers(1)).toEqual(["user1"]);
    eachTableReadOnce();
  });

  test("remove finds the member whatever case the name came in, as the account was found", async () => {
    expect(await guilds.remove("USER2")).toEqual(["user1"]);
    expect(await guilds.isInGuild("user2")).toBe(false);
    expect(membersTable.filter((row) => row.guild_id === 1).map((row) => row.username)).toEqual(["user1"]);
  });

  test("remove of someone in no guild writes nothing", async () => {
    expect(await guilds.remove("user4")).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("delete takes the guild out and frees its members' accounts", async () => {
    expect(await guilds.delete(1)).toBe(true);
    expect(writes()).toEqual([
      ["DELETE FROM guild_members WHERE guild_id = ?", [1]],
      ["DELETE FROM guild_ranks WHERE guild_id = ?", [1]],
      ["DELETE FROM guilds WHERE id = ?", [1]],
      ["UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", [1]],
    ]);
    expect(accountsDropped().sort()).toEqual(["user1", "user2"]);
    expect(ranksTable.filter((row) => row.guild_id === 1)).toEqual([]);
    expect(membersTable.filter((row) => row.guild_id === 1)).toEqual([]);

    expect(await guilds.getGuildName(1)).toBeNull();
    expect(await guilds.exists("Dragon Slayers")).toBe(false);
    expect(await guilds.isInGuild("user2")).toBe(false);
    expect(await guilds.isGuildLeader("user1")).toBe(false);
    expect((await guilds.list()).map((guild) => guild.id)).toEqual([2]);
    eachTableReadOnce();
  });

  test("leave is a removal, refused to the leader and to someone in no guild", async () => {
    expect(await guilds.leave("user1")).toBe(false);
    expect(await guilds.leave("user4")).toBe(false);
    expect(writes()).toEqual([]);

    expect(await guilds.leave("user2")).toEqual(["user1"]);
    expect(writes().map(([sql]) => sql)).toEqual([
      "UPDATE accounts SET guild_id = NULL WHERE username = ?",
      "DELETE FROM guild_members WHERE username = ?",
    ]);
    expect(await guilds.isInGuild("user2")).toBe(false);
    eachTableReadOnce();
  });

  test("disband by the leader ends the guild", async () => {
    expect(await guilds.disband("user1")).toBe(true);
    expect(writes()).toEqual([
      ["DELETE FROM guild_members WHERE guild_id = ?", [1]],
      ["DELETE FROM guild_ranks WHERE guild_id = ?", [1]],
      ["DELETE FROM guilds WHERE id = ?", [1]],
      ["UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", [1]],
    ]);
    expect([...new Set(accountsDropped())].sort()).toEqual(["user1", "user2"]);

    expect(await guilds.isInGuild("user1")).toBe(false);
    expect(await guilds.isInGuild("user2")).toBe(false);
    expect(await guilds.isGuildLeader("user1")).toBe(false);
    expect(await guilds.getGuildMembers(1)).toEqual([]);
    eachTableReadOnce();
  });

  test("disband is refused to a member who does not lead, and to someone in no guild", async () => {
    expect(await guilds.disband("user2")).toBe(false);
    expect(await guilds.disband("user4")).toBe(false);
    expect(writes()).toEqual([]);
  });

  test("create makes the guild with its founder as leader and only member", async () => {
    expect(await guilds.create("user4", "  New Guild  ")).toEqual(["user4"]);
    expect(writes()).toEqual([
      ["INSERT INTO guilds (leader, name, motd) VALUES (?, ?, '')", ["user4", "New Guild"]],
      ...DEFAULT_RANKS.map((rank): [string, any[]] => [
        "INSERT INTO guild_ranks (guild_id, rank_index, name, permissions) SELECT id, ?, ?, ? FROM guilds WHERE name = ?",
        [rank.index, rank.name, rank.permissions, "New Guild"],
      ]),
      ["INSERT INTO guild_members (username, guild_id, rank_index, public_note, officer_note) SELECT ?, id, 0, '', '' FROM guilds WHERE name = ?", ["user4", "New Guild"]],
      ["UPDATE accounts SET guild_id = (SELECT id FROM guilds WHERE name = ?) WHERE username = ?", ["New Guild", "user4"]],
    ]);
    expect(accountsDropped()).toEqual(["user4"]);
    expect(ranksTable.filter((r) => r.guild_id === 3).map((r) => r.name)).toEqual(DEFAULT_RANKS.map((rank) => rank.name));
    expect(membersTable.find((row) => row.username === "user4")).toEqual(member("user4", 3, 0));
    expect(accountOf("user4")!.guild_id).toBe(3);

    expect(await guilds.getGuildId("user4")).toBe(3);
    expect(await guilds.getGuildName(3)).toBe("New Guild");
    expect(await guilds.getGuildLeader(3)).toBe("user4");
    expect(await guilds.getGuildMembers(3)).toEqual(["user4"]);
    expect(await guilds.getRanks(3)).toEqual(DEFAULT_RANKS);
    expect(await guilds.isGuildLeader("user4")).toBe(true);
    expect(await guilds.exists("new guild")).toBe(true);
    eachTableReadOnce();
  });

  test("create is refused for a taken name or a founder already in a guild, with nothing written", async () => {
    expect(await guilds.create("user4", "dragon slayers")).toBe(false);
    expect(await guilds.create("user2", "New Guild")).toBe(false);
    expect(await guilds.create("user4", "")).toBe(false);
    expect(await guilds.create("", "New Guild")).toBe(false);
    expect(writes()).toEqual([]);
  });

  test("create reads the table again when the database does not say which id it gave", async () => {
    reportsInsertId = false;
    expect(await guilds.create("user4", "New Guild")).toEqual(["user4"]);
    // All three tables, read again after the writes.
    expect(queries.slice(-3).map(([sql]) => sql)).toEqual(LOADS);
    const read = reads().length;
    expect(await guilds.getGuildId("user4")).toBe(3);
    expect(await guilds.getGuildName(3)).toBe("New Guild");
    expect(await guilds.getRanks(3)).toEqual(DEFAULT_RANKS);
    expect(reads().length).toBe(read);
  });
});

// --------------------------------- a write the database does not answer

// Each write, the statement of it that is not answered, what the write then
// answers, and the accounts the player system must be told to read again.
const unanswered: Array<[string, RegExp, () => Promise<unknown>, unknown, string[]]> = [
  ["setLeader", /^UPDATE guilds/, () => guilds.setLeader(1, "user2"), [], []],
  ["add (the account)", /^UPDATE accounts/, () => guilds.add("user4", 1), [], ["user4"]],
  ["add (the member list)", /^INSERT INTO guild_members/, () => guilds.add("user4", 1), [], ["user4"]],
  ["remove (the account)", /^UPDATE accounts/, () => guilds.remove("user2"), [], ["user2"]],
  ["remove (the member list)", /^DELETE FROM guild_members/, () => guilds.remove("user2"), [], ["user2"]],
  ["delete (the guild)", /^DELETE FROM guilds/, () => guilds.delete(1), false, ["user1", "user2"]],
  ["delete (the accounts)", /^UPDATE accounts/, () => guilds.delete(1), false, ["user1", "user2"]],
  ["leave", /^DELETE FROM guild_members/, () => guilds.leave("user2"), [], ["user2"]],
  ["disband (the accounts)", /^UPDATE accounts/, () => guilds.disband("user1"), false, ["user1", "user2"]],
  ["disband (the guild)", /^DELETE FROM guilds/, () => guilds.disband("user1"), false, ["user1", "user2"]],
  ["create (the guild)", /^INSERT INTO guilds/, () => guilds.create("user4", "New Guild"), false, ["user4"]],
  ["create (the account)", /^UPDATE accounts/, () => guilds.create("user4", "New Guild"), false, ["user4"]],
];

// A statement that timed out may still have been applied, so after either
// kind of failure the tables are read again rather than trusted.
for (const made of [false, true]) {
  describe(`a guild write the database ${made ? "made but never answered" : "refused"}`, () => {
    test.each(unanswered)("%s: the tables are read again, so what is held is what the database holds", async (_name, statement, write, answer, accounts) => {
      await guilds.list();
      lostAfterWriting = made;
      failing = statement;
      expect(await write()).toEqual(answer);
      failing = null;

      expect(queries.slice(-3).map(([sql]) => sql)).toEqual(LOADS);
      expect([...new Set(accountsDropped())].sort()).toEqual(accounts);
      const read = reads().length;
      expect(await guilds.list()).toEqual(inDatabase());
      expect(reads().length).toBe(read);
    });
  });
}

test("a write that was made but never answered is what the next read answers", async () => {
  await guilds.list();
  lostAfterWriting = true;

  failing = /^INSERT INTO guild_members/;
  expect(await guilds.add("user4", 1)).toEqual([]);
  expect(await guilds.getGuildMembers(1)).toEqual(["user1", "user2", "user4"]);
  expect(await guilds.getGuildId("user4")).toBe(1);

  failing = /^UPDATE guilds/;
  expect(await guilds.setLeader(1, "user2")).toEqual([]);
  expect(await guilds.getGuildLeader(1)).toBe("user2");

  failing = /^DELETE FROM guilds/;
  expect(await guilds.delete(2)).toBe(false);
  expect(await guilds.getGuildName(2)).toBeNull();
  expect(await guilds.isInGuild("user3")).toBe(false);

  failing = /^INSERT INTO guilds/;
  expect(await guilds.create("user5", "New Guild")).toBe(false);
  expect(await guilds.exists("New Guild")).toBe(true);
  expect(await guilds.getGuildLeader(3)).toBe("user5");
});

test("when the table cannot be read again either, the write still answers that it failed", async () => {
  await guilds.list();
  await guilds.getRanks(1);
  failing = /^INSERT INTO guild_members|^SELECT/;
  expect(await guilds.add("user4", 1)).toEqual([]);
  failing = null;
  expect(writes().map(([sql]) => sql)).toContain("INSERT INTO guild_members (username, guild_id, rank_index, public_note, officer_note) VALUES (?, ?, ?, '', '')");
  expect(queries.slice(-3).map(([sql]) => sql)).toEqual(LOADS);
});

// ------------------------------------------------------------- behaviour

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

describe("rank actions", () => {
  beforeEach(() => {
    // Dragon Slayers: user1 GM (0), user6 Officer (1), user7 Veteran (2), user2 Initiate (4).
    membersTable.push(member("user6", 1, 1), member("user7", 1, 2));
    accountsTable.push({ username: "user6", guild_id: 1 }, { username: "user7", guild_id: 1 });
  });
  const rankOf = (username: string) => membersTable.find((row) => row.username === username)?.rank_index;

  test("an officer promotes a lower member one rank, not to their own", async () => {
    expect(await guilds.promote("user6", "user2")).toEqual({ ok: true });
    expect(rankOf("user2")).toBe(3);
    expect(await guilds.promote("user6", "user2")).toEqual({ ok: true });
    expect(rankOf("user2")).toBe(2);
    expect(await guilds.promote("user6", "user2")).toEqual({ ok: false, reason: "promote_ceiling" });
    expect(rankOf("user2")).toBe(2);
  });
  test("nobody acts on an equal or higher rank", async () => {
    expect(await guilds.promote("user6", "user1")).toEqual({ ok: false, reason: "not_below" });
    expect(await guilds.demote("user6", "user1")).toEqual({ ok: false, reason: "not_below" });
    expect(await guilds.kick("user7", "user6")).toEqual({ ok: false, reason: "no_permission" });
  });
  test("a rank without the bit is refused", async () => {
    expect(await guilds.promote("user7", "user2")).toEqual({ ok: false, reason: "no_permission" });
    expect(await guilds.setMotd("user2", "hi")).toEqual({ ok: false, reason: "no_permission" });
  });
  test("demote stops at the lowest rank", async () => {
    expect(await guilds.demote("user1", "user2")).toEqual({ ok: false, reason: "demote_floor" });
    expect(await guilds.demote("user1", "user7")).toEqual({ ok: true });
    expect(rankOf("user7")).toBe(3);
  });
  test("a player in another guild is not a member", async () => {
    expect(await guilds.promote("user1", "user3")).toEqual({ ok: false, reason: "not_member" });
    expect(await guilds.promote("user4", "user2")).toEqual({ ok: false, reason: "not_in_guild" });
  });
  test("kick removes the member and answers who is left", async () => {
    const result = await guilds.kick("user6", "user2");
    expect(result.ok).toBe(true);
    expect((result as any).members).toEqual(["user1", "user6", "user7"]);
    expect(accountOf("user2")!.guild_id).toBeNull();
    expect(await guilds.kick("user6", "user6")).toEqual({ ok: false, reason: "self" });
  });
  test("MOTD is set by a rank with the bit, capped at 128", async () => {
    expect(await guilds.setMotd("user6", "  Raid at eight  ")).toEqual({ ok: true });
    expect(guildsTable[0].motd).toBe("Raid at eight");
    expect(await guilds.getMotd(1)).toBe("Raid at eight");
    expect(await guilds.setMotd("user6", "x".repeat(129))).toEqual({ ok: false, reason: "bad_text" });
  });
  test("everyone edits their own public note; others need the bit and a lower target", async () => {
    expect(await guilds.setNote("user2", "user2", "Alt of user9", false)).toEqual({ ok: true });
    expect(await guilds.setNote("user2", "user7", "nope", false)).toEqual({ ok: false, reason: "no_permission" });
    expect(await guilds.setNote("user6", "user7", "Tank", false)).toEqual({ ok: true });
    expect(membersTable.find((row) => row.username === "user7")!.public_note).toBe("Tank");
  });
  test("officer notes need the edit bit, even for one's own", async () => {
    expect(await guilds.setNote("user2", "user2", "x", true)).toEqual({ ok: false, reason: "no_permission" });
    expect(await guilds.setNote("user6", "user2", "Late often", true)).toEqual({ ok: true });
    expect(membersTable.find((row) => row.username === "user2")!.officer_note).toBe("Late often");
  });
  test("only the Guild Master edits ranks", async () => {
    expect(await guilds.addRank("user6", "Raider")).toEqual({ ok: false, reason: "no_permission" });
    expect(await guilds.addRank("user1", "Raider")).toEqual({ ok: true });
    expect((await guilds.getRanks(1)).map((rank) => rank.name)).toEqual(["Guild Master", "Officer", "Veteran", "Member", "Initiate", "Raider"]);
  });
  test("new members join the new lowest rank", async () => {
    await guilds.addRank("user1", "Raider");
    await guilds.add("user4", 1);
    expect(rankOf("user4")).toBe(5);
  });
  test("rank limits: at most 8, at least 2, delete only an empty lowest rank", async () => {
    for (const name of ["A", "B", "C"]) expect(await guilds.addRank("user1", name)).toEqual({ ok: true });
    expect(await guilds.addRank("user1", "D")).toEqual({ ok: false, reason: "max_ranks" });
    for (let i = 0; i < 3; i++) expect(await guilds.deleteRank("user1")).toEqual({ ok: true });
    expect(await guilds.deleteRank("user1")).toEqual({ ok: false, reason: "rank_in_use" }); // user2 is Initiate
    await guilds.promote("user1", "user2");
    expect(await guilds.deleteRank("user1")).toEqual({ ok: true }); // ranks 0 to 3 left, user2 at 3
    await guilds.kick("user1", "user2");
    await guilds.kick("user1", "user7");
    expect(await guilds.deleteRank("user1")).toEqual({ ok: true }); // 0 to 2
    expect(await guilds.deleteRank("user1")).toEqual({ ok: true }); // 0 and 1, user6 at 1
    expect(await guilds.deleteRank("user1")).toEqual({ ok: false, reason: "min_ranks" });
  });
  test("rank names are checked; rank 0 permissions cannot change", async () => {
    expect(await guilds.addRank("user1", "Rank 2")).toEqual({ ok: false, reason: "bad_name" });
    expect(await guilds.editRank("user1", 0, { permissions: 0 })).toEqual({ ok: false, reason: "rank_zero" });
    expect(await guilds.editRank("user1", 0, { name: "Chief" })).toEqual({ ok: true });
    expect(await guilds.editRank("user1", 3, { permissions: GuildPermission.GUILD_CHAT_LISTEN })).toEqual({ ok: true });
    expect((await guilds.getRanks(1))[3].permissions).toBe(GuildPermission.GUILD_CHAT_LISTEN);
    expect(await guilds.editRank("user1", 9, { name: "Ghost" })).toEqual({ ok: false, reason: "no_rank" });
  });
  test("permissions outside the 12 bits are dropped", async () => {
    await guilds.editRank("user1", 3, { permissions: 0xffffff });
    expect((await guilds.getRanks(1))[3].permissions).toBe(ALL_PERMISSIONS);
  });
  test("saving the same MOTD, note or rank again writes nothing and says nothing changed", async () => {
    expect(await guilds.setMotd("user6", "Raid")).toEqual({ ok: true });
    expect(await guilds.setNote("user6", "user7", "Tank", false)).toEqual({ ok: true });
    expect(await guilds.setNote("user6", "user7", "Bench", true)).toEqual({ ok: true });
    expect(await guilds.editRank("user1", 3, { name: "Raider" })).toEqual({ ok: true });
    queries = [];
    const unchanged = { ok: true, changed: false } as const;
    expect(await guilds.setMotd("user6", "  Raid ")).toEqual(unchanged);
    expect(await guilds.setNote("user6", "user7", "Tank", false)).toEqual(unchanged);
    expect(await guilds.setNote("user6", "user7", " Bench", true)).toEqual(unchanged);
    expect(await guilds.setNote("user2", "user2", "", false)).toEqual(unchanged);
    expect(await guilds.editRank("user1", 3, { name: "Raider" })).toEqual(unchanged);
    expect(await guilds.editRank("user1", 3, { permissions: DEFAULT_RANKS[3].permissions })).toEqual(unchanged);
    expect(await guilds.editRank("user1", 3, {})).toEqual(unchanged);
    expect(await guilds.editRank("user1", 0, { name: "Guild Master" })).toEqual(unchanged);
    expect(writes()).toEqual([]);
    // Nothing to change is still checked first.
    expect(await guilds.setMotd("user2", "Raid")).toEqual({ ok: false, reason: "no_permission" });
    expect(await guilds.editRank("user6", 3, { name: "Raider" })).toEqual({ ok: false, reason: "no_permission" });
  });
  test("leader transfer: GM only, new GM rank 0, old GM rank 1", async () => {
    expect(await guilds.transferLeader("user6", "user7")).toEqual({ ok: false, reason: "no_permission" });
    expect(await guilds.transferLeader("user1", "user7")).toEqual({ ok: true });
    expect(rankOf("user7")).toBe(0);
    expect(rankOf("user1")).toBe(1);
    expect(guildsTable[0].leader).toBe("user7");
  });
});

describe("the guild packet", () => {
  beforeEach(() => {
    membersTable.push(member("user6", 1, 1));
    membersTable.find((row) => row.username === "user2")!.officer_note = "secret";
  });
  test("an officer sees officer notes, an initiate does not", async () => {
    const officer = await guilds.packetFor(1, "user6");
    expect(officer.roster.find((row) => row.username === "user2")!.officer_note).toBe("secret");
    expect(officer.my_rank).toBe(1);
    const initiate = await guilds.packetFor(1, "user2");
    expect(initiate.roster.every((row) => !("officer_note" in row))).toBe(true);
    expect(initiate.my_rank).toBe(4);
  });
  test("names, ranks, MOTD and the leader-first member list", async () => {
    const packet = await guilds.packetFor(1, "user1");
    expect(packet.guild_name).toBe("Dragon Slayers");
    expect(packet.members).toEqual(["user1", "user6", "user2"]);
    expect(packet.ranks.length).toBe(5);
    expect(packet.motd).toBe("");
  });
  test("chat listeners are the ranks with the bit", async () => {
    await guilds.editRank("user1", 4, { permissions: 0 });
    expect(await guilds.listeners(1, GuildPermission.GUILD_CHAT_LISTEN)).toEqual(["user1", "user6"]);
    expect(await guilds.listeners(1, GuildPermission.OFFICER_CHAT_LISTEN)).toEqual(["user1", "user6"]);
  });
  test("rank 0 is reported with every permission whatever its row says", async () => {
    ranksTable.find((row) => row.guild_id === 1 && row.rank_index === 0)!.permissions = 1;
    const packet = await guilds.packetFor(1, "user1");
    expect(packet.ranks[0].permissions).toBe(ALL_PERMISSIONS);
  });
  test("the whole packet, as an initiate and as someone outside the guild sees it", async () => {
    guildsTable[0].motd = "Raid";
    const roster = [
      { username: "user1", rank: 0, public_note: "" },
      { username: "user6", rank: 1, public_note: "" },
      { username: "user2", rank: 4, public_note: "" },
    ];
    const base = { guild_name: "Dragon Slayers", members: ["user1", "user6", "user2"], motd: "Raid", ranks: DEFAULT_RANKS, roster };
    expect(await guilds.packetFor(1, "user2")).toEqual({ ...base, my_rank: 4 });
    expect(await guilds.packetFor(1, "user4")).toEqual({ ...base, my_rank: null });
    expect(await guilds.packetFor(1, "USER6")).toEqual({
      ...base, my_rank: 1, roster: roster.map((row) => ({ ...row, officer_note: row.username === "user2" ? "secret" : "" })),
    });
  });
  test("packetsFor gives every viewer the packet packetFor gives them, from one read of the tables", async () => {
    const viewers = ["user1", "user6", "user2", "user4"];
    const packets = await guilds.packetsFor(1, viewers);
    eachTableReadOnce();
    expect([...packets.keys()]).toEqual(viewers);
    for (const viewer of viewers) expect(packets.get(viewer)).toEqual(await guilds.packetFor(1, viewer));
    expect((await guilds.packetsFor(9, ["user1"])).get("user1")!.members).toEqual([]);
  });
});

describe("changes made at the same time, and refusals", () => {
  beforeEach(() => {
    membersTable.push(member("user6", 1, 1), member("user7", 1, 2));
    accountsTable.push({ username: "user6", guild_id: 1 }, { username: "user7", guild_id: 1 });
  });
  const rowOf = (username: string) => membersTable.find((row) => row.username === username);

  test("a promote and a kick of the same member, in either order, leave them out", async () => {
    await Promise.all([guilds.promote("user6", "user2"), guilds.kick("user1", "user2")]);
    expect(await guilds.getGuildMembers(1)).not.toContain("user2");
    expect(rowOf("user2")).toBeUndefined();
    expect(await guilds.getMember("user2")).toBeNull();
  });
  test("a kick and a promote of the same member, in either order, leave them out", async () => {
    await Promise.all([guilds.kick("user1", "user2"), guilds.promote("user6", "user2")]);
    expect(await guilds.getGuildMembers(1)).not.toContain("user2");
    expect(rowOf("user2")).toBeUndefined();
    expect(await guilds.getMember("user2")).toBeNull();
  });
  test("a note and a promote of the same member keep both", async () => {
    const results = await Promise.all([guilds.setNote("user6", "user2", "Tank", false), guilds.promote("user6", "user2")]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(rowOf("user2")!.public_note).toBe("Tank");
    expect(rowOf("user2")!.rank_index).toBe(3);
    expect((await guilds.getMember("user2"))!.public_note).toBe("Tank");
    expect((await guilds.getMember("user2"))!.rank_index).toBe(3);
  });
  test("a promote and a note of the same member keep both", async () => {
    await Promise.all([guilds.promote("user6", "user2"), guilds.setNote("user6", "user2", "Tank", false)]);
    expect(rowOf("user2")!.public_note).toBe("Tank");
    expect(rowOf("user2")!.rank_index).toBe(3);
    expect((await guilds.getMember("user2"))!.public_note).toBe("Tank");
    expect((await guilds.getMember("user2"))!.rank_index).toBe(3);
  });
  test("a MOTD and a leader transfer keep the new leader", async () => {
    await Promise.all([guilds.setMotd("user1", "Raid"), guilds.transferLeader("user1", "user7")]);
    expect(await guilds.getGuildLeader(1)).toBe("user7");
    expect(guildsTable[0].leader).toBe("user7");
    expect(await guilds.getMotd(1)).toBe("Raid");
    await datacache.clearCaches();
    await Promise.all([guilds.transferLeader("user7", "user1"), guilds.setMotd("user7", "Again")]);
    expect(await guilds.getGuildLeader(1)).toBe("user1");
    expect(await guilds.getMotd(1)).toBe("Again");
  });
  test("a promote queued behind a leader transfer is judged on the rank the actor has then", async () => {
    // user1 hands over to user7 and is rank 1 when its promote of user6 (also rank 1) runs: not below.
    const results = await Promise.all([guilds.transferLeader("user1", "user7"), guilds.promote("user1", "user6")]);
    expect(results[0]).toEqual({ ok: true });
    expect(results[1]).toEqual({ ok: false, reason: "not_below" });
    expect(rowOf("user6")!.rank_index).toBe(1);
  });
  test("the Guild Master is never removed, even through remove", async () => {
    expect(await guilds.remove("user1")).toEqual([]);
    expect(writes()).toEqual([]);
    expect(rowOf("user1")!.rank_index).toBe(0);
  });
  test("a leave queued behind a leader transfer to the one leaving is refused", async () => {
    const [moved, left] = await Promise.all([guilds.transferLeader("user1", "user7"), guilds.leave("user7")]);
    expect(moved).toEqual({ ok: true });
    expect(left).toEqual([]);
    expect(rowOf("user7")!.rank_index).toBe(0);
    expect(await guilds.getGuildLeader(1)).toBe("user7");
  });
  test("a former leader cannot disband the guild, also when the disband was queued behind the transfer", async () => {
    expect(await guilds.transferLeader("user1", "user7")).toEqual({ ok: true });
    expect(await guilds.disband("user1")).toBe(false);
    const [moved, disbanded] = await Promise.all([guilds.transferLeader("user7", "user1"), guilds.disband("user7")]);
    expect(moved).toEqual({ ok: true });
    expect(disbanded).toBe(false);
    expect(guildsTable.map((row) => row.id)).toEqual([1, 2]);
    expect(await guilds.getGuildName(1)).toBe("Dragon Slayers");
  });
  test("a kick whose delete is not answered says it failed", async () => {
    failing = /DELETE FROM guild_members WHERE username/;
    expect(await guilds.kick("user6", "user2")).toEqual({ ok: false, reason: "failed" });
    failing = null;
    expect(rowOf("user2")).toBeDefined();
    expect(await guilds.getGuildMembers(1)).toContain("user2");
  });
  test("a note on a higher rank is refused, and so is one over 31 characters", async () => {
    expect(await guilds.setNote("user6", "user1", "x", false)).toEqual({ ok: false, reason: "not_below" });
    expect(await guilds.setNote("user2", "user2", "x".repeat(32), false)).toEqual({ ok: false, reason: "bad_text" });
  });
  test("only the Guild Master edits or deletes ranks", async () => {
    expect(await guilds.editRank("user6", 3, { name: "Raider" })).toEqual({ ok: false, reason: "no_permission" });
    expect(await guilds.deleteRank("user6")).toEqual({ ok: false, reason: "no_permission" });
    expect(await guilds.editRank("user4", 3, { name: "Raider" })).toEqual({ ok: false, reason: "not_in_guild" });
  });
  test("a leader transfer to oneself or to a non-member is refused", async () => {
    expect(await guilds.transferLeader("user1", "user1")).toEqual({ ok: false, reason: "self" });
    expect(await guilds.transferLeader("user1", "user3")).toEqual({ ok: false, reason: "not_member" });
    expect(await guilds.transferLeader("user1", "nobody")).toEqual({ ok: false, reason: "not_member" });
    expect(guildsTable[0].leader).toBe("user1");
  });
  test("rank permissions that are not an integer number are refused", async () => {
    const before = (await guilds.getRanks(1))[3].permissions;
    for (const bad of ["abc", "5", NaN, Infinity, 1.5, null, {}]) {
      expect(await guilds.editRank("user1", 3, { permissions: bad })).toEqual({ ok: false, reason: "bad_text" });
    }
    expect((await guilds.getRanks(1))[3].permissions).toBe(before);
  });
});
