import { expect, spyOn, test } from "bun:test";
import { LayerNumbers } from "../cluster/layerseq";
import { MemoryStore } from "../cluster/memorystore";
import log from "../modules/logger";
import { LayerManager } from "../services/layermanager";

// Layer numbers above 1 come from one counter per map in the store, so two
// nodes never give one number to two different crowds.

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

// One player per layer: a block holds one player of a layer, so each new player opens a layer.
const crowded = (numbers: LayerNumbers | null) => {
  const manager = new LayerManager({ maxPlayersPerBlock: 1 });
  manager.useLayerNumbers(numbers);
  return manager;
};

test("numbers start at 2 and are not given twice, across nodes", async () => {
  const store = new MemoryStore();
  const a = new LayerNumbers(store, 2);
  const b = new LayerNumbers(store, 2);
  await a.prefill(["main.json"]);
  await b.prefill(["main"]);
  const taken = [a.take("main"), b.take("main"), a.take("main"), b.take("main")];
  expect(taken.every((n) => n !== null && n >= 2)).toBe(true);
  expect(new Set(taken).size).toBe(4);
  expect(Math.min(...(taken as number[]))).toBe(2);
});

test("layer 1 is every node's; layers above it take the reserved numbers", async () => {
  const store = new MemoryStore();
  const numbersA = new LayerNumbers(store, 4);
  const numbersB = new LayerNumbers(store, 4);
  await numbersA.prefill(["main"]);
  await numbersB.prefill(["main"]);
  const a = crowded(numbersA);
  const b = crowded(numbersB);
  expect(a.assignPlayerToLayer("1", "main", 10, 10)).toBe("main:layer_1");
  expect(b.assignPlayerToLayer("2", "main", 10, 10)).toBe("main:layer_1");
  const overflowA = a.assignPlayerToLayer("3", "main", 10, 10);
  const overflowB = b.assignPlayerToLayer("4", "main", 10, 10);
  expect(overflowA).not.toBe("main:layer_1");
  expect(overflowB).not.toBe("main:layer_1");
  expect(overflowA).not.toBe(overflowB);
});

test("the pool refills in the background as it is used", async () => {
  const numbers = new LayerNumbers(new MemoryStore(), 2);
  await numbers.prefill(["main"]);
  const first = [numbers.take("main"), numbers.take("main")];
  expect(numbers.take("main")).toBeNull();
  await settle();
  const next = numbers.take("main");
  expect(next).not.toBeNull();
  expect(first).not.toContain(next);
});

test("with no number ready the local rule is used, and that is logged once", () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    // Never prefilled, and a store that does not answer: the pool stays empty.
    const numbers = new LayerNumbers({ incrBy: () => new Promise<number>(() => {}) } as any, 2);
    const manager = crowded(numbers);
    expect(manager.assignPlayerToLayer("1", "main", 10, 10)).toBe("main:layer_1");
    expect(manager.assignPlayerToLayer("2", "main", 10, 10)).toBe("main:layer_2");
    expect(manager.assignPlayerToLayer("3", "main", 10, 10)).toBe("main:layer_3");
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("a reserved number already used here by the local rule is passed over", async () => {
  const store = new MemoryStore();
  const numbers = new LayerNumbers(store, 2);
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const manager = crowded(numbers);
    manager.assignPlayerToLayer("1", "main", 10, 10);
    // Empty pool: layer_2 by the local rule.
    expect(manager.assignPlayerToLayer("2", "main", 10, 10)).toBe("main:layer_2");
    await settle();
    // The pool now holds 2 and 3: 2 is in use here, so 3.
    expect(manager.assignPlayerToLayer("3", "main", 10, 10)).toBe("main:layer_3");
  } finally {
    warn.mockRestore();
  }
});

test("without a number source the layers are numbered as before", () => {
  const manager = crowded(null);
  expect(manager.assignPlayerToLayer("1", "main", 10, 10)).toBe("main:layer_1");
  expect(manager.assignPlayerToLayer("2", "main", 10, 10)).toBe("main:layer_2");
});
