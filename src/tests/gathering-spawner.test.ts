import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resetEntityIds, useWorldIds } from "../cluster/entityids";
import { GatherSpawner, RETRY_MS } from "../systems/gathering/spawner";
import type { GatherArea, GatherNode } from "../systems/gathering/types";
import { openGrid, seeded } from "./gathering-helpers";
import { apart } from "../systems/gathering/placement";
const { default: log } = await import("../modules/logger");

const area = (overrides: Partial<GatherArea> = {}): GatherArea => ({
  id: 1, map: "main", x: 500, y: 500, radius: 160, size: 32, item: "Copper Ore",
  quantity_min: 1, quantity_max: 1, max_nodes: 5, respawn_min_s: 10, respawn_max_s: 20, enabled: true, ...overrides,
});
const layers = (...ids: string[]) => new Map([["main", ids]]);

function started(areas: GatherArea[] = [area()], layerIds = ["L1"], grid = openGrid()) {
  const spawned: GatherNode[] = [];
  const despawned: GatherNode[] = [];
  const spawner = new GatherSpawner(() => grid, { onSpawn: (n) => spawned.push(n), onDespawn: (n) => despawned.push(n) }, seeded(4));
  spawner.setAreas(areas, 0);
  spawner.setLayers(layers(...layerIds), 0);
  spawner.tick(0);
  return { spawner, spawned, despawned };
}

describe("GatherSpawner", () => {
  test("fills each area to its node count, on different tiles inside the circle", () => {
    const { spawner } = started();
    const nodes = spawner.nodesOn("main", "L1");
    expect(nodes.length).toBe(5);
    expect(new Set(nodes.map((n) => n.tile)).size).toBe(5);
    for (const n of nodes) expect(Math.hypot(n.x - 500, n.y - 500)).toBeLessThanOrEqual(160);
    expect(nodes.every((n) => n.item === "Copper Ore" && n.areaId === 1)).toBe(true);
  });

  test("a taken node comes back after the respawn time, not before", () => {
    const { spawner } = started();
    const [first] = spawner.nodesOn("main", "L1");
    expect(spawner.take(first!.id, 1000)?.id).toBe(first!.id);
    expect(spawner.get(first!.id)).toBeUndefined();
    spawner.tick(1000 + 9_999);
    expect(spawner.countOn(1, "L1")).toBe(4);
    spawner.tick(1000 + 20_000);
    expect(spawner.countOn(1, "L1")).toBe(5);
  });

  test("a node taken twice is given once", () => {
    const { spawner } = started();
    const [first] = spawner.nodesOn("main", "L1");
    expect(spawner.take(first!.id, 0)).not.toBeNull();
    expect(spawner.take(first!.id, 0)).toBeNull();
  });

  test("each layer has its own nodes", () => {
    const { spawner } = started([area()], ["L1", "L2"]);
    const [first] = spawner.nodesOn("main", "L1");
    spawner.take(first!.id, 0);
    expect(spawner.countOn(1, "L1")).toBe(4);
    expect(spawner.countOn(1, "L2")).toBe(5);
  });

  test("a layer that is gone loses its nodes", () => {
    const { spawner, despawned } = started([area()], ["L1", "L2"]);
    spawner.setLayers(layers("L1"), 0);
    expect(spawner.nodesOn("main", "L2")).toEqual([]);
    expect(despawned.length).toBe(5);
  });

  test("a changed area is spawned again; an unchanged one keeps its nodes", () => {
    const { spawner } = started();
    const before = spawner.nodesOn("main", "L1").map((n) => n.id);
    spawner.setAreas([area()], 0);
    spawner.tick(0);
    expect(spawner.nodesOn("main", "L1").map((n) => n.id)).toEqual(before);
    spawner.setAreas([area({ max_nodes: 3 })], 0);
    spawner.tick(0);
    const after = spawner.nodesOn("main", "L1");
    expect(after.length).toBe(3);
    expect(after.some((n) => before.includes(n.id))).toBe(false);
  });

  test("a disabled area spawns nothing", () => {
    const { spawner } = started([area({ enabled: false })]);
    expect(spawner.nodesOn("main", "L1")).toEqual([]);
    expect(spawner.maps()).toEqual([]);
  });

  test("a node that could not be given is put back, and its respawn is cancelled", () => {
    const { spawner } = started();
    const [first] = spawner.nodesOn("main", "L1");
    const taken = spawner.take(first!.id, 0)!;
    expect(spawner.restore(taken)).toBe(true);
    expect(spawner.get(first!.id)).toBeDefined();
    spawner.tick(30_000);
    expect(spawner.countOn(1, "L1")).toBe(5);
  });

  test("a node is not put back once its area changed", () => {
    const { spawner } = started();
    const [first] = spawner.nodesOn("main", "L1");
    const taken = spawner.take(first!.id, 0)!;
    spawner.setAreas([area({ radius: 200 })], 0);
    expect(spawner.restore(taken)).toBe(false);
  });

  test("a layer that comes back keeps its respawn times", () => {
    const { spawner } = started();
    const [a, b] = spawner.nodesOn("main", "L1");
    spawner.take(a!.id, 0);
    spawner.take(b!.id, 0);
    spawner.setLayers(layers(), 100);
    spawner.setLayers(layers("L1"), 200);
    spawner.tick(200);
    expect(spawner.countOn(1, "L1")).toBe(3);
    spawner.tick(20_100);
    expect(spawner.countOn(1, "L1")).toBe(5);
  });

  test("parked respawn times expire", () => {
    const { spawner } = started();
    const [a, b] = spawner.nodesOn("main", "L1");
    spawner.take(a!.id, 0);
    spawner.take(b!.id, 0);
    spawner.setLayers(layers(), 100);
    spawner.setLayers(layers("L1"), 30_000);
    spawner.tick(30_000);
    expect(spawner.countOn(1, "L1")).toBe(5);
  });

  test("a changed area is not seeded from parked times", () => {
    const { spawner } = started();
    const [a, b] = spawner.nodesOn("main", "L1");
    spawner.take(a!.id, 0);
    spawner.take(b!.id, 0);
    spawner.setLayers(layers(), 100);
    spawner.setAreas([area({ max_nodes: 4 })], 150);
    spawner.setLayers(layers("L1"), 200);
    spawner.tick(200);
    expect(spawner.countOn(1, "L1")).toBe(4);
  });

  test("a spawn hook that throws does not break the slot's count", () => {
    const errors = spyOn(log, "error").mockImplementation(() => {});
    try {
      const spawner = new GatherSpawner(() => openGrid(), { onSpawn: () => { throw new Error("hook down"); } }, seeded(4));
      spawner.setAreas([area()], 0);
      spawner.setLayers(layers("L1"), 0);
      spawner.tick(0);
      expect(spawner.countOn(1, "L1")).toBe(5);
      spawner.tick(10);
      spawner.tick(20);
      expect(spawner.countOn(1, "L1")).toBe(5);
      expect(spawner.nodesOn("main", "L1").length).toBe(5);
      expect(errors).toHaveBeenCalledTimes(5);
      expect(errors.mock.calls[0]![0]).toContain("hook down");
    } finally {
      errors.mockRestore();
    }
  });

  test("an area with no walkable tile waits and tries again", () => {
    const base = openGrid();
    let open = false;
    const grid = { ...base, isWalkable: (x: number, y: number) => open && base.isWalkable(x, y) };
    const spawner = new GatherSpawner(() => grid, {}, seeded(4));
    spawner.setAreas([area()], 0);
    spawner.setLayers(layers("L1"), 0);
    spawner.tick(0);
    expect(spawner.countOn(1, "L1")).toBe(0);
    open = true;
    spawner.tick(RETRY_MS - 1);
    expect(spawner.countOn(1, "L1")).toBe(0);
    spawner.tick(RETRY_MS);
    expect(spawner.countOn(1, "L1")).toBe(5);
  });
});

describe("GatherSpawner spacing", () => {
  test("nodes never overlap, also across areas of different sizes", () => {
    const small = area({ id: 1, size: 48, max_nodes: 15, radius: 220 });
    const big = area({ id: 2, size: 64, max_nodes: 15, radius: 220, item: "Iron Ore" });
    const { spawner } = started([small, big]);
    for (let t = 1; t <= 10; t++) spawner.tick(t * RETRY_MS);
    const nodes = spawner.nodesOn("main", "L1");
    expect(nodes.length).toBeGreaterThan(10);
    const sized = nodes.map((n) => ({ x: n.x, y: n.y, size: n.areaId === 1 ? 48 : 64 }));
    for (const a of sized) {
      for (const b of sized) {
        if (a !== b) expect(apart(a, b)).toBe(true);
      }
    }
  });

  test("an area too small for its node count holds as many as fit", () => {
    const { spawner } = started([area({ size: 96, radius: 100, max_nodes: 10 })]);
    for (let t = 1; t <= 10; t++) spawner.tick(t * RETRY_MS);
    const count = spawner.countOn(1, "L1");
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });
});

describe("GatherSpawner.nodesNear", () => {
  // a big area across many 512 px cells, so queries cross cell edges
  const wide = area({ x: 2000, y: 2000, radius: 1500, max_nodes: 200 });
  const ids = (nodes: GatherNode[]) => nodes.map((n) => n.id).sort((a, b) => a - b);
  const byHand = (spawner: GatherSpawner, x: number, y: number, radius: number) =>
    spawner.nodesOn("main", "L1").filter((n) => Math.hypot(n.x - x, n.y - y) <= radius);

  test("finds exactly the nodes within the radius, across cell edges", () => {
    const { spawner } = started([wide]);
    expect(spawner.countOn(1, "L1")).toBe(200);
    for (const [x, y] of [[2000, 2000], [512, 512], [1024, 1536], [1535, 2047], [3000, 600], [0, 0]] as const) {
      for (const radius of [0, 40, 300, 511, 512, 800, 5000]) {
        expect(ids(spawner.nodesNear("main", "L1", x, y, radius))).toEqual(ids(byHand(spawner, x, y, radius)));
      }
    }
  });

  test("only the asked layer and map", () => {
    const { spawner } = started([wide], ["L1", "L2"]);
    const near = spawner.nodesNear("main", "L1", 2000, 2000, 5000);
    expect(near.length).toBe(200);
    expect(near.every((n) => n.layerId === "L1")).toBe(true);
    expect(spawner.nodesNear("other", "L1", 2000, 2000, 5000)).toEqual([]);
  });

  test("a taken node is gone from its cell, and a restored one is back", () => {
    const { spawner } = started([wide]);
    const [first] = spawner.nodesOn("main", "L1");
    const taken = spawner.take(first!.id, 0)!;
    expect(spawner.nodesNear("main", "L1", taken.x, taken.y, 0).some((n) => n.id === taken.id)).toBe(false);
    spawner.restore(taken);
    expect(spawner.nodesNear("main", "L1", taken.x, taken.y, 0).some((n) => n.id === taken.id)).toBe(true);
  });

  test("a dropped layer leaves no nodes in its cells", () => {
    const { spawner } = started([wide], ["L1", "L2"]);
    spawner.setLayers(layers("L2"), 0);
    expect(spawner.nodesNear("main", "L1", 2000, 2000, 5000)).toEqual([]);
  });
});

describe("node ids", () => {
  afterEach(resetEntityIds);

  test("are the world's entity ids, which are numbers", () => {
    let next = 700;
    useWorldIds({ next: () => next++ } as any);
    const { spawner } = started();
    expect(spawner.nodesOn("main", "L1").map((n) => n.id).sort()).toEqual([700, 701, 702, 703, 704]);
  });

  test("a node that cannot get an id is skipped and tried again after the retry wait", () => {
    useWorldIds({ next: () => { throw new Error("No world ids left"); } } as any);
    const errors = spyOn(log, "error").mockImplementation(() => {});
    try {
      const { spawner, spawned } = started();
      expect(spawned).toEqual([]);
      expect(spawner.countOn(1, "L1")).toBe(0);
      expect(errors.mock.calls[0]![0]).toContain("No world ids left");

      let next = 9;
      useWorldIds({ next: () => next++ } as any);
      spawner.tick(RETRY_MS - 1);
      expect(spawner.countOn(1, "L1")).toBe(0);
      spawner.tick(RETRY_MS);
      expect(spawner.countOn(1, "L1")).toBe(5);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("overflow layers fill only where they have players", () => {
  // Players per layer and 4096 px block, as the layer manager counts them.
  function occupied() {
    const players = new Map<string, number>();
    const at = (layerId: string, x: number, y: number) => `${layerId}@${Math.floor(x / 4096)},${Math.floor(y / 4096)}`;
    const despawned: GatherNode[] = [];
    const spawner = new GatherSpawner(() => openGrid(), {
      onDespawn: (n) => despawned.push(n),
      playersInBlock: (layerId, x, y) => players.get(at(layerId, x, y)) ?? 0,
    }, seeded(4));
    spawner.setAreas([area()], 0);
    spawner.setLayers(layers("main:layer_1", "main:layer_2"), 0);
    spawner.tick(0);
    return { spawner, players, despawned, at };
  }

  test("layer 1 is filled everywhere; an overflow layer only once the area's block has a player", () => {
    const { spawner, players, at } = occupied();
    expect(spawner.countOn(1, "main:layer_1")).toBe(5);
    expect(spawner.countOn(1, "main:layer_2")).toBe(0);
    players.set(at("main:layer_2", 5000, 500), 1); // another block
    spawner.tick(100);
    expect(spawner.countOn(1, "main:layer_2")).toBe(0);
    players.set(at("main:layer_2", 500, 500), 1);
    spawner.tick(200);
    expect(spawner.countOn(1, "main:layer_2")).toBe(5);
  });

  test("overflow nodes go after the block has been empty for 60 s and come back with a player", () => {
    const { spawner, players, despawned, at } = occupied();
    players.set(at("main:layer_2", 500, 500), 1);
    spawner.tick(100);
    expect(spawner.countOn(1, "main:layer_2")).toBe(5);

    players.delete(at("main:layer_2", 500, 500));
    spawner.tick(1000); // seen empty
    spawner.tick(1000 + 59_000);
    expect(spawner.countOn(1, "main:layer_2")).toBe(5);
    spawner.tick(1000 + 60_000);
    expect(spawner.countOn(1, "main:layer_2")).toBe(0);
    expect(despawned.length).toBe(5);
    expect(despawned.every((n) => n.layerId === "main:layer_2")).toBe(true);
    expect(spawner.countOn(1, "main:layer_1")).toBe(5);

    players.set(at("main:layer_2", 500, 500), 1);
    spawner.tick(1000 + 61_000);
    expect(spawner.countOn(1, "main:layer_2")).toBe(5);
  });

  test("a player coming back within 60 s keeps the overflow nodes", () => {
    const { spawner, players, at } = occupied();
    players.set(at("main:layer_2", 500, 500), 1);
    spawner.tick(100);
    const ids = spawner.nodesOn("main", "main:layer_2").map((n) => n.id);
    players.delete(at("main:layer_2", 500, 500));
    spawner.tick(1000);
    players.set(at("main:layer_2", 500, 500), 1);
    spawner.tick(50_000);
    players.delete(at("main:layer_2", 500, 500));
    spawner.tick(70_000);
    spawner.tick(100_000);
    expect(spawner.nodesOn("main", "main:layer_2").map((n) => n.id)).toEqual(ids);
  });
});

describe("cluster: areas in blocks other nodes own", () => {
  test("an area owned elsewhere has no nodes; one owned here or by no one fills, and so does the first once it is this node's", () => {
    // Block owners by "map|bx,by"; an absent block has no known owner.
    const owners = new Map([["main|0,0", "b"], ["main|1,0", "a"]]);
    const ownerAt = (map: string, x: number, y: number) => owners.get(`${map}|${Math.floor(x / 4096)},${Math.floor(y / 4096)}`);
    const spawner = new GatherSpawner(() => openGrid(), {
      spawnsHere: (map, x, y) => { const owner = ownerAt(map, x, y); return owner === undefined || owner === "b"; },
    }, seeded(4));
    spawner.setAreas([area({ id: 1 }), area({ id: 2, x: 5000 }), area({ id: 3, y: 5000 })], 0);
    spawner.setLayers(layers("main:layer_1"), 0);
    spawner.tick(0);
    expect(spawner.countOn(1, "main:layer_1")).toBe(5);
    expect(spawner.countOn(2, "main:layer_1")).toBe(0);
    expect(spawner.countOn(3, "main:layer_1")).toBe(5);

    owners.set("main|1,0", "b");
    spawner.tick(100);
    expect(spawner.countOn(2, "main:layer_1")).toBe(5);
  });

  test("nodes standing in a block another node takes are left alone", () => {
    const owners = new Map<string, string>();
    const spawner = new GatherSpawner(() => openGrid(), {
      spawnsHere: (map, x, y) => (owners.get(`${map}|${Math.floor(x / 4096)},${Math.floor(y / 4096)}`) ?? "b") === "b",
    }, seeded(4));
    spawner.setAreas([area()], 0);
    spawner.setLayers(layers("main:layer_1"), 0);
    spawner.tick(0);
    const [first] = spawner.nodesOn("main", "main:layer_1");
    owners.set("main|0,0", "a");
    spawner.tick(100);
    expect(spawner.countOn(1, "main:layer_1")).toBe(5);
    // A gathered one is not put back here: the block is node a's now.
    spawner.take(first!.id, 200);
    spawner.tick(200 + 20_000);
    expect(spawner.countOn(1, "main:layer_1")).toBe(4);
  });

  test("asks about the block only for an area with a node due", () => {
    let asked = 0;
    const spawner = new GatherSpawner(() => openGrid(), {
      spawnsHere: () => { asked++; return true; },
    }, seeded(4));
    spawner.setAreas([area()], 0);
    spawner.setLayers(layers("main:layer_1"), 0);
    spawner.tick(0);
    expect(spawner.countOn(1, "main:layer_1")).toBe(5);
    asked = 0;
    spawner.tick(100);
    spawner.tick(200);
    expect(asked).toBe(0);
    const [first] = spawner.nodesOn("main", "main:layer_1");
    spawner.take(first!.id, 300);
    spawner.tick(400);
    expect(asked).toBe(0);
    spawner.tick(300 + 20_000);
    expect(asked).toBe(1);
    expect(spawner.countOn(1, "main:layer_1")).toBe(5);
  });
});
