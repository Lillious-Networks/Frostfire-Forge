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
  private readonly MAX_PLAYERS_PER_LAYER = 50;

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

  assignPlayerToLayer(playerId: string, mapName: string): string {

    this.removePlayerFromLayer(playerId);

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

  syncPartyToLeaderLayer(partyLeaderPlayerId: string, partyMemberPlayerIds: string[], mapName: string): string | null {
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

    const membersNotInLeaderLayer = partyMemberPlayerIds.filter(id => {
      const memberLayerId = this.playerToLayer.get(id);
      return memberLayerId !== leaderLayerId;
    });

    const spaceNeeded = membersNotInLeaderLayer.length;
    const availableSpace = this.MAX_PLAYERS_PER_LAYER - leaderLayer.playerCount;

    let targetLayerId = leaderLayerId;

    if (spaceNeeded > availableSpace) {
      log.debug(`[LAYER] Leader's layer ${leaderLayerId} cannot fit party (need ${spaceNeeded} slots, have ${availableSpace}). Finding new layer...`);

      const totalPartySize = partyMemberPlayerIds.length + 1;

      let foundLayer: LayerInfo | null = null;
      for (const [layerId, layer] of this.layers.entries()) {
        if (layer.mapName === mapName &&
            (this.MAX_PLAYERS_PER_LAYER - layer.playerCount) >= totalPartySize) {
          foundLayer = layer;
          targetLayerId = layerId;
          break;
        }
      }

      if (!foundLayer) {
        targetLayerId = this.generateLayerId(mapName);
        this.layers.set(targetLayerId, {
          layerId: targetLayerId,
          mapName: mapName,
          playerCount: 0,
          players: new Set<string>(),
        });
        log.debug(`[LAYER] Created new layer ${targetLayerId} for party`);
      } else {
        log.debug(`[LAYER] Found existing layer ${targetLayerId} with space for party`);
      }

      this.removePlayerFromLayer(partyLeaderPlayerId);
      const targetLayer = this.layers.get(targetLayerId)!;
      targetLayer.players.add(partyLeaderPlayerId);
      targetLayer.playerCount++;
      this.playerToLayer.set(partyLeaderPlayerId, targetLayerId);
      log.debug(`[LAYER] Moved party leader ${partyLeaderPlayerId} to ${targetLayerId}`);
    }

    for (const memberId of partyMemberPlayerIds) {
      const currentLayerId = this.playerToLayer.get(memberId);

      if (currentLayerId !== targetLayerId) {

        this.removePlayerFromLayer(memberId);

        const targetLayer = this.layers.get(targetLayerId)!;
        targetLayer.players.add(memberId);
        targetLayer.playerCount++;
        this.playerToLayer.set(memberId, targetLayerId);

        log.debug(`[LAYER] Synced party member ${memberId} to ${targetLayerId}`);
      }
    }

    const finalLayer = this.layers.get(targetLayerId)!;
    log.debug(`[LAYER] Party synced to ${targetLayerId} (${finalLayer.playerCount}/${this.MAX_PLAYERS_PER_LAYER})`);

    return targetLayerId;
  }
}

const layerManager = new LayerManager();
export default layerManager;
