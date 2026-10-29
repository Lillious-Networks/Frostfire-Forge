import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { ParkedGrant } from "../cluster/grants";
import { linkPair } from "./cluster-fakelink";
import { receiverSource as readReceiverSource } from "./receiver-source";
import { databaseModule } from "./setup";

// Security review phase 7, fix group B: bounded and durable item writes (H1 grant bounds, M2, M4, L7).
//
// The database stand-in keeps the grant_writes rows: a second insert of the same id changes nothing, which the
// transaction stand-in (setup.ts databaseModule) turns into a GuardError on that statement, as the real one does.
const grantRows = new Set<string>();
const statements: string[] = [];
const pruneValues: any[][] = [];
let failPrune = false;
const database = async (sql: string, values: any[] = []) => {
  statements.push(sql);
  if (sql.startsWith("DELETE FROM grant_writes")) {
    pruneValues.push(values);
    if (failPrune) throw new Error("prune refused");
    return { affectedRows: 3 };
  }
  if (/INTO grant_writes/.test(sql)) {
    const id = String(values[0]);
    if (grantRows.has(id)) return { affectedRows: 0 };
    grantRows.add(id);
    return { affectedRows: 1 };
  }
  if (/^\s*SELECT/i.test(sql)) return [];
  return { affectedRows: 1 };
};
mock.module("../controllers/sqldatabase", () => databaseModule({ default: database }));

const { MemoryStore } = await import("../cluster/memorystore");
const { grantKey, grantedKey, grants } = await import("../cluster/grants");
const { LinkCalls, linkCalls } = await import("../cluster/linkcalls");
const { ghosts } = await import("../cluster/ghosts");
const { askOwner, handedRows } = await import("../cluster/remoteitems");
const { isMovedChest, isMovedLoot } = await import("../cluster/kinds/objectmoves");
const { setGrantApplier } = await import("../systems/creatures/remotereward");
const { setKnownTemplates } = await import("../systems/creatures/kill");
const { giveGrant } = await import("../systems/grantwriter");
const { GRANT_WRITES_KEEP_MS, forgetGrantWritesTable, grantWrittenBefore, pruneGrantWrites, recordGrantWrite } = await import("../systems/grantwrites");
const {
  HANDED_ITEMS_MAX, ITEM_QUANTITY_MAX, checkBounds, copperMax, isItemQuantity, itemQuantityMaxNow, outOfBounds, refreshItemNames, refreshItemQuantityMax,
  setCopperCap, setQuantitySource,
} = await import("../systems/itembounds");
const { Grants } = await import("../cluster/grants");

// The loot tables source itembounds.ts sets when it loads (each test sets a stand-in for it).
const defaultLootSource = setQuantitySource("loot tables", null);
setQuantitySource("loot tables", defaultLootSource);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Sets one configured-quantity source for a test; answers what puts the one before back. */
function setQuantitySourceFor(name: string, source: () => number | null | Promise<number | null>): () => void {
  const previous = setQuantitySource(name, source);
  return () => { setQuantitySource(name, previous); };
}
const { receiveGathered } = await import("../systems/gathering/remote");
const { atomically, nothingWritten } = await import("../services/batch");
const { default: assetCache } = await import("../services/assetCache");
const { default: inventory } = await import("../systems/inventory");
const { default: currency } = await import("../systems/currency");
const { default: playerCache } = await import("../services/playermanager");
const { default: log } = await import("../modules/logger");

// kill.ts sets its applier when it loads: the engine's corpse-money path.
const killGrant = setGrantApplier(null)!;
setGrantApplier(killGrant);

const restores: Array<() => void | Promise<void>> = [];
let errored: string[] = [];
let warned: string[] = [];
let informed: string[] = [];

beforeEach(async () => {
  errored = [];
  warned = [];
  informed = [];
  grantRows.clear();
  statements.length = 0;
  pruneValues.length = 0;
  failPrune = false;
  forgetGrantWritesTable();
  // The configured sources of item quantities, read: none above 9999.
  restores.push(setQuantitySourceFor("loot tables", () => 0), setQuantitySourceFor("gathering areas", () => 0));
  await refreshItemQuantityMax();
  const error = spyOn(log, "error").mockImplementation((message: any) => { errored.push(String(message)); });
  const warn = spyOn(log, "warn").mockImplementation((message: any) => { warned.push(String(message)); });
  const info = spyOn(log, "info").mockImplementation((message: any) => { informed.push(String(message)); });
  restores.push(() => error.mockRestore(), () => warn.mockRestore(), () => info.mockRestore());
  // A corpse of this node holds at most 1000 copper: the copper cap of a hand-over.
  const saved = setKnownTemplates(new Map([[3, { id: 3, name: "Wolf", gold_max: 1000 } as any]]));
  restores.push(() => { setKnownTemplates(saved); });
});

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) await restore();
  grants.detach();
  (ghosts as any).mirrors.remove(5);
  linkCalls.detach();
});

/**
 * The item table this node loads, for one test. Each test starts with none loaded (names then not checked): other
 * test files put the asset cache module in place of the real one for the whole run, with tables of their own.
 */
let loadedItems: Array<{ name: string }> | null = null;
async function itemTable(names: string[]) {
  loadedItems = names.map((name) => ({ name }));
}
beforeEach(async () => {
  loadedItems = null;
  const original = assetCache.get;
  const get = spyOn(assetCache, "get").mockImplementation(async (key: string) => key === "items" ? loadedItems : original.call(assetCache, key));
  restores.push(() => get.mockRestore());
  // The table as last read (checkBoundsNow) starts as none too.
  await refreshItemNames();
});

/** inventory.add and currency.add as batch statements; `committed` lists what a kept transaction wrote. */
function writes() {
  const committed: string[] = [];
  const add = spyOn(inventory, "add").mockImplementation(async (name: string, item: any, batch: any) => {
    batch.add({ sql: "UPDATE inventory SET quantity = quantity + ? WHERE username = ? AND item = ?", values: [item.quantity, name, item.name] }, () => { committed.push(`${name}+${item.name}x${item.quantity}`); });
    return true;
  });
  const pay = spyOn(currency, "add").mockImplementation(async (name: string, amount: any, batch: any) => {
    batch.add({ sql: "UPDATE currency SET copper = copper + ? WHERE username = ?", values: [amount.copper, name] }, () => { committed.push(`${name}$${amount.copper}`); });
    return { copper: amount.copper, silver: 0, gold: 0 } as any;
  });
  restores.push(() => add.mockRestore(), () => pay.mockRestore());
  return committed;
}

const parked = (over: Partial<ParkedGrant> = {}): ParkedGrant => ({ id: "b:9", owner: "b", at: 1, username: "ann", items: [{ itemName: "Bone", quantity: 2 }], copper: 11, call: "LOOT_TAKE", ...over });

// ---------------------------------------------------------------- the bounds (itembounds.ts)

test("the bounds: a count from 1 to 9999, copper up to a corpse's most, a known item, at most 64 rows", async () => {
  expect(ITEM_QUANTITY_MAX).toBe(9999);
  expect(HANDED_ITEMS_MAX).toBe(64);
  expect([1, 9999].every(isItemQuantity)).toBe(true);
  expect([0, -1, 10000, 1.5, Number.NaN, Infinity, "2", null].some(isItemQuantity)).toBe(false);
  expect(copperMax()).toBe(1000);
  await itemTable(["Bone", "Gem"]);
  expect(await outOfBounds([{ itemName: "Bone", quantity: 9999 }, { itemName: "gem", quantity: 1 }], 1000)).toBeNull();
  expect(await outOfBounds([{ itemName: "Bone", quantity: 10000 }], 0)).toContain("10000 x Bone");
  expect(await outOfBounds([{ itemName: "Bone", quantity: 0 }], 0)).not.toBeNull();
  expect(await outOfBounds([{ itemName: "Bone", quantity: 1.5 }], 0)).not.toBeNull();
  expect(await outOfBounds([], 1001)).toContain("1001 copper");
  expect(await outOfBounds([], -1)).not.toBeNull();
  expect(await outOfBounds([], 2.5)).not.toBeNull();
  expect(await outOfBounds([{ itemName: "Gold Bar", quantity: 1 }], 0)).toContain("Gold Bar");
  expect(await outOfBounds([{ quantity: 1 }], 0)).not.toBeNull();
  expect(await outOfBounds(Array.from({ length: 65 }, () => ({ itemName: "Bone", quantity: 1 })), 0)).toContain("65 item rows");
});

test("copper over a known cap is refused; with no templates loaded the cap is not known, and copper waits", async () => {
  const saved = setCopperCap(() => 0);
  try {
    expect(copperMax()).toBe(0);
    expect(await checkBounds([], 1)).toMatchObject({ ok: false, ready: true });
    expect(await checkBounds([], 0)).toEqual({ ok: true });
  } finally {
    setCopperCap(saved);
  }
  expect(copperMax()).toBe(1000);
  // kill.ts's cap with no templates loaded: not known yet.
  const loaded = setKnownTemplates(new Map());
  try {
    expect(copperMax()).toBeNull();
    expect(await checkBounds([], 1)).toMatchObject({ ok: false, ready: false });
    expect(await checkBounds([{ itemName: "Bone", quantity: 1 }], 0)).toEqual({ ok: true });
  } finally {
    setKnownTemplates(loaded);
  }
});

// ---------------------------------------------------------------- fix round 1: bounds not known yet

/** An owner node "b" whose player is on no node: its first check writes the grant with giveGrant. */
function ownerNode() {
  const store = new MemoryStore();
  const owner = new Grants({ runOnPlayer: async () => false, now: Date.now }, { delays: [20, 40, 80], storeRetryMs: 20, ttlMs: 2_000 });
  owner.attach(store, "b");
  owner.setWriter(giveGrant);
  restores.push(() => owner.detach());
  return { store, owner };
}

test("a grant with copper before the templates load stays parked, and is written after they load", async () => {
  const committed = writes();
  const loaded = setKnownTemplates(new Map());
  const { owner } = ownerNode();
  try {
    const id = await owner.park({ username: "ann", items: [{ itemName: "Bone", quantity: 2 }], copper: 11, call: "LOOT_TAKE" });
    expect(typeof id).toBe("string");
    await wait(120);
    // Guard: the not-ready path in giveGrant. Refused here, the grant would be logged lost for a bound not yet read.
    expect(committed).toEqual([]);
    expect(errored.filter((line) => line.includes("lost"))).toEqual([]);
    expect(informed.some((line) => line.includes(id!) && line.includes("not written yet"))).toBe(true);
  } finally {
    setKnownTemplates(loaded);
  }
  await wait(250);
  expect(committed).toEqual(["ann+Bonex2", "ann$11"]);
  expect(errored.filter((line) => line.includes("lost"))).toEqual([]);
});

test("an owner's answer whose copper cannot be checked yet is left parked for the owner's recovery", async () => {
  const store = new MemoryStore();
  grants.attach(store, "a");
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  owner.handle("CHEST_TAKE", () => ({ ok: true, items: [{ itemName: "Bone", quantity: 2 }], copper: 11, grantId: "b:70" }));
  (ghosts as any).mirrors.set({ kind: "chest", id: "chest_5", num: 5, from: "b", confirmedAt: 0 });
  const loaded = setKnownTemplates(new Map());
  try {
    await store.set(grantKey("b:70"), JSON.stringify({ id: "b:70" }));
    const answer = await askOwner("CHEST_TAKE", "chest_5", { id: 7, username: "Alice" }, { chestId: "chest_5", indices: null });
    // Guard: the not-ready path in askOwner. Claimed and refused, the grant would be lost for good.
    expect(answer).toEqual({ ok: false, reason: "failed" });
    expect(await store.get(grantKey("b:70"))).not.toBeNull();
    expect(errored).toEqual([]);
    expect(informed.some((line) => line.includes("b:70") && line.includes("not written yet"))).toBe(true);
  } finally {
    setKnownTemplates(loaded);
    owner.detach();
  }
});

test("a configured quantity above 9999 is in bounds, and one above every configured source is refused", async () => {
  // The largest configured row is the cap, when above 9999 (here, a loot table row of 25000).
  restores.push(setQuantitySourceFor("loot tables", () => 25_000));
  await refreshItemQuantityMax();
  expect(itemQuantityMaxNow()).toEqual({ most: 25_000, known: true });
  // Guard: the configured sources in the quantity cap.
  expect(await checkBounds([{ itemName: "Bone", quantity: 25_000 }], 0)).toEqual({ ok: true });
  expect(await checkBounds([{ itemName: "Bone", quantity: 25_001 }], 0)).toMatchObject({ ok: false, ready: true });
  expect(isMovedLoot(movedLoot(25_000))).toBe(true);
  expect(isMovedLoot(movedLoot(25_001))).toBe(false);
  // A gathering area's quantity_max counts too.
  const { noteAreaQuantities } = await import("../systems/gathering");
  restores.push(setQuantitySourceFor("gathering areas", () => 0));
  noteAreaQuantities([{ quantity_max: 40_000 }, { quantity_max: 3 }] as any);
  await refreshItemQuantityMax();
  expect(itemQuantityMaxNow()).toEqual({ most: 40_000, known: true });
  // Never below 9999.
  restores.push(setQuantitySourceFor("loot tables", () => 5));
  noteAreaQuantities([]);
  await refreshItemQuantityMax();
  expect(itemQuantityMaxNow().most).toBe(9999);
});

test("the loot tables source is the largest max_quantity of the loaded loot tables", async () => {
  const { default: lootTable } = await import("../systems/lootTable");
  const list = spyOn(lootTable, "list").mockImplementation(async () => [
    { id: 2, name: "big", items: [{ item: "Bone", max_quantity: 15_000 }, { item: "Gem", max_quantity: 4 }] },
    { id: 1, name: "small", items: [{ item: "Fang", max_quantity: 12 }] },
  ] as any);
  restores.push(() => list.mockRestore(), setQuantitySourceFor("loot tables", defaultLootSource!));
  // Guard: the default loot tables source (itembounds.ts).
  expect(await refreshItemQuantityMax()).toEqual({ most: 15_000, known: true });
  list.mockImplementation(async () => { throw new Error("database away"); });
  expect(await refreshItemQuantityMax()).toEqual({ most: 9999, known: false });
});

test("a source not read yet (the gathering areas before they load) leaves the cap unknown, and a count above 9999 waits", async () => {
  restores.push(setQuantitySourceFor("gathering areas", () => null));
  // Guard: a null source is not read (itembounds.ts refreshItemQuantityMax).
  expect(await refreshItemQuantityMax()).toEqual({ most: 9999, known: false });
  expect(await checkBounds([{ itemName: "Bone", quantity: 12_000 }], 0)).toMatchObject({ ok: false, ready: false });
  expect(await checkBounds([{ itemName: "Bone", quantity: 9999 }], 0)).toEqual({ ok: true });
});

test("a quantity above 9999 waits while the configured sources cannot be read, and is written once they are", async () => {
  const committed = writes();
  let tables: number | null = null;
  restores.push(setQuantitySourceFor("loot tables", () => { if (tables === null) throw new Error("no loot tables yet"); return tables; }));
  const { owner } = ownerNode();
  const id = await owner.park({ username: "ann", items: [{ itemName: "Bone", quantity: 12_000 }], copper: 0, call: "LOOT_TAKE" });
  await wait(120);
  expect(committed).toEqual([]);
  expect(errored.filter((line) => line.includes("lost"))).toEqual([]);
  expect(informed.some((line) => line.includes(id!) && line.includes("not written yet"))).toBe(true);
  // 9999 and under is never held back.
  expect(await checkBounds([{ itemName: "Bone", quantity: 9999 }], 0)).toEqual({ ok: true });
  tables = 12_000;
  await wait(250);
  expect(committed).toEqual(["ann+Bonex12000"]);
});

// ---------------------------------------------------------------- fix round 1: grant_writes pruning

test("grant_writes rows older than 30 days are deleted in one statement at cluster start, and a failure is logged and ignored", async () => {
  expect(GRANT_WRITES_KEEP_MS).toBe(30 * 24 * 60 * 60 * 1000);
  const before = Date.now();
  await pruneGrantWrites();
  const deletes = statements.filter((sql) => sql.startsWith("DELETE"));
  expect(deletes).toEqual(["DELETE FROM grant_writes WHERE written_at < ?"]);
  expect(pruneValues.at(-1)![0]).toBeGreaterThanOrEqual(before - GRANT_WRITES_KEEP_MS);
  expect(pruneValues.at(-1)![0]).toBeLessThanOrEqual(Date.now() - GRANT_WRITES_KEEP_MS);
  failPrune = true;
  await pruneGrantWrites();
  expect(warned.some((line) => line.includes("grant_writes") && line.includes("prune refused"))).toBe(true);
  // Run by a link hook: only startCluster runs those, so only in cluster mode.
  const source = await Bun.file(new URL("../systems/grantwriter.ts", import.meta.url)).text();
  expect(source).toContain("onLinksAttached(() => { void pruneGrantWrites(); })");
});

// ---------------------------------------------------------------- the grant writer (H1 bounds, M2)

test("a grant out of bounds is refused whole and logged lost by name", async () => {
  const committed = writes();
  await itemTable(["Bone"]);
  await giveGrant(parked({ id: "b:21", items: [{ itemName: "Bone", quantity: 2 }, { itemName: "Bone", quantity: 1_000_000 }] }), null);
  await giveGrant(parked({ id: "b:22", items: [{ itemName: "Bone", quantity: 2 }], copper: 5_000_000 }), null);
  await giveGrant(parked({ id: "b:23", items: [{ itemName: "Crown", quantity: 1 }], copper: 0 }), null);
  // Guard: refusedOutOfBounds in giveGrant. Without it the store could mint any item in any number.
  expect(committed).toEqual([]);
  expect(statements.filter((sql) => !sql.startsWith("CREATE"))).toEqual([]);
  expect(errored.some((line) => line.includes("b:21") && line.includes("ann") && line.includes("1000000 x Bone") && line.includes("refused and lost"))).toBe(true);
  expect(errored.some((line) => line.includes("b:22") && line.includes("5000000 copper"))).toBe(true);
  expect(errored.some((line) => line.includes("b:23") && line.includes("Crown is not an item"))).toBe(true);
  // In bounds it is written as before.
  await giveGrant(parked({ id: "b:24" }), null);
  expect(committed).toEqual(["ann+Bonex2", "ann$11"]);
});

test("a grant whose id was written before is skipped, not written again", async () => {
  const committed = writes();
  await giveGrant(parked({ id: "b:30" }), null);
  expect(committed).toEqual(["ann+Bonex2", "ann$11"]);
  expect(statements.find((sql) => !sql.startsWith("CREATE"))).toContain("INSERT IGNORE INTO grant_writes");
  // Guard: recordGrantWrite in giveGrant. A store rolled back to before the claim brings the grant back.
  await giveGrant(parked({ id: "b:30" }), null);
  expect(committed).toEqual(["ann+Bonex2", "ann$11"]);
  expect(informed.some((line) => line.includes("b:30") && line.includes("written before"))).toBe(true);
  expect(errored).toEqual([]);
  // Another id is written.
  await giveGrant(parked({ id: "b:31" }), null);
  expect(committed).toEqual(["ann+Bonex2", "ann$11", "ann+Bonex2", "ann$11"]);
});

test("a grant row is the first statement, and a written-before guard is only that statement's", async () => {
  const { GuardError } = await import("../controllers/sqldatabase");
  expect(grantWrittenBefore(new GuardError(0))).toBe(true);
  expect(grantWrittenBefore(new GuardError(1))).toBe(false);
  expect(grantWrittenBefore(new Error("x"))).toBe(false);
  // An id that is not one throws before anything is sent: nothing was written.
  let thrown: unknown = null;
  try {
    await atomically(["ann"], async (batch) => { await recordGrantWrite(batch, "x".repeat(129)); });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).not.toBeNull();
  expect(nothingWritten(thrown)).toBe(true);
});

// ---------------------------------------------------------------- corpse money (M2, L7)

function money() {
  const committed = writes();
  playerCache.add("901", { id: "901", username: "ann" });
  restores.push(() => { playerCache.remove("901"); });
  return committed;
}

test("a share whose id was written before is not given again, and keeps its mark", async () => {
  const committed = money();
  // No store: the once-only mark is not there to stop the second send (a store that lost it).
  expect(await killGrant({ username: "ann", copper: 7, id: "g9" })).toBe("given");
  expect(committed).toEqual(["ann$7"]);
  // Guard: recordGrantWrite in grantCopper. The row stops the second payment the lost mark would have stopped.
  expect(await killGrant({ username: "ann", copper: 7, id: "g9" })).toBe("given");
  expect(committed).toEqual(["ann$7"]);
  expect(informed.some((line) => line.includes("g9") && line.includes("given before"))).toBe(true);
  // With the store: the mark lost, set again by the resend, and kept when the row says it was paid.
  const store = new MemoryStore();
  grants.attach(store, "b");
  expect(await killGrant({ username: "ann", copper: 7, id: "g9" })).toBe("given");
  expect(committed).toEqual(["ann$7"]);
  expect(await store.get(grantedKey("g9"))).not.toBeNull();
});

test("a share without an id is refused in cluster mode, and given as before with the cluster off", async () => {
  const committed = money();
  const before = process.env.CLUSTER;
  restores.push(() => { if (before === undefined) delete process.env.CLUSTER; else process.env.CLUSTER = before; });
  process.env.CLUSTER = "true";
  // Guard: the L7 check in grantCopper. Sent again after a lost answer, a share with no id would be paid twice.
  expect(await killGrant({ username: "ann", copper: 7 })).toBe("failed");
  expect(committed).toEqual([]);
  expect(errored.some((line) => line.includes("ann") && line.includes("7 copper") && line.includes("no grant id"))).toBe(true);
  delete process.env.CLUSTER;
  expect(await killGrant({ username: "ann", copper: 7 })).toBe("given");
  expect(committed).toEqual(["ann$7"]);
  // With the cluster off no grant_writes row is read or written.
  expect(statements.some((sql) => sql.includes("grant_writes"))).toBe(false);
});

// ---------------------------------------------------------------- the owner's answer (M4)

test("an owner's answer out of bounds is refused whole, claimed, and logged lost by name", async () => {
  const store = new MemoryStore();
  grants.attach(store, "a");
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  let answer: any = { ok: true, items: [{ itemName: "Gem", quantity: 1_000_000_000 }], grantId: "b:40" };
  owner.handle("CHEST_TAKE", () => answer);
  (ghosts as any).mirrors.set({ kind: "chest", id: "chest_5", num: 5, from: "b", confirmedAt: 0 });
  const player = { id: 7, username: "Alice" };
  try {
    await store.set(grantKey("b:40"), JSON.stringify({ id: "b:40" }));
    // Guard: refusedOutOfBounds in askOwner. Without it the asker writes a billion gems.
    expect(await askOwner("CHEST_TAKE", "chest_5", player, { chestId: "chest_5", indices: null })).toEqual({ ok: false, reason: "failed" });
    // Claimed: the owner's recovery does not write it either.
    expect(await store.get(grantKey("b:40"))).toBeNull();
    expect(errored.some((line) => line.includes("Alice") && line.includes("1000000000 x Gem") && line.includes("b:40") && line.includes("refused and lost"))).toBe(true);
    // Copper above a corpse's most is refused too.
    answer = { ok: true, items: [], copper: 1001 };
    expect(await askOwner("CHEST_TAKE", "chest_5", player, { chestId: "chest_5", indices: null })).toEqual({ ok: false, reason: "failed" });
    // In bounds it is answered as before.
    answer = { ok: true, items: [{ itemName: "Gem", quantity: 9999 }], copper: 1000 };
    expect(await askOwner("CHEST_TAKE", "chest_5", player, { chestId: "chest_5", indices: null })).toEqual(answer);
  } finally {
    owner.detach();
  }
});

test("handedRows reads a list of items and a picked-up item", () => {
  expect(handedRows({ ok: true, items: [{ itemName: "Gem", quantity: 2, extra: 1 }] } as any)).toEqual([{ itemName: "Gem", quantity: 2 }]);
  expect(handedRows({ ok: true, item: { item: "Bone", quantity: 3 } } as any)).toEqual([{ itemName: "Bone", quantity: 3 }]);
  expect(handedRows({ ok: true } as any)).toEqual([]);
});

// ---------------------------------------------------------------- moved blocks (M4)

const movedLoot = (quantity: number) => ({ id: "loot_1", item: "Bone", quantity, quality: "common", iconUrl: "", map: "main", x: 1, y: 2, expiresAt: 3, ownerId: "", ownerName: "" });
const movedChest = (quantity: number) => ({ id: "chest_1", map: "main", x: 1, y: 2, iconUrl: "", createdBy: "", playerLoot: [["p1", { rolled: [{ itemName: "Gem", quantity }], taken: [] }]] });

test("moved loot or a chest roll above the most one source gives is refused by name", () => {
  expect(isMovedLoot(movedLoot(9999))).toBe(true);
  // Guard: isItemQuantity in isMovedLoot.
  expect(isMovedLoot(movedLoot(10000))).toBe(false);
  expect(isMovedLoot(movedLoot(0))).toBe(false);
  expect(isMovedChest(movedChest(9999))).toBe(true);
  // Guard: isRolledItem in isMovedChest.
  expect(isMovedChest(movedChest(10000))).toBe(false);
  expect(isMovedChest({ ...movedChest(1), playerLoot: [["p1", { rolled: [{ quantity: 1 }], taken: [] }]] })).toBe(false);
});

test("a moved block reads the quantity cap when it arrives: a configured row above 9999 is taken in, and while the sources cannot be read nothing is dropped", async () => {
  const { objectMovesPart } = await import("../cluster/kinds/objectmoves");
  const { default: loot } = await import("../systems/loot");
  const adopted: string[] = [];
  const adopt = spyOn(loot, "adoptOwn").mockImplementation(((record: any) => { adopted.push(`${record.item}x${record.quantity}`); return "new"; }) as any);
  restores.push(() => adopt.mockRestore());
  const nothing = () => {};
  const part = objectMovesPart({
    now: () => 1,
    ghosts: { handOver: nothing, adoptMirror: () => true, dropMirror: nothing } as any,
    views: { showLoot: nothing, hideLoot: nothing, showChest: nothing, hideChest: nothing, showSkeleton: nothing, hideSkeleton: nothing } as any,
  });
  const block = { id: "m1", map: "main", bx: 0, by: 0, from: "f", to: "t" } as any;
  // A loot table row now gives 25000: the cap last read (9999) is stale until the block arrives.
  restores.push(setQuantitySourceFor("loot tables", () => 25000));
  await part.accept(block, { loot: [movedLoot(20000)], chests: [], skeletons: [], tornadoes: [] } as any, "f");
  // Guard: refreshItemQuantityMax in accept.
  expect(adopted).toEqual(["Bonex20000"]);
  expect(warned.filter((line) => line.includes("dropped"))).toEqual([]);
  // Over every configured source: dropped by name.
  await part.accept(block, { loot: [{ ...movedLoot(30000), id: "loot_2" }], chests: [], skeletons: [], tornadoes: [] } as any, "f");
  expect(adopted).toEqual(["Bonex20000"]);
  expect(warned.some((line) => line.includes("dropped") && line.includes("loot_2"))).toBe(true);
  // A source that cannot be read: the cap is not known, and a moved record (which cannot wait) is taken in up to what a row stores.
  restores.push(setQuantitySourceFor("gathering areas", () => { throw new Error("not read"); }));
  await part.accept(block, { loot: [{ ...movedLoot(2_000_000), id: "loot_3" }], chests: [], skeletons: [], tornadoes: [] } as any, "f");
  expect(adopted).toEqual(["Bonex20000", "Bonex2000000"]);
});

// ---------------------------------------------------------------- the asker's writes (M2)

test("a gathered hand-over is written with its grant id", async () => {
  const given: any[] = [];
  const deps = { expected: { item: "Copper Ore", maxQuantity: 5 }, stillHere: () => true, give: async (...args: any[]) => { given.push(args); return true; } };
  // Guard: the grant id passed to give in receiveGathered.
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3, grantId: "b:50" } as any, deps as any)).toEqual({ ok: true, item: "Copper Ore", quantity: 3 });
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3 } as any, deps as any)).toEqual({ ok: true, item: "Copper Ore", quantity: 3 });
  expect(given).toEqual([["alice", "Copper Ore", 3, "b:50"], ["alice", "Copper Ore", 3, undefined]]);
});

test("a gathered hand-over written before is not written again, and not parked again", async () => {
  const committed = writes();
  const { giveHanded } = await import("../systems/gathering");
  expect(await giveHanded("alice", "Copper Ore", 3, "b:51")).toBe(true);
  expect(committed).toEqual(["alice+Copper Orex3"]);
  // Guard: recordGrantWrite in gathering's write.
  expect(await giveHanded("alice", "Copper Ore", 3, "b:51")).toBe(true);
  expect(committed).toEqual(["alice+Copper Orex3"]);
  expect(informed.some((line) => line.includes("b:51") && line.includes("written before"))).toBe(true);
});

// socket/receiver.ts cannot be imported by a test (it imports the server, which starts it), so, as the other
// receiver tests do, the code is read from its source and run with the names it uses handed in.
const receiverSource = readReceiverSource();
const receiverTranspiler = new Bun.Transpiler({ loader: "ts" });
function sliceOf(from: string, to: string): string {
  const start = receiverSource.indexOf(from);
  const end = receiverSource.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`${from} was not found in socket/receiver.ts`);
  return receiverSource.slice(start, end);
}
const compile = (parameters: string, body: string, returns: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${receiverTranspiler.transformSync(`function make({ ${parameters} }: any) { ${body.replace(/^export /gm, "")}\nreturn ${returns}; }`)}\nreturn make;`)();

const helping = compile(
  "atomically, nothingWritten, recordGrantWrite, grantWrittenBefore, inventory, currencySystem, sendPacket, packetManager, formatMoney, log, itemOwner, askOwner, bagRoom, creatures, listener, Events, bareMap, lootChest, loot, playerCache, grants, MAX_GRANT_ITEMS",
  sliceOf("function stillHere(", "/** getPlayersNearPoint, and the mirrored players"),
  "{ receiveHanded, pickupLootHere }",
);

function asker(answer: any, extra: Record<string, any> = {}) {
  const committed: string[] = [];
  const me: any = { id: "7", username: "Zed", wt: {}, location: { map: "main.json", position: { x: 4, y: 5 } } };
  const helpers = helping({
    atomically, nothingWritten, recordGrantWrite, grantWrittenBefore,
    inventory: { add: async (name: string, item: any, batch: any) => { batch.add({ sql: "UPDATE inventory", values: [name, item.name] }, () => { committed.push(`${name}+${item.name}x${item.quantity}`); }); return true; } },
    currencySystem: { add: async (name: string, amount: any, batch: any) => { batch.add({ sql: "UPDATE currency", values: [name] }, () => { committed.push(`${name}$${amount.copper}`); }); return { copper: amount.copper, silver: 0, gold: 0 }; } },
    playerCache: { get: () => me },
    sendPacket: () => {},
    packetManager: new Proxy({}, { get: () => () => [] }),
    formatMoney: (copper: number) => `${copper} copper`,
    log,
    itemOwner: () => "b",
    askOwner: async () => answer,
    bagRoom: async () => ({ free: 3, held: [] }),
    creatures: {}, lootChest: {}, loot: {},
    listener: { emit: () => {} },
    Events: { PLAYER_LOOT_RETRIEVED: "retrieved" },
    bareMap: (map: unknown) => String(map ?? "").replace(/\.json$/, ""),
    grants: { park: async () => null }, MAX_GRANT_ITEMS: 64,
    ...extra,
  });
  return { me, helpers, committed };
}

test("a claimed hand-over is written with its grant id, and one written before is not written again", async () => {
  const t = asker(null);
  const items = [{ name: "Gem", quantity: 1 }];
  expect(await t.helpers.receiveHanded(t.me, items, 5, "CHEST_TAKE", "b:60")).toEqual(items);
  expect(t.committed).toEqual(["Zed+Gemx1", "Zed$5"]);
  expect(statements.find((sql) => !sql.startsWith("CREATE"))).toContain("grant_writes");
  // Guard: recordGrantWrite in receiveHanded. The owner's recovery after a store rollback writes the same id.
  expect(await t.helpers.receiveHanded(t.me, items, 5, "CHEST_TAKE", "b:60")).toBeNull();
  expect(t.committed).toEqual(["Zed+Gemx1", "Zed$5"]);
  expect(informed.some((line) => line.includes("b:60") && line.includes("written before"))).toBe(true);
  // No id: written as before, with no row.
  statements.length = 0;
  expect(await t.helpers.receiveHanded(t.me, items, 0, "CHEST_TAKE")).toEqual(items);
  expect(statements.some((sql) => sql.includes("grant_writes"))).toBe(false);
});

test("a picked-up hand-over is written with its grant id, and one written before is not written again", async () => {
  const t = asker({ ok: true, item: { item: "Bone", quantity: 1, map: "main.json", x: 1, y: 2 }, grantId: "b:61" });
  expect(await t.helpers.pickupLootHere(t.me, "loot_1")).toEqual({ added: true });
  expect(t.committed).toEqual(["Zed+Bonex1"]);
  // Guard: recordGrantWrite in pickupLootHere.
  expect(await t.helpers.pickupLootHere(t.me, "loot_1")).toEqual({ added: false });
  expect(t.committed).toEqual(["Zed+Bonex1"]);
  expect(informed.some((line) => line.includes("b:61") && line.includes("written before"))).toBe(true);
});

// ---------------------------------------------------------------- fix round 2: a re-park keeps the grant id (review Important 3)

const STORE_KEY = "ab".repeat(32);

/** A node of the cluster on `store`: its own Grants, run `run`, the player on no node, writer giveGrant. */
function grantNode(store: any, self: string, run: number) {
  const node = new Grants({ runOnPlayer: async () => false, now: Date.now }, { delays: [20, 40, 80], storeRetryMs: 20, ttlMs: 2_000 });
  node.attach(store, self, { run });
  node.setWriter(giveGrant);
  restores.push(() => node.detach());
  return node;
}

test("a re-parked hand-over keeps its id: a rolled-back copy of it and the re-park are written once", async () => {
  const committed = writes();
  const { sealStore } = await import("../cluster/storeseal");
  const inner = new MemoryStore();
  const store = sealStore(inner, STORE_KEY);
  const owner = grantNode(store, "b", 111);
  const loaded = setKnownTemplates(new Map());
  let id: string | null;
  let raw: string | null;
  try {
    id = await owner.park({ username: "ann", items: [{ itemName: "Bone", quantity: 2 }], copper: 11, call: "LOOT_TAKE" });
    raw = await inner.get(grantKey(id!));
    expect(raw).not.toBeNull();
    // The first check finds the copper cap not known: nothing is written, and the grant is parked again.
    await wait(60);
    expect(committed).toEqual([]);
  } finally {
    setKnownTemplates(loaded);
  }
  // Guard: parkAgain passes the grant's id (grants.ts). The re-park is the same key, sealed as this node's run.
  const reparked = await store.get(grantKey(id!));
  expect(reparked).not.toBeNull();
  expect(JSON.parse(reparked!)).toMatchObject({ id, owner: "b", run: 111 });
  // The store is rolled back to the first record, and the player's node recovers it.
  await inner.set(grantKey(id!), raw!, 2_000);
  const player = grantNode(store, "a", 222);
  await player.recoverHere({ username: "ann" }, { id });
  expect(committed).toEqual(["ann+Bonex2", "ann$11"]);
  // The owner's checks of the re-park, and a second rollback, find the id written.
  await wait(250);
  await inner.set(grantKey(id!), raw!, 2_000);
  await player.recoverHere({ username: "ann" }, { id });
  expect(committed).toEqual(["ann+Bonex2", "ann$11"]);
  expect(informed.some((line) => line.includes(id!) && line.includes("written before"))).toBe(true);
});

test("a hand-over re-parked under its id by another run is that run's: adopted from its list, not from the first", async () => {
  writes();
  const store = new MemoryStore();
  const first = grantNode(store, "b", 111);
  const loaded = setKnownTemplates(new Map());
  let id: string | null;
  try {
    id = await first.park({ username: "ann", items: [{ itemName: "Bone", quantity: 1 }], copper: 5, call: "LOOT_TAKE" });
    // The player's node takes it, cannot write it yet, and parks it again under its own run.
    const player = grantNode(store, "a", 222);
    await player.recoverHere({ username: "ann" }, { id });
    const record = JSON.parse((await store.get(grantKey(id!)))!);
    expect(record).toMatchObject({ id, owner: "a", run: 222 });
    expect(await store.members("cells:grants:a|222")).toContain(id!);
    // Run 222 of a is over: a third node adopts the re-park from that run's list.
    const third = grantNode(store, "c", 333);
    expect(await third.adoptFrom("b", 111)).toBe(0);
    expect(await third.adoptFrom("a", 222)).toBe(1);
  } finally {
    setKnownTemplates(loaded);
  }
});

test("a re-park under the same id on this node replaces its check: one chain of checks per id", async () => {
  const committed = writes();
  const store = new MemoryStore();
  const sentAt: number[] = [];
  const loaded = setKnownTemplates(new Map());
  restores.push(() => { setKnownTemplates(loaded); });
  let start = 0;
  // The player is on this node. The first check's recover action takes the grant here while the templates are not
  // loaded: the write is not ready, so it is parked again under its id while that first check is still running. The
  // later recover actions reach a player that does not take it, so the grant is written from here at the last step.
  const node: any = new Grants({
    runOnPlayer: async (_name: string, _action: string, args: unknown) => {
      sentAt.push(Date.now() - start);
      if (sentAt.length === 1) {
        await node.recoverHere({ username: "ann" }, args);
        setKnownTemplates(loaded);
      }
      return true;
    },
    now: Date.now,
  }, { delays: [30, 100, 250], storeRetryMs: 20, ttlMs: 5_000 });
  node.attach(store, "b", { run: 111 });
  node.setWriter(giveGrant);
  restores.push(() => node.detach());
  start = Date.now();
  const id = await node.park({ username: "ann", items: [{ itemName: "Bone", quantity: 1 }], copper: 5, call: "LOOT_TAKE" });
  await wait(200);
  // Guard: current() in grants.ts. The re-park's chain sends at 30 + 30 and 30 + 100 ms. The first check, replaced
  // by it, sends nothing more; going on, it would send again at 30 + 70 ms (two chains for one id).
  expect(sentAt.length).toBe(3);
  expect(node.pending.size).toBe(1);
  expect(await store.members("cells:grants:b|111")).toEqual([id]);
  await wait(250);
  expect(sentAt.length).toBe(3);
  expect(committed).toEqual(["ann+Bonex1", "ann$5"]);
  expect(node.pending.size).toBe(0);
  expect(await store.get(grantKey(id))).toBeNull();
});

test("a re-park of the same hand-over warns once, then logs at info", async () => {
  writes();
  const store = new MemoryStore();
  const owner = grantNode(store, "b", 111);
  const loaded = setKnownTemplates(new Map());
  try {
    const id = await owner.park({ username: "ann", items: [{ itemName: "Bone", quantity: 1 }], copper: 5, call: "LOOT_TAKE" });
    // Checks at 20, 40 and 80 ms after each park: several re-parks.
    await wait(300);
    // One grant in this test: every re-park line is about it, under whatever id.
    const lines = (from: string[]) => from.filter((line) => line.includes("could not be written") && line.includes("parked again"));
    expect(id).not.toBeNull();
    // Guard: the once-per-grant warn in parkAgain (grants.ts).
    expect(lines(warned).length).toBe(1);
    expect(lines(informed).length).toBeGreaterThan(0);
  } finally {
    setKnownTemplates(loaded);
  }
});

test("the receiver parks a hand-over it could not write again under its grant id", async () => {
  const parks: Array<[any, unknown]> = [];
  const park = async (handOver: any, id?: string) => { parks.push([handOver, id]); return id ?? "a:new"; };
  // The session ended meanwhile (another session holds the name), and a write thrown before it was sent.
  const gone = asker(null, { grants: { park }, playerCache: { get: () => ({ wt: {} }) } });
  expect(await gone.helpers.receiveHanded(gone.me, [{ name: "Gem", quantity: 1 }], 5, "CHEST_TAKE", "b:80")).toBeNull();
  const failing = asker(null, { grants: { park }, inventory: { add: async () => { throw new Error("lock held"); } } });
  expect(await failing.helpers.receiveHanded(failing.me, [{ name: "Gem", quantity: 2 }], 0, "CHEST_TAKE", "b:81")).toBeNull();
  // A pickup, both ways.
  const answer = { ok: true, item: { item: "Bone", quantity: 1, map: "main.json", x: 1, y: 2 }, grantId: "b:82" };
  const leftPickup = asker(answer, { grants: { park }, playerCache: { get: () => ({ wt: {} }) } });
  expect(await leftPickup.helpers.pickupLootHere(leftPickup.me, "loot_1")).toEqual({ added: false });
  const failedPickup = asker({ ...answer, grantId: "b:83" }, { grants: { park }, inventory: { add: async () => { throw new Error("lock held"); } } });
  expect(await failedPickup.helpers.pickupLootHere(failedPickup.me, "loot_1")).toEqual({ added: false });
  // Guard: parkAgain in socket/receiver.ts passes the grant id.
  expect(parks.map(([, id]) => id)).toEqual(["b:80", "b:81", "b:82", "b:83"]);
  // No id (a hand-over that was never parked): a new one.
  expect(await gone.helpers.receiveHanded(gone.me, [{ name: "Gem", quantity: 1 }], 0, "CHEST_TAKE")).toBeNull();
  expect(parks.at(-1)![1]).toBeUndefined();
});

test("a gathered hand-over that could not be written is parked again under its grant id", async () => {
  const parks: Array<[any, unknown]> = [];
  const park = spyOn(grants, "park").mockImplementation((async (handOver: any, id?: string) => { parks.push([handOver, id]); return id ?? "a:new"; }) as any);
  restores.push(() => park.mockRestore());
  const answer = (grantId?: string) => ({ ok: true, item: "Copper Ore", quantity: 3, grantId }) as any;
  const left = { expected: { item: "Copper Ore", maxQuantity: 5 }, stillHere: () => false, give: async () => true };
  const notWritten = { ...left, stillHere: () => true, give: async () => false };
  await receiveGathered("alice", "b", 4, answer("b:90"), left as any);
  await receiveGathered("alice", "b", 4, answer("b:91"), notWritten as any);
  await receiveGathered("alice", "b", 4, answer(), notWritten as any);
  // Guard: parkAgain in gathering/remote.ts passes the grant id.
  expect(parks.map(([, id]) => id)).toEqual(["b:90", "b:91", undefined]);
});

// ---------------------------------------------------------------- fix round 2: a moved chest's rolled items (review Minor 6)

test("a moved chest's rolled item is held to the bounds: a name not in the item table is dropped", async () => {
  const { objectMovesPart } = await import("../cluster/kinds/objectmoves");
  const { default: lootChest } = await import("../systems/lootChest");
  const adopted: string[] = [];
  const adopt = spyOn(lootChest, "adoptOwn").mockImplementation(((record: any) => { adopted.push(record.id); return "new"; }) as any);
  restores.push(() => adopt.mockRestore());
  const nothing = () => {};
  const part = objectMovesPart({
    now: () => 1,
    ghosts: { handOver: nothing, adoptMirror: () => true, dropMirror: nothing } as any,
    views: { showLoot: nothing, hideLoot: nothing, showChest: nothing, hideChest: nothing, showSkeleton: nothing, hideSkeleton: nothing } as any,
  });
  const block = { id: "m1", map: "main", bx: 0, by: 0, from: "f", to: "t" } as any;
  await itemTable(["Gem"]);
  const chest = (id: string, itemName: string) => ({ ...movedChest(1), id, playerLoot: [["p1", { rolled: [{ itemName, quantity: 1 }], taken: [] }]] });
  await part.accept(block, { loot: [], chests: [chest("chest_1", "Gem"), chest("chest_2", "Nope")], skeletons: [], tornadoes: [] } as any, "f");
  // Guard: checkBounds in isRolledItem (objectmoves.ts), read in accept.
  expect(adopted).toEqual(["chest_1"]);
  expect(warned.some((line) => line.includes("dropped") && line.includes("chest_2"))).toBe(true);
  // With no item table loaded the names are not checked, as for every hand-over.
  loadedItems = null;
  await part.accept(block, { loot: [], chests: [chest("chest_3", "Nope")], skeletons: [], tornadoes: [] } as any, "f");
  expect(adopted).toEqual(["chest_1", "chest_3"]);
});
