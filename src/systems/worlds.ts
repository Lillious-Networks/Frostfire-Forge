import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

let worldsCountMutex: Promise<void> = Promise.resolve();

async function readWorldsCache(): Promise<WorldData[]> {
  const cached = await assetCache.get("worlds");
  if (Array.isArray(cached)) return cached;
  if (typeof cached === "string" && cached.length > 0) return JSON.parse(cached);
  return [];
}

function withWorldsLock<T>(action: () => Promise<T>): Promise<T> {
  const result = worldsCountMutex.then(action);
  worldsCountMutex = result.then(() => undefined, () => undefined);
  return result;
}

async function getRedisClient(): Promise<any | null> {
  try {
    const mod = await import("bun");
    return (mod as any).redis;
  } catch {
    return null;
  }
}

const worlds = {
  async list() {
    const results = await query("SELECT * FROM worlds") as WorldData[];
    const worlds = results.map(world => {
      const players = 0;
      return { ...world, players };
    });
    return worlds;
  },
  async get(world: string) {
    const worlds = await assetCache.get("worlds") as WorldData[];
    return worlds.find((w) => w.name === world);
  },
  async getCurrentWeather(world: string) {
    const worldData = await this.get(world);
    return worldData?.weather || "clear";
  },
  async add(world: WorldData) {
    await query("INSERT INTO worlds (name, weather) VALUES (?, ?)", [world.name, world.weather]);
  },
  async remove(world: WorldData) {
    await query("DELETE FROM worlds WHERE name = ?", [world.name]);
  },
  async update(world: WorldData) {
    await query("UPDATE worlds SET name = ?, weather = ? WHERE name = ?", [world.name, world.weather, world.name]);

    // Preserve existing player counts instead of resetting them to zero
    await withWorldsLock(async () => {
      const worldsList = await readWorldsCache();
      const updatedWorlds = worldsList.map((w) =>
        w.name === world.name
          ? { ...w, name: world.name, weather: world.weather, players: w.players || 0 }
          : w
      );
      await assetCache.set("worlds", JSON.stringify(updatedWorlds));
    });
  },
  async adjustPlayerCount(mapName: string, delta: number): Promise<number | null> {
    return withWorldsLock(async () => {
      const worldsList = await readWorldsCache();
      const worldName = mapName.replace(".json", "");
      const world = worldsList.find((w) => w.name === worldName);
      if (!world) return null;

      // Use Redis HINCRBY for atomic cross-process counter updates. The Redis
      // client is shared via the `bun.redis` singleton, so the async client
      // assignment in RedisCacheService is not a problem here.
      const redisClient = await getRedisClient();
      if (redisClient) {
        try {
          const redisKey = "world:player_counts";
          let newCount = Number(await redisClient.send("HINCRBY", [redisKey, worldName, String(delta)]));
          // Ensure non-negative
          if (newCount < 0) {
            await redisClient.send("HSET", [redisKey, worldName, "0"]);
            newCount = 0;
          }
          world.players = newCount;
          await assetCache.set("worlds", JSON.stringify(worldsList));
          return newCount;
        } catch (e) {
          // Fallback to the in-process update if the Redis operation fails
        }
      }

      // Fallback: non-atomic update
      world.players = Math.max(0, (world.players || 0) + delta);
      await assetCache.set("worlds", JSON.stringify(worldsList));
      return world.players;
    });
  },
};

export default worlds;
