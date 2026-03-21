import { expect, test } from "bun:test";
import { mockAssetCache } from "./setup";

const worldsDatabase: Record<string, any> = {
  main: { name: "main", weather: "clear", max_players: 100, default_map: "main" },
  dungeon: { name: "dungeon", weather: "dark", max_players: 50, default_map: "dungeon_1" },
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT * FROM worlds")) {
    return Object.values(worldsDatabase).map((world) => ({ ...world, players: 0 }));
  }
  if (sql.includes("INSERT INTO worlds")) {
    const [name, weather, maxPlayers, defaultMap] = params;
    worldsDatabase[name] = { name, weather, max_players: maxPlayers, default_map: defaultMap };
    return { affectedRows: 1 };
  }
  if (sql.includes("DELETE FROM worlds")) {
    const [name] = params;
    if (worldsDatabase[name]) {
      delete worldsDatabase[name];
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("UPDATE worlds")) {
    const [name, weather, maxPlayers, defaultMap, updateName] = params;
    if (worldsDatabase[updateName]) {
      delete worldsDatabase[updateName];
      worldsDatabase[name] = { name, weather, max_players: maxPlayers, default_map: defaultMap };
    }
    return { affectedRows: 1 };
  }
  return [];
};

const worlds = {
  async list() {
    const results = (await mockQuery("SELECT * FROM worlds", [])) as any[];
    const worldsList = results.map((world) => {
      const players = 0;
      return { ...world, players };
    });
    return worldsList;
  },

  async get(world: string) {
    const worldsList = (await mockAssetCache.get("worlds")) as any[];
    return worldsList.find((w) => w.name === world);
  },

  async getCurrentWeather(world: string) {
    const worldData = await this.get(world);
    return worldData?.weather || "clear";
  },

  async getMaxPlayers(world: string) {
    const worldData = await this.get(world);
    return worldData?.max_players || 100;
  },

  async add(world: any) {
    await mockQuery("INSERT INTO worlds (name, weather, max_players, default_map) VALUES (?, ?, ?, ?)", [
      world.name,
      world.weather,
      world.max_players,
      world.default_map,
    ]);
  },

  async remove(world: any) {
    await mockQuery("DELETE FROM worlds WHERE name = ?", [world.name]);
  },

  async update(world: any) {
    await mockQuery("UPDATE worlds SET name = ?, weather = ?, max_players = ?, default_map = ? WHERE name = ?", [
      world.name,
      world.weather,
      world.max_players,
      world.default_map,
      world.name,
    ]);
  },
};

test("worlds.list returns all worlds", async () => {
  const result = await worlds.list();
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThan(0);
});

test("worlds.list includes players property", async () => {
  const result = await worlds.list();
  expect(result[0]?.players).toBeDefined();
});

test("worlds.get returns world by name", async () => {
  const result = await worlds.get("test_world");
  expect(result?.name).toBe("test_world");
});

test("worlds.get returns undefined for non-existent world", async () => {
  const result = await worlds.get("nonexistent");
  expect(result).toBeUndefined();
});

test("worlds.getCurrentWeather returns weather for world", async () => {
  const result = await worlds.getCurrentWeather("test_world");
  expect(result).toBe("clear");
});

test("worlds.getCurrentWeather returns default if world not found", async () => {
  const result = await worlds.getCurrentWeather("nonexistent");
  expect(result).toBe("clear");
});

test("worlds.getMaxPlayers returns max players for world", async () => {
  const result = await worlds.getMaxPlayers("test_world");
  expect(result).toBe(100);
});

test("worlds.getMaxPlayers returns default if world not found", async () => {
  const result = await worlds.getMaxPlayers("nonexistent");
  expect(result).toBe(100);
});

test("worlds.add creates new world", async () => {
  const world = { name: "newworld", weather: "clear", max_players: 150, default_map: "new_main" };
  await worlds.add(world);
  expect(worldsDatabase["newworld"]).toBeDefined();
});

test("worlds.remove deletes world", async () => {
  const world = { name: "dungeon" };
  await worlds.remove(world);
  expect(worldsDatabase["dungeon"]).toBeUndefined();
});
