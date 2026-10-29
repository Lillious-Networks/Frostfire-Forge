import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { BLOCK_MOVE_TIMEOUT_MS, MOVE_PROBE_MAX_MS, MOVE_PROBE_TIMEOUT_MS, probeDeadlineMs, BlockMoveOrders, BlockMover, DECIDE_FOR_MS, DECIDE_RETRY_MS, HELD_ASK_TIMEOUT_MS, UNDECIDED_HOLD_MS, type EndedOrder, type MoveEnd } from "../cluster/blockmove";
import type { BlockMove, BlockPart } from "../cluster/blockparts";
import { BlockTable, blockKey, type BlockOwner, type MapBlocks } from "../cluster/blocks";
import { ClusterBus } from "../cluster/bus";
import { Coordinator, LOCK_KEY, MOVE_SEND_TIMEOUT_MS, deadKey, MOVE_START_TIMEOUT_MS, ORDER_KEEP_MS } from "../cluster/coordinator";
import { LinkCalls, MAX_CALL_BODY_BYTES } from "../cluster/linkcalls";
import { MapCatalogue, extentOf } from "../cluster/maps";
import { MemoryStore } from "../cluster/memorystore";
import { MOVES_KEY, moveKey, type MoveOrder, type MoveState } from "../cluster/moveorders";
import { NodeRegistry, type NodeInfo } from "../cluster/nodes";
import log from "../modules/logger";
import { linkPair, settle } from "./cluster-fakelink";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

const T0 = new Date("2026-10-21T12:00:00Z").getTime();
let clock = T0;
const advance = (ms: number) => {
  clock += ms;
  setSystemTime(new Date(clock));
};

const quiet: Array<{ mockRestore(): void }> = [];
const cleanups: Array<() => void> = [];
let errorLines: string[] = [];
let warnLines: string[] = [];
beforeEach(() => {
  clock = T0;
  setSystemTime(new Date(clock));
  errorLines = [];
  warnLines = [];
  quiet.push(
    spyOn(log, "success").mockImplementation(() => {}),
    spyOn(log, "info").mockImplementation(() => {}),
    spyOn(log, "warn").mockImplementation((...args: unknown[]) => { warnLines.push(args.map(String).join(" ")); }),
    spyOn(log, "error").mockImplementation((...args: unknown[]) => { errorLines.push(args.map(String).join(" ")); }),
  );
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setSystemTime();
  for (const spy of quiet.splice(0)) spy.mockRestore();
});

// ---- fake parts: each node writes what its parts did into its ledger

interface Ledger {
  collected: string[];
  restored: string[];
  sent: string[];
  lost: string[];
  lostAborted: Array<{ part: string; data: unknown }>;
  accepted: Array<{ part: string; block: string; data: unknown; from: string }>;
  /** The `forMs` of each hold the part was told. */
  held: number[];
}
const ledger = (): Ledger => ({ collected: [], restored: [], sent: [], lost: [], lostAborted: [], accepted: [], held: [] });

interface Hooks { failCollect?: boolean; failAccept?: boolean; onAccept?: () => void; onCollect?: (move: BlockMove) => Promise<void> }

function fakePart(name: string, order: number, l: Ledger, data: unknown, hooks: Hooks = {}): BlockPart<unknown> {
  return {
    name,
    order,
    collect: async (move: BlockMove) => {
      if (hooks.failCollect) throw new Error(`${name} could not be read`);
      l.collected.push(name);
      await hooks.onCollect?.(move);
      return data;
    },
    restore: () => { l.restored.push(name); },
    accept: (move: BlockMove, got: unknown, from: string) => {
      if (hooks.failAccept) throw new Error(`${name} refused`);
      l.accepted.push({ part: name, block: `${move.bx},${move.by}`, data: got, from });
      hooks.onAccept?.();
    },
    sent: () => { l.sent.push(name); },
    hold: (_move: BlockMove, _got: unknown, forMs: number) => { l.held.push(forMs); },
    lost: () => { l.lost.push(name); },
    lostAborted: (_move: BlockMove, got: unknown) => { l.lostAborted.push({ part: name, data: got }); },
  };
}
const standard = (l: Ledger) => [fakePart("slots", 0, l, [1, 2]), fakePart("objects", 1, l, { loot: 3 })];

// ---- two movers, a (the old owner) and b (the new owner), on one link pair

const HELD: BlockOwner = { nodeId: "a", epoch: 7, since: T0 - 60_000 };

interface MoverOptions {
  ownerOf?: (map: string, bx: number, by: number) => BlockOwner | null;
  partsA?: (l: Ledger) => Array<BlockPart<unknown>>;
  partsB?: (l: Ledger) => Array<BlockPart<unknown>>;
  /** Whether the new owner b may own blocks now (not fenced, its lease valid, its run not taken). */
  canOwnB?: () => boolean;
  /** Both links carry frames again at the old owner's first retry wait (a link that came back). */
  unblockOnSleep?: boolean;
  /** The new owner's announced run and the run its tombstone names, as the old owner reads them. */
  runOf?: (nodeId: string) => Promise<number | null>;
  buriedRun?: (nodeId: string) => Promise<number | null>;
  /** How long the old owner holds what it cannot decide, past its deadline. 0 unless a test asks: the old deadline. */
  undecidedHoldMs?: number;
  /** Both links carry frames again once the clock has passed this time (a lagging node that caught up). */
  unblockAtMs?: number;
  /** Runs at each retry wait of the old owner. */
  onSleep?: () => void | Promise<void>;
  /** The old owner's own event-loop lag, in ms (its load report's lagMs). */
  lagA?: number;
}

function movers(orders: BlockMoveOrders, opts: MoverOptions = {}) {
  const { a: linkA, b: linkB } = linkPair();
  const callsA = new LinkCalls();
  const callsB = new LinkCalls();
  callsA.attach(linkA);
  callsB.attach(linkB);
  const A = ledger();
  const B = ledger();
  const make = (self: string, calls: LinkCalls, l: Ledger, parts: (l: Ledger) => Array<BlockPart<unknown>>) =>
    new BlockMover({
      self,
      orders,
      calls,
      ownerOf: opts.ownerOf ?? (() => HELD),
      ...(self === "b" && opts.canOwnB ? { canOwn: opts.canOwnB } : {}),
      ...(opts.runOf ? { runOf: opts.runOf } : {}),
      ...(opts.buriedRun ? { buriedRun: opts.buriedRun } : {}),
      parts: () => parts(l),
      timeoutMs: 50,
      askTimeoutMs: 50,
      probeTimeoutMs: 50,
      ...(self === "a" && opts.lagA !== undefined ? { lagMs: () => opts.lagA! } : {}),
      retryMs: 1_000,
      decideForMs: 10_000,
      undecidedHoldMs: opts.undecidedHoldMs ?? 0,
      now: () => clock,
      // The retry wait moves the clock on instead of waiting.
      sleep: async (ms) => {
        await opts.onSleep?.();
        if (opts.unblockOnSleep || (opts.unblockAtMs !== undefined && clock >= opts.unblockAtMs)) {
          linkA.blackhole = false;
          linkB.blackhole = false;
        }
        advance(ms);
        await settle();
      },
    });
  const a = make("a", callsA, A, opts.partsA ?? standard);
  const b = make("b", callsB, B, opts.partsB ?? standard);
  const stops = [a.start(), b.start()];
  const stop = () => {
    for (const off of stops) off();
    callsA.detach();
    callsB.detach();
  };
  cleanups.push(stop);
  return { a, b, A, B, linkA, linkB, callsA, callsB, stop };
}

function pair(opts: MoverOptions = {}) {
  const store = new MemoryStore();
  const orders = new BlockMoveOrders(store, () => clock);
  const order = (from = "a", to = "b") => orders.create({ map: "main", bx: 1, by: 0, from, to, blockEpoch: 7 });
  return { store, orders, order, ...movers(orders, opts) };
}

const stateOf = async (orders: BlockMoveOrders, id: string) => (await orders.get(id))?.state ?? null;

// ---- the old owner and the new owner

test("an order carried out: collected in order, taken in in order on the new owner, then sent; nothing put back", async () => {
  const p = pair();
  const o = await p.order();
  expect(await p.a.run(o.id)).toBe("sent");
  expect(p.A.collected).toEqual(["slots", "objects"]);
  expect(p.B.accepted).toEqual([
    { part: "slots", block: "1,0", data: [1, 2], from: "a" },
    { part: "objects", block: "1,0", data: { loot: 3 }, from: "a" },
  ]);
  expect(p.A.sent).toEqual(["slots", "objects"]);
  expect(p.A.restored).toEqual([]);
  expect(await stateOf(p.orders, o.id)).toBe("sent");
});

test("one order runs once: a second block-move for it while it runs does nothing", async () => {
  const p = pair();
  const o = await p.order();
  const ends = await Promise.all([p.a.run(o.id), p.a.run(o.id)]);
  expect(ends.sort()).toEqual(["sent", "skipped"]);
  expect(p.A.collected).toEqual(["slots", "objects"]);
  expect(p.B.accepted).toHaveLength(2);
  expect(await stateOf(p.orders, o.id)).toBe("sent");
});

test("one outgoing move at a time: a second order for the old owner while one runs is aborted, with nothing collected", async () => {
  // The link comes back at the first retry: b says it never took the first order in, and the parts go back.
  const p = pair({ unblockOnSleep: true });
  const first = await p.order();
  const second = await p.order();
  // The first call never reaches b: it waits for its answer.
  p.linkA.blackhole = true;
  const running = p.a.run(first.id);
  await settle();
  // A second block-move for the running order does nothing, and leaves the first's claim in place.
  expect(await p.a.run(first.id)).toBe("skipped");
  // Guard: one outgoing move per node. A stale leader may have written a second order for this node.
  expect(await p.a.run(second.id)).toBe("skipped");
  expect(await stateOf(p.orders, second.id)).toBe("aborted");
  // The abort says the old owner was busy, so the coordinator does not count it against the block.
  expect((await p.orders.get(second.id) as any).reason).toBe("busy");
  expect(p.A.collected).toEqual(["slots", "objects"]);
  expect(await running).toBe("restored");
  // Once the first has ended, the node takes an order again.
  p.linkA.blackhole = false;
  const third = await p.order();
  expect(await p.a.run(third.id)).toBe("sent");
});

test("an order the coordinator aborts while the old owner reads it is not started", async () => {
  const store = new MemoryStore();
  const orders = new BlockMoveOrders(store, () => clock);
  const o = await orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 7 });
  const l = ledger();
  const racing = {
    get: async (id: string) => {
      const read = await orders.get(id);
      // The coordinator's start timeout lands right after the old owner read the order.
      await orders.swap(id, "ordered", "aborted");
      return read;
    },
    swap: (id: string, from: MoveState, to: MoveState) => orders.swap(id, from, to),
    swapWith: orders.swapWith.bind(orders),
    advanceToSent: orders.advanceToSent.bind(orders),
    all: () => orders.all(),
  };
  const mover = new BlockMover({ self: "a", orders: racing, calls: new LinkCalls(), ownerOf: () => HELD, parts: () => standard(l) });
  // Guard: the start is one swap ordered -> sending. A read followed by a write would start an aborted order.
  expect(await mover.run(o.id)).toBe("skipped");
  expect(l.collected).toEqual([]);
  expect(await stateOf(orders, o.id)).toBe("aborted");
});

test("an order for a block this node does not hold at the order's epoch is aborted, with nothing collected", async () => {
  for (const held of [{ ...HELD, epoch: 8 }, { ...HELD, nodeId: "b" }, null]) {
    const p = pair({ ownerOf: () => held });
    const o = await p.order();
    // Guard: the owner check. The table moved on since the order (a takeover, or another order), or it was never ours.
    expect(await p.a.run(o.id)).toBe("skipped");
    expect(p.A.collected).toEqual([]);
    expect(p.B.accepted).toEqual([]);
    // Aborted straight from ordered: the order was never started.
    expect(await p.orders.get(o.id)).toMatchObject({ state: "aborted", epoch: o.epoch + 1 });
  }
});

test("a block that leaves the old owner while the order starts is not sent: the order is aborted at sending, with nothing collected", async () => {
  let reads = 0;
  // The table changes (a takeover) while the start swap is written: the second read sees the new epoch.
  const p = pair({ ownerOf: () => (reads++ === 0 ? HELD : { ...HELD, epoch: 9 }) });
  const o = await p.order();
  // Guard: the owner check again at sending.
  expect(await p.a.run(o.id)).toBe("skipped");
  expect(reads).toBe(2);
  expect(p.A.collected).toEqual([]);
  expect(p.B.accepted).toEqual([]);
  expect(await stateOf(p.orders, o.id)).toBe("aborted");
});

test("an order that names another old owner is left alone", async () => {
  const p = pair();
  const o = await p.order("c", "b");
  expect(await p.a.run(o.id)).toBe("skipped");
  expect(p.A.collected).toEqual([]);
  expect(await stateOf(p.orders, o.id)).toBe("ordered");
});

test("a new owner that cannot be reached gets nothing, and the state is put back in reverse order", async () => {
  // The link is up for the probe and goes down while the parts are collected: the call never runs.
  let p!: ReturnType<typeof pair>;
  p = pair({ partsA: (l) => [fakePart("slots", 0, l, [1, 2]), fakePart("objects", 1, l, { loot: 3 }, { onCollect: async () => { p.linkA.setUp(false); } })] });
  const o = await p.order();
  expect(await p.a.run(o.id)).toBe("restored");
  expect(p.A.restored).toEqual(["objects", "slots"]);
  expect(p.A.sent).toEqual([]);
  expect(p.B.accepted).toEqual([]);
  expect(await stateOf(p.orders, o.id)).toBe("aborted");
});

test("a call that timed out: the old owner aborts the order before it puts anything back, and the late call is refused", async () => {
  // The link comes back at the first retry: b says it never took the order in.
  const p = pair({ unblockOnSleep: true });
  const o = await p.order();
  // The call never reaches b.
  p.linkA.blackhole = true;
  expect(await p.a.run(o.id)).toBe("restored");
  expect(p.A.restored).toEqual(["objects", "slots"]);
  expect(await stateOf(p.orders, o.id)).toBe("aborted");
  // The call arrives after all. Guard: the abort swap came first, so b cannot take the order.
  const late = { order: (await p.orders.get(o.id))!, parts: { slots: [1, 2], objects: { loot: 3 } } };
  expect(await p.b.accept(late, "a")).toEqual({ ok: false, reason: "the order is aborted" });
  expect(p.B.accepted).toEqual([]);
});

test("a lost answer after the new owner took the order puts nothing back", async () => {
  const p = pair();
  const o = await p.order();
  // b runs the call; its answer is lost.
  p.linkB.blackhole = true;
  // Guard: the read-back. The swap to aborted fails, the order says sent: the parts are on b.
  expect(await p.a.run(o.id)).toBe("sent");
  expect(p.A.restored).toEqual([]);
  expect(p.A.sent).toEqual(["slots", "objects"]);
  expect(p.B.accepted).toHaveLength(2);
  expect(await stateOf(p.orders, o.id)).toBe("sent");
  // The block is given away as on a confirmed send (task 20 review I1).
  expect(p.a.givenAway("main", 1, 0)).toBe(true);
});

test("a block too big for one call ends too-big: it is put back, and the order is closed with that reason", async () => {
  const huge = "x".repeat(MAX_CALL_BODY_BYTES + 16);
  const p = pair({ partsA: (l) => [fakePart("slots", 0, l, [1, 2]), fakePart("objects", 1, l, { loot: huge })] });
  const o = await p.order();
  // Guard: preflight D11. The reason is written with the abort, so the coordinator leaves the block alone.
  expect(await p.a.run(o.id)).toBe("too-big");
  expect(p.A.restored).toEqual(["objects", "slots"]);
  expect(p.A.sent).toEqual([]);
  expect(p.B.accepted).toEqual([]);
  const stored = (await p.orders.get(o.id)) as EndedOrder;
  expect(stored.state).toBe("aborted");
  expect(stored.reason).toBe("too-big");
  expect(warnLines.some((line) => line.includes("slots, objects") && line.includes("bytes"))).toBe(true);
});

test("the new owner takes a block only from the order's old owner, and only if the order names it", async () => {
  const p = pair();
  const o = await p.order();
  const sending = (await p.orders.swap(o.id, "ordered", "sending"))!;
  const body = { order: sending, parts: { slots: [1, 2] } };
  // Guard: the caller must be the order's from.
  expect(await p.b.accept(body, "c")).toEqual({ ok: false, reason: "not this pair" });
  // Guard: the order must name this node as to.
  expect(await p.a.accept(body, "a")).toEqual({ ok: false, reason: "not this pair" });
  expect(p.B.accepted).toEqual([]);
  expect(p.A.accepted).toEqual([]);
  expect(await stateOf(p.orders, o.id)).toBe("sending");
});

test("the new owner moves the stored order's block, not the one the body names", async () => {
  const p = pair();
  const o = await p.order();
  const sending = (await p.orders.swap(o.id, "ordered", "sending"))!;
  const forged: MoveOrder = { ...sending, bx: 9, by: 9 };
  expect(await p.b.accept({ order: forged, parts: { slots: [1, 2] } }, "a")).toEqual({ ok: true });
  // Guard: the stored order. The body's block is only what the sender says.
  expect(p.B.accepted).toEqual([{ part: "slots", block: "1,0", data: [1, 2], from: "a" }]);
});

test("two calls for one order at once take the parts in once", async () => {
  const p = pair();
  const o = await p.order();
  const sending = (await p.orders.swap(o.id, "ordered", "sending"))!;
  const body = { order: sending, parts: { slots: [1, 2], objects: { loot: 3 } } };
  // Both read "sending" before either writes. Guard: the take is one swap, so only one of them takes the parts in.
  const answers = await Promise.all([p.b.accept(body, "a"), p.b.accept(body, "a")]);
  expect(answers).toEqual([{ ok: true }, { ok: true }]);
  expect(p.B.accepted.map((entry) => entry.part)).toEqual(["slots", "objects"]);
  // A call sent again once it ran answers ok, and takes nothing in.
  expect(await p.b.accept(body, "a")).toEqual({ ok: true });
  expect(p.B.accepted).toHaveLength(2);
});

test("an order that is not sending is refused, and nothing is taken in", async () => {
  const p = pair();
  const o = await p.order();
  const body = { order: o, parts: { slots: [1, 2] } };
  expect(await p.b.accept(body, "a")).toEqual({ ok: false, reason: "the order is ordered" });
  await p.orders.swap(o.id, "ordered", "aborted");
  expect(await p.b.accept(body, "a")).toEqual({ ok: false, reason: "the order is aborted" });
  expect(await p.b.accept({ order: { ...o, id: "nope" }, parts: {} }, "a")).toEqual({ ok: false, reason: "no such order" });
  expect(await p.b.accept({ order: o }, "a")).toEqual({ ok: false, reason: "malformed" });
  expect(p.B.accepted).toEqual([]);
});

test("a part that fails to collect: the parts collected before it are put back, and the order is aborted", async () => {
  const p = pair({ partsA: (l) => [fakePart("slots", 0, l, [1, 2]), fakePart("objects", 1, l, { loot: 3 }, { failCollect: true })] });
  const o = await p.order();
  // Guard: a failed collect closes the order, which puts back what was collected.
  expect(await p.a.run(o.id)).toBe("restored");
  expect(p.A.collected).toEqual(["slots"]);
  expect(p.A.restored).toEqual(["slots"]);
  expect(p.B.accepted).toEqual([]);
  expect(await stateOf(p.orders, o.id)).toBe("aborted");
});

test("a part the new owner cannot take in, or does not know, is logged by name; the others are taken in", async () => {
  const p = pair({ partsB: (l) => [fakePart("slots", 0, l, [1, 2], { failAccept: true }), fakePart("objects", 1, l, { loot: 3 })] });
  const o = await p.order();
  expect(await p.a.run(o.id)).toBe("sent");
  expect(p.B.accepted.map((entry) => entry.part)).toEqual(["objects"]);
  expect(errorLines.some((line) => line.includes("slots"))).toBe(true);

  const other = await p.order();
  const sending = (await p.orders.swap(other.id, "ordered", "sending"))!;
  expect(await p.b.accept({ order: sending, parts: { mystery: 1 } }, "a")).toEqual({ ok: true });
  expect(errorLines.some((line) => line.includes("mystery"))).toBe(true);
});

test("while the order cannot be read, the old owner holds the parts and decides once it can", async () => {
  let failures = 0;
  const p = pair({
    // Once b has taken the parts in, the store fails the next two reads.
    partsB: (l) => [fakePart("slots", 0, l, [1, 2]), fakePart("objects", 1, l, { loot: 3 }, { onAccept: () => { failures = 2; } })],
  });
  const real = p.store.get.bind(p.store);
  const reads = spyOn(p.store, "get").mockImplementation(async (key: string) => {
    if (failures > 0) {
      failures--;
      throw new Error("the cluster store is down");
    }
    return real(key);
  });
  try {
    const o = await p.order();
    p.linkB.blackhole = true;
    const before = clock;
    // Guard: a failed read holds the parts. Putting them back on a guess would copy what b took in.
    expect(await p.a.run(o.id)).toBe("sent");
    expect(p.A.restored).toEqual([]);
    expect(p.A.sent).toEqual(["slots", "objects"]);
    expect(clock - before).toBe(2_000);
  } finally {
    reads.mockRestore();
  }
});

test("an order that cannot be read until the deadline: the parts are logged lost by name, and never put back", async () => {
  let down = false;
  const p = pair({ partsB: (l) => [fakePart("slots", 0, l, [1, 2]), fakePart("objects", 1, l, { loot: 3 }, { onAccept: () => { down = true; } })] });
  const real = p.store.get.bind(p.store);
  const reads = spyOn(p.store, "get").mockImplementation(async (key: string) => {
    if (down) throw new Error("the cluster store is down");
    return real(key);
  });
  try {
    const o = await p.order();
    p.linkB.blackhole = true;
    expect(await p.a.run(o.id)).toBe("lost");
    expect(p.A.restored).toEqual([]);
    expect(p.A.sent).toEqual([]);
    expect(errorLines.some((line) => line.includes("slots, objects"))).toBe(true);
    // Guard: lost (task 20 review I2). Each part drops what it still holds of the block: b may hold it.
    expect(p.A.lost).toEqual(["slots", "objects"]);
    // Guard: the block stays given away (I1). How the order ended is not known.
    expect(p.a.givenAway("main", 1, 0)).toBe(true);
  } finally {
    reads.mockRestore();
  }
});

test("the old owner's hold is counted from the start of the order, not from the end of the call", async () => {
  let down = false;
  const p = pair({
    partsB: (l) => [
      fakePart("slots", 0, l, [1, 2]),
      // The call takes 9 s of the 10.05 s the old owner may hold the parts (timeoutMs 50 + decideForMs 10 000).
      fakePart("objects", 1, l, { loot: 3 }, { onAccept: () => { advance(9_000); down = true; } }),
    ],
  });
  const real = p.store.get.bind(p.store);
  const reads = spyOn(p.store, "get").mockImplementation(async (key: string) => {
    if (down) throw new Error("the cluster store is down");
    return real(key);
  });
  try {
    const o = await p.order();
    p.linkB.blackhole = true;
    const before = clock;
    // Guard: the deadline (preflight C5). The spawner holds a moving block's slots for OUTGOING_KEEP_MS from the
    // collect; a deadline counted from the end of the call would hold the parts past it.
    expect(await p.a.run(o.id)).toBe("lost");
    expect(clock - before).toBe(11_000);
  } finally {
    reads.mockRestore();
  }
});

test("an order the coordinator aborted while the call went unanswered: everything is put back in reverse, and nothing is sent", async () => {
  const p = pair({
    partsA: (l) => [
      fakePart("slots", 0, l, [1, 2]),
      // The coordinator's send timeout lands while the old owner still collects: its own abort swap then fails.
      fakePart("objects", 1, l, { loot: 3 }, { onCollect: async (move) => { await p.orders.swap(move.id, "sending", "aborted"); } }),
    ],
    // The link comes back at the first retry: b says it never took the order in.
    unblockOnSleep: true,
  });
  const o = await p.order();
  p.linkA.blackhole = true;
  // Guard: the read-back (task 20 review I3). Only an order read back aborted is put back; sent or done is finished.
  expect(await p.a.run(o.id)).toBe("restored");
  expect(p.A.restored).toEqual(["objects", "slots"]);
  expect(p.A.sent).toEqual([]);
  expect(p.B.accepted).toEqual([]);
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
  expect(await stateOf(p.orders, o.id)).toBe("aborted");
});

test("a block sent stays given away past the spawner's 60 s, until the old owner's table shows it at a higher epoch", async () => {
  let view: BlockOwner | null = HELD;
  const p = pair({ ownerOf: () => view });
  const o = await p.order();
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
  expect(await p.a.run(o.id)).toBe("sent");
  expect(p.a.givenAway("main", 1, 0)).toBe(true);
  expect(p.a.givenAway("main.json", 1, 0)).toBe(true);
  expect(p.a.givenAway("main", 0, 0)).toBe(false);
  // Guard: the hold is tied to the table, not to a timer (task 20 review I1). The commit may come late.
  advance(61_000);
  expect(p.a.givenAway("main", 1, 0)).toBe(true);
  // Another owner at the order's epoch, or no owner, does not end it: only a later table write does.
  view = { ...HELD, nodeId: "b" };
  expect(p.a.givenAway("main", 1, 0)).toBe(true);
  view = null;
  expect(p.a.givenAway("main", 1, 0)).toBe(true);
  // The commit, as this node's table reads it: b at a higher epoch.
  view = { nodeId: "b", epoch: 8, since: clock };
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
  // Once released it stays released.
  view = HELD;
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
});

test("a block given away is released when the old owner's table shows it back on the old owner at a higher epoch (a refill)", async () => {
  let view: BlockOwner | null = HELD;
  const p = pair({ ownerOf: () => view });
  const o = await p.order();
  expect(await p.a.run(o.id)).toBe("sent");
  // b was committed and taken over at once; this node's cache missed b's version and reads the refill to itself.
  view = { ...HELD, epoch: 7 };
  expect(p.a.givenAway("main", 1, 0)).toBe(true);
  // Guard: any owner at a higher epoch ends it (task 20 re-review Q2). A rule that wants another owner keeps the
  // block empty for good here.
  view = { nodeId: "a", epoch: 9, since: clock };
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
});

test("a block given back to the old owner later is released once it takes the block in", async () => {
  let view: BlockOwner | null = HELD;
  const p = pair({ ownerOf: () => view });
  const o = await p.order();
  expect(await p.a.run(o.id)).toBe("sent");
  // b sends the block back at epoch 8. a's table names b at 8 as the take lands.
  view = { nodeId: "b", epoch: 8, since: clock };
  const back = await p.orders.create({ map: "main", bx: 1, by: 0, from: "b", to: "a", blockEpoch: 8 });
  const sending = (await p.orders.swap(back.id, "ordered", "sending"))!;
  expect(await p.a.accept({ order: sending, parts: { slots: [1, 2] } }, "b")).toEqual({ ok: true });
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
  // a's table then names a at 9: the block stays a's, and a spawns there.
  view = { nodeId: "a", epoch: 9, since: clock };
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
});

test("a block lost at the deadline is released once its order is read back aborted", async () => {
  let down = false;
  const p = pair();
  const real = p.store.get.bind(p.store);
  const reads = spyOn(p.store, "get").mockImplementation(async (key: string) => {
    if (down) throw new Error("the cluster store is down");
    return real(key);
  });
  try {
    const o = await p.order();
    // The call never reaches b, and the store goes down as it is sent.
    p.linkA.blackhole = true;
    const run = p.a.run(o.id);
    await settle();
    down = true;
    expect(await run).toBe("lost");
    expect(p.a.givenAway("main", 1, 0)).toBe(true);
    // The store and the link are back; the coordinator aborted the order meanwhile.
    down = false;
    p.linkA.blackhole = false;
    await p.orders.swap(o.id, "sending", "aborted");
    // A store that cannot be read changes nothing.
    down = true;
    await p.a.review();
    expect(p.a.givenAway("main", 1, 0)).toBe(true);
    expect(p.A.lostAborted).toEqual([]);
    down = false;
    // Guard: the abort ends it (task 20 review I1): b never took the block in.
    await p.a.review();
    expect(p.a.givenAway("main", 1, 0)).toBe(false);
    // Guard: lostAborted (task 20 re-review N1). The parts put back what other nodes still hold of the block, in
    // reverse, with the data collect took; else the old owner spawns slots whose creatures other nodes hold.
    expect(p.A.lostAborted).toEqual([{ part: "objects", data: { loot: 3 } }, { part: "slots", data: [1, 2] }]);
    // Once only.
    await p.a.review();
    expect(p.A.lostAborted).toHaveLength(2);
    expect(p.A.restored).toEqual([]);
  } finally {
    reads.mockRestore();
  }
});

test("a new order for a block still given away is aborted with nothing taken out, so a lost move's data stays for its abort", async () => {
  let down = false;
  const p = pair();
  const real = p.store.get.bind(p.store);
  const reads = spyOn(p.store, "get").mockImplementation(async (key: string) => {
    if (down) throw new Error("the cluster store is down");
    return real(key);
  });
  try {
    const first = await p.order();
    p.linkA.blackhole = true;
    const run = p.a.run(first.id);
    await settle();
    down = true;
    expect(await run).toBe("lost");
    down = false;
    p.linkA.blackhole = false;
    // The coordinator aborts the lost order and orders the block again before this node reviews it.
    await p.orders.swap(first.id, "sending", "aborted");
    const second = await p.order();
    // Guard: run refuses a block still given away (task 20 fix round 3). Without it the second export replaces the
    // lost move's data, and its abort puts back nothing other nodes hold.
    expect(await p.a.run(second.id)).toBe("skipped");
    expect(await stateOf(p.orders, second.id)).toBe("aborted");
    expect((await p.orders.get(second.id) as any).reason).toBe("held");
    expect(p.A.collected).toEqual(["slots", "objects"]);
    expect(p.B.accepted).toEqual([]);
    expect(p.a.givenAway("main", 1, 0)).toBe(true);
    // The review puts back the first move's data, once, and the block may move again.
    await p.a.review();
    expect(p.A.lostAborted).toEqual([{ part: "objects", data: { loot: 3 } }, { part: "slots", data: [1, 2] }]);
    const third = await p.order();
    expect(await p.a.run(third.id)).toBe("sent");
  } finally {
    reads.mockRestore();
  }
});

test("at boot, the blocks of open orders that name this node as the old owner are given away until the orders close", async () => {
  const store = new MemoryStore();
  const orders = new BlockMoveOrders(store, () => clock);
  const make = (bx: number, from = "a") => orders.create({ map: "main", bx, by: 0, from, to: "b", blockEpoch: 7 });
  const sending = await make(1);
  await orders.swap(sending.id, "ordered", "sending");
  const sent = await make(2);
  await orders.swap(sent.id, "ordered", "sending");
  await orders.swap(sent.id, "sending", "sent");
  const aborted = await make(3);
  await orders.swap(aborted.id, "ordered", "aborted");
  await make(4, "c");
  const rolledBack = await make(5);
  await orders.swap(rolledBack.id, "ordered", "sending");
  // b's answers to BLOCK_MOVE_HELD, by order: none yet (its take under way).
  const held = new Map<string, boolean | null>();
  const asked: string[] = [];
  const calls = {
    call: async <T>(_peer: string, name: string, body: unknown) => {
      const id = (body as { id: string }).id;
      asked.push(`${name} ${id}`);
      return { ok: true as const, answer: { held: held.get(id) ?? null } as T };
    },
    handle: () => () => {},
  };
  const mover = new BlockMover({ self: "a", orders, calls, ownerOf: () => HELD, parts: () => [] });
  // Guard: the seed (task 20 review I1, P3). A restarted old owner whose table still names it must not spawn a
  // block whose slots the new owner may hold.
  expect(await mover.seed()).toBe(3);
  expect([1, 2, 3, 4, 5].map((bx) => mover.givenAway("main", bx, 0))).toEqual([true, true, false, false, true]);
  await orders.swap(sending.id, "sending", "aborted");
  await orders.swap(rolledBack.id, "sending", "aborted");
  // Guard (secfix A round 1): the last run may have sent the parts. Until b says it did not take the order in, the
  // block stays given away; an aborted record may be an earlier revision written back.
  await mover.review();
  expect(asked.sort()).toEqual([`BLOCK_MOVE_HELD ${rolledBack.id}`, `BLOCK_MOVE_HELD ${sending.id}`].sort());
  expect([1, 2, 5].map((bx) => mover.givenAway("main", bx, 0))).toEqual([true, true, true]);
  held.set(sending.id, false);
  held.set(rolledBack.id, true);
  await mover.review();
  expect([1, 2, 5].map((bx) => mover.givenAway("main", bx, 0))).toEqual([false, true, true]);
  // Guard (secfix A round 2): the order b holds is written forward from the rolled-back abort, so it is committed.
  expect((await orders.get(rolledBack.id))?.state).toBe("sent");
  expect((await orders.get(sending.id))?.state).toBe("aborted");
});

test("a block whose order is gone stays given away: only the table or an abort ends it", async () => {
  const p = pair();
  const o = await p.order();
  expect(await p.a.run(o.id)).toBe("sent");
  // The coordinator committed the block and removed the closed order; this node's cache still names itself.
  await p.orders.swap(o.id, "sent", "done");
  await p.orders.remove(o.id);
  expect(await p.orders.get(o.id)).toBeNull();
  await p.a.review();
  // Guard: a gone order changes nothing (task 20 re-review N2). Released, this node spawns slots b holds.
  expect(p.a.givenAway("main", 1, 0)).toBe(true);
});

test("a lost block the table moved on is released with nothing put back", async () => {
  let view: BlockOwner | null = HELD;
  const p = pair({ ownerOf: () => view });
  const o = await p.order();
  p.linkA.blackhole = true;
  let down = false;
  const real = p.store.get.bind(p.store);
  const reads = spyOn(p.store, "get").mockImplementation(async (key: string) => {
    if (down) throw new Error("the cluster store is down");
    return real(key);
  });
  try {
    const run = p.a.run(o.id);
    await settle();
    down = true;
    expect(await run).toBe("lost");
  } finally {
    reads.mockRestore();
  }
  // b took the block in and the commit reached this node's table.
  view = { nodeId: "b", epoch: 8, since: clock };
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
  await p.orders.swap(o.id, "sending", "aborted");
  await p.a.review();
  // Guard: lostAborted belongs to the entry. Once the table released it, nothing of the block comes back here.
  expect(p.A.lostAborted).toEqual([]);
});

test("the new owner takes a block in only if its own table gives it to the old owner at the order's epoch", async () => {
  let view: BlockOwner | null = HELD;
  const p = pair({ ownerOf: () => view });
  const o = await p.order();
  const sending = (await p.orders.swap(o.id, "ordered", "sending"))!;
  const body = { order: sending, parts: { slots: [1, 2] } };
  // Guard: the new owner's own check (task 20 review M2). A block taken over since, or one its table does not know
  // at that epoch, would strand the parts here.
  for (const seen of [{ nodeId: "c", epoch: 8, since: T0 }, { ...HELD, epoch: 6 }, null]) {
    view = seen;
    expect((await p.b.accept(body, "a")).ok).toBe(false);
  }
  expect(p.B.accepted).toEqual([]);
  expect(await stateOf(p.orders, o.id)).toBe("sending");
  view = HELD;
  expect(await p.b.accept(body, "a")).toEqual({ ok: true });
  expect(p.B.accepted).toHaveLength(1);
});

test("a new owner that may not own blocks (fenced, its lease lapsed, or its run taken) takes nothing in", async () => {
  // Ownership I1: a node stalled past its takeover wakes up and handles a BLOCK_MOVE before its beat finds the
  // tombstone. Taken in, the block would be committed to a node the coordinator has forgotten.
  let mayOwn = false;
  const p = pair({ canOwnB: () => mayOwn });
  const o = await p.order();
  const sending = (await p.orders.swap(o.id, "ordered", "sending"))!;
  const body = { order: sending, parts: { slots: [1, 2] } };
  // Guard: canOwn in accept.
  expect(await p.b.accept(body, "a")).toEqual({ ok: false, reason: "this node may not own blocks now" });
  expect(p.B.accepted).toEqual([]);
  expect(await stateOf(p.orders, o.id)).toBe("sending");
  mayOwn = true;
  expect(await p.b.accept(body, "a")).toEqual({ ok: true });
  expect(p.B.accepted).toHaveLength(1);
  expect(await stateOf(p.orders, o.id)).toBe("sent");
});

// ---- secfix A round 1: an order record written back does not decide a put-back

test("a replayed sending revision: the old owner puts nothing back while the new owner holds the block", async () => {
  let key = "";
  let replay: string | null = null;
  const p = pair({
    // a reads the order as it starts: the sealed "sending" revision an attacker could keep.
    partsA: (l) => [fakePart("slots", 0, l, [1, 2]), fakePart("objects", 1, l, { loot: 3 }, {
      onCollect: async (move) => {
        key = moveKey(move.id);
        replay = await p.store.get(key);
      },
    })],
    // Once b has taken the order (sent), the earlier revision is written back over it.
    partsB: (l) => [fakePart("slots", 0, l, [1, 2]), fakePart("objects", 1, l, { loot: 3 }, { onAccept: () => { void p.store.set(key, replay!); } })],
    unblockOnSleep: true,
  });
  const o = await p.order();
  // b's answers are lost until a's first retry wait.
  p.linkB.blackhole = true;
  // Guard: the question before a put-back. a's abort lands on the written-back revision; b says it took the order in.
  expect(await p.a.run(o.id)).toBe("sent");
  expect(p.B.accepted).toHaveLength(2);
  expect(p.A.restored).toEqual([]);
  expect(p.A.sent).toEqual(["slots", "objects"]);
  // Guard (secfix A round 2): the rolled-back order is written forward, so the coordinator commits b.
  expect(await stateOf(p.orders, o.id)).toBe("sent");
  expect(errorLines.some((line) => line.includes(o.id) && line.includes("rolled back"))).toBe(true);
  // The block stays given away, and a review of the aborted record does not take it back: b holds it.
  expect(p.a.givenAway("main", 1, 0)).toBe(true);
  await p.a.review();
  expect(p.a.givenAway("main", 1, 0)).toBe(true);
  expect(p.A.lostAborted).toEqual([]);
});

test("at boot, a block whose new owner is gone for good is taken back once the tombstone names the run announced at boot", async () => {
  const store = new MemoryStore();
  const orders = new BlockMoveOrders(store, () => clock);
  const o = await orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 7 });
  await orders.swap(o.id, "ordered", "sending");
  // b never answers: it is gone. Its tombstone names run 100, the run it announced when a restarted.
  const calls = {
    call: async <T>() => ({ ok: false as const, why: "timeout" as const }) as unknown as T,
    handle: () => () => {},
  };
  let dead: number | null = null;
  const mover = new BlockMover({
    self: "a", orders, calls: calls as any, ownerOf: () => HELD, parts: () => [],
    runOf: async () => 100,
    buriedRun: async () => dead,
  });
  expect(await mover.seed()).toBe(1);
  await orders.swap(o.id, "sending", "aborted");
  await mover.review();
  expect(mover.givenAway("main", 1, 0)).toBe(true);
  // Guard (secfix A round 2): the seed asks about the run announced at boot, so the tombstone of that run counts.
  dead = 100;
  await mover.review();
  expect(mover.givenAway("main", 1, 0)).toBe(false);
});

test("a rolled-back order the new owner holds is written forward: the coordinator commits it, and a restarted old owner does not serve the block", async () => {
  const c = await cluster();
  const tableA = new BlockTable(c.store);
  await tableA.load("main");
  const ownerOf = (table: BlockTable) => (map: string, bx: number, by: number) => table.ownersOf(map)[blockKey(bx, by)] ?? null;
  let key = "";
  let replay: string | null = null;
  const m = movers(c.orders, {
    ownerOf: ownerOf(tableA),
    partsA: (l) => [fakePart("slots", 0, l, [1, 2]), fakePart("objects", 1, l, { loot: 3 }, {
      onCollect: async (move) => {
        key = moveKey(move.id);
        replay = await c.store.get(key);
      },
    })],
    // Once b has taken the order (sent), the earlier "sending" revision is written back over it.
    partsB: (l) => [fakePart("slots", 0, l, [1, 2]), fakePart("objects", 1, l, { loot: 3 }, { onAccept: () => { void c.store.set(key, replay!); } })],
    unblockOnSleep: true,
  });
  const o = await c.orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 7 });
  m.linkB.blackhole = true;
  expect(await m.a.run(o.id)).toBe("sent");
  expect(m.A.restored).toEqual([]);
  // Guard (secfix A round 2): written forward from the abort that landed on the written-back revision.
  expect(await stateOf(c.orders, o.id)).toBe("sent");

  // A run of a restarted before the next pass: its table still names it, and its seed holds the block given away.
  const nobody = { call: async () => ({ ok: false, why: "timeout" }), handle: () => () => {} };
  const serves = (mover: BlockMover, table: BlockTable) => table.ownersOf("main")["1,0"]?.nodeId === "a" && !mover.givenAway("main", 1, 0);
  const restarted = new BlockMover({ self: "a", orders: c.orders, calls: nobody as any, ownerOf: ownerOf(tableA), parts: () => [] });
  await restarted.seed();
  expect(serves(restarted, tableA)).toBe(false);

  // The next pass commits b, as for any sent order. A run started after it reads the table.
  await c.pass();
  expect((await c.stored()).owners["1,0"]?.nodeId).toBe("b");
  expect(await stateOf(c.orders, o.id)).toBe("done");
  const tableLater = new BlockTable(c.store);
  await tableLater.load("main");
  const later = new BlockMover({ self: "a", orders: c.orders, calls: nobody as any, ownerOf: ownerOf(tableLater), parts: () => [] });
  await later.seed();
  expect(serves(later, tableLater)).toBe(false);
});

test("an order written forward to sent: over any revision, afresh and listed again when gone, never over a record it cannot read", async () => {
  const store = new MemoryStore();
  const orders = new BlockMoveOrders(store, () => clock);
  const o = await orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 7 });
  const sending = (await orders.swap(o.id, "ordered", "sending"))!;
  await orders.swap(o.id, "sending", "aborted");
  expect((await orders.advanceToSent(sending, { parts: ["slots"] }))?.state).toBe("sent");
  expect(await orders.get(o.id)).toMatchObject({ state: "sent", parts: ["slots"], epoch: 4 });
  // Already sent: nothing is written.
  expect((await orders.advanceToSent(sending, {}))?.epoch).toBe(4);
  // Gone (deleted, and taken off the list): guard (secfix A round 2), written afresh and listed, so it is committed.
  await orders.remove(o.id);
  expect((await orders.advanceToSent(sending, { parts: ["slots"] }))?.state).toBe("sent");
  expect((await orders.all()).map((order) => [order.id, order.state])).toEqual([[o.id, "sent"]]);
  // A record that does not read as an order (a seal that fails reads the same) is not written over.
  await store.set(moveKey(o.id), JSON.stringify({ epoch: 9 }));
  expect(await orders.advanceToSent(sending, {})).toBeNull();
  expect(await store.get(moveKey(o.id))).toBe(JSON.stringify({ epoch: 9 }));
});

test("a new owner that cannot answer: nothing is put back until the coordinator's tombstone names its run", async () => {
  // b announced run 100 before the call. Its tombstone, as the old owner reads it later, and its run announced then.
  const cases: Array<{ dead: number | null; now: number; end: MoveEnd }> = [
    { dead: null, now: 100, end: "lost" },
    // A tombstone of an earlier run (still kept, or written back) does not count.
    { dead: 99, now: 100, end: "lost" },
    // A later run announced since: the tombstone of run 100 does not cover what it may hold.
    { dead: 100, now: 101, end: "lost" },
    { dead: 100, now: 100, end: "restored" },
    { dead: 101, now: 101, end: "restored" },
  ];
  for (const { dead, now, end } of cases) {
    let announced = 100;
    const p = pair({ runOf: async () => announced, buriedRun: async () => dead });
    const o = await p.order();
    // Nothing reaches b, and nothing comes back. The run is read before the call; later reads give `now`.
    p.linkA.blackhole = true;
    const run = p.a.run(o.id);
    await settle();
    announced = now;
    // Guard (secfix A round 1): unanswered, only the tombstone of the run asked (or a later one) lets the parts back.
    expect({ dead, now, end: await run }).toEqual({ dead, now, end });
    expect(p.A.restored).toEqual(end === "restored" ? ["objects", "slots"] : []);
    expect(p.A.lost).toEqual(end === "lost" ? ["slots", "objects"] : []);
    p.stop();
  }
});

// ---- a new owner that is behind (the limit runs: run/limit/C-2125)

test("a new owner that answers only after the deadline: the old owner keeps holding, the block stays frozen, and everything is put back", async () => {
  const frozen: boolean[] = [];
  let p!: ReturnType<typeof pair>;
  p = pair({
    runOf: async () => 100,
    undecidedHoldMs: 240_000,
    // b catches up 40 s in, well past the deadline (timeoutMs 50 + decideForMs 10 000).
    unblockAtMs: T0 + 40_000,
    onSleep: () => {
      if (clock > T0 + 10_100) {
        frozen.push(p.a.givenAway("main", 1, 0));
        // The review must leave a block whose move is being decided to that move.
        void p.a.review();
      }
    },
  });
  const o = await p.order();
  p.linkA.blackhole = true;
  // Guard (limit run C-2125): the order reads aborted, b cannot say whether it took it in. Without the longer hold the
  // old owner loses the parts at the deadline, and the creature slots remove their creatures.
  expect(await p.a.run(o.id)).toBe("restored");
  expect(clock - T0).toBeGreaterThanOrEqual(40_000);
  expect(p.A.lost).toEqual([]);
  expect(p.A.restored).toEqual(["objects", "slots"]);
  expect(p.B.accepted).toEqual([]);
  // The parts were told to hold on once, for the rest of the hold.
  expect(p.A.held).toHaveLength(2);
  expect(p.A.held.every((forMs) => forMs > 200_000)).toBe(true);
  expect(frozen.length).toBeGreaterThan(0);
  expect(frozen.every(Boolean)).toBe(true);
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
  expect(p.a.givenCount()).toBe(0);
  expect(errorLines).toEqual([]);
  expect(await stateOf(p.orders, o.id)).toBe("aborted");
});

test("review in the middle of a hold leaves the block given away, though the new owner says it never took the order", async () => {
  const frozen: boolean[] = [];
  let p!: ReturnType<typeof pair>;
  let reviewed = false;
  p = pair({
    undecidedHoldMs: 240_000,
    onSleep: async () => {
      if (reviewed || clock <= T0 + 20_000) return;
      reviewed = true;
      // b catches up and answers review's question "free" while close is still asleep.
      p.linkA.blackhole = false;
      p.linkB.blackhole = false;
      await p.a.review();
      frozen.push(p.a.givenAway("main", 1, 0));
      expect(p.A.restored).toEqual([]);
    },
  });
  const o = await p.order();
  p.linkA.blackhole = true;
  expect(await p.a.run(o.id)).toBe("restored");
  expect(reviewed).toBe(true);
  // Guard: the `deciding` skip in review. Without it review drops the entry while the parts are still out, and the
  // block is spawnable while its creatures are foreign.
  expect(frozen).toEqual([true]);
  expect(p.A.restored).toEqual(["objects", "slots"]);
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
});

test("a new owner that is found dead during the hold: the parts are put back, not lost", async () => {
  let dead: number | null = null;
  const p = pair({
    runOf: async () => 100,
    buriedRun: async () => dead,
    undecidedHoldMs: 240_000,
    onSleep: () => { if (clock > T0 + 30_000) dead = 100; },
  });
  const o = await p.order();
  p.linkA.blackhole = true;
  expect(await p.a.run(o.id)).toBe("restored");
  expect(p.A.lost).toEqual([]);
  expect(p.A.restored).toEqual(["objects", "slots"]);
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
});

test("a new owner that never answers: the hold is bounded, and then the parts are lost, logged by name", async () => {
  const p = pair({ runOf: async () => 100, undecidedHoldMs: 20_000 });
  const o = await p.order();
  p.linkA.blackhole = true;
  const before = clock;
  expect(await p.a.run(o.id)).toBe("lost");
  // The deadline (10 050 ms) plus the hold, to the one-second step of the retry.
  expect(clock - before).toBeGreaterThanOrEqual(30_050);
  expect(clock - before).toBeLessThan(32_000);
  expect(p.A.lost).toEqual(["slots", "objects"]);
  expect(p.A.restored).toEqual([]);
  expect(errorLines.some((line) => line.includes("could not be decided in time") && line.includes("slots, objects"))).toBe(true);
  expect(p.a.givenAway("main", 1, 0)).toBe(true);
});

test("a new owner that answers the take after the timeout is refused, because the old owner's abort landed first", async () => {
  const p = pair({ undecidedHoldMs: 240_000, unblockAtMs: T0 + 25_000 });
  const o = await p.order();
  p.linkA.blackhole = true;
  // The call is queued behind b's lag: it reaches b once the link carries it, after the old owner aborted the order.
  const late = (await p.orders.get(o.id))!;
  expect(await p.a.run(o.id)).toBe("restored");
  const sending = { ...late, state: "sending" as const };
  expect(await p.b.accept({ order: sending, parts: { slots: [1, 2] } }, "a")).toMatchObject({ ok: false });
  expect(p.B.accepted).toEqual([]);
});

test("a new owner that said it did not take an order never takes it in", async () => {
  const p = pair();
  const o = await p.order();
  const sending = (await p.orders.swap(o.id, "ordered", "sending"))!;
  expect(p.b.heldHere({ id: o.id })).toEqual({ held: false });
  // Guard: the refusal stays true. A late call (or one for an order written back to "sending") takes nothing in.
  expect(await p.b.accept({ order: sending, parts: { slots: [1, 2] } }, "a")).toEqual({ ok: false, reason: "the old owner was told it was not taken in" });
  expect(p.B.accepted).toEqual([]);
  expect(await stateOf(p.orders, o.id)).toBe("sending");
  // An order it took in is held, whatever the store says of it later.
  const other = await p.order();
  const second = (await p.orders.swap(other.id, "ordered", "sending"))!;
  expect(await p.b.accept({ order: second, parts: { slots: [1, 2] } }, "a")).toEqual({ ok: true });
  await p.store.set(moveKey(other.id), JSON.stringify(second));
  expect(p.b.heldHere({ id: other.id })).toEqual({ held: true });
  // A call sent again for it answers ok, and takes nothing in twice.
  expect(await p.b.accept({ order: second, parts: { slots: [1, 2] } }, "a")).toEqual({ ok: true });
  expect(p.B.accepted).toHaveLength(1);
});

test("the timeouts fit together", async () => {
  // The coordinator does not abort a sending order while the old owner may still decide it.
  expect(BLOCK_MOVE_TIMEOUT_MS + DECIDE_FOR_MS).toBeLessThan(MOVE_SEND_TIMEOUT_MS);
  // A closed order is still there when an old owner that waited the longest reads it.
  expect(BLOCK_MOVE_TIMEOUT_MS + DECIDE_FOR_MS).toBeLessThan(ORDER_KEEP_MS);
  expect(MOVE_START_TIMEOUT_MS).toBeLessThan(MOVE_SEND_TIMEOUT_MS);
  // A move is sent or put back before the creature spawner lets go of the moving slots (preflight C5). Read from the
  // source: loading the spawner needs the database stood in for, and the module mock would reach other test files.
  const source = await Bun.file(new URL("../systems/creatures/spawner.ts", import.meta.url)).text();
  const keep = Number(/export const OUTGOING_KEEP_MS = ([\d_]+);/.exec(source)?.[1]?.replaceAll("_", ""));
  expect(keep).toBeGreaterThan(0);
  // One question to the new owner can start just before the deadline (secfix A round 1).
  expect(BLOCK_MOVE_TIMEOUT_MS + DECIDE_FOR_MS + HELD_ASK_TIMEOUT_MS).toBeLessThan(keep);
  // The longer hold of an undecided move ends while the closed order can still be read (ORDER_KEEP_MS), and the parts
  // are told to hold on past `keep`.
  expect(BLOCK_MOVE_TIMEOUT_MS + DECIDE_FOR_MS + UNDECIDED_HOLD_MS + HELD_ASK_TIMEOUT_MS + DECIDE_RETRY_MS).toBeLessThan(ORDER_KEEP_MS);
});

// ---- the coordinator

const info = (nodeId: string): NodeInfo => ({ nodeId, regionId: "eu", publicHost: `${nodeId}.example.com`, port: 3000, wtPort: 3002, useSSL: true, startedAt: T0 });
const own = (nodeId: string, epoch: number): BlockOwner => ({ nodeId, epoch, since: T0 - 60_000 });
// main is four blocks wide: a owns 0,0 and 1,0 (at epoch 7); b owns 2,0 and 3,0.
const startTable = (): MapBlocks => ({ epoch: 7, owners: { "0,0": own("a", 1), "1,0": own("a", 7), "2,0": own("b", 3), "3,0": own("b", 3) } });

async function cluster(opts: { rebalanceEveryMs?: number; also?: string[] } = {}) {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await new MapCatalogue(store).publish([extentOf("main", 4 * 4096, 4096)]);
  // `also`: nodes that own no block of the table (a node that joined, the target of a move).
  const nodes = ["a", "b", ...(opts.also ?? [])];
  for (const id of nodes) await registry.announce(info(id));
  const table = new BlockTable(store);
  await table.write("main", startTable());
  let live = nodes;
  // a is overloaded (by more than MIN_OVERLOAD, so loads are in the hundreds): rebalance (when on) orders 1,0 to b.
  const loads: Record<string, Record<string, number>> = { a: { "main|0,0": 150, "main|1,0": 50 }, b: { "main|2,0": 20 } };
  const beat = async () => {
    for (const id of live) {
      await registry.beat(id);
      await registry.report({ nodeId: id, at: clock, players: 0, creatures: 0, blocks: loads[id] ?? {} });
    }
  };
  await beat();
  const coordinator = new Coordinator(store, new ClusterBus(store, "coord", TEST_BUS_KEY), { id: "coord", now: () => clock, rebalanceEveryMs: opts.rebalanceEveryMs ?? 0 });
  const orders = new BlockMoveOrders(store, () => clock);
  const pass = async (ms = 1000) => {
    advance(ms);
    await beat();
    await coordinator.tick();
    await settle();
  };
  const stored = async (): Promise<MapBlocks> => {
    const read = await table.readStored("main");
    if (read.state !== "ok") throw new Error(`the table is ${read.state}`);
    return read.table;
  };
  const sentOrder = async (): Promise<MoveOrder> => {
    const o = await orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 7 });
    await orders.swap(o.id, "ordered", "sending");
    return (await orders.swapWith(o.id, "sending", "sent", { parts: ["slots", "objects"] }))!;
  };
  return { store, registry, orders, pass, stored, sentOrder, setLive: (ids: string[]) => { live = ids; } };
}

test("a sent order is committed: the block goes to its new owner under a new epoch, and the order is done", async () => {
  const c = await cluster();
  const o = await c.sentOrder();
  await c.pass();
  const t = await c.stored();
  expect(t.epoch).toBeGreaterThan(7);
  expect(t.owners["1,0"]).toEqual({ nodeId: "b", epoch: t.epoch, since: clock });
  expect(t.owners["0,0"]).toEqual(own("a", 1));
  expect(await stateOf(c.orders, o.id)).toBe("done");
});

test("a sent order whose block changed hands is not committed", async () => {
  const c = await cluster();
  const o = await c.sentOrder();
  const moved = startTable();
  moved.epoch = 8;
  moved.owners["1,0"] = own("a", 8);
  await new BlockTable(c.store).write("main", moved);
  await c.pass();
  // Guard: the owner check. The order was made at epoch 7; the block is at 8 now.
  expect((await c.stored()).owners["1,0"]).toEqual(own("a", 8));
  expect(await stateOf(c.orders, o.id)).toBe("done");
  // What b took in is stranded there, logged by name (task 20 review M3).
  expect(errorLines.some((line) => line.includes(o.id) && line.includes("slots, objects") && line.includes("stranded"))).toBe(true);
});

test("a sent order whose new owner missed its beats is committed all the same, and the new owner keeps the block once back", async () => {
  const c = await cluster();
  const o = await c.sentOrder();
  c.setLive(["a"]);
  // b's beat runs out (3 s). One pass: b is missing once, not yet taken over.
  await c.pass(5_000);
  // Guard: no live check (task 20 review C1). The block goes where its state is. Left on a, a respawns the slots b
  // holds once they are no longer outgoing: two creatures for one slot.
  const committed = (await c.stored()).owners["1,0"]!;
  expect(committed.nodeId).toBe("b");
  expect(await stateOf(c.orders, o.id)).toBe("done");
  c.setLive(["a", "b"]);
  for (let i = 0; i < 5; i++) await c.pass();
  expect((await c.stored()).owners["1,0"]).toEqual(committed);
  expect(await c.store.get(deadKey("b"))).toBeNull();
});

test("a sent order whose new owner is dead is committed to it, and the takeover hands the block on", async () => {
  const c = await cluster();
  // The coordinator leads, its first hold is over, and it has seen b's run live.
  for (let i = 0; i < 5; i++) await c.pass();
  const o = await c.sentOrder();
  c.setLive(["a"]);
  await c.pass(5_000);
  const committed = (await c.stored()).owners["1,0"]!;
  expect(committed.nodeId).toBe("b");
  for (let i = 0; i < 10; i++) await c.pass(2_000);
  // b is tombstoned: node-dead tells a to drop b's foreign creatures, and b's blocks are refilled.
  expect(await c.store.get(deadKey("b"))).not.toBeNull();
  const t = await c.stored();
  expect(Object.values(t.owners).map((owner) => owner.nodeId)).toEqual(["a", "a", "a", "a"]);
  expect(t.owners["1,0"]!.epoch).toBeGreaterThan(committed.epoch);
  expect(await stateOf(c.orders, o.id)).toBe("done");
});

test("a sent order whose new owner was forgotten is not committed to it: the block is refilled, and what it took in is logged lost there", async () => {
  // Ownership I1: c stalled, was taken over and forgotten, then woke and took the block in before its beat fenced it.
  const c = await cluster();
  const o = await c.orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "c", blockEpoch: 7 });
  await c.orders.swap(o.id, "ordered", "sending");
  await c.orders.swapWith(o.id, "sending", "sent", { parts: ["slots", "objects"] });
  for (let i = 0; i < 20; i++) await c.pass();
  // Guard: the known check in commitMove. Committed to c, the block would stay with a node no one watches.
  const owner = (await c.stored()).owners["1,0"]!;
  expect(["a", "b"]).toContain(owner.nodeId);
  expect(owner.epoch).toBeGreaterThan(7);
  expect(await stateOf(c.orders, o.id)).toBe("done");
  expect(errorLines.some((line) => line.includes(o.id) && line.includes("slots, objects") && line.includes(" c ") && line.includes("lost"))).toBe(true);
});

test("a sent order whose new owner's run has a tombstone is not committed to it: the block is refilled", async () => {
  const c = await cluster({ also: ["c"] });
  const o = await c.orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "c", blockEpoch: 7 });
  await c.orders.swap(o.id, "ordered", "sending");
  await c.orders.swapWith(o.id, "sending", "sent", { parts: ["slots"] });
  // Taken over, not yet forgotten: still known, its run tombstoned.
  await c.store.set(deadKey("c"), JSON.stringify({ nodeId: "c", startedAt: T0, at: clock }), 60_000);
  c.setLive(["a", "b"]);
  await c.pass();
  // Guard: the tombstone check in commitMove.
  const owner = (await c.stored()).owners["1,0"]!;
  expect(["a", "b"]).toContain(owner.nodeId);
  expect(owner.epoch).toBeGreaterThan(7);
  expect(await stateOf(c.orders, o.id)).toBe("done");
});

test("a takeover aborts the dead node's orders that were not taken in, before it refills its blocks", async () => {
  // Ownership M1: left open, the new owner could still take in what the dead node sent, for a block refilled meanwhile.
  const c = await cluster();
  for (let i = 0; i < 5; i++) await c.pass();
  const ordered = await c.orders.create({ map: "main", bx: 0, by: 0, from: "a", to: "b", blockEpoch: 1 });
  const sending = await c.orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 7 });
  await c.orders.swap(sending.id, "ordered", "sending");
  c.setLive(["b"]);
  for (let i = 0; i < 10 && !(await c.store.get(deadKey("a"))); i++) await c.pass(2_000);
  expect(await c.store.get(deadKey("a"))).not.toBeNull();
  // Guard: the abort in takeOver (well inside the 30 s and 60 s the pass's own timeouts wait).
  expect(await stateOf(c.orders, ordered.id)).toBe("aborted");
  expect(await stateOf(c.orders, sending.id)).toBe("aborted");
  const t = await c.stored();
  expect(t.owners["0,0"]!.nodeId).toBe("b");
  expect(t.owners["1,0"]!.nodeId).toBe("b");
});

test("a takeover commits the dead node's order its new owner took in, and leaves that block out of the refill", async () => {
  const c = await cluster({ also: ["c"] });
  for (let i = 0; i < 5; i++) await c.pass();
  const o = await c.orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "c", blockEpoch: 7 });
  await c.orders.swap(o.id, "ordered", "sending");
  // c takes the block in while the takeover runs: after the pass's settleMoves read the order, before the refill.
  const realSet = c.store.set.bind(c.store);
  const spy = spyOn(c.store, "set").mockImplementation(async (key: string, value: string, ttlMs?: number) => {
    const result = await realSet(key, value, ttlMs);
    if (key === deadKey("a")) await c.orders.swapWith(o.id, "sending", "sent", { parts: ["slots", "objects"] });
    return result;
  });
  cleanups.push(() => spy.mockRestore());
  c.setLive(["b", "c"]);
  for (let i = 0; i < 10 && !(await c.store.get(deadKey("a"))); i++) await c.pass(2_000);
  expect(await c.store.get(deadKey("a"))).not.toBeNull();
  // Guard: the commit in takeOver. Refilled, 1,0 would go to b (its live neighbour), stranding what c took in.
  expect((await c.stored()).owners["1,0"]!.nodeId).toBe("c");
  expect(await stateOf(c.orders, o.id)).toBe("done");
  expect(errorLines.some((line) => line.includes("stranded"))).toBe(false);
});

test("an order not started in 30 s is aborted, and one not taken in 60 s after it started", async () => {
  const c = await cluster();
  const ordered = await c.orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 7 });
  const started = await c.orders.create({ map: "main", bx: 0, by: 0, from: "a", to: "b", blockEpoch: 1 });
  await c.orders.swap(started.id, "ordered", "sending");
  await c.pass(MOVE_START_TIMEOUT_MS - 1_000);
  expect(await stateOf(c.orders, ordered.id)).toBe("ordered");
  await c.pass(2_000);
  expect(await stateOf(c.orders, ordered.id)).toBe("aborted");
  // The abort says why, so a node that never started an order can be told from one that holds a block.
  expect(((await c.orders.get(ordered.id)) as EndedOrder).reason).toBe("not-started");
  expect(await stateOf(c.orders, started.id)).toBe("sending");
  await c.pass(MOVE_SEND_TIMEOUT_MS - MOVE_START_TIMEOUT_MS);
  expect(await stateOf(c.orders, started.id)).toBe("aborted");
  expect((await c.stored()).owners["1,0"]).toEqual(own("a", 7));
});

test("a sent order is never aborted, however old", async () => {
  const c = await cluster();
  const o = await c.sentOrder();
  // The table cannot be read, so the commit waits.
  await c.store.set("cells:blocks:main", "{");
  await c.pass(MOVE_SEND_TIMEOUT_MS + 1_000);
  await c.pass(ORDER_KEEP_MS + 1_000);
  // Guard: no timeout on sent. The parts are on b; an abort would let a put them back.
  expect(await stateOf(c.orders, o.id)).toBe("sent");
});

test("a closed order is kept for ORDER_KEEP_MS, then removed", async () => {
  const c = await cluster();
  const o = await c.orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 7 });
  await c.orders.swap(o.id, "ordered", "aborted");
  await c.pass(ORDER_KEEP_MS - 1_000);
  // Guard: the keep. An old owner still deciding must read how the order ended.
  expect(await stateOf(c.orders, o.id)).toBe("aborted");
  await c.pass(2_000);
  expect(await c.orders.get(o.id)).toBeNull();
  expect(await c.store.members(MOVES_KEY)).toEqual([]);
});

test("a closed order is removed only at the revision the coordinator read", async () => {
  const c = await cluster();
  const o = await c.orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 7 });
  const aborted = (await c.orders.swap(o.id, "ordered", "aborted"))!;
  advance(ORDER_KEEP_MS + 1_000);
  // Right after the coordinator reads the order, before it removes it, the order's key is written again at a new
  // revision.
  const real = c.store.get.bind(c.store);
  let armed = true;
  const reads = spyOn(c.store, "get").mockImplementation(async (key: string) => {
    const value = await real(key);
    if (armed && key === moveKey(o.id)) {
      armed = false;
      const rewritten: MoveOrder = { ...aborted, epoch: aborted.epoch + 1, state: "sending", at: clock };
      await c.store.swapIfEpoch(moveKey(o.id), aborted.epoch, JSON.stringify(rewritten));
    }
    return value;
  });
  try {
    await c.pass();
  } finally {
    reads.mockRestore();
  }
  // Guard: the remove checks the state and revision it read (preflight T14 m6).
  expect(armed).toBe(false);
  expect(await stateOf(c.orders, o.id)).toBe("sending");
  expect(await c.store.members(MOVES_KEY)).toEqual([o.id]);
});

test("a block whose order ended too-big is not ordered again until ORDER_KEEP_MS has passed, and is logged once", async () => {
  const c = await cluster({ rebalanceEveryMs: 10_000 });
  const o = await c.orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 7 });
  await c.orders.swap(o.id, "ordered", "sending");
  await c.orders.swapWith(o.id, "sending", "aborted", { reason: "too-big" });
  const tooBigLines = () => warnLines.filter((line) => line.includes(o.id) && line.includes("too big")).length;
  // Guard: preflight D11. Without the skip, the next pass orders the same block again, and every pass after it.
  for (let i = 0; i < 5; i++) await c.pass(10_000);
  expect((await c.orders.all()).map((order) => order.id)).toEqual([o.id]);
  expect(tooBigLines()).toBe(1);
  await c.pass(ORDER_KEEP_MS - 50_000);
  expect((await c.orders.all()).map((order) => order.id)).toEqual([o.id]);
  // Past the keep, the order is removed and the block may be ordered again (at the next rebalance).
  await c.pass(10_000);
  const after = await c.orders.all();
  expect(after).toHaveLength(1);
  expect(after[0]!.id).not.toBe(o.id);
  expect(after[0]).toMatchObject({ state: "ordered", bx: 1, by: 0, from: "a", to: "b" });
  expect(tooBigLines()).toBe(1);
});

test("a commit that loses its table write to another one stays sent, and the next pass commits it", async () => {
  const c = await cluster();
  const o = await c.sentOrder();
  // Between the commit's read of the table and its write, another write lands (the block is still a's at 7).
  const real = c.store.swapIfEpoch.bind(c.store);
  let armed = true;
  const spy = spyOn(c.store, "swapIfEpoch").mockImplementation(async (key: string, epoch: number, value: string) => {
    if (armed && key === "cells:blocks:main") {
      armed = false;
      await c.store.set(key, JSON.stringify({ ...startTable(), epoch: 8 }));
    }
    return real(key, epoch, value);
  });
  try {
    await c.pass();
  } finally {
    spy.mockRestore();
  }
  // Guard: the write's result (task 20 review I4). Marked done without it, the block stays on a while b holds it.
  expect(armed).toBe(false);
  expect((await c.stored()).owners["1,0"]).toEqual(own("a", 7));
  expect(await stateOf(c.orders, o.id)).toBe("sent");
  await c.pass();
  expect((await c.stored()).owners["1,0"]?.nodeId).toBe("b");
  expect(await stateOf(c.orders, o.id)).toBe("done");
});

test("a coordinator that lost the lock just before a commit does not commit", async () => {
  const c = await cluster();
  await c.pass();
  const o = await c.sentOrder();
  // The lock goes to another holder after this pass took it, as the move orders are read.
  const real = c.store.members.bind(c.store);
  let armed = true;
  const spy = spyOn(c.store, "members").mockImplementation(async (key: string) => {
    if (armed && key === MOVES_KEY) {
      armed = false;
      await c.store.set(LOCK_KEY, JSON.stringify({ holder: "other", epoch: 99 }), 600_000);
    }
    return real(key);
  });
  try {
    await c.pass();
  } finally {
    spy.mockRestore();
  }
  // Guard: the lock check before the commit (task 20 review M1). The other leader carries the order on.
  expect(armed).toBe(false);
  expect((await c.stored()).owners["1,0"]).toEqual(own("a", 7));
  expect(await stateOf(c.orders, o.id)).toBe("sent");
});

test("a coordinator that is not the leader carries no order on", async () => {
  const c = await cluster();
  await c.store.set(LOCK_KEY, JSON.stringify({ holder: "other", epoch: 99 }), 600_000);
  const o = await c.sentOrder();
  for (let i = 0; i < 3; i++) await c.pass();
  expect(await stateOf(c.orders, o.id)).toBe("sent");
  expect((await c.stored()).owners["1,0"]).toEqual(own("a", 7));
});

test("a sent order is committed before the pass gives out any other block", async () => {
  const c = await cluster();
  // Block 3,0 has no owner: the pass gives it out (fill) in the same pass.
  const t = startTable();
  delete t.owners["3,0"];
  await new BlockTable(c.store).write("main", t);
  await c.sentOrder();
  const writes: string[] = [];
  const real = c.store.swapIfEpoch.bind(c.store);
  const spy = spyOn(c.store, "swapIfEpoch").mockImplementation(async (key: string, epoch: number, value: string) => {
    if (key === "cells:blocks:main") writes.push(Object.entries(JSON.parse(value).owners).map(([k, o]: [string, any]) => `${k}=${o.nodeId}`).sort().join(" "));
    return real(key, epoch, value);
  });
  try {
    await c.pass();
  } finally {
    spy.mockRestore();
  }
  // Guard: preflight C5. The first table write of the pass is the commit: the old owner's spawner reviews the slots it
  // let go on any table change, and must find the block already its new owner's.
  expect(writes[0]).toBe("0,0=a 1,0=b 2,0=b");
  expect(writes).toHaveLength(2);
});

test("end to end: the leader orders a move, the old owner carries it out, and the next pass commits it", async () => {
  const c = await cluster({ rebalanceEveryMs: 10_000 });
  const tableA = new BlockTable(c.store);
  await tableA.load("main");
  const m = movers(c.orders, { ownerOf: (map, bx, by) => tableA.ownersOf(map)[blockKey(bx, by)] ?? null });
  const busA = new ClusterBus(c.store, "a", TEST_BUS_KEY);
  const runs: Array<Promise<string>> = [];
  busA.on("block-move", (data: any) => { runs.push(m.a.run(data.id)); });
  await busA.start();
  try {
    await c.pass();
    expect(runs).toHaveLength(1);
    expect(await runs[0]).toBe("sent");
    await c.pass();
    expect((await c.stored()).owners["1,0"]?.nodeId).toBe("b");
    expect(m.B.accepted.map((entry) => entry.part)).toEqual(["slots", "objects"]);
    expect(m.A.restored).toEqual([]);
    const [order] = await c.orders.all();
    expect(order?.state).toBe("done");
  } finally {
    await busA.stop();
  }
});

// ---- stall fix: probe before collecting

test("a new owner that does not answer the probe: the order is aborted unreachable with nothing taken out, frozen or held", async () => {
  const p = pair();
  const o = await p.order();
  // Guard: the link is clogged both ways; the probe waits behind it. Without the probe the parts are taken out first and
  // the block sits frozen for the whole hold.
  p.linkA.probeThrough = false;
  p.linkA.blackhole = true;
  const before = clock;
  expect(await p.a.run(o.id)).toBe("skipped");
  expect(p.A.collected).toEqual([]);
  expect(p.A.restored).toEqual([]);
  expect(p.A.held).toEqual([]);
  expect(p.A.lost).toEqual([]);
  expect(p.A.sent).toEqual([]);
  expect(p.B.accepted).toEqual([]);
  // No retry wait: the order is aborted at once, not decided over minutes.
  expect(clock - before).toBe(0);
  const ended = (await p.orders.get(o.id)) as EndedOrder;
  expect(ended.state).toBe("aborted");
  expect(ended.reason).toBe("unreachable");
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
  expect(p.a.givenCount()).toBe(0);
  expect(errorLines).toEqual([]);
  // The node is free again: the next order goes through.
  p.linkA.blackhole = false;
  p.linkA.probeThrough = true;
  const next = await p.order();
  expect(await p.a.run(next.id)).toBe("sent");
});

test("a probe answered: the order goes on as before, and the new owner's state is not changed by the probe", async () => {
  const p = pair();
  const o = await p.order();
  expect(p.b.probeHere()).toEqual({ ready: true });
  // The probe does not refuse the order on the new owner (as BLOCK_MOVE_HELD does) and does not take it in.
  expect(await p.a.run(o.id)).toBe("sent");
  expect(p.A.collected).toEqual(["slots", "objects"]);
  expect(p.B.accepted).toHaveLength(2);
  expect(await stateOf(p.orders, o.id)).toBe("sent");
  // The probe went before the call, over the link.
  expect(p.linkA.sent.filter((kind) => kind === "CALL")).toHaveLength(2);
});

test("a new owner that may not own blocks answers the probe not ready: nothing is taken out", async () => {
  const p = pair({ canOwnB: () => false });
  const o = await p.order();
  expect(p.b.probeHere()).toEqual({ ready: false });
  expect(await p.a.run(o.id)).toBe("skipped");
  expect(p.A.collected).toEqual([]);
  expect(((await p.orders.get(o.id)) as EndedOrder).reason).toBe("unreachable");
});

test("a new owner without the probe handler (an older build) counts as no answer: nothing is taken out", async () => {
  const p = pair();
  (p.callsB as any).handlers.delete("BLOCK_MOVE_PROBE");
  const o = await p.order();
  expect(await p.a.run(o.id)).toBe("skipped");
  expect(p.A.collected).toEqual([]);
  expect(p.B.accepted).toEqual([]);
  expect(((await p.orders.get(o.id)) as EndedOrder).reason).toBe("unreachable");
});

// ---- balance: the probe waits for the sender's own lag

test("the probe wait is max(base, 8 x own lag), capped at MOVE_PROBE_MAX_MS", () => {
  expect(MOVE_PROBE_MAX_MS).toBe(10_000);
  expect(probeDeadlineMs(0)).toBe(MOVE_PROBE_TIMEOUT_MS);
  expect(probeDeadlineMs(100)).toBe(MOVE_PROBE_TIMEOUT_MS);
  expect(probeDeadlineMs(441)).toBe(3_528);
  expect(probeDeadlineMs(1_000)).toBe(8_000);
  expect(probeDeadlineMs(5_000)).toBe(MOVE_PROBE_MAX_MS);
  expect(probeDeadlineMs(Number.NaN)).toBe(MOVE_PROBE_TIMEOUT_MS);
  expect(probeDeadlineMs(-5)).toBe(MOVE_PROBE_TIMEOUT_MS);
  expect(probeDeadlineMs(441, 50)).toBe(3_528);
});

test("the longest probe, then the move's own call, ends well before the coordinator gives up on a sending order", () => {
  // The coordinator aborts a "sending" order MOVE_SEND_TIMEOUT_MS after it started; the probe runs inside that, before the call.
  expect(MOVE_PROBE_MAX_MS + BLOCK_MOVE_TIMEOUT_MS + 20_000).toBeLessThanOrEqual(MOVE_SEND_TIMEOUT_MS);
  // The probe starts after the "ordered" to "sending" swap, so MOVE_START_TIMEOUT_MS (an order never started) is not in play.
  expect(MOVE_PROBE_MAX_MS).toBeLessThan(MOVE_START_TIMEOUT_MS);
});

test("the probe is called with the scaled wait for the sender's lag", async () => {
  for (const [lag, want] of [[0, 50], [10, 80], [1_000_000, MOVE_PROBE_MAX_MS]] as const) {
    const p = pair({ lagA: lag });
    const waits: Array<number | undefined> = [];
    const call = p.callsA.call.bind(p.callsA);
    (p.callsA as any).call = (peer: string, name: string, body: unknown, opts: { timeoutMs?: number } = {}) => {
      if (name === "BLOCK_MOVE_PROBE") waits.push(opts.timeoutMs);
      return call(peer, name, body, opts);
    };
    const o = await p.order();
    expect(await p.a.run(o.id)).toBe("sent");
    expect(waits).toEqual([want]);
  }
});

test("a probe answer later than the base wait but inside the scaled one lets the order go; with no lag the same answer is too late and takes nothing", async () => {
  const slow = (p: ReturnType<typeof pair>) =>
    (p.callsB as any).handlers.set("BLOCK_MOVE_PROBE", () => new Promise((resolve) => setTimeout(() => resolve({ ready: true }), 120)));
  // 120 ms against a 50 ms base: a lag of 20 ms allows 160 ms.
  const lagging = pair({ lagA: 20 });
  slow(lagging);
  const first = await lagging.order();
  expect(await lagging.a.run(first.id)).toBe("sent");
  expect(lagging.B.accepted).toHaveLength(2);

  const plain = pair();
  slow(plain);
  const second = await plain.order();
  expect(await plain.a.run(second.id)).toBe("skipped");
  // The answer arrives after the deadline and is ignored: nothing was taken out, frozen, held or accepted.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(plain.A.collected).toEqual([]);
  expect(plain.A.held).toEqual([]);
  expect(plain.B.accepted).toEqual([]);
  expect(((await plain.orders.get(second.id)) as EndedOrder).reason).toBe("unreachable");
  expect(plain.a.givenCount()).toBe(0);
});

test("the decide deadline is measured from the probe's return: a slow probe does not shorten it, a long wait that is not used does not stretch it", async () => {
  const want = 50 + 10_000 + 240_000 + 50 + 1_000; // timeoutMs + decideForMs + undecidedHoldMs + askTimeoutMs + retryMs, from the collect
  for (const [lagA, probeTakes] of [[0, 8_000], [1_000, 0]] as const) {
    clock = T0;
    setSystemTime(new Date(clock));
    let collectedAt = -1;
    let holdEndsAt = -1;
    let p!: ReturnType<typeof pair>;
    p = pair({
      lagA,
      runOf: async () => 100,
      undecidedHoldMs: 240_000,
      unblockAtMs: T0 + 40_000 + probeTakes,
      partsA: (l) => [
        {
          ...fakePart("slots", 0, l, [1, 2]),
          // The link goes down once the parts are out: the call never answers, and the order is decided late.
          collect: async () => {
            collectedAt = clock;
            p.linkA.blackhole = true;
            return [1, 2];
          },
          hold: (_move: BlockMove, _got: unknown, forMs: number) => { if (holdEndsAt < 0) holdEndsAt = clock + forMs; },
        },
      ],
    });
    // A new owner behind: its answer takes `probeTakes` ms of the old owner's clock (a lagging link), or none.
    (p.callsB as any).handlers.set("BLOCK_MOVE_PROBE", () => { advance(probeTakes); return { ready: true }; });
    const o = await p.order();
    expect(await p.a.run(o.id)).toBe("restored");
    expect(collectedAt).toBeGreaterThan(0);
    expect(holdEndsAt - collectedAt).toBe(want);
  }
});

// ---- stall fix: a held block does not hold the node

const orderOf = (p: ReturnType<typeof pair>, bx: number) => p.orders.create({ map: "main", bx, by: 0, from: "a", to: "b", blockEpoch: 7 });

test("a block held undecided frees the node: an order for another block is carried out, the held block stays frozen, each part runs once", async () => {
  let p!: ReturnType<typeof pair>;
  let second: MoveOrder | null = null;
  let done = false;
  let secondEnd: MoveEnd | null = null;
  let sameBlock: MoveEnd | null = null;
  let sameOrder: string | null = null;
  p = pair({
    runOf: async () => 100,
    undecidedHoldMs: 240_000,
    onSleep: async () => {
      // 11 s in: past the deadline, the first order is held.
      if (done || clock <= T0 + 11_000) return;
      done = true;
      expect(p.a.givenAway("main", 1, 0)).toBe(true);
      // The link carries frames for a moment (a node that has caught up) and is clogged again after.
      p.linkA.blackhole = false;
      p.linkB.blackhole = false;
      second = await orderOf(p, 2);
      secondEnd = await p.a.run(second.id);
      // Guard: a second order for the held block is not carried out, whatever the node is doing.
      const again = await orderOf(p, 1);
      sameOrder = again.id;
      sameBlock = await p.a.run(again.id);
      // Held: the first order's own question is not asked while the link works (it asks after the sleep).
      p.linkA.blackhole = true;
      p.linkB.blackhole = true;
    },
  });
  const first = await p.order();
  p.linkA.blackhole = true;
  const running = p.a.run(first.id);
  while (!done) await settle();
  // Wait for the hook to finish its orders.
  while (sameBlock === null) await settle();
  // The first block is still frozen and given away; the second was sent.
  expect(secondEnd as unknown).toBe("sent");
  expect(sameBlock as unknown).toBe("skipped");
  expect(((await p.orders.get(sameOrder!)) as EndedOrder).reason).toBe("held");
  expect(p.a.givenAway("main", 1, 0)).toBe(true);
  expect(p.a.givenAway("main", 2, 0)).toBe(true);
  // Per part: the second block's parts were collected and sent once; the first block's are out and not restored, sent or lost.
  expect(p.A.collected).toEqual(["slots", "objects", "slots", "objects"]);
  expect(p.A.sent).toEqual(["slots", "objects"]);
  expect(p.A.restored).toEqual([]);
  expect(p.A.lost).toEqual([]);
  expect(p.B.accepted.map((entry) => entry.block)).toEqual(["2,0", "2,0"]);
  // The link is back: the first order is decided once, and its parts are put back once.
  p.linkA.blackhole = false;
  p.linkB.blackhole = false;
  expect(await running).toBe("restored");
  expect(p.A.restored).toEqual(["objects", "slots"]);
  expect(p.A.sent).toEqual(["slots", "objects"]);
  expect(p.A.lost).toEqual([]);
  expect(p.B.accepted.map((entry) => entry.block)).toEqual(["2,0", "2,0"]);
  expect(await stateOf(p.orders, first.id)).toBe("aborted");
  expect(await stateOf(p.orders, second!.id)).toBe("sent");
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
  expect(errorLines).toEqual([]);
});

test("only one undecided hold frees the node: with two held blocks a third order is aborted busy", async () => {
  let p!: ReturnType<typeof pair>;
  let secondRun = null as Promise<MoveEnd> | null;
  let startedSecond = false;
  let thirdEnd: MoveEnd | null = null;
  let thirdId = "";
  let checked = false;
  p = pair({
    runOf: async () => 100,
    undecidedHoldMs: 240_000,
    onSleep: async () => {
      if (!startedSecond && clock > T0 + 11_000) {
        startedSecond = true;
        // The second order is stuck too: its call is never answered.
        const second = await orderOf(p, 2);
        secondRun = p.a.run(second.id);
        return;
      }
      // Once the second is past its own deadline as well, both are held (the mover's own count of holds).
      if (startedSecond && !checked && (p.a as any).holding.size === 2) {
        checked = true;
        thirdId = (await orderOf(p, 3)).id;
        thirdEnd = await p.a.run(thirdId);
        // Both held, clear the link so both loops end.
        p.linkA.blackhole = false;
        p.linkB.blackhole = false;
      }
    },
  });
  const first = await p.order();
  p.linkA.blackhole = true;
  const ends = await Promise.all([p.a.run(first.id), (async () => { while (!secondRun) await settle(); return secondRun; })()]);
  expect(checked).toBe(true);
  // Guard: the cap. A third order while two blocks are held is aborted busy, nothing collected for it.
  expect(thirdEnd as unknown).toBe("skipped");
  expect(((await p.orders.get(thirdId)) as EndedOrder).reason).toBe("busy");
  expect(ends).toEqual(["restored", "restored"]);
  expect(p.A.collected).toEqual(["slots", "objects", "slots", "objects"]);
  expect(p.A.restored).toEqual(["objects", "slots", "objects", "slots"]);
  expect(p.A.lost).toEqual([]);
  expect(p.A.sent).toEqual([]);
  // Both holds are over: the node takes an order again.
  const fourth = await orderOf(p, 3);
  expect(await p.a.run(fourth.id)).toBe("sent");
});

test("an order that cannot be read with nothing taken out is let go at the deadline: no block frozen, nothing held or lost", async () => {
  const p = pair({ undecidedHoldMs: 240_000 });
  const o = await p.order();
  p.linkA.probeThrough = false;
  p.linkA.blackhole = true;
  // The store goes down once the order is started: the abort cannot be written or read.
  const real = p.store.get.bind(p.store);
  let down = false;
  const reads = spyOn(p.store, "get").mockImplementation(async (key: string) => {
    if (down) throw new Error("the cluster store is down");
    return real(key);
  });
  const set = spyOn(p.orders, "swapWith").mockImplementation(async () => { down = true; throw new Error("the cluster store is down"); });
  try {
    expect(await p.a.run(o.id)).toBe("skipped");
  } finally {
    reads.mockRestore();
    set.mockRestore();
  }
  // Guard: nothing was taken out, so no hold. With the hold the block is given away and the parts are told to hold on.
  expect(p.A.held).toEqual([]);
  expect(p.A.lost).toEqual([]);
  expect(p.a.givenAway("main", 1, 0)).toBe(false);
  expect(p.a.givenCount()).toBe(0);
  expect(clock - T0).toBeLessThanOrEqual(11_000);
});
