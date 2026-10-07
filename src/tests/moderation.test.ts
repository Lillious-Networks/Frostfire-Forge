import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// ------------------------------------------------------------ fake database
// The mute, ignore, report and friends systems are the real ones, and so is
// the player system that says which accounts there are. Their tables are held
// here, and understand the statements those systems send.

type Row = Record<string, any>;
let accounts: Row[];
let mutesTable: Row[];
let ignoresTable: Row[];
let reportsTable: Row[];
let friendsTable: Row[];
let tradesTable: Row[];
let nextId: number;

function run(sql: string, params: any[]): any {
  if (/FROM accounts WHERE username = \?$/.test(sql)) return accounts.filter((row) => row.username === params[0]).map((row) => ({ ...row }));

  if (sql.startsWith("SELECT username, muted_by")) return mutesTable.map((row) => ({ ...row }));
  if (sql.startsWith("DELETE FROM mutes")) { mutesTable = mutesTable.filter((row) => row.username !== params[0]); return { affectedRows: 1 }; }
  if (sql.startsWith("INSERT INTO mutes")) {
    const [username, muted_by, reason, created_at, expires_at] = params;
    mutesTable.push({ username, muted_by, reason, created_at, expires_at });
    return { affectedRows: 1 };
  }

  if (sql.startsWith("SELECT ignored FROM ignores")) return ignoresTable.filter((row) => row.username === params[0]).map((row) => ({ ignored: row.ignored }));
  if (sql.startsWith("INSERT INTO ignores")) { ignoresTable.push({ username: params[0], ignored: params[1] }); return { affectedRows: 1 }; }
  if (sql.startsWith("DELETE FROM ignores")) { ignoresTable = ignoresTable.filter((row) => !(row.username === params[0] && row.ignored === params[1])); return { affectedRows: 1 }; }

  if (sql.includes("FROM reports WHERE status = 'open'")) return reportsTable.filter((row) => row.status === "open").map((row) => ({ ...row }));
  if (sql.includes("FROM reports WHERE status = 'resolved'")) return reportsTable.filter((row) => row.status === "resolved").map((row) => ({ ...row }));
  if (sql.startsWith("INSERT INTO reports")) {
    const [reporter, target, category, details, chat_log, map, x, y, target_map, target_x, target_y, created_at] = params;
    const row = { id: nextId++, reporter, target, category, details, chat_log, map, x, y, target_map, target_x, target_y, created_at, status: "open", resolved_by: null, resolved_at: null, resolution: null };
    reportsTable.push(row);
    return { affectedRows: 1, lastInsertRowid: row.id };
  }
  if (sql.startsWith("UPDATE reports SET status = 'resolved'")) {
    const [resolved_by, resolved_at, resolution, id] = params;
    const row = reportsTable.find((entry) => entry.id === id && entry.status === "open");
    if (row) Object.assign(row, { status: "resolved", resolved_by, resolved_at, resolution });
    return { affectedRows: row ? 1 : 0 };
  }

  if (sql.startsWith("SELECT friends FROM friendslist")) return friendsTable.filter((row) => row.username === params[0]).map((row) => ({ friends: row.friends }));
  if (sql.startsWith("UPDATE friendslist SET friends")) {
    const row = friendsTable.find((entry) => entry.username === params[1]);
    if (row) row.friends = params[0];
    return { affectedRows: row ? 1 : 0 };
  }

  if (sql.includes("FROM trade_log ORDER BY id DESC")) return [...tradesTable].sort((a, b) => b.id - a.id).slice(0, params[0]).map((row) => ({ ...row }));

  // A login has every system's player cache fill itself: tables that are not this file's hold nothing.
  if (sql.startsWith("SELECT ")) return [];
  throw new Error(`The fake database does not understand: ${sql}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => run(sql.replace(/\s+/g, " ").trim(), params),
}));

const datacache = await import("../services/datacache");
const { default: playerCache } = await import("../services/playermanager");
const { default: log } = await import("../modules/logger");
const { default: mutes } = await import("../systems/mutes");
const { default: ignores } = await import("../systems/ignores");
const { default: reports } = await import("../systems/reports");
const { audience, forgetLines } = await import("../systems/chatgate");
const moderation = await import("../systems/moderation");

const NOON = 1_800_000_000_000;
const MINUTE = 60_000;

const account = (id: number, username: string, role = 0): Row => ({ id, username, role, banned: 0, guest_mode: 0 });
const online = (id: string, username: string, permissions: string[] = [], at = { x: 100, y: 200 }) => ({
  id, username, permissions, location: { map: "overworld.json", position: { ...at, direction: "down" } },
});

let boss: any;
let mod: any;
let hero: any;
let troll: any;

let logged: Array<ReturnType<typeof spyOn>>;
/** The players other test files left online in the shared cache: out of it while this file runs, and put back after. */
let others: Array<[string, any]>;
beforeAll(() => {
  others = Object.entries(playerCache.list() as Record<string, any>);
  for (const [id] of others) playerCache.remove(id);
  logged = [spyOn(log, "info"), spyOn(log, "warn"), spyOn(log, "error")].map((spy) => spy.mockImplementation(() => {}));
});
afterAll(async () => {
  for (const spy of logged) spy.mockRestore();
  for (const player of [boss, mod, hero, troll]) playerCache.remove(player.id);
  for (const [id, live] of others) playerCache.add(id, live);
  await datacache.clearCaches();
});

beforeEach(async () => {
  accounts = [account(1, "boss", 1), account(2, "mod"), account(3, "hero"), account(4, "troll"), account(5, "ally"), account(6, "sleeper")];
  mutesTable = [];
  ignoresTable = [];
  reportsTable = [];
  friendsTable = [];
  tradesTable = [];
  nextId = 1;
  for (const id of ["9301", "9302", "9303", "9304"]) playerCache.remove(id);
  boss = online("9301", "boss", ["admin.*"]);
  mod = online("9302", "mod", ["admin.mute", "admin.reports"]);
  hero = online("9303", "hero", [], { x: 10.4, y: 20.6 });
  troll = online("9304", "troll", [], { x: 12, y: 21 });
  for (const player of [boss, mod, hero, troll]) playerCache.add(player.id, player);
  for (const name of ["hero", "troll", "ally"]) forgetLines(name);
  await datacache.clearCaches();
});

describe("/mute and /unmute", () => {
  test("need their permission, each its own", async () => {
    expect(await moderation.muteCommand(hero, ["troll"], NOON)).toBe("You don't have permission to use this command");
    expect(await moderation.unmuteCommand(mod, ["troll"], NOON)).toBe("You don't have permission to use this command");
    expect(mutesTable).toEqual([]);
  });

  test("mute for a time, with the rest of the line as the reason", async () => {
    expect(await moderation.muteCommand(mod, ["Troll", "30M", "selling", "gold"], NOON)).toBe("Muted Troll for 30m");

    expect(mutesTable).toEqual([{ username: "troll", muted_by: "mod", reason: "selling gold", created_at: NOON, expires_at: NOON + 30 * MINUTE }]);
  });

  test("mute until lifted when no time is given: the second word is then the reason", async () => {
    expect(await moderation.muteCommand(boss, ["troll", "selling", "gold"], NOON)).toBe("Muted Troll until they are unmuted");
    expect(mutesTable[0]).toMatchObject({ reason: "selling gold", expires_at: null });

    expect(await moderation.muteCommand(boss, ["sleeper"], NOON)).toBe("Muted Sleeper until they are unmuted");
    expect(mutesTable[1]).toMatchObject({ username: "sleeper", reason: null });
  });

  test("mute until lifted when that is said in a word, so a reason may begin with what reads as a time", async () => {
    expect(await moderation.muteCommand(boss, ["troll", "Permanent", "7d", "of", "spam"], NOON)).toBe("Muted Troll until they are unmuted");

    expect(mutesTable[0]).toMatchObject({ reason: "7d of spam", expires_at: null });
  });

  test("refuse a name there is no account for, oneself, and an admin", async () => {
    expect(await moderation.muteCommand(boss, [], NOON)).toBe("Usage: /mute <username> [duration] [reason]");
    expect(await moderation.muteCommand(boss, ["nobody"], NOON)).toBe("Player not found");
    expect(await moderation.muteCommand(boss, ["BOSS"], NOON)).toBe("You cannot mute yourself");
    expect(await moderation.muteCommand(mod, ["boss"], NOON)).toBe("You cannot mute other admins");
    expect(mutesTable).toEqual([]);
  });

  test("lift a mute, and say so when there was none", async () => {
    await moderation.muteCommand(boss, ["troll"], NOON);

    expect(await moderation.unmuteCommand(boss, ["TROLL"], NOON)).toBe("Unmuted Troll");
    expect(await mutes.isMuted("troll", NOON)).toBe(false);
    expect(await moderation.unmuteCommand(boss, ["troll"], NOON)).toBe("Troll is not muted");
    expect(await moderation.unmuteCommand(boss, ["nobody"], NOON)).toBe("Player not found");
    expect(await moderation.unmuteCommand(boss, [], NOON)).toBe("Usage: /unmute <username>");
  });
});

describe("/ignore, /unignore and /ignorelist", () => {
  test("ignore a player, and answer with the list as it now stands", async () => {
    expect(await moderation.ignore(hero, "Troll")).toEqual({ message: "You are now ignoring Troll", ignored: ["troll"] });
    expect(await moderation.ignore(hero, "sleeper")).toEqual({ message: "You are now ignoring Sleeper", ignored: ["troll", "sleeper"] });
    expect(await moderation.ignoreList(hero)).toBe("You are ignoring: Troll, Sleeper");
  });

  test("say why a player was not ignored, and change nothing", async () => {
    await moderation.ignore(hero, "troll");

    expect(await moderation.ignore(hero, "TROLL")).toEqual({ message: "You are already ignoring Troll" });
    expect(await moderation.ignore(hero, "hero")).toEqual({ message: "You cannot ignore yourself" });
    expect(await moderation.ignore(hero, "nobody")).toEqual({ message: "Player not found" });
    expect(await moderation.ignore(hero, "  ")).toEqual({ message: "Usage: /ignore <username>" });
    expect(await ignores.list("hero")).toEqual(["troll"]);
  });

  test("refuse a player ignoring an admin, and an admin ignoring anyone", async () => {
    expect(await moderation.ignore(hero, "Boss")).toEqual({ message: "You cannot ignore an admin" });
    expect(await moderation.ignore(boss, "troll")).toEqual({ message: "Admins cannot ignore players" });
    expect(ignoresTable).toEqual([]);
  });

  test("end a friendship on both sides, and hand back each list for its owner", async () => {
    friendsTable.push({ username: "hero", friends: "ally,troll" }, { username: "troll", friends: "hero" });

    const answer = await moderation.ignore(hero, "troll");

    expect(answer.unfriended).toEqual({ target: "troll", mine: ["ally"], theirs: [] });
    expect(friendsTable).toEqual([{ username: "hero", friends: "ally" }, { username: "troll", friends: "" }]);
  });

  test("leave the friends lists alone when the two were not friends", async () => {
    friendsTable.push({ username: "hero", friends: "ally" });

    expect((await moderation.ignore(hero, "troll")).unfriended).toBeUndefined();
    expect(friendsTable).toEqual([{ username: "hero", friends: "ally" }]);
  });

  test("stop ignoring a player, and say so when they were not ignored", async () => {
    await moderation.ignore(hero, "troll");

    expect(await moderation.unignore(hero, "Troll")).toEqual({ message: "You are no longer ignoring Troll", ignored: [] });
    expect(await moderation.unignore(hero, "troll")).toEqual({ message: "You are not ignoring Troll" });
    expect(await moderation.unignore(hero, "")).toEqual({ message: "Usage: /unignore <username>" });
    expect(await moderation.ignoreList(hero)).toBe("You are not ignoring anyone");
  });
});

describe("a report from a player", () => {
  test("is filed with where both were and the reported player's lines that reached the reporter", async () => {
    await audience("troll", "say", "you again", ["hero", "ally"], NOON - 2000);
    await audience("troll", "whisper", "not for hero", ["ally"], NOON - 1000);

    const answer = await moderation.report(hero, "Troll", "harassment", "keeps following me", NOON);

    expect(answer.message).toBe("Thank you. Your report was sent");
    expect(answer.report).toMatchObject({
      id: 1, reporter: "hero", target: "troll", category: "harassment", details: "keeps following me",
      map: "overworld", x: 10, y: 21, target_map: "overworld", target_x: 12, target_y: 21,
    });
    expect(answer.report!.chat_log.map((line) => line.text)).toEqual(["you again"]);
  });

  test("of a player who is offline has no place for them", async () => {
    expect((await moderation.report(hero, "sleeper", "name", null, NOON)).report).toMatchObject({ target: "sleeper", target_map: null, details: null });
  });

  test("says why it was not filed", async () => {
    await moderation.report(hero, "troll", "spam", null, NOON);

    expect(await moderation.report(hero, "troll", "spam", null, NOON)).toEqual({ message: "You have already reported this player" });
    expect(await moderation.report(hero, "hero", "spam", null, NOON)).toEqual({ message: "You cannot report yourself" });
    expect(await moderation.report(hero, "nobody", "spam", null, NOON)).toEqual({ message: "Player not found" });
    expect(await moderation.report(hero, "ally", "boring", null, NOON)).toEqual({ message: "Choose a reason for the report" });
    expect(await moderation.report(hero, "", "spam", null, NOON)).toEqual({ message: "Usage: /report <username> <reason>" });
    expect(reportsTable).toHaveLength(1);
  });

  test("is told to the staff in one line", async () => {
    const { report } = await moderation.report(hero, "troll", "name", null, NOON);

    expect(moderation.staffNotice(report!)).toBe("New report #1: Hero reported Troll (Offensive name). /reports view 1");
  });

  test("can be handled by whoever holds the reports permission, or every admin permission", () => {
    expect(moderation.can(mod, "admin.reports")).toBe(true);
    expect(moderation.can(boss, "admin.reports")).toBe(true);
    expect(moderation.can(hero, "admin.reports")).toBe(false);
    expect(moderation.can(null, "admin.reports")).toBe(false);
  });
});

describe("/reports", () => {
  test("needs its permission", async () => {
    expect(await moderation.reportsCommand(hero, [], NOON)).toBe("You don't have permission to use this command");
  });

  test("lists the open reports, newest first", async () => {
    expect(await moderation.reportsCommand(mod, [], NOON)).toBe("There are no open reports");

    await moderation.report(hero, "troll", "harassment", null, NOON - 65 * MINUTE);
    await moderation.report(troll, "hero", "other", "he started it", NOON - 5 * MINUTE);

    expect(await moderation.reportsCommand(mod, ["list"], NOON)).toBe([
      "Open reports: 2",
      "#2 Hero (Other) by Troll, 5m ago",
      "#1 Troll (Harassment) by Hero, 1h ago",
    ].join("\n"));
  });

  test("shows one report: what was said, where, the lines attached and how many others name the player", async () => {
    await audience("troll", "say", "you again", ["hero"], NOON - 6 * MINUTE);
    await moderation.report(hero, "troll", "harassment", "keeps following me", NOON - 5 * MINUTE);

    expect(await moderation.reportsCommand(mod, ["view", "1"], NOON)).toBe([
      "#1 Troll (Harassment) by Hero, 5m ago",
      "\"keeps following me\"",
      "Troll was at overworld (12, 21)",
      "[say] you again",
      "Open reports naming Troll: 1",
    ].join("\n"));
    expect(await moderation.reportsCommand(mod, ["view", "9"], NOON)).toBe("No report has that number");
  });

  test("resolves a report once, with a note", async () => {
    await moderation.report(hero, "sleeper", "name", null, NOON);

    expect(await moderation.reportsCommand(mod, ["resolve", "1", "asked", "to", "rename"], NOON + MINUTE)).toBe("Report #1 resolved");
    expect(reportsTable[0]).toMatchObject({ status: "resolved", resolved_by: "mod", resolution: "asked to rename" });
    expect(await moderation.reportsCommand(mod, ["resolve", "1"], NOON + MINUTE)).toBe("No open report has that number");
    expect(await moderation.reportsCommand(mod, ["view", "1"], NOON + MINUTE)).toContain("resolved by Mod");
    expect(await reports.open()).toEqual([]);
  });

  test("says how it is used when it is not understood", async () => {
    const usage = "Usage: /reports, /reports view <number>, /reports resolve <number> [note]";

    expect(await moderation.reportsCommand(mod, ["view"], NOON)).toBe(usage);
    expect(await moderation.reportsCommand(mod, ["resolve", "abc"], NOON)).toBe(usage);
    expect(await moderation.reportsCommand(mod, ["close", "1"], NOON)).toBe(usage);
  });
});

describe("/trades", () => {
  const gave = (items: Array<[string, number]> = [], gold = 0, silver = 0, copper = 0) =>
    JSON.stringify({ items: items.map(([name, quantity]) => ({ name, quantity })), coins: { gold, silver, copper } });

  test("needs its permission", async () => {
    expect(await moderation.tradesCommand(hero, ["troll"], NOON)).toBe("You don't have permission to use this command");
    expect(await moderation.tradesCommand(mod, ["troll"], NOON)).toBe("You don't have permission to use this command");
  });

  test("lists a player's latest trades, newest first, from their side", async () => {
    tradesTable = [
      { id: 1, player_a: "hero", player_b: "troll", a_gave: gave([["Iron Ore", 4], ["Rat Tail", 1]], 0, 1, 60), b_gave: gave([["Health Potion", 5]]), created_at: NOON - 65 * MINUTE },
      { id: 2, player_a: "ally", player_b: "hero", a_gave: gave([], 12), b_gave: gave(), created_at: NOON - 5 * MINUTE },
      { id: 3, player_a: "ally", player_b: "troll", a_gave: gave(), b_gave: gave([["Rat Tail", 2]]), created_at: NOON - MINUTE },
    ];
    await datacache.clearCaches();

    expect(await moderation.tradesCommand(boss, ["HERO"], NOON)).toBe([
      "Hero's latest trades: 2",
      "#2 with Ally, 5m ago: gave nothing, got 12g",
      "#1 with Troll, 1h ago: gave 4 Iron Ore, 1 Rat Tail, 1s 60c, got 5 Health Potion",
    ].join("\n"));
  });

  test("says so when a player has made none, or is nobody", async () => {
    expect(await moderation.tradesCommand(boss, ["sleeper"], NOON)).toBe("Sleeper has no trades on record");
    expect(await moderation.tradesCommand(boss, ["nobody"], NOON)).toBe("Player not found");
    expect(await moderation.tradesCommand(boss, [], NOON)).toBe("Usage: /trades <username>");
  });

  test("lists ten at most", async () => {
    tradesTable = Array.from({ length: 14 }, (_, index) => ({ id: index + 1, player_a: "hero", player_b: "troll", a_gave: gave([], 1), b_gave: gave(), created_at: NOON - MINUTE }));
    await datacache.clearCaches();
    const lines = (await moderation.tradesCommand(boss, ["hero"], NOON)).split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[1]).toStartWith("#14 ");
    expect(lines[10]).toStartWith("#5 ");
  });
});

describe("how long ago", () => {
  test("is said in the largest unit that fits", () => {
    expect(moderation.ago(NOON - 20_000, NOON)).toBe("just now");
    expect(moderation.ago(NOON - 59 * MINUTE, NOON)).toBe("59m ago");
    expect(moderation.ago(NOON - 23 * 60 * MINUTE, NOON)).toBe("23h ago");
    expect(moderation.ago(NOON - 3 * 24 * 60 * MINUTE, NOON)).toBe("3d ago");
  });
});
