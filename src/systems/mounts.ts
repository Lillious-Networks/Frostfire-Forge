import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import assetCache from "../services/assetCache";

// The mounts a WHERE on a name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: string, b: string) =>
  (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

/** The mounts held: every row of the table, read at startup and kept in step by each write of it. */
async function held(): Promise<Mount[]> {
  return ((await assetCache.get("mounts")) || []) as Mount[];
}

/**
 * A statement that changes the mounts table. One that throws may still have
 * been applied (a timeout, say), so the table is read again: what is held is
 * then what the database holds, not what it held before.
 */
async function write(sql: string, values: any[]): Promise<any> {
  try {
    return await query(sql, values);
  } catch (error) {
    try {
      await assetCache.set("mounts", await mounts.list());
    } catch (again) {
      log.error(`Could not read the mounts again after a write that failed: ${again}`);
    }
    throw error;
  }
}

const mounts = {
  async add(mount: Mount) {
    if (!mount?.name || !mount?.description) return;
    // INSERT IGNORE adds nothing when the name is taken: the mounts held say whether it is.
    const taken = (await held()).some((m) => sameName(m.name, mount.name));
    const row = { name: mount.name, description: mount.description, particles: mount.particles || null, icon: mount.icon || null };
    const result = await write(
      "INSERT IGNORE INTO mounts (name, description, particles, icon) VALUES (?, ?, ?, ?)",
      [row.name, row.description, row.particles, row.icon]
    );
    if (!taken) {
      // The row is what was written, under the id the database gave it when its answer says.
      const id = Number(result?.lastInsertRowid);
      await assetCache.set("mounts", [...(await held()), Number.isInteger(id) && id > 0 ? { id, ...row } : row]);
    }
    return result;
  },
  async remove(mount: Mount) {
    if (!mount?.name) return;
    const result = await write("DELETE FROM mounts WHERE name = ?", [mount.name]);
    await assetCache.set("mounts", (await held()).filter((m) => !sameName(m.name, mount.name)));
    return result;
  },
  async list() {
    return await query("SELECT * FROM mounts") as Mount[];
  },
  /** The mounts of that name, as the table has them; nothing when there is none. */
  async find(mount: Mount) {
    if (!mount?.name) return;
    const response = (await held()).filter((m) => sameName(m.name, mount.name));
    if (response.length === 0) return;
    return response;
  },
  async update(mount: Mount) {
    if (!mount?.name || !mount?.description) return;
    const changed = { description: mount.description, particles: mount.particles || null, icon: mount.icon || null };
    await write(
      "UPDATE mounts SET description = ?, particles = ?, icon = ? WHERE name = ?",
      [changed.description, changed.particles, changed.icon, mount.name]
    );
    // The statement changes those three columns of the rows of that name, and adds none: so do the mounts held.
    await assetCache.set("mounts", (await held()).map((m) => (sameName(m.name, mount.name) ? { ...m, ...changed } : m)));
  }
};

export default mounts;
