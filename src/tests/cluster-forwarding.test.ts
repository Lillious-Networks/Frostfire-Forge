import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { Delivery } from "../cluster/deliver";
import { PlayerDirectory } from "../cluster/directory";
import { ForwardTable, FORWARD_TTL_MS, redirectCall } from "../cluster/forwarding";
import { MemoryStore } from "../cluster/memorystore";
import log from "../modules/logger";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
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
let warnings: string[];
let errors: string[];
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  store = new MemoryStore();
  warnings = [];
  errors = [];
  warnSpy = spyOn(log, "warn").mockImplementation((message: string) => { warnings.push(String(message)); });
  errorSpy = spyOn(log, "error").mockImplementation((message: string) => { errors.push(String(message)); });
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

async function node(id: string, entries: Record<string, any>) {
  const bus = new ClusterBus(store, id, TEST_BUS_KEY);
  await bus.start();
  const directory = new PlayerDirectory(store, id);
  const delivery = new Delivery(players(entries));
  delivery.attach(bus, directory);
  return { bus, directory, delivery };
}

test("the table forgets an entry after its time", () => {
  const clock = { now: 0 };
  const table = new ForwardTable(() => clock.now);
  table.addPlayer("7", "Hero", "b");
  expect(table.to("player:7")).toBe("b");
  expect(table.to("user:hero")).toBe("b");
  clock.now = FORWARD_TTL_MS + 1;
  // Guard: the expiry in to(). Without it calls keep going to a node the player left long ago.
  expect(table.to("player:7")).toBeNull();
  expect(table.to("user:hero")).toBeNull();
});

test("the table keeps an entry up to its last moment and clear drops all", () => {
  const clock = { now: 0 };
  const table = new ForwardTable(() => clock.now);
  table.addCreature(42, "c");
  clock.now = FORWARD_TTL_MS;
  expect(table.to("creature:42")).toBe("c");
  table.forgetCreature(42);
  expect(table.to("creature:42")).toBeNull();
  table.addPlayer("7", "Hero", "b");
  table.clear();
  expect(table.to("player:7")).toBeNull();
});

test("forgetting a player removes both keys", () => {
  const table = new ForwardTable(() => 0);
  table.addPlayer("7", "Hero", "b");
  table.forgetPlayer("7", "HERO");
  expect(table.to("player:7")).toBeNull();
  expect(table.to("user:hero")).toBeNull();
});

test("the redirect sends each call about a moved entity to its new owner", () => {
  const table = new ForwardTable(() => 0);
  table.addPlayer("7", "Hero", "b");
  table.addCreature(42, "c");
  const redirect = redirectCall(table);
  expect(redirect("APPLY_EFFECT", { op: "player_hit", target: "7", body: {} }, "x")).toBe("b");
  expect(redirect("APPLY_EFFECT", { op: "creature_on_player", target: "7", body: {} }, "x")).toBe("b");
  expect(redirect("APPLY_EFFECT", { op: "creature_hit", target: 42, body: {} }, "x")).toBe("c");
  expect(redirect("APPLY_EFFECT", { op: "creature_threat", target: 42, body: {} }, "x")).toBe("c");
  expect(redirect("APPLY_REWARD", { playerId: "7", username: "Hero" }, "x")).toBe("b");
  // A reward whose id is not known (a new session) still finds the player by name.
  expect(redirect("APPLY_REWARD", { playerId: "99", username: "HERO" }, "x")).toBe("b");
  // The session id alone finds them too (the name on the share is the one the sender had).
  expect(redirect("APPLY_REWARD", { playerId: "7", username: "Renamed" }, "x")).toBe("b");
  expect(redirect("GRANT", { username: "hero", copper: 5 }, "x")).toBe("b");
  expect(redirect("APPLY_EFFECT", { op: "player_hit", target: "8", body: {} }, "x")).toBeNull();
  expect(redirect("TP_UPDATE", { username: "Hero" }, "x")).toBeNull();
});

test("expired entries are dropped when another is added, with no lookup", () => {
  const clock = { now: 0 };
  const table = new ForwardTable(() => clock.now);
  table.addPlayer("7", "Hero", "b");
  table.addCreature(42, "c");
  expect(table.size).toBe(3);
  clock.now = FORWARD_TTL_MS + 1;
  table.addCreature(43, "c");
  // Guard: the prune of expired entries in add(). Without it ids that nobody looks up again stay forever.
  expect(table.size).toBe(1);
  expect(table.to("creature:43")).toBe("c");
});

test("adding a key again moves it to the back, so the front is always the oldest", () => {
  const clock = { now: 0 };
  const table = new ForwardTable(() => clock.now);
  table.add("creature:1", "b");
  clock.now = 1_000;
  table.add("creature:2", "b");
  clock.now = 2_000;
  table.add("creature:1", "b");
  clock.now = 6_500;
  table.add("creature:3", "b");
  // Guard: delete before set in add(). Otherwise creature:1 keeps the front and shields the expired creature:2.
  expect(table.size).toBe(2);
  expect(table.to("creature:2")).toBeNull();
  expect(table.to("creature:1")).toBe("b");
});

test("the table holds at most its cap, dropping the oldest", () => {
  const table = new ForwardTable(() => 0, FORWARD_TTL_MS, 3);
  for (const id of [1, 2, 3, 4, 5]) table.addCreature(id, "b");
  // Guard: the cap in prune(). Within one TTL nothing expires, so only the cap bounds the table.
  expect(table.size).toBe(3);
  expect(table.to("creature:1")).toBeNull();
  expect(table.to("creature:2")).toBeNull();
  expect(table.to("creature:5")).toBe("b");
});

test("an empty id or name is never stored and never matches", () => {
  const table = new ForwardTable(() => 0);
  table.add("user:", "b");
  table.addPlayer("", "", "b");
  table.add("creature:3", "");
  // Guard: the empty-key refusal in add().
  expect(table.size).toBe(0);
  table.addPlayer("", "Hero", "b");
  expect(table.size).toBe(1);
  expect(table.to("user:")).toBeNull();
  expect(table.to("player:")).toBeNull();
  // Guard: the empty-key refusal in to(), should an entry for one ever get in by another way.
  (table as any).entries.set("user:", { to: "b", until: 1_000 });
  expect(table.to("user:")).toBeNull();
});

test("the redirect matches nothing for a body with no id or name", () => {
  const table = new ForwardTable(() => 0);
  // Keys a careless caller could have stored: what a missing field turns into.
  table.add("player:undefined", "b");
  table.add("user:undefined", "b");
  table.add("creature:NaN", "c");
  table.add("user:", "b");
  const redirect = redirectCall(table);
  // Guard: the type checks in redirectCall. A body with no username or playerId must not find a key.
  expect(redirect("APPLY_REWARD", {}, "x")).toBeNull();
  expect(redirect("APPLY_REWARD", { playerId: "", username: "" }, "x")).toBeNull();
  expect(redirect("APPLY_REWARD", { creatureId: 3, xp: 5 }, "x")).toBeNull();
  expect(redirect("GRANT", { copper: 5 }, "x")).toBeNull();
  expect(redirect("GRANT", { username: "", copper: 5 }, "x")).toBeNull();
  expect(redirect("APPLY_EFFECT", { op: "player_hit", body: {} }, "x")).toBeNull();
  expect(redirect("APPLY_EFFECT", { op: "creature_hit", target: Number.NaN, body: {} }, "x")).toBeNull();
  expect(redirect("APPLY_EFFECT", { op: "creature_hit", body: {} }, "x")).toBeNull();
});

test("the redirect never sends a reward or a grant for someone else, or after the entry ended", () => {
  const clock = { now: 0 };
  const table = new ForwardTable(() => clock.now);
  table.addPlayer("7", "Hero", "b");
  const redirect = redirectCall(table);
  // Guard: the player id and name keys are exact. Another player's reward or money stays here.
  expect(redirect("APPLY_REWARD", { playerId: "8", username: "Other" }, "x")).toBeNull();
  expect(redirect("GRANT", { username: "Other", copper: 5 }, "x")).toBeNull();
  expect(redirect("APPLY_REWARD", {}, "x")).toBeNull();
  expect(redirect("GRANT", null, "x")).toBeNull();
  expect(redirect("APPLY_EFFECT", { op: "creature_hit", target: 7, body: {} }, "x")).toBeNull();
  expect(redirect("APPLY_EFFECT", { op: "unknown_op", target: "7", body: {} }, "x")).toBeNull();
  clock.now = FORWARD_TTL_MS + 1;
  // Guard: the expiry. A reward for a player who came back, or logged in elsewhere, is not sent to the old peer.
  expect(redirect("APPLY_REWARD", { playerId: "7", username: "Hero" }, "x")).toBeNull();
  expect(redirect("GRANT", { username: "Hero", copper: 5 }, "x")).toBeNull();
});

test("a delivery for a player who left is passed on to the new node", async () => {
  const hero = fakeConnection();
  const a = await node("a", {});
  await node("b", { "7": { username: "Hero", ...hero } });
  a.delivery.setForwarder((username) => (username.toLowerCase() === "hero" ? "b" : null));
  // The directory does not have Hero yet: only the forwarder knows.
  expect(await a.delivery.deliverToPlayer("Hero", [encode("hi")])).toBe(true);
  await settle();
  expect(hero.sent).toEqual(["hi"]);
});

test("a first send keeps its best-effort flag when the forwarder takes it", async () => {
  const hero = fakeConnection();
  const a = await node("a", {});
  await node("b", { "7": { username: "Hero", ...hero } });
  a.delivery.setForwarder(() => "b");
  expect(await a.delivery.deliverToPlayer("Hero", [encode("m")], { bestEffort: true })).toBe(true);
  await settle();
  expect(hero.sent).toEqual(["~m"]);
});

test("a best-effort delivery stays best-effort when passed on", async () => {
  const hero = fakeConnection();
  const a = await node("a", {});
  await node("b", { "7": { username: "Hero", ...hero } });
  const c = await node("c", {});
  a.delivery.setForwarder(() => "b");
  await c.bus.toNode("a", "deliver", { username: "Hero", packets: [Buffer.from("m").toString("base64")], bestEffort: true });
  await settle();
  expect(hero.sent).toEqual(["~m"]);
});

test("a bus delivery that reaches the old node is passed on once", async () => {
  const hero = fakeConnection();
  const a = await node("a", {});
  await node("b", { "7": { username: "Hero", ...hero } });
  const c = await node("c", {});
  a.delivery.setForwarder(() => "b");
  // C still has Hero on A.
  await c.bus.toNode("a", "deliver", { username: "Hero", packets: [Buffer.from("late").toString("base64")], bestEffort: false });
  await settle();
  // Guard: the forwarder in the "deliver" handler.
  expect(hero.sent).toEqual(["late"]);
});

test("a delivery for a player who is here again is not passed on", async () => {
  const hero = fakeConnection();
  const other = fakeConnection();
  const a = await node("a", { "7": { username: "Hero", ...hero } });
  await node("b", { "8": { username: "Hero", ...other } });
  const c = await node("c", {});
  // A stale entry: Hero came back to A before it ended. The player here wins.
  a.delivery.setForwarder(() => "b");
  await c.bus.toNode("a", "deliver", { username: "Hero", packets: [Buffer.from("x").toString("base64")], bestEffort: false });
  await settle();
  expect(await a.delivery.deliverToPlayer("Hero", [encode("y")])).toBe(true);
  // Guard: the local lookup comes before the forwarder.
  expect(hero.sent).toEqual(["x", "y"]);
  expect(other.sent).toEqual([]);
});

test("a pass-on carries only the known fields", async () => {
  const hero = fakeConnection();
  const a = await node("a", {});
  await node("b", { "7": { username: "Hero", ...hero } });
  const c = await node("c", {});
  a.delivery.setForwarder(() => "b");
  const original = store.publish.bind(store);
  const toB: any[] = [];
  const publish = spyOn(store, "publish").mockImplementation((channel: string, message: string) => {
    if (channel.endsWith(":b")) toB.push(JSON.parse(message).data);
    return original(channel, message);
  });
  try {
    await c.bus.toNode("a", "deliver", { username: "Hero", packets: [Buffer.from("m").toString("base64")], bestEffort: false, junk: 1 });
    await c.bus.toNode("a", "player-action", { username: "Hero", action: "cells-grant", args: { copper: 5 }, junk: 1 });
    await settle();
  } finally {
    publish.mockRestore();
  }
  // Guard: the explicit field copy in the pass-on. A field a sender added is not carried to the next node.
  expect(toB.map((d) => Object.keys(d).sort())).toEqual([
    ["bestEffort", "hops", "packets", "username"],
    ["action", "args", "hops", "username"],
  ]);
  expect(toB.every((d) => d.hops === 1)).toBe(true);
  expect(hero.sent).toEqual(["m"]);
});

test("an action for a player who left runs on the new node once", async () => {
  const runs: string[] = [];
  const a = await node("a", {});
  const b = await node("b", { "7": { username: "Hero" } });
  b.delivery.registerAction("cells-grant", (player, args: any) => { runs.push(`${player.username}:${args.copper}`); });
  a.delivery.registerAction("cells-grant", () => { runs.push("ran on a"); });
  a.delivery.setForwarder(() => "b");
  const c = await node("c", {});
  await c.bus.toNode("a", "player-action", { username: "Hero", action: "cells-grant", args: { copper: 5 } });
  await settle();
  // Guard: the forwarder in the "player-action" handler.
  expect(runs).toEqual(["Hero:5"]);
});

test("an action for a player who is here again runs here, not on the forward target", async () => {
  const runs: string[] = [];
  const a = await node("a", { "7": { username: "Hero" } });
  const b = await node("b", { "8": { username: "Hero" } });
  a.delivery.registerAction("cells-grant", (_player, args: any) => { runs.push(`a:${args.copper}`); });
  b.delivery.registerAction("cells-grant", () => { runs.push("b"); });
  a.delivery.setForwarder(() => "b");
  const c = await node("c", {});
  await c.bus.toNode("a", "player-action", { username: "Hero", action: "cells-grant", args: { copper: 5 } });
  await settle();
  // Guard: the local lookup comes before the forwarder. Otherwise the grant lands on the node the player left.
  expect(runs).toEqual(["a:5"]);
});

test("a message passed between two nodes stops at the hop limit, and is logged once", async () => {
  const runs: string[] = [];
  const a = await node("a", {});
  const b = await node("b", {});
  for (const n of [a, b]) n.delivery.registerAction("cells-grant", () => { runs.push("ran"); });
  // A points at B and B points back at A: a loop the flag must break.
  a.delivery.setForwarder(() => "b");
  b.delivery.setForwarder(() => "a");
  const c = await node("c", {});
  await c.bus.toNode("a", "player-action", { username: "Hero", action: "cells-grant", args: { copper: 5 } });
  for (let i = 0; i < 4; i++) await settle();
  // Guard: MAX_FORWARD_HOPS in nextHop. Without it the action circles the two nodes for good.
  expect(runs).toEqual([]);
  const lost = warnings.filter((w) => w.includes('Player action "cells-grant" found no player Hero'));
  expect(lost.length).toBe(1);
});

test("an action by session id is never forwarded", async () => {
  const runs: string[] = [];
  const a = await node("a", {});
  const b = await node("b", { "7": { username: "Hero" } });
  b.delivery.registerAction("cells-kick", () => { runs.push("kicked on b"); });
  a.delivery.registerAction("cells-kick", () => { runs.push("kicked on a"); });
  a.delivery.setForwarder(() => "b");
  await a.delivery.runOnPlayerAt("a", "7", "cells-kick", {});
  await b.bus.toNode("a", "player-action", { playerId: "7", username: "Hero", action: "cells-kick", args: {} });
  await settle();
  // Guard: the playerId check. A session id on A is not the session on B.
  expect(runs).toEqual([]);
});

test("a forwarder that names this node passes nothing on", async () => {
  const runs: string[] = [];
  const a = await node("a", {});
  a.delivery.registerAction("cells-grant", () => { runs.push("ran"); });
  a.delivery.setForwarder(() => "a");
  const c = await node("c", {});
  await c.bus.toNode("a", "player-action", { username: "Hero", action: "cells-grant", args: { copper: 5 } });
  await settle();
  // Guard: the "never this node" check in forwardPeer. Without it the message goes to the node's own channel forever.
  expect(runs).toEqual([]);
  expect(warnings.filter((w) => w.includes("found no player Hero")).length).toBe(1);
  expect(await a.delivery.isOnline("Hero")).toBe(false);
});

test("runOnPlayer asks the forwarder before the directory", async () => {
  const runs: string[] = [];
  const a = await node("a", {});
  const b = await node("b", { "7": { username: "Hero" } });
  const c = await node("c", {});
  b.delivery.registerAction("cells-revive", () => { runs.push("b"); });
  c.delivery.registerAction("cells-revive", () => { runs.push("c"); });
  // The directory still has Hero on C (the old claim); the forwarder knows better.
  await c.directory.claim("Hero", "7", "main");
  a.delivery.setForwarder(() => "b");
  expect(await a.delivery.runOnPlayer("Hero", "cells-revive", { by: "Admin" })).toBe(true);
  await settle();
  expect(runs).toEqual(["b"]);
});

test("isOnline counts a player the forwarder knows", async () => {
  const a = await node("a", {});
  expect(await a.delivery.isOnline("Hero")).toBe(false);
  a.delivery.setForwarder(() => "b");
  // Guard: the forwarder check in isOnline.
  expect(await a.delivery.isOnline("Hero")).toBe(true);
});

test("a pass-on that cannot be published is reported and the action is logged as lost", async () => {
  const a = await node("a", {});
  a.delivery.setForwarder(() => "b");
  const publish = spyOn(store, "publish").mockRejectedValue(new Error("redis down"));
  try {
    // Guard: passOn's catch. The failure is an answer of false, not a throw into the caller.
    expect(await a.delivery.deliverToPlayer("Hero", [encode("hi")])).toBe(false);
    expect(await a.delivery.runOnPlayer("Hero", "cells-grant", { copper: 5 })).toBe(false);
  } finally {
    publish.mockRestore();
  }
  expect(errors.filter((e) => e.includes("on to b failed")).length).toBe(2);
});

test("a forwarded action whose pass-on fails is logged as lost, not dropped silently", async () => {
  const a = await node("a", {});
  a.delivery.setForwarder(() => "b");
  const c = await node("c", {});
  const original = store.publish.bind(store);
  const publish = spyOn(store, "publish").mockImplementation((channel: string, message: string) =>
    channel.endsWith(":b") ? Promise.reject(new Error("redis down")) : original(channel, message));
  try {
    await c.bus.toNode("a", "player-action", { username: "Hero", action: "cells-grant", args: { copper: 5 } });
    await settle();
  } finally {
    publish.mockRestore();
  }
  // Guard: the false from passOn falls through to the lost warning.
  expect(errors.filter((e) => e.includes("on to b failed")).length).toBe(1);
  expect(warnings.filter((w) => w.includes('Player action "cells-grant" found no player Hero')).length).toBe(1);
});

test("setForwarder answers the one set before", () => {
  const delivery = new Delivery(players({}));
  const first = () => "b";
  expect(delivery.setForwarder(first)).toBeNull();
  expect(delivery.setForwarder(null)).toBe(first);
});
