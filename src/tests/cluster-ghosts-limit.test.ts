import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Ghosts, type GhostKind } from "../cluster/ghosts";
import { GHOST_MOVES_PER_DATAGRAM, decodeGhostMoves } from "../cluster/linkproto";
import { BorderBand, MIRROR_KEEP_PX, MIRROR_RADIUS_PX, TargetCache, mirrorTargets, type Owners } from "../cluster/strip";
import { BLOCK_SIZE_PX } from "../cluster/blocks";
import { databaseModule, mockQuery } from "./setup";
import log from "../modules/logger";
import { linkMesh, linkPair } from "./cluster-fakelink";

// The limit fix wave, fixes 1 and 2: the scan compares state without turning all of it into JSON, spreads the
// comparison over several scans (never the release), and asks for targets through a cache that drops with the
// block table; flushTick keeps its order in a list. One owner "a" with the real mirrorTargets and band, and
// MeshLink peers that record what they are sent.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const own = (nodeId: string) => ({ nodeId, epoch: 1, since: 0 });
const B = BLOCK_SIZE_PX;
const table = (cells: Record<string, string>): Owners => Object.fromEntries(Object.entries(cells).map(([key, nodeId]) => [key, own(nodeId)]));
const row = (...nodes: string[]): Owners => table(Object.fromEntries(nodes.map((nodeId, bx) => [`${bx},0`, nodeId])));

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

type Row = Record<string, unknown>;

/** Owner "a" tracking `world` for peers b and c (a MeshLink each way), with state() read from `states`. */
function setup(timing: ConstructorParameters<typeof Ghosts>[0] = {}, initial: Owners = row("a", "b", "c")) {
  const tables: Record<string, Owners> = { main: initial };
  const ownersOf = (map: string): Owners => tables[map] ?? {};
  const cache = new TargetCache(ownersOf, "a");
  const band = new BorderBand(ownersOf, "a", () => Object.keys(tables));
  const mesh = linkMesh(["a", "b", "c"]);
  const owner = new Ghosts({ scanMs: 1_000_000, ...timing });
  const world = new Map<number, { id: number; map: string; x: number; y: number }>();
  const states = new Map<number, Row>();
  const calls = { state: 0, motion: 0 };
  const kind: GhostKind = {
    name: "loot",
    *candidates() { for (const e of world.values()) yield { id: e.id, num: e.id, map: e.map, layerId: null, x: e.x, y: e.y }; },
    snapshot: (id) => ({ ...world.get(Number(id)), ...states.get(Number(id)) }),
    state: (id) => { calls.state++; const s = states.get(Number(id)); return s ? { ...s } : null; },
    motion: (id) => { calls.motion++; const e = world.get(Number(id)); return e ? { x: e.x, y: e.y, dir: 1, flags: 0 } : null; },
    spawn: () => {},
    despawn: () => {},
  };
  owner.register(kind);
  owner.attach(mesh.a, (map, x, y, previous) => cache.targets(map, x, y, previous), band);
  const sent = () => mesh.a.sent;
  const add = (id: number, x: number, state: Row = { hp: 10 }) => {
    world.set(id, { id, map: "main", x, y: 100 });
    states.set(id, state);
  };
  return { owner, world, states, calls, mesh, sent, add, tables, cache, band };
}

// Block 1 is b's, between a's block 0 and c's block 2: x = B + 100 is inside b's block, 1250 px from nothing else.
const IN_B = B + 100;

// ---- fix 1(a): compare without a full JSON

test("an entity whose state did not change sends nothing, and a primitive field makes no JSON", () => {
  const t = setup();
  t.add(1, IN_B, { hp: 10, name: "wolf", stats: { str: 5 } });
  t.owner.scan();
  expect(t.sent().map((m) => m.kind)).toEqual(["GHOST_SPAWN"]);
  t.sent().length = 0;
  const stringify = spyOn(JSON, "stringify");
  spies.push(stringify);
  t.owner.scan();
  t.owner.scan();
  // Nothing sent. Only the object field went through JSON: hp and name were equal to what was sent.
  expect(t.sent()).toEqual([]);
  expect(stringify.mock.calls.length).toBe(2);
});

test("a change in one field sends the update the full compare sent: only that field, to every holder", () => {
  const t = setup();
  t.add(1, IN_B, { hp: 10, name: "wolf", stats: { str: 5 } });
  t.owner.scan();
  t.sent().length = 0;
  t.states.set(1, { hp: 7, name: "wolf", stats: { str: 5 } });
  t.owner.scan();
  expect(t.sent()).toEqual([{ peer: "b", kind: "GHOST_STATE", data: { kind: "loot", id: 1, num: 1, changes: { hp: 7 } } }]);
  t.sent().length = 0;
  // An object field that changes inside is sent whole; one rebuilt equal is not sent.
  t.states.set(1, { hp: 7, name: "wolf", stats: { str: 6 } });
  t.owner.scan();
  expect(t.sent()).toEqual([{ peer: "b", kind: "GHOST_STATE", data: { kind: "loot", id: 1, num: 1, changes: { stats: { str: 6 } } } }]);
  t.sent().length = 0;
  t.states.set(1, { hp: 7, name: "wolf", stats: { str: 6 } });
  t.owner.scan();
  expect(t.sent()).toEqual([]);
});

test("changes keep their order: changed and new fields in the kind's order, then dropped fields as null", () => {
  const t = setup();
  t.add(1, IN_B, { a: 1, b: 2, c: 3, d: 4 });
  t.owner.scan();
  t.sent().length = 0;
  t.states.set(1, { a: 1, b: 9, e: 5, d: undefined as unknown as number });
  t.owner.scan();
  const [message] = t.sent();
  // b changed, e is new, d went undefined (null on the wire), c was dropped.
  expect(Object.entries((message!.data as any).changes)).toEqual([["b", 9], ["e", 5], ["d", null], ["c", null]]);
  t.sent().length = 0;
  // The base is now {a, b, e, d: null}: the same again sends nothing, and a dropped field that returns is new.
  t.states.set(1, { a: 1, b: 9, e: 5, d: undefined as unknown as number });
  t.owner.scan();
  expect(t.sent()).toEqual([]);
  t.states.set(1, { a: 1, b: 9, e: 5, d: undefined as unknown as number, c: 3 });
  t.owner.scan();
  expect((t.sent()[0]!.data as any).changes).toEqual({ c: 3 });
});

test("a field that goes from a primitive to an object and back is sent each time", () => {
  const t = setup();
  t.add(1, IN_B, { f: 5 });
  t.owner.scan();
  t.sent().length = 0;
  t.states.set(1, { f: {} as unknown as number });
  t.owner.scan();
  expect((t.sent()[0]!.data as any).changes).toEqual({ f: {} });
  t.sent().length = 0;
  t.states.set(1, { f: 5 });
  t.owner.scan();
  // The old primitive 5 must not stand in for the value last sent, which was {}.
  expect((t.sent()[0]!.data as any).changes).toEqual({ f: 5 });
});

test("a field that cannot be turned into JSON loses no change: nothing is recorded, and the next scan sends it", () => {
  const t = setup();
  t.add(1, IN_B, { hp: 10, extra: { v: 1 } });
  t.owner.scan();
  t.sent().length = 0;
  const cyclic: any = {};
  cyclic.self = cyclic;
  // hp changed, then a later field throws: hp's change must not be taken as sent.
  t.states.set(1, { hp: 7, extra: cyclic });
  const errors = spyOn(log, "error").mockImplementation(() => {});
  spies.push(errors);
  t.owner.scan();
  expect(t.sent()).toEqual([]);
  t.states.set(1, { hp: 7, extra: { v: 1 } });
  t.owner.scan();
  expect((t.sent()[0]!.data as any).changes).toEqual({ hp: 7 });
});

// ---- fix 1(c): spread over scans; the release is every scan

test("with the scan spread, a state change goes out within the slices, once, and never twice", () => {
  const t = setup({ spreadAbove: 0, stateSlices: 5 });
  for (let id = 1; id <= 20; id++) t.add(id, IN_B, { hp: 10 });
  t.owner.scan();
  t.sent().length = 0;
  for (let id = 1; id <= 20; id++) t.states.set(id, { hp: 3 });
  const seenAt = new Map<number, number>();
  for (let scan = 1; scan <= 5; scan++) {
    t.owner.scan();
    for (const m of t.sent().splice(0)) {
      const id = (m.data as any).id;
      expect(seenAt.has(id)).toBe(false);
      seenAt.set(id, scan);
    }
    // A fifth of them per scan, not all in one.
    expect(seenAt.size).toBeLessThanOrEqual(4 * scan + 4);
  }
  expect(seenAt.size).toBe(20);
  t.owner.scan();
  expect(t.sent()).toEqual([]);
});

test("with the scan spread, a kind with few entities is compared every scan", () => {
  const t = setup({ spreadAbove: 50, stateSlices: 5 });
  for (let id = 1; id <= 20; id++) t.add(id, IN_B, { hp: 10 });
  t.owner.scan();
  t.sent().length = 0;
  for (let id = 1; id <= 20; id++) t.states.set(id, { hp: 3 });
  t.owner.scan();
  expect(t.sent().length).toBe(20);
});

test("with the scan spread, an entity that is gone has its mirror released on the very next scan", () => {
  const t = setup({ spreadAbove: 0, stateSlices: 5 });
  for (let id = 1; id <= 20; id++) t.add(id, IN_B);
  t.owner.scan();
  t.sent().length = 0;
  for (let id = 1; id <= 20; id++) t.world.delete(id);
  t.owner.scan();
  const released = t.sent().filter((m) => m.kind === "GHOST_DESPAWN");
  expect(released.map((m) => (m.data as any).id).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
});

test("with the scan spread, an entity that leaves the band, or loses its target, is released on the very next scan", () => {
  const t = setup({ spreadAbove: 0, stateSlices: 5 });
  for (let id = 1; id <= 20; id++) t.add(id, IN_B);
  t.owner.scan();
  t.sent().length = 0;
  // 1-10 go to where no block of another node is near: out of the band, so they are not visited at all.
  for (let id = 1; id <= 10; id++) t.world.get(id)!.x = -3 * B;
  // 11-20 stay in the band but out of reach of b (1250 + 64 px from its block, and past it).
  for (let id = 11; id <= 20; id++) t.world.get(id)!.x = B - MIRROR_KEEP_PX - 10;
  t.owner.scan();
  const released = t.sent().filter((m) => m.kind === "GHOST_DESPAWN");
  expect(released.length).toBe(20);
  const reason = (id: number) => (released.find((m) => (m.data as any).id === id)!.data as any).reason;
  for (let id = 1; id <= 10; id++) expect(reason(id)).toBe("gone");
  for (let id = 11; id <= 20; id++) expect(reason(id)).toBe("left");
});

test("with the scan spread, a new peer is sent the snapshot at once, and the state it holds is the base", () => {
  const t = setup({ spreadAbove: 0, stateSlices: 5 });
  for (let id = 1; id <= 10; id++) t.add(id, IN_B, { hp: 10 });
  t.owner.scan();
  t.sent().length = 0;
  // Entity 3 walks into c's reach too (still inside b's block row), with a changed state, in whatever slice it is.
  t.world.get(3)!.x = 2 * B - 100;
  t.states.set(3, { hp: 4 });
  for (let scan = 0; scan < 5; scan++) {
    t.owner.scan();
    if (t.sent().some((m) => m.kind === "GHOST_SPAWN")) break;
  }
  const spawn = t.sent().find((m) => m.kind === "GHOST_SPAWN" && m.peer === "c")!;
  expect(spawn).toBeDefined();
  expect((spawn.data as any).record.hp).toBe(4);
  // The holder b hears the change in the same scan the snapshot goes (what b holds is what c was sent), and nothing twice.
  expect(t.sent().filter((m) => m.kind === "GHOST_STATE" && m.peer === "b").length).toBe(1);
  t.sent().length = 0;
  for (let scan = 0; scan < 5; scan++) t.owner.scan();
  expect(t.sent().filter((m) => m.kind === "GHOST_STATE")).toEqual([]);
});

// ---- fix 1(b): the target cache

test("the target cache gives what mirrorTargets gives, over a sweep of positions and holders", () => {
  const owners = table({ "0,0": "a", "1,0": "b", "2,0": "c", "0,1": "a", "1,1": "a", "2,1": "b", "3,3": "c" });
  const cache = new TargetCache(() => owners, "a");
  const previous = [new Set<string>(), new Set(["b"]), new Set(["c"]), new Set(["b", "c"])];
  for (let x = -300; x < 4 * B; x += 37) {
    for (let y = -300; y < 3 * B; y += 311) {
      for (const held of previous) {
        const want = [...mirrorTargets(owners, x, y, "a", held)].sort();
        expect([...cache.targets("main", x, y, held)].sort()).toEqual(want);
      }
    }
  }
});

test("the target cache answers by the position, not by the centre of its 64 px square, on the radius", () => {
  const owners = row("a", "b");
  const cache = new TargetCache(() => owners, "a");
  // b's block starts at x = B. Walk across the radius and the keep radius pixel by pixel.
  for (let x = B - MIRROR_KEEP_PX - 70; x < B - MIRROR_RADIUS_PX + 70; x++) {
    for (const held of [new Set<string>(), new Set(["b"])]) {
      expect([...cache.targets("main", x, 50, held)]).toEqual([...mirrorTargets(owners, x, 50, "a", held)]);
    }
  }
});

test("the target cache is dropped with the block table: a block that changed owner has the new target, and not the old", () => {
  let owners: Owners = row("a", "b");
  const cache = new TargetCache(() => owners, "a");
  const near = new Set<string>();
  expect([...cache.targets("main", B - 500, 100, near)]).toEqual(["b"]);
  // The same square again is answered from the cache.
  expect([...cache.targets("main", B - 499, 100, near)]).toEqual(["b"]);
  // The block changes owner (a new table object, as BlockTable.keep makes): the cached "b" must go.
  owners = row("a", "c");
  expect([...cache.targets("main", B - 500, 100, near)]).toEqual(["c"]);
  // And away from this node altogether.
  owners = row("a", "a");
  expect([...cache.targets("main", B - 500, 100, near)]).toEqual([]);
});

test("a block that changed owner: the old holder is released and the new one gets the spawn, in the next scan", () => {
  const t = setup({}, row("a", "b"));
  t.add(1, B - 500);
  t.owner.scan();
  expect(t.sent().map((m) => `${m.peer} ${m.kind}`)).toEqual(["b GHOST_SPAWN"]);
  t.sent().length = 0;
  t.tables.main = row("a", "c");
  t.owner.scan();
  expect(t.sent().map((m) => `${m.peer} ${m.kind}`)).toEqual(["b GHOST_DESPAWN", "c GHOST_SPAWN"]);
});

test("the target cache keeps one table per map, and a map it does not know has no targets", () => {
  const tables: Record<string, Owners> = { main: row("a", "b"), side: row("a", "c") };
  const cache = new TargetCache((map) => tables[map] ?? {}, "a");
  const none = new Set<string>();
  expect([...cache.targets("main", B - 100, 10, none)]).toEqual(["b"]);
  expect([...cache.targets("side", B - 100, 10, none)]).toEqual(["c"]);
  expect([...cache.targets("nowhere", B - 100, 10, none)]).toEqual([]);
  expect([...cache.targets("main", Number.NaN, 10, none)]).toEqual([]);
  tables.side = row("a", "d");
  expect([...cache.targets("side", B - 100, 10, none)]).toEqual(["d"]);
  expect([...cache.targets("main", B - 100, 10, none)]).toEqual(["b"]);
});

// ---- fix 2: flushTick's order is a list

function flushSetup(timing: ConstructorParameters<typeof Ghosts>[0] = {}) {
  const { a } = linkPair();
  const owner = new Ghosts({ scanMs: 1_000_000, ...timing });
  const world = new Map<number, { id: number; x: number }>();
  const calls = { motion: 0 };
  owner.register({
    name: "loot",
    *candidates() { for (const e of world.values()) yield { id: e.id, num: e.id, map: "main", layerId: null, x: e.x, y: 0 }; },
    snapshot: (id) => ({ ...world.get(Number(id)) }),
    motion: (id) => { calls.motion++; const e = world.get(Number(id)); return e ? { x: e.x, y: 0, dir: 1, flags: 0 } : null; },
    spawn: () => {},
    despawn: () => {},
  });
  owner.attach(a, (_map, x, _y, previous) => new Set(x >= (previous.has("b") ? 2936 : 3000) ? ["b"] : []));
  const moves = () => a.datagrams.splice(0).flatMap((d) => decodeGhostMoves(d)).map((m) => m.num);
  return { a, owner, world, calls, moves };
}

test("a moved tracked entity's motion goes out on the same tick, and an unmoved one's does not", () => {
  const t = flushSetup();
  for (let id = 1; id <= 5; id++) t.world.set(id, { id, x: 3000 + id });
  t.owner.scan();
  t.owner.flushTick();
  expect(t.moves().sort()).toEqual([1, 2, 3, 4, 5]);
  t.owner.flushTick();
  expect(t.moves()).toEqual([]);
  t.world.get(2)!.x += 5;
  t.world.get(4)!.x += 5;
  t.owner.flushTick();
  expect(t.moves().sort()).toEqual([2, 4]);
});

test("flushTick sends the least recently sent first: entities left over by the budget lead the next tick", () => {
  // One datagram a tick: GHOST_MOVES_PER_DATAGRAM entries at a time, three ticks to send them all.
  const t = flushSetup({ datagramsPerTick: 1 });
  const count = GHOST_MOVES_PER_DATAGRAM * 3;
  for (let id = 1; id <= count; id++) t.world.set(id, { id, x: 3000 + id });
  t.owner.scan();
  const order: number[] = [];
  for (let tick = 0; tick < 40 && new Set(order).size < count; tick++) {
    for (const e of t.world.values()) e.x += 1;
    t.owner.flushTick();
    order.push(...t.moves());
  }
  // Everyone was sent, each round in the same order as the one before: a rotation, not a restart at the front.
  expect(new Set(order).size).toBe(count);
  expect(order.slice(0, count)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
});

test("the list stays whole when entities leave from the middle, from the ends, and when a peer goes", () => {
  const t = flushSetup();
  for (let id = 1; id <= 8; id++) t.world.set(id, { id, x: 3000 + id });
  t.owner.scan();
  t.owner.flushTick();
  t.moves();
  // Gone from the middle, the front and the back; one more arrives.
  for (const id of [1, 4, 8]) t.world.delete(id);
  t.world.set(9, { id: 9, x: 3009 });
  t.owner.scan();
  for (const e of t.world.values()) e.x += 1;
  t.owner.flushTick();
  expect(t.moves().sort((p, q) => p - q)).toEqual([2, 3, 5, 6, 7, 9]);
  // The peer goes down: everything is untracked in one pass over the list, and a tick sends nothing.
  t.a.setUp(false);
  for (const e of t.world.values()) e.x += 1;
  t.owner.flushTick();
  expect(t.a.datagrams).toEqual([]);
  t.a.setUp(true);
  t.owner.scan();
  for (const e of t.world.values()) e.x += 1;
  t.owner.flushTick();
  expect(t.moves().sort((p, q) => p - q)).toEqual([2, 3, 5, 6, 7, 9]);
});
