// How many of an item a player has in use. What is in use stays with the player:
// only what they hold beyond it is spare, and can be traded away or sold.

import bags from "./bags";
import equipment, { EQUIPMENT_SLOTS } from "./equipment";

/**
 * How many of an item a player has in use: worn, or as a bag in a bag slot. `marked` is the
 * inventory row's own mark that the item is in use, which stands for one at least whatever the
 * slots say.
 */
export async function inUse(username: string, item: string, marked: boolean): Promise<number> {
  const holds = (slot: unknown) => typeof slot === "string" && slot.toLowerCase() === item.toLowerCase();
  const worn = await equipment.list(username);
  const carried = await bags.get(username);
  const counted = EQUIPMENT_SLOTS.filter((slot) => holds(worn?.[slot])).length + bags.SLOTS.filter((slot) => holds(carried?.[slot])).length;
  return Math.max(counted, marked ? 1 : 0);
}
