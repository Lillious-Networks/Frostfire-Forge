// Achievement data. The definitions (the achievements table, edited with /achievements) are held in a table cache;
// each player's progress (player_achievements) in a per-player row cache, read at login and let go at logout.
// Progress changes in the cache at once and is written on the save tick (onSave, 60 s) and when the player leaves:
// a crash can lose up to a minute of it. A completion is written at once, in the batch that gives the reward
// (service.ts), so it is never lost. Client requests read only the caches.
import query, { transaction, type TransactionStatement } from "../../controllers/sqldatabase";
import log from "../../modules/logger";
import { rowCache, tableCache, turns } from "../../services/datacache";
import playerCache from "../../services/playermanager";
import { ID_TARGETS, isCriterion, type AchievementDef, type AchievementInput, type CriterionType, type PlayerAchievement } from "./types";

const sqlite = (): boolean => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";
const lower = (name: unknown) => String(name ?? "").toLowerCase();

/** The two tables, as the setup scripts make them. */
export const ACHIEVEMENT_TABLES: Record<"mysql" | "sqlite", string[]> = {
  mysql: [
    `CREATE TABLE IF NOT EXISTS achievements (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    icon VARCHAR(255) NULL,
    type VARCHAR(32) NOT NULL,
    target VARCHAR(255) NULL,
    count INT NOT NULL DEFAULT 1,
    reward_item VARCHAR(255) NULL,
    reward_quantity INT NOT NULL DEFAULT 1,
    reward_mount VARCHAR(255) NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_achievements_name (name)
  )`,
    `CREATE TABLE IF NOT EXISTS player_achievements (
    username VARCHAR(191) NOT NULL,
    achievement_id INT NOT NULL,
    progress INT NOT NULL DEFAULT 0,
    completed_at VARCHAR(32) NULL,
    PRIMARY KEY (username, achievement_id),
    INDEX idx_player_achievements_achievement (achievement_id)
  )`,
  ],
  sqlite: [
    `CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NULL,
    type TEXT NOT NULL,
    target TEXT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    reward_item TEXT NULL,
    reward_quantity INTEGER NOT NULL DEFAULT 1,
    reward_mount TEXT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  )`,
    `CREATE TABLE IF NOT EXISTS player_achievements (
    username TEXT NOT NULL,
    achievement_id INTEGER NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT NULL,
    PRIMARY KEY (username, achievement_id)
  )`,
    "CREATE INDEX IF NOT EXISTS idx_player_achievements_achievement ON player_achievements (achievement_id)",
  ],
};

let ready = false;

/** The tables are there: achievements are counted, and the editor can save. */
export const isReady = (): boolean => ready;

/**
 * Start-time safety step: makes the tables on a database whose setup ran before they were added, and lists the
 * editor's permission. Safe on every start, and never throws: without the tables nothing is counted, the editor
 * refuses changes, and this says so once.
 */
export async function ensureAchievementSchema(): Promise<boolean> {
  ready = false;
  staleIndex();
  try {
    for (const sql of ACHIEVEMENT_TABLES[sqlite() ? "sqlite" : "mysql"]) await query(sql);
    ready = true;
  } catch (error) {
    log.warn(`[Achievements] The achievement tables could not be made, so achievements are off: ${error}`);
  }
  try {
    await query(`INSERT ${sqlite() ? "OR IGNORE" : "IGNORE"} INTO permission_types (name) VALUES ('tools.achievement_editor')`);
  } catch {
    // no permission_types table: nothing lists them
  }
  return ready;
}

// ------------------------------------------------------------ definitions

interface DefRow {
  id: number;
  name: string;
  description: string;
  icon: string | null;
  type: string;
  target: string | null;
  count: number;
  reward_item: string | null;
  reward_quantity: number;
  reward_mount: string | null;
  enabled: number | boolean;
}

const DEF_COLUMNS = "id, name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled";

const defs = tableCache<DefRow>("achievements", async () => {
  // read again (startup, a reload, the first read after a drop): the index is built again from what was read
  staleIndex();
  return ready ? (((await query(`SELECT ${DEF_COLUMNS} FROM achievements`)) as DefRow[]) || []) : [];
});

// The enabled definitions by type, for the counting: every deed asks it, so it is not the table copied and sorted
// each time. Kept in step with every change made in this process (saveDefinition, deleteDefinition) and built again
// on the next read after the table is read again or dropped. With CACHE=redis another server may change the table
// held in the shared cache, which this process is not told of: there it is built again on every read.
const shared = process.env.CACHE?.toLowerCase() === "redis";
let index: Map<CriterionType, AchievementDef[]> | null = null;
/** Raised whenever the table held may differ from the index; the index is current while `indexAt` equals it. */
let tableAt = 0;
let indexAt = -1;
function staleIndex(): void {
  tableAt++;
}
const indexCurrent = (): boolean => !shared && index !== null && indexAt === tableAt;

/** The index without `id`, and with `def` (when enabled) in its place. */
function patchIndex(id: number, def: AchievementDef | null): void {
  if (!indexCurrent()) return;
  for (const [type, list] of index!) index!.set(type, list.filter((held) => held.id !== id));
  if (def && def.enabled) index!.set(def.type, [...(index!.get(def.type) ?? []), Object.freeze({ ...def })].sort((a, b) => a.id - b.id));
}

async function buildIndex(): Promise<Map<CriterionType, AchievementDef[]>> {
  let built = new Map<CriterionType, AchievementDef[]>();
  // a read of the table while this one was made: made again from the table as it is now
  for (let tries = 0; tries < 3; tries++) {
    const at = tableAt;
    built = new Map();
    for (const def of await definitions()) {
      if (!def.enabled) continue;
      if (!built.has(def.type)) built.set(def.type, []);
      built.get(def.type)!.push(Object.freeze(def));
    }
    if (tableAt === at) {
      if (!shared) {
        index = built;
        indexAt = at;
      }
      break;
    }
  }
  return built;
}

/** The enabled definitions of one type, by id. Answered at once (no promise) while the index is current. */
export function definitionsOfType(type: CriterionType): AchievementDef[] | Promise<AchievementDef[]> {
  if (!ready) return [];
  if (indexCurrent()) return [...(index!.get(type) ?? [])];
  return buildIndex().then((built) => [...(built.get(type) ?? [])]);
}

const text = (value: unknown): string | null => (value === null || value === undefined || String(value).trim() === "" ? null : String(value));

/** A row as the rest of the engine reads it; null for a row whose type this version does not know. */
export function toDef(row: DefRow): AchievementDef | null {
  const type = row.type;
  if (!isCriterion(type)) return null;
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    icon: text(row.icon),
    type,
    target: text(row.target),
    count: Math.max(1, Math.floor(Number(row.count)) || 1),
    reward_item: text(row.reward_item),
    reward_quantity: Math.max(1, Math.floor(Number(row.reward_quantity)) || 1),
    reward_mount: text(row.reward_mount),
    enabled: Boolean(Number(row.enabled)),
  };
}

/** Every definition, disabled ones too (the editor lists them), by id. */
export async function definitions(): Promise<AchievementDef[]> {
  if (!ready) return [];
  const all: AchievementDef[] = [];
  for (const row of await defs.all()) {
    const def = toDef(row);
    if (def) all.push(def);
  }
  return all.sort((a, b) => a.id - b.id);
}

/** Whether two targets of `type` count the same things: ids as numbers, names without regard to case. */
function sameTarget(type: string, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return isCriterion(type) && ID_TARGETS.has(type) ? Number(a) === Number(b) : a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Every player's progress toward `id` that waits to be written, forgotten. */
function forgetWaiting(id: number): void {
  for (const [name, waiting] of changed) {
    waiting.delete(id);
    if (waiting.size === 0) changed.delete(name);
  }
}

/**
 * Writes a definition (a new one when `id` is null) to the table, then to the cache the counting reads. A change to
 * what counts (its type or its target) starts every player's progress toward it again, in the same transaction:
 * `reset` says so. Who earned it keeps it.
 */
export async function saveDefinition(id: number | null, input: AchievementInput): Promise<{ ok: true; def: AchievementDef; reset: boolean } | { ok: false; message: string }> {
  if (!ready) return { ok: false, message: "Achievements cannot be saved: the achievement tables are missing." };
  const values = [input.name, input.description, input.icon, input.type, input.target, input.count, input.reward_item, input.reward_quantity, input.reward_mount, input.enabled ? 1 : 0];
  const before = id === null ? null : await defs.find((held) => Number(held.id) === id);
  const reset = before !== null && (before.type !== input.type || !sameTarget(input.type, text(before.target), input.target));
  let saved = id;
  // before and after: a save tick in between must not write progress counted the old way again
  if (reset) forgetWaiting(id as number);
  try {
    if (saved === null) {
      const result: any = await query(
        "INSERT INTO achievements (name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        values,
      );
      saved = Number(result?.lastInsertRowid ?? result?.insertId ?? 0) || null;
      if (saved === null) throw new Error("the database gave no id");
    } else {
      const update = "UPDATE achievements SET name = ?, description = ?, icon = ?, type = ?, target = ?, count = ?, reward_item = ?, reward_quantity = ?, reward_mount = ?, enabled = ? WHERE id = ?";
      if (!reset) await query(update, [...values, saved]);
      else {
        await transaction([
          { sql: update, values: [...values, saved] },
          { sql: "DELETE FROM player_achievements WHERE achievement_id = ? AND completed_at IS NULL", values: [saved] },
        ]);
      }
    }
  } catch (error) {
    await defs.drop();
    staleIndex();
    if (reset) await playerRows.clear();
    log.error(`[Achievements] ${input.name} could not be saved: ${error}`);
    return { ok: false, message: "The achievement could not be saved." };
  }
  // the try above threw when there was no id
  const row: DefRow = { id: saved as number, ...input, enabled: input.enabled ? 1 : 0 };
  const def = toDef(row)!;
  // counted from at once; built again from the table held once that has it
  patchIndex(def.id, def);
  if (reset) forgetWaiting(def.id);
  await defs.put(row, (held) => Number(held.id) === row.id);
  staleIndex();
  // the rows held keep the completed ones when read again
  if (reset) await playerRows.clear();
  return { ok: true, def, reset };
}

/** Deletes a definition and every player's progress toward it. */
export async function deleteDefinition(id: number): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!ready) return { ok: false, message: "Achievements cannot be deleted: the achievement tables are missing." };
  // before and after: a save tick in between must not write progress toward it again
  forgetWaiting(id);
  try {
    await transaction([
      { sql: "DELETE FROM player_achievements WHERE achievement_id = ?", values: [id] },
      { sql: "DELETE FROM achievements WHERE id = ?", values: [id] },
    ]);
  } catch (error) {
    await defs.drop();
    staleIndex();
    await playerRows.clear();
    log.error(`[Achievements] Achievement ${id} could not be deleted: ${error}`);
    return { ok: false, message: "The achievement could not be deleted." };
  }
  patchIndex(id, null);
  forgetWaiting(id);
  await defs.remove((held) => Number(held.id) === id);
  staleIndex();
  await playerRows.clear();
  return { ok: true };
}

// ------------------------------------------------------------ player rows

/** Progress counted and not written yet: lower-case username, then achievement id, then progress. */
const changed = new Map<string, Map<number, number>>();

/** A stored date (ISO text, a number, or a Date a driver made of it) as ms since the epoch. */
export function whenOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

const playerRows = rowCache<PlayerAchievement[]>("player_achievements", async (username) => {
  if (!ready) return [];
  const read = ((((await query("SELECT achievement_id, progress, completed_at FROM player_achievements WHERE username = ?", [username])) as any[]) || []))
    .map((row): PlayerAchievement => ({ achievement_id: Number(row.achievement_id), progress: Number(row.progress) || 0, completed_at: whenOf(row.completed_at) }));
  // Counted before the player left and not written yet (they came back before the save tick): newer than the table.
  for (const [id, progress] of changed.get(lower(username)) ?? new Map<number, number>()) {
    const row = read.find((held) => held.achievement_id === id);
    if (!row) read.push({ achievement_id: id, progress, completed_at: null });
    else if (row.completed_at === null) row.progress = Math.max(row.progress, progress);
  }
  return read;
}, { perPlayer: true });

// One change to a player's achievements at a time: each works from the rows held and puts back what it left.
const oneAtATime = turns();

/** Runs `work` in the player's turn: after everything asked of them before it. */
export function inTurn<T>(username: string, work: () => Promise<T>): Promise<T> {
  return oneAtATime(lower(username), work);
}

/** The player's rows, as held (a copy: change it and give it back with holdRows). */
export async function rowsOf(username: string): Promise<PlayerAchievement[]> {
  if (!ready || !username) return [];
  return (await playerRows.get(lower(username))) ?? [];
}

/** After a change in the player's turn: what their rows are now. */
export async function holdRows(username: string, rows: PlayerAchievement[]): Promise<void> {
  await playerRows.set(lower(username), rows);
}

/** Progress to write on the next save. */
export function markChanged(username: string, id: number, progress: number): void {
  const name = lower(username);
  if (!changed.has(name)) changed.set(name, new Map());
  changed.get(name)!.set(id, progress);
}

/** Written another way (a completion): nothing to write on the next save. */
export function clearChanged(username: string, id: number): void {
  const name = lower(username);
  const waiting = changed.get(name);
  if (!waiting) return;
  waiting.delete(id);
  if (waiting.size === 0) changed.delete(name);
}

/** What waits to be written for the player: achievement id to progress. A copy. */
export function changedOf(username: string): Map<number, number> {
  return new Map(changed.get(lower(username)) ?? []);
}

/** Forget everything that waits to be written, and build the definitions index again on the next read. For tests, which empty the caches behind it. */
export function resetChanges(): void {
  changed.clear();
  staleIndex();
}

// Never lowers progress: a relog during a flush can read the table before the write lands, and a later flush would
// otherwise write the lower value it counted from.
const PROGRESS_SQL = "INSERT INTO player_achievements (username, achievement_id, progress) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE progress = CASE WHEN completed_at IS NULL AND ? > progress THEN ? ELSE progress END";
// A completion is two statements (see completionStatements): the row made if it is not there, then the update that
// dates it, which changes nothing, and so refuses the batch, when the row is completed already.
const ROW_SQL = "INSERT IGNORE INTO player_achievements (username, achievement_id, progress, completed_at) VALUES (?, ?, 0, NULL)";
const COMPLETED_SQL = "UPDATE player_achievements SET progress = ?, completed_at = ? WHERE username = ? AND achievement_id = ? AND completed_at IS NULL";

/**
 * Writes the player's changed progress, in their turn, as one transaction. One that fails is kept for the next save
 * and logged. A player who is not online any more is let go of afterwards (counted while away: a friend added by an
 * admin, say).
 */
export async function flush(username: string): Promise<void> {
  const name = lower(username);
  if (!name || !ready) return;
  await oneAtATime(name, async () => {
    const waiting = changed.get(name);
    if (waiting && waiting.size > 0) {
      const writes = [...waiting.entries()];
      changed.delete(name);
      try {
        await transaction(writes.map(([id, progress]) => ({ sql: PROGRESS_SQL, values: [name, id, progress, progress, progress] })));
      } catch (error) {
        const back = changed.get(name) ?? new Map<number, number>();
        for (const [id, progress] of writes) if (!back.has(id)) back.set(id, progress);
        changed.set(name, back);
        log.error(`[Achievements] The progress of ${name} could not be saved; it is tried again on the next save: ${error}`);
        return;
      }
    }
    if (!playerCache.getByUsername(name)) await playerRows.drop(name);
  });
}

/** The save tick: every player's changed progress. */
export async function flushAll(): Promise<void> {
  for (const name of [...changed.keys()]) await flush(name);
}

/**
 * The statements that mark an achievement earned, for the batch that gives its reward. The date is ISO text (UTC).
 * The second must change a row: one already completed makes the whole batch refuse, so a completion that was
 * written but reported as failed (a timeout after the commit) is never given a second time.
 */
export function completionStatements(username: string, id: number, progress: number, at: number): TransactionStatement[] {
  const name = lower(username);
  return [
    { sql: ROW_SQL, values: [name, id] },
    { sql: COMPLETED_SQL, values: [progress, new Date(at).toISOString(), name, id], mustChange: true },
  ];
}

/** Forgets the rows held for the player, so the next read asks the database. For when a write may or may not have been made. */
export async function forgetRows(username: string): Promise<void> {
  await playerRows.drop(lower(username));
}
