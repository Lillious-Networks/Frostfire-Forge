import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";

// HANDOFF_DONE names the walk: the direction the new node walks the player in as it sends DONE, or null. The client
// decides its resend from that (it no longer infers it from the facing, which is not the walk: mid-cast the facing stays
// the cast direction while the player walks another way).

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { doneWalkOf, handoffStateOf, arrivalLimits, walkOf } = await import("../socket/arrival");
const { packetManager } = await import("../socket/packet_manager");

const decode = (bytes: any) => JSON.parse(new TextDecoder().decode(bytes));
const base = { map: "main", x: 10, y: 20, direction: "right" };

/** The walk the old node's snapshot carries for a player, as the new node reads it back. */
const arrivedWalk = (player: any) => handoffStateOf({ walk: walkOf(player) }, arrivalLimits([])).walk;

test("HANDOFF_DONE carries the walk the node resumes: the direction while walking, null when stopped", () => {
  const walking = { moving: true, location: { position: { direction: "right" } }, _movementState: { targetDirection: "right" } };
  const walk = doneWalkOf(arrivedWalk(walking), walking);
  expect(walk).toBe("right");
  expect(decode(packetManager.handoffDone({ ...base, walk })[0])).toEqual({ type: "HANDOFF_DONE", data: { ...base, walk: "right" } });

  const stopped = { moving: false, location: { position: { direction: "right" } }, _movementState: { targetDirection: "right" } };
  const none = doneWalkOf(arrivedWalk(stopped), stopped);
  expect(none).toBeNull();
  const data = decode(packetManager.handoffDone({ ...base, walk: none })[0]).data;
  expect(data.walk).toBeNull();
  expect("walk" in data).toBe(true);
});

test("HANDOFF_DONE carries the walk, not the facing, when they differ (mid-cast)", () => {
  // Cast toward the right, walking up: the facing stays the cast direction, the mover steps the other way.
  const casting = { moving: true, casting: true, location: { position: { direction: "right" } }, _movementState: { targetDirection: "up" } };
  const walk = doneWalkOf(arrivedWalk(casting), casting);
  expect(walk).toBe("up");
  const data = decode(packetManager.handoffDone({ ...base, direction: casting.location.position.direction, walk })[0]).data;
  expect(data.direction).toBe("right");
  expect(data.walk).toBe("up");
});

test("a walk the node does not resume is null: no walk, a dead, stunned or held player, a name that is no direction", () => {
  const now = 1_000_000;
  expect(doneWalkOf(null, {}, now)).toBeNull();
  expect(doneWalkOf(undefined, {}, now)).toBeNull();
  expect(doneWalkOf("sideways", {}, now)).toBeNull();
  expect(doneWalkOf("left", { isDead: true }, now)).toBeNull();
  expect(doneWalkOf("left", { ghostTeleportPending: true }, now)).toBeNull();
  expect(doneWalkOf("left", { stunnedUntil: now + 1 }, now)).toBeNull();
  expect(doneWalkOf("left", { stunnedUntil: now }, now)).toBe("left");
  expect(doneWalkOf("left", { stunnedUntil: 0 }, now)).toBe("left");
  for (const d of ["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"]) expect(doneWalkOf(d, {}, now)).toBe(d);
});

test("the login sends the resumed walk in HANDOFF_DONE, from the arrival's own state and not the facing, before the walk resumes", () => {
  const receiver = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8");
  const done = receiver.indexOf("packetManager.handoffDone({");
  expect(done).toBeGreaterThan(0);
  const call = receiver.slice(done, receiver.indexOf("}));", done));
  const named = receiver.lastIndexOf("const doneWalk = doneWalkOf(arrivalState?.walk, _pcache);", done);
  expect(named).toBeGreaterThan(0);
  expect(call).toContain("walk: doneWalk,");
  expect(call).not.toMatch(/walk:[^\n]*direction/);
  // The walk named is the one resumed just after, from the same state.
  expect(receiver.indexOf("resumedWalk = resumeArrivalWalk(wt, arrivalState.walk);", done)).toBeGreaterThan(done);
  // Only the wire changes (the walk, and the walk the catch-up makes up): the packet keeps its type and its place.
  const source = readFileSync(join(import.meta.dir, "..", "socket", "packet_manager.ts"), "utf8");
  expect(source).toContain("handoffDone: (data: { map: string; x: number; y: number; direction: string; walk?: string | null; catchUpMs?: number }) => {");
});
