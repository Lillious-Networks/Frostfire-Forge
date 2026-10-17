import { describe, expect, test } from "bun:test";
import { GatherSync, MAX_ENTER_PER_REFRESH, type GatherViewer } from "../systems/gathering/sync";
import type { GatherNode } from "../systems/gathering/types";

const node = (id: number, x: number, y: number, layerId = "L1"): GatherNode => ({ id, areaId: 1, map: "main", layerId, x, y, item: "Copper Ore", tile: `${id}` });

function world(nodes: GatherNode[], viewer: GatherViewer) {
  const spawns: number[][] = [];
  const despawns: number[][] = [];
  const all = new Map(nodes.map((n) => [n.id, n]));
  const sync = new GatherSync({
    nodesNear: (map, layerId, x, y, radius) =>
      [...all.values()].filter((n) => n.map === map && n.layerId === layerId && Math.hypot(n.x - x, n.y - y) <= radius),
    get: (id) => all.get(id),
    mapsWithNodes: () => ["main"],
    playersOnMap: (map) => (map === viewer.map ? [viewer.id] : []),
    resolvePlayer: (id) => (id === viewer.id ? viewer : null),
    snapshot: (n) => ({ id: n.id, x: n.x, y: n.y, item: n.item, icon: null, size: 32 }),
    sendSpawn: (_wt, list) => spawns.push(list.map((s) => s.id)),
    sendDespawn: (_wt, ids) => despawns.push(ids),
  });
  return { sync, all, spawns, despawns };
}

const viewer = (overrides: Partial<GatherViewer> = {}): GatherViewer => ({ id: "p1", wt: {}, map: "main", layerId: "L1", x: 0, y: 0, radius: 500, ...overrides });

describe("GatherSync", () => {
  test("sends the nodes in range of the player's layer only", () => {
    const { sync, spawns } = world([node(1, 100, 0), node(2, 900, 0), node(3, 100, 0, "L2")], viewer());
    sync.refresh();
    expect(spawns).toEqual([[1]]);
    sync.refresh();
    expect(spawns.length).toBe(1);
  });

  test("a node is despawned once the player is well out of range", () => {
    const me = viewer();
    const { sync, despawns } = world([node(1, 100, 0)], me);
    sync.refresh();
    me.x = -450; // 550 away: inside the exit margin
    sync.refresh();
    expect(despawns).toEqual([]);
    me.x = -700;
    sync.refresh();
    expect(despawns).toEqual([[1]]);
  });

  test("changing layer despawns the old layer's nodes and sends the new one's", () => {
    const me = viewer();
    const { sync, spawns, despawns } = world([node(1, 100, 0), node(2, 100, 0, "L2")], me);
    sync.refresh();
    me.layerId = "L2";
    sync.refresh();
    expect(despawns).toEqual([[1]]);
    expect(spawns).toEqual([[1], [2]]);
  });

  test("a gathered node is despawned for those who saw it", () => {
    const { sync, all, despawns } = world([node(1, 100, 0)], viewer());
    sync.refresh();
    const gone = all.get(1)!;
    all.delete(1);
    sync.onDespawn(gone);
    expect(despawns).toEqual([[1]]);
    expect(sync.knownBy("p1").size).toBe(0);
  });

  test("a new node is sent on the next flush to a player in range", () => {
    const { sync, all, spawns } = world([], viewer());
    sync.refresh();
    const fresh = node(5, 50, 0);
    all.set(5, fresh);
    sync.onSpawn(fresh);
    expect(spawns).toEqual([]);
    sync.flush();
    expect(spawns).toEqual([[5]]);
    sync.flush();
    expect(spawns).toEqual([[5]]);
  });

  test("nodes spawned in one tick reach each viewer in one packet", () => {
    const { sync, all, spawns } = world([], viewer());
    sync.refresh();
    for (const id of [5, 6, 7]) {
      const fresh = node(id, 50, 0);
      all.set(id, fresh);
      sync.onSpawn(fresh);
    }
    sync.onSpawn(node(8, 50, 0, "L2"));
    sync.onSpawn(node(9, 900, 0));
    sync.flush();
    expect(spawns).toEqual([[5, 6, 7]]);
  });

  test("a node gone before the flush is never sent", () => {
    const { sync, all, spawns, despawns } = world([], viewer());
    sync.refresh();
    const fresh = node(5, 50, 0);
    all.set(5, fresh);
    sync.onSpawn(fresh);
    all.delete(5);
    sync.onDespawn(fresh);
    sync.flush();
    expect(spawns).toEqual([]);
    expect(despawns).toEqual([]);
  });

  test("a flush sends at most the per-refresh cap; the next refresh sends the rest", () => {
    const { sync, all, spawns } = world([], viewer());
    sync.refresh();
    for (let id = 1; id <= MAX_ENTER_PER_REFRESH + 10; id++) {
      const fresh = node(id, 10, 0);
      all.set(id, fresh);
      sync.onSpawn(fresh);
    }
    sync.flush();
    sync.refresh();
    expect(spawns.map((s) => s.length)).toEqual([MAX_ENTER_PER_REFRESH, 10]);
  });

  test("resync sends everything again (the client cleared its nodes on a map load)", () => {
    const { sync, spawns } = world([node(1, 100, 0)], viewer());
    sync.refresh();
    sync.resync("p1");
    expect(spawns).toEqual([[1], [1]]);
  });

  test("a crowded area is sent over several refreshes", () => {
    const many = Array.from({ length: MAX_ENTER_PER_REFRESH + 10 }, (_, i) => node(i + 1, 10, 0));
    const { sync, spawns } = world(many, viewer());
    sync.refresh();
    sync.refresh();
    expect(spawns.map((s) => s.length)).toEqual([MAX_ENTER_PER_REFRESH, 10]);
  });
});
