import { expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { ThreatTable, createCombatState } = await import("../systems/creatures/threat");
const { CreatureCombatSystem } = await import("../systems/creatures/engine");
const { CreatureRegistry } = await import("../systems/creatures/registry");
const { CreatureSync } = await import("../systems/creatures/sync");
const { createAuras } = await import("../systems/creatures/auras");
const { AIState } = await import("../systems/creatures/types");
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");

test("a threat table survives a round trip through JSON", () => {
  const table = new ThreatTable();
  table.add("p1", 50, 1_000);
  table.add("p2", 80, 1_100);
  table.victimId = "p2";
  const copy = ThreatTable.fromJSON(JSON.parse(JSON.stringify(table.toJSON())));
  expect(copy.threatOf("p1")).toBe(50);
  expect(copy.threatOf("p2")).toBe(80);
  expect(copy.victimId).toBe("p2");
  expect(copy.get("p1")).toEqual(table.get("p1"));
  expect([...copy.units()].sort()).toEqual(["p1", "p2"]);
});

test("a taunt survives a round trip", () => {
  const table = new ThreatTable();
  table.add("p1", 10, 1_000);
  const data = table.toJSON();
  data.tauntedBy = "p1";
  data.tauntUntil = 9_000;
  expect(ThreatTable.fromJSON(data).toJSON()).toEqual(data);
});

const good = ["p1", { threat: 5, addedAt: 1, unreachableSince: null }] as [string, any];
const units = (entries: any[], extra: any = {}) =>
  [...ThreatTable.fromJSON({ entries: [good, ...entries], victimId: "p1", tauntedBy: null, tauntUntil: 0, ...extra }).units()];

test("fromJSON ignores an entry that is not a pair", () => {
  expect(units([null, "p2", 5])).toEqual(["p1"]);
});

test("fromJSON ignores an entry with no data", () => {
  expect(units([["p2", null]])).toEqual(["p1"]);
});

test("fromJSON ignores an entry whose unit id is not a string", () => {
  expect(units([[7, { threat: 5 }]])).toEqual(["p1"]);
});

test("fromJSON ignores an entry with an empty unit id", () => {
  expect(units([["", { threat: 5 }]])).toEqual(["p1"]);
});

test("fromJSON ignores an entry whose threat is not a number", () => {
  expect(units([["p2", { threat: "x" }], ["p3", {}], ["p4", { threat: null }]])).toEqual(["p1"]);
});

test("fromJSON ignores an entry whose threat is not finite", () => {
  expect(units([["p2", { threat: NaN }], ["p3", { threat: Infinity }]])).toEqual(["p1"]);
});

test("fromJSON ignores an entry with negative threat", () => {
  expect(units([["p2", { threat: -1 }]])).toEqual(["p1"]);
});

test("fromJSON ignores an entry with an out-of-range threat", () => {
  expect(units([["p2", { threat: 1e300 }]])).toEqual(["p1"]);
  expect(units([["p3", { threat: 1e9 }]])).toEqual(["p1", "p3"]);
});

test("fromJSON ignores an entry whose unreachableSince is not a finite number", () => {
  expect(units([["p2", { threat: 5, unreachableSince: "x" }], ["p3", { threat: 5, unreachableSince: Infinity }]])).toEqual(["p1"]);
  expect(units([["p4", { threat: 5, unreachableSince: 123 }]])).toEqual(["p1", "p4"]);
});

test("fromJSON drops a taunt on a unit with no entry", () => {
  const copy = ThreatTable.fromJSON({ entries: [good], victimId: null, tauntedBy: "ghost", tauntUntil: 9_000 });
  expect(copy.toJSON().tauntedBy).toBeNull();
  expect(copy.toJSON().tauntUntil).toBe(0);
});

test("a copy of a threat table is independent of the original", () => {
  const table = new ThreatTable();
  table.add("p1", 50, 1_000);
  const copy = ThreatTable.fromJSON(table.toJSON());
  copy.add("p1", 25, 2_000);
  expect(table.threatOf("p1")).toBe(50);
  expect(copy.threatOf("p1")).toBe(75);
});

test("fromJSON drops a victim that has no entry and survives missing data", () => {
  const copy = ThreatTable.fromJSON({ entries: [], victimId: "ghost", tauntedBy: null, tauntUntil: 0 });
  expect(copy.victimId).toBeNull();
  expect(ThreatTable.fromJSON(undefined as any).size).toBe(0);
});

test("the engine releases and adopts a creature's combat bookkeeping", () => {
  const source = readFileSync(join(import.meta.dir, "..", "systems", "creatures", "engine.ts"), "utf8");
  const release = source.slice(source.indexOf("  release(creature: CreatureInstance): void {"), source.indexOf("  adopt(creature: CreatureInstance): void {"));
  expect(release).toContain("this.clearThreatIndex(creature)");
  expect(release).toContain("this.active.delete(creature.id)");
  // Auto-attacks on it go on: they become hits on the mirror (phase 5).
  expect(release).not.toContain("stopAutoAttack");
  const adopt = source.slice(source.indexOf("  adopt(creature: CreatureInstance): void {"));
  expect(adopt.slice(0, 900)).toContain("this.unitIndex");
  expect(adopt.slice(0, 900)).toContain("this.active.add(creature.id)");
});

const creature = (id: number, over: any = {}) => ({
  id, templateId: 1, spawnId: 1, poolId: null, map: "main", layerId: null as string | null, x: 10, y: 10, dir: "down",
  homeX: 10, homeY: 10, level: 5, health: 50, maxHealth: 50, state: AIState.IDLE as any, spawnedAt: 0,
  move: null, waitUntil: 0, patrolIndex: 0, patrolForward: true, sentX: 10, sentY: 10, sentDir: "down", sentMoving: false,
  combat: createCombatState(), auras: createAuras(), casting: null, abilityStates: new Map(), ...over,
});

test("a creature handed over mid-fight is indexed and ticked here; released, it is neither", () => {
  const registry = new CreatureRegistry(64);
  const system = new CreatureCombatSystem(registry, {} as any);
  const c = creature(1, { state: AIState.COMBAT });
  c.combat.threat.add("p1", 40, 1_000);
  registry.add(c);

  system.adopt(c);
  expect(system.isInCombatWith("p1")).toBe(true);
  expect([...system.activeIds()]).toEqual([1]);

  // Guard: release forgets the index. Without it the old holder still thinks the player fights its creature.
  system.release(c);
  expect(system.isInCombatWith("p1")).toBe(false);
  expect([...system.activeIds()]).toEqual([]);
  // The threat table itself went with the creature: release leaves it alone.
  expect(c.combat.threat.threatOf("p1")).toBe(40);
});

test("adopt does not index the threat of a creature it does not make active", () => {
  const registry = new CreatureRegistry(64);
  const system = new CreatureCombatSystem(registry, {} as any);
  const idle = creature(1, { state: AIState.IDLE });
  idle.combat.threat.add("p1", 10, 1_000);
  const dead = creature(2, { state: AIState.DEAD });
  dead.combat.threat.add("p2", 10, 1_000);
  system.adopt(idle);
  system.adopt(dead);
  // Guard: the early return. Without it the player would stay "in combat" with a creature that is not fighting.
  expect(system.isInCombatWith("p1")).toBe(false);
  expect(system.isInCombatWith("p2")).toBe(false);
});

test("adopt keeps an idle creature out of the active set, and a dead one too", () => {
  const registry = new CreatureRegistry(64);
  const system = new CreatureCombatSystem(registry, {} as any);
  for (const [id, state] of [[1, AIState.IDLE], [2, AIState.WANDER], [3, AIState.PATROL], [4, AIState.DEAD]] as const) {
    system.adopt(creature(id, { state }));
  }
  expect([...system.activeIds()]).toEqual([]);
  for (const [id, state] of [[5, AIState.EVADING], [6, AIState.FLEEING]] as const) system.adopt(creature(id, { state }));
  expect([...system.activeIds()]).toEqual([5, 6]);
});

test("CreatureSync.adopt records what the arriving player already sees", () => {
  const source = readFileSync(join(import.meta.dir, "..", "systems", "creatures", "sync.ts"), "utf8");
  expect(source).toContain("adopt(playerId: string, map: string, layerId: string | null, ids: Iterable<number>): void {");
});

test("CreatureSync.adopt makes the arriving player's creatures known and observed, and forget undoes it", () => {
  const registry = new CreatureRegistry(64);
  const sent: Array<{ kind: string; ids: number[] }> = [];
  const sync = new CreatureSync({
    registry,
    getTemplate: () => undefined,
    playersOnMap: () => [],
    resolvePlayer: () => null,
    sendSpawn: (_wt: any, snaps: any[]) => sent.push({ kind: "spawn", ids: snaps.map((s) => s.id) }),
    sendDespawn: (_wt: any, ids: number[]) => sent.push({ kind: "despawn", ids }),
    sendMoves: () => {},
  } as any);
  sync.adopt("p1", "main", "main:layer_1", [3, 4, "5" as any, 1.5, NaN]);
  expect([...sync.knownBy("p1")].sort()).toEqual([3, 4, 5]);
  expect(sync.isObserved(3)).toBe(true);
  expect(sync.viewersOf(4).has("p1")).toBe(true);
  // A second adopt replaces the first record and leaves no observer behind.
  sync.adopt("p1", "main", "main:layer_1", [4]);
  expect([...sync.knownBy("p1")]).toEqual([4]);
  expect(sync.isObserved(3)).toBe(false);
  sync.forget("p1");
  expect(sync.isObserved(4)).toBe(false);
  expect(sent).toEqual([]);
});
