import { expect, test } from "bun:test";
import { MemoryStore } from "../cluster/memorystore";
import { MapCatalogue, extentOf } from "../cluster/maps";
import { NodeRegistry, type LoadReport, type NodeInfo } from "../cluster/nodes";

const info = (nodeId: string): NodeInfo => ({
  nodeId,
  regionId: "eu",
  publicHost: `${nodeId}.example.com`,
  port: 3000,
  wtPort: 3002,
  useSSL: true,
  startedAt: 1000,
});

const load = (nodeId: string): LoadReport => ({ nodeId, at: 5000, players: 3, creatures: 10, blocks: { "main|0,0": 3 } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a node is live only once announced and beating", async () => {
  const registry = new NodeRegistry(new MemoryStore());
  await registry.announce(info("b"));
  await registry.announce(info("a"));
  expect(await registry.live()).toEqual([]);
  await registry.beat("a");
  await registry.beat("b");
  expect((await registry.live()).map((n) => n.nodeId)).toEqual(["a", "b"]);
  expect(await registry.info("a")).toEqual(info("a"));
  expect(await registry.info("nope")).toBeNull();
});

test("a beating node that never announced is not live", async () => {
  const registry = new NodeRegistry(new MemoryStore());
  await registry.beat("ghost");
  expect(await registry.live()).toEqual([]);
});

test("a node that stops beating drops out of live but stays known", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(info("a"));
  await registry.beat("a");
  // Same key the beat writes, with a short ttl, to avoid waiting 3 s.
  await store.set("cells:alive:a", "1", 20);
  expect((await registry.live()).length).toBe(1);
  await sleep(40);
  expect(await registry.live()).toEqual([]);
  expect(await registry.info("a")).toEqual(info("a"));
});

test("retire drops alive and load, keeps info", async () => {
  const registry = new NodeRegistry(new MemoryStore());
  await registry.announce(info("a"));
  await registry.beat("a");
  await registry.report(load("a"));
  await registry.retire("a");
  expect(await registry.live()).toEqual([]);
  expect(await registry.loads()).toEqual([]);
  expect(await registry.info("a")).toEqual(info("a"));
});

test("loads are the reports of live nodes only", async () => {
  const registry = new NodeRegistry(new MemoryStore());
  await registry.announce(info("a"));
  await registry.announce(info("b"));
  await registry.beat("a");
  await registry.report(load("a"));
  await registry.report(load("b")); // b never beat: not live
  expect(await registry.loads()).toEqual([load("a")]);
});

test("a report expires with its ttl", async () => {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await registry.announce(info("a"));
  await registry.beat("a");
  await registry.report(load("a"));
  await store.set("cells:load:a", JSON.stringify(load("a")), 20);
  await sleep(40);
  expect(await registry.loads()).toEqual([]);
});

test("a re-announce replaces the info without duplicating the node", async () => {
  const registry = new NodeRegistry(new MemoryStore());
  await registry.announce(info("a"));
  await registry.announce({ ...info("a"), startedAt: 2000 });
  await registry.beat("a");
  const live = await registry.live();
  expect(live.length).toBe(1);
  expect(live[0]!.startedAt).toBe(2000);
});

test("extentOf rounds up to whole blocks, tiny maps are 1x1", () => {
  expect(extentOf("main", 4096, 4096)).toEqual({ name: "main", widthPx: 4096, heightPx: 4096, blocksX: 1, blocksY: 1 });
  expect(extentOf("main", 4097, 8192)).toEqual({ name: "main", widthPx: 4097, heightPx: 8192, blocksX: 2, blocksY: 2 });
  expect(extentOf("tiny", 320, 200)).toMatchObject({ blocksX: 1, blocksY: 1 });
  expect(extentOf("empty", 0, 0)).toMatchObject({ blocksX: 1, blocksY: 1 });
});

test("extentOf strips .json from the name", () => {
  expect(extentOf("main.json", 100, 100).name).toBe("main");
});

test("the catalogue round trips extents", async () => {
  const catalogue = new MapCatalogue(new MemoryStore());
  expect(await catalogue.all()).toEqual([]);
  const a = extentOf("a", 5000, 100);
  const b = extentOf("b", 100, 100);
  await catalogue.publish([b, a]);
  expect(await catalogue.all()).toEqual([a, b]);
});

test("publishing again replaces a map's extent", async () => {
  const catalogue = new MapCatalogue(new MemoryStore());
  await catalogue.publish([extentOf("a", 100, 100)]);
  await catalogue.publish([extentOf("a", 9000, 100)]);
  const all = await catalogue.all();
  expect(all.length).toBe(1);
  expect(all[0]!.blocksX).toBe(3);
});
