import { describe, expect, mock, test } from "bun:test";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

const { CreatureRegistry } = await import("../systems/creatures/registry");
const { CreatureSync, diffVisibility } = await import("../systems/creatures/sync");
const { normalizeTemplate } = await import("../systems/creatures/repository");
const { createCombatState } = await import("../systems/creatures/threat");
const { createAuras } = await import("../systems/creatures/auras");

const template = normalizeTemplate({ id: 1, name: "Kobold", stance: "neutral" });
const creature = (id: number, x: number, y: number, map = "main") => ({
  id, templateId: 1, spawnId: id, poolId: null, map, x, y, dir: "down", homeX: x, homeY: y,
  level: 2, health: 60, maxHealth: 60, state: "idle" as const, spawnedAt: 0, layerId: null as string | null,
  move: null, waitUntil: 0, patrolIndex: 0, patrolForward: true, sentX: x, sentY: y, sentDir: "down", sentMoving: false, combat: createCombatState(), auras: createAuras(), casting: null, abilityStates: new Map(),
});

function setup() {
  const registry = new CreatureRegistry(128);
  const players = new Map<string, { id: string; wt: any; map: string; layerId: string | null; x: number; y: number; radius: number }>();
  const sent: Array<{ player: string; kind: "spawn" | "despawn" | "move" | "stop"; ids: number[] }> = [];
  const sync = new CreatureSync({
    registry,
    getTemplate: (id) => (id === 1 ? template : undefined),
    playersOnMap: (map) => [...players.values()].filter((p) => p.map === map).map((p) => p.id),
    resolvePlayer: (id) => players.get(id) ?? null,
    sendSpawn: (wt, snaps) => sent.push({ player: wt, kind: "spawn", ids: snaps.map((s) => s.id) }),
    sendDespawn: (wt, ids) => sent.push({ player: wt, kind: "despawn", ids }),
    sendMoves: (wt, entries, reliable) => sent.push({ player: wt, kind: reliable ? "stop" : "move", ids: entries.map((e) => e[0]) }),
  });
  const addPlayer = (id: string, x: number, y: number, map = "main", layerId: string | null = "main:layer_1") =>
    players.set(id, { id, wt: id, map, layerId, x, y, radius: 100 });
  return { registry, players, sent, sync, addPlayer };
}

describe("diffVisibility", () => {
  test("enters new, keeps hysteresis band, exits far", () => {
    const { enter, exit } = diffVisibility(new Set([1, 2, 3]), [creature(1, 0, 0), creature(4, 0, 0)], (id) => id === 2);
    expect(enter).toEqual([4]);
    expect(exit).toEqual([3]);
  });
});

describe("creature sync", () => {
  test("sends snapshots on enter and despawn once past the hysteresis radius", () => {
    const { registry, sent, sync, addPlayer, players } = setup();
    registry.add(creature(1, 50, 0));
    addPlayer("p1", 0, 0);

    sync.refresh();
    expect(sent).toEqual([{ player: "p1", kind: "spawn", ids: [1] }]);

    sync.refresh();
    expect(sent.length).toBe(1);

    players.get("p1")!.x = -60; // 110 away: outside 100, inside 125
    sync.refresh();
    expect(sent.length).toBe(1);

    players.get("p1")!.x = -100; // 150 away
    sync.refresh();
    expect(sent[1]).toEqual({ player: "p1", kind: "despawn", ids: [1] });
    expect(sync.knownBy("p1").size).toBe(0);
  });

  test("slicing refreshes each player once per cycle, spread over the ticks", () => {
    const { registry, sent, sync, addPlayer } = setup();
    registry.add(creature(1, 0, 0));
    const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
    for (const id of ids) addPlayer(id, 0, 0);

    // One full cycle of 3 slices: every player refreshed exactly once.
    for (let slice = 0; slice < 3; slice++) sync.refresh(slice, 3);
    const spawned = sent.filter((s) => s.kind === "spawn").map((s) => s.player);
    expect(spawned.sort()).toEqual([...ids].sort());

    // Each slice does part of the work, never all of it.
    const perSlice = ids.map((id) => sync.knownBy(id).size);
    expect(perSlice.every((n) => n === 1)).toBe(true);

    // A second cycle has nothing new to send.
    const before = sent.length;
    for (let slice = 0; slice < 3; slice++) sync.refresh(slice, 3);
    expect(sent.length).toBe(before);
  });

  test("a player who left is forgotten even when another slice is refreshing", () => {
    const { registry, sync, addPlayer, players } = setup();
    registry.add(creature(1, 0, 0));
    addPlayer("p1", 0, 0);
    sync.refresh();
    expect(sync.knownBy("p1").size).toBe(1);

    players.delete("p1");
    // Whatever slice runs, a departed player is dropped from tracking.
    sync.refresh(1, 3);
    expect(sync.knownBy("p1").size).toBe(0);
  });

  test("a crowded area is sent in batches instead of one huge tick", () => {
    const { registry, sent, sync, addPlayer } = setup();
    // 400 creatures in range: more than one refresh is allowed to send.
    for (let i = 1; i <= 400; i++) registry.add(creature(i, i % 50, 0));
    addPlayer("p1", 0, 0);

    sync.refresh();
    const first = sent.filter((s) => s.kind === "spawn");
    expect(first).toHaveLength(1);
    expect(first[0].ids.length).toBe(150);
    expect(sync.knownBy("p1").size).toBe(150);

    // The backlog arrives over the following refreshes, not all at once.
    sync.refresh();
    expect(sync.knownBy("p1").size).toBe(300);
    sync.refresh();
    expect(sync.knownBy("p1").size).toBe(400);

    // Nothing left to send once everything is known.
    const before = sent.length;
    sync.refresh();
    expect(sent.length).toBe(before);
  });

  test("does not leak creatures across maps and resets on map change", () => {
    const { registry, sent, sync, addPlayer, players } = setup();
    registry.add(creature(1, 0, 0, "main"));
    registry.add(creature(2, 0, 0, "cave"));
    addPlayer("p1", 0, 0, "main");
    sync.refresh();
    expect(sent.at(-1)!.ids).toEqual([1]);

    players.get("p1")!.map = "cave";
    sync.refresh();
    expect(sent.at(-1)).toEqual({ player: "p1", kind: "spawn", ids: [2] });
    expect([...sync.knownBy("p1")]).toEqual([2]);
  });

  test("despawn notifies only viewers that knew the creature", () => {
    const { registry, sent, sync, addPlayer } = setup();
    const c = creature(1, 0, 0);
    registry.add(c);
    addPlayer("near", 10, 0);
    addPlayer("far", 900, 0);
    sync.refresh();
    sent.length = 0;

    registry.remove(1);
    sync.onDespawn(c);
    expect(sent).toEqual([{ player: "near", kind: "despawn", ids: [1] }]);
  });

  test("onSpawn pushes immediately to players in range", () => {
    const { registry, sent, sync, addPlayer } = setup();
    addPlayer("p1", 0, 0);
    const c = creature(5, 20, 20);
    registry.add(c);
    sync.onSpawn(c);
    expect(sent).toEqual([{ player: "p1", kind: "spawn", ids: [5] }]);
  });

  test("players who leave the world are forgotten", () => {
    const { registry, sync, addPlayer, players } = setup();
    registry.add(creature(1, 0, 0));
    addPlayer("p1", 0, 0);
    sync.refresh();
    players.delete("p1");
    sync.refresh();
    expect(sync.knownBy("p1").size).toBe(0);
  });
});

describe("creature sync layers and movement", () => {
  test("players only see creatures on their own layer plus shared ones", () => {
    const { registry, sent, sync, addPlayer } = setup();
    registry.add({ ...creature(1, 0, 0), layerId: "main:layer_1" });
    registry.add({ ...creature(2, 0, 0), layerId: "main:layer_2" });
    registry.add(creature(3, 0, 0));
    addPlayer("p1", 0, 0, "main", "main:layer_1");
    sync.refresh();
    expect(sent[0].ids.sort()).toEqual([1, 3]);
  });

  test("switching layers despawns the old layer's copies", () => {
    const { registry, sent, sync, addPlayer, players } = setup();
    registry.add({ ...creature(1, 0, 0), layerId: "main:layer_1" });
    registry.add({ ...creature(2, 0, 0), layerId: "main:layer_2" });
    addPlayer("p1", 0, 0, "main", "main:layer_1");
    sync.refresh();
    players.get("p1")!.layerId = "main:layer_2";
    sync.refresh();
    expect(sent[1]).toEqual({ player: "p1", kind: "despawn", ids: [1] });
    expect(sent[2]).toEqual({ player: "p1", kind: "spawn", ids: [2] });
    expect(sync.isObserved(1)).toBe(false);
    expect(sync.isObserved(2)).toBe(true);
  });

  test("observer counts drive dormancy", () => {
    const { registry, sync, addPlayer, players } = setup();
    registry.add(creature(1, 0, 0));
    registry.add(creature(2, 5000, 0));
    addPlayer("a", 0, 0);
    addPlayer("b", 10, 0);
    sync.refresh();
    expect([...sync.observedIds()]).toEqual([1]);
    players.delete("a");
    sync.refresh();
    expect(sync.isObserved(1)).toBe(true);
    sync.forget("b");
    expect(sync.isObserved(1)).toBe(false);
  });

  test("moves go best-effort to viewers; stops go reliable; unchanged is silent", () => {
    const { registry, sent, sync, addPlayer } = setup();
    const c = creature(1, 0, 0);
    registry.add(c);
    addPlayer("p1", 0, 0);
    addPlayer("far", 4000, 0);
    sync.refresh();
    sent.length = 0;

    c.x = 5;
    c.move = { path: [{ x: 10, y: 0 }], index: 0, speed: 20, stuckTicks: 0 } as any;
    sync.flushMoves([c]);
    expect(sent).toEqual([{ player: "p1", kind: "move", ids: [1] }]);

    sync.flushMoves([c]);
    expect(sent.length).toBe(1);

    c.x = 10;
    c.move = null;
    sync.flushMoves([c]);
    expect(sent[1]).toEqual({ player: "p1", kind: "stop", ids: [1] });
  });
});
