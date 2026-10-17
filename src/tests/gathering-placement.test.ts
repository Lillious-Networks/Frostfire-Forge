import { describe, expect, test } from "bun:test";
import { NODE_GAP, apart, pickSpot, previewSpots } from "../systems/gathering/placement";
import { closedGrid, openGrid, seeded } from "./gathering-helpers";

const area = { x: 500, y: 500, radius: 160 };
const inside = (s: { x: number; y: number }) => Math.hypot(s.x - area.x, s.y - area.y) <= area.radius;

describe("pickSpot", () => {
  test("is a walkable tile inside the circle", () => {
    const r = seeded(7);
    for (let i = 0; i < 50; i++) {
      const spot = pickSpot(openGrid(), area, new Set(), r);
      expect(spot).not.toBeNull();
      expect(inside(spot!)).toBe(true);
    }
  });

  test("never picks a taken tile", () => {
    const r = seeded(3);
    const taken = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const spot = pickSpot(openGrid(), area, taken, r)!;
      expect(taken.has(spot.tile)).toBe(false);
      taken.add(spot.tile);
    }
  });

  test("never picks a blocked tile", () => {
    const blocked = new Set<string>();
    for (let tx = 10; tx < 20; tx++) for (let ty = 10; ty < 20; ty++) if ((tx + ty) % 2 === 0) blocked.add(`${tx},${ty}`);
    const r = seeded(11);
    for (let i = 0; i < 40; i++) {
      const spot = pickSpot(openGrid(blocked), area, new Set(), r);
      if (spot) expect(blocked.has(spot.tile)).toBe(false);
    }
  });

  test("is null when nothing is walkable", () => {
    expect(pickSpot(closedGrid(), area, new Set(), seeded())).toBeNull();
  });
});

describe("previewSpots", () => {
  test("gives as many spots as asked, on different tiles", () => {
    const spots = previewSpots(openGrid(), area, 12, seeded(5));
    expect(spots.length).toBe(12);
    expect(new Set(spots.map((s) => s.tile)).size).toBe(12);
  });

  test("spots never overlap: pictures of the area's size stay apart", () => {
    const size = 64;
    const spots = previewSpots(openGrid(), { ...area, size }, 30, seeded(5));
    expect(spots.length).toBeGreaterThan(3);
    for (const a of spots) {
      for (const b of spots) {
        if (a !== b) expect(apart({ ...a, size }, { ...b, size })).toBe(true);
      }
    }
  });

  test("apart: squares that touch with the gap are apart, closer ones are not", () => {
    const step = 32 + NODE_GAP;
    expect(apart({ x: 0, y: 0, size: 32 }, { x: step, y: 0, size: 32 })).toBe(true);
    expect(apart({ x: 0, y: 0, size: 32 }, { x: step - 1, y: step - 1, size: 32 })).toBe(false);
    expect(apart({ x: 0, y: 0, size: 16 }, { x: 0, y: 16 / 2 + 64 / 2 + NODE_GAP, size: 64 })).toBe(true);
  });

  test("gives fewer when the area has no more room", () => {
    // a 40 px circle centred on a tile corner holds 4 tile centres at most
    const spots = previewSpots(openGrid(), { x: 512, y: 512, radius: 40 }, 20, seeded(9));
    expect(spots.length).toBeLessThanOrEqual(4);
    expect(spots.length).toBeGreaterThan(0);
  });
});
