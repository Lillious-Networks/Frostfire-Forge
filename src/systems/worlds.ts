import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import assetCache from "../services/assetCache";

// The worlds a WHERE on a name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: string, b: string) =>
  (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

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

/**
 * A statement that changes the worlds table, then `change` made to the worlds
 * held. A statement that throws may still have been applied (a timeout, say),
 * so the table is read again rather than the list left as it was. Either way
 * the player counts, which only the list holds, are kept.
 */
async function write(sql: string, values: any[], change: (list: WorldData[]) => WorldData[]): Promise<void> {
  try {
    await query(sql, values);
  } catch (error) {
    try {
      const rows = await worlds.list();
      await withWorldsLock(async () => {
        const counts = await readWorldsCache();
        const read = rows.map((row) => ({ ...row, players: counts.find((w) => w.name === row.name)?.players || 0 }));
        await assetCache.set("worlds", JSON.stringify(read));
      });
    } catch (again) {
      log.error(`Could not read the worlds again after a write that failed: ${again}`);
    }
    throw error;
  }
  await withWorldsLock(async () => {
    await assetCache.set("worlds", JSON.stringify(change(await readWorldsCache())));
  });
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
    // The list is held as text once a player count has been written to it.
    const worlds = await readWorldsCache();
    return worlds.find((w) => w.name === world);
  },
  async getCurrentWeather(world: string) {
    const worldData = await this.get(world);
    return worldData?.weather || "clear";
  },
  async add(world: WorldData) {
    await write("INSERT INTO worlds (name, weather) VALUES (?, ?)", [world.name, world.weather],
      (list) => [...list, { name: world.name, weather: world.weather, players: 0 }]);
  },
  async remove(world: WorldData) {
    await write("DELETE FROM worlds WHERE name = ?", [world.name], (list) => list.filter((w) => !sameName(w.name, world.name)));
  },
  async update(world: WorldData) {
    await write("UPDATE worlds SET name = ?, weather = ? WHERE name = ?", [world.name, world.weather, world.name],
      // Preserve existing player counts instead of resetting them to zero
      (list) => list.map((w) => (sameName(w.name, world.name) ? { ...w, name: world.name, weather: world.weather, players: w.players || 0 } : w)));
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
