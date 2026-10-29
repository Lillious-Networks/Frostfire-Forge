import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { deadKey } from "../cluster/coordinator";
import { Ghosts, type GhostKind } from "../cluster/ghosts";
import { MemoryStore } from "../cluster/memorystore";
import { ALIVE_TTL_MS, LEASE_MARGIN_MS, NodeRegistry, tombstoneKey, type NodeInfo } from "../cluster/nodes";
import { HANDLED_KEEP, NodeDeath, RETRY_LIMIT, type NodeDeathDeps } from "../cluster/nodedeath";
import log from "../modules/logger";
import { linkMesh, settle } from "./cluster-fakelink";

const STARTED = 1_000;
const TEST_BUS_KEY = "test-bus-key";

let warnings: string[];
let errors: string[];
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  warnings = [];
  errors = [];
  spies.push(
    spyOn(log, "warn").mockImplementation((message: string) => { warnings.push(String(message)); }),
    spyOn(log, "error").mockImplementation((message: string) => { errors.push(String(message)); }),
  );
});
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

// A death notice is acted on only when the coordinator's tombstone names that run, and a restart notice only when the
// node announced a later run (security review M1): these write what the coordinator and the new run would have.
async function buried(store: MemoryStore, nodeId: string, startedAt: number): Promise<MemoryStore> {
  await store.set(deadKey(nodeId), JSON.stringify({ nodeId, startedAt, at: 1 }));
  return store;
}
async function announced(store: MemoryStore, nodeId: string, startedAt: number): Promise<MemoryStore> {
  await store.set(`cells:nodeinfo:${nodeId}`, JSON.stringify({ nodeId, startedAt }));
  return store;
}

function fakeDeps(over: Partial<NodeDeathDeps> = {}) {
  const calls: string[] = [];
  const deps: NodeDeathDeps = {
    self: "a",
    startedAt: STARTED,
    dropMirrors: (peer) => { calls.push(`mirrors:${peer}`); return 2; },
    releaseAwayHeldBy: (peer) => { calls.push(`away:${peer}`); return 1; },
    dropForeignFrom: (home) => { calls.push(`foreign:${home}`); return 3; },
    fence: (why) => { calls.push(`fence:${why}`); },
    ...over,
  };
  return { deps, calls };
}

test("a dead peer's mirrors, away slots and foreign creatures go, once per run", async () => {
  const store = new MemoryStore();
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(store, deps);
  const bus = new ClusterBus(store, "a", TEST_BUS_KEY);
  death.attach(bus);
  await bus.start();
  const coordinator = new ClusterBus(store, "coord", TEST_BUS_KEY);
  await buried(store, "c", 5);
  await coordinator.toWorld("node-dead", { nodeId: "c", startedAt: 5, restarted: false });
  await settle();
  expect(calls).toEqual(["mirrors:c", "away:c", "foreign:c"]);
  // A takeover cut short and run again tells the world again: the second message changes nothing.
  await coordinator.toWorld("node-dead", { nodeId: "c", startedAt: 5, restarted: false });
  await settle();
  expect(calls.length).toBe(3);
  expect(warnings.filter((w) => w.includes("Node c is dead")).length).toBe(1);
  expect(warnings.some((w) => w.includes("Node c is dead: 2 mirror(s), 1 away slot(s) and 3 foreign creature(s) dropped"))).toBe(true);
});

test("a second node-dead for one run changes nothing, however many come", async () => {
  const { deps, calls } = fakeDeps();
  const store = await buried(new MemoryStore(), "c", 5);
  const death = new NodeDeath(store, deps);
  for (let i = 0; i < 5; i++) await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  // Guard: the handled set. Without it each repeat drops, releases and logs again.
  expect(calls).toEqual(["mirrors:c", "away:c", "foreign:c"]);
  // A later run of the same id is a new run and is handled.
  await buried(store, "c", 6);
  await death.onNodeDead({ nodeId: "c", startedAt: 6, restarted: false });
  expect(calls.length).toBe(6);
});

test("a death notice that follows the restart notice for the same run is handled as a restart, once", async () => {
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(await announced(new MemoryStore(), "c", 9), deps);
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: true });
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: true });
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  // Guard: the record of runs told restarted. A restart notice means a newer run is live: releasing its away
  // slots would put a creature the new run holds in the world twice.
  expect(calls).toEqual(["foreign:c"]);
});

test("a death notice for a run whose node announced a newer run is handled as a restart", async () => {
  const store = await buried(new MemoryStore(), "c", 5);
  await store.set("cells:nodeinfo:c", JSON.stringify({ nodeId: "c", startedAt: 9 }));
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(store, deps);
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: true });
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  expect(calls).toEqual(["foreign:c"]);
  // Without a restart notice first, the nodeinfo read alone downgrades it.
  const second = fakeDeps();
  await new NodeDeath(store, second.deps).onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  // Guard: the nodeinfo read. Without it the new run's mirrors are dropped here and its away slots released.
  expect(second.calls).toEqual(["foreign:c"]);
  // The announcement names the dead run itself: handled in full. So is a node already forgotten.
  await store.set("cells:nodeinfo:c", JSON.stringify({ nodeId: "c", startedAt: 5 }));
  const third = fakeDeps();
  await new NodeDeath(store, third.deps).onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  expect(third.calls).toEqual(["mirrors:c", "away:c", "foreign:c"]);
  await store.del("cells:nodeinfo:c");
  const fourth = fakeDeps();
  await new NodeDeath(store, fourth.deps).onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  expect(fourth.calls).toEqual(["mirrors:c", "away:c", "foreign:c"]);
});

test("two death notices at once for one run are handled once", async () => {
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(await buried(new MemoryStore(), "c", 5), deps);
  const notice = { nodeId: "c", startedAt: 5, restarted: false };
  await Promise.all([death.onNodeDead(notice), death.onNodeDead(notice), death.onNodeDead(notice)]);
  expect(calls).toEqual(["mirrors:c", "away:c", "foreign:c"]);
});

test("a nodeinfo that cannot be read is retried, and then handled in full", async () => {
  const store = await buried(new MemoryStore(), "c", 5);
  const get = store.get.bind(store);
  let broken = true;
  store.get = async (key: string) => {
    if (broken && key === "cells:nodeinfo:c") throw new Error("Redis lost");
    return get(key);
  };
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(store, deps);
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  // Not known whether a newer run is live: the mirrors and away slots wait, the creatures it sent here go now.
  expect(calls).toEqual(["foreign:c"]);
  broken = false;
  await death.retry();
  expect(calls).toEqual(["foreign:c", "mirrors:c", "away:c"]);
  await death.retry();
  expect(calls.length).toBe(3);
});

test("N2: a nodeinfo that stays unreadable never costs the foreign creatures, nor the notice", async () => {
  const store = await buried(new MemoryStore(), "c", 5);
  const get = store.get.bind(store);
  let broken = true;
  store.get = async (key: string) => {
    if (broken && key === "cells:nodeinfo:c") throw new Error("Redis lost");
    return get(key);
  };
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(store, deps);
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  for (let i = 0; i < RETRY_LIMIT + 3; i++) await death.retry();
  // Guard: foreign runs whatever the read does. Without it the creatures stay here while their slots respawn on the new owner.
  expect(calls).toEqual(["foreign:c"]);
  // Guard: a failing read is no step failure. Counted, the notice is given up and a resent one is ignored.
  expect(errors.some((e) => e.includes("Gave up"))).toBe(false);
  expect(errors.filter((e) => e.includes("Reading the announcement of node c failed")).length).toBe(1);
  broken = false;
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  expect(calls).toEqual(["foreign:c", "mirrors:c", "away:c"]);
  await death.retry();
  expect(calls.length).toBe(3);
});

test("a nodeinfo that cannot be parsed counts as none: the notice is handled in full, not left waiting", async () => {
  const store = await buried(new MemoryStore(), "c", 5);
  await store.set("cells:nodeinfo:c", "not json");
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(store, deps);
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  // Guard: the parse is apart from the read. Inside it, a bad record is an outage and the notice waits for ever.
  expect([...calls].sort()).toEqual(["away:c", "foreign:c", "mirrors:c"]);
});

test("a notice a resent copy finished during a retry pass is not run again by that pass", async () => {
  const store = await buried(await buried(new MemoryStore(), "d", 6), "c", 5);
  const get = store.get.bind(store);
  let broken = true;
  let hold: Promise<void> | null = null;
  let release = () => {};
  store.get = async (key: string) => {
    if (broken && key.startsWith("cells:nodeinfo:")) throw new Error("Redis lost");
    if (hold && key === "cells:nodeinfo:c") await hold;
    return get(key);
  };
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(store, deps);
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  await death.onNodeDead({ nodeId: "d", startedAt: 6, restarted: false });
  broken = false;
  hold = new Promise((resolve) => { release = resolve; });
  const pass = death.retry();
  // While the pass waits on c, a resent notice for d finishes it.
  await death.onNodeDead({ nodeId: "d", startedAt: 6, restarted: false });
  release();
  await pass;
  // Guard: the pass skips a notice it no longer holds. Without it d's old steps run a second time.
  expect(calls.filter((c) => c === "away:d").length).toBe(1);
  expect(calls.filter((c) => c === "mirrors:d").length).toBe(1);
  expect(calls.filter((c) => c === "away:c").length).toBe(1);
});

test("N2: an unreadable nodeinfo then a newer run: the mirrors and away slots are never touched", async () => {
  const store = await buried(new MemoryStore(), "c", 5);
  const get = store.get.bind(store);
  let broken = true;
  store.get = async (key: string) => {
    if (broken && key === "cells:nodeinfo:c") throw new Error("Redis lost");
    return get(key);
  };
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(store, deps);
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  broken = false;
  await store.set("cells:nodeinfo:c", JSON.stringify({ nodeId: "c", startedAt: 9 }));
  await death.retry();
  expect(calls).toEqual(["foreign:c"]);
  await death.retry();
  expect(calls).toEqual(["foreign:c"]);
});

test("a step that failed is tried again for that run only, and then not again", async () => {
  let broken = true;
  const calls: string[] = [];
  const { deps } = fakeDeps({
    dropMirrors: () => {
      if (broken) throw new Error("boom");
      calls.push("mirrors:c");
      return 2;
    },
    releaseAwayHeldBy: () => { calls.push("away:c"); return 0; },
    dropForeignFrom: () => { calls.push("foreign:c"); return 0; },
  });
  const death = new NodeDeath(await buried(new MemoryStore(), "c", 5), deps);
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  expect(calls).toEqual(["away:c", "foreign:c"]);
  broken = false;
  await death.retry();
  // Only the step that failed: away slots are not released twice.
  expect(calls).toEqual(["away:c", "foreign:c", "mirrors:c"]);
  await death.retry();
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  expect(calls.length).toBe(3);
});

test("a step that keeps failing is tried a bounded number of times, and each failure is logged", async () => {
  let tries = 0;
  const { deps } = fakeDeps({ dropMirrors: () => { tries++; throw new Error("boom"); } });
  const death = new NodeDeath(await buried(new MemoryStore(), "c", 5), deps);
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  for (let i = 0; i < RETRY_LIMIT + 3; i++) await death.retry();
  expect(tries).toBe(RETRY_LIMIT + 1);
  expect(errors.filter((e) => e.includes("Dropping the mirrors of dead node c failed")).length).toBe(RETRY_LIMIT + 1);
  expect(errors.some((e) => e.includes("Gave up on the steps of node-dead for c run 5"))).toBe(true);
});

test("the interval retries a step that failed", async () => {
  let broken = true;
  const calls: string[] = [];
  const { deps } = fakeDeps({ dropMirrors: () => { if (broken) throw new Error("boom"); calls.push("mirrors:c"); return 1; } });
  const death = new NodeDeath(await buried(new MemoryStore(), "c", 5), deps);
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  broken = false;
  const stop = death.start(5);
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
  } finally {
    stop();
  }
  expect(calls).toEqual(["mirrors:c"]);
});

test("the handled runs are bounded: the oldest is forgotten, the newest is not", async () => {
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(await announced(new MemoryStore(), "c", HANDLED_KEEP + 100), deps);
  for (let run = 0; run <= HANDLED_KEEP; run++) await death.onNodeDead({ nodeId: "c", startedAt: run, restarted: true });
  expect(calls.length).toBe(HANDLED_KEEP + 1);
  await death.onNodeDead({ nodeId: "c", startedAt: HANDLED_KEEP, restarted: true });
  expect(calls.length).toBe(HANDLED_KEEP + 1);
  // Guard: the eviction. Without it the set grows for as long as the node runs.
  await death.onNodeDead({ nodeId: "c", startedAt: 0, restarted: true });
  expect(calls.length).toBe(HANDLED_KEEP + 2);
});

test("a restarted peer loses only its foreign creatures here", async () => {
  const { deps, calls } = fakeDeps();
  await new NodeDeath(await announced(new MemoryStore(), "c", 9), deps).onNodeDead({ nodeId: "c", startedAt: 5, restarted: true });
  // Guard: the restarted check. Without it an away slot the new run holds by a fresh handoff is respawned
  // here as well, and its creature exists twice.
  expect(calls).toEqual(["foreign:c"]);
});

test("a node-dead naming this run fences; one naming an older run does not", async () => {
  const older = fakeDeps();
  await new NodeDeath(new MemoryStore(), older.deps).onNodeDead({ nodeId: "a", startedAt: STARTED - 1, restarted: false });
  // Guard: startedAt === deps.startedAt. Without it a node restarted under its old id fences on its last run's death.
  expect(older.calls).toEqual([]);
  const own = fakeDeps();
  const death = new NodeDeath(await buried(new MemoryStore(), "a", STARTED), own.deps);
  await death.onNodeDead({ nodeId: "a", startedAt: STARTED, restarted: false });
  expect(own.calls).toEqual(["fence:the coordinator took this node's blocks"]);
  expect(death.isFenced()).toBe(true);
});

test("the restart message about this node's last run never fences it", async () => {
  const { deps, calls } = fakeDeps();
  await new NodeDeath(new MemoryStore(), deps).onNodeDead({ nodeId: "a", startedAt: STARTED, restarted: true });
  expect(calls).toEqual([]);
});

test("a tombstone of this run fences, once; one of an older run does not", async () => {
  const store = new MemoryStore();
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(store, deps);
  expect(await death.check()).toBe(false);
  await store.set(deadKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED - 1, at: 9 }));
  // Guard: the tombstone's startedAt check. A tombstone lives 10 minutes; a quick restart must not die of it.
  expect(await death.check()).toBe(false);
  await store.set(deadKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED, at: 9 }));
  expect(await death.check()).toBe(true);
  expect(await death.check()).toBe(true);
  // Guard: the fenced flag. fence kicks every player and exits: it must not run twice.
  expect(calls).toEqual(["fence:this node's tombstone was found"]);
});

test("a malformed tombstone or message is ignored", async () => {
  const store = new MemoryStore();
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(store, deps);
  await store.set(deadKey("a"), "not json");
  expect(await death.check()).toBe(false);
  await death.onNodeDead(null);
  await death.onNodeDead({ nodeId: "", startedAt: 1, restarted: false });
  await death.onNodeDead({ nodeId: "c", startedAt: "1", restarted: false });
  expect(calls).toEqual([]);
});

test("one failing step does not stop the others", async () => {
  const { deps, calls } = fakeDeps({ dropMirrors: () => { throw new Error("boom"); } });
  await new NodeDeath(await buried(new MemoryStore(), "c", 5), deps).onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  expect(calls).toEqual(["away:c", "foreign:c"]);
  expect(errors).toEqual(["Dropping the mirrors of dead node c failed: Error: boom"]);
});

test("a fence that throws is logged, and runs once", async () => {
  const { deps } = fakeDeps({ fence: () => { throw new Error("stuck"); } });
  const death = new NodeDeath(await buried(new MemoryStore(), "a", STARTED), deps);
  await death.onNodeDead({ nodeId: "a", startedAt: STARTED, restarted: false });
  await death.onNodeDead({ nodeId: "a", startedAt: STARTED, restarted: false });
  expect(errors.filter((e) => e.includes("Fencing cluster node a failed: Error: stuck")).length).toBe(1);
});

test("after the fence nothing more is handled", async () => {
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(await buried(await buried(new MemoryStore(), "a", STARTED), "c", 5), deps);
  await death.onNodeDead({ nodeId: "a", startedAt: STARTED, restarted: false });
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  expect(calls).toEqual(["fence:the coordinator took this node's blocks"]);
});

test("start checks on its interval, and stop ends it", async () => {
  const store = new MemoryStore();
  const { deps, calls } = fakeDeps();
  const stop = new NodeDeath(store, deps).start(5);
  try {
    await store.set(deadKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED, at: 9 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
  } finally {
    stop();
  }
  expect(calls).toEqual(["fence:this node's tombstone was found"]);
});

// ---- Ghosts.dropPeer

function kind(local: Map<string, { id: string }>, shown: Map<string, string>, trail: string[]): GhostKind {
  return {
    name: "loot",
    *candidates() { for (const e of local.values()) yield { id: e.id, num: Number(e.id), map: "m", layerId: null, x: 0, y: 0 }; },
    snapshot: (id) => (local.has(String(id)) ? { id: String(id) } : null),
    spawn: (record, from) => { shown.set(String(record.id), from); },
    despawn: (id, reason) => { shown.delete(String(id)); trail.push(`despawn ${id} ${reason}`); },
  };
}

test("dropPeer despawns that peer's mirrors now, and the next scan sends ours to it again", async () => {
  const links = linkMesh(["a", "b", "c"] as const);
  const nodes = (["a", "b", "c"] as const).map((name) => {
    const ghosts = new Ghosts({ scanMs: 60_000, expireMs: 60_000 });
    const local = new Map<string, { id: string }>();
    const shown = new Map<string, string>();
    const trail: string[] = [];
    ghosts.register(kind(local, shown, trail));
    ghosts.attach(links[name], () => new Set(["a", "b", "c"].filter((n) => n !== name)));
    return { name, ghosts, local, shown, trail };
  });
  const [a, b, c] = nodes as [typeof nodes[0], typeof nodes[0], typeof nodes[0]];
  try {
    a.local.set("7", { id: "7" });
    c.local.set("8", { id: "8" });
    b.local.set("9", { id: "9" });
    for (const node of nodes) node.ghosts.scan();
    await settle();
    expect(Object.fromEntries(a.shown)).toEqual({ "8": "c", "9": "b" });
    expect(a.ghosts.dropPeer("c")).toBe(1);
    expect(a.trail).toEqual(["despawn 8 node-dead"]);
    expect(Object.fromEntries(a.shown)).toEqual({ "9": "b" });
    // Ours: c no longer counts as holding 7, so it is sent again if c is still there.
    const before = links.a.sent.filter((s) => s.peer === "c" && s.kind === "GHOST_SPAWN").length;
    a.ghosts.scan();
    expect(links.a.sent.filter((s) => s.peer === "c" && s.kind === "GHOST_SPAWN").length).toBe(before + 1);
    expect(a.ghosts.dropPeer("c")).toBe(0);
  } finally {
    for (const node of nodes) node.ghosts.detach();
  }
});

// ---- The node-side lease and the re-announce backstop (nodes.ts)

const infoOf = (nodeId: string, startedAt = STARTED): NodeInfo => ({
  nodeId, regionId: "eu", publicHost: `${nodeId}.example.com`, port: 3000, wtPort: 3002, useSSL: true, startedAt,
});

// A store whose writes fail while `down`, as with Redis away (the real one has no offline queue).
class FlakyStore extends MemoryStore {
  down = false;
  override async set(key: string, value: string, ttlMs = 0) {
    if (this.down) throw new Error("redis away");
    return super.set(key, value, ttlMs);
  }
}

const LEASE_MS = ALIVE_TTL_MS + LEASE_MARGIN_MS;

test("the lease holds while beats go through and ends once the last good beat is too old", async () => {
  let clock = 10_000;
  const registry = new NodeRegistry(new FlakyStore(), () => clock);
  await registry.announce(infoOf("a"));
  // No good beat yet: no lease.
  expect(registry.leaseValid()).toBe(false);
  await registry.beat("a");
  expect(registry.leaseValid()).toBe(true);
  expect(registry.leaseValid("a")).toBe(true);
  clock += LEASE_MS;
  expect(registry.leaseValid()).toBe(true);
  clock += 1;
  // Guard: the age check. Without it a node cut off from Redis keeps owning its blocks after a neighbour took them.
  expect(registry.leaseValid()).toBe(false);
  expect(registry.leaseValid("other")).toBe(false);
});

test("a beat that fails does not extend the lease, and a good beat after the lapse restores it", async () => {
  let clock = 10_000;
  const store = new FlakyStore();
  const registry = new NodeRegistry(store, () => clock);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  store.down = true;
  clock += 2_000;
  await expect(registry.beat("a")).rejects.toThrow("redis away");
  clock += 1_600;
  // 3.6 s since the good beat: the failed one at +2 s counted for nothing.
  expect(registry.leaseValid()).toBe(false);
  clock += 5_000;
  expect(registry.leaseValid()).toBe(false);
  store.down = false;
  await registry.beat("a");
  expect(registry.leaseValid()).toBe(true);
});

test("the lease counts from when the beat was sent, not when it came back", async () => {
  let clock = 10_000;
  const store = new MemoryStore();
  const slow = Object.create(store) as MemoryStore;
  let delay = 0;
  slow.set = async (key: string, value: string, ttlMs = 0) => {
    clock += delay;
    return store.set(key, value, ttlMs);
  };
  const registry = new NodeRegistry(slow, () => clock);
  await registry.announce(infoOf("a"));
  delay = 2_000;
  await registry.beat("a");
  // The beat went out at 10 000 and came back at 12 000: the lease runs from the send.
  expect(registry.leaseValid()).toBe(true);
  clock += LEASE_MS - 2_000;
  expect(registry.leaseValid()).toBe(true);
  clock += 1;
  expect(registry.leaseValid()).toBe(false);
});

test("retire ends the lease", async () => {
  const registry = new NodeRegistry(new MemoryStore());
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  expect(registry.leaseValid()).toBe(true);
  await registry.retire("a");
  expect(registry.leaseValid()).toBe(false);
});

test("a run named by a tombstone is not granted the lease again after it ran out", async () => {
  let clock = 10_000;
  const store = new MemoryStore();
  const registry = new NodeRegistry(store, () => clock);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  clock += LEASE_MS + 5_000;
  await store.set(tombstoneKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED, at: 1 }));
  await registry.beat("a");
  // Guard: the tombstone read on a lapsed lease. Without it a stalled node that wakes up owns its blocks again for
  // the second until its fence check runs.
  expect(registry.leaseValid()).toBe(false);
  // The run stays taken, whatever the tombstone says later.
  await store.set(tombstoneKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED - 1, at: 1 }));
  await registry.beat("a");
  expect(registry.leaseValid()).toBe(false);
  // A tombstone of an older run is none of another registry's run.
  const other = new NodeRegistry(store, () => clock);
  await other.announce(infoOf("a"));
  await other.beat("a");
  expect(other.leaseValid()).toBe(true);
});

test("the tombstone key is the coordinator's", () => {
  expect(tombstoneKey("node-7")).toBe(deadKey("node-7"));
});

test("a node forgotten by a racing forget announces itself again on its next beat", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  // The set entry is gone, the info is still there.
  await store.removeFromSet("cells:nodes", "a");
  expect(await registry.known()).toEqual([]);
  await registry.beat("a");
  expect(await registry.known()).toEqual(["a"]);
  expect((await registry.live()).map((n) => n.nodeId)).toEqual(["a"]);
  // The info is gone and so is the set entry (a forget that ran to the end).
  await store.removeFromSet("cells:nodes", "a");
  await store.del("cells:nodeinfo:a");
  await registry.beat("a");
  expect(await registry.info("a")).toEqual(infoOf("a"));
  expect(await registry.known()).toEqual(["a"]);
  // The info is gone and the id is still listed.
  await store.del("cells:nodeinfo:a");
  await registry.beat("a");
  expect(await registry.info("a")).toEqual(infoOf("a"));
});

test("a node whose info names an older run announces itself again", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(infoOf("a", STARTED));
  await registry.beat("a");
  await store.set("cells:nodeinfo:a", JSON.stringify(infoOf("a", STARTED - 50)));
  await registry.beat("a");
  expect((await registry.info("a"))?.startedAt).toBe(STARTED);
});

test("a node does not overwrite the announcement of a newer run under its id", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(infoOf("a", STARTED));
  await registry.beat("a");
  await store.set("cells:nodeinfo:a", JSON.stringify(infoOf("a", STARTED + 50)));
  await registry.beat("a");
  expect((await registry.info("a"))?.startedAt).toBe(STARTED + 50);
  // Both processes would act as owner of the blocks of the id: the older run is taken.
  expect(registry.taken()).toBe(true);
  expect(registry.leaseValid()).toBe(false);
});

test("a node whose tombstone names its run does not announce itself again; one of an older run does", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  await store.removeFromSet("cells:nodes", "a");
  await store.del("cells:nodeinfo:a");
  await store.set(tombstoneKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED, at: 1 }));
  await registry.beat("a");
  // Guard: the tombstone check. Without it a taken-over node announces itself again, and the coordinator ends up
  // forgetting the same dead run once more every few passes.
  expect(await registry.info("a")).toBeNull();
  expect(await registry.known()).toEqual([]);
  expect(registry.taken()).toBe(true);
  // A tombstone of an older run is none of this run's: a registry of a node that did not find itself taken announces.
  const other = new NodeRegistry(store);
  await other.announce(infoOf("a"));
  await store.removeFromSet("cells:nodes", "a");
  await store.del("cells:nodeinfo:a");
  await store.set(tombstoneKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED - 1, at: 1 }));
  await other.beat("a");
  expect(await other.info("a")).toEqual(infoOf("a"));
  expect(await other.known()).toEqual(["a"]);
  expect(other.taken()).toBe(false);
});

test("a beat from a node that never announced announces nothing", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.beat("ghost");
  expect(await registry.known()).toEqual([]);
  expect(await registry.info("ghost")).toBeNull();
});

test("a look at the announcement that fails does not stop the beat, and is logged once", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  const members = store.members.bind(store);
  store.members = async () => { throw new Error("Redis lost"); };
  await registry.beat("a");
  await registry.beat("a");
  expect(await store.get("cells:alive:a")).toBe(String(STARTED));
  expect(registry.leaseValid()).toBe(true);
  expect(warnings.filter((w) => w.includes("could not check its announcement")).length).toBe(1);
  store.members = members;
  await registry.beat("a");
  store.members = async () => { throw new Error("Redis lost"); };
  await registry.beat("a");
  expect(warnings.filter((w) => w.includes("could not check its announcement")).length).toBe(2);
});

test("a tombstone that cannot be read keeps a lapsed lease withheld until a beat can read it", async () => {
  let clock = 10_000;
  const store = new MemoryStore();
  const registry = new NodeRegistry(store, () => clock);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  clock += LEASE_MS + 1;
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    if (key === tombstoneKey("a")) throw new Error("Redis lost");
    return get(key);
  };
  await registry.beat("a");
  expect(registry.leaseValid()).toBe(false);
  store.get = get;
  await registry.beat("a");
  expect(registry.leaseValid()).toBe(true);
});

// ---- Fix round 1: a taken run has no lease, announces nothing and writes no beat

const TOMBSTONE_TTL = 600_000;

test("P1: a run forgotten after its lease ran out is taken even when the tombstone has expired", async () => {
  let clock = 10_000;
  const store = new MemoryStore();
  const registry = new NodeRegistry(store, () => clock);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  await store.set(tombstoneKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED, at: 1 }));
  expect(await registry.forgetRun("a", STARTED)).toBe(true);
  clock += TOMBSTONE_TTL + 60_000;
  await store.del(tombstoneKey("a"));
  await registry.beat("a");
  // Guard: held && lapsed && lost. Without it the dead run announces itself again with a lease of its own.
  expect(registry.taken()).toBe(true);
  expect(registry.leaseValid()).toBe(false);
  expect(await registry.known()).toEqual([]);
  expect(await registry.info("a")).toBeNull();
  expect(await store.get("cells:alive:a")).toBeNull();
  // Latched: it stays taken on every later beat.
  await registry.beat("a");
  expect(registry.taken()).toBe(true);
  expect(await registry.known()).toEqual([]);
});

test("a run that lost its announcement while its lease was valid is announced again, not taken", async () => {
  const clock = 10_000;
  const store = new MemoryStore();
  const registry = new NodeRegistry(store, () => clock);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  await store.removeFromSet("cells:nodes", "a");
  await store.del("cells:nodeinfo:a");
  await registry.beat("a");
  expect(registry.taken()).toBe(false);
  expect(registry.leaseValid()).toBe(true);
  expect(await registry.known()).toEqual(["a"]);
});

test("a run that never held a lease and finds itself forgotten announces itself again", async () => {
  let clock = 10_000;
  const store = new MemoryStore();
  const registry = new NodeRegistry(store, () => clock);
  await registry.announce(infoOf("a"));
  await store.removeFromSet("cells:nodes", "a");
  await store.del("cells:nodeinfo:a");
  clock += 60_000;
  await registry.beat("a");
  expect(registry.taken()).toBe(false);
  expect(await registry.known()).toEqual(["a"]);
  expect(registry.leaseValid()).toBe(true);
});

test("P3: a lease granted again just before a takeover is revoked by the beat that finds the tombstone", async () => {
  let clock = 10_000;
  const store = new MemoryStore();
  const registry = new NodeRegistry(store, () => clock);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  clock += LEASE_MS + 1_000;
  expect(registry.leaseValid()).toBe(false);
  // The takeover has not written its tombstone yet: the lease is granted again.
  await registry.beat("a");
  expect(registry.leaseValid()).toBe(true);
  await store.set(tombstoneKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED, at: 1 }));
  clock += 900;
  // The announcement is still there, as the takeover has not reached its end. The next beat reads the tombstone
  // although the lease is valid, and revokes it at once.
  await registry.beat("a");
  // Guard: the tombstone read on every beat. Without it the lease is renewed while the tables give the blocks away.
  expect(registry.leaseValid()).toBe(false);
  expect(registry.taken()).toBe(true);
  clock += 2_900;
  expect(registry.leaseValid()).toBe(false);
});

test("P3b: the beat that finds the tombstone after the announcement was forgotten ends the lease now", async () => {
  let clock = 10_000;
  const store = new MemoryStore();
  const registry = new NodeRegistry(store, () => clock);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  await store.set(tombstoneKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED, at: 1 }));
  await registry.forgetRun("a", STARTED);
  clock += 500;
  expect(registry.leaseValid()).toBe(true);
  await registry.beat("a");
  // Guard: take() deletes the last good beat. Without it the lease granted earlier runs on for up to 3.5 s.
  expect(registry.leaseValid()).toBe(false);
  clock += 2_900;
  expect(registry.leaseValid()).toBe(false);
  expect(await store.get("cells:alive:a")).not.toBe(String(STARTED));
});

test("a taken run writes no beat", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  await store.set(tombstoneKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED, at: 1 }));
  await registry.beat("a");
  await store.del("cells:alive:a");
  await registry.beat("a");
  // Guard: the early return of a latched run. Without it a taken run looks live to live() during a racing announce.
  expect(await store.get("cells:alive:a")).toBeNull();
  // A run announced anew by its own node (a different start) is a fresh start.
  await registry.announce(infoOf("a", STARTED + 10));
  expect(registry.taken()).toBe(false);
  await registry.beat("a");
  expect(registry.leaseValid()).toBe(true);
  expect(await store.get("cells:alive:a")).toBe(String(STARTED + 10));
});

test("m2: a run that sees a newer run announced under its id has no lease, even with the lease still valid", async () => {
  const clock = 10_000;
  const store = new MemoryStore();
  const registry = new NodeRegistry(store, () => clock);
  await registry.announce(infoOf("a", STARTED));
  await registry.beat("a");
  expect(registry.leaseValid()).toBe(true);
  await store.set("cells:nodeinfo:a", JSON.stringify(infoOf("a", STARTED + 50)));
  await registry.beat("a");
  expect(registry.taken()).toBe(true);
  expect(registry.leaseValid()).toBe(false);
});

test("m1: the lease follows the monotonic clock, not the wall clock", async () => {
  let mono = 1_000;
  const spies2 = [
    spyOn(performance, "now").mockImplementation(() => mono),
    // The wall clock is stepped back by an hour and stays there.
    spyOn(Date, "now").mockImplementation(() => 1_700_000_000_000 - 3_600_000),
  ];
  try {
    const registry = new NodeRegistry(new MemoryStore());
    await registry.announce(infoOf("a"));
    await registry.beat("a");
    expect(registry.leaseValid()).toBe(true);
    mono += LEASE_MS + 1;
    expect(registry.leaseValid()).toBe(false);
  } finally {
    for (const spy of spies2) spy.mockRestore();
  }
});

test("N1: a beat whose reads were held up past the takeover and the tombstone's expiry does not announce or regain the lease", async () => {
  let clock = 10_000;
  const store = new MemoryStore();
  const registry = new NodeRegistry(store, () => clock);
  await registry.announce(infoOf("a"));
  await registry.beat("a");
  // The info read of the next beat is held.
  const get = store.get.bind(store);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = true;
  store.get = async (key: string) => {
    if (held && key === "cells:nodeinfo:a") {
      held = false;
      await gate;
    }
    return get(key);
  };
  const slow = registry.beat("a");
  await store.set(tombstoneKey("a"), JSON.stringify({ nodeId: "a", startedAt: STARTED, at: 1 }));
  expect(await registry.forgetRun("a", STARTED)).toBe(true);
  clock += TOMBSTONE_TTL + 60_000;
  await store.del(tombstoneKey("a"));
  release();
  await slow;
  await registry.beat("a");
  // Guard: lapsed is read after the reads. Read before them it is stale, the beat announces the dead run again, and
  // the next beat grants it a lease.
  expect(registry.taken()).toBe(true);
  expect(registry.leaseValid()).toBe(false);
  expect(await registry.known()).toEqual([]);
  expect(await store.get("cells:alive:a")).toBeNull();
});

// Security review M1: the bus key alone must not fence a healthy node, nor drop or adopt anything of a live one. A
// notice is acted on only when the store, whose authority records are sealed, confirms it.
test("a node-dead naming this run fences only when the tombstone names the run", async () => {
  const store = new MemoryStore();
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(store, deps);
  const own = { nodeId: "a", startedAt: STARTED, restarted: false };
  await death.onNodeDead(own);
  // Guard: the verdict. Without it anyone with the bus key stops any node.
  expect(calls).toEqual([]);
  expect(death.isFenced()).toBe(false);
  expect(warnings.some((w) => w.includes("but no tombstone does: it is ignored"))).toBe(true);
  // A tombstone of an earlier run, or of a later one, is not this run's death.
  await buried(store, "a", STARTED - 1);
  await death.onNodeDead(own);
  await buried(store, "a", STARTED + 1);
  await death.onNodeDead(own);
  expect(calls).toEqual([]);
  await buried(store, "a", STARTED);
  await death.onNodeDead(own);
  expect(calls).toEqual(["fence:the coordinator took this node's blocks"]);
});

test("a node-dead no tombstone names drops nothing and adopts nothing", async () => {
  const store = new MemoryStore();
  const adopted: string[] = [];
  const { deps, calls } = fakeDeps({ adopt: (node, run) => { adopted.push(`${node}|${run}`); } });
  const death = new NodeDeath(store, deps);
  const notice = { nodeId: "c", startedAt: 5, restarted: false };
  await death.onNodeDead(notice);
  // Guard: the verdict on a peer's notice. Without it a forged notice drops a live node's mirrors, respawns the away
  // slots it holds (a creature then lives on two nodes) and adopts the grants it parked.
  expect(calls).toEqual([]);
  expect(adopted).toEqual([]);
  // The tombstone of an earlier run of c does not say run 5 is over.
  await buried(store, "c", 4);
  await death.onNodeDead(notice);
  expect(calls).toEqual([]);
  // Denied is not handled: the coordinator's own notice, once its tombstone is written, is acted on.
  await buried(store, "c", 5);
  await death.onNodeDead(notice);
  expect(calls).toEqual(["mirrors:c", "away:c", "foreign:c"]);
  expect(adopted).toEqual(["c|5"]);
  // A resent copy adopts again (idempotent there), and drops nothing more.
  await death.onNodeDead(notice);
  expect(calls.length).toBe(3);
  expect(adopted).toEqual(["c|5", "c|5"]);
});

test("a later run's tombstone confirms an earlier run of another node, never this node's own", async () => {
  const store = await buried(new MemoryStore(), "c", 9);
  const { deps, calls } = fakeDeps();
  await new NodeDeath(store, deps).onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  expect(calls).toEqual(["mirrors:c", "away:c", "foreign:c"]);
});

test("a restart notice is acted on only when the node announced a later run, or a tombstone names one", async () => {
  const store = new MemoryStore();
  const { deps, calls } = fakeDeps();
  const death = new NodeDeath(store, deps);
  const notice = { nodeId: "c", startedAt: 5, restarted: true };
  await death.onNodeDead(notice);
  // Guard: the announcement check. Without it a forged restart notice despawns the creatures c sent here.
  expect(calls).toEqual([]);
  await announced(store, "c", 5);
  await death.onNodeDead(notice);
  expect(calls).toEqual([]);
  await announced(store, "c", 6);
  await death.onNodeDead(notice);
  expect(calls).toEqual(["foreign:c"]);
  const other = fakeDeps();
  await new NodeDeath(await buried(new MemoryStore(), "d", 8), other.deps).onNodeDead({ nodeId: "d", startedAt: 5, restarted: true });
  expect(other.calls).toEqual(["foreign:d"]);
});

test("a store that cannot be read neither fences nor drops: the notice waits and is checked again", async () => {
  const store = await buried(await buried(new MemoryStore(), "a", STARTED), "c", 5);
  const get = store.get.bind(store);
  let broken = true;
  store.get = async (key: string) => {
    if (broken) throw new Error("Redis lost");
    return get(key);
  };
  const adopted: string[] = [];
  const { deps, calls } = fakeDeps({ adopt: (node, run) => { adopted.push(`${node}|${run}`); } });
  const death = new NodeDeath(store, deps);
  await death.onNodeDead({ nodeId: "a", startedAt: STARTED, restarted: false });
  await death.onNodeDead({ nodeId: "c", startedAt: 5, restarted: false });
  // Guard: an unread record is no verdict. Fenced on it, a Redis blip would stop a healthy node.
  expect(calls).toEqual([]);
  expect(adopted).toEqual([]);
  expect(await death.check()).toBe(false);
  expect(death.isFenced()).toBe(false);
  for (let i = 0; i < RETRY_LIMIT + 3; i++) await death.retry();
  expect(calls).toEqual([]);
  expect(errors.filter((e) => e.includes("could not be checked against the store")).length).toBe(1);
  broken = false;
  // The peer's notice was kept: it is acted on once the store answers, with no resent copy.
  await death.retry();
  expect(calls).toEqual(["mirrors:c", "away:c", "foreign:c"]);
  expect(adopted).toEqual(["c|5"]);
  // This node's own death is found by the tombstone watch (and the beat) once the tombstone can be read.
  expect(await death.check()).toBe(true);
  expect(calls).toContain("fence:this node's tombstone was found");
});

test("the notices waiting on the store are bounded: the oldest unconfirmed one goes first", async () => {
  const store = new MemoryStore();
  store.get = async () => { throw new Error("Redis lost"); };
  const { deps } = fakeDeps();
  const death = new NodeDeath(store, deps);
  for (let run = 0; run <= HANDLED_KEEP; run++) await death.onNodeDead({ nodeId: "c", startedAt: run, restarted: false });
  // Guard: the bound. Without it forged notices sent while Redis is away grow the map for as long as it is.
  expect(errors.filter((e) => e.includes("Too many node-dead notices wait")).length).toBe(1);
  expect(errors.some((e) => e.includes("run 0 of node c is dropped (it was never confirmed)"))).toBe(true);
});
