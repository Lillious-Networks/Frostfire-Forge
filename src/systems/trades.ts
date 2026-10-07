// Two players trading: each puts items and coins on their side of a window,
// both accept, and the two offers change hands in one transaction.
//
// The trades under way are kept here, in memory: one that is cut short by a
// restart has moved nothing. What a player holds is only looked at while an
// offer is made; it is checked for good inside the swap, where nothing else
// can change it.

import assetCache from "../services/assetCache";
import { atomically } from "../services/batch";
import log from "../modules/logger";
import { isKept } from "./consumables";
import currency, { CURRENCY_LIMITS, coinsWorth } from "./currency";
import inventory from "./inventory";
import { inUse } from "./spare";
import tradeLog, { type TradeGave, type TradeRecord } from "./tradelog";

/** How far apart (px) two players may stand and still trade. The reach of talking to an NPC. */
export const TRADE_RANGE = 120;
/** How many different items one side of a trade holds. */
export const TRADE_ITEMS_MAX = 8;
/** How long after an offer changed before the trade can be accepted, so nobody accepts what was swapped under their hand. */
export const ACCEPT_DELAY_MS = 2000;

/** What the trade rules read of a player. */
export interface Trader {
  username: string;
  isGuest?: boolean;
  isDead?: boolean;
  isGhost?: boolean;
  /** In combat. */
  pvp?: boolean;
  location?: { map?: string; position?: unknown };
}

export interface Trade {
  /** Who asked, then who was asked. Names as accounts are keyed. */
  players: [string, string];
  /** What each has on their side. */
  offers: Record<string, TradeGave>;
  accepted: Record<string, boolean>;
  /** When an offer last changed, or the trade opened. */
  changedAt: number;
  /** Both accepted and the swap is under way: nothing changes or ends the trade until it is done. */
  settling: boolean;
}

/** What a player is shown of their trade. */
export interface TradeView {
  partner: string;
  mine: { items: Array<Record<string, unknown>>; coins: Currency };
  theirs: { items: Array<Record<string, unknown>>; coins: Currency };
  accepted: { mine: boolean; theirs: boolean };
  /** Milliseconds until the trade can be accepted. */
  acceptIn: number;
}

export type OfferAnswer = { ok: true; trade: Trade; changed: boolean } | { ok: false; message: string };

export type AcceptAnswer =
  | { state: "none" }
  | { state: "wait"; message: string }
  /** Accepted, and waiting for the other player. */
  | { state: "accepted"; trade: Trade }
  /** Both accepted and the offers changed hands. `record` is null when neither offered anything. */
  | { state: "completed"; trade: Trade; record: TradeRecord | null }
  /** The trade ended with nothing exchanged: what each player is told. */
  | { state: "failed"; trade: Trade; reasons: Record<string, string> };

/** A swap that is not made, for a reason the players are told. */
class Refused extends Error {}

const lower = (username: string) => String(username ?? "").toLowerCase();
/** A name as players read it. */
const named = (username: string) => username.charAt(0).toUpperCase() + username.slice(1);
const noCoins = (): Currency => ({ copper: 0, silver: 0, gold: 0 });
const nothing = (): TradeGave => ({ items: [], coins: noCoins() });
const isEmpty = (gave: TradeGave) => gave.items.length === 0 && coinsWorth(gave.coins) === 0;
const MOST_COINS = coinsWorth(CURRENCY_LIMITS);

/** Where a player stands. A position is kept as an object, or as "x,y". */
function placeOf(player: Trader): { map: string; x: number; y: number } {
  const position = player.location?.position as any;
  const [x, y] = typeof position === "string" ? position.split(",").map(Number) : [Number(position?.x), Number(position?.y)];
  return { map: String(player.location?.map ?? ""), x, y };
}

/** Why `me` cannot trade with `them` now, in words for `me`. Null when they can. */
export function cannotTrade(me: Trader, them: Trader | null | undefined): string | null {
  if (!them) return "That player is not online.";
  if (lower(me.username) === lower(them.username)) return "You cannot trade with yourself.";
  const their = named(them.username);
  if (me.isGuest) return "Please create an account to use that feature.";
  if (them.isGuest) return `${their} is a guest and cannot trade.`;
  if (me.isDead || me.isGhost) return "You cannot trade while dead.";
  if (them.isDead || them.isGhost) return `${their} is dead.`;
  if (me.pvp) return "You cannot trade while in combat.";
  if (them.pvp) return `${their} is in combat.`;
  const here = placeOf(me);
  const there = placeOf(them);
  // Not within reach, which is also what a position that cannot be read comes to.
  if (here.map !== there.map || !(Math.hypot(here.x - there.x, here.y - there.y) <= TRADE_RANGE)) return `${their} is too far away to trade.`;
  return null;
}

// Each trade under way, under both of its players' names.
const open = new Map<string, Trade>();

function close(trade: Trade) {
  for (const player of trade.players) if (open.get(player) === trade) open.delete(player);
}

/** What each of a trade's players is told when the two may no longer trade. Null while they may. */
function noLonger(trade: Trade, find: (username: string) => Trader | undefined): Record<string, string> | null {
  const [a, b] = trade.players;
  const first = find(a);
  const second = find(b);
  if (!first || !second) {
    const gone = `${named(first ? b : a)} is no longer online.`;
    return { [a]: gone, [b]: gone };
  }
  const toFirst = cannotTrade(first, second);
  const toSecond = cannotTrade(second, first);
  if (!toFirst && !toSecond) return null;
  return { [a]: toFirst ?? toSecond!, [b]: toSecond ?? toFirst! };
}

const AMOUNT = "That is not an amount.";
const wholeUpTo = (value: unknown, most: number) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= most;

/** An offer as a player sent it, checked against what they hold: the offer to keep, or why it is refused. */
async function readOffer(username: string, raw: any): Promise<TradeGave | string> {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items) || (raw.coins != null && typeof raw.coins !== "object")) return "That is not an offer.";
  if (raw.items.length > TRADE_ITEMS_MAX) return `A trade holds ${TRADE_ITEMS_MAX} different items at most.`;

  const definitions = ((await assetCache.get("items")) as Item[]) || [];
  const items: TradeGave["items"] = [];
  const seen = new Set<string>();
  for (const entry of raw.items) {
    const quantity = entry?.quantity;
    if (typeof entry?.name !== "string" || !wholeUpTo(quantity, 2147483647) || quantity === 0) return AMOUNT;
    const definition = definitions.find((item) => lower(item.name) === lower(entry.name));
    const name = definition?.name ?? entry.name.slice(0, 64);
    if (seen.has(lower(name))) return `${name} is in the offer twice.`;
    seen.add(lower(name));

    const held = definition ? (await inventory.find(username, { name, quantity: 0 }))?.[0] : undefined;
    if (!definition || !held || Number(held.quantity) < quantity) return `You do not have ${quantity} ${name}.`;
    if (definition.type === "quest") return `${name} is a quest item and cannot be traded.`;
    if (isKept(definition)) return `${name} cannot be traded.`;
    const spare = Number(held.quantity) - (await inUse(username, name, Number(held.equipped) === 1));
    if (spare <= 0) return `${name} is in use and cannot be traded.`;
    if (spare < quantity) return `Only ${spare} ${name} can be traded: the rest is in use.`;
    items.push({ name, quantity });
  }

  const coins: Currency = { copper: raw.coins?.copper ?? 0, silver: raw.coins?.silver ?? 0, gold: raw.coins?.gold ?? 0 };
  if (!wholeUpTo(coins.copper, CURRENCY_LIMITS.copper) || !wholeUpTo(coins.silver, CURRENCY_LIMITS.silver) || !wholeUpTo(coins.gold, CURRENCY_LIMITS.gold)) return AMOUNT;
  if (coinsWorth(coins) > coinsWorth(await currency.get(username))) return "You do not have that many coins.";
  return { items, coins };
}

const sameOffer = (a: TradeGave, b: TradeGave) =>
  coinsWorth(a.coins) === coinsWorth(b.coins) &&
  a.items.length === b.items.length &&
  a.items.every((item, index) => item.name === b.items[index].name && item.quantity === b.items[index].quantity);

/**
 * The swap. Both players' rows are held by one batch: what each offered is checked against what
 * they have there, and then every item and coin is moved, and the trade written to the log, as one
 * transaction.
 */
async function swap(trade: Trade, now: number): Promise<TradeRecord> {
  const [a, b] = trade.players;
  const sides: Array<{ giver: string; receiver: string; gave: TradeGave }> = [
    { giver: a, receiver: b, gave: trade.offers[a] },
    { giver: b, receiver: a, gave: trade.offers[b] },
  ];

  return atomically([a, b], async (batch) => {
    const gone = (giver: string, item: { name: string; quantity: number }) => new Refused(`${named(giver)} no longer has ${item.quantity} ${item.name}.`);
    for (const { giver, gave } of sides) {
      for (const item of gave.items) {
        const held = await inventory.heldIn(batch, giver, item.name);
        // remove() takes what there is of a stack that is too small: the other player would be given more than was
        // taken. And what is worn or in a bag slot is not there to give: only what is spare of it.
        if (!held || held.quantity - (await inUse(giver, item.name, held.equipped)) < item.quantity) throw gone(giver, item);
      }
    }

    const worth = sides.map(({ gave }) => coinsWorth(gave.coins));
    if (worth[0] > 0 || worth[1] > 0) {
      const purse = [coinsWorth(await currency.heldIn(batch, a)), coinsWorth(await currency.heldIn(batch, b))];
      sides.forEach(({ giver }, index) => {
        if (purse[index] < worth[index]) throw new Refused(`${named(giver)} no longer has the coins they offered.`);
      });
      // A balance stops at its limit: coins put into a full purse would be lost.
      sides.forEach(({ giver }, index) => {
        if (purse[index] - worth[index] + worth[1 - index] > MOST_COINS) throw new Refused(`${named(giver)} cannot hold that many coins.`);
      });
    }

    // Everything is taken out before anything is put in, so no purse is at its limit on the way.
    for (const { giver, gave } of sides) {
      for (const item of gave.items) if (!(await inventory.remove(giver, item, batch))) throw gone(giver, item);
      if (coinsWorth(gave.coins) > 0) await currency.remove(giver, gave.coins, batch);
    }
    for (const { receiver, gave } of sides) {
      for (const item of gave.items) {
        if (!(await inventory.add(receiver, item, batch))) throw new Error(`${item.name} could not be given to ${receiver}`);
      }
      if (coinsWorth(gave.coins) > 0) await currency.add(receiver, gave.coins, batch);
    }
    return tradeLog.write(batch, { player_a: a, player_b: b, a_gave: structuredClone(trade.offers[a]), b_gave: structuredClone(trade.offers[b]), created_at: now });
  });
}

const trades = {
  /** The trade a player is in, or null. */
  of(username: string): Trade | null {
    return open.get(lower(username)) ?? null;
  },
  /** Who a player is trading with, or null. */
  partnerOf(username: string): string | null {
    const name = lower(username);
    return open.get(name)?.players.find((player) => player !== name) ?? null;
  },
  /** How many trades are under way. */
  get count(): number {
    return open.size / 2;
  },
  /** Opens a trade `asker` asked `asked` for, or says (to the asker) why not. */
  open(asker: Trader, asked: Trader, now = Date.now()): Trade | string {
    const reason = cannotTrade(asker, asked);
    if (reason) return reason;
    const a = lower(asker.username);
    const b = lower(asked.username);
    if (open.has(a)) return "You are already trading.";
    if (open.has(b)) return `${named(b)} is already trading.`;
    const trade: Trade = { players: [a, b], offers: { [a]: nothing(), [b]: nothing() }, accepted: { [a]: false, [b]: false }, changedAt: now, settling: false };
    open.set(a, trade);
    open.set(b, trade);
    return trade;
  },
  /**
   * Makes a player's side of their trade `raw` ({ items: [{ name, quantity }], coins }). An offer
   * that changes anything takes back both accepts.
   */
  async offer(username: string, raw: unknown, now = Date.now()): Promise<OfferAnswer> {
    const name = lower(username);
    const trade = open.get(name);
    if (!trade) return { ok: false, message: "You are not trading." };
    if (trade.settling) return { ok: false, message: "The trade is being completed." };

    const offer = await readOffer(name, raw);
    if (typeof offer === "string") return { ok: false, message: offer };
    // What the player holds was read meanwhile: the trade may have ended, or begun to be swapped.
    if (open.get(name) !== trade) return { ok: false, message: "You are not trading." };
    if (trade.settling) return { ok: false, message: "The trade is being completed." };
    if (sameOffer(offer, trade.offers[name])) return { ok: true, trade, changed: false };

    trade.offers[name] = offer;
    for (const player of trade.players) trade.accepted[player] = false;
    trade.changedAt = now;
    return { ok: true, trade, changed: true };
  },
  /**
   * A player accepts the trade as it stands. Once both have, the offers change hands and the
   * trade ends, whether they did or not. `find` is the player online under a name.
   */
  async accept(username: string, find: (username: string) => Trader | undefined, now = Date.now()): Promise<AcceptAnswer> {
    const name = lower(username);
    const trade = open.get(name);
    if (!trade) return { state: "none" };
    if (trade.settling) return { state: "accepted", trade };
    if (now - trade.changedAt < ACCEPT_DELAY_MS) return { state: "wait", message: "The offer just changed. Look it over, then accept." };

    trade.accepted[name] = true;
    if (!trade.players.every((player) => trade.accepted[player])) return { state: "accepted", trade };

    // Marked before anything is waited for: from here nothing else changes the offers or ends the trade.
    trade.settling = true;
    const failed = (reasons: Record<string, string>): AcceptAnswer => ({ state: "failed", trade, reasons });
    try {
      const apart = noLonger(trade, find);
      if (apart) return failed(apart);
      if (trade.players.every((player) => isEmpty(trade.offers[player]))) return { state: "completed", trade, record: null };
      return { state: "completed", trade, record: await swap(trade, now) };
    } catch (error) {
      if (!(error instanceof Refused)) log.error(`The trade between ${trade.players.join(" and ")} was not completed: ${error}`);
      const said = `${error instanceof Refused ? error.message : "The trade could not be completed."} Nothing was traded.`;
      return failed(Object.fromEntries(trade.players.map((player) => [player, said])));
    } finally {
      close(trade);
    }
  },
  /** Ends a player's trade with nothing exchanged. The trade that ended, or null: there was none, or it is being swapped. */
  cancel(username: string): Trade | null {
    const trade = open.get(lower(username));
    if (!trade || trade.settling) return null;
    close(trade);
    return trade;
  },
  /**
   * Ends every trade whose players may no longer trade (one walked away, entered combat, died,
   * changed map or left), and answers with them and what each player is told.
   */
  sweep(find: (username: string) => Trader | undefined): Array<{ trade: Trade; reasons: Record<string, string> }> {
    const ended: Array<{ trade: Trade; reasons: Record<string, string> }> = [];
    for (const trade of new Set(open.values())) {
      if (trade.settling) continue;
      const reasons = noLonger(trade, find);
      if (!reasons) continue;
      close(trade);
      ended.push({ trade, reasons });
    }
    return ended;
  },
  /** A trade as one of its players is shown it: each item with what it is (its icon, quality and so on). */
  async view(trade: Trade, username: string, now = Date.now()): Promise<TradeView> {
    const me = lower(username);
    const them = trade.players.find((player) => player !== me) ?? me;
    const definitions = new Map((((await assetCache.get("items")) as Item[]) || []).map((item) => [item.name, item]));
    const shown = (gave: TradeGave) => ({
      items: gave.items.map(({ name, quantity }) => ({ ...(definitions.get(name) ?? { name }), quantity })),
      coins: { ...gave.coins },
    });
    return {
      partner: them,
      mine: shown(trade.offers[me]),
      theirs: shown(trade.offers[them]),
      accepted: { mine: trade.accepted[me], theirs: trade.accepted[them] },
      acceptIn: Math.max(0, trade.changedAt + ACCEPT_DELAY_MS - now),
    };
  },
  /** Forgets every trade under way. For tests. */
  reset() {
    open.clear();
  },
};

export default trades;
