/**
 * Weather editor: what the admin weather editor window (/we) asks for. A world
 * refers to its weather by name, and the client picks what it draws by that
 * name too, so a weather's name is fixed once it exists. Each change is
 * checked, carried out through systems/weather (the table, then the list
 * held), shown at once to the players of every world that shows that weather,
 * and answered with whether it was done and every weather as it then stands.
 */
import log from "../modules/logger";
import assetCache from "../services/assetCache";
import permissions from "./permissions";
import weather from "./weather";
import { WEATHER_API } from "./weatherapi";

/** The tool's own permission and the wildcards over it, as the spell editor has its own. */
export const EDITOR_PERMISSIONS = ["tools.weather_editor", "tools.*", "server.admin", "server.*"];
export const DENIED = "You don't have permission to use the weather editor.";

/** Column size of worlds.weather, which holds a weather's name: a longer one could not be given to a world. */
export const NAME_MAX = 45;
/** The values of weather.wind_direction. */
export const DIRECTIONS = ["none", "left", "right", "up", "down"];
/**
 * /weather's own words, and what a world or a particle with no weather is
 * given: never the name of a weather. "weather_api" is the real weather
 * (systems/weatherapi.ts), which has no row.
 */
export const RESERVED = ["random", "none", WEATHER_API];
/** What a world with no weather shows, and what a world falls back to when its weather is deleted. */
export const FALLBACK = "clear";
/** Weathers that cannot be deleted: the server falls back to it by name. */
export const PROTECTED = [FALLBACK];

/**
 * Lower case letters, digits, underscores and hyphens: /weather reads the
 * name as one word and in lower case, so no other name could be given to a world.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Limits of a numeric column, as the editor is sent and held to them. */
export interface NumberRule {
  label: string;
  min: number;
  max: number;
}

export const NUMBER_FIELDS: Record<string, NumberRule> = {
  temperature: { label: "Temperature", min: -100, max: 200 },
  humidity: { label: "Humidity", min: 0, max: 100 },
  wind_speed: { label: "Wind speed", min: 0, max: 100 },
  precipitation: { label: "Precipitation", min: 0, max: 100 },
  ambience: { label: "Ambience", min: 0, max: 1 },
};

const GONE = "That weather no longer exists. It may have been deleted by someone else.";

const lower = (s: unknown): string => String(s ?? "").toLowerCase();

/** Names in a sentence: "main", "main and forest", "main, forest and cave". */
function listed(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// -------------------------------------------------------------- permission

/**
 * Admins, and anyone holding the tool's permission: the rule of the spell
 * editor. The permissions are the stored ones, asked for on every packet, not
 * the copy made at login.
 */
export async function canUseEditor(admin: any): Promise<boolean> {
  if (!admin?.username || admin.isGuest) return false;
  if (admin.isAdmin) return true;
  const held = String((await permissions.get(admin.username)) || "").split(",").map((p) => p.trim()).filter(Boolean);
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

/**
 * Whether a player could have the editor open, from the permissions copied at
 * login. Only used to pick who is told to reload after a change.
 */
export function mayHaveEditorOpen(player: any): boolean {
  if (player?.isAdmin) return true;
  const held: string[] = Array.isArray(player?.permissions) ? player.permissions : [];
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

// ------------------------------------------------------------------ worlds

/** A world with the weather it is set to and the one it shows: the same, but for a world on "random". */
export interface WorldWeather {
  name: string;
  weather: string;
  showing: string;
}

/** What the editor needs from the socket layer, which holds what each "random" world settled on and the connections. */
export interface WeatherEditorBridge {
  worlds(): Promise<WorldWeather[]>;
  /** Sets a world's weather, as /weather does. Nobody is told. */
  setWorldWeather(world: string, weather: string): Promise<void>;
  /**
   * `weather` is what the world shows from now on: a "random" world has
   * settled on it, and every player there is sent CHANGE_WEATHER.
   */
  show(world: string, weather: string, weatherData: WeatherData | null): void;
}

let bridge: WeatherEditorBridge | null = null;

export function setWeatherEditorBridge(next: WeatherEditorBridge | null): void {
  bridge = next;
}

// ----------------------------------------------------------------- reading

/** The weathers held: every row of the table, read at startup and kept in step by systems/weather. */
async function held(): Promise<WeatherData[]> {
  const list = await assetCache.get("weather");
  return Array.isArray(list) ? (list as WeatherData[]) : [];
}

/** A weather as the editor is sent it: its columns, the numbers as numbers. */
function toEditorWeather(row: WeatherData): WeatherData {
  return {
    name: String(row.name),
    temperature: Number(row.temperature) || 0,
    humidity: Number(row.humidity) || 0,
    wind_speed: Number(row.wind_speed) || 0,
    wind_direction: String(row.wind_direction ?? "none"),
    precipitation: Number(row.precipitation) || 0,
    ambience: Number(row.ambience) || 0,
  };
}

export interface WeatherEditorData {
  weathers: WeatherData[];
  /** Every world with the weather it is set to and the one it shows now. */
  worlds: WorldWeather[];
  directions: string[];
  numbers: Record<string, NumberRule>;
  nameMax: number;
  reserved: string[];
  /** Weathers that cannot be deleted. */
  protected: string[];
  /** What a world is given when its weather is deleted. */
  fallback: string;
}

/** Everything the editor shows: the weathers as they stand, where each is shown, and the rules a save is held to. */
export async function buildEditorData(): Promise<WeatherEditorData> {
  return {
    weathers: (await held()).filter((w) => w?.name).map(toEditorWeather).sort((a, b) => a.name.localeCompare(b.name)),
    worlds: bridge ? await bridge.worlds() : [],
    directions: DIRECTIONS,
    numbers: NUMBER_FIELDS,
    nameMax: NAME_MAX,
    reserved: RESERVED,
    protected: PROTECTED,
    fallback: FALLBACK,
  };
}

// -------------------------------------------------------------- validation

export interface FieldError {
  field: string;
  message: string;
}

/**
 * What is wrong with a weather sent by the editor, by field. The name is only
 * checked for a new one: an existing weather keeps the name it has.
 */
export function validateWeather(data: any, ctx: { existingNames: Set<string>; originalName: string | null }): FieldError[] {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => {
    if (!errors.some((e) => e.field === field)) errors.push({ field, message });
  };

  if (ctx.originalName === null) {
    const name = typeof data?.name === "string" ? data.name.trim() : "";
    if (!name) add("name", "Name is required.");
    else if (name.length > NAME_MAX) add("name", `Name must be ${NAME_MAX} characters or fewer.`);
    else if (!NAME_PATTERN.test(name)) add("name", "Name can hold lower case letters, digits, underscores and hyphens, and starts with a letter or a digit.");
    else if (RESERVED.includes(name)) add("name", `"${name}" is a word of the /weather command, not a weather.`);
    else if (ctx.existingNames.has(lower(name))) add("name", "A weather with that name already exists.");
  }

  if (typeof data?.wind_direction !== "string" || !DIRECTIONS.includes(data.wind_direction)) {
    add("wind_direction", `Wind direction must be one of ${listed(DIRECTIONS)}.`);
  }

  for (const [key, rule] of Object.entries(NUMBER_FIELDS)) {
    const value = data?.[key];
    if (typeof value !== "number" || !Number.isFinite(value)) add(key, `${rule.label} must be a number.`);
    else if (value < rule.min || value > rule.max) add(key, `${rule.label} must be between ${rule.min} and ${rule.max}.`);
  }
  return errors;
}

// ----------------------------------------------------------------- changes

/** How a change ended: what is wrong, or nothing when it was made. */
interface Outcome {
  errors: string[];
  /** Problems by field, for the editor to show next to each one. */
  fields?: Record<string, string>;
  /** The weather saved or deleted. */
  name?: string;
  /** What else came of it, in sentences: the worlds shown the change, the worlds moved to another weather. */
  notes?: string[];
  /** The weathers changed: other open editors should reload. */
  changed?: boolean;
}

const refuse = (...errors: string[]): Outcome => ({ errors });

function invalid(errors: FieldError[]): Outcome {
  const fields: Record<string, string> = {};
  for (const error of errors) fields[error.field] ??= error.message;
  return { errors: errors.map((e) => e.message), fields };
}

/** Insert or update through systems/weather, then show the weather as saved on every world that shows it. */
async function saveWeather(admin: any, data: any): Promise<Outcome> {
  const list = await held();
  const originalName = typeof data?.originalName === "string" && data.originalName ? data.originalName : null;
  if (originalName !== null && !list.some((w) => w.name === originalName)) return refuse(GONE);

  const errors = validateWeather(data, { existingNames: new Set(list.map((w) => lower(w.name))), originalName });
  if (errors.length) return invalid(errors);

  // The name is the key and does not change.
  const row: WeatherData = {
    name: originalName ?? String(data.name).trim(),
    temperature: data.temperature,
    humidity: data.humidity,
    wind_speed: data.wind_speed,
    wind_direction: data.wind_direction,
    precipitation: data.precipitation,
    ambience: data.ambience,
  };
  if (originalName !== null) await weather.update(row);
  else await weather.add(row);

  const saved = (await held()).find((w) => w.name === row.name);
  if (!saved) return refuse("The server did not keep the weather.");
  log.info(`[WEATHER EDITOR] ${admin.username} ${originalName === null ? "created" : "saved"} weather ${saved.name}`);

  // A world set to this weather, and a "random" world that settled on it, shows it as it now is.
  const showing = (bridge ? await bridge.worlds() : []).filter((world) => world.showing === saved.name).map((world) => world.name);
  for (const world of showing) bridge!.show(world, saved.name, saved);
  return {
    errors: [],
    name: saved.name,
    changed: true,
    notes: [
      showing.length > 0
        ? `Showing now on ${listed(showing)}: the players there see the change.`
        : `No world shows ${saved.name} right now. /weather ${saved.name} sets the world you are in to it.`,    ],
  };
}

/**
 * Delete a weather. A world set to it is set to "clear" first, a "random"
 * world that settled on it shows "clear" until it next changes, and the
 * players of both are shown that.
 */
async function deleteWeather(admin: any, data: any): Promise<Outcome> {
  const name = typeof data?.name === "string" ? data.name : "";
  if (!name) return refuse("Nothing selected.");
  const row = (await held()).find((w) => w.name === name);
  if (!row) return refuse(GONE);
  if (PROTECTED.includes(lower(name))) {
    return refuse(`${name} cannot be deleted: it is what a world with no weather shows, and what a world falls back to when its weather is deleted.`);
  }

  const worlds = bridge ? await bridge.worlds() : [];
  const set = worlds.filter((world) => world.weather === name).map((world) => world.name);
  const settled = worlds.filter((world) => world.weather !== name && world.showing === name).map((world) => world.name);

  const moved: string[] = [];
  let failure: unknown = null;
  try {
    // The worlds first: a world never points at a weather that is gone.
    for (const world of set) {
      await bridge!.setWorldWeather(world, FALLBACK);
      moved.push(world);
    }
    await weather.remove(row);
  } catch (error) {
    failure = error;
  }

  // A statement that threw may still have been applied: what is held now says whether the weather is gone.
  const left = await held();
  const gone = !left.some((w) => w.name === name);
  const fallback = left.find((w) => w.name === FALLBACK) ?? null;
  const told = [...moved, ...(gone ? settled : [])];
  for (const world of told) bridge!.show(world, FALLBACK, fallback);

  const notes: string[] = [];
  if (moved.length > 0) notes.push(`${listed(moved)} ${moved.length === 1 ? "was" : "were"} set to ${name} and ${moved.length === 1 ? "is" : "are"} now set to ${FALLBACK}.`);
  if (gone && settled.length > 0) notes.push(`${listed(settled)} had settled on ${name} at random and ${settled.length === 1 ? "shows" : "show"} ${FALLBACK} until the weather there next changes.`);

  if (failure) {
    log.error(`Weather editor could not delete ${name}: ${failure}`);
    return { errors: [`The server could not delete ${name}: ${(failure as Error)?.message ?? failure}`], notes, changed: gone || moved.length > 0 };
  }
  if (!gone) return { errors: [`The server did not delete ${name}.`], notes, changed: moved.length > 0 };

  log.info(`[WEATHER EDITOR] ${admin.username} deleted weather ${name}${told.length > 0 ? ` (${listed(told)} now ${told.length === 1 ? "shows" : "show"} ${FALLBACK})` : ""}`);
  return { errors: [], name, changed: true, notes };
}

/**
 * Changes run one at a time. Each is a check followed by a write, and the
 * database layer has no transactions: two saves of one name, or the same
 * request arriving twice, must not both pass the check before either writes.
 */
let changes: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = changes.then(work, work);
  changes = run.catch(() => {});
  return run;
}

export interface ActionResult {
  kind: "result";
  ok: boolean;
  /** Why it was not done, in sentences. Empty when it was. */
  errors: string[];
  fields?: Record<string, string>;
  name?: string;
  notes: string[];
  denied?: boolean;
  changed?: boolean;
  /** Every weather as it now stands. Null when nothing was read: the sender may not use the editor. */
  data: WeatherEditorData | null;
}

export type EditorResult = { kind: "data"; data: WeatherEditorData } | ActionResult;

/** One change, made or refused, answered with the weathers as they then stand. */
function change(type: string, work: () => Promise<Outcome>): Promise<ActionResult> {
  return oneAtATime(async () => {
    let outcome: Outcome;
    try {
      outcome = await work();
    } catch (error) {
      log.error(`Weather editor ${type} failed: ${error}`);
      outcome = refuse(`The server could not do that: ${(error as Error)?.message ?? error}`);
    }
    return {
      kind: "result",
      ok: outcome.errors.length === 0,
      errors: outcome.errors,
      fields: outcome.fields,
      name: outcome.name,
      notes: outcome.notes ?? [],
      changed: outcome.changed,
      data: await buildEditorData(),
    };
  });
}

/** Dispatch for every WEATHER_EDITOR_* packet. Permission is checked here, on each one. */
export async function handleEditorPacket(admin: any, type: string, data: any): Promise<EditorResult> {
  if (!(await canUseEditor(admin))) return { kind: "result", ok: false, errors: [DENIED], notes: [], denied: true, data: null };
  switch (type) {
    case "WEATHER_EDITOR_LIST":
      return { kind: "data", data: await buildEditorData() };
    case "WEATHER_EDITOR_SAVE":
      return change(type, () => saveWeather(admin, data));
    case "WEATHER_EDITOR_DELETE":
      return change(type, () => deleteWeather(admin, data));
    default:
      return change(type, async () => refuse(`Unknown weather editor action: ${type}`));
  }
}
