import query from "../../controllers/sqldatabase";
import playerCache from "../../services/playermanager";
import log from "../../modules/logger";
import { listener } from "../../modules/event_bus";
import { Events } from "../events";
import { find, questsGivenBy, questsEndedBy, isGiver, isEnder } from "./definitions";

export const MAX_ACTIVE_QUESTS = 25;
export const DAILY_RESET_UTC_HOUR = 3;

export interface AcceptResult {
  ok: boolean;
  entry?: QuestLogEntry;
  quest?: Quest;
  error?: string;
  code?: string;
}

export interface TurnInResult {
  ok: boolean;
  questId?: number;
  xp?: number;
  copper?: number;
  items?: Array<{ name: string; quantity: number }>;
  xpResult?: { xp: number; level: number; max_xp: number } | null;
  nextQuestId?: Nullable<number>;
  error?: string;
  code?: string;
}

/** Server-wide daily reset boundary (UTC). Returns ms epoch of the most recent reset. */
export function lastResetBoundary(nowMs: number = Date.now()): number {
  const now = new Date(nowMs);
  const boundary = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    DAILY_RESET_UTC_HOUR,
    0,
    0,
    0
  );
  if (nowMs < boundary) return boundary - 24 * 60 * 60 * 1000;
  return boundary;
}

const lower = (s: unknown): string => String(s ?? "").toLowerCase();

function findCachedPlayer(username: string): any | null {
  const target = lower(username);
  const all = playerCache.list() as Record<string, any>;
  for (const p of Object.values(all || {})) {
    if (p && lower(p.username) === target) return p;
  }
  return null;
}

export function getCachedLog(username: string): QuestLogData | null {
  const player = findCachedPlayer(username);
  if (!player) return null;
  if (player.questlog && Array.isArray(player.questlog.active)) return player.questlog as QuestLogData;
  return null;
}

export function setCachedLog(username: string, data: QuestLogData): void {
  const player = findCachedPlayer(username);
  if (!player) return;
  player.questlog = data;
  if (player.id) playerCache.set(player.id, player);
}

async function getPlayerLevel(username: string): Promise<number> {
  const player = findCachedPlayer(username);
  const cached = Number(player?.stats?.level);
  if (Number.isFinite(cached) && cached > 0) return cached;
  try {
    const rows = (await query("SELECT level FROM stats WHERE username = ?", [lower(username)])) as any[];
    const lvl = Number(rows?.[0]?.level);
    if (Number.isFinite(lvl) && lvl > 0) return lvl;
  } catch {
    // Fall through to default.
  }
  return 1;
}

/** Load the log from the DB into the player cache. Called on login. */
export async function load(username: string): Promise<QuestLogData> {
  const uname = lower(username);
  const rows = ((await query(
    "SELECT quest_id, state, accepted_at, completed_at, times_completed FROM quest_log WHERE username = ?",
    [uname]
  )) as any[]) || [];
  const progressRows = ((await query(
    "SELECT quest_id, objective_id, count FROM quest_objective_progress WHERE username = ?",
    [uname]
  )) as any[]) || [];

  const progressByQuest = new Map<number, Record<number, number>>();
  for (const r of progressRows) {
    const qid = Number(r.quest_id);
    const oid = Number(r.objective_id);
    const bucket = progressByQuest.get(qid) || {};
    bucket[oid] = Number(r.count) || 0;
    progressByQuest.set(qid, bucket);
  }

  const active: QuestLogEntry[] = [];
  const completed: number[] = [];
  for (const r of rows) {
    const qid = Number(r.quest_id);
    const state = r.state as QuestState;
    if (state === "completed") {
      if (!completed.includes(qid)) completed.push(qid);
      continue;
    }
    active.push({
      quest_id: qid,
      state: state === "ready" ? "ready" : "active",
      accepted_at: Number(r.accepted_at) || 0,
      completed_at: Number(r.completed_at) || 0,
      times_completed: Number(r.times_completed) || 0,
      progress: progressByQuest.get(qid) || {},
    });
  }

  const data: QuestLogData = { active, completed };
  setCachedLog(username, data);
  // Ensure the shape exists even when the player is offline (tests).
  if (!findCachedPlayer(username)) {
    // No cache entry; callers still get the data.
  }
  return data;
}

async function readLog(username: string): Promise<QuestLogData> {
  const cached = getCachedLog(username);
  if (cached) return cached;
  return load(username);
}

export async function eligibility(username: string, questId: number): Promise<QuestEligibility> {
  const quest = find(Number(questId));
  if (!quest) return "unknown_quest";
  const data = await readLog(username);
  const completedSet = new Set(data.completed.map(Number));
  const activeEntry = data.active.find((e) => e.quest_id === quest.id);

  if (activeEntry) {
    return activeEntry.state === "ready" ? "ready" : "active";
  }

  const wasCompleted = completedSet.has(quest.id);
  if (wasCompleted) {
    if (quest.repeatable === "none") return "completed";
    if (quest.repeatable === "daily") {
      // Need completed_at from the DB row (completed rows are not in the active list).
      try {
        const rows = (await query(
          "SELECT completed_at FROM quest_log WHERE username = ? AND quest_id = ?",
          [lower(username), quest.id]
        )) as any[];
        const completedAt = Number(rows?.[0]?.completed_at) || 0;
        if (completedAt >= lastResetBoundary()) return "daily_not_reset";
      } catch {
        return "daily_not_reset";
      }
    }
    // repeatable: fall through to availability checks.
  }

  const level = await getPlayerLevel(username);
  if (level < quest.required_level) return "level_too_low";

  for (const pre of quest.prerequisites || []) {
    if (!completedSet.has(Number(pre))) return "missing_prerequisite";
  }

  if (data.active.length >= MAX_ACTIVE_QUESTS) return "log_full";
  return "available";
}

async function backfillOnAccept(username: string, quest: Quest): Promise<void> {
  const uname = lower(username);
  try {
    const { sync: syncObjective } = await import("./objectives");
    for (const o of quest.objectives || []) {
      if (o.type === "collect") {
        const rows = (await query("SELECT quantity FROM inventory WHERE username = ? AND item = ?", [uname, o.target])) as any[];
        const total = rows?.reduce((sum: number, r: any) => sum + (Number(r.quantity) || 0), 0) ?? 0;
        await syncObjective(username, "collect", o.target, total);
      } else if (o.type === "explore" && !o.target_radius) {
        const player = findCachedPlayer(username);
        const map = String(player?.location?.map ?? "").replaceAll(".json", "");
        if (map && map.toLowerCase() === String(o.target).replaceAll(".json", "").toLowerCase()) {
          await syncObjective(username, "explore", o.target, 1);
        }
      }
    }
    // Radius explore objectives are picked up by the periodic tick; if the
    // player is already standing in the radius, credit it now.
    const player = findCachedPlayer(username);
    if (player?.location?.position) {
      const { checkExplorePosition } = await import("./objectives");
      const map = String(player.location.map ?? "").replaceAll(".json", "");
      await checkExplorePosition(username, map, Number(player.location.position.x) || 0, Number(player.location.position.y) || 0);
    }
  } catch (error) {
    log.warn(`Quest accept backfill failed for ${uname} quest ${quest.id}: ${error}`);
  }
}

export async function accept(username: string, questId: number, npcId: number): Promise<AcceptResult> {
  const uname = lower(username);
  const quest = find(Number(questId));
  if (!quest) return { ok: false, error: "Unknown quest.", code: "unknown_quest" };
  if (!isGiver(Number(npcId), quest.id)) {
    return { ok: false, error: "That NPC does not offer this quest.", code: "not_giver" };
  }
  const state = await eligibility(username, quest.id);
  if (state !== "available") {
    return { ok: false, error: eligibilityMessage(state), code: state };
  }

  const now = Date.now();
  const data = await readLog(username);
  const existing = data.active.find((e) => e.quest_id === quest.id);
  if (existing) {
    return { ok: false, error: eligibilityMessage(existing.state === "ready" ? "ready" : "active"), code: existing.state };
  }

  // Repeatable re-accept: flip the completed row back to active.
  const completedIdx = data.completed.indexOf(quest.id);
  if (completedIdx !== -1) data.completed.splice(completedIdx, 1);

  // Zero-objective quests are immediately ready on accept.
  const readyImmediately = (quest.objectives || []).length === 0;
  const entry: QuestLogEntry = {
    quest_id: quest.id,
    state: readyImmediately ? "ready" : "active",
    accepted_at: now,
    completed_at: 0,
    times_completed: 0,
    progress: {},
  };
  try {
    const prior = (await query("SELECT times_completed FROM quest_log WHERE username = ? AND quest_id = ?", [uname, quest.id])) as any[];
    const timesCompleted = Number(prior?.[0]?.times_completed) || 0;
    entry.times_completed = timesCompleted;
    if (prior && prior.length > 0) {
      await query("UPDATE quest_log SET state = ?, accepted_at = ?, completed_at = 0 WHERE username = ? AND quest_id = ?", [
        entry.state,
        now,
        uname,
        quest.id,
      ]);
    } else {
      await query("INSERT INTO quest_log (username, quest_id, state, accepted_at, completed_at, times_completed) VALUES (?, ?, ?, ?, 0, ?)", [
        uname,
        quest.id,
        entry.state,
        now,
        timesCompleted,
      ]);
    }
    await query("DELETE FROM quest_objective_progress WHERE username = ? AND quest_id = ?", [uname, quest.id]);
  } catch (error) {
    log.error(`Quest accept failed for ${uname} quest ${quest.id}: ${error}`);
    return { ok: false, error: "Could not accept the quest.", code: "db_error" };
  }

  data.active = data.active.filter((e) => e.quest_id !== quest.id);
  data.active.push(entry);
  setCachedLog(username, data);

  // Track radius explore objectives for the periodic check.
  try {
    const { trackRadiusPlayer } = await import("./objectives");
    trackRadiusPlayer(username);
  } catch {
    // Objectives module unavailable in some test setups; ignore.
  }

  await backfillOnAccept(username, quest);
  // Re-read: backfill may have flipped the entry to ready.
  const updated = getCachedLog(username) || data;
  const finalEntry = updated.active.find((e) => e.quest_id === quest.id) || entry;

  listener.emit(Events.QUEST_ACCEPTED, { username: uname, questId: quest.id });
  return { ok: true, entry: finalEntry, quest };
}

export async function abandon(username: string, questId: number): Promise<void> {
  const uname = lower(username);
  const qid = Number(questId);
  try {
    await query("DELETE FROM quest_objective_progress WHERE username = ? AND quest_id = ?", [uname, qid]);
    // Only delete non-completed rows: abandoning must not erase history.
    await query("DELETE FROM quest_log WHERE username = ? AND quest_id = ? AND state != 'completed'", [uname, qid]);
  } catch (error) {
    log.error(`Quest abandon failed for ${uname} quest ${qid}: ${error}`);
  }
  const data = getCachedLog(username);
  if (data) {
    data.active = data.active.filter((e) => e.quest_id !== qid);
    setCachedLog(username, data);
  }
  try {
    const { trackRadiusPlayer } = await import("./objectives");
    trackRadiusPlayer(username);
  } catch {
    // Ignore.
  }
  listener.emit(Events.QUEST_ABANDONED, { username: uname, questId: qid });
}

export async function turnIn(
  username: string,
  questId: number,
  npcId: number,
  rewardChoiceIndex?: number
): Promise<TurnInResult> {
  const uname = lower(username);
  const quest = find(Number(questId));
  if (!quest) return { ok: false, error: "Unknown quest.", code: "unknown_quest" };
  if (!isEnder(Number(npcId), quest.id)) {
    return { ok: false, error: "That NPC does not complete this quest.", code: "not_ender" };
  }
  const data = await readLog(username);
  const entry = data.active.find((e) => e.quest_id === quest.id);
  if (!entry) return { ok: false, error: "That quest is not in your log.", code: "not_active" };
  if (entry.state !== "ready") return { ok: false, error: "That quest is not ready to turn in.", code: "not_ready" };

  const { validateChoice, grant } = await import("./rewards");
  if (!validateChoice(quest, rewardChoiceIndex)) {
    return { ok: false, error: "Choose a reward first.", code: "bad_choice" };
  }
  const granted = await grant(username, quest, rewardChoiceIndex);
  if (!granted.ok) {
    return { ok: false, error: granted.error || "Could not grant rewards.", code: granted.code || "rewards" };
  }

  const now = Date.now();
  const timesCompleted = (entry.times_completed || 0) + 1;
  try {
    await query(
      "UPDATE quest_log SET state = 'completed', completed_at = ?, times_completed = ? WHERE username = ? AND quest_id = ?",
      [now, timesCompleted, uname, quest.id]
    );
  } catch (error) {
    log.error(`Quest turn-in state save failed for ${uname} quest ${quest.id}: ${error}`);
    return { ok: false, error: "Could not complete the quest.", code: "db_error" };
  }

  data.active = data.active.filter((e) => e.quest_id !== quest.id);
  if (!data.completed.includes(quest.id)) data.completed.push(quest.id);
  setCachedLog(username, data);

  try {
    const { trackRadiusPlayer } = await import("./objectives");
    trackRadiusPlayer(username);
  } catch {
    // Ignore.
  }

  listener.emit(Events.QUEST_COMPLETED, { username: uname, questId: quest.id, rewards: granted });
  return {
    ok: true,
    questId: quest.id,
    xp: quest.xp_reward,
    copper: quest.copper_reward,
    items: granted.items,
    xpResult: granted.xpResult,
    nextQuestId: quest.next_quest_id,
  };
}

/** What this NPC can show this player: offers, incompletes and turn-ins. */
export async function offersFor(username: string, npcId: number): Promise<QuestOffer[]> {
  const nid = Number(npcId);
  const given = questsGivenBy(nid);
  const ended = questsEndedBy(nid);
  const ids = [...new Set([...given, ...ended])];
  const offers: QuestOffer[] = [];
  for (const qid of ids) {
    const quest = find(qid);
    if (!quest) continue;
    const state = await eligibility(username, qid);
    const isGiverRole = given.includes(qid);
    const isEnderRole = ended.includes(qid);
    const questLevel = quest.quest_level || quest.required_level;
    if (state === "available" || state === "level_too_low" || state === "missing_prerequisite" || state === "log_full" || state === "daily_not_reset") {
      if (!isGiverRole) continue;
      offers.push({
        questId: quest.id,
        name: quest.name,
        questLevel,
        requiredLevel: quest.required_level,
        marker: state === "available" ? "available" : "available_future",
        action: "offer",
        reason: state,
      });
    } else if (state === "active") {
      if (!isEnderRole) continue;
      offers.push({ questId: quest.id, name: quest.name, questLevel, requiredLevel: quest.required_level, marker: "in_progress", action: "incomplete", reason: state });
    } else if (state === "ready") {
      if (!isEnderRole) continue;
      offers.push({ questId: quest.id, name: quest.name, questLevel, requiredLevel: quest.required_level, marker: "ready", action: "turnin", reason: state });
    }
    // completed / unknown_quest: nothing to show.
  }
  return offers;
}

export function eligibilityMessage(state: QuestEligibility): string {
  switch (state) {
    case "active":
      return "That quest is already in your log.";
    case "ready":
      return "That quest is ready to turn in.";
    case "completed":
      return "You have already completed that quest.";
    case "level_too_low":
      return "You are not high enough level for that quest.";
    case "missing_prerequisite":
      return "You must complete the previous quest first.";
    case "log_full":
      return "Your quest log is full.";
    case "daily_not_reset":
      return "That daily quest is not available yet.";
    default:
      return "You cannot accept that quest.";
  }
}

const questLog = {
  load,
  eligibility,
  accept,
  abandon,
  turnIn,
  offersFor,
  lastResetBoundary,
  getCachedLog,
  setCachedLog,
  MAX_ACTIVE_QUESTS,
  DAILY_RESET_UTC_HOUR,
};

export default questLog;
