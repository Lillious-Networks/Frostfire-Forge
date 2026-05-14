import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

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
  },
};

export default worlds;
