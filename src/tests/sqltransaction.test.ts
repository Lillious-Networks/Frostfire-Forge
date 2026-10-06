import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { SQL } from "bun";
import { runTransaction, GuardError, NotStartedError } from "../controllers/sqltransaction";

// A real in-memory SQLite database: what is under test is whether the rows
// are there afterwards, which no stand-in can answer.
let db: any;

const copperOf = async (username: string) => (await db.unsafe(`SELECT copper FROM currency WHERE username = '${username}'`))[0]?.copper;
const itemsOf = async (username: string) => (await db.unsafe(`SELECT item FROM inventory WHERE username = '${username}' ORDER BY id`)).map((row: any) => row.item);

beforeEach(async () => {
  db = new SQL({ adapter: "sqlite", filename: ":memory:" });
  await db.unsafe("CREATE TABLE currency (username TEXT PRIMARY KEY, copper INTEGER NOT NULL)");
  await db.unsafe("CREATE TABLE inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, item TEXT NOT NULL)");
  await db.unsafe("INSERT INTO currency (username, copper) VALUES ('buyer', 100)");
});

afterEach(async () => {
  await db.close();
});

describe("runTransaction", () => {
  test("keeps every statement when all of them succeed", async () => {
    await runTransaction(db, [
      { sql: "UPDATE currency SET copper = copper - ? WHERE username = ?", values: [30, "buyer"] },
      { sql: "INSERT INTO inventory (username, item) VALUES (?, ?)", values: ["buyer", "sword"] },
    ], "sqlite");

    expect(await copperOf("buyer")).toBe(70);
    expect(await itemsOf("buyer")).toEqual(["sword"]);
  });

  test("returns one result for each statement, in order", async () => {
    const results = await runTransaction(db, [
      { sql: "INSERT INTO inventory (username, item) VALUES (?, ?)", values: ["buyer", "sword"] },
      { sql: "SELECT item FROM inventory WHERE username = ?", values: ["buyer"] },
    ], "sqlite");

    expect(results).toHaveLength(2);
    expect([...results[1]]).toEqual([{ item: "sword" }]);
  });

  test("keeps nothing when a later statement fails", async () => {
    const run = runTransaction(db, [
      { sql: "UPDATE currency SET copper = copper - ? WHERE username = ?", values: [30, "buyer"] },
      { sql: "INSERT INTO no_such_table (username) VALUES (?)", values: ["buyer"] },
    ], "sqlite");

    await expect(run).rejects.toThrow("no_such_table");
    expect(await copperOf("buyer")).toBe(100);
  });

  test("keeps nothing when a statement that must change a row changes none", async () => {
    const run = runTransaction(db, [
      { sql: "INSERT INTO inventory (username, item) VALUES (?, ?)", values: ["buyer", "sword"] },
      { sql: "UPDATE currency SET copper = copper - ? WHERE username = ? AND copper >= ?", values: [500, "buyer", 500], mustChange: true },
    ], "sqlite");

    await expect(run).rejects.toBeInstanceOf(GuardError);
    expect(await copperOf("buyer")).toBe(100);
    expect(await itemsOf("buyer")).toEqual([]);
  });

  test("says which statement changed no rows", async () => {
    const error = await runTransaction(db, [
      { sql: "INSERT INTO inventory (username, item) VALUES (?, ?)", values: ["buyer", "sword"] },
      { sql: "DELETE FROM inventory WHERE username = ?", values: ["nobody"], mustChange: true },
    ], "sqlite").catch((caught) => caught);

    expect(error).toBeInstanceOf(GuardError);
    expect(error.statement).toBe(1);
  });

  test("goes through when a statement that must change a row changes one", async () => {
    await runTransaction(db, [
      { sql: "UPDATE currency SET copper = copper - ? WHERE username = ? AND copper >= ?", values: [100, "buyer", 100], mustChange: true },
      { sql: "INSERT INTO inventory (username, item) VALUES (?, ?)", values: ["buyer", "sword"] },
    ], "sqlite");

    expect(await copperOf("buyer")).toBe(0);
    expect(await itemsOf("buyer")).toEqual(["sword"]);
  });

  test("writes a value holding a quote as that value", async () => {
    await runTransaction(db, [
      { sql: "INSERT INTO inventory (username, item) VALUES (?, ?)", values: ["buyer", "king's blade'); DROP TABLE currency; --"] },
    ], "sqlite");

    expect(await itemsOf("buyer")).toEqual(["king's blade'); DROP TABLE currency; --"]);
    expect(await copperOf("buyer")).toBe(100);
  });

  test("an empty list is done without asking the database", async () => {
    const untouched = { begin: () => { throw new Error("asked"); } };

    expect(await runTransaction(untouched, [], "sqlite")).toEqual([]);
  });

  test("a wrong number of values fails before anything is written", async () => {
    const run = runTransaction(db, [
      { sql: "UPDATE currency SET copper = copper - ? WHERE username = ?", values: [30, "buyer"] },
      { sql: "INSERT INTO inventory (username, item) VALUES (?, ?)", values: ["buyer"] },
    ], "sqlite");

    await expect(run).rejects.toThrow("Number of placeholders does not match number of parameters");
    expect(await copperOf("buyer")).toBe(100);
  });

  test("reads MySQL's count of changed rows, which it reports under another name", async () => {
    // What Bun hands back for a MySQL write: affectedRows holds the number and count stays 0.
    const mysqlResult = (affectedRows: number) => Object.assign([], { count: 0, affectedRows });
    const mysql = {
      begin: async (work: (tx: any) => Promise<any>) => work({
        unsafe: async (sql: string) => mysqlResult(sql.startsWith("DELETE") ? 0 : 1),
      }),
    };

    await expect(runTransaction(mysql, [{ sql: "UPDATE t SET a = 1", mustChange: true }], "mysql")).resolves.toHaveLength(1);
    await expect(runTransaction(mysql, [{ sql: "DELETE FROM t", mustChange: true }], "mysql")).rejects.toBeInstanceOf(GuardError);
  });

  test("a database that could not start the transaction is told apart from one that failed inside it", async () => {
    const unreachable = { begin: async () => { throw new Error("Connection closed"); } };

    await expect(runTransaction(unreachable, [{ sql: "SELECT 1" }], "sqlite")).rejects.toBeInstanceOf(NotStartedError);
    await expect(runTransaction(db, [{ sql: "SELECT * FROM no_such_table" }], "sqlite")).rejects.not.toBeInstanceOf(NotStartedError);
  });

  test("gives up, keeping nothing, when a statement does not answer in time", async () => {
    let rolledBack = false;
    const stuck = {
      begin: async (work: (tx: any) => Promise<any>) => {
        try {
          return await work({ unsafe: () => new Promise(() => {}) });
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    };

    await expect(runTransaction(stuck, [{ sql: "UPDATE t SET a = 1" }], "mysql", 20)).rejects.toThrow("Transaction timeout after 20ms");
    expect(rolledBack).toBe(true);
  });
});
