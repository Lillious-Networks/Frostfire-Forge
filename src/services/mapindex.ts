

class MapIndex {

  private mapToPlayers: Map<string, Set<string>>;

  private playerToMap: Map<string, string>;

  constructor() {
    this.mapToPlayers = new Map();
    this.playerToMap = new Map();
  }

  private normalizeMapName(mapName: string): string {
    return mapName.replaceAll(".json", "");
  }

  addPlayer(playerId: string, mapName: string): void {
    const normalizedMap = this.normalizeMapName(mapName);

    const oldMap = this.playerToMap.get(playerId);
    if (oldMap) {
      this.removePlayer(playerId);
    }

    if (!this.mapToPlayers.has(normalizedMap)) {
      this.mapToPlayers.set(normalizedMap, new Set());
    }

    this.mapToPlayers.get(normalizedMap)!.add(playerId);
    this.playerToMap.set(playerId, normalizedMap);
  }

  removePlayer(playerId: string): void {
    const currentMap = this.playerToMap.get(playerId);
    if (currentMap) {
      const playersOnMap = this.mapToPlayers.get(currentMap);
      if (playersOnMap) {
        playersOnMap.delete(playerId);

        if (playersOnMap.size === 0) {
          this.mapToPlayers.delete(currentMap);
        }
      }
    }
    this.playerToMap.delete(playerId);
  }

  movePlayer(playerId: string, oldMapName: string, newMapName: string): void {
    const normalizedOldMap = this.normalizeMapName(oldMapName);
    const normalizedNewMap = this.normalizeMapName(newMapName);

    if (normalizedOldMap === normalizedNewMap) {
      return;
    }

    const oldMapPlayers = this.mapToPlayers.get(normalizedOldMap);
    if (oldMapPlayers) {
      oldMapPlayers.delete(playerId);
      if (oldMapPlayers.size === 0) {
        this.mapToPlayers.delete(normalizedOldMap);
      }
    }

    if (!this.mapToPlayers.has(normalizedNewMap)) {
      this.mapToPlayers.set(normalizedNewMap, new Set());
    }
    this.mapToPlayers.get(normalizedNewMap)!.add(playerId);
    this.playerToMap.set(playerId, normalizedNewMap);
  }

  getPlayersOnMap(mapName: string): Set<string> {
    const normalizedMap = this.normalizeMapName(mapName);
    return this.mapToPlayers.get(normalizedMap) || new Set();
  }

  getPlayerMap(playerId: string): string | undefined {
    return this.playerToMap.get(playerId);
  }

  getMapCount(): number {
    return this.mapToPlayers.size;
  }

  getPlayerCount(): number {
    return this.playerToMap.size;
  }

  clear(): void {
    this.mapToPlayers.clear();
    this.playerToMap.clear();
  }

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

const mapIndex = new MapIndex();
export default mapIndex;
