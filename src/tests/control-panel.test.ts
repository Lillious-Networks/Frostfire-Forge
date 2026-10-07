import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";
import { readFileSync } from "fs";
import { join } from "path";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// ------------------------------------------------------------ fake database
// The panel only reads: accounts, permissions and loot tables. Anything else
// answers with no rows.

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
const queries: string[] = [];

function run(sql: string, params: any[] = []): any {
  const text = sql.replace(/\s+/g, " ").trim();
  queries.push(text);
  // The two reads the report system fills itself with.
  if (text.includes("FROM reports WHERE status = 'open'")) return (tables.reports || []).filter((row) => row.status === "open").map((row) => ({ ...row }));
  if (text.includes("FROM reports WHERE status = 'resolved'")) return (tables.reports || []).filter((row) => row.status === "resolved").map((row) => ({ ...row }));
  // The dashboard's two counts of the accounts table, guests aside.
  if (text.startsWith("SELECT COUNT(*) AS registered")) {
    const real = tables.accounts.filter((row) => (row.guest_mode ?? 0) == params[0]);
    return [{ registered: real.length, banned: String(real.filter((row) => row.banned === 1).length) }];
  }
  const select = text.match(/^SELECT .+? FROM (\w+)(?: WHERE (\w+) (=|LIKE) \?)?/);
  if (!select) return [];
  const [, table, column, op] = select;
  const rows = tables[table] || [];
  if (!column) return rows.map((row) => ({ ...row }));
  const wanted = params[0];
  return rows
    .filter((row) => (op === "LIKE" ? String(row[column]).includes(String(wanted).replaceAll("%", "")) : row[column] == wanted))
    .map((row) => ({ ...row }));
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => run(sql, params),
}));

const assets = new Map<string, any>([
  ["items", [{ name: "Iron Helmet", quality: "common", type: "equipment", icon: "iron_helmet", equipment_slot: "helmet", level_requirement: 1 }]],
  ["mapProperties", [{ name: "overworld.json", width: 100, height: 50, tileWidth: 32, tileHeight: 32 }, { name: "cave.json", width: 10, height: 10, tileWidth: 32, tileHeight: 32 }]],
  ["weather", [{ name: "rain" }, { name: "snow" }]],
]);
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => assets.get(key),
    set: async (key: string, value: any) => assets.set(key, value),
    add: async (key: string, value: any) => assets.set(key, value),
  },
}));

const { default: playerCache } = await import("../services/playermanager");
const { clearCaches, dropRows, loadTables } = await import("../services/datacache");
const { packetManager } = await import("../socket/packet_manager");
const { oneAtATime } = await import("../systems/playereditor");
const panel = await import("../systems/controlpanel");
type PanelRun = import("../systems/controlpanel").PanelRun;

// ------------------------------------------------------------------ fixtures

const EVERYTHING = ["admin.*", "server.*", "permission.*", "tools.*"];
const SESSIONS = ["7101", "7102", "7103", "7104", "7105"];

/** Put a player online. The cache is shared: other test files leave their players in it. */
function online(id: string, username: string, over: Row = {}): any {
  const live = {
    id, userid: Number(id) + 1000, username, isAdmin: false, isGuest: false, isStealth: false, isNoclip: false, isDead: false, isGhost: false,
    permissions: [] as string[], stats: { level: 3 },
    location: { map: "overworld.json", position: { x: 10, y: 20, direction: "down" } },
    ...over,
  };
  playerCache.add(id, live);
  return live;
}

let boss: any;
let mod: any;
let sneak: any;
let hero: any;
let restartScheduled: boolean;
let whitelistOn: boolean;
/** What the server is measuring: the readings of the history are taken from these. */
let lagMs: number;
let awake: number;
/** What the panel asked the receiver to run, in order. */
let ran: Array<{ by: string; run: PanelRun }>;
/** Commands that answer with something other than "<command> done". */
let replies: Record<string, string[]>;

const accountOf = (username: string) => tables.accounts.find((row) => row.username === username)!;
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/**
 * Stands in for the receiver. The commands the panel has to be careful with
 * do here what they do there: the admin packets and /admin and /restart flip
 * what they find, after the wait a database call gives a second request.
 */
const receiver = (actor: any) => async (asked: PanelRun): Promise<string[]> => {
  ran.push({ by: actor.username, run: asked });
  await tick();
  if ("packet" in asked) {
    const flag = asked.packet === "NOCLIP" ? "isNoclip" : "isStealth";
    actor[flag] = !actor[flag];
    return [];
  }
  switch (asked.command) {
    case "ADMIN": {
      const row = accountOf(asked.args[0]);
      row.role = row.role ? 0 : 1;
      // /admin writes through the player system, which leaves the account it holds with the new role.
      await dropRows("accounts", asked.args[0]);
      return [`${asked.args[0]} is now ${row.role ? "an admin" : "not an admin"}`];
    }
    case "RESTART":
      restartScheduled = !restartScheduled;
      return restartScheduled ? [] : ["Server restart has been aborted"];
    case "WHITELIST":
      // /whitelist on and off say where the switch now stands; add and remove answer like any other command.
      if (asked.args[0] !== "on" && asked.args[0] !== "off") return replies.WHITELIST ?? ["WHITELIST done"];
      whitelistOn = asked.args[0] === "on";
      return [`Whitelist is ${asked.args[0]}`];
    case "BROADCAST":
      return [asked.args[1]];
    default:
      return replies[asked.command] ?? [`${asked.command} done`];
  }
};

let nextRequest = 0;
const act = async (actor: any, action: string, data: Row = {}, requestId: string | null = `r${++nextRequest}`) => {
  const result = await panel.handlePanelPacket(actor, "CONTROL_PANEL_ACTION", { action, requestId, ...data }, receiver(actor));
  if (result.kind !== "result") throw new Error("An action answers with a result");
  return result.data;
};
const commands = () => ran.map((entry) => ("packet" in entry.run ? entry.run.packet : [entry.run.command, ...entry.run.args].join(" ")));

const bridge = {
  restartScheduled: () => restartScheduled,
  status: () => ({ eventLoopLagMs: lagMs, whitelistEnabled: whitelistOn, whitelisted: 4, creatures: { creatures: 12, awake } }),
  worlds: async () => [
    { name: "overworld", weather: "random", showing: "rain", conditions: { temperature: 55, humidity: 70, wind_speed: 8, wind_direction: "left", precipitation: 60 }, players: 3 },
    { name: "cave", weather: "clear", showing: "clear", conditions: null, players: 0 },
  ],
};
panel.setControlPanelBridge(bridge);

let consoleLog: ReturnType<typeof spyOn>;
let consoleWarn: ReturnType<typeof spyOn>;
beforeAll(() => {
  // Every action is written to the audit log, every refusal is a warning.
  consoleLog = spyOn(console, "log").mockImplementation(() => {});
  consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
});
beforeEach(async () => {
  for (const id of SESSIONS) playerCache.remove(id);
  panel.forgetHistory();
  // The accounts are put back below: what a case before this one left held of them is not theirs.
  await clearCaches();
  queries.length = 0;
  ran = [];
  replies = {};
  restartScheduled = false;
  whitelistOn = true;
  lagMs = 1.6;
  awake = 5;
  tables = {
    accounts: [
      { id: 8101, username: "cp_boss", session_id: "7101", banned: 0, is_dead: 0, role: 1 },
      { id: 8102, username: "cp_mod", session_id: "7102", banned: 0, is_dead: 0, role: 1 },
      { id: 8103, username: "cp_sneak", session_id: "7103", banned: 0, is_dead: 0, role: 1 },
      { id: 8104, username: "cp_hero", session_id: "7104", banned: 0, is_dead: 0, role: 0 },
      { id: 8105, username: "cp_exile", session_id: null, banned: 1, is_dead: 0, role: 0 },
    ],
    // What the database holds: the permissions the panel lists and changes.
    permissions: [{ username: "cp_mod", permissions: "admin.kick,admin.ban" }, { username: "cp_boss", permissions: EVERYTHING.join(",") }],
    permission_types: ["admin.*", "admin.kick", "admin.ban", "server.*"].map((name) => ({ name })),
    loot_tables: [{ id: 3, name: "Bandit", created_at: null }],
    loot_table_items: [{ id: 31, loot_table_id: 3, item_name: "Iron Helmet", min_quantity: 1, max_quantity: 2, drop_chance: 50, quality: "common" }],
  };
  // As at startup: the tables the server holds whole are read before anyone opens the panel.
  await loadTables();
  queries.length = 0;
  boss = online("7101", "cp_boss", { isAdmin: true, permissions: [...EVERYTHING] });
  mod = online("7102", "cp_mod", { isAdmin: true, permissions: ["admin.kick", "admin.ban"] });
  sneak = online("7103", "cp_sneak", { isAdmin: true, isStealth: true, stats: { level: 60 }, location: { map: "cave.json", position: { x: 0, y: 0 } } });
  hero = online("7104", "cp_hero");
});
afterAll(() => {
  consoleLog.mockRestore();
  consoleWarn.mockRestore();
  for (const id of SESSIONS) playerCache.remove(id);
  panel.setControlPanelBridge(null);
});

// ---------------------------------------------------- the rules, by action
// What each control needs: one name from every group, or the admin role. This
// is the table the report is written from.

type Needs = { command: string; groups?: string[][]; role?: boolean; confirm?: boolean };
const COMMAND_RULE = ["admin.permission", "admin.*"];
const RULES: Record<string, Needs> = {
  "self.noclip": { command: "NOCLIP", role: true },
  "self.stealth": { command: "STEALTH", role: true },
  "player.summon": { command: "SUMMON", groups: [["admin.summon", "admin.*"]] },
  "player.goto": { command: "TELEPORT", groups: [["admin.summon", "admin.*"]] },
  "player.respawn": { command: "RESPAWN", groups: [["admin.respawn", "admin.*"]] },
  "player.revive": { command: "REVIVE", groups: [["admin.revive", "admin.*"]] },
  "player.kill": { command: "KILL", groups: [["admin.kill", "admin.*"]], confirm: true },
  "player.kick": { command: "KICK", groups: [["admin.kick", "admin.*"]], confirm: true },
  "player.ban": { command: "BAN", groups: [["admin.ban", "admin.*"]], confirm: true },
  "player.unban": { command: "UNBAN", groups: [["admin.unban", "admin.*"]] },
  "player.mute": { command: "MUTE", groups: [["admin.mute", "admin.*"]] },
  "player.unmute": { command: "UNMUTE", groups: [["admin.unmute", "admin.*"]] },
  "report.resolve": { command: "REPORTS", groups: [["admin.reports", "admin.*"]] },
  "player.admin": { command: "ADMIN", groups: [["server.admin", "server.*"]], confirm: true },
  "player.give": { command: "GIVE", groups: [["admin.items", "admin.*"]] },
  "permission.add": { command: "PERMISSION", groups: [COMMAND_RULE, ["permission.add", "permission.*"]], confirm: true },
  "permission.remove": { command: "PERMISSION", groups: [COMMAND_RULE, ["permission.remove", "permission.*"]], confirm: true },
  "permission.set": { command: "PERMISSION", groups: [COMMAND_RULE, ["permission.add", "permission.*"]], confirm: true },
  "permission.clear": { command: "PERMISSION", groups: [COMMAND_RULE, ["permission.remove", "permission.*"]], confirm: true },
  "server.broadcast": { command: "BROADCAST", groups: [["server.notify", "server.*"]] },
  "server.whitelist.on": { command: "WHITELIST", groups: [["admin.whitelist", "admin.*"]] },
  "server.whitelist.off": { command: "WHITELIST", groups: [["admin.whitelist", "admin.*"]] },
  "server.whitelist.add": { command: "WHITELIST", groups: [["admin.whitelist", "admin.*"]] },
  "server.whitelist.remove": { command: "WHITELIST", groups: [["admin.whitelist", "admin.*"]] },
  "server.restart": { command: "RESTART", groups: [["server.restart", "server.*"]], confirm: true },
  "server.restart.cancel": { command: "RESTART", groups: [["server.restart", "server.*"]] },
  "server.shutdown": { command: "SHUTDOWN", groups: [["server.shutdown", "server.*"]], confirm: true },
  "world.reloadmap": { command: "RELOADMAP", groups: [["admin.reloadmap", "admin.*"]] },
  "world.warp": { command: "WARP", groups: [["admin.warp", "admin.*"]] },
  "world.weather": { command: "WEATHER", groups: [["admin.weather", "admin.*"]] },
  "item.drop": { command: "DROP", groups: [["admin.items", "admin.*"]] },
  "chest.spawn": { command: "SPAWNCHEST", groups: [["admin.items", "admin.*"]] },
  "loot.create": { command: "LOOTTABLE", groups: [["admin.loot", "admin.*"]] },
  "loot.delete": { command: "LOOTTABLE", groups: [["admin.loot", "admin.*"]], confirm: true },
  "loot.additem": { command: "LOOTTABLE", groups: [["admin.loot", "admin.*"]] },
  "loot.removeitem": { command: "LOOTTABLE", groups: [["admin.loot", "admin.*"]] },
  "loot.updateitem": { command: "LOOTTABLE", groups: [["admin.loot", "admin.*"]] },
};

/** A request for each action that passes its own checks, so only the rule can stop it. */
const VALID: Record<string, Row> = {
  "self.noclip": { enabled: true },
  "self.stealth": { enabled: true },
  "player.admin": { target: "cp_hero", admin: true },
  "player.unban": { target: "cp_exile" },
  "player.mute": { target: "cp_hero", duration: "30m", reason: "spam" },
  "report.resolve": { id: 4, note: "warned" },
  "player.give": { target: "cp_hero", item: "Iron Helmet", quantity: 2 },
  "permission.add": { target: "cp_mod", permission: "admin.kick" },
  "permission.remove": { target: "cp_mod", permission: "admin.kick" },
  "permission.set": { target: "cp_mod", permissions: ["admin.kick"] },
  "server.broadcast": { audience: "ALL", message: "Hello" },
  "server.whitelist.add": { target: "cp_hero" },
  "server.whitelist.remove": { target: "cp_hero" },
  "world.reloadmap": { map: "overworld" },
  "world.warp": { map: "cave" },
  "world.weather": { weather: "rain" },
  "item.drop": { item: "Iron Helmet", quantity: 1 },
  "chest.spawn": { table: 3 },
  "loot.create": { name: "Wolves" },
  "loot.delete": { id: 3 },
  "loot.additem": { id: 3, item: "Iron Helmet", min: 1, max: 2, chance: 25 },
  "loot.removeitem": { itemId: 31 },
  "loot.updateitem": { itemId: 31, min: 1, max: 2, chance: 25, quality: "rare" },
};
const valid = (action: string): Row => ({ ...(VALID[action] ?? { target: "cp_hero" }), confirm: true });

/** An admin holding exactly these. */
const holder = (permissions: string[]) => online("7105", "cp_temp", { isAdmin: true, permissions });

// The receiver cannot be imported (it starts the server), so its source is read.
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
/** The body of one packet's case. */
function packetBlock(name: string): string {
  const start = source.indexOf(`\n      case "${name}": {`);
  return start < 0 ? "" : source.slice(start, source.indexOf('\n      case "', start + 1));
}

// --------------------------------------------------------------------- tests

describe("who may use the control panel", () => {
  test("admins only, as the in-game panel it replaces", () => {
    expect(panel.canUsePanel(boss)).toBe(true);
    expect(panel.canUsePanel({ ...boss, permissions: [] })).toBe(true);
    expect(panel.canUsePanel(hero)).toBe(false);
    expect(panel.canUsePanel({ ...boss, isGuest: true })).toBe(false);
    expect(panel.canUsePanel({ isAdmin: true })).toBe(false);
    expect(panel.canUsePanel(null)).toBe(false);
  });

  test("every packet is refused for anyone else, with nothing read or run", async () => {
    // Every permission there is, without the admin role.
    hero.permissions = [...EVERYTHING];
    for (const [type, data] of [
      ["CONTROL_PANEL_LOAD", { full: true }],
      ["CONTROL_PANEL_QUERY", { kind: "lootTables" }],
      ["CONTROL_PANEL_ACTION", { action: "player.kick", target: "cp_mod", requestId: "x1", confirm: true }],
    ] as Array<[string, Row]>) {
      const result = await panel.handlePanelPacket(hero, type, data, receiver(hero));
      expect(result.kind).toBe("result");
      if (result.kind !== "result") continue;
      expect(result.data.ok).toBe(false);
      expect(result.data.denied).toBe(true);
      expect(result.data.errors).toEqual([panel.DENIED]);
    }
    expect(ran).toEqual([]);
    expect(queries).toEqual([]);
  });
});

describe("each control keeps its command's permission rule", () => {
  test("the table covers every action, and every action names a command the receiver has", () => {
    expect(Object.keys(panel.ACTIONS).sort()).toEqual(Object.keys(RULES).sort());
    for (const [action, needs] of Object.entries(RULES)) {
      expect(panel.ACTIONS[action].command).toBe(needs.command);
      expect(!!panel.ACTIONS[action].confirm).toBe(!!needs.confirm);
      const block = needs.role ? packetBlock(needs.command) : commandBlock(needs.command);
      expect(block.length).toBeGreaterThan(0);
    }
  });

  test("the rule here is the one written in the command", () => {
    for (const needs of Object.values(RULES)) {
      const block = needs.role ? packetBlock(needs.command) : commandBlock(needs.command);
      for (const name of (needs.groups ?? []).flat()) expect(block).toContain(`"${name}"`);
      if (needs.role) expect(block).toContain("if (!currentPlayer?.isAdmin) return;");
    }
  });

  for (const [action, needs] of Object.entries(RULES)) {
    if (action === "player.unban" || action === "player.admin") continue;
    test(`${action}: ${needs.command}`, async () => {
      const allowed = panel.ACTIONS[action].allowed;

      if (needs.role) {
        expect(await allowed({ isAdmin: true, permissions: [] })).toBe(true);
        expect(await allowed({ isAdmin: false, permissions: [...EVERYTHING] })).toBe(false);
        return;
      }

      const groups = needs.groups!;
      // Any one name of each group is enough.
      for (let g = 0; g < groups.length; g++) {
        for (const name of groups[g]) {
          const others = groups.filter((_, i) => i !== g).map((group) => group[0]);
          expect(await allowed(holder([name, ...others]))).toBe(true);
        }
        // Everything else there is does not make up for a missing group.
        const without = [...EVERYTHING, ...groups.flat(), "admin.summonadmins"].filter((name) => !groups[g].includes(name));
        const lacking = holder(without);
        expect(await allowed(lacking)).toBe(false);
        const refused = await act(lacking, action, valid(action));
        expect(refused.ok).toBe(false);
        expect(refused.errors).toEqual(["You don't have permission to do that."]);
      }
      expect(ran).toEqual([]);

      // With the rule met the command is what runs.
      if (action === "server.restart.cancel") restartScheduled = true;
      if (action === "server.whitelist.on") whitelistOn = false;
      const done = await act(holder(groups.map((group) => group[0])), action, valid(action));
      expect(done.errors).toEqual([]);
      expect(ran.length).toBe(1);
      expect("command" in ran[0].run && ran[0].run.command).toBe(needs.command);
    });
  }

  test("what the viewer may do is sent with the full panel, by action", async () => {
    const can = await panel.capabilities(mod);
    expect(Object.keys(can).sort()).toEqual([...Object.keys(RULES), "player.summon.admins", "query.lootTables", "query.moderation", "query.permissions", "query.reports", "query.trades"].sort());
    const yes = Object.keys(can).filter((name) => can[name]).sort();
    expect(yes).toEqual(["player.ban", "player.kick", "self.noclip", "self.stealth"]);
    expect((await panel.capabilities(boss))["player.summon.admins"]).toBe(true);
  });
});

describe("actions that cannot be taken back", () => {
  const DANGEROUS = Object.keys(RULES).filter((action) => RULES[action].confirm);

  test("they are the ones the panel confirms", () => {
    expect(DANGEROUS.sort()).toEqual([
      "loot.delete", "permission.add", "permission.clear", "permission.remove", "permission.set",
      "player.admin", "player.ban", "player.kick", "player.kill", "server.restart", "server.shutdown",
    ]);
  });

  test("each is refused without its permission, confirmed or not", async () => {
    const powerless = holder([]);
    for (const action of DANGEROUS) {
      const refused = await act(powerless, action, valid(action));
      expect(refused.ok).toBe(false);
      expect(refused.errors).toEqual(["You don't have permission to do that."]);
    }
    expect(ran).toEqual([]);
  });

});

describe("the live view", () => {
  const mine = (players: ControlPanelPlayer[]) => players.filter((p) => p.username.startsWith("cp_"));

  test("who is online: name, level, map, admin and stealth, in name order", () => {
    expect(mine(panel.onlinePlayers(boss))).toEqual([
      { id: "7101", username: "cp_boss", level: 3, map: "overworld", isAdmin: true, isStealth: false, isGuest: false, dead: 0, onlineFor: null },
      { id: "7104", username: "cp_hero", level: 3, map: "overworld", isAdmin: false, isStealth: false, isGuest: false, dead: 0, onlineFor: null },
      { id: "7102", username: "cp_mod", level: 3, map: "overworld", isAdmin: true, isStealth: false, isGuest: false, dead: 0, onlineFor: null },
      { id: "7103", username: "cp_sneak", level: 60, map: "cave", isAdmin: true, isStealth: true, isGuest: false, dead: 0, onlineFor: null },
    ]);
    hero.isGhost = true;
    expect(mine(panel.onlinePlayers(boss)).find((p) => p.username === "cp_hero")?.dead).toBe(2);
  });

  test("how long each has been online is counted from the receiver's login stamp", () => {
    // The receiver sets `created` to the clock's reading when the player logs in.
    hero.created = performance.now() - 125000;
    const listed = mine(panel.onlinePlayers(boss));
    const seconds = listed.find((p) => p.username === "cp_hero")?.onlineFor;
    expect(seconds).toBeGreaterThanOrEqual(125);
    expect(seconds).toBeLessThan(130);
    // Without the stamp it is left unknown, not guessed.
    expect(listed.find((p) => p.username === "cp_mod")?.onlineFor).toBeNull();
    expect(source).toContain("created: performance.now(),");
  });

  test("a stealthed admin is listed for admins only: the receiver's own rule", () => {
    expect(panel.canSee(boss, sneak)).toBe(true);
    expect(panel.canSee(hero, sneak)).toBe(false);
    expect(panel.canSee(sneak, sneak)).toBe(true);
    expect(mine(panel.onlinePlayers(hero)).map((p) => p.username)).toEqual(["cp_boss", "cp_hero", "cp_mod"]);
    // SELECTPLAYER and the spawn code hide a stealthed player from everyone who is not an admin.
    expect(source).toContain("!(p.isStealth && !currentPlayer.isAdmin)");
    expect(source).toContain("!targetPlayer.isStealth || otherPlayer.isAdmin");
  });

  test("the status and the world come from what the server already tracks", async () => {
    const data = await panel.buildData(boss, false);
    expect(data.viewer).toEqual({ id: "7101", username: "cp_boss", map: "overworld", isNoclip: false, isStealth: false });
    expect(data.status.online).toBe(data.players.length);
    expect(data.status.uptime).toBeGreaterThanOrEqual(0);
    expect(data.status.memoryMb).toBeGreaterThan(0);
    expect(data.status).toMatchObject({
      eventLoopLagMs: 2, restartScheduled: false, whitelist: { enabled: true, size: 4 }, creatures: { creatures: 12, awake: 5 },
    });
    expect(data.world).toMatchObject({
      map: "overworld", weather: "random", showing: "rain",
      // What the viewer's own map reads now, for the weather card.
      conditions: { temperature: 55, humidity: 70, wind_speed: 8, wind_direction: "left", precipitation: 60 },
    });
    expect(data.world.worlds.length).toBe(2);
    // Asked for every few seconds: nothing is read from the database, and the fixed lists are left out.
    expect(queries).toEqual([]);
    expect(data.can).toBeUndefined();
    expect(data.options).toBeUndefined();
    expect(data.accounts).toBeUndefined();
    expect(data.history).toBeUndefined();
    expect(data.activity).toBeUndefined();
  });

  test("asked in full, it adds the viewer's rights and what the controls pick from", async () => {
    const result = await panel.handlePanelPacket(boss, "CONTROL_PANEL_LOAD", { full: true }, receiver(boss));
    if (result.kind !== "data") throw new Error("A load answers with data");
    expect(result.data.options).toEqual({ maps: ["cave", "overworld"], weathers: ["clear", "random", "weather_api", "rain", "snow"] });
    expect(result.data.can?.["server.shutdown"]).toBe(true);
    expect(ran).toEqual([]);
  });

  test("asked in full, it counts the accounts and the banned ones, guests aside, and keeps the answer a while", async () => {
    tables.accounts.push({ id: 8106, username: "guest_1", session_id: null, banned: 0, is_dead: 0, role: 0, guest_mode: 1 });
    expect((await panel.buildData(boss, true)).accounts).toEqual({ registered: 5, banned: 1 });
    const counts = () => queries.filter((text) => text.startsWith("SELECT COUNT(*)"));
    expect(counts()).toEqual(["SELECT COUNT(*) AS registered, SUM(CASE WHEN banned = 1 THEN 1 ELSE 0 END) AS banned FROM accounts WHERE guest_mode = ?"]);
    // A second panel opening inside the minute is not a second count.
    accountOf("cp_hero").banned = 1;
    expect((await panel.buildData(mod, true)).accounts).toEqual({ registered: 5, banned: 1 });
    expect(counts().length).toBe(1);
  });

  test("the most players online at once is remembered after they leave", async () => {
    const before = (await panel.buildData(boss, false)).status;
    expect(before.peak.online).toBe(before.online);
    expect(before.peak.at).toBeGreaterThan(0);
    online("7105", "cp_temp");
    expect((await panel.buildData(boss, false)).status.peak.online).toBe(before.online + 1);
    playerCache.remove("7105");
    const after = (await panel.buildData(boss, false)).status;
    expect(after.online).toBe(before.online);
    expect(after.peak.online).toBe(before.online + 1);
  });

  test("searching accounts finds players who are offline", async () => {
    const result = await panel.handlePanelPacket(boss, "CONTROL_PANEL_QUERY", { kind: "players", query: "cp_e" }, receiver(boss));
    expect(result).toEqual({ kind: "results", data: { kind: "players", query: "cp_e", players: [{ username: "cp_exile", userid: 8105, online: false }], truncated: 0 } });
    const items = await panel.handlePanelPacket(boss, "CONTROL_PANEL_QUERY", { kind: "items", query: "iron" }, receiver(boss));
    expect(items).toMatchObject({ kind: "results", data: { kind: "items", items: [{ name: "Iron Helmet" }] } });
  });
});

describe("a request that arrives twice", () => {
  test("the same request is run once, whether the copies arrive together or one after the other", async () => {
    const [first, second] = await Promise.all([
      act(boss, "player.kick", { target: "cp_hero", confirm: true }, "same-click"),
      act(boss, "player.kick", { target: "cp_hero", confirm: true }, "same-click"),
    ]);
    expect(first).toMatchObject({ ok: true, replies: ["KICK done"] });
    expect(second).toMatchObject({ ok: false, duplicate: true, errors: [], replies: [] });
    expect((await act(boss, "player.kick", { target: "cp_hero", confirm: true }, "same-click")).duplicate).toBe(true);
    expect(commands()).toEqual(["KICK cp_hero"]);
    // Another admin's request with the same id is their own.
    expect((await act(mod, "player.kick", { target: "cp_hero", confirm: true }, "same-click")).ok).toBe(true);
  });

  test("a request with no id is not run", async () => {
    const result = await act(boss, "player.kick", { target: "cp_hero", confirm: true }, null);
    expect(result.ok).toBe(false);
    expect(ran).toEqual([]);
  });

  test("noclip and stealth are asked for as on or off, so a doubled click does not switch them back", async () => {
    const [first, second] = await Promise.all([act(boss, "self.noclip", { enabled: true }), act(boss, "self.noclip", { enabled: true })]);
    expect(first.replies).toEqual(["Noclip is on."]);
    expect(second.replies).toEqual(["Noclip is already on."]);
    expect(commands()).toEqual(["NOCLIP"]);
    expect(boss.isNoclip).toBe(true);
    expect((await act(boss, "self.stealth", { enabled: false })).replies).toEqual(["Stealth is already off."]);
    expect((await act(boss, "self.noclip", { enabled: false })).replies).toEqual(["Noclip is off."]);
    expect((await act(boss, "self.noclip", {})).errors).toEqual(["Noclip must be on or off."]);
  });

  test("a restart is scheduled once and cancelled once", async () => {
    mod.permissions = ["server.restart"];
    const [first, second] = await Promise.all([act(boss, "server.restart", { confirm: true }), act(mod, "server.restart", { confirm: true })]);
    expect(first.replies).toEqual(["A restart is scheduled in 15 minutes. Players see the countdown."]);
    expect(second.replies).toEqual(["A restart is already scheduled."]);
    expect(restartScheduled).toBe(true);
    expect((await act(boss, "server.restart.cancel")).replies).toEqual(["The restart was cancelled. Players have been told."]);
    expect((await act(boss, "server.restart.cancel")).replies).toEqual(["No restart is scheduled."]);
    expect(commands()).toEqual(["RESTART", "RESTART"]);
    expect(restartScheduled).toBe(false);
  });

  test("the whitelist is switched once each way, and the answer carries where it now stands", async () => {
    whitelistOn = false;
    mod.permissions = ["admin.whitelist"];
    const [first, second] = await Promise.all([act(boss, "server.whitelist.on"), act(mod, "server.whitelist.on")]);
    expect(first.replies).toEqual(["Whitelist is on"]);
    expect(second.replies).toEqual(["The whitelist is already on."]);
    expect(first.data?.status.whitelist).toEqual({ enabled: true, size: 4 });
    const off = await act(boss, "server.whitelist.off");
    expect(off.replies).toEqual(["Whitelist is off"]);
    expect(off.data?.status.whitelist.enabled).toBe(false);
    expect((await act(boss, "server.whitelist.off")).replies).toEqual(["The whitelist is already off."]);
    // The switch takes no username: nothing sent with it reaches the command.
    await act(boss, "server.whitelist.on", { target: "cp_hero", enabled: false });
    expect(commands()).toEqual(["WHITELIST on", "WHITELIST off", "WHITELIST on"]);
    expect(whitelistOn).toBe(true);
  });

  test("the panel waits its turn behind a player editor change to the same player", async () => {
    let release = () => {};
    const editing = oneAtATime("cp_hero", () => new Promise<void>((resolve) => { release = resolve; }));
    const kicking = act(boss, "player.kick", { target: "cp_hero", confirm: true });
    await tick();
    await tick();
    expect(ran).toEqual([]);
    release();
    await editing;
    expect((await kicking).ok).toBe(true);
    expect(commands()).toEqual(["KICK cp_hero"]);
  });
});

describe("everything the in-game admin panel did", () => {
  // What each of its buttons sent, as the command and arguments the receiver is now handed.
  const OLD_PANEL: Array<[string, string, Row, string]> = [
    ["Noclip", "self.noclip", { enabled: true }, "NOCLIP"],
    ["Stealth", "self.stealth", { enabled: true }, "STEALTH"],
    ["Summon", "player.summon", { target: "cp_hero" }, "SUMMON cp_hero"],
    ["Teleport To", "player.goto", { target: "cp_hero" }, "TELEPORT cp_hero"],
    ["Respawn", "player.respawn", { target: "cp_hero" }, "RESPAWN cp_hero"],
    ["Kick", "player.kick", { target: "cp_hero", confirm: true }, "KICK cp_hero"],
    ["Ban", "player.ban", { target: "cp_hero", confirm: true }, "BAN cp_hero"],
    ["Reload Map", "world.reloadmap", { map: "Overworld.json" }, "RELOADMAP overworld"],
    ["Warp", "world.warp", { map: "cave" }, "WARP cave"],
    ["Broadcast: All Players", "server.broadcast", { audience: "ALL", message: "Back in five" }, "BROADCAST ALL Back in five"],
    ["Broadcast: Current Map", "server.broadcast", { audience: "MAP", message: "Back in five" }, "BROADCAST MAP Back in five"],
    ["Broadcast: Admins Only", "server.broadcast", { audience: "ADMINS", message: "Back in five" }, "BROADCAST ADMINS Back in five"],
  ];

  for (const [button, action, data, expected] of OLD_PANEL) {
    test(button, async () => {
      const result = await act(boss, action, data);
      expect(result.errors).toEqual([]);
      expect(commands()).toEqual([expected]);
    });
  }

  test("and every admin chat command has a control", () => {
    const reachable = new Set(Object.values(panel.ACTIONS).map((action) => action.command));
    for (const command of [
      "SUMMON", "TELEPORT", "KICK", "BROADCAST", "BAN", "UNBAN", "ADMIN", "WHITELIST", "SHUTDOWN", "RESTART", "RESPAWN", "REVIVE", "KILL",
      "PERMISSION", "RELOADMAP", "WARP", "WEATHER", "GIVE", "DROP", "SPAWNCHEST", "LOOTTABLE", "MUTE", "UNMUTE", "REPORTS",
    ]) {
      expect(reachable.has(command)).toBe(true);
    }
  });

  test("but the editors are not launched from the panel: they open with their own commands", () => {
    expect(Object.keys(panel.ACTIONS).filter((action) => action.startsWith("editor."))).toEqual([]);
    const reachable = new Set(Object.values(panel.ACTIONS).map((action) => action.command));
    for (const command of ["TE", "PE", "IE", "SE", "WE", "QE", "CE", "NE", "LE"]) {
      expect(reachable.has(command)).toBe(false);
      expect(commandBlock(command).length).toBeGreaterThan(0);
    }
  });
});

describe("mutes and reports", () => {
  const NOON = 1_800_000_000_000;
  const filed = (id: number, over: Row = {}): Row => ({
    id, reporter: "cp_hero", target: "cp_exile", category: "spam", details: null, chat_log: JSON.stringify([{ at: NOON, channel: "say", text: "buy gold" }]),
    map: "overworld", x: 1, y: 2, target_map: null, target_x: null, target_y: null, created_at: NOON + id,
    status: "open", resolved_by: null, resolved_at: null, resolution: null, ...over,
  });
  const ask = (actor: any, data: Row) => panel.handlePanelPacket(actor, "CONTROL_PANEL_QUERY", data, receiver(actor));

  test("/mute is handed the player, how long and why, and a mute until lifted says so in a word", async () => {
    await act(boss, "player.mute", { target: "CP_Hero", duration: "2H", reason: "  selling gold  " });
    await act(boss, "player.mute", { target: "cp_hero", duration: "", reason: "7d of spam" });
    await act(boss, "player.mute", { target: "cp_hero" });
    await act(boss, "player.unmute", { target: "cp_hero" });

    expect(ran.map((entry) => entry.run)).toEqual([
      { command: "MUTE", args: ["cp_hero", "2h", "selling gold"] },
      { command: "MUTE", args: ["cp_hero", "permanent", "7d of spam"] },
      { command: "MUTE", args: ["cp_hero", "permanent"] },
      { command: "UNMUTE", args: ["cp_hero"] },
    ]);
  });

  test("a report is resolved by its number, with the note as it was typed", async () => {
    await act(boss, "report.resolve", { id: 4, note: " warned, then muted " });
    await act(boss, "report.resolve", { id: "7" });

    expect(ran.map((entry) => entry.run)).toEqual([
      { command: "REPORTS", args: ["resolve", "4", "warned, then muted"] },
      { command: "REPORTS", args: ["resolve", "7"] },
    ]);
  });

  test("what those commands would choke on is refused here, in a sentence", async () => {
    const refusals: Array<[string, Row, string | RegExp]> = [
      ["player.mute", { duration: "30m" }, "Pick a player first."],
      ["player.mute", { target: "cp_nobody", duration: "30m" }, "Player not found."],
      ["player.mute", { target: "cp_hero", duration: "soon" }, /a number and a unit/],
      ["player.mute", { target: "cp_hero", duration: "30m", reason: "x".repeat(201) }, /200 characters/],
      ["player.unmute", {}, "Pick a player first."],
      ["report.resolve", { note: "done" }, "Pick a report first."],
      ["report.resolve", { id: 0 }, "Pick a report first."],
      ["report.resolve", { id: 4, note: "x".repeat(201) }, /200 characters/],
    ];
    for (const [action, data, message] of refusals) {
      const result = await act(boss, action, data);
      expect(result.ok).toBe(false);
      expect(result.errors.join(" | ")).toMatch(message);
    }
    expect(ran).toEqual([]);
  });

  test("a player's mute and how many open reports name them are shown to whoever may act on either", async () => {
    tables.mutes = [{ username: "cp_exile", muted_by: "cp_boss", reason: "spam", created_at: NOON, expires_at: null }];
    tables.reports = [filed(1), filed(2, { reporter: "cp_mod" }), filed(3, { status: "resolved", resolved_by: "cp_boss", resolved_at: NOON + 9 })];
    await loadTables();

    expect(await ask(boss, { kind: "moderation", target: "CP_Exile" })).toEqual({
      kind: "results",
      data: { kind: "moderation", target: "cp_exile", mute: { username: "cp_exile", muted_by: "cp_boss", reason: "spam", created_at: NOON, expires_at: null }, openReports: 2 },
    });
    expect(await ask(boss, { kind: "moderation", target: "cp_hero" })).toMatchObject({ data: { mute: null, openReports: 0 } });
    expect(await ask(holder(["admin.unmute"]), { kind: "moderation", target: "cp_hero" })).toMatchObject({ kind: "results" });
    expect(await ask(mod, { kind: "moderation", target: "cp_hero" })).toMatchObject({ kind: "result", data: { ok: false, errors: ["You don't have permission to do that."] } });
    expect(await ask(boss, { kind: "moderation", target: "cp_nobody" })).toMatchObject({ data: { errors: ["Player not found."] } });
  });

  test("the reports are listed for whoever handles them: the open ones newest first, then the latest resolved", async () => {
    tables.reports = [filed(1), filed(2, { reporter: "cp_mod" }), filed(3, { status: "resolved", resolved_by: "cp_boss", resolved_at: NOON + 9, resolution: "muted" })];
    await loadTables();

    const listed = await ask(holder(["admin.reports"]), { kind: "reports" }) as any;

    expect(listed.kind).toBe("results");
    expect(listed.data.open.map((report: Row) => report.id)).toEqual([2, 1]);
    expect(listed.data.open[0].chat_log).toEqual([{ at: NOON, channel: "say", text: "buy gold" }]);
    expect(listed.data.resolved).toEqual([expect.objectContaining({ id: 3, resolved_by: "cp_boss", resolution: "muted" })]);
    expect(await ask(mod, { kind: "reports" })).toMatchObject({ kind: "result", data: { ok: false, errors: ["You don't have permission to do that."] } });
  });

  test("a player's latest trades are listed, newest first, for whoever may read the trade log", async () => {
    const gave = (items: Array<[string, number]> = [], gold = 0) => ({ items: items.map(([name, quantity]) => ({ name, quantity })), coins: { gold, silver: 0, copper: 0 } });
    const traded = (id: number, player_a: string, player_b: string, a: ReturnType<typeof gave>, b: ReturnType<typeof gave>) =>
      ({ id, player_a, player_b, a_gave: JSON.stringify(a), b_gave: JSON.stringify(b), created_at: NOON + id });
    tables.trade_log = [
      traded(1, "cp_hero", "cp_exile", gave([["Iron Helmet", 1]]), gave([], 5)),
      traded(2, "cp_exile", "cp_mod", gave(), gave([], 1)),
      traded(3, "cp_mod", "cp_hero", gave([], 2), gave()),
    ];
    await loadTables();

    expect(await ask(holder(["admin.trades"]), { kind: "trades", target: "CP_Hero" })).toEqual({
      kind: "results",
      data: {
        kind: "trades",
        target: "cp_hero",
        trades: [
          { id: 3, player_a: "cp_mod", player_b: "cp_hero", a_gave: gave([], 2), b_gave: gave(), created_at: NOON + 3 },
          { id: 1, player_a: "cp_hero", player_b: "cp_exile", a_gave: gave([["Iron Helmet", 1]]), b_gave: gave([], 5), created_at: NOON + 1 },
        ],
      },
    });
    expect(await ask(boss, { kind: "trades", target: "cp_boss" })).toMatchObject({ data: { trades: [] } });
    expect(await ask(mod, { kind: "trades", target: "cp_hero" })).toMatchObject({ kind: "result", data: { ok: false, errors: ["You don't have permission to do that."] } });
    expect(await ask(boss, { kind: "trades", target: "cp_nobody" })).toMatchObject({ data: { errors: ["Player not found."] } });
    expect(await ask(boss, { kind: "trades" })).toMatchObject({ data: { errors: ["Pick a player first."] } });
  });

  test("how many reports are open is on every refresh, for those who handle them only", async () => {
    tables.reports = [filed(1), filed(2, { reporter: "cp_mod" }), filed(3, { status: "resolved", resolved_at: NOON })];
    await loadTables();

    expect((await panel.buildData(boss, false)).reports).toEqual({ open: 2 });
    expect((await panel.buildData(mod, false)).reports).toBeUndefined();
  });
});

describe("what is handed to the command", () => {
  test("values go as they are: no chat text is built or parsed", async () => {
    await act(boss, "server.broadcast", { audience: "all", message: '  They said "hi"  to   ALL of you ' });
    await act(boss, "player.give", { target: "CP_Hero", item: "Iron Helmet", quantity: 3 });
    await act(boss, "chest.spawn", { entries: [{ item: "Iron Helmet", min: 1, max: 3, chance: 12.5 }, { item: "Health Potion", min: 2, max: 2, chance: 100 }] });
    await act(boss, "loot.additem", { id: 3, item: "Iron Helmet", min: 1, max: 2, chance: 0 });
    await act(boss, "permission.set", { target: "cp_mod", permissions: ["admin.kick", " admin.ban ", "admin.kick"], confirm: true });
    expect(ran.map((entry) => entry.run)).toEqual([
      { command: "BROADCAST", args: ["ALL", 'They said "hi"  to   ALL of you'] },
      { command: "GIVE", args: ["cp_hero", "Iron Helmet", "3"] },
      { command: "SPAWNCHEST", args: ["inline", "Iron Helmet", "1", "3", "12.5", "Health Potion", "2", "2", "100"] },
      { command: "LOOTTABLE", args: ["additem", "3", "Iron Helmet", "1", "2", "0", "common"] },
      { command: "PERMISSION", args: ["SET", "cp_mod", "admin.kick,admin.ban"] },
    ]);
  });

  test("what the command would choke on is refused here, in a sentence", async () => {
    const refusals: Array<[string, Row, string | RegExp]> = [
      ["player.kick", { confirm: true }, "Pick a player first."],
      ["player.kick", { target: "cp hero; drop", confirm: true }, "Pick a player first."],
      ["player.unban", { target: "cp_nobody" }, "Player not found."],
      ["player.admin", { target: "cp_nobody", admin: true, confirm: true }, "Player not found."],
      ["player.admin", { target: "cp_hero", confirm: true }, "Admin must be on or off."],
      ["player.give", { target: "cp_hero", item: "", quantity: 0 }, /Pick an item/],
      ["permission.add", { target: "cp_mod", permission: "a,b", confirm: true }, "Pick a permission."],
      ["permission.set", { target: "cp_mod", permissions: [], confirm: true }, "Use Clear all to take every permission away."],
      ["server.broadcast", { audience: "ALL", message: "   " }, /Type a message/],
      ["server.broadcast", { audience: "EVERYONE", message: "Hi" }, "Pick who the message is for."],
      ["world.warp", { map: "" }, "Pick a map."],
      ["world.weather", {}, "Pick a weather."],
      ["item.drop", { item: "Iron Helmet", quantity: 10000 }, /from 1 to 9999/],
      ["chest.spawn", { entries: [] }, /1 to 20 kinds/],
      ["chest.spawn", { entries: [{ item: "Iron Helmet", min: 3, max: 1, chance: 50 }] }, /cannot be more than the largest/],
      ["loot.additem", { id: 3, item: "Iron Helmet", min: 1, max: 2, chance: 250 }, /from 0 to 100/],
      ["loot.create", { name: "" }, "Give the loot table a name."],
      ["no.such.action", {}, /Unknown control panel action/],
    ];
    for (const [action, data, message] of refusals) {
      const result = await act(boss, action, data);
      expect(result.ok).toBe(false);
      expect(result.errors.join(" | ")).toMatch(message);
    }
    expect(ran).toEqual([]);
  });

});

describe("the answer", () => {
  test("is what the command told the admin, with the player's name as it is shown", async () => {
    replies.GIVE = ["Gave 2x Iron Helmet to cp_hero"];
    expect(await act(boss, "player.give", { target: "cp_hero", item: "Iron Helmet", quantity: 2 })).toMatchObject({
      ok: true, errors: [], replies: ["Gave 2x Iron Helmet to Cp_hero"], action: "player.give",
    });
    replies.KICK = ["You cannot disconnect other admins"];
    expect((await act(boss, "player.kick", { target: "cp_mod", confirm: true })).replies).toEqual(["You cannot disconnect other admins"]);
  });

  test("comes with the state as it now stands", async () => {
    const result = await act(boss, "self.stealth", { enabled: true });
    expect(result.data?.viewer.isStealth).toBe(true);
    expect(result.data?.can).toBeUndefined();
  });

  test("is a refusal when a command that always answers said nothing", async () => {
    replies.BAN = [];
    const result = await act(boss, "player.ban", { target: "cp_hero", confirm: true });
    expect(result).toMatchObject({ ok: false, errors: ["The server gave no answer, so that may not have been done."], replies: [] });
  });

  test("is the panel's own for the commands that only speak to refuse", async () => {
    replies.WARP = [];
    expect((await act(boss, "world.warp", { map: "cave" })).replies).toEqual(["Warped to cave."]);
    replies.WARP = ["You are already in this map"];
    expect((await act(boss, "world.warp", { map: "cave" })).replies).toEqual(["You are already in this map"]);
    expect((await act(boss, "server.broadcast", { audience: "MAP", message: "Hello" })).replies).toEqual(["Message sent."]);
  });

  test("is read off the notifications the receiver sends the admin", () => {
    const collected: string[] = [];
    panel.collectReplies(collected, packetManager.notify({ message: "Disconnected Cp_hero from the server" }));
    panel.collectReplies(collected, packetManager.toggleControlPanel());
    panel.collectReplies(collected, packetManager.controlPanelResult({ ok: true, errors: [], replies: ["NOTIFY"], action: "x", requestId: "1" }));
    panel.collectReplies(collected, ["not a packet", new Uint8Array(0)]);
    panel.collectReplies(undefined, packetManager.notify({ message: "nobody is listening" }));
    expect(collected).toEqual(["Disconnected Cp_hero from the server"]);
  });

  test("a command that fails on the server is a refusal, and the next one still runs", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const broken = async () => { throw new Error("lost the database"); };
    const result = await panel.handlePanelPacket(boss, "CONTROL_PANEL_ACTION", { action: "player.kick", target: "cp_hero", confirm: true, requestId: "boom" }, broken);
    error.mockRestore();
    expect(result).toMatchObject({ kind: "result", data: { ok: false, errors: ["That failed on the server."] } });
    expect((await act(boss, "player.kick", { target: "cp_hero", confirm: true })).ok).toBe(true);
  });
});

describe("the history the dashboard charts", () => {
  // A reading: seconds since the epoch, players online, event loop delay, memory, creatures awake.
  const START = Date.UTC(2026, 9, 4, 12, 0, 0);
  const at = (reading: number) => START + reading * panel.READING_EVERY_MS;
  const seconds = (reading: number) => at(reading) / 1000;
  const everyone = () => Object.values(playerCache.list() as Row).filter((p: any) => p?.username).length;
  const load = async (actor: any, data: Row) => {
    const result = await panel.handlePanelPacket(actor, "CONTROL_PANEL_LOAD", data, receiver(actor));
    if (result.kind !== "data") throw new Error("A load answers with data");
    return result.data;
  };

  test("a reading is what the server already measures, and nothing is read from the database for it", async () => {
    lagMs = 3.14159;
    awake = 7;
    panel.takeReading(at(0));
    expect(queries).toEqual([]);
    const { history } = await panel.buildData(boss, true);
    expect(history?.day).toEqual([]);
    expect(history?.recent.length).toBe(1);
    const [time, players, lag, memory, creatures] = history!.recent[0];
    expect([time, players, lag, creatures]).toEqual([seconds(0), everyone(), 3.1, 7]);
    expect(memory).toBe(Math.round(memory!));
    expect(memory).toBeGreaterThan(0);
  });

  test("it counts everyone online, a stealthed admin too: only admins open the panel, and they may see them", async () => {
    panel.takeReading(at(0));
    const data = await panel.buildData(boss, true);
    expect(data.history?.recent[0][1]).toBe(data.players.length);
    expect(data.players.some((p) => p.isStealth)).toBe(true);
    // Whoever may not use the panel is refused before the history is touched.
    expect((await panel.handlePanelPacket(hero, "CONTROL_PANEL_LOAD", { full: true }, receiver(hero))).kind).toBe("result");
  });

  test("a figure the server could not give is left unknown", async () => {
    panel.setControlPanelBridge(null);
    panel.takeReading(at(0));
    panel.setControlPanelBridge(bridge);
    const [time, players, lag, , creatures] = (await panel.buildData(boss, true)).history!.recent[0];
    expect([time, players, lag, creatures]).toEqual([seconds(0), everyone(), null, null]);
  });

  test("every fourth reading closes a minute of the day, which keeps the highest of its four", async () => {
    expect(panel.READINGS_PER_MINUTE * panel.READING_EVERY_MS).toBe(60000);
    const lags = [1, 9, 3, 2, 4, 4, 6, 5];
    lags.forEach((lag, reading) => {
      lagMs = lag;
      awake = 10 - reading;
      if (reading === 2) online("7105", "cp_temp");
      if (reading === 3) playerCache.remove("7105");
      panel.takeReading(at(reading));
    });
    const { history } = await panel.buildData(boss, true);
    expect(history?.recent.map((row) => row[2])).toEqual(lags);
    expect(history?.day.map((row) => [row[0], row[1], row[2], row[4]])).toEqual([
      [seconds(3), everyone() + 1, 9, 10],
      [seconds(7), everyone(), 6, 6],
    ]);
  });

  test("the last hour holds 240 readings and the day 1,440 minutes: older ones are dropped", async () => {
    expect([panel.RECENT_KEEP, panel.DAY_KEEP]).toEqual([240, 1440]);
    const readings = (panel.DAY_KEEP + 2) * panel.READINGS_PER_MINUTE;
    for (let reading = 0; reading < readings; reading++) panel.takeReading(at(reading));
    const { history } = await panel.buildData(boss, true);
    expect(history?.recent.length).toBe(panel.RECENT_KEEP);
    expect(history?.recent[0][0]).toBe(seconds(readings - panel.RECENT_KEEP));
    expect(history?.recent.at(-1)?.[0]).toBe(seconds(readings - 1));
    expect(history?.day.length).toBe(panel.DAY_KEEP);
    // The first two minutes have been written over; what is left is in order.
    expect(history?.day[0][0]).toBe(seconds(3 * panel.READINGS_PER_MINUTE - 1));
    expect(history?.day.at(-1)?.[0]).toBe(seconds(readings - 1));
    const times = history!.day.map((row) => row[0]!);
    expect(times.every((time, i) => i === 0 || time - times[i - 1] === 60)).toBe(true);
  });

  test("the panel gets all of it when it opens, then only what is newer than it holds", async () => {
    for (let reading = 0; reading < 6; reading++) panel.takeReading(at(reading));
    const opened = await load(boss, { full: true });
    expect(opened.history?.recent.length).toBe(6);
    expect(opened.history?.day.length).toBe(1);
    expect(opened.activity).toEqual([]);

    // Nothing new: the refresh carries no history at all.
    const held = { recent: seconds(5), day: seconds(3), activity: 0 };
    const quiet = await load(boss, { since: held });
    expect(quiet.history).toBeUndefined();
    expect(quiet.activity).toBeUndefined();

    panel.takeReading(at(6));
    panel.takeReading(at(7));
    const refreshed = await load(boss, { since: held });
    expect(refreshed.history?.recent.map((row) => row[0])).toEqual([seconds(6), seconds(7)]);
    expect(refreshed.history?.day.map((row) => row[0])).toEqual([seconds(7)]);
    expect(refreshed.can).toBeUndefined();

    // A refresh that does not say what it holds, or says it badly, is not sent the lot again.
    expect((await load(boss, {})).history).toBeUndefined();
    expect((await load(boss, { since: "everything" })).history).toBeUndefined();
    expect((await load(boss, { since: { recent: "x", day: -5 } })).history?.recent.length).toBe(8);
    // The state sent back with an action's answer is the live view only.
    expect((await act(boss, "self.noclip", { enabled: true })).data?.history).toBeUndefined();
    expect(queries.filter((text) => !text.includes("FROM permission") && !text.startsWith("SELECT COUNT(*)"))).toEqual([]);
  });
});

describe("the list of what admins did through the panel", () => {
  const listed = async (actor: any = boss) => (await panel.buildData(actor, true)).activity!;

  test("who, what, on whom, when, and what the command answered", async () => {
    const before = Date.now();
    replies.KICK = ["Disconnected cp_hero from the server"];
    await act(boss, "player.kick", { target: "cp_hero", confirm: true });
    await act(mod, "player.ban", { target: "CP_Hero", confirm: true });
    const entries = await listed();
    expect(entries).toMatchObject([
      { seq: 1, by: "cp_boss", action: "player.kick", target: "cp_hero", details: {}, said: "Disconnected Cp_hero from the server" },
      { seq: 2, by: "cp_mod", action: "player.ban", target: "cp_hero", details: {}, said: "BAN done" },
    ]);
    expect(entries[0].at).toBeGreaterThanOrEqual(before);
    expect(entries[0].at).toBeLessThanOrEqual(Date.now());
    // Every admin with the panel sees the same list.
    expect(await listed(mod)).toEqual(entries);
  });

  test("it keeps the values that say what was done, cut to size, and nothing else a client sends", async () => {
    await act(boss, "server.broadcast", { audience: "ALL", message: "x".repeat(400), junk: "y".repeat(5000), nested: { deep: true } });
    await act(boss, "player.give", { target: "cp_hero", item: "Iron Helmet", quantity: 3 });
    await act(boss, "permission.set", { target: "cp_mod", permissions: ["admin.kick", "admin.ban"], confirm: true });
    await act(boss, "chest.spawn", { entries: [{ item: "Iron Helmet", min: 1, max: 3, chance: 12.5 }, { item: "Health Potion", min: 2, max: 2, chance: 100 }] });
    await act(boss, "self.stealth", { enabled: true });
    expect((await listed()).map((entry) => [entry.action, entry.target, entry.details])).toEqual([
      ["server.broadcast", null, { audience: "ALL", message: "x".repeat(160) }],
      ["player.give", "cp_hero", { item: "Iron Helmet", quantity: 3 }],
      ["permission.set", "cp_mod", { permissions: "admin.kick, admin.ban" }],
      ["chest.spawn", null, { entries: 2 }],
      ["self.stealth", null, { enabled: true }],
    ]);
  });

  test("the last 100 are kept, and a refresh is sent the ones it does not hold", async () => {
    expect(panel.ACTIVITY_KEEP).toBe(100);
    for (let i = 0; i < panel.ACTIVITY_KEEP + 5; i++) await act(boss, "player.respawn", { target: "cp_hero" });
    const entries = await listed();
    expect(entries.length).toBe(panel.ACTIVITY_KEEP);
    expect([entries[0].seq, entries.at(-1)?.seq]).toEqual([6, 105]);

    const refresh = await panel.handlePanelPacket(boss, "CONTROL_PANEL_LOAD", { since: { activity: 103 } }, receiver(boss));
    if (refresh.kind !== "data") throw new Error("A load answers with data");
    expect(refresh.data.activity?.map((entry) => entry.seq)).toEqual([104, 105]);
    expect(refresh.data.history).toBeUndefined();
    // The answer to an action carries the live view only: the panel asks for the list.
    expect((await act(boss, "player.respawn", { target: "cp_hero" })).data?.activity).toBeUndefined();
  });
});

describe("the weather a world has now", () => {
  const row = (name: string, over: Partial<WeatherData> = {}): WeatherData => ({ name, temperature: 60, humidity: 50, wind_speed: 5, wind_direction: "left", precipitation: 40, ambience: 0.3, ...over });
  const rows = [row("rainy"), row("Blizzard", { temperature: 10, wind_speed: 40, wind_direction: "right", precipitation: 90 })];
  const live = { look: "snowy", row: row("weather_api", { temperature: 28, humidity: 81, wind_speed: 12, wind_direction: "down", precipitation: 20 }) };
  const now = (set: string, settled?: { weather: string; weatherData: WeatherData | null }) => panel.worldWeather(set, settled, live, rows);

  test("a clear world shows clear, and has no readings", () => {
    expect(now("clear")).toEqual({ weather: "clear", showing: "clear", conditions: null });
    expect(now("")).toEqual({ weather: "clear", showing: "clear", conditions: null });
  });

  test("a world set to a weather of the table has that weather's readings, whatever the case of its name", () => {
    expect(now("rainy")).toEqual({
      weather: "rainy", showing: "rainy",
      conditions: { temperature: 60, humidity: 50, wind_speed: 5, wind_direction: "left", precipitation: 40 },
    });
    expect(now("blizzard").conditions).toEqual({ temperature: 10, humidity: 50, wind_speed: 40, wind_direction: "right", precipitation: 90 });
    // A weather that has since been deleted is still named, with nothing to read.
    expect(now("fog")).toEqual({ weather: "fog", showing: "fog", conditions: null });
  });

  test("a random world shows the weather it settled on, and nothing before it has", () => {
    expect(now("random", { weather: "Blizzard", weatherData: rows[1] })).toEqual({
      weather: "random", showing: "Blizzard",
      conditions: { temperature: 10, humidity: 50, wind_speed: 40, wind_direction: "right", precipitation: 90 },
    });
    expect(now("random", { weather: "clear", weatherData: null })).toEqual({ weather: "random", showing: "clear", conditions: null });
    expect(now("random")).toEqual({ weather: "random", showing: "random", conditions: null });
  });

  test("a world that follows a real place shows what it looks like there now, with the reading", () => {
    expect(now("weather_api")).toEqual({
      weather: "weather_api", showing: "snowy",
      conditions: { temperature: 28, humidity: 81, wind_speed: 12, wind_direction: "down", precipitation: 20 },
    });
  });
});
