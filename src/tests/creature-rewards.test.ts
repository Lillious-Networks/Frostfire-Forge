import { describe, expect, mock, test } from "bun:test";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

const { baseKillXp, distributeKillXp, groupBonus, rankMultiplier, zeroDifference } = await import("../systems/creatures/rewards");
const { CorpseLootStore, splitCopper } = await import("../systems/creatures/loot");

describe("kill XP", () => {
  test("equal level gives 45 + 5 x level", () => {
    expect(baseKillXp(1, 1)).toBe(50);
    expect(baseKillXp(10, 10)).toBe(95);
    expect(baseKillXp(60, 60)).toBe(345);
  });

  test("higher creatures give +5% per level, capped at +4", () => {
    expect(baseKillXp(10, 12)).toBeCloseTo(104.5, 5);
    expect(baseKillXp(10, 14)).toBeCloseTo(114, 5);
    expect(baseKillXp(10, 20)).toBeCloseTo(114, 5);
  });

  test("lower creatures scale by the zero-difference table and grey gives 0", () => {
    expect(zeroDifference(7)).toBe(5);
    expect(zeroDifference(20)).toBe(10);
    expect(zeroDifference(45)).toBe(13);
    expect(zeroDifference(60)).toBe(16);
    // Level 20 vs 17: 145 * (1 - 3/10)
    expect(baseKillXp(20, 17)).toBeCloseTo(101.5, 5);
    // Level 20 grey level is 13
    expect(baseKillXp(20, 13)).toBe(0);
    expect(baseKillXp(20, 14)).toBeGreaterThan(0);
  });

  test("rank multipliers and group bonus", () => {
    expect(rankMultiplier("normal")).toBe(1);
    expect(rankMultiplier("elite")).toBe(2);
    expect(rankMultiplier("rare")).toBe(2);
    expect(rankMultiplier("rare_elite")).toBe(4);
    expect([1, 2, 3, 4, 5, 6].map(groupBonus)).toEqual([1, 1, 1.166, 1.3, 1.4, 1]);
  });

  test("solo kills get the full value with xp_mult applied", () => {
    const xp = distributeKillXp([{ username: "a", level: 10 }], 10, "elite", 1.5);
    expect(xp.get("a")).toBe(Math.round(95 * 2 * 1.5));
  });

  test("groups split by level share with the group bonus, valued at the highest level", () => {
    const xp = distributeKillXp(
      [
        { username: "low", level: 10 },
        { username: "high", level: 20 },
        { username: "mid", level: 15 },
      ],
      20,
      "normal",
      1
    );
    const total = baseKillXp(20, 20) * 1.166;
    expect(xp.get("low")).toBe(Math.round((total * 10) / 45));
    expect(xp.get("high")).toBe(Math.round((total * 20) / 45));
    expect(xp.get("mid")).toBe(Math.round((total * 15) / 45));
  });

  test("a high-level helper can make the kill grey for the whole group", () => {
    const xp = distributeKillXp([{ username: "low", level: 5 }, { username: "helper", level: 60 }], 5, "normal", 1);
    expect(xp.get("low")).toBe(0);
    expect(xp.get("helper")).toBe(0);
  });

  test("no members or zero multiplier yields nothing", () => {
    expect(distributeKillXp([], 10, "normal", 1).size).toBe(0);
    expect(distributeKillXp([{ username: "a", level: 1 }], 1, "normal", 0).size).toBe(0);
  });
});

describe("corpse loot", () => {
  const items = [
    { index: 0, itemName: "wolf_pelt", quantity: 1, quality: "common", iconUrl: "" },
    { index: 1, itemName: "wolf_fang", quantity: 2, quality: "uncommon", iconUrl: "" },
  ];

  test("copper splits evenly with the remainder to the looter", () => {
    expect([...splitCopper(10, ["a", "b", "c"], "b")]).toEqual([["a", 3], ["b", 4], ["c", 3]]);
    expect([...splitCopper(1, ["a", "b"], "a")]).toEqual([["a", 1]]);
    expect(splitCopper(0, ["a"], "a").size).toBe(0);
    expect([...splitCopper(7, [], "solo")]).toEqual([["solo", 7]]);
  });

  test("nothing to drop creates no corpse loot", () => {
    const store = new CorpseLootStore();
    expect(store.create(1, [], 0, ["a"], ["a"])).toBeNull();
    expect(store.has(1)).toBe(false);
  });

  test("only owners can loot; partial takes keep the rest; money is paid once", () => {
    const store = new CorpseLootStore();
    store.create(1, items.map((i) => ({ ...i })), 25, ["Owner"], ["owner", "friend"]);
    expect(store.canLoot(1, "friend")).toBe(false);
    expect(store.take(1, "friend", null)).toBeNull();

    const first = store.take(1, "OWNER", [1])!;
    expect(first.taken.map((i) => i.itemName)).toEqual(["wolf_fang"]);
    expect([...first.copper]).toEqual([["owner", 13], ["friend", 12]]);
    expect(first.empty).toBe(false);
    expect(store.remaining(1).map((i) => i.index)).toEqual([0]);

    const second = store.take(1, "owner", null)!;
    expect(second.taken.map((i) => i.itemName)).toEqual(["wolf_pelt"]);
    expect(second.copper.size).toBe(0);
    expect(second.empty).toBe(true);
    expect(store.has(1)).toBe(false);
  });

  test("money-only corpses empty on first take", () => {
    const store = new CorpseLootStore();
    store.create(2, [], 50, ["solo"], ["solo"]);
    const result = store.take(2, "solo", null)!;
    expect([...result.copper]).toEqual([["solo", 50]]);
    expect(result.empty).toBe(true);
  });

  test("round robin rotates through the group; solo always owns", () => {
    const store = new CorpseLootStore();
    expect(store.pickOwner(null, ["solo"])).toBe("solo");
    const names = ["carl", "anna", "bob"];
    const owners = [0, 1, 2, 3].map(() => store.pickOwner("party:7", names));
    expect(owners).toEqual(["anna", "bob", "carl", "anna"]);
    expect(store.pickOwner("party:8", [])).toBeNull();
  });
});
