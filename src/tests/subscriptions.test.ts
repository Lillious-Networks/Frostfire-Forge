import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { databaseModule } from "./setup";

// ------------------------------------------------------------ fake database
// A real in-memory SQLite database behind the engine's query function, so the
// statements of the subscription step and the login read are run, not matched.
// A table the test did not create is an empty one (the login reads many).

let db: Database;
const queries: string[] = [];

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    queries.push(sql);
    try {
      const statement = db.query(sql);
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params);
      statement.run(...params);
      return { affectedRows: 1 };
    } catch (error: any) {
      if (/no such table/.test(String(error?.message))) return [];
      throw error;
    }
  },
}));

const { clearCaches, reloadTable } = await import("../services/datacache");
const subs = await import("../systems/subscriptions");
const { default: player } = await import("../systems/player");

/** accounts as a database set up before this feature has it: no subscription column. */
const OLD_ACCOUNTS = `CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
  map TEXT DEFAULT 'overworld', position TEXT DEFAULT '0,0', direction TEXT DEFAULT 'down',
  role INTEGER DEFAULT 0, guest_mode INTEGER DEFAULT 0, stealth INTEGER DEFAULT 0, noclip INTEGER DEFAULT 0,
  party_id INTEGER, guild_id INTEGER, is_dead INTEGER DEFAULT 0, corpse_map TEXT, corpse_x INTEGER, corpse_y INTEGER
)`;

const columns = () => (db.query("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).map((c) => c.name);
const tick = async (enabled: number) => {
  db.run("UPDATE subscription_status SET enabled = ? WHERE id = 1", [enabled]);
  await reloadTable("subscription_status");
  await subs.refreshSubscriptions();
};

let engineBefore: string | undefined;
let consoleLog: ReturnType<typeof spyOn>;
beforeAll(() => {
  engineBefore = process.env.DATABASE_ENGINE;
  process.env.DATABASE_ENGINE = "sqlite";
  consoleLog = spyOn(console, "log").mockImplementation(() => {});
});
beforeEach(async () => {
  db = new Database(":memory:");
  db.run(OLD_ACCOUNTS);
  queries.length = 0;
  await clearCaches();
});
afterAll(async () => {
  // Leave the module as found: no schema, so nothing is read or locked for the files that follow.
  db.close();
  await subs.ensureSubscriptionSchema();
  await clearCaches();
  await subs.refreshSubscriptions();
  // The stand-in outlives this file (see setup.ts): leave it answering with empty tables, not with a closed database.
  db = new Database(":memory:");
  if (engineBefore === undefined) delete process.env.DATABASE_ENGINE;
  else process.env.DATABASE_ENGINE = engineBefore;
  consoleLog.mockRestore();
});

const paid = { isAdmin: false, isGuest: false, isSubscribed: true };
const unpaid = { isAdmin: false, isGuest: false, isSubscribed: false };

describe("the start-time schema step", () => {
  test("adds what is missing, changes nothing when run again, and never throws", async () => {
    expect(await subs.ensureSubscriptionSchema()).toBe(true);
    expect(columns()).toEqual(expect.arrayContaining(["subscribed", "stripe_customer_id", "subscription_ends"]));
    db.run("INSERT INTO accounts (username) VALUES ('early')");
    expect(db.query("SELECT subscribed FROM accounts").get()).toEqual({ subscribed: 0 });
    expect(db.query("SELECT id, enabled FROM subscription_status").all()).toEqual([{ id: 1, enabled: 0 }]);
    db.run("INSERT INTO subscription_locks (name) VALUES ('chat')");

    // Run again (the next start): the columns, the lock and the status row are as they were.
    expect(await subs.ensureSubscriptionSchema()).toBe(true);
    expect(columns().filter((name) => name === "subscribed")).toHaveLength(1);
    expect(db.query("SELECT name FROM subscription_locks").all()).toEqual([{ name: "chat" }]);
    expect(db.query("SELECT COUNT(*) AS n FROM subscription_status").get()).toEqual({ n: 1 });

    // A database that cannot be changed: one warning, subscriptions stay off, the start goes on.
    db.close();
    expect(await subs.ensureSubscriptionSchema()).toBe(false);
    expect(subs.subscriptionsReady()).toBe(false);
  });
});

describe("the lock rule", () => {
  test("locks bite only while the Gateway has subscriptions switched on", async () => {
    await subs.ensureSubscriptionSchema();
    expect((await subs.setLock("chat", true)).success).toBe(true);
    // Ticked, but the status row says off: nobody is locked.
    expect(subs.refusal(unpaid, "chat")).toBeNull();
    expect(subs.subscriptionState().enabled).toBe(false);

    await tick(1);
    expect(subs.refusal(unpaid, "chat")).toBe("A subscription is needed for this.");
    // Only what is ticked, and only for the id asked.
    expect(subs.refusal(unpaid, "whisper")).toBeNull();
    expect(subs.subscriptionState().locks).toEqual(["chat"]);

    await tick(0);
    expect(subs.refusal(unpaid, "chat")).toBeNull();
  });

  test("an admin and a subscribed player are never locked", async () => {
    await subs.ensureSubscriptionSchema();
    await subs.setLock("login", true);
    await subs.setLock("trade", true);
    await tick(1);
    expect(subs.refusal(unpaid, "login")).not.toBeNull();
    expect(subs.refusal({ ...unpaid, isAdmin: true }, "login")).toBeNull();
    expect(subs.refusal({ ...unpaid, isAdmin: true }, "trade")).toBeNull();
    expect(subs.refusal(paid, "login")).toBeNull();
    expect(subs.refusal(paid, "trade")).toBeNull();
    // Nobody to ask about is nobody to lock.
    expect(subs.refusal(undefined, "login")).toBeNull();
  });

  test("a guest counts as not subscribed", async () => {
    await subs.ensureSubscriptionSchema();
    await subs.setLock("mount", true);
    await tick(1);
    expect(subs.refusal({ isAdmin: false, isGuest: true, isSubscribed: false }, "mount")).not.toBeNull();
    // Even a flag that somehow reads as paid does not unlock a guest.
    expect(subs.refusal({ isAdmin: false, isGuest: true, isSubscribed: true }, "mount")).not.toBeNull();
  });

  test("a change is written to the database first, then the checks follow", async () => {
    await subs.ensureSubscriptionSchema();
    await tick(1);
    expect((await subs.setLock("loot", true)).success).toBe(true);
    expect(db.query("SELECT name FROM subscription_locks").all()).toEqual([{ name: "loot" }]);
    expect(subs.refusal(unpaid, "loot")).not.toBeNull();
    expect((await subs.setLock("loot", false)).success).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM subscription_locks").get()).toEqual({ n: 0 });
    expect(subs.refusal(unpaid, "loot")).toBeNull();
    // An id that is not one of the locks is refused and writes nothing.
    queries.length = 0;
    expect((await subs.setLock("flying", true)).success).toBe(false);
    expect(queries).toEqual([]);
  });
});

describe("the flag at login", () => {
  test("is read from accounts.subscribed, and a database without it counts everyone as subscribed", async () => {
    db.run("INSERT INTO accounts (username) VALUES ('login_paid'), ('login_free')");
    // Before the column exists: the login still works, and nobody is locked by it.
    expect(((await player.GetPlayerLoginData("login_free")) as any).isSubscribed).toBe(true);

    await subs.ensureSubscriptionSchema();
    db.run("UPDATE accounts SET subscribed = 1 WHERE username = 'login_paid'");
    expect(((await player.GetPlayerLoginData("login_paid")) as any).isSubscribed).toBe(true);
    expect(((await player.GetPlayerLoginData("login_free")) as any).isSubscribed).toBe(false);
  });
});
