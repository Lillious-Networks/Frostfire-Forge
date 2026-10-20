import { describe, expect, test } from "bun:test";
import { MAX_CHANGES, MAX_TILE_ID, mayEditTileSounds, readTileSoundChanges } from "../systems/tilesounds";

describe("tile sounds", () => {
  test("only map savers may change them", () => {
    expect(mayEditTileSounds(["server.admin"])).toBe(true);
    expect(mayEditTileSounds(["server.*"])).toBe(true);
    expect(mayEditTileSounds(["tools.tile_editor"])).toBe(false);
    expect(mayEditTileSounds([])).toBe(false);
  });

  test("a save is made tidy: names in lower case, each tile once and in order", () => {
    const read = readTileSoundChanges({ changes: [{ tileset: " Environment ", ids: [5, 3, 5, 0], sound: "Footstep Sand" }] });
    expect(read).toEqual({ changes: [{ tileset: "environment", ids: [0, 3, 5], sound: "footstep sand" }] });
  });

  test("no sound and back to the map's own are kept apart", () => {
    const read = readTileSoundChanges({ changes: [{ tileset: "inside", ids: [1], sound: "" }, { tileset: "inside", ids: [2], sound: null }] });
    expect(read).toEqual({ changes: [{ tileset: "inside", ids: [1], sound: "" }, { tileset: "inside", ids: [2], sound: null }] });
  });

  test("a save that is not valid is refused with the reason", () => {
    expect("error" in readTileSoundChanges(null)).toBe(true);
    expect("error" in readTileSoundChanges({ changes: [] })).toBe(true);
    expect("error" in readTileSoundChanges({ changes: new Array(MAX_CHANGES + 1).fill({ tileset: "a", ids: [1], sound: "" }) })).toBe(true);
    expect("error" in readTileSoundChanges({ changes: [{ tileset: "../maps", ids: [1], sound: "" }] })).toBe(true);
    expect("error" in readTileSoundChanges({ changes: [{ tileset: "a", ids: [], sound: "" }] })).toBe(true);
    expect("error" in readTileSoundChanges({ changes: [{ tileset: "a", ids: [1.5], sound: "" }] })).toBe(true);
    expect("error" in readTileSoundChanges({ changes: [{ tileset: "a", ids: [MAX_TILE_ID], sound: "" }] })).toBe(true);
    expect("error" in readTileSoundChanges({ changes: [{ tileset: "a", ids: [1], sound: "a/b" }] })).toBe(true);
    expect("error" in readTileSoundChanges({ changes: [{ tileset: "a", ids: [1], sound: 3 }] })).toBe(true);
  });
});
