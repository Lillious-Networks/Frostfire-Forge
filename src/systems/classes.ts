/**
 * Character classes. USER REQUEST 2026-10-14 ("a character selection screen after realm selection if a character has
 * not been created. One character per account (same username) and create a class editor that can define certain base
 * stats and learn certain spells at certain levels").
 *
 * A class is a row of `classes`: a name, a description, the stats a character of it starts with (base stats only:
 * levelling works as it does for everyone), the spells it learns, each at a level, and the items it starts with
 * (USER REQUEST 2026-10-21: "allow adding starter items"; the gateway puts them in the inventory when the character
 * is made). An account's character is its
 * class: `accounts.class_id`, NULL while no character has been made. The character is made on the gateway's character
 * page (it writes the rows while the player is out of the game; the caches read them again at login), and this
 * server refuses a login without one while there are classes to choose from (socket/receiver.ts: CHARACTER_REQUIRED).
 *
 * A character learns its class's spells as it reaches their levels: on PLAYER_LEVEL_UP, and at every login for the
 * levels it already has (a spell added to a class later reaches the characters past its level).
 */
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { getSpriteUrl } from "../modules/spriteSheetManager";
import { packetManager } from "../socket/packet_manager";
import { tableCache } from "../services/datacache";
import spells from "./spells";
import { Events, listener } from "./events";
import { CLASSES_TABLE } from "./classtable";

/** A spell a class learns, at the level it is learned. */
export interface ClassSpell { spell: string; level: number }
/** An item a new character of a class starts with, and how many. */
export interface ClassItem { item: string; quantity: number }

export interface CharacterClass {
  id: number;
  name: string;
  description: string;
  max_health: number;
  max_stamina: number;
  stat_damage: number;
  stat_armor: number;
  stat_critical_chance: number;
  stat_critical_damage: number;
  stat_avoidance: number;
  spells: ClassSpell[];
  items: ClassItem[];
}

/** The base stats a class sets, as the stats table names them. */
export const STAT_COLUMNS = ["max_health", "max_stamina", "stat_damage", "stat_armor", "stat_critical_chance", "stat_critical_damage", "stat_avoidance"] as const;

const sqlite = (): boolean => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";

/** The spells column, read from either engine: JSON text, or already parsed. Unreadable or wrong entries are dropped. */
export function parseSpells(raw: unknown): ClassSpell[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((e) => e && typeof e.spell === "string" && e.spell && Number.isFinite(Number(e.level)))
    .map((e) => ({ spell: String(e.spell), level: Math.max(1, Math.floor(Number(e.level))) }))
    .sort((a, b) => a.level - b.level || a.spell.localeCompare(b.spell));
}

/** The items column, read as the spells column is. Unreadable or wrong entries are dropped. */
export function parseItems(raw: unknown): ClassItem[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((e) => e && typeof e.item === "string" && e.item && Number.isFinite(Number(e.quantity)))
    .map((e) => ({ item: String(e.item), quantity: Math.max(1, Math.floor(Number(e.quantity))) }));
}

function toClass(row: any): CharacterClass {
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    max_health: Number(row.max_health) || 0,
    max_stamina: Number(row.max_stamina) || 0,
    stat_damage: Number(row.stat_damage) || 0,
    stat_armor: Number(row.stat_armor) || 0,
    stat_critical_chance: Number(row.stat_critical_chance) || 0,
    stat_critical_damage: Number(row.stat_critical_damage) || 0,
    stat_avoidance: Number(row.stat_avoidance) || 0,
    spells: parseSpells(row.spells),
    items: parseItems(row.items),
  };
}

/** False until the table and the column are known to be there: until then there are no classes and no character is asked for. */
let ready = false;

const classRows = tableCache<CharacterClass>("classes", async () =>
  ready ? (((await query("SELECT * FROM classes")) as any[]) || []).map(toClass) : []
);

async function hasColumn(table: string, column: string): Promise<boolean> {
  if (sqlite()) {
    const rows = (await query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [table])) as any[];
    return new RegExp(`\\b${column}\\b`).test(String(rows?.[0]?.sql || ""));
  }
  const rows = (await query(
    `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  )) as any[];
  return Number(rows?.[0]?.count) > 0;
}

/** Adds a column if it is missing. Another realm starting at the same moment may have added it first. */
async function ensureColumn(table: string, column: string, type: string): Promise<void> {
  if (await hasColumn(table, column)) return;
  try {
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} DEFAULT NULL`);
  } catch (error) {
    if (!(await hasColumn(table, column))) throw error;
  }
}

/**
 * Start-time step, before the first login and before the table caches are read: the classes table,
 * classes.items (the starter items) and accounts.class_id, if missing (a live database whose setup ran before they
 * existed). Safe on every start, and it never throws: if it cannot be done, one warning is logged and characters
 * stay off (no class to choose, no character asked for).
 */
export async function ensureClassSchema(): Promise<boolean> {
  ready = false;
  try {
    await query(CLASSES_TABLE[sqlite() ? "sqlite" : "mysql"]);
    await ensureColumn("classes", "items", "TEXT");
    await ensureColumn("accounts", "class_id", sqlite() ? "INTEGER" : "INT");
    ready = true;
  } catch (error) {
    log.warn(`[Classes] The classes table or accounts.class_id could not be added to the database, so characters and classes stay off: ${error}`);
  }
  // the class editor's permission, so it can be granted where the permissions are picked from a list
  try {
    await query(`INSERT ${sqlite() ? "OR IGNORE" : "IGNORE"} INTO permission_types (name) VALUES ('tools.class_editor')`);
  } catch {
    // no permission_types table: nothing lists them
  }
  return ready;
}

/** Whether the classes table and accounts.class_id are there. */
export const classesReady = (): boolean => ready;

const classes = {
  async list(): Promise<CharacterClass[]> {
    return ready ? (await classRows.all()).sort((a, b) => a.name.localeCompare(b.name)) : [];
  },
  async get(id: unknown): Promise<CharacterClass | null> {
    const wanted = Number(id);
    if (!ready || !Number.isInteger(wanted)) return null;
    return classRows.find((c) => c.id === wanted);
  },
  /** Insert or update (by id), then the list held. Returns the class as saved. */
  async save(c: Omit<CharacterClass, "id"> & { id?: number | null }): Promise<CharacterClass | null> {
    const values = [c.name, c.description || null, ...STAT_COLUMNS.map((k) => c[k]), JSON.stringify(c.spells), JSON.stringify(c.items)];
    const columns = ["name", "description", ...STAT_COLUMNS, "spells", "items"];
    let id = c.id ?? null;
    if (id != null) {
      await query(`UPDATE classes SET ${columns.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...values, id]);
    } else {
      const result = (await query(`INSERT INTO classes (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, values)) as any;
      id = Number(result?.lastInsertRowid ?? result?.insertId) || null;
    }
    if (id == null) {
      // no id came back: the table is read again
      await classRows.reload();
      return classRows.find((row) => row.name === c.name);
    }
    const saved = toClass({ ...c, id, spells: c.spells, items: c.items });
    await classRows.put(saved, (row) => row.id === saved.id);
    return saved;
  },
  async remove(id: number): Promise<void> {
    await query("DELETE FROM classes WHERE id = ?", [id]);
    await classRows.remove((row) => row.id === id);
  },
  /**
   * Whether this account must make its character before it may play: it has none (class_id NULL) and there is a
   * class to choose. With no class defined, everyone plays as before.
   */
  async characterRequired(characterClass: unknown): Promise<boolean> {
    if (!ready || characterClass !== null && characterClass !== undefined) return false;
    return (await classes.list()).length > 0;
  },
  /**
   * Teaches a character the spells of its class up to its level that it does not know yet. Returns the spells
   * learned. Spells a class names that no longer exist are passed over.
   */
  async learnUpTo(username: string, classId: unknown, level: number): Promise<string[]> {
    const c = await classes.get(classId);
    if (!c || !username) return [];
    const known = new Set((await spells.listLearned(username)).map((s) => s.toLowerCase()));
    const learned: string[] = [];
    for (const entry of c.spells) {
      if (entry.level > level || known.has(entry.spell.toLowerCase())) continue;
      if (!(await spells.find(entry.spell))) continue;
      await spells.learnSpell(username, entry.spell);
      known.add(entry.spell.toLowerCase());
      learned.push(entry.spell);
    }
    return learned;
  },
};

/** A live player is sent their spell book again and told what they learned. */
async function teach(player: any, learned: string[]): Promise<void> {
  if (!learned.length || !player?.wt) return;
  player.learnedSpells = await spells.learnedDetails(player.username);
  const spellBook: Record<string, any> = {};
  for (const [name, spell] of Object.entries(player.learnedSpells || {}) as [string, any][]) {
    spellBook[name] = { ...spell, spriteUrl: getSpriteUrl(spell.icon) };
  }
  const send = (packets: any[]) => {
    if (player.wt?.readyState !== 1) return;
    try { for (const p of packets) player.wt.send(p); } catch { /* closing */ }
  };
  send(packetManager.spells(spellBook));
  for (const name of learned) send(packetManager.notify({ message: `You have learned ${name}.` }));
}

// A character reaching a level learns its class's spells for it (and any it missed on the way).
listener.on(Events.PLAYER_LEVEL_UP, async ({ player, level }: any) => {
  try {
    if (player?.characterClass == null) return;
    const reached = Number(level ?? player?.stats?.level) || 1;
    await teach(player, await classes.learnUpTo(player.username, player.characterClass, reached));
  } catch (error) {
    log.error(`[Classes] Spells for ${player?.username} at level ${level} could not be learned: ${error}`);
  }
});

export default classes;
