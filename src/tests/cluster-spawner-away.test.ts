import { describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { CreatureRegistry } = await import("../systems/creatures/registry");
const { CreatureSpawner } = await import("../systems/creatures/spawner");
const { normalizeSpawn, normalizeTemplate, normalizeSpawnPool } = await import("../systems/creatures/repository");
const { default: log } = await import("../modules/logger");

const template = (over: any = {}) => normalizeTemplate({ id: 1, name: "Wolf", level_min: 3, level_max: 5, health_base: 50, health_per_level: 10, ...over });
const spawn = (over: any = {}) => normalizeSpawn({ id: 1, template_id: 1, map: "main", x: 100, y: 200, respawn_min_s: 10, respawn_max_s: 20, layer_policy: "shared", ...over });

function setup(opts: { templates?: any[]; spawns?: any[]; pools?: any[] } = {}) {
  const registry = new CreatureRegistry(64);
  const events: string[] = [];
  const spawner = new CreatureSpawner(registry, {
    onSpawn: (c) => events.push(`spawn:${c.id}`),
    onDespawn: (c) => events.push(`despawn:${c.id}`),
    onForeignGone: (c, home, o) => events.push(`gone:${c.id}:${home}:${o.respawn}:${o.delayMs}`),
  }, () => 0, 1);
  const data = () => ({
    templates: new Map((opts.templates ?? [template()]).map((t) => [t.id, t])),
    spawns: new Map((opts.spawns ?? [spawn()]).map((s) => [s.id, s])),
    pools: new Map((opts.pools ?? []).map((p) => [p.id, p])),
    patrolPaths: new Map(),
  });
  spawner.load(data(), 1000);
  return { registry, spawner, events, data };
}

describe("away slots on the creature's home", () => {
  test("an away slot is not spawned again", () => {
    const { registry, spawner, data } = setup();
    const id = spawner.getLiveInstanceId(1)!;
    expect(spawner.markAway(id, "b")).toBe(true);
    // The handed-off copy becomes a mirror; here it is simply gone from the registry.
    registry.remove(id);
    spawner.tick(10_000_000);
    expect(spawner.getLiveInstanceId(1)).toBeUndefined();
    expect(spawner.getPendingAt(1)).toBeUndefined();
    // Guard: isKnown counts away slots. Without it a data update schedules the slot and spawns a second wolf.
    spawner.updateData(data(), 20_000_000);
    spawner.tick(30_000_000);
    expect(spawner.getLiveInstanceId(1)).toBeUndefined();
    expect(spawner.getPendingAt(1)).toBeUndefined();
    expect([...registry.all()]).toHaveLength(0);
    expect(spawner.awaySlots()).toEqual([{ instanceId: id, spawnId: 1, layerId: null, poolId: null, templateId: 1, holder: "b" }]);
  });

  test("an away per-layer slot is not given a second copy when its layer is reconciled", () => {
    const { registry, spawner, data } = setup({ spawns: [spawn({ layer_policy: "per_layer" })] });
    spawner.setLayers(new Map([["main", ["main:layer_1"]]]), 2_000);
    spawner.tick(2_000);
    const id = spawner.getLiveInstanceId(1, "main:layer_1")!;
    expect(id).toBeDefined();
    spawner.markAway(id, "b");
    registry.remove(id);
    // Guard: isKnown in reconcileLayers.
    spawner.updateData(data(), 3_000);
    spawner.tick(10_000_000);
    expect(spawner.getLiveInstanceId(1, "main:layer_1")).toBeUndefined();
    expect(spawner.getPendingAt(1, "main:layer_1")).toBeUndefined();
    expect(spawner.awaySlots()).toHaveLength(1);
  });

  test("releasing an away slot schedules the respawn once", () => {
    const { registry, spawner } = setup();
    const id = spawner.getLiveInstanceId(1)!;
    spawner.markAway(id, "b");
    registry.remove(id);
    expect(spawner.releaseAway(id, 5_000, { delayMs: 3_000 })).toBe(true);
    expect(spawner.getPendingAt(1)).toBe(8_000);
    // Guard: idempotent. A CREATURE_DIED sent twice must not move the respawn or count twice.
    expect(spawner.releaseAway(id, 6_000, { delayMs: 3_000 })).toBe(false);
    expect(spawner.getPendingAt(1)).toBe(8_000);
    expect(spawner.awaySlots()).toEqual([]);
  });

  test("an away slot released with no respawn stays empty", () => {
    const { registry, spawner } = setup();
    const id = spawner.getLiveInstanceId(1)!;
    spawner.markAway(id, "b");
    registry.remove(id);
    spawner.releaseAway(id, 5_000, { respawn: false });
    expect(spawner.getPendingAt(1)).toBeUndefined();
  });

  test("an away slot moves between holders", () => {
    const { spawner } = setup();
    const id = spawner.getLiveInstanceId(1)!;
    spawner.markAway(id, "b");
    expect(spawner.moveAway(id, "c")).toBe(true);
    expect(spawner.awaySlots()[0].holder).toBe("c");
    expect(spawner.moveAway(999, "c")).toBe(false);
  });

  test("a creature goes away once, and only if it is the slot's live one", () => {
    const { registry, spawner } = setup();
    const id = spawner.getLiveInstanceId(1)!;
    expect(spawner.markAway(id, "b")).toBe(true);
    // Guard: the live check. The instance is still registered, but its slot is already away.
    expect(spawner.markAway(id, "c")).toBe(false);
    expect(spawner.awaySlots()).toHaveLength(1);
    expect(spawner.awaySlots()[0].holder).toBe("b");
    expect(spawner.markAway(12345, "b")).toBe(false);
    registry.remove(id);
  });

  test("an away rare still counts as alive in its pool", () => {
    const pool = normalizeSpawnPool({ id: 5, max_active: 2, rare_chance_pct: 100, rare_template_id: 2 });
    const { registry, spawner } = setup({
      templates: [template(), template({ id: 2, name: "Old Grey" })],
      spawns: [spawn({ id: 1, pool_id: 5 }), spawn({ id: 2, pool_id: 5, x: 300 })],
      pools: [pool],
    });
    const rare = [...registry.all()].find((c) => c.templateId === 2);
    const other = [...registry.all()].find((c) => c.templateId === 1);
    expect(rare).toBeDefined();
    expect(other).toBeDefined();
    spawner.markAway(rare!.id, "b");
    registry.remove(rare!.id);
    // The rare is away but still in its pool.
    expect(spawner.activeInPool(5)).toBe(2);
    // Its pool-mate dies and respawns. Guard: isRareAlive reads the away slot's template. Without it a
    // second rare (chance 100) spawns while the first lives on another node.
    spawner.despawn(other!.id, 5_000, { delayMs: 0 });
    spawner.tick(6_000);
    const now = [...registry.all()];
    expect(now).toHaveLength(1);
    expect(now[0].templateId).toBe(1);
  });

  test("releasing an away pool member frees its place in the pool", () => {
    const pool = normalizeSpawnPool({ id: 5, max_active: 1 });
    const { registry, spawner } = setup({ spawns: [spawn({ id: 1, pool_id: 5 })], pools: [pool] });
    const id = spawner.getLiveInstanceId(1)!;
    spawner.markAway(id, "b");
    registry.remove(id);
    expect(spawner.activeInPool(5)).toBe(1);
    spawner.releaseAway(id, 5_000, { respawn: false });
    expect(spawner.activeInPool(5)).toBe(0);
  });

  test("a creature handed back to its home is live there again", () => {
    const { registry, spawner } = setup();
    const id = spawner.getLiveInstanceId(1)!;
    const instance = registry.get(id)!;
    spawner.markAway(id, "b");
    registry.remove(id);
    spawner.adopt(instance, null);
    expect(spawner.getLiveInstanceId(1)).toBe(id);
    expect(spawner.awaySlots()).toEqual([]);
    expect(spawner.foreignCreatures()).toEqual([]);
    // And it is the slot's creature again: its death schedules the respawn.
    spawner.despawn(id, 5_000, { delayMs: 1_000 });
    expect(spawner.getPendingAt(1)).toBe(6_000);
  });

  test("adopt replaces a mirror of the same creature left in the registry", () => {
    const { registry, spawner } = setup();
    const id = spawner.getLiveInstanceId(1)!;
    const instance = registry.get(id)!;
    spawner.markAway(id, "b");
    // The mirror sits where the creature was; the creature comes back from elsewhere.
    registry.remove(id);
    registry.add({ ...instance, remote: true });
    // One cell over (the registry's cells are 64 px here).
    expect(spawner.adopt({ ...instance, x: 130 }, null)).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.get(id)!.remote).toBeUndefined();
    // Guard: adopt removes the mirror first. A stale cell entry for the mirror's position would show the creature twice.
    expect(registry.queryRadius("main", 115, 200, 60)).toHaveLength(1);
  });

  test("a reload drops away slots", () => {
    const { registry, spawner } = setup();
    const id = spawner.getLiveInstanceId(1)!;
    spawner.markAway(id, "b");
    registry.remove(id);
    spawner.load({ templates: new Map([[1, template()]]), spawns: new Map([[1, spawn()]]), pools: new Map(), patrolPaths: new Map() }, 2_000);
    expect(spawner.awaySlots()).toEqual([]);
    // The slot starts over: it spawns afresh.
    expect(spawner.getLiveInstanceId(1)).toBeDefined();
  });

  test("a pool spawns again after a reload that dropped its away creature", () => {
    const pool = normalizeSpawnPool({ id: 5, max_active: 1 });
    const { registry, spawner, data } = setup({ spawns: [spawn({ id: 1, pool_id: 5 }), spawn({ id: 2, pool_id: 5, x: 300 })], pools: [pool] });
    const id = [...registry.all()][0].id;
    spawner.markAway(id, "b");
    registry.remove(id);
    expect(spawner.activeInPool(5)).toBe(1);
    spawner.load(data(), 2_000);
    // Guard: load takes the away creature out of its pool. Without it the pool counts it forever and never spawns.
    expect(spawner.activeInPool(5)).toBe(1);
    expect([...registry.all()]).toHaveLength(1);
    spawner.tick(10_000_000);
    expect([...registry.all()]).toHaveLength(1);
  });

  test("a reloaded away rare no longer counts as alive", () => {
    const pool = normalizeSpawnPool({ id: 5, max_active: 2, rare_chance_pct: 100, rare_template_id: 2 });
    const { registry, spawner, data } = setup({
      templates: [template(), template({ id: 2, name: "Old Grey" })],
      spawns: [spawn({ id: 1, pool_id: 5 }), spawn({ id: 2, pool_id: 5, x: 300 })],
      pools: [pool],
    });
    const rare = [...registry.all()].find((c) => c.templateId === 2)!;
    spawner.markAway(rare.id, "b");
    registry.remove(rare.id);
    spawner.load(data(), 2_000);
    // The pool is whole again: one rare and one placeholder, as at the first load.
    expect([...registry.all()].map((c) => c.templateId).sort()).toEqual([1, 2]);
  });

  test("a creature coming home to a slot that is no longer away is refused, and no second copy appears", () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const { registry, spawner, data } = setup();
      const id = spawner.getLiveInstanceId(1)!;
      const instance = registry.get(id)!;
      spawner.markAway(id, "b");
      registry.remove(id);
      // A reload inside the handoff's commit window: the slot spawns afresh.
      spawner.load(data(), 2_000);
      const fresh = spawner.getLiveInstanceId(1)!;
      expect(fresh).not.toBe(id);
      // Guard: adopt refuses a home creature with no away slot. Without it two wolves stand in the world.
      expect(spawner.adopt({ ...instance }, null)).toBe(false);
      expect([...registry.all()].map((c) => c.id)).toEqual([fresh]);
      expect(spawner.getLiveInstanceId(1)).toBe(fresh);
      expect(warn.mock.calls.map((c) => String(c[0])).join(" | ")).toContain("Wolf");
    } finally {
      warn.mockRestore();
    }
  });

  test("despawning the mirror of an away slot leaves the slot away", () => {
    const pool = normalizeSpawnPool({ id: 5, max_active: 1 });
    const { registry, spawner, events } = setup({ spawns: [spawn({ id: 1, pool_id: 5 })], pools: [pool] });
    const id = spawner.getLiveInstanceId(1)!;
    const instance = registry.get(id)!;
    spawner.markAway(id, "b");
    registry.remove(id);
    registry.add({ ...instance, remote: true });
    spawner.despawn(id, 5_000);
    // Guard: despawn's away check. Without it the slot is scheduled while the creature lives on another node.
    expect(spawner.getPendingAt(1)).toBeUndefined();
    expect(spawner.awaySlots()).toHaveLength(1);
    expect(spawner.activeInPool(5)).toBe(1);
    expect(registry.get(id)).toBeUndefined();
    expect(events).toContain(`despawn:${id}`);
    spawner.tick(10_000_000);
    expect([...registry.all()]).toHaveLength(0);
  });

  test("a deleted spawn point releases its away slot with no respawn", () => {
    const { registry, spawner } = setup();
    const id = spawner.getLiveInstanceId(1)!;
    spawner.markAway(id, "b");
    registry.remove(id);
    spawner.updateData({ templates: new Map([[1, template()]]), spawns: new Map(), pools: new Map(), patrolPaths: new Map() }, 3_000);
    expect(spawner.awaySlots()).toEqual([]);
    expect(spawner.getPendingAt(1)).toBeUndefined();
  });

  test("a vanished layer releases its away slots with no respawn", () => {
    const { registry, spawner } = setup({ spawns: [spawn({ layer_policy: "per_layer" })] });
    spawner.setLayers(new Map([["main", ["main:layer_1"]]]), 2_000);
    spawner.tick(2_000);
    const id = spawner.getLiveInstanceId(1, "main:layer_1")!;
    spawner.markAway(id, "b");
    registry.remove(id);
    spawner.setLayers(new Map([["main", []]]), 3_000);
    expect(spawner.awaySlots()).toEqual([]);
    expect(spawner.getPendingAt(1, "main:layer_1")).toBeUndefined();
  });
});

describe("foreign creatures on their holder", () => {
  test("a foreign creature's death goes to its home, not to a respawn here", () => {
    const home = setup();
    const id = home.spawner.getLiveInstanceId(1)!;
    const instance = home.registry.get(id)!;
    const holder = setup({ spawns: [] });
    holder.spawner.adopt({ ...instance }, "a");
    expect(holder.registry.get(id)).toBeDefined();
    expect(holder.spawner.foreignHome(id)).toBe("a");
    holder.spawner.despawn(id, 5_000, { delayMs: 2_000 });
    // Guard: the foreign branch of despawn. Without it the holder schedules a slot it does not own.
    expect(holder.spawner.getPendingAt(1)).toBeUndefined();
    expect(holder.events).toContain(`despawn:${id}`);
    expect(holder.events).toContain(`gone:${id}:a:true:2000`);
    expect(holder.spawner.foreignCreatures()).toEqual([]);
  });

  test("a foreign creature whose spawn point the holder also has does not take that slot", () => {
    const home = setup();
    const instance = home.registry.get(home.spawner.getLiveInstanceId(1)!)!;
    // The holder knows spawn 1 too (same data) but owns none of its slots here.
    const holder = setup();
    holder.spawner.despawn(holder.spawner.getLiveInstanceId(1)!, 1_500, { respawn: false });
    holder.spawner.adopt({ ...instance, id: 777 }, "a");
    expect(holder.spawner.getLiveInstanceId(1)).toBeUndefined();
    holder.spawner.despawn(777, 5_000, { delayMs: 2_000 });
    expect(holder.spawner.getPendingAt(1)).toBeUndefined();
  });

  test("a foreign creature removed with no respawn says so to its home", () => {
    const holder = setup({ spawns: [] });
    const home = setup();
    const instance = home.registry.get(home.spawner.getLiveInstanceId(1)!)!;
    holder.spawner.adopt({ ...instance }, "a");
    holder.spawner.despawn(instance.id, 5_000, { respawn: false });
    expect(holder.events).toContain(`gone:${instance.id}:a:false:null`);
  });

  test("a foreign creature handed on is dropped with no despawn and no message to its home", () => {
    const holder = setup({ spawns: [] });
    const home = setup();
    const instance = home.registry.get(home.spawner.getLiveInstanceId(1)!)!;
    holder.spawner.adopt({ ...instance }, "a");
    holder.spawner.dropForeign(instance.id);
    expect(holder.spawner.foreignHome(instance.id)).toBe(null);
    expect(holder.events.filter((e) => e.startsWith("gone") || e.startsWith("despawn"))).toEqual([]);
  });

  test("adopt announces the creature only when asked", () => {
    const holder = setup({ spawns: [] });
    const home = setup();
    const instance = home.registry.get(home.spawner.getLiveInstanceId(1)!)!;
    holder.spawner.adopt({ ...instance }, "a");
    expect(holder.events).toEqual([]);
    holder.spawner.dropForeign(instance.id);
    holder.registry.remove(instance.id);
    holder.spawner.adopt({ ...instance }, "a", { announce: true });
    expect(holder.events).toEqual([`spawn:${instance.id}`]);
  });

  test("a reload removes foreign creatures and tells their home they are gone for good", () => {
    const holder = setup({ spawns: [] });
    const home = setup();
    const instance = home.registry.get(home.spawner.getLiveInstanceId(1)!)!;
    holder.spawner.adopt({ ...instance }, "a");
    holder.spawner.load({ templates: new Map(), spawns: new Map(), pools: new Map(), patrolPaths: new Map() }, 2_000);
    // Guard: load drops foreign creatures. Without it they linger in the registry with no slot anywhere.
    expect(holder.registry.get(instance.id)).toBeUndefined();
    expect(holder.spawner.foreignCreatures()).toEqual([]);
    expect(holder.events).toContain(`gone:${instance.id}:a:true:null`);
  });

  test("a vanished layer removes the foreign creatures standing on it", () => {
    const holder = setup({ spawns: [] });
    const home = setup();
    const instance = home.registry.get(home.spawner.getLiveInstanceId(1)!)!;
    holder.spawner.setLayers(new Map([["main", ["main:layer_1", "main:layer_2"]]]), 1_500);
    holder.spawner.adopt({ ...instance, layerId: "main:layer_1" }, "a");
    holder.spawner.adopt({ ...instance, id: instance.id + 1, layerId: "main:layer_2" }, "a");
    holder.spawner.setLayers(new Map([["main", ["main:layer_2"]]]), 2_000);
    expect(holder.registry.get(instance.id)).toBeUndefined();
    expect(holder.registry.get(instance.id + 1)).toBeDefined();
    expect(holder.events).toContain(`gone:${instance.id}:a:true:null`);
    expect(holder.spawner.foreignHome(instance.id + 1)).toBe("a");
  });
});
