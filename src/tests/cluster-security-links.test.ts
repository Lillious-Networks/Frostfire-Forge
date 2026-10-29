import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebTransport } from "@lillious-networks/webtransport-bun";
import { startCluster, stopCluster, clusterNodes } from "../cluster";
import { BUS_START_SKEW_MS, BUS_WINDOW_MS, BusNonces, ClusterBus, WORLD_CHANNEL, busSignature, nodeChannel, sealEnvelope } from "../cluster/bus";
import { CLUSTER_SECRET_MIN_LENGTH, deriveClusterKeys, requireClusterKeys } from "../cluster/clusterkeys";
import { nodeLinkBindHost, nodeLinkBindWarning } from "../cluster/config";
import { delivery } from "../cluster/deliver";
import { resetEntityIds } from "../cluster/entityids";
import { guardedTeleport } from "../cluster/handoffguards";
import { packetsInFlight } from "../cluster/inflight";
import { invitations } from "../cluster/invitations";
import { NodeLinks, PRE_HELLO_MS, type NodeLinksOptions } from "../cluster/links";
import { encodeLinkFrame, makeHello } from "../cluster/linkproto";
import type { LinkChannel, LinkTransport } from "../cluster/linktransport";
import { LoopbackNetwork } from "../cluster/loopback";
import { MemoryStore } from "../cluster/memorystore";
import { NodeRegistry, type NodeInfo } from "../cluster/nodes";
import { PRE_HELLO_PER_SOURCE, PreHelloGate, STREAM_WAIT_MS, WebTransportLinks, type WebTransportLinksOptions } from "../cluster/wtlinks";
import log from "../modules/logger";
import { generateLocalCertificate } from "../utility/local_cert";

// Security review S1: H2 (a cluster secret of its own, split by HKDF, and no replacing a live link), H1 (signed bus
// envelopes) and M1 (the link listener's limits before the hello). Every secret here is a made-up test value.

const CLUSTER_SECRET = "security-test-cluster-secret-0123456789abcdef";
// Stands in for GATEWAY_GAME_SERVER_SECRET: the key client tickets keep, which must not open a node link.
const GATEWAY_SECRET = "security-test-gateway-secret-0123456789abcdef";
const KEYS = deriveClusterKeys(CLUSTER_SECRET);

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await Bun.sleep(5);
  }
};
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

const info = (nodeId: string, host: string, port: number): NodeInfo => ({
  nodeId, regionId: "r", publicHost: `${nodeId}.example`, port: 1, wtPort: 1, useSSL: true, startedAt: 0,
  linkHost: host, linkPort: port, certHash: "",
});

const made: NodeLinks[] = [];
afterEach(async () => { for (const links of made.splice(0)) await links.stop(); });

function links(transport: LinkTransport, self: string, directory: Map<string, NodeInfo>, extra: Partial<NodeLinksOptions> = {}) {
  const node = new NodeLinks({ self, secret: KEYS.link, transport, nodeInfo: async (id) => directory.get(id) ?? null, pingMs: 20, deadMs: 80, lingerMs: 50, ...extra });
  made.push(node);
  return node;
}

/** A transport that records why the node closed each channel it accepted. */
function recording(real: LinkTransport, reasons: string[]): LinkTransport {
  return {
    listen: (accept) => real.listen((channel) => {
      const close = channel.close.bind(channel);
      channel.close = (reason) => { reasons.push(reason); close(reason); };
      accept(channel);
    }),
    dial: (peer) => real.dial(peer),
    stop: () => real.stop(),
  };
}

const idle = { frame: () => {}, datagram: () => {}, closed: () => {} };

// ================================================================== H2: the keys

test("the cluster secret gives two different keys, neither of them the secret, the same each time", () => {
  expect(KEYS.link).toMatch(/^[0-9a-f]{64}$/);
  expect(KEYS.bus).toMatch(/^[0-9a-f]{64}$/);
  expect(KEYS.link).not.toBe(KEYS.bus);
  expect(KEYS.link).not.toBe(CLUSTER_SECRET);
  expect(deriveClusterKeys(CLUSTER_SECRET)).toEqual(KEYS);
  expect(deriveClusterKeys(GATEWAY_SECRET).link).not.toBe(KEYS.link);
});

test("the keys need CLUSTER_LINK_SECRET of at least 32 characters, and the error never shows the value", () => {
  expect(() => requireClusterKeys({})).toThrow(/CLUSTER_LINK_SECRET.*not set/);
  expect(() => requireClusterKeys({ CLUSTER_LINK_SECRET: "" })).toThrow(/not set/);
  const short = "x".repeat(CLUSTER_SECRET_MIN_LENGTH - 1);
  let message = "";
  try {
    requireClusterKeys({ CLUSTER_LINK_SECRET: short });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("too short");
  expect(message).not.toContain(short);
  expect(requireClusterKeys({ CLUSTER_LINK_SECRET: "y".repeat(CLUSTER_SECRET_MIN_LENGTH) })).toEqual(deriveClusterKeys("y".repeat(32)));
});

test("a hello signed with the gateway secret, the raw cluster secret or the bus key is refused; the link key is taken", async () => {
  const net = new LoopbackNetwork();
  const directory = new Map([["a", info("a", "a.loop", 7001)], ["b", info("b", "b.loop", 7002)]]);
  const refused: string[] = [];
  const b = links(recording(net.transport("b.loop", 7002), refused), "b", directory);
  await b.start();
  const fake = net.transport("a.loop", 7001);
  for (const wrong of [GATEWAY_SECRET, CLUSTER_SECRET, KEYS.bus]) {
    const channel = await fake.dial({ host: "b.loop", port: 7002, certHash: "" });
    channel.start(idle);
    channel.send(encodeLinkFrame("LINK_HELLO", makeHello(wrong, "a", "b", Date.now())));
  }
  await until(() => refused.length === 3);
  expect(refused).toEqual(["bad hello", "bad hello", "bad hello"]);
  expect(b.isUp("a")).toBe(false);
  const good = await fake.dial({ host: "b.loop", port: 7002, certHash: "" });
  good.start(idle);
  good.send(encodeLinkFrame("LINK_HELLO", makeHello(KEYS.link, "a", "b", Date.now())));
  await until(() => b.isUp("a"));
  await fake.stop();
});

// ================================================================== H2: no replacing a live link

test("a hello for a peer whose link is up and live is refused, and a stale one is replaced", async () => {
  const net = new LoopbackNetwork();
  const directory = new Map([["a", info("a", "a.loop", 7001)], ["b", info("b", "b.loop", 7002)]]);
  let clock = 5_000_000;
  const refused: string[] = [];
  const b = links(recording(net.transport("b.loop", 7002), refused), "b", directory, { pingMs: 60_000, deadMs: 1_000, now: () => clock });
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    await b.start();
    const fake = net.transport("a.loop", 7001);
    const closes: string[] = [];
    const hello = async (name: string) => {
      const channel = await fake.dial({ host: "b.loop", port: 7002, certHash: "" });
      channel.start({ ...idle, closed: (reason) => closes.push(`${name}:${reason}`) });
      channel.send(encodeLinkFrame("LINK_HELLO", makeHello(KEYS.link, "a", "b", clock)));
    };
    await hello("first");
    await until(() => b.isUp("a"));
    // Live (heard from 500 ms ago): a second channel, even with a good hello, does not take the link.
    clock += 500;
    await hello("intruder");
    await until(() => closes.length === 1);
    expect(closes).toEqual(["intruder:link already up"]);
    expect(refused).toEqual(["link already up"]);
    expect(warns.mock.calls.some((call) => String(call[0]).includes("refused: its link is up and live"))).toBe(true);
    // Stale (nothing for longer than deadMs): a restarted peer's hello replaces the old channel.
    clock += 1_500;
    await hello("restarted");
    await until(() => closes.length === 2);
    expect(closes[1]).toBe("first:replaced");
    expect(b.isUp("a")).toBe(true);
    await fake.stop();
  } finally {
    warns.mockRestore();
  }
});

test("a peer that really restarts gets its link back: refused while the old link is live, taken once it is dropped", async () => {
  const net = new LoopbackNetwork();
  const directory = new Map([["a", info("a", "a.loop", 7001)], ["b", info("b", "b.loop", 7002)]]);
  const refused: string[] = [];
  const b = links(recording(net.transport("b.loop", 7002), refused), "b", directory, { pingMs: 50, deadMs: 400 });
  const a1Transport = net.transport("a.loop", 7001);
  const a1 = links(a1Transport, "a", directory, { pingMs: 50, deadMs: 400 });
  const downs: string[] = [];
  b.onPeerDown((peer) => downs.push(peer));
  await b.start();
  await a1.start();
  a1.want(["b"]);
  b.want(["a"]);
  await until(() => a1.isUp("b") && b.isUp("a"));
  // a dies hard and comes back at once on a new address, with the same id.
  a1Transport.freeze();
  directory.set("a", info("a", "a2.loop", 7011));
  const a2 = links(net.transport("a2.loop", 7011), "a", directory, { pingMs: 50, deadMs: 400 });
  await a2.start();
  a2.want(["b"]);
  // Its first hello comes while b still holds the old link as live: refused, not replaced.
  await until(() => refused.includes("link already up"), 3000);
  // b then finds the old link silent, drops it, and a's redial gets in.
  await until(() => a2.isUp("b") && b.isUp("a"), 8000);
  expect(downs).toEqual(["a"]);
}, 15_000);

// ================================================================== M1: the wait before the hello

test("a channel that sends no hello is closed after about 1 s", async () => {
  expect(PRE_HELLO_MS).toBe(1000);
  expect(STREAM_WAIT_MS).toBe(1000);
  const net = new LoopbackNetwork();
  const directory = new Map([["b", info("b", "b.loop", 7002)]]);
  // No preHelloMs given: the default holds.
  const b = links(net.transport("b.loop", 7002), "b", directory);
  await b.start();
  const fake = net.transport("a.loop", 7001);
  let reason = "";
  const opened = Date.now();
  const silent = await fake.dial({ host: "b.loop", port: 7002, certHash: "" });
  silent.start({ ...idle, closed: (why) => { reason = why; } });
  await until(() => reason !== "", 3000);
  const waited = Date.now() - opened;
  expect(reason).toBe("no hello");
  expect(waited).toBeGreaterThanOrEqual(900);
  expect(waited).toBeLessThan(2000);
  await fake.stop();
});

// ================================================================== M1: the gate before the hello

test("the gate refuses a fifth session from one source, and a released place is free again", () => {
  const gate = new PreHelloGate();
  expect(PRE_HELLO_PER_SOURCE).toBe(4);
  const slots = [1, 2, 3, 4].map(() => gate.admit("10.0.0.9", false, () => {}));
  expect(slots.every((slot) => slot !== null)).toBe(true);
  expect(gate.admit("10.0.0.9", false, () => {})).toBeNull();
  // Another source is not held to the first one's cap.
  expect(gate.admit("10.0.0.10", false, () => {})).not.toBeNull();
  slots[0]!.release();
  slots[0]!.release();
  expect(gate.admit("10.0.0.9", false, () => {})).not.toBeNull();
  expect(gate.size).toBe(5);
});

test("a full gate puts out its oldest stranger, never a known node's session; all known refuses the newcomer", () => {
  const gate = new PreHelloGate(4, 3);
  const evicted: string[] = [];
  gate.admit("known-1", true, () => evicted.push("known-1"));
  gate.admit("stranger-1", false, () => evicted.push("stranger-1"));
  gate.admit(null, false, () => evicted.push("unknown-address"));
  // Full: the newcomer takes the oldest stranger's place.
  expect(gate.admit("stranger-2", false, () => evicted.push("stranger-2"))).not.toBeNull();
  expect(evicted).toEqual(["stranger-1"]);
  expect(gate.admit("known-2", true, () => evicted.push("known-2"))).not.toBeNull();
  expect(evicted).toEqual(["stranger-1", "unknown-address"]);
  expect(gate.admit("known-3", true, () => evicted.push("known-3"))).not.toBeNull();
  expect(evicted).toEqual(["stranger-1", "unknown-address", "stranger-2"]);
  // Every place is a known node's: the next one is refused, and nothing is put out.
  expect(gate.admit("stranger-3", false, () => {})).toBeNull();
  expect(evicted.length).toBe(3);
  expect(gate.size).toBe(3);
});

// The gate on a real listener (QUIC on localhost; skipped where UDP cannot be bound).
const wtStarted: WebTransportLinks[] = [];
afterAll(async () => { for (const server of wtStarted) await server.stop(); });
const BIND_ERROR = /os error (10048|10013)|EADDRINUSE|EACCES|address (already )?in use|permission/i;
type Cert = Awaited<ReturnType<typeof generateLocalCertificate>>;
async function listening(cert: Cert, accept: (channel: LinkChannel) => void, extra: Partial<WebTransportLinksOptions> = {}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const server = new WebTransportLinks({ hostname: "127.0.0.1", port, certPem: cert.certPem, keyPem: cert.keyPem, ...extra });
    try {
      await server.listen(accept);
      wtStarted.push(server);
      return { server, port };
    } catch (error) {
      if (!BIND_ERROR.test(String(error))) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
const noUdp: unknown = await (async () => {
  try {
    const probe = await listening(await generateLocalCertificate({ hostnames: ["127.0.0.1"] }), () => {});
    await probe.server.stop();
    return null;
  } catch (error) {
    if (!BIND_ERROR.test(String(error))) throw error;
    return error;
  }
})();
const udpTest = test.skipIf(noUdp !== null);
const client = (cert: Cert, port: number) => new WebTransport(`https://127.0.0.1:${port}`, {
  serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(Buffer.from(cert.hash, "base64")) }],
});
const closedWithin = (session: WebTransport, ms: number) => Promise.race([session.closed, Bun.sleep(ms).then(() => null)]);

udpTest("a listener refuses a session over the per-source cap, and frees the place when one closes", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  // The library gives no peer address, so the source is supplied here, as a future library would.
  const bound = await listening(cert, () => {}, { sourceOf: () => "10.0.0.9", preHelloPerSource: 1, streamWaitMs: 4000 });
  const first = client(cert, bound.port);
  await first.ready;
  await until(() => bound.server.pendingSessions === 1);
  const second = client(cert, bound.port);
  await second.ready.catch(() => {});
  const info = await closedWithin(second, 3000);
  expect(info?.reason).toBe("too many sessions");
  expect(info?.closeCode).toBe(1008);
  // The first is held to the stream wait, then closed, and its place freed.
  first.close();
  await until(() => bound.server.pendingSessions === 0);
}, 20_000);

udpTest("a full listener puts out its oldest stranger for a newcomer", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const bound = await listening(cert, () => {}, { preHelloMax: 1, streamWaitMs: 4000 });
  const first = client(cert, bound.port);
  await first.ready;
  await until(() => bound.server.pendingSessions === 1);
  const second = client(cert, bound.port);
  await second.ready;
  const info = await closedWithin(first, 3000);
  expect(info?.reason).toBe("busy");
  expect(bound.server.pendingSessions).toBe(1);
  second.close();
}, 20_000);

udpTest("a session that opens no stream is closed after the 1 s wait", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const bound = await listening(cert, () => {});
  const session = client(cert, bound.port);
  await session.ready;
  const opened = Date.now();
  const info = await closedWithin(session, 4000);
  expect(info?.reason).toBe("no stream");
  expect(Date.now() - opened).toBeLessThan(2500);
  await until(() => bound.server.pendingSessions === 0);
}, 20_000);

// ================================================================== H1: signed bus envelopes

test("a bus needs its key", () => {
  expect(() => new ClusterBus(new MemoryStore(), "a", "")).toThrow(/bus key/);
});

async function busWorld() {
  const store = new MemoryStore();
  let clock = 9_000_000;
  const bus = new ClusterBus(store, "b", KEYS.bus, { now: () => clock });
  await bus.start();
  // Well after the start, so the start fence (m1) stays out of the way of the window tests.
  clock += 60_000;
  const got: unknown[] = [];
  bus.on("cmd", (data, from) => { got.push({ data, from }); });
  const send = async (message: string) => { await store.publish(nodeChannel("b"), message); await settle(); };
  return { store, bus, got, send, at: (ms: number) => { clock = ms; }, now: () => clock };
}

test("a signed envelope is delivered with its data and sender", async () => {
  const w = await busWorld();
  await w.send(sealEnvelope(KEYS.bus, "a", "b", "cmd", { n: 1, deep: { z: 1, a: [2, { y: 3, b: 4 }] } }, w.now()));
  expect(w.got).toEqual([{ data: { n: 1, deep: { z: 1, a: [2, { y: 3, b: 4 }] } }, from: "a" }]);
});

test("unsigned, forged, tampered and malformed envelopes are dropped before any handler", async () => {
  const w = await busWorld();
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    // Unsigned: the old envelope shape.
    await w.send(JSON.stringify({ kind: "cmd", from: "a", data: { n: 1 } }));
    // Forged: signed with the gateway secret, the link key, or the raw cluster secret.
    for (const wrong of [GATEWAY_SECRET, KEYS.link, CLUSTER_SECRET]) await w.send(sealEnvelope(wrong, "a", "b", "cmd", { n: 2 }, w.now()));
    // Tampered after signing: the data, the sender, the kind.
    const good = JSON.parse(sealEnvelope(KEYS.bus, "a", "b", "cmd", { n: 3 }, w.now()));
    await w.send(JSON.stringify({ ...good, data: { n: 4 } }));
    await w.send(JSON.stringify({ ...good, from: "coordinator" }));
    await w.send(JSON.stringify({ ...JSON.parse(sealEnvelope(KEYS.bus, "a", "b", "other", { n: 5 }, w.now())), kind: "cmd" }));
    // A signature padded with junk, upper case, or cut short.
    await w.send(JSON.stringify({ ...good, nonce: good.nonce, sig: `${good.sig}00` }));
    await w.send(JSON.stringify({ ...good, sig: good.sig.toUpperCase() }));
    await w.send(JSON.stringify({ ...good, sig: good.sig.slice(0, 62) }));
    // No ts, or no nonce, signed over what is there.
    const noTs = { kind: "cmd", from: "a", to: "b", data: {}, nonce: "f".repeat(32) };
    await w.send(JSON.stringify({ ...noTs, sig: busSignature(KEYS.bus, { ...noTs, ts: undefined }) }));
    const noNonce = { kind: "cmd", from: "a", to: "b", data: {}, ts: w.now() };
    await w.send(JSON.stringify({ ...noNonce, sig: busSignature(KEYS.bus, { ...noNonce, nonce: undefined }) }));
    await w.send("null");
    await w.send("not json");
    expect(w.got).toEqual([]);
    // The untouched one still goes through.
    await w.send(JSON.stringify(good));
    expect(w.got).toEqual([{ data: { n: 3 }, from: "a" }]);
  } finally {
    warns.mockRestore();
  }
});

test("an envelope more than 10 s off the receiver's clock is dropped, either way; inside the window it is taken", async () => {
  const w = await busWorld();
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    await w.send(sealEnvelope(KEYS.bus, "a", "b", "cmd", { n: "old" }, w.now() - BUS_WINDOW_MS - 1));
    await w.send(sealEnvelope(KEYS.bus, "a", "b", "cmd", { n: "future" }, w.now() + BUS_WINDOW_MS + 1));
    expect(w.got).toEqual([]);
    await w.send(sealEnvelope(KEYS.bus, "a", "b", "cmd", { n: "late" }, w.now() - BUS_WINDOW_MS + 500));
    await w.send(sealEnvelope(KEYS.bus, "a", "b", "cmd", { n: "early" }, w.now() + BUS_WINDOW_MS - 500));
    expect(w.got.map((g: any) => g.data.n)).toEqual(["late", "early"]);
  } finally {
    warns.mockRestore();
  }
});

test("a replayed envelope is dropped, on the node channel and the world channel; a replay after the window is stale", async () => {
  const w = await busWorld();
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const sealed = sealEnvelope(KEYS.bus, "a", "b", "cmd", { n: 1 }, w.now());
    await w.send(sealed);
    await w.send(sealed);
    // The same envelope on the world channel is the same envelope.
    await w.store.publish(WORLD_CHANNEL, sealed);
    await settle();
    expect(w.got.length).toBe(1);
    // Long after: the nonce may have been pruned, but the ts is out of the window.
    w.at(w.now() + BUS_WINDOW_MS * 3);
    await w.send(sealed);
    expect(w.got.length).toBe(1);
  } finally {
    warns.mockRestore();
  }
});

test("an envelope is bound to its destination: one copied onto another node's channel or the world channel is dropped there (I1)", async () => {
  const store = new MemoryStore();
  const ran: string[] = [];
  const nodes = ["a", "b", "c"].map((id) => {
    const bus = new ClusterBus(store, id, KEYS.bus);
    bus.on("player-action", (data, from) => { ran.push(`${id}:${data.n}<-${from}`); });
    return bus;
  });
  const [a, b, c] = nodes as [ClusterBus, ClusterBus, ClusterBus];
  // What a Redis reader sees on b's channel.
  const captured: string[] = [];
  await store.subscribe(nodeChannel("b"), (message) => { captured.push(message); });
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    for (const bus of nodes) await bus.start();
    await a.toNode("b", "player-action", { n: 1 });
    await settle();
    expect(ran).toEqual(["b:1<-a"]);
    expect(captured.length).toBe(1);
    // The reviewer's probe: the envelope sealed for b, republished on c's channel. c runs nothing.
    await store.publish(nodeChannel("c"), captured[0]!);
    // And on the world channel: nobody runs it, b included.
    await store.publish(WORLD_CHANNEL, captured[0]!);
    await settle();
    expect(ran).toEqual(["b:1<-a"]);
    expect(warns.mock.calls.some((call) => String(call[0]).includes("was not sent to this channel"))).toBe(true);
    // Rewriting `to` to c breaks the signature.
    await store.publish(nodeChannel("c"), JSON.stringify({ ...JSON.parse(captured[0]!), to: "c" }));
    // A world envelope moved onto one node's channel is dropped too.
    await store.publish(nodeChannel("c"), sealEnvelope(KEYS.bus, "a", "*", "player-action", { n: 2 }, Date.now()));
    await settle();
    expect(ran).toEqual(["b:1<-a"]);
    // The real thing still works both ways: a world message reaches every node once, a node message its node.
    await c.toWorld("player-action", { n: 3 });
    await b.toNode("c", "player-action", { n: 4 });
    await settle();
    expect(ran.slice(1).sort()).toEqual(["a:3<-c", "b:3<-c", "c:3<-c", "c:4<-b"]);
  } finally {
    warns.mockRestore();
  }
});

test("a message forwarded to the node a player moved to is still delivered there (I1)", async () => {
  // Forwarding re-sends with the forwarding node's own signature and the new target, so `to` matches.
  const store = new MemoryStore();
  const ran: string[] = [];
  const a = new ClusterBus(store, "a", KEYS.bus);
  const b = new ClusterBus(store, "b", KEYS.bus);
  const c = new ClusterBus(store, "c", KEYS.bus);
  // b no longer has the player: it passes the action on to c, as deliver.ts does.
  b.on("player-action", async (data) => { if (!data.forwarded) await b.toNode("c", "player-action", { ...data, forwarded: true }); });
  c.on("player-action", (data, from) => { ran.push(`c:${data.n}<-${from}:${data.forwarded}`); });
  for (const bus of [a, b, c]) await bus.start();
  await a.toNode("b", "player-action", { n: 1 });
  await until(() => ran.length > 0);
  expect(ran).toEqual(["c:1<-b:true"]);
});

test("an envelope sent before the bus started is dropped: a restarted node does not take a replay (m1)", async () => {
  const store = new MemoryStore();
  let clock = 5_000_000;
  // The old b took this envelope; its nonce set went with it.
  const sealed = sealEnvelope(KEYS.bus, "a", "b", "cmd", { n: "before" }, clock);
  clock += BUS_START_SKEW_MS + 1;
  const restarted = new ClusterBus(store, "b", KEYS.bus, { now: () => clock });
  const got: unknown[] = [];
  restarted.on("cmd", (data) => { got.push(data.n); });
  await restarted.start();
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    // Still inside the ±10 s window, but from before the start: dropped.
    await store.publish(nodeChannel("b"), sealed);
    await settle();
    expect(got).toEqual([]);
    expect(String(warns.mock.calls[0]?.[0])).toContain("sent before this node started");
    // A sender's clock a little behind (inside the start skew) is still heard.
    await store.publish(nodeChannel("b"), sealEnvelope(KEYS.bus, "a", "b", "cmd", { n: "skewed" }, clock - BUS_START_SKEW_MS));
    await store.publish(nodeChannel("b"), sealEnvelope(KEYS.bus, "a", "b", "cmd", { n: "now" }, clock));
    await settle();
    expect(got).toEqual(["skewed", "now"]);
  } finally {
    warns.mockRestore();
  }
});

test("the nonce set is bounded and pruned by age", () => {
  const nonces = new BusNonces(3);
  for (let i = 0; i < 10; i++) expect(nonces.claim(`n${i}`, 1_000)).toBe(true);
  expect(nonces.size).toBeLessThanOrEqual(3);
  expect(nonces.claim("n9", 1_000)).toBe(false);
  const aged = new BusNonces();
  aged.claim("old", 0);
  aged.claim("new", BUS_WINDOW_MS);
  expect(aged.size).toBe(2);
  // Kept for twice the window, then let go.
  aged.claim("later", BUS_WINDOW_MS * 2 + 1);
  expect(aged.size).toBe(2);
  expect(aged.claim("new", BUS_WINDOW_MS * 2 + 1)).toBe(false);
});

test("drops are warned about at most once per 10 s, with a count of the rest", async () => {
  const w = await busWorld();
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    for (let i = 0; i < 5; i++) await w.send(JSON.stringify({ kind: "cmd", from: "a", data: { i } }));
    expect(warns).toHaveBeenCalledTimes(1);
    expect(String(warns.mock.calls[0]![0])).toContain("not signed");
    w.at(w.now() + 10_000);
    await w.send(sealEnvelope(GATEWAY_SECRET, "a", "b", "cmd", {}, w.now()));
    expect(warns).toHaveBeenCalledTimes(2);
    expect(String(warns.mock.calls[1]![0])).toContain("bad signature");
    expect(String(warns.mock.calls[1]![0])).toContain("4 more");
    // Never the key, the secret or a signature.
    for (const call of warns.mock.calls) {
      for (const secret of [KEYS.bus, KEYS.link, CLUSTER_SECRET, GATEWAY_SECRET]) expect(String(call[0])).not.toContain(secret);
    }
  } finally {
    warns.mockRestore();
  }
});

test("two buses with the same key talk; a bus with another cluster's key hears nothing", async () => {
  const store = new MemoryStore();
  const a = new ClusterBus(store, "a", KEYS.bus);
  const b = new ClusterBus(store, "b", KEYS.bus);
  const stranger = new ClusterBus(store, "s", deriveClusterKeys(GATEWAY_SECRET).bus);
  const got: string[] = [];
  b.on("hi", (_data, from) => { got.push(`b<-${from}`); });
  stranger.on("hi", (_data, from) => { got.push(`s<-${from}`); });
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    for (const bus of [a, b, stranger]) await bus.start();
    await a.toWorld("hi", {});
    await stranger.toNode("b", "hi", {});
    await settle();
    expect(got).toEqual(["b<-a"]);
  } finally {
    warns.mockRestore();
  }
});

test("the coordinator signs with the bus key of the same secret, and refuses to start without it", async () => {
  const source = readFileSync(join(import.meta.dir, "..", "cluster", "coordinator-main.ts"), "utf8");
  expect(source).toContain("keys = requireClusterKeys();");
  expect(source).toContain("keys.bus)");
  // Run it with no secret, from a directory with no .env file, so nothing fills the secret in.
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "cluster", "coordinator-main.ts")], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", REDIS_URL: "redis://127.0.0.1:1", REGION_ID: "test", CLUSTER_LINK_SECRET: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "timeout" as const)]);
  if (exited === "timeout") proc.kill();
  const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  expect(exited).toBe(1);
  expect(output).toContain("CLUSTER_LINK_SECRET");
}, 20_000);

// ================================================================== Final review M1: the plugin API teleport

test("a plugin teleport runs as before with cells off; with cells on it is tracked, and refused for a player being handed off", async () => {
  const ran: string[] = [];
  const teleport = (name: string) => async () => { ran.push(name); };
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  try {
    // Cells off: exactly as before, whatever the flags say.
    expect(await guardedTeleport(false, { id: 7, handoff: true }, teleport("off"))).toBe(true);
    // Cells on: a player in a handoff (either flag) is not moved, and it is logged.
    expect(await guardedTeleport(true, { id: 7, handoff: true }, teleport("handoff"))).toBe(false);
    expect(await guardedTeleport(true, { id: 7, wt: { data: { handedOff: true } } }, teleport("handedOff"))).toBe(false);
    expect(ran).toEqual(["off"]);
    expect(warns.mock.calls.filter((call) => String(call[0]).includes("Teleport of player 7 refused")).length).toBe(2);
    // Otherwise it runs inside trackPacket: a handoff's drain sees it in flight.
    let inFlight = -1;
    expect(await guardedTeleport(true, { id: 7 }, async () => { inFlight = packetsInFlight("7"); })).toBe(true);
    expect(inFlight).toBe(1);
    expect(packetsInFlight("7")).toBe(0);
  } finally {
    warns.mockRestore();
  }
});

test("the server's plugin teleportPlayer goes through the guard", () => {
  const source = readFileSync(join(import.meta.dir, "..", "socket", "server.ts"), "utf8");
  const at = source.indexOf("teleportPlayer: async (playerObj: any, mapName: string, x: number, y: number): Promise<boolean> => {");
  expect(at).toBeGreaterThan(-1);
  const body = source.slice(at, source.indexOf("},", at));
  // The refusal reaches the plugin (m3).
  expect(body).toContain("return await guardedTeleport(clusterEnabled(), playerObj, () => teleportPlayerWrapper(playerObj, mapName, x, y));");
  const types = readFileSync(join(import.meta.dir, "..", "..", "types.d.ts"), "utf8");
  expect(types).toContain("teleportPlayer(playerObj: any, mapName: string, x: number, y: number): Promise<boolean>;");
  expect(source).not.toContain("secret: process.env.GATEWAY_GAME_SERVER_SECRET");
});

test("the startup checks refuse a cluster node whose CLUSTER_LINK_SECRET is unset or short, with the other CLUSTER=true checks (m5)", () => {
  const source = readFileSync(join(import.meta.dir, "..", "utility", "validate_config.ts"), "utf8");
  const cluster = source.slice(source.indexOf('if (process.env.CLUSTER === "true") {'), source.indexOf("// Validate the generated settings.json"));
  expect(cluster).toContain('if ((process.env.CLUSTER_LINK_SECRET ?? "").length < CLUSTER_SECRET_MIN_LENGTH) {');
  expect(cluster).toContain("Cluster mode needs CLUSTER_LINK_SECRET set to at least ${CLUSTER_SECRET_MIN_LENGTH} random characters");
  // Only inside the CLUSTER=true block: a single server needs no cluster secret.
  expect(source.indexOf("CLUSTER_LINK_SECRET")).toBeGreaterThan(source.indexOf('if (process.env.CLUSTER === "true") {'));
});

test("the link listener binds NODE_LINK_BIND_HOST, else every interface, and the server warns once about the latter (I2, m5, m7)", () => {
  const saved = process.env.NODE_LINK_BIND_HOST;
  try {
    delete process.env.NODE_LINK_BIND_HOST;
    expect(nodeLinkBindHost()).toBe("0.0.0.0");
    process.env.NODE_LINK_BIND_HOST = "  ";
    expect(nodeLinkBindHost()).toBe("0.0.0.0");
    process.env.NODE_LINK_BIND_HOST = " 10.0.0.5 ";
    expect(nodeLinkBindHost()).toBe("10.0.0.5");
    // The old name is not read.
    delete process.env.NODE_LINK_BIND_HOST;
    process.env.LINK_HOST = "10.0.0.6";
    expect(nodeLinkBindHost()).toBe("0.0.0.0");
  } finally {
    delete process.env.LINK_HOST;
    if (saved === undefined) delete process.env.NODE_LINK_BIND_HOST;
    else process.env.NODE_LINK_BIND_HOST = saved;
  }
  for (const host of ["0.0.0.0", "::", "[::]"]) {
    const warning = nodeLinkBindWarning(host, 3001);
    expect(warning).toContain("NODE_LINK_BIND_HOST");
    expect(warning).toContain("UDP port 3001");
  }
  expect(nodeLinkBindWarning("10.0.0.5", 3001)).toBeNull();
  expect(nodeLinkBindWarning("127.0.0.1", 3001)).toBeNull();
  // server.ts binds what nodeLinkBindHost gives, logs where, and warns when it is every interface.
  const source = readFileSync(join(import.meta.dir, "..", "socket", "server.ts"), "utf8");
  expect(source).toContain("const linkBindHost = nodeLinkBindHost();");
  expect(source).toContain("new WebTransportLinks({ hostname: linkBindHost,");
  expect(source).toContain("const bindWarning = nodeLinkBindWarning(linkBindHost, linkPort);\n  if (bindWarning) log.warn(bindWarning);");
});

// ================================================================== H2: startCluster refuses without the secret

const saved = { cluster: process.env.CLUSTER, cache: process.env.CACHE, node: process.env.NODE_ID, secret: process.env.CLUSTER_LINK_SECRET };
beforeEach(() => {
  process.env.CLUSTER = "true";
  process.env.CACHE = "redis";
  process.env.NODE_ID = "b";
  process.env.CLUSTER_LINK_SECRET = CLUSTER_SECRET;
});
afterEach(async () => {
  await stopCluster();
  delivery.detach();
  invitations.attach(null);
  resetEntityIds();
  for (const [name, value] of [["CLUSTER", saved.cluster], ["CACHE", saved.cache], ["NODE_ID", saved.node], ["CLUSTER_LINK_SECRET", saved.secret]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const address = { publicHost: "b.example.com", port: 3000, wtPort: 3000, useSSL: true };

test("startCluster refuses to start without CLUSTER_LINK_SECRET, or with a short one, and leaves nothing behind", async () => {
  for (const secret of [undefined, "", "too-short-secret"]) {
    if (secret === undefined) delete process.env.CLUSTER_LINK_SECRET;
    else process.env.CLUSTER_LINK_SECRET = secret;
    const store = new MemoryStore();
    const error: any = await startCluster(store, address).then(() => null, (e) => e);
    expect(String(error?.message)).toContain("CLUSTER_LINK_SECRET");
    if (secret) expect(String(error?.message)).not.toContain(secret);
    expect(clusterNodes()).toBeNull();
    expect(await new NodeRegistry(store).info("b")).toBeNull();
  }
  // CACHE is still checked first.
  process.env.CACHE = "memory";
  const error: any = await startCluster(new MemoryStore(), address).then(() => null, (e) => e);
  expect(String(error?.message)).toContain("CACHE");
  // With both, it starts (cluster-start.test.ts talks to it with the bus key of the same secret).
  process.env.CACHE = "redis";
  process.env.CLUSTER_LINK_SECRET = CLUSTER_SECRET;
  expect(await startCluster(new MemoryStore(), address)).not.toBeNull();
});

test("with the cluster off the secret is not needed", async () => {
  process.env.CLUSTER = "false";
  delete process.env.CLUSTER_LINK_SECRET;
  expect(await startCluster(new MemoryStore(), address)).toBeNull();
});
