import { describe, expect, spyOn, test } from "bun:test";
import { GatherService, REASONS, type Gatherer } from "../systems/gathering/service";
import { GatherSpawner } from "../systems/gathering/spawner";
import type { GatherArea } from "../systems/gathering/types";
import { openGrid, seeded } from "./gathering-helpers";
const { default: log } = await import("../modules/logger");

const area: GatherArea = {
  id: 1, map: "main", x: 500, y: 500, radius: 64, size: 32, item: "Copper Ore",
  quantity_min: 2, quantity_max: 4, max_nodes: 1, respawn_min_s: 10, respawn_max_s: 20, enabled: true,
};

function setup(options: { give?: (u: string, i: string, q: number) => Promise<boolean>; room?: boolean; roll?: () => number } = {}) {
  const spawner = new GatherSpawner(() => openGrid(), {}, seeded(2));
  spawner.setAreas([area], 0);
  spawner.setLayers(new Map([["main", ["L1"]]]), 0);
  spawner.tick(0);
  const node = spawner.nodesOn("main", "L1")[0]!;
  const players = new Map<string, Gatherer>();
  const add = (id: string, overrides: Partial<Gatherer> = {}) =>
    players.set(id, { id, username: id, map: "main", layerId: "L1", x: node.x + 10, y: node.y, dead: false, stunned: false, casting: false, moving: false, inCombat: false, ...overrides });
  const waiting: Array<() => void> = [];
  const given: Array<[string, string, number]> = [];
  const service = new GatherService({
    spawner,
    gatherer: (id) => players.get(id) ?? null,
    hasRoomFor: async () => options.room ?? true,
    give: options.give ?? (async (u, i, q) => (given.push([u, i, q]), true)),
    later: (run) => void waiting.push(run),
    r: options.roll ?? seeded(3),
    now: () => 1000,
  });
  /** Lets every awaited check settle, then closes the open windows. */
  const closeWindows = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const run of waiting.splice(0)) run();
  };
  return { spawner, node, add, service, given, closeWindows, players };
}

describe("GatherService.start", () => {
  const refusals: Array<[string, Partial<Gatherer>, string]> = [
    ["too far", { x: 5000 }, REASONS.far],
    ["another layer", { layerId: "L2" }, REASONS.gone],
    ["dead", { dead: true }, REASONS.dead],
    ["stunned", { stunned: true }, REASONS.stunned],
    ["casting", { casting: true }, REASONS.casting],
    ["moving", { moving: true }, REASONS.moving],
    ["in combat", { inCombat: true }, REASONS.combat],
  ];
  for (const [what, overrides, reason] of refusals) {
    test(`refuses a player who is ${what}`, async () => {
      const { node, add, service } = setup();
      add("alice", overrides);
      expect(await service.start("alice", node.id)).toEqual({ ok: false, reason });
    });
  }

  test("refuses when the bags are full", async () => {
    const { node, add, service } = setup({ room: false });
    add("alice");
    expect(await service.start("alice", node.id)).toEqual({ ok: false, reason: REASONS.full });
  });

  test("refuses a node that does not exist", async () => {
    const { add, service } = setup();
    add("alice");
    expect(await service.start("alice", 999)).toEqual({ ok: false, reason: REASONS.gone });
  });

  test("lets a player in range start", async () => {
    const { node, add, service } = setup();
    add("alice");
    expect(await service.start("alice", node.id)).toEqual({ ok: true, node });
  });
});

describe("GatherService.finish", () => {
  test("gives the item once, in the area's quantity range, and the node is gone", async () => {
    const { spawner, node, add, service, given, closeWindows } = setup();
    add("alice");
    const done = service.finish("alice", node.id);
    await closeWindows();
    const outcome = await done;
    expect(outcome.ok).toBe(true);
    expect(given.length).toBe(1);
    expect(given[0]![0]).toBe("alice");
    expect(given[0]![1]).toBe("Copper Ore");
    expect(given[0]![2]).toBeGreaterThanOrEqual(2);
    expect(given[0]![2]).toBeLessThanOrEqual(4);
    expect(spawner.get(node.id)).toBeUndefined();
  });

  test("two players finishing together: one gets it, the other is told someone else did", async () => {
    for (const [roll, winner, loser] of [[0, "alice", "bob"], [0.99, "bob", "alice"]] as const) {
      const { node, add, service, given, closeWindows } = setup({ roll: () => roll });
      add("alice");
      add("bob");
      const alice = service.finish("alice", node.id);
      const bob = service.finish("bob", node.id);
      await closeWindows();
      const outcomes = { alice: await alice, bob: await bob };
      expect(outcomes[winner].ok).toBe(true);
      expect(outcomes[loser]).toEqual({ ok: false, reason: REASONS.lost });
      expect(given.map(([u]) => u)).toEqual([winner]);
    }
  });

  test("a claimant who walked away during the window does not void the other", async () => {
    for (const roll of [0, 0.99]) {
      const { node, add, service, given, closeWindows, players } = setup({ roll: () => roll });
      add("alice");
      add("bob");
      const alice = service.finish("alice", node.id);
      const bob = service.finish("bob", node.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      players.get("bob")!.x = 5000;
      await closeWindows();
      const [a, b] = [await alice, await bob];
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(false);
      expect(given.map(([u]) => u)).toEqual(["alice"]);
    }
  });

  test("a claim after the node was taken loses at once", async () => {
    const { node, add, service, given, closeWindows } = setup();
    add("alice");
    add("bob");
    const alice = service.finish("alice", node.id);
    await closeWindows();
    await alice;
    expect(given.length).toBe(1);
    expect(await service.finish("bob", node.id)).toEqual({ ok: false, reason: REASONS.lost });
  });

  test("a node whose item could not be given is put back", async () => {
    const { spawner, node, add, service, closeWindows } = setup({ give: async () => false });
    add("alice");
    const done = service.finish("alice", node.id);
    await closeWindows();
    expect(await done).toEqual({ ok: false, reason: REASONS.failed });
    expect(spawner.get(node.id)).toBeDefined();
  });

  test("a give that throws puts the node back and is logged", async () => {
    const { spawner, node, add, service, closeWindows } = setup({ give: async () => { throw new Error("boom"); } });
    add("alice");
    const errors = spyOn(log, "error").mockImplementation(() => {});
    try {
      const done = service.finish("alice", node.id);
      await closeWindows();
      expect(await done).toEqual({ ok: false, reason: REASONS.failed });
      expect(spawner.get(node.id)).toBeDefined();
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]![0]).toContain("boom");
    } finally {
      errors.mockRestore();
    }
  });

  test("a winner who died before the window closed gets nothing and the node stays", async () => {
    const { spawner, node, add, service, given, closeWindows, players } = setup();
    add("alice");
    const done = service.finish("alice", node.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    players.get("alice")!.dead = true;
    await closeWindows();
    expect(await done).toEqual({ ok: false, reason: REASONS.dead });
    expect(given).toEqual([]);
    expect(spawner.get(node.id)).toBeDefined();
  });

  test("a player who walked away during the cast gets nothing", async () => {
    const { spawner, node, add, service } = setup();
    add("alice", { x: 5000 });
    expect(await service.finish("alice", node.id)).toEqual({ ok: false, reason: REASONS.far });
    expect(spawner.get(node.id)).toBeDefined();
  });
});
