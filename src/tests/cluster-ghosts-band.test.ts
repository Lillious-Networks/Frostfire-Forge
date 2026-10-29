import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Ghosts, type GhostKind } from "../cluster/ghosts";
import { BorderBand, MIRROR_KEEP_PX, mirrorTargets, nodesWithin, type Owners } from "../cluster/strip";
import { BLOCK_SIZE_PX } from "../cluster/blocks";
import { databaseModule, mockQuery } from "./setup";
import { linkPair, settle } from "./cluster-fakelink";

// The border band (fix 1 of the ghost wave): the scan visits only entities within MIRROR_KEEP_PX of a block
// another node owns, and a mirror is released the moment its entity is no longer visited. Two Ghosts joined by a
// fake link pair, the real mirrorTargets, and a block table the test replaces the way BlockTable does (a new
// owners object per change).
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const own = (nodeId: string) => ({ nodeId, epoch: 1, since: 0 });
const B = BLOCK_SIZE_PX;

const table = (cells: Record<string, string>): Owners => Object.fromEntries(Object.entries(cells).map(([key, nodeId]) => [key, own(nodeId)]));
/** One row of blocks, block 0 first: row("a", "b", "a", "a") has b's block between a's. */
const row = (...nodes: string[]): Owners => table(Object.fromEntries(nodes.map((nodeId, bx) => [`${bx},0`, nodeId])));

function setup(initial: Record<string, Owners>) {
  const tables = { ...initial };
  const ownersOf = (map: string): Owners => tables[map] ?? {};
  const band = new BorderBand(ownersOf, "a", () => Object.keys(tables));
  const { a, b } = linkPair();
  const owner = new Ghosts({ scanMs: 1_000_000 });
  const mirror = new Ghosts({ scanMs: 1_000_000 });
  const world = new Map<number, any>();
  const seen: string[] = [];
  const counts = { candidates: 0, targets: 0, targetAt: [] as number[] };
  const kind: GhostKind = {
    name: "loot",
    *candidates() {
      counts.candidates++;
      for (const e of world.values()) yield { id: e.id, num: e.id, map: e.map, layerId: null, x: e.x, y: e.y };
    },
    snapshot: (id) => ({ ...world.get(Number(id)) }),
    spawn: () => {},
    despawn: () => {},
  };
  owner.register(kind);
  mirror.register({ ...kind, candidates: () => [], spawn: (record) => { seen.push(`spawn ${record.id}`); }, despawn: (id, reason) => { seen.push(`despawn ${id} ${reason}`); } });
  owner.attach(a, (map, x, y, previous) => {
    counts.targets++;
    counts.targetAt.push(x);
    return mirrorTargets(ownersOf(map), x, y, "a", previous);
  }, band);
  mirror.attach(b, () => new Set());
  return { owner, mirror, world, seen, counts, tables, band };
}

const loot = (id: number, x: number, map = "main") => ({ id, map, x, y: 100 });

test("an entity far from every block of another node is not visited and gets no mirror", async () => {
  // Block 3 is two blocks from b's block 1: nothing there can be mirrored.
  const { owner, mirror, world, counts, seen } = setup({ main: row("a", "b", "a", "a") });
  world.set(1, loot(1, 3 * B + 100));
  owner.scan();
  await settle();
  expect(counts.targets).toBe(0);
  expect(mirror.mirrorCount()).toBe(0);
  expect(seen).toEqual([]);
  // An entity in the band is visited (too far from b to be mirrored, but the targets were asked).
  world.set(2, loot(2, 100));
  owner.scan();
  expect(counts.targetAt).toEqual([100]);
});

test("an entity that walks into the band gets a mirror; one that walks out has it released", async () => {
  const { owner, mirror, world, counts, seen } = setup({ main: row("a", "b", "a", "a") });
  const e = loot(1, 3 * B + 100);
  world.set(1, e);
  owner.scan();
  expect(counts.targets).toBe(0);

  // Into block 2, 100 px from b's block: mirrored.
  e.x = 2 * B + 100;
  owner.scan();
  await settle();
  expect(seen).toEqual(["spawn 1"]);
  expect(mirror.mirrorCount()).toBe(1);

  // Out to block 3: no longer visited, and the scan releases what it mirrored.
  e.x = 3 * B + 100;
  const asked = counts.targets;
  owner.scan();
  await settle();
  expect(counts.targets).toBe(asked);
  expect(seen).toEqual(["spawn 1", "despawn 1 gone"]);
  expect(mirror.mirrorCount()).toBe(0);

  // And back in: mirrored again, from scratch.
  e.x = 2 * B + 100;
  owner.scan();
  await settle();
  expect(seen.at(-1)).toBe("spawn 1");
  expect(mirror.mirrorCount()).toBe(1);
});

test("a mirror is kept to the keep distance inside the band, not flapped", async () => {
  const { owner, mirror, world, seen } = setup({ main: row("a", "b", "a", "a") });
  const e = loot(1, 2 * B + 100);
  world.set(1, e);
  owner.scan();
  await settle();
  // 1300 px from b's block is past the 1250 px that starts a mirror but inside the 1314 px that keeps one.
  e.x = 2 * B + 1300;
  owner.scan();
  await settle();
  expect(mirror.mirrorCount()).toBe(1);
  // Past the keep, in a block that is still in the band: visited, and released by the targets as before.
  e.x = 2 * B + MIRROR_KEEP_PX + 10;
  owner.scan();
  await settle();
  expect(mirror.mirrorCount()).toBe(0);
  expect(seen).toEqual(["spawn 1", "despawn 1 left"]);
});

test("a block table change that moves the band mirrors the newly near entities and releases the ones no longer near", async () => {
  const { owner, mirror, world, seen, tables } = setup({ main: row("a", "b", "a", "a") });
  // 1 is 500 px from b's block 1; 2 is 500 px from block 3, which a owns for now.
  world.set(1, loot(1, B - 500));
  world.set(2, loot(2, 3 * B - 500));
  owner.scan();
  await settle();
  expect(seen).toEqual(["spawn 1"]);

  // b gives up block 1 and takes block 3: the band moves.
  tables.main = row("a", "a", "a", "b");
  owner.scan();
  await settle();
  expect(seen.sort()).toEqual(["despawn 1 gone", "spawn 1", "spawn 2"]);
  expect(mirror.mirrorCount()).toBe(1);

  // b's blocks all go to a: nothing is near any more, and the last mirror goes.
  tables.main = row("a", "a", "a", "a");
  owner.scan();
  await settle();
  expect(seen.includes("despawn 2 gone")).toBe(true);
  expect(mirror.mirrorCount()).toBe(0);
});

test("a map whose every block is this node's has no per-entity work", () => {
  const { owner, world, counts } = setup({ main: row("a", "b", "a", "a"), side: row("a", "a", "a") });
  world.set(1, loot(1, 100, "side"));
  world.set(2, loot(2, 2 * B, "side"));
  world.set(3, loot(3, 3 * B + 100, "main"));
  owner.scan();
  expect(counts.candidates).toBe(1);
  expect(counts.targets).toBe(0);
});

test("one node with the cluster on: the scan does no per-entity work at all", () => {
  const { owner, world, counts, band } = setup({ main: row("a", "a", "a", "a"), side: row("a") });
  for (let i = 1; i <= 50; i++) world.set(i, loot(i, i * 300, i % 2 ? "main" : "side"));
  expect(band.anyBorder()).toBe(false);
  owner.scan();
  owner.scan();
  expect(counts.candidates).toBe(0);
  expect(counts.targets).toBe(0);
});

test("a node's own blocks beside unowned ones are no border", () => {
  const band = new BorderBand(() => table({ "0,0": "a", "2,0": "a" }), "a", () => ["main"]);
  expect(band.hasBorder("main")).toBe(false);
  expect(band.anyBorder()).toBe(false);
  expect(band.near("main", 100, 100)).toBe(false);
});

test("the band is the blocks next to a block of another node, and no more", () => {
  // b owns block (2,1).
  const band = new BorderBand(() => table({ "1,1": "a", "2,1": "b", "3,1": "a" }), "a", () => ["main"]);
  expect(band.hasBorder("main")).toBe(true);
  const at = (bx: number, by: number) => band.near("main", bx * B + 1, by * B + 1);
  for (let bx = 0; bx <= 4; bx++) {
    for (let by = 0; by <= 2; by++) expect(at(bx, by)).toBe(bx >= 1 && bx <= 3);
  }
  expect(band.near("main", 2 * B + 100, -50)).toBe(false);
  expect(band.near("main", Number.NaN, 100)).toBe(false);
  expect(band.near("main", Infinity, 100)).toBe(false);
  // A rectangle counts when it touches a band block, and not when it is wholly outside.
  expect(band.nearRect("main", 0, 0, 512, 512)).toBe(false);
  expect(band.nearRect("main", B - 256, B, B + 256, B + 512)).toBe(true);
  expect(band.nearRect("main", 3 * B, B, 4 * B, 2 * B)).toBe(true);
  expect(band.nearRect("main", 4 * B, B, 5 * B, 2 * B)).toBe(false);
});

test("the band never leaves out a position that has a mirror target", () => {
  const owners = table({ "0,0": "a", "1,0": "b", "0,1": "c", "1,1": "a", "2,2": "d" });
  const band = new BorderBand(() => owners, "a", () => ["main"]);
  const kept = new Set(["b", "c", "d"]);
  for (let x = -500; x < 3 * B + 500; x += 97) {
    for (let y = -500; y < 3 * B + 500; y += 101) {
      if (mirrorTargets(owners, x, y, "a", kept).size > 0) expect(band.near("main", x, y)).toBe(true);
    }
  }
});

test("a changed table is re-read at the next refresh", () => {
  let owners = row("a", "a");
  const band = new BorderBand(() => owners, "a", () => ["main"]);
  expect(band.hasBorder("main")).toBe(false);
  owners = row("a", "b");
  band.refresh();
  expect(band.hasBorder("main")).toBe(true);
  expect(band.near("main", 100, 100)).toBe(true);
});

// ------------------------------------------------------------------ the creature kind

const { creatureGhostKind } = await import("../systems/creatures");
const registry = (await import("../systems/creatures/registry")).default;
const { createCombatState } = await import("../systems/creatures/threat");
const { createAuras } = await import("../systems/creatures/auras");

const creature = (id: number, x: number, y: number, map: string) => ({
  id, templateId: 1, spawnId: 1, poolId: null, map, layerId: null, x, y, dir: "down",
  homeX: x, homeY: y, level: 10, health: 100, maxHealth: 100, state: "idle" as any, spawnedAt: 0,
  move: null, waitUntil: 0, patrolIndex: 0, patrolForward: true, sentX: x, sentY: y, sentDir: "down",
  sentMoving: false, combat: createCombatState(), auras: createAuras(), casting: null, abilityStates: new Map(), remote: false,
});

const added: number[] = [];
const addCreature = (id: number, x: number, y: number, map = "bandmain") => { registry.add(creature(id, x, y, map) as any); added.push(id); };
afterEach(() => { for (const id of added.splice(0)) registry.remove(id); });

test("the creature kind lists only the creatures in cells of the band, and skips a map with no border whole", () => {
  const band = new BorderBand((map) => (map === "bandmain" ? row("a", "b", "a", "a") : row("a", "a")), "a", () => ["bandmain", "bandside"]);
  addCreature(880001, 3 * B + 100, 100);
  addCreature(880002, 2 * B + 100, 100);
  addCreature(880003, B - 100, 100);
  addCreature(880004, 100, 100, "bandside");
  const onMap = spyOn(registry, "onMap");
  const onBandCells = spyOn(registry, "onBandCells");
  try {
    const mine = (c: { id: string | number }) => Number(c.id) >= 880000;
    const ids = [...creatureGhostKind.candidates(band)].filter(mine).map((c) => c.id).sort();
    // The creature in block 3 is out of the band; "bandside" has no block of another node and is not even opened.
    expect(ids).toEqual([880002, 880003]);
    expect(onMap).not.toHaveBeenCalled();
    expect(onBandCells.mock.calls.map((call) => call[0])).not.toContain("bandside");
    expect(onBandCells.mock.calls.map((call) => call[0])).toContain("bandmain");
    // Without a band every creature of this node is listed, as before.
    expect([...creatureGhostKind.candidates()].filter(mine).map((c) => c.id).sort()).toEqual([880001, 880002, 880003, 880004]);
  } finally {
    onMap.mockRestore();
    onBandCells.mockRestore();
  }
});

test("a creature that walks out of the band has its mirror released by the scan", async () => {
  const { a, b } = linkPair();
  const owners = row("a", "b", "a", "a");
  const ownersOf = (map: string) => (map === "bandmain" ? owners : {});
  const band = new BorderBand(ownersOf, "a", () => ["bandmain"]);
  const owner = new Ghosts({ scanMs: 1_000_000 });
  const mirror = new Ghosts({ scanMs: 1_000_000 });
  const seen: string[] = [];
  owner.register(creatureGhostKind);
  mirror.register({
    ...creatureGhostKind, candidates: () => [],
    spawn: (r) => { seen.push(`spawn ${r.id}`); },
    despawn: (id, reason) => { seen.push(`despawn ${id} ${reason}`); },
  });
  owner.attach(a, (map, x, y, previous) => mirrorTargets(ownersOf(map), x, y, "a", previous), band);
  mirror.attach(b, () => new Set());
  try {
    addCreature(880010, 2 * B + 100, 100);
    owner.scan();
    await settle();
    expect(seen).toEqual(["spawn 880010"]);
    // The registry re-buckets it as it moves, as the engine does.
    registry.move(registry.get(880010)!, 3 * B + 100, 100);
    owner.scan();
    await settle();
    expect(seen).toEqual(["spawn 880010", "despawn 880010 gone"]);
    expect(mirror.mirrorCount()).toBe(0);
  } finally {
    owner.detach();
    mirror.detach();
  }
});

// ------------------------------------------------------------------ no allocation without a peer (fix 3)

/** How many Sets `work` makes (the global is wrapped for the call: code that says `new Set` gets the count). */
function setsMadeBy(work: () => void): number {
  const Real = globalThis.Set;
  let made = 0;
  class Counting<T> extends Real<T> {
    constructor(values?: Iterable<T> | null) {
      super(values);
      made++;
    }
  }
  globalThis.Set = Counting as unknown as SetConstructor;
  try {
    work();
  } finally {
    globalThis.Set = Real;
  }
  return made;
}

test("an entity with no peer near it makes no Set and has its state left alone", () => {
  const owners = row("a", "b", "a", "a");
  const { a } = linkPair();
  const owner = new Ghosts({ scanMs: 1_000_000 });
  const calls = { state: 0, snapshot: 0 };
  const world = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, map: "main", x: 3 * B + 10 * i, y: 100 }));
  owner.register({
    name: "loot",
    *candidates() { for (const e of world) yield { id: e.id, num: e.id, map: e.map, layerId: null, x: e.x, y: e.y }; },
    snapshot: () => { calls.snapshot++; return {}; },
    state: () => { calls.state++; return { hp: 1 }; },
    spawn: () => {},
    despawn: () => {},
  });
  // No band here: every entity is visited, so what is measured is the work for one that has nobody near it.
  owner.attach(a, (map, x, y, previous) => mirrorTargets(map === "main" ? owners : {}, x, y, "a", previous));
  owner.scan();
  expect(setsMadeBy(() => owner.scan())).toBe(0);
  expect(calls).toEqual({ state: 0, snapshot: 0 });
});

test("nodesWithin and mirrorTargets share one empty set when no node is near", () => {
  const owners = row("a", "b", "a", "a");
  expect(nodesWithin(owners, 3 * B, 100, MIRROR_KEEP_PX, "a")).toBe(nodesWithin(owners, 3 * B + 500, 900, MIRROR_KEEP_PX, "a"));
  expect(mirrorTargets(owners, 3 * B, 100, "a", new Set(["b"])).size).toBe(0);
  // A kept node is added to a copy, never to the set the next call gets.
  const kept = mirrorTargets(owners, 2 * B + 1300, 100, "a", new Set(["b"]));
  expect([...kept]).toEqual(["b"]);
  expect(mirrorTargets(owners, 3 * B, 100, "a", new Set(["b"])).size).toBe(0);
});

test("a mirrored entity that walks off reads no state on the scan that releases it", async () => {
  const owners = row("a", "b", "a", "a");
  const { a, b } = linkPair();
  const owner = new Ghosts({ scanMs: 1_000_000 });
  const mirror = new Ghosts({ scanMs: 1_000_000 });
  const e = { id: 1, map: "main", x: 2 * B + 100, y: 100 };
  let reads = 0;
  owner.register({
    name: "loot",
    *candidates() { yield { id: e.id, num: e.id, map: e.map, layerId: null, x: e.x, y: e.y }; },
    snapshot: () => ({ ...e }),
    state: () => { reads++; return { hp: 1 }; },
    spawn: () => {},
    despawn: () => {},
  });
  mirror.register({ name: "loot", candidates: () => [], snapshot: () => null, spawn: () => {}, despawn: () => {} });
  owner.attach(a, (_map, x, y, previous) => mirrorTargets(owners, x, y, "a", previous));
  mirror.attach(b, () => new Set());
  owner.scan();
  await settle();
  expect(mirror.mirrorCount()).toBe(1);
  const before = reads;
  e.x = 3 * B + 100;
  owner.scan();
  await settle();
  expect(mirror.mirrorCount()).toBe(0);
  expect(reads).toBe(before);
});

// ------------------------------------------------------------------ fix round 1

test("a candidate that throws in the band check does not stop the release of a gone entity's mirror", async () => {
  const tables: Record<string, Owners> = { main: row("a", "b", "a", "a") };
  // Like BlockTable.ownersOf: a map that is no string throws.
  const ownersOf = (map: string): Owners => {
    if (typeof map !== "string") throw new TypeError("map.endsWith is not a function");
    return tables[map] ?? {};
  };
  const band = new BorderBand(ownersOf, "a", () => Object.keys(tables));
  const { a, b } = linkPair();
  const owner = new Ghosts({ scanMs: 1_000_000 });
  const mirror = new Ghosts({ scanMs: 1_000_000 });
  const world = new Map<number, any>();
  const seen: string[] = [];
  owner.register({
    name: "loot",
    *candidates() { for (const e of world.values()) yield { id: e.id, num: e.id, map: e.map, layerId: null, x: e.x, y: e.y }; },
    snapshot: (id) => ({ ...world.get(Number(id)) }),
    spawn: () => {},
    despawn: () => {},
  });
  mirror.register({ name: "loot", candidates: () => [], snapshot: () => null, spawn: (r) => { seen.push(`spawn ${r.id}`); }, despawn: (id, reason) => { seen.push(`despawn ${id} ${reason}`); } });
  owner.attach(a, (map, x, y, previous) => mirrorTargets(ownersOf(map), x, y, "a", previous), band);
  mirror.attach(b, () => new Set());

  world.set(1, loot(1, 2 * B + 100));
  owner.scan();
  await settle();
  expect(seen).toEqual(["spawn 1"]);

  // Entity 1 is gone; a candidate with no map is listed before and after another good one.
  world.delete(1);
  world.set(2, { id: 2, map: undefined, x: 100, y: 100 });
  world.set(3, loot(3, 2 * B + 200));
  owner.scan();
  await settle();
  expect(seen).toEqual(["spawn 1", "spawn 3", "despawn 1 gone"]);
  expect(mirror.mirrorCount()).toBe(1);
});

test("a band that fails to refresh falls back to looking at every entity", async () => {
  const owners = row("a", "b", "a", "a");
  const band = new BorderBand(() => owners, "a", () => ["main"]);
  band.refresh = () => { throw new Error("table unreadable"); };
  const { a, b } = linkPair();
  const owner = new Ghosts({ scanMs: 1_000_000 });
  const mirror = new Ghosts({ scanMs: 1_000_000 });
  const e = loot(1, 2 * B + 100);
  owner.register({
    name: "loot",
    *candidates() { yield { id: e.id, num: e.id, map: e.map, layerId: null, x: e.x, y: e.y }; },
    snapshot: () => ({ ...e }),
    spawn: () => {},
    despawn: () => {},
  });
  mirror.register({ name: "loot", candidates: () => [], snapshot: () => null, spawn: () => {}, despawn: () => {} });
  owner.attach(a, (_map, x, y, previous) => mirrorTargets(owners, x, y, "a", previous), band);
  mirror.attach(b, () => new Set());
  expect(() => owner.scan()).not.toThrow();
  await settle();
  expect(mirror.mirrorCount()).toBe(1);
});

test("a map the table does not know shares one empty table, so its band is not rebuilt every scan", async () => {
  const { BlockTable } = await import("../cluster/blocks");
  const { MemoryStore } = await import("../cluster/memorystore");
  const blocks = new BlockTable(new MemoryStore());
  expect(blocks.ownersOf("nowhere")).toBe(blocks.ownersOf("elsewhere.json"));
  const band = new BorderBand((map) => blocks.ownersOf(map), "a", () => blocks.maps());
  expect(band.hasBorder("nowhere")).toBe(false);
  const before = (band as any).maps.get("nowhere");
  band.refresh();
  expect((band as any).maps.get("nowhere")).toBe(before);
});
