import AOI_CONFIG from "../config/aoi.json";
import log from "../modules/logger";

interface LayerInfo {
  layerId: string;
  mapName: string;
  playerCount: number;
  players: Set<string>;
}

class LayerManager {
  private layers: Map<string, LayerInfo>;
  private playerToLayer: Map<string, string>;
  private readonly MAX_PLAYERS_PER_LAYER = AOI_CONFIG.MAX_PLAYERS_PER_LAYER;

  constructor() {
    this.layers = new Map();
    this.playerToLayer = new Map();
  }

  private generateLayerId(mapName: string): string {
    let layerNumber = 1;
    let layerId: string;

    do {
      layerId = `${mapName}:layer_${layerNumber}`;
      layerNumber++;
    } while (this.layers.has(layerId) && this.layers.get(layerId)!.playerCount >= this.MAX_PLAYERS_PER_LAYER);

    return layerId;
  }

  private findAvailableLayer(mapName: string): string {

    for (const [layerId, layerInfo] of this.layers.entries()) {
      if (layerInfo.mapName === mapName && layerInfo.playerCount < this.MAX_PLAYERS_PER_LAYER) {
        return layerId;
      }
    }

    const newLayerId = this.generateLayerId(mapName);
    this.layers.set(newLayerId, {
      layerId: newLayerId,
      mapName: mapName,
      playerCount: 0,
      players: new Set<string>(),
    });

    return newLayerId;
  }

  assignPlayerToLayer(playerId: string, mapName: string, preferredLayerId?: string): string {

    this.removePlayerFromLayer(playerId);

    if (preferredLayerId) {
      const preferredLayer = this.layers.get(preferredLayerId);
      if (preferredLayer && preferredLayer.mapName === mapName &&
          preferredLayer.playerCount < this.MAX_PLAYERS_PER_LAYER) {
        preferredLayer.players.add(playerId);
        preferredLayer.playerCount++;
        this.playerToLayer.set(playerId, preferredLayerId);
        return preferredLayerId;
      }
    }

    const layerId = this.findAvailableLayer(mapName);
    const layer = this.layers.get(layerId)!;

    layer.players.add(playerId);
    layer.playerCount++;
    this.playerToLayer.set(playerId, layerId);

    return layerId;
  }

  removePlayerFromLayer(playerId: string): void {
    const layerId = this.playerToLayer.get(playerId);
    if (!layerId) return;

    const layer = this.layers.get(layerId);
    if (layer) {
      layer.players.delete(playerId);
      layer.playerCount--;

      if (layer.playerCount === 0) {
        this.layers.delete(layerId);
      }
    }

    this.playerToLayer.delete(playerId);
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

      const availableSpace = this.MAX_PLAYERS_PER_LAYER - leaderLayer.playerCount;
      if (availableSpace <= 0) {
        break;
      }

      this.removePlayerFromLayer(memberId);

      const targetLayer = this.layers.get(leaderLayerId)!;
      targetLayer.players.add(memberId);
      targetLayer.playerCount++;
      this.playerToLayer.set(memberId, leaderLayerId);

      log.debug(`[LAYER] Synced party member ${memberId} to ${leaderLayerId}`);
    }

    const finalLayer = this.layers.get(leaderLayerId)!;
    log.debug(`[LAYER] Party synced to ${leaderLayerId} (${finalLayer.playerCount}/${this.MAX_PLAYERS_PER_LAYER})`);

    return leaderLayerId;
  }
}

const layerManager = new LayerManager();
export default layerManager;
