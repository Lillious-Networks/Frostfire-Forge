import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// The gate decides who a line of chat really goes to. The mute and ignore
// systems behind it are the real ones, reading these two tables.

let muted: Array<{ username: string; muted_by: string; reason: null; created_at: number; expires_at: number | null }>;
let ignored: Array<{ username: string; ignored: string }>;

/** The two tables cannot be read: a database set up before they were added, say. */
let unreadable: boolean;

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    if (unreadable && /FROM (mutes|ignores)/.test(sql)) throw new Error("Table doesn't exist");
    if (sql.startsWith("SELECT username, muted_by")) return muted.map((row) => ({ ...row }));
    if (sql.startsWith("SELECT ignored FROM ignores")) return ignored.filter((row) => row.username === params[0]).map((row) => ({ ignored: row.ignored }));
    if (sql.startsWith("DELETE FROM mutes")) muted = muted.filter((row) => row.username !== params[0]);
    return [];
  },
}));

const datacache = await import("../services/datacache");
const { audience, recentLines, linesSeenBy, forgetLines, pruneLines, LINES_KEPT, LINES_KEPT_FOR, PRUNE_EVERY } = await import("../systems/chatgate");

const NOON = 1_800_000_000_000;

beforeEach(async () => {
  muted = [];
  ignored = [];
  unreadable = false;
  for (const name of ["hero", "ally", "rogue", "troll"]) forgetLines(name);
  await datacache.clearCaches();
});
afterAll(() => datacache.clearCaches());

describe("who a line of chat goes to", () => {
  test("everyone it was meant for, when nobody is muted or ignored", async () => {
    expect(await audience("Hero", "say", "hello", ["Ally", "rogue"], NOON)).toEqual({ muted: false, recipients: ["Ally", "rogue"] });
  });

  test("nobody, when its sender is muted, on every channel", async () => {
    muted.push({ username: "troll", muted_by: "boss", reason: null, created_at: NOON, expires_at: null });

    for (const channel of ["say", "whisper", "party", "guild"] as const) {
      expect(await audience("Troll", channel, "buy gold", ["hero", "ally"], NOON)).toEqual({ muted: true, recipients: [] });
    }
  });

  test("everyone again once the mute is over", async () => {
    muted.push({ username: "troll", muted_by: "boss", reason: null, created_at: NOON, expires_at: NOON + 60_000 });

    expect((await audience("troll", "say", "hi", ["hero"], NOON + 59_000)).recipients).toEqual([]);
    expect((await audience("troll", "say", "hi", ["hero"], NOON + 60_000)).recipients).toEqual(["hero"]);
  });

  test("everyone it was meant for when the mutes or the ignore lists cannot be read: chat goes on", async () => {
    muted.push({ username: "troll", muted_by: "boss", reason: null, created_at: NOON, expires_at: null });
    ignored.push({ username: "ally", ignored: "troll" });
    unreadable = true;

    expect(await audience("troll", "say", "hello", ["hero", "ally"], NOON)).toEqual({ muted: false, recipients: ["hero", "ally"] });
  });

  test("not the players who ignore its sender", async () => {
    ignored.push({ username: "ally", ignored: "troll" });

    expect(await audience("troll", "say", "hello", ["hero", "ally", "rogue"], NOON)).toEqual({ muted: false, recipients: ["hero", "rogue"] });
    expect(await audience("troll", "whisper", "psst", ["ally"], NOON)).toEqual({ muted: false, recipients: [] });
    // Ignoring is one way: the one who ignores is still heard.
    expect((await audience("ally", "say", "hello", ["troll"], NOON)).recipients).toEqual(["troll"]);
  });
});

describe("the lines kept for a report", () => {
  test("are a player's latest, with who each one reached", async () => {
    ignored.push({ username: "ally", ignored: "troll" });

    await audience("Troll", "say", "first", ["hero", "ally"], NOON);
    await audience("troll", "whisper", "second", ["rogue"], NOON + 1000);

    expect(recentLines("TROLL")).toEqual([
      { at: NOON, channel: "say", text: "first", to: ["hero"], muted: false },
      { at: NOON + 1000, channel: "whisper", text: "second", to: ["rogue"], muted: false },
    ]);
  });

  test("are no more than the latest few", async () => {
    for (let line = 0; line < LINES_KEPT + 5; line++) await audience("troll", "say", `line ${line}`, ["hero"], NOON + line);

    const kept = recentLines("troll");
    expect(kept).toHaveLength(LINES_KEPT);
    expect(kept[0].text).toBe("line 5");
    expect(kept.at(-1)!.text).toBe(`line ${LINES_KEPT + 4}`);
  });

  test("a muted player's lines are kept too, marked as reaching nobody", async () => {
    muted.push({ username: "troll", muted_by: "boss", reason: null, created_at: NOON, expires_at: null });

    await audience("troll", "say", "still here", ["hero"], NOON);

    expect(recentLines("troll")).toEqual([{ at: NOON, channel: "say", text: "still here", to: [], muted: true }]);
  });

  test("a reporter is shown only the lines that reached them: never a whisper to someone else", async () => {
    await audience("troll", "say", "to the map", ["Hero", "ally"], NOON);
    await audience("troll", "whisper", "to ally alone", ["ally"], NOON + 1);
    await audience("troll", "party", "to the party", ["rogue"], NOON + 2);
    await audience("troll", "whisper", "to hero", ["hero"], NOON + 3);

    expect(linesSeenBy("troll", "HERO").map((line) => line.text)).toEqual(["to the map", "to hero"]);
    expect(linesSeenBy("troll", "rogue").map((line) => line.text)).toEqual(["to the party"]);
    expect(linesSeenBy("nobody", "hero")).toEqual([]);
  });

  test("what a caller does to the lines it was given changes nothing kept", async () => {
    await audience("troll", "say", "hello", ["hero"], NOON);

    recentLines("troll")[0].to.push("ally");
    recentLines("troll").length = 0;

    expect(recentLines("troll")).toEqual([{ at: NOON, channel: "say", text: "hello", to: ["hero"], muted: false }]);
  });

  test("outlast the player leaving, for a report filed after, and are let go once they are old", async () => {
    await audience("troll", "say", "hello", ["hero"], NOON);
    await audience("hero", "say", "hi", ["troll"], NOON + LINES_KEPT_FOR - 1000);

    pruneLines(NOON + LINES_KEPT_FOR - 1);
    expect(recentLines("troll")).toHaveLength(1);

    pruneLines(NOON + LINES_KEPT_FOR);
    expect(recentLines("troll")).toEqual([]);
    expect(recentLines("hero")).toHaveLength(1);
  });

  test("are pruned as lines come in, without being asked", async () => {
    await audience("troll", "say", "hello", ["hero"], NOON);

    for (let line = 0; line <= PRUNE_EVERY; line++) await audience("hero", "say", "hi", [], NOON + LINES_KEPT_FOR + line);

    expect(recentLines("troll")).toEqual([]);
  });
});
