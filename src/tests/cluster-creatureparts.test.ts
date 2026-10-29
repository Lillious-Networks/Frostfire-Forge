import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { CreatureRegistry } = await import("../systems/creatures/registry");
const { CreatureSpawner, OUTGOING_KEEP_MS } = await import("../systems/creatures/spawner");
const { normalizeSpawn, normalizeTemplate, normalizeSpawnPool } = await import("../systems/creatures/repository");
const { CreatureHandoff } = await import("../cluster/creaturehandoff");
const { LinkCalls } = await import("../cluster/linkcalls");
const { creatureSlotsPart, isMovedSlot, CREATURE_SLOTS_PART } = await import("../cluster/kinds/creatureparts");
const { default: log } = await import("../modules/logger");
const { linkMesh, settle } = await import("./cluster-fakelink");
import type { CreatureHandoffDeps } from "../cluster/creaturehandoff";
import type { MovedSlot } from "../systems/creatures/spawner";
import type { MeshLink } from "./cluster-fakelink";

const template = (over: any = {}) => normalizeTemplate({ id: 1, name: "Wolf", level_min: 3, level_max: 5, health_base: 50, health_per_level: 10, ...over });
const spawn = (over: any = {}) => normalizeSpawn({ id: 1, template_id: 1, map: "main", x: 100, y: 200, respawn_min_s: 10, respawn_max_s: 20, layer_policy: "shared", ...over });
// Block 0,0 of main (blocks are 4096 px).
const inMain00 = (map: string, x: number, y: number) => map === "main" && x < 4096 && y < 4096;

let warnings: string[];
let warnSpy: { mockRestore(): void };
beforeEach(() => {
  warnings = [];
  warnSpy = spyOn(log, "warn").mockImplementation((message: string) => { warnings.push(String(message)); });
});
afterEach(() => warnSpy.mockRestore());

/** One node's spawner. `owns`: what its spawnsHere says for every point (the block table's answer). */
function side(opts: { spawns?: any[]; pools?: any[]; owns?: boolean } = {}) {
  const registry = new CreatureRegistry(64);
  const events: string[] = [];
  const state = { owns: opts.owns ?? true };
  const spawner = new CreatureSpawner(registry, {
    onSpawn: (c) => events.push(`spawn:${c.id}`),
    onDespawn: (c) => events.push(`despawn:${c.id}`),
    onForeignGone: (c, home) => events.push(`gone:${c.id}:${home}`),
    spawnsHere: () => state.owns,
  }, () => 0, 1);
  spawner.load({
    templates: new Map([[1, template()]]),
    spawns: new Map((opts.spawns ?? [spawn()]).map((s) => [s.id, s])),
    pools: new Map((opts.pools ?? []).map((p) => [p.id, p])),
    patrolPaths: new Map(),
  }, 1_000);
  return { registry, spawner, events, state };
}

// ---- the spawner

test("a live slot goes out held by the old owner, whose creature stays as the new owner's foreign one", () => {
  const f = side();
  const t = side({ owns: false });
  const id = f.spawner.getLiveInstanceId(1)!;
  const slots = f.spawner.exportSlots(inMain00, "t", "f", 2_000);
  expect(slots).toEqual([{ kind: "held", spawnId: 1, layerId: null, instanceId: id, poolId: null, templateId: 1, holder: "f" }]);
  expect(f.spawner.getLiveInstanceId(1)).toBeUndefined();
  expect(f.registry.get(id)).toBeDefined();
  expect(f.spawner.foreignHome(id)).toBe("t");
  // Still moving: no home is answered until the move is decided.
  expect(f.spawner.outgoingHome(id, 2_000)).toBeNull();
  expect(f.spawner.outgoingHome(id, 2_000 + OUTGOING_KEEP_MS + 1)).toBeNull();
  expect(t.spawner.importSlots(slots, 2_000, "t")).toBe(1);
  expect(t.spawner.awaySlots()).toEqual([{ instanceId: id, spawnId: 1, layerId: null, poolId: null, templateId: 1, holder: "f" }]);
  // The coordinator commits: the table says t. The slot is away, so t spawns nothing for it.
  t.state.owns = true;
  t.spawner.reviewOwnership(3_000);
  t.spawner.tick(10_000_000);
  expect([...t.registry.all()]).toHaveLength(0);
  // Its death on f goes to t, its new home.
  f.spawner.despawn(id, 4_000);
  expect(f.events).toContain(`gone:${id}:t`);
  expect(f.spawner.getPendingAt(1)).toBeUndefined();
});

test("a waiting slot goes with the time it has left, and the old owner does not spawn it", () => {
  const f = side();
  const t = side({ owns: false });
  f.spawner.despawn(f.spawner.getLiveInstanceId(1)!, 2_000, { delayMs: 7_000 });
  expect(f.spawner.getPendingAt(1)).toBe(9_000);
  const slots = f.spawner.exportSlots(inMain00, "t", "f", 3_000);
  expect(slots).toEqual([{ kind: "waiting", spawnId: 1, layerId: null, inMs: 6_000 }]);
  expect(f.spawner.getPendingAt(1)).toBeUndefined();
  // The table still says f until the coordinator commits the move.
  f.spawner.reviewOwnership(4_000);
  f.spawner.tick(20_000);
  // Guard: reviewOwnership skips outgoing slots. Without it f schedules the slot it just gave away, and it spawns on both nodes.
  expect(f.spawner.getPendingAt(1)).toBeUndefined();
  expect([...f.registry.all()]).toHaveLength(0);
  t.spawner.importSlots(slots, 10_000, "t");
  expect(t.spawner.getPendingAt(1)).toBe(16_000);
});

test("an outgoing slot whose move never committed is spawned again by the old owner at its own due time", () => {
  const f = side();
  f.spawner.despawn(f.spawner.getLiveInstanceId(1)!, 2_000, { delayMs: 100_000 });
  f.spawner.exportSlots(inMain00, "t", "f", 3_000);
  f.spawner.reviewOwnership(3_000 + OUTGOING_KEEP_MS + 1);
  // Guard: reviewOwnership schedules at the later of now and the slot's due time. Without it a slot given away and
  // taken back respawns at once.
  expect(f.spawner.getPendingAt(1)).toBe(102_000);
});

test("a move held undecided: its slots stay moving past OUTGOING_KEEP_MS, and nothing is spawned or handed on", () => {
  const f = side();
  const id = f.spawner.getLiveInstanceId(1)!;
  const part = creatureSlotsPart({ self: "f", now: () => 2_000, spawner: f.spawner, tellHome: () => true });
  const move = { id: "o", map: "main", bx: 0, by: 0, from: "f", to: "t" };
  const slots = f.spawner.exportSlots(inMain00, "t", "f", 2_000);
  void part.hold!(move, slots, 5 * OUTGOING_KEEP_MS);
  const late = 2_000 + OUTGOING_KEEP_MS + 1;
  // Guard: holdSlots. Without it the entry is pruned at OUTGOING_KEEP_MS: the creature may be handed on while the move
  // is undecided, and the slot is scheduled afresh, so a restore finds two.
  expect(f.spawner.movingOut(id, late)).toBe(true);
  f.spawner.reviewOwnership(late);
  f.spawner.tick(late + 1_000_000);
  expect(f.spawner.getLiveInstanceId(1)).toBeUndefined();
  expect(f.registry.get(id)).toBeDefined();
  expect(f.events).not.toContain(`despawn:${id}`);
  // The hold ends with the hold, not before.
  expect(f.spawner.movingOut(id, 2_000 + 5 * OUTGOING_KEEP_MS + 1)).toBe(false);
});

test("an away slot goes with its holder and with its place in the pool", () => {
  const pool = normalizeSpawnPool({ id: 5, max_active: 1 });
  const f = side({ spawns: [spawn({ pool_id: 5 })], pools: [pool] });
  const t = side({ spawns: [spawn({ pool_id: 5 })], pools: [pool], owns: false });
  const id = f.spawner.getLiveInstanceId(1)!;
  f.spawner.markAway(id, "c");
  f.registry.remove(id);
  const slots = f.spawner.exportSlots(inMain00, "t", "f", 2_000);
  expect(slots).toEqual([{ kind: "held", spawnId: 1, layerId: null, instanceId: id, poolId: 5, templateId: 1, holder: "c" }]);
  // Guard: exportSlots takes the creature out of the old owner's pool. Without it f counts a creature it no longer answers for.
  expect(f.spawner.activeInPool(5)).toBe(0);
  t.spawner.importSlots(slots, 2_000, "t");
  // Guard: importSlots puts it in the new owner's pool. Without it t spawns a second member while c's lives.
  expect(t.spawner.activeInPool(5)).toBe(1);
  expect(t.spawner.awaySlots()[0]?.holder).toBe("c");
});

test("a move that did not happen puts the slots back as they were", () => {
  const f = side();
  const id = f.spawner.getLiveInstanceId(1)!;
  const slots = f.spawner.exportSlots(inMain00, "t", "f", 2_000);
  expect(f.spawner.importSlots(slots, 2_500, "f")).toBe(1);
  expect(f.spawner.getLiveInstanceId(1)).toBe(id);
  expect(f.spawner.foreignHome(id)).toBeNull();
  expect(f.spawner.outgoingHome(id, 2_500)).toBeNull();
  // The slot is f's again: its creature's death respawns it here.
  f.spawner.despawn(id, 3_000, { delayMs: 1_000 });
  expect(f.spawner.getPendingAt(1)).toBe(4_000);
  expect(f.events).not.toContain(`gone:${id}:t`);
});

test("a slot held by the new owner becomes its live slot", () => {
  const f = side();
  const t = side({ owns: false });
  const id = f.spawner.getLiveInstanceId(1)!;
  const wolf = f.registry.get(id)!;
  f.spawner.markAway(id, "t");
  f.registry.remove(id);
  t.spawner.adopt({ ...wolf }, "f");
  t.spawner.importSlots(f.spawner.exportSlots(inMain00, "t", "f", 2_000), 2_000, "t");
  expect(t.spawner.getLiveInstanceId(1)).toBe(id);
  expect(t.spawner.foreignHome(id)).toBeNull();
  expect(t.spawner.awaySlots()).toEqual([]);
  // Its death is t's own now: no word to f.
  t.spawner.despawn(id, 3_000, { delayMs: 1_000 });
  expect(t.events).not.toContain(`gone:${id}:f`);
  expect(t.spawner.getPendingAt(1)).toBe(4_000);
});

test("a slot held by the new owner whose creature is only a mirror there respawns on its roll", () => {
  const f = side();
  const t = side({ owns: false });
  const id = f.spawner.getLiveInstanceId(1)!;
  const wolf = f.registry.get(id)!;
  f.spawner.markAway(id, "t");
  f.registry.remove(id);
  // t handed the creature on, or it died: what t has left is a mirror, not a foreign creature.
  t.registry.add({ ...wolf, remote: true });
  t.spawner.importSlots(f.spawner.exportSlots(inMain00, "t", "f", 2_000), 2_000, "t");
  // Guard: the creature must be t's foreign one. Without it the slot is set live for a mirror and never spawns again.
  expect(t.spawner.getLiveInstanceId(1)).toBeUndefined();
  expect(t.spawner.getPendingAt(1)).toBe(12_000);
});

test("a slot the new owner already has live is not taken twice", () => {
  const f = side();
  const t = side();
  const mine = t.spawner.getLiveInstanceId(1)!;
  // Guard: the live-or-away check. Without it t holds two wolves for one slot.
  expect(t.spawner.importSlots(f.spawner.exportSlots(inMain00, "t", "f", 2_000), 2_000, "t")).toBe(0);
  expect(t.spawner.getLiveInstanceId(1)).toBe(mine);
  expect(t.spawner.awaySlots()).toEqual([]);
  expect(warnings.some((w) => w.includes("Wolf") && w.includes("already held here"))).toBe(true);
});

test("a held slot whose creature is already foreign here is taken as held here, whatever its holder says (P2)", () => {
  // c held the wolf (an away slot on f) and handed it to t during the move; t's commit came before the slot's accept.
  const f = side();
  const t = side({ owns: false });
  const id = f.spawner.getLiveInstanceId(1)!;
  const wolf = f.registry.get(id)!;
  f.spawner.markAway(id, "c");
  f.registry.remove(id);
  t.spawner.adopt({ ...wolf }, "f");
  const slots = f.spawner.exportSlots(inMain00, "t", "f", 2_000);
  expect(slots[0]).toMatchObject({ kind: "held", holder: "c" });
  expect(t.spawner.importSlots(slots, 2_000, "t")).toBe(1);
  // Guard: the foreign check before the away branch. Without it t holds the slot away at c and the wolf foreign at
  // once; its sweep hears "moved to t" from c, frees the slot and spawns a second wolf.
  expect(t.spawner.getLiveInstanceId(1)).toBe(id);
  expect(t.spawner.foreignHome(id)).toBeNull();
  expect(t.spawner.awaySlots()).toEqual([]);
  t.state.owns = true;
  t.spawner.reviewOwnership(3_000);
  t.spawner.tick(10_000_000);
  expect([...t.registry.all()].map((c) => c.id)).toEqual([id]);
});

test("a foreign creature that is only a mirror here does not take its slot live", () => {
  const f = side();
  const t = side({ owns: false });
  const id = f.spawner.getLiveInstanceId(1)!;
  const wolf = f.registry.get(id)!;
  f.spawner.markAway(id, "c");
  f.registry.remove(id);
  t.spawner.adopt({ ...wolf }, "f");
  t.registry.get(id)!.remote = true;
  t.spawner.importSlots(f.spawner.exportSlots(inMain00, "t", "f", 2_000), 2_000, "t");
  // Guard: the remote check. Without it the slot is set live for a mirror, and c's live wolf is a second one.
  expect(t.spawner.getLiveInstanceId(1)).toBeUndefined();
  expect(t.spawner.awaySlots()[0]?.holder).toBe("c");
});

test("a moved wait is capped at a day", () => {
  const t = side({ owns: false });
  t.spawner.importSlots([{ kind: "waiting", spawnId: 1, layerId: null, inMs: 1e12 }], 2_000, "t");
  // Guard: MAX_MOVED_WAIT_MS. Without it a corrupt wait parks the slot for decades.
  expect(t.spawner.getPendingAt(1)).toBe(2_000 + 24 * 60 * 60_000);
});

test("an outgoing slot answers its new home only once its move is sent", () => {
  const f = side();
  const id = f.spawner.getLiveInstanceId(1)!;
  const slots = f.spawner.exportSlots(inMain00, "t", "f", 2_000);
  // Guard: the moving check in outgoingHome (ownership M2). A move put back keeps the slot here.
  expect(f.spawner.outgoingHome(id, 2_000)).toBeNull();
  f.spawner.settleSlots(slots);
  expect(f.spawner.outgoingHome(id, 2_000)).toBe("t");
  expect(f.spawner.outgoingHome(id, 2_000 + OUTGOING_KEEP_MS + 1)).toBeNull();
});

test("forgetOutgoingTo drops only the sent outgoing slots of a dead new owner", () => {
  const f = side({ spawns: [spawn({ id: 1 }), spawn({ id: 2, x: 5_000 })] });
  const one = f.spawner.getLiveInstanceId(1)!;
  const two = f.spawner.getLiveInstanceId(2)!;
  const toT = f.spawner.exportSlots(inMain00, "t", "f", 2_000);
  f.spawner.settleSlots(f.spawner.exportSlots((map, x) => map === "main" && x >= 4096, "u", "f", 2_000));
  // Guard: a slot still moving is kept. Without it its creature could be handed on before a restore.
  expect(f.spawner.forgetOutgoingTo("t")).toBe(0);
  expect(f.spawner.movingOut(one, 2_000)).toBe(true);
  f.spawner.settleSlots(toT);
  expect(f.spawner.movingOut(one, 2_000)).toBe(false);
  expect(f.spawner.forgetOutgoingTo("t")).toBe(1);
  expect(f.spawner.outgoingHome(one, 2_000)).toBeNull();
  expect(f.spawner.outgoingHome(two, 2_000)).toBe("u");
});

test("a slot with no spawn point here is dropped with a warning", () => {
  const t = side({ spawns: [] });
  expect(t.spawner.importSlots([{ kind: "waiting", spawnId: 1, layerId: null, inMs: 0 }], 2_000, "t")).toBe(0);
  expect(warnings.some((w) => w.includes("no spawn point here"))).toBe(true);
});

test("releaseAwayHeldBy frees only the dead holder's slots; dropForeignFrom removes its creatures without a word", () => {
  const f = side({ spawns: [spawn({ id: 1 }), spawn({ id: 2, x: 300 })] });
  const one = f.spawner.getLiveInstanceId(1)!;
  const two = f.spawner.getLiveInstanceId(2)!;
  f.spawner.markAway(one, "c");
  f.registry.remove(one);
  f.spawner.markAway(two, "d");
  f.registry.remove(two);
  expect(f.spawner.releaseAwayHeldBy("c", 5_000)).toBe(1);
  expect(f.spawner.getPendingAt(1)).toBe(15_000);
  expect(f.spawner.awaySlots().map((s) => s.holder)).toEqual(["d"]);

  const home = side();
  const wolf = home.registry.get(home.spawner.getLiveInstanceId(1)!)!;
  const holder = side({ spawns: [] });
  holder.spawner.adopt({ ...wolf, id: 901 }, "c");
  holder.spawner.adopt({ ...wolf, id: 902 }, "d");
  expect(holder.spawner.dropForeignFrom("c")).toBe(1);
  expect(holder.registry.get(901)).toBeUndefined();
  expect(holder.spawner.foreignHome(902)).toBe("d");
  // Guard: no onForeignGone. The dead home cannot be told, and the message would sit in the outbox for nothing.
  expect(holder.events).toEqual(["despawn:901"]);
});

test("rehome moves a foreign creature's home; to this node only when its away slot is here", () => {
  const home = side();
  const wolf = home.registry.get(home.spawner.getLiveInstanceId(1)!)!;
  const t = side({ spawns: [] });
  t.spawner.adopt({ ...wolf }, "f");
  expect(t.spawner.rehome(wolf.id, "t2")).toBe(true);
  expect(t.spawner.foreignHome(wolf.id)).toBe("t2");
  // Guard: a move home needs the away slot. Without it a creature with no slot here would count as live here.
  expect(t.spawner.rehome(wolf.id, null)).toBe(false);
  expect(t.spawner.foreignHome(wolf.id)).toBe("t2");
  expect(t.spawner.rehome(12_345, "x")).toBe(false);

  // importSlots and adopt never leave a creature both foreign and away here any more (P2), so the state rehome(null)
  // repairs is built by hand: the away slot first, then the creature marked foreign.
  const u = side({ owns: false });
  u.spawner.importSlots([{ kind: "held", spawnId: 1, layerId: null, instanceId: wolf.id, poolId: null, templateId: 1, holder: "c" }], 2_000, "u");
  u.registry.add({ ...wolf });
  (u.spawner as any).foreign.set(wolf.id, "f");
  expect(u.spawner.rehome(wolf.id, null)).toBe(true);
  expect(u.spawner.getLiveInstanceId(1)).toBe(wolf.id);
  expect(u.spawner.awaySlots()).toEqual([]);
  expect(u.spawner.foreignHome(wolf.id)).toBeNull();
});

// ---- the creature handoff

type HNode = ReturnType<typeof hnode>;

function hnode(name: string, link: MeshLink) {
  const calls = new LinkCalls(500);
  calls.attach(link);
  const away = new Map<number, string>();
  const foreign = new Map<number, string>();
  const outgoing = new Map<number, string>();
  // Outgoing slots whose move is not decided yet: the spawner answers no home for them (outgoingHome).
  const moving = new Set<number>();
  const templates = new Map<number, number>();
  const steps: string[] = [];
  const deps: CreatureHandoffDeps = {
    calls,
    ghosts: { handOver: () => {}, adoptMirror: () => true },
    self: name,
    ownerAt: () => name,
    now: () => 1_000_000,
    creature: () => null,
    serialize: (c) => ({ id: c.id, templateId: c.templateId, map: c.map, x: c.x, y: c.y }),
    arrive: () => true,
    toMirror: () => {},
    ghostRecord: (c) => ({ id: c.id }),
    templateKnown: () => true,
    templateName: () => "Wolf",
    ownsSlot: () => true,
    spawner: {
      markAway: () => true,
      moveAway: (id, holder) => { if (!away.has(id)) return false; away.set(id, holder); steps.push(`moveAway ${id} ${holder}`); return true; },
      releaseAway: (id, _now, o) => { const had = away.delete(id); if (had) steps.push(`releaseAway ${id} ${o?.respawn} ${o?.delayMs}`); return had; },
      dropForeign: (id) => { foreign.delete(id); },
      foreignHome: (id) => foreign.get(id) ?? null,
      awaySlots: () => [...away].map(([instanceId, holder]) => ({ instanceId, spawnId: 1, layerId: null, poolId: null, templateId: 1, holder })),
      foreignCreatures: () => [...foreign].map(([instanceId, home]) => ({ instanceId, home })),
      outgoingHome: (id) => (moving.has(id) ? null : outgoing.get(id) ?? null),
      movingOut: (id) => moving.has(id),
      outgoingTemplate: (id) => templates.get(id) ?? null,
      rehome: (id, home) => {
        if (!foreign.has(id)) return false;
        steps.push(`rehome ${id} ${home}`);
        if (home === null) foreign.delete(id);
        else foreign.set(id, home);
        return true;
      },
    },
    despawnForeign: (id) => { foreign.delete(id); steps.push(`despawnForeign ${id}`); },
    forward: () => {},
  };
  const handoff = new CreatureHandoff();
  handoff.start(deps);
  return { name, handoff, calls, away, foreign, outgoing, moving, templates, steps };
}

let hnodes: HNode[] = [];
afterEach(() => {
  for (const n of hnodes) { n.handoff.stop(); n.calls.detach(); }
  hnodes = [];
});
function four() {
  const mesh = linkMesh(["f", "t", "c", "d"] as const);
  const nodes = { f: hnode("f", mesh.f), t: hnode("t", mesh.t), c: hnode("c", mesh.c), d: hnode("d", mesh.d) };
  hnodes.push(...Object.values(nodes));
  return nodes;
}
const twice = async () => { await settle(); await settle(); };

test("a CREATURE_DIED for a slot that moved with its block goes on to the new home", async () => {
  const { f, t, c } = four();
  f.outgoing.set(5, "t");
  t.away.set(5, "c");
  const answer = await c.calls.call<any>("f", "CREATURE_DIED", { id: 5, respawn: true, delayMs: 1_000 });
  expect(answer.ok).toBe(true);
  await twice();
  // Guard: the outgoing forward in onDied. Without it the slot stays away on t for good: the creature is dead.
  expect(t.steps).toEqual(["releaseAway 5 true 1000"]);
  expect(t.away.has(5)).toBe(false);
});

test("CREATURE_SLOT answers not gone for a slot that moved with its block", async () => {
  const { f, c } = four();
  f.outgoing.set(5, "t");
  // Guard: the outgoing check in onSlot. Without it c's sweep removes a creature whose slot is on t.
  expect(((await c.calls.call<any>("f", "CREATURE_SLOT", { id: 5 })) as any).answer).toEqual({ gone: false });
  f.outgoing.delete(5);
  expect(((await c.calls.call<any>("f", "CREATURE_SLOT", { id: 5 })) as any).answer).toEqual({ gone: true });
  // Guard: movedTo ignores a move to this node. Without it f answers for a slot it already took back.
  f.outgoing.set(5, "f");
  expect(((await c.calls.call<any>("f", "CREATURE_SLOT", { id: 5 })) as any).answer).toEqual({ gone: true });
});

test("a forwarded CREATURE_DIED that cannot be delivered is logged by the creature's name", async () => {
  const { f, t, c } = four();
  f.outgoing.set(5, "t");
  f.templates.set(5, 1);
  // t has no handler: the call fails there and the entry is dropped.
  t.handoff.stop();
  await c.calls.call<any>("f", "CREATURE_DIED", { id: 5, respawn: true, delayMs: null });
  await twice();
  expect(warnings.some((w) => w.includes("CREATURE_DIED for creature Wolf (5) to t dropped"))).toBe(true);
});

test("a CREATURE_MOVED for a slot that moved tells the new holder the new home", async () => {
  const { f, c, d } = four();
  f.outgoing.set(5, "t");
  d.foreign.set(5, "f");
  await c.calls.call<any>("f", "CREATURE_MOVED", { id: 5, holder: "d" });
  await twice();
  // Guard: the CREATURE_HOME cast in onMoved. Without it d asks f about the slot, and removes the creature once f forgets it.
  expect(d.foreign.get(5)).toBe("t");
  expect(d.steps).toEqual(["rehome 5 t"]);
});

test("a CREATURE_DIED for a slot still moving out is kept in the sender's outbox, and goes on to the new home once the move is sent", async () => {
  // Ownership M2: forwarded while undecided, a move put back would leave the slot here and the report on the wrong node.
  const { f, t, c } = four();
  f.outgoing.set(5, "t");
  f.moving.add(5);
  t.away.set(5, "c");
  c.handoff.died(5, 1, "f", { respawn: true, delayMs: 1_000 });
  await twice();
  // Guard: the moving refusal in onDied. Answered ok, the report would leave c's outbox and be lost.
  expect(c.handoff.outboxSize()).toBe(1);
  expect(t.steps).toEqual([]);
  expect(f.steps).toEqual([]);
  // The move is sent: the next sweep sends the report again, and f forwards it.
  f.moving.delete(5);
  await c.handoff.sweep();
  await twice();
  expect(c.handoff.outboxSize()).toBe(0);
  expect(t.steps).toEqual(["releaseAway 5 true 1000"]);
});

test("a refused report does not hold up the ones behind it for the same peer", async () => {
  const { f, c } = four();
  f.outgoing.set(5, "t");
  f.moving.add(5);
  f.away.set(6, "c");
  c.handoff.died(5, 1, "f", { respawn: true, delayMs: null });
  c.handoff.died(6, 1, "f", { respawn: true, delayMs: 2_000 });
  await twice();
  // Guard: the deferred set in flush. Without it 6 waits behind 5 until 5's move is decided.
  expect(f.steps).toEqual(["releaseAway 6 true 2000"]);
  expect(c.handoff.outboxSize()).toBe(1);
});

test("a CREATURE_MOVED for a slot still moving out is refused, and tells the new holder the new home once the move is sent", async () => {
  const { f, c, d } = four();
  f.outgoing.set(5, "t");
  f.moving.add(5);
  d.foreign.set(5, "f");
  // Guard: the moving refusal in onMoved. A move put back keeps the slot on f: d must not be told t.
  expect(((await c.calls.call<any>("f", "CREATURE_MOVED", { id: 5, holder: "d" })) as any).answer).toEqual({ ok: false, reason: "moving" });
  await twice();
  expect(d.steps).toEqual([]);
  // A holder's sweep meanwhile finds the slot not gone.
  expect(((await c.calls.call<any>("f", "CREATURE_SLOT", { id: 5 })) as any).answer).toEqual({ gone: false });
  f.moving.delete(5);
  expect(((await c.calls.call<any>("f", "CREATURE_MOVED", { id: 5, holder: "d" })) as any).answer).toEqual({ ok: true });
  await twice();
  expect(d.steps).toEqual(["rehome 5 t"]);
});

test("CREATURE_HOME is taken only from the creature's home, and home to this node rehomes it here", async () => {
  const { f, c, d } = four();
  d.foreign.set(5, "f");
  c.calls.cast("d", "CREATURE_HOME", { id: 5, home: "c" });
  await twice();
  // Guard: the from check in onHome. Without it any node could take a creature's slot over.
  expect(d.foreign.get(5)).toBe("f");
  expect(f.handoff.tellHome("d", 5, "d")).toBe(true);
  await twice();
  expect(d.steps).toEqual(["rehome 5 null"]);
  expect(d.foreign.has(5)).toBe(false);
});

test("an outbox entry too big to send is dropped by name and does not hold up the ones behind it", async () => {
  const sent: number[] = [];
  const fake = {
    handle: () => () => {},
    onCast: () => () => {},
    onPeerUp: () => () => {},
    cast: () => true,
    call: async (_peer: string, _name: string, body: any) => {
      sent.push(body.id);
      return body.id === 1 ? { ok: false, why: "too-big", unsent: true } : { ok: true, answer: { ok: true } };
    },
  };
  const handoff = new CreatureHandoff();
  handoff.start({
    calls: fake as any,
    ghosts: { handOver: () => {}, adoptMirror: () => true },
    self: "f",
    ownerAt: () => "f",
    now: () => 1_000_000,
    creature: () => null,
    serialize: (c) => ({ id: c.id, templateId: c.templateId, map: c.map, x: c.x, y: c.y }),
    arrive: () => true,
    toMirror: () => {},
    ghostRecord: (c) => ({ id: c.id }),
    templateKnown: () => true,
    templateName: () => "Wolf",
    ownsSlot: () => true,
    spawner: {
      markAway: () => true, moveAway: () => true, releaseAway: () => true, dropForeign: () => {},
      foreignHome: () => null, awaySlots: () => [], foreignCreatures: () => [],
    },
    despawnForeign: () => {},
    forward: () => {},
  });
  try {
    handoff.died(1, 1, "h", { respawn: true, delayMs: null });
    handoff.died(2, 1, "h", { respawn: true, delayMs: null });
    await twice();
    // Guard: too-big is dropped, not kept. Without it the entry stays at the head of the outbox and is tried again
    // before every later one, so the second death never reaches its home.
    expect(sent).toEqual([1, 2]);
    expect(handoff.outboxSize()).toBe(0);
    expect(warnings.some((w) => w.includes("Wolf (1)") && w.includes("too big"))).toBe(true);
  } finally {
    handoff.stop();
  }
});

// ---- the move window: a creature whose slot is moving out stays put until the move is sent or restored

let started: Array<InstanceType<typeof CreatureHandoff>> = [];
afterEach(() => {
  for (const h of started) h.stop();
  started = [];
});

/** The real spawner of `node` behind a handoff whose every call is answered yes. */
function handing(node: ReturnType<typeof side>, self: string) {
  const handoff = new CreatureHandoff();
  handoff.start({
    calls: {
      handle: () => () => {},
      onCast: () => () => {},
      onPeerUp: () => () => {},
      cast: () => true,
      call: async () => ({ ok: true, answer: { ok: true } }),
    } as any,
    ghosts: { handOver: () => {}, adoptMirror: () => true },
    self,
    ownerAt: () => self,
    now: () => 2_000,
    creature: (id) => { const c = node.registry.get(id); return c && !c.remote ? c : null; },
    serialize: (c) => ({ id: c.id, templateId: c.templateId, map: c.map, x: c.x, y: c.y }),
    arrive: () => true,
    toMirror: (c) => { c.remote = true; },
    ghostRecord: (c) => ({ id: c.id }),
    templateKnown: () => true,
    templateName: () => "Wolf",
    ownsSlot: (c) => node.spawner.getLiveInstanceId(c.spawnId, c.layerId) === c.id,
    spawner: node.spawner,
    despawnForeign: () => {},
    forward: () => {},
  });
  started.push(handoff);
  return handoff;
}

const realPart = (node: ReturnType<typeof side>) =>
  creatureSlotsPart({ self: "f", now: () => 2_000, spawner: node.spawner, tellHome: () => true });

test("a creature whose slot is moving out is not handed on, so a restore finds it here (P1)", async () => {
  const f = side();
  const id = f.spawner.getLiveInstanceId(1)!;
  const wolf = f.registry.get(id)!;
  const handoff = handing(f, "f");
  const part = realPart(f);
  const data = await part.collect(move);
  // Guard: the in-move check in handOff. Without it f hands the wolf to d; the restore then finds no foreign wolf,
  // respawns the slot on its roll, and d still holds the first wolf: two wolves for one slot.
  expect(await handoff.handOff(wolf, "d")).toBe("busy");
  expect(await handoff.handOff(wolf, "t")).toBe("busy");
  expect(wolf.remote).toBeFalsy();
  await part.restore(move, data);
  expect(f.spawner.getLiveInstanceId(1)).toBe(id);
  f.spawner.tick(10_000_000);
  expect([...f.registry.all()].filter((c) => !c.remote).map((c) => c.id)).toEqual([id]);
  // The restore ended the move: the wolf may walk on again.
  expect(await handoff.handOff(wolf, "d")).toBe("moved");
});

test("once the move is sent, the creature hands off to its new owner at once", async () => {
  const f = side();
  const id = f.spawner.getLiveInstanceId(1)!;
  const wolf = f.registry.get(id)!;
  const handoff = handing(f, "f");
  const part = realPart(f);
  const data = await part.collect(move);
  await part.sent!(move, data);
  // Guard: sent settles the slot. Without it the wolf is frozen on f for OUTGOING_KEEP_MS in a block t now owns.
  expect(await handoff.handOff(wolf, "t")).toBe("moved");
  expect(f.spawner.foreignHome(id)).toBeNull();
  expect(wolf.remote).toBe(true);
  // f still answers for the slot (CREATURE_SLOT, CREATURE_DIED) for the rest of OUTGOING_KEEP_MS.
  expect(f.spawner.outgoingHome(id, 2_000)).toBe("t");
});

// ---- the block part

const sample: MovedSlot[] = [
  { kind: "held", spawnId: 1, layerId: null, instanceId: 7, poolId: null, templateId: 1, holder: "c" },
  { kind: "held", spawnId: 2, layerId: null, instanceId: 8, poolId: null, templateId: 1, holder: "t" },
  { kind: "held", spawnId: 3, layerId: null, instanceId: 9, poolId: null, templateId: 1, holder: "f" },
  { kind: "waiting", spawnId: 4, layerId: "main:layer_1", inMs: 5 },
];

function partWith() {
  const calls: string[] = [];
  const told: string[] = [];
  const part = creatureSlotsPart({
    self: "f",
    now: () => 42,
    spawner: {
      exportSlots: (inBlock, to, self, now) => { calls.push(`export ${inBlock("main", 10, 10)} ${inBlock("main", 5_000, 10)} ${to} ${self} ${now}`); return sample; },
      importSlots: (slots, now, self) => { calls.push(`import ${slots.length} ${now} ${self}`); return slots.length; },
      settleSlots: (slots) => { calls.push(`settle ${slots.length}`); },
    },
    tellHome: (holder, id, home) => { told.push(`${holder} ${id} ${home}`); return true; },
  });
  return { part, calls, told };
}
const move = { id: "m1", map: "main", bx: 0, by: 0, from: "f", to: "t" };

test("the part exports the block's slots, restores and accepts them, and tells third holders once sent", async () => {
  const { part, calls, told } = partWith();
  expect(part.name).toBe(CREATURE_SLOTS_PART);
  expect(part.order).toBe(0);
  const data = await part.collect(move);
  expect(calls).toEqual(["export true false t f 42"]);
  await part.restore(move, data);
  await part.accept(move, JSON.parse(JSON.stringify(data)), "f");
  expect(calls.slice(1)).toEqual(["import 4 42 f", "import 4 42 f"]);
  await part.sent!(move, data);
  // Guard: only third holders are told. t took its slot in accept, and f set its own creature's home in collect.
  expect(told).toEqual(["c 7 t"]);
  expect(calls.slice(3)).toEqual(["settle 4"]);
});

test("isMovedSlot refuses a spawn id that is not positive", () => {
  expect(isMovedSlot(sample[3])).toBe(true);
  // Guard: spawnId <= 0. Without it a slot key no spawn point can have travels as if real.
  expect(isMovedSlot({ ...sample[3], spawnId: 0 })).toBe(false);
  expect(isMovedSlot({ ...sample[0], spawnId: -1 })).toBe(false);
});

test("accept drops malformed slots and takes the rest", async () => {
  const { part, calls } = partWith();
  await part.accept(move, [sample[0], { kind: "held", spawnId: "1" }, null, { kind: "waiting", spawnId: 4, layerId: null, inMs: Number.POSITIVE_INFINITY }] as any, "f");
  expect(calls).toEqual(["import 1 42 f"]);
  expect(warnings.some((w) => w.includes("3 malformed creature slot(s)"))).toBe(true);
  await part.accept(move, "junk" as any, "f");
  expect(calls).toHaveLength(1);
});

test("a move lost at the deadline drops the creatures the old owner still holds for it, by name, with no respawn and no word", async () => {
  const f = side();
  const id = f.spawner.getLiveInstanceId(1)!;
  const part = realPart(f);
  const data = await part.collect(move);
  expect(f.spawner.foreignHome(id)).toBe("t");
  const errors: string[] = [];
  const errorSpy = spyOn(log, "error").mockImplementation((message: string) => { errors.push(String(message)); });
  try {
    await part.lost!(move, data);
  } finally {
    errorSpy.mockRestore();
  }
  // Guard: the drop (task 20 review I2). Kept, the wolf stays foreign here while t may hold its slot, and the slot
  // respawns here once it is no longer outgoing: two wolves for one slot.
  expect(f.registry.get(id)).toBeUndefined();
  expect(f.spawner.foreignHome(id)).toBeNull();
  expect(f.events).toContain(`despawn:${id}`);
  // No word to t: t's sweep finds the wolf gone and spawns it once, if t took the slot in.
  expect(f.events.some((event) => event.startsWith("gone:"))).toBe(false);
  expect(f.spawner.getPendingAt(1)).toBeUndefined();
  expect(errors.some((line) => line.includes(`Wolf ${id}`))).toBe(true);
});

test("a slot another node holds, in a move lost at the deadline, is held here again only once the order reads aborted, and is not spawned twice", async () => {
  for (const holder of ["x", "t"]) {
    const f = side();
    const id = f.spawner.getLiveInstanceId(1)!;
    // The holder took the wolf over earlier: its home is f, and f keeps the slot away.
    f.spawner.markAway(id, holder);
    f.registry.remove(id);
    const part = realPart(f);
    const data = await part.collect(move);
    expect(data).toEqual([{ kind: "held", spawnId: 1, layerId: null, instanceId: id, poolId: null, templateId: 1, holder }]);
    await part.lost!(move, data);
    // Guard: lost leaves the slot out (task 20 re-review N1). Held away here at once, the holder could hand the wolf
    // home to f, where it would become live while t, had it taken the slot, finds it gone and spawns a second.
    expect(f.spawner.awaySlots()).toEqual([]);
    // The order is read back aborted: t never took the slot.
    await part.lostAborted!(move, data);
    // Guard: lostAborted puts the slot back away. Without it f spawns slot 1 afresh once it no longer answers for it,
    // while the holder keeps the first wolf: two wolves for one slot.
    expect(f.spawner.awaySlots()).toEqual([{ instanceId: id, spawnId: 1, layerId: null, poolId: null, templateId: 1, holder }]);
    f.spawner.reviewOwnership(2_000 + OUTGOING_KEEP_MS + 1);
    f.spawner.tick(10_000_000);
    expect(f.spawner.getLiveInstanceId(1)).toBeUndefined();
    expect([...f.registry.all()].filter((c) => !c.remote)).toHaveLength(0);
    expect(warnings.some((line) => line.includes(`${id} at ${holder}`))).toBe(true);
  }
});

test("lostAborted leaves the old owner's own slots and waiting slots alone", async () => {
  const steps: string[] = [];
  const part = creatureSlotsPart({
    self: "f", now: () => 5, tellHome: () => true,
    spawner: {
      exportSlots: () => [],
      importSlots: (slots, now, self) => { steps.push(`import ${slots.map((s) => s.spawnId).join(",")} ${now} ${self}`); return slots.length; },
      settleSlots: () => {},
    },
  });
  const own: MovedSlot = { kind: "held", spawnId: 1, layerId: null, instanceId: 11, poolId: null, templateId: 1, holder: "f" };
  const third: MovedSlot = { kind: "held", spawnId: 2, layerId: null, instanceId: 12, poolId: null, templateId: 1, holder: "x" };
  const waiting: MovedSlot = { kind: "waiting", spawnId: 3, layerId: null, inMs: 0 };
  await part.lostAborted!(move, [own, third, waiting]);
  // Guard: only slots other nodes hold. f dropped its own creatures in lost, and its waiting slots wait here already.
  expect(steps).toEqual(["import 2 5 f"]);
  await part.lostAborted!(move, [own, waiting]);
  expect(steps).toHaveLength(1);
});
