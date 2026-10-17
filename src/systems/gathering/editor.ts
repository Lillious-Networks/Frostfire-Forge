/**
 * Gathering editor: what the admin gathering editor window (/gathering) asks for, built as the mailbox editor is
 * (systems/mailboxeditor.ts). A record is an area of the map the admin is on: a circle where nodes of one item spawn,
 * how many stand at once, how much one gather gives, and how soon a gathered node grows back. Each change is checked,
 * written to gathering_areas and then to the cache, and answered with every area of the map as it then stands.
 * Preview answers where nodes would stand with the settings as typed, placed as the spawner places them.
 */
import query from "../../controllers/sqldatabase";
import log from "../../modules/logger";
import { tableCache } from "../../services/datacache";
import permissions from "../permissions";
import { MAX_NODES_PER_AREA, MAX_NODE_SIZE } from "./spawner";
import type { GatherArea } from "./types";

export const EDITOR_PERMISSIONS = ["tools.gathering", "tools.*", "server.admin", "server.*"];
export const DENIED = "You don't have permission to use the gathering editor.";
export const LIMITS = {
  radiusMin: 32,
  radiusMax: 4096,
  quantityMax: 999,
  nodesMax: MAX_NODES_PER_AREA,
  respawnMax: 86_400,
  coordinateMax: 1_000_000,
  sizeMin: 8,
  sizeMax: MAX_NODE_SIZE,
} as const;
/** How big a node is drawn (px, its picture's longest side) when its area sets nothing else. */
export const DEFAULT_SIZE = 32;

const sqlite = (): boolean => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";
const mapName = (map: unknown) => String(map ?? "").replaceAll(".json", "");

/** The table, as the setup scripts make it. */
export const GATHERING_AREAS_TABLE: Record<"mysql" | "sqlite", string> = {
  mysql: `CREATE TABLE IF NOT EXISTS gathering_areas (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    map VARCHAR(191) NOT NULL,
    x INT NOT NULL,
    y INT NOT NULL,
    radius INT NOT NULL DEFAULT 128,
    size INT NOT NULL DEFAULT 32,
    item VARCHAR(255) NOT NULL,
    quantity_min INT NOT NULL DEFAULT 1,
    quantity_max INT NOT NULL DEFAULT 1,
    max_nodes INT NOT NULL DEFAULT 5,
    respawn_min_s INT NOT NULL DEFAULT 60,
    respawn_max_s INT NOT NULL DEFAULT 120,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    INDEX idx_gathering_areas_map (map)
  )`,
  sqlite: `CREATE TABLE IF NOT EXISTS gathering_areas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    map TEXT NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    radius INTEGER NOT NULL DEFAULT 128,
    size INTEGER NOT NULL DEFAULT 32,
    item TEXT NOT NULL,
    quantity_min INTEGER NOT NULL DEFAULT 1,
    quantity_max INTEGER NOT NULL DEFAULT 1,
    max_nodes INTEGER NOT NULL DEFAULT 5,
    respawn_min_s INTEGER NOT NULL DEFAULT 60,
    respawn_max_s INTEGER NOT NULL DEFAULT 120,
    enabled INTEGER NOT NULL DEFAULT 1
  )`,
};

let ready = false;

/**
 * Start-time safety step: makes the table on a database whose setup ran before it was added, and lists the tool's
 * permission. Safe on every start, and never throws: without the table, no area spawns and a change is refused.
 */
export async function ensureGatheringSchema(): Promise<boolean> {
  ready = false;
  try {
    await query(GATHERING_AREAS_TABLE[sqlite() ? "sqlite" : "mysql"]);
    // gathering_areas.size came after the table: a table made before it gets it, every node at the default size
    await ensureSizeColumn();
    ready = true;
  } catch (error) {
    log.warn(`[Gathering] The gathering_areas table could not be made, so nothing can be gathered: ${error}`);
  }
  try {
    await query(`INSERT ${sqlite() ? "OR IGNORE" : "IGNORE"} INTO permission_types (name) VALUES ('tools.gathering')`);
  } catch {
    // no permission_types table: nothing lists them
  }
  return ready;
}

/** Adds gathering_areas.size unless it is there, as items' columns are added (systems/items.ts). */
async function ensureSizeColumn(): Promise<void> {
  const lite = sqlite();
  const has = async () => {
    if (lite) {
      const found = (await query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gathering_areas'`)) as any[];
      return /\bsize\b/.test(String(found?.[0]?.sql || ""));
    }
    const found = (await query(
      `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gathering_areas' AND COLUMN_NAME = 'size'`
    )) as any[];
    return Number(found?.[0]?.count) > 0;
  };
  if (await has()) return;
  try {
    await query(`ALTER TABLE gathering_areas ADD COLUMN size ${lite ? "INTEGER" : "INT"} NOT NULL DEFAULT ${DEFAULT_SIZE}`);
  } catch (error) {
    // another realm starting at the same moment may have added it first
    if (await has()) return;
    throw error;
  }
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

// ---------------------------------------------------------------- the areas

interface Row {
  id: number;
  map: string;
  x: number;
  y: number;
  radius: number;
  size: number;
  item: string;
  quantity_min: number;
  quantity_max: number;
  max_nodes: number;
  respawn_min_s: number;
  respawn_max_s: number;
  enabled: number | boolean;
}

const COLUMNS = "id, map, x, y, radius, size, item, quantity_min, quantity_max, max_nodes, respawn_min_s, respawn_max_s, enabled";

const rows = tableCache<Row>("gathering_areas", async () =>
  ready ? (((await query(`SELECT ${COLUMNS} FROM gathering_areas`)) as Row[]) || []) : []
);

/** A row as the spawner holds it: numbers as numbers, keys always in this order (the spawner compares areas by it). */
export function toArea(row: Row): GatherArea {
  return {
    id: Number(row.id),
    map: mapName(row.map),
    x: Number(row.x),
    y: Number(row.y),
    radius: Number(row.radius),
    size: Number(row.size) || DEFAULT_SIZE,
    item: String(row.item),
    quantity_min: Number(row.quantity_min),
    quantity_max: Number(row.quantity_max),
    max_nodes: Number(row.max_nodes),
    respawn_min_s: Number(row.respawn_min_s),
    respawn_max_s: Number(row.respawn_max_s),
    enabled: Boolean(Number(row.enabled)),
  };
}

export async function allAreas(): Promise<GatherArea[]> {
  return ready ? (await rows.all()).map(toArea) : [];
}

export type AreaInput = Omit<GatherArea, "id" | "map">;
export type ReadResult = { ok: true; area: AreaInput } | { ok: false; errors: string[]; fields: Record<string, string> };

/** The area an editor sent, or which fields are wrong. `items`: every item name. */
export function readArea(raw: any, items: readonly string[]): ReadResult {
  const fields: Record<string, string> = {};
  const whole = (key: string, min: number, max: number, label: string): number => {
    const given = raw?.[key];
    const value = Number(given);
    if (given === null || given === undefined || given === "" || !Number.isInteger(value) || value < min || value > max) {
      fields[key] = `${label} must be a whole number from ${min} to ${max}.`;
      return min;
    }
    return value;
  };
  const x = whole("x", 0, LIMITS.coordinateMax, "X");
  const y = whole("y", 0, LIMITS.coordinateMax, "Y");
  const radius = whole("radius", LIMITS.radiusMin, LIMITS.radiusMax, "Radius");
  // an editor that does not send a size draws nodes at the default one
  const size = raw?.size === undefined ? DEFAULT_SIZE : whole("size", LIMITS.sizeMin, LIMITS.sizeMax, "Size");
  const quantity_min = whole("quantity_min", 1, LIMITS.quantityMax, "Least per gather");
  const quantity_max = whole("quantity_max", 1, LIMITS.quantityMax, "Most per gather");
  const max_nodes = whole("max_nodes", 1, LIMITS.nodesMax, "Nodes at once");
  const respawn_min_s = whole("respawn_min_s", 0, LIMITS.respawnMax, "Shortest regrow");
  const respawn_max_s = whole("respawn_max_s", 0, LIMITS.respawnMax, "Longest regrow");
  if (!fields["quantity_min"] && !fields["quantity_max"] && quantity_min > quantity_max) fields["quantity_max"] = "Most per gather can't be less than least per gather.";
  if (!fields["respawn_min_s"] && !fields["respawn_max_s"] && respawn_min_s > respawn_max_s) fields["respawn_max_s"] = "Longest regrow can't be shorter than shortest regrow.";
  const wanted = String(raw?.item ?? "").trim();
  const item = items.find((name) => name.toLowerCase() === wanted.toLowerCase());
  if (!item) fields["item"] = wanted ? `There is no item called ${wanted}.` : "Pick an item.";

  const wrong = Object.keys(fields).length;
  if (wrong > 0 || !item) return { ok: false, errors: [wrong === 1 ? "1 field needs fixing." : `${wrong} fields need fixing.`], fields };
  return { ok: true, area: { x, y, radius, size, item, quantity_min, quantity_max, max_nodes, respawn_min_s, respawn_max_s, enabled: raw?.enabled !== false } };
}

/** Writes an area (a new one when `id` is null) to the table, then to the cache. */
export async function saveArea(id: number | null, map: string, area: AreaInput): Promise<{ ok: true; area: GatherArea } | { ok: false; message: string }> {
  if (!ready) return { ok: false, message: "Areas cannot be saved: the gathering_areas table is missing." };
  const values = [map, area.x, area.y, area.radius, area.size, area.item, area.quantity_min, area.quantity_max, area.max_nodes, area.respawn_min_s, area.respawn_max_s, area.enabled ? 1 : 0];
  let saved = id;
  try {
    if (saved === null) {
      const result: any = await query(
        "INSERT INTO gathering_areas (map, x, y, radius, size, item, quantity_min, quantity_max, max_nodes, respawn_min_s, respawn_max_s, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        values,
      );
      saved = Number(result?.lastInsertRowid ?? result?.insertId ?? 0) || null;
      if (saved === null) throw new Error("the database gave no id");
    } else {
      await query(
        "UPDATE gathering_areas SET map = ?, x = ?, y = ?, radius = ?, size = ?, item = ?, quantity_min = ?, quantity_max = ?, max_nodes = ?, respawn_min_s = ?, respawn_max_s = ?, enabled = ? WHERE id = ?",
        [...values, saved],
      );
    }
  } catch (error) {
    await rows.drop();
    log.error(`[Gathering] An area on ${map} could not be saved: ${error}`);
    return { ok: false, message: "The area could not be saved." };
  }
  // the try above threw when there was no id
  const row: Row = { id: saved as number, map, ...area, enabled: area.enabled ? 1 : 0 };
  await rows.put(row, (held) => Number(held.id) === row.id);
  return { ok: true, area: toArea(row) };
}

export async function deleteArea(id: number): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!ready) return { ok: false, message: "Areas cannot be deleted: the gathering_areas table is missing." };
  try {
    await query("DELETE FROM gathering_areas WHERE id = ?", [id]);
  } catch (error) {
    await rows.drop();
    log.error(`[Gathering] Area ${id} could not be deleted: ${error}`);
    return { ok: false, message: "The area could not be deleted." };
  }
  await rows.remove((held) => Number(held.id) === id);
  return { ok: true };
}

// ------------------------------------------------------------------ editor

export interface EditorItem {
  name: string;
  image: string | null;
}

export interface EditorData {
  /** The map the admin is on: the areas listed are its. */
  here: string;
  areas: GatherArea[];
  /** Every item, with its icon from the asset server: what an area can give. */
  items: EditorItem[];
  limits: typeof LIMITS;
  /** The table is there: changes can be saved. */
  ready: boolean;
}

/** What the server knows of the world, given by whoever calls: gathering/index.ts. */
export interface EditorWorld {
  here: string;
  items(): Promise<EditorItem[]>;
  /** Where nodes of this area would stand at once, or null when the map has no collision data. */
  preview(map: string, area: AreaInput): Promise<Array<{ x: number; y: number }> | null>;
}

export type EditorAnswer =
  | { kind: "data"; data: EditorData }
  | { kind: "preview"; spots: Array<{ x: number; y: number }>; wanted: number; note: string | null }
  | {
    kind: "result"; ok: boolean; errors: string[]; fields?: Record<string, string>; id: number | null; notes: string[];
    denied?: boolean; data: EditorData | null;
    /** Areas changed: the spawner reloads, and the other open editors are told. */
    changed?: boolean;
  };

export async function buildEditorData(world: EditorWorld): Promise<EditorData> {
  const here = mapName(world.here);
  const areas = (await allAreas()).filter((area) => area.map === here).sort((a, b) => a.id - b.id);
  return { here, areas, items: await world.items(), limits: LIMITS, ready };
}

/** One packet of the editor, after its permission is checked. */
export async function handleEditorPacket(admin: any, type: string, data: any, world: EditorWorld): Promise<EditorAnswer> {
  if (!(await canUseEditor(admin))) return { kind: "result", ok: false, errors: [DENIED], notes: [], id: null, denied: true, data: null };
  if (type === "GATHERING_EDITOR_LIST") return { kind: "data", data: await buildEditorData(world) };

  const rawId = data?.id;
  const id = rawId === null || rawId === undefined || rawId === "" ? null : Number(rawId);
  const refused = async (errors: string[], fields?: Record<string, string>): Promise<EditorAnswer> =>
    ({ kind: "result", ok: false, errors, fields, notes: [], id, data: await buildEditorData(world) });
  if (id !== null && !Number.isInteger(id)) return refused(["That area does not exist."]);
  const existing = id === null ? null : (await allAreas()).find((area) => area.id === id) ?? null;
  if (id !== null && !existing) return refused(["That area does not exist any more."]);
  const map = existing?.map ?? mapName(world.here);
  if (!map) return refused(["You are not on a map."]);

  if (type === "GATHERING_EDITOR_PREVIEW" || type === "GATHERING_EDITOR_SAVE") {
    const items = (await world.items()).map((item) => item.name);
    const read = readArea(data, items);
    if (!read.ok) return refused(read.errors, read.fields);
    if (type === "GATHERING_EDITOR_PREVIEW") {
      const spots = await world.preview(map, read.area);
      if (spots === null) return refused([`${map} has no collision data, so nodes cannot be placed on it.`]);
      const wanted = read.area.max_nodes;
      const note = spots.length < wanted ? `Only ${spots.length} of ${wanted} nodes fit: the area has no more free walkable tiles.` : null;
      return { kind: "preview", spots, wanted, note };
    }
    const saved = await saveArea(id, map, read.area);
    if (!saved.ok) return refused([saved.message]);
    log.info(`[Gathering] ${admin.username} saved area ${saved.area.id} on ${map} (${saved.area.max_nodes} x ${saved.area.item}).`);
    return { kind: "result", ok: true, errors: [], notes: [], id: saved.area.id, data: await buildEditorData(world), changed: true };
  }

  if (type === "GATHERING_EDITOR_DELETE") {
    if (!existing) return refused(["Pick an area."]);
    const done = await deleteArea(existing.id);
    if (!done.ok) return refused([done.message]);
    log.info(`[Gathering] ${admin.username} deleted area ${existing.id} on ${existing.map}.`);
    return { kind: "result", ok: true, errors: [], notes: [], id: existing.id, data: await buildEditorData(world), changed: true };
  }

  return refused([`Unknown request ${type}.`]);
}
