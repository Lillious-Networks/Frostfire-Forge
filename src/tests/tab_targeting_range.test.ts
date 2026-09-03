import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Tab-targeting (TARGETCLOSEST in src/socket/receiver.ts) picks a target within
// TARGETING_RANGE using a facing cone. TARGETING_RANGE was a hardcoded 500; it is
// now the AOI radius (aoi.json DEFAULT_RADIUS) so you can target anyone you can
// see even if no spell reaches them - the cast path enforces spell range on its
// own.
//
// The real cone code lives on the `player` object in systems/player.ts, which
// pulls in the DB worker pool and generated config at import time (and CI runs
// `bun test` before any config is generated), so it can't be imported here. This
// test uses mock fixtures for everything: a stand-in cone predicate that mirrors
// player.findPlayersInFacingCone, driven by hand-built positions.

// ---- fixtures (mock data, not read from real config) ----
const OLD_TARGETING_RANGE = 500;
const NEW_TARGETING_RANGE = 1000; // AOI DEFAULT_RADIUS
const CONE_ANGLE = 90;

const DIRECTION_ANGLES: Record<string, number> = {
  right: 0, downright: 45, down: 90, downleft: 135,
  left: 180, upleft: -135, up: -90, upright: -45,
};

// Mirrors the range + cone test inside player.findPlayersInFacingCone.
function inFacingCone(
  self: { x: number; y: number; direction: string },
  target: { x: number; y: number },
  range: number,
): boolean {
  const dx = target.x - self.x;
  const dy = target.y - self.y;
  if (Math.sqrt(dx * dx + dy * dy) > range) return false;

  const facingAngle = DIRECTION_ANGLES[self.direction] ?? 90;
  const tolerance = CONE_ANGLE / 2;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const minAngle = facingAngle - tolerance;
  const maxAngle = facingAngle + tolerance;
  if (minAngle < -180) return angle >= minAngle + 360 || angle <= maxAngle;
  if (maxAngle > 180) return angle >= minAngle || angle <= maxAngle - 360;
  return angle >= minAngle && angle <= maxAngle;
}

describe("tab-targeting cone + range", () => {
  const self = { x: 0, y: 0, direction: "right" };

  test("old range could not select a player at 800px; new range can", () => {
    const target = { x: 800, y: 0 }; // dead ahead, past the old 500 cap
    expect(inFacingCone(self, target, OLD_TARGETING_RANGE)).toBe(false);
    expect(inFacingCone(self, target, NEW_TARGETING_RANGE)).toBe(true);
  });

  test("still cuts off past the (new) range", () => {
    expect(inFacingCone(self, { x: NEW_TARGETING_RANGE + 200, y: 0 }, NEW_TARGETING_RANGE)).toBe(false);
  });

  test("longer range still respects the facing cone", () => {
    // behind the player
    expect(inFacingCone(self, { x: -800, y: 0 }, NEW_TARGETING_RANGE)).toBe(false);
    // 90deg off-facing, outside the 90deg cone
    expect(inFacingCone(self, { x: 0, y: 800 }, NEW_TARGETING_RANGE)).toBe(false);
    // 30deg off-facing, inside the cone
    expect(inFacingCone(self, { x: 700, y: 400 }, NEW_TARGETING_RANGE)).toBe(true);
  });
});

describe("TARGETCLOSEST handler wiring", () => {
  // Guards against the constant regressing to a hardcoded value. Source scan
  // only - no module import, no config dependency.
  const src = readFileSync(
    join(import.meta.dir, "..", "socket", "receiver.ts"),
    "utf8",
  );
  const handler = src.slice(src.indexOf('case "TARGETCLOSEST"'));
  const block = handler.slice(0, handler.indexOf("break;"));

  test("TARGETING_RANGE is derived from the AOI radius, not a literal", () => {
    const line = block.split("\n").find((l) => l.includes("TARGETING_RANGE ="));
    expect(line).toBeDefined();
    expect(line).toContain("DEFAULT_RADIUS");
    expect(line).not.toMatch(/TARGETING_RANGE\s*=\s*\d/);
  });
});
