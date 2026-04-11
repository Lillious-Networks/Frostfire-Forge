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

const particlesNow = performance.now();

const particles = {
  async add(particle: Particle) {
    const response = await query("INSERT INTO particles (size, color, velocity, lifetime, opacity, visible, gravity, name, localposition, `interval`, amount, staggertime, spread, affected_by_weather) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [particle.size, particle.color, particle.velocity, particle.lifetime, particle.opacity, particle.visible, particle.gravity, particle.name, particle.localposition, particle.interval, particle.amount, particle.staggertime, particle.spread, particle.affected_by_weather]);
    await assetCache.set("particles", response);
    return response;
  },

  async remove(particle: Particle) {
    const response = await query("DELETE FROM particles WHERE name = ?", [particle.name]);
    await assetCache.set("particles", response);
    return response;
  },

  async update(particle: Particle) {
    const response = await query("UPDATE particles SET size = ?, color = ?, velocity = ?, lifetime = ?, opacity = ?, visible = ?, gravity = ?, name = ?, localposition = ?, `interval` = ?, amount = ?, staggertime = ?, spread = ?, affected_by_weather = ? WHERE name = ?", [particle.size, particle.color, particle.velocity, particle.lifetime, particle.opacity, particle.visible, particle.gravity, particle.name, particle.localposition, particle.interval, particle.amount, particle.staggertime, particle.spread, particle.affected_by_weather, particle.name]);
    await assetCache.set("particles", response);
    return response;
  },

  async list() {
    const response = await query("SELECT * FROM particles") as any[];
    const particles: Particle[] = [];

    for (const particle of response) {
      const weather = weathers.find((w) => w.name === world?.weather) || 'none';
      const p: Particle = {
        name: particle.name,
        size: particle.size,
        color: particle.color,
        lifetime: particle.lifetime,
        opacity: particle.opacity,
        visible: particle.visible,
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
        weather: particle.affected_by_weather ? weather : 'none'
      };
      particles.push(p);
    }
    await assetCache.set("particles", particles);
    return particles;
  },

  async find(particle: Particle) {
    const response = await query("SELECT * FROM particles WHERE name = ?", [particle.name]) as any[];
    const weather = weathers.find((w) => w.name === world?.weather) || 'none';
    const p: Particle = {
      name: response[0]?.name,
      size: response[0]?.size,
      color: response[0]?.color,
      lifetime: response[0]?.lifetime,
      opacity: response[0]?.opacity,
      visible: response[0]?.visible,
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
    };
    await assetCache.set("particles", p);
    return p;
  },
}

// Initialize particles cache on startup
await particles.list();
log.success(`Loaded particles into cache in ${(performance.now() - particlesNow).toFixed(2)}ms`);

export default particles;