/**
 * Server control panel: the admin window that stands in for the admin chat
 * commands and shows who is online and how the server is doing. It has no
 * powers of its own. Every control is one of the existing commands (or one of
 * the two admin packets), run by the receiver's own code under that command's
 * permission rule, which is checked here first and again by the command. What
 * this module adds is what a window needs and chat does not: the lists to
 * pick from, the state to show, a confirmation for what cannot be taken back,
 * and an answer to a request that arrives twice. For its dashboard it also
 * keeps, in memory only, a short history of what the server already measures
 * and the latest things admins did through it.
 */
import assetCache from "../services/assetCache";
import playerCache from "../services/playermanager";
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import player from "./player";
import permissions from "./permissions";
import lootTable from "./lootTable";
import { findOnline, oneAtATime, search as searchEditor } from "./playereditor";

export const DENIED = "You don't have permission to use the control panel.";
const NOT_ALLOWED = "You don't have permission to do that.";
const UNCONFIRMED = "That has to be confirmed in the control panel first.";
const NO_ANSWER = "The server gave no answer, so that may not have been done.";
const NO_TARGET = "Pick a player first.";
const NOT_FOUND = "Player not found.";

/** Longest broadcast: the length chat messages are held to. */
const BROADCAST_MAX = 500;
/** /drop's own ceiling for one stack. */
const DROP_MAX = 9999;
/** Ceiling for an item stack, as the player editor's. */
const GIVE_MAX = 1000000;
/** Rows of an inline chest. */
const CHEST_ENTRIES_MAX = 20;
/** The permissions column is 255 characters wide. */
const PERMISSIONS_MAX = 255;
/** How long a request id is remembered: a repeat inside this window is not run again. */
const REPEAT_WINDOW_MS = 60000;

/** Usernames are letters, digits and underscores; nothing else is looked up. */
const USERNAME = /^[a-zA-Z0-9_]{1,64}$/;
const PERMISSION_NAME = /^[a-zA-Z0-9_.*]{1,64}$/;
const AUDIENCES = ["ALL", "MAP", "ADMINS"];

/** Everything the server does at once: restart, shutdown, whitelist, broadcast, weather. */
const SERVER_KEY = "@server";
const LOOT_KEY = "@loot";

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const normMap = (map: unknown): string => String(map ?? "").replaceAll(".json", "");
/** A username as it is shown: the server stores them lower case. */
const shown = (username: unknown): string => {
  const name = String(username ?? "");
  return name.charAt(0).toUpperCase() + name.slice(1);
};

// ------------------------------------------------------------------ bridge

/**
 * What only the socket layer knows (its restart countdown, its counters, the
 * live worlds), registered by receiver.ts so this module does not import it.
 */
export interface ControlPanelBridge {
  /** Whether /restart has a countdown running. */
  restartScheduled(): boolean;
  /** Counters the server already keeps: the event loop delay, the whitelist, what /creature-stats reports. */
  status(): { eventLoopLagMs: number; whitelistEnabled: boolean; whitelisted: number; creatures: Record<string, unknown> };
  /** Every world with the weather it is set to and, where that is "random", the one being shown. */
  worlds(): Promise<Array<{ name: string; weather: string; showing: string; players: number }>>;
}

let bridge: ControlPanelBridge | null = null;

export function setControlPanelBridge(next: ControlPanelBridge | null): void {
  bridge = next;
  // The readings the dashboard charts are taken for as long as there is a server to read.
  keepReadings(!!next);
}

/**
 * What the receiver is asked to run: an admin chat command with its arguments
 * already split (they are values, never chat text to parse), or one of the
 * two admin packets.
 */
export type PanelRun = { command: string; args: string[] } | { packet: "NOCLIP" | "STEALTH" };
/** Runs it for the admin and resolves with what the command told them. */
export type RunCommand = (run: PanelRun) => Promise<string[]>;

const NOTIFY_HEAD = new TextEncoder().encode('{"type":"NOTIFY",');
const decoder = new TextDecoder();

/**
 * The receiver hands over what it is sending to an admin while one of their
 * panel commands runs. The commands answer with notifications: their text is
 * the panel's answer too.
 */
export function collectReplies(replies: string[] | undefined, packets: any[]): void {
  if (!replies) return;
  for (const packet of packets) {
    if (!(packet instanceof Uint8Array) || packet.length <= NOTIFY_HEAD.length) continue;
    if (!NOTIFY_HEAD.every((byte, i) => packet[i] === byte)) continue;
    try {
      const message = JSON.parse(decoder.decode(packet))?.data?.message;
      if (typeof message === "string" && message) replies.push(message);
    } catch {
      // Not a notification after all.
    }
  }
}

// -------------------------------------------------------------- permission

type Rule = (actor: any) => boolean | Promise<boolean>;

/** The commands' own check: one of these names, in the permissions copied at login. */
const holds = (...names: string[]): ((actor: any) => boolean) => (actor) =>
  Array.isArray(actor?.permissions) && actor.permissions.some((p: string) => names.includes(p));
/** NOCLIP and STEALTH ask only for the admin role. */
const isAdmin = (actor: any): boolean => !!actor?.isAdmin;
/** /permission asks for the command itself, then for the permission of the mode. */
const permissionMode = (...names: string[]): ((actor: any) => boolean) => (actor) =>
  holds("admin.permission", "admin.*")(actor) && holds(...names)(actor);

/**
 * The panel replaces the in-game admin panel and opens for the same people:
 * admins. Each control inside it has its command's rule on top of that.
 */
export function canUsePanel(actor: any): boolean {
  return !!actor?.username && !actor.isGuest && !!actor.isAdmin;
}

/**
 * Who the viewer may know is online. A stealthed player is shown to admins
 * only: the rule the receiver follows wherever it lists or spawns players.
 */
export function canSee(viewer: any, other: any): boolean {
  return !other?.isStealth || !!viewer?.isAdmin || other === viewer;
}

// ----------------------------------------------------------------- reading

/** A trimmed line of text no longer than `max`, or null for anything else a client can send. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Line breaks and other control characters become spaces.
  const line = Array.from(value, (c) => (c < " " || c === "\u007f" ? " " : c)).join("").trim();
  return line && line.length <= max ? line : null;
}

/** A whole number within [min, max], or null for anything else a client can send. */
function wholeNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value === "string" ? value.trim() === "" : typeof value !== "number") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** The player a request names, as the commands look them up: by username, lower case. */
function targetOf(data: any): string | null {
  const name = typeof data?.target === "string" ? data.target.trim() : "";
  return USERNAME.test(name) ? lower(name) : null;
}

async function cached<T>(key: string): Promise<T[]> {
  const value = await assetCache.get(key);
  return Array.isArray(value) ? (value as T[]) : [];
}

export function onlinePlayers(viewer: any): ControlPanelPlayer[] {
  const list: ControlPanelPlayer[] = [];
  const now = performance.now();
  for (const p of Object.values(playerCache.list() as Record<string, any>)) {
    if (!p?.username || !canSee(viewer, p)) continue;
    list.push({
      id: String(p.id),
      username: lower(p.username),
      level: Number(p.stats?.level) || 1,
      map: normMap(p.location?.map),
      isAdmin: !!p.isAdmin,
      isStealth: !!p.isStealth,
      isGuest: !!p.isGuest,
      dead: p.isDead ? 1 : p.isGhost ? 2 : 0,
      // The receiver stamps a player with the clock's reading when they log in.
      onlineFor: typeof p.created === "number" ? Math.max(0, Math.floor((now - p.created) / 1000)) : null,
    });
  }
  return list.sort((a, b) => a.username.localeCompare(b.username));
}

/** What each control's rule says for this viewer, so the panel can grey out what would be refused. */
export async function capabilities(viewer: any): Promise<Record<string, boolean>> {
  const can: Record<string, boolean> = {};
  for (const [name, action] of Object.entries(ACTIONS)) can[name] = !!(await action.allowed(viewer));
  for (const [name, rule] of Object.entries(QUERY_RULES)) can[`query.${name}`] = rule(viewer);
  // /summon refuses an admin as its target without this.
  can["player.summon.admins"] = holds("admin.summonadmins", "admin.*")(viewer);
  return can;
}

// ----------------------------------------------------------------- history

/**
 * What the dashboard charts: a reading of what the server already measures,
 * taken on a timer and kept in memory only, so a restart starts it again from
 * nothing. One reading every 15 seconds for the last hour; for the last 24
 * hours, one row a minute holding the highest of that minute's four. That is
 * 1,680 rows of five numbers: about 66 KB, set aside once.
 */
export const READING_EVERY_MS = 15000;
/** An hour of readings. */
export const RECENT_KEEP = 240;
export const READINGS_PER_MINUTE = 4;
/** 24 hours of minutes. */
export const DAY_KEEP = 1440;
/** Seconds since the epoch, players online, event loop delay in ms, memory in MB, creatures awake. */
const FIELDS = 5;

/** The last `keep` rows, the oldest written over: one block of memory that never grows. */
class Readings {
  private readonly rows: Float64Array;
  private next = 0;
  private held = 0;

  constructor(private readonly keep: number) {
    this.rows = new Float64Array(keep * FIELDS);
  }

  add(row: number[]): void {
    this.rows.set(row, this.next * FIELDS);
    this.next = (this.next + 1) % this.keep;
    if (this.held < this.keep) this.held++;
  }

  /** The rows taken after `since`, oldest first. A figure that was not known is null. */
  after(since: number): ControlPanelReading[] {
    const found: ControlPanelReading[] = [];
    for (let i = 0; i < this.held; i++) {
      const at = ((this.next - this.held + i + this.keep) % this.keep) * FIELDS;
      if (this.rows[at] <= since) continue;
      found.push(Array.from(this.rows.subarray(at, at + FIELDS), (n) => (Number.isNaN(n) ? null : n)));
    }
    return found;
  }

  clear(): void {
    this.next = 0;
    this.held = 0;
  }
}

const recent = new Readings(RECENT_KEEP);
const day = new Readings(DAY_KEEP);
/** The minute being filled: the highest of each figure so far, and how many readings that is. */
let minute: number[] | null = null;
let minuteReadings = 0;
/** The most players online at once since the server started, and when. */
let peak = { online: 0, at: 0 };
let readingTimer: ReturnType<typeof setInterval> | null = null;
let readingFailed = false;

const higher = (a: number, b: number): number => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b));

/** Everyone connected. Only admins open the panel, and an admin may see a stealthed player. */
function countOnline(): number {
  let online = 0;
  for (const p of Object.values(playerCache.list() as Record<string, any>)) if (p?.username) online++;
  return online;
}

function notePeak(online: number, now: number): void {
  if (online > peak.online) peak = { online, at: now };
}

/** Takes one reading. The timer calls it; the tests give it the time. */
export function takeReading(now = Date.now()): void {
  const extra = bridge?.status();
  const online = countOnline();
  const awake = Number(extra?.creatures?.awake);
  const row = [
    Math.floor(now / 1000),
    online,
    extra ? Math.round(extra.eventLoopLagMs * 10) / 10 : NaN,
    Math.round(process.memoryUsage().rss / 1048576),
    Number.isFinite(awake) ? awake : NaN,
  ];
  notePeak(online, now);
  recent.add(row);
  minute = minute ? minute.map((highest, i) => (i === 0 ? row[0] : higher(highest, row[i]))) : row;
  if (++minuteReadings < READINGS_PER_MINUTE) return;
  day.add(minute);
  minute = null;
  minuteReadings = 0;
}

function keepReadings(on: boolean): void {
  if (readingTimer) clearInterval(readingTimer);
  readingTimer = on
    ? setInterval(() => {
        // A reading that cannot be taken is a gap in a chart, never a reason for the server to stop.
        try {
          takeReading();
        } catch (error) {
          if (!readingFailed) log.warn(`[CONTROL_PANEL] A reading for the dashboard could not be taken: ${error}`);
          readingFailed = true;
        }
      }, READING_EVERY_MS)
    : null;
  // Never what keeps the process alive.
  readingTimer?.unref();
}

// ---------------------------------------------------------------- activity

/** How many of the latest actions the dashboard lists. */
export const ACTIVITY_KEEP = 100;
/** The values of a request that say what was done, as the actions read them. */
const SHOWN_DETAILS = ["enabled", "admin", "item", "quantity", "permission", "permissions", "audience", "message", "map", "weather", "table", "entries", "name", "id", "itemId"];
const DETAIL_MAX = 160;

const activity: ControlPanelActivity[] = [];
let activityCount = 0;

/** Remembers what an admin did through the panel: who, what, on whom, when, and what the command answered. */
function noteActivity(actor: any, action: string, target: string | undefined, data: any, said: string[]): void {
  const details: ControlPanelActivity["details"] = {};
  for (const key of SHOWN_DETAILS) {
    const value = data?.[key];
    if (typeof value === "number" || typeof value === "boolean") details[key] = value;
    else if (typeof value === "string") details[key] = value.trim().slice(0, DETAIL_MAX);
    // The names of a set of permissions; for the rows of a chest, how many.
    else if (Array.isArray(value)) details[key] = key === "permissions" ? value.map(String).join(", ").slice(0, DETAIL_MAX) : value.length;
  }
  activity.push({
    seq: ++activityCount,
    at: Date.now(),
    by: lower(actor.username),
    action,
    target: target ?? null,
    details,
    said: said.join(" ").slice(0, DETAIL_MAX * 2),
  });
  if (activity.length > ACTIVITY_KEEP) activity.splice(0, activity.length - ACTIVITY_KEEP);
}

/** What the panel says it already holds, so only what is newer is sent. */
type Since = { recent: number; day: number; activity: number };

function sinceOf(data: any): Since | null {
  if (!data?.since || typeof data.since !== "object") return null;
  const held = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return { recent: held(data.since.recent), day: held(data.since.day), activity: held(data.since.activity) };
}

/** How long the two counts of the accounts table are kept before they are asked for again. */
const TOTALS_FOR_MS = 60000;
let totals: { at: number; value: ControlPanelData["accounts"] } | null = null;

/**
 * How many accounts there are and how many of them are banned: two counts the
 * accounts table already answers. Read when a panel opens, never on its
 * refreshes. Guest accounts are temporary and not counted.
 */
async function accountTotals(): Promise<ControlPanelData["accounts"]> {
  if (totals && Date.now() - totals.at < TOTALS_FOR_MS) return totals.value;
  let value: ControlPanelData["accounts"] = null;
  try {
    const [row] = (await query(
      "SELECT COUNT(*) AS registered, SUM(CASE WHEN banned = 1 THEN 1 ELSE 0 END) AS banned FROM accounts WHERE guest_mode = ?",
      [0]
    )) as any[];
    const registered = Number(row?.registered);
    if (Number.isFinite(registered)) value = { registered, banned: Number(row.banned) || 0 };
  } catch (error) {
    log.warn(`[CONTROL_PANEL] The account totals could not be read: ${error}`);
  }
  totals = { at: Date.now(), value };
  return value;
}

/** Empties the history, the activity list and the kept totals: a clean slate for the tests. */
export function forgetHistory(): void {
  recent.clear();
  day.clear();
  minute = null;
  minuteReadings = 0;
  peak = { online: 0, at: 0 };
  activity.length = 0;
  activityCount = 0;
  totals = null;
}

/**
 * Everything the panel shows, from what the server holds in memory: it is
 * asked for every few seconds. `full` adds what does not change while the
 * panel is open (the viewer's rights, the lists its controls pick from) and
 * the whole history; a refresh that says what it holds gets what is newer.
 */
export async function buildData(viewer: any, full: boolean, since: Since | null = null): Promise<ControlPanelData> {
  const players = onlinePlayers(viewer);
  const map = normMap(viewer.location?.map);
  const extra = bridge?.status();
  const worlds = bridge ? await bridge.worlds() : [];
  const here = worlds.find((w) => w.name === map);
  notePeak(countOnline(), Date.now());

  const data: ControlPanelData = {
    viewer: {
      id: String(viewer.id),
      username: lower(viewer.username),
      map,
      isNoclip: !!viewer.isNoclip,
      isStealth: !!viewer.isStealth,
    },
    players,
    status: {
      uptime: Math.floor(process.uptime()),
      online: players.length,
      peak: { ...peak },
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      eventLoopLagMs: extra ? Math.round(extra.eventLoopLagMs) : null,
      restartScheduled: bridge ? bridge.restartScheduled() : false,
      whitelist: { enabled: !!extra?.whitelistEnabled, size: extra?.whitelisted ?? 0 },
      creatures: extra?.creatures ?? null,
    },
    world: { map, weather: here?.weather || "clear", showing: here?.showing || "clear", worlds },
  };
  if (full) {
    const [maps, weathers] = await Promise.all([cached<MapProperties>("mapProperties"), cached<WeatherData>("weather")]);
    data.can = await capabilities(viewer);
    data.options = {
      maps: maps.map((m) => normMap(m.name)).sort((a, b) => a.localeCompare(b)),
      // "clear" and "random" are /weather's own words, not rows of the weather table.
      weathers: [...new Set(["clear", "random", ...weathers.map((w) => w.name)])],
    };
    data.accounts = await accountTotals();
  }
  const from = full ? { recent: 0, day: 0, activity: 0 } : since;
  if (from) {
    const readings = { recent: recent.after(from.recent), day: day.after(from.day) };
    const done = activity.filter((entry) => entry.seq > from.activity);
    if (full || readings.recent.length || readings.day.length) data.history = readings;
    if (full || done.length) data.activity = done;
  }
  return data;
}

// ----------------------------------------------------------------- queries

/** The lists that are read on request. Each has the rule of the command it stands for. */
const QUERY_RULES: Record<string, (actor: any) => boolean> = {
  // /permission list
  permissions: permissionMode("permission.list", "permission.*"),
  // /loottable list and info
  lootTables: holds("admin.loot", "admin.*"),
};

async function lookUp(viewer: any, data: any): Promise<ControlPanelResults | string[]> {
  const kind = String(data?.kind ?? "");

  if (kind === "players") {
    // Accounts by name, for the players who are not online. Who is online is in the panel's own list.
    const query = String(data?.query ?? "").trim();
    if (!query) return { kind, query: "", players: [], truncated: 0 };
    const found = await searchEditor({ kind: "players", query });
    if (found.kind !== "players") return { kind, query: "", players: [], truncated: 0 };
    return {
      kind,
      query: found.query,
      // A stealthed player the viewer may not see reads as offline.
      players: found.players.map((p) => ({ ...p, online: p.online && canSee(viewer, findOnline(p.username)) })),
      truncated: found.truncated,
    };
  }

  if (kind === "items") {
    const found = await searchEditor({ kind: "items", query: data?.query });
    if (found.kind !== "items") return { kind, query: "", items: [], truncated: 0 };
    return { kind, query: found.query, items: found.items, truncated: found.truncated };
  }

  const rule = Object.hasOwn(QUERY_RULES, kind) ? QUERY_RULES[kind] : null;
  if (!rule) return ["The control panel does not know that list."];
  if (!rule(viewer)) return [NOT_ALLOWED];

  if (kind === "lootTables") {
    const tables = await lootTable.list();
    return { kind, tables: tables.map((t: any) => ({ id: Number(t.id), name: String(t.name), items: t.items })) };
  }

  const target = targetOf(data);
  if (!target) return [NO_TARGET];
  const account = await player.findAccount(target);
  if (!account) return [NOT_FOUND];
  const [held, types] = await Promise.all([permissions.get(target), permissions.list()]);
  return {
    kind: "permissions",
    target,
    held: String(held || "").split(",").map((p) => p.trim()).filter(Boolean),
    types,
    isAdmin: !!(await player.isAdmin(target)),
  };
}

// ----------------------------------------------------------------- actions

interface Plan {
  /** What the action is ordered on: the player it changes, or the part of the server it touches. */
  key: string;
  run: PanelRun;
  /** The player the answer is about, so their name reads as it is shown. */
  target?: string;
  /** Asked once it is this request's turn. An answer means things already stand as asked: nothing is run. */
  already?: () => string | null | Promise<string | null>;
  /** For a command that says nothing when it works: what to tell the admin, or null to pass its own words on. */
  answer?: (replies: string[]) => string | null;
}

interface PanelAction {
  /** The chat command (or admin packet) behind the control. */
  command: string;
  /** That command's own rule. */
  allowed: Rule;
  /** Cannot be taken back: the panel asks first, and the request is refused here without that. */
  confirm?: boolean;
  /** The command's arguments from the request, or what is wrong with it. */
  plan(ctx: { actor: any; data: any }): Plan | string[] | Promise<Plan | string[]>;
}

const actorKey = (actor: any): string => `@actor:${actor.id}`;
/** A command that answers only when it refuses. */
const unlessRefused = (said: string) => (replies: string[]): string | null => (replies.length ? null : said);

/** A command that takes the player and nothing else. */
function onPlayer(command: string, allowed: Rule, confirm = false): PanelAction {
  return {
    command,
    allowed,
    confirm,
    plan: ({ data }) => {
      const target = targetOf(data);
      return target ? { key: target, target, run: { command, args: [target] } } : [NO_TARGET];
    },
  };
}

/**
 * NOCLIP and STEALTH flip what the admin has. The panel asks for on or off,
 * and the packet is only sent when that is not how things stand: a doubled
 * click would otherwise switch it on and straight back off.
 */
function ownSwitch(packet: "NOCLIP" | "STEALTH", flag: "isNoclip" | "isStealth", label: string): PanelAction {
  return {
    command: packet,
    allowed: isAdmin,
    plan: ({ actor, data }) => {
      if (typeof data?.enabled !== "boolean") return [`${label} must be on or off.`];
      const wanted: boolean = data.enabled;
      const state = wanted ? "on" : "off";
      return {
        key: actorKey(actor),
        run: { packet },
        already: () => (!!actor[flag] === wanted ? `${label} is already ${state}.` : null),
        answer: () => (!!actor[flag] === wanted ? `${label} is ${state}.` : null),
      };
    },
  };
}

/** One permission name, as /permission add and remove take them. */
function onePermission(mode: "ADD" | "REMOVE"): PanelAction["plan"] {
  return ({ data }) => {
    const target = targetOf(data);
    if (!target) return [NO_TARGET];
    const name = typeof data?.permission === "string" ? data.permission.trim() : "";
    if (!PERMISSION_NAME.test(name)) return ["Pick a permission."];
    return { key: target, target, run: { command: "PERMISSION", args: [mode, target, name] } };
  };
}

function itemAndAmount(data: any, max: number): { item: string; quantity: number } | string[] {
  const item = text(data?.item, 100);
  const quantity = wholeNumber(data?.quantity ?? 1, 1, max);
  const errors: string[] = [];
  if (!item) errors.push("Pick an item.");
  if (quantity === null) errors.push(`The amount must be a whole number from 1 to ${max}.`);
  return item && quantity !== null ? { item, quantity } : errors;
}

/** The numbers of one loot row, as /loottable and /spawnchest take them. */
function lootNumbers(data: any): { min: number; max: number; chance: number } | string[] {
  const min = wholeNumber(data?.min, 1, DROP_MAX);
  const max = wholeNumber(data?.max, 1, DROP_MAX);
  const chance = typeof data?.chance === "number" && data.chance >= 0 && data.chance <= 100 ? data.chance : null;
  const errors: string[] = [];
  if (min === null || max === null) errors.push(`Amounts must be whole numbers from 1 to ${DROP_MAX}.`);
  else if (min > max) errors.push("The smallest amount cannot be more than the largest.");
  if (chance === null) errors.push("The drop chance must be from 0 to 100.");
  return min !== null && max !== null && chance !== null && errors.length === 0 ? { min, max, chance } : errors;
}

const loot = (plan: (data: any) => string[] | { args: string[] }, confirm = false): PanelAction => ({
  command: "LOOTTABLE",
  allowed: holds("admin.loot", "admin.*"),
  confirm,
  plan: ({ data }) => {
    const built = plan(data);
    return Array.isArray(built) ? built : { key: LOOT_KEY, run: { command: "LOOTTABLE", args: built.args } };
  },
});

const QUALITY = /^[a-z_]{1,32}$/;

/**
 * Every control of the panel. The key is what the panel sends; `command` and
 * `allowed` are the chat command it stands for and that command's rule.
 */
export const ACTIONS: Record<string, PanelAction> = {
  "self.noclip": ownSwitch("NOCLIP", "isNoclip", "Noclip"),
  "self.stealth": ownSwitch("STEALTH", "isStealth", "Stealth"),

  "player.summon": onPlayer("SUMMON", holds("admin.summon", "admin.*")),
  // /goto and /teleport ask for the summon permission.
  "player.goto": onPlayer("TELEPORT", holds("admin.summon", "admin.*")),
  "player.respawn": onPlayer("RESPAWN", holds("admin.respawn", "admin.*")),
  "player.revive": onPlayer("REVIVE", holds("admin.revive", "admin.*")),
  "player.kill": onPlayer("KILL", holds("admin.kill", "admin.*"), true),
  "player.kick": onPlayer("KICK", holds("admin.kick", "admin.*"), true),
  "player.ban": onPlayer("BAN", holds("admin.ban", "admin.*"), true),
  "player.unban": {
    command: "UNBAN",
    allowed: holds("admin.unban", "admin.*"),
    plan: async ({ data }) => {
      const target = targetOf(data);
      if (!target) return [NO_TARGET];
      // A name with no account is answered here, in the same words as every other player action.
      if (!(await player.findAccount(target))) return [NOT_FOUND];
      return {
        key: target,
        target,
        run: { command: "UNBAN", args: [target] },
        already: async () => (Number((await player.findAccount(target))?.banned) === 1 ? null : `${shown(target)} is not banned.`),
      };
    },
  },
  "player.admin": {
    command: "ADMIN",
    allowed: holds("server.admin", "server.*"),
    confirm: true,
    plan: async ({ data }) => {
      const target = targetOf(data);
      if (!target) return [NO_TARGET];
      if (typeof data?.admin !== "boolean") return ["Admin must be on or off."];
      // A name with no account is answered here, before the role is read.
      if (!(await player.findAccount(target))) return [NOT_FOUND];
      const wanted: boolean = data.admin;
      return {
        key: target,
        target,
        run: { command: "ADMIN", args: [target] },
        // /admin flips the role: it is only run when that lands on what was asked for.
        already: async () => ((await player.isAdmin(target)) === wanted ? `${shown(target)} is ${wanted ? "already an admin" : "not an admin"}.` : null),
      };
    },
  },
  "player.give": {
    command: "GIVE",
    allowed: holds("admin.items", "admin.*"),
    plan: ({ data }) => {
      const target = targetOf(data);
      if (!target) return [NO_TARGET];
      const given = itemAndAmount(data, GIVE_MAX);
      if (Array.isArray(given)) return given;
      return { key: target, target, run: { command: "GIVE", args: [target, given.item, String(given.quantity)] } };
    },
  },

  "permission.add": { command: "PERMISSION", allowed: permissionMode("permission.add", "permission.*"), confirm: true, plan: onePermission("ADD") },
  "permission.remove": { command: "PERMISSION", allowed: permissionMode("permission.remove", "permission.*"), confirm: true, plan: onePermission("REMOVE") },
  "permission.set": {
    command: "PERMISSION",
    allowed: permissionMode("permission.add", "permission.*"),
    confirm: true,
    plan: ({ data }) => {
      const target = targetOf(data);
      if (!target) return [NO_TARGET];
      if (!Array.isArray(data?.permissions)) return ["No permissions were given."];
      const names = [...new Set((data.permissions as unknown[]).map((p) => String(p).trim()))];
      // /permission set has no way to say "none": that is what clear is for.
      if (names.length === 0) return ["Use Clear all to take every permission away."];
      if (names.some((name) => !PERMISSION_NAME.test(name))) return ["One of those is not a permission."];
      if (names.join(",").length > PERMISSIONS_MAX) return ["That is more permissions than one player can hold."];
      return { key: target, target, run: { command: "PERMISSION", args: ["SET", target, names.join(",")] } };
    },
  },
  "permission.clear": {
    command: "PERMISSION",
    allowed: permissionMode("permission.remove", "permission.*"),
    confirm: true,
    plan: ({ data }) => {
      const target = targetOf(data);
      return target ? { key: target, target, run: { command: "PERMISSION", args: ["CLEAR", target] } } : [NO_TARGET];
    },
  },

  "server.broadcast": {
    command: "BROADCAST",
    allowed: holds("server.notify", "server.*"),
    plan: ({ data }) => {
      const audience = String(data?.audience ?? "").toUpperCase();
      if (!AUDIENCES.includes(audience)) return ["Pick who the message is for."];
      const message = text(data?.message, BROADCAST_MAX);
      if (!message) return [`Type a message of up to ${BROADCAST_MAX} characters.`];
      return {
        key: SERVER_KEY,
        run: { command: "BROADCAST", args: [audience, message] },
        // The admin is one of the players it went to: getting it back is the proof it was sent.
        answer: (replies) => (replies.includes(message) ? "Message sent." : null),
      };
    },
  },
  "server.whitelist.add": whitelist("add"),
  "server.whitelist.remove": whitelist("remove"),
  "server.restart": {
    command: "RESTART",
    allowed: holds("server.restart", "server.*"),
    confirm: true,
    plan: () => ({
      key: SERVER_KEY,
      run: { command: "RESTART", args: [] },
      // /restart starts the countdown or stops it, whichever is not the case: it is only run when that starts one.
      already: () => (bridge?.restartScheduled() ? "A restart is already scheduled." : null),
      answer: () => (bridge?.restartScheduled() ? "A restart is scheduled in 15 minutes. Players see the countdown." : null),
    }),
  },
  "server.restart.cancel": {
    command: "RESTART",
    allowed: holds("server.restart", "server.*"),
    plan: () => ({
      key: SERVER_KEY,
      run: { command: "RESTART", args: [] },
      already: () => (bridge?.restartScheduled() ? null : "No restart is scheduled."),
      answer: () => (bridge?.restartScheduled() ? null : "The restart was cancelled. Players have been told."),
    }),
  },
  "server.shutdown": {
    command: "SHUTDOWN",
    allowed: holds("server.shutdown", "server.*"),
    confirm: true,
    plan: () => ({ key: SERVER_KEY, run: { command: "SHUTDOWN", args: [] } }),
  },

  "world.reloadmap": {
    command: "RELOADMAP",
    allowed: holds("admin.reloadmap", "admin.*"),
    plan: ({ data }) => {
      const map = mapOf(data);
      return map ? { key: SERVER_KEY, run: { command: "RELOADMAP", args: [map] } } : ["Pick a map."];
    },
  },
  "world.warp": {
    command: "WARP",
    allowed: holds("admin.warp", "admin.*"),
    plan: ({ actor, data }) => {
      const map = mapOf(data);
      return map ? { key: actorKey(actor), run: { command: "WARP", args: [map] }, answer: unlessRefused(`Warped to ${map}.`) } : ["Pick a map."];
    },
  },
  "world.weather": {
    command: "WEATHER",
    allowed: holds("admin.weather", "admin.*"),
    plan: ({ data }) => {
      const weather = lower(text(data?.weather, 64));
      return weather ? { key: SERVER_KEY, run: { command: "WEATHER", args: [weather] } } : ["Pick a weather."];
    },
  },

  "item.drop": {
    command: "DROP",
    allowed: holds("admin.items", "admin.*"),
    plan: ({ actor, data }) => {
      const dropped = itemAndAmount(data, DROP_MAX);
      if (Array.isArray(dropped)) return dropped;
      return { key: actorKey(actor), run: { command: "DROP", args: [dropped.item, String(dropped.quantity)] } };
    },
  },
  "chest.spawn": {
    command: "SPAWNCHEST",
    allowed: holds("admin.items", "admin.*"),
    plan: ({ actor, data }) => {
      const key = actorKey(actor);
      if (data?.table !== undefined) {
        const table = wholeNumber(data.table, 1, Number.MAX_SAFE_INTEGER);
        return table === null ? ["Pick a loot table."] : { key, run: { command: "SPAWNCHEST", args: ["table", String(table)] } };
      }
      const entries: unknown[] = Array.isArray(data?.entries) ? data.entries : [];
      if (entries.length === 0 || entries.length > CHEST_ENTRIES_MAX) return [`A chest holds 1 to ${CHEST_ENTRIES_MAX} kinds of item.`];
      const args = ["inline"];
      for (const entry of entries as any[]) {
        const item = text(entry?.item, 100);
        const numbers = lootNumbers(entry);
        if (!item) return ["Every row needs an item."];
        if (Array.isArray(numbers)) return numbers;
        args.push(item, String(numbers.min), String(numbers.max), String(numbers.chance));
      }
      return { key, run: { command: "SPAWNCHEST", args } };
    },
  },

  "loot.create": loot((data) => {
    const name = text(data?.name, 64);
    return name ? { args: ["create", name] } : ["Give the loot table a name."];
  }),
  "loot.delete": loot((data) => {
    const id = wholeNumber(data?.id, 1, Number.MAX_SAFE_INTEGER);
    return id === null ? ["Pick a loot table."] : { args: ["delete", String(id)] };
  }, true),
  "loot.additem": loot((data) => {
    const id = wholeNumber(data?.id, 1, Number.MAX_SAFE_INTEGER);
    const item = text(data?.item, 100);
    const numbers = lootNumbers(data);
    const quality = data?.quality === undefined ? "common" : String(data.quality);
    if (id === null) return ["Pick a loot table."];
    if (!item) return ["Pick an item."];
    if (Array.isArray(numbers)) return numbers;
    if (!QUALITY.test(quality)) return ["Pick a quality."];
    return { args: ["additem", String(id), item, String(numbers.min), String(numbers.max), String(numbers.chance), quality] };
  }),
  "loot.removeitem": loot((data) => {
    const id = wholeNumber(data?.itemId, 1, Number.MAX_SAFE_INTEGER);
    return id === null ? ["Pick a row of the loot table."] : { args: ["removeitem", String(id)] };
  }),
  "loot.updateitem": loot((data) => {
    const id = wholeNumber(data?.itemId, 1, Number.MAX_SAFE_INTEGER);
    const numbers = lootNumbers(data);
    const quality = data?.quality === undefined ? "common" : String(data.quality);
    if (id === null) return ["Pick a row of the loot table."];
    if (Array.isArray(numbers)) return numbers;
    if (!QUALITY.test(quality)) return ["Pick a quality."];
    return { args: ["updateitem", String(id), String(numbers.min), String(numbers.max), String(numbers.chance), quality] };
  }),
};

function whitelist(mode: "add" | "remove"): PanelAction {
  return {
    command: "WHITELIST",
    allowed: holds("admin.whitelist", "admin.*"),
    plan: ({ data }) => {
      const target = targetOf(data);
      return target ? { key: SERVER_KEY, target, run: { command: "WHITELIST", args: [mode, target] } } : ["Type a username."];
    },
  };
}

/** A map name as /warp and /reloadmap compare it: lower case, without the file extension. */
function mapOf(data: any): string | null {
  const map = lower(normMap(text(data?.map, 100))).trim();
  return map && !/\s/.test(map) ? map : null;
}

/** The commands that write the player's name as stored: it is shown with its capital. */
function withShownName(replies: string[], target: string | undefined): string[] {
  if (!target) return replies;
  const name = new RegExp(`(^|[^A-Za-z0-9_])${target}(?![A-Za-z0-9_])`, "g");
  return replies.map((reply) => reply.replace(name, (_all, before: string) => before + shown(target)));
}

// ----------------------------------------------------------------- repeats

/** Request ids seen lately, by admin: `id of the connection:request id` to when it came in. */
const seen = new Map<string, number>();

/**
 * True for a request id this admin has already sent. Every click has its own
 * id, so a second arrival is the same click delivered twice and is not run
 * again. Remembered before anything is awaited: the two can arrive together.
 */
function isRepeat(actor: any, requestId: string): boolean {
  const now = Date.now();
  for (const [key, at] of seen) {
    if (now - at > REPEAT_WINDOW_MS) seen.delete(key);
  }
  const key = `${actor.id}:${requestId}`;
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

// ---------------------------------------------------------------- dispatch

export type PanelResult =
  | { kind: "data"; data: ControlPanelData }
  | { kind: "results"; data: ControlPanelResults }
  | { kind: "result"; data: ControlPanelResult };

/**
 * Dispatch for every CONTROL_PANEL_* packet. Who is asking is checked here on
 * every packet, and each action's own rule before anything is run, so no
 * caller reaches a command without both. `run` is the receiver running one
 * command for this admin.
 */
export async function handlePanelPacket(actor: any, type: string, data: any, run: RunCommand): Promise<PanelResult> {
  const action = type === "CONTROL_PANEL_ACTION" ? String(data?.action ?? "") : type === "CONTROL_PANEL_QUERY" ? "query" : "load";
  const requestId = typeof data?.requestId === "string" && data.requestId ? data.requestId.slice(0, 64) : null;
  const result = (ok: boolean, said: string[], extra: Partial<ControlPanelResult> = {}): PanelResult =>
    ({ kind: "result", data: { ok, errors: ok ? [] : said, replies: ok ? said : [], action, requestId, ...extra } });
  const fail = (errors: string[]): PanelResult => result(false, errors);

  if (!canUsePanel(actor)) {
    log.warn(`[CONTROL_PANEL] ${actor?.username} was refused ${action}`);
    return result(false, [DENIED], { denied: true });
  }

  if (type === "CONTROL_PANEL_LOAD") return { kind: "data", data: await buildData(actor, data?.full === true, sinceOf(data)) };
  if (type === "CONTROL_PANEL_QUERY") {
    const found = await lookUp(actor, data);
    return Array.isArray(found) ? fail(found) : { kind: "results", data: found };
  }
  if (type !== "CONTROL_PANEL_ACTION") return fail([`Unknown control panel request: ${type}`]);

  const definition = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!definition) return fail([`Unknown control panel action: ${action}`]);
  if (!requestId) return fail(["That request could not be told apart from a repeat, so it was not run."]);
  if (isRepeat(actor, requestId)) return result(false, [], { duplicate: true });

  if (!(await definition.allowed(actor))) {
    log.warn(`[CONTROL_PANEL] ${actor.username} was refused ${action}`);
    return fail([NOT_ALLOWED]);
  }
  if (definition.confirm && data?.confirm !== true) return fail([UNCONFIRMED]);

  const plan = await definition.plan({ actor, data });
  if (Array.isArray(plan)) return fail(plan);

  const carryOut = async (): Promise<PanelResult> => {
    let said: string[];
    try {
      const already = plan.already ? await plan.already() : null;
      if (already) return result(true, [already], { data: await buildData(actor, false) });
      const replies = await run(plan.run);
      const own = plan.answer ? plan.answer(replies) : null;
      said = own ? [own] : withShownName(replies, plan.target);
    } catch (error) {
      log.error(`[CONTROL_PANEL] ${action} by ${actor.username} failed: ${error}`);
      return fail(["That failed on the server."]);
    }
    if (said.length === 0) return fail([NO_ANSWER]);
    const details = { ...data };
    delete details.action;
    delete details.requestId;
    delete details.confirm;
    log.info(`[CONTROL_PANEL] ${actor.username} (${actor.id}) ran ${action}: ${JSON.stringify(details).slice(0, 300)}`);
    noteActivity(actor, action, plan.target, details, said);
    // The fresh state with the answer: the panel shows what the server has now.
    return result(true, said, { data: await buildData(actor, false) });
  };

  // One command at a time for this admin (its answer is read off their
  // connection), and one change at a time for whatever it changes: two
  // admins, or this panel and the player editor, are ordered too.
  const mine = actorKey(actor);
  return oneAtATime(mine, () => (plan.key === mine ? carryOut() : oneAtATime(plan.key, carryOut)));
}
