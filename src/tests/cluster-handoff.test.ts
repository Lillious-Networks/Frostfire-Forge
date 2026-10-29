import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARRIVAL_TTL_MS, HandoffGiveUp, MAX_ARRIVALS, MAX_SHOWN_IDS, MAX_STATE_BYTES, MAX_TEXT, MAX_TOKEN, PlayerHandoff, RECENT_MS, RETRY_AFTER_MS,
  type HandoffDeps, type PlayerSnapshot, type SwitchTicket,
} from "../cluster/handoff";
import { LinkCalls } from "../cluster/linkcalls";
import { onLinksAttached, runLinkHooks } from "../cluster/linkhooks";
import { packetManager } from "../socket/packet_manager";
import { linkPair, settle } from "./cluster-fakelink";
import log from "../modules/logger";

type Node = { handoff: PlayerHandoff; calls: LinkCalls; players: Map<string, any>; log: string[]; clock: { now: number }; deps: HandoffDeps };

function ticketFor(target: string): SwitchTicket {
  return { token: `switch-${Math.random().toString(16).slice(2)}`, timestamp: 1, expiresAt: 2, signature: "sig", origin: "o", account: "ann", nodeId: target };
}

function node(name: string, link: any, over: Partial<HandoffDeps> = {}): Node {
  const calls = new LinkCalls(1_000);
  calls.attach(link);
  const players = new Map<string, any>();
  const log: string[] = [];
  const clock = { now: 1_000_000 };
  const deps: HandoffDeps = {
    calls,
    ghosts: {
      handOver: (kind, id, to) => { log.push(`handOver ${kind} ${id} ${to}`); },
      adoptMirror: (kind, record, from) => { log.push(`adoptMirror ${kind} ${record.id} ${from}`); return true; },
    },
    self: name,
    ownerAt: () => name === "a" ? "b" : name,
    now: () => clock.now,
    player: (id) => players.get(id) ?? null,
    playerByUsername: (username) => [...players.values()].find((p) => p.username === username) ?? null,
    drain: async () => { log.push("drain"); },
    snapshot: (p): PlayerSnapshot => ({ id: String(p.id), username: p.username, map: "main", x: p.x, y: 0, direction: "down", creatureIds: [], playerIds: [], state: { hp: p.hp } }),
    ghostRecord: (p) => ({ id: String(p.id) }),
    ticket: (_p, target) => ticketFor(target),
    node: (target) => ({ nodeId: target, publicHost: "h", port: 1, wtPort: 2, useSSL: true }),
    release: (p) => { players.delete(String(p.id)); log.push(`release ${p.id}`); },
    save: async (p) => { log.push(`save ${p.id}`); },
    sendSwitch: async (p, _node, ticket, resume) => { log.push(`switch ${p.id} ${resume}`); p.ticket = ticket; },
    forward: (id, username, to) => { log.push(`forward ${id} ${username} ${to}`); },
    ...over,
  };
  const handoff = new PlayerHandoff();
  handoff.start(deps);
  return { handoff, calls, players, log, clock, deps };
}

function pair(overA: Partial<HandoffDeps> = {}, overB: Partial<HandoffDeps> = {}) {
  const { a: la, b: lb } = linkPair();
  const a = node("a", la, overA);
  const b = node("b", lb, overB);
  const stop = () => { a.handoff.stop(); b.handoff.stop(); a.calls.detach(); b.calls.detach(); };
  return { a, b, la, lb, stop };
}

const annSnapshot = (): PlayerSnapshot => ({ id: "7", username: "ann", map: "main", x: 1, y: 0, direction: "down", creatureIds: [], playerIds: [], state: {} });

/** Records the casts a node sends, and still sends them. */
function recordCasts(n: Node): Array<{ name: string; body: any }> {
  const casts: Array<{ name: string; body: any }> = [];
  const original = n.calls.cast.bind(n.calls);
  (n.deps.calls as any).cast = (peer: string, name: string, body: unknown) => {
    casts.push({ name, body });
    return original(peer, name, body);
  };
  return casts;
}

/** Whether `b` has no arrival parked for ann any more: a fresh ticket for her is taken. */
async function annFreeOn(a: Node): Promise<boolean> {
  const outcome = await a.calls.call<{ ok: boolean }>("b", "HANDOFF", { snapshot: annSnapshot(), token: "switch-probe", fullLoad: false });
  return outcome.ok && outcome.answer.ok;
}

test("a handoff hands the mirrors over, releases the player, keeps a mirror, forwards, then saves and switches", async () => {
  const { a, b, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    expect(await a.handoff.handOff(player, "b")).toBe("switched");
    // Guard: the order. A mirror handed over after the release would be despawned by the next scan in between.
    expect(a.log).toEqual(["drain", "handOver player 7 b", "release 7", "adoptMirror player 7 b", "forward 7 ann b", "save 7", "switch 7 true"]);
    expect(player.handoff).toBe(true);
    await settle();
    expect(b.handoff.claimArrivalId(player.ticket.token)).toBe("7");
    const arrival = b.handoff.takeArrival(player.ticket.token, "ann", "7");
    expect(arrival?.resume).toBe(true);
    expect(arrival?.snapshot.state).toEqual({ hp: 50 });
    expect(a.handoff.departedRecently("ann")).toBe(true);
    expect(b.handoff.arrivedRecently("ann")).toBe(true);
    expect(a.handoff.pending("ann")).toBe(false);
  } finally {
    stop();
  }
});

test("the commit's snapshot replaces the one sent with the call", async () => {
  const { a, b, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    let calls = 0;
    a.deps.snapshot = (p) => ({ id: "7", username: "ann", map: "main", x: p.x, y: 0, direction: "down", creatureIds: [], playerIds: [], state: { hp: p.hp, n: ++calls } });
    await a.handoff.handOff(player, "b");
    await settle();
    expect(b.handoff.takeArrival(player.ticket.token, "ann", "7")?.snapshot.state).toEqual({ hp: 50, n: 2 });
  } finally {
    stop();
  }
});

test("the new node refuses a player who is live there", async () => {
  const { a, b, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    b.players.set("9", { id: "9", username: "ann" });
    // Guard: the "here" check. Without it the player would be live on both nodes.
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(a.players.get("7")).toBe(player);
    expect(player).not.toHaveProperty("handoff", true);
    expect(a.log).not.toContain("release 7");
  } finally {
    stop();
  }
});

test("the new node refuses a second ticket for a player already arriving", async () => {
  const { a, stop } = pair();
  try {
    const snapshot = annSnapshot();
    expect(await a.calls.call("b", "HANDOFF", { snapshot, token: "switch-1", fullLoad: false })).toEqual({ ok: true, answer: { ok: true } });
    // The same call again (same token) is a yes.
    expect(await a.calls.call("b", "HANDOFF", { snapshot, token: "switch-1", fullLoad: false })).toEqual({ ok: true, answer: { ok: true } });
    // Guard: one arrival per player. Without it two connections could each take one.
    expect(await a.calls.call("b", "HANDOFF", { snapshot, token: "switch-2", fullLoad: false })).toEqual({ ok: true, answer: { ok: false, reason: "arriving" } });
  } finally {
    stop();
  }
});

test("a parked token sent again by another node, or for another player, is refused", async () => {
  const { a, b, stop } = pair();
  try {
    await a.calls.call("b", "HANDOFF", { snapshot: annSnapshot(), token: "switch-1", fullLoad: false });
    // Guard: the sender check on a repeated token. Another node cannot ride on a's yes.
    expect((b.handoff as any).onHandoff({ snapshot: annSnapshot(), token: "switch-1", fullLoad: false }, "c")).toEqual({ ok: false, reason: "token" });
    const bob = { ...annSnapshot(), id: "8", username: "bob" };
    expect(await a.calls.call("b", "HANDOFF", { snapshot: bob, token: "switch-1", fullLoad: false })).toEqual({ ok: true, answer: { ok: false, reason: "token" } });
  } finally {
    stop();
  }
});

test("the new node refuses a point it does not own", async () => {
  const { a, stop } = pair({}, { ownerAt: () => "c" });
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    // Guard: the owner check on B.
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(a.players.get("7")).toBe(player);
  } finally {
    stop();
  }
});

test("a refused handoff is cast as aborted, and not tried again for a while", async () => {
  const { a, stop } = pair({}, { ownerAt: () => "c" });
  try {
    const casts = recordCasts(a);
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    let token = "";
    a.deps.ticket = (_p, target) => { const t = ticketFor(target); token = t.token; return t; };
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(token).not.toBe("");
    // Guard: the abort cast on a refusal.
    expect(casts).toEqual([{ name: "HANDOFF_ABORT", body: { username: "ann", token } }]);
    // Guard: retryAt.
    expect(a.handoff.coolingDown("ann")).toBe(true);
    expect(a.handoff.pending("ann")).toBe(false);
    a.clock.now += RETRY_AFTER_MS + 1;
    expect(a.handoff.coolingDown("ann")).toBe(false);
  } finally {
    stop();
  }
});

test("a handoff whose answer is lost removes the arrival parked on the new node", async () => {
  const { a, lb, stop } = pair({ ackMs: 50 });
  try {
    const player: any = { id: "7", username: "ann", x: 1, hp: 50 };
    a.players.set("7", player);
    // B parks the arrival, but its yes never reaches A: A times out and refuses.
    lb.blackhole = true;
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    lb.blackhole = false;
    await settle();
    expect(a.players.get("7")).toBe(player);
    // Guard: the abort reached B, so the player is not stuck as "arriving" there.
    expect(await annFreeOn(a)).toBe(true);
  } finally {
    stop();
  }
});

test("an abort removes the parked arrival", async () => {
  const { a, b, stop } = pair();
  try {
    const snapshot = annSnapshot();
    await a.calls.call("b", "HANDOFF", { snapshot, token: "switch-1", fullLoad: false });
    a.calls.cast("b", "HANDOFF_ABORT", { username: "ann", token: "switch-1" });
    await settle();
    expect(b.handoff.claimArrivalId("switch-1")).toBe(null);
    // A new ticket for the same player is taken now.
    expect(await a.calls.call("b", "HANDOFF", { snapshot, token: "switch-2", fullLoad: false })).toEqual({ ok: true, answer: { ok: true } });
  } finally {
    stop();
  }
});

test("an abort after the commit does not remove the arrival", async () => {
  const { a, b, stop } = pair();
  try {
    const snapshot = annSnapshot();
    await a.calls.call("b", "HANDOFF", { snapshot, token: "switch-1", fullLoad: false });
    a.calls.cast("b", "HANDOFF_COMMIT", { username: "ann", token: "switch-1", snapshot });
    a.calls.cast("b", "HANDOFF_ABORT", { username: "ann", token: "switch-1" });
    await settle();
    // Guard: `!arrival.committed` in onAbort. A has released the player; the arrival is all that is left of them.
    expect(b.handoff.claimArrivalId("switch-1")).toBe("7");
  } finally {
    stop();
  }
});

test("a player who left during the drain is not handed off, and the arrival is aborted", async () => {
  const { a, b, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    a.deps.drain = async () => { a.players.delete("7"); };
    let token = "";
    a.deps.ticket = (_p, target) => { const t = ticketFor(target); token = t.token; return t; };
    // Guard: the stillHere check after the drain (which now follows the answer). Without it a player who already left is released and saved again.
    expect(await a.handoff.handOff(player, "b")).toBe("gone");
    expect(a.log).not.toContain("release 7");
    expect(a.log).not.toContain("save 7");
    await settle();
    expect(b.handoff.claimArrivalId(token)).toBe(null);
    // Guard: the abort in that branch. Without it ann stays "arriving" on B for the arrival's lifetime.
    expect(await annFreeOn(a)).toBe(true);
  } finally {
    stop();
  }
});

test("a warp's handoff drains first: a player who left during that drain gets no ticket", async () => {
  const { a, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    a.deps.drain = async () => { a.players.delete("7"); };
    let tickets = 0;
    a.deps.ticket = (_p, target) => { tickets++; return ticketFor(target); };
    // Guard: fullLoad drains before the lock and the ticket, as a warp always did.
    expect(await a.handoff.handOff(player, "b", { fullLoad: true })).toBe("gone");
    expect(tickets).toBe(0);
  } finally {
    stop();
  }
});

test("a player who left during the call is not released, and the arrival is aborted", async () => {
  const { a, b, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    let token = "";
    a.deps.ticket = (_p, target) => { const t = ticketFor(target); token = t.token; return t; };
    const originalCall = a.calls.call.bind(a.calls);
    (a.deps.calls as any).call = async (...args: any[]) => {
      const outcome = await (originalCall as any)(...args);
      a.players.delete("7");
      return outcome;
    };
    // Guard: the stillHere check after the call. Without it a disconnected player is handed off too.
    expect(await a.handoff.handOff(player, "b")).toBe("gone");
    expect(a.log).not.toContain("release 7");
    expect(a.log).not.toContain("handOver player 7 b");
    expect(token).not.toBe("");
    await settle();
    expect(b.handoff.claimArrivalId(token)).toBe(null);
    // Guard: the abort in that branch. Without it ann stays "arriving" on B for the arrival's lifetime.
    expect(await annFreeOn(a)).toBe(true);
  } finally {
    stop();
  }
});

test("a second handoff of the same player while one runs is refused", async () => {
  let release: () => void = () => {};
  const { a, stop } = pair({ drain: () => new Promise<void>((resolve) => { release = resolve; }) });
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    const first = a.handoff.handOff(player, "b");
    // Guard: `leaving`. Without it two handoffs of one player run at once.
    expect(await a.handoff.handOff(player, "b")).toBe("busy");
    expect(a.handoff.pending("ann")).toBe(true);
    // The drain follows the answer: the first run reaches it a moment later.
    await settle();
    release();
    expect(await first).toBe("switched");
  } finally {
    stop();
  }
});

test("a failure before the release keeps the player here and aborts the arrival", async () => {
  const { a, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    a.deps.ghostRecord = () => { throw new Error("no record"); };
    // Guard: the try around the step before the release.
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(a.players.get("7")).toBe(player);
    expect(player.handoff).toBe(false);
    expect(a.log).not.toContain("release 7");
    await settle();
    expect(await annFreeOn(a)).toBe(true);
  } finally {
    stop();
  }
});

test("a release that throws with the player still here gives the handoff up", async () => {
  const { a, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    a.deps.release = () => { throw new Error("busy"); };
    // Guard: the still-here check on a failed release. Without it the player would be live on both nodes.
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(a.players.get("7")).toBe(player);
    expect(a.log).not.toContain("save 7");
    await settle();
    expect(await annFreeOn(a)).toBe(true);
  } finally {
    stop();
  }
});

test("a release that throws after removing the player still commits", async () => {
  const { a, b, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    a.deps.release = (p) => { a.players.delete(String(p.id)); throw new Error("late"); };
    // Guard: the release failure goes on when the player is gone. Without it the player is on neither node and no SWITCH is sent.
    expect(await a.handoff.handOff(player, "b")).toBe("switched");
    await settle();
    expect(b.handoff.claimArrivalId(player.ticket.token)).toBe("7");
  } finally {
    stop();
  }
});

test("a mirror or forwarding failure after the release does not stop the commit", async () => {
  for (const broken of ["ghosts", "forward"] as const) {
    const { a, b, stop } = pair();
    try {
      const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
      a.players.set("7", player);
      if (broken === "ghosts") a.deps.ghosts = { handOver: () => {}, adoptMirror: () => { throw new Error("no mirror"); } };
      else a.deps.forward = () => { throw new Error("no table"); };
      // Guard: the try around each step after the release.
      expect(await a.handoff.handOff(player, "b")).toBe("switched");
      expect(a.log).toContain("switch 7 true");
      await settle();
      expect(b.handoff.claimArrivalId(player.ticket.token)).toBe("7");
    } finally {
      stop();
    }
  }
});

test("an arrival is taken once, by the right player, only after the commit", async () => {
  const { a, b, stop } = pair();
  try {
    const snapshot = annSnapshot();
    await a.calls.call("b", "HANDOFF", { snapshot, token: "switch-1", fullLoad: false });
    // Guard: committed. Without the commit (A did not finish) the login is a normal one.
    expect(b.handoff.claimArrivalId("switch-1")).toBe(null);
    expect(b.handoff.takeArrival("switch-1", "ann", "7")).toBe(null);
    a.calls.cast("b", "HANDOFF_COMMIT", { username: "ann", token: "switch-1", snapshot });
    await settle();
    // Guard: the username check. Another account's connection cannot take ann's arrival.
    expect(b.handoff.takeArrival("switch-1", "bob", "7")).toBe(null);
    expect(b.handoff.claimArrivalId("switch-1")).toBe("7");
    // Guard: the id is given once.
    expect(b.handoff.claimArrivalId("switch-1")).toBe(null);
    expect(b.handoff.takeArrival("switch-1", "ann", "7")?.resume).toBe(true);
    // Guard: taken once.
    expect(b.handoff.takeArrival("switch-1", "ann", "7")).toBe(null);
  } finally {
    stop();
  }
});

test("an arrival says when its commit came, on the new node's clock: the resumed walk makes up the time from there", async () => {
  const { a, b, stop } = pair();
  try {
    const snapshot = annSnapshot();
    await a.calls.call("b", "HANDOFF", { snapshot, token: "switch-1", fullLoad: false });
    b.clock.now = 1_000_500;
    a.calls.cast("b", "HANDOFF_COMMIT", { username: "ann", token: "switch-1", snapshot });
    await settle();
    b.clock.now = 1_000_570;
    expect(b.handoff.takeArrival("switch-1", "ann", "7")?.committedAt).toBe(1_000_500);
  } finally {
    stop();
  }
});

test("an arrival's id is not given while a player with that id is live on the new node", async () => {
  const { a, b, stop } = pair();
  try {
    const snapshot = annSnapshot();
    await a.calls.call("b", "HANDOFF", { snapshot, token: "switch-1", fullLoad: false });
    a.calls.cast("b", "HANDOFF_COMMIT", { username: "ann", token: "switch-1", snapshot });
    await settle();
    b.players.set("7", { id: "7", username: "zed" });
    // Guard: the live-id check in claimArrivalId. Two connections would share one id.
    expect(b.handoff.claimArrivalId("switch-1")).toBe(null);
    b.players.delete("7");
    expect(b.handoff.claimArrivalId("switch-1")).toBe("7");
  } finally {
    stop();
  }
});

test("an arrival with another id, or for a full load, does not resume", async () => {
  const { a, b, stop } = pair();
  try {
    const snapshot = annSnapshot();
    for (const [token, id, fullLoad] of [["switch-1", "7", false], ["switch-2", "8", true]] as const) {
      const s = { ...snapshot, id, username: token };
      expect(await a.calls.call("b", "HANDOFF", { snapshot: s, token, fullLoad })).toEqual({ ok: true, answer: { ok: true } });
      a.calls.cast("b", "HANDOFF_COMMIT", { username: token, token, snapshot: s });
    }
    await settle();
    expect(b.handoff.takeArrival("switch-1", "switch-1", "8")?.resume).toBe(false);
    expect(b.handoff.takeArrival("switch-2", "switch-2", "8")?.resume).toBe(false);
  } finally {
    stop();
  }
});

test("a full-load handoff sends a SWITCH that does not resume", async () => {
  const { a, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    expect(await a.handoff.handOff(player, "b", { fullLoad: true })).toBe("switched");
    expect(a.log).toContain("switch 7 false");
  } finally {
    stop();
  }
});

test("a handoff refused as too big is logged at warn, once per player, not on every retry", async () => {
  // Ownership M3: a snapshot over the link's frame limit can never be handed off; at debug only, nobody would know.
  const { a, stop } = pair();
  const warned: string[] = [];
  const warn = spyOn(log, "warn").mockImplementation((message: any) => { warned.push(String(message)); });
  const debug = spyOn(log, "debug").mockImplementation(() => {});
  try {
    const big = "x".repeat(1024 * 1024 + 1);
    a.deps.snapshot = (p): PlayerSnapshot => ({ id: String(p.id), username: p.username, map: "main", x: p.x, y: 0, direction: "down", creatureIds: [], playerIds: [], state: { big } });
    const ann: any = { id: "7", username: "ann", x: 10, hp: 50 };
    const bob: any = { id: "8", username: "bob", x: 10, hp: 50 };
    a.players.set("7", ann);
    a.players.set("8", bob);
    expect(await a.handoff.handOff(ann, "b")).toBe("refused");
    // Guard: "too-big" is loud.
    expect(warned.filter((line) => line.includes("ann") && line.includes("too-big"))).toHaveLength(1);
    a.clock.now += RETRY_AFTER_MS + 1;
    expect(await a.handoff.handOff(ann, "b")).toBe("refused");
    // Guard: once per player. The retry every RETRY_AFTER_MS says it at debug.
    expect(warned.filter((line) => line.includes("ann") && line.includes("too-big"))).toHaveLength(1);
    expect(await a.handoff.handOff(bob, "b")).toBe("refused");
    expect(warned.filter((line) => line.includes("bob") && line.includes("too-big"))).toHaveLength(1);
  } finally {
    warn.mockRestore();
    debug.mockRestore();
    stop();
  }
});

test("an arrival expires", async () => {
  const { a, b, stop } = pair();
  try {
    const snapshot = annSnapshot();
    await a.calls.call("b", "HANDOFF", { snapshot, token: "switch-1", fullLoad: false });
    a.calls.cast("b", "HANDOFF_COMMIT", { username: "ann", token: "switch-1", snapshot });
    await settle();
    b.clock.now += ARRIVAL_TTL_MS + 1;
    expect(b.handoff.takeArrival("switch-1", "ann", "7")).toBe(null);
  } finally {
    stop();
  }
});

test("a commit or abort from a node other than the one that parked the arrival is ignored", async () => {
  const { a, b, stop } = pair();
  try {
    const snapshot = annSnapshot();
    await a.calls.call("b", "HANDOFF", { snapshot, token: "switch-1", fullLoad: false });
    // b casting to itself is not possible over the pair; call the handler path with another sender instead.
    (b.handoff as any).onCommit({ username: "ann", token: "switch-1", snapshot }, "c");
    expect(b.handoff.claimArrivalId("switch-1")).toBe(null);
    // Guard: the sender check in onAbort. The arrival survives an abort from c, and a's commit still lands.
    (b.handoff as any).onAbort({ username: "ann", token: "switch-1" }, "c");
    a.calls.cast("b", "HANDOFF_COMMIT", { username: "ann", token: "switch-1", snapshot });
    await settle();
    expect(b.handoff.claimArrivalId("switch-1")).toBe("7");
  } finally {
    stop();
  }
});

test("a handoff to this node itself, or with no ticket, is refused", async () => {
  const { a, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    // Guard: the self check. Refused before anything starts: no drain, no cooldown.
    expect(await a.handoff.handOff(player, "a")).toBe("refused");
    expect(a.log).toEqual([]);
    expect(a.handoff.coolingDown("ann")).toBe(false);
    a.deps.ticket = () => null;
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(a.handoff.coolingDown("ann")).toBe(true);
    expect(a.players.get("7")).toBe(player);
    // Never drained: the refusal came before the player was stopped.
    // Never drained, so the flag was never set (not even to false).
    expect(player.handoff).toBeUndefined();
    expect(a.log).not.toContain("drain");
  } finally {
    stop();
  }
});

test("a failure before the answer is a refusal with a cooldown, and the player stays", async () => {
  const boom = () => { throw new Error("boom"); };
  const cases: Array<[string, Partial<HandoffDeps>]> = [
    ["drain", { drain: async () => boom() }],
    ["ticket", { ticket: boom }],
    ["node", { node: boom }],
    ["snapshot", { snapshot: boom }],
    ["call", {}],
  ];
  for (const [name, over] of cases) {
    const { a, stop } = pair(over);
    try {
      if (name === "call") (a.deps.calls as any).call = boom;
      const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
      a.players.set("7", player);
      // Guard: the try around steps 1-2. Without it handOff rejects and sets no cooldown.
      expect(await a.handoff.handOff(player, "b")).toBe("refused");
      expect(a.handoff.coolingDown("ann")).toBe(true);
      expect(a.handoff.pending("ann")).toBe(false);
      expect(a.players.get("7")).toBe(player);
      // Only the failing drain stopped the player (and put the flag back); the others failed before it.
      expect(player.handoff).toBe(name === "drain" ? false : undefined);
      expect(a.log).not.toContain("release 7");
    } finally {
      stop();
    }
  }
});

test("an abort that cannot be sent still ends in a refusal with a cooldown", async () => {
  const { a, stop } = pair({}, { ownerAt: () => "c" });
  try {
    const original = a.calls.cast.bind(a.calls);
    (a.deps.calls as any).cast = (peer: string, name: string, body: unknown) => {
      if (name === "HANDOFF_ABORT") throw new Error("cannot encode");
      return original(peer, name, body);
    };
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    // Guard: the try around the abort cast.
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(a.handoff.coolingDown("ann")).toBe(true);
    expect(player.handoff).toBeUndefined();
  } finally {
    stop();
  }
});

test("a malformed HANDOFF is refused", () => {
  const { b, stop } = pair();
  try {
    const good = annSnapshot();
    const cyclic: any = {};
    cyclic.self = cyclic;
    const bodies: Array<[string, any]> = [
      ["no body", undefined],
      ["no snapshot", { token: "switch-1" }],
      ["snapshot not an object", { snapshot: "ann", token: "switch-1" }],
      ["token missing", { snapshot: good }],
      ["token not a string", { snapshot: good, token: 5 }],
      ["token empty", { snapshot: good, token: "" }],
      ["token too long", { snapshot: good, token: "t".repeat(MAX_TOKEN + 1) }],
      ["id not a string", { snapshot: { ...good, id: 7 }, token: "switch-1" }],
      ["id empty", { snapshot: { ...good, id: "" }, token: "switch-1" }],
      ["id not numeric", { snapshot: { ...good, id: "7a" }, token: "switch-1" }],
      ["id not decimal digits", { snapshot: { ...good, id: "1e3" }, token: "switch-1" }],
      ["id hex", { snapshot: { ...good, id: "0x10" }, token: "switch-1" }],
      ["id not a safe integer", { snapshot: { ...good, id: "9999999999999999" }, token: "switch-1" }],
      ["username not a string", { snapshot: { ...good, username: 5 }, token: "switch-1" }],
      ["username empty", { snapshot: { ...good, username: "" }, token: "switch-1" }],
      ["username too long", { snapshot: { ...good, username: "u".repeat(MAX_TEXT + 1) }, token: "switch-1" }],
      ["map missing", { snapshot: { ...good, map: undefined }, token: "switch-1" }],
      ["map too long", { snapshot: { ...good, map: "m".repeat(MAX_TEXT + 1) }, token: "switch-1" }],
      ["x not a number", { snapshot: { ...good, x: "1" }, token: "switch-1" }],
      ["y missing", { snapshot: { ...good, y: undefined }, token: "switch-1" }],
      ["direction not a string", { snapshot: { ...good, direction: 3 }, token: "switch-1" }],
      ["direction too long", { snapshot: { ...good, direction: "d".repeat(MAX_TEXT + 1) }, token: "switch-1" }],
      ["creatureIds not an array", { snapshot: { ...good, creatureIds: "1,2" }, token: "switch-1" }],
      ["creatureIds too many", { snapshot: { ...good, creatureIds: new Array(MAX_SHOWN_IDS + 1).fill(1) }, token: "switch-1" }],
      ["playerIds not an array", { snapshot: { ...good, playerIds: {} }, token: "switch-1" }],
      ["playerIds too many", { snapshot: { ...good, playerIds: new Array(MAX_SHOWN_IDS + 1).fill("1") }, token: "switch-1" }],
      ["state an array", { snapshot: { ...good, state: [1] }, token: "switch-1" }],
      ["state not an object", { snapshot: { ...good, state: "x" }, token: "switch-1" }],
      ["state too large", { snapshot: { ...good, state: { big: "x".repeat(MAX_STATE_BYTES) } }, token: "switch-1" }],
      ["state not JSON", { snapshot: { ...good, state: cyclic }, token: "switch-1" }],
    ];
    for (const [why, body] of bodies) {
      // Guard: one validation check per case.
      expect([why, (b.handoff as any).onHandoff(body, "a")]).toEqual([why, { ok: false, reason: "malformed" }]);
    }
    // The same snapshot, well formed, is taken.
    expect((b.handoff as any).onHandoff({ snapshot: good, token: "switch-1" }, "a")).toEqual({ ok: true });
  } finally {
    stop();
  }
});

test("a snapshot keeps only well-formed shown ids", () => {
  const { b, stop } = pair();
  try {
    const snapshot = { ...annSnapshot(), creatureIds: [1, "2", 1.5, null, 3], playerIds: ["9", 10, {}, "", null] };
    expect((b.handoff as any).onHandoff({ snapshot, token: "switch-1" }, "a")).toEqual({ ok: true });
    const parked = (b.handoff as any).arrivals.get("switch-1").snapshot;
    // Guard: the element filters. An object would arrive as "[object Object]", a string as a creature id.
    expect(parked.creatureIds).toEqual([1, 3]);
    expect(parked.playerIds).toEqual(["9", "10"]);
  } finally {
    stop();
  }
});

test("the new node parks at most MAX_ARRIVALS arrivals", () => {
  const { b, stop } = pair();
  try {
    for (let i = 0; i < MAX_ARRIVALS; i++) {
      const reply = (b.handoff as any).onHandoff({ snapshot: { ...annSnapshot(), id: String(100 + i), username: `u${i}` }, token: `t${i}` }, "a");
      if (!reply.ok) throw new Error(`arrival ${i} refused: ${reply.reason}`);
    }
    // Guard: the cap on parked arrivals.
    expect((b.handoff as any).onHandoff({ snapshot: annSnapshot(), token: "t-last" }, "a")).toEqual({ ok: false, reason: "full" });
  } finally {
    stop();
  }
});

test("the id halves of the here and arriving checks refuse on their own", async () => {
  const { a, b, stop } = pair();
  try {
    const bob = { ...annSnapshot(), username: "bob" };
    // Guard: the id half of "here". Another account with the same live id on B.
    b.players.set("7", { id: "7", username: "zed" });
    expect(await a.calls.call("b", "HANDOFF", { snapshot: annSnapshot(), token: "switch-1", fullLoad: false })).toEqual({ ok: true, answer: { ok: false, reason: "here" } });
    b.players.delete("7");
    // Guard: the id half of "arriving". Two arrivals would claim the same id.
    expect(await a.calls.call("b", "HANDOFF", { snapshot: annSnapshot(), token: "switch-1", fullLoad: false })).toEqual({ ok: true, answer: { ok: true } });
    expect(await a.calls.call("b", "HANDOFF", { snapshot: bob, token: "switch-2", fullLoad: false })).toEqual({ ok: true, answer: { ok: false, reason: "arriving" } });
  } finally {
    stop();
  }
});

test("a commit carrying another player's snapshot keeps the arrival's own", async () => {
  const { a, b, stop } = pair();
  try {
    // Another id.
    await a.calls.call("b", "HANDOFF", { snapshot: annSnapshot(), token: "switch-1", fullLoad: false });
    (b.handoff as any).onCommit({ username: "ann", token: "switch-1", snapshot: { ...annSnapshot(), id: "8", state: { n: 1 } } }, "a");
    // Guard: the id check on the commit's snapshot. Without it B gives out id 8.
    expect(b.handoff.claimArrivalId("switch-1")).toBe("7");
    expect(b.handoff.takeArrival("switch-1", "ann", "7")?.snapshot.state).toEqual({});
    // Another username.
    await a.calls.call("b", "HANDOFF", { snapshot: annSnapshot(), token: "switch-2", fullLoad: false });
    (b.handoff as any).onCommit({ username: "ann", token: "switch-2", snapshot: { ...annSnapshot(), username: "bob", state: { n: 2 } } }, "a");
    // Guard: the username check on the commit's snapshot. Without it ann's arrival turns into bob's.
    const arrival = b.handoff.takeArrival("switch-2", "ann", "7");
    expect(arrival?.snapshot.username).toBe("ann");
    expect(arrival?.snapshot.state).toEqual({});
  } finally {
    stop();
  }
});

test("a commit's position is taken only where the new node owns the block", async () => {
  const { a, b, stop } = pair({}, { ownerAt: (map) => map === "main" ? "b" : "c" });
  try {
    await a.calls.call("b", "HANDOFF", { snapshot: annSnapshot(), token: "switch-1", fullLoad: false });
    (b.handoff as any).onCommit({ token: "switch-1", snapshot: { ...annSnapshot(), map: "elsewhere", x: 50, y: 60, state: { hp: 3 } } }, "a");
    // Guard: B's owner check on the commit. The player arrives at the point B checked, with the final state.
    const kept = b.handoff.takeArrival("switch-1", "ann", "7")?.snapshot;
    expect([kept?.map, kept?.x, kept?.y]).toEqual(["main", 1, 0]);
    expect(kept?.state).toEqual({ hp: 3 });
    await a.calls.call("b", "HANDOFF", { snapshot: annSnapshot(), token: "switch-2", fullLoad: false });
    (b.handoff as any).onCommit({ token: "switch-2", snapshot: { ...annSnapshot(), x: 5 } }, "a");
    expect(b.handoff.takeArrival("switch-2", "ann", "7")?.snapshot.x).toBe(5);
  } finally {
    stop();
  }
});

test("a commit that cannot be sent still sends the client on, without resume", async () => {
  for (const failure of ["throws", "not sent"] as const) {
    const { a, stop } = pair();
    try {
      const original = a.calls.cast.bind(a.calls);
      (a.deps.calls as any).cast = (peer: string, name: string, body: unknown) => {
        if (name !== "HANDOFF_COMMIT") return original(peer, name, body);
        if (failure === "throws") throw new Error("cannot encode");
        return false;
      };
      const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
      a.players.set("7", player);
      // Guard: the try around the commit (throws), and resume only with a sent commit (not sent).
      expect(await a.handoff.handOff(player, "b")).toBe("switched");
      expect(a.log.slice(-2)).toEqual(["save 7", "switch 7 false"]);
      expect(player.handoff).toBe(true);
      expect(a.handoff.departedRecently("ann")).toBe(true);
    } finally {
      stop();
    }
  }
});

test("a handoff still running after a stop keeps to its own tables, and idle waits for it", async () => {
  // The HANDOFF call is the first thing a run waits for here: each run's turn is let in by the test. The second run
  // is answered with a yes of its own, so it ends at the "player still here" check.
  const turns: Array<() => void> = [];
  const { a, stop } = pair();
  const original = a.calls.call.bind(a.calls);
  (a.deps.calls as any).call = (...args: any[]) => new Promise((resolve) => {
    const first = turns.length === 0;
    turns.push(() => resolve(first ? (original as any)(...args) : { ok: true, answer: { ok: true } }));
  });
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    const first = a.handoff.handOff(player, "b");
    a.handoff.stop();
    a.handoff.start(a.deps);
    const second = a.handoff.handOff(player, "b");
    expect(a.handoff.pending("ann")).toBe(true);
    let idle = false;
    const waiting = a.handoff.idle().then(() => { idle = true; });
    turns[0]!();
    expect(await first).toBe("switched");
    // Guard: the session captured at entry. Without it the first run's end clears the second run's entry.
    expect(a.handoff.pending("ann")).toBe(true);
    await settle();
    // Guard: `running`. idle waits for the second run too.
    expect(idle).toBe(false);
    turns[1]!();
    expect(await second).toBe("gone");
    await waiting;
    expect(idle).toBe(true);
  } finally {
    stop();
  }
});

test("cooldowns and the recently tables are swept", async () => {
  const { a, b, stop } = pair();
  try {
    const ann: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", ann);
    expect(await a.handoff.handOff(ann, "b")).toBe("switched");
    await settle();
    expect(b.handoff.takeArrival(ann.ticket.token, "ann", "7")).not.toBe(null);
    // A refusal for bob leaves a cooldown.
    const bob: any = { id: "8", username: "bob", x: 10, hp: 50 };
    a.players.set("8", bob);
    a.deps.ticket = () => null;
    expect(await a.handoff.handOff(bob, "b")).toBe("refused");
    const tables = (h: PlayerHandoff) => h as any;
    expect(tables(a.handoff).session.retryAt.has("bob")).toBe(true);
    expect(tables(a.handoff).departedAt.has("ann")).toBe(true);
    expect(tables(b.handoff).arrivedAt.has("ann")).toBe(true);
    a.clock.now += Math.max(RECENT_MS, RETRY_AFTER_MS) + 10_000;
    b.clock.now += RECENT_MS + 10_000;
    // The next handoff on A, and the next HANDOFF on B, sweep.
    const cid: any = { id: "9", username: "cid", x: 10, hp: 50 };
    a.players.set("9", cid);
    await a.handoff.handOff(cid, "b");
    expect(await a.calls.call("b", "HANDOFF", { snapshot: { ...annSnapshot(), id: "10", username: "dan" }, token: "switch-x", fullLoad: false })).toEqual({ ok: true, answer: { ok: true } });
    // Guard: each sweep loop.
    expect(tables(a.handoff).session.retryAt.has("bob")).toBe(false);
    expect(tables(a.handoff).departedAt.has("ann")).toBe(false);
    expect(tables(b.handoff).arrivedAt.has("ann")).toBe(false);
  } finally {
    stop();
  }
});

test("link hooks run on attach and are undone at detach", () => {
  const seen: string[] = [];
  const off = onLinksAttached((ctx) => { seen.push(`up ${ctx.self}`); return () => seen.push(`down ${ctx.self}`); });
  const offBroken = onLinksAttached(() => { throw new Error("broken hook"); });
  try {
    const undo = runLinkHooks({ calls: new LinkCalls(), links: {} as any, self: "a", ownerAt: () => null });
    expect(seen).toEqual(["up a"]);
    undo();
    expect(seen).toEqual(["up a", "down a"]);
  } finally {
    off();
    offBroken();
  }
  // A removed hook does not run again.
  runLinkHooks({ calls: new LinkCalls(), links: {} as any, self: "b", ownerAt: () => null })();
  expect(seen).toEqual(["up a", "down a"]);
});

test("the SWITCH packet carries the handoff flags, and HANDOFF_DONE exists", () => {
  const source = readFileSync(join(import.meta.dir, "..", "socket", "packet_manager.ts"), "utf8");
  expect(source).toContain("switchNode: (node: { nodeId: string; publicHost: string; port: number; wtPort: number; useSSL: boolean }, ticket: NodeTicket, handoff?: { resume: boolean }) => {");
  expect(source).toContain("...(handoff ? { handoff: true, resume: handoff.resume } : {})");
  expect(source).toContain('type: "HANDOFF_DONE"');
  const decode = (bytes: any) => JSON.parse(new TextDecoder().decode(bytes));
  const address = { nodeId: "b", publicHost: "h", port: 1, wtPort: 2, useSSL: true };
  const ticket = ticketFor("b");
  expect(decode(packetManager.switchNode(address, ticket)[0]).data).toEqual({ ...address, ticket });
  expect(decode(packetManager.switchNode(address, ticket, { resume: false })[0]).data).toEqual({ ...address, ticket, handoff: true, resume: false });
  const done = { map: "main", x: 1, y: 2, direction: "up" };
  expect(decode(packetManager.handoffDone(done)[0])).toEqual({ type: "HANDOFF_DONE", data: done });
});

test("a drained player kept here gets their movement back; one switched or gone does not", async () => {
  const undrained: Array<{ id: string; handoff: unknown }> = [];
  const undrain = (p: any) => { undrained.push({ id: String(p.id), handoff: p.handoff }); };
  const boom = () => { throw new Error("boom"); };
  const cases: Array<[string, Partial<HandoffDeps>, Partial<HandoffDeps>, string, number]> = [
    // Guard M1: a refusal after the drain restores the movement.
    // The target's refusal and a missing address come before the drain: the player never stopped, so nothing is restored.
    ["refused by the target", { undrain }, { ownerAt: () => "c" }, "refused", 0],
    ["no node address", { undrain, node: () => null }, {}, "refused", 0],
    ["a trade begun during the answer", { undrain, recheck: () => "trading" }, {}, "refused", 1],
    ["walked out of the target's block", { undrain, ownerAt: (_m: string, x: number) => (x > 100 ? "b" : "a") }, {}, "refused", 1],
    ["drain gives up", { undrain, drain: async () => { throw new HandoffGiveUp("busy"); } }, {}, "refused", 1],
    ["release throws, player still here", { undrain, release: boom }, {}, "refused", 1],
    ["switched", { undrain }, {}, "switched", 0],
    // Guard: a switched player is never restored here, even where the lookup still finds them.
    ["switched, still found here", { undrain, release: () => {} }, {}, "switched", 0],
  ];
  for (const [name, overA, overB, result, calls] of cases) {
    undrained.length = 0;
    const { a, stop } = pair(overA, overB);
    try {
      const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
      a.players.set("7", player);
      expect(`${name}: ${await a.handoff.handOff(player, "b")}`).toBe(`${name}: ${result}`);
      expect(`${name}: ${undrained.length}`).toBe(`${name}: ${calls}`);
      // Restored after the handoff flag is cleared, so the packets that follow are handled.
      if (calls) expect(undrained[0]).toEqual({ id: "7", handoff: false });
    } finally {
      stop();
    }
  }
});

test("a player who left during the drain, or who was never drained, gets no movement restore", async () => {
  let undrained = 0;
  const undrain = () => { undrained++; };
  const { a, stop } = pair({ undrain });
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    a.deps.drain = async () => { a.players.delete("7"); };
    expect(await a.handoff.handOff(player, "b")).toBe("gone");
    // A handoff to itself is refused before any drain.
    a.players.set("7", player);
    expect(await a.handoff.handOff(player, "a")).toBe("refused");
    expect(undrained).toBe(0);
  } finally {
    stop();
  }
});

test("a restore that throws is logged and the handoff still ends as refused", async () => {
  const { a, stop } = pair({ undrain: () => { throw new Error("no wt"); }, release: () => { throw new Error("no release"); } });
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
    a.players.set("7", player);
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("movement not restored"))).toBe(true);
  } finally {
    warn.mockRestore();
    stop();
  }
});

test("a drain that gives up (HandoffGiveUp) is not logged as an error; another failure is", async () => {
  const error = spyOn(log, "error").mockImplementation(() => {});
  try {
    for (const [thrown, loud] of [[new HandoffGiveUp("packets still running"), false], [new Error("broken"), true]] as const) {
      error.mockClear();
      const { a, stop } = pair({ drain: async () => { throw thrown; } });
      try {
        const player: any = { id: "7", username: "ann", x: 10, hp: 50 };
        a.players.set("7", player);
        expect(await a.handoff.handOff(player, "b")).toBe("refused");
        expect(a.handoff.coolingDown("ann")).toBe(true);
        expect(error.mock.calls.some((c) => String(c[0]).includes("failed before the answer"))).toBe(loud);
      } finally {
        stop();
      }
    }
  } finally {
    error.mockRestore();
  }
});
