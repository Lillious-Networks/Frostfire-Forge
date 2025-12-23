import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

const mounts = {
  async add(mount: Mount) {
    if (!mount?.name || !mount?.description) return;
    return await query(
      "INSERT IGNORE INTO mounts (name, description, particles, icon) VALUES (?, ?, ?, ?)",
      [mount.name, mount.description, mount.particles || null, mount.icon || null]
    );
  },
  async remove(mount: Mount) {
    if (!mount?.name) return;
    return await query("DELETE FROM mounts WHERE name = ?", [mount.name]);
  },
  async list() {
    return await query("SELECT * FROM mounts") as Mount[];
  },
  async find(mount: Mount) {
    if (!mount?.name) return;
    const response = await query("SELECT * FROM mounts WHERE name = ?", [mount.name]) as any;
    if (response.length === 0) return;
    return response;
  },
  async update(mount: Mount) {
    if (!mount?.name || !mount?.description) return;
    const result = await query(
      "UPDATE mounts SET description = ?, particles = ?, icon = ? WHERE name = ?",
      [mount.description, mount.particles || null, mount.icon || null, mount.name]
    );
    if (result) {
      const mounts = await assetCache.get("mounts") as Mount[];
      const index = mounts.findIndex((m) => m.name === mount.name);
      mounts[index] = mount;
      assetCache.set("mounts", mounts);
    }
  }
};

export default mounts;