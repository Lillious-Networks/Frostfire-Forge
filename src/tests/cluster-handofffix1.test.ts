import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HANDOFF_DWELL_MS, HandoffGiveUp, PlayerHandoff, holdPlayerLock, RETRY_AFTER_MS, TRANSIENT_RETRY_MS,
  type HandoffDeps, type PlayerSnapshot, type SwitchTicket,
} from "../cluster/handoff";
import { DWELL_MARGIN_PX, EDGE_MARGIN_PX, handoffBlocked, pickHandoffs, type HandoffChecks } from "../cluster/handoffwatch";
import { LinkCalls } from "../cluster/linkcalls";
import { MemoryStore } from "../cluster/memorystore";
import { PlayerLocks } from "../cluster/playerlock";
import { trackPacket, waitIdle } from "../cluster/inflight";
import { linkPair, settle } from "./cluster-fakelink";
import log from "../modules/logger";

// Handoff fix 1: the player keeps walking until the drain, refusals are said and retried by kind, a player is not sent
// straight back, and each handoff leaves one line of times on each node.

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
    snapshot: (p): PlayerSnapshot => ({ id: String(p.id), username: p.username, map: "main", x: p.x, y: 0, direction: "down", creatureIds: [], playerIds: [], state: {} }),
    ghostRecord: (p) => ({ id: String(p.id) }),
    ticket: (_p, target) => ticketFor(target),
    node: (target) => ({ nodeId: target, publicHost: "h", port: 1, wtPort: 2, useSSL: true }),
    release: (p) => { players.delete(String(p.id)); log.push(`release ${p.id}`); },
    save: async (p) => { log.push(`save ${p.id}`); },
    sendSwitch: async (p, _node, ticket) => { log.push(`switch ${p.id}`); p.ticket = ticket; },
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
  return { a, b, stop };
}

/** The info lines said while `run` runs, and the debug lines (a crossing under 100 ms says its summary at debug, f2minors M2). */
async function infoLines(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const info = spyOn(log, "info").mockImplementation(((message: string) => { lines.push(String(message)); }) as any);
  const debug = spyOn(log, "debug").mockImplementation(((message: string) => { lines.push(String(message)); }) as any);
  try {
    await run();
  } finally {
    info.mockRestore();
    debug.mockRestore();
  }
  return lines;
}

test("the player keeps walking until the drain: the ticket and the HANDOFF come first, the lock follows the drain, and the snapshot is taken after the last move", async () => {
  const events: string[] = [];
  const player: any = { id: "7", username: "ann", x: 10 };
  let handoffFlag = false;
  Object.defineProperty(player, "handoff", { get: () => handoffFlag, set: (v) => { handoffFlag = v; events.push(`handoff=${v}`); }, configurable: true });
  const { a, b, stop } = pair({
    ticket: (_p, target) => { events.push(`ticket(handoff=${handoffFlag})`); return ticketFor(target); },
    snapshot: (p): PlayerSnapshot => {
      events.push(`snapshot x=${p.x} handoff=${handoffFlag}`);
      return { id: String(p.id), username: p.username, map: "main", x: p.x, y: 0, direction: "down", creatureIds: [], playerIds: [], state: {} };
    },
    // The last move lands while the packets in flight finish: the drain is where the walk ends.
    drain: async (p) => { events.push(`drain parked=${(b.handoff as any).arrivals.size}`); p.x = 50; },
    save: async () => { events.push("save"); },
    sendSwitch: async () => { events.push("switch"); },
  });
  try {
    a.players.set("7", player);
    a.handoff.setLock(async () => { events.push(`lock(handoff=${handoffFlag})`); return async () => { events.push("unlock"); }; });
    expect(await a.handoff.handOff(player, "b")).toBe("switched");
    // Guard: the late drain. Without it handoff is true from the first line and nothing is parked before the drain.
    expect(events).toEqual([
      "ticket(handoff=false)",
      "snapshot x=10 handoff=false",
      // The look at the lock, while the player still walks (handoff fix 2, N1).
      "lock(handoff=false)",
      "unlock",
      "handoff=true",
      "drain parked=1",
      "lock(handoff=true)",
      "snapshot x=50 handoff=true",
      "save",
      "unlock",
      "switch",
    ]);
    await settle();
    expect(a.log).toEqual(["handOver player 7 b", "release 7", "adoptMirror player 7 b", "forward 7 ann b"]);
  } finally {
    stop();
  }
});

test("the new node is given the position the player had after the last move", async () => {
  const { a, b, stop } = pair({ drain: async (p) => { p.x = 50; } });
  try {
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    expect(await a.handoff.handOff(player, "b")).toBe("switched");
    await settle();
    expect(b.handoff.takeArrival(player.ticket.token, "ann", "7")?.snapshot.x).toBe(50);
  } finally {
    stop();
  }
});

test("a refused handoff never stops the player", async () => {
  const sets: unknown[] = [];
  const player: any = { id: "7", username: "ann", x: 10 };
  let flag = false;
  Object.defineProperty(player, "handoff", { get: () => flag, set: (v) => { flag = v; sets.push(v); }, configurable: true });
  let drains = 0;
  let undrains = 0;
  // B does not own the point: refused at the answer.
  const { a, stop } = pair({ drain: async () => { drains++; }, undrain: () => { undrains++; } }, { ownerAt: () => "c" });
  try {
    a.players.set("7", player);
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    // Guard: without the late drain the player is stopped at the start and restored at the end.
    expect(sets).toEqual([]);
    expect(drains).toBe(0);
    expect(undrains).toBe(0);
    // No ticket: the same.
    a.clock.now += RETRY_AFTER_MS + 1;
    a.deps.ticket = () => null;
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(sets).toEqual([]);
    expect(drains).toBe(0);
  } finally {
    stop();
  }
});

test("a refusal after the drain gives the player their movement back", async () => {
  const sets: unknown[] = [];
  const player: any = { id: "7", username: "ann", x: 10 };
  let flag = false;
  Object.defineProperty(player, "handoff", { get: () => flag, set: (v) => { flag = v; sets.push(v); }, configurable: true });
  let undrains = 0;
  const { a, stop } = pair({ undrain: () => { undrains++; }, recheck: () => "trading" });
  try {
    a.players.set("7", player);
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(sets).toEqual([true, false]);
    expect(undrains).toBe(1);
    expect(a.log).not.toContain("release 7");
    // A lock that is busy only after the drain (it was free at the look) is a refusal after it too.
    sets.length = 0;
    undrains = 0;
    a.clock.now += RETRY_AFTER_MS + 1;
    a.deps.recheck = undefined;
    let taken = 0;
    a.handoff.setLock(async () => (++taken === 1 ? async () => {} : null));
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(sets).toEqual([true, false]);
    expect(undrains).toBe(1);
    // A lock that is busy at the look never stops the player.
    sets.length = 0;
    undrains = 0;
    a.clock.now += RETRY_AFTER_MS + 1;
    a.handoff.setLock(async () => null);
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(sets).toEqual([]);
    expect(undrains).toBe(0);
  } finally {
    stop();
  }
});

test("a transient refusal is tried again after TRANSIENT_RETRY_MS, a hard one after RETRY_AFTER_MS", async () => {
  expect(TRANSIENT_RETRY_MS).toBe(300);
  expect(RETRY_AFTER_MS).toBe(5_000);
  const kinds: Array<[string, Partial<HandoffDeps>, Partial<HandoffDeps>, (n: Node) => void, number]> = [
    // transient
    ["lock busy", {}, {}, (n) => { n.handoff.setLock(async () => null); }, TRANSIENT_RETRY_MS],
    ["no node address", { node: () => null }, {}, () => {}, TRANSIENT_RETRY_MS],
    ["trade begun", { recheck: () => "trading" }, {}, () => {}, TRANSIENT_RETRY_MS],
    ["walked back out", { ownerAt: () => "a" }, {}, () => {}, TRANSIENT_RETRY_MS],
    // hard: a drain that gave up is the one refusal that already froze the player
    ["packets still running", { drain: async () => { throw new HandoffGiveUp("packets still running after 2000 ms"); } }, {}, () => {}, RETRY_AFTER_MS],
    ["target does not own the point", {}, { ownerAt: () => "c" }, () => {}, RETRY_AFTER_MS],
    ["no ticket", { ticket: () => null }, {}, () => {}, RETRY_AFTER_MS],
  ];
  for (const [name, overA, overB, setup, wait] of kinds) {
    const { a, stop } = pair(overA, overB);
    try {
      setup(a);
      const player: any = { id: "7", username: "ann", x: 10 };
      a.players.set("7", player);
      expect(`${name}: ${await a.handoff.handOff(player, "b")}`).toBe(`${name}: refused`);
      expect(`${name} at ${wait - 1}: ${(a.clock.now += wait - 1, a.handoff.coolingDown("ann"))}`).toBe(`${name} at ${wait - 1}: true`);
      expect(`${name} at ${wait}: ${(a.clock.now += 1, a.handoff.coolingDown("ann"))}`).toBe(`${name} at ${wait}: false`);
    } finally {
      stop();
    }
  }
});

test("a target that still holds an earlier try is a transient refusal", async () => {
  const { a, b, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    // An arrival for ann is parked on B already.
    (b.handoff as any).arrivals.set("old", { snapshot: { id: "7", username: "ann" }, from: "a", fullLoad: false, expiresAt: Infinity, committed: false, idClaimed: false, marks: [], takenAt: 0 });
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    a.clock.now += TRANSIENT_RETRY_MS;
    expect(a.handoff.coolingDown("ann")).toBe(false);
  } finally {
    stop();
  }
});

test("every refusal is said at info with the player, the target, the reason and the time, once per player and reason in 10 s", async () => {
  const { a, stop } = pair({}, { ownerAt: () => "c" });
  try {
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    const lines = await infoLines(async () => {
      await a.handoff.handOff(player, "b");
      a.clock.now += RETRY_AFTER_MS + 1;
      await a.handoff.handOff(player, "b");
      // Guard: the rate limit. The second refusal, 5 s later for the same reason, is not said.
      a.clock.now += RETRY_AFTER_MS + 1;
      await a.handoff.handOff(player, "b");
    });
    expect(lines.filter((line) => line.includes("not done"))).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[handoff\] ann a->b not done \(owner\) after \d+ ms: tried again in 5000 ms at the earliest$/);
  } finally {
    stop();
  }
});

test("a different reason for the same player is said as well", async () => {
  const { a, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    const lines = await infoLines(async () => {
      a.handoff.setLock(async () => null);
      await a.handoff.handOff(player, "b");
      a.handoff.setLock(null);
      a.clock.now += TRANSIENT_RETRY_MS + 1;
      a.deps.ticket = () => null;
      await a.handoff.handOff(player, "b");
    });
    expect(lines.filter((line) => line.includes("(locked)"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("(no ticket)"))).toHaveLength(1);
  } finally {
    stop();
  }
});

test("a drain that gives up is said with its count of packets, and tried again after the long wait", async () => {
  const { a, stop } = pair({ drain: async () => { throw new HandoffGiveUp("packets still running after 2000 ms (1 in flight)"); } });
  try {
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    const lines = await infoLines(async () => { await a.handoff.handOff(player, "b"); });
    expect(lines.some((line) => line.includes("packets still running after 2000 ms (1 in flight)") && line.includes("tried again in 5000 ms"))).toBe(true);
  } finally {
    stop();
  }
});

// The block border: "a" owns x below 4096, "b" the rest.
const owner = (_map: string, x: number): string | null => (x < 4096 ? "a" : "b");
const checks = (over: Partial<HandoffChecks> = {}): HandoffChecks => ({
  trading: () => false, dragged: () => false, pending: () => false, coolingDown: () => false, linkUp: () => true, settling: () => false, storeUp: () => true, ...over,
});
const at = (x: number) => ({ id: "7", username: "ann", location: { map: "main", position: { x, y: 500 } } });

test("a player handed here from a node is not handed straight back, unless well inside it", () => {
  expect(DWELL_MARGIN_PX).toBe(2 * EDGE_MARGIN_PX);
  // On b, the player stands 96 px inside a's block: past the 64 px margin, short of 128.
  const dwelling = checks({ dwellingFrom: (_u, peer) => peer === "a" });
  // Guard: the dwell. Without it the player goes straight back.
  expect(pickHandoffs([at(4000)], owner, "b", dwelling)).toEqual([]);
  // 200 px inside a's block: allowed.
  expect(pickHandoffs([at(3896)], owner, "b", dwelling)).toHaveLength(1);
  // Not dwelling (the 3 s are over, or they came from elsewhere): the margin of 64 px is enough.
  expect(pickHandoffs([at(4000)], owner, "b", checks())).toHaveLength(1);
  expect(pickHandoffs([at(4000)], owner, "b", checks({ dwellingFrom: (_u, peer) => peer === "c" }))).toHaveLength(1);
});

test("the dwell lasts HANDOFF_DWELL_MS from the arrival and only against the node they came from", async () => {
  expect(HANDOFF_DWELL_MS).toBe(3_000);
  const { a, b, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    expect(await a.handoff.handOff(player, "b")).toBe("switched");
    await settle();
    expect(b.handoff.dwellingFrom("ann", "a")).toBe(false);
    expect(b.handoff.takeArrival(player.ticket.token, "ann", "7")).not.toBeNull();
    expect(b.handoff.dwellingFrom("ann", "a")).toBe(true);
    expect(b.handoff.dwellingFrom("ann", "c")).toBe(false);
    b.clock.now += HANDOFF_DWELL_MS - 1;
    expect(b.handoff.dwellingFrom("ann", "a")).toBe(true);
    b.clock.now += 1;
    expect(b.handoff.dwellingFrom("ann", "a")).toBe(false);
  } finally {
    stop();
  }
});

test("the drain's own check skips the pending flag and the freeze, and nothing else", () => {
  const frozen = { username: "ann", handoff: true, casting: true };
  expect(handoffBlocked(frozen, "b", checks({ pending: () => true }))).toBe("pending");
  expect(handoffBlocked(frozen, "b", checks({ pending: () => true }), { draining: true })).toBe("casting");
  expect(handoffBlocked({ username: "ann", handoff: true }, "b", checks({ pending: () => true, trading: () => true }), { draining: true })).toBe("trading");
  expect(handoffBlocked({ username: "ann", handoff: true }, "b", checks({ pending: () => true }), { draining: true })).toBeNull();
});

test("a finished handoff says one line on the old node with the time of each step", async () => {
  const { a, stop } = pair({
    drain: async () => { a.clock.now += 3; },
    save: async () => { a.clock.now += 20; },
  });
  try {
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    a.handoff.setLock(async () => { a.clock.now += 2; return async () => { a.clock.now += 1; }; });
    const lines = await infoLines(async () => { expect(await a.handoff.handOff(player, "b")).toBe("switched"); });
    const said = lines.filter((line) => line.startsWith("[handoff] ann a->b total="));
    // Guard: once per handoff.
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^\[handoff\] ann a->b total=\d+ acked=\+\d+ drained=\+6 locked=\+2 released=\+\d+ saved=\+20 unlocked=\+1 switch_sent=\+\d+$/);
  } finally {
    stop();
  }
});

test("a refused handoff says no summary line", async () => {
  const { a, stop } = pair({}, { ownerAt: () => "c" });
  try {
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    const lines = await infoLines(async () => { await a.handoff.handOff(player, "b"); });
    expect(lines.filter((line) => line.includes("total="))).toEqual([]);
  } finally {
    stop();
  }
});

test("the new node says one line when the player first moves, with the time of each step", async () => {
  const { a, b, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    await a.handoff.handOff(player, "b");
    await settle();
    const token = player.ticket.token;
    const lines = await infoLines(async () => {
      expect(b.handoff.claimArrivalId(token)).toBe("7");
      b.clock.now += 2;
      b.handoff.landed(token, "auth_rx");
      b.clock.now += 30;
      b.handoff.landed(token, "worker_done");
      expect(b.handoff.takeArrival(token, "ann", "7")).not.toBeNull();
      b.clock.now += 4;
      b.handoff.landed(token, "rows_done");
      b.handoff.landed(token, "rows_done");
      b.clock.now += 1;
      b.handoff.landed(token, "cached");
      b.clock.now += 1;
      b.handoff.landed(token, "done_sent");
      b.clock.now += 20;
      b.handoff.firstMove(token);
      // Guard: once. A second move says nothing.
      b.handoff.firstMove(token);
    });
    const said = lines.filter((line) => line.startsWith("[handoff] ann a->b total="));
    expect(said).toEqual(["[handoff] ann a->b total=58 auth_rx=+2 worker_done=+30 rows_done=+4 cached=+1 done_sent=+1 first_move=+20"]);
  } finally {
    stop();
  }
});

test("an arrival who never moves is said once, without the last step, when the table is next swept", async () => {
  const { a, b, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    await a.handoff.handOff(player, "b");
    await settle();
    const token = player.ticket.token;
    b.handoff.claimArrivalId(token);
    b.handoff.takeArrival(token, "ann", "7");
    b.handoff.landed(token, "cached");
    b.clock.now += 40_000;
    const lines = await infoLines(async () => {
      // Another player's handoff to b sweeps the tables.
      (b.handoff as any).onHandoff({ snapshot: { id: "9", username: "bob", map: "main", x: 1, y: 0 }, token: "other" }, "a");
      (b.handoff as any).sweep(b.deps);
    });
    expect(lines.filter((line) => line.startsWith("[handoff] ann a->b total="))).toHaveLength(1);
    expect(lines.some((line) => line.includes("first_move"))).toBe(false);
  } finally {
    stop();
  }
});

test("a marks call for a ticket that is not a handoff's does nothing", () => {
  const handoff = new PlayerHandoff();
  expect(() => handoff.landed("nobody", "auth_rx")).not.toThrow();
  expect(() => handoff.firstMove("nobody")).not.toThrow();
});

// The receiver cannot be imported by a test: its wiring is read from its source.
const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8");
const receiver = read("socket", "receiver.ts");
const login = receiver.slice(receiver.indexOf("async function completeLogin("), receiver.indexOf("\nasync function ", receiver.indexOf("async function completeLogin(") + 10));

test("a handoff's login does not read the player's rows a second time; any other login does", () => {
  // Guard: the skip. A resume is an arrival that the old node saved before the SWITCH, so the auth worker's rows are current.
  expect(login).toContain("if (!resume) await refreshPlayer(playerData.username);");
  expect(login).not.toMatch(/\n\s*await refreshPlayer\(playerData\.username\);/);
  // resume is only an arrival taken from a handoff that the client keeps its world for: a plain login has none.
  expect(login).toContain("const resume = !!arrival?.resume && !!savedMap;");
  expect(login.indexOf("const resume =")).toBeLessThan(login.indexOf("if (!resume) await refreshPlayer("));
  // The settle mark is still read after it.
  expect(login.indexOf("reloadWhenSettled(playerData.username);")).toBeGreaterThan(login.indexOf("if (!resume) await refreshPlayer("));
});

test("the new node marks the steps of a login, and the first move says the line", () => {
  for (const step of ["worker_done", "rows_done", "cached", "done_sent"]) expect(login).toContain(`"${step}"`);
  expect(receiver).toContain("wt.data.handoffLanding = true;");
  expect(read("socket", "handlers", "session.ts")).toContain('playerHandoff.landed(String(wt.data?.ticketToken ?? ""), "auth_rx");');
  const movement = read("socket", "handlers", "movement.ts");
  expect(movement).toContain("playerHandoff.firstMove(String(wt.data.ticketToken ?? \"\"));");
  expect(movement.indexOf("handoffLanding")).toBeLessThan(movement.indexOf('if (direction === "abort") {'));
});

test("the node asks the handoff to recheck the player once drained, and the watch knows the dwell", () => {
  const server = read("socket", "server.ts");
  expect(server).toContain("recheck: handoffRecheck,");
  // The mover is dropped again after the packets in flight end: one of them may have registered it.
  const drain = server.slice(server.indexOf("drain: async (p, ms) => {"), server.indexOf("recheck: handoffRecheck,"));
  expect(drain.match(/gameLoop\.unregisterMovingPlayer\(p\.id\)/g)).toHaveLength(2);
  expect(receiver).toContain("dwellingFrom: (username, peer) => playerHandoff.dwellingFrom(username, peer),");
  expect(receiver).toContain("export function handoffRecheck(");
});

test("a batch of the player's own that is running when the handoff reaches the drain completes, and the handoff succeeds", async () => {
  const locks = new PlayerLocks(new MemoryStore(), "a");
  let batch: Promise<unknown> = Promise.resolve(null);
  const { a, stop } = pair({
    // The drain waits for the player's packets as the node's does. A packet of the player's is running when it begins.
    drain: async (p) => {
      batch = trackPacket("7", () => locks.withLocks(["ann"], async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return "done"; }));
      if (!(await waitIdle(String(p.id), 2_000))) throw new HandoffGiveUp("packets still running");
    },
  });
  try {
    a.handoff.setLock((username) => holdPlayerLock(locks, username));
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    // The packet takes the cluster lock for its batch, as services/batch.ts does.
    const started = Date.now();
    // Guard: the lock after the drain. With the lock held before it, the batch waits for the handoff, the drain waits for the batch, and both give up after 2 s.
    expect(await a.handoff.handOff(player, "b")).toBe("switched");
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(await batch).toBe("done");
  } finally {
    stop();
  }
});

test("a node that only receives arrivals does not let its tables grow", async () => {
  const { a, b, stop } = pair();
  try {
    const clock = b.clock;
    const lines = await infoLines(async () => {
      for (let i = 0; i < 5; i++) {
        const name = `p${i}`;
        const snapshot = { id: String(100 + i), username: name, map: "main", x: 1, y: 0, direction: "down", creatureIds: [], playerIds: [], state: {} };
        const token = `tok-${i}`;
        const answer = await a.calls.call<{ ok: boolean }>("b", "HANDOFF", { snapshot, token, fullLoad: false });
        expect(answer.ok && answer.answer.ok).toBe(true);
        a.calls.cast("b", "HANDOFF_COMMIT", { username: name, token, snapshot });
        await settle();
        expect(b.handoff.takeArrival(token, name, snapshot.id)).not.toBeNull();
        // Nobody moves; a minute passes before the next arrival.
        clock.now += 60_000;
      }
    });
    // Guard: the sweep on arrival. Without it all five stay in the tables, as b starts no handoff of its own.
    expect((b.handoff as any).landing.size).toBeLessThanOrEqual(1);
    expect((b.handoff as any).arrivedFrom.size).toBeLessThanOrEqual(1);
    expect(lines.filter((line) => line.startsWith("[handoff] p") && line.includes("total="))).toHaveLength(4);
  } finally {
    stop();
  }
});
