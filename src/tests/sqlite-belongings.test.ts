import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "os";
import path from "path";
import fs from "fs";

// The inventory and currency systems on a real SQLite file. Their statements are written for
// MySQL, and the other test files hand them to a stand-in that takes them as written: only a
// database says whether SQLite reads them. It runs in a process of its own (see the fixture), so
// the stand-ins other test files put in place of the database layer do not reach it.

const name = `ff_belongings_test_${process.pid}`;
const file = path.join(os.tmpdir(), "frostfire_forge", `${name}.sqlite`);
const remove = () => { for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true }); };

let out: any;

beforeAll(async () => {
  remove();
  const run = Bun.spawn(["bun", path.join(import.meta.dir, "sqlite-belongings.fixture.ts")], {
    env: { ...process.env, DATABASE_ENGINE: "sqlite", DATABASE_NAME: name, DB_WORKER_POOL_SIZE: "2", LOG_LEVEL: "error", CACHE: "memory" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
  await run.exited;
  const line = stdout.slice(stdout.indexOf("RESULT "));
  if (!line.startsWith("RESULT ")) throw new Error(`The fixture gave no result.\n${stdout}\n${stderr}`);
  out = JSON.parse(line.slice("RESULT ".length));
}, 60000);

afterAll(remove);

describe("the inventory and the currency on SQLite", () => {
  test("every write is taken: a new item, more of it, where it sits, and coins put in and taken out", () => {
    expect(out.steps).toEqual(Array(7).fill("ran"));
    expect(out.afterSteps).toEqual({
      held: [
        { username: "hero", item: "Iron Ore", quantity: 8, slot: 4 },
        { username: "hero", item: "Rat's \"Tail\"", quantity: 1, slot: null },
      ],
      // 1g 2s 50c and 60c more is 1g 3s 10c; less 1s 5c is 1g 2s 5c.
      purses: [{ username: "hero", copper: 5, silver: 2, gold: 1 }],
    });
  });

  test("a batch that takes coins and gives a new item is kept whole", () => {
    expect(out.bought).toBe("ran");
    expect(out.tables).toEqual({
      held: [
        { username: "hero", item: "Iron Ore", quantity: 8, slot: 4 },
        { username: "hero", item: "Rat's \"Tail\"", quantity: 1, slot: null },
        { username: "hero", item: "Small Pouch", quantity: 2, slot: null },
      ],
      purses: [{ username: "hero", copper: 5, silver: 2, gold: 0 }],
    });
  });

  test("a player's home is written and written over: the inn, then the time they went home, then the next inn", () => {
    expect(out.homeSteps).toEqual(Array(5).fill("ran"));
    expect(out.homes).toEqual([
      // Set at one inn, gone home, then set at another: the time stays.
      { username: "hero", npc_id: 12, offset_x: -5, offset_y: 8, used_at: 1_700_000_000_000 },
      // Gone home with no home set, then the innkeeper they later chose was deleted.
      { username: "ally", npc_id: null, offset_x: 30, offset_y: 40, used_at: 1_700_000_000_500 },
    ]);
    expect(out.homeRead).toEqual({
      hero: { map: "forest", x: 95, y: 108, inn: "Leaf Lodge" },
      ally: null,
      cooldown: 3_600_000 - 1000,
    });
  });

  test("what the systems answer after reading again is what the tables hold", () => {
    expect(out.read).toEqual({
      held: [["Iron Ore", 8], ["Rat's \"Tail\"", 1], ["Small Pouch", 2]],
      purse: { copper: 5, silver: 2, gold: 0 },
    });
  });
});
