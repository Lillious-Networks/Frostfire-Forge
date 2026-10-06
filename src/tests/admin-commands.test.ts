import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";
import { readFileSync } from "fs";
import { join } from "path";

// ------------------------------------------------------------ fake database
// The accounts the commands look up, and the permissions table as the real
// permissions module reads and writes it.

type Row = Record<string, any>;
let accounts: Row[];
let held: Record<string, string>;
const PERMISSION_TYPES = ["admin.*", "admin.kick", "admin.ban", "admin.warp", "server.*", "permission.*"];

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT permissions FROM permissions")) return params[0] in held ? [{ permissions: held[params[0]] }] : [];
    if (text.startsWith("INSERT INTO permissions")) held[params[0]] = params[1];
    if (text.startsWith("DELETE FROM permissions")) delete held[params[0]];
    if (text.startsWith("SELECT name FROM permission_types")) return PERMISSION_TYPES.map((name) => ({ name }));
    return [];
  },
}));

const { default: permissions } = await import("../systems/permissions");
const { clearCaches } = await import("../services/datacache");

// ------------------------------------------------------------------ harness
// The receiver cannot be imported (it starts the server), so a command is run
// from its source: the body of its case, with the names it uses handed in.

const source = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8");
const commandsAt = source.indexOf('      case "COMMAND": {');
/** The body of one chat command's case, up to the next command. */
function commandBlock(name: string): string {
  const start = source.indexOf(`\n          case "${name}":`, commandsAt);
  if (start < 0) return "";
  const body = source.indexOf("{", start);
  const end = source.indexOf('\n          case "', body);
  return source.slice(start, end < 0 ? body + 4000 : end);
}

/** What a command's body may name: the receiver's own, each one a fake here. */
const NAMES = [
  "commandName", "currentPlayer", "wt", "args", "sendPacket", "packetManager", "player", "playerCache", "permissions", "log",
  "listener", "Events", "maps", "mapPropertiesCache", "transitionPlayerToMap", "spawnBatchQueue", "despawnBatchQueue",
  "gracefulShutdown", "drainQueries", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Bun",
  "defaultMap", "resurrection", "resyncNpcChunks", "filterPlayersByMap", "spellEffects",
];
/** The receiver's module state (the restart countdown), declared as it is there. */
const moduleState = [...source.matchAll(/^let (\w+)[^\n]*;\r?$/gm)].map((match) => ({ name: match[1], line: match[0] }));
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** One command, ready to run. Its module state lasts as long as what is returned. */
function command(name: string): (names: Row) => Promise<void> {
  const block = commandBlock(name);
  if (!block) throw new Error(`The receiver has no ${name} command`);
  const state = moduleState.filter((item) => new RegExp(`\\b${item.name}\\b`).test(block)).map((item) => item.line).join("\n");
  const body = transpiler.transformSync(`${state}\nasync function run({ ${NAMES.join(", ")} }: any) { switch (commandName) {${block}\n} }`);
  return new Function(`"use strict";\n${body}\nreturn run;`)();
}

// ------------------------------------------------------------------ fixtures

let online: Record<string, any>;
let boss: any;
let mod: any;
let hero: any;
/** Every packet sent, with the connection it went to. */
let sent: Array<{ to: any; packets: any[] }>;
let emitted: any[][];
let closed: string[];
/** What the end of a shutdown did, in order. */
let ending: string[];
let spawned: any[];
let timeouts: Array<{ run: () => any; ms: number; cleared: boolean }>;
let intervals: Array<{ run: () => any; ms: number; cleared: boolean }>;
let moved: any[][];
let transitions: any[][];
/** Rows the location update reports as changed. */
let locationRows: number;

const accountOf = (username: string) => accounts.find((row) => row.username === String(username).toLowerCase());
/** The columns of an account a saved location is. */
const savedAt = (map: string, position: Row) => ({ map, position: `${Math.round(position.x)},${Math.round(position.y)}`, direction: position.direction });
/** What a connection was told, as the notifications it was sent. */
const told = (who: any) => sent.filter((entry) => entry.to === who.wt).flatMap((entry) => entry.packets).filter((packet) => packet.type === "NOTIFY").map((packet) => packet.data.message);

function connect(id: string, username: string, over: Row = {}): any {
  const live: Row = {
    id, username, isAdmin: false, permissions: [] as string[],
    location: { map: "main", position: { x: 10, y: 20, direction: "down" } },
    ...over,
  };
  live.wt = { close: () => { closed.push(username); } };
  online[id] = live;
  return live;
}

/** The names a command's body uses, standing for what the receiver has. */
function names(name: string, args: string[], over: Row = {}): Row {
  return {
    commandName: name,
    currentPlayer: boss,
    wt: boss.wt,
    args,
    sendPacket: (to: any, packets: any[]) => { sent.push({ to, packets }); },
    packetManager: {
      notify: (data: Row) => [{ type: "NOTIFY", data }],
      reconnect: () => [{ type: "RECONNECT", data: null }],
      moveXY: (data: Row) => [{ type: "MOVEXY", data }],
      playerGhost: (data: Row) => [{ type: "PLAYER_GHOST", data }],
      revive: (data: Row) => [{ type: "REVIVE", data }],
    },
    // As systems/player.ts answers: a name with no account is an empty list.
    player: {
      findPlayerInDatabase: async (username: string) => accounts.filter((row) => row.username === username.toLowerCase()).map((row) => ({ username: row.username, banned: row.banned })),
      isAdmin: async (username: string) => accountOf(username)?.role === 1,
      toggleAdmin: async (username: string) => {
        const row = accountOf(username);
        if (row) row.role = row.role ? 0 : 1;
        return row?.role === 1;
      },
      unban: async (username: string) => {
        const row = accountOf(username);
        if (row) row.banned = 0;
      },
      // A location is saved as systems/player.ts saves it: for the session with that id, or for that username.
      // A username handed to the first is no session's id, and saves nothing.
      setLocation: async (...call: any[]) => {
        moved.push(call);
        const row = online[call[0]] ? accountOf(online[call[0]].username) : undefined;
        if (!row || !locationRows) return { affectedRows: 0 };
        Object.assign(row, savedAt(call[1], call[2]));
        return { affectedRows: locationRows };
      },
      setLocationByUsername: async (username: string, map: string, position: Row) => {
        const row = accountOf(username);
        if (row) Object.assign(row, savedAt(map, position));
        return { affectedRows: row ? 1 : 0 };
      },
      synchronizeStats: async () => null,
      setDeadState: async () => {},
      clear: async () => { ending.push("player.clear"); },
    },
    playerCache: {
      list: () => online,
      get: (id: string) => online[id],
      set: (id: string, value: any) => { online[id] = value; },
    },
    permissions,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, success: () => {} },
    listener: { emit: (...event: any[]) => { emitted.push(event); } },
    Events: { GUILD_CHANGED: "onGuildChanged", PLAYER_DISCONNECT: "onPlayerDisconnect", PLAYER_RESPAWN: "onPlayerRespawn" },
    maps: [{ name: "main.json" }, { name: "cave.json" }],
    mapPropertiesCache: [{ name: "cave.json", width: 10, height: 20, tileWidth: 32, tileHeight: 32 }],
    transitionPlayerToMap: async (...call: any[]) => { transitions.push(call); },
    spawnBatchQueue: new Map(),
    despawnBatchQueue: new Map(),
    gracefulShutdown: async (reason: string) => { ending.push(`gracefulShutdown ${reason}`); },
    drainQueries: async () => { ending.push("drainQueries"); },
    setTimeout: (run: () => any, ms: number) => {
      const timer = { run, ms, cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout: (timer: any) => { if (timer) timer.cleared = true; },
    setInterval: (run: () => any, ms: number) => {
      const timer = { run, ms, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (timer: any) => { if (timer) timer.cleared = true; },
    Bun: { spawn: (...call: any[]) => { spawned.push(call); } },
    // The map a respawn goes to.
    defaultMap: "cave",
    resurrection: { clearSickness: () => {} },
    resyncNpcChunks: async () => {},
    filterPlayersByMap: (map: string) => Object.values(online).filter((live) => live.location.map === map),
    spellEffects: { broadcastEffectsUpdate: () => {} },
    ...over,
  };
}

const run = (name: string, args: string[] = [], over: Row = {}) => command(name)(names(name, args, over));

let consoleLog: ReturnType<typeof spyOn>;
beforeAll(() => {
  // The permissions module writes what it changed to the log.
  consoleLog = spyOn(console, "log").mockImplementation(() => {});
});
beforeEach(async () => {
  await clearCaches();
  online = {};
  sent = [];
  emitted = [];
  closed = [];
  ending = [];
  spawned = [];
  timeouts = [];
  intervals = [];
  moved = [];
  transitions = [];
  locationRows = 1;
  accounts = [
    { username: "ac_boss", banned: 0, role: 1 },
    { username: "ac_mod", banned: 0, role: 1 },
    { username: "ac_hero", banned: 0, role: 0 },
    { username: "ac_exile", banned: 1, role: 0 },
  ];
  held = { ac_mod: "admin.kick,admin.ban,admin.warp" };
  boss = connect("9101", "ac_boss", { isAdmin: true, permissions: ["admin.*", "server.*", "permission.*"] });
  mod = connect("9102", "ac_mod", { isAdmin: true, permissions: ["admin.kick", "admin.ban", "admin.warp"] });
  hero = connect("9103", "ac_hero");
});
afterAll(() => {
  consoleLog.mockRestore();
});

// --------------------------------------------------------------------- tests

describe("/shutdown", () => {
  test("warns, disconnects everyone, and ends the process once they are gone", async () => {
    const done = run("SHUTDOWN");
    expect(told(hero)).toEqual(["⚠️ Server shutting down - please reconnect in a few minutes ⚠️"]);
    expect(timeouts.map((timer) => timer.ms)).toEqual([5000]);
    expect(closed).toEqual([]);
    timeouts[0].run();
    await done;
    expect(closed.sort()).toEqual(["ac_boss", "ac_hero", "ac_mod"]);

    // Somebody is still being disconnected: nothing ends yet.
    expect(intervals).toHaveLength(1);
    await intervals[0].run();
    expect(ending).toEqual([]);
    expect(intervals[0].cleared).toBe(false);

    // Everyone is out: clear what a session leaves behind, let the database
    // finish what the disconnects wrote, then stop the server.
    online = {};
    await intervals[0].run();
    expect(intervals[0].cleared).toBe(true);
    expect(ending).toEqual(["player.clear", "drainQueries", "gracefulShutdown /shutdown"]);
    expect(spawned).toEqual([]);
  });

  test("is refused without its permission, and nothing is started", async () => {
    boss.permissions = ["admin.*", "permission.*"];
    await run("SHUTDOWN");
    expect(told(boss)).toEqual(["You don't have permission to use this command"]);
    expect(told(hero)).toEqual([]);
    expect(timeouts).toEqual([]);
    expect(intervals).toEqual([]);
    expect(ending).toEqual([]);
  });
});

describe("/restart", () => {
  test("counts down for 15 minutes, then disconnects everyone and ends the process", async () => {
    await run("RESTART");
    // A notice a minute, one a second for the last 30, and the restart itself.
    expect(timeouts).toHaveLength(15 + 30 + 1);
    const last = timeouts[timeouts.length - 1];
    expect(last.ms).toBe(15 * 60000);
    expect(Math.max(...timeouts.map((timer) => timer.ms))).toBe(last.ms);
    expect(closed).toEqual([]);
    expect(ending).toEqual([]);

    last.run();
    expect(closed.sort()).toEqual(["ac_boss", "ac_hero", "ac_mod"]);
    expect(intervals).toHaveLength(1);
    await intervals[0].run();
    expect(ending).toEqual([]);

    // The process ends here; whatever supervises it starts the server again.
    online = {};
    await intervals[0].run();
    expect(intervals[0].cleared).toBe(true);
    expect(ending).toEqual(["player.clear", "drainQueries", "gracefulShutdown /restart"]);
    expect(spawned).toEqual([]);
  });

  test("asked again before then, the countdown is called off", async () => {
    const restart = command("RESTART");
    await restart(names("RESTART", []));
    const scheduled = [...timeouts];
    await restart(names("RESTART", []));
    expect(scheduled.every((timer) => timer.cleared)).toBe(true);
    expect(timeouts).toHaveLength(scheduled.length);
    expect(told(hero)).toEqual(["⚠️ Server restart has been aborted ⚠️"]);
    expect(ending).toEqual([]);
  });
});

describe("/permission", () => {
  test("granting is for admins only: add and set are refused for anyone else", async () => {
    held.ac_hero = "admin.kick";
    for (const args of [
      ["add", "ac_hero", "admin.ban"],
      ["set", "ac_hero", "admin.ban"],
      // Offline: read from the database.
      ["add", "ac_exile", "admin.ban"],
    ]) {
      sent = [];
      await run("PERMISSION", args);
      expect(told(boss)).toEqual(["You can only grant permissions to admin players"]);
    }
    expect(held).toEqual({ ac_mod: "admin.kick,admin.ban,admin.warp", ac_hero: "admin.kick" });
    expect(hero.permissions).toEqual([]);
  });

  test("what a former admin still holds can be listed, removed and cleared", async () => {
    held.ac_hero = "admin.kick,admin.ban";
    hero.permissions = ["admin.kick", "admin.ban"];

    await run("PERMISSION", ["list", "ac_hero"]);
    expect(told(boss)).toEqual(["Permissions for Ac_hero: admin.kick, admin.ban"]);

    await run("PERMISSION", ["remove", "ac_hero", "admin.kick"]);
    expect(held.ac_hero).toBe("admin.ban");
    expect(hero.permissions).toEqual(["admin.ban"]);

    await run("PERMISSION", ["clear", "ac_hero"]);
    expect("ac_hero" in held).toBe(false);
    expect(hero.permissions).toEqual([]);
  });

  test("add takes a comma-separated list, and stores each name once", async () => {
    await run("PERMISSION", ["add", "ac_mod", "admin.kick,server.*"]);
    expect(held.ac_mod).toBe("admin.kick,admin.ban,admin.warp,server.*");
    expect(mod.permissions).toEqual(["admin.kick", "admin.ban", "admin.warp", "server.*"]);
  });

  test("an admin's are changed, in the database and on the player who is online", async () => {
    await run("PERMISSION", ["remove", "ac_mod", "admin.kick"]);
    expect(held.ac_mod).toBe("admin.ban,admin.warp");
    expect(mod.permissions).toEqual(["admin.ban", "admin.warp"]);
    expect(told(boss)).toEqual(["Permissions removed from Ac_mod"]);

    await run("PERMISSION", ["add", "ac_mod", "admin.kick"]);
    expect(held.ac_mod).toBe("admin.ban,admin.warp,admin.kick");
    expect(mod.permissions).toEqual(["admin.ban", "admin.warp", "admin.kick"]);
  });

  test("remove takes a comma-separated list, and removes each of them", async () => {
    await run("PERMISSION", ["remove", "ac_mod", "admin.kick,admin.ban"]);
    expect(held.ac_mod).toBe("admin.warp");
    expect(mod.permissions).toEqual(["admin.warp"]);

    // One that is not held does not stop the others.
    await run("PERMISSION", ["remove", "ac_mod", "admin.kick,", "admin.warp"]);
    expect(held.ac_mod).toBe("");
    expect(mod.permissions).toEqual([]);
  });

  test("the per-permission rules still decide who may ask", async () => {
    boss.permissions = ["admin.*"];
    await run("PERMISSION", ["remove", "ac_mod", "admin.kick"]);
    expect(told(boss)).toEqual(["Insufficient permissions for this operation"]);
    expect(held.ac_mod).toBe("admin.kick,admin.ban,admin.warp");
  });
});

describe("/warp", () => {
  test("moves the admin to the middle of the map, and says nothing to the guild or of a disconnect", async () => {
    await run("WARP", ["cave"]);
    expect(moved).toEqual([["9101", "cave", { x: 160, y: 320, direction: "down" }]]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].slice(0, 4)).toEqual([boss, "cave", { x: 160, y: 320, direction: "down" }, boss.wt]);
    expect(told(boss)).toEqual([]);
    expect(emitted).toEqual([]);
  });

  test("a location that could not be saved is said, and is not an event either", async () => {
    locationRows = 0;
    await run("WARP", ["cave"]);
    expect(transitions).toEqual([]);
    expect(told(boss)).toEqual(["Failed to update location"]);
    expect(emitted).toEqual([]);
  });

  test("takes a map only: with a player named, nobody is moved and the admin is told", async () => {
    await run("WARP", ["cave", "ac_hero"]);
    expect(told(boss)).toEqual(["Warping another player is not supported. Usage: /warp <map>"]);
    expect(moved).toEqual([]);
    expect(transitions).toEqual([]);
    expect(emitted).toEqual([]);
  });
});

describe("/unban", () => {
  test("a name with no account is answered", async () => {
    await run("UNBAN", ["ac_nobody"]);
    expect(told(boss)).toEqual(["Player not found or is not online"]);
  });

  test("a banned player is unbanned", async () => {
    await run("UNBAN", ["AC_Exile"]);
    expect(accountOf("ac_exile")!.banned).toBe(0);
    expect(told(boss)).toEqual(["Unbanned ac_exile from the server"]);
  });
});

describe("/admin", () => {
  test("a name with no account is answered, and no role is changed", async () => {
    const before = JSON.stringify(accounts);
    await run("ADMIN", ["ac_nobody"]);
    expect(told(boss)).toEqual(["Player not found"]);
    expect(JSON.stringify(accounts)).toBe(before);
  });

  test("no name at all is answered", async () => {
    await run("SETADMIN", []);
    expect(told(boss)).toEqual(["Please provide a username or ID"]);
  });

  test("flips the role of a player who is online, and of one who is not", async () => {
    await run("ADMIN", ["ac_hero"]);
    expect(accountOf("ac_hero")!.role).toBe(1);
    expect(hero.isAdmin).toBe(true);
    expect(told(boss)).toEqual(["Ac_hero is now an admin"]);
    expect(sent.some((entry) => entry.to === hero.wt && entry.packets[0].type === "RECONNECT")).toBe(true);

    sent = [];
    await run("ADMIN", ["ac_exile"]);
    expect(accountOf("ac_exile")!.role).toBe(1);
    expect(told(boss)).toEqual(["Ac_exile is now an admin"]);
  });
});

describe("no name given", () => {
  // Each of these read args[0] without checking it was there, and threw.
  test("/kick and /ban ask for one", async () => {
    for (const name of ["KICK", "DISCONNECT", "BAN"]) {
      sent = [];
      await run(name, []);
      expect(told(boss)).toEqual(["Please provide a username or ID"]);
    }
    expect(closed).toEqual([]);
  });

  test("/respawn respawns the admin who asked", async () => {
    await run("RESPAWN", []);
    // Where they now stand is saved, not only shown.
    expect(accountOf("ac_boss")).toMatchObject({ map: "cave", position: "160,320", direction: "down" });
    expect(boss.location.position).toEqual({ x: 160, y: 320, direction: "down" });
    expect(told(boss)).toEqual(["Respawned Ac_boss"]);
    expect(emitted.map((event) => event[0])).toEqual(["onPlayerRespawn"]);
  });
});

describe("/respawn", () => {
  test("of another player who is online moves them and saves where they are, by name or by connection id", async () => {
    for (const identifier of ["AC_Hero", "9103"]) {
      delete accountOf("ac_hero")!.position;
      hero.location.position = { x: 10, y: 20, direction: "up" };
      sent = [];
      emitted = [];

      await run("RESPAWN", [identifier]);

      expect(accountOf("ac_hero")).toMatchObject({ map: "cave", position: "160,320", direction: "down" });
      expect(hero.location.position).toEqual({ x: 160, y: 320, direction: "down" });
      expect(told(boss)).toEqual(["Respawned Ac_hero"]);
      expect(emitted).toEqual([["onPlayerRespawn", { player: hero, mapName: "main", x: 160, y: 320 }]]);
    }
  });

  test("of a player who is offline saves it for their next login, and nobody is announced as respawned", async () => {
    await run("RESPAWN", ["ac_exile"]);

    expect(accountOf("ac_exile")).toMatchObject({ map: "cave", position: "160,320", direction: "down" });
    expect(told(boss)).toEqual(["Respawned Ac_exile"]);
    // There is no player in the world to respawn.
    expect(emitted).toEqual([]);
  });

  test("of a name with no account is answered, and nothing is saved", async () => {
    const before = JSON.stringify(accounts);
    await run("RESPAWN", ["ac_nobody"]);
    expect(told(boss)).toEqual(["Player not found"]);
    expect(JSON.stringify(accounts)).toBe(before);
    expect(emitted).toEqual([]);
  });

  test("is refused without its permission", async () => {
    boss.permissions = ["admin.kick"];
    await run("RESPAWN", ["ac_hero"]);
    expect(told(boss)).toEqual(["You don't have permission to use this command"]);
    expect(accountOf("ac_hero")!.position).toBeUndefined();
  });
});
