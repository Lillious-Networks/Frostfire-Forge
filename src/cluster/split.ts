// How the coordinator lays a map's blocks out among nodes when the map has no
// table yet: the blocks are walked in a snake (a column down, the next column
// back up, along the longer side of the grid) and cut into runs, one run per
// node, each run holding its share of the total weight. Neighbours in the walk
// are neighbours on the map, so every run is one connected area and a node's
// border with the next stays about one line of blocks long. With equal weights
// the runs differ by at most one block (64 blocks among 3 nodes: 21, 22, 21),
// where cutting whole columns gave 24, 20, 20.
// Pure: the same inputs (in any order of node ids) give the same split. It is
// only used for a map that has no table; a block already in a table is never moved by it.

/**
 * Block key `"${bx},${by}"` to node id. `weight` (per block, default 1) is what the
 * runs are balanced by; a negative or non-number weight counts as 0. With more
 * nodes than blocks some nodes get none; with weights, a node whose share falls
 * inside one heavy block may get none either.
 */
export function splitBlocks(
  blocksX: number,
  blocksY: number,
  nodeIds: string[],
  weight?: (bx: number, by: number) => number,
): Map<string, string> {
  const split = new Map<string, string>();
  const nodes = [...new Set(nodeIds)].sort();
  if (nodes.length === 0 || blocksX <= 0 || blocksY <= 0) return split;

  // The walk: lines along the longer side, so the cut between two runs crosses the shorter one.
  const acrossX = blocksX >= blocksY;
  const lines = acrossX ? blocksX : blocksY;
  const breadth = acrossX ? blocksY : blocksX;
  const walk: Array<[number, number]> = [];
  for (let line = 0; line < lines; line++) {
    for (let step = 0; step < breadth; step++) {
      const across = line % 2 === 0 ? step : breadth - 1 - step;
      walk.push(acrossX ? [line, across] : [across, line]);
    }
  }

  // Each block's weight once, in walk order. All weightless counts the blocks as equal.
  let weights = walk.map(([bx, by]) => {
    const value = weight ? Number(weight(bx, by)) : 1;
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  let total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) {
    weights = weights.map(() => 1);
    total = weights.length;
  }

  // A block belongs to the node whose share of the total holds the block's midpoint.
  let before = 0;
  for (let i = 0; i < walk.length; i++) {
    const index = Math.min(nodes.length - 1, Math.floor(((before + weights[i]! / 2) * nodes.length) / total));
    const [bx, by] = walk[i]!;
    split.set(`${bx},${by}`, nodes[index]!);
    before += weights[i]!;
  }
  return split;
}
