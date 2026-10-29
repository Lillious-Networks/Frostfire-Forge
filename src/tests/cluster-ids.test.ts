import { expect, test } from "bun:test";
import { IdAllocator } from "../cluster/ids";
import { MemoryStore } from "../cluster/memorystore";

test("two nodes never hand out the same id", async () => {
  const store = new MemoryStore();
  const a = new IdAllocator(store, 8);
  const b = new IdAllocator(store, 8);
  await a.init();
  await b.init();
  const seen = new Set<number>();
  for (let i = 0; i < 40; i++) {
    for (const id of [a.next(), b.next()]) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    await Bun.sleep(0); // lets the spare block arrive
  }
});

test("ids are never 0 and fit in a u32", async () => {
  const store = new MemoryStore();
  await store.set("cells:ids", String(65_536 * 65_534)); // the last blocks of the u32 range
  const ids = new IdAllocator(store);
  await ids.init();
  const first = ids.next();
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThanOrEqual(0xffff_ffff);
  await store.set("cells:ids", String(65_536 * 65_535));
  const wrapped = new IdAllocator(store);
  await wrapped.init();
  expect(wrapped.next()).toBe(1);
});

test("next() before init() throws", () => {
  expect(() => new IdAllocator(new MemoryStore()).next()).toThrow();
});

// A store whose counter can be made to fail: what taking a block of ids runs on.
const flaky = () => {
  const store = new MemoryStore();
  const state = { failures: 0, calls: 0 };
  const incrBy = store.incrBy.bind(store);
  store.incrBy = async (key, amount) => {
    state.calls++;
    if (state.failures > 0) {
      state.failures--;
      throw new Error("redis is down");
    }
    return incrBy(key, amount);
  };
  return { store, state };
};

test("tryNext returns null, and next() throws, when the block is used up and no spare has arrived", async () => {
  const { store, state } = flaky();
  const ids = new IdAllocator(store, 4, 60_000);
  await ids.init();
  state.failures = Infinity;
  const got = [ids.tryNext(), ids.tryNext(), ids.tryNext(), ids.tryNext()];
  expect(got).toEqual([1, 2, 3, 4]);
  expect(ids.tryNext()).toBeNull();
  expect(() => ids.next()).toThrow();
});

test("a failed fetch of the next block is retried", async () => {
  const { store, state } = flaky();
  const ids = new IdAllocator(store, 4, 5);
  await ids.init();
  state.failures = 2;
  // Half way through the block asks for the spare; the first two asks fail.
  for (let i = 0; i < 4; i++) expect(ids.tryNext()).toBe(i + 1);
  await Bun.sleep(80);
  expect(state.calls).toBeGreaterThanOrEqual(4); // init, two failures, then the retry that worked
  expect(ids.tryNext()).toBe(5);
});

test("the spare block is fetched once half the block is used", async () => {
  const { store, state } = flaky();
  const ids = new IdAllocator(store, 8);
  await ids.init();
  expect(state.calls).toBe(1);
  for (let i = 0; i < 3; i++) ids.tryNext();
  expect(state.calls).toBe(1);
  ids.tryNext(); // the fifth id leaves less than half the block
  expect(state.calls).toBe(2);
});
