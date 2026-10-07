// Using an item from the bags.
//
// A consumable gives back health and stamina at once (`restore_health` and
// `restore_stamina`, set in the item editor) and is used up. Every consumable
// shares one cooldown, kept here in memory for each player and not lost when
// they leave.
//
// One consumable is the home item (`teleports_home`). It is never used up, and
// cannot be deleted, traded or sold. Using it is answered with a cast for the
// caller to run: what breaks the cast, and the move when it ends, are the
// receiver's, and where home is and the hour between uses are in systems/homes.

import assetCache from "../services/assetCache";
import { atomically } from "../services/batch";
import log from "../modules/logger";
import bags from "./bags";
import homes, { HOME_CAST_MS } from "./homes";
import inventory from "./inventory";

/** How long (ms) after a consumable is used before the player can use another. */
export const CONSUMABLE_COOLDOWN_MS = 30_000;

/** What a use answers: what it gave back, that a cast home starts, or why nothing happened. */
export type UseAnswer =
  | { ok: true; kind: "restore"; item: string; health: number; stamina: number; cooldown: number }
  | { ok: true; kind: "home"; item: string; cast: number }
  | { ok: false; message: string };

/** What the rules read of a player. A use changes the `stats` it is handed: they are the ones the server holds. */
export interface User {
  username: string;
  isDead?: boolean;
  isGhost?: boolean;
  /** In combat, with a player or a creature: the server raises it for both. */
  pvp?: boolean;
  /** Until when (ms, as Date.now counts) the player is stunned. */
  stunnedUntil?: number;
  stats?: { health: number; stamina: number; max_health?: number; max_stamina?: number; total_max_health?: number; total_max_stamina?: number; level?: number };
}

/** What is so around a use that the player does not carry. */
export interface UseState {
  now?: number;
  /** In a trade with a player: what they hold is on offer. */
  trading?: boolean;
}

/** A use that is not made, for a reason the player is told. */
class Refused extends Error {}

const lower = (text: unknown) => String(text ?? "").toLowerCase();
const refuse = (message: string): UseAnswer => ({ ok: false, message });
const amount = (value: unknown) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0);
const definitions = async () => ((await assetCache.get("items")) as Item[]) || [];

/** Whether an item is the home item: the consumable that takes its player home. */
export function teleportsHome(item: Pick<Item, "type" | "teleports_home"> | null | undefined): boolean {
  return !!item && item.type === "consumable" && !!item.teleports_home;
}

/** Whether an item stays with its player for good: it cannot be deleted, traded or sold. The home item is. */
export function isKept(item: Pick<Item, "type" | "teleports_home"> | null | undefined): boolean {
  return teleportsHome(item);
}

/** What using one of an item gives back. Nothing of either is an item with no use. */
export function restoresOf(item: Pick<Item, "type" | "restore_health" | "restore_stamina"> | null | undefined): { health: number; stamina: number } {
  if (!item || item.type !== "consumable") return { health: 0, stamina: 0 };
  return { health: amount(item.restore_health), stamina: amount(item.restore_stamina) };
}

// When each player can use a consumable again (ms, as Date.now counts).
const readyAt = new Map<string, number>();

/** The most of a stat a player can have: what gear adds is counted when the stats say so. */
const most = (total: unknown, base: unknown) => amount(total) || amount(base);

const consumables = {
  /** How long (ms) until a player can use another consumable. */
  cooldownLeft(username: string, now: number = Date.now()): number {
    return Math.max(0, (readyAt.get(lower(username)) ?? 0) - now);
  },
  /** The home item, when there is one. */
  async homeItem(): Promise<Item | null> {
    return (await definitions()).find((item) => teleportsHome(item)) ?? null;
  },
  /**
   * Gives a player the home item when they hold none and have a slot for it. Whether it was given:
   * a player with full bags is asked again the next time.
   */
  async giveHomeItem(username: string): Promise<boolean> {
    const name = lower(username);
    const stone = await consumables.homeItem();
    if (!name || !stone) return false;
    const rows = (await inventory.get(name)) as any[];
    if (rows.some((row) => lower(row.item ?? row.name) === lower(stone.name))) return false;
    if (rows.length >= (await bags.capacity(name))) return false;
    try {
      return await atomically([name], async (batch) => {
        // Asked again where nothing else of the player's changes: two logins at once give one.
        if (await inventory.heldIn(batch, name, stone.name)) return false;
        return !!(await inventory.add(name, { name: stone.name, quantity: 1 }, batch));
      });
    } catch (error) {
      log.error(`${name} could not be given ${stone.name}: ${error}`);
      return false;
    }
  },
  /**
   * A player uses an item they hold. A consumable that restores is used up and its health and
   * stamina are put on the player's stats, as one step: when the item could not be taken, nothing
   * is given. The home item answers the cast to run (see systems/homes for the arrival).
   */
  async use(player: User, itemName: unknown, state: UseState = {}): Promise<UseAnswer> {
    const now = state.now ?? Date.now();
    const name = lower(player?.username);
    const stats = player?.stats;
    if (!name || !stats) return refuse("You do not have that.");
    if (player.isDead || player.isGhost || !(stats.health > 0)) return refuse("You cannot use items while dead.");
    if ((player.stunnedUntil ?? 0) > now) return refuse("You cannot do that while stunned.");
    if (state.trading) return refuse("You cannot use items while trading.");

    const definition = typeof itemName === "string" && itemName ? (await definitions()).find((item) => lower(item.name) === lower(itemName)) : undefined;
    const held = definition && ((await inventory.get(name)) as any[]).some((row) => lower(row.item ?? row.name) === lower(definition.name) && Number(row.quantity) > 0);
    if (!definition || !held) return refuse("You do not have that.");
    const item = definition.name;

    const home = teleportsHome(definition);
    const gives = restoresOf(definition);
    if (!home && gives.health === 0 && gives.stamina === 0) return refuse(`${item} cannot be used.`);
    const level = amount(definition.level_requirement);
    if (level > amount(stats.level)) return refuse(`You must be level ${level} to use ${item}.`);
    if (definition.no_combat && player.pvp) return refuse(`${item} cannot be used in combat.`);

    if (home) {
      if ((await homes.cooldownLeft(name, now)) > 0) return refuse(`${item} is not ready yet.`);
      return { ok: true, kind: "home", item, cast: HOME_CAST_MS };
    }

    if (consumables.cooldownLeft(name, now) > 0) return refuse("You cannot use another item yet.");
    const mostHealth = most(stats.total_max_health, stats.max_health);
    const mostStamina = most(stats.total_max_stamina, stats.max_stamina);
    const fullHealth = gives.health === 0 || stats.health >= mostHealth;
    const fullStamina = gives.stamina === 0 || stats.stamina >= mostStamina;
    if (fullHealth && fullStamina) {
      const what = [gives.health > 0 ? "health" : "", gives.stamina > 0 ? "stamina" : ""].filter(Boolean);
      return refuse(`Your ${what.join(" and ")} ${what.length > 1 ? "are" : "is"} already full.`);
    }

    try {
      return await atomically([name], async (batch) => {
        // Asked again where nothing else of the player's changes: of two uses sent together, the second finds the first's cooldown.
        if (consumables.cooldownLeft(name, now) > 0) throw new Refused("You cannot use another item yet.");
        if (!(await inventory.heldIn(batch, name, item))) throw new Refused("You do not have that.");
        if (!(await inventory.remove(name, { name: item, quantity: 1 }, batch))) throw new Refused("You do not have that.");

        const answer: UseAnswer = { ok: true, kind: "restore", item, health: 0, stamina: 0, cooldown: CONSUMABLE_COOLDOWN_MS };
        // Once the item is taken, and before anything else of the player's is: the stats as they are then.
        batch.kept(() => {
          const health = Math.max(0, Math.min(gives.health, mostHealth - stats.health));
          const stamina = Math.max(0, Math.min(gives.stamina, mostStamina - stats.stamina));
          stats.health = Math.round(stats.health + health);
          stats.stamina = Math.round(stats.stamina + stamina);
          answer.health = health;
          answer.stamina = stamina;
          readyAt.set(name, now + CONSUMABLE_COOLDOWN_MS);
        });
        return answer;
      });
    } catch (error) {
      if (error instanceof Refused) return refuse(error.message);
      log.error(`${name} could not use ${item}: ${error}`);
      return refuse("That could not be used. Nothing changed.");
    }
  },
  /** Ends a player's cooldown at once: an admin reset it. */
  clearCooldown(username: string): void {
    readyAt.delete(lower(username));
  },
  /** Forgets every player's cooldown. For tests. */
  reset(): void {
    readyAt.clear();
  },
};

export default consumables;
