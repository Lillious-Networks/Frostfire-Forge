import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

import { databaseModule, mockQuery } from "./setup";

// The real database layer (its worker threads connect to a database) must never load, whichever way this file is run.
// The modules below reach it through their static imports, so the stand-in goes first and they are loaded after it.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery, drainQueries: async () => {} }));
const { ClusterBus } = await import("../cluster/bus");
const { deriveClusterKeys } = await import("../cluster/clusterkeys");
const { Delivery, delivery } = await import("../cluster/deliver");
const { PlayerDirectory } = await import("../cluster/directory");
const { nextEntityId, resetEntityIds } = await import("../cluster/entityids");
const { clusterBlocks, onBlocksChanged, reportCreaturesFrom, spawnsHere, startCluster, stopCluster } = await import("../cluster");
const { BlockTable } = await import("../cluster/blocks");
const { invitations } = await import("../cluster/invitations");
const { MapCatalogue } = await import("../cluster/maps");
const { MemoryStore } = await import("../cluster/memorystore");
const { NodeRegistry } = await import("../cluster/nodes");
const { routeLogin } = await import("../cluster/route");
const { default: log } = await import("../modules/logger");
const { default: assetCache } = await import("../services/assetCache");
const { default: layerManager, MAX_PLAYERS_PER_LAYER } = await import("../services/layermanager");
const { default: playerCache } = await import("../services/playermanager");

// startCluster wires the shared delivery, invitations and presence tracking to
// a store: here a MemoryStore, with this process standing in for node "b".

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

const saved = { cluster: process.env.CLUSTER, cache: process.env.CACHE, node: process.env.NODE_ID, secret: process.env.CLUSTER_LINK_SECRET };
// startCluster refuses a node without the link secret (security review H2); its bus key is derived from it.
const LINK_SECRET = "start-test-link-secret-0123456789abcdef";

// Block tables are sealed (secfix A round 1): written for startCluster through the seal it reads with.
const { sealStore } = await import("../cluster/storeseal");
const sealed = (store: Parameters<typeof sealStore>[0]) => sealStore(store, deriveClusterKeys(LINK_SECRET).store);
const BUS_KEY = deriveClusterKeys(LINK_SECRET).bus;
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

// What server.ts passes: the address the gateway registration advertises.
const address = { publicHost: "b.example.com", port: 3000, wtPort: 3000, useSSL: true };
// Short beats and re-reads, so a test waits for a few of them and not for seconds.
const fast = { beatMs: 10, refreshMs: 20 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Polls until `check` holds, or fails after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await sleep(5);
  }
}
const player = (map: string, x: number, y: number) => ({ username: `p${x},${y}`, location: { map, position: { x, y } } });

/** Runs `body` with mapProperties set to these maps, then puts the old list back. */
async function withMaps(maps: Array<{ name: string; width: number; height: number; tileWidth: number; tileHeight: number }>, body: () => Promise<void>) {
  const saved = await assetCache.get("mapProperties");
  await assetCache.add("mapProperties", maps);
  try {
    await body();
  } finally {
    await assetCache.add("mapProperties", saved);
  }
}
const mainMap = { name: "main.json", width: 200, height: 100, tileWidth: 32, tileHeight: 32 };

test("without CLUSTER=true nothing starts", async () => {
  process.env.CLUSTER = "false";
  expect(await startCluster(new MemoryStore(), address)).toBeNull();
});

test("without CLUSTER=true and no store, no Redis client is made", async () => {
  delete process.env.CLUSTER;
  // RedisStore is swapped for a counter, so a regression cannot open a socket either; the real one is put back after.
  // A copy: mock.module patches the live namespace, so restoring the namespace itself would keep the stand-in.
  const original = { ...(await import("../cluster/redisstore")) };
  let made = 0;
  mock.module("../cluster/redisstore", () => ({ RedisStore: class { constructor() { made++; } } }));
  try {
    expect(await startCluster(undefined, address)).toBeNull();
    expect(made).toBe(0);
    // The mock is live: with the cluster on, the same call does make one (and then fails on the fake).
    process.env.CLUSTER = "true";
    await startCluster(undefined, address).catch(() => {});
    expect(made).toBe(1);
  } finally {
    mock.module("../cluster/redisstore", () => original);
  }
});

test("returns world ids and the directory of this node", async () => {
  const cluster = await startCluster(new MemoryStore(), address);
  expect(cluster).not.toBeNull();
  const first = cluster!.ids.next();
  expect(first).toBeGreaterThan(0);
  expect(cluster!.ids.next()).not.toBe(first);
  expect(cluster!.directory.nodeId).toBe("b");
});

test("entity ids come from the node's allocator once it has joined", async () => {
  const cluster = await startCluster(new MemoryStore(), address);
  const first = nextEntityId();
  expect(cluster!.ids.next()).toBe(first + 1);
});

test("clears the entries this node left behind, and only those", async () => {
  const store = new MemoryStore();
  const b = new PlayerDirectory(store, "b");
  const a = new PlayerDirectory(store, "a");
  await b.claim("ghost", "1", "main");
  await a.claim("keeper", "2", "main");
  const cluster = await startCluster(store, address);
  expect(await cluster!.directory.get("ghost")).toBeNull();
  expect(await cluster!.directory.playersOn("b")).toEqual([]);
  expect((await cluster!.directory.get("keeper"))?.nodeId).toBe("a");
});

test("a login here of a player held on node a closes the session on node a", async () => {
  const store = new MemoryStore();
  // Node a: its own bus, directory and delivery, as another process would have.
  const displaced: string[] = [];
  const hero = { username: "Hero" };
  const nodeA = new Delivery({ get: (key) => (key === "11" ? hero : undefined), getByUsername: () => undefined, list: () => ({}) });
  const busA = new ClusterBus(store, "a", BUS_KEY);
  const directoryA = new PlayerDirectory(store, "a");
  nodeA.attach(busA, directoryA);
  nodeA.registerAction("displaced-login", (player, args) => { displaced.push(`${player.username}:${args.username}`); });
  await busA.start();
  await directoryA.claim("Hero", "11", "main");

  await startCluster(store, address);
  playerCache.add("22", { username: "Hero", location: { map: "main" } });
  await settle();

  expect(displaced).toEqual(["Hero:Hero"]);
  expect((await directoryA.get("hero"))?.nodeId).toBe("b");
});

test("announces this node and beats until shutdown, which retires it", async () => {
  const store = new MemoryStore();
  const nodes = new NodeRegistry(store);
  const beats = spyOn(NodeRegistry.prototype, "beat");
  try {
    await startCluster(store, address, fast);
    const [info] = await nodes.live();
    expect(info).toMatchObject({ nodeId: "b", ...address });
    expect(typeof info!.regionId).toBe("string");
    expect(info!.startedAt).toBeGreaterThan(0);
    await until(() => beats.mock.calls.length >= 3);

    await stopCluster();
    expect(await nodes.live()).toEqual([]);
    // The info stays (old tickets still route) and the timer is gone: nothing makes the node live again.
    expect((await nodes.info("b"))?.publicHost).toBe("b.example.com");
    const after = beats.mock.calls.length;
    await sleep(10 * fast.beatMs);
    expect(beats.mock.calls.length).toBe(after);
    expect(await nodes.live()).toEqual([]);
  } finally {
    beats.mockRestore();
  }
});

test("reports players and active creatures per block, again on each beat", async () => {
  const store = new MemoryStore();
  const nodes = new NodeRegistry(store);
  playerCache.add("1", player("main.json", 10, 10));
  playerCache.add("2", player("main", 5000, 10));
  reportCreaturesFrom(() => [
    { map: "main", x: 100, y: 100, state: "idle" },
    { map: "main", x: 200, y: 100, state: "dead" }, // a corpse is not load
    { map: "cave", x: -5, y: 9000, state: "wander" }, // off the edge: the edge block
  ]);
  await startCluster(store, address, fast);
  const [load] = await nodes.loads();
  expect(load).toMatchObject({ nodeId: "b", players: 2, creatures: 2 });
  // Load per block: players + 0.1 x creatures.
  expect(load!.blocks).toEqual({ "main|0,0": 1.1, "main|1,0": 1, "cave|0,2": 0.1 });

  playerCache.add("3", player("main", 20, 20));
  await until(async () => (await nodes.loads())[0]?.players === 3);
  expect((await nodes.loads())[0]!.blocks["main|0,0"]).toBe(2.1);
});

test("a player or creature without a position counts in the totals, but in no block", async () => {
  const store = new MemoryStore();
  const nodes = new NodeRegistry(store);
  playerCache.add("1", player("main", 10, 10));
  // Logging in, or between maps: a map, no position yet.
  playerCache.add("2", { username: "arriving", location: { map: "main" } });
  reportCreaturesFrom(() => [{ map: "main", x: Number.NaN, y: 100, state: "idle" }]);
  await startCluster(store, address);
  const [load] = await nodes.loads();
  expect(load).toMatchObject({ players: 2, creatures: 1 });
  expect(load!.blocks).toEqual({ "main|0,0": 1 });
});

test("publishes the loaded maps' sizes, worlds included", async () => {
  const store = new MemoryStore();
  await withMaps([mainMap, { name: "bigworld.json", width: 1000, height: 10, tileWidth: 16, tileHeight: 16 }], async () => {
    await startCluster(store, address);
    expect(await new MapCatalogue(store).all()).toEqual([
      { name: "bigworld", widthPx: 16000, heightPx: 160, blocksX: 4, blocksY: 1 },
      { name: "main", widthPx: 6400, heightPx: 3200, blocksX: 2, blocksY: 1 },
    ]);
  });
});

test("keeps the block table, and says at once when it changed", async () => {
  const store = new MemoryStore();
  expect(clusterBlocks()).toBeNull();
  const changed: string[][] = [];
  const stopListening = onBlocksChanged((maps) => changed.push(maps));
  try {
    await withMaps([mainMap], async () => {
      await startCluster(store, address);
      const blocks = clusterBlocks();
      expect(blocks).not.toBeNull();
      expect(blocks!.ownerOf("main", 10, 10)).toBeNull();

      // The coordinator's write, from another process sharing the store.
      const coordinatorBus = new ClusterBus(store, "coordinator", BUS_KEY);
      const coordinator = new BlockTable(sealed(store));
      coordinator.attach(coordinatorBus);
      await coordinatorBus.start();
      await coordinator.write("main", { epoch: 1, owners: { "0,0": { nodeId: "a", epoch: 1, since: 0 }, "1,0": { nodeId: "b", epoch: 1, since: 0 } } });
      await settle();
      expect(blocks!.ownerOf("main", 10, 10)?.nodeId).toBe("a");
      // Told with the message, not on a later beat.
      expect(changed).toEqual([["main"]]);
      expect(spawnsHere("main", 10, 10)).toBe(false);
      expect(spawnsHere("main", 5000, 10)).toBe(true);

      await stopCluster();
      expect(clusterBlocks()).toBeNull();
      // Outside cluster mode a node spawns everywhere.
      expect(spawnsHere("main", 10, 10)).toBe(true);
    });
  } finally {
    stopListening();
  }
});

test("a missed message is caught by the re-read, which runs on its own timer", async () => {
  const store = new MemoryStore();
  const changed: string[][] = [];
  const stopListening = onBlocksChanged((maps) => changed.push(maps));
  try {
    await withMaps([mainMap], async () => {
      await startCluster(store, address, fast);
      // Written without a message: as if pub/sub dropped it.
      await sealed(store).set("cells:blocks:main", JSON.stringify({ epoch: 2, owners: { "0,0": { nodeId: "b", epoch: 2, since: 0 } } }));
      await until(() => clusterBlocks()!.ownerOf("main", 10, 10)?.nodeId === "b");
      expect(changed).toEqual([["main"]]);
    });
  } finally {
    stopListening();
  }
});

test("a failing re-read is logged as such, and the beat goes on", async () => {
  const store = new MemoryStore();
  const errors = spyOn(log, "error").mockImplementation(() => {});
  const nodes = new NodeRegistry(store);
  try {
    await withMaps([mainMap], async () => {
      await startCluster(store, address, fast);
      const refresh = spyOn(clusterBlocks()!, "refresh").mockImplementation(async () => { throw new Error("redis away"); });
      const beats = spyOn(NodeRegistry.prototype, "beat");
      try {
        await until(() => refresh.mock.calls.length >= 3 && beats.mock.calls.length >= 3);
        // Once, when it starts failing.
        const logged = errors.mock.calls.map((call) => String(call[0]));
        expect(logged.filter((line) => line.includes("redis away"))).toHaveLength(1);
        expect(logged.some((line) => line.includes("could not beat"))).toBe(false);
        expect((await nodes.live()).map((info) => info.nodeId)).toEqual(["b"]);
      } finally {
        refresh.mockRestore();
        beats.mockRestore();
      }
    });
  } finally {
    errors.mockRestore();
  }
});

// 2 x 2 blocks: 6400 x 6400 px.
const squareMap = { name: "main.json", width: 200, height: 200, tileWidth: 32, tileHeight: 32 };

test("a block no one owns is spawned only after the start grace, and the listeners are told when it ends", async () => {
  const store = new MemoryStore();
  const changed: string[][] = [];
  const stopListening = onBlocksChanged((maps) => changed.push(maps));
  try {
    await withMaps([squareMap], async () => {
      await new BlockTable(sealed(store)).write("main", { epoch: 1, owners: { "0,0": { nodeId: "b", epoch: 1, since: 0 }, "1,0": { nodeId: "a", epoch: 1, since: 0 } } });
      await startCluster(store, address, { beatMs: 10, unownedGraceMs: 60 });
      // Owned here, owned elsewhere, owned by no one (the coordinator has not got to it, or is down).
      expect(spawnsHere("main", 10, 10)).toBe(true);
      expect(spawnsHere("main", 5000, 10)).toBe(false);
      expect(spawnsHere("main.json", 10, 5000)).toBe(false);
      expect(changed).toEqual([]);

      await until(() => changed.length > 0);
      expect(changed).toEqual([["main"]]);
      expect(spawnsHere("main", 10, 5000)).toBe(true);
      expect(spawnsHere("main", 5000, 10)).toBe(false);
    });
  } finally {
    stopListening();
  }
});

test("while a coordinator holds the lock, blocks no one owns wait past the grace; the grace counts only without one", async () => {
  const store = new MemoryStore();
  const changed: string[][] = [];
  const stopListening = onBlocksChanged((maps) => changed.push(maps));
  try {
    await withMaps([squareMap], async () => {
      // A coordinator leads (settling, say): it has not split the map yet.
      await store.set("cells:coordinator", JSON.stringify({ holder: "coord", epoch: 1 }), 60_000);
      await startCluster(store, address, { beatMs: 10, unownedGraceMs: 60 });
      await sleep(200);
      expect(spawnsHere("main", 10, 10)).toBe(false);
      expect(changed).toEqual([]);

      // The coordinator is gone: the grace now runs, from the start (none of it ran while the lock was held).
      await store.del("cells:coordinator");
      const goneAt = Date.now();
      await until(() => changed.length > 0);
      expect(Date.now() - goneAt).toBeGreaterThanOrEqual(30);
      expect(changed).toEqual([["main"]]);
      expect(spawnsHere("main", 10, 10)).toBe(true);

      // A coordinator back: the blocks are its to give out again.
      await store.set("cells:coordinator", JSON.stringify({ holder: "coord-2", epoch: 2 }), 60_000);
      await until(() => !spawnsHere("main", 10, 10));
      expect(changed).toEqual([["main"]]);
    });
  } finally {
    stopListening();
  }
});

test("a position on or past a map's right or bottom edge is in the edge block", async () => {
  const store = new MemoryStore();
  // 256 x 128 tiles of 32 px: 8192 x 4096 px, exactly 2 x 1 blocks.
  await withMaps([{ name: "edge.json", width: 256, height: 128, tileWidth: 32, tileHeight: 32 }], async () => {
    await new BlockTable(sealed(store)).write("edge", { epoch: 1, owners: { "0,0": { nodeId: "a", epoch: 1, since: 0 }, "1,0": { nodeId: "b", epoch: 1, since: 0 } } });
    await startCluster(store, address);
    expect(clusterBlocks()!.ownerOf("edge", 8192, 4096)?.nodeId).toBe("b");
    expect(spawnsHere("edge", 8192, 10)).toBe(true);
    expect(spawnsHere("edge", 99_999, 99_999)).toBe(true);
    expect(spawnsHere("edge", 10, 4096)).toBe(false);
    // A login saved at x = width, on node a: handed to b, the edge block's owner (not played "here" as unowned).
    const b = { nodeId: "b", regionId: "local", ...address, startedAt: 1 };
    expect(routeLogin({ map: "edge", x: 8192, y: 0 }, clusterBlocks(), [b], "a")).toEqual({ switchTo: b });
  });
});

test("the load report counts a position on the far edge in the edge block", async () => {
  const store = new MemoryStore();
  const nodes = new NodeRegistry(store);
  playerCache.add("1", player("edge", 8192, 4096));
  await withMaps([{ name: "edge.json", width: 256, height: 128, tileWidth: 32, tileHeight: 32 }], async () => {
    await startCluster(store, address);
    const [load] = await nodes.loads();
    expect(load!.blocks).toEqual({ "edge|1,0": 1 });
  });
});

test("new layers above 1 take the world's numbers while the node is in the cluster", async () => {
  const store = new MemoryStore();
  // Other nodes have taken numbers up to 11.
  await store.incrBy("cells:layerseq:wiringtest", 10);
  const ids = Array.from({ length: MAX_PLAYERS_PER_LAYER + 2 }, (_, i) => `wiring-${i}`);
  try {
    await withMaps([{ name: "wiringtest.json", width: 10, height: 10, tileWidth: 32, tileHeight: 32 }], async () => {
      await startCluster(store, address);
      for (let i = 0; i < MAX_PLAYERS_PER_LAYER; i++) layerManager.assignPlayerToLayer(ids[i]!, "wiringtest", 10, 10);
      expect(layerManager.assignPlayerToLayer(ids[MAX_PLAYERS_PER_LAYER]!, "wiringtest", 10, 10)).toBe("wiringtest:layer_12");
      layerManager.removePlayerFromLayer(ids[MAX_PLAYERS_PER_LAYER]!);

      await stopCluster();
      // Back to the lowest free number.
      expect(layerManager.assignPlayerToLayer(ids[MAX_PLAYERS_PER_LAYER + 1]!, "wiringtest", 10, 10)).toBe("wiringtest:layer_2");
    });
  } finally {
    for (const id of ids) layerManager.removePlayerFromLayer(id);
  }
});
