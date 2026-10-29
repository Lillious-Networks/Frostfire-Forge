import { expect, test } from "bun:test";
import { ClusterBus, nodeChannel } from "../cluster/bus";
import { MemoryStore } from "../cluster/memorystore";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a message to a node reaches that node only", async () => {
  const store = new MemoryStore();
  const a = new ClusterBus(store, "a", TEST_BUS_KEY);
  const b = new ClusterBus(store, "b", TEST_BUS_KEY);
  await a.start();
  await b.start();
  const got: string[] = [];
  a.on("hello", (data, from) => got.push(`a:${data.n}:${from}`));
  b.on("hello", (data, from) => got.push(`b:${data.n}:${from}`));
  await a.toNode("b", "hello", { n: 1 });
  await settle();
  expect(got).toEqual(["b:1:a"]);
});

test("a world message reaches every node, the sender too", async () => {
  const store = new MemoryStore();
  const a = new ClusterBus(store, "a", TEST_BUS_KEY);
  const b = new ClusterBus(store, "b", TEST_BUS_KEY);
  await a.start();
  await b.start();
  const got: string[] = [];
  a.on("all", () => got.push("a"));
  b.on("all", () => got.push("b"));
  await b.toWorld("all", {});
  await settle();
  expect(got.sort()).toEqual(["a", "b"]);
});

test("one handler per kind", () => {
  const bus = new ClusterBus(new MemoryStore(), "a", TEST_BUS_KEY);
  bus.on("x", () => {});
  expect(() => bus.on("x", () => {})).toThrow();
});

test("a handler that throws does not stop the next message", async () => {
  const store = new MemoryStore();
  const bus = new ClusterBus(store, "a", TEST_BUS_KEY);
  await bus.start();
  let ok = 0;
  bus.on("bad", () => { throw new Error("boom"); });
  bus.on("good", () => { ok++; });
  await bus.toNode("a", "bad", {});
  await bus.toNode("a", "good", {});
  await settle();
  await settle();
  expect(ok).toBe(1);
});

test("a message that parses to a non-object is dropped", async () => {
  const store = new MemoryStore();
  const bus = new ClusterBus(store, "a", TEST_BUS_KEY);
  await bus.start();
  let got = 0;
  bus.on("ok", () => { got++; });
  await store.publish(nodeChannel("a"), "null");
  await store.publish(nodeChannel("a"), "42");
  await bus.toNode("a", "ok", {});
  await settle();
  expect(got).toBe(1);
});
