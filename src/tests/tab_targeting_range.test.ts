import { expect, test, describe } from "bun:test";
import AOI_CONFIG from "../config/aoi.json";

// Tab-targeting (TARGETCLOSEST) selects a target within TARGETING_RANGE using a
// facing cone. TARGETING_RANGE is now the AOI radius (config DEFAULT_RADIUS, was
// a hardcoded 500) so you can target anyone you can see, even out of spell range
// - the cast path enforces spell range separately.
//
// This replicates the range + cone filter from player.findPlayersInFacingCone /
// getNextTargetInCone (which can't be imported directly - systems/player.ts pulls
// in the DB worker pool at import time).

const TARGETING_RANGE = (AOI_CONFIG as any).DEFAULT_RADIUS ?? 1000;
const CONE_ANGLE = 90;

const DIRECTION_ANGLES: Record<string, number> = {
  right: 0, downright: 45, down: 90, downleft: 135,
  left: 180, upleft: -135, up: -90, upright: -45,
};

function inFacingCone(self: { x: number; y: number; direction: string }, tx: number, ty: number): boolean {
  const dx = tx - self.x;
  const dy = ty - self.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance > TARGETING_RANGE) return false;

  const facingAngle = DIRECTION_ANGLES[self.direction] ?? 90;
  const tolerance = CONE_ANGLE / 2;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  const minAngle = facingAngle - tolerance;
  const maxAngle = facingAngle + tolerance;
  if (minAngle < -180) return angle >= minAngle + 360 || angle <= maxAngle;
  if (maxAngle > 180) return angle >= minAngle || angle <= maxAngle - 360;
  return angle >= minAngle && angle <= maxAngle;
}

describe("tab-targeting range", () => {
  test("TARGETING_RANGE follows the AOI radius, not the old 500", () => {
    expect(TARGETING_RANGE).toBe(AOI_CONFIG.DEFAULT_RADIUS);
    expect(TARGETING_RANGE).toBeGreaterThan(500);
  });

  test("targets a player past old 500 range but within AOI, in the facing cone", () => {
    const self = { x: 0, y: 0, direction: "right" };
    // 800px directly to the right - outside the old range, inside the new one.
    expect(inFacingCone(self, 800, 0)).toBe(true);
  });

  test("does not target a player beyond the AOI radius", () => {
    const self = { x: 0, y: 0, direction: "right" };
    expect(inFacingCone(self, TARGETING_RANGE + 200, 0)).toBe(false);
  });

  test("still respects the facing cone at the longer range", () => {
    const self = { x: 0, y: 0, direction: "right" };
    // 800px away but directly behind (to the left) - out of the cone.
    expect(inFacingCone(self, -800, 0)).toBe(false);
    // 800px away at ~90deg off-facing - out of the 90deg cone.
    expect(inFacingCone(self, 0, 800)).toBe(false);
  });
});
