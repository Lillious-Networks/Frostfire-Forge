import { describe, expect, test } from "bun:test";
import { mayCreateMaps, readCreateMap } from "../systems/mapcreate";

const ok = { name: "Test_Map-1", kind: "map", width: 64, height: 48, infinite: true, tilesets: ["inside.png", "inside.png", "environment.png"] };

describe("new maps from the editor", () => {
  test("only map savers may make them", () => {
    expect(mayCreateMaps(["server.admin"])).toBe(true);
    expect(mayCreateMaps(["server.*"])).toBe(true);
    expect(mayCreateMaps(["tools.tile_editor"])).toBe(false);
  });

  test("a request is made tidy: the name in lower case, each tileset once", () => {
    expect(readCreateMap(ok)).toEqual({ request: { name: "test_map-1", kind: "map", width: 64, height: 48, infinite: true, tilesets: ["inside.png", "environment.png"] } });
  });

  test("a world is whole 64-tile chunks and never infinite", () => {
    expect("request" in readCreateMap({ ...ok, kind: "world", width: 1024, height: 640, infinite: false })).toBe(true);
    expect("error" in readCreateMap({ ...ok, kind: "world", width: 1000, height: 640, infinite: false })).toBe(true);
    expect("error" in readCreateMap({ ...ok, kind: "world", width: 1024, height: 640, infinite: true })).toBe(true);
  });

  test("a request that is not valid is refused with the reason", () => {
    expect("error" in readCreateMap(null)).toBe(true);
    expect("error" in readCreateMap({ ...ok, name: "../maps" })).toBe(true);
    expect("error" in readCreateMap({ ...ok, name: "has space" })).toBe(true);
    expect("error" in readCreateMap({ ...ok, kind: "cave" })).toBe(true);
    expect("error" in readCreateMap({ ...ok, width: 8 })).toBe(true);
    expect("error" in readCreateMap({ ...ok, height: 2000 })).toBe(true);
    expect("error" in readCreateMap({ ...ok, tilesets: [] })).toBe(true);
    expect("error" in readCreateMap({ ...ok, tilesets: ["../x.png"] })).toBe(true);
  });
});
