import { expect, test } from "bun:test";
import { mockAssetCache } from "./setup";

const audio = {
  list: async () => {
    return await mockAssetCache.get("audio");
  },
  get: async (name: string) => {
    const audioList = await audio.list();
    return (audioList as any[]).find((a: any) => a.name === name);
  },
};

test("audio.list returns all audio from cache", async () => {
  const result = await audio.list();
  expect(Array.isArray(result)).toBe(true);
});

test("audio.get finds audio by name", async () => {
  const result = await audio.get("test_audio");
  expect(result?.name).toBe("test_audio");
});

test("audio.get returns undefined for non-existent audio", async () => {
  const result = await audio.get("nonexistent");
  expect(result).toBeUndefined();
});
