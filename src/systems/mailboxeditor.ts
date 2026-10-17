/**
 * Mailbox editor: where an admin places the mailboxes of the map they are on (/mailbox). USER REQUEST
 * 2026-10-16 ("Add a /mailbox command to open a UI to edit where mailboxes are placed and the ability to
 * move them"). A map left alone has its mailboxes in front of its inns (mail.mailboxesOn). Once one is
 * added, moved or removed there, the map keeps a list of its own, one row of mailbox_spots, and the inns
 * place none; a reset takes the row away and the inns place them again. An empty list is a map with no
 * mailbox. The lists are read from the cache, and written to the database and then to the cache.
 */
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { tableCache } from "../services/datacache";
import permissions from "./permissions";
import type { Mailbox } from "./mail";

/** The tool's own permission and the wildcards over it, as the other editors have theirs. */
export const EDITOR_PERMISSIONS = ["tools.mailbox_editor", "tools.*", "server.admin", "server.*"];
export const DENIED = "You don't have permission to use the mailbox editor.";
/** The most mailboxes one map is given by hand. */
export const MAILBOXES_MAX = 50;
/** The furthest from the corner of a map (px) a mailbox is put: past any map there is. */
const COORDINATE_MAX = 1_000_000;

const sqlite = (): boolean => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";
const mapName = (map: unknown) => String(map ?? "").replaceAll(".json", "");

/** The table of mailboxes placed by hand, as the setup scripts make it: a map's spots as a JSON list. */
export const MAILBOX_SPOTS_TABLE: Record<"mysql" | "sqlite", string> = {
  mysql: `CREATE TABLE IF NOT EXISTS mailbox_spots (map VARCHAR(191) NOT NULL PRIMARY KEY, spots TEXT NOT NULL)`,
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

// ---------------------------------------------------------------- the lists

interface Row { map: string; spots: string }

const rows = tableCache<Row>("mailbox_spots", async () =>
  ready ? (((await query("SELECT map, spots FROM mailbox_spots")) as Row[]) || []) : []
);

/** A map's mailboxes at these spots. */
const boxesAt = (map: string, spots: Array<{ x: number; y: number }>): Mailbox[] =>
  spots.map(({ x, y }) => ({ id: `${map}:${x}:${y}`, x, y }));

/** What a row holds: its spots, or none when it cannot be read. */
function spotsOf(stored: unknown): Array<{ x: number; y: number }> {
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

export type EditorAnswer = { ok: true; mailboxes: Mailbox[] } | { ok: false; message: string };

/** The spots an editor sent, each a whole number of px, or why they are refused. */
export function readSpots(raw: unknown): { ok: true; spots: Array<{ x: number; y: number }> } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: "No mailboxes were sent." };
  if (raw.length > MAILBOXES_MAX) return { ok: false, message: `A map has at most ${MAILBOXES_MAX} mailboxes.` };
  const spots: Array<{ x: number; y: number }> = [];
  for (const spot of raw) {
    const x = Math.round(Number(spot?.x));
    const y = Math.round(Number(spot?.y));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > COORDINATE_MAX || y > COORDINATE_MAX) {
      return { ok: false, message: "A mailbox is off the map." };
    }
    if (spots.some((other) => other.x === x && other.y === y)) return { ok: false, message: "Two mailboxes cannot stand on the same spot." };
    spots.push({ x, y });
  }
  return { ok: true, spots };
}

/** Gives a map these mailboxes, in place of the ones its inns place. */
export async function place(map: unknown, raw: unknown): Promise<EditorAnswer> {
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
