import log from "../modules/logger";
import { listener } from "../modules/event_bus";
import { Events } from "./events";

const PICKUP_RADIUS = 100;
const DESPAWN_MINUTES = 30;

export interface LootItem {
  id: string;
  item: string;
  quantity: number;
  quality: string;
  iconUrl: string;
  map: string;
  x: number;
  y: number;
  ownerId: string;
  ownerName: string;
  expiresAt: number;
}

const lootItems = new Map<string, LootItem>();
const despawnTimers = new Map<string, NodeJS.Timeout>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();
const OFFLINE_CLEANUP_MS = 5 * 60 * 1000;

let lootIdCounter = 0;
let onDespawn: ((lootItem: LootItem) => void) | null = null;

function generateId(): string {
  return `loot_${++lootIdCounter}_${Date.now()}`;
}

const loot = {
  setOnDespawn(fn: (lootItem: LootItem) => void): void {
    onDespawn = fn;
  },

  create(
    player: any,
    itemName: string,
    quantity: number,
    iconUrl: string,
    quality: string,
  ): LootItem {
    const id = generateId();
    const lootItem: LootItem = {
      id,
      item: itemName,
      quantity,
      quality,
      iconUrl,
      map: player.location.map,
      x: player.location.position.x,
      y: player.location.position.y,
      ownerId: player.username,
      ownerName: player.username || "Unknown",
      expiresAt: Date.now() + DESPAWN_MINUTES * 60 * 1000,
    };
    lootItems.set(id, lootItem);

    const timer = setTimeout(() => {
      loot.despawn(id);
    }, DESPAWN_MINUTES * 60 * 1000);
    despawnTimers.set(id, timer);

    log.debug(`Loot spawned: ${itemName} x${quantity} for player ${player.id}`);
    listener.emit(Events.PLAYER_LOOT_DROPPED, { player, itemName, quantity, mapName: lootItem.map, x: lootItem.x, y: lootItem.y } as any);
    return lootItem;
  },

  despawn(id: string): LootItem | null {
    const lootItem = lootItems.get(id);
    if (!lootItem) return null;

    const timer = despawnTimers.get(id);
    if (timer) clearTimeout(timer);
    despawnTimers.delete(id);
    lootItems.delete(id);

    if (onDespawn) onDespawn(lootItem);
    listener.emit(Events.PLAYER_LOOT_DESPAWNED, { player: { username: lootItem.ownerName, id: lootItem.ownerId }, itemName: lootItem.item, quantity: lootItem.quantity, mapName: lootItem.map, x: lootItem.x, y: lootItem.y } as any);
    return lootItem;
  },

  get(id: string): LootItem | undefined {
    return lootItems.get(id);
  },

  pickup(player: any, lootId: string): { success: boolean; message?: string; item?: LootItem } {
    const lootItem = lootItems.get(lootId);
    if (!lootItem) return { success: false, message: "Loot no longer exists." };
    if (String(lootItem.ownerId) !== String(player.username)) return { success: false, message: "This loot belongs to someone else." };
    if (lootItem.map !== player.location.map) return { success: false, message: "Loot is on a different map." };

    const dx = player.location.position.x - lootItem.x;
    const dy = player.location.position.y - lootItem.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > PICKUP_RADIUS) return { success: false, message: "You are too far away." };

    const timer = despawnTimers.get(lootId);
    if (timer) clearTimeout(timer);
    despawnTimers.delete(lootId);
    lootItems.delete(lootId);

    if (onDespawn) onDespawn(lootItem);
    listener.emit(Events.PLAYER_LOOT_RETRIEVED, { player, itemName: lootItem.item, quantity: lootItem.quantity, mapName: lootItem.map, x: lootItem.x, y: lootItem.y } as any);
    return { success: true, item: lootItem };
  },

  pickupAllNearby(player: any): LootItem[] {
    const result: LootItem[] = [];
    for (const [id, lootItem] of lootItems) {
      if (String(lootItem.ownerId) !== String(player.username)) continue;
      if (lootItem.map !== player.location.map) continue;
      const dx = player.location.position.x - lootItem.x;
      const dy = player.location.position.y - lootItem.y;
      if (Math.sqrt(dx * dx + dy * dy) > PICKUP_RADIUS) continue;

      const timer = despawnTimers.get(id);
      if (timer) clearTimeout(timer);
      despawnTimers.delete(id);
      result.push(lootItem);
    }
    for (const item of result) {
      lootItems.delete(item.id);
      if (onDespawn) onDespawn(item);
      listener.emit(Events.PLAYER_LOOT_RETRIEVED, { player, itemName: item.item, quantity: item.quantity, mapName: item.map, x: item.x, y: item.y } as any);
    }
    return result;
  },

  cleanupPlayer(playerId: string): LootItem[] {
    const result: LootItem[] = [];
    for (const [_id, lootItem] of lootItems) {
      if (String(lootItem.ownerId) === String(playerId)) {
        result.push(lootItem);
      }
    }
    for (const item of result) {
      loot.despawn(item.id);
    }
    return result;
  },

  scheduleCleanup(playerId: string): void {
    loot.cancelCleanup(playerId);
    const timer = setTimeout(() => {
      cleanupTimers.delete(playerId);
      loot.cleanupPlayer(playerId);
    }, OFFLINE_CLEANUP_MS);
    cleanupTimers.set(playerId, timer);
  },

  cancelCleanup(playerId: string): void {
    const timer = cleanupTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      cleanupTimers.delete(playerId);
    }
  },

  getOnMap(mapName: string): LootItem[] {
    const result: LootItem[] = [];
    for (const lootItem of lootItems.values()) {
      if (lootItem.map === mapName) {
        result.push(lootItem);
      }
    }
    return result;
  },

  PICKUP_RADIUS,
};

export default loot;
