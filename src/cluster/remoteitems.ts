import { ghosts, type GhostKindName } from "./ghosts";
import { linkCalls, neverRan } from "./linkcalls";
import { mirrorPlayers } from "./mirrors";
import { grants, handOverOf } from "./grants";
import log from "../modules/logger";
import { handedVerdict } from "../systems/itembounds";

/**
 * Items across the border (spec §4). A corpse, ground loot or chest belongs to the node that owns it. A player
 * of a neighbouring node acts on it by a call to that owner, which checks the player's mirror and takes the
 * items; the answer carries them, and the player's own node writes them.
 */

/** The room in a player's bags: free slots, and the lowercase names of what they hold (more of one takes no slot). */
export interface BagRoom {
  free: number;
  held: string[];
}

/** The items `room` has space for, in order, as kill.ts fitsInBags counts it. */
export function fitsInRoom<T extends { itemName: string }>(room: BagRoom, items: T[]): T[] {
  const held = new Set(room.held.map((name) => String(name).toLowerCase()));
  let free = room.free;
  const fits: T[] = [];
  for (const item of items) {
    const key = String(item.itemName).toLowerCase();
    if (!held.has(key)) {
      if (free <= 0) continue;
      free--;
      held.add(key);
    }
    fits.push(item);
  }
  return fits;
}

export type ItemCall = "LOOT_OPEN" | "LOOT_TAKE" | "PICKUP_REQUEST" | "CHEST_OPEN" | "CHEST_TAKE";

export interface ItemAnswer {
  ok: boolean;
  reason?: string;
  [field: string]: unknown;
}

/** Serves one item call for `actor`, the calling player's mirror here. */
export type ItemServer = (actor: any, body: any) => ItemAnswer | Promise<ItemAnswer>;

const KINDS: Record<ItemCall, GhostKindName> = {
  LOOT_OPEN: "creature",
  LOOT_TAKE: "creature",
  PICKUP_REQUEST: "loot",
  CHEST_OPEN: "chest",
  CHEST_TAKE: "chest",
};

/** The node that owns the thing an item call acts on. Null when this node owns it, or nobody mirrors it here. */
export function itemOwner(name: ItemCall, id: string | number): string | null {
  return ghosts.ownerOf(KINDS[name], id);
}

/**
 * Owner side: answers `name` for a player of the calling node. The player must be mirrored here, from that
 * node, under the name the call gives; anything else is "not_found".
 */
export function serveItems(name: ItemCall, fn: ItemServer): () => void {
  return linkCalls.handle(name, async (body: any, from: string) => {
    const actor = mirrorPlayers.get(String(body?.actor?.id));
    const sameName = String(actor?.username ?? "").toLowerCase() === String(body?.actor?.username ?? "").toLowerCase();
    if (!actor || actor.mirrorFrom !== from || !sameName) return { ok: false, reason: "not_found" };
    const answer = await fn(actor, body);
    // The items are off the corpse, the ground or the chest from here on, and in no inventory until the player's
    // node writes them: this line is the only record if the answer is lost.
    if (TAKES.has(name) && answer?.ok) {
      const handed = describeHandOver(answer);
      if (handed) {
        log.info(`${name} from ${from}: ${actor.username} (${actor.id}) was handed ${handed}`);
        // Parked before the answer goes out (grants.ts): an answer that is lost is given by recovery, and one that
        // arrives is claimed. Without a store it is null, and the answer is phase 5's.
        const grantId = await grants.park({ username: String(actor.username), ...handOverOf(answer), call: name });
        if (grantId) return { ...answer, grantId };
      }
    }
    return answer;
  });
}

/** The calls that take something off the owner's side. */
const TAKES = new Set<ItemCall>(["LOOT_TAKE", "PICKUP_REQUEST", "CHEST_TAKE"]);

/** What an answer to a take hands over, as one line ("2 x Bone, 1 x Fang, 11 copper"). Empty when it hands over nothing. */
export function describeHandOver(answer: ItemAnswer): string {
  const parts: string[] = [];
  const rows: any[] = Array.isArray(answer.items) ? answer.items : answer.item ? [answer.item] : [];
  for (const row of rows) parts.push(`${row?.quantity ?? 1} x ${row?.itemName ?? row?.item ?? "?"}`);
  const copper = Number(answer.copper) || 0;
  if (copper > 0) parts.push(`${copper} copper`);
  return parts.join(", ");
}

/**
 * The item rows an answer to a take hands over, as the receivers write them (socket/receiver.ts): `items` (a corpse,
 * a chest) or `item` as a ground loot row (`{ item, quantity }`). Counts and names are as they came, for the bounds.
 */
export function handedRows(answer: ItemAnswer): Array<{ itemName: unknown; quantity: unknown }> {
  if (Array.isArray(answer.items)) return answer.items.map((row: any) => ({ itemName: row?.itemName, quantity: row?.quantity }));
  const row: any = answer.item;
  if (row && typeof row === "object") return [{ itemName: row.item ?? row.itemName, quantity: row.quantity }];
  return [];
}

/**
 * Player side: asks the owner of the thing `id` names. Null when nobody mirrors it here (the caller acts on it
 * here, as before); `{ ok: false, reason: "failed" }` when the link fails (not retried: it may have been applied).
 * A take whose answer names a parked hand-over (`grantId`) is answered here only once this node has claimed it.
 */
export async function askOwner(name: ItemCall, id: string | number, player: any, body: Record<string, unknown>): Promise<ItemAnswer | null> {
  const owner = itemOwner(name, id);
  if (!owner) return null;
  const outcome = await linkCalls.call<ItemAnswer>(owner, name, { ...body, actor: { id: String(player.id), username: player.username } });
  if (outcome.ok) {
    const answer = outcome.answer;
    const grantId = answer?.ok && TAKES.has(name) ? answer.grantId : undefined;
    // Security review M4: what an owner hands over is written here only when it is in bounds (itembounds.ts). One
    // out of bounds is refused whole and logged lost by name; its hand-over is claimed first, so no recovery writes it.
    // Guard (test "an owner's answer out of bounds is refused whole, claimed, and logged lost by name").
    if (answer?.ok && TAKES.has(name)) {
      const handed = handedRows(answer);
      const source = `${name} of ${id} on ${owner}${typeof grantId === "string" ? ` (hand-over ${grantId})` : ""}`;
      const parked = typeof grantId === "string";
      const verdict = await handedVerdict({
        player: String(player.username), items: handed, copper: answer.copper ?? 0, source,
        waits: parked ? `it stays parked, and ${owner}'s recovery writes it` : "no hand-over was parked to wait in",
      });
      if (verdict === "refused") {
        if (parked) await grants.claim(grantId);
        return { ok: false, reason: "failed" };
      }
      // A bound not read yet here (fix round 1): the hand-over is not claimed, so the owner's recovery writes it once
      // the bounds are known. Guard (test "an owner's answer whose copper cannot be checked yet is left parked for the
      // owner's recovery").
      if (verdict === "not-ready") {
        if (!parked) log.error(`${source} for ${player.username} is lost: ${describeHandOver(answer)} could not be checked yet and no hand-over was parked`);
        return { ok: false, reason: "failed" };
      }
    }
    // A parked hand-over is written here only once this node has taken it: else the owner's recovery gives it.
    if (typeof grantId === "string" && !(await grants.claim(grantId, handOverOf(answer)))) {
      log.warn(`${name} of ${id} on ${owner} for ${player.username}: hand-over ${grantId} was not claimed here, so it is not written here (${owner}'s recovery has it, unless the line above says it may be lost)`);
      return { ok: false, reason: "failed" };
    }
    return answer;
  }
  if (TAKES.has(name)) {
    // A call that never ran took nothing (linkcalls.ts neverRan); any other failure may have been applied. A link that
    // is not up sends nothing, and is not worth a line. With the cluster store attached, what the owner took is parked
    // and its recovery gives it.
    if (!neverRan(outcome)) log.warn(`${name} of ${id} on ${owner} for ${player.username} ended ${outcome.why}: ${grants.attached() ? `if ${owner} took anything for them, its recovery gives it` : "what the owner took for them may be lost"}`);
    else if (outcome.why !== "down") log.warn(`${name} of ${id} on ${owner} for ${player.username} ended ${outcome.why}: it did not run, so nothing was taken`);
  }
  return { ok: false, reason: "failed" };
}
