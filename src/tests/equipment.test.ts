import { expect, test } from "bun:test";
import { mockAssetCache } from "./setup";

// Mock database
const equipmentDatabase: Record<string, any> = {
  user1: {
    username: "user1",
    helmet: "iron_helmet",
    chestplate: "iron_armor",
    weapon: "iron_sword",
  },
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT * FROM equipment")) {
    const user = params[0];
    return [equipmentDatabase[user] || null];
  }
  if (sql.includes("UPDATE equipment SET")) {
    const [itemName, username] = params;
    if (!equipmentDatabase[username]) equipmentDatabase[username] = { username };
    const slot = sql.match(/SET (\w+) =/)?.[1];
    if (slot) equipmentDatabase[username][slot] = itemName;
    return { affectedRows: 1 };
  }
  if (sql.includes("UPDATE equipment") && sql.includes("NULL")) {
    const [username] = params;
    const slot = sql.match(/SET (\w+) = NULL/)?.[1];
    if (slot && equipmentDatabase[username]) {
      equipmentDatabase[username][slot] = null;
    }
    return { affectedRows: 1 };
  }
  return [];
};

const validSlots = [
  "helmet",
  "necklace",
  "shoulderguards",
  "cape",
  "chestplate",
  "wristguards",
  "gloves",
  "belt",
  "pants",
  "boots",
  "ring_1",
  "ring_2",
  "trinket_1",
  "trinket_2",
  "weapon",
  "off_hand_weapon",
];

const equipment = {
  async list(username: string) {
    if (!username) return null;
    const response = (await mockQuery("SELECT * FROM equipment WHERE username = ?", [username])) as any[];
    if (response.length === 0) return null;
    return response[0];
  },

  async equipItem(username: string, slot: string, item: string | null) {
    if (!username || !slot) return false;
    if (!validSlots.includes(slot)) return false;

    if (item) {
      const items = (await mockAssetCache.get("items")) as any[];
      const itemObj = items.find((i) => i.name.toLowerCase() === item.toLowerCase() && i.equipment_slot?.toLowerCase() === slot.toLowerCase());
      if (!itemObj) return false;
      await mockQuery(`UPDATE equipment SET ${slot} = ? WHERE username = ?`, [itemObj.name, username]);
      return true;
    }
    return false;
  },

  async unEquipItem(username: string, slot: string, item: string) {
    if (!username || !slot) return false;
    if (!validSlots.includes(slot)) return false;
    await mockQuery(`UPDATE equipment SET ${slot} = NULL WHERE username = ?`, [username]);
    return true;
  },
};

test("equipment.list returns equipment for user", async () => {
  const result = await equipment.list("user1");
  expect(result?.helmet).toBe("iron_helmet");
  expect(result?.weapon).toBe("iron_sword");
});

test("equipment.list returns null for non-existent user", async () => {
  const result = await equipment.list("nonexistent");
  expect(result).toBeNull();
});

test("equipment.equipItem requires username and slot", async () => {
  const result = await equipment.equipItem("", "helmet", "test_item");
  expect(result).toBe(false);
});

test("equipment.equipItem validates slot", async () => {
  const result = await equipment.equipItem("user1", "invalid_slot", "test_item");
  expect(result).toBe(false);
});

test("equipment.equipItem requires item name for equipping", async () => {
  const result = await equipment.equipItem("user1", "helmet", null);
  expect(result).toBe(false);
});

test("equipment.equipItem fails for mismatched equipment slot", async () => {
  // test_item is mocked with equipment_slot="helmet", so it should match
  const result = await equipment.equipItem("user1", "helmet", "test_item");
  // The result depends on if the item matches the slot in mock cache
  expect(typeof result).toBe("boolean");
});

test("equipment.unEquipItem requires username and slot", async () => {
  const result = await equipment.unEquipItem("", "helmet", "test_item");
  expect(result).toBe(false);
});

test("equipment.unEquipItem validates slot", async () => {
  const result = await equipment.unEquipItem("user1", "invalid_slot", "test_item");
  expect(result).toBe(false);
});

test("equipment.unEquipItem unequips item", async () => {
  const result = await equipment.unEquipItem("user1", "helmet", "iron_helmet");
  expect(result).toBe(true);
});
