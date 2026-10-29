import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { BlockTable, type MapBlocks } from "../cluster/blocks";
import { ClusterBus } from "../cluster/bus";
import { Coordinator, MOVE_BACKOFF_MAX_MS, MOVE_BACKOFF_MS, deadKey, moveBackoffMs } from "../cluster/coordinator";
import { PlayerDirectory } from "../cluster/directory";
import { MapCatalogue, extentOf } from "../cluster/maps";
import { MemoryStore } from "../cluster/memorystore";
import { BlockMoveOrders } from "../cluster/blockmove";
import { MOVES_KEY, MoveOrders, isOpen, moveKey } from "../cluster/moveorders";
import { LAG_SAMPLE_MS, LAG_WINDOW_MS, LoopLagMeter, NodeRegistry, type LoadReport, type NodeInfo } from "../cluster/nodes";
import { MIN_OVERLOAD, MOVE_LAG_LIMIT_MS, MOVE_SENDER_LAG_LIMIT_MS, NODE_COOLDOWN_MS, OVERLOAD_RATIO, isLagging, nodeLoad, planRebalance } from "../cluster/rebalance";
import log from "../modules/logger";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

const T0 = new Date("2026-10-21T12:00:00Z").getTime();
let clock = T0;
const advance = (ms: number) => {
  clock += ms;
  setSystemTime(new Date(clock));
};
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

const quiet: Array<{ mockRestore(): void }> = [];
// Stopped before the clock is reset, so nothing is heard on the wrong clock.
const buses: ClusterBus[] = [];
beforeEach(() => {
  clock = T0;
  setSystemTime(new Date(clock));
  quiet.push(
    spyOn(log, "success").mockImplementation(() => {}),
    spyOn(log, "info").mockImplementation(() => {}),
    spyOn(log, "warn").mockImplementation(() => {}),
  );
});
afterEach(async () => {
  await settle();
  for (const bus of buses.splice(0)) await bus.stop();
  setSystemTime();
  for (const spy of quiet.splice(0)) spy.mockRestore();
});

const owner = (nodeId: string, epoch = 1, since = T0 - 60_000) => ({ nodeId, epoch, since });
const report = (nodeId: string, blocks: Record<string, number>): LoadReport => ({ nodeId, at: T0, players: 0, creatures: 0, blocks });

// main is four blocks wide: a owns 0,0 and 1,0; b owns 2,0 and 3,0.
const table = (since = T0 - 60_000): MapBlocks => ({
  epoch: 3,
  owners: { "0,0": owner("a", 1, since), "1,0": owner("a", 2, since), "2,0": owner("b", 3, since), "3,0": owner("b", 3, since) },
});
// Loads are in the hundreds: a node is a sender only if it is MIN_OVERLOAD (25) over the average as well.
const heavyA = () => [report("a", { "main|0,0": 150, "main|1,0": 50 }), report("b", { "main|2,0": 20 })];

// ---- the plan

test("nodeLoad sums the block loads", () => {
  expect(nodeLoad(report("a", { "main|0,0": 1.5, "main|1,0": 2 }))).toBe(3.5);
  expect(nodeLoad(report("a", {}))).toBe(0);
});

test("an overloaded node's edge block goes to the neighbour across the edge", () => {
  expect(planRebalance({ now: T0, tables: [{ map: "main", table: table() }], loads: heavyA(), busy: new Set() })).toEqual([
    { map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2, load: 50 },
  ]);
});

// Node a owns blocks 0,0 and 1,0 (a heavy one and a light one), b owns 2,0: only a can send.
const two = (a: number, light: number, b: number) => ({
  now: T0, tables: [{ map: "main", table: table() }], busy: new Set<string>(),
  loads: [report("a", { "main|0,0": a - light, "main|1,0": light }), report("b", { "main|2,0": b })],
});

test("a node 1.10 times the average and 25 over it sends a block", () => {
  // a at 1100, b at 900: average 1000, so a is 1.10 times it and 100 over. The light block passes hysteresis.
  expect(planRebalance(two(1100, 50, 900))).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2, load: 50 }]);
  // The edge of the floor: 25 over the average of 250 is 1.10 times it.
  expect(planRebalance(two(275, 10, 225))).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2, load: 10 }]);
});

test("a node 1.10 times the average but less than 25 over it sends nothing", () => {
  // a at 110, b at 90: average 100, a is 1.10 times it and 10 over. Guard: MIN_OVERLOAD. The move would pass hysteresis
  // (90 + 5 is below 110 - 5), and with the floor off it is made.
  expect(planRebalance(two(110, 5, 90))).toEqual([]);
  expect(planRebalance(two(110, 5, 90), { minOverload: 0 })).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2, load: 5 }]);
});

test("a node 1.05 times the average sends nothing, though it is far over it in units", () => {
  // a at 1050, b at 950: average 1000, a is 50 over, which is past the floor, but 1.05 is under the ratio of 1.08.
  // Guard: OVERLOAD_RATIO. The light block passes hysteresis (950 + 10 is below 1050 - 10), and with a lower ratio it goes.
  expect(planRebalance(two(1050, 10, 950))).toEqual([]);
  expect(planRebalance(two(1050, 10, 950), { ratio: 1.04 })).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2, load: 10 }]);
});

test("the constants of the trigger", () => {
  expect(OVERLOAD_RATIO).toBe(1.08);
  expect(MIN_OVERLOAD).toBe(25);
});

test("a neighbour with no load report is not a receiver", () => {
  // b owns 2,0 but sent no report (it is not live); c, which reports, borders only b.
  const t: MapBlocks = { epoch: 1, owners: { "0,0": owner("a"), "1,0": owner("a"), "2,0": owner("b"), "3,0": owner("c") } };
  const loads = [report("a", { "main|0,0": 150, "main|1,0": 50 }), report("c", {})];
  // Guard: the report check on the receiver.
  expect(planRebalance({ now: T0, tables: [{ map: "main", table: t }], loads, busy: new Set() })).toEqual([]);
});

test("two senders that border one receiver: only one of them gives to it in a pass", () => {
  // h0 | l | h1 in row 0, and h0, h1 also own the row below.
  const t: MapBlocks = { epoch: 1, owners: { "0,0": owner("h0"), "0,1": owner("h0"), "1,0": owner("l"), "2,0": owner("h1"), "2,1": owner("h1") } };
  const loads = [report("h0", { "main|0,0": 50, "main|0,1": 150 }), report("h1", { "main|2,0": 50, "main|2,1": 150 }), report("l", {})];
  // Guard: the receiver is marked busy by the first move.
  expect(planRebalance({ now: T0, tables: [{ map: "main", table: t }], loads, busy: new Set() })).toHaveLength(1);
});

// ---- a node that owns no block (preflight C6: the takeover fills, rebalancing evens the layout out)

test("a live node that owns no block receives an edge block of the most loaded node", () => {
  const input = { now: T0, tables: [{ map: "main", table: table() }], loads: heavyA(), busy: new Set<string>() };
  // c is live and has no report yet: it counts at load 0. Block 0,0 (150) would leave c above a; 1,0 (50) does not.
  expect(planRebalance({ ...input, live: ["a", "b", "c"] })).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "c", blockEpoch: 2, load: 50 }]);
  // Without the live list (a table could not be read), c is left alone and the neighbour rule runs as before.
  expect(planRebalance({ ...input, loads: [...heavyA(), report("c", {})] })).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2, load: 50 }]);
  // A busy node receives nothing.
  expect(planRebalance({ ...input, live: ["a", "b", "c"], busy: new Set(["c"]) })).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2, load: 50 }]);
});

test("the block given to a node that owns none is an edge block, even when an inner block is heavier", () => {
  // a owns 0..2 x 0..2; 1,1 is its only block that borders no other node's block and lies on no map edge.
  const owners: MapBlocks["owners"] = { "5,0": owner("b") };
  const blocks: Record<string, number> = {};
  for (let by = 0; by < 3; by++) {
    for (let bx = 0; bx < 3; bx++) {
      owners[`${bx},${by}`] = owner("a");
      blocks[`main|${bx},${by}`] = bx === 1 && by === 1 ? 6 : 1;
    }
  }
  const loads = [report("a", blocks), report("b", { "main|5,0": 1 })];
  const moves = planRebalance({ now: T0, tables: [{ map: "main", table: { epoch: 1, owners } }], loads, busy: new Set(), live: ["a", "b", "c"] });
  // Guard: edge blocks first. Without it the heavier 1,1 goes.
  expect(moves).toEqual([{ map: "main", bx: 0, by: 0, from: "a", to: "c", blockEpoch: 1, load: 1 }]);
});

test("a node that owns one block never gives it to a node that owns none", () => {
  // a's report still counts a block it lost, so its one block would pass hysteresis. b is not next to a.
  const t: MapBlocks = { epoch: 1, owners: { "0,0": owner("a"), "2,0": owner("b") } };
  const loads = [report("a", { "main|0,0": 5, "main|9,9": 20 }), report("b", { "main|2,0": 1 })];
  // Guard: the giver owns at least two blocks.
  expect(planRebalance({ now: T0, tables: [{ map: "main", table: t }], loads, busy: new Set(), live: ["a", "b", "c"] })).toEqual([]);
});

test("a node that owns no block receives one even when no node is over 1.2 times the average", () => {
  // Five nodes at load 4 and an empty one: the average is 20 / 6, so 1.2 times it is 4, which no node exceeds. Only
  // the weight-1 block passes hysteresis (0 + 1 < 4 - 1); the weight-3 block does not.
  const owners: MapBlocks["owners"] = {};
  const loads: LoadReport[] = [];
  ["a", "b", "d", "e", "f"].forEach((nodeId, i) => {
    owners[`${i * 2},0`] = owner(nodeId);
    owners[`${i * 2 + 1},0`] = owner(nodeId);
    loads.push(report(nodeId, { [`main|${i * 2},0`]: 3, [`main|${i * 2 + 1},0`]: 1 }));
  });
  const live = ["a", "b", "c", "d", "e", "f"];
  // Guard: the giver need not be over the ratio (preflight C6). Ties in load go by name, so a gives.
  expect(planRebalance({ now: T0, tables: [{ map: "main", table: { epoch: 1, owners } }], loads, busy: new Set(), live })).toEqual([
    { map: "main", bx: 1, by: 0, from: "a", to: "c", blockEpoch: 1, load: 1 },
  ]);
});

// main: a owns 0,0 and 1,0 (load 20); b owns 3,0 only, so it can never give.
const oneGiver = (since = T0 - 60_000): MapBlocks => ({ epoch: 3, owners: { "0,0": owner("a", 1, since), "1,0": owner("a", 2, since), "3,0": owner("b", 3, since) } });

test("a busy node gives no block to a node that owns none", () => {
  const input = { now: T0, tables: [{ map: "main", table: oneGiver() }], loads: heavyA(), live: ["a", "b", "c"] };
  expect(planRebalance({ ...input, busy: new Set<string>() })).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "c", blockEpoch: 2, load: 50 }]);
  // Guard: the giver is not busy (one open order per node).
  expect(planRebalance({ ...input, busy: new Set(["a"]) })).toEqual([]);
});

test("a block held for less than 30 s is not given to a node that owns none", () => {
  // Guard: the block age. Held 29 s, the neighbour rule moves nothing either.
  const input = { now: T0, tables: [{ map: "main", table: oneGiver(T0 - 29_000) }], loads: heavyA(), busy: new Set<string>(), live: ["a", "b", "c"] };
  expect(planRebalance(input)).toEqual([]);
});

test("the move cap also holds for nodes that own no block", () => {
  // a and b can each give (b's 3,0 weighs 0, which passes hysteresis for a node at 0); c, d and e own none.
  const input = { now: T0, tables: [{ map: "main", table: table() }], loads: heavyA(), busy: new Set<string>(), live: ["a", "b", "c", "d", "e"] };
  expect(planRebalance(input)).toHaveLength(2);
  // Guard: maxMoves, checked before each node that owns none.
  expect(planRebalance(input, { maxMoves: 1 })).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "c", blockEpoch: 2, load: 50 }]);
});

test("a block held for less than 30 s does not move", () => {
  // Guard: MIN_BLOCK_AGE_MS. Without it a block just moved could swing straight back.
  expect(planRebalance({ now: T0, tables: [{ map: "main", table: table(T0 - 10_000) }], loads: heavyA(), busy: new Set() })).toEqual([]);
});

test("a node whose event loop lags receives no block (and sends none when far behind); one without the field is not lagging", () => {
  const input = { now: T0, tables: [{ map: "main", table: table() }], busy: new Set<string>() };
  const lag = (lagMs?: number) => heavyA().map((r) => (r.nodeId === "a" ? { ...r, ...(lagMs === undefined ? {} : { lagMs }) } : r));
  const lagB = (lagMs?: number) => heavyA().map((r) => (r.nodeId === "b" ? { ...r, ...(lagMs === undefined ? {} : { lagMs }) } : r));
  expect(planRebalance({ ...input, loads: lag() })).toHaveLength(1);
  expect(planRebalance({ ...input, loads: lag(MOVE_LAG_LIMIT_MS) })).toHaveLength(1);
  // Guard: a sender that lags is still relieved (the balancer exists for it) ...
  expect(planRebalance({ ...input, loads: lag(400) })).toHaveLength(1);
  expect(planRebalance({ ...input, loads: lag(MOVE_SENDER_LAG_LIMIT_MS) })).toHaveLength(1);
  // ... until it is far behind.
  expect(planRebalance({ ...input, loads: lag(1200) })).toEqual([]);
  // Guard: the receiver lags (node-2 did not answer the take).
  expect(planRebalance({ ...input, loads: lagB(300) })).toEqual([]);
  expect(planRebalance({ ...input, loads: lagB(MOVE_LAG_LIMIT_MS + 1) })).toEqual([]);
  expect(isLagging({ ...heavyA()[0]!, lagMs: 400 }, MOVE_SENDER_LAG_LIMIT_MS)).toBe(false);
  expect(isLagging({ ...heavyA()[0]!, lagMs: 0 })).toBe(false);
  expect(isLagging(heavyA()[0]!)).toBe(false);
});

test("the loop-lag meter reports the worst delay of the last few seconds, and clears", () => {
  let t = 0;
  const meter = new LoopLagMeter(() => t);
  expect(meter.max()).toBe(0);
  // A timer that fires on time shows no lag; one that fires 400 ms late shows 400.
  t += LAG_SAMPLE_MS;
  meter.sample();
  expect(meter.max()).toBe(0);
  t += LAG_SAMPLE_MS + 400;
  meter.sample();
  expect(meter.max()).toBe(400);
  // It is gone once the window has passed (the timer fired on time since).
  for (let i = 0; i < LAG_WINDOW_MS / LAG_SAMPLE_MS + 1; i++) {
    t += LAG_SAMPLE_MS;
    meter.sample();
  }
  expect(meter.max()).toBe(0);
  // A loop blocked right now has not fired: the time since its last firing counts.
  t += LAG_SAMPLE_MS + 900;
  expect(meter.max()).toBe(900);
});

test("a move that would overload the neighbour in turn is not made", () => {
  const loads = [report("a", { "main|0,0": 20, "main|1,0": 180 }), report("b", { "main|2,0": 20 })];
  // Guard: toLoad + w < fromLoad - w. 20 + 180 is not below 200 - 180.
  expect(planRebalance({ now: T0, tables: [{ map: "main", table: table() }], loads, busy: new Set() })).toEqual([]);
});

test("a node in an open order neither gives nor takes", () => {
  const input = { now: T0, tables: [{ map: "main", table: table() }], loads: heavyA() };
  expect(planRebalance({ ...input, busy: new Set(["a"]) })).toEqual([]);
  // Guard: the busy check on the receiver.
  expect(planRebalance({ ...input, busy: new Set(["b"]) })).toEqual([]);
});

test("the block goes to the least loaded of the neighbours it borders", () => {
  // c | a | d in row 0; a also owns 1,1 below. Block 1,0 borders c (load 30) and d (load 10).
  const t: MapBlocks = { epoch: 1, owners: { "0,0": owner("c"), "1,0": owner("a"), "2,0": owner("d"), "1,1": owner("a") } };
  const loads = [report("a", { "main|1,0": 100, "main|1,1": 200 }), report("c", { "main|0,0": 30 }), report("d", { "main|2,0": 10 })];
  const moves = planRebalance({ now: T0, tables: [{ map: "main", table: t }], loads, busy: new Set() });
  // 1,1 (load 200) has no neighbour of another node; 1,0 goes to d, the lighter of c and d.
  expect(moves).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "d", blockEpoch: 1, load: 100 }]);
});

test("at most four moves a pass", () => {
  const owners: MapBlocks["owners"] = {};
  const loads: LoadReport[] = [];
  // Five heavy nodes, each owning rows 0 and 2 of its column, with a light node in row 1 between them.
  for (let i = 0; i < 5; i++) {
    owners[`${i},0`] = owner(`h${i}`);
    owners[`${i},1`] = owner(`l${i}`);
    owners[`${i},2`] = owner(`h${i}`);
    loads.push(report(`h${i}`, { [`main|${i},0`]: 150, [`main|${i},2`]: 50 }), report(`l${i}`, {}));
  }
  const moves = planRebalance({ now: T0, tables: [{ map: "main", table: { epoch: 1, owners } }], loads, busy: new Set() });
  // Guard: MAX_MOVES_PER_PASS.
  expect(moves.length).toBe(4);
  expect(new Set(moves.map((m) => m.from)).size).toBe(4);
});

// ---- perf fix 2: a load signal that answers to the moves (block ping-pong)

test("a block weighs what its owner reports: a weight only a non-owner reports does not count", () => {
  // b reports main|1,0, a block a owns, and a does not: the weight is nobody's. Without the owner rule it would be 50,
  // and 1,0 would pass hysteresis (70 + 50 is below 200 - 50).
  const loads = [report("a", { "main|0,0": 200 }), report("b", { "main|2,0": 20, "main|1,0": 50 })];
  expect(planRebalance({ now: T0, tables: [{ map: "main", table: table() }], loads, busy: new Set() })).toEqual([]);
  // Both report it: the owner's 50 is the weight, not 50 + 10.
  const both = [report("a", { "main|0,0": 150, "main|1,0": 50 }), report("b", { "main|2,0": 20, "main|1,0": 10 })];
  expect(planRebalance({ now: T0, tables: [{ map: "main", table: table() }], loads: both, busy: new Set() })).toEqual([
    { map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2, load: 50 },
  ]);
});

test("a block lighter than 5% of the sender's overload above the average is not moved", () => {
  const plan = (light: number) => planRebalance({
    now: T0,
    tables: [{ map: "main", table: table() }],
    loads: [report("a", { "main|0,0": 60, "main|1,0": light }), report("b", { "main|2,0": 2 })],
    busy: new Set(),
  });
  // a at 60.5, average 31.25: the overload is 29.25, and 5% of it is 1.46. Guard: the minimum weight.
  expect(plan(0.5)).toEqual([]);
  expect(plan(2)).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2, load: 2 }]);
});

test("a node that took part in a move rests: no second order within the cooldown, one after it", async () => {
  const { pass, orders } = await world();
  await pass();
  const [first] = await orders.all();
  expect(first).toBeDefined();
  // The move is done, and a's report does not change (its creatures are still there): the plan would order it again.
  await orders.swap(first!.id, "ordered", "done");
  await pass(10_000);
  await pass(10_000);
  // Guard: NODE_COOLDOWN_MS. Nothing is open, and a is still over the ratio.
  expect(await orders.all()).toHaveLength(1);
  await pass(NODE_COOLDOWN_MS - 20_000);
  expect(await orders.all()).toHaveLength(2);
  expect(((await orders.all()) as any[]).filter(isOpen)).toHaveLength(1);
});

test("an aborted order rests the block and its nodes, and the rest doubles with each abort of the block", async () => {
  const { pass, orders } = await world();
  await pass();
  const abortLast = async () => {
    const all = ((await orders.all()) as any[]).sort((x, y) => x.at - y.at);
    await orders.swap(all[all.length - 1].id, "ordered", "aborted");
  };
  await abortLast();
  // Guard: MOVE_BACKOFF_MS. The abort moved nothing, but the same block must not be ordered again at once (the limit
  // run C-2125 ordered it four times in 50 s).
  await pass(10_000);
  await pass(MOVE_BACKOFF_MS - 30_000);
  expect(await orders.all()).toHaveLength(1);
  await pass(30_000);
  expect(await orders.all()).toHaveLength(2);
  // A second abort in a row rests it twice as long.
  await abortLast();
  await pass(MOVE_BACKOFF_MS + 1_000);
  expect(await orders.all()).toHaveLength(2);
  await pass(MOVE_BACKOFF_MS);
  expect(await orders.all()).toHaveLength(3);
  expect(moveBackoffMs(1)).toBe(MOVE_BACKOFF_MS);
  expect(moveBackoffMs(2)).toBe(2 * MOVE_BACKOFF_MS);
  expect(moveBackoffMs(3)).toBe(4 * MOVE_BACKOFF_MS);
  expect(moveBackoffMs(30)).toBe(MOVE_BACKOFF_MAX_MS);
});

test("a block's run of aborts is forgotten once its rest and a further full rest have passed with no new abort", async () => {
  const { coordinator, pass, orders } = await world();
  const fails = () => (coordinator as any).moveFails as Map<string, unknown>;
  await pass();
  const [first] = await orders.all();
  await orders.swap(first!.id, "ordered", "aborted");
  await pass(10_000);
  expect(fails().size).toBe(1);
  await pass(MOVE_BACKOFF_MS);
  expect(await orders.all()).toHaveLength(2);
  // The new order is taken away before the coordinator times it out, which would be a second abort of the block.
  for (const order of await orders.all()) if (order.id !== first!.id) await orders.remove(order.id);
  // Guard: the entry would otherwise live as long as the coordinator. Its rest ended 60 s ago and the block has not aborted since.
  expect(fails().size).toBe(1);
  await pass(MOVE_BACKOFF_MS);
  expect(fails().size).toBe(0);
});

test("an order aborted because the old owner was busy does not lengthen its block's rest, and the nodes still rest", async () => {
  const { pass, orders, store: worldStore } = await world(undefined, ["c"]);
  const busy = new BlockMoveOrders(worldStore);
  await pass();
  const [first] = await orders.all();
  await busy.swapWith(first!.id, "ordered", "aborted", { reason: "busy" });
  // The nodes rest (c is idle, but a, the old owner, is busy): no order for another block either.
  await pass(10_000);
  expect(await orders.all()).toHaveLength(1);
  await pass(MOVE_BACKOFF_MS);
  const second = ((await orders.all()) as any[]).find((order) => order.id !== first!.id);
  expect(second).toBeDefined();
  await busy.swapWith(second.id, "ordered", "aborted", { reason: "busy" });
  // Guard: a busy abort is not a failure of the block. Counted, this second abort would rest the block 120 s, and the
  // order would not come at 61 s.
  await pass(MOVE_BACKOFF_MS + 1_000);
  expect(await orders.all()).toHaveLength(3);
});

test("a done order ends a block's run of aborts", async () => {
  const { pass, orders } = await world();
  await pass();
  const [first] = await orders.all();
  await orders.swap(first!.id, "ordered", "aborted");
  await pass(MOVE_BACKOFF_MS + 1_000);
  const second = ((await orders.all()) as any[]).find((order) => order.id !== first!.id);
  expect(second).toBeDefined();
  await orders.swap(second.id, "ordered", "done");
  await pass(NODE_COOLDOWN_MS + 1_000);
  const third = ((await orders.all()) as any[]).find((order) => order.id !== first!.id && order.id !== second.id);
  expect(third).toBeDefined();
  // Guard: done clears the count. The third order aborted rests one MOVE_BACKOFF_MS, not three.
  await orders.swap(third.id, "ordered", "aborted");
  await pass(MOVE_BACKOFF_MS + 1_000);
  expect(await orders.all()).toHaveLength(4);
});

// ---- the orders

test("an order is created ordered, moved on by swap, and listed until removed", async () => {
  const store = new MemoryStore();
  const orders = new MoveOrders(store, () => clock);
  const order = await orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2 });
  expect(order).toMatchObject({ epoch: 1, state: "ordered", map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2, at: T0 });
  expect(await store.members(MOVES_KEY)).toEqual([order.id]);
  advance(500);
  const sending = await orders.swap(order.id, "ordered", "sending");
  expect(sending).toMatchObject({ epoch: 2, state: "sending", at: T0 + 500 });
  // Guard: the state check in swap. An order already sending cannot be aborted as if it were still ordered.
  expect(await orders.swap(order.id, "ordered", "aborted")).toBeNull();
  expect((await orders.get(order.id))?.state).toBe("sending");
  expect(isOpen(sending!)).toBe(true);
  expect((await orders.all()).map((o) => o.id)).toEqual([order.id]);
  await orders.remove(order.id);
  expect(await orders.all()).toEqual([]);
  expect(await orders.get(order.id)).toBeNull();
});

test("two writers that read one revision: only one swap lands", async () => {
  const store = new MemoryStore();
  const orders = new MoveOrders(store, () => clock);
  const order = await orders.create({ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2 });
  // Both read epoch 1. Guard: swapIfEpoch. Without it the second write lands over the first.
  const [one, two] = await Promise.all([orders.swap(order.id, "ordered", "sending"), orders.swap(order.id, "ordered", "aborted")]);
  expect([one, two].filter((o) => o !== null).length).toBe(1);
});

test("a listed id with no order behind it is dropped from the set; a malformed order reads as none", async () => {
  const store = new MemoryStore();
  const orders = new MoveOrders(store, () => clock);
  await store.addToSet(MOVES_KEY, "ghost");
  await store.addToSet(MOVES_KEY, "bad");
  await store.set(moveKey("bad"), JSON.stringify({ id: "bad", epoch: 1, state: "flying" }));
  expect(await orders.all()).toEqual([]);
  expect(await store.members(MOVES_KEY)).toEqual(["bad"]);
  expect(await orders.get("bad")).toBeNull();
  expect(isOpen({ state: "done" } as any)).toBe(false);
  expect(isOpen({ state: "aborted" } as any)).toBe(false);
});

// ---- the coordinator

const info = (nodeId: string): NodeInfo => ({ nodeId, regionId: "eu", publicHost: `${nodeId}.example.com`, port: 3000, wtPort: 3002, useSSL: true, startedAt: T0 });

// `joiners`: live nodes that own no block and send no report.
// `clocks`: the coordinator's own `now` and `monotonic`, when a test needs them apart.
// `shape`: another block table and load reports than the default pair of nodes.
async function world(rebalanceEveryMs?: number, joiners: string[] = [], clocks: { now?: () => number; monotonic?: () => number } = {}, shape: { table?: MapBlocks; reports?: () => LoadReport[] } = {}) {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await new MapCatalogue(store).publish([extentOf("main", 4 * 4096, 4096)]);
  for (const id of ["a", "b", ...joiners]) await registry.announce(info(id));
  await new BlockTable(store).write("main", shape.table ?? table());
  const live = async () => {
    for (const r of (shape.reports ?? heavyA)()) {
      await registry.beat(r.nodeId);
      await registry.report({ ...r, at: clock });
    }
    for (const id of joiners) await registry.beat(id);
  };
  await live();
  const coordinator = new Coordinator(store, new ClusterBus(store, "coord", TEST_BUS_KEY), { id: "coord", now: () => clock, rebalanceEveryMs, ...clocks });
  const told: any[] = [];
  const nodeA = new ClusterBus(store, "a", TEST_BUS_KEY);
  nodeA.on("block-move", (data) => { told.push(data); });
  await nodeA.start();
  buses.push(nodeA);
  const pass = async (ms = 1000) => {
    advance(ms);
    await live();
    await coordinator.tick();
    await settle();
  };
  return { store, coordinator, told, pass, orders: new MoveOrders(store) };
}

test("the leader writes one order and tells the old owner; the table is left alone", async () => {
  const { store, told, pass, orders } = await world();
  const before = await store.get("cells:blocks:main");
  await pass();
  const all = await orders.all();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ state: "ordered", map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2 });
  expect(told).toEqual([{ id: all[0]!.id }]);
  expect(await store.get("cells:blocks:main")).toBe(before);
});

test("no second order while the first is open", async () => {
  const { pass, orders } = await world();
  await pass();
  // The open order keeps a and b busy: that, not the 10 s interval, is what holds back a second order here (the
  // interval has its own test below).
  for (let i = 0; i < 25; i++) await pass();
  expect(await orders.all()).toHaveLength(1);
});

test("once the open order is closed, the next pass after 10 s may order again", async () => {
  const { pass, orders } = await world();
  await pass();
  const [first] = await orders.all();
  await orders.swap(first!.id, "ordered", "aborted");
  await orders.remove(first!.id);
  await pass(10_000);
  expect(await orders.all()).toHaveLength(1);
});

test("no pass runs within 10 s of the last one", async () => {
  const { pass, orders } = await world();
  await pass();
  const [first] = await orders.all();
  await orders.swap(first!.id, "ordered", "aborted");
  await orders.remove(first!.id);
  // Guard: the interval. Nothing is busy now, so only it holds the next order back.
  await pass(5000);
  expect(await orders.all()).toEqual([]);
  await pass(5000);
  expect(await orders.all()).toHaveLength(1);
});

test("the pass interval runs on the monotonic clock, not on the wall clock", async () => {
  // The wall clock steps back 20 s; the monotonic clock goes on.
  let shift = 0;
  const { pass, orders } = await world(undefined, [], { now: () => clock + shift, monotonic: () => clock });
  await pass();
  const [first] = await orders.all();
  await orders.swap(first!.id, "ordered", "aborted");
  await orders.remove(first!.id);
  shift = -20_000;
  await pass(5000);
  expect(await orders.all()).toEqual([]);
  // Guard: 10 s by the monotonic clock. By the wall clock only -10 s have passed.
  await pass(5000);
  expect(await orders.all()).toHaveLength(1);
});

test("an aborted order rests the pair, not the old owner: it may give another block elsewhere, and not to the same new owner", async () => {
  // c joins and owns nothing: a gives it a block. The order is given up on (a hold on a, say), without a reason.
  const { pass, orders } = await world(undefined, ["c"]);
  await pass();
  const [first] = await orders.all();
  expect(first).toMatchObject({ from: "a", to: "c" });
  await orders.swap(first!.id, "ordered", "aborted");
  await pass(10_000);
  const later = ((await orders.all()) as any[]).filter((order) => order.id !== first!.id);
  // Guard: a sends nothing to c for the rest, and the block rests. Without the pair rest the same order comes again.
  expect(later.some((order) => order.from === "a" && order.to === "c")).toBe(false);
  expect(later.some((order) => order.bx === first!.bx && order.by === first!.by)).toBe(false);
  // Guard: a is not out (the planner's input does not name it busy), only barred from c. See the plan test below.
  await pass(MOVE_BACKOFF_MS);
  expect(((await orders.all()) as any[]).some((order) => order.id !== first!.id && order.from === "a" && order.to === "c")).toBe(true);
});

test("an order aborted unreachable rests the pair for MOVE_BACKOFF_MS and does not lengthen the block's rest", async () => {
  const { pass, orders, store: worldStore } = await world(undefined, ["c"]);
  const ended = new BlockMoveOrders(worldStore);
  const toC = async () => ((await orders.all()) as any[]).filter((order) => order.from === "a" && order.to === "c");
  await pass();
  const [first] = await toC();
  expect(first).toBeDefined();
  await ended.swapWith(first.id, "ordered", "aborted", { reason: "unreachable" });
  await pass(10_000);
  // Guard: a sends nothing to c for the rest.
  expect(await toC()).toHaveLength(1);
  await pass(MOVE_BACKOFF_MS);
  const second = (await toC()).find((order) => order.id !== first.id);
  expect(second).toBeDefined();
  await ended.swapWith(second.id, "ordered", "aborted", { reason: "unreachable" });
  // Guard: the second abort is not a failure of the block. Counted, the block would rest 120 s and this order would not come.
  await pass(MOVE_BACKOFF_MS + 1_000);
  expect(await toC()).toHaveLength(3);
});

for (const reason of [undefined, "unreachable"] as const) test(`an order aborted ${reason ?? "with no reason"} leaves the old owner free: it gives another block to another node`, async () => {
  // a owns 1,0 and 1,1 (light) and 0,2 (heavy); b borders 1,0 and c borders 1,1.
  const owners: MapBlocks["owners"] = { "0,0": owner("b", 1, T0 - 60_000), "1,0": owner("a", 2, T0 - 60_000), "1,1": owner("a", 3, T0 - 60_000), "2,1": owner("c", 4, T0 - 60_000), "0,2": owner("a", 5, T0 - 60_000) };
  const reports = () => [report("a", { "main|1,0": 40, "main|1,1": 40, "main|0,2": 120 }), report("b", { "main|0,0": 5 }), report("c", { "main|2,1": 5 })];
  const { pass, orders, store: worldStore } = await world(undefined, ["c"], {}, { table: { epoch: 5, owners }, reports });
  await pass();
  const [first] = await orders.all();
  expect(first).toMatchObject({ from: "a", to: "b", bx: 1, by: 0 });
  // The order is given up on (with the block of a held on a), or aborted by a probe that b did not answer.
  if (reason) await new BlockMoveOrders(worldStore).swapWith(first!.id, "ordered", "aborted", { reason });
  else await orders.swap(first!.id, "ordered", "aborted");
  await pass(10_000);
  const later = ((await orders.all()) as any[]).filter((order) => order.id !== first!.id);
  // Guard: a is not rested. Resting both nodes (the old rule) leaves a with its held block unable to send anything else.
  expect(later).toHaveLength(1);
  expect(later[0]).toMatchObject({ from: "a", to: "c", bx: 1, by: 1 });
});

test("a block refused because its old owner holds it rests longer each time, and rests no node and no pair", async () => {
  const owners: MapBlocks["owners"] = { "0,0": owner("b", 1, T0 - 60_000), "1,0": owner("a", 2, T0 - 60_000), "1,1": owner("a", 3, T0 - 60_000), "2,1": owner("c", 4, T0 - 60_000), "0,2": owner("a", 5, T0 - 60_000) };
  const reports = () => [report("a", { "main|1,0": 40, "main|1,1": 40, "main|0,2": 120 }), report("b", { "main|0,0": 5 }), report("c", { "main|2,1": 5 })];
  const { pass, orders, store: worldStore } = await world(undefined, ["c"], {}, { table: { epoch: 5, owners }, reports });
  const ended = new BlockMoveOrders(worldStore);
  const forBlock = async (bx: number, by: number) => ((await orders.all()) as any[]).filter((order) => order.bx === bx && order.by === by);
  await pass();
  const [first] = await forBlock(1, 0);
  expect(first).toMatchObject({ from: "a", to: "b" });
  // The sender still holds block 1,0 from an earlier order: this one is refused unstarted.
  await ended.swapWith(first.id, "ordered", "aborted", { reason: "held" });
  await pass(10_000);
  // Guard: no node rests. The sender gives its other block to c at once. With a "busy" abort both nodes rest 60 s.
  const [other] = await forBlock(1, 1);
  expect(other).toMatchObject({ from: "a", to: "c" });
  await ended.swapWith(other.id, "ordered", "aborted", { reason: "unreachable" });
  // The first rest (60 s) over: the block may be ordered again.
  await pass(MOVE_BACKOFF_MS + 1_000);
  expect(await forBlock(1, 0)).toHaveLength(2);
  const second = (await forBlock(1, 0)).find((order) => order.id !== first.id);
  await ended.swapWith(second.id, "ordered", "aborted", { reason: "held" });
  // Guard: it counts against the block. A second refusal in a row rests it 120 s, so not again after 61 s (a "busy" abort would not escalate).
  await pass(MOVE_BACKOFF_MS + 1_000);
  expect(await forBlock(1, 0)).toHaveLength(2);
  await pass(MOVE_BACKOFF_MS);
  expect(await forBlock(1, 0)).toHaveLength(3);
});

test("a sender barred from one new owner still gives a block to another", () => {
  // a owns 1,0 and 1,1; b borders 1,0 on the left and c on the right, both light.
  const owners: MapBlocks["owners"] = { "0,0": owner("b", 1), "1,0": owner("a", 2), "2,0": owner("c", 3), "1,1": owner("a", 4) };
  const input = {
    now: T0,
    tables: [{ map: "main", table: { epoch: 4, owners } }],
    loads: [report("a", { "main|1,0": 40, "main|1,1": 160 }), report("b", { "main|0,0": 5 }), report("c", { "main|2,0": 5 })],
    busy: new Set<string>(),
  };
  // Not barred: b, the first by name among equals.
  expect(planRebalance(input)).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "b", blockEpoch: 2, load: 40 }]);
  // Guard: barred from b, a is not out; it gives the block to c.
  expect(planRebalance({ ...input, noReceiveFrom: new Map([["a", new Set(["b"])]]) })).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "c", blockEpoch: 2, load: 40 }]);
  // Barred from both, it gives nothing; the bar is by sender, so it does not stop another node's moves.
  expect(planRebalance({ ...input, noReceiveFrom: new Map([["a", new Set(["b", "c"])]]) })).toEqual([]);
  expect(planRebalance({ ...input, noReceiveFrom: new Map([["c", new Set(["b"])]]) })).toHaveLength(1);
});

test("an empty node is not given a block by a sender barred from it", () => {
  const input = { now: T0, tables: [{ map: "main", table: table() }], loads: heavyA(), live: ["a", "b", "c"], busy: new Set<string>() };
  expect(planRebalance(input)).toEqual([{ map: "main", bx: 1, by: 0, from: "a", to: "c", blockEpoch: 2, load: 50 }]);
  // Guard: a is the giver; barred from c, the next giver, b (two blocks), is tried instead.
  const moves = planRebalance({ ...input, noReceiveFrom: new Map([["a", new Set(["c"])]]) });
  expect(moves.every((move) => !(move.from === "a" && move.to === "c"))).toBe(true);
});

test("a leader that loses the lock while it plans writes no order", async () => {
  const { store, coordinator, told, pass, orders } = await world();
  const members = store.members.bind(store);
  let taken = false;
  store.members = async (key) => {
    // Another coordinator takes the lock while this one reads the open orders, after its lock check for the pass.
    if (key === MOVES_KEY && !taken) {
      taken = true;
      await store.set("cells:coordinator", JSON.stringify({ holder: "other", epoch: 99 }), 60_000);
    }
    return members(key);
  };
  await pass();
  store.members = members;
  // Guard: confirm() before each order.
  expect(await orders.all()).toEqual([]);
  expect(told).toEqual([]);
  expect(coordinator.isLeader()).toBe(false);
});

test("a live node that owns no block is ordered a block of the most loaded node", async () => {
  const { told, pass, orders } = await world(undefined, ["c"]);
  await pass();
  const all = await orders.all();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ state: "ordered", map: "main", bx: 1, by: 0, from: "a", to: "c", blockEpoch: 2 });
  expect(told).toEqual([{ id: all[0]!.id }]);
});

test("while a table cannot be read, a live node that owns no block in the others is given none", async () => {
  const { store, pass, orders } = await world(undefined, ["c"]);
  quiet.push(spyOn(log, "error").mockImplementation(() => {}));
  await new MapCatalogue(store).publish([extentOf("side", 4096, 4096)]);
  await store.set("cells:blocks:side", "not a table");
  await pass();
  // Guard: c may own blocks in the table that cannot be read, so it is no receiver; the neighbour rule still runs.
  const all = await orders.all();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ map: "main", bx: 1, by: 0, from: "a", to: "b" });
});

test("rebalanceEveryMs 0 turns it off", async () => {
  const { pass, orders } = await world(0);
  for (let i = 0; i < 15; i++) await pass();
  expect(await orders.all()).toEqual([]);
});

test("a coordinator that is not the leader writes no order", async () => {
  const { store, pass, orders } = await world();
  await store.set("cells:coordinator", JSON.stringify({ holder: "other", epoch: 99 }), 60_000);
  for (let i = 0; i < 12; i++) await pass();
  expect(await orders.all()).toEqual([]);
});

// ---- the clean-up left from the dead-node takeover (task 8 notes)

test("a guarded sweep takes out of the dead node's set the names it no longer holds", async () => {
  const store = new MemoryStore();
  const c = new PlayerDirectory(store, "c");
  for (const name of ["carol", "dave", "erin"]) await c.claim(name, name, "main");
  // dave is held by a now, but still listed under c; erin's entry is gone.
  await new PlayerDirectory(store, "a").claim("dave", "dave", "main");
  await store.addToSet("cells:dirnode:c", "dave");
  await store.del("cells:dir:erin");
  // A new run holds the node: nothing is deleted, but the names it does not hold still go.
  expect(await c.sweepNode("c", async () => false)).toBe(0);
  // Guard: the leftover clean-up. Without it dave and erin stay in c's set for good.
  expect(await c.playersOn("c")).toEqual(["carol"]);
  expect((await c.get("carol"))?.nodeId).toBe("c");
  expect((await c.get("dave"))?.nodeId).toBe("a");
  expect(await store.members("cells:dirnode:a")).toEqual(["dave"]);
  // With nothing of the node's held, the leftovers go too.
  await store.addToSet("cells:dirnode:c", "erin");
  expect(await c.sweepNode("c", async () => true)).toBe(1);
  expect(await c.playersOn("c")).toEqual([]);
  expect(await c.get("carol")).toBeNull();
});

test("a leftover name the node claims again while it is dropped stays in the set", async () => {
  const store = new MemoryStore();
  const c = new PlayerDirectory(store, "c");
  await store.addToSet("cells:dirnode:c", "erin");
  const remove = store.removeFromSet.bind(store);
  store.removeFromSet = async (key, member) => {
    await remove(key, member);
    // A claim of the new run writes its entry here; it joins the set only after the sweep looked.
    if (member === "erin") await store.set("cells:dir:erin", JSON.stringify({ nodeId: "c", playerId: "erin", epoch: 5, map: "main" }));
  };
  expect(await c.sweepNode("c", async () => false)).toBe(0);
  // Guard: the put-back after the removal.
  expect(await c.playersOn("c")).toEqual(["erin"]);
});

// Two nodes own main; c is announced and owns nothing.
async function idleWorld(cInfo: NodeInfo = info("c")) {
  const store = new MemoryStore();
  const registry = new NodeRegistry(store);
  await new MapCatalogue(store).publish([extentOf("main", 2 * 4096, 4096)]);
  for (const node of [info("a"), info("b"), cInfo]) await registry.announce(node);
  await new BlockTable(store).write("main", { epoch: 1, owners: { "0,0": owner("a"), "1,0": owner("b") } });
  const coordinator = new Coordinator(store, new ClusterBus(store, "coord", TEST_BUS_KEY), { id: "coord", now: () => clock, rebalanceEveryMs: 0 });
  const heard: any[] = [];
  const listener = new ClusterBus(store, "a", TEST_BUS_KEY);
  listener.on("node-dead", (data) => { heard.push(data); });
  await listener.start();
  buses.push(listener);
  // One pass per second; a and b beat, the others only when asked.
  const second = async (...also: string[]) => {
    advance(1000);
    for (const id of ["a", "b", ...also]) await registry.beat(id);
    await coordinator.tick();
    await settle();
  };
  return { store, registry, heard, second };
}

test("a run never seen live that owns no block is forgotten after 60 s", async () => {
  const { registry, heard, second } = await idleWorld();
  for (let i = 0; i < 55; i++) await second();
  expect(await registry.known()).toContain("c");
  for (let i = 0; i < 10; i++) await second();
  // Guard: watchIdle. Without it c stays known for good (task 8 re-review 2, M-f).
  expect(await registry.known()).not.toContain("c");
  expect(await registry.info("c")).toBeNull();
  expect((await registry.known()).sort()).toEqual(["a", "b"]);
  expect(heard).toEqual([]);
});

test("the run a takeover kept, which then never beats, is forgotten", async () => {
  const kept = { ...info("c"), startedAt: T0 + 500 };
  const { store, registry, second } = await idleWorld(kept);
  // The takeover of run T0 left its tombstone and forgot the run record; the new run never beat.
  await store.set(deadKey("c"), JSON.stringify({ nodeId: "c", startedAt: T0, at: T0 }), 600_000);
  for (let i = 0; i < 55; i++) await second();
  expect((await registry.info("c"))?.startedAt).toBe(T0 + 500);
  for (let i = 0; i < 10; i++) await second();
  expect(await registry.known()).not.toContain("c");
});

test("an older recorded run of a node whose new run never beats is told dead before the node is forgotten", async () => {
  const { store, registry, heard, second } = await idleWorld();
  await store.set("cells:noderun:c", JSON.stringify({ startedAt: T0 - 5000, live: true }));
  await second();
  expect(heard).toEqual([{ nodeId: "c", startedAt: T0 - 5000, restarted: true }]);
  for (let i = 0; i < 65; i++) await second();
  expect(await registry.known()).not.toContain("c");
  expect(heard).toHaveLength(1);
  expect(await store.get("cells:noderun:c")).toBeNull();
});

test("a run seen live keeps its announcement once it stops, as a retired node does", async () => {
  const { registry, second } = await idleWorld();
  for (let i = 0; i < 3; i++) await second("c");
  await registry.retire("c");
  for (let i = 0; i < 70; i++) await second();
  // Guard: the seen-live check in watchIdle.
  expect(await registry.known()).toContain("c");
  expect((await registry.info("c"))?.startedAt).toBe(T0);
});

test("a node that beats again before 60 s is not forgotten", async () => {
  const { registry, second } = await idleWorld();
  for (let i = 0; i < 50; i++) await second();
  await second("c");
  for (let i = 0; i < 70; i++) await second();
  expect(await registry.known()).toContain("c");
});

test("a node whose first beat lands during the pass that would forget it is kept", async () => {
  const { store, registry, second } = await idleWorld();
  for (let i = 0; i < 60; i++) await second();
  const get = store.get.bind(store);
  let beaten = false;
  store.get = async (key) => {
    // After this pass read who is live: c beats at last.
    if (key === deadKey("c") && !beaten) {
      beaten = true;
      await registry.beat("c");
    }
    return get(key);
  };
  await second();
  store.get = get;
  // Guard: the fresh isAlive in watchIdle.
  expect(await registry.known()).toContain("c");
  for (let i = 0; i < 70; i++) await second("c");
  expect(await registry.known()).toContain("c");
});

test("a node that announces a new run while it is counted idle starts its count over", async () => {
  const { registry, second } = await idleWorld();
  for (let i = 0; i < 55; i++) await second();
  await registry.announce({ ...info("c"), startedAt: T0 + 55_000 });
  for (let i = 0; i < 10; i++) await second();
  // Guard: the reset on a new run. Without it the new run is forgotten 60 s after the old one was first counted.
  expect((await registry.info("c"))?.startedAt).toBe(T0 + 55_000);
  for (let i = 0; i < 60; i++) await second();
  expect(await registry.known()).not.toContain("c");
});

test("a leader that loses the lock in the pass that would forget an idle node forgets nothing", async () => {
  const { store, registry, second } = await idleWorld();
  for (let i = 0; i < 60; i++) await second();
  const get = store.get.bind(store);
  store.get = async (key) => (key === "cells:coordinator" ? JSON.stringify({ holder: "other", epoch: 99 }) : get(key));
  await second();
  store.get = get;
  // Guard: confirm() in watchIdle.
  expect(await registry.known()).toContain("c");
});

test("a coordinator that leads again counts an idle node from the start", async () => {
  const { store, registry, second } = await idleWorld();
  for (let i = 0; i < 55; i++) await second();
  await store.set("cells:coordinator", JSON.stringify({ holder: "other", epoch: 99 }), 60_000);
  for (let i = 0; i < 2; i++) await second();
  await store.del("cells:coordinator");
  for (let i = 0; i < 10; i++) await second();
  // Guard: the idle counts are dropped on gaining the lead.
  expect(await registry.known()).toContain("c");
  for (let i = 0; i < 60; i++) await second();
  expect(await registry.known()).not.toContain("c");
});
