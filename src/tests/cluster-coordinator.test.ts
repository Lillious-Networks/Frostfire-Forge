import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { BlockTable, type MapBlocks } from "../cluster/blocks";
import { ClusterBus } from "../cluster/bus";
import { Coordinator, LOCK_KEY, deadKey } from "../cluster/coordinator";
import { PlayerDirectory } from "../cluster/directory";
import { MapCatalogue, extentOf } from "../cluster/maps";
import { MemoryStore } from "../cluster/memorystore";
import { ALIVE_TTL_MS, LEASE_MARGIN_MS, NodeRegistry, type NodeInfo } from "../cluster/nodes";
import log from "../modules/logger";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

// MemoryStore expires keys by Date.now, so the fake clock is Bun's system time:
// the lock and the heartbeats run out when the test moves it on.

const T0 = new Date("2026-10-21T12:00:00Z").getTime();
let clock = T0;
const advance = (ms: number) => {
  clock += ms;
  setSystemTime(new Date(clock));
};

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

const quiet: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  clock = T0;
  setSystemTime(new Date(clock));
  quiet.push(spyOn(log, "success").mockImplementation(() => {}), spyOn(log, "info").mockImplementation(() => {}));
});
afterEach(() => {
  setSystemTime();
  for (const spy of quiet.splice(0)) spy.mockRestore();
});

const info = (nodeId: string): NodeInfo => ({
  nodeId,
  regionId: "eu",
  publicHost: `${nodeId}.example.com`,
  port: 3000,
  wtPort: 3002,
  useSSL: true,
  startedAt: T0,
});

async function world() {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  const catalogue = new MapCatalogue(store);
  const make = (id: string) => new Coordinator(store, new ClusterBus(store, id, TEST_BUS_KEY), { id, now: () => clock });
  const join = async (...ids: string[]) => {
    for (const id of ids) {
      await registry.announce(info(id));
      await registry.beat(id);
    }
  };
  const tableOf = async (map: string): Promise<MapBlocks | null> => {
    const raw = await store.get(`cells:blocks:${map}`);
    return raw ? JSON.parse(raw) : null;
  };
  // blocks wide x high, in px
  const map = (name: string, blocksX: number, blocksY: number) => catalogue.publish([extentOf(name, blocksX * 4096, blocksY * 4096)]);
  return { store, registry, make, join, tableOf, map };
}

const ownersOf = (table: MapBlocks | null) =>
  Object.fromEntries(Object.entries(table?.owners ?? {}).map(([key, owner]) => [key, owner.nodeId]));

test("one coordinator leads; the standby takes over once the lock runs out", async () => {
  const { store, make } = await world();
  const a = make("coord-a");
  const b = make("coord-b");
  await a.tick();
  await b.tick();
  expect(a.isLeader()).toBe(true);
  expect(b.isLeader()).toBe(false);

  // a keeps renewing: b stays standby for as long as it does.
  for (let i = 0; i < 10; i++) {
    advance(1000);
    await a.tick();
    await b.tick();
  }
  expect(a.isLeader()).toBe(true);
  expect(b.isLeader()).toBe(false);

  // a stops renewing (stalled): after the 5 s ttl b has the lock.
  advance(5001);
  await b.tick();
  expect(b.isLeader()).toBe(true);
  const held = await store.get("cells:coordinator");
  expect(JSON.parse(held!).holder).toBe("coord-b");

  // a finds out on its next renewal and does not touch b's lock.
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  await a.tick();
  warns.mockRestore();
  expect(a.isLeader()).toBe(false);
  expect(await store.get("cells:coordinator")).toBe(held);
});

test("stop releases the lock so a standby leads at once", async () => {
  const { make } = await world();
  const a = make("coord-a");
  const b = make("coord-b");
  await a.tick();
  await b.tick();
  await a.stop();
  expect(a.isLeader()).toBe(false);
  await b.tick();
  expect(b.isLeader()).toBe(true);
});

test("the first assignment covers every block of every map and tells the world", async () => {
  const { store, make, join, tableOf, map } = await world();
  await join("n1", "n2");
  await map("main", 8, 4);
  await map("cave", 1, 1);
  const listener = new BlockTable(store);
  const bus = new ClusterBus(store, "n1", TEST_BUS_KEY);
  listener.attach(bus);
  await bus.start();
  await listener.preload(["main", "cave"]);

  await make("coord").tick();

  const main = await tableOf("main");
  expect(main!.epoch).toBe(1);
  expect(Object.keys(main!.owners).length).toBe(32);
  for (const owner of Object.values(main!.owners)) {
    expect(["n1", "n2"]).toContain(owner.nodeId);
    expect(owner.epoch).toBe(1);
    expect(owner.since).toBe(T0);
  }
  // An even split of an 8x4 map: 16 blocks each.
  expect(Object.values(ownersOf(main)).filter((n) => n === "n1").length).toBe(16);
  expect(Object.keys((await tableOf("cave"))!.owners)).toEqual(["0,0"]);

  await settle();
  expect(listener.ownerOf("main", 0, 0)?.nodeId).toBe(main!.owners["0,0"]!.nodeId);
});

test("the split weighs blocks by the players reported in them", async () => {
  const { registry, make, join, tableOf, map } = await world();
  await join("n1", "n2");
  await map("main", 4, 1);
  // 1 + 5 on block 0,0 against 1 on each of the other three: the first node gets that block alone.
  await registry.report({ nodeId: "n1", at: T0, players: 5, creatures: 0, blocks: { "main|0,0": 5 } });
  await make("coord").tick();
  const owners = ownersOf(await tableOf("main"));
  expect(owners["0,0"]).not.toBe(owners["1,0"]);
  expect(owners["1,0"]).toBe(owners["3,0"]);
});

test("a map published later is assigned on a later tick", async () => {
  const { make, join, tableOf, map } = await world();
  await join("n1");
  await map("main", 2, 2);
  const coordinator = make("coord");
  await coordinator.tick();
  expect(await tableOf("cave")).toBeNull();

  await map("cave", 3, 1);
  advance(1000);
  await join("n1");
  await coordinator.tick();
  expect(ownersOf(await tableOf("cave"))).toEqual({ "0,0": "n1", "1,0": "n1", "2,0": "n1" });
  expect((await tableOf("main"))!.epoch).toBe(1); // untouched
});

test("a node that joins does not take blocks from a live one", async () => {
  const { make, join, tableOf, map } = await world();
  await join("n1");
  await map("main", 4, 4);
  const coordinator = make("coord");
  await coordinator.tick();
  const before = await tableOf("main");

  await join("n2");
  advance(1000);
  await join("n1", "n2");
  await coordinator.tick();
  expect(await tableOf("main")).toEqual(before);
});

test("unowned blocks go to the live node with the most neighbouring blocks", async () => {
  const { registry, store, make, join, tableOf, map } = await world();
  await join("a", "b");
  await map("main", 3, 2);
  const blocks = new BlockTable(store);
  const owned = (nodeId: string) => ({ nodeId, epoch: 4, since: 1 });
  // a: 0,0 0,1 1,0   b: 2,0   free: 1,1 (two of a's around it) and 2,1 (only b next to it)
  await blocks.write("main", { epoch: 4, owners: { "0,0": owned("a"), "0,1": owned("a"), "1,0": owned("a"), "2,0": owned("b") } });
  // b is busier: it must not matter where a has more neighbours.
  await registry.report({ nodeId: "b", at: T0, players: 50, creatures: 0, blocks: {} });

  await make("coord").tick();
  const table = await tableOf("main");
  expect(ownersOf(table)).toEqual({ "0,0": "a", "0,1": "a", "1,0": "a", "2,0": "b", "1,1": "a", "2,1": "b" });
  expect(table!.epoch).toBe(5);
  expect(table!.owners["1,1"]).toEqual({ nodeId: "a", epoch: 5, since: T0 });
  expect(table!.owners["0,0"]).toEqual(owned("a")); // unchanged blocks keep their epoch
});

test("a tie between neighbours goes to the less loaded node", async () => {
  const { registry, store, make, join, tableOf, map } = await world();
  await join("a", "b");
  await map("main", 3, 1);
  await new BlockTable(store).write("main", { epoch: 1, owners: { "0,0": { nodeId: "a", epoch: 1, since: 1 }, "2,0": { nodeId: "b", epoch: 1, since: 1 } } });
  await registry.report({ nodeId: "a", at: T0, players: 9, creatures: 0, blocks: {} });
  await registry.report({ nodeId: "b", at: T0, players: 2, creatures: 0, blocks: {} });
  await make("coord").tick();
  expect(ownersOf(await tableOf("main"))["1,0"]).toBe("b");
});

test("a block cut off from every live node goes to the least loaded node", async () => {
  const { registry, store, make, join, tableOf, map } = await world();
  await join("a", "b");
  await map("main", 3, 1);
  // 1,0 is free but its only neighbours belong to a dead node.
  const dead = { nodeId: "gone", epoch: 1, since: 1 };
  await new BlockTable(store).write("main", { epoch: 1, owners: { "0,0": dead, "2,0": dead } });
  await registry.report({ nodeId: "a", at: T0, players: 3, creatures: 0, blocks: {} });
  // "gone" was never announced: one warning, silenced here.
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    await make("coord").tick();
  } finally {
    warns.mockRestore();
  }
  const owners = ownersOf(await tableOf("main"));
  expect(owners).toEqual({ "0,0": "gone", "2,0": "gone", "1,0": "b" });
});

test("with no live nodes nothing is written", async () => {
  const { make, tableOf, map } = await world();
  await map("main", 2, 2);
  await make("coord").tick();
  expect(await tableOf("main")).toBeNull();
});

test("an owner never announced keeps its blocks, with one warning", async () => {
  const { store, make, join, tableOf, map } = await world();
  await join("a");
  await map("main", 2, 1);
  const owned = (nodeId: string) => ({ nodeId, epoch: 1, since: 1 });
  await new BlockTable(store).write("main", { epoch: 1, owners: { "0,0": owned("a"), "1,0": owned("gone") } });
  const before = await tableOf("main");
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const coordinator = make("coord");
    await coordinator.tick();
    for (let second = 0; second < 40; second++) {
      advance(1000);
      await join("a");
      await coordinator.tick();
    }
    expect(await tableOf("main")).toEqual(before);
    const aboutGone = warns.mock.calls.filter(([message]) => String(message).includes("gone"));
    expect(aboutGone.length).toBe(1);
  } finally {
    warns.mockRestore();
  }
});

test("a stored table that cannot be read is never overwritten; one error, and it is assigned once it reads again", async () => {
  const { store, make, join, tableOf, map } = await world();
  await join("n1");
  await map("main", 2, 1);
  await store.set("cells:blocks:main", "{ not json");
  const errors = spyOn(log, "error").mockImplementation(() => {});
  try {
    const coordinator = make("coord");
    await coordinator.tick();
    advance(1000);
    await join("n1");
    await coordinator.tick();
    expect(await store.get("cells:blocks:main")).toBe("{ not json");
    expect(errors.mock.calls.filter(([message]) => String(message).includes("main")).length).toBe(1);

    // Valid JSON of the wrong shape is no better.
    await store.set("cells:blocks:main", '{"epoch":3}');
    await coordinator.tick();
    expect(await store.get("cells:blocks:main")).toBe('{"epoch":3}');

    await store.set("cells:blocks:main", JSON.stringify({ epoch: 3, owners: {} }));
    await coordinator.tick();
    const table = await tableOf("main");
    expect(table!.epoch).toBe(4);
    expect(ownersOf(table)).toEqual({ "0,0": "n1", "1,0": "n1" });
  } finally {
    errors.mockRestore();
  }
});

test("a write over a table that changed since it was read is refused and skipped", async () => {
  const { store, make, join, tableOf, map } = await world();
  await join("n1");
  await map("main", 2, 1);
  // Another (newer) leader writes the table right after this coordinator has read it.
  const newer: MapBlocks = { epoch: 5, owners: { "0,0": { nodeId: "other", epoch: 5, since: 1 } } };
  const get = store.get.bind(store);
  let raced = false;
  store.get = async (key: string) => {
    const raw = await get(key);
    if (key === "cells:blocks:main" && !raced) {
      raced = true;
      await store.set(key, JSON.stringify(newer));
    }
    return raw;
  };
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    await make("coord").tick();
    expect(await tableOf("main")).toEqual(newer);
    expect(warns.mock.calls.filter(([message]) => String(message).includes("main")).length).toBe(1);
  } finally {
    warns.mockRestore();
    store.get = get;
  }
});

test("renewal keeps the lock's ttl: a leader that stops renewing loses it after the ttl", async () => {
  const { store, make } = await world();
  const a = make("coord-a");
  await a.tick();
  // Redis goes away part way through a renewal: whatever a separate expire call would have done never happens.
  store.expire = async () => { throw new Error("Redis lost"); };
  advance(1000);
  await a.tick(); // a renewal
  // No renewal after this one: the lock must still run out, or no standby could ever lead.
  advance(5001);
  expect(await store.get("cells:coordinator")).toBeNull();
  const b = make("coord-b");
  await b.tick();
  expect(b.isLeader()).toBe(true);
});

// Cold start: the coordinator is up first, and the nodes come up one by one.
async function coldStart(options: { expectedNodes?: number; settleMs?: number }) {
  const { store, registry, join, tableOf, map } = await world();
  const coordinator = new Coordinator(store, new ClusterBus(store, "coord", TEST_BUS_KEY), { id: "coord", now: () => clock, ...options });
  // Spied (and silenced) in beforeEach.
  const infos = log.info as unknown as { mock: { calls: unknown[][] } };
  // node-1 is live and has published the maps before the others.
  await join("n1");
  await map("main", 4, 4);
  await coordinator.tick();
  const first = await tableOf("main");
  advance(1000);
  await join("n1", "n2", "n3");
  await coordinator.tick();
  const waits = infos.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("waiting for"));
  return { coordinator, store, registry, join, tableOf, first, waits };
}

test("cold start: with CLUSTER_EXPECTED_NODES the split waits for every expected node", async () => {
  const { tableOf, first, waits } = await coldStart({ expectedNodes: 3 });
  expect(first).toBeNull();
  // Once per pass while it waits.
  expect(waits).toEqual(["Coordinator coord waiting for 1/3 nodes before splitting new maps, at most 60 s more"]);
  const table = await tableOf("main");
  expect(table!.epoch).toBe(1);
  const owners = Object.values(ownersOf(table));
  expect(owners.length).toBe(16);
  expect(new Set(owners)).toEqual(new Set(["n1", "n2", "n3"]));
});

test("cold start: without the settle rule the first live node takes every block (today's behaviour)", async () => {
  const { tableOf, first, waits } = await coldStart({});
  expect(waits).toEqual([]);
  expect(new Set(Object.values(ownersOf(first)))).toEqual(new Set(["n1"]));
  // The nodes that came later get nothing: owned blocks never move.
  expect(await tableOf("main")).toEqual(first);
});

test("cold start: CLUSTER_SETTLE_MS splits over the nodes live once it has passed, if fewer than expected come", async () => {
  const { coordinator, join, tableOf } = await coldStart({ expectedNodes: 4, settleMs: 15_000 });
  expect(await tableOf("main")).toBeNull();
  // 15 s since node-1 was first seen; node-4 never comes.
  for (let second = 0; second < 13; second++) {
    advance(1000);
    await join("n1", "n2", "n3");
    await coordinator.tick();
  }
  expect(await tableOf("main")).toBeNull();
  advance(1000);
  await join("n1", "n2", "n3");
  await coordinator.tick();
  expect(new Set(Object.values(ownersOf(await tableOf("main"))))).toEqual(new Set(["n1", "n2", "n3"]));
});

test("cold start: CLUSTER_EXPECTED_NODES alone waits at most 60 s, then splits over the nodes live", async () => {
  const { store, join, tableOf, map } = await world();
  const coordinator = new Coordinator(store, new ClusterBus(store, "coord", TEST_BUS_KEY), { id: "coord", now: () => clock, expectedNodes: 3 });
  const infos = log.info as unknown as { mock: { calls: unknown[][] } };
  const caps = () => infos.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("settle cap"));
  // node-3 never comes.
  await join("n1", "n2");
  await map("main", 4, 4);
  await coordinator.tick();
  for (let second = 0; second < 59; second++) {
    advance(1000);
    await join("n1", "n2");
    await coordinator.tick();
  }
  expect(await tableOf("main")).toBeNull();
  expect(caps()).toEqual([]);
  // 60 s since node-1 was first seen.
  advance(1000);
  await join("n1", "n2");
  await coordinator.tick();
  expect(new Set(Object.values(ownersOf(await tableOf("main"))))).toEqual(new Set(["n1", "n2"]));
  advance(1000);
  await join("n1", "n2");
  await coordinator.tick();
  expect(caps()).toEqual(["Coordinator coord settle cap reached: splitting over 2/3 nodes"]);
});

test("the settle cap is not logged when no empty table was waiting", async () => {
  const { store, join, map } = await world();
  await join("a", "b");
  await map("main", 2, 1);
  await new BlockTable(store).write("main", { epoch: 1, owners: { "0,0": { nodeId: "a", epoch: 1, since: 1 }, "1,0": { nodeId: "b", epoch: 1, since: 1 } } });
  // A leader that comes long after the cold start, with one of the 3 expected nodes down.
  const coordinator = new Coordinator(store, new ClusterBus(store, "coord", TEST_BUS_KEY), { id: "coord", now: () => clock, expectedNodes: 3 });
  const infos = log.info as unknown as { mock: { calls: unknown[][] } };
  for (let second = 0; second <= 61; second++) {
    await join("a", "b");
    await coordinator.tick();
    advance(1000);
  }
  expect(infos.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("settle cap"))).toEqual([]);
});

test("the settle rule holds back only empty tables: unowned blocks of a split map are still given out", async () => {
  const { store, join, tableOf, map } = await world();
  await join("a");
  await map("main", 2, 1);
  await new BlockTable(store).write("main", { epoch: 1, owners: { "0,0": { nodeId: "a", epoch: 1, since: 1 } } });
  const coordinator = new Coordinator(store, new ClusterBus(store, "coord", TEST_BUS_KEY), { id: "coord", now: () => clock, expectedNodes: 3 });
  await coordinator.tick();
  expect(ownersOf(await tableOf("main"))).toEqual({ "0,0": "a", "1,0": "a" });
});

test("a block table deleted while the cluster runs is left alone: no block is given a second time", async () => {
  const { store, make, join, tableOf, map } = await world();
  const errors = spyOn(log, "error").mockImplementation(() => {});
  try {
    await join("n1", "n2");
    await map("main", 2, 1);
    const coordinator = make("coord");
    await coordinator.tick();
    const split = await tableOf("main");
    expect(ownersOf(split)).toEqual({ "0,0": expect.any(String), "1,0": expect.any(String) });
    // A node holds the blocks by the table it cached.
    const node = new BlockTable(store);
    await node.preload(["main"]);
    const pass = async (coordinatorOf = coordinator) => {
      advance(1000);
      await join("n1", "n2");
      await coordinatorOf.tick();
    };

    // Deleted by a party that can write Redis (DEL needs no store key). Split afresh, the blocks would change hands
    // with no move order while each node still serves them: a block live on two nodes.
    await store.del("cells:blocks:main");
    for (let i = 0; i < 3; i++) await pass();
    // Guard (secfix A round 2, the map's epoch counter): a map split before is left alone, like a corrupt table.
    expect(await tableOf("main")).toBeNull();
    await node.refresh();
    expect(await node.load("main")).toEqual(split!);
    expect(errors.mock.calls.filter(([line]) => String(line).includes("map main is missing")).length).toBe(1);

    // Another coordinator run (a failover) has never read the table: the epoch counter alone says the map was split.
    await store.del(LOCK_KEY);
    const next = make("coord-b");
    await pass(next);
    expect(next.isLeader()).toBe(true);
    expect(await tableOf("main")).toBeNull();

    // An operator puts the table back (a backup): it is read again, and nothing else changes.
    await store.set("cells:blocks:main", JSON.stringify(split));
    await pass(next);
    expect(await tableOf("main")).toEqual(split!);

    // The counter is not sealed and can be deleted too. Guard (secfix A round 2, the table seen in this run): this
    // run read the table before, and leaves the map alone.
    await store.del("cells:blocks:main");
    await store.del("cells:blocksepoch:main");
    await pass(next);
    expect(await tableOf("main")).toBeNull();

    // Recovery, with the cluster stopped: both keys deleted, and a coordinator run that never read the map splits it.
    await store.del(LOCK_KEY);
    const fresh = make("coord-c");
    await pass(fresh);
    expect(Object.keys((await tableOf("main"))!.owners)).toHaveLength(2);
  } finally {
    errors.mockRestore();
  }
});

test("a standby does not assign", async () => {
  const { make, join, tableOf, map } = await world();
  await join("n1");
  const leader = make("coord-a");
  await leader.tick();
  await map("main", 2, 2);
  await make("coord-b").tick();
  expect(await tableOf("main")).toBeNull();
});

// Cells phase 7 (Task 13 re-review, m7): a beat of the dead run that lands after the takeover's last read holds that
// run's lease for up to ALIVE_TTL_MS + LEASE_MARGIN_MS. Its blocks are given out only once that has passed.

/** Nodes a and c with one block each of "main"; c stops beating and is taken over with no confirm wait. */
async function takeoverOfC(onTombstone: (store: MemoryStore) => Promise<void>, onSleep: (store: MemoryStore) => Promise<void> = async () => {}) {
  const { store, registry, join, tableOf, map } = await world();
  await map("main", 2, 1);
  await join("a", "c");
  await new BlockTable(store).write("main", { epoch: 1, owners: { "0,0": { nodeId: "a", epoch: 1, since: 1 }, "1,0": { nodeId: "c", epoch: 1, since: 1 } } });
  const slept: Array<{ ms: number; owner: string | undefined }> = [];
  const coordinator = new Coordinator(store, new ClusterBus(store, "coord", TEST_BUS_KEY), {
    id: "coord",
    now: () => clock,
    deadConfirmMs: 0,
    sleep: async (ms) => {
      slept.push({ ms, owner: ownersOf(await tableOf("main"))["1,0"] });
      await onSleep(store);
    },
  });
  const set = store.set.bind(store);
  (store as any).set = async (key: string, value: string, ttlMs?: number) => {
    await set(key, value, ttlMs);
    if (key === deadKey("c")) await onTombstone(store);
  };
  const warned = spyOn(log, "warn").mockImplementation(() => {});
  quiet.push(warned);
  await coordinator.tick();
  for (let i = 0; i < 3; i++) {
    advance(1000);
    await registry.beat("a");
    await registry.beat("c");
    await coordinator.tick();
  }
  for (let i = 0; i < 10 && ownersOf(await tableOf("main"))["1,0"] === "c"; i++) {
    advance(1000);
    await registry.beat("a");
    await coordinator.tick();
    await settle();
  }
  return { slept, owner: ownersOf(await tableOf("main"))["1,0"], warned };
}

test("a beat of the dead run that lands after the takeover's read holds its blocks back until its lease has lapsed", async () => {
  // c's beat lands right after its tombstone was written.
  const { slept, owner, warned } = await takeoverOfC((store) => store.set("cells:alive:c", String(T0), ALIVE_TTL_MS));
  expect(slept).toEqual([{ ms: ALIVE_TTL_MS + LEASE_MARGIN_MS, owner: "c" }]);
  expect(owner).toBe("a");
  expect(warned.mock.calls.some(([line]) => String(line).includes("beat while it was taken over"))).toBe(true);
});

test("a coordinator that lost the lock during the wait sends no node-dead and sweeps nothing (review m1)", async () => {
  const sent: string[] = [];
  const toWorld = ClusterBus.prototype.toWorld;
  const told = spyOn(ClusterBus.prototype, "toWorld").mockImplementation(function (this: ClusterBus, kind: string, data: unknown) {
    sent.push(kind);
    return toWorld.call(this, kind, data);
  });
  quiet.push(told);
  const swept = spyOn(PlayerDirectory.prototype, "sweepNode");
  quiet.push(swept);
  // Another coordinator takes the lock (with no ttl, so it is not taken back) while this one waits out c's lease.
  const { slept, owner } = await takeoverOfC(
    (store) => store.set("cells:alive:c", String(T0), ALIVE_TTL_MS),
    (store) => store.set(LOCK_KEY, "other"),
  );
  expect(slept.length).toBe(1);
  expect(sent).not.toContain("node-dead");
  expect(swept).not.toHaveBeenCalled();
  expect(owner).toBe("c");
});

test("a takeover with no late beat gives the blocks out without waiting", async () => {
  const { slept, owner } = await takeoverOfC(async () => {});
  expect(slept).toEqual([]);
  expect(owner).toBe("a");
});
