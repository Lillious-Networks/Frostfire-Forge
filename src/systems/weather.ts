import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import assetCache from "../services/assetCache";

// The weathers a WHERE on a name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: string, b: string) =>
  (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

/** The weathers held: every row of the table, read at startup and kept in step by each write of it. */
async function held(): Promise<WeatherData[]> {
  return ((await assetCache.get("weather")) || []) as WeatherData[];
}

/** A weather as its row keeps it: the columns a statement here writes. */
const rowOf = (weather: WeatherData): WeatherData => ({
  name: weather.name, temperature: weather.temperature, humidity: weather.humidity, wind_speed: weather.wind_speed,
  wind_direction: weather.wind_direction, precipitation: weather.precipitation, ambience: weather.ambience,
});

/**
 * A statement that changes the weather table, then `change` made to the list
 * held: the same list, so whoever was handed it at startup sees the change.
 * A statement that throws may still have been applied (a timeout, say), so
 * the table is read again rather than the list left as it was.
 */
async function write(sql: string, values: any[], change: (list: WeatherData[]) => WeatherData[]): Promise<any> {
  let response;
  try {
    response = await query(sql, values);
  } catch (error) {
    try {
      await hold((await weather.list()) as WeatherData[]);
    } catch (again) {
      log.error(`Could not read the weather again after a write that failed: ${again}`);
    }
    throw error;
  }
  await hold(change(await held()));
  return response;
}

/** Puts `next` into the list held, in place. */
async function hold(next: WeatherData[]): Promise<void> {
  const list = await held();
  list.splice(0, list.length, ...next);
  await assetCache.set("weather", list);
}

const weather = {
  async add(weather: WeatherData) {
    if (!weather?.name) return;
    return await write(
      "INSERT INTO weather (name, temperature, humidity, wind_speed, wind_direction, precipitation, ambience) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [weather.name, weather.temperature, weather.humidity, weather.wind_speed, weather.wind_direction, weather.precipitation, weather.ambience],
      (list) => [...list, rowOf(weather)]
    );
  },
  async remove(weather: WeatherData) {
    if (!weather?.name) return;
    return await write("DELETE FROM weather WHERE name = ?", [weather.name], (list) => list.filter((w) => !sameName(w.name, weather.name)));
  },
  async find(weather: WeatherData) {
    if (!weather?.name) return;
    const weathers = await assetCache.get("weather") as WeatherData[];
    return weathers.find((w) => w.name === weather.name);
  },
  async update(weather: WeatherData) {
    if (!weather?.name) return;
    return await write(
      "UPDATE weather SET temperature = ?, humidity = ?, wind_speed = ?, wind_direction = ?, precipitation = ?, ambience = ? WHERE name = ?",
      [weather.temperature, weather.humidity, weather.wind_speed, weather.wind_direction, weather.precipitation, weather.ambience, weather.name],
      // The statement changes the rows of that name, but for the name itself, and adds none.
      (list) => list.map((w) => (sameName(w.name, weather.name) ? { ...rowOf(weather), name: w.name } : w))
    );
  },
  async list() {
    return await query("SELECT * FROM weather");
  },
  async random() {
    const weathers = await assetCache.get("weather") as WeatherData[];
    if (!weathers?.length) return null;
    return weathers[Math.floor(Math.random() * weathers.length)];
  }
};

export default weather;
