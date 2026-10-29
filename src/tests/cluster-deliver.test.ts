import { beforeEach, expect, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { Delivery } from "../cluster/deliver";
import { PlayerDirectory } from "../cluster/directory";
import { MemoryStore } from "../cluster/memorystore";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
// Published messages arrive on the next immediate; five turns covers a message that triggers another.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

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

let store: MemoryStore;
beforeEach(() => { store = new MemoryStore(); });

async function node(id: string, entries: Record<string, any>) {
  const bus = new ClusterBus(store, id, TEST_BUS_KEY);
  await bus.start();
  const directory = new PlayerDirectory(store, id);
  const delivery = new Delivery(players(entries));
  delivery.attach(bus, directory);
  for (const [key, p] of Object.entries(entries)) await directory.claim(p.username, key, "main");
  return delivery;
}

test("without a cluster, delivery is local only", async () => {
  const hero = fakeConnection();
  const delivery = new Delivery(players({ "1": { username: "Hero", ...hero } }));
  expect(await delivery.deliverToPlayer("hero", [encode("hi")])).toBe(true);
  expect(await delivery.deliverToPlayer("nobody", [encode("hi")])).toBe(false);
  expect(hero.sent).toEqual(["hi"]);
});

test("a player on another node gets the packets", async () => {
  const hero = fakeConnection();
  const a = await node("a", {});
  await node("b", { "7": { username: "Hero", ...hero } });
  expect(await a.deliverToPlayer("hero", [encode("one"), encode("two")], { bestEffort: true })).toBe(true);
  await settle();
  expect(hero.sent).toEqual(["~one", "~two"]);
});

test("a world broadcast reaches players on every node once", async () => {
  const x = fakeConnection();
  const y = fakeConnection();
  const a = await node("a", { "1": { username: "X", ...x } });
  await node("b", { "2": { username: "Y", ...y } });
  await a.broadcastWorld([encode("news")]);
  await settle();
  expect(x.sent).toEqual(["news"]);
  expect(y.sent).toEqual(["news"]);
});

test("a world broadcast that cannot be published still reaches this node's players", async () => {
  const x = fakeConnection();
  const a = await node("a", { "1": { username: "X", ...x } });
  store.publish = async () => { throw new Error("redis is down"); };
  await a.broadcastWorld([encode("news")]);
  await settle();
  expect(x.sent).toEqual(["news"]);
});

test("an action runs where the player is", async () => {
  const ran: string[] = [];
  const a = await node("a", {});
  const b = await node("b", { "7": { username: "Hero", ...fakeConnection() } });
  for (const each of [a, b]) each.registerAction("greet", (player, args) => { ran.push(`${player.username}:${args.word}`); });
  expect(await a.runOnPlayer("hero", "greet", { word: "hi" })).toBe(true);
  await settle();
  expect(ran).toEqual(["Hero:hi"]);
  expect(await a.runOnPlayer("nobody", "greet", {})).toBe(false);
});

test("isOnline looks across nodes", async () => {
  const a = await node("a", {});
  await node("b", { "7": { username: "Hero", ...fakeConnection() } });
  expect(await a.isOnline("hero")).toBe(true);
  expect(await a.isOnline("nobody")).toBe(false);
});

// A store whose reads and publishes can be made to fail, as Redis does when it goes away.
class FlakyStore extends MemoryStore {
  failing = false;
  override async get(key: string) {
    if (this.failing) throw new Error("redis down");
    return super.get(key);
  }
  override async publish(channel: string, message: string) {
    if (this.failing) throw new Error("redis down");
    return super.publish(channel, message);
  }
}

async function nodeOn(flaky: FlakyStore, id: string, entries: Record<string, any>) {
  const bus = new ClusterBus(flaky, id, TEST_BUS_KEY);
  await bus.start();
  const directory = new PlayerDirectory(flaky, id);
  const delivery = new Delivery(players(entries));
  delivery.attach(bus, directory);
  for (const [key, p] of Object.entries(entries)) await directory.claim(p.username, key, "main");
  return delivery;
}

test("a failing lookup never throws out of delivery", async () => {
  const flaky = new FlakyStore();
  const a = await nodeOn(flaky, "a", {});
  flaky.failing = true;
  expect(await a.deliverToPlayer("hero", [encode("hi")])).toBe(false);
  expect(await a.runOnPlayer("hero", "greet", {})).toBe(false);
  expect(await a.isOnline("hero")).toBe(false);
  await a.runOnPlayerAt("b", "7", "greet", {});
});

test("a failing publish never throws out of delivery", async () => {
  const flaky = new FlakyStore();
  const a = await nodeOn(flaky, "a", {});
  await nodeOn(flaky, "b", { "7": { username: "Hero", ...fakeConnection() } });
  // The lookup works; only the publish fails.
  flaky.get = MemoryStore.prototype.get;
  flaky.failing = true;
  expect(await a.deliverToPlayer("hero", [encode("hi")])).toBe(false);
  expect(await a.runOnPlayer("hero", "greet", {})).toBe(false);
  await a.runOnPlayerAt("b", "7", "greet", {});
  await a.broadcastWorld([encode("news")]);
});

test("a local player is still reached while the cluster is failing", async () => {
  const flaky = new FlakyStore();
  const hero = fakeConnection();
  const a = await nodeOn(flaky, "a", { "1": { username: "Hero", ...hero } });
  flaky.failing = true;
  expect(await a.deliverToPlayer("hero", [encode("hi")])).toBe(true);
  expect(await a.isOnline("hero")).toBe(true);
  expect(hero.sent).toEqual(["hi"]);
});
