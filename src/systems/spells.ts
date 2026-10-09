import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import { rowCache, dropRows, turns } from "../services/datacache";

/** A row of the learned_spells table. */
type LearnedRow = { spell: string };

// Each player's rows of learned_spells, as the table has them. What a player
// knows is answered from these, and learning and unlearning are written to
// the database and then to them.
const learnedRows = rowCache<LearnedRow[]>("learned_spells", async (username) =>
  (await query("SELECT spell FROM learned_spells WHERE username = ?", [username])) as LearnedRow[] || []
, { perPlayer: true });

// One write to a player's rows at a time. Each works from the rows held and
// puts back what its statement left, so two side by side would each put back
// rows without the other's change.
const oneAtATime = turns();

// The rows a WHERE on a spell's name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: string, b: string) =>
  (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

/**
 * A write of a player's learned spells: the statement, then what it left as
 * the rows held (`left` is handed the rows from before and the statement's
 * answer). A statement that fails may still have been written (one that
 * timed out, say), so the rows are forgotten and the next read asks the
 * database.
 */
function writeLearned(username: string, sql: string, values: unknown[], left: (held: LearnedRow[], result: any) => LearnedRow[]) {
  return oneAtATime(username, async () => {
    const held = (await learnedRows.get(username)) ?? [];
    try {
      const result = await query(sql, values);
      await learnedRows.set(username, left(held, result));
      return result;
    } catch (error) {
      await learnedRows.drop(username);
      throw error;
    }
  });
}

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
    try {
      return await writeLearned(
        username,
        "INSERT IGNORE INTO learned_spells (username, spell) VALUES (?, ?)",
        [username, spellName],
        // The table has no key a second row of the same spell would break: a row is added unless the database says none was.
        (held, result) => (Number(result?.affectedRows ?? result?.count) === 0 ? held : [...held, { spell: spellName }])
      );
    } finally {
      // Who knows this spell changed, or may have if the statement failed: the spell editor's list of them is read again.
      await dropRows("spell_usage", String(spellName).toLowerCase());
    }
  },
  async unlearnSpell(username: string, spellName: string) {
    try {
      return await writeLearned(
        username,
        "DELETE FROM learned_spells WHERE username = ? AND spell = ?",
        [username, spellName],
        (held) => held.filter((row) => !sameName(row.spell, spellName))
      );
    } finally {
      await dropRows("spell_usage", String(spellName).toLowerCase());
    }
  },
  async listLearned(username: string): Promise<string[]> {
    if (!username) return [];
    const rows = (await learnedRows.get(username)) ?? [];
    return rows.map((row) => row.spell);
  },
  // The shape a live player's learnedSpells holds, as built at login (socket/authentication.ts).
  async learnedDetails(username: string) {
    const all = await assetCache.get("spells") as SpellData[];
    const learned: Record<string, any> = Object.create(null);
    for (const name of await spells.listLearned(username)) {
      const spell = Array.isArray(all) ? all.find((s) => s.name === name) : null;
      if (!spell) continue;
      learned[name] = {
        icon: spell.icon ?? null,
        sprite: spell.sprite ?? null,
        description: spell.description ?? null,
        mana: spell.mana ?? 0,
        cooldown: spell.cooldown ?? 0,
        cast_time: spell.cast_time ?? 0,
        damage: spell.damage ?? 0,
        type: spell.type ?? null,
        effects: Array.isArray(spell.effects) ? spell.effects : [],
        particles: spell.particles ?? null,
        aoe_radius: spell.aoe_radius ?? null,
        ground_aoe: spell.ground_aoe ?? null,
        ground_duration: spell.ground_duration ?? null,
        is_thrown: spell.is_thrown ?? null,
        charge_distance: spell.charge_distance ?? null,
        teleport_behind: spell.teleport_behind ?? null,
        can_move: spell.can_move ? 1 : 0,
      };
    }
    return learned;
  }
};

export default spells;
