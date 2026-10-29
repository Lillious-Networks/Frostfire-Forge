import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";
import { BlockTable, type MapBlocks } from "../cluster/blocks";
import { MemoryStore } from "../cluster/memorystore";
import {
  DEBUG_MIN_GAP_MS, DebugRateLimit, MAX_DEBUG_CELLS, buildClusterDebug, type ClusterDebugSource,
} from "../cluster/nodedebug";

// The admin's "Cluster Nodes" overlay (F2 menu): the CLUSTER_DEBUG answer reads the node's block table and nothing else.

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

// 3 x 2 blocks: a owns the left column, b the middle, c one block of the right column, (2,1) is unowned.
const table: MapBlocks = {
  epoch: 7,
  owners: {
    "0,0": { nodeId: "a", epoch: 7, since: 1 },
    "0,1": { nodeId: "a", epoch: 7, since: 1 },
    "1,0": { nodeId: "b", epoch: 7, since: 1 },
    "1,1": { nodeId: "b", epoch: 7, since: 1 },
    "2,0": { nodeId: "c", epoch: 7, since: 1 },
  },
};

async function sourceOf(given: Array<[number, number]> = [], self: string | null = "a"): Promise<ClusterDebugSource> {
  const blocks = new BlockTable(new MemoryStore());
  blocks.useExtents([{ name: "main", blocksX: 3, blocksY: 2 }]);
  await blocks.write("main", table);
  return {
    self: () => self,
    ownersOf: (map) => blocks.ownersOf(map),
    epochOf: (map) => blocks.epochOf(map),
    extentOf: (map) => blocks.extentOf(map),
    blockOf: (map, x, y) => blocks.blockOf(map, x, y),
    givenAway: (_map, bx, by) => given.some(([x, y]) => x === bx && y === by),
  };
}

const admin = (x = 100, y = 100) => ({ isAdmin: true, location: { map: "main.json", position: { x, y } } });

test("the answer lists the owner of each block of the map, row by row, with the table's epoch", async () => {
  const answer: any = buildClusterDebug(await sourceOf(), admin());
  expect(answer.cluster).toBe(true);
  expect(answer.allowed).toBe(true);
  expect(answer.self).toBe("a");
  expect(answer.map).toBe("main");
  expect(answer.blocksX).toBe(3);
  expect(answer.blocksY).toBe(2);
  expect(answer.epoch).toBe(7);
  expect(answer.blockPx).toBe(4096);
  const owners = answer.cells.map((i: number) => (i < 0 ? null : answer.nodes[i]));
  // index = by * 3 + bx
  expect(owners).toEqual(["a", "b", "c", "a", "b", null]);
  expect(answer.moving).toEqual([]);
});

test("the block under the player and its owner are named, and a position past the edge is the edge block", async () => {
  const source = await sourceOf();
  const inB: any = buildClusterDebug(source, admin(4096 + 5, 10));
  expect(inB.here).toEqual({ bx: 1, by: 0, owner: inB.nodes.indexOf("b") });
  const past: any = buildClusterDebug(source, admin(999_999, 999_999));
  expect(past.here.bx).toBe(2);
  expect(past.here.by).toBe(1);
  expect(past.here.owner).toBe(-1);
  const noPosition: any = buildClusterDebug(source, { location: { map: "main" } });
  expect(noPosition.here).toBeNull();
});

test("a block this node gave away and has not seen settled is listed as moving", async () => {
  const answer: any = buildClusterDebug(await sourceOf([[1, 0], [2, 1]]), admin());
  expect(answer.moving).toEqual([1, 5]);
});

test("a map with no table cached answers with every block unowned", async () => {
  const answer: any = buildClusterDebug(await sourceOf(), { location: { map: "elsewhere", position: { x: 0, y: 0 } } });
  expect(answer.allowed).toBe(true);
  expect(answer.cells.every((i: number) => i === -1)).toBe(true);
  expect(answer.nodes).toEqual([]);
});

test("any logged-in player gets the table; a request with no player is told it is not allowed", async () => {
  const source = await sourceOf();
  expect(buildClusterDebug(source, null)).toEqual({ cluster: true, allowed: false });
  for (const player of [{ isAdmin: false, location: { map: "main" } }, { permissions: [], location: { map: "main" } }]) {
    const answer: any = buildClusterDebug(source, player as any);
    expect(answer.allowed).toBe(true);
    expect(answer.self).toBe("a");
  }
});

test("with the cluster off the answer is { cluster: false } and nothing else, to an admin or not", async () => {
  expect(buildClusterDebug(null, admin())).toEqual({ cluster: false });
  expect(buildClusterDebug(null, null)).toEqual({ cluster: false });
  expect(buildClusterDebug(await sourceOf([], null), admin())).toEqual({ cluster: false });
});

test("the answer names no host, port, secret or player", async () => {
  const text = JSON.stringify(buildClusterDebug(await sourceOf(), { ...admin(), username: "root", token: "secret", id: "9" } as any));
  for (const word of ["root", "secret", "host", "port", "username", "token"]) expect(text).not.toContain(word);
});

test("a grid over the cell cap is cut by rows, not made into a large packet", async () => {
  const blocks = new BlockTable(new MemoryStore());
  blocks.useExtents([{ name: "huge", blocksX: 100, blocksY: 100 }]);
  const source: ClusterDebugSource = {
    self: () => "a", ownersOf: () => ({}), epochOf: () => 1, extentOf: (m) => blocks.extentOf(m),
    blockOf: (m, x, y) => blocks.blockOf(m, x, y), givenAway: () => false,
  };
  const answer: any = buildClusterDebug(source, { location: { map: "huge", position: { x: 0, y: 0 } } });
  expect(answer.cells.length).toBeLessThanOrEqual(MAX_DEBUG_CELLS);
  expect(answer.cells.length).toBe(answer.blocksX * answer.blocksY);
});

test("the rate limit allows one answer per connection per second and tracks connections apart", () => {
  const limit = new DebugRateLimit();
  const one = {};
  const two = {};
  expect(limit.allow(one, 10_000)).toBe(true);
  expect(limit.allow(one, 10_000 + DEBUG_MIN_GAP_MS - 1)).toBe(false);
  expect(limit.allow(two, 10_000 + 5)).toBe(true);
  // a refused request does not push the next allowed time out
  expect(limit.allow(one, 10_000 + DEBUG_MIN_GAP_MS)).toBe(true);
  expect(limit.allow(one, 10_000 + DEBUG_MIN_GAP_MS + 1)).toBe(false);
});

test("outside cluster mode the live source is null, so the handler answers { cluster: false }", async () => {
  const { clusterDebugSource } = await import("../cluster/index");
  expect(clusterDebugSource()).toBeNull();
});

test("the packet is registered, gated by the rate limit in the handler, and is built only from the debug answer", () => {
  const read = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
  expect(read("socket/types.ts")).toContain('CLUSTER_DEBUG: "CLUSTER_DEBUG"');
  expect(read("socket/types.ts")).toContain('CLUSTER_DEBUG_DATA: "CLUSTER_DEBUG_DATA"');
  const editors = read("socket/handlers/editors.ts");
  const at = editors.indexOf('case "CLUSTER_DEBUG"');
  expect(at).toBeGreaterThan(0);
  const body = editors.slice(at, at + 400);
  expect(body.indexOf("debugRateLimit.allow(wt)")).toBeGreaterThan(-1);
  expect(body.indexOf("debugRateLimit.allow(wt)")).toBeLessThan(body.indexOf("sendPacket"));
  expect(editors).toContain('"CLUSTER_DEBUG", "TOGGLE_QUEST_EDITOR"');
  expect(read("socket/packet_manager.ts")).toContain('type: "CLUSTER_DEBUG_DATA"');
});
