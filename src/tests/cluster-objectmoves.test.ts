import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { databaseModule, mockQuery } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { default: loot } = await import("../systems/loot");
const { default: lootChest } = await import("../systems/lootChest");
const { default: skeletons } = await import("../systems/skeletons");
const tornadoes = await import("../systems/tornadoes");
const { objectMovesPart, OBJECTS_PART } = await import("../cluster/kinds/objectmoves");
const { default: log } = await import("../modules/logger");
const { default: assetCache } = await import("../services/assetCache");
import type { LootItem } from "../systems/loot";
import type { MovedObjects } from "../cluster/kinds/objectmoves";

const MAP = "mvtest";
const move = { id: "m1", map: MAP, bx: 0, by: 0, from: "f", to: "t" };
const dropper = (x: number, y: number) => ({ id: "d1", username: "dropper", location: { map: `${MAP}.json`, position: { x, y } } });
const always = (itemName: string, quantity: number) => ({ itemName, minQuantity: quantity, maxQuantity: quantity, dropChance: 100 }) as any;
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

let warnings: string[];
let warnSpy: { mockRestore(): void };
let itemsSpy: { mockRestore(): void };
const made = { loot: [] as string[], chests: [] as string[], skeletons: [] as string[] };
beforeEach(() => {
  warnings = [];
  warnSpy = spyOn(log, "warn").mockImplementation((message: string) => { warnings.push(String(message)); });
  // A moved chest's rolled items are held to the item table (objectmoves.ts isRolledItem). These tests are not about
  // names: no table is loaded, so an item table another test file left in the asset cache does not drop their rolls.
  const original = assetCache.get;
  itemsSpy = spyOn(assetCache, "get").mockImplementation(async (key: string) => key === "items" ? null : original.call(assetCache, key));
});
afterEach(() => {
  warnSpy.mockRestore();
  itemsSpy.mockRestore();
  for (const id of made.loot.splice(0)) { loot.despawn(id); loot.removeRemote(id); }
  for (const id of made.chests.splice(0)) { lootChest.despawn(id); lootChest.removeRemote(id); }
  for (const id of made.skeletons.splice(0)) { skeletons.despawn(id); skeletons.removeRemote(id); }
  tornadoes.resetTornadoes();
  tornadoes.setTornadoBridge(null);
});

function setup(adopt = true) {
  const calls: string[] = [];
  const shown: string[] = [];
  const part = objectMovesPart({
    now: () => Date.now(),
    ghosts: {
      handOver: (kind, id, to) => { calls.push(`handOver ${kind} ${id} ${to}`); },
      adoptMirror: (kind, record, from) => { calls.push(`adoptMirror ${kind} ${record.id} ${from}`); return adopt; },
      dropMirror: (kind, id) => { calls.push(`dropMirror ${kind} ${id}`); },
    },
    views: {
      showLoot: (l) => shown.push(`show loot ${l.id}`),
      hideLoot: (l) => shown.push(`hide loot ${l.id}`),
      showChest: (c) => shown.push(`show chest ${c.id}`),
      hideChest: (c) => shown.push(`hide chest ${c.id}`),
      showSkeleton: (s) => shown.push(`show skeleton ${s.id}`),
      hideSkeleton: (s) => shown.push(`hide skeleton ${s.id}`),
    },
  });
  return { part, calls, shown };
}

function dropLoot(x: number, y: number, item = "Bone"): LootItem {
  const l = loot.create(dropper(x, y), item, 2, "", "common", null);
  made.loot.push(l.id);
  return l;
}
const onMap = (id: string) => loot.getOnMap(`${MAP}.json`).filter((l) => l.id === id).length;

test("loot in the block leaves this node, stays shown as the new owner's mirror, and cannot be picked up here", async () => {
  const { part, calls, shown } = setup();
  expect(part.name).toBe(OBJECTS_PART);
  expect(part.order).toBe(1);
  const inside = dropLoot(10, 10);
  const outside = dropLoot(5_000, 10);
  const data = await part.collect(move);
  expect(data.loot.map((l) => l.id)).toEqual([inside.id]);
  expect(loot.get(inside.id)).toBeUndefined();
  expect(loot.get(outside.id)).toBeDefined();
  // Still shown here, once: the remote copy.
  expect(onMap(inside.id)).toBe(1);
  expect(loot.pickup(dropper(10, 10), inside.id).success).toBe(false);
  expect(calls).toEqual([`handOver loot ${inside.id} t`, `adoptMirror loot ${inside.id} t`]);
  expect(shown).toEqual([]);
});

test("when the new owner's mirror cannot be held, the copy is removed and its viewers told", async () => {
  const { part, shown } = setup(false);
  const l = dropLoot(10, 10);
  await part.collect(move);
  // Guard: dropShown when adoptMirror fails. Without it the copy stays shown here with nothing to despawn it.
  expect(onMap(l.id)).toBe(0);
  expect(shown).toEqual([`hide loot ${l.id}`]);
});

test("accepted loot is this node's own; a mirror already shown is not shown again, one never seen is", async () => {
  const { part, calls, shown } = setup();
  const l = dropLoot(10, 10);
  const data = await part.collect(move);
  const fresh: LootItem = { ...l, id: "loot_990001", item: "Fang" };
  made.loot.push(fresh.id);
  calls.length = 0;
  await part.accept(move, roundTrip({ ...data, loot: [...data.loot, fresh] }), "f");
  expect(loot.get(l.id)).toBeDefined();
  expect(loot.get(fresh.id)).toBeDefined();
  expect(onMap(l.id)).toBe(1);
  // Guard: only an object that was not a mirror here is shown. Without it the client gets a second spawn of l.
  expect(shown).toEqual([`show loot ${fresh.id}`]);
  expect(calls).toEqual([`dropMirror loot ${l.id}`, `dropMirror loot ${fresh.id}`]);
  expect(loot.pickup(dropper(10, 10), l.id).success).toBe(true);
});

test("loot this node already owns is not taken twice", async () => {
  const { part, calls } = setup();
  const l = dropLoot(10, 10);
  await part.accept(move, roundTrip({ loot: [{ ...l, quantity: 99 }], chests: [], skeletons: [], tornadoes: [] }), "f");
  // Guard: adoptOwn refuses an id this node owns. Without it the record is replaced and its first timer left running.
  expect(loot.get(l.id)?.quantity).toBe(2);
  expect(calls).toEqual([]);
  expect(warnings.some((w) => w.includes(l.id) && w.includes("already this node's own"))).toBe(true);
});

test("a chest moves with each player's roll and what they took of it", async () => {
  const { part } = setup();
  const id = lootChest.spawn(`${MAP}.json`, 100, 100, undefined, [always("Gem", 1), always("Opal", 1)]);
  made.chests.push(id);
  const opened = await lootChest.open(id, "p1");
  const gem = opened!.items.find((i: any) => i.itemName === "Gem");
  expect(await lootChest.takeItems(id, "p1", "alice", [gem.index], false)).not.toBeNull();
  const data = await part.collect(move);
  expect(data.chests.map((c) => c.id)).toEqual([id]);
  expect(lootChest.getChest(id)).toBeUndefined();
  expect(await lootChest.open(id, "p1")).toBeNull();
  await part.accept(move, roundTrip(data), "f");
  // Guard: the taken indices travel with the chest. Without them alice takes the gem a second time.
  const rest = await lootChest.takeAllItems(id, "p1", "alice", false);
  expect(rest!.taken.map((i: any) => i.itemName)).toEqual(["Opal"]);
  expect((await lootChest.open(id, "p2"))!.firstOpen).toBe(true);
});

test("a take under way when its chest moves away travels as taken; a failed write then loses it, logged by name", async () => {
  const { default: inventory } = await import("../systems/inventory");
  const errors: string[] = [];
  const errorSpy = spyOn(log, "error").mockImplementation((message: string) => { errors.push(String(message)); });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const addSpy = spyOn(inventory, "add").mockImplementation(async () => { await gate; throw new Error("write failed"); });
  try {
    const { part } = setup();
    const id = lootChest.spawn(`${MAP}.json`, 100, 100, undefined, [always("Gem", 1), always("Opal", 1)]);
    made.chests.push(id);
    const opened = await lootChest.open(id, "p1");
    const gem = opened!.items.find((i: any) => i.itemName === "Gem");
    const taking = lootChest.takeItems(id, "p1", "alice", [gem.index]);
    const data = await part.collect(move);
    release();
    expect(await taking).toBeNull();
    // Guard: the loss is logged with the item's name (movedAway in lootChest.ts).
    expect(errors.some((e) => e.includes(id) && e.includes("alice") && e.includes("lost Gem x1"))).toBe(true);
    await part.accept(move, roundTrip(data), "f");
    // At most once: the gem left marked taken, so it is not given again on the new owner.
    addSpy.mockRestore();
    const rest = await lootChest.takeAllItems(id, "p1", "alice", false);
    expect(rest!.taken.map((i: any) => i.itemName)).toEqual(["Opal"]);
  } finally {
    addSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("a failed write on a chest that stayed puts the items back and logs no loss", async () => {
  const { default: inventory } = await import("../systems/inventory");
  const errors: string[] = [];
  const errorSpy = spyOn(log, "error").mockImplementation((message: string) => { errors.push(String(message)); });
  const addSpy = spyOn(inventory, "add").mockImplementation(async () => { throw new Error("write failed"); });
  try {
    const id = lootChest.spawn(`${MAP}.json`, 100, 100, undefined, [always("Gem", 1)]);
    made.chests.push(id);
    await lootChest.open(id, "p1");
    expect(await lootChest.takeAllItems(id, "p1", "alice")).toBeNull();
    expect(errors.some((e) => e.includes("lost"))).toBe(false);
    expect((await lootChest.open(id, "p1"))!.items.map((i: any) => i.itemName)).toEqual(["Gem"]);
  } finally {
    addSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("a take under way when its chest moves away and back: a failed write keeps the items taken here, logged as lost", async () => {
  const { default: inventory } = await import("../systems/inventory");
  const errors: string[] = [];
  const errorSpy = spyOn(log, "error").mockImplementation((message: string) => { errors.push(String(message)); });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const addSpy = spyOn(inventory, "add").mockImplementation(async () => { await gate; throw new Error("write failed"); });
  try {
    const { part } = setup();
    const id = lootChest.spawn(`${MAP}.json`, 100, 100, undefined, [always("Gem", 1), always("Opal", 1)]);
    made.chests.push(id);
    const gem = (await lootChest.open(id, "p1"))!.items.find((i: any) => i.itemName === "Gem");
    const taking = lootChest.takeItems(id, "p1", "alice", [gem.index]);
    const data = await part.collect(move);
    await part.restore(move, data);
    release();
    expect(await taking).toBeNull();
    // Guard: the copy here keeps the gem taken (lootChest.ts give). A failure may be a write that landed.
    expect((await lootChest.open(id, "p1"))!.items.map((i: any) => i.itemName)).toEqual(["Opal"]);
    expect(errors.some((e) => e.includes(id) && e.includes("alice") && e.includes("lost Gem x1"))).toBe(true);
  } finally {
    addSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("a take whose write lands but reports failure, on a chest moved away and back, gives the item only once", async () => {
  const { default: inventory } = await import("../systems/inventory");
  const errorSpy = spyOn(log, "error").mockImplementation(() => {});
  const granted: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // The first write lands (recorded as granted), then its answer fails: a timeout, or a kept step failing after commit.
  const addSpy = spyOn(inventory, "add").mockImplementation(async (_name: string, item: any) => {
    granted.push(item.name);
    await gate;
    throw new Error("answer lost");
  });
  try {
    const { part } = setup();
    const id = lootChest.spawn(`${MAP}.json`, 100, 100, undefined, [always("Gem", 1), always("Opal", 1)]);
    made.chests.push(id);
    const gem = (await lootChest.open(id, "p1"))!.items.find((i: any) => i.itemName === "Gem");
    const taking = lootChest.takeItems(id, "p1", "alice", [gem.index]);
    const data = await part.collect(move);
    await part.restore(move, data);
    release();
    expect(await taking).toBeNull();
    // Every later take writes what it is given.
    addSpy.mockImplementation(async (_name: string, item: any) => { granted.push(item.name); });
    await lootChest.takeAllItems(id, "p1", "alice");
    // Guard: at most once. Unmarked after the failure, the gem would be granted a second time here.
    expect(granted.filter((name) => name === "Gem")).toEqual(["Gem"]);
    expect(granted).toEqual(["Gem", "Opal"]);
  } finally {
    addSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("collect names every object it takes under the move's id: loot by item, chests by their untaken rolls", async () => {
  const infos: string[] = [];
  const infoSpy = spyOn(log, "info").mockImplementation((message: string) => { infos.push(String(message)); });
  try {
    const { part } = setup();
    const sword = dropLoot(10, 10, "Sword");
    const id = lootChest.spawn(`${MAP}.json`, 100, 100, undefined, [always("Gem", 1), always("Opal", 3)]);
    made.chests.push(id);
    const gem = (await lootChest.open(id, "p1"))!.items.find((i: any) => i.itemName === "Gem");
    await lootChest.takeItems(id, "p1", "alice", [gem.index], false);
    const s = skeletons.spawn(MAP, 30, 30, "alice")!;
    made.skeletons.push(s.id);
    infos.length = 0;
    await part.collect(move);
    // Guard: a move lost later on any path leaves what it carried named in the log.
    const line = infos.find((i) => i.includes(`Block move ${move.id}`));
    expect(line).toBeDefined();
    expect(line).toContain(`${sword.id} (Sword x2)`);
    expect(line).toContain(`${id} (p1: Opal x3)`);
    expect(line).not.toContain("Gem");
    expect(line).toContain(s.id);
  } finally {
    infoSpy.mockRestore();
  }
});

test("a mirror that throws: the object still leaves in the answer, and its copy here is removed", async () => {
  const errors: string[] = [];
  const errorSpy = spyOn(log, "error").mockImplementation((message: string) => { errors.push(String(message)); });
  try {
    const shown: string[] = [];
    const part = objectMovesPart({
      now: () => Date.now(),
      ghosts: { handOver: () => {}, adoptMirror: () => { throw new Error("mirror broke"); }, dropMirror: () => {} },
      views: { showLoot: () => {}, hideLoot: (l) => shown.push(`hide loot ${l.id}`), showChest: () => {}, hideChest: () => {}, showSkeleton: () => {}, hideSkeleton: () => {} },
    });
    const l = dropLoot(10, 10);
    const data = await part.collect(move);
    expect(data.loot.map((x) => x.id)).toEqual([l.id]);
    // Guard: dropShown in the collect catch. Without it the copy stays shown here with nothing to despawn it.
    expect(onMap(l.id)).toBe(0);
    expect(shown).toEqual([`hide loot ${l.id}`]);
    expect(errors.some((e) => e.includes(`${l.id} (Bone x2)`))).toBe(true);
  } finally {
    errorSpy.mockRestore();
  }
});

test("an adopt that throws is logged as lost, by item, and the rest are still taken in", async () => {
  const errors: string[] = [];
  const errorSpy = spyOn(log, "error").mockImplementation((message: string) => { errors.push(String(message)); });
  const real = loot.adoptOwn.bind(loot);
  const adoptSpy = spyOn(loot, "adoptOwn").mockImplementation((item: LootItem, now?: number) => {
    if (item.item === "Cursed") throw new Error("adopt broke");
    return real(item, now);
  });
  try {
    const { part } = setup();
    const base = { quantity: 4, quality: "common", iconUrl: "", map: `${MAP}.json`, x: 1, y: 1, ownerId: "", ownerName: "", expiresAt: Date.now() + 60_000 };
    const bad: LootItem = { ...base, id: "loot_990004", item: "Cursed" };
    const good: LootItem = { ...base, id: "loot_990005", item: "Bone" };
    made.loot.push(bad.id, good.id);
    await part.accept(move, { loot: [bad, good], chests: [], skeletons: [], tornadoes: [] }, "f");
    expect(errors.some((e) => e.includes("loot_990004 (Cursed x4)") && e.includes("lost"))).toBe(true);
    expect(loot.get(good.id)).toBeDefined();
  } finally {
    adoptSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("a move that did not happen puts every kind back as this node's own", async () => {
  const { part, calls, shown } = setup();
  tornadoes.setTornadoBridge({
    weathers: () => [], players: () => [], size: () => ({ width: 4_000, height: 4_000 }),
    walkable: () => true, move: () => {}, hurt: () => {}, show: () => {},
  });
  const twister = tornadoes.spawn(MAP, [dropper(0, 0)], "tornado", Date.now())!;
  const l = dropLoot(10, 10);
  const s = skeletons.spawn(MAP, 30, 30, "alice")!;
  made.skeletons.push(s.id);
  const chest = lootChest.spawn(`${MAP}.json`, 100, 100, undefined, [always("Gem", 1), always("Opal", 1)]);
  made.chests.push(chest);
  await lootChest.open(chest, "p1");
  const data = await part.collect(move);
  expect(data.tornadoes.map((t) => t.id)).toEqual([twister.id]);
  expect(data.skeletons.map((k) => k.id)).toEqual([s.id]);
  expect(data.chests.map((c) => c.id)).toEqual([chest]);
  expect(tornadoes.tornadoesOn(MAP)).toEqual([]);
  await part.restore(move, data);
  expect(loot.get(l.id)).toBeDefined();
  expect(onMap(l.id)).toBe(1);
  expect(skeletons.get(s.id)).toBeDefined();
  expect(lootChest.getChest(chest)).toBeDefined();
  expect(tornadoes.tornadoesOn(MAP).map((t) => t.id)).toEqual([twister.id]);
  expect(shown).toEqual([]);
  expect(calls.filter((c) => c.startsWith("dropMirror"))).toHaveLength(4);
  // An item taken from the restored chest, then the same data restored again. The part refuses only what is still
  // here; that a move restores once is the order's to keep (blockmove.ts).
  const gem = (await lootChest.open(chest, "p1"))!.items.find((i: any) => i.itemName === "Gem");
  expect(await lootChest.takeItems(chest, "p1", "alice", [gem.index], false)).not.toBeNull();
  const skeletonHere = skeletons.get(s.id);
  warnings.length = 0;
  await part.restore(move, data);
  expect(tornadoes.tornadoesOn(MAP)).toHaveLength(1);
  // Guard: the chest and skeleton adoptOwn refuse an id this node owns. Without it the chest is replaced by the
  // collect-time copy and the gem is takeable again, and the skeleton is replaced with its first timer left running.
  expect((await lootChest.open(chest, "p1"))!.items.map((i: any) => i.itemName)).toEqual(["Opal"]);
  expect(skeletons.get(s.id)).toBe(skeletonHere);
  expect(warnings.some((w) => w.includes(`Chest ${chest}`) && w.includes("already this node's own"))).toBe(true);
  expect(warnings.some((w) => w.includes(`Skeleton ${s.id}`) && w.includes("already this node's own"))).toBe(true);
});

test("a tornado taken while the tick awaits its harm is not shown again by this node as its own", async () => {
  const { part } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lists: Array<Array<{ id: string }>> = [];
  let victim: any = null;
  tornadoes.setTornadoBridge({
    weathers: () => [], players: () => (victim ? [victim] : []), size: () => ({ width: 4_000, height: 4_000 }),
    walkable: () => true, move: () => {}, hurt: () => gate, show: (_map, list) => { lists.push(list); },
  });
  const twister = tornadoes.spawn(MAP, [dropper(0, 0)], "tornado", Date.now())!;
  victim = { id: "v1", location: { map: `${MAP}.json`, position: { x: twister.x, y: twister.y } }, stats: { max_health: 100 } };
  const ticking = tornadoes.tick(Date.now());
  // The tick is held in its harm now; the block moves away meanwhile.
  await Bun.sleep(0);
  const data = await part.collect(move);
  expect(data.tornadoes.map((t) => t.id)).toEqual([twister.id]);
  release();
  await ticking;
  // Guard: the tick reads the map's own list, not a copy (tornadoes.ts). Without it the list holds the tornado twice:
  // once as this node's own and once as the new owner's mirror.
  expect(lists.at(-1)!.map((t) => t.id)).toEqual([twister.id]);
});

test("a moved skeleton keeps only the time it had left", async () => {
  const { part } = setup();
  const s = skeletons.spawn(MAP, 30, 30, "alice")!;
  made.skeletons.push(s.id);
  const data = await part.collect(move);
  data.skeletons[0]!.expiresAt = Date.now() + 20;
  await part.accept(move, roundTrip(data), "f");
  expect(skeletons.get(s.id)).toBeDefined();
  await Bun.sleep(60);
  // Guard: adoptOwn starts the despawn timer from expiresAt. Without it the marker never goes.
  expect(skeletons.get(s.id)).toBeUndefined();
});

test("accept drops malformed objects and takes the rest", async () => {
  const { part } = setup();
  const good: LootItem = { id: "loot_990002", item: "Bone", quantity: 1, quality: "common", iconUrl: "", map: `${MAP}.json`, x: 1, y: 1, ownerId: "", ownerName: "", expiresAt: Date.now() + 60_000 };
  made.loot.push(good.id);
  await part.accept(move, { loot: [good, { id: "loot_990003", x: "1" }, null], chests: "junk", skeletons: [], tornadoes: [{ id: "t1" }] } as any, "f");
  expect(loot.get(good.id)).toBeDefined();
  expect(loot.get("loot_990003")).toBeUndefined();
  expect(warnings.some((w) => w.includes("2 malformed loot"))).toBe(true);
  expect(warnings.some((w) => w.includes("chests") && w.includes("malformed"))).toBe(true);
  expect(warnings.some((w) => w.includes("1 malformed tornado"))).toBe(true);
  await part.accept(move, "junk" as unknown as MovedObjects, "f");
  expect(warnings.some((w) => w.includes("none were taken"))).toBe(true);
});
