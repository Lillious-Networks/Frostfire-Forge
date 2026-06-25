import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

const spells = {
  async add(spell: SpellData) {
    if (!spell?.name) return;
    return await query(
      "INSERT IGNORE INTO spells (name, damage, mana, type, range, cast_time, description, can_move, effects) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [spell.name, spell.damage, spell.mana, spell.type, spell.range, spell.cast_time, spell.description, spell.can_move || 0, JSON.stringify(spell.effects || [])]
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
        "UPDATE spells SET damage = ?, mana = ?, type = ?, range = ?, cast_time = ?, description = ?, can_move = ?, effects = ? WHERE name = ?",
        [spell.damage, spell.mana, spell.type, spell.range, spell.cast_time, spell.description, spell.can_move, JSON.stringify(spell.effects || []), spell.name]
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
  },
  async learnSpell(username: string, spellName: string) {
    return await query(
      "INSERT IGNORE INTO learned_spells (username, spell) VALUES (?, ?)",
      [username, spellName]
    );
  },
  async unlearnSpell(username: string, spellName: string) {
    return await query(
      "DELETE FROM learned_spells WHERE username = ? AND spell = ?",
      [username, spellName]
    );
  }
};

export default spells;
