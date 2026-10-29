import { expect, test } from "bun:test";
import { PlayerManager } from "../services/playermanager";

test("add notifies the add listeners with the key and value", () => {
  const cache = new PlayerManager();
  const seen: Array<[string, any]> = [];
  cache.onAdd((key, value) => seen.push([key, value]));
  const value = { username: "Hero" };
  cache.add("1", value);
  expect(seen).toEqual([["1", value]]);
});

test("remove notifies with the removed value, and not when the key is absent", () => {
  const cache = new PlayerManager();
  const removed: Array<[string, any]> = [];
  cache.onRemove((key, value) => removed.push([key, value]));
  cache.remove("missing");
  expect(removed).toEqual([]);
  const value = { username: "Hero" };
  cache.add("1", value);
  cache.remove("1");
  expect(removed).toEqual([["1", value]]);
});

test("set and setNested do not notify", () => {
  const cache = new PlayerManager();
  let calls = 0;
  cache.onAdd(() => calls++);
  cache.onRemove(() => calls++);
  cache.set("1", { username: "Hero" });
  cache.setNested("1", "x", 1);
  expect(calls).toBe(0);
  expect(cache.get("1").x).toBe(1);
});

test("a listener that throws does not stop the next listener or the cache update", () => {
  const cache = new PlayerManager();
  const got: string[] = [];
  cache.onAdd(() => { throw new Error("boom"); });
  cache.onAdd((key) => got.push(key));
  cache.add("1", { username: "Hero" });
  expect(got).toEqual(["1"]);
  expect(cache.getByUsername("hero")).toBeDefined();

  const after: string[] = [];
  cache.onRemove(() => { throw new Error("boom"); });
  cache.onRemove((key) => after.push(key));
  cache.remove("1");
  expect(after).toEqual(["1"]);
  expect(cache.get("1")).toBeUndefined();
});
