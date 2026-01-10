import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import log from "../modules/logger";

// Helper function to get items from cache dynamically
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
    if (items.find((i) => i.name === item.name) === undefined)
      return;
    const response = (await inventory.find(name, item)) as InventoryItem[];

    if (response.length === 0)
      return await query(
        "INSERT IGNORE INTO inventory (username, item, quantity) VALUES (?, ?, ?)",
        [name, item.name, Number(item.quantity)]
      );
    return await query(
      "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?",
      [
        (Number(response[0].quantity) + Number(item.quantity)).toString(),
        item.name,
        name,
      ]
    );
  },
  async setEquipped(name: string, item: string, equipped: boolean) {
    if (!name || !item || typeof equipped !== "boolean") return;
    return await query(
      "UPDATE inventory SET equipped = ? WHERE item = ? AND username = ?",
      [equipped ? 1 : 0, item, name]
    );
  },
  async remove(name: string, item: InventoryItem) {
    if (!name || !item?.quantity || !item?.name) return;
    if (Number(item.quantity) <= 0) return;
    const items = await getItems();
    if (items.find((i) => i.name === item.name) === undefined)
      return;
    const response = (await inventory.find(name, item)) as InventoryItem[];
    if (response.length === 0) return;
    if (Number(item.quantity) >= Number(response[0].quantity))
      return await query(
        "DELETE FROM inventory WHERE item = ? AND username = ?",
        [item.name, name]
      );
    return await query(
      "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?",
      [
        (Number(response[0].quantity) - Number(item.quantity)).toString(),
        item.name,
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

    // Fetch items for the user
    const _items = await query("SELECT item, quantity, equipped FROM inventory WHERE username = ?", [name]) as any[];

    if (!_items || _items.length === 0) return []; // Return if no items found

    const items = await getItems();
    // Fetch and process details for each item
    const details = await Promise.all(
      _items.map(async (item: any) => {
        // Fetch item details from cache
        const itemDetails = (items as any).find((i: any) => i.name === item.item);
        if (itemDetails) {
          return {
            ...itemDetails, // Item details from cache
            ...item, // Inventory item details (includes equipped and quantity)
          };
        } else {
          // If item details are not found, return the item with blank details
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
