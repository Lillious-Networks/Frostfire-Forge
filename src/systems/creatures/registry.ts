import { CREATURE_CELL_PX } from "./constants";
import type { CreatureInstance } from "./types";

/**
 * Authoritative store of live creatures, bucketed per map into a coarse grid
 * so visibility and aggro scans only touch nearby cells.
 */
export class CreatureRegistry {
  private instances = new Map<number, CreatureInstance>();
  private maps = new Map<string, Map<string, Set<number>>>();
  private cellOf = new Map<number, string>();
  private nextId = 1;

  constructor(private readonly cellSize: number = CREATURE_CELL_PX) {}

  allocateId(): number {
    return this.nextId++;
  }

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
        const ids = cells.get(`${cx},${cy}`);
        if (!ids) continue;
        for (const id of ids) {
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
    let ids = cells.get(key);
    if (!ids) {
      ids = new Set();
      cells.set(key, ids);
    }
    ids.add(instance.id);
    this.cellOf.set(instance.id, key);
  }

  private removeFromCell(instance: CreatureInstance): void {
    const key = this.cellOf.get(instance.id);
    if (key === undefined) return;
    const cells = this.maps.get(instance.map);
    const ids = cells?.get(key);
    if (ids) {
      ids.delete(instance.id);
      if (ids.size === 0) cells!.delete(key);
      if (cells!.size === 0) this.maps.delete(instance.map);
    }
    this.cellOf.delete(instance.id);
  }
}

const registry = new CreatureRegistry();
export default registry;
