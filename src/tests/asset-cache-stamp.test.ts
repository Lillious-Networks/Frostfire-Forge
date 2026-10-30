import { describe, expect, test } from "bun:test";
import { RedisCacheService } from "../services/assetCache";

// A Redis stand-in: string keys only, and a log of the values read whole (GET of a value key).
function fakeRedis() {
  const data = new Map<string, string>();
  const reads: string[] = [];
  return {
    data,
    reads,
    async get(key: string) {
      if (!key.endsWith("#stamp")) reads.push(key);
      return data.get(key) ?? null;
    },
    async set(key: string, value: string) {
      data.set(key, value);
    },
    async send(cmd: string, args: string[]) {
      switch (cmd) {
        case "MSET":
          for (let i = 0; i < args.length; i += 2) data.set(args[i]!, args[i + 1]!);
          return "OK";
        case "STRLEN":
          return data.get(args[0]!)?.length ?? 0;
        case "DEL":
          return args.filter((k) => data.delete(k)).length;
        case "KEYS": {
          const prefix = args[0]!.replace(/\*$/, "");
          return [...data.keys()].filter((k) => k.startsWith(prefix));
        }
        default:
          throw new Error(`unexpected ${cmd}`);
      }
    },
  };
}

describe("RedisCacheService.getIfChanged", () => {
  test("an unchanged value is not read again", async () => {
    const redis = fakeRedis();
    const cache = new RedisCacheService("asset:", redis);
    await cache.add("npcs", [{ id: 1, hp: 100 }]);
    const first = await cache.getIfChanged("npcs", null);
    expect(first.same).toBe(false);
    expect(first.value).toEqual([{ id: 1, hp: 100 }]);
    redis.reads.length = 0;
    const again = await cache.getIfChanged("npcs", first.digest);
    expect(again.same).toBe(true);
    expect(redis.reads).toEqual([]);
  });

  test("writing the same value again is not read again", async () => {
    const redis = fakeRedis();
    const cache = new RedisCacheService("asset:", redis);
    await cache.add("npcs", [{ id: 1, hp: 100 }]);
    const first = await cache.getIfChanged("npcs", null);
    await cache.add("npcs", [{ id: 1, hp: 100 }]);
    redis.reads.length = 0;
    const again = await cache.getIfChanged("npcs", first.digest);
    expect(again.same).toBe(true);
    expect(redis.reads).toEqual([]);
  });

  test("a write of the same length is seen", async () => {
    const redis = fakeRedis();
    const cache = new RedisCacheService("asset:", redis);
    await cache.add("npcs", [{ id: 1, hp: 100 }]);
    const first = await cache.getIfChanged("npcs", null);
    await cache.add("npcs", [{ id: 1, hp: 200 }]);
    const next = await cache.getIfChanged("npcs", first.digest);
    expect(next.same).toBe(false);
    expect(next.value).toEqual([{ id: 1, hp: 200 }]);
  });

  test("a write that kept no stamp is seen when its length differs", async () => {
    const redis = fakeRedis();
    const cache = new RedisCacheService("asset:", redis);
    await cache.add("npcs", [{ id: 1 }]);
    const first = await cache.getIfChanged("npcs", null);
    await redis.set("asset:npcs", JSON.stringify([{ id: 1 }, { id: 2 }]));
    const next = await cache.getIfChanged("npcs", first.digest);
    expect(next.same).toBe(false);
    expect(next.value).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("a value without a stamp is compared by its text", async () => {
    const redis = fakeRedis();
    const cache = new RedisCacheService("asset:", redis);
    await redis.set("asset:spells", JSON.stringify([{ id: 7 }]));
    const first = await cache.getIfChanged("spells", null);
    expect(first.value).toEqual([{ id: 7 }]);
    expect((await cache.getIfChanged("spells", first.digest)).same).toBe(true);
    await redis.set("asset:spells", JSON.stringify([{ id: 8 }]));
    const next = await cache.getIfChanged("spells", first.digest);
    expect(next.same).toBe(false);
    expect(next.value).toEqual([{ id: 8 }]);
  });

  test("remove and clear drop the stamps with the values", async () => {
    const redis = fakeRedis();
    const cache = new RedisCacheService("asset:", redis);
    await cache.add("npcs", [{ id: 1 }]);
    await cache.add("spells", [{ id: 2 }]);
    const held = await cache.getIfChanged("npcs", null);
    await cache.remove("npcs");
    const gone = await cache.getIfChanged("npcs", held.digest);
    expect(gone.same).toBe(false);
    expect(gone.value).toBeNull();
    await cache.clear();
    expect([...redis.data.keys()]).toEqual([]);
  });
});
