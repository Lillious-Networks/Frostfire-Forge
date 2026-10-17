/**
 * Mailbox editor: what the admin mailbox editor window (/mailbox) asks for. USER REQUEST 2026-10-16 ("Add a
 * /mailbox command to open a UI to edit where mailboxes are placed and the ability to move them"), built as the
 * other editors are (USER REQUEST 2026-10-17: "Rebuild the mailbox editor on the standard editor pattern, like
 * the NPC editor").
 *
 * A map left alone has its mailboxes in front of its inns (mail.mailboxesOn). Once its mailboxes are saved from
 * the editor, the map keeps a list of its own, one row of mailbox_spots, and the inns place none; deleting that
 * list gives the map back to its inns. An empty list is a map with no mailbox. A record of the editor is a map.
 * The editor is sent the map the admin is on and the maps they visited recently (the game remembers them and sends
 * their names); any other map is found by a search of its name, as the item editor finds items (SEARCH_LIMIT at a
 * time), never the whole list at once. USER REQUEST 2026-10-17: "You should only show recently visited maps unless
 * the developer searches for a specific map". Each change is checked, written to the table and
 * then to the cache, and answered with whether it was done and every record as it then stands. Like the other
 * editors, it reads only what the server holds, never the database.
 */
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { tableCache } from "../services/datacache";
import permissions from "./permissions";
import type { Mailbox } from "./mail";

/** The tool's own permission and the wildcards over it, as the other editors have theirs. */
export const EDITOR_PERMISSIONS = ["tools.mailbox_editor", "tools.*", "server.admin", "server.*"];
export const DENIED = "You don't have permission to use the mailbox editor.";
/** The furthest from the corner of a map (px) a mailbox is put: past any map there is. */
export const COORDINATE_MAX = 1_000_000;
/** The most maps a search sends. */
export const SEARCH_LIMIT = 50;
/** The most recently visited maps listed. */
export const RECENT_LIMIT = 10;

const sqlite = (): boolean => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";
const mapName = (map: unknown) => String(map ?? "").replaceAll(".json", "");

/** The table of mailboxes placed by hand, as the setup scripts make it: a map's spots as a JSON list. */
export const MAILBOX_SPOTS_TABLE: Record<"mysql" | "sqlite", string> = {
  mysql: `CREATE TABLE IF NOT EXISTS mailbox_spots (map VARCHAR(191) NOT NULL PRIMARY KEY, spots MEDIUMTEXT NOT NULL)`,
  sqlite: `CREATE TABLE IF NOT EXISTS mailbox_spots (map TEXT NOT NULL PRIMARY KEY, spots TEXT NOT NULL)`,
};

let ready = false;

/**
 * Start-time safety step: makes the table on a database whose setup ran before it was added, and lists
 * the tool's permission. Safe on every start, and never throws: without the table, every map keeps the
 * mailboxes its inns place, and a change is refused.
 */
export async function ensureMailboxSchema(): Promise<boolean> {
  ready = false;
  try {
    await query(MAILBOX_SPOTS_TABLE[sqlite() ? "sqlite" : "mysql"]);
    ready = true;
  } catch (error) {
    log.warn(`[Mail] The mailbox_spots table could not be made, so mailboxes stay in front of the inns: ${error}`);
  }
  // the editor's permission, so it can be granted where the permissions are picked from a list
  try {
    await query(`INSERT ${sqlite() ? "OR IGNORE" : "IGNORE"} INTO permission_types (name) VALUES ('tools.mailbox_editor')`);
  } catch {
    // no permission_types table: nothing lists them
  }
  return ready;
}

// -------------------------------------------------------------- permission

/** Admins, and anyone holding the tool's permission: the stored permissions, asked on every packet. */
export async function canUseEditor(admin: any): Promise<boolean> {
  if (!admin?.username || admin.isGuest) return false;
  if (admin.isAdmin) return true;
  const held = String((await permissions.get(admin.username)) || "").split(",").map((p) => p.trim()).filter(Boolean);
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

/** Whether a player could have the editor open, from the permissions copied at login: who is told to reload. */
export function mayHaveEditorOpen(player: any): boolean {
  if (player?.isAdmin) return true;
  const held: string[] = Array.isArray(player?.permissions) ? player.permissions : [];
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

// ---------------------------------------------------------------- the lists

interface Row { map: string; spots: string }
type Spot = { x: number; y: number };

const rows = tableCache<Row>("mailbox_spots", async () =>
  ready ? (((await query("SELECT map, spots FROM mailbox_spots")) as Row[]) || []) : []
);

/** A map's mailboxes at these spots. */
const boxesAt = (map: string, spots: Spot[]): Mailbox[] => spots.map(({ x, y }) => ({ id: `${map}:${x}:${y}`, x, y }));

/** What a row holds: its spots, or none when it cannot be read. */
function spotsOf(stored: unknown): Spot[] {
  try {
    const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
    if (Array.isArray(parsed)) {
      return parsed
        .map((spot) => ({ x: Number(spot?.x), y: Number(spot?.y) }))
        .filter((spot) => Number.isFinite(spot.x) && Number.isFinite(spot.y));
    }
  } catch {
    // read as no mailbox
  }
  return [];
}

/** The mailboxes placed by hand on a map, or null when its inns place them. */
export async function placedOn(map: unknown): Promise<Mailbox[] | null> {
  const name = mapName(map);
  if (!ready || !name) return null;
  const row = await rows.find((held) => held.map === name);
  return row ? boxesAt(name, spotsOf(row.spots)) : null;
}

/** The spots an editor sent, each a whole number of px, or why they are refused (`at`: which mailbox). */
export function readSpots(raw: unknown): { ok: true; spots: Spot[] } | { ok: false; message: string; at?: number } {
  if (!Array.isArray(raw)) return { ok: false, message: "No mailboxes were sent." };
  const spots: Spot[] = [];
  for (const [at, spot] of raw.entries()) {
    const x = Math.round(Number(spot?.x));
    const y = Math.round(Number(spot?.y));
    if (spot?.x === null || spot?.y === null || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > COORDINATE_MAX || y > COORDINATE_MAX) {
      return { ok: false, message: `X and Y must be whole numbers from 0 to ${COORDINATE_MAX}.`, at };
    }
    if (spots.some((other) => other.x === x && other.y === y)) return { ok: false, message: "Another mailbox stands on the same spot.", at };
    spots.push({ x, y });
  }
  return { ok: true, spots };
}

/** Gives a map these mailboxes, in place of the ones its inns place. */
export async function place(map: unknown, raw: unknown): Promise<{ ok: true; mailboxes: Mailbox[] } | { ok: false; message: string; at?: number }> {
  const name = mapName(map);
  if (!name) return { ok: false, message: "No map." };
  if (!ready) return { ok: false, message: "Mailboxes cannot be placed: the mailbox_spots table is missing." };
  const read = readSpots(raw);
  if (!read.ok) return read;
  const spots = JSON.stringify(read.spots);
  try {
    await query("INSERT INTO mailbox_spots (map, spots) VALUES (?, ?) ON DUPLICATE KEY UPDATE spots = ?", [name, spots, spots]);
  } catch (error) {
    await rows.drop();
    log.error(`[Mail] The mailboxes of ${name} could not be saved: ${error}`);
    return { ok: false, message: "The mailboxes could not be saved." };
  }
  await rows.put({ map: name, spots }, (held) => held.map === name);
  return { ok: true, mailboxes: boxesAt(name, read.spots) };
}

/** Lets a map's inns place its mailboxes again. */
export async function reset(map: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  const name = mapName(map);
  if (!name) return { ok: false, message: "No map." };
  if (!ready) return { ok: true };
  try {
    await query("DELETE FROM mailbox_spots WHERE map = ?", [name]);
  } catch (error) {
    await rows.drop();
    log.error(`[Mail] The mailboxes of ${name} could not be reset: ${error}`);
    return { ok: false, message: "The mailboxes could not be reset." };
  }
  await rows.remove((held) => held.map === name);
  return { ok: true };
}

// ------------------------------------------------------------------ editor

/** One record of the editor: a map, its mailboxes, and whether they were placed by hand. */
export interface EditorMap { map: string; mailboxes: Spot[]; placed: boolean }

export interface EditorData {
  /** The map the admin is on: the one whose mailboxes can be dragged in the world. */
  here: string;
  /** The map the admin is on first, then the maps they visited recently; or, for a search, the maps it found. */
  maps: EditorMap[];
  /** What was searched for: "" for none. */
  query: string;
  /** Maps found beyond the ones sent, so the editor can say to narrow the search. */
  truncated: number;
  coordinateMax: number;
  /** The table is there: changes can be saved. */
  ready: boolean;
}

/** What the server knows of the world, given by whoever calls: the receiver. */
export interface EditorWorld {
  /** The map the admin is on. */
  here: string;
  /** Where a map's mailboxes stand now: by hand, or in front of its inns. */
  mailboxesOf(map: string): Promise<Mailbox[]>;
  /** Whether there is such a map. */
  isMap(map: string): Promise<boolean>;
  /** The name of every map. */
  maps(): Promise<string[]>;
}

export type EditorAnswer =
  | { kind: "data"; data: EditorData }
  | {
    kind: "result"; ok: boolean; errors: string[]; fields?: Record<string, string>; name: string | null; notes: string[];
    denied?: boolean; data: EditorData | null;
    /** The map whose mailboxes changed: everyone on it is sent them again, and the other editors are told. */
    changed?: string;
  };

const spotsOnly = (boxes: Mailbox[]): Spot[] => boxes.map(({ x, y }) => ({ x, y }));

/**
 * The records the editor is sent. With no `query`: the map the admin is on, then the maps of `recent` (the names
 * the game remembers, newest first) that are maps, RECENT_LIMIT at most. With a query: the maps whose name has it
 * in, those that start with it first, SEARCH_LIMIT at most. `open`: the map the editor has open, sent along
 * whatever else is, so it stays open.
 */
export async function buildEditorData(world: EditorWorld, rawQuery: unknown = "", open: unknown = "", recent: unknown = []): Promise<EditorData> {
  const here = mapName(world.here);
  const query = String(rawQuery ?? "").trim().toLowerCase();
  // a map placed by hand that is not loaded (any more) is found too: it can still be given back to its inns
  const held = ready ? await rows.all() : [];
  const known = new Set([...(await world.maps()).map(mapName), ...held.map((row) => row.map)]);
  let names: string[];
  let truncated = 0;
  if (!query) {
    const visited = (Array.isArray(recent) ? recent : []).slice(0, RECENT_LIMIT * 2).map(mapName).filter((map) => known.has(map) && map !== here);
    names = [here, ...new Set(visited)].slice(0, RECENT_LIMIT + 1);
  } else {
    const found = [...known]
      .filter((map) => map.toLowerCase().includes(query))
      .sort((a, b) => {
        // names that start with what was typed are what is usually meant
        const aStarts = a.toLowerCase().startsWith(query), bStarts = b.toLowerCase().startsWith(query);
        return aStarts !== bStarts ? (aStarts ? -1 : 1) : a.localeCompare(b);
      });
    names = found.slice(0, SEARCH_LIMIT);
    truncated = Math.max(0, found.length - SEARCH_LIMIT);
  }
  const kept = mapName(open);
  if (kept) names.push(kept);
  const maps: EditorMap[] = [];
  for (const map of [...new Set(names.filter(Boolean))]) {
    const placed = await placedOn(map);
    maps.push({ map, mailboxes: spotsOnly(placed ?? await world.mailboxesOf(map)), placed: placed !== null });
  }
  return { here, maps, query, truncated, coordinateMax: COORDINATE_MAX, ready };
}

/** One packet of the editor, after its permission is checked. */
export async function handleEditorPacket(admin: any, type: string, data: any, world: EditorWorld): Promise<EditorAnswer> {
  if (!(await canUseEditor(admin))) return { kind: "result", ok: false, errors: [DENIED], notes: [], name: null, denied: true, data: null };
  if (type === "MAILBOX_EDITOR_LIST") return { kind: "data", data: await buildEditorData(world, data?.query, data?.open, data?.recent) };

  const map = mapName(data?.map);
  // the answer lists the maps as the editor has them listed: its search, and the map it has open
  const list = () => buildEditorData(world, data?.query, map, data?.recent);
  const refused = async (errors: string[], fields?: Record<string, string>): Promise<EditorAnswer> =>
    ({ kind: "result", ok: false, errors, fields, notes: [], name: map || null, data: await list() });
  if (!map) return refused(["Pick a map."]);

  if (type === "MAILBOX_EDITOR_SAVE") {
    if (!(await world.isMap(map))) return refused([`There is no map called ${map}.`]);
    const placed = await place(map, data?.mailboxes);
    if (!placed.ok) return refused([placed.message], placed.at === undefined ? undefined : { [`mailboxes.${placed.at}`]: placed.message });
    const many = placed.mailboxes.length;
    const notes = many === 0 ? ["It has no mailbox now."] : [];
    log.info(`[Mail] ${admin.username} placed ${many} mailbox(es) on ${map}.`);
    return { kind: "result", ok: true, errors: [], notes, name: map, data: await list(), changed: map };
  }

  if (type === "MAILBOX_EDITOR_DELETE") {
    if ((await placedOn(map)) === null) return refused([`The mailboxes of ${map} are already placed in front of its inns.`]);
    const done = await reset(map);
    if (!done.ok) return refused([done.message]);
    log.info(`[Mail] ${admin.username} gave the mailboxes of ${map} back to its inns.`);
    return { kind: "result", ok: true, errors: [], notes: ["Its inns place its mailboxes again."], name: map, data: await list(), changed: map };
  }

  return refused([`Unknown request ${type}.`]);
}
