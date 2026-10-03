import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import log from "../modules/logger";
import weather from "./weather";
import worlds from "./worlds";
import * as settings from "../config/settings.json";
const worldList = await worlds.list();
const world = worldList.find((w) => w.name === settings.world);

const weatherNow = performance.now();
await assetCache.add("weather", await weather.list());
const weathers = await assetCache.get("weather") as WeatherData[];
log.success(`Loaded ${weathers.length} weather(s) from the database in ${(performance.now() - weatherNow).toFixed(2)}ms`);

const resolveWeather = (weatherName: string | undefined) => {
  if (weatherName === "random") {
    return weathers.length ? weathers[Math.floor(Math.random() * weathers.length)] : 'none';
  }
  return weathers.find((w) => w.name === weatherName) || 'none';
};

const particlesNow = performance.now();

/** A comma-separated particle list with one name swapped for another (other names and their order kept). */
export function renameInList(list: string, from: string, to: string): string {
  return list.split(",").map((n) => (n.trim() === from ? to : n.trim())).filter(Boolean).join(",");
}

/** A particle's brightness: 1 when unset (rows saved before the column existed), never negative. */
function brightnessOf(v: unknown): number {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? 1 : Math.max(0, n);
}

const particles = {
  async add(particle: Particle) {
    const response = await query("INSERT INTO particles (size, color, velocity, lifetime, opacity, visible, gravity, name, localposition, `interval`, amount, staggertime, spread, affected_by_weather, zIndex, glow_intensity, glow_radius, static_light, brightness, affected_by_time, time_on, time_off) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [particle.size, particle.color, particle.velocity, particle.lifetime, particle.opacity, particle.visible ? 1 : 0, particle.gravity, particle.name, particle.localposition, particle.interval, particle.amount, particle.staggertime, particle.spread, particle.affected_by_weather ? 1 : 0, particle.zIndex || 0, particle.glow_intensity || 0, particle.glow_radius || 0, particle.static_light ? 1 : 0, brightnessOf(particle.brightness), particle.affected_by_time ? 1 : 0, particle.time_on || null, particle.time_off || null]);
    await assetCache.set("particles", response);
    return response;
  },

  async remove(particle: Particle) {
    const response = await query("DELETE FROM particles WHERE name = ?", [particle.name]);
    await assetCache.set("particles", response);
    return response;
  },

  async update(particle: Particle) {
    const response = await query("UPDATE particles SET size = ?, color = ?, velocity = ?, lifetime = ?, opacity = ?, visible = ?, gravity = ?, name = ?, localposition = ?, `interval` = ?, amount = ?, staggertime = ?, spread = ?, affected_by_weather = ?, zIndex = ?, glow_intensity = ?, glow_radius = ?, static_light = ?, brightness = ?, affected_by_time = ?, time_on = ?, time_off = ? WHERE name = ?", [particle.size, particle.color, particle.velocity, particle.lifetime, particle.opacity, particle.visible ? 1 : 0, particle.gravity, particle.name, particle.localposition, particle.interval, particle.amount, particle.staggertime, particle.spread, particle.affected_by_weather ? 1 : 0, particle.zIndex || 0, particle.glow_intensity || 0, particle.glow_radius || 0, particle.static_light ? 1 : 0, brightnessOf(particle.brightness), particle.affected_by_time ? 1 : 0, particle.time_on || null, particle.time_off || null, particle.name]);
    await assetCache.set("particles", response);
    return response;
  },

  async list() {
    const response = await query("SELECT * FROM particles") as any[];
    const particles: Particle[] = [];

    for (const particle of response) {
      const weather = resolveWeather(world?.weather);
      const p: Particle = {
        name: particle.name,
        size: particle.size,
        color: particle.color,
        lifetime: particle.lifetime,
        opacity: particle.opacity,
        visible: particle.visible === 1,
        gravity: {
          x: Number(particle.gravity?.split(",")[0]) || 0,
          y: Number(particle.gravity?.split(",")[1]) || 0,
        },
        localposition: {
          x: Number(particle.localposition?.split(",")[0]) || 0,
          y: Number(particle.localposition?.split(",")[1]) || 0,
        },
        velocity: {
          x: Number(particle.velocity?.split(",")[0]) || 0,
          y: Number(particle.velocity?.split(",")[1]) || 0,
        },
        interval: particle.interval,
        amount: particle.amount,
        staggertime: particle.staggertime,
        spread: {
          x: Number(particle.spread?.split(",")[0]) || 0,
          y: Number(particle.spread?.split(",")[1]) || 0,
        },
        currentLife: null,
        initialVelocity: null,
        weather: particle.affected_by_weather ? weather : 'none',
        affected_by_weather: particle.affected_by_weather === 1,
        zIndex: particle.zIndex || 0,
        glow_intensity: Number(particle.glow_intensity) || 0,
        glow_radius: Number(particle.glow_radius) || 0,
        static_light: particle.static_light === 1 || particle.static_light === true,
        brightness: brightnessOf(particle.brightness),
        affected_by_time: particle.affected_by_time === 1,
        time_on: particle.time_on || null,
        time_off: particle.time_off || null
      };
      particles.push(p);
    }
    await assetCache.set("particles", particles);
    return particles;
  },

  /**
   * Renames a particle and every reference to it: the comma-separated particle lists of npcs, spells and mounts.
   * Returns how many rows of each referred to it. The caller refreshes the caches.
   */
  async rename(from: string, to: string): Promise<{ npcs: number; spells: number; mounts: number }> {
    await query("UPDATE particles SET name = ? WHERE name = ?", [to, from]);
    const counts = { npcs: 0, spells: 0, mounts: 0 };
    const tables: Array<[keyof typeof counts, string]> = [["npcs", "id"], ["spells", "name"], ["mounts", "name"]];
    for (const [table, key] of tables) {
      const rows = (await query(`SELECT ${key} AS k, particles FROM ${table} WHERE particles LIKE ?`, [`%${from}%`])) as any[];
      for (const row of rows || []) {
        if (typeof row.particles !== "string") continue;
        const names = row.particles.split(",").map((n: string) => n.trim());
        if (!names.includes(from)) continue;
        await query(`UPDATE ${table} SET particles = ? WHERE ${key} = ?`, [renameInList(row.particles, from, to), row.k]);
        counts[table]++;
      }
    }
    await particles.list();
    return counts;
  },

  async find(particle: Particle) {
    const response = await query("SELECT * FROM particles WHERE name = ?", [particle.name]) as any[];
    const weather = resolveWeather(world?.weather);
    const p: Particle = {
      name: response[0]?.name,
      size: response[0]?.size,
      color: response[0]?.color,
      lifetime: response[0]?.lifetime,
      opacity: response[0]?.opacity,
      visible: response[0]?.visible === 1,
      gravity: {
        x: Number(response[0]?.gravity?.split(",")[0]) || 0,
        y: Number(response[0]?.gravity?.split(",")[1]) || 0,
      },
      localposition: {
        x: Number(response[0]?.localposition?.split(",")[0]) || 0,
        y: Number(response[0]?.localposition?.split(",")[1]) || 0,
      },
      velocity: {
        x: Number(response[0]?.velocity?.split(",")[0]) || 0,
        y: Number(response[0]?.velocity?.split(",")[1]) || 0,
      },
      interval: response[0]?.interval,
      amount: response[0]?.amount,
      staggertime: response[0]?.staggertime,
      spread: {
        x: Number(response[0]?.spread?.split(",")[0]) || 0,
        y: Number(response[0]?.spread?.split(",")[1]) || 0,
      },
      currentLife: null,
      initialVelocity: null,
      weather: response[0]?.affected_by_weather ? weather : 'none',
      affected_by_weather: response[0]?.affected_by_weather === 1,
      zIndex: response[0]?.zIndex || 0,
      glow_intensity: Number(response[0]?.glow_intensity) || 0,
      glow_radius: Number(response[0]?.glow_radius) || 0,
      static_light: response[0]?.static_light === 1 || response[0]?.static_light === true,
      brightness: brightnessOf(response[0]?.brightness),
      affected_by_time: response[0]?.affected_by_time === 1,
      time_on: response[0]?.time_on || null,
      time_off: response[0]?.time_off || null
    };
    await assetCache.set("particles", p);
    return p;
  },
}

// Columns added to particles after their first release: a database set up before then gets them here, so saving
// particles never fails on them. glow_radius: how far a particle's glow reaches (glow_intensity is its brightness
// only); static_light: the particle is one steady light at its position instead of an emitted stream; brightness: how
// much light the whole particle gives off (1 = as drawn).
for (const col of [
  { name: "glow_radius", type: "FLOAT NOT NULL DEFAULT 0" },
  { name: "static_light", type: "INT NOT NULL DEFAULT 0" },
  { name: "brightness", type: "FLOAT NOT NULL DEFAULT 1" },
]) {
  try {
    await query(`SELECT ${col.name} FROM particles LIMIT 1`);
  } catch {
    try {
      await query(`ALTER TABLE particles ADD COLUMN ${col.name} ${col.type}`);
      log.info(`Added the ${col.name} column to the particles table`);
    } catch (e) {
      log.warn(`Could not add the ${col.name} column to the particles table: ${e}`);
    }
  }
}

// Initialize particles cache on startup
await particles.list();
log.success(`Loaded particles into cache in ${(performance.now() - particlesNow).toFixed(2)}ms`);

export default particles;