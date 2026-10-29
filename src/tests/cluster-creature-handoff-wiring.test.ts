import { expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule, mockQuery } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
// Generated at server start and gitignored, so CI has no copy on disk.
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { default: assetCache } = await import("../services/assetCache");
const { CACHE_KEYS, normalizeSpawn, normalizeTemplate } = await import("../systems/creatures/repository");
const { createCombatState } = await import("../systems/creatures/threat");
const { createAuras } = await import("../systems/creatures/auras");
const { AIState } = await import("../systems/creatures/types");
const { creatureHandoff } = await import("../cluster/creaturehandoff");
const { forwardTable } = await import("../cluster/forwarding");
const { ghosts } = await import("../cluster/ghosts");
const { ThreatTable } = await import("../systems/creatures/threat");
const creatures = await import("../systems/creatures");

const wolf = normalizeTemplate({ id: 1, name: "Wolf", level_min: 5, level_max: 5, sprite_type: "none" });
await assetCache.set(CACHE_KEYS.templates, [wolf]);
await creatures.init();

const mod = creatures as any;
const kind = mod.creatureGhostKind;
const ctx: any = { calls: {}, links: {}, self: "b", ownerAt: () => "b" };
const deps = creatures.creatureHandoffDeps(ctx);
const IDS = [880101, 880102, 880103, 880104, 880105, 880106, 880107, 880108];

/** A live creature of this node, in the real registry. */
function live(id: number, over: any = {}): any {
  const c: any = {
    id, templateId: 1, spawnId: 0, poolId: null, map: "main", layerId: null, x: 300, y: 300, dir: "down",
    homeX: 300, homeY: 300, level: 5, health: 40, maxHealth: 50, state: AIState.IDLE, spawnedAt: 1, move: null,
    waitUntil: Infinity, patrolIndex: 0, patrolForward: true, sentX: 300, sentY: 300, sentDir: "down", sentMoving: false,
    combat: createCombatState(), auras: createAuras(), casting: null, abilityStates: new Map(), ...over,
  };
  creatures.registry.add(c);
  return c;
}

/** A creature that is fighting, with a tapper, a DoT and an ability timer. */
function fighting(id: number): any {
  const now = Date.now();
  const c = live(id, { state: AIState.COMBAT });
  c.combat.threat.add("p1", 30, now);
  c.combat.threat.add("p2", 10, now);
  c.combat.threat.victimId = "p1";
  c.combat.tapper = { playerId: "p1", username: "alice" };
  c.combat.startX = 280;
  c.auras.dots.push({ id: "Rend", casterId: "p2", amountPerTick: 3, intervalMs: 1000, expiresAt: now + 9000, nextTickAt: now + 1000, stacks: 2, maxStacks: 3 });
  c.auras.stunUntil = now + 500;
  c.abilityStates.set(7, { nextReadyAt: now + 4000, fired: true });
  return c;
}

/** The creature as the wire gives it to the other node. */
const overWire = (c: any) => JSON.parse(JSON.stringify(creatures.serializeCreature(c)));

/** The mirror this node showed of a creature of another node. */
const showMirror = (id: number) =>
  kind.spawn({ id, templateId: 1, spawnId: 0, map: "main", layerId: null, x: 300, y: 300, dir: "down", moving: false, level: 5, health: 40, maxHealth: 50, state: "combat", victimId: "p1", tapper: null, casting: null, auras: [] });

function clear(): void {
  for (const id of IDS) {
    const c = creatures.getCreature(id);
    if (c?.remote) kind.despawn(id, "left");
    else if (c) {
      // Out of the fight bookkeeping first: a registry removal alone leaves the engine holding the id and its units.
      creatures.combat.forget(c);
      creatures.registry.remove(id);
    }
    creatures.spawner.dropForeign(id);
    forwardTable.forgetCreature(id);
  }
}

test("a creature travels whole: its fight, auras and ability timers survive the wire", () => {
  try {
    const c = fighting(880101);
    const s = overWire(c);
    expect(s).toMatchObject({ id: 880101, templateId: 1, map: "main", x: 300, y: 300, level: 5, health: 40, state: "combat" });
    expect(s.combat.tapper).toEqual({ playerId: "p1", username: "alice" });
    expect(s.combat.startX).toBe(280);
    expect(s.auras.dots[0]).toMatchObject({ id: "Rend", casterId: "p2", stacks: 2 });
    expect(s.abilityStates).toEqual([[7, { nextReadyAt: c.abilityStates.get(7).nextReadyAt, fired: true }]]);
    // Infinity is not JSON: it travels as null.
    expect(s.waitUntil).toBeNull();
    // The old node's own bookkeeping stays there.
    expect("remote" in s || "handoff" in s || "mirrorAuras" in s || "move" in s || "casting" in s).toBe(false);
    // The record itself, before the wire, is plain data: JSON.stringify would hide a table or an Infinity left in it.
    const record: any = creatures.serializeCreature(c);
    expect(record.combat.threat instanceof ThreatTable).toBe(false);
    expect(record.combat.threat.entries.map((e: any) => e[0])).toEqual(["p1", "p2"]);
    expect(record.waitUntil).toBeNull();
    // The serialized copy shares nothing with the live creature.
    record.auras.dots[0].stacks = 9;
    record.auras.slows.push({ id: "x", pct: 1, expiresAt: 1 });
    record.combat.tapper.username = "mallory";
    record.abilityStates[0][1].fired = false;
    expect(c.auras.dots[0].stacks).toBe(2);
    expect(c.auras.slows).toHaveLength(0);
    expect(c.combat.tapper.username).toBe("alice");
    expect(c.abilityStates.get(7).fired).toBe(true);
  } finally {
    clear();
  }
});

test("an arrival takes the mirror's place under the same id, with no despawn, and resumes the fight", () => {
  const onDespawn = spyOn(creatures.sync, "onDespawn");
  const onSpawn = spyOn(creatures.sync, "onSpawn");
  // As the real ghost entry does: the kind despawns the mirror it finds, unless the creature is live here by then.
  const dropMirror = spyOn(ghosts, "dropMirror").mockImplementation(((_kind: string, id: number) => kind.despawn(id, "arrived")) as any);
  try {
    const s = overWire(fighting(880102));
    creatures.registry.remove(880102);
    expect(showMirror(880102)).toBe(true);
    const mirrorsBefore = Number(creatures.stats().mirrors);
    forwardTable.addCreature(880102, "c");
    onDespawn.mockClear();
    onSpawn.mockClear();

    // Its slot is on node z.
    expect(deps.arrive(s, "z")).toBe(true);

    const c: any = creatures.getCreature(880102);
    expect(c.remote).toBeFalsy();
    expect(Number(creatures.stats().mirrors)).toBe(mirrorsBefore - 1);
    expect(onDespawn).not.toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
    expect(c.combat.threat.threatOf("p1")).toBe(30);
    expect(c.combat.threat.threatOf("p2")).toBe(10);
    expect(c.combat.threat.victimId).toBe("p1");
    expect(c.combat.tapper).toEqual({ playerId: "p1", username: "alice" });
    expect(c.abilityStates instanceof Map).toBe(true);
    expect(c.abilityStates.get(7)?.fired).toBe(true);
    expect(c.waitUntil).toBe(0);
    expect(c.move).toBeNull();
    expect(c.casting).toBeNull();
    expect([...creatures.combat.activeIds()]).toContain(880102);
    expect(forwardTable.to("creature:880102")).toBeNull();
    expect(creatures.spawner.foreignHome(880102)).toBe("z");
    // The ghost record of the mirror goes too (the creature is this node's own now).
    expect(dropMirror).toHaveBeenCalledWith("creature", 880102);
  } finally {
    dropMirror.mockRestore();
    onDespawn.mockRestore();
    onSpawn.mockRestore();
    clear();
  }
});

test("an arrival with no mirror here is announced", () => {
  const onSpawn = spyOn(creatures.sync, "onSpawn");
  try {
    const s = overWire(live(880103));
    creatures.registry.remove(880103);
    onSpawn.mockClear();
    const mirrorsBefore = Number(creatures.stats().mirrors);
    expect(deps.arrive(s, "z")).toBe(true);
    expect(onSpawn).toHaveBeenCalledTimes(1);
    // No mirror was there, so none is taken off the count.
    expect(Number(creatures.stats().mirrors)).toBe(mirrorsBefore);
  } finally {
    onSpawn.mockRestore();
    clear();
  }
});

test("an arrival is refused when the creature is already live here, or the record is malformed", () => {
  try {
    const here = live(880104);
    const s = overWire(here);
    expect(deps.arrive(s, "z")).toBe(false);
    expect(creatures.getCreature(880104)).toBe(here);
    creatures.registry.remove(880104);
    expect(deps.arrive({ ...s, x: "far" } as any, "z")).toBe(false);
    expect(deps.arrive({ ...s, map: 7 } as any, "z")).toBe(false);
    expect(deps.arrive({ ...s, combat: null } as any, "z")).toBe(false);
    expect(deps.arrive({ ...s, auras: 3 } as any, "z")).toBe(false);
    expect(creatures.getCreature(880104)).toBeUndefined();
  } finally {
    clear();
  }
});

test("a mirror that moved before its creature arrived is not flushed as a move afterwards", () => {
  const flush = spyOn(creatures.sync, "flushMoves");
  try {
    const s = overWire(live(880103));
    creatures.registry.remove(880103);
    expect(showMirror(880103)).toBe(true);
    // The mirror's move waits for the next tick.
    kind.move(880103, 310, 300, 0, 0);
    expect(deps.arrive(s, "z")).toBe(true);
    flush.mockClear();
    creatures.tickCreatures(Date.now());
    expect(flush).toHaveBeenCalled();
    for (const call of flush.mock.calls) expect([...(call[0] as Iterable<any>)].some((c) => c.remote)).toBe(false);
  } finally {
    flush.mockRestore();
    clear();
  }
});

test("an arrival the spawner refuses leaves the mirror in place and counted", () => {
  const onDespawn = spyOn(creatures.sync, "onDespawn");
  try {
    const s = overWire(fighting(880107));
    creatures.registry.remove(880107);
    expect(showMirror(880107)).toBe(true);
    const mirror = creatures.getCreature(880107);
    const mirrorsBefore = Number(creatures.stats().mirrors);
    onDespawn.mockClear();

    // Home is this node (null), but no away slot is held for the creature: the spawner takes in nothing.
    expect(deps.arrive(s, null)).toBe(false);

    expect(creatures.getCreature(880107)).toBe(mirror);
    expect(mirror?.remote).toBe(true);
    expect(Number(creatures.stats().mirrors)).toBe(mirrorsBefore);
    expect([...creatures.combat.activeIds()]).not.toContain(880107);
    expect(onDespawn).not.toHaveBeenCalled();
  } finally {
    onDespawn.mockRestore();
    clear();
  }
});

test("a creature coming home takes its away slot back and the mirror's place", () => {
  const empty = () => ({ templates: new Map([[1, wolf]]), spawns: new Map(), pools: new Map(), patrolPaths: new Map() });
  try {
    const spawn = normalizeSpawn({ id: 1, template_id: 1, map: "main", x: 100, y: 200, respawn_min_s: 10, respawn_max_s: 20, layer_policy: "shared" });
    creatures.spawner.load({ ...empty(), spawns: new Map([[1, spawn]]) }, Date.now());
    const id = creatures.spawner.getLiveInstanceId(1)!;
    expect(id).toBeDefined();
    expect(deps.ownsSlot(creatures.getCreature(id)!)).toBe(true);
    const s = overWire(creatures.getCreature(id));
    // Handed to node c: its slot stays taken, and this node shows it as a mirror.
    expect(creatures.spawner.markAway(id, "c")).toBe(true);
    creatures.registry.remove(id);
    expect(kind.spawn({ id, templateId: 1, spawnId: 1, map: "main", layerId: null, x: 100, y: 200, dir: "down", moving: false, level: 5, health: 40, maxHealth: 50, state: "idle", victimId: null, tapper: null, casting: null, auras: [] })).toBe(true);
    const mirrorsBefore = Number(creatures.stats().mirrors);
    const liveBefore = Number(creatures.stats().creatures);

    expect(deps.arrive(s, null)).toBe(true);

    const c: any = creatures.getCreature(id);
    expect(c.remote).toBeFalsy();
    expect(creatures.spawner.awaySlots()).toEqual([]);
    expect(creatures.spawner.getLiveInstanceId(1)).toBe(id);
    expect(creatures.spawner.foreignHome(id)).toBeNull();
    expect(Number(creatures.stats().mirrors)).toBe(mirrorsBefore - 1);
    expect(Number(creatures.stats().creatures)).toBe(liveBefore + 1);
  } finally {
    creatures.spawner.load(empty(), Date.now());
  }
});

test("a record that cannot be a living creature of a known template is refused, and the mirror stays", () => {
  try {
    const base = overWire(live(880103));
    creatures.registry.remove(880103);
    expect(showMirror(880103)).toBe(true);
    const mirror = creatures.getCreature(880103);
    const mirrorsBefore = Number(creatures.stats().mirrors);
    const bad: any[] = [
      { state: "dead" }, { templateId: 999 }, { health: 0 }, { health: "x" }, { health: -5 }, { maxHealth: 0 }, { maxHealth: null },
      { level: 0 }, { level: 1.5 }, { level: "5" }, { level: null }, { spawnId: 1.5 }, { poolId: 0.5 },
    ];
    for (const over of bad) {
      expect(deps.arrive({ ...base, ...over }, "z")).toBe(false);
      expect(creatures.getCreature(880103)).toBe(mirror);
      expect(Number(creatures.stats().mirrors)).toBe(mirrorsBefore);
    }
    // Health is held to the most the creature has.
    expect(deps.arrive({ ...base, health: 500, maxHealth: 50 }, "z")).toBe(true);
    expect((creatures.getCreature(880103) as any).health).toBe(50);
  } finally {
    clear();
  }
});

test("a creature coming home must be the one its away slot holds, or it is refused and the slot stays away", () => {
  const empty = () => ({ templates: new Map([[1, wolf]]), spawns: new Map(), pools: new Map(), patrolPaths: new Map() });
  try {
    const spawn = normalizeSpawn({ id: 1, template_id: 1, map: "main", x: 100, y: 200, respawn_min_s: 10, respawn_max_s: 20, layer_policy: "shared" });
    creatures.spawner.load({ ...empty(), spawns: new Map([[1, spawn]]) }, Date.now());
    const id = creatures.spawner.getLiveInstanceId(1)!;
    const s = overWire(creatures.getCreature(id));
    expect(creatures.spawner.markAway(id, "c")).toBe(true);
    creatures.registry.remove(id);
    expect(kind.spawn({ id, templateId: 1, spawnId: 1, map: "main", layerId: null, x: 100, y: 200, dir: "down", moving: false, level: 5, health: 40, maxHealth: 50, state: "idle", victimId: null, tapper: null, casting: null, auras: [] })).toBe(true);
    const mirror = creatures.getCreature(id);
    const mirrorsBefore = Number(creatures.stats().mirrors);
    for (const over of [{ spawnId: 2 }, { spawnId: 0 }, { layerId: "main:layer_1" }, { poolId: 5 }]) {
      expect(deps.arrive({ ...s, ...over }, null)).toBe(false);
      // Nothing changed: the mirror is shown, and the slot is still away at its holder.
      expect(creatures.getCreature(id)).toBe(mirror);
      expect(Number(creatures.stats().mirrors)).toBe(mirrorsBefore);
      expect(creatures.spawner.awaySlots().map((a) => [a.instanceId, a.holder])).toEqual([[id, "c"]]);
      expect(creatures.spawner.getLiveInstanceId(1)).toBeUndefined();
    }
    // The creature the slot holds is taken back, and its fields are the slot's.
    expect(deps.arrive(s, null)).toBe(true);
    const c: any = creatures.getCreature(id);
    expect([c.spawnId, c.layerId, c.poolId]).toEqual([1, null, null]);
  } finally {
    creatures.spawner.load(empty(), Date.now());
  }
});

test("a replaced mirror that differs in map or layer is announced again, so the client rebuilds the creature", () => {
  const onDespawn = spyOn(creatures.sync, "onDespawn");
  const onSpawn = spyOn(creatures.sync, "onSpawn");
  try {
    for (const [map, layerId] of [["elsewhere", null], ["main", "main:layer_2"]] as const) {
      const s = overWire(live(880103));
      creatures.registry.remove(880103);
      expect(kind.spawn({ id: 880103, templateId: 1, spawnId: 0, map, layerId, x: 300, y: 300, dir: "down", moving: false, level: 5, health: 40, maxHealth: 50, state: "idle", victimId: null, tapper: null, casting: null, auras: [] })).toBe(true);
      const mirrorsBefore = Number(creatures.stats().mirrors);
      onDespawn.mockClear();
      onSpawn.mockClear();
      expect(deps.arrive(s, "z")).toBe(true);
      expect(onDespawn).toHaveBeenCalledTimes(1);
      expect(onSpawn).toHaveBeenCalledTimes(1);
      // The viewers are told it left (the old entry) before it is announced (the live creature).
      expect(onDespawn.mock.invocationCallOrder[0]).toBeLessThan(onSpawn.mock.invocationCallOrder[0]);
      expect(Number(creatures.stats().mirrors)).toBe(mirrorsBefore - 1);
      clear();
    }
  } finally {
    onDespawn.mockRestore();
    onSpawn.mockRestore();
    clear();
  }
});

test("a record with bad parts arrives with those parts fresh, and a bad DoT cannot stall the tick", () => {
  try {
    const s = overWire(fighting(880108));
    creatures.registry.remove(880108);
    s.state = "bogus";
    s.homeX = 0;
    s.waitUntil = "soon";
    s.combat.startX = null;
    s.combat.fledThisCombat = "yes";
    s.combat.tapper = { playerId: 5 };
    s.auras.stunUntil = "later";
    s.auras.dots.push({ id: "Zero", casterId: "p2", amountPerTick: 1, intervalMs: 0, expiresAt: 1, nextTickAt: 1, stacks: 1, maxStacks: 1 }, "junk");
    s.abilityStates.push(["x", { nextReadyAt: 1 }], [9, null]);
    expect(deps.arrive(s, "z")).toBe(true);
    const c: any = creatures.getCreature(880108);
    expect(c.state).toBe("idle");
    // A real 0 is kept, not read as missing.
    expect(c.homeX).toBe(0);
    expect(c.waitUntil).toBe(0);
    expect(c.combat.startX).toBe(0);
    expect(c.combat.fledThisCombat).toBe(false);
    expect(c.combat.tapper).toBeNull();
    expect(c.auras.stunUntil).toBe(0);
    expect(c.auras.dots.map((d: any) => d.id)).toEqual(["Rend"]);
    expect([...c.abilityStates.keys()]).toEqual([7]);
  } finally {
    clear();
  }
});

test("the old node's copy becomes a mirror in place, out of the fight bookkeeping", () => {
  try {
    const c = fighting(880105);
    c.move = { path: [{ x: 310, y: 300 }], index: 0, speed: 2, stuckTicks: 0 };
    c.casting = { abilityId: 1, spellId: 1, spellName: "Bite", target: { kind: "player", id: "p1" }, startedAt: 1, endsAt: 2, interruptible: true };
    creatures.combat.adopt(c);
    expect([...creatures.combat.activeIds()]).toContain(880105);
    const record = deps.ghostRecord(c);
    expect(record).toMatchObject({ id: 880105, templateId: 1, moving: true });
    const mirrorsBefore = Number(creatures.stats().mirrors);

    deps.toMirror(c, "c");

    expect(creatures.getCreature(880105)).toBe(c);
    expect(c.remote).toBe(true);
    expect(c.handoff).toBe(false);
    expect(c.casting).toBeNull();
    // The path stays here: the mirror only says it is moving.
    expect(c.move.path).toEqual([]);
    expect(Array.isArray(c.mirrorAuras) && c.mirrorAuras.length > 0).toBe(true);
    expect(Number(creatures.stats().mirrors)).toBe(mirrorsBefore + 1);
    expect([...creatures.combat.activeIds()]).not.toContain(880105);
    // A mirror has no ghost record of its own to send.
    expect(deps.ghostRecord(c)).toBeNull();
  } finally {
    clear();
  }
});

test("turning a creature into a mirror twice counts it once", () => {
  try {
    const c = live(880105);
    const mirrorsBefore = Number(creatures.stats().mirrors);
    deps.toMirror(c, "c");
    deps.toMirror(c, "c");
    expect(Number(creatures.stats().mirrors)).toBe(mirrorsBefore + 1);
    // No path in, none out.
    expect(c.move).toBeNull();
  } finally {
    clear();
  }
});

test("a foreign creature's death goes to its home, and a dropped one does not", () => {
  const died = spyOn(creatureHandoff, "died").mockImplementation(() => {});
  try {
    const s = overWire(live(880106));
    creatures.registry.remove(880106);
    expect(deps.arrive(s, "z")).toBe(true);
    expect(creatures.spawner.foreignHome(880106)).toBe("z");
    creatures.spawner.despawn(880106, Date.now(), { delayMs: 1234 });
    expect(died).toHaveBeenCalledTimes(1);
    expect(died.mock.calls[0].slice(0, 3)).toEqual([880106, 1, "z"]);

    died.mockClear();
    expect(deps.arrive(s, "z")).toBe(true);
    deps.despawnForeign(880106);
    expect(creatures.getCreature(880106)).toBeUndefined();
    expect(died).not.toHaveBeenCalled();
  } finally {
    died.mockRestore();
    clear();
  }
});

test("the handoff deps read this node's own creatures, templates and slots", () => {
  try {
    const c = live(880101);
    expect(deps.creature(880101)).toBe(c);
    c.remote = true;
    expect(deps.creature(880101)).toBeNull();
    c.remote = false;
    expect(deps.templateKnown(1)).toBe(true);
    expect(deps.templateKnown(999)).toBe(false);
    expect(deps.templateName(1)).toBe("Wolf");
    // Spawn 0 is no slot: the creature does not hold one.
    expect(deps.ownsSlot(c)).toBe(false);
    deps.forward(880101, "c");
    expect(forwardTable.to("creature:880101")).toBe("c");
    expect(deps.self).toBe("b");
  } finally {
    clear();
  }
});

test("a creature of spawn 0 holds no slot, even when the spawner lists a live one under 0", () => {
  const empty = () => ({ templates: new Map([[1, wolf]]), spawns: new Map(), pools: new Map(), patrolPaths: new Map() });
  try {
    const zero = normalizeSpawn({ id: 0, template_id: 1, map: "main", x: 100, y: 200, respawn_min_s: 10, respawn_max_s: 20, layer_policy: "shared" });
    creatures.spawner.load({ ...empty(), spawns: new Map([[0, zero]]) }, Date.now());
    const id = creatures.spawner.getLiveInstanceId(0)!;
    expect(id).toBeDefined();
    const c = creatures.getCreature(id)!;
    expect(c.spawnId).toBe(0);
    expect(deps.ownsSlot(c)).toBe(false);
  } finally {
    creatures.spawner.load(empty(), Date.now());
  }
});

test("handoffs wait while the shared store is down, and a context with no store counts as up", () => {
  expect(creatures.handoffPaused({ ...ctx, store: { isUp: () => false } })).toBe(true);
  expect(creatures.handoffPaused({ ...ctx, store: { isUp: () => true } })).toBe(false);
  expect(creatures.handoffPaused({ ...ctx, store: {} })).toBe(false);
  expect(creatures.handoffPaused(ctx)).toBe(false);
});

// What the watch needs of a creature and of the node.
const mk = (id: number, over: any = {}): any => ({ id, templateId: 1, map: "main", x: 2000, y: 300, state: AIState.IDLE, remote: false, handoff: false, casting: null, ...over });
/** Node b owns x < 1000 and node c the rest: a creature at x 2000 is well inside c's block. */
const watchCtx = (over: any = {}): any => ({ calls: { isUp: () => true }, self: "b", ownerAt: (_map: string, x: number) => (x >= 1000 ? "c" : "b"), ...over });
const never = () => new Promise<unknown>(() => {});

test("the watch hands at most 20 creatures a tick to the node whose block they entered, counted when started", () => {
  const started: Array<[number, string]> = [];
  creatures.watchHandoffs(Array.from({ length: 25 }, (_, i) => mk(i + 1)), watchCtx(), (c, target) => { started.push([c.id, target]); return never(); });
  expect(started).toHaveLength(20);
  expect(started[0]).toEqual([1, "c"]);
  expect(started[19]).toEqual([20, "c"]);
  // Creatures that need no handoff do not use up the cap.
  started.length = 0;
  const inside = Array.from({ length: 30 }, (_, i) => mk(100 + i, { x: 100 }));
  creatures.watchHandoffs([...inside, ...Array.from({ length: 25 }, (_, i) => mk(i + 1))], watchCtx(), (c, target) => { started.push([c.id, target]); return never(); });
  expect(started.map((s) => s[0])).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
});

test("the watch skips a remote, busy, casting or dead creature, one cooling down, and one not inside another block", () => {
  const cooling = spyOn(creatureHandoff, "coolingDown").mockImplementation((id: number) => id === 6);
  try {
    const started: number[] = [];
    creatures.watchHandoffs(
      [mk(1, { remote: true }), mk(2, { handoff: true }), mk(3, { casting: { abilityId: 1 } }), mk(4, { state: AIState.DEAD }), mk(5, { x: 100 }), mk(6), mk(7)],
      watchCtx(),
      (c) => { started.push(c.id); return never(); },
    );
    expect(started).toEqual([7]);
    expect(cooling).toHaveBeenCalledWith(6);
  } finally {
    cooling.mockRestore();
  }
});

test("the watch starts nothing while the link to the target is down, or the store is", () => {
  const asked: string[] = [];
  const started: number[] = [];
  const start = (c: any) => { started.push(c.id); return never(); };
  creatures.watchHandoffs([mk(1)], watchCtx({ calls: { isUp: (peer: string) => { asked.push(peer); return false; } } }), start);
  expect(asked).toEqual(["c"]);
  creatures.watchHandoffs([mk(1)], watchCtx({ store: { isUp: () => false } }), start);
  expect(started).toEqual([]);
  // The pause is read once for the tick, not once per creature.
  let reads = 0;
  creatures.watchHandoffs(Array.from({ length: 5 }, (_, i) => mk(i + 1)), watchCtx({ store: { isUp: () => { reads++; return false; } } }), start);
  expect(reads).toBe(1);
  // Up, it is read once for the tick too.
  let upReads = 0;
  creatures.watchHandoffs(Array.from({ length: 5 }, (_, i) => mk(i + 10)), watchCtx({ store: { isUp: () => { upReads++; return true; } } }), () => never());
  expect(upReads).toBe(1);
  // Up, or a store that does not say, starts them.
  creatures.watchHandoffs([mk(1)], watchCtx({ store: { isUp: () => true } }), start);
  creatures.watchHandoffs([mk(2)], watchCtx({ store: {} }), start);
  creatures.watchHandoffs([mk(3)], watchCtx(), start);
  expect(started).toEqual([1, 2, 3]);
});

test("a handoff that fails is logged with the creature, and does not stop the tick", async () => {
  const { default: log } = await import("../modules/logger");
  const error = spyOn(log, "error").mockImplementation(() => {});
  try {
    creatures.watchHandoffs([mk(1)], watchCtx(), () => Promise.reject(new Error("boom")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(String(error.mock.calls[0]?.[0])).toContain("creature 1 to c failed");
  } finally {
    error.mockRestore();
  }
});

test("the handoff runs only while the links are attached: the sweep runs, the tick watches, and the undo stops both", () => {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const setTimer = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => { timers.push({ fn, ms }); return { unref() {} }; }) as any);
  const clearTimer = spyOn(globalThis, "clearInterval").mockImplementation((() => {}) as any);
  const sweep = spyOn(creatureHandoff, "sweep").mockResolvedValue(undefined);
  const handOff = spyOn(creatureHandoff, "handOff").mockResolvedValue("moved");
  const startHandoff = spyOn(creatureHandoff, "start");
  const stopHandoff = spyOn(creatureHandoff, "stop");
  const attachCtx = (): any => watchCtx({
    // Every point is node c's: the tick moves a creature whose victim is gone, so where it stands does not matter.
    ownerAt: () => "c",
    calls: { isUp: () => true, handle: () => () => {}, onCast: () => () => {}, onPeerUp: () => () => {}, cast: () => true, call: async () => ({ ok: false, why: "down" }) },
    links: {},
  });
  let undo = () => {};
  try {
    const c = fighting(880101);
    // A tick of the real AI ends the fight of a creature whose victim is gone, so it is put back in combat before each tick.
    const place = () => {
      c.state = AIState.COMBAT;
      creatures.combat.adopt(c);
      creatures.tickCreatures(Date.now());
    };

    // Not attached: a creature inside another block is left alone (the cluster is off).
    place();
    expect(handOff).not.toHaveBeenCalled();

    undo = creatures.attachCreatureHandoff(attachCtx());
    expect(startHandoff).toHaveBeenCalledTimes(1);
    expect(startHandoff.mock.calls[0][0].self).toBe("b");
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(creatures.CREATURE_SWEEP_MS);
    timers[0].fn();
    expect(sweep).toHaveBeenCalledTimes(1);
    place();
    expect(handOff).toHaveBeenCalledTimes(1);
    expect(handOff.mock.calls[0][0]).toBe(c);
    expect(handOff.mock.calls[0][1]).toBe("c");

    // A later attach owns the context: the earlier undo does not clear it.
    const undoSecond = creatures.attachCreatureHandoff(attachCtx());
    undo();
    handOff.mockClear();
    place();
    expect(handOff).toHaveBeenCalledTimes(1);
    undo = undoSecond;

    stopHandoff.mockClear();
    undo();
    expect(stopHandoff).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalledTimes(2);
    handOff.mockClear();
    place();
    expect(handOff).not.toHaveBeenCalled();
  } finally {
    undo();
    creatureHandoff.stop();
    setTimer.mockRestore();
    clearTimer.mockRestore();
    sweep.mockRestore();
    handOff.mockRestore();
    startHandoff.mockRestore();
    stopHandoff.mockRestore();
    clear();
  }
});

// Perf fix 3: a creature nobody observes and nobody fights is never ticked, so after its block moved out (exportSlots
// marks it foreign) only the sweep of the dormant ones offers it to the handoff watch.
const emptySpawnData = () => ({ templates: new Map([[1, wolf]]), spawns: new Map(), pools: new Map(), patrolPaths: new Map() });
let sweepClock = Date.now() + 1_000_000_000;

/** A dormant creature of a loaded spawn whose block is exported to "c"; returns its id. Node c owns every point. */
function strandedCreature(): number {
  const spawn = normalizeSpawn({ id: 5, template_id: 1, map: "main", x: 2000, y: 300, respawn_min_s: 10, respawn_max_s: 20, layer_policy: "shared" });
  creatures.spawner.load({ ...emptySpawnData(), spawns: new Map([[5, spawn]]) }, sweepClock);
  const id = creatures.spawner.getLiveInstanceId(5)!;
  expect(id).toBeDefined();
  // Other test files leave their own ids in these process-wide sets; this one's creature is in neither.
  expect([...creatures.sync.observedIds()]).not.toContain(id);
  expect([...creatures.combat.activeIds()]).not.toContain(id);
  creatures.spawner.exportSlots(() => true, "c", "b", sweepClock);
  expect(creatures.spawner.foreignHome(id)).toBe("c");
  return id;
}

/** Ticks from sweepClock for `ms`, 50 ms a tick. */
function tickFor(ms: number): void {
  const end = sweepClock + ms;
  for (; sweepClock < end; sweepClock += 50) creatures.tickCreatures(sweepClock);
}

function withSweepHandoff(up: { value: boolean; asked?: number }, run: (handOff: ReturnType<typeof spyOn>) => void): void {
  const setTimer = spyOn(globalThis, "setInterval").mockImplementation((() => ({ unref() {} })) as any);
  const clearTimer = spyOn(globalThis, "clearInterval").mockImplementation((() => {}) as any);
  const sweep = spyOn(creatureHandoff, "sweep").mockResolvedValue(undefined);
  // What handOff ends in on success: the creature is no longer foreign here.
  const handOff = spyOn(creatureHandoff, "handOff").mockImplementation((async (c: any) => {
    creatures.spawner.dropForeign(c.id);
    return "moved";
  }) as any);
  const undo = creatures.attachCreatureHandoff(watchCtx({ ownerAt: () => "c", calls: { isUp: () => { up.asked = (up.asked ?? 0) + 1; return up.value; }, handle: () => () => {}, onCast: () => () => {}, onPeerUp: () => () => {}, cast: () => true, call: async () => ({ ok: false, why: "down" }) }, links: {} }));
  try {
    run(handOff as any);
  } finally {
    undo();
    creatureHandoff.stop();
    setTimer.mockRestore();
    clearTimer.mockRestore();
    sweep.mockRestore();
    handOff.mockRestore();
    creatures.spawner.load(emptySpawnData(), sweepClock);
    clear();
  }
}

test("a dormant creature left foreign by a block move is handed to the new owner once, with no observer and no fight", () => {
  withSweepHandoff({ value: true }, (handOff) => {
    const id = strandedCreature();
    tickFor(2_100);
    const mine = handOff.mock.calls.filter((call: any[]) => call[0].id === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]![1]).toBe("c");
    expect(creatures.spawner.foreignHome(id)).toBeNull();
  });
});

test("a dormant foreign creature waits while its target is down, is handed once it is up, and stays handed", () => {
  const up = { value: false };
  withSweepHandoff(up, (handOff) => {
    const id = strandedCreature();
    const mine = () => handOff.mock.calls.filter((call: any[]) => call[0].id === id).length;
    tickFor(3_100);
    expect(mine()).toBe(0);
    expect(creatures.spawner.foreignHome(id)).toBe("c");
    up.value = true;
    tickFor(1_100);
    expect(mine()).toBe(1);
    tickFor(3_000);
    expect(mine()).toBe(1);
  });
});

test("a foreign creature that is ticked and already handing off is not offered again by the sweep", () => {
  withSweepHandoff({ value: true }, (handOff) => {
    // The stub is what the real handOff does at its start: it marks the creature and keeps it foreign while it waits.
    const starts: number[] = [];
    handOff.mockImplementation((async (c: any) => {
      starts.push(c.id);
      c.handoff = true;
      return new Promise(() => {});
    }) as any);
    {
      const id = strandedCreature();
      const c = creatures.getCreature(id)!;
      // In a fight it is ticked, so the watch of the ticked creatures offers it first; the sweep of the same tick finds it marked.
      c.combat.threat.add("p1", 10, sweepClock);
      c.state = AIState.COMBAT;
      creatures.combat.adopt(c);
      // A sweep is due on this tick.
      sweepClock += 2_000;
      creatures.tickCreatures(sweepClock);
      sweepClock += 50;
      expect(starts.filter((started) => started === id)).toHaveLength(1);
      expect(creatures.spawner.foreignHome(id)).toBe("c");
    }
  });
});

test("a clock stepped back does not stop the sweep for the length of the step", () => {
  const up = { value: false, asked: 0 };
  withSweepHandoff(up, () => {
    strandedCreature();
    sweepClock += 2_000;
    creatures.tickCreatures(sweepClock);
    const first = up.asked;
    expect(first).toBeGreaterThan(0);
    // Within the second: no sweep.
    creatures.tickCreatures(sweepClock + 100);
    expect(up.asked).toBe(first);
    // The wall clock steps back 10 s: the next tick sweeps, it does not wait for the old time.
    creatures.tickCreatures(sweepClock - 10_000);
    expect(up.asked).toBeGreaterThan(first);
    sweepClock += 1;
  });
});

test("with the cluster off nothing is swept: no foreign walk, no handoff", () => {
  const count = spyOn(creatures.spawner, "foreignCount");
  const ids = spyOn(creatures.spawner, "foreignIds");
  const handOff = spyOn(creatureHandoff, "handOff");
  try {
    const id = strandedCreature();
    tickFor(2_100);
    expect(count).not.toHaveBeenCalled();
    expect(ids).not.toHaveBeenCalled();
    expect(handOff.mock.calls.filter((call: any[]) => call[0].id === id)).toHaveLength(0);
    expect(creatures.spawner.foreignHome(id)).toBe("c");
  } finally {
    count.mockRestore();
    ids.mockRestore();
    handOff.mockRestore();
    creatures.spawner.load(emptySpawnData(), sweepClock);
    clear();
  }
});

// The creature loop runs on a timer; where the watch sits in it, and the hook into the spawner, are read from the source.
const source = readFileSync(join(import.meta.dir, "..", "systems", "creatures", "index.ts"), "utf8");

test("the watch runs on this node's own creatures, before the moved mirrors join them, and a foreign death goes home", () => {
  const tick = source.slice(source.indexOf("function tickCreatures("), source.indexOf("function sweepUnobservedCorpses("));
  expect(tick).toContain("if (handoffCtx) watchHandoffs(ticked, handoffCtx);");
  // Perf fix 3: the dormant foreign creatures follow, once a second, through the same watch.
  expect(tick).toContain("if (handoffCtx && foreignSweepDue(now)) sweepForeign(now, handoffCtx);");
  expect(tick.indexOf("if (handoffCtx)")).toBeGreaterThan(tick.indexOf("combat.tick(creature, now, TICK_MS)"));
  expect(tick.indexOf("if (handoffCtx)")).toBeLessThan(tick.indexOf("if (movedMirrors.size > 0)"));
  expect(source).toContain("onLinksAttached(attachCreatureHandoff);");
  expect(source).toContain("onForeignGone: (instance, home, opts) => creatureHandoff.died(instance.id, instance.templateId, home, opts)");
});

test("no test creature is left in the combat engine", () => {
  const active = [...creatures.combat.activeIds()];
  for (const id of IDS) expect(active).not.toContain(id);
  expect(creatures.combat.isInCombatWith("p1")).toBe(false);
  expect(creatures.combat.isInCombatWith("p2")).toBe(false);
});
