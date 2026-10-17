import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// Achievements: counting (systems/achievements/service.ts), earning with its rewards, and the collectables a batch
// adds. The real store, inventory, collectables and mail systems run against a fake database.

type Row = Record<string, any>;
let tables: { achievements: Row[]; player_achievements: Row[]; inventory: Row[]; collectables: Row[]; mail: Row[] };
let nextId = 1;
let failing: ((sql: string) => boolean) | null = null;
/** Each write to player_achievements: "progress" or "completed". */
const written: string[] = [];

const fold = (value: unknown) => String(value).toLowerCase();
const DEF_SELECT = "SELECT id, name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled FROM achievements";
const ROWS_SELECT = "SELECT achievement_id, progress, completed_at FROM player_achievements WHERE username = ?";
const PROGRESS = "INSERT INTO player_achievements (username, achievement_id, progress) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE progress = CASE WHEN completed_at IS NULL AND ? > progress THEN ? ELSE progress END";
const ROW = "INSERT IGNORE INTO player_achievements (username, achievement_id, progress, completed_at) VALUES (?, ?, 0, NULL)";
const COMPLETED = "UPDATE player_achievements SET progress = ?, completed_at = ? WHERE username = ? AND achievement_id = ? AND completed_at IS NULL";
const MAIL_COLUMNS = "id, recipient, sender, subject, body, items, copper, silver, gold, sent_at, expires_at, is_read, returned";

function upsert(username: string, id: number, fields: Row) {
  const row = tables.player_achievements.find((r) => r.username === username && r.achievement_id === id);
  if (row) Object.assign(row, fields);
  else tables.player_achievements.push({ username, achievement_id: id, progress: 0, completed_at: null, ...fields });
  return { affectedRows: row ? 2 : 1 };
}

function run(sql: string, values: any[] = []): any {
  const text = sql.replace(/\s+/g, " ").trim();
  if (failing?.(text)) throw new Error("database gone");
  if (text.startsWith("CREATE ") || text.includes("permission_types")) return [];
  if (text === DEF_SELECT) return tables.achievements.map((r) => ({ ...r }));
  if (text === ROWS_SELECT) {
    return tables.player_achievements.filter((r) => r.username === values[0]).map(({ achievement_id, progress, completed_at }) => ({ achievement_id, progress, completed_at }));
  }
  if (text === PROGRESS) {
    written.push("progress");
    // progress = CASE WHEN completed_at IS NULL AND ? > progress THEN ? ELSE progress END
    const held = tables.player_achievements.find((r) => r.username === values[0] && r.achievement_id === values[1]);
    if (!held) return upsert(values[0], values[1], { progress: values[2] });
    return upsert(values[0], values[1], held.completed_at === null && values[3] > held.progress ? { progress: values[4] } : {});
  }
  if (text === ROW) {
    const held = tables.player_achievements.find((r) => r.username === values[0] && r.achievement_id === values[1]);
    if (held) return { affectedRows: 0 };
    return upsert(values[0], values[1], {});
  }
  if (text === COMPLETED) {
    // only a row that is not completed yet
    const held = tables.player_achievements.find((r) => r.username === values[2] && r.achievement_id === values[3] && r.completed_at === null);
    if (!held) return { affectedRows: 0 };
    written.push("completed");
    Object.assign(held, { progress: values[0], completed_at: values[1] });
    return { affectedRows: 1 };
  }
  if (text === "SELECT * FROM inventory WHERE username = ?") return tables.inventory.filter((r) => fold(r.username) === fold(values[0])).map((r) => ({ ...r }));
  if (text === "INSERT IGNORE INTO inventory (username, item, quantity) VALUES (?, ?, ?)") {
    const [username, item, quantity] = values;
    const row = { id: nextId++, username, item, quantity: Number(quantity), equipped: 0, slot: null, bag_slot: null };
    tables.inventory.push(row);
    return { affectedRows: 1, lastInsertRowid: row.id };
  }
  if (text === "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?") {
    const [quantity, item, username] = values;
    const rows = tables.inventory.filter((r) => fold(r.username) === fold(username) && fold(r.item) === fold(item));
    rows.forEach((r) => { r.quantity = Number(quantity); });
    return { affectedRows: rows.length };
  }
  if (text === "SELECT item, type FROM collectables WHERE username = ?") {
    return tables.collectables.filter((r) => fold(r.username) === fold(values[0])).map(({ item, type }) => ({ item, type }));
  }
  if (text === "INSERT INTO collectables (type, item, username) VALUES (?, ?, ?)") {
    const [type, item, username] = values;
    tables.collectables.push({ type, item, username });
    return { affectedRows: 1 };
  }
  if (text === `SELECT ${MAIL_COLUMNS} FROM mail WHERE recipient = ? ORDER BY id`) return tables.mail.filter((r) => r.recipient === values[0]).map((r) => ({ ...r }));
  if (text.startsWith("INSERT INTO mail (")) {
    const [recipient, sender, subject, body, items, copper, silver, gold, sent_at, expires_at] = values;
    // the last two values of the statement are is_read and returned, written in it
    const row = { id: nextId++, recipient, sender, subject, body, items, copper, silver, gold, sent_at, expires_at, is_read: 0, returned: text.endsWith(", 0, 1)") ? 1 : 0 };
    tables.mail.push(row);
    return { affectedRows: 1, lastInsertRowid: row.id };
  }
  if (text === "DELETE FROM mail WHERE id = ? AND recipient = ?") {
    const before = tables.mail.length;
    tables.mail = tables.mail.filter((r) => !(r.id === values[0] && r.recipient === values[1]));
    return { affectedRows: before - tables.mail.length };
  }
  if (text.startsWith("INSERT INTO achievements")) {
    const [name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled] = values;
    const id = nextId++;
    tables.achievements.push({ id, name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled });
    return { lastInsertRowid: id, affectedRows: 1 };
  }
  if (text.startsWith("UPDATE achievements SET")) {
    const row = tables.achievements.find((r) => r.id === values[values.length - 1]);
    if (!row) return { affectedRows: 0 };
    const [name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled] = values;
    Object.assign(row, { name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled });
    return { affectedRows: 1 };
  }
  if (text === "DELETE FROM player_achievements WHERE achievement_id = ? AND completed_at IS NULL") {
    tables.player_achievements = tables.player_achievements.filter((r) => !(r.achievement_id === values[0] && r.completed_at === null));
    return { affectedRows: 1 };
  }
  if (text === "DELETE FROM player_achievements WHERE achievement_id = ?") {
    tables.player_achievements = tables.player_achievements.filter((r) => r.achievement_id !== values[0]);
    return { affectedRows: 1 };
  }
  if (text === "DELETE FROM achievements WHERE id = ?") {
    tables.achievements = tables.achievements.filter((r) => r.id !== values[0]);
    return { affectedRows: 1 };
  }
  // a read of another system's table (the quest log an inventory change reports to) holds nothing
  if (text.startsWith("SELECT")) return [];
  throw new Error(`The fake database does not understand: ${text}`);
}

/** When set, the next transaction is written and then reported as failed (a timeout after the commit). */
let lateFailure = false;
mock.module("../controllers/sqldatabase", () => {
  const base = databaseModule({ default: async (sql: string, values: any[] = []) => run(sql, values) });
  return {
    ...base,
    transaction: async (statements: any[]) => {
      const results = await base.transaction(statements);
      if (lateFailure) {
        lateFailure = false;
        throw new Error("Query timeout after 30 seconds");
      }
      return results;
    },
  };
});

const assets = new Map<string, any>();
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => assets.get(key),
    set: async (key: string, value: any) => { assets.set(key, value); },
    add: async (key: string, value: any) => { assets.set(key, value); },
  },
}));

const store = await import("../systems/achievements/store");
const { AchievementService, MAIL_SENDER } = await import("../systems/achievements/service");
const { Events, listener } = await import("../systems/events");
const { atomically } = await import("../services/batch");
const { clearCaches, reloadTable } = await import("../services/datacache");
const { default: collectables } = await import("../systems/collectables");
const { default: mail } = await import("../systems/mail");
const { default: playerCache } = await import("../services/playermanager");
const { default: log } = await import("../modules/logger");

const NOW = Date.UTC(2026, 9, 17, 12);
let room = true;
let circles = new Map<string, { party: string[]; guild: string[] }>();
const refreshed: Array<{ username: string; inventory: boolean; collectables: boolean; mail: boolean }> = [];
const service = new AchievementService({
  hasRoomFor: async () => room,
  circleOf: async (username) => circles.get(username.toLowerCase()) ?? { party: [], guild: [] },
  refresh: async (player, what) => { refreshed.push({ username: player.username, ...what }); },
  items: async () => new Map([["copper ore", "Copper Ore"]]),
  mounts: async () => new Map([["unicorn", "Unicorn"]]),
  iconUrl: (icon) => (icon ? `icon:${icon}` : null),
  now: () => NOW,
});

/** What each online player was sent, decoded. */
const inbox = new Map<string, any[]>();
const onlineIds: string[] = [];
function online(username: string, extra: Record<string, unknown> = {}) {
  const box: any[] = [];
  inbox.set(username, box);
  const player = { id: `id-${username}`, username, wt: { readyState: 1, send: (p: Uint8Array) => box.push(JSON.parse(new TextDecoder().decode(p))) }, ...extra };
  playerCache.add(player.id, player);
  onlineIds.push(player.id);
  return player;
}
const packets = (username: string, type: string) => (inbox.get(username) ?? []).filter((p) => p.type === type);

function define(over: Row = {}): number {
  const id = nextId++;
  tables.achievements.push({
    id, name: `Achievement ${id}`, description: "", icon: null, type: "creature_kill", target: null, count: 10,
    reward_item: null, reward_quantity: 1, reward_mount: null, enabled: 1, ...over,
  });
  return id;
}
const defined = () => reloadTable("achievements");
const progressOf = async (username: string, id: number) => (await store.rowsOf(username)).find((r) => r.achievement_id === id)?.progress ?? null;
const loot = (username: string, quantity = 1) =>
  service.onEvent(Events.PLAYER_LOOT_RETRIEVED, { player: { username }, itemName: "Wolf Pelt", quantity, mapName: "forest", x: 0, y: 0 });

let warnSpy: ReturnType<typeof spyOn>;
let otherSpies: Array<ReturnType<typeof spyOn>> = [];
beforeAll(async () => {
  warnSpy = spyOn(log, "warn").mockImplementation(() => {});
  otherSpies = [spyOn(log, "info").mockImplementation(() => {}), spyOn(log, "error").mockImplementation(() => {})];
  expect(await store.ensureAchievementSchema()).toBe(true);
});

afterAll(() => {
  warnSpy.mockRestore();
  for (const spy of otherSpies) spy.mockRestore();
});

beforeEach(async () => {
  tables = { achievements: [], player_achievements: [], inventory: [], collectables: [], mail: [] };
  nextId = 1;
  failing = null;
  lateFailure = false;
  written.length = 0;
  room = true;
  circles = new Map();
  refreshed.length = 0;
  inbox.clear();
  warnSpy.mockClear();
  assets.set("items", [{ name: "Copper Ore", icon: "copper_ore", quality: "common" }]);
  assets.set("mounts", [{ name: "Unicorn", description: "A unicorn." }]);
  store.resetChanges();
  await clearCaches();
  // Only the players a test puts online are online: test files that run earlier can leave players in the shared
  // cache (the order files run in differs between machines, see src/tests/setup.ts standInFor).
  playerCache.clear();
});

afterEach(() => {
  for (const id of onlineIds.splice(0)) playerCache.remove(id);
});

describe("counting", () => {
  test("a kill counts for the player credited, toward that creature or any creature", async () => {
    const wolves = define({ target: "7" });
    const any = define({ target: null });
    const bears = define({ target: "8" });
    await defined();
    await service.onEvent(Events.CREATURE_KILL_CREDIT, { player: { username: "alice" }, templateId: 7 });
    expect(await progressOf("alice", wolves)).toBe(1);
    expect(await progressOf("alice", any)).toBe(1);
    expect(await progressOf("alice", bears)).toBeNull();
  });

  test("names are matched without regard to case, and a gather counts what it gave", async () => {
    const ore = define({ type: "gather", target: "copper ore" });
    await defined();
    await service.onEvent(Events.GATHER_COMPLETED, { player: { username: "alice" }, item: "Copper Ore", quantity: 3 });
    expect(await progressOf("alice", ore)).toBe(3);
  });

  test("a level achievement holds the highest level reached", async () => {
    const level = define({ type: "level", count: 20 });
    await defined();
    await service.onEvent(Events.PLAYER_LEVEL_UP, { player: { username: "alice" }, level: 5 });
    await service.onEvent(Events.PLAYER_LEVEL_UP, { player: { username: "alice" }, level: 3 });
    expect(await progressOf("alice", level)).toBe(5);
  });

  test("a trade counts for both players", async () => {
    const trades = define({ type: "trade", count: 5 });
    await defined();
    await service.onEvent(Events.TRADE_COMPLETED, { trade: { id: 1, player_a: "alice", player_b: "bob" } });
    expect(await progressOf("alice", trades)).toBe(1);
    expect(await progressOf("bob", trades)).toBe(1);
  });

  test("a player's kill counts for the killer and the death for the one who died; a creature's kill only the death", async () => {
    const pvp = define({ type: "pvp_kill" });
    const death = define({ type: "death" });
    await defined();
    await service.onEvent(Events.PLAYER_DEATH, { player: { username: "alice" }, killer: { username: "bob" } });
    await service.onEvent(Events.PLAYER_DEATH, { player: { username: "alice" }, killer: { id: "creature:1", username: "Wolf", isCreature: true } });
    expect(await progressOf("alice", death)).toBe(2);
    expect(await progressOf("bob", pvp)).toBe(1);
    expect(await progressOf("alice", pvp)).toBeNull();
  });

  test("a guest is not counted", async () => {
    define();
    await defined();
    online("visitor", { isGuest: true });
    await service.onEvent(Events.CREATURE_KILL_CREDIT, { player: { username: "visitor" }, templateId: 1 });
    expect(await store.rowsOf("visitor")).toEqual([]);
  });

  test("a disabled achievement is not counted", async () => {
    const off = define({ enabled: 0 });
    await defined();
    await service.onEvent(Events.CREATURE_KILL_CREDIT, { player: { username: "alice" }, templateId: 1 });
    expect(await progressOf("alice", off)).toBeNull();
  });

  test("a deleted achievement is not counted any more", async () => {
    const kills = define();
    await defined();
    const kill = () => service.onEvent(Events.CREATURE_KILL_CREDIT, { player: { username: "alice" }, templateId: 1 });
    await kill();
    expect((await store.deleteDefinition(kills)).ok).toBe(true);
    await kill();
    expect(await progressOf("alice", kills)).toBeNull();
    expect(store.changedOf("alice").size).toBe(0);
  });

  test("an achievement deleted while a deed waits for the player's turn is not counted", async () => {
    const doomed = define();
    const kept = define();
    await defined();
    let release!: () => void;
    const holding = store.inTurn("alice", () => new Promise<void>((resolve) => { release = resolve; }));
    const counting = service.onEvent(Events.CREATURE_KILL_CREDIT, { player: { username: "alice" }, templateId: 1 });
    // the deed has read the definitions and waits for the turn the test holds
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await store.deleteDefinition(doomed)).ok).toBe(true);
    release();
    await holding;
    await counting;
    expect(await progressOf("alice", doomed)).toBeNull();
    expect(await progressOf("alice", kept)).toBe(1);
    expect([...store.changedOf("alice").keys()]).toEqual([kept]);
  });

  test("progress waits to be written on the next save, and nothing is written before", async () => {
    const kills = define();
    await defined();
    await service.onEvent(Events.CREATURE_KILL_CREDIT, { player: { username: "alice" }, templateId: 1 });
    expect(store.changedOf("alice").get(kills)).toBe(1);
    expect(written).toEqual([]);
  });
});

describe("the enabled definitions by type", () => {
  const kill = (templateId: number) => service.onEvent(Events.CREATURE_KILL_CREDIT, { player: { username: "alice" }, templateId });
  const killInput = (over: Partial<import("../systems/achievements/types").AchievementInput> = {}) => ({
    name: "Wolf Slayer", description: "", icon: null, type: "creature_kill" as const, target: "7", count: 10,
    reward_item: null, reward_quantity: 1, reward_mount: null, enabled: true, ...over,
  });

  test("a deed no enabled achievement counts does not take the player's turn or read their rows", async () => {
    define({ target: "7" });
    define({ type: "loot", enabled: 0 });
    await defined();
    let release!: () => void;
    const holding = store.inTurn("alice", () => new Promise<void>((resolve) => { release = resolve; }));
    const turns = spyOn(store, "inTurn");
    const reads = spyOn(store, "rowsOf");
    try {
      const timedOut = Symbol("timed out");
      const settled = (work: Promise<void>) => Promise.race([work.then(() => "done"), new Promise((resolve) => setTimeout(() => resolve(timedOut), 50))]);
      // another creature, a type switched off, a type nothing counts: each is done while the turn is held
      expect(await settled(kill(8))).toBe("done");
      expect(await settled(loot("alice"))).toBe("done");
      expect(await settled(service.onEvent(Events.PLAYER_DEATH, { player: { username: "alice" } }))).toBe("done");
      expect(turns).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
    } finally {
      turns.mockRestore();
      reads.mockRestore();
      release();
      await holding;
    }
    expect(store.changedOf("alice").size).toBe(0);
    // and the spies do see a deed that counts
    const counted = spyOn(store, "inTurn");
    try {
      await kill(7);
      expect(counted).toHaveBeenCalledTimes(1);
    } finally {
      counted.mockRestore();
    }
  });

  test("saving a definition makes the next deed of its type count; switching it off or deleting it takes it out", async () => {
    await defined();
    await kill(7);
    expect(await store.rowsOf("alice")).toEqual([]);
    const saved = await store.saveDefinition(null, killInput());
    if (!saved.ok) throw new Error(saved.message);
    expect((await store.definitionsOfType("creature_kill")).map((def) => def.id)).toEqual([saved.def.id]);
    await kill(7);
    expect(await progressOf("alice", saved.def.id)).toBe(1);

    expect((await store.saveDefinition(saved.def.id, killInput({ enabled: false }))).ok).toBe(true);
    expect(await store.definitionsOfType("creature_kill")).toEqual([]);
    await kill(7);
    expect(await progressOf("alice", saved.def.id)).toBe(1);

    expect((await store.saveDefinition(saved.def.id, killInput())).ok).toBe(true);
    expect((await store.definitionsOfType("creature_kill")).map((def) => def.id)).toEqual([saved.def.id]);
    expect((await store.deleteDefinition(saved.def.id)).ok).toBe(true);
    expect(await store.definitionsOfType("creature_kill")).toEqual([]);
    await kill(7);
    expect(await progressOf("alice", saved.def.id)).toBeNull();
  });

  test("a reload of the table is what the index holds after it", async () => {
    define({ target: "7" });
    await defined();
    expect(await store.definitionsOfType("creature_kill")).toHaveLength(1);
    define({ target: "8" });
    await defined();
    expect((await store.definitionsOfType("creature_kill")).map((def) => def.target)).toEqual(["7", "8"]);
  });
});

describe("earning", () => {
  test("reaching the count earns it once: dated, announced, and the reward is in the bags", async () => {
    const id = define({ name: "Pelt Hunter", description: "Loot 2 pelts.", icon: "pelt", type: "loot", target: "Wolf Pelt", count: 2, reward_item: "copper ore", reward_quantity: 3 });
    await defined();
    online("alice");
    await loot("alice");
    await loot("alice");
    await loot("alice");
    expect(tables.player_achievements).toEqual([{ username: "alice", achievement_id: id, progress: 2, completed_at: new Date(NOW).toISOString() }]);
    expect(tables.inventory.map((r) => [r.item, r.quantity])).toEqual([["Copper Ore", 3]]);
    expect(packets("alice", "ACHIEVEMENT_EARNED").map((p) => p.data)).toEqual([
      { id, name: "Pelt Hunter", description: "Loot 2 pelts.", icon: "icon:pelt", rewardItem: "Copper Ore", rewardQuantity: 3, rewardMount: null, mailed: false },
    ]);
    expect(refreshed).toEqual([{ username: "alice", inventory: true, collectables: false, mail: false }]);
    expect(store.changedOf("alice").size).toBe(0);
  });

  test("two deeds at once earn it once", async () => {
    const id = define({ type: "loot", count: 1, reward_item: "Copper Ore", reward_quantity: 3 });
    await defined();
    online("alice");
    await Promise.all([loot("alice"), loot("alice")]);
    expect(written.filter((w) => w === "completed")).toHaveLength(1);
    expect(tables.inventory.map((r) => r.quantity)).toEqual([3]);
    expect(packets("alice", "ACHIEVEMENT_EARNED")).toHaveLength(1);
    expect(tables.player_achievements[0]!.achievement_id).toBe(id);
  });

  test("a mount reward is added to the collectables, for both friends", async () => {
    define({ type: "friend_add", count: 1, reward_mount: "unicorn" });
    await defined();
    online("alice");
    await service.onEvent(Events.FRIEND_ADDED, { type: "add", playerUsername: "alice", friendUsername: "bob" });
    expect(tables.collectables).toEqual([{ type: "mount", item: "Unicorn", username: "alice" }, { type: "mount", item: "Unicorn", username: "bob" }]);
    expect(packets("alice", "ACHIEVEMENT_EARNED")[0]!.data).toMatchObject({ rewardMount: "Unicorn", rewardItem: null, rewardQuantity: 0 });
    expect(refreshed).toEqual([{ username: "alice", inventory: false, collectables: true, mail: false }]);
  });

  test("a reward that does not fit in the bags is mailed, and the popup says so", async () => {
    room = false;
    define({ type: "guild_join", count: 1, name: "Joiner", reward_item: "Copper Ore", reward_quantity: 3 });
    await defined();
    online("alice");
    await service.onEvent(Events.GUILD_CHANGED, { type: "join", guildId: 1, guildName: "G", playerUsername: "alice" });
    expect(tables.inventory).toEqual([]);
    expect(tables.mail).toHaveLength(1);
    expect(MAIL_SENDER).toBe("Achievement Rewards");
    expect(tables.mail[0]).toMatchObject({ recipient: "alice", sender: "Achievement Rewards", subject: "Achievement: Joiner", returned: 1 });
    expect(JSON.parse(tables.mail[0]!.items)).toEqual([{ name: "Copper Ore", quantity: 3 }]);
    expect(packets("alice", "ACHIEVEMENT_EARNED")[0]!.data.mailed).toBe(true);
    expect(refreshed).toEqual([{ username: "alice", inventory: false, collectables: false, mail: true }]);
  });

  test("the party and the guild are told, as a line from the game", async () => {
    define({ type: "death", count: 1, name: "First Fall" });
    await defined();
    online("alice");
    online("bob");
    online("carol");
    circles.set("alice", { party: ["alice", "Bob"], guild: ["carol", "bob"] });
    await service.onEvent(Events.PLAYER_DEATH, { player: { username: "alice" }, killer: null });
    const line = {
      id: null, username: "", system: true, message: "Alice has completed [First Fall]",
      who: "Alice", achievement: "First Fall", achievementId: expect.any(Number),
    };
    expect(packets("bob", "PARTY_CHAT").map((p) => p.data)).toEqual([line]);
    expect(packets("carol", "GUILD_CHAT").map((p) => p.data)).toEqual([line]);
    expect(packets("carol", "PARTY_CHAT")).toEqual([]);
    // in the party and the guild: told once, in party chat
    expect(packets("bob", "GUILD_CHAT")).toEqual([]);
  });

  test("a reward that no longer exists is skipped with a warning, and the achievement is still earned", async () => {
    define({ type: "death", count: 1, reward_item: "Gold Bar" });
    await defined();
    online("alice");
    await service.onEvent(Events.PLAYER_DEATH, { player: { username: "alice" } });
    expect(tables.player_achievements[0]!.completed_at).toBe(new Date(NOW).toISOString());
    expect(tables.inventory).toEqual([]);
    expect(packets("alice", "ACHIEVEMENT_EARNED")[0]!.data.rewardItem).toBeNull();
    expect(warnSpy.mock.calls.some((call: any[]) => String(call[0]).includes("Gold Bar"))).toBe(true);
  });

  test("a completion that is not written gives nothing, and the next deed tries again", async () => {
    define({ type: "loot", count: 2, reward_item: "Copper Ore", reward_quantity: 3 });
    await defined();
    online("alice");
    await loot("alice");
    failing = (sql) => sql.startsWith("UPDATE player_achievements SET progress = ?, completed_at");
    await loot("alice");
    expect(tables.inventory).toEqual([]);
    expect(packets("alice", "ACHIEVEMENT_EARNED")).toEqual([]);
    expect([...store.changedOf("alice").values()]).toEqual([1]);
    failing = null;
    await loot("alice");
    expect(tables.inventory.map((r) => r.quantity)).toEqual([3]);
    expect(packets("alice", "ACHIEVEMENT_EARNED")).toHaveLength(1);
  });

  test("a completion that was written but reported as failed gives nothing more on the next deed", async () => {
    const id = define({ type: "loot", count: 1, reward_item: "Copper Ore", reward_quantity: 3 });
    await defined();
    online("alice");
    lateFailure = true;
    await loot("alice");
    // the batch was kept by the database, though the caller was told it was not
    expect(tables.inventory.map((r) => r.quantity)).toEqual([3]);
    expect(packets("alice", "ACHIEVEMENT_EARNED")).toEqual([]);
    await loot("alice");
    await loot("alice");
    expect(tables.inventory.map((r) => r.quantity)).toEqual([3]);
    expect(written.filter((w) => w === "completed")).toHaveLength(1);
    expect(packets("alice", "ACHIEVEMENT_EARNED")).toEqual([]);
    expect(tables.player_achievements.map((r) => [r.achievement_id, r.completed_at !== null])).toEqual([[id, true]]);
  });

  test("a mailed completion that was reported as failed is not mailed twice", async () => {
    room = false;
    define({ type: "loot", count: 1, reward_item: "Copper Ore", reward_quantity: 3 });
    await defined();
    online("alice");
    lateFailure = true;
    await loot("alice");
    await loot("alice");
    expect(tables.mail).toHaveLength(1);
    expect(tables.inventory).toEqual([]);
  });

  test("completing a row the database has completed already refuses the batch and gives nothing", async () => {
    define({ type: "loot", count: 1, reward_item: "Copper Ore", reward_quantity: 3, reward_mount: "unicorn" });
    await defined();
    online("alice");
    // rows are held with no completion; the database has one (written by another process, say)
    expect(await store.rowsOf("alice")).toEqual([]);
    tables.player_achievements.push({ username: "alice", achievement_id: 1, progress: 1, completed_at: "2026-10-16T08:00:00.000Z" });
    await loot("alice");
    expect(tables.inventory).toEqual([]);
    expect(tables.collectables).toEqual([]);
    expect(tables.mail).toEqual([]);
    expect(packets("alice", "ACHIEVEMENT_EARNED")).toEqual([]);
    expect(tables.player_achievements).toEqual([{ username: "alice", achievement_id: 1, progress: 1, completed_at: "2026-10-16T08:00:00.000Z" }]);
    // the rows are read again, and show it earned: later deeds are not counted
    await loot("alice");
    expect(tables.inventory).toEqual([]);
    expect((await store.rowsOf("alice")).map((r) => r.completed_at !== null)).toEqual([true]);
  });

  test("a throw looking up the reward is a failed completion, handled like one", async () => {
    define({ type: "loot", count: 2, reward_item: "Copper Ore" });
    await defined();
    online("alice");
    await loot("alice");
    const broken = new AchievementService({
      hasRoomFor: async () => { throw new Error("bags unreadable"); },
      circleOf: async () => ({ party: [], guild: [] }),
      refresh: async () => {},
      items: async () => new Map([["copper ore", "Copper Ore"]]),
      mounts: async () => new Map(),
      iconUrl: () => null,
      now: () => NOW,
    });
    await broken.onEvent(Events.PLAYER_LOOT_RETRIEVED, { player: { username: "alice" }, itemName: "Wolf Pelt", quantity: 1, mapName: "forest", x: 0, y: 0 });
    expect(tables.player_achievements).toEqual([]);
    expect(packets("alice", "ACHIEVEMENT_EARNED")).toEqual([]);
    expect([...store.changedOf("alice").values()]).toEqual([1]);
    // and the next deed, with the lookup working again, earns it
    await loot("alice");
    expect(packets("alice", "ACHIEVEMENT_EARNED")).toHaveLength(1);
    expect(tables.inventory.map((r) => r.quantity)).toEqual([1]);
  });

  test("the list holds every enabled achievement with the player's progress and when it was earned", async () => {
    const kills = define({ name: "Kills", count: 10 });
    define({ name: "Hidden", enabled: 0 });
    const fall = define({ name: "Fall", type: "death", count: 1, reward_item: "Copper Ore", reward_quantity: 2 });
    await defined();
    online("alice");
    await service.onEvent(Events.CREATURE_KILL_CREDIT, { player: { username: "alice" }, templateId: 4 });
    await service.onEvent(Events.PLAYER_DEATH, { player: { username: "alice" } });
    const list = await service.listFor("alice");
    expect(list.map((a) => [a.id, a.progress, a.count, a.completedAt])).toEqual([[kills, 1, 10, null], [fall, 1, 1, NOW]]);
    expect(list[1]).toMatchObject({ rewardItem: "Copper Ore", rewardQuantity: 2, rewardMount: null });
    expect((await service.listFor("alice", true)).map((a) => a.progress)).toEqual([0, 0]);
  });
});

describe("system mail", () => {
  test("a reward mail is kept as already sent back: it cannot be sent back, and when it expires it is deleted", async () => {
    room = false;
    define({ type: "loot", count: 1, reward_item: "Copper Ore", reward_quantity: 3 });
    await defined();
    online("alice");
    await loot("alice");
    const letter = tables.mail[0]!;
    expect(letter).toMatchObject({ sender: "Achievement Rewards", returned: 1 });
    expect(await mail.returnToSender("alice", letter.id, NOW)).toEqual({ ok: false, message: "Mail that was sent back cannot be sent back again." });
    expect(tables.mail).toHaveLength(1);
    expect(tables.mail[0]).toMatchObject({ recipient: "alice", sender: "Achievement Rewards" });
    await mail.expire("alice", letter.expires_at + 1);
    expect(tables.mail).toEqual([]);
  });
});

describe("collectables in a batch", () => {
  const unicorn = (): Collectable => ({ type: "mount", item: "Unicorn", username: "alice", icon: null });
  const hearing = () => {
    const said: any[] = [];
    const hear = (payload: any) => said.push(payload);
    listener.on(Events.COLLECTABLE_ADDED, hear);
    return { said, stop: () => listener.off(Events.COLLECTABLE_ADDED, hear) };
  };

  test("one added in a batch is held once the batch is kept, and said once", async () => {
    const { said, stop } = hearing();
    try {
      expect(await atomically(["alice"], (batch) => collectables.add(unicorn(), batch))).toBe(true);
      expect(tables.collectables).toEqual([{ type: "mount", item: "Unicorn", username: "alice" }]);
      expect(await collectables.list("alice")).toEqual([{ item: "Unicorn", type: "mount" }]);
      expect(said).toEqual([{ username: "alice", type: "mount", item: "Unicorn" }]);
    } finally {
      stop();
    }
  });

  test("one already held is not added again, and nothing is said", async () => {
    tables.collectables.push({ type: "mount", item: "Unicorn", username: "alice" });
    const { said, stop } = hearing();
    try {
      expect(await atomically(["alice"], (batch) => collectables.add(unicorn(), batch))).toBe(false);
      expect(tables.collectables).toHaveLength(1);
      expect(said).toEqual([]);
    } finally {
      stop();
    }
  });

  test("one added outside a batch is said too", async () => {
    const { said, stop } = hearing();
    try {
      await collectables.add(unicorn());
      expect(said).toEqual([{ username: "alice", type: "mount", item: "Unicorn" }]);
    } finally {
      stop();
    }
  });
});
