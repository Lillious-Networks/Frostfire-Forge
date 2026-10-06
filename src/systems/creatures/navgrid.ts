import type { Rng } from "./constants";

/**
 * Walkability grid for creature movement, decoded from the map collision RLE
 * that assetloader stores as [width, height, value, count, value, count, ...].
 *
 * Creature positions use the same anchor as players: the footprint spans
 * x - FOOT_W/2 .. x + FOOT_W/2 horizontally and y .. y + FOOT_H vertically.
 */
export const FOOT_W = 16;
export const FOOT_H = 16;

export interface Point {
  x: number;
  y: number;
}

export function decodeCollisionRLE(rle: ArrayLike<number>): { width: number; height: number; blocked: Uint8Array } | null {
  if (!rle || rle.length < 2) return null;
  const width = Number(rle[0]);
  const height = Number(rle[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const blocked = new Uint8Array(width * height);
  let offset = 0;
  for (let i = 2; i + 1 < rle.length && offset < blocked.length; i += 2) {
    const value = Number(rle[i]);
    const count = Math.max(0, Number(rle[i + 1]) | 0);
    const end = Math.min(blocked.length, offset + count);
    if (value !== 0) blocked.fill(1, offset, end);
    offset = end;
  }
  return { width, height, blocked };
}

/** Cheap content fingerprint so a reloaded/edited map rebuilds its grid. */
export function rleChecksum(rle: ArrayLike<number>): number {
  let h = 2166136261;
  for (let i = 0; i < rle.length; i++) {
    h ^= Number(rle[i]) | 0;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) ^ rle.length;
}

// Min-heap keyed by f-score, storing tile indices.
class IndexHeap {
  private items: number[] = [];
  private scores: number[] = [];
  get size(): number {
    return this.items.length;
  }
  clear(): void {
    this.items.length = 0;
    this.scores.length = 0;
  }
  push(item: number, score: number): void {
    const items = this.items;
    const scores = this.scores;
    let i = items.length;
    items.push(item);
    scores.push(score);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (scores[parent] <= score) break;
      items[i] = items[parent];
      scores[i] = scores[parent];
      i = parent;
    }
    items[i] = item;
    scores[i] = score;
  }
  pop(): number {
    const items = this.items;
    const scores = this.scores;
    const top = items[0];
    const lastItem = items.pop()!;
    const lastScore = scores.pop()!;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && scores[r] < scores[l] ? r : l;
        if (scores[c] >= lastScore) break;
        items[i] = items[c];
        scores[i] = scores[c];
        i = c;
      }
      items[i] = lastItem;
      scores[i] = lastScore;
    }
    return top;
  }
}

const SQRT2 = Math.SQRT2;
const NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

export class NavGrid {
  // A* scratch buffers, reused across searches via a generation stamp.
  private gScore: Float64Array;
  private cameFrom: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private generation = 0;
  private heap = new IndexHeap();

  constructor(
    readonly width: number,
    readonly height: number,
    readonly tileW: number,
    readonly tileH: number,
    readonly blocked: Uint8Array,
    // WorldNavGrid keeps its own, smaller scratch and passes 0
    scratchCells = width * height
  ) {
    const n = scratchCells;
    this.gScore = new Float64Array(n);
    this.cameFrom = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  static fromRLE(rle: ArrayLike<number>, tileW: number, tileH: number): NavGrid | null {
    const decoded = decodeCollisionRLE(rle);
    if (!decoded) return null;
    return new NavGrid(decoded.width, decoded.height, tileW, tileH, decoded.blocked);
  }

  /** Out-of-bounds tiles are treated as walls so creatures never leave the map. */
  isBlockedTile(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return true;
    return this.blocked[ty * this.width + tx] === 1;
  }

  tileOf(p: Point): { tx: number; ty: number } {
    return { tx: Math.floor(p.x / this.tileW), ty: Math.floor((p.y + FOOT_H / 2) / this.tileH) };
  }

  /** Anchor position that centres the footprint in a tile. */
  anchorOfTile(tx: number, ty: number): Point {
    return { x: tx * this.tileW + this.tileW / 2, y: ty * this.tileH + this.tileH / 2 - FOOT_H / 2 };
  }

  /** True when the whole footprint at this anchor is on walkable tiles. */
  isWalkable(x: number, y: number): boolean {
    const m = 0.1;
    const left = Math.floor((x - FOOT_W / 2 + m) / this.tileW);
    const right = Math.floor((x + FOOT_W / 2 - m) / this.tileW);
    const top = Math.floor((y + m) / this.tileH);
    const bottom = Math.floor((y + FOOT_H - m) / this.tileH);
    for (let ty = top; ty <= bottom; ty++) {
      for (let tx = left; tx <= right; tx++) {
        if (this.isBlockedTile(tx, ty)) return false;
      }
    }
    return true;
  }

  /** Whether the footprint can travel the straight segment a -> b. */
  canTraverse(a: Point, b: Point): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(1, Math.min(this.tileW, this.tileH) / 4);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.isWalkable(a.x + dx * t, a.y + dy * t)) return false;
    }
    return true;
  }

  /** Tile-level line of sight (walls block sight; used by aggro in later phases). */
  lineOfSight(a: Point, b: Point): boolean {
    let { tx: x0, ty: y0 } = this.tileOf(a);
    const { tx: x1, ty: y1 } = this.tileOf(b);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      if (this.isBlockedTile(x0, y0)) return false;
      if (x0 === x1 && y0 === y1) return true;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /**
   * A* over tiles (8-way, no corner cutting), returning smoothed anchor
   * waypoints excluding the start. `null` when unreachable within maxNodes.
   */
  findPath(from: Point, to: Point, maxNodes = 4000): Point[] | null {
    const start = this.tileOf(from);
    let goal = this.tileOf(to);
    if (this.isBlockedTile(goal.tx, goal.ty)) {
      const near = this.nearestOpenTile(goal.tx, goal.ty, 2);
      if (!near) return null;
      goal = near;
    }
    if (start.tx === goal.tx && start.ty === goal.ty) {
      return this.isWalkable(to.x, to.y) ? [{ x: to.x, y: to.y }] : [this.anchorOfTile(goal.tx, goal.ty)];
    }

    const w = this.width;
    const startIdx = start.ty * w + start.tx;
    const goalIdx = goal.ty * w + goal.tx;
    const gen = ++this.generation;
    if (gen === 0xffffffff) {
      this.stamp.fill(0);
      this.closed.fill(0);
      this.generation = 1;
    }
    const g = this.gScore;
    const came = this.cameFrom;
    const stamp = this.stamp;
    const closed = this.closed;
    const heap = this.heap;
    heap.clear();

    const h = (tx: number, ty: number) => {
      const ax = Math.abs(tx - goal.tx);
      const ay = Math.abs(ty - goal.ty);
      return Math.max(ax, ay) + (SQRT2 - 1) * Math.min(ax, ay);
    };

    stamp[startIdx] = this.generation;
    g[startIdx] = 0;
    came[startIdx] = -1;
    heap.push(startIdx, h(start.tx, start.ty));

    let expanded = 0;
    let found = false;
    while (heap.size > 0) {
      const current = heap.pop();
      if (closed[current] === this.generation) continue;
      closed[current] = this.generation;
      if (current === goalIdx) {
        found = true;
        break;
      }
      if (++expanded > maxNodes) break;

      const cx = current % w;
      const cy = (current - cx) / w;
      for (const [ox, oy, cost] of NEIGHBORS) {
        const nx = cx + ox;
        const ny = cy + oy;
        if (this.isBlockedTile(nx, ny)) continue;
        if (ox !== 0 && oy !== 0 && (this.isBlockedTile(cx + ox, cy) || this.isBlockedTile(cx, cy + oy))) continue;
        const ni = ny * w + nx;
        if (closed[ni] === this.generation) continue;
        const tentative = g[current] + cost;
        if (stamp[ni] === this.generation && tentative >= g[ni]) continue;
        stamp[ni] = this.generation;
        g[ni] = tentative;
        came[ni] = current;
        heap.push(ni, tentative + h(nx, ny));
      }
    }
    if (!found) return null;

    const tiles: Point[] = [];
    for (let i = goalIdx; i !== -1 && i !== startIdx; i = came[i]) {
      const tx = i % w;
      tiles.push(this.anchorOfTile(tx, (i - tx) / w));
    }
    tiles.reverse();
    if (this.isWalkable(to.x, to.y) && this.tileOf(to).tx === goal.tx && this.tileOf(to).ty === goal.ty) {
      tiles[tiles.length - 1] = { x: to.x, y: to.y };
    }
    return this.smooth(from, tiles);
  }

  /** String-pull: drop waypoints the footprint can skip in a straight line. */
  smooth(from: Point, waypoints: Point[]): Point[] {
    if (waypoints.length <= 1) return waypoints;
    const out: Point[] = [];
    let anchor = from;
    let i = 0;
    while (i < waypoints.length) {
      let furthest = i;
      for (let j = waypoints.length - 1; j > i; j--) {
        if (this.canTraverse(anchor, waypoints[j])) {
          furthest = j;
          break;
        }
      }
      out.push(waypoints[furthest]);
      anchor = waypoints[furthest];
      i = furthest + 1;
    }
    return out;
  }

  nearestOpenTile(tx: number, ty: number, maxRing: number): { tx: number; ty: number } | null {
    for (let ring = 1; ring <= maxRing; ring++) {
      for (let oy = -ring; oy <= ring; oy++) {
        for (let ox = -ring; ox <= ring; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== ring) continue;
          if (!this.isBlockedTile(tx + ox, ty + oy)) return { tx: tx + ox, ty: ty + oy };
        }
      }
    }
    return null;
  }

  /** Random walkable anchor within `radius` of centre, reachable in a straight line. */
  randomPointNear(center: Point, radius: number, r: Rng, tries = 8): Point | null {
    for (let i = 0; i < tries; i++) {
      const angle = r() * Math.PI * 2;
      const dist = Math.sqrt(r()) * radius;
      const p = { x: center.x + Math.cos(angle) * dist, y: center.y + Math.sin(angle) * dist };
      if (this.isWalkable(p.x, p.y) && this.lineOfSight(center, p)) return p;
    }
    return null;
  }

  /** Move by (dx, dy), sliding along walls. Returns the resulting position. */
  step(from: Point, dx: number, dy: number): Point {
    if (this.isWalkable(from.x + dx, from.y + dy)) return { x: from.x + dx, y: from.y + dy };
    if (dx !== 0 && this.isWalkable(from.x + dx, from.y)) return { x: from.x + dx, y: from.y };
    if (dy !== 0 && this.isWalkable(from.x, from.y + dy)) return { x: from.x, y: from.y + dy };
    return from;
  }
}

/** A world's collision (modules/worldmaps.ts WorldBits): one bit per tile, read directly. */
export interface TileBits {
  isSet(tileX: number, tileY: number): number;
}

/** Edge, in tiles, of the square a WorldNavGrid search may cover. */
export const WORLD_NAV_WINDOW = 256;

/**
 * The grid of a world (a map too large to hold a byte and 20 bytes of search scratch per tile: 2.2 GB for the
 * 10240 x 10240 continent). Collision is read from the world's bitset, and a path search works inside a window of
 * WORLD_NAV_WINDOW tiles centred between its two ends, with scratch the size of the window (1.3 MB). Tiles outside
 * the window count as walls for that search, and ends too far apart to share a window have no path. Inside the
 * window the search is NavGrid's own, step for step. Everything else (footprints, line of sight, smoothing, steps)
 * is inherited and reads the bitset through isBlockedTile.
 */
export class WorldNavGrid extends NavGrid {
  private winG = new Float64Array(WORLD_NAV_WINDOW * WORLD_NAV_WINDOW);
  private winFrom = new Int32Array(WORLD_NAV_WINDOW * WORLD_NAV_WINDOW);
  private winStamp = new Uint32Array(WORLD_NAV_WINDOW * WORLD_NAV_WINDOW);
  private winClosed = new Uint32Array(WORLD_NAV_WINDOW * WORLD_NAV_WINDOW);
  private winGeneration = 0;
  private winHeap = new IndexHeap();

  constructor(width: number, height: number, tileW: number, tileH: number, readonly bits: TileBits) {
    super(width, height, tileW, tileH, new Uint8Array(0), 0);
  }

  override isBlockedTile(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return true;
    return this.bits.isSet(tx, ty) === 1;
  }

  override findPath(from: Point, to: Point, maxNodes = 4000): Point[] | null {
    const start = this.tileOf(from);
    let goal = this.tileOf(to);
    if (this.isBlockedTile(goal.tx, goal.ty)) {
      const near = this.nearestOpenTile(goal.tx, goal.ty, 2);
      if (!near) return null;
      goal = near;
    }
    if (start.tx === goal.tx && start.ty === goal.ty) {
      return this.isWalkable(to.x, to.y) ? [{ x: to.x, y: to.y }] : [this.anchorOfTile(goal.tx, goal.ty)];
    }

    // the window: centred between the two ends, which must both lie inside it
    const w = WORLD_NAV_WINDOW;
    const ox = Math.floor((start.tx + goal.tx) / 2) - (w >> 1);
    const oy = Math.floor((start.ty + goal.ty) / 2) - (w >> 1);
    const inside = (tx: number, ty: number) => tx >= ox && ty >= oy && tx < ox + w && ty < oy + w;
    if (!inside(start.tx, start.ty) || !inside(goal.tx, goal.ty)) return null;

    const startIdx = (start.ty - oy) * w + (start.tx - ox);
    const goalIdx = (goal.ty - oy) * w + (goal.tx - ox);
    ++this.winGeneration;
    if (this.winGeneration === 0xffffffff) {
      this.winStamp.fill(0);
      this.winClosed.fill(0);
      this.winGeneration = 1;
    }
    const gen = this.winGeneration;
    const g = this.winG;
    const came = this.winFrom;
    const stamp = this.winStamp;
    const closed = this.winClosed;
    const heap = this.winHeap;
    heap.clear();

    const h = (tx: number, ty: number) => {
      const ax = Math.abs(tx - goal.tx);
      const ay = Math.abs(ty - goal.ty);
      return Math.max(ax, ay) + (SQRT2 - 1) * Math.min(ax, ay);
    };

    stamp[startIdx] = gen;
    g[startIdx] = 0;
    came[startIdx] = -1;
    heap.push(startIdx, h(start.tx, start.ty));

    let expanded = 0;
    let found = false;
    while (heap.size > 0) {
      const current = heap.pop();
      if (closed[current] === gen) continue;
      closed[current] = gen;
      if (current === goalIdx) {
        found = true;
        break;
      }
      if (++expanded > maxNodes) break;

      const lx = current % w;
      const cx = lx + ox;
      const cy = (current - lx) / w + oy;
      for (const [dx, dy, cost] of NEIGHBORS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inside(nx, ny) || this.isBlockedTile(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (this.isBlockedTile(cx + dx, cy) || this.isBlockedTile(cx, cy + dy))) continue;
        const ni = (ny - oy) * w + (nx - ox);
        if (closed[ni] === gen) continue;
        const tentative = g[current] + cost;
        if (stamp[ni] === gen && tentative >= g[ni]) continue;
        stamp[ni] = gen;
        g[ni] = tentative;
        came[ni] = current;
        heap.push(ni, tentative + h(nx, ny));
      }
    }
    if (!found) return null;

    const tiles: Point[] = [];
    for (let i = goalIdx; i !== -1 && i !== startIdx; i = came[i]) {
      const lx = i % w;
      tiles.push(this.anchorOfTile(lx + ox, (i - lx) / w + oy));
    }
    tiles.reverse();
    if (this.isWalkable(to.x, to.y) && this.tileOf(to).tx === goal.tx && this.tileOf(to).ty === goal.ty) {
      tiles[tiles.length - 1] = { x: to.x, y: to.y };
    }
    return this.smooth(from, tiles);
  }
}

/** Per-map grid cache, rebuilt when the collision data changes. */
export class NavGridCache {
  private grids = new Map<string, { grid: NavGrid; checksum: number }>();

  /**
   * The grid of a world, over its collision bitset. Returns true if the grid was (re)built: the first time, and when
   * the world's bitset is another one (the world was loaded again).
   */
  useBits(map: string, bits: TileBits, width: number, height: number, tileW: number, tileH: number): boolean {
    const existing = this.grids.get(map)?.grid;
    if (existing instanceof WorldNavGrid && existing.bits === bits && existing.tileW === tileW && existing.tileH === tileH) return false;
    this.grids.set(map, { grid: new WorldNavGrid(width, height, tileW, tileH, bits), checksum: -1 });
    return true;
  }

  get(map: string): NavGrid | undefined {
    return this.grids.get(map)?.grid;
  }

  /** Returns true if the grid was (re)built. */
  update(map: string, rle: ArrayLike<number> | null | undefined, tileW: number, tileH: number): boolean {
    if (!rle || rle.length < 2) {
      this.grids.delete(map);
      return false;
    }
    const checksum = rleChecksum(rle);
    const existing = this.grids.get(map);
    if (existing && existing.checksum === checksum && existing.grid.tileW === tileW && existing.grid.tileH === tileH) {
      return false;
    }
    const grid = NavGrid.fromRLE(rle, tileW, tileH);
    if (!grid) {
      this.grids.delete(map);
      return false;
    }
    this.grids.set(map, { grid, checksum });
    return true;
  }

  delete(map: string): void {
    this.grids.delete(map);
  }
}
