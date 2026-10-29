import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { BlockTable, type MapBlocks } from "../cluster/blocks";
import { ClusterBus } from "../cluster/bus";
import { Coordinator, LOCK_KEY, deadKey, type CoordinatorOptions } from "../cluster/coordinator";
import { PlayerDirectory } from "../cluster/directory";
import { MapCatalogue, extentOf } from "../cluster/maps";
import { MemoryStore } from "../cluster/memorystore";
import { NodeRegistry, type NodeInfo } from "../cluster/nodes";
import log from "../modules/logger";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

const T0 = new Date("2026-10-21T12:00:00Z").getTime();
let clock = T0;
const advance = (ms: number) => {
  clock += ms;
  setSystemTime(new Date(clock));
};
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

const quiet: Array<{ mockRestore(): void }> = [];
// Stopped before the clock is reset, so nothing is heard on the wrong clock.
const buses: ClusterBus[] = [];
beforeEach(() => {
  clock = T0;
  setSystemTime(new Date(clock));
  quiet.push(
    spyOn(log, "success").mockImplementation(() => {}),
    spyOn(log, "info").mockImplementation(() => {}),
    spyOn(log, "warn").mockImplementation(() => {}),
    spyOn(log, "error").mockImplementation(() => {}),
  );
});
afterEach(async () => {
  await settle();
  for (const bus of buses.splice(0)) await bus.stop();
  setSystemTime();
  for (const spy of quiet.splice(0)) spy.mockRestore();
});

const info = (nodeId: string, startedAt = T0): NodeInfo => ({ nodeId, regionId: "eu", publicHost: `${nodeId}.example.com`, port: 3000, wtPort: 3002, useSSL: true, startedAt });
const owned = (nodeId: string) => ({ nodeId, epoch: 1, since: 1 });
const otherLock = JSON.stringify({ holder: "other", epoch: 999 });

// Three nodes on a map three blocks wide: a | c | b, with a listener for "node-dead".
async function bare(deadConfirmMs = 2000, options: CoordinatorOptions = {}) {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await new MapCatalogue(store).publish([extentOf("main", 3 * 4096, 4096)]);
  for (const id of ["a", "b", "c"]) await registry.announce(info(id));
  const beat = async (...ids: string[]) => { for (const id of ids) await registry.beat(id); };
  await new BlockTable(store).write("main", { epoch: 1, owners: { "0,0": owned("a"), "1,0": owned("c"), "2,0": owned("b") } });
  const make = (id: string) => new Coordinator(store, new ClusterBus(store, id, TEST_BUS_KEY), { id, now: () => clock, deadConfirmMs, ...options });
  const coordinator = make("coord");
  const heard: any[] = [];
  const listener = new ClusterBus(store, "a", TEST_BUS_KEY);
  listener.on("node-dead", (data) => { heard.push(data); });
  await listener.start();
  buses.push(listener);
  const tableOf = async (): Promise<MapBlocks> => JSON.parse((await store.get("cells:blocks:main"))!);
  const ownerOf = async (key = "1,0") => (await tableOf()).owners[key]?.nodeId;
  // One pass per second; a and b beat, c only when asked.
  const second = async (...also: string[]) => {
    advance(1000);
    await beat("a", "b", ...also);
    await coordinator.tick().catch(() => {});
    await settle();
  };
  return { store, registry, coordinator, make, heard, tableOf, ownerOf, second, beat };
}

// As bare, with the coordinator leading and its first hold over, having seen every node's run live. From here c
// stops beating: its beat runs out on the third pass.
async function world(deadConfirmMs = 2000, options: CoordinatorOptions = {}) {
  const it = await bare(deadConfirmMs, options);
  await it.beat("a", "b", "c");
  await it.coordinator.tick();
  for (let i = 0; i < 5; i++) await it.second("c");
  expect(it.coordinator.isLeader()).toBe(true);
  return it;
}

test("a dead node's block goes to a live neighbour once it is confirmed dead", async () => {
  const { tableOf, second } = await world();
  for (let i = 0; i < 3; i++) await second(); // c's beat runs out
  expect((await tableOf()).owners["1,0"]!.nodeId).toBe("c");
  for (let i = 0; i < 3; i++) await second();
  const table = await tableOf();
  expect(table.owners["1,0"]!.nodeId).toBe("a");
  expect(table.owners["1,0"]!.epoch).toBeGreaterThan(1);
  expect(table.epoch).toBeGreaterThan(1);
});

test("one pass with the node missing is not enough", async () => {
  const { ownerOf, second } = await world(0);
  for (let i = 0; i < 3; i++) await second();
  // With no wait, the first pass that sees c missing still does not take it over.
  expect(await ownerOf()).toBe("c");
  await second();
  expect(await ownerOf()).not.toBe("c");
});

test("passes alone are not enough before the wait is over", async () => {
  const { ownerOf, second } = await world(60_000);
  for (let i = 0; i < 20; i++) await second();
  expect(await ownerOf()).toBe("c");
});

test("the takeover leaves a tombstone with the node's start time", async () => {
  const { store, second } = await world();
  for (let i = 0; i < 6; i++) await second();
  const tombstone = JSON.parse((await store.get(deadKey("c")))!);
  expect(tombstone).toMatchObject({ nodeId: "c", startedAt: T0 });
});

test("the takeover clears the dead node's directory entries and tells the world", async () => {
  const { store, heard, second } = await world();
  await new PlayerDirectory(store, "c").claim("carol", "p1", "main");
  for (let i = 0; i < 6; i++) await second();
  expect(await new PlayerDirectory(store, "a").get("carol")).toBeNull();
  expect(heard).toEqual([{ nodeId: "c", startedAt: T0, restarted: false }]);
});

test("the dead node is forgotten, and told dead once", async () => {
  const { registry, heard, second } = await world();
  for (let i = 0; i < 10; i++) await second();
  expect(await registry.known()).not.toContain("c");
  expect(await registry.info("c")).toBeNull();
  expect(heard.length).toBe(1);
});

test("a node back before it is confirmed keeps its blocks", async () => {
  const { ownerOf, second, beat } = await world();
  for (let i = 0; i < 4; i++) await second();
  await beat("c");
  for (let i = 0; i < 10; i++) await second("c");
  expect(await ownerOf()).toBe("c");
});

test("a restarted node is told dead with its old start time, and keeps its blocks", async () => {
  const { registry, heard, ownerOf, coordinator, beat } = await world();
  await registry.announce(info("c", clock));
  await beat("a", "b", "c");
  await coordinator.tick();
  await settle();
  expect(heard).toEqual([{ nodeId: "c", startedAt: T0, restarted: true }]);
  expect(await ownerOf()).toBe("c");
});

test("a coordinator that is not the leader takes nothing over", async () => {
  const { store, ownerOf, second } = await world();
  // Another coordinator holds the lock.
  await store.set(LOCK_KEY, JSON.stringify({ holder: "other", epoch: 99 }), 60_000);
  for (let i = 0; i < 10; i++) await second();
  expect(await ownerOf()).toBe("c");
});

// C1: the run that is judged dead is the one last seen live, never a new run that has announced and not beaten yet.

async function expectRestartKept(it: Awaited<ReturnType<typeof world>>, newRun: number) {
  const { store, registry, heard, ownerOf, second } = it;
  // The new run loads for a while before its first beat.
  for (let i = 0; i < 10; i++) await second();
  expect(await ownerOf()).toBe("c");
  expect(await store.get(deadKey("c"))).toBeNull();
  expect(await registry.known()).toContain("c");
  expect(heard).toEqual([{ nodeId: "c", startedAt: T0, restarted: true }]);
  // Its first beat: it is live, and nothing more is told.
  for (let i = 0; i < 3; i++) await second("c");
  expect((await registry.live()).map((node) => node.nodeId)).toContain("c");
  expect((await registry.info("c"))!.startedAt).toBe(newRun);
  expect(await ownerOf()).toBe("c");
  expect(heard.length).toBe(1);
}

test("a node that crashed and restarts under the same id is told restarted, not taken over, while its new run boots", async () => {
  const it = await world();
  // The old run's beat runs out; the new run announces 4 s after the last beat, as the takeover comes due.
  for (let i = 0; i < 4; i++) await it.second();
  await it.registry.announce(info("c", clock));
  await expectRestartKept(it, clock);
});

test("a node that stops gracefully and restarts is told restarted, not taken over, while its new run boots", async () => {
  const it = await world();
  await it.second("c");
  // retire drops the beat at once.
  await it.registry.retire("c");
  for (let i = 0; i < 2; i++) await it.second();
  const newRun = clock + 500;
  await it.registry.announce(info("c", newRun));
  await expectRestartKept(it, newRun);
});

test("a new run that announces as the takeover runs is not tombstoned", async () => {
  const { store, registry, heard, ownerOf, second } = await world();
  for (let i = 0; i < 4; i++) await second();
  // The new run announces between this pass's read of the registry and the tombstone.
  const isAlive = NodeRegistry.prototype.isAlive;
  let armed = true;
  quiet.push(spyOn(NodeRegistry.prototype, "isAlive").mockImplementation(async function (this: NodeRegistry, nodeId: string) {
    if (armed && nodeId === "c") {
      armed = false;
      await registry.announce(info("c", clock));
    }
    return isAlive.call(this, nodeId);
  }));
  await second();
  expect(armed).toBe(false);
  expect(await store.get(deadKey("c"))).toBeNull();
  await second();
  expect(await store.get(deadKey("c"))).toBeNull();
  expect(await registry.known()).toContain("c");
  expect(await ownerOf()).toBe("c");
  expect(heard).toEqual([{ nodeId: "c", startedAt: T0, restarted: true }]);
});

// A cold start with the table kept (Redis persistence): the nodes come back as new runs, some slower than others.
async function coldStart(previousRuns: boolean) {
  const it = await bare();
  if (previousRuns) {
    // The run records of the cluster's last life, kept with the table.
    for (const id of ["a", "b", "c"]) await it.store.set(`cells:noderun:${id}`, JSON.stringify({ startedAt: T0 - 100_000, live: true }));
  }
  // Only a beats; b and c are still loading.
  await it.beat("a");
  const second = async () => {
    advance(1000);
    await it.beat("a");
    await it.coordinator.tick();
    await settle();
  };
  await it.coordinator.tick();
  return { ...it, second };
}

test("cold start with a kept table: runs not yet seen live keep their blocks while they boot", async () => {
  const { store, registry, heard, tableOf, second, beat } = await coldStart(false);
  for (let i = 0; i < 30; i++) await second();
  const owners = Object.fromEntries(Object.entries((await tableOf()).owners).map(([key, owner]) => [key, owner.nodeId]));
  expect(owners).toEqual({ "0,0": "a", "1,0": "c", "2,0": "b" });
  expect(await store.get(deadKey("b"))).toBeNull();
  expect(await store.get(deadKey("c"))).toBeNull();
  expect(heard).toEqual([]);
  await beat("b", "c");
  await second();
  expect((await registry.live()).map((node) => node.nodeId)).toEqual(["a", "b", "c"]);
});

test("cold start with the last life's run records: each old run is told dead once, and the blocks stay", async () => {
  const { registry, heard, tableOf, second, beat } = await coldStart(true);
  for (let i = 0; i < 30; i++) await second();
  expect(Object.values((await tableOf()).owners).map((owner) => owner.nodeId)).toEqual(["a", "c", "b"]);
  const told = [...heard].sort((x, y) => x.nodeId.localeCompare(y.nodeId));
  expect(told).toEqual(["a", "b", "c"].map((nodeId) => ({ nodeId, startedAt: T0 - 100_000, restarted: true })));
  await beat("b", "c");
  await second();
  expect((await registry.live()).length).toBe(3);
  expect(heard.length).toBe(3);
});

test("a run never seen live is taken over once the long grace is over", async () => {
  const { ownerOf, second } = await coldStart(false);
  for (let i = 0; i < 58; i++) await second();
  expect(await ownerOf()).toBe("c");
  for (let i = 0; i < 3; i++) await second();
  expect(await ownerOf()).toBe("a");
});

// I1: counts from an earlier spell as leader are dropped.

test("a coordinator that leads again starts its counts over, under the hold", async () => {
  const { store, ownerOf, second, coordinator } = await world();
  // c is counted missing in two passes.
  for (let i = 0; i < 4; i++) await second();
  expect(await ownerOf()).toBe("c");
  // Another coordinator leads for a minute while c beats; then c falls silent for 3 s (its beat runs out).
  await store.set(LOCK_KEY, otherLock, 120_000);
  for (let i = 0; i < 60; i++) await second("c");
  for (let i = 0; i < 3; i++) await second();
  expect(coordinator.isLeader()).toBe(false);
  // The other goes, and this one leads again: c's old count must not take it over at once.
  await store.del(LOCK_KEY);
  for (let i = 0; i < 4; i++) await second();
  expect(coordinator.isLeader()).toBe(true);
  expect(await ownerOf()).toBe("c");
  for (let i = 0; i < 2; i++) await second();
  expect(await ownerOf()).toBe("a");
});

// I2: liveness is read again right before the tombstone.

test("a beat that lands as the takeover runs stops it", async () => {
  const { store, registry, heard, ownerOf, second, beat } = await world();
  for (let i = 0; i < 4; i++) await second();
  const isAlive = NodeRegistry.prototype.isAlive;
  let armed = true;
  quiet.push(spyOn(NodeRegistry.prototype, "isAlive").mockImplementation(async function (this: NodeRegistry, nodeId: string) {
    if (armed && nodeId === "c") {
      armed = false;
      await beat("c");
    }
    return isAlive.call(this, nodeId);
  }));
  await second();
  expect(armed).toBe(false);
  for (let i = 0; i < 5; i++) await second("c");
  expect(await store.get(deadKey("c"))).toBeNull();
  expect(heard).toEqual([]);
  expect(await registry.known()).toContain("c");
  expect(await ownerOf()).toBe("c");
});

// I3: the restart notice is sent for sure.

test("a restart notice that could not be sent is sent on a later pass", async () => {
  const { registry, heard, ownerOf, second } = await world();
  const toWorld = ClusterBus.prototype.toWorld;
  let failures = 1;
  quiet.push(spyOn(ClusterBus.prototype, "toWorld").mockImplementation(async function (this: ClusterBus, kind: string, data: unknown) {
    if (kind === "node-dead" && failures > 0) {
      failures--;
      throw new Error("Redis lost");
    }
    return toWorld.call(this, kind, data);
  }));
  await registry.announce(info("c", clock));
  await second("c");
  expect(failures).toBe(0);
  expect(heard).toEqual([]);
  for (let i = 0; i < 2; i++) await second("c");
  expect(heard).toEqual([{ nodeId: "c", startedAt: T0, restarted: true }]);
  expect(await ownerOf()).toBe("c");
});

test("a restart during a coordinator failover is still told by the new leader", async () => {
  const { registry, heard, make, coordinator, beat } = await world();
  await coordinator.stop();
  // c restarts while no coordinator leads.
  await registry.announce(info("c", clock));
  await beat("a", "b", "c");
  const next = make("coord-b");
  await next.tick();
  await settle();
  expect(next.isLeader()).toBe(true);
  expect(heard).toEqual([{ nodeId: "c", startedAt: T0, restarted: true }]);
});

// I4: a lost lock or a lost table write stops the takeover.

test("a lock lost just before the tombstone stops the takeover", async () => {
  const { store, registry, heard, ownerOf, second } = await world();
  for (let i = 0; i < 4; i++) await second();
  const isAlive = NodeRegistry.prototype.isAlive;
  let armed = true;
  quiet.push(spyOn(NodeRegistry.prototype, "isAlive").mockImplementation(async function (this: NodeRegistry, nodeId: string) {
    if (armed && nodeId === "c") {
      armed = false;
      await store.set(LOCK_KEY, otherLock, 120_000);
    }
    return isAlive.call(this, nodeId);
  }));
  for (let i = 0; i < 5; i++) await second();
  expect(armed).toBe(false);
  expect(await store.get(deadKey("c"))).toBeNull();
  expect(heard).toEqual([]);
  expect(await registry.known()).toContain("c");
  expect(await ownerOf()).toBe("c");
});

test("a lock lost after the tombstone stops the table write, and the node is not forgotten", async () => {
  const { store, registry, ownerOf, second } = await world();
  for (let i = 0; i < 4; i++) await second();
  const set = store.set.bind(store);
  store.set = async (key: string, value: string, ttlMs?: number) => {
    await set(key, value, ttlMs);
    if (key === deadKey("c")) await set(LOCK_KEY, otherLock, 120_000);
  };
  for (let i = 0; i < 5; i++) await second();
  expect(await store.get(deadKey("c"))).not.toBeNull();
  expect(await ownerOf()).toBe("c");
  expect(await registry.known()).toContain("c");
});

test("a table write that loses keeps the node, and the takeover is finished on a later pass", async () => {
  const { store, registry, heard, ownerOf, second } = await world();
  for (let i = 0; i < 4; i++) await second();
  const nextEpoch = BlockTable.prototype.nextEpoch;
  let armed = true;
  quiet.push(spyOn(BlockTable.prototype, "nextEpoch").mockImplementation(async function (this: BlockTable, map: string, current: number) {
    if (armed) {
      armed = false;
      // Another write lands between the read and the write: same owners, a higher epoch.
      await store.set("cells:blocks:main", JSON.stringify({ epoch: 7, owners: { "0,0": owned("a"), "1,0": owned("c"), "2,0": owned("b") } }));
    }
    return nextEpoch.call(this, map, current);
  }));
  await second();
  expect(armed).toBe(false);
  expect(await ownerOf()).toBe("c");
  expect(await registry.known()).toContain("c");
  expect(await registry.info("c")).not.toBeNull();
  await second();
  expect(await ownerOf()).toBe("a");
  expect(await registry.known()).not.toContain("c");
  // Told twice: each step of a takeover may run twice (receivers are idempotent).
  expect(heard.length).toBe(2);
});

// I4: an outage inside a pass, with the lock renewal still fine.

function failMembers(store: MemoryStore): () => void {
  store.members = async () => { throw new Error("Redis lost"); };
  return () => { delete (store as any).members; };
}

test("a pass that fails part way, with the lock held, starts the hold", async () => {
  const { store, coordinator, ownerOf, second } = await world();
  for (let i = 0; i < 3; i++) await second(); // c counted missing once
  const back = failMembers(store);
  for (let i = 0; i < 2; i++) await second();
  back();
  expect(coordinator.isLeader()).toBe(true);
  // Without the hold, the first good pass would take c over (two passes, 3 s).
  for (let i = 0; i < 3; i++) await second();
  expect(await ownerOf()).toBe("c");
  for (let i = 0; i < 3; i++) await second();
  expect(await ownerOf()).toBe("a");
});

test("a pass that fails part way drops the absences counted before it", async () => {
  const { store, ownerOf, second } = await world(8000);
  for (let i = 0; i < 3; i++) await second(); // c first counted missing
  const back = failMembers(store);
  for (let i = 0; i < 6; i++) await second();
  back();
  // The count starts over at the first good pass: 8 s from it, not from before the failure.
  for (let i = 0; i < 7; i++) await second();
  expect(await ownerOf()).toBe("c");
  for (let i = 0; i < 2; i++) await second();
  expect(await ownerOf()).toBe("a");
});

// M2, M3.

test("a table that cannot be read holds the takeover back; it is finished once the table reads again", async () => {
  const { store, registry, ownerOf, second } = await world();
  await new MapCatalogue(store).publish([extentOf("cave", 4096, 4096)]);
  await store.set("cells:blocks:cave", "{ not json");
  for (let i = 0; i < 10; i++) await second();
  expect(await ownerOf()).toBe("c");
  expect(await registry.known()).toContain("c");
  expect(await store.get(deadKey("c"))).toBeNull();
  await store.set("cells:blocks:cave", JSON.stringify({ epoch: 1, owners: { "0,0": owned("c") } }));
  for (let i = 0; i < 2; i++) await second();
  expect(await ownerOf()).toBe("a");
  expect(JSON.parse((await store.get("cells:blocks:cave"))!).owners["0,0"].nodeId).not.toBe("c");
  expect(await registry.known()).not.toContain("c");
});

test("a takeover cut short after its last table write is finished by forgetting the node", async () => {
  const { registry, ownerOf, second } = await world();
  for (let i = 0; i < 4; i++) await second();
  const forgetRun = NodeRegistry.prototype.forgetRun;
  let armed = true;
  quiet.push(spyOn(NodeRegistry.prototype, "forgetRun").mockImplementation(async function (this: NodeRegistry, nodeId: string, startedAt: number) {
    if (armed) {
      armed = false;
      throw new Error("Redis lost");
    }
    return forgetRun.call(this, nodeId, startedAt);
  }));
  await second();
  expect(armed).toBe(false);
  expect(await ownerOf()).toBe("a");
  expect(await registry.known()).toContain("c");
  await second();
  expect(await registry.known()).not.toContain("c");
  expect(await registry.info("c")).toBeNull();
});

// I-A: only the run judged dead is forgotten; a new run that announces while it is taken over is kept.

// The takeover of c comes due on the next pass; `arm` makes the new run announce at some point in it.
async function newRunDuringTakeover(arm: (announce: () => Promise<void>) => { fired(): boolean }) {
  const it = await world();
  const { store, registry, heard, ownerOf, second } = it;
  for (let i = 0; i < 4; i++) await second();
  const newRun = clock;
  const trap = arm(() => registry.announce(info("c", newRun)));
  await second();
  expect(trap.fired()).toBe(true);
  // The old run is ended: its tombstone and notice name it, and its block is given away.
  expect(JSON.parse((await store.get(deadKey("c")))!)).toMatchObject({ nodeId: "c", startedAt: T0 });
  expect(heard).toEqual([{ nodeId: "c", startedAt: T0, restarted: false }]);
  expect(await ownerOf()).toBe("a");
  // The new run is still announced.
  expect(await registry.known()).toContain("c");
  expect((await registry.info("c"))!.startedAt).toBe(newRun);
  for (let i = 0; i < 3; i++) await second();
  expect(await registry.known()).toContain("c");
  // Its first beats make it live, and nothing more is told.
  for (let i = 0; i < 3; i++) await second("c");
  expect((await registry.live()).map((node) => node.nodeId)).toContain("c");
  expect(JSON.parse((await store.get("cells:noderun:c"))!)).toEqual({ startedAt: newRun, live: true });
  expect(JSON.parse((await store.get(deadKey("c")))!).startedAt).toBe(T0);
  expect(heard.length).toBe(1);
}

test("a new run that announces during the directory sweep is kept, and the tombstone names the old run", async () => {
  await newRunDuringTakeover((announce) => {
    const sweepNode = PlayerDirectory.prototype.sweepNode;
    let armed = true;
    quiet.push(spyOn(PlayerDirectory.prototype, "sweepNode").mockImplementation(async function (this: PlayerDirectory, nodeId: string) {
      if (armed && nodeId === "c") {
        armed = false;
        await announce();
      }
      return sweepNode.call(this, nodeId);
    }));
    return { fired: () => !armed };
  });
});

test("a new run that announces right after the takeover's own check is kept, and the tombstone names the old run", async () => {
  await newRunDuringTakeover((announce) => {
    // The takeover reads c's beat, then c's run: the new run lands just after that read, before the tombstone.
    const isAlive = NodeRegistry.prototype.isAlive;
    const infoOf = NodeRegistry.prototype.info;
    let state: "waiting" | "checking" | "fired" = "waiting";
    quiet.push(
      spyOn(NodeRegistry.prototype, "isAlive").mockImplementation(async function (this: NodeRegistry, nodeId: string) {
        if (state === "waiting" && nodeId === "c") state = "checking";
        return isAlive.call(this, nodeId);
      }),
      spyOn(NodeRegistry.prototype, "info").mockImplementation(async function (this: NodeRegistry, nodeId: string) {
        const read = await infoOf.call(this, nodeId);
        if (state === "checking" && nodeId === "c") {
          state = "fired";
          await announce();
        }
        return read;
      }),
    );
    return { fired: () => state === "fired" };
  });
});

test("forgetRun forgets the run it names, and leaves a newer run alone", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(info("c", T0));
  await registry.beat("c");
  // A newer run's announcement is not taken, not even for a moment.
  const taken: string[] = [];
  const take = store.take.bind(store);
  store.take = async (key: string) => {
    taken.push(key);
    return take(key);
  };
  expect(await registry.forgetRun("c", T0 + 1)).toBe(false);
  expect(taken).toEqual([]);
  expect(await registry.known()).toEqual(["c"]);
  expect(await registry.isAlive("c")).toBe(true);
  expect(await registry.forgetRun("c", T0)).toBe(true);
  expect(await registry.known()).toEqual([]);
  expect(await registry.info("c")).toBeNull();
  expect(await registry.isAlive("c")).toBe(false);
});

test("forgetRun keeps a new run that announces between its read and its take", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(info("c", T0));
  const take = store.take.bind(store);
  let armed = true;
  store.take = async (key: string) => {
    if (armed && key === "cells:nodeinfo:c") {
      armed = false;
      await registry.announce(info("c", T0 + 5000));
    }
    return take(key);
  };
  expect(await registry.forgetRun("c", T0)).toBe(false);
  expect(armed).toBe(false);
  expect(await registry.known()).toEqual(["c"]);
  expect((await registry.info("c"))!.startedAt).toBe(T0 + 5000);
});

test("forgetRun puts a new run's announcement back even when the first put-back fails", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(info("c", T0));
  const take = store.take.bind(store);
  const set = store.set.bind(store);
  let state: "waiting" | "taken" | "failed" = "waiting";
  store.take = async (key: string) => {
    if (state === "waiting" && key === "cells:nodeinfo:c") {
      await registry.announce(info("c", T0 + 5000));
      state = "taken";
    }
    return take(key);
  };
  store.set = async (key: string, value: string, ttlMs?: number) => {
    if (state === "taken" && key === "cells:nodeinfo:c") {
      state = "failed";
      throw new Error("Redis lost");
    }
    return set(key, value, ttlMs);
  };
  expect(await registry.forgetRun("c", T0)).toBe(false);
  expect(state as string).toBe("failed");
  expect(await registry.known()).toEqual(["c"]);
  expect((await registry.info("c"))!.startedAt).toBe(T0 + 5000);
});

test("forgetRun keeps a new run that announces after its take", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(info("c", T0));
  const removeFromSet = store.removeFromSet.bind(store);
  let armed = true;
  store.removeFromSet = async (key: string, member: string) => {
    if (armed && member === "c") {
      armed = false;
      await registry.announce(info("c", T0 + 5000));
    }
    return removeFromSet(key, member);
  };
  expect(await registry.forgetRun("c", T0)).toBe(false);
  expect(armed).toBe(false);
  expect(await registry.known()).toEqual(["c"]);
  expect((await registry.info("c"))!.startedAt).toBe(T0 + 5000);
});

// I-C: the takeover's directory sweep clears only the dead run's logins; a login the new run takes meanwhile stays.

// c's old run held carol and dave; its takeover comes due on the next pass. `boot` is the new run starting as
// index.ts does it (optionally clearing what its last run left, then announce, beat) and taking carol's login.
async function claimsDuringSweep() {
  const it = await world();
  const { store, registry } = it;
  const old = new PlayerDirectory(store, "c");
  await old.claim("carol", "p1", "main");
  await old.claim("dave", "p2", "main");
  for (let i = 0; i < 4; i++) await it.second();
  const newRun = clock;
  const boot = async (sweepFirst: boolean) => {
    const own = new PlayerDirectory(store, "c");
    if (sweepFirst) await own.sweepNode("c");
    await registry.announce(info("c", newRun));
    await registry.beat("c");
    return (await own.claim("carol", "p9", "main")).entry;
  };
  // Marks the takeover's sweep (the one that asks whether the run is still dead).
  let sweeping = false;
  const sweepNode = PlayerDirectory.prototype.sweepNode;
  quiet.push(spyOn(PlayerDirectory.prototype, "sweepNode").mockImplementation(async function (this: PlayerDirectory, nodeId: string, stillDead?: () => Promise<boolean>) {
    if (!stillDead) return sweepNode.call(this, nodeId);
    sweeping = true;
    try {
      return await sweepNode.call(this, nodeId, stillDead);
    } finally {
      sweeping = false;
    }
  }));
  return { ...it, boot, isSweeping: () => sweeping };
}

// The old run is ended, its other login is gone, and carol is held once: by the new run, where a second login of
// hers elsewhere finds her and kicks her.
async function expectNewClaimKept(it: Awaited<ReturnType<typeof claimsDuringSweep>>, entry: { nodeId: string; epoch: number }) {
  const { store, registry, ownerOf, second } = it;
  expect(JSON.parse((await store.get(deadKey("c")))!).startedAt).toBe(T0);
  expect(await ownerOf()).toBe("a");
  expect(await new PlayerDirectory(store, "a").get("carol")).toEqual(entry as any);
  expect(await new PlayerDirectory(store, "a").get("dave")).toBeNull();
  expect(await store.members("cells:dirnode:c")).toContain("carol");
  for (let i = 0; i < 3; i++) await second("c");
  expect((await registry.live()).map((node) => node.nodeId)).toContain("c");
  expect(await new PlayerDirectory(store, "a").get("carol")).toEqual(entry as any);
  const again = await new PlayerDirectory(store, "a").claim("carol", "p3", "main");
  expect(again.previous).toEqual(entry as any);
}

test("a login the new run takes before the sweep reads it stays", async () => {
  const it = await claimsDuringSweep();
  const get = it.store.get.bind(it.store);
  let armed = true;
  let entry: any = null;
  it.store.get = async (key: string) => {
    if (armed && it.isSweeping() && key === "cells:dir:carol") {
      armed = false;
      entry = await it.boot(true);
    }
    return get(key);
  };
  await it.second();
  expect(armed).toBe(false);
  await expectNewClaimKept(it, entry);
});

test("a login the new run takes after the sweep's check stays", async () => {
  const it = await claimsDuringSweep();
  const infoOf = NodeRegistry.prototype.info;
  let armed = true;
  let entry: any = null;
  quiet.push(spyOn(NodeRegistry.prototype, "info").mockImplementation(async function (this: NodeRegistry, nodeId: string) {
    const read = await infoOf.call(this, nodeId);
    if (armed && it.isSweeping() && nodeId === "c") {
      armed = false;
      entry = await it.boot(false);
    }
    return read;
  }));
  await it.second();
  expect(armed).toBe(false);
  await expectNewClaimKept(it, entry);
});

test("a login the new run takes right after the sweep deletes the old one stays in the node's set", async () => {
  const it = await claimsDuringSweep();
  const deleteIfEpoch = it.store.deleteIfEpoch.bind(it.store);
  let armed = true;
  let entry: any = null;
  it.store.deleteIfEpoch = async (key: string, epoch: number) => {
    const deleted = await deleteIfEpoch(key, epoch);
    if (armed && deleted && it.isSweeping() && key === "cells:dir:carol") {
      armed = false;
      entry = await it.boot(false);
    }
    return deleted;
  };
  await it.second();
  expect(armed).toBe(false);
  await expectNewClaimKept(it, entry);
});

// I-B: a restart notice is never sent from a view older than the run record.

test("a coordinator that leads again with a stale view does not tell the current run dead", async () => {
  const { store, registry, heard, coordinator, second } = await world();
  // Another coordinator leads; c restarts as R1, which that leader recorded but has not seen beat yet.
  await store.set(LOCK_KEY, otherLock, 120_000);
  await second("c");
  expect(coordinator.isLeader()).toBe(false);
  const newRun = clock;
  await registry.announce(info("c", newRun));
  await store.set("cells:noderun:c", JSON.stringify({ startedAt: newRun, live: false }));
  // This coordinator leads again, and its first read of the live nodes still shows c's old run.
  const live = NodeRegistry.prototype.live;
  let stale = true;
  quiet.push(spyOn(NodeRegistry.prototype, "live").mockImplementation(async function (this: NodeRegistry) {
    const nodes = await live.call(this);
    if (!stale) return nodes;
    const others = nodes.filter((node) => node.nodeId !== "c");
    return [...others, info("c", T0)].sort((x, y) => x.nodeId.localeCompare(y.nodeId));
  }));
  await store.del(LOCK_KEY);
  await second();
  expect(coordinator.isLeader()).toBe(true);
  stale = false;
  expect(heard.filter((message) => message.startedAt === newRun)).toEqual([]);
  expect(JSON.parse((await store.get("cells:noderun:c"))!)).toEqual({ startedAt: newRun, live: false });
  // R1's first beat: it is recorded live, and nothing is told.
  for (let i = 0; i < 2; i++) await second("c");
  expect(JSON.parse((await store.get("cells:noderun:c"))!)).toEqual({ startedAt: newRun, live: true });
  expect(heard).toEqual([]);
});

test("a coordinator that loses the lock as it sees a restart does not tell it", async () => {
  const { store, registry, heard, second } = await world();
  const newRun = clock;
  await registry.announce(info("c", newRun));
  // The lock goes to another coordinator right after this pass reads the live nodes.
  const live = NodeRegistry.prototype.live;
  let armed = true;
  quiet.push(spyOn(NodeRegistry.prototype, "live").mockImplementation(async function (this: NodeRegistry) {
    const nodes = await live.call(this);
    if (armed) {
      armed = false;
      await store.set(LOCK_KEY, otherLock, 120_000);
    }
    return nodes;
  }));
  await second("c");
  expect(armed).toBe(false);
  expect(heard).toEqual([]);
  expect(JSON.parse((await store.get("cells:noderun:c"))!)).toEqual({ startedAt: T0, live: true });
});

// M-a: a run is recorded live only on a beat that names it.

test("a beat from a node of the older release (it does not name its run) still counts as the run's own", async () => {
  const { store, registry, heard, second } = await world();
  const newRun = clock;
  await registry.announce(info("c", newRun));
  await store.set("cells:alive:c", "1", 3000);
  await second();
  expect(JSON.parse((await store.get("cells:noderun:c"))!)).toEqual({ startedAt: newRun, live: true });
  expect(heard).toEqual([{ nodeId: "c", startedAt: T0, restarted: true }]);
});

test("a new run seen only through the old run's beat is judged as never seen live", async () => {
  const { store, registry, heard, ownerOf, second } = await world();
  // c's last beat was one pass ago; the new run announces with that beat about 2 s from running out.
  await second();
  const newRun = clock;
  await registry.announce(info("c", newRun));
  await second();
  expect(JSON.parse((await store.get("cells:noderun:c"))!)).toEqual({ startedAt: newRun, live: false });
  // It does not beat for 12 s.
  for (let i = 0; i < 12; i++) await second();
  expect(await store.get(deadKey("c"))).toBeNull();
  expect(await ownerOf()).toBe("c");
  expect(await registry.known()).toContain("c");
  expect(heard).toEqual([{ nodeId: "c", startedAt: T0, restarted: true }]);
  await second("c");
  expect(JSON.parse((await store.get("cells:noderun:c"))!)).toEqual({ startedAt: newRun, live: true });
});

// C9: a store outage does not count as death.

// Every store call fails until the returned function brings the store back (a Redis outage).
const STORE_CALLS = [
  "get", "set", "setIfAbsent", "del", "take", "incrBy", "swapIfEpoch", "deleteIfEpoch", "renewIfEpoch",
  "addToSet", "removeFromSet", "members", "expire", "publish", "subscribe", "unsubscribe",
] as const;
function outage(store: MemoryStore): () => void {
  for (const name of STORE_CALLS) (store as any)[name] = async () => { throw new Error("Redis lost"); };
  return () => { for (const name of STORE_CALLS) delete (store as any)[name]; };
}

// The store is gone for 8 passes, long enough for every beat and the lock to run out. It comes back with no node
// live: a and b beat at once, c is slow.
async function afterOutage() {
  const it = await world();
  const back = outage(it.store);
  for (let i = 0; i < 8; i++) {
    advance(1000);
    await it.coordinator.tick();
  }
  expect(it.coordinator.isLeader()).toBe(false);
  back();
  expect(await it.ownerOf()).toBe("c");
  return it;
}

test("after a store outage, a slow node that beats again within the beat's ttl plus two passes keeps its blocks", async () => {
  const { ownerOf, second, beat, heard } = await afterOutage();
  // The first four passes after the store is back see c missing: without the hold, the third would take it over.
  for (let i = 0; i < 4; i++) await second();
  expect(await ownerOf()).toBe("c");
  // c beats again, 4 s after the store came back.
  await beat("c");
  for (let i = 0; i < 10; i++) await second("c");
  expect(await ownerOf()).toBe("c");
  expect(heard).toEqual([]);
});

test("after a store outage, a node that stays gone is taken over once the hold is over", async () => {
  const { store, ownerOf, second, heard } = await afterOutage();
  // The hold: the beat's ttl (3 s) plus two passes (2 s) from the first pass after the store came back.
  for (let i = 0; i < 5; i++) await second();
  expect(await ownerOf()).toBe("c");
  await second();
  expect(await ownerOf()).toBe("a");
  expect(await store.get(deadKey("c"))).not.toBeNull();
  expect(heard).toEqual([{ nodeId: "c", startedAt: T0, restarted: false }]);
});

test("the hold lasts at least two passes, however slow the passes are", async () => {
  // A lock that outlives the slow passes below, so the lead is not lost (and the hold not started again) between them.
  const { store, coordinator, beat, ownerOf } = await world(2000, { lockTtlMs: 30_000 });
  const back = outage(store);
  for (let i = 0; i < 8; i++) {
    advance(1000);
    await coordinator.tick();
  }
  back();
  const slow = async () => {
    advance(6000);
    await beat("a", "b");
    await coordinator.tick();
    await settle();
  };
  await slow(); // the hold starts
  await slow(); // more than its time, but only one pass
  expect(await ownerOf()).toBe("c");
  await slow();
  expect(await ownerOf()).toBe("a");
});
