import { expect, mock, test } from "bun:test";
import { Ghosts, type GhostKind, type GhostKindName } from "../cluster/ghosts";
import { GHOST_MOVES_PER_DATAGRAM, decodeGhostMoves, encodeGhostMoves, fromWire, toWire } from "../cluster/linkproto";
import type { LinkSender } from "../cluster/linktransport";
import { MirrorStore, RemoteObjects, mirrorPlayers } from "../cluster/mirrors";
import { databaseModule } from "./setup";
import { FakeLink, linkPair, settle } from "./cluster-fakelink";

// The ghost publisher and receiver, two Ghosts joined by a fake link pair (no
// NodeLinks), and aoiEvent both ways. aoievent loads socket/aoi, which reaches
// the database module: it is stubbed first, and aoievent is imported after the
// stub (a static import would be hoisted above it).
// The ignore list of "ignorer" (they ignore "speaker") is the only row it holds.
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params?: any[]) =>
    sql === "SELECT ignored FROM ignores WHERE username = ?" && params?.[0] === "ignorer" ? [{ ignored: "speaker" }] : [],
}));
const { aoiEvent, attachAoiEvents, detachAoiEvents, forwardAoiEvent } = await import("../cluster/aoievent");
const aoiReverse = await import("../services/aoiReverseIndex");
const playerCache = (await import("../services/playermanager")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;

type Seen = { log: string[]; mirrors: Map<number, any> };
const newSeen = (): Seen => ({ log: [], mirrors: new Map() });

/**
 * A test kind: entities the owner holds in `world`; the mirror side records what it was told. A record with
 * `refuse` set is refused, the way the player kind refuses an id that is a local player.
 */
function testKind(world: Map<number, any>, seen: Seen, name: GhostKindName = "loot"): GhostKind {
  return {
    name,
    *candidates() { for (const e of world.values()) yield { id: e.id, num: e.id, map: e.map, layerId: null, x: e.x, y: e.y }; },
    snapshot: (id) => { const e = world.get(Number(id)); return e ? { ...e } : null; },
    state: (id) => { const e = world.get(Number(id)); return e ? { hp: e.hp, ...("cast" in e ? { cast: e.cast } : {}) } : null; },
    motion: (id) => { const e = world.get(Number(id)); return e ? { x: e.x, y: e.y, dir: 1, flags: 0 } : null; },
    spawn: (record, from) => {
      if (record.refuse) { seen.log.push(`refuse ${record.id}`); return false; }
      seen.mirrors.set(record.id, { ...record, from });
      seen.log.push(`spawn ${record.id}`);
    },
    move: (id, x, y) => { const m = seen.mirrors.get(Number(id)); if (m) { m.x = x; m.y = y; } seen.log.push(`move ${id} ${x},${y}`); },
    update: (id, changes) => {
      const m = seen.mirrors.get(Number(id)) ?? {};
      for (const [field, value] of Object.entries(changes)) if (value === null) delete m[field]; else m[field] = value;
      seen.log.push(`update ${id} ${JSON.stringify(changes)}`);
    },
    relay: (id, packets) => seen.log.push(`relay ${id} ${packets.length}`),
    despawn: (id, reason) => { seen.mirrors.delete(Number(id)); seen.log.push(`despawn ${id} ${reason}`); },
  };
}

// Owner "a" mirrors to "b" whatever is at x >= 3000 (a stand-in for the 1250 px strip), and keeps a mirror
// already there to x >= 2936 (the 64 px hysteresis), as mirrorTargets does with `previous`.
const targets = (_map: string, x: number, _y: number, previous: ReadonlySet<string>) =>
  new Set(x >= (previous.has("b") ? 2936 : 3000) ? ["b"] : []);

function setup(timing = {}) {
  const { a, b } = linkPair();
  const clock = { now: 1_000_000 };
  const owner = new Ghosts({ scanMs: 1_000_000, now: () => clock.now, ...timing });
  const mirror = new Ghosts({ scanMs: 1_000_000, now: () => clock.now, ...timing });
  const world = new Map<number, any>();
  const seen = newSeen();
  owner.register(testKind(world, newSeen()));
  mirror.register(testKind(new Map(), seen));
  owner.attach(a, targets);
  mirror.attach(b, () => new Set());
  return { a, b, owner, mirror, world, seen, clock };
}

/** A third node "c" with a link to "b" only. */
function thirdNode(b: FakeLink) {
  const c = new FakeLink("c");
  c.other = b;
  return c;
}

test("an entity entering the strip is spawned, changed, moved and despawned", async () => {
  const { a, owner, mirror, world, seen } = setup();
  world.set(5, { id: 5, map: "main", x: 100, y: 0, hp: 10 });
  owner.scan();
  await settle();
  expect(seen.log).toEqual([]);

  world.get(5).x = 3100;
  owner.scan();
  await settle();
  expect(seen.mirrors.get(5)).toMatchObject({ id: 5, x: 3100, hp: 10, from: "a" });
  expect(mirror.mirrorCount()).toBe(1);

  world.get(5).hp = 7;
  owner.scan();
  await settle();
  expect(seen.log).toContain(`update 5 {"hp":7}`);

  world.get(5).x = 3200;
  owner.flushTick();
  expect(a.datagrams.length).toBe(1);
  expect(decodeGhostMoves(a.datagrams[0])).toEqual([{ num: 5, x: 3200, y: 0, dir: 1, flags: 0 }]);
  a.release();
  expect(seen.mirrors.get(5).x).toBe(3200);
  // Unchanged and inside the keyframe interval: nothing more.
  owner.flushTick();
  expect(a.datagrams.length).toBe(0);

  world.get(5).x = 100;
  owner.scan();
  await settle();
  expect(seen.log.at(-1)).toBe("despawn 5 left");
  expect(mirror.mirrorCount()).toBe(0);
});

test("a mirror is kept within the hysteresis band, and left past it", async () => {
  const { owner, world, seen } = setup();
  world.set(5, { id: 5, map: "main", x: 2950, y: 0, hp: 1 });
  owner.scan();
  await settle();
  // Not there yet: 2950 is too far to enter.
  expect(seen.log).toEqual([]);

  world.get(5).x = 3100;
  owner.scan();
  await settle();
  world.get(5).x = 2950;
  owner.scan();
  await settle();
  expect(seen.log).toEqual(["spawn 5"]);

  world.get(5).x = 2900;
  owner.scan();
  await settle();
  expect(seen.log).toEqual(["spawn 5", "despawn 5 left"]);
});

test("a field the owner stops reporting is cleared on the mirror", async () => {
  const { owner, world, seen } = setup();
  world.set(5, { id: 5, map: "main", x: 3500, y: 0, hp: 1, cast: "fire" });
  owner.scan();
  await settle();
  expect(seen.mirrors.get(5).cast).toBe("fire");
  delete world.get(5).cast;
  owner.scan();
  await settle();
  expect(seen.log.at(-1)).toBe(`update 5 {"cast":null}`);
  expect("cast" in seen.mirrors.get(5)).toBe(false);
});

test("a field that becomes undefined is cleared on the mirror", async () => {
  const { owner, world, seen } = setup();
  world.set(5, { id: 5, map: "main", x: 3500, y: 0, hp: 1, cast: "fire" });
  owner.scan();
  await settle();
  world.get(5).cast = undefined;
  owner.scan();
  await settle();
  expect(seen.log.at(-1)).toBe(`update 5 {"cast":null}`);
  expect("cast" in seen.mirrors.get(5)).toBe(false);
});

test("an entity that disappears is despawned as gone", async () => {
  const { owner, world, seen } = setup();
  world.set(6, { id: 6, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();
  world.delete(6);
  owner.scan();
  await settle();
  expect(seen.log.at(-1)).toBe("despawn 6 gone");
});

test("an entity that changes map is despawned there and sent again", async () => {
  const { owner, world, seen } = setup();
  world.set(7, { id: 7, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();
  world.get(7).map = "cave";
  owner.scan();
  await settle();
  expect(seen.log).toEqual(["spawn 7", "despawn 7 map", "spawn 7"]);
  expect(seen.mirrors.get(7).map).toBe("cave");
});

test("relayed packets reach the mirror side", async () => {
  const { owner, world, seen } = setup();
  world.set(8, { id: 8, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();
  owner.relay("loot", 8, [new Uint8Array([1]), new Uint8Array([2])], false);
  owner.relay("loot", 99, [new Uint8Array([1])], false);
  await settle();
  expect(seen.log.filter((l) => l.startsWith("relay"))).toEqual(["relay 8 2"]);
});

test("an unchanged entity is sent again at the keyframe interval", async () => {
  const { a, owner, world, seen, clock } = setup();
  world.set(5, { id: 5, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();
  owner.flushTick();
  a.release();
  world.get(5).x = 3510;
  owner.flushTick();
  expect(a.datagrams.length).toBe(1);
  a.release();

  clock.now += 499;
  owner.flushTick();
  expect(a.datagrams.length).toBe(0);
  clock.now += 1;
  owner.flushTick();
  expect(a.datagrams.length).toBe(1);
  expect(decodeGhostMoves(a.datagrams[0])).toEqual([{ num: 5, x: 3510, y: 0, dir: 1, flags: 0 }]);
  a.release();
  expect(seen.mirrors.get(5).x).toBe(3510);
});

test("a move that overtakes its spawn is dropped, and the next keyframe puts it right", async () => {
  const { a, owner, world, seen, clock } = setup();
  world.set(5, { id: 5, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  world.get(5).x = 3550;
  owner.flushTick();
  a.release();
  expect(seen.log).toEqual([]);
  await settle();
  expect(seen.mirrors.get(5).x).toBe(3500);

  owner.flushTick();
  expect(a.datagrams.length).toBe(0);
  clock.now += 500;
  owner.flushTick();
  a.release();
  expect(seen.mirrors.get(5).x).toBe(3550);
});

test("a move after the despawn is dropped", async () => {
  const { a, owner, world, seen } = setup();
  world.set(5, { id: 5, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();
  const late = encodeGhostMoves([{ num: 5, x: 3600, y: 0, dir: 1, flags: 0 }])[0];
  world.get(5).x = 100;
  owner.scan();
  await settle();
  a.datagrams.push(late);
  a.release();
  expect(seen.log).toEqual(["spawn 5", "despawn 5 left"]);
});

test("mirrors of a lost peer expire, unless it comes back and sends them again", async () => {
  const { a, owner, mirror, world, seen } = setup({ expireMs: 40 });
  world.set(1, { id: 1, map: "main", x: 3500, y: 0, hp: 1 });
  world.set(2, { id: 2, map: "main", x: 3600, y: 0, hp: 1 });
  owner.scan();
  await settle();
  expect(mirror.mirrorCount()).toBe(2);

  a.setUp(false);
  world.delete(2);
  a.setUp(true);
  owner.scan();
  await settle();
  await Bun.sleep(80);
  // 1 was sent again after the peer came back; 2 was not, and expired.
  expect([...seen.mirrors.keys()]).toEqual([1]);
  expect(seen.log).toContain("despawn 2 expired");
  expect(mirror.mirrorCount()).toBe(1);
});

test("a link replaced with no down resends everything and expires what the owner no longer has", async () => {
  const { a, owner, mirror, world, seen } = setup({ expireMs: 40 });
  world.set(1, { id: 1, map: "main", x: 3500, y: 0, hp: 1 });
  world.set(2, { id: 2, map: "main", x: 3600, y: 0, hp: 1 });
  owner.scan();
  await settle();
  // A restarted owner would no longer have 2 and would send no "gone" for it.
  world.delete(2);
  a.replace();
  const before = a.sent.length;
  owner.scan();
  await settle();
  expect(a.sent.slice(before)).toEqual(["GHOST_SPAWN"]);
  expect(seen.log.filter((l) => l === "spawn 1").length).toBe(2);
  await Bun.sleep(80);
  expect([...seen.mirrors.keys()]).toEqual([1]);
  expect(seen.log).toContain("despawn 2 expired");
  expect(mirror.mirrorCount()).toBe(1);
});

test("moves, changes and removals from a node that is not the mirror's source are ignored", async () => {
  const { a, b, owner, world, seen } = setup();
  world.set(3, { id: 3, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();

  // A third node "c", linked to "b", speaks about the mirror "b" holds from "a".
  const c = thirdNode(b);
  const head = { kind: "loot", id: 3, num: 3 };
  c.sendDatagram("b", encodeGhostMoves([{ num: 3, x: 9999, y: 9, dir: 2, flags: 0 }])[0]);
  c.release();
  c.send("b", "GHOST_STATE", { ...head, changes: { hp: 0 } });
  c.send("b", "GHOST_DESPAWN", { ...head, reason: "gone" });
  await settle();
  expect(seen.mirrors.get(3)).toMatchObject({ x: 3500, y: 0, hp: 1, from: "a" });
  expect(seen.log).toEqual(["spawn 3"]);

  // The source itself still moves it.
  world.get(3).x = 3600;
  owner.flushTick();
  a.release();
  expect(seen.mirrors.get(3).x).toBe(3600);
});

test("a spawn from another node takes the mirror over: the newest owner wins", async () => {
  const { a, b, owner, mirror, world, seen } = setup();
  world.set(3, { id: 3, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();
  const c = thirdNode(b);
  c.send("b", "GHOST_SPAWN", { kind: "loot", id: 3, num: 3, record: { id: 3, map: "main", x: 5000, y: 0, hp: 2 } });
  await settle();
  expect(seen.mirrors.get(3)).toMatchObject({ x: 5000, hp: 2, from: "c" });
  expect(mirror.mirrorCount()).toBe(1);

  // "a" no longer moves it; "c" does.
  world.get(3).x = 3600;
  owner.flushTick();
  a.release();
  expect(seen.mirrors.get(3).x).toBe(5000);
  c.sendDatagram("b", encodeGhostMoves([{ num: 3, x: 5100, y: 0, dir: 1, flags: 0 }])[0]);
  c.release();
  expect(seen.mirrors.get(3).x).toBe(5100);
});

test("a spawn under another kind replaces the stale mirror through its own kind", async () => {
  const { b, owner, mirror, world, seen } = setup();
  const chests = newSeen();
  mirror.register(testKind(new Map(), chests, "chest"));
  world.set(3, { id: 3, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();
  thirdNode(b).send("b", "GHOST_SPAWN", { kind: "chest", id: "chest_3", num: 3, record: { id: "chest_3", map: "main", x: 1, y: 1 } });
  await settle();
  expect(seen.log).toEqual(["spawn 3", "despawn 3 replaced"]);
  expect(chests.log).toEqual(["spawn chest_3"]);
  expect(mirror.mirrorCount()).toBe(1);
});

test("messages for an unknown kind, an unknown mirror or a number that is not the id's are ignored", async () => {
  const { a, mirror, seen } = setup();
  a.send("b", "GHOST_SPAWN", { kind: "tornado", id: "t1", num: 1, record: { id: 1 } });
  a.send("b", "GHOST_SPAWN", { kind: "loot", id: 5, num: 6, record: { id: 5, map: "main", x: 0, y: 0 } });
  a.send("b", "GHOST_STATE", { kind: "loot", id: 7, num: 7, changes: { hp: 1 }, packets: toWire([new Uint8Array([1])]) });
  a.send("b", "GHOST_DESPAWN", { kind: "loot", id: 7, num: 7, reason: "gone" });
  await settle();
  expect(mirror.mirrorCount()).toBe(0);
  expect(seen.log).toEqual([]);
});

test("a spawn the kind refuses is not recorded, and nothing follows for it", async () => {
  const { a, b, owner, mirror, world, seen } = setup();
  world.set(11, { id: 11, map: "main", x: 3500, y: 0, hp: 1, refuse: true });
  owner.scan();
  await settle();
  expect(seen.log).toEqual(["refuse 11"]);
  expect(mirror.mirrorCount()).toBe(0);
  owner.flushTick();
  a.release();
  world.get(11).x = 100;
  owner.scan();
  await settle();
  expect(seen.log).toEqual(["refuse 11"]);

  // A refused spawn from another node leaves the mirror already held alone.
  world.set(12, { id: 12, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();
  thirdNode(b).send("b", "GHOST_SPAWN", { kind: "loot", id: 12, num: 12, record: { id: 12, refuse: true } });
  await settle();
  expect(seen.mirrors.get(12)).toMatchObject({ x: 3500, from: "a" });
  world.get(12).x = 3600;
  owner.flushTick();
  a.release();
  expect(seen.mirrors.get(12).x).toBe(3600);
  expect(mirror.mirrorCount()).toBe(1);
});

test("datagram budget: at most 16 per peer per tick, the rest next tick", async () => {
  const { a, owner, world } = setup();
  for (let i = 1; i <= GHOST_MOVES_PER_DATAGRAM * 16 + 10; i++) world.set(i, { id: i, map: "main", x: 3000 + i, y: 0, hp: 1 });
  owner.scan();
  await settle();
  owner.flushTick();
  expect(a.datagrams.length).toBe(16);
  a.datagrams.length = 0;
  owner.flushTick();
  expect(a.datagrams.length).toBe(1);
  expect(decodeGhostMoves(a.datagrams[0]).length).toBe(10);
});

test("datagram budget is fair: entities that always move cannot starve the rest", async () => {
  const { a, owner, world } = setup();
  const count = 2000;
  for (let i = 1; i <= count; i++) world.set(i, { id: i, map: "main", x: 3000 + i, y: 0, hp: 1 });
  owner.scan();
  await settle();
  const sent = new Set<number>();
  const ticks = Math.ceil(count / (GHOST_MOVES_PER_DATAGRAM * 16));
  for (let tick = 0; tick < ticks; tick++) {
    for (const e of world.values()) e.x += 1;
    owner.flushTick();
    expect(a.datagrams.length).toBeLessThanOrEqual(16);
    for (const datagram of a.datagrams.splice(0)) for (const move of decodeGhostMoves(datagram)) sent.add(move.num);
  }
  expect(sent.size).toBe(count);
});

test("detach despawns every mirror and stops calling kinds", async () => {
  const { a, owner, mirror, world, seen } = setup();
  world.set(4, { id: 4, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();
  mirror.detach();
  expect(seen.log.at(-1)).toBe("despawn 4 detached");
  expect(mirror.mirrorCount()).toBe(0);

  // A detached receiver ignores what still arrives on its links.
  world.set(9, { id: 9, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();
  expect(seen.log).toEqual(["spawn 4", "despawn 4 detached"]);

  // A detached owner sends nothing.
  owner.detach();
  const sent = a.sent.length;
  world.get(4).x = 3700;
  world.set(10, { id: 10, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  owner.flushTick();
  owner.relay("loot", 4, [new Uint8Array([1])], false);
  await settle();
  expect(a.sent.length).toBe(sent);
  expect(a.datagrams.length).toBe(0);
});

test("attaching again detaches first, and a refused handler leaves nothing attached", async () => {
  const { a, b, owner, mirror, world, seen } = setup();
  world.set(4, { id: 4, map: "main", x: 3500, y: 0, hp: 1 });
  owner.scan();
  await settle();
  mirror.attach(b, () => new Set());
  expect(seen.log).toEqual(["spawn 4", "despawn 4 detached"]);

  // Links that refuse a second handler for a kind, as NodeLinks does.
  const strict = Object.assign(Object.create(a), {
    on: () => { throw new Error('"GHOST_SPAWN" already has a handler'); },
  }) as LinkSender;
  const fresh = new Ghosts({ scanMs: 1_000_000 });
  fresh.register(testKind(world, newSeen()));
  expect(() => fresh.attach(strict, targets)).toThrow();
  const sent = a.sent.length;
  fresh.scan();
  fresh.flushTick();
  expect(a.sent.length).toBe(sent);
  expect(a.datagrams.length).toBe(0);
});

test("MirrorStore and RemoteObjects bookkeeping", () => {
  const store = new MirrorStore();
  store.set({ kind: "loot", id: "loot_1", num: 1, from: "a", confirmedAt: 0 });
  store.set({ kind: "chest", id: "chest_2", num: 2, from: "c", confirmedAt: 0 });
  expect(store.fromPeer("a").map((m) => m.num)).toEqual([1]);
  store.set({ kind: "loot", id: "loot_1", num: 1, from: "c", confirmedAt: 1 });
  expect(store.fromPeer("a")).toEqual([]);
  expect(store.fromPeer("c").length).toBe(2);
  expect(store.remove(1)?.id).toBe("loot_1");
  expect(store.size).toBe(1);

  const objects = new RemoteObjects<{ id: string; map: string }>();
  objects.set({ id: "x", map: "main" });
  objects.set({ id: "y", map: "other" });
  expect(objects.onMap("main", (o) => o.map).map((o) => o.id)).toEqual(["x"]);
  expect(objects.delete("x")?.id).toBe("x");
  expect(objects.get("x")).toBeUndefined();
});

test("aoiEvent forwards to the neighbours whose blocks are in range, until detached", async () => {
  const { a, b } = linkPair();
  const blockOwner = (nodeId: string) => ({ nodeId, epoch: 1, since: 0 });
  const got: any[] = [];
  b.on("AOI_EVENT", (data, from) => got.push({ ...data, from }));
  attachAoiEvents(a, () => ({ "0,0": blockOwner("a"), "1,0": blockOwner("b") }));
  const packet = new Uint8Array([7, 8]);
  try {
    // 96 px from block 1,0 (it starts at x 4096).
    aoiEvent("main", null, 4000, 100, 500, [packet]);
    await settle();
    expect(got.length).toBe(1);
    expect(got[0]).toMatchObject({ map: "main", layerId: null, x: 4000, y: 100, radius: 500, bestEffort: false, from: "a" });
    expect(fromWire(got[0].packets)).toEqual([packet]);

    aoiEvent("main", null, 1000, 100, 500, [packet]);
    await settle();
    expect(got.length).toBe(1);
  } finally {
    detachAoiEvents();
  }
  aoiEvent("main", null, 4000, 100, 500, [packet]);
  await settle();
  expect(got.length).toBe(1);
});

test("an AOI_EVENT from a neighbour reaches local players in range (radius capped), until detached", async () => {
  const { a, b } = linkPair();
  const map = "ghosts-aoi-event";
  const received: Record<string, number> = { near: 0, far: 0 };
  const player = (id: string, x: number) => ({
    id, location: { map, position: { x, y: 100, direction: "down" } },
    wt: { readyState: 1, send: () => received[id]++, sendBestEffort: () => received[id]++ },
  });
  playerCache.add("near", player("near", 100));
  playerCache.add("far", player("far", 3200));
  spatialGrid.addPlayer("near", 100, 100, map);
  spatialGrid.addPlayer("far", 3200, 100, map);
  attachAoiEvents(b, () => ({}));
  const message = (radius: number) => ({ map, layerId: null, x: 120, y: 100, radius, packets: toWire([new Uint8Array([1])]), bestEffort: false });
  try {
    a.send("b", "AOI_EVENT", message(500));
    await settle();
    expect(received).toEqual({ near: 1, far: 0 });
    // 3080 px away: past the cap a huge radius from the wire is cut to.
    a.send("b", "AOI_EVENT", message(1e9));
    await settle();
    expect(received).toEqual({ near: 2, far: 0 });

    detachAoiEvents();
    a.send("b", "AOI_EVENT", message(500));
    await settle();
    expect(received).toEqual({ near: 2, far: 0 });
  } finally {
    detachAoiEvents();
    for (const id of ["near", "far"]) {
      spatialGrid.removePlayer(id);
      playerCache.remove(id);
    }
  }
});

test("forwardAoiEvent carries the speaker only when it is given one", async () => {
  const { a, b } = linkPair();
  const got: any[] = [];
  b.on("AOI_EVENT", (data) => got.push(data));
  attachAoiEvents(a, () => ({ "0,0": { nodeId: "a", epoch: 1, since: 0 }, "1,0": { nodeId: "b", epoch: 1, since: 0 } }));
  try {
    forwardAoiEvent("main", null, 4000, 100, 500, [new Uint8Array([1])], { speaker: "speaker" });
    forwardAoiEvent("main", null, 4000, 100, 500, [new Uint8Array([1])]);
    await settle();
    expect(got.length).toBe(2);
    expect(got[0].speaker).toBe("speaker");
    expect("speaker" in got[1]).toBe(false);
  } finally {
    detachAoiEvents();
  }
});

test("a line from a neighbour's speaker is held back from the listeners who ignore them, and from those who cannot see them", async () => {
  const { a, b } = linkPair();
  const map = "ghosts-aoi-chat";
  const names = ["ignorer", "friend", "blind"];
  const received: Record<string, number> = { ignorer: 0, friend: 0, blind: 0 };
  for (const name of names) {
    playerCache.add(name, {
      id: name, username: name, aoi: {}, location: { map, position: { x: 100, y: 100, direction: "down" } },
      wt: { readyState: 1, send: () => received[name]++, sendBestEffort: () => received[name]++ },
    });
    spatialGrid.addPlayer(name, 100, 100, map);
  }
  attachAoiEvents(b, () => ({}));
  const message = (extra: object) => ({ map, layerId: null, x: 120, y: 100, radius: 500, packets: toWire([new Uint8Array([1])]), bestEffort: false, ...extra });
  const reset = () => { for (const name of names) received[name] = 0; };
  try {
    // Without a speaker the event behaves as before: everyone in range.
    a.send("b", "AOI_EVENT", message({}));
    await settle();
    expect(received).toEqual({ ignorer: 1, friend: 1, blind: 1 });

    // No mirror of the speaker here: the radius rule, less whoever ignores them.
    reset();
    a.send("b", "AOI_EVENT", message({ speaker: "Speaker" }));
    await settle();
    expect(received).toEqual({ ignorer: 0, friend: 1, blind: 1 });

    // With the speaker's mirror here, only its viewers hear it.
    mirrorPlayers.set("m1", { id: "m1", username: "speaker", remote: true });
    aoiReverse.addViewer("m1", "friend");
    aoiReverse.addViewer("m1", "ignorer");
    reset();
    a.send("b", "AOI_EVENT", message({ speaker: "speaker" }));
    await settle();
    expect(received).toEqual({ ignorer: 0, friend: 1, blind: 0 });
  } finally {
    detachAoiEvents();
    mirrorPlayers.delete("m1");
    aoiReverse.removeViewer("m1", "friend");
    aoiReverse.removeViewer("m1", "ignorer");
    for (const name of names) {
      spatialGrid.removePlayer(name);
      playerCache.remove(name);
    }
  }
});

test("a GHOST_SPAWN whose record id is not the head id is dropped", async () => {
  const { b, owner, seen } = setup();
  thirdNode(b).send("b", "GHOST_SPAWN", { kind: "loot", id: 6, num: 6, record: { id: 7, x: 1, y: 1 } });
  thirdNode(b).send("b", "GHOST_SPAWN", { kind: "loot", id: 6, num: 6, record: { x: 1, y: 1 } });
  await settle();
  expect(seen.log).toEqual([]);
  // The same id as a string and as a number is the same id (a record may name it either way).
  thirdNode(b).send("b", "GHOST_SPAWN", { kind: "loot", id: 6, num: 6, record: { id: "6", x: 1, y: 1 } });
  await settle();
  expect(seen.log).toEqual(["spawn 6"]);
  void owner;
});

test("a spawn that throws is cleaned up through the kind's despawn, and nothing is recorded", async () => {
  const { b, mirror, seen } = setup();
  const stored = new Set<number>();
  const log: string[] = [];
  const throwing: GhostKind = {
    ...testKind(new Map(), seen),
    spawn: (record) => { stored.add(record.id); throw new Error("bad record"); },
    despawn: (id, reason) => { stored.delete(Number(id)); log.push(`despawn ${id} ${reason}`); },
  };
  mirror.register(throwing);
  thirdNode(b).send("b", "GHOST_SPAWN", { kind: "loot", id: 8, num: 8, record: { id: 8, x: 1, y: 1 } });
  await settle();
  expect(log).toEqual(["despawn 8 failed"]);
  expect([...stored]).toEqual([]);
  expect((mirror as any).mirrors.get(8)).toBeUndefined();
});
