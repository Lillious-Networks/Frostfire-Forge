import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";

const quests = {
  async add(quest: Quest) {
    if (!quest?.name || !quest?.description || !quest?.reward || !quest?.xp_gain || !quest?.required_quest || !quest?.required_level) return;
    return await query("INSERT INTO quests (name, description, reward, xp_gain, required_quest, required_level) VALUES (?, ?, ?, ?, ?, ?)", [quest.name, quest.description, quest.reward, quest.xp_gain, quest.required_quest, quest.required_level]);
  },
  async remove(id: number) {
    if (!id) return;
    return await query("DELETE FROM quests WHERE id = ?", [id]);
  },
  async list() {
    return await query("SELECT * FROM quests");
  },
  async find(id: number) {
    if (!id) return;
    return await query("SELECT * FROM quests WHERE id = ?", [id]);
  },
  async update(quest: Quest) {
    if (!quest?.id) return;
    const result = await query("UPDATE quests SET name = ?, description = ?, reward = ?, xp_gain = ?, required_quest = ?, required_level = ? WHERE id = ?", [quest.name, quest.description, quest.reward, quest.xp_gain, quest.required_quest, quest.required_level, quest.id]);
    if (result) {
      const quests = await assetCache.get("quests") as Quest[];
      const index = quests.findIndex((q) => q.id === quest.id);
      quests[index] = quest;
      assetCache.set("quests", quests);
    }
  }
}

export default quests;