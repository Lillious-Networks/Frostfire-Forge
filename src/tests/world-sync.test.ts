import { afterAll, expect, test } from "bun:test";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { checkWorldChanges, getWorldMap, loadWorldMaps, syncWorldMaps, warpsAndGraveyardsOf } from "../modules/worldmaps";

// A world of one 64 x 64 chunk, as the asset server holds it: a manifest and two bitsets (the game server never
// gets the packs). `blocked` lists the tiles set in the collision bitset.
function writeWorld(dir: string, blocked: [number, number][], warpX: number): void {
  const bits = (role: number, tiles: [number, number][]) => {
    const bytes = new Uint8Array(32 + 512);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x42574646, true);
    view.setUint16(4, 1, true);
    view.setUint16(6, 32, true);
    view.setUint16(8, 64, true);
    view.setUint16(10, 1, true);
    view.setUint16(12, 1, true);
    view.setUint16(14, role, true);
    for (const [x, y] of tiles) bytes[32 + ((y * 64 + x) >> 3)]! |= 1 << ((y * 64 + x) & 7);
    const hash = BigInt.asUintN(64, BigInt(Bun.hash.xxHash64(bytes.subarray(32))));
    view.setBigUint64(16, hash, true);
    return { bytes, hash: hash.toString(16).padStart(16, "0") };
  };
  const collision = bits(1, blocked), nopvp = bits(2, []);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "collision.bits"), collision.bytes);
  fs.writeFileSync(path.join(dir, "nopvp.bits"), nopvp.bytes);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    format: "ffworld", formatVersion: 1, id: "synctest", width: 64, height: 64, tilewidth: 16, tileheight: 16, chunkSize: 64,
    layers: [{ id: 1, name: "Ground", type: "tilelayer", tileIndex: 0, role: "tiles", visible: true }, { id: 2, name: "Warps", type: "objectgroup", visible: true }],
    tilesets: [],
    bitsets: { collision: { file: "collision.bits", hash: collision.hash }, nopvp: { file: "nopvp.bits", hash: nopvp.hash } },
    objects: [{ id: 1, layer: "Warps", name: "W1", type: "warp", x: warpX, y: 32, width: 32, height: 16, properties: [{ name: "map", type: "string", value: "town" }, { name: "x", type: "int", value: 5 }, { name: "y", type: "int", value: 6 }] }],
  }));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "world-sync-"));
const remote = path.join(root, "remote", "synctest.world");
const local = path.join(root, "local");
fs.mkdirSync(local, { recursive: true });
const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(path.join(remote, file))).digest("hex");

// The asset server's two world routes, serving `remote`
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as any;
    if (url.pathname === "/world-list") {
      const files = Object.fromEntries(["manifest.json", "collision.bits", "nopvp.bits"].map(f => [f, sha256(f)]));
      return Response.json({ success: true, worlds: [{ id: "synctest", name: "synctest.json", files }] });
    }
    if (url.pathname === "/world-file") return new Response(fs.readFileSync(path.join(remote, body.file)));
    return new Response("not found", { status: 404 });
  },
});
const env = { internal: process.env.ASSET_SERVER_INTERNAL_URL };
process.env.ASSET_SERVER_INTERNAL_URL = `http://localhost:${server.port}`;
afterAll(() => {
  server.stop(true);
  if (env.internal === undefined) delete process.env.ASSET_SERVER_INTERNAL_URL;
  else process.env.ASSET_SERVER_INTERNAL_URL = env.internal;
  fs.rmSync(root, { recursive: true, force: true });
});

test("a world changed on the asset server is taken in without a restart", async () => {
  writeWorld(remote, [[1, 1]], 100);
  expect(await syncWorldMaps(local)).toEqual(["synctest"]);
  loadWorldMaps(local, new Set());
  const world = getWorldMap("synctest")!;
  world.properties = { name: world.name, warps: null, graveyards: null, version: "0" } as any;
  const collision = world.collision;
  expect(collision.isSet(1, 1)).toBe(1);

  // Nothing changed: nothing to do, and the local files are not hashed again
  expect(await checkWorldChanges()).toEqual([]);

  // Saved from outside (the Tiled extension): a wall moved and the warp moved
  writeWorld(remote, [[2, 2]], 200);
  const changed = await checkWorldChanges();
  expect(changed.map(w => w.id)).toEqual(["synctest"]);
  // the same bitset object everything holds now reads the new bits
  expect(world.collision).toBe(collision);
  expect(collision.isSet(1, 1)).toBe(0);
  expect(collision.isSet(2, 2)).toBe(1);
  expect(world.properties!.warps).toEqual([{ name: "W1", map: "town", x: 5, y: 6, position: { x: 200, y: 32 }, size: { width: 32, height: 16 }, layer: "Warps" }]);
  expect(world.properties!.version).not.toBe("0");

  expect(await checkWorldChanges()).toEqual([]);
});

test("warps and graveyards of a manifest, by type or by layer, as the loader reads them", () => {
  const manifest = {
    objects: [
      { id: 1, layer: "Graveyard", name: "G1", x: 10.7, y: 20.2 },
      { id: 2, layer: "Stuff", name: "W1", type: "warp", x: 1, y: 2, width: 3, height: 4, properties: [{ name: "map", value: "a" }, { name: "x", value: 1 }, { name: "y", value: 2 }] },
      { id: 3, layer: "Warps", name: "broken" },
    ],
  };
  const { warps, graveyards } = warpsAndGraveyardsOf(manifest);
  expect(graveyards).toEqual([{ name: "G1", position: { x: 10, y: 20 }, layer: "Graveyard" }]);
  expect(warps!.map(w => w.name)).toEqual(["W1"]);
  expect(warpsAndGraveyardsOf({ objects: [] })).toEqual({ warps: null, graveyards: null });
});
