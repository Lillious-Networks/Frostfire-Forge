import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

const spells = {
  async add(spell: SpellData) {
    if (!spell?.name) return;
    return await query(
      "INSERT IGNORE INTO spells (name, damage, mana, type, range, cast_time, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [spell.name, spell.damage, spell.mana, spell.type, spell.range, spell.cast_time, spell.description]
    );
  },
  async remove(spell: SpellData) {
    if (!spell?.name) return;
    return await query("DELETE FROM spells WHERE name = ?", [spell.name]);
  },
  async find(identifier: number | string) {
    const spells = await assetCache.get("spells") as SpellData[];
    if (typeof identifier === "number") {
      return spells.find((spell) => spell.id === identifier);
    } else {
      return spells.find((spell) => spell.name === identifier);
    }
  },
  async update(spell: SpellData) {
    if (!spell?.name) return;
    const result = await query(
        "UPDATE spells SET damage = ?, mana = ?, type = ?, range = ?, cast_time = ?, description = ? WHERE name = ?",
        [spell.damage, spell.mana, spell.type, spell.range, spell.cast_time, spell.description, spell.name]
    );
    if (result) {
      const spells = await assetCache.get("spells") as SpellData[];
      const index = spells.findIndex((s) => s.name === spell.name);
      spells[index] = spell;
      assetCache.set("spells", spells);
    }
  },
  async list() {
    return await query("SELECT * FROM spells");
  }
};

export default spells;
