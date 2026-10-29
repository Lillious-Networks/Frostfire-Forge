import log from "../modules/logger";
import { BASE_TICK_MS, TICK_RATE, cadenceDue } from "./tickrate";

interface MovingPlayer {
  playerId: string;
  moveCallback: () => Promise<void>;
  /** When the mover was (re)registered: its first step waits at least half a tick from then. */
  registeredAt: number;
  /** When this mover's AOI update last came due (aoiDue), on the loop's clock. */
  lastAoiAt: number;
  /** Whether this tick's step is the one that updates the mover's AOI. */
  aoiDue: boolean;
  running: boolean;
}

/** How often a mover's AOI is updated while it walks: every 10th tick at 30 Hz, kept in time at any TICK_RATE. */
export const AOI_UPDATE_MS = 10 * BASE_TICK_MS;

const GL_PROFILE = process.env.BENCHMARK_PROFILE === "1" || process.env.BENCHMARK_PROFILE === "true";

/** A loop that fell behind fires at most this many ticks back to back to catch up; further behind, it starts again. */
export const MAX_CATCH_UP_TICKS = 3;

/** The loop's schedule: tick `index` is due at `start + index * frame`. */
export interface LoopClock {
  start: number;
  index: number;
}

/**
 * The delay to the loop's next tick, at `now`. Each tick is due at an absolute time, so a timer that fires a ms late
 * (Bun's does, every period) does not push the ticks after it back: the loop averages its rate. Behind by up to
 * MAX_CATCH_UP_TICKS ticks, the next fires at once; further, the schedule starts again a tick from now, so a stall
 * is not followed by a burst.
 */
export function nextTickDelay(clock: LoopClock, now: number, frameMs: number): number {
  clock.index++;
  let target = clock.start + clock.index * frameMs;
  if (now - target > MAX_CATCH_UP_TICKS * frameMs) {
    clock.start = now;
    clock.index = 1;
    target = now + frameMs;
  }
  return Math.max(0, target - now);
}

export interface GameLoopOptions {
  /** Ticks a second; TICK_RATE (settings.json "tickRate", env TICK_RATE) when left out. */
  tickRate?: number;
  /** The loop's clock, in ms; performance.now() when left out (tests pass a fake one). */
  now?: () => number;
  /** Staggers the movers' AOI updates; Math.random when left out. */
  random?: () => number;
}

export class GameLoop {
  private movingPlayers: Map<string, MovingPlayer>;
  /** Run at the start of every tick, before the movers step (systems/tornadoes.ts: its pull). */
  private tickHooks: Array<() => void | Promise<void>> = [];
  /** Run at the end of every tick, after the movers have stepped (receiver.ts: the movement flush). */
  private afterTickHooks: Array<() => void | Promise<void>> = [];
  private loopTimer: ReturnType<typeof setTimeout> | null;
  private readonly FRAME_TIME: number;
  private readonly now: () => number;
  private readonly random: () => number;

  // Profiling: ticks that overlapped (fired while the previous one was still
  // awaiting), total wall time spent inside tick(), and the max single tick.
  private prof = { ticks: 0, overlaps: 0, tickMs: 0, maxTickMs: 0, running: false };

  constructor(options: GameLoopOptions = {}) {
    this.movingPlayers = new Map();
    this.loopTimer = null;
    this.FRAME_TIME = 1000 / (options.tickRate ?? TICK_RATE);
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? Math.random;

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
    if (this.loopTimer) return;

    // A setTimeout chain against absolute tick times (nextTickDelay), not setInterval, which runs about a ms long
    // every period: 2% slow at 60 Hz, 7% at 120. Ticks are not awaited, as with setInterval: a mover whose step is
    // still running sits the next tick out.
    const clock: LoopClock = { start: performance.now(), index: 0 };
    const schedule = () => {
      this.loopTimer = setTimeout(() => {
        if (!this.loopTimer) return;
        void this.tick();
        schedule();
      }, nextTickDelay(clock, performance.now(), this.FRAME_TIME));
    };
    schedule();
  }

  stop(): void {
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }

  /** Runs `hook` at the start of every tick, whether or not anyone is moving, before the movers step. */
  addTickHook(hook: () => void | Promise<void>): void {
    this.tickHooks.push(hook);
  }

  /** Runs `hook` at the end of every tick, whether or not anyone is moving, after the movers have stepped. */
  addAfterTickHook(hook: () => void | Promise<void>): void {
    this.afterTickHooks.push(hook);
  }

  /** One tick: the tick hooks, every mover's step, then the after-tick hooks. Called by the loop's timer (and tests). */
  async tick(): Promise<void> {
    await this.runHooks(this.tickHooks);

    if (this.movingPlayers.size > 0) {
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

    await this.runHooks(this.afterTickHooks);
  }

  private async runHooks(hooks: Array<() => void | Promise<void>>): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        log.error(`A game loop hook failed: ${error}`);
      }
    }
  }

  private async processPlayer(playerId: string, playerState: MovingPlayer): Promise<void> {
    try {
      playerState.running = true;

      const currentTime = this.now();

      // The loop keeps time, so a mover steps on every tick. Only its first step waits: a mover registered just
      // before a tick (less than half a tick) starts on the next one, as a tick that fires a little early still steps.
      if (currentTime - playerState.registeredAt < this.FRAME_TIME / 2) {
        playerState.running = false;
        return;
      }

      playerState.aoiDue = cadenceDue(currentTime - playerState.lastAoiAt, AOI_UPDATE_MS, this.FRAME_TIME);
      if (playerState.aoiDue) playerState.lastAoiAt = currentTime;

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
      existing.registeredAt = this.now();
      existing.running = false;
      return;
    }

    const now = this.now();
    this.movingPlayers.set(playerId, {
      playerId,
      moveCallback,
      registeredAt: now,
      // A random phase, so the movers' AOI updates are spread over the interval instead of landing on one tick.
      lastAoiAt: now - this.random() * AOI_UPDATE_MS,
      aoiDue: false,
      running: false,
    });
  }

  unregisterMovingPlayer(playerId: string): void {
    this.movingPlayers.delete(playerId);
  }

  /** Whether the mover's current step is the one that updates its AOI; true for a player the loop is not moving. */
  isAOIUpdateDue(playerId: string): boolean {
    return this.movingPlayers.get(playerId)?.aoiDue ?? true;
  }

  getStats(): { movingPlayers: number; isRunning: boolean } {
    return {
      movingPlayers: this.movingPlayers.size,
      isRunning: this.loopTimer !== null,
    };
  }

  isPlayerMoving(playerId: string): boolean {
    return this.movingPlayers.has(playerId);
  }
}

const gameLoop = new GameLoop();
export default gameLoop;
