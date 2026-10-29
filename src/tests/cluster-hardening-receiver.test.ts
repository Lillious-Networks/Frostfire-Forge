import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { linkPair, settle } from "./cluster-fakelink";
import { databaseModule, mockQuery } from "./setup";
import { receiverSource as readReceiverSource } from "./receiver-source";

// Phase 5 final fix wave, part A: the shared-cache guard (I1), the owner-derived admin flag of an inspect (S5), the
// one-call-at-a-time rule and the limits on what a client can fan out (S6), and the validation of a take (S8).
// socket/receiver.ts cannot be imported by a test (it imports the server, which starts it), so, as the other
// receiver tests do, the code is read from its source and run with the names it uses handed in.

// The real database layer must never load (its workers connect to a database), so the stand-in goes in before anything
// that imports it, however this file is run; the modules below are loaded after it.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery, drainQueries: async () => {} }));
const { requireSharedCache, startCluster, stopCluster } = await import("../cluster");
const { LinkCalls } = await import("../cluster/linkcalls");
const { MemoryStore } = await import("../cluster/memorystore");
const { TradeLink } = await import("../cluster/tradelink");
const { usesSharedCache } = await import("../services/datacache");
const { nothingWritten } = await import("../services/batch");
const { default: lootChest } = await import("../systems/lootChest");
const { default: log } = await import("../modules/logger");

const receiverSource = readReceiverSource();
const transpiler = new Bun.Transpiler({ loader: "ts" });

function sliceOf(from: string, to: string): string {
  const start = receiverSource.indexOf(from);
  const end = receiverSource.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`${from} was not found in socket/receiver.ts`);
  return receiverSource.slice(start, end).replace(/^export /gm, "");
}
/** A function cut out whole, from its first line to the closing brace at the left margin. */
function functionSource(name: string): string {
  const found = [...receiverSource.matchAll(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "gm"))];
  if (found.length !== 1) throw new Error(`function ${name} was found ${found.length} times in socket/receiver.ts`);
  const start = found[0]!.index!;
  const end = receiverSource.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`function ${name} has no end`);
  return receiverSource.slice(start, end + 3).replace(/^export /, "");
}
const compile = (parameters: string, body: string, returns: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${parameters} }: any) { ${body}\nreturn ${returns}; }`)}\nreturn make;`)();

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

// ================================================================== I1: the shared cache

const envBefore = { cluster: process.env.CLUSTER, cache: process.env.CACHE, node: process.env.NODE_ID, secret: process.env.CLUSTER_LINK_SECRET };
// A start past the CACHE check also needs the link secret (security review H2), which comes after it.
const LINK_SECRET = "hardening-test-link-secret-0123456789abcdef";
afterEach(async () => {
  await stopCluster();
  for (const [name, value] of [["CLUSTER", envBefore.cluster], ["CACHE", envBefore.cache], ["NODE_ID", envBefore.node], ["CLUSTER_LINK_SECRET", envBefore.secret]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("the cache is shared only with CACHE=redis, in any case", () => {
  expect(usesSharedCache({})).toBe(false);
  expect(usesSharedCache({ CACHE: "" })).toBe(false);
  expect(usesSharedCache({ CACHE: "memory" })).toBe(false);
  expect(usesSharedCache({ CACHE: "redis" })).toBe(true);
  expect(usesSharedCache({ CACHE: "Redis" })).toBe(true);
});

test("the start-up check refuses CACHE unset or not redis, names the variable and never shows its value", () => {
  expect(() => requireSharedCache({})).toThrow(/CACHE/);
  expect(() => requireSharedCache({ CACHE: "" })).toThrow(/CACHE/);
  let message = "";
  try {
    requireSharedCache({ CACHE: "s3cret-value-9x" });
  } catch (error) {
    message = String((error as Error).message);
  }
  expect(message).toContain("CACHE");
  expect(message).not.toContain("s3cret-value-9x");
  expect(() => requireSharedCache({ CACHE: "redis" })).not.toThrow();
  expect(() => requireSharedCache({ CACHE: "REDIS" })).not.toThrow();
});

/** Runs `body` with the Redis store swapped for a stand-in that is only counted, then puts the real one back. */
async function withFakeRedisStore(body: () => Promise<void>): Promise<void> {
  // A copy: mock.module patches the live namespace, so restoring the namespace itself would keep the stand-in.
  const original = { ...(await import("../cluster/redisstore")) };
  mock.module("../cluster/redisstore", () => ({ RedisStore: class { async close() {} } }));
  try {
    await body();
  } finally {
    mock.module("../cluster/redisstore", () => original);
  }
}

test("a cluster node that makes its own store does not start without CACHE=redis, and logs no value", async () => {
  process.env.CLUSTER = "true";
  process.env.NODE_ID = "b";
  process.env.CACHE = "s3cret-value-9x";
  const written: string[] = [];
  const spies = (["info", "warn", "error", "success", "debug"] as const).map((level) =>
    spyOn(log, level).mockImplementation(((message: unknown) => { written.push(String(message)); }) as any),
  );
  try {
    await withFakeRedisStore(async () => {
      const error: any = await startCluster(undefined, { publicHost: "b.example.com", port: 3000, wtPort: 3000, useSSL: true }).then(() => null, (e) => e);
      expect(error).not.toBeNull();
      expect(String(error.message)).toContain("CACHE");
      expect(String(error.message)).not.toContain("s3cret-value-9x");
    });
    expect(written.some((line) => line.includes("s3cret-value-9x"))).toBe(false);
    // The check came first: the node announced nothing and joined nothing.
    expect(written.some((line) => line.includes("joined the world"))).toBe(false);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test("with CACHE=redis the check lets the start go on (it then fails on the stand-in store, not on the cache)", async () => {
  process.env.CLUSTER = "true";
  process.env.NODE_ID = "b";
  process.env.CACHE = "redis";
  process.env.CLUSTER_LINK_SECRET = LINK_SECRET;
  await withFakeRedisStore(async () => {
    const error: any = await startCluster(undefined, { publicHost: "b.example.com", port: 3000, wtPort: 3000, useSSL: true }).then(() => null, (e) => e);
    expect(String(error?.message ?? "")).not.toContain("CACHE");
  });
});

test("a start with a store handed in is held to CACHE=redis as well", async () => {
  process.env.CLUSTER = "true";
  process.env.NODE_ID = "b";
  process.env.CLUSTER_LINK_SECRET = LINK_SECRET;
  const address = { publicHost: "b.example.com", port: 3000, wtPort: 3000, useSSL: true };
  for (const cache of [undefined, "memory"]) {
    if (cache === undefined) delete process.env.CACHE;
    else process.env.CACHE = cache;
    const error: any = await startCluster(new MemoryStore(), address).then(() => null, (e) => e);
    expect(String(error?.message ?? "")).toContain("CACHE");
  }
  process.env.CACHE = "redis";
  expect(await startCluster(new MemoryStore(), address)).not.toBeNull();
});

test("with the cluster off nothing is checked, as before", async () => {
  process.env.CLUSTER = "false";
  delete process.env.CACHE;
  expect(await startCluster(undefined, { publicHost: "b.example.com", port: 3000, wtPort: 3000, useSSL: true })).toBeNull();
});

// The partner's rows are dropped before the reload after a trade the other node hosted.
const belongings = compile(
  "dropRows, patchInventoryBagSlots, inventory, currencySystem, playerCache, sendPacket, packetManager, getInventorySlots, log",
  `${functionSource("sendBelongingsOf")}\n${functionSource("closeTradeFromHost")}`,
  "{ sendBelongingsOf, closeTradeFromHost }",
);

function trading() {
  const order: string[] = [];
  const sent: string[] = [];
  const online: any = { id: "2", username: "Bob", wt: {} };
  const helpers = belongings({
    dropRows: async (name: string, key: string) => { order.push(`drop ${name} ${key}`); },
    patchInventoryBagSlots: async (rows: any) => rows,
    inventory: { get: async (name: string) => { order.push(`read inventory ${name}`); return [{ name: "Gold Bar" }]; } },
    currencySystem: { get: async (name: string) => { order.push(`read currency ${name}`); return { copper: 5, silver: 0, gold: 0 }; } },
    playerCache: { getByUsername: (name: string) => (name === "Bob" ? online : undefined), set: () => {} },
    sendPacket: (_wt: any, packet: any) => { sent.push(packet.type); },
    packetManager: new Proxy({}, { get: (_t, kind) => (data: any) => ({ type: String(kind), data }) }),
    getInventorySlots: async () => 25,
    log: { error: () => {} },
  });
  return { order, sent, online, closeTradeFromHost: helpers.closeTradeFromHost, sendBelongingsOf: helpers.sendBelongingsOf };
}

test("after a trade another node hosted, the partner's inventory and currency copies are dropped before they are read again", async () => {
  const t = trading();
  await t.closeTradeFromHost({ username: "Bob", reload: true, completed: true, message: "done" });
  const firstRead = t.order.findIndex((entry) => entry.startsWith("read "));
  const drops = t.order.slice(0, firstRead);
  expect(drops.sort()).toEqual(["drop currency Bob", "drop inventory Bob"]);
  expect(t.order.slice(firstRead).sort()).toEqual(["read currency Bob", "read inventory Bob"]);
  expect(t.sent).toContain("tradeClosed");
});

test("a trade that ended without a swap drops and reads nothing, and a plain reload of bags drops nothing", async () => {
  const t = trading();
  await t.closeTradeFromHost({ username: "Bob", reload: false, completed: false, message: "cancelled" });
  expect(t.order).toEqual([]);
  expect(t.sent).toEqual(["tradeClosed"]);
  await t.sendBelongingsOf(t.online);
  expect(t.order.filter((entry) => entry.startsWith("drop"))).toEqual([]);
  expect(t.order.filter((entry) => entry.startsWith("read")).length).toBe(2);
});

test("the partner's trade ending is the one place that drops the copies, and the lost-trade reload does too", () => {
  expect(functionSource("closeTradeFromHost")).toContain("sendBelongingsOf(online, true)");
  expect(functionSource("relayTradeUpdate")).toContain("sendBelongingsOf(playerCache.getByUsername(username), true)");
});

// ================================================================== S5: the admin flag of an inspect

const inspecting = compile(
  "isOnline, player, log, deliverToPlayer, packetManager, inspectPlayerData, registerPlayerAction",
  sliceOf("async function inspectAskerAdmin(", "// Cluster mode: a player of a neighbouring node acts on a corpse"),
  "undefined",
);

function inspectNode(accounts: Record<string, { admin: boolean } | "throws">, online: string[]) {
  const sent: any[][] = [];
  const asked: string[] = [];
  const actions: Record<string, (p: any, args: any) => Promise<void>> = {};
  inspecting({
    isOnline: async (name: string) => online.includes(name),
    player: {
      isAdmin: async (name: string) => {
        asked.push(name);
        const account = accounts[name];
        if (account === "throws") throw new Error("database gone");
        return !!account?.admin;
      },
    },
    log: { error: () => {} },
    deliverToPlayer: async (name: string, packets: any) => { sent.push([name, packets]); return true; },
    packetManager: { inspectPlayer: (data: any) => data },
    inspectPlayerData: (target: any, whole: boolean) => ({ username: target.username, whole }),
    registerPlayerAction: (name: string, fn: any) => { actions[name] = fn; },
  });
  return { sent, asked, inspect: actions["cells-inspect"]! };
}

test("an inspect asked across a border is answered by the asker's own role, never the admin flag the bus carried", async () => {
  const { sent, inspect } = inspectNode({ Ann: { admin: false }, Boss: { admin: true } }, ["Ann", "Boss"]);
  const target = { username: "Border" };
  // A body that claims admin for an ordinary player gets the worn rows only.
  await inspect(target, { asker: "Ann", admin: true });
  // A body that claims none for an admin gets the whole inventory: the account decides.
  await inspect(target, { asker: "Boss", admin: false });
  expect(sent).toEqual([["Ann", { username: "Border", whole: false }], ["Boss", { username: "Border", whole: true }]]);
});

test("a stealthed player is shown to an admin by their account, and to nobody else whatever the body says", async () => {
  const { sent, inspect } = inspectNode({ Ann: { admin: false }, Boss: { admin: true } }, ["Ann", "Boss"]);
  const hidden = { username: "Ghost", isStealth: true };
  await inspect(hidden, { asker: "Ann", admin: true });
  expect(sent).toEqual([]);
  await inspect(hidden, { asker: "Boss" });
  expect(sent).toEqual([["Boss", { username: "Ghost", whole: true }]]);
});

test("an inspect for a name that is not online, or no name, sends nothing and asks no account", async () => {
  const { sent, asked, inspect } = inspectNode({ Boss: { admin: true } }, []);
  await inspect({ username: "Border" }, { asker: "Boss", admin: true });
  await inspect({ username: "Border" }, { admin: true });
  await inspect({ username: "Border" }, { asker: "", admin: true });
  await inspect({ username: "Border" }, undefined);
  expect(sent).toEqual([]);
  expect(asked).toEqual([]);
});

test("an asker that is not a text is no name, even when a player is online under its text", async () => {
  const { sent, asked, inspect } = inspectNode({ "42": { admin: true } }, ["42"]);
  await inspect({ username: "Border" }, { asker: 42, admin: true });
  await inspect({ username: "Border" }, { asker: { toString: () => "42" }, admin: true });
  expect(sent).toEqual([]);
  expect(asked).toEqual([]);
});

test("an account that cannot be read is no admin", async () => {
  const { sent, inspect } = inspectNode({ Boss: "throws" }, ["Boss"]);
  await inspect({ username: "Border", isStealth: true }, { asker: "Boss", admin: true });
  expect(sent).toEqual([]);
  await inspect({ username: "Border" }, { asker: "Boss", admin: true });
  expect(sent).toEqual([["Boss", { username: "Border", whole: false }]]);
});

test("the owner no longer reads the admin flag from the body", () => {
  const action = sliceOf('registerPlayerAction("cells-inspect"', "// Cluster mode: a player of a neighbouring node acts on a corpse");
  expect(action).not.toContain("args.admin");
  expect(action).not.toMatch(/\{\s*asker,\s*admin\s*\}/);
});

// ================================================================== S6: one call at a time, and the limits

const helping = compile(
  "atomically, nothingWritten, inventory, currencySystem, sendPacket, packetManager, formatMoney, log, itemOwner, askOwner, bagRoom, creatures, listener, Events, bareMap, lootChest, loot, playerCache",
  sliceOf("function stillHere(", "/** getPlayersNearPoint, and the mirrored players"),
  "{ receiveHanded, takeCorpseLootHere, takeChestItems, openCorpseHere, pickupLootHere, openChestOnOwner, stillHere }",
);

/** receiver.ts's item helpers over stand-ins, with an owner whose answers are held until the test lets them go. */
function node() {
  const asked: any[][] = [];
  const written: any[][] = [];
  const rooms: string[] = [];
  const holds: ReturnType<typeof deferred<any>>[] = [];
  const sessions = new Map<string, any>();
  let owner: string | null = "b";
  const given: Record<string, any> = {
    atomically: async (_names: string[], work: any) => work({}),
    // The real one: the stand-in batch above marks nothing as unsent, so every failure counts as one that may be written.
    nothingWritten,
    inventory: { add: async (name: string, item: any) => { written.push(["add", name, item.name, item.quantity]); return true; } },
    currencySystem: { add: async (name: string, amount: any) => { written.push(["pay", name, amount.copper]); return { copper: amount.copper, silver: 0, gold: 0 }; } },
    playerCache: { get: (id: string) => sessions.get(String(id)) },
    sendPacket: () => {},
    packetManager: new Proxy({}, { get: (_t, kind) => (data: any) => [`${String(kind)}:${JSON.stringify(data)}`] }),
    formatMoney: (copper: number) => `${copper} copper`,
    log: { error: () => {} },
    itemOwner: () => owner,
    askOwner: (...args: any[]) => {
      // As the real one: nobody to ask when this node owns the thing.
      if (!owner) return Promise.resolve(null);
      asked.push(args);
      const hold = deferred<any>();
      holds.push(hold);
      return hold.promise;
    },
    bagRoom: async (name: string) => { rooms.push(name); return { free: 3, held: [] }; },
    creatures: { takeCorpseLootFor: async () => "local-result", openCorpseFor: () => "local-open" },
    listener: { emit: () => {} },
    Events: { PLAYER_LOOT_RETRIEVED: "retrieved" },
    bareMap: (map: unknown) => String(map ?? "").replace(/\.json$/, ""),
    lootChest: {
      takeItems: async () => ({ taken: [], remaining: [], allTaken: false }),
      takeAllItems: async () => ({ taken: [], allTaken: true }),
    },
    loot: { pickup: () => ({ success: true, item: { item: "Bone", quantity: 1 } }) },
  };
  const helpers = helping(given);
  const person = (id: string, username: string) => {
    const me = { id, username, wt: {}, location: { map: "main.json", position: { x: 1, y: 2 } } };
    sessions.set(id, me);
    return me;
  };
  return { helpers, asked, written, rooms, holds, person, ownedBy: (value: string | null) => { owner = value; } };
}

test("a second corpse take while one is under way is refused, sends nothing and loses nothing; the first still writes its items", async () => {
  const t = node();
  const zed = t.person("7", "Zed");
  const first = t.helpers.takeCorpseLootHere(zed, 50, null);
  await tick();
  const second = await t.helpers.takeCorpseLootHere(zed, 50, null);

  // Refused, with a reason the packet case has a text for; no call and no read of the bags was made for it.
  expect(second).toBe("busy");
  expect(t.asked.length).toBe(1);
  expect(t.rooms).toEqual(["Zed"]);
  expect(t.written).toEqual([]);

  // The first is answered and written whole.
  t.holds[0]!.resolve({ ok: true, items: [{ itemName: "Bone", quantity: 2 }], copper: 11, empty: true, full: false, remaining: [] });
  const done = await first;
  expect(done).toMatchObject({ taken: [{ itemName: "Bone", quantity: 2 }], empty: true });
  expect(t.written).toEqual([["add", "Zed", "Bone", 2], ["pay", "Zed", 11]]);
});

test("the next call goes through once the one under way has ended, whatever way it ended", async () => {
  const t = node();
  const zed = t.person("7", "Zed");
  const failing = t.helpers.takeCorpseLootHere(zed, 50, null);
  await tick();
  t.holds[0]!.reject(new Error("link broke"));
  await expect(failing).rejects.toThrow("link broke");

  const again = t.helpers.takeCorpseLootHere(zed, 50, null);
  await tick();
  expect(t.asked.length).toBe(2);
  t.holds[1]!.resolve({ ok: false, reason: "too_far" });
  expect(await again).toBe("too_far");

  const third = t.helpers.takeCorpseLootHere(zed, 50, null);
  await tick();
  expect(t.asked.length).toBe(3);
  t.holds[2]!.resolve({ ok: true, items: [], copper: 0, empty: false, full: false, remaining: [] });
  await third;
});

test("every cross-node item call is one at a time, and each refusal is something its packet case can show", async () => {
  const t = node();
  const zed = t.person("7", "Zed");
  const open = t.helpers.openCorpseHere(zed, 50);
  await tick();
  expect(await t.helpers.openCorpseHere(zed, 50)).toBe("busy");
  expect(await t.helpers.takeCorpseLootHere(zed, 50, null)).toBe("busy");
  expect(await t.helpers.pickupLootHere(zed, "loot_1")).toEqual({ added: false, message: expect.stringContaining("already doing that") });
  expect(await t.helpers.openChestOnOwner(zed, "c1")).toEqual([expect.stringContaining("already doing that")]);
  expect(await t.helpers.takeChestItems(zed, "c1", [0])).toBeNull();
  expect(await t.helpers.takeChestItems(zed, "c1", null)).toBeNull();
  expect(t.asked.length).toBe(1);
  t.holds[0]!.resolve({ ok: true, items: [], copper: 0 });
  await open;
});

test("a pickup under way is not lost to a second one, and the item is added once", async () => {
  const t = node();
  const zed = t.person("7", "Zed");
  const first = t.helpers.pickupLootHere(zed, "loot_1");
  await tick();
  const second = await t.helpers.pickupLootHere(zed, "loot_1");
  expect(second.added).toBe(false);
  t.holds[0]!.resolve({ ok: true, item: { item: "Bone", quantity: 1 } });
  expect(await first).toEqual({ added: true });
  expect(t.written).toEqual([["add", "Zed", "Bone", 1]]);
});

test("a chest take under way keeps its items when a second take is refused", async () => {
  const t = node();
  const zed = t.person("7", "Zed");
  const first = t.helpers.takeChestItems(zed, "c1", [0]);
  await tick();
  expect(await t.helpers.takeChestItems(zed, "c1", [0])).toBeNull();
  t.holds[0]!.resolve({ ok: true, items: [{ itemName: "Gem", quantity: 1 }], remaining: [], allTaken: true });
  expect(await first).toEqual({ taken: [{ itemName: "Gem", quantity: 1 }], remaining: [], allTaken: true });
  expect(t.written).toEqual([["add", "Zed", "Gem", 1]]);
});

test("different players, and the same name in another case, are counted as they are", async () => {
  const t = node();
  const zed = t.person("7", "Zed");
  const amy = t.person("8", "Amy");
  const first = t.helpers.takeCorpseLootHere(zed, 50, null);
  const other = t.helpers.takeCorpseLootHere(amy, 50, null);
  await tick();
  expect(t.asked.length).toBe(2);
  expect(await t.helpers.takeCorpseLootHere({ ...zed, username: "ZED" }, 50, null)).toBe("busy");
  t.holds[0]!.resolve({ ok: false });
  t.holds[1]!.resolve({ ok: false });
  await first;
  await other;
});

test("a thing this node owns is not held back: two calls at once both run, as before", async () => {
  const t = node();
  t.ownedBy(null);
  const zed = t.person("7", "Zed");
  const results = await Promise.all([t.helpers.takeCorpseLootHere(zed, 50, null), t.helpers.takeCorpseLootHere(zed, 50, null)]);
  expect(results).toEqual(["local-result", "local-result"]);
  expect(await Promise.all([t.helpers.openCorpseHere(zed, 1), t.helpers.openCorpseHere(zed, 1)])).toEqual(["local-open", "local-open"]);
});

test("the packet case shows a refused loot call with the text of the refusal", () => {
  expect(sliceOf('case "CREATURE_LOOT":', 'case "USE_ITEM":')).toContain("busy: ITEM_CALL_BUSY,");
});

// The trade relays and the inspect are limited like the answers across.
const relaying = compile(
  "tradeLink, relayTradeUpdate, isQuestRateLimited, offerInTrade, acceptTrade, cancelTrade, sendPacket, packetManager",
  functionSource("tradeAction"),
  "{ tradeAction }",
);

function tradeNode(hosted: boolean, limited: () => boolean, heldState: unknown = { offers: "host" }) {
  const events: string[] = [];
  const shown: any[] = [];
  const limits: string[] = [];
  const helpers = relaying({
    tradeLink: { hostOf: () => (hosted ? "a" : null), lastState: () => heldState },
    relayTradeUpdate: async (_wt: any, _name: string, op: string) => { events.push(`relay ${op}`); },
    isQuestRateLimited: (key: string) => { limits.push(key); return limited(); },
    offerInTrade: async () => { events.push("local offer"); },
    acceptTrade: async () => { events.push("local accept"); },
    cancelTrade: () => { events.push("local cancel"); },
    sendPacket: (_wt: any, packet: any) => { shown.push(packet); },
    packetManager: { notify: (data: any) => ({ type: "notify", data }), tradeState: (data: any) => ({ type: "tradeState", data }) },
  });
  return { events, limits, shown, tradeAction: helpers.tradeAction as (wt: any, player: any, op: string, offer?: unknown) => Promise<void> };
}

test("the three trade relays are limited, and a limited one is not sent to the other node", async () => {
  const t = tradeNode(true, () => true);
  const bob = { id: "2", username: "bob" };
  await t.tradeAction({}, bob, "offer", { items: [] });
  await t.tradeAction({}, bob, "accept");
  await t.tradeAction({}, bob, "cancel");
  expect(t.events).toEqual([]);
  expect(t.limits.length).toBe(3);
});

test("a limited relay is never dropped in silence: the player is told and their window is given the offer the host holds", async () => {
  const t = tradeNode(true, () => true, { offers: "host" });
  const bob = { id: "2", username: "bob" };
  // The offer with the item taken out, which the host never gets: the window goes back to what it holds.
  for (const op of ["offer", "accept", "cancel"]) {
    t.shown.length = 0;
    await t.tradeAction({}, bob, op, op === "offer" ? { items: [] } : undefined);
    expect(t.shown.map((packet) => packet.type)).toEqual(["notify", "tradeState"]);
    expect(t.shown[0].data.message).toContain("too fast");
    expect(t.shown[1].data).toEqual({ offers: "host" });
  }
  // Before the host has sent any state there is nothing to show again, and the player is still told.
  const early = tradeNode(true, () => true, null);
  await early.tradeAction({}, bob, "cancel");
  expect(early.shown.map((packet) => packet.type)).toEqual(["notify"]);
});

test("an unlimited relay says nothing of its own to the player", async () => {
  const t = tradeNode(true, () => false);
  await t.tradeAction({}, { id: "2", username: "bob" }, "offer", { items: [] });
  expect(t.shown).toEqual([]);
});

// The partner's node keeps the trade as its host last sent it.
test("the partner's node holds the last trade state its host cast, only from that host and trade, until the trade ends", async () => {
  const links = linkPair();
  const hostCalls = new LinkCalls(200);
  const partnerCalls = new LinkCalls(200);
  hostCalls.attach(links.a);
  partnerCalls.attach(links.b);
  try {
    const host = new TradeLink(hostCalls, 400);
    const partner = new TradeLink(partnerCalls, 400);
    expect(partner.lastState("bob")).toBeNull();
    host.setPartner("bob", "b", "s1");
    partner.setHost("bob", "a", "s1");
    expect(host.sendState("bob", { offers: 1 })).toBe(true);
    await settle();
    expect(partner.lastState("bob")).toEqual({ offers: 1 });
    expect(partner.lastState("BOB")).toEqual({ offers: 1 });
    host.sendState("bob", { offers: 2 });
    await settle();
    expect(partner.lastState("bob")).toEqual({ offers: 2 });
    // A state of another trade (a stale stamp) is not kept.
    host.setPartner("bob", "b", "old");
    host.sendState("bob", { offers: 99 });
    await settle();
    expect(partner.lastState("bob")).toEqual({ offers: 2 });
    // The end of the trade: nothing is held for the next one.
    host.setPartner("bob", "b", "s1");
    host.sendClosed("bob", { completed: true, message: "", reload: false });
    await settle();
    expect(partner.hostOf("bob")).toBeNull();
    expect(partner.lastState("bob")).toBeNull();
  } finally {
    hostCalls.detach();
    partnerCalls.detach();
  }
});

test("an unlimited relay is sent, with the limit kept per player", async () => {
  const t = tradeNode(true, () => false);
  await t.tradeAction({}, { id: "2", username: "bob" }, "offer", { items: [] });
  await t.tradeAction({}, { id: "2", username: "bob" }, "accept");
  await t.tradeAction({}, { id: "2", username: "bob" }, "cancel");
  expect(t.events).toEqual(["relay offer", "relay accept", "relay cancel"]);
  expect(new Set(t.limits).size).toBe(1);
  const other = tradeNode(true, () => false);
  await other.tradeAction({}, { id: "3", username: "cy" }, "cancel");
  expect(other.limits[0]).not.toBe(t.limits[0]);
});

test("a trade held on this node is not limited by the relay limit: no call is made for it", async () => {
  const t = tradeNode(false, () => true);
  const bob = { id: "2", username: "bob" };
  await t.tradeAction({}, bob, "offer", { items: [] });
  await t.tradeAction({}, bob, "accept");
  await t.tradeAction({}, bob, "cancel");
  expect(t.events).toEqual(["local offer", "local accept", "local cancel"]);
  expect(t.limits).toEqual([]);
});

const inspectCase = compile(
  "playerCache, mirrorPlayers, isQuestRateLimited, inspectOnOwner, sendPacket, packetManager, inspectPlayerData",
  `const handle = async (type: string, data: any, currentPlayer: any, wt: any) => {\nswitch (type) {\n${sliceOf('case "INSPECTPLAYER": {', "\n  }\n}\n")}\n}\n};`,
  "handle",
);

function inspectPacket(over: { limited?: boolean; local?: Record<string, any>; mirrors?: string[] } = {}) {
  const events: string[] = [];
  const handle = inspectCase({
    playerCache: { get: (id: string) => (over.local ?? {})[id] },
    mirrorPlayers: { has: (id: string) => (over.mirrors ?? []).includes(id), get: () => undefined },
    isQuestRateLimited: (key: string) => { events.push(`limit ${key}`); return !!over.limited; },
    inspectOnOwner: async (_asker: any, id: unknown) => { events.push(`ask owner ${id}`); return true; },
    sendPacket: () => { events.push("sent"); },
    packetManager: { inspectPlayer: (data: any) => data },
    inspectPlayerData: () => ({}),
  });
  return { events, inspect: (id: unknown) => handle("INSPECTPLAYER", { id }, { id: "1", username: "ann" }, {}) };
}

test("inspecting a player of a neighbouring node is limited before the owner is asked", async () => {
  const limited = inspectPacket({ limited: true, mirrors: ["7"] });
  await limited.inspect("7");
  expect(limited.events).toEqual(["limit inspect:1"]);

  const free = inspectPacket({ limited: false, mirrors: ["7"] });
  await free.inspect("7");
  expect(free.events).toEqual(["limit inspect:1", "ask owner 7"]);
});

test("inspecting a player of this node, or an id nobody has, is not limited", async () => {
  const here = inspectPacket({ limited: true, local: { "5": { id: "5", username: "twin" } }, mirrors: ["5"] });
  await here.inspect("5");
  expect(here.events).not.toContain("limit inspect:1");
  expect(here.events).toContain("ask owner 5");
  const nobody = inspectPacket({ limited: true });
  await nobody.inspect("99");
  await nobody.inspect(undefined);
  expect(nobody.events.some((event) => event.startsWith("limit"))).toBe(false);
});

// ================================================================== S8: what a take is believed to carry

const taking = compile(
  "serveItems, creatures, loot, lootChest, bareMap",
  sliceOf('serveItems("LOOT_OPEN"', "/** The player logged in on another node"),
  "{ takeIndices, bagRoomOf, MAX_TAKE_INDICES, MAX_HELD_NAMES, MAX_FREE_SLOTS }",
);
function ownerHandlers(systems: Record<string, any>) {
  const handlers: Record<string, (actor: any, body: any) => any> = {};
  const exported = taking({
    serveItems: (name: string, fn: any) => { handlers[name] = fn; },
    bareMap: (map: unknown) => String(map ?? "").replace(/\.json$/, ""),
    creatures: {}, loot: {}, lootChest: {},
    ...systems,
  });
  return { handlers, ...exported };
}

test("the places a take asks for are whole numbers from 0, each once, and at most the limit", () => {
  const { takeIndices, MAX_TAKE_INDICES } = ownerHandlers({});
  expect(takeIndices(undefined)).toBeNull();
  expect(takeIndices("1,2")).toBeNull();
  expect(takeIndices({ length: 2 })).toBeNull();
  expect(takeIndices([])).toEqual([]);
  expect(takeIndices([2, "2", 2, 0, "1", 1])).toEqual([2, 0, 1]);
  expect(takeIndices([-1, 1.5, NaN, Infinity, "x", "", " ", null, true, false, undefined, {}, [], 3])).toEqual([3]);
  // Past the limit the rest is dropped: 100 000 places cost no more than the first ones.
  const many = Array.from({ length: 100_000 }, (_unused, i) => i);
  const kept = takeIndices(many)!;
  expect(kept.length).toBe(MAX_TAKE_INDICES);
  expect(kept[0]).toBe(0);
  expect(takeIndices(Array.from({ length: 100_000 }, () => 4))).toEqual([4]);
});

test("the room in a looter's bags is believed only as a whole number of free slots and a list of names", () => {
  const { bagRoomOf, MAX_HELD_NAMES, MAX_FREE_SLOTS } = ownerHandlers({});
  expect(bagRoomOf({ free: 2, held: ["bone"] })).toEqual({ free: 2, held: ["bone"] });
  expect(bagRoomOf({ free: 0, held: [] })).toEqual({ free: 0, held: [] });
  // Not a room: nothing fits for it, and the caller refuses.
  for (const bad of [undefined, null, "room", 5, [], {}, { free: NaN, held: [] }, { free: Infinity, held: [] }, { free: "3", held: [] }, { free: 1.5, held: [] },
    { free: null, held: [] }, { held: [] }, { free: 2 }, { free: 2, held: "bone" }, { free: 2, held: { length: 1 } }]) {
    expect(bagRoomOf(bad as any)).toBeNull();
  }
  // Fewer than none free is none; an absurd count is cut.
  expect(bagRoomOf({ free: -4, held: [] })!.free).toBe(0);
  expect(bagRoomOf({ free: 1e300, held: [] })!.free).toBe(MAX_FREE_SLOTS);
  // Only strings are names, and no more than the limit of them.
  expect(bagRoomOf({ free: 1, held: ["a", 5, null, "b", {}] })!.held).toEqual(["a", "b"]);
  const held = bagRoomOf({ free: 1, held: Array.from({ length: 5000 }, (_unused, i) => `item${i}`) })!.held;
  expect(held.length).toBe(MAX_HELD_NAMES);
});

test("a corpse take with a room that is not one is refused and asks the corpse for nothing", async () => {
  const asked: any[] = [];
  const { handlers } = ownerHandlers({ creatures: { takeCorpseLootFor: async (...args: any[]) => { asked.push(args); return { taken: [], copper: 0, empty: true, full: false, remaining: [] }; } } });
  for (const room of [undefined, null, { free: NaN, held: [] }, { free: 2, held: "x" }, "room"]) {
    expect(await handlers.LOOT_TAKE!({ username: "zed" }, { creatureId: "6", indices: null, room })).toEqual({ ok: false, reason: "failed" });
  }
  expect(asked).toEqual([]);
});

test("a corpse take hands the corpse a clean list of places and a clean room", async () => {
  const asked: any[] = [];
  const { handlers, MAX_TAKE_INDICES } = ownerHandlers({ creatures: { takeCorpseLootFor: async (...args: any[]) => { asked.push(args); return { taken: [], copper: 0, empty: false, full: false, remaining: [] }; } } });
  await handlers.LOOT_TAKE!({ username: "zed" }, { creatureId: "6", indices: [1, "1", 1, 2, -3, "x"], room: { free: -1, held: ["bone", 7] } });
  await handlers.LOOT_TAKE!({ username: "zed" }, { creatureId: "6", indices: Array.from({ length: 50_000 }, (_unused, i) => i), room: { free: 4, held: [] } });
  await handlers.LOOT_TAKE!({ username: "zed" }, { creatureId: "6", indices: null, room: { free: 4, held: [] } });
  expect(asked[0].slice(2)).toEqual([[1, 2], { free: 0, held: ["bone"] }]);
  expect(asked[1][2].length).toBe(MAX_TAKE_INDICES);
  expect(asked[2][2]).toBeNull();
});

test("a chest take hands the chest a clean list of places, and a take with no list still takes all", async () => {
  const asked: any[][] = [];
  const { handlers, MAX_TAKE_INDICES } = ownerHandlers({
    lootChest: {
      takeItems: async (...args: any[]) => { asked.push(["some", ...args]); return { taken: [], remaining: [], allTaken: false }; },
      takeAllItems: async (...args: any[]) => { asked.push(["all", ...args]); return { taken: [], allTaken: true }; },
    },
  });
  const zed = { id: 9, username: "zed" };
  await handlers.CHEST_TAKE!(zed, { chestId: "c1", indices: [0, 0, "0", 3, NaN, -1] });
  await handlers.CHEST_TAKE!(zed, { chestId: "c1", indices: Array.from({ length: 50_000 }, (_unused, i) => i) });
  await handlers.CHEST_TAKE!(zed, { chestId: "c1", indices: null });
  await handlers.CHEST_TAKE!(zed, { chestId: "c1" });
  expect(asked[0]).toEqual(["some", "c1", "9", "zed", [0, 3], false]);
  expect(asked[1]![4].length).toBe(MAX_TAKE_INDICES);
  expect(asked[2]).toEqual(["all", "c1", "9", "zed", false]);
  expect(asked[3]).toEqual(["all", "c1", "9", "zed", false]);
});

test("a chest gives each item once however often its place is asked for", async () => {
  const id = lootChest.spawn("main.json", 100, 100, undefined, [{ itemName: "Gem", quantity: 1, chance: 100 } as any, { itemName: "Opal", quantity: 1, chance: 100 } as any]);
  try {
    await lootChest.open(id, "m9");
    const first = await lootChest.takeItems(id, "m9", "zed", [0, 0, 0, 0], false);
    expect(first!.taken.length).toBe(1);
    const again = await lootChest.takeItems(id, "m9", "zed", [0, 0], false);
    expect(again!.taken.length).toBe(0);
    expect((await lootChest.takeItems(id, "m9", "zed", [1, 1], false))!.taken.length).toBe(1);
  } finally {
    lootChest.despawn(id);
  }
});
