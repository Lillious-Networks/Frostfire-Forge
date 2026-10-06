import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { removeUnlistedMaps, removeUnlistedWorlds } from "../modules/mapmirror";

let dir: string;

function file(name: string, content = "{}") {
  fs.writeFileSync(path.join(dir, name), content);
}

function world(id: string) {
  const worldDir = path.join(dir, `${id}.world`);
  fs.mkdirSync(path.join(worldDir, "packs"), { recursive: true });
  fs.writeFileSync(path.join(worldDir, "manifest.json"), "{}");
  fs.writeFileSync(path.join(worldDir, "collision.bits"), "bits");
}

const entries = () => fs.readdirSync(dir).sort();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-map-mirror-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("removeUnlistedMaps", () => {
  test("removes map files the asset server did not list and keeps the rest", () => {
    file("developer.json");
    file("main.json");
    file("overworld.json");

    const removed = removeUnlistedMaps(dir, ["developer.json"]);

    expect(removed.sort()).toEqual(["main.json", "overworld.json"]);
    expect(entries()).toEqual(["developer.json"]);
  });

  test("leaves the checksum cache, other files and world directories alone", () => {
    file("developer.json");
    file(".map-checksums-cache.json");
    file("notes.txt", "keep");
    world("overworld");

    expect(removeUnlistedMaps(dir, ["developer.json"])).toEqual([]);
    expect(entries()).toEqual([".map-checksums-cache.json", "developer.json", "notes.txt", "overworld.world"]);
  });

  test("does not treat a directory named like a map as a map", () => {
    file("developer.json");
    fs.mkdirSync(path.join(dir, "old.json"));

    expect(removeUnlistedMaps(dir, ["developer.json"])).toEqual([]);
    expect(entries()).toEqual(["developer.json", "old.json"]);
  });

  test("removes nothing when the asset server listed no maps at all", () => {
    file("developer.json");
    file("main.json");

    expect(removeUnlistedMaps(dir, [])).toEqual([]);
    expect(entries()).toEqual(["developer.json", "main.json"]);
  });

  test("answers an empty list for a folder that does not exist", () => {
    expect(removeUnlistedMaps(path.join(dir, "missing"), ["developer.json"])).toEqual([]);
  });
});

describe("removeUnlistedWorlds", () => {
  test("removes world directories the asset server did not list, with their contents", () => {
    world("overworld");
    world("underworld");
    world("overworld-big");
    world("world-a-2x2-v54");

    const removed = removeUnlistedWorlds(dir, ["overworld", "underworld"]);

    expect(removed.sort()).toEqual(["overworld-big", "world-a-2x2-v54"]);
    expect(entries()).toEqual(["overworld.world", "underworld.world"]);
  });

  test("leaves map files and files that only look like a world alone", () => {
    world("overworld");
    file("developer.json");
    file("stray.world", "not a directory");

    expect(removeUnlistedWorlds(dir, ["overworld"])).toEqual([]);
    expect(entries()).toEqual(["developer.json", "overworld.world", "stray.world"]);
  });

  test("removes every local world when the asset server has none", () => {
    world("overworld");
    file("developer.json");

    expect(removeUnlistedWorlds(dir, [])).toEqual(["overworld"]);
    expect(entries()).toEqual(["developer.json"]);
  });
});
