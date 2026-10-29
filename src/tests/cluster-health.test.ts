import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { Delivery } from "../cluster/deliver";
import { PlayerDirectory } from "../cluster/directory";
import { handoffBlocked, type HandoffChecks } from "../cluster/handoffwatch";
import { StoreHealth, runWhenUp, storeHealth } from "../cluster/health";
import { MemoryStore } from "../cluster/memorystore";
import { trackPresence } from "../cluster/presence";
import { SnapshotWriter } from "../cluster/snapshots";
import log from "../modules/logger";
import playerCache from "../services/playermanager";

const TEST_BUS_KEY = "test-bus-key";
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

/** A MemoryStore whose isUp can be turned off; `outage` also makes its calls fail, as Redis's do. */
class FlakyStore extends MemoryStore {
  down = false;
  override isUp(): boolean {
    return !this.down;
  }
}

const FAILING = ["get", "set", "incrBy", "swapIfEpoch", "deleteIfEpoch", "publish", "addToSet", "removeFromSet"] as const;

function outage(store: FlakyStore): () => void {
  store.down = true;
  const spies = FAILING.map((name) => spyOn(store, name).mockImplementation((async () => { throw new Error("redis down"); }) as any));
  return () => {
    for (const spy of spies) spy.mockRestore();
    store.down = false;
  };
}

const restores: Array<() => void> = [];
let errored: string[] = [];
let warned: string[] = [];
let back: string[] = [];
let debugged: string[] = [];

beforeEach(() => {
  errored = [];
  warned = [];
  back = [];
  debugged = [];
  const error = spyOn(log, "error").mockImplementation((message: any) => { errored.push(String(message)); });
  const warn = spyOn(log, "warn").mockImplementation((message: any) => { warned.push(String(message)); });
  const success = spyOn(log, "success").mockImplementation((message: any) => { back.push(String(message)); });
  const info = spyOn(log, "info").mockImplementation(() => {});
  const debug = spyOn(log, "debug").mockImplementation((message: any) => { debugged.push(String(message)); });
  restores.push(() => error.mockRestore(), () => warn.mockRestore(), () => success.mockRestore(), () => info.mockRestore(), () => debug.mockRestore());
});

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  storeHealth.detach();
});

// ---------------------------------------------------------------- StoreHealth

test("up follows the store, and with no store it is up", () => {
  const health = new StoreHealth();
  const store = new FlakyStore();
  expect(health.up()).toBe(true);
  health.attach(store, 5);
  store.down = true;
  expect(health.up()).toBe(false);
  health.detach();
  expect(health.up()).toBe(true);
});

test("whenUp answers at once when up, when the store comes back, or false at the timeout", async () => {
  const health = new StoreHealth();
  const store = new FlakyStore();
  health.attach(store, 5);
  try {
    expect(await health.whenUp(1_000)).toBe(true);
    store.down = true;
    expect(await health.whenUp(20)).toBe(false);
    const started = Date.now();
    const waiting = health.whenUp(5_000);
    setTimeout(() => { store.down = false; }, 20);
    // Guard: the poll wakes the waiters. Without it the wait runs to its timeout.
    expect(await waiting).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    health.detach();
  }
});

test("an outage is logged once when it starts and once when it ends", async () => {
  const health = new StoreHealth();
  const store = new FlakyStore();
  health.attach(store, 5);
  try {
    store.down = true;
    await wait(40);
    store.down = false;
    await wait(40);
    expect(errored.filter((line) => line.includes("cluster store is down")).length).toBe(1);
    expect(back.filter((line) => line.includes("cluster store is back")).length).toBe(1);
  } finally {
    health.detach();
  }
});

test("runWhenUp waits for a store that is down, and runs again what failed because it went down", async () => {
  const health = new StoreHealth();
  const store = new FlakyStore();
  health.attach(store, 5);
  try {
    let runs = 0;
    const done = runWhenUp(health, "a test", async () => {
      runs++;
      if (runs === 1) {
        store.down = true;
        setTimeout(() => { store.down = false; }, 20);
        throw new Error("redis down");
      }
      return "ran";
    }, { holdMs: 1_000, attempts: 3 });
    // Guard: the retry while the store is down.
    expect(await done).toBe("ran");
    expect(runs).toBe(2);
  } finally {
    health.detach();
  }
});

test("runWhenUp runs at most `attempts` times when the store keeps going down under it", async () => {
  const health = new StoreHealth();
  const store = new FlakyStore();
  health.attach(store, 5);
  try {
    let runs = 0;
    const done = runWhenUp(health, "a test", async () => {
      runs++;
      if (runs < 6) {
        store.down = true;
        setTimeout(() => { store.down = false; }, 10);
      }
      throw new Error("redis down");
    }, { holdMs: 1_000, attempts: 2 });
    await expect(done).rejects.toThrow("redis down");
    // Guard: the attempts bound. Without it the work runs until the store stays up.
    expect(runs).toBe(2);
  } finally {
    health.detach();
  }
});

test("detach wakes whoever waits for the store", async () => {
  const health = new StoreHealth();
  health.attach(new FlakyStore(), 5_000);
  (health as any).store.down = true;
  const started = Date.now();
  const waiting = health.whenUp(3_000);
  health.detach();
  // Guard: the wake in detach. Without it the wait runs to its timeout.
  expect(await waiting).toBe(true);
  expect(Date.now() - started).toBeLessThan(500);
});

test("runWhenUp does not run again what failed while the store was up", async () => {
  const health = new StoreHealth();
  health.attach(new FlakyStore(), 5);
  try {
    let runs = 0;
    const done = runWhenUp(health, "a test", async () => { runs++; throw new Error("bad row"); }, { holdMs: 1_000, attempts: 3 });
    await expect(done).rejects.toThrow("bad row");
    expect(runs).toBe(1);
  } finally {
    health.detach();
  }
});

test("runWhenUp gives up after the hold, and once its owner stopped", async () => {
  const health = new StoreHealth();
  const store = new FlakyStore();
  health.attach(store, 5);
  try {
    store.down = true;
    let runs = 0;
    // Guard: the hold bound. Without it a claim waits for good.
    await expect(runWhenUp(health, "a test", async () => { runs++; }, { holdMs: 20, attempts: 3 })).rejects.toThrow("stayed down");
    let alive = true;
    const stopped = runWhenUp(health, "a test", async () => { runs++; }, { holdMs: 1_000, attempts: 3, alive: () => alive });
    alive = false;
    store.down = false;
    // Guard: alive. A claim that wakes after the teardown sweep would leave an entry behind.
    await expect(stopped).rejects.toThrow("stopped");
    expect(runs).toBe(0);
  } finally {
    health.detach();
  }
});

// ---------------------------------------------------------------- handoffs

const open: HandoffChecks = {
  trading: () => false, dragged: () => false, pending: () => false, coolingDown: () => false, linkUp: () => true, settling: () => false,
};

test("a handoff waits while the store is down: the node's health is asked when no check is given", () => {
  const hero = { id: "1", username: "Hero", location: { map: "main", position: { x: 1, y: 1 } } };
  expect(handoffBlocked(hero, "b", { ...open, storeUp: () => false })).toBe("store");
  expect(handoffBlocked(hero, "b", { ...open, storeUp: () => true })).toBeNull();
  // With the link down as well the store is the reason named, and with the store up the link is.
  expect(handoffBlocked(hero, "b", { ...open, storeUp: () => false, linkUp: () => false })).toBe("store");
  expect(handoffBlocked(hero, "b", { ...open, storeUp: () => true, linkUp: () => false })).toBe("link");
  const store = new FlakyStore();
  storeHealth.attach(store, 5);
  store.down = true;
  // Guard: the "store" line of handoffBlocked and its default to storeHealth.
  expect(handoffBlocked(hero, "b", open)).toBe("store");
  store.down = false;
  expect(handoffBlocked(hero, "b", open)).toBeNull();
});

// ---------------------------------------------------------------- delivery

function fakeConnection() {
  const sent: string[] = [];
  return { sent, wt: { readyState: 1, send: (p: Uint8Array) => sent.push(decode(p)), sendBestEffort: (p: Uint8Array) => sent.push(`~${decode(p)}`) } };
}

function players(entries: Record<string, any>) {
  return {
    get: (key: string) => entries[key],
    getByUsername: (name: string) => Object.values(entries).find((p) => p.username.toLowerCase() === name.toLowerCase()),
    list: () => entries,
  };
}

/** Two nodes on one store. Node a waits on `health`; node b holds Hero. */
async function pair(health: StoreHealth, opts: { holdMs?: number; maxHeld?: number } = {}) {
  const store = new FlakyStore();
  health.attach(store, 5);
  const hero = fakeConnection();
  const local = fakeConnection();
  const nodes: Delivery[] = [];
  let mine: Record<string, any> = {};
  for (const [id, entries] of [["a", { "1": { username: "Here", ...local } }], ["b", { "7": { username: "Hero", ...hero } }]] as const) {
    if (id === "a") mine = entries;
    const bus = new ClusterBus(store, id, TEST_BUS_KEY);
    await bus.start();
    const directory = new PlayerDirectory(store, id);
    const delivery = new Delivery(players(entries), id === "a" ? { health, ...opts } : {});
    delivery.attach(bus, directory);
    for (const [key, p] of Object.entries(entries)) await directory.claim(p.username, key, "main");
    delivery.registerAction("note", (player: any, args: any) => { player.wt.send(encode(`action ${args}`)); });
    nodes.push(delivery);
  }
  return { store, hero, local, mine, a: nodes[0]!, b: nodes[1]! };
}

test("a delivery to another node is held while the store is down, and sent when it is back", async () => {
  const health = new StoreHealth();
  const { store, hero, a } = await pair(health);
  try {
    store.down = true;
    const sending = a.deliverToPlayer("hero", [encode("hi")]);
    const acting = a.runOnPlayer("hero", "note", "x");
    await wait(40);
    // Guard: the hold in deliverToPlayer and runOnPlayer. Without it both go out while Redis is away.
    expect(hero.sent).toEqual([]);
    store.down = false;
    expect(await sending).toBe(true);
    expect(await acting).toBe(true);
    await wait(20);
    expect(hero.sent.sort()).toEqual(["action x", "hi"]);
  } finally {
    health.detach();
  }
});

test("a delivery held past the hold is dropped and logged", async () => {
  const health = new StoreHealth();
  const { store, hero, a } = await pair(health, { holdMs: 20 });
  try {
    store.down = true;
    expect(await a.deliverToPlayer("hero", [encode("hi")])).toBe(false);
    expect(await a.isOnline("hero")).toBe(false);
    expect(await a.runOnPlayer("hero", "note", "x")).toBe(false);
    store.down = false;
    await wait(20);
    expect(hero.sent).toEqual([]);
    expect(warned.some((line) => line.includes("hero") && line.includes("cluster store"))).toBe(true);
  } finally {
    health.detach();
  }
});

test("past the most held at once, a delivery is not held", async () => {
  const health = new StoreHealth();
  const { store, a } = await pair(health, { maxHeld: 1 });
  try {
    store.down = true;
    const first = a.deliverToPlayer("hero", [encode("one")]);
    const started = Date.now();
    // Guard: MAX_HELD_DELIVERIES. Without it a long outage holds every delivery of the node.
    expect(await a.deliverToPlayer("hero", [encode("two")])).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
    store.down = false;
    expect(await first).toBe(true);
  } finally {
    health.detach();
  }
});

test("a world broadcast held past the hold still reaches this node's players", async () => {
  const health = new StoreHealth();
  const { store, local, hero, a } = await pair(health, { holdMs: 20 });
  try {
    store.down = true;
    await a.broadcastWorld([encode("news")]);
    // Guard: the local fallback after the hold.
    expect(local.sent).toEqual(["news"]);
    store.down = false;
    await wait(20);
    expect(hero.sent).toEqual([]);
  } finally {
    health.detach();
  }
});

test("without a cluster nothing is held", async () => {
  const health = new StoreHealth();
  const store = new FlakyStore();
  health.attach(store, 5);
  store.down = true;
  try {
    const here = fakeConnection();
    const delivery = new Delivery(players({ "1": { username: "Here", ...here } }), { health });
    expect(await delivery.deliverToPlayer("here", [encode("hi")])).toBe(true);
    expect(await delivery.deliverToPlayer("nobody", [encode("hi")])).toBe(false);
    await delivery.broadcastWorld([encode("news")]);
    expect(here.sent).toEqual(["hi", "news"]);
  } finally {
    health.detach();
  }
});

test("isOnline is held while the store is down, and answers once it is back", async () => {
  const health = new StoreHealth();
  const { store, a } = await pair(health);
  try {
    store.down = true;
    const asking = a.isOnline("hero");
    // Guard: the hold in isOnline. Without it the lookup is answered from the directory while Redis is away.
    expect(await Promise.race([asking, wait(40).then(() => "held")])).toBe("held");
    store.down = false;
    expect(await asking).toBe(true);
  } finally {
    health.detach();
  }
});

test("an action for one session on another node is held while the store is down, and dropped past the hold", async () => {
  const health = new StoreHealth();
  const { store, hero, a } = await pair(health);
  try {
    store.down = true;
    const acting = a.runOnPlayerAt("b", "7", "note", "x");
    await wait(40);
    // Guard: the hold in runOnPlayerAt.
    expect(hero.sent).toEqual([]);
    store.down = false;
    await acting;
    await wait(20);
    expect(hero.sent).toEqual(["action x"]);
  } finally {
    health.detach();
  }
  const short = new StoreHealth();
  const second = await pair(short, { holdMs: 20 });
  try {
    second.store.down = true;
    await second.a.runOnPlayerAt("b", "7", "note", "x");
    second.store.down = false;
    await wait(20);
    expect(second.hero.sent).toEqual([]);
    expect(warned.some((line) => line.includes("session 7") && line.includes("cluster store"))).toBe(true);
  } finally {
    short.detach();
  }
});

test("a player who arrives here while the hold runs out is served here, though the store is still down", async () => {
  const health = new StoreHealth();
  const { store, mine, a } = await pair(health, { holdMs: 40 });
  try {
    store.down = true;
    const sending = a.deliverToPlayer("zed", [encode("hi")]);
    const acting = a.runOnPlayer("zed", "note", "x");
    const asking = a.isOnline("zed");
    await wait(10);
    const arrived = fakeConnection();
    mine["11"] = { username: "Zed", ...arrived };
    // Guard: the local look in the drop branches. A local send or run needs no store.
    expect(await sending).toBe(true);
    expect(await acting).toBe(true);
    expect(await asking).toBe(true);
    expect(arrived.sent.sort()).toEqual(["action x", "hi"]);
  } finally {
    health.detach();
  }
});

test("the places held are given back: a second outage holds a delivery again", async () => {
  const health = new StoreHealth();
  const { store, a } = await pair(health, { maxHeld: 1 });
  try {
    store.down = true;
    const first = a.deliverToPlayer("hero", [encode("one")]);
    store.down = false;
    expect(await first).toBe(true);
    store.down = true;
    const second = a.deliverToPlayer("hero", [encode("two")]);
    const settled = await Promise.race([second, wait(40).then(() => "held")]);
    // Guard: held-- in storeBack. Without it the one place is used up for good, and this fails at once.
    expect(settled).toBe("held");
    store.down = false;
    expect(await second).toBe(true);
  } finally {
    health.detach();
  }
});

test("an action held past the hold is not run, and says so", async () => {
  const health = new StoreHealth();
  const { store, hero, a } = await pair(health, { holdMs: 20 });
  try {
    store.down = true;
    // Guard: the drop answer of runOnPlayer.
    expect(await a.runOnPlayer("hero", "note", "x")).toBe(false);
    store.down = false;
    await wait(20);
    expect(hero.sent).toEqual([]);
    expect(warned.some((line) => line.includes('Action "note"') && line.includes("cluster store"))).toBe(true);
  } finally {
    health.detach();
  }
});

test("a player who arrives here while a delivery is held gets it here", async () => {
  const health = new StoreHealth();
  const { store, hero, mine, a } = await pair(health);
  try {
    store.down = true;
    const sending = a.deliverToPlayer("hero", [encode("hi")]);
    const acting = a.runOnPlayer("hero", "note", "x");
    const asking = a.isOnline("hero");
    const newcomerAsking = a.isOnline("newcomer");
    await wait(20);
    mine["10"] = { username: "Newcomer", ...fakeConnection() };
    const arrived = fakeConnection();
    mine["9"] = { username: "Hero", ...arrived };
    store.down = false;
    // Guard: the local look after the hold. Without it the message goes to the directory's node or is lost.
    expect(await sending).toBe(true);
    expect(await acting).toBe(true);
    expect(await asking).toBe(true);
    // Nobody else holds Newcomer, so only the local look can find them.
    expect(await newcomerAsking).toBe(true);
    await wait(20);
    expect(arrived.sent.sort()).toEqual(["action x", "hi"]);
    expect(hero.sent).toEqual([]);
  } finally {
    health.detach();
  }
});

// ---------------------------------------------------------------- the directory

async function withPresence(run: (ctx: { store: FlakyStore; directory: PlayerDirectory; stop: () => void }) => Promise<void>) {
  const health = new StoreHealth();
  const store = new FlakyStore();
  health.attach(store, 5);
  const directory = new PlayerDirectory(store, "a");
  const stop = trackPresence(directory, () => {}, { health, storeHoldMs: 1_000 });
  try {
    await run({ store, directory, stop });
  } finally {
    stop();
    health.detach();
  }
}

test("a login while the store is down is claimed when it comes back", async () => {
  await withPresence(async ({ store, directory }) => {
    const restore = outage(store);
    playerCache.add("h901", { username: "Waiting", location: { map: "main" } });
    try {
      await wait(30);
      restore();
      await wait(40);
      // Guard: runWhenUp around the claim. Without it the claim failed once, and the player is in no entry.
      expect((await directory.get("waiting"))?.nodeId).toBe("a");
    } finally {
      playerCache.remove("h901");
    }
  });
});

test("a logout while the store is down is released when it comes back", async () => {
  await withPresence(async ({ store, directory }) => {
    playerCache.add("h902", { username: "Leaving", location: { map: "main" } });
    await wait(20);
    expect((await directory.get("leaving"))?.nodeId).toBe("a");
    const restore = outage(store);
    playerCache.remove("h902");
    await wait(30);
    restore();
    await wait(40);
    // Guard: runWhenUp around the release. Without it the entry stays until the node's teardown sweep.
    expect(await directory.get("leaving")).toBeNull();
  });
});

test("a claim still waiting when presence stops is not made", async () => {
  await withPresence(async ({ store, directory, stop }) => {
    const restore = outage(store);
    playerCache.add("h903", { username: "Late", location: { map: "main" } });
    try {
      await wait(20);
      stop();
      restore();
      await wait(40);
      expect(await directory.get("late")).toBeNull();
      // A claim that stopped with the node is a shutdown, not a fault: debug, not error.
      expect(errored.some((line) => line.includes("Directory claim"))).toBe(false);
      expect(debugged.some((line) => line.includes("Directory claim for Late"))).toBe(true);
    } finally {
      playerCache.remove("h903");
    }
  });
});

test("a release still waiting when presence stops is not made, and is not an error", async () => {
  await withPresence(async ({ store, directory, stop }) => {
    playerCache.add("h905", { username: "Gone", location: { map: "main" } });
    await wait(20);
    expect((await directory.get("gone"))?.nodeId).toBe("a");
    const restore = outage(store);
    playerCache.remove("h905");
    await wait(20);
    stop();
    restore();
    await wait(40);
    expect(errored.some((line) => line.includes("Directory release"))).toBe(false);
    expect(debugged.some((line) => line.includes("Directory release for Gone"))).toBe(true);
  });
});

test("a claim that fails after it took the entry from another node still names the login it displaced", async () => {
  const health = new StoreHealth();
  const store = new FlakyStore();
  health.attach(store, 5);
  const old = new PlayerDirectory(store, "a");
  await old.claim("Hero", "1", "main");
  const directory = new PlayerDirectory(store, "b");
  const displaced: Array<[string, string]> = [];
  const stop = trackPresence(directory, (previous, username) => { displaced.push([previous.nodeId, username]); }, { health, storeHoldMs: 1_000 });
  // The entry is swapped; the store goes down at the next call, which is the old node's set.
  const failing = spyOn(store, "removeFromSet").mockImplementationOnce((async () => {
    store.down = true;
    setTimeout(() => { store.down = false; }, 20);
    throw new Error("redis down");
  }) as any);
  playerCache.add("h906", { username: "Hero", location: { map: "main" } });
  try {
    await wait(80);
    expect((await directory.get("hero"))?.nodeId).toBe("b");
    // Guard: the entry read before the first attempt. The retry reads this node's own new entry as the previous one.
    expect(displaced).toEqual([["a", "Hero"]]);
  } finally {
    failing.mockRestore();
    playerCache.remove("h906");
    stop();
    health.detach();
  }
});

test("a claim that took the entry from another node and then fails for good still names the login it displaced", async () => {
  const health = new StoreHealth();
  const store = new FlakyStore();
  health.attach(store, 5);
  const old = new PlayerDirectory(store, "a");
  await old.claim("Hero", "1", "main");
  const directory = new PlayerDirectory(store, "b");
  const displaced: Array<[string, string]> = [];
  const stop = trackPresence(directory, (previous, username) => { displaced.push([previous.nodeId, username]); }, { health, storeHoldMs: 1_000 });
  // The entry is swapped; the old node's set then fails while the store is up, so the claim is not run again.
  const failing = spyOn(store, "removeFromSet").mockImplementation((async () => { throw new Error("bad reply"); }) as any);
  playerCache.add("h907", { username: "Hero", location: { map: "main" } });
  try {
    await wait(80);
    expect((await directory.get("hero"))?.nodeId).toBe("b");
    // Guard: the failed claim's catch names what its swap replaced. Without it the login on a stays live beside this one.
    expect(displaced).toEqual([["a", "Hero"]]);
  } finally {
    failing.mockRestore();
    playerCache.remove("h907");
    stop();
    health.detach();
  }
});

test("a claim that lost the entry to a third node between its read and its swap names that node, not the first", async () => {
  const health = new StoreHealth();
  const store = new FlakyStore();
  health.attach(store, 5);
  await new PlayerDirectory(store, "a").claim("Hero", "1", "main");
  const directory = new PlayerDirectory(store, "b");
  const displaced: Array<[string, string, string]> = [];
  const stop = trackPresence(directory, (previous, username) => { displaced.push([previous.nodeId, previous.playerId, username]); }, { health, storeHoldMs: 1_000 });
  const original = MemoryStore.prototype.incrBy;
  let failing: ReturnType<typeof spyOn> | null = null;
  // Node c takes the entry after b read it. Then b's swap is refused and b reads again; the set update after its
  // second swap fails once with the store down.
  const racing = spyOn(store, "incrBy").mockImplementationOnce((async (key: string, by: number) => {
    await new PlayerDirectory(store, "c").claim("Hero", "55", "main");
    failing = spyOn(store, "removeFromSet").mockImplementationOnce((async () => {
      store.down = true;
      setTimeout(() => { store.down = false; }, 20);
      throw new Error("redis down");
    }) as any);
    return original.call(store, key, by);
  }) as any);
  playerCache.add("h907", { username: "Hero", location: { map: "main" } });
  try {
    await wait(100);
    expect((await directory.get("hero"))?.nodeId).toBe("b");
    // Guard: the entry the swap replaced. c's session 55 is live and must be told; a's was already replaced by c.
    expect(displaced).toEqual([["c", "55", "Hero"]]);
  } finally {
    racing.mockRestore();
    failing?.mockRestore();
    playerCache.remove("h907");
    stop();
    health.detach();
  }
});

test("a quiet claim names no displaced login, and a plain one names the node it took the entry from", async () => {
  const store = new FlakyStore();
  const displaced: string[] = [];
  const stops: Array<() => void> = [];
  try {
    for (const [name, quiet] of [["Calm", true], ["Loud", false]] as const) {
      await new PlayerDirectory(store, "a").claim(name, "1", "main");
      stops.push(trackPresence(new PlayerDirectory(store, "b"), (previous, username) => { displaced.push(`${username}<-${previous.nodeId}`); }, { quiet: () => quiet }));
      playerCache.add(`h91${quiet ? 1 : 2}`, { username: name, location: { map: "main" } });
      await wait(20);
      playerCache.remove(`h91${quiet ? 1 : 2}`);
      stops.pop()!();
    }
    // Guard: options.quiet. A handoff arrival is not a displaced login.
    expect(displaced).toEqual(["Loud<-a"]);
  } finally {
    for (const stop of stops) stop();
  }
});

test("claim tells onSwap the entry its swap replaced before the set updates, which can fail", async () => {
  const store = new FlakyStore();
  await new PlayerDirectory(store, "a").claim("Hero", "1", "main");
  const directory = new PlayerDirectory(store, "b");
  const heard: Array<string | null> = [];
  const failing = spyOn(store, "removeFromSet").mockImplementation((async () => { throw new Error("redis down"); }) as any);
  await expect(directory.claim("Hero", "2", "main", (previous) => { heard.push(previous?.nodeId ?? null); })).rejects.toThrow("redis down");
  failing.mockRestore();
  expect(heard).toEqual(["a"]);
  // A name nobody held has no previous entry.
  await directory.claim("Fresh", "3", "main", (previous) => { heard.push(previous?.nodeId ?? null); });
  expect(heard).toEqual(["a", null]);
});

// ---------------------------------------------------------------- snapshots

test("snapshots pause while the store is down and resume when it is back, logged once each", async () => {
  let up = true;
  let writes = 0;
  const store = { set: async () => { writes++; } };
  const hero = { username: "Hero", ownerEpoch: 3, location: { map: "main.json", position: { x: 1, y: 1, direction: "up" } }, stats: null };
  const stop = new SnapshotWriter(store, () => [hero], { everyMs: 5, up: () => up }).start();
  try {
    await wait(30);
    expect(writes).toBeGreaterThan(0);
    up = false;
    await wait(10);
    const before = writes;
    await wait(40);
    // Guard: the up check in start(). Without it every pass fails once per player while Redis is away.
    expect(writes).toBe(before);
    expect(warned.filter((line) => line.includes("Snapshots pause")).length).toBe(1);
    up = true;
    await wait(30);
    expect(writes).toBeGreaterThan(before);
    // A second outage is logged again: the pause flag was reset by the resume.
    up = false;
    await wait(30);
    expect(warned.filter((line) => line.includes("Snapshots pause")).length).toBe(2);
  } finally {
    stop();
  }
});
