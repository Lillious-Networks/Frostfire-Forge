import { describe, expect, mock, test } from "bun:test";

mock.module("../controllers/sqldatabase", () => ({ default: async () => [] }));

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

const { NavGrid, NavGridCache, decodeCollisionRLE, rleChecksum, FOOT_H } = await import("../systems/creatures/navgrid");
const { advance, directionFor, setDestination } = await import("../systems/creatures/movement");
const { advancePatrolIndex, tickCreature } = await import("../systems/creatures/ai");
const { normalizeSpawn, normalizeTemplate, normalizePatrolPath } = await import("../systems/creatures/repository");
const { speedPxPerSec } = await import("../systems/creatures/constants");

/** Build an RLE collision array from rows of '.' (open) and '#' (wall). */
function rleFrom(rows: string[]): number[] {
  const width = rows[0].length;
  const flat = rows.join("").split("").map((ch) => (ch === "#" ? 1 : 0));
  const out: number[] = [width, rows.length];
  let current = flat[0];
  let count = 1;
  for (let i = 1; i < flat.length; i++) {
    if (flat[i] === current) count++;
    else {
      out.push(current, count);
      current = flat[i];
      count = 1;
    }
  }
  out.push(current, count);
  return out;
}

const T = 32;
const center = (tx: number, ty: number) => ({ x: tx * T + T / 2, y: ty * T + T / 2 - FOOT_H / 2 });

// A wall down column 3 with a gap at row 4.
const ROOM = [
  "...#......",
  "...#......",
  "...#......",
  "...#......",
  "..........",
  "...#......",
];
const grid = () => NavGrid.fromRLE(rleFrom(ROOM), T, T)!;

const creature = (x: number, y: number): any => ({
  id: 1, templateId: 1, spawnId: 1, poolId: null, map: "main", layerId: null, x, y, dir: "down",
  homeX: x, homeY: y, level: 1, health: 10, maxHealth: 10, state: "idle", spawnedAt: 0, move: null,
  waitUntil: 0, patrolIndex: 0, patrolForward: true, sentX: x, sentY: y, sentDir: "down", sentMoving: false,
});

describe("nav grid", () => {
  test("decodes RLE and treats out-of-bounds as blocked", () => {
    const d = decodeCollisionRLE([3, 2, 0, 2, 1, 1, 0, 3])!;
    expect(d.width).toBe(3);
    expect([...d.blocked]).toEqual([0, 0, 1, 0, 0, 0]);
    const g = grid();
    expect(g.isBlockedTile(3, 1)).toBe(true);
    expect(g.isBlockedTile(3, 4)).toBe(false);
    expect(g.isBlockedTile(-1, 0)).toBe(true);
    expect(g.isBlockedTile(10, 0)).toBe(true);
    expect(decodeCollisionRLE([0, 5])).toBeNull();
  });

  test("tile/anchor round trip and footprint walkability", () => {
    const g = grid();
    const p = center(2, 2);
    expect(g.tileOf(p)).toEqual({ tx: 2, ty: 2 });
    expect(g.isWalkable(p.x, p.y)).toBe(true);
    expect(g.isWalkable(center(3, 2).x, center(3, 2).y)).toBe(false);
  });

  test("line of sight is blocked by walls", () => {
    const g = grid();
    expect(g.lineOfSight(center(1, 2), center(6, 2))).toBe(false);
    expect(g.lineOfSight(center(1, 4), center(6, 4))).toBe(true);
  });

  test("A* routes through the gap and never enters walls", () => {
    const g = grid();
    const path = g.findPath(center(1, 2), center(6, 2))!;
    expect(path).not.toBeNull();
    let prev = center(1, 2);
    for (const wp of path) {
      expect(g.canTraverse(prev, wp)).toBe(true);
      prev = wp;
    }
    expect(path.at(-1)).toEqual(center(6, 2));
    expect(path.some((wp) => g.tileOf(wp).ty === 4)).toBe(true);
  });

  test("straight open paths are smoothed to a single waypoint", () => {
    expect(grid().findPath(center(5, 0), center(9, 3))).toEqual([center(9, 3)]);
  });

  test("returns null when enclosed or over budget", () => {
    const boxed = NavGrid.fromRLE(rleFrom(["#####", "#...#", "#####", ".....", "....."]), T, T)!;
    expect(boxed.findPath(center(2, 1), center(2, 4))).toBeNull();
    expect(grid().findPath(center(0, 0), center(9, 5), 3)).toBeNull();
  });

  test("blocked goal snaps to a nearby open tile", () => {
    const path = grid().findPath(center(0, 0), center(3, 2))!;
    expect(path).not.toBeNull();
    expect(grid().isBlockedTile(grid().tileOf(path.at(-1)!).tx, grid().tileOf(path.at(-1)!).ty)).toBe(false);
  });

  test("step slides along walls", () => {
    const g = grid();
    const start = center(2, 2);
    const slid = g.step(start, 40, 10);
    expect(slid.x).toBe(start.x);
    expect(slid.y).toBe(start.y + 10);
  });

  test("random points stay walkable and in radius", () => {
    const g = grid();
    let s = 1;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 50; i++) {
      const p = g.randomPointNear(center(7, 3), 64, r);
      if (!p) continue;
      expect(g.isWalkable(p.x, p.y)).toBe(true);
      expect(Math.hypot(p.x - center(7, 3).x, p.y - center(7, 3).y)).toBeLessThanOrEqual(64.001);
    }
  });

  test("cache rebuilds only when collision content changes", () => {
    const cache = new NavGridCache();
    const rle = rleFrom(ROOM);
    expect(cache.update("main", rle, T, T)).toBe(true);
    expect(cache.update("main", [...rle], T, T)).toBe(false);
    const edited = rleFrom(ROOM.map((row, i) => (i === 0 ? "#" + row.slice(1) : row)));
    expect(rleChecksum(edited)).not.toBe(rleChecksum(rle));
    expect(cache.update("main", edited, T, T)).toBe(true);
    expect(cache.get("main")!.isBlockedTile(0, 0)).toBe(true);
    cache.update("main", null, T, T);
    expect(cache.get("main")).toBeUndefined();
  });
});

describe("creature movement", () => {
  test("direction names match player directions", () => {
    expect(directionFor(1, 0, "down")).toBe("right");
    expect(directionFor(0, -1, "down")).toBe("up");
    expect(directionFor(-1, 1, "down")).toBe("downleft");
    expect(directionFor(0, 0, "left")).toBe("left");
  });

  test("advances at speed, re-buckets via place, and arrives", () => {
    const g = grid();
    const c = creature(center(5, 0).x, center(5, 0).y);
    expect(setDestination(c, g, center(9, 0), 180)).toBe(true);
    const placed: Array<[number, number]> = [];
    const place = (x: number, y: number) => {
      c.x = x;
      c.y = y;
      placed.push([x, y]);
    };
    expect(advance(c, g, 100, place)).toBe("moving");
    expect(c.x - center(5, 0).x).toBeCloseTo(18, 5);
    expect(c.dir).toBe("right");
    let result = "moving";
    for (let i = 0; i < 20 && result === "moving"; i++) result = advance(c, g, 100, place);
    expect(result).toBe("arrived");
    expect(c.x).toBeCloseTo(center(9, 0).x, 5);
    expect(c.move).toBeNull();
    expect(placed.length).toBeGreaterThan(1);
  });

  test("gives up after repeated no-progress ticks", () => {
    const g = grid();
    const c = creature(center(2, 2).x, center(2, 2).y);
    c.move = { path: [center(4, 2)], index: 0, speed: 180, stuckTicks: 0 };
    const place = (x: number, y: number) => {
      c.x = x;
      c.y = y;
    };
    const results = [advance(c, g, 100, place), advance(c, g, 100, place), advance(c, g, 100, place)];
    expect(results.at(-1)).toBe("stuck");
    expect(c.move).toBeNull();
  });

  test("speed conversion matches player run speed at WoW run speed", () => {
    expect(speedPxPerSec(7)).toBe(180);
    expect(speedPxPerSec(2.5)).toBeCloseTo(64.29, 1);
  });
});

describe("idle AI behaviours", () => {
  const template = normalizeTemplate({ id: 1, name: "Boar", move_speed_walk: 7 });
  const baseCtx = (overrides: any = {}) => ({
    now: 0,
    dtMs: 100,
    grid: grid(),
    template,
    spawn: undefined,
    patrol: undefined,
    rng: () => 0.5,
    place: (c: any, x: number, y: number) => {
      c.x = x;
      c.y = y;
    },
    ...overrides,
  });

  test("patrol index loops or ping-pongs", () => {
    const c = creature(0, 0);
    const loop = normalizePatrolPath({ id: 1, loop: 1, points_json: "[{\"x\":0,\"y\":0},{\"x\":1,\"y\":1},{\"x\":2,\"y\":2}]" });
    const pong = { ...loop, loop: false };
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      advancePatrolIndex(c, loop);
      seen.push(c.patrolIndex);
    }
    expect(seen).toEqual([1, 2, 0, 1]);
    c.patrolIndex = 0;
    seen.length = 0;
    for (let i = 0; i < 5; i++) {
      advancePatrolIndex(c, pong);
      seen.push(c.patrolIndex);
    }
    expect(seen).toEqual([1, 2, 1, 0, 1]);
  });

  test("patrol walks to each point and waits there", () => {
    const a = center(5, 0);
    const b = center(8, 0);
    const patrol = normalizePatrolPath({ id: 1, map: "main", loop: 1, points_json: JSON.stringify([{ ...a, wait_ms: 0 }, { ...b, wait_ms: 1000 }]) });
    const spawn = normalizeSpawn({ id: 1, template_id: 1, map: "main", movement_type: "patrol", patrol_path_id: 1 });
    const c = creature(a.x, a.y);
    let now = 0;
    for (; now < 3000; now += 100) {
      tickCreature(c, baseCtx({ now, spawn, patrol }));
      if (c.x === b.x && !c.move) break;
    }
    expect(c.state).toBe("patrol");
    expect(c.x).toBeCloseTo(b.x, 5);
    expect(c.patrolIndex).toBe(0);
    expect(c.waitUntil).toBe(now + 1000);
  });

  test("wander stays within radius of home and pauses between moves", () => {
    const spawn = normalizeSpawn({ id: 1, template_id: 1, map: "main", movement_type: "wander", wander_radius: 5 });
    const home = center(7, 2);
    const c = creature(home.x, home.y);
    let s = 7;
    const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    let pauses = 0;
    let wasMoving = false;
    for (let now = 0; now < 60_000; now += 100) {
      tickCreature(c, baseCtx({ now, spawn, rng }));
      expect(Math.hypot(c.x - home.x, c.y - home.y)).toBeLessThanOrEqual(5 * 8 + 0.01);
      if (wasMoving && !c.move) pauses++;
      wasMoving = c.move !== null;
    }
    expect(c.state).toBe("wander");
    expect(pauses).toBeGreaterThan(0);
  });

  test("idle creatures return home when displaced and face spawn direction", () => {
    const spawn = normalizeSpawn({ id: 1, template_id: 1, map: "main", direction: "left" });
    const home = center(8, 0);
    const c = creature(center(5, 0).x, center(5, 0).y);
    c.homeX = home.x;
    c.homeY = home.y;
    for (let now = 0; now < 3000; now += 100) tickCreature(c, baseCtx({ now, spawn }));
    expect(c.x).toBeCloseTo(home.x, 5);
    expect(c.dir).toBe("left");
    expect(c.state).toBe("idle");
  });

  test("no grid means no movement", () => {
    const spawn = normalizeSpawn({ id: 1, template_id: 1, map: "main", movement_type: "wander", wander_radius: 10 });
    const c = creature(100, 100);
    tickCreature(c, baseCtx({ grid: undefined, spawn }));
    expect(c.move).toBeNull();
    expect(c.x).toBe(100);
  });
});
