import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

// ------------------------------------------------------------ fake database
// The statements the spell system sends about what players have learned, run
// against an in-memory table. A statement it does not know is an error, so a
// read that is not the cache filling itself fails the test that made it.

type Row = Record<string, any>;
let learnedTable: Row[];
/** Every statement sent, with its values, in order. */
let queries: Array<[string, any[]]>;
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null;
/** The refused statement was written all the same: its answer is what was lost. */
let lostAfterWriting: boolean;
/** A database whose table has a key on (username, spell): a second row of a spell is ignored. */
let keyed: boolean;

const LOAD = "SELECT spell FROM learned_spells WHERE username = ?";
const INSERT = "INSERT IGNORE INTO learned_spells (username, spell) VALUES (?, ?)";
const DELETE = "DELETE FROM learned_spells WHERE username = ? AND spell = ?";

// As MySQL compares text: without regard to case.
const same = (a: string, b: string) => String(a).toLowerCase() === String(b).toLowerCase();
const stored = (username: string) => learnedTable.filter((row) => row.username === username).map((row) => row.spell);

function run(sql: string, params: any[]): any {
  if (sql === LOAD) return learnedTable.filter((row) => row.username === params[0]).map((row) => ({ spell: row.spell }));
  // A login has every system's player cache fill itself: the others' tables are not this file's, and hold nothing.
  if (sql.startsWith("SELECT ") && !sql.includes("learned_spells")) return [];
  if (sql === INSERT) {
    const [username, spell] = params;
    if (keyed && learnedTable.some((row) => row.username === username && same(row.spell, spell))) return { affectedRows: 0 };
    learnedTable.push({ username, spell });
    return { affectedRows: 1 };
  }
  if (sql === DELETE) {
    const [username, spell] = params;
    const before = learnedTable.length;
    learnedTable = learnedTable.filter((row) => !(row.username === username && same(row.spell, spell)));
    return { affectedRows: before - learnedTable.length };
  }
  throw new Error(`The fake database does not understand: ${sql}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    queries.push([sql, params]);
    if (failing?.test(sql)) {
      if (lostAfterWriting) run(sql, params);
      throw new Error("connection lost");
    }
    return run(sql, params);
  },
}));

const assets = new Map<string, any>([
  ["spells", [
    { id: 1, name: "frost_bolt", icon: "frost_bolt", mana: 5, damage: 10 },
    { id: 2, name: "fireball", icon: "fireball", mana: 10, damage: 20 },
    { id: 3, name: "heal", icon: "heal", mana: 8, damage: 0 },
  ]],
]);
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => assets.get(key),
    set: async (key: string, value: any) => assets.set(key, value),
    add: async (key: string, value: any) => assets.set(key, value),
  },
}));

const datacache = await import("../services/datacache");
const { default: spells } = await import("../systems/spells");

const reads = () => queries.map(([sql]) => sql).filter((sql) => sql === LOAD);
const writes = () => queries.filter(([sql]) => !sql.startsWith("SELECT"));

beforeEach(async () => {
  learnedTable = [
    { username: "hero", spell: "frost_bolt" },
    { username: "hero", spell: "heal" },
    { username: "ally", spell: "fireball" },
  ];
  queries = [];
  failing = null;
  lostAfterWriting = false;
  keyed = false;
  await datacache.clearCaches();
});

afterAll(async () => {
  // What this file's database answered is not for the files that follow.
  await datacache.clearCaches();
});

// ------------------------------------------------ one read of a player's rows

describe("what a player has learned is answered from the rows held, read once", () => {
  test("asked again, the database is not", async () => {
    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal"]);
    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal"]);
    expect(queries).toEqual([[LOAD, ["hero"]]]);
  });

  test("a name in any case is the same player's rows", async () => {
    expect(await spells.listLearned("Hero")).toEqual(["frost_bolt", "heal"]);
    expect(await spells.listLearned("HERO")).toEqual(["frost_bolt", "heal"]);
    expect(reads()).toEqual([LOAD]);
  });

  test("a player who has learned nothing has no spells, and is not asked about twice", async () => {
    expect(await spells.listLearned("novice")).toEqual([]);
    expect(await spells.listLearned("novice")).toEqual([]);
    expect(await spells.listLearned("")).toEqual([]);
    expect(queries).toEqual([[LOAD, ["novice"]]]);
  });

  test("an answer is a copy: changing it changes nothing held", async () => {
    (await spells.listLearned("hero")).push("intruder");
    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal"]);
  });

  test("the details a live player carries are built from the same rows", async () => {
    expect(Object.keys(await spells.learnedDetails("hero"))).toEqual(["frost_bolt", "heal"]);
    expect((await spells.learnedDetails("hero")).frost_bolt).toMatchObject({ icon: "frost_bolt", mana: 5, damage: 10 });
    expect(queries).toEqual([[LOAD, ["hero"]]]);
  });

  test("a player's rows are read again when they log in, and forgotten when they leave", async () => {
    await spells.listLearned("hero");
    learnedTable.push({ username: "hero", spell: "fireball" });
    await datacache.refreshPlayer("hero");
    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal", "fireball"]);
    expect(reads()).toEqual([LOAD, LOAD]);

    await datacache.forgetPlayer("hero");
    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal", "fireball"]);
    expect(reads()).toEqual([LOAD, LOAD, LOAD]);
  });

  test("the rows are known by their agreed name: told to forget a player, they are read again", async () => {
    await spells.listLearned("hero");
    learnedTable = learnedTable.filter((row) => row.username !== "hero");
    await datacache.dropRows("learned_spells", "hero");
    expect(await spells.listLearned("hero")).toEqual([]);
    expect(reads()).toEqual([LOAD, LOAD]);
  });
});

// ------------------------------------------ changes: database, then the rows

describe("learning and unlearning are written to the database, then to the rows held", () => {
  test("learnSpell adds the row and the next read has it without asking", async () => {
    const result = await spells.learnSpell("hero", "fireball") as any;
    expect(result.affectedRows).toBe(1);
    expect(writes()).toEqual([[INSERT, ["hero", "fireball"]]]);
    expect(stored("hero")).toEqual(["frost_bolt", "heal", "fireball"]);

    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal", "fireball"]);
    expect(reads()).toEqual([LOAD]);
  });

  test("learnSpell for a player who had learned nothing", async () => {
    await spells.learnSpell("novice", "heal");
    expect(await spells.listLearned("novice")).toEqual(["heal"]);
    expect(stored("novice")).toEqual(["heal"]);
    expect(reads()).toEqual([LOAD]);
  });

  test("a spell learned twice is held as the table holds it: one row for each time", async () => {
    await spells.learnSpell("hero", "heal");
    expect(stored("hero")).toEqual(["frost_bolt", "heal", "heal"]);
    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal", "heal"]);
    expect(reads()).toEqual([LOAD]);
  });

  test("where the database says it added no row, none is held", async () => {
    keyed = true;
    const result = await spells.learnSpell("hero", "heal") as any;
    expect(result.affectedRows).toBe(0);
    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal"]);
    expect(stored("hero")).toEqual(["frost_bolt", "heal"]);
    expect(reads()).toEqual([LOAD]);
  });

  test("unlearnSpell removes every row of the spell and the next read lacks it without asking", async () => {
    await spells.learnSpell("hero", "heal");
    const result = await spells.unlearnSpell("hero", "heal") as any;
    expect(result.affectedRows).toBe(2);
    expect(writes().at(-1)).toEqual([DELETE, ["hero", "heal"]]);
    expect(stored("hero")).toEqual(["frost_bolt"]);

    expect(await spells.listLearned("hero")).toEqual(["frost_bolt"]);
    expect(reads()).toEqual([LOAD]);
  });

  test("unlearnSpell finds the spell as the database does, whatever case its name came in", async () => {
    await spells.unlearnSpell("hero", "Frost_Bolt");
    expect(stored("hero")).toEqual(["heal"]);
    expect(await spells.listLearned("hero")).toEqual(["heal"]);
  });

  test("unlearnSpell of a spell the player does not know changes nothing held", async () => {
    await spells.unlearnSpell("hero", "fireball");
    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal"]);
    expect(stored("ally")).toEqual(["fireball"]);
    expect(reads()).toEqual([LOAD]);
  });

  test("changes made side by side leave the rows held as the table has them", async () => {
    await Promise.all([spells.learnSpell("hero", "fireball"), spells.unlearnSpell("hero", "heal"), spells.learnSpell("hero", "heal")]);
    expect(await spells.listLearned("hero")).toEqual(stored("hero"));
    expect(stored("hero")).toEqual(["frost_bolt", "fireball", "heal"]);
    expect(reads()).toEqual([LOAD]);
  });
});

// ------------------------------------------------ a write the database refuses

describe("a write that fails has the rows read again", () => {
  test("learnSpell that was refused: the next read asks once and answers what the table holds", async () => {
    await spells.listLearned("hero");
    failing = /^INSERT IGNORE INTO learned_spells/;
    await expect(spells.learnSpell("hero", "fireball")).rejects.toThrow("connection lost");
    failing = null;

    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal"]);
    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal"]);
    expect(reads()).toEqual([LOAD, LOAD]);
  });

  test("learnSpell that was written though its answer was lost: the read finds the spell", async () => {
    await spells.listLearned("hero");
    failing = /^INSERT IGNORE INTO learned_spells/;
    lostAfterWriting = true;
    await expect(spells.learnSpell("hero", "fireball")).rejects.toThrow("connection lost");
    failing = null;

    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal", "fireball"]);
    expect(reads()).toEqual([LOAD, LOAD]);
  });

  test("unlearnSpell that was refused: the next read asks once and answers what the table holds", async () => {
    await spells.listLearned("hero");
    failing = /^DELETE FROM learned_spells/;
    await expect(spells.unlearnSpell("hero", "heal")).rejects.toThrow("connection lost");
    failing = null;

    expect(await spells.listLearned("hero")).toEqual(["frost_bolt", "heal"]);
    expect(reads()).toEqual([LOAD, LOAD]);
  });

  test("unlearnSpell that was written though its answer was lost: the read finds the spell gone", async () => {
    await spells.listLearned("hero");
    failing = /^DELETE FROM learned_spells/;
    lostAfterWriting = true;
    await expect(spells.unlearnSpell("hero", "heal")).rejects.toThrow("connection lost");
    failing = null;

    expect(await spells.listLearned("hero")).toEqual(["frost_bolt"]);
    expect(reads()).toEqual([LOAD, LOAD]);
  });
});
