import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";

// A small accounts and stats table: the stand-in honours the WHERE of each statement this task writes, so a
// statement that loses its guard writes where it must not, and the test sees it.
type Row = { username: string; owner_epoch: number; saved_at: number; map: string; position: string; direction: string; health: number; session_server: string | null };
const rows = new Map<string, Row>();
const statements: string[] = [];

function run(sql: string, values: any[] = []): any {
  statements.push(sql);
  if (sql.startsWith("UPDATE accounts SET owner_epoch = ?")) {
    const [epoch, username, floor] = values;
    const row = rows.get(username);
    const guarded = sql.includes("owner_epoch < ?");
    if (!row || (guarded && !(row.owner_epoch < floor))) return { affectedRows: 0 };
    row.owner_epoch = epoch;
    return { affectedRows: 1 };
  }
  if (sql.startsWith("UPDATE accounts SET map = ?, position = ?, direction = ?, saved_at = ?")) {
    const [map, position, direction, savedAt, username, epoch, server] = values;
    const row = rows.get(username);
    const guarded = sql.includes("owner_epoch = ?");
    const realmGuarded = sql.includes("(session_server = ? OR session_server IS NULL)");
    if (!row || (guarded && row.owner_epoch !== epoch)) return { affectedRows: 0 };
    if (realmGuarded && row.session_server !== null && row.session_server !== server) return { affectedRows: 0 };
    // As MySQL counts them: a row whose columns already hold the values given is matched but not changed.
    if (row.map === map && row.position === position && row.direction === direction && row.saved_at === savedAt) return { affectedRows: 0 };
    Object.assign(row, { map, position, direction, saved_at: savedAt });
    return { affectedRows: 1 };
  }
  if (sql.startsWith("UPDATE stats SET health = ?")) {
    const row = rows.get(values[4]);
    if (row) row.health = values[0];
    return { affectedRows: row ? 1 : 0 };
  }
  if (sql.startsWith("SELECT owner_epoch, saved_at FROM accounts")) {
    const row = rows.get(values[0]);
    return row ? [{ owner_epoch: row.owner_epoch, saved_at: row.saved_at }] : [];
  }
  return [];
}

// The statements sent on their own, not in a transaction: a fenced save sends its stats write in the guarded
// transaction, an unfenced one (setStats, setLocation) on its own.
const alone: string[] = [];
let inTransaction = false;
mock.module("../controllers/sqldatabase", () => {
  const database = databaseModule({
    default: async (sql: string, values?: any[]) => {
      if (!inTransaction) alone.push(sql);
      return run(sql, values);
    },
  });
  return {
    ...database,
    transaction: async (list: any[]) => {
      inTransaction = true;
      try {
        return await database.transaction(list);
      } finally {
        inTransaction = false;
      }
    },
  };
});

const { claimOwnerEpoch, storedOwnerEpoch, adoptOwnerEpoch, fencedSaves } = await import("../cluster/ownerepoch");
const { default: player, SESSION_SERVER } = await import("../systems/player");
const { PlayerDirectory } = await import("../cluster/directory");
const { MemoryStore } = await import("../cluster/memorystore");
const { trackPresence } = await import("../cluster/presence");
const { default: playerCache } = await import("../services/playermanager");
const { default: log } = await import("../modules/logger");

const account = (username: string, owner_epoch = 0): Row => {
  const row: Row = { username, owner_epoch, saved_at: 0, map: "main", position: "0,0", direction: "down", health: 10, session_server: null };
  rows.set(username, row);
  return row;
};

afterEach(() => {
  rows.clear();
  statements.length = 0;
  alone.length = 0;
});

const stats = { health: 7, max_health: 10, stamina: 5, max_stamina: 10 } as any;
const here = { map: "main", position: { x: 10, y: 20, direction: "down" } } as any;

test("a claim raises the owner epoch", async () => {
  account("alice", 3);
  expect(await claimOwnerEpoch("Alice", 4)).toBe(true);
  expect(rows.get("alice")!.owner_epoch).toBe(4);
});

test("a claim never lowers the owner epoch", async () => {
  account("alice", 9);
  expect(await claimOwnerEpoch("alice", 4)).toBe(false);
  expect(rows.get("alice")!.owner_epoch).toBe(9);
});

test("a second claim of the epoch already held is taken", async () => {
  account("alice", 4);
  expect(await claimOwnerEpoch("alice", 4)).toBe(true);
});

test("storedOwnerEpoch reads the column; null for no account", async () => {
  account("alice", 6);
  expect(await storedOwnerEpoch("alice")).toBe(6);
  expect(await storedOwnerEpoch("nobody")).toBeNull();
});

test("a save under the held epoch writes the location, saved_at and stats", async () => {
  account("alice", 4);
  expect(await player.saveFenced("alice", 4, stats, here)).toBe("saved");
  const row = rows.get("alice")!;
  expect(row.position).toBe("10,20");
  expect(row.saved_at).toBeGreaterThan(0);
  expect(row.health).toBe(7);
});

test("a save under an old epoch writes nothing", async () => {
  account("alice", 5);
  expect(await player.saveFenced("alice", 4, stats, here)).toBe("fenced");
  const row = rows.get("alice")!;
  expect(row.position).toBe("0,0");
  expect(row.health).toBe(10);
  expect(statements.some((sql) => sql.startsWith("UPDATE stats"))).toBe(false);
});

test("a save under the held epoch is refused when another realm took the session", async () => {
  // A realm outside the cluster (or the Gateway) never raises the owner epoch: the session's realm fences it.
  account("alice", 4).session_server = "another-realm";
  expect(await player.saveFenced("alice", 4, stats, here)).toBe("fenced");
  const row = rows.get("alice")!;
  expect(row.position).toBe("0,0");
  expect(row.health).toBe(10);
});

test("a save under the held epoch lands when the session is this realm's, or nobody's", async () => {
  account("alice", 4).session_server = SESSION_SERVER;
  expect(await player.saveFenced("alice", 4, stats, here)).toBe("saved");
  account("bob", 4);
  expect(await player.saveFenced("bob", 4, stats, here)).toBe("saved");
});

test("the realm compared is the one a login here writes into session_server", () => {
  const source = readFileSync(join(import.meta.dir, "..", "systems", "player.ts"), "utf8");
  const claims = source.match(/SET session_id = \?, online = 1, session_server = \?, session_seen = \?[\s\S]*?\[sid, SESSION_SERVER, Date\.now\(\), token, sid\]/g) ?? [];
  expect(claims.length).toBe(2);
  expect(source).toContain("values: [location.map, at, direction, savedAt, name, epoch, SESSION_SERVER],");
});

test("two fenced saves in the same millisecond at the same place both land", async () => {
  account("alice", 4);
  const now = spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    expect(await player.saveFenced("alice", 4, null, here)).toBe("saved");
    const first = rows.get("alice")!.saved_at;
    expect(await player.saveFenced("alice", 4, null, here)).toBe("saved");
    expect(rows.get("alice")!.saved_at).toBeGreaterThan(first);
  } finally {
    now.mockRestore();
  }
});

test("saveStamp answers the owner epoch and the last save time", async () => {
  account("alice", 2).saved_at = 1234;
  expect(await player.saveStamp("alice")).toEqual({ ownerEpoch: 2, savedAt: 1234 });
});

function directoryFor(nodeId: string, store = new MemoryStore()) {
  return { store, directory: new PlayerDirectory(store, nodeId) };
}

test("adoptOwnerEpoch claims the directory epoch and fences saves on it", async () => {
  account("alice", 0);
  const { directory } = directoryFor("n1");
  const { entry } = await directory.claim("alice", "p1", "main");
  const alice: any = { id: "p1", username: "alice" };
  expect(await adoptOwnerEpoch(alice, entry.epoch, { directory, kick: () => { throw new Error("no kick"); } })).toBe(entry.epoch);
  expect(alice.ownerEpoch).toBe(entry.epoch);
  expect(fencedSaves(alice)).toBe(true);
});

test("a counter that went back is lifted past the stored epoch", async () => {
  // Redis lost its counters: the directory hands out epoch 1 while the database holds 50.
  account("alice", 50);
  const { directory } = directoryFor("n1");
  const { entry } = await directory.claim("alice", "p1", "main");
  expect(entry.epoch).toBe(1);
  const alice: any = { id: "p1", username: "alice" };
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const epoch = await adoptOwnerEpoch(alice, entry.epoch, { directory, kick: () => { throw new Error("no kick"); } });
    expect(epoch).toBeGreaterThan(50);
    expect(alice.ownerEpoch).toBe(epoch);
    expect((await directory.get("alice"))!.epoch).toBe(epoch!);
    expect(rows.get("alice")!.owner_epoch).toBe(epoch!);
  } finally {
    warn.mockRestore();
  }
});

test("a fenced claim whose directory entry is another node's kicks the player", async () => {
  account("alice", 50);
  const store = new MemoryStore();
  const mine = new PlayerDirectory(store, "n1");
  const { entry } = await mine.claim("alice", "p1", "main");
  // A newer login on n2 took the name since.
  await new PlayerDirectory(store, "n2").claim("alice", "p9", "main");
  const kicked: string[] = [];
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const alice: any = { id: "p1", username: "alice" };
    expect(await adoptOwnerEpoch(alice, entry.epoch, { directory: mine, kick: (p, why) => kicked.push(`${p.username}:${why}`) })).toBeNull();
    expect(kicked).toEqual(["alice:owner"]);
    expect(alice.ownerEpoch).toBeUndefined();
    expect(rows.get("alice")!.owner_epoch).toBe(50);
  } finally {
    warn.mockRestore();
  }
});

/** adoptOwnerEpoch with the database at 50, which no claim from a fresh counter outranks: who is kicked, and the answer. */
async function adoptRefused(alice: any, epoch: number, directory: any) {
  const kicked: string[] = [];
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const answer = await adoptOwnerEpoch(alice, epoch, { directory, kick: (p, why) => kicked.push(`${p.username}:${why}`) });
    return { answer, kicked };
  } finally {
    warn.mockRestore();
  }
}

test("a stale session whose entry is this node's under a newer epoch (same id) is kicked", async () => {
  account("alice", 50);
  const { directory } = directoryFor("n1");
  const { entry } = await directory.claim("alice", "p1", "main");
  // The name was claimed here again since, under the same id (a hand-back keeps it).
  const { entry: newer } = await directory.claim("alice", "p1", "main");
  const alice: any = { id: "p1", username: "alice" };
  expect(await adoptRefused(alice, entry.epoch, directory)).toEqual({ answer: null, kicked: ["alice:owner"] });
  expect(alice.ownerEpoch).toBeUndefined();
  expect((await directory.get("alice"))!.epoch).toBe(newer.epoch);
  expect(rows.get("alice")!.owner_epoch).toBe(50);
});

test("an entry of this node under another player id is kicked", async () => {
  account("alice", 50);
  const { directory } = directoryFor("n1");
  const { entry } = await directory.claim("alice", "p1", "main");
  const other: any = { id: "p2", username: "alice" };
  expect(await adoptRefused(other, entry.epoch, directory)).toEqual({ answer: null, kicked: ["alice:owner"] });
  expect(other.ownerEpoch).toBeUndefined();
  expect((await directory.get("alice"))!.epoch).toBe(entry.epoch);
  expect(rows.get("alice")!.owner_epoch).toBe(50);
});

test("a lift whose database claim then loses releases the lifted entry before the kick", async () => {
  account("alice", 50);
  const { directory } = directoryFor("n1");
  const { entry } = await directory.claim("alice", "p1", "main");
  // Between the lift and the database claim, another writer raised the owner epoch past the lifted one.
  const racing = {
    nodeId: directory.nodeId,
    get: (name: string) => directory.get(name),
    release: (name: string, epoch: number) => directory.release(name, epoch),
    lift: async (name: string, floor: number, held: any) => {
      const lifted = await directory.lift(name, floor, held);
      rows.get("alice")!.owner_epoch = 1000;
      return lifted;
    },
  };
  const alice: any = { id: "p1", username: "alice" };
  expect(await adoptRefused(alice, entry.epoch, racing)).toEqual({ answer: null, kicked: ["alice:owner"] });
  expect(alice.ownerEpoch).toBeUndefined();
  // No entry is left naming this node for a player who is gone.
  expect(await directory.get("alice")).toBeNull();
  expect(await directory.playersOn("n1")).not.toContain("alice");
});

test("a guest is never fenced", async () => {
  const { directory } = directoryFor("n1");
  const guest: any = { id: "g1", username: "guest_1", isGuest: true };
  expect(await adoptOwnerEpoch(guest, 3, { directory, kick: () => {} })).toBeNull();
  expect(fencedSaves(guest)).toBe(false);
  expect(statements.length).toBe(0);
});

test("lift refuses an entry that changed", async () => {
  const { directory } = directoryFor("n1");
  const { entry } = await directory.claim("alice", "p1", "main");
  await directory.claim("alice", "p2", "main");
  expect(await directory.lift("alice", 50, entry)).toBeNull();
});

// ------------------------------------------------------------------ presence: the epoch onClaimed answers

test("presence releases the epoch onClaimed answers, so a lifted entry is the one released", async () => {
  const { directory } = directoryFor("n7");
  const claimed: string[] = [];
  const stop = trackPresence(directory, () => {}, {
    onClaimed: async (value, entry) => {
      if (value?.username !== "Lifted") return null;
      claimed.push(value.username);
      return directory.lift(value.username, 40, entry);
    },
  });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  try {
    playerCache.add("ownerepoch-presence-1", { username: "Lifted", location: { map: "main" } });
    await settle();
    expect(claimed).toEqual(["Lifted"]);
    expect((await directory.get("lifted"))!.epoch).toBeGreaterThan(40);
    playerCache.remove("ownerepoch-presence-1");
    await settle();
    expect(await directory.get("lifted")).toBeNull();
  } finally {
    stop();
  }
});

test("presence keeps the claimed epoch when onClaimed throws", async () => {
  const { directory } = directoryFor("n8");
  const error = spyOn(log, "error").mockImplementation(() => {});
  const stop = trackPresence(directory, () => {}, {
    onClaimed: async (value) => {
      if (value?.username === "Broken") throw new Error("database gone");
      return null;
    },
  });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  try {
    playerCache.add("ownerepoch-presence-2", { username: "Broken", location: { map: "main" } });
    await settle();
    expect((await directory.get("broken"))!.epoch).toBe(1);
    playerCache.remove("ownerepoch-presence-2");
    await settle();
    expect(await directory.get("broken")).toBeNull();
  } finally {
    stop();
    error.mockRestore();
  }
});

// ------------------------------------------------------------------ the save paths, run from their source

// socket/server.ts starts the server when imported, and socket/handlers/session.ts imports the receiver, which imports
// the server: the save paths are run from their source with the names they use handed in. The real player.saveFenced,
// setStats and setLocation run against the stand-in tables above, so a save path that loses its fence writes a row
// it must not, and the test sees it.

const transpiler = new Bun.Transpiler({ loader: "ts" });
const serverSource = readFileSync(join(import.meta.dir, "..", "socket", "server.ts"), "utf8");
const sessionSource = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "session.ts"), "utf8");

/** `source` from where `from` starts up to the first match of `until` after it. */
function cut(source: string, from: string, until: RegExp): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`Not found in the source: ${from}`);
  const rest = source.slice(start);
  const end = rest.search(until);
  if (end < 0) throw new Error(`No end found for: ${from}`);
  return rest.slice(0, end);
}

/** Code that names `names`, made into a function of them. */
function withNames(names: string[], code: string): (given: Record<string, any>) => any {
  return new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();
}

/** The unfenced writes: setStats by name and setLocation by session id, each sent on its own. */
const unfencedWrites = () => alone.filter((sql) => sql.startsWith("UPDATE stats") || sql.startsWith("UPDATE accounts SET map"));
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("saveHandedOff", () => {
  const make = withNames(
    ["worlds", "achievements", "log", "player", "fencedSaves", "takeAchievementProgress", "settleFencedLeave"],
    `${cut(serverSource, "async function saveHandedOff(", /\r?\n}\r?\n/)}\n}\nreturn saveHandedOff;`,
  );
  const saveHandedOff = make({
    worlds: { adjustPlayerCount: async () => 0 },
    achievements: { onLeave: async () => {} },
    log: quiet,
    player,
    fencedSaves,
    // The leave's achievement and leftover handling has its own tests (cluster-fenced-leave.test.ts).
    takeAchievementProgress: () => new Map(),
    settleFencedLeave: async () => {},
  });

  test("a handed-off player under an old epoch writes nothing", async () => {
    account("alice", 9);
    await saveHandedOff({ id: "p1", username: "alice", ownerEpoch: 4, stats: { ...stats }, location: here });
    expect(rows.get("alice")!.health).toBe(10);
    expect(rows.get("alice")!.position).toBe("0,0");
    expect(unfencedWrites()).toEqual([]);
  });

  test("a handed-off player under the held epoch is saved through the fence", async () => {
    account("alice", 4);
    await saveHandedOff({ id: "p1", username: "alice", ownerEpoch: 4, stats: { ...stats }, location: here });
    expect(rows.get("alice")!.health).toBe(7);
    expect(rows.get("alice")!.position).toBe("10,20");
    expect(unfencedWrites()).toEqual([]);
  });

  test("with no owner epoch (CLUSTER=false) the old writes run", async () => {
    account("alice", 9);
    await saveHandedOff({ id: "p1", username: "alice", stats: { ...stats }, location: here });
    expect(rows.get("alice")!.health).toBe(7);
    expect(unfencedWrites().length).toBe(2);
  });
});

describe("the disconnect save", () => {
  const make = withNames(
    [
      "playerCache", "packetManager", "effectManager", "dots", "getStunsForPlayer", "getSlowsForPlayer", "saveSicknessOnDisconnect",
      "loot", "cleanupPlayerState", "releaseDraggedBy", "listener", "Events", "removeFromAuthenticationQueues", "worlds", "log", "player",
      "console", "forgetPlayer", "fencedSaves", "clusterEnabled", "isOnline", "deliverToPlayer", "takeAchievementProgress", "settleFencedLeave",
    ],
    `return ${cut(serverSource, 'listener.on("onDisconnect", ', /\r?\n}\);\r?\n/).replace('listener.on("onDisconnect", ', "")}\n};`,
  );
  let online: Record<string, any> = {};
  const errors: string[] = [];
  const onDisconnect = make({
    playerCache: { get: (id: string) => online[id], getByUsername: () => undefined },
    packetManager: { notify: () => [{}], updateOnlineStatus: () => [{}] },
    effectManager: { saveDots: () => {}, saveBarriers: () => {}, saveStuns: () => {}, saveSlows: () => {} },
    dots: { getPlayerDots: () => [] },
    getStunsForPlayer: () => [],
    getSlowsForPlayer: () => [],
    saveSicknessOnDisconnect: () => {},
    loot: { scheduleCleanup: () => {} },
    cleanupPlayerState: (live: any) => { delete online[live.id]; },
    releaseDraggedBy: () => {},
    listener: { emit: () => {} },
    Events: { PLAYER_DISCONNECT: "onPlayerDisconnect" },
    removeFromAuthenticationQueues: () => {},
    worlds: { adjustPlayerCount: async () => 0 },
    log: { ...quiet, error: (e: any) => errors.push(String(e)) },
    player: { saveFenced: player.saveFenced, setStats: player.setStats, setLocation: player.setLocation, clearSessionId: async () => {} },
    console: { error: () => {} },
    forgetPlayer: async () => {},
    fencedSaves,
    takeAchievementProgress: () => new Map(),
    settleFencedLeave: async () => {},
    clusterEnabled: () => false,
    isOnline: async () => false,
    deliverToPlayer: async () => {},
  });
  const leave = async (live: any) => {
    online = { [live.id]: live };
    errors.length = 0;
    await onDisconnect({ id: live.id, reason: "player_left" });
    expect(errors).toEqual([]);
  };

  test("a player under an old epoch writes nothing at disconnect", async () => {
    account("alice", 9);
    await leave({ id: "p1", username: "alice", ownerEpoch: 4, stats: { ...stats }, location: here });
    expect(rows.get("alice")!.health).toBe(10);
    expect(rows.get("alice")!.position).toBe("0,0");
    expect(unfencedWrites()).toEqual([]);
  });

  test("a player under the held epoch is saved through the fence at disconnect", async () => {
    account("alice", 4);
    await leave({ id: "p1", username: "alice", ownerEpoch: 4, stats: { ...stats }, location: here });
    expect(rows.get("alice")!.health).toBe(7);
    expect(rows.get("alice")!.position).toBe("10,20");
    expect(unfencedWrites()).toEqual([]);
  });

  test("a fenced player with no location writes no stats unfenced", async () => {
    account("alice", 9);
    await leave({ id: "p1", username: "alice", ownerEpoch: 4, stats: { ...stats } });
    expect(rows.get("alice")!.health).toBe(10);
    expect(unfencedWrites()).toEqual([]);
  });

  test("with no owner epoch (CLUSTER=false) the old writes run", async () => {
    account("alice", 9);
    await leave({ id: "p1", username: "alice", stats: { ...stats }, location: here });
    expect(rows.get("alice")!.health).toBe(7);
    expect(unfencedWrites().length).toBe(2);
  });
});

describe("the SAVE loop", () => {
  const make = withNames(
    ["playerCache", "log", "subscriptionsReady", "query", "subscriptionRefusal", "packetManager", "player", "cleanupPlayerState", "forgetNpcStream", "fencedSaves"],
    `return ${cut(serverSource, "listener.on(Events.SAVE, ", /\r?\n}\);\r?\n/).replace("listener.on(Events.SAVE, ", "")}\n};`,
  );
  let online: Record<string, any> = {};
  /** What the SAVE loop's own session query answers: each account's session id and subscribed flag. */
  let accounts: Array<{ id: number; session_id: string; subscribed: number }> = [];
  const kicked: string[] = [];
  const cleaned: string[] = [];
  const save = make({
    playerCache: { list: () => online, remove: (id: string) => { delete online[id]; } },
    log: quiet,
    subscriptionsReady: () => true,
    query: async (sql: string) => (sql.startsWith("SELECT id, session_id") ? accounts : []),
    subscriptionRefusal: (row: any) => (row.locked ? "Not subscribed" : null),
    packetManager: { notify: () => [{}] },
    player: { saveFenced: player.saveFenced, setStats: player.setStats, setLocation: player.setLocation, kick: async (username: string) => { kicked.push(username); } },
    cleanupPlayerState: (live: any) => { cleaned.push(live.username); },
    forgetNpcStream: () => {},
    fencedSaves,
  });
  const runSave = async (live: Record<string, any>) => {
    online = live;
    kicked.length = 0;
    cleaned.length = 0;
    await save();
  };

  test("a player under an old epoch writes nothing, and the stale connection is closed", async () => {
    account("alice", 9);
    accounts = [{ id: 1, session_id: "p1", subscribed: 1 }];
    const closed: string[] = [];
    await runSave({ p1: { id: "p1", userid: 1, username: "alice", ownerEpoch: 4, stats: { ...stats }, location: here, wt: { close: () => closed.push("p1") } } });
    expect(rows.get("alice")!.health).toBe(10);
    expect(rows.get("alice")!.position).toBe("0,0");
    expect(unfencedWrites()).toEqual([]);
    // Only the stale connection closes: player.kick would log out the session the account has now, the new owner's.
    expect(closed).toEqual(["p1"]);
    expect(kicked).toEqual([]);
    expect(cleaned).toEqual(["alice"]);
  });

  test("a player under the held epoch is saved, whatever the session id says", async () => {
    account("alice", 4);
    // The owner epoch decides for a fenced player, not the session id.
    accounts = [{ id: 1, session_id: "elsewhere", subscribed: 1 }];
    await runSave({ p1: { id: "p1", userid: 1, username: "alice", ownerEpoch: 4, stats: { ...stats }, location: here, wt: {} } });
    expect(rows.get("alice")!.health).toBe(7);
    expect(rows.get("alice")!.position).toBe("10,20");
    expect(unfencedWrites()).toEqual([]);
    expect(kicked).toEqual([]);
  });

  test("a fenced player still has the subscription refreshed, and is kicked when it ended", async () => {
    account("alice", 4);
    accounts = [{ id: 1, session_id: "p1", subscribed: 0 }];
    const alice: any = { id: "p1", userid: 1, username: "alice", ownerEpoch: 4, isSubscribed: true, locked: true, stats: { ...stats }, location: here, wt: {} };
    await runSave({ p1: alice });
    expect(alice.isSubscribed).toBe(false);
    expect(kicked).toEqual(["alice"]);
  });

  test("with no owner epoch (CLUSTER=false) a stolen session is still skipped", async () => {
    account("alice", 9);
    accounts = [{ id: 1, session_id: "elsewhere", subscribed: 1 }];
    await runSave({ p1: { id: "p1", userid: 1, username: "alice", stats: { ...stats }, location: here, wt: {} } });
    expect(rows.get("alice")!.health).toBe(10);
    expect(unfencedWrites()).toEqual([]);
  });

  test("with no owner epoch (CLUSTER=false) the old writes run", async () => {
    account("alice", 9);
    accounts = [{ id: 1, session_id: "p1", subscribed: 1 }];
    await runSave({ p1: { id: "p1", userid: 1, username: "alice", stats: { ...stats }, location: here, wt: {} } });
    expect(rows.get("alice")!.health).toBe(7);
    expect(unfencedWrites().length).toBe(2);
  });
});

describe("LOGOUT and DISCONNECT", () => {
  /** A case of session.ts's switch, from its opening brace to its break, made into a function. */
  function caseOf(name: string) {
    const header = `case "${name}": {`;
    const code = cut(sessionSource, header, /\r?\n\s*break;/).slice(header.length);
    return withNames(["currentPlayer", "player", "fencedSaves", "log", "listener", "Events", "wt", "releaseDraggedBy"], code);
  }
  const names = (currentPlayer: any) => ({
    currentPlayer,
    player: { saveFenced: player.saveFenced, setLocation: player.setLocation, logout: () => {}, clearSessionId: () => {} },
    fencedSaves,
    log: quiet,
    listener: { emit: () => {} },
    Events: { PLAYER_LOGOUT: "onPlayerLogout" },
    wt: { readyState: 3, close: () => {} },
    releaseDraggedBy: () => {},
  });

  for (const name of ["LOGOUT", "DISCONNECT"]) {
    const handle = caseOf(name);

    test(`${name} under an old epoch writes nothing`, async () => {
      account("alice", 9);
      handle(names({ id: "p1", username: "alice", ownerEpoch: 4, location: here }));
      await flush();
      expect(rows.get("alice")!.position).toBe("0,0");
      expect(unfencedWrites()).toEqual([]);
    });

    test(`${name} under the held epoch saves the location through the fence`, async () => {
      account("alice", 4);
      handle(names({ id: "p1", username: "alice", ownerEpoch: 4, location: here }));
      await flush();
      expect(rows.get("alice")!.position).toBe("10,20");
      expect(rows.get("alice")!.health).toBe(10);
      expect(unfencedWrites()).toEqual([]);
    });

    test(`${name} with no owner epoch (CLUSTER=false) saves by session id as before`, async () => {
      account("alice", 9);
      handle(names({ id: "p1", username: "alice", location: here }));
      await flush();
      expect(unfencedWrites().length).toBe(1);
    });
  }
});
