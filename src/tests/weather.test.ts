import { expect, test } from "bun:test";
import { mockAssetCache } from "./setup";

// Mock database
const weatherDatabase: Record<string, any> = {
  clear: {
    name: "clear",
    temperature: 20,
    humidity: 50,
    wind_speed: 5,
    wind_direction: "N",
    precipitation: 0,
    ambience: "peaceful",
  },
  rainy: {
    name: "rainy",
    temperature: 15,
    humidity: 90,
    wind_speed: 10,
    wind_direction: "W",
    precipitation: 100,
    ambience: "stormy",
  },
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("INSERT INTO weather")) {
    const [name] = params;
    weatherDatabase[name] = { name, ...params };
    return { affectedRows: 1 };
  }
  if (sql.includes("DELETE FROM weather")) {
    const [name] = params;
    if (weatherDatabase[name]) {
      delete weatherDatabase[name];
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("UPDATE weather")) {
    const name = params[params.length - 1];
    weatherDatabase[name] = { name, ...params };
    return { affectedRows: 1 };
  }
  if (sql.includes("SELECT * FROM weather")) {
    return Object.values(weatherDatabase);
  }
  return [];
};

const weather = {
  async add(weatherData: any) {
    if (!weatherData?.name) return;
    const response = await mockQuery("INSERT INTO weather (name) VALUES (?)", [weatherData.name]);
    await mockAssetCache.set("weather", response);
    return response;
  },

  async remove(weatherData: any) {
    if (!weatherData?.name) return;
    const response = await mockQuery("DELETE FROM weather WHERE name = ?", [weatherData.name]);
    await mockAssetCache.set("weather", response);
    return response;
  },

  async find(weatherData: any) {
    if (!weatherData?.name) return;
    const weathers = (await mockAssetCache.get("weather")) as any[];
    return weathers.find((w) => w.name === weatherData.name);
  },

  async update(weatherData: any) {
    if (!weatherData?.name) return;
    const response = await mockQuery("UPDATE weather SET name = ? WHERE name = ?", [weatherData.name, weatherData.name]);
    await mockAssetCache.set("weather", response);
    return response;
  },

  async list() {
    return await mockQuery("SELECT * FROM weather", []);
  },
};

test("weather.list returns all weather types", async () => {
  const result = (await weather.list()) as any[];
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThan(0);
});

test("weather.find returns weather by name", async () => {
  const result = await weather.find({ name: "clear" });
  expect(result?.name).toBe("clear");
  expect(result?.temperature).toBe(20);
});

test("weather.find returns undefined for non-existent weather", async () => {
  const result = await weather.find({ name: "nonexistent" });
  expect(result).toBeUndefined();
});

test("weather.add requires name", async () => {
  const result = await weather.add({ temperature: 25 });
  expect(result).toBeUndefined();
});

test("weather.add creates weather entry", async () => {
  const weatherData = { name: "snow", temperature: 0 };
  const result = await weather.add(weatherData);
  expect(result).toBeDefined();
});

test("weather.remove deletes weather", async () => {
  const weatherData = { name: "rainy" };
  await weather.remove(weatherData);
  const result = await weather.find(weatherData);
  expect(result).toBeUndefined();
});

test("weather.update modifies weather", async () => {
  const weatherData = { name: "clear", temperature: 25 };
  await weather.update(weatherData);
  expect((await weather.update(weatherData))).toBeDefined();
});
