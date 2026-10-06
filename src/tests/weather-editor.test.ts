import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ------------------------------------------------------------ fake database
// The statements systems/weather sends, run against an in-memory table, with
// a pause in each one so that two requests sent together really do
// interleave. The only reads it knows are the sender's permissions and the
// table read again after a write that failed: a check that asked the database
// instead of the weathers held would fail the test that made it.

type Row = Record<string, any>;
let tables: { weather: Row[]; permissions: Row[] };
/** A statement matching this is refused, as a lost connection would refuse it. */
let failing: RegExp | null;
/** The refused statement was applied all the same, as one that timed out may have been. */
let appliedAnyway: boolean;
const queries: Array<{ sql: string; params: any[] }> = [];

const PERMISSIONS = "SELECT permissions FROM permissions WHERE username = ?";
const REREAD = "SELECT * FROM weather";
const INSERT = "INSERT INTO weather (name, temperature, humidity, wind_speed, wind_direction, precipitation, ambience) VALUES (?, ?, ?, ?, ?, ?, ?)";
const UPDATE = "UPDATE weather SET temperature = ?, humidity = ?, wind_speed = ?, wind_direction = ?, precipitation = ?, ambience = ? WHERE name = ?";
const DELETE = "DELETE FROM weather WHERE name = ?";

// As MySQL compares a name: without regard to case.
const sameName = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

async function run(sql: string, params: any[] = []): Promise<any> {
  const text = sql.replace(/\s+/g, " ").trim();
  queries.push({ sql: text, params });
  await new Promise((resolve) => setTimeout(resolve, 1));
  if (failing?.test(text)) {
    if (appliedAnyway) apply(text, params);
    throw new Error("Connection lost");
  }
  return apply(text, params);
}

function apply(text: string, params: any[]): any {
  if (text === PERMISSIONS) return tables.permissions.filter((r) => r.username === params[0]);
  if (text === REREAD) return tables.weather.map((r) => ({ ...r }));
  if (text === INSERT) {
    const [name, temperature, humidity, wind_speed, wind_direction, precipitation, ambience] = params;
    // The name is the table's primary key.
    if (tables.weather.some((r) => sameName(r.name, name))) throw new Error(`Duplicate entry '${name}' for key 'PRIMARY'`);
    tables.weather.push({ name, temperature, humidity, wind_speed, wind_direction, precipitation, ambience });
    return [];
  }
  if (text === UPDATE) {
    const [temperature, humidity, wind_speed, wind_direction, precipitation, ambience, name] = params;
    for (const row of tables.weather.filter((r) => sameName(r.name, name))) {
      Object.assign(row, { temperature, humidity, wind_speed, wind_direction, precipitation, ambience });
    }
    return [];
  }
  if (text === DELETE) {
    tables.weather = tables.weather.filter((r) => !sameName(r.name, params[0]));
    return [];
  }
  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => ({
  default: (sql: string, params: any[] = []) => run(sql, params),
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
const { clearCaches } = await import("../services/datacache");
const editor = await import("../systems/weathereditor");

// ------------------------------------------------------------------ fixtures

const ADMIN = { id: "we-1", username: "boss", isGuest: false, permissions: ["server.admin"] };
const BUILDER = { id: "we-2", username: "builder", isGuest: false, permissions: ["tools.*"] };
// /weather's own permission is not the editor's.
const MODERATOR = { id: "we-3", username: "mod", isGuest: false, permissions: ["admin.*"] };

const PACKETS = ["WEATHER_EDITOR_LIST", "WEATHER_EDITOR_SAVE", "WEATHER_EDITOR_DELETE"];

const weatherOf = (over: Row = {}): Row => ({
  name: "foggy", temperature: 48, humidity: 95, wind_speed: 4, wind_direction: "left", precipitation: 10, ambience: 0.3,
  ...over,
});

/** The socket layer as the editor sees it: the worlds, and what was done to them. */
let worlds: Array<{ name: string; weather: string; showing: string }>;
let shown: Array<{ world: string; weather: string; weatherData: Row | null }>;
let moved: Array<{ world: string; weather: string }>;
/** A world whose weather cannot be set, as when the statement that sets it fails. */
let stuckWorld: string | null;

function resetWorld() {
  failing = null;
  appliedAnyway = false;
  stuckWorld = null;
  queries.length = 0;
  tables = {
    permissions: [
      { username: "boss", permissions: "server.admin,admin.kick" },
      { username: "builder", permissions: "tools.*" },
      { username: "forecaster", permissions: "tools.weather_editor" },
      { username: "smith", permissions: "tools.spell_editor" },
      { username: "mod", permissions: "admin.*,admin.weather" },
      { username: "owner", permissions: "server.*" },
    ],
    weather: [
      { name: "clear", temperature: 68, humidity: 30, wind_speed: 0, wind_direction: "none", precipitation: 0, ambience: 0 },
      { name: "thunderstorm", temperature: 55, humidity: 90, wind_speed: 25, wind_direction: "right", precipitation: 80, ambience: 0.8 },
      { name: "rainy", temperature: 60, humidity: 85, wind_speed: 10, wind_direction: "left", precipitation: 60, ambience: 0.2 },
      { name: "darkness", temperature: 50, humidity: 40, wind_speed: 0, wind_direction: "none", precipitation: 0, ambience: 0.9 },
    ],
  };
  cache.set("weather", tables.weather.map((r) => ({ ...r })));
  worlds = [
    { name: "main", weather: "rainy", showing: "rainy" },
    { name: "cave", weather: "darkness", showing: "darkness" },
    // On "random", settled on rainy for now.
    { name: "wilds", weather: "random", showing: "rainy" },
    { name: "town", weather: "clear", showing: "clear" },
    // Set to a weather that has no row.
    { name: "marsh", weather: "misty", showing: "misty" },
  ];
  shown = [];
  moved = [];
  editor.setWeatherEditorBridge({
    worlds: async () => worlds.map((w) => ({ ...w })),
    setWorldWeather: async (world, weather) => {
      if (world === stuckWorld) throw new Error("Connection lost");
      moved.push({ world, weather });
      const found = worlds.find((w) => w.name === world)!;
      found.weather = found.showing = weather;
    },
    show: (world, weather, weatherData) => {
      shown.push({ world, weather, weatherData: weatherData ? { ...weatherData } : null });
      worlds.find((w) => w.name === world)!.showing = weather;
    },
  });
}

const held = (): Row[] => cache.get("weather") as Row[];
const heldOf = (name: string) => held().find((w) => w.name === name);
const stored = (name: string) => tables.weather.find((w) => w.name === name);
const writes = () => queries.filter((q) => /^(INSERT|UPDATE|DELETE)/.test(q.sql));
/** The reads of the database that are not of the sender's permissions. */
const reads = () => queries.filter((q) => q.sql.startsWith("SELECT") && q.sql !== PERMISSIONS);

const act = async (admin: any, type: string, data: any) => {
  const result = await editor.handleEditorPacket(admin, type, data);
  if (result.kind !== "result") throw new Error(`Expected a result, got ${result.kind}`);
  return result;
};
const save = (data: Row, admin: any = ADMIN) => act(admin, "WEATHER_EDITOR_SAVE", data);
const remove = (name: unknown, admin: any = ADMIN) => act(admin, "WEATHER_EDITOR_DELETE", { name });

const check = (data: Row, originalName: string | null = null) =>
  editor.validateWeather(data, { existingNames: new Set(["clear", "thunderstorm", "rainy", "darkness"]), originalName });
const messageFor = (errors: Array<{ field: string; message: string }>, field: string) => errors.find((e) => e.field === field)?.message;

// The editor logs what it did and what it could not do; the tests say so themselves.
let errorLog: ReturnType<typeof spyOn>;
let infoLog: ReturnType<typeof spyOn>;
beforeAll(() => {
  errorLog = spyOn(log, "error").mockImplementation(() => {});
  infoLog = spyOn(log, "info").mockImplementation(() => {});
});
afterAll(() => {
  errorLog.mockRestore();
  infoLog.mockRestore();
  editor.setWeatherEditorBridge(null);
});

// Each test starts from a different database: what the caches held of the last one is forgotten.
beforeEach(async () => {
  resetWorld();
  await clearCaches();
});

// ------------------------------------------------------------------- tests

describe("weather editor permissions", () => {
  test("admins, the tool's own permission and the wildcards pass; other permissions, guests and nobody do not", async () => {
    expect(await editor.canUseEditor(ADMIN)).toBe(true);
    expect(await editor.canUseEditor({ username: "owner" })).toBe(true);
    expect(await editor.canUseEditor(BUILDER)).toBe(true);
    expect(await editor.canUseEditor({ username: "forecaster" })).toBe(true);
    // the admin role, whatever permissions are stored
    expect(await editor.canUseEditor({ username: "stranger", isAdmin: true })).toBe(true);
    // another editor's permission, and /weather's
    expect(await editor.canUseEditor({ username: "smith" })).toBe(false);
    expect(await editor.canUseEditor(MODERATOR)).toBe(false);
    expect(await editor.canUseEditor({ username: "stranger" })).toBe(false);
    expect(await editor.canUseEditor({ username: "boss", isGuest: true })).toBe(false);
    expect(await editor.canUseEditor(null)).toBe(false);
  });

  test("the stored permissions decide, not the ones copied at login", async () => {
    tables.permissions[0]!.permissions = "admin.kick";
    expect(await editor.canUseEditor(ADMIN)).toBe(false);
  });

  test("every packet is refused without the permission, and nothing is read, written or shown", async () => {
    for (const type of PACKETS) {
      const result = await act(MODERATOR, type, { ...weatherOf(), name: "rainy", originalName: "rainy" });
      expect(result.ok).toBe(false);
      expect(result.denied).toBe(true);
      expect(result.errors).toEqual([editor.DENIED]);
      expect(result.data).toBeNull();
    }
    // The sender's permissions were read once, for the first of them, and are held since.
    expect(queries.map((q) => q.sql)).toEqual([PERMISSIONS]);
    expect(tables.weather).toHaveLength(4);
    expect(held()).toHaveLength(4);
    expect(shown).toEqual([]);
    expect(moved).toEqual([]);
  });

  test("the reload notice goes to players who hold the permission", () => {
    expect(editor.mayHaveEditorOpen(ADMIN)).toBe(true);
    expect(editor.mayHaveEditorOpen({ permissions: ["tools.weather_editor"] })).toBe(true);
    expect(editor.mayHaveEditorOpen(BUILDER)).toBe(true);
    expect(editor.mayHaveEditorOpen({ isAdmin: true, permissions: [] })).toBe(true);
    expect(editor.mayHaveEditorOpen(MODERATOR)).toBe(false);
    expect(editor.mayHaveEditorOpen(null)).toBe(false);
  });
});

describe("listing", () => {
  test("the editor is sent every weather, where each is shown, and the rules a save is held to", async () => {
    const result = await editor.handleEditorPacket(ADMIN, "WEATHER_EDITOR_LIST", null);
    if (result.kind !== "data") throw new Error("Expected the editor's data");
    expect(result.data.weathers.map((w) => w.name)).toEqual(["clear", "darkness", "rainy", "thunderstorm"]);
    expect(result.data.weathers[3]).toEqual({ name: "thunderstorm", temperature: 55, humidity: 90, wind_speed: 25, wind_direction: "right", precipitation: 80, ambience: 0.8 });
    expect(result.data.worlds).toEqual(worlds);
    expect(result.data.directions).toEqual(["none", "left", "right", "up", "down"]);
    expect(result.data.numbers.ambience).toEqual({ label: "Ambience", min: 0, max: 1 });
    expect(result.data.protected).toEqual(["clear"]);
    expect(result.data.fallback).toBe("clear");
    expect(result.data.reserved).toEqual(["random", "none", "weather_api"]);
    expect(result.data.nameMax).toBe(editor.NAME_MAX);
  });

  test("it is read from the weathers held, never from the database", async () => {
    await editor.handleEditorPacket(ADMIN, "WEATHER_EDITOR_LIST", null);
    expect(reads()).toEqual([]);
  });

  test("numbers held as text reach the editor as numbers", async () => {
    cache.set("weather", [{ name: "odd", temperature: "50", humidity: "40", wind_speed: "2.5", wind_direction: "up", precipitation: null, ambience: "0.25" }]);
    const result = await editor.handleEditorPacket(ADMIN, "WEATHER_EDITOR_LIST", null);
    if (result.kind !== "data") throw new Error("Expected the editor's data");
    expect(result.data.weathers).toEqual([{ name: "odd", temperature: 50, humidity: 40, wind_speed: 2.5, wind_direction: "up", precipitation: 0, ambience: 0.25 }]);
  });
});

describe("validation", () => {
  test("a weather within the rules has nothing wrong with it", () => {
    expect(check(weatherOf())).toEqual([]);
    expect(check(weatherOf({ temperature: -100, humidity: 0, wind_speed: 100, precipitation: 100, ambience: 1, wind_direction: "none" }))).toEqual([]);
  });

  const BAD_NAMES: Array<[name: unknown, says: string]> = [
    ["", "Name is required."],
    ["   ", "Name is required."],
    [undefined, "Name is required."],
    [42, "Name is required."],
    ["x".repeat(editor.NAME_MAX + 1), `Name must be ${editor.NAME_MAX} characters or fewer.`],
    ["Foggy", "Name can hold lower case letters"],
    ["light rain", "Name can hold lower case letters"],
    ["_fog", "Name can hold lower case letters"],
    ["fog'; DROP TABLE weather", "Name can hold lower case letters"],
    ["random", "is a word of the /weather command"],
    ["none", "is a word of the /weather command"],
    ["rainy", "A weather with that name already exists."],
  ];
  for (const [name, says] of BAD_NAMES) {
    test(`a new weather cannot be named ${JSON.stringify(name)}`, () => {
      const errors = check(weatherOf({ name }));
      expect(errors.map((e) => e.field)).toEqual(["name"]);
      expect(errors[0]!.message).toContain(says);
    });
  }

  test("a name of the longest length, with digits, underscores and hyphens, is fine", () => {
    expect(check(weatherOf({ name: "x".repeat(editor.NAME_MAX) }))).toEqual([]);
    expect(check(weatherOf({ name: "2nd_light-rain" }))).toEqual([]);
  });

  test("the name of an existing weather is not checked: it does not change", () => {
    expect(check(weatherOf({ name: "Whatever Else" }), "rainy")).toEqual([]);
  });

  test("the wind direction is one of the five", () => {
    for (const direction of editor.DIRECTIONS) expect(check(weatherOf({ wind_direction: direction }))).toEqual([]);
    for (const direction of ["north", "LEFT", "", null, undefined, 3, "leftward"]) {
      expect(messageFor(check(weatherOf({ wind_direction: direction })), "wind_direction")).toBe("Wind direction must be one of none, left, right, up and down.");
    }
  });

  test("every number is a finite number within its range", () => {
    for (const [key, rule] of Object.entries(editor.NUMBER_FIELDS)) {
      for (const value of [NaN, Infinity, -Infinity, "5", null, undefined, true, {}]) {
        expect(messageFor(check(weatherOf({ [key]: value })), key)).toBe(`${rule.label} must be a number.`);
      }
      for (const value of [rule.min - 0.01, rule.max + 0.01]) {
        expect(messageFor(check(weatherOf({ [key]: value })), key)).toBe(`${rule.label} must be between ${rule.min} and ${rule.max}.`);
      }
      expect(check(weatherOf({ [key]: rule.min }))).toEqual([]);
      expect(check(weatherOf({ [key]: rule.max }))).toEqual([]);
    }
  });

  test("ambience is from 0 to 1", () => {
    expect(messageFor(check(weatherOf({ ambience: 1.1 })), "ambience")).toBe("Ambience must be between 0 and 1.");
    expect(messageFor(check(weatherOf({ ambience: -0.1 })), "ambience")).toBe("Ambience must be between 0 and 1.");
  });

  test("each field is reported once, and all of them together", () => {
    const errors = check({ name: "", wind_direction: "sideways" });
    expect(errors.map((e) => e.field)).toEqual(["name", "wind_direction", "temperature", "humidity", "wind_speed", "precipitation", "ambience"]);
  });
});

describe("saving", () => {
  test("a new weather is written to the table, then held, and answered with the weathers as they stand", async () => {
    const result = await save({ ...weatherOf(), originalName: null });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.name).toBe("foggy");
    expect(result.changed).toBe(true);
    expect(writes()).toEqual([{ sql: INSERT, params: ["foggy", 48, 95, 4, "left", 10, 0.3] }]);
    expect(stored("foggy")).toEqual(weatherOf());
    expect(heldOf("foggy")).toEqual(weatherOf());
    expect(result.data!.weathers.map((w) => w.name)).toEqual(["clear", "darkness", "foggy", "rainy", "thunderstorm"]);
    // Nothing shows it yet, and the answer says how to see it.
    expect(shown).toEqual([]);
    expect(result.notes).toEqual(["No world shows foggy right now. /weather foggy sets the world you are in to it."]);
    expect(reads()).toEqual([]);
  });

  test("the name is trimmed", async () => {
    const result = await save({ ...weatherOf({ name: "  foggy " }), originalName: null });
    expect(result.name).toBe("foggy");
    expect(stored("foggy")).toBeDefined();
  });

  test("a weather that is not valid is refused by field, and nothing is written or shown", async () => {
    const result = await save({ ...weatherOf({ name: "Foggy", wind_direction: "north", ambience: 2, wind_speed: "fast" }), originalName: null });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.fields!)).toEqual(["name", "wind_direction", "wind_speed", "ambience"]);
    expect(result.errors).toHaveLength(4);
    expect(result.changed).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(shown).toEqual([]);
    // The answer still carries the weathers, as they were.
    expect(result.data!.weathers).toHaveLength(4);
  });

  test("a name that is taken is refused, whatever its case in the table", async () => {
    expect((await save({ ...weatherOf({ name: "rainy" }), originalName: null })).fields).toEqual({ name: "A weather with that name already exists." });
    cache.set("weather", [...held(), { ...weatherOf({ name: "Foggy" }) }]);
    expect((await save({ ...weatherOf({ name: "foggy" }), originalName: null })).fields).toEqual({ name: "A weather with that name already exists." });
    expect(writes()).toEqual([]);
  });

  test("an existing weather is updated in the table, then in the list held", async () => {
    const result = await save({ ...weatherOf({ name: "rainy", wind_speed: 40, wind_direction: "right", ambience: 0.5 }), originalName: "rainy" });
    expect(result.ok).toBe(true);
    expect(result.name).toBe("rainy");
    expect(writes()).toEqual([{ sql: UPDATE, params: [48, 95, 40, "right", 10, 0.5, "rainy"] }]);
    const saved = weatherOf({ name: "rainy", wind_speed: 40, wind_direction: "right", ambience: 0.5 });
    expect(stored("rainy")).toEqual(saved);
    expect(heldOf("rainy")).toEqual(saved);
    expect(held()).toHaveLength(4);
    expect(reads()).toEqual([]);
  });

  test("the list held is changed in place: whoever was handed it at startup sees the change", async () => {
    const handed = held();
    await save({ ...weatherOf({ name: "rainy", wind_speed: 40 }), originalName: "rainy" });
    await save({ ...weatherOf(), originalName: null });
    expect(held()).toBe(handed);
    expect(handed.find((w) => w.name === "rainy")!.wind_speed).toBe(40);
    expect(handed.find((w) => w.name === "foggy")).toBeDefined();
  });

  test("its name is fixed: a different name sent with it is not taken", async () => {
    const result = await save({ ...weatherOf({ name: "drizzle" }), originalName: "rainy" });
    expect(result.ok).toBe(true);
    expect(result.name).toBe("rainy");
    expect(stored("drizzle")).toBeUndefined();
    expect(heldOf("drizzle")).toBeUndefined();
    expect(stored("rainy")!.humidity).toBe(95);
  });

  test("clear can be edited like any other: its wind still blows", async () => {
    const result = await save({ ...weatherOf({ name: "clear", wind_speed: 6, wind_direction: "right", ambience: 0 }), originalName: "clear" });
    expect(result.ok).toBe(true);
    expect(shown).toEqual([{ world: "town", weather: "clear", weatherData: heldOf("clear")! }]);
  });

  test("a weather deleted since it was opened is not saved", async () => {
    const result = await save({ ...weatherOf({ name: "snowy" }), originalName: "snowy" });
    expect(result.errors).toEqual(["That weather no longer exists. It may have been deleted by someone else."]);
    expect(writes()).toEqual([]);
  });

  test("every world that shows it is shown it as saved: the worlds set to it, and a random world that settled on it", async () => {
    const result = await save({ ...weatherOf({ name: "rainy", wind_speed: 40, wind_direction: "right" }), originalName: "rainy" });
    const saved = weatherOf({ name: "rainy", wind_speed: 40, wind_direction: "right" });
    expect(shown).toEqual([
      { world: "main", weather: "rainy", weatherData: saved },
      { world: "wilds", weather: "rainy", weatherData: saved },
    ]);
    expect(result.notes).toEqual(["Showing now on main and wilds: the players there see the change."]);
    // No world's weather is set by a save.
    expect(moved).toEqual([]);
  });

  test("a new weather is shown on a world that was already set to its name", async () => {
    const result = await save({ ...weatherOf({ name: "misty" }), originalName: null });
    expect(result.ok).toBe(true);
    expect(shown).toEqual([{ world: "marsh", weather: "misty", weatherData: weatherOf({ name: "misty" }) }]);
  });

  test("a save the database refuses is answered with why, with the table read again", async () => {
    failing = /^UPDATE weather/;
    const result = await save({ ...weatherOf({ name: "rainy", wind_speed: 40 }), originalName: "rainy" });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["The server could not do that: Connection lost"]);
    expect(heldOf("rainy")!.wind_speed).toBe(10);
    expect(shown).toEqual([]);
    expect(reads().map((q) => q.sql)).toEqual([REREAD]);
    expect(result.data!.weathers.find((w) => w.name === "rainy")!.wind_speed).toBe(10);
  });

  test("a refused save that was applied all the same is what the editor is then sent", async () => {
    failing = /^UPDATE weather/;
    appliedAnyway = true;
    const result = await save({ ...weatherOf({ name: "rainy", wind_speed: 40 }), originalName: "rainy" });
    expect(result.ok).toBe(false);
    expect(heldOf("rainy")!.wind_speed).toBe(40);
    expect(result.data!.weathers.find((w) => w.name === "rainy")!.wind_speed).toBe(40);
  });

  test("the same new weather sent twice at once is added once", async () => {
    const request = { ...weatherOf(), originalName: null };
    const [first, second] = await Promise.all([save(request), save(request)]);
    expect([first.ok, second.ok]).toEqual([true, false]);
    expect(second.fields).toEqual({ name: "A weather with that name already exists." });
    expect(tables.weather.filter((w) => w.name === "foggy")).toHaveLength(1);
    expect(held().filter((w) => w.name === "foggy")).toHaveLength(1);
  });

  test("two saves of one weather at once both land, the later one last", async () => {
    const [first, second] = await Promise.all([
      save({ ...weatherOf({ name: "rainy", wind_speed: 11 }), originalName: "rainy" }),
      save({ ...weatherOf({ name: "rainy", wind_speed: 22 }), originalName: "rainy" }, { username: "owner" }),
    ]);
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(stored("rainy")!.wind_speed).toBe(22);
    expect(heldOf("rainy")!.wind_speed).toBe(22);
  });
});

describe("deleting", () => {
  test("a weather no world shows is deleted from the table, then from the list held", async () => {
    const result = await remove("thunderstorm");
    expect(result.ok).toBe(true);
    expect(result.name).toBe("thunderstorm");
    expect(result.changed).toBe(true);
    expect(result.notes).toEqual([]);
    expect(writes()).toEqual([{ sql: DELETE, params: ["thunderstorm"] }]);
    expect(stored("thunderstorm")).toBeUndefined();
    expect(heldOf("thunderstorm")).toBeUndefined();
    expect(result.data!.weathers.map((w) => w.name)).toEqual(["clear", "darkness", "rainy"]);
    expect(shown).toEqual([]);
    expect(moved).toEqual([]);
    expect(reads()).toEqual([]);
  });

  test("clear cannot be deleted", async () => {
    const result = await remove("clear");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("clear cannot be deleted");
    expect(writes()).toEqual([]);
    expect(heldOf("clear")).toBeDefined();
  });

  test("the other weathers the client draws by name can be: only clear is relied on by the server", async () => {
    expect((await remove("darkness")).ok).toBe(true);
    expect((await remove("thunderstorm")).ok).toBe(true);
    expect(held().map((w) => w.name)).toEqual(["clear", "rainy"]);
  });

  test("nothing selected, and a weather that is not there", async () => {
    expect((await remove("")).errors).toEqual(["Nothing selected."]);
    expect((await remove(undefined)).errors).toEqual(["Nothing selected."]);
    expect((await remove(7)).errors).toEqual(["Nothing selected."]);
    expect((await remove("snowy")).errors).toEqual(["That weather no longer exists. It may have been deleted by someone else."]);
    expect(writes()).toEqual([]);
  });

  test("a world set to it is set to clear, a random world that settled on it shows clear, and both are told", async () => {
    const result = await remove("rainy");
    expect(result.ok).toBe(true);
    // The world set to it by name is set to clear; the random one stays on random.
    expect(moved).toEqual([{ world: "main", weather: "clear" }]);
    expect(worlds.find((w) => w.name === "wilds")!.weather).toBe("random");
    const clear = { ...heldOf("clear")! };
    expect(shown).toEqual([
      { world: "main", weather: "clear", weatherData: clear },
      { world: "wilds", weather: "clear", weatherData: clear },
    ]);
    expect(result.notes).toEqual([
      "main was set to rainy and is now set to clear.",
      "wilds had settled on rainy at random and shows clear until the weather there next changes.",
    ]);
    expect(stored("rainy")).toBeUndefined();
    // The worlds the editor is sent are as they now stand.
    expect(result.data!.worlds.filter((w) => w.showing === "rainy")).toEqual([]);
  });

  test("the worlds are moved before the weather is deleted: none is left pointing at one that is gone", async () => {
    const order: string[] = [];
    editor.setWeatherEditorBridge({
      worlds: async () => worlds.map((w) => ({ ...w })),
      setWorldWeather: async (world) => { order.push(`set ${world}: ${stored("rainy") ? "there" : "gone"}`); },
      show: (world) => { order.push(`show ${world}: ${stored("rainy") ? "there" : "gone"}`); },
    });
    await remove("rainy");
    expect(order).toEqual(["set main: there", "show main: gone", "show wilds: gone"]);
  });

  test("with no clear row, the worlds are shown clear with nothing to it", async () => {
    cache.set("weather", held().filter((w) => w.name !== "clear"));
    await remove("darkness");
    expect(shown).toEqual([{ world: "cave", weather: "clear", weatherData: null }]);
  });

  test("a delete the database refuses leaves the weather, and says which worlds were already moved", async () => {
    failing = /^DELETE FROM weather/;
    const result = await remove("rainy");
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["The server could not delete rainy: Connection lost"]);
    expect(result.notes).toEqual(["main was set to rainy and is now set to clear."]);
    expect(heldOf("rainy")).toBeDefined();
    // The world that was moved is shown clear; the random world still shows the weather, which is still there.
    expect(shown.map((s) => s.world)).toEqual(["main"]);
    expect(result.changed).toBe(true);
    expect(result.data!.weathers.map((w) => w.name)).toContain("rainy");
  });

  test("a refused delete that was applied all the same is treated as the delete it was", async () => {
    failing = /^DELETE FROM weather/;
    appliedAnyway = true;
    const result = await remove("rainy");
    expect(result.ok).toBe(false);
    expect(heldOf("rainy")).toBeUndefined();
    expect(shown.map((s) => s.world)).toEqual(["main", "wilds"]);
    expect(result.data!.weathers.map((w) => w.name)).not.toContain("rainy");
  });

  test("a world that cannot be moved stops the delete", async () => {
    stuckWorld = "main";
    const result = await remove("rainy");
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["The server could not delete rainy: Connection lost"]);
    expect(writes()).toEqual([]);
    expect(heldOf("rainy")).toBeDefined();
    expect(shown).toEqual([]);
  });

  test("the same delete sent twice at once deletes once", async () => {
    const [first, second] = await Promise.all([remove("rainy"), remove("rainy")]);
    expect([first.ok, second.ok]).toEqual([true, false]);
    expect(second.errors).toEqual(["That weather no longer exists. It may have been deleted by someone else."]);
    expect(writes()).toHaveLength(1);
    expect(moved).toHaveLength(1);
  });
});

describe("the rest", () => {
  test("an unknown action is refused, with the weathers as they stand", async () => {
    const result = await act(ADMIN, "WEATHER_EDITOR_NONSENSE", {});
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["Unknown weather editor action: WEATHER_EDITOR_NONSENSE"]);
    expect(result.data!.weathers).toHaveLength(4);
    expect(writes()).toEqual([]);
  });

  test("without the socket layer there are no worlds to show a change to, and the change is still made", async () => {
    editor.setWeatherEditorBridge(null);
    const saved = await save({ ...weatherOf({ name: "rainy", wind_speed: 40 }), originalName: "rainy" });
    expect(saved.ok).toBe(true);
    expect(saved.data!.worlds).toEqual([]);
    expect((await remove("rainy")).ok).toBe(true);
    expect(heldOf("rainy")).toBeUndefined();
  });
});
