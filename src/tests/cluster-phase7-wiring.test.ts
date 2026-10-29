import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";

// Phase 7 wiring: what startCluster attaches and takes off again, the creature module's handlers, and the receiver's
// hooks. The database is stubbed. The receiver cannot be imported (it loads the whole server), so its part is read
// from its source.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: async (_sql: string, _params?: any[]) => [] }));
// Generated at server start and gitignored, so CI has no copy on disk.
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const playerCache = (await import("../services/playermanager")).default;
const assetCache = (await import("../services/assetCache")).default;
const log = (await import("../modules/logger")).default;
const { startCluster, stopCluster, clusterStartedAt, onBlocksChanged, spawnsHere, useEngineHooks, usePeerDeathHandlers, setFenceExit } = await import("../cluster");
const { MemoryStore } = await import("../cluster/memorystore");
const { ClusterBus } = await import("../cluster/bus");
const { deriveClusterKeys } = await import("../cluster/clusterkeys");
const { sealStore } = await import("../cluster/storeseal");
const { LoopbackNetwork } = await import("../cluster/loopback");
const { BlockTable } = await import("../cluster/blocks");
const { delivery } = await import("../cluster/deliver");
const { invitations } = await import("../cluster/invitations");
const { resetEntityIds } = await import("../cluster/entityids");
const { forwardTable } = await import("../cluster/forwarding");
const { linkCalls } = await import("../cluster/linkcalls");
const { playerHandoff } = await import("../cluster/handoff");
const { storeIsUp } = await import("../cluster/health");
const { tradeSettle } = await import("../cluster/tradesettle");
const { Grants, grantAdoptKey, grants, runGrantsKey } = await import("../cluster/grants");
const { atomically, nothingWritten, setClusterPlayerLock } = await import("../services/batch");
const { blockParts } = await import("../cluster/blockparts");
const { BLOCK_MOVE } = await import("../cluster/blockmove");
const { MOVES_KEY, MoveOrders } = await import("../cluster/moveorders");
const { deadKey } = await import("../cluster/coordinator");
const { readSnapshot } = await import("../cluster/snapshots");
// The creature module registers the creature slots' part (in its link hook), the peer-death handlers and the grant writer.
await import("../systems/creatures");
const { CreatureRegistry } = await import("../systems/creatures/registry");
const { CreatureSpawner } = await import("../systems/creatures/spawner");
const { normalizeSpawn, normalizeTemplate } = await import("../systems/creatures/repository");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it holds or `ms` pass; answers whether it held. */
async function until(check: () => boolean | Promise<boolean>, ms = 1_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(5);
  }
  return await check();
}

// startCluster refuses a node without the link secret (security review H2); the bus key is derived from it.
const LINK_SECRET = "phase7-wiring-link-secret-0123456789abcdef";
const BUS_KEY = deriveClusterKeys(LINK_SECRET).bus;
// The node reads its store through the seal (security review H1): what a test puts there as the coordinator or another
// node would is written through it too.
const sealed = (store: InstanceType<typeof MemoryStore>) => sealStore(store, deriveClusterKeys(LINK_SECRET).store);
const mainMap = { name: "main.json", width: 300, height: 100, tileWidth: 32, tileHeight: 32 };
const address = { publicHost: "b.example.com", port: 3000, wtPort: 3000, useSSL: true, linkHost: "b.loop", linkPort: 7012, certHash: "" };
const fast = { beatMs: 10, refreshMs: 20, snapshotMs: 10, deadCheckMs: 10, fenceExitMs: 10, healthPollMs: 10, moverReviewMs: 10, unownedGraceMs: 0 };
// Block 0,0 holds x < 4096 px; block 1,0 the next 4096 px.
const IN_FIRST = { x: 100, y: 100 };
const IN_SECOND = { x: 5_000, y: 100 };
const partNames = () => blockParts().map((part) => part.name).sort();
const ann = (over: Record<string, unknown> = {}) => ({
  id: "7", username: "ann", location: { map: "main.json", position: { x: 10, y: 20, direction: "down" } }, ...over,
});

function startB(store: InstanceType<typeof MemoryStore>, withLinks = true, timing: Record<string, number> = {}) {
  const links = withLinks ? { transport: new LoopbackNetwork().transport("b.loop", 7012), pingMs: 20, deadMs: 100 } : undefined;
  return startCluster(store, address, { ...fast, ...timing }, links);
}

/** Moves the registry's clock (monotonic, performance.now) on by `ms`, until what it answers is called. */
function shiftClock(ms: number): () => void {
  const real = performance.now.bind(performance);
  const shifted = spyOn(performance, "now").mockImplementation(() => real() + ms);
  const undo = () => shifted.mockRestore();
  restores.push(undo);
  return undo;
}

/** Block 0,0 and 1,0 of "main" are b's, at block epoch 1. */
async function ownBothBlocks(store: InstanceType<typeof MemoryStore>) {
  await new BlockTable(sealed(store)).write("main", { epoch: 1, owners: { "0,0": { nodeId: "b", epoch: 1, since: 0 }, "1,0": { nodeId: "b", epoch: 1, since: 0 } } });
}

const saved = { cluster: process.env.CLUSTER, cache: process.env.CACHE, node: process.env.NODE_ID, secret: process.env.CLUSTER_LINK_SECRET };
const restores: Array<() => void> = [];
let mapsBefore: unknown;
beforeEach(async () => {
  process.env.CLUSTER = "true";
  process.env.CACHE = "redis";
  process.env.NODE_ID = "b";
  process.env.CLUSTER_LINK_SECRET = LINK_SECRET;
  playerCache.clear();
  mapsBefore = await assetCache.get("mapProperties");
  await assetCache.add("mapProperties", [mainMap]);
});
afterEach(async () => {
  await stopCluster();
  for (const restore of restores.splice(0)) restore();
  playerCache.clear();
  delivery.detach();
  invitations.attach(null);
  resetEntityIds();
  forwardTable.clear();
  await assetCache.add("mapProperties", mapsBefore);
  for (const [name, value] of [["CLUSTER", saved.cluster], ["CACHE", saved.cache], ["NODE_ID", saved.node], ["CLUSTER_LINK_SECRET", saved.secret]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("with the cluster off nothing of phase 7 is attached", async () => {
  process.env.CLUSTER = "false";
  expect(await startB(new MemoryStore())).toBeNull();
  expect(storeIsUp()).toBe(true);
  expect(tradeSettle.attached()).toBe(false);
  expect(grants.attached()).toBe(false);
  expect(setClusterPlayerLock(null)).toBeNull();
  expect(playerHandoff.setLock(null)).toBeNull();
  expect(partNames()).toEqual([]);
  // Outside cluster mode everything spawns.
  expect(spawnsHere("main.json", IN_FIRST.x, IN_FIRST.y)).toBe(true);
});

test("a running node attaches the settle marks, grants, player locks, block parts and the mover, and stop takes them off", async () => {
  const store = new MemoryStore();
  await startB(store);
  expect(tradeSettle.attached()).toBe(true);
  expect(grants.attached()).toBe(true);

  const lock = setClusterPlayerLock(null);
  setClusterPlayerLock(lock);
  expect(lock).not.toBeNull();
  let held: string | null = null;
  expect(await lock!(["ann"], async () => {
    held = await store.get("cells:plock:ann");
    return 7;
  })).toBe(7);
  expect(held).not.toBeNull();
  expect(await store.get("cells:plock:ann")).toBeNull();

  const handoffLock = playerHandoff.setLock(null);
  playerHandoff.setLock(handoffLock);
  expect(handoffLock).not.toBeNull();

  expect(partNames()).toEqual(["creature-slots", "objects"]);
  // The mover answers BLOCK_MOVE: a second handler is refused.
  expect(() => linkCalls.handle(BLOCK_MOVE, async () => ({ ok: true }))).toThrow();

  await stopCluster();
  expect(tradeSettle.attached()).toBe(false);
  expect(grants.attached()).toBe(false);
  expect(setClusterPlayerLock(null)).toBeNull();
  expect(playerHandoff.setLock(null)).toBeNull();
  expect(partNames()).toEqual([]);
  const undo = linkCalls.handle(BLOCK_MOVE, async () => ({ ok: true }));
  undo();
});

test("a node without links attaches no block part and no mover", async () => {
  await startB(new MemoryStore(), false);
  expect(partNames()).toEqual([]);
  const undo = linkCalls.handle(BLOCK_MOVE, async () => ({ ok: true }));
  undo();
  expect(tradeSettle.attached()).toBe(true);
});

test("the store's health is read from the start, and reset at stop", async () => {
  const store = new MemoryStore();
  (store as any).isUp = () => false;
  await startB(store, false);
  expect(storeIsUp()).toBe(false);
  await stopCluster();
  expect(storeIsUp()).toBe(true);
});

test("a block-move on the bus reaches the mover: an order for a block this node does not hold is aborted", async () => {
  const store = new MemoryStore();
  await startB(store);
  const orders = new MoveOrders(sealed(store));
  const order = await orders.create({ map: "main", bx: 0, by: 0, from: "b", to: "a", blockEpoch: 999 });
  await new ClusterBus(store, "coordinator", BUS_KEY).toNode("b", "block-move", { id: order.id });
  expect(await until(async () => (await orders.get(order.id))?.state === "aborted")).toBe(true);
});

/** Starts b with links, and answers its BLOCK_MOVE handler: the one the mover sets on the link calls. */
async function startWithMoveHandler(store: InstanceType<typeof MemoryStore>) {
  let handler: ((body: unknown, from: string) => unknown) | null = null;
  const handle = linkCalls.handle.bind(linkCalls);
  const watched = spyOn(linkCalls, "handle").mockImplementation((name, fn) => {
    if (name === BLOCK_MOVE) handler = fn;
    return handle(name, fn);
  });
  restores.push(() => watched.mockRestore());
  await startB(store);
  expect(handler).not.toBeNull();
  return (body: unknown, from: string) => handler!(body, from) as Promise<{ ok: boolean; reason?: string }>;
}

/** Block 0,0 of "main" is a's at block epoch 1, and a has an order sending it to b. */
async function sendingFromA(store: InstanceType<typeof MemoryStore>) {
  await new BlockTable(sealed(store)).write("main", { epoch: 1, owners: { "0,0": { nodeId: "a", epoch: 1, since: 0 } } });
  const orders = new MoveOrders(sealed(store));
  const order = await orders.create({ map: "main", bx: 0, by: 0, from: "a", to: "b", blockEpoch: 1 });
  const sending = (await orders.swap(order.id, "ordered", "sending"))!;
  expect(sending).not.toBeNull();
  return { orders, body: { order: sending, parts: {} } };
}

test("a node past its lease refuses a BLOCK_MOVE, and takes it once the lease is back (review I1)", async () => {
  const store = new MemoryStore();
  const { orders, body } = await sendingFromA(store);
  const accept = await startWithMoveHandler(store);
  // Past the lease: the coordinator may already have given this node's blocks out.
  const undo = shiftClock(10_000);
  expect(await accept(body, "a")).toEqual({ ok: false, reason: "this node may not own blocks now" });
  expect((await orders.get(body.order.id))?.state).toBe("sending");
  undo();
  expect(await until(async () => (await accept(body, "a")).ok)).toBe(true);
  expect((await orders.get(body.order.id))?.state).toBe("sent");
});

test("a fenced node refuses a BLOCK_MOVE", async () => {
  const exits: number[] = [];
  const previousExit = setFenceExit((code) => { exits.push(code); });
  try {
    const store = new MemoryStore();
    const { orders, body } = await sendingFromA(store);
    const accept = await startWithMoveHandler(store);
    await sealed(store).set(deadKey("b"), JSON.stringify({ nodeId: "b", startedAt: clusterStartedAt(), at: Date.now() }));
    expect(await until(() => exits.length === 1)).toBe(true);
    expect(await accept(body, "a")).toEqual({ ok: false, reason: "this node may not own blocks now" });
    expect((await orders.get(body.order.id))?.state).toBe("sending");
  } finally {
    setFenceExit(previousExit);
  }
});

test("a node-dead message for a peer runs the creature module's handlers", async () => {
  const calls: string[] = [];
  const previous = usePeerDeathHandlers({
    releaseAwayHeldBy: (peer) => { calls.push(`away:${peer}`); return 0; },
    dropForeignFrom: (home) => { calls.push(`foreign:${home}`); return 0; },
  });
  try {
    // The creature module set its own at load.
    expect(previous).not.toBeNull();
    const store = new MemoryStore();
    await startB(store);
    // The coordinator writes the tombstone before it tells the world (security review M1).
    await sealed(store).set(deadKey("a"), JSON.stringify({ nodeId: "a", startedAt: 5, at: Date.now() }));
    await new ClusterBus(store, "coordinator", BUS_KEY).toWorld("node-dead", { nodeId: "a", startedAt: 5, restarted: false });
    expect(await until(() => calls.length === 2)).toBe(true);
    expect(calls).toEqual(["away:a", "foreign:a"]);
  } finally {
    usePeerDeathHandlers(previous);
  }
});

test("a node-dead message for a peer adopts the grants that run had parked", async () => {
  const store = new MemoryStore();
  // Run 5 of node a parked a grant and died before it was claimed.
  const dead = new Grants({ runOnPlayer: async () => false, now: Date.now });
  dead.attach(sealed(store), "a", { run: 5, mayAct: () => false });
  const id = (await dead.park({ username: "Ann", items: [{ itemName: "Bone", quantity: 2 }], copper: 0, call: "LOOT_TAKE" }))!;
  const quiet = spyOn(log, "error").mockImplementation(() => {});
  restores.push(() => quiet.mockRestore());
  dead.detach();
  expect(await store.members(runGrantsKey("a", 5))).toEqual([id]);

  await startB(store, false);
  // The coordinator writes the tombstone before it tells the world (security review M1).
  await sealed(store).set(deadKey("a"), JSON.stringify({ nodeId: "a", startedAt: 5, at: Date.now() }));
  await new ClusterBus(store, "coordinator", BUS_KEY).toWorld("node-dead", { nodeId: "a", startedAt: 5, restarted: false });
  expect(await until(async () => (await store.get(grantAdoptKey("a", 5))) === "b")).toBe(true);
  expect(await until(async () => (await store.members(runGrantsKey("a", 5))).length === 0)).toBe(true);
  expect(await store.members(runGrantsKey("b", clusterStartedAt()!))).toEqual([id]);
});

test("a tombstone of this run fences the node: its players are kicked, then the process exits", async () => {
  const kicked: string[] = [];
  const exits: number[] = [];
  const previousHooks = useEngineHooks({ claimed: async () => null, kick: (p, why) => { kicked.push(`${p.username}:${why}`); } });
  const previousExit = setFenceExit((code) => { exits.push(code); });
  try {
    const store = new MemoryStore();
    await startB(store, false);
    playerCache.add("7", ann());
    // A tombstone of an earlier run of b is not this run's.
    await sealed(store).set(deadKey("b"), JSON.stringify({ nodeId: "b", startedAt: clusterStartedAt()! - 1, at: Date.now() }));
    await sleep(60);
    expect(kicked).toEqual([]);
    expect(exits).toEqual([]);
    await sealed(store).set(deadKey("b"), JSON.stringify({ nodeId: "b", startedAt: clusterStartedAt(), at: Date.now() }));
    expect(await until(() => exits.length === 1)).toBe(true);
    expect(kicked).toEqual(["ann:fenced"]);
    expect(exits).toEqual([1]);
    // Fenced once: the tombstone watch and the beat both find it.
    await sleep(60);
    expect(exits).toEqual([1]);
  } finally {
    useEngineHooks(previousHooks);
    setFenceExit(previousExit);
  }
});

// Security review H1 and M1: what fences a node, drops a peer's creatures or places a player is read through the seal.
test("startCluster seals the records it writes, and a tombstone or node-dead no sealed record confirms changes nothing", async () => {
  const exits: number[] = [];
  const calls: string[] = [];
  const previousExit = setFenceExit((code) => { exits.push(code); });
  const previousHandlers = usePeerDeathHandlers({
    releaseAwayHeldBy: (peer) => { calls.push(`away:${peer}`); return 0; },
    dropForeignFrom: (home) => { calls.push(`foreign:${home}`); return 0; },
  });
  try {
    const store = new MemoryStore();
    await startB(store, false);
    const run = clusterStartedAt()!;
    expect(JSON.parse((await store.get("cells:nodeinfo:b"))!).seal).toMatch(/^[0-9a-f]{64}$/);
    // Written straight into Redis, and sealed with another cluster's key: neither is this node's tombstone.
    await store.set(deadKey("b"), JSON.stringify({ nodeId: "b", startedAt: run, at: Date.now() }));
    await sleep(60);
    await sealStore(store, deriveClusterKeys("another-cluster-link-secret-0123456789").store)
      .set(deadKey("b"), JSON.stringify({ nodeId: "b", startedAt: run, at: Date.now() }));
    await sleep(60);
    // A node-dead signed with the bus key, for this run and for a live peer, with no tombstone behind either.
    const coordinator = new ClusterBus(store, "coordinator", BUS_KEY);
    await coordinator.toWorld("node-dead", { nodeId: "b", startedAt: run, restarted: false });
    await coordinator.toWorld("node-dead", { nodeId: "a", startedAt: 5, restarted: false });
    await sleep(60);
    // Guard: the seal on tombstones, and the check of a node-dead against the store.
    expect(exits).toEqual([]);
    expect(calls).toEqual([]);
    // The real tombstone still fences.
    await sealed(store).set(deadKey("b"), JSON.stringify({ nodeId: "b", startedAt: run, at: Date.now() }));
    expect(await until(() => exits.length === 1)).toBe(true);
  } finally {
    usePeerDeathHandlers(previousHandlers);
    setFenceExit(previousExit);
  }
});

test("a login's snapshot is read only on a map this node loaded, and not once it stopped", async () => {
  const store = new MemoryStore();
  await startB(store, false);
  const at = { epoch: 1, at: 1, username: "ann", direction: "down", stats: null };
  await sealed(store).set("cells:snap:ann", JSON.stringify({ ...at, map: "main", x: 100, y: 100 }));
  await sealed(store).set("cells:snap:bob", JSON.stringify({ ...at, username: "bob", map: "main", x: 9_601, y: 100 }));
  expect((await readSnapshot(sealed(store), "ann"))?.x).toBe(100);
  // Guard: the maps startCluster gives the reader. "main" is 300 tiles of 32 px: 9600 px wide.
  expect(await readSnapshot(sealed(store), "bob")).toBeNull();
  await stopCluster();
  expect(await readSnapshot(sealed(store), "ann")).toBeNull();
});

test("a beat that finds its run taken fences the node, whatever the tombstone watch's pace", async () => {
  const exits: number[] = [];
  const previousExit = setFenceExit((code) => { exits.push(code); });
  try {
    const store = new MemoryStore();
    // The tombstone watch would not look again for a minute.
    await startB(store, false, { deadCheckMs: 60_000 });
    await sealed(store).set(deadKey("b"), JSON.stringify({ nodeId: "b", startedAt: clusterStartedAt(), at: Date.now() }));
    expect(await until(() => exits.length === 1)).toBe(true);
    expect(exits).toEqual([1]);
    // A taken run spawns nothing.
    expect(spawnsHere("main.json", IN_FIRST.x, IN_FIRST.y)).toBe(false);
  } finally {
    setFenceExit(previousExit);
  }
});

test("a node spawns in its own blocks only while it holds its lease", async () => {
  const store = new MemoryStore();
  await ownBothBlocks(store);
  await startB(store, false);
  expect(spawnsHere("main.json", IN_FIRST.x, IN_FIRST.y)).toBe(true);
  // Past the lease: the last good beat is older than ALIVE_TTL_MS + LEASE_MARGIN_MS.
  const undo = shiftClock(10_000);
  expect(spawnsHere("main.json", IN_FIRST.x, IN_FIRST.y)).toBe(false);
  undo();
  expect(await until(() => spawnsHere("main.json", IN_FIRST.x, IN_FIRST.y))).toBe(true);
});

test("a slot skipped while the lease had lapsed spawns once the lease renews, with no change to the block table (review I1)", async () => {
  const store = new MemoryStore();
  await ownBothBlocks(store);
  await startB(store, false);
  const spawner = new CreatureSpawner(new CreatureRegistry(64), { spawnsHere }, () => 0, 1);
  restores.push(onBlocksChanged(() => spawner.reviewOwnership(Date.now())));
  // Past the lease when the slot comes due: it is skipped, and waits as an elsewhere slot.
  const undo = shiftClock(10_000);
  spawner.load({
    templates: new Map([[1, normalizeTemplate({ id: 1, name: "Wolf", level_min: 3, level_max: 5, health_base: 50, health_per_level: 10 })]]),
    spawns: new Map([[1, normalizeSpawn({ id: 1, template_id: 1, map: "main.json", x: IN_FIRST.x, y: IN_FIRST.y, respawn_min_s: 10, respawn_max_s: 20, layer_policy: "shared" })]]),
    pools: new Map(),
  } as any, Date.now());
  expect(spawner.getLiveInstanceId(1)).toBeUndefined();
  undo();
  // The next beat finds the gate open again and tells the spawners.
  expect(await until(() => { spawner.tick(Date.now()); return spawner.getLiveInstanceId(1) !== undefined; })).toBe(true);
});

test("a fenced node spawns nothing and writes no snapshot, before any beat has read its tombstone (review m2)", async () => {
  const exits: number[] = [];
  const previousHooks = useEngineHooks({ claimed: async () => null, kick: () => {} });
  const previousExit = setFenceExit((code) => { exits.push(code); });
  const quiet = spyOn(log, "error").mockImplementation(() => {});
  restores.push(() => quiet.mockRestore());
  try {
    const store = new MemoryStore();
    await ownBothBlocks(store);
    // No beat comes again in this test: only the tombstone watch finds the tombstone, and the lease stays valid.
    await startB(store, false, { beatMs: 60_000 });
    expect(spawnsHere("main.json", IN_FIRST.x, IN_FIRST.y)).toBe(true);
    await sealed(store).set(deadKey("b"), JSON.stringify({ nodeId: "b", startedAt: clusterStartedAt(), at: Date.now() }));
    expect(await until(() => exits.length === 1)).toBe(true);
    expect(spawnsHere("main.json", IN_FIRST.x, IN_FIRST.y)).toBe(false);
    playerCache.add("7", ann({ ownerEpoch: 3, stats: { health: 5, max_health: 10, stamina: 1, max_stamina: 2 } }));
    await sleep(80);
    expect(await readSnapshot(store, "ann")).toBeNull();
  } finally {
    useEngineHooks(previousHooks);
    setFenceExit(previousExit);
  }
});

test("nothing spawns until the mover's seed has read the open orders, and the skipped slots are looked at again", async () => {
  const store = new MemoryStore();
  await ownBothBlocks(store);
  const members = store.members.bind(store);
  let failing = true;
  (store as any).members = async (key: string) => {
    if (failing && key === MOVES_KEY) throw new Error("store away");
    return members(key);
  };
  const quiet = spyOn(log, "error").mockImplementation(() => {});
  restores.push(() => quiet.mockRestore());
  const told: string[][] = [];
  const stopListening = onBlocksChanged((maps) => { told.push(maps); });
  restores.push(stopListening);
  await startB(store);
  await sleep(50);
  expect(spawnsHere("main.json", IN_FIRST.x, IN_FIRST.y)).toBe(false);
  expect(spawnsHere("main.json", IN_SECOND.x, IN_SECOND.y)).toBe(false);
  told.length = 0;
  failing = false;
  expect(await until(() => spawnsHere("main.json", IN_FIRST.x, IN_FIRST.y))).toBe(true);
  expect(await until(() => told.some((maps) => maps.includes("main")))).toBe(true);
  // Logged when it started failing, not on every try.
  expect(quiet.mock.calls.filter(([line]) => String(line).includes("open move orders")).length).toBe(1);
});

test("a block this node gave away in an open move order spawns nothing here, its other blocks do", async () => {
  const store = new MemoryStore();
  await ownBothBlocks(store);
  // Left open by the last run, which was moving block 0,0 to a.
  await new MoveOrders(sealed(store)).create({ map: "main", bx: 0, by: 0, from: "b", to: "a", blockEpoch: 1 });
  const quiet = spyOn(log, "warn").mockImplementation(() => {});
  restores.push(() => quiet.mockRestore());
  await startB(store);
  expect(spawnsHere("main.json", IN_SECOND.x, IN_SECOND.y)).toBe(true);
  expect(spawnsHere("main.json", IN_FIRST.x, IN_FIRST.y)).toBe(false);
});

test("a login claim runs the engine's claimed hook with the directory entry's epoch", async () => {
  const seen: Array<[string, number]> = [];
  const previous = useEngineHooks({
    claimed: async (p, entry) => { seen.push([p.username, entry.epoch]); return null; },
    kick: () => {},
  });
  try {
    const started = await startB(new MemoryStore(), false);
    playerCache.add("7", ann());
    expect(await until(() => seen.length === 1)).toBe(true);
    expect(seen[0]).toEqual(["ann", (await started!.directory.get("ann"))!.epoch]);
  } finally {
    useEngineHooks(previous);
  }
});

test("a player with an owner epoch gets a snapshot in the store", async () => {
  const store = new MemoryStore();
  await startB(store, false);
  playerCache.add("7", ann({ ownerEpoch: 3, stats: { health: 5, max_health: 10, stamina: 1, max_stamina: 2 } }));
  expect(await until(async () => (await readSnapshot(store, "ann")) !== null)).toBe(true);
  expect((await readSnapshot(store, "ann"))!.epoch).toBe(3);
});

test("a node past its lease writes no snapshot", async () => {
  const store = new MemoryStore();
  await startB(store, false, { beatMs: 60_000 });
  shiftClock(10_000);
  playerCache.add("7", ann({ ownerEpoch: 3, stats: { health: 5, max_health: 10, stamina: 1, max_stamina: 2 } }));
  await sleep(80);
  expect(await readSnapshot(store, "ann")).toBeNull();
});

test("the creature module loads the grant writer", () => {
  const writer = grants.setWriter(null);
  grants.setWriter(writer);
  expect(writer).not.toBeNull();
});

const receiverCode = readFileSync(join(import.meta.dir, "../socket/receiver.ts"), "utf8");

test("the receiver hands in its hooks, and shows a marked player's bags again once the login's mark runs out", () => {
  expect(receiverCode).toContain("useEngineHooks({");
  expect(receiverCode).toContain("adoptOwnerEpoch(");
  // A refused claim leaves the old epoch on the player, so the save at disconnect writes nothing.
  expect(receiverCode).toContain("refused.ownerEpoch = entry.epoch;");
  const refresh = receiverCode.indexOf("await refreshPlayer(playerData.username);");
  expect(refresh).toBeGreaterThan(0);
  const reload = receiverCode.indexOf("reloadWhenSettled(playerData.username);", refresh);
  expect(reload).toBeGreaterThan(refresh);
  expect(reload - refresh).toBeLessThan(250);
});

test("the receiver's hooks end one session by its connection, never by the player's name", () => {
  const start = receiverCode.indexOf("useEngineHooks({");
  const hooks = receiverCode.slice(start, receiverCode.indexOf("\n});", start));
  expect(hooks).toContain('endSessionOf(refused, "Logged in from another location")');
  expect(hooks).toContain('kick: (p) => endSessionOf(p, "Server is restarting")');
  expect(hooks).not.toContain("player.kick(");
  const end = receiverCode.indexOf("function endSessionOf(");
  expect(receiverCode.slice(end, receiverCode.indexOf("\n}", end))).toContain("row?.wt?.close?.(1000, why)");
});

test("items claimed from another node that cannot be written here are parked again before they are logged lost", () => {
  const park = receiverCode.indexOf("async function parkAgain(");
  expect(park).toBeGreaterThan(0);
  const body = receiverCode.slice(park, receiverCode.indexOf("\n}", park));
  expect(body).toContain("grants.park({ username, items: rows.slice(at, at + MAX_GRANT_ITEMS)");
  // Logged lost only in the catch, when the store did not take them.
  expect(body.indexOf("log.error(")).toBeGreaterThan(body.indexOf("} catch"));
  // Both ways a claimed hand-over is not written, for corpses, chests and ground loot.
  expect(receiverCode.match(/await parkAgain\(player\.username, items, copper, call, /g)?.length).toBe(2);
  expect(receiverCode.match(/await parkAgain\(player\.username, handed, 0, "PICKUP_REQUEST", /g)?.length).toBe(2);
  expect(receiverCode).toContain('copper, "LOOT_TAKE", asked.grantId)');
  expect(receiverCode).toContain('0, "CHEST_TAKE", asked.grantId)');
});

// The receiver's hand-over helpers, run from its source with the names they use handed in (as the other receiver
// tests do), and a grant store that records what is parked again.
const helpers = (() => {
  const start = receiverCode.indexOf("function stillHere(");
  const end = receiverCode.indexOf("/** getPlayersNearPoint, and the mirrored players", start);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const names = "atomically, nothingWritten, inventory, currencySystem, sendPacket, packetManager, formatMoney, log, itemOwner, askOwner, bagRoom, creatures, listener, Events, bareMap, lootChest, loot, playerCache, grants, MAX_GRANT_ITEMS";
  const body = receiverCode.slice(start, end).replace(/^export /gm, "");
  return new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names} }: any) { ${body}\nreturn { receiveHanded, pickupLootHere }; }`)}\nreturn make;`)();
})();

/**
 * The real batch (its database stubbed): `writeFails` throws inside it, before anything is sent; `keptFails` has the
 * rows sent and kept, then a kept step fail, as a row cache that cannot be updated after the commit does.
 */
function handing(opts: { here?: boolean; writeFails?: boolean; keptFails?: boolean; parkFailsAt?: number } = {}) {
  const parked: any[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const me: any = { id: "7", username: "Zed", wt: {} };
  const run = helpers({
    atomically,
    nothingWritten,
    inventory: {
      add: async (_name: string, _item: any, batch?: any) => {
        if (opts.writeFails) throw new Error("refused");
        if (opts.keptFails) {
          batch.add({ sql: "INSERT INTO inventory" });
          batch.kept(() => { throw new Error("cache gone"); });
        }
        return true;
      },
    },
    itemOwner: () => "b",
    askOwner: async () => ({ ok: true, item: { item: "Pelt", quantity: 3, map: "main.json", x: 1, y: 2 } }),
    loot: { pickup: () => ({ success: false }) },
    listener: { emit: () => {} },
    Events: { PLAYER_LOOT_RETRIEVED: "retrieved" },
    currencySystem: { add: async (_name: string, amount: any) => ({ copper: amount.copper, silver: 0, gold: 0 }) },
    sendPacket: () => {},
    packetManager: new Proxy({}, { get: () => () => [] }),
    formatMoney: (copper: number) => `${copper} copper`,
    log: { error: (line: string) => { errors.push(line); }, warn: (line: string) => { warnings.push(line); } },
    playerCache: { get: () => (opts.here === false ? undefined : me) },
    MAX_GRANT_ITEMS: 2,
    grants: {
      park: async (handOver: any) => {
        if (opts.parkFailsAt === parked.length) return null;
        parked.push(handOver);
        return `g${parked.length}`;
      },
    },
  });
  return { me, run, parked, errors, warnings };
}

const pelts = [{ name: "Pelt", quantity: 3 }, { name: "Bone", quantity: 1 }, { name: "Fang", quantity: 2 }];

test("a hand-over claimed for a player who left meanwhile is parked again, in grants of at most MAX_GRANT_ITEMS rows, the money with the first", async () => {
  const t = handing({ here: false });
  expect(await t.run.receiveHanded(t.me, pelts, 9, "LOOT_TAKE")).toBeNull();
  expect(t.parked).toEqual([
    { username: "Zed", items: [{ itemName: "Pelt", quantity: 3 }, { itemName: "Bone", quantity: 1 }], copper: 9, call: "LOOT_TAKE" },
    { username: "Zed", items: [{ itemName: "Fang", quantity: 2 }], copper: 0, call: "LOOT_TAKE" },
  ]);
  expect(t.errors).toEqual([]);
  expect(t.warnings.some((line) => line.includes("Zed") && line.includes("g1, g2"))).toBe(true);
});

test("a hand-over whose write failed here is parked again whole", async () => {
  const t = handing({ writeFails: true });
  expect(await t.run.receiveHanded(t.me, [{ name: "Pelt", quantity: 3 }], 0, "CHEST_TAKE")).toBeNull();
  expect(t.parked).toEqual([{ username: "Zed", items: [{ itemName: "Pelt", quantity: 3 }], copper: 0, call: "CHEST_TAKE" }]);
  expect(t.errors).toEqual([]);
});

test("a hand-over whose batch may have been written (a kept step failed after the commit) is logged lost, never parked (review C1)", async () => {
  const t = handing({ keptFails: true });
  expect(await t.run.receiveHanded(t.me, [{ name: "Pelt", quantity: 3 }], 4, "LOOT_TAKE")).toBeNull();
  expect(t.parked).toEqual([]);
  expect(t.errors).toHaveLength(1);
  expect(t.errors[0]).toContain("Zed");
  expect(t.errors[0]).toContain("Pelt");
  expect(t.errors[0]).toContain("cache gone");
});

test("picked-up loot of another node: parked again when nothing was written, logged lost when it may have been (review C1)", async () => {
  const refused = handing({ writeFails: true });
  expect(await refused.run.pickupLootHere(refused.me, "loot_1")).toEqual({ added: false });
  expect(refused.parked).toEqual([{ username: "Zed", items: [{ itemName: "Pelt", quantity: 3 }], copper: 0, call: "PICKUP_REQUEST" }]);
  expect(refused.errors).toEqual([]);
  const kept = handing({ keptFails: true });
  expect(await kept.run.pickupLootHere(kept.me, "loot_1")).toEqual({ added: false });
  expect(kept.parked).toEqual([]);
  expect(kept.errors).toHaveLength(1);
  expect(kept.errors[0]).toContain("Pelt x3");
  expect(kept.errors[0]).toContain("cache gone");
});

test("a hand-over that cannot be parked again is logged lost by name, less what parked before the failure", async () => {
  const none = handing({ here: false, parkFailsAt: 0 });
  await none.run.receiveHanded(none.me, pelts, 9, "LOOT_TAKE");
  expect(none.errors).toHaveLength(1);
  expect(none.errors[0]).toContain("Pelt");
  expect(none.errors[0]).toContain("9 copper");
  expect(none.errors[0]).toContain("left meanwhile");
  const half = handing({ here: false, parkFailsAt: 1 });
  await half.run.receiveHanded(half.me, pelts, 9, "LOOT_TAKE");
  expect(half.errors).toHaveLength(1);
  expect(half.errors[0]).toContain("except what hand-over(s) g1 hold");
});
