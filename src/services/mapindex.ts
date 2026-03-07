/**
 * Map Index Service
 *
 * Maintains an optimized index of players by map for O(1) lookup instead of O(n) linear search.
 * This replaces the expensive filterPlayersByMap() pattern used throughout the codebase.
 *
 * Usage:
 *   mapIndex.addPlayer(playerId, mapName)
 *   mapIndex.removePlayer(playerId)
 *   mapIndex.movePlayer(playerId, oldMap, newMap)
 *   mapIndex.getPlayersOnMap(mapName) // Returns Set<playerId>
 */

class MapIndex {
  // Map name -> Set of player IDs on that map
  private mapToPlayers: Map<string, Set<string>>;

  // Player ID -> Current map (for quick lookups during moves)
  private playerToMap: Map<string, string>;

  constructor() {
    this.mapToPlayers = new Map();
    this.playerToMap = new Map();
  }

  /**
   * Normalize map name by removing .json extension
   */
  private normalizeMapName(mapName: string): string {
    return mapName.replaceAll(".json", "");
  }

  /**
   * Add a player to a map
   */
  addPlayer(playerId: string, mapName: string): void {
    const normalizedMap = this.normalizeMapName(mapName);

    // Remove from old map if exists
    const oldMap = this.playerToMap.get(playerId);
    if (oldMap) {
      this.removePlayer(playerId);
    }

    // Add to new map
    if (!this.mapToPlayers.has(normalizedMap)) {
      this.mapToPlayers.set(normalizedMap, new Set());
    }

    this.mapToPlayers.get(normalizedMap)!.add(playerId);
    this.playerToMap.set(playerId, normalizedMap);
  }

  /**
   * Remove a player from all maps (typically on disconnect)
   */
  removePlayer(playerId: string): void {
    const currentMap = this.playerToMap.get(playerId);
    if (currentMap) {
      const playersOnMap = this.mapToPlayers.get(currentMap);
      if (playersOnMap) {
        playersOnMap.delete(playerId);

        // Clean up empty map entries
        if (playersOnMap.size === 0) {
          this.mapToPlayers.delete(currentMap);
        }
      }
    }
    this.playerToMap.delete(playerId);
  }

  /**
   * Move a player from one map to another (optimized version)
   */
  movePlayer(playerId: string, oldMapName: string, newMapName: string): void {
    const normalizedOldMap = this.normalizeMapName(oldMapName);
    const normalizedNewMap = this.normalizeMapName(newMapName);

    // Same map, no-op
    if (normalizedOldMap === normalizedNewMap) {
      return;
    }

    // Remove from old map
    const oldMapPlayers = this.mapToPlayers.get(normalizedOldMap);
    if (oldMapPlayers) {
      oldMapPlayers.delete(playerId);
      if (oldMapPlayers.size === 0) {
        this.mapToPlayers.delete(normalizedOldMap);
      }
    }

    // Add to new map
    if (!this.mapToPlayers.has(normalizedNewMap)) {
      this.mapToPlayers.set(normalizedNewMap, new Set());
    }
    this.mapToPlayers.get(normalizedNewMap)!.add(playerId);
    this.playerToMap.set(playerId, normalizedNewMap);
  }

  /**
   * Get all player IDs on a specific map - O(1) lookup
   */
  getPlayersOnMap(mapName: string): Set<string> {
    const normalizedMap = this.normalizeMapName(mapName);
    return this.mapToPlayers.get(normalizedMap) || new Set();
  }

  /**
   * Get the current map for a player
   */
  getPlayerMap(playerId: string): string | undefined {
    return this.playerToMap.get(playerId);
  }

  /**
   * Get total number of maps with players
   */
  getMapCount(): number {
    return this.mapToPlayers.size;
  }

  /**
   * Get total number of players tracked
   */
  getPlayerCount(): number {
    return this.playerToMap.size;
  }

  /**
   * Clear all data (useful for testing)
   */
  clear(): void {
    this.mapToPlayers.clear();
    this.playerToMap.clear();
  }

  /**
   * Rebuild index from player cache (useful for initialization or recovery)
   */
  rebuildFromCache(playerCache: any): void {
    this.clear();
    const players = playerCache.list();
    for (const [playerId, player] of Object.entries(players) as [string, any][]) {
      if (player && player.location && player.location.map) {
        this.addPlayer(playerId, player.location.map);
      }
    }
  }
}

// Export singleton instance
const mapIndex = new MapIndex();
export default mapIndex;
