/**
 * Loot table editor: what the editor window (/le) asks for, one change to a
 * packet. Each is checked, carried out through lootTable, and answered with
 * whether it was done, why not when it was not, and every table as it then
 * stands, so the window never has to work out for itself what happened.
 */
import log from "../modules/logger";
import lootTable from "./lootTable";

/** The /loottable command's own rule: one of these, in the permissions copied at login. */
export const EDITOR_PERMISSIONS = ["admin.loot", "admin.*"];
export const DENIED = "You don't have permission to use the loot table editor.";

/** Longest table name: what the editor window and the control panel let through. */
export const NAME_MAX = 64;
/** Column size of loot_table_items.item_name. */
export const ITEM_NAME_MAX = 255;
/** The most one row drops at a time: what the control panel holds a row to. */
export const QUANTITY_MAX = 9999;

const NO_TABLE = "Pick a loot table.";
const NO_ROW = "Pick a row of the loot table.";
const GONE_TABLE = "That loot table is no longer there.";
const GONE_ROW = "That row is no longer in its table.";

/** Whoever /loottable lets through. Being an admin is not enough for it, so it is not enough here. */
export function canUseEditor(player: any): boolean {
  const held: string[] = Array.isArray(player?.permissions) ? player.permissions : [];
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

// ----------------------------------------------------------------- reading

/** A line of text, its control characters read as spaces, trimmed. Null for anything that is not text. */
function lineOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Array.from(value, (c) => (c < " " || c === "\u007f" ? " " : c)).join("").trim();
}

/** The id of a table or of a row: a whole number from 1 up. Null for anything else a client can send. */
function idOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** The numbers of one row, or what is wrong with them. lootTable itself turns a bad number into 1 or 100 without a word. */
function numbersOf(data: any): { min: number; max: number; chance: number } | string[] {
  const amount = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= QUANTITY_MAX ? value : null;
  const min = amount(data?.minQuantity);
  const max = amount(data?.maxQuantity);
  const chance = typeof data?.dropChance === "number" && data.dropChance >= 0 && data.dropChance <= 100 ? (data.dropChance as number) : null;
  const errors: string[] = [];
  if (min === null || max === null) errors.push(`The fewest and the most must be whole numbers from 1 to ${QUANTITY_MAX}.`);
  else if (min > max) errors.push("The fewest cannot be more than the most.");
  if (chance === null) errors.push("The chance must be from 0 to 100.");
  return min !== null && max !== null && chance !== null && errors.length === 0 ? { min, max, chance } : errors;
}

// ----------------------------------------------------------------- changes

/** How a change ended: what is wrong, or nothing when it was made. `created` is the name of a new table, to find its id by. */
interface Outcome {
  errors: string[];
  created?: string;
}

const made: Outcome = { errors: [] };
const refuse = (...errors: string[]): Outcome => ({ errors });

const CHANGES: Record<string, (data: any) => Promise<Outcome>> = {
  async LOOT_EDITOR_CREATE_TABLE(data) {
    const name = lineOf(data?.name);
    if (!name) return refuse("Give the loot table a name.");
    if (name.length > NAME_MAX) return refuse(`The name must be ${NAME_MAX} characters or fewer.`);
    // create() answers null for a name that is taken (and for none, which was refused above).
    if ((await lootTable.create(name)) === null) return refuse(`A loot table named "${name}" already exists.`);
    return { errors: [], created: name };
  },

  async LOOT_EDITOR_DELETE_TABLE(data) {
    const id = idOf(data?.id);
    if (id === null) return refuse(NO_TABLE);
    if (!(await lootTable.get(id))) return refuse(GONE_TABLE);
    await lootTable.delete(id);
    return made;
  },

  async LOOT_EDITOR_ADD_ITEM(data) {
    const tableId = idOf(data?.tableId);
    const itemName = lineOf(data?.itemName);
    const numbers = numbersOf(data);
    if (tableId === null) return refuse(NO_TABLE);
    if (!itemName || itemName.length > ITEM_NAME_MAX) return refuse("Pick an item.");
    if (Array.isArray(numbers)) return refuse(...numbers);
    if (!(await lootTable.get(tableId))) return refuse(GONE_TABLE);
    // The row takes the item's own quality.
    const added = await lootTable.addItem(tableId, itemName, numbers.min, numbers.max, numbers.chance);
    // addItem() refuses an item the server does not have, and a table deleted since the check above.
    if (added?.error) return refuse((await lootTable.get(tableId)) ? `There is no item named "${itemName}".` : GONE_TABLE);
    return made;
  },

  async LOOT_EDITOR_REMOVE_ITEM(data) {
    const itemId = idOf(data?.itemId);
    if (itemId === null) return refuse(NO_ROW);
    if (!(await lootTable.getItem(itemId))) return refuse(GONE_ROW);
    await lootTable.removeItem(itemId);
    return made;
  },

  async LOOT_EDITOR_UPDATE_ITEM(data) {
    const itemId = idOf(data?.itemId);
    const numbers = numbersOf(data);
    if (itemId === null) return refuse(NO_ROW);
    if (Array.isArray(numbers)) return refuse(...numbers);
    const row = await lootTable.getItem(itemId);
    if (!row) return refuse(GONE_ROW);
    // The editor changes a row's numbers only: its quality stays as it is.
    await lootTable.updateItem(itemId, numbers.min, numbers.max, numbers.chance, row.quality);
    return made;
  },
};

/**
 * Changes run one at a time. Each is a check followed by a write, and the
 * database layer has no transactions: the same request arriving twice must
 * not pass the check twice before either writes.
 */
let changes: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = changes.then(work, work);
  changes = run.catch(() => {});
  return run;
}

export interface LootEditorResult {
  ok: boolean;
  /** Why it was not done, in sentences. Empty when it was. */
  errors: string[];
  /** The number the editor gave its request, handed back so it knows which one this answers. */
  request?: number;
  /** The table a create made. */
  id?: number;
  /** Every loot table as it now stands, as LIST_LOOT_TABLES sends them. Null when nothing was read: the sender may not use the editor. */
  tables: Awaited<ReturnType<typeof lootTable.list>> | null;
}

/**
 * Dispatch for every LOOT_EDITOR_* packet. Permission is checked here, on each
 * one. The tables are read after the change, made or refused; when they cannot
 * be read this throws, and no answer is sent rather than one with nothing to show.
 */
export async function handleEditorPacket(player: any, type: string, data: any): Promise<LootEditorResult> {
  const request = Number.isSafeInteger(data?.request) ? (data.request as number) : undefined;
  if (!canUseEditor(player)) return { ok: false, errors: [DENIED], request, tables: null };
  const change = Object.hasOwn(CHANGES, type) ? CHANGES[type] : null;

  return oneAtATime(async () => {
    let outcome: Outcome;
    try {
      outcome = change ? await change(data) : refuse(`Unknown loot editor action: ${type}`);
    } catch (error) {
      log.error(`Loot editor ${type} failed: ${error}`);
      outcome = refuse(`The server could not do that: ${(error as Error)?.message ?? error}`);
    }
    const tables = await lootTable.list();
    const id = outcome.created === undefined ? undefined : tables.find((table) => table.name === outcome.created)?.id;
    return { ok: outcome.errors.length === 0, errors: outcome.errors, request, id, tables };
  });
}
