import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";
import { IdAllocator } from "../cluster/ids";
import { MemoryStore } from "../cluster/memorystore";
import { logNoIds, nextEntityId, resetEntityIds, useWorldIds } from "../cluster/entityids";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const { default: skeletons } = await import("../systems/skeletons");
const { default: lootChest } = await import("../systems/lootChest");
const { default: log } = await import("../modules/logger");

beforeEach(resetEntityIds);
afterEach(resetEntityIds);

test("without a cluster, ids count up from 1 in this process", () => {
  expect([nextEntityId(), nextEntityId(), nextEntityId()]).toEqual([1, 2, 3]);
});

test("once the node has an allocator, ids come from it", async () => {
  const ids = new IdAllocator(new MemoryStore(), 8);
  await ids.init();
  useWorldIds(ids);
  expect([nextEntityId(), nextEntityId()]).toEqual([1, 2]);
  expect(ids.next()).toBe(3); // the same counter the players' ids use
});

test("ids stay JS numbers, which the client checks for creatures and gathering nodes", async () => {
  expect(typeof nextEntityId()).toBe("number");
  const ids = new IdAllocator(new MemoryStore());
  await ids.init();
  useWorldIds(ids);
  expect(typeof nextEntityId()).toBe("number");
});

test("two nodes on one store never hand out the same id", async () => {
  const store = new MemoryStore();
  const a = new IdAllocator(store, 8);
  const b = new IdAllocator(store, 8);
  await a.init();
  await b.init();
  const seen = new Set<number>();
  for (let i = 0; i < 40; i++) {
    for (const node of [a, b]) {
      useWorldIds(node);
      const id = nextEntityId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    await Bun.sleep(0); // lets the spare blocks arrive
  }
});

test("when the allocator has no id to give, the spawn is refused with a clear error", async () => {
  const store = new MemoryStore();
  const ids = new IdAllocator(store, 2, 60_000);
  await ids.init();
  store.incrBy = async () => { throw new Error("redis is down"); };
  useWorldIds(ids);
  nextEntityId();
  nextEntityId();
  expect(() => nextEntityId()).toThrow(/No world ids left/);
});

test("detaching the allocator goes back to the local counter", async () => {
  const ids = new IdAllocator(new MemoryStore());
  await ids.init();
  useWorldIds(ids);
  nextEntityId();
  useWorldIds(null);
  expect(nextEntityId()).toBe(1);
});

test("a death marker is named by a world entity id, and is skipped when none can be had", () => {
  useWorldIds({ next: () => 4242 } as any);
  const marker = skeletons.spawn("main", 10, 20, "alice");
  expect(marker?.id).toBe("skeleton_4242");
  skeletons.despawn(marker!.id);

  useWorldIds({ next: () => { throw new Error("No world ids left"); } } as any);
  const errors = spyOn(log, "error").mockImplementation(() => {});
  try {
    expect(skeletons.spawn("main", 10, 20, "alice")).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
  } finally {
    errors.mockRestore();
  }
});

test("a loot chest is named by a world entity id", () => {
  useWorldIds({ next: () => 4242 } as any);
  const id = lootChest.spawn("main", 0, 0, 1);
  expect(id).toBe("chest_4242");
  lootChest.despawn(id);
});

test("when no id can be had no loot chest is made", () => {
  const before = lootChest.getOnMap("main").length;
  useWorldIds({ next: () => { throw new Error("No world ids left"); } } as any);
  expect(() => lootChest.spawn("main", 0, 0, 1)).toThrow(/No world ids left/);
  expect(lootChest.getOnMap("main")).toHaveLength(before);
});

test("an out-of-ids failure is logged once per 10 s per call site", () => {
  const errors = spyOn(log, "error").mockImplementation(() => {});
  try {
    logNoIds("creatures", "no ids a", 1_000);
    logNoIds("creatures", "no ids b", 5_000);
    logNoIds("gathering", "no ids c", 5_000);
    logNoIds("creatures", "no ids d", 10_999);
    expect(errors.mock.calls.map((call) => call[0])).toEqual(["no ids a", "no ids c"]);
    logNoIds("creatures", "no ids e", 11_000);
    expect(errors).toHaveBeenCalledTimes(3);
  } finally {
    errors.mockRestore();
  }
});

test("attaching world ids after local ids were handed out warns of collisions", async () => {
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const ids = new IdAllocator(new MemoryStore());
    await ids.init();
    useWorldIds(ids);
    expect(warns).not.toHaveBeenCalled();

    resetEntityIds();
    nextEntityId();
    useWorldIds(ids);
    expect(warns).toHaveBeenCalledTimes(1);
    expect(warns.mock.calls[0]![0]).toContain("1 local entity id");
  } finally {
    warns.mockRestore();
  }
});
