import { expect, mock, test } from "bun:test";
import { databaseModule, mockQuery } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));

const { answerGather, GATHER_MIRROR_TOLERANCE_PX, RemoteGatherers } = await import("../systems/gathering/remote");
const { REASONS } = await import("../systems/gathering/service");

const node = { id: 4, map: "main", x: 500, y: 500 } as any;

// A service that grants every request but a dead gatherer's, as the real one: what is under test is the check before it.
function deps(mirror: any) {
  const ran: string[] = [];
  const gatherers = new RemoteGatherers();
  const dead = (id: string) => !!gatherers.get(id)?.dead;
  return {
    ran,
    deps: {
      service: {
        start: async (id: string) => (ran.push("start"), dead(id) ? { ok: false as const, reason: REASONS.dead } : { ok: true as const, node }),
        finish: async (id: string) => (ran.push("finish"), dead(id) ? { ok: false as const, reason: REASONS.dead } : { ok: true as const, node, item: "Copper Ore", quantity: 2 }),
      },
      gatherers,
      ownerOf: (id: string) => (id === "7" ? "b" : null),
      mirrorOf: (id: string) => (id === "7" ? mirror : undefined),
    } as any,
  };
}

const gatherer = (over: any = {}) => ({
  id: "7", username: "alice", map: "main", layerId: "L1", x: 510, y: 500,
  dead: false, stunned: false, casting: false, moving: false, inCombat: false, hasRoom: true, ...over,
});
const mirrorAt = (x: number, y: number, map = "main", over: any = {}) => ({ username: "alice", location: { map, position: { x, y } }, ...over });

test("a gatherer whose mirror stands within reach is served", async () => {
  const { deps: d, ran } = deps(mirrorAt(510 + GATHER_MIRROR_TOLERANCE_PX - 1, 500));
  expect(await answerGather({ phase: "start", nodeId: 4, gatherer: gatherer() }, "b", d)).toMatchObject({ ok: true });
  expect(ran).toEqual(["start"]);
});

test("a gatherer sent far from its mirror is refused", async () => {
  const { deps: d, ran } = deps(mirrorAt(510 + GATHER_MIRROR_TOLERANCE_PX + 1, 500));
  expect(await answerGather({ phase: "start", nodeId: 4, gatherer: gatherer() }, "b", d)).toEqual({ ok: false, reason: REASONS.gone });
  expect(ran).toEqual([]);
});

test("a finish sent far from its mirror is refused as lost", async () => {
  const { deps: d, ran } = deps(mirrorAt(5000, 500));
  expect(await answerGather({ phase: "finish", nodeId: 4, gatherer: gatherer() }, "b", d)).toEqual({ ok: false, reason: REASONS.lost });
  expect(ran).toEqual([]);
});

test("a gatherer sent on another map than its mirror is refused", async () => {
  const { deps: d, ran } = deps(mirrorAt(510, 500, "cave"));
  expect(await answerGather({ phase: "start", nodeId: 4, gatherer: gatherer() }, "b", d)).toEqual({ ok: false, reason: REASONS.gone });
  expect(ran).toEqual([]);
});

test("a mirror's map with .json matches the bare map sent", async () => {
  const { deps: d } = deps(mirrorAt(510, 500, "main.json"));
  expect(await answerGather({ phase: "start", nodeId: 4, gatherer: gatherer() }, "b", d)).toMatchObject({ ok: true });
});

test("a mirror with no position refuses the gatherer", async () => {
  const { deps: d, ran } = deps({ username: "alice" });
  expect(await answerGather({ phase: "start", nodeId: 4, gatherer: gatherer() }, "b", d)).toEqual({ ok: false, reason: REASONS.gone });
  expect(ran).toEqual([]);
});

test("a mirror with a null x or y refuses the gatherer, not read as 0", async () => {
  for (const position of [{ x: null, y: null }, { x: null, y: 500 }, { x: 510, y: null }]) {
    const { deps: d, ran } = deps({ username: "alice", location: { map: "main", position } });
    // The gatherer stands near (0, 0), where a null read as 0 would pass.
    const near = gatherer({ x: 10, y: 0 });
    expect(await answerGather({ phase: "start", nodeId: 4, gatherer: near }, "b", d)).toEqual({ ok: false, reason: REASONS.gone });
    expect(await answerGather({ phase: "finish", nodeId: 4, gatherer: near }, "b", d)).toEqual({ ok: false, reason: REASONS.lost });
    expect(ran).toEqual([]);
  }
});

test("a dead or ghost mirror is refused by the service as dead, whatever the request says", async () => {
  for (const state of [{ isDead: true }, { isGhost: true }]) {
    const { deps: d } = deps(mirrorAt(510, 500, "main", state));
    expect(await answerGather({ phase: "start", nodeId: 4, gatherer: gatherer({ dead: false }) }, "b", d)).toEqual({ ok: false, reason: REASONS.dead });
    expect(await answerGather({ phase: "finish", nodeId: 4, gatherer: gatherer({ dead: false }) }, "b", d)).toEqual({ ok: false, reason: REASONS.dead });
  }
});

test("a request that says dead is refused as dead although the mirror is alive", async () => {
  const { deps: d } = deps(mirrorAt(510, 500, "main", { isDead: false, isGhost: false }));
  expect(await answerGather({ phase: "start", nodeId: 4, gatherer: gatherer({ dead: true }) }, "b", d)).toEqual({ ok: false, reason: REASONS.dead });
  expect(await answerGather({ phase: "finish", nodeId: 4, gatherer: gatherer({ dead: true }) }, "b", d)).toEqual({ ok: false, reason: REASONS.dead });
});

test("a stealthed mirror is served, as a local stealthed player is", async () => {
  const { deps: d, ran } = deps(mirrorAt(510, 500, "main", { isStealth: true }));
  expect(await answerGather({ phase: "start", nodeId: 4, gatherer: gatherer() }, "b", d)).toMatchObject({ ok: true });
  expect(ran).toEqual(["start"]);
});
