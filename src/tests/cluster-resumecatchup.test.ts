import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";

// A walk resumed after a handoff makes up the ticks it stood still. From the drain on the old node to the first step
// on the new one the server does not step the player, while the client walks on: without the catch-up the server is
// that many steps behind the client for the rest of the walk, and the client slows down to meet it at every border.

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { MAX_GAP_SEGMENTS, MAX_RESUME_CATCH_UP_MS, arrivalLimits, gapInputOf, gapPlanOf, handoffStateOf, resumeCatchUpMs, resumeCatchUpSteps, walkIdleMsOf } = await import("../socket/arrival");

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
  // (less what a gap report's replay walked of it: `catchUp`, below)
  const done = receiver.indexOf("catchUpMs: doneWalk ? resumeCatchUpMs(catchUp, Date.now(), TICK_MS) : 0,");
  expect(done).toBeGreaterThan(built);
  const set = receiver.indexOf("wt.data.resumeCatchUp = catchUp;");
  expect(set).toBeGreaterThan(done);
  expect(set).toBeLessThan(receiver.indexOf("resumedWalk = resumeArrivalWalk(wt, walk);"));
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

// The client walked the gap as its keys said and reports it with AUTH: a key let go or turned in the gap is walked here
// as the client walked it before HANDOFF_DONE, so the node's point is the drawn one (to a tick's step), not up to 36 px past it.

test("a gap report is read as stretches of a MOVEXY direction or a stand, each 0 to MAX_RESUME_CATCH_UP_MS long", () => {
  expect(gapInputOf({ segments: [{ walk: "RIGHT", ms: 40 }, { walk: "", ms: 20.5 }], held: "Down" })).toEqual({ segments: [{ walk: "right", ms: 40 }, { walk: "", ms: 20.5 }], held: "down" });
  expect(gapInputOf({ segments: [], held: "" })).toEqual({ segments: [], held: "" });
  expect(gapInputOf({ segments: [{ walk: null, ms: 10 }], held: null })).toEqual({ segments: [{ walk: "", ms: 10 }], held: "" });
  expect(gapInputOf({ segments: [{ walk: "right", ms: 60_000 }], held: "" })!.segments[0].ms).toBe(MAX_RESUME_CATCH_UP_MS);
  const many = Array.from({ length: MAX_GAP_SEGMENTS + 4 }, (_, i) => ({ walk: i % 2 ? "up" : "", ms: 1 }));
  expect(gapInputOf({ segments: many, held: "" })!.segments.length).toBe(MAX_GAP_SEGMENTS);
  // Anything else is no report: the walk goes on the way it came.
  expect(gapInputOf(null)).toBeNull();
  expect(gapInputOf("right")).toBeNull();
  expect(gapInputOf({ segments: [], held: "north" })).toBeNull();
  expect(gapInputOf({ segments: "x", held: "" })).toBeNull();
  expect(gapInputOf({ segments: [{ walk: "warp", ms: 10 }], held: "" })).toBeNull();
  expect(gapInputOf({ segments: [{ walk: "up", ms: -1 }], held: "" })).toBeNull();
  expect(gapInputOf({ segments: [{ walk: "up", ms: Number.NaN }], held: "" })).toBeNull();
  expect(gapInputOf({ segments: [{ walk: "up" }], held: "" })).toBeNull();
});

test("the replay walks each ended stretch in the whole steps nearest its length, within the standstill made up", () => {
  const T = 1000 / 30;
  const catchUp = { walk: "right", idleMs: 30, committedAt: 10_000 };
  // 30 + 170 ms: 200 ms of standstill. Walked right 90 ms (2.7 ticks: 3 steps), stood 50, then stands.
  const letGo = gapPlanOf({ segments: [{ walk: "right", ms: 90 }, { walk: "", ms: 50 }], held: "" }, catchUp, 10_170, T)!;
  expect(letGo).toEqual({ steps: ["right", "right", "right"], spentMs: 140, walk: null });
  // Turned: right 50 (1.5 ticks: 2 steps), down 50 (2 steps); down goes on, making up only the rest.
  const turned = gapPlanOf({ segments: [{ walk: "right", ms: 50 }, { walk: "down", ms: 50 }], held: "down" }, catchUp, 10_170, T)!;
  expect(turned).toEqual({ steps: ["right", "right", "down", "down"], spentMs: 100, walk: "down" });
  // A stretch is counted on its own, not from where the stand before it ended in a tick: the client walks every stretch
  // to a whole tick (handoffwalk.ts GapLog.stepLeft), and a stand of 17 ms then 2 ticks right is 2 steps, not 1.
  expect(gapPlanOf({ segments: [{ walk: "", ms: 17 }, { walk: "right", ms: 66 }], held: "" }, catchUp, 10_170, T)!.steps).toEqual(["right", "right"]);
  expect(resumeCatchUpSteps({ ...catchUp, walk: "down", spentMs: turned.spentMs }, "down", 10_170, T)).toBe(Math.round(200 / T) - Math.round(100 / T) - 1);
  // A stretch the client's rounding left 0 ms long is passed over, not the end of the replay.
  expect(gapPlanOf({ segments: [{ walk: "up", ms: 0 }, { walk: "left", ms: 40 }], held: "" }, catchUp, 10_170, T)!.steps).toEqual(["left"]);
  // More than the standstill: cut at it.
  const long = gapPlanOf({ segments: [{ walk: "left", ms: 400 }, { walk: "up", ms: 100 }], held: "" }, catchUp, 10_170, T)!;
  expect(long.spentMs).toBe(200);
  expect(long.steps).toEqual(Array(Math.round(200 / T)).fill("left"));
  // Held through the gap: nothing ended, the walk goes on as before.
  expect(gapPlanOf({ segments: [], held: "right" }, catchUp, 10_170, T)).toEqual({ steps: [], spentMs: 0, walk: "right" });
  // No report, no walk to make up, no tick: none.
  expect(gapPlanOf(null, catchUp, 10_170, T)).toBeNull();
  expect(gapPlanOf({ segments: [], held: "" }, null, 10_170, T)).toBeNull();
  expect(gapPlanOf({ segments: [], held: "" }, catchUp, 10_170, 0)).toBeNull();
});

test("the walk that goes on after a replay makes up only the standstill the replay did not walk", () => {
  const catchUp = { walk: "right", idleMs: 30, committedAt: 10_000 };
  // 80 ms, 5 ticks at 60 Hz: 2 of them replayed, the first step is one, 2 made up.
  expect(resumeCatchUpSteps({ ...catchUp, spentMs: 2 * TICK }, "right", 10_050, TICK)).toBe(2);
  expect(resumeCatchUpSteps({ ...catchUp, spentMs: 80 }, "right", 10_050, TICK)).toBe(0);
  expect(resumeCatchUpMs({ ...catchUp, spentMs: 2 * TICK }, 10_050, TICK)).toBe(Math.round(2 * TICK));
});

test("wiring: AUTH keeps the report before anything is awaited; the login replays the newest before HANDOFF_DONE and resumes the walk held", () => {
  const session = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "session.ts"), "utf8");
  const auth = session.slice(session.indexOf('case "AUTH": {'), session.indexOf('case "LOGOUT": {'));
  const kept = auth.indexOf("wt.data.gapUpdate = newerGap(wt.data.gapUpdate, authGap ? { seq: 0, input: authGap } : null) ?? undefined;");
  expect(kept).toBeGreaterThan(-1);
  expect(kept).toBeLessThan(auth.search(/\bawait\s/));
  const receiver = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8").replaceAll("\r", "");
  // The map's collision is loaded before the report is read: nothing from the read to the walk's first step waits.
  const preload = receiver.indexOf("await player.preloadMapCollision(_pcache.location.map);\n      const gap: GapUpdate | undefined = wt.data.gapUpdate;\n      wt.data.gapUpdate = undefined;");
  expect(preload).toBeGreaterThan(-1);
  const taken = receiver.indexOf("wt.data.gapUpdate = undefined;", preload);
  // From the read on, a later report is walked from the same point (applyLateGap).
  const applied = receiver.indexOf("wt.data.gapApplied = applied;", taken);
  const plan = receiver.indexOf("gapPlanOf(gap?.input, resumeCatchUp, Date.now(), TICK_MS)", taken);
  const replay = receiver.indexOf("replayGapSteps(_pcache, gapPlan.steps)", plan);
  const done = receiver.indexOf("packetManager.handoffDone(", replay);
  expect(applied).toBeGreaterThan(taken);
  expect(applied).toBeLessThan(replay);
  expect(receiver.slice(taken, applied)).not.toMatch(/\bawait\s/);
  expect(plan).toBeGreaterThan(taken);
  expect(replay).toBeGreaterThan(plan);
  expect(done).toBeGreaterThan(replay);
  expect(receiver.slice(replay, done)).toContain("catchUp = walk && resumeCatchUp ? { ...resumeCatchUp, walk, spentMs: gapPlan.spentMs } : null;");
  // DONE names the report walked; the reports that came meanwhile are walked once the walk is numbered.
  expect(receiver.slice(done, done + 900)).toContain("gapSeq: applied.seq,");
  const walked = receiver.indexOf("resumedWalk = resumeArrivalWalk(wt, walk);", done);
  const ready = receiver.indexOf("applied.ready = true;", done);
  expect(ready).toBeGreaterThan(walked);
  expect(receiver.slice(ready, ready + 200)).toContain("void applyLateGap(wt, pending);");
  // The replay steps as the MOVEXY steps (one step function), without its echo.
  const movement = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "movement.ts"), "utf8").replaceAll("\r", "");
  const start = movement.indexOf("export async function replayGapSteps(");
  const fn = movement.slice(start, movement.indexOf("\n}\n", start));
  expect(fn).toContain("takeStep(currentPlayer, direction, offset.dx, offset.dy);");
  expect(fn).not.toContain("sendPacket");
  expect(movement).toContain("const { collision, isColliding } = takeStep(currentPlayer, direction, stepX, stepY);");
  // The client is told the gap is reported, and that each change of key after AUTH is taken.
  const packets = readFileSync(join(import.meta.dir, "..", "socket", "packet_manager.ts"), "utf8");
  expect(packets).toContain('JSON.stringify({ type: "HANDOFF_BEGIN", data: { report: true, gapUpdates: true, ...(at ?? {}) } })');
});

// A change of key after AUTH (a release or a turn as the login runs, or as HANDOFF_DONE is on its way) is sent as a
// HANDOFF_GAP with the whole gap so far. The login walks the newest it has; a later one is walked again from the same
// point once it comes, as if the login had read it, and answered (HANDOFF_GAP_DONE). The client walks the gap on until
// the answer: the node ends where the client's draw is, not up to a round trip of walk past it.

const { MAX_GAP_UPDATES, gapUpdateOf, newerGap } = await import("../socket/arrival");

test("a HANDOFF_GAP is a report numbered 1 to MAX_GAP_UPDATES; anything else is none", () => {
  const input = { segments: [{ walk: "right", ms: 72 }], held: "" };
  expect(gapUpdateOf({ seq: 1, ...input })).toEqual({ seq: 1, input });
  expect(gapUpdateOf({ seq: MAX_GAP_UPDATES, ...input })!.seq).toBe(MAX_GAP_UPDATES);
  // 0 is AUTH's.
  expect(gapUpdateOf({ seq: 0, ...input })).toBeNull();
  expect(gapUpdateOf({ seq: MAX_GAP_UPDATES + 1, ...input })).toBeNull();
  expect(gapUpdateOf({ seq: 1.5, ...input })).toBeNull();
  expect(gapUpdateOf({ seq: "2", ...input })!.seq).toBe(2);
  expect(gapUpdateOf({ ...input })).toBeNull();
  expect(gapUpdateOf({ seq: 1, segments: [], held: "north" })).toBeNull();
  expect(gapUpdateOf(null)).toBeNull();
});

test("the newer of two reports is kept, in whatever order they are handled", () => {
  const a = { seq: 0, input: { segments: [], held: "right" } };
  const b = { seq: 2, input: { segments: [{ walk: "right", ms: 60 }], held: "" } };
  expect(newerGap(a, b)).toBe(b);
  expect(newerGap(b, a)).toBe(b);
  expect(newerGap(undefined, a)).toBe(a);
  expect(newerGap(a, null)).toBe(a);
  expect(newerGap(undefined, undefined)).toBeNull();
});

test("a report walked after HANDOFF_DONE puts the player where the same report read in time would", () => {
  const catchUp = { walk: "right", idleMs: 30, committedAt: 10_000 };
  // Let go after 120 ms of the gap: in time (at 10_150) and late (at 10_260, after DONE) the replay is the same.
  const letGo = { segments: [{ walk: "right", ms: 120 }], held: "" };
  const inTime = gapPlanOf(letGo, catchUp, 10_150, TICK)!;
  const late = gapPlanOf(letGo, catchUp, 10_260, TICK)!;
  expect(late).toEqual(inTime);
  expect(late.steps).toEqual(Array(Math.round(120 / TICK)).fill("right"));
  expect(late.walk).toBeNull();
  // Turned down after 100 ms: the replay is the same and the walk down makes up the rest of the standstill up to now.
  const turned = { segments: [{ walk: "right", ms: 100 }], held: "down" };
  const lateTurn = gapPlanOf(turned, catchUp, 10_260, TICK)!;
  expect(lateTurn.steps).toEqual(gapPlanOf(turned, catchUp, 10_150, TICK)!.steps);
  expect(resumeCatchUpSteps({ ...catchUp, walk: "down", spentMs: lateTurn.spentMs }, "down", 10_260, TICK)).toBe(Math.round(290 / TICK) - Math.round(100 / TICK) - 1);
});

test("wiring: a HANDOFF_GAP is taken at once, kept until the login reads it, and walked again from the arrival's point after it", () => {
  const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", "socket", ...p), "utf8").replaceAll("\r", "");
  // A packet type the node takes (an unknown one closes the connection), handled in the order of the moves around it.
  expect(read("types.ts")).toContain('HANDOFF_GAP: "HANDOFF_GAP",');
  expect(read("server.ts")).toContain('const PROCESS_IMMEDIATELY = new Set(["MOVEXY", "STATS", "SERVER_TIME", "ANIMATION", "HANDOFF_GAP"]);');
  const movement = read("handlers", "movement.ts");
  expect(movement).toMatch(/handles[^\n]*"HANDOFF_GAP"/);
  const gapCase = movement.slice(movement.indexOf('case "HANDOFF_GAP": {'), movement.indexOf('case "MOVEXY": {'));
  expect(gapCase).toContain("if (wt.data?.gapApplied) return applyLateGap(wt, update);");
  expect(gapCase).toContain("wt.data.gapUpdate = newerGap(wt.data.gapUpdate, update) ?? undefined;");
  const receiver = read("receiver.ts");
  const start = receiver.indexOf("export async function applyLateGap(");
  expect(start).toBeGreaterThan(-1);
  const fn = receiver.slice(start, receiver.indexOf("\n}\n", start));
  // One at a time; an older report than one walked is passed over.
  expect(fn).toContain("if (!applied || update.seq <= applied.seq) return;");
  expect(fn).toContain("applied.pending = newerGap(applied.pending, update);");
  expect(fn).toContain("now - applied.at <= MAX_GAP_LATE_MS");
  // The walk under way gives way before the replay, which starts from the arrival's point.
  const bump = fn.indexOf("p._moveSeq = (p._moveSeq ?? 0) + 1;");
  const replay = fn.indexOf("replayGapSteps(p, plan.steps, applied.from)");
  const answer = fn.indexOf("packetManager.handoffGapDone(");
  const walk = fn.indexOf("resumed = resumeArrivalWalk(wt, walk);");
  expect(bump).toBeGreaterThan(-1);
  expect(replay).toBeGreaterThan(bump);
  expect(answer).toBeGreaterThan(replay);
  expect(walk).toBeGreaterThan(answer);
  expect(fn.slice(answer, walk)).toContain("wt.data.resumeCatchUp = catchUp;");
  // A stop stands them where the replay left them.
  expect(fn).toContain("await forceStopPlayerMovement(p);\n      queueFinalMovement(p);");
  expect(fn).toContain("if (next) void applyLateGap(wt, next);");
});
