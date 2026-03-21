import log from "../modules/logger";

export class SpatialGrid {

  private grid: Map<string, Set<string>>;

  private playerCells: Map<string, string>;

  private cellSize: number;

  private stats = {
    totalCells: 0,
    totalPlayers: 0,
    queriesPerformed: 0,
    avgPlayersPerQuery: 0,
  };

  constructor(cellSize: number = 512) {
    this.grid = new Map();
    this.playerCells = new Map();
    this.cellSize = cellSize;
  }

  private getCellKey(x: number, y: number, map: string): string {
    const cellX = Math.floor(x / this.cellSize);
    const cellY = Math.floor(y / this.cellSize);
    return `${map}:${cellX}:${cellY}`;
  }

  private getCellsInRadius(x: number, y: number, radius: number, map: string): string[] {
    const cells: string[] = [];

    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minY = Math.floor((y - radius) / this.cellSize);
    const maxY = Math.floor((y + radius) / this.cellSize);

    for (let cellX = minX; cellX <= maxX; cellX++) {
      for (let cellY = minY; cellY <= maxY; cellY++) {
        cells.push(`${map}:${cellX}:${cellY}`);
      }
    }

    return cells;
  }

  addPlayer(playerId: string, x: number, y: number, map: string): void {
    const cellKey = this.getCellKey(x, y, map);

    if (!this.grid.has(cellKey)) {
      this.grid.set(cellKey, new Set());
      this.stats.totalCells = this.grid.size;
    }

    this.grid.get(cellKey)!.add(playerId);

    this.playerCells.set(playerId, cellKey);
    this.stats.totalPlayers++;
  }

  removePlayer(playerId: string): void {
    const cellKey = this.playerCells.get(playerId);
    if (!cellKey) return;

    const cell = this.grid.get(cellKey);
    if (cell) {
      cell.delete(playerId);

      if (cell.size === 0) {
        this.grid.delete(cellKey);
        this.stats.totalCells = this.grid.size;
      }
    }

    this.playerCells.delete(playerId);
    this.stats.totalPlayers--;
  }

  updatePlayer(playerId: string, x: number, y: number, map: string): boolean {
    const newCellKey = this.getCellKey(x, y, map);
    const oldCellKey = this.playerCells.get(playerId);

    if (oldCellKey === newCellKey) {
      return false;
    }

    if (oldCellKey) {
      const oldCell = this.grid.get(oldCellKey);
      if (oldCell) {
        oldCell.delete(playerId);

        if (oldCell.size === 0) {
          this.grid.delete(oldCellKey);
        }
      }
    }

    if (!this.grid.has(newCellKey)) {
      this.grid.set(newCellKey, new Set());
    }
    this.grid.get(newCellKey)!.add(playerId);

    this.playerCells.set(playerId, newCellKey);
    this.stats.totalCells = this.grid.size;

    return true;
  }

  getPlayersInRadius(x: number, y: number, radius: number, map: string): string[] {
    const cells = this.getCellsInRadius(x, y, radius, map);
    const candidates: string[] = [];

    for (const cellKey of cells) {
      const cell = this.grid.get(cellKey);
      if (cell) {
        candidates.push(...Array.from(cell));
      }
    }

    this.stats.queriesPerformed++;
    this.stats.avgPlayersPerQuery =
      (this.stats.avgPlayersPerQuery * (this.stats.queriesPerformed - 1) + candidates.length) /
      this.stats.queriesPerformed;

    return candidates;
  }

  getPlayerCell(playerId: string): { cellX: number; cellY: number; map: string } | null {
    const cellKey = this.playerCells.get(playerId);
    if (!cellKey) return null;

    const [map, cellXStr, cellYStr] = cellKey.split(':');
    return {
      map,
      cellX: parseInt(cellXStr),
      cellY: parseInt(cellYStr),
    };
  }

  getPlayersInCell(x: number, y: number, map: string): string[] {
    const cellKey = this.getCellKey(x, y, map);
    const cell = this.grid.get(cellKey);
    return cell ? Array.from(cell) : [];
  }

  hasPlayer(playerId: string): boolean {
    return this.playerCells.has(playerId);
  }

  clear(): void {
    this.grid.clear();
    this.playerCells.clear();
    this.stats = {
      totalCells: 0,
      totalPlayers: 0,
      queriesPerformed: 0,
      avgPlayersPerQuery: 0,
    };
  }

  clearMap(map: string): void {
    const cellsToRemove: string[] = [];

    for (const cellKey of this.grid.keys()) {
      if (cellKey.startsWith(`${map}:`)) {
        cellsToRemove.push(cellKey);
      }
    }

    for (const cellKey of cellsToRemove) {
      const cell = this.grid.get(cellKey);
      if (cell) {

        for (const playerId of cell) {
          if (this.playerCells.get(playerId) === cellKey) {
            this.playerCells.delete(playerId);
            this.stats.totalPlayers--;
          }
        }
      }
      this.grid.delete(cellKey);
    }

    this.stats.totalCells = this.grid.size;
  }

  getStats() {
    return {
      ...this.stats,
      avgPlayersPerCell: this.stats.totalCells > 0
        ? this.stats.totalPlayers / this.stats.totalCells
        : 0,
    };
  }

  getGridDebugInfo(): Map<string, number> {
    const densityMap = new Map<string, number>();

    for (const [cellKey, players] of this.grid.entries()) {
      densityMap.set(cellKey, players.size);
    }

    return densityMap;
  }

  logStats(): void {
    const stats = this.getStats();
    log.info(`[SpatialGrid] Stats: ${stats.totalPlayers} players across ${stats.totalCells} cells`);
    log.info(`[SpatialGrid] Avg players per cell: ${stats.avgPlayersPerCell.toFixed(2)}`);
    log.info(`[SpatialGrid] Avg players per query: ${stats.avgPlayersPerQuery.toFixed(2)}`);
    log.info(`[SpatialGrid] Total queries: ${stats.queriesPerformed}`);
  }
}

const spatialGrid = new SpatialGrid(512);

export default spatialGrid;
