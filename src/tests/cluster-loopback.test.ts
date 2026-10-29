import { expect, test } from "bun:test";
import type { LinkChannel } from "../cluster/linktransport";
import { LoopbackNetwork } from "../cluster/loopback";

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const bytes = (...values: number[]) => new Uint8Array(values);

async function pair(net = new LoopbackNetwork()) {
  const server = net.transport("b.loop", 7000);
  const client = net.transport("a.loop", 7001);
  let accepted: LinkChannel | null = null;
  await server.listen((channel) => { accepted = channel; });
  const dialled = await client.dial({ host: "b.loop", port: 7000, certHash: "" });
  await settle();
  return { net, server, client, dialled, accepted: accepted! };
}

test("frames and datagrams cross, in order, after start", async () => {
  const { dialled, accepted } = await pair();
  dialled.send(bytes(1));
  dialled.send(bytes(2));
  dialled.sendDatagram(bytes(9));
  await settle();
  const frames: number[] = [];
  const datagrams: number[] = [];
  accepted.start({ frame: (p) => frames.push(p[0]), datagram: (d) => datagrams.push(d[0]), closed: () => {} });
  await settle();
  expect(frames).toEqual([1, 2]);
  expect(datagrams).toEqual([9]);
});

test("closing one end closes the other", async () => {
  const { dialled, accepted } = await pair();
  let reason = "";
  accepted.start({ frame: () => {}, datagram: () => {}, closed: (r) => { reason = r; } });
  dialled.start({ frame: () => {}, datagram: () => {}, closed: () => {} });
  dialled.close("bye");
  await settle();
  expect(reason).toBe("bye");
  expect(dialled.send(bytes(1))).toBe(false);
});

test("a frozen node goes silent without closing", async () => {
  const { server, dialled, accepted } = await pair();
  const frames: number[] = [];
  let closedServer = false;
  let closedClient = false;
  accepted.start({ frame: (p) => frames.push(p[0]), datagram: () => {}, closed: () => { closedServer = true; } });
  dialled.start({ frame: () => {}, datagram: () => {}, closed: () => { closedClient = true; } });
  server.freeze();
  dialled.send(bytes(1));
  await settle();
  expect(frames).toEqual([]);
  expect(closedServer).toBe(false);
  expect(closedClient).toBe(false);
  server.unfreeze();
  dialled.send(bytes(2));
  await settle();
  // What was sent while frozen is lost, as with a process that was gone.
  expect(frames).toEqual([2]);
});

test("dialling nobody, or a frozen node, fails", async () => {
  const net = new LoopbackNetwork();
  const client = net.transport("a.loop", 7001);
  await expect(client.dial({ host: "nobody", port: 1, certHash: "" })).rejects.toThrow();
  const server = net.transport("b.loop", 7000);
  await server.listen(() => {});
  server.freeze();
  await expect(client.dial({ host: "b.loop", port: 7000, certHash: "" })).rejects.toThrow();
});

test("datagram loss drops every n-th datagram", async () => {
  const net = new LoopbackNetwork();
  net.datagramLoss = 2;
  const { dialled, accepted } = await pair(net);
  const got: number[] = [];
  accepted.start({ frame: () => {}, datagram: (d) => got.push(d[0]), closed: () => {} });
  for (let i = 1; i <= 4; i++) dialled.sendDatagram(bytes(i));
  await settle();
  expect(got).toEqual([1, 3]);
});

test("stopping a transport closes its channels, on both ends", async () => {
  const { server, dialled, accepted } = await pair();
  let closedClient = false;
  let closedServer = false;
  dialled.start({ frame: () => {}, datagram: () => {}, closed: () => { closedClient = true; } });
  accepted.start({ frame: () => {}, datagram: () => {}, closed: () => { closedServer = true; } });
  await server.stop();
  await settle();
  expect(closedClient).toBe(true);
  expect(closedServer).toBe(true);
});

test("dialling a stopped transport fails", async () => {
  const net = new LoopbackNetwork();
  const client = net.transport("a.loop", 7001);
  const server = net.transport("b.loop", 7000);
  await server.listen(() => {});
  await server.stop();
  await expect(client.dial({ host: "b.loop", port: 7000, certHash: "" })).rejects.toThrow();
});

test("stopping an old transport keeps a newer listener on the same address", async () => {
  const net = new LoopbackNetwork();
  const client = net.transport("a.loop", 7001);
  const old = net.transport("b.loop", 7000);
  await old.listen(() => {});
  const fresh = net.transport("b.loop", 7000);
  let accepted = false;
  await fresh.listen(() => { accepted = true; });
  await old.stop();
  await client.dial({ host: "b.loop", port: 7000, certHash: "" });
  expect(accepted).toBe(true);
});

test("each end sees its own closed event with the reason", async () => {
  const { dialled, accepted } = await pair();
  const seen: string[] = [];
  accepted.start({ frame: () => {}, datagram: () => {}, closed: (r) => seen.push(`accepted:${r}`) });
  dialled.start({ frame: () => {}, datagram: () => {}, closed: (r) => seen.push(`dialled:${r}`) });
  dialled.close("bye");
  await settle();
  expect(seen.sort()).toEqual(["accepted:bye", "dialled:bye"]);
});

test("close fires closed on both ends, the closer's only after close() returns", async () => {
  const { dialled, accepted } = await pair();
  const seen = { accepted: [] as string[], dialled: [] as string[] };
  accepted.start({ frame: () => {}, datagram: () => {}, closed: (r) => seen.accepted.push(r) });
  dialled.start({ frame: () => {}, datagram: () => {}, closed: (r) => seen.dialled.push(r) });
  dialled.close("bye");
  expect(seen.dialled).toEqual([]);
  expect(seen.accepted).toEqual([]);
  await settle();
  expect(seen.dialled).toEqual(["bye"]);
  expect(seen.accepted).toEqual(["bye"]);
});

test("a frame sent before close arrives before closed", async () => {
  const { dialled, accepted } = await pair();
  const log: string[] = [];
  accepted.start({ frame: (p) => log.push(`frame:${p[0]}`), datagram: () => {}, closed: (r) => log.push(`closed:${r}`) });
  dialled.send(bytes(1));
  dialled.close("bye");
  await settle();
  expect(log).toEqual(["frame:1", "closed:bye"]);
});

test("send does not deliver to the handler before it returns", async () => {
  const { dialled, accepted } = await pair();
  const frames: number[] = [];
  accepted.start({ frame: (p) => frames.push(p[0]), datagram: () => {}, closed: () => {} });
  dialled.send(bytes(1));
  expect(frames).toEqual([]);
  await settle();
  expect(frames).toEqual([1]);
});

test("after a local close only closed is delivered", async () => {
  const { dialled, accepted } = await pair();
  dialled.send(bytes(1));
  await settle();
  // The frame has arrived at accepted, which has no handlers yet.
  accepted.close("mine");
  const log: string[] = [];
  accepted.start({ frame: (p) => log.push(`frame:${p[0]}`), datagram: () => {}, closed: (r) => log.push(`closed:${r}`) });
  await settle();
  expect(log).toEqual(["closed:mine"]);
});

test("a handler that closes the channel gets no further frames", async () => {
  const { dialled, accepted } = await pair();
  dialled.send(bytes(1));
  dialled.send(bytes(2));
  // Both frames are queued before start, so the close lands mid-pump.
  await settle();
  const frames: number[] = [];
  const closes: string[] = [];
  accepted.start({
    frame: (p) => { frames.push(p[0]); accepted.close("stop"); },
    datagram: () => {},
    closed: (r) => closes.push(r),
  });
  await settle();
  expect(frames).toEqual([1]);
  expect(closes).toEqual(["stop"]);
});

test("close is idempotent: each end sees closed once, with the first reason", async () => {
  const { dialled, accepted } = await pair();
  const seen: string[] = [];
  accepted.start({ frame: () => {}, datagram: () => {}, closed: (r) => seen.push(`accepted:${r}`) });
  dialled.start({ frame: () => {}, datagram: () => {}, closed: (r) => seen.push(`dialled:${r}`) });
  dialled.close("first");
  dialled.close("second");
  await settle();
  expect(seen.sort()).toEqual(["accepted:first", "dialled:first"]);
});

test("datagrams over 1200 bytes are refused, as on the real link", async () => {
  const { dialled, accepted } = await pair();
  const sizes: number[] = [];
  accepted.start({ frame: () => {}, datagram: (d) => sizes.push(d.byteLength), closed: () => {} });
  expect(dialled.sendDatagram(new Uint8Array(1201))).toBe(false);
  expect(dialled.sendDatagram(new Uint8Array(1200))).toBe(true);
  await settle();
  expect(sizes).toEqual([1200]);
});

test("datagram loss counts across links on one network", async () => {
  const net = new LoopbackNetwork();
  net.datagramLoss = 2;
  const server = net.transport("b.loop", 7000);
  const accepted: LinkChannel[] = [];
  await server.listen((channel) => { accepted.push(channel); });
  const one = await net.transport("a.loop", 7001).dial({ host: "b.loop", port: 7000, certHash: "" });
  const two = await net.transport("c.loop", 7002).dial({ host: "b.loop", port: 7000, certHash: "" });
  await settle();
  const got: string[] = [];
  accepted[0].start({ frame: () => {}, datagram: (d) => got.push(`one:${d[0]}`), closed: () => {} });
  accepted[1].start({ frame: () => {}, datagram: (d) => got.push(`two:${d[0]}`), closed: () => {} });
  one.sendDatagram(bytes(1)); // datagram 1: kept
  two.sendDatagram(bytes(2)); // datagram 2: dropped
  one.sendDatagram(bytes(3)); // datagram 3: kept
  two.sendDatagram(bytes(4)); // datagram 4: dropped
  await settle();
  expect(got).toEqual(["one:1", "one:3"]);
});

test("a dial whose accept throws rejects, and its channels are closed", async () => {
  const net = new LoopbackNetwork();
  const server = net.transport("b.loop", 7000);
  let refused: LinkChannel | null = null;
  await server.listen((channel) => { refused = channel; throw new Error("refused"); });
  const client = net.transport("a.loop", 7001);
  await expect(client.dial({ host: "b.loop", port: 7000, certHash: "" })).rejects.toThrow("refused");
  expect(refused!.send(bytes(1))).toBe(false);
});
