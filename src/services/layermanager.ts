import AOI_CONFIG from "../config/aoi.json";
import log from "../modules/logger";

interface LayerInfo {
  layerId: string;
  mapName: string;
  playerCount: number;
  players: Set<string>;
}

// Read with a fallback: aoi.json is generated, so an older file (or a test's
// stand-in) may not have the key yet.
const BLOCK_SIZE_PX: number = (AOI_CONFIG as { BLOCK_SIZE_PX?: number }).BLOCK_SIZE_PX ?? 4096;

// Most players of one layer in one block, checked when a player is placed
// (login, warp, map change, summon/teleport). Walking into a crowded block
// never moves a player to another layer.
export const MAX_PLAYERS_PER_LAYER: number =
  (AOI_CONFIG as { MAX_PLAYERS_PER_LAYER?: number }).MAX_PLAYERS_PER_LAYER ?? 150;

// A block is a square of the map, named by its grid coordinates. Layers are
// capped per block, so a big map only splits where one area is crowded.
export function blockOf(x: number, y: number, blockSizePx: number = BLOCK_SIZE_PX): string {
  return `${Math.floor(x / blockSizePx)},${Math.floor(y / blockSizePx)}`;
}

// "main:layer_3" -> 3. Only used to order layers of a map.
function layerNumber(layerId: string): number {
  const at = layerId.lastIndexOf(":layer_");
  return at === -1 ? Number.MAX_SAFE_INTEGER : parseInt(layerId.slice(at + 7), 10);
}

// Layer 1 is the base layer of every map; higher layers are overflow.
export function isBaseLayer(layerId: string): boolean {
  return layerNumber(layerId) === 1;
}

interface LayerManagerOptions {
  maxPlayersPerBlock?: number;
  blockSizePx?: number;
}

/** Cluster mode: numbers for layers above 1 that no other node uses (cluster/layerseq.ts); null when none is ready. */
export interface LayerNumberSource {
  take(mapName: string): number | null;
}

export class LayerManager {
  private layers: Map<string, LayerInfo>;
  private playerToLayer: Map<string, string>;
  // layerId -> block -> how many of the layer's players stand in that block
  private blockCounts: Map<string, Map<string, number>>;
  private playerBlock: Map<string, string>;
  private readonly MAX_PLAYERS_PER_LAYER: number;
  private readonly blockSizePx: number;
  private numbers: LayerNumberSource | null = null;
  private warnedNoNumber = false;

  constructor(options: LayerManagerOptions = {}) {
    this.layers = new Map();
    this.playerToLayer = new Map();
    this.blockCounts = new Map();
    this.playerBlock = new Map();
    this.MAX_PLAYERS_PER_LAYER = options.maxPlayersPerBlock ?? MAX_PLAYERS_PER_LAYER;
    this.blockSizePx = options.blockSizePx ?? BLOCK_SIZE_PX;
  }

  /** Cluster mode: layers above 1 take their numbers from `source`. Null: the lowest free number, as on one server. */
  useLayerNumbers(source: LayerNumberSource | null): void {
    this.numbers = source;
  }

  private generateLayerId(mapName: string): string {
    // Layer 1 is the base layer of the map on every node. Above it, in a cluster, the number is the world's: a
    // reserved one this node does not already use (the local rule below may have taken it while the pool was empty).
    if (this.numbers && this.layers.has(`${mapName}:layer_1`)) {
      for (let n = this.numbers.take(mapName); n !== null; n = this.numbers.take(mapName)) {
        if (!this.layers.has(`${mapName}:layer_${n}`)) return `${mapName}:layer_${n}`;
      }
      if (!this.warnedNoNumber) {
        this.warnedNoNumber = true;
        log.warn(`[LAYER] No reserved layer number was ready for ${mapName}: numbering by the lowest free one, which another node may also use`);
      }
    }
    let layerNumber = 1;
    while (this.layers.has(`${mapName}:layer_${layerNumber}`)) layerNumber++;
    return `${mapName}:layer_${layerNumber}`;
  }

  countInBlock(layerId: string, block: string): number {
    return this.blockCounts.get(layerId)?.get(block) ?? 0;
  }

  private hasRoom(layerId: string, block: string): boolean {
    return this.countInBlock(layerId, block) < this.MAX_PLAYERS_PER_LAYER;
  }

  // The lowest-numbered existing layer of the map with room in the block (and
  // numbered below `below`), so players settle into low layers and the high
  // ones empty out and disappear.
  private lowestLayerWithRoom(mapName: string, block: string, below: number = Infinity): string | null {
    let best: string | null = null;
    let bestNumber = below;
    for (const [layerId, layerInfo] of this.layers.entries()) {
      if (layerInfo.mapName !== mapName || !this.hasRoom(layerId, block)) continue;
      const n = layerNumber(layerId);
      if (n < bestNumber) {
        best = layerId;
        bestNumber = n;
      }
    }
    return best;
  }

  private findAvailableLayer(mapName: string, block: string): string {
    const existing = this.lowestLayerWithRoom(mapName, block);
    if (existing) return existing;

    const newLayerId = this.generateLayerId(mapName);
    this.layers.set(newLayerId, {
      layerId: newLayerId,
      mapName: mapName,
      playerCount: 0,
      players: new Set<string>(),
    });

    return newLayerId;
  }

  private addToLayer(playerId: string, layerId: string, block: string): void {
    const layer = this.layers.get(layerId)!;
    layer.players.add(playerId);
    layer.playerCount++;
    this.playerToLayer.set(playerId, layerId);
    this.playerBlock.set(playerId, block);

    let counts = this.blockCounts.get(layerId);
    if (!counts) {
      counts = new Map();
      this.blockCounts.set(layerId, counts);
    }
    counts.set(block, (counts.get(block) ?? 0) + 1);
  }

  private decrementBlock(counts: Map<string, number>, block: string): void {
    const next = (counts.get(block) ?? 0) - 1;
    if (next > 0) counts.set(block, next);
    else counts.delete(block);
  }

  assignPlayerToLayer(playerId: string, mapName: string, x: number, y: number, preferredLayerId?: string): string {

    this.removePlayerFromLayer(playerId);

    const block = blockOf(x, y, this.blockSizePx);

    if (preferredLayerId) {
      const preferredLayer = this.layers.get(preferredLayerId);
      if (preferredLayer && preferredLayer.mapName === mapName && this.hasRoom(preferredLayerId, block)) {
        this.addToLayer(playerId, preferredLayerId, block);
        return preferredLayerId;
      }
    }

    const layerId = this.findAvailableLayer(mapName, block);
    this.addToLayer(playerId, layerId, block);

    return layerId;
  }

  // Call when a player's position changes. Keeps the block counts right and,
  // for a player parked on a high layer because their old block was crowded,
  // returns the lower layer they can now join (the caller moves them with
  // movePlayerToLayer). Only looked at on a block change, not on every step.
  updatePlayerBlock(playerId: string, x: number, y: number): string | null {
    const layerId = this.playerToLayer.get(playerId);
    if (!layerId) return null;

    const block = blockOf(x, y, this.blockSizePx);
    const oldBlock = this.playerBlock.get(playerId);
    if (block === oldBlock) return null;

    const counts = this.blockCounts.get(layerId)!;
    if (oldBlock !== undefined) this.decrementBlock(counts, oldBlock);
    counts.set(block, (counts.get(block) ?? 0) + 1);
    this.playerBlock.set(playerId, block);

    return this.lowestLayerWithRoom(this.layers.get(layerId)!.mapName, block, layerNumber(layerId));
  }

  // The lowest layer numbered below the player's own with room in the block
  // they stand in, or null. Never a higher-numbered layer.
  lowerLayerWithRoom(playerId: string): string | null {
    const layerId = this.playerToLayer.get(playerId);
    const block = this.playerBlock.get(playerId);
    const layer = layerId ? this.layers.get(layerId) : undefined;
    if (!layerId || !layer || block === undefined) return null;
    return this.lowestLayerWithRoom(layer.mapName, block, layerNumber(layerId));
  }

  // The one way to move a player between layers of a map. The player keeps the
  // block they are standing in.
  movePlayerToLayer(playerId: string, layerId: string): void {
    if (!this.layers.has(layerId)) return;
    if (this.playerToLayer.get(playerId) === layerId) return;

    const block = this.playerBlock.get(playerId) ?? blockOf(0, 0, this.blockSizePx);
    this.removePlayerFromLayer(playerId);
    this.addToLayer(playerId, layerId, block);
  }

  removePlayerFromLayer(playerId: string): void {
    const layerId = this.playerToLayer.get(playerId);
    if (!layerId) return;

    const layer = this.layers.get(layerId);
    if (layer) {
      layer.players.delete(playerId);
      layer.playerCount--;

      const counts = this.blockCounts.get(layerId);
      const block = this.playerBlock.get(playerId);
      if (counts && block !== undefined) this.decrementBlock(counts, block);

      if (layer.playerCount === 0) {
        this.layers.delete(layerId);
        this.blockCounts.delete(layerId);
      }
    }

    this.playerToLayer.delete(playerId);
    this.playerBlock.delete(playerId);
  }

  getPlayerLayer(playerId: string): string | null {
    return this.playerToLayer.get(playerId) || null;
  }

  getPlayersInSameLayer(playerId: string): string[] {
    const layerId = this.playerToLayer.get(playerId);
    if (!layerId) return [];

    const layer = this.layers.get(layerId);
    return layer ? Array.from(layer.players) : [];
  }

  getPlayersInLayer(layerId: string): string[] {
    const layer = this.layers.get(layerId);
    return layer ? Array.from(layer.players) : [];
  }

  getLayerName(layerId: string): string {
    const parts = layerId.split(":");
    return parts.length > 1 ? parts[1] : layerId;
  }

  getLayerInfo(layerId: string): LayerInfo | null {
    return this.layers.get(layerId) || null;
  }

  getLayersForMap(mapName: string): LayerInfo[] {
    const result: LayerInfo[] = [];
    for (const layer of this.layers.values()) {
      if (layer.mapName === mapName) {
        result.push(layer);
      }
    }
    return result;
  }

  getAllLayers(): Map<string, LayerInfo> {
    return new Map(this.layers);
  }

  getStats(): { totalLayers: number; totalPlayers: number; layersByMap: Map<string, number> } {
    const layersByMap = new Map<string, number>();
    let totalPlayers = 0;

    for (const layer of this.layers.values()) {
      layersByMap.set(layer.mapName, (layersByMap.get(layer.mapName) || 0) + 1);
      totalPlayers += layer.playerCount;
    }

    return {
      totalLayers: this.layers.size,
      totalPlayers,
      layersByMap,
    };
  }

  syncPartyToLeaderLayer(partyLeaderPlayerId: string, partyMemberPlayerIds: string[], _mapName: string): string | null {
    const leaderLayerId = this.playerToLayer.get(partyLeaderPlayerId);

    if (!leaderLayerId) {
      log.warn(`[LAYER] Party leader ${partyLeaderPlayerId} has no layer assignment`);
      return null;
    }

    const leaderLayer = this.layers.get(leaderLayerId);
    if (!leaderLayer) {
      log.warn(`[LAYER] Party leader's layer ${leaderLayerId} not found`);
      return null;
    }

    for (const memberId of partyMemberPlayerIds) {
      const currentLayerId = this.playerToLayer.get(memberId);

      if (!currentLayerId || currentLayerId === leaderLayerId) {
        continue;
      }

      // Room is per block: a member standing in a crowded block stays where
      // they are, members elsewhere can still join.
      const memberBlock = this.playerBlock.get(memberId);
      if (memberBlock === undefined || !this.hasRoom(leaderLayerId, memberBlock)) {
        continue;
      }

      this.movePlayerToLayer(memberId, leaderLayerId);

      log.debug(`[LAYER] Synced party member ${memberId} to ${leaderLayerId}`);
    }

    const finalLayer = this.layers.get(leaderLayerId)!;
    log.debug(`[LAYER] Party synced to ${leaderLayerId} (${finalLayer.playerCount} players)`);

    return leaderLayerId;
  }
}

const layerManager = new LayerManager();
export default layerManager;
