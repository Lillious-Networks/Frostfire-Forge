import { describe, expect, test } from "bun:test";
import {
  applyFishingChanges, facingToward, fishingSpotInChunk, fishingSpotInMap, MAX_CATCHES, readFishingChanges, rollCatch, tilesetKey,
  type FishingTiles,
} from "../systems/fishing/catches";

const MATERIALS = ["Trout", "Salmon", "Old Boot"];
const itemName = (name: string) => MATERIALS.find((m) => m.toLowerCase() === name.toLowerCase()) ?? null;

describe("fishing saves", () => {
  test("a save is made tidy: tileset in lower case, each tile once and in order, items as the list spells them", () => {
    const read = readFishingChanges({ changes: [{ tileset: " Environment ", ids: [5, 3, 5], catches: [{ item: "trout", chance: 60.005 }, { item: "SALMON", chance: 40 }] }] }, itemName);
    expect(read).toEqual({ changes: [{ tileset: "environment", ids: [3, 5], catches: [{ item: "Trout", chance: 60.01 }, { item: "Salmon", chance: 40 }] }] });
  });

  test("null makes tiles not fishable", () => {
    expect(readFishingChanges({ changes: [{ tileset: "water", ids: [1], catches: null }] }, itemName)).toEqual({ changes: [{ tileset: "water", ids: [1], catches: null }] });
  });

  test("what is not a material item, a twice-listed item, a chance out of range or too many catches is refused", () => {
    const one = (catches: unknown) => readFishingChanges({ changes: [{ tileset: "water", ids: [1], catches }] }, itemName);
    expect("error" in one([{ item: "Iron Sword", chance: 50 }])).toBe(true);
    expect("error" in one([{ item: "Trout", chance: 50 }, { item: "trout", chance: 50 }])).toBe(true);
    expect("error" in one([{ item: "Trout", chance: 0 }])).toBe(true);
    expect("error" in one([{ item: "Trout", chance: 101 }])).toBe(true);
    expect("error" in one([])).toBe(true);
    expect("error" in one(Array.from({ length: MAX_CATCHES + 1 }, () => ({ item: "Trout", chance: 1 })))).toBe(true);
  });

  test("bad tilesets and tile ids are refused", () => {
    expect("error" in readFishingChanges({ changes: [] }, itemName)).toBe(true);
    expect("error" in readFishingChanges({ changes: [{ tileset: "../x", ids: [1], catches: null }] }, itemName)).toBe(true);
    expect("error" in readFishingChanges({ changes: [{ tileset: "water", ids: [-1], catches: null }] }, itemName)).toBe(true);
    expect("error" in readFishingChanges({ changes: [{ tileset: "water", ids: [1.5], catches: null }] }, itemName)).toBe(true);
  });

  test("changes are applied in order, and an emptied tileset goes away", () => {
    const base: FishingTiles = { water: { "1": [{ item: "Trout", chance: 100 }] } };
    const next = applyFishingChanges(base, [
      { tileset: "water", ids: [2], catches: [{ item: "Salmon", chance: 100 }] },
      { tileset: "water", ids: [1, 2], catches: null },
      { tileset: "sea", ids: [7], catches: [{ item: "Old Boot", chance: 5 }] },
    ]);
    expect(next).toEqual({ sea: { "7": [{ item: "Old Boot", chance: 5 }] } });
    expect(base.water!["1"]).toEqual([{ item: "Trout", chance: 100 }]);
  });
});

describe("rolling a catch", () => {
  const list = [{ item: "Trout", chance: 75 }, { item: "Old Boot", chance: 25 }];
  test("each catch takes its share", () => {
    expect(rollCatch(list, 0)).toBe("Trout");
    expect(rollCatch(list, 0.74)).toBe("Trout");
    expect(rollCatch(list, 0.76)).toBe("Old Boot");
    expect(rollCatch(list, 1)).toBe("Old Boot");
  });
  test("chances that do not add up to 100 count as shares of their sum", () => {
    const small = [{ item: "Trout", chance: 1 }, { item: "Salmon", chance: 3 }];
    expect(rollCatch(small, 0.2)).toBe("Trout");
    expect(rollCatch(small, 0.3)).toBe("Salmon");
  });
  test("an empty list gives nothing", () => {
    expect(rollCatch([], 0.5)).toBeNull();
  });
});

describe("finding the fishable tile", () => {
  const tiles: FishingTiles = { water: { "3": [{ item: "Trout", chance: 100 }] }, lily: { "0": [{ item: "Salmon", chance: 100 }] } };
  const tilesets = [
    { firstgid: 1, image: "../tilesets/Water.png", name: "w" },
    { firstgid: 101, image: "../tilesets/lily.png", name: "l" },
  ];

  test("a tileset is keyed by its picture's name", () => {
    expect(tilesetKey(tilesets[0])).toBe("water");
    expect(tilesetKey({ name: "Inside" })).toBe("inside");
  });

  test("the topmost fishable tile of a Tiled map wins; collision and other tiles are passed over", () => {
    const map = {
      width: 2, height: 1, tilewidth: 16, tileheight: 16, tilesets,
      layers: [
        { type: "tilelayer", name: "Ground", width: 2, height: 1, data: [4, 4] },
        { type: "group", layers: [{ type: "tilelayer", name: "Details", width: 2, height: 1, data: [101, 50] }] },
        { type: "tilelayer", name: "Collisions", width: 2, height: 1, data: [4, 4] },
      ],
    };
    expect(fishingSpotInMap(map, 5, 5, tiles)).toEqual({ tileset: "lily", id: 0, catches: tiles.lily!["0"]! });
    expect(fishingSpotInMap(map, 20, 5, tiles)).toEqual({ tileset: "water", id: 3, catches: tiles.water!["3"]! });
    expect(fishingSpotInMap(map, 40, 5, tiles)).toBeNull();
  });

  test("flipped tiles are read as the tile", () => {
    const map = { width: 1, height: 1, tilewidth: 16, tileheight: 16, tilesets, layers: [{ type: "tilelayer", name: "Ground", width: 1, height: 1, data: [(4 | 0x80000000) >>> 0] }] };
    expect(fishingSpotInMap(map, 1, 1, tiles)?.tileset).toBe("water");
  });

  test("in a world chunk the highest zIndex wins", () => {
    const chunk = { width: 2, height: 2, layers: [
      { name: "Upper", zIndex: 5, data: [101, 0, 0, 0] },
      { name: "Ground", zIndex: 0, data: [4, 4, 0, 0] },
    ] };
    expect(fishingSpotInChunk(chunk, 0, 0, tilesets, tiles)?.tileset).toBe("lily");
    expect(fishingSpotInChunk(chunk, 1, 0, tilesets, tiles)?.tileset).toBe("water");
    expect(fishingSpotInChunk(chunk, 0, 1, tilesets, tiles)).toBeNull();
    expect(fishingSpotInChunk(chunk, 2, 0, tilesets, tiles)).toBeNull();
  });
});

test("a player faces the way they cast", () => {
  expect(facingToward(10, 0)).toBe("right");
  expect(facingToward(0, 10)).toBe("down");
  expect(facingToward(-10, -10)).toBe("upleft");
  expect(facingToward(0, 0)).toBe("down");
});
