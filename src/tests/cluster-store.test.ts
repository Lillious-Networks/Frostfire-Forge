import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { RedisClient } from "bun";
import { within } from "../services/redisclient";
import type { ClusterStore } from "../cluster/store";
import { MemoryStore } from "../cluster/memorystore";
import { RedisStore } from "../cluster/redisstore";

// One set of expectations for every ClusterStore, so MemoryStore (what the other tests run on) cannot drift
// from RedisStore (what the cluster runs on). RedisStore runs against a real Redis only when
// CLUSTER_TEST_REDIS_URL names one; every key it touches starts with cells:test:<random>: and is deleted afterwards.

const redisUrl = process.env.CLUSTER_TEST_REDIS_URL;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const until = async (done: () => boolean) => {
  for (let waited = 0; !done() && waited < 2000; waited += 10) await Bun.sleep(10);
};

function contract(make: () => ClusterStore) {
  let store: ClusterStore;
  let prefix: string;
  let used: Set<string>;
  // A key (or channel) of this test's own.
  const k = (name: string) => {
    used.add(prefix + name);
    return prefix + name;
  };

  beforeEach(() => {
    store = make();
    prefix = `cells:test:${randomUUID()}:`;
    used = new Set();
  });

  afterEach(async () => {
    for (const key of used) await store.del(key);
    store.close();
  });

  test("values expire after their ttl", async () => {
    await store.set(k("a"), "1", 50);
    expect(await store.get(k("a"))).toBe("1");
    await Bun.sleep(100);
    expect(await store.get(k("a"))).toBeNull();
  });

  test("a value set without a ttl stays", async () => {
    await store.set(k("a"), "1");
    expect(await store.get(k("a"))).toBe("1");
    expect(await store.get(k("missing"))).toBeNull();
  });

  test("setIfAbsent sets once", async () => {
    expect(await store.setIfAbsent(k("k"), "x", 1000)).toBe(true);
    expect(await store.setIfAbsent(k("k"), "y", 1000)).toBe(false);
    expect(await store.get(k("k"))).toBe("x");
  });

  test("incrBy counts from zero", async () => {
    expect(await store.incrBy(k("n"), 5)).toBe(5);
    expect(await store.incrBy(k("n"), 5)).toBe(10);
  });

  test("swapIfEpoch only replaces the epoch it was told", async () => {
    const d = k("d");
    expect(await store.swapIfEpoch(d, 1, JSON.stringify({ epoch: 2 }))).toBe(false);
    expect(await store.swapIfEpoch(d, 0, JSON.stringify({ epoch: 1 }))).toBe(true);
    expect(await store.swapIfEpoch(d, 0, JSON.stringify({ epoch: 1 }))).toBe(false);
    expect(await store.swapIfEpoch(d, 1, JSON.stringify({ epoch: 2 }))).toBe(true);
    expect(JSON.parse((await store.get(d))!).epoch).toBe(2);
  });

  test("deleteIfEpoch leaves a newer value", async () => {
    const d = k("d");
    await store.set(d, JSON.stringify({ epoch: 3 }));
    expect(await store.deleteIfEpoch(d, 2)).toBe(false);
    expect(await store.deleteIfEpoch(d, 3)).toBe(true);
    expect(await store.get(d)).toBeNull();
    expect(await store.deleteIfEpoch(d, 0)).toBe(false); // nothing there to delete
  });

  test("a value that is not JSON has epoch 0 for swapIfEpoch", async () => {
    const d = k("d");
    await store.set(d, "not json");
    expect(await store.swapIfEpoch(d, 1, JSON.stringify({ epoch: 2 }))).toBe(false);
    expect(await store.get(d)).toBe("not json");
    expect(await store.swapIfEpoch(d, 0, JSON.stringify({ epoch: 1 }))).toBe(true);
    expect(JSON.parse((await store.get(d))!).epoch).toBe(1);
  });

  test("a value that is not JSON has epoch 0 for deleteIfEpoch", async () => {
    const d = k("d");
    await store.set(d, "not json");
    expect(await store.deleteIfEpoch(d, 1)).toBe(false);
    expect(await store.get(d)).toBe("not json");
    expect(await store.deleteIfEpoch(d, 0)).toBe(true);
    expect(await store.get(d)).toBeNull();
  });

  test("JSON without an epoch number has epoch 0", async () => {
    const d = k("d");
    for (const value of ["5", "null", "[1]", '"x"', "{}", '{"epoch":{"a":1}}']) {
      await store.set(d, value);
      expect(await store.swapIfEpoch(d, 7, "{}")).toBe(false);
      expect(await store.deleteIfEpoch(d, 7)).toBe(false);
      expect(await store.deleteIfEpoch(d, 0)).toBe(true);
    }
  });

  test("renewIfEpoch puts a ttl on the epoch it was told, and only on that one", async () => {
    const d = k("d");
    expect(await store.renewIfEpoch(d, 0, 1000)).toBe(false); // nothing there to renew
    expect(await store.get(d)).toBeNull();
    // Without a ttl at first, as swapIfEpoch leaves it: renewing gives it one.
    await store.set(d, JSON.stringify({ epoch: 3, holder: "a" }));
    expect(await store.renewIfEpoch(d, 2, 50)).toBe(false);
    expect(await store.renewIfEpoch(d, 3, 50)).toBe(true);
    expect(JSON.parse((await store.get(d))!)).toEqual({ epoch: 3, holder: "a" });
    await Bun.sleep(100);
    expect(await store.get(d)).toBeNull();

    // A renewal replaces the earlier time; one refused leaves it.
    await store.set(d, JSON.stringify({ epoch: 4 }), 50);
    expect(await store.renewIfEpoch(d, 4, 1000)).toBe(true);
    expect(await store.renewIfEpoch(d, 5, 10)).toBe(false);
    await Bun.sleep(100);
    expect(await store.get(d)).not.toBeNull();
  });

  test("renewIfEpoch: a value that is not JSON, or JSON without an epoch number, has epoch 0", async () => {
    const d = k("d");
    for (const value of ["not json", "5", "null", "[1]", '"x"', "{}", '{"epoch":{"a":1}}']) {
      await store.set(d, value);
      expect(await store.renewIfEpoch(d, 7, 1000)).toBe(false);
      expect(await store.renewIfEpoch(d, 0, 1000)).toBe(true);
      expect(await store.get(d)).toBe(value);
    }
  });

  test("take reads and deletes, so only one caller gets the value", async () => {
    await store.set(k("t"), "x", 1000);
    expect(await store.take(k("t"))).toBe("x");
    expect(await store.take(k("t"))).toBeNull();
    expect(await store.get(k("t"))).toBeNull();
    await store.set(k("e"), "y", 50);
    await Bun.sleep(100);
    expect(await store.take(k("e"))).toBeNull();
  });

  test("sets", async () => {
    await store.addToSet(k("s"), "a");
    await store.addToSet(k("s"), "b");
    await store.addToSet(k("s"), "b");
    await store.removeFromSet(k("s"), "a");
    expect(await store.members(k("s"))).toEqual(["b"]);
    await store.removeFromSet(k("s"), "b");
    expect(await store.members(k("s"))).toEqual([]);
    expect(await store.members(k("none"))).toEqual([]);
  });

  test("del removes a value and a set", async () => {
    await store.set(k("v"), "1");
    await store.addToSet(k("s"), "a");
    await store.del(k("v"));
    await store.del(k("s"));
    expect(await store.get(k("v"))).toBeNull();
    expect(await store.members(k("s"))).toEqual([]);
  });

  test("expire removes a value and a set after the time, and replaces an earlier time", async () => {
    await store.set(k("v"), "1");
    await store.addToSet(k("s"), "a");
    await store.expire(k("v"), 50);
    await store.expire(k("s"), 50);
    await store.set(k("w"), "2", 50);
    await store.expire(k("w"), 5000);
    expect(await store.get(k("v"))).toBe("1");
    expect(await store.members(k("s"))).toEqual(["a"]);
    await Bun.sleep(120);
    expect(await store.get(k("v"))).toBeNull();
    expect(await store.members(k("s"))).toEqual([]);
    expect(await store.get(k("w"))).toBe("2");
  });

  test("publish reaches every subscriber of the channel", async () => {
    const got: string[] = [];
    await store.subscribe(k("c"), (m) => got.push(`1:${m}`));
    await store.subscribe(k("c"), (m) => got.push(`2:${m}`));
    await store.subscribe(k("other"), (m) => got.push(`x:${m}`));
    await store.publish(k("c"), "hi");
    await until(() => got.length >= 2);
    await settle();
    expect(got).toEqual(["1:hi", "2:hi"]);
  });
}

describe("MemoryStore", () => {
  contract(() => new MemoryStore());

  test("a publisher never runs its own handler inline", async () => {
    const store = new MemoryStore();
    const got: string[] = [];
    await store.subscribe("c", (m) => got.push(m));
    await store.publish("c", "hi");
    expect(got).toEqual([]);
    await settle();
    expect(got).toEqual(["hi"]);
  });
});

// One probe, before the tests, with a deadline of a second: a Redis that does not answer in time skips the RedisStore cases
// (they never fail on it, and never wait through reconnects). With CLUSTER_TEST_REDIS_URL unset nothing is tried at all.
async function redisAnswers(url: string | undefined, ms: number): Promise<boolean> {
  if (!url) return false;
  const probe = new RedisClient(url, { autoReconnect: false, maxRetries: 0, enableOfflineQueue: false, connectionTimeout: ms });
  try {
    await within(probe.connect().then(() => probe.send("PING", [])), ms);
    return true;
  } catch {
    return false;
  } finally {
    try { probe.close(); } catch {}
  }
}
const redisUp = await redisAnswers(redisUrl, 1000);
if (redisUrl && !redisUp) console.warn("CLUSTER_TEST_REDIS_URL does not answer within 1 s: the RedisStore cases are skipped.");

describe.skipIf(!redisUp)("RedisStore", () => {
  contract(() => new RedisStore(redisUrl));
});
