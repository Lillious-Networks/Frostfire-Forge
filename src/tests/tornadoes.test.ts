import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as t from "../systems/tornadoes";

type W = "tornado" | "storm" | "none";

const made = (id: string, x: number, y: number, over: any = {}) => ({
  id, username: id, wt: {}, location: { map: "overworld", position: { x, y, direction: "down" } },
  stats: { health: 1000, total_max_health: 1000 }, ...over,
});

let weather: W;
let people: any[];
let walls: (x: number, y: number) => boolean;
let moves: Array<{ id: string; x: number; y: number }>;
let hurts: Array<{ id: string; amount: number }>;
let shown: Array<{ map: string; list: any[] }>;
const spies: any[] = [];

beforeEach(() => {
  t.resetTornadoes();
  weather = "none";
  people = [made("p1", 5000, 5000)];
  walls = () => false;
  moves = [];
  hurts = [];
  shown = [];
  t.setTornadoBridge({
    weathers: () => [{ map: "overworld", weather }],
    players: () => people,
    size: () => ({ width: 163840, height: 163840 }),
    walkable: (_map, x, y) => !walls(x, y),
    move: (who, x, y) => { who.location.position = { ...who.location.position, x, y }; moves.push({ id: who.id, x, y }); },
    hurt: (who, amount) => { who.stats.health -= amount; hurts.push({ id: who.id, amount }); },
    show: (map, list) => { shown.push({ map, list }); },
  });
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  t.setTornadoBridge(null);
  t.resetTornadoes();
});

/** Runs the tornadoes from `from` for `ms`: a tick every 100 ms, and a pull three times in each (30 Hz). */
async function run(from: number, ms: number): Promise<number> {
  let now = from;
  for (const end = from + ms; now <= end; now += 100) {
    await t.tick(now);
    for (const at of [now, now + 33, now + 67]) await t.pull(at);
  }
  return now;
}

test("clear weather has no tornado, and a world on \"tornado\" always has one, anywhere on the map", async () => {
  await run(0, 30_000);
  expect(t.tornadoesOn("overworld")).toEqual([]);
  weather = "tornado";
  await run(40_000, 100);
  const [one] = t.tornadoesOn("overworld");
  expect(one).toBeDefined();
  // inside the map, not put by the player (who stands at 5000, 5000 of a 163840 px map)
  expect(one.x).toBeGreaterThanOrEqual(0);
  expect(one.y).toBeLessThanOrEqual(163840);
  // the players of the map are told where it is
  expect(shown.at(-1)).toMatchObject({ map: "overworld", list: [{ id: one.id }] });
});

test("never more than two on a map, however long it blows", async () => {
  weather = "tornado";
  spies.push(spyOn(Math, "random").mockReturnValue(0));
  // (Math.random 0: the second always comes; the tornadoes all live their shortest)
  let most = 0;
  for (let now = 0; now < 120_000; now += 100) {
    await t.tick(now);
    await t.pull(now);
    most = Math.max(most, t.tornadoesOn("overworld").length);
  }
  expect(most).toBe(t.MAX_PER_MAP);
});

test("a thunderstorm makes one only by its rare chance", async () => {
  weather = "storm";
  spies.push(spyOn(Math, "random").mockReturnValue(t.STORM_CHANCE + 0.001));
  await run(0, 60_000);
  expect(t.tornadoesOn("overworld")).toEqual([]);
  spies.pop().mockRestore();
  spies.push(spyOn(Math, "random").mockReturnValue(t.STORM_CHANCE / 2));
  await run(70_000, 100);
  expect(t.tornadoesOn("overworld").length).toBe(1);
});

test("no tornado forms where nobody is, nor for the dead, ghosts and admins in stealth", async () => {
  weather = "tornado";
  people = [made("dead", 5000, 5000, { isDead: true }), made("ghost", 5000, 5000, { isGhost: true }), made("hidden", 5000, 5000, { isStealth: true })];
  await run(0, 30_000);
  expect(t.tornadoesOn("overworld")).toEqual([]);
});

test("when the storm passes its tornadoes go, and the players are told there are none", async () => {
  weather = "tornado";
  await run(0, 500);
  expect(t.tornadoesOn("overworld").length).toBeGreaterThan(0);
  weather = "none";
  await run(1_000, 1_500);
  expect(t.tornadoesOn("overworld")).toEqual([]);
  expect(shown.at(-1)).toEqual({ map: "overworld", list: [] });
  const told = shown.length;
  await run(3_000, 2_000);
  // told once, not over and over
  expect(shown.length).toBe(told);
});

test("a pull draws a player in, harder the nearer, never past the middle, and round it a little", () => {
  const far = t.pullStep(0, 0, 150, 0, 0.1)!, near = t.pullStep(0, 0, 40, 0, 0.1)!;
  expect(far.inX).toBeLessThan(150);
  expect(150 - far.inX).toBeLessThan(40 - near.inX);
  // slower than a walk (180 px a second), even at its middle
  expect((40 - near.inX) / 0.1).toBeLessThan(180);
  // carried round as well as in
  expect(Math.abs(near.y)).toBeGreaterThan(0);
  expect(t.pullStep(0, 0, 0.5, 0, 0.1)).toBeNull();
  expect(t.pullStep(0, 0, t.PULL_RADIUS + 1, 0, 0.1)).toBeNull();
  const close = t.pullStep(0, 0, 2, 0, 1)!;
  expect(close.inX).toBeCloseTo(0, 5);
});

test("a player near one is pulled toward it and loses 5% of their maximum health each second", async () => {
  weather = "tornado";
  await run(0, 100);
  const [one] = t.tornadoesOn("overworld");
  // stand the player right by it, and keep the tornado still
  one.speed = 0;
  people[0].location.position = { x: Math.round(one.x + 30), y: Math.round(one.y), direction: "down" };
  const before = Math.hypot(people[0].location.position.x - one.x, people[0].location.position.y - one.y);
  await run(200, 2_950);
  expect(moves.length).toBeGreaterThan(0);
  expect(Math.hypot(people[0].location.position.x - one.x, people[0].location.position.y - one.y)).toBeLessThan(before);
  // at once on coming near, then once a second (at 0.2, 1.2 and 2.2 seconds)
  expect(hurts.map((h) => h.amount)).toEqual([50, 50, 50]);
  expect(people[0].stats.health).toBe(850);
});

test("a pull is never into a wall", async () => {
  weather = "tornado";
  await run(0, 100);
  const [one] = t.tornadoesOn("overworld");
  one.speed = 0;
  people[0].location.position = { x: Math.round(one.x + 100), y: Math.round(one.y), direction: "down" };
  walls = () => true;
  await run(200, 1_000);
  expect(moves).toEqual([]);
});

test("a player out of reach is neither pulled nor hurt", async () => {
  weather = "tornado";
  await run(0, 100);
  const [one] = t.tornadoesOn("overworld");
  one.speed = 0;
  people[0].location.position = { x: Math.round(one.x + t.PULL_RADIUS + 50), y: Math.round(one.y), direction: "down" };
  await run(200, 2_000);
  expect(moves).toEqual([]);
  expect(hurts).toEqual([]);
});

test("a pull moves a player a little every 1/30 s, evenly, not a lump every 100 ms", async () => {
  weather = "tornado";
  await run(0, 100);
  const [one] = t.tornadoesOn("overworld");
  one.speed = 0;
  people[0].location.position = { x: Math.round(one.x + 150), y: Math.round(one.y), direction: "down" };
  moves = [];
  let now = 1_000;
  await t.pull(now);
  for (let i = 0; i < 30; i++) await t.pull((now += 1000 / 30));
  // a step on (nearly) every tick, each of a px or two: the part of a px left over is carried, not lost
  expect(moves.length).toBeGreaterThanOrEqual(28);
  const steps = moves.slice(1).map((m, i) => Math.hypot(m.x - moves[i].x, m.y - moves[i].y));
  // (a whole px or two each way, a little more as it nears the middle, where it pulls harder: before, a lump of 4 to
  // 11 px every third tick)
  expect(Math.max(...steps)).toBeLessThan(3.5);
  const start = Math.hypot(moves[0].x - one.x, moves[0].y - one.y), end = Math.hypot(moves.at(-1)!.x - one.x, moves.at(-1)!.y - one.y);
  // about the pull's speed out there over the second (not stalled by rounding)
  expect(start - end).toBeGreaterThan(25);
});

test("a tornado forms anywhere on the map, not by the players", async () => {
  weather = "tornado";
  const spots: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 40; i++) {
    t.resetTornadoes();
    await t.tick(0);
    spots.push({ x: t.tornadoesOn("overworld")[0].x, y: t.tornadoesOn("overworld")[0].y });
  }
  // spread over the map, not gathered round the player at 5000, 5000
  const far = spots.filter((p) => Math.hypot(p.x - 5000, p.y - 5000) > 20_000).length;
  expect(far).toBeGreaterThan(30);
});
