import { expect, test, describe } from "bun:test";
import { TransportConnection } from "../socket/transport";
import { FrameDecoder } from "../socket/framing";

const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function fake(maxFrame = 1024 * 1024) {
  const writes: Uint8Array[] = [];
  const session: any = { queuedBytes: 0n, close: () => {} };
  const connection = new TransportConnection(session, 1200, maxFrame);
  connection.attachStream({ getWriter: () => ({ write: (chunk: Uint8Array) => { writes.push(chunk); return Promise.resolve(); } }) });
  return { connection, writes };
}

function decode(writes: Uint8Array[]): string[] {
  const decoder = new FrameDecoder(1024 * 1024);
  return writes.flatMap((w) => decoder.push(w)).map((f) => dec.decode(f));
}

describe("stream write coalescing", () => {
  test("frames queued in one turn leave in one write, in order", async () => {
    const { connection, writes } = fake();
    for (let i = 0; i < 50; i++) connection.send(enc.encode(`{"n":${i}}`));
    expect(writes.length).toBe(0);
    await tick();
    expect(writes.length).toBe(1);
    expect(decode(writes)).toEqual(Array.from({ length: 50 }, (_, i) => `{"n":${i}}`));
  });

  test("a later turn is a later write", async () => {
    const { connection, writes } = fake();
    connection.send(enc.encode("a"));
    await tick();
    connection.send(enc.encode("b"));
    await tick();
    expect(writes.length).toBe(2);
    expect(decode(writes)).toEqual(["a", "b"]);
  });

  test("a flush past the cap is split into ordered writes of whole frames", async () => {
    const { connection, writes } = fake();
    const big = "x".repeat(5 * 1024);
    for (let i = 0; i < 10; i++) connection.send(enc.encode(`${i}${big}`));
    await tick();
    expect(writes.length).toBeGreaterThan(1);
    for (const w of writes) expect(w.length).toBeLessThanOrEqual(16 * 1024);
    expect(decode(writes).map((f) => f[0])).toEqual(["0","1","2","3","4","5","6","7","8","9"]);
  });

  test("one frame over the cap is written alone", async () => {
    const { connection, writes } = fake();
    connection.send(enc.encode("a"));
    connection.send(enc.encode("y".repeat(40 * 1024)));
    connection.send(enc.encode("c"));
    await tick();
    expect(writes.length).toBe(3);
    expect(decode(writes).map((f) => f[0])).toEqual(["a", "y", "c"]);
  });

  test("an oversized frame is dropped without disturbing the others", async () => {
    const { connection, writes } = fake(16);
    connection.send(enc.encode("a"));
    connection.send(enc.encode("z".repeat(100)));
    connection.send(enc.encode("b"));
    await tick();
    expect(decode(writes)).toEqual(["a", "b"]);
  });

  test("queued bytes count toward bufferedAmount until written", async () => {
    const { connection } = fake();
    connection.send(enc.encode("hello"));
    expect(connection.bufferedAmount).toBeGreaterThan(0);
    await tick();
    expect(connection.bufferedAmount).toBe(0);
  });

  test("sendThenClose resolves after the shared write", async () => {
    const { connection, writes } = fake();
    connection.send(enc.encode("a"));
    await connection.sendThenClose([enc.encode("bye")], 1000, "x", { peerMs: 10 });
    expect(decode(writes)).toEqual(["a", "bye"]);
    expect(writes.length).toBe(1);
  });

  test("close writes what was queued first, and nothing after", async () => {
    const { connection, writes } = fake();
    connection.send(enc.encode("a"));
    connection.close();
    connection.send(enc.encode("late"));
    await tick();
    expect(decode(writes)).toEqual(["a"]);
  });

  test("a connection that closed before the flush writes nothing and clears the accounting", async () => {
    const { connection, writes } = fake();
    connection.send(enc.encode("a"));
    connection.readyState = 3;
    await tick();
    expect(writes.length).toBe(0);
    expect((connection as any).pendingWriteBytes).toBe(0);
  });

  test("a failing write does not throw and clears the accounting", async () => {
    const session: any = { queuedBytes: 0n, close: () => {} };
    const connection = new TransportConnection(session, 1200, 1024);
    connection.attachStream({ getWriter: () => ({ write: () => Promise.reject(new Error("boom")) }) });
    connection.send(enc.encode("a"));
    await tick();
    expect(connection.bufferedAmount).toBe(0);
  });
});
