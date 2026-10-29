import { afterAll, expect, test } from "bun:test";
import { WebTransport } from "@lillious-networks/webtransport-bun";
import type { LinkChannel } from "../cluster/linktransport";
import { LaneWriter, LinkFrameReader, WebTransportLinks, type WebTransportLinksOptions } from "../cluster/wtlinks";
import { encodeFrame } from "../socket/framing";
import { generateLocalCertificate } from "../utility/local_cert";

// Real QUIC on localhost. Ports are high and random. When UDP cannot be bound at all (a CI box
// without it), the socket tests are skipped, and bun reports them as skipped. Only a failed bind
// counts: any other error fails the test. Set REQUIRE_UDP=1 to make a skip a failure.

const until = async (check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await Bun.sleep(10);
  }
};

const started: WebTransportLinks[] = [];
afterAll(async () => { for (const links of started) await links.stop(); });

const randomPort = () => 40000 + Math.floor(Math.random() * 20000);
const BIND_ERROR = /os error (10048|10013)|EADDRINUSE|EACCES|address (already )?in use|permission/i;

type Cert = Awaited<ReturnType<typeof generateLocalCertificate>>;

/** A listening server on a free high port. Windows reserves some ranges, so a few ports are tried; any other error is thrown at once. */
async function listening(cert: Cert, accept: (channel: LinkChannel) => void, extra: Partial<WebTransportLinksOptions> = {}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = randomPort();
    const server = new WebTransportLinks({ hostname: "127.0.0.1", port, certPem: cert.certPem, keyPem: cert.keyPem, ...extra });
    try {
      await server.listen(accept);
      started.push(server);
      return { server, port };
    } catch (error) {
      if (!BIND_ERROR.test(String(error))) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** A transport that only dials. */
function dialler(cert: Cert, extra: Partial<WebTransportLinksOptions> = {}) {
  const links = new WebTransportLinks({ port: 0, certPem: cert.certPem, keyPem: cert.keyPem, ...extra });
  started.push(links);
  return links;
}

// Whether UDP can be bound here at all: null when it can.
const noUdp: unknown = await (async () => {
  try {
    const probe = await listening(await generateLocalCertificate({ hostnames: ["127.0.0.1"] }), () => {});
    await probe.server.stop();
    return null;
  } catch (error) {
    if (!BIND_ERROR.test(String(error))) throw error;
    console.warn(`cluster-wtlinks: socket tests skipped, could not bind UDP: ${error}`);
    return error;
  }
})();
const udpTest = test.skipIf(noUdp !== null);

test("UDP can be bound when the run requires it", () => {
  if (process.env.REQUIRE_UDP && noUdp !== null) throw new Error(`REQUIRE_UDP is set but UDP could not be bound: ${noUdp}`);
});

test("the frame reader holds the first frame to its small limit, then the large one", () => {
  const first = new Uint8Array(10).fill(1);
  const big = new Uint8Array(5000).fill(2);
  const both = new Uint8Array([...encodeFrame(first), ...encodeFrame(big)]);

  // In one chunk, the frame behind the first one is already under the large limit.
  expect(new LinkFrameReader(1_000_000, 64).push(both).map((f) => f.length)).toEqual([10, 5000]);

  // Fed a byte at a time, and in odd slices, the result is the same.
  for (const size of [1, 3, 7, 4000]) {
    const reader = new LinkFrameReader(1_000_000, 64);
    const lengths: number[] = [];
    for (let at = 0; at < both.length; at += size) lengths.push(...reader.push(both.subarray(at, at + size)).map((f) => f.length));
    expect(lengths).toEqual([10, 5000]);
    expect(reader.isOverflowed()).toBe(false);
  }

  // An empty first frame still raises the limit.
  expect(new LinkFrameReader(1_000_000, 64).push(new Uint8Array([...encodeFrame(new Uint8Array(0)), ...encodeFrame(big)])).map((f) => f.length)).toEqual([0, 5000]);

  // A first frame over its limit is refused before any of it is buffered, and nothing is delivered.
  const refused = new LinkFrameReader(1_000_000, 64);
  expect(refused.push(encodeFrame(new Uint8Array(100)).subarray(0, 4))).toEqual([]);
  expect(refused.isOverflowed()).toBe(true);

  // A frame over the large limit is refused too.
  const tooBig = new LinkFrameReader(1000, 64);
  expect(tooBig.push(both)).toHaveLength(1);
  expect(tooBig.isOverflowed()).toBe(true);
});

udpTest("a pinned link carries frames and datagrams both ways", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["localhost", "127.0.0.1"] });
  const accepted: LinkChannel[] = [];
  const bound = await listening(cert, (channel) => { accepted.push(channel); });

  const channel = await dialler(cert).dial({ host: "127.0.0.1", port: bound.port, certHash: cert.hash });
  const serverFrames: string[] = [];
  const clientFrames: Uint8Array[] = [];
  const serverDatagrams: number[] = [];
  let clientClosed = "";
  channel.start({ frame: (p) => clientFrames.push(p), datagram: () => {}, closed: (reason) => { clientClosed = reason; } });
  // The server learns of the stream when the first frame is written.
  channel.send(new TextEncoder().encode("hello"));
  await until(() => accepted.length === 1);
  const serverEnd = accepted[0];
  serverEnd.start({
    frame: (p) => serverFrames.push(new TextDecoder().decode(p)),
    datagram: (d) => serverDatagrams.push(d[0]),
    closed: () => {},
  });
  await until(() => serverFrames.length === 1);
  expect(serverFrames).toEqual(["hello"]);

  serverEnd.send(new TextEncoder().encode("ok"));
  await until(() => clientFrames.length === 1);
  expect(new TextDecoder().decode(clientFrames[0])).toBe("ok");

  // The first frame was small; a large one follows on the same link.
  serverEnd.send(new Uint8Array(200_000).fill(9));
  await until(() => clientFrames.length === 2);
  expect(clientFrames[1].length).toBe(200_000);

  // Datagrams are unreliable: send a few, expect at least one on localhost.
  for (let i = 0; i < 5; i++) channel.sendDatagram(new Uint8Array([7]));
  await until(() => serverDatagrams.length > 0);
  expect(serverDatagrams[0]).toBe(7);

  // A datagram over the cap is refused, one at the cap is not.
  expect(channel.sendDatagram(new Uint8Array(1201))).toBe(false);
  expect(channel.sendDatagram(new Uint8Array(1200))).toBe(true);

  // Starting again swaps the handlers. closed fires once on each end, the closing one included,
  // and the closer's own comes on a later tick.
  let serverClosed = "";
  let serverClosedCount = 0;
  serverEnd.start({ frame: () => {}, datagram: () => {}, closed: (reason) => { serverClosed = reason || "closed"; serverClosedCount++; } });
  channel.close("bye");
  expect(clientClosed).toBe("");
  expect(channel.send(new Uint8Array([1]))).toBe(false);
  expect(channel.sendDatagram(new Uint8Array([1]))).toBe(false);
  await until(() => clientClosed !== "");
  expect(clientClosed).toBe("bye");
  await until(() => serverClosed !== "");
  expect(serverClosed).toBe("bye");
  await Bun.sleep(100);
  expect(serverClosedCount).toBe(1);
}, 20_000);

udpTest("a channel that ended before start reports it when started", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const accepted: LinkChannel[] = [];
  const bound = await listening(cert, (channel) => { accepted.push(channel); });

  const channel = await dialler(cert).dial({ host: "127.0.0.1", port: bound.port, certHash: cert.hash });
  channel.send(new Uint8Array([1]));
  await until(() => accepted.length === 1);
  channel.close("gone");
  // The server end has noticed once its session is closed. Waiting only reads: a probe that sent a frame
  // could fail a write and end the channel with its own reason before the peer's arrives.
  await until(() => (accepted[0] as any).done === true);
  const reasons: string[] = [];
  const frames: number[] = [];
  accepted[0].start({ frame: (p) => frames.push(p.length), datagram: () => {}, closed: (reason) => reasons.push(reason) });
  expect(reasons).toEqual(["gone"]);
  // Starting a dead channel again neither reports it twice nor reads from it.
  accepted[0].start({ frame: (p) => frames.push(p.length), datagram: () => {}, closed: (reason) => reasons.push(reason) });
  await Bun.sleep(100);
  expect(reasons).toEqual(["gone"]);
  expect(frames).toEqual([]);
}, 20_000);

udpTest("a frame over the limit closes the link", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const accepted: LinkChannel[] = [];
  const bound = await listening(cert, (channel) => { accepted.push(channel); }, { maxFrameSize: 64 });

  const channel = await dialler(cert).dial({ host: "127.0.0.1", port: bound.port, certHash: cert.hash });
  let clientClosed = false;
  let serverReason = "";
  channel.start({ frame: () => {}, datagram: () => {}, closed: () => { clientClosed = true; } });
  // The sender's own limit is the default, so the oversized frame leaves it and the receiver refuses it.
  expect(channel.send(new Uint8Array(100))).toBe(true);
  await until(() => accepted.length === 1);
  accepted[0].start({ frame: () => {}, datagram: () => {}, closed: (reason) => { serverReason = reason; } });
  await until(() => serverReason !== "");
  expect(serverReason).toBe("frame too large");
  await until(() => clientClosed);
}, 20_000);

udpTest("a first frame of 100 KiB closes the link, though the limit after it is larger", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const accepted: LinkChannel[] = [];
  const bound = await listening(cert, (channel) => { accepted.push(channel); });

  const channel = await dialler(cert).dial({ host: "127.0.0.1", port: bound.port, certHash: cert.hash });
  channel.start({ frame: () => {}, datagram: () => {}, closed: () => {} });
  expect(channel.send(new Uint8Array(100 * 1024))).toBe(true);
  await until(() => accepted.length === 1);
  const frames: number[] = [];
  let serverReason = "";
  accepted[0].start({ frame: (p) => frames.push(p.length), datagram: () => {}, closed: (reason) => { serverReason = reason; } });
  await until(() => serverReason !== "");
  expect(serverReason).toBe("frame too large");
  expect(frames).toEqual([]);
}, 20_000);

udpTest("a peer that stops reading is cut off at the send backlog", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const accepted: LinkChannel[] = [];
  const bound = await listening(cert, (channel) => { accepted.push(channel); });

  // 32 KiB frames, so the backlog cap is 128 KiB. The server end is never started, so it never reads.
  const channel = await dialler(cert, { maxFrameSize: 32 * 1024 }).dial({ host: "127.0.0.1", port: bound.port, certHash: cert.hash });
  let reason = "";
  channel.start({ frame: () => {}, datagram: () => {}, closed: (r) => { reason = r; } });
  channel.send(new Uint8Array([1]));
  await until(() => accepted.length === 1);
  let refused = false;
  for (let i = 0; i < 4000 && !refused; i++) {
    refused = !channel.send(new Uint8Array(30 * 1024));
    if (i % 20 === 0) await Bun.sleep(1);
  }
  expect(refused).toBe(true);
  expect(channel.send(new Uint8Array([1]))).toBe(false);
  await until(() => reason !== "");
  expect(reason).toBe("send backlog");
}, 30_000);

udpTest("a session that opens no stream is closed", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const bound = await listening(cert, () => {});

  const session = new WebTransport(`https://127.0.0.1:${bound.port}`, {
    serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(Buffer.from(cert.hash, "base64")) }],
  });
  await session.ready;
  const info = await Promise.race([session.closed, Bun.sleep(6000).then(() => null)]);
  expect(info?.reason).toBe("no stream");
  expect(info?.closeCode).toBe(1008);
}, 20_000);

udpTest("a wrong pin is refused", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const other = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const bound = await listening(cert, () => {});
  const client = dialler(cert, { dialTimeoutMs: 3000 });
  // The handshake fails on the pin; it is not the dial timeout.
  const error: any = await client.dial({ host: "127.0.0.1", port: bound.port, certHash: other.hash }).then(() => null, (e) => e);
  expect(error).not.toBeNull();
  expect(String(error?.message ?? error)).not.toMatch(/no answer/);
}, 20_000);

udpTest("a dial to nothing times out", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const client = dialler(cert, { dialTimeoutMs: 1000 });
  const began = Date.now();
  await expect(client.dial({ host: "127.0.0.1", port: randomPort(), certHash: cert.hash })).rejects.toThrow(/no answer/);
  expect(Date.now() - began).toBeLessThan(5000);
}, 20_000);

udpTest("stop closes the channels it owns, and a stopped transport does not dial", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const accepted: LinkChannel[] = [];
  const bound = await listening(cert, (channel) => { accepted.push(channel); });
  const client = dialler(cert);

  const channel = await client.dial({ host: "127.0.0.1", port: bound.port, certHash: cert.hash });
  let clientReason = "";
  channel.start({ frame: () => {}, datagram: () => {}, closed: (reason) => { clientReason = reason || "closed"; } });
  channel.send(new Uint8Array([1]));
  await until(() => accepted.length === 1);
  let serverReason = "";
  accepted[0].start({ frame: () => {}, datagram: () => {}, closed: (reason) => { serverReason = reason; } });
  await bound.server.stop();
  await until(() => serverReason !== "");
  expect(serverReason).toBe("stopping");
  await until(() => clientReason !== "");

  await client.stop();
  await expect(client.dial({ host: "127.0.0.1", port: bound.port, certHash: cert.hash })).rejects.toThrow(/stopped/);
}, 20_000);

udpTest("listening twice is refused", async () => {
  const cert = await generateLocalCertificate({ hostnames: ["127.0.0.1"] });
  const bound = await listening(cert, () => {});
  await expect(bound.server.listen(() => {})).rejects.toThrow(/already listening/);
}, 20_000);

// ---- stall fix: the lane writer (no network)

/** A writer that holds every frame until the test lets it through, and records the order they were handed over. */
function heldWrites() {
  const handed: string[] = [];
  const release: Array<() => void> = [];
  const write = (frame: Uint8Array) => new Promise<void>((resolve) => {
    handed.push(new TextDecoder().decode(frame));
    release.push(resolve);
  });
  const flush = async () => {
    for (let i = 0; i < 200 && release.length > 0; i++) {
      release.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { handed, write, flush };
}
const bytes = (text: string, size = 100) => new TextEncoder().encode(text.padEnd(size, "."));
const names = (list: string[]) => list.map((text) => text.replace(/\.+$/, ""));

test("a control frame queued behind many bulk frames goes out ahead of them, each lane in its own order, none dropped", async () => {
  const w = heldWrites();
  const lanes = new LaneWriter(w.write, () => {}, 250);
  // 100-byte frames and a 250-byte window: two are with the writer, the rest wait in the bulk lane.
  for (let i = 1; i <= 10; i++) lanes.push(bytes(`bulk${i}`), false);
  lanes.push(bytes("call1"), true);
  lanes.push(bytes("call2"), true);
  lanes.push(bytes("bulk11"), false);
  lanes.push(bytes("call3"), true);
  await w.flush();
  const order = names(w.handed);
  // Guard: one FIFO (the old writer) gives bulk1..bulk10 first. The control frames wait behind the two the writer held, no more.
  expect(order.slice(0, 2)).toEqual(["bulk1", "bulk2"]);
  expect(order.slice(2, 5)).toEqual(["call1", "call2", "call3"]);
  // Each lane keeps its order, and every frame goes out exactly once.
  expect(order.filter((name) => name.startsWith("bulk"))).toEqual(["bulk1", "bulk2", "bulk3", "bulk4", "bulk5", "bulk6", "bulk7", "bulk8", "bulk9", "bulk10", "bulk11"]);
  expect(order).toHaveLength(14);
  expect(lanes.backlog).toBe(0);
});

test("the lane writer counts what the stream has not taken, and stops after a failed write", async () => {
  let fail = false;
  const written: string[] = [];
  const errors: unknown[] = [];
  const lanes = new LaneWriter(async (frame) => {
    written.push(new TextDecoder().decode(frame));
    if (fail) throw new Error("reset");
  }, (error) => errors.push(error), 250);
  lanes.push(bytes("a"), false);
  expect(lanes.backlog).toBe(100);
  await Bun.sleep(5);
  expect(lanes.backlog).toBe(0);
  fail = true;
  lanes.push(bytes("b"), true);
  lanes.push(bytes("c"), false);
  await Bun.sleep(5);
  expect(errors).toHaveLength(1);
  // Nothing is sent after the failure; the channel closes.
  lanes.push(bytes("d"), true);
  await Bun.sleep(5);
  expect(names(written)).toEqual(["a", "b", "c"].slice(0, written.length));
  expect(written).not.toContain("d");
});

test("a control frame is not held back by a window of one big bulk frame beyond what the writer already holds", async () => {
  const w = heldWrites();
  const lanes = new LaneWriter(w.write, () => {}, 150);
  lanes.push(bytes("big1", 1000), false);
  lanes.push(bytes("big2", 1000), false);
  lanes.push(bytes("call", 50), true);
  // The first frame is always handed over; the window is full, so the second waits and the call goes next.
  expect(names(w.handed)).toEqual(["big1"]);
  await w.flush();
  expect(names(w.handed).slice(0, 2)).toEqual(["big1", "call"]);
});
