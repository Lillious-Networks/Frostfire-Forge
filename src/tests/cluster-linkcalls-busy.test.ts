import { expect, test } from "bun:test";
import { LinkCalls, MAX_CALL_BODY_BYTES, MAX_INFLIGHT_PER_PEER, SeqWindow, neverRan } from "../cluster/linkcalls";
import { LINK_FRAME_MAX_BYTES, decodeLinkFrame, encodeLinkFrame } from "../cluster/linkproto";
import { linkPair, settle } from "./cluster-fakelink";

// b serves; a is a raw link the test drives, so it can send any frame and read every answer.
function served() {
  const { a, b } = linkPair();
  const calls = new LinkCalls();
  calls.attach(b);
  const answers: any[] = [];
  a.on("ANSWER", (data) => answers.push(data));
  return { a, b, calls, answers };
}

test("SeqWindow.has knows the numbers admitted", () => {
  const window = new SeqWindow();
  expect(window.has(3)).toBe(false);
  window.admit(3);
  expect(window.has(3)).toBe(true);
});

test("past the cap a new call is answered busy and does not run", async () => {
  const { a, calls, answers } = served();
  try {
    let ran = 0;
    const gates: Array<() => void> = [];
    calls.handle("HOLD", () => { ran++; return new Promise<void>((resolve) => gates.push(resolve)); });
    for (let seq = 1; seq <= MAX_INFLIGHT_PER_PEER + 1; seq++) a.send("b", "CALL", { seq, epoch: "e1", name: "HOLD", body: null });
    await settle();
    expect(ran).toBe(MAX_INFLIGHT_PER_PEER);
    expect(answers).toEqual([{ seq: MAX_INFLIGHT_PER_PEER + 1, epoch: "e1", busy: true }]);
    for (const open of gates.splice(0)) open();
  } finally {
    calls.detach();
  }
});

test("a call refused as busy runs when it is sent again", async () => {
  const { a, calls, answers } = served();
  try {
    let ran = 0;
    const gates: Array<() => void> = [];
    calls.handle("HOLD", () => { ran++; return new Promise<void>((resolve) => gates.push(resolve)); });
    const last = MAX_INFLIGHT_PER_PEER + 1;
    for (let seq = 1; seq <= last; seq++) a.send("b", "CALL", { seq, epoch: "e1", name: "HOLD", body: null });
    await settle();
    for (const open of gates.splice(0)) open();
    await settle();
    answers.length = 0;
    a.send("b", "CALL", { seq: last, epoch: "e1", name: "HOLD", body: null });
    await settle();
    expect(ran).toBe(last);
    for (const open of gates.splice(0)) open();
    await settle();
    expect(answers).toEqual([{ seq: last, epoch: "e1", answer: null }]);
  } finally {
    calls.detach();
  }
});

test("a resend of a running call is not refused as busy", async () => {
  const { a, calls, answers } = served();
  try {
    const gates: Array<() => void> = [];
    calls.handle("HOLD", () => new Promise<void>((resolve) => gates.push(resolve)));
    for (let seq = 1; seq <= MAX_INFLIGHT_PER_PEER; seq++) a.send("b", "CALL", { seq, epoch: "e1", name: "HOLD", body: null });
    await settle();
    // The link was replaced and the caller sent seq 1 again: it is still running, so nothing is answered yet.
    a.send("b", "CALL", { seq: 1, epoch: "e1", name: "HOLD", body: null });
    await settle();
    expect(answers).toEqual([]);
    for (const open of gates.splice(0)) open();
  } finally {
    calls.detach();
  }
});

test("a resend too old for the window is answered failed at the cap, never busy", async () => {
  const { a, calls, answers } = served();
  try {
    const gates: Array<() => void> = [];
    calls.handle("QUICK", () => "done");
    calls.handle("HOLD", () => new Promise<void>((resolve) => gates.push(resolve)));
    // Seq 5000 runs and raises the window past seq 1, which may have run long ago and been dropped.
    a.send("b", "CALL", { seq: 5000, epoch: "e1", name: "QUICK", body: null });
    await settle();
    for (let seq = 5001; seq <= 5000 + MAX_INFLIGHT_PER_PEER; seq++) a.send("b", "CALL", { seq, epoch: "e1", name: "HOLD", body: null });
    await settle();
    answers.length = 0;
    a.send("b", "CALL", { seq: 1, epoch: "e1", name: "QUICK", body: null });
    await settle();
    expect(answers).toEqual([{ seq: 1, epoch: "e1", failed: true }]);
    for (const open of gates.splice(0)) open();
  } finally {
    calls.detach();
  }
});

test("a busy answer to a copy sent before a resend does not end the call", async () => {
  // a calls; b is a raw link the test drives, so it can answer each copy as it likes.
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  const copies: any[] = [];
  b.on("CALL", (data) => copies.push(data));
  try {
    let outcome: unknown = null;
    void caller.call("b", "TAKE", null).then((result) => { outcome = result; });
    await settle();
    // The link is replaced: the caller sends the call again, as its second copy.
    a.replace();
    await settle();
    expect(copies.map((copy) => copy.try)).toEqual([undefined, 2]);
    const { seq, epoch } = copies[0];
    // The first copy was refused as busy; the second ran.
    b.send("a", "ANSWER", { seq, epoch, busy: true });
    await settle();
    expect(outcome).toBeNull();
    b.send("a", "ANSWER", { seq, epoch, answer: "taken" });
    await settle();
    expect(outcome).toEqual({ ok: true, answer: "taken" });
  } finally {
    caller.detach();
  }
});

test("a busy answer to the latest copy ends the call busy", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  const copies: any[] = [];
  b.on("CALL", (data) => copies.push(data));
  try {
    const pending = caller.call("b", "TAKE", null);
    await settle();
    a.replace();
    await settle();
    const { seq, epoch } = copies[0];
    b.send("a", "ANSWER", { seq, epoch, busy: true, try: 2 });
    const outcome = await pending;
    expect(outcome).toEqual({ ok: false, why: "busy" });
    expect(neverRan(outcome)).toBe(true);
  } finally {
    caller.detach();
  }
});

test("a busy answer names the copy it refuses", async () => {
  const { a, calls, answers } = served();
  try {
    const gates: Array<() => void> = [];
    calls.handle("HOLD", () => new Promise<void>((resolve) => gates.push(resolve)));
    for (let seq = 1; seq <= MAX_INFLIGHT_PER_PEER; seq++) a.send("b", "CALL", { seq, epoch: "e1", name: "HOLD", body: null });
    await settle();
    a.send("b", "CALL", { seq: MAX_INFLIGHT_PER_PEER + 1, epoch: "e1", name: "HOLD", body: null, try: 3 });
    await settle();
    expect(answers).toEqual([{ seq: MAX_INFLIGHT_PER_PEER + 1, epoch: "e1", busy: true, try: 3 }]);
    for (const open of gates.splice(0)) open();
  } finally {
    calls.detach();
  }
});

test("the caller sees a busy answer as busy, and neverRan says it did not run", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  const server = new LinkCalls();
  caller.attach(a);
  server.attach(b);
  try {
    const gates: Array<() => void> = [];
    server.handle("HOLD", () => new Promise<void>((resolve) => gates.push(resolve)));
    const held = Array.from({ length: MAX_INFLIGHT_PER_PEER }, () => caller.call("b", "HOLD", null));
    await settle();
    const outcome = await caller.call("b", "HOLD", null);
    expect(outcome).toEqual({ ok: false, why: "busy" });
    expect(neverRan(outcome)).toBe(true);
    for (const open of gates.splice(0)) open();
    await Promise.all(held);
  } finally {
    caller.detach();
    server.detach();
  }
});

test("a body over the limit ends too-big and sends nothing", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  try {
    const outcome = await caller.call("b", "BIG", { blob: "x".repeat(MAX_CALL_BODY_BYTES + 1) });
    expect(outcome).toEqual({ ok: false, why: "too-big", unsent: true });
    expect(neverRan(outcome)).toBe(true);
    expect(a.sent).toEqual([]);
  } finally {
    caller.detach();
    void b;
  }
});

test("a call to a link that is not up is unsent", async () => {
  const { a } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  a.up = false;
  try {
    const outcome = await caller.call("b", "X", null);
    expect(outcome).toEqual({ ok: false, why: "down", unsent: true });
    expect(neverRan(outcome)).toBe(true);
  } finally {
    caller.detach();
  }
});

test("neverRan is false for a timeout and for a down after sending", async () => {
  expect(neverRan({ ok: false, why: "timeout" })).toBe(false);
  expect(neverRan({ ok: false, why: "down" })).toBe(false);
  expect(neverRan({ ok: false, why: "failed" })).toBe(false);
  expect(neverRan({ ok: true, answer: 1 })).toBe(false);
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  try {
    const pending = caller.call("b", "SLOW", null);
    a.setUp(false);
    const outcome = await pending;
    expect(outcome).toEqual({ ok: false, why: "down" });
    expect(neverRan(outcome)).toBe(false);
  } finally {
    caller.detach();
    void b;
  }
});

test("a frame over the limit is not decoded", () => {
  const small = encodeLinkFrame("CALL", { x: 1 });
  expect(decodeLinkFrame(small)).toEqual({ t: "CALL", d: { x: 1 } });
  expect(decodeLinkFrame(small, small.byteLength - 1)).toBeNull();
  expect(LINK_FRAME_MAX_BYTES).toBe(4 * 1024 * 1024);
});

test("a first send the link refuses ends the call down and unsent", async () => {
  const calls = new LinkCalls();
  const refusing = { self: "a", isUp: () => true, send: () => false, sendDatagram: () => false, on: () => {}, onDatagram: () => {}, onPeerUp: () => {}, onPeerDown: () => {} } as any;
  calls.attach(refusing);
  try {
    expect(await calls.call("b", "ECHO", {})).toEqual({ ok: false, why: "down", unsent: true });
  } finally {
    calls.detach();
  }
});
