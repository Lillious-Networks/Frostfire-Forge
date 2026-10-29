import { afterEach, expect, test } from "bun:test";
import { NodeLinks, isControlKind, type NodeLinksOptions } from "../cluster/links";
import type { LinkChannel, LinkTransport } from "../cluster/linktransport";
import { LoopbackNetwork } from "../cluster/loopback";
import type { NodeInfo } from "../cluster/nodes";
import { decodeLinkFrame, makeHello, encodeLinkFrame } from "../cluster/linkproto";

const until = async (check: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await Bun.sleep(5);
  }
};

const info = (nodeId: string, port: number): NodeInfo => ({
  nodeId, regionId: "r", publicHost: `${nodeId}.example`, port: 1, wtPort: 1, useSSL: true, startedAt: 0,
  linkHost: `${nodeId}.loop`, linkPort: port, certHash: "",
});

const made: NodeLinks[] = [];
afterEach(async () => { for (const links of made.splice(0)) await links.stop(); });

function node(net: LoopbackNetwork, self: string, port: number, directory: Map<string, NodeInfo>, secret = "s3cret", extra: Partial<NodeLinksOptions> = {}) {
  const transport = net.transport(`${self}.loop`, port);
  const links = new NodeLinks({ self, secret, transport, nodeInfo: async (id) => directory.get(id) ?? null, pingMs: 20, deadMs: 80, lingerMs: 50, ...extra });
  made.push(links);
  return { links, transport };
}

function world() {
  const net = new LoopbackNetwork();
  const directory = new Map([["a", info("a", 7001)], ["b", info("b", 7002)]]);
  return { net, directory };
}

const idle = { frame: () => {}, datagram: () => {}, closed: () => {} };

test("the smaller id dials; both sides come up and exchange messages", async () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory);
  const b = node(net, "b", 7002, directory);
  const got: string[] = [];
  b.links.on("GHOST_SPAWN", (data, from) => got.push(`${from}:${data.n}`));
  const ups: string[] = [];
  a.links.onPeerUp((peer) => ups.push(`a sees ${peer}`));
  b.links.onPeerUp((peer) => ups.push(`b sees ${peer}`));
  await a.links.start();
  await b.links.start();
  a.links.want(["b"]);
  b.links.want(["a"]);
  await until(() => a.links.isUp("b") && b.links.isUp("a"));
  expect(ups.sort()).toEqual(["a sees b", "b sees a"]);
  expect(a.links.peers()).toEqual(["b"]);
  expect(a.links.send("b", "GHOST_SPAWN", { n: 1 })).toBe(true);
  await until(() => got.length === 1);
  expect(got).toEqual(["a:1"]);
});

test("datagrams reach the datagram handler with the sender's id", async () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory);
  const b = node(net, "b", 7002, directory);
  const got: string[] = [];
  a.links.onDatagram((data, from) => got.push(`${from}:${data[0]}`));
  await a.links.start();
  await b.links.start();
  a.links.want(["b"]);
  await until(() => b.links.isUp("a"));
  b.links.sendDatagram("a", new Uint8Array([5]));
  await until(() => got.length === 1);
  expect(got).toEqual(["b:5"]);
});

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

test("a wrong secret never comes up", async () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory, "one");
  const refused: string[] = [];
  const transport = recording(net.transport("b.loop", 7002), refused);
  const b = new NodeLinks({ self: "b", secret: "two", transport, nodeInfo: async (id) => directory.get(id) ?? null, pingMs: 20, deadMs: 80 });
  made.push(b);
  await a.links.start();
  await b.start();
  a.links.want(["b"]);
  // The dial reached b and b refused it, and refuses the redial too.
  await until(() => refused.length >= 2);
  expect(refused.slice(0, 2)).toEqual(["bad hello", "bad hello"]);
  expect(a.links.isUp("b")).toBe(false);
  expect(b.isUp("a")).toBe(false);
});

test("a frozen peer is found dead by the ping, and comes back after", async () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory);
  const b = node(net, "b", 7002, directory);
  const downs: string[] = [];
  a.links.onPeerDown((peer) => downs.push(peer));
  await a.links.start();
  await b.links.start();
  a.links.want(["b"]);
  await until(() => a.links.isUp("b"));
  b.transport.freeze();
  await until(() => !a.links.isUp("b"), 1000);
  expect(downs).toEqual(["b"]);
  b.transport.unfreeze();
  await until(() => a.links.isUp("b"), 3000);
});

test("a stall of this node's own loop is not taken for a dead peer", async () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory);
  const b = node(net, "b", 7002, directory);
  const downs: string[] = [];
  a.links.onPeerDown((peer) => downs.push(peer));
  b.links.onPeerDown((peer) => downs.push(peer));
  await a.links.start();
  await b.links.start();
  a.links.want(["b"]);
  await until(() => a.links.isUp("b") && b.links.isUp("a"));
  // Block the loop for 300 ms, far past deadMs (80). Both late ticks fire before the pings
  // queued behind them are read, so they must hold their verdict for one tick.
  const end = Date.now() + 300;
  while (Date.now() < end) { /* stall */ }
  await Bun.sleep(100);
  expect(downs).toEqual([]);
  expect(a.links.isUp("b")).toBe(true);
  expect(b.links.isUp("a")).toBe(true);
});

test("a second HELLO from a peer whose link is up and live is refused; the first channel stays (H2)", async () => {
  const { net, directory } = world();
  // No ping in the test's time: the link stays live on its first word.
  const b = node(net, "b", 7002, directory, "s3cret", { pingMs: 60_000, deadMs: 30_000 });
  const ups: string[] = [];
  b.links.onPeerUp((peer) => ups.push(peer));
  await b.links.start();
  const fake = net.transport("a.loop", 7001);
  const okFrames: string[] = [];
  const closes: string[] = [];
  const dialHello = async (i: number) => {
    const channel = await fake.dial({ host: "b.loop", port: 7002, certHash: "" });
    channel.start({ frame: (p) => okFrames.push(new TextDecoder().decode(p)), datagram: () => {}, closed: (reason) => closes.push(`${i}:${reason}`) });
    channel.send(encodeLinkFrame("LINK_HELLO", makeHello("s3cret", "a", "b", Date.now())));
  };
  await dialHello(0);
  await until(() => okFrames.length === 1);
  await dialHello(1);
  await until(() => closes.length === 1);
  expect(closes).toEqual(["1:link already up"]);
  expect(okFrames.length).toBe(1);
  expect(b.links.isUp("a")).toBe(true);
  expect(ups).toEqual(["a"]);
  await fake.stop();
});

test("a second HELLO once the peer's link is stale replaces the first channel", async () => {
  const { net, directory } = world();
  let clock = 1_000_000;
  const b = node(net, "b", 7002, directory, "s3cret", { pingMs: 60_000, deadMs: 1_000, now: () => clock });
  const downs: string[] = [];
  const ups: string[] = [];
  b.links.onPeerDown((peer) => downs.push(peer));
  b.links.onPeerUp((peer) => ups.push(peer));
  await b.links.start();
  const fake = net.transport("a.loop", 7001);
  const okFrames: string[] = [];
  const closes: string[] = [];
  for (let i = 0; i < 2; i++) {
    const channel = await fake.dial({ host: "b.loop", port: 7002, certHash: "" });
    channel.start({ frame: (p) => okFrames.push(new TextDecoder().decode(p)), datagram: () => {}, closed: (reason) => closes.push(reason) });
    channel.send(encodeLinkFrame("LINK_HELLO", makeHello("s3cret", "a", "b", clock)));
    await until(() => okFrames.length === i + 1);
    // Nothing heard from the first channel for longer than deadMs: it is stale.
    clock += 1_500;
  }
  await until(() => closes.length === 1);
  expect(closes).toEqual(["replaced"]);
  expect(b.links.isUp("a")).toBe(true);
  expect(downs).toEqual([]);
  // The new channel may be a restarted peer, so it is reported up again.
  expect(ups).toEqual(["a", "a"]);
  await fake.stop();
});

test("a first frame that is not a good HELLO, or none at all, closes the channel", async () => {
  const { net, directory } = world();
  const b = node(net, "b", 7002, directory, "s3cret", { preHelloMs: 40 });
  await b.links.start();
  const fake = net.transport("a.loop", 7001);
  let rudeReason = "";
  let silentReason = "";
  const rude = await fake.dial({ host: "b.loop", port: 7002, certHash: "" });
  rude.start({ ...idle, closed: (reason) => { rudeReason = reason; } });
  rude.send(encodeLinkFrame("GHOST_SPAWN", { n: 1 }));
  const silent = await fake.dial({ host: "b.loop", port: 7002, certHash: "" });
  silent.start({ ...idle, closed: (reason) => { silentReason = reason; } });
  await until(() => rudeReason !== "" && silentReason !== "");
  expect(rudeReason).toBe("bad hello");
  expect(silentReason).toBe("no hello");
  expect(b.links.isUp("a")).toBe(false);
  await fake.stop();
});

test("a HELLO from the larger id is refused: the smaller id dials", async () => {
  const { net, directory } = world();
  const b = node(net, "b", 7002, directory);
  await b.links.start();
  const fake = net.transport("c.loop", 7003);
  let reason = "";
  const channel = await fake.dial({ host: "b.loop", port: 7002, certHash: "" });
  channel.start({ ...idle, closed: (why) => { reason = why; } });
  channel.send(encodeLinkFrame("LINK_HELLO", makeHello("s3cret", "c", "b", Date.now())));
  await until(() => reason !== "");
  expect(reason).toBe("wrong dialler");
  expect(b.links.isUp("c")).toBe(false);
  await fake.stop();
});

test("a hung node lookup counts as a failed dial", async () => {
  const { net, directory } = world();
  let asked = 0;
  const a = node(net, "a", 7001, directory, "s3cret", {
    helloTimeoutMs: 30,
    nodeInfo: (id) => (++asked === 1 ? new Promise<NodeInfo | null>(() => {}) : Promise.resolve(directory.get(id) ?? null)),
  });
  const b = node(net, "b", 7002, directory);
  await b.links.start();
  await a.links.start();
  a.links.want(["b"]);
  await until(() => a.links.isUp("b"), 2000);
  expect(asked).toBe(2);
});

test("a dialler that gets no LINK_OK closes and redials", async () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory, "s3cret", { helloTimeoutMs: 30 });
  const mute = net.transport("b.loop", 7002);
  const accepted: LinkChannel[] = [];
  await mute.listen((channel) => { accepted.push(channel); channel.start(idle); });
  await a.links.start();
  a.links.want(["b"]);
  // HELLO timeout (30 ms), then the first redial 250 ms later.
  await until(() => accepted.length >= 2, 2000);
  expect(a.links.isUp("b")).toBe(false);
  await mute.stop();
});

test("a peer with no link port is tried again later", async () => {
  const { net, directory } = world();
  directory.set("b", { ...info("b", 7002), linkPort: 0 });
  let asked = 0;
  const a = node(net, "a", 7001, directory, "s3cret", { nodeInfo: async (id) => { asked++; return directory.get(id) ?? null; } });
  const b = node(net, "b", 7002, directory);
  await b.links.start();
  await a.links.start();
  a.links.want(["b"]);
  await until(() => asked >= 1);
  expect(a.links.isUp("b")).toBe(false);
  directory.set("b", info("b", 7002));
  await until(() => a.links.isUp("b"), 2000);
});

test("a peer no longer wanted is let go after the linger", async () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory);
  const b = node(net, "b", 7002, directory);
  await a.links.start();
  await b.links.start();
  a.links.want(["b"]);
  await until(() => a.links.isUp("b"));
  a.links.want([]);
  expect(a.links.isUp("b")).toBe(true);
  await until(() => !a.links.isUp("b"), 1000);
});

test("the acceptor leaves teardown to the dialler", async () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory);
  const b = node(net, "b", 7002, directory);
  const downs: string[] = [];
  a.links.onPeerDown((peer) => downs.push(`a lost ${peer}`));
  await a.links.start();
  await b.links.start();
  a.links.want(["b"]);
  b.links.want(["a"]);
  await until(() => a.links.isUp("b") && b.links.isUp("a"));
  b.links.want([]);
  // Three lingers (50 ms) pass: b, the acceptor, keeps the link while a still wants it.
  await Bun.sleep(150);
  expect(downs).toEqual([]);
  expect(b.links.isUp("a")).toBe(true);
  a.links.want([]);
  await until(() => !a.links.isUp("b") && !b.links.isUp("a"), 1000);
  expect(downs).toEqual(["a lost b"]);
});

test("a handler that throws does not break the link", async () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory);
  const b = node(net, "b", 7002, directory);
  const got: number[] = [];
  b.links.on("BOOM", () => { throw new Error("handler failed"); });
  b.links.on("FINE", (data) => got.push(data.n));
  await a.links.start();
  await b.links.start();
  a.links.want(["b"]);
  await until(() => a.links.isUp("b"));
  a.links.send("b", "BOOM", {});
  a.links.send("b", "FINE", { n: 2 });
  await until(() => got.length === 1);
  expect(got).toEqual([2]);
  expect(b.links.isUp("a")).toBe(true);
});

test("start throws when the transport cannot listen", async () => {
  const transport: LinkTransport = {
    listen: async () => { throw new Error("port in use"); },
    dial: async () => { throw new Error("unused"); },
    stop: async () => {},
  };
  const links = new NodeLinks({ self: "a", secret: "s3cret", transport, nodeInfo: async () => null });
  await expect(links.start()).rejects.toThrow("port in use");
});

test("start runs once; a node id holding ':' is refused", async () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory);
  await a.links.start();
  await expect(a.links.start()).rejects.toThrow();
  expect(() => new NodeLinks({ self: "a:1", secret: "s3cret", transport: net.transport("x.loop", 1), nodeInfo: async () => null })).toThrow();
});

test("handlers: one per kind, link kinds reserved; sends to a down peer fail", () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory);
  a.links.on("X", () => {});
  expect(() => a.links.on("X", () => {})).toThrow();
  expect(() => a.links.on("LINK_PING", () => {})).toThrow();
  expect(a.links.send("b", "X", {})).toBe(false);
  expect(a.links.sendDatagram("b", new Uint8Array([1]))).toBe(false);
});

test("a wanted peer that is gone is dialled again, and linked once it is back under a new run", async () => {
  const { net, directory } = world();
  const a = node(net, "a", 7001, directory);
  await a.links.start();
  a.links.want(["b"]);
  // The peer's name does not resolve and nothing answers: every dial fails, with the backoff growing.
  directory.set("b", { ...info("b", 7002), startedAt: 1, linkHost: "b-old.loop" });
  await Bun.sleep(150);
  expect(a.links.isUp("b")).toBe(false);
  // It comes back as a new run: another host and port, announced under its id (what registry.info returns).
  directory.set("b", { ...info("b", 7102), startedAt: 2 });
  const b = node(net, "b", 7102, directory);
  await b.links.start();
  await until(() => a.links.isUp("b") && b.links.isUp("a"), 8000);
});

// ---- stall fix: the control lane

test("calls, answers, casts and the link's own frames are sent as control; ghost and AOI frames are bulk", async () => {
  const { net, directory } = world();
  const seen: Array<{ kind: string; control: boolean | undefined }> = [];
  const spied = (real: LinkTransport): LinkTransport => {
    const wrap = (channel: LinkChannel) => {
      const send = channel.send.bind(channel);
      channel.send = (payload, control) => {
        seen.push({ kind: decodeLinkFrame(payload)?.t ?? "?", control });
        return send(payload, control);
      };
      return channel;
    };
    return { listen: (accept) => real.listen((channel) => accept(wrap(channel))), dial: async (peer) => wrap(await real.dial(peer)), stop: () => real.stop() };
  };
  const a = new NodeLinks({ self: "a", secret: "s3cret", transport: spied(net.transport("a.loop", 7001)), nodeInfo: async (id) => directory.get(id) ?? null, pingMs: 20, deadMs: 200 });
  const b = node(net, "b", 7002, directory);
  made.push(a);
  for (const kind of ["CALL", "ANSWER", "CAST", "GHOST_STATE", "AOI_EVENT"]) b.links.on(kind, () => {});
  await a.start();
  await b.links.start();
  a.want(["b"]);
  await until(() => a.isUp("b") && b.links.isUp("a"));
  for (const kind of ["CALL", "ANSWER", "CAST", "GHOST_STATE", "GHOST_SPAWN", "AOI_EVENT"]) a.send("b", kind, {});
  // Guard: the lane is chosen by the kind. Every frame as bulk leaves a call behind the ghost backlog.
  await until(() => seen.some((entry) => entry.kind === "LINK_PING"));
  const lane = (kind: string) => seen.filter((entry) => entry.kind === kind).map((entry) => entry.control);
  for (const kind of ["CALL", "ANSWER", "CAST", "LINK_HELLO", "LINK_PING"]) expect(lane(kind).every((control) => control === true)).toBe(true);
  for (const kind of ["GHOST_STATE", "GHOST_SPAWN", "AOI_EVENT"]) expect(lane(kind).every((control) => control !== true)).toBe(true);
  expect(isControlKind("LINK_OK")).toBe(true);
  expect(isControlKind("GHOST_HANDOVER")).toBe(false);
});
