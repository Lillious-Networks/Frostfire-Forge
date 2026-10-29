import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";
import { receiverSource } from "./receiver-source";

// Handoff fix 2: a seamless crossing.
//   - the old node tells the walking player's client which node is next (HANDOFF_PREPARE, no ticket), once, only while
//     the player walks toward the border, never with CLUSTER=false; the client opens that node's session early;
//   - an idle unauthenticated session holds no player and is closed by the node's timeout, which is long enough for the
//     pre-opened session to wait for the SWITCH;
//   - the snapshot carries the walk and the arrival goes on walking;
//   - a busy player lock refuses before the player is stopped;
//   - the client walks its own player during the gap (core/handoffwalk.ts) and eases the error out.

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { PlayerHandoff, PREPARE_MS, RETRY_AFTER_MS, TRANSIENT_RETRY_MS } = await import("../cluster/handoff");
const { HANDOFF_PREPARE_PX, prepareTarget, prepareWalkers } = await import("../cluster/handoffwatch");
const { LinkCalls } = await import("../cluster/linkcalls");
const { linkPair, settle } = await import("./cluster-fakelink");
const { WALK_DIRECTIONS, handoffStateOf, arrivalLimits, walkOf } = await import("../socket/arrival");
const { packetManager } = await import("../socket/packet_manager");
const { sendHandoffPrepare } = await import("../socket/handoffprepare");
const { FrameDecoder } = await import("../socket/framing");
const { TransportConnection, PREOPEN_AUTH_TIMEOUT_MS, authTimeoutFor, startAuthTimer } = await import("../socket/transport");
const { default: log } = await import("../modules/logger");
type HandoffDeps = import("../cluster/handoff").HandoffDeps;

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

const dec = new TextDecoder();
const decode = (frames: any[]) => JSON.parse(dec.decode(frames[0]));

// A world of 4096 px blocks: x below 4096 is a's, from there b's.
const ownerAt = (_map: string, x: number) => (x >= 4096 ? "b" : "a");
const checks: any = {
  trading: () => false, dragged: () => false, pending: () => false, coolingDown: () => false, linkUp: () => true, settling: () => false, storeUp: () => true,
};

function ticketFor(target: string) {
  return { token: `switch-${Math.random().toString(16).slice(2)}`, timestamp: 1, expiresAt: 2, signature: "sig", origin: "o", account: "ann", nodeId: target };
}

function node(name: string, link: any, over: Partial<HandoffDeps> = {}) {
  const calls = new LinkCalls(1_000);
  calls.attach(link);
  const players = new Map<string, any>();
  const log: string[] = [];
  const clock = { now: 1_000_000 };
  const prepares: Array<{ player: any; node: any }> = [];
  const deps: HandoffDeps = {
    calls,
    ghosts: { handOver: () => {}, adoptMirror: () => true },
    self: name,
    ownerAt: () => (name === "a" ? "b" : name),
    now: () => clock.now,
    player: (id) => players.get(id) ?? null,
    playerByUsername: (username) => [...players.values()].find((p) => p.username === username) ?? null,
    drain: async () => { log.push("drain"); },
    snapshot: (p): any => ({ id: String(p.id), username: p.username, map: "main", x: p.x ?? 0, y: 0, direction: "down", creatureIds: [], playerIds: [], state: { walk: p.walk ?? null, big: "x".repeat(100) } }),
    ghostRecord: (p) => ({ id: String(p.id) }),
    ticket: (_p, target) => ticketFor(target),
    node: (target) => ({ nodeId: target, publicHost: "h", port: 1, wtPort: 2, useSSL: true }),
    release: (p) => { players.delete(String(p.id)); log.push(`release ${p.id}`); },
    save: async () => { log.push("save"); },
    sendSwitch: async () => { log.push("switch"); },
    forward: () => {},
    prepare: (player, address) => { prepares.push({ player, node: address }); },
    ...over,
  };
  const handoff = new PlayerHandoff();
  handoff.start(deps);
  return { handoff, calls, players, log, clock, deps, prepares };
}

function pair(overA: Partial<HandoffDeps> = {}, overB: Partial<HandoffDeps> = {}) {
  const { a: la, b: lb } = linkPair();
  const a = node("a", la, overA);
  const b = node("b", lb, overB);
  const stop = () => { a.handoff.stop(); b.handoff.stop(); a.calls.detach(); b.calls.detach(); };
  return { a, b, stop };
}

// ---- the border ahead

test("a player walking toward a border to another node is found within the prepare distance, and only then", () => {
  expect(HANDOFF_PREPARE_PX).toBe(384);
  // 300 px short of b's block, walking right: the border is 300 px ahead.
  expect(prepareTarget("main.json", 3796, 100, "right", ownerAt, "a")).toBe("b");
  // 400 px short: farther than the prepare distance.
  expect(prepareTarget("main", 3696, 100, "right", ownerAt, "a")).toBeNull();
  // Walking away from it, up, or standing: not.
  expect(prepareTarget("main", 3796, 100, "left", ownerAt, "a")).toBeNull();
  expect(prepareTarget("main", 3796, 100, "up", ownerAt, "a")).toBeNull();
  expect(prepareTarget("main", 3796, 100, null, ownerAt, "a")).toBeNull();
  // A diagonal covers the same distance: 384 px is 272 on each axis, so 300 px short on x is not near enough on a diagonal.
  expect(prepareTarget("main", 3840, 100, "downright", ownerAt, "a")).toBe("b");
  expect(prepareTarget("main", 3796, 100, "downright", ownerAt, "a")).toBeNull();
  // A player past the border, walking on into b's block, keeps b (the handoff has not run yet); walking back, or up
  // along the border into nothing of b's, they do not.
  expect(prepareTarget("main", 4120, 100, "right", ownerAt, "a")).toBe("b");
  expect(prepareTarget("main", 4120, 100, "left", ownerAt, "a")).toBeNull();
  expect(prepareTarget("main", 4120, 100, null, ownerAt, "a")).toBeNull();
  // Toward a different node: not b's any more.
  expect(prepareTarget("main", 4120, 100, "right", (_m, x) => (x >= 4200 ? "c" : x >= 4096 ? "b" : "a"), "a")).toBeNull();
  // A point nobody owns is not a node.
  expect(prepareTarget("main", 3796, 100, "right", (_m, x) => (x >= 4096 ? null : "a"), "a")).toBeNull();
});

function walker(over: any = {}): any {
  return { id: "7", username: "ann", moving: true, _movementState: { targetDirection: "right" }, location: { map: "main", position: { x: 3796, y: 100, direction: "right" } }, ...over };
}

test("the watch prepares a walker once as they approach, and not when they walk away or stand", () => {
  const { a, stop } = pair();
  try {
    const player = walker();
    const hand = a.handoff;
    prepareWalkers([player], [], ownerAt, "a", checks, walkOf, hand);
    expect(a.prepares).toHaveLength(1);
    expect(a.prepares[0].node).toEqual({ nodeId: "b", publicHost: "h", port: 1, wtPort: 2, useSSL: true });
    // Guard: once. The watch runs every 250 ms and the player is in range for seconds.
    prepareWalkers([player], [], ownerAt, "a", checks, walkOf, hand);
    prepareWalkers([player], [], ownerAt, "a", checks, walkOf, hand);
    expect(a.prepares).toHaveLength(1);
    // Standing: nothing, and the prepare is not withdrawn (the client's own timer ends it).
    prepareWalkers([walker({ moving: false })], [], ownerAt, "a", checks, walkOf, hand);
    expect(a.prepares).toHaveLength(1);
    // Walking away: the prepare is withdrawn, once.
    const away = walker({ _movementState: { targetDirection: "left" }, location: { map: "main", position: { x: 3796, y: 100, direction: "left" } } });
    prepareWalkers([away], [], ownerAt, "a", checks, walkOf, hand);
    prepareWalkers([away], [], ownerAt, "a", checks, walkOf, hand);
    expect(a.prepares.map((p) => p.node === null)).toEqual([false, true]);
    // A walker who was never prepared and walks away sends nothing.
    const other = walker({ id: "8", username: "bob", _movementState: { targetDirection: "left" } });
    prepareWalkers([other], [], ownerAt, "a", checks, walkOf, hand);
    expect(a.prepares).toHaveLength(2);
  } finally {
    stop();
  }
});

test("a walk across the border keeps one prepare from 384 px before it to 64 px past it, and turning back withdraws it", () => {
  const { a, stop } = pair();
  try {
    const at = (x: number, dir = "right") => walker({ _movementState: { targetDirection: dir }, location: { map: "main", position: { x, y: 100, direction: dir } } });
    const hand = a.handoff;
    // b's block starts at 4096; the handoff would start at 4160.
    for (let x = 3712; x <= 4159; x += 16) prepareWalkers([at(x)], [], ownerAt, "a", checks, walkOf, hand);
    expect(a.prepares).toHaveLength(1);
    expect(a.prepares[0].node).not.toBeNull();
    // Turning back while still past the border: withdrawn.
    prepareWalkers([at(4120, "left")], [], ownerAt, "a", checks, walkOf, hand);
    expect(a.prepares.map((p) => p.node === null)).toEqual([false, true]);
  } finally {
    stop();
  }
});

test("the watch does not prepare a player who is picked this tick, blocked, or a mirror", () => {
  const { a, stop } = pair();
  try {
    const picked = walker();
    prepareWalkers([picked], [{ player: picked, target: "b" }], ownerAt, "a", checks, walkOf, a.handoff);
    prepareWalkers([walker({ id: "8", username: "bob" })], [], ownerAt, "a", { ...checks, trading: () => true }, walkOf, a.handoff);
    prepareWalkers([walker({ id: "9", username: "cat", remote: true })], [], ownerAt, "a", checks, walkOf, a.handoff);
    expect(a.prepares).toHaveLength(0);
  } finally {
    stop();
  }
});

test("a prepare is sent again after PREPARE_MS, and at once for another node; the node's address is all it names", () => {
  const { a, stop } = pair();
  try {
    const player = walker();
    expect(a.handoff.prepare(player, "b")).toBe(true);
    expect(a.handoff.prepare(player, "b")).toBe(false);
    a.clock.now += PREPARE_MS - 1;
    expect(a.handoff.prepare(player, "b")).toBe(false);
    a.clock.now += 1;
    expect(a.handoff.prepare(player, "b")).toBe(true);
    expect(a.handoff.prepare(player, "c")).toBe(true);
    expect(a.prepares).toHaveLength(3);
    // The prepare carries no ticket: the address of the node and nothing else.
    for (const p of a.prepares) expect(Object.keys(p.node).sort()).toEqual(["nodeId", "port", "publicHost", "useSSL", "wtPort"]);
  } finally {
    stop();
  }
});

test("with no prepare dep (CLUSTER=false never starts a handoff) or a stopped handoff, nothing is sent", () => {
  const { a, stop } = pair({ prepare: undefined });
  try {
    expect(a.handoff.prepare(walker(), "b")).toBe(false);
  } finally {
    stop();
  }
  const idle = new PlayerHandoff();
  expect(idle.prepare(walker(), "b")).toBe(false);
  idle.unprepare(walker());
  // The only caller is the watch, which is attached by the cluster link hook only.
  const receiver = receiverSource();
  const hook = receiver.slice(receiver.indexOf("onLinksAttached((ctx) => {\n  handoffCtx = ctx;"));
  expect(hook.slice(0, hook.indexOf("}, HANDOFF_WATCH_MS);"))).toContain("prepareWalkers(players, picks, ctx.ownerAt, ctx.self, handoffChecks, walkOf, playerHandoff);");
  expect(receiver.match(/prepareWalkers\(/g)).toHaveLength(1);
  expect(receiver.match(/playerHandoff\.prepare\(/g)).toBeNull();
});

test("a handoff refused for good withdraws the prepare, one that clears in a moment keeps it, a finished one forgets it", async () => {
  // Hard refusal: the target says the player is not to come.
  {
    const { a, stop } = pair({}, { ownerAt: () => "c" });
    try {
      const player: any = { id: "7", username: "ann" };
      a.players.set("7", player);
      expect(a.handoff.prepare(player, "b")).toBe(true);
      expect(await a.handoff.handOff(player, "b")).toBe("refused");
      expect(a.prepares.map((p) => p.node === null)).toEqual([false, true]);
      // Not prepared again inside PREPARE_MS.
      expect(a.handoff.prepare(player, "b")).toBe(false);
    } finally {
      stop();
    }
  }
  // Transient refusal: the session stays open for the next try.
  {
    const { a, stop } = pair();
    try {
      const player: any = { id: "7", username: "ann" };
      a.players.set("7", player);
      a.handoff.setLock(async () => null);
      expect(a.handoff.prepare(player, "b")).toBe(true);
      expect(await a.handoff.handOff(player, "b")).toBe("refused");
      expect(a.prepares.map((p) => p.node === null)).toEqual([false]);
      a.handoff.setLock(null);
      a.clock.now += TRANSIENT_RETRY_MS + 1;
      expect(await a.handoff.handOff(player, "b")).toBe("switched");
      // Handed off: the entry is gone; a player who comes back is prepared again.
      expect((a.handoff as any).prepared.size).toBe(0);
    } finally {
      stop();
    }
  }
  expect(RETRY_AFTER_MS).toBeGreaterThan(TRANSIENT_RETRY_MS);
});

test("the prepare packet names the node and carries no ticket; its withdrawal carries nothing", () => {
  const prepare = decode(packetManager.handoffPrepare({ nodeId: "b", publicHost: "h", port: 1, wtPort: 2, useSSL: true, ticket: { token: "t" } } as any));
  expect(prepare).toEqual({ type: "HANDOFF_PREPARE", data: { nodeId: "b", publicHost: "h", port: 1, wtPort: 2, useSSL: true } });
  expect(JSON.stringify(prepare)).not.toContain("ticket");
  expect(decode(packetManager.handoffAbort())).toEqual({ type: "HANDOFF_ABORT", data: null });
});

test("the prepare and the withdrawal reach the client as frames it can read, through the node's own send", async () => {
  // A real connection over a recording stream: what it writes is what the client's decoder reads.
  const writes: Uint8Array[] = [];
  const connection = new TransportConnection({ queuedBytes: 0n, close: () => {} } as any, 1200, 1024 * 1024);
  connection.attachStream({ getWriter: () => ({ write: (chunk: Uint8Array) => { writes.push(chunk); return Promise.resolve(); } }) });
  connection.readyState = 1;
  const read = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const decoder = new FrameDecoder(1024 * 1024);
    const frames = writes.splice(0).flatMap((w) => decoder.push(w));
    return frames.map((f) => JSON.parse(dec.decode(f)));
  };
  const address = { nodeId: "b", publicHost: "h", port: 1, wtPort: 2, useSSL: true };
  // Guard: one frame at a time. Sent as the packet manager's list, the frame is a single 0 byte and the client drops it.
  sendHandoffPrepare(connection as any, address);
  expect(await read()).toEqual([{ type: "HANDOFF_PREPARE", data: address }]);
  sendHandoffPrepare(connection as any, null);
  expect(await read()).toEqual([{ type: "HANDOFF_ABORT", data: null }]);
  // A closed connection gets nothing.
  connection.readyState = 3;
  sendHandoffPrepare(connection as any, address);
  sendHandoffPrepare(null, address);
  expect(await read()).toEqual([]);
  // The node's dep is this function.
  const server = readFileSync(join(import.meta.dir, "..", "socket", "server.ts"), "utf8");
  expect(server).toContain("prepare: (p, node) => sendHandoffPrepare(p.wt, node),");
});

// ---- an idle session

test("an unauthenticated session holds no player and is closed by the node's timeout; a cluster node waits long enough for a pre-opened one", async () => {
  expect(PREOPEN_AUTH_TIMEOUT_MS).toBeGreaterThan(10_000);
  // A single node keeps its configured timeout; a cluster node (allocateId given) waits at least the pre-open window.
  expect(authTimeoutFor({ authTimeoutMs: 10_000 })).toBe(10_000);
  expect(authTimeoutFor({ authTimeoutMs: 10_000, allocateId: () => "1" })).toBe(PREOPEN_AUTH_TIMEOUT_MS);
  expect(authTimeoutFor({ authTimeoutMs: 60_000, allocateId: () => "1" })).toBe(60_000);

  const closes: Array<{ code: number; reason: string }> = [];
  const session: any = { id: "s1", close: (arg: any) => { closes.push(arg); } };
  const idle = new TransportConnection(session, 1200, 1024 * 1024);
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  spies.push(warn);
  // Holds no player: no id, not logged in, nothing in the datagram path (it drops frames of a connection without an id).
  expect(idle.data.id).toBeUndefined();
  expect(idle.loggedIn).toBe(false);
  const timer = startAuthTimer(idle, 15);
  await new Promise((resolve) => setTimeout(resolve, 60));
  clearTimeout(timer);
  // Guard: the timer. Without it the idle session sits on a slot for good.
  expect(closes).toHaveLength(1);
  expect(idle.isOpen()).toBe(false);

  // A session that authenticated in time is left alone.
  const closes2: any[] = [];
  const live = new TransportConnection({ id: "s2", close: (arg: any) => { closes2.push(arg); } } as any, 1200, 1024 * 1024);
  live.data = { id: "42" };
  const timer2 = startAuthTimer(live, 15);
  await new Promise((resolve) => setTimeout(resolve, 60));
  clearTimeout(timer2);
  expect(closes2).toHaveLength(0);
  // The transport uses both, in place of the bare option.
  const transport = readFileSync(join(import.meta.dir, "..", "socket", "transport.ts"), "utf8");
  expect(transport).toContain("const authTimer = startAuthTimer(connection, authTimeoutFor(options));");
});

// ---- the walk

test("the snapshot's walk is the direction of the mover, and only while the player moves", () => {
  expect(walkOf({ moving: true, _movementState: { targetDirection: "upleft" }, location: { position: { direction: "up" } } })).toBe("upleft");
  // Facing differs from the walk while casting: the walk is the mover's.
  expect(walkOf({ moving: true, _movementState: { targetDirection: "right" }, location: { position: { direction: "down" } } })).toBe("right");
  // Without a movement state the facing is the walk.
  expect(walkOf({ moving: true, location: { position: { direction: "DOWN" } } })).toBe("down");
  expect(walkOf({ moving: false, _movementState: { targetDirection: "right" }, location: { position: { direction: "right" } } })).toBeNull();
  expect(walkOf({ moving: true, isDead: true, location: { position: { direction: "right" } } })).toBeNull();
  expect(walkOf({ moving: true, location: { position: { direction: "sideways" } } })).toBeNull();
  expect(walkOf({})).toBeNull();
  expect([...WALK_DIRECTIONS].sort()).toEqual(["down", "downleft", "downright", "left", "right", "up", "upleft", "upright"]);
  // The node's snapshot state includes it.
  const server = readFileSync(join(import.meta.dir, "..", "socket", "server.ts"), "utf8");
  expect(server).toContain("walk: walkOf(p),");
});

test("the arrival reads the walk, drops one that is not a direction, and a dead player does not walk", () => {
  const state = (over: any) => handoffStateOf({ walk: "right", ...over }, arrivalLimits([]));
  expect(state({}).walk).toBe("right");
  expect(state({ walk: "sideways" }).walk).toBeNull();
  expect(state({ walk: 3 }).walk).toBeNull();
  expect(state({ walk: undefined }).walk).toBeNull();
  expect(state({ deadState: 1 }).walk).toBeNull();
  expect(handoffStateOf(null, arrivalLimits([])).walk).toBeNull();
});

test("a resumed arrival goes on walking: the MOVEXY handler is run for its direction, counted in flight; a standing one is not", async () => {
  const receiver = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8");
  // Wiring: after HANDOFF_DONE, resume only, from the arrival's own state.
  const done = receiver.indexOf("packetManager.handoffDone({");
  const wiring = receiver.indexOf("resumedWalk = resumeArrivalWalk(wt, arrivalState.walk);", done);
  expect(wiring).toBeGreaterThan(done);
  expect(wiring).toBeLessThan(receiver.indexOf("sendPacket(wt, packetManager.loadMap(mapMetadata));", done));

  // The function itself, cut out of the receiver and run with stubs.
  const from = receiver.indexOf("async function resumeArrivalWalk(");
  const code = receiver.slice(from, receiver.indexOf("\n}\n", from) + 3);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const compile = new Function(`"use strict";\n${transpiler.transformSync(`function make({ handlerRoutes, playerCache, trackPacket, log }: any) {\n${code}\nreturn resumeArrivalWalk;\n}`)}\nreturn make;`)();
  const handled: any[] = [];
  const tracked: string[] = [];
  const me: any = { id: "7", username: "ann" };
  const make = () => compile({
    handlerRoutes: { route: (type: string) => (type === "MOVEXY" ? { handle: async (ctx: any) => { handled.push(ctx); } } : undefined) },
    playerCache: { get: (id: string) => (id === "7" ? me : undefined) },
    trackPacket: async (id: string, work: () => Promise<unknown>) => { tracked.push(id); return work(); },
    log,
  });
  await make()({ data: { id: "7" }, readyState: 1 }, "right");
  // Guard: the handler call. Without it the arrival stands until the client resends its move.
  expect(handled).toHaveLength(1);
  expect(handled[0].type).toBe("MOVEXY");
  expect(handled[0].data).toBe("right");
  expect(handled[0].currentPlayer).toBe(me);
  expect(tracked).toEqual(["7"]);
  // A connection that closed meanwhile walks nobody.
  await make()({ data: { id: "7" }, readyState: 3 }, "right");
  expect(handled).toHaveLength(1);
});

// ---- the lock look, N1; the landing table, N2

test("a busy player lock refuses before the player is stopped, and a free one is let go before the drain", async () => {
  const { a, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann", x: 10 };
    a.players.set("7", player);
    let taken = 0;
    a.handoff.setLock(async () => { taken++; return null; });
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    // Guard: the look. Without it the drain stops the walker first and the refusal gives them back.
    expect(a.log).not.toContain("drain");
    expect(player.handoff).toBeUndefined();
    expect(taken).toBe(1);
    a.clock.now += TRANSIENT_RETRY_MS + 1;

    const events: string[] = [];
    a.handoff.setLock(async () => { events.push("lock"); return async () => { events.push("unlock"); }; });
    a.deps.drain = async () => { events.push("drain"); };
    expect(await a.handoff.handOff(player, "b")).toBe("switched");
    expect(events.slice(0, 3)).toEqual(["lock", "unlock", "drain"]);
  } finally {
    stop();
  }
});

test("what an arrival keeps until its first move is the identity and the marks, not the snapshot's state", async () => {
  const { a, b, stop } = pair();
  try {
    const snapshot = { id: "100", username: "dan", map: "main", x: 1, y: 0, direction: "down", creatureIds: [1, 2, 3], playerIds: ["9"], state: { walk: "right", blob: "y".repeat(5000) } };
    const answer = await a.calls.call<{ ok: boolean }>("b", "HANDOFF", { snapshot, token: "tok", fullLoad: false });
    expect(answer.ok && answer.answer.ok).toBe(true);
    a.calls.cast("b", "HANDOFF_COMMIT", { username: "dan", token: "tok", snapshot });
    await settle();
    const taken = b.handoff.takeArrival("tok", "dan", "100");
    // The caller still gets all of it.
    expect(taken!.snapshot.state).toEqual(snapshot.state);
    expect(taken!.snapshot.creatureIds).toEqual([1, 2, 3]);
    // Guard: the drop. Without it 1000 arrivals hold up to 64 MB of state for nothing.
    const kept = (b.handoff as any).landing.get("tok").snapshot;
    expect(kept.state).toEqual({});
    expect(kept.creatureIds).toEqual([]);
    expect(kept.playerIds).toEqual([]);
    expect(kept.username).toBe("dan");
    // The line of marks still names the player.
    const lines: string[] = [];
    const info = spyOn(log, "info").mockImplementation(((m: string) => { lines.push(String(m)); }) as any);
    spies.push(info);
    // A crossing under 100 ms says its summary at debug (f2minors M2).
    const debug = spyOn(log, "debug").mockImplementation(((m: string) => { lines.push(String(m)); }) as any);
    spies.push(debug);
    b.handoff.landed("tok", "open");
    b.handoff.firstMove("tok");
    expect(lines.some((l) => l.startsWith("[handoff] dan a->b total="))).toBe(true);
  } finally {
    stop();
  }
});

// ---- the client

const GATEWAY = join(import.meta.dir, "..", "..", "..", "Frostfire-Forge-Gateway", "src", "webserver", "public", "js", "core");
const haveClient = existsSync(join(GATEWAY, "handoffwalk.ts"));
const clientTest = haveClient ? test : test.skip;
const walk = haveClient ? await import(join(GATEWAY, "handoffwalk.ts")) : (null as any);

/** A map of 32 px tiles in 32-tile chunks whose collision layer is set where `wall` says (global tile coordinates). */
function mapWith(wall: (tx: number, ty: number) => boolean): any {
  const loadedChunks = new Map<string, any>();
  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const data = new Array(32 * 32).fill(0);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (wall(cx * 32 + x, cy * 32 + y)) data[y * 32 + x] = 5;
      loadedChunks.set(`${cx}-${cy}`, { width: 32, layers: [{ name: "Ground", data: new Array(32 * 32).fill(1) }, { name: "Collision", data }] });
    }
  }
  return { tilewidth: 32, tileheight: 32, chunkSize: 32, loadedChunks };
}

clientTest("the client walks the player at the engine's speed along the held keys, and not into a wall", () => {
  expect(walk.heldDirection(new Set(["KeyW", "KeyD"]))).toBe("upright");
  expect(walk.heldDirection(new Set(["KeyS"]))).toBe("down");
  expect(walk.heldDirection(new Set())).toBe("");
  const open = mapWith(() => false);
  const player: any = { position: { x: 100, y: 100 }, mounted: false };
  // 0.5 s at 180 px a second is 90 px, in whatever frames it comes.
  for (let i = 0; i < 30; i++) walk.advanceSelf(player, "right", 1000 / 60, open);
  expect(player.position.x).toBe(190);
  expect(player.position.y).toBe(100);
  expect(player.lastDirection).toBe("right");
  // Mounted: 1.35 times.
  const mounted: any = { position: { x: 0, y: 0 }, mounted: true };
  walk.advanceSelf(mounted, "down", 1000, open);
  expect(mounted.position.y).toBe(243);
  // A wall tile at x = 300..331: the player stops in front of it (their box is 24 wide).
  const walled = mapWith((tx) => tx === 9);
  const blocked: any = { position: { x: 250, y: 100 } };
  for (let i = 0; i < 120; i++) walk.advanceSelf(blocked, "right", 1000 / 60, walled);
  expect(blocked.position.x).toBeLessThan(300);
  expect(blocked.position.x).toBeGreaterThan(270);
  // A diagonal into it slides along the open axis.
  const slide: any = { position: { x: 250, y: 100 } };
  for (let i = 0; i < 60; i++) walk.advanceSelf(slide, "downright", 1000 / 60, walled);
  expect(slide.position.y).toBeGreaterThan(150);
  expect(slide.position.x).toBeLessThan(300);
  // A chunk the client does not hold is not a wall.
  const hole: any = { position: { x: 100, y: 100 } };
  walk.advanceSelf(hole, "right", 500, { ...open, loadedChunks: new Map() });
  expect(hole.position.x).toBe(190);
  // No direction, no step.
  const still: any = { position: { x: 5, y: 5 } };
  expect(walk.advanceSelf(still, "", 100, open)).toBe(false);
});

clientTest("the difference to the new node's position is eased out, and snapped when it is large", () => {
  const player: any = { position: { x: 0, y: 0 } };
  // 40 px ahead: eased.
  expect(walk.startEase(player, { x: 140, y: 100 }, { x: 100, y: 100 }, 1000)).toBe(true);
  const first = walk.applyEase(player, { x: 100, y: 100 }, 1000);
  expect(first.x).toBe(140);
  const later = walk.applyEase(player, { x: 100, y: 100 }, 1000 + walk.EASE_TIME_CONSTANT_MS);
  // One time constant: a third of the error is left.
  expect(later.x).toBeCloseTo(100 + 40 / Math.E, 1);
  const done = walk.applyEase(player, { x: 100, y: 100 }, 1000 + 20 * walk.EASE_TIME_CONSTANT_MS);
  expect(done).toEqual({ x: 100, y: 100 });
  expect(player.handoffEase).toBeUndefined();
  // Above the snap size (the movement smoothing's teleport size): taken at once.
  expect(walk.HANDOFF_SNAP_PX).toBe(100);
  expect(walk.startEase(player, { x: 301, y: 100 }, { x: 100, y: 100 }, 2000)).toBe(false);
  expect(walk.applyEase(player, { x: 100, y: 100 }, 2000)).toEqual({ x: 100, y: 100 });
  // No error, nothing to ease.
  expect(walk.startEase(player, { x: 100, y: 100 }, { x: 100, y: 100 }, 2000)).toBe(false);
});

clientTest("the client opens the next node's session on HANDOFF_PREPARE and keeps it for the SWITCH, one at a time, closed when unused", () => {
  const client = readFileSync(join(GATEWAY, "socket.ts"), "utf8");
  const renderer = readFileSync(join(GATEWAY, "renderer.ts"), "utf8");
  // The packets are handled.
  expect(client).toContain('case "HANDOFF_PREPARE": {');
  expect(client).toContain('case "HANDOFF_ABORT": {');
  // The session and its stream are opened, and nothing is sent on it: the AUTH_CONNECT is sent by setupTransport at the SWITCH.
  const pre = client.slice(client.indexOf("function preOpenNode("), client.indexOf("async function transportForSwitch("));
  expect(pre).toContain("openGameTransport(server, marks)");
  expect(pre).toContain("createBidirectionalStream()");
  expect(pre).not.toContain("AUTH_CONNECT");
  expect(pre).not.toContain("sendRawFrame");
  // At most one: a different node closes the earlier one.
  expect(pre).toContain("closePreOpened(preOpened);");
  expect(client).toContain("const HANDOFF_PREOPEN_MS = 10_000;");
  // The SWITCH uses it only for the same node and while it is open, else opens as before.
  const use = client.slice(client.indexOf("async function transportForSwitch("), client.indexOf("// The times of one handoff on the client"));
  expect(use).toContain("handoff && !pre.closed && pre.key === nodeKey(server)");
  expect(use).toContain("openSwitchTransport(server, marks)");
  expect(client).toContain("await Promise.race([setupTransport(opened.stream), closedFirst]);");
  expect(client).toContain("const bidi = preStream ?? await socket.createBidirectionalStream();");
  // The certificate hash is kept per origin.
  expect(client).toContain("const certHashes = new Map<string, string>();");
  // The measurement line.
  expect(client).toContain("[handoff] client switch_rx->cert/wt_ready/auth_sent/handoff_done/first_pos ms:");
  // The walk is drawn while the gap lasts; movementAllowed still holds the sending.
  expect(renderer).toContain("advanceSelf(currentPlayer, gapDirection(pressedKeys, getStickDirection()), stepMs, window.mapData);");
  expect(client).toContain("handoffGap = data?.resume === true;");
  // A stick still held after HANDOFF_DONE sends its direction and never a stop; a repeat prepare does not extend the timer.
  const done = client.slice(client.indexOf('case "HANDOFF_DONE"'), client.indexOf('case "LOAD_PLAYERS"'));
  // (What is sent is decided by doneSend in the Gateway's resumesend.ts, which has its own tests; here the stick is handed to it,
  // what it names is sent as a MOVEXY, and HANDOFF_DONE sends no ABORT of its own.)
  expect(done).toContain("stick: getStickDirection(),");
  expect(done).toContain('if (send.send !== null) sendRequest({ type: "MOVEXY", data: send.send });');
  expect(done).not.toContain('data: "ABORT"');
  expect(pre.slice(0, pre.indexOf("closePreOpened(preOpened);"))).not.toContain("setTimeout");
});

clientTest("the cluster overlay waits during a switch or a disconnect, forgets the old node's answer, and starts again at HANDOFF_DONE and LOAD_MAP", () => {
  const overlay = readFileSync(join(GATEWAY, "clusternodes.ts"), "utf8");
  const client = readFileSync(join(GATEWAY, "socket.ts"), "utf8");
  expect(overlay).toContain("export function pauseClusterRefresh(keepGrid = false): void {");
  expect(overlay).toContain("timer = setInterval(() => { if (!paused) request?.(); }, REFRESH_MS);");
  expect(overlay.slice(overlay.indexOf("export function requestClusterRefresh")).slice(0, 200)).toContain("paused = false;");
  // Kept as it was: the data case, the requester, and the refresh lines.
  expect(client).toContain('case "CLUSTER_DEBUG_DATA": {');
  expect(client).toContain("setClusterDebugRequester(() => sendRequest({ type: \"CLUSTER_DEBUG\", data: {} }));");
  expect(client.match(/requestClusterRefresh\(\);/g)).toHaveLength(2);
  // Paused when the switch starts (a handoff keeps the grid drawn, any other switch clears it), the socket closes and switching stops.
  expect(client.slice(client.indexOf("async function switchNode("), client.indexOf("async function switchNode(") + 1200)).toContain("pauseClusterRefresh(handoff);");
  expect(client.slice(client.indexOf("async function handleSocketClose("), client.indexOf("async function handleSocketClose(") + 400)).toContain("pauseClusterRefresh();");
  expect(client.slice(client.indexOf("function stopSwitching("), client.indexOf("function stopSwitching(") + 200)).toContain("pauseClusterRefresh();");
});
