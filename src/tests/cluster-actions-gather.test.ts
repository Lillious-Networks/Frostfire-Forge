import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ghosts } from "../cluster/ghosts";
import { grantKey, grants } from "../cluster/grants";
import { LinkCalls, linkCalls } from "../cluster/linkcalls";
import { MemoryStore } from "../cluster/memorystore";
import { mirrorOwner, mirrorPlayers } from "../cluster/mirrors";
import log from "../modules/logger";
import { answerGather, receiveGathered, RemoteGatherers, requestGather, withRemoteGatherers, type RemoteGatherer } from "../systems/gathering/remote";
import { GatherService, REASONS } from "../systems/gathering/service";
import { GatherSpawner } from "../systems/gathering/spawner";
import type { GatherArea, GatherNode } from "../systems/gathering/types";
import { linkPair, settle } from "./cluster-fakelink";
import { openGrid, seeded } from "./gathering-helpers";
import { databaseModule, mockQuery } from "./setup";
import { receiverSource as readReceiverSource } from "./receiver-source";

// The engine side of gathering (index.ts) reaches the database through the inventory; none of these tests reads or writes a row.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
// Generated at server start and gitignored, so CI has no copy on disk.
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const gathering = await import("../systems/gathering");
const { default: inventory } = await import("../systems/inventory");
const { default: bags } = await import("../systems/bags");
const { default: playerCache } = await import("../services/playermanager");

const area: GatherArea = {
  id: 1, map: "main", x: 500, y: 500, radius: 64, size: 32, item: "Copper Ore",
  quantity_min: 2, quantity_max: 4, max_nodes: 1, respawn_min_s: 10, respawn_max_s: 20, enabled: true,
};

/** The owner node: a spawner with one node, and a service that sees remote gatherers. `locals` are this node's own gatherers. */
function owner(locals: Record<string, RemoteGatherer> = {}, seed = 3, later: (run: () => void) => void = (run) => void setTimeout(run, 0)) {
  const spawner = new GatherSpawner(() => openGrid(), {}, seeded(2));
  spawner.setAreas([area], 0);
  spawner.setLayers(new Map([["main", ["L1"]]]), 0);
  spawner.tick(0);
  const node = spawner.nodesOn("main", "L1")[0]!;
  const gatherers = new RemoteGatherers();
  const given: string[] = [];
  const service = new GatherService({
    spawner,
    ...withRemoteGatherers({
      gatherer: (id) => locals[id] ?? null,
      hasRoomFor: async () => true,
      give: async (username) => (given.push(username), true),
    }, gatherers),
    // The claim window closes on the next turn.
    later,
    r: seeded(seed),
    now: () => 1000,
  });
  // The mirror is the test's to set (see stands): the refusal for a mirror with no position is tested in cluster-gather-mirror.test.ts.
  return { node, spawner, gatherers, service, given, deps: { service, gatherers, ownerOf: mirrorOwner, mirrorOf: (id: string) => mirrorPlayers.get(id) } };
}

/** The mirror of alice (id 7) as her node last said it: standing where remote(node) sends her. */
const stands = (node: GatherNode, over: Record<string, unknown> = {}) => ({
  id: "7", username: "alice", remote: true, mirrorFrom: "b", location: { map: "main", position: { x: node.x + 10, y: node.y } }, ...over,
});

const remote = (node: GatherNode, over: Partial<RemoteGatherer> = {}): RemoteGatherer => ({
  id: "7", username: "alice", map: "main", layerId: "L1", x: node.x + 10, y: node.y,
  dead: false, stunned: false, casting: false, moving: false, inCombat: false, hasRoom: true, ...over,
});

// Every test file shares one process: what a test changes in a singleton is put back here.
const restores: Array<() => void> = [];
const spy = (target: any, key: string, impl: (...args: any[]) => any) => {
  const s = spyOn(target, key).mockImplementation(impl as any);
  restores.push(() => s.mockRestore());
  return s;
};

afterEach(() => {
  mirrorPlayers.clear();
  linkCalls.detach();
  for (const restore of restores.splice(0).reverse()) restore();
});

/** What is logged while a test runs. */
function logged() {
  const out = { error: [] as string[], warn: [] as string[], info: [] as string[] };
  spy(log, "error", (message: string) => { out.error.push(String(message)); });
  spy(log, "warn", (message: string) => { out.warn.push(String(message)); });
  spy(log, "info", (message: string) => { out.info.push(String(message)); });
  return out;
}

test("a remote gatherer starts and finishes on the owner, and the owner writes nothing", async () => {
  const { node, gatherers, given, deps } = owner();
  mirrorPlayers.set("7", stands(node));
  const started = await answerGather({ phase: "start", nodeId: node.id, gatherer: remote(node) }, "b", deps);
  expect(started.ok).toBe(true);
  expect(started.node?.id).toBe(node.id);
  const finished = await answerGather({ phase: "finish", nodeId: node.id, gatherer: remote(node) }, "b", deps);
  expect(finished).toMatchObject({ ok: true, item: "Copper Ore" });
  expect(finished.quantity).toBeGreaterThanOrEqual(2);
  expect(finished.quantity).toBeLessThanOrEqual(4);
  expect(given).toEqual([]);
  // The snapshot is gone once the request is served.
  expect(gatherers.get("7")).toBeNull();
  expect(gatherers.isRemote("alice")).toBe(false);
});

test("the owner checks the snapshot: its room, its range, and that it came from the caller", async () => {
  const { node, deps } = owner();
  mirrorPlayers.set("7", stands(node));
  expect(await answerGather({ phase: "start", nodeId: node.id, gatherer: remote(node, { hasRoom: false }) }, "b", deps)).toEqual({ ok: false, reason: REASONS.full });
  mirrorPlayers.set("7", stands(node, { location: { map: "main", position: { x: node.x + 5000, y: node.y } } }));
  expect(await answerGather({ phase: "start", nodeId: node.id, gatherer: remote(node, { x: node.x + 5000 }) }, "b", deps)).toEqual({ ok: false, reason: REASONS.far });
  mirrorPlayers.set("7", stands(node));
  expect(await answerGather({ phase: "start", nodeId: node.id, gatherer: remote(node) }, "c", deps)).toEqual({ ok: false, reason: REASONS.gone });
  expect(await answerGather({ phase: "start", nodeId: node.id, gatherer: remote(node, { id: "8" }) }, "b", deps)).toEqual({ ok: false, reason: REASONS.gone });
});

test("requestGather asks the owner, and a failed link is a failed gather", async () => {
  const { a, b } = linkPair();
  const ownerLink = new LinkCalls();
  linkCalls.attach(a);
  ownerLink.attach(b);
  const asked: any[] = [];
  ownerLink.handle("GATHER_REQUEST", (request) => {
    asked.push(request);
    return { ok: true, item: "Copper Ore", quantity: 3 };
  });
  const request = { phase: "finish" as const, nodeId: 4, gatherer: remote({ id: 4, x: 0, y: 0 } as GatherNode) };
  expect(await requestGather("b", request)).toEqual({ ok: true, item: "Copper Ore", quantity: 3 });
  expect(asked[0].gatherer.username).toBe("alice");
  b.setUp(false);
  expect(await requestGather("b", request)).toEqual({ ok: false, reason: REASONS.failed });
  ownerLink.detach();
});

test("a request that cannot be a gatherer's is refused: a position that is no number, another name, no phase", async () => {
  const { node, deps } = owner();
  const out = logged();
  mirrorPlayers.set("7", stands(node));
  // NaN is never farther than the range: a snapshot without a position must not pass the range check.
  const noPosition = { ...remote(node), x: undefined as any };
  expect(await answerGather({ phase: "start", nodeId: node.id, gatherer: noPosition }, "b", deps)).toEqual({ ok: false, reason: REASONS.gone });
  expect(await answerGather({ phase: "start", nodeId: node.id, gatherer: remote(node, { username: "mallory" }) }, "b", deps)).toEqual({ ok: false, reason: REASONS.gone });
  expect(await answerGather({ phase: "start", nodeId: node.id, gatherer: remote(node, { username: "ALICE" }) }, "b", deps)).toMatchObject({ ok: true });
  // A request with no phase must not run as a finish: the node is still there afterwards.
  expect(await answerGather({ phase: "claim" as any, nodeId: node.id, gatherer: remote(node) }, "b", deps)).toEqual({ ok: false, reason: REASONS.failed });
  expect(out.warn.some((line) => line.includes("alice"))).toBe(true);
  expect((await answerGather({ phase: "start", nodeId: node.id, gatherer: remote(node) }, "b", deps)).ok).toBe(true);
});

test("the snapshot is dropped when the owner's service throws", async () => {
  const { node, gatherers, deps } = owner();
  mirrorPlayers.set("7", stands(node));
  const failing = { start: async () => { throw new Error("boom"); }, finish: async () => { throw new Error("boom"); } };
  await expect(answerGather({ phase: "finish", nodeId: node.id, gatherer: remote(node) }, "b", { ...deps, service: failing })).rejects.toThrow("boom");
  expect(gatherers.get("7")).toBeNull();
});

test("a remote and a local gatherer who finish together get one winner, and only a local winner is written", async () => {
  logged();
  const winners = new Set<string>();
  for (let seed = 1; seed <= 12; seed++) {
    const locals: Record<string, RemoteGatherer> = {};
    const { node, deps, given } = owner(locals, seed * 104729);
    locals.bob = { ...remote(node), id: "bob", username: "bob" };
    mirrorPlayers.set("7", stands(node));
    // Both finish against the one node of one owner, in the same claim window.
    const [far, near] = await Promise.all([
      answerGather({ phase: "finish", nodeId: node.id, gatherer: remote(node) }, "b", deps),
      deps.service.finish("bob", node.id),
    ]);
    expect([far.ok, near.ok].filter(Boolean)).toHaveLength(1);
    expect(far.ok ? near : far).toEqual({ ok: false, reason: REASONS.lost });
    winners.add(far.ok ? "remote" : "local");
    // Only the local winner is written on the owner; the remote winner's item goes back in the answer.
    expect(given).toEqual(near.ok ? ["bob"] : []);
  }
  // The draw is random across the two nodes: each side won at least once over the seeds.
  expect([...winners].sort()).toEqual(["local", "remote"]);
});

test("a finish whose answer is lost is logged by item name, and only when the call was sent", async () => {
  const out = logged();
  const { a, b } = linkPair();
  const ownerLink = new LinkCalls();
  linkCalls.attach(a);
  ownerLink.attach(b);
  ownerLink.handle("GATHER_REQUEST", () => { throw new Error("owner fault"); });
  const request = (phase: "start" | "finish") => ({ phase, nodeId: 4, gatherer: remote({ id: 4, x: 0, y: 0 } as GatherNode) });
  // A start takes nothing: nothing to report.
  expect(await requestGather("b", request("start"), "Copper Ore")).toEqual({ ok: false, reason: REASONS.failed });
  expect(out.warn).toEqual([]);
  // A finish that failed after it was sent may have been applied: the item is named.
  expect(await requestGather("b", request("finish"), "Copper Ore")).toEqual({ ok: false, reason: REASONS.failed });
  expect(out.warn).toHaveLength(1);
  expect(out.warn[0]).toContain("Copper Ore");
  expect(out.warn[0]).toContain("alice");
  // The link is down: nothing was sent, so nothing was taken, and nothing is said.
  b.setUp(false);
  expect(await requestGather("b", request("finish"), "Copper Ore")).toEqual({ ok: false, reason: REASONS.failed });
  expect(out.warn).toHaveLength(1);
  ownerLink.detach();
});

test("the owner logs what it hands to a remote gatherer, by item name", async () => {
  const out = logged();
  const { node, deps } = owner();
  mirrorPlayers.set("7", stands(node));
  const finished = await answerGather({ phase: "finish", nodeId: node.id, gatherer: remote(node) }, "b", deps);
  expect(finished.ok).toBe(true);
  expect(out.info).toHaveLength(1);
  expect(out.info[0]).toContain("alice");
  expect(out.info[0]).toContain(`${finished.quantity} x Copper Ore`);
});

// ------------------------------------------------------------------ the owner reads every field of the snapshot

const FIELD_CASES: Array<[string, Partial<RemoteGatherer>, string, boolean]> = [
  // [name, the field sent, the reason on a start, whether a finish refuses it too]
  ["dead", { dead: true }, REASONS.dead, true],
  ["stunned", { stunned: true }, REASONS.stunned, true],
  ["inCombat", { inCombat: true }, REASONS.combat, true],
  ["casting", { casting: true }, REASONS.casting, false],
  ["moving", { moving: true }, REASONS.moving, false],
  ["map", { map: "elsewhere" }, REASONS.gone, true],
  ["layerId", { layerId: "L2" }, REASONS.gone, true],
  ["no layer", { layerId: null }, REASONS.gone, true],
];

test("the owner refuses each field of the snapshot that a local gatherer would be refused for", async () => {
  logged();
  for (const [name, over, reason, onFinish] of FIELD_CASES) {
    const started = owner();
    mirrorPlayers.set("7", stands(started.node));
    expect(await answerGather({ phase: "start", nodeId: started.node.id, gatherer: remote(started.node, over) }, "b", started.deps), `start: ${name}`).toEqual({ ok: false, reason });
    // casting and moving only count before the cast; the cast itself is one, and a step is its end.
    const finished = owner();
    mirrorPlayers.set("7", stands(finished.node));
    const answer = await answerGather({ phase: "finish", nodeId: finished.node.id, gatherer: remote(finished.node, over) }, "b", finished.deps);
    if (onFinish) expect(answer, `finish: ${name}`).toEqual({ ok: false, reason: reason === REASONS.gone ? REASONS.lost : reason });
    else expect(answer, `finish: ${name}`).toMatchObject({ ok: true, item: "Copper Ore" });
  }
});

test("two requests of one gatherer overlap: the first to end does not take the snapshot from the other", async () => {
  logged();
  const held: Array<() => void> = [];
  const { node, gatherers, deps, given } = owner({}, 3, (run) => void held.push(run));
  mirrorPlayers.set("7", stands(node));
  // The finish claims the node and waits in its window; a start of the same player (a second click) runs meanwhile.
  const finish = answerGather({ phase: "finish", nodeId: node.id, gatherer: remote(node) }, "b", deps);
  await settle();
  expect(held).toHaveLength(1);
  expect(gatherers.get("7")).not.toBeNull();
  expect(await answerGather({ phase: "start", nodeId: node.id, gatherer: remote(node) }, "b", deps)).toMatchObject({ ok: true });
  // The start is done; the finish still has its snapshot when the window closes.
  expect(gatherers.get("7")).not.toBeNull();
  held[0]!();
  expect(await finish).toMatchObject({ ok: true, item: "Copper Ore" });
  expect(gatherers.get("7")).toBeNull();
  expect(given).toEqual([]);
});

// ------------------------------------------------------------------ the gatherer's node writes what the owner handed over

function receiving(over: { stillHere?: boolean; give?: (name: string, item: string, quantity: number) => Promise<boolean> } = {}) {
  const gave: any[] = [];
  const out = logged();
  const deps = {
    expected: { item: "Copper Ore", maxQuantity: 5 },
    stillHere: () => over.stillHere ?? true,
    give: over.give ?? (async (...args: [string, string, number]) => (gave.push(args), true)),
  };
  return { gave, out, deps };
}

test("what the owner handed over is written once, as the owner counted it", async () => {
  const { gave, out, deps } = receiving();
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3 }, deps)).toEqual({ ok: true, item: "Copper Ore", quantity: 3 });
  expect(gave).toEqual([["alice", "Copper Ore", 3]]);
  // A quantity that is no number is one, as the rest of the game counts.
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: "x" as any }, deps)).toMatchObject({ ok: true, quantity: 1 });
  expect(out.error).toEqual([]);
});

test("an item that cannot be written is lost, and logged by item name", async () => {
  // The player left during the round trip: nothing is written.
  const left = receiving({ stillHere: false });
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3 }, left.deps)).toEqual({ ok: false, reason: REASONS.failed });
  expect(left.gave).toEqual([]);
  expect(left.out.error).toHaveLength(1);
  expect(left.out.error[0]).toContain("3 x Copper Ore");
  expect(left.out.error[0]).toContain("alice");
  // The write was refused.
  const refused = receiving({ give: async () => false });
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3 }, refused.deps)).toEqual({ ok: false, reason: REASONS.failed });
  expect(refused.out.error).toHaveLength(1);
  expect(refused.out.error[0]).toContain("3 x Copper Ore");
  // The write threw.
  const threw = receiving({ give: async () => { throw new Error("db down"); } });
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3 }, threw.deps)).toEqual({ ok: false, reason: REASONS.failed });
  expect(threw.out.error).toHaveLength(1);
  expect(threw.out.error[0]).toContain("3 x Copper Ore");
  expect(threw.out.error[0]).toContain("db down");
  // The owner settled the node but named no item: that is logged too, and nothing is written.
  const nameless = receiving();
  expect(await receiveGathered("alice", "b", 4, { ok: true, quantity: 3 }, nameless.deps)).toEqual({ ok: false, reason: REASONS.failed });
  expect(nameless.gave).toEqual([]);
  expect(nameless.out.error).toHaveLength(1);
});

test("with a grant store, an item that cannot be written is parked again, and logged as lost only when that fails", async () => {
  const store = new MemoryStore();
  grants.attach(store, "a");
  try {
    for (const [why, over] of [
      ["left", { stillHere: false }],
      ["nothing written", { give: async () => false }],
    ] as const) {
      const { out, deps } = receiving(over as any);
      expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3 }, deps)).toEqual({ ok: false, reason: REASONS.failed });
      expect(out.error).toEqual([]);
      const parked = out.warn.find((line) => line.includes("parked again as hand-over"));
      expect(parked, why).toBeDefined();
      const id = parked!.slice(parked!.lastIndexOf(" ") + 1);
      const grant = JSON.parse(String(await store.get(grantKey(id))));
      expect(grant).toMatchObject({ username: "alice", items: [{ itemName: "Copper Ore", quantity: 3 }], copper: 0, call: "GATHER_REQUEST" });
    }
  } finally {
    grants.detach();
  }
  // A write that threw may have been made (a kept step after the commit, a lost answer): logged as lost, never parked.
  grants.attach(store, "a");
  const parks = spyOn(grants, "park");
  try {
    const { out, deps } = receiving({ give: async () => { throw new Error("db down"); } });
    expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3 }, deps)).toEqual({ ok: false, reason: REASONS.failed });
    expect(out.warn.filter((line) => line.includes("parked again"))).toEqual([]);
    expect(out.error).toHaveLength(1);
    expect(out.error[0]).toContain("3 x Copper Ore");
    expect(out.error[0]).toContain("db down");
    expect(parks).not.toHaveBeenCalled();
  } finally {
    parks.mockRestore();
    grants.detach();
  }
  // The park fails too: the item is logged as lost by name.
  const failing = new MemoryStore();
  failing.set = async () => { throw new Error("store down"); };
  grants.attach(failing, "a");
  try {
    const { out, deps } = receiving({ give: async () => false });
    expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3 }, deps)).toEqual({ ok: false, reason: REASONS.failed });
    const lost = out.error.filter((line) => line.includes("was lost for alice"));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("3 x Copper Ore");
  } finally {
    grants.detach();
  }
});

// ------------------------------------------------------------------ index.ts: the gatherer's two calls and the owner's handler

const node9: GatherNode = { id: 9201, areaId: 1, map: "main", layerId: "L1", x: 100, y: 100, item: "Copper Ore", tile: "9201" };

/** A player here, in the player cache only: enough for the rules' view of them. */
function addPlayer(id: string, username: string): any {
  const player: any = {
    id, username, wt: { readyState: 1, send() {} }, location: { map: "main.json", position: { x: node9.x + 10, y: node9.y, direction: "down" } },
    stats: { health: 50, total_max_health: 100 },
  };
  playerCache.add(id, player);
  restores.push(() => playerCache.remove(id));
  return playerCache.get(id);
}

/** This node holds the mirror of node9, which `b` owns, and is linked to `b`; `asked` collects what `b` is asked. */
function neighbour(answer: (request: any) => any, bagRows: any[] = []) {
  const { a, b } = linkPair();
  const ownerLink = new LinkCalls();
  linkCalls.attach(a);
  ownerLink.attach(b);
  restores.push(() => ownerLink.detach());
  const asked: any[] = [];
  ownerLink.handle("GATHER_REQUEST", (request) => (asked.push(request), answer(request)));
  expect(gathering.addRemoteGatherNode(node9)).toBe(true);
  restores.push(() => gathering.removeRemoteGatherNode(node9.id));
  // This node knows the node's area (every node reads them all), which bounds what the owner may answer.
  gathering.spawner.setAreas([area], 0);
  restores.push(() => gathering.spawner.setAreas([], 0));
  spy(ghosts, "ownerOf", (kind: string, id: number) => (kind === "gather" && Number(id) === node9.id ? "b" : null));
  spy(inventory, "get", async () => bagRows);
  spy(bags, "capacity", async () => 10);
  return { asked, b };
}

test("startGather asks the owner of a neighbour's node with the player as this node sees them", async () => {
  const { asked } = neighbour(() => ({ ok: true, node: node9 }));
  addPlayer("21", "gina");
  expect(await gathering.startGather("21", 9201)).toEqual({ ok: true, node: node9 });
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ phase: "start", nodeId: 9201, gatherer: { id: "21", username: "gina", map: "main", x: node9.x + 10, y: node9.y, hasRoom: true } });
  // The owner cannot read their bags: their room is sent.
  const full = neighbour(() => ({ ok: true, node: node9 }), Array.from({ length: 10 }, (_, i) => ({ item: `Item ${i}` })));
  expect(await gathering.startGather("21", 9201)).toEqual({ ok: true, node: node9 });
  expect(full.asked[0].gatherer.hasRoom).toBe(false);
});

test("startGather passes the owner's refusal on, and a failed link or an answer for another node is a failure", async () => {
  const refusing = neighbour(() => ({ ok: false, reason: REASONS.far }));
  addPlayer("21", "gina");
  expect(await gathering.startGather("21", 9201)).toEqual({ ok: false, reason: REASONS.far });
  expect(refusing.asked).toHaveLength(1);
  refusing.b.setUp(false);
  expect(await gathering.startGather("21", 9201)).toEqual({ ok: false, reason: REASONS.failed });
  restores.splice(0).reverse().forEach((restore) => restore());
  neighbour(() => ({ ok: true, node: { ...node9, id: 1 } }));
  addPlayer("21", "gina");
  expect(await gathering.startGather("21", 9201)).toEqual({ ok: false, reason: REASONS.gone });
});

test("a node of this node's own is still started by its own service, and asks nobody", async () => {
  const { asked } = neighbour(() => ({ ok: true, node: node9 }));
  addPlayer("21", "gina");
  expect(await gathering.startGather("21", 5)).toEqual({ ok: false, reason: REASONS.gone });
  expect(await gathering.startGather("21", "not a number")).toEqual({ ok: false, reason: REASONS.gone });
  expect(asked).toEqual([]);
});

test("a player who left is not asked for", async () => {
  const { asked } = neighbour(() => ({ ok: true, node: node9 }));
  expect(await gathering.startGather("22", 9201)).toEqual({ ok: false, reason: REASONS.gone });
  expect(await gathering.finishGather("22", 9201)).toEqual({ ok: false, reason: REASONS.lost });
  expect(asked).toEqual([]);
});

/** Stands in for the inventory write of gathering's own `give`. */
function writes(result: boolean | Error = true) {
  const added: any[] = [];
  spy(inventory, "add", async (username: string, item: any) => {
    added.push([username, item.name, item.quantity]);
    if (result instanceof Error) throw result;
    return result;
  });
  return added;
}

test("finishGather writes what the owner handed over, on this node, once", async () => {
  const { asked } = neighbour(() => ({ ok: true, node: node9, item: "Copper Ore", quantity: 3 }));
  addPlayer("21", "gina");
  const added = writes();
  const out = logged();
  expect(await gathering.finishGather("21", 9201)).toEqual({ ok: true, node: node9, item: "Copper Ore", quantity: 3 });
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ phase: "finish", nodeId: 9201, gatherer: { username: "gina", hasRoom: true } });
  expect(added).toEqual([["gina", "Copper Ore", 3]]);
  expect(out.error).toEqual([]);
});

test("finishGather: the owner's refusal writes nothing, and a lost link is logged by item name", async () => {
  const refusing = neighbour(() => ({ ok: false, reason: REASONS.lost }));
  addPlayer("21", "gina");
  const added = writes();
  const out = logged();
  expect(await gathering.finishGather("21", 9201)).toEqual({ ok: false, reason: REASONS.lost });
  expect(added).toEqual([]);
  expect(out.warn).toEqual([]);
  restores.splice(0).reverse().forEach((restore) => restore());
  neighbour(() => { throw new Error("owner fault"); });
  addPlayer("21", "gina");
  const added2 = writes();
  const out2 = logged();
  expect(await gathering.finishGather("21", 9201)).toEqual({ ok: false, reason: REASONS.failed });
  expect(added2).toEqual([]);
  expect(out2.warn.some((line) => line.includes("Copper Ore") && line.includes("gina"))).toBe(true);
  void refusing;
});

test("finishGather: a node whose mirror shows another item than its area gives is not gathered, and the owner is not asked (review M4)", async () => {
  const { asked } = neighbour(() => ({ ok: true, node: node9, item: "Gold Ore", quantity: 1 }));
  gathering.spawner.setAreas([{ ...area, item: "Gold Ore" }], 0);
  addPlayer("21", "gina");
  const added = writes();
  const out = logged();
  expect(await gathering.finishGather("21", 9201)).toEqual({ ok: false, reason: REASONS.failed });
  expect(asked).toEqual([]);
  expect(added).toEqual([]);
  expect(out.warn.some((line) => line.includes("Copper Ore") && line.includes("Gold Ore"))).toBe(true);
});

test("finishGather: an item the owner has settled that cannot be written is lost, and logged by item name", async () => {
  neighbour(() => ({ ok: true, node: node9, item: "Copper Ore", quantity: 3 }));
  addPlayer("21", "gina");
  const refused = writes(false);
  const out = logged();
  expect(await gathering.finishGather("21", 9201)).toEqual({ ok: false, reason: REASONS.failed });
  expect(refused).toHaveLength(1);
  expect(out.error.some((line) => line.includes("3 x Copper Ore"))).toBe(true);
});

test("finishGather: a write that failed before its batch was sent is parked again; one that may have been made is not (review C1)", async () => {
  const store = new MemoryStore();
  grants.attach(store, "a");
  const parks = spyOn(grants, "park");
  try {
    // The item check inside the batch refused: nothing was sent, so the item goes back to the grant store.
    neighbour(() => ({ ok: true, node: node9, item: "Copper Ore", quantity: 3 }));
    addPlayer("21", "gina");
    writes(new Error("bags locked"));
    const out = logged();
    expect(await gathering.finishGather("21", 9201)).toEqual({ ok: false, reason: REASONS.failed });
    expect(parks).toHaveBeenCalledTimes(1);
    expect(parks.mock.calls[0][0]).toMatchObject({ username: "gina", items: [{ itemName: "Copper Ore", quantity: 3 }], call: "GATHER_REQUEST" });
    expect(out.error.some((line) => line.includes("was lost for gina"))).toBe(false);
    // The rows were sent and kept, then a kept step failed: the item may be in the bags, so it is logged lost, not parked.
    restores.splice(0).reverse().forEach((restore) => restore());
    parks.mockClear();
    neighbour(() => ({ ok: true, node: node9, item: "Copper Ore", quantity: 3 }));
    addPlayer("21", "gina");
    spy(inventory, "add", async (_username: string, _item: any, batch: any) => {
      batch.add({ sql: "INSERT INTO inventory" });
      batch.kept(() => { throw new Error("cache gone"); });
      return true;
    });
    const out2 = logged();
    expect(await gathering.finishGather("21", 9201)).toEqual({ ok: false, reason: REASONS.failed });
    expect(parks).not.toHaveBeenCalled();
    const lost = out2.error.filter((line) => line.includes("was lost for gina"));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("3 x Copper Ore");
    expect(lost[0]).toContain("cache gone");
  } finally {
    parks.mockRestore();
    grants.detach();
  }
});

/** finishGather for gina with `during` run while the owner answers; the write is a stand-in. */
async function finishDuring(during: () => void) {
  neighbour(() => {
    during();
    return { ok: true, node: node9, item: "Copper Ore", quantity: 3 };
  });
  addPlayer("21", "gina");
  const added = writes();
  const out = logged();
  const outcome = await gathering.finishGather("21", 9201);
  return { outcome, added, out };
}

test("finishGather: a player who left or logged in elsewhere during the round trip is not written to", async () => {
  const left = await finishDuring(() => playerCache.remove("21"));
  expect(left.outcome).toEqual({ ok: false, reason: REASONS.failed });
  expect(left.added).toEqual([]);
  expect(left.out.error.some((line) => line.includes("3 x Copper Ore") && line.includes("left meanwhile"))).toBe(true);
  // Another player holds the id by now.
  restores.splice(0).reverse().forEach((restore) => restore());
  const other = await finishDuring(() => { playerCache.remove("21"); addPlayer("21", "zed"); });
  expect(other.outcome).toEqual({ ok: false, reason: REASONS.failed });
  expect(other.added).toEqual([]);
  expect(other.out.error.some((line) => line.includes("3 x Copper Ore"))).toBe(true);
});

test("finishGather: a session whose connection object changed under the same id is still written to", async () => {
  const { outcome, added, out } = await finishDuring(() => playerCache.set("21", { ...playerCache.get("21"), wt: { readyState: 1, send() {} } }));
  expect(outcome).toMatchObject({ ok: true, item: "Copper Ore", quantity: 3 });
  expect(added).toEqual([["gina", "Copper Ore", 3]]);
  expect(out.error).toEqual([]);
});

test("finishGather: a node that is no longer mirrored is someone else's, and the owner is not asked", async () => {
  const { asked } = neighbour(() => ({ ok: true, node: node9, item: "Copper Ore", quantity: 3 }));
  addPlayer("21", "gina");
  gathering.removeRemoteGatherNode(node9.id);
  expect(await gathering.finishGather("21", 9201)).toEqual({ ok: false, reason: REASONS.lost });
  expect(asked).toEqual([]);
});

test("the owner's handler serves a neighbour's request on this node's service, over the snapshot", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  restores.push(() => caller.detach());
  const own = { ...node9, id: 9301 };
  spy(gathering.spawner, "get", (id: number) => (id === own.id ? own : undefined));
  mirrorPlayers.set("31", stands(own, { id: "31", username: "rita", mirrorFrom: "a" }));
  const ask = async (gatherer: Partial<RemoteGatherer>) => {
    const outcome = await caller.call<any>("b", "GATHER_REQUEST", { phase: "start", nodeId: own.id, gatherer: { ...remote(own, { id: "31", username: "rita", layerId: "L1" }), ...gatherer } });
    return outcome.ok ? outcome.answer : outcome;
  };
  // This node has no player 31: the rules see the snapshot, or the node would answer that there is nothing there.
  expect(await ask({})).toEqual({ ok: true, node: own });
  await settle();
  // Their room is theirs to say, not this node's bags.
  expect(await ask({ hasRoom: false })).toEqual({ ok: false, reason: REASONS.full });
  // The request names the mirror that came from the caller.
  expect(await ask({ username: "mallory" })).toEqual({ ok: false, reason: REASONS.gone });
  expect(await ask({ id: "32", username: "rita" })).toEqual({ ok: false, reason: REASONS.gone });
});

// ------------------------------------------------------------------ the receiver's castGather
// socket/receiver.ts cannot be imported by a test (it imports the server, which starts it), so, as the other
// receiver tests do, castGather is read from its source and run with the names it uses handed in. The stand-in
// for the gathering system has startGather and finishGather and nothing else: a cast that still asks
// gathering.service would throw.
const receiverSource = readReceiverSource();
const castStart = receiverSource.indexOf("async function castGather(");
const castEnd = receiverSource.indexOf("/** Breaks a player's cast home", castStart);
if (castStart < 0 || castEnd < 0) throw new Error("castGather was not found in socket/receiver.ts");
const castGatherOf = new Function(
  `"use strict";\n${new Bun.Transpiler({ loader: "ts" }).transformSync(
    `function make({ gathering, GATHER_REASONS, sendPacket, packetManager, playerCache, sendPositionAnimation, broadcastCastToAOI, interruptPlayerCast, spellEffects, listener, Events, inventory, patchInventoryBagSlots, getInventorySlots }: any) { let globalStateRevision = 0;\n${receiverSource.slice(castStart, castEnd)}\nreturn castGather; }`,
  )}\nreturn make;`,
)();

function casting(start: any, finish: any) {
  const sent: string[] = [];
  const emitted: any[] = [];
  const asked: any[] = [];
  const caster: any = { id: "21", username: "gina", wt: { id: "wt" }, location: { map: "main.json", position: { x: 1, y: 2, direction: "down" } } };
  const cache = new Map<string, any>([["21", caster]]);
  const cast = castGatherOf({
    gathering: {
      GATHER_CAST_MS: 0,
      startGather: async (...args: any[]) => (asked.push(["start", ...args]), start),
      finishGather: async (...args: any[]) => (asked.push(["finish", ...args]), finish),
    },
    GATHER_REASONS: REASONS,
    sendPacket: (_wt: any, packets: any[]) => { sent.push(packets[0]); },
    packetManager: new Proxy({}, { get: (_t, kind) => (data: any) => [`${String(kind)}:${JSON.stringify(data)}`] }),
    playerCache: { get: (id: string) => cache.get(id), set: (id: string, player: any) => cache.set(id, player) },
    sendPositionAnimation: async () => {},
    broadcastCastToAOI: () => {},
    interruptPlayerCast: async () => { sent.push("interrupted"); },
    spellEffects: { isStunned: () => false },
    listener: { emit: (event: string, payload: any) => { emitted.push([event, payload]); } },
    Events: { GATHER_COMPLETED: "gather" },
    inventory: { get: async () => [] },
    patchInventoryBagSlots: async (rows: any[]) => rows,
    getInventorySlots: async () => 10,
  });
  return { cast: () => cast(caster, 9201), sent, emitted, asked, caster };
}

test("castGather checks the start and the end of the cast through the gathering entry points", async () => {
  const won = casting({ ok: true, node: node9 }, { ok: true, node: node9, item: "Copper Ore", quantity: 3 });
  await won.cast();
  expect(won.asked).toEqual([["start", "21", 9201], ["finish", "21", 9201]]);
  expect(won.emitted).toEqual([["gather", { player: won.caster, item: "Copper Ore", quantity: 3 }]]);
  const refused = casting({ ok: false, reason: REASONS.far }, null);
  await refused.cast();
  expect(refused.asked).toEqual([["start", "21", 9201]]);
  expect(refused.sent[0]).toContain(REASONS.far);
  const lost = casting({ ok: true, node: node9 }, { ok: false, reason: REASONS.lost });
  await lost.cast();
  expect(lost.emitted).toEqual([]);
  expect(lost.sent.some((line) => line.includes(REASONS.lost))).toBe(true);
});
