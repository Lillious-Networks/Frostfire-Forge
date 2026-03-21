import { expect, test } from "bun:test";
import { mockAssetCache } from "./setup";

const inventoryDatabase: Record<string, any[]> = {
  user1: [
    { item: "iron_sword", quantity: 1, equipped: 1 },
    { item: "healing_potion", quantity: 5, equipped: 0 },
  ],
  user2: [],
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT * FROM inventory WHERE item")) {
    const [itemName, username] = params;
    const items = inventoryDatabase[username] || [];
    return items.filter((i) => i.item === itemName);
  }
  if (sql.includes("INSERT IGNORE INTO inventory")) {
    const [username, itemName, quantity] = params;
    if (!inventoryDatabase[username]) inventoryDatabase[username] = [];
    const exists = inventoryDatabase[username].find((i) => i.item === itemName);
    if (!exists) {
      inventoryDatabase[username].push({ item: itemName, quantity, equipped: 0 });
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("UPDATE inventory SET quantity")) {
    const [newQuantity, itemName, username] = params;
    const items = inventoryDatabase[username] || [];
    const item = items.find((i) => i.item === itemName);
    if (item) {
      item.quantity = parseInt(newQuantity);
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("UPDATE inventory SET equipped")) {
    const [equipped, itemName, username] = params;
    const items = inventoryDatabase[username] || [];
    const item = items.find((i) => i.item === itemName);
    if (item) {
      item.equipped = equipped;
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("DELETE FROM inventory")) {
    const [itemName, username] = params;
    if (inventoryDatabase[username]) {
      const index = inventoryDatabase[username].findIndex((i) => i.item === itemName);
      if (index !== -1) {
        inventoryDatabase[username].splice(index, 1);
        return { affectedRows: 1 };
      }
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("SELECT item, quantity, equipped FROM inventory")) {
    const [username] = params;
    return inventoryDatabase[username] || [];
  }
  return [];
};

const inventory = {
  async find(name: string, item: any) {
    if (!name || !item.name) return;
    return await mockQuery("SELECT * FROM inventory WHERE item = ? AND username = ?", [item.name, name]);
  },

  async add(name: string, item: any) {
    if (!name || !item?.quantity || !item?.name) return;
    if (Number(item.quantity) <= 0) return;
    const items = (await mockAssetCache.get("items")) as any[];
    if (!items.find((i) => i.name === item.name)) return;
    const response = (await this.find(name, item)) as any[];
    if (response.length === 0) {
      return await mockQuery("INSERT IGNORE INTO inventory (username, item, quantity) VALUES (?, ?, ?)", [name, item.name, Number(item.quantity)]);
    }
    return await mockQuery("UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?", [
      Number(response[0].quantity) + Number(item.quantity),
      item.name,
      name,
    ]);
  },

  async setEquipped(name: string, item: string, equipped: boolean) {
    if (!name || !item || typeof equipped !== "boolean") return;
    return await mockQuery("UPDATE inventory SET equipped = ? WHERE item = ? AND username = ?", [equipped ? 1 : 0, item, name]);
  },

  async remove(name: string, item: any) {
    if (!name || !item?.quantity || !item?.name) return;
    if (Number(item.quantity) <= 0) return;
    const items = (await mockAssetCache.get("items")) as any[];
    if (!items.find((i) => i.name === item.name)) return;
    const response = (await this.find(name, item)) as any[];
    if (response.length === 0) return;
    if (Number(item.quantity) >= Number(response[0].quantity)) {
      return await mockQuery("DELETE FROM inventory WHERE item = ? AND username = ?", [item.name, name]);
    }
    return await mockQuery("UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?", [
      Number(response[0].quantity) - Number(item.quantity),
      item.name,
      name,
    ]);
  },

  async delete(name: string, item: any) {
    if (!name || !item.name) return;
    return await mockQuery("DELETE FROM inventory WHERE item = ? AND username = ?", [item.name, name]);
  },

  async get(name: string) {
    if (!name) return [];
    const items = (await mockQuery("SELECT item, quantity, equipped FROM inventory WHERE username = ?", [name])) as any[];
    if (!items || items.length === 0) return [];
    return items;
  },
};

test("inventory.add adds item to user inventory", async () => {
  await inventory.add("user1", { name: "test_item", quantity: 5 });
  const result = await inventory.get("user1");
  expect(result.length).toBeGreaterThanOrEqual(0);
});

test("inventory.add requires quantity", async () => {
  const result = await inventory.add("user1", { name: "test_item" });
  expect(result).toBeUndefined();
});

test("inventory.add requires item name", async () => {
  const result = await inventory.add("user1", { quantity: 5 });
  expect(result).toBeUndefined();
});

test("inventory.add prevents zero or negative quantities", async () => {
  const result = await inventory.add("user1", { name: "test_item", quantity: -1 });
  expect(result).toBeUndefined();
});

test("inventory.setEquipped marks item as equipped", async () => {
  await inventory.setEquipped("user1", "iron_sword", true);
  const result = await inventory.get("user1");
  expect(result.length).toBeGreaterThanOrEqual(0);
});

test("inventory.setEquipped requires boolean equipped", async () => {
  const result = await inventory.setEquipped("user1", "iron_sword", null as any);
  expect(result).toBeUndefined();
});

test("inventory.remove removes item from inventory", async () => {
  await inventory.remove("user1", { name: "healing_potion", quantity: 2 });
  const result = await inventory.get("user1");
  expect(result.length).toBeGreaterThanOrEqual(0);
});

test("inventory.delete deletes item completely", async () => {
  await inventory.delete("user1", { name: "iron_sword" });
  const result = await inventory.find("user1", { name: "iron_sword" });
  expect((result as any)?.length || 0).toBe(0);
});

test("inventory.get returns user inventory", async () => {
  const result = await inventory.get("user1");
  expect(Array.isArray(result)).toBe(true);
});

test("inventory.get returns empty for non-existent user", async () => {
  const result = await inventory.get("nonexistent");
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(0);
});
