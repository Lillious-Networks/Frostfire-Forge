import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { LinkCalls } from "../cluster/linkcalls";
import { TradeLink, type TradeHandlers } from "../cluster/tradelink";
import { DB_QUERY_TIMEOUT_MS, SETTLE_MS, SWAP_START_MS, TradeSettle, tradeSettle } from "../cluster/tradesettle";
import { linkPair, settle } from "./cluster-fakelink";
import { databaseModule, standInFor } from "./setup";
import { receiverSource } from "./receiver-source";

// The settle fence (cluster/tradesettle.ts): after a trade across a border is lost, the bags and coins of this node's
// player wait for a swap that may still commit on the host. These run the real inventory and currency systems
// against a small fake database, and play the host's swap by writing that database behind the systems' backs.

type Row = Record<string, any>;
let inventoryRows: Row[] = [];
let currencyRows: Row[] = [];
let nextId = 1;
/** Every statement, in order, and how many transactions were sent. */
let statements: string[] = [];
let transactions = 0;

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

function fakeQuery(sql: string, values: any[] = []): any {
  const text = sql.replace(/\s+/g, " ").trim();
  statements.push(text);
  if (text === "SELECT * FROM inventory WHERE username = ?") return inventoryRows.filter((row) => same(row.username, values[0])).map((row) => ({ ...row }));
  if (text.startsWith("INSERT IGNORE INTO inventory")) {
    const [username, item, quantity] = values;
    if (inventoryRows.some((row) => same(row.username, username) && same(row.item, item))) return { affectedRows: 0 };
    const id = nextId++;
    inventoryRows.push({ id, username, item, quantity: Number(quantity), equipped: 0, slot: null, bag_slot: null });
    return { affectedRows: 1, lastInsertRowid: id };
  }
  if (text === "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?") {
    const [quantity, item, username] = values;
    const found = inventoryRows.filter((row) => same(row.username, username) && same(row.item, item));
    for (const row of found) row.quantity = Number(quantity);
    return { affectedRows: found.length };
  }
  if (text === "DELETE FROM inventory WHERE item = ? AND username = ?") {
    const [item, username] = values;
    const before = inventoryRows.length;
    inventoryRows = inventoryRows.filter((row) => !(same(row.username, username) && same(row.item, item)));
    return { affectedRows: before - inventoryRows.length };
  }
  if (text === "SELECT copper, silver, gold FROM currency WHERE username = ?") {
    return currencyRows.filter((row) => same(row.username, values[0])).map(({ copper, silver, gold }) => ({ copper, silver, gold }));
  }
  if (text.startsWith("INSERT INTO currency")) {
    const [username, copper, silver, gold] = values;
    const row = currencyRows.find((r) => same(r.username, username));
    if (row) Object.assign(row, { copper, silver, gold });
    else currencyRows.push({ username, copper, silver, gold });
    return { affectedRows: 1 };
  }
  // Every other table (the quest log an inventory change reports to, equipment, bags) holds nothing.
  return [];
}

// The database layer cannot be loaded for real in a test (it opens its pool at load), so, as the other trade tests
// do, it is replaced with mock.module and not put back.
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, values?: any[]) => fakeQuery(sql, values),
  transaction: async (list: Array<{ sql: string; values?: any[] }>) => {
    transactions++;
    return list.map((statement) => fakeQuery(statement.sql, statement.values ?? []));
  },
}));
const items = [{ name: "Iron Ore", quality: "common", type: "material", description: "", icon: "iron_ore.png", equipment_slot: null, bag_slots: null }];
await standInFor("../services/assetCache", () => ({
  default: { get: async (key: string) => (key === "items" ? items : null), set: async () => {}, add: async () => {} },
}));

const { default: log } = await import("../modules/logger");
const { default: inventory } = await import("../systems/inventory");
const { default: currency } = await import("../systems/currency");
const { default: trades, swapStart } = await import("../systems/trades");
const { atomically } = await import("../services/batch");
const { clearCaches, dropRows } = await import("../services/datacache");

const WINDOW = 300;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ore = (username: string) => inventoryRows.find((row) => same(row.username, username) && row.item === "Iron Ore")?.quantity;
const coins = (username: string) => { const { copper, silver, gold } = currencyRows.find((row) => same(row.username, username)) ?? {}; return { copper, silver, gold }; };

let warned: string[] = [];
const restores: Array<() => void> = [];
beforeEach(async () => {
  inventoryRows = [];
  currencyRows = [];
  statements = [];
  transactions = 0;
  warned = [];
  await clearCaches();
  tradeSettle.reset({ ms: WINDOW });
  const spy = (key: "warn" | "info" | "error") => {
    const s = spyOn(log, key).mockImplementation(((message: string) => { if (key === "warn") warned.push(message); }) as any);
    restores.push(() => s.mockRestore());
  };
  spy("warn");
  spy("info");
  spy("error");
});
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  tradeSettle.reset();
  trades.reset();
  await clearCaches();
});

/**
 * `name` is a player of this node (b) whose trade node a held. They have 5 Iron Ore and 40 copper, 3 silver; the trade
 * gives away 3 ore and 2 silver. The link to a goes down, the `lost` handler reads their bags again at once (as the
 * receiver does), and the swap commits on a 50 ms later. Answers once the swap has committed, inside the window: the
 * copies held here are then from before the swap, and a write that trusted them would put back what was given.
 */
async function lostWhileSwapping(name: string) {
  inventoryRows.push({ id: nextId++, username: name, item: "Iron Ore", quantity: 5, equipped: 0, slot: null, bag_slot: null });
  currencyRows.push({ username: name, copper: 40, silver: 3, gold: 0 });
  // Held here, as for any player online.
  await inventory.get(name);
  await currency.get(name);

  const { a, b } = linkPair();
  const ca = new LinkCalls(200);
  const cb = new LinkCalls(200);
  ca.attach(a);
  cb.attach(b);
  const partner = new TradeLink(cb, 400);
  const reloaded: string[] = [];
  const handlers: TradeHandlers = {
    answer: async () => ({ ok: true }),
    update: async () => ({ ok: true }),
    state: () => {},
    closed: () => {},
    // The receiver's sendBelongingsOf(online, true): the rows are dropped, then read again.
    lost: async (body) => {
      await Promise.all([dropRows("inventory", body.username), dropRows("currency", body.username)]);
      await inventory.get(body.username);
      await currency.get(body.username);
      reloaded.push(body.username);
    },
  };
  partner.setHandlers(handlers);
  // They had accepted: the swap on a may be under way.
  partner.setHost(name, "a", "s1", true);
  const started = Date.now();
  a.setUp(false);
  // The host's swap, committed after the partner read the bags again.
  const swapped = sleep(50).then(() => {
    inventoryRows.find((row) => same(row.username, name))!.quantity = 2;
    currencyRows.find((row) => same(row.username, name))!.silver = 1;
  });
  await settle();
  expect(reloaded).toEqual([name]);
  await swapped;
  // What the bags read again hold is from before the swap: the hazard the fence is for.
  expect((await inventory.find(name, { name: "Iron Ore", quantity: 0 }))?.[0]?.quantity).toBe(5);
  expect((await currency.get(name)).silver).toBe(3);
  const done = () => { partner.reset(); ca.detach(); cb.detach(); };
  return { done, started };
}

// ------------------------------------------------------------- the writes wait

test("an add during the settle window waits, and counts from what the swap left", async () => {
  const { done, started } = await lostWhileSwapping("settleann");
  try {
    await Promise.all([
      // Guard: settledThen in inventory.add. Without it the add counts from 5, and the 3 ore traded away come back (6).
      inventory.add("settleann", { name: "Iron Ore", quantity: 1 } as any),
      // Guard: settledThen in currency.add. Without it the 2 silver traded away come back.
      currency.add("settleann", { copper: 1, silver: 0, gold: 0 }),
    ]);
    expect(ore("settleann")).toBe(3);
    expect(coins("settleann")).toEqual({ copper: 41, silver: 1, gold: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(WINDOW - 50);
    // Logged once, with the reason and the peer.
    const lines = warned.filter((line) => line.includes("may predate a swap on a"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("settleann");
  } finally {
    done();
  }
});

test("a remove during the settle window waits, and counts from what the swap left", async () => {
  const { done } = await lostWhileSwapping("settlebo");
  try {
    await Promise.all([
      // Guard: settledThen in inventory.remove. Without it the remove counts from 5 and writes 4.
      inventory.remove("settlebo", { name: "Iron Ore", quantity: 1 } as any),
      // Guard: settledThen in currency.remove. Without it the balance written is 3 silver, less one copper.
      currency.remove("settlebo", { copper: 1, silver: 0, gold: 0 }),
    ]);
    expect(ore("settlebo")).toBe(1);
    expect(coins("settlebo")).toEqual({ copper: 39, silver: 1, gold: 0 });
  } finally {
    done();
  }
});

test("an inventory change in a batch during the settle window reads what the swap left", async () => {
  const { done } = await lostWhileSwapping("settlecy");
  try {
    // Guard: settledThen in inventory's pendingIn.
    await atomically(["settlecy"], async (batch) => {
      expect(await inventory.add("settlecy", { name: "Iron Ore", quantity: 1 } as any, batch)).toBe(true);
    });
    expect(ore("settlecy")).toBe(3);
  } finally {
    done();
  }
});

test("a currency change in a batch during the settle window reads what the swap left", async () => {
  const { done } = await lostWhileSwapping("settledi");
  try {
    // Guard: settledThen in currency's pendingIn.
    await atomically(["settledi"], async (batch) => {
      await currency.add("settledi", { copper: 1, silver: 0, gold: 0 }, batch);
    });
    expect(coins("settledi")).toEqual({ copper: 41, silver: 1, gold: 0 });
  } finally {
    done();
  }
});

test("a delete and a balance set during the settle window wait for it", async () => {
  const { done, started } = await lostWhileSwapping("settleed");
  try {
    let deleted = 0;
    let set = 0;
    // Guard: settledThen in inventory.delete.
    const deleting = inventory.delete("settleed", { name: "Iron Ore", quantity: 0 } as any).then(() => { deleted = Date.now() - started; });
    // Guard: settledThen in currency.set.
    const setting = currency.set("settleed", { copper: 7, silver: 0, gold: 0 }).then(() => { set = Date.now() - started; });
    await Promise.all([deleting, setting]);
    expect(deleted).toBeGreaterThanOrEqual(WINDOW - 50);
    expect(set).toBeGreaterThanOrEqual(WINDOW - 50);
    expect(ore("settleed")).toBeUndefined();
    expect(coins("settleed")).toEqual({ copper: 7, silver: 0, gold: 0 });
  } finally {
    done();
  }
});

test("a read during the window may be old; the first read after it is the database's", async () => {
  const { done } = await lostWhileSwapping("settlefu");
  try {
    // Read during the window: the copy the reload put back.
    expect((await inventory.find("settlefu", { name: "Iron Ore", quantity: 0 }))?.[0]?.quantity).toBe(5);
    await tradeSettle.settled("settlefu");
    // Guard: the drop when the mark ends.
    expect((await inventory.find("settlefu", { name: "Iron Ore", quantity: 0 }))?.[0]?.quantity).toBe(2);
    expect((await currency.get("settlefu")).silver).toBe(1);
  } finally {
    done();
  }
});

test("a player who is not marked writes at once", async () => {
  inventoryRows.push({ id: nextId++, username: "settlego", item: "Iron Ore", quantity: 5, equipped: 0, slot: null, bag_slot: null });
  tradeSettle.unsettle("someoneelse", "test", "a");
  const started = Date.now();
  await inventory.add("settlego", { name: "Iron Ore", quantity: 1 } as any);
  expect(ore("settlego")).toBe(6);
  expect(Date.now() - started).toBeLessThan(WINDOW / 2);
});

// --------------------------------------------------------------- the fence itself

test("settled on an unmarked player is one promise made at load, with no timer, and settledThen does not wait", () => {
  const fence = new TradeSettle({ ms: 100 });
  const timers = spyOn(globalThis, "setTimeout");
  try {
    const first = fence.settled("ann");
    expect(fence.settled("bob")).toBe(first);
    expect(tradeSettle.settled("ann")).toBe(first);
    let ran = false;
    void fence.settledThen("ann", async () => { ran = true; });
    // Run in the same turn: nothing was waited for.
    expect(ran).toBe(true);
    expect(timers).not.toHaveBeenCalled();
  } finally {
    timers.mockRestore();
    fence.reset();
  }
});

test("a mark is waited for, its waiters share one promise, and a player marked beside it is not held up", async () => {
  const fence = new TradeSettle({ ms: 100 });
  try {
    fence.unsettle("ann", "test", "a");
    expect(fence.settled("Ann")).toBe(fence.settled("ann"));
    let ran = false;
    void fence.settledThen("bob", async () => { ran = true; });
    expect(ran).toBe(true);
    const started = Date.now();
    await fence.settled("ann");
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(fence.unsettledUntil("ann")).toBeNull();
    expect(fence.size).toBe(0);
  } finally {
    fence.reset();
  }
});

test("a mark is made longer by a second unsettle", async () => {
  const fence = new TradeSettle({ ms: 100 });
  try {
    const started = Date.now();
    fence.unsettle("ann", "test", "a");
    await sleep(60);
    fence.unsettle("ann", "test again", "a");
    const waiting = fence.settled("ann");
    await waiting;
    // Guard: the mark made longer is waited for to its new end, from the same timer chain.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  } finally {
    fence.reset();
  }
});

test("marks are bounded: past the cap the oldest ends early, and its waiters are released", async () => {
  const fence = new TradeSettle({ ms: 10_000, cap: 2 });
  try {
    fence.unsettle("ann", "test", "a");
    const annWaits = fence.settled("ann");
    fence.unsettle("bob", "test", "a");
    fence.unsettle("cid", "test", "a");
    expect(fence.size).toBe(2);
    expect(fence.unsettledUntil("ann")).toBeNull();
    expect(fence.unsettledUntil("bob")).not.toBeNull();
    const started = Date.now();
    await annWaits;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warned.some((line) => line.includes("ann") && line.includes("ended early"))).toBe(true);
    // A mark made longer becomes the newest: the oldest is then the other one.
    fence.unsettle("bob", "test", "a");
    fence.unsettle("dee", "test", "a");
    expect(fence.unsettledUntil("bob")).not.toBeNull();
    expect(fence.unsettledUntil("cid")).toBeNull();
  } finally {
    fence.reset();
  }
});

test("a mark is kept while the rows are dropped at its end: a write that comes then still waits", async () => {
  let release!: () => void;
  const dropping: string[] = [];
  const fence = new TradeSettle({
    ms: 50,
    // The drop when the mark ends is held until the test lets it go; the one in unsettle is not.
    drop: (name) => {
      dropping.push(name);
      return dropping.length === 1 ? Promise.resolve() : new Promise<void>((resolve) => { release = resolve; });
    },
  });
  try {
    await fence.unsettle("ann", "test", "a");
    while (dropping.length < 2) await sleep(10);
    // Guard: the mark is ended after the drop, not before it.
    expect(fence.unsettledUntil("ann")).not.toBeNull();
    let ran = false;
    const writing = fence.settledThen("ann", async () => { ran = true; });
    await sleep(20);
    expect(ran).toBe(false);
    release();
    await writing;
    expect(ran).toBe(true);
    expect(fence.size).toBe(0);
  } finally {
    fence.reset();
  }
});

test("a mark made longer while its rows are dropped waits on to its new end", async () => {
  let release!: () => void;
  let drops = 0;
  const fence = new TradeSettle({
    ms: 60,
    drop: () => (++drops === 2 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve()),
  });
  try {
    const started = Date.now();
    await fence.unsettle("ann", "test", "a");
    while (drops < 2) await sleep(5);
    void fence.unsettle("ann", "again", "a");
    release();
    await fence.settled("ann");
    // Guard: the check of the mark's end after the drop.
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  } finally {
    fence.reset();
  }
});

test("reset ends every mark and releases its waiters", async () => {
  const fence = new TradeSettle({ ms: 10_000 });
  fence.unsettle("ann", "test", "a");
  const waiting = fence.settled("ann");
  fence.reset();
  const started = Date.now();
  await waiting;
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(fence.size).toBe(0);
  expect(fence.settled("ann")).toBe(fence.settled("nobody"));
});

test("unsettle drops the player's rows at once", async () => {
  inventoryRows.push({ id: nextId++, username: "settlehy", item: "Iron Ore", quantity: 5, equipped: 0, slot: null, bag_slot: null });
  currencyRows.push({ username: "settlehy", copper: 1, silver: 0, gold: 0 });
  await inventory.get("settlehy");
  await currency.get("settlehy");
  inventoryRows[0].quantity = 9;
  currencyRows[0].copper = 9;
  // Held: the copies are read.
  expect((await inventory.find("settlehy", { name: "Iron Ore", quantity: 0 }))?.[0]?.quantity).toBe(5);
  await tradeSettle.unsettle("settlehy", "test", "a");
  expect((await inventory.find("settlehy", { name: "Iron Ore", quantity: 0 }))?.[0]?.quantity).toBe(9);
  expect((await currency.get("settlehy")).copper).toBe(9);
});

// ------------------------------------------------------- the host refuses a swap

// The host's last check before a swap: trades.accept asks the receiver's traderNamed for both players, and a player
// of a neighbouring node is found only while tradeLink.partnerPeer has them, which peerDown ends with the link.
const traderSource = (() => {
  const source = receiverSource();
  const start = source.search(/^const traderNamed = /m);
  if (start < 0) throw new Error("traderNamed was not found in socket/receiver.ts");
  return source.slice(start, source.indexOf(";\n", start) + 2);
})();
const transpiler = new Bun.Transpiler({ loader: "ts" });
const makeTraderNamed: (given: Record<string, any>) => (username: string) => any = new Function(`"use strict";\n${transpiler.transformSync(
  `function make({ playerCache, tradeLink, mirrorByUsername }: any) {\n${traderSource}\nreturn traderNamed;\n}`,
)}\nreturn make;`)();

const person = (id: string, username: string, over: Record<string, any> = {}) => ({
  id, username, invitations: [], isGuest: false, isDead: false, isGhost: false, pvp: false,
  location: { map: "forest.json", position: { x: 100, y: 100 } }, ...over,
});

async function hostWithTrade() {
  const { a, b } = linkPair();
  const ca = new LinkCalls(200);
  const cb = new LinkCalls(200);
  ca.attach(a);
  cb.attach(b);
  const host = new TradeLink(ca);
  const alice = person("1", "settlealice");
  const bob = person("2", "settlebob", { remote: true, mirrorFrom: "b", location: { map: "forest", position: { x: 120, y: 100 } } });
  const traderNamed = makeTraderNamed({
    playerCache: { getByUsername: (name: string) => (same(name, alice.username) ? alice : undefined) },
    tradeLink: host,
    mirrorByUsername: (name: string) => (same(name, bob.username) ? bob : undefined),
  });
  inventoryRows.push({ id: nextId++, username: "settlealice", item: "Iron Ore", quantity: 5, equipped: 0, slot: null, bag_slot: null });
  host.setPartner("settlebob", "b", "s1");
  const trade = trades.open(alice as any, bob as any);
  if (typeof trade === "string") throw new Error(trade);
  expect((await trades.offer("settlealice", { items: [{ name: "Iron Ore", quantity: 2 }] })).ok).toBe(true);
  trade.changedAt -= 10_000;
  expect((await trades.accept("settlealice", traderNamed)).state).toBe("accepted");
  const done = () => { host.reset(); ca.detach(); cb.detach(); };
  return { a, host, traderNamed, done };
}

test("with the partner's link up, the host's accept makes the swap", async () => {
  const { traderNamed, done } = await hostWithTrade();
  try {
    expect((await trades.accept("settlebob", traderNamed)).state).toBe("completed");
    expect(transactions).toBe(1);
    expect(ore("settlealice")).toBe(3);
    expect(ore("settlebob")).toBe(2);
  } finally {
    done();
  }
});

test("the host does not start a swap once the link to the partner's node is down", async () => {
  const { a, host, traderNamed, done } = await hostWithTrade();
  try {
    a.setUp(false);
    // Guard: peerDown drops the partner with the link, which is what traderNamed asks.
    expect(host.partnerPeer("settlebob")).toBeNull();
    const accepted = await trades.accept("settlebob", traderNamed);
    expect(accepted.state).toBe("failed");
    expect(transactions).toBe(0);
    expect(ore("settlealice")).toBe(5);
    expect(ore("settlebob")).toBeUndefined();
  } finally {
    done();
  }
});

test("a trade is not accepted while one of its players is settling", async () => {
  const { traderNamed, done } = await hostWithTrade();
  try {
    await tradeSettle.unsettle("settlealice", "test", "c");
    // Guard: the mark in trades.accept. Without it the swap waits out the mark and then is made.
    const accepted = await trades.accept("settlebob", traderNamed);
    expect(accepted.state).toBe("wait");
    expect(transactions).toBe(0);
    expect(trades.of("settlealice")).not.toBeNull();
  } finally {
    done();
  }
});

// ---------------------------------------------------------- the host bounds its swap

test("the window is longer than a swap the host started can take to end", async () => {
  // The client's query timeout is a literal in sqldatabase.ts: read there, so the two cannot drift apart.
  const source = await Bun.file(new URL("../controllers/sqldatabase.ts", import.meta.url)).text();
  const found = source.match(/reject\(new Error\('Query timeout[^']*'\)\);\s*\},\s*([\d_]+)\);/);
  expect(found).not.toBeNull();
  expect(Number(found![1].replace(/_/g, ""))).toBe(DB_QUERY_TIMEOUT_MS);
  expect(SETTLE_MS).toBeGreaterThan(SWAP_START_MS + DB_QUERY_TIMEOUT_MS);
  expect(SETTLE_MS).toBe(40_000);
  expect(SWAP_START_MS).toBe(5_000);
  expect(swapStart.ms).toBe(SWAP_START_MS);
});

test("a swap held up by a turn is still made while the link is up and within the start bound", async () => {
  const { traderNamed, done } = await hostWithTrade();
  try {
    const holding = atomically(["settlealice"], async () => { await sleep(80); });
    const accepted = await trades.accept("settlebob", traderNamed);
    await holding;
    expect(accepted.state).toBe("completed");
    expect(transactions).toBe(1);
  } finally {
    done();
  }
});

test("a swap held up while the link to the partner's node went down is not made", async () => {
  const { a, traderNamed, done } = await hostWithTrade();
  try {
    // The swap waits for Alice's turn; meanwhile the link goes down.
    const holding = atomically(["settlealice"], async () => { await sleep(80); });
    const accepting = trades.accept("settlebob", traderNamed);
    await sleep(20);
    a.setUp(false);
    await holding;
    const accepted = await accepting;
    // Guard: the check of the players in swap, after the turns and before the transaction.
    expect(accepted.state).toBe("failed");
    expect(transactions).toBe(0);
    expect(ore("settlealice")).toBe(5);
    expect(ore("settlebob")).toBeUndefined();
    expect(warned.some((line) => line.includes("settlebob could no longer be reached"))).toBe(true);
  } finally {
    done();
  }
});

test("a swap that cannot start within the bound after the final accept is not made", async () => {
  const { traderNamed, done } = await hostWithTrade();
  swapStart.ms = 20;
  try {
    const holding = atomically(["settlealice"], async () => { await sleep(80); });
    const accepted = await trades.accept("settlebob", traderNamed);
    await holding;
    // Guard: the start deadline in swap.
    expect(accepted.state).toBe("failed");
    if (accepted.state === "failed") expect(accepted.reasons.settlealice).toContain("took too long");
    expect(transactions).toBe(0);
    expect(ore("settlealice")).toBe(5);
    expect(warned.some((line) => line.includes("within 20 ms of the final accept"))).toBe(true);
  } finally {
    swapStart.ms = SWAP_START_MS;
    done();
  }
});

test("a mark's timer does not keep the process alive", async () => {
  const fence = new TradeSettle({ ms: 50, drop: async () => {} });
  try {
    await fence.unsettle("ann", "test", "a");
    // Guard: unref on the mark's timer. stopCluster keeps the marks, and they do not hold up a process that stops.
    expect(((fence as any).marks.get("ann").timer as any).hasRef()).toBe(false);
  } finally {
    fence.reset();
  }
});

// ------------------------------------------------- a trade of two players of one node

/** A trade between two players of this node, both accepted but the last, as with the cluster off. */
async function localTrade() {
  const alice = person("1", "localalice");
  const carol = person("3", "localcarol", { location: { map: "forest.json", position: { x: 120, y: 100 } } });
  const here = new Map([[alice.username, alice], [carol.username, carol]]);
  const find = (name: string) => here.get(String(name).toLowerCase());
  inventoryRows.push({ id: nextId++, username: "localalice", item: "Iron Ore", quantity: 5, equipped: 0, slot: null, bag_slot: null });
  const trade = trades.open(alice as any, carol as any);
  if (typeof trade === "string") throw new Error(trade);
  expect((await trades.offer("localalice", { items: [{ name: "Iron Ore", quantity: 2 }] })).ok).toBe(true);
  trade.changedAt -= 10_000;
  expect((await trades.accept("localalice", find)).state).toBe("accepted");
  return { here, find };
}

test("a swap between two players of one node held up past the start bound is still made", async () => {
  const { find } = await localTrade();
  swapStart.ms = 20;
  try {
    const holding = atomically(["localalice"], async () => { await sleep(80); });
    const accepted = await trades.accept("localcarol", find);
    await holding;
    // Guard: the bound is armed only for a trade with a player across a border. Single-node trades are as before.
    expect(accepted.state).toBe("completed");
    expect(transactions).toBe(1);
    expect(ore("localalice")).toBe(3);
    expect(ore("localcarol")).toBe(2);
  } finally {
    swapStart.ms = SWAP_START_MS;
  }
});

test("a swap between two players of one node is made when one leaves while it waits for a turn", async () => {
  const { here, find } = await localTrade();
  const holding = atomically(["localalice"], async () => { await sleep(80); });
  const accepting = trades.accept("localcarol", find);
  await sleep(20);
  here.delete("localcarol");
  await holding;
  // Guard: no second presence check for a trade of one node, as before this task.
  expect((await accepting).state).toBe("completed");
  expect(transactions).toBe(1);
  expect(ore("localcarol")).toBe(2);
});
