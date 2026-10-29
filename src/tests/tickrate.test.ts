import { expect, test } from "bun:test";
import {
  BASE_TICK_MS,
  DEFAULT_TICK_RATE,
  cadenceDue,
  resolveTickRate,
  scaledStep,
  ticksFor,
} from "../services/tickrate";
import { AOI_UPDATE_MS, GameLoop, MAX_CATCH_UP_TICKS, nextTickDelay, type LoopClock } from "../services/gameloop";
import {
  HIGH_VOLUME_RATE,
  HIGH_VOLUME_RELEASE,
  MovementVolume,
  afterTickFlush,
  batchVolume,
  collectReceiverEntries,
  farUpdateEvery,
  flushDue,
  type EntryTally,
  type FlushPacer,
  type MoverSnapshot,
  type ReceiverInfo,
} from "../socket/movement_batch";

// A fake clock for the game loop: each tick lands a hundredth of a ms late by default, or `gaps` apart (ms between
// ticks, in turn) for a timer that fires early and late.
function fakeLoop(tickRate: number, gaps?: number[]) {
  let clock = 1_000, tick = 0;
  const loop = new GameLoop({ tickRate, now: () => clock, random: () => 0 });
  return {
    loop,
    now: () => clock,
    async ticks(count: number) {
      for (let i = 0; i < count; i++) {
        clock += gaps ? gaps[tick++ % gaps.length] : 1000 / tickRate + 0.01;
        await loop.tick();
      }
    },
  };
}

test("TICK_RATE is 60 unless the environment or the settings say otherwise, within 20-120", () => {
  expect(DEFAULT_TICK_RATE).toBe(60);
  expect(resolveTickRate(undefined, undefined)).toBe(60);
  expect(resolveTickRate(undefined, 30)).toBe(30);
  expect(resolveTickRate("45", 30)).toBe(45);
  expect(resolveTickRate("", 30)).toBe(30);
  // out of range or not a number: that source is ignored
  expect(resolveTickRate("10", 30)).toBe(30);
  expect(resolveTickRate("121", undefined)).toBe(60);
  expect(resolveTickRate("fast", 200)).toBe(60);
  expect(resolveTickRate("20", undefined)).toBe(20);
  expect(resolveTickRate("120", undefined)).toBe(120);
});

test("ticksFor turns a time into ticks at a rate, never fewer than one", () => {
  expect(ticksFor(10 * BASE_TICK_MS, 30)).toBe(10);
  expect(ticksFor(10 * BASE_TICK_MS, 60)).toBe(20);
  expect(ticksFor(1, 60)).toBe(1);
});

/** Px covered along one axis in one second of steps of `step30` (the step tuned at 30 Hz) at `tickRate`. */
function pxPerSecond(step30: number, tickRate: number): { px: number; steps: number[] } {
  let carry = 0, px = 0;
  const steps: number[] = [];
  for (let i = 0; i < tickRate; i++) {
    const s = scaledStep(step30, carry, tickRate);
    carry = s.carry;
    px += s.move;
    steps.push(s.move);
  }
  return { px, steps };
}

test("a step covers the same distance a second at 30 and 60 Hz, walking, mounted and slowed, either way", () => {
  // 6 px (walk), 6 x 1.35 (mounted, ghost), slowed by 0.5 and 0.7, and both ways on the axis
  for (const step30 of [6, 6 * 1.35, 6 * 0.5, 6 * 0.7, 6 * 1.35 * 0.5, -6, -6 * 1.35, -6 * 0.5, -6 * 0.7, 0]) {
    const at30 = pxPerSecond(step30, 30);
    expect(pxPerSecond(step30, 60).px).toBe(at30.px);
    expect(pxPerSecond(step30, 120).px).toBe(at30.px);
    // 30 Hz moves exactly as before: the offset rounded to whole px on every tick, nothing carried
    expect(at30.steps.every((s) => s === Math.round(step30))).toBe(true);
  }
  // whole px every tick, and smaller ones at 60 Hz (half a 30 Hz step, give or take the px carried)
  const walk60 = pxPerSecond(6, 60).steps;
  expect(walk60.every((s) => s === 3)).toBe(true);
  const slow60 = pxPerSecond(3, 60).steps;
  expect(slow60.every((s) => Number.isInteger(s) && (s === 1 || s === 2))).toBe(true);
});

test("the game loop steps each mover once a tick, at its own tick rate", async () => {
  for (const rate of [30, 60]) {
    const { loop, ticks } = fakeLoop(rate);
    let steps = 0;
    loop.registerMovingPlayer("p", async () => { steps++; });
    await ticks(rate * 2);
    expect(steps).toBe(rate * 2);
  }
});

test("a tick that fires a little early still steps: 16 and 17 ms ticks at 60 Hz give 60 steps a second", async () => {
  const { loop, ticks } = fakeLoop(60, [16, 17, 17]);
  let steps = 0;
  loop.registerMovingPlayer("p", async () => { steps++; });
  await ticks(60);
  expect(steps).toBe(60);
});

test("a mover registered just before a tick starts on the next one", async () => {
  const { loop, ticks } = fakeLoop(60, [5, 1000 / 60]);
  let steps = 0;
  loop.registerMovingPlayer("p", async () => { steps++; });
  // 5 ms after registering: under half a tick, no step yet
  await ticks(1);
  expect(steps).toBe(0);
  await ticks(1);
  expect(steps).toBe(1);
});

/** Ticks the loop's schedule gives in `ms` with a timer that fires `lateMs(tick)` after each asked-for delay. */
function scheduledTicks(rate: number, ms: number, lateMs: (tick: number) => number): number {
  const frame = 1000 / rate;
  const clock: LoopClock = { start: 0, index: 0 };
  let now = 0, ticks = 0;
  while (true) {
    now += nextTickDelay(clock, now, frame) + lateMs(ticks);
    if (now > ms) return ticks;
    ticks++;
  }
}

test("the loop's schedule keeps its rate with a timer that runs late, and does not burst after a stall", () => {
  for (const rate of [30, 60, 120]) {
    // a ms late every period (Bun's setInterval ran 2% slow at 60 Hz, 7% at 120 this way)
    expect(Math.abs(scheduledTicks(rate, 3000, () => 1) - rate * 3)).toBeLessThanOrEqual(1);
    // late and early by up to a ms in turn
    expect(Math.abs(scheduledTicks(rate, 3000, (t) => (t % 2 ? 1 : -0.9)) - rate * 3)).toBeLessThanOrEqual(1);
  }
  const clock: LoopClock = { start: 0, index: 0 };
  expect(nextTickDelay(clock, 0, 10)).toBe(10);
  // two periods behind: the next ticks fire at once, to catch up
  expect(nextTickDelay(clock, 30, 10)).toBe(0);
  expect(nextTickDelay(clock, 30, 10)).toBe(0);
  expect(nextTickDelay(clock, 30, 10)).toBe(10);
  // a long stall: no burst, the schedule starts again a tick from now
  const stalled = 40 + (MAX_CATCH_UP_TICKS + 5) * 10;
  expect(nextTickDelay(clock, stalled, 10)).toBe(10);
  expect(nextTickDelay(clock, stalled + 10, 10)).toBe(10);
});

test("the running loop averages its TICK_RATE at 30, 60 and 120 Hz (real timers)", async () => {
  const seconds = 2;
  const runs = [30, 60, 120].map((rate) => {
    const loop = new GameLoop({ tickRate: rate });
    const run = { rate, loop, ticks: 0 };
    loop.addAfterTickHook(() => { run.ticks++; });
    return run;
  });
  for (const run of runs) run.loop.start();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  for (const run of runs) run.loop.stop();
  for (const run of runs) {
    // generous, for a busy machine: setInterval came out 2-7% short every time
    expect(run.ticks / seconds).toBeGreaterThan(run.rate * 0.96);
    expect(run.ticks / seconds).toBeLessThan(run.rate * 1.03);
  }
});

/** The fake-clock times at which a mover's AOI update came due, over `seconds` of walking. */
async function aoiDueTimes(rate: number, seconds: number): Promise<number[]> {
  const { loop, now, ticks } = fakeLoop(rate);
  const due: number[] = [];
  loop.registerMovingPlayer("p", async () => {
    if (loop.isAOIUpdateDue("p")) due.push(now());
  });
  await ticks(rate * seconds);
  return due;
}

test("a mover's AOI update comes due at the same wall-clock cadence at 30 and 60 Hz", async () => {
  const at30 = await aoiDueTimes(30, 5);
  const at60 = await aoiDueTimes(60, 5);
  expect(at60.length).toBe(at30.length);
  expect(at30.length).toBeGreaterThanOrEqual(14);
  for (const times of [at30, at60]) {
    for (let i = 1; i < times.length; i++) {
      expect(Math.abs(times[i] - times[i - 1] - AOI_UPDATE_MS)).toBeLessThan(1);
    }
  }
});

test("at 30 Hz the AOI update still comes due on every 10th tick, as the tick counter did", async () => {
  const { loop, ticks } = fakeLoop(30);
  let tick = 0;
  const dueTicks: number[] = [];
  loop.addTickHook(() => { tick++; });
  loop.registerMovingPlayer("p", async () => {
    if (loop.isAOIUpdateDue("p")) dueTicks.push(tick);
  });
  await ticks(60);
  expect(dueTicks.length).toBe(6);
  for (let i = 1; i < dueTicks.length; i++) expect(dueTicks[i] - dueTicks[i - 1]).toBe(10);
});

test("a player who is not moving has their AOI updated at once", () => {
  const { loop } = fakeLoop(60);
  expect(loop.isAOIUpdateDue("nobody")).toBe(true);
});

/** Ticks (1-based) at which a cadence of `intervalMs` fires over `count` ticks at `rate`, with a fake clock. */
function cadenceTicks(rate: number, intervalMs: number, count: number): number[] {
  const tickMs = 1000 / rate;
  let clock = 0, last = 0;
  const fired: number[] = [];
  for (let tick = 1; tick <= count; tick++) {
    clock += tickMs + 0.01;
    if (cadenceDue(clock - last, intervalMs, tickMs)) {
      last = clock;
      fired.push(tick);
    }
  }
  return fired;
}

test("the warp scan's cadence (8 ticks at 30 Hz) fires at the same wall-clock times at 30 and 60 Hz", () => {
  const WARP_SCAN_MS = 8 * BASE_TICK_MS;
  const at30 = cadenceTicks(30, WARP_SCAN_MS, 30 * 4);
  const at60 = cadenceTicks(60, WARP_SCAN_MS, 60 * 4);
  expect(at30.length).toBe(15);
  expect(at60.length).toBe(at30.length);
  // every 8th tick at 30 Hz, as the tick counter did; every 16th at 60 Hz: the same 267 ms
  expect(at30.every((tick, i) => tick === (i + 1) * 8)).toBe(true);
  expect(at60.every((tick, i) => tick === (i + 1) * 16)).toBe(true);
});

const receiver: ReceiverInfo = { x: 0, y: 0, isAdmin: false, username: "r" };
const farMover = (id: number): MoverSnapshot => ({ id: String(id), x: 5000, y: 0, direction: "down", stealth: false, vanished: false, party: [] });

/**
 * Over `seconds` at `rate` with a back-off of `backoffMs`: how many movement flushes go out, and how often each far
 * mover is sent, with the far interval each flush works out (as receiver.ts does).
 */
function flushRun(rate: number, backoffMs: number, seconds: number, ids: number[] = [1, 2, 7]) {
  const tickMs = 1000 / rate;
  const pacer: FlushPacer = { nextAt: null };
  let clock = 0, flushes = 0;
  const sent = new Map<number, number>();
  for (let tick = 0; tick < rate * seconds; tick++) {
    clock += tickMs + 0.01;
    if (!flushDue(pacer, clock, backoffMs, tickMs)) continue;
    const farEvery = farUpdateEvery(Math.max(tickMs, backoffMs));
    for (const id of ids) {
      sent.set(id, (sent.get(id) ?? 0) + collectReceiverEntries(new Set([String(id)]), [farMover(id)], receiver, flushes, 500, farEvery).length);
    }
    flushes++;
  }
  return { flushes, sent: ids.map((id) => sent.get(id) ?? 0) };
}

test("FAR_UPDATE_EVERY is a time (30 Hz ticks): far movers' interval in flushes at the spacing the flushes run at", () => {
  expect(farUpdateEvery(1000 / 30, 3)).toBe(3);
  expect(farUpdateEvery(1000 / 60, 3)).toBe(6);
  expect(farUpdateEvery(50, 3)).toBe(2);
  expect(farUpdateEvery(150, 3)).toBe(1);
  // 1 is full rate at any rate
  expect(farUpdateEvery(1000 / 60, 1)).toBe(1);
});

test("a far mover is sent as often a second at 30 and 60 Hz, with or without a back-off", () => {
  // no back-off: one flush a tick, a far mover every 100 ms
  for (const rate of [30, 60]) expect(flushRun(rate, 0, 2).sent).toEqual([20, 20, 20]);
  // a 50 ms back-off (high volume): 20 flushes a second, a far mover on every other one, 10 a second, at both
  for (const rate of [30, 60]) {
    for (const sent of flushRun(rate, 50, 3).sent) expect(Math.abs(sent - 30)).toBeLessThanOrEqual(1);
  }
});

/**
 * Runs the movement volume (as receiver.ts does) at 60 Hz for `seconds`, with `receivers` each watching one far mover:
 * the floor, when engaged, backs the flushes off to 50 ms, and the far interval follows. Each simulated receiver stands
 * for `weight` real ones. Per second: whether the floor is engaged after the sample, and the datagrams really sent,
 * per flush x 30 (what the volume counted before far movers were counted at the unthrottled interval).
 */
function volumeRun(volume: MovementVolume, state: { clock: number; flushes: number; pacer: FlushPacer }, receivers: number, seconds: number, weight = 100) {
  const rate = 60, tickMs = 1000 / rate;
  const samples: Array<{ high: boolean; sentRate: number }> = [];
  for (let second = 0; second < seconds; second++) {
    let sent = 0, flushes = 0;
    for (let tick = 0; tick < rate; tick++) {
      state.clock += tickMs + 0.01;
      const backoffMs = volume.high ? 50 : 0;
      if (!flushDue(state.pacer, state.clock, backoffMs, tickMs)) continue;
      const farEvery = farUpdateEvery(Math.max(tickMs, backoffMs));
      volume.flushed();
      flushes++;
      for (let id = 0; id < receivers; id++) {
        const tally: EntryTally = { full: 0, far: 0 };
        const entries = collectReceiverEntries(new Set([String(id)]), [farMover(id)], receiver, state.flushes, 500, farEvery, undefined, tally);
        volume.add(batchVolume(tally, farUpdateEvery(tickMs)) * weight);
        if (entries.length > 0) sent += weight;
      }
      state.flushes++;
    }
    samples.push({ high: volume.sample(), sentRate: (sent / flushes) * 30 });
  }
  return samples;
}

test("the volume floor lets go when the load falls to half the engage level, though it sends far movers more often", () => {
  const volume = new MovementVolume();
  const state = { clock: 0, flushes: 0, pacer: { nextAt: null } as FlushPacer };
  // 2000 receivers of one far mover each: 2000 x 1/6 of the flushes x 30 = 10000 a second.
  const busy = volumeRun(volume, state, 20, 6);
  expect(busy.at(-1)!.high).toBe(true);
  expect(volume.rate).toBeGreaterThan(HIGH_VOLUME_RATE);

  // Half that (5000). Under the floor a far mover goes on every 2nd flush, not every 6th: the datagrams really sent
  // read 15000, above the release level, which kept the floor engaged for good.
  const quiet = volumeRun(volume, state, 10, 6);
  expect(quiet[0]!.sentRate).toBeGreaterThan(HIGH_VOLUME_RELEASE);
  const released = quiet.findIndex((second) => !second.high);
  expect(released).toBeGreaterThanOrEqual(0);
  expect(released).toBeLessThanOrEqual(3);
  expect(quiet.at(-1)!.high).toBe(false);
  expect(Math.abs(volume.rate - 5000)).toBeLessThan(400);
});

test("a receiver's volume: full-rate entries every flush, far movers at the unthrottled interval", () => {
  // Any near (or full-rate) entry: a datagram every flush.
  expect(batchVolume({ full: 1, far: 0 }, 6)).toBe(1);
  expect(batchVolume({ full: 1, far: 30 }, 6)).toBe(1);
  // Far movers only: the share of flushes with at least one due.
  expect(batchVolume({ full: 0, far: 1 }, 6)).toBeCloseTo(1 / 6, 10);
  expect(batchVolume({ full: 0, far: 2 }, 6)).toBeCloseTo(1 - (5 / 6) ** 2, 10);
  expect(batchVolume({ full: 0, far: 0 }, 6)).toBe(0);
  // FAR_UPDATE_EVERY 1: far movers go every flush too.
  expect(batchVolume({ full: 0, far: 3 }, 1)).toBe(1);
  // More entries than one datagram holds: more than one.
  expect(batchVolume({ full: 200, far: 0 }, 6)).toBe(3);
  // The tally counts far movers whether due on this flush or not, at any far interval.
  for (const farEvery of [1, 2, 6]) {
    const tally: EntryTally = { full: 0, far: 0 };
    collectReceiverEntries(new Set(["1", "2"]), [farMover(1), { ...farMover(2), x: 10 }], receiver, 0, 500, farEvery, undefined, tally);
    expect(tally).toEqual({ full: 1, far: 1 });
  }
});

test("movement batches are flushed once after every tick, moving or not", async () => {
  for (const rate of [30, 60]) {
    const { loop, now, ticks } = fakeLoop(rate);
    const flushes: number[] = [];
    let stepsBeforeFlush = 0, steps = 0;
    loop.registerMovingPlayer("p", async () => { steps++; });
    loop.addAfterTickHook(() => {
      flushes.push(now());
      stepsBeforeFlush += steps;
      steps = 0;
    });
    await ticks(rate);
    expect(flushes.length).toBe(rate);
    // each flush comes after the tick's step, not before
    expect(stepsBeforeFlush).toBe(rate);

    loop.unregisterMovingPlayer("p");
    await ticks(rate);
    expect(flushes.length).toBe(rate * 2);
  }
});

test("a healthy flush goes out every tick; a back-off averages its interval at any tick rate", () => {
  for (const rate of [30, 60, 120]) {
    expect(flushRun(rate, 0, 1).flushes).toBe(rate);
    // a 50 ms back-off: 20 a second (at 30 Hz on alternate 1 and 2 ticks; every 2nd tick would be 15)
    expect(Math.abs(flushRun(rate, 50, 3).flushes - 60)).toBeLessThanOrEqual(1);
    // 85 ms: about 11.8 a second; 100 ms: 10; 150 ms: about 6.7
    expect(Math.abs(flushRun(rate, 85, 6).flushes - 6000 / 85)).toBeLessThanOrEqual(1);
    expect(Math.abs(flushRun(rate, 100, 3).flushes - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(flushRun(rate, 150, 3).flushes - 20)).toBeLessThanOrEqual(1);
  }
});

test("a back-off that fell behind starts again from now instead of flushing a burst", () => {
  const tickMs = 1000 / 60;
  const pacer: FlushPacer = { nextAt: null };
  expect(flushDue(pacer, 0, 50, tickMs)).toBe(true);
  // a 500 ms stall
  expect(flushDue(pacer, 500, 50, tickMs)).toBe(true);
  expect(flushDue(pacer, 500 + tickMs, 50, tickMs)).toBe(false);
  expect(flushDue(pacer, 550, 50, tickMs)).toBe(true);
});

test("the after-tick flush never runs twice at once, and is given the back-off in use", async () => {
  let clock = 0;
  let release: () => void = () => {};
  const runs: number[] = [];
  const hook = afterTickFlush(
    (backoffMs) => {
      runs.push(backoffMs);
      return new Promise<void>((resolve) => { release = resolve; });
    },
    () => 0,
    () => clock,
    1000 / 60
  );
  const first = hook();
  // the flush is still running: the ticks meanwhile skip theirs
  clock += 17; await hook();
  clock += 17; await hook();
  expect(runs).toEqual([0]);
  release();
  await first;
  clock += 17;
  const next = hook();
  release();
  await next;
  expect(runs).toEqual([0, 0]);
  // a flush that throws does not stop the next
  let tries = 0;
  const failing = afterTickFlush(async () => { tries++; throw new Error("x"); }, () => 0, () => clock, 1000 / 60);
  await failing();
  await failing();
  expect(tries).toBe(2);
});
