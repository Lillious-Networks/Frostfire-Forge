import { expect, test } from "bun:test";
import { splitBlocks } from "../cluster/split";

// Every block of the grid has exactly one node, and each node's blocks are one connected area.
function expectValid(split: Map<string, string>, blocksX: number, blocksY: number): Map<string, string[]> {
  expect(split.size).toBe(blocksX * blocksY);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) expect(split.has(`${bx},${by}`)).toBe(true);
  }
  const byNode = new Map<string, string[]>();
  for (const [key, node] of split) byNode.set(node, [...(byNode.get(node) ?? []), key]);
  for (const keys of byNode.values()) {
    const left = new Set(keys);
    const queue = [keys[0]!];
    left.delete(keys[0]!);
    while (queue.length > 0) {
      const [x, y] = queue.pop()!.split(",").map(Number) as [number, number];
      for (const next of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) {
        if (left.delete(next)) queue.push(next);
      }
    }
    expect(left.size).toBe(0);
  }
  return byNode;
}

test("two nodes on 80x80 get 3200 blocks each", () => {
  const byNode = expectValid(splitBlocks(80, 80, ["a", "b"]), 80, 80);
  expect(byNode.get("a")!.length).toBe(3200);
  expect(byNode.get("b")!.length).toBe(3200);
});

test("three nodes share 8x8 as 21, 21 and 22 blocks, not 24, 20 and 20", () => {
  const byNode = expectValid(splitBlocks(8, 8, ["node-1", "node-2", "node-3"]), 8, 8);
  expect([...byNode.keys()].sort()).toEqual(["node-1", "node-2", "node-3"]);
  expect([...byNode.values()].map((keys) => keys.length).sort()).toEqual([21, 21, 22]);
  expect(byNode.get("node-1")!.length).toBeLessThanOrEqual(22);
});

test("blocks per node differ by at most one, for any grid and node count", () => {
  for (const [blocksX, blocksY] of [[8, 8], [80, 80], [13, 9], [5, 3], [3, 11], [7, 7], [1, 10], [16, 4]] as const) {
    for (let count = 1; count <= Math.min(12, blocksX * blocksY); count++) {
      const ids = Array.from({ length: count }, (_, i) => `n${i}`);
      const byNode = expectValid(splitBlocks(blocksX, blocksY, ids), blocksX, blocksY);
      expect(byNode.size).toBe(count);
      const sizes = [...byNode.values()].map((keys) => keys.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  }
});

test("weights move the cut: the node on the heavy side gets fewer blocks", () => {
  // The left quarter weighs as much as the rest put together.
  const weight = (bx: number) => (bx < 20 ? 3 : 1);
  const split = splitBlocks(80, 80, ["a", "b"], weight);
  const byNode = expectValid(split, 80, 80);
  const left = split.get("0,0")!;
  const right = split.get("79,0")!;
  expect(left).not.toBe(right);
  expect(byNode.get(left)!.length).toBe(20 * 80);
  expect(byNode.get(right)!.length).toBe(60 * 80);
});

test("one node owns every block", () => {
  const byNode = expectValid(splitBlocks(5, 3, ["solo"]), 5, 3);
  expect(byNode.get("solo")!.length).toBe(15);
});

test("more nodes than blocks: each block has one node, some nodes have none", () => {
  const split = splitBlocks(2, 1, ["a", "b", "c", "d", "e"]);
  const byNode = expectValid(split, 2, 1);
  expect(byNode.size).toBe(2);
  for (const keys of byNode.values()) expect(keys.length).toBe(1);

  const grid = expectValid(splitBlocks(3, 3, ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11"]), 3, 3);
  expect(grid.size).toBe(9);
  for (const keys of grid.values()) expect(keys.length).toBe(1);
});

test("the same inputs give the same split, whatever the order of the node ids", () => {
  const weight = (bx: number, by: number) => 1 + ((bx * 7 + by * 13) % 5);
  const first = splitBlocks(13, 9, ["c", "a", "b", "d"], weight);
  const again = splitBlocks(13, 9, ["c", "a", "b", "d"], weight);
  const shuffled = splitBlocks(13, 9, ["d", "b", "a", "c"], weight);
  expect([...again]).toEqual([...first]);
  expect([...shuffled]).toEqual([...first]);
  expectValid(first, 13, 9);
});

test("no nodes or no blocks: nothing is assigned", () => {
  expect(splitBlocks(4, 4, []).size).toBe(0);
  expect(splitBlocks(0, 4, ["a"]).size).toBe(0);
});
