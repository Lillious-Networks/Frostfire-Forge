import query from "../../controllers/sqldatabase";
import playerCache from "../../services/playermanager";
import log from "../../modules/logger";
import { listener } from "../../modules/event_bus";
import { Events } from "../events";
import { find, indexes, getCachedQuestsSync } from "./definitions";
import { getCachedLog, setCachedLog } from "./log";

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const normMap = (m: unknown): string => String(m ?? "").replaceAll(".json", "").toLowerCase();

/** Usernames with at least one active point+radius explore objective. */
const radiusPlayers = new Set<string>();

function findCachedPlayer(username: string): any | null {
  const target = lower(username);
  const all = playerCache.list() as Record<string, any>;
  for (const p of Object.values(all || {})) {
    if (p && lower(p.username) === target) return p;
  }
  return null;
}

function candidateQuestIds(type: QuestObjectiveType, target: string): number[] {
  const idx = indexes();
  if (type === "kill") return idx.byKillTarget.get(String(target)) || [];
  if (type === "collect") return idx.byCollectTarget.get(String(target).toLowerCase()) || [];
  if (type === "talk") return idx.byTalkTarget.get(String(target)) || [];
  if (type === "explore") return idx.byExploreMap.get(normMap(target)) || [];
  return [];
}

async function writeProgress(username: string, questId: number, objectiveId: number, count: number): Promise<void> {
  const uname = lower(username);
  try {
    const existing = (await query(
      "SELECT count FROM quest_objective_progress WHERE username = ? AND quest_id = ? AND objective_id = ?",
      [uname, questId, objectiveId]
    )) as any[];
    if (existing && existing.length > 0) {
      await query(
        "UPDATE quest_objective_progress SET count = ? WHERE username = ? AND quest_id = ? AND objective_id = ?",
        [count, uname, questId, objectiveId]
      );
    } else {
      await query(
        "INSERT INTO quest_objective_progress (username, quest_id, objective_id, count) VALUES (?, ?, ?, ?)",
        [uname, questId, objectiveId, count]
      );
    }
  } catch (error) {
    log.error(`Quest progress write failed for ${uname} quest ${questId} objective ${objectiveId}: ${error}`);
  }
}

function questObjectives(questId: number): QuestObjective[] {
  const quest = find(questId) || getCachedQuestsSync().find((q) => q.id === Number(questId));
  return quest?.objectives || [];
}

function entryIsComplete(quest: Quest, entry: QuestLogEntry): boolean {
  if ((quest.objectives || []).length === 0) return true;
  for (const o of quest.objectives) {
    const count = Number(entry.progress[o.id]) || 0;
    if (count < o.required_count) return false;
  }
  return true;
}

async function markReady(username: string, entry: QuestLogEntry): Promise<void> {
  const uname = lower(username);
  entry.state = "ready";
  try {
    await query("UPDATE quest_log SET state = 'ready' WHERE username = ? AND quest_id = ?", [uname, entry.quest_id]);
  } catch (error) {
    log.error(`Quest ready transition failed for ${uname} quest ${entry.quest_id}: ${error}`);
  }
}

async function markActive(username: string, entry: QuestLogEntry): Promise<void> {
  const uname = lower(username);
  if (entry.state !== "ready") return;
  entry.state = "active";
  try {
    await query("UPDATE quest_log SET state = 'active' WHERE username = ? AND quest_id = ? AND state = 'ready'", [uname, entry.quest_id]);
  } catch (error) {
    log.error(`Quest un-ready transition failed for ${uname} quest ${entry.quest_id}: ${error}`);
  }
}

export function trackRadiusPlayer(username: string): void {
  const uname = lower(username);
  const cached = getCachedLog(username);
  if (!cached) {
    radiusPlayers.delete(uname);
    return;
  }
  for (const entry of cached.active) {
    if (entry.state === "completed") continue;
    for (const o of questObjectives(entry.quest_id)) {
      if (o.type === "explore" && o.target_radius) {
        radiusPlayers.add(uname);
        return;
      }
    }
  }
  radiusPlayers.delete(uname);
}

export function hasRadiusPlayers(): boolean {
  return radiusPlayers.size > 0;
}

export function getRadiusPlayers(): string[] {
  return [...radiusPlayers];
}

export function clearRadiusPlayersForTests(): void {
  radiusPlayers.clear();
}

/**
 * Add `amount` to every active objective matching (type, target).
 * Only touches the DB when a count actually changes.
 */
export async function credit(
  username: string,
  type: QuestObjectiveType,
  target: string,
  amount: number
): Promise<ObjectiveUpdate[]> {
  const uname = lower(username);
  if (!uname || !amount || amount <= 0) return [];
  const candidates = candidateQuestIds(type, target);
  if (candidates.length === 0) return [];

  const cached = getCachedLog(username);
  if (!cached) return [];
  const activeByQuest = new Map<number, QuestLogEntry>();
  for (const e of cached.active) {
    if (e.state === "completed") continue;
    activeByQuest.set(e.quest_id, e);
  }
  const relevant = candidates.filter((qid) => activeByQuest.has(qid));
  if (relevant.length === 0) return [];

  const updates: ObjectiveUpdate[] = [];
  let cacheDirty = false;
  for (const qid of relevant) {
    const quest = find(qid) || getCachedQuestsSync().find((q) => q.id === qid);
    if (!quest) continue;
    const entry = activeByQuest.get(qid)!;
    for (const o of quest.objectives || []) {
      if (o.type !== type) continue;
      if (type === "collect") continue; // collect is sync-only.
      if (type === "explore" && o.target_radius) continue; // radius handled by position checks.
      const key = type === "explore" ? normMap(o.target) !== normMap(target) : String(o.target).toLowerCase() !== String(target).toLowerCase();
      if (type === "kill" || type === "talk") {
        if (String(o.target) !== String(target)) continue;
      } else if (key) {
        continue;
      }
      const current = Number(entry.progress[o.id]) || 0;
      if (current >= o.required_count) continue;
      const next = Math.min(o.required_count, current + amount);
      if (next === current) continue;
      await writeProgress(username, qid, o.id, next);
      entry.progress[o.id] = next;
      cacheDirty = true;
      const wasComplete = entry.state === "ready";
      let questReady = false;
      if (!wasComplete && entryIsComplete(quest, entry)) {
        await markReady(username, entry);
        questReady = true;
      }
      const update: ObjectiveUpdate = {
        questId: qid,
        objectiveId: o.id,
        type,
        target: o.target,
        count: next,
        required: o.required_count,
        questReady,
      };
      updates.push(update);
      listener.emit(Events.QUEST_OBJECTIVE_PROGRESS, {
        username: uname,
        questId: qid,
        objectiveId: o.id,
        count: next,
        required: o.required_count,
      });
      if (questReady) {
        listener.emit(Events.QUEST_READY, { username: uname, questId: qid });
      }
    }
  }
  if (cacheDirty) setCachedLog(username, cached);
  if (updates.some((u) => u.questReady)) trackRadiusPlayer(username);
  return updates;
}

/**
 * Set an objective's count to an absolute value. Used by collect, where the
 * player's inventory is the source of truth and items can be lost as well as
 * gained. Also used by map-wide explore objectives.
 */
export async function sync(
  username: string,
  type: QuestObjectiveType,
  target: string,
  total: number
): Promise<ObjectiveUpdate[]> {
  const uname = lower(username);
  if (!uname) return [];
  const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
  const candidates = candidateQuestIds(type, target);
  if (candidates.length === 0) return [];

  const cached = getCachedLog(username);
  if (!cached) return [];
  const activeByQuest = new Map<number, QuestLogEntry>();
  for (const e of cached.active) {
    if (e.state === "completed") continue;
    activeByQuest.set(e.quest_id, e);
  }
  const relevant = candidates.filter((qid) => activeByQuest.has(qid));
  if (relevant.length === 0) return [];

  const updates: ObjectiveUpdate[] = [];
  let cacheDirty = false;
  for (const qid of relevant) {
    const quest = find(qid) || getCachedQuestsSync().find((q) => q.id === qid);
    if (!quest) continue;
    const entry = activeByQuest.get(qid)!;
    for (const o of quest.objectives || []) {
      if (o.type !== type) continue;
      if (type === "explore" && o.target_radius) continue;
      if (type === "kill" || type === "talk") {
        if (String(o.target) !== String(target)) continue;
      } else if (type === "collect") {
        if (String(o.target).toLowerCase() !== String(target).toLowerCase()) continue;
      } else if (type === "explore") {
        if (normMap(o.target) !== normMap(target)) continue;
      }
      const clamped = Math.min(o.required_count, safeTotal);
      const current = Number(entry.progress[o.id]) || 0;
      if (clamped === current) continue;
      await writeProgress(username, qid, o.id, clamped);
      entry.progress[o.id] = clamped;
      cacheDirty = true;
      let questReady = false;
      if (entryIsComplete(quest, entry)) {
        if (entry.state !== "ready") {
          await markReady(username, entry);
          questReady = true;
        }
      } else if (entry.state === "ready") {
        await markActive(username, entry);
      }
      const update: ObjectiveUpdate = {
        questId: qid,
        objectiveId: o.id,
        type,
        target: o.target,
        count: clamped,
        required: o.required_count,
        questReady,
      };
      updates.push(update);
      listener.emit(Events.QUEST_OBJECTIVE_PROGRESS, {
        username: uname,
        questId: qid,
        objectiveId: o.id,
        count: clamped,
        required: o.required_count,
      });
      if (questReady) {
        listener.emit(Events.QUEST_READY, { username: uname, questId: qid });
      }
    }
  }
  if (cacheDirty) setCachedLog(username, cached);
  return updates;
}

/** All objectives of a quest met? Quests with no objectives are trivially complete. */
export function isComplete(username: string, questId: number): boolean {
  const quest = find(Number(questId)) || getCachedQuestsSync().find((q) => q.id === Number(questId));
  if (!quest) return false;
  if ((quest.objectives || []).length === 0) return true;
  const cached = getCachedLog(username);
  const entry = cached?.active.find((e) => e.quest_id === Number(questId));
  if (!entry) return false;
  return entryIsComplete(quest, entry);
}

/** Wipe progress for one quest (abandon, or re-accepting a repeatable). */
export async function clear(username: string, questId: number): Promise<void> {
  const uname = lower(username);
  try {
    await query("DELETE FROM quest_objective_progress WHERE username = ? AND quest_id = ?", [uname, Number(questId)]);
  } catch (error) {
    log.error(`Quest progress clear failed for ${uname} quest ${questId}: ${error}`);
  }
  const cached = getCachedLog(username);
  const entry = cached?.active.find((e) => e.quest_id === Number(questId));
  if (entry) {
    entry.progress = {};
    if (entry.state === "ready") {
      const quest = find(Number(questId));
      // Zero-objective quests stay ready even with empty progress.
      if (quest && (quest.objectives || []).length > 0) {
        entry.state = "active";
      }
    }
    setCachedLog(username, cached!);
  }
}

/** Point+radius explore check for one player position. */
export async function checkExplorePosition(
  username: string,
  mapName: string,
  x: number,
  y: number
): Promise<ObjectiveUpdate[]> {
  const uname = lower(username);
  if (!uname) return [];
  const cached = getCachedLog(username);
  if (!cached) return [];
  const normalized = normMap(mapName);
  const updates: ObjectiveUpdate[] = [];
  let cacheDirty = false;
  for (const entry of cached.active) {
    if (entry.state === "completed") continue;
    const quest = find(entry.quest_id) || getCachedQuestsSync().find((q) => q.id === entry.quest_id);
    if (!quest) continue;
    for (const o of quest.objectives || []) {
      if (o.type !== "explore" || !o.target_radius) continue;
      if (normMap(o.target) !== normalized) continue;
      if (o.target_x === null || o.target_x === undefined || o.target_y === null || o.target_y === undefined) continue;
      const dist = Math.hypot(Number(x) - Number(o.target_x), Number(y) - Number(o.target_y));
      if (dist > Number(o.target_radius)) continue;
      const current = Number(entry.progress[o.id]) || 0;
      if (current >= o.required_count) continue;
      const next = o.required_count;
      await writeProgress(username, entry.quest_id, o.id, next);
      entry.progress[o.id] = next;
      cacheDirty = true;
      let questReady = false;
      if (entryIsComplete(quest, entry) && entry.state !== "ready") {
        await markReady(username, entry);
        questReady = true;
      }
      const update: ObjectiveUpdate = {
        questId: entry.quest_id,
        objectiveId: o.id,
        type: "explore",
        target: o.target,
        count: next,
        required: o.required_count,
        questReady,
      };
      updates.push(update);
      listener.emit(Events.QUEST_OBJECTIVE_PROGRESS, {
        username: uname,
        questId: entry.quest_id,
        objectiveId: o.id,
        count: next,
        required: o.required_count,
      });
      if (questReady) {
        listener.emit(Events.QUEST_READY, { username: uname, questId: entry.quest_id });
      }
    }
  }
  if (cacheDirty) setCachedLog(username, cached);
  if (updates.some((u) => u.questReady)) trackRadiusPlayer(username);
  return updates;
}

/** Periodic radius check. Only players in the radius set cost anything. */
export async function tickRadiusObjectives(): Promise<Map<string, ObjectiveUpdate[]>> {
  const results = new Map<string, ObjectiveUpdate[]>();
  if (radiusPlayers.size === 0) return results;
  for (const uname of [...radiusPlayers]) {
    const player = findCachedPlayer(uname);
    const pos = player?.location?.position;
    const map = player?.location?.map;
    if (!pos || !map) continue;
    try {
      const updates = await checkExplorePosition(uname, String(map), Number(pos.x) || 0, Number(pos.y) || 0);
      if (updates.length > 0) results.set(uname, updates);
    } catch (error) {
      log.warn(`Quest radius tick failed for ${uname}: ${error}`);
    }
  }
  return results;
}

let hooksRegistered = false;

/** Wire explore hooks. Called once from the quest index module. */
export function registerExploreHooks(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  // Map-wide explore objectives credit on map enter.
  listener.on(Events.MAP_ENTER, async ({ player, mapName }: any) => {
    try {
      const username = player?.username;
      if (!username) return;
      const normalized = normMap(mapName);
      const candidates = indexes().byExploreMap.get(normalized) || [];
      if (candidates.length === 0) return;
      await sync(username, "explore", normalized, 1);
      // Radius objectives on this map are checked immediately too, so a
      // player who logs in standing inside the radius completes it at once.
      const pos = player?.location?.position;
      if (pos) {
        await checkExplorePosition(username, normalized, Number(pos.x) || 0, Number(pos.y) || 0);
      }
    } catch (error) {
      log.warn(`Quest map-enter explore credit failed: ${error}`);
    }
  });
  // Point+radius objectives tick once per second, not in the 30Hz path.
  listener.on(Events.SERVER_TICK, async () => {
    try {
      await tickRadiusObjectives();
    } catch (error) {
      log.warn(`Quest radius tick failed: ${error}`);
    }
  });
}

const questObjectivesApi = {
  credit,
  sync,
  isComplete,
  clear,
  checkExplorePosition,
  tickRadiusObjectives,
  trackRadiusPlayer,
  hasRadiusPlayers,
  getRadiusPlayers,
  registerExploreHooks,
};

export default questObjectivesApi;
