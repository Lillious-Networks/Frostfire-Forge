import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const { GatewayClient } = await import("../modules/gateway-client");
const { default: log } = await import("../modules/logger");
type MapBlocks = import("../cluster/blocks").MapBlocks;

// In cluster mode a node registers with the gateway under its node id (one
// realm is many nodes), and says which node and region it is.

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
  ...over,
});

// The gateway answers "no": nothing goes on to heartbeats or the map sync, so each call sends one request.
function capture() {
  const bodies: Array<{ url: string; body: any }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    bodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ success: false }));
  }) as any);
  const quiet = [spyOn(log, "error").mockImplementation(() => {}), spyOn(log, "warn").mockImplementation(() => {})];
  return { bodies, restore: () => { fetchSpy.mockRestore(); for (const spy of quiet) spy.mockRestore(); } };
}

let restore = () => {};
afterEach(() => restore());

test("a node registers and beats under its node id, with its node and region", async () => {
  const sent = capture();
  restore = sent.restore;
  const client = new GatewayClient(config({ nodeId: "node-b", regionId: "eu" }));
  await client.register(true);
  await (client as any).sendHeartbeat();
  const [register, heartbeat] = sent.bodies;
  expect(register!.url).toBe("http://gateway.test/register");
  expect(register!.body).toMatchObject({ id: "node-b", nodeId: "node-b", regionId: "eu" });
  expect(heartbeat!.url).toBe("http://gateway.test/heartbeat");
  expect(heartbeat!.body.id).toBe("node-b");
});

test("outside cluster mode the server id is used and no node fields are sent", async () => {
  const sent = capture();
  restore = sent.restore;
  const client = new GatewayClient(config());
  await client.register(true);
  const [register] = sent.bodies;
  expect(register!.body.id).toBe("realm-1");
  expect("nodeId" in register!.body).toBe(false);
  expect("regionId" in register!.body).toBe(false);
});

test("a node unregisters under its node id", async () => {
  const sent = capture();
  restore = sent.restore;
  const client = new GatewayClient(config({ nodeId: "node-b", regionId: "eu" }));
  // As after a register the gateway accepted.
  (client as any).registered = true;
  await client.unregister();
  const [unregister] = sent.bodies;
  expect(unregister!.url).toBe("http://gateway.test/unregister");
  expect(unregister!.body.id).toBe("node-b");
});

// ---- block reports that cannot be sent: told once, by name ----------------------------------------------------------

const blocksConfig = () => config({ nodeId: "node-1", regionId: "eu" });

/** A one-block table owned by `owners` different nodes (more than 62 cannot be encoded) or no table (epoch 0). */
function tableSource(maps: Record<string, { epoch: number; owners: number }>) {
  return {
    maps: () => Object.keys(maps),
    epochOf: (map: string) => maps[map]?.epoch ?? 0,
    extentOf: (map: string) => (maps[map] ? { blocksX: Math.max(1, maps[map]!.owners), blocksY: 1 } : undefined),
    ownersOf: (map: string) => {
      const out: MapBlocks["owners"] = {};
      for (let i = 0; i < (maps[map]?.owners ?? 0); i++) out[`${i},0`] = { nodeId: `node-${i}`, epoch: 1, since: 1 };
      return out;
    },
    onChange: () => () => {},
  };
}

function blocksGateway(status: () => number) {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(JSON.stringify({ success: false }), { status: status() })) as any);
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  const errorSpy = spyOn(log, "error").mockImplementation(() => {});
  restore = () => { fetchSpy.mockRestore(); warn.mockRestore(); errorSpy.mockRestore(); };
  return { warns: () => warn.mock.calls.map((call) => String(call[0])) };
}

// Sends one report round as the last retry, so a failure is told at once.
const reportRound = (client: any, maps: string[]) => client.sendBlocks(maps, 3);

function blocksClient(source: ReturnType<typeof tableSource>) {
  const client = new GatewayClient(blocksConfig()) as any;
  client.registered = true;
  client.blocksSource = source;
  return client;
}

test("a table that cannot be encoded is told once, by map name; a map with no table yet is not told", async () => {
  const { warns } = blocksGateway(() => 200);
  // 63 owners: one more than a report can name.
  const client = blocksClient(tableSource({ crowded: { epoch: 4, owners: 63 }, fresh: { epoch: 0, owners: 0 } }));
  await reportRound(client, ["crowded", "fresh"]);
  await reportRound(client, ["crowded", "fresh"]);
  const told = warns().filter((line) => line.includes("crowded"));
  expect(told.length).toBe(1);
  // No warning of either kind names it ("block owners of fresh" starts both texts).
  expect(warns().some((line) => /block owners of fresh\b/.test(line))).toBe(false);
});

test("a map told as failing is told again when the gateway forgot the node (404) and it fails again", async () => {
  let status = 200;
  const { warns } = blocksGateway(() => status);
  const client = blocksClient(tableSource({ overworld: { epoch: 2, owners: 2 } }));
  // Fails for good: told once.
  await reportRound(client, ["overworld"]);
  await reportRound(client, ["overworld"]);
  expect(warns().filter((line) => line.includes("overworld")).length).toBe(1);
  // The gateway answers 404 (it restarted): the map is let go, so the flag goes with it.
  status = 404;
  await reportRound(client, ["overworld"]);
  // After registering again it fails once more: told again.
  status = 200;
  await reportRound(client, ["overworld"]);
  expect(warns().filter((line) => line.includes("overworld")).length).toBe(2);
});

test("an unreportable table that loses its table is told again when it comes back unreportable", async () => {
  const { warns } = blocksGateway(() => 200);
  const maps = { crowded: { epoch: 4, owners: 63 } };
  const client = blocksClient(tableSource(maps));
  await reportRound(client, ["crowded"]);
  maps.crowded.epoch = 0;
  await reportRound(client, ["crowded"]);
  maps.crowded.epoch = 5;
  await reportRound(client, ["crowded"]);
  expect(warns().filter((line) => line.includes("crowded")).length).toBe(2);
});

test("a map told as unencodable still gets the warning for sends that fail once its table can be encoded", async () => {
  const { warns } = blocksGateway(() => 200);
  const maps = { crowded: { epoch: 4, owners: 63 } };
  const client = blocksClient(tableSource(maps));
  await reportRound(client, ["crowded"]);
  expect(warns().filter((line) => /cannot be reported to the gateway/.test(line) && line.includes("crowded")).length).toBe(1);
  expect(warns().some((line) => /was not told the block owners of crowded/.test(line))).toBe(false);
  // The table can be encoded now, and the gateway does not take it (success: false) until the retries are used up.
  maps.crowded.owners = 2;
  await reportRound(client, ["crowded"]);
  expect(warns().filter((line) => /was not told the block owners of crowded/.test(line)).length).toBe(1);
  // Told once: the next failed round says nothing new.
  await reportRound(client, ["crowded"]);
  expect(warns().filter((line) => /was not told the block owners of crowded/.test(line)).length).toBe(1);
});
