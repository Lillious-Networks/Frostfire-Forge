import { describe, expect, test } from "bun:test";
import { LayerManager, blockOf } from "../services/layermanager";

// Small cap and 100 px blocks keep the arithmetic readable; the first and
// last tests use the real defaults (50 per block, 4096 px blocks).
const make = () => new LayerManager({ maxPlayersPerBlock: 3, blockSizePx: 100 });

// x positions inside block 0 and block 1 for the 100 px blocks above
const A = 10;
const B = 150;

function fill(lm: LayerManager, map: string, x: number, count: number, prefix: string): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}${i}`;
    lm.assignPlayerToLayer(id, map, x, 0);
    ids.push(id);
  }
  return ids;
}

describe("blockOf", () => {
  test("floors each axis by the block size", () => {
    expect(blockOf(0, 0)).toBe("0,0");
    expect(blockOf(4095, 4095)).toBe("0,0");
    expect(blockOf(4096, 8192)).toBe("1,2");
    expect(blockOf(-1, -4097)).toBe("-1,-2");
    expect(blockOf(250, 99, 100)).toBe("2,0");
  });
});

describe("assignPlayerToLayer", () => {
  test("a full block spills the next player to layer_2", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p");
    expect(lm.getPlayerLayer("p0")).toBe("main:layer_1");
    expect(lm.assignPlayerToLayer("extra", "main", A, 0)).toBe("main:layer_2");
    expect(lm.getLayerInfo("main:layer_1")!.playerCount).toBe(3);
  });

  test("a player in another block of the same map still gets layer_1", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p");
    expect(lm.assignPlayerToLayer("elsewhere", "main", B, 0)).toBe("main:layer_1");
    expect(lm.getLayerInfo("main:layer_1")!.playerCount).toBe(4);
    expect(lm.countInBlock("main:layer_1", blockOf(A, 0, 100))).toBe(3);
    expect(lm.countInBlock("main:layer_1", blockOf(B, 0, 100))).toBe(1);
  });

  test("other maps are independent", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p");
    expect(lm.assignPlayerToLayer("o", "other", A, 0)).toBe("other:layer_1");
  });

  test("picks the lowest numbered layer with room in the block, not the newest", () => {
    const lm = make();
    fill(lm, "main", A, 3, "a");
    fill(lm, "main", A, 3, "b"); // layer_2
    lm.removePlayerFromLayer("a0");
    expect(lm.assignPlayerToLayer("late", "main", A, 0)).toBe("main:layer_1");
  });

  test("a freed layer number is reused (lowest free number)", () => {
    const lm = make();
    fill(lm, "main", A, 3, "a");   // layer_1
    fill(lm, "main", A, 3, "b");   // layer_2
    fill(lm, "main", A, 3, "c");   // layer_3
    for (let i = 0; i < 3; i++) lm.removePlayerFromLayer(`b${i}`);
    expect(lm.getLayerInfo("main:layer_2")).toBeNull();
    expect(lm.assignPlayerToLayer("n", "main", A, 0)).toBe("main:layer_2");
  });

  test("preferred layer is honoured only when it has room in the player's block", () => {
    const lm = make();
    fill(lm, "main", A, 3, "a");  // layer_1 full in block A
    fill(lm, "main", A, 1, "b");  // layer_2
    // layer_1 is full in A, so the preference is ignored and layer_2 wins
    expect(lm.assignPlayerToLayer("x", "main", A, 0, "main:layer_1")).toBe("main:layer_2");
    // layer_2 has room in A (2 of 3) and is preferred over the lower layer_1 only when it has room
    expect(lm.assignPlayerToLayer("y", "main", A, 0, "main:layer_2")).toBe("main:layer_2");
    // layer_1 has room in block B, so there the preference is honoured
    expect(lm.assignPlayerToLayer("z", "main", B, 0, "main:layer_2")).toBe("main:layer_2");
    expect(lm.assignPlayerToLayer("w", "main", B, 0, "main:layer_1")).toBe("main:layer_1");
  });

  test("a preferred layer from another map is ignored", () => {
    const lm = make();
    lm.assignPlayerToLayer("a", "other", A, 0);
    expect(lm.assignPlayerToLayer("b", "main", A, 0, "other:layer_1")).toBe("main:layer_1");
  });

  test("re-assigning a player moves it without leaving counts behind", () => {
    const lm = make();
    lm.assignPlayerToLayer("a", "main", A, 0);
    lm.assignPlayerToLayer("a", "main", B, 0);
    expect(lm.getLayerInfo("main:layer_1")!.playerCount).toBe(1);
    expect(lm.countInBlock("main:layer_1", blockOf(A, 0, 100))).toBe(0);
    expect(lm.countInBlock("main:layer_1", blockOf(B, 0, 100))).toBe(1);
  });

  test("50 players in one default block fill layer_1 and the 51st goes to layer_2", () => {
    const lm = new LayerManager();
    for (let i = 0; i < 50; i++) lm.assignPlayerToLayer(`p${i}`, "main", 100, 100);
    expect(lm.assignPlayerToLayer("p50", "main", 200, 200)).toBe("main:layer_2");
    // a block over 4096 px away is still layer_1
    expect(lm.assignPlayerToLayer("far", "main", 5000, 100)).toBe("main:layer_1");
  });
});

describe("updatePlayerBlock", () => {
  test("an overflow player walking into an empty block is sent to layer_1", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p");
    lm.assignPlayerToLayer("over", "main", A, 0); // layer_2
    expect(lm.updatePlayerBlock("over", B, 0)).toBe("main:layer_1");
  });

  test("an overflow player walking into another full block stays put", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p");
    fill(lm, "main", B, 3, "q");
    lm.assignPlayerToLayer("over", "main", A, 0); // layer_2
    expect(lm.updatePlayerBlock("over", B, 0)).toBeNull();
  });

  test("a layer_1 player walking anywhere gets null", () => {
    const lm = make();
    lm.assignPlayerToLayer("p", "main", A, 0);
    expect(lm.updatePlayerBlock("p", B, 0)).toBeNull();
    expect(lm.updatePlayerBlock("p", 5000, 5000)).toBeNull();
  });

  test("moving inside a block changes nothing", () => {
    const lm = make();
    lm.assignPlayerToLayer("p", "main", A, 0);
    expect(lm.updatePlayerBlock("p", A + 5, 3)).toBeNull();
    expect(lm.countInBlock("main:layer_1", blockOf(A, 0, 100))).toBe(1);
  });

  test("block counts follow the player", () => {
    const lm = make();
    lm.assignPlayerToLayer("p", "main", A, 0);
    lm.updatePlayerBlock("p", B, 0);
    expect(lm.countInBlock("main:layer_1", blockOf(A, 0, 100))).toBe(0);
    expect(lm.countInBlock("main:layer_1", blockOf(B, 0, 100))).toBe(1);
    expect(lm.getLayerInfo("main:layer_1")!.playerCount).toBe(1);
  });

  test("a player in the lowest layer with room is never told to move", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p"); // layer_1 full in A
    lm.assignPlayerToLayer("o1", "main", A, 0); // layer_2
    lm.assignPlayerToLayer("o2", "main", A, 0); // layer_2
    // layer_1 is full in A, so o1/o2 are already in the lowest layer with room
    expect(lm.updatePlayerBlock("o1", A + 1, 0)).toBeNull();
    expect(lm.updatePlayerBlock("o2", A + 2, 0)).toBeNull();
  });

  test("unknown player returns null", () => {
    expect(make().updatePlayerBlock("ghost", 0, 0)).toBeNull();
  });

  test("a walk into a block where only a higher layer has room never suggests that layer", () => {
    const lm = make();
    fill(lm, "main", A, 3, "a");     // layer_1 full in A
    fill(lm, "main", A, 3, "b");     // layer_2 full in A
    lm.assignPlayerToLayer("c", "main", A, 0); // layer_3
    fill(lm, "main", B, 3, "q");     // layer_1 full in B
    fill(lm, "main", B, 3, "r");     // layer_2 full in B; layer_3 has room in B
    expect(lm.getPlayerLayer("b0")).toBe("main:layer_2");
    // b0 (layer_2) walks into B: layer_1 and layer_2 are full there and only
    // layer_3 has room. Walking in never moves a player up: b0 stays.
    expect(lm.updatePlayerBlock("b0", B, 0)).toBeNull();
    expect(lm.getPlayerLayer("b0")).toBe("main:layer_2");
    expect(lm.countInBlock("main:layer_2", blockOf(B, 0, 100))).toBe(4);
  });
});

describe("lowerLayerWithRoom", () => {
  test("offers only a lower-numbered layer with room in the player's block", () => {
    const lm = make();
    fill(lm, "main", A, 3, "a");     // layer_1 full in A
    lm.assignPlayerToLayer("o", "main", A, 0); // layer_2
    expect(lm.lowerLayerWithRoom("o")).toBeNull();
    expect(lm.lowerLayerWithRoom("a0")).toBeNull(); // layer_1 has nothing lower
    lm.removePlayerFromLayer("a1");
    expect(lm.lowerLayerWithRoom("o")).toBe("main:layer_1");
    expect(lm.lowerLayerWithRoom("ghost")).toBeNull();
  });
});

describe("movePlayerToLayer", () => {
  test("updates the player's layer, both layer counts and the block counts", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p");
    lm.assignPlayerToLayer("o", "main", B, 0); // layer_1 (room in B)
    fill(lm, "main", A, 1, "z");               // layer_2 (A full on layer_1)
    const block = blockOf(B, 0, 100);

    lm.movePlayerToLayer("o", "main:layer_2");

    expect(lm.getPlayerLayer("o")).toBe("main:layer_2");
    expect(lm.getPlayersInLayer("main:layer_2")).toContain("o");
    expect(lm.getPlayersInLayer("main:layer_1")).not.toContain("o");
    expect(lm.getLayerInfo("main:layer_1")!.playerCount).toBe(3);
    expect(lm.getLayerInfo("main:layer_2")!.playerCount).toBe(2);
    expect(lm.countInBlock("main:layer_1", block)).toBe(0);
    expect(lm.countInBlock("main:layer_2", block)).toBe(1);
  });

  test("moving the last player out deletes the source layer", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p");
    lm.assignPlayerToLayer("o", "main", A, 0); // layer_2
    lm.movePlayerToLayer("p0", "main:layer_2");
    lm.movePlayerToLayer("p1", "main:layer_2");
    lm.movePlayerToLayer("p2", "main:layer_2");
    expect(lm.getLayerInfo("main:layer_1")).toBeNull();
    expect(lm.getPlayerLayer("p0")).toBe("main:layer_2");
  });

  test("a missing target layer or the current layer changes nothing", () => {
    const lm = make();
    lm.assignPlayerToLayer("p", "main", A, 0);
    lm.movePlayerToLayer("p", "main:layer_9");
    lm.movePlayerToLayer("p", "main:layer_1");
    expect(lm.getPlayerLayer("p")).toBe("main:layer_1");
    expect(lm.getLayerInfo("main:layer_1")!.playerCount).toBe(1);
    expect(lm.countInBlock("main:layer_1", blockOf(A, 0, 100))).toBe(1);
  });

  test("a later block update uses the moved player's new layer", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p");
    lm.assignPlayerToLayer("o", "main", A, 0); // layer_2
    lm.movePlayerToLayer("p0", "main:layer_2");
    lm.updatePlayerBlock("p0", B, 0);
    expect(lm.countInBlock("main:layer_2", blockOf(A, 0, 100))).toBe(1);
    expect(lm.countInBlock("main:layer_2", blockOf(B, 0, 100))).toBe(1);
  });
});

describe("removePlayerFromLayer", () => {
  test("removing the last player deletes the layer and its block counts", () => {
    const lm = make();
    lm.assignPlayerToLayer("p", "main", A, 0);
    lm.removePlayerFromLayer("p");
    expect(lm.getLayerInfo("main:layer_1")).toBeNull();
    expect(lm.getPlayerLayer("p")).toBeNull();
    expect(lm.countInBlock("main:layer_1", blockOf(A, 0, 100))).toBe(0);
    expect(lm.getStats().totalLayers).toBe(0);
  });

  test("keeps the layer while others remain and frees the block slot", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p");
    lm.removePlayerFromLayer("p0");
    expect(lm.getLayerInfo("main:layer_1")!.playerCount).toBe(2);
    expect(lm.countInBlock("main:layer_1", blockOf(A, 0, 100))).toBe(2);
    expect(lm.assignPlayerToLayer("n", "main", A, 0)).toBe("main:layer_1");
  });
});

describe("syncPartyToLeaderLayer", () => {
  test("moves members into the leader's layer while their block has room", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p");
    lm.assignPlayerToLayer("leader", "main", A, 0); // layer_2
    lm.assignPlayerToLayer("m1", "main", B, 0);     // layer_1 (room in B)
    expect(lm.syncPartyToLeaderLayer("leader", ["m1"], "main")).toBe("main:layer_2");
    expect(lm.getPlayerLayer("m1")).toBe("main:layer_2");
    expect(lm.countInBlock("main:layer_2", blockOf(B, 0, 100))).toBe(1);
    expect(lm.countInBlock("main:layer_1", blockOf(B, 0, 100))).toBe(0);
  });

  test("a member whose block is full on the leader's layer stays, others still move", () => {
    const lm = make();
    fill(lm, "main", A, 3, "p");                    // layer_1, A full
    lm.assignPlayerToLayer("mB", "main", B, 0);     // layer_1, block B
    lm.assignPlayerToLayer("leader", "main", A, 0); // layer_2
    lm.assignPlayerToLayer("q1", "main", A, 0);     // layer_2
    lm.assignPlayerToLayer("q2", "main", A, 0);     // layer_2, A now full there too
    expect(lm.syncPartyToLeaderLayer("leader", ["p0", "mB"], "main")).toBe("main:layer_2");
    expect(lm.getPlayerLayer("p0")).toBe("main:layer_1");
    expect(lm.getPlayerLayer("mB")).toBe("main:layer_2");
  });

  test("no layer for the leader returns null", () => {
    expect(make().syncPartyToLeaderLayer("nobody", [], "main")).toBeNull();
  });
});
