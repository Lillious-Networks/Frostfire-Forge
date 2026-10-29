import { getIconUrl } from "../modules/spriteSheetManager";
import inventory from "./inventory";
import { atomically } from "../services/batch";
import lootTable from "./lootTable";
import log from "../modules/logger";
import { nextEntityId } from "../cluster/entityids";
import { RemoteObjects } from "../cluster/mirrors";

/** Cluster mode: a chest as it travels with its block, each player's roll and the indices they took of it. */
export interface MovedChest {
  id: string;
  map: string;
  x: number;
  y: number;
  lootTableId?: number | null;
  inlineLootTable?: LootTableEntry[] | null;
  iconUrl: string;
  createdBy: string;
  playerLoot: Array<[string, { rolled: any[]; taken: number[] }]>;
}

const CHEST_RANGE = 120;
const chests = new Map<string, any>();
// Cluster mode: chests another node owns near the border, shown here and never opened here (open and take look only at `chests`).
const remoteChests = new RemoteObjects<any>();
// Cluster mode: chests that left this node with their block (takeOwn). A take under way on one of them does not put
// back what it could not write: its items stay taken in every copy of the chest, and are logged as lost.
const movedAway = new WeakSet<object>();
function nextId() { return `chest_${nextEntityId()}`; }

/**
 * Puts `items` of a player's roll in their inventory, all of them or none. They are marked taken
 * before anything is awaited, so a second take meanwhile does not find them, and unmarked if they
 * could not be written. False when they could not. Cluster mode: on a chest that moved with its block
 * meanwhile, they stay taken in its copies and are logged as lost by name.
 */
async function give(chest: any, pd: any, playerName: string, items: any[], write = true): Promise<boolean> {
  for (const i of items) pd.taken.add(i.index);
  // A player of a neighbouring node (CHEST_TAKE): the items are only marked taken; their node writes them.
  if (!write) return true;
  try {
    await atomically([playerName], async (batch) => {
      for (const i of items) await inventory.add(playerName, { name: i.itemName, quantity: i.quantity }, batch);
    });
    return true;
  } catch (error) {
    for (const i of items) pd.taken.delete(i.index);
    log.error(`Chest loot could not be given to ${playerName}: ${error}`);
    if (movedAway.has(chest)) {
      // The chest moved with its block with these marked taken, and every copy of it since (on another node, or back
      // here after a move that did not happen) has them marked. They stay so: a failure here may be a write that
      // landed with its answer lost, and unmarked they could be given a second time. They are lost, and named.
      log.error(`Chest ${chest.id} moved with its block while ${playerName} took from it: lost ${items.map((i) => `${i.itemName} x${i.quantity}`).join(", ")}`);
    }
    return false;
  }
}

export const lootChest = {
  spawn(map: string, x: number, y: number, lootTableId?: number, inlineEntries?: LootTableEntry[], createdBy = "system"): string {
    const id = nextId();
    chests.set(id, { id, map, x, y, lootTableId, inlineLootTable: inlineEntries, iconUrl: getIconUrl("loot_chest") || "", createdBy, playerLoot: new Map() });
    log.info(`Loot chest ${id} spawned on ${map} at (${x}, ${y})`);
    return id;
  },
  despawn(id: string) { const c = chests.get(id); if (c) { c.playerLoot.clear(); chests.delete(id); return true; } return false; },
  async open(chestId: string, playerId: string) {
    const chest = chests.get(chestId); if (!chest) return null;
    let pd = chest.playerLoot.get(playerId); let first = false;
    if (!pd) { first = true; const rolled = await lootTable.roll(chest.lootTableId, chest.inlineLootTable); pd = { rolled, taken: new Set() }; chest.playerLoot.set(playerId, pd); }
    const remaining = pd.rolled.filter((i: any) => !pd.taken.has(i.index));
    return { items: remaining, firstOpen: first };
  },
  async takeItems(chestId: string, playerId: string, playerName: string, indices: number[], write = true) {
    const chest = chests.get(chestId); if (!chest) return null;
    const pd = chest.playerLoot.get(playerId); if (!pd) return null;
    // A set, so a long list of indices costs one look-up per item, not one scan of the list.
    const wanted = new Set(indices);
    const taken = pd.rolled.filter((i: any) => wanted.has(i.index) && !pd.taken.has(i.index));
    if (!(await give(chest, pd, playerName, taken, write))) return null;
    const remaining = pd.rolled.filter((i: any) => !pd.taken.has(i.index));
    return { taken, remaining, allTaken: pd.rolled.every((i: any) => pd.taken.has(i.index)) };
  },
  async takeAllItems(chestId: string, playerId: string, playerName: string, write = true) {
    const chest = chests.get(chestId); if (!chest) return null;
    const pd = chest.playerLoot.get(playerId); if (!pd) return null;
    const taken = pd.rolled.filter((i: any) => !pd.taken.has(i.index));
    if (!(await give(chest, pd, playerName, taken, write))) return null;
    return { taken, allTaken: true };
  },
  getOnMap(mapName: string) { return [...chests.values()].filter(c => c.map === mapName).concat(remoteChests.onMap(mapName, (c) => c.map)); },
  getChest(id: string) { return chests.get(id); },
  /** The chests this node owns. */
  all(): IterableIterator<any> { return chests.values(); },
  addRemote(chest: { id: string; map: string; x: number; y: number; iconUrl: string }) { remoteChests.set(chest); },
  removeRemote(id: string) { return remoteChests.delete(id) ?? null; },
  /**
   * Cluster mode, a block moving away: this node's chest `id` leaves it, with every player's roll and what they took.
   * A take now finds no chest. A take already under way marked its items before it awaited, so they travel as taken:
   * if its write then reports failure (failed, or landed with its answer lost), they stay taken in every copy and are
   * logged as lost by name. Given at most once: a failure that was really a landed write costs nothing twice.
   */
  takeOwn(id: string): MovedChest | null {
    const c = chests.get(id);
    if (!c) return null;
    chests.delete(id);
    movedAway.add(c);
    return {
      id: c.id, map: c.map, x: c.x, y: c.y, lootTableId: c.lootTableId ?? null, inlineLootTable: c.inlineLootTable ?? null,
      iconUrl: c.iconUrl, createdBy: c.createdBy,
      playerLoot: [...c.playerLoot].map(([playerId, pd]: [string, any]) => [playerId, { rolled: pd.rolled, taken: [...pd.taken] }]),
    };
  },
  /** Cluster mode: a chest of a block that moved here (or back). As loot.adoptOwn: "mirror", "new", or null when this node has that id. */
  adoptOwn(m: MovedChest): "mirror" | "new" | null {
    if (chests.has(m.id)) return null;
    const known = remoteChests.delete(m.id) !== undefined;
    chests.set(m.id, {
      id: m.id, map: m.map, x: m.x, y: m.y, lootTableId: m.lootTableId ?? undefined, inlineLootTable: m.inlineLootTable ?? undefined,
      iconUrl: m.iconUrl, createdBy: m.createdBy,
      playerLoot: new Map(m.playerLoot.map(([playerId, pd]) => [playerId, { rolled: pd.rolled, taken: new Set(pd.taken) }])),
    });
    return known ? "mirror" : "new";
  },
  dist(chestId: string, px: number, py: number) { const c = chests.get(chestId); return c ? Math.sqrt((c.x - px) ** 2 + (c.y - py) ** 2) : Infinity; },
  isWithinRange(chestId: string, px: number, py: number) { return this.dist(chestId, px, py) <= CHEST_RANGE; },
};
export default lootChest;
