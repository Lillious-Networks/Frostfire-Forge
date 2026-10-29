import { blockKey, type MapBlocks } from "./blocks";
import type { LoadReport } from "./nodes";

// Which blocks to move off overloaded nodes (spec §2). A node above OVERLOAD_RATIO times the average load, and at
// least MIN_OVERLOAD over it, gives one edge block to its least-loaded neighbour across that edge. Only a block held
// for MIN_BLOCK_AGE_MS moves,
// and only when the neighbour stays below the sender afterwards, so a block cannot swing back and forth. A node
// is in one move at a time, as sender or receiver, and rests for NODE_COOLDOWN_MS after one (longer after an aborted
// one, coordinator.ts). A node that reports an event-loop lag over MOVE_LAG_LIMIT_MS receives no block, and one over
// MOVE_SENDER_LAG_LIMIT_MS sends none. A block's weight is its
// owner's report only. Pure: the coordinator reads the tables and reports, and
// writes the orders.
// A live node that owns no block (a node that joined a running cluster, or one restarted after a takeover gave its
// blocks to its neighbours: the takeover fills, it does not split, preflight C6) borders no one, so the neighbour
// rule never reaches it. It is given one edge block of the most loaded node that owns at least two, and grows by the
// neighbour rule from there. The giver need not be over the ratio, so an empty node gets a first block in a cluster of
// any size (preflight C6). The same age, hysteresis and busy rules apply.
//
// Clocks: `now` is wall time, because it is compared with each owner's `since`, which the coordinator that gave
// the block stored (a value read across hosts). The pass interval is kept by the coordinator on its own monotonic
// clock.

export const REBALANCE_EVERY_MS = 10_000;
export const OVERLOAD_RATIO = 1.08;
/**
 * A node is a sender only if its load also exceeds the average by this much, so a quiet cluster does not move
 * blocks.
 */
export const MIN_OVERLOAD = 25;
export const MIN_BLOCK_AGE_MS = 30_000;
/**
 * After a node sent or received a block, no move is planned from or to it for this long. A move changes the node's
 * load only once its players and creatures have crossed (tens of seconds), so the next report still shows the old
 * overload. The coordinator reads it from the closed orders (coordinator.ts rebalance).
 */
export const NODE_COOLDOWN_MS = 60_000;
/**
 * A node whose event loop was held up longer than this in the last few seconds (LoadReport.lagMs) receives no block.
 * A lagging receiver does not answer the take in time, so the move ends aborted and the block sits frozen. The limit
 * sits between the nodes of the
 * limit runs: at 1,750 spread bots the longest tick was 210 ms at most (90th percentile 159 ms); at 2,125 the nodes
 * that lagged ran 430 ms and more at the median and reached 740 ms. A report without the field never lags.
 */
export const MOVE_LAG_LIMIT_MS = 250;
/**
 * The same for a sender, much higher: moving load off a lagging node is the relief, so a node that is behind may still
 * give a block away. A slow sender is covered by the old owner's hold and the block's backoff (blockmove.ts,
 * coordinator.ts); only a node past this is too far gone to run a move.
 */
export const MOVE_SENDER_LAG_LIMIT_MS = 1000;
/** A block lighter than this share of the sender's overload above the average is not worth a move. */
export const MIN_BLOCK_SHARE = 0.05;
export const MAX_MOVES_PER_PASS = 4;

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export interface PlannedMove {
  map: string; bx: number; by: number; from: string; to: string; blockEpoch: number; load: number;
}

export interface RebalanceInput {
  now: number;
  tables: Array<{ map: string; table: MapBlocks }>;
  /** Live nodes' reports only. */
  loads: LoadReport[];
  /** Nodes in an open order, as sender or receiver, and those that took part in a move within NODE_COOLDOWN_MS. */
  busy: ReadonlySet<string>;
  /**
   * Every live node (announced, its run beating, not retired), given only when every table was read: a node that
   * owns no block in `tables` may then receive one, and a live node with no report yet counts at load 0. Without
   * it, a node owning no block is left alone (it may own blocks in a table that could not be read).
   */
  live?: readonly string[];
  /**
   * New owners a node may not send to now (an order of the pair ended aborted, coordinator.ts): by old owner. Both nodes
   * stay free for other pairs, so a sender that is stuck with one new owner can still give a block to another.
   */
  noReceiveFrom?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface RebalanceOptions { ratio?: number; minOverload?: number; minAgeMs?: number; maxMoves?: number }

export function nodeLoad(report: LoadReport): number {
  let total = 0;
  for (const value of Object.values(report.blocks ?? {})) total += Number(value) || 0;
  return total;
}

/**
 * Whether the node reports an event-loop delay over `limit` (the receiver's by default). A report without the field
 * does not.
 */
export function isLagging(report: LoadReport, limit: number = MOVE_LAG_LIMIT_MS): boolean {
  return typeof report.lagMs === "number" && report.lagMs > limit;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function planRebalance(input: RebalanceInput, opts: RebalanceOptions = {}): PlannedMove[] {
  const ratio = opts.ratio ?? OVERLOAD_RATIO;
  const minOverload = opts.minOverload ?? MIN_OVERLOAD;
  const minAgeMs = opts.minAgeMs ?? MIN_BLOCK_AGE_MS;
  const maxMoves = opts.maxMoves ?? MAX_MOVES_PER_PASS;
  const load = new Map<string, number>();
  const blockLoad = new Map<string, number>();
  // A block weighs what its owner reports. A node that moved a block away still reports the creatures it has not
  // handed on, and a neighbour may report the players on its edge: neither is the block's weight.
  const ownerOf = new Map<string, string>();
  for (const { map, table } of input.tables) {
    for (const [key, owner] of Object.entries(table.owners)) {
      if (owner?.nodeId) ownerOf.set(`${map}|${key}`, owner.nodeId);
    }
  }
  for (const report of input.loads) {
    load.set(report.nodeId, nodeLoad(report));
    for (const [key, value] of Object.entries(report.blocks ?? {})) {
      if (ownerOf.get(key) === report.nodeId) blockLoad.set(key, (Number(value) || 0));
    }
  }
  // Every node the average is taken over: a live node with no report counts at load 0.
  const all = new Map(load);
  for (const nodeId of input.live ?? []) if (!all.has(nodeId)) all.set(nodeId, 0);
  if (all.size < 2) return [];
  let sum = 0;
  for (const value of all.values()) sum += value;
  const average = sum / all.size;
  // No load anywhere: nothing is over the ratio, and no block passes hysteresis for an empty node.
  if (average <= 0) return [];
  const busy = new Set(input.busy);
  // A lagging node receives nothing (noReceive); one far behind gives nothing either (busy).
  const noReceive = new Set<string>();
  for (const report of input.loads) {
    if (isLagging(report)) noReceive.add(report.nodeId);
    if (isLagging(report, MOVE_SENDER_LAG_LIMIT_MS)) busy.add(report.nodeId);
  }
  const moves: PlannedMove[] = [];
  if (input.live) seedEmpty(input, all, blockLoad, minAgeMs, maxMoves, busy, noReceive, moves);
  const over = [...load]
    .filter(([, value]) => value > ratio * average && value - average >= minOverload)
    .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
  for (const [from, fromLoad] of over) {
    if (moves.length >= maxMoves) break;
    if (busy.has(from)) continue;
    let best: (PlannedMove & { toLoad: number }) | null = null;
    for (const { map, table } of input.tables) {
      for (const [key, owner] of Object.entries(table.owners)) {
        if (owner?.nodeId !== from || input.now - owner.since < minAgeMs) continue;
        const weight = blockLoad.get(`${map}|${key}`) ?? 0;
        if (weight <= 0 || weight < MIN_BLOCK_SHARE * (fromLoad - average)) continue;
        const [bx, by] = key.split(",").map(Number) as [number, number];
        for (const [dx, dy] of NEIGHBOURS) {
          const to = table.owners[blockKey(bx + dx, by + dy)]?.nodeId;
          if (!to || to === from || busy.has(to) || noReceive.has(to) || !load.has(to)) continue;
          if (input.noReceiveFrom?.get(from)?.has(to)) continue;
          const toLoad = load.get(to)!;
          // The neighbour must stay below the sender, or the block would only move the overload.
          if (toLoad + weight >= fromLoad - weight) continue;
          const candidate = { map, bx, by, from, to, blockEpoch: owner.epoch, load: weight, toLoad };
          if (!best || better(candidate, best)) best = candidate;
        }
      }
    }
    if (!best) continue;
    const { toLoad: _toLoad, ...move } = best;
    moves.push(move);
    busy.add(from);
    busy.add(move.to);
  }
  return moves;
}

// Each live node that owns no block and is not busy is given one block of the most loaded node that owns at least two
// blocks and can give one (hysteresis: the receiver stays below the giver). The giver need not be over the ratio. An
// edge block (one that borders a block of another node, or no block) first; then the heavier block; then by name.
function seedEmpty(
  input: RebalanceInput,
  load: ReadonlyMap<string, number>,
  blockLoad: ReadonlyMap<string, number>,
  minAgeMs: number,
  maxMoves: number,
  busy: Set<string>,
  noReceive: ReadonlySet<string>,
  moves: PlannedMove[],
): void {
  const owned = new Map<string, number>();
  for (const { table } of input.tables) {
    for (const owner of Object.values(table.owners)) {
      if (owner?.nodeId) owned.set(owner.nodeId, (owned.get(owner.nodeId) ?? 0) + 1);
    }
  }
  const empty = [...load.keys()].filter((nodeId) => !owned.has(nodeId)).sort(byName);
  for (const to of empty) {
    if (moves.length >= maxMoves) return;
    if (busy.has(to) || noReceive.has(to)) continue;
    const toLoad = load.get(to) ?? 0;
    const givers = [...load]
      .filter(([nodeId]) => nodeId !== to && (owned.get(nodeId) ?? 0) >= 2 && !busy.has(nodeId))
      .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
    for (const [from, fromLoad] of givers) {
      if (input.noReceiveFrom?.get(from)?.has(to)) continue;
      let best: (PlannedMove & { edge: boolean }) | null = null;
      for (const { map, table } of input.tables) {
        for (const [key, owner] of Object.entries(table.owners)) {
          if (owner?.nodeId !== from || input.now - owner.since < minAgeMs) continue;
          const weight = blockLoad.get(`${map}|${key}`) ?? 0;
          if (toLoad + weight >= fromLoad - weight) continue;
          const [bx, by] = key.split(",").map(Number) as [number, number];
          const edge = NEIGHBOURS.some(([dx, dy]) => table.owners[blockKey(bx + dx, by + dy)]?.nodeId !== from);
          const candidate = { map, bx, by, from, to, blockEpoch: owner.epoch, load: weight, edge };
          if (!best || seedsBetter(candidate, best)) best = candidate;
        }
      }
      if (!best) continue;
      const { edge: _edge, ...move } = best;
      moves.push(move);
      busy.add(from);
      busy.add(to);
      break;
    }
  }
}

function seedsBetter(a: PlannedMove & { edge: boolean }, b: PlannedMove & { edge: boolean }): boolean {
  if (a.edge !== b.edge) return a.edge;
  if (a.load !== b.load) return a.load > b.load;
  return byName(`${a.map}|${a.bx},${a.by}`, `${b.map}|${b.bx},${b.by}`) < 0;
}

// The least loaded neighbour first; then the heavier block (one move does more); then by name, so a plan is stable.
function better(a: PlannedMove & { toLoad: number }, b: PlannedMove & { toLoad: number }): boolean {
  if (a.toLoad !== b.toLoad) return a.toLoad < b.toLoad;
  if (a.load !== b.load) return a.load > b.load;
  return byName(`${a.map}|${a.bx},${a.by}|${a.to}`, `${b.map}|${b.bx},${b.by}|${b.to}`) < 0;
}
