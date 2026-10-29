import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import crypto from "crypto";
import { BUS_KEY_LABEL, deriveClusterKeys, LINK_KEY_LABEL, STORE_KEY_LABEL } from "../cluster/clusterkeys";
import { BlockTable, blockTableKey } from "../cluster/blocks";
import { ClusterBus } from "../cluster/bus";
import { Coordinator } from "../cluster/coordinator";
import { MapCatalogue, extentOf } from "../cluster/maps";
import { MemoryStore } from "../cluster/memorystore";
import { MoveOrders, moveKey } from "../cluster/moveorders";
import { NodeRegistry } from "../cluster/nodes";
import { open, refusedRecord, REFUSED_KEEP, seal, SealedStore, sealKindOf, sealStore } from "../cluster/storeseal";
import log from "../modules/logger";

// Security review H1: the store records that carry authority are sealed with the store key.

const KEYS = deriveClusterKeys("storeseal-test-secret-0123456789abcdef");
const KEY = KEYS.store;
const OTHER = deriveClusterKeys("another-cluster-secret-0123456789abcdef").store;

let warnings: string[];
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  warnings = [];
  spies.push(spyOn(log, "warn").mockImplementation((message: string) => { warnings.push(String(message)); }));
});
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

test("the store key is its own HKDF label of the cluster secret", () => {
  expect(STORE_KEY_LABEL).toBe("cells-store-v1");
  const hkdf = (label: string) => Buffer.from(crypto.hkdfSync("sha256", "storeseal-test-secret-0123456789abcdef", Buffer.alloc(0), label, 32)).toString("hex");
  expect(KEYS.store).toBe(hkdf(STORE_KEY_LABEL));
  // One key per use: a store seal is never a link or bus signature.
  expect(KEYS.store).not.toBe(hkdf(LINK_KEY_LABEL));
  expect(KEYS.store).not.toBe(hkdf(BUS_KEY_LABEL));
  expect(new Set([KEYS.link, KEYS.bus, KEYS.store]).size).toBe(3);
});

test("a sealed record opens to the value it sealed, byte for byte, and stays a JSON object with its fields on top", () => {
  const value = JSON.stringify({ id: "g1", epoch: 3, state: "sent", note: "a \"quoted\" , } value" });
  const stored = seal("move", "cells:move:g1", value, KEY);
  expect(open("move", "cells:move:g1", stored, KEY)).toBe(value);
  const parsed = JSON.parse(stored);
  expect(parsed.epoch).toBe(3);
  expect(parsed.state).toBe("sent");
  expect(parsed.seal).toMatch(/^[0-9a-f]{64}$/);
  expect(open("tombstone", "cells:dead:a", seal("tombstone", "cells:dead:a", "{}", KEY), KEY)).toBe("{}");
  expect(() => seal("grant", "cells:grant:x", "[1]", KEY)).toThrow("Only a JSON object can be sealed");
});

test("a seal does not open under another key, another kind, another Redis key, or on a changed value", () => {
  const value = JSON.stringify({ epoch: 4, at: 1, username: "ann", map: "main", x: 1, y: 2 });
  const stored = seal("snapshot", "cells:snap:ann", value, KEY);
  // Guard: the store key. Another cluster's records (or a forger's) do not open here.
  expect(open("snapshot", "cells:snap:ann", stored, OTHER)).toBeNull();
  // Guard: the Redis key in the MAC. Ann's snapshot copied to Bob's key does not place Bob.
  expect(open("snapshot", "cells:snap:bob", stored, KEY)).toBeNull();
  // Guard: the kind in the MAC.
  expect(open("grant", "cells:snap:ann", stored, KEY)).toBeNull();
  // Guard: the value in the MAC.
  expect(open("snapshot", "cells:snap:ann", stored.replace('"x":1', '"x":9'), KEY)).toBeNull();
  // No seal, a short or odd one, a seal not at the end: none opens.
  expect(open("snapshot", "cells:snap:ann", value, KEY)).toBeNull();
  expect(open("snapshot", "cells:snap:ann", stored.replace(/"seal":"[0-9a-f]{64}"/, '"seal":"00"'), KEY)).toBeNull();
  expect(open("snapshot", "cells:snap:ann", stored.replace(/[0-9a-f]"}$/, 'A"}'), KEY)).toBeNull();
  expect(open("snapshot", "cells:snap:ann", `${stored} `, KEY)).toBeNull();
  expect(open("snapshot", "cells:snap:ann", "x".repeat(200), KEY)).toBeNull();
});

test("only the authority records are sealed", () => {
  for (const [key, kind] of [
    ["cells:grant:g1", "grant"], ["cells:snap:ann", "snapshot"], ["cells:dead:a", "tombstone"], ["cells:noderun:a", "noderun"],
    ["cells:nodeinfo:a", "nodeinfo"], ["cells:settle:ann", "settle"], ["cells:move:m1", "move"],
    ["cells:blocks:main", "blocks"],
  ] as const) expect(sealKindOf(key)).toBe(kind);
  for (const key of ["cells:grants:a|5", "cells:granted:g1", "cells:grant-adopt:a|5", "cells:moves", "cells:blocksepoch:main", "cells:alive:a", "cells:snapshot"]) {
    expect(sealKindOf(key)).toBeNull();
  }
});

test("SealedStore seals what it writes and opens what it reads; an unsealed record counts as missing, logged once per key", async () => {
  const raw = new MemoryStore();
  const store = sealStore(raw, KEY);
  await store.set("cells:dead:a", JSON.stringify({ nodeId: "a", startedAt: 5, at: 1 }));
  expect(JSON.parse((await raw.get("cells:dead:a"))!).seal).toMatch(/^[0-9a-f]{64}$/);
  expect(await store.get("cells:dead:a")).toBe(JSON.stringify({ nodeId: "a", startedAt: 5, at: 1 }));
  // A key that is not sealed passes through as it is.
  await store.set("cells:alive:a", "5");
  expect(await raw.get("cells:alive:a")).toBe("5");
  expect(await store.get("cells:alive:a")).toBe("5");
  // Guard: the read check. Written straight into Redis (a forger, or a record from before the upgrade) it is missing.
  await raw.set("cells:dead:b", JSON.stringify({ nodeId: "b", startedAt: 5, at: 1 }));
  expect(await store.get("cells:dead:b")).toBeNull();
  expect(await store.get("cells:dead:b")).toBeNull();
  expect(warnings.filter((w) => w.includes("cells:dead:b")).length).toBe(1);
  expect(warnings[0]).toContain("counts as missing");
  // A missing record is no refusal.
  expect(await store.get("cells:dead:c")).toBeNull();
  expect(warnings.length).toBe(1);
});

test("an unsealed grant is taken as missing, and its content is logged with the warning that it is not given", async () => {
  const raw = new MemoryStore();
  const store = sealStore(raw, KEY);
  await raw.set("cells:grant:g9", JSON.stringify({ id: "g9", username: "ann", items: [{ itemName: "Gold Bar", quantity: 1 }] }));
  expect(await store.take("cells:grant:g9")).toBeNull();
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("A hand-over parked before records were sealed is lost here, and not given");
  expect(warnings[0]).toContain("Gold Bar");
  // A sealed one is taken once.
  await store.set("cells:grant:g8", JSON.stringify({ id: "g8" }));
  expect(await store.take("cells:grant:g8")).toBe(JSON.stringify({ id: "g8" }));
  expect(await store.take("cells:grant:g8")).toBeNull();
  // setIfAbsent seals too.
  expect(await store.setIfAbsent("cells:settle:ann", JSON.stringify({ until: 1 }), 1000)).toBe(true);
  expect(await store.get("cells:settle:ann")).toBe(JSON.stringify({ until: 1 }));
});

test("the once-per-key memory is bounded", async () => {
  const raw = new MemoryStore();
  const store = sealStore(raw, KEY);
  for (let i = 0; i <= REFUSED_KEEP; i++) {
    await raw.set(`cells:snap:p${i}`, "{}");
    await store.get(`cells:snap:p${i}`);
  }
  expect(warnings.length).toBe(REFUSED_KEEP + 1);
  // The memory started over: the first key is logged again, once.
  await store.get("cells:snap:p0");
  await store.get("cells:snap:p0");
  expect(warnings.length).toBe(REFUSED_KEEP + 2);
});

test("move orders swap by epoch through the seal: the store's epoch check reads the sealed record", async () => {
  const raw = new MemoryStore();
  const orders = new MoveOrders(sealStore(raw, KEY));
  const order = await orders.create({ map: "main", bx: 0, by: 0, from: "a", to: "b", blockEpoch: 1 });
  const sending = await orders.swap(order.id, "ordered", "sending");
  expect(sending?.state).toBe("sending");
  // A stale swap is refused as before.
  expect(await orders.swap(order.id, "ordered", "sending")).toBeNull();
  expect((await orders.get(order.id))?.state).toBe("sending");
  expect(JSON.parse((await raw.get(moveKey(order.id)))!).seal).toMatch(/^[0-9a-f]{64}$/);
  // Guard: the seal on orders. A forged "sent" (an order the old owner never sent) reads as no order at all.
  const forged = JSON.stringify({ ...sending, state: "sent", epoch: sending!.epoch + 1 });
  await raw.set(moveKey(order.id), forged);
  expect(await orders.get(order.id)).toBeNull();
  expect(await orders.all()).toEqual([]);
  // An order written without the seal (an old one, or the chaos tool's raw store) is missing too.
  const unsealed = await new MoveOrders(raw).create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 1 });
  expect(await orders.get(unsealed.id)).toBeNull();
});

test("sealStore wraps once, keeps isUp, and passes the rest through", async () => {
  const raw = new MemoryStore();
  let up = true;
  (raw as any).isUp = () => up;
  const store = sealStore(raw, KEY);
  expect(sealStore(store, OTHER)).toBe(store);
  expect(store.inner).toBe(raw);
  expect(store.isUp?.()).toBe(true);
  up = false;
  expect(store.isUp?.()).toBe(false);
  // A store with no health of its own gets none here (health.ts treats it as up).
  expect(new SealedStore({ ...raw, isUp: undefined } as any, KEY).isUp).toBeUndefined();
  expect(() => new SealedStore(raw, "short")).toThrow("The store key must be 32 bytes as hex");
  await store.addToSet("cells:grants:a|5", "g1");
  expect(await raw.members("cells:grants:a|5")).toEqual(["g1"]);
  expect(await store.incrBy("cells:ids", 2)).toBe(2);
});

test("a block table whose seal does not open is never split afresh: the coordinator leaves it alone like a corrupt one", async () => {
  const errors: string[] = [];
  spies.push(
    spyOn(log, "error").mockImplementation((message: string) => { errors.push(String(message)); }),
    spyOn(log, "info").mockImplementation(() => {}),
    spyOn(log, "success").mockImplementation(() => {}),
  );
  const raw = new MemoryStore();
  const store = sealStore(raw, KEY);
  const registry = new NodeRegistry(store);
  const now = Date.now();
  for (const nodeId of ["a", "b"]) {
    await registry.announce({ nodeId, regionId: "eu", publicHost: `${nodeId}.example.com`, port: 3000, wtPort: 3002, useSSL: true, startedAt: now });
    await registry.beat(nodeId);
  }
  await new MapCatalogue(store).publish([extentOf("main", 2 * 4096, 4096), extentOf("other", 2 * 4096, 4096)]);
  // "main" holds a table this cluster did not write (forged, or from before the seal): it reads as missing.
  const forged = JSON.stringify({ epoch: 3, owners: { "0,0": { nodeId: "b", epoch: 3, since: now } } });
  await raw.set(blockTableKey("main"), forged);
  const coordinator = new Coordinator(store, new ClusterBus(store, "coord", KEYS.bus), { id: "coord" });
  try {
    await coordinator.tick();
    expect(coordinator.isLeader()).toBe(true);
    // Guard: refusedRecord in the coordinator's read. Taken as absent, the map is split afresh over the nodes, and a
    // node still holding blocks by the table it cached would share them with the new owners.
    expect(await raw.get(blockTableKey("main"))).toBe(forged);
    expect(errors.some((line) => line.includes("block table of map main cannot be read"))).toBe(true);
    // A map with no table at all is split as before, and its table is sealed.
    expect((await new BlockTable(store).readStored("other")).state).toBe("ok");
    expect(await raw.get(blockTableKey("other"))).toContain('"seal":"');
    // A node reads the refused table as no table: it owns nothing there.
    expect(await new BlockTable(store).readStored("main")).toEqual({ state: "absent" });
    expect(await refusedRecord(store, blockTableKey("main"))).toBe(true);
    expect(await refusedRecord(store, blockTableKey("other"))).toBe(false);
    expect(await refusedRecord(store, blockTableKey("nowhere"))).toBe(false);
    expect(await refusedRecord(raw, blockTableKey("main"))).toBe(false);
  } finally {
    await coordinator.stop();
  }
});
