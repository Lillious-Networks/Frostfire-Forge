import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SPAWN_FLUSH_CONCURRENCY, flushSpawnQueue, requeueSpawnBatch, runBounded, setBounded, spawnsPerFlush,
  SPAWN_FLUSH_BUDGET_MS,
} from "../socket/batch_queue_utils";
import { forgetLook, holdsLook, lookSignature, noteLook } from "../socket/looks";

// The limit fix wave, fix 3: the spawn flush runs several receivers at once, hands a long queue 50 spawns a flush,
// and keeps its sprite caches bounded. The pass itself (claim, restore, bounded concurrency, time budget) is
// flushSpawnQueue in batch_queue_utils and is imported. The per-receiver step, flushOneSpawnBatch, lives in the
// receiver, which a test cannot import (it starts the server), so that one function is cut out of its source and
// run here with the names it uses handed in (line endings normalised, so a CRLF checkout cuts the same).
const source = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8").replace(/\r\n/g, "\n");
const from = source.indexOf("async function flushOneSpawnBatch(");
const to = source.indexOf("export const despawnBatchQueue");
expect(from).toBeGreaterThan(0);
expect(to).toBeGreaterThan(from);
const transpiler = new Bun.Transpiler({ loader: "ts" });
const NAMES = [
  "spawnBatchQueue", "requeueSpawnBatch", "SPAWN_BACKPRESSURE_THRESHOLD",
  "spawnsPerFlush", "spriteDataCache", "animationDataCache", "SPRITE_CACHE_MAX", "setBounded", "entityById", "getAnimationNameForDirection",
  "getPlayerSpriteSheetData", "getMountSpriteUrl", "getAnimationData", "sendPacket", "sendPacketQueued", "packetManager", "globalStateRevision",
  "forgetLook", "noteLook", "lookSignature",
];
const make = new Function(`"use strict";
${transpiler.transformSync(
  `function make({ ${NAMES.join(", ")} }: any) {
${source.slice(from, to)}
return flushOneSpawnBatch;
}`,
)}
return make;`)() as (given: Record<string, any>) => (...args: any[]) => Promise<void>;

const sheetOf = (name: string) => ({ name, templateUrl: `t/${name}`, imageUrl: `i/${name}` });

/** A promise settled by hand. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
const ticks = async (count = 20) => { for (let i = 0; i < count; i++) await Promise.resolve(); };

/** The flush over `queue` ({ receiver: [spawned player ids] }), with sprite lookups waiting on `hold`. */
function world(queue: Record<string, string[]>, opts: {
  hold?: Promise<void>; max?: number;
  /** True for a packet the connection drops (the transport's queue is full). */
  drop?: (packet: any) => boolean;
  /** The sheet name of a player's body; "body" when not listed. A player listed as null has no animation. */
  bodyOf?: Record<string, string | null>;
  animJsonCache?: Map<string, any>;
} = {}) {
  const spawnBatchQueue = new Map<string, Map<string, any>>();
  const players: Record<string, any> = {};
  for (const [receiver, spawned] of Object.entries(queue)) {
    players[receiver] = { id: receiver, wt: { readyState: 1, getFreshQueuedBytes: () => 0, id: receiver } };
    const batch = new Map<string, any>();
    for (const id of spawned) {
      batch.set(id, { id, username: id });
      players[id] ??= { id, location: { position: { direction: "down" } }, equipment: { tag: id }, equipmentRevision: 0 };
    }
    spawnBatchQueue.set(receiver, batch);
  }
  const events: string[] = [];
  const sent: Array<{ to: string; kind: string; ids: string[] }> = [];
  const lookups: string[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const spriteDataCache = new Map<string, any>();
  const animationDataCache = new Map<string, any>();
  const deliver = (wt: any, packet: any) => {
    if (opts.drop?.(packet)) return false;
    events.push(`${wt.id} ${packet.kind}`);
    sent.push({ to: wt.id, kind: packet.kind, ids: packet.ids });
    return true;
  };
  const flushOne = make({
    spawnBatchQueue,
    requeueSpawnBatch, spawnsPerFlush, setBounded,
    SPAWN_BACKPRESSURE_THRESHOLD: 1e9,
    spriteDataCache, animationDataCache, SPRITE_CACHE_MAX: opts.max ?? 5000,
    entityById: () => null,
    getAnimationNameForDirection: () => "walk_down",
    getMountSpriteUrl: () => null,
    getPlayerSpriteSheetData: async (_animation: string, equipment: any) => {
      lookups.push(equipment.tag);
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await opts.hold;
      inFlight--;
      return { bodySprite: { name: "body" }, headSprite: null, animationState: "walk" };
    },
    // The real record of sheets (socket/looks.ts): what the flush records is asserted below.
    forgetLook, noteLook, lookSignature,
    getAnimationData: async (_name: string, id: string) => {
      const body = opts.bodyOf && id in opts.bodyOf ? opts.bodyOf[id] : "body";
      return body === null ? null : { id, bodySprite: sheetOf(body), headSprite: sheetOf("head"), animationState: "walk_down" };
    },
    packetManager: {
      loadPlayersJson: (parts: string[]) => ({ kind: "spawn", ids: parts.map((p) => JSON.parse(p).id) }),
      batchSpriteSheetAnimationJson: (parts: string[]) => ({ kind: "anim", ids: parts.map((p) => JSON.parse(p).id) }),
    },
    globalStateRevision: 1,
    sendPacket: (wt: any, packet: any) => { deliver(wt, packet); },
    sendPacketQueued: (wt: any, packet: any) => deliver(wt, packet),
  });
  const flush = () => flushSpawnQueue(spawnBatchQueue, (id, claimed) => flushOne(id, claimed, players, new Map(), opts.animJsonCache ?? new Map()), SPAWN_FLUSH_CONCURRENCY);
  return { flush, players, spawnBatchQueue, events, sent, lookups, mostInFlight: () => mostInFlight, spriteDataCache, animationDataCache };
}

test("two receivers are flushed at once, and each gets its own spawns, then their animations, in the order queued", async () => {
  const hold = gate();
  const w = world({ r1: ["a1", "a2", "a3"], r2: ["b1", "b2"] }, { hold: hold.promise });
  const done = w.flush();
  await ticks();
  // Both receivers' sprite lookups have started while neither is finished: the second did not wait for the first.
  expect(w.lookups.sort()).toEqual(["a1", "a2", "a3", "b1", "b2"]);
  expect(w.sent).toEqual([]);
  hold.open();
  await done;
  expect(w.sent.filter((m) => m.to === "r1")).toEqual([
    { to: "r1", kind: "spawn", ids: ["a1", "a2", "a3"] },
    { to: "r1", kind: "anim", ids: ["a1", "a2", "a3"] },
  ]);
  expect(w.sent.filter((m) => m.to === "r2")).toEqual([
    { to: "r2", kind: "spawn", ids: ["b1", "b2"] },
    { to: "r2", kind: "anim", ids: ["b1", "b2"] },
  ]);
  expect(w.spawnBatchQueue.size).toBe(0);
});

test("no more than 8 receivers are flushed at once, and every one is flushed", async () => {
  const hold = gate();
  const queue: Record<string, string[]> = {};
  for (let i = 0; i < 20; i++) queue[`r${i}`] = [`p${i}`];
  const w = world(queue, { hold: hold.promise });
  const done = w.flush();
  await ticks(50);
  expect(w.lookups.length).toBe(SPAWN_FLUSH_CONCURRENCY);
  hold.open();
  await done;
  expect(w.mostInFlight()).toBe(SPAWN_FLUSH_CONCURRENCY);
  expect(new Set(w.sent.map((m) => m.to)).size).toBe(20);
  expect(w.spawnBatchQueue.size).toBe(0);
});

test("a receiver with a long queue gets 50 spawns a flush, and the rest stay queued; a short queue gets 10", async () => {
  const many = Array.from({ length: 130 }, (_, i) => `m${i}`);
  const few = Array.from({ length: 25 }, (_, i) => `f${i}`);
  const w = world({ long: many, short: few });
  await w.flush();
  const longSpawns = w.sent.filter((m) => m.to === "long" && m.kind === "spawn").flatMap((m) => m.ids);
  const shortSpawns = w.sent.filter((m) => m.to === "short" && m.kind === "spawn").flatMap((m) => m.ids);
  expect(longSpawns).toEqual(many.slice(0, 50));
  expect(shortSpawns).toEqual(few.slice(0, 10));
  // The rest are queued for the next flush, in order.
  expect([...w.spawnBatchQueue.get("long")!.keys()]).toEqual(many.slice(50));
  expect([...w.spawnBatchQueue.get("short")!.keys()]).toEqual(few.slice(10));
});

test("a queue of exactly 100 is still 10 a flush; 101 is 50", () => {
  expect(spawnsPerFlush(1)).toBe(10);
  expect(spawnsPerFlush(100)).toBe(10);
  expect(spawnsPerFlush(101)).toBe(50);
  expect(spawnsPerFlush(5000)).toBe(50);
});

test("the sprite caches hold at most SPRITE_CACHE_MAX entries, the newest kept", async () => {
  const w = world({ r1: Array.from({ length: 8 }, (_, i) => `p${i}`) }, { max: 3 });
  await w.flush();
  expect(w.spriteDataCache.size).toBe(3);
  expect(w.animationDataCache.size).toBe(3);
  expect([...w.spriteDataCache.keys()]).toEqual(["p5:walk_down:0", "p6:walk_down:0", "p7:walk_down:0"]);
});

test("runBounded: each item once, `limit` at a time, the first error thrown after the others finished", async () => {
  const started: number[] = [];
  let live = 0;
  let most = 0;
  await runBounded([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    started.push(n);
    live++;
    most = Math.max(most, live);
    await new Promise((resolve) => setTimeout(resolve, 1));
    live--;
  });
  expect(started).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(most).toBe(3);
  const finished: number[] = [];
  await expect(runBounded([1, 2, 3], 2, async (n) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (n === 1) throw new Error("boom");
    finished.push(n);
  })).rejects.toThrow("boom");
  expect(finished).toEqual([2, 3]);
  await runBounded([], 8, async () => { throw new Error("never"); });
});

test("setBounded keeps the newest entries, and a key set again counts as newest", () => {
  const map = new Map<string, number>();
  for (const [i, key] of ["a", "b", "c"].entries()) setBounded(map, key, i, 3);
  setBounded(map, "a", 9, 3);
  setBounded(map, "d", 4, 3);
  expect([...map.keys()]).toEqual(["c", "a", "d"]);
  expect(map.get("a")).toBe(9);
});

/** A fake clock: each receiver's flush costs `cost` ms, spent before its first await. */
function budgetRun(receivers: string[], cost: number) {
  const queue = new Map<string, Map<string, any>>();
  for (const r of receivers) queue.set(r, new Map([[`s-${r}`, { id: `s-${r}` }]]));
  let clock = 0;
  const started: string[] = [];
  const pass = () => flushSpawnQueue(queue, async (id) => { started.push(id); clock += cost; }, SPAWN_FLUSH_CONCURRENCY, SPAWN_FLUSH_BUDGET_MS, () => clock);
  return { queue, started, pass, reset: () => { clock = 0; } };
}

test("a spawn flush pass starts no receiver once 12 ms are used; the rest stay queued and go out next pass, in order", async () => {
  expect(SPAWN_FLUSH_BUDGET_MS).toBe(12);
  const run = budgetRun(["r1", "r2", "r3", "r4", "r5", "r6", "r7"], 5);
  await run.pass();
  // r1 at 0 ms, r2 at 5, r3 at 10 (under 12); at 15 ms the budget is gone.
  expect(run.started).toEqual(["r1", "r2", "r3"]);
  expect([...run.queue.keys()]).toEqual(["r4", "r5", "r6", "r7"]);
  run.reset();
  await run.pass();
  expect(run.started).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
  expect([...run.queue.keys()]).toEqual(["r7"]);
  run.reset();
  await run.pass();
  expect(run.started).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
  expect(run.queue.size).toBe(0);
});

test("a receiver that alone costs more than the budget still goes out, one a pass", async () => {
  const run = budgetRun(["a", "b"], 40);
  await run.pass();
  expect(run.started).toEqual(["a"]);
  run.reset();
  await run.pass();
  expect(run.started).toEqual(["a", "b"]);
});

test("a receiver whose flush throws is restored, not lost, and the pass goes on", async () => {
  const queue = new Map<string, Map<string, any>>([["bad", new Map([["x", 1]])], ["ok", new Map([["y", 2]])]]);
  const done: string[] = [];
  await flushSpawnQueue(queue, async (id) => { if (id === "bad") throw new Error("boom"); done.push(id); }, 8);
  expect(done).toEqual(["ok"]);
  expect([...queue.get("bad")!.keys()]).toEqual(["x"]);
  expect(queue.has("ok")).toBe(false);
});

// ---- what the viewer is recorded as holding (socket/looks.ts), with the real record

const viewerOf = (w: ReturnType<typeof world>, receiver: string) => w.players[receiver].wt;
const looksOf = (body: string) => lookSignature({ bodySprite: sheetOf(body), headSprite: sheetOf("head") });

test("a flush records the sheets it sent, so the next pose of that player can go out alone", async () => {
  const w = world({ r1: ["a", "b"], r2: ["a"] });
  await w.flush();
  expect(holdsLook(viewerOf(w, "r1"), "a", looksOf("body"))).toBe(true);
  expect(holdsLook(viewerOf(w, "r1"), "b", looksOf("body"))).toBe(true);
  expect(holdsLook(viewerOf(w, "r2"), "a", looksOf("body"))).toBe(true);
  // Only for the sheets that were sent: another look is not held.
  expect(holdsLook(viewerOf(w, "r1"), "a", looksOf("other"))).toBe(false);
  expect(holdsLook(viewerOf(w, "r2"), "b", looksOf("body"))).toBe(false);
});

test("a flush clears what the viewer held of a spawned player, even when no sheets go out for them", async () => {
  const w = world({ r1: ["a", "ghost"] }, { bodyOf: { ghost: null } });
  noteLook(viewerOf(w, "r1"), "ghost", looksOf("old"));
  noteLook(viewerOf(w, "r1"), "a", looksOf("old"));
  await w.flush();
  // The client builds "ghost" anew and got no sheet for it: the old record would make the next pose a bare pose.
  expect(holdsLook(viewerOf(w, "r1"), "ghost", looksOf("old"))).toBe(false);
  // "a" got its sheets: the record is the new look, not the old.
  expect(holdsLook(viewerOf(w, "r1"), "a", looksOf("old"))).toBe(false);
  expect(holdsLook(viewerOf(w, "r1"), "a", looksOf("body"))).toBe(true);
});

test("a sheet packet the connection dropped leaves no record", async () => {
  const w = world({ r1: ["a"] }, { drop: (packet) => packet.kind === "anim" });
  noteLook(viewerOf(w, "r1"), "a", looksOf("body"));
  await w.flush();
  expect(w.sent.map((m) => m.kind)).toEqual(["spawn"]);
  expect(holdsLook(viewerOf(w, "r1"), "a", looksOf("body"))).toBe(false);
});

test("the record is the look of the json that was sent, not of a newer copy of the data", async () => {
  // The json for "a" was built earlier in the flush from the old look; the data now says another.
  const animJsonCache = new Map<string, any>([["a", { json: JSON.stringify({ id: "a", bodySprite: sheetOf("older") }), signature: looksOf("older") }]]);
  const w = world({ r1: ["a"] }, { animJsonCache });
  await w.flush();
  const batch = w.sent.find((m) => m.kind === "anim")!;
  expect(batch.ids).toEqual(["a"]);
  expect(holdsLook(viewerOf(w, "r1"), "a", looksOf("older"))).toBe(true);
  expect(holdsLook(viewerOf(w, "r1"), "a", looksOf("body"))).toBe(false);
});

test("a changed url under the same sheet name is another look", () => {
  const a = lookSignature({ bodySprite: { name: "body", templateUrl: "t/1", imageUrl: "i/1" } });
  expect(lookSignature({ bodySprite: { name: "body", templateUrl: "t/1", imageUrl: "i/1" } })).toBe(a);
  expect(lookSignature({ bodySprite: { name: "body", templateUrl: "t/2", imageUrl: "i/1" } })).not.toBe(a);
  expect(lookSignature({ bodySprite: { name: "body", templateUrl: "t/1", imageUrl: "i/2" } })).not.toBe(a);
  expect(lookSignature({ mountSprite: { name: "body", templateUrl: "t/1", imageUrl: "i/1" } })).not.toBe(a);
});

// ---- the queued despawns and sendAnimationTo, cut out of the receiver the same way

const despawnFrom = source.indexOf("function flushDespawnBatches(");
const despawnTo = source.indexOf("// Movement is flushed by the game loop");
expect(despawnFrom).toBeGreaterThan(0);
expect(despawnTo).toBeGreaterThan(despawnFrom);
const makeDespawn = new Function(`"use strict";
${transpiler.transformSync(
  `function make({ despawnBatchQueue, playerCache, claimDespawnEntry, requeueDespawnEntry, MAX_BUFFER_BACKPRESSURE, sendPacket, packetManager, forgetLook }: any) {
${source.slice(despawnFrom, despawnTo)}
return flushDespawnBatches;
}`,
)}
return make;`)() as (given: Record<string, any>) => () => void;

const animFrom = source.indexOf("export async function sendAnimationTo(");
const animTo = source.indexOf("function scheduleLightning(");
expect(animFrom).toBeGreaterThan(0);
expect(animTo).toBeGreaterThan(animFrom);
const makeAnimTo = new Function(`"use strict";
${transpiler.transformSync(
  `function make({ entityById, useSpriteSheets, isSpriteSheetSystemAvailable, log, drawnEquipment, getPlayerSpriteSheetData, getMountSpriteUrl, sendPacketQueued, packetManager, noteLook, lookSignature, castingFish, fishing }: any) {
${source.slice(animFrom, animTo).replace(/^export /gm, "")}
return sendAnimationTo;
}`,
)}
return make;`)() as (given: Record<string, any>) => (...args: any[]) => Promise<void>;

test("a queued despawn clears the viewer's record of that player when it is sent, and no other", () => {
  const wt: any = { readyState: 1, bufferedAmount: 0 };
  const despawnBatchQueue = new Map<string, Set<string>>([["v", new Set(["a", "b"])]]);
  const sent: any[] = [];
  noteLook(wt, "a", "x");
  noteLook(wt, "b", "x");
  noteLook(wt, "c", "x");
  const flush = makeDespawn({
    despawnBatchQueue,
    playerCache: { list: () => ({ v: { wt } }) },
    claimDespawnEntry: (queue: Map<string, Set<string>>, id: string) => { const e = queue.get(id); queue.delete(id); return e; },
    requeueDespawnEntry: () => {},
    MAX_BUFFER_BACKPRESSURE: 1e9,
    sendPacket: (_wt: any, packets: any) => { sent.push(packets); return true; },
    packetManager: { batchDisconnectPlayer: (data: any) => data },
    forgetLook,
  });
  flush();
  expect(sent.length).toBe(1);
  expect(holdsLook(wt, "a", "x")).toBe(false);
  expect(holdsLook(wt, "b", "x")).toBe(false);
  expect(holdsLook(wt, "c", "x")).toBe(true);
});

function animationWorld(opts: { drop?: boolean; available?: boolean } = {}) {
  const wt: any = { readyState: 1 };
  const player: any = { id: "7", mounted: false, mount_type: "", equipment: null, wt: null };
  const sent: any[] = [];
  const send = makeAnimTo({
    entityById: () => player,
    useSpriteSheets: true,
    isSpriteSheetSystemAvailable: async () => opts.available !== false,
    log: { warn: () => {}, debug: () => {} },
    drawnEquipment: () => null,
    getPlayerSpriteSheetData: async (animation: string) => ({ bodySprite: sheetOf("body"), headSprite: sheetOf("head"), animationState: animation }),
    getMountSpriteUrl: (type: string) => sheetOf(`mount_${type}`),
    sendPacketQueued: (_wt: any, packets: any) => { sent.push(packets); return !opts.drop; },
    packetManager: { spriteSheetAnimation: (data: any) => data, fishing: (data: any) => data },
    noteLook, lookSignature,
    castingFish: () => false,
    fishing: { session: () => undefined },
  });
  return { wt, player, sent, send };
}

test("sendAnimationTo records the sheets it sent", async () => {
  const w = animationWorld();
  await w.send(w.wt, "walk_down", "7", 1);
  expect(w.sent.length).toBe(1);
  expect(holdsLook(w.wt, "7", looksOf("body"))).toBe(true);
  // A look with a mount is another look.
  w.player.mounted = true;
  w.player.mount_type = "horse";
  await w.send(w.wt, "walk_down", "7", 2);
  expect(holdsLook(w.wt, "7", looksOf("body"))).toBe(false);
  expect(holdsLook(w.wt, "7", lookSignature({ mountSprite: sheetOf("mount_horse"), bodySprite: sheetOf("body"), headSprite: sheetOf("head") }))).toBe(true);
});

test("sendAnimationTo records nothing for a dropped packet or when it sent nothing", async () => {
  const dropped = animationWorld({ drop: true });
  await dropped.send(dropped.wt, "walk_down", "7", 1);
  expect(holdsLook(dropped.wt, "7", looksOf("body"))).toBe(false);
  const none = animationWorld({ available: false });
  await none.send(none.wt, "walk_down", "7", 1);
  expect(none.sent.length).toBe(0);
  expect(holdsLook(none.wt, "7", looksOf("body"))).toBe(false);
});
