// Buying from and selling to an NPC.
//
// An NPC with something in stock is a vendor. What it stocks, and what each
// thing costs there, is the NPC's own (`vendor_items`, set in the NPC editor);
// what a vendor pays for an item is the item's (`sell_price`, set in the item
// editor). Stock never runs out. Every deal is one batch: the coins and the
// items are written together, or neither is.
//
// What a player sold can be bought back for what they were paid, from a short
// list kept here in memory until they leave.

import assetCache from "../services/assetCache";
import { atomically } from "../services/batch";
import log from "../modules/logger";
import bags from "./bags";
import { isKept } from "./consumables";
import currency, { CURRENCY_LIMITS, coinsOf, coinsWorth } from "./currency";
import inventory from "./inventory";
import { inUse } from "./spare";

/** How far (px) a player may stand from a vendor and still deal with it. The reach of talking to an NPC. */
export const VENDOR_RANGE = 120;
/** How many different items one vendor stocks. */
export const VENDOR_ITEMS_MAX = 40;
/** How many of an item are bought in one purchase. */
export const BUY_AMOUNT_MAX = 999;
/** How many of a player's latest sales can be bought back. */
export const BUYBACK_KEPT = 8;

const MOST_COINS = coinsWorth(CURRENCY_LIMITS);

/** What a deal answers: what changed hands and for how many copper, or why nothing did. */
export type VendorAnswer = { ok: true; item: string; quantity: number; coins: number } | { ok: false; message: string };

/** Something a player sold: what, how many, and the copper they were paid for all of it. */
export interface Sale {
  item: string;
  quantity: number;
  price: number;
}

/** What the vendor rules read of a player. */
export interface Shopper {
  username: string;
  isDead?: boolean;
  isGhost?: boolean;
  location?: { map?: string; position?: unknown };
}

/** A deal that is not made, for a reason the player is told. */
class Refused extends Error {}

const lower = (text: unknown) => String(text ?? "").toLowerCase();
const refuse = (message: string): VendorAnswer => ({ ok: false, message });
const AMOUNT = "That is not an amount.";
const wholeFromOne = (value: unknown, most: number) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= most;
const definitions = async () => ((await assetCache.get("items")) as Item[]) || [];

/** What a vendor pays for one of an item, in copper: 1 when the item says nothing, never less than 0. */
export function sellPriceOf(item: Pick<Item, "sell_price"> | null | undefined): number {
  const price = item?.sell_price;
  if (price === null || price === undefined || !Number.isFinite(Number(price))) return 1;
  return Math.max(0, Math.trunc(Number(price)));
}

/**
 * What one of an item costs at a vendor: the price set there, and never less than a vendor pays
 * for the item. Sold for less, it could be bought and sold back for more, over and over: coins
 * from nowhere. A quest item is never bought, so it can cost anything, or nothing.
 */
export function priceAt(entry: VendorItem, item: Item): number {
  return Math.max(entry.price, item.type === "quest" ? 0 : sellPriceOf(item));
}

/**
 * A vendor's stock as an editor sent it, checked against the names of the items there are: the
 * entries to keep, and what was wrong with the ones left out.
 */
export function readVendorItems(input: unknown, itemNames: string[]): { items: VendorItem[]; errors: string[] } {
  if (input === undefined || input === null || input === "") return { items: [], errors: [] };
  if (!Array.isArray(input)) return { items: [], errors: ["A vendor's stock is a list of items and prices."] };

  const names = new Map(itemNames.map((name) => [lower(name), name]));
  const items: VendorItem[] = [];
  const errors: string[] = [];
  for (const entry of input) {
    if (items.length >= VENDOR_ITEMS_MAX) {
      errors.push(`A vendor stocks ${VENDOR_ITEMS_MAX} items at most.`);
      break;
    }
    if (!entry || typeof entry !== "object" || typeof entry.item !== "string" || !entry.item.trim()) {
      errors.push("A stock entry names no item.");
      continue;
    }
    const name = names.get(lower(entry.item.trim()));
    if (!name) {
      errors.push(`${entry.item.trim().slice(0, 64)} is not an item.`);
      continue;
    }
    if (items.some((kept) => kept.item === name)) {
      errors.push(`${name} is in the stock twice.`);
      continue;
    }
    const price = typeof entry.price === "string" && entry.price.trim() !== "" ? Number(entry.price) : entry.price;
    if (!Number.isInteger(price) || price < 0) {
      errors.push(`The price of ${name} must be a whole number of copper, 0 or more.`);
      continue;
    }
    if (price > MOST_COINS) {
      errors.push(`The price of ${name} is more coins than a player can hold.`);
      continue;
    }
    items.push({ item: name, price });
  }
  return { items, errors };
}

/** What an NPC stocks, as it is held. */
const stockOf = (npc: Pick<Npc, "vendor_items"> | null | undefined): VendorItem[] => (Array.isArray(npc?.vendor_items) ? npc!.vendor_items! : []);

/** Where a player stands. A position is kept as an object, or as "x,y". */
function placeOf(player: Shopper): { map: string; x: number; y: number } {
  const position = player.location?.position as any;
  const [x, y] = typeof position === "string" ? position.split(",").map(Number) : [Number(position?.x), Number(position?.y)];
  return { map: mapName(player.location?.map), x, y };
}
/** A map's name, with or without the ending its file has. */
const mapName = (map: unknown) => String(map ?? "").replaceAll(".json", "");

/** Why a player cannot deal with an NPC now, in words for the player. Null when they can. */
export function cannotShop(player: Shopper, npc: Npc | null | undefined): string | null {
  if (!npc || npc.hidden || stockOf(npc).length === 0) return "They have nothing to sell.";
  if (player.isDead || player.isGhost) return "You cannot trade with a vendor while dead.";
  const here = placeOf(player);
  // Not within reach, which is also what a position that cannot be read comes to.
  const near = Math.hypot(here.x - Number(npc.position?.x), here.y - Number(npc.position?.y)) <= VENDOR_RANGE;
  if (here.map !== mapName(npc.map) || !near) return "You are too far from that vendor.";
  return null;
}

/**
 * Whether a player has a slot for an item: more of something they hold takes none, and anything
 * else takes one. Counted as a quest's rewards are (see quests/rewards).
 */
async function hasRoomFor(username: string, item: string): Promise<boolean> {
  const rows = (await inventory.get(username)) as any[];
  if (rows.some((row) => lower(row.item ?? row.name) === lower(item))) return true;
  return rows.length < (await bags.capacity(username));
}

// What each player sold lately, the last sale first.
const sales = new Map<string, Sale[]>();

/** Runs a deal, and answers a refusal or a failure in words: nothing was written when it is not `ok`. */
async function deal(username: string, work: () => Promise<VendorAnswer>): Promise<VendorAnswer> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Refused) return refuse(error.message);
    log.error(`A vendor deal of ${username} was not completed: ${error}`);
    return refuse("The vendor could not complete that. Nothing changed.");
  }
}

/**
 * The player pays `cost` copper and is given the items, as one batch. `still` is asked inside the
 * batch, where nothing else of the player's changes: whether what is being bought is still there
 * to buy. `kept` runs once the batch is written, before anything else of the player's can.
 */
async function purchase(username: string, item: string, quantity: number, cost: number, still?: () => boolean, kept?: () => void): Promise<VendorAnswer> {
  if (!(await hasRoomFor(username, item))) return refuse("Your bags are full.");
  return deal(username, async () => {
    await atomically([username], async (batch) => {
      if (still && !still()) throw new Refused("That is no longer there to buy back.");
      if (cost > 0) {
        if (coinsWorth(await currency.heldIn(batch, username)) < cost) throw new Refused("You cannot afford that.");
        await currency.remove(username, coinsOf(cost), batch);
      }
      if (!(await inventory.add(username, { name: item, quantity }, batch))) throw new Error(`${item} could not be given`);
      if (kept) batch.kept(kept);
    });
    return { ok: true, item, quantity, coins: cost };
  });
}

const vendors = {
  /** Whether an NPC has anything in stock. */
  isVendor(npc: Pick<Npc, "vendor_items"> | null | undefined): boolean {
    return stockOf(npc).length > 0;
  },
  /** What an NPC stocks, each item with what it is (its icon, quality and so on) and its price there. Items that no longer exist are left out. */
  async stock(npc: Pick<Npc, "vendor_items"> | null | undefined): Promise<Array<Item & { price: number }>> {
    const known = new Map((await definitions()).map((item) => [item.name, item]));
    return stockOf(npc).filter((entry) => known.has(entry.item)).map((entry) => ({ ...known.get(entry.item)!, price: priceAt(entry, known.get(entry.item)!) }));
  },
  /** A player buys from a vendor's stock. Who may deal with the vendor is the caller's to have asked (see cannotShop). */
  async buy(username: string, npc: Pick<Npc, "vendor_items">, itemName: string, quantity: unknown = 1): Promise<VendorAnswer> {
    if (!wholeFromOne(quantity, BUY_AMOUNT_MAX)) return refuse(AMOUNT);
    const entry = stockOf(npc).find((stocked) => lower(stocked.item) === lower(itemName));
    const definition = entry && (await definitions()).find((item) => lower(item.name) === lower(entry.item));
    if (!entry || !definition) return refuse("They do not sell that.");
    return purchase(lower(username), definition.name, quantity as number, priceAt(entry, definition) * (quantity as number));
  },
  /**
   * A player sells an item for its sell price: `quantity` of it, or all they have spare. What is
   * worn or in a bag slot stays with them.
   */
  async sell(username: string, itemName: string, quantity?: unknown): Promise<VendorAnswer> {
    const name = lower(username);
    if (quantity !== undefined && !wholeFromOne(quantity, 2147483647)) return refuse(AMOUNT);
    const definition = (await definitions()).find((item) => lower(item.name) === lower(itemName));
    if (!definition) return refuse("You do not have that.");
    const item = definition.name;
    if (definition.type === "quest") return refuse(`${item} is a quest item and cannot be sold.`);
    if (isKept(definition)) return refuse(`${item} cannot be sold.`);
    const each = sellPriceOf(definition);

    return deal(name, () => atomically([name], async (batch) => {
      const held = await inventory.heldIn(batch, name, item);
      if (!held) throw new Refused("You do not have that.");
      if (each <= 0) throw new Refused(`The vendor does not want ${item}.`);
      const spare = held.quantity - (await inUse(name, item, held.equipped));
      if (spare <= 0) throw new Refused(`${item} is in use and cannot be sold.`);
      const amount = (quantity as number | undefined) ?? spare;
      if (amount > spare) throw new Refused(`You do not have ${amount} ${item} to sell.`);

      const paid = each * amount;
      // A balance stops at its limit: coins put into a full purse would be lost.
      if (!Number.isSafeInteger(paid) || coinsWorth(await currency.heldIn(batch, name)) + paid > MOST_COINS) throw new Refused("You cannot hold that many coins.");
      if (!(await inventory.remove(name, { name: item, quantity: amount }, batch))) throw new Refused("You do not have that.");
      await currency.add(name, coinsOf(paid), batch);
      batch.kept(() => {
        sales.set(name, [{ item, quantity: amount, price: paid }, ...(sales.get(name) ?? [])].slice(0, BUYBACK_KEPT));
      });
      return { ok: true, item, quantity: amount, coins: paid } as VendorAnswer;
    }));
  },
  /** What a player sold lately, the last sale first. Copies: changing them changes nothing. */
  sold(username: string): Sale[] {
    return (sales.get(lower(username)) ?? []).map((sale) => ({ ...sale }));
  },
  /** The same, each with what the item is, as a player is shown it. */
  async buybackList(username: string): Promise<Array<Record<string, unknown> & { name: string; quantity: number; price: number }>> {
    const known = new Map((await definitions()).map((item) => [item.name, item]));
    return vendors.sold(username).map(({ item, quantity, price }) => ({ ...(known.get(item) ?? { name: item }), quantity, price }));
  },
  /** A player buys back one of their latest sales (counted from 0, the last sale first) for what they were paid. */
  async buyback(username: string, index: unknown): Promise<VendorAnswer> {
    const name = lower(username);
    const list = sales.get(name) ?? [];
    const sale = Number.isInteger(index) ? list[index as number] : undefined;
    if (!sale) return refuse("That is no longer there to buy back.");
    const onList = () => (sales.get(name) ?? []).includes(sale);
    return purchase(name, sale.item, sale.quantity, sale.price, onList, () => {
      sales.set(name, (sales.get(name) ?? []).filter((kept) => kept !== sale));
    });
  },
  /** A player left: what they sold can no longer be bought back. */
  forget(username: string): void {
    sales.delete(lower(username));
  },
  /** Forgets every player's sales. For tests. */
  reset(): void {
    sales.clear();
  },
};

export default vendors;
