import { describe, expect, mock, test } from "bun:test";

mock.module("../controllers/sqldatabase", () => ({ default: async () => [] }));

const { CreatureRegistry } = await import("../systems/creatures/registry");
const { CreatureSpawner, computeMaxHealth, pickTemplateId, rollRespawnMs } = await import("../systems/creatures/spawner");
const { normalizeSpawn, normalizeTemplate, normalizeSpawnPool } = await import("../systems/creatures/repository");
const { POOL_RETRY_MS } = await import("../systems/creatures/constants");
const { createCombatState } = await import("../systems/creatures/threat");
const { createAuras } = await import("../systems/creatures/auras");

const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const template = (over: any = {}) => normalizeTemplate({ id: 1, name: "Wolf", level_min: 3, level_max: 5, health_base: 50, health_per_level: 10, ...over });
const spawn = (over: any = {}) => normalizeSpawn({ id: 1, template_id: 1, map: "main", x: 100, y: 200, respawn_min_s: 10, respawn_max_s: 20, layer_policy: "shared", ...over });

function setup(opts: { templates?: any[]; spawns?: any[]; pools?: any[]; r?: () => number } = {}) {
  const registry = new CreatureRegistry(64);
  const events: string[] = [];
  const spawner = new CreatureSpawner(
    registry,
    { onSpawn: (c) => events.push(`spawn:${c.id}`), onDespawn: (c) => events.push(`despawn:${c.id}`) },
    opts.r ?? (() => 0),
    1
  );
  const templates = opts.templates ?? [template()];
  const spawns = opts.spawns ?? [spawn()];
  spawner.load(
    {
      templates: new Map(templates.map((t) => [t.id, t])),
      spawns: new Map(spawns.map((s) => [s.id, s])),
      pools: new Map((opts.pools ?? []).map((p) => [p.id, p])),
    },
    1000
  );
  return { registry, spawner, events };
}

describe("creature normalizers", () => {
  test("clamps and defaults template fields", () => {
    const t = normalizeTemplate({ id: "7", name: "Boar", level_min: 0, level_max: -2, stance: "bogus", rank: "elite", regen_ooc: 0 });
    expect(t.id).toBe(7);
    expect(t.level_min).toBe(1);
    expect(t.level_max).toBe(1);
    expect(t.stance).toBe("aggressive");
    expect(t.rank).toBe("elite");
    expect(t.regen_ooc).toBe(false);
    expect(t.aggro_radius_override).toBeNull();
  });

  test("spawn strips .json from map and orders respawn window", () => {
    const s = normalizeSpawn({ id: 1, template_id: 1, map: "main.json", respawn_min_s: 60, respawn_max_s: 30 });
    expect(s.map).toBe("main");
    expect(s.respawn_max_s).toBe(60);
  });
});

describe("creature spawner", () => {
  test("health scales with level", () => {
    expect(computeMaxHealth(template(), 1)).toBe(50);
    expect(computeMaxHealth(template(), 5)).toBe(90);
  });

  test("spawns every spawn point on load at its home position", () => {
    const { registry, spawner, events } = setup();
    expect(registry.size).toBe(1);
    const id = spawner.getLiveInstanceId(1)!;
    const c = registry.get(id)!;
    expect(c.x).toBe(100);
    expect(c.homeY).toBe(200);
    expect(c.level).toBe(3);
    expect(c.health).toBe(c.maxHealth);
    expect(events).toEqual([`spawn:${id}`]);
  });

  test("respawn time rolls within the window", () => {
    expect(rollRespawnMs(spawn(), 1, () => 0)).toBe(10_000);
    expect(rollRespawnMs(spawn(), 1, () => 0.999999)).toBeCloseTo(20_000, -1);
    expect(rollRespawnMs(spawn(), 0.5, () => 0)).toBe(5_000);
  });

  test("despawn schedules a respawn and tick brings it back", () => {
    const { registry, spawner } = setup();
    const first = spawner.getLiveInstanceId(1)!;
    spawner.despawn(first, 2000);
    expect(registry.size).toBe(0);
    expect(spawner.getPendingAt(1)).toBe(12_000);

    spawner.tick(11_999);
    expect(registry.size).toBe(0);
    spawner.tick(12_000);
    expect(registry.size).toBe(1);
    expect(spawner.getLiveInstanceId(1)).not.toBe(first);
  });

  test("despawn without respawn leaves the point empty", () => {
    const { registry, spawner } = setup();
    spawner.despawn(spawner.getLiveInstanceId(1)!, 2000, { respawn: false });
    spawner.tick(10_000_000);
    expect(registry.size).toBe(0);
  });

  test("pool caps active creatures and retries later", () => {
    const pool = normalizeSpawnPool({ id: 9, max_active: 1 });
    const { registry, spawner } = setup({
      spawns: [spawn({ id: 1, pool_id: 9 }), spawn({ id: 2, pool_id: 9, x: 500 })],
      pools: [pool],
    });
    expect(registry.size).toBe(1);
    expect(spawner.activeInPool(9)).toBe(1);
    expect(spawner.getPendingAt(2)).toBe(1000 + POOL_RETRY_MS);

    spawner.despawn(spawner.getLiveInstanceId(1)!, 5000);
    spawner.tick(1000 + POOL_RETRY_MS);
    expect(spawner.getLiveInstanceId(2)).toBeDefined();
    expect(spawner.activeInPool(9)).toBe(1);
  });

  test("rare roll replaces the placeholder but never twice at once", () => {
    const pool = normalizeSpawnPool({ id: 9, max_active: 2, rare_chance_pct: 50, rare_template_id: 2 });
    expect(pickTemplateId(spawn(), pool, false, () => 0.1)).toBe(2);
    expect(pickTemplateId(spawn(), pool, false, () => 0.9)).toBe(1);
    expect(pickTemplateId(spawn(), pool, true, () => 0)).toBe(1);

    const { registry } = setup({
      templates: [template(), template({ id: 2, name: "Old Greymane", rank: "rare" })],
      spawns: [spawn({ id: 1, pool_id: 9 }), spawn({ id: 2, pool_id: 9, x: 400 })],
      pools: [pool],
      r: seq(0),
    });
    const templates = [...registry.all()].map((c) => c.templateId).sort();
    expect(templates).toEqual([1, 2]);
  });

  test("reload despawns old creatures without scheduling respawns", () => {
    const { registry, spawner, events } = setup();
    spawner.load({ templates: new Map(), spawns: new Map(), pools: new Map() }, 5000);
    expect(registry.size).toBe(0);
    expect(events.filter((e) => e.startsWith("despawn")).length).toBe(1);
    expect(spawner.getPendingAt(1)).toBeUndefined();
  });
});

describe("creature registry", () => {
  test("radius query respects cells and moves", () => {
    const registry = new CreatureRegistry(64);
    const base = { templateId: 1, spawnId: 1, poolId: null, layerId: null, dir: "down", level: 1, health: 1, maxHealth: 1, state: "idle" as const, spawnedAt: 0, move: null, waitUntil: 0, patrolIndex: 0, patrolForward: true, sentX: 0, sentY: 0, sentDir: "down", sentMoving: false };
    registry.add({ ...base, combat: createCombatState(), auras: createAuras(), casting: null, abilityStates: new Map(), id: 1, map: "main", x: 10, y: 10, homeX: 10, homeY: 10 });
    registry.add({ ...base, combat: createCombatState(), auras: createAuras(), casting: null, abilityStates: new Map(), id: 2, map: "main", x: 300, y: 300, homeX: 300, homeY: 300 });
    registry.add({ ...base, combat: createCombatState(), auras: createAuras(), casting: null, abilityStates: new Map(), id: 3, map: "cave", x: 10, y: 10, homeX: 10, homeY: 10 });

    expect(registry.queryRadius("main", 0, 0, 50).map((c) => c.id)).toEqual([1]);
    registry.move(registry.get(2)!, 20, 20);
    expect(registry.queryRadius("main", 0, 0, 50).map((c) => c.id).sort()).toEqual([1, 2]);
    registry.remove(1);
    expect(registry.queryRadius("main", 0, 0, 50).map((c) => c.id)).toEqual([2]);
    expect([...registry.mapsWithCreatures()].sort()).toEqual(["cave", "main"]);
  });
});

describe("per-layer spawning", () => {
  function layered() {
    const registry = new CreatureRegistry(64);
    const spawner = new CreatureSpawner(registry, {}, () => 0, 1);
    spawner.load(
      {
        templates: new Map([[1, template()]]),
        spawns: new Map([
          [1, spawn({ id: 1, layer_policy: "per_layer" })],
          [2, spawn({ id: 2, layer_policy: "shared", x: 900 })],
        ]),
        pools: new Map(),
      },
      1000
    );
    return { registry, spawner };
  }

  test("per_layer spawns wait for a layer; shared spawn immediately", () => {
    const { registry, spawner } = layered();
    expect(registry.size).toBe(1);
    expect(spawner.getLiveInstanceId(2)).toBeDefined();
    expect([...spawner.perLayerMaps()]).toEqual(["main"]);
  });

  test("each layer gets its own copy, removed when the layer goes away", () => {
    const { registry, spawner } = layered();
    spawner.setLayers(new Map([["main", ["main:layer_1", "main:layer_2"]]]), 2000);
    spawner.tick(2000);
    const a = spawner.getLiveInstanceId(1, "main:layer_1")!;
    const b = spawner.getLiveInstanceId(1, "main:layer_2")!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(registry.get(a)!.layerId).toBe("main:layer_1");
    expect(registry.size).toBe(3);

    spawner.setLayers(new Map([["main", ["main:layer_1"]]]), 3000);
    expect(registry.get(b)).toBeUndefined();
    expect(spawner.getPendingAt(1, "main:layer_2")).toBeUndefined();
    expect(registry.size).toBe(2);
  });

  test("an unchanged layer set is a no-op, and one layer leaving spares the others", () => {
    const { registry, spawner } = layered();
    spawner.setLayers(new Map([["main", ["main:layer_1", "main:layer_2"]]]), 2000);
    spawner.tick(2000);
    const keep = spawner.getLiveInstanceId(1, "main:layer_1")!;
    const drop = spawner.getLiveInstanceId(1, "main:layer_2")!;

    // Same layers again: nothing is despawned or rescheduled.
    spawner.setLayers(new Map([["main", ["main:layer_2", "main:layer_1"]]]), 2100);
    expect(spawner.getLiveInstanceId(1, "main:layer_1")).toBe(keep);
    expect(spawner.getLiveInstanceId(1, "main:layer_2")).toBe(drop);

    // Only the departing layer's creatures are removed.
    spawner.setLayers(new Map([["main", ["main:layer_1"]]]), 2200);
    expect(registry.get(keep)).toBeDefined();
    expect(registry.get(drop)).toBeUndefined();

    // The layer coming back gets a fresh copy.
    spawner.setLayers(new Map([["main", ["main:layer_1", "main:layer_2"]]]), 2300);
    spawner.tick(2300);
    const fresh = spawner.getLiveInstanceId(1, "main:layer_2")!;
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(drop);
  });

  test("a death on a vanished layer does not schedule a respawn", () => {
    const { spawner } = layered();
    spawner.setLayers(new Map([["main", ["main:layer_1"]]]), 2000);
    spawner.tick(2000);
    const id = spawner.getLiveInstanceId(1, "main:layer_1")!;
    spawner.setLayers(new Map([["main", []]]), 2500);
    spawner.despawn(id, 2600);
    expect(spawner.getPendingAt(1, "main:layer_1")).toBeUndefined();
  });
});

describe("spawn burst spreading", () => {
  test("at most 100 spawn per tick; the rest follow on later ticks", () => {
    const spawns = Array.from({ length: 250 }, (_, i) => spawn({ id: i + 1, x: i * 40 }));
    const { registry, spawner } = setup({ spawns });

    // load() ticks once, so the first 100 are already live.
    expect(registry.size).toBe(100);

    spawner.tick(1000);
    expect(registry.size).toBe(200);

    spawner.tick(1000);
    expect(registry.size).toBe(250);

    // Nothing pending: a further tick changes nothing.
    spawner.tick(1000);
    expect(registry.size).toBe(250);
  });

  test("a spawn delayed past this tick is not counted against the cap", () => {
    const spawns = Array.from({ length: 3 }, (_, i) => spawn({ id: i + 1, x: i * 40 }));
    const { registry, spawner } = setup({ spawns });
    expect(registry.size).toBe(3);

    // Kill one and check it stays away until its respawn window elapses.
    const id = spawner.getLiveInstanceId(1)!;
    spawner.despawn(id, 1000);
    expect(registry.size).toBe(2);
    spawner.tick(1000);
    expect(registry.size).toBe(2);
    spawner.tick(10_000_000);
    expect(registry.size).toBe(3);
  });
});

describe("editor data updates", () => {
  function loaded() {
    const registry = new CreatureRegistry(64);
    const despawned: number[] = [];
    const spawner = new CreatureSpawner(registry, { onDespawn: (c) => despawned.push(c.id) }, () => 0, 1);
    const data = {
      templates: new Map([[1, template()]]),
      spawns: new Map([[1, spawn({ id: 1 })], [2, spawn({ id: 2, x: 500 })]]),
      pools: new Map(),
    };
    spawner.load(data, 1000);
    return { registry, spawner, despawned, data };
  }

  test("existing creatures survive a data update untouched", () => {
    const { registry, spawner, despawned, data } = loaded();
    const before = spawner.getLiveInstanceId(1);
    spawner.updateData({ ...data, templates: new Map([[1, template({ health_base: 999 })]]) }, 2000);
    expect(spawner.getLiveInstanceId(1)).toBe(before);
    expect(despawned).toEqual([]);
    expect(registry.size).toBe(2);
  });

  test("new spawn points spawn immediately; deleted ones are removed without respawn", () => {
    const { registry, spawner, despawned, data } = loaded();
    const removedId = spawner.getLiveInstanceId(2)!;
    const spawns = new Map([[1, spawn({ id: 1 })], [3, spawn({ id: 3, x: 900 })]]);
    spawner.updateData({ ...data, spawns }, 2000);
    expect(spawner.getLiveInstanceId(3)).toBeDefined();
    expect(registry.get(removedId)).toBeUndefined();
    expect(despawned).toEqual([removedId]);
    spawner.tick(10_000_000);
    expect(spawner.getLiveInstanceId(2)).toBeUndefined();
    expect(registry.size).toBe(2);
  });

  test("despawn with delay 0 respawns on the next tick using the new template", () => {
    const { registry, spawner, data } = loaded();
    spawner.updateData({ ...data, templates: new Map([[1, template({ health_base: 999, health_per_level: 0 })]]) }, 2000);
    const old = spawner.getLiveInstanceId(1)!;
    spawner.despawn(old, 2000, { delayMs: 0 });
    spawner.tick(2000);
    const fresh = registry.get(spawner.getLiveInstanceId(1)!)!;
    expect(fresh.id).not.toBe(old);
    expect(fresh.maxHealth).toBe(999);
  });
});
