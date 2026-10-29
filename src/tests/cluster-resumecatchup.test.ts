import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";

// A walk resumed after a handoff makes up the ticks it stood still. From the drain on the old node to the first step
// on the new one the server does not step the player, while the client walks on: without the catch-up the server is
// that many steps behind the client for the rest of the walk, and the client slows down to meet it at every border.

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { MAX_RESUME_CATCH_UP_MS, arrivalLimits, handoffStateOf, resumeCatchUpMs, resumeCatchUpSteps, walkIdleMsOf } = await import("../socket/arrival");

const TICK = 1000 / 60;

test("the old node says how long the walk has not stepped; nothing for a player who stands or never stepped", () => {
  const walking = { moving: true, location: { position: { direction: "right" } }, _lastStepAt: 1_000 };
  expect(walkIdleMsOf(walking, 1_042.4)).toBe(42);
  expect(walkIdleMsOf(walking, 900)).toBe(0);
  expect(walkIdleMsOf({ ...walking, moving: false }, 1_042)).toBe(0);
  expect(walkIdleMsOf({ ...walking, _lastStepAt: undefined }, 1_042)).toBe(0);
  const server = readFileSync(join(import.meta.dir, "..", "socket", "server.ts"), "utf8");
  expect(server).toContain("walkIdleMs: walkIdleMsOf(p, now),");
  const movement = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "movement.ts"), "utf8");
  expect(movement).toContain("currentPlayer._lastStepAt = performance.now();");
});

test("the arrival reads the standstill as ms, at most MAX_RESUME_CATCH_UP_MS; anything else is none", () => {
  const state = (walkIdleMs: unknown) => handoffStateOf({ walk: "right", walkIdleMs }, arrivalLimits([])).walkIdleMs;
  expect(state(40)).toBe(40);
  expect(state(60_000)).toBe(MAX_RESUME_CATCH_UP_MS);
  expect(state(-5)).toBe(0);
  expect(state("x")).toBe(0);
  expect(state(Number.NaN)).toBe(0);
  expect(state(undefined)).toBe(0);
});

test("the steps made up are the ticks of the standstill less the first step, for the arrival's own walk only", () => {
  const catchUp = { walk: "right", idleMs: 30, committedAt: 10_000 };
  // 30 ms on the old node and 50 ms here: 80 ms, about 5 ticks at 60 Hz, of which the first step is one.
  expect(resumeCatchUpSteps(catchUp, "right", 10_050, TICK)).toBe(4);
  // Within a tick: the first step is all.
  expect(resumeCatchUpSteps({ ...catchUp, idleMs: 5 }, "right", 10_005, TICK)).toBe(0);
  // Another direction is a new walk, not the resumed one.
  expect(resumeCatchUpSteps(catchUp, "left", 10_050, TICK)).toBe(0);
  expect(resumeCatchUpSteps(null, "right", 10_050, TICK)).toBe(0);
  expect(resumeCatchUpSteps(undefined, "right", 10_050, TICK)).toBe(0);
  // A clock that went back counts nothing here.
  expect(resumeCatchUpSteps(catchUp, "right", 9_000, TICK)).toBe(1);
  // A long standstill is cut to MAX_RESUME_CATCH_UP_MS.
  expect(resumeCatchUpSteps(catchUp, "right", 60_000, TICK)).toBe(Math.round(MAX_RESUME_CATCH_UP_MS / TICK) - 1);
  expect(resumeCatchUpSteps(catchUp, "right", 10_050, 0)).toBe(0);
});

test("HANDOFF_DONE names the walk the catch-up makes up on top of the first step", () => {
  const catchUp = { walk: "right", idleMs: 30, committedAt: 10_000 };
  // 4 steps on top of the first (above): 4 ticks of walk.
  expect(resumeCatchUpMs(catchUp, 10_050, TICK)).toBe(Math.round(4 * TICK));
  expect(resumeCatchUpMs({ ...catchUp, idleMs: 5 }, 10_005, TICK)).toBe(0);
  expect(resumeCatchUpMs(null, 10_050, TICK)).toBe(0);
  expect(resumeCatchUpMs(catchUp, 60_000, TICK)).toBe(Math.round((Math.round(MAX_RESUME_CATCH_UP_MS / TICK) - 1) * TICK));
});

test("wiring: the receiver hands the resumed walk its standstill; the MOVEXY takes it once and steps it with the first step, echoing only the last", () => {
  const receiver = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8");
  const built = receiver.indexOf("{ walk: arrivalState.walk, idleMs: arrivalState.walkIdleMs, committedAt: arrival?.committedAt ?? Date.now() }");
  expect(built).toBeGreaterThan(-1);
  // The same standstill is told to the client in HANDOFF_DONE, and handed to the MOVEXY that makes it up.
  const done = receiver.indexOf("catchUpMs: doneWalk ? resumeCatchUpMs(resumeCatchUp, Date.now(), TICK_MS) : 0,");
  expect(done).toBeGreaterThan(built);
  const set = receiver.indexOf("wt.data.resumeCatchUp = resumeCatchUp;");
  expect(set).toBeGreaterThan(done);
  expect(set).toBeLessThan(receiver.indexOf("resumedWalk = resumeArrivalWalk(wt, arrivalState.walk);"));
  const movement = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "movement.ts"), "utf8");
  const take = movement.indexOf("if (resumeCatchUp) wt.data.resumeCatchUp = undefined;");
  expect(take).toBeGreaterThan(-1);
  expect(take).toBeLessThan(movement.indexOf('if (direction === "abort") {'));
  const first = movement.indexOf("if (!wasAlreadyMoving) {");
  expect(first).toBeGreaterThan(-1);
  const steps = movement.indexOf("resumeCatchUpSteps(resumeCatchUp, direction, Date.now(), TICK_MS)", first);
  expect(steps).toBeGreaterThan(first);
  // Every step of the catch-up but the last goes without the self-echo: the client gets one point, not a burst sent at once.
  const block = movement.slice(steps, movement.indexOf("\n        }\n", steps));
  expect(block).toContain("muteEcho = catchUp > 0;");
  expect(block).toContain("muteEcho = i < catchUp - 1;");
  expect(block).toContain("} finally {\n            muteEcho = false;");
  expect(movement).toContain("if (!muteEcho) sendPacket(wt, packetManager.moveXY(movementData));");
});
