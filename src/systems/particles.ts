import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import log from "../modules/logger";
import weather from "./weather";
import worlds from "./worlds";
import npcs from "./npcs";
import mounts from "./mounts";
import spells from "./spells";
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

/**
 * A particle's image: the name of the sprite (asset server, assets/sprites) it emits in place of the round dot, or null
 * for the dot. Only a plain file name is kept (the asset server refuses anything else).
 */
export function imageOf(v: unknown): string | null {
  const name = typeof v === "string" ? v.trim() : "";
  return name && name.length <= 255 && !/[\\/]|\.\./.test(name) && !name.includes("\0") ? name : null;
}

// The particles a WHERE on a name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: unknown, b: unknown) =>
  (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

/** A particles row as the server holds it. `row` is what the table gives, or what was just written to it. */
function fromRow(particle: any): Particle {
  const weather = resolveWeather(world?.weather);
  return {
    name: particle?.name,
    size: particle?.size,
    color: particle?.color,
    lifetime: particle?.lifetime,
    opacity: particle?.opacity,
    visible: particle?.visible === 1,
    gravity: {
      x: Number(particle?.gravity?.split(",")[0]) || 0,
      y: Number(particle?.gravity?.split(",")[1]) || 0,
    },
    localposition: {
      x: Number(particle?.localposition?.split(",")[0]) || 0,
      y: Number(particle?.localposition?.split(",")[1]) || 0,
    },
    velocity: {
      x: Number(particle?.velocity?.split(",")[0]) || 0,
      y: Number(particle?.velocity?.split(",")[1]) || 0,
    },
    interval: particle?.interval,
    amount: particle?.amount,
    staggertime: particle?.staggertime,
    spread: {
      x: Number(particle?.spread?.split(",")[0]) || 0,
      y: Number(particle?.spread?.split(",")[1]) || 0,
    },
    currentLife: null,
    initialVelocity: null,
    weather: particle?.affected_by_weather ? weather : 'none',
    affected_by_weather: particle?.affected_by_weather === 1,
    zIndex: particle?.zIndex || 0,
    glow_intensity: Number(particle?.glow_intensity) || 0,
    glow_radius: Number(particle?.glow_radius) || 0,
    static_light: particle?.static_light === 1 || particle?.static_light === true,
    brightness: brightnessOf(particle?.brightness),
    affected_by_time: particle?.affected_by_time === 1,
    time_on: particle?.time_on || null,
    time_off: particle?.time_off || null,
    image: imageOf(particle?.image)
  };
}

/** The columns add() and update() write, in the order their statements name them. */
const COLUMNS = [
  "size", "color", "velocity", "lifetime", "opacity", "visible", "gravity", "name", "localposition", "interval", "amount", "staggertime", "spread",
  "affected_by_weather", "zIndex", "glow_intensity", "glow_radius", "static_light", "brightness", "affected_by_time", "time_on", "time_off", "image",
] as const;
/** The columns that keep a whole number, and those that keep any number: the rest keep text. */
const WHOLE = new Set<string>(["size", "lifetime", "visible", "interval", "amount", "affected_by_weather", "zIndex", "static_light", "affected_by_time"]);
const FRACTION = new Set<string>(["opacity", "staggertime", "glow_intensity", "glow_radius", "brightness"]);

/** What add() and update() write for a particle, in the order of COLUMNS. */
function values(particle: Particle): unknown[] {
  return [particle.size, particle.color, particle.velocity, particle.lifetime, particle.opacity, particle.visible ? 1 : 0, particle.gravity, particle.name, particle.localposition, particle.interval, particle.amount, particle.staggertime, particle.spread, particle.affected_by_weather ? 1 : 0, particle.zIndex || 0, particle.glow_intensity || 0, particle.glow_radius || 0, particle.static_light ? 1 : 0, brightnessOf(particle.brightness), particle.affected_by_time ? 1 : 0, particle.time_on || null, particle.time_off || null, imageOf(particle.image)];
}

/**
 * The particle a row holds once `written` (what values() gave) has been written to it. A number column keeps a
 * number, rounded where it is a whole one; any other keeps text, which is what a statement sends for whatever it is
 * given; and nothing is kept where nothing was given.
 */
function asWritten(written: unknown[]): Particle {
  const row: Record<string, unknown> = {};
  COLUMNS.forEach((column, i) => {
    const value = typeof written[i] === "boolean" ? (written[i] ? 1 : 0) : written[i];
    if (value === null || value === undefined) row[column] = null;
    else if (!WHOLE.has(column) && !FRACTION.has(column)) row[column] = String(value);
    else {
      const n = Number(value);
      row[column] = !Number.isFinite(n) ? value : WHOLE.has(column) ? Math.sign(n) * Math.round(Math.abs(n)) : n;
    }
  });
  return fromRow(row);
}

/**
 * Lowered when a write failed and the table could not be read again: what is held is then not known to be what the
 * table holds, and the next list() reads it.
 */
let sure = true;

/** The particles held: every row of the table, read at startup and kept in step by each write here. */
async function held(): Promise<Particle[]> {
  const list = await assetCache.get("particles");
  return Array.isArray(list) ? (list as Particle[]) : [];
}

/** Reads the table and holds what it has: at startup, and after a write whose outcome is not known. */
async function load(): Promise<Particle[]> {
  const response = await query("SELECT * FROM particles") as any[];
  const list = response.map(fromRow);
  await assetCache.set("particles", list);
  sure = true;
  return list;
}

// One write at a time: each changes the particles held and puts them back.
let writing: Promise<unknown> = Promise.resolve();

/**
 * A statement that changes the particles table, then `change` made to the particles held. A statement that throws
 * may still have been applied (a timeout, say), so the table is read again rather than the particles left as they
 * were; if it cannot be read either, the next list() reads it.
 */
function write(sql: string, written: unknown[], change: (list: Particle[]) => Particle[]): Promise<any> {
  const work = async () => {
    let response;
    try {
      response = await query(sql, written as any[]);
    } catch (error) {
      sure = false;
      await load().catch((again) => log.error(`Could not read the particles again after a write that failed: ${again}`));
      throw error;
    }
    await assetCache.set("particles", change(await held()));
    return response;
  };
  const run = writing.then(work, work);
  writing = run.catch(() => {});
  return run;
}

const particles = {
  async add(particle: Particle) {
    const written = values(particle);
    return await write(
      "INSERT INTO particles (size, color, velocity, lifetime, opacity, visible, gravity, name, localposition, `interval`, amount, staggertime, spread, affected_by_weather, zIndex, glow_intensity, glow_radius, static_light, brightness, affected_by_time, time_on, time_off, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      written,
      // The name is the table's key: a row of it that was held would have refused the statement.
      (list) => [...list.filter((p) => !sameName(p.name, particle.name)), asWritten(written)]
    );
  },

  async remove(particle: Particle) {
    return await write("DELETE FROM particles WHERE name = ?", [particle.name], (list) => list.filter((p) => !sameName(p.name, particle.name)));
  },

  async update(particle: Particle) {
    const written = values(particle);
    return await write(
      "UPDATE particles SET size = ?, color = ?, velocity = ?, lifetime = ?, opacity = ?, visible = ?, gravity = ?, name = ?, localposition = ?, `interval` = ?, amount = ?, staggertime = ?, spread = ?, affected_by_weather = ?, zIndex = ?, glow_intensity = ?, glow_radius = ?, static_light = ?, brightness = ?, affected_by_time = ?, time_on = ?, time_off = ?, image = ? WHERE name = ?",
      [...written, particle.name],
      // The statement changes the row of that name and adds none.
      (list) => list.map((p) => (sameName(p.name, particle.name) ? asWritten(written) : p))
    );
  },

  /** Every particle: the particles held. The table itself is read at startup, and here only when what is held is in doubt. */
  async list() {
    if (!sure || !Array.isArray(await assetCache.get("particles"))) return load();
    return held();
  },

  /** Reads the table again and holds what it has. */
  async reload() {
    return load();
  },

  /**
   * Renames a particle and every reference to it: the comma-separated particle lists of npcs, spells and mounts.
   * Returns how many rows of each referred to it. Which rows those are is read from the lists held, and each row
   * written is changed in its list too; the maps' own NPCs and the plugins' spells, which are no rows of the
   * database, are left to the caller.
   */
  async rename(from: string, to: string): Promise<{ npcs: number; spells: number; mounts: number }> {
    await write("UPDATE particles SET name = ? WHERE name = ?", [to, from], (list) => list.map((p) => (sameName(p.name, from) ? { ...p, name: to } : p)));
    const counts = { npcs: 0, spells: 0, mounts: 0 };
    const tables: Array<[keyof typeof counts, string]> = [["npcs", "id"], ["spells", "name"], ["mounts", "name"]];
    try {
      for (const [table, key] of tables) {
        const list = await assetCache.get(table);
        if (!Array.isArray(list)) continue;
        for (const row of list) {
          if (typeof row?.particles !== "string") continue;
          const names = row.particles.split(",").map((n: string) => n.trim());
          if (!names.includes(from)) continue;
          // A row of the database has the id it gave it: a map's NPC has a negative one of its own, a plugin's spell none.
          if (table === "npcs" ? npcs.isMapNpc(row) : table === "spells" && (row.id === null || row.id === undefined)) continue;
          const renamed = renameInList(row.particles, from, to);
          await query(`UPDATE ${table} SET particles = ? WHERE ${key} = ?`, [renamed, row[key]]);
          row.particles = renamed;
          counts[table]++;
        }
        await assetCache.set(table, list);
      }
    } catch (error) {
      await rereadReferences();
      throw error;
    }
    return counts;
  },

  /** The particle of that name as held. When there is none, one with no name. */
  async find(particle: Particle) {
    return (await this.list()).find((p) => sameName(p.name, particle.name)) ?? fromRow(undefined);
  },
}

/**
 * After a rename that failed part way: a statement that throws may still have been applied (a timeout, say), so
 * every list the rename writes is read again. Of the spells only the column it writes is: what else the server
 * holds of a spell, and the spells of plugins, are not the database's to give back.
 */
async function rereadReferences(): Promise<void> {
  const again = async (what: string, read: () => Promise<unknown>) => {
    try {
      await read();
    } catch (error) {
      log.error(`Could not read the ${what} again after a particle rename that failed: ${error}`);
    }
  };
  await again("particles", async () => {
    sure = false;
    await load();
  });
  await again("NPCs", () => npcs.reload());
  await again("mounts", async () => assetCache.set("mounts", await mounts.list()));
  await again("spells", async () => {
    const rows = (await spells.list()) as any[];
    const list = await assetCache.get("spells");
    if (!Array.isArray(list)) return;
    for (const spell of list) {
      const row = spell?.id === null || spell?.id === undefined ? null : rows.find((r) => Number(r.id) === Number(spell.id));
      if (row) spell.particles = row.particles;
    }
    await assetCache.set("spells", list);
  });
}

// Columns added to particles after their first release: a database set up before then gets them here, so saving
// particles never fails on them. glow_radius: how far a particle's glow reaches (glow_intensity is its brightness
// only); static_light: the particle is one steady light at its position instead of an emitted stream; brightness: how
// much light the whole particle gives off (1 = as drawn); image: the sprite it emits in place of the round dot.
for (const col of [
  { name: "glow_radius", type: "FLOAT NOT NULL DEFAULT 0" },
  { name: "static_light", type: "INT NOT NULL DEFAULT 0" },
  { name: "brightness", type: "FLOAT NOT NULL DEFAULT 1" },
  { name: "image", type: "VARCHAR(255) DEFAULT NULL" },
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
await load();
log.success(`Loaded particles into cache in ${(performance.now() - particlesNow).toFixed(2)}ms`);

export default particles;
