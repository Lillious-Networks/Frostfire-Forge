import { expect, test } from "bun:test";
import { FrameDecoder, encodeFrame, encodeCloseReason, decodeCloseReason } from "../socket/framing";
import { topicBus } from "../socket/topics";

test("encodeFrame prefixes payload with 4-byte little-endian length", () => {
  const payload = new TextEncoder().encode("hello");
  const frame = encodeFrame(payload);

  expect(frame.length).toBe(payload.length + 4);

  const view = new DataView(frame.buffer);
  expect(view.getUint32(0, true)).toBe(payload.length);

  const decoded = frame.slice(4);
  expect(new TextDecoder().decode(decoded)).toBe("hello");
});

test("FrameDecoder reassembles frames from a single chunk", () => {
  const decoder = new FrameDecoder(1024 * 1024);
  const payload = new TextEncoder().encode("hello");
  const frames = decoder.push(encodeFrame(payload));

  expect(frames.length).toBe(1);
  expect(new TextDecoder().decode(frames[0])).toBe("hello");
});

test("FrameDecoder handles byte-by-byte delivery", () => {
  const decoder = new FrameDecoder(1024 * 1024);
  const payload = new TextEncoder().encode("fragmented");
  const frame = encodeFrame(payload);

  const frames: Uint8Array[] = [];
  for (let i = 0; i < frame.length; i++) {
    frames.push(...decoder.push(frame.slice(i, i + 1)));
  }

  expect(frames.length).toBe(1);
  expect(new TextDecoder().decode(frames[0])).toBe("fragmented");
});

test("FrameDecoder extracts multiple coalesced frames", () => {
  const decoder = new FrameDecoder(1024 * 1024);
  const first = new TextEncoder().encode("one");
  const second = new TextEncoder().encode("two");

  const combined = new Uint8Array(encodeFrame(first).length + encodeFrame(second).length);
  combined.set(encodeFrame(first), 0);
  combined.set(encodeFrame(second), encodeFrame(first).length);

  const frames = decoder.push(combined);
  expect(frames.length).toBe(2);
  expect(new TextDecoder().decode(frames[0])).toBe("one");
  expect(new TextDecoder().decode(frames[1])).toBe("two");
});

test("FrameDecoder survives a large chunk arriving behind a buffered partial frame", () => {
  const decoder = new FrameDecoder(1024 * 1024);
  const first = new TextEncoder().encode("a".repeat(1000));
  const bigPayload = new Uint8Array(7000);
  const bigFrame = encodeFrame(bigPayload);

  // One complete small frame, then the header + first 4996 bytes of a 7000-byte
  // frame: leaves readOffset > 0 with a partial frame at the buffer head.
  const push1 = new Uint8Array(encodeFrame(first).length + 5000);
  push1.set(encodeFrame(first), 0);
  push1.set(bigFrame.slice(0, 5000), encodeFrame(first).length);
  expect(decoder.push(push1).length).toBe(1);

  // 2004 bytes finish the big frame, then a header declaring a 1000-byte
  // payload with only 492 bytes present (stays partial). The old capacity
  // check (compacted size) passed while set() wrote past the buffer end.
  const push2 = new Uint8Array(2500);
  new DataView(push2.buffer).setUint32(2004, 1000, true);
  const frames = decoder.push(push2);
  expect(frames.length).toBe(1);
  expect(frames[0]).toEqual(bigPayload);
});

test("FrameDecoder flags oversized frames", () => {
  const decoder = new FrameDecoder(10);
  const payload = new Uint8Array(11);
  decoder.push(encodeFrame(payload));

  expect(decoder.isOverflowed()).toBe(true);
  expect(decoder.push(encodeFrame(new Uint8Array(1))).length).toBe(0);
});

test("FrameDecoder rejects oversized length header without crashing", () => {
  const decoder = new FrameDecoder(1024);
  const malicious = new Uint8Array(4);
  new DataView(malicious.buffer).setUint32(0, 0xffffffff, true);
  decoder.push(malicious);

  expect(decoder.isOverflowed()).toBe(true);
});

test("close reason encodes and decodes semantic close codes", () => {
  expect(encodeCloseReason(1000, "normal")).toBe("1000|normal");
  expect(encodeCloseReason(1008, "")).toBe("1008|");
  expect(encodeCloseReason(1009, "Frame too large")).toBe("1009|Frame too large");
});

test("decodeCloseReason parses encoded reasons", () => {
  expect(decodeCloseReason("1008|Unauthorized")).toEqual({ code: 1008, reason: "Unauthorized" });
  expect(decodeCloseReason("1000|")).toEqual({ code: 1000, reason: "" });
});

test("decodeCloseReason handles missing or malformed reasons", () => {
  expect(decodeCloseReason(undefined)).toEqual({ code: 0, reason: "" });
  expect(decodeCloseReason("")).toEqual({ code: 0, reason: "" });
  expect(decodeCloseReason("no-separator")).toEqual({ code: 1, reason: "no-separator" });
  expect(decodeCloseReason("notanumber|reason")).toEqual({ code: 1, reason: "reason" });
});

test("topicBus delivers published payloads only to subscribers", () => {
  const received: string[] = [];
  const subscriber = {
    send(payload: Uint8Array) {
      received.push(new TextDecoder().decode(payload));
    },
  };
  const nonSubscriber = {
    send(payload: Uint8Array) {
      received.push(`unexpected:${new TextDecoder().decode(payload)}`);
    },
  };

  topicBus.subscribe("TEST_TOPIC", subscriber);
  topicBus.publish("TEST_TOPIC", new TextEncoder().encode("payload-1"));
  topicBus.publish("OTHER_TOPIC", new TextEncoder().encode("payload-2"));

  expect(received).toEqual(["payload-1"]);

  topicBus.unsubscribe("TEST_TOPIC", subscriber);
  topicBus.publish("TEST_TOPIC", new TextEncoder().encode("payload-3"));

  expect(received).toEqual(["payload-1"]);

  topicBus.subscribe("TEST_TOPIC", subscriber);
  topicBus.clear(subscriber);
  topicBus.publish("TEST_TOPIC", new TextEncoder().encode("payload-4"));

  expect(received).toEqual(["payload-1"]);

  topicBus.clear(nonSubscriber);
});

test("topicBus ignores subscriber send failures", () => {
  const failing = {
    send() {
      throw new Error("send failed");
    },
  };

  topicBus.subscribe("FAILING_TOPIC", failing);
  expect(() => topicBus.publish("FAILING_TOPIC", new TextEncoder().encode("x"))).not.toThrow();
  topicBus.clear(failing);
});
