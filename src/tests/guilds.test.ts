import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// ------------------------------------------------------------ fake database
// The statements the guild system sends, run against in-memory tables. A
// statement it does not know is an error, so a read that is not the load of
// the whole table fails the test that made it.

type Row = Record<string, any>;
let guildsTable: Row[];
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

const LOAD = "SELECT id, name, leader, members FROM guilds";

const accountOf = (username: string) => accountsTable.find((row) => row.username === String(username).toLowerCase());

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
    case LOAD:
      return guildsTable.map((row) => ({ ...row }));
    case "INSERT INTO guilds (leader, name, members) VALUES (?, ?, ?)": {
      const [leader, name, members] = params;
      const id = nextGuildId++;
      guildsTable.push({ id, name, leader, members });
      return reportsInsertId ? { lastInsertRowid: id, affectedRows: 1 } : { affectedRows: 1 };
    }
    case "UPDATE guilds SET leader = ?, members = ? WHERE id = ?": {
      const [leader, members, id] = params;
      for (const row of guildsTable) if (row.id === id) Object.assign(row, { leader, members });
      return { affectedRows: 1 };
    }
    case "UPDATE guilds SET members = ? WHERE id = ?": {
      const [members, id] = params;
      for (const row of guildsTable) if (row.id === id) row.members = members;
      return { affectedRows: 1 };
    }
    case "DELETE FROM guilds WHERE id = ?":
      guildsTable = guildsTable.filter((row) => row.id !== params[0]);
      return { affectedRows: 1 };
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
  }
  throw new Error(`The fake database does not understand: ${sql}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({ default: database }));

const datacache = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
const { default: guilds } = await import("../systems/guild");

const reads = () => queries.map(([sql]) => sql).filter((sql) => sql.startsWith("SELECT"));
const writes = () => queries.filter(([sql]) => !sql.startsWith("SELECT"));
/** The accounts another system caches, that it was told to read again. */
const accountsDropped = () => dropRows.mock.calls.filter(([name]: any[]) => name === "accounts").map(([, key]: any[]) => key);
/** The guilds the fake database holds, as `list` answers them. */
const inDatabase = () => guildsTable
  .map((row) => ({
    id: row.id,
    name: row.name,
    leader: row.leader,
    members: String(row.members ?? "").split(",").map((member) => member.trim()).filter(Boolean),
  }))
  .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

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
    { id: 1, name: "Dragon Slayers", leader: "user1", members: "user1, user2" },
    { id: 2, name: "Shadow Guild", leader: "user3", members: "user3" },
  ];
  accountsTable = [
    { username: "user1", guild_id: 1 },
    { username: "user2", guild_id: 1 },
    { username: "user3", guild_id: 2 },
    { username: "user4", guild_id: null },
    { username: "user5", guild_id: null },
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
    expect(queries).toEqual([[LOAD, []]]);
  });

  test("every question together costs that one read", async () => {
    for (const [, ask, answer] of questions) expect(await ask()).toEqual(answer);
    expect(queries).toEqual([[LOAD, []]]);
  });

  test("names match in any case, as the database matched them", async () => {
    expect(await guilds.isInGuild("USER2")).toBe(true);
    expect(await guilds.getGuildId("User2")).toBe(1);
    expect(await guilds.isGuildLeader("USER3")).toBe(true);
    expect(await guilds.exists("shadow guild")).toBe(true);
  });

  test("who is in a guild is who its member list names", async () => {
    // An account pointing at a guild that does not list it, and a list naming an account that points nowhere.
    accountOf("user4")!.guild_id = 1;
    accountOf("user2")!.guild_id = null;
    expect(await guilds.isInGuild("user4")).toBe(false);
    expect(await guilds.getGuildId("user4")).toBeNull();
    expect(await guilds.isInGuild("user2")).toBe(true);
    expect(await guilds.getGuildId("user2")).toBe(1);
    // Someone no list names, and someone the database has never heard of.
    expect(await guilds.isInGuild("user5")).toBe(false);
    expect(await guilds.isInGuild("nobody")).toBe(false);
    expect(await guilds.isInGuild("")).toBe(false);
    expect(await guilds.getGuildId("")).toBeNull();
  });

  test("a name on two lists is in the newer guild", async () => {
    guildsTable.push({ id: 5, name: "Late Comers", leader: "user9", members: "user9, user2" });
    expect(await guilds.getGuildId("user2")).toBe(5);
  });

  test("a member list is read as it is stored: trimmed, without blanks", async () => {
    guildsTable[0].members = " user1 ,user2,, ";
    guildsTable[1].members = null;
    expect(await guilds.getGuildMembers(1)).toEqual(["user1", "user2"]);
    expect(await guilds.getGuildMembers(2)).toEqual([]);
    expect((await guilds.list()).map((guild) => guild.members)).toEqual([["user1", "user2"], []]);
    expect(await guilds.isInGuild("user3")).toBe(false);
  });

  test("a guild that is not there has no name, leader or members", async () => {
    expect(await guilds.getGuildName(9)).toBeNull();
    expect(await guilds.getGuildLeader(9)).toBeNull();
    expect(await guilds.getGuildMembers(9)).toEqual([]);
    expect(await guilds.getGuildName(0)).toBeNull();
    // An id that arrived as text finds the same guild.
    expect(await guilds.getGuildName("2" as any)).toBe("Shadow Guild");
    expect(queries).toEqual([[LOAD, []]]);
  });

  test("the list is in name order whatever order the table gave", async () => {
    guildsTable.push({ id: 3, name: "alpha Wolves", leader: "user9", members: "user9" });
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
    expect(await guilds.list()).toEqual([]);
    expect(await guilds.exists("Dragon Slayers")).toBe(false);
    expect(await guilds.isGuildLeader("user1")).toBe(false);
    expect(queries).toEqual([[LOAD, []]]);
  });
});

// ------------------------------------------- changes: database, then table

describe("a guild change is written to the database, then to the table held", () => {
  test("setLeader puts the new leader first", async () => {
    expect(await guilds.setLeader(1, "user2")).toEqual(["user2", "user1"]);
    expect(writes()).toEqual([["UPDATE guilds SET leader = ?, members = ? WHERE id = ?", ["user2", "user2, user1", 1]]]);

    expect(await guilds.getGuildLeader(1)).toBe("user2");
    expect(await guilds.getGuildMembers(1)).toEqual(["user2", "user1"]);
    expect(await guilds.isGuildLeader("user2")).toBe(true);
    expect(await guilds.isGuildLeader("user1")).toBe(false);
    expect(reads()).toEqual([LOAD]);
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
      ["UPDATE guilds SET members = ? WHERE id = ?", ["user1, user2, user4", 1]],
    ]);
    expect(accountsDropped()).toEqual(["user4"]);

    expect(await guilds.getGuildMembers(1)).toEqual(["user1", "user2", "user4"]);
    expect(await guilds.getGuildId("user4")).toBe(1);
    expect(await guilds.isInGuild("user4")).toBe(true);
    expect(reads()).toEqual([LOAD]);
  });

  test("add refuses a member of any guild, a full guild and a guild that is not there", async () => {
    expect(await guilds.add("user3", 1)).toEqual([]);
    expect(await guilds.add("USER3", 1)).toEqual([]);
    expect(await guilds.add("user4", 9)).toEqual([]);
    expect(await guilds.add("", 1)).toEqual([]);
    guildsTable[1].members = Array.from({ length: 500 }, (_, i) => `member${i}`).join(", ");
    await datacache.clearCaches();
    expect(await guilds.add("user4", 2)).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("remove takes the member off the account and the list", async () => {
    expect(await guilds.remove("user2")).toEqual(["user1"]);
    expect(writes()).toEqual([
      ["UPDATE accounts SET guild_id = NULL WHERE username = ?", ["user2"]],
      ["UPDATE guilds SET members = ? WHERE id = ?", ["user1", 1]],
    ]);
    expect(accountsDropped()).toEqual(["user2"]);

    expect(await guilds.isInGuild("user2")).toBe(false);
    expect(await guilds.getGuildId("user2")).toBeNull();
    expect(await guilds.getGuildMembers(1)).toEqual(["user1"]);
    expect(reads()).toEqual([LOAD]);
  });

  test("remove finds the member whatever case the name came in, as the account was found", async () => {
    expect(await guilds.remove("USER2")).toEqual(["user1"]);
    expect(await guilds.isInGuild("user2")).toBe(false);
    expect(guildsTable[0].members).toBe("user1");
  });

  test("remove of someone in no guild writes nothing", async () => {
    expect(await guilds.remove("user4")).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("delete takes the guild out and frees its members' accounts", async () => {
    expect(await guilds.delete(1)).toBe(true);
    expect(writes()).toEqual([
      ["DELETE FROM guilds WHERE id = ?", [1]],
      ["UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", [1]],
    ]);
    expect(accountsDropped().sort()).toEqual(["user1", "user2"]);

    expect(await guilds.getGuildName(1)).toBeNull();
    expect(await guilds.exists("Dragon Slayers")).toBe(false);
    expect(await guilds.isInGuild("user2")).toBe(false);
    expect(await guilds.isGuildLeader("user1")).toBe(false);
    expect((await guilds.list()).map((guild) => guild.id)).toEqual([2]);
    expect(reads()).toEqual([LOAD]);
  });

  test("leave is a removal, refused to the leader and to someone in no guild", async () => {
    expect(await guilds.leave("user1")).toBe(false);
    expect(await guilds.leave("user4")).toBe(false);
    expect(writes()).toEqual([]);

    expect(await guilds.leave("user2")).toEqual(["user1"]);
    expect(writes().map(([sql]) => sql)).toEqual([
      "UPDATE accounts SET guild_id = NULL WHERE username = ?",
      "UPDATE guilds SET members = ? WHERE id = ?",
    ]);
    expect(await guilds.isInGuild("user2")).toBe(false);
    expect(reads()).toEqual([LOAD]);
  });

  test("disband by the leader ends the guild", async () => {
    expect(await guilds.disband("user1")).toBe(true);
    expect(writes()).toEqual([
      ["UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", [1]],
      ["DELETE FROM guilds WHERE id = ?", [1]],
      ["UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", [1]],
    ]);
    expect([...new Set(accountsDropped())].sort()).toEqual(["user1", "user2"]);

    expect(await guilds.isInGuild("user1")).toBe(false);
    expect(await guilds.isInGuild("user2")).toBe(false);
    expect(await guilds.isGuildLeader("user1")).toBe(false);
    expect(await guilds.getGuildMembers(1)).toEqual([]);
    expect(reads()).toEqual([LOAD]);
  });

  test("disband is refused to a member who does not lead, and to someone in no guild", async () => {
    expect(await guilds.disband("user2")).toBe(false);
    expect(await guilds.disband("user4")).toBe(false);
    expect(writes()).toEqual([]);
  });

  test("create makes the guild with its founder as leader and only member", async () => {
    expect(await guilds.create("user4", "  New Guild  ")).toEqual(["user4"]);
    expect(writes()).toEqual([
      ["INSERT INTO guilds (leader, name, members) VALUES (?, ?, ?)", ["user4", "New Guild", "user4"]],
      ["UPDATE accounts SET guild_id = ? WHERE username = ?", [3, "user4"]],
    ]);
    expect(accountsDropped()).toEqual(["user4"]);

    expect(await guilds.getGuildId("user4")).toBe(3);
    expect(await guilds.getGuildName(3)).toBe("New Guild");
    expect(await guilds.getGuildLeader(3)).toBe("user4");
    expect(await guilds.getGuildMembers(3)).toEqual(["user4"]);
    expect(await guilds.isGuildLeader("user4")).toBe(true);
    expect(await guilds.exists("new guild")).toBe(true);
    expect(reads()).toEqual([LOAD]);
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
    expect(await guilds.getGuildId("user4")).toBe(3);
    expect(await guilds.getGuildName(3)).toBe("New Guild");
    expect(reads()).toEqual([LOAD, LOAD]);
  });
});

// --------------------------------- a write the database does not answer

// Each write, the statement of it that is not answered, what the write then
// answers, and the accounts the player system must be told to read again.
const unanswered: Array<[string, RegExp, () => Promise<unknown>, unknown, string[]]> = [
  ["setLeader", /^UPDATE guilds/, () => guilds.setLeader(1, "user2"), [], []],
  ["add (the account)", /^UPDATE accounts/, () => guilds.add("user4", 1), [], ["user4"]],
  ["add (the member list)", /^UPDATE guilds/, () => guilds.add("user4", 1), [], ["user4"]],
  ["remove (the account)", /^UPDATE accounts/, () => guilds.remove("user2"), [], ["user2"]],
  ["remove (the member list)", /^UPDATE guilds/, () => guilds.remove("user2"), [], ["user2"]],
  ["delete (the guild)", /^DELETE FROM guilds/, () => guilds.delete(1), false, []],
  ["delete (the accounts)", /^UPDATE accounts/, () => guilds.delete(1), false, ["user1", "user2"]],
  ["leave", /^UPDATE guilds/, () => guilds.leave("user2"), [], ["user2"]],
  ["disband (the accounts)", /^UPDATE accounts/, () => guilds.disband("user1"), false, ["user1", "user2"]],
  ["disband (the guild)", /^DELETE FROM guilds/, () => guilds.disband("user1"), false, ["user1", "user2"]],
  ["create (the guild)", /^INSERT INTO guilds/, () => guilds.create("user4", "New Guild"), false, []],
  ["create (the account)", /^UPDATE accounts/, () => guilds.create("user4", "New Guild"), false, ["user4"]],
];

// A statement that timed out may still have been applied, so after either
// kind of failure the table is read again rather than trusted.
for (const made of [false, true]) {
  describe(`a guild write the database ${made ? "made but never answered" : "refused"}`, () => {
    test.each(unanswered)("%s: the table is read again, so what is held is what the database holds", async (_name, statement, write, answer, accounts) => {
      await guilds.list();
      lostAfterWriting = made;
      failing = statement;
      expect(await write()).toEqual(answer);
      failing = null;

      expect(reads()).toEqual([LOAD, LOAD]);
      expect([...new Set(accountsDropped())].sort()).toEqual(accounts);
      expect(await guilds.list()).toEqual(inDatabase());
      expect(reads()).toEqual([LOAD, LOAD]);
    });
  });
}

test("a write that was made but never answered is what the next read answers", async () => {
  await guilds.list();
  lostAfterWriting = true;

  failing = /^UPDATE guilds/;
  expect(await guilds.add("user4", 1)).toEqual([]);
  expect(await guilds.getGuildMembers(1)).toEqual(["user1", "user2", "user4"]);
  expect(await guilds.getGuildId("user4")).toBe(1);

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
  failing = /^UPDATE guilds|^SELECT/;
  expect(await guilds.add("user4", 1)).toEqual([]);
  failing = null;
  expect(reads()).toEqual([LOAD, LOAD]);
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
