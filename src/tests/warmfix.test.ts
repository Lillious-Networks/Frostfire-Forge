import { afterEach, describe, expect, mock, test } from "bun:test";
import { databaseModule, standInFor } from "./setup";

// Nothing here reads the database.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

await standInFor("../services/playermanager", () => ({
  default: { list: () => ({}), get: () => undefined, set: () => {}, add: () => {}, remove: () => {}, clear: () => {} },
}));

const stream = await import("../systems/npcStreaming");
const { useStreamSource, readNpcList, syncNpcChunks, warmStreamData, warmStreamDataWithin, heldStaticList } = stream;

const base = { last_updated: null, hidden: false, script: null, dialog: null, quest_giver: false, sprite_type: "animated" };
const npc = (id: number, map: string, x: number, y: number, more: Record<string, unknown> = {}) =>
  ({ ...base, id, name: `npc${id}`, map, position: { x, y, direction: "down" }, particles: null, ...more }) as unknown as Npc;
const NPCS = [npc(1, "overworld", 10, 10, { particles: "glow" }), npc(2, "overworld", 50, 50), npc(3, "house_1", 5, 5)];
const PARTICLES = [{ name: "glow", color: "#fff" }];
const MAPS = [
  { name: "overworld.json", data: { tilewidth: 32, width: 200, height: 200 } },
  { name: "house_1.json", data: { tilewidth: 32, width: 20, height: 20 } },
];

/** A cache that answers like Redis does: a new copy on every read, a read takes a while; counts reads by key. */
function redisLike(initial: Record<string, any>) {
  const data = new Map<string, any>(Object.entries(initial));
  const reads: string[] = [];
  const failing = new Set<string>();
  return {
    reads,
    failing,
    readsOf: (key: string) => reads.filter((k) => k === key).length,
    cache: {
      get: async (key: string) => {
        reads.push(key);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (failing.has(key)) throw new Error(`${key} is unreadable`);
        const v = data.get(key);
        return v === undefined ? null : structuredClone(v);
      },
      onChange: () => {},
    },
  };
}

const defaultSource = stream.streamSource.cache;
afterEach(() => {
  useStreamSource(defaultSource, () => false);
});

const player = (id: string, map: string, x: number, y: number) => ({ id, location: { map, position: { x, y } } });

describe("warmStreamData", () => {
  test("after the warm-up the first arrival reads nothing from the cache", async () => {
    const r = redisLike({ npcs: NPCS, particles: PARTICLES, maps: MAPS });
    useStreamSource(r.cache, () => true);
    await warmStreamData();
    const readsAfterWarm = r.reads.length;
    expect(r.readsOf("npcs")).toBe(1);
    expect(r.readsOf("particles")).toBe(1);
    expect(r.readsOf("maps")).toBe(1);

    expect((await readNpcList()).length).toBe(3);
    const packets = await syncNpcChunks(player("p1", "overworld", 20, 20), true);
    expect(packets.length).toBeGreaterThan(0);
    expect(r.reads.length).toBe(readsAfterWarm);
  });

  test("without the warm-up the first arrival does read them (the stall this removes)", async () => {
    const r = redisLike({ npcs: NPCS, particles: PARTICLES, maps: MAPS });
    useStreamSource(r.cache, () => true);
    await syncNpcChunks(player("p1", "overworld", 20, 20), true);
    expect(r.readsOf("npcs")).toBe(1);
    expect(r.readsOf("maps")).toBe(1);
    expect(r.readsOf("particles")).toBe(1);
  });

  test("a warm-up that fails leaves the lazy path working", async () => {
    const r = redisLike({ npcs: NPCS, particles: PARTICLES, maps: MAPS });
    useStreamSource(r.cache, () => true);
    r.failing.add("npcs");
    r.failing.add("maps");
    await expect(warmStreamData()).resolves.toBeUndefined();
    expect(heldStaticList("npcs")).toBeNull();
    r.failing.clear();
    expect((await readNpcList()).map((n) => n.id)).toEqual([1, 2, 3]);
    const packets = await syncNpcChunks(player("p1", "overworld", 20, 20), true);
    expect(packets.length).toBeGreaterThan(0);
  });

  test("lazy reads during the warm-up share its loads", async () => {
    const r = redisLike({ npcs: NPCS, particles: PARTICLES, maps: MAPS });
    useStreamSource(r.cache, () => true);
    const warm = warmStreamData();
    const lazy = readNpcList();
    const arrival = syncNpcChunks(player("p1", "overworld", 20, 20), true);
    await Promise.all([warm, lazy, arrival]);
    expect(r.readsOf("npcs")).toBe(1);
    expect(r.readsOf("maps")).toBe(1);
    expect(r.readsOf("particles")).toBe(1);
  });

  test("a second warm-up costs nothing", async () => {
    const r = redisLike({ npcs: NPCS, particles: PARTICLES, maps: MAPS });
    useStreamSource(r.cache, () => true);
    await Promise.all([warmStreamData(), warmStreamData()]);
    await warmStreamData();
    expect(r.reads.length).toBe(5); // npcs, particles, maps, mapProperties, spells
  });

  test("with CACHE=memory it warms too and changes no answer", async () => {
    const r = redisLike({ npcs: NPCS, particles: PARTICLES, maps: MAPS });
    useStreamSource(r.cache, () => false);
    await warmStreamData();
    const warmed = await syncNpcChunks(player("p1", "overworld", 20, 20), true);
    useStreamSource(r.cache, () => false);
    const cold = await syncNpcChunks(player("p1", "overworld", 20, 20), true);
    expect(warmed).toEqual(cold);
  });
});

describe("warmStreamDataWithin", () => {
  test("start-up's wait returns after the cap when a read never resolves; a later lazy read works once it does", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const data: Record<string, any> = { npcs: NPCS, particles: PARTICLES, maps: MAPS };
    let reads = 0;
    useStreamSource({
      get: async (key: string) => { reads++; await gate; return structuredClone(data[key] ?? null); },
      onChange: () => {},
    }, () => true);
    const started = performance.now();
    await warmStreamDataWithin(30);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(heldStaticList("npcs")).toBeNull();
    const lazy = readNpcList(); // shares the warm-up's load
    release();
    expect((await lazy).map((n) => n.id)).toEqual([1, 2, 3]);
    await warmStreamData();
    expect(reads).toBe(5); // npcs, particles, maps, mapProperties, spells: once each
  });

  test("returns as soon as the warm-up is done, not at the cap", async () => {
    const r = redisLike({ npcs: NPCS, particles: PARTICLES, maps: MAPS });
    useStreamSource(r.cache, () => true);
    const started = performance.now();
    await warmStreamDataWithin(5000);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(heldStaticList("npcs")).not.toBeNull();
  });
});
