import query from "../controllers/sqldatabase";
import quests from "./quests";

const questlog = {
  async get(username: string) {
    const result = await query("SELECT completed_quests, incomplete_quests FROM quest_log WHERE username = ?", [username]) as any[];
    if (!result || !result[0]) {
      return { completed: [], incomplete: [] };
    }
    const completed = result[0].completed_quests ? result[0].completed_quests.split(",") : [];
    const incomplete = result[0].incomplete_quests ? result[0].incomplete_quests.split(",") : [];
    return { completed, incomplete };
  },
  async startQuest(username: string, id: number) {
    const quest = await quests.find(id);
    if (!quest) return;
    const questLog = await questlog.get(username);
    questLog.incomplete.push(id);
    await questlog.updateQuestLog(username, questLog);
  },
  async updateQuestLog(username: string, questLog: any) {
    return await query("UPDATE quest_log SET completed_quests = ?, incomplete_quests = ? WHERE username = ?", [questLog.completed.join(","), questLog.incomplete.join(","), username]);
  },
  async completeQuest(username: string, id: number) {
    const quest = await quests.find(id);
    if (!quest) return;
    const questLog = await questlog.get(username);
    if (questLog.incomplete.includes(id)) {
      questLog.incomplete.splice(questLog.incomplete.indexOf(id), 1);
      questLog.completed.push(id);
      await questlog.updateQuestLog(username, questLog);
    }
  }
}

export default questlog;
export interface KillCreditUpdate {
  questId: number;
  templateId: number;
  count: number;
  required: number;
}

/**
 * Creature kill objectives: quest_kill_objectives defines "kill N of template",
 * quest_kill_progress tracks each player's count for quests they have active.
 */
export const questKills = {
  /** Credit one kill of `templateId` to every active quest that needs it. Returns the changed objectives. */
  async creditKill(username: string, templateId: number): Promise<KillCreditUpdate[]> {
    if (!username) return [];
    username = username.toLowerCase();
    const objectives = (await query(
      "SELECT quest_id, template_id, required_count FROM quest_kill_objectives WHERE template_id = ?",
      [templateId]
    )) as Array<{ quest_id: number; template_id: number; required_count: number }>;
    if (!objectives || objectives.length === 0) return [];

    const log = await questlog.get(username);
    const active = new Set((log.incomplete as Array<string | number>).map((id) => Number(id)));
    const updates: KillCreditUpdate[] = [];
    for (const objective of objectives) {
      const questId = Number(objective.quest_id);
      if (!active.has(questId)) continue;
      const required = Math.max(1, Number(objective.required_count) || 1);
      const rows = (await query(
        "SELECT kill_count FROM quest_kill_progress WHERE username = ? AND quest_id = ? AND template_id = ?",
        [username, questId, templateId]
      )) as Array<{ kill_count: number }>;
      const current = rows?.[0] ? Number(rows[0].kill_count) || 0 : null;
      if (current !== null && current >= required) continue;
      const next = (current ?? 0) + 1;
      if (current === null) {
        await query(
          "INSERT INTO quest_kill_progress (username, quest_id, template_id, kill_count) VALUES (?, ?, ?, ?)",
          [username, questId, templateId, next]
        );
      } else {
        await query(
          "UPDATE quest_kill_progress SET kill_count = ? WHERE username = ? AND quest_id = ? AND template_id = ?",
          [next, username, questId, templateId]
        );
      }
      updates.push({ questId, templateId, count: next, required });
    }
    return updates;
  },

  /** True when every kill objective of the quest is met (quests without objectives count as complete). */
  async objectivesComplete(username: string, questId: number): Promise<boolean> {
    username = username.toLowerCase();
    const objectives = (await query(
      "SELECT template_id, required_count FROM quest_kill_objectives WHERE quest_id = ?",
      [questId]
    )) as Array<{ template_id: number; required_count: number }>;
    for (const objective of objectives || []) {
      const rows = (await query(
        "SELECT kill_count FROM quest_kill_progress WHERE username = ? AND quest_id = ? AND template_id = ?",
        [username, questId, objective.template_id]
      )) as Array<{ kill_count: number }>;
      if ((Number(rows?.[0]?.kill_count) || 0) < (Number(objective.required_count) || 1)) return false;
    }
    return true;
  },
};
