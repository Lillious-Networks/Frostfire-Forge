/**
 * Centralized Game Loop Service
 *
 * Replaces per-player setInterval timers with a single game loop that processes
 * all moving players in one central tick. This dramatically reduces timer overhead
 * from 3,000 callbacks/second (100 players × 30 FPS) to just 30 callbacks/second.
 *
 * Performance improvement: ~99% reduction in timer callbacks
 *
 * Usage:
 *   gameLoop.registerMovingPlayer(playerId, moveCallback)
 *   gameLoop.unregisterMovingPlayer(playerId)
 */

import log from "../modules/logger";

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
  private readonly FPS = 30;
  private readonly FRAME_TIME = 1000 / 30; // 33ms

  constructor() {
    this.movingPlayers = new Map();
    this.loopInterval = null;
  }

  /**
   * Start the game loop (called once on server start)
   */
  start(): void {
    if (this.loopInterval) {
      log.warn("[GameLoop] Already running");
      return;
    }

    log.success("[GameLoop] Starting centralized game loop at 30 FPS");
    this.loopInterval = setInterval(() => this.tick(), this.FRAME_TIME);
  }

  /**
   * Stop the game loop (called on server shutdown)
   */
  stop(): void {
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
      log.info("[GameLoop] Stopped");
    }
  }

  /**
   * Main game loop tick - processes all moving players
   */
  private async tick(): Promise<void> {
    if (this.movingPlayers.size === 0) return;

    // Process all moving players in parallel for maximum performance
    const tickPromises: Promise<void>[] = [];

    for (const [playerId, playerState] of this.movingPlayers.entries()) {
      // Skip if already processing
      if (playerState.running) continue;

      tickPromises.push(this.processPlayer(playerId, playerState));
    }

    // Wait for all player movements to complete
    if (tickPromises.length > 0) {
      await Promise.all(tickPromises);
    }
  }

  /**
   * Process a single player's movement
   */
  private async processPlayer(playerId: string, playerState: MovingPlayer): Promise<void> {
    try {
      playerState.running = true;

      const currentTime = performance.now();
      const deltaTime = currentTime - playerState.lastTime;

      // Frame rate limiting - only process if enough time has passed
      if (deltaTime < this.FRAME_TIME) {
        playerState.running = false;
        return;
      }

      // Update last time with frame time correction
      playerState.lastTime = currentTime - (deltaTime % this.FRAME_TIME);

      // Increment AOI counter
      playerState.aoiUpdateCounter++;

      // Call the player's move callback
      await playerState.moveCallback();

      playerState.running = false;
    } catch (error) {
      log.error(`[GameLoop] Error processing player ${playerId}: ${error}`);
      // Remove player from loop on error to prevent infinite error spam
      this.unregisterMovingPlayer(playerId);
    }
  }

  /**
   * Register a player to be processed by the game loop
   */
  registerMovingPlayer(playerId: string, moveCallback: () => Promise<void>): void {
    // If player already registered, update their callback
    if (this.movingPlayers.has(playerId)) {
      const existing = this.movingPlayers.get(playerId)!;
      existing.moveCallback = moveCallback;
      existing.lastTime = performance.now();
      existing.aoiUpdateCounter = 0;
      existing.running = false;
      return;
    }

    // Register new moving player
    this.movingPlayers.set(playerId, {
      playerId,
      moveCallback,
      lastTime: performance.now(),
      aoiUpdateCounter: 0,
      running: false,
    });
  }

  /**
   * Unregister a player from the game loop (when they stop moving)
   */
  unregisterMovingPlayer(playerId: string): void {
    this.movingPlayers.delete(playerId);
  }

  /**
   * Get the AOI update counter for a player (used for rate limiting)
   */
  getAOIUpdateCounter(playerId: string): number {
    return this.movingPlayers.get(playerId)?.aoiUpdateCounter || 0;
  }

  /**
   * Get stats about the game loop
   */
  getStats(): { movingPlayers: number; isRunning: boolean } {
    return {
      movingPlayers: this.movingPlayers.size,
      isRunning: this.loopInterval !== null,
    };
  }

  /**
   * Check if a player is registered in the game loop
   */
  isPlayerMoving(playerId: string): boolean {
    return this.movingPlayers.has(playerId);
  }
}

// Export singleton instance
const gameLoop = new GameLoop();
export default gameLoop;
