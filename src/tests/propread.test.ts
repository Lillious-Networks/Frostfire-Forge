import { afterEach, describe, expect, mock, test } from "bun:test";
import { databaseModule, standInFor } from "./setup";

// Nothing here reads the database.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

// The per-map reads (getNested) are answered from `nested`; the whole-list reads go through the stream source.
let nested: Record<string, any> = {};
await standInFor("../services/assetCache", () => ({
  default: {
    get: async () => null,
    getNested: async (map: string, field: string) => nested[`${map}.${field}`],
    set: async () => {},
    onChange: () => {},
  },
}));

const stream = await import("../systems/npcStreaming");
const { useStreamSource, readHeldList, heldStaticList, warmStreamData, refreshStaticLists } = stream;
const { setSpellLookup } = await import("../cluster/playerhits");
const { default: player } = await import("../systems/player");
const creatures = await import("../systems/creatures");

/** A cache that answers like Redis does: a new copy of the value on every read; counts the reads by key. */
function redisLike(initial: Record<string, any>) {
  const data = new Map<string, any>(Object.entries(initial));
  const reads: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  return {
    readsOf: (key: string) => reads.filter((k) => k === key).length,
    cache: {
      get: async (key: string) => { reads.push(key); const v = data.get(key); return v === undefined ? null : structuredClone(v); },
      getIfChanged: async (key: string, digest: string | null) => {
        const v = data.get(key);
        const now = JSON.stringify(v ?? null);
        if (now === digest) return { digest: now, same: true };
        reads.push(key);
        return { digest: now, same: false, value: v === undefined ? null : structuredClone(v) };
      },
      onChange: (key: string, fn: () => void) => { (listeners.get(key) ?? listeners.set(key, []).get(key)!).push(fn); },
    },
    /** A write made through this process: stores and signals. */
    /** A write by another node: stored, no signal. */
    writeElsewhere(key: string, value: any) { data.set(key, value); },
    write(key: string, value: any) { data.set(key, value); for (const fn of listeners.get(key) ?? []) fn(); },
  };
}

// A Tiled map "tiledmap" 10 x 10 tiles of 32 px whose tiles x 0..4 are no-pvp (run lengths: width, height, value, count...).
const MAP_PROPS = [
  { name: "other.json", tileWidth: 32, tileHeight: 32, width: 4, height: 4 },
  { name: "tiledmap.json", tileWidth: 32, tileHeight: 32, width: 10, height: 10 },
];
const NOPVP_RLE = [10, 10, 1, 5, 0, 5, 1, 5, 0, 5, 1, 5, 0, 5, 1, 5, 0, 5, 1, 5, 0, 5, 1, 5, 0, 5, 1, 5, 0, 5, 1, 5, 0, 5, 1, 5, 0, 5, 1, 5, 0, 5];
const SPELLS = [{ id: 1, name: "Bolt", icon: null, particles: "spark" }, { id: 2, name: "Heal", icon: null }];
const PARTICLES = [{ name: "Spark", size: 1 }];
const at = (x: number, y: number) => ({ x, y, direction: "down" });
const POSITIONS = [at(16, 16), at(200, 16), at(16, 300), at(300, 300), at(5000, 5000)];
const props = { width: 32, height: 32 } as any;

const defaultSource = stream.streamSource.cache;
afterEach(() => {
  useStreamSource(defaultSource, () => false);
  nested = {};
});
/** The per-map nopvp / collision reads (getNested, not the whole-list ones) are answered here. */
function nestedAnswers(answers: Record<string, any>) {
  nested = answers;
}

describe("held mapProperties and spells", () => {
  test("readHeldList: many callers cost one read; a local write is seen by the next read", async () => {
    const r = redisLike({ mapProperties: MAP_PROPS, spells: SPELLS });
    useStreamSource(r.cache, () => true);
    const first = await Promise.all([readHeldList("mapProperties"), readHeldList("mapProperties"), readHeldList("spells")]);
    for (let i = 0; i < 5; i++) await readHeldList("mapProperties");
    expect(r.readsOf("mapProperties")).toBe(1);
    expect(r.readsOf("spells")).toBe(1);
    expect(first[0]).toBe(first[1]);
    expect(first[0]).toEqual(MAP_PROPS);
    expect(heldStaticList("spells")).toBe(first[2]);
    r.write("mapProperties", [...MAP_PROPS, { name: "new.json", tileWidth: 16, tileHeight: 16, width: 2, height: 2 }]);
    const after = await readHeldList<any>("mapProperties");
    expect(after!.map((m) => m.name)).toContain("new.json");
    expect(r.readsOf("mapProperties")).toBe(2);
  });

  test("the periodic refresh covers mapProperties and spells (a write by another node, no signal)", async () => {
    const r = redisLike({ mapProperties: MAP_PROPS, spells: SPELLS });
    useStreamSource(r.cache, () => true);
    await readHeldList("mapProperties");
    await readHeldList("spells");
    r.writeElsewhere("spells", [...SPELLS, { id: 3, name: "Nova" }]);
    r.writeElsewhere("mapProperties", [MAP_PROPS[0]]);
    expect((await readHeldList<any>("spells"))!.length).toBe(2); // not read again yet
    refreshStaticLists();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await readHeldList<any>("spells"))!.length).toBe(3);
    expect((await readHeldList<any>("mapProperties"))!.length).toBe(1);
  });

  test("CACHE=memory reads the cache on each call, as before", async () => {
    const r = redisLike({ mapProperties: MAP_PROPS, spells: SPELLS });
    useStreamSource(r.cache, () => false);
    await readHeldList("mapProperties");
    await readHeldList("mapProperties");
    expect(r.readsOf("mapProperties")).toBe(2);
    expect(heldStaticList("mapProperties")).toBeNull();
  });

  test("a missing list is null", async () => {
    const r = redisLike({});
    useStreamSource(r.cache, () => true);
    expect(await readHeldList("spells")).toBeNull();
  });

  test("the warm-up loads the new keys once", async () => {
    const r = redisLike({ mapProperties: MAP_PROPS, spells: SPELLS, npcs: [], particles: PARTICLES, maps: [] });
    useStreamSource(r.cache, () => true);
    await warmStreamData();
    await readHeldList("mapProperties");
    await readHeldList("spells");
    expect(r.readsOf("mapProperties")).toBe(1);
    expect(r.readsOf("spells")).toBe(1);
  });
});

describe("isInPvPZone", () => {
  test("repeated calls read mapProperties from the cache once", async () => {
    const r = redisLike({ mapProperties: MAP_PROPS });
    useStreamSource(r.cache, () => true);
    nestedAnswers({ "tiledmap.nopvp": NOPVP_RLE });
    for (let i = 0; i < 100; i++) await player.isInPvPZone("tiledmap.json", POSITIONS[i % POSITIONS.length], props);
    expect(r.readsOf("mapProperties")).toBe(1);
  });

  test("answers equal those from a fresh copy (and from CACHE=memory)", async () => {
    nestedAnswers({ "tiledmap.nopvp": NOPVP_RLE });
    const answers = async () => Promise.all(POSITIONS.map((p) => player.isInPvPZone("tiledmap.json", p, props)));
    const held = redisLike({ mapProperties: MAP_PROPS });
    useStreamSource(held.cache, () => true);
    await answers(); // held
    const heldAnswers = await answers();
    const fresh = redisLike({ mapProperties: MAP_PROPS });
    useStreamSource(fresh.cache, () => false); // a fresh read each call
    const freshAnswers = await answers();
    expect(heldAnswers).toEqual(freshAnswers);
    expect(new Set(heldAnswers).size).toBe(2); // the positions cover both a no-pvp tile and a pvp tile
  });

  test("a local write of mapProperties is seen by the next call", async () => {
    const r = redisLike({ mapProperties: MAP_PROPS });
    useStreamSource(r.cache, () => true);
    nestedAnswers({ "tiledmap.nopvp": NOPVP_RLE });
    expect(await player.isInPvPZone("tiledmap.json", at(16, 16), props)).toBe(false);
    // the map loses its entry: with no properties the zone does not apply
    r.write("mapProperties", [MAP_PROPS[0]]);
    expect(await player.isInPvPZone("tiledmap.json", at(16, 16), props)).toBe(true);
    expect(r.readsOf("mapProperties")).toBe(2);
  });
});

describe("the creature tick", () => {
  test("refreshSpells run N times reads spells and particles once while unchanged, and sees a write", async () => {
    const r = redisLike({ spells: SPELLS, particles: PARTICLES });
    useStreamSource(r.cache, () => true);
    for (let i = 0; i < 20; i++) await creatures.refreshSpells();
    expect(r.readsOf("spells")).toBe(1);
    expect(r.readsOf("particles")).toBe(1);
    r.write("spells", [...SPELLS, { id: 3, name: "Nova", icon: null }]);
    await creatures.refreshSpells();
    await creatures.refreshSpells();
    expect(r.readsOf("spells")).toBe(2);
    expect(r.readsOf("particles")).toBe(1);
  });

  test("the spell lookup the creatures use finds a spell written after the first build, and keeps its maps while nothing changed", async () => {
    // the lookup refreshSpells feeds, as the cluster's player_hit path installs it
    const lookup = setSpellLookup(null)!;
    setSpellLookup(lookup);
    try {
      const r = redisLike({ spells: SPELLS, particles: PARTICLES });
      useStreamSource(r.cache, () => true);
      await creatures.refreshSpells();
      expect(lookup(1)?.name).toBe("Bolt");
      expect(lookup(3)).toBeUndefined();
      // Unchanged: the same array comes back and the maps are not rebuilt. Changing the held array in place
      // (never done by the code) shows whether they were: a rebuild would pick the change up.
      const held = heldStaticList("spells")!;
      const before = lookup(1);
      held[0] = { ...held[0], name: "Rebuilt" };
      for (let i = 0; i < 5; i++) await creatures.refreshSpells();
      expect(lookup(1)).toBe(before);
      expect(lookup(1)?.name).toBe("Bolt");
      // A write: the list is a new array, the maps are rebuilt and the new spell is found.
      r.write("spells", [...SPELLS, { id: 3, name: "Nova", icon: null }]);
      await creatures.refreshSpells();
      expect(lookup(3)?.name).toBe("Nova");
      expect(lookup(1)?.name).toBe("Bolt");
    } finally {
      setSpellLookup(lookup);
    }
  });

  test("the nav grid refresh run N times reads mapProperties once while unchanged", async () => {
    const r = redisLike({ mapProperties: MAP_PROPS, spells: [], particles: [] });
    useStreamSource(r.cache, () => true);
    nestedAnswers({ "tiledmap.collision": [10, 10, 0, 100] });
    for (let i = 0; i < 20; i++) await creatures.wantNavGrids(["tiledmap"]);
    expect(r.readsOf("mapProperties")).toBe(1);
  });

  test("with CACHE=memory refreshSpells reads the cache every time, as before", async () => {
    const r = redisLike({ spells: SPELLS, particles: PARTICLES });
    useStreamSource(r.cache, () => false);
    await creatures.refreshSpells();
    await creatures.refreshSpells();
    expect(r.readsOf("spells")).toBe(2);
  });
});
