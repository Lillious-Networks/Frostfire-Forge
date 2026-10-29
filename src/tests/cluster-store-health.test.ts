import { describe, expect, test } from "bun:test";
import type { RedisClient } from "bun";
import { MemoryStore } from "../cluster/memorystore";
import { RedisStore } from "../cluster/redisstore";

// No socket anywhere: the fake client keeps the handlers RedisStore assigns, and the tests fire them by hand.
class FakeClient {
  onclose: ((error: Error) => void) | null = null;
  onconnect: (() => void) | null = null;
  closes = 0;
  subscriber: FakeClient | null = null;

  async connect() {}
  async duplicate() {
    this.subscriber = new FakeClient();
    return this.subscriber;
  }
  async subscribe(_channel: string, _dispatch: (message: string) => void) {}
  async unsubscribe(_channels: string[]) {}
  close() {
    this.closes++;
  }
}

function storeWithFakeMain() {
  const main = new FakeClient();
  const store = new RedisStore("redis://unused", main as unknown as RedisClient);
  return { store, main };
}

describe("MemoryStore health", () => {
  test("is up", () => {
    expect(new MemoryStore().isUp()).toBe(true);
  });
});

describe("RedisStore health", () => {
  test("is up before any outage", () => {
    const { store } = storeWithFakeMain();
    expect(store.isUp()).toBe(true);
  });

  test("an outage of the main connection takes it down, and reconnecting brings it back", () => {
    const { store, main } = storeWithFakeMain();
    main.onclose!(new Error("connection reset"));
    expect(store.isUp()).toBe(false);
    main.onconnect!();
    expect(store.isUp()).toBe(true);
  });

  test("a failed first connection is down until it connects", () => {
    const { store, main } = storeWithFakeMain();
    main.onclose!(new Error("connection refused"));
    expect(store.isUp()).toBe(false);
    main.onconnect!();
    expect(store.isUp()).toBe(true);
  });

  test("an outage after a failed first connection and a reconnect still takes it down", () => {
    const { store, main } = storeWithFakeMain();
    main.onclose!(new Error("connection refused"));
    main.onconnect!();
    main.onclose!(new Error("connection reset"));
    expect(store.isUp()).toBe(false);
    main.onconnect!();
    expect(store.isUp()).toBe(true);
  });

  test("the subscriber's connection does not change it", async () => {
    const { store, main } = storeWithFakeMain();
    await store.subscribe("cells:test", () => {});
    const subscriber = main.subscriber!;
    expect(subscriber).not.toBeNull();

    subscriber.onclose!(new Error("connection reset"));
    expect(store.isUp()).toBe(true);
    subscriber.onconnect!();
    expect(store.isUp()).toBe(true);

    main.onclose!(new Error("connection reset"));
    subscriber.onclose!(new Error("connection reset"));
    expect(store.isUp()).toBe(false);
    main.onconnect!();
    expect(store.isUp()).toBe(true);
  });

  test("a store closed by us reports down, and a later connect does not bring it back", () => {
    const { store, main } = storeWithFakeMain();
    store.close();
    expect(main.closes).toBe(1);
    expect(store.isUp()).toBe(false);
    main.onconnect!();
    expect(store.isUp()).toBe(false);
  });
});
