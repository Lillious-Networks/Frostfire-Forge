import { expect, test, describe, afterEach } from "bun:test";
import { TransportConnection, getStreamWriteStats, SEND_THEN_CLOSE_WRITE_MS } from "../socket/transport";
import { FrameDecoder } from "../socket/framing";

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_FLUSH = 16 * 1024;
const micro = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

type Pending = { chunk: Uint8Array; resolve: () => void; reject: (e: any) => void };

function fake() {
  const writes: Pending[] = [];
  const log: string[] = [];
  let closed = false;
  const writesAfterClose: number[] = [];
  const session: any = {
    queuedBytes: 0n,
    close: () => { closed = true; log.push("close"); },
  };
  const connection = new TransportConnection(session, 1200, 1024 * 1024);
  connection.attachStream({
    getWriter: () => ({
      write: (chunk: Uint8Array) => {
        if (closed) writesAfterClose.push(chunk.length);
        return new Promise<void>((resolve, reject) => { writes.push({ chunk, resolve, reject }); log.push("write"); });
      },
    }),
  });
  return { connection, writes, log, writesAfterClose, isClosed: () => closed };
}

function bytesOf(list: Pending[]): number[] {
  return list.flatMap((w) => Array.from(w.chunk));
}

function frames(list: Pending[]): string[] {
  const decoder = new FrameDecoder(1024 * 1024);
  return list.flatMap((w) => decoder.push(w.chunk)).map((f) => dec.decode(f));
}

const unhandled: any[] = [];
const onUnhandled = (e: any) => { unhandled.push(e); };
process.on("unhandledRejection", onUnhandled);
afterEach(() => { unhandled.length = 0; });

describe("single-flight merge pump", () => {
  test("(a) idle connection: one write in the same microtask", async () => {
    const { connection, writes } = fake();
    connection.send(enc.encode("a"));
    connection.send(enc.encode("b"));
    expect(writes.length).toBe(0);
    await micro();
    expect(writes.length).toBe(1);
    expect(frames(writes)).toEqual(["a", "b"]);
  });

  test("(b) frames queued during an in-flight write leave as one write on settle, in order", async () => {
    const { connection, writes } = fake();
    connection.send(enc.encode("first"));
    await micro();
    expect(writes.length).toBe(1);
    for (let i = 0; i < 5; i++) {
      connection.send(enc.encode(`m${i}`));
      await micro();
    }
    expect(writes.length).toBe(1);
    writes[0].resolve();
    await tick();
    expect(writes.length).toBe(2);
    expect(frames([writes[1]])).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    const joined = bytesOf([writes[1]]);
    const expected: number[] = [];
    // equals the concatenation of each frame as encoded alone
    for (let i = 0; i < 5; i++) {
      const solo = fake();
      solo.connection.send(enc.encode(`m${i}`));
      await micro();
      expected.push(...Array.from(solo.writes[0].chunk));
    }
    expect(joined).toEqual(expected);
  });

  test("(c) over MAX_FLUSH_BYTES: split in order, one in flight at a time", async () => {
    const { connection, writes } = fake();
    connection.send(enc.encode("gate"));
    await micro();
    const big = "x".repeat(5 * 1024);
    for (let i = 0; i < 10; i++) connection.send(enc.encode(`${i}${big}`));
    await micro();
    expect(writes.length).toBe(1);
    writes[0].resolve();
    await tick();
    // exactly one new write in flight, however many were queued
    expect(writes.length).toBe(2);
    expect(writes[1].chunk.length).toBeLessThanOrEqual(MAX_FLUSH);
    let settled = 1;
    while (settled < writes.length) {
      writes[settled].resolve();
      settled++;
      await tick();
      expect(writes.length).toBeLessThanOrEqual(settled + 1);
    }
    expect(writes.length).toBeGreaterThan(2);
    for (const w of writes) expect(w.chunk.length).toBeLessThanOrEqual(MAX_FLUSH);
    expect(frames(writes).map((f) => f[0])).toEqual(["g", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  test("(d) each sendFrame promise resolves after its own bytes are written", async () => {
    const { connection, writes } = fake();
    const done: string[] = [];
    const send = (name: string) => (connection as any).sendFrame(enc.encode(name)).then(() => done.push(name));
    const p1 = send("one");
    await micro();
    const p2 = send("two");
    await micro();
    await tick();
    expect(done).toEqual([]);
    writes[0].resolve();
    await p1;
    expect(done).toEqual(["one"]);
    await tick();
    expect(writes.length).toBe(2);
    expect(done).toEqual(["one"]);
    writes[1].resolve();
    await p2;
    expect(done).toEqual(["one", "two"]);
  });

  test("(e) pending bytes count queued frames and return to 0 after drain", async () => {
    const { connection, writes } = fake();
    connection.send(enc.encode("aaaa"));
    await micro();
    const inFlight = writes[0].chunk.length;
    expect((connection as any).pendingWriteBytes).toBe(inFlight);
    connection.send(enc.encode("bbbbbbbb"));
    await micro();
    const queued = (connection as any).pendingWriteBytes - inFlight;
    expect(queued).toBeGreaterThan(0);
    expect(connection.bufferedAmount).toBeGreaterThanOrEqual(inFlight + queued);
    writes[0].resolve();
    await tick();
    expect((connection as any).pendingWriteBytes).toBe(queued);
    writes[1].resolve();
    await tick();
    expect((connection as any).pendingWriteBytes).toBe(0);
  });

  test("(f) close({drain}) during an in-flight write: queued frames go out first, no write after close", async () => {
    const { connection, writes, log, writesAfterClose, isClosed } = fake();
    connection.send(enc.encode("a"));
    await micro();
    connection.send(enc.encode("b"));
    connection.close(1000, "bye", { drain: true });
    // the turn's frame is queued behind the in-flight write: the session is not closed yet
    expect(isClosed()).toBe(false);
    expect(writes.length).toBe(1);
    writes[0].resolve();
    await tick();
    expect(writes.length).toBe(2);
    expect(isClosed()).toBe(false);
    writes[1].resolve();
    await tick();
    expect(isClosed()).toBe(true);
    expect(frames(writes)).toEqual(["a", "b"]);
    expect(log).toEqual(["write", "write", "close"]);
    expect(writesAfterClose).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  test("(f) close() on an idle connection writes then closes at once, as before", async () => {
    const { connection, writes, log } = fake();
    connection.send(enc.encode("a"));
    connection.close(1000, "bye");
    expect(writes.length).toBe(1);
    expect(log).toEqual(["write", "close"]);
  });

  test("(f) sendThenClose waits for its frames, then closes", async () => {
    const { connection, writes, isClosed } = fake();
    connection.send(enc.encode("x"));
    await micro();
    const closing = connection.sendThenClose([enc.encode("last")], 1000, "bye", { writeMs: 500, peerMs: 20 });
    await micro();
    expect(writes.length).toBe(1);
    writes[0].resolve();
    await tick();
    expect(writes.length).toBe(2);
    expect(isClosed()).toBe(false);
    writes[1].resolve();
    await closing;
    expect(isClosed()).toBe(true);
    expect(frames(writes)).toEqual(["x", "last"]);
    expect(unhandled).toEqual([]);
  });

  test("(f) a plain close() with frames behind an in-flight write closes at once and settles them", async () => {
    const { connection, writes, log, writesAfterClose, isClosed } = fake();
    connection.send(enc.encode("a"));
    await micro();
    const queued = (connection as any).sendFrame(enc.encode("b")).then(() => "settled");
    connection.close(1000, "bye");
    expect(isClosed()).toBe(true);
    expect(await queued).toBe("settled");
    writes[0].resolve();
    await tick();
    expect(writes.length).toBe(1);
    expect(log).toEqual(["write", "close"]);
    expect(writesAfterClose).toEqual([]);
    expect((connection as any).pendingWriteBytes).toBe(0);
    expect(unhandled).toEqual([]);
  });

  test("(f) a drain close behind a never-settling write still closes within the cap, once", async () => {
    const { connection, writes, log, writesAfterClose, isClosed } = fake();
    connection.send(enc.encode("a"));
    await micro();
    const queued = (connection as any).sendFrame(enc.encode("b")).then(() => "settled");
    connection.close(1000, "bye", { drain: true });
    expect(isClosed()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, SEND_THEN_CLOSE_WRITE_MS + 150));
    expect(isClosed()).toBe(true);
    expect(await queued).toBe("settled");
    expect(writes.length).toBe(1);
    writes[0].reject(new Error("late"));
    await tick();
    expect(log).toEqual(["write", "close"]);
    expect(writesAfterClose).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  test("(f) a write rejection during a drain close still closes the session", async () => {
    const { connection, writes, log, isClosed } = fake();
    connection.send(enc.encode("a"));
    await micro();
    connection.send(enc.encode("b"));
    connection.close(1000, "bye", { drain: true });
    expect(isClosed()).toBe(false);
    writes[0].reject(new Error("boom"));
    await tick();
    expect(isClosed()).toBe(true);
    expect(writes.length).toBe(1);
    expect(log).toEqual(["write", "close"]);
    expect(unhandled).toEqual([]);
  });

  test("send() returns false after a write failure", async () => {
    const { connection, writes } = fake();
    connection.send(enc.encode("a"));
    await micro();
    writes[0].reject(new Error("boom"));
    await tick();
    expect(connection.send(enc.encode("b"))).toBe(false);
  });

  test("(g) a rejected write: no unhandled rejection, later frames are not written", async () => {
    const { connection, writes } = fake();
    const settled: string[] = [];
    const p1 = (connection as any).sendFrame(enc.encode("a")).then(() => settled.push("a"));
    await micro();
    const p2 = (connection as any).sendFrame(enc.encode("b")).then(() => settled.push("b"));
    await micro();
    writes[0].reject(new Error("boom"));
    await Promise.all([p1, p2]);
    await tick();
    expect(writes.length).toBe(1);
    expect(settled).toEqual(["a", "b"]);
    expect((connection as any).pendingWriteBytes).toBe(0);
    expect((connection as any).sendFrame(enc.encode("c"))).toBeNull();
    await tick();
    expect(writes.length).toBe(1);
    expect(unhandled).toEqual([]);
  });

  test("(h) counters move as expected", async () => {
    const before = getStreamWriteStats();
    const { connection, writes } = fake();
    connection.send(enc.encode("a"));
    await micro();
    connection.send(enc.encode("b"));
    connection.send(enc.encode("c"));
    await micro();
    const firstBytes = writes[0].chunk.length;
    writes[0].resolve();
    await tick();
    const secondBytes = writes[1].chunk.length;
    const after = getStreamWriteStats();
    expect(after.writes - before.writes).toBe(2);
    expect(after.frames - before.frames).toBe(3);
    expect(after.bytes - before.bytes).toBe(firstBytes + secondBytes);
    expect(after.mergedWrites - before.mergedWrites).toBe(1);
    writes[1].resolve();
    await tick();
  });
});
