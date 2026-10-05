import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import log from "../modules/logger";
import { clearCaches, dropAllRows, forgetPlayer, loadTables, refreshPlayer, rowCache, tableCache, turns } from "../services/datacache";
import playerCache from "../services/playermanager";

// The database, as the caches' loaders read it, and how often each was read.
let database: Record<string, any>;
let reads: string[];

const bags = rowCache<{ slots: number }>("test_bags", async (key) => {
  reads.push(`bags ${key}`);
  return database.bags[key];
}, { perPlayer: true });

const things = rowCache<string[]>("test_things", async (key) => {
  reads.push(`things ${key}`);
  return database.things[key];
});

const sheets = rowCache<{ hp: number; xp: number }>("test_sheets", async (key) => {
  reads.push(`sheets ${key}`);
  return database.sheets[key];
});

const guilds = tableCache<{ id: number; name: string }>("test_guilds", async () => {
  reads.push("guilds");
  return database.guilds;
});

beforeEach(async () => {
  database = { bags: { hero: { slots: 4 } }, things: { 7: ["a"] }, sheets: { hero: { hp: 10, xp: 0 } }, guilds: [{ id: 1, name: "Wolves" }] };
  await clearCaches();
  reads = [];
});

describe("rows by key", () => {
  test("are read from the database once, then from the cache", async () => {
    expect(await things.get(7)).toEqual(["a"]);
    expect(await things.get("7")).toEqual(["a"]);
    expect(await things.get(7)).toEqual(["a"]);
    expect(reads).toEqual(["things 7"]);
  });

  test("asked for by several at once are read once", async () => {
    expect(await Promise.all([things.get(7), things.get(7), things.get(7)])).toEqual([["a"], ["a"], ["a"]]);
    expect(reads).toEqual(["things 7"]);
  });

  test("come back as copies: changing one changes nothing held", async () => {
    const first = await things.get(7);
    first!.push("mine");
    expect(await things.get(7)).toEqual(["a"]);

    const stored = ["x"];
    await things.set(8, stored);
    stored.push("mine");
    expect(await things.get(8)).toEqual(["x"]);
  });

  test("a write is what the next read gets, without the database", async () => {
    await things.get(7);
    database.things[7] = ["a", "b"];
    await things.set(7, ["a", "b"]);
    expect(await things.get(7)).toEqual(["a", "b"]);
    expect(reads).toEqual(["things 7"]);
  });

  test("dropped, are read again", async () => {
    await things.get(7);
    database.things[7] = ["changed elsewhere"];
    await things.drop(7);
    expect(await things.get(7)).toEqual(["changed elsewhere"]);
    expect(reads).toEqual(["things 7", "things 7"]);
  });

  test("a row that is not there is not asked for again straight away", async () => {
    expect(await things.get(99)).toBeNull();
    expect(await things.get(99)).toBeNull();
    expect(reads).toEqual(["things 99"]);
  });

  test("a write that lands while the row is loading is not replaced by what was read", async () => {
    let release!: () => void;
    const slow = rowCache<string>("test_slow", () => new Promise((resolve) => { release = () => resolve("old"); }));

    const reading = slow.get("k");
    await Promise.resolve();
    await slow.set("k", "new");
    release();

    expect(await reading).toBe("new");
    expect(await slow.get("k")).toBe("new");
  });

  test("a load that fails is not remembered", async () => {
    let fail = true;
    const flaky = rowCache<string>("test_flaky", async () => {
      if (fail) throw new Error("database gone");
      return "there";
    });

    await expect(flaky.get("k")).rejects.toThrow("database gone");
    fail = false;
    expect(await flaky.get("k")).toBe("there");
  });
});

// A player's rows and a table whose database can be taken away.
let wardrobeDown = false;
const wardrobe = rowCache<string[]>("test_wardrobe", async () => {
  if (wardrobeDown) throw new Error("database gone");
  return ["hat"];
}, { perPlayer: true });
let shelfDown = false;
const shelf = tableCache<{ id: number }>("test_shelf", async () => {
  if (shelfDown) throw new Error("database gone");
  return [{ id: 1 }];
});

describe("when the database cannot be read", () => {
  beforeEach(() => {
    wardrobeDown = false;
    shelfDown = false;
  });

  test("a login is not refused: the other rows are read again, and the missing ones by whoever asks next", async () => {
    const said = spyOn(log, "error").mockImplementation(() => {});
    try {
      await bags.get("hero");
      await wardrobe.get("hero");
      database.bags.hero = { slots: 8 };
      wardrobeDown = true;

      await refreshPlayer("hero");

      expect(await bags.get("hero")).toEqual({ slots: 8 });
      expect(said.mock.calls.length).toBeGreaterThanOrEqual(1);
      // The old rows were let go all the same: nothing stale is answered.
      await expect(wardrobe.get("hero")).rejects.toThrow("database gone");
      wardrobeDown = false;
      expect(await wardrobe.get("hero")).toEqual(["hat"]);
    } finally {
      said.mockRestore();
    }
  });

  test("startup goes on: the other tables are read, and the missing one on first use", async () => {
    const said = spyOn(log, "error").mockImplementation(() => {});
    try {
      shelfDown = true;

      await loadTables();

      expect(await guilds.all()).toEqual([{ id: 1, name: "Wolves" }]);
      expect(said.mock.calls.length).toBeGreaterThanOrEqual(1);
      shelfDown = false;
      expect(await shelf.all()).toEqual([{ id: 1 }]);
    } finally {
      said.mockRestore();
    }
  });
});

describe("a player's rows", () => {
  test("are held under the username in any case", async () => {
    expect(await bags.get("Hero")).toEqual({ slots: 4 });
    expect(await bags.get("HERO")).toEqual({ slots: 4 });
    expect(reads).toEqual(["bags hero"]);
  });

  test("are read again at login, and forgotten when the player leaves", async () => {
    await bags.get("hero");
    // Written while the player was away, by something else.
    database.bags.hero = { slots: 8 };

    await refreshPlayer("Hero");
    expect(reads).toEqual(["bags hero", "bags hero"]);
    expect(await bags.get("hero")).toEqual({ slots: 8 });
    expect(reads).toHaveLength(2);

    await forgetPlayer("hero");
    await bags.get("hero");
    expect(reads).toHaveLength(3);
  });

  test("other caches are left alone by a login", async () => {
    await things.get(7);
    await refreshPlayer("7");
    await things.get(7);
    expect(reads.filter((read) => read === "things 7")).toHaveLength(1);
  });
});

describe("a write of some of a row's columns", () => {
  test("is made to the row held, without the database, and leaves the other columns", async () => {
    await sheets.get("hero");
    await sheets.patch("hero", { xp: 40 });
    expect(await sheets.get("hero")).toEqual({ hp: 10, xp: 40 });
    expect(reads).toEqual(["sheets hero"]);
  });

  test("holds a copy of what it was given", async () => {
    const nested = rowCache<{ config: Record<string, string> | null }>("test_nested", async () => ({ config: null }));
    await nested.get("k");
    const config = { a: "sword" };
    await nested.patch("k", { config });
    config.a = "mine";
    expect(await nested.get("k")).toEqual({ config: { a: "sword" } });
  });

  test("to a row that is not held reads nothing: the next get loads what was written", async () => {
    database.sheets.hero = { hp: 10, xp: 40 };
    await sheets.patch("hero", { xp: 40 });
    expect(reads).toEqual([]);
    expect(await sheets.get("hero")).toEqual({ hp: 10, xp: 40 });
    expect(reads).toEqual(["sheets hero"]);
  });

  test("two at the same moment never leave one of them out", async () => {
    await sheets.get("hero");
    // As the writers do: the database first.
    database.sheets.hero = { hp: 7, xp: 40 };
    await Promise.all([sheets.patch("hero", { hp: 7 }), sheets.patch("hero", { xp: 40 })]);
    expect(await sheets.get("hero")).toEqual({ hp: 7, xp: 40 });
  });

  test("made at the same moment as a whole row is written does not undo it", async () => {
    await sheets.get("hero");
    database.sheets.hero = { hp: 1, xp: 99 };
    await Promise.all([sheets.patch("hero", { xp: 99 }), sheets.set("hero", { hp: 1, xp: 99 })]);
    expect(await sheets.get("hero")).toEqual({ hp: 1, xp: 99 });
  });

  test("that lands while the row is loading is not lost to what was read", async () => {
    const releases: Array<() => void> = [];
    let stored = { hp: 10, xp: 0 };
    const slow = rowCache<{ hp: number; xp: number }>("test_slow_sheets", () => new Promise((resolve) => {
      const read = { ...stored };
      releases.push(() => resolve(read));
    }));

    const reading = slow.get("k");
    await Promise.resolve();
    stored = { hp: 10, xp: 40 };
    await slow.patch("k", { xp: 40 });
    releases.shift()!();
    // What was read is older than the write, so it is read again.
    await new Promise((resolve) => setTimeout(resolve, 1));
    releases.shift()!();

    expect(await reading).toEqual({ hp: 10, xp: 40 });
  });

  test("to a row held as missing has it read again", async () => {
    expect(await sheets.get("newcomer")).toBeNull();
    database.sheets.newcomer = { hp: 5, xp: 1 };
    await sheets.patch("newcomer", { xp: 1 });
    expect(await sheets.get("newcomer")).toEqual({ hp: 5, xp: 1 });
    expect(reads).toEqual(["sheets newcomer", "sheets newcomer"]);
  });
});

describe("forgetting every row of a cache", () => {
  test("has each of them read again, and leaves the other caches alone", async () => {
    await sheets.get("hero");
    await bags.get("hero");
    database.sheets.hero = { hp: 3, xp: 3 };
    database.bags.hero = { slots: 8 };

    await dropAllRows("test_sheets");
    expect(await sheets.get("hero")).toEqual({ hp: 3, xp: 3 });
    expect(await bags.get("hero")).toEqual({ slots: 4 });
    expect(reads).toEqual(["sheets hero", "bags hero", "sheets hero"]);
  });

  test("does not let a row that was loading through", async () => {
    let release!: () => void;
    let stored = "old";
    const slow = rowCache<string>("test_slow_all", () => new Promise((resolve) => {
      const read = stored;
      release = () => resolve(read);
    }));

    const reading = slow.get("k");
    await Promise.resolve();
    stored = "new";
    await slow.clear();
    release();
    await new Promise((resolve) => setTimeout(resolve, 1));
    release();

    expect(await reading).toBe("new");
    expect(await slow.get("k")).toBe("new");
  });

  test("of a cache nobody made does nothing", async () => {
    await dropAllRows("test_no_such_cache");
  });
});

describe("a whole table", () => {
  test("is read at startup, then never again", async () => {
    await loadTables();
    expect(await guilds.all()).toEqual([{ id: 1, name: "Wolves" }]);
    expect(await guilds.find((guild) => guild.name === "Wolves")).toEqual({ id: 1, name: "Wolves" });
    expect(await guilds.find((guild) => guild.name === "Bears")).toBeNull();
    expect(reads).toEqual(["guilds"]);
  });

  test("is read on first use when startup did not", async () => {
    expect(await Promise.all([guilds.all(), guilds.all()])).toEqual([[{ id: 1, name: "Wolves" }], [{ id: 1, name: "Wolves" }]]);
    expect(reads).toEqual(["guilds"]);
  });

  test("takes added, changed and removed rows without the database", async () => {
    await loadTables();
    await guilds.put({ id: 2, name: "Bears" }, (guild) => guild.id === 2);
    await guilds.put({ id: 1, name: "Grey Wolves" }, (guild) => guild.id === 1);
    expect(await guilds.all()).toEqual([{ id: 1, name: "Grey Wolves" }, { id: 2, name: "Bears" }]);

    await guilds.remove((guild) => guild.id === 1);
    expect(await guilds.all()).toEqual([{ id: 2, name: "Bears" }]);
    expect(reads).toEqual(["guilds"]);
  });

  test("changes made at the same moment all land", async () => {
    await loadTables();
    await Promise.all([3, 4, 5].map((id) => guilds.put({ id, name: `g${id}` }, (guild) => guild.id === id)));
    expect((await guilds.all()).map((guild) => guild.id)).toEqual([1, 3, 4, 5]);
  });

  test("comes back as copies", async () => {
    const rows = await guilds.all();
    rows[0].name = "mine";
    rows.push({ id: 9, name: "mine" });
    expect(await guilds.all()).toEqual([{ id: 1, name: "Wolves" }]);
  });

  test("gives the rows that are asked for, as copies, without the database", async () => {
    database.guilds = [{ id: 1, name: "Wolves" }, { id: 2, name: "Bears" }, { id: 3, name: "Wolfhounds" }];
    await loadTables();
    const found = await guilds.filter((guild) => guild.name.startsWith("Wol"));
    expect(found).toEqual([{ id: 1, name: "Wolves" }, { id: 3, name: "Wolfhounds" }]);
    expect(await guilds.filter((guild) => guild.id > 9)).toEqual([]);

    found[0].name = "mine";
    expect(await guilds.find((guild) => guild.id === 1)).toEqual({ id: 1, name: "Wolves" });
    expect(reads).toEqual(["guilds"]);
  });

  test("dropped, is read again by the next read, once however many ask", async () => {
    await loadTables();
    database.guilds = [{ id: 1, name: "Wolves" }, { id: 2, name: "Bears" }];
    await guilds.drop();
    expect(reads).toEqual(["guilds"]);

    expect(await Promise.all([guilds.all(), guilds.find((guild) => guild.id === 2)])).toEqual([database.guilds, { id: 2, name: "Bears" }]);
    expect(await guilds.all()).toEqual(database.guilds);
    expect(reads).toEqual(["guilds", "guilds"]);
  });

  test("dropped, takes a change onto what the database holds, not onto what was held", async () => {
    await loadTables();
    database.guilds = [{ id: 2, name: "Bears" }];
    await guilds.drop();
    await guilds.put({ id: 3, name: "Owls" }, (guild) => guild.id === 3);
    expect(await guilds.all()).toEqual([{ id: 2, name: "Bears" }, { id: 3, name: "Owls" }]);
    expect(reads).toEqual(["guilds", "guilds"]);
  });

  test("a change that lands just after a drop does not stand in for the table", async () => {
    await loadTables();
    database.guilds = [{ id: 1, name: "Wolves" }, { id: 2, name: "Bears" }];
    // Each change finds the table held, then takes its turn behind the drop.
    await Promise.all([guilds.put({ id: 3, name: "Owls" }, (guild) => guild.id === 3), guilds.drop()]);
    expect(await guilds.all()).toEqual(database.guilds);

    await Promise.all([guilds.remove((guild) => guild.id === 1), guilds.drop()]);
    expect(await guilds.all()).toEqual(database.guilds);
    expect(reads).toEqual(["guilds", "guilds", "guilds"]);
  });

  test("dropped while the database cannot be read, is read by the first read that can", async () => {
    let fail = false;
    const flaky = tableCache<string>("test_flaky_table", async () => {
      if (fail) throw new Error("database gone");
      return ["there"];
    });
    expect(await flaky.all()).toEqual(["there"]);

    fail = true;
    await flaky.drop();
    await expect(flaky.all()).rejects.toThrow("database gone");
    fail = false;
    expect(await flaky.all()).toEqual(["there"]);
  });

  test("that could not be read again is not answered from the rows it held before", async () => {
    let stored = ["old"];
    let fail = false;
    let loads = 0;
    const flaky = tableCache<string>("test_flaky_reload", async () => {
      loads++;
      if (fail) throw new Error("database gone");
      return stored;
    });
    expect(await flaky.all()).toEqual(["old"]);

    // A write went wrong and the table is read again, but the database is still down.
    stored = ["new"];
    fail = true;
    await expect(flaky.reload()).rejects.toThrow("database gone");
    await expect(flaky.all()).rejects.toThrow("database gone");
    expect(await flaky.find(() => true).catch(() => "no answer")).toBe("no answer");

    // The first read that can reach the database reads it, once.
    fail = false;
    expect(await flaky.all()).toEqual(["new"]);
    expect(await flaky.all()).toEqual(["new"]);
    expect(loads).toBe(5);
  });
});

describe("work queued per key", () => {
  /** A piece of work that says when it starts and ends, and ends when told to. */
  function piece(log: string[], name: string) {
    let finish!: (fails?: boolean) => void;
    const work = () => new Promise<string>((resolve, reject) => {
      log.push(`${name} starts`);
      finish = (fails) => {
        log.push(`${name} ends`);
        if (fails) reject(new Error(`${name} failed`));
        else resolve(name);
      };
    });
    return { work, finish: (fails?: boolean) => finish(fails) };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1));

  test("runs one piece at a time, in the order asked, and answers each caller with its own result", async () => {
    const oneAtATime = turns();
    const log: string[] = [];
    const [a, b, c] = ["a", "b", "c"].map((name) => piece(log, name));

    const results = [oneAtATime("hero", a.work), oneAtATime("hero", b.work), oneAtATime("hero", c.work)];
    await settle();
    expect(log).toEqual(["a starts"]);
    a.finish();
    await settle();
    expect(log).toEqual(["a starts", "a ends", "b starts"]);
    b.finish();
    await settle();
    c.finish();

    expect(await Promise.all(results)).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["a starts", "a ends", "b starts", "b ends", "c starts", "c ends"]);
  });

  test("does not hold one key up for another, and takes a username in any case as one key", async () => {
    const oneAtATime = turns();
    const log: string[] = [];
    const [first, other, second] = ["first", "other", "second"].map((name) => piece(log, name));

    const results = [oneAtATime("Hero", first.work), oneAtATime("ally", other.work), oneAtATime("hero", second.work)];
    await settle();
    expect(log).toEqual(["first starts", "other starts"]);
    other.finish();
    first.finish();
    await settle();
    second.finish();

    expect(await Promise.all(results)).toEqual(["first", "other", "second"]);
    expect(log).toEqual(["first starts", "other starts", "other ends", "first ends", "second starts", "second ends"]);
  });

  test("a piece that fails is its caller's failure, and the next piece still runs", async () => {
    const oneAtATime = turns();
    const log: string[] = [];
    const [bad, good] = ["bad", "good"].map((name) => piece(log, name));

    const failing = oneAtATime("hero", bad.work);
    const following = oneAtATime("hero", good.work);
    await settle();
    bad.finish(true);
    await expect(failing).rejects.toThrow("bad failed");
    await settle();
    good.finish();

    expect(await following).toBe("good");
    expect(log).toEqual(["bad starts", "bad ends", "good starts", "good ends"]);
    // Work that throws before it has anything to wait for is no different.
    await expect(oneAtATime("hero", () => { throw new Error("at once"); })).rejects.toThrow("at once");
    expect(await oneAtATime("hero", async () => "after")).toBe("after");
  });

  test("keeps nothing for a key once its queue is empty", async () => {
    const oneAtATime = turns();
    const log: string[] = [];
    const [a, b, c] = ["a", "b", "c"].map((name) => piece(log, name));
    expect(oneAtATime.busy).toBe(0);

    const results = [oneAtATime("hero", a.work), oneAtATime("hero", b.work), oneAtATime("ally", c.work)];
    await settle();
    expect(oneAtATime.busy).toBe(2);
    c.finish();
    a.finish(true);
    await results[0].catch(() => {});
    // The queue is not empty while a piece waits or runs.
    expect(oneAtATime.busy).toBe(1);
    await settle();
    b.finish();
    await results[1];
    expect(oneAtATime.busy).toBe(0);
  });

  test("each set of queues is its own", async () => {
    const mine = turns();
    const theirs = turns();
    const log: string[] = [];
    const [a, b] = ["a", "b"].map((name) => piece(log, name));

    const results = [mine("hero", a.work), theirs("hero", b.work)];
    await settle();
    expect(log).toEqual(["a starts", "b starts"]);
    a.finish();
    b.finish();
    await Promise.all(results);
  });
});

describe("finding an online player by name", () => {
  beforeEach(() => playerCache.clear());

  test("finds them in any case, and nobody once they have left", () => {
    playerCache.add("s1", { id: "s1", username: "Hero" });
    expect(playerCache.getByUsername("hero")?.id).toBe("s1");
    expect(playerCache.getByUsername("HERO")?.id).toBe("s1");
    expect(playerCache.getByUsername("nobody")).toBeUndefined();

    playerCache.remove("s1");
    expect(playerCache.getByUsername("hero")).toBeUndefined();
  });

  test("a second login takes the name, and the first session's last writes do not take it back", () => {
    playerCache.add("old", { id: "old", username: "hero" });
    playerCache.add("new", { id: "new", username: "hero" });
    expect(playerCache.getByUsername("hero")?.id).toBe("new");

    // The old session is still written to while it is being disconnected.
    playerCache.set("old", { id: "old", username: "hero" });
    expect(playerCache.getByUsername("hero")?.id).toBe("new");

    playerCache.remove("old");
    expect(playerCache.getByUsername("hero")?.id).toBe("new");
  });

  test("a player put in with set is found too", () => {
    playerCache.set("s2", { id: "s2", username: "mage" });
    expect(playerCache.getByUsername("mage")?.id).toBe("s2");
  });
});
