import { afterEach, expect, test } from "bun:test";
import { LinkCalls } from "../cluster/linkcalls";
import { TRADE_SETTLING, TradeLink, type TradeAnswer, type TradeHandlers, type TradeLost } from "../cluster/tradelink";
import { TradeSettle } from "../cluster/tradesettle";
import { linkPair, settle } from "./cluster-fakelink";

// The marks peerDown makes (cluster/tradesettle.ts) go to a fence of these tests, not the node's: a mark there would
// hold up the writes of a player of the same name in another test file.
const fence = new TradeSettle({ ms: 200 });
afterEach(() => fence.reset({ ms: 200 }));

function pair(settleWaitMs = 400) {
  const { a, b } = linkPair();
  const ca = new LinkCalls(200);
  const cb = new LinkCalls(200);
  ca.attach(a);
  cb.attach(b);
  return { a, b, ca, cb, host: new TradeLink(ca, undefined, fence), partner: new TradeLink(cb, settleWaitMs, fence) };
}

function recorder(over: Partial<TradeHandlers> = {}) {
  const lost: TradeLost[] = [];
  const handlers: TradeHandlers = {
    answer: async () => ({ ok: true }),
    update: async () => ({ ok: true }),
    state: () => {},
    closed: () => {},
    lost: (body) => { lost.push(body); },
    ...over,
  };
  return { lost, handlers };
}

test("a link that goes down ends the trades across it on both sides", async () => {
  const { a, ca, cb, host, partner } = pair();
  try {
    const onHost = recorder();
    const onPartner = recorder();
    host.setHandlers(onHost.handlers);
    partner.setHandlers(onPartner.handlers);
    host.setPartner("Bob", "b", "s1");
    partner.setHost("Bob", "a", "s1");
    a.setUp(false);
    await settle();
    // Guard: the partners loop in peerDown.
    expect(onHost.lost).toEqual([{ role: "host", username: "bob", peer: "b" }]);
    expect(host.partnerPeer("bob")).toBeNull();
    // Guard: the hosts loop in peerDown.
    expect(onPartner.lost).toEqual([{ role: "partner", username: "bob", peer: "a" }]);
    expect(partner.hostOf("bob")).toBeNull();
  } finally {
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("only the trades across the peer that went down end", async () => {
  const { a, ca, cb, host, partner } = pair();
  try {
    const onHost = recorder();
    const onPartner = recorder();
    host.setHandlers(onHost.handlers);
    partner.setHandlers(onPartner.handlers);
    host.setPartner("Bob", "b", "s1");
    host.setPartner("Cid", "c", "s2");
    partner.setHost("Ann", "a", "s3");
    partner.setHost("Dan", "c", "s4");
    a.setUp(false);
    await settle();
    // Guard: `partner.peer !== peer` in the partners loop.
    expect(onHost.lost.map((l) => l.username)).toEqual(["bob"]);
    expect(host.partnerPeer("cid")).toBe("c");
    // Guard: `host.peer !== peer` in the hosts loop.
    expect(onPartner.lost.map((l) => l.username)).toEqual(["ann"]);
    expect(partner.hostOf("dan")).toBe("c");
  } finally {
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("a player whose update was pending is told once, by sendUpdate", async () => {
  const { a, b, ca, cb, host, partner } = pair();
  try {
    const onPartner = recorder();
    partner.setHandlers(onPartner.handlers);
    partner.setHost("Bob", "a", "s1");
    b.blackhole = true;
    const pending = partner.sendUpdate("Bob", "offer", { items: [] });
    await settle();
    a.setUp(false);
    const reply = await pending;
    await settle();
    expect(reply?.gone).toBe(true);
    // Guard: the `inflight` count. Without it the player gets TRADE_UNREACHABLE twice.
    expect(onPartner.lost).toEqual([]);
    expect(partner.hostOf("bob")).toBeNull();
  } finally {
    b.blackhole = false;
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("two updates in flight: the first to end does not make the player count as idle", async () => {
  const { a, ca, cb, host, partner } = pair();
  try {
    const onPartner = recorder();
    partner.setHandlers(onPartner.handlers);
    partner.setHost("Bob", "a", "s1");
    // The offer is answered at once; the accept is not answered before the link goes down.
    host.setHandlers(recorder({
      update: async (body) => {
        if (body.op === "accept") await new Promise((resolve) => setTimeout(resolve, 150));
        return { ok: true };
      },
    }).handlers);
    host.setPartner("Bob", "b", "s1");
    const accept = partner.sendUpdate("Bob", "accept");
    const offer = partner.sendUpdate("Bob", "offer", { items: [] });
    expect((await offer)?.ok).toBe(true);
    a.setUp(false);
    expect((await accept)?.gone).toBe(true);
    await settle();
    // Guard: a count, not a flag. A flag cleared by the offer, which ended first, would tell the player twice.
    expect(onPartner.lost).toEqual([]);
    expect(partner.hostOf("bob")).toBeNull();
  } finally {
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("a wait for the end of a swap on the peer ends at once", async () => {
  const { b, ca, cb, host, partner } = pair(10_000);
  try {
    const onPartner = recorder();
    partner.setHandlers(onPartner.handlers);
    // The host answers the first update by timing out, and the cancel after it with "settling".
    let updates = 0;
    host.setHandlers(recorder({
      update: async () => {
        updates++;
        if (updates === 1) await new Promise((resolve) => setTimeout(resolve, 400));
        return { ok: false, settling: true };
      },
    }).handlers);
    host.setPartner("Bob", "b", "s1");
    partner.setHost("Bob", "a", "s1");
    const started = Date.now();
    const pending = partner.sendUpdate("Bob", "accept");
    // Wait until the partner is waiting for the end of the swap.
    while (updates < 2) await settle();
    await settle();
    b.setUp(false);
    const reply = await pending;
    // Guard: ending the waits in peerDown. Without it the player waits the full 10 s.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reply?.gone).toBe(true);
    expect(onPartner.lost).toEqual([]);
  } finally {
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("a wait for the end of a swap on another peer goes on", async () => {
  const { ca, cb, host, partner } = pair(700);
  try {
    let updates = 0;
    host.setHandlers(recorder({
      update: async () => {
        updates++;
        if (updates === 1) await new Promise((resolve) => setTimeout(resolve, 400));
        return { ok: false, settling: true };
      },
    }).handlers);
    host.setPartner("Bob", "b", "s1");
    partner.setHandlers(recorder().handlers);
    partner.setHost("Bob", "a", "s1");
    const pending = partner.sendUpdate("Bob", "accept");
    while (updates < 2) await settle();
    await settle();
    // Guard: `wait.host.peer === peer`. A link to a node the trade does not run on ends nothing here.
    const waited = Date.now();
    partner.peerDown("zzz");
    const reply = await pending;
    expect(Date.now() - waited).toBeGreaterThanOrEqual(500);
    expect(reply?.gone).toBe(true);
  } finally {
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("a lost handler that throws does not stop the others", async () => {
  const { a, ca, cb, host, partner } = pair();
  try {
    const seen: string[] = [];
    host.setHandlers(recorder({ lost: (body) => { seen.push(body.username); throw new Error("boom"); } }).handlers);
    host.setPartner("Bob", "b", "s1");
    host.setPartner("Dee", "b", "s2");
    a.setUp(false);
    await settle();
    // Guard: run() around each lost call.
    expect(seen.sort()).toEqual(["bob", "dee"]);
    // Guard: run() around the partner's lost call too.
    const seenPartner: string[] = [];
    partner.setHandlers(recorder({ lost: (body) => { seenPartner.push(body.username); throw new Error("boom"); } }).handlers);
    partner.setHost("Eve", "a", "s3");
    partner.setHost("Fay", "a", "s4");
    partner.peerDown("a");
    await settle();
    expect(seenPartner.sort()).toEqual(["eve", "fay"]);
  } finally {
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("a lost handler that rejects does not stop the others", async () => {
  const { a, ca, cb, host, partner } = pair();
  try {
    const seen: string[] = [];
    host.setHandlers(recorder({ lost: async (body) => { seen.push(body.username); throw new Error("boom"); } }).handlers);
    host.setPartner("Bob", "b", "s1");
    host.setPartner("Dee", "b", "s2");
    a.setUp(false);
    await settle();
    expect(seen.sort()).toEqual(["bob", "dee"]);
  } finally {
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("a node without a lost handler still lets the trades go", async () => {
  const { a, ca, cb, host, partner } = pair();
  try {
    const { lost: _lost, ...bare } = recorder().handlers;
    host.setHandlers(bare);
    host.setPartner("Bob", "b", "s1");
    a.setUp(false);
    await settle();
    expect(host.partnerPeer("bob")).toBeNull();
  } finally {
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("peerDown marks this node's players whose trade the peer held, before their bags are read again", async () => {
  const { a, ca, cb, host, partner } = pair(10_000);
  try {
    // At the moment `lost` runs (where the bags are read again), whether the player is already marked.
    const markedAtLost: Record<string, boolean> = {};
    partner.setHandlers(recorder({ lost: (body) => { markedAtLost[body.username] = fence.unsettledUntil(body.username) !== null; } }).handlers);
    host.setHandlers(recorder({ lost: (body) => { markedAtLost[body.username] = fence.unsettledUntil(body.username) !== null; } }).handlers);
    // Both accepted their trade: a swap of either could be under way.
    partner.setHost("Ann", "a", "s1", true);
    partner.setHost("Dan", "c", "s2", true);
    host.setPartner("Cid", "b", "s3");
    a.setUp(false);
    await settle();
    // Guard: the mark in the hosts loop, made before `lost`.
    expect(markedAtLost.ann).toBe(true);
    expect(fence.unsettledUntil("ann")).not.toBeNull();
    // Guard: `host.peer !== peer` before the mark. A trade on another node is not touched.
    expect(fence.unsettledUntil("dan")).toBeNull();
    // A host's own players need no mark: their swap is made on their own node.
    expect(markedAtLost.cid).toBe(false);
    expect(fence.size).toBe(1);
  } finally {
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("a player whose update was in flight, or who waited for a swap's end, is marked as well, once", async () => {
  const { b, ca, cb, host, partner } = pair(10_000);
  try {
    partner.setHandlers(recorder().handlers);
    let updates = 0;
    host.setHandlers(recorder({
      update: async () => {
        updates++;
        if (updates === 1) await new Promise((resolve) => setTimeout(resolve, 400));
        return { ok: false, settling: true };
      },
    }).handlers);
    host.setPartner("Bob", "b", "s1");
    partner.setHost("Bob", "a", "s1");
    partner.setHost("Eve", "a", "s2");
    const waiting = partner.sendUpdate("Bob", "accept");
    while (updates < 2) await settle();
    await settle();
    b.blackhole = true;
    const pending = partner.sendUpdate("Eve", "accept");
    await settle();
    b.blackhole = false;
    b.setUp(false);
    // Marked in the same turn as the link went down: before either update is answered and the relay reads the bags.
    expect(fence.unsettledUntil("bob")).not.toBeNull();
    expect(fence.unsettledUntil("eve")).not.toBeNull();
    expect((await waiting)?.gone).toBe(true);
    expect((await pending)?.gone).toBe(true);
    // Guard: the mark in the hosts loop comes before `if (host.inflight) continue`.
    expect(fence.size).toBe(2);
  } finally {
    b.blackhole = false;
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("an update of an earlier trade still in flight does not hide the loss of the player's newer trade (M1)", async () => {
  const { b, ca, cb, host, partner } = pair();
  try {
    const onPartner = recorder();
    partner.setHandlers(onPartner.handlers);
    partner.setHost("Bob", "a", "s1");
    // An update of the first trade, held on a, that is not answered.
    b.blackhole = true;
    const old = partner.sendUpdate("Bob", "offer", { items: [] });
    await settle();
    // That trade ends (its TP_CLOSED), and Bob's next trade is held on node c.
    partner.dropHost("Bob");
    partner.setHost("Bob", "c", "s2");
    partner.peerDown("c");
    await settle();
    // Guard: the in-flight count is the trade's, not the player's. Keyed by name, the old update hid this loss.
    expect(onPartner.lost).toEqual([{ role: "partner", username: "bob", peer: "c" }]);
    expect(partner.hostOf("bob")).toBeNull();
    b.blackhole = false;
    await old;
  } finally {
    b.blackhole = false;
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

test("peerDown marks only the players who sent an accept: no swap can be under way for the others", async () => {
  const { a, ca, cb, host, partner } = pair();
  try {
    const onPartner = recorder();
    partner.setHandlers(onPartner.handlers);
    host.setHandlers(recorder().handlers);
    host.setPartner("Ann", "b", "s1");
    host.setPartner("Ida", "b", "s2");
    partner.setHost("Ann", "a", "s1");
    partner.setHost("Ida", "a", "s2");
    expect((await partner.sendUpdate("Ann", "accept"))?.ok).toBe(true);
    expect((await partner.sendUpdate("Ida", "offer", { items: [] }))?.ok).toBe(true);
    a.setUp(false);
    await settle();
    expect(fence.unsettled("ann")).toBe(true);
    // Guard: `if (host.accepted)`. Ida never accepted, so the host cannot have swapped: her writes are not held up.
    expect(fence.unsettled("ida")).toBe(false);
    expect(fence.size).toBe(1);
    // Both trades end all the same.
    expect(onPartner.lost.map((body) => body.username).sort()).toEqual(["ann", "ida"]);
  } finally {
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  }
});

// ------------------------------------------- no trade across a border while settling

/** A host and a partner's node with a fence each, as two nodes have. The host opens a trade for every answer. */
function apart() {
  const quiet = { ms: 200, drop: async () => {} };
  const hostFence = new TradeSettle(quiet);
  const partnerFence = new TradeSettle(quiet);
  const { a, b } = linkPair();
  const ca = new LinkCalls(200);
  const cb = new LinkCalls(200);
  ca.attach(a);
  cb.attach(b);
  const host = new TradeLink(ca, undefined, hostFence);
  const partner = new TradeLink(cb, 400, partnerFence);
  const answered: string[] = [];
  const updated: string[] = [];
  host.setHandlers(recorder({
    answer: async (body, from) => {
      answered.push(body.partner);
      host.setPartner(body.partner, from, body.stamp);
      return { ok: true, opened: true };
    },
    update: async (body) => {
      updated.push(body.op);
      return { ok: true };
    },
  }).handlers);
  partner.setHandlers(recorder().handlers);
  const done = () => {
    hostFence.reset();
    partnerFence.reset();
    host.reset();
    partner.reset();
    ca.detach();
    cb.detach();
  };
  return { host, partner, hostFence, partnerFence, quiet, answered, updated, done };
}
const answer = (accepted = true): TradeAnswer => ({ asker: "Alice", askerId: "1", authorization: "x", partner: "Bob", partnerId: "2", accepted });

test("a player who is settling does not open a trade across a border", async () => {
  const { partner, partnerFence, answered, done } = apart();
  try {
    await partnerFence.unsettle("bob", "test", "c");
    // Guard: the mark in sendAnswer. The host would swap from Bob's rows in the shared cache, past his mark here.
    expect(await partner.sendAnswer("a", answer())).toEqual({ ok: false, reason: TRADE_SETTLING });
    expect(answered).toEqual([]);
    expect(partner.hostOf("bob")).toBeNull();
    // Declining opens nothing, and is sent.
    await partner.sendAnswer("a", answer(false));
    expect(answered).toEqual(["Bob"]);
  } finally {
    done();
  }
});

test("the host opens no trade across a border while either player is settling there", async () => {
  const { partner, hostFence, quiet, answered, done } = apart();
  try {
    // Guard: the mark of the asker in the TP_ANSWER handler.
    await hostFence.unsettle("alice", "test", "c");
    expect(await partner.sendAnswer("a", answer())).toEqual({ ok: false, reason: TRADE_SETTLING });
    hostFence.reset(quiet);
    // Guard: the mark of the one who answered.
    await hostFence.unsettle("bob", "test", "c");
    expect(await partner.sendAnswer("a", answer())).toEqual({ ok: false, reason: TRADE_SETTLING });
    expect(answered).toEqual([]);
    expect(partner.hostOf("bob")).toBeNull();
    hostFence.reset(quiet);
    expect((await partner.sendAnswer("a", answer())).opened).toBe(true);
  } finally {
    done();
  }
});

test("a settling player's accept is not sent to the host", async () => {
  const { partner, partnerFence, updated, done } = apart();
  try {
    expect((await partner.sendAnswer("a", answer())).opened).toBe(true);
    await partnerFence.unsettle("bob", "test", "c");
    // Guard: the mark in sendUpdate.
    expect(await partner.sendUpdate("bob", "accept")).toEqual({ ok: false, reason: TRADE_SETTLING });
    expect(updated).toEqual([]);
    // Anything else is sent: it starts no swap.
    expect((await partner.sendUpdate("bob", "offer", { items: [] }))?.ok).toBe(true);
    expect(updated).toEqual(["offer"]);
  } finally {
    done();
  }
});

test("the host refuses an accept while either player of the trade is settling there", async () => {
  const { partner, hostFence, quiet, updated, done } = apart();
  try {
    expect((await partner.sendAnswer("a", answer())).opened).toBe(true);
    // Guard: the asker kept with the partner, and its mark in the TP_UPDATE handler.
    await hostFence.unsettle("alice", "test", "c");
    expect(await partner.sendUpdate("bob", "accept")).toEqual({ ok: false, reason: TRADE_SETTLING });
    hostFence.reset(quiet);
    // Guard: the mark of the one who accepts.
    await hostFence.unsettle("bob", "test", "c");
    expect(await partner.sendUpdate("bob", "accept")).toEqual({ ok: false, reason: TRADE_SETTLING });
    expect(updated).toEqual([]);
    expect((await partner.sendUpdate("bob", "offer", { items: [] }))?.ok).toBe(true);
    hostFence.reset(quiet);
    expect((await partner.sendUpdate("bob", "accept"))?.ok).toBe(true);
    expect(updated).toEqual(["offer", "accept"]);
  } finally {
    done();
  }
});
