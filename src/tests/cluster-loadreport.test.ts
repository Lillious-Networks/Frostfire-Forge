import { afterEach, beforeEach, expect, test } from "bun:test";
import { clusterBus, clusterDirectory, clusterSelf, clusterStartedAt, clusterStore, loadReport, startCluster, stopCluster, VISIBLE_PAIR_LOAD } from "../cluster";
import { delivery } from "../cluster/deliver";
import { resetEntityIds } from "../cluster/entityids";
import { invitations } from "../cluster/invitations";
import { MemoryStore } from "../cluster/memorystore";
import type { SealedStore } from "../cluster/storeseal";
import assetCache from "../services/assetCache";
import playerCache from "../services/playermanager";

const saved = { cluster: process.env.CLUSTER, cache: process.env.CACHE, node: process.env.NODE_ID, secret: process.env.CLUSTER_LINK_SECRET };
beforeEach(() => {
  process.env.CLUSTER = "true";
  process.env.CACHE = "redis";
  process.env.NODE_ID = "b";
  // startCluster refuses to start without the link secret (it signs the bus and the links).
  process.env.CLUSTER_LINK_SECRET = "loadreport-test-secret-0123456789abcdef";
  playerCache.clear();
});
afterEach(async () => {
  await stopCluster();
  playerCache.clear();
  delivery.detach();
  invitations.attach(null);
  resetEntityIds();
  for (const [name, value] of [["CLUSTER", saved.cluster], ["CACHE", saved.cache], ["NODE_ID", saved.node], ["CLUSTER_LINK_SECRET", saved.secret]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const seeing = (count: number) => new Set(Array.from({ length: count }, (_, i) => `x${i}`));

test("a player adds a share of each player it sees to its block", () => {
  playerCache.add("1", { username: "alice", location: { map: "main", position: { x: 10, y: 10 } }, aoi: { playersInAOI: seeing(10) } });
  playerCache.add("2", { username: "bob", location: { map: "main", position: { x: 20, y: 10 } } });
  const report = loadReport("b", 1);
  expect(report.players).toBe(2);
  expect(report.blocks["main|0,0"]).toBe(Math.round((2 + 10 * VISIBLE_PAIR_LOAD) * 10) / 10);
});

test("the report carries the event-loop lag when it is given, and nothing when it is not", () => {
  expect(loadReport("b", 1, undefined, 340).lagMs).toBe(340);
  // A report without the field is an older node's: the coordinator counts it as not lagging.
  expect("lagMs" in loadReport("b", 1)).toBe(false);
});

test("outside cluster mode the accessors answer null", () => {
  expect(clusterSelf()).toBeNull();
  expect(clusterStore()).toBeNull();
  expect(clusterBus()).toBeNull();
  expect(clusterDirectory()).toBeNull();
  expect(clusterStartedAt()).toBeNull();
});

test("a running node answers its own store, bus, directory and start time", async () => {
  const before = await assetCache.get("mapProperties");
  await assetCache.add("mapProperties", [{ name: "main.json", width: 200, height: 100, tileWidth: 32, tileHeight: 32 }]);
  try {
    const store = new MemoryStore();
    const from = Date.now();
    const started = await startCluster(store, { publicHost: "b.example.com", port: 3000, wtPort: 3000, useSSL: true }, { beatMs: 10, refreshMs: 20 });
    const to = Date.now();
    expect(clusterSelf()).toBe("b");
    // The store is used through its seal (storeseal.ts, security review H1).
    expect((clusterStore() as SealedStore).inner).toBe(store);
    expect(clusterBus()?.nodeId).toBe("b");
    expect(clusterDirectory()).toBe(started!.directory);
    expect(clusterStartedAt()).toBeGreaterThanOrEqual(from);
    expect(clusterStartedAt()).toBeLessThanOrEqual(to);
    await stopCluster();
    expect(clusterSelf()).toBeNull();
    expect(clusterStore()).toBeNull();
    expect(clusterBus()).toBeNull();
    expect(clusterDirectory()).toBeNull();
    expect(clusterStartedAt()).toBeNull();
  } finally {
    await assetCache.add("mapProperties", before);
  }
});
