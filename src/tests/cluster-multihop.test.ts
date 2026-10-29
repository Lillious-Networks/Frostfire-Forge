import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { Delivery, hopsOf } from "../cluster/deliver";
import { PlayerDirectory } from "../cluster/directory";
import { FORWARD_CALL, LinkCalls, MAX_FORWARD_HOPS, MAX_INFLIGHT_PER_PEER, neverRan } from "../cluster/linkcalls";
import { MemoryStore } from "../cluster/memorystore";
import log from "../modules/logger";
import { linkMesh, settle } from "./cluster-fakelink";

const NAMES = ["a", "b", "c", "d", "e", "f"] as const;
type Name = (typeof NAMES)[number];

function mesh(timeoutMs = 500) {
  const links = linkMesh(NAMES);
  const calls = Object.fromEntries(NAMES.map((name) => [name, new LinkCalls(timeoutMs)])) as Record<Name, LinkCalls>;
  for (const name of NAMES) calls[name].attach(links[name]);
  const stop = () => { for (const name of NAMES) calls[name].detach(); };
  return { calls, links, stop };
}

/** The entity walked b -> c -> d -> ...: each node redirects to the next one in `chain`. */
function chainOf(calls: Record<Name, LinkCalls>, chain: Name[]) {
  for (let i = 0; i < chain.length - 1; i++) {
    const next = chain[i + 1]!;
    calls[chain[i]!].setRedirect((name) => (name === "HIT" ? next : null));
  }
}

test("a call follows the entity over three hops, and runs as from its sender", async () => {
  const { calls, stop } = mesh();
  try {
    const seen: string[] = [];
    calls.e.handle("HIT", (_body, from) => { seen.push(from); return "e"; });
    // a calls b; b -> c is the first forward (hops 1), c -> d hops 2, d -> e hops 3.
    chainOf(calls, ["b", "c", "d", "e"]);
    expect(await calls.a.call("b", "HIT", {})).toEqual({ ok: true, answer: "e" });
    expect(seen).toEqual(["a"]);
  } finally {
    stop();
  }
});

test("a call that would need a fourth forward fails, and runs nowhere", async () => {
  const { calls, stop } = mesh();
  try {
    const runs: string[] = [];
    for (const name of NAMES) calls[name].handle("HIT", () => { runs.push(name); return name; });
    chainOf(calls, ["b", "c", "d", "e", "f"]);
    // Guard: the hops check in forwarded(). Without it the call goes on to f.
    expect(await calls.a.call("b", "HIT", {})).toEqual({ ok: false, why: "failed" });
    expect(runs).toEqual([]);
    expect(MAX_FORWARD_HOPS).toBe(3);
  } finally {
    stop();
  }
});

test("a forward is never sent back to the original caller: it runs where it is", async () => {
  const { calls, stop } = mesh();
  try {
    calls.c.handle("HIT", () => "c");
    calls.a.handle("HIT", () => "a");
    calls.b.setRedirect(() => "c");
    calls.c.setRedirect(() => "a");
    // Guard: to !== from in forwarded(). a would refuse a forward naming itself, and the call would fail.
    expect(await calls.a.call("b", "HIT", {})).toEqual({ ok: true, answer: "c" });
  } finally {
    stop();
  }
});

test("a forward bounced back to the node before it fails at once, and runs nowhere", async () => {
  const { calls, stop } = mesh();
  try {
    const runs: string[] = [];
    for (const name of NAMES) calls[name].handle("HIT", () => { runs.push(name); return name; });
    let askedB = 0;
    calls.b.setRedirect(() => { askedB++; return "c"; });
    calls.c.setRedirect(() => "b");
    // b forwards to c (hops 1); c's redirect names b, the node that forwarded it: the two disagree about the owner,
    // and c fails it without passing it back.
    expect(await calls.a.call("b", "HIT", {})).toEqual({ ok: false, why: "failed" });
    expect(runs).toEqual([]);
    // Guard: to === sender in forwarded(). Without it c passes the forward back to b, which asks its redirect again.
    expect(askedB).toBe(1);
  } finally {
    stop();
  }
});

test("a loop over three nodes ends at the hop limit, and runs nowhere", async () => {
  const { calls, stop } = mesh();
  try {
    const runs: string[] = [];
    for (const name of NAMES) calls[name].handle("HIT", () => { runs.push(name); return name; });
    calls.b.setRedirect(() => "c");
    calls.c.setRedirect(() => "d");
    calls.d.setRedirect(() => "b");
    expect(await calls.a.call("b", "HIT", {})).toEqual({ ok: false, why: "failed" });
    expect(runs).toEqual([]);
  } finally {
    stop();
  }
});

// ---- an onward forward that fails after the first hop: the call ran at most once, and is never reported never-ran

test("an onward forward over a link that is down fails the call, which runs nowhere", async () => {
  const { calls, links, stop } = mesh();
  try {
    const runs: string[] = [];
    for (const name of NAMES) calls[name].handle("HIT", () => { runs.push(name); return name; });
    chainOf(calls, ["b", "c", "d"]);
    links.c.setUp("d", false);
    const outcome = await calls.a.call("b", "HIT", {});
    // Guard: the not-ok check after the onward call in forwarded(). Taken as ok, a gets an answer for a call that
    // ran nowhere; run here instead, c runs a call d may have run.
    expect(outcome).toEqual({ ok: false, why: "failed" });
    expect(neverRan(outcome)).toBe(false);
    expect(runs).toEqual([]);
  } finally {
    stop();
  }
});

test("an onward forward that times out fails the call; it runs once, at the end of the chain only", async () => {
  const { calls, stop } = mesh(100);
  try {
    const runs: string[] = [];
    for (const name of NAMES) {
      calls[name].handle("HIT", async () => {
        runs.push(name);
        if (name === "d") await Bun.sleep(250);
        return name;
      });
    }
    chainOf(calls, ["b", "c", "d"]);
    const outcome = await calls.a.call("b", "HIT", {});
    expect(outcome.ok).toBe(false);
    expect(neverRan(outcome)).toBe(false);
    await Bun.sleep(300);
    // Guard: a timed-out onward forward is never run here: d may have run it (and does).
    expect(runs).toEqual(["d"]);
  } finally {
    stop();
  }
});

test("an onward forward answered busy fails the call (not busy), and it runs nowhere", async () => {
  const { calls, stop } = mesh();
  const releases: Array<() => void> = [];
  try {
    const runs: string[] = [];
    for (const name of NAMES) calls[name].handle("HIT", () => { runs.push(name); return name; });
    calls.d.handle("HOLD", () => new Promise<void>((resolve) => { releases.push(resolve); }));
    // c fills its share of d: d answers c's next call busy.
    const held = Array.from({ length: MAX_INFLIGHT_PER_PEER }, () => calls.c.call("d", "HOLD", null));
    await settle();
    expect(releases.length).toBe(MAX_INFLIGHT_PER_PEER);
    chainOf(calls, ["b", "c", "d"]);
    const outcome = await calls.a.call("b", "HIT", {});
    // A busy answer is about c's call to d only: a, two hops back, gets failed, never busy (which neverRan reads
    // as never run).
    expect(outcome).toEqual({ ok: false, why: "failed" });
    expect(neverRan(outcome)).toBe(false);
    expect(runs).toEqual([]);
    for (const release of releases) release();
    await Promise.all(held);
  } finally {
    for (const release of releases) release();
    stop();
  }
});

test("the same forward sent twice through a middle node runs once at the end", async () => {
  const { calls, stop } = mesh();
  try {
    let runs = 0;
    calls.d.handle("GRANT", () => ++runs);
    calls.c.setRedirect((name) => (name === "GRANT" ? "d" : null));
    const body = { from: "a", epoch: "e1", seq: 1, name: "GRANT", body: {}, hops: 1 };
    expect(await calls.b.call("c", FORWARD_CALL, body)).toEqual({ ok: true, answer: { answer: 1 } });
    // Guard: window.settle after the onward forward. Without it the copy is forwarded again and d decides alone.
    expect(await calls.b.call("c", FORWARD_CALL, body)).toEqual({ ok: true, answer: { answer: 1 } });
    expect(runs).toBe(1);
  } finally {
    stop();
  }
});

test("a forward with no hops field counts as the first", async () => {
  const { calls, stop } = mesh();
  try {
    calls.f.handle("HIT", () => "f");
    chainOf(calls, ["c", "d", "e", "f"]);
    const body = { from: "a", epoch: "e1", seq: 1, name: "HIT", body: {} };
    // c (hops 1) -> d (2) -> e (3); e may not pass it to f.
    expect(await calls.b.call("c", FORWARD_CALL, body)).toEqual({ ok: true, answer: { failed: true } });
  } finally {
    stop();
  }
});

// ---- bus messages

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const settleLong = async () => { for (let i = 0; i < 6; i++) await settle(); };

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
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  store = new MemoryStore();
  warnings = [];
  spies.push(
    spyOn(log, "warn").mockImplementation((message: string) => { warnings.push(String(message)); }),
    spyOn(log, "error").mockImplementation(() => {}),
  );
});
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

async function node(id: string, entries: Record<string, any> = {}) {
  const bus = new ClusterBus(store, id, TEST_BUS_KEY);
  await bus.start();
  const directory = new PlayerDirectory(store, id);
  const delivery = new Delivery(players(entries));
  delivery.attach(bus, directory);
  return { bus, directory, delivery };
}

const wire = (text: string) => [Buffer.from(text).toString("base64")];

test("hopsOf reads hops, and the old forwarded flag as one", () => {
  expect(hopsOf({ hops: 2 })).toBe(2);
  expect(hopsOf({ forwarded: true })).toBe(1);
  expect(hopsOf({})).toBe(0);
  expect(hopsOf({ hops: -1 })).toBe(0);
});

test("a delivery follows the forward tables over three hops, and no further", async () => {
  const near = fakeConnection();
  const a = await node("a");
  const b = await node("b");
  const c = await node("c");
  await node("d", { "7": { username: "Hero", ...near } });
  a.delivery.setForwarder(() => "b");
  b.delivery.setForwarder(() => "c");
  c.delivery.setForwarder(() => "d");
  const sender = await node("s");
  await sender.bus.toNode("a", "deliver", { username: "Hero", packets: wire("m"), bestEffort: false });
  await settleLong();
  expect(near.sent).toEqual(["m"]);
});

test("a delivery that would need a fourth hop is dropped", async () => {
  const far = fakeConnection();
  const a = await node("a");
  const b = await node("b");
  const c = await node("c");
  const d = await node("d");
  await node("e", { "7": { username: "Hero", ...far } });
  a.delivery.setForwarder(() => "b");
  b.delivery.setForwarder(() => "c");
  c.delivery.setForwarder(() => "d");
  d.delivery.setForwarder(() => "e");
  const sender = await node("s");
  await sender.bus.toNode("a", "deliver", { username: "Hero", packets: wire("m"), bestEffort: false });
  await settleLong();
  // Guard: hops >= MAX_FORWARD_HOPS in nextHop. Without it a forward-table loop never ends.
  expect(far.sent).toEqual([]);
});

test("a node with no forward entry passes a delivery to the node a newer directory epoch names", async () => {
  const hero = fakeConnection();
  const a = await node("a");
  const b = await node("b", { "8": { username: "Hero", ...hero } });
  const first = await a.directory.claim("Hero", "7", "main");
  await b.directory.claim("Hero", "8", "main");
  const sender = await node("s");
  // The sender read the directory at the first epoch (Hero on a).
  await sender.bus.toNode("a", "deliver", { username: "Hero", packets: wire("m"), bestEffort: false, epoch: first.entry.epoch });
  await settleLong();
  expect(hero.sent).toEqual(["m"]);
});

test("a delivery sent at the directory's current epoch is not passed on", async () => {
  const hero = fakeConnection();
  const a = await node("a");
  await a.directory.claim("Hero", "7", "main");
  const latest = await (await node("x", { "8": { username: "Hero", ...hero } })).directory.claim("Hero", "8", "main");
  // The entry names x now, at the epoch the sender read: a has nothing newer to go by. The sender, which read the
  // entry, reaches x itself; a passing it on as well would hand x a second copy.
  const sender = await node("s");
  await sender.bus.toNode("a", "deliver", { username: "Hero", packets: wire("m"), bestEffort: false, epoch: latest.entry.epoch });
  await settleLong();
  // Guard: entry.epoch > the sent epoch. Without it a passes on what the sender already knew.
  expect(hero.sent).toEqual([]);
});

test("deliverToPlayer and runOnPlayer send the epoch they read", async () => {
  const a = await node("a");
  const b = await node("b", { "8": { username: "Hero", ...fakeConnection() } });
  const claim = await b.directory.claim("Hero", "8", "main");
  const seen: any[] = [];
  const original = store.publish.bind(store);
  const publish = spyOn(store, "publish").mockImplementation((channel: string, message: string) => {
    if (channel.endsWith(":b")) seen.push(JSON.parse(message).data);
    return original(channel, message);
  });
  try {
    b.delivery.registerAction("test-hop", () => {});
    await a.delivery.deliverToPlayer("Hero", [encode("m")]);
    await a.delivery.runOnPlayer("Hero", "test-hop", { n: 1 });
    await settle();
  } finally {
    publish.mockRestore();
  }
  expect(seen.map((d) => d.epoch)).toEqual([claim.entry.epoch, claim.entry.epoch]);
});

test("a directory entry naming this node is never followed: the action is logged lost once, and not sent again", async () => {
  const a = await node("a");
  a.delivery.registerAction("test-hop", () => {}, (args) => `${args.copper} copper`);
  // Hero claimed on a twice (the player is gone from a now): the entry names a under a newer epoch than the sender read.
  const first = await a.directory.claim("Hero", "7", "main");
  await a.directory.claim("Hero", "8", "main");
  const sender = await node("s");
  const toA: any[] = [];
  const original = store.publish.bind(store);
  const publish = spyOn(store, "publish").mockImplementation((channel: string, message: string) => {
    if (channel.endsWith(":a")) toA.push(JSON.parse(message).data);
    return original(channel, message);
  });
  try {
    await sender.bus.toNode("a", "player-action", { username: "Hero", action: "test-hop", args: { copper: 5 }, epoch: first.entry.epoch });
    await settleLong();
  } finally {
    publish.mockRestore();
  }
  // Guard: entry.nodeId !== this node in nextHop. Without it a sends the action to itself until the hop limit.
  expect(toA.length).toBe(1);
  expect(warnings.filter((w) => w.includes('Player action "test-hop" found no player Hero'))).toEqual([
    'Player action "test-hop" found no player Hero here: 5 copper',
  ]);
});

test("a forward-table pass-on carries the epoch the sender read", async () => {
  const hero = fakeConnection();
  const a = await node("a");
  await node("b", { "8": { username: "Hero", ...hero } });
  a.delivery.setForwarder(() => "b");
  // The sender read Hero's entry (on x); a's forward table names b. b is told the epoch the sender read, so it never
  // follows an entry older than that one.
  const latest = await (await node("x")).directory.claim("Hero", "8", "main");
  const toB: any[] = [];
  const original = store.publish.bind(store);
  const publish = spyOn(store, "publish").mockImplementation((channel: string, message: string) => {
    if (channel.endsWith(":b")) toB.push(JSON.parse(message).data);
    return original(channel, message);
  });
  try {
    const sender = await node("s");
    await sender.bus.toNode("a", "deliver", { username: "Hero", packets: wire("m"), bestEffort: false, epoch: latest.entry.epoch });
    await settleLong();
  } finally {
    publish.mockRestore();
  }
  // Guard: the received epoch on a forward-table hop. Without it b reads the message as sent at epoch 0.
  expect(toB.map((d) => d.epoch)).toEqual([latest.entry.epoch]);
  expect(hero.sent).toEqual(["m"]);
});

test("an action the directory passes on is logged with what it carried", async () => {
  const runs: string[] = [];
  const a = await node("a");
  const b = await node("b", { "8": { username: "Hero", ...fakeConnection() } });
  b.delivery.registerAction("test-grant", (player, args) => { runs.push(`${player.username}:${args.copper}`); });
  a.delivery.registerAction("test-grant", () => { runs.push("a"); }, (args) => `${args.copper} copper`);
  const first = await a.directory.claim("Hero", "7", "main");
  await b.directory.claim("Hero", "8", "main");
  const sender = await node("s");
  await sender.bus.toNode("a", "player-action", { username: "Hero", action: "test-grant", args: { copper: 5 }, epoch: first.entry.epoch });
  await settleLong();
  expect(runs).toEqual(["Hero:5"]);
  // Guard: the log on a directory pass-on. b may have died since its claim; the grant is then named in a's log.
  expect(warnings).toEqual(['Player action "test-grant" found no player Hero here, passed on to b by the directory: 5 copper']);
});

test("an action by name follows a newer epoch; one by session id never moves", async () => {
  const runs: string[] = [];
  const a = await node("a");
  const b = await node("b", { "8": { username: "Hero", ...fakeConnection() } });
  b.delivery.registerAction("test-hop", (player) => { runs.push(player.username); });
  a.delivery.registerAction("test-hop", () => { runs.push("a"); });
  const first = await a.directory.claim("Hero", "7", "main");
  await b.directory.claim("Hero", "8", "main");
  const sender = await node("s");
  await sender.bus.toNode("a", "player-action", { username: "Hero", action: "test-hop", args: {}, epoch: first.entry.epoch });
  await sender.bus.toNode("a", "player-action", { playerId: "7", action: "test-hop", args: {} });
  await settleLong();
  expect(runs).toEqual(["Hero"]);
  expect(warnings.filter((w) => w.includes('Player action "test-hop" found no player 7')).length).toBe(1);
});
