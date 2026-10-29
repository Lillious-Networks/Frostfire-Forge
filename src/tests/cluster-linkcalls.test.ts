import { expect, test } from "bun:test";
import { onApplyEffect, sendEffect, swapApplierForTest } from "../cluster/effects";
import { LinkCalls, SeqWindow, linkCalls } from "../cluster/linkcalls";
import { FakeLink, linkPair, settle } from "./cluster-fakelink";

// Two LinkCalls joined by a fake link pair: a on "a", b on "b".
function pair(timeoutMs = 10_000) {
  const { a, b } = linkPair();
  const ca = new LinkCalls(timeoutMs);
  const cb = new LinkCalls(timeoutMs);
  ca.attach(a);
  cb.attach(b);
  return { a, b, ca, cb };
}

test("a call reaches the handler and its answer comes back", async () => {
  const { ca, cb } = pair();
  cb.handle("ECHO", (body, from) => ({ got: body.n, from }));
  const outcome = await ca.call<{ got: number; from: string }>("b", "ECHO", { n: 7 });
  expect(outcome).toEqual({ ok: true, answer: { got: 7, from: "a" } });
});

test("a call to a peer that is not up fails at once as down", async () => {
  const { a, ca } = pair();
  a.setUp(false);
  expect(await ca.call("b", "ECHO", {})).toEqual({ ok: false, why: "down", unsent: true });
  expect(ca.isUp("b")).toBe(false);
});

test("a resend after a link replacement is applied once", async () => {
  const { a, ca, cb } = pair();
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  cb.handle("SLOW", async () => { runs++; await gate; return "done"; });
  const outcome = ca.call("b", "SLOW", {});
  await settle();
  a.replace(); // an up with no down: pending calls are sent again with their seq
  await settle();
  release();
  expect(await outcome).toEqual({ ok: true, answer: "done" });
  expect(runs).toBe(1);
  expect(a.sent.filter((kind) => kind === "CALL").length).toBe(2); // the call, and its resend
});

test("a lost answer is answered again from the cache, without a second run", async () => {
  const { a, b, ca, cb } = pair();
  let runs = 0;
  cb.handle("COUNT", () => ++runs);
  b.blackhole = true; // the first answer is lost
  const outcome = ca.call("b", "COUNT", {});
  await settle();
  b.blackhole = false;
  a.replace();
  expect(await outcome).toEqual({ ok: true, answer: 1 });
  expect(runs).toBe(1);
});

test("a peer-down fails pending calls as down", async () => {
  const { a, b, ca, cb } = pair();
  cb.handle("NEVER", () => new Promise(() => {}));
  const outcome = ca.call("b", "NEVER", {});
  await settle();
  a.setUp(false);
  expect(await outcome).toEqual({ ok: false, why: "down" });
  expect(b.up).toBe(false);
});

test("a call with no answer times out", async () => {
  const { ca, cb } = pair(20);
  cb.handle("NEVER", () => new Promise(() => {}));
  expect(await ca.call("b", "NEVER", {})).toEqual({ ok: false, why: "timeout" });
});

test("a throwing handler, or a name with no handler, answers failed", async () => {
  const { ca, cb } = pair();
  cb.handle("THROW", () => { throw new Error("no"); });
  expect(await ca.call("b", "THROW", {})).toEqual({ ok: false, why: "failed" });
  expect(await ca.call("b", "UNKNOWN", {})).toEqual({ ok: false, why: "failed" });
});

test("a cast reaches its handler and has no answer", async () => {
  const { ca, cb } = pair();
  const seen: unknown[] = [];
  cb.onCast("NOTE", (body, from) => seen.push([body, from]));
  expect(ca.cast("b", "NOTE", { x: 1 })).toBe(true);
  await settle();
  expect(seen).toEqual([[{ x: 1 }, "a"]]);
});

test("a second handler for one name throws, and the unregister frees the name", () => {
  const calls = new LinkCalls();
  const off = calls.handle("X", () => 1);
  expect(() => calls.handle("X", () => 2)).toThrow();
  off();
  expect(() => calls.handle("X", () => 3)).not.toThrow();
  const offCast = calls.onCast("Y", () => {});
  expect(() => calls.onCast("Y", () => {})).toThrow();
  offCast();
});

test("the window admits once, answers from cache, and refuses what fell out of it", () => {
  const window = new SeqWindow(4);
  expect(window.admit(1)).toEqual({ state: "new" });
  expect(window.admit(1)).toEqual({ state: "pending" });
  window.settle(1, "one");
  expect(window.admit(1)).toEqual({ state: "done", answer: "one", failed: false });
  for (let seq = 2; seq <= 9; seq++) window.admit(seq);
  expect(window.admit(5)).toEqual({ state: "stale" });
  expect(window.admit(0)).toEqual({ state: "stale" });
  expect(window.admit(10)).toEqual({ state: "new" });
});

test("a detach fails pending calls, and a re-attach answers again on a new epoch", async () => {
  const { ca, cb } = pair();
  cb.handle("NEVER", () => new Promise(() => {}));
  const outcome = ca.call("b", "NEVER", {});
  await settle();
  ca.detach();
  expect(await outcome).toEqual({ ok: false, why: "down" });
  // A new pair: NodeLinks allows one handler per kind, so a re-attach is always to new links.
  const { a: a2, b: b2 } = linkPair();
  ca.attach(a2);
  cb.attach(b2);
  cb.handle("AGAIN", () => "yes");
  expect(await ca.call("b", "AGAIN", {})).toEqual({ ok: true, answer: "yes" });
});

test("sendEffect returns the owner's EFFECT_RESULT, and null when the link is down", async () => {
  // The singleton sends; the owner is a plain LinkCalls that answers APPLY_EFFECT itself.
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  owner.handle("APPLY_EFFECT", (effect, from) => ({ outcome: "applied", reason: `${effect.op}:${effect.target}:${effect.body.amount}:${from}` }));
  try {
    expect(await sendEffect("b", { op: "creature_threat", target: 9, body: { amount: 3 } })).toEqual({ outcome: "applied", reason: "creature_threat:9:3:a" });
    b.setUp(false);
    expect(await sendEffect("b", { op: "creature_threat", target: 9, body: { amount: 3 } })).toBeNull();
  } finally {
    linkCalls.detach();
  }
});

test("the singleton serves APPLY_EFFECT through onApplyEffect", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  // Later tasks register real appliers at module load, in the same process: swap the ops used here.
  const restoreHit = swapApplierForTest("creature_hit", (target, body, from) => ({ outcome: body.amount > 5 ? "killed" : "applied", reason: `${target}@${from}` }));
  const restoreMissing = swapApplierForTest("player_hit", null);
  try {
    expect(await caller.call("b", "APPLY_EFFECT", { op: "creature_hit", target: 4, body: { amount: 9 } })).toEqual({ ok: true, answer: { outcome: "killed", reason: "4@a" } });
    expect(await caller.call("b", "APPLY_EFFECT", { op: "player_hit", target: 4, body: {} })).toEqual({ ok: true, answer: { outcome: "missing" } });
    expect(() => onApplyEffect("creature_hit", () => ({ outcome: "applied" }))).toThrow();
  } finally {
    restoreMissing();
    restoreHit();
    linkCalls.detach();
  }
});

// A CALL frame as a caller sends it, for tests that talk to a LinkCalls through a bare link.
const frame = (seq: number, epoch: string, name: string) => ({ seq, epoch, name, body: {} });

test("an answer from the wrong epoch, for no pending call, or from the wrong peer is ignored", async () => {
  const { a, b } = linkPair();
  const ca = new LinkCalls(2_000);
  ca.attach(a);
  let sent: { seq: number; epoch: string } | null = null;
  b.on("CALL", (data) => { sent = data; });
  const c = new FakeLink("c"); // a third node answering on a's link
  c.other = a;
  const outcome = ca.call("b", "ASK", {});
  await settle();
  const { seq, epoch } = sent!;
  b.send("a", "ANSWER", { seq, epoch: "other", answer: 1 });
  b.send("a", "ANSWER", { seq: seq + 50, epoch, answer: 2 });
  c.send("a", "ANSWER", { seq, epoch, answer: 3 });
  await settle();
  b.send("a", "ANSWER", { seq, epoch, answer: 42 }); // the call was still waiting for this one
  expect(await outcome).toEqual({ ok: true, answer: 42 });
});

test("a new epoch from a peer replaces its window, so a restarted caller runs again", async () => {
  const { a, b, ca, cb } = pair();
  let runs = 0;
  cb.handle("COUNT", () => ++runs);
  expect(await ca.call("b", "COUNT", {})).toEqual({ ok: true, answer: 1 });
  // The caller restarts on new links: a new epoch, and its seq counts from 1 again.
  const a2 = new FakeLink("a");
  a2.other = b;
  b.other = a2;
  ca.attach(a2);
  expect(await ca.call("b", "COUNT", {})).toEqual({ ok: true, answer: 2 });
  expect(runs).toBe(2);
  expect(a.sent.filter((kind) => kind === "CALL").length).toBe(1);
});

test("a late frame of a retired epoch does not bring the old window back", async () => {
  const { a, b } = linkPair();
  const cb = new LinkCalls();
  cb.attach(b);
  let runs = 0;
  cb.handle("COUNT", () => ++runs);
  const answers: unknown[] = [];
  a.on("ANSWER", (data) => answers.push(data.answer));
  a.send("b", "CALL", frame(1, "E1", "COUNT"));
  await settle();
  a.send("b", "CALL", frame(1, "E2", "COUNT"));
  await settle();
  a.send("b", "CALL", frame(2, "E1", "COUNT")); // from a connection that was replaced
  await settle();
  a.send("b", "CALL", frame(1, "E2", "COUNT")); // a resend of the call that already ran
  await settle();
  expect(runs).toBe(2);
  expect(answers).toEqual([1, 2, 2]);
});

test("a call that failed is answered failed again from the cache, and a call outside the window is refused", async () => {
  const { a, b } = linkPair();
  const cb = new LinkCalls();
  cb.attach(b);
  let runs = 0;
  cb.handle("BAD", () => { runs++; throw new Error("no"); });
  cb.handle("OK", () => { runs++; return "ok"; });
  const answers: Array<{ seq: number; answer?: unknown; failed?: boolean }> = [];
  a.on("ANSWER", (data) => answers.push(data));
  a.send("b", "CALL", frame(1, "E", "BAD"));
  await settle();
  a.send("b", "CALL", frame(1, "E", "BAD")); // sent again after the answer was lost
  await settle();
  expect(runs).toBe(1);
  expect(answers.map((x) => [x.seq, !!x.failed])).toEqual([[1, true], [1, true]]);
  answers.length = 0;
  a.send("b", "CALL", frame(5000, "E", "OK"));
  await settle();
  a.send("b", "CALL", frame(904, "E", "OK")); // 4096 behind the highest: its answer may have been dropped
  await settle();
  expect(runs).toBe(2);
  expect(answers.map((x) => [x.seq, !!x.failed])).toEqual([[5000, false], [904, true]]);
});

test("attaching the links already in use changes nothing", async () => {
  const { a, ca, cb } = pair();
  cb.handle("ECHO", () => "echo");
  const outcome = ca.call("b", "ECHO", {});
  ca.attach(a);
  expect(await outcome).toEqual({ ok: true, answer: "echo" });
});

test("every timer a call starts is cleared when the call ends", async () => {
  const live = new Set<unknown>();
  const setTimer = globalThis.setTimeout;
  const clearTimer = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const timer = setTimer(fn, ms);
    live.add(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: any) => {
    live.delete(timer);
    clearTimer(timer);
  }) as typeof clearTimeout;
  try {
    const { a, ca, cb } = pair();
    cb.handle("ECHO", () => "echo");
    cb.handle("NEVER", () => new Promise(() => {}));
    await ca.call("b", "ECHO", {});
    expect(live.size).toBe(0);
    const down = ca.call("b", "NEVER", {});
    await settle();
    expect(live.size).toBe(1);
    a.setUp(false);
    await down;
    expect(live.size).toBe(0);
    a.setUp(true);
    const detached = ca.call("b", "NEVER", {});
    await settle();
    expect(live.size).toBe(1);
    ca.detach();
    await detached;
    expect(live.size).toBe(0);
  } finally {
    globalThis.setTimeout = setTimer;
    globalThis.clearTimeout = clearTimer;
  }
});
