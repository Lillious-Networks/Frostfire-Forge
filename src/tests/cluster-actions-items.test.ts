import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ghosts } from "../cluster/ghosts";
import { LinkCalls, linkCalls } from "../cluster/linkcalls";
import { mirrorPlayers } from "../cluster/mirrors";
import { askOwner, describeHandOver, fitsInRoom, itemOwner, serveItems } from "../cluster/remoteitems";
import { sendGrant, setGrantApplier, type GrantApplier } from "../systems/creatures/remotereward";
import { linkPair, settle } from "./cluster-fakelink";
import { databaseModule, mockQuery } from "./setup";
import { receiverSource as readReceiverSource } from "./receiver-source";

// kill.ts and the systems under it reach the database; none of these tests reads or writes a row.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
const { nothingWritten } = await import("../services/batch");

const { bagRoom, corpseLoot, grantsPaid, handleKill, setKnownTemplates, takeCorpseLoot } = await import("../systems/creatures/kill");
const { AIState } = await import("../systems/creatures/types");
const { default: inventory } = await import("../systems/inventory");
const { default: currency } = await import("../systems/currency");
const { default: bags } = await import("../systems/bags");
const { default: playerCache } = await import("../services/playermanager");
const { default: playerSystem } = await import("../systems/player");
const { default: log } = await import("../modules/logger");
const { default: assetCache } = await import("../services/assetCache");
const { default: loot } = await import("../systems/loot");
const { default: lootChest } = await import("../systems/lootChest");
const { default: lootTable } = await import("../systems/lootTable");
const { delivery } = await import("../cluster/deliver");
const { playerGhostKind, playerGhostRecord } = await import("../cluster/kinds/players");
const { Events, listener } = await import("../systems/events");

// Without --parallel the test files share one process: a player another file left in the cache is not this file's.
playerCache.clear();

// kill.ts sets its grant applier when it loads: this is the one the engine runs with.
const killGrant = setGrantApplier(null);
setGrantApplier(killGrant);

const offs: Array<() => void> = [];
// Every test file shares one process: what a test changes in a singleton is put back.
let savedGrant: GrantApplier | null = null;
// A share a peer sends is held to what a corpse of this node's templates holds: these tests give out at most 1000 copper.
let savedTemplates: Map<number, any> | null = null;

/** Every write the systems were asked for, and every warning and error logged, while a test runs. */
let writes: string[] = [];
let warned: string[] = [];
let errored: string[] = [];
let infos: string[] = [];
let warnBreaks = false;
let failWrite: ((username: string) => boolean) | null = null;
const restores: Array<() => void> = [];
const created: number[] = [];
const locals: string[] = [];

beforeEach(() => {
  savedGrant = setGrantApplier(null);
  savedTemplates = setKnownTemplates(new Map([[3, { id: 3, name: "Wolf", gold_max: 1000 } as any]]));
  writes = [];
  warned = [];
  errored = [];
  infos = [];
  warnBreaks = false;
  failWrite = null;
  const spy = (target: any, key: string, impl: (...args: any[]) => any) => {
    const s = spyOn(target, key).mockImplementation(impl as any);
    restores.push(() => s.mockRestore());
  };
  spy(inventory, "add", async (username: string, item: any) => { writes.push(`${username}+${item.name}x${item.quantity}`); return true; });
  spy(inventory, "get", async () => []);
  spy(bags, "capacity", async () => 25);
  spy(currency, "add", async (username: string, amount: any) => {
    if (failWrite?.(username)) throw new Error("write refused");
    writes.push(`${username}$${amount.copper}`);
    return { copper: amount.copper, silver: 0, gold: 0 };
  });
  spy(log, "info", (message: string) => { infos.push(String(message)); });
  spy(log, "warn", (message: string) => {
    warned.push(String(message));
    if (warnBreaks) throw new Error("the log broke");
  });
  spy(log, "error", (message: string) => { errored.push(String(message)); });
  // No item table loaded, as when this file runs alone: other files put an asset cache with tables of their own in
  // place for the whole run, and an owner's answer is held to the table (systems/itembounds.ts, secfix B).
  const original = assetCache.get;
  spy(assetCache, "get", async (key: string) => key === "items" ? null : original.call(assetCache, key));
});

afterEach(() => {
  if (savedTemplates) setKnownTemplates(savedTemplates);
  for (const off of offs.splice(0)) off();
  for (const restore of restores.splice(0)) restore();
  for (const id of created.splice(0)) corpseLoot.remove(id);
  for (const id of locals.splice(0)) playerCache.remove(id);
  mirrorPlayers.clear();
  (ghosts as any).mirrors.remove(5);
  setGrantApplier(savedGrant);
  delivery.detach();
  linkCalls.detach();
});

// ------------------------------------------------------------------ the calls

test("fitsInRoom takes more of a held item freely, and a new item only into a free slot", () => {
  const items = [{ itemName: "Bone" }, { itemName: "Fang" }, { itemName: "Pelt" }, { itemName: "fang" }];
  expect(fitsInRoom({ free: 1, held: ["bone"] }, items).map((item) => item.itemName)).toEqual(["Bone", "Fang", "fang"]);
  expect(fitsInRoom({ free: 0, held: [] }, items)).toEqual([]);
});

test("serveItems answers only for a mirror of the calling node, under its own name", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  const served: string[] = [];
  offs.push(serveItems("CHEST_OPEN", (actor, body) => {
    served.push(`${actor.username}:${body.chestId}`);
    return { ok: true, items: [] };
  }));
  mirrorPlayers.set("7", { id: "7", username: "Alice", remote: true, mirrorFrom: "a" });
  mirrorPlayers.set("8", { id: "8", username: "Bob", remote: true, mirrorFrom: "c" });
  const ask = (actor: any) => caller.call("b", "CHEST_OPEN", { chestId: "chest_5", actor });
  expect(await ask({ id: "7", username: "alice" })).toEqual({ ok: true, answer: { ok: true, items: [] } });
  expect(await ask({ id: "7", username: "mallory" })).toEqual({ ok: true, answer: { ok: false, reason: "not_found" } });
  expect(await ask({ id: "8", username: "bob" })).toEqual({ ok: true, answer: { ok: false, reason: "not_found" } });
  expect(await ask({ id: "9", username: "carol" })).toEqual({ ok: true, answer: { ok: false, reason: "not_found" } });
  expect(served).toEqual(["Alice:chest_5"]);
  caller.detach();
});

test("askOwner is null for a thing this node owns, and asks the owner of a mirrored one", async () => {
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  const bodies: any[] = [];
  owner.handle("CHEST_TAKE", (body) => {
    bodies.push(body);
    return { ok: true, items: [{ itemName: "Gem", quantity: 1 }] };
  });
  const player = { id: 7, username: "Alice" };
  const body = { chestId: "chest_5", indices: null };
  expect(itemOwner("CHEST_TAKE", "chest_5")).toBeNull();
  expect(await askOwner("CHEST_TAKE", "chest_5", player, body)).toBeNull();
  (ghosts as any).mirrors.set({ kind: "chest", id: "chest_5", num: 5, from: "b", confirmedAt: 0 });
  expect(itemOwner("CHEST_TAKE", "chest_5")).toBe("b");
  expect(itemOwner("PICKUP_REQUEST", "chest_5")).toBeNull();
  expect(await askOwner("CHEST_TAKE", "chest_5", player, body)).toEqual({ ok: true, items: [{ itemName: "Gem", quantity: 1 }] });
  expect(bodies).toEqual([{ chestId: "chest_5", indices: null, actor: { id: "7", username: "Alice" } }]);
  b.setUp(false);
  expect(await askOwner("CHEST_TAKE", "chest_5", player, body)).toEqual({ ok: false, reason: "failed" });
  owner.detach();
});

test("sendGrant gives money through the node a mirror came from", async () => {
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  owner.handle("GRANT", (body) => ({ result: body.copper > 100 ? "failed" : "given" }));
  mirrorPlayers.set("7", { id: "7", username: "Alice", remote: true, mirrorFrom: "b" });
  expect(await sendGrant({ username: "alice", copper: 40, message: "m" })).toBe("given");
  expect(await sendGrant({ username: "alice", copper: 400, message: "m" })).toBe("failed");
  // The node answered with a failure: it may have applied the share.
  owner.detach();
  const broken = new LinkCalls();
  broken.attach(b);
  broken.handle("GRANT", () => { throw new Error("stuck"); });
  expect(await sendGrant({ username: "alice", copper: 40, message: "m" })).toBe("unknown");
  broken.detach();
});

test("sendGrant uses the directory when the link to the mirror's node is down, because nothing was sent", async () => {
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  const asked: any[] = [];
  owner.handle("GRANT", (body) => { asked.push(body); return { result: "given" }; });
  const sent = busWith(["alice"]);
  mirrorPlayers.set("7", { id: "7", username: "Alice", remote: true, mirrorFrom: "b" });
  b.setUp(false);
  expect(await sendGrant({ username: "alice", copper: 40, message: "m" })).toBe("sent");
  expect(asked).toEqual([]);
  expect(sent.map((s) => [s.node, s.data.action])).toEqual([["b", "cells-grant"]]);
  owner.detach();
});

test("GRANT runs the grant applier, and fails with none", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  // beforeEach cleared the applier kill.ts set.
  const grant = (username: string) => caller.call("b", "GRANT", { username, copper: 1, message: "" });
  expect(await grant("alice")).toEqual({ ok: true, answer: { result: "failed" } });
  setGrantApplier(async (body) => (body.username === "alice" ? "given" : "absent"));
  expect(await grant("alice")).toEqual({ ok: true, answer: { result: "given" } });
  expect(await grant("bob")).toEqual({ ok: true, answer: { result: "absent" } });
  caller.detach();
});

test("setGrantApplier answers the applier it replaces", () => {
  const first: GrantApplier = async () => "given";
  const second: GrantApplier = async () => "absent";
  // beforeEach cleared it.
  expect(setGrantApplier(first)).toBeNull();
  expect(setGrantApplier(second)).toBe(first);
  expect(setGrantApplier(null)).toBe(second);
});

// ------------------------------------------------------------------ fixtures

const CORPSE = { x: 1000, y: 1000 };
let nextCreature = 71000;
const drop = (index: number, itemName: string, quantity: number) => ({ index, itemName, quantity, quality: "common", iconUrl: "" });
const corpse = (over: any = {}): any => ({
  id: nextCreature++, state: AIState.DEAD, map: "main", layerId: null, x: CORPSE.x, y: CORPSE.y, level: 30,
  combat: { tapper: null, corpseUntil: Date.now() + 60_000 }, ...over,
});
const mirrorAt = (id: string, name: string, over: any = {}): any => ({
  id, username: name, remote: true, mirrorFrom: "b", wt: undefined,
  location: { map: "main", position: { x: CORPSE.x, y: CORPSE.y, direction: "down" } }, aoi: { layerId: null }, ...over,
});
const localAt = (id: string, name: string, over: any = {}): any => ({
  id, username: name, wt: undefined, location: { map: "main.json", position: { x: CORPSE.x, y: CORPSE.y } }, ...over,
});

const lootOn = (creature: any, items: any[], copper: number, owners: string[], share: string[]) => {
  created.push(creature.id);
  corpseLoot.create(creature.id, items, copper, owners, share);
  return creature;
};
const addLocal = (player: any) => { playerCache.add(player.id, player); locals.push(player.id); return player; };
const sorted = (list: string[]) => [...list].sort();

/** A link to the node "b", whose GRANT is answered by `answer`; the grants it was given are collected. */
function grantsTo(answer: (body: any) => unknown) {
  const { a, b } = linkPair();
  const peer = new LinkCalls();
  linkCalls.attach(a);
  peer.attach(b);
  const grants: any[] = [];
  let broken = false;
  peer.handle("GRANT", (body) => { grants.push(body); if (broken) throw new Error("stuck"); return answer(body); });
  return { grants, link: b, fail: () => { broken = true; }, close: () => peer.detach() };
}

/** A bus that records what is sent to other nodes, and a directory that has the given players on node "b". */
function busWith(onB: string[]) {
  const sent: Array<{ node: string; kind: string; data: any }> = [];
  const handlers = new Map<string, (data: any) => unknown>();
  const bus: any = { nodeId: "a", on: (kind: string, fn: (data: any) => unknown) => { handlers.set(kind, fn); }, toNode: async (node: string, kind: string, data: any) => { sent.push({ node, kind, data }); } };
  const directory: any = { get: async (name: string) => (onB.includes(name.toLowerCase()) ? { nodeId: "b" } : null) };
  delivery.attach(bus, directory);
  return Object.assign(sent, { handlers });
}

// ------------------------------------------------------------------ taking a corpse

test("bagRoom counts the free slots and the distinct lowercase names held", async () => {
  (inventory.get as any).mockImplementation(async () => [{ item: "Bone" }, { name: "FANG" }, { item: "bone" }]);
  expect(await bagRoom("zed")).toEqual({ free: 22, held: ["bone", "fang"] });
});

test("a looter of another node gets the items and their own share in the answer, and nothing is written for them here", async () => {
  const peer = grantsTo(() => ({ result: "given" }));
  addLocal(localAt("2", "amy"));
  const creature = lootOn(corpse(), [drop(0, "Bone", 2), drop(1, "Fang", 1)], 21, ["zed"], ["zed", "amy"]);
  mirrorPlayers.set("m9", mirrorAt("m9", "Zed"));

  const result = await takeCorpseLoot(mirrorPlayers.get("m9"), creature, null, { free: 5, held: [] });
  await grantsPaid();

  expect(result).toMatchObject({ empty: true, full: false, copper: 11, taken: [expect.objectContaining({ itemName: "Bone" }), expect.objectContaining({ itemName: "Fang" })] });
  // amy, who is here, is paid here; zed's items and share are for his own node to write.
  expect(writes).toEqual(["amy$10"]);
  // Zed's share is in the answer: it is not also sent to his node as a grant.
  expect(peer.grants).toEqual([]);
  expect(warned).toEqual([]);
  expect(corpseLoot.has(creature.id)).toBe(false);
  peer.close();
});

test("what a remote looter's bags have no room for stays on the corpse, by the room their node sent", async () => {
  const creature = lootOn(corpse(), [drop(0, "Bone", 2), drop(1, "Fang", 1), drop(2, "Pelt", 1)], 0, ["zed"], ["zed"]);
  mirrorPlayers.set("m9", mirrorAt("m9", "Zed"));

  const result: any = await takeCorpseLoot(mirrorPlayers.get("m9"), creature, null, { free: 0, held: ["fang"] });

  expect(result.taken.map((item: any) => item.itemName)).toEqual(["Fang"]);
  expect(result).toMatchObject({ full: true, empty: false, copper: 0 });
  expect(result.remaining.map((item: any) => item.itemName)).toEqual(["Bone", "Pelt"]);
  expect(corpseLoot.remaining(creature.id).map((item) => item.itemName)).toEqual(["Bone", "Pelt"]);
  // With no room sent, nothing fits, and a corpse with no money to take is full.
  expect(await takeCorpseLoot(mirrorPlayers.get("m9"), creature, null)).toBe("full");
  expect(corpseLoot.remaining(creature.id).length).toBe(2);
  expect(writes).toEqual([]);
});

test("a remote looter on a layer is checked against the layer their mirror is on", async () => {
  const creature = lootOn(corpse({ layerId: "L1" }), [drop(0, "Bone", 1)], 0, ["zed"], ["zed"]);
  mirrorPlayers.set("m9", mirrorAt("m9", "Zed", { aoi: { layerId: "L2" } }));
  expect(await takeCorpseLoot(mirrorPlayers.get("m9"), creature, null, { free: 5, held: [] })).toBe("not_found");
  mirrorPlayers.get("m9").aoi.layerId = "L1";
  expect(await takeCorpseLoot(mirrorPlayers.get("m9"), creature, null, { free: 5, held: [] })).toMatchObject({ empty: true });
});

test("a member on another node is sent their share (GRANT), and not written here", async () => {
  const peer = grantsTo(() => ({ result: "given" }));
  addLocal(localAt("1", "ann"));
  mirrorPlayers.set("m3", mirrorAt("m3", "Cat"));
  const creature = lootOn(corpse(), [drop(0, "Bone", 1)], 31, ["ann"], ["ann", "cat"]);

  const result = await takeCorpseLoot(playerCache.get("1"), creature, null);
  await grantsPaid();

  expect(result).toMatchObject({ empty: true, copper: 0 });
  expect(peer.grants).toEqual([{ username: "cat", copper: 15 }]);
  // ann's own share and the item are written here; cat's is not.
  expect(sorted(writes)).toEqual(["ann$16", "ann+Bonex1"]);
  peer.close();
});

test("a share the other node did not confirm is logged and lost, and one for a member gone offline is written here", async () => {
  for (const [result, written] of [["failed", false], ["unknown", false], ["absent", true]] as const) {
    writes = [];
    warned = [];
    const peer = grantsTo(() => ({ result }));
    addLocal(localAt("1", "ann"));
    mirrorPlayers.set("m3", mirrorAt("m3", "Cat"));
    const creature = lootOn(corpse(), [drop(0, "Bone", 1)], 30, ["ann"], ["ann", "cat"]);
    if (result === "unknown") peer.fail();

    await takeCorpseLoot(playerCache.get("1"), creature, null);
    await grantsPaid();

    expect(writes.includes("cat$15")).toBe(written);
    expect(warned.some((line) => line.includes("cat") && line.includes("15 copper") && line.includes(result))).toBe(!written && true);
    playerCache.remove("1");
    mirrorPlayers.clear();
    peer.close();
    linkCalls.detach();
  }
});

test("a member on another node with no mirror is reached through the directory (cells-grant)", async () => {
  const sent = busWith(["dan"]);
  addLocal(localAt("1", "ann"));
  const creature = lootOn(corpse(), [drop(0, "Bone", 1)], 20, ["ann"], ["ann", "dan"]);

  await takeCorpseLoot(playerCache.get("1"), creature, null);
  await grantsPaid();

  expect(sorted(writes)).toEqual(["ann$10", "ann+Bonex1"]);
  expect(sent.map((s) => [s.node, s.kind, s.data.action, s.data.args])).toEqual([
    ["b", "player-action", "cells-grant", { username: "dan", copper: 10 }],
  ]);
});

test("a share for a mirror that moved on follows the directory to where the player is now, or is absent when they are nowhere", async () => {
  const sent = busWith(["cat"]);
  const peer = grantsTo(() => ({ result: "absent" }));
  mirrorPlayers.set("m3", mirrorAt("m3", "Cat"));
  expect(await sendGrant({ username: "cat", copper: 5, message: "m" })).toBe("sent");
  expect(peer.grants.length).toBe(1);
  expect(sent.map((s) => [s.node, s.data.action])).toEqual([["b", "cells-grant"]]);

  delivery.detach();
  busWith([]);
  expect(await sendGrant({ username: "cat", copper: 5, message: "m" })).toBe("absent");
  peer.close();
});

test("the cells-grant action gives the share to the player on the node it was sent to", async () => {
  const sent = busWith([]);
  addLocal(localAt("1", "ann"));
  setGrantApplier(killGrant);

  await sent.handlers.get("player-action")!({ username: "ann", action: "cells-grant", args: { username: "ann", copper: 5, message: "m" } });

  expect(writes).toEqual(["ann$5"]);
});

test("a member who is online nowhere is written here with the rest, in the same batch", async () => {
  const sent = busWith([]);
  addLocal(localAt("1", "ann"));
  const creature = lootOn(corpse(), [drop(0, "Bone", 1)], 20, ["ann"], ["ann", "eve"]);

  await takeCorpseLoot(playerCache.get("1"), creature, null);

  expect(sorted(writes)).toEqual(["ann$10", "ann+Bonex1", "eve$10"]);
  expect(sent.length).toBe(0);
});

test("when a write for a member here fails, a remote looter's items are back on the corpse and nothing is handed over", async () => {
  addLocal(localAt("2", "amy"));
  const creature = lootOn(corpse(), [drop(0, "Bone", 1)], 20, ["zed"], ["zed", "amy"]);
  mirrorPlayers.set("m9", mirrorAt("m9", "Zed"));
  failWrite = (username) => username === "amy";

  expect(await takeCorpseLoot(mirrorPlayers.get("m9"), creature, null, { free: 5, held: [] })).toBe("failed");

  expect(corpseLoot.remaining(creature.id).map((item) => item.itemName)).toEqual(["Bone"]);
  expect(corpseLoot.get(creature.id)!.copper).toBe(20);
});

test("a looter of this node is written here as before, and told no money is owed in the answer", async () => {
  addLocal(localAt("1", "ann"));
  const creature = lootOn(corpse(), [drop(0, "Bone", 1)], 20, ["ann"], ["ann"]);

  const result = await takeCorpseLoot(playerCache.get("1"), creature, null);

  expect(result).toMatchObject({ empty: true, copper: 0, taken: [expect.objectContaining({ itemName: "Bone" })] });
  expect(sorted(writes)).toEqual(["ann$20", "ann+Bonex1"]);
});

test("the grant applier gives a share to a player here, and says absent for one who is not", async () => {
  expect(killGrant).not.toBeNull();
  addLocal(localAt("1", "ann"));
  expect(await killGrant!({ username: "Ann", copper: 7, message: "m" })).toBe("given");
  expect(await killGrant!({ username: "bob", copper: 7, message: "m" })).toBe("absent");
  expect(await killGrant!({ username: "ann", copper: 0, message: "m" })).toBe("given");
  failWrite = () => true;
  expect(await killGrant!({ username: "ann", copper: 7, message: "m" })).toBe("failed");
  expect(writes).toEqual(["Ann$7"]);
});

test("GRANT reaches the engine's own applier once kill.ts has loaded", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  addLocal(localAt("1", "ann"));
  setGrantApplier(killGrant);
  expect(await caller.call("b", "GRANT", { username: "ann", copper: 5, message: "" })).toEqual({ ok: true, answer: { result: "given" } });
  expect(await caller.call("b", "GRANT", { username: "bob", copper: 5, message: "" })).toEqual({ ok: true, answer: { result: "absent" } });
  caller.detach();
});

// ------------------------------------------------------------------ the sparkle and the party key

const levelOf: Record<string, number> = { zed: 30, amy: 30 };
const zedLocalPlayer = (over: any = {}): any => ({
  id: "m9", userid: 1, username: "zed", location: { map: "main.json", position: { x: CORPSE.x, y: CORPSE.y, direction: "down" } },
  aoi: { layerId: null }, stats: { level: 30 }, moving: false, party: ["amy"], party_id: 9, ...over,
});
const kindDeps = () => ({ queueMove: () => {}, spawnQueue: new Map(), despawnQueue: new Map() });
const wolf: any = { id: 3, name: "Wolf", rank: "normal", xp_mult: 1, flags: 0, loot_table_id: null, gold_min: 10, gold_max: 10 };
const killedBy = (tapper: string, id: string): any => corpse({ combat: { tapper: { playerId: id, username: tapper }, corpseUntil: 0 } });

async function withXpSpy(body: () => Promise<void>) {
  const increase = spyOn(playerSystem, "increaseXp").mockImplementation((async (username: string) => ({ xp: 1, max_xp: 1000, level: levelOf[username] ?? 5 })) as any);
  try {
    await body();
  } finally {
    increase.mockRestore();
  }
}

test("a remote tapper with a party gets the party key for the corpse's owner: the mirror carries party_id", async () => {
  const kind = playerGhostKind(kindDeps());
  // The owner's record of the tapper is what the mirror is made of.
  try {
    kind.spawn(playerGhostRecord(zedLocalPlayer()), "b");
    expect(mirrorPlayers.get("m9")!.party_id).toBe(9);
    addLocal(localAt("2", "amy", { stats: { level: 30 }, party: ["zed"] }));
    const creature = killedBy("zed", "m9");
    created.push(creature.id);

    await withXpSpy(() => handleKill(creature, wolf));

    // Round robin by party: the first of [amy, zed] by name owns it. Without the key the tapper would, who is first in the group.
    expect([...corpseLoot.get(creature.id)!.owners]).toEqual(["amy"]);
  } finally {
    kind.despawn("m9", "test");
  }
});

test("without a party id the tapper owns the corpse", async () => {
  const kind = playerGhostKind(kindDeps());
  try {
    kind.spawn(playerGhostRecord(zedLocalPlayer({ party_id: null })), "b");
    addLocal(localAt("2", "amy", { stats: { level: 30 }, party: ["zed"] }));
    const creature = killedBy("zed", "m9");
    created.push(creature.id);

    await withXpSpy(() => handleKill(creature, wolf));

    expect([...corpseLoot.get(creature.id)!.owners]).toEqual(["zed"]);
  } finally {
    kind.despawn("m9", "test");
  }
});

test("a corpse owned by a remote member is announced to them through delivery, and one owned by a local member is not", async () => {
  const sent = busWith(["zed"]);
  // Solo tapper on another node: they own the corpse, and see it as a mirror.
  mirrorPlayers.set("m9", mirrorAt("m9", "zed", { stats: { level: 30 } }));
  const creature = killedBy("zed", "m9");
  created.push(creature.id);

  await withXpSpy(() => handleKill(creature, wolf));
  await Promise.resolve();

  expect(sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ node: "b", kind: "deliver", data: { username: "zed" } });
  const decoded = sent[0]!.data.packets.map((p: string) => JSON.parse(Buffer.from(p, "base64").toString()));
  expect(decoded).toEqual([{ type: "CREATURE_LOOTABLE", data: { id: creature.id, lootable: true } }]);

  sent.length = 0;
  mirrorPlayers.clear();
  addLocal(localAt("1", "ann", { stats: { level: 30 } }));
  const own = killedBy("ann", "1");
  created.push(own.id);
  await withXpSpy(() => handleKill(own, wolf));
  await Promise.resolve();
  expect(sent.length).toBe(0);
});

// ------------------------------------------------------------------ ground loot and chests

const dropper = { id: "1", username: "ann", location: { map: "main.json", position: { x: 100, y: 100 } } };
const looted: string[] = [];
const hearLoot = (event: any) => { looted.push(event.player.username); };

test("a mirror picks up ground loot on a map written with or without .json, and the hook is left to its own node", () => {
  looted.length = 0;
  listener.on(Events.PLAYER_LOOT_RETRIEVED, hearLoot);
  const made: string[] = [];
  try {
    const bone = loot.create(dropper, "Bone", 2, "", "common", null);
    made.push(bone.id);
    const picked = loot.pickup(mirrorAt("m9", "zed", { location: { map: "main", position: { x: 130, y: 100, direction: "down" } } }), bone.id);
    expect(picked).toMatchObject({ success: true, item: { item: "Bone", quantity: 2 } });
    expect(looted).toEqual([]);
    expect(loot.get(bone.id)).toBeUndefined();

    // A player of this node still counts it, on their node's own hook.
    const fang = loot.create(dropper, "Fang", 1, "", "common", null);
    made.push(fang.id);
    expect(loot.pickup({ id: "2", username: "bob", location: { map: "main.json", position: { x: 100, y: 100 } } }, fang.id).success).toBe(true);
    expect(looted).toEqual(["bob"]);

    // Another map, or too far, still refuses a mirror.
    const pelt = loot.create(dropper, "Pelt", 1, "", "common", null);
    made.push(pelt.id);
    expect(loot.pickup(mirrorAt("m9", "zed", { location: { map: "cave", position: { x: 100, y: 100, direction: "down" } } }), pelt.id)).toEqual({ success: false, message: "Loot is on a different map." });
    expect(loot.pickup(mirrorAt("m9", "zed", { location: { map: "main", position: { x: 900, y: 100, direction: "down" } } }), pelt.id)).toEqual({ success: false, message: "You are too far away." });
    expect(loot.get(pelt.id)).toBeDefined();
  } finally {
    listener.off(Events.PLAYER_LOOT_RETRIEVED, hearLoot);
    for (const id of made) loot.despawn(id);
  }
});

const gems = [{ index: 0, itemName: "Gem", quantity: 1 }, { index: 1, itemName: "Ruby", quantity: 2 }, { index: 2, itemName: "Opal", quantity: 1 }];

async function chestFor(player: string) {
  const roll = spyOn(lootTable, "roll").mockImplementation((async () => gems.map((gem) => ({ ...gem }))) as any);
  const id = lootChest.spawn("main.json", 100, 100, 1);
  try {
    await lootChest.open(id, player);
  } finally {
    roll.mockRestore();
  }
  return id;
}

test("a take with write off only marks the items taken: nothing is written, and a second take finds none of them", async () => {
  const id = await chestFor("m9");
  try {
    const first = await lootChest.takeItems(id, "m9", "zed", [0, 1], false);
    expect(first!.taken.map((item: any) => item.itemName)).toEqual(["Gem", "Ruby"]);
    expect(first).toMatchObject({ allTaken: false, remaining: [expect.objectContaining({ itemName: "Opal" })] });
    expect(writes).toEqual([]);
    const again = await lootChest.takeItems(id, "m9", "zed", [0, 1], false);
    expect(again!.taken).toEqual([]);
    const rest = await lootChest.takeAllItems(id, "m9", "zed", false);
    expect(rest).toMatchObject({ allTaken: true, taken: [expect.objectContaining({ itemName: "Opal" })] });
    expect(writes).toEqual([]);
  } finally {
    lootChest.despawn(id);
  }
});

test("a take for a player of this node still writes the items to them", async () => {
  const id = await chestFor("1");
  try {
    expect((await lootChest.takeItems(id, "1", "ann", [1]))!.taken.length).toBe(1);
    expect((await lootChest.takeAllItems(id, "1", "ann"))!.taken.length).toBe(2);
    expect(writes).toEqual(["ann+Rubyx2", "ann+Gemx1", "ann+Opalx1"]);
  } finally {
    lootChest.despawn(id);
  }
});

// ------------------------------------------------------------------ the receiver's owner handlers and helpers
// socket/receiver.ts cannot be imported by a test (it imports the server, which starts it), so, as the other
// receiver tests do, the code is read from its source and run with the names it uses handed in.
const receiverSource = readReceiverSource();
const receiverTranspiler = new Bun.Transpiler({ loader: "ts" });
function sliceOf(from: string, to: string): string {
  const start = receiverSource.indexOf(from);
  const end = receiverSource.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`${from} was not found in socket/receiver.ts`);
  return receiverSource.slice(start, end);
}
const compile = (parameters: string, body: string, returns: string): ((given: Record<string, any>) => any) =>
  new Function(`"use strict";\n${receiverTranspiler.transformSync(`function make({ ${parameters} }: any) { ${body.replace(/^export /gm, "")}\nreturn ${returns}; }`)}\nreturn make;`)();

const serving = compile(
  "serveItems, creatures, loot, lootChest, bareMap",
  sliceOf('serveItems("LOOT_OPEN"', "/** The player logged in on another node"),
  "undefined",
);

/** The five owner handlers, as receiver.ts registers them, over stand-ins for the systems they use. */
function owner(systems: Record<string, any>) {
  const handlers: Record<string, (actor: any, body: any) => any> = {};
  serving({
    serveItems: (name: string, fn: any) => { handlers[name] = fn; },
    bareMap: (map: unknown) => String(map ?? "").replace(/\.json$/, ""),
    creatures: {}, loot: {}, lootChest: {},
    ...systems,
  });
  return handlers;
}

test("the owner opens a corpse for a mirror, and says why when it cannot", () => {
  const asked: any[] = [];
  const handlers = owner({ creatures: { openCorpseFor: (actor: any, id: number) => { asked.push([actor.username, id]); return id === 5 ? "too_far" : { items: [{ index: 0 }], copper: 7 }; } } });
  expect(handlers.LOOT_OPEN!({ username: "zed" }, { creatureId: "5" })).toEqual({ ok: false, reason: "too_far" });
  expect(handlers.LOOT_OPEN!({ username: "zed" }, { creatureId: "6" })).toEqual({ ok: true, items: [{ index: 0 }], copper: 7 });
  expect(asked).toEqual([["zed", 5], ["zed", 6]]);
});

test("the owner takes a corpse for a mirror with the indices and the room it was sent, and answers what was taken", async () => {
  const asked: any[] = [];
  const room = { free: 2, held: ["bone"] };
  const handlers = owner({
    creatures: {
      takeCorpseLootFor: async (actor: any, id: number, indices: any, given: any) => {
        asked.push([actor.username, id, indices, given]);
        return id === 5 ? "full" : { taken: [{ itemName: "Bone" }], copper: 11, empty: true, full: false, remaining: [] };
      },
    },
  });
  expect(await handlers.LOOT_TAKE!({ username: "zed" }, { creatureId: "5", indices: null, room })).toEqual({ ok: false, reason: "full" });
  expect(await handlers.LOOT_TAKE!({ username: "zed" }, { creatureId: "6", indices: ["1", "x", 2], room })).toEqual({
    ok: true, items: [{ itemName: "Bone" }], copper: 11, empty: true, full: false, remaining: [],
  });
  expect(asked).toEqual([["zed", 5, null, room], ["zed", 6, [1, 2], room]]);
});

test("the owner lets a mirror pick up ground loot, and gives the reason when it cannot", () => {
  const picked: any[] = [];
  const handlers = owner({
    loot: { pickup: (actor: any, id: string) => { picked.push([actor.username, id]); return id === "loot_1" ? { success: true, item: { id, item: "Bone" } } : { success: false, message: "You are too far away." }; } },
  });
  expect(handlers.PICKUP_REQUEST!({ username: "zed" }, { lootId: "loot_1" })).toEqual({ ok: true, item: { id: "loot_1", item: "Bone" } });
  expect(handlers.PICKUP_REQUEST!({ username: "zed" }, { lootId: "loot_2" })).toEqual({ ok: false, reason: "You are too far away." });
  expect(picked).toEqual([["zed", "loot_1"], ["zed", "loot_2"]]);
});

test("the owner opens a chest for a mirror only on its map and within range, for the mirror's own id", async () => {
  const opened: any[] = [];
  const chests: Record<string, any> = { c1: { map: "main.json" }, c2: { map: "cave.json" }, c3: { map: "main.json" }, c4: { map: "main.json" } };
  const handlers = owner({
    lootChest: {
      getChest: (id: string) => chests[id],
      isWithinRange: (id: string) => id !== "c3",
      open: async (id: string, playerId: string) => { opened.push([id, playerId]); return id === "c4" ? null : { items: [{ index: 0 }] }; },
    },
  });
  const zed = { id: 9, username: "zed", location: { map: "main", position: { x: 1, y: 2 } } };
  expect(await handlers.CHEST_OPEN!(zed, { chestId: "c1" })).toEqual({ ok: true, items: [{ index: 0 }] });
  expect(await handlers.CHEST_OPEN!(zed, { chestId: "c0" })).toEqual({ ok: false, reason: "Chest not found." });
  expect(await handlers.CHEST_OPEN!(zed, { chestId: "c2" })).toEqual({ ok: false, reason: "Chest is on a different map." });
  expect(await handlers.CHEST_OPEN!(zed, { chestId: "c3" })).toEqual({ ok: false, reason: "You are too far from the chest." });
  expect(await handlers.CHEST_OPEN!(zed, { chestId: "c4" })).toEqual({ ok: false, reason: "Could not open chest." });
  expect(opened).toEqual([["c1", "9"], ["c4", "9"]]);
});

test("the owner takes chest items for a mirror without writing them: some by index, or all", async () => {
  const asked: any[] = [];
  const handlers = owner({
    lootChest: {
      takeItems: async (...args: any[]) => { asked.push(["some", ...args]); return args[0] === "gone" ? null : { taken: [{ itemName: "Gem" }], remaining: [{ itemName: "Opal" }], allTaken: false }; },
      takeAllItems: async (...args: any[]) => { asked.push(["all", ...args]); return { taken: [{ itemName: "Gem" }, { itemName: "Opal" }], allTaken: true }; },
    },
  });
  const zed = { id: 9, username: "zed" };
  expect(await handlers.CHEST_TAKE!(zed, { chestId: "c1", indices: ["0", 3] })).toEqual({ ok: true, items: [{ itemName: "Gem" }], remaining: [{ itemName: "Opal" }], allTaken: false });
  expect(await handlers.CHEST_TAKE!(zed, { chestId: "c1", indices: null })).toEqual({ ok: true, items: [{ itemName: "Gem" }, { itemName: "Opal" }], remaining: [], allTaken: true });
  expect(await handlers.CHEST_TAKE!(zed, { chestId: "gone", indices: [0] })).toEqual({ ok: false, reason: "Could not take items." });
  // write = false on every one: the items are written on the player's node.
  expect(asked).toEqual([["some", "c1", "9", "zed", [0, 3], false], ["all", "c1", "9", "zed", false], ["some", "gone", "9", "zed", [0], false]]);
});

const helping = compile(
  "atomically, nothingWritten, inventory, currencySystem, sendPacket, packetManager, formatMoney, log, itemOwner, askOwner, bagRoom, creatures, listener, Events, bareMap, lootChest, loot, playerCache",
  sliceOf("function stillHere(", "/** getPlayersNearPoint, and the mirrored players"),
  "{ receiveHanded, takeCorpseLootHere, takeChestItems, openCorpseHere, pickupLootHere, openChestOnOwner, stillHere }",
);

/** receiver.ts's helpers over stand-ins that record what they are asked and what is sent to the player. */
function player(over: Record<string, any> = {}) {
  const calls: any[][] = [];
  const sentTo: string[] = [];
  const emitted: any[] = [];
  const errors: string[] = [];
  let writeFails = false;
  let notItems: string[] = [];
  let owned: string | null = "b";
  const me: any = { id: "7", username: "Zed", wt: {}, location: { map: "main.json", position: { x: 4, y: 5 } } };
  let session: any = me;
  let answer: any = { ok: true, items: [], copper: 0 };
  const given: Record<string, any> = {
    atomically: async (_names: string[], work: any) => work({}),
    // The real one: the stand-in batch above marks nothing as unsent, so every failure counts as one that may be written.
    nothingWritten,
    inventory: { add: async (name: string, item: any) => { if (writeFails) throw new Error("refused"); calls.push(["add", name, item]); return notItems.includes(item.name) ? undefined : true; } },
    playerCache: { get: () => session },
    loot: { pickup: (...args: any[]) => { calls.push(["pickup", ...args]); return { success: true, item: { item: "Bone", quantity: 1, map: "main.json", x: 1, y: 2 } }; } },
    currencySystem: { add: async (name: string, amount: any) => { calls.push(["pay", name, amount.copper]); return { copper: amount.copper, silver: 0, gold: 0 }; } },
    sendPacket: (_wt: any, packets: any[]) => { sentTo.push(packets[0]); },
    packetManager: new Proxy({}, { get: (_t, kind) => (data: any) => [`${String(kind)}:${JSON.stringify(data)}`] }),
    formatMoney: (copper: number) => `${copper} copper`,
    log: { error: (message: string) => { errors.push(message); } },
    itemOwner: () => owned,
    askOwner: async (...args: any[]) => { calls.push(["ask", ...args]); return answer; },
    bagRoom: async () => ({ free: 3, held: ["bone"] }),
    creatures: {
      takeCorpseLootFor: async (...args: any[]) => { calls.push(["local", ...args]); return "local-result"; },
      openCorpseFor: (...args: any[]) => { calls.push(["openLocal", ...args]); return "local-open"; },
    },
    listener: { emit: (event: string, data: any) => { emitted.push([event, data]); } },
    Events: { PLAYER_LOOT_RETRIEVED: "retrieved" },
    bareMap: (map: unknown) => String(map ?? "").replace(/\.json$/, ""),
    lootChest: {
      takeItems: async (...args: any[]) => { calls.push(["chestSome", ...args]); return { taken: [], remaining: [], allTaken: false }; },
      takeAllItems: async (...args: any[]) => { calls.push(["chestAll", ...args]); return { taken: [], allTaken: true }; },
    },
    ...over,
  };
  return {
    me,
    helpers: helping(given),
    calls, sentTo, emitted, errors,
    answerWith: (value: any) => { answer = value; },
    ownedBy: (node: string | null) => { owned = node; },
    failWrites: () => { writeFails = true; },
    notItems: (...names: string[]) => { notItems = names; },
    leave: () => { session = undefined; },
    logIn: () => { session = { ...me, wt: {} }; },
  };
}

test("a corpse this node owns is taken as before, with no call and no room", async () => {
  const t = player();
  t.ownedBy(null);
  expect(await t.helpers.takeCorpseLootHere(t.me, 50, [1])).toBe("local-result");
  expect(t.calls).toEqual([["local", t.me, 50, [1]]]);
});

test("a corpse another node owns is taken by a call with the room in the bags, and what comes back is written here", async () => {
  const t = player();
  t.answerWith({ ok: true, items: [{ itemName: "Bone", quantity: 2, quality: "rare" }], copper: 11, empty: true, full: false, remaining: [] });

  const result = await t.helpers.takeCorpseLootHere(t.me, 50, null);

  expect(result).toEqual({ taken: [{ itemName: "Bone", quantity: 2, quality: "rare" }], empty: true, full: false, remaining: [], copper: 0 });
  expect(t.calls[0]).toEqual(["ask", "LOOT_TAKE", 50, t.me, { creatureId: 50, indices: null, room: { free: 3, held: ["bone"] } }]);
  expect(t.calls.slice(1)).toEqual([["add", "Zed", { name: "Bone", quantity: 2 }], ["pay", "Zed", 11]]);
  // The player is told their money and each item; the hook that counts loot runs on this node; an emptied corpse stops sparkling.
  expect(t.sentTo).toEqual([
    'currency:{"copper":11,"silver":0,"gold":0}',
    'notify:{"message":"You receive loot: 11 copper"}',
    'lootReceived:{"itemName":"Bone","quantity":2,"quality":"rare"}',
    'creatureLootable:{"id":50,"lootable":false}',
  ]);
  expect(t.emitted).toEqual([["retrieved", { player: t.me, itemName: "Bone", quantity: 2, mapName: "main", x: 4, y: 5 }]]);
});

test("a refused or failed corpse call gives its reason, and nothing is written", async () => {
  const t = player();
  t.answerWith({ ok: false, reason: "too_far" });
  expect(await t.helpers.takeCorpseLootHere(t.me, 50, null)).toBe("too_far");
  t.answerWith({ ok: false });
  expect(await t.helpers.takeCorpseLootHere(t.me, 50, null)).toBe("failed");
  t.answerWith(null);
  expect(await t.helpers.takeCorpseLootHere(t.me, 50, null)).toBe("failed");
  expect(t.calls.filter((call) => call[0] === "add" || call[0] === "pay")).toEqual([]);
  expect(t.sentTo).toEqual([]);
});

test("items the owner handed over that cannot be written here are lost and logged, and the take fails", async () => {
  const t = player();
  t.answerWith({ ok: true, items: [{ itemName: "Bone", quantity: 2 }], copper: 3, empty: false, full: false, remaining: [] });
  t.failWrites();

  expect(await t.helpers.takeCorpseLootHere(t.me, 50, null)).toBe("failed");

  expect(t.errors.length).toBe(1);
  expect(t.errors[0]).toContain("Zed");
  expect(t.errors[0]).toContain("Bone");
  expect(t.sentTo).toEqual([]);
  expect(t.emitted).toEqual([]);
});

test("nothing handed over is nothing to write", async () => {
  const t = player();
  expect(await t.helpers.receiveHanded(t.me, [], 0)).toEqual([]);
  expect(t.calls).toEqual([]);
});

test("chest items are taken from this node's chest as before, or by a call to the node that owns it", async () => {
  const t = player();
  t.answerWith(null);
  await t.helpers.takeChestItems(t.me, "c1", [0]);
  expect(await t.helpers.takeChestItems(t.me, "c1", null)).toEqual({ taken: [], allTaken: true, remaining: [] });
  expect(t.calls.filter((call) => call[0].startsWith("chest"))).toEqual([["chestSome", "c1", "7", "Zed", [0]], ["chestAll", "c1", "7", "Zed"]]);

  const remote = player();
  remote.answerWith({ ok: true, items: [{ itemName: "Gem", quantity: 1 }], remaining: [{ itemName: "Opal" }], allTaken: false });
  expect(await remote.helpers.takeChestItems(remote.me, "c1", [0])).toEqual({ taken: [{ itemName: "Gem", quantity: 1 }], remaining: [{ itemName: "Opal" }], allTaken: false });
  expect(remote.calls).toEqual([["ask", "CHEST_TAKE", "c1", remote.me, { chestId: "c1", indices: [0] }], ["add", "Zed", { name: "Gem", quantity: 1 }]]);

  const refused = player();
  refused.answerWith({ ok: false, reason: "failed" });
  expect(await refused.helpers.takeChestItems(refused.me, "c1", null)).toBeNull();
  const lost = player();
  lost.answerWith({ ok: true, items: [{ itemName: "Gem", quantity: 1 }], remaining: [], allTaken: true });
  lost.failWrites();
  expect(await lost.helpers.takeChestItems(lost.me, "c1", null)).toBeNull();
  expect(lost.errors.length).toBe(1);
});

test("the packet cases hand over to the helpers, and the batch pickup stays on this node's loot", () => {
  const once = (text: string) => expect(receiverSource.split(text).length - 1).toBe(1);
  once("const opened = await openCorpseHere(currentPlayer, creatureId);");
  once("const result = await takeCorpseLootHere(currentPlayer, creatureId, indices);");
  once("const picked = await pickupLootHere(currentPlayer, lootId);");
  once("const openedRemote = await openChestOnOwner(currentPlayer, String(chestId));");
  once("const result = await takeChestItems(currentPlayer, String(chestId), indices);");
  once("const result = await takeChestItems(currentPlayer, String(chestId), null);");
  // A chest another node owns is answered there and the case ends: it does not go on to look in this node's chests.
  once(`if (openedRemote) {
          sendPacket(wt, openedRemote);
          break;
        }`);
  // What a failed pickup says, and the silent end of a pickup that added nothing.
  once(`if (!picked.added) {
          if (picked.message) sendPacket(wt, packetManager.notify({ message: picked.message }));
          break;
        }`);
  once("const items = loot.pickupAllNearby(currentPlayer);");
  expect(receiverSource).not.toContain("await lootChest.takeItems(chestId, String(currentPlayer.id)");
  expect(receiverSource).not.toContain("await lootChest.takeAllItems(chestId, String(currentPlayer.id)");
});

test("the creature system hands the bag room on to the corpse", () => {
  const indexSource = readFileSync(join(import.meta.dir, "..", "systems", "creatures", "index.ts"), "utf8");
  expect(indexSource).toContain("export function takeCorpseLootFor(player: any, creatureId: number, indices: number[] | null, room?: BagRoom) {");
  expect(indexSource).toContain("return takeCorpseLoot(player, localCreature(creatureId), indices, room);");
});

// ================================================================== fix round 1

// ------------------------------------------------------------------ I1: a hand-over that is lost is on record

test("describeHandOver names the items and the money an answer hands over, and nothing for an answer that hands none", () => {
  expect(describeHandOver({ ok: true, items: [{ itemName: "Bone", quantity: 2 }, { itemName: "Fang", quantity: 1 }], copper: 11 })).toBe("2 x Bone, 1 x Fang, 11 copper");
  expect(describeHandOver({ ok: true, item: { item: "Pelt", quantity: 3 } })).toBe("3 x Pelt");
  expect(describeHandOver({ ok: true, items: [], copper: 0 })).toBe("");
});

test("the owner logs what each take hands over, by actor, calling node and item, and logs nothing for the rest", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  offs.push(serveItems("LOOT_TAKE", () => ({ ok: true, items: [{ itemName: "Bone", quantity: 2 }], copper: 11 })));
  offs.push(serveItems("PICKUP_REQUEST", () => ({ ok: true, item: { item: "Pelt", quantity: 1 } })));
  offs.push(serveItems("CHEST_TAKE", () => ({ ok: true, items: [] })));
  offs.push(serveItems("LOOT_OPEN", () => ({ ok: true, items: [{ itemName: "Bone", quantity: 2 }], copper: 5 })));
  mirrorPlayers.set("7", { id: "7", username: "Alice", remote: true, mirrorFrom: "a" });
  const ask = (name: string, actor = { id: "7", username: "alice" }) => caller.call("b", name, { actor });

  await ask("LOOT_TAKE");
  await ask("PICKUP_REQUEST");
  // Nothing taken, a look only, and a stranger: no line.
  await ask("CHEST_TAKE");
  await ask("LOOT_OPEN");
  await ask("LOOT_TAKE", { id: "8", username: "mallory" });

  expect(infos).toEqual([
    "LOOT_TAKE from a: Alice (7) was handed 2 x Bone, 11 copper",
    "PICKUP_REQUEST from a: Alice (7) was handed 1 x Pelt",
  ]);
  caller.detach();
});

test("a take whose call fails after it was sent is warned about, and one that was never sent or only looks is not", async () => {
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  owner.handle("CHEST_TAKE", () => { throw new Error("stuck"); });
  owner.handle("CHEST_OPEN", () => { throw new Error("stuck"); });
  (ghosts as any).mirrors.set({ kind: "chest", id: "chest_5", num: 5, from: "b", confirmedAt: 0 });
  const player = { id: 7, username: "Alice" };

  expect(await askOwner("CHEST_TAKE", "chest_5", player, {})).toEqual({ ok: false, reason: "failed" });
  expect(warned.length).toBe(1);
  expect(warned[0]).toContain("CHEST_TAKE");
  expect(warned[0]).toContain("chest_5");
  expect(warned[0]).toContain("Alice");
  expect(warned[0]).toContain("failed");

  // A look takes nothing, so there is nothing to warn about.
  expect(await askOwner("CHEST_OPEN", "chest_5", player, {})).toEqual({ ok: false, reason: "failed" });
  expect(warned.length).toBe(1);

  // The link is down: nothing was sent, so nothing was taken.
  b.setUp(false);
  expect(await askOwner("CHEST_TAKE", "chest_5", player, {})).toEqual({ ok: false, reason: "failed" });
  expect(warned.length).toBe(1);
  owner.detach();
});

// ------------------------------------------------------------------ I2: the looter is answered first

const sleep = (ms: number) => new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), ms));

test("a share owed to a node that does not answer does not hold back the looter's answer, and is paid once it does", async () => {
  let release!: () => void;
  const peer = grantsTo(() => new Promise((resolve) => { release = () => resolve({ result: "given" }); }));
  addLocal(localAt("1", "ann"));
  mirrorPlayers.set("m3", mirrorAt("m3", "Cat"));
  const creature = lootOn(corpse(), [drop(0, "Bone", 1)], 30, ["ann"], ["ann", "cat"]);

  const result: any = await Promise.race([takeCorpseLoot(playerCache.get("1"), creature, null), sleep(1000)]);

  // Answered, with the items and the looter's share written, while cat's grant is still out.
  expect(result).toMatchObject({ empty: true, taken: [expect.objectContaining({ itemName: "Bone" })] });
  expect(sorted(writes)).toEqual(["ann$15", "ann+Bonex1"]);
  expect(corpseLoot.has(creature.id)).toBe(false);
  await settle();
  expect(peer.grants.length).toBe(1);
  release();
  await grantsPaid();
  // Paid once, by that grant; nothing more is written here.
  expect(peer.grants.length).toBe(1);
  expect(sorted(writes)).toEqual(["ann$15", "ann+Bonex1"]);
  expect(warned).toEqual([]);
  peer.close();
});

test("a failure while paying the shares is logged, not thrown, and the looter is unaffected", async () => {
  const peer = grantsTo(() => ({ result: "failed" }));
  addLocal(localAt("1", "ann"));
  mirrorPlayers.set("m3", mirrorAt("m3", "Cat"));
  const creature = lootOn(corpse(), [drop(0, "Bone", 1)], 30, ["ann"], ["ann", "cat"]);
  // The warning about the lost share is the first thing to go wrong.
  warnBreaks = true;

  expect(await takeCorpseLoot(playerCache.get("1"), creature, null)).toMatchObject({ empty: true });
  await grantsPaid();

  expect(errored.some((line) => line.includes("cat") && line.includes("15 copper") && line.includes("the log broke"))).toBe(true);
  peer.close();
});

// ------------------------------------------------------------------ m3: a cells-grant that does not land is warned about

test("a cells-grant the applier did not give is warned about, and so is an action that finds no player here", async () => {
  const sent = busWith([]);
  addLocal(localAt("1", "ann"));
  setGrantApplier(async () => "absent");

  await sent.handlers.get("player-action")!({ username: "ann", action: "cells-grant", args: { username: "ann", copper: 5, message: "m" } });
  expect(warned.length).toBe(1);
  expect(warned[0]).toContain("ann");
  expect(warned[0]).toContain("5 copper");
  expect(warned[0]).toContain("absent");

  setGrantApplier(async () => "given");
  await sent.handlers.get("player-action")!({ username: "ann", action: "cells-grant", args: { username: "ann", copper: 5, message: "m" } });
  expect(warned.length).toBe(1);

  await sent.handlers.get("player-action")!({ username: "nobody", action: "cells-grant", args: { username: "nobody", copper: 9, message: "m" } });
  expect(warned.length).toBe(2);
  expect(warned[1]).toContain("cells-grant");
  expect(warned[1]).toContain("nobody");
  expect(warned[1]).toContain("9 copper");
});

// ------------------------------------------------------------------ the receiver's other helpers

test("a corpse is opened here as before, or by a call to the node that owns it", async () => {
  const local = player();
  local.ownedBy(null);
  // The stand-in's askOwner answers as if it were remote, so answer null the way it does for a corpse of this node.
  local.answerWith(null);
  expect(await local.helpers.openCorpseHere(local.me, 50)).toBe("local-open");
  expect(local.calls).toEqual([["ask", "LOOT_OPEN", 50, local.me, { creatureId: 50 }], ["openLocal", local.me, 50]]);

  const remote = player();
  remote.answerWith({ ok: true, items: [{ index: 0, itemName: "Bone" }], copper: 7 });
  expect(await remote.helpers.openCorpseHere(remote.me, 50)).toEqual({ items: [{ index: 0, itemName: "Bone" }], copper: 7 });
  remote.answerWith({ ok: true });
  expect(await remote.helpers.openCorpseHere(remote.me, 50)).toEqual({ items: [], copper: 0 });
  remote.answerWith({ ok: false, reason: "too_far" });
  expect(await remote.helpers.openCorpseHere(remote.me, 50)).toBe("too_far");
  remote.answerWith({ ok: false });
  expect(await remote.helpers.openCorpseHere(remote.me, 50)).toBe("failed");
});

test("a chest is opened on its owner with the packets that answer, and not at all when this node owns it", async () => {
  const t = player();
  t.answerWith(null);
  expect(await t.helpers.openChestOnOwner(t.me, "c1")).toBeNull();
  t.answerWith({ ok: false, reason: "You are too far from the chest." });
  expect(await t.helpers.openChestOnOwner(t.me, "c1")).toEqual(['notify:{"message":"You are too far from the chest."}']);
  t.answerWith({ ok: false });
  expect(await t.helpers.openChestOnOwner(t.me, "c1")).toEqual(['notify:{"message":"Could not open chest."}']);
  t.answerWith({ ok: true, items: [] });
  expect(await t.helpers.openChestOnOwner(t.me, "c1")).toEqual(['notify:{"message":"This chest is empty for you."}']);
  t.answerWith({ ok: true, items: [{ index: 0, itemName: "Gem" }] });
  expect(await t.helpers.openChestOnOwner(t.me, "c1")).toEqual(['lootChestContents:{"chestId":"c1","items":[{"index":0,"itemName":"Gem"}]}']);
});

test("ground loot is picked up here as before: the hook is the owner's", async () => {
  const t = player();
  t.answerWith(null);
  expect(await t.helpers.pickupLootHere(t.me, "loot_1")).toEqual({ added: true });
  expect(t.calls).toEqual([["ask", "PICKUP_REQUEST", "loot_1", t.me, { lootId: "loot_1" }], ["pickup", t.me, "loot_1"], ["add", "Zed", { name: "Bone", quantity: 1 }]]);
  expect(t.emitted).toEqual([]);
  // A write that throws on this node's own loot is not caught here, as before.
  t.failWrites();
  await expect(t.helpers.pickupLootHere(t.me, "loot_1")).rejects.toThrow("refused");
});

test("ground loot of another node is added here and counted here, and what is refused gives its message", async () => {
  const t = player();
  t.answerWith({ ok: true, item: { item: "Pelt", quantity: 3, map: "main.json", x: 1, y: 2 } });

  expect(await t.helpers.pickupLootHere(t.me, "loot_1")).toEqual({ added: true });

  expect(t.calls.slice(1)).toEqual([["add", "Zed", { name: "Pelt", quantity: 3 }]]);
  expect(t.emitted).toEqual([["retrieved", { player: t.me, itemName: "Pelt", quantity: 3, mapName: "main.json", x: 1, y: 2 }]]);

  t.answerWith({ ok: false, reason: "You are too far away." });
  expect(await t.helpers.pickupLootHere(t.me, "loot_1")).toEqual({ added: false, message: "You are too far away." });
  t.answerWith({ ok: false });
  expect(await t.helpers.pickupLootHere(t.me, "loot_1")).toEqual({ added: false, message: "Could not pick up loot." });
  t.answerWith({ ok: true });
  expect(await t.helpers.pickupLootHere(t.me, "loot_1")).toEqual({ added: false, message: "Could not pick up loot." });
});

test("loot another node handed over that cannot be added here is lost and logged by name, never silently", async () => {
  const item = { ok: true, item: { item: "Pelt", quantity: 3, map: "main.json", x: 1, y: 2 } };

  const refused = player();
  refused.answerWith(item);
  refused.failWrites();
  expect(await refused.helpers.pickupLootHere(refused.me, "loot_1")).toEqual({ added: false });
  expect(refused.errors.length).toBe(1);
  expect(refused.errors[0]).toContain("Zed");
  expect(refused.errors[0]).toContain("Pelt x3");
  expect(refused.errors[0]).toContain("refused");

  const nothing = player();
  nothing.answerWith(item);
  nothing.notItems("Pelt");
  expect(await nothing.helpers.pickupLootHere(nothing.me, "loot_1")).toEqual({ added: false });
  expect(nothing.errors.length).toBe(1);
  expect(nothing.errors[0]).toContain("Pelt x3");
  expect(nothing.emitted).toEqual([]);

  // The player left while the call was out: another node may hold their rows now, so nothing is written.
  const gone = player();
  gone.answerWith(item);
  gone.leave();
  expect(await gone.helpers.pickupLootHere(gone.me, "loot_1")).toEqual({ added: false });
  expect(gone.errors.length).toBe(1);
  expect(gone.errors[0]).toContain("Pelt x3");
  expect(gone.errors[0]).toContain("left meanwhile");
  expect(gone.calls.filter((call) => call[0] === "add")).toEqual([]);
});

test("only the items that were really added are written, told and counted; the rest are logged by name", async () => {
  const t = player();
  t.answerWith({ ok: true, items: [{ itemName: "Bone", quantity: 2 }, { itemName: "Junk", quantity: 1 }], copper: 3, empty: false, full: false, remaining: [] });
  t.notItems("Junk");

  const result = await t.helpers.takeCorpseLootHere(t.me, 50, null);

  expect(result).toMatchObject({ taken: [expect.objectContaining({ itemName: "Bone" }), expect.objectContaining({ itemName: "Junk" })] });
  expect(t.sentTo.filter((packet: string) => packet.startsWith("lootReceived"))).toEqual(['lootReceived:{"itemName":"Bone","quantity":2,"quality":"common"}']);
  expect(t.emitted.map((event: any) => event[1].itemName)).toEqual(["Bone"]);
  expect(t.errors.length).toBe(1);
  expect(t.errors[0]).toContain("1 x Junk");
  expect(t.errors[0]).toContain("Zed");
});

test("items handed over for a player who left, or who logged in again, are not written and are logged by name", async () => {
  for (const change of ["leave", "logIn"] as const) {
    const t = player();
    t.answerWith({ ok: true, items: [{ itemName: "Bone", quantity: 2 }], copper: 3, empty: false, full: false, remaining: [] });
    t[change]();

    expect(await t.helpers.takeCorpseLootHere(t.me, 50, null)).toBe("failed");

    expect(t.calls.filter((call) => call[0] === "add" || call[0] === "pay")).toEqual([]);
    expect(t.errors.length).toBe(1);
    expect(t.errors[0]).toContain("Bone");
    expect(t.errors[0]).toContain("3 copper");
    expect(t.errors[0]).toContain("left meanwhile");
    expect(t.sentTo).toEqual([]);
  }
  const here = player();
  expect(here.helpers.stillHere(here.me)).toBe(true);
});
