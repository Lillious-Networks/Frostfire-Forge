import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";
import { readFileSync } from "fs";
import { join } from "path";

// ------------------------------------------------------------ fake database
// The two statements the whitelist switch sends, run against an in-memory
// table. A statement it does not know is an error, so a read that is not the
// load of the list fails the test that made it.

type Row = { realm: string; username: string };
let table: Row[];
/** Every statement sent, with its values, in order. */
let queries: Array<[string, any[]]>;
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null;

const SELECT = "SELECT username FROM whitelist WHERE realm = ?";
const INSERT = "INSERT INTO whitelist (realm, username) VALUES (?, ?)";
const REALM = "wl_test_realm";

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    queries.push([sql, params]);
    if (failing?.test(sql)) throw new Error("Connection lost");
    // The wait a real database call gives a second request.
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (sql === SELECT) return table.filter((row) => row.realm === params[0]).map((row) => ({ username: row.username }));
    if (sql === INSERT) {
      table.push({ realm: params[0], username: params[1] });
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected statement: ${sql}`);
  },
}));

const whitelist = await import("../services/whitelist");

/** The login check, as receiver.ts writes it (the receiver cannot be imported: it starts the server). */
const LOGIN_CHECK = "if (isWhitelistEnabled() && !realmWhitelist.has(playerData.username.toLowerCase())) {";
const letsIn = (username: string) => !(whitelist.isWhitelistEnabled() && !whitelist.realmWhitelist.has(username.toLowerCase()));
const sent = () => queries.map(([sql]) => sql);

const switched: boolean[] = [];
whitelist.onWhitelistSwitch((enabled) => switched.push(enabled));

let realmBefore: string | undefined;
let consoleLog: ReturnType<typeof spyOn>;
let consoleError: ReturnType<typeof spyOn>;
beforeAll(() => {
  realmBefore = process.env.SERVER_ID;
  process.env.SERVER_ID = REALM;
  // Every switch is logged, every failure is an error.
  consoleLog = spyOn(console, "log").mockImplementation(() => {});
  consoleError = spyOn(console, "error").mockImplementation(() => {});
});
beforeEach(async () => {
  failing = null;
  table = [
    { realm: REALM, username: "Wl_Alice" },
    { realm: REALM, username: "wl_bob" },
    { realm: "another_realm", username: "wl_carol" },
  ];
  queries = [];
  // The module is shared with the other test files: start each case off and empty.
  await whitelist.setWhitelistEnabled(false);
  whitelist.realmWhitelist.clear();
  queries = [];
  switched.length = 0;
});
afterAll(async () => {
  await whitelist.setWhitelistEnabled(false);
  whitelist.realmWhitelist.clear();
  if (realmBefore === undefined) delete process.env.SERVER_ID;
  else process.env.SERVER_ID = realmBefore;
  consoleLog.mockRestore();
  consoleError.mockRestore();
});

describe("turning the whitelist on while the server runs", () => {
  test("off, nobody is checked and nothing was loaded", () => {
    expect(whitelist.isWhitelistEnabled()).toBe(false);
    expect(whitelist.realmWhitelist.size).toBe(0);
    expect(letsIn("wl_stranger")).toBe(true);
  });

  test("the usernames of this realm are loaded first, then logins are checked", async () => {
    const result = await whitelist.setWhitelistEnabled(true);
    expect(result.success).toBe(true);
    expect(sent()).toEqual([SELECT]);
    expect(queries[0][1]).toEqual([REALM]);
    expect(whitelist.isWhitelistEnabled()).toBe(true);
    expect([...whitelist.realmWhitelist].sort()).toEqual(["wl_alice", "wl_bob"]);
    expect(letsIn("WL_Alice")).toBe(true);
    expect(letsIn("wl_carol")).toBe(false);
    expect(letsIn("wl_stranger")).toBe(false);
    expect(result.message).toContain("Whitelist is on with 2 names.");
  });

  test("the admin who turns it on is put on the list: the database, then the set", async () => {
    const result = await whitelist.setWhitelistEnabled(true, "WL_Admin");
    expect(result.success).toBe(true);
    expect(queries).toEqual([[SELECT, [REALM]], [INSERT, [REALM, "wl_admin"]]]);
    expect(table).toContainEqual({ realm: REALM, username: "wl_admin" });
    expect(letsIn("wl_admin")).toBe(true);
    expect(result.message).toContain("Whitelist is on with 3 names (you were added).");
  });

  test("an admin already on the list is not written again", async () => {
    const result = await whitelist.setWhitelistEnabled(true, "wl_alice");
    expect(sent()).toEqual([SELECT]);
    expect(result.message).not.toContain("you were added");
    expect(whitelist.realmWhitelist.size).toBe(2);
  });

  test("the answer says who is affected and that it does not outlast a restart", async () => {
    const on = await whitelist.setWhitelistEnabled(true, "wl_alice");
    expect(on.message).toContain("Players already online stay, new logins are checked.");
    expect(on.message).toContain("This lasts until the server restarts");
    const off = await whitelist.setWhitelistEnabled(false, "wl_alice");
    expect(off.message).toContain("Whitelist is off: anyone can log in.");
    expect(off.message).toContain("This lasts until the server restarts");
  });

  test("a list that cannot be read leaves the whitelist off", async () => {
    failing = /^SELECT/;
    const result = await whitelist.setWhitelistEnabled(true, "wl_admin");
    expect(result).toEqual({ success: false, message: "The whitelist could not be read from the database, so it was left off" });
    expect(whitelist.isWhitelistEnabled()).toBe(false);
    expect(letsIn("wl_stranger")).toBe(true);
    expect(switched).toEqual([]);
  });

  test("an admin who cannot be put on the list leaves the whitelist off: nobody locks themselves out", async () => {
    failing = /^INSERT/;
    const result = await whitelist.setWhitelistEnabled(true, "wl_admin");
    expect(result.success).toBe(false);
    expect(whitelist.isWhitelistEnabled()).toBe(false);
    expect(whitelist.realmWhitelist.has("wl_admin")).toBe(false);
    expect(switched).toEqual([]);
  });

  test("two admins at once: it is turned on once", async () => {
    const [first, second] = await Promise.all([whitelist.setWhitelistEnabled(true, "wl_alice"), whitelist.setWhitelistEnabled(true, "wl_bob")]);
    expect(first.success).toBe(true);
    expect(second).toEqual({ success: false, message: "Whitelist is already on" });
    expect(sent()).toEqual([SELECT]);
    expect(switched).toEqual([true]);
  });
});

describe("turning it off, and on again", () => {
  test("off stops the check without touching the database or the list", async () => {
    await whitelist.setWhitelistEnabled(true);
    queries = [];
    const result = await whitelist.setWhitelistEnabled(false, "wl_alice");
    expect(result.success).toBe(true);
    expect(queries).toEqual([]);
    expect(whitelist.isWhitelistEnabled()).toBe(false);
    expect(whitelist.realmWhitelist.size).toBe(2);
    expect(letsIn("wl_stranger")).toBe(true);
  });

  test("asking for how things already stand changes nothing and reads nothing", async () => {
    expect(await whitelist.setWhitelistEnabled(false)).toEqual({ success: false, message: "Whitelist is already off" });
    await whitelist.setWhitelistEnabled(true);
    queries = [];
    switched.length = 0;
    expect(await whitelist.setWhitelistEnabled(true, "wl_admin")).toEqual({ success: false, message: "Whitelist is already on" });
    expect(queries).toEqual([]);
    expect(switched).toEqual([]);
  });

  test("on again reads the list again: what the database holds now is what is enforced", async () => {
    await whitelist.setWhitelistEnabled(true);
    await whitelist.setWhitelistEnabled(false);
    table = table.filter((row) => row.username !== "wl_bob");
    table.push({ realm: REALM, username: "wl_dave" });
    await whitelist.setWhitelistEnabled(true);
    expect([...whitelist.realmWhitelist].sort()).toEqual(["wl_alice", "wl_dave"]);
    expect(letsIn("wl_bob")).toBe(false);
  });

  test("whoever listens is told each time it is switched", async () => {
    await whitelist.setWhitelistEnabled(true);
    await whitelist.setWhitelistEnabled(false);
    await whitelist.setWhitelistEnabled(true);
    expect(switched).toEqual([true, false, true]);
  });

  test("a listener that throws does not undo the switch or stop the others", async () => {
    const heard: boolean[] = [];
    let broken = true;
    whitelist.onWhitelistSwitch(() => {
      if (broken) throw new Error("gateway away");
    });
    whitelist.onWhitelistSwitch((enabled) => heard.push(enabled));
    expect((await whitelist.setWhitelistEnabled(true)).success).toBe(true);
    broken = false;
    expect(whitelist.isWhitelistEnabled()).toBe(true);
    expect(heard).toEqual([true]);
  });
});

describe("everything that reads the switch reads the live value", () => {
  const read = (...path: string[]) => readFileSync(join(import.meta.dir, "..", ...path), "utf8").replaceAll("\r\n", "\n");
  const receiver = read("socket", "receiver.ts");
  const server = read("socket", "server.ts");
  const gateway = read("modules", "gateway-client.ts");

  test("the login check, the /whitelist command and the control panel status call it", () => {
    expect(receiver).toContain(LOGIN_CHECK);
    expect(receiver).toContain("if (!isWhitelistEnabled()) {");
    expect(receiver).toContain("whitelistEnabled: isWhitelistEnabled(),");
    // Never the value itself: a copy taken at import would not change.
    expect(receiver.match(/isWhitelistEnabled(?!\(\)|,)/g)).toBeNull();
  });

  test("nothing keeps a copy made at startup", () => {
    expect(server).not.toContain("export const isWhitelistEnabled");
    expect(server).not.toContain("export const realmWhitelist");
    expect(server).toContain("if (isWhitelistEnabled()) {");
    for (const file of [receiver, server, gateway, read("systems", "player.ts")]) {
      expect(file).not.toContain("process.env.WHITELIST");
    }
  });

  test("the gateway is told when registering, on every heartbeat, and at once when it is switched", () => {
    expect(gateway.match(/whitelisted: isWhitelistEnabled\(\)/g)?.length).toBe(2);
    expect(server).toContain("onWhitelistSwitch(() => {\n  void gatewayClient?.heartbeatNow();\n});");
  });
});
