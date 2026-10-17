import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// The achievements wired to the engine (systems/achievements/index.ts): packets, listeners, saving, the list.

type Row = Record<string, any>;
let achievements: Row[] = [];
let progress: Row[] = [];

const DEF_SELECT = "SELECT id, name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled FROM achievements";
const ROWS_SELECT = "SELECT achievement_id, progress, completed_at FROM player_achievements WHERE username = ?";
const PROGRESS = "INSERT INTO player_achievements (username, achievement_id, progress) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE progress = CASE WHEN completed_at IS NULL AND ? > progress THEN ? ELSE progress END";

function run(sql: string, values: any[] = []): any {
  const text = sql.replace(/\s+/g, " ").trim();
  if (text.startsWith("CREATE ") || text.includes("permission_types")) return [];
  if (text === DEF_SELECT) return achievements.map((r) => ({ ...r }));
  if (text === ROWS_SELECT) return progress.filter((r) => r.username === values[0]).map(({ achievement_id, progress, completed_at }) => ({ achievement_id, progress, completed_at }));
  if (text === PROGRESS) {
    // progress = CASE WHEN completed_at IS NULL AND ? > progress THEN ? ELSE progress END
    const [username, achievement_id, value, compared, raised] = values;
    const row = progress.find((r) => r.username === username && r.achievement_id === achievement_id);
    if (row) { if (row.completed_at === null && compared > row.progress) row.progress = raised; }
    else progress.push({ username, achievement_id, progress: value, completed_at: null });
    return { affectedRows: row ? 2 : 1 };
  }
  if (text.startsWith("SELECT")) return [];
  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, values: any[] = []) => run(sql, values),
}));

const wiring = await import("../systems/achievements");
const store = await import("../systems/achievements/store");
const { COUNTED_EVENTS } = await import("../systems/achievements/criteria");
const { packetManager } = await import("../socket/packet_manager");
const { packetTypes } = await import("../socket/types");
const { Events, listener } = await import("../systems/events");
const { clearCaches, reloadTable } = await import("../services/datacache");
const { default: log } = await import("../modules/logger");

const decode = (packets: any[]) => JSON.parse(new TextDecoder().decode(packets[0]));
const definition = (over: Row = {}) => ({
  id: 1, name: "Friendly", description: "Add 5 friends.", icon: null, type: "friend_add", target: null, count: 5,
  reward_item: null, reward_quantity: 1, reward_mount: null, enabled: 1, ...over,
});

let spies: Array<ReturnType<typeof spyOn>> = [];
beforeAll(async () => {
  spies = [spyOn(log, "success").mockImplementation(() => {}), spyOn(log, "info").mockImplementation(() => {})];
  expect(await store.ensureAchievementSchema()).toBe(true);
});

afterAll(() => {
  wiring.stop();
  for (const spy of spies) spy.mockRestore();
});

beforeEach(async () => {
  achievements = [];
  progress = [];
  store.resetChanges();
  await clearCaches();
});

describe("achievements wiring", () => {
  test("the packets are the types the client reads", () => {
    for (const type of [
      "ACHIEVEMENT_EARNED", "ACHIEVEMENTS_LIST", "ACHIEVEMENTS", "TOGGLE_ACHIEVEMENT_EDITOR", "ACHIEVEMENT_EDITOR_LIST",
      "ACHIEVEMENT_EDITOR_SAVE", "ACHIEVEMENT_EDITOR_DELETE", "ACHIEVEMENT_EDITOR_DATA", "ACHIEVEMENT_EDITOR_RESULT", "ACHIEVEMENT_EDITOR_UPDATED",
    ]) expect(packetTypes[type]).toBe(type);
    const earned = { id: 1, name: "A", description: "B", icon: null, rewardItem: "Copper Ore", rewardQuantity: 3, rewardMount: null, mailed: true };
    expect(decode(packetManager.achievementEarned(earned))).toEqual({ type: "ACHIEVEMENT_EARNED", data: earned });
    expect(decode(packetManager.achievements({ achievements: [] }))).toEqual({ type: "ACHIEVEMENTS", data: { achievements: [] } });
    expect(decode(packetManager.toggleAchievementEditor())).toEqual({ type: "TOGGLE_ACHIEVEMENT_EDITOR", data: null });
    expect(decode(packetManager.achievementEditorUpdated({ by: "boss" }))).toEqual({ type: "ACHIEVEMENT_EDITOR_UPDATED", data: { by: "boss" } });
  });

  test("init listens to every counted event, the save tick and leaving; stop lets them go", async () => {
    const watched = [...COUNTED_EVENTS, Events.SAVE, Events.PLAYER_LOGOUT, Events.PLAYER_DISCONNECT];
    const before = watched.map((event) => listener.listenerCount(event));
    await wiring.init();
    expect(watched.map((event) => listener.listenerCount(event))).toEqual(before.map((n) => n + 1));
    wiring.stop();
    expect(watched.map((event) => listener.listenerCount(event))).toEqual(before);
  });

  test("an event is counted through the listener", async () => {
    achievements.push(definition());
    await reloadTable("achievements");
    await wiring.init();
    try {
      listener.emit(Events.FRIEND_ADDED, { type: "add", playerUsername: "alice", friendUsername: "bob" });
      for (let i = 0; i < 50 && store.changedOf("alice").size === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect([...store.changedOf("alice").entries()]).toEqual([[1, 1]]);
    } finally {
      wiring.stop();
    }
  });

  test("the save tick writes every player's changed progress", async () => {
    store.markChanged("alice", 1, 3);
    store.markChanged("bob", 1, 4);
    await wiring.onSave();
    expect(progress.map((r) => [r.username, r.progress])).toEqual([["alice", 3], ["bob", 4]]);
  });

  test("leaving writes that player's changed progress only", async () => {
    store.markChanged("alice", 1, 3);
    store.markChanged("bob", 1, 4);
    await wiring.onLeave({ player: { id: "p1", username: "Alice" } });
    expect(progress.map((r) => r.username)).toEqual(["alice"]);
    expect(store.changedOf("bob").get(1)).toBe(4);
  });

  test.each([Events.PLAYER_LOGOUT, Events.PLAYER_DISCONNECT])("%s through the listener writes that player's changed progress", async (event) => {
    store.markChanged("alice", 1, 3);
    store.markChanged("bob", 1, 4);
    await wiring.init();
    try {
      listener.emit(event, { player: { id: "p1", username: "Alice" } });
      for (let i = 0; i < 50 && progress.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(progress.map((r) => [r.username, r.progress])).toEqual([["alice", 3]]);
      expect(store.changedOf("bob").get(1)).toBe(4);
    } finally {
      wiring.stop();
    }
  });

  test("an event whose payload cannot be read is logged and does not escape the listener", async () => {
    const errors = spyOn(log, "error").mockImplementation(() => {});
    const escaped: unknown[] = [];
    const onEscape = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", onEscape);
    await wiring.init();
    try {
      const broken = { type: "add", get playerUsername(): string { throw new Error("unreadable"); }, friendUsername: "bob" };
      expect(() => listener.emit(Events.FRIEND_ADDED, broken)).not.toThrow();
      await wiring.service.onEvent(Events.FRIEND_ADDED, broken);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(escaped).toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      wiring.stop();
      process.off("unhandledRejection", onEscape);
      errors.mockRestore();
    }
  });

  test("a player's list is sent as ACHIEVEMENTS, the enabled ones only", async () => {
    achievements.push(definition(), definition({ id: 2, name: "Hidden", enabled: 0 }));
    await reloadTable("achievements");
    const sent: any[] = [];
    await wiring.sendList({ id: "p1", username: "alice", wt: { readyState: 1, send: (p: any) => sent.push(p) } });
    const packet = decode(sent);
    expect(packet.type).toBe("ACHIEVEMENTS");
    expect(packet.data.achievements.map((a: any) => [a.name, a.progress, a.count])).toEqual([["Friendly", 0, 5]]);
  });
});
