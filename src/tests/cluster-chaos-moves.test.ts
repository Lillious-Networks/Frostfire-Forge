import { expect, test } from "bun:test";
import { creatureTotal, ownerChanges, type Order, type Owner } from "../docker/chaos-moves";

// The chaos check "no block changed owner during the outage" must not count the rebalancer's own moves.

const owners = (entries: Record<string, string>) => new Map<string, Owner>(Object.entries(entries).map(([key, nodeId]) => [key, { nodeId }]));
const order = (id: string, state: string, to: string, bx = 3, by = 4): Order => ({ id, state, map: "overworld", bx, by, from: "node-1", to });
const orders = (...list: Order[]) => new Map(list.map((o) => [o.id, o]));

test("a block moved by an order committed since the start is not a change of owner", () => {
  const before = owners({ "overworld|3,4": "node-1", "overworld|0,0": "node-2" });
  const after = owners({ "overworld|3,4": "node-3", "overworld|0,0": "node-2" });
  const result = ownerChanges(before, after, orders(), orders(order("a", "done", "node-3")));
  expect(result).toEqual({ changed: ["overworld|3,4"], unexplained: [] });
});

test("an order still open at the start and committed since explains its move, a sent one too", () => {
  const before = owners({ "overworld|3,4": "node-1" });
  const after = owners({ "overworld|3,4": "node-2" });
  expect(ownerChanges(before, after, orders(order("a", "sending", "node-2")), orders(order("a", "done", "node-2"))).unexplained).toEqual([]);
  expect(ownerChanges(before, after, orders(order("a", "ordered", "node-2")), orders(order("a", "sent", "node-2"))).unexplained).toEqual([]);
});

test("an order that was committed before the start explains nothing of the window", () => {
  const before = owners({ "overworld|3,4": "node-2" });
  const after = owners({ "overworld|3,4": "node-3" });
  const old = order("a", "done", "node-2");
  expect(ownerChanges(before, after, orders(old), orders(old)).unexplained).toEqual(["overworld|3,4"]);
});

test("a change with no order, to another node than the order's, or from an aborted order stays unexplained", () => {
  const before = owners({ "overworld|3,4": "node-1", "overworld|5,5": "node-1", "overworld|6,6": "node-3" });
  const after = owners({ "overworld|3,4": "node-2", "overworld|5,5": "node-2", "overworld|6,6": "node-1" });
  const result = ownerChanges(before, after, orders(), orders(order("a", "done", "node-3", 3, 4), order("b", "aborted", "node-2", 5, 5)));
  // The takeover of a dead node's block (6,6) has no order either.
  expect(result.unexplained).toEqual(["overworld|3,4", "overworld|5,5", "overworld|6,6"]);
});

test("a world where no block changed owner has no changes", () => {
  const same = owners({ "overworld|3,4": "node-1" });
  expect(ownerChanges(same, owners({ "overworld|3,4": "node-1" }), orders(), orders(order("a", "done", "node-2")))).toEqual({ changed: [], unexplained: [] });
});

test("an order that was sent at the start and is done now explains a commit that landed in the window", () => {
  const before = owners({ "overworld|3,4": "node-1" });
  const after = owners({ "overworld|3,4": "node-2" });
  expect(ownerChanges(before, after, orders(order("a", "sent", "node-2")), orders(order("a", "done", "node-2"))).unexplained).toEqual([]);
});

// The check "none doubled, none lost" counts every creature of the world. `creatures` of a load report is the awake
// ones only, and moves with the players, so the harness must not read it.
test("the world's creatures are the nodes' creaturesTotal, never the awake count", () => {
  const loads = [{ creatures: 2, creaturesTotal: 40 }, { creatures: 0, creaturesTotal: 35 }, { creatures: 9, creaturesTotal: 25 }];
  expect(creatureTotal(loads)).toBe(100);
  // Players move and the awake counts change; the total does not.
  expect(creatureTotal(loads.map((load) => ({ ...load, creatures: load.creatures + 7 })))).toBe(100);
  // A node with no report, or a report from before the field, gives no total (it is not read as the awake count).
  expect(creatureTotal([...loads, null])).toBeNull();
  expect(creatureTotal([{ creatures: 5 }, { creatures: 6, creaturesTotal: 1 }])).toBeNull();
});
