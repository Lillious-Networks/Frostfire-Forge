import query from "../../controllers/sqldatabase";
import playerCache from "../../services/playermanager";
import { rowCache } from "../../services/datacache";
import { atomically, type Batch } from "../../services/batch";
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

/** A row of quest_log, without the username. */
export interface QuestLogRow {
  quest_id: number;
  state: string;
  accepted_at: number;
  completed_at: number;
  times_completed: number;
}

/** A row of quest_objective_progress, without the username. */
export interface QuestProgressRow {
  quest_id: number;
  objective_id: number;
  count: number;
}

/** A player's rows of the two tables. */
export interface QuestRows {
  log: QuestLogRow[];
  progress: QuestProgressRow[];
}

// Each player's rows of the two tables, as the tables have them. These are
// what is asked instead of the database; every write below and in the
// objectives goes to the database and then to them. The log an online player
// carries (getCachedLog) is the working copy the same functions keep.
const logRows = rowCache<QuestLogRow[]>("quest_log", async (username) =>
  ((await query(
    "SELECT quest_id, state, accepted_at, completed_at, times_completed FROM quest_log WHERE username = ?",
    [username]
  )) as QuestLogRow[]) || []
, { perPlayer: true });

const progressRows = rowCache<QuestProgressRow[]>("quest_progress", async (username) =>
  ((await query(
    "SELECT quest_id, objective_id, count FROM quest_objective_progress WHERE username = ?",
    [username]
  )) as QuestProgressRow[]) || []
, { perPlayer: true });

/** Picks the rows of one quest. */
export const ofQuest = (questId: number) => (row: { quest_id: number }): boolean => Number(row.quest_id) === Number(questId);

/** A player's rows of the two tables, as held. */
export async function rowsOf(username: string): Promise<QuestRows> {
  const uname = lower(username);
  return { log: (await logRows.get(uname)) ?? [], progress: (await progressRows.get(uname)) ?? [] };
}

// One write to a player's rows at a time. Each works from the rows held and
// puts back what its statements left, so two side by side would each put back
// rows without the other's change; and statements sent side by side reach the
// database in no set order.
const writing = new Map<string, Promise<unknown>>();
// A write to every player's rows at once (a quest deleted in the editor): after
// the writes under way, and before any that follow.
let writingAll: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(username: string, write: () => Promise<T>): Promise<T> {
  const key = lower(username);
  const mine = Promise.allSettled([writing.get(key), writingAll]).then(() => write());
  writing.set(key, mine);
  const done = () => { if (writing.get(key) === mine) writing.delete(key); };
  mine.then(done, done);
  return mine;
}

function forEveryone<T>(write: () => Promise<T>): Promise<T> {
  const mine = Promise.allSettled([...writing.values(), writingAll]).then(() => write());
  writingAll = mine.catch(() => {});
  return mine;
}

/**
 * A write to one player's quest rows. `write` is handed the rows held, sends
 * its statements and, after each, replaces the list it changed with what the
 * statement left; the lists it replaced are then the rows held. If a
 * statement fails, the ones before it were written and it may have been too
 * (one that timed out, say): the rows are forgotten, so the next read asks
 * the database, the log an online player carries is put back in step with
 * what it answers (resyncLog), and the failure is the caller's to handle. A
 * caller changes the log the player carries only once this has resolved.
 */
export function writeQuestRows<T>(username: string, write: (rows: QuestRows) => Promise<T>): Promise<T> {
  const uname = lower(username);
  return oneAtATime(uname, async () => {
    const held = await rowsOf(uname);
    const rows = { ...held };
    try {
      const result = await write(rows);
      if (rows.log !== held.log) await logRows.set(uname, rows.log);
      if (rows.progress !== held.progress) await progressRows.set(uname, rows.progress);
      return result;
    } catch (error) {
      await Promise.all([logRows.drop(uname), progressRows.drop(uname)]);
      await resyncLog(uname);
      throw error;
    }
  });
}

/**
 * writeQuestRows, as part of a batch (see services/batch). `write` is handed
 * the rows the batch has so far, adds its statements to the batch and replaces
 * the lists it changed; they become the rows held once the batch is kept. If
 * it is not, the rows are forgotten and the log an online player carries is
 * put back in step, as there. A caller changes the log the player carries in
 * a step of its own, for once the batch is kept.
 */
export async function writeQuestRowsIn(batch: Batch, username: string, write: (rows: QuestRows) => void): Promise<void> {
  const uname = lower(username);
  await batch.hold(oneAtATime, uname);
  const rows = await batch.pending(logRows, uname, async () => {
    const held = await rowsOf(uname);
    const pending = { ...held };
    batch.kept(async () => {
      if (pending.log !== held.log) await logRows.set(uname, pending.log);
      if (pending.progress !== held.progress) await progressRows.set(uname, pending.progress);
    });
    batch.undone(async () => {
      await Promise.all([logRows.drop(uname), progressRows.drop(uname)]);
      await resyncLog(uname);
    });
    return pending;
  });
  write(rows);
}

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
    // An offline player's level is the player system's to say, from the stats it holds.
    const { default: playerSystem } = await import("../player");
    const stats = (await playerSystem.getStats(lower(username))) as any;
    const lvl = Number(stats?.level);
    if (Number.isFinite(lvl) && lvl > 0) return lvl;
  } catch {
    // Fall through to default.
  }
  return 1;
}

/** The log a player carries, as their rows make it. */
function logFrom({ log: rows, progress }: QuestRows): QuestLogData {
  const progressByQuest = new Map<number, Record<number, number>>();
  for (const r of progress) {
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

  return { active, completed };
}

/** Build the log from the player's rows into the player cache. */
export async function load(username: string): Promise<QuestLogData> {
  const data = logFrom(await rowsOf(username));
  setCachedLog(username, data);
  // Ensure the shape exists even when the player is offline (tests).
  if (!findCachedPlayer(username)) {
    // No cache entry; callers still get the data.
  }
  return data;
}

/**
 * After a quest write that failed: the log an online player carries is put
 * back in step with the tables. The write left their rows forgotten, so they
 * are read; when they cannot be, the log stays as it was before the write.
 * An entry that is still in the log is changed in place, so whoever is in
 * the middle of working on it has what is there now.
 */
async function resyncLog(username: string): Promise<void> {
  const data = getCachedLog(username);
  if (!data) return;
  let fresh: QuestLogData;
  try {
    fresh = logFrom(await rowsOf(username));
  } catch {
    return;
  }
  const carried = new Map(data.active.map((entry) => [entry.quest_id, entry]));
  data.active = fresh.active.map((entry) => {
    const mine = carried.get(entry.quest_id);
    return mine ? Object.assign(mine, entry) : entry;
  });
  data.completed = fresh.completed;
  setCachedLog(username, data);
  await refreshRadiusTracking(username);
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
      // Need completed_at from the quest's row (completed rows are not in the active list).
      try {
        const row = (await logRows.get(lower(username)))?.find(ofQuest(quest.id));
        const completedAt = Number(row?.completed_at) || 0;
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
        // What the player holds of the item is the inventory's to say, from the rows it holds.
        const { default: inventory } = await import("../inventory");
        const rows = await inventory.find(uname, { name: o.target, quantity: 0 });
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
  const quest = find(Number(questId));
  if (!quest) return { ok: false, error: "Unknown quest.", code: "unknown_quest" };
  if (!isGiver(Number(npcId), quest.id)) {
    return { ok: false, error: "That NPC does not offer this quest.", code: "not_giver" };
  }
  const state = await eligibility(username, quest.id);
  if (state !== "available") {
    return { ok: false, error: eligibilityMessage(state), code: state };
  }
  return begin(username, quest);
}

/** Puts a quest in the log as active. Callers decide whether the player may take it. */
async function begin(username: string, quest: Quest): Promise<AcceptResult> {
  const uname = lower(username);
  const now = Date.now();
  const data = await readLog(username);
  const existing = data.active.find((e) => e.quest_id === quest.id);
  if (existing) {
    return { ok: false, error: eligibilityMessage(existing.state === "ready" ? "ready" : "active"), code: existing.state };
  }

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
    await writeQuestRows(username, async (rows) => {
      // The counts of an earlier run go first: if the rest fails, the quest
      // is not left active with them still in place.
      await query("DELETE FROM quest_objective_progress WHERE username = ? AND quest_id = ?", [uname, quest.id]);
      rows.progress = rows.progress.filter((row) => !ofQuest(quest.id)(row));
      const prior = rows.log.find(ofQuest(quest.id));
      const timesCompleted = Number(prior?.times_completed) || 0;
      entry.times_completed = timesCompleted;
      if (prior) {
        await query("UPDATE quest_log SET state = ?, accepted_at = ?, completed_at = 0 WHERE username = ? AND quest_id = ?", [
          entry.state,
          now,
          uname,
          quest.id,
        ]);
        rows.log = rows.log.map((row) => (ofQuest(quest.id)(row) ? { ...row, state: entry.state, accepted_at: now, completed_at: 0 } : row));
      } else {
        await query("INSERT INTO quest_log (username, quest_id, state, accepted_at, completed_at, times_completed) VALUES (?, ?, ?, ?, 0, ?)", [
          uname,
          quest.id,
          entry.state,
          now,
          timesCompleted,
        ]);
        rows.log = [...rows.log, { quest_id: quest.id, state: entry.state, accepted_at: now, completed_at: 0, times_completed: timesCompleted }];
      }
    });
  } catch (error) {
    log.error(`Quest accept failed for ${uname} quest ${quest.id}: ${error}`);
    return { ok: false, error: "Could not accept the quest.", code: "db_error" };
  }

  // Repeatable re-accept: the completed row is active again. Only once that
  // is written: a write that failed leaves the quest completed.
  const completedIdx = data.completed.indexOf(quest.id);
  if (completedIdx !== -1) data.completed.splice(completedIdx, 1);

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
    await writeQuestRows(username, async (rows) => {
      await query("DELETE FROM quest_objective_progress WHERE username = ? AND quest_id = ?", [uname, qid]);
      rows.progress = rows.progress.filter((row) => !ofQuest(qid)(row));
      // Only delete non-completed rows: abandoning must not erase history.
      await query("DELETE FROM quest_log WHERE username = ? AND quest_id = ? AND state != 'completed'", [uname, qid]);
      rows.log = rows.log.filter((row) => !ofQuest(qid)(row) || row.state === "completed");
    });
  } catch (error) {
    log.error(`Quest abandon failed for ${uname} quest ${qid}: ${error}`);
    // Not written, as far as is known: the log the player carries says what the tables hold, not that the quest is gone.
    return;
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

/**
 * Admin tools: start a quest for a player whatever its giver, level,
 * prerequisites or daily reset say. A full log still refuses it.
 */
export async function forceAccept(username: string, questId: number): Promise<AcceptResult> {
  const quest = find(Number(questId));
  if (!quest) return { ok: false, error: "Unknown quest.", code: "unknown_quest" };
  const data = await readLog(username);
  if (!data.active.some((e) => e.quest_id === quest.id) && data.active.length >= MAX_ACTIVE_QUESTS) {
    return { ok: false, error: eligibilityMessage("log_full"), code: "log_full" };
  }
  return begin(username, quest);
}

/** Admin tools: mark a quest completed without a turn-in, so no rewards are granted. */
export async function forceComplete(username: string, questId: number): Promise<{ ok: boolean; error?: string; code?: string }> {
  const uname = lower(username);
  const quest = find(Number(questId));
  if (!quest) return { ok: false, error: "Unknown quest.", code: "unknown_quest" };
  const data = await readLog(username);
  const entry = data.active.find((e) => e.quest_id === quest.id);
  if (!entry && data.completed.includes(quest.id)) {
    return { ok: false, error: eligibilityMessage("completed"), code: "completed" };
  }

  const now = Date.now();
  try {
    await writeQuestRows(username, async (rows) => {
      const prior = rows.log.find(ofQuest(quest.id));
      const timesCompleted = (Number(prior?.times_completed) || 0) + 1;
      if (prior) {
        await query(
          "UPDATE quest_log SET state = 'completed', completed_at = ?, times_completed = ? WHERE username = ? AND quest_id = ?",
          [now, timesCompleted, uname, quest.id]
        );
        rows.log = rows.log.map((row) => (ofQuest(quest.id)(row) ? { ...row, state: "completed", completed_at: now, times_completed: timesCompleted } : row));
      } else {
        await query(
          "INSERT INTO quest_log (username, quest_id, state, accepted_at, completed_at, times_completed) VALUES (?, ?, 'completed', ?, ?, ?)",
          [uname, quest.id, now, now, timesCompleted]
        );
        rows.log = [...rows.log, { quest_id: quest.id, state: "completed", accepted_at: now, completed_at: now, times_completed: timesCompleted }];
      }
      await query("DELETE FROM quest_objective_progress WHERE username = ? AND quest_id = ?", [uname, quest.id]);
      rows.progress = rows.progress.filter((row) => !ofQuest(quest.id)(row));
    });
  } catch (error) {
    log.error(`Quest force-complete failed for ${uname} quest ${quest.id}: ${error}`);
    return { ok: false, error: "Could not complete the quest.", code: "db_error" };
  }

  data.active = data.active.filter((e) => e.quest_id !== quest.id);
  if (!data.completed.includes(quest.id)) data.completed.push(quest.id);
  setCachedLog(username, data);
  await refreshRadiusTracking(username);
  return { ok: true };
}

/** Admin tools: erase a quest from the log, its completion history included, as if never taken. */
export async function forget(username: string, questId: number): Promise<void> {
  const uname = lower(username);
  const qid = Number(questId);
  try {
    await writeQuestRows(username, async (rows) => {
      await query("DELETE FROM quest_objective_progress WHERE username = ? AND quest_id = ?", [uname, qid]);
      rows.progress = rows.progress.filter((row) => !ofQuest(qid)(row));
      await query("DELETE FROM quest_log WHERE username = ? AND quest_id = ?", [uname, qid]);
      rows.log = rows.log.filter((row) => !ofQuest(qid)(row));
    });
  } catch (error) {
    log.error(`Quest forget failed for ${uname} quest ${qid}: ${error}`);
    // Not written, as far as is known: the log the player carries says what the tables hold, not that the quest is gone.
    return;
  }
  const data = getCachedLog(username);
  if (data) {
    data.active = data.active.filter((e) => e.quest_id !== qid);
    data.completed = data.completed.filter((id) => id !== qid);
    setCachedLog(username, data);
  }
  await refreshRadiusTracking(username);
}

async function refreshRadiusTracking(username: string): Promise<void> {
  try {
    const { trackRadiusPlayer } = await import("./objectives");
    trackRadiusPlayer(username);
  } catch {
    // Ignore.
  }
}

/**
 * Quest editor: a deleted quest leaves every player's log and progress. The
 * statements do not say whose rows they took, so no write to one player's
 * rows runs beside them. The rows held of everyone online lose the quest as
 * the tables did, and so does the log each of them carries; the rest are
 * forgotten, to be read when next asked for. If a statement fails, all are
 * forgotten and each online player's log is put back in step with the tables.
 */
export async function removeFromEveryLog(questId: number): Promise<void> {
  const qid = Number(questId);
  await forEveryone(async () => {
    const online = [...new Set(Object.values((playerCache.list() as Record<string, any>) || {}).map((p) => lower(p?.username)).filter(Boolean))];
    const held = await Promise.all(online.map(async (uname) => ({ uname, rows: await rowsOf(uname) })));
    try {
      await query("DELETE FROM quest_objective_progress WHERE quest_id = ?", [qid]);
      await query("DELETE FROM quest_log WHERE quest_id = ?", [qid]);
    } catch (error) {
      await Promise.all([logRows.clear(), progressRows.clear()]);
      for (const uname of online) await resyncLog(uname);
      throw error;
    }
    await Promise.all([logRows.clear(), progressRows.clear()]);
    for (const { uname, rows } of held) {
      await logRows.set(uname, rows.log.filter((row) => !ofQuest(qid)(row)));
      await progressRows.set(uname, rows.progress.filter((row) => !ofQuest(qid)(row)));
    }

    for (const player of Object.values((playerCache.list() as Record<string, any>) || {})) {
      const data = player?.questlog as QuestLogData | undefined;
      if (!data || !Array.isArray(data.active)) continue;
      const completed = Array.isArray(data.completed) ? data.completed : [];
      if (!data.active.some((e) => e.quest_id === qid) && !completed.includes(qid)) continue;
      data.active = data.active.filter((e) => e.quest_id !== qid);
      data.completed = completed.filter((id) => id !== qid);
      setCachedLog(player.username, data);
      await refreshRadiusTracking(player.username);
    }
  });
}

/** Thrown inside a hand-in's batch to leave it unsent: what the player is told instead. */
class Refused extends Error {
  constructor(readonly result: TurnInResult) {
    super(result.error);
  }
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
  const { validateChoice, grant } = await import("./rewards");

  // One batch: what the quest pays and the quest's state are kept together or not at all, so a
  // quest that could not be completed pays nothing. And one hand-in at a time for a player: the
  // log is read inside, where a second hand-in of the same quest finds it handed in.
  let granted: Awaited<ReturnType<typeof grant>>;
  try {
    granted = await atomically([uname], async (batch) => {
      const data = await readLog(username);
      const entry = data.active.find((e) => e.quest_id === quest.id);
      if (!entry) throw new Refused({ ok: false, error: "That quest is not in your log.", code: "not_active" });
      if (entry.state !== "ready") throw new Refused({ ok: false, error: "That quest is not ready to turn in.", code: "not_ready" });
      if (!validateChoice(quest, rewardChoiceIndex)) {
        throw new Refused({ ok: false, error: "Choose a reward first.", code: "bad_choice" });
      }

      const rewards = await grant(username, quest, rewardChoiceIndex, batch);
      if (!rewards.ok) {
        throw new Refused({ ok: false, error: rewards.error || "Could not grant rewards.", code: rewards.code || "rewards" });
      }

      const now = Date.now();
      const timesCompleted = (entry.times_completed || 0) + 1;
      await writeQuestRowsIn(batch, username, (rows) => {
        // It must change the row: a quest that is no longer in the log pays nothing.
        batch.add({
          sql: "UPDATE quest_log SET state = 'completed', completed_at = ?, times_completed = ? WHERE username = ? AND quest_id = ?",
          values: [now, timesCompleted, uname, quest.id],
          mustChange: true,
        });
        rows.log = rows.log.map((row) => (ofQuest(quest.id)(row) ? { ...row, state: "completed", completed_at: now, times_completed: timesCompleted } : row));
      });
      batch.kept(() => {
        data.active = data.active.filter((e) => e.quest_id !== quest.id);
        if (!data.completed.includes(quest.id)) data.completed.push(quest.id);
        setCachedLog(username, data);
      });
      return rewards;
    });
  } catch (error) {
    if (error instanceof Refused) return error.result;
    log.error(`Quest turn-in save failed for ${uname} quest ${quest.id}: ${error}`);
    return { ok: false, error: "Could not complete the quest.", code: "db_error" };
  }

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
  forceAccept,
  forceComplete,
  forget,
  turnIn,
  offersFor,
  lastResetBoundary,
  getCachedLog,
  setCachedLog,
  MAX_ACTIVE_QUESTS,
  DAILY_RESET_UTC_HOUR,
};

export default questLog;
