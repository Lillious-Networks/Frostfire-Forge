import { CREATURE_CELL_PX } from "./constants";
import type { CreatureInstance } from "./types";

/**
 * Authoritative store of live creatures, bucketed per map into a coarse grid
 * so visibility and aggro scans only touch nearby cells.
 */
/** A grid cell: its coordinates (cell units) and the creatures in it. */
interface Cell {
  cx: number;
  cy: number;
  ids: Set<number>;
  /** Taken out of the grid: a cached list that still holds it drops it. */
  gone?: boolean;
}

/** The cells of a map that a caller's `wanted` accepted, kept between calls (see onBandCells). */
interface WantedCells {
  token: object;
  wanted: (left: number, top: number, size: number) => boolean;
  cells: Cell[];
  /** Some cell in `cells` is gone. */
  stale: boolean;
}

export class CreatureRegistry {
  private instances = new Map<number, CreatureInstance>();
  private maps = new Map<string, Map<string, Cell>>();
  private cellOf = new Map<number, string>();
  private wantedCells = new Map<string, WantedCells>();
  /**
   * Called when a creature's position is set by `move`, and by `touch`. Cluster mode uses it to tell the mirror layer
   * which creatures moved. Null leaves both a no-op.
   */
  onMoved: ((instance: CreatureInstance) => void) | null = null;

  constructor(private readonly cellSize: number = CREATURE_CELL_PX) {}

  get size(): number {
    return this.instances.size;
  }

  get(id: number): CreatureInstance | undefined {
    return this.instances.get(id);
  }

  all(): IterableIterator<CreatureInstance> {
    return this.instances.values();
  }

  mapsWithCreatures(): IterableIterator<string> {
    return this.maps.keys();
  }

  /** Every creature on `map`, read from its cells. */
  *onMap(map: string): IterableIterator<CreatureInstance> {
    const cells = this.maps.get(map);
    if (!cells) return;
    for (const { ids } of cells.values()) {
      for (const id of ids) {
        const instance = this.instances.get(id);
        if (instance) yield instance;
      }
    }
  }

  /**
   * Creatures on `map` in the cells `wanted` accepts (given a cell's left, top and size in px). The registry has
   * no index by block, so this visits the map's cells, not its creatures: a cell that is not wanted costs one call.
   */
  *onMapCells(map: string, wanted: (left: number, top: number, size: number) => boolean): IterableIterator<CreatureInstance> {
    const cells = this.maps.get(map);
    if (!cells) return;
    for (const { cx, cy, ids } of cells.values()) {
      if (!wanted(cx * this.cellSize, cy * this.cellSize, this.cellSize)) continue;
      for (const id of ids) {
        const instance = this.instances.get(id);
        if (instance) yield instance;
      }
    }
  }

  /**
   * Like onMapCells, with the cells that passed kept per map between calls. `token` says what `wanted` depends on
   * (the border band's token for the map): while it is the same object the answer for a cell is the same, so the
   * list is kept and only updated for cells that appear or go. A different token starts the list over.
   */
  *onBandCells(map: string, token: object, wanted: (left: number, top: number, size: number) => boolean): IterableIterator<CreatureInstance> {
    const cells = this.maps.get(map);
    if (!cells) return;
    let held = this.wantedCells.get(map);
    if (!held || held.token !== token) {
      held = { token, wanted, cells: [], stale: false };
      for (const cell of cells.values()) {
        if (wanted(cell.cx * this.cellSize, cell.cy * this.cellSize, this.cellSize)) held.cells.push(cell);
      }
      this.wantedCells.set(map, held);
    } else if (held.stale) {
      held.cells = held.cells.filter((cell) => !cell.gone);
      held.stale = false;
    }
    for (const cell of held.cells) {
      if (cell.gone) continue;
      for (const id of cell.ids) {
        const instance = this.instances.get(id);
        if (instance) yield instance;
      }
    }
  }

  /** `instance` changed in a way the mirror layer shows (direction, movement) without its position being set. */
  touch(instance: CreatureInstance): void {
    this.onMoved?.(instance);
  }

  add(instance: CreatureInstance): void {
    this.instances.set(instance.id, instance);
    this.insertIntoCell(instance);
  }

  remove(id: number): CreatureInstance | undefined {
    const instance = this.instances.get(id);
    if (!instance) return undefined;
    this.removeFromCell(instance);
    this.instances.delete(id);
    return instance;
  }

  /** Update position and re-bucket if the creature crossed a cell boundary. */
  move(instance: CreatureInstance, x: number, y: number): void {
    instance.x = x;
    instance.y = y;
    this.onMoved?.(instance);
    const key = this.cellKey(x, y);
    if (this.cellOf.get(instance.id) === key) return;
    this.removeFromCell(instance);
    this.insertIntoCell(instance);
  }

  /** Creatures on `map` whose position is within `radius` of (x, y). */
  queryRadius(map: string, x: number, y: number, radius: number, out: CreatureInstance[] = []): CreatureInstance[] {
    const cells = this.maps.get(map);
    if (!cells) return out;
    const r2 = radius * radius;
    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const cell = cells.get(`${cx},${cy}`);
        if (!cell) continue;
        for (const id of cell.ids) {
          const c = this.instances.get(id);
          if (!c) continue;
          const dx = c.x - x;
          const dy = c.y - y;
          if (dx * dx + dy * dy <= r2) out.push(c);
        }
      }
    }
    return out;
  }

  clear(): void {
    this.instances.clear();
    this.maps.clear();
    this.cellOf.clear();
    this.wantedCells.clear();
  }

  private cellKey(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  private insertIntoCell(instance: CreatureInstance): void {
    let cells = this.maps.get(instance.map);
    if (!cells) {
      cells = new Map();
      this.maps.set(instance.map, cells);
    }
    const key = this.cellKey(instance.x, instance.y);
    let cell = cells.get(key);
    if (!cell) {
      cell = { cx: Math.floor(instance.x / this.cellSize), cy: Math.floor(instance.y / this.cellSize), ids: new Set() };
      cells.set(key, cell);
      const held = this.wantedCells.get(instance.map);
      if (held && held.wanted(cell.cx * this.cellSize, cell.cy * this.cellSize, this.cellSize)) held.cells.push(cell);
    }
    cell.ids.add(instance.id);
    this.cellOf.set(instance.id, key);
  }

  private removeFromCell(instance: CreatureInstance): void {
    const key = this.cellOf.get(instance.id);
    if (key === undefined) return;
    const cells = this.maps.get(instance.map);
    const cell = cells?.get(key);
    if (cell) {
      cell.ids.delete(instance.id);
      if (cell.ids.size === 0) {
        cells!.delete(key);
        cell.gone = true;
        const held = this.wantedCells.get(instance.map);
        if (held) held.stale = true;
      }
      if (cells!.size === 0) {
        this.maps.delete(instance.map);
        this.wantedCells.delete(instance.map);
      }
    }
    this.cellOf.delete(instance.id);
  }
}

const registry = new CreatureRegistry();
export default registry;
