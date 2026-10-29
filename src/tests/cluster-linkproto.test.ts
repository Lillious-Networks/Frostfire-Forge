import { expect, test } from "bun:test";
import {
  FLAG_MOVING, FLAG_STEALTH, GHOST_MOVES_PER_DATAGRAM, HELLO_WINDOW_MS, HelloNonces, checkHello, decodeGhostMoves,
  decodeLinkFrame, directionCode, directionName, encodeGhostMoves, encodeLinkFrame, fromWire, idNumber, makeHello, toWire,
} from "../cluster/linkproto";
import { MAX_DATAGRAM_SIZE } from "../socket/movement_batch";

test("a frame round trips; junk decodes to null", () => {
  expect(decodeLinkFrame(encodeLinkFrame("GHOST_SPAWN", { a: 1 }))).toEqual({ t: "GHOST_SPAWN", d: { a: 1 } });
  expect(decodeLinkFrame(new TextEncoder().encode("not json"))).toBeNull();
  expect(decodeLinkFrame(new TextEncoder().encode("42"))).toBeNull();
});

test("a good HELLO names the peer, once", () => {
  const nonces = new HelloNonces();
  const hello = makeHello("s3cret", "a", "b", 1_000_000);
  expect(checkHello("s3cret", hello, "b", 1_000_000, nonces)).toBe("a");
  // The same HELLO again is a replay.
  expect(checkHello("s3cret", hello, "b", 1_000_001, nonces)).toBeNull();
});

test("a HELLO is refused for a wrong secret, target, age or signature", () => {
  const now = 5_000_000;
  const hello = makeHello("s3cret", "a", "b", now);
  expect(checkHello("other", hello, "b", now, new HelloNonces())).toBeNull();
  expect(checkHello("s3cret", hello, "c", now, new HelloNonces())).toBeNull();
  expect(checkHello("s3cret", hello, "b", now + HELLO_WINDOW_MS + 1, new HelloNonces())).toBeNull();
  expect(checkHello("s3cret", { ...hello, sig: "00" }, "b", now, new HelloNonces())).toBeNull();
  expect(checkHello("s3cret", { ...hello, from: "b" }, "b", now, new HelloNonces())).toBeNull();
  expect(checkHello("", hello, "b", now, new HelloNonces())).toBeNull();
  expect(checkHello("s3cret", null, "b", now, new HelloNonces())).toBeNull();
});

test("a HELLO with a padded signature, a NaN time or a ':' in a node id is refused", () => {
  const now = 5_000_000;
  const hello = makeHello("s3cret", "a", "b", now);
  expect(checkHello("s3cret", { ...hello, sig: hello.sig + "zz" }, "b", now, new HelloNonces())).toBeNull();
  expect(checkHello("s3cret", { ...hello, sig: hello.sig.toUpperCase() }, "b", now, new HelloNonces())).toBeNull();
  expect(checkHello("s3cret", { ...hello, ts: NaN }, "b", now, new HelloNonces())).toBeNull();
  expect(() => makeHello("s3cret", "a:1", "b", now)).toThrow();
  expect(() => makeHello("s3cret", "a", "b:2", now)).toThrow();
  expect(checkHello("s3cret", { ...hello, from: "a:1" }, "b", now, new HelloNonces())).toBeNull();
  expect(checkHello("s3cret", hello, "b:2", now, new HelloNonces())).toBeNull();
});

test("ghost moves round trip in the client's batch format", () => {
  const entries = [
    { num: 7, x: 100, y: -20, dir: directionCode("upleft"), flags: FLAG_MOVING },
    { num: 4_000_000_000, x: 8191, y: 4097, dir: directionCode("down"), flags: FLAG_STEALTH | FLAG_MOVING },
  ];
  const datagrams = encodeGhostMoves(entries);
  expect(datagrams.length).toBe(1);
  expect(datagrams[0][0]).toBe(0x01);
  expect(decodeGhostMoves(datagrams[0])).toEqual(entries);
  expect(directionName(entries[0].dir)).toBe("upleft");
});

test("every flag bit survives a datagram", () => {
  const entries = [{ num: 1, x: 0, y: 0, dir: 3, flags: 0x0f }];
  expect(decodeGhostMoves(encodeGhostMoves(entries)[0])).toEqual(entries);
});

test("a direction name that is not a direction falls back to down", () => {
  expect(directionCode("constructor")).toBe(directionCode("down"));
  expect(directionCode("toString")).toBe(directionCode("down"));
  expect(directionCode(undefined)).toBe(directionCode("down"));
});

test("each datagram holds at most 91 moves and fits 1200 bytes", () => {
  const many = Array.from({ length: GHOST_MOVES_PER_DATAGRAM + 1 }, (_, i) => ({ num: i, x: i, y: i, dir: 1, flags: 0 }));
  const datagrams = encodeGhostMoves(many);
  expect(datagrams.length).toBe(2);
  expect(decodeGhostMoves(datagrams[0]).length).toBe(GHOST_MOVES_PER_DATAGRAM);
  for (const datagram of datagrams) expect(datagram.length).toBeLessThanOrEqual(MAX_DATAGRAM_SIZE);
  expect(encodeGhostMoves([])).toEqual([]);
});

test("a short or foreign datagram decodes to nothing", () => {
  expect(decodeGhostMoves(new Uint8Array([0x01, 5, 0, 1, 2]))).toEqual([]);
  expect(decodeGhostMoves(new Uint8Array([0x02, 0, 0]))).toEqual([]);
});

test("ids map to their u32", () => {
  expect(idNumber(12)).toBe(12);
  expect(idNumber("4021")).toBe(4021);
  expect(idNumber("loot_77")).toBe(77);
  expect(idNumber("t9")).toBe(9);
  expect(idNumber("groundaoe_5")).toBe(5);
  expect(idNumber("abc")).toBe(-1);
  expect(idNumber(-3)).toBe(-1);
  expect(idNumber("-3")).toBe(-1);
  expect(idNumber("a-3")).toBe(-1);
  expect(idNumber("")).toBe(-1);
});

test("packets survive the wire", () => {
  const packets = [new Uint8Array([1, 2, 3]), new Uint8Array([])];
  expect(fromWire(toWire(packets))).toEqual(packets);
  expect(fromWire("nope")).toEqual([]);
});
