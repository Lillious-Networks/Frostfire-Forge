import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import log from "../modules/logger";

async function getItems(): Promise<Item[]> {
  return await assetCache.get("items") as Item[] || [];
}

const inventory = {
  async find(name: string, item: InventoryItem) {
    if (!name || !item.name) return;
    return await query(
      "SELECT * FROM inventory WHERE item = ? AND username = ?",
      [item.name, name]
    );
  },
  async add(name: string, item: InventoryItem) {
    if (!name || !item?.quantity || !item?.name) return;
    if (Number(item.quantity) <= 0) return;
    const items = await getItems();
    const matchedItem = items.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
    if (!matchedItem) return;
    const resolvedName = matchedItem.name;
    const response = (await inventory.find(name, { name: resolvedName, quantity: 0 })) as InventoryItem[];

    if (response.length === 0)
      return await query(
        "INSERT IGNORE INTO inventory (username, item, quantity) VALUES (?, ?, ?)",
        [name, resolvedName, Number(item.quantity)]
      );
    return await query(
      "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?",
      [
        (Number(response[0].quantity) + Number(item.quantity)).toString(),
        resolvedName,
        name,
      ]
    );
  },
  async setEquipped(name: string, item: string, equipped: boolean, targetSlot?: number, targetBagSlot?: number) {
    if (!name || !item || typeof equipped !== "boolean") return;
    if (equipped) {
      return await query(
        "UPDATE inventory SET equipped = 1 WHERE item = ? AND username = ?",
        [item, name]
      );
    } else {
      return await query(
        "UPDATE inventory SET equipped = 0, slot = ?, bag_slot = ? WHERE item = ? AND username = ?",
        [targetSlot ?? null, targetBagSlot ?? null, item, name]
      );
    }
  },
  async setUnequippedSlot(name: string, item: string, slot: number | null, bagSlot: number | null) {
    if (!name || !item) return;
    return await query(
      "UPDATE inventory SET equipped = 0, slot = ?, bag_slot = ? WHERE item = ? AND username = ?",
      [slot, bagSlot ?? null, item, name]
    );
  },
  async saveSlots(username: string, slots: Array<{ item: string; slot: number; bag_slot: number }>) {
    if (!username) return;
    for (const s of slots) {
      await query(
        "UPDATE inventory SET slot = ?, bag_slot = ? WHERE item = ? AND username = ?",
        [s.slot, s.bag_slot ?? null, s.item, username]
      );
    }
  },
  async remove(name: string, item: InventoryItem) {
    if (!name || !item?.quantity || !item?.name) return;
    if (Number(item.quantity) <= 0) return;
    const items = await getItems();
    const matchedItem = items.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
    if (!matchedItem) return;
    const resolvedName = matchedItem.name;
    const response = (await inventory.find(name, { name: resolvedName, quantity: 0 })) as InventoryItem[];
    if (response.length === 0) return;
    if (Number(item.quantity) >= Number(response[0].quantity))
      return await query(
        "DELETE FROM inventory WHERE item = ? AND username = ?",
        [resolvedName, name]
      );
    return await query(
      "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?",
      [
        (Number(response[0].quantity) - Number(item.quantity)).toString(),
        resolvedName,
        name,
      ]
    );
  },
  async delete(name: string, item: InventoryItem) {
    if (!name || !item.name) return;
    return await query(
      "DELETE FROM inventory WHERE item = ? AND username = ?",
      [item.name, name]
    );
  },
  async get(name: string) {
    if (!name) return [];

    const _items = await query("SELECT item, quantity, equipped, slot, bag_slot FROM inventory WHERE username = ?", [name]) as any[];

    if (!_items || _items.length === 0) return [];

    const items = await getItems();
    const itemsByName = new Map(items.map((i: any) => [i.name, i]));

    const details = await Promise.all(
      _items.map(async (item: any) => {

        const itemDetails = itemsByName.get(item.item);
        if (itemDetails) {
          return {
            ...itemDetails,
            ...item,
          };
        } else {

          log.error(`Item details not found for: ${item.item}`);
          return {
            ...item,
            name: item.item,
            quality: "unknown",
            description: "unknown",
            icon: null,
          };
        }

      })
    );
    return details;
  }
};

export default inventory;
