import { expect, spyOn, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { BlockTable, blockAt, blockKey, type MapBlocks } from "../cluster/blocks";
import { MemoryStore } from "../cluster/memorystore";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

const settle = () => new Promise((r) => setImmediate(r));

const table: MapBlocks = {
  epoch: 1,
  owners: {
    "0,0": { nodeId: "a", epoch: 1, since: 100 },
    "1,0": { nodeId: "b", epoch: 1, since: 100 },
    "0,1": { nodeId: "a", epoch: 1, since: 100 },
  },
};

test("blockAt floors by 4096 and clamps negatives to 0", () => {
  expect(blockAt(0, 0)).toEqual({ bx: 0, by: 0 });
  expect(blockAt(4095, 4095)).toEqual({ bx: 0, by: 0 });
  expect(blockAt(4096, 8192)).toEqual({ bx: 1, by: 2 });
  expect(blockAt(-1, -5000)).toEqual({ bx: 0, by: 0 });
  expect(blockKey(3, 4)).toBe("3,4");
});

test("an unknown map has no owners", async () => {
  const blocks = new BlockTable(new MemoryStore());
  expect(blocks.ownerOf("main", 10, 10)).toBeNull();
  expect(blocks.ownedBy("a", "main")).toEqual([]);
  expect(await blocks.load("main")).toEqual({ epoch: 0, owners: {} });
});

test("write then load and look up owners, .json is ignored", async () => {
  const store = new MemoryStore();
  const writer = new BlockTable(store);
  await writer.write("main", table);
  const reader = new BlockTable(store);
  expect(reader.ownerOf("main", 10, 10)).toBeNull(); // not loaded yet
  expect(await reader.load("main.json")).toEqual(table);
  expect(reader.ownerOf("main.json", 10, 10)?.nodeId).toBe("a");
  expect(reader.ownerOf("main", 4096, 0)?.nodeId).toBe("b");
  expect(reader.ownerOf("main", 4096, 4096)).toBeNull();
  expect(reader.ownedBy("a", "main").sort()).toEqual(["0,0", "0,1"]);
  expect(reader.ownedBy("b", "main")).toEqual(["1,0"]);
  expect(reader.ownedBy("c", "main")).toEqual([]);
});

test("preload fills the cache for each map", async () => {
  const store = new MemoryStore();
  const writer = new BlockTable(store);
  await writer.write("main", table);
  await writer.write("cave", { epoch: 2, owners: { "0,0": { nodeId: "b", epoch: 2, since: 5 } } });
  const reader = new BlockTable(store);
  await reader.preload(["main", "cave.json"]);
  expect(reader.ownerOf("main", 0, 0)?.nodeId).toBe("a");
  expect(reader.ownerOf("cave", 0, 0)?.nodeId).toBe("b");
});

test("another instance sees a write after the world message", async () => {
  const store = new MemoryStore();
  const writer = new BlockTable(store);
  const reader = new BlockTable(store);
  const writerBus = new ClusterBus(store, "coord", TEST_BUS_KEY);
  const readerBus = new ClusterBus(store, "n1", TEST_BUS_KEY);
  writer.attach(writerBus);
  reader.attach(readerBus);
  await writerBus.start();
  await readerBus.start();

  await reader.load("main");
  expect(reader.ownerOf("main", 0, 0)).toBeNull();
  await writer.write("main", table);
  await settle();
  await settle();
  expect(reader.ownerOf("main", 0, 0)?.nodeId).toBe("a");

  await writer.write("main", { epoch: 2, owners: { "0,0": { nodeId: "b", epoch: 2, since: 200 } } });
  await settle();
  await settle();
  expect(reader.ownerOf("main", 0, 0)?.nodeId).toBe("b");
  expect(reader.ownedBy("a", "main")).toEqual([]);
});

test("a corrupt stored table reads as empty", async () => {
  const store = new MemoryStore();
  await store.set("cells:blocks:main", "not json");
  expect(await new BlockTable(store).load("main")).toEqual({ epoch: 0, owners: {} });
});

test("blockAt maps non-finite input to block 0", () => {
  expect(blockAt(NaN, Infinity)).toEqual({ bx: 0, by: 0 });
  expect(blockAt(-Infinity, 5000)).toEqual({ bx: 0, by: 1 });
});

test("a stored table of the wrong shape reads as empty and ownerOf does not throw", async () => {
  for (const raw of [
    '{"epoch":1}', "{}", "null", '{"epoch":"1","owners":{}}', '{"epoch":1,"owners":null}', "5",
    // owners must be an object of owner objects, each with a string nodeId
    '{"epoch":1,"owners":[]}', '{"epoch":1,"owners":[{"nodeId":"a","epoch":1,"since":1}]}',
    '{"epoch":1,"owners":{"0,0":null}}', '{"epoch":1,"owners":{"0,0":"a"}}', '{"epoch":1,"owners":{"0,0":{"nodeId":5}}}',
    '{"epoch":1,"owners":{"0,0":{"epoch":1}}}',
  ]) {
    const store = new MemoryStore();
    await store.set("cells:blocks:main", raw);
    const blocks = new BlockTable(store);
    expect(await blocks.load("main")).toEqual({ epoch: 0, owners: {} });
    expect(blocks.ownerOf("main", 0, 0)).toBeNull();
    expect(blocks.ownedBy("a", "main")).toEqual([]);
  }
});

test("readStored tells an absent table from a corrupt one", async () => {
  const store = new MemoryStore();
  const blocks = new BlockTable(store);
  expect(await blocks.readStored("main")).toEqual({ state: "absent" });
  await store.set("cells:blocks:main", "not json");
  expect(await blocks.readStored("main")).toEqual({ state: "corrupt" });
  await store.set("cells:blocks:main", '{"epoch":1}');
  expect(await blocks.readStored("main.json")).toEqual({ state: "corrupt" });
  await store.set("cells:blocks:main", '{"epoch":1,"owners":{"0,0":{"nodeId":7}}}');
  expect(await blocks.readStored("main")).toEqual({ state: "corrupt" });
  await store.set("cells:blocks:main", JSON.stringify(table));
  expect(await blocks.readStored("main")).toEqual({ state: "ok", table });
});

test("write caches a copy, not the caller's object", async () => {
  const blocks = new BlockTable(new MemoryStore());
  const mine: MapBlocks = structuredClone(table);
  await blocks.write("main", mine);
  mine.owners["0,0"]!.nodeId = "z";
  delete mine.owners["1,0"];
  expect(blocks.ownerOf("main", 0, 0)?.nodeId).toBe("a");
  expect(blocks.ownerOf("main", 4096, 0)?.nodeId).toBe("b");
});

test("writeIfEpoch writes only over the epoch it was told (0 when absent), then caches and tells the world", async () => {
  const store = new MemoryStore();
  const writer = new BlockTable(store);
  const reader = new BlockTable(store);
  const writerBus = new ClusterBus(store, "coord", TEST_BUS_KEY);
  const readerBus = new ClusterBus(store, "n1", TEST_BUS_KEY);
  writer.attach(writerBus);
  reader.attach(readerBus);
  await writerBus.start();
  await readerBus.start();
  await reader.load("main");

  expect(await writer.writeIfEpoch("main", 1, table)).toBe(false); // nothing there yet: epoch 0
  expect(await store.get("cells:blocks:main")).toBeNull();
  expect(await writer.writeIfEpoch("main.json", 0, table)).toBe(true);
  await settle();
  await settle();
  expect(reader.ownerOf("main", 0, 0)?.nodeId).toBe("a");

  // A stale writer, still at epoch 0, is refused and changes nothing, its own cache included.
  const stale = new BlockTable(store);
  await stale.load("main");
  const older: MapBlocks = { epoch: 1, owners: { "0,0": { nodeId: "z", epoch: 1, since: 1 } } };
  expect(await stale.writeIfEpoch("main", 0, older)).toBe(false);
  expect(JSON.parse((await store.get("cells:blocks:main"))!)).toEqual(table);
  expect(stale.ownerOf("main", 0, 0)?.nodeId).toBe("a");

  const newer: MapBlocks = { epoch: 2, owners: { "0,0": { nodeId: "b", epoch: 2, since: 200 } } };
  expect(await writer.writeIfEpoch("main", 1, newer)).toBe(true);
  newer.owners["0,0"]!.nodeId = "y"; // the cache holds a copy
  expect(writer.ownerOf("main", 0, 0)?.nodeId).toBe("b");
  await settle();
  await settle();
  expect(reader.ownerOf("main", 0, 0)?.nodeId).toBe("b");
});

test("refresh picks up a table whose world message was missed", async () => {
  const store = new MemoryStore();
  const reader = new BlockTable(store);
  await reader.preload(["main", "cave"]);
  // Written behind the reader's back: no bus, so no message reaches it.
  const writer = new BlockTable(store);
  await writer.write("main", table);
  await writer.write("cave", { epoch: 3, owners: { "0,0": { nodeId: "b", epoch: 3, since: 5 } } });
  expect(reader.ownerOf("main", 0, 0)).toBeNull();

  await reader.refresh(["main"]);
  expect(reader.ownerOf("main", 0, 0)?.nodeId).toBe("a");
  expect(reader.ownerOf("cave", 0, 0)).toBeNull();

  await reader.refresh();
  expect(reader.ownerOf("cave", 0, 0)?.nodeId).toBe("b");
});

test("an older read landing after a newer write does not replace it", async () => {
  const store = new MemoryStore();
  await store.set("cells:blocks:main", JSON.stringify(table)); // epoch 1
  const blocks = new BlockTable(store);
  // The read gets the epoch 1 table, then is held until the write of epoch 2 is cached.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    const raw = await get(key);
    await held;
    return raw;
  };
  const loading = blocks.load("main");
  store.get = get;
  const newer: MapBlocks = { epoch: 2, owners: { "0,0": { nodeId: "b", epoch: 2, since: 200 } } };
  await blocks.write("main", newer);
  release();
  expect(await loading).toEqual(newer);
  expect(blocks.ownerOf("main", 0, 0)?.nodeId).toBe("b");
});

test("onChange tells each map whose epoch changed: by a world message, a refresh or a write", async () => {
  const store = new MemoryStore();
  const writerBus = new ClusterBus(store, "coordinator", TEST_BUS_KEY);
  const writer = new BlockTable(store);
  writer.attach(writerBus);
  await writerBus.start();
  const readerBus = new ClusterBus(store, "b", TEST_BUS_KEY);
  const reader = new BlockTable(store);
  reader.attach(readerBus);
  await readerBus.start();
  const told: string[] = [];
  const writes: string[] = [];
  const stop = reader.onChange((map) => told.push(map));
  writer.onChange((map) => writes.push(map));

  // An empty map (epoch 0) loaded for the first time is no change.
  await reader.preload(["main", "cave"]);
  expect(told).toEqual([]);

  await writer.write("main", table);
  await settle();
  expect(told).toEqual(["main"]);
  expect(writes).toEqual(["main"]);

  // Same epoch read again: nothing to tell.
  await reader.refresh();
  expect(told).toEqual(["main"]);

  // A message that never came: the refresh finds it.
  await store.set("cells:blocks:cave", JSON.stringify({ epoch: 3, owners: {} }));
  await reader.refresh();
  expect(told).toEqual(["main", "cave"]);

  stop();
  await writer.write("main", { ...table, epoch: 2 });
  await settle();
  expect(told).toEqual(["main", "cave"]);
});

test("a listener that throws does not stop the others or the reload", async () => {
  const store = new MemoryStore();
  const reader = new BlockTable(store);
  const told: string[] = [];
  reader.onChange(() => { throw new Error("boom"); });
  reader.onChange((map) => told.push(map));
  await store.set("cells:blocks:main", JSON.stringify(table));
  const { default: log } = await import("../modules/logger");
  const errors = spyOn(log, "error").mockImplementation(() => {});
  try {
    await reader.refresh(["main"]);
  } finally {
    errors.mockRestore();
  }
  expect(told).toEqual(["main"]);
  expect(reader.ownerOf("main", 10, 10)?.nodeId).toBe("a");
});

test("ownersOf and maps read the cache", async () => {
  const blocks = new BlockTable(new MemoryStore());
  expect(blocks.ownersOf("nowhere")).toEqual({});
  expect(blocks.maps()).toEqual([]);
  await blocks.write("main", table);
  expect(blocks.ownersOf("main.json")).toEqual(table.owners);
  expect(blocks.ownersOf("nowhere")).toEqual({});
  expect(blocks.maps()).toContain("main");
});

test("a lookup by map name uses no regex, and takes off one .json only", async () => {
  const blocks = new BlockTable(new MemoryStore());
  await blocks.write("main", table);
  const replace = spyOn(String.prototype, "replace");
  try {
    for (let i = 0; i < 100; i++) {
      expect(blocks.ownersOf("main.json")).toEqual(table.owners);
      expect(blocks.ownerOf("main", 10, 10)?.nodeId).toBe("a");
    }
    expect(replace).not.toHaveBeenCalled();
  } finally {
    replace.mockRestore();
  }
  expect(blocks.ownersOf("main.json.json")).toEqual({});
  expect(blocks.ownersOf("main.jsonx")).toEqual({});
  expect(blocks.ownersOf("json")).toEqual({});
});
