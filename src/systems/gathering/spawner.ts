// Keeps every gathering area filled with nodes, on every layer of its map, as the creature spawner keeps its spawn
// points (creatures/spawner.ts). Each area on each layer is a slot: its standing nodes, and when each missing one is
// due. A gathered node is taken out at once (before anything is awaited, so no one else can take it) and its slot
// gets a respawn time; a node whose item could not be given is put back and that respawn cancelled.
import log from "../../modules/logger";
import { NODE_GAP, apart, pickSpot } from "./placement";
import type { GatherArea, GatherGrid, GatherNode, Rng } from "./types";

/** Nodes spawned in one tick; the rest wait for the next one. */
export const MAX_SPAWNS_PER_TICK = 200;
/** How long a slot that found no free walkable tile waits before it tries again. */
export const RETRY_MS = 5_000;
/** The most nodes one area keeps standing on one layer. */
export const MAX_NODES_PER_AREA = 200;
/** Spatial bucket size for node lookups, as creatures use (CREATURE_CELL_PX). */
export const GATHER_CELL_PX = 512;
/** The biggest a node is drawn, px: the editor's limit, and how far a new node looks for others it could overlap. */
export const MAX_NODE_SIZE = 128;

export interface SpawnerHooks {
  onSpawn?(node: GatherNode): void;
  onDespawn?(node: GatherNode): void;
}

/** One area on one layer. */
interface Slot {
  area: GatherArea;
  layerId: string;
  live: Set<number>;
  /** When each missing node is due. */
  due: number[];
}

const slotKey = (areaId: number, layerId: string) => `${areaId}|${layerId}`;
const layerKey = (map: string, layerId: string) => `${map}|${layerId}`;
const cellOf = (v: number) => Math.floor(v / GATHER_CELL_PX);
const cellKey = (x: number, y: number) => `${cellOf(x)},${cellOf(y)}`;
/** Areas are always built with their keys in the same order (editor.toArea), so this compares every field. */
const sameArea = (a: GatherArea, b: GatherArea) => JSON.stringify(a) === JSON.stringify(b);

export function rollRespawnMs(area: GatherArea, r: Rng): number {
  return Math.max(0, Math.round((area.respawn_min_s + r() * (area.respawn_max_s - area.respawn_min_s)) * 1000));
}

export class GatherSpawner {
  private areas = new Map<number, GatherArea>();
  private slots = new Map<string, Slot>();
  private nodes = new Map<number, GatherNode>();
  /** map|layer -> node ids */
  private byLayer = new Map<string, Set<number>>();
  /** map|layer -> tiles with a node */
  private tiles = new Map<string, Set<string>>();
  /** map|layer -> cell "cx,cy" -> nodes standing in it, so a radius query only reads nearby cells (nodes never move) */
  private cells = new Map<string, Map<string, Set<GatherNode>>>();
  /** map -> live layer ids */
  private layers = new Map<string, Set<string>>();
  /** Taken nodes not yet settled: the slot they came from and the respawn their take queued. */
  private taken = new Map<number, { slot: Slot; dueAt: number }>();
  /** Slots whose layer went away: their pending respawn times, kept until `until` in case the layer comes back. */
  private parked = new Map<string, { area: GatherArea; due: number[]; until: number }>();
  private nextId = 1;

  constructor(
    private readonly gridFor: (map: string) => GatherGrid | undefined,
    private readonly hooks: SpawnerHooks = {},
    private readonly r: Rng = Math.random,
  ) {}

  /** Maps with an enabled area: the ones whose layers matter. */
  maps(): string[] {
    return [...new Set([...this.areas.values()].map((area) => area.map))];
  }

  area(id: number): GatherArea | undefined {
    return this.areas.get(id);
  }

  get(id: number): GatherNode | undefined {
    return this.nodes.get(id);
  }

  nodesOn(map: string, layerId: string): GatherNode[] {
    const out: GatherNode[] = [];
    for (const id of this.byLayer.get(layerKey(map, layerId)) ?? []) {
      const node = this.nodes.get(id);
      if (node) out.push(node);
    }
    return out;
  }

  /** Nodes on a layer within `radius` of (x, y): the cells the circle touches, then the exact distance. */
  nodesNear(map: string, layerId: string, x: number, y: number, radius: number, out: GatherNode[] = []): GatherNode[] {
    const cells = this.cells.get(layerKey(map, layerId));
    if (!cells) return out;
    const r2 = radius * radius;
    const maxCx = cellOf(x + radius);
    const maxCy = cellOf(y + radius);
    for (let cx = cellOf(x - radius); cx <= maxCx; cx++) {
      for (let cy = cellOf(y - radius); cy <= maxCy; cy++) {
        for (const node of cells.get(`${cx},${cy}`) ?? []) {
          const dx = node.x - x;
          const dy = node.y - y;
          if (dx * dx + dy * dy <= r2) out.push(node);
        }
      }
    }
    return out;
  }

  countOn(areaId: number, layerId: string): number {
    return this.slots.get(slotKey(areaId, layerId))?.live.size ?? 0;
  }

  /** Swap in the areas. An area that changed or went away loses its nodes and is filled again; the others keep theirs. */
  setAreas(areas: GatherArea[], now: number): void {
    const next = new Map(areas.filter((area) => area.enabled).map((area) => [area.id, area] as const));
    for (const [key, slot] of [...this.slots]) {
      const kept = next.get(slot.area.id);
      if (!kept || !sameArea(kept, slot.area)) this.dropSlot(key);
    }
    for (const [key, held] of [...this.parked]) {
      const kept = next.get(held.area.id);
      if (!kept || !sameArea(kept, held.area)) this.parked.delete(key);
    }
    this.areas = next;
    this.fillSlots(now);
  }

  /** The live layers of each map. A new layer gets every area of its map; a layer that is gone loses its nodes. */
  setLayers(layersByMap: Map<string, Iterable<string>>, now: number): void {
    const next = new Map<string, Set<string>>();
    for (const [map, ids] of layersByMap) next.set(map, new Set(ids));
    this.layers = next;
    for (const [key, slot] of [...this.slots]) {
      if (next.get(slot.area.map)?.has(slot.layerId)) continue;
      // the layer may come back (a party leaves and returns): its gathered nodes keep waiting for a while
      this.parked.set(key, {
        area: slot.area,
        due: slot.due.filter((at) => at > now),
        until: now + slot.area.respawn_max_s * 1000,
      });
      this.dropSlot(key);
    }
    for (const [key, held] of [...this.parked]) if (held.until < now) this.parked.delete(key);
    this.fillSlots(now);
  }

  tick(now: number): void {
    let budget = MAX_SPAWNS_PER_TICK;
    for (const slot of this.slots.values()) {
      let i = 0;
      while (i < slot.due.length) {
        if (slot.due[i]! > now) {
          i++;
          continue;
        }
        if (budget-- <= 0) return;
        if (this.spawn(slot)) {
          slot.due.splice(i, 1);
        } else {
          slot.due[i] = now + RETRY_MS;
          i++;
        }
      }
    }
  }

  /** Takes a node out of the world: it was gathered. Its slot refills after the area's respawn time. Null when it is gone. */
  take(id: number, now: number): GatherNode | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    const slot = this.slots.get(slotKey(node.areaId, node.layerId));
    this.removeNode(node);
    if (slot) {
      const dueAt = now + rollRespawnMs(slot.area, this.r);
      slot.due.push(dueAt);
      this.taken.set(node.id, { slot, dueAt });
    }
    return node;
  }

  /** The item of a taken node was given: nothing is put back. */
  settle(id: number): void {
    this.taken.delete(id);
  }

  /** Puts back a taken node whose item could not be given. False when its area changed, or its slot already refilled. */
  restore(node: GatherNode): boolean {
    const held = this.taken.get(node.id);
    this.taken.delete(node.id);
    if (!held) return false;
    const { slot, dueAt } = held;
    if (this.slots.get(slotKey(node.areaId, node.layerId)) !== slot) return false;
    if (this.tiles.get(layerKey(node.map, node.layerId))?.has(node.tile)) return false;
    const at = slot.due.indexOf(dueAt);
    if (at === -1) return false;
    slot.due.splice(at, 1);
    this.addNode(node, slot);
    return true;
  }

  private fillSlots(now: number): void {
    for (const area of this.areas.values()) {
      for (const layerId of this.layers.get(area.map) ?? []) {
        const key = slotKey(area.id, layerId);
        if (this.slots.has(key)) continue;
        const held = this.parked.get(key);
        this.parked.delete(key);
        // the nodes that stood when the layer went away come back at once; the gathered ones keep waiting
        const waiting = held && held.until >= now && sameArea(held.area, area) ? held.due.slice(0, area.max_nodes) : [];
        const due = [...waiting, ...Array.from({ length: area.max_nodes - waiting.length }, () => now)];
        this.slots.set(key, { area, layerId, live: new Set(), due });
      }
    }
  }

  private spawn(slot: Slot): boolean {
    const grid = this.gridFor(slot.area.map);
    if (!grid) return false;
    const { map, size } = slot.area;
    // no picture may overlap another node's, whatever area that one is from
    const clear = (x: number, y: number) =>
      this.nodesNear(map, slot.layerId, x, y, (size + MAX_NODE_SIZE) / 2 * Math.SQRT2 + NODE_GAP)
        .every((other) => apart({ x, y, size }, { x: other.x, y: other.y, size: this.areas.get(other.areaId)?.size ?? size }));
    const spot = pickSpot(grid, slot.area, this.tiles.get(layerKey(map, slot.layerId)) ?? new Set(), this.r, clear);
    if (!spot) return false;
    this.addNode({ id: this.nextId++, areaId: slot.area.id, map: slot.area.map, layerId: slot.layerId, x: spot.x, y: spot.y, item: slot.area.item, tile: spot.tile }, slot);
    return true;
  }

  private addNode(node: GatherNode, slot: Slot): void {
    const key = layerKey(node.map, node.layerId);
    this.nodes.set(node.id, node);
    slot.live.add(node.id);
    let ids = this.byLayer.get(key);
    if (!ids) this.byLayer.set(key, (ids = new Set()));
    ids.add(node.id);
    let tiles = this.tiles.get(key);
    if (!tiles) this.tiles.set(key, (tiles = new Set()));
    tiles.add(node.tile);
    let cells = this.cells.get(key);
    if (!cells) this.cells.set(key, (cells = new Map()));
    const cell = cellKey(node.x, node.y);
    let inCell = cells.get(cell);
    if (!inCell) cells.set(cell, (inCell = new Set()));
    inCell.add(node);
    try {
      this.hooks.onSpawn?.(node);
    } catch (error) {
      log.error(`[Gathering] A node spawn hook failed: ${error}`);
    }
  }

  private removeNode(node: GatherNode): void {
    const key = layerKey(node.map, node.layerId);
    this.nodes.delete(node.id);
    this.slots.get(slotKey(node.areaId, node.layerId))?.live.delete(node.id);
    const ids = this.byLayer.get(key);
    ids?.delete(node.id);
    if (ids?.size === 0) this.byLayer.delete(key);
    const tiles = this.tiles.get(key);
    tiles?.delete(node.tile);
    if (tiles?.size === 0) this.tiles.delete(key);
    const cells = this.cells.get(key);
    const cell = cellKey(node.x, node.y);
    const inCell = cells?.get(cell);
    inCell?.delete(node);
    if (inCell?.size === 0) cells!.delete(cell);
    if (cells?.size === 0) this.cells.delete(key);
    try {
      this.hooks.onDespawn?.(node);
    } catch (error) {
      log.error(`[Gathering] A node despawn hook failed: ${error}`);
    }
  }

  private dropSlot(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    for (const id of [...slot.live]) {
      const node = this.nodes.get(id);
      if (node) this.removeNode(node);
    }
    this.slots.delete(key);
  }
}
