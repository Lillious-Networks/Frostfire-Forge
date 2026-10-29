import type { BlockExtent, BlockOwner } from "./blocks";
import { BLOCK_SIZE_PX, blockKey } from "./blocks";

// The answer to a player's CLUSTER_DEBUG request (any logged-in player gets the table, not only an admin): which node
// owns which block of the map the player is on, for the client's "Cluster Nodes" overlay (F2 menu). Read-only: it
// reads the block table this node already holds in memory (no database or Redis read) and changes nothing.
// Nothing in it names a host, port, secret or player.

/** Most blocks one answer lists: a 64 x 64 grid. The 40 x 40 overworld (1600 blocks) fits; a bigger grid is cut by rows. */
export const MAX_DEBUG_CELLS = 4096;

/** The least time between two answers to one connection (ms). */
export const DEBUG_MIN_GAP_MS = 1000;

/** The node ids in `nodes`; a cell holds an index into it, -1 for a block no one owns. */
export interface ClusterDebugData {
  cluster: true;
  allowed: true;
  /** This node's id. */
  self: string;
  map: string;
  /** A block's side in world pixels (the client divides by its tile size for tiles). */
  blockPx: number;
  blocksX: number;
  blocksY: number;
  /** The table's epoch. */
  epoch: number;
  nodes: string[];
  /** Row by row (index = by * blocksX + bx): an index into `nodes`, or -1. */
  cells: number[];
  /** Indexes of cells whose block this node gave away and has not yet seen settled (a move in flight). */
  moving: number[];
  /** The block under the asking player and its owner (an index into `nodes`, -1 for none). Null when the position is unknown. */
  here: { bx: number; by: number; owner: number } | null;
}

export type ClusterDebugAnswer =
  | { cluster: false }
  | { cluster: true; allowed: false }
  | ClusterDebugData;

/** What the answer is built from. The live one is clusterDebugSource (cluster/index.ts); tests give their own. */
export interface ClusterDebugSource {
  /** This node's id while the cluster runs, null when it does not. */
  self(): string | null;
  /** The cached owners of the map's blocks, {} when the map is not known. */
  ownersOf(map: string): Readonly<Record<string, BlockOwner>>;
  /** The table's epoch (0 when none is cached). */
  epochOf(map: string): number;
  /** The map's size in blocks, undefined when not known. */
  extentOf(map: string): BlockExtent | undefined;
  /** The block a position is in. */
  blockOf(map: string, x: number, y: number): { bx: number; by: number };
  /** Whether this node gave the block away and the move is not settled. */
  givenAway(map: string, bx: number, by: number): boolean;
}

export interface DebugAsker {
  location?: { map?: string; position?: { x?: number; y?: number } };
}

/**
 * The answer for one request. Not a cluster: `{ cluster: false }` (to anyone, it tells nothing). No logged-in player
 * asking: `{ allowed: false }`; any logged-in player gets the table. A map with no table cached yet still answers, with
 * every cell unowned.
 */
export function buildClusterDebug(source: ClusterDebugSource | null, player: DebugAsker | null): ClusterDebugAnswer {
  const self = source?.self() ?? null;
  if (!source || self === null) return { cluster: false };
  // Any logged-in player may see the table (USER REQUEST 2026-10-23: "make the cluster nodes non-admin").
  if (!player) return { cluster: true, allowed: false };

  const map = String(player.location?.map ?? "").replace(/\.json$/, "");
  const owners = source.ownersOf(map);
  const extent = source.extentOf(map) ?? extentFromOwners(owners);
  const blocksX = Math.max(1, Math.floor(extent.blocksX));
  const blocksY = Math.max(1, Math.floor(extent.blocksY));
  const total = blocksX * blocksY;
  // A grid over the cap is cut by rows so the cells stay rectangular; the client draws what it is given.
  const rows = total > MAX_DEBUG_CELLS ? Math.max(1, Math.floor(MAX_DEBUG_CELLS / blocksX)) : blocksY;

  const nodes: string[] = [];
  const index = new Map<string, number>();
  const indexOf = (id: string | undefined): number => {
    if (!id) return -1;
    let at = index.get(id);
    if (at === undefined) {
      at = nodes.length;
      nodes.push(id);
      index.set(id, at);
    }
    return at;
  };

  const cells: number[] = [];
  const moving: number[] = [];
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      cells.push(indexOf(owners[blockKey(bx, by)]?.nodeId));
      if (source.givenAway(map, bx, by)) moving.push(by * blocksX + bx);
    }
  }

  let here: ClusterDebugData["here"] = null;
  const position = player.location?.position;
  if (position && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y))) {
    const at = source.blockOf(map, Number(position.x), Number(position.y));
    here = { bx: at.bx, by: at.by, owner: indexOf(owners[blockKey(at.bx, at.by)]?.nodeId) };
  }

  return {
    cluster: true, allowed: true, self, map, blockPx: BLOCK_SIZE_PX, blocksX, blocksY: rows,
    epoch: source.epochOf(map), nodes, cells, moving, here,
  };
}

/** The grid size as far as the table shows it, for a map whose extent this node has not been given. */
function extentFromOwners(owners: Readonly<Record<string, BlockOwner>>): BlockExtent {
  let blocksX = 1;
  let blocksY = 1;
  for (const key in owners) {
    const [x, y] = key.split(",").map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      blocksX = Math.max(blocksX, x! + 1);
      blocksY = Math.max(blocksY, y! + 1);
    }
  }
  return { blocksX, blocksY };
}

/**
 * At most one answer per connection per DEBUG_MIN_GAP_MS. `allow` is true for a request that gets an answer, false for
 * one that is dropped (it answers nothing). Keyed by the connection object, so a closed connection is not held on to.
 */
export class DebugRateLimit {
  private last = new WeakMap<object, number>();

  allow(connection: object, now = Date.now()): boolean {
    const before = this.last.get(connection);
    if (before !== undefined && now >= before && now - before < DEBUG_MIN_GAP_MS) return false;
    this.last.set(connection, now);
    return true;
  }
}

/** The one limiter the packet handler uses. */
export const debugRateLimit = new DebugRateLimit();
