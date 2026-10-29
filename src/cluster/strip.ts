import { BLOCK_SIZE_PX, blockKey, type BlockOwner } from "./blocks";

// Which nodes hold a mirror of an entity (spec §3): every node owning a block
// within 1250 px of it (the AOI exit radius, 1.25 x 1000). A block is 4096 px,
// so only the blocks next to the entity's own can qualify.

export const MIRROR_RADIUS_PX = 1250;
/** A mirror already there is kept to this distance, so an entity on the line does not flap. */
export const MIRROR_KEEP_PX = MIRROR_RADIUS_PX + 64;

export type Owners = Readonly<Record<string, BlockOwner>>;

/** Distance squared from a point to block (bx, by)'s rectangle; 0 inside it. */
function distanceToBlockSq(x: number, y: number, bx: number, by: number): number {
  const left = bx * BLOCK_SIZE_PX;
  const top = by * BLOCK_SIZE_PX;
  const dx = Math.max(left - x, 0, x - (left + BLOCK_SIZE_PX));
  const dy = Math.max(top - y, 0, y - (top + BLOCK_SIZE_PX));
  return dx * dx + dy * dy;
}

/** A block packed into one number for a Set (no key string per lookup). Both coordinates are -1 or more, under BAND_PACK - 1. */
const BAND_PACK = 2 ** 26;
const packBlock = (bx: number, by: number) => (bx + 1) * BAND_PACK + (by + 1);
const packable = (bx: number, by: number) => bx >= -1 && by >= -1 && bx < BAND_PACK - 1 && by < BAND_PACK - 1;

interface MapBand {
  /** The table it was built from: a new table object is a change. */
  owners: Owners;
  /** Every block next to (or being) a block of another node, off the map's edge included. */
  blocks: Set<number>;
  /** A block of another node was too far out to pack: every position counts as near. */
  wide: boolean;
}

/**
 * The border band (spec §3): the part of each map where an entity can have a mirror target. A mirror is made and
 * kept only within MIRROR_KEEP_PX of a block another node owns, and a block is 4096 px, so only the blocks next
 * to (or being) one of those can hold such an entity. Everything outside the band is not worth a look: with
 * every block this node's, nothing on the map is. A table is re-read by `refresh` (a changed table is a new
 * object), which the scan calls first, so a band never outlives the table it was made from by more than a scan.
 */
export class BorderBand {
  private maps = new Map<string, MapBand>();

  /**
   * `ownersOf` is the block table (a map not loaded has no owners, so no band); `knownMaps` lists the maps it
   * holds, for `anyBorder`.
   */
  constructor(
    private readonly ownersOf: (map: string) => Owners,
    private readonly self: string,
    private readonly knownMaps: () => Iterable<string>,
  ) {}

  /** Rebuild the band of every map whose table changed since it was made. */
  refresh(): void {
    for (const [map, band] of this.maps) {
      const owners = this.ownersOf(map);
      if (owners !== band.owners) this.maps.set(map, this.build(owners));
    }
  }

  /**
   * An object that stays the same for as long as `map`'s band does and is a new one each time the band is rebuilt
   * (its table changed): a caller that keeps something worked out from the band compares it to know when to redo it.
   */
  token(map: string): object {
    return this.of(map);
  }

  /** Whether any other node owns a block of `map`: when not, nothing on it can be mirrored. */
  hasBorder(map: string): boolean {
    const band = this.of(map);
    return band.wide || band.blocks.size > 0;
  }

  /** Whether any known map has a border: when not, the scan has nothing to look at. */
  anyBorder(): boolean {
    for (const map of this.knownMaps()) if (this.hasBorder(map)) return true;
    return false;
  }

  /** Whether (x, y) can have a mirror target: false when it is farther than MIRROR_KEEP_PX from every block of another node. */
  near(map: string, x: number, y: number): boolean {
    const band = this.of(map);
    if (band.wide) return true;
    if (band.blocks.size === 0) return false;
    const bx = Math.floor(x / BLOCK_SIZE_PX);
    const by = Math.floor(y / BLOCK_SIZE_PX);
    // NaN and infinities fail this too: they have no target either.
    return packable(bx, by) && band.blocks.has(packBlock(bx, by));
  }

  /** Whether the rectangle [left, right) x [top, bottom) touches a block of the band: true when a position in it can be near. */
  nearRect(map: string, left: number, top: number, right: number, bottom: number): boolean {
    const band = this.of(map);
    if (band.wide) return true;
    if (band.blocks.size === 0) return false;
    const fromX = Math.floor(left / BLOCK_SIZE_PX);
    const toX = Math.ceil(right / BLOCK_SIZE_PX) - 1;
    const fromY = Math.floor(top / BLOCK_SIZE_PX);
    const toY = Math.ceil(bottom / BLOCK_SIZE_PX) - 1;
    for (let bx = fromX; bx <= toX; bx++) {
      for (let by = fromY; by <= toY; by++) if (packable(bx, by) && band.blocks.has(packBlock(bx, by))) return true;
    }
    return false;
  }

  private of(map: string): MapBand {
    let band = this.maps.get(map);
    if (!band) this.maps.set(map, (band = this.build(this.ownersOf(map))));
    return band;
  }

  private build(owners: Owners): MapBand {
    const band: MapBand = { owners, blocks: new Set(), wide: false };
    for (const [key, owner] of Object.entries(owners)) {
      if (owner.nodeId === this.self) continue;
      const [bx, by] = key.split(",").map(Number);
      if (!(bx >= 0 && by >= 0 && packable(bx + 1, by + 1))) {
        band.wide = true;
        continue;
      }
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) band.blocks.add(packBlock(bx + dx, by + dy));
      }
    }
    return band;
  }
}

/** What nodesWithin returns when no node is near: one shared set, so an entity with no peers allocates nothing. Read only. */
const NO_NODES: ReadonlySet<string> = new Set();

/** Nodes other than `self` that own a block within `radius` of (x, y). The set is read only (it may be shared). */
export function nodesWithin(owners: Owners, x: number, y: number, radius: number, self: string): ReadonlySet<string> {
  let nodes: Set<string> | null = null;
  const radiusSq = radius * radius;
  const fromX = Math.max(0, Math.floor((x - radius) / BLOCK_SIZE_PX));
  const toX = Math.floor((x + radius) / BLOCK_SIZE_PX);
  const fromY = Math.max(0, Math.floor((y - radius) / BLOCK_SIZE_PX));
  const toY = Math.floor((y + radius) / BLOCK_SIZE_PX);
  for (let bx = fromX; bx <= toX; bx++) {
    for (let by = fromY; by <= toY; by++) {
      // The distance first: the corner blocks of the box are often out of reach, and a lookup makes a key string.
      if (distanceToBlockSq(x, y, bx, by) > radiusSq) continue;
      const owner = owners[blockKey(bx, by)];
      if (!owner || owner.nodeId === self || nodes?.has(owner.nodeId)) continue;
      (nodes ??= new Set()).add(owner.nodeId);
    }
  }
  return nodes ?? NO_NODES;
}

/** Where an entity is mirrored now: within 1250 px, or within 1314 px of a node that already has it. */
export function mirrorTargets(owners: Owners, x: number, y: number, self: string, previous: ReadonlySet<string>): ReadonlySet<string> {
  const targets = nodesWithin(owners, x, y, MIRROR_RADIUS_PX, self);
  if (previous.size === 0) return targets;
  let kept: Set<string> | null = null;
  for (const nodeId of nodesWithin(owners, x, y, MIRROR_KEEP_PX, self)) {
    if (previous.has(nodeId) && !targets.has(nodeId)) (kept ??= new Set(targets)).add(nodeId);
  }
  return kept ?? targets;
}

/** Side of the squares the target cache is kept for. */
const CELL_PX = 64;
/** The farthest a point of a cell is from its centre (half the diagonal), with a pixel to spare. */
const CELL_REACH_PX = CELL_PX * Math.SQRT1_2 + 1;
/** Cells either way from 0 that are cached; a position beyond (or NaN, infinite) is not cached. */
const CELL_LIMIT = 2 ** 24;
/** Cells kept for all maps together: past it the cache starts over. */
const CELL_CAP = 100_000;

interface TargetCell {
  /** Nodes within MIRROR_RADIUS_PX of every point of the cell. */
  near: ReadonlySet<string>;
  /** Nodes within MIRROR_KEEP_PX of every point of the cell. */
  keep: ReadonlySet<string>;
  /** Some node is within reach of some points of the cell and not of others: the position decides. */
  edge: boolean;
}

/**
 * mirrorTargets per map and square of 64 px. A node is within reach of the whole square when it is within the
 * radius less the square's reach of its centre, and of none of it when it is not within the radius plus that: only
 * a square the radius cuts through is worked out position by position, so what comes back is what mirrorTargets
 * gives for the position, not for the square's centre. A map's squares are dropped when its table is replaced
 * (BlockTable.keep puts a new owners object on every change), which is checked on every call, so no target outlives
 * the owner it was made from. The sets returned are read only and may be shared.
 */
export class TargetCache {
  private maps = new Map<string, { owners: Owners; cells: Map<number, TargetCell> }>();
  private cells = 0;

  constructor(private readonly ownersOf: (map: string) => Owners, private readonly self: string) {}

  targets(map: string, x: number, y: number, previous: ReadonlySet<string>): ReadonlySet<string> {
    const owners = this.ownersOf(map);
    const cx = Math.floor(x / CELL_PX);
    const cy = Math.floor(y / CELL_PX);
    // NaN and infinities fail this too: they are mirrorTargets' to answer.
    if (!(Math.abs(cx) < CELL_LIMIT && Math.abs(cy) < CELL_LIMIT)) return mirrorTargets(owners, x, y, this.self, previous);
    let held = this.maps.get(map);
    if (!held || held.owners !== owners) {
      if (held) this.cells -= held.cells.size;
      this.maps.set(map, (held = { owners, cells: new Map() }));
    }
    const key = (cx + CELL_LIMIT) * (2 * CELL_LIMIT) + (cy + CELL_LIMIT);
    let cell = held.cells.get(key);
    if (!cell) {
      if (this.cells >= CELL_CAP) {
        this.clear();
        this.maps.set(map, (held = { owners, cells: new Map() }));
      }
      cell = this.cellAt(owners, (cx + 0.5) * CELL_PX, (cy + 0.5) * CELL_PX);
      held.cells.set(key, cell);
      this.cells++;
    }
    if (cell.edge) return mirrorTargets(owners, x, y, this.self, previous);
    if (previous.size === 0) return cell.near;
    let kept: Set<string> | null = null;
    for (const nodeId of cell.keep) {
      if (previous.has(nodeId) && !cell.near.has(nodeId)) (kept ??= new Set(cell.near)).add(nodeId);
    }
    return kept ?? cell.near;
  }

  /** Forget everything (the next call works each square out again). */
  clear(): void {
    this.maps.clear();
    this.cells = 0;
  }

  private cellAt(owners: Owners, mx: number, my: number): TargetCell {
    const near = nodesWithin(owners, mx, my, MIRROR_RADIUS_PX - CELL_REACH_PX, this.self);
    const keep = nodesWithin(owners, mx, my, MIRROR_KEEP_PX - CELL_REACH_PX, this.self);
    // The sets only grow with the radius, so a different size is a node that is in reach of some points only.
    const edge = nodesWithin(owners, mx, my, MIRROR_RADIUS_PX + CELL_REACH_PX, this.self).size !== near.size
      || nodesWithin(owners, mx, my, MIRROR_KEEP_PX + CELL_REACH_PX, this.self).size !== keep.size;
    return { near, keep, edge };
  }
}

/** Nodes owning a block next to (8-neighbourhood) one of `self`'s blocks, on any map: the nodes to link with. */
export function neighbourNodes(tables: Iterable<Owners>, self: string): Set<string> {
  const nodes = new Set<string>();
  for (const owners of tables) {
    for (const [key, owner] of Object.entries(owners)) {
      if (owner.nodeId !== self) continue;
      const [bx, by] = key.split(",").map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const other = owners[blockKey(bx + dx, by + dy)];
          if (other && other.nodeId !== self) nodes.add(other.nodeId);
        }
      }
    }
  }
  return nodes;
}

/**
 * The nodes `self` links with: its neighbours, and the live nodes that own no block when it owns some, or every live
 * node when it owns none. A node that owns no block (one that joined a running cluster, or restarted after a takeover
 * gave its blocks away) borders no one, yet the rebalancer gives it a block of the most loaded node, and that move runs
 * as a call over a link between the two. Without this rule no link is ever wanted to it and every such order ends
 * "not run (down)".
 */
export function linkPartners(tables: Iterable<Owners>, self: string, live: Iterable<string>): Set<string> {
  const all = [...tables];
  const partners = neighbourNodes(all, self);
  const owning = new Set<string>();
  for (const owners of all) for (const owner of Object.values(owners)) owning.add(owner.nodeId);
  for (const nodeId of live) {
    if (nodeId !== self && (!owning.has(self) || !owning.has(nodeId))) partners.add(nodeId);
  }
  return partners;
}
