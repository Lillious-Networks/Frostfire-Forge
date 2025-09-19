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
  get(world: string) {
    const worlds = assetCache.get("worlds") as WorldData[];
    return worlds.find((w) => w.name === world);
  },
  getCurrentWeather(world: string) {
    const worldData = this.get(world);
    return worldData?.weather || "clear";
  },
  getMaxPlayers(world: string) {
    const worldData = this.get(world);
    return worldData?.max_players || 100;
  },
  async add(world: WorldData) {
    await query("INSERT INTO worlds (name, weather, max_players, default_map) VALUES (?, ?, ?, ?)", [world.name, world.weather, world.max_players, world.default_map]);
  },
  async remove(world: WorldData) {
    await query("DELETE FROM worlds WHERE name = ?", [world.name]);
  },
  async update(world: WorldData) {
    await query("UPDATE worlds SET name = ?, weather = ?, max_players = ?, default_map = ? WHERE name = ?", [world.name, world.weather, world.max_players, world.default_map, world.name]);
  },
};

export default worlds;
