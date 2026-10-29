import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { RedisClient } from "bun";
import log from "../modules/logger";
import { RedisStore } from "../cluster/redisstore";

// A Redis client that has given up (Bun 1.4.4 does so once connectionTimeout has passed) is replaced by a fresh one.
// No socket anywhere: the fake clients keep the handlers RedisStore assigns, and the tests fire them by hand.

const REVIVE_TEST_MS = 5;

type Connect = "ok" | "fail" | "hang";

class FakeClient {
  onclose: ((error: Error) => void) | null = null;
  onconnect: (() => void) | null = null;
  closes = 0;
  gets = 0;
  connects = 0;
  subscribed: Array<{ channel: string; dispatch: (message: string) => void }> = [];
  // What the next connect() does; "hang" waits for release().
  behaviour: Connect = "ok";
  private release: ((ok: boolean) => void) | null = null;
  subscriber: FakeClient | null = null;
  failSubscribe = false;
  // False: a closed client that is still connecting goes on to connect (a race a real client can lose).
  abortOnClose = true;
  // When set, subscribe waits for it before it answers.
  holdSubscribe: Promise<void> | null = null;
  holdUnsubscribe: Promise<void> | null = null;
  // Called as a subscribe is answered, inside the same turn.
  onSubscribe: ((channel: string) => void) | null = null;

  async connect() {
    this.connects++;
    if (this.behaviour === "fail") throw new Error("connection refused");
    if (this.behaviour === "hang") {
      const connected = await new Promise<boolean>((resolve) => { this.release = resolve; });
      if (!connected) throw new Error("closed while connecting");
    }
  }
  letConnect() {
    this.release?.(true);
    this.release = null;
  }
  async get(_key: string) {
    this.gets++;
    return "value";
  }
  async duplicate() {
    this.subscriber = new FakeClient();
    return this.subscriber;
  }
  async subscribe(channel: string, dispatch: (message: string) => void) {
    if (this.holdSubscribe) await this.holdSubscribe;
    if (this.failSubscribe) throw new Error("subscribe refused");
    this.subscribed.push({ channel, dispatch });
    this.onSubscribe?.(channel);
  }
  async unsubscribe(channels: string[]) {
    if (this.holdUnsubscribe) await this.holdUnsubscribe;
    this.subscribed = this.subscribed.filter((x) => !channels.includes(x.channel));
  }
  close() {
    this.closes++;
    // A closed hanging connect ends in an error, like a real client.
    if (this.abortOnClose) {
      this.release?.(false);
      this.release = null;
    }
  }
}

/** A store whose factory hands out the fakes in `made`, each connecting as `next` says when it is made. */
function setup(attemptMs?: number) {
  const main = new FakeClient();
  const made: FakeClient[] = [];
  const state = { next: "ok" as Connect, refuseSubscribeOfFirst: false, holdSubscribeOfFirst: null as Promise<void> | null, holdUnsubscribeOfFirst: null as Promise<void> | null, onSubscribeOfFirst: null as ((channel: string) => void) | null };
  const store = new RedisStore("redis://unused", main as unknown as RedisClient, () => {
    const fake = new FakeClient();
    fake.behaviour = state.next;
    made.push(fake);
    if (state.refuseSubscribeOfFirst && made.length === 1) fake.failSubscribe = true;
    if (state.holdSubscribeOfFirst && made.length === 1) fake.holdSubscribe = state.holdSubscribeOfFirst;
    if (state.onSubscribeOfFirst && made.length === 1) fake.onSubscribe = state.onSubscribeOfFirst;
    if (state.holdUnsubscribeOfFirst && made.length === 1) fake.holdUnsubscribe = state.holdUnsubscribeOfFirst;
    return fake as unknown as RedisClient;
  }, REVIVE_TEST_MS, attemptMs);
  // The first connection (it is not logged as a return).
  main.onconnect!();
  return { store, main, made, state };
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
let stores: RedisStore[] = [];
beforeEach(() => {
  errors = spyOn(log, "error").mockImplementation(() => {});
  successes = spyOn(log, "success").mockImplementation(() => {});
  spyOn(log, "warn").mockImplementation(() => {});
  stores = [];
});
afterEach(() => {
  for (const store of stores) store.close();
  errors.mockRestore();
  successes.mockRestore();
});

function track<T extends { store: RedisStore }>(rig: T): T {
  stores.push(rig.store);
  return rig;
}

const lost = () => errors.mock.calls.filter((call: unknown[]) => String(call[0]).includes("connection lost")).length;
const restored = () => successes.mock.calls.filter((call: unknown[]) => String(call[0]).includes("connection restored")).length;

describe("RedisStore revival of the main client", () => {
  test("a main client that never reconnects is replaced once Redis answers; isUp turns true and a get goes to the new client", async () => {
    const { store, main, made } = track(setup());
    main.onclose!(new Error("connection reset"));
    expect(store.isUp()).toBe(false);

    await until(() => store.isUp());
    expect(made.length).toBe(1);
    expect(main.closes).toBe(1);
    expect(made[0]!.closes).toBe(0);
    expect(await store.get("k")).toBe("value");
    expect(made[0]!.gets).toBe(1);
    expect(main.gets).toBe(0);
    // One "lost" and one "restored" line for the whole outage.
    expect(lost()).toBe(1);
    expect(restored()).toBe(1);
  });

  test("the old client closing after the swap is not an outage, and the new client's own loss is", async () => {
    const { store, main, made } = track(setup());
    main.onclose!(new Error("connection reset"));
    await until(() => store.isUp());
    main.onclose!(new Error("closed late"));
    main.onconnect!();
    expect(store.isUp()).toBe(true);
    expect(restored()).toBe(1);

    made[0]!.onclose!(new Error("connection reset"));
    expect(store.isUp()).toBe(false);
    expect(lost()).toBe(2);
    await until(() => made.length === 2 && store.isUp());
    expect(made[0]!.closes).toBe(1);
  });

  test("attempts that fail are closed, are not counted as outages, and only one is in flight at a time", async () => {
    const { store, main, made, state } = track(setup());
    state.next = "hang";
    main.onclose!(new Error("connection reset"));
    // A second close event of the same client does not start a second timer.
    main.onclose!(new Error("connection reset again"));
    await until(() => made.length === 1);
    // Several ticks pass while the first attempt hangs: no second one starts.
    await sleep(REVIVE_TEST_MS * 8);
    expect(made.length).toBe(1);
    expect(made[0]!.connects).toBe(1);

    // It fails: it is closed, and the next tick tries again.
    made[0]!.behaviour = "fail";
    state.next = "fail";
    made[0]!.close();
    made[0]!.closes = 0;
    await until(() => made.length >= 3);
    expect(store.isUp()).toBe(false);
    for (const fake of made.slice(1)) expect(fake.closes).toBe(1);
    // A failed attempt's onclose (should it fire) is no outage: only the first loss was logged.
    for (const fake of made) fake.onclose?.(new Error("refused"));
    expect(lost()).toBe(1);
    expect(restored()).toBe(0);
    expect(main.closes).toBe(0);

    state.next = "ok";
    await until(() => store.isUp());
    expect(main.closes).toBe(1);
    expect(restored()).toBe(1);
  });

  test("the old client coming back first stops the timer, and a fresh one that then connects is closed", async () => {
    const { store, main, made, state } = track(setup());
    state.next = "hang";
    main.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);

    made[0]!.abortOnClose = false;
    main.onconnect!();
    expect(store.isUp()).toBe(true);
    expect(restored()).toBe(1);
    // The attempt in flight is dropped at once, and what it connects to later is not adopted.
    expect(made[0]!.closes).toBe(1);
    made[0]!.letConnect();
    await sleep(REVIVE_TEST_MS * 8);
    expect(made.length).toBe(1);
    expect(made[0]!.closes).toBe(1);
    expect(main.closes).toBe(0);
    expect(await store.get("k")).toBe("value");
    expect(main.gets).toBe(1);
    expect(made[0]!.gets).toBe(0);
    expect(restored()).toBe(1);
  });

  test("close() during an outage stops the timer and closes an attempt in flight; nothing runs afterwards", async () => {
    const { store, main, made, state } = track(setup());
    state.next = "hang";
    main.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);

    store.close();
    expect(made[0]!.closes).toBe(1);
    expect(main.closes).toBe(1);
    made[0]!.letConnect();
    await sleep(REVIVE_TEST_MS * 8);
    expect(made.length).toBe(1);
    expect(made[0]!.closes).toBe(1);
    expect(store.isUp()).toBe(false);
    expect(restored()).toBe(0);
  });

  test("close() during an outage between attempts starts no further attempt", async () => {
    const { store, main, made, state } = track(setup());
    state.next = "fail";
    main.onclose!(new Error("connection reset"));
    await until(() => made.length === 2);
    store.close();
    // Whatever attempt was in flight has ended; the count must stop growing.
    await sleep(REVIVE_TEST_MS * 4);
    const count = made.length;
    await sleep(REVIVE_TEST_MS * 8);
    expect(made.length).toBe(count);
  });
});

describe("RedisStore revival attempt deadline", () => {
  test("an attempt whose connect never answers is closed after the deadline, and a later one can succeed", async () => {
    const { store, main, made, state } = track(setup(30));
    state.next = "hang";
    main.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    // Inside the deadline it is the one in flight.
    await sleep(10);
    expect(made.length).toBe(1);
    expect(made[0]!.closes).toBe(0);

    await until(() => made.length >= 2);
    expect(made[0]!.closes).toBe(1);
    expect(store.isUp()).toBe(false);
    expect(lost()).toBe(1);

    state.next = "ok";
    await until(() => store.isUp());
    expect(restored()).toBe(1);
    expect(main.closes).toBe(1);
    expect(await store.get("k")).toBe("value");
  });
});

describe("RedisStore revival of the subscriber", () => {
  test("a replaced subscriber subscribes every channel again; a message on the new one reaches each handler exactly once", async () => {
    const { store, main, made } = track(setup());
    const seenA: string[] = [];
    const seenB: string[] = [];
    await store.subscribe("cells:a", (m) => seenA.push(m));
    await store.subscribe("cells:b", (m) => seenB.push(m));
    const oldSubscriber = main.subscriber!;
    expect(oldSubscriber.subscribed.length).toBe(2);

    oldSubscriber.onclose!(new Error("connection reset"));
    // The main connection is fine: the store stays up.
    expect(store.isUp()).toBe(true);
    await until(() => made.length === 1 && made[0]!.subscribed.length === 2);
    expect(oldSubscriber.closes).toBe(1);
    expect(made[0]!.subscribed.map((s) => s.channel).sort()).toEqual(["cells:a", "cells:b"]);

    for (const { channel, dispatch } of made[0]!.subscribed) dispatch(`on ${channel}`);
    expect(seenA).toEqual(["on cells:a"]);
    expect(seenB).toEqual(["on cells:b"]);
    expect(restored()).toBe(1);

    // A later subscribe goes to the new subscriber, and an unsubscribe too.
    const seenC: string[] = [];
    await store.subscribe("cells:c", (m) => seenC.push(m));
    expect(made[0]!.subscribed.some((s) => s.channel === "cells:c")).toBe(true);
    expect(oldSubscriber.subscribed.some((s) => s.channel === "cells:c")).toBe(false);
  });

  test("a fresh subscriber that cannot subscribe again is closed, not adopted, and the next attempt is tried", async () => {
    const { store, main, made, state } = track(setup());
    await store.subscribe("cells:a", () => {});
    state.refuseSubscribeOfFirst = true;
    main.subscriber!.onclose!(new Error("connection reset"));
    await until(() => made.length >= 2 && made[1]!.subscribed.length === 1);
    expect(made[0]!.closes).toBe(1);
    expect(made[0]!.subscribed.length).toBe(0);
    expect(made[1]!.closes).toBe(0);
    expect(main.subscriber!.closes).toBe(1);
    expect(restored()).toBe(1);
    expect(lost()).toBe(1);
  });

  test("the subscriber coming back on its own stops its timer", async () => {
    const { main, made, state } = track(setup());
    state.next = "hang";
    const store = stores[0]!;
    await store.subscribe("cells:a", () => {});
    main.subscriber!.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    main.subscriber!.onconnect!();
    expect(made[0]!.closes).toBe(1);
    made[0]!.letConnect();
    await sleep(REVIVE_TEST_MS * 8);
    expect(made.length).toBe(1);
    expect(main.subscriber!.closes).toBe(0);
  });

  test("a lost subscriber that the store closes itself is not revived", async () => {
    const { store, main, made, state } = track(setup());
    state.next = "fail";
    const handler = () => {};
    await store.subscribe("cells:a", handler);
    const old = main.subscriber!;
    old.onclose!(new Error("connection reset"));
    // The last channel goes, and the next subscribe is refused: the store closes the subscriber it had.
    await store.unsubscribe("cells:a", handler);
    old.failSubscribe = true;
    await expect(store.subscribe("cells:b", () => {})).rejects.toThrow();
    expect(old.closes).toBe(1);
    await sleep(REVIVE_TEST_MS * 4);
    const count = made.length;
    await sleep(REVIVE_TEST_MS * 8);
    expect(made.length).toBe(count);
    expect(restored()).toBe(0);
  });

  test("the subscriber coming back while the fresh one subscribes drops the fresh one", async () => {
    const { store, main, made, state } = track(setup());
    await store.subscribe("cells:a", () => {});
    const old = main.subscriber!;
    let open!: () => void;
    state.holdSubscribeOfFirst = new Promise<void>((resolve) => { open = resolve; });
    old.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    // The fresh client has connected and waits on its subscribe; the old one comes back.
    await sleep(REVIVE_TEST_MS * 3);
    old.onconnect!();
    open();
    await sleep(REVIVE_TEST_MS * 8);
    expect(made[0]!.closes).toBe(1);
    expect(old.closes).toBe(0);
    expect(made.length).toBe(1);
    expect(restored()).toBe(1);
    // A later subscribe still goes to the old subscriber.
    await store.subscribe("cells:b", () => {});
    expect(old.subscribed.some((x) => x.channel === "cells:b")).toBe(true);
  });

  test("a subscribe that fails on a replaced subscriber does not drop the new one", async () => {
    const { store, main, made, state } = track(setup());
    const handler = () => {};
    await store.subscribe("cells:a", handler);
    await store.unsubscribe("cells:a", handler);
    const old = main.subscriber!;
    let fail!: () => void;
    old.holdSubscribe = new Promise<void>((resolve) => { fail = resolve; });
    old.failSubscribe = true;
    state.next = "hang";
    old.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    // A subscribe starts on the old subscriber and waits; the fresh one is swapped in; then the old one refuses.
    const late = store.subscribe("cells:b", () => {});
    const outcome = late.then(() => "accepted", () => "refused");
    made[0]!.letConnect();
    await until(() => restored() === 1);
    fail();
    expect(await outcome).toBe("refused");
    // The new subscriber is the store's: a later subscribe goes to it, and no third client is made.
    await store.subscribe("cells:c", () => {});
    expect(made[0]!.subscribed.some((x) => x.channel === "cells:c")).toBe(true);
    expect(main.subscriber).toBe(old);
    expect(made[0]!.closes).toBe(0);
  });

  test("a lost subscriber closed by a refused subscribe is not revived: its fresh client is closed and no second subscriber is left", async () => {
    const { store, main, made, state } = track(setup());
    const handler = () => {};
    await store.subscribe("cells:x", handler);
    await store.unsubscribe("cells:x", handler);
    const first = main.subscriber!;
    state.next = "hang";
    first.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    made[0]!.abortOnClose = false;

    first.failSubscribe = true;
    await expect(store.subscribe("cells:c", handler)).rejects.toThrow();
    // The revival of the closed subscriber is over at once, with its fresh client.
    expect(first.closes).toBe(1);
    expect(made[0]!.closes).toBe(1);

    // The retry makes the next subscriber; the old attempt connecting late must not become a second one.
    const seen: string[] = [];
    await store.subscribe("cells:c", (m) => seen.push(m));
    const second = main.subscriber!;
    expect(second).not.toBe(first);
    made[0]!.letConnect();
    await sleep(REVIVE_TEST_MS * 8);
    expect(made.length).toBe(1);
    expect(made[0]!.subscribed.length).toBe(0);
    expect(restored()).toBe(0);
    for (const { dispatch } of second.subscribed) dispatch("hello");
    expect(seen).toEqual(["hello"]);
    store.close();
    await sleep(2);
    expect(second.closes).toBe(1);
  });

  test("an attempt whose lost client is no longer the store's subscriber drops its fresh client", async () => {
    const { store, main, made, state } = track(setup());
    await store.subscribe("cells:a", () => {});
    const first = main.subscriber!;
    state.next = "hang";
    first.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    made[0]!.abortOnClose = false;
    // Something other than a close here made another client the store's subscriber.
    (store as unknown as { sub: { client: unknown } }).sub.client = new FakeClient();
    made[0]!.letConnect();
    await sleep(REVIVE_TEST_MS * 8);
    expect(made[0]!.closes).toBe(1);
    expect(made.length).toBe(1);
    expect(restored()).toBe(0);
  });

  test("a channel left while the fresh subscriber subscribes is taken off it; a later subscribe runs its handler once", async () => {
    const { store, main, made, state } = track(setup());
    const handlerA = () => {};
    const seenA: string[] = [];
    await store.subscribe("cells:a", handlerA);
    await store.subscribe("cells:b", () => {});
    const old = main.subscriber!;
    let open!: () => void;
    state.holdSubscribeOfFirst = new Promise<void>((resolve) => { open = resolve; });
    old.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    // The fresh client waits on its first subscribe (cells:a); that channel is left meanwhile.
    await sleep(REVIVE_TEST_MS * 3);
    await store.unsubscribe("cells:a", handlerA);
    open();
    await until(() => restored() === 1);
    expect(made[0]!.subscribed.some((x) => x.channel === "cells:a")).toBe(false);
    expect(made[0]!.subscribed.some((x) => x.channel === "cells:b")).toBe(true);

    await store.subscribe("cells:a", (m) => seenA.push(m));
    for (const { channel, dispatch } of made[0]!.subscribed) if (channel === "cells:a") dispatch("hi");
    expect(made[0]!.subscribed.filter((x) => x.channel === "cells:a").length).toBe(1);
    expect(seenA).toEqual(["hi"]);
  });

  test("a channel left and subscribed to again while the fresh subscriber subscribes has one dispatch on it", async () => {
    const { store, main, made, state } = track(setup());
    const first = () => {};
    const seen: string[] = [];
    await store.subscribe("cells:a", first);
    const old = main.subscriber!;
    let open!: () => void;
    state.holdSubscribeOfFirst = new Promise<void>((resolve) => { open = resolve; });
    old.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    await sleep(REVIVE_TEST_MS * 3);
    await store.unsubscribe("cells:a", first);
    await store.subscribe("cells:a", (m) => seen.push(m));
    open();
    await until(() => restored() === 1);
    const onA = made[0]!.subscribed.filter((x) => x.channel === "cells:a");
    expect(onA.length).toBe(1);
    onA[0]!.dispatch("hi");
    expect(seen).toEqual(["hi"]);
  });

  test("a channel subscribed to while the fresh subscriber takes another one off is on it when it is adopted", async () => {
    const { store, main, made, state } = track(setup());
    const handlerA = () => {};
    await store.subscribe("cells:a", handlerA);
    await store.subscribe("cells:b", () => {});
    const old = main.subscriber!;
    let openSubscribe!: () => void;
    let openUnsubscribe!: () => void;
    state.holdSubscribeOfFirst = new Promise<void>((resolve) => { openSubscribe = resolve; });
    state.holdUnsubscribeOfFirst = new Promise<void>((resolve) => { openUnsubscribe = resolve; });
    old.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    await sleep(REVIVE_TEST_MS * 3);
    await store.unsubscribe("cells:a", handlerA);
    openSubscribe();
    // The fresh client is now taking cells:a off again; a channel arrives meanwhile.
    await until(() => made[0]!.subscribed.length === 2);
    await sleep(REVIVE_TEST_MS * 3);
    await store.subscribe("cells:late", () => {});
    openUnsubscribe();
    await until(() => restored() === 1);
    expect(made[0]!.subscribed.map((x) => x.channel).sort()).toEqual(["cells:b", "cells:late"]);
  });

  test("the old subscriber coming back while the fresh one takes a channel off drops the fresh one", async () => {
    const { store, main, made, state } = track(setup());
    const handlerA = () => {};
    await store.subscribe("cells:a", handlerA);
    await store.subscribe("cells:b", () => {});
    const old = main.subscriber!;
    let openSubscribe!: () => void;
    let openUnsubscribe!: () => void;
    state.holdSubscribeOfFirst = new Promise<void>((resolve) => { openSubscribe = resolve; });
    state.holdUnsubscribeOfFirst = new Promise<void>((resolve) => { openUnsubscribe = resolve; });
    old.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    made[0]!.abortOnClose = false;
    await sleep(REVIVE_TEST_MS * 3);
    await store.unsubscribe("cells:a", handlerA);
    openSubscribe();
    await until(() => made[0]!.subscribed.length === 2);
    await sleep(REVIVE_TEST_MS * 3);
    old.onconnect!();
    openUnsubscribe();
    await sleep(REVIVE_TEST_MS * 8);
    expect(made[0]!.closes).toBe(1);
    expect(old.closes).toBe(0);
    expect(made.length).toBe(1);
  });

  test("a channel left in the turn between the last subscribe and the adoption is taken off; a later subscribe runs its handler once", async () => {
    const { store, main, made, state } = track(setup());
    await store.subscribe("cells:a", () => {});
    const handlerB = () => {};
    await store.subscribe("cells:b", handlerB);
    const old = main.subscriber!;
    // Two microtasks after the fresh client answers its last subscribe: after the store has seen it, before the
    // attempt that waits on all the subscribes has resumed.
    state.onSubscribeOfFirst = (channel) => {
      if (channel !== "cells:b") return;
      queueMicrotask(() => queueMicrotask(() => { void store.unsubscribe("cells:b", handlerB); }));
    };
    old.onclose!(new Error("connection reset"));
    await until(() => restored() === 1);
    await sleep(REVIVE_TEST_MS * 3);

    const seen: string[] = [];
    await store.subscribe("cells:b", (m) => seen.push(m));
    const onB = made[0]!.subscribed.filter((x) => x.channel === "cells:b");
    expect(onB.length).toBe(1);
    onB[0]!.dispatch("hi");
    expect(seen).toEqual(["hi"]);
  });

  test("a channel left and subscribed to again in the turn before the adoption has one dispatch on the fresh client", async () => {
    const { store, main, made, state } = track(setup());
    const handlerB = () => {};
    const seen: string[] = [];
    await store.subscribe("cells:b", handlerB);
    const old = main.subscriber!;
    let fired = false;
    state.onSubscribeOfFirst = () => {
      if (fired) return;
      fired = true;
      queueMicrotask(() => queueMicrotask(() => {
        void store.unsubscribe("cells:b", handlerB);
        void store.subscribe("cells:b", (m) => seen.push(m));
      }));
    };
    old.onclose!(new Error("connection reset"));
    await until(() => restored() === 1);
    await sleep(REVIVE_TEST_MS * 3);
    const onB = made[0]!.subscribed.filter((x) => x.channel === "cells:b");
    expect(onB.length).toBe(1);
    // It is the dispatch the store holds for the channel, not the one that was left.
    expect(onB[0]!.dispatch).toBe((store as unknown as { dispatchers: Map<string, (m: string) => void> }).dispatchers.get("cells:b")!);
    onB[0]!.dispatch("hi");
    expect(seen).toEqual(["hi"]);
  });

  test("what is on the fresh client matches what the store holds only when the channels and their dispatch functions are the same", () => {
    const { store } = track(setup());
    const inner = store as unknown as { dispatchers: Map<string, (m: string) => void>; holdsAll(on: Map<string, (m: string) => void>): boolean };
    const one = () => {};
    const other = () => {};
    inner.dispatchers.set("cells:c", one);
    expect(inner.holdsAll(new Map([["cells:c", one]]))).toBe(true);
    expect(inner.holdsAll(new Map([["cells:c", other]]))).toBe(false);
    expect(inner.holdsAll(new Map())).toBe(false);
    expect(inner.holdsAll(new Map([["cells:c", one], ["cells:x", one]]))).toBe(false);
    expect(inner.holdsAll(new Map([["cells:x", one]]))).toBe(false);
  });

  test("a store closed in the turn before the adoption adopts nothing", async () => {
    const { store, main, made, state } = track(setup());
    await store.subscribe("cells:b", () => {});
    const old = main.subscriber!;
    state.onSubscribeOfFirst = () => {
      queueMicrotask(() => queueMicrotask(() => { store.close(); }));
    };
    old.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    await sleep(REVIVE_TEST_MS * 8);
    expect(restored()).toBe(0);
    expect(made[0]!.closes).toBe(1);
  });

  test("a channel subscribed to while the fresh subscriber subscribes is on it when it is adopted", async () => {
    const { store, main, made, state } = track(setup());
    await store.subscribe("cells:a", () => {});
    const old = main.subscriber!;
    let open!: () => void;
    state.holdSubscribeOfFirst = new Promise<void>((resolve) => { open = resolve; });
    old.onclose!(new Error("connection reset"));
    await until(() => made.length === 1);
    await sleep(REVIVE_TEST_MS * 3);
    // The old subscriber still takes this one (it is held open here), so the store holds a dispatch for it.
    await store.subscribe("cells:late", () => {});
    open();
    await until(() => restored() === 1);
    expect(made[0]!.subscribed.map((x) => x.channel).sort()).toEqual(["cells:a", "cells:late"]);
  });

  test("close() during a subscriber outage stops its timer", async () => {
    const { store, main, made, state } = track(setup());
    state.next = "fail";
    await store.subscribe("cells:a", () => {});
    main.subscriber!.onclose!(new Error("connection reset"));
    await until(() => made.length >= 1);
    store.close();
    await sleep(REVIVE_TEST_MS * 4);
    const count = made.length;
    await sleep(REVIVE_TEST_MS * 8);
    expect(made.length).toBe(count);
  });
});
