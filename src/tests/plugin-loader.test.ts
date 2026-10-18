import { describe, expect, test } from "bun:test";
import path from "node:path";
import { isInside } from "../modules/plugin_loader";

describe("plugin entry containment", () => {
  const dir = path.resolve("plugins", "demo");

  test("a file in the plugin folder or below it is inside", () => {
    expect(isInside(dir, path.join(dir, "index.ts"))).toBe(true);
    expect(isInside(dir, path.join(dir, "src", "main.ts"))).toBe(true);
    expect(isInside(dir, path.join(dir, "..bundle.ts"))).toBe(true);
  });

  test("the folder itself, its parent and other folders are not", () => {
    expect(isInside(dir, dir)).toBe(false);
    expect(isInside(dir, path.resolve(dir, "..", "other", "index.ts"))).toBe(false);
    expect(isInside(dir, path.resolve(dir, "..", "..", "socket", "server.ts"))).toBe(false);
    expect(isInside(dir, path.resolve("/elsewhere/evil.ts"))).toBe(false);
  });
});
