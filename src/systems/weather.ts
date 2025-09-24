import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

const weather = {
  async add(weather: WeatherData) {
    if (!weather?.name) return;
    const response = await query("INSERT INTO weather (name, temperature, humidity, wind_speed, wind_direction, precipitation, ambience) VALUES (?, ?, ?, ?, ?, ?, ?)", [weather.name, weather.temperature, weather.humidity, weather.wind_speed, weather.wind_direction, weather.precipitation, weather.ambience]);
    assetCache.set("weather", response);
    return response;
  },
  async remove(weather: WeatherData) {
    if (!weather?.name) return;
    const response = await query("DELETE FROM weather WHERE name = ?", [weather.name]);
    assetCache.set("weather", response);
    return response;
  },
  async find(weather: WeatherData) {
    if (!weather?.name) return;
    const weathers = await assetCache.get("weather") as WeatherData[];
    return weathers.find((w) => w.name === weather.name);
  },
  async update(weather: WeatherData) {
    if (!weather?.name) return;
    const response = await query("UPDATE weather SET temperature = ?, humidity = ?, wind_speed = ?, wind_direction = ?, precipitation = ?, ambience = ? WHERE name = ?", [weather.temperature, weather.humidity, weather.wind_speed, weather.wind_direction, weather.precipitation, weather.ambience, weather.name]);
    assetCache.set("weather", response);
    return response;
  },
  async list() {
    return await query("SELECT * FROM weather");
  }
};

export default weather;