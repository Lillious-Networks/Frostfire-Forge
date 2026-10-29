import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// startCluster joins the node to its neighbours over node links, and stopCluster takes them down. The node
// is "b"; "a" is a NodeLinks on the same loopback network, built here. With links, startCluster loads
// aoievent and the ghost kinds, which reach the database module: it is stubbed first, and the cluster
// modules are imported after the stub (a static import would be hoisted above it).
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));
const log = (await import("../modules/logger")).default;
const { clusterLinks, reportCreaturesFrom, startCluster, stopCluster } = await import("../cluster");
const { BlockTable } = await import("../cluster/blocks");
const { delivery } = await import("../cluster/deliver");
const { resetEntityIds } = await import("../cluster/entityids");
const { aoiEvent } = await import("../cluster/aoievent");
const { ghosts } = await import("../cluster/ghosts");
const { toWire } = await import("../cluster/linkproto");
const { invitations } = await import("../cluster/invitations");
const { NodeLinks } = await import("../cluster/links");
const { deriveClusterKeys } = await import("../cluster/clusterkeys");
const { LoopbackNetwork } = await import("../cluster/loopback");
const { MemoryStore } = await import("../cluster/memorystore");
const { NodeRegistry } = await import("../cluster/nodes");
const assetCache = (await import("../services/assetCache")).default;
const playerCache = (await import("../services/playermanager")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
import type { GhostKind } from "../cluster/ghosts";

/** A MemoryStore that counts live subscriptions, and can be made to fail reads of the block tables. */
class CountingStore extends MemoryStore {
  subscriptions = 0;
  failBlockReads = false;
  async subscribe(channel: string, handler: (message: string) => void) {
    this.subscriptions++;
    return super.subscribe(channel, handler);
  }
  async unsubscribe(channel: string, handler: (message: string) => void) {
    this.subscriptions--;
    return super.unsubscribe(channel, handler);
  }
  async get(key: string) {
    if (this.failBlockReads && key.startsWith("cells:blocks:")) throw new Error("redis away");
    return super.get(key);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const saved = { cluster: process.env.CLUSTER, cache: process.env.CACHE, node: process.env.NODE_ID, secret: process.env.CLUSTER_LINK_SECRET };
// startCluster signs node links with a key derived from CLUSTER_LINK_SECRET (security review H2); the peer here uses the same.
const LINK_SECRET = "links-wiring-test-secret-0123456789abcdef";

// Block tables are sealed (secfix A round 1): written for startCluster through the seal it reads with.
const { sealStore } = await import("../cluster/storeseal");
const sealed = (store: Parameters<typeof sealStore>[0]) => sealStore(store, deriveClusterKeys(LINK_SECRET).store);
const LINK_KEY = deriveClusterKeys(LINK_SECRET).link;
beforeEach(() => {
  process.env.CLUSTER = "true";
  // startCluster refuses a node whose player rows are not shared (CACHE=redis), whoever made its store.
  process.env.CACHE = "redis";
  process.env.NODE_ID = "b";
  process.env.CLUSTER_LINK_SECRET = LINK_SECRET;
  playerCache.clear();
});
afterEach(async () => {
  await stopCluster();
  reportCreaturesFrom(null);
  playerCache.clear();
  delivery.detach();
  invitations.attach(null);
  resetEntityIds();
  for (const [name, value] of [["CLUSTER", saved.cluster], ["CACHE", saved.cache], ["NODE_ID", saved.node], ["CLUSTER_LINK_SECRET", saved.secret]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Polls until `check` holds, or fails after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await sleep(5);
  }
}

/** Runs `body` with mapProperties set to these maps, then puts the old list back. */
async function withMaps(maps: Array<{ name: string; width: number; height: number; tileWidth: number; tileHeight: number }>, body: () => Promise<void>) {
  const before = await assetCache.get("mapProperties");
  await assetCache.add("mapProperties", maps);
  try {
    await body();
  } finally {
    await assetCache.add("mapProperties", before);
  }
}

const own = (nodeId: string) => ({ nodeId, epoch: 1, since: 0 });
const mainMap = { name: "main.json", width: 300, height: 100, tileWidth: 32, tileHeight: 32 };   // 9600 x 3200 px: 3 x 1 blocks

async function world() {
  const store = new CountingStore();
  const net = new LoopbackNetwork();
  // Blocks: "a" owns x < 4096, "b" the rest.
  await new BlockTable(sealed(store)).write("main", { epoch: 1, owners: { "0,0": own("a"), "1,0": own("b"), "2,0": own("b") } });
  const registry = new NodeRegistry(store);
  await registry.announce({ nodeId: "a", regionId: "local", publicHost: "a", port: 1, wtPort: 1, useSSL: true, startedAt: 0, linkHost: "a.loop", linkPort: 7001, certHash: "" });
  await registry.beat("a");
  const peer = new NodeLinks({ self: "a", secret: LINK_KEY, transport: net.transport("a.loop", 7001), nodeInfo: (id) => registry.info(id), pingMs: 20, deadMs: 100 });
  await peer.start();
  return { store, net, peer };
}

const address = { publicHost: "b.example.com", port: 3000, wtPort: 3000, useSSL: true, linkHost: "b.loop", linkPort: 7002, certHash: "" };

test("a node links with the neighbour its blocks touch, and drops it on stop", async () => {
  await withMaps([mainMap], async () => {
    const { store, net, peer } = await world();
    const downs: string[] = [];
    peer.onPeerDown((id) => downs.push(id));
    peer.want(["b"]);                      // "a" < "b": "a" dials
    await startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("b.loop", 7002), pingMs: 20, deadMs: 100 });
    await until(() => peer.isUp("b") && !!clusterLinks()?.isUp("a"));
    // What the neighbour dialled from: the announcement carries the link port.
    expect((await new NodeRegistry(store).info("b"))?.linkPort).toBe(7002);
    await stopCluster();
    await until(() => downs.includes("b"));
    expect(clusterLinks()).toBeNull();
    await peer.stop();
  });
});

test("a ghost sent by the neighbour reaches the registered kind", async () => {
  await withMaps([mainMap], async () => {
    const { store, net, peer } = await world();
    const spawned: any[] = [];
    const kind: GhostKind = {
      name: "tornado",
      candidates: () => [],
      snapshot: () => null,
      spawn: (record, from) => { spawned.push({ record, from }); },
      despawn: () => {},
    };
    peer.want(["b"]);
    await startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("b.loop", 7002), pingMs: 20, deadMs: 100 });
    // After startCluster: loadGhostKinds registers the engine's own kinds, and this one stands in for the real one.
    const kinds = (ghosts as any).kinds as Map<string, GhostKind>;
    const engine = kinds.get("tornado");
    ghosts.register(kind);
    try {
      await until(() => peer.isUp("b"));
      peer.send("b", "GHOST_SPAWN", { kind: "tornado", id: "t9", num: 9, record: { id: "t9", map: "main", x: 4000, y: 10 } });
      await until(() => spawned.length === 1);
      expect(spawned[0]).toEqual({ record: { id: "t9", map: "main", x: 4000, y: 10 }, from: "a" });
      expect(ghosts.mirrorCount()).toBe(1);

      // Stopping detaches the ghosts (their mirrors go), and nothing the old links hand over reaches a kind.
      await stopCluster();
      expect(ghosts.mirrorCount()).toBe(0);
      peer.send("b", "GHOST_SPAWN", { kind: "tornado", id: "t10", num: 10, record: { id: "t10", map: "main", x: 4000, y: 10 } });
      await sleep(100);
      expect(spawned).toHaveLength(1);
    } finally {
      // The kinds are the engine's for the next test.
      if (engine) kinds.set("tornado", engine);
      else kinds.delete("tornado");
    }
    await peer.stop();
  });
});

test("a node can stop and start again with links, on new links each time", async () => {
  await withMaps([mainMap], async () => {
    const { store, net, peer } = await world();
    peer.want(["b"]);
    await startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("b.loop", 7002), pingMs: 20, deadMs: 100 });
    await until(() => !!clusterLinks()?.isUp("a"));
    const first = clusterLinks();
    await stopCluster();
    expect(store.subscriptions).toBe(0);
    expect(net.listeners.has("b.loop:7002")).toBe(false);

    // The second start would throw if it re-attached the first start's links (each kind gets one handler).
    await startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("b.loop", 7002), pingMs: 20, deadMs: 100 });
    expect(clusterLinks()).not.toBe(first);
    await until(() => !!clusterLinks()?.isUp("a") && peer.isUp("b"));
    await peer.stop();
  });
});

test("an AOI event crosses the link both ways", async () => {
  await withMaps([mainMap], async () => {
    const { store, net, peer } = await world();
    const got: any[] = [];
    peer.on("AOI_EVENT", (data, from) => got.push({ ...data, from }));
    peer.want(["b"]);
    await startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("b.loop", 7002), pingMs: 20, deadMs: 100 });
    await until(() => peer.isUp("b") && !!clusterLinks()?.isUp("a"));

    // Out: an event 100 px from "a"'s blocks goes to "a" (its blocks are within the radius).
    aoiEvent("main", null, 4200, 100, 500, [new Uint8Array([7])]);
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ map: "main", x: 4200, radius: 500, from: "b" });

    // In: an event from "a" reaches the local players in range.
    let received = 0;
    playerCache.add("near", { id: "near", location: { map: "main", position: { x: 5000, y: 100, direction: "down" } }, wt: { readyState: 1, send: () => { received++; }, sendBestEffort: () => { received++; } } });
    spatialGrid.addPlayer("near", 5000, 100, "main");
    try {
      peer.send("b", "AOI_EVENT", { map: "main", layerId: null, x: 4900, y: 100, radius: 500, packets: toWire([new Uint8Array([1])]), bestEffort: false });
      await until(() => received === 1);
    } finally {
      spatialGrid.removePlayer("near");
      playerCache.remove("near");
    }
    await peer.stop();
  });
});

test("without a transport the node announces linkPort 0 and links nothing", async () => {
  await withMaps([mainMap], async () => {
    const { store, peer } = await world();
    await startCluster(store, address, { beatMs: 10, refreshMs: 20 });
    expect(clusterLinks()).toBeNull();
    expect((await new NodeRegistry(store).info("b"))?.linkPort).toBe(0);
    await peer.stop();
  });
});

test("a link port in use ends the start, leaves no node behind, and a later start works", async () => {
  await withMaps([mainMap], async () => {
    const { store, net, peer } = await world();
    // Another listener holds the node's link address: the loopback transport answers a second listen with an error.
    const busy = net.transport("b.loop", 7002);
    busy.listen = async () => { throw new Error("address in use"); };
    await expect(startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: busy, pingMs: 20, deadMs: 100 }))
      .rejects.toThrow("address in use");
    expect(clusterLinks()).toBeNull();
    // Not announced: no neighbour dials a node that never came up.
    expect(await new NodeRegistry(store).info("b")).toBeNull();
    // Nothing was attached before the listener: no subscription, no delivery, no ghosts.
    expect(store.subscriptions).toBe(0);
    expect((delivery as any).bus).toBeNull();
    expect(ghosts.mirrorCount()).toBe(0);
    await startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("b.loop", 7002), pingMs: 20, deadMs: 100 });
    expect(clusterLinks()).not.toBeNull();
    await peer.stop();
  });
});

test("a start that fails after the listener is up undoes all of it", async () => {
  await withMaps([mainMap], async () => {
    const { store, net, peer } = await world();
    peer.want(["b"]);
    // The block tables cannot be read: the start fails after links, bus, delivery, presence and the announcement.
    store.failBlockReads = true;
    const errors = spyOn(log, "error").mockImplementation(() => {});
    try {
      await expect(startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("b.loop", 7002), pingMs: 20, deadMs: 100 }))
        .rejects.toThrow("redis away");
      // Every step of the undo went through (none was logged as failed).
      expect(errors.mock.calls.filter((call) => String(call[0]).includes("could not"))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
    expect(clusterLinks()).toBeNull();
    // The listener is closed, the subscriptions are gone, the handlers are off, and the node is not live.
    expect(net.listeners.has("b.loop:7002")).toBe(false);
    expect(store.subscriptions).toBe(0);
    expect((delivery as any).bus).toBeNull();
    expect(ghosts.mirrorCount()).toBe(0);
    expect((await new NodeRegistry(store).live()).map((info) => info.nodeId)).toEqual(["a"]);
    await sleep(100);
    expect(peer.isUp("b")).toBe(false);

    // A retry in the same process starts clean.
    store.failBlockReads = false;
    await startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("b.loop", 7002), pingMs: 20, deadMs: 100 });
    await until(() => peer.isUp("b") && !!clusterLinks()?.isUp("a"));
    await peer.stop();
  });
});

test("without CLUSTER_LINK_SECRET the node does not start (it no longer runs without links)", async () => {
  await withMaps([mainMap], async () => {
    const { store, net, peer } = await world();
    delete process.env.CLUSTER_LINK_SECRET;
    await expect(startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("b.loop", 7002), pingMs: 20, deadMs: 100 }))
      .rejects.toThrow("CLUSTER_LINK_SECRET");
    expect(clusterLinks()).toBeNull();
    expect(net.listeners.has("b.loop:7002")).toBe(false);
    expect(await new NodeRegistry(store).info("b")).toBeNull();
    expect(store.subscriptions).toBe(0);
    await peer.stop();
  });
});

test("the neighbour list follows the block table", async () => {
  await withMaps([mainMap], async () => {
    const { store, net, peer } = await world();
    peer.want(["b"]);
    await startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("b.loop", 7002), pingMs: 20, deadMs: 100 });
    await until(() => !!clusterLinks()?.isUp("a"));
    // "a" hands every block to "b": no one borders "b" any more, so it stops wanting "a" (lingers, then goes).
    // Observed from the other end: the dialler "a" keeps its link while it wants "b", so only the want list is checked.
    const links = clusterLinks()!;
    const wanted: string[][] = [];
    const want = links.want.bind(links);
    links.want = (peers: Iterable<string>) => { const list = [...peers]; wanted.push(list); want(list); };
    await new BlockTable(sealed(store)).write("main", { epoch: 2, owners: { "0,0": own("b"), "1,0": own("b"), "2,0": own("b") } });
    await until(() => wanted.at(-1)?.length === 0);
    await peer.stop();
  });
});

/**
 * A node "a" (the one under test) next to a live node "b" built here: b is announced and beating, and holds the
 * blocks `bOwns` of the main map ("a" the others). Neither wants the other by itself: only the live list brings them
 * together, as a node that owns no block borders no one.
 */
async function emptyNeighbourWorld(owners: Record<string, string>) {
  process.env.NODE_ID = "a";
  const store = new CountingStore();
  const net = new LoopbackNetwork();
  await new BlockTable(sealed(store)).write("main", {
    epoch: 1,
    owners: Object.fromEntries(Object.entries(owners).map(([key, nodeId]) => [key, own(nodeId)])),
  });
  const registry = new NodeRegistry(sealed(store));
  await registry.announce({ nodeId: "b", regionId: process.env.REGION_ID || process.env.SERVER_ID || "default", publicHost: "b", port: 1, wtPort: 1, useSSL: true, startedAt: 0, linkHost: "b.loop", linkPort: 7002, certHash: "" });
  await registry.beat("b");
  const peer = new NodeLinks({ self: "b", secret: LINK_KEY, transport: net.transport("b.loop", 7002), nodeInfo: (id) => registry.info(id), pingMs: 20, deadMs: 100 });
  await peer.start();
  return { store, net, peer, registry };
}
const aAddress = { publicHost: "a.example.com", port: 3000, wtPort: 3000, useSSL: true, linkHost: "a.loop", linkPort: 7001, certHash: "" };

test("a node that owns blocks links with a live node that owns none, for the block move the rebalancer orders", async () => {
  await withMaps([mainMap], async () => {
    const { store, net, peer, registry } = await emptyNeighbourWorld({ "0,0": "a", "1,0": "a", "2,0": "a" });
    await startCluster(store, aAddress, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("a.loop", 7001), pingMs: 20, deadMs: 100 });
    await until(() => !!clusterLinks()?.isUp("b") && peer.isUp("a"));
    // The empty node's restart: it is announced under a new run and the link is made again.
    await peer.stop();
    await until(() => !clusterLinks()?.isUp("b"));
    await registry.announce({ nodeId: "b", regionId: process.env.REGION_ID || process.env.SERVER_ID || "default", publicHost: "b", port: 1, wtPort: 1, useSSL: true, startedAt: 5, linkHost: "b.loop", linkPort: 7002, certHash: "" });
    await registry.beat("b");
    const again = new NodeLinks({ self: "b", secret: LINK_KEY, transport: net.transport("b.loop", 7002), nodeInfo: (id) => registry.info(id), pingMs: 20, deadMs: 100 });
    await again.start();
    await until(() => !!clusterLinks()?.isUp("b") && again.isUp("a"), 8000);
    await again.stop();
  });
});

test("a node that owns no block links with the live nodes", async () => {
  await withMaps([mainMap], async () => {
    const { store, net, peer } = await emptyNeighbourWorld({ "0,0": "b", "1,0": "b", "2,0": "b" });
    await startCluster(store, aAddress, { beatMs: 10, refreshMs: 20 }, { transport: net.transport("a.loop", 7001), pingMs: 20, deadMs: 100 });
    await until(() => !!clusterLinks()?.isUp("b") && peer.isUp("a"));
    await peer.stop();
  });
});
