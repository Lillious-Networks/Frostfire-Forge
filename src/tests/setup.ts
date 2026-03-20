/**
 * Mock setup utilities for system testing
 * Provides mock implementations of common dependencies for Bun test framework
 */

// Mock query function for database operations
export const mockQuery = async (sql: string, params?: any[]) => {
  return [];
};

// Mock assetCache
export const mockAssetCache = {
  get: async (key: string) => {
    const mockData: Record<string, any> = {
      items: [
        { name: "test_item", quality: "common", description: "A test item", type: "equipment", equipable: true, level_requirement: 1 },
      ],
      audio: [{ name: "test_audio" }],
      mounts: [{ name: "test_mount", description: "A test mount" }],
      spells: [{ name: "test_spell", id: 1, damage: 10, mana: 5 }],
      quests: [{ id: 1, name: "test_quest", description: "A test quest", reward: 100, xp_gain: 50, required_quest: 0, required_level: 1 }],
      weather: [{ name: "clear", temperature: 20, humidity: 50, wind_speed: 0, wind_direction: "N", precipitation: 0, ambience: "clear" }],
      worlds: [{ name: "test_world", weather: "clear", max_players: 100, default_map: "main" }],
      mapProperties: [{ name: "main", warps: [], tileWidth: 32, tileHeight: 32 }],
      particles: [{ name: "test_particle" }],
      npcs: [{ id: 1, map: "main", position: { x: 100, y: 100 } }],
    };
    return mockData[key] || [];
  },
  set: async (key: string, value: any) => {},
  getNested: async (key: string, nestedKey: string) => {
    return [512, 512, 0, 262144]; // Mock RLE collision data
  },
  add: async (key: string, value: any) => {},
};

// Mock logger
export const mockLog = {
  error: (msg: string) => console.error(msg),
  warn: (msg: string) => console.warn(msg),
  info: (msg: string) => console.log(msg),
  debug: (msg: string) => console.log(msg),
  success: (msg: string) => console.log(msg),
};

// Mock player cache
export const mockPlayerCache = {
  get: (playerId: string) => ({
    id: playerId,
    username: "test_player",
    level: 1,
    experience: 0,
  }),
  set: (playerId: string, data: any) => {},
  has: (playerId: string) => true,
  delete: (playerId: string) => {},
};

/**
 * Helper to create a mock query result
 */
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

/**
 * Helper to create mock currency data
 */
export function createMockCurrency(copper = 0, silver = 0, gold = 0) {
  return { copper, silver, gold };
}

/**
 * Helper to create mock item
 */
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

/**
 * Helper to create mock collectable
 */
export function createMockCollectable(overrides: any = {}) {
  return {
    username: "test_user",
    item: "test_item",
    type: "rare_item",
    ...overrides,
  };
}
