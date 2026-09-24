import query from "../../controllers/sqldatabase";
import assetCache from "../../services/assetCache";
import log from "../../modules/logger";

export interface QuestIndexes {
  byKillTarget: Map<string, number[]>;
  byCollectTarget: Map<string, number[]>;
  byTalkTarget: Map<string, number[]>;
  byExploreMap: Map<string, number[]>;
  byGiverNpc: Map<number, number[]>;
  byEnderNpc: Map<number, number[]>;
}

function emptyIndexes(): QuestIndexes {
  return {
    byKillTarget: new Map(),
    byCollectTarget: new Map(),
    byExploreMap: new Map(),
    byTalkTarget: new Map(),
    byGiverNpc: new Map(),
    byEnderNpc: new Map(),
  };
}

let cachedIndexes: QuestIndexes = emptyIndexes();

function pushTo(map: Map<string, number[]>, key: string, questId: number): void {
  const k = String(key);
  const existing = map.get(k);
  if (existing) {
    if (!existing.includes(questId)) existing.push(questId);
  } else {
    map.set(k, [questId]);
  }
}

function pushToNum(map: Map<number, number[]>, key: number, questId: number): void {
  const existing = map.get(key);
  if (existing) {
    if (!existing.includes(questId)) existing.push(questId);
  } else {
    map.set(key, [questId]);
  }
}

function normalizeMapName(name: unknown): string {
  return String(name ?? "").replaceAll(".json", "");
}

export function buildIndexes(quests: Quest[], npcLinks: Array<{ npc_id: number; quest_id: number; role: string }>): QuestIndexes {
  const idx = emptyIndexes();
  for (const q of quests || []) {
    for (const o of q.objectives || []) {
      if (o.type === "kill") pushTo(idx.byKillTarget, String(o.target), q.id);
      else if (o.type === "collect") pushTo(idx.byCollectTarget, String(o.target).toLowerCase(), q.id);
      else if (o.type === "talk") pushTo(idx.byTalkTarget, String(o.target), q.id);
      else if (o.type === "explore") pushTo(idx.byExploreMap, normalizeMapName(o.target), q.id);
    }
  }
  for (const link of npcLinks || []) {
    const npcId = Number(link.npc_id);
    const questId = Number(link.quest_id);
    if (!Number.isFinite(npcId) || !Number.isFinite(questId)) continue;
    if (link.role === "giver") pushToNum(idx.byGiverNpc, npcId, questId);
    else if (link.role === "ender") pushToNum(idx.byEnderNpc, npcId, questId);
  }
  return idx;
}

function toBool(v: unknown): boolean {
  return v === 1 || v === true || v === "1";
}

function hydrateQuest(
  row: any,
  objectivesByQuest: Map<number, QuestObjective[]>,
  rewardsByQuest: Map<number, QuestReward[]>,
  prereqsByQuest: Map<number, number[]>
): Quest {
  const id = Number(row.id);
  return {
    id,
    name: String(row.name ?? ""),
    zone: row.zone ?? null,
    offer_text: String(row.offer_text ?? ""),
    description: String(row.description ?? ""),
    progress_text: String(row.progress_text ?? ""),
    completion_text: String(row.completion_text ?? ""),
    required_level: Number(row.required_level) || 1,
    quest_level: Number(row.quest_level) || 0,
    xp_reward: Number(row.xp_reward) || 0,
    copper_reward: Number(row.copper_reward) || 0,
    repeatable: (row.repeatable === "repeatable" || row.repeatable === "daily" ? row.repeatable : "none") as Quest["repeatable"],
    next_quest_id: row.next_quest_id === null || row.next_quest_id === undefined ? null : Number(row.next_quest_id),
    sort_order: Number(row.sort_order) || 0,
    objectives: (objectivesByQuest.get(id) || []).slice().sort((a, b) => a.sort_order - b.sort_order),
    rewards: (rewardsByQuest.get(id) || []).slice().sort((a, b) => a.sort_order - b.sort_order),
    prerequisites: (prereqsByQuest.get(id) || []).slice(),
  };
}

/** Load every quest fully hydrated (objectives, rewards, prerequisites). */
export async function list(): Promise<Quest[]> {
  const questRows = ((await query("SELECT * FROM quests ORDER BY sort_order, id")) as any[]) || [];
  const objectiveRows = ((await query("SELECT * FROM quest_objectives ORDER BY quest_id, sort_order, id")) as any[]) || [];
  const rewardRows = ((await query("SELECT * FROM quest_rewards ORDER BY quest_id, sort_order, id")) as any[]) || [];
  const prereqRows = ((await query("SELECT quest_id, required_quest_id FROM quest_prerequisites")) as any[]) || [];
  let npcLinks: Array<{ npc_id: number; quest_id: number; role: string }> = [];
  try {
    npcLinks = ((await query("SELECT npc_id, quest_id, `role` FROM npc_quests")) as any[]) || [];
  } catch {
    npcLinks = [];
  }

  const objectivesByQuest = new Map<number, QuestObjective[]>();
  for (const r of objectiveRows) {
    const qid = Number(r.quest_id);
    const listForQuest = objectivesByQuest.get(qid) || [];
    listForQuest.push({
      id: Number(r.id),
      quest_id: qid,
      sort_order: Number(r.sort_order) || 0,
      type: r.type as QuestObjectiveType,
      target: String(r.target ?? ""),
      required_count: Math.max(1, Number(r.required_count) || 1),
      target_x: r.target_x === null || r.target_x === undefined ? null : Number(r.target_x),
      target_y: r.target_y === null || r.target_y === undefined ? null : Number(r.target_y),
      target_radius: r.target_radius === null || r.target_radius === undefined ? null : Number(r.target_radius),
      description: r.description ?? null,
    });
    objectivesByQuest.set(qid, listForQuest);
  }

  const rewardsByQuest = new Map<number, QuestReward[]>();
  for (const r of rewardRows) {
    const qid = Number(r.quest_id);
    const listForQuest = rewardsByQuest.get(qid) || [];
    listForQuest.push({
      id: Number(r.id),
      quest_id: qid,
      item_name: String(r.item_name ?? ""),
      quantity: Math.max(1, Number(r.quantity) || 1),
      is_choice: toBool(r.is_choice),
      sort_order: Number(r.sort_order) || 0,
    });
    rewardsByQuest.set(qid, listForQuest);
  }

  const prereqsByQuest = new Map<number, number[]>();
  for (const r of prereqRows) {
    const qid = Number(r.quest_id);
    const listForQuest = prereqsByQuest.get(qid) || [];
    listForQuest.push(Number(r.required_quest_id));
    prereqsByQuest.set(qid, listForQuest);
  }

  const quests = questRows.map((row) => hydrateQuest(row, objectivesByQuest, rewardsByQuest, prereqsByQuest));
  await assetCache.set("quests", quests);
  setCachedQuestsSync(quests);
  cachedIndexes = buildIndexes(quests, npcLinks);
  const objectiveCount = objectiveRows.length;
  const rewardCount = rewardRows.length;
  log.success(`Loaded ${quests.length} quest(s) with ${objectiveCount} objective(s) and ${rewardCount} reward(s) from the database`);
  return quests;
}

/** Synchronous read from the in-memory mirror (populated at asset-load time). */
export function find(id: number): Quest | undefined {
  return syncMirror.find((q) => q.id === Number(id));
}

export const findSync = find;

// assetCache is async-only; keep a module-level mirror for sync reads.
let syncMirror: Quest[] = [];

export function getCachedQuestsSync(): Quest[] {
  return syncMirror;
}

export function setCachedQuestsSync(quests: Quest[]): void {
  syncMirror = quests || [];
}

export function indexes(): QuestIndexes {
  return cachedIndexes;
}

export function setIndexesForTests(idx: QuestIndexes): void {
  cachedIndexes = idx;
}

/** Re-query and rebuild indexes; called by the editor after a save. */
export async function reload(): Promise<void> {
  await reloadAndMirror();
}

export function isGiver(npcId: number, questId: number): boolean {
  return cachedIndexes.byGiverNpc.get(Number(npcId))?.includes(Number(questId)) || false;
}

export function isEnder(npcId: number, questId: number): boolean {
  return cachedIndexes.byEnderNpc.get(Number(npcId))?.includes(Number(questId)) || false;
}

export function questsGivenBy(npcId: number): number[] {
  return cachedIndexes.byGiverNpc.get(Number(npcId)) || [];
}

export function questsEndedBy(npcId: number): number[] {
  return cachedIndexes.byEnderNpc.get(Number(npcId)) || [];
}

/** NPC links for one quest (the quest editor edits both directions). */
export function npcLinksForQuest(questId: number): { givers: number[]; enders: number[] } {
  const qid = Number(questId);
  const givers: number[] = [];
  const enders: number[] = [];
  for (const [npcId, ids] of cachedIndexes.byGiverNpc) {
    if (ids.includes(qid)) givers.push(npcId);
  }
  for (const [npcId, ids] of cachedIndexes.byEnderNpc) {
    if (ids.includes(qid)) enders.push(npcId);
  }
  return { givers, enders };
}

export async function listAndMirror(): Promise<Quest[]> {
  return list();
}

async function reloadAndMirror(): Promise<void> {
  await list();
}

const questDefinitions = {
  list: listAndMirror,
  find,
  reload: reloadAndMirror,
  indexes,
  buildIndexes,
  isGiver,
  isEnder,
  questsGivenBy,
  questsEndedBy,
  npcLinksForQuest,
  getCachedQuestsSync,
  setCachedQuestsSync,
};

export default questDefinitions;
