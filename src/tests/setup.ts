

export const mockQuery = async (_sql: string, _params?: any[]) => {
  return [];
};

export const mockAssetCache = {
  get: async (key: string) => {
    const mockData: Record<string, any> = {
      items: [
        { name: "test_item", quality: "common", description: "A test item", type: "equipment", equipable: true, level_requirement: 1 },
      ],
      audio: [{ name: "test_audio" }],
      mounts: [{ name: "test_mount", description: "A test mount" }],
      spells: [{ name: "test_spell", id: 1, damage: 10, mana: 5 }],
      quests: [{ id: 1, name: "test_quest", zone: null, offer_text: "", description: "A test quest", progress_text: "", completion_text: "", required_level: 1, quest_level: 1, xp_reward: 50, copper_reward: 0, repeatable: "none", next_quest_id: null, sort_order: 0, objectives: [], rewards: [], prerequisites: [] }],
      weather: [{ name: "clear", temperature: 20, humidity: 50, wind_speed: 0, wind_direction: "N", precipitation: 0, ambience: "clear" }],
      worlds: [{ name: "test_world", weather: "clear" }],
      mapProperties: [{ name: "main", warps: [], tileWidth: 32, tileHeight: 32 }],
      particles: [{ name: "test_particle" }],
      npcs: [{ id: 1, map: "main", position: { x: 100, y: 100 } }],
    };
    return mockData[key] || [];
  },
  set: async (_key: string, _value: any) => {},
  getNested: async (_key: string, _nestedKey: string) => {
    return [512, 512, 0, 262144];
  },
  add: async (_key: string, _value: any) => {},
};

export const mockLog = {
  error: (msg: string) => console.error(msg),
  warn: (msg: string) => console.warn(msg),
  info: (msg: string) => console.log(msg),
  debug: (msg: string) => console.log(msg),
  success: (msg: string) => console.log(msg),
};

export const mockPlayerCache = {
  get: (playerId: string) => ({
    id: playerId,
    username: "test_player",
    level: 1,
    experience: 0,
  }),
  set: (_playerId: string, _data: any) => {},
  has: (_playerId: string) => true,
  delete: (_playerId: string) => {},
};

export function createMockQueryResult(data: any[] = [], affectedRows = 1, lastInsertRowid = 1) {
  return {
    ...data,
    affectedRows,
    lastInsertRowid,
    length: data.length,
    [Symbol.iterator]: function* () {
      yield* data;
    },
  };
}

export function createMockCurrency(copper = 0, silver = 0, gold = 0) {
  return { copper, silver, gold };
}

export function createMockItem(overrides: any = {}) {
  return {
    name: "test_item",
    quality: "common",
    description: "A test item",
    type: "equipment",
    level_requirement: 1,
    equipable: true,
    icon: null,
    stat_armor: 0,
    stat_damage: 0,
    stat_critical_chance: 0,
    stat_critical_damage: 0,
    stat_health: 0,
    stat_stamina: 0,
    stat_avoidance: 0,
    equipment_slot: "helmet",
    ...overrides,
  };
}

export function createMockCollectable(overrides: any = {}) {
  return {
    username: "test_user",
    item: "test_item",
    type: "rare_item",
    ...overrides,
  };
}
