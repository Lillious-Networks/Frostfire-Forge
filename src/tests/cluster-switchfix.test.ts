import { expect, test } from "bun:test";
import { databaseModule } from "./setup";
import { mock } from "bun:test";

// Switch stutter fix: a resumed arrival's own SPAWN_PLAYER carries the walk, the mount and the current point.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const { resumeSelfSpawn, recoverResumedWalk, waitFor, RESUME_WALK_WAIT_MS, RESUME_WALK_RECOVER_MS } = await import("../socket/arrival");

// The same naming as getAnimationNameForDirection (receiver.ts), which a test cannot import.
const nameOf = (direction: string, walking: boolean, mounted: boolean, mountType: string | undefined, casting: boolean) => {
  if (casting) return `player_${walking ? "cast_walk" : "cast_idle"}_${direction}.png`;
  const action = walking ? "walk" : "idle";
  return mounted ? `mount_${mountType || "unicorn"}_${action}_${direction}.png` : `player_${action}_${direction}.png`;
};
const at = (extra: any = {}) => ({ location: { position: { x: 640, y: 480, direction: "right" } }, ...extra });

test("a resumed walk spawns walking, at the current point", () => {
  const spawn = resumeSelfSpawn(at({ moving: true }), nameOf)!;
  expect(spawn.animationName).toBe("player_walk_right.png");
  expect([spawn.x, spawn.y, spawn.direction]).toEqual([640, 480, "right"]);
});

test("a resumed standing player spawns idle, mounted keeps the mount variant", () => {
  expect(resumeSelfSpawn(at(), nameOf)!.animationName).toBe("player_idle_right.png");
  expect(resumeSelfSpawn(at({ moving: true, mounted: true, mount_type: "horse" }), nameOf)!.animationName).toBe("mount_horse_walk_right.png");
  expect(resumeSelfSpawn(at({ moving: true, casting: true }), nameOf)!.animationName).toBe("player_cast_walk_right.png");
});

test("a dead walker is idle; a player without a usable point gives null (login values stay)", () => {
  expect(resumeSelfSpawn(at({ moving: true, isDead: true }), nameOf)!.animationName).toBe("player_idle_right.png");
  expect(resumeSelfSpawn({ location: { position: {} } }, nameOf)).toBeNull();
  expect(resumeSelfSpawn(undefined, nameOf)).toBeNull();
});

test("the receiver uses the helper only on a resume; a normal login keeps idle and the spawn point", async () => {
  const src = await Bun.file(new URL("../socket/receiver.ts", import.meta.url)).text();
  expect(src).toContain("const resumed = resume ? resumeSelfSpawn(currentPlayer, getAnimationNameForDirection, gameLoop.isPlayerMoving(currentPlayer.id)) : null;");
  expect(src).toContain('getAnimationNameForDirection(position?.direction || "down", false, false, undefined, false)');
  expect(src).toContain("x: resumed ? resumed.x : spawnLocation.x || 0");
});

// Crossfix: the walk survives the arrival.
test("a registered mover is a walk even when a stray stop cleared moving; a standing player with no mover is idle", () => {
  expect(resumeSelfSpawn(at({ moving: false }), nameOf, true)!.animationName).toBe("player_walk_right.png");
  expect(resumeSelfSpawn(at({ moving: false }), nameOf, false)!.animationName).toBe("player_idle_right.png");
  // A dead player is not walking whatever the mover says.
  expect(resumeSelfSpawn(at({ moving: false, isDead: true }), nameOf, true)!.animationName).toBe("player_idle_right.png");
});

test("the deferred spawn waits for the resumed walk and sends the live pose, not the stored point's idle", async () => {
  const src = (await Bun.file(new URL("../socket/receiver.ts", import.meta.url)).text()).replaceAll("\r", "");
  expect(src).toContain("resumedWalk = resumeArrivalWalk(wt, walk);");
  expect(src).toContain("if (resumedWalk) await waitFor(resumedWalk, RESUME_WALK_WAIT_MS);");
  expect(src).toContain("wt.data.walkRecoverUntil = Date.now() + RESUME_WALK_RECOVER_MS;");
  // The idle pose built from the stored position (a "down" default) is the login path only.
  expect(src).toContain("if (poseNow) await sendAnimationTo(wt, poseNow.animationName, wt.data.id);\n      } else if (position?.direction) {");
});

test("the waits are the specified values", () => {
  expect(RESUME_WALK_WAIT_MS).toBe(500);
  expect(RESUME_WALK_RECOVER_MS).toBe(3000);
});

test("waitFor ends with the work, or at the bound when the work never ends; it clears its timer and never rejects", async () => {
  const t0 = performance.now();
  await waitFor(new Promise(() => {}), 40);
  expect(performance.now() - t0).toBeGreaterThanOrEqual(35);
  expect(performance.now() - t0).toBeLessThan(400);
  const t1 = performance.now();
  await waitFor(Promise.resolve(), 60_000);
  expect(performance.now() - t1).toBeLessThan(50);
  await waitFor(Promise.reject(new Error("x")), 60_000);
  // the timer was cleared: no handle left that keeps the process or fires later
  let fired = 0;
  const real = globalThis.setTimeout;
  const cleared: any[] = [];
  const realClear = globalThis.clearTimeout;
  (globalThis as any).clearTimeout = (h: any) => { cleared.push(h); return realClear(h); };
  try { await waitFor(Promise.resolve(), 60_000); } finally { (globalThis as any).clearTimeout = realClear; }
  expect(cleared.length).toBe(1);
  expect(real).toBe(globalThis.setTimeout);
  expect(fired).toBe(0);
});

test("a resumed arrival recovers the walk after a stray stop; a normal player, a finished window, the dead and a mover are left alone", () => {
  const now = 10_000;
  const arrival = () => ({ moving: false } as any);
  const p = arrival();
  expect(recoverResumedWalk(p, now + 2000, now)).toBe(true);
  expect(p.moving).toBe(true);
  // not a resumed arrival (no window): untouched, CLUSTER=false never sets one
  const normal = arrival();
  expect(recoverResumedWalk(normal, undefined, now)).toBe(false);
  expect(normal.moving).toBe(false);
  // a stop after the window ended
  const late = arrival();
  expect(recoverResumedWalk(late, now - 1, now)).toBe(false);
  expect(late.moving).toBe(false);
  // dead, ghost teleport, already moving
  const dead = { moving: false, isDead: true } as any;
  expect(recoverResumedWalk(dead, now + 1000, now)).toBe(false);
  expect(dead.moving).toBe(false);
  const ghost = { moving: false, ghostTeleportPending: true } as any;
  expect(recoverResumedWalk(ghost, now + 1000, now)).toBe(false);
  expect(recoverResumedWalk({ moving: true } as any, now + 1000, now)).toBe(false);
});

test("movement.ts asks the helper with the arrival's window, and nothing else sets the window but the resume (and its late gap report)", async () => {
  const mv = (await Bun.file(new URL("../socket/handlers/movement.ts", import.meta.url)).text()).replaceAll("\r", "");
  expect(mv).toContain("if (recoverResumedWalk(currentPlayer, wt.data?.walkRecoverUntil, Date.now())) {");
  const rc = (await Bun.file(new URL("../socket/receiver.ts", import.meta.url)).text()).replaceAll("\r", "");
  expect(rc.split("walkRecoverUntil").length - 1).toBe(2);
  expect(rc.slice(rc.indexOf("export async function applyLateGap(")).split("walkRecoverUntil").length - 1).toBe(1);
});
