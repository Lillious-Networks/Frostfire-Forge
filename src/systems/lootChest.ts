import { getIconUrl } from "../modules/spriteSheetManager";
import inventory from "./inventory";
import lootTable from "./lootTable";
import log from "../modules/logger";

const CHEST_RANGE = 120;
const chests = new Map<string, any>();
let chestCounter = 0;
function nextId() { chestCounter++; return `chest_${chestCounter}_${Date.now()}`; }

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
  async takeItems(chestId: string, playerId: string, playerName: string, indices: number[]) {
    const chest = chests.get(chestId); if (!chest) return null;
    const pd = chest.playerLoot.get(playerId); if (!pd) return null;
    const taken: any[] = []; const remaining: any[] = [];
    for (const i of pd.rolled) {
      if (indices.includes(i.index) && !pd.taken.has(i.index)) { await inventory.add(playerName, { name: i.itemName, quantity: i.quantity }); pd.taken.add(i.index); taken.push(i); }
      else if (!pd.taken.has(i.index)) { remaining.push(i); }
    }
    return { taken, remaining, allTaken: pd.rolled.every((i: any) => pd.taken.has(i.index)) };
  },
  async takeAllItems(chestId: string, playerId: string, playerName: string) {
    const chest = chests.get(chestId); if (!chest) return null;
    const pd = chest.playerLoot.get(playerId); if (!pd) return null;
    const taken: any[] = [];
    for (const i of pd.rolled) { if (!pd.taken.has(i.index)) { await inventory.add(playerName, { name: i.itemName, quantity: i.quantity }); pd.taken.add(i.index); taken.push(i); } }
    return { taken, allTaken: true };
  },
  getOnMap(mapName: string) { return [...chests.values()].filter(c => c.map === mapName); },
  getChest(id: string) { return chests.get(id); },
  dist(chestId: string, px: number, py: number) { const c = chests.get(chestId); return c ? Math.sqrt((c.x - px) ** 2 + (c.y - py) ** 2) : Infinity; },
  isWithinRange(chestId: string, px: number, py: number) { return this.dist(chestId, px, py) <= CHEST_RANGE; },
};
export default lootChest;
