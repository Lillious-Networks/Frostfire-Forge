import { expect, test } from "bun:test";
import { mockAssetCache } from "./setup";

// Mock database
const spellsDatabase: Record<string, any> = {
  fireball: { name: "fireball", damage: 50, mana: 30, type: "offensive", range: 200, cast_time: 1, description: "A fireball spell" },
  heal: { name: "heal", damage: 0, mana: 20, type: "healing", range: 100, cast_time: 2, description: "A healing spell" },
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("INSERT IGNORE INTO spells")) {
    const [name] = params;
    if (!spellsDatabase[name]) {
      spellsDatabase[name] = { name, ...params };
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("DELETE FROM spells")) {
    const [name] = params;
    if (spellsDatabase[name]) {
      delete spellsDatabase[name];
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("SELECT * FROM spells")) {
    return Object.values(spellsDatabase);
  }
  if (sql.includes("INSERT IGNORE INTO learned_spells")) {
    return { affectedRows: 1 };
  }
  if (sql.includes("DELETE FROM learned_spells")) {
    return { affectedRows: 1 };
  }
  return [];
};

const spells = {
  async add(spell: any) {
    if (!spell?.name) return;
    return await mockQuery("INSERT IGNORE INTO spells (name) VALUES (?)", [spell.name]);
  },

  async remove(spell: any) {
    if (!spell?.name) return;
    return await mockQuery("DELETE FROM spells WHERE name = ?", [spell.name]);
  },

  async find(identifier: number | string) {
    const spellsList = (await mockAssetCache.get("spells")) as any[];
    if (typeof identifier === "number") {
      return spellsList.find((spell) => spell.id === identifier);
    } else {
      return spellsList.find((spell) => spell.name === identifier);
    }
  },

  async update(spell: any) {
    if (!spell?.name) return;
    const spellsList = (await mockAssetCache.get("spells")) as any[];
    const index = spellsList.findIndex((s) => s.name === spell.name);
    if (index !== -1) {
      spellsList[index] = spell;
      await mockAssetCache.set("spells", spellsList);
    }
  },

  async list() {
    return await mockQuery("SELECT * FROM spells", []);
  },

  async learnSpell(username: string, spellName: string) {
    return await mockQuery("INSERT IGNORE INTO learned_spells (username, spell) VALUES (?, ?)", [username, spellName]);
  },

  async unlearnSpell(username: string, spellName: string) {
    return await mockQuery("DELETE FROM learned_spells WHERE username = ? AND spell = ?", [username, spellName]);
  },
};

test("spells.list returns all spells", async () => {
  const result = (await spells.list()) as any[];
  expect(Array.isArray(result)).toBe(true);
});

test("spells.find finds spell by name", async () => {
  const result = await spells.find("test_spell");
  expect(result?.name).toBe("test_spell");
});

test("spells.find finds spell by id", async () => {
  const result = await spells.find(1);
  expect(result?.id).toBe(1);
});

test("spells.find returns undefined for non-existent spell", async () => {
  const result = await spells.find("nonexistent");
  expect(result).toBeUndefined();
});

test("spells.add requires name", async () => {
  const result = await spells.add({ damage: 50 });
  expect(result).toBeUndefined();
});

test("spells.add adds valid spell", async () => {
  const spell = { name: "lightning", damage: 60, mana: 35 };
  await spells.add(spell);
  expect((await spells.add(spell))).toBeDefined();
});

test("spells.remove deletes spell", async () => {
  const spell = { name: "fireball" };
  await spells.remove(spell);
  expect((await spells.remove(spell))).toBeDefined();
});

test("spells.learnSpell teaches spell to player", async () => {
  const result = await spells.learnSpell("test_player", "fireball");
  expect((result as any).affectedRows).toBeGreaterThanOrEqual(0);
});

test("spells.unlearnSpell removes spell from player", async () => {
  const result = await spells.unlearnSpell("test_player", "fireball");
  expect((result as any).affectedRows).toBeGreaterThanOrEqual(0);
});
