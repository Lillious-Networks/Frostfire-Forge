import log from "../modules/logger";

interface MovingPlayer {
  playerId: string;
  moveCallback: () => Promise<void>;
  lastTime: number;
  aoiUpdateCounter: number;
  running: boolean;
}

const GL_PROFILE = process.env.BENCHMARK_PROFILE === "1" || process.env.BENCHMARK_PROFILE === "true";

class GameLoop {
  private movingPlayers: Map<string, MovingPlayer>;
  private loopInterval: ReturnType<typeof setInterval> | null;
  private readonly FRAME_TIME = 1000 / 30;

  // Profiling: ticks that overlapped (fired while the previous one was still
  // awaiting), total wall time spent inside tick(), and the max single tick.
  private prof = { ticks: 0, overlaps: 0, tickMs: 0, maxTickMs: 0, running: false };

  constructor() {
    this.movingPlayers = new Map();
    this.loopInterval = null;

    if (GL_PROFILE) {
      setInterval(() => {
        const p = this.prof;
        log.info(
          `[profile:gameloop] ${p.ticks} ticks/5s, ${p.overlaps} overlaps, ` +
          `${p.tickMs.toFixed(0)}ms total, ${p.maxTickMs.toFixed(0)}ms max, ` +
          `${this.movingPlayers.size} movers, rss=${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`
        );
        p.ticks = p.overlaps = p.tickMs = p.maxTickMs = 0;
      }, 5000).unref();
    }
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

    if (GL_PROFILE) {
      if (this.prof.running) this.prof.overlaps++;
      this.prof.running = true;
      this.prof.ticks++;
    }
    const _t0 = GL_PROFILE ? performance.now() : 0;

    const tickPromises: Promise<void>[] = [];

    for (const [playerId, playerState] of this.movingPlayers.entries()) {

      if (playerState.running) continue;

      tickPromises.push(this.processPlayer(playerId, playerState));
    }

    if (tickPromises.length > 0) {
      await Promise.all(tickPromises);
    }

    if (GL_PROFILE) {
      const dt = performance.now() - _t0;
      this.prof.tickMs += dt;
      if (dt > this.prof.maxTickMs) this.prof.maxTickMs = dt;
      this.prof.running = false;
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
      existing.running = false;
      return;
    }

    this.movingPlayers.set(playerId, {
      playerId,
      moveCallback,
      lastTime: performance.now(),
      aoiUpdateCounter: Math.floor(Math.random() * 10),
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
