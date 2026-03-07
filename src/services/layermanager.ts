import log from "../modules/logger";

/**
 * Layer management for distributing players across layers within maps
 * Each layer has a maximum capacity of 50 players
 */

interface LayerInfo {
  layerId: string;
  mapName: string;
  playerCount: number;
  players: Set<string>;
}

class LayerManager {
  private layers: Map<string, LayerInfo>; // Key: "mapName:layerId"
  private playerToLayer: Map<string, string>; // Key: playerId, Value: "mapName:layerId"
  private readonly MAX_PLAYERS_PER_LAYER = 50;

  constructor() {
    this.layers = new Map();
    this.playerToLayer = new Map();
  }

  /**
   * Generate a unique layer ID for a map
   */
  private generateLayerId(mapName: string): string {
    let layerNumber = 1;
    let layerId: string;

    do {
      layerId = `${mapName}:layer_${layerNumber}`;
      layerNumber++;
    } while (this.layers.has(layerId) && this.layers.get(layerId)!.playerCount >= this.MAX_PLAYERS_PER_LAYER);

    return layerId;
  }

  /**
   * Find or create a layer with available space for a player on the given map
   */
  private findAvailableLayer(mapName: string): string {
    // Find existing layer with space
    for (const [layerId, layerInfo] of this.layers.entries()) {
      if (layerInfo.mapName === mapName && layerInfo.playerCount < this.MAX_PLAYERS_PER_LAYER) {
        return layerId;
      }
    }

    // Create new layer if all are full
    const newLayerId = this.generateLayerId(mapName);
    this.layers.set(newLayerId, {
      layerId: newLayerId,
      mapName: mapName,
      playerCount: 0,
      players: new Set<string>(),
    });

    return newLayerId;
  }

  /**
   * Assign a player to a layer on a specific map
   * Returns the layer ID (e.g., "mapName:layer_1")
   */
  assignPlayerToLayer(playerId: string, mapName: string): string {
    // Remove player from old layer if they exist
    this.removePlayerFromLayer(playerId);

    // Find or create available layer
    const layerId = this.findAvailableLayer(mapName);
    const layer = this.layers.get(layerId)!;

    // Add player to layer
    layer.players.add(playerId);
    layer.playerCount++;
    this.playerToLayer.set(playerId, layerId);

    return layerId;
  }

  /**
   * Remove a player from their current layer
   */
  removePlayerFromLayer(playerId: string): void {
    const layerId = this.playerToLayer.get(playerId);
    if (!layerId) return;

    const layer = this.layers.get(layerId);
    if (layer) {
      layer.players.delete(playerId);
      layer.playerCount--;

      // Clean up empty layers
      if (layer.playerCount === 0) {
        this.layers.delete(layerId);
      }
    }

    this.playerToLayer.delete(playerId);
  }

  /**
   * Get the layer ID for a specific player
   */
  getPlayerLayer(playerId: string): string | null {
    return this.playerToLayer.get(playerId) || null;
  }

  /**
   * Get all players in the same layer as the given player
   */
  getPlayersInSameLayer(playerId: string): string[] {
    const layerId = this.playerToLayer.get(playerId);
    if (!layerId) return [];

    const layer = this.layers.get(layerId);
    return layer ? Array.from(layer.players) : [];
  }

  /**
   * Get all players in a specific layer
   */
  getPlayersInLayer(layerId: string): string[] {
    const layer = this.layers.get(layerId);
    return layer ? Array.from(layer.players) : [];
  }

  /**
   * Extract just the layer name from a full layer ID
   * e.g., "main:layer_1" -> "layer_1"
   */
  getLayerName(layerId: string): string {
    const parts = layerId.split(":");
    return parts.length > 1 ? parts[1] : layerId;
  }

  /**
   * Get layer info for a specific layer
   */
  getLayerInfo(layerId: string): LayerInfo | null {
    return this.layers.get(layerId) || null;
  }

  /**
   * Get all layers for a specific map
   */
  getLayersForMap(mapName: string): LayerInfo[] {
    const result: LayerInfo[] = [];
    for (const layer of this.layers.values()) {
      if (layer.mapName === mapName) {
        result.push(layer);
      }
    }
    return result;
  }

  /**
   * Get all layers (for internal operations like condensation)
   */
  getAllLayers(): Map<string, LayerInfo> {
    return new Map(this.layers);
  }

  /**
   * Get statistics about layers
   */
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

  /**
   * Synchronize all party members to the party leader's layer
   * If the leader's layer is full, find or create a new layer that can fit the entire party
   * Returns the target layer ID that all members should be on
   */
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

    // Check if leader's layer can accommodate all party members
    const membersNotInLeaderLayer = partyMemberPlayerIds.filter(id => {
      const memberLayerId = this.playerToLayer.get(id);
      return memberLayerId !== leaderLayerId;
    });

    const spaceNeeded = membersNotInLeaderLayer.length;
    const availableSpace = this.MAX_PLAYERS_PER_LAYER - leaderLayer.playerCount;

    let targetLayerId = leaderLayerId;

    // If leader's layer is full, find or create a new layer for the entire party
    if (spaceNeeded > availableSpace) {
      log.debug(`[LAYER] Leader's layer ${leaderLayerId} cannot fit party (need ${spaceNeeded} slots, have ${availableSpace}). Finding new layer...`);

      // Calculate total party size
      const totalPartySize = partyMemberPlayerIds.length + 1; // +1 for leader

      // Try to find an existing layer that can fit the entire party
      let foundLayer: LayerInfo | null = null;
      for (const [layerId, layer] of this.layers.entries()) {
        if (layer.mapName === mapName &&
            (this.MAX_PLAYERS_PER_LAYER - layer.playerCount) >= totalPartySize) {
          foundLayer = layer;
          targetLayerId = layerId;
          break;
        }
      }

      // If no suitable layer found, create a new one
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

      // Move leader to the new layer
      this.removePlayerFromLayer(partyLeaderPlayerId);
      const targetLayer = this.layers.get(targetLayerId)!;
      targetLayer.players.add(partyLeaderPlayerId);
      targetLayer.playerCount++;
      this.playerToLayer.set(partyLeaderPlayerId, targetLayerId);
      log.debug(`[LAYER] Moved party leader ${partyLeaderPlayerId} to ${targetLayerId}`);
    }

    // Move all party members to the target layer
    for (const memberId of partyMemberPlayerIds) {
      const currentLayerId = this.playerToLayer.get(memberId);

      if (currentLayerId !== targetLayerId) {
        // Remove from current layer
        this.removePlayerFromLayer(memberId);

        // Add to target layer
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
