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
