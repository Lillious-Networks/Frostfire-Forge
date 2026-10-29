import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { LinkCalls } from "../cluster/linkcalls";
import { TRADE_UNREACHABLE, TradeLink, type TradeAnswer, type TradeHandlers, type TradeReply } from "../cluster/tradelink";
import { linkPair, settle } from "./cluster-fakelink";
import { databaseModule, standInFor } from "./setup";
import { receiverSource as readReceiverSource } from "./receiver-source";

// The trade systems read the database and the item list; none of these tests writes a row.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: async (_sql: string, _params?: any[]) => [] }));
const items = [{ name: "Iron Ore", quality: "common", type: "material", description: "", icon: "iron_ore.png", equipment_slot: null, bag_slots: null }];
await standInFor("../services/assetCache", () => ({
  default: { get: async (key: string) => (key === "items" ? items : null), set: async () => {}, add: async () => {} },
}));

const { default: log } = await import("../modules/logger");
const { default: trades, cannotTrade } = await import("../systems/trades");
const { default: inventory } = await import("../systems/inventory");
const { default: currency } = await import("../systems/currency");
const { settled, tradeSettle, unsettle } = await import("../cluster/tradesettle");

// Every test file shares one process: the log is not written to, and what a test changes is put back.
const restores: Array<() => void> = [];
let warned: string[] = [];
let infos: string[] = [];
let errored: string[] = [];
beforeEach(() => {
  warned = [];
  infos = [];
  errored = [];
  const spy = (target: any, key: string, impl: (...args: any[]) => any) => {
    const s = spyOn(target, key).mockImplementation(impl as any);
    restores.push(() => s.mockRestore());
  };
  spy(log, "warn", (message: string) => { warned.push(message); });
  spy(log, "info", (message: string) => { infos.push(message); });
  spy(log, "error", (message: string) => { errored.push(message); });
});
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  trades.reset();
});
afterAll(() => trades.reset());

// ------------------------------------------------------------------ the link

// The host is node "a", where Alice asked for the trade. The partner's node is "b", where Bob is.
function pair(settleWaitMs?: number) {
  const { a, b } = linkPair();
  const ca = new LinkCalls(200);
  const cb = new LinkCalls(200);
  ca.attach(a);
  cb.attach(b);
  return { a, b, ca, cb, host: new TradeLink(ca), partner: new TradeLink(cb, settleWaitMs) };
}

type Seen = { answers: unknown[]; updates: unknown[]; states: unknown[]; closed: unknown[] };
function recorder(replies: { answer?: TradeReply; update?: TradeReply } = {}): TradeHandlers & { seen: Seen } {
  const seen: Seen = { answers: [], updates: [], states: [], closed: [] };
  return {
    seen,
    answer: async (body, from) => {
      seen.answers.push([body, from]);
      return replies.answer ?? { ok: true, opened: true };
    },
    update: async (body, from) => {
      seen.updates.push([body, from]);
      return replies.update ?? { ok: true };
    },
    state: (body) => {
      seen.states.push(body);
    },
    closed: (body) => {
      seen.closed.push(body);
    },
  };
}

const bobAnswers = (accepted = true): TradeAnswer => ({ asker: "alice", askerId: "1", authorization: "auth", partner: "Bob", partnerId: "2", accepted });
/** The stamp the partner's node gave the trade its last answer asked for. */
const stampOf = (handlers: { seen: Seen }): string => (handlers.seen.answers.at(-1) as any)[0].stamp;

test("an answer that opens a trade holds its host for the asked player", async () => {
  const { host, partner } = pair();
  const handlers = recorder();
  host.setHandlers(handlers);
  expect(await partner.sendAnswer("a", bobAnswers())).toEqual({ ok: true, opened: true });
  expect(handlers.seen.answers).toEqual([[{ ...bobAnswers(), stamp: expect.any(String) }, "b"]]);
  expect(stampOf(handlers).length).toBeGreaterThan(0);
  expect(partner.hostOf("bob")).toBe("a");
});

test("an answer that opens nothing, or does not arrive, holds no host", async () => {
  const refused = pair();
  refused.host.setHandlers(recorder({ answer: { ok: false, reason: "Alice is already trading." } }));
  expect(await refused.partner.sendAnswer("a", bobAnswers())).toEqual({ ok: false, reason: "Alice is already trading." });
  expect(refused.partner.hostOf("bob")).toBeNull();

  const declined = pair();
  declined.host.setHandlers(recorder({ answer: { ok: true } }));
  expect(await declined.partner.sendAnswer("a", bobAnswers(false))).toEqual({ ok: true });
  expect(declined.partner.hostOf("bob")).toBeNull();

  const down = pair();
  down.host.setHandlers(recorder());
  down.b.up = false;
  expect((await down.partner.sendAnswer("a", bobAnswers())).ok).toBe(false);
  expect(down.partner.hostOf("bob")).toBeNull();
  // The trade may have opened there without this node knowing: that is logged.
  expect(warned.some((line) => line.includes("bob") && line.includes("may be open"))).toBe(true);
});

test("an answer that opens nothing leaves the host of a trade the player already has", async () => {
  const { host, partner } = pair();
  const handlers = recorder();
  host.setHandlers(handlers);
  await partner.sendAnswer("a", bobAnswers());
  const stamp = stampOf(handlers);
  host.setPartner("bob", "b", stamp);

  // A second invitation from the same node, declined, and one that is refused.
  handlers.answer = async () => ({ ok: true });
  expect(await partner.sendAnswer("a", { ...bobAnswers(false), authorization: "second" })).toEqual({ ok: true });
  expect(partner.hostOf("bob")).toBe("a");
  handlers.answer = async () => ({ ok: false, reason: "Dave is already trading." });
  expect(await partner.sendAnswer("a", { ...bobAnswers(true), authorization: "third" })).toEqual({ ok: false, reason: "Dave is already trading." });
  expect(partner.hostOf("bob")).toBe("a");
  // The trade is still Bob's: his updates reach the host, with the stamp it was opened under.
  expect(await partner.sendUpdate("bob", "cancel")).toEqual({ ok: true });
  expect(handlers.seen.updates).toEqual([[{ username: "bob", op: "cancel", stamp }, "b"]]);
});

test("only the asked player's node changes their side of the trade", async () => {
  const { host, partner } = pair();
  const handlers = recorder({ update: { ok: false, reason: "That is not an amount." } });
  host.setHandlers(handlers);
  await partner.sendAnswer("a", bobAnswers());
  // The host has not recorded Bob as a partner: it refuses, and the host is let go here.
  expect(await partner.sendUpdate("Bob", "offer", { coins: 1 })).toMatchObject({ ok: false, gone: true });
  expect(partner.hostOf("bob")).toBeNull();
  expect(handlers.seen.updates).toEqual([]);
  expect(warned.some((line) => line.includes("bob") && line.includes("refused"))).toBe(true);

  await partner.sendAnswer("a", bobAnswers());
  const stamp = stampOf(handlers);
  host.setPartner("bob", "b", stamp);
  expect(await partner.sendUpdate("Bob", "offer", { coins: 1 })).toEqual({ ok: false, reason: "That is not an amount." });
  expect(handlers.seen.updates).toEqual([[{ username: "bob", op: "offer", offer: { coins: 1 }, stamp }, "b"]]);
  expect(partner.hostOf("bob")).toBe("a");

  // A partner recorded on another node is not spoken for by this one.
  host.setPartner("bob", "c", stamp);
  expect(await partner.sendUpdate("Bob", "accept")).toMatchObject({ ok: false, gone: true });
});

test("an update of an earlier trade is refused by the host, which holds a newer one for the same player", async () => {
  const { host, partner } = pair();
  const handlers = recorder();
  host.setHandlers(handlers);
  await partner.sendAnswer("a", bobAnswers());
  // The host holds a newer trade of Bob's, from the same node, under another stamp.
  host.setPartner("bob", "b", "newer");
  expect(await partner.sendUpdate("bob", "accept")).toMatchObject({ ok: false, gone: true });
  expect(handlers.seen.updates).toEqual([]);
  expect(partner.hostOf("bob")).toBeNull();
});

test("a host that cannot be reached ends the trade for the asked player", async () => {
  const { b, host, partner } = pair();
  const handlers = recorder();
  host.setHandlers(handlers);
  await partner.sendAnswer("a", bobAnswers());
  host.setPartner("bob", "b", stampOf(handlers));
  b.up = false;
  expect(await partner.sendUpdate("bob", "offer", {})).toEqual({ ok: false, gone: true, reason: TRADE_UNREACHABLE });
  expect(partner.hostOf("bob")).toBeNull();
  expect(await partner.sendUpdate("bob", "offer", {})).toBeNull();
  expect(warned.some((line) => line.includes("bob") && line.includes("offer") && line.includes("may still be open"))).toBe(true);
  // A link that is down gets no cancel after it.
  expect(handlers.seen.updates).toEqual([]);
});

test("an update that is lost is followed by one cancel, and the host is let go once that is answered", async () => {
  const { b, host, partner } = pair();
  const handlers = recorder();
  host.setHandlers(handlers);
  await partner.sendAnswer("a", bobAnswers());
  const stamp = stampOf(handlers);
  host.setPartner("bob", "b", stamp);
  // The offer is lost on the link; the cancel after it is not.
  b.blackhole = true;
  const lost = partner.sendUpdate("bob", "offer", { coins: 1 });
  b.blackhole = false;
  expect(await lost).toEqual({ ok: false, gone: true, reason: TRADE_UNREACHABLE });
  expect(handlers.seen.updates).toEqual([[{ username: "bob", op: "cancel", stamp }, "b"]]);
  expect(partner.hostOf("bob")).toBeNull();
  expect(warned.some((line) => line.includes("bob") && line.includes("timeout"))).toBe(true);

  // A leave that is lost sends no cancel after it: the one who left is done with the trade, and the host takes a cancel it is sent.
  await partner.sendAnswer("a", bobAnswers());
  host.setPartner("bob", "b", stampOf(handlers));
  b.blackhole = true;
  const left = partner.sendUpdate("bob", "leave");
  b.blackhole = false;
  await left;
  expect(handlers.seen.updates.length).toBe(1);
});

test("one who leaves lets go of the host at once", async () => {
  const { host, partner } = pair();
  const handlers = recorder();
  host.setHandlers(handlers);
  await partner.sendAnswer("a", bobAnswers());
  const stamp = stampOf(handlers);
  host.setPartner("bob", "b", stamp);
  const leaving = partner.sendUpdate("bob", "leave");
  expect(partner.hostOf("bob")).toBeNull();
  expect(await leaving).toEqual({ ok: true });
  expect(handlers.seen.updates).toEqual([[{ username: "bob", op: "leave", stamp }, "b"]]);
});

test("the trade's state and its end reach the asked player's node from their host", async () => {
  const { host, partner } = pair();
  const handlers = recorder();
  const hostSide = recorder();
  host.setHandlers(hostSide);
  partner.setHandlers(handlers);
  await partner.sendAnswer("a", bobAnswers());
  const stamp = stampOf(hostSide);

  // Bob is not yet recorded as a partner on the host: nothing is sent.
  expect(host.sendState("bob", { partner: "alice" })).toBe(false);
  host.setPartner("bob", "b", stamp);
  expect(host.sendState("bob", { partner: "alice" })).toBe(true);
  await settle();
  expect(handlers.seen.states).toEqual([{ username: "bob", state: { partner: "alice" }, stamp }]);

  expect(host.sendClosed("bob", { completed: true, message: "Trade complete.", reload: true })).toBe(true);
  expect(host.partnerPeer("bob")).toBeNull();
  await settle();
  expect(handlers.seen.closed).toEqual([{ username: "bob", completed: true, message: "Trade complete.", reload: true, stamp }]);
  expect(partner.hostOf("bob")).toBeNull();
});

test("a late state or end of an earlier trade does not touch a newer one of the same player and host", async () => {
  const { host, partner } = pair();
  const handlers = recorder();
  const hostSide = recorder();
  host.setHandlers(hostSide);
  partner.setHandlers(handlers);
  // The first trade ended on both nodes, and its last casts are still on their way when Bob answers a new invitation.
  await partner.sendAnswer("a", bobAnswers());
  const old = stampOf(hostSide);
  partner.dropHost("bob");
  await partner.sendAnswer("a", bobAnswers());
  const fresh = stampOf(hostSide);
  expect(fresh).not.toBe(old);
  host.setPartner("bob", "b", old);
  expect(host.sendState("bob", { old: true })).toBe(true);
  expect(host.sendClosed("bob", { completed: false, message: "old", reload: false })).toBe(true);
  await settle();
  expect(handlers.seen.states).toEqual([]);
  expect(handlers.seen.closed).toEqual([]);
  expect(partner.hostOf("bob")).toBe("a");
  // The newer trade's own end is taken.
  host.setPartner("bob", "b", fresh);
  expect(host.sendClosed("bob", { completed: false, message: "new", reload: false })).toBe(true);
  await settle();
  expect(handlers.seen.closed.length).toBe(1);
  expect(partner.hostOf("bob")).toBeNull();
});

test("a state from a node that does not hold the player's trade is dropped", async () => {
  const { host, partner } = pair();
  const handlers = recorder();
  partner.setHandlers(handlers);
  host.setPartner("bob", "b");
  // No host is recorded for Bob on "b": the casts are sent, and dropped there.
  expect(host.sendState("bob", { partner: "alice" })).toBe(true);
  expect(host.sendClosed("bob", { completed: false, message: "", reload: false })).toBe(true);
  await settle();
  expect(handlers.seen.states).toEqual([]);
  expect(handlers.seen.closed).toEqual([]);
  // A trade state that is dropped is logged.
  expect(infos.filter((line) => line.includes("bob") && line.includes("dropped")).length).toBe(2);
});

test("a state or an end from a node that is not the recorded host is dropped, even when another node holds one", async () => {
  const { host, partner } = pair();
  const handlers = recorder();
  partner.setHandlers(handlers);
  host.setPartner("bob", "b");
  // Bob's trade is held by node "c" as far as "b" knows: nothing from "a" is taken for it.
  partner.setHost("bob", "c");
  expect(host.sendState("bob", { partner: "alice" })).toBe(true);
  expect(host.sendClosed("bob", { completed: true, message: "Trade complete.", reload: true })).toBe(true);
  await settle();
  expect(handlers.seen.states).toEqual([]);
  expect(handlers.seen.closed).toEqual([]);
  // And the host recorded for Bob is still "c".
  expect(partner.hostOf("bob")).toBe("c");
});

test("a state or an end that cannot be sent is logged, and an end still frees the partner", async () => {
  const { a, host } = pair();
  host.setPartner("bob", "b");
  a.up = false;
  expect(host.sendState("bob", {})).toBe(false);
  expect(warned.some((line) => line.includes("bob") && line.includes("trade window"))).toBe(true);
  expect(host.sendClosed("bob", { completed: true, message: "Trade complete.", reload: true })).toBe(false);
  expect(host.partnerPeer("bob")).toBeNull();
  expect(warned.some((line) => line.includes("bob") && line.includes("bags and coins are not read again"))).toBe(true);
});

test("a host that answers nothing readable opens no trade", async () => {
  const { host, partner } = pair();
  host.setHandlers({ ...recorder(), answer: async () => null as any });
  const reply = await partner.sendAnswer("a", bobAnswers());
  expect(reply.ok).toBe(false);
  expect(partner.hostOf("bob")).toBeNull();
});

test("a call before the handlers are set is answered, not run", async () => {
  const { partner } = pair();
  expect((await partner.sendAnswer("a", bobAnswers())).ok).toBe(false);
  expect(partner.hostOf("bob")).toBeNull();
});

// ------------------------------------------------------ the receiver's helpers
// socket/receiver.ts cannot be imported by a test (it imports the server, which starts it), so, as the
// other receiver tests do, the helpers are read from its source and run with the names they use handed in.
// Each is cut out whole, from its first line to the closing brace at the left margin, so nothing past its
// end is taken. Two nodes are made from the same source, each with its own players, mirrors and trade link.
const receiverSource = readReceiverSource();
const transpiler = new Bun.Transpiler({ loader: "ts" });

function only(pattern: RegExp, what: string): number {
  const found = [...receiverSource.matchAll(new RegExp(pattern.source, "gm"))];
  if (found.length !== 1) throw new Error(`${what} was found ${found.length} times in socket/receiver.ts`);
  return found[0].index!;
}
function functionSource(name: string): string {
  const start = only(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`), `function ${name}`);
  const end = receiverSource.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`function ${name} has no end`);
  return receiverSource.slice(start, end + 3).replace(/^export /, "");
}
function constSource(name: string): string {
  const start = only(new RegExp(`^(?:export )?const ${name} = `), `const ${name}`);
  const end = receiverSource.indexOf(";\n", start);
  return receiverSource.slice(start, end + 2).replace(/^export /, "");
}
function statementSource(opening: string): string {
  const start = only(new RegExp(`^${opening.replace(/[.(]/g, "\\$&")}`), opening);
  const end = receiverSource.indexOf(");\n", start);
  return receiverSource.slice(start, end + 3).replace(/^export /, "");
}

const FUNCTIONS = [
  "tradeRefusal", "isTrading", "busyRefusal", "sendTradeViewTo", "sendTradeState", "sendTradeClosed", "sendBelongingsAfterTrade",
  "offerInTrade", "acceptTrade", "cancelTrade", "endTradeOf", "answerTradeHere", "updateTradeHere", "showTradeFromHost",
  "closeTradeFromHost", "reloadWhenSettled", "loseTrade", "requestTrade", "tradeAction", "relayTradeUpdate", "answerTradeIfAcross", "answerTradeAcross",
  "endTradeOfLeaver", "vendorFor",
];
const NAMES = [
  "playerCache", "trades", "tradeLink", "packetManager", "sendPacket", "subscriptionRefusal", "cannotTrade", "entityById",
  "mirrorByUsername", "mirrorOwner", "listener", "Events", "log", "sendBelongingsOf", "TRADE_UNREACHABLE", "randomBytes",
  "sendInvitation", "vendors", "readNpcList", "cannotShop", "isQuestRateLimited", "unsettle", "settled", "tradeSettle", "handoffCtx",
];
const helperCode = [
  constSource("traderNamed"),
  constSource("shownName"),
  ...FUNCTIONS.map(functionSource),
  statementSource("tradeLink.setHandlers("),
].join("\n");
const compiled: (given: Record<string, any>) => Record<string, any> = new Function(`"use strict";\n${transpiler.transformSync(
  `function make({ ${NAMES.join(", ")} }: any) {\n${helperCode}\nreturn { traderNamed, shownName, ${FUNCTIONS.join(", ")} };\n}`,
)}\nreturn make;`)();

// ------------------------------------------------------------------ fixtures

const decode = (packet: any) => packet;
const packetManager = {
  tradeState: (data: any) => ({ type: "TRADE_STATE", data }),
  tradeClosed: (data: any) => ({ type: "TRADE_CLOSED", data }),
  notify: (data: any) => ({ type: "NOTIFY", data }),
  vendorClosed: (data: any) => ({ type: "VENDOR_CLOSED", data }),
};
const sendPacket = (wt: any, packet: any) => { wt.sent.push(decode(packet)); };

interface Node {
  name: string;
  link: TradeLink;
  calls: LinkCalls;
  players: Map<string, any>;
  mirrors: Map<string, any>;
  /** The names given to sendBelongingsOf, and the events emitted. */
  belongings: string[];
  emitted: any[][];
  invitations: any[][];
  /** Whether this node's subscription rule refuses a trade, and the trades it holds besides (name to anything). */
  subscription: string | null;
  holds: Map<string, any>;
  failBelongings: boolean;
  /** How long (ms) a reload of bags takes. */
  delay: number;
  /** Whether the rate limit refuses the next packet of the player. */
  limited: boolean;
  helpers: Record<string, any>;
}

let realTrades: any = null;
/** What happened, in order, in the tests of a swap that is under way: the commit, and each reload of bags. */
let order: string[] = [];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function makeNode(name: string, link: any, hostTrades: boolean, clusterOff = false): Node {
  const calls = new LinkCalls(200);
  // With the cluster off the links are never attached, and the receiver holds no link context.
  if (!clusterOff) calls.attach(link);
  const tradeLink = new TradeLink(calls, 400);
  let authorizations = 0;
  const players = new Map<string, any>();
  const mirrors = new Map<string, any>();
  const node: Node = { name, link: tradeLink, calls, players, mirrors, belongings: [], emitted: [], invitations: [], subscription: null, holds: new Map(), failBelongings: false, delay: 0, limited: false, helpers: {} };
  const playerCache = {
    get: (id: string) => players.get(String(id)),
    getByUsername: (username: string) => [...players.values()].find((p) => p.username.toLowerCase() === String(username).toLowerCase()),
    set: (id: string, player: any) => { players.set(String(id), player); },
  };
  // Only the host holds trades in these tests, with the real rules; the other node holds what a test puts in `holds`.
  const nodeTrades = hostTrades ? realTrades : { of: (username: string) => node.holds.get(username.toLowerCase()) ?? null, cancel: () => null };
  node.helpers = compiled({
    playerCache,
    trades: nodeTrades,
    tradeLink,
    packetManager,
    sendPacket,
    subscriptionRefusal: () => node.subscription,
    cannotTrade,
    entityById: (id: string) => players.get(String(id)) ?? mirrors.get(String(id)),
    mirrorByUsername: (username: string) => [...mirrors.values()].find((m) => m.username.toLowerCase() === String(username).toLowerCase()),
    mirrorOwner: (id: string) => mirrors.get(String(id))?.mirrorFrom ?? null,
    listener: { emit: (...event: any[]) => { node.emitted.push(event); } },
    Events: { TRADE_COMPLETED: "TRADE_COMPLETED" },
    log,
    sendBelongingsOf: async (online: any) => {
      if (!online) return;
      if (node.delay) await new Promise((resolve) => setTimeout(resolve, node.delay));
      if (node.failBelongings) throw new Error("database gone");
      node.belongings.push(online.username);
      order.push(`reload ${online.username}`);
    },
    TRADE_UNREACHABLE,
    randomBytes: () => `auth-${++authorizations}`,
    sendInvitation: async (_from: any, toUsername: string, invitation: any) => { node.invitations.push([toUsername, invitation]); return true; },
    vendors: { forget: () => {} },
    readNpcList: async () => [{ id: 5, name: "Smith" }],
    cannotShop: () => null,
    isQuestRateLimited: () => node.limited,
    unsettle,
    settled,
    tradeSettle,
    handoffCtx: clusterOff ? null : { calls },
  });
  return node;
}

let a: Node;
let b: Node;
let alice: any;
let bob: any;
let fakeLinks: ReturnType<typeof linkPair>;

const person = (id: string, username: string, x: number, over: Record<string, any> = {}) => ({
  id, username, invitations: [], isGuest: false, isDead: false, isGhost: false, pvp: false,
  location: { map: "forest.json", position: { x, y: 100 } }, wt: { sent: [] as any[] }, ...over,
});
/** A player as a neighbouring node's mirror of them: bare map, no socket. */
const mirrorOf = (player: any, from: string) => ({
  id: player.id, username: player.username, isGuest: false, isDead: false, isGhost: false, pvp: false,
  remote: true, mirrorFrom: from, location: { map: "forest", position: { ...player.location.position } },
});
const sentTo = (player: any, type: string) => player.wt.sent.filter((packet: any) => packet.type === type).map((packet: any) => packet.data);
const lastOf = (player: any, type: string) => sentTo(player, type).at(-1);
const noticesOf = (player: any) => sentTo(player, "NOTIFY").map((data: any) => data.message);

beforeEach(() => {
  order = [];
  trades.reset();
  realTrades = trades;
  fakeLinks = linkPair();
  a = makeNode("a", fakeLinks.a, true);
  b = makeNode("b", fakeLinks.b, false);
  alice = person("1", "alice", 100);
  bob = person("2", "bob", 150, { location: { map: "forest", position: { x: 150, y: 100 } } });
  a.players.set("1", alice);
  a.mirrors.set("2", mirrorOf(bob, "b"));
  b.players.set("2", bob);
  b.mirrors.set("1", mirrorOf(alice, "a"));
  // The node's marks after a lost trade (cluster/tradesettle.ts) are shared by every test: a mark lasts a minute
  // unless a test shortens it, so no reload after the mark runs out lands in a test that did not ask for one, and
  // no row is dropped.
  tradeSettle.reset({ ms: 60_000, drop: async () => {} });
});
afterEach(() => {
  // A reload still waiting on a mark runs now, at once, and before the next test's fixtures are made.
  if (a) { a.delay = 0; a.failBelongings = false; }
  if (b) { b.delay = 0; b.failBelongings = false; }
  tradeSettle.reset();
});

/** Alice asks Bob, and Bob accepts: the trade is open on node a. */
async function openAcross(): Promise<string> {
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, invitation] = a.invitations[0];
  await b.helpers.answerTradeIfAcross(bob.wt, bob, invitation.originator, invitation.authorization, "ACCEPT");
  await settle();
  return invitation.authorization;
}
/** Makes the offer in the open trade old enough to be accepted. */
const ripen = () => { trades.of("alice")!.changedAt -= 10_000; };

// ------------------------------------------------- asking, and answering across

test("a player of the neighbouring node can be asked, by their mirror", async () => {
  await a.helpers.requestTrade(alice.wt, alice, "2");
  expect(noticesOf(alice)).toEqual(["Trade request sent to Bob"]);
  expect(a.invitations.map(([to, invitation]) => [to, invitation.action, invitation.originator])).toEqual([["bob", "TRADE_REQUEST", "1"]]);
  // The invitation stays on the asker, and only Bob's id can answer it.
  expect(alice.invitations).toEqual([{ action: "TRADE_REQUEST", originator: "1", authorization: "auth-1", target: "2" }]);
});

test("a request to a mirror too far away, or to one who is trading elsewhere, is refused", async () => {
  a.mirrors.get("2").location.position.x = 1000;
  await a.helpers.requestTrade(alice.wt, alice, "2");
  expect(noticesOf(alice)).toEqual(["Bob is too far away to trade."]);
  expect(a.invitations).toEqual([]);

  a.mirrors.get("2").location.position.x = 150;
  a.mirrors.get("2").location.map = "cave";
  await a.helpers.requestTrade(alice.wt, alice, "2");
  expect(noticesOf(alice).at(-1)).toBe("Bob is too far away to trade.");

  a.mirrors.delete("2");
  await a.helpers.requestTrade(alice.wt, alice, "2");
  expect(noticesOf(alice).at(-1)).toBe("That player is not online.");
  expect(a.invitations).toEqual([]);
});

test("a trade of the asker's, here or held on a neighbouring node, keeps them from asking", async () => {
  const carol = person("3", "carol", 100);
  a.players.set("3", carol);
  expect(typeof trades.open(carol, alice)).toBe("object");
  await a.helpers.requestTrade(alice.wt, alice, "2");
  expect(noticesOf(alice)).toEqual(["You are already trading."]);
  expect(a.invitations).toEqual([]);

  // Bob's trade is held on node a: node b will not let him ask either.
  trades.reset();
  b.link.setHost("bob", "a");
  await b.helpers.requestTrade(bob.wt, bob, "1");
  expect(noticesOf(bob)).toEqual(["You are already trading."]);
  expect(b.invitations).toEqual([]);
});

test("an answer from across opens the trade on the asker's node and shows both players its window", async () => {
  await openAcross();
  const trade = trades.of("alice");
  expect(trade?.players).toEqual(["alice", "bob"]);
  expect(a.link.partnerPeer("bob")).toBe("b");
  expect(b.link.hostOf("bob")).toBe("a");
  expect(a.helpers.isTrading("alice")).toBe(true);
  expect(b.helpers.isTrading("bob")).toBe(true);
  // Alice's window comes from her own node, Bob's from the cast of the host.
  expect(lastOf(alice, "TRADE_STATE")).toMatchObject({ partner: "bob" });
  expect(lastOf(bob, "TRADE_STATE")).toMatchObject({ partner: "alice" });
  // The invitation is spent.
  expect(alice.invitations).toEqual([]);
});

test("a declined answer from across opens nothing and tells the asker", async () => {
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, invitation] = a.invitations[0];
  await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", invitation.authorization, "decline");
  await settle();
  expect(trades.of("alice")).toBeNull();
  expect(b.link.hostOf("bob")).toBeNull();
  expect(a.link.partnerPeer("bob")).toBeNull();
  expect(noticesOf(alice).at(-1)).toBe("Bob declined your trade request");
  expect(alice.invitations).toEqual([]);
});

test("an answer is not taken from a node the answering player is not mirrored from", async () => {
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, invitation] = a.invitations[0];
  const answer = (over: Record<string, any>, from = "b") => a.helpers.answerTradeHere(
    { asker: "alice", askerId: "1", authorization: invitation.authorization, partner: "bob", partnerId: "2", accepted: true, ...over }, from);

  // A third node speaks for Bob.
  expect(await answer({}, "c")).toEqual({ ok: false, reason: "Invitation not found or has already been processed" });
  // The node that sent it names a player it does not hold.
  a.mirrors.set("9", mirrorOf(person("9", "mallory", 100), "c"));
  expect(await answer({ partnerId: "9", partner: "mallory" })).toEqual({ ok: false, reason: "Invitation not found or has already been processed" });
  // The name does not match the mirror.
  expect(await answer({ partner: "someone" })).toEqual({ ok: false, reason: "Invitation not found or has already been processed" });
  // A player of the host's own node cannot be spoken for, even when a mirror of the same id is still held.
  expect(await answer({ partnerId: "1", partner: "alice" })).toEqual({ ok: false, reason: "Invitation not found or has already been processed" });
  a.mirrors.set("1", mirrorOf(alice, "b"));
  expect(await answer({ partnerId: "1", partner: "alice" })).toEqual({ ok: false, reason: "Invitation not found or has already been processed" });
  a.mirrors.delete("1");
  // None of them spent the invitation or opened a trade.
  expect(alice.invitations.length).toBe(1);
  expect(trades.of("alice")).toBeNull();
  expect(a.link.partnerPeer("bob")).toBeNull();
  expect(a.link.partnerPeer("mallory")).toBeNull();

  // The right node, a wrong authorization or asker.
  expect(await answer({ authorization: "guess" })).toEqual({ ok: false, reason: "Invitation not found or has already been processed" });
  expect((await answer({ asker: "carol" })).reason).toBe("Unable to process invitation - user not found or has disconnected");
  expect(alice.invitations.length).toBe(1);
});

test("an invitation sent to one player is spent, and opens nothing, when another answers it", async () => {
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, invitation] = a.invitations[0];
  const eve = person("5", "eve", 140);
  a.mirrors.set("5", mirrorOf(eve, "b"));
  const reply = await a.helpers.answerTradeHere({ asker: "alice", askerId: "1", authorization: invitation.authorization, partner: "eve", partnerId: "5", accepted: true }, "b");
  expect(reply).toEqual({ ok: true });
  expect(trades.of("alice")).toBeNull();
  expect(alice.invitations).toEqual([]);
  expect(a.link.partnerPeer("eve")).toBeNull();
});

test("a trade is not opened once the two may no longer trade, or one of them trades", async () => {
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, invitation] = a.invitations[0];
  a.mirrors.get("2").location.position.x = 5000;
  await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", invitation.authorization, "ACCEPT");
  await settle();
  expect(noticesOf(bob)).toEqual(["Alice is too far away to trade."]);
  expect(trades.of("alice")).toBeNull();
  expect(b.link.hostOf("bob")).toBeNull();
  expect(a.link.partnerPeer("bob")).toBeNull();

  // The asker began another trade meanwhile: the host knows, the answering node cannot.
  a.mirrors.get("2").location.position.x = 150;
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, second] = a.invitations[1];
  const carol = person("3", "carol", 110);
  a.players.set("3", carol);
  trades.open(alice, carol);
  await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", second.authorization, "ACCEPT");
  await settle();
  expect(noticesOf(bob).at(-1)).toBe("Alice is already trading.");
  expect(trades.of("bob")).toBeNull();
  expect(b.link.hostOf("bob")).toBeNull();
});

test("the answering node refuses before asking when its player is locked out of trades or already trading", async () => {
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, invitation] = a.invitations[0];
  let asked = 0;
  const spy = spyOn(b.link, "sendAnswer").mockImplementation((async () => { asked++; return { ok: true }; }) as any);
  restores.push(() => spy.mockRestore());

  b.subscription = "Upgrade to trade.";
  await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", invitation.authorization, "ACCEPT");
  expect(noticesOf(bob)).toEqual(["Upgrade to trade."]);
  b.subscription = null;

  // A trade held on this node.
  b.holds.set("bob", { players: ["bob", "carol"] });
  await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", invitation.authorization, "ACCEPT");
  expect(noticesOf(bob).at(-1)).toBe("You are already trading.");
  b.holds.clear();
  // A trade held elsewhere for the player.
  b.link.setHost("bob", "a");
  await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", invitation.authorization, "ACCEPT");
  expect(noticesOf(bob).length).toBe(3);
  expect(noticesOf(bob).at(-1)).toBe("You are already trading.");
  expect(asked).toBe(0);

  // A decline needs neither check.
  b.subscription = "Upgrade to trade.";
  await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", invitation.authorization, "DECLINE");
  expect(asked).toBe(1);
});

test("an asker nobody mirrors is not answered across", async () => {
  expect(await b.helpers.answerTradeIfAcross(bob.wt, bob, "77", "x", "ACCEPT")).toBe(false);
  // A player of this node is not an asker across.
  expect(await b.helpers.answerTradeIfAcross(bob.wt, bob, "2", "x", "ACCEPT")).toBe(false);
  // The asker's mirror has no owner on record.
  b.mirrors.get("1").mirrorFrom = undefined;
  await b.helpers.answerTradeAcross(bob.wt, bob, b.mirrors.get("1"), "x", true);
  expect(noticesOf(bob)).toEqual(["Unable to process invitation - user not found or has disconnected"]);
});

test("a host that does not answer, or refuses, is told to the one who answered, who holds no trade", async () => {
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, invitation] = a.invitations[0];
  fakeLinks.b.up = false;
  await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", invitation.authorization, "ACCEPT");
  expect(noticesOf(bob)).toEqual(["Unable to process invitation - user not found or has disconnected"]);
  expect(b.helpers.isTrading("bob")).toBe(false);

  fakeLinks.b.up = true;
  fakeLinks.a.up = true;
  await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", "wrong", "ACCEPT");
  expect(noticesOf(bob).at(-1)).toBe("Invitation not found or has already been processed");
  expect(b.link.hostOf("bob")).toBeNull();
});

test("two answers at once open one trade: the second finds the player trading", async () => {
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, invitation] = a.invitations[0];
  const first = b.helpers.answerTradeIfAcross(bob.wt, bob, "1", invitation.authorization, "ACCEPT");
  // Asked before the first has an answer: the host is already held for Bob.
  const second = b.helpers.answerTradeIfAcross(bob.wt, bob, "1", invitation.authorization, "ACCEPT");
  await Promise.all([first, second]);
  await settle();
  expect(noticesOf(bob)).toEqual(["You are already trading."]);
  expect(trades.of("alice")?.players).toEqual(["alice", "bob"]);
});

// ------------------------------------------------------------- the open trade

test("offers, accepts and the swap run on the host for a player of the neighbouring node", async () => {
  await openAcross();
  const spies = [
    spyOn(currency, "get").mockResolvedValue({ copper: 100, silver: 0, gold: 0 } as any),
    spyOn(inventory, "find").mockImplementation((async (username: string) => (username === "bob" ? [{ quantity: 4, equipped: 0 }] : [])) as any),
  ];
  restores.push(...spies.map((s) => () => s.mockRestore()));

  await b.helpers.tradeAction(bob.wt, bob, "offer", { items: [], coins: { copper: 5 } });
  await settle();
  expect(trades.of("alice")?.offers.bob.coins).toMatchObject({ copper: 5 });
  // Both windows show it: Bob's as his own side.
  expect(lastOf(alice, "TRADE_STATE")).toMatchObject({ theirs: { coins: { copper: 5 } } });
  expect(lastOf(bob, "TRADE_STATE")).toMatchObject({ mine: { coins: { copper: 5 } }, accepted: { mine: false, theirs: false } });

  // Accepting at once is told to wait, and Bob is told.
  await b.helpers.tradeAction(bob.wt, bob, "accept");
  await settle();
  expect(noticesOf(bob).at(-1)).toBe("The offer just changed. Look it over, then accept.");

  ripen();
  await b.helpers.tradeAction(bob.wt, bob, "accept");
  await settle();
  expect(lastOf(alice, "TRADE_STATE")).toMatchObject({ accepted: { mine: false, theirs: true } });
  expect(lastOf(bob, "TRADE_STATE")).toMatchObject({ accepted: { mine: true, theirs: false } });
});

test("an offer that changes nothing puts back the window of the one who made it, and of nobody else", async () => {
  await openAcross();
  const spy = spyOn(currency, "get").mockResolvedValue({ copper: 100, silver: 0, gold: 0 } as any);
  restores.push(() => spy.mockRestore());
  await b.helpers.tradeAction(bob.wt, bob, "offer", { items: [], coins: { copper: 5 } });
  await settle();
  const bobSaw = sentTo(bob, "TRADE_STATE").length;
  const aliceSaw = sentTo(alice, "TRADE_STATE").length;
  await b.helpers.tradeAction(bob.wt, bob, "offer", { items: [], coins: { copper: 5 } });
  await settle();
  expect(sentTo(bob, "TRADE_STATE").length).toBe(bobSaw + 1);
  expect(sentTo(alice, "TRADE_STATE").length).toBe(aliceSaw);

  // The same for the host's own player.
  await a.helpers.tradeAction(alice.wt, alice, "offer", { items: [], coins: {} });
  expect(sentTo(alice, "TRADE_STATE").length).toBe(aliceSaw + 1);
  expect(sentTo(bob, "TRADE_STATE").length).toBe(bobSaw + 1);
});

test("an offer of what the player does not hold is refused by the node that holds the trade, against the database", async () => {
  await openAcross();
  const spies = [
    spyOn(currency, "get").mockResolvedValue({ copper: 0, silver: 0, gold: 0 } as any),
    spyOn(inventory, "find").mockImplementation((async () => []) as any),
  ];
  restores.push(...spies.map((s) => () => s.mockRestore()));

  const shown = sentTo(bob, "TRADE_STATE").length;
  await b.helpers.tradeAction(bob.wt, bob, "offer", { items: [{ name: "Iron Ore", quantity: 3 }], coins: {} });
  await settle();
  expect(noticesOf(bob).at(-1)).toBe("You do not have 3 Iron Ore.");
  expect(trades.of("alice")?.offers.bob.items).toEqual([]);
  // His window is put back as it stood: sent to him again, and to nobody else.
  expect(sentTo(bob, "TRADE_STATE").length).toBe(shown + 1);
  expect(lastOf(bob, "TRADE_STATE")).toMatchObject({ mine: { items: [] } });

  // Coins he lacks are refused too.
  await b.helpers.tradeAction(bob.wt, bob, "offer", { items: [], coins: { gold: 5 } });
  expect(noticesOf(bob).at(-1)).toBe("You do not have that many coins.");
});

test("a node speaks only for the player it holds a trade for: an update for another is refused", async () => {
  await openAcross();
  ripen();
  // Node b is the partner's node of Bob only. It cannot accept, cancel or offer for the host's own player,
  // and cannot name a player who is not trading here.
  for (const username of ["alice", "ALICE", "carol"]) {
    for (const op of ["accept", "cancel", "leave", "offer"]) {
      const sent = await b.calls.call("a", "TP_UPDATE", { username, op, offer: { items: [], coins: {} } });
      expect(sent).toEqual({ ok: true, answer: { ok: false, gone: true, reason: "You are not trading." } });
    }
  }
  expect(trades.of("alice")?.accepted).toEqual({ alice: false, bob: false });
  expect(a.link.partnerPeer("bob")).toBe("b");

  // The player it does hold the trade for is taken, and an action the trade does not have is refused.
  const stamp = (b.link as any).hosts.get("bob").stamp;
  // An update that carries another trade's stamp is refused too.
  expect(await b.calls.call("a", "TP_UPDATE", { username: "bob", op: "cancel", stamp: "old" })).toEqual({ ok: true, answer: { ok: false, gone: true, reason: "You are not trading." } });
  expect(trades.of("alice")).not.toBeNull();
  const unknown = await b.calls.call("a", "TP_UPDATE", { username: "bob", op: "explode", stamp });
  expect(unknown).toEqual({ ok: true, answer: { ok: false, reason: "That is not a trade action." } });
  expect(trades.of("alice")?.accepted).toEqual({ alice: false, bob: false });
  expect(warned.filter((line) => line.includes("refused")).length).toBe(13);
});

test("a cancel by the player of the neighbouring node ends the trade for both, and frees them", async () => {
  await openAcross();
  await b.helpers.tradeAction(bob.wt, bob, "cancel");
  await settle();
  expect(trades.of("alice")).toBeNull();
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: false, message: "Bob cancelled the trade." });
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: "You cancelled the trade." });
  expect(a.link.partnerPeer("bob")).toBeNull();
  expect(b.link.hostOf("bob")).toBeNull();
  expect(b.helpers.isTrading("bob")).toBe(false);
  // Nothing changed hands: nobody's bags are read again.
  expect(a.belongings).toEqual([]);
  expect(b.belongings).toEqual([]);
});

test("a cancel by the host's player closes the window of the player of the neighbouring node", async () => {
  await openAcross();
  await a.helpers.tradeAction(alice.wt, alice, "cancel");
  await settle();
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: false, message: "You cancelled the trade." });
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: "Alice cancelled the trade." });
  expect(b.link.hostOf("bob")).toBeNull();
  expect(a.link.partnerPeer("bob")).toBeNull();
});

test("a swap reloads the bags and coins of the host's player there and of the other player on their own node", async () => {
  await openAcross();
  const trade = trades.of("alice")!;
  // The swap itself is the trade system's (player-trading.test.ts): here it is made to end with a record.
  const record = { id: 7, player_a: "alice", player_b: "bob" };
  const found: string[] = [];
  const accept = spyOn(trades, "accept").mockImplementation((async (username: string, find: any) => {
    for (const name of ["alice", "bob"]) found.push(find(name)?.username);
    trades.cancel(username);
    return { state: "completed", trade, record };
  }) as any);
  restores.push(() => accept.mockRestore());

  await b.helpers.tradeAction(bob.wt, bob, "accept");
  await settle();
  // The host finds both players: Bob through his mirror.
  expect(found).toEqual(["alice", "bob"]);
  expect(a.belongings).toEqual(["alice"]);
  expect(b.belongings).toEqual(["bob"]);
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: true, message: "Trade complete." });
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: true, message: "Trade complete." });
  expect(a.emitted).toEqual([["TRADE_COMPLETED", { trade: record }]]);
  expect(b.link.hostOf("bob")).toBeNull();
  expect(a.link.partnerPeer("bob")).toBeNull();
});

test("a trade that moved nothing does not read the bags again", async () => {
  await openAcross();
  ripen();
  await a.helpers.tradeAction(alice.wt, alice, "accept");
  await b.helpers.tradeAction(bob.wt, bob, "accept");
  await settle();
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: "Nothing was traded." });
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: false, message: "Nothing was traded." });
  expect(a.belongings).toEqual([]);
  expect(b.belongings).toEqual([]);
  expect(a.emitted).toEqual([]);
});

test("a window closes even when the bags could not be read again after a swap", async () => {
  await openAcross();
  b.failBelongings = true;
  await b.helpers.closeTradeFromHost({ username: "bob", completed: true, message: "Trade complete.", reload: true });
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: true, message: "Trade complete." });
  expect(errored.some((line) => line.includes("bob"))).toBe(true);
  // A player who is gone is not sent to.
  b.players.clear();
  await b.helpers.closeTradeFromHost({ username: "bob", completed: true, message: "x", reload: true });
});

test("a failed swap closes both windows with the reasons and moves nothing", async () => {
  await openAcross();
  const trade = trades.of("alice")!;
  const accept = spyOn(trades, "accept").mockImplementation((async () => {
    trades.cancel("alice");
    return { state: "failed", trade, reasons: { alice: "Bob no longer has 1 Iron Ore. Nothing was traded.", bob: "Bob no longer has 1 Iron Ore. Nothing was traded." } };
  }) as any);
  restores.push(() => accept.mockRestore());
  await a.helpers.tradeAction(alice.wt, alice, "accept");
  await settle();
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: "Bob no longer has 1 Iron Ore. Nothing was traded." });
  expect(a.belongings).toEqual([]);
  expect(b.belongings).toEqual([]);
  expect(b.link.hostOf("bob")).toBeNull();
});

test("a player who leaves lets go of the host at once and ends the trade there", async () => {
  await openAcross();
  b.helpers.endTradeOfLeaver({ player: bob });
  expect(b.link.hostOf("bob")).toBeNull();
  await settle();
  expect(trades.of("alice")).toBeNull();
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: false, message: "Bob is no longer online." });
  expect(a.link.partnerPeer("bob")).toBeNull();
});

test("the host's player leaving ends the trade for the player of the neighbouring node", async () => {
  await openAcross();
  a.helpers.endTradeOfLeaver({ player: alice });
  await settle();
  expect(trades.of("alice")).toBeNull();
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: "Alice is no longer online." });
  expect(b.link.hostOf("bob")).toBeNull();
  // A leaver with no name, or no trade, ends nothing.
  a.helpers.endTradeOfLeaver({});
  a.helpers.endTradeOfLeaver({ player: bob });
});

test("a host that cannot be reached closes the window of the player who acts, and is let go", async () => {
  await openAcross();
  fakeLinks.b.up = false;
  await b.helpers.tradeAction(bob.wt, bob, "accept");
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: TRADE_UNREACHABLE });
  expect(b.link.hostOf("bob")).toBeNull();
  expect(b.helpers.isTrading("bob")).toBe(false);
  expect(warned.some((line) => line.includes("bob") && line.includes("accept"))).toBe(true);
  // With no host left, the next TRADE_ACCEPT is handled here, and finds no trade.
  fakeLinks.b.up = true;
  await b.helpers.tradeAction(bob.wt, bob, "cancel");
});

test("a host that holds no trade of theirs tells them so", async () => {
  await openAcross();
  trades.cancel("alice");
  a.link.dropPartner("bob");
  await b.helpers.tradeAction(bob.wt, bob, "offer", { items: [], coins: {} });
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: "You are not trading." });
  expect(b.link.hostOf("bob")).toBeNull();
});

test("the host finds the player of the neighbouring node by their mirror only while they are its partner", async () => {
  expect(a.helpers.traderNamed("alice")).toBe(alice);
  expect(a.helpers.traderNamed("bob")).toBeUndefined();
  a.link.setPartner("bob", "b");
  expect(a.helpers.traderNamed("Bob")?.remote).toBe(true);
  a.mirrors.clear();
  expect(a.helpers.traderNamed("bob")).toBeUndefined();
});

test("a mirror that left the border ends the trade: both are told the other is no longer online", async () => {
  await openAcross();
  a.mirrors.delete("2");
  const ended = trades.sweep(a.helpers.traderNamed);
  expect(ended.length).toBe(1);
  for (const { trade, reasons } of ended) a.helpers.sendTradeClosed(trade, false, reasons);
  await settle();
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: false, message: "Bob is no longer online." });
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: "Bob is no longer online." });
  expect(b.link.hostOf("bob")).toBeNull();
  expect(a.link.partnerPeer("bob")).toBeNull();
});

test("a trade window that cannot be sent to the other node is logged", async () => {
  await openAcross();
  fakeLinks.a.up = false;
  const trade = trades.of("alice")!;
  await a.helpers.sendTradeState(trade);
  expect(warned.some((line) => line.includes("bob") && line.includes("trade window"))).toBe(true);
});

// ---------------------------------------------------------------- busy players

test("a trade held elsewhere keeps the player from other trades and from vendors", async () => {
  await openAcross();
  expect(b.helpers.busyRefusal(bob, alice)).toBe("You are already trading.");
  expect(b.helpers.busyRefusal(alice, bob)).toBe("Bob is already trading.");
  expect(b.helpers.tradeRefusal(bob, person("8", "frank", 150))).toBe("You are already trading.");
  await b.helpers.vendorFor(bob.wt, bob, 5);
  expect(sentTo(bob, "VENDOR_CLOSED")).toEqual([{ message: "You cannot use a vendor while trading." }]);
  // Neither trading: free.
  expect(b.helpers.busyRefusal(person("8", "frank", 1), person("9", "gina", 1))).toBeNull();
});

test("a trade that ends frees every player as a partner, even one who is also online here", async () => {
  const carol = person("3", "carol", 110);
  a.players.set("3", carol);
  trades.open(alice, carol);
  // Carol was a partner from a neighbouring node, and is now logged in here.
  a.link.setPartner("carol", "b");
  a.helpers.cancelTrade("alice");
  expect(a.link.partnerPeer("carol")).toBeNull();
  expect(fakeLinks.a.sent).toEqual([]);
});

test("a trade held here is a trade, as before", async () => {
  const carol = person("3", "carol", 100);
  a.players.set("3", carol);
  expect(a.helpers.isTrading("alice")).toBe(false);
  trades.open(alice, carol);
  expect(a.helpers.isTrading("alice")).toBe(true);
  expect(a.helpers.isTrading("carol")).toBe(true);
  expect(a.helpers.busyRefusal(alice, person("9", "gina", 1))).toBe("You are already trading.");
});

test("between two players of one node nothing is sent across, and the messages are as before", async () => {
  const carol = person("3", "carol", 110);
  a.players.set("3", carol);
  trades.open(alice, carol);
  await a.helpers.sendTradeState(trades.of("alice")!);
  expect(lastOf(alice, "TRADE_STATE")).toMatchObject({ partner: "carol" });
  expect(lastOf(carol, "TRADE_STATE")).toMatchObject({ partner: "alice" });
  expect(fakeLinks.a.sent).toEqual([]);

  await a.helpers.tradeAction(carol.wt, carol, "cancel");
  expect(lastOf(carol, "TRADE_CLOSED")).toEqual({ completed: false, message: "You cancelled the trade." });
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: false, message: "Carol cancelled the trade." });
  expect(fakeLinks.a.sent).toEqual([]);
});

test("the receiver registers the trade handlers on the link, and they are the helpers read here", async () => {
  // The handlers the node hands the link are the ones cut out of the receiver: an answer reaches answerTradeHere.
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, invitation] = a.invitations[0];
  const outcome = await b.link.sendAnswer("a", { asker: "alice", askerId: "1", authorization: invitation.authorization, partner: "bob", partnerId: "2", accepted: true });
  expect(outcome).toEqual({ ok: true, opened: true });
});

// ------------------------------------------------- the guards, case by case

const caseBlock = (name: string): string => {
  const start = only(new RegExp(`^      case "${name}": \\{`), `case ${name}`);
  const next = receiverSource.indexOf("\n      case \"", start + 1);
  return receiverSource.slice(start, next);
};

test("the packets that change a player's belongings stop for a trade held on another node as for one held here", () => {
  for (const name of ["USE_ITEM", "EQUIP_ITEM", "BAG_EQUIP", "MAIL_SEND"]) {
    const block = caseBlock(name);
    expect(block).toContain("isTrading(currentPlayer.username)");
    expect(block).not.toContain("trades.of(");
  }
});

test("the trade packets go through the helpers that relay a trade held elsewhere", () => {
  expect(caseBlock("TRADE_OFFER")).toContain('tradeAction(wt, currentPlayer, "offer", data)');
  expect(caseBlock("TRADE_ACCEPT")).toContain('tradeAction(wt, currentPlayer, "accept")');
  expect(caseBlock("TRADE_CANCEL")).toContain('tradeAction(wt, currentPlayer, "cancel")');
  expect(caseBlock("TRADE_REQUEST")).toContain("requestTrade(wt, currentPlayer,");
});

test("an invitation response whose asker is on another node is answered across, and only then does the branch end", () => {
  const block = caseBlock("INVITATION_RESPONSE");
  const branchStart = block.indexOf('if (action.toUpperCase() === "TRADE_REQUEST") {');
  expect(branchStart).toBeGreaterThan(0);
  const missing = block.indexOf("if (!inviter) {", branchStart);
  const call = "if (await answerTradeIfAcross(wt, currentPlayer, originator, authorization, response)) break;";
  const at = block.indexOf(call, branchStart);
  const gone = block.indexOf("inviterGone();", branchStart);
  // The branch asks the cached asker first; with none, it answers across and ends, else the asker is said to be gone.
  expect(block.indexOf("playerCache.get(originator)", branchStart)).toBeGreaterThan(branchStart);
  expect(missing).toBeGreaterThan(branchStart);
  expect(at).toBeGreaterThan(missing);
  expect(gone).toBeGreaterThan(at);
  expect(block.slice(missing, gone)).toContain(call);
});

// ------------------------------------------------------------ fix round 1

test("declining a second invitation from the host leaves the trade the player has with it open", async () => {
  // Alice and Dave, both on node a, ask Bob before either trade is open.
  const dave = person("6", "dave", 100);
  a.players.set("6", dave);
  b.mirrors.set("6", mirrorOf(dave, "a"));
  await a.helpers.requestTrade(alice.wt, alice, "2");
  await a.helpers.requestTrade(dave.wt, dave, "2");
  const [[, forAlice], [, forDave]] = a.invitations;
  await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", forAlice.authorization, "ACCEPT");
  await settle();
  expect(trades.of("alice")?.players).toEqual(["alice", "bob"]);

  await b.helpers.answerTradeIfAcross(bob.wt, bob, "6", forDave.authorization, "DECLINE");
  await settle();
  expect(noticesOf(dave).at(-1)).toBe("Bob declined your trade request");
  // Bob is still trading with Alice: on his node, and in what he can do.
  expect(b.link.hostOf("bob")).toBe("a");
  expect(b.helpers.isTrading("bob")).toBe(true);
  await b.helpers.tradeAction(bob.wt, bob, "cancel");
  await settle();
  expect(trades.of("alice")).toBeNull();
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: false, message: "Bob cancelled the trade." });
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: "You cancelled the trade." });
});

test("a refused second answer from the host leaves the trade open as well", async () => {
  const dave = person("6", "dave", 100);
  a.players.set("6", dave);
  await a.helpers.requestTrade(alice.wt, alice, "2");
  await a.helpers.requestTrade(dave.wt, dave, "2");
  const [[, forAlice], [, forDave]] = a.invitations;
  await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", forAlice.authorization, "ACCEPT");
  // The answering node refuses a second accept before asking; asking the link directly is refused by the host.
  const direct = await b.link.sendAnswer("a", { asker: "dave", askerId: "6", authorization: forDave.authorization, partner: "bob", partnerId: "2", accepted: true });
  expect(direct.ok).toBe(false);
  expect(b.link.hostOf("bob")).toBe("a");
  expect(trades.of("alice")?.players).toEqual(["alice", "bob"]);
});

test("a host that stalls past the timeout after a swap: the player's bags are read again and no trade is left open", async () => {
  await openAcross();
  const trade = trades.of("alice")!;
  const record = { id: 7, player_a: "alice", player_b: "bob" };
  const accept = spyOn(trades, "accept").mockImplementation((async (username: string) => {
    trades.cancel(username);
    return { state: "completed", trade, record };
  }) as any);
  restores.push(() => accept.mockRestore());
  // After the swap the host reads its own player's bags, slowly: Bob's call times out first.
  a.delay = 500;

  await b.helpers.tradeAction(bob.wt, bob, "accept");
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: TRADE_UNREACHABLE });
  expect(b.belongings).toEqual(["bob"]);
  expect(b.link.hostOf("bob")).toBeNull();
  expect(warned.some((line) => line.includes("bob") && line.includes("timeout"))).toBe(true);
  // The host finishes, and its end for Bob is dropped here: it is dropped with a log, not lost silently.
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(trades.of("alice")).toBeNull();
  expect(a.link.partnerPeer("bob")).toBeNull();
  expect(a.belongings).toEqual(["alice"]);
  expect(infos.some((line) => line.includes("bob") && line.includes("dropped"))).toBe(true);
});

test("a lost cancel of a player who had accepted still ends the trade on the host", async () => {
  await openAcross();
  ripen();
  await b.helpers.tradeAction(bob.wt, bob, "accept");
  await settle();
  expect(trades.of("alice")?.accepted.bob).toBe(true);

  // Bob's cancel is lost on the link; the one sent after it arrives.
  fakeLinks.b.blackhole = true;
  const cancelling = b.helpers.tradeAction(bob.wt, bob, "cancel");
  fakeLinks.b.blackhole = false;
  await cancelling;
  await settle();
  expect(trades.of("alice")).toBeNull();
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: false, message: "Bob cancelled the trade." });
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: TRADE_UNREACHABLE });
  expect(b.helpers.isTrading("bob")).toBe(false);
  expect(a.link.partnerPeer("bob")).toBeNull();
  // Alice cannot go on to swap with Bob's accept.
  expect(await a.helpers.tradeAction(alice.wt, alice, "accept")).toBeUndefined();
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: false, message: "Bob cancelled the trade." });
});

test("a host that holds no trade of theirs reloads their bags as well", async () => {
  await openAcross();
  trades.cancel("alice");
  a.link.dropPartner("bob");
  await b.helpers.tradeAction(bob.wt, bob, "accept");
  expect(b.belongings).toEqual(["bob"]);
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: "You are not trading." });
  // A reload that fails still closes the window, and is logged. The gone reply marked Bob unsettled
  // (cluster/tradesettle.ts), which refuses a new trade until the mark runs out: it is ended here, as if it had.
  tradeSettle.reset({ ms: 60_000, drop: async () => {} });
  await openAcrossAgain();
  trades.cancel("alice");
  a.link.dropPartner("bob");
  b.failBelongings = true;
  await b.helpers.tradeAction(bob.wt, bob, "accept");
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: "You are not trading." });
  expect(errored.some((line) => line.includes("bob"))).toBe(true);
});

/** A second trade between the same two, once the first is over. */
async function openAcrossAgain(): Promise<void> {
  alice.invitations = [];
  a.invitations.length = 0;
  await openAcross();
}

test("a failure on the host while it handles an update is logged and answered", async () => {
  await openAcross();
  const offer = spyOn(trades, "offer").mockImplementation((async () => { throw new Error("database gone"); }) as any);
  restores.push(() => offer.mockRestore());
  await b.helpers.tradeAction(bob.wt, bob, "offer", { items: [], coins: {} });
  await settle();
  expect(errored.some((line) => line.includes("bob") && line.includes("offer") && line.includes("database gone"))).toBe(true);
  expect(noticesOf(bob).at(-1)).toBe("The trade could not be completed.");
  // His trade is still held, and he is not told it ended.
  expect(b.link.hostOf("bob")).toBe("a");
  expect(trades.of("alice")).not.toBeNull();
});

test("a swap whose bags cannot be read again still closes both windows and tells the event", async () => {
  await openAcross();
  const trade = trades.of("alice")!;
  const record = { id: 7, player_a: "alice", player_b: "bob" };
  const accept = spyOn(trades, "accept").mockImplementation((async (username: string) => {
    trades.cancel(username);
    return { state: "completed", trade, record };
  }) as any);
  restores.push(() => accept.mockRestore());
  a.failBelongings = true;

  await b.helpers.tradeAction(bob.wt, bob, "accept");
  await settle();
  expect(errored.some((line) => line.includes("alice") && line.includes("bob") && line.includes("database gone"))).toBe(true);
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: true, message: "Trade complete." });
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: true, message: "Trade complete." });
  expect(b.belongings).toEqual(["bob"]);
  expect(a.emitted).toEqual([["TRADE_COMPLETED", { trade: record }]]);
  expect(a.link.partnerPeer("bob")).toBeNull();
  expect(b.link.hostOf("bob")).toBeNull();
});

test("an answer is not taken for a player who is also a player of the host's node", async () => {
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, invitation] = a.invitations[0];
  // A session of Bob's is still held here (it is saving) while his mirror, under another id, is asked.
  const stale = person("20", "bob", 150);
  a.players.set("20", stale);
  const reply = await a.helpers.answerTradeHere({ asker: "alice", askerId: "1", authorization: invitation.authorization, partner: "bob", partnerId: "2", accepted: true, stamp: "s" }, "b");
  expect(reply).toEqual({ ok: false, reason: "Invitation not found or has already been processed" });
  expect(trades.of("alice")).toBeNull();
  expect(a.link.partnerPeer("bob")).toBeNull();
  expect(alice.invitations.length).toBe(1);
});

test("the stamp of an answer is the stamp the host sends with the trade's window and end", async () => {
  await openAcross();
  const stamp = (b.link as any).hosts.get("bob").stamp;
  expect(typeof stamp).toBe("string");
  expect(stamp.length).toBeGreaterThan(0);
  // Nothing a trade of the same two nodes held earlier can send is taken now.
  a.link.setPartner("bob", "b", "an-earlier-trade");
  await a.helpers.sendTradeState(trades.of("alice")!);
  await settle();
  const shown = sentTo(bob, "TRADE_STATE").length;
  a.link.setPartner("bob", "b", "an-earlier-trade");
  a.helpers.sendTradeClosed(trades.of("alice")!, false, { alice: "x", bob: "late" });
  await settle();
  expect(sentTo(bob, "TRADE_STATE").length).toBe(shown);
  expect(sentTo(bob, "TRADE_CLOSED")).toEqual([]);
  expect(b.link.hostOf("bob")).toBe("a");
});

test("answers across are rate limited before they become a call to the other node", async () => {
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, invitation] = a.invitations[0];
  let asked = 0;
  const spy = spyOn(b.link, "sendAnswer").mockImplementation((async () => { asked++; return { ok: true }; }) as any);
  restores.push(() => spy.mockRestore());

  b.limited = true;
  expect(await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", invitation.authorization, "ACCEPT")).toBe(true);
  expect(asked).toBe(0);
  // Dropped, as the other limited packets are: nothing is said.
  expect(noticesOf(bob)).toEqual([]);
  b.limited = false;
  expect(await b.helpers.answerTradeIfAcross(bob.wt, bob, "1", invitation.authorization, "ACCEPT")).toBe(true);
  expect(asked).toBe(1);
  // An asker that is not across is not counted against the limit.
  b.limited = true;
  expect(await b.helpers.answerTradeIfAcross(bob.wt, bob, "77", "x", "ACCEPT")).toBe(false);
});

// ------------------------------------------------------------ fix round 2

/** A host whose accept stays settling until `release` is called, and then commits: the swap of a slow database. */
function slowSwap() {
  const trade = trades.of("alice")!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const record = { id: 7, player_a: "alice", player_b: "bob" };
  const accept = spyOn(trades, "accept").mockImplementation((async (username: string) => {
    trade.settling = true;
    await gate;
    order.push("commit");
    trade.settling = false;
    trades.cancel(username);
    return { state: "completed", trade, record };
  }) as any);
  restores.push(() => accept.mockRestore());
  return { trade, release };
}

/** A host whose update handler answers "settling" to a cancel, and stalls on anything else past the timeout. */
function settlingHost(): TradeHandlers & { seen: Seen } {
  const handlers = recorder();
  handlers.update = async (body, from) => {
    handlers.seen.updates.push([body, from]);
    if (body.op === "cancel") return { ok: false, settling: true };
    await sleep(700);
    return { ok: true };
  };
  return handlers;
}

test("a host that is swapping answers a cancel with settling, and does not cancel", async () => {
  await openAcross();
  const { trade, release } = slowSwap();
  ripen();
  const accepting = b.helpers.tradeAction(bob.wt, bob, "accept");
  await sleep(50);
  expect(trade.settling).toBe(true);
  const sent = await b.calls.call("a", "TP_UPDATE", { username: "bob", op: "cancel", stamp: (b.link as any).hosts.get("bob").stamp });
  expect(sent).toEqual({ ok: true, answer: { ok: false, settling: true } });
  expect(trades.of("alice")).toBe(trade);
  expect(sentTo(alice, "TRADE_CLOSED")).toEqual([]);
  // A cancel of a trade that is not being swapped is answered as before.
  release();
  await accepting;
  await settle();
});

test("a player's cancel during the swap is not told anything and keeps the host", async () => {
  await openAcross();
  const { release } = slowSwap();
  ripen();
  const accepting = b.helpers.tradeAction(bob.wt, bob, "accept");
  await sleep(50);
  await b.helpers.tradeAction(bob.wt, bob, "cancel");
  expect(b.link.hostOf("bob")).toBe("a");
  expect(sentTo(bob, "TRADE_CLOSED")).toEqual([]);
  expect(noticesOf(bob)).toEqual([]);
  release();
  await accepting;
  await settle();
});

test("a swap that ends within the wait: the player is shown its own end, and the bags are read once, after the commit", async () => {
  await openAcross();
  const { release } = slowSwap();
  (b.link as any).settleWaitMs = 3000;
  ripen();
  const accepting = b.helpers.tradeAction(bob.wt, bob, "accept");
  // Past the call's timeout (200 ms): the cancel after it was answered "settling", and nothing is shown yet.
  await sleep(400);
  expect(b.link.hostOf("bob")).toBe("a");
  expect(b.belongings).toEqual([]);
  expect(sentTo(bob, "TRADE_CLOSED")).toEqual([]);

  release();
  await accepting;
  await settle();
  expect(order).toEqual(["commit", "reload alice", "reload bob"]);
  expect(sentTo(bob, "TRADE_CLOSED")).toEqual([{ completed: true, message: "Trade complete." }]);
  expect(b.belongings).toEqual(["bob"]);
  expect(b.link.hostOf("bob")).toBeNull();
  // The words about his bags are not sent: they were read again when the end came.
  expect(sentTo(bob, "TRADE_CLOSED").some((closed: any) => closed.message === TRADE_UNREACHABLE)).toBe(false);
  expect(warned.some((line) => line.includes("did not arrive"))).toBe(false);
});

test("a swap that outlasts the wait: the bags are read again once it has run out, and the log names the player", async () => {
  await openAcross();
  const { release } = slowSwap();
  ripen();
  const accepting = b.helpers.tradeAction(bob.wt, bob, "accept");
  // The call times out at 200 ms and the wait runs to 600 ms: at 450 ms nothing has been read or said.
  await sleep(450);
  expect(b.belongings).toEqual([]);
  expect(sentTo(bob, "TRADE_CLOSED")).toEqual([]);
  expect(b.link.hostOf("bob")).toBe("a");

  await accepting;
  expect(order).toEqual(["reload bob"]);
  expect(sentTo(bob, "TRADE_CLOSED")).toEqual([{ completed: false, message: TRADE_UNREACHABLE }]);
  expect(b.link.hostOf("bob")).toBeNull();
  expect(warned.some((line) => line.includes("bob") && line.includes("did not arrive"))).toBe(true);

  // The swap commits later: its end finds no host here, and is dropped with a log.
  release();
  await sleep(60);
  expect(order).toEqual(["reload bob", "commit", "reload alice"]);
  expect(infos.some((line) => line.includes("bob") && line.includes("dropped"))).toBe(true);
});

test("a lost update followed by a cancel the host answers normally lets go at once, as before", async () => {
  await openAcross();
  const started = Date.now();
  fakeLinks.b.blackhole = true;
  const cancelling = b.helpers.tradeAction(bob.wt, bob, "offer", { items: [], coins: {} });
  fakeLinks.b.blackhole = false;
  await cancelling;
  expect(Date.now() - started).toBeLessThan(380);
  expect(sentTo(bob, "TRADE_CLOSED").at(-1)).toEqual({ completed: false, message: TRADE_UNREACHABLE });
  expect(order).toContain("reload bob");
});

test("the link: a settling answer keeps the host, and the end of the trade within the wait releases the update", async () => {
  const { host, partner } = pair(3000);
  const hostSide = settlingHost();
  const closed = recorder();
  host.setHandlers(hostSide);
  partner.setHandlers(closed);
  await partner.sendAnswer("a", bobAnswers());
  const stamp = stampOf(hostSide);
  host.setPartner("bob", "b", stamp);

  let result: unknown = "pending";
  const accepting = partner.sendUpdate("bob", "accept").then((reply) => { result = reply; });
  await sleep(350);
  // The call ended timeout, the cancel was answered settling: the host is kept, and the update is not settled.
  expect(hostSide.seen.updates.map(([body]: any) => body.op)).toEqual(["accept", "cancel"]);
  expect(partner.hostOf("bob")).toBe("a");
  expect(result).toBe("pending");

  expect(host.sendClosed("bob", { completed: true, message: "Trade complete.", reload: true })).toBe(true);
  await accepting;
  expect(result).toEqual({ ok: false, gone: true, closed: true });
  expect(closed.seen.closed).toEqual([{ username: "bob", completed: true, message: "Trade complete.", reload: true, stamp }]);
  expect(partner.hostOf("bob")).toBeNull();
  expect(warned.some((line) => line.includes("did not arrive"))).toBe(false);
});

test("the link: the update is released with the unreachable answer once the wait has run out", async () => {
  const { host, partner } = pair(250);
  const hostSide = settlingHost();
  host.setHandlers(hostSide);
  await partner.sendAnswer("a", bobAnswers());
  host.setPartner("bob", "b", stampOf(hostSide));

  const started = Date.now();
  const reply = await partner.sendUpdate("bob", "accept");
  expect(reply).toEqual({ ok: false, gone: true, reason: TRADE_UNREACHABLE });
  // The call's timeout (200 ms) and then the wait (250 ms).
  expect(Date.now() - started).toBeGreaterThanOrEqual(440);
  expect(partner.hostOf("bob")).toBeNull();
  expect(warned.some((line) => line.includes("bob") && line.includes("did not arrive") && line.includes("250 ms"))).toBe(true);
});

test("the link: a host that answers the cancel with anything but settling is let go at once", async () => {
  const { host, partner } = pair(5000);
  const hostSide = recorder();
  hostSide.update = async (body, from) => {
    hostSide.seen.updates.push([body, from]);
    if (body.op === "cancel") return { ok: true };
    await sleep(700);
    return { ok: true };
  };
  host.setHandlers(hostSide);
  await partner.sendAnswer("a", bobAnswers());
  host.setPartner("bob", "b", stampOf(hostSide));
  const started = Date.now();
  expect(await partner.sendUpdate("bob", "accept")).toEqual({ ok: false, gone: true, reason: TRADE_UNREACHABLE });
  expect(Date.now() - started).toBeLessThan(600);
  expect(partner.hostOf("bob")).toBeNull();
});

test("the link: reset releases a wait for an end that would not come", async () => {
  const { host, partner } = pair(60_000);
  const hostSide = settlingHost();
  host.setHandlers(hostSide);
  await partner.sendAnswer("a", bobAnswers());
  host.setPartner("bob", "b", stampOf(hostSide));
  const accepting = partner.sendUpdate("bob", "accept");
  await sleep(350);
  partner.reset();
  expect(await accepting).toEqual({ ok: false, gone: true, reason: TRADE_UNREACHABLE });
});

test("the link: the update is released only after the end has been handled (the bags read, the window shown)", async () => {
  const { host, partner } = pair(3000);
  const hostSide = settlingHost();
  host.setHandlers(hostSide);
  let handled = false;
  partner.setHandlers({
    ...recorder(),
    closed: async () => {
      await sleep(150);
      handled = true;
    },
  });
  await partner.sendAnswer("a", bobAnswers());
  host.setPartner("bob", "b", stampOf(hostSide));
  const accepting = partner.sendUpdate("bob", "accept");
  await sleep(350);
  expect(host.sendClosed("bob", { completed: true, message: "Trade complete.", reload: true })).toBe(true);
  await sleep(40);
  expect(handled).toBe(false);
  expect(await accepting).toEqual({ ok: false, gone: true, closed: true });
  expect(handled).toBe(true);
});

test("the link: an end that came before the host's settling answer needs no wait", async () => {
  const { host, partner } = pair(3000);
  const hostSide = recorder();
  hostSide.update = async (body, from) => {
    hostSide.seen.updates.push([body, from]);
    if (body.op === "cancel") {
      // The swap is done, and its end is cast before the answer to the cancel.
      host.sendClosed("bob", { completed: true, message: "Trade complete.", reload: true });
      return { ok: false, settling: true };
    }
    await sleep(700);
    return { ok: true };
  };
  const closed = recorder();
  host.setHandlers(hostSide);
  partner.setHandlers(closed);
  await partner.sendAnswer("a", bobAnswers());
  host.setPartner("bob", "b", stampOf(hostSide));
  const started = Date.now();
  const reply = await partner.sendUpdate("bob", "accept");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(closed.seen.closed.length).toBe(1);
  expect(reply).toMatchObject({ ok: false, gone: true });
  expect(partner.hostOf("bob")).toBeNull();
  expect(warned.some((line) => line.includes("did not arrive"))).toBe(false);
});

// ------------------------------------------------- a link that goes down (phase 6)

test("a trade lost with the partner's node ends on the host and tells the host's player", async () => {
  await openAcross();
  await a.helpers.loseTrade({ role: "host", username: "bob", peer: "b" });
  expect(trades.of("alice")).toBeNull();
  expect(trades.of("bob")).toBeNull();
  expect(lastOf(alice, "TRADE_CLOSED")).toEqual({ completed: false, message: "Bob is no longer online." });
  // Nothing changed hands: the host's player's bags are not read again.
  expect(a.belongings).toEqual([]);
});

test("a trade lost while it is being swapped is left to the swap", async () => {
  await openAcross();
  trades.of("alice")!.settling = true;
  await a.helpers.loseTrade({ role: "host", username: "bob", peer: "b" });
  expect(trades.of("alice")).not.toBeNull();
  expect(sentTo(alice, "TRADE_CLOSED")).toEqual([]);
  trades.of("alice")!.settling = false;
});

test("a trade lost with the host's node closes the partner's window and reads their bags again", async () => {
  await openAcross();
  await b.helpers.loseTrade({ role: "partner", username: "bob", peer: "a" });
  expect(b.belongings).toEqual(["bob"]);
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: TRADE_UNREACHABLE });
});

test("a partner whose bags cannot be read again still has the window closed", async () => {
  await openAcross();
  b.failBelongings = true;
  await b.helpers.loseTrade({ role: "partner", username: "bob", peer: "a" });
  expect(b.belongings).toEqual([]);
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: TRADE_UNREACHABLE });
});

test("a lost trade of a player who already left does nothing", async () => {
  b.players.delete("2");
  await b.helpers.loseTrade({ role: "partner", username: "bob", peer: "a" });
  expect(b.belongings).toEqual([]);
  expect(sentTo(bob, "TRADE_CLOSED")).toEqual([]);
});

test("a partner marked unsettled by the lost link is shown their bags once more after the mark runs out", async () => {
  tradeSettle.reset({ ms: 40, drop: async () => {} });
  await openAcross();
  // As TradeLink.peerDown does it: marked first, then the handler.
  await unsettle("bob", "the link went down with their trade held there", "a");
  await b.helpers.loseTrade({ role: "partner", username: "bob", peer: "a" });
  expect(b.belongings).toEqual(["bob"]);
  await settled("bob");
  await sleep(10);
  // Guard: reloadWhenSettled. Without it the window shows the bags read before a swap the host may still finish.
  expect(b.belongings).toEqual(["bob", "bob"]);
});

test("an update that came back gone marks the player unsettled before their bags are read, and reads them once more after", async () => {
  tradeSettle.reset({ ms: 40, drop: async () => {} });
  await openAcross();
  fakeLinks.b.up = false;
  await b.helpers.tradeAction(bob.wt, bob, "accept");
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: TRADE_UNREACHABLE });
  // Guard: the unsettle in relayTradeUpdate's gone branch, named for the node that held the trade.
  expect(tradeSettle.unsettledUntil("bob")).not.toBeNull();
  expect(warned.some((line) => line.includes("bob") && line.includes("on a ") && line.includes('"accept" came back gone'))).toBe(true);
  expect(b.belongings).toEqual(["bob"]);
  await settled("bob");
  await sleep(10);
  expect(b.belongings).toEqual(["bob", "bob"]);
  fakeLinks.b.up = true;
});

test("a leave that came back gone marks the player unsettled; one that arrived marks nobody", async () => {
  await openAcross();
  b.helpers.endTradeOfLeaver({ player: bob });
  await settle();
  expect(tradeSettle.unsettledUntil("bob")).toBeNull();

  // A host that holds no trade of theirs answers the leave gone (the link is up, and nothing was accepted).
  b.link.setHost("bob", "a");
  b.helpers.endTradeOfLeaver({ player: bob });
  expect(tradeSettle.unsettled("bob")).toBe(false);
  await settle();
  await sleep(10);
  // Guard: the unsettle on a gone leave in endTradeOfLeaver.
  expect(tradeSettle.unsettledUntil("bob")).not.toBeNull();
  expect(warned.some((line) => line.includes("bob") && line.includes("on a ") && line.includes("leave from the trade came back gone"))).toBe(true);
});

test("a leave while the link is down marks the player at once, before the leave goes out (review M2)", async () => {
  await openAcross();
  fakeLinks.b.up = false;
  b.helpers.endTradeOfLeaver({ player: bob });
  // Guard: the mark is there before any await, so a relog here in the leave's round trip waits on settled.
  expect(tradeSettle.unsettled("bob")).toBe(true);
  let waited = false;
  void settled("bob").then(() => { waited = true; });
  await settle();
  await sleep(10);
  expect(waited).toBe(false);
  expect(warned.some((line) => line.includes("bob") && line.includes("on a ") && line.includes("they left their trade while the link to it was down"))).toBe(true);
  // The gone reply extends the mark from the reply (review re-check Minor), so a leave that timed out is covered in full.
  expect(warned.filter((line) => line.includes("bob") && line.includes("leave from the trade came back gone")).length).toBe(1);
  fakeLinks.b.up = true;
});

test("a leave after an accept marks the player at once, and a relog in the leave's round trip waits on settled (review M2)", async () => {
  tradeSettle.reset({ ms: 40, drop: async () => {} });
  await openAcross();
  ripen();
  await a.helpers.tradeAction(alice.wt, alice, "accept");
  await settle();
  expect((b.link.lastState("bob") as any)?.accepted).toEqual({ mine: false, theirs: true });
  // The host's answer is held back, so the leave is still in flight when the relog reads the mark.
  fakeLinks.a.blackhole = true;
  b.helpers.endTradeOfLeaver({ player: bob });
  // Guard: the accepted mark, before any await.
  expect(tradeSettle.unsettled("bob")).toBe(true);
  const relog = (async () => { await settled("bob"); return "loaded"; })();
  let loaded = false;
  void relog.then(() => { loaded = true; });
  await sleep(5);
  expect(loaded).toBe(false);
  expect(warned.some((line) => line.includes("bob") && line.includes("they left their trade after an accept"))).toBe(true);
  fakeLinks.a.blackhole = false;
  // The mark runs out, and the relog goes on.
  expect(await relog).toBe("loaded");
  // The held leave times out (LinkCalls 200 ms) and comes back gone inside this test, so its mark does not leak into
  // later tests with the default SETTLE_MS.
  await sleep(250);
  expect(warned.some((line) => line.includes("bob") && line.includes("leave from the trade came back gone"))).toBe(true);
});

test("a leave with nothing accepted and the link up marks nobody at once (review M2)", async () => {
  await openAcross();
  ripen();
  // Bob's own accept is on the host only once it is shown back; before that nothing is accepted here.
  expect((b.link.lastState("bob") as any)?.accepted ?? { mine: false, theirs: false }).toEqual({ mine: false, theirs: false });
  b.helpers.endTradeOfLeaver({ player: bob });
  expect(tradeSettle.unsettled("bob")).toBe(false);
  await settle();
  expect(tradeSettle.unsettledUntil("bob")).toBeNull();
});

test("a leave after the leaver's own accept is shown back marks them at once (review M2)", async () => {
  tradeSettle.reset({ ms: 40, drop: async () => {} });
  await openAcross();
  ripen();
  await b.helpers.tradeAction(bob.wt, bob, "accept");
  await settle();
  expect((b.link.lastState("bob") as any)?.accepted).toEqual({ mine: true, theirs: false });
  b.helpers.endTradeOfLeaver({ player: bob });
  // Guard: the leaver's own accept counts, not only the partner's.
  expect(tradeSettle.unsettled("bob")).toBe(true);
  await settle();
  await settled("bob");
});

// ------------------------------------------------- an accept on its way (cells phase 7, Task 20c)

test("an accept sent is recorded until a state the host cast after answering it arrives (T20c)", async () => {
  const { host, partner } = pair();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handlers = recorder();
  handlers.update = async (body, from) => {
    handlers.seen.updates.push([body, from]);
    if (body.op === "accept") await gate;
    return { ok: true };
  };
  host.setHandlers(handlers);
  partner.setHandlers(recorder());
  host.setPartner("bob", "b", "s1");
  partner.setHost("bob", "a", "s1");
  expect(partner.acceptSent("bob")).toBe(false);

  const accepting = partner.sendUpdate("Bob", "accept");
  // Guard: recorded before it is sent, so a leave in the same turn finds it.
  expect(partner.acceptSent("BOB")).toBe(true);
  await settle();
  expect(handlers.seen.updates.length).toBe(1);
  // A state that arrives while the accept is on its way may have been cast before the host read it.
  host.sendState("bob", { accepted: { mine: false, theirs: false } });
  await settle();
  expect(partner.lastState("bob")).toEqual({ accepted: { mine: false, theirs: false } });
  // Guard: only a state that arrives once no accept is on its way lets go of the record.
  expect(partner.acceptSent("bob")).toBe(true);
  release();
  expect(await accepting).toEqual({ ok: true });
  // Answered, but no state has shown since whether it stands.
  expect(partner.acceptSent("bob")).toBe(true);
  host.sendState("bob", { accepted: { mine: false, theirs: false } });
  await settle();
  // Guard: the state cast after the answer shows where the accept stands, and the record is let go.
  expect(partner.acceptSent("bob")).toBe(false);
});

test("an accept sent is kept through a cancel, and let go when the trade ends or is left (T20c)", async () => {
  const { host, partner, a } = pair();
  host.setHandlers(recorder());
  partner.setHandlers(recorder());
  host.setPartner("bob", "b", "s1");
  partner.setHost("bob", "a", "s1");
  await partner.sendUpdate("bob", "accept");
  await partner.sendUpdate("bob", "cancel");
  // Guard: a cancel ends the trade only once the host says so. One answered "settling" leaves a swap under way.
  expect(partner.acceptSent("bob")).toBe(true);
  host.sendClosed("bob", { completed: false, message: "You cancelled the trade.", reload: false });
  await settle();
  // Guard: the record lives on the trade, and goes with it.
  expect(partner.hostOf("bob")).toBeNull();
  expect(partner.acceptSent("bob")).toBe(false);
  // A new trade of the same two nodes starts with no accept sent.
  host.setPartner("bob", "b", "s2");
  partner.setHost("bob", "a", "s2");
  expect(partner.acceptSent("bob")).toBe(false);

  // Left: the trade is let go here, and the record with it.
  await partner.sendUpdate("bob", "accept");
  expect(partner.acceptSent("bob")).toBe(true);
  await partner.sendUpdate("bob", "leave");
  expect(partner.acceptSent("bob")).toBe(false);

  // Lost with the link: let go too (peerDown marks on its own `accepted`).
  host.setPartner("bob", "b", "s3");
  partner.setHost("bob", "a", "s3");
  await partner.sendUpdate("bob", "accept");
  expect(partner.acceptSent("bob")).toBe(true);
  a.setUp(false);
  expect(partner.acceptSent("bob")).toBe(false);
  // peerDown's own mark is unchanged.
  expect(tradeSettle.unsettled("bob")).toBe(true);
});

test("a leave while the leaver's accept is on its way, not yet shown back, marks them at once (T20c)", async () => {
  tradeSettle.reset({ ms: 40, drop: async () => {} });
  await openAcross();
  ripen();
  // Sent, and not awaited: the leave comes in the same turn, before the host has read the accept.
  const accepting = b.helpers.tradeAction(bob.wt, bob, "accept");
  expect((b.link.lastState("bob") as any)?.accepted ?? { mine: false, theirs: false }).toEqual({ mine: false, theirs: false });
  expect(b.link.acceptSent("bob")).toBe(true);
  b.helpers.endTradeOfLeaver({ player: bob });
  // Guard: "accept sent" counts as "shown accepted" in endTradeOfLeaver, and marks before any await.
  expect(tradeSettle.unsettled("bob")).toBe(true);
  expect(warned.some((line) => line.includes("bob") && line.includes("they left their trade with an accept on its way"))).toBe(true);
  expect(b.link.hostOf("bob")).toBeNull();
  await accepting;
  await settle();
  // The host read the accept, then the leave: the trade is over there, and nothing was swapped.
  expect(trades.of("alice")).toBeNull();
  expect(a.emitted).toEqual([]);
  await settled("bob");
});

test("a leave while an offer (not an accept) is on its way marks nobody (T20c)", async () => {
  await openAcross();
  const spy = spyOn(currency, "get").mockResolvedValue({ copper: 100, silver: 0, gold: 0 } as any);
  restores.push(() => spy.mockRestore());
  const offering = b.helpers.tradeAction(bob.wt, bob, "offer", { items: [], coins: { copper: 5 } });
  // Guard: only an accept is recorded.
  expect(b.link.acceptSent("bob")).toBe(false);
  b.helpers.endTradeOfLeaver({ player: bob });
  expect(tradeSettle.unsettled("bob")).toBe(false);
  await offering;
  await settle();
  expect(tradeSettle.unsettledUntil("bob")).toBeNull();
});

test("an accept the host took back when the offer changed is let go, and a leave then marks nobody (T20c)", async () => {
  await openAcross();
  const spy = spyOn(currency, "get").mockResolvedValue({ copper: 100, silver: 0, gold: 0 } as any);
  restores.push(() => spy.mockRestore());
  ripen();
  await b.helpers.tradeAction(bob.wt, bob, "accept");
  await settle();
  expect((b.link.lastState("bob") as any)?.accepted).toEqual({ mine: true, theirs: false });
  // Alice changes her offer: the host takes back both accepts and casts the trade as it now stands.
  await a.helpers.tradeAction(alice.wt, alice, "offer", { items: [], coins: { copper: 5 } });
  await settle();
  expect((b.link.lastState("bob") as any)?.accepted).toEqual({ mine: false, theirs: false });
  // Guard: the state cast after the accept's answer lets go of the record.
  expect(b.link.acceptSent("bob")).toBe(false);
  b.helpers.endTradeOfLeaver({ player: bob });
  expect(tradeSettle.unsettled("bob")).toBe(false);
  await settle();
  expect(tradeSettle.unsettledUntil("bob")).toBeNull();
  expect(trades.of("alice")).toBeNull();
});

test("a trade that ends normally lets go of the accept sent, and the next trade starts with none (T20c)", async () => {
  await openAcross();
  ripen();
  await b.helpers.tradeAction(bob.wt, bob, "accept");
  await settle();
  expect(b.link.acceptSent("bob")).toBe(true);
  await a.helpers.tradeAction(alice.wt, alice, "cancel");
  await settle();
  expect(lastOf(bob, "TRADE_CLOSED")).toEqual({ completed: false, message: "Alice cancelled the trade." });
  // Guard: the record goes with the trade's end (TP_CLOSED).
  expect(b.link.hostOf("bob")).toBeNull();
  expect(b.link.acceptSent("bob")).toBe(false);
  // Opened again (openAcross answers the first invitation only).
  await a.helpers.requestTrade(alice.wt, alice, "2");
  const [, again] = a.invitations.at(-1)!;
  await b.helpers.answerTradeIfAcross(bob.wt, bob, again.originator, again.authorization, "ACCEPT");
  await settle();
  expect(b.link.hostOf("bob")).toBe("a");
  expect(b.link.acceptSent("bob")).toBe(false);
  b.helpers.endTradeOfLeaver({ player: bob });
  expect(tradeSettle.unsettled("bob")).toBe(false);
  await settle();
});

test("the real host's own offer or accept, raced against an accept on its way from the other node, never hides that accept (T20c review m1)", async () => {
  // The rule under test: while the host holds Bob's accept and node b still holds the trade, b's last state shows
  // it, or b still records it as sent. It rests on the host casting the state an accept made before it answers the
  // accept, and on b letting no state clear the record while an accept is on its way.
  const macrotasks = async (n: number) => { for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  let currencyDelay = 0;
  let viewDelay = 0;
  const view0 = trades.view;
  const accept0 = trades.accept;
  const spies = [
    spyOn(currency, "get").mockImplementation((async () => {
      await macrotasks(currencyDelay);
      return { copper: 100, silver: 0, gold: 0 };
    }) as any),
    // A view that reads the trade at once and is cast a few macrotasks later: a state that predates an accept can
    // then still be on its way when the accept is answered, unless the host casts before it answers.
    spyOn(trades, "view").mockImplementation((async (trade: any, username: string, now?: number) => {
      const read = await view0.call(trades, trade, username, now);
      await macrotasks(viewDelay);
      return read;
    }) as any),
    // The offer is old enough to accept whenever an accept is read (the link here is far faster than ACCEPT_DELAY_MS).
    spyOn(trades, "accept").mockImplementation(((username: string, find: any) => accept0.call(trades, username, find, Date.now() + 10_000)) as any),
  ];
  restores.push(...spies.map((s) => () => s.mockRestore()));

  const fresh = () => {
    trades.reset();
    fakeLinks = linkPair();
    a = makeNode("a", fakeLinks.a, true);
    b = makeNode("b", fakeLinks.b, false);
    alice = person("1", "alice", 100);
    bob = person("2", "bob", 150, { location: { map: "forest", position: { x: 150, y: 100 } } });
    a.players.set("1", alice);
    a.mirrors.set("2", mirrorOf(bob, "b"));
    b.players.set("2", bob);
    b.mirrors.set("1", mirrorOf(alice, "a"));
  };
  const hidden: string[] = [];
  let held = 0;
  const look = (label: string) => {
    if (trades.of("bob")?.accepted.bob !== true || b.link.hostOf("bob") === null) return;
    held++;
    const shown = (b.link.lastState("bob") as any)?.accepted?.mine === true;
    if (!shown && !b.link.acceptSent("bob")) hidden.push(label);
  };

  for (const action of ["offer", "accept", "offer then accept"]) {
    for (const cd of [0, 1, 3]) {
      for (const vd of [0, 2, 3]) {
        for (let offset = -4; offset <= 6; offset++) {
          const label = `${action}, currency +${cd}, view +${vd}, Bob ${offset >= 0 ? "+" : ""}${offset}`;
          fresh();
          currencyDelay = 0;
          viewDelay = 0;
          await openAcross();
          await macrotasks(5);
          currencyDelay = cd;
          viewDelay = vd;
          const hostSide = (async () => {
            await macrotasks(Math.max(0, -offset));
            if (action !== "accept") await a.helpers.tradeAction(alice.wt, alice, "offer", { items: [], coins: { copper: 5 } });
            if (action !== "offer") await a.helpers.tradeAction(alice.wt, alice, "accept");
          })();
          const bobSide = (async () => {
            await macrotasks(Math.max(0, offset));
            await b.helpers.tradeAction(bob.wt, bob, "accept");
          })();
          let done = false;
          void Promise.all([hostSide, bobSide]).then(() => { done = true; });
          for (let tick = 0; tick < 200 && !done; tick++) {
            await macrotasks(1);
            look(label);
          }
          // What is still on its way lands, and is looked at as it does.
          for (let tick = 0; tick < 15; tick++) {
            await macrotasks(1);
            look(label);
          }
          expect(done).toBe(true);
        }
      }
    }
  }
  // The race reached the case it is about: the host held an accept of Bob's while it was being looked at.
  expect(held).toBeGreaterThan(0);
  // Guard: the in-flight rule on b (TP_STATE), and the host's cast before its answer (acceptTrade).
  expect([...new Set(hidden)]).toEqual([]);
  expect(warned.filter((line) => line.includes("bob") && line.includes("came back gone"))).toEqual([]);
});

test("with the cluster off, a player who accepted and leaves ends their trade and is marked by nobody (T20c)", async () => {
  const c = makeNode("c", linkPair().a, true, true);
  const carol = person("3", "carol", 100);
  const dave = person("4", "dave", 120);
  c.players.set("3", carol);
  c.players.set("4", dave);
  expect(typeof trades.open(carol, dave)).toBe("object");
  trades.of("carol")!.changedAt -= 10_000;
  await c.helpers.tradeAction(dave.wt, dave, "accept");
  expect(lastOf(dave, "TRADE_STATE")).toMatchObject({ accepted: { mine: true, theirs: false } });
  expect(c.link.hostOf("dave")).toBeNull();
  expect(c.link.acceptSent("dave")).toBe(false);
  c.helpers.endTradeOfLeaver({ player: dave });
  // Guard: no trade held on another node, so no mark (no link context here would read as a link that is down).
  expect(tradeSettle.unsettled("dave")).toBe(false);
  expect(trades.of("carol")).toBeNull();
  expect(lastOf(carol, "TRADE_CLOSED")).toEqual({ completed: false, message: "Dave is no longer online." });
  await settle();
  expect(tradeSettle.unsettledUntil("dave")).toBeNull();
});
