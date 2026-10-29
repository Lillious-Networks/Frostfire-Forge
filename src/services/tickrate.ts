import * as settings from "../config/settings.json";

// The movement loop's tick rate. 30 Hz was chosen when movement went over WebSockets; over WebTransport datagrams the
// transport no longer limits it, so the default is 60. Set by settings.json "tickRate" or the TICK_RATE environment
// variable (which wins), read once at start. Movement and everything that used to count ticks is kept in time, so the
// game plays the same at any rate: only how finely it is stepped changes.

/** The rate the per-tick constants (the 6 px step, "every 10th tick") were tuned at. */
export const BASE_TICK_RATE = 30;
export const BASE_TICK_MS = 1000 / BASE_TICK_RATE;
export const DEFAULT_TICK_RATE = 60;
export const MIN_TICK_RATE = 20;
export const MAX_TICK_RATE = 120;

/** The first of `sources` that is a number from MIN_TICK_RATE to MAX_TICK_RATE; DEFAULT_TICK_RATE if none is. */
export function resolveTickRate(...sources: unknown[]): number {
  for (const source of sources) {
    if (source === undefined || source === null || source === "") continue;
    const rate = Number(source);
    if (Number.isFinite(rate) && rate >= MIN_TICK_RATE && rate <= MAX_TICK_RATE) return rate;
  }
  return DEFAULT_TICK_RATE;
}

export const TICK_RATE = resolveTickRate(process.env.TICK_RATE, (settings as any)?.tickRate);
export const TICK_MS = 1000 / TICK_RATE;

/** How many ticks at `tickRate` make up `ms`, never fewer than one. */
export function ticksFor(ms: number, tickRate: number = TICK_RATE): number {
  return Math.max(1, Math.round((ms * tickRate) / 1000));
}

/**
 * Whether a cadence of `intervalMs`, checked once a tick, is due `elapsedMs` after it last fired. It fires on the tick
 * nearest the interval (half a tick early at most), so an interval of N 30 Hz ticks still fires on every Nth tick at
 * 30 Hz instead of slipping a tick on timer jitter, and on every 2Nth at 60 Hz.
 */
export function cadenceDue(elapsedMs: number, intervalMs: number, tickMs: number = TICK_MS): boolean {
  return elapsedMs >= intervalMs - tickMs / 2;
}

/**
 * One tick's move along one axis, in whole px. `step30` is the offset a 30 Hz tick takes (6 px, x1.35 mounted or a
 * ghost, x the slow multiplier), and a 30 Hz tick moves it rounded to whole px. At another rate that rounded step is
 * scaled by 30 / tickRate and the part of a px left over is carried to the next tick (`carry`), so a mover covers the
 * same px a second at any rate. At 30 Hz nothing is ever carried: exactly the old step.
 */
export function scaledStep(step30: number, carry: number, tickRate: number = TICK_RATE): { move: number; carry: number } {
  const exact = Math.round(step30) * (BASE_TICK_RATE / tickRate) + carry;
  const move = Math.round(exact);
  return { move, carry: exact - move };
}
