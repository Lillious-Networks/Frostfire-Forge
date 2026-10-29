import { afterEach, beforeEach, expect, test } from "bun:test";
import { startCluster, stopCluster, reportCreaturesFrom } from "../cluster";
import { ClusterBus, WORLD_CHANNEL, sealEnvelope } from "../cluster/bus";
import { nodeLinkHost, nodeLinkPort } from "../cluster/config";
import { delivery } from "../cluster/deliver";
import { PlayerDirectory } from "../cluster/directory";
import { resetEntityIds } from "../cluster/entityids";
import { invitations } from "../cluster/invitations";
import { MemoryStore } from "../cluster/memorystore";
import { NodeRegistry } from "../cluster/nodes";
import playerCache from "../services/playermanager";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

/** A MemoryStore that counts live subscriptions. */
class CountingStore extends MemoryStore {
  subscriptions = 0;
  async subscribe(channel: string, handler: (message: string) => void) {
    this.subscriptions++;
    return super.subscribe(channel, handler);
  }
  async unsubscribe(channel: string, handler: (message: string) => void) {
    this.subscriptions--;
    return super.unsubscribe(channel, handler);
  }
}

const saved = { cluster: process.env.CLUSTER, cache: process.env.CACHE, node: process.env.NODE_ID, port: process.env.NODE_LINK_PORT, host: process.env.NODE_LINK_HOST, server: process.env.SERVER_HOST, secret: process.env.CLUSTER_LINK_SECRET };
beforeEach(() => {
  process.env.CLUSTER = "true";
  // startCluster refuses a node whose player rows are not shared (CACHE=redis), whoever made its store.
  process.env.CACHE = "redis";
  process.env.NODE_ID = "b";
  // startCluster also refuses a node without the link secret (security review H2).
  process.env.CLUSTER_LINK_SECRET = "lifecycle-test-link-secret-0123456789abcdef";
  playerCache.clear();
});
afterEach(async () => {
  await stopCluster();
  reportCreaturesFrom(null);
  playerCache.clear();
  delivery.detach();
  invitations.attach(null);
  resetEntityIds();
  for (const [name, value] of [["CLUSTER", saved.cluster], ["CACHE", saved.cache], ["NODE_ID", saved.node], ["NODE_LINK_PORT", saved.port], ["NODE_LINK_HOST", saved.host], ["SERVER_HOST", saved.server], ["CLUSTER_LINK_SECRET", saved.secret]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const address = { publicHost: "b.example.com", port: 3000, wtPort: 3000, useSSL: true };

test("starting the bus twice handles a message once", async () => {
  const store = new MemoryStore();
  const bus = new ClusterBus(store, "a", TEST_BUS_KEY);
  let got = 0;
  bus.on("ping", () => { got++; });
  await bus.start();
  await bus.start();
  await bus.toWorld("ping", {});
  await settle();
  expect(got).toBe(1);
});

test("a stopped bus hears nothing and can start again", async () => {
  const store = new MemoryStore();
  const bus = new ClusterBus(store, "a", TEST_BUS_KEY);
  let got = 0;
  bus.on("ping", () => { got++; });
  await bus.start();
  await bus.stop();
  await store.publish(WORLD_CHANNEL, sealEnvelope(TEST_BUS_KEY, "x", "*", "ping", {}, Date.now()));
  await settle();
  expect(got).toBe(0);
  await bus.start();
  await bus.toWorld("ping", {});
  await settle();
  expect(got).toBe(1);
});

test("unsubscribe removes only that handler", async () => {
  const store = new MemoryStore();
  const got: string[] = [];
  const one = (m: string) => got.push(`1:${m}`);
  const two = (m: string) => got.push(`2:${m}`);
  await store.subscribe("c", one);
  await store.subscribe("c", two);
  await store.unsubscribe("c", one);
  await store.publish("c", "x");
  await settle();
  expect(got).toEqual(["2:x"]);
});

test("playerCache listeners can be removed", () => {
  let added = 0;
  const stop = playerCache.onAdd(() => { added++; });
  playerCache.add("1", { id: "1", username: "one" });
  stop();
  playerCache.add("2", { id: "2", username: "two" });
  expect(added).toBe(1);
});

test("stopCluster leaves no subscription behind, and a restart works", async () => {
  const store = new CountingStore();
  await startCluster(store, address, { beatMs: 10, refreshMs: 20 });
  expect(store.subscriptions).toBeGreaterThan(0);
  await stopCluster();
  expect(store.subscriptions).toBe(0);
  // The store passed in is the caller's: it is still usable.
  await store.set("k", "v");
  expect(await store.get("k")).toBe("v");
  await startCluster(store, address, { beatMs: 10, refreshMs: 20 });
  expect(store.subscriptions).toBeGreaterThan(0);
});

test("the node announces its link address, with linkPort 0 when it runs without links", async () => {
  const store = new MemoryStore();
  await startCluster(store, { ...address, linkHost: "10.0.0.2", linkPort: 3001, certHash: "abc" });
  const info = await new NodeRegistry(store).info("b");
  expect(info?.linkHost).toBe("10.0.0.2");
  // No links were given: a neighbour must not dial a port nothing listens on (cluster-links-wiring.test.ts has the linked case).
  expect(info?.linkPort).toBe(0);
  expect(info?.certHash).toBe("abc");
});

test("link settings: defaults and overrides", () => {
  delete process.env.NODE_LINK_PORT;
  expect(nodeLinkPort(3000)).toBe(3001);
  process.env.NODE_LINK_PORT = "4100";
  expect(nodeLinkPort(3000)).toBe(4100);
  process.env.NODE_LINK_PORT = "0";
  expect(nodeLinkPort(3000)).toBe(0);
  process.env.NODE_LINK_PORT = "nope";
  expect(nodeLinkPort(3000)).toBe(3001);
  for (const odd of ["1e3", "0x10", "-1", "70000", "4100.5"]) {
    process.env.NODE_LINK_PORT = odd;
    expect(nodeLinkPort(3000)).toBe(3001);
  }
  delete process.env.NODE_LINK_HOST;
  process.env.SERVER_HOST = "localhost";
  expect(nodeLinkHost()).toBe("127.0.0.1");
  process.env.SERVER_HOST = "node-2";
  expect(nodeLinkHost()).toBe("node-2");
  process.env.NODE_LINK_HOST = "10.1.2.3";
  expect(nodeLinkHost()).toBe("10.1.2.3");
});

test("a player added after stopCluster makes no directory claim", async () => {
  const store = new MemoryStore();
  await startCluster(store, address);
  await stopCluster();
  playerCache.add("9", { id: "9", username: "late" });
  await settle();
  expect(await new PlayerDirectory(store, "b").get("late")).toBeNull();
});

test("stopCluster empties a logged-in player's directory entry", async () => {
  const store = new MemoryStore();
  await startCluster(store, address);
  playerCache.add("7", { id: "7", username: "hero" });
  await settle();
  const directory = new PlayerDirectory(store, "b");
  expect((await directory.get("hero"))?.nodeId).toBe("b");
  await stopCluster();
  expect(await directory.get("hero")).toBeNull();
});

test("stopCluster twice is safe", async () => {
  await startCluster(new MemoryStore(), address);
  await stopCluster();
  await stopCluster();
});

test("a retire that fails still releases the bus subscriptions", async () => {
  class FailingRetire extends CountingStore {
    async del(key: string) {
      if (key.startsWith("cells:alive:")) throw new Error("redis down");
      return super.del(key);
    }
  }
  const store = new FailingRetire();
  await startCluster(store, address);
  expect(store.subscriptions).toBeGreaterThan(0);
  await stopCluster();
  expect(store.subscriptions).toBe(0);
});
