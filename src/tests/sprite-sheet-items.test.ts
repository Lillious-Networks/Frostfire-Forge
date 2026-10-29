import { afterAll, expect, setSystemTime, test } from "bun:test";
import { standInFor } from "./setup";

// The limit fix wave, fix 3(b): the item sheets the sprite data is built with are kept in memory, not read from the
// cache (Redis on a cluster node) on every miss; a write to the items through the cache drops them at once, and
// otherwise they are read again after a few seconds (a node's edit is not heard on another node).

// ---- the cache tells who is listening when a key is written

test("assetCache.onChange: a write, a removal or a clear of the key is heard; other keys are not; a listener that throws harms nothing", async () => {
  const saved = process.env.CACHE;
  process.env.CACHE = "memory";
  // A fresh copy of the module: other tests put a stand-in in place of the shared one.
  const fresh = "../services/assetCache.ts?onchange";
  const { default: cache } = (await import(fresh)) as typeof import("../services/assetCache");
  process.env.CACHE = saved;
  if (saved === undefined) delete process.env.CACHE;
  const heard: string[] = [];
  cache.onChange("items", () => { heard.push("items"); });
  cache.onChange("items", () => { throw new Error("a listener that fails"); });
  cache.onChange("mounts", () => { heard.push("mounts"); });
  await cache.add("items", [{ name: "a" }]);
  await cache.set("items", [{ name: "b" }]);
  expect(heard).toEqual(["items", "items"]);
  // The write itself was made, whatever the listener did.
  expect(await cache.get("items")).toEqual([{ name: "b" }]);
  await cache.set("spells", []);
  expect(heard).toEqual(["items", "items"]);
  await cache.remove("items");
  expect(heard).toEqual(["items", "items", "items"]);
  await cache.clear();
  expect(heard.sort()).toEqual(["items", "items", "items", "items", "mounts"]);
});

// ---- the sheets

let items: any[] = [{ name: "Iron Helm", sprite_sheet: "helm_v1" }];
let reads = 0;
let holdRead: Promise<void> | null = null;
let failNext = false;
const listeners: Array<() => void> = [];

await standInFor("../services/assetCache", () => ({
  default: {
    get: async (key: string) => {
      if (key !== "items") return null;
      reads++;
      if (holdRead) await holdRead;
      if (failNext) { failNext = false; throw new Error("cache down"); }
      return items;
    },
    onChange: (key: string, listener: () => void) => { if (key === "items") listeners.push(listener); },
  },
}));
// A copy of its own: the module keeps the sheets, and another test file may have loaded the shared one.
const own = "../modules/spriteSheetManager.ts?items";
const sprites = (await import(own)) as typeof import("../modules/spriteSheetManager");

const helm = async (animation = "walk_down", name = "Iron Helm") =>
  (await sprites.getPlayerSpriteSheetData(animation, { helmet: name } as any)).armorHelmetSprite?.name;
const write = (list: any[]) => { items = list; for (const listener of listeners) listener(); };

afterAll(() => setSystemTime());
/** Moves the clock on (the sheets are kept for 5 s); it stays moved on for the next test, so what it kept has expired. */
const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));

test("the sheets are read once for any number of cache misses, and the player's sprite uses the chosen sheet", async () => {
  later(60_000);
  reads = 0;
  expect(await helm("walk_down")).toBe("helm_v1");
  expect(await helm("walk_up")).toBe("helm_v1");
  expect(await helm("idle_down")).toBe("helm_v1");
  // An item with no sheet chosen is drawn with the sheet named after it.
  expect(await helm("walk_down", "Plain Hat")).toBe("plain hat");
  expect(reads).toBe(1);
  // No equipment: no sheets needed at all.
  await sprites.getPlayerSpriteSheetData("walk_down", null);
  expect(reads).toBe(1);
});

test("a write to the items drops the sheets: the next sprite is built from the new list, read once", async () => {
  later(60_000);
  reads = 0;
  expect(await helm()).toBe("helm_v1");
  write([{ name: "Iron Helm", sprite_sheet: "helm_v2" }]);
  expect(await helm()).toBe("helm_v2");
  expect(await helm("walk_up")).toBe("helm_v2");
  expect(reads).toBe(2);
});

test("with no write heard, the sheets are read again after 5 s", async () => {
  later(60_000);
  reads = 0;
  await helm();
  later(4900);
  await helm();
  expect(reads).toBe(1);
  // Another node edited the item: its write did not come through this cache.
  items = [{ name: "Iron Helm", sprite_sheet: "helm_v3" }];
  later(200);
  expect(await helm()).toBe("helm_v3");
  expect(reads).toBe(2);
});

test("lookups at the same time share one read", async () => {
  later(60_000);
  reads = 0;
  const names = await Promise.all([helm("a"), helm("b"), helm("c"), helm("d")]);
  expect(names).toEqual(["helm_v3", "helm_v3", "helm_v3", "helm_v3"]);
  expect(reads).toBe(1);
});

test("a write that lands while the sheets are being read is not overtaken by that read", async () => {
  later(60_000);
  reads = 0;
  let release!: () => void;
  holdRead = new Promise<void>((resolve) => { release = resolve; });
  const stale = helm();
  await Promise.resolve();
  await Promise.resolve();
  write([{ name: "Iron Helm", sprite_sheet: "helm_v4" }]);
  holdRead = null;
  release();
  await stale;
  // The read that began before the write is not kept as the sheets: the next lookup reads the list again.
  expect(await helm()).toBe("helm_v4");
  expect(reads).toBe(2);
  expect(await helm()).toBe("helm_v4");
  expect(reads).toBe(2);
});

test("a read that fails is not kept: the next lookup reads again", async () => {
  later(60_000);
  reads = 0;
  failNext = true;
  await expect(helm()).rejects.toThrow("cache down");
  expect(await helm()).toBe("helm_v4");
  expect(reads).toBe(2);
});
