import { describe, expect, test } from "bun:test";
import {
  bareMapName, type BlockReason, EDGE_MARGIN_PX, handoffBlocked, handoffTarget, HANDOFFS_PER_TICK, pickHandoffs, type HandoffChecks, type OwnerAt,
} from "../cluster/handoffwatch";
import { packetsInFlight, trackPacket, waitIdle } from "../cluster/inflight";
import { tradeSettle } from "../cluster/tradesettle";

// Node "a" owns x < 1000 of map "main", node "b" owns x >= 1000. Nothing owns map "void".
const ownerAt = (map: string, x: number) => (map === "main" ? (x < 1000 ? "a" : "b") : null);
const open: HandoffChecks = {
  trading: () => false, dragged: () => false, pending: () => false, coolingDown: () => false, linkUp: () => true,
};
const player = (over: any = {}) => ({
  id: "7", username: "Hero", location: { map: "main.json", position: { x: 1200, y: 50, direction: "down" } }, ...over,
});

describe("spec values", () => {
  test("the margin and the per-tick limit are the spec values", () => {
    expect(EDGE_MARGIN_PX).toBe(64);
    expect(HANDOFFS_PER_TICK).toBe(20);
  });
});

describe("handoffTarget", () => {
  test("a point well inside another node's block goes there", () => {
    expect(handoffTarget("main", 1200, 50, ownerAt, "a")).toBe("b");
  });

  test("a point within the margin of this node's block stays", () => {
    // Guard: the margin loop. Without it, a player on the border goes back and forth.
    expect(handoffTarget("main", 1000 + EDGE_MARGIN_PX - 1, 50, ownerAt, "a")).toBeNull();
    expect(handoffTarget("main", 1000 + EDGE_MARGIN_PX, 50, ownerAt, "a")).toBe("b");
  });

  test("a point this node owns, or nobody owns, stays", () => {
    expect(handoffTarget("main", 10, 50, ownerAt, "a")).toBeNull();
    expect(handoffTarget("void", 10, 50, ownerAt, "a")).toBeNull();
  });

  test("the map name is looked up bare", () => {
    // Guard: bareMapName. Players carry "main.json"; the blocks are keyed "main".
    expect(bareMapName("main.json")).toBe("main");
    expect(handoffTarget("main.json", 1200, 50, ownerAt, "a")).toBe("b");
  });
});

describe("the margin loop, one offset at a time", () => {
  const OFFSETS: Array<[number, number]> = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];
  for (const [dx, dy] of OFFSETS) {
    // Guard: each of the 8 offsets. Only this neighbour belongs to this node, so a missing offset would hand the player off.
    test(`a point with only the (${dx}, ${dy}) neighbour owned by this node stays`, () => {
      const px = 1200;
      const py = 500;
      const onlyThatOne: OwnerAt = (_map, x, y) =>
        (x === px + dx * EDGE_MARGIN_PX && y === py + dy * EDGE_MARGIN_PX ? "a" : "b");
      expect(handoffTarget("main", px, py, onlyThatOne, "a")).toBeNull();
    });
  }

  test("a point this node owns stays even when no neighbour is its own", () => {
    // Guard: owner === self. Without it, a point this node owns would be sent to this node itself.
    const onlyThePoint: OwnerAt = (_map, x, y) => (x === 1200 && y === 500 ? "a" : "b");
    expect(handoffTarget("main", 1200, 500, onlyThePoint, "a")).toBeNull();
  });
});

describe("handoffBlocked", () => {
  const cases: Array<[BlockReason, any, Partial<HandoffChecks>]> = [
    ["remote", { remote: true }, {}],
    ["pending", { handoff: true }, {}],
    ["pending", {}, { pending: () => true }],
    ["dead", { isDead: true }, {}],
    ["revive", { reviveOffered: true }, {}],
    ["ghost-teleport", { isDead: true, isGhost: true, ghostTeleportPending: true }, {}],
    ["trading", {}, { trading: () => true }],
    ["settling", {}, { settling: () => true }],
    ["casting", { casting: true }, {}],
    ["dragged", {}, { dragged: () => true }],
    ["cooldown", {}, { coolingDown: () => true }],
    ["link", {}, { linkUp: () => false }],
  ];
  for (const [reason, over, checks] of cases) {
    // Guard: each line of handoffBlocked has the test of its reason.
    test(`blocked: ${reason} (${JSON.stringify(over)})`, () => {
      expect(handoffBlocked(player(over), "b", { ...open, ...checks })).toBe(reason);
    });
  }

  test("a ghost may go; a corpse may not", () => {
    expect(handoffBlocked(player({ isDead: true, isGhost: true }), "b", open)).toBeNull();
    expect(handoffBlocked(player({ isDead: true, isGhost: false }), "b", open)).toBe("dead");
  });

  test("a player marked unsettled after a lost trade stays: the node's marks are asked when no check is given", async () => {
    tradeSettle.reset({ drop: async () => {} });
    try {
      await tradeSettle.unsettle("hero", "test", "c");
      // Guard: the default to the node's marks. The mark is held here only; the node the player went to would write
      // their bags from rows that may predate the swap.
      expect(handoffBlocked(player(), "b", open)).toBe("settling");
      expect(pickHandoffs([player()], ownerAt, "a", open)).toEqual([]);
    } finally {
      tradeSettle.reset();
    }
    expect(handoffBlocked(player(), "b", open)).toBeNull();
  });

  test("a free player may go", () => {
    expect(handoffBlocked(player(), "b", open)).toBeNull();
  });

  test("the drag check gets the player's id as a string", () => {
    // Guard: String(player.id). Runtime ids may be numbers; the drag set is keyed by strings (R9).
    const seen: string[] = [];
    const checks: HandoffChecks = { ...open, dragged: (id: string) => { seen.push(id); return false; } };
    handoffBlocked(player({ id: 7 }), "b", checks);
    expect(seen).toEqual(["7"]);
  });

  test("the link check asks about the target node", () => {
    const asked: string[] = [];
    const checks: HandoffChecks = { ...open, linkUp: (peer: string) => { asked.push(peer); return true; } };
    handoffBlocked(player(), "c", checks);
    expect(asked).toEqual(["c"]);
  });
});

describe("pickHandoffs", () => {
  test("picks the players across the border, at most the limit", () => {
    const many = Array.from({ length: HANDOFFS_PER_TICK + 5 }, (_, i) => player({ id: String(i), username: `p${i}` }));
    const home = player({ id: "home", username: "Home", location: { map: "main.json", position: { x: 10, y: 0 } } });
    const picks = pickHandoffs([home, ...many], ownerAt, "a", open);
    // Guard: the limit. Without it one tick hands off everyone at once.
    expect(picks.length).toBe(HANDOFFS_PER_TICK);
    expect(picks.every((p) => p.target === "b" && p.player.id !== "home")).toBe(true);
  });

  test("a blocked player is not picked", () => {
    const picks = pickHandoffs([player({ casting: true }), player({ id: "8", username: "Free" })], ownerAt, "a", open);
    expect(picks.map((p) => p.player.id)).toEqual(["8"]);
  });

  test("a player with no location is skipped", () => {
    expect(pickHandoffs([{ id: "9", username: "Lost" }], ownerAt, "a", open)).toEqual([]);
  });

  test("a player with no map name is skipped", () => {
    // Guard: the string check on the map. This owner answers for any map name, so only the check stops the pick.
    const anyMap: OwnerAt = (_map, x) => (x < 1000 ? "a" : "b");
    const picks = pickHandoffs([{ id: "9", username: "NoMap", location: { position: { x: 1200, y: 50 } } }], anyMap, "a", open);
    expect(picks).toEqual([]);
  });

  for (const position of [{ y: 50 }, { x: 1200 }]) {
    // Guard: the finite check on x and y. Without it a NaN position is picked and sent to the far node.
    test(`a player with a missing coordinate is skipped (${JSON.stringify(position)})`, () => {
      const picks = pickHandoffs([{ id: "9", username: "NoXY", location: { map: "main.json", position } }], ownerAt, "a", open);
      expect(picks).toEqual([]);
    });
  }

  test("a null coordinate is skipped, not read as 0", () => {
    // Guard: the number check on x. Number(null) is 0, and with this owner 0 is across the border, so without the
    // check the player would be picked.
    const flipped: OwnerAt = (_map, x) => (x < 1000 ? "b" : "a");
    const picks = pickHandoffs([{ id: "9", username: "NullX", location: { map: "main.json", position: { x: null, y: 50 } } }], flipped, "a", open);
    expect(picks).toEqual([]);
  });

  test("a non-finite coordinate is skipped", () => {
    // Guard: the finite check. Infinity is past any border and would be picked.
    const picks = pickHandoffs([
      { id: "9", username: "InfX", location: { map: "main.json", position: { x: Infinity, y: 50 } } },
      { id: "10", username: "NaNY", location: { map: "main.json", position: { x: 1200, y: NaN } } },
    ], ownerAt, "a", open);
    expect(picks).toEqual([]);
  });

  test("a null y is skipped, not read as 0", () => {
    // Guard: the number check on y. Here x is across the border, so only the y check keeps the player back.
    const picks = pickHandoffs([{ id: "9", username: "NullY", location: { map: "main.json", position: { x: 1200, y: null } } }], ownerAt, "a", open);
    expect(picks).toEqual([]);
  });
});

describe("in-flight packets", () => {
  test("a packet counts while it runs", async () => {
    let release!: () => void;
    const running = trackPacket("p1", () => new Promise<void>((resolve) => { release = resolve; }));
    expect(packetsInFlight("p1")).toBe(1);
    // Guard: waitIdle's count. Without it the handoff snapshots a player whose packet is half done.
    expect(await waitIdle("p1", 30, 5)).toBe(false);
    release();
    await running;
    expect(packetsInFlight("p1")).toBe(0);
    expect(await waitIdle("p1", 30, 5)).toBe(true);
  });

  test("waitIdle returns as soon as the packet ends", async () => {
    const running = trackPacket("p5", () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    expect(await waitIdle("p5", 500, 5)).toBe(true);
    await running;
  });

  test("a packet that throws still ends", async () => {
    // Guard: the finally in trackPacket.
    await expect(trackPacket("p2", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(packetsInFlight("p2")).toBe(0);
  });

  test("waitIdle inside a packet does not wait for that packet", async () => {
    // Guard: the AsyncLocalStorage check. Without it a warp handled in a packet waits 2 s for itself.
    const idle = await trackPacket("p3", () => waitIdle("p3", 30, 5));
    expect(idle).toBe(true);
  });

  test("waitIdle inside one packet still waits for another of the same player", async () => {
    let release!: () => void;
    const other = trackPacket("p4", () => new Promise<void>((resolve) => { release = resolve; }));
    const idle = await trackPacket("p4", () => waitIdle("p4", 30, 5));
    expect(idle).toBe(false);
    release();
    await other;
  });

  test("waitIdle exempts only the packets of its own player", async () => {
    // Guard: the id check in the exemption. A packet of another player inside this player's packet must not exempt
    // the other packet of this player that is still running.
    let release!: () => void;
    const held = trackPacket("pa", () => new Promise<void>((resolve) => { release = resolve; }));
    const idle = await trackPacket("pa", () => trackPacket("pb", () => waitIdle("pa", 30, 5)));
    expect(idle).toBe(false);
    release();
    await held;
  });

  test("a timer started by a packet that has ended does not exempt that packet", async () => {
    // Guard: the live flag on the packet's run. Without it the timer's waitIdle subtracts a packet that has already
    // ended, and reports idle while another packet of the same player is still running.
    let fromTimer = null as boolean | null;
    let timerDone!: () => void;
    const fired = new Promise<void>((resolve) => { timerDone = resolve; });
    await trackPacket("p6", async () => {
      setTimeout(async () => { fromTimer = await waitIdle("p6", 30, 5); timerDone(); }, 10);
    });
    let release!: () => void;
    const held = trackPacket("p6", () => new Promise<void>((resolve) => { release = resolve; }));
    await fired;
    expect(packetsInFlight("p6")).toBe(1);
    expect(fromTimer).toBe(false);
    release();
    await held;
  });

  test("a floating promise started by a packet that has ended does not exempt that packet", async () => {
    // Guard: the same live flag, for un-awaited work the packet started and that outlives it.
    let fromFloat = null as boolean | null;
    let floatDone!: () => void;
    const fired = new Promise<void>((resolve) => { floatDone = resolve; });
    await trackPacket("p8", async () => {
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        fromFloat = await waitIdle("p8", 30, 5);
        floatDone();
      })();
    });
    let release!: () => void;
    const held = trackPacket("p8", () => new Promise<void>((resolve) => { release = resolve; }));
    await fired;
    expect(fromFloat).toBe(false);
    release();
    await held;
  });

  test("a nested trackPacket for the same player does not wait for its own outer packet", async () => {
    // Guard: the nested packet's own exemption. Without it, waitIdle inside the inner packet waits for the outer one
    // until the deadline, and a drain would log a false warning.
    const inside: number[] = [];
    const idle = await trackPacket("p7", () => trackPacket("p7", async () => {
      inside.push(packetsInFlight("p7"));
      return waitIdle("p7", 30, 5);
    }));
    expect(idle).toBe(true);
    expect(inside).toEqual([2]);
    expect(packetsInFlight("p7")).toBe(0);
  });

  test("a nested packet that outlives its outer packet is still counted", async () => {
    // Guard: nested packets are counted in their own right. Without it, work the outer packet fires off with
    // trackPacket runs uncounted after the outer packet ends.
    let release!: () => void;
    await trackPacket("p9", async () => {
      void trackPacket("p9", () => new Promise<void>((resolve) => { release = resolve; }));
    });
    expect(packetsInFlight("p9")).toBe(1);
    expect(await waitIdle("p9", 30, 5)).toBe(false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(packetsInFlight("p9")).toBe(0);
  });
});
