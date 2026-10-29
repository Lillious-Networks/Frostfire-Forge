import { expect, test } from "bun:test";
import { FORWARD_CALL, LinkCalls } from "../cluster/linkcalls";
import { linkMesh, settle } from "./cluster-fakelink";

// Three nodes: "a" sends, "b" is the old owner of an entity, "c" the new one.

function mesh(timeoutMs = 500) {
  const links = linkMesh(["a", "b", "c"] as const);
  const calls = { a: new LinkCalls(timeoutMs), b: new LinkCalls(timeoutMs), c: new LinkCalls(timeoutMs) };
  calls.a.attach(links.a);
  calls.b.attach(links.b);
  calls.c.attach(links.c);
  const stop = () => { calls.a.detach(); calls.b.detach(); calls.c.detach(); };
  return { links, calls, stop };
}

test("a call that reached the old owner runs on the new owner, as from its sender", async () => {
  const { calls, stop } = mesh();
  try {
    const seen: string[] = [];
    calls.b.handle("HIT", () => ({ ran: "b" }));
    calls.c.handle("HIT", (_body, from) => { seen.push(from); return { ran: "c" }; });
    calls.b.setRedirect((name) => (name === "HIT" ? "c" : null));
    const outcome = await calls.a.call<{ ran: string }>("b", "HIT", { amount: 5 });
    expect(outcome).toEqual({ ok: true, answer: { ran: "c" } });
    // Guard: the new owner checks the original sender (mirror ownership), not the node that forwarded it.
    expect(seen).toEqual(["a"]);
  } finally {
    stop();
  }
});

test("a call redirected to its own sender runs here instead", async () => {
  const { calls, stop } = mesh();
  try {
    calls.b.handle("HIT", () => ({ ran: "b" }));
    calls.a.handle("HIT", () => ({ ran: "a" }));
    calls.b.setRedirect(() => "a");
    // Guard: forwarding back to the sender would loop between two nodes that disagree about the owner.
    expect(await calls.a.call("b", "HIT", {})).toEqual({ ok: true, answer: { ran: "b" } });
  } finally {
    stop();
  }
});

test("a forward is not sent back to the original caller", async () => {
  const { calls, stop } = mesh();
  try {
    let ranOnC = 0;
    calls.c.handle("HIT", () => { ranOnC++; return "c"; });
    calls.a.handle("HIT", () => "a");
    calls.b.setRedirect(() => "c");
    calls.c.setRedirect(() => "a");
    // Guard: to !== from in forwarded(). c runs it rather than send it back to a, its original caller.
    expect(await calls.a.call("b", "HIT", {})).toEqual({ ok: true, answer: "c" });
    expect(ranOnC).toBe(1);
  } finally {
    stop();
  }
});

test("the same forwarded call runs once, and its answer is sent again from the window", async () => {
  const { calls, stop } = mesh();
  try {
    let runs = 0;
    calls.c.handle("GRANT", () => ++runs);
    const body = { from: "a", epoch: "e1", seq: 1, name: "GRANT", body: { item: "Copper Ore" } };
    expect(await calls.b.call("c", FORWARD_CALL, body)).toEqual({ ok: true, answer: { answer: 1 } });
    // Guard: the per-sender window. Without it a forward that was sent again (the old owner restarted and the
    // sender resent) grants the item twice.
    expect(await calls.b.call("c", FORWARD_CALL, body)).toEqual({ ok: true, answer: { answer: 1 } });
    expect(runs).toBe(1);
  } finally {
    stop();
  }
});

test("a forward that arrives while the first copy still runs is refused, not run", async () => {
  const { calls, stop } = mesh();
  try {
    let runs = 0;
    let finish: () => void = () => {};
    calls.c.handle("GRANT", () => { runs++; return new Promise<string>((resolve) => { finish = () => resolve("done"); }); });
    const body = { from: "a", epoch: "e1", seq: 7, name: "GRANT", body: {} };
    const first = calls.b.call("c", FORWARD_CALL, body);
    await settle();
    const second = await calls.b.call("c", FORWARD_CALL, body);
    expect(second).toEqual({ ok: true, answer: { failed: true } });
    finish();
    expect(await first).toEqual({ ok: true, answer: { answer: "done" } });
    expect(runs).toBe(1);
  } finally {
    stop();
  }
});

test("a forward that fails ends the original call as failed", async () => {
  const { links, calls, stop } = mesh();
  try {
    let ranOnB = 0;
    calls.b.handle("HIT", () => { ranOnB++; return "b"; });
    calls.b.setRedirect(() => "c");
    links.b.setUp("c", false);
    // Guard: a forward that did not reach the new owner must not fall back to running on the old one.
    expect(await calls.a.call("b", "HIT", {})).toEqual({ ok: false, why: "failed" });
    expect(ranOnB).toBe(0);
  } finally {
    stop();
  }
});

test("forward windows are kept for the 64 most recent senders' epochs", async () => {
  const { calls, stop } = mesh();
  try {
    let runs = 0;
    calls.c.handle("GRANT", () => ++runs);
    for (let i = 0; i < 65; i++) await calls.b.call("c", FORWARD_CALL, { from: "a", epoch: `e${i}`, seq: 1, name: "GRANT", body: {} });
    expect(runs).toBe(65);
    await calls.b.call("c", FORWARD_CALL, { from: "a", epoch: "e64", seq: 1, name: "GRANT", body: {} });
    expect(runs).toBe(65);
    await calls.b.call("c", FORWARD_CALL, { from: "a", epoch: "e0", seq: 1, name: "GRANT", body: {} });
    expect(runs).toBe(66);
  } finally {
    stop();
  }
});

test("a forward window that was used again is kept, and the least recently used one is dropped", async () => {
  const { calls, stop } = mesh();
  try {
    let runs = 0;
    calls.c.handle("GRANT", () => ++runs);
    const forward = (epoch: string) => calls.b.call("c", FORWARD_CALL, { from: "a", epoch, seq: 1, name: "GRANT", body: {} });
    for (let i = 0; i < 64; i++) await forward(`e${i}`);
    expect(runs).toBe(64);
    // Guard: a use moves a window to the back. Without it e0 is dropped by the next new epoch, though e1 is older in use.
    await forward("e0");
    expect(runs).toBe(64);
    await forward("e64");
    expect(runs).toBe(65);
    await forward("e0");
    expect(runs).toBe(65);
    await forward("e1");
    expect(runs).toBe(66);
  } finally {
    stop();
  }
});

test("a peer-down hook runs after the calls pending to that peer failed, and can be removed", async () => {
  const { links, calls, stop } = mesh(5_000);
  try {
    calls.b.handle("SLOW", () => new Promise(() => {}));
    const pending = calls.a.call("b", "SLOW", {});
    const seen: string[] = [];
    let settledFirst = false;
    void pending.then(() => { settledFirst = true; });
    const off = calls.a.onPeerDown((peer) => { seen.push(`${peer}:${settledFirst}`); });
    await settle();
    links.a.setUp("b", false);
    expect(await pending).toEqual({ ok: false, why: "down" });
    await settle();
    expect(seen).toEqual(["b:false"]);
    off();
    links.a.setUp("b", true);
    links.a.setUp("b", false);
    expect(seen).toEqual(["b:false"]);
    const ups: string[] = [];
    const offUp = calls.a.onPeerUp((peer) => ups.push(peer));
    links.a.setUp("c", false);
    links.a.setUp("c", true);
    expect(ups).toEqual(["c"]);
    offUp();
  } finally {
    stop();
  }
});

test("a call can set its own, shorter timeout", async () => {
  const { calls, stop } = mesh(5_000);
  try {
    calls.b.handle("SLOW", () => new Promise(() => {}));
    const started = Date.now();
    expect(await calls.a.call("b", "SLOW", {}, { timeoutMs: 50 })).toEqual({ ok: false, why: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    stop();
  }
});

test("a detached node's forward windows are forgotten", async () => {
  const { links, calls, stop } = mesh();
  try {
    let runs = 0;
    calls.c.handle("GRANT", () => ++runs);
    const body = { from: "a", epoch: "e1", seq: 1, name: "GRANT", body: {} };
    await calls.b.call("c", FORWARD_CALL, body);
    calls.c.detach();
    calls.c.attach(links.c);
    await calls.b.call("c", FORWARD_CALL, body);
    expect(runs).toBe(2);
  } finally {
    stop();
  }
});

test("the peer-down hook runs after the pending call failed, and the peer-up hook after it was sent again", async () => {
  const { links, calls, stop } = mesh(5_000);
  try {
    calls.b.handle("SLOW", () => new Promise(() => {}));
    const pending = calls.a.call("b", "SLOW", {});
    await settle();
    const callsSent = () => links.a.sent.filter((m) => m.peer === "b" && m.kind === "CALL").length;
    const atUp: number[] = [];
    calls.a.onPeerUp(() => { atUp.push(callsSent()); });
    // Guard: hooks run after the resend, so a hook that sends its own call does not overtake the pending ones.
    links.a.setUp("b", true);
    expect(atUp).toEqual([2]);
    const atDown: string[] = [];
    calls.a.onPeerDown(() => { atDown.push(Bun.peek.status(pending)); });
    // Guard: hooks run after the pending calls ended, so a hook can start over without meeting its old call.
    links.a.setUp("b", false);
    expect(atDown).toEqual(["fulfilled"]);
    expect(await pending).toEqual({ ok: false, why: "down" });
  } finally {
    stop();
  }
});

test("a hook that throws does not keep the others from running", async () => {
  const { links, calls, stop } = mesh();
  try {
    const seen: string[] = [];
    calls.a.onPeerDown(() => { throw new Error("hook failed"); });
    calls.a.onPeerDown((peer) => { seen.push(peer); });
    calls.a.onPeerUp(() => { throw new Error("hook failed"); });
    calls.a.onPeerUp((peer) => { seen.push(`up:${peer}`); });
    links.a.setUp("b", false);
    links.a.setUp("b", true);
    expect(seen).toEqual(["b", "up:b"]);
  } finally {
    stop();
  }
});

test("a call redirected to this node itself runs here", async () => {
  const { calls, stop } = mesh();
  try {
    calls.b.handle("HIT", () => ({ ran: "b" }));
    calls.b.setRedirect(() => "b");
    // Guard: `to !== links.self`. Without it b forwards to itself, finds no link to itself and fails the call.
    expect(await calls.a.call("b", "HIT", {})).toEqual({ ok: true, answer: { ran: "b" } });
  } finally {
    stop();
  }
});

test("a forward that carries a forward is refused", async () => {
  const { calls, stop } = mesh();
  try {
    let runs = 0;
    calls.c.handle("GRANT", () => ++runs);
    const inner = { from: "a", epoch: "e2", seq: 1, name: "GRANT", body: {} };
    // Guard: `name === FORWARD_CALL` in `forwarded`. Without it the inner call runs after a second hop.
    expect(await calls.b.call("c", FORWARD_CALL, { from: "a", epoch: "e1", seq: 1, name: FORWARD_CALL, body: inner }))
      .toEqual({ ok: true, answer: { failed: true } });
    expect(runs).toBe(0);
  } finally {
    stop();
  }
});

test("a forward is refused when it names this node, or the node that forwarded it, as the original sender", async () => {
  const { calls, stop } = mesh();
  try {
    let runs = 0;
    calls.c.handle("GRANT", () => ++runs);
    // Guard: the original sender is never this node itself (it would run as its own call) ...
    expect(await calls.b.call("c", FORWARD_CALL, { from: "c", epoch: "e1", seq: 1, name: "GRANT", body: {} }))
      .toEqual({ ok: true, answer: { failed: true } });
    // ... and never the forwarding node (an honest forward names the node the call came from).
    expect(await calls.b.call("c", FORWARD_CALL, { from: "b", epoch: "e1", seq: 1, name: "GRANT", body: {} }))
      .toEqual({ ok: true, answer: { failed: true } });
    expect(runs).toBe(0);
  } finally {
    stop();
  }
});

test("forward windows of different senders and epochs never share a key", async () => {
  const { calls, stop } = mesh();
  try {
    let runs = 0;
    calls.c.handle("GRANT", () => ++runs);
    // Guard: the window key. With a plain "from|epoch" join these two are the same key, and the second is
    // answered from the first one's cache without running.
    await calls.b.call("c", FORWARD_CALL, { from: "a|x", epoch: "y", seq: 1, name: "GRANT", body: {} });
    await calls.b.call("c", FORWARD_CALL, { from: "a", epoch: "x|y", seq: 1, name: "GRANT", body: {} });
    expect(runs).toBe(2);
  } finally {
    stop();
  }
});

test("attaching again on the same link runs each peer hook once, and the old attach no longer answers", async () => {
  const { links, calls, stop } = mesh(200);
  try {
    let downs = 0;
    calls.a.onPeerDown(() => { downs++; });
    calls.a.detach();
    calls.a.attach(links.a);
    // Guard: a token per attach. With `links` as the test, the first attach's hook closure is live again and
    // the hook runs twice.
    links.a.setUp("b", false);
    expect(downs).toBe(1);
    links.a.setUp("b", true);

    let finish: () => void = () => {};
    calls.b.handle("SLOW", () => new Promise<string>((resolve) => { finish = () => resolve("late"); }));
    const pending = calls.a.call("b", "SLOW", {}, { timeoutMs: 100 });
    await settle();
    calls.b.detach();
    calls.b.attach(links.b);
    const before = links.b.sent.length;
    finish();
    await settle();
    // Guard: a call that was running before a detach does not answer after a new attach.
    expect(links.b.sent.length).toBe(before);
    expect(await pending).toEqual({ ok: false, why: "timeout" });
  } finally {
    stop();
  }
});
