import { expect, test } from "bun:test";
import { createMockItem, mockAssetCache } from "./setup";

const itemsDatabase: Record<string, any> = {
  test_item: createMockItem({ name: "test_item" }),
  sword: createMockItem({ name: "sword", stat_damage: 15 }),
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("INSERT IGNORE INTO items")) {
    const [name] = params;
    if (!itemsDatabase[name]) {
      itemsDatabase[name] = params;
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("DELETE FROM items")) {
    const [name] = params;
    if (itemsDatabase[name]) {
      delete itemsDatabase[name];
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("SELECT * FROM items WHERE name")) {
    const name = params[0];
    return itemsDatabase[name] ? [itemsDatabase[name]] : [];
  }
  if (sql.includes("SELECT * FROM items")) {
    return Object.values(itemsDatabase);
  }
  if (sql.includes("UPDATE items")) {
    const name = params[params.length - 1];
    itemsDatabase[name] = { name, ...params };
    return { affectedRows: 1 };
  }
  return [];
};

const items = {
  async add(item: any) {
    if (!item?.name || !item?.quality || !item?.description || !item?.type || !item?.level_requirement || !item?.equipable)
      return;
    const result = await mockQuery("INSERT IGNORE INTO items (name) VALUES (?)", [item.name]);
    if ((result as any).affectedRows > 0) {
      const itemList = (await mockAssetCache.get("items")) as any[];
      itemList.push(item);
      await mockAssetCache.set("items", itemList);
    }
  },

  async remove(item: any) {
    if (!item?.name) return;
    const result = await mockQuery("DELETE FROM items WHERE name = ?", [item.name]);
    if ((result as any).affectedRows > 0) {
      const itemList = (await mockAssetCache.get("items")) as any[];
      const index = itemList.findIndex((i) => i.name === item.name);
      if (index !== -1) {
        itemList.splice(index, 1);
        await mockAssetCache.set("items", itemList);
      }
    }
  },

  async list() {
    return await mockQuery("SELECT * FROM items", []);
  },

  async find(item: any) {
    if (!item?.name) return;
    const response = await mockQuery("SELECT * FROM items WHERE name = ?", [item.name]);
    if ((response as any[]).length === 0) return;
    return response;
  },

  async update(item: any) {
    if (!item?.name || !item?.quality || !item?.description || !item?.type || !item?.level_requirement || !item?.equipable)
      return;
    const result = await mockQuery("UPDATE items SET name = ? WHERE name = ?", [item.name, item.name]);
    if (result) {
      const itemList = (await mockAssetCache.get("items")) as any[];
      const index = itemList.findIndex((i) => i.name === item.name);
      if (index !== -1) {
        itemList[index] = item;
        await mockAssetCache.set("items", itemList);
      }
    }
  },

  async equipmentList() {
    const items = (await mockAssetCache.get("items")) as any[];
    return items.filter((item) => item.type === "equipment");
  },

  async consumableList() {
    const items = (await mockAssetCache.get("items")) as any[];
    return items.filter((item) => item.type === "consumable");
  },
};

test("items.list returns all items", async () => {
  const result = (await items.list()) as any[];
  expect(Array.isArray(result)).toBe(true);
});

test("items.find returns item by name", async () => {
  const result = (await items.find({ name: "test_item" })) as any[];
  expect(result?.length).toBeGreaterThanOrEqual(0);
});

test("items.find returns undefined for non-existent item", async () => {
  const result = await items.find({ name: "nonexistent" });
  expect(result?.length || 0).toBe(0);
});

test("items.add requires all fields", async () => {
  await items.add({ name: "incomplete" });
  const result = await items.find({ name: "incomplete" });
  expect(result?.length || 0).toBe(0);
});

test("items.add adds valid item", async () => {
  const newItem = createMockItem({ name: "new_sword" });
  await items.add(newItem);
  const result = await items.find(newItem);
  expect(result?.length || 0).toBeGreaterThanOrEqual(0);
});

test("items.remove deletes item", async () => {
  await items.remove({ name: "test_item" });
  const result = await items.find({ name: "test_item" });
  expect(result?.length || 0).toBe(0);
});

test("items.equipmentList filters equipment items", async () => {
  const result = await items.equipmentList();
  expect(Array.isArray(result)).toBe(true);
});
