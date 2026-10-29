import { beforeEach, expect, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { Delivery } from "../cluster/deliver";
import { PlayerDirectory } from "../cluster/directory";
import { MemoryStore } from "../cluster/memorystore";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

// Social systems change a member's cached player (a party id cleared) and
// send them a packet. Both happen in an action on the node holding the member.

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

function member(username: string, fields: Record<string, any> = {}): any {
  const sent: string[] = [];
  return { username, ...fields, sent, wt: { readyState: 1, send: (p: Uint8Array) => sent.push(decode(p)), sendBestEffort: (p: Uint8Array) => sent.push(`~${decode(p)}`) } };
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
  // Registered the way receiver.ts registers its actions: once, by name, on every node.
  delivery.registerAction("leave-party", (player, args) => {
    player.party_id = null;
    player.wt.send(encode(`left:${args.reason}`));
  });
  return delivery;
}

test("an action clears a member's party on the node that holds them", async () => {
  const hero = member("Hero", { party_id: 12 });
  const a = await node("a", {});
  await node("b", { "7": hero });
  expect(await a.runOnPlayer("hero", "leave-party", { reason: "kicked" })).toBe(true);
  await settle();
  expect(hero.party_id).toBeNull();
  expect(hero.sent).toEqual(["left:kicked"]);
});

test("the same action runs at once for a member on this node", async () => {
  const hero = member("Hero", { party_id: 12 });
  const a = await node("a", { "7": hero });
  expect(await a.runOnPlayer("hero", "leave-party", { reason: "disbanded" })).toBe(true);
  expect(hero.party_id).toBeNull();
  expect(hero.sent).toEqual(["left:disbanded"]);
});

test("a member who is offline everywhere is reported so", async () => {
  const a = await node("a", {});
  await node("b", {});
  expect(await a.runOnPlayer("ghost", "leave-party", { reason: "kicked" })).toBe(false);
  expect(await a.deliverToPlayer("ghost", [encode("hi")])).toBe(false);
  expect(await a.isOnline("ghost")).toBe(false);
});

test("party HP frames reach a member on another node best effort", async () => {
  const hero = member("Hero");
  const a = await node("a", {});
  await node("b", { "7": hero });
  expect(await a.deliverToPlayer("hero", [encode("hp")], { bestEffort: true })).toBe(true);
  await settle();
  expect(hero.sent).toEqual(["~hp"]);
});
