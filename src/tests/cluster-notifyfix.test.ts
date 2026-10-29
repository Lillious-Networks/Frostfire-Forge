import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packetManager } from "../socket/packet_manager";
import { BlockTable } from "../cluster/blocks";
import { MemoryStore } from "../cluster/memorystore";
import { databaseModule } from "./setup";
mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));
import { buildClusterDebug, MAX_DEBUG_CELLS, type ClusterDebugSource } from "../cluster/nodedebug";

// The kick paths run inside the login handler and the disconnect listener, which need a database, so the call
// sites are checked as source text; the part that can be driven (what packetManager hands back, what the overlay
// answers) is checked by behaviour.

const socket = join(import.meta.dir, "..", "socket");
const code = (file: string) => readFileSync(join(socket, file), "utf8").replace(/\r\n/g, "\n");

test("packetManager.notify returns an array of frames, which a one-frame send cannot take", () => {
  const frames = packetManager.notify({ message: "x" });
  expect(Array.isArray(frames)).toBe(true);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames[0]).toBeInstanceOf(Uint8Array);
});

test("no .send( is handed a packetManager array in the socket code", () => {
  for (const file of ["receiver.ts", "server.ts"]) {
    expect(code(file)).not.toMatch(/\.send\(\s*packetManager\./);
  }
});

test("the duplicate-login kick and the session-stolen notices go through sendPacket, before the close", () => {
  const receiver = code("receiver.ts");
  const kick = receiver.indexOf("Kicking existing session for");
  const notice = receiver.indexOf("sendPacket(p.wt, packetManager.notify({", kick);
  const close = receiver.indexOf('p.wt.close(1000, "Logged in from another location", { drain: true })', kick);
  expect(kick).toBeGreaterThan(0);
  expect(notice).toBeGreaterThan(kick);
  expect(close).toBeGreaterThan(notice);

  const server = code("server.ts");
  const stolen = [...server.matchAll(/sendPacket\(\s*(stillInCache|playerData)\.wt,\s*packetManager\.notify/g)];
  expect(stolen.length).toBe(2);
  for (const m of stolen) {
    const close = server.indexOf('.close(1000, "Logged in from another location", { drain: true })', m.index!);
    expect(close).toBeGreaterThan(m.index!);
  }
  expect(server).toMatch(/sendPacket\(row\.wt, packetManager\.notify\(\{ message: subscriptionRefusal/);
  // The save of a session another node owns now: only this connection is closed, and it drains too.
  expect(server).toContain('row.wt?.close?.(1000, "Logged in from another location", { drain: true });');
  expect(server).not.toContain('row.wt?.close?.(1000, "Logged in from another location");');
});

test("the overlay cap fits the 40 x 40 overworld and a 64 x 64 grid, and cuts a bigger grid by rows", () => {
  expect(MAX_DEBUG_CELLS).toBe(4096);
  const answer = (blocksX: number, blocksY: number): any => {
    const blocks = new BlockTable(new MemoryStore());
    blocks.useExtents([{ name: "m", blocksX, blocksY }]);
    const source: ClusterDebugSource = {
      self: () => "a", ownersOf: () => ({}), epochOf: () => 1, extentOf: (m) => blocks.extentOf(m),
      blockOf: (m, x, y) => blocks.blockOf(m, x, y), givenAway: () => false,
    };
    return buildClusterDebug(source, { location: { map: "m", position: { x: 0, y: 0 } } });
  };
  const world = answer(40, 40);
  expect(world.cells.length).toBe(1600);
  expect(world.blocksY).toBe(40);
  const full = answer(64, 64);
  expect(full.cells.length).toBe(4096);
  expect(answer(100, 100).cells.length).toBe(4096 - (4096 % 100));
});
