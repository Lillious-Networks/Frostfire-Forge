import { BLOCK_SIZE_PX } from "./blocks";
import type { ClusterStore } from "./store";

// The size of every map in blocks, published by the nodes that load the maps so
// the coordinator can lay out the block table without having the maps itself.
// Names have no ".json", as in `accounts.map`.

export interface MapExtent {
  name: string;
  widthPx: number;
  heightPx: number;
  blocksX: number;
  blocksY: number;
}

const LIST_KEY = "cells:maplist";
const mapKey = (name: string) => `cells:map:${name}`;
const bare = (name: string) => name.replace(/\.json$/, "");

/** A map smaller than one block still owns that one block. */
export function extentOf(name: string, widthPx: number, heightPx: number): MapExtent {
  return {
    name: bare(name),
    widthPx,
    heightPx,
    blocksX: Math.max(1, Math.ceil(widthPx / BLOCK_SIZE_PX)),
    blocksY: Math.max(1, Math.ceil(heightPx / BLOCK_SIZE_PX)),
  };
}

export class MapCatalogue {
  constructor(private store: ClusterStore) {}

  async publish(extents: MapExtent[]): Promise<void> {
    for (const extent of extents) {
      const name = bare(extent.name);
      await this.store.set(mapKey(name), JSON.stringify({ ...extent, name }));
      await this.store.addToSet(LIST_KEY, name);
    }
  }

  /** Every published map, by name. */
  async all(): Promise<MapExtent[]> {
    const extents: MapExtent[] = [];
    for (const name of (await this.store.members(LIST_KEY)).sort()) {
      const raw = await this.store.get(mapKey(name));
      if (!raw) continue;
      try {
        extents.push(JSON.parse(raw) as MapExtent);
      } catch {
        // A corrupt entry is skipped; the next publish rewrites it.
      }
    }
    return extents;
  }
}
