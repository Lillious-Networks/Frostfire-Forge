import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// ------------------------------------------------------------ fake database
// The statements the friends system sends, run against in-memory tables, and
// the read the player system makes of an account. A statement it does not
// know is an error, so a read that is not a cache filling itself fails the
// test that made it.

type Row = Record<string, any>;
let friendsTable: Row[];
let accountsTable: Row[];
/** Every statement sent, with its values, in order. */
let queries: Array<[string, any[]]>;
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null;
/** The refused statement was written all the same: its answer is what was lost. */
let lostAfterWriting: boolean;

const LOAD = "SELECT friends FROM friendslist WHERE username = ?";
const INSERT = "INSERT INTO friendslist (username, friends) VALUES (?, ?) ON DUPLICATE KEY UPDATE friends = ?";
const UPDATE = "UPDATE friendslist SET friends = ? WHERE username = ?";
const ACCOUNT = /^SELECT .+ FROM accounts WHERE username = \?$/;

const rowOf = (username: string) => friendsTable.find((row) => row.username === String(username).toLowerCase());

function run(sql: string, params: any[]): any {
  if (sql === LOAD) return friendsTable.filter((row) => row.username === params[0]).map((row) => ({ friends: row.friends }));
  if (ACCOUNT.test(sql)) return accountsTable.filter((row) => row.username === params[0]).map((row) => ({ ...row }));
  // A login has every system's player cache fill itself: the others' tables are not this file's, and hold nothing.
  if (sql.startsWith("SELECT ") && !sql.includes("friendslist")) return [];
  if (sql === INSERT) {
    const [username, list] = params;
    const row = rowOf(username);
    if (row) row.friends = list;
    else friendsTable.push({ username, friends: list });
    return { affectedRows: row ? 2 : 1 };
  }
  if (sql === UPDATE) {
    const [list, username] = params;
    const row = rowOf(username);
    if (row) row.friends = list;
    return { affectedRows: row ? 1 : 0 };
  }
  throw new Error(`The fake database does not understand: ${sql}`);
}

async function database(sql: string, params: any[] = []): Promise<any> {
  queries.push([sql, params]);
  if (failing?.test(sql)) {
    if (lostAfterWriting) run(sql, params);
    throw new Error("connection lost");
  }
  return run(sql, params);
}

mock.module("../controllers/sqldatabase", () => ({ default: database }));

const datacache = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
const { default: friends } = await import("../systems/friends");

const reads = () => queries.map(([sql]) => sql).filter((sql) => sql.startsWith("SELECT"));
const friendReads = () => reads().filter((sql) => sql === LOAD);
const accountReads = () => queries.filter(([sql]) => ACCOUNT.test(sql)).map(([, params]) => params[0]);
const writes = () => queries.filter(([sql]) => !sql.startsWith("SELECT"));

let logged: Array<ReturnType<typeof spyOn>>;
beforeAll(() => {
  logged = [spyOn(log, "info"), spyOn(log, "warn"), spyOn(log, "error")].map((spy) => spy.mockImplementation(() => {}));
});
afterAll(async () => {
  for (const spy of logged) spy.mockRestore();
  // What this file's database answered is not for the files that follow.
  await datacache.clearCaches();
});

beforeEach(async () => {
  friendsTable = [
    { username: "user1", friends: "user2, user3" },
    { username: "user2", friends: "user1" },
    { username: "user3", friends: "" },
  ];
  accountsTable = ["user1", "user2", "user3", "user4", "user5"].map((username, i) => ({ id: 7101 + i, username }));
  queries = [];
  failing = null;
  lostAfterWriting = false;
  await datacache.clearCaches();
});

// ------------------------------------------------- one read of a player's row

describe("a friends list is answered from the row held, read once", () => {
  test("asked again, the database is not", async () => {
    expect(await friends.list("user1")).toEqual(["user2", "user3"]);
    expect(await friends.list("user1")).toEqual(["user2", "user3"]);
    expect(queries).toEqual([[LOAD, ["user1"]]]);
  });

  test("a name in any case is the same player's row", async () => {
    expect(await friends.list("User1")).toEqual(["user2", "user3"]);
    expect(await friends.list("USER1")).toEqual(["user2", "user3"]);
    expect(friendReads()).toEqual([LOAD]);
  });

  test("no row and an empty list are both no friends, and neither is asked for twice", async () => {
    expect(await friends.list("user3")).toEqual([]);
    expect(await friends.list("user3")).toEqual([]);
    expect(await friends.list("user4")).toEqual([]);
    expect(await friends.list("user4")).toEqual([]);
    expect(queries).toEqual([[LOAD, ["user3"]], [LOAD, ["user4"]]]);
  });

  test("an answer is a copy: changing it changes nothing held", async () => {
    (await friends.list("user1")).push("intruder");
    expect(await friends.list("user1")).toEqual(["user2", "user3"]);
    expect(friendReads()).toEqual([LOAD]);
  });

  test("no name is no friends, without a read", async () => {
    expect(await friends.list("")).toEqual([]);
    expect(queries).toEqual([]);
  });

  test("a player's row is read again when they log in, and forgotten when they leave", async () => {
    await friends.list("user1");
    rowOf("user1")!.friends = "user5";
    await datacache.refreshPlayer("user1");
    expect(await friends.list("user1")).toEqual(["user5"]);
    expect(friendReads()).toEqual([LOAD, LOAD]);

    await datacache.forgetPlayer("user1");
    expect(await friends.list("user1")).toEqual(["user5"]);
    expect(friendReads()).toEqual([LOAD, LOAD, LOAD]);
  });
});

// ------------------------------------------- changes: database, then the row

describe("a change to a friends list is written to the database, then to the row held", () => {
  test("add writes the longer list and the next read has it without asking", async () => {
    expect(await friends.add("user1", "user4")).toEqual(["user2", "user3", "user4"]);
    expect(writes()).toEqual([[INSERT, ["user1", "user2,user3,user4", "user2,user3,user4"]]]);
    expect(rowOf("user1")!.friends).toBe("user2,user3,user4");

    expect(await friends.list("user1")).toEqual(["user2", "user3", "user4"]);
    expect(friendReads()).toEqual([LOAD]);
  });

  test("add makes the row of a player who had none", async () => {
    expect(await friends.add("user4", "user1")).toEqual(["user1"]);
    expect(friendsTable).toContainEqual({ username: "user4", friends: "user1" });
    expect(await friends.list("user4")).toEqual(["user1"]);
    expect(friendReads()).toEqual([LOAD]);
  });

  test("whether the friend has an account is asked of the player system, which reads it once", async () => {
    await friends.add("user1", "user4");
    await friends.add("user2", "user4");
    await friends.remove("user1", "user4");
    expect(accountReads()).toEqual(["user4"]);
  });

  test("add of someone with no account, or who is a friend already, writes nothing", async () => {
    expect(await friends.add("user1", "nobody")).toEqual(["user2", "user3"]);
    expect(await friends.add("user1", "user2")).toEqual(["user2", "user3"]);
    expect(await friends.add("", "user2")).toEqual([]);
    expect(await friends.add("user1", "")).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("remove writes the shorter list and the next read has it without asking", async () => {
    expect(await friends.remove("user1", "user2")).toEqual(["user3"]);
    expect(writes()).toEqual([[UPDATE, ["user3", "user1"]]]);
    expect(rowOf("user1")!.friends).toBe("user3");

    expect(await friends.list("user1")).toEqual(["user3"]);
    expect(friendReads()).toEqual([LOAD]);
  });

  test("remove of the last friend leaves the row with an empty list", async () => {
    expect(await friends.remove("user2", "user1")).toEqual([]);
    expect(rowOf("user2")!.friends).toBe("");
    expect(await friends.list("user2")).toEqual([]);
    expect(friendReads()).toEqual([LOAD]);
  });

  test("remove of someone who is not a friend, or has no account, writes nothing", async () => {
    expect(await friends.remove("user1", "user4")).toEqual(["user2", "user3"]);
    expect(await friends.remove("user1", "nobody")).toEqual([]);
    expect(await friends.remove("", "user2")).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("changes made side by side leave the row held as the table has it", async () => {
    await Promise.all([friends.add("user1", "user4"), friends.add("user1", "user5"), friends.remove("user1", "user2")]);
    const stored = rowOf("user1")!.friends.split(",");
    expect(await friends.list("user1")).toEqual(stored);
    expect(friendReads()).toEqual([LOAD]);
  });
});

// ------------------------------------------------ a write the database refuses

describe("a write that fails has the row read again", () => {
  test("add that was refused: the next read asks once and answers what the table holds", async () => {
    await friends.list("user1");
    failing = /^INSERT INTO friendslist/;
    // What add answers after a failure is the list as it now stands, which is that read.
    expect(await friends.add("user1", "user4")).toEqual(["user2", "user3"]);
    failing = null;

    expect(await friends.list("user1")).toEqual(["user2", "user3"]);
    expect(friendReads()).toEqual([LOAD, LOAD]);
    expect(rowOf("user1")!.friends).toBe("user2, user3");
  });

  test("add that was written though its answer was lost: the read finds the friend", async () => {
    await friends.list("user1");
    failing = /^INSERT INTO friendslist/;
    lostAfterWriting = true;
    expect(await friends.add("user1", "user4")).toEqual(["user2", "user3", "user4"]);
    failing = null;

    expect(await friends.list("user1")).toEqual(["user2", "user3", "user4"]);
    expect(friendReads()).toEqual([LOAD, LOAD]);
  });

  test("remove that was refused: the next read asks once and answers what the table holds", async () => {
    await friends.list("user1");
    failing = /^UPDATE friendslist/;
    expect(await friends.remove("user1", "user2")).toEqual([]);
    failing = null;

    expect(await friends.list("user1")).toEqual(["user2", "user3"]);
    expect(await friends.list("user1")).toEqual(["user2", "user3"]);
    expect(friendReads()).toEqual([LOAD, LOAD]);
  });

  test("remove that was written though its answer was lost: the read finds the friend gone", async () => {
    await friends.list("user1");
    failing = /^UPDATE friendslist/;
    lostAfterWriting = true;
    expect(await friends.remove("user1", "user2")).toEqual([]);
    failing = null;

    expect(await friends.list("user1")).toEqual(["user3"]);
    expect(friendReads()).toEqual([LOAD, LOAD]);
  });

  test("a list that cannot be read is no friends, and is asked for again", async () => {
    failing = /^SELECT friends/;
    expect(await friends.list("user1")).toEqual([]);
    failing = null;
    expect(await friends.list("user1")).toEqual(["user2", "user3"]);
  });
});

// ------------------------------------------------------------- behaviour

test("friends.list returns user friends", async () => {
  const result = await friends.list("user1");
  expect(result).toContain("user2");
  expect(result).toContain("user3");
});

test("friends.list returns empty array for non-existent user", async () => {
  const result = await friends.list("nonexistent");
  expect(result).toEqual([]);
});

test("friends.list returns empty array for empty friends string", async () => {
  const result = await friends.list("user3");
  expect(result).toEqual([]);
});

test("friends.add adds new friend", async () => {
  const result = await friends.add("user2", "user3");
  expect(result).toContain("user3");
});

test("friends.add prevents duplicate friends", async () => {
  const result = await friends.add("user1", "user2");
  const count = result.filter((f: string) => f === "user2").length;
  expect(count).toBe(1);
});

test("friends.add returns the list unchanged if friend not found", async () => {
  const result = await friends.add("user1", "nonexistent");
  expect(result).toEqual(["user2", "user3"]);
});

test("friends.remove removes friend from list", async () => {
  const result = await friends.remove("user1", "user2");
  expect(result).not.toContain("user2");
});

test("friends.remove returns same list if friend not found", async () => {
  const result = await friends.remove("user1", "user5");
  expect(result).toEqual(["user2", "user3"]);
});
