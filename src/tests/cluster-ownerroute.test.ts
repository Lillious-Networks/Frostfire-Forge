import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { databaseModule } from "./setup";
import { mock } from "bun:test";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const { GatewayClient } = await import("../modules/gateway-client");
const { default: log } = await import("../modules/logger");
const { BlockTable, blockKey } = await import("../cluster/blocks");
const { MemoryStore } = await import("../cluster/memorystore");
const { MAX_REPORT_BLOCKS, MAX_REPORT_NODES, NO_OWNER, REPORT_ALPHABET, decodeBlockOwner, encodeBlockReport, reportOf } = await import("../cluster/blockreport");
type BlockReport = import("../cluster/blockreport").BlockReport;
type MapBlocks = import("../cluster/blocks").MapBlocks;

// The Gateway is told who owns which block (POST /blocks) so a login can go straight to the owner of its saved point.
// The same report, 3 x 2 blocks row by row, is the fixture of the Gateway's own test (src/modules/ownerroute.test.ts).
//   row 0: node-1 node-2 (none)    row 1: node-2 node-1 node-1
const FIXTURE: BlockReport = { map: "overworld", epoch: 7, blockPx: 4096, blocksX: 3, blocksY: 2, nodes: ["node-1", "node-2"], owners: "01.100" };
const FIXTURE_TABLE: MapBlocks = {
  epoch: 7,
  owners: {
    "0,0": { nodeId: "node-1", epoch: 7, since: 1 },
    "1,0": { nodeId: "node-2", epoch: 7, since: 1 },
    "0,1": { nodeId: "node-2", epoch: 7, since: 1 },
    "1,1": { nodeId: "node-1", epoch: 7, since: 1 },
    "2,1": { nodeId: "node-1", epoch: 7, since: 1 },
  },
};

// ---- the encoding ----------------------------------------------------------------------------------------------

test("a table is encoded to the agreed layout, one character per block, node by first appearance", () => {
  expect(encodeBlockReport("overworld", FIXTURE_TABLE, { blocksX: 3, blocksY: 2 })).toEqual(FIXTURE);
  // ".json" is not part of the name the Gateway keys by.
  expect(encodeBlockReport("overworld.json", FIXTURE_TABLE, { blocksX: 3, blocksY: 2 })?.map).toBe("overworld");
  expect(decodeBlockOwner(FIXTURE, 0, 0)).toBe("node-1");
  expect(decodeBlockOwner(FIXTURE, 4096, 0)).toBe("node-2");
  expect(decodeBlockOwner(FIXTURE, 8192, 0)).toBeNull();
  expect(NO_OWNER).toBe(".");
});

test("a table that cannot be reported is not: no epoch, no size, too large, too many nodes, a bad name", () => {
  const extent = { blocksX: 3, blocksY: 2 };
  expect(encodeBlockReport("m", { epoch: 0, owners: {} }, extent)).toBeNull();
  expect(encodeBlockReport("m", FIXTURE_TABLE, undefined)).toBeNull();
  expect(encodeBlockReport("m", FIXTURE_TABLE, { blocksX: 0, blocksY: 2 })).toBeNull();
  expect(encodeBlockReport("m", FIXTURE_TABLE, { blocksX: 257, blocksY: 257 })).toBeNull();
  expect(encodeBlockReport("m", FIXTURE_TABLE, { blocksX: 256, blocksY: 256 })?.owners.length).toBe(MAX_REPORT_BLOCKS);
  expect(encodeBlockReport("", FIXTURE_TABLE, extent)).toBeNull();
  expect(encodeBlockReport("m".repeat(129), FIXTURE_TABLE, extent)).toBeNull();
  expect(encodeBlockReport("m", FIXTURE_TABLE, extent, 0)).toBeNull();
  // One node per block: as many as the alphabet holds is fine, one more is not.
  const owners = (count: number): MapBlocks => ({
    epoch: 1,
    owners: Object.fromEntries(Array.from({ length: count }, (_, i) => [blockKey(i, 0), { nodeId: `n${i}`, epoch: 1, since: 1 }])),
  });
  expect(encodeBlockReport("m", owners(MAX_REPORT_NODES), { blocksX: 70, blocksY: 1 })?.nodes.length).toBe(MAX_REPORT_NODES);
  expect(encodeBlockReport("m", owners(MAX_REPORT_NODES + 1), { blocksX: 70, blocksY: 1 })).toBeNull();
  expect(REPORT_ALPHABET.length).toBe(MAX_REPORT_NODES);
  expect(encodeBlockReport("m", { epoch: 1, owners: { "0,0": { nodeId: "x".repeat(129), epoch: 1, since: 1 } } }, extent)).toBeNull();
});

test("a decoded owner equals BlockTable.ownerOf for random tables and points, far edges included", async () => {
  let seed = 987654;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const store = new MemoryStore();
  const blocks = new BlockTable(store);
  for (let round = 0; round < 40; round++) {
    const map = `map-${round}`;
    const blocksX = 1 + Math.floor(random() * 10);
    const blocksY = 1 + Math.floor(random() * 10);
    const nodeCount = 1 + Math.floor(random() * 5);
    const owners: MapBlocks["owners"] = {};
    for (let by = 0; by < blocksY; by++) for (let bx = 0; bx < blocksX; bx++) if (random() < 0.85) owners[blockKey(bx, by)] = { nodeId: `node-${Math.floor(random() * nodeCount) + 1}`, epoch: 1, since: 1 };
    // A key outside the map must not matter: the table clamps every position into the extent.
    owners[blockKey(blocksX + 3, 0)] = { nodeId: "node-stray", epoch: 1, since: 1 };
    blocks.useExtents([{ name: map, blocksX, blocksY }]);
    await blocks.write(map, { epoch: 1 + round, owners });
    const report = reportOf(blocks, map);
    expect(report).not.toBeNull();
    if (!report) return;
    const width = blocksX * 4096;
    const height = blocksY * 4096;
    const points: Array<[number, number]> = [
      [0, 0], [width, height], [width - 1, height - 1], [width + 4096, height + 40960], [-1, -4096], [NaN, 7], [Infinity, -Infinity], [width, 0], [0, height],
    ];
    for (let i = 0; i < 50; i++) points.push([Math.floor(random() * (width + 8192)) - 4096, Math.floor(random() * (height + 8192)) - 4096]);
    for (const [x, y] of points) {
      expect([map, x, y, decodeBlockOwner(report, x, y)]).toEqual([map, x, y, blocks.ownerOf(map, x, y)?.nodeId ?? null]);
    }
  }
});

test("a map the table does not know, or knows without a size, has no report", async () => {
  const blocks = new BlockTable(new MemoryStore());
  expect(reportOf(blocks, "nowhere")).toBeNull();
  await blocks.write("sizeless", { epoch: 2, owners: { "0,0": { nodeId: "a", epoch: 2, since: 1 } } });
  expect(reportOf(blocks, "sizeless")).toBeNull();
  blocks.useExtents([{ name: "sizeless", blocksX: 1, blocksY: 1 }]);
  expect(reportOf(blocks, "sizeless.json")?.owners).toBe("0");
});

// ---- the report goes to the gateway ----------------------------------------------------------------------------------

const config = (over: Partial<ServerRegistrationConfig> = {}): ServerRegistrationConfig => ({
  gatewayUrl: "http://gateway.test",
  assetServerUrl: null,
  serverId: "realm-1",
  description: "",
  host: "localhost",
  publicHost: "b.example.com",
  port: 3000,
  wtPort: 3000,
  maxConnections: 10,
  heartbeatInterval: 5000,
  nodeId: "node-1",
  regionId: "eu",
  ...over,
});

/** A block table stand-in: the maps and what it says about them, and the listeners onChange was given. */
function fakeSource(maps: Record<string, { epoch: number; owners: string }> = { overworld: { epoch: 7, owners: "01.100" } }) {
  const listeners = new Set<(map: string) => void>();
  const source = {
    state: maps,
    listeners,
    maps: () => Object.keys(source.state),
    epochOf: (map: string) => source.state[map]?.epoch ?? 0,
    extentOf: (map: string) => (source.state[map] ? { blocksX: 3, blocksY: 2 } : undefined),
    ownersOf: (map: string) => {
      const out: MapBlocks["owners"] = {};
      const text = source.state[map]?.owners ?? "";
      for (let i = 0; i < text.length; i++) if (text[i] !== ".") out[blockKey(i % 3, Math.floor(i / 3))] = { nodeId: `node-${Number(text[i]) + 1}`, epoch: 1, since: 1 };
      return out;
    },
    onChange: (listener: (map: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    change: (map: string) => { for (const listener of listeners) listener(map); },
  };
  return source;
}

interface Sent { url: string; body: any }
let restore = () => {};
afterEach(() => restore());

/** Answers every call with success, except what `blocks` says about /blocks. */
function gateway(blocks: (sent: Sent, count: number) => Response = () => new Response(JSON.stringify({ success: true, stored: true }))) {
  const sent: Sent[] = [];
  let blockCalls = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const entry = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) };
    sent.push(entry);
    if (entry.url.endsWith("/blocks")) return blocks(entry, ++blockCalls);
    return new Response(JSON.stringify({ success: true, outdatedMaps: [] }));
  }) as any);
  const quiet = [spyOn(log, "error").mockImplementation(() => {}), spyOn(log, "warn").mockImplementation(() => {}), spyOn(log, "info").mockImplementation(() => {}), spyOn(log, "success").mockImplementation(() => {})];
  const priorKey = process.env.GATEWAY_AUTH_KEY;
  process.env.GATEWAY_AUTH_KEY = "test-gateway-key";
  restore = () => {
    fetchSpy.mockRestore();
    for (const spy of quiet) spy.mockRestore();
    if (priorKey === undefined) delete process.env.GATEWAY_AUTH_KEY;
    else process.env.GATEWAY_AUTH_KEY = priorKey;
  };
  return { sent, blocksSent: () => sent.filter((entry) => entry.url.endsWith("/blocks")) };
}

const asRegistered = (client: InstanceType<typeof GatewayClient>) => { (client as any).registered = true; };
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

test("a change is reported once for a burst of changes, with the last state of the table, and only for the maps that changed", async () => {
  const { blocksSent } = gateway();
  const source = fakeSource({ overworld: { epoch: 7, owners: "01.100" }, cave: { epoch: 2, owners: "000000" } });
  const client = new GatewayClient(config());
  client.blocksCoalesceMs = 20;
  asRegistered(client);
  client.reportBlocksFrom(source);
  source.change("overworld");
  source.change("overworld");
  source.state.overworld = { epoch: 8, owners: "111111" };
  source.change("overworld");
  source.change("cave");
  await settle();
  const sent = blocksSent();
  expect(sent.length).toBe(2);
  const overworld = sent.find((entry) => entry.body.map === "overworld")!;
  expect(overworld.body).toMatchObject({ id: "node-1", authKey: "test-gateway-key", map: "overworld", epoch: 8, blockPx: 4096, blocksX: 3, blocksY: 2, nodes: ["node-2"], owners: "000000" });
  expect(sent.find((entry) => entry.body.map === "cave")!.body.epoch).toBe(2);
  // Later changes go out in a group of their own.
  source.state.cave = { epoch: 3, owners: "111111" };
  source.change("cave");
  await settle();
  expect(blocksSent().length).toBe(3);
  expect(blocksSent()[2]!.body).toMatchObject({ map: "cave", epoch: 3 });
});

test("registering sends every map once, after the heartbeat; a heartbeat alone never sends them", async () => {
  const { sent, blocksSent } = gateway();
  const source = fakeSource({ overworld: { epoch: 7, owners: "01.100" }, cave: { epoch: 2, owners: "000000" }, empty: { epoch: 0, owners: "" } });
  const client = new GatewayClient(config());
  client.reportBlocksFrom(source);
  expect(await client.register(true)).toBe(true);
  await settle();
  const urls = sent.map((entry) => entry.url.replace("http://gateway.test", ""));
  expect(urls.slice(0, 2)).toEqual(["/register", "/heartbeat"]);
  expect(urls.indexOf("/blocks")).toBeGreaterThan(1);
  // The map with no table yet (epoch 0) is not reported.
  expect(blocksSent().map((entry) => entry.body.map).sort()).toEqual(["cave", "overworld"]);
  // Heartbeats, by timer or by hand, carry no block report.
  const before = blocksSent().length;
  await (client as any).sendHeartbeat();
  await (client as any).sendHeartbeat();
  await client.heartbeatNow();
  await settle();
  expect(blocksSent().length).toBe(before);
  // Registering again (the gateway restarted; the heartbeat timer was stopped by the failed beat) sends them again.
  clearInterval((client as any).heartbeatTimer);
  expect(await client.register(true)).toBe(true);
  await settle();
  expect(blocksSent().length).toBe(before + 2);
  await client.unregister();
});

test("nothing is sent with the cluster off: no node id, no subscription, no report", async () => {
  const { blocksSent } = gateway();
  const source = fakeSource();
  const client = new GatewayClient(config({ nodeId: undefined, regionId: undefined }));
  client.blocksCoalesceMs = 10;
  client.reportBlocksFrom(source);
  expect(source.listeners.size).toBe(0);
  expect(await client.register(true)).toBe(true);
  source.change("overworld");
  await settle();
  expect(blocksSent().length).toBe(0);
  await client.unregister();
  // A client that was never given a table sends nothing either.
  const bare = new GatewayClient(config());
  expect(await bare.register(true)).toBe(true);
  await settle();
  expect(blocksSent().length).toBe(0);
  await bare.unregister();
});

test("a change before the node is registered is not sent (registering sends the table), and none after it left", async () => {
  const { blocksSent } = gateway();
  const source = fakeSource();
  const client = new GatewayClient(config());
  client.blocksCoalesceMs = 10;
  client.reportBlocksFrom(source);
  source.change("overworld");
  await settle();
  expect(blocksSent().length).toBe(0);
  asRegistered(client);
  await client.unregister();
  expect(source.listeners.size).toBe(0);
  source.change("overworld");
  await settle();
  expect(blocksSent().length).toBe(0);
});

test("a report the gateway refused is tried again a few times; a 404 is not, and the key is never logged", async () => {
  const failing = gateway((_entry, count) => (count < 3 ? new Response(JSON.stringify({ error: "busy" }), { status: 500 }) : new Response(JSON.stringify({ success: true }))));
  const source = fakeSource();
  const client = new GatewayClient(config());
  client.blocksCoalesceMs = 5;
  client.blocksRetryMs = 15;
  asRegistered(client);
  client.reportBlocksFrom(source);
  source.change("overworld");
  await settle(300);
  expect(failing.blocksSent().length).toBe(3);
  restore();

  const gone = gateway(() => new Response(JSON.stringify({ error: "Server not found" }), { status: 404 }));
  const other = new GatewayClient(config());
  other.blocksCoalesceMs = 5;
  other.blocksRetryMs = 15;
  asRegistered(other);
  const otherSource = fakeSource();
  other.reportBlocksFrom(otherSource);
  otherSource.change("overworld");
  await settle(150);
  expect(gone.blocksSent().length).toBe(1);
  restore();

  // Retries stop at the limit and the failure is logged by map name, with no key in it.
  const warn: string[] = [];
  const never = gateway(() => new Response("nope", { status: 503 }));
  spyOn(log, "warn").mockImplementation(((message: string) => { warn.push(message); }) as any);
  const last = new GatewayClient(config());
  last.blocksCoalesceMs = 5;
  last.blocksRetryMs = 10;
  asRegistered(last);
  const lastSource = fakeSource();
  last.reportBlocksFrom(lastSource);
  lastSource.change("overworld");
  await settle(300);
  expect(never.blocksSent().length).toBe(4);
  expect(warn.some((line) => line.includes("overworld"))).toBe(true);
  expect(warn.join("\n")).not.toContain("test-gateway-key");
});

test("the node's server wires the report only in cluster mode, before it registers", () => {
  const source = readFileSync(new URL("../socket/server.ts", import.meta.url), "utf8");
  const wire = source.indexOf("gatewayClient.reportBlocksFrom(blockTable)");
  expect(wire).toBeGreaterThan(0);
  expect(source.slice(source.lastIndexOf("const blockTable", wire), wire)).toContain("cluster ? clusterBlocks() : null");
  expect(wire).toBeLessThan(source.indexOf("await gatewayClient.registerWithRetry()"));
});

test("a report that used up its retries is sent again at the next good heartbeat, with the table as it is then, until it gets through", async () => {
  const warn: string[] = [];
  const g = gateway((_entry, count) => (count <= 5 ? new Response("nope", { status: 503 }) : new Response(JSON.stringify({ success: true }))));
  spyOn(log, "warn").mockImplementation(((message: string) => { warn.push(message); }) as any);
  const source = fakeSource();
  const client = new GatewayClient(config());
  client.blocksCoalesceMs = 5;
  client.blocksRetryMs = 10;
  asRegistered(client);
  client.reportBlocksFrom(source);
  source.change("overworld");
  await settle(250);
  // First try and three retries: all refused.
  expect(g.blocksSent().length).toBe(4);
  expect(warn.length).toBe(1);
  // The table moves on without a change event (the event was the one that got lost): the resend carries the new one.
  source.state.overworld = { epoch: 9, owners: "111111" };
  // Heartbeat 1: the resend fails once more (the 5th call). No retries on it, and no second warning.
  await (client as any).sendHeartbeat();
  await settle(60);
  expect(g.blocksSent().length).toBe(5);
  expect(g.blocksSent()[4]!.body.epoch).toBe(9);
  expect(warn.length).toBe(1);
  // Heartbeat 2: it gets through (the 6th call), and the map is clean.
  await (client as any).sendHeartbeat();
  await settle(60);
  expect(g.blocksSent().length).toBe(6);
  expect(g.blocksSent()[5]!.body.epoch).toBe(9);
  // Heartbeat 3: nothing is dirty, so nothing is sent.
  await (client as any).sendHeartbeat();
  await settle(60);
  expect(g.blocksSent().length).toBe(6);
});

test("a heartbeat does not resend a map whose retries are still waiting, nor one the gateway answered 404 for", async () => {
  const waiting = gateway(() => new Response("nope", { status: 503 }));
  const source = fakeSource();
  const client = new GatewayClient(config());
  client.blocksCoalesceMs = 5;
  client.blocksRetryMs = 80;
  asRegistered(client);
  client.reportBlocksFrom(source);
  source.change("overworld");
  await settle(40);
  expect(waiting.blocksSent().length).toBe(1);
  // The first retry is on its timer: the heartbeat leaves it to the timer.
  await (client as any).sendHeartbeat();
  await settle(20);
  expect(waiting.blocksSent().length).toBe(1);
  await client.unregister();
  restore();

  const gone = gateway(() => new Response(JSON.stringify({ error: "Server not found" }), { status: 404 }));
  const other = new GatewayClient(config());
  other.blocksCoalesceMs = 5;
  const otherSource = fakeSource();
  asRegistered(other);
  other.reportBlocksFrom(otherSource);
  otherSource.change("overworld");
  await settle(40);
  await (other as any).sendHeartbeat();
  await settle(40);
  expect(gone.blocksSent().length).toBe(1);
  await other.unregister();
});

// ---- a report the gateway refuses for good ---------------------------------------------------------------------------

const refuse = (error = "No room for this map") => new Response(JSON.stringify({ error }), { status: 400 });
const accepted = () => new Response(JSON.stringify({ success: true, stored: true }));

test("a map the gateway refuses with a 400 is logged once by name and not sent again until its table changes; the other maps keep reporting", async () => {
  const warn: string[] = [];
  let full = true;
  const g = gateway((entry) => (full && entry.body.map === "house_1" ? refuse() : accepted()));
  spyOn(log, "warn").mockImplementation(((message: string) => { warn.push(message); }) as any);
  const source = fakeSource({ overworld: { epoch: 7, owners: "01.100" }, house_1: { epoch: 2, owners: "000000" }, house_2: { epoch: 3, owners: "111111" } });
  const client = new GatewayClient(config());
  client.blocksCoalesceMs = 5;
  client.blocksRetryMs = 10;
  asRegistered(client);
  client.reportBlocksFrom(source);
  const sentFor = (map: string) => g.blocksSent().filter((entry) => entry.body.map === map).length;
  for (const map of ["overworld", "house_1", "house_2"]) source.change(map);
  await settle(120);
  // A 400 is not retried: one call for the refused map, and the others got through.
  expect(sentFor("house_1")).toBe(1);
  expect(sentFor("overworld")).toBe(1);
  expect(sentFor("house_2")).toBe(1);
  expect(warn.length).toBe(1);
  expect(warn[0]).toContain("house_1");
  expect(warn[0]).not.toContain("overworld");
  expect(warn.join("\n")).not.toContain("test-gateway-key");
  // Good heartbeats do not send it again, and neither does a change of another map.
  await (client as any).sendHeartbeat();
  await (client as any).sendHeartbeat();
  await settle(60);
  source.change("house_2");
  await settle(60);
  expect(sentFor("house_1")).toBe(1);
  expect(sentFor("house_2")).toBe(2);
  // A change event for the same table (nothing new to say) is not sent either, and not logged again.
  source.change("house_1");
  await settle(60);
  expect(sentFor("house_1")).toBe(1);
  expect(warn.length).toBe(1);
  // Its table changes: the gateway is told of it, and takes it now.
  full = false;
  source.state.house_1 = { epoch: 3, owners: "111111" };
  source.change("house_1");
  await settle(60);
  expect(sentFor("house_1")).toBe(2);
  expect(g.blocksSent().filter((entry) => entry.body.map === "house_1")[1]!.body.epoch).toBe(3);
  // It is clean now: the change after that goes out as any other.
  source.state.house_1 = { epoch: 4, owners: "000000" };
  source.change("house_1");
  await settle(60);
  expect(sentFor("house_1")).toBe(3);
  expect(warn.length).toBe(1);
});

test("a map refused again after its table changed is logged again, once; registering again asks the gateway afresh", async () => {
  const warn: string[] = [];
  const g = gateway(() => refuse());
  spyOn(log, "warn").mockImplementation(((message: string) => { warn.push(message); }) as any);
  const source = fakeSource({ house_1: { epoch: 2, owners: "000000" } });
  const client = new GatewayClient(config());
  client.blocksCoalesceMs = 5;
  asRegistered(client);
  client.reportBlocksFrom(source);
  source.change("house_1");
  await settle(60);
  source.state.house_1 = { epoch: 3, owners: "111111" };
  source.change("house_1");
  await settle(60);
  expect(g.blocksSent().length).toBe(2);
  expect(warn.length).toBe(2);
  // The same table again, with another epoch counter value of its own, is a table that changed; the same epoch and owners is not.
  source.change("house_1");
  await settle(60);
  expect(g.blocksSent().length).toBe(2);
  // The owners change with no new epoch: that is a table that changed too.
  source.state.house_1 = { epoch: 3, owners: "000111" };
  source.change("house_1");
  await settle(60);
  expect(g.blocksSent().length).toBe(3);
  restore();

  // Registering sends every map once more (a gateway that was restarted, or replaced, may take it now).
  const again = gateway(() => refuse());
  const other = new GatewayClient(config());
  const otherSource = fakeSource({ house_1: { epoch: 2, owners: "000000" } });
  other.reportBlocksFrom(otherSource);
  expect(await other.register(true)).toBe(true);
  await settle(60);
  expect(again.blocksSent().length).toBe(1);
  clearInterval((other as any).heartbeatTimer);
  expect(await other.register(true)).toBe(true);
  await settle(60);
  expect(again.blocksSent().length).toBe(2);
  await other.unregister();
});

test("a transient failure is still retried and resent, and only a 400 (or 413) is final", async () => {
  const g = gateway((_entry, count) => (count === 1 ? new Response(JSON.stringify({ error: "busy" }), { status: 503 }) : accepted()));
  const source = fakeSource();
  const client = new GatewayClient(config());
  client.blocksCoalesceMs = 5;
  client.blocksRetryMs = 10;
  asRegistered(client);
  client.reportBlocksFrom(source);
  source.change("overworld");
  await settle(100);
  expect(g.blocksSent().length).toBe(2);
  restore();

  const big = gateway(() => new Response(JSON.stringify({ error: "Report too large" }), { status: 413 }));
  const large = new GatewayClient(config());
  large.blocksCoalesceMs = 5;
  large.blocksRetryMs = 10;
  asRegistered(large);
  const largeSource = fakeSource();
  large.reportBlocksFrom(largeSource);
  largeSource.change("overworld");
  await settle(100);
  expect(big.blocksSent().length).toBe(1);
});

test("the map a new character starts on is reported first, whatever the order the maps come in", async () => {
  const g = gateway();
  const maps: Record<string, { epoch: number; owners: string }> = {};
  for (let i = 0; i < 12; i++) maps[`house_${i}`] = { epoch: 2, owners: "000000" };
  maps.overworld = { epoch: 7, owners: "01.100" };
  maps.cave = { epoch: 2, owners: "000000" };
  const source = fakeSource(maps);
  const client = new GatewayClient(config());
  client.blocksFirstMap = "overworld";
  client.reportBlocksFrom(source);
  expect(await client.register(true)).toBe(true);
  await settle(150);
  const order = g.blocksSent().map((entry) => entry.body.map);
  expect(order.length).toBe(14);
  expect(order[0]).toBe("overworld");
  expect(new Set(order).size).toBe(14);
  await client.unregister();
  restore();

  // The same for changes that go out together, and for a name given with ".json".
  const changed = gateway();
  const other = new GatewayClient(config());
  other.blocksFirstMap = "cave.json";
  other.blocksCoalesceMs = 10;
  asRegistered(other);
  const otherSource = fakeSource(maps);
  other.reportBlocksFrom(otherSource);
  for (const map of ["house_3", "house_1", "cave", "overworld"]) otherSource.change(map);
  await settle(100);
  expect(changed.blocksSent().map((entry) => entry.body.map)).toEqual(["cave", "house_3", "house_1", "overworld"]);
});

test("the node's first map is the engine's default map, from the settings", async () => {
  // The same default the receiver gives new characters (src/socket/receiver.ts: defaultMap), whatever the settings say.
  const settings: any = await import("../config/settings.json");
  expect(new GatewayClient(config()).blocksFirstMap).toBe(settings.default_map?.replace(".json", "") || "main");
});
