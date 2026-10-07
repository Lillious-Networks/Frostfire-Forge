import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import os from "os";
import path from "path";
import fs from "fs";

// The database layer end to end: main thread, worker pool and a SQLite file. It runs in a process
// of its own (see the fixture), so the stand-ins other test files put in place of the layer do not
// reach it.

const name = `ff_transaction_test_${process.pid}`;
const file = path.join(os.tmpdir(), "frostfire_forge", `${name}.sqlite`);
const remove = () => { for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true }); };

let out: any;

beforeAll(async () => {
  remove();
  const run = Bun.spawn(["bun", path.join(import.meta.dir, "sqldatabase_transaction.fixture.ts")], {
    env: { ...process.env, DATABASE_ENGINE: "sqlite", DATABASE_NAME: name, DB_WORKER_POOL_SIZE: "4", LOG_LEVEL: "error" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
  await run.exited;
  const line = stdout.split("\n").find((text) => text.startsWith("RESULT "));
  if (!line) throw new Error(`The fixture gave no result.\n${stdout}\n${stderr}`);
  out = JSON.parse(line.slice("RESULT ".length));
}, 60000);

afterAll(remove);

describe("transaction through the worker pool", () => {
  test("keeps every statement of a list that succeeds", () => {
    expect(out.kept).toEqual([{ username: "a", copper: 90 }, { username: "b", copper: 5 }]);
  });

  test("a statement that had to change a row and did not reaches the caller as a GuardError naming it", () => {
    expect(out.guard).toBe(1);
  });

  test("a statement the database refuses reaches the caller as the database's error", () => {
    expect(out.failed).toContain("no_such_table");
  });

  test("a list that was undone leaves the rows as they were", () => {
    expect(out.afterUndone).toEqual([{ username: "a", copper: 90 }, { username: "b", copper: 5 }]);
  });

  test("lists sent at once to different workers do not take the same coin twice", () => {
    expect(out.took).toBe(25);
    expect(out.refused).toBe(15);
    expect(out.final).toEqual([{ username: "a", copper: 0 }, { username: "b", copper: 30 }]);
  });
});

// The systems' statements are MySQL's. SQLite has other words for two of them, and the layer
// writes those: without that, a new item or a change of coins is a syntax error there.
describe("MySQL's insert forms on SQLite", () => {
  test("INSERT IGNORE adds a row, answers with its id, and adds nothing when one is in the way", () => {
    expect(out.ignore).toEqual({ id: 1, again: "ran" });
    expect(out.bag).toEqual([{ username: "a", item: "Ore", quantity: 1 }, { username: "a", item: "Rat's \"Tail\"", quantity: 2 }]);
  });

  test("in a transaction, an insert that was ignored changed no rows and one that was made changed one", () => {
    expect(out.ignoreGuard).toBe("guard 0");
    expect(out.ignoreKept).toBe("kept");
  });

  test("ON DUPLICATE KEY UPDATE makes the row, then changes it, alone or in a transaction", () => {
    expect(out.upsertFirst).toBe("ran");
    expect(out.upsertAgain).toBe("ran");
    expect(out.upsertTogether).toBe("kept");
    expect(out.purse).toEqual([{ username: "a", copper: 7, silver: 8 }, { username: "b", copper: 5, silver: 6 }]);
  });
});
