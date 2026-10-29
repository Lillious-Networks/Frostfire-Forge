import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import log from "../modules/logger";
import { MemoryStore } from "../cluster/memorystore";
import { NodeRegistry, type NodeInfo } from "../cluster/nodes";
import { clearOnStart } from "../cluster/startclear";

// What a node's start may wipe in the shared database (player.clear: verification codes, party ids, guests, parties).
// In a cluster only the first node of a region does it: a node that starts or restarts next to running ones would
// delete the guests and parties of everyone playing there.

const info = (nodeId: string, regionId = "eu"): NodeInfo => ({
  nodeId, regionId, publicHost: `${nodeId}.example.com`, port: 3000, wtPort: 3002, useSSL: true, startedAt: 1000,
});

const saved = process.env.CLUSTER;
let warned: string[];
let infos: string[];
beforeEach(() => {
  warned = [];
  infos = [];
  spyOn(log, "warn").mockImplementation((m: any) => { warned.push(String(m)); });
  spyOn(log, "info").mockImplementation((m: any) => { infos.push(String(m)); });
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLUSTER;
  else process.env.CLUSTER = saved;
  (log.warn as any).mockRestore();
  (log.info as any).mockRestore();
});

async function registryWith(...beating: NodeInfo[]): Promise<NodeRegistry> {
  const registry = new NodeRegistry(new MemoryStore());
  for (const node of beating) {
    await registry.announce(node);
    await registry.beat(node.nodeId);
  }
  return registry;
}

test("without a cluster the clear runs as before and the registry is not read", async () => {
  process.env.CLUSTER = "false";
  let cleared = 0;
  const unread = { live: () => { throw new Error("read"); } } as unknown as NodeRegistry;
  expect(await clearOnStart(async () => { cleared++; }, unread, "a", "eu")).toBe(true);
  expect(await clearOnStart(async () => { cleared++; }, null, "a", "eu")).toBe(true);
  expect(cleared).toBe(2);
});

test("in a cluster with another node of the region alive nothing is cleared", async () => {
  process.env.CLUSTER = "true";
  const registry = await registryWith(info("a"), info("b"));
  let cleared = 0;
  expect(await clearOnStart(async () => { cleared++; }, registry, "a", "eu")).toBe(false);
  expect(cleared).toBe(0);
  expect(infos.join("\n")).toContain("b");
});

test("a node alone in its region clears; its own beat and other regions do not count", async () => {
  process.env.CLUSTER = "true";
  const registry = await registryWith(info("a"), info("c", "us"));
  let cleared = 0;
  expect(await clearOnStart(async () => { cleared++; }, registry, "a", "eu")).toBe(true);
  expect(cleared).toBe(1);
});

test("the old run of this same node still beating does not count as another node", async () => {
  process.env.CLUSTER = "true";
  // A quick restart: the run before this one beats for up to ALIVE_TTL_MS more, under the same node id.
  const registry = await registryWith({ ...info("a"), startedAt: 500 });
  await registry.announce({ ...info("a"), startedAt: 1000 });
  let cleared = 0;
  expect(await clearOnStart(async () => { cleared++; }, registry, "a", "eu")).toBe(true);
  expect(cleared).toBe(1);
});

test("a node that was announced but no longer beats does not hold the clear back", async () => {
  process.env.CLUSTER = "true";
  const registry = await registryWith(info("a"), info("b"));
  await registry.retire("b");
  let cleared = 0;
  expect(await clearOnStart(async () => { cleared++; }, registry, "a", "eu")).toBe(true);
  expect(cleared).toBe(1);
});

test("live nodes that cannot be read skip the clear and say so", async () => {
  process.env.CLUSTER = "true";
  let cleared = 0;
  const broken = { live: async () => { throw new Error("redis away"); } } as unknown as NodeRegistry;
  expect(await clearOnStart(async () => { cleared++; }, broken, "a", "eu")).toBe(false);
  expect(await clearOnStart(async () => { cleared++; }, null, "a", "eu")).toBe(false);
  expect(cleared).toBe(0);
  expect(warned.length).toBe(2);
  expect(warned[0]).toContain("redis away");
});

test("a clear that fails is not swallowed", async () => {
  process.env.CLUSTER = "true";
  const registry = await registryWith(info("a"));
  await expect(clearOnStart(async () => { throw new Error("database gone"); }, registry, "a", "eu")).rejects.toThrow("database gone");
});
