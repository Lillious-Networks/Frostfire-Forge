import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { RedisClient } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import log from "../modules/logger";
import { CLIENT_OPTIONS, SHARED_OPTIONS, SharedRedis } from "../services/redisclient";

// The cache client (CACHE=redis, with or without a cluster) after a Redis outage. Bun 1.4.4 stops reconnecting once the
// connection has been away longer than connectionTimeout, and every call then fails with "Connection has failed". The
// client is replaced by a fresh one, as the cluster store's is. No socket anywhere: the fake clients keep the handlers
// the slot assigns, and the tests fire them by hand.

const REVIVE_TEST_MS = 5;

type Connect = "ok" | "fail" | "hang";

class FakeClient {
  onclose: ((error: Error) => void) | null = null;
  onconnect: (() => void) | null = null;
  data = new Map<string, string>();
  closes = 0;
  calls = 0;
  // A client that gave up: every call fails.
  broken = false;
  behaviour: Connect = "ok";
  private release: ((ok: boolean) => void) | null = null;

  async connect() {
    if (this.behaviour === "fail") throw new Error("connection refused");
    if (this.behaviour === "hang") {
      const connected = await new Promise<boolean>((resolve) => { this.release = resolve; });
      if (!connected) throw new Error("closed while connecting");
    }
    this.onconnect?.();
  }
  private check() {
    this.calls++;
    if (this.broken) throw new Error("Connection has failed");
  }
  async get(key: string) {
    this.check();
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.check();
    this.data.set(key, value);
    return "OK";
  }
  async send(command: string, args: string[]) {
    this.check();
    if (command === "TYPE") return this.data.has(args[0]!) ? "string" : "none";
    if (command === "DEL") { this.data.delete(args[0]!); return 1; }
    return null;
  }
  close() {
    this.closes++;
    this.release?.(false);
    this.release = null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(probe: () => boolean, ms = 1_000) {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) throw new Error("until: timed out");
    await sleep(2);
  }
}

let errors: { mock: { calls: unknown[][] }; mockRestore(): void };
let successes: { mock: { calls: unknown[][] }; mockRestore(): void };
let clients: SharedRedis[] = [];
beforeEach(() => {
  errors = spyOn(log, "error").mockImplementation(() => {});
  successes = spyOn(log, "success").mockImplementation(() => {});
  clients = [];
});
afterEach(() => {
  for (const client of clients) client.close();
  errors.mockRestore();
  successes.mockRestore();
});

/** A client whose factory hands out the fakes in `made`, each connecting as `state.next` says when it is made. */
function setup(first = new FakeClient(), attemptMs = 50) {
  const made: FakeClient[] = [];
  const state = { next: "ok" as Connect };
  const redis = new SharedRedis("redis://unused", first as unknown as RedisClient, () => {
    const fake = new FakeClient();
    fake.behaviour = state.next;
    made.push(fake);
    return fake as unknown as RedisClient;
  }, attemptMs, REVIVE_TEST_MS);
  clients.push(redis);
  return { redis, first, made, state };
}

test("a call goes to the client, and nothing is revived while the connection holds", async () => {
  const { redis, first, made } = setup();
  await redis.set("a", "1");
  expect(await redis.get("a")).toBe("1");
  expect(await redis.send("TYPE", ["a"])).toBe("string");
  expect(first.calls).toBe(3);
  await sleep(REVIVE_TEST_MS * 4);
  expect(made.length).toBe(0);
  expect(redis.isUp()).toBe(true);
});

test("a client that gave up after an outage is replaced once Redis answers; calls fail meanwhile and then succeed", async () => {
  const { redis, first, made, state } = setup();
  await redis.set("a", "1");
  // The outage: the client reports the loss and every call fails; the first fresh clients cannot connect.
  state.next = "fail";
  first.broken = true;
  first.onclose!(new Error("connection reset"));
  expect(redis.isUp()).toBe(false);
  await expect(redis.get("a")).rejects.toThrow("Connection has failed");
  await until(() => made.length >= 2);
  expect(redis.isUp()).toBe(false);
  // Redis is back: the next fresh client connects, takes the place of the lost one, and the lost one is closed.
  state.next = "ok";
  await until(() => redis.isUp());
  expect(first.closes).toBe(1);
  expect(await redis.get("a")).toBeNull();
  expect(made.at(-1)!.calls).toBe(1);
  // One "lost" and one "restored" line for the whole outage.
  expect(errors.mock.calls.filter((call) => String(call[0]).includes("connection lost")).length).toBe(1);
  expect(successes.mock.calls.filter((call) => String(call[0]).includes("connection restored")).length).toBe(1);
});

test("a client that comes back on its own is kept, and its fresh client is dropped", async () => {
  const { redis, first, made, state } = setup();
  await redis.set("a", "1");
  state.next = "hang";
  first.onclose!(new Error("connection reset"));
  await until(() => made.length === 1);
  first.onconnect!();
  await until(() => made[0]!.closes === 1);
  expect(first.closes).toBe(0);
  expect(redis.isUp()).toBe(true);
  expect(await redis.get("a")).toBe("1");
  expect(made.length).toBe(1);
});

test("a first connection that is refused is revived, as the client may never say that it was lost", async () => {
  const first = new FakeClient();
  first.behaviour = "fail";
  first.broken = true;
  const { redis, made } = setup(first);
  // Waits for the first connection, which fails; the call then meets a client that is not connected.
  await expect(redis.get("a")).rejects.toThrow("Connection has failed");
  expect(errors.mock.calls.some((call) => String(call[0]).includes("Could not connect to Redis"))).toBe(true);
  await until(() => first.closes === 1);
  expect(made.length).toBeGreaterThanOrEqual(1);
  expect(await redis.get("a")).toBeNull();
  expect(made.at(-1)!.calls).toBe(1);
});

test("a first connection that never answers is given up after the attempt deadline and revived", async () => {
  const first = new FakeClient();
  first.behaviour = "hang";
  first.broken = true;
  const { redis, made } = setup(first, 20);
  const started = Date.now();
  await expect(redis.get("a")).rejects.toThrow("Connection has failed");
  expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  await until(() => first.closes === 1);
  expect(made.length).toBeGreaterThanOrEqual(1);
  expect(await redis.get("a")).toBeNull();
});

// The cache and the worlds' player counts take their client from here and not from Bun's `redis` singleton, which gives
// up for good after a long outage. The cache module is replaced by stand-ins in many test files, so its source is read.
test("the asset cache and the worlds' counts use the shared client, not Bun's redis singleton", () => {
  const cache = readFileSync(join(import.meta.dir, "..", "services", "assetCache.ts"), "utf8");
  const worlds = readFileSync(join(import.meta.dir, "..", "systems", "worlds.ts"), "utf8");
  expect(cache).toContain("sharedRedis()");
  expect(cache).not.toContain(".redis");
  expect(worlds).toMatch(/CACHE\?\.toLowerCase\(\) === "redis"\) return sharedRedis\(\)/);
});

test("close ends the revival: no fresh client is made after it", async () => {
  const { redis, first, made, state } = setup();
  await redis.set("a", "1");
  state.next = "fail";
  first.onclose!(new Error("connection reset"));
  await until(() => made.length >= 1);
  redis.close();
  const count = made.length;
  await sleep(REVIVE_TEST_MS * 6);
  expect(made.length).toBe(count);
});

test("the cache client queues calls while it reconnects, the cluster store's client does not", () => {
  expect(SHARED_OPTIONS.enableOfflineQueue).toBe(true);
  expect(SHARED_OPTIONS.autoReconnect).toBe(true);
  expect(CLIENT_OPTIONS.enableOfflineQueue).toBe(false);
});

test("a call made while the client is reconnecting waits and completes when it comes back", async () => {
  const { redis, first } = setup();
  await redis.set("a", "1");
  // A client with its offline queue on: a call made while it is lost waits for the connection.
  let back!: () => void;
  const reconnected = new Promise<void>((resolve) => { back = resolve; });
  first.get = async (key: string) => { await reconnected; return first.data.get(key) ?? null; };
  first.onclose!(new Error("connection reset"));
  let answer: string | null | undefined;
  const pending = redis.get("a").then((value) => { answer = value; });
  await sleep(REVIVE_TEST_MS * 3);
  expect(answer).toBeUndefined();
  first.onconnect!();
  back();
  await pending;
  expect(answer).toBe("1");
  expect(redis.isUp()).toBe(true);
});

test("isUp is false while the first connection fails, and true once a client is connected", async () => {
  const first = new FakeClient();
  first.behaviour = "fail";
  const { redis, state } = setup(first);
  state.next = "fail";
  await redis.get("a").catch(() => {});
  expect(redis.isUp()).toBe(false);
  state.next = "ok";
  await until(() => redis.isUp());
});
