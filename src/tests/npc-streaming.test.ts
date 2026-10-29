import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule, mockQuery } from "./setup";

// Nothing here reads the database.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));

const stream = await import("../systems/npcStreaming");
const { packetManager } = await import("../socket/packet_manager");
const { syncNpcChunks, forgetNpcStream, useStreamSource, refreshStaticLists, preloadNpcsAt, npcForClient, heldStaticList } = stream;

// A map of 4 x 4 chunks of 1024 px (32 px tiles, 32 tiles per chunk).
const MAPS = [{ name: "town", data: { tilewidth: 32, width: 128, height: 128 } }];
const npc = (id: number, x: number, y: number, more: Record<string, unknown> = {}) => ({
  id, name: `npc${id}`, map: "town", position: { x, y, direction: "down" }, sprite_type: "static", particles: null, ...more,
});

/** A cache that answers like Redis does: a new copy of the list on every get; counts the gets by key. */
function redisLike(initial: Record<string, any>) {
  const data = new Map<string, any>(Object.entries(initial));
  const gets: string[] = [];
  const copies: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  return {
    gets,
    copies,
    getsOf: (key: string) => gets.filter((k) => k === key).length,
    cache: {
      get: async (key: string) => { gets.push(key); const v = data.get(key); return v === undefined ? null : structuredClone(v); },
      getIfChanged: async (key: string, digest: string | null) => {
        gets.push(key);
        const v = data.get(key);
        const now = JSON.stringify(v ?? null);
        if (now === digest) return { digest: now, same: true };
        copies.push(key);
        return { digest: now, same: false, value: v === undefined ? null : structuredClone(v) };
      },
      onChange: (key: string, fn: () => void) => { (listeners.get(key) ?? listeners.set(key, []).get(key)!).push(fn); },
    },
    /** A write made through this process: stores and signals. */
    write(key: string, value: any) { data.set(key, value); for (const fn of listeners.get(key) ?? []) fn(); },
    /** A write made by another node: stored, not signalled. */
    writeQuietly(key: string, value: any) { data.set(key, value); },
  };
}

const player = (id: string, x: number, y = 100) => ({ id, location: { map: "town", position: { x, y } } });
let loaded: ReturnType<typeof spyOn>;
const sentNpcIds = () => loaded.mock.calls.flatMap((call: any[]) => (call[0] as any[]).map((n) => n.id));

const defaultSource = stream.streamSource.cache;
beforeEach(() => {
  loaded = spyOn(packetManager, "loadNpcs");
});
afterEach(() => {
  loaded.mockRestore();
  useStreamSource(defaultSource, () => false);
});

describe("NPC streaming with the lists in Redis", () => {
  test("repeated chunk crossings read nothing from Redis between refreshes and index the same array", async () => {
    const r = redisLike({ maps: MAPS, npcs: [npc(1, 100, 100), npc(2, 1500, 100), npc(3, 3000, 100)], particles: [] });
    useStreamSource(r.cache, () => true);

    await syncNpcChunks(player("a", 100), true); // entering the map reads the lists once
    const heldList = heldStaticList("npcs");
    expect(r.getsOf("npcs")).toBe(1);
    const before = r.gets.length;

    await syncNpcChunks(player("a", 1100)); // crossings: no GET of anything
    await syncNpcChunks(player("a", 2200));
    await syncNpcChunks(player("a", 3300));
    await syncNpcChunks(player("a", 100));
    expect(r.gets.length).toBe(before);

    // a second player on the same node shares the held list
    expect(r.gets.length).toBe(before);
    expect(heldStaticList("npcs")).toBe(heldList); // the same array all along
    expect(r.gets.length).toBe(before);
  });

  test("a crossing never waits on Redis: a list not held yet is read in the background and the next scan streams", async () => {
    const r = redisLike({ maps: MAPS, npcs: [npc(1, 100, 100)], particles: [] });
    useStreamSource(r.cache, () => true);
    // not reset (a player walking): nothing is held yet
    expect(await syncNpcChunks(player("walker", 100))).toEqual([]);
    expect(sentNpcIds()).toEqual([]);
    await Bun.sleep(5);
    expect(await syncNpcChunks(player("walker", 100))).toEqual([]); // the map is held now, the list is being read or held
    await Bun.sleep(5);
    const packets = await syncNpcChunks(player("walker", 100));
    expect(packets.length).toBe(1);
    expect(sentNpcIds()).toEqual([1]);
  });

  test("a write through this process refreshes the held list", async () => {
    const r = redisLike({ maps: MAPS, npcs: [npc(1, 100, 100)], particles: [] });
    useStreamSource(r.cache, () => true);
    await syncNpcChunks(player("a", 100), true);
    expect(sentNpcIds()).toEqual([1]);

    r.write("npcs", [npc(1, 100, 100), npc(4, 150, 150)]); // an editor adds an NPC
    const fresh = await syncNpcChunks(player("b", 100), true);
    expect(fresh.length).toBe(1);
    expect(sentNpcIds()).toEqual([1, 1, 4]);
  });

  test("a write by another node is seen after the periodic refresh, not before", async () => {
    const r = redisLike({ maps: MAPS, npcs: [npc(1, 100, 100)], particles: [] });
    useStreamSource(r.cache, () => true);
    await syncNpcChunks(player("a", 100), true);
    r.writeQuietly("npcs", [npc(1, 100, 100), npc(5, 200, 200)]);

    await syncNpcChunks(player("b", 100), true);
    expect(sentNpcIds()).toEqual([1, 1]); // still the held copy

    refreshStaticLists();
    await Bun.sleep(5);
    await syncNpcChunks(player("c", 100), true);
    expect(sentNpcIds()).toEqual([1, 1, 1, 5]);
  });

  test("the particle list is read once per sync, and not at all when no NPC uses particles", async () => {
    const ember = { name: "ember", size: 2 }, smoke = { name: "smoke", size: 3 };
    const plain = redisLike({ maps: MAPS, npcs: [npc(1, 100, 100), npc(2, 200, 200)], particles: [ember] });
    useStreamSource(plain.cache, () => true);
    await syncNpcChunks(player("a", 100), true);
    expect(plain.getsOf("particles")).toBe(0);

    const r = redisLike({
      maps: MAPS,
      npcs: [npc(1, 100, 100, { particles: "ember" }), npc(2, 200, 200, { particles: "smoke, ember" }), npc(3, 300, 300, { particles: "ember" })],
      particles: [ember, smoke],
    });
    useStreamSource(r.cache, () => true);
    await syncNpcChunks(player("a", 100), true);
    expect(r.getsOf("particles")).toBe(1);
    const sent = loaded.mock.calls.at(-1)![0] as any[];
    expect(sent.map((n) => n.particles.map((p: any) => p.name))).toEqual([["ember"], ["smoke", "ember"], ["ember"]]);
    // a second sync, and a crossing, read it no more
    await syncNpcChunks(player("b", 100), true);
    await syncNpcChunks(player("a", 1100));
    expect(r.getsOf("particles")).toBe(1);
  });

  test("a sync for a player who logs out meanwhile sends nothing and leaves no state", async () => {
    const r = redisLike({ maps: MAPS, npcs: [npc(1, 100, 100)], particles: [] });
    useStreamSource(r.cache, () => true);
    const pending = syncNpcChunks(player("gone", 100), true); // waits on the first read of the lists
    forgetNpcStream("gone"); // the player leaves
    expect(await pending).toEqual([]);
    expect(sentNpcIds()).toEqual([]);
    // a later sync of the same id is a fresh start, as the state was not recreated
    const again = await syncNpcChunks(player("gone", 100), true);
    expect(again.length).toBe(1);
  });

  test("the player's NPCs are the same as when the list is read straight from the cache", async () => {
    const list = [npc(1, 100, 100), npc(2, 1500, 100), npc(3, 3000, 3000)];
    const r = redisLike({ maps: MAPS, npcs: list, particles: [] });
    useStreamSource(r.cache, () => true);
    await syncNpcChunks(player("a", 1100, 100), true);
    const viaSnapshot = sentNpcIds();

    loaded.mockClear();
    const direct = redisLike({ maps: MAPS, npcs: list, particles: [] });
    useStreamSource(direct.cache, () => false);
    await syncNpcChunks(player("a", 1100, 100), true);
    expect(sentNpcIds()).toEqual(viaSnapshot);
  });

  test("a warp preload and npcForClient use the held particle list", async () => {
    const ember = { name: "ember", size: 2 };
    const r = redisLike({ maps: MAPS, npcs: [npc(1, 100, 100, { particles: "ember" })], particles: [ember] });
    useStreamSource(r.cache, () => true);
    await preloadNpcsAt(player("a", 0), "town", 100, 100);
    await preloadNpcsAt(player("a", 0), "town", 100, 100);
    expect(r.getsOf("particles")).toBe(1);
    expect((await npcForClient(npc(9, 0, 0, { particles: "ember" }) as any)).particles).toEqual([ember]);
    expect(r.getsOf("particles")).toBe(1);
  });
});

describe("NPC streaming: refresh and jumps", () => {
  test("a refresh with unchanged content keeps the same array and copies nothing; a changed one replaces it", async () => {
    const r = redisLike({ maps: MAPS, npcs: [npc(1, 100, 100)], particles: [] });
    useStreamSource(r.cache, () => true);
    await syncNpcChunks(player("r1", 100), true);
    const first = heldStaticList("npcs");
    expect(first).not.toBeNull();
    const copied = r.copies.filter((k) => k === "npcs").length;

    refreshStaticLists();
    await Bun.sleep(5);
    expect(heldStaticList("npcs")).toBe(first); // same reference: the chunk index is kept
    expect(r.copies.filter((k) => k === "npcs").length).toBe(copied);

    r.writeQuietly("npcs", [npc(1, 100, 100), npc(2, 120, 120)]);
    refreshStaticLists();
    await Bun.sleep(5);
    expect(heldStaticList("npcs")).not.toBe(first);
    expect(heldStaticList("npcs")!.length).toBe(2);
  });

  test("the 30 s timer re-reads the lists and sets itself again", async () => {
    const r = redisLike({ maps: MAPS, npcs: [npc(1, 100, 100)], particles: [] });
    useStreamSource(r.cache, () => true);
    const real = globalThis.setTimeout;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    (globalThis as any).setTimeout = (fn: () => void, ms?: number, ...rest: any[]) => {
      if (typeof ms === "number" && ms >= 20000 && ms <= 40000) {
        timers.push({ fn, ms });
        return { unref() {} };
      }
      return (real as any)(fn, ms, ...rest);
    };
    try {
      await syncNpcChunks(player("t1", 100), true);
      expect(timers.length).toBe(1);
      expect(timers[0]!.ms).toBeGreaterThanOrEqual(stream.STATIC_LIST_REFRESH_MS * 0.8);
      expect(timers[0]!.ms).toBeLessThanOrEqual(stream.STATIC_LIST_REFRESH_MS * 1.2);
      r.writeQuietly("npcs", [npc(1, 100, 100), npc(7, 130, 130)]);
      timers[0]!.fn();
      await Bun.sleep(5);
      expect(timers.length).toBe(2); // scheduled again
      expect(heldStaticList("npcs")!.length).toBe(2);
    } finally {
      (globalThis as any).setTimeout = real;
    }
  });

  test("a jump within the map waits for a list that is out of date instead of ending with nothing", async () => {
    const r = redisLike({ maps: MAPS, npcs: [npc(1, 100, 100)], particles: [] });
    useStreamSource(r.cache, () => true);
    await syncNpcChunks(player("j1", 100), true);
    r.write("npcs", [npc(1, 100, 100), npc(3, 140, 140)]); // an edit: the held copy is out of date
    // the player is teleported to another chunk and stands still
    expect(await syncNpcChunks(player("j1", 1500))).toEqual([]); // a walking sync defers (and would not be asked again)
    r.write("npcs", [npc(1, 100, 100), npc(3, 140, 140), npc(4, 150, 150)]);
    const packets = await syncNpcChunks(player("j1", 2600), false, true);
    expect(packets.length).toBeGreaterThan(0);
    expect(sentNpcIds()).toContain(4);
  });

  test("a first read that fails is an error for a sync that waits, not an empty list", async () => {
    const r = redisLike({ maps: MAPS, npcs: [npc(1, 100, 100)], particles: [] });
    const failing = { ...r.cache, getIfChanged: async (key: string) => { if (key === "npcs") throw new Error("down"); return { digest: "x", same: false, value: MAPS }; } };
    useStreamSource(failing, () => true);
    await expect(syncNpcChunks(player("f1", 100), true)).rejects.toThrow();
  });
});

describe("NPC streaming with CACHE=memory", () => {
  test("reads the cache directly each time, as before", async () => {
    let stored = [npc(1, 100, 100)];
    const gets: string[] = [];
    useStreamSource({ get: async (key: string) => { gets.push(key); return key === "maps" ? MAPS : stored; } }, () => false);
    const first = await syncNpcChunks(player("a", 100), true);
    expect(first.length).toBe(1);
    await syncNpcChunks(player("a", 1100));
    expect(gets.filter((k) => k === "npcs").length).toBe(2); // one per chunk change, straight from the cache
    expect(gets).not.toContain("particles"); // none of the NPCs uses particles
    // a write is seen at once
    stored = [...stored, npc(2, 1500, 100)];
    const next = await syncNpcChunks(player("b", 1100), true);
    expect(next.length).toBe(1);
    expect(sentNpcIds()).toEqual([1, 1, 2]);
  });
});
