import { describe, expect, test } from "bun:test";
import { fromRows, MAX_CHANGES, mayEditFootprints, readFootprintChanges } from "../systems/footprintrules";

describe("tile footprints", () => {
  test("only map savers may change them", () => {
    expect(mayEditFootprints(["server.admin"])).toBe(true);
    expect(mayEditFootprints(["server.*"])).toBe(true);
    expect(mayEditFootprints(["tools.tile_editor"])).toBe(false);
  });

  test("a save is made tidy: tileset and colour in lower case, each tile once and in order", () => {
    const read = readFootprintChanges({ changes: [{ tileset: " Environment ", ids: [5, 3, 5], print: { style: "Boot", color: "#AABBCC", opacity: 0.456, fade: 30 } }] });
    expect(read).toEqual({ changes: [{ tileset: "environment", ids: [3, 5], print: { style: "boot", color: "#aabbcc", opacity: 0.46, fade: 30 } }] });
  });

  test("null takes the prints away", () => {
    expect(readFootprintChanges({ changes: [{ tileset: "sand", ids: [1], print: null }] })).toEqual({ changes: [{ tileset: "sand", ids: [1], print: null }] });
  });

  test("a bad style, colour, darkness or fade time is refused", () => {
    const one = (print: unknown) => "error" in readFootprintChanges({ changes: [{ tileset: "sand", ids: [1], print }] });
    expect(one({ style: "hoof", color: "#000000", opacity: 0.5, fade: 10 })).toBe(true);
    expect(one({ style: "boot", color: "red", opacity: 0.5, fade: 10 })).toBe(true);
    expect(one({ style: "boot", color: "#000000", opacity: 0, fade: 10 })).toBe(true);
    expect(one({ style: "boot", color: "#000000", opacity: 0.5, fade: 0 })).toBe(true);
    expect(one({ style: "boot", color: "#000000", opacity: 0.5, fade: 1.5 })).toBe(true);
    expect(one({ style: "hole", color: "#ffffff", opacity: 1, fade: 600 })).toBe(false);
  });

  test("bad tilesets, tile ids and too many changes are refused", () => {
    expect("error" in readFootprintChanges({ changes: [] })).toBe(true);
    expect("error" in readFootprintChanges({ changes: [{ tileset: "../x", ids: [1], print: null }] })).toBe(true);
    expect("error" in readFootprintChanges({ changes: [{ tileset: "sand", ids: [-1], print: null }] })).toBe(true);
    const many = Array.from({ length: MAX_CHANGES + 1 }, () => ({ tileset: "sand", ids: [1], print: null }));
    expect("error" in readFootprintChanges({ changes: many })).toBe(true);
  });

  test("rows become the list; a row that is not a valid print is left out", () => {
    const list = fromRows([
      { tileset: "Sand", tile_id: 4, style: "bare", color: "#806040", opacity: 0.5, fade_s: 20 },
      { tileset: "sand", tile_id: 5, style: "nope", color: "#806040", opacity: 0.5, fade_s: 20 },
    ]);
    expect(list).toEqual({ sand: { "4": { style: "bare", color: "#806040", opacity: 0.5, fade: 20 } } });
  });
});
