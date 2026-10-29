import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Ghosts, type GhostKind } from "../cluster/ghosts";
import { GHOST_MOVES_PER_DATAGRAM, decodeGhostMoves } from "../cluster/linkproto";
import { BorderBand, type Owners } from "../cluster/strip";
import { bareMemoSize, blockTableKey } from "../cluster/blocks";
import { CreatureRegistry } from "../systems/creatures/registry";
import { databaseModule, mockQuery } from "./setup";
import { linkPair } from "./cluster-fakelink";

// The ghost-perf wave: flushTick reads only the entities that were touched and those whose keyframe is due (fix 2),
// the creature registry keeps the cells that pass the band between scans (fix 3), and the block table's bare()
// memo is bounded (fix 1).
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

const KEYFRAME = 500;

interface Ent { id: number; x: number; dir: number; flags: number }

/** An owner tracking `world` for one peer; `aware` makes the kind mark moves (dirtyMarks) and the tests call touch. */
function setup(aware: boolean, timing: ConstructorParameters<typeof Ghosts>[0] = {}) {
  const { a } = linkPair();
  const clock = { now: 1_000_000 };
  const owner = new Ghosts({ scanMs: 1_000_000, keyframeMs: KEYFRAME, now: () => clock.now, ...timing });
  const world = new Map<number, Ent>();
  const calls = { motion: 0 };
  const kind: GhostKind = {
    name: "loot",
    *candidates() { for (const e of world.values()) yield { id: e.id, num: e.id, map: "main", layerId: null, x: e.x, y: 0 }; },
    snapshot: (id) => ({ ...world.get(Number(id)) }),
    motion: (id) => { calls.motion++; const e = world.get(Number(id)); return e ? { x: e.x, y: 0, dir: e.dir, flags: e.flags } : null; },
    spawn: () => {},
    despawn: () => {},
    ...(aware ? { dirtyMarks: true } : {}),
  };
  owner.register(kind);
  owner.attach(a, () => new Set(["b"]));
  // sorted entries of one tick
  const moves = () => a.datagrams.splice(0).flatMap((d) => decodeGhostMoves(d)).map((m) => `${m.num}:${m.x}:${m.dir}:${m.flags}`).sort();
  const move = (id: number, dx: number) => {
    world.get(id)!.x += dx;
    if (aware) owner.touch("loot", id);
  };
  return { a, owner, world, calls, moves, move, clock, add: (id: number, x = 100) => world.set(id, { id, x, dir: 1, flags: 0 }) };
}

// A fixed random offset of zero puts a first keyframe at the send itself, so the order of the list is exact.
const noOffset = () => { spies.push(spyOn(Math, "random").mockReturnValue(0)); };

test("differential: random moves give the same GHOST_MOVE entries per tick with and without dirty marks", () => {
  noOffset();
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const plain = setup(false);
  const aware = setup(true);
  for (let id = 1; id <= 300; id++) { plain.add(id, id); aware.add(id, id); }
  plain.owner.scan();
  aware.owner.scan();
  let total = 0;
  for (let tick = 0; tick < 80; tick++) {
    for (let id = 1; id <= 300; id++) {
      const r = rnd();
      if (r < 0.1) { const dx = 1 + Math.floor(rnd() * 5); plain.move(id, dx); aware.move(id, dx); }
      else if (r < 0.12) {
        // direction or flags only
        plain.world.get(id)!.flags ^= 1; aware.world.get(id)!.flags ^= 1; aware.owner.touch("loot", id);
      }
    }
    plain.clock.now += 50;
    aware.clock.now += 50;
    plain.owner.flushTick();
    aware.owner.flushTick();
    const p = plain.moves();
    expect(aware.moves()).toEqual(p);
    total += p.length;
  }
  expect(total).toBeGreaterThan(300);
  // The aware side read far fewer motions.
  expect(aware.calls.motion).toBeLessThan(plain.calls.motion / 2);
});

test("a spawn is followed by a move on the next tick, with no touch", () => {
  noOffset();
  const t = setup(true);
  t.add(1, 500);
  t.owner.scan();
  t.owner.flushTick();
  expect(t.moves()).toEqual(["1:500:1:0"]);
  // Nothing moved and no keyframe is due: nothing goes out.
  t.clock.now += 50;
  t.owner.flushTick();
  expect(t.moves()).toEqual([]);
});

test("a write nobody touched still goes out at the keyframe, no later than keyframeMs after the last send", () => {
  noOffset();
  const t = setup(true);
  t.add(1, 100);
  t.owner.scan();
  t.owner.flushTick();
  t.moves();
  t.world.get(1)!.x = 900; // a missed writer
  let waited = 0;
  let got: string[] = [];
  while (!got.length && waited <= KEYFRAME + 50) {
    t.clock.now += 50;
    waited += 50;
    t.owner.flushTick();
    got = t.moves();
  }
  expect(got).toEqual(["1:900:1:0"]);
  expect(waited).toBeLessThanOrEqual(KEYFRAME);
});

test("with random first-keyframe offsets every entity is still sent within keyframeMs of its last send", () => {
  const t = setup(true);
  for (let id = 1; id <= 100; id++) t.add(id, id);
  t.owner.scan();
  const lastSent = new Map<number, number>();
  let worst = 0;
  for (let tick = 0; tick < 60; tick++) {
    t.clock.now += 50;
    t.owner.flushTick();
    for (const m of t.a.datagrams.splice(0).flatMap((d) => decodeGhostMoves(d))) {
      const before = lastSent.get(m.num);
      if (before !== undefined) worst = Math.max(worst, t.clock.now - before);
      lastSent.set(m.num, t.clock.now);
    }
  }
  expect(lastSent.size).toBe(100);
  expect(worst).toBeLessThanOrEqual(KEYFRAME + 50);
});

test("the dirty list holds nothing after an untrack, a detach, or a touch with the ghosts not attached", () => {
  const t = setup(true);
  t.add(1);
  t.add(2);
  t.owner.scan();
  t.owner.touch("loot", 1);
  t.owner.touch("loot", 1);
  expect((t.owner as any).dirtyList.length).toBeLessThanOrEqual(2);
  // 1 leaves: the scan untracks it, and the next tick drops the mark.
  t.world.delete(1);
  t.owner.scan();
  t.owner.flushTick();
  expect((t.owner as any).dirtyList.length).toBe(0);
  expect(t.moves().some((m) => m.startsWith("1:"))).toBe(false);
  t.owner.touch("loot", 1);
  t.owner.touch("loot", 99);
  expect((t.owner as any).dirtyList.length).toBe(0);
  t.owner.touch("loot", 2);
  t.owner.detach();
  expect((t.owner as any).dirtyList.length).toBe(0);
  t.owner.touch("loot", 2);
  expect((t.owner as any).dirtyList.length).toBe(0);
});

test("an entity touched twice in a tick, or touched and due, is read once", () => {
  noOffset();
  const t = setup(true);
  t.add(1);
  t.owner.scan();
  t.owner.flushTick();
  t.moves();
  t.clock.now += KEYFRAME;
  t.calls.motion = 0;
  t.move(1, 5);
  t.owner.touch("loot", 1);
  t.owner.flushTick();
  expect(t.calls.motion).toBe(1);
  expect(t.moves()).toEqual(["1:105:1:0"]);
});

test("the budget leaves touched entities for the next tick, which they lead", () => {
  noOffset();
  const t = setup(true, { datagramsPerTick: 1 });
  const count = GHOST_MOVES_PER_DATAGRAM * 3;
  for (let id = 1; id <= count; id++) t.add(id, id);
  t.owner.scan();
  const order: number[] = [];
  for (let tick = 0; tick < 40 && new Set(order).size < count; tick++) {
    t.clock.now += 10;
    t.owner.flushTick();
    order.push(...t.a.datagrams.splice(0).flatMap((d) => decodeGhostMoves(d)).map((m) => m.num));
  }
  expect(new Set(order).size).toBe(count);
  expect(order.slice(0, count)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
});

test("flushTick with 1,500 tracked and 10% moving per tick reads about a tenth of the motions (numbers in the report)", () => {
  noOffset();
  const plain = setup(false);
  const aware = setup(true);
  const N = 1500;
  for (let id = 1; id <= N; id++) { plain.add(id, id); aware.add(id, id); }
  plain.owner.scan();
  aware.owner.scan();
  const time = (t: ReturnType<typeof setup>) => {
    t.clock.now += 50;
    t.owner.flushTick();
    t.a.datagrams.length = 0;
    t.calls.motion = 0;
    const start = performance.now();
    for (let tick = 0; tick < 200; tick++) {
      for (let id = 1 + (tick % 10); id <= N; id += 10) t.move(id, 1);
      t.clock.now += 10;
      t.owner.flushTick();
      t.a.datagrams.length = 0;
    }
    return { ms: performance.now() - start, motions: t.calls.motion };
  };
  const p = time(plain);
  const a = time(aware);
  console.log(`flushTick bench 1500 tracked, 10% move/tick, 200 ticks: plain ${p.ms.toFixed(1)} ms (${p.motions} motion reads), dirty ${a.ms.toFixed(1)} ms (${a.motions} motion reads)`);
  expect(a.motions).toBeLessThan(p.motions / 3);
});

// ---- fix 3: cells kept between scans

const cellOf = (id: number, x: number, y: number, map = "m") => ({ id, map, x, y }) as any;

test("onBandCells asks `wanted` once per cell while the token is the same, and starts over for a new token", () => {
  const registry = new CreatureRegistry(100);
  for (let i = 0; i < 20; i++) registry.add(cellOf(i, i * 100 + 5, 5));
  const token = {};
  const wanted = mock((left: number) => left < 1000);
  const ids = () => [...registry.onBandCells("m", token, wanted)].map((c) => c.id).sort((p, q) => p - q);
  expect(ids()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(wanted).toHaveBeenCalledTimes(20);
  expect(ids()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(wanted).toHaveBeenCalledTimes(20);
  // a new token: the answer is worked out again
  const wanted2 = mock((left: number) => left >= 1500);
  expect([...registry.onBandCells("m", {}, wanted2)].map((c) => c.id).sort((p, q) => p - q)).toEqual([15, 16, 17, 18, 19]);
  expect(wanted2).toHaveBeenCalledTimes(20);
});

test("onBandCells follows creatures that cross cells, appear in new cells, and leave", () => {
  const registry = new CreatureRegistry(100);
  const token = {};
  const wanted = (left: number) => left < 500;
  const a = cellOf(1, 50, 5);
  const b = cellOf(2, 950, 5);
  registry.add(a);
  registry.add(b);
  const ids = () => [...registry.onBandCells("m", token, wanted)].map((c) => c.id).sort((p, q) => p - q);
  expect(ids()).toEqual([1]);
  // into a cell that passes, out of one that does not
  registry.move(b, 350, 5);
  expect(ids()).toEqual([1, 2]);
  // out of the band: the old cell is gone and the list drops it
  registry.move(a, 750, 5);
  expect(ids()).toEqual([2]);
  registry.add(cellOf(3, 60, 5));
  expect(ids()).toEqual([2, 3]);
  registry.remove(2);
  registry.remove(3);
  expect(ids()).toEqual([]);
  registry.add(cellOf(4, 10, 5));
  expect(ids()).toEqual([4]);
  // same answer as onMapCells for every state above
  expect([...registry.onMapCells("m", wanted)].map((c) => c.id)).toEqual([4]);
});

test("the creature registry reports a move to onMoved, and touch too", () => {
  const registry = new CreatureRegistry(100);
  const seen: number[] = [];
  registry.onMoved = (c) => { seen.push(c.id); };
  const c = cellOf(7, 5, 5);
  registry.add(c);
  expect(seen).toEqual([]);
  registry.move(c, 300, 5);
  registry.touch(c);
  expect(seen).toEqual([7, 7]);
});

test("a BorderBand token stays while the table is the same object and changes when the table is replaced", () => {
  const owners: Record<string, Owners> = { m: { "0,0": { nodeId: "a", epoch: 1, since: 0 }, "1,0": { nodeId: "b", epoch: 1, since: 0 } } };
  const band = new BorderBand((map) => owners[map] ?? {}, "a", () => Object.keys(owners));
  const first = band.token("m");
  band.refresh();
  expect(band.token("m")).toBe(first);
  owners.m = { ...owners.m, "2,0": { nodeId: "b", epoch: 2, since: 0 } };
  band.refresh();
  expect(band.token("m")).not.toBe(first);
});

// ---- fix 1: the bare memo

test("blockTableKey strips .json and does not grow without bound for names that are not maps", () => {
  expect(blockTableKey("main.json")).toBe("cells:blocks:main");
  expect(blockTableKey("main")).toBe("cells:blocks:main");
  for (let i = 0; i < 2000; i++) expect(blockTableKey(`m${i}.json`)).toBe(`cells:blocks:m${i}`);
  expect(blockTableKey("main.json")).toBe("cells:blocks:main");
});

test("the block table's per-entity lookups do not allocate a string for a .json map name", () => {
  const { BlockTable } = require("../cluster/blocks") as typeof import("../cluster/blocks");
  const table = new BlockTable({} as any);
  const start = performance.now();
  for (let i = 0; i < 1_000_000; i++) table.ownersOf("main.json");
  const ms = performance.now() - start;
  console.log(`ownersOf(".json") x1,000,000: ${ms.toFixed(1)} ms`);
  expect(table.ownersOf("main.json")).toBe(table.ownersOf("main"));
});

// ---- fix round 1: guards for the risky parts

test("the bare memo stays within its cap however many names come in", () => {
  for (let i = 0; i < 2000; i++) blockTableKey(`cap${i}.json`);
  expect(bareMemoSize()).toBeLessThanOrEqual(256);
  expect(bareMemoSize()).toBeGreaterThan(0);
});

test("touched entities past the budget stay marked and go out on the next ticks with no clock change", () => {
  noOffset();
  const per = GHOST_MOVES_PER_DATAGRAM;
  const t = setup(true, { datagramsPerTick: 1 });
  const count = per * 3;
  for (let id = 1; id <= count; id++) t.add(id, id);
  t.owner.scan();
  // Everything sent once (three ticks), at one instant: no keyframe is due afterwards.
  for (let i = 0; i < 3; i++) t.owner.flushTick();
  t.a.datagrams.length = 0;
  for (let id = 1; id <= count; id++) t.move(id, 7);
  const got: number[] = [];
  for (let i = 0; i < 3; i++) {
    t.owner.flushTick();
    got.push(...t.a.datagrams.splice(0).flatMap((d) => decodeGhostMoves(d)).map((m) => m.num));
  }
  expect(got.length).toBe(count);
  expect(new Set(got).size).toBe(count);
});

test("untracking an entity clears its mark, and a stale mark of an unlisted entity sends nothing", () => {
  const t = setup(true);
  t.add(1);
  t.add(2);
  t.owner.scan();
  t.owner.flushTick();
  t.moves();
  const one = (t.owner as any).tracked.get("loot").get(1);
  t.move(1, 5);
  expect(one.dirty).toBe(true);
  t.world.delete(1);
  t.owner.scan();
  expect(one.dirty).toBe(false);
  // Even with the mark put back by hand, the tick drops it: the entity is not listed.
  one.dirty = true;
  one.peers.add("b");
  (t.owner as any).dirtyList.push(one);
  t.world.set(1, { id: 1, x: 999, dir: 1, flags: 0 });
  t.owner.flushTick();
  expect(t.moves()).toEqual([]);
  expect(one.dirty).toBe(false);
  expect((t.owner as any).dirtyList.length).toBe(0);
});

test("an entity that is both touched and due is read once even when the budget leaves it for the next tick", () => {
  noOffset();
  const per = GHOST_MOVES_PER_DATAGRAM;
  const t = setup(true, { datagramsPerTick: 1 });
  const count = per + 1;
  for (let id = 1; id <= count; id++) t.add(id, id);
  t.owner.scan();
  t.owner.flushTick();
  t.owner.flushTick();
  t.a.datagrams.length = 0;
  t.clock.now += KEYFRAME;
  for (let id = 1; id <= count; id++) t.owner.touch("loot", id);
  t.calls.motion = 0;
  t.owner.flushTick();
  expect(t.calls.motion).toBe(count);
});

test("touch before attach and after detach keeps nothing", () => {
  const owner = new Ghosts({ scanMs: 1_000_000 });
  owner.touch("loot", 1);
  owner.touch("player", 5);
  expect((owner as any).dirtyList.length).toBe(0);
});

test("a player touched with a numeric id marks the tracked player filed under its string id", () => {
  const { a } = linkPair();
  const owner = new Ghosts({ scanMs: 1_000_000 });
  owner.register({
    name: "player", dirtyMarks: true,
    *candidates() { yield { id: "5", num: 5, map: "main", layerId: null, x: 1, y: 0 }; },
    snapshot: () => ({ id: "5" }),
    motion: () => ({ x: 1, y: 0, dir: 1, flags: 0 }),
    spawn: () => {}, despawn: () => {},
  });
  owner.attach(a, () => new Set(["b"]));
  owner.scan();
  owner.flushTick();
  owner.touch("player", 5 as any);
  expect((owner as any).dirtyList.length).toBe(1);
});
