import { expect, test } from "bun:test";
import { MIRROR_KEEP_PX, MIRROR_RADIUS_PX, linkPartners, mirrorTargets, neighbourNodes, nodesWithin, type Owners } from "../cluster/strip";

const own = (nodeId: string) => ({ nodeId, epoch: 1, since: 0 });
// Two columns of blocks: x 0-4095 is "a", x 4096-8191 is "b". One row.
const owners: Owners = { "0,0": own("a"), "1,0": own("b") };

test("an entity near the border is mirrored to the other side only", () => {
  expect([...nodesWithin(owners, 4096 - 1000, 100, MIRROR_RADIUS_PX, "a")]).toEqual(["b"]);
  expect([...nodesWithin(owners, 4096 - 1300, 100, MIRROR_RADIUS_PX, "a")]).toEqual([]);
  expect([...nodesWithin(owners, 100, 100, MIRROR_RADIUS_PX, "a")]).toEqual([]);
});

test("the distance is to the block's rectangle, corners included", () => {
  const four: Owners = { "0,0": own("a"), "1,0": own("b"), "0,1": own("c"), "1,1": own("d") };
  // 800 px from both edges: the diagonal block is 1131 px away.
  const near = nodesWithin(four, 4096 - 800, 4096 - 800, MIRROR_RADIUS_PX, "a");
  expect([...near].sort()).toEqual(["b", "c", "d"]);
  // 900 px from both: the diagonal block is 1273 px away, too far.
  const far = nodesWithin(four, 4096 - 900, 4096 - 900, MIRROR_RADIUS_PX, "a");
  expect([...far].sort()).toEqual(["b", "c"]);
});

test("a mirror is kept to 1314 px, then dropped", () => {
  const was = new Set(["b"]);
  expect([...mirrorTargets(owners, 4096 - 1300, 0, "a", was)]).toEqual(["b"]);
  expect([...mirrorTargets(owners, 4096 - MIRROR_KEEP_PX - 1, 0, "a", was)]).toEqual([]);
  // Without a mirror already there, 1300 px is too far to start one.
  expect([...mirrorTargets(owners, 4096 - 1300, 0, "a", new Set())]).toEqual([]);
});

test("neighbours are the other owners around this node's blocks", () => {
  const map1: Owners = { "0,0": own("a"), "1,0": own("b"), "2,0": own("c") };
  const map2: Owners = { "0,0": own("d"), "0,1": own("a") };
  expect([...neighbourNodes([map1, map2], "a")].sort()).toEqual(["b", "d"]);
  expect([...neighbourNodes([map1], "c")]).toEqual(["b"]);
  expect([...neighbourNodes([map1], "z")]).toEqual([]);
});

// A node that owns no block borders no one, but a block move needs a link between its old and its new owner.
test("a node that owns blocks also links with the live nodes that own none", () => {
  const map1: Owners = { "0,0": own("a"), "1,0": own("b") };
  expect([...linkPartners([map1], "a", ["a", "b", "c"])].sort()).toEqual(["b", "c"]);
  expect([...linkPartners([map1], "b", ["a", "b", "c", "d"])].sort()).toEqual(["a", "c", "d"]);
});

test("a node that owns no block links with every live node", () => {
  const map1: Owners = { "0,0": own("a"), "1,0": own("b") };
  expect([...linkPartners([map1], "c", ["a", "b", "c"])].sort()).toEqual(["a", "b"]);
  expect([...linkPartners([], "c", ["a", "c"])]).toEqual(["a"]);
});

test("nodes that are not live are not link partners, and neighbours stay whatever the live list says", () => {
  const map1: Owners = { "0,0": own("a"), "1,0": own("b") };
  expect([...linkPartners([map1], "a", [])]).toEqual(["b"]);
  expect([...linkPartners([map1], "c", [])]).toEqual([]);
});
