import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ------------------------------------------------------------ fake database
// The statements the permissions system sends, run against in-memory tables.
// A statement it does not know is an error, so a read that is not a cache
// filling itself fails the test that made it.

type Row = Record<string, any>;
let permissionsTable: Row[];
let typesTable: string[];
/** Every statement sent, with its values, in order. */
let queries: Array<[string, any[]]>;
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null;
/** The refused statement was written all the same: its answer is what was lost. */
let lostAfterWriting: boolean;
/** The most the permissions column holds: a longer list is stored cut short. */
let columnLength: number;

const LOAD = "SELECT permissions FROM permissions WHERE username = ?";
const TYPES = "SELECT name FROM permission_types";
const INSERT = "INSERT INTO permissions (username, permissions) VALUES (?, ?) ON DUPLICATE KEY UPDATE permissions = ?";
const DELETE = "DELETE FROM permissions WHERE username = ?";

const rowOf = (username: string) => permissionsTable.find((row) => row.username === String(username).toLowerCase());
const stored = (username: string) => rowOf(username)?.permissions;

function run(sql: string, params: any[]): any {
  if (sql === LOAD) return permissionsTable.filter((row) => row.username === params[0]).map((row) => ({ permissions: row.permissions }));
  if (sql === TYPES) return typesTable.map((name) => ({ name }));
  // A login has every system's player cache fill itself: the others' tables are not this file's, and hold nothing.
  if (sql.startsWith("SELECT ") && !sql.includes("permission")) return [];
  if (sql === INSERT) {
    const [username, list] = params;
    const row = rowOf(username);
    if (row) row.permissions = String(list).slice(0, columnLength);
    else permissionsTable.push({ username, permissions: String(list).slice(0, columnLength) });
    return { affectedRows: row ? 2 : 1 };
  }
  if (sql === DELETE) {
    const before = permissionsTable.length;
    permissionsTable = permissionsTable.filter((row) => row.username !== params[0]);
    return { affectedRows: before - permissionsTable.length };
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
const { default: permissions } = await import("../systems/permissions");

const reads = () => queries.map(([sql]) => sql).filter((sql) => sql === LOAD || sql === TYPES);
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
  permissionsTable = [
    { username: "user1", permissions: "admin,moderator" },
    { username: "user2", permissions: "player" },
    { username: "user3", permissions: "" },
  ];
  typesTable = ["admin", "moderator", "player"];
  queries = [];
  failing = null;
  lostAfterWriting = false;
  columnLength = 255;
  await datacache.clearCaches();
});

// ------------------------------------------------- one read of a player's row

describe("a player's permissions are answered from the row held, read once", () => {
  test("asked again, the database is not", async () => {
    expect(await permissions.get("user1")).toBe("admin,moderator");
    expect(await permissions.get("user1")).toBe("admin,moderator");
    expect(queries).toEqual([[LOAD, ["user1"]]]);
  });

  test("a name in any case is the same player's row", async () => {
    expect(await permissions.get("User1")).toBe("admin,moderator");
    expect(await permissions.get("USER1")).toBe("admin,moderator");
    expect(reads()).toEqual([LOAD]);
  });

  test("no row and an empty list are both no permissions, and neither is asked for twice", async () => {
    expect(await permissions.get("user3")).toBe("");
    expect(await permissions.get("user3")).toBe("");
    expect(await permissions.get("nobody")).toBe("");
    expect(await permissions.get("nobody")).toBe("");
    expect(queries).toEqual([[LOAD, ["user3"]], [LOAD, ["nobody"]]]);
  });

  test("a player's row is read again when they log in, and forgotten when they leave", async () => {
    await permissions.get("user1");
    rowOf("user1")!.permissions = "player";
    await datacache.refreshPlayer("user1");
    expect(await permissions.get("user1")).toBe("player");
    expect(reads()).toEqual([LOAD, LOAD]);

    await datacache.forgetPlayer("user1");
    expect(await permissions.get("user1")).toBe("player");
    expect(reads()).toEqual([LOAD, LOAD, LOAD]);
  });
});

describe("the permissions there are to give are a table read once", () => {
  test("asked again, the database is not", async () => {
    expect(await permissions.list()).toEqual(["admin", "moderator", "player"]);
    expect(await permissions.list()).toEqual(["admin", "moderator", "player"]);
    expect(queries).toEqual([[TYPES, []]]);
  });

  test("the answer is a copy: changing it changes nothing held", async () => {
    (await permissions.list()).push("intruder");
    expect(await permissions.list()).toEqual(["admin", "moderator", "player"]);
  });

  test("the table is known by its agreed name: told to read again, it does, once", async () => {
    await permissions.list();
    typesTable = ["admin", "tools.*"];
    await datacache.reloadTable("permission_types");
    expect(await permissions.list()).toEqual(["admin", "tools.*"]);
    expect(await permissions.list()).toEqual(["admin", "tools.*"]);
    expect(queries).toEqual([[TYPES, []], [TYPES, []]]);
  });

  test("no permission types at all is an empty list, not asked for twice", async () => {
    typesTable = [];
    expect(await permissions.list()).toEqual([]);
    expect(await permissions.list()).toEqual([]);
    expect(queries).toEqual([[TYPES, []]]);
  });
});

// ------------------------------------------- changes: database, then the row

describe("a change to a player's permissions is written to the database, then to the row held", () => {
  test("set writes the list, each name once, and the next read has it without asking", async () => {
    await permissions.set("user1", ["admin", "player", "admin"]);
    expect(writes()).toEqual([[INSERT, ["user1", "admin,player", "admin,player"]]]);
    expect(stored("user1")).toBe("admin,player");

    expect(await permissions.get("user1")).toBe("admin,player");
    expect(reads()).toEqual([]);
  });

  test("set of one name, and for a player who had no row", async () => {
    await permissions.set("user4", "admin");
    expect(permissionsTable).toContainEqual({ username: "user4", permissions: "admin" });
    expect(await permissions.get("user4")).toBe("admin");
    expect(reads()).toEqual([]);
  });

  test("add puts the name on the list held, without a second read", async () => {
    await permissions.add("user2", "moderator");
    expect(writes()).toEqual([[INSERT, ["user2", "player,moderator", "player,moderator"]]]);
    expect(await permissions.get("user2")).toBe("player,moderator");
    expect(stored("user2")).toBe("player,moderator");
    expect(reads()).toEqual([LOAD]);
  });

  test("add of a name already held writes nothing", async () => {
    await permissions.add("user1", "admin");
    expect(writes()).toEqual([]);
    expect(await permissions.get("user1")).toBe("admin,moderator");
  });

  test("add gives a player with no row their first permission", async () => {
    await permissions.add("user4", "player");
    expect(stored("user4")).toBe("player");
    expect(await permissions.get("user4")).toBe("player");
    expect(reads()).toEqual([LOAD]);
  });

  test("remove takes the name off the list held, without a second read", async () => {
    await permissions.remove("user1", "moderator");
    expect(writes()).toEqual([[INSERT, ["user1", "admin", "admin"]]]);
    expect(await permissions.get("user1")).toBe("admin");
    expect(stored("user1")).toBe("admin");
    expect(reads()).toEqual([LOAD]);
  });

  test("remove of a name not held writes nothing", async () => {
    await permissions.remove("user1", "player");
    expect(writes()).toEqual([]);
  });

  test("clear deletes the row, and the next read knows there is none without asking", async () => {
    await permissions.get("user1");
    await permissions.clear("user1");
    expect(writes()).toEqual([[DELETE, ["user1"]]]);
    expect(rowOf("user1")).toBeUndefined();

    expect(await permissions.get("user1")).toBe("");
    expect(reads()).toEqual([LOAD]);
  });

  test("changes made side by side leave the row held as the table has it", async () => {
    await Promise.all([permissions.add("user2", "admin"), permissions.add("user2", "moderator"), permissions.remove("user2", "player")]);
    expect(await permissions.get("user2")).toBe(stored("user2"));
    expect(reads()).toEqual([LOAD]);
  });

  test("a list too long for the column is read back, not assumed", async () => {
    const names = Array.from({ length: 40 }, (_, i) => `tools.editor_${i}`);
    expect(names.join(",").length).toBeGreaterThan(255);
    await permissions.set("user1", names);
    expect(await permissions.get("user1")).toBe(names.join(",").slice(0, 255));
    expect(reads()).toEqual([LOAD]);
  });
});

// ------------------------------------------------ a write the database refuses

describe("a write that fails has the row read again", () => {
  test("set that was refused: the next read asks once and answers what the table holds", async () => {
    await permissions.get("user1");
    failing = /^INSERT INTO permissions/;
    await expect(permissions.set("user1", ["player"])).rejects.toThrow("connection lost");
    failing = null;

    expect(await permissions.get("user1")).toBe("admin,moderator");
    expect(await permissions.get("user1")).toBe("admin,moderator");
    expect(reads()).toEqual([LOAD, LOAD]);
  });

  test("set that was written though its answer was lost: the read finds the new list", async () => {
    await permissions.get("user1");
    failing = /^INSERT INTO permissions/;
    lostAfterWriting = true;
    await expect(permissions.set("user1", ["player"])).rejects.toThrow("connection lost");
    failing = null;

    expect(await permissions.get("user1")).toBe("player");
    expect(reads()).toEqual([LOAD, LOAD]);
  });

  test("add and remove that were refused change nothing held", async () => {
    failing = /^INSERT INTO permissions/;
    await expect(permissions.add("user2", "admin")).rejects.toThrow("connection lost");
    await expect(permissions.remove("user1", "admin")).rejects.toThrow("connection lost");
    failing = null;

    expect(await permissions.get("user2")).toBe("player");
    expect(await permissions.get("user1")).toBe("admin,moderator");
    // Each was read for the change, and again after it failed.
    expect(queries.filter(([sql]) => sql === LOAD).map(([, params]) => params[0])).toEqual(["user2", "user1", "user2", "user1"]);
  });

  test("clear that was refused: the next read asks once and answers what the table holds", async () => {
    await permissions.get("user1");
    failing = /^DELETE FROM permissions/;
    await expect(permissions.clear("user1")).rejects.toThrow("connection lost");
    failing = null;

    expect(await permissions.get("user1")).toBe("admin,moderator");
    expect(reads()).toEqual([LOAD, LOAD]);
  });

  test("clear that was written though its answer was lost: the read finds no row", async () => {
    await permissions.get("user1");
    failing = /^DELETE FROM permissions/;
    lostAfterWriting = true;
    await expect(permissions.clear("user1")).rejects.toThrow("connection lost");
    failing = null;

    expect(await permissions.get("user1")).toBe("");
    expect(reads()).toEqual([LOAD, LOAD]);
  });
});

// ------------------------------------------------------------- behaviour

test("permissions.get returns permissions for user", async () => {
  const result = await permissions.get("user1");
  expect(result).toContain("admin");
  expect(result).toContain("moderator");
});

test("permissions.get returns empty for user with no permissions", async () => {
  const result = await permissions.get("user3");
  expect(result).toBe("");
});

test("permissions.get returns empty for non-existent user", async () => {
  const result = await permissions.get("nonexistent");
  expect(result).toBe("");
});

test("permissions.set sets single permission", async () => {
  await permissions.set("user1", "admin");
  expect(await permissions.get("user1")).toBe("admin");
});

test("permissions.set sets multiple permissions", async () => {
  await permissions.set("user1", ["admin", "moderator", "player"]);
  expect(await permissions.get("user1")).toBe("admin,moderator,player");
});

test("permissions.set removes duplicates", async () => {
  await permissions.set("user1", ["admin", "admin", "admin"]);
  expect(await permissions.get("user1")).toBe("admin");
});

test("permissions.add adds permission to user", async () => {
  await permissions.add("user2", "moderator");
  expect(await permissions.get("user2")).toBe("player,moderator");
});

test("permissions.add prevents duplicate permissions", async () => {
  await permissions.add("perms_test_user", "admin");
  await permissions.add("perms_test_user", "admin");
  expect(await permissions.get("perms_test_user")).toBe("admin");
});

test("permissions.remove removes permission from user", async () => {
  await permissions.remove("user1", "moderator");
  expect(await permissions.get("user1")).toBe("admin");
});

test("permissions.clear clears all permissions", async () => {
  await permissions.clear("user1");
  expect(await permissions.get("user1")).toBe("");
});

test("permissions.list returns all permission types", async () => {
  const result = await permissions.list();
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThan(0);
});
