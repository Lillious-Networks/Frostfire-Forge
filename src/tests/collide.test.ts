import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "fs";
import { databaseModule } from "./setup";

mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const { default: player, clearMapCache } = await import("../systems/player");
const { default: assetCache } = await import("../services/assetCache");
const { loadWorldMaps, getWorldMap, warpsAndGraveyardsOf } = await import("../modules/worldmaps");

type Warp = { name?: string; map: string; x: number; y: number; position: { x: number; y: number }; size: { width: number; height: number } };

// The maps folder of a real world (one of the Mystika game's), for the two tests of the real overworld below. Not in
// this repository: set MYSTIKA_MAPS_DIR to run them; without it they skip.
const WORLD_DIR = process.env.MYSTIKA_MAPS_DIR ?? "";
const OVERWORLD_MANIFEST = `${WORLD_DIR}/overworld.world/manifest.json`;

/** Warps as the old code kept them: a record keyed by name, else by index. */
function recordOf(raw: unknown): Record<string, Warp> {
  return (Array.isArray(raw)
    ? Object.fromEntries((raw as Warp[]).map((warp, idx) => [warp.name ?? String(idx), warp]))
    : (raw || {})) as Record<string, Warp>;
}

/** The pre-change loop over the record, warps only (a map with no solid tiles has nothing else to answer). */
function reference(raw: unknown, x: number, y: number, w: number, h: number) {
  const warps = recordOf(raw);
  for (const key in warps) {
    const warp = warps[key];
    if (
      x + w / 2 > warp.position.x &&
      x - w / 2 < warp.position.x + warp.size.width &&
      y + h > warp.position.y &&
      y < warp.position.y + warp.size.height
    ) {
      return { value: true, reason: "warp_collision", warp: { map: warp.map, x: warp.x, y: warp.y } };
    }
  }
  return { value: false, reason: "no_collision" };
}

// Seeded so a failure repeats
let seed = 12345;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

/** 450 warps: most named (some names repeat), some unnamed so they take their index, many overlapping. */
function syntheticWarps(): Warp[] {
  const list: Warp[] = [];
  for (let i = 0; i < 450; i++) {
    const unnamed = i % 5 === 0;
    list.push({
      ...(unnamed ? {} : { name: i % 7 === 0 ? `dup${i % 3}` : i % 11 === 0 ? String(900 - i) : `warp_${i}` }),
      map: `dest${i}`,
      x: i,
      y: i * 2,
      position: { x: Math.floor(rand() * 2000), y: Math.floor(rand() * 2000) },
      size: { width: 16 + Math.floor(rand() * 200), height: 16 + Math.floor(rand() * 200) },
    });
  }
  return list;
}

const SIZES = [{ width: 32, height: 32 }, { width: 16, height: 48 }, { width: 64, height: 64 }, {}];

let mapProperties: any[] = [];
const spies: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
  spies.push(
    spyOn(assetCache, "get").mockImplementation((async (key: string) => (key === "mapProperties" ? mapProperties : [])) as any),
    spyOn(assetCache, "getNested").mockImplementation((async () => [4096, 4096, 0, 4096 * 4096]) as any)
  );
});
afterAll(() => spies.forEach((s) => s.mockRestore()));

async function load(name: string, warps: unknown) {
  clearMapCache(name);
  mapProperties = [{ name: `${name}.json`, warps, tileWidth: 32, tileHeight: 32 }];
  await player.preloadMapCollision(name);
}

function compare(name: string, raw: unknown, x: number, y: number, size: { width?: number; height?: number }) {
  const got = player.checkCollisionSync(name, { x, y } as any, size as any);
  const want = reference(raw, x, y, size.width || 32, size.height || 32);
  expect(got).toEqual(want as any);
}

function sweep(name: string, raw: unknown, span: number) {
  const warps = Object.values(recordOf(raw));
  for (const size of SIZES) {
    const w = size.width || 32;
    const h = size.height || 32;
    for (let i = 0; i < 2000; i++) compare(name, raw, rand() * span, rand() * span, size);
    for (const warp of warps) {
      const { x, y } = warp.position;
      const { width, height } = warp.size;
      for (const px of [x - w / 2, x - w / 2 + 1, x + width + w / 2, x + width + w / 2 - 1, x, x + width / 2]) {
        for (const py of [y - h, y - h + 1, y + height, y + height - 1, y, y + height / 2]) compare(name, raw, px, py, size);
      }
    }
  }
}

describe("checkCollisionSync with the flat warp list", () => {
  test("synthetic map of 450 warps answers as the for...in loop did", async () => {
    const raw = syntheticWarps();
    await load("collide_syn", raw);
    sweep("collide_syn", raw, 2400);
  }, 120000);

  test("warps given as a record (integer-like and string keys mixed) keep for...in order", async () => {
    const raw: Record<string, Warp> = {};
    const mk = (n: number): Warp => ({ map: `m${n}`, x: n, y: n, position: { x: 100, y: 100 }, size: { width: 100, height: 100 } });
    raw["zeta"] = mk(1);
    raw["10"] = mk(2);
    raw["alpha"] = mk(3);
    raw["2"] = mk(4);
    raw["1"] = mk(5);
    await load("collide_rec", raw);
    // for...in yields 1, 2, 10, zeta, alpha: the warp keyed "1" wins an overlap
    const hit = player.checkCollisionSync("collide_rec", { x: 150, y: 150 } as any, {} as any) as any;
    expect(hit.warp.map).toBe("m5");
    sweep("collide_rec", raw, 300);
  }, 120000);

  test("overlapping warps: the first in for...in order wins", async () => {
    const mk = (map: string): Warp => ({ name: map, map, x: 1, y: 2, position: { x: 0, y: 0 }, size: { width: 100, height: 100 } });
    await load("collide_ov", [mk("first"), mk("second"), mk("third")]);
    const hit = player.checkCollisionSync("collide_ov", { x: 50, y: 50 } as any, {} as any) as any;
    expect(hit.reason).toBe("warp_collision");
    expect(hit.warp.map).toBe("first");
    // an index-keyed overlap: unnamed warps are keyed 0, 1, 2 and enumerate in that order
    const un = (map: string): Warp => ({ map, x: 1, y: 2, position: { x: 0, y: 0 }, size: { width: 100, height: 100 } });
    await load("collide_ov2", [un("a"), un("b")]);
    expect((player.checkCollisionSync("collide_ov2", { x: 50, y: 50 } as any, {} as any) as any).warp.map).toBe("a");
  });

  test("an entry rebuilt after a change uses the new warps", async () => {
    const one: Warp = { name: "w", map: "old", x: 1, y: 1, position: { x: 0, y: 0 }, size: { width: 50, height: 50 } };
    await load("collide_re", [one]);
    expect((player.checkCollisionSync("collide_re", { x: 20, y: 20 } as any, {} as any) as any).warp.map).toBe("old");
    // an editor save or a world adopt: the warps change, the cache is cleared, the next entry is built from them
    mapProperties = [{ name: "collide_re.json", warps: [{ ...one, map: "new", position: { x: 500, y: 500 } }], tileWidth: 32, tileHeight: 32 }];
    clearMapCache("collide_re");
    await player.preloadMapCollision("collide_re");
    expect(player.checkCollisionSync("collide_re", { x: 20, y: 20 } as any, {} as any)).toEqual({ value: false, reason: "no_collision" } as any);
    expect((player.checkCollisionSync("collide_re", { x: 520, y: 520 } as any, {} as any) as any).warp.map).toBe("new");
  });

  const real = WORLD_DIR !== "" && fs.existsSync(OVERWORLD_MANIFEST);
  (real ? test : test.skip)("the real overworld (tile path) answers as the for...in loop did", async () => {
    const manifest = JSON.parse(fs.readFileSync(OVERWORLD_MANIFEST, "utf8"));
    const raw = warpsAndGraveyardsOf(manifest).warps ?? [];
    expect(raw.length).toBeGreaterThan(0);
    await load("collide_real", raw);
    sweep("collide_real", raw, Math.max(manifest.width * manifest.tilewidth, 1000));
  }, 120000);

  (real ? test : test.skip)("the real overworld as a loaded world (world path, tile collision included)", async () => {
    const manifest = JSON.parse(fs.readFileSync(OVERWORLD_MANIFEST, "utf8"));
    const raw = warpsAndGraveyardsOf(manifest).warps ?? [];
    loadWorldMaps(WORLD_DIR, new Set());
    const world = getWorldMap("overworld");
    if (!world) return;
    world.properties = { name: "overworld.json", warps: raw, tileWidth: world.tileWidth, tileHeight: world.tileHeight } as any;
    clearMapCache("overworld");
    const span = world.width * world.tileWidth;
    for (let i = 0; i < 3000; i++) {
      const x = rand() * span;
      const y = rand() * span;
      const got = player.checkCollisionSync("overworld", { x, y } as any, {} as any) as any;
      const want = reference(raw, x, y, 32, 32);
      // a position outside every warp falls through to the tiles, which this change leaves alone
      if (want.value) expect(got).toEqual(want as any);
      else expect(got.reason).not.toBe("warp_collision");
    }
    for (const warp of Object.values(recordOf(raw)).slice(0, 450)) {
      const x = warp.position.x - 16 + 1;
      const y = warp.position.y - 32 + 1;
      const got = player.checkCollisionSync("overworld", { x, y } as any, {} as any) as any;
      const want = reference(raw, x, y, 32, 32);
      if (want.value) expect(got).toEqual(want as any);
    }
  }, 120000);
});
