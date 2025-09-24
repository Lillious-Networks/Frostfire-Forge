import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

const weapons = {
  async add(weapon: WeaponData) {
    if (!weapon?.name) return;
    return await query(
      "INSERT IGNORE INTO weapons (name, damage, mana, type, description, quality) VALUES (?, ?, ?, ?, ?, ?)",
      [weapon.name, weapon.damage, weapon.mana, weapon.type, weapon.description, weapon.quality]
    );
  },
  async remove(weapon: WeaponData) {
    if (!weapon?.name) return;
    return await query("DELETE FROM weapons WHERE name = ?", [weapon.name]);
  },
  async find(weapon: WeaponData) {
    if (!weapon?.name) return;
    const weapons = await assetCache.get("weapons") as WeaponData[];
    return weapons.find((w) => w.name === weapon.name);
  },
  async update(weapon: WeaponData) {
    if (!weapon?.name) return;
    const result = await query(
      "UPDATE weapons SET damage = ?, mana = ?, type = ?, description = ?, quality = ? WHERE name = ?",
      [weapon.damage, weapon.mana, weapon.type, weapon.description, weapon.quality, weapon.name]
    );
    if (result) {
      const weapons = await assetCache.get("weapons") as WeaponData[];
      const index = weapons.findIndex((w) => w.name === weapon.name);
      weapons[index] = weapon;
      assetCache.set("weapons", weapons);
    }
  },
  async list() {
    return await query("SELECT * FROM weapons");
  }
};

export default weapons;
