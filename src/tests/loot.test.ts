import { afterEach, describe, expect, test } from "bun:test";
import loot from "../systems/loot";

const player = (username: string, x = 100, y = 100, map = "main") => ({
  id: `id-${username}`,
  username,
  location: { map, position: { x, y } },
});

// Every drop starts a 30 minute despawn timer: clear whatever a test left behind.
afterEach(() => {
  for (const map of ["main", "other"]) {
    for (const item of loot.getOnMap(map)) loot.despawn(item.id);
  }
});

describe("owned loot", () => {
  test("belongs to the player it was created for", () => {
    const drop = loot.create(player("alice"), "Rat Tail", 2, "", "common");

    expect(drop.ownerId).toBe("alice");
    expect(drop.ownerName).toBe("alice");
  });

  test("cannot be picked up by another player", () => {
    const drop = loot.create(player("alice"), "Rat Tail", 1, "", "common");

    expect(loot.pickup(player("bob"), drop.id)).toEqual({ success: false, message: "This loot belongs to someone else." });
    expect(loot.pickupAllNearby(player("bob"))).toEqual([]);
    expect(loot.pickup(player("alice"), drop.id).success).toBe(true);
  });

  test("is removed when its owner is cleaned up", () => {
    const drop = loot.create(player("alice"), "Rat Tail", 1, "", "common");

    expect(loot.cleanupPlayer("alice").map((item) => item.id)).toEqual([drop.id]);
    expect(loot.get(drop.id)).toBeUndefined();
  });
});

describe("loot with no owner", () => {
  test("has an empty owner", () => {
    const drop = loot.create(player("alice"), "Rat Tail", 3, "", "common", null);

    expect(drop.ownerId).toBe("");
    expect(drop.ownerName).toBe("");
    expect(drop.quantity).toBe(3);
  });

  test("can be picked up by anyone, once", () => {
    const drop = loot.create(player("alice"), "Rat Tail", 1, "", "common", null);

    const first = loot.pickup(player("bob"), drop.id);
    expect(first.success).toBe(true);
    expect(first.item?.id).toBe(drop.id);
    expect(loot.pickup(player("carol"), drop.id)).toEqual({ success: false, message: "Loot no longer exists." });
  });

  test("is included when anyone picks up everything nearby", () => {
    const free = loot.create(player("alice"), "Rat Tail", 1, "", "common", null);
    const owned = loot.create(player("alice"), "Iron Ore", 1, "", "common");

    expect(loot.pickupAllNearby(player("bob")).map((item) => item.id)).toEqual([free.id]);
    expect(loot.get(owned.id)).toBeDefined();
  });

  test("still needs the player to be on the map and in range", () => {
    const drop = loot.create(player("alice"), "Rat Tail", 1, "", "common", null);

    expect(loot.pickup(player("bob", 100, 100, "other"), drop.id).message).toBe("Loot is on a different map.");
    expect(loot.pickup(player("bob", 100 + loot.PICKUP_RADIUS + 1, 100), drop.id).message).toBe("You are too far away.");
    expect(loot.get(drop.id)).toBeDefined();
  });

  test("stays on the ground when the player who dropped it is cleaned up", () => {
    const drop = loot.create(player("alice"), "Rat Tail", 1, "", "common", null);

    expect(loot.cleanupPlayer("alice")).toEqual([]);
    expect(loot.cleanupPlayer("")).toEqual([]);
    expect(loot.get(drop.id)).toBeDefined();
  });
});
