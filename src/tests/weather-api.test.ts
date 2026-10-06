import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// The real weather is held in memory: nothing here may ask the database.
const queries: string[] = [];
mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string) => {
    queries.push(sql);
    throw new Error(`The real weather asked the database: ${sql}`);
  },
}));

const cache = new Map<string, any>();
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => cache.get(key),
    set: async (key: string, value: any) => cache.set(key, value),
    add: async (key: string, value: any) => cache.set(key, value),
  },
}));

const { default: log } = await import("../modules/logger");
const api = await import("../systems/weatherapi");
const editor = await import("../systems/weathereditor");

// ------------------------------------------------------------------ fixtures

type Row = Record<string, any>;

const KEY = "test-key-0123456789";
const STILL = { name: "weather_api", temperature: 68, humidity: 30, wind_speed: 0, wind_direction: "none", precipitation: 0, ambience: 0 };

/** OpenWeatherMap's own example of a reading (moderate rain), in imperial units. */
const reading = (over: Row = {}): Row => ({
  weather: [{ id: 501, main: "Rain", description: "moderate rain", icon: "10d" }],
  main: { temp: 77.6, humidity: 64 },
  wind: { speed: 4.2, deg: 270 },
  rain: { "1h": 3.16 },
  clouds: { all: 100 },
  cod: 200,
  ...over,
});

const asked: string[] = [];
const answers = (status: number, body: any) => async (url: string) => {
  asked.push(url);
  return { ok: status === 200, status, json: async () => body };
};

const env = { ...process.env };
const logged: string[] = [];
const spies = (["info", "warn", "error", "debug"] as const).map((level) =>
  spyOn(log, level).mockImplementation((message: any) => { logged.push(String(message)); })
);

beforeEach(() => {
  api.resetWeatherApi();
  queries.length = 0;
  asked.length = 0;
  logged.length = 0;
  // The table has no "weather_api": it is not a weather of the list.
  cache.set("weather", [{ name: "clear", temperature: 68, humidity: 30, wind_speed: 0, wind_direction: "none", precipitation: 0, ambience: 0 }]);
  process.env.WEATHER_API_KEY = KEY;
  process.env.WEATHER_API_LOCATION = "47.61,-122.33";
  delete process.env.WEATHER_API_MINUTES;
});

afterEach(() => {
  api.resetWeatherApi();
  // Whatever a test did, the database was never asked and the weathers held never changed.
  expect(queries).toEqual([]);
  expect((cache.get("weather") as Row[]).map((w) => w.name)).toEqual(["clear"]);
});

afterAll(() => {
  for (const key of ["WEATHER_API_KEY", "WEATHER_API_LOCATION", "WEATHER_API_MINUTES"]) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  for (const spy of spies) spy.mockRestore();
});

// ------------------------------------------------------------------ reading

describe("a reading as a weather", () => {
  test("moderate rain", () => {
    const { row, look } = api.readingToWeather(reading())!;
    expect(look).toBe("rainy");
    expect(row).toEqual({ name: "weather_api", temperature: 78, humidity: 64, wind_speed: 4, wind_direction: "right", precipitation: 55, ambience: 0.47 });
  });

  test("how hard it falls follows the millimetres an hour", () => {
    const fall = (mm: number) => api.readingToWeather(reading({ rain: { "1h": mm } }))!.row.precipitation;
    expect([fall(0.5), fall(2.5), fall(7.6), fall(40)]).toEqual([12, 46, 85, 100]);
    // The slightest rain still shows.
    expect(fall(0.05)).toBe(5);
  });

  test("a condition that falls with no amount is judged by its id", () => {
    const fall = (id: number) => api.readingToWeather(reading({ weather: [{ id }], rain: undefined }))!.row.precipitation;
    expect([fall(500), fall(501), fall(502), fall(300), fall(211)]).toEqual([20, 50, 85, 20, 50]);
  });

  test("a dry sky has no precipitation and darkens only as far as its clouds", () => {
    const { row, look } = api.readingToWeather(reading({ weather: [{ id: 804 }], rain: { "1h": 1 }, clouds: { all: 100 } }))!;
    expect(look).toBe("clear");
    expect(row.precipitation).toBe(0);
    expect(row.ambience).toBe(0.3);
    expect(api.readingToWeather(reading({ weather: [{ id: 800 }], rain: undefined, clouds: { all: 0 } }))!.row.ambience).toBe(0);
  });

  test("thunderstorm, drizzle and snow", () => {
    const look = (id: number, over: Row = {}) => api.readingToWeather(reading({ weather: [{ id }], ...over }))!.look;
    expect([look(200), look(232), look(300), look(321), look(531), look(600), look(622), look(741), look(801)])
      .toEqual(["thunderstorm", "thunderstorm", "rainy", "rainy", "rainy", "snowy", "snowy", "clear", "clear"]);
    const storm = api.readingToWeather(reading({ weather: [{ id: 211 }] }))!;
    expect(storm.row.ambience).toBe(0.8);
    const snow = api.readingToWeather(reading({ weather: [{ id: 601 }], rain: undefined, snow: { "1h": 2.5 }, main: { temp: 28.4, humidity: 90 } }))!;
    // Snow is measured as water: the same millimetres show as three times the rain.
    expect(snow.row).toMatchObject({ temperature: 28, precipitation: 85 });
    const light = api.readingToWeather(reading({ weather: [{ id: 600 }], rain: undefined, snow: { "1h": 0.3 } }))!;
    expect(light.row.precipitation).toBe(20);
  });

  test("the wind blows to where the map shows it, from the bearing it blows from", () => {
    const to = (deg: number, speed = 10) => api.readingToWeather(reading({ wind: { speed, deg } }))!.row.wind_direction;
    // A west wind blows right, a north wind down the map, an east wind left, a south wind up.
    expect([to(270), to(0), to(360), to(90), to(180)]).toEqual(["right", "down", "down", "left", "up"]);
    expect([to(225), to(314), to(315), to(44), to(45), to(135)]).toEqual(["right", "right", "down", "down", "left", "up"]);
    // Still air has no direction.
    expect(to(270, 0.4)).toBe("none");
    expect(api.readingToWeather(reading({ wind: undefined }))!.row).toMatchObject({ wind_speed: 0, wind_direction: "none" });
  });

  test("what is not a reading is refused", () => {
    expect(api.readingToWeather({ cod: 401, message: "Invalid API key" })).toBeNull();
    expect(api.readingToWeather(null)).toBeNull();
    expect(api.readingToWeather({ main: { temp: "warm" } })).toBeNull();
  });
});

describe("the place asked for", () => {
  test("coordinates and city names", () => {
    expect(api.locationQuery("47.61,-122.33")).toBe("lat=47.61&lon=-122.33");
    expect(api.locationQuery(" 51 , 0 ")).toBe("lat=51&lon=0");
    expect(api.locationQuery("Seattle,US")).toBe("q=Seattle%2CUS");
    expect(api.locationQuery("São Paulo")).toBe("q=S%C3%A3o%20Paulo");
    expect(api.locationQuery("")).toBeNull();
    expect(api.locationQuery(undefined)).toBeNull();
  });
});

// ------------------------------------------------------------- what is held

describe("the weather held", () => {
  test("until the first reading it is a still, clear day", () => {
    expect(api.currentWeather()).toEqual(STILL);
    expect(api.shownAs("weather_api")).toBe("clear");
  });

  test("any other weather is told under its own name", () => {
    expect(api.shownAs("rainy")).toBe("rainy");
    expect(api.shownAs("darkness")).toBe("darkness");
    expect(api.shownAs("clear")).toBe("clear");
  });

  test("nothing is asked without a key or a place", async () => {
    delete process.env.WEATHER_API_KEY;
    expect(await api.refresh(answers(200, reading()))).toBe("off");
    process.env.WEATHER_API_KEY = KEY;
    process.env.WEATHER_API_LOCATION = "  ";
    expect(await api.refresh(answers(200, reading()))).toBe("off");
    expect(asked).toEqual([]);
    expect(api.currentWeather()).toEqual(STILL);
  });

  test("a reading is held in memory, and told as what it looks like", async () => {
    expect(await api.refresh(answers(200, reading()))).toBe("changed");
    expect(asked).toEqual([`https://api.openweathermap.org/data/2.5/weather?lat=47.61&lon=-122.33&units=imperial&appid=${KEY}`]);
    expect(api.currentWeather()).toEqual({ name: "weather_api", temperature: 78, humidity: 64, wind_speed: 4, wind_direction: "right", precipitation: 55, ambience: 0.47 });
    expect(api.shownAs("weather_api")).toBe("rainy");

    await api.refresh(answers(200, reading({ weather: [{ id: 211 }] })));
    expect(api.shownAs("weather_api")).toBe("thunderstorm");
    await api.refresh(answers(200, reading({ weather: [{ id: 601 }], rain: undefined, snow: { "1h": 1 }, main: { temp: 20, humidity: 80 } })));
    expect(api.shownAs("weather_api")).toBe("snowy");
    expect(api.currentWeather()).toMatchObject({ temperature: 20, precipitation: 53 });
  });

  test("the same reading again is no change", async () => {
    await api.refresh(answers(200, reading()));
    const held = api.currentWeather();
    expect(await api.refresh(answers(200, reading({ main: { temp: 77.9, humidity: 64.2 } })))).toBe("same");
    expect(api.currentWeather()).toBe(held);
  });

  test("the same numbers under another look are a change", async () => {
    const drizzle = reading({ weather: [{ id: 301 }], rain: { "1h": 2 } });
    const rain = reading({ weather: [{ id: 501 }], rain: { "1h": 2 }, main: { temp: 77.6, humidity: 64 } });
    await api.refresh(answers(200, drizzle));
    // Drizzle and rain look the same: rainy, with as much falling.
    expect(await api.refresh(answers(200, rain))).toBe("same");
    // Snow of the same weight in the row does not.
    const snow = reading({ weather: [{ id: 601 }], rain: { "1h": 2 } });
    expect(await api.refresh(answers(200, snow))).toBe("changed");
    expect(api.shownAs("weather_api")).toBe("snowy");
  });

  test("a refused key keeps the last reading and is reported once, without the key", async () => {
    await api.refresh(answers(200, reading()));
    const held = api.currentWeather();
    expect(await api.refresh(answers(401, { cod: 401, message: "Invalid API key" }))).toBe("failed");
    expect(await api.refresh(answers(401, { cod: 401, message: "Invalid API key" }))).toBe("failed");
    expect(api.currentWeather()).toBe(held);
    expect(api.shownAs("weather_api")).toBe("rainy");
    expect(logged.filter((line) => line.includes("the key was refused"))).toHaveLength(1);
    expect(logged.some((line) => line.includes(KEY))).toBe(false);
  });

  test("an unknown place, a service that fails and an answer that is no reading", async () => {
    expect(await api.refresh(answers(404, { cod: "404", message: "city not found" }))).toBe("failed");
    expect(await api.refresh(async () => { throw new Error("getaddrinfo ENOTFOUND"); })).toBe("failed");
    expect(await api.refresh(answers(200, { cod: 200 }))).toBe("failed");
    expect(api.currentWeather()).toEqual(STILL);
    expect(logged.some((line) => line.includes("WEATHER_API_LOCATION was not found"))).toBe(true);
    expect(logged.some((line) => line.includes(KEY))).toBe(false);
    // It works again as soon as a reading comes.
    expect(await api.refresh(answers(200, reading()))).toBe("changed");
  });

  test("the place's shift from UTC is kept from a reading, for the time of day", async () => {
    expect(api.utcOffsetSeconds()).toBeNull();
    expect(api.readingToWeather(reading({ timezone: -14400 }))!.utcOffset).toBe(-14400);
    expect(api.readingToWeather(reading())!.utcOffset).toBeNull();
    // No zone is a day out: such a number is not a shift.
    expect(api.readingToWeather(reading({ timezone: 90000 }))!.utcOffset).toBeNull();

    await api.refresh(answers(200, reading({ timezone: -14400 })));
    expect(api.utcOffsetSeconds()).toBe(-14400);
    // A reading without one, or a failed one, keeps the last.
    await api.refresh(answers(200, reading()));
    await api.refresh(answers(401, {}));
    expect(api.utcOffsetSeconds()).toBe(-14400);
    // Daylight saving ends: the same weather, another clock.
    expect(await api.refresh(answers(200, reading({ timezone: -18000 })))).toBe("same");
    expect(api.utcOffsetSeconds()).toBe(-18000);
  });

  test("starting without a key asks nothing and tells nobody", async () => {
    delete process.env.WEATHER_API_KEY;
    let told = 0;
    await api.startWeatherApi(() => { told++; });
    expect(told).toBe(0);
    expect(api.currentWeather()).toEqual(STILL);
    expect(logged.some((line) => line.includes("Weather API: off"))).toBe(true);
  });
});

describe("the weather editor", () => {
  test("weather_api is a word of /weather, not a name a weather can take", () => {
    const errors = editor.validateWeather(
      { name: "weather_api", temperature: 60, humidity: 50, wind_speed: 0, wind_direction: "none", precipitation: 0, ambience: 0 },
      { existingNames: new Set(), originalName: null }
    );
    expect(errors).toEqual([{ field: "name", message: "\"weather_api\" is a word of the /weather command, not a weather." }]);
  });
});
