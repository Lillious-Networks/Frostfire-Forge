import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  COOLDOWN_MS, CreatureHandoff, RESERVE_MS, SWEEP_GRACE_MS, type CreatureHandoffDeps,
} from "../cluster/creaturehandoff";
import { LinkCalls } from "../cluster/linkcalls";
import log from "../modules/logger";
import { linkMesh, settle, type MeshLink } from "./cluster-fakelink";

// Three nodes. "a" owns x < 1000 of "main", "b" owns 1000 to 1999, "c" owns 2000 and up.
const ownerAt = (_map: string, x: number) => (x < 1000 ? "a" : x < 2000 ? "b" : "c");

type Node = {
  name: string;
  handoff: CreatureHandoff;
  calls: LinkCalls;
  creatures: Map<number, any>;
  away: Map<number, { holder: string; templateId: number }>;
  foreign: Map<number, string>;
  log: string[];
  clock: { now: number };
  deps: CreatureHandoffDeps;
};

function node(name: string, link: MeshLink, over: Partial<CreatureHandoffDeps> = {}, opts: { outboxLimit?: number } = {}): Node {
  const calls = new LinkCalls(500);
  calls.attach(link);
  const creatures = new Map<number, any>();
  const away = new Map<number, { holder: string; templateId: number }>();
  const foreign = new Map<number, string>();
  const steps: string[] = [];
  const clock = { now: 1_000_000 };
  const deps: CreatureHandoffDeps = {
    calls,
    ghosts: {
      handOver: (kind, id, to) => { steps.push(`handOver ${kind} ${id} ${to}`); },
      adoptMirror: (kind, record, from) => { steps.push(`adoptMirror ${kind} ${record.id} ${from}`); return true; },
    },
    self: name,
    ownerAt,
    now: () => clock.now,
    creature: (id) => { const c = creatures.get(id); return c && !c.remote ? c : null; },
    serialize: (c) => ({ id: c.id, templateId: c.templateId, map: c.map, x: c.x, y: c.y, health: c.health }),
    arrive: (s, home) => {
      creatures.set(s.id, { ...s, layerId: null, state: "idle", casting: null, remote: false, handoff: false });
      if (home) foreign.set(s.id, home);
      else away.delete(s.id);
      steps.push(`arrive ${s.id} ${home}`);
      return true;
    },
    toMirror: (c, to) => { c.remote = true; steps.push(`toMirror ${c.id} ${to}`); },
    ghostRecord: (c) => ({ id: c.id }),
    templateKnown: (id) => id === 1,
    templateName: (id) => (id === 1 ? "Wolf" : `template ${id}`),
    ownsSlot: () => true,
    spawner: {
      markAway: (id, holder) => { away.set(id, { holder, templateId: 1 }); steps.push(`markAway ${id} ${holder}`); return true; },
      moveAway: (id, holder) => { const slot = away.get(id); if (!slot) return false; slot.holder = holder; steps.push(`moveAway ${id} ${holder}`); return true; },
      releaseAway: (id, _now, o) => { const had = away.delete(id); if (had) steps.push(`releaseAway ${id} ${o?.respawn}`); return had; },
      dropForeign: (id) => { foreign.delete(id); steps.push(`dropForeign ${id}`); },
      foreignHome: (id) => foreign.get(id) ?? null,
      awaySlots: () => [...away].map(([instanceId, s]) => ({ instanceId, spawnId: 1, layerId: null, poolId: null, templateId: s.templateId, holder: s.holder })),
      foreignCreatures: () => [...foreign].map(([instanceId, home]) => ({ instanceId, home })),
    },
    despawnForeign: (id) => { creatures.delete(id); foreign.delete(id); steps.push(`despawnForeign ${id}`); },
    forward: (id, to) => { steps.push(`forward ${id} ${to}`); },
    ...over,
  };
  const handoff = new CreatureHandoff(opts);
  handoff.start(deps);
  return { name, handoff, calls, creatures, away, foreign, log: steps, clock, deps };
}

function cluster(over: Record<string, Partial<CreatureHandoffDeps>> = {}, opts: { outboxLimit?: number } = {}) {
  const mesh = linkMesh(["a", "b", "c"] as const);
  return {
    mesh,
    a: node("a", mesh.a, over.a, opts),
    b: node("b", mesh.b, over.b, opts),
    c: node("c", mesh.c, over.c, opts),
  };
}

const wolf = (over: any = {}): any => ({ id: 5, templateId: 1, map: "main", layerId: null, x: 1200, y: 50, health: 40, state: "idle", casting: null, remote: false, handoff: false, ...over });

let nodes: Node[] = [];
let warnings: string[];
let warnSpy: { mockRestore(): void };
beforeEach(() => {
  warnings = [];
  warnSpy = spyOn(log, "warn").mockImplementation((message: string) => { warnings.push(String(message)); });
});
afterEach(() => {
  for (const n of nodes) { n.handoff.stop(); n.calls.detach(); }
  nodes = [];
  warnSpy.mockRestore();
});
const track = <T extends { a: Node; b: Node; c: Node }>(x: T) => { nodes.push(x.a, x.b, x.c); return x; };

test("a creature moves to the node whose block it entered; its home keeps the slot", async () => {
  const { a, b } = track(cluster());
  const c = wolf();
  a.creatures.set(5, c);
  expect(await a.handoff.handOff(c, "b")).toBe("moved");
  await settle();
  // Guard: the order of step 6. The mirrors are handed over before the copy becomes a mirror.
  expect(a.log).toEqual(["handOver creature 5 b", "markAway 5 b", "toMirror 5 b", "adoptMirror creature 5 b", "forward 5 b"]);
  expect(a.deps.creature(5)).toBeNull();
  expect(a.away.get(5)?.holder).toBe("b");
  expect(b.deps.creature(5)?.health).toBe(40);
  expect(b.foreign.get(5)).toBe("a");
  expect(c.handoff).toBe(false);
});

test("a commit that cannot be sent changes nothing", async () => {
  const { a, b } = track(cluster());
  const c = wolf();
  a.creatures.set(5, c);
  const cast = a.calls.cast.bind(a.calls);
  a.calls.cast = (peer, name, body) => (name === "CREATURE_HANDOFF_COMMIT" ? false : cast(peer, name, body));
  // Guard: the check of the commit cast's result. Without it A gives up a creature B never got.
  expect(await a.handoff.handOff(c, "b")).toBe("refused");
  await settle();
  expect(a.deps.creature(5)).toBe(c);
  expect(a.away.size).toBe(0);
  expect(b.deps.creature(5)).toBeNull();
});

test("a node with a live copy refuses, and the holder cools down", async () => {
  const { a, b } = track(cluster());
  const c = wolf();
  a.creatures.set(5, c);
  b.creatures.set(5, wolf());
  // Guard: the "here" check on the reserving node.
  expect(await a.handoff.handOff(c, "b")).toBe("refused");
  expect(a.deps.creature(5)).toBe(c);
  // Guard: the cooldown.
  expect(await a.handoff.handOff(c, "b")).toBe("busy");
  a.clock.now += COOLDOWN_MS + 1;
  b.creatures.delete(5);
  expect(await a.handoff.handOff(c, "b")).toBe("moved");
});

test("a reservation held by another node refuses", async () => {
  const { a, b, c: third } = track(cluster());
  const c = wolf();
  a.creatures.set(5, c);
  const first = await third.calls.call<any>("b", "CREATURE_HANDOFF", { id: 5, templateId: 1, map: "main", x: 1200, y: 50, home: "c" });
  expect(first.ok && first.answer.ok).toBe(true);
  // Guard: the "reserved" check.
  expect(await a.handoff.handOff(c, "b")).toBe("refused");
  b.clock.now += RESERVE_MS + 1;
  a.clock.now += COOLDOWN_MS + 1;
  expect(await a.handoff.handOff(c, "b")).toBe("moved");
});

test("a node that does not own the point refuses", async () => {
  const { a } = track(cluster({ b: { ownerAt: () => "c" } }));
  const c = wolf();
  a.creatures.set(5, c);
  // Guard: the "owner" check.
  expect(await a.handoff.handOff(c, "b")).toBe("refused");
});

test("an unknown template refuses", async () => {
  const { a } = track(cluster({ b: { templateKnown: () => false } }));
  const c = wolf();
  a.creatures.set(5, c);
  // Guard: the "template" check.
  expect(await a.handoff.handOff(c, "b")).toBe("refused");
});

test("a home whose away slot another node holds refuses its return", async () => {
  const { a, b } = track(cluster());
  const c = wolf();
  a.creatures.set(5, c);
  a.foreign.set(5, "b");
  b.away.set(5, { holder: "c", templateId: 1 });
  // Guard: the "slot" check. Without it a stale copy comes home beside the real one.
  expect(await a.handoff.handOff(c, "b")).toBe("refused");
});

test("a creature that cannot go now is not offered", async () => {
  const { a } = track(cluster({ a: { ownsSlot: (c) => c.id !== 9 } }));
  let calls = 0;
  const call = a.calls.call.bind(a.calls);
  a.calls.call = ((...args: Parameters<typeof call>) => { calls++; return call(...args); }) as typeof call;
  // Guard: each of the start checks.
  expect(await a.handoff.handOff(wolf({ handoff: true }), "b")).toBe("busy");
  expect(await a.handoff.handOff(wolf({ remote: true }), "b")).toBe("busy");
  expect(await a.handoff.handOff(wolf({ state: "dead" }), "b")).toBe("busy");
  expect(await a.handoff.handOff(wolf({ casting: { spellId: 1 } }), "b")).toBe("busy");
  expect(await a.handoff.handOff(wolf({ id: 9 }), "b")).toBe("busy");
  expect(calls).toBe(0);
});

test("the handoff flag is cleared whatever the outcome", async () => {
  const { a, b } = track(cluster());
  const c = wolf();
  a.creatures.set(5, c);
  b.creatures.set(5, wolf());
  await a.handoff.handOff(c, "b");
  // Guard: the finally that clears c.handoff.
  expect(c.handoff).toBe(false);
});

test("a creature that died during the call is not handed over", async () => {
  const { a, b } = track(cluster());
  const c = wolf();
  a.creatures.set(5, c);
  const call = a.calls.call.bind(a.calls);
  a.calls.call = (async (...args: Parameters<typeof call>) => {
    const outcome = await call(...args);
    c.state = "dead";
    return outcome;
  }) as typeof call;
  // Guard: the second check after the call.
  expect(await a.handoff.handOff(c, "b")).toBe("gone");
  await settle();
  expect(b.deps.creature(5)).toBeNull();
  expect(a.away.size).toBe(0);
});

for (const [what, change] of [
  ["despawned", (n: Node) => { n.creatures.delete(5); }],
  ["turned into a mirror", (n: Node) => { n.creatures.get(5).remote = true; }],
] as const) {
  test(`a creature ${what} during the call is not handed over`, async () => {
    const { a, b } = track(cluster());
    const c = wolf();
    a.creatures.set(5, c);
    const call = a.calls.call.bind(a.calls);
    a.calls.call = (async (...args: Parameters<typeof call>) => {
      const outcome = await call(...args);
      change(a);
      return outcome;
    }) as typeof call;
    // Guard: the live and remote halves of the check after the call.
    expect(await a.handoff.handOff(c, "b")).toBe("gone");
    await settle();
    expect(b.deps.creature(5)).toBeNull();
    expect(a.away.size).toBe(0);
  });
}

test("a commit after its reservation expired is lost by name", async () => {
  const { a, b } = track(cluster());
  a.away.set(5, { holder: "b", templateId: 1 });
  const reserve = await a.calls.call<any>("b", "CREATURE_HANDOFF", { id: 5, templateId: 1, map: "main", x: 1200, y: 50, home: "a" });
  expect(reserve.ok && reserve.answer.ok).toBe(true);
  b.clock.now += RESERVE_MS + 1;
  (b.handoff as any).onCommit({ creature: { id: 5, templateId: 1, map: "main", x: 1200, y: 50 }, home: "a" }, "a");
  await settle();
  // Guard: the expiry half of the reservation check in onCommit.
  expect(b.deps.creature(5)).toBeNull();
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("lost"))).toBe(true);
  expect(a.log).toContain("releaseAway 5 true");
});

test("a creature that cannot be placed is lost by name and its home respawns it", async () => {
  const { a, b } = track(cluster({ b: { arrive: () => false } }));
  const c = wolf();
  a.creatures.set(5, c);
  expect(await a.handoff.handOff(c, "b")).toBe("moved");
  await settle();
  await settle();
  // Guard: the result of arrive in onCommit.
  expect(b.deps.creature(5)).toBeNull();
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("lost"))).toBe(true);
  expect(a.away.has(5)).toBe(false);
  expect(a.log).toContain("releaseAway 5 true");
});

test("the home's sweep frees a slot whose holder says it sent the creature home", async () => {
  const { a, c } = track(cluster());
  c.away.set(5, { holder: "a", templateId: 1 });
  // A handed it to C, and the commit was lost: A answers "moved to c", but C has no live copy.
  (a.handoff as any).handedTo.set(5, { to: "c", at: a.clock.now });
  await c.handoff.sweep();
  c.clock.now += SWEEP_GRACE_MS;
  await c.handoff.sweep();
  // Guard: `answer.to !== deps.self` in the sweep. Without it the slot points at C itself and is never freed.
  expect(c.away.has(5)).toBe(false);
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("lost"))).toBe(true);
});

test("a commit with no reservation loses the creature by name and frees its slot", async () => {
  const { b } = track(cluster());
  b.away.set(5, { holder: "a", templateId: 1 });
  // A commit from A that B never reserved (it expired): B is the home.
  (b.handoff as any).onCommit({ creature: { id: 5, templateId: 1, map: "main", x: 1200, y: 50 }, home: "b" }, "a");
  // Guard: the reservation check in onCommit, and the release on loss.
  expect(b.deps.creature(5)).toBeNull();
  expect(b.away.has(5)).toBe(false);
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("lost"))).toBe(true);
});

test("a lost commit from a node that does not hold the away slot leaves the slot to its holder", async () => {
  const { b } = track(cluster());
  b.away.set(5, { holder: "c", templateId: 1 });
  (b.handoff as any).onCommit({ creature: { id: 5, templateId: 1, map: "main", x: 1200, y: 50 }, home: "b" }, "a");
  // Guard: the holder check in lost(). Freeing the slot would respawn the creature while C has it live.
  expect(b.deps.creature(5)).toBeNull();
  expect(b.away.get(5)?.holder).toBe("c");
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("lost"))).toBe(true);
});

test("a lost creature whose home is a third node is reported there", async () => {
  const { b, c } = track(cluster());
  c.away.set(5, { holder: "a", templateId: 1 });
  (b.handoff as any).onCommit({ creature: { id: 5, templateId: 1, map: "main", x: 1200, y: 50 }, home: "c" }, "a");
  await settle();
  // Guard: CREATURE_DIED { respawn: true } to the home on loss.
  expect(c.away.has(5)).toBe(false);
  expect(c.log).toContain("releaseAway 5 true");
});

test("a commit from another node than the one that reserved is lost, and the reservation stays", async () => {
  const { a, b } = track(cluster());
  const reserve = await a.calls.call<any>("b", "CREATURE_HANDOFF", { id: 5, templateId: 1, map: "main", x: 1200, y: 50, home: "a" });
  expect(reserve.ok && reserve.answer.ok).toBe(true);
  (b.handoff as any).onCommit({ creature: { id: 5, templateId: 1, map: "main", x: 1200, y: 50 }, home: "a" }, "c");
  // Guard: r.from === from in onCommit.
  expect(b.deps.creature(5)).toBeNull();
  (b.handoff as any).onCommit({ creature: { id: 5, templateId: 1, map: "main", x: 1200, y: 50 }, home: "a" }, "a");
  expect(b.deps.creature(5)?.id).toBe(5);
});

test("a commit never makes a second live copy", async () => {
  const { a, b } = track(cluster());
  const reserve = await a.calls.call<any>("b", "CREATURE_HANDOFF", { id: 5, templateId: 1, map: "main", x: 1200, y: 50, home: "a" });
  expect(reserve.ok && reserve.answer.ok).toBe(true);
  const existing = wolf({ health: 7 });
  b.creatures.set(5, existing);
  (b.handoff as any).onCommit({ creature: { id: 5, templateId: 1, map: "main", x: 1200, y: 50, health: 40 }, home: "a" }, "a");
  // Guard: the live-copy check in onCommit.
  expect(b.creatures.get(5)).toBe(existing);
  expect(b.log.filter((l) => l.startsWith("arrive"))).toEqual([]);
});

test("a creature coming home whose away slot went in the reservation window is lost by name, not kept uncounted", async () => {
  const { a, b } = track(cluster());
  const c = wolf();
  a.creatures.set(5, c);
  a.foreign.set(5, "b");
  b.away.set(5, { holder: "a", templateId: 1 });
  // A data reload on B releases the away slot between the reservation and the commit.
  const cast = a.calls.cast.bind(a.calls);
  a.calls.cast = (peer, name, body) => {
    if (name === "CREATURE_HANDOFF_COMMIT") b.away.delete(5);
    return cast(peer, name, body);
  };
  expect(await a.handoff.handOff(c, "b")).toBe("moved");
  await settle();
  // Guard: the away-slot recheck in onCommit (R13). Without it B makes the creature live with no slot counting it.
  expect(b.deps.creature(5)).toBeNull();
  expect(b.log.filter((l) => l.startsWith("arrive"))).toEqual([]);
  expect(b.log.filter((l) => l.startsWith("releaseAway"))).toEqual([]);
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("lost"))).toBe(true);
});

test("a creature coming home is refused when its away slot moved to another holder in the window", async () => {
  const { a, b } = track(cluster());
  b.away.set(5, { holder: "a", templateId: 1 });
  const reserve = await a.calls.call<any>("b", "CREATURE_HANDOFF", { id: 5, templateId: 1, map: "main", x: 1200, y: 50, home: "b" });
  expect(reserve.ok && reserve.answer.ok).toBe(true);
  b.away.set(5, { holder: "c", templateId: 1 });
  (b.handoff as any).onCommit({ creature: { id: 5, templateId: 1, map: "main", x: 1200, y: 50 }, home: "b" }, "a");
  // Guard: the holder half of the away-slot recheck in onCommit (R13). The slot stays with the node that holds it.
  expect(b.deps.creature(5)).toBeNull();
  expect(b.away.get(5)?.holder).toBe("c");
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("lost"))).toBe(true);
});

test("an abort from another node does not drop the reservation", async () => {
  const { a, c } = track(cluster());
  await a.calls.call<any>("b", "CREATURE_HANDOFF", { id: 5, templateId: 1, map: "main", x: 1200, y: 50, home: "a" });
  c.calls.cast("b", "CREATURE_HANDOFF_ABORT", { id: 5 });
  await settle();
  // Guard: r.from === from in onAbort.
  const again = await c.calls.call<any>("b", "CREATURE_HANDOFF", { id: 5, templateId: 1, map: "main", x: 1200, y: 50, home: "a" });
  expect(again.ok && again.answer.reason).toBe("reserved");
});

test("the home learns when its creature moves on between two other nodes", async () => {
  const { a, b, c } = track(cluster());
  const wolfOnA = wolf();
  a.creatures.set(5, wolfOnA);
  a.foreign.set(5, "c");
  c.away.set(5, { holder: "a", templateId: 1 });
  expect(await a.handoff.handOff(wolfOnA, "b")).toBe("moved");
  await settle();
  await settle();
  // Guard: CREATURE_MOVED to a home that is neither side.
  expect(c.away.get(5)?.holder).toBe("b");
  expect(a.log).toContain("dropForeign 5");
  expect(b.foreign.get(5)).toBe("c");
});

test("CREATURE_MOVED from a node that does not hold the slot is ignored", async () => {
  const { b, c } = track(cluster());
  c.away.set(5, { holder: "a", templateId: 1 });
  await b.calls.call("c", "CREATURE_MOVED", { id: 5, holder: "b" });
  // Guard: the holder check in onMoved.
  expect(c.away.get(5)?.holder).toBe("a");
});

test("a creature handed back to its home takes its slot again", async () => {
  const { a, b } = track(cluster());
  const c = wolf();
  a.creatures.set(5, c);
  a.foreign.set(5, "b");
  b.away.set(5, { holder: "a", templateId: 1 });
  expect(await a.handoff.handOff(c, "b")).toBe("moved");
  await settle();
  expect(b.away.has(5)).toBe(false);
  expect(b.deps.creature(5)?.id).toBe(5);
  expect(b.foreign.has(5)).toBe(false);
  expect(a.log.some((l) => l.startsWith("markAway"))).toBe(false);
});

test("a death on the holder reaches the home, after the link is back", async () => {
  const { mesh, a, c } = track(cluster());
  c.away.set(5, { holder: "a", templateId: 1 });
  mesh.a.setUp("c", false);
  a.handoff.died(5, 1, "c", { respawn: true, delayMs: null });
  await settle();
  expect(c.away.has(5)).toBe(true);
  expect(a.handoff.outboxSize()).toBe(1);
  // Guard: the outbox and its flush on onPeerUp.
  mesh.a.setUp("c", true);
  await settle();
  await settle();
  expect(c.away.has(5)).toBe(false);
  expect(a.handoff.outboxSize()).toBe(0);
});

test("a full outbox drops its oldest entry by name", async () => {
  const { mesh, a } = track(cluster({}, { outboxLimit: 2 }));
  mesh.a.setUp("c", false);
  for (const id of [5, 6, 7]) a.handoff.died(id, 1, "c", { respawn: true, delayMs: null });
  await settle();
  // Guard: the limit, and its log line.
  expect(a.handoff.outboxSize()).toBe(2);
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("5") && w.includes("dropped"))).toBe(true);
});

test("the home's sweep frees a slot whose holder lost the creature, after the grace", async () => {
  const { a, c } = track(cluster());
  c.away.set(5, { holder: "a", templateId: 1 });
  await c.handoff.sweep();
  // Guard: the grace. One "gone" answer is not enough.
  expect(c.away.has(5)).toBe(true);
  // Nor a second one sooner than the grace after the first.
  c.clock.now += SWEEP_GRACE_MS - 1;
  await c.handoff.sweep();
  expect(c.away.has(5)).toBe(true);
  c.clock.now += 1;
  await c.handoff.sweep();
  expect(c.away.has(5)).toBe(false);
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("5"))).toBe(true);
  expect(a.creatures.size).toBe(0);
});

test("the home's sweep keeps a slot whose holder still has the creature", async () => {
  const { a, c } = track(cluster());
  c.away.set(5, { holder: "a", templateId: 1 });
  a.creatures.set(5, wolf());
  await c.handoff.sweep();
  c.clock.now += SWEEP_GRACE_MS;
  await c.handoff.sweep();
  expect(c.away.has(5)).toBe(true);
});

test("the home's sweep follows a creature that moved on", async () => {
  const { a, b, c } = track(cluster());
  const wolfOnA = wolf();
  a.creatures.set(5, wolfOnA);
  a.foreign.set(5, "c");
  c.away.set(5, { holder: "a", templateId: 1 });
  // The CREATURE_MOVED is lost: the link to C is down while A hands the creature to B.
  const real = a.calls.call.bind(a.calls);
  a.calls.call = ((peer: string, name: string, body: unknown, opts?: any) =>
    name === "CREATURE_MOVED" ? Promise.resolve({ ok: false, why: "down" }) : real(peer, name, body, opts)) as typeof real;
  expect(await a.handoff.handOff(wolfOnA, "b")).toBe("moved");
  await settle();
  expect(c.away.get(5)?.holder).toBe("a");
  // Guard: the "moved" answer of CREATURE_HELD.
  await c.handoff.sweep();
  expect(c.away.get(5)?.holder).toBe("b");
  expect(b.deps.creature(5)?.id).toBe(5);
});

test("the holder's sweep removes a foreign creature its home has no slot for, after the grace", async () => {
  const { b } = track(cluster());
  b.creatures.set(5, wolf());
  b.foreign.set(5, "c");
  await b.handoff.sweep();
  expect(b.creatures.has(5)).toBe(true);
  b.clock.now += SWEEP_GRACE_MS - 1;
  await b.handoff.sweep();
  expect(b.creatures.has(5)).toBe(true);
  b.clock.now += 1;
  // Guard: CREATURE_SLOT { gone: true }, with the grace.
  await b.handoff.sweep();
  expect(b.creatures.has(5)).toBe(false);
  expect(b.log).toContain("despawnForeign 5");
});

test("a sweep that cannot reach the other side changes nothing", async () => {
  const { mesh, c } = track(cluster());
  c.away.set(5, { holder: "a", templateId: 1 });
  mesh.c.setUp("a", false);
  await c.handoff.sweep();
  c.clock.now += SWEEP_GRACE_MS * 2;
  await c.handoff.sweep();
  // Guard: `if (!outcome.ok) continue`. A down link is not a lost creature.
  expect(c.away.has(5)).toBe(true);
});

// --- Review fixes (M1 to M8) ---

/** Run `fn` on node `n` once its CREATURE_HANDOFF call has its answer, before handOff goes on. */
function afterCall(n: Node, fn: () => void) {
  const call = n.calls.call.bind(n.calls);
  n.calls.call = (async (...args: Parameters<typeof call>) => {
    const outcome = await call(...args);
    if (args[1] === "CREATURE_HANDOFF") fn();
    return outcome;
  }) as typeof call;
}

const commitBody = (over: any = {}) => ({ creature: { id: 5, templateId: 1, map: "main", x: 1200, y: 50, ...over.creature }, home: over.home ?? "a" });
const reserveAt = async (from: Node, to: string, home = "a") => {
  const r = await from.calls.call<any>(to, "CREATURE_HANDOFF", { id: 5, templateId: 1, map: "main", x: 1200, y: 50, home });
  expect(r.ok && r.answer.ok).toBe(true);
};

test("a toMirror that throws after the commit still leaves no live copy here", async () => {
  const { a, b } = track(cluster({ a: { toMirror: () => { throw new Error("boom"); } } }));
  const c = wolf();
  a.creatures.set(5, c);
  expect(await a.handoff.handOff(c, "b")).toBe("moved");
  await settle();
  // Guard (M1): the fallback that marks the copy a mirror, and the steps after it still run.
  expect(c.remote).toBe(true);
  expect(a.deps.creature(5)).toBeNull();
  expect(a.log).toEqual(["handOver creature 5 b", "markAway 5 b", "adoptMirror creature 5 b", "forward 5 b"]);
  expect(b.deps.creature(5)?.id).toBe(5);
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("failed") && w.includes("boom"))).toBe(true);
});

test("a hand-over of the mirrors that throws does not stop the copy becoming a mirror", async () => {
  const { a } = track(cluster({ a: { ghosts: { handOver: () => { throw new Error("boom"); }, adoptMirror: () => true } } }));
  const c = wolf();
  a.creatures.set(5, c);
  expect(await a.handoff.handOff(c, "b")).toBe("moved");
  // Guard (M1): each part of step 6 runs on its own.
  expect(a.log).toEqual(["markAway 5 b", "toMirror 5 b", "forward 5 b"]);
  expect(a.deps.creature(5)).toBeNull();
});

test("a slot that cannot be kept away is logged by name", async () => {
  const { a } = track(cluster());
  a.deps.spawner.markAway = () => false;
  const c = wolf();
  a.creatures.set(5, c);
  expect(await a.handoff.handOff(c, "b")).toBe("moved");
  // Guard (M8): the result of markAway.
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("no live slot"))).toBe(true);
});

test("an arrive that throws before placing the creature loses it by name and its home respawns it", async () => {
  const { a, b } = track(cluster({ b: { arrive: () => { throw new Error("boom"); } } }));
  const c = wolf();
  a.creatures.set(5, c);
  expect(await a.handoff.handOff(c, "b")).toBe("moved");
  await settle();
  await settle();
  // Guard (M2): the catch around arrive.
  expect(b.deps.creature(5)).toBeNull();
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("lost"))).toBe(true);
  expect(a.log).toContain("releaseAway 5 true");
});

test("an arrive that throws after placing the creature keeps it, and frees nothing", async () => {
  const { a, b } = track(cluster());
  const arrive = b.deps.arrive;
  b.deps.arrive = (s, home) => { arrive(s, home); throw new Error("late"); };
  const c = wolf();
  a.creatures.set(5, c);
  expect(await a.handoff.handOff(c, "b")).toBe("moved");
  await settle();
  await settle();
  // Guard (M2): a copy that became live before the throw is not reported lost.
  expect(b.deps.creature(5)?.id).toBe(5);
  expect(a.away.get(5)?.holder).toBe("b");
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("live here"))).toBe(true);
});

test("a commit with a string id is refused as malformed", async () => {
  const { a, b } = track(cluster());
  await reserveAt(a, "b");
  (b.handoff as any).onCommit(commitBody({ creature: { id: "5" } }), "a");
  // Guard (M3): isId on the commit's id.
  expect(b.log.filter((l) => l.startsWith("arrive"))).toEqual([]);
  expect(warnings.some((w) => w.includes("malformed"))).toBe(true);
});

for (const [what, body] of [
  ["another home", commitBody({ home: "c" })],
  ["another template", commitBody({ creature: { templateId: 2 } })],
  ["no position", commitBody({ creature: { x: "far" } })],
  ["no map", commitBody({ creature: { map: 7 } })],
] as const) {
  test(`a commit for ${what} than its reservation is lost, and the reserved home is told`, async () => {
    const { a, b, c } = track(cluster());
    a.away.set(5, { holder: "b", templateId: 1 });
    c.away.set(5, { holder: "b", templateId: 1 });
    await reserveAt(a, "b");
    (b.handoff as any).onCommit(body, "a");
    await settle();
    // Guard (M3): the commit is bound to its reservation.
    expect(b.log.filter((l) => l.startsWith("arrive"))).toEqual([]);
    expect(warnings.some((w) => w.includes("Wolf") && w.includes("does not match"))).toBe(true);
    expect(a.log).toContain("releaseAway 5 true");
    expect(c.away.has(5)).toBe(true);
  });
}

test("a stale commit replayed after the creature moved on frees no slot at a third home", async () => {
  const { mesh, a, b, c } = track(cluster());
  const wolfOnA = wolf();
  a.creatures.set(5, wolfOnA);
  a.foreign.set(5, "c");
  c.away.set(5, { holder: "a", templateId: 1 });
  expect(await a.handoff.handOff(wolfOnA, "b")).toBe("moved");
  await settle();
  const replay = mesh.a.sent.find((m) => (m.data as any)?.name === "CREATURE_HANDOFF_COMMIT")!.data as any;
  // B hands it back to A, then the first commit arrives at B a second time.
  b.deps.creature(5)!.x = 500;
  a.creatures.delete(5);
  expect(await b.handoff.handOff(b.deps.creature(5)!, "a")).toBe("moved");
  await settle();
  await settle();
  expect(c.away.get(5)?.holder).toBe("a");
  (b.handoff as any).onCommit(replay.body, "a");
  await settle();
  await settle();
  // Guard (M3): lost() frees nothing for a creature this node handed on since.
  expect(a.deps.creature(5)?.id).toBe(5);
  expect(c.away.get(5)?.holder).toBe("a");
  expect(c.log.filter((l) => l.startsWith("releaseAway"))).toEqual([]);
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("stale"))).toBe(true);
});

test("a stale commit replayed after the creature moved on frees no slot at its home", async () => {
  const { mesh, a, b } = track(cluster());
  const wolfOnA = wolf();
  a.creatures.set(5, wolfOnA);
  a.foreign.set(5, "b");
  b.away.set(5, { holder: "a", templateId: 1 });
  expect(await a.handoff.handOff(wolfOnA, "b")).toBe("moved");
  await settle();
  const replay = mesh.a.sent.find((m) => (m.data as any)?.name === "CREATURE_HANDOFF_COMMIT")!.data as any;
  b.deps.creature(5)!.x = 500;
  a.creatures.delete(5);
  expect(await b.handoff.handOff(b.deps.creature(5)!, "a")).toBe("moved");
  await settle();
  expect(b.away.get(5)?.holder).toBe("a");
  (b.handoff as any).onCommit(replay.body, "a");
  // Guard (M3): the same, when this node is the home and the replaying node holds the slot.
  expect(a.deps.creature(5)?.id).toBe(5);
  expect(b.away.get(5)?.holder).toBe("a");
});

test("CREATURE_MOVED to an empty holder or to the home itself is ignored", async () => {
  const { a, c } = track(cluster());
  c.away.set(5, { holder: "a", templateId: 1 });
  await a.calls.call("c", "CREATURE_MOVED", { id: 5, holder: "" });
  await a.calls.call("c", "CREATURE_MOVED", { id: 5, holder: "c" });
  // Guard (M3): a holder the sweep could never ask.
  expect(c.away.get(5)?.holder).toBe("a");
});

test("CREATURE_DIED with an unbounded delay rolls the slot's own", async () => {
  const { a, c } = track(cluster());
  const asked: Array<number | null | undefined> = [];
  c.deps.spawner.releaseAway = (_id, _now, o) => { asked.push(o?.delayMs); return true; };
  await a.calls.call("c", "CREATURE_DIED", { id: 5, respawn: true, delayMs: 1e12 });
  await a.calls.call("c", "CREATURE_DIED", { id: 5, respawn: true, delayMs: 3_000 });
  // Guard (M3): the bound on delayMs.
  expect(asked).toEqual([null, 3_000]);
});

test("sweeps do not overlap", async () => {
  const { c } = track(cluster());
  c.away.set(5, { holder: "a", templateId: 1 });
  let held = 0;
  const call = c.calls.call.bind(c.calls);
  c.calls.call = ((...args: Parameters<typeof call>) => { if (args[1] === "CREATURE_HELD") held++; return call(...args); }) as typeof call;
  await Promise.all([c.handoff.sweep(), c.handoff.sweep(), c.handoff.sweep()]);
  // Guard (M4): the re-entrancy flag.
  expect(held).toBe(1);
  await c.handoff.sweep();
  expect(held).toBe(2);
});

test("a slow peer does not hold up the sweep's checks of another", async () => {
  const { c } = track(cluster());
  c.away.set(5, { holder: "a", templateId: 1 });
  c.away.set(6, { holder: "b", templateId: 1 });
  const asked: string[] = [];
  let release!: () => void;
  const call = c.calls.call.bind(c.calls);
  c.calls.call = (async (...args: Parameters<typeof call>) => {
    if (args[1] === "CREATURE_HELD") asked.push(args[0]);
    if (args[1] === "CREATURE_HELD" && args[0] === "a") await new Promise<void>((resolve) => { release = resolve; });
    return call(...args);
  }) as typeof call;
  const sweep = c.handoff.sweep();
  await settle();
  // Guard (M4): the peers are asked in parallel.
  expect(asked).toEqual(["a", "b"]);
  release();
  await sweep;
});

test("a call that fails at the peer is dropped by name and does not block that peer's queue", async () => {
  const { mesh, a, c } = track(cluster());
  c.away.set(6, { holder: "a", templateId: 1 });
  const release = c.deps.spawner.releaseAway;
  c.deps.spawner.releaseAway = (id, now, o) => { if (id === 5) throw new Error("boom"); return release(id, now, o); };
  mesh.a.setUp("c", false);
  a.handoff.died(5, 1, "c", { respawn: true, delayMs: null });
  a.handoff.died(6, 1, "c", { respawn: true, delayMs: null });
  await settle();
  mesh.a.setUp("c", true);
  for (let i = 0; i < 4; i++) await settle();
  // Guard (M6): a "failed" answer drops the entry instead of keeping it at the head of the queue.
  expect(c.away.has(6)).toBe(false);
  expect(a.handoff.outboxSize()).toBe(0);
  expect(warnings.some((w) => w.includes("Wolf (5)") && w.includes("failed"))).toBe(true);
});

test("a link that comes back while a flush is still running is not missed", async () => {
  const { mesh, a, c } = track(cluster());
  c.away.set(5, { holder: "a", templateId: 1 });
  mesh.a.setUp("c", false);
  a.handoff.died(5, 1, "c", { respawn: true, delayMs: null });
  // The first flush is still waiting on its "down" answer when the link comes back.
  mesh.a.setUp("c", true);
  for (let i = 0; i < 3; i++) await settle();
  // Guard: the flush runs again when it was asked for while running.
  expect(c.away.has(5)).toBe(false);
  expect(a.handoff.outboxSize()).toBe(0);
});

test("the sweep forgets expired reservations, cooldowns and settled suspicions", async () => {
  const { a, b, c } = track(cluster());
  await reserveAt(a, "b");
  b.clock.now += RESERVE_MS + 1;
  await b.handoff.sweep();
  // Guard (M7): pruning of each map.
  expect((b.handoff as any).reserved.size).toBe(0);
  const w = wolf();
  a.creatures.set(5, w);
  b.creatures.set(5, wolf());
  expect(await a.handoff.handOff(w, "b")).toBe("refused");
  expect((a.handoff as any).cooling.size).toBe(1);
  a.clock.now += COOLDOWN_MS;
  await a.handoff.sweep();
  expect((a.handoff as any).cooling.size).toBe(0);
  c.away.set(7, { holder: "a", templateId: 1 });
  await c.handoff.sweep();
  expect((c.handoff as any).suspects.size).toBe(1);
  c.away.delete(7);
  await c.handoff.sweep();
  expect((c.handoff as any).suspects.size).toBe(0);
});

test("a creature that started a cast during the call is not handed over", async () => {
  const { a, b } = track(cluster());
  const c = wolf();
  a.creatures.set(5, c);
  afterCall(a, () => { c.casting = { spellId: 1 }; });
  // Guard (M8): the casting recheck after the call.
  expect(await a.handoff.handOff(c, "b")).toBe("busy");
  await settle();
  expect(a.deps.creature(5)).toBe(c);
  expect(b.deps.creature(5)).toBeNull();
  expect(a.handoff.coolingDown(5)).toBe(true);
});

test("a creature whose own slot went during the call is not handed over", async () => {
  let owns = true;
  const { a, b } = track(cluster({ a: { ownsSlot: () => owns } }));
  const c = wolf();
  a.creatures.set(5, c);
  afterCall(a, () => { owns = false; });
  // Guard (M8): the ownsSlot recheck after the call.
  expect(await a.handoff.handOff(c, "b")).toBe("gone");
  await settle();
  expect(a.deps.creature(5)).toBe(c);
  expect(b.deps.creature(5)).toBeNull();
});

test("a creature whose home changed during the call is not handed over", async () => {
  const { a, b } = track(cluster());
  const c = wolf();
  a.creatures.set(5, c);
  a.foreign.set(5, "c");
  afterCall(a, () => { a.foreign.delete(5); });
  // Guard (M8): the home recheck after the call.
  expect(await a.handoff.handOff(c, "b")).toBe("gone");
  await settle();
  expect(b.deps.creature(5)).toBeNull();
});
