import { describe, expect, mock, test } from "bun:test";

const quest: Quest = {
  id: 1, name: "Rats", zone: null, offer_text: "", description: "", progress_text: "", completion_text: "",
  required_level: 1, quest_level: 1, xp_reward: 50, copper_reward: 100,
  repeatable: "none", next_quest_id: null, sort_order: 0,
  objectives: [],
  rewards: [
    { id: 1, quest_id: 1, item_name: "Bread", quantity: 2, is_choice: false, sort_order: 0 },
    { id: 2, quest_id: 1, item_name: "Sword", quantity: 1, is_choice: true, sort_order: 0 },
    { id: 3, quest_id: 1, item_name: "Shield", quantity: 1, is_choice: true, sort_order: 1 },
  ],
  prerequisites: [],
};

let inventoryCalls: Array<{ name: string; quantity: number }>;
let xpCalls: Array<{ username: string; xp: number }>;
let currencyCalls: Array<{ username: string; amount: any }>;
let inventoryState: Array<{ item: string; quantity: number }>;

function resetAll() {
  inventoryCalls = [];
  xpCalls = [];
  currencyCalls = [];
  // 25 slots, all occupied: bag-full scenario can be built by filling these.
  inventoryState = [];
}

resetAll();

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, _params: any[] = []) => {
    if (sql.includes("SELECT * FROM bags")) return [];
    if (sql.includes("SELECT item FROM inventory")) {
      return inventoryState.map((r) => ({ item: r.item }));
    }
    if (sql.includes("SELECT level FROM stats")) return [{ level: 5 }];
    if (sql.includes("SELECT max_health")) {
      return [{ max_health: 100, health: 100, max_stamina: 100, stamina: 100, xp: 0, max_xp: 100, level: 1 }];
    }
    if (sql.includes("SELECT copper, silver, gold FROM currency")) {
      return [{ copper: 0, silver: 0, gold: 0 }];
    }
    return { affectedRows: 1 };
  },
}));

mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => {
      if (key === "items") return [{ name: "Bread" }, { name: "Sword" }, { name: "Shield" }];
      return null;
    },
    set: async (_key: string, _value: any) => {},
    add: async (_key: string, _value: any) => {},
  },
}));

const players = new Map<string, any>();
mock.module("../services/playermanager", () => ({
  default: {
    list: () => Object.fromEntries(players),
    get: (id: string) => players.get(id),
    set: (id: string, value: any) => players.set(id, value),
    add: (id: string, value: any) => players.set(id, value),
    remove: (id: string) => players.delete(id),
    clear: () => players.clear(),
    addNested: (id: string, nestedKey: string, value: any) => players.set(id, { ...(players.get(id) || {}), [nestedKey]: value }),
    setNested: (id: string, nestedKey: string, value: any) => players.set(id, { ...(players.get(id) || {}), [nestedKey]: value }),
  },
}));

// Observe grants through the real inventory/currency/player modules by spying
// on the query layer is awkward, so spy one level up via module mocks that
// still exercise rewards.ts validation and precheck logic.
mock.module("../systems/inventory", () => ({
  default: {
    find: async () => [],
    get: async () => [],
    add: async (name: string, item: any) => {
      inventoryCalls.push({ name, quantity: item.quantity });
      return { affectedRows: 1 };
    },
    remove: async () => {},
  },
}));

mock.module("../systems/currency", () => ({
  default: {
    get: async () => ({ copper: 0, silver: 0, gold: 0 }),
    add: async (username: string, amount: any) => {
      currencyCalls.push({ username, amount });
      return { copper: 0, silver: 0, gold: 0 };
    },
  },
}));

mock.module("../systems/player", () => ({
  default: {
    increaseXp: async (username: string, xp: number) => {
      xpCalls.push({ username, xp });
      return { xp, level: 1, max_xp: 100 };
    },
    synchronizeStats: async () => null,
  },
}));

const rewards = await import("../systems/quests/rewards");

describe("quest rewards", () => {
  test("choice validation requires an index only when choices exist", () => {
    expect(rewards.validateChoice(quest, 0)).toBe(true);
    expect(rewards.validateChoice(quest, 1)).toBe(true);
    expect(rewards.validateChoice(quest, 2)).toBe(false);
    expect(rewards.validateChoice(quest, undefined)).toBe(false);
    const noChoice = { ...quest, rewards: quest.rewards.filter((r) => !r.is_choice) };
    expect(rewards.validateChoice(noChoice, undefined)).toBe(true);
  });

  test("grant gives guaranteed plus the chosen item, xp and copper", async () => {
    resetAll();
    const result = await rewards.grant("hero", quest, 1);
    expect(result.ok).toBe(true);
    expect(result.items).toEqual([
      { name: "Bread", quantity: 2 },
      { name: "Shield", quantity: 1 },
    ]);
    expect(inventoryCalls).toHaveLength(2);
    expect(xpCalls).toEqual([{ username: "hero", xp: 50 }]);
    expect(currencyCalls).toHaveLength(1);
    expect(currencyCalls[0]!.amount.copper).toBe(100);
  });

  test("bag-full refusal grants nothing", async () => {
    resetAll();
    // Fill every one of the 25 base slots with unrelated items.
    inventoryState = Array.from({ length: 25 }, (_, i) => ({ item: `Junk${i}`, quantity: 1 }));
    const result = await rewards.grant("hero", quest, 0);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bag_full");
    expect(inventoryCalls).toHaveLength(0);
    expect(xpCalls).toHaveLength(0);
    expect(currencyCalls).toHaveLength(0);
  });

  test("stacking onto an owned item needs no free slot", async () => {
    resetAll();
    inventoryState = [
      ...Array.from({ length: 24 }, (_, i) => ({ item: `Junk${i}`, quantity: 1 })),
      { item: "Bread", quantity: 1 },
    ];
    // Sword is new (1 slot: 24 junk + bread = 25 owned, +1 = 26 > 25) so this
    // particular grant does not fit; shrink to a fitting case instead.
    const fitting: Quest = { ...quest, rewards: [{ id: 9, quest_id: 1, item_name: "Bread", quantity: 1, is_choice: false, sort_order: 0 }] };
    const result = await rewards.grant("hero", fitting, undefined);
    expect(result.ok).toBe(true);
    expect(inventoryCalls).toHaveLength(1);
  });
});
