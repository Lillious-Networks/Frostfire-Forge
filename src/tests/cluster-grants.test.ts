import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { ParkedGrant } from "../cluster/grants";
import { linkPair } from "./cluster-fakelink";
import { databaseModule, mockQuery } from "./setup";

// kill.ts, the grant writer and the systems under them reach the database; the writes are spied on.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));

const { MemoryStore } = await import("../cluster/memorystore");
const { GRANT_RECOVER_DELAYS_MS, GRANT_TTL_MS, Grants, grantKey, grantedKey, grants, handOverOf } = await import("../cluster/grants");
const { LinkCalls, linkCalls } = await import("../cluster/linkcalls");
const { ghosts } = await import("../cluster/ghosts");
const { mirrorPlayers } = await import("../cluster/mirrors");
const { askOwner, serveItems } = await import("../cluster/remoteitems");
const { delivery } = await import("../cluster/deliver");
const { checkedGrant, sendGrant, setGrantApplier } = await import("../systems/creatures/remotereward");
const { setKnownTemplates } = await import("../systems/creatures/kill");
const { giveGrant } = await import("../systems/grantwriter");
const { RemoteGatherers, answerGather, requestGather } = await import("../systems/gathering/remote");
const { REASONS } = await import("../systems/gathering/service");
const { default: inventory } = await import("../systems/inventory");
const { default: currency } = await import("../systems/currency");
const { default: playerCache } = await import("../services/playermanager");
const { default: log } = await import("../modules/logger");
const { default: assetCache } = await import("../services/assetCache");

// kill.ts sets its applier when it loads: the engine's corpse-money path.
const killGrant = setGrantApplier(null);
setGrantApplier(killGrant);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const restores: Array<() => void> = [];
const offs: Array<() => void> = [];
let errored: string[] = [];
let warned: string[] = [];
let informed: string[] = [];

beforeEach(() => {
  errored = [];
  warned = [];
  informed = [];
  const error = spyOn(log, "error").mockImplementation((message: any) => { errored.push(String(message)); });
  const warn = spyOn(log, "warn").mockImplementation((message: any) => { warned.push(String(message)); });
  const info = spyOn(log, "info").mockImplementation((message: any) => { informed.push(String(message)); });
  restores.push(() => error.mockRestore(), () => warn.mockRestore(), () => info.mockRestore());
  // No item table loaded, as when this file runs alone (other files replace the asset cache for the whole run).
  const original = assetCache.get;
  const items = spyOn(assetCache, "get").mockImplementation(async (key: string) => key === "items" ? null : original.call(assetCache, key));
  restores.push(() => items.mockRestore());
});

afterEach(() => {
  for (const off of offs.splice(0)) off();
  for (const restore of restores.splice(0)) restore();
  grants.detach();
  mirrorPlayers.clear();
  (ghosts as any).mirrors.remove(5);
  delivery.detach();
  linkCalls.detach();
});

const bones = () => ({ username: "Ann", items: [{ itemName: "Bone", quantity: 2 }], copper: 11, call: "LOOT_TAKE" });

/** An owner node "b" with its own Grants, the player's node "a" sharing its store, and what each wrote. */
function harness(opts: { online?: boolean } = {}) {
  const store = new MemoryStore();
  const actions: any[] = [];
  const written: Array<{ id: string; player: any }> = [];
  const player = { id: "7", username: "Ann" };
  let playerNode: InstanceType<typeof Grants> | null = null;
  const owner = new Grants({
    runOnPlayer: async (username, action, args) => {
      actions.push({ username, action, args });
      if (opts.online === false) return false;
      if (playerNode) await playerNode.recoverHere(player, args);
      return true;
    },
    now: Date.now,
  }, { delays: [20, 40, 80], storeRetryMs: 20, ttlMs: 200 });
  owner.attach(store, "b");
  owner.setWriter(async (grant, p) => { written.push({ id: grant.id, player: p }); });
  const onPlayerNode = () => {
    const node = new Grants({ runOnPlayer: async () => false, now: Date.now }, { delays: [20, 40, 80], storeRetryMs: 20, ttlMs: 200 });
    node.attach(store, "a");
    node.setWriter(async (grant, p) => { written.push({ id: grant.id, player: p }); });
    playerNode = node;
    return node;
  };
  const stop = () => { owner.detach(); playerNode?.detach(); };
  return { store, owner, actions, written, player, onPlayerNode, stop };
}

// ---------------------------------------------------------------- the grants

test("the times are the ones the plan sets", () => {
  expect(GRANT_TTL_MS).toBe(600_000);
  expect([...GRANT_RECOVER_DELAYS_MS]).toEqual([12_000, 30_000, 60_000]);
});

test("park keeps the hand-over under a grant id of this node, and answers null with no store", async () => {
  const h = harness();
  try {
    const id = await h.owner.park(bones());
    expect(id!.startsWith("b:")).toBe(true);
    expect(JSON.parse((await h.store.get(grantKey(id!)))!)).toMatchObject({ ...bones(), id, owner: "b" });
    h.owner.detach();
    expect(await h.owner.park(bones())).toBeNull();
  } finally {
    h.stop();
  }
});

test("a hand-over is claimed once", async () => {
  const h = harness();
  try {
    const id = (await h.owner.park(bones()))!;
    // Guard: take, not get. A second claim (or the owner's recovery) would give it again.
    expect(await h.owner.claim(id)).toBe(true);
    expect(await h.owner.claim(id)).toBe(false);
    expect(await h.store.get(grantKey(id))).toBeNull();
  } finally {
    h.stop();
  }
});

test("a claim that fails on the store is not a claim", async () => {
  const h = harness();
  try {
    const id = (await h.owner.park(bones()))!;
    const take = spyOn(h.store, "take").mockImplementation(async () => { throw new Error("redis down"); });
    expect(await h.owner.claim(id)).toBe(false);
    take.mockRestore();
    expect(await h.store.get(grantKey(id))).not.toBeNull();
  } finally {
    h.stop();
  }
});

test("a claimed hand-over is never recovered", async () => {
  const h = harness();
  try {
    const id = (await h.owner.park(bones()))!;
    await h.owner.claim(id);
    await wait(120);
    // Guard: the read before the action. A claimed grant must not send a recover action.
    expect(h.actions).toEqual([]);
    expect(h.written).toEqual([]);
  } finally {
    h.stop();
  }
});

test("an unclaimed hand-over is given on the player's node, once", async () => {
  const h = harness();
  try {
    h.onPlayerNode();
    const id = (await h.owner.park(bones()))!;
    await wait(120);
    expect(h.actions).toEqual([{ username: "Ann", action: "cells-grant-recover", args: { id } }]);
    expect(h.written).toEqual([{ id, player: h.player }]);
  } finally {
    h.stop();
  }
});

test("the recover action gives a hand-over once, even when it runs twice", async () => {
  const h = harness();
  try {
    const node = h.onPlayerNode();
    const id = (await h.owner.park(bones()))!;
    // Guard: take in recoverHere. Two deliveries of one action would both write.
    await Promise.all([node.recoverHere(h.player, { id }), node.recoverHere(h.player, { id })]);
    expect(h.written).toEqual([{ id, player: h.player }]);
  } finally {
    h.stop();
  }
});

test("a recover action for another player writes to the named player's rows", async () => {
  const h = harness();
  try {
    const node = h.onPlayerNode();
    const id = (await h.owner.park(bones()))!;
    await node.recoverHere({ id: "8", username: "Bob" }, { id });
    expect(h.written).toEqual([{ id, player: null }]);
    await node.recoverHere(h.player, { id: 5 });
    expect(h.written.length).toBe(1);
  } finally {
    h.stop();
  }
});

test("a player on no node is written to the rows by the owner at the first check", async () => {
  const h = harness({ online: false });
  try {
    const id = (await h.owner.park(bones()))!;
    await wait(35);
    expect(h.actions.length).toBe(1);
    expect(h.written).toEqual([{ id, player: null }]);
  } finally {
    h.stop();
  }
});

test("the last check writes what the action did not take", async () => {
  // Online, but the action never runs (no player node): lost on the bus.
  const h = harness();
  try {
    const id = (await h.owner.park(bones()))!;
    await wait(120);
    expect(h.actions.length).toBe(2);
    expect(h.written).toEqual([{ id, player: null }]);
  } finally {
    h.stop();
  }
});

test("the owner's own write and a late claim never both give it", async () => {
  const h = harness({ online: false });
  try {
    const id = (await h.owner.park(bones()))!;
    await wait(35);
    expect(h.written.length).toBe(1);
    // Guard: take in the owner's write. An answer that came very late finds nothing to claim.
    expect(await h.owner.claim(id)).toBe(false);
  } finally {
    h.stop();
  }
});

test("a write that fails is logged lost, with what it held", async () => {
  const h = harness();
  try {
    const node = h.onPlayerNode();
    node.setWriter(async () => { throw new Error("database down"); });
    const id = (await h.owner.park(bones()))!;
    await node.recoverHere(h.player, { id });
    expect(errored.some((line) => line.includes(id) && line.includes("2 x Bone, 11 copper"))).toBe(true);
  } finally {
    h.stop();
  }
});

test("the owner's write that fails before anything is sent parks the grant again under its own id, which is given once", async () => {
  // Items m1: the player's lock is busy on another node, so the batch is refused before its transaction is sent.
  const { atomically } = await import("../services/batch");
  const unsent = await atomically(["ann"], async () => { throw new Error("player lock busy"); }).catch((error) => error);
  const h = harness({ online: false });
  let refusals = 1;
  h.owner.setWriter(async (grant, p) => {
    if (refusals-- > 0) throw unsent;
    h.written.push({ id: grant.id, player: p });
  });
  try {
    const id = (await h.owner.park(bones()))!;
    await wait(35);
    // Guard: nothingWritten in Grants.write. Logged lost here, the items would be gone though nothing was written.
    // Parked again under the same id (security review Important 3): two park lines for it, and no other id.
    const parkedIds = informed.map((line) => /^Hand-over (\S+) \(LOOT_TAKE\) parked/.exec(line)?.[1]).filter(Boolean);
    expect(parkedIds).toEqual([id, id]);
    expect(JSON.parse((await h.store.get(grantKey(id)))!)).toMatchObject({ ...bones(), id, owner: "b" });
    expect(errored.some((line) => line.includes("is lost"))).toBe(false);
    await wait(60);
    expect(h.written).toEqual([{ id, player: null }]);
    expect(await h.store.get(grantKey(id))).toBeNull();
  } finally {
    h.stop();
  }
});

test("a store failure during a check is retried until the grant runs out, then logged lost by name", async () => {
  const h = harness();
  try {
    const id = (await h.owner.park(bones()))!;
    const get = spyOn(h.store, "get").mockImplementation(async () => { throw new Error("redis down"); });
    await wait(300);
    get.mockRestore();
    // Guard: the ttl bound. Without it the checks run on forever and the loss is never logged.
    expect(warned.length).toBeGreaterThan(1);
    expect(errored.filter((line) => line.includes(id) && line.includes("2 x Bone, 11 copper")).length).toBe(1);
    expect(h.written).toEqual([]);
  } finally {
    h.stop();
  }
});

test("a store that comes back is checked again, and the grant is given", async () => {
  const h = harness();
  try {
    h.onPlayerNode();
    const id = (await h.owner.park(bones()))!;
    let failures = 2;
    const real = h.store.get.bind(h.store);
    const get = spyOn(h.store, "get").mockImplementation(async (key: string) => {
      if (failures-- > 0) throw new Error("redis down");
      return real(key);
    });
    await wait(150);
    get.mockRestore();
    expect(h.written).toEqual([{ id, player: h.player }]);
  } finally {
    h.stop();
  }
});

test("detach stops the checks", async () => {
  const h = harness();
  try {
    await h.owner.park(bones());
    h.owner.detach();
    await wait(120);
    expect(h.actions).toEqual([]);
  } finally {
    h.stop();
  }
});

test("every park is logged by id with what it holds", async () => {
  const h = harness();
  try {
    const id = (await h.owner.park(bones()))!;
    // Every later line names only the id: this one ties it to the items.
    expect(informed.some((line) => line.includes(id) && line.includes("Ann") && line.includes("2 x Bone, 11 copper"))).toBe(true);
  } finally {
    h.stop();
  }
});

test("a claim whose take ran on the store but whose reply was lost is logged by name, and nobody writes it", async () => {
  // P1: GETDEL ran, then the connection closed, so the take rejects with the key already gone.
  const h = harness();
  try {
    const id = (await h.owner.park(bones()))!;
    const real = h.store.take.bind(h.store);
    const take = spyOn(h.store, "take").mockImplementation(async (key: string) => { await real(key); throw new Error("connection closed"); });
    // Guard: the claim names what the answer carried when the store fails.
    expect(await h.owner.claim(id, bones())).toBe(false);
    take.mockRestore();
    expect(await h.store.get(grantKey(id))).toBeNull();
    expect(errored.some((line) => line.includes(id) && line.includes("2 x Bone, 11 copper") && line.includes("may be lost"))).toBe(true);
    await wait(120);
    expect(h.written).toEqual([]);
  } finally {
    h.stop();
  }
});

test("the owner's take whose reply was lost is logged as may be lost when the next check finds it gone", async () => {
  // P1, owner half: the player is on no node, the owner's own take runs on the store and its reply is lost.
  const h = harness({ online: false });
  try {
    const id = (await h.owner.park(bones()))!;
    const real = h.store.take.bind(h.store);
    let failures = 1;
    const take = spyOn(h.store, "take").mockImplementation(async (key: string) => {
      const value = await real(key);
      if (failures-- > 0) throw new Error("connection closed");
      return value;
    });
    await wait(80);
    take.mockRestore();
    expect(h.written).toEqual([]);
    // Guard: the check remembers the failed take. Without it the next check reads "gone" as claimed, and says nothing.
    expect(errored.filter((line) => line.includes(id) && line.includes("2 x Bone, 11 copper") && line.includes("may be lost")).length).toBe(1);
  } finally {
    h.stop();
  }
});

test("a failed take that did not run is forgotten once the grant is read back, so a later claim is not logged as may be lost", async () => {
  const opts = { online: false };
  const h = harness(opts);
  try {
    const id = (await h.owner.park(bones()))!;
    // The take fails without running; the player comes online meanwhile, so the next check sends the recover action.
    const take = spyOn(h.store, "take").mockImplementation(async () => { opts.online = true; throw new Error("connection closed"); });
    const deadline = Date.now() + 1_000;
    while (h.actions.length < 2 && Date.now() < deadline) await wait(5);
    take.mockRestore();
    expect(h.actions.length).toBe(2);
    // Claimed on another node before the next check.
    await h.store.del(grantKey(id));
    await wait(80);
    // Guard: the check that read the grant back clears the failed take. Without it the gone grant is logged as may be lost.
    expect(errored.some((line) => line.includes(id) && line.includes("may be lost"))).toBe(false);
    expect(h.written).toEqual([]);
  } finally {
    h.stop();
  }
});

test("a parked value that is not a grant is logged lost by id, on the player's node and on the owner", async () => {
  const h = harness({ online: false });
  try {
    const node = h.onPlayerNode();
    const first = (await h.owner.park(bones()))!;
    await h.store.set(grantKey(first), "not a grant");
    await node.recoverHere(h.player, { id: first });
    expect(errored.some((line) => line.includes(first) && line.includes("not a grant"))).toBe(true);
    const second = (await h.owner.park(bones()))!;
    await h.store.set(grantKey(second), JSON.stringify({ id: second }));
    await wait(35);
    // Guard: the owner's take of a value that is not a grant names the grant it parked.
    expect(errored.some((line) => line.includes(second) && line.includes("2 x Bone, 11 copper") && line.includes("not a grant"))).toBe(true);
    expect(h.written).toEqual([]);
  } finally {
    h.stop();
  }
});

test("detach logs each grant it stops checking by id and what it holds, and none that was settled", async () => {
  const h = harness();
  try {
    const claimed = (await h.owner.park(bones()))!;
    await h.owner.claim(claimed);
    await wait(30);
    const first = (await h.owner.park(bones()))!;
    const second = (await h.owner.park({ ...bones(), items: [{ itemName: "Fang", quantity: 1 }], copper: 0 }))!;
    warned = [];
    h.owner.detach();
    // Guard: one line per pending grant, by name. A count alone leaves one that runs out unclaimed on record nowhere.
    expect(warned.length).toBe(2);
    expect(warned.some((line) => line.includes(first) && line.includes("2 x Bone, 11 copper"))).toBe(true);
    expect(warned.some((line) => line.includes(second) && line.includes("1 x Fang"))).toBe(true);
    expect(warned.some((line) => line.includes(claimed))).toBe(false);
  } finally {
    h.stop();
  }
});

test("firstApply marks a grant id once, unapply clears it, and with no store it always applies", async () => {
  const h = harness();
  try {
    expect(await h.owner.firstApply("g1")).toBe(true);
    expect(await h.owner.firstApply("g1")).toBe(false);
    expect(await h.store.get(grantedKey("g1"))).toBe("1");
    await h.owner.unapply("g1");
    expect(await h.owner.firstApply("g1")).toBe(true);
    h.owner.detach();
    expect(await h.owner.firstApply("g1")).toBe(true);
  } finally {
    h.stop();
  }
});

test("handOverOf reads a list of items, one item, a gathered item and the money", () => {
  expect(handOverOf({ ok: true, items: [{ itemName: "Bone", quantity: 2, quality: "rare" }], copper: 11 })).toEqual({ items: [{ itemName: "Bone", quantity: 2 }], copper: 11 });
  expect(handOverOf({ ok: true, item: { item: "Gem", quantity: 1, map: "main" } })).toEqual({ items: [{ itemName: "Gem", quantity: 1 }], copper: 0 });
  expect(handOverOf({ ok: true, item: "Copper Ore", quantity: 3 })).toEqual({ items: [{ itemName: "Copper Ore", quantity: 3 }], copper: 0 });
  expect(handOverOf({ ok: true })).toEqual({ items: [], copper: 0 });
});

// ---------------------------------------------------------------- item calls

test("the owner parks a take before the answer goes out, and the answer names it", async () => {
  const store = new MemoryStore();
  grants.attach(store, "b");
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  offs.push(serveItems("CHEST_TAKE", () => ({ ok: true, items: [{ itemName: "Gem", quantity: 1 }] })));
  offs.push(serveItems("CHEST_OPEN", () => ({ ok: true, items: [{ itemName: "Gem", quantity: 1 }] })));
  mirrorPlayers.set("7", { id: "7", username: "Alice", remote: true, mirrorFrom: "a" });
  try {
    const taken: any = await caller.call("b", "CHEST_TAKE", { chestId: "chest_5", actor: { id: "7", username: "alice" } });
    // Guard: the park in serveItems. Without it a lost answer loses the gem.
    expect(typeof taken.answer.grantId).toBe("string");
    expect(JSON.parse((await store.get(grantKey(taken.answer.grantId)))!)).toMatchObject({ username: "Alice", items: [{ itemName: "Gem", quantity: 1 }], copper: 0, call: "CHEST_TAKE", owner: "b" });
    const opened: any = await caller.call("b", "CHEST_OPEN", { chestId: "chest_5", actor: { id: "7", username: "alice" } });
    expect(opened.answer.grantId).toBeUndefined();
  } finally {
    caller.detach();
  }
});

test("an answer whose hand-over is claimed is written; one not claimed is not", async () => {
  const store = new MemoryStore();
  grants.attach(store, "a");
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  owner.handle("CHEST_TAKE", () => ({ ok: true, items: [{ itemName: "Gem", quantity: 1 }], grantId: "b:1" }));
  (ghosts as any).mirrors.set({ kind: "chest", id: "chest_5", num: 5, from: "b", confirmedAt: 0 });
  const player = { id: 7, username: "Alice" };
  try {
    await store.set(grantKey("b:1"), JSON.stringify({ id: "b:1" }));
    expect(await askOwner("CHEST_TAKE", "chest_5", player, { chestId: "chest_5", indices: null })).toEqual({ ok: true, items: [{ itemName: "Gem", quantity: 1 }], grantId: "b:1" });
    expect(await store.get(grantKey("b:1"))).toBeNull();
    // Guard: the claim in askOwner. The owner's recovery has this one: written here too, it would exist twice.
    expect(await askOwner("CHEST_TAKE", "chest_5", player, { chestId: "chest_5", indices: null })).toEqual({ ok: false, reason: "failed" });
    expect(warned.some((line) => line.includes("b:1"))).toBe(true);
  } finally {
    owner.detach();
  }
});

test("a gather finish parks its item, and the gatherer's node claims it", async () => {
  const store = new MemoryStore();
  grants.attach(store, "b");
  const deps: any = {
    service: {
      start: async () => ({ ok: true, node: { id: 3 } }),
      finish: async () => ({ ok: true, node: { id: 3 }, item: "Copper Ore", quantity: 3 }),
    },
    gatherers: new RemoteGatherers(),
    ownerOf: () => "a",
    // The mirror here, standing where the request says the gatherer stands (T3).
    mirrorOf: () => ({ username: "ann", location: { map: "main", position: { x: 1, y: 1 } } }),
  };
  const gatherer: any = { id: "7", username: "ann", map: "main", layerId: null, x: 1, y: 1, dead: false, stunned: false, casting: false, moving: false, inCombat: false, hasRoom: true };
  const answer = await answerGather({ phase: "finish", nodeId: 3, gatherer }, "a", deps);
  // Guard: the park in answerGather.
  expect(typeof answer.grantId).toBe("string");
  expect(JSON.parse((await store.get(grantKey(answer.grantId!)))!)).toMatchObject({ username: "ann", items: [{ itemName: "Copper Ore", quantity: 3 }], call: "GATHER_REQUEST" });
  expect((await answerGather({ phase: "start", nodeId: 3, gatherer }, "a", deps)).grantId).toBeUndefined();

  grants.detach();
  grants.attach(store, "a");
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  owner.handle("GATHER_REQUEST", () => ({ ok: true, item: "Copper Ore", quantity: 3, grantId: answer.grantId }));
  try {
    const request: any = { phase: "finish", nodeId: 3, gatherer };
    expect(await requestGather("b", request, "Copper Ore")).toMatchObject({ ok: true, item: "Copper Ore", quantity: 3 });
    // Guard: the claim in requestGather.
    expect(await requestGather("b", request, "Copper Ore")).toEqual({ ok: false, reason: REASONS.failed });
  } finally {
    owner.detach();
  }
});

test("a take or a gather finish refused as busy is logged as not run, never as lost", async () => {
  const { a, b } = linkPair();
  linkCalls.attach(a);
  // The owner is at its cap (linkcalls.ts MAX_INFLIGHT_PER_PEER): every call is answered busy, and none runs.
  b.on("CALL", (frame: any) => { b.send("a", "ANSWER", { seq: frame.seq, epoch: frame.epoch, busy: true }); });
  (ghosts as any).mirrors.set({ kind: "chest", id: "chest_5", num: 5, from: "b", confirmedAt: 0 });
  const gatherer: any = { id: "7", username: "ann", map: "main", layerId: null, x: 1, y: 1, dead: false, stunned: false, casting: false, moving: false, inCombat: false, hasRoom: true };
  expect(await askOwner("CHEST_TAKE", "chest_5", { id: 7, username: "Alice" }, { chestId: "chest_5", indices: null })).toEqual({ ok: false, reason: "failed" });
  expect(await requestGather("b", { phase: "finish", nodeId: 3, gatherer }, "Copper Ore")).toEqual({ ok: false, reason: REASONS.failed });
  // Guard: neverRan in askOwner and requestGather. A busy call took nothing, so nothing may be lost.
  expect(warned.length).toBe(2);
  expect(warned[0]).toContain("CHEST_TAKE");
  expect(warned[1]).toContain("Copper Ore");
  expect(warned.every((line) => line.includes("busy") && line.includes("did not run"))).toBe(true);
  expect(warned.some((line) => line.includes("may be lost"))).toBe(false);
});

// ---------------------------------------------------------------- corpse money

test("a money share with a grant id is given once", async () => {
  grants.attach(new MemoryStore(), "b");
  const savedTemplates = setKnownTemplates(new Map([[3, { id: 3, name: "Wolf", gold_max: 1000 } as any]]));
  const paid: number[] = [];
  const add = spyOn(currency, "add").mockImplementation(async (_name: string, amount: any) => { paid.push(amount.copper); return { copper: amount.copper, silver: 0, gold: 0 } as any; });
  playerCache.add("901", { id: "901", username: "ann" });
  try {
    expect(await killGrant!({ username: "ann", copper: 7, id: "g1" })).toBe("given");
    // Guard: firstApply in grantCopper. A share sent again after a lost answer would be paid twice.
    expect(await killGrant!({ username: "ann", copper: 7, id: "g1" })).toBe("given");
    expect(paid).toEqual([7]);
    expect(await killGrant!({ username: "ann", copper: 7 })).toBe("given");
    expect(paid).toEqual([7, 7]);
  } finally {
    playerCache.remove("901");
    add.mockRestore();
    setKnownTemplates(savedTemplates);
  }
});

test("a money share whose write failed can be given when sent again", async () => {
  grants.attach(new MemoryStore(), "b");
  const savedTemplates = setKnownTemplates(new Map([[3, { id: 3, name: "Wolf", gold_max: 1000 } as any]]));
  let fail = true;
  const paid: number[] = [];
  const add = spyOn(currency, "add").mockImplementation(async (_name: string, amount: any) => {
    if (fail) throw new Error("write refused");
    paid.push(amount.copper);
    return { copper: amount.copper, silver: 0, gold: 0 } as any;
  });
  playerCache.add("901", { id: "901", username: "ann" });
  try {
    expect(await killGrant!({ username: "ann", copper: 7, id: "g2" })).toBe("failed");
    fail = false;
    // Guard: unapply on a failed write. The mark would make the retry a no-op, and the share would be lost.
    expect(await killGrant!({ username: "ann", copper: 7, id: "g2" })).toBe("given");
    expect(paid).toEqual([7]);
  } finally {
    playerCache.remove("901");
    add.mockRestore();
    setKnownTemplates(savedTemplates);
  }
});

test("a money share whose write may have been kept is not given again when sent again, and is logged by name", async () => {
  // Items I1: the transaction is kept, then a kept step throws. The rows are written, so the mark must stay.
  grants.attach(new MemoryStore(), "b");
  const savedTemplates = setKnownTemplates(new Map([[3, { id: 3, name: "Wolf", gold_max: 1000 } as any]]));
  let failKept = true;
  let committed = 0;
  const add = spyOn(currency, "add").mockImplementation(async (_name: string, amount: any, batch: any) => {
    batch.add({ sql: "UPDATE currency SET copper = copper + ? WHERE username = ?", values: [amount.copper, "ann"] }, () => { committed++; });
    batch.kept(() => {
      if (failKept) { failKept = false; throw new Error("cache step failed"); }
    });
    return { copper: amount.copper, silver: 0, gold: 0 } as any;
  });
  playerCache.add("901", { id: "901", username: "ann" });
  try {
    expect(await killGrant!({ username: "ann", copper: 7, id: "g4" })).toBe("failed");
    expect(committed).toBe(1);
    // Guard: nothingWritten in grantCopper. Unmarked here, the sender's resend would pay the same share twice.
    expect(await killGrant!({ username: "ann", copper: 7, id: "g4" })).toBe("given");
    expect(committed).toBe(1);
    expect(errored.some((line) => line.includes("g4") && line.includes("ann") && line.includes("7 copper") && line.includes("not given again"))).toBe(true);
  } finally {
    playerCache.remove("901");
    add.mockRestore();
    setKnownTemplates(savedTemplates);
  }
});

test("a money share whose once-only mark cannot be set is not given, and is given at most once when sent again", async () => {
  // P2: the receiver's store fails once on the mark, then the same id arrives again.
  const store = new MemoryStore();
  grants.attach(store, "b");
  const savedTemplates = setKnownTemplates(new Map([[3, { id: 3, name: "Wolf", gold_max: 1000 } as any]]));
  const paid: number[] = [];
  const add = spyOn(currency, "add").mockImplementation(async (_name: string, amount: any) => { paid.push(amount.copper); return { copper: amount.copper, silver: 0, gold: 0 } as any; });
  const real = store.setIfAbsent.bind(store);
  let failures = 1;
  const mark = spyOn(store, "setIfAbsent").mockImplementation(async (key: string, value: string, ttlMs: number) => {
    if (failures-- > 0) throw new Error("redis down");
    return real(key, value, ttlMs);
  });
  playerCache.add("901", { id: "901", username: "ann" });
  try {
    // Guard: no mark, no payment. Paid here without one, the second send below would pay it again.
    expect(await killGrant!({ username: "ann", copper: 7, id: "g3" })).toBe("failed");
    expect(paid).toEqual([]);
    expect(errored.some((line) => line.includes("g3") && line.includes("ann") && line.includes("7 copper") && line.includes("lost"))).toBe(true);
    expect(await killGrant!({ username: "ann", copper: 7, id: "g3" })).toBe("given");
    expect(await killGrant!({ username: "ann", copper: 7, id: "g3" })).toBe("given");
    expect(paid).toEqual([7]);
  } finally {
    playerCache.remove("901");
    mark.mockRestore();
    add.mockRestore();
    setKnownTemplates(savedTemplates);
  }
});

test("with the store attached a take that may have run says the owner's recovery gives it", async () => {
  grants.attach(new MemoryStore(), "a");
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  owner.handle("CHEST_TAKE", () => { throw new Error("stuck"); });
  owner.handle("GATHER_REQUEST", () => { throw new Error("stuck"); });
  (ghosts as any).mirrors.set({ kind: "chest", id: "chest_5", num: 5, from: "b", confirmedAt: 0 });
  const gatherer: any = { id: "7", username: "ann", map: "main", layerId: null, x: 1, y: 1, dead: false, stunned: false, casting: false, moving: false, inCombat: false, hasRoom: true };
  try {
    expect(await askOwner("CHEST_TAKE", "chest_5", { id: 7, username: "Alice" }, { chestId: "chest_5", indices: null })).toEqual({ ok: false, reason: "failed" });
    expect(await requestGather("b", { phase: "finish", nodeId: 3, gatherer }, "Copper Ore")).toEqual({ ok: false, reason: REASONS.failed });
    expect(warned.length).toBe(2);
    expect(warned.every((line) => line.includes("failed") && line.includes("recovery gives it"))).toBe(true);
    expect(warned.some((line) => line.includes("may be lost"))).toBe(false);
  } finally {
    owner.detach();
  }
});

test("a GRANT that failed after it was sent is sent again through the directory with the same id", async () => {
  const { a, b } = linkPair();
  const broken = new LinkCalls();
  linkCalls.attach(a);
  broken.attach(b);
  const seen: any[] = [];
  broken.handle("GRANT", (body) => { seen.push(body); throw new Error("stuck"); });
  const sent: any[] = [];
  const bus: any = { nodeId: "a", on: () => {}, toNode: async (node: string, kind: string, data: any) => { sent.push({ node, kind, data }); } };
  delivery.attach(bus, { get: async () => ({ nodeId: "b" }) } as any);
  mirrorPlayers.set("7", { id: "7", username: "Alice", remote: true, mirrorFrom: "b" });
  try {
    // With the cluster's store attached: an id, and a second send.
    grants.attach(new MemoryStore(), "a");
    expect(await sendGrant({ username: "alice", copper: 40 })).toBe("sent");
    expect(typeof seen[0].id).toBe("string");
    // Guard: the retry, and the same id on it.
    expect(sent).toEqual([{ node: "b", kind: "player-action", data: { username: "alice", action: "cells-grant", args: { username: "alice", copper: 40, id: seen[0].id } } }]);
    // Without it: as in phase 5, no id and no second send.
    grants.detach();
    seen.length = 0;
    sent.length = 0;
    expect(await sendGrant({ username: "alice", copper: 40 })).toBe("unknown");
    expect(seen[0].id).toBeUndefined();
    expect(sent).toEqual([]);
  } finally {
    broken.detach();
  }
});

test("checkedGrant keeps a grant id and drops one that is not", () => {
  expect(checkedGrant({ username: "ann", copper: 5, id: "b:1" })).toEqual({ username: "ann", copper: 5, id: "b:1" });
  expect(checkedGrant({ username: "ann", copper: 5, id: 7 })).toEqual({ username: "ann", copper: 5 });
  expect(checkedGrant({ username: "ann", copper: 5, id: "x".repeat(129) })).toEqual({ username: "ann", copper: 5 });
});

// ---------------------------------------------------------------- the writer

const parked = (over: Partial<ParkedGrant> = {}): ParkedGrant => ({ id: "b:9", owner: "b", at: 1, username: "ann", items: [{ itemName: "Bone", quantity: 2 }, { itemName: "Nothing", quantity: 1 }], copper: 11, call: "LOOT_TAKE", ...over });

test("the grant writer writes items and money in one batch and tells a player here", async () => {
  const rows: string[] = [];
  const add = spyOn(inventory, "add").mockImplementation(async (name: string, item: any) => { rows.push(`${name}+${item.name}x${item.quantity}`); return item.name !== "Nothing" ? true : undefined; });
  const pay = spyOn(currency, "add").mockImplementation(async (name: string, amount: any) => { rows.push(`${name}$${amount.copper}`); return { copper: amount.copper, silver: 0, gold: 0 } as any; });
  const packets: unknown[] = [];
  const player = { id: "7", username: "ann", wt: { readyState: 1, send: (packet: unknown) => { packets.push(packet); } } };
  // Security review M4 (secfix B): a grant's copper is held to the most a corpse of this node's templates holds.
  const savedTemplates = setKnownTemplates(new Map([[3, { id: 3, name: "Wolf", gold_max: 1000 } as any]]));
  restores.push(() => setKnownTemplates(savedTemplates));
  try {
    await giveGrant(parked(), player);
    expect(rows).toEqual(["ann+Bonex2", "ann+Nothingx1", "ann$11"]);
    expect(packets.length).toBeGreaterThan(0);
    expect(errored.some((line) => line.includes("1 x Nothing"))).toBe(true);
    packets.length = 0;
    await giveGrant(parked(), null);
    expect(packets).toEqual([]);
  } finally {
    add.mockRestore();
    pay.mockRestore();
  }
});

test("the engine's grant writer is giveGrant once it has loaded", () => {
  const previous = grants.setWriter(null);
  expect(previous).toBe(giveGrant);
  grants.setWriter(previous);
});

// Cells phase 7, Task 21: the owner's checks wait while its node may not act as owner, and a run that is over has its
// grants adopted by one other node.

const { GRANT_ADOPT_TRIES, grantAdoptKey, runGrantsKey } = await import("../cluster/grants");

/** A Grants of node `self`, run `run`, over `store`, whose recover action is recorded (and answered `online`). */
function node(store: InstanceType<typeof MemoryStore>, self: string, run: number, opts: { mayAct?: () => boolean; online?: boolean } = {}) {
  const asked: string[] = [];
  const written: string[] = [];
  const grantsHere = new Grants({
    runOnPlayer: async (_username, _action, args) => { asked.push(String((args as any)?.id)); return opts.online !== false; },
    now: Date.now,
  }, { delays: [20, 40, 80], storeRetryMs: 20, ttlMs: 300 });
  grantsHere.attach(store, self, { run, mayAct: opts.mayAct });
  grantsHere.setWriter(async (grant) => { written.push(grant.id); });
  offs.push(() => grantsHere.detach());
  return { grants: grantsHere, asked, written };
}

test("a node that may not act as owner checks nothing until it may again", async () => {
  const store = new MemoryStore();
  let may = false;
  const b = node(store, "b", 1, { mayAct: () => may, online: false });
  const id = (await b.grants.park(bones()))!;
  await wait(150);
  // No recover action was sent and nothing was written: the grant is still parked.
  expect(b.asked).toEqual([]);
  expect(b.written).toEqual([]);
  expect(await store.get(grantKey(id))).not.toBeNull();
  expect(warned.some((line) => line.includes(id) && line.includes("lease"))).toBe(true);
  may = true;
  for (let i = 0; i < 40 && b.written.length === 0; i++) await wait(10);
  expect(b.written).toEqual([id]);
  expect(await store.get(grantKey(id))).toBeNull();
});

test("a grant a node may not check before it runs out is logged lost by name", async () => {
  const store = new MemoryStore();
  const b = node(store, "b", 1, { mayAct: () => false });
  const id = (await b.grants.park(bones()))!;
  for (let i = 0; i < 60 && !errored.some((line) => line.includes(id)); i++) await wait(10);
  expect(errored.some((line) => line.includes(id) && line.includes("2 x Bone"))).toBe(true);
});

test("each parked grant is listed under its run, and taken off the list once it is settled", async () => {
  const store = new MemoryStore();
  const b = node(store, "b", 7);
  const id = (await b.grants.park(bones()))!;
  expect(await store.members(runGrantsKey("b", 7))).toEqual([id]);
  expect(await b.grants.claim(id)).toBe(true);
  // The owner's first check (at 20 ms) finds it gone, well before the list's own ttl (300 ms here) runs out.
  await wait(80);
  expect(await store.members(runGrantsKey("b", 7))).toEqual([]);
});

test("a grant the owner writes itself is taken off its run's list", async () => {
  const store = new MemoryStore();
  const b = node(store, "b", 7, { online: false });
  const id = (await b.grants.park(bones()))!;
  for (let i = 0; i < 60 && b.written.length === 0; i++) await wait(10);
  expect(b.written).toEqual([id]);
  // Well before the list's own ttl (300 ms here) runs out.
  await wait(20);
  expect(await store.members(runGrantsKey("b", 7))).toEqual([]);
});

test("the grants of a run that is over are adopted by one node, which checks them from then on", async () => {
  const store = new MemoryStore();
  // The dead run never checks: its node is gone.
  const dead = node(store, "a", 5, { mayAct: () => false });
  const first = (await dead.grants.park(bones()))!;
  const second = (await dead.grants.park({ ...bones(), username: "Bob" }))!;
  // One of them was claimed before the run died: it is not adopted.
  expect(await dead.grants.claim(second)).toBe(true);
  dead.grants.detach();

  const b = node(store, "b", 9, { online: false });
  const c = node(store, "c", 9, { online: false });
  expect(await b.grants.adoptFrom("a", 5)).toBe(1);
  // A second notice, and another node's, adopt nothing again.
  expect(await b.grants.adoptFrom("a", 5)).toBe(0);
  expect(await c.grants.adoptFrom("a", 5)).toBe(0);
  expect(await store.get(grantAdoptKey("a", 5))).toBe("b");
  expect(await store.members(runGrantsKey("a", 5))).toEqual([]);
  // Listed under its adopter's run, should that one die too.
  expect(await store.members(runGrantsKey("b", 9))).toEqual([first]);
  expect(warned.some((line) => line.includes(first) && line.includes("2 x Bone") && line.includes("checked here now"))).toBe(true);
  for (let i = 0; i < 60 && b.written.length === 0; i++) await wait(10);
  expect(b.written).toEqual([first]);
  expect(c.written).toEqual([]);
});

test("a node does not adopt its own run's grants, nor any while it may not act as owner", async () => {
  const store = new MemoryStore();
  const b = node(store, "b", 9);
  await b.grants.park(bones());
  expect(await b.grants.adoptFrom("b", 9)).toBe(0);
  expect(await store.get(grantAdoptKey("b", 9))).toBeNull();

  const dead = node(store, "a", 5, { mayAct: () => false });
  await dead.grants.park(bones());
  dead.grants.detach();
  const stale = node(store, "c", 9, { mayAct: () => false });
  expect(await stale.grants.adoptFrom("a", 5)).toBe(0);
  // It did not win the adoption, so a node that may act still can.
  expect(await store.get(grantAdoptKey("a", 5))).toBeNull();
  expect(await b.grants.adoptFrom("a", 5)).toBe(1);
});

test("an adoption the store fails is tried again by the node that won it, and given up with a line naming the run after the last try", async () => {
  const store = new MemoryStore();
  const dead = node(store, "a", 5, { mayAct: () => false });
  const id = (await dead.grants.park(bones()))!;
  dead.grants.detach();
  const b = node(store, "b", 9, { online: false });
  const members = store.members.bind(store);
  let failing = runGrantsKey("a", 5);
  let failures = 1;
  (store as any).members = async (key: string) => {
    if (key === failing && failures-- > 0) throw new Error("store away");
    return members(key);
  };
  expect(await b.grants.adoptFrom("a", 5)).toBe(0);
  for (let i = 0; i < 60 && b.written.length === 0; i++) await wait(10);
  expect(b.written).toEqual([id]);

  failing = runGrantsKey("a", 6);
  failures = GRANT_ADOPT_TRIES;
  const again = node(store, "a", 6, { mayAct: () => false });
  await again.grants.park(bones());
  again.grants.detach();
  await b.grants.adoptFrom("a", 6);
  for (let i = 0; i < 60 && !errored.some((line) => line.includes("were not adopted")); i++) await wait(10);
  expect(errored.some((line) => line.includes("run 6 of node a") && line.includes("were not adopted"))).toBe(true);
});

test("a stop and an attach again with the same store does not run an old adoption retry (review m5)", async () => {
  const store = new MemoryStore();
  const dead = node(store, "a", 5, { mayAct: () => false });
  await dead.grants.park(bones());
  dead.grants.detach();
  const b = node(store, "b", 9, { online: false });
  const members = store.members.bind(store);
  let reads = 0;
  (store as any).members = async (key: string) => {
    if (key !== runGrantsKey("a", 5)) return members(key);
    reads++;
    if (reads === 1) throw new Error("store away");
    return members(key);
  };
  expect(await b.grants.adoptFrom("a", 5)).toBe(0);
  // Stopped and started again over the same store object before the retry is due (storeRetryMs is 20).
  b.grants.detach();
  b.grants.attach(store, "b", { run: 10 });
  await wait(120);
  expect(reads).toBe(1);
  expect(b.written).toEqual([]);
});

test("an adoption still reading when the node stops and attaches again with the same store adopts nothing (review m5)", async () => {
  const store = new MemoryStore();
  const dead = node(store, "a", 5, { mayAct: () => false });
  await dead.grants.park(bones());
  dead.grants.detach();
  const b = node(store, "b", 9, { online: false });
  const members = store.members.bind(store);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  (store as any).members = async (key: string) => {
    if (key === runGrantsKey("a", 5)) await held;
    return members(key);
  };
  const adopting = b.grants.adoptFrom("a", 5);
  await wait(10);
  b.grants.detach();
  b.grants.attach(store, "b", { run: 10 });
  release();
  expect(await adopting).toBe(0);
  await wait(120);
  expect(b.written).toEqual([]);
});

// Security review H1: a grant record binds its id and the run that parked it, so a record listed or copied elsewhere
// is not adopted there (the store seals it as well: storeseal.ts).
test("a parked grant names its id, its owner and its run", async () => {
  const store = new MemoryStore();
  const dead = node(store, "a", 5, { mayAct: () => false });
  const id = (await dead.grants.park(bones()))!;
  const record = JSON.parse((await store.get(grantKey(id)))!);
  expect(record.id).toBe(id);
  expect(record.owner).toBe("a");
  expect(record.run).toBe(5);
});

test("an id listed under a run its record does not name is not adopted", async () => {
  const store = new MemoryStore();
  // b's live run 9 parks a grant; its id is put on the list of a's dead run 5.
  const live = node(store, "b", 9, { mayAct: () => false });
  const id = (await live.grants.park(bones()))!;
  await store.addToSet(runGrantsKey("a", 5), id);
  // And a's run 4 parked one, listed under run 5 too.
  const older = node(store, "a", 4, { mayAct: () => false });
  const old = (await older.grants.park({ ...bones(), username: "Bob" }))!;
  older.grants.detach();
  await store.addToSet(runGrantsKey("a", 5), old);
  const c = node(store, "c", 9, { online: false });
  // Guard: the owner and run check. Without it c checks b's live grant too, and two nodes give it.
  expect(await c.grants.adoptFrom("a", 5)).toBe(0);
  expect(warned.filter((line) => line.includes("not adopted from that list")).length).toBe(2);
  expect(await store.members(runGrantsKey("c", 9))).toEqual([]);
  expect(await store.get(grantKey(id))).not.toBeNull();
});

test("a grant record read under another id is not that grant", async () => {
  const store = new MemoryStore();
  const dead = node(store, "a", 5, { mayAct: () => false });
  const id = (await dead.grants.park(bones()))!;
  dead.grants.detach();
  // The record copied under a second id, listed with the dead run: one grant, now under two keys.
  const copy = "copied-grant-id";
  await store.set(grantKey(copy), (await store.get(grantKey(id)))!);
  await store.addToSet(runGrantsKey("a", 5), copy);
  const b = node(store, "b", 9, { online: false });
  // Guard: the id check. Without it the copy is adopted and written as a second grant.
  expect(await b.grants.adoptFrom("a", 5)).toBe(1);
  expect(await store.members(runGrantsKey("b", 9))).toEqual([id]);
  for (let i = 0; i < 60 && b.written.length === 0; i++) await wait(10);
  await wait(30);
  expect(b.written).toEqual([id]);
});
