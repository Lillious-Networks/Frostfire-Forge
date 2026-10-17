// Which gathering nodes each player is sent: those on their layer within their AOI radius, as creatures are
// (creatures/sync.ts). A node is sent once when it comes in range and despawned when the player is well past the
// edge (radius * SYNC_EXIT_HYSTERESIS), so standing at the edge does not churn. The client clears its nodes on
// LOAD_MAP, so a map load is answered with resync. Nodes are found by the spawner's spatial cells (nodesNear), and
// nodes that spawn are queued and sent once per tick (flush), one packet per player, not one per node.
import { SYNC_EXIT_HYSTERESIS } from "../creatures/constants";
import type { GatherNode, GatherNodeSnapshot } from "./types";

/** Nodes sent to one player per refresh: a crowded area arrives over a few refreshes. */
export const MAX_ENTER_PER_REFRESH = 150;

export interface GatherViewer {
  id: string;
  wt: any;
  map: string;
  layerId: string | null;
  x: number;
  y: number;
  radius: number;
}

export interface GatherSyncDeps {
  /** Nodes on a layer within `radius` of (x, y). */
  nodesNear(map: string, layerId: string, x: number, y: number, radius: number): GatherNode[];
  get(id: number): GatherNode | undefined;
  mapsWithNodes(): Iterable<string>;
  /** Every connected, in-world player id on `map`. */
  playersOnMap(map: string): Iterable<string>;
  resolvePlayer(id: string): GatherViewer | null;
  snapshot(node: GatherNode): GatherNodeSnapshot;
  sendSpawn(wt: any, nodes: GatherNodeSnapshot[]): void;
  sendDespawn(wt: any, ids: number[]): void;
}

interface ViewerState {
  map: string;
  layerId: string | null;
  ids: Set<number>;
}

const EMPTY: ReadonlySet<number> = new Set();

/** Stable bucket for a player id, so each player lands in the same slice every cycle. */
function sliceOf(playerId: string, slices: number): number {
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) hash = (hash * 31 + playerId.charCodeAt(i)) | 0;
  return Math.abs(hash) % slices;
}

const within = (node: GatherNode, v: GatherViewer, radius: number) => {
  const dx = node.x - v.x;
  const dy = node.y - v.y;
  return dx * dx + dy * dy <= radius * radius;
};

const layerKey = (map: string, layerId: string) => `${map}|${layerId}`;

export class GatherSync {
  private viewers = new Map<string, ViewerState>();
  /** map|layer -> nodes spawned since the last flush */
  private fresh = new Map<string, Map<number, GatherNode>>();

  constructor(private readonly deps: GatherSyncDeps) {}

  knownBy(playerId: string): ReadonlySet<number> {
    return this.viewers.get(playerId)?.ids ?? EMPTY;
  }

  forget(playerId: string): void {
    this.viewers.delete(playerId);
  }

  /** The client cleared its nodes (a map was loaded): send everything in range again. */
  resync(playerId: string): void {
    this.forget(playerId);
    const player = this.deps.resolvePlayer(playerId);
    if (player) this.refreshPlayer(player);
  }

  /** Refreshes one slice of the players on maps with nodes; forgets players no longer on any of them. */
  refresh(slice = 0, slices = 1): void {
    const maps = new Set<string>(this.deps.mapsWithNodes());
    for (const v of this.viewers.values()) maps.add(v.map);
    const seen = new Set<string>();
    for (const map of maps) {
      for (const playerId of this.deps.playersOnMap(map)) {
        if (seen.has(playerId)) continue;
        seen.add(playerId);
        if (slices > 1 && sliceOf(playerId, slices) !== slice) continue;
        const player = this.deps.resolvePlayer(playerId);
        if (player) this.refreshPlayer(player);
      }
    }
    for (const playerId of [...this.viewers.keys()]) {
      if (!seen.has(playerId)) this.forget(playerId);
    }
  }

  refreshPlayer(player: GatherViewer): void {
    let state = this.viewers.get(player.id);
    if (state && state.map === player.map && state.layerId !== player.layerId) {
      // Same map, new layer: every node is on one layer, so all of the old layer's go.
      const stale = [...state.ids];
      state.ids.clear();
      if (stale.length > 0) this.deps.sendDespawn(player.wt, stale);
      state.layerId = player.layerId;
    }
    if (!state || state.map !== player.map) {
      state = { map: player.map, layerId: player.layerId, ids: new Set() };
      this.viewers.set(player.id, state);
    }

    const exitRadius = player.radius * SYNC_EXIT_HYSTERESIS;
    const exit: number[] = [];
    for (const id of state.ids) {
      const node = this.deps.get(id);
      if (!node || node.map !== player.map || node.layerId !== player.layerId || !within(node, player, exitRadius)) exit.push(id);
    }
    if (exit.length > 0) {
      for (const id of exit) state.ids.delete(id);
      this.deps.sendDespawn(player.wt, exit);
    }

    if (player.layerId === null) return;
    this.sendEntering(player, state, this.deps.nodesNear(player.map, player.layerId, player.x, player.y, player.radius));
  }

  /** A node spawned: queued for the players who see its layer and are in range, and sent on the next flush. */
  onSpawn(node: GatherNode): void {
    const key = layerKey(node.map, node.layerId);
    let nodes = this.fresh.get(key);
    if (!nodes) this.fresh.set(key, (nodes = new Map()));
    nodes.set(node.id, node);
  }

  /**
   * Sends the nodes spawned since the last flush: one packet per player, at most MAX_ENTER_PER_REFRESH of them; any
   * left over are not marked sent, so the player's next refresh picks them up. Called once per tick.
   */
  flush(): void {
    if (this.fresh.size === 0) return;
    const fresh = this.fresh;
    this.fresh = new Map();
    const maps = new Set<string>();
    for (const nodes of fresh.values()) for (const node of nodes.values()) maps.add(node.map);
    for (const map of maps) {
      for (const playerId of this.deps.playersOnMap(map)) {
        const state = this.viewers.get(playerId);
        // a player not refreshed yet gets everything in range on their first refresh
        if (!state || state.map !== map || state.layerId === null) continue;
        const nodes = fresh.get(layerKey(map, state.layerId));
        if (!nodes) continue;
        const player = this.deps.resolvePlayer(playerId);
        if (!player || player.map !== map || player.layerId !== state.layerId) continue;
        this.sendEntering(player, state, nodes.values(), true);
      }
    }
  }

  /** Sends the nodes of `nodes` the player is in range of and was not sent yet, at most MAX_ENTER_PER_REFRESH. */
  private sendEntering(player: GatherViewer, state: ViewerState, nodes: Iterable<GatherNode>, checkRange = false): void {
    const enter: GatherNodeSnapshot[] = [];
    for (const node of nodes) {
      if (enter.length >= MAX_ENTER_PER_REFRESH) break;
      if (state.ids.has(node.id) || (checkRange && !within(node, player, player.radius))) continue;
      state.ids.add(node.id);
      enter.push(this.deps.snapshot(node));
    }
    if (enter.length > 0) this.deps.sendSpawn(player.wt, enter);
  }

  /** A node is gone: everyone who was sent it is told, and a queued spawn of it is dropped. */
  onDespawn(node: GatherNode): void {
    const queued = this.fresh.get(layerKey(node.map, node.layerId));
    queued?.delete(node.id);
    if (queued?.size === 0) this.fresh.delete(layerKey(node.map, node.layerId));
    for (const [playerId, state] of this.viewers) {
      if (!state.ids.delete(node.id)) continue;
      const player = this.deps.resolvePlayer(playerId);
      if (player) this.deps.sendDespawn(player.wt, [node.id]);
    }
  }
}
