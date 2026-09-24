/**
 * Quest editor: validation and CRUD for the admin quest editor window.
 * Mirrors systems/itemeditor.ts in shape and permission style.
 */
import query from "../../controllers/sqldatabase";
import log from "../../modules/logger";
import assetCache from "../../services/assetCache";
import { find, getCachedQuestsSync, npcLinksForQuest, reload } from "./definitions";

export const EDITOR_PERMISSION = "tools.quest_editor";
export const EDITOR_WILDCARD = "tools.*";

/** Admins and holders of tools.quest_editor / tools.* may use the editor. */
export function canUseEditor(player: any): boolean {
  if (!player) return false;
  if (player.isAdmin) return true;
  const permissions: string[] = Array.isArray(player.permissions) ? player.permissions : [];
  return permissions.some((p) => p === EDITOR_PERMISSION || p === EDITOR_WILDCARD || p === "server.*");
}

/** Results per search. Editors search rather than browse, so this stays small. */
export const SEARCH_LIMIT = 50;

export const OBJECTIVE_TYPES: QuestObjectiveType[] = ["kill", "collect", "talk", "explore"];
export const REPEATABLE_VALUES: QuestRepeatable[] = ["none", "repeatable", "daily"];

export interface QuestEditorData {
  objectiveTypes: string[];
  repeatableValues: string[];
  creatures: Array<{ id: number; name: string }>;
  items: Array<{ name: string; icon: string | null; quality: string }>;
  npcs: Array<{ id: number; name: string; map: string; quest_giver: boolean }>;
  maps: string[];
  questCount: number;
  quests: Array<{ id: number; name: string }>;
}

export interface QuestSearchResult {
  query: string;
  /** Quests carry their NPC links so the editor round-trips them. */
  quests: Array<Quest & { givers: number[]; enders: number[] }>;
  truncated: number;
}

export interface QuestSavePayload {
  id?: number | null;
  /** Client-generated draft key. Concurrent creates sharing it are one save. */
  clientKey?: string | null;
  name: string;
  zone?: string | null;
  offer_text?: string;
  description?: string;
  progress_text?: string;
  completion_text?: string;
  required_level?: number;
  quest_level?: number;
  xp_reward?: number;
  copper_reward?: number;
  repeatable?: QuestRepeatable;
  next_quest_id?: number | null;
  sort_order?: number;
  objectives?: Array<{
    type: QuestObjectiveType;
    target: string;
    required_count?: number;
    target_x?: number | null;
    target_y?: number | null;
    target_radius?: number | null;
    description?: string | null;
    sort_order?: number;
  }>;
  rewards?: Array<{
    item_name: string;
    quantity?: number;
    is_choice?: boolean;
    sort_order?: number;
  }>;
  prerequisites?: number[];
  givers?: number[];
  enders?: number[];
}

export interface SaveResult {
  ok: boolean;
  errors: string[];
  id?: number;
}

/** The editor opens with metadata and counts, not the quests themselves. */
export async function buildEditorData(): Promise<QuestEditorData> {
  const quests = getCachedQuestsSync();
  let creatures: Array<{ id: number; name: string }> = [];
  try {
    const templates = ((await assetCache.get("creatureTemplates")) || []) as any[];
    creatures = (templates || []).map((t) => ({ id: Number(t.id), name: String(t.name ?? `#${t.id}`) }));
  } catch {
    creatures = [];
  }
  let items: Array<{ name: string; icon: string | null; quality: string }> = [];
  try {
    const all = ((await assetCache.get("items")) || []) as Item[];
    items = (all || [])
      // Quality drives the coloured frame around the item's icon in the editor.
      .map((i) => ({ name: String(i.name), icon: (i.icon ?? null) as string | null, quality: String(i.quality || "common") }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    items = [];
  }
  let npcs: Array<{ id: number; name: string; map: string; quest_giver: boolean }> = [];
  try {
    const all = ((await assetCache.get("npcs")) || []) as Npc[];
    npcs = (all || [])
      .filter((n) => n.id !== null && n.id !== undefined)
      .map((n) => ({
        id: Number(n.id),
        name: String(n.name ?? `#${n.id}`),
        map: String(n.map ?? ""),
        quest_giver: (n as any).quest_giver === true || (n as any).quest_giver === 1,
      }));
  } catch {
    npcs = [];
  }
  let maps: string[] = [];
  try {
    const props = ((await assetCache.get("mapProperties")) || []) as any[];
    maps = (props || []).map((m: any) => String(m.name ?? "").replaceAll(".json", "")).filter(Boolean);
    if (maps.length === 0) {
      const allMaps = ((await assetCache.get("maps")) || []) as any[];
      maps = (allMaps || []).map((m: any) => String(m.name ?? "").replaceAll(".json", "")).filter(Boolean);
    }
  } catch {
    maps = [];
  }
  return {
    objectiveTypes: OBJECTIVE_TYPES,
    repeatableValues: REPEATABLE_VALUES,
    creatures,
    items,
    npcs,
    maps,
    questCount: quests.length,
    quests: quests.map((q) => ({ id: q.id, name: q.name })).sort((a, b) => a.id - b.id),
  };
}

export async function search(rawQuery: unknown): Promise<QuestSearchResult> {
  const q = String(rawQuery ?? "").trim().toLowerCase();
  const all = getCachedQuestsSync();
  // An empty query browses everything (by id); typing narrows it down.
  const matches = !q
    ? [...all].sort((a, b) => a.id - b.id)
    : all
        .filter((quest) => quest.name.toLowerCase().includes(q))
        .sort((a, b) => {
          const aStarts = a.name.toLowerCase().startsWith(q);
          const bStarts = b.name.toLowerCase().startsWith(q);
          if (aStarts !== bStarts) return aStarts ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
  return {
    query: q,
    quests: matches
      .slice(0, SEARCH_LIMIT)
      .map((quest) => ({ ...quest, ...npcLinksForQuest(quest.id) })),
    truncated: Math.max(0, matches.length - SEARCH_LIMIT),
  };
}

interface ValidationContext {
  creatureIds: Set<number>;
  itemNames: Set<string>;
  npcIds: Set<number>;
  /** NPCs flagged as quest givers; only these accept quest links. */
  questGiverIds: Set<number>;
  maps: Set<string>;
  questIds: Set<number>;
}

async function buildValidationContext(selfId: number | null): Promise<ValidationContext> {
  const creatureIds = new Set<number>();
  try {
    const templates = ((await assetCache.get("creatureTemplates")) || []) as any[];
    for (const t of templates || []) creatureIds.add(Number(t.id));
  } catch {
    // Leave empty; every kill target then fails with a clear message.
  }
  const itemNames = new Set<string>();
  try {
    const items = ((await assetCache.get("items")) || []) as Item[];
    for (const i of items || []) itemNames.add(String(i.name).toLowerCase());
  } catch {
    // Leave empty.
  }
  const npcIds = new Set<number>();
  const questGiverIds = new Set<number>();
  try {
    const npcs = ((await assetCache.get("npcs")) || []) as Npc[];
    for (const n of npcs || []) {
      if (n.id !== null && n.id !== undefined) {
        npcIds.add(Number(n.id));
        if ((n as any).quest_giver === true || (n as any).quest_giver === 1) {
          questGiverIds.add(Number(n.id));
        }
      }
    }
  } catch {
    // Leave empty.
  }
  const maps = new Set<string>();
  try {
    const props = ((await assetCache.get("mapProperties")) || []) as any[];
    for (const m of props || []) maps.add(String(m.name ?? "").replaceAll(".json", "").toLowerCase());
    if (maps.size === 0) {
      const allMaps = ((await assetCache.get("maps")) || []) as any[];
      for (const m of allMaps || []) maps.add(String(m.name ?? "").replaceAll(".json", "").toLowerCase());
    }
  } catch {
    // Leave empty.
  }
  const questIds = new Set<number>();
  for (const q of getCachedQuestsSync()) {
    if (selfId === null || q.id !== selfId) questIds.add(q.id);
  }
  return { creatureIds, itemNames, npcIds, questGiverIds, maps, questIds };
}

function reachablePrereq(startId: number, targetId: number, edges: Map<number, number[]>): boolean {
  // Is targetId reachable from startId following prerequisite edges?
  const seen = new Set<number>();
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of edges.get(current) || []) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return false;
}

export async function validateQuest(payload: QuestSavePayload): Promise<string[]> {
  const errors: string[] = [];
  const selfId = payload.id === null || payload.id === undefined ? null : Number(payload.id);
  const ctx = await buildValidationContext(selfId);

  const name = String(payload.name ?? "").trim();
  if (!name) errors.push("Name is required.");
  if (name.length > 255) errors.push("Name must be 255 characters or fewer.");

  const requiredLevel = Number(payload.required_level ?? 1);
  if (!Number.isFinite(requiredLevel) || requiredLevel < 1) errors.push("Required level must be at least 1.");

  if (payload.repeatable !== undefined && !(REPEATABLE_VALUES as string[]).includes(String(payload.repeatable))) {
    errors.push("Repeatable must be one of: none, repeatable, daily.");
  }

  if (payload.next_quest_id !== null && payload.next_quest_id !== undefined) {
    const nextId = Number(payload.next_quest_id);
    if (!Number.isFinite(nextId)) {
      errors.push("Next quest must be a valid quest id.");
    } else {
      if (selfId !== null && nextId === selfId) {
        errors.push("A quest cannot chain into itself.");
      } else if (!ctx.questIds.has(nextId)) {
        errors.push("Next quest does not exist.");
      }
    }
  }

  const objectives = payload.objectives || [];
  if (!Array.isArray(objectives)) {
    errors.push("Objectives must be a list.");
  } else {
    objectives.forEach((o, i) => {
      const label = `Objective ${i + 1}`;
      if (!(OBJECTIVE_TYPES as string[]).includes(String(o.type))) {
        errors.push(`${label}: type must be one of: kill, collect, talk, explore.`);
        return;
      }
      const target = String(o.target ?? "").trim();
      if (!target) {
        errors.push(`${label}: target is required.`);
        return;
      }
      const requiredCount = Number(o.required_count ?? 1);
      if (!Number.isFinite(requiredCount) || requiredCount < 1 || !Number.isInteger(requiredCount)) {
        errors.push(`${label}: required count must be an integer of at least 1.`);
      }
      if (o.type === "kill") {
        if (!ctx.creatureIds.has(Number(target))) errors.push(`${label}: kill target does not match a creature template id.`);
      } else if (o.type === "collect") {
        if (!ctx.itemNames.has(target.toLowerCase())) errors.push(`${label}: collect target does not match an item name.`);
      } else if (o.type === "talk") {
        if (!ctx.npcIds.has(Number(target))) errors.push(`${label}: talk target does not match an NPC id.`);
      } else if (o.type === "explore") {
        if (!ctx.maps.has(target.replaceAll(".json", "").toLowerCase())) errors.push(`${label}: explore target does not match a map name.`);
        const hasRadius = o.target_radius !== null && o.target_radius !== undefined;
        const hasX = o.target_x !== null && o.target_x !== undefined;
        const hasY = o.target_y !== null && o.target_y !== undefined;
        if (hasRadius && (!hasX || !hasY)) {
          errors.push(`${label}: a radius requires both target_x and target_y.`);
        }
        if (hasRadius && (Number(o.target_radius) < 1 || !Number.isFinite(Number(o.target_radius)))) {
          errors.push(`${label}: radius must be at least 1.`);
        }
      }
    });
  }

  const rewards = payload.rewards || [];
  if (!Array.isArray(rewards)) {
    errors.push("Rewards must be a list.");
  } else {
    rewards.forEach((r, i) => {
      const label = `Reward ${i + 1}`;
      const itemName = String(r.item_name ?? "").trim();
      if (!itemName) {
        errors.push(`${label}: item name is required.`);
        return;
      }
      if (!ctx.itemNames.has(itemName.toLowerCase())) errors.push(`${label}: item "${itemName}" does not exist.`);
      const qty = Number(r.quantity ?? 1);
      if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
        errors.push(`${label}: quantity must be an integer of at least 1.`);
      }
    });
  }

  const prereqs = payload.prerequisites || [];
  if (!Array.isArray(prereqs)) {
    errors.push("Prerequisites must be a list of quest ids.");
  } else {
    const edges = new Map<number, number[]>();
    for (const q of getCachedQuestsSync()) {
      edges.set(q.id, (q.prerequisites || []).map(Number));
    }
    const selfKey = selfId ?? -1;
    edges.set(selfKey, prereqs.map(Number));
    for (const pre of prereqs) {
      const preId = Number(pre);
      if (selfId !== null && preId === selfId) {
        errors.push("A quest cannot require itself.");
        continue;
      }
      if (!ctx.questIds.has(preId)) {
        errors.push(`Prerequisite quest ${pre} does not exist.`);
        continue;
      }
      // Cycle: quest_id reachable from itself through the new edges.
      if (selfId !== null && reachablePrereq(preId, selfId, edges)) {
        errors.push(`Prerequisite ${pre} would create a cycle.`);
      }
    }
  }

  for (const role of ["givers", "enders"] as const) {
    const list = (payload as any)[role];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`${role === "givers" ? "Quests given" : "Quests ended"} must be a list of NPC ids.`);
      continue;
    }
    for (const npcId of list) {
      if (!ctx.npcIds.has(Number(npcId))) {
        errors.push(`NPC ${npcId} in ${role} does not exist.`);
      } else if (!ctx.questGiverIds.has(Number(npcId))) {
        errors.push(`NPC ${npcId} in ${role} is not marked as a quest giver.`);
      }
    }
  }

  return errors;
}

// Saves replace child rows (delete + insert), so two saves for the same quest
// must never interleave - a double-clicked Save (or two admins) would
// otherwise duplicate every objective, reward and prerequisite. A per-quest
// promise chain serializes them.
const saveQueues = new Map<string, Promise<void>>();

// In-flight creates by client key. A double-submitted new quest (same draft,
// no id yet) shares the first execution's result instead of inserting twice.
const inFlightCreates = new Map<string, Promise<SaveResult>>();

export async function save(payload: QuestSavePayload): Promise<SaveResult> {
  const selfId = payload.id === null || payload.id === undefined ? null : Number(payload.id);
  if (selfId === null) {
    const clientKey = typeof payload.clientKey === "string" && payload.clientKey ? payload.clientKey : null;
    if (clientKey) {
      const existing = inFlightCreates.get(clientKey);
      if (existing) return existing;
      const pending = saveInner(payload);
      inFlightCreates.set(clientKey, pending);
      try {
        return await pending;
      } finally {
        if (inFlightCreates.get(clientKey) === pending) inFlightCreates.delete(clientKey);
      }
    }
  }
  const key = selfId === null ? "__new__" : `id:${selfId}`;
  const prev = saveQueues.get(key) || Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  saveQueues.set(key, prev.then(() => current));
  await prev;
  try {
    return await saveInner(payload);
  } finally {
    release();
    if (saveQueues.get(key) === current) saveQueues.delete(key);
  }
}

/**
 * Drop giver/ender links to NPCs that no longer exist (deleted since the quest
 * was assigned), so saving the quest cleans them up instead of failing. Skipped
 * when the NPC list can't be read: an unreadable cache must not wipe links.
 */
async function pruneDeletedNpcLinks(payload: QuestSavePayload): Promise<void> {
  let npcIds: Set<number>;
  try {
    const npcs = (await assetCache.get("npcs")) as Npc[] | null;
    if (!Array.isArray(npcs)) return;
    npcIds = new Set(npcs.filter((n) => n.id !== null && n.id !== undefined).map((n) => Number(n.id)));
  } catch {
    return;
  }
  for (const role of ["givers", "enders"] as const) {
    const list = payload[role];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((npcId) => npcIds.has(Number(npcId)));
    if (kept.length !== list.length) {
      log.info(`Quest ${payload.id ?? "(new)"}: removed ${list.length - kept.length} deleted NPC(s) from ${role}`);
      payload[role] = kept;
    }
  }
}

async function saveInner(payload: QuestSavePayload): Promise<SaveResult> {
  await pruneDeletedNpcLinks(payload);
  const errors = await validateQuest(payload);
  if (errors.length > 0) return { ok: false, errors };

  const selfId = payload.id === null || payload.id === undefined ? null : Number(payload.id);
  const repeatable = (payload.repeatable || "none") as QuestRepeatable;
  const row = {
    name: String(payload.name).trim(),
    zone: payload.zone ? String(payload.zone) : null,
    offer_text: String(payload.offer_text ?? ""),
    description: String(payload.description ?? ""),
    progress_text: String(payload.progress_text ?? ""),
    completion_text: String(payload.completion_text ?? ""),
    required_level: Math.max(1, Math.trunc(Number(payload.required_level ?? 1)) || 1),
    quest_level: Math.max(0, Math.trunc(Number(payload.quest_level ?? 0)) || 0),
    xp_reward: Math.max(0, Math.trunc(Number(payload.xp_reward ?? 0)) || 0),
    copper_reward: Math.max(0, Math.trunc(Number(payload.copper_reward ?? 0)) || 0),
    repeatable,
    next_quest_id: payload.next_quest_id === null || payload.next_quest_id === undefined ? null : Number(payload.next_quest_id),
    sort_order: Math.trunc(Number(payload.sort_order ?? 0)) || 0,
  };

  let questId = selfId;
  const existing = selfId !== null ? find(selfId) : undefined;
  if (existing && selfId !== null) {
    await query(
      `UPDATE quests SET name = ?, zone = ?, offer_text = ?, description = ?, progress_text = ?, completion_text = ?,
       required_level = ?, quest_level = ?, xp_reward = ?, copper_reward = ?, repeatable = ?, next_quest_id = ?, sort_order = ?
       WHERE id = ?`,
      [
        row.name, row.zone, row.offer_text, row.description, row.progress_text, row.completion_text,
        row.required_level, row.quest_level, row.xp_reward, row.copper_reward, row.repeatable,
        row.next_quest_id, row.sort_order, selfId,
      ]
    );
    questId = selfId;
  } else {
    const result = (await query(
      `INSERT INTO quests (name, zone, offer_text, description, progress_text, completion_text,
       required_level, quest_level, xp_reward, copper_reward, repeatable, next_quest_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.name, row.zone, row.offer_text, row.description, row.progress_text, row.completion_text,
        row.required_level, row.quest_level, row.xp_reward, row.copper_reward, row.repeatable,
        row.next_quest_id, row.sort_order,
      ]
    )) as any;
    questId = Number(result?.insertId ?? result?.lastInsertRowid);
    if (!Number.isFinite(questId)) {
      // Fall back to re-reading the row by name.
      const rows = (await query("SELECT id FROM quests WHERE name = ?", [row.name])) as any[];
      questId = Number(rows?.[0]?.id);
    }
  }
  if (!Number.isFinite(questId)) return { ok: false, errors: ["Could not save the quest."] };

  // Full replace of children: partial diffs buy nothing and risk orphan rows.
  await query("DELETE FROM quest_objectives WHERE quest_id = ?", [questId]);
  const objectives = payload.objectives || [];
  let sort = 0;
  for (const o of objectives) {
    await query(
      `INSERT INTO quest_objectives (quest_id, sort_order, type, target, required_count, target_x, target_y, target_radius, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        questId,
        o.sort_order ?? sort++,
        o.type,
        String(o.target).trim(),
        Math.max(1, Math.trunc(Number(o.required_count ?? 1)) || 1),
        o.target_x ?? null,
        o.target_y ?? null,
        o.target_radius ?? null,
        o.description ?? null,
      ]
    );
  }

  await query("DELETE FROM quest_rewards WHERE quest_id = ?", [questId]);
  const rewards = payload.rewards || [];
  sort = 0;
  for (const r of rewards) {
    await query(
      `INSERT INTO quest_rewards (quest_id, item_name, quantity, is_choice, sort_order) VALUES (?, ?, ?, ?, ?)`,
      [
        questId,
        String(r.item_name).trim(),
        Math.max(1, Math.trunc(Number(r.quantity ?? 1)) || 1),
        r.is_choice ? 1 : 0,
        r.sort_order ?? sort++,
      ]
    );
  }

  await query("DELETE FROM quest_prerequisites WHERE quest_id = ?", [questId]);
  for (const pre of payload.prerequisites || []) {
    await query("INSERT INTO quest_prerequisites (quest_id, required_quest_id) VALUES (?, ?)", [questId, Number(pre)]);
  }

  if (payload.givers !== undefined) {
    await query("DELETE FROM npc_quests WHERE quest_id = ? AND `role` = 'giver'", [questId]);
    for (const npcId of payload.givers || []) {
      await query("INSERT INTO npc_quests (npc_id, quest_id, `role`) VALUES (?, ?, 'giver')", [Number(npcId), questId]);
    }
  }
  if (payload.enders !== undefined) {
    await query("DELETE FROM npc_quests WHERE quest_id = ? AND `role` = 'ender'", [questId]);
    for (const npcId of payload.enders || []) {
      await query("INSERT INTO npc_quests (npc_id, quest_id, `role`) VALUES (?, ?, 'ender')", [Number(npcId), questId]);
    }
  }

  await reload();
  return { ok: true, errors: [], id: questId };
}

export async function remove(questId: number): Promise<void> {
  const qid = Number(questId);
  if (!Number.isFinite(qid)) return;
  await query("DELETE FROM quest_rewards WHERE quest_id = ?", [qid]);
  await query("DELETE FROM quest_objectives WHERE quest_id = ?", [qid]);
  await query("DELETE FROM quest_prerequisites WHERE quest_id = ? OR required_quest_id = ?", [qid, qid]);
  await query("DELETE FROM npc_quests WHERE quest_id = ?", [qid]);
  await query("DELETE FROM quest_objective_progress WHERE quest_id = ?", [qid]);
  await query("DELETE FROM quest_log WHERE quest_id = ?", [qid]);
  await query("UPDATE quests SET next_quest_id = NULL WHERE next_quest_id = ?", [qid]);
  await query("DELETE FROM quests WHERE id = ?", [qid]);
  await reload();
}

export type QuestEditorResult =
  | { kind: "data"; data: QuestEditorData }
  | { kind: "search"; data: QuestSearchResult }
  | { kind: "result"; ok: boolean; errors: string[]; id?: number };

/** Dispatch for every QUEST_EDITOR_* packet. The caller checks permission first. */
export async function handleEditorPacket(type: string, data: any): Promise<QuestEditorResult> {
  switch (type) {
    case "QUEST_EDITOR_DATA":
    case "TOGGLE_QUEST_EDITOR":
      return { kind: "data", data: await buildEditorData() };

    case "QUEST_EDITOR_SEARCH":
      return { kind: "search", data: await search(data?.query) };

    case "QUEST_EDITOR_SAVE": {
      const result = await save((data ?? {}) as QuestSavePayload);
      return { kind: "result", ok: result.ok, errors: result.errors, id: result.id };
    }

    case "QUEST_EDITOR_DELETE": {
      const id = Number(data?.questId ?? data?.id);
      if (!Number.isFinite(id)) return { kind: "result", ok: false, errors: ["Nothing selected."] };
      await remove(id);
      return { kind: "result", ok: true, errors: [], id };
    }

    default:
      return { kind: "result", ok: false, errors: [`Unknown quest editor action: ${type}`] };
  }
}

const questEditor = {
  canUseEditor,
  buildEditorData,
  search,
  validateQuest,
  save,
  remove,
  handleEditorPacket,
};

export default questEditor;
