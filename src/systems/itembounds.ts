import log from "../modules/logger";
import assetCache from "../services/assetCache";
import lootTable from "./lootTable";

// The bounds an item hand-over written from another node's word is held to (security review phase 7, H1 and M4):
// a grant read back from the cluster store, an owner node's answer to a take, and a moved block's ground loot. Each
// item must be one of the item table this node loads, each quantity a whole number from 1 to the most one configured
// source hands out, and the copper a whole number from 0 to the most one corpse holds. A list over a known bound is
// refused whole and logged lost by name; nothing of it is written.
//
// A bound this node has not read yet (its creature templates or its loot tables not loaded) is not a reason to lose
// anything (fix round 1): such a write is "not ready". The caller leaves it parked (or parks it again), and a later
// check writes it once the bound is known. Only a value over a known bound is refused.
//
// Items have no stack limit of their own (the items table has no such column, and inventory rows add up without
// one). The quantity cap is the larger of ITEM_QUANTITY_MAX and the largest quantity any configured source hands out
// as one row, over all items (not per item): the loot tables' max_quantity and the gathering areas' quantity_max.
// ITEM_QUANTITY_MAX is what the sources that are not configured rows stop at: a loot table row made in the editor
// (looteditor.ts QUANTITY_MAX), an admin /drop (commands.ts) and a class's starter items (classeditor.ts
// QUANTITY_MAX) all stop at 9999.
//
// Copper reaches a hand-over only as a share of corpse money: the most is the biggest gold_max of this node's
// creature templates (kill.ts maxCorpseCopper, which kill.ts hands in when it loads: setCopperCap). Until the
// templates load, the copper cap is not known.

/** The least the quantity cap is: what a loot table row made in the editor, /drop and a class's starter items stop at. */
export const ITEM_QUANTITY_MAX = 9999;
/** The most an inventory row holds (an INT column): the cap a moved record is held to while the sources are not read. */
export const STORED_QUANTITY_MAX = 2147483647;
/** The most item rows one hand-over holds (cluster/grants.ts MAX_GRANT_ITEMS). */
export const HANDED_ITEMS_MAX = 64;

export interface BoundedItem { itemName: string; quantity: number }

/** The copper cap, or null while it is not known (kill.ts: no creature templates loaded yet). */
let copperCap: () => number | null = () => null;

/** kill.ts hands in its cap when it loads. Answers the one set before, so a test can put it back. */
export function setCopperCap(cap: () => number | null): () => number | null {
  const previous = copperCap;
  copperCap = cap;
  return previous;
}

/** The most copper one hand-over may carry, or null while it is not known. */
export function copperMax(): number | null {
  const most = copperCap();
  if (most === null || most === undefined) return null;
  const n = Number(most);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * A configured source of item quantities: the largest quantity it hands out as one row, or null while it is not
 * read. A source that throws is not read either.
 */
export type QuantitySource = () => number | null | Promise<number | null>;

const quantitySources = new Map<string, QuantitySource>();

/**
 * Sets the source `name` (null removes it). Answers the one set before, so a test can put it back. The loot tables
 * are set here; gathering/index.ts sets its areas each time it loads them.
 */
export function setQuantitySource(name: string, source: QuantitySource | null): QuantitySource | null {
  const previous = quantitySources.get(name) ?? null;
  if (source) quantitySources.set(name, source);
  else quantitySources.delete(name);
  return previous;
}

const largestOf = (rows: Iterable<unknown>): number => {
  let most = 0;
  for (const n of rows) {
    const v = Number(n);
    if (Number.isFinite(v) && v > most) most = v;
  }
  return Math.floor(most);
};

// The loot tables: datacache's table cache, which the server already loads (lootTable.ts).
setQuantitySource("loot tables", async () => largestOf((await lootTable.list()).flatMap((table: any) => (table.items ?? []).map((row: any) => row.max_quantity))));
// The gathering areas are not read until gathering/index.ts loads them.
setQuantitySource("gathering areas", () => null);

let quantityCap = { most: ITEM_QUANTITY_MAX, known: false };

/**
 * Reads every source again: the cap is the larger of ITEM_QUANTITY_MAX and the largest configured quantity, and
 * known only when every source was read. Kept for itemQuantityMaxNow.
 */
export async function refreshItemQuantityMax(): Promise<{ most: number; known: boolean }> {
  let most = ITEM_QUANTITY_MAX;
  let known = true;
  for (const [name, source] of quantitySources) {
    try {
      const largest = await source();
      if (largest === null || largest === undefined) known = false;
      else most = Math.max(most, Math.min(STORED_QUANTITY_MAX, largestOf([largest])));
    } catch (error) {
      known = false;
      log.debug(`The item quantity cap could not read the ${name}: ${error}`);
    }
  }
  quantityCap = { most, known };
  return { ...quantityCap };
}

/** The cap as last read (refreshItemQuantityMax). */
export function itemQuantityMaxNow(): { most: number; known: boolean } {
  return { ...quantityCap };
}

/**
 * Whether `value` is a quantity one row may hold: a whole number from 1 to the cap as last read. While the cap is
 * not known, up to what a row stores (a moved record cannot wait: it is taken in, not lost).
 */
export const isItemQuantity = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= (quantityCap.known ? quantityCap.most : STORED_QUANTITY_MAX);

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

const shown = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 64 ? `${text.slice(0, 64)}...` : text;
};

/** In bounds; over a known bound (`ready`: refuse it, it is lost); or not checkable yet (not `ready`: leave it parked). */
export type BoundsVerdict = { ok: true } | { ok: false; ready: boolean; why: string };

/** The lowercase names of the item table as last read (refreshItemNames), or null when no table was loaded. */
let itemNames: Set<string> | null = null;

/** Reads the item table again, for checkBoundsNow. Null (names not checked) when no table is loaded. */
export async function refreshItemNames(): Promise<Set<string> | null> {
  const table = await assetCache.get("items");
  itemNames = Array.isArray(table) && table.length > 0 ? new Set(table.map((item: any) => String(item?.name ?? "").toLowerCase())) : null;
  return itemNames;
}

/**
 * Checks `items` and `copper` against the bounds. The item table and the quantity sources are read once. When the
 * item table is not loaded (no table at all), the names are not checked here: inventory.add then finds no item of
 * any name and writes none, so nothing can be made of one. A value over a known bound wins over one not yet
 * checkable: the write is then refused, not left parked.
 */
export async function checkBounds(items: readonly unknown[], copper: unknown): Promise<BoundsVerdict> {
  if (Array.isArray(items) && items.length > 0 && items.length <= HANDED_ITEMS_MAX) {
    await refreshItemQuantityMax();
    await refreshItemNames();
  }
  return checkBoundsNow(items, copper);
}

/**
 * checkBounds against the quantity cap and the item table as last read (refreshItemQuantityMax, refreshItemNames),
 * without reading them: for a check that cannot wait, such as a moved block's records (cluster/kinds/objectmoves.ts),
 * whose accept reads them first.
 */
export function checkBoundsNow(items: readonly unknown[], copper: unknown): BoundsVerdict {
  if (!Array.isArray(items)) return { ok: false, ready: true, why: "the items are not a list" };
  if (items.length > HANDED_ITEMS_MAX) return { ok: false, ready: true, why: `${items.length} item rows, more than ${HANDED_ITEMS_MAX}` };
  let waiting: string | null = null;
  const most = copperMax();
  if (!isWhole(copper) || copper < 0) return { ok: false, ready: true, why: `${shown(copper)} copper is not a whole number of 0 or more` };
  if (most === null) {
    if (copper > 0) waiting = `the most copper a corpse holds is not known yet (no creature templates loaded) for ${copper} copper`;
  } else if (copper > most) {
    return { ok: false, ready: true, why: `${copper} copper is more than the ${most} a corpse holds` };
  }
  if (items.length === 0) return waiting ? { ok: false, ready: false, why: waiting } : { ok: true };
  const cap = quantityCap;
  const names = itemNames;
  for (const item of items as any[]) {
    const name = item?.itemName;
    if (typeof name !== "string" || !name) return { ok: false, ready: true, why: `an item row has no name (${shown(item)})` };
    const quantity = item.quantity;
    if (!isWhole(quantity) || quantity < 1 || quantity > STORED_QUANTITY_MAX) {
      return { ok: false, ready: true, why: `${shown(quantity)} x ${shown(name)} is not a whole number from 1 to ${STORED_QUANTITY_MAX}` };
    }
    if (quantity > cap.most) {
      if (cap.known) return { ok: false, ready: true, why: `${quantity} x ${shown(name)} is more than the ${cap.most} any configured source hands out` };
      waiting ??= `the configured item quantities are not read yet for ${quantity} x ${shown(name)} (more than ${ITEM_QUANTITY_MAX})`;
    }
    if (names && !names.has(name.toLowerCase())) return { ok: false, ready: true, why: `${shown(name)} is not an item` };
  }
  return waiting ? { ok: false, ready: false, why: waiting } : { ok: true };
}

/** Why `items` and `copper` are not in bounds now (over a bound, or not checkable yet), or null when they are. */
export async function outOfBounds(items: readonly unknown[], copper: unknown): Promise<string | null> {
  const verdict = await checkBounds(items, copper);
  return verdict.ok ? null : verdict.why;
}

export interface HandedWrite {
  /** Whose rows it would be written to. */
  player: string;
  items: readonly unknown[];
  copper: unknown;
  /** Where it came from, for the log line: "Hand-over b:1 (LOOT_TAKE on b)", "LOOT_TAKE of 5 on b (hand-over b:1)". */
  source: string;
  /** What happens to a write not checkable yet, for its log line: "it stays parked", "it is parked again". */
  waits: string;
}

/** What a write holds, as one line for a log ("2 x Bone, 11 copper"), shown as it came. */
export function describeHanded(items: readonly unknown[], copper: unknown): string {
  const parts = (Array.isArray(items) ? items : []).slice(0, HANDED_ITEMS_MAX).map((item: any) => `${shown(item?.quantity)} x ${shown(item?.itemName)}`);
  if (Array.isArray(items) && items.length > HANDED_ITEMS_MAX) parts.push(`and ${items.length - HANDED_ITEMS_MAX} more rows`);
  if (copper !== 0 && copper !== undefined) parts.push(`${shown(copper)} copper`);
  return parts.join(", ") || "nothing";
}

/**
 * Checks `write` and logs what it found: "ok" (in bounds, nothing logged); "refused" (over a known bound: logged by
 * name as lost, and the caller writes none of it); "not-ready" (a bound not known yet: logged at info, and the caller
 * leaves it parked so a later check writes it).
 */
export async function handedVerdict(write: HandedWrite): Promise<"ok" | "refused" | "not-ready"> {
  const verdict = await checkBounds(write.items, write.copper);
  if (verdict.ok) return "ok";
  const what = describeHanded(write.items, write.copper);
  if (!verdict.ready) {
    log.info(`${write.source} for ${shown(write.player)} is not written yet: ${what} cannot be checked until its bounds are read (${verdict.why}); ${write.waits}`);
    return "not-ready";
  }
  log.error(`${write.source} for ${shown(write.player)} is refused and lost: ${what} is out of bounds (${verdict.why}), so none of it is written`);
  return "refused";
}
