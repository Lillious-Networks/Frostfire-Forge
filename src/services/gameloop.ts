

interface MovingPlayer {
  playerId: string;
  moveCallback: () => Promise<void>;
  lastTime: number;
  aoiUpdateCounter: number;
  running: boolean;
}

class GameLoop {
  private movingPlayers: Map<string, MovingPlayer>;
  private loopInterval: ReturnType<typeof setInterval> | null;
  private readonly FRAME_TIME = 1000 / 30;

  constructor() {
    this.movingPlayers = new Map();
    this.loopInterval = null;
  }

  start(): void {
    if (this.loopInterval) return;

    this.loopInterval = setInterval(() => this.tick(), this.FRAME_TIME);
  }

  stop(): void {
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.movingPlayers.size === 0) return;

    const tickPromises: Promise<void>[] = [];

    for (const [playerId, playerState] of this.movingPlayers.entries()) {

      if (playerState.running) continue;

      tickPromises.push(this.processPlayer(playerId, playerState));
    }

    if (tickPromises.length > 0) {
      await Promise.all(tickPromises);
    }
  }

  private async processPlayer(playerId: string, playerState: MovingPlayer): Promise<void> {
    try {
      playerState.running = true;

      const currentTime = performance.now();
      const deltaTime = currentTime - playerState.lastTime;

      if (deltaTime < this.FRAME_TIME) {
        playerState.running = false;
        return;
      }

      playerState.lastTime = currentTime - (deltaTime % this.FRAME_TIME);

      playerState.aoiUpdateCounter++;

      await playerState.moveCallback();

      playerState.running = false;
    } catch (error) {

      this.unregisterMovingPlayer(playerId);
    }
  }

  registerMovingPlayer(playerId: string, moveCallback: () => Promise<void>): void {

    if (this.movingPlayers.has(playerId)) {
      const existing = this.movingPlayers.get(playerId)!;
      existing.moveCallback = moveCallback;
      existing.lastTime = performance.now();
      existing.aoiUpdateCounter = 0;
      existing.running = false;
      return;
    }

    this.movingPlayers.set(playerId, {
      playerId,
      moveCallback,
      lastTime: performance.now(),
      aoiUpdateCounter: 0,
      running: false,
    });
  }

  unregisterMovingPlayer(playerId: string): void {
    this.movingPlayers.delete(playerId);
  }

  getAOIUpdateCounter(playerId: string): number {
    return this.movingPlayers.get(playerId)?.aoiUpdateCounter || 0;
  }

  getStats(): { movingPlayers: number; isRunning: boolean } {
    return {
      movingPlayers: this.movingPlayers.size,
      isRunning: this.loopInterval !== null,
    };
  }

  isPlayerMoving(playerId: string): boolean {
    return this.movingPlayers.has(playerId);
  }
}

const gameLoop = new GameLoop();
export default gameLoop;
