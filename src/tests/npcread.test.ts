import { afterEach, describe, expect, mock, test } from "bun:test";
import { databaseModule, standInFor } from "./setup";

// Nothing here reads the database.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const players = new Map<string, any>();
await standInFor("../services/playermanager", () => ({
  default: {
    list: () => Object.fromEntries(players),
    get: (id: string) => players.get(id),
    set: (id: string, value: any) => players.set(id, value),
    add: (id: string, value: any) => players.set(id, value),
    remove: (id: string) => players.delete(id),
    clear: () => players.clear(),
    addNested: (id: string, k: string, v: any) => players.set(id, { ...(players.get(id) || {}), [k]: v }),
    setNested: (id: string, k: string, v: any) => players.set(id, { ...(players.get(id) || {}), [k]: v }),
  },
}));

const stream = await import("../systems/npcStreaming");
const { useStreamSource, readNpcList, heldStaticList, refreshStaticLists } = stream;
const defs = await import("../systems/quests/definitions");
const markers = await import("../systems/quests/markers");
const { mapMarkers } = await import("../systems/mapmarkers");
const { mailboxesOn } = await import("../systems/mail");

const base = {
  last_updated: null, hidden: false, script: null, dialog: null, particles: null,
  quest_giver: false, sprite_type: "animated",
};
const npc = (id: number, map: string, x: number, y: number, more: Record<string, unknown> = {}) =>
  ({ ...base, id, name: `npc${id}`, map, position: { x, y, direction: "down" }, ...more }) as unknown as Npc;
const LIST = [
  npc(1, "overworld", 10, 10, { quest_giver: true }),
  npc(2, "overworld", 50, 50, { innkeeper: true }),
  npc(3, "house_1", 5, 5, { innkeeper: true, name: "Innkeeper" }),
  npc(4, "dungeon", 0, 0),
];

/** A cache that answers like Redis does: a new copy of the list on every read; counts the copies by key. */
function redisLike(initial: Record<string, any>) {
  const data = new Map<string, any>(Object.entries(initial));
  const copies: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  return {
    copies,
    copiesOf: (key: string) => copies.filter((k) => k === key).length,
    cache: {
      get: async (key: string) => { copies.push(key); const v = data.get(key); return v === undefined ? null : structuredClone(v); },
      getIfChanged: async (key: string, digest: string | null) => {
        const v = data.get(key);
        const now = JSON.stringify(v ?? null);
        if (now === digest) return { digest: now, same: true };
        copies.push(key);
        await new Promise((resolve) => setTimeout(resolve, 5)); // a read takes a while
        return { digest: now, same: false, value: v === undefined ? null : structuredClone(v) };
      },
      onChange: (key: string, fn: () => void) => { (listeners.get(key) ?? listeners.set(key, []).get(key)!).push(fn); },
    },
    /** A write made through this process: stores and signals. */
    write(key: string, value: any) { data.set(key, value); for (const fn of listeners.get(key) ?? []) fn(); },
  };
}

const defaultSource = stream.streamSource.cache;
afterEach(() => {
  useStreamSource(defaultSource, () => false);
});

describe("readNpcList", () => {
  test("many callers, concurrent or later, cost one read and get the same array", async () => {
    const r = redisLike({ npcs: LIST });
    useStreamSource(r.cache, () => true);
    const first = await Promise.all([readNpcList(), readNpcList(), readNpcList(), readNpcList()]);
    const later = [await readNpcList(), await readNpcList()];
    expect(r.copiesOf("npcs")).toBe(1);
    for (const list of [...first, ...later]) expect(list).toBe(first[0]);
    expect(first[0]).toEqual(LIST);
    expect(heldStaticList("npcs")).toBe(first[0]);
  });

  test("a write made on this node is what the next read gives", async () => {
    const r = redisLike({ npcs: LIST });
    useStreamSource(r.cache, () => true);
    const before = await readNpcList();
    const written = [...LIST, npc(5, "overworld", 99, 99)];
    r.write("npcs", written);
    const after = await readNpcList();
    expect(after).not.toBe(before);
    expect(after.map((n) => n.id)).toEqual([1, 2, 3, 4, 5]);
    expect(await readNpcList()).toBe(after);
  });

  test("a write that lands while a read is in flight is not lost", async () => {
    const r = redisLike({ npcs: LIST });
    useStreamSource(r.cache, () => true);
    const reading = readNpcList();
    r.write("npcs", [npc(9, "overworld", 1, 1)]);
    await reading;
    expect((await readNpcList()).map((n) => n.id)).toEqual([9]);
  });

  test("a changed list shows after the periodic refresh", async () => {
    const r = redisLike({ npcs: LIST });
    useStreamSource(r.cache, () => true);
    const before = await readNpcList();
    r.write("npcs", LIST.slice(0, 1)); // (the stream tests cover a write that is not signalled)
    refreshStaticLists();
    expect((await readNpcList()).length).toBe(1);
    expect(before.length).toBe(4);
  });

  test("with CACHE=memory it is what the cache holds, each time", async () => {
    const stored = [...LIST];
    let gets = 0;
    useStreamSource({ get: async () => { gets++; return stored; } }, () => false);
    expect(await readNpcList()).toBe(stored);
    expect(await readNpcList()).toBe(stored);
    expect(gets).toBe(2);
  });

  test("an empty cache gives an empty list", async () => {
    useStreamSource({ get: async () => null }, () => false);
    expect(await readNpcList()).toEqual([]);
  });
});

describe("the login sends read the held list", () => {
  const questBase: Quest = {
    id: 1, name: "Rats", zone: null, offer_text: "", description: "", progress_text: "", completion_text: "",
    required_level: 1, quest_level: 1, xp_reward: 0, copper_reward: 0,
    repeatable: "none", next_quest_id: null, sort_order: 0,
    objectives: [{ id: 101, quest_id: 1, sort_order: 0, type: "kill", target: "1", required_count: 3, target_x: null, target_y: null, target_radius: null, description: null }],
    rewards: [], prerequisites: [],
  } as Quest;
  const seed = () => {
    players.clear();
    players.set("c", { id: "c", username: "hero", stats: { level: 5 }, questlog: { active: [], completed: [] } });
    defs.setCachedQuestsSync([questBase]);
    defs.setIndexesForTests(defs.buildIndexes([questBase], [{ npc_id: 1, quest_id: 1, role: "giver" }]));
  };

  test("markersFor copies the list once for many logins and answers as when the cache is read directly", async () => {
    seed();
    const r = redisLike({ npcs: LIST });
    useStreamSource(r.cache, () => true);
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await markers.markersFor("hero", "overworld"));
    expect(r.copiesOf("npcs")).toBe(1);
    const direct = redisLike({ npcs: LIST });
    useStreamSource(direct.cache, () => false);
    const expected = await markers.markersFor("hero", "overworld");
    expect(expected).toEqual({ 1: "available" });
    for (const answer of answers) expect(answer).toEqual(expected);
  });

  test("map markers and mailboxes from the held list equal those from a fresh copy, and leave the list as it was", async () => {
    const r = redisLike({ npcs: LIST });
    useStreamSource(r.cache, () => true);
    const held = await readNpcList();
    const frozen = JSON.stringify(held);
    const warps = [{ map: "house_1", position: { x: 100, y: 100 }, size: { width: 32, height: 32 } }] as any;
    const outdoors = (map: string) => map === "overworld";
    const fromHeld = [mapMarkers("overworld", held, warps, outdoors), mailboxesOn("overworld", held, warps, outdoors)];
    const fromCopy = [mapMarkers("overworld", structuredClone(LIST), warps, outdoors), mailboxesOn("overworld", structuredClone(LIST), warps, outdoors)];
    expect(fromHeld).toEqual(fromCopy);
    expect(fromHeld[0].length).toBeGreaterThan(0);
    expect(fromHeld[1].length).toBeGreaterThan(0);
    expect(JSON.stringify(held)).toBe(frozen);
    expect(await readNpcList()).toBe(held);
    expect(r.copiesOf("npcs")).toBe(1);
  });
});
