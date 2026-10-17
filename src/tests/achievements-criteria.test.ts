import { describe, expect, test } from "bun:test";
import { COUNTED_EVENTS, deedsOf, matches, progressAfter } from "../systems/achievements/criteria";
import { CRITERIA, CRITERION_TYPES, isCriterion, type AchievementDef, type CriterionType } from "../systems/achievements/types";
import { Events } from "../systems/events";

const def = (over: Partial<AchievementDef> = {}): AchievementDef => ({
  id: 1, name: "Test", description: "", icon: null, type: "creature_kill", target: null, count: 10,
  reward_item: null, reward_quantity: 1, reward_mount: null, enabled: true, ...over,
});
const alice = { id: "p1", username: "Alice" };
const bob = { id: "p2", username: "bob" };
type Expected = Array<[string, CriterionType, string | number | null, number]>;

describe("deedsOf", () => {
  const cases: Array<[string, string, any, Expected]> = [
    ["a kill credit", Events.CREATURE_KILL_CREDIT, { player: alice, templateId: 7 }, [["Alice", "creature_kill", 7, 1]]],
    ["a death to a creature", Events.PLAYER_DEATH, { player: alice, killer: { id: "creature:3", username: "Wolf", isCreature: true } }, [["Alice", "death", null, 1]]],
    ["a death to a player", Events.PLAYER_DEATH, { player: alice, killer: bob }, [["Alice", "death", null, 1], ["bob", "pvp_kill", null, 1]]],
    ["a death to the tornado", Events.PLAYER_DEATH, { player: alice, killer: { id: "tornado", username: "Tornado", isCreature: true } }, [["Alice", "death", null, 1]]],
    ["a death by one's own hand", Events.PLAYER_DEATH, { player: alice, killer: { ...alice } }, [["Alice", "death", null, 1]]],
    ["a quest turned in", Events.QUEST_COMPLETED, { username: "alice", questId: "12", rewards: {} }, [["alice", "quest_complete", 12, 1]]],
    ["a level reached", Events.PLAYER_LEVEL_UP, { player: alice, level: 9 }, [["Alice", "level", null, 9]]],
    ["a gather", Events.GATHER_COMPLETED, { player: alice, item: "Copper Ore", quantity: 3 }, [["Alice", "gather", "Copper Ore", 3]]],
    ["loot taken", Events.PLAYER_LOOT_RETRIEVED, { player: alice, itemName: "Wolf Pelt", quantity: 2, mapName: "forest", x: 0, y: 0 }, [["Alice", "loot", "Wolf Pelt", 2]]],
    ["a mount collected", Events.COLLECTABLE_ADDED, { username: "alice", type: "mount", item: "Unicorn" }, [["alice", "collectable", "Unicorn", 1]]],
    ["a map entered", Events.MAP_ENTER, { player: alice, mapName: "forest.json", position: { x: 0, y: 0 } }, [["Alice", "map_visit", "forest", 1]]],
    ["a spell cast", Events.SPELL_CAST, { player: alice, spellName: "frost_bolt", target: null, isEntityTarget: false }, [["Alice", "spell_cast", "frost_bolt", 1]]],
    ["a trade", Events.TRADE_COMPLETED, { trade: { id: 1, player_a: "alice", player_b: "bob" } }, [["alice", "trade", null, 1], ["bob", "trade", null, 1]]],
    ["a friend added (counts for both)", Events.FRIEND_ADDED, { type: "add", playerUsername: "alice", friendUsername: "bob" }, [["alice", "friend_add", null, 1], ["bob", "friend_add", null, 1]]],
    ["a friend added with one name missing", Events.FRIEND_ADDED, { type: "add", playerUsername: "alice", friendUsername: "  " }, [["alice", "friend_add", null, 1]]],
    ["a friend added by a name that is the player's own", Events.FRIEND_ADDED, { type: "add", playerUsername: "alice", friendUsername: "ALICE" }, [["alice", "friend_add", null, 1]]],
    ["a guild joined", Events.GUILD_CHANGED, { type: "join", guildId: 1, guildName: "G", playerUsername: "alice" }, [["alice", "guild_join", null, 1]]],
    ["a guild made", Events.GUILD_CHANGED, { type: "create", guildId: 1, guildName: "G", playerUsername: "alice" }, [["alice", "guild_join", null, 1]]],
    ["a guild left", Events.GUILD_CHANGED, { type: "leave", guildId: 1, guildName: "G", playerUsername: "alice" }, []],
    ["a mount ridden", Events.PLAYER_MOUNT, { player: alice, mounted: true, mountType: "unicorn" }, [["Alice", "mount_ride", "unicorn", 1]]],
    ["a dismount", Events.PLAYER_MOUNT, { player: alice, mounted: false, mountType: null }, []],
    ["an event nothing counts", Events.PLAYER_CHAT, { player: alice, message: "hi", mapName: "forest" }, []],
  ];
  for (const [what, event, payload, expected] of cases) {
    test(`reads ${what}`, () => {
      expect(deedsOf(event, payload)).toEqual(expected.map(([username, type, target, amount]) => ({ username, type, target, amount })));
    });
  }

  test("loot and gathers without a quantity count one", () => {
    expect(deedsOf(Events.PLAYER_LOOT_RETRIEVED, { player: alice, itemName: "Wolf Pelt" })[0]!.amount).toBe(1);
    expect(deedsOf(Events.GATHER_COMPLETED, { player: alice, item: "Copper Ore" })[0]!.amount).toBe(1);
  });

  test("a collectable that is not a mount gives no deed", () => {
    expect(deedsOf(Events.COLLECTABLE_ADDED, { username: "alice", type: "pet", item: "Cat" })).toEqual([]);
    expect(deedsOf(Events.COLLECTABLE_ADDED, { username: "alice", type: "MOUNT", item: "Unicorn" })).toHaveLength(1);
  });

  test("a kill credit without a usable template id gives no deed", () => {
    expect(deedsOf(Events.CREATURE_KILL_CREDIT, { player: alice, templateId: "wolf" })).toEqual([]);
    expect(deedsOf(Events.CREATURE_KILL_CREDIT, { player: alice })).toEqual([]);
  });

  test("a gather or loot without an item name gives no deed", () => {
    expect(deedsOf(Events.GATHER_COMPLETED, { player: alice, item: "", quantity: 2 })).toEqual([]);
    expect(deedsOf(Events.GATHER_COMPLETED, { player: alice, quantity: 2 })).toEqual([]);
    expect(deedsOf(Events.PLAYER_LOOT_RETRIEVED, { player: alice, itemName: "  ", quantity: 2 })).toEqual([]);
    expect(deedsOf(Events.PLAYER_LOOT_RETRIEVED, { player: alice, quantity: 2 })).toEqual([]);
  });

  test("a deed without a player, or of nothing, is dropped", () => {
    expect(deedsOf(Events.CREATURE_KILL_CREDIT, { templateId: 3 })).toEqual([]);
    expect(deedsOf(Events.GATHER_COMPLETED, { player: alice, item: "Copper Ore", quantity: 0 })).toEqual([]);
    expect(deedsOf(Events.QUEST_COMPLETED, null)).toEqual([]);
  });
});

describe("matches", () => {
  const deed = (type: any, target: string | number | null) => ({ username: "alice", type, target, amount: 1 });

  test("no target counts every target of its type", () => {
    expect(matches(def({ target: null }), deed("creature_kill", 7))).toBe(true);
  });

  test("a creature target is an id, compared as a number", () => {
    expect(matches(def({ target: "7" }), deed("creature_kill", 7))).toBe(true);
    expect(matches(def({ target: "7" }), deed("creature_kill", 8))).toBe(false);
  });

  test("names are compared without regard to case", () => {
    expect(matches(def({ type: "gather", target: "copper ore" }), deed("gather", "Copper Ore"))).toBe(true);
    expect(matches(def({ type: "spell_cast", target: "Frost_Bolt" }), deed("spell_cast", "frost_bolt"))).toBe(true);
  });

  test("a map target is the same with or without .json", () => {
    expect(matches(def({ type: "map_visit", target: "Forest.json" }), deed("map_visit", "forest"))).toBe(true);
  });

  test("another type never matches", () => {
    expect(matches(def({ type: "loot" }), deed("gather", "Copper Ore"))).toBe(false);
  });

  test("a map visit needs its map", () => {
    expect(matches(def({ type: "map_visit", target: null }), deed("map_visit", "forest"))).toBe(false);
  });

  test("a type without a target counts whatever it is given", () => {
    expect(matches(def({ type: "trade", target: "something" }), deed("trade", null))).toBe(true);
    expect(matches(def({ type: "mount_ride", target: "unicorn" }), deed("mount_ride", null))).toBe(false);
  });
});

describe("progressAfter", () => {
  test("adds what the deed is worth", () => {
    expect(progressAfter(def({ type: "loot" }), 4, { username: "a", type: "loot", target: "x", amount: 3 })).toBe(7);
  });

  test("a level keeps the highest level reached", () => {
    const level = def({ type: "level", count: 20 });
    expect(progressAfter(level, 5, { username: "a", type: "level", target: null, amount: 3 })).toBe(5);
    expect(progressAfter(level, 5, { username: "a", type: "level", target: null, amount: 8 })).toBe(8);
  });
});

describe("the criteria", () => {
  test("every type is listed once, with its rule", () => {
    expect(CRITERION_TYPES).toHaveLength(14);
    expect(CRITERION_TYPES.every(isCriterion)).toBe(true);
    expect(isCriterion("dance")).toBe(false);
    expect(CRITERIA.map_visit).toEqual({ label: "Visit a map", target: "required", pick: "maps" });
  });

  test("every event a deed is read from is listened to", () => {
    for (const event of [
      Events.CREATURE_KILL_CREDIT, Events.PLAYER_DEATH, Events.QUEST_COMPLETED, Events.PLAYER_LEVEL_UP, Events.GATHER_COMPLETED,
      Events.PLAYER_LOOT_RETRIEVED, Events.COLLECTABLE_ADDED, Events.MAP_ENTER, Events.SPELL_CAST, Events.TRADE_COMPLETED,
      Events.FRIEND_ADDED, Events.GUILD_CHANGED, Events.PLAYER_MOUNT,
    ]) expect(COUNTED_EVENTS).toContain(event);
    expect(COUNTED_EVENTS).toHaveLength(13);
  });
});
