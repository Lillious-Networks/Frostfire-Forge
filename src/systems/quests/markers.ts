import playerCache from "../../services/playermanager";
import assetCache from "../../services/assetCache";
import log from "../../modules/logger";
import { listener } from "../../modules/event_bus";
import { Events } from "../events";
import { packetManager } from "../../socket/packet_manager";
import { find, questsGivenBy, questsEndedBy } from "./definitions";
import { getCachedLog, MAX_ACTIVE_QUESTS } from "./log";

export type MarkerState = QuestMarkerState;

const PRECEDENCE: Record<MarkerState, number> = {
  ready: 4,
  available: 3,
  in_progress: 2,
  available_future: 1,
  none: 0,
};

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const normMap = (m: unknown): string => String(m ?? "").replaceAll(".json", "").toLowerCase();

function cachedPlayerLevel(username: string): number {
  const target = lower(username);
  const all = playerCache.list() as Record<string, any>;
  for (const p of Object.values(all || {})) {
    if (p && lower(p.username) === target) {
      const lvl = Number(p?.stats?.level);
      if (Number.isFinite(lvl) && lvl > 0) return lvl;
    }
  }
  return 1;
}

/** Sync eligibility using cached data only. Never touches the DB. */
export function eligibilitySync(username: string, questId: number): QuestEligibility {
  const quest = find(Number(questId));
  if (!quest) return "unknown_quest";
  const data = getCachedLog(username);
  if (!data) return "unknown_quest";
  const completedSet = new Set(data.completed.map(Number));
  const activeEntry = data.active.find((e) => e.quest_id === quest.id);
  if (activeEntry) return activeEntry.state === "ready" ? "ready" : "active";
  if (completedSet.has(quest.id)) {
    if (quest.repeatable === "none") return "completed";
    if (quest.repeatable === "daily") return "daily_not_reset";
  }
  if (cachedPlayerLevel(username) < quest.required_level) return "level_too_low";
  for (const pre of quest.prerequisites || []) {
    if (!completedSet.has(Number(pre))) return "missing_prerequisite";
  }
  if (data.active.length >= MAX_ACTIVE_QUESTS) return "log_full";
  return "available";
}

function markerForQuest(username: string, questId: number, npcId: number): MarkerState {
  const quest = find(Number(questId));
  if (!quest) return "none";
  const state = eligibilitySync(username, questId);
  const given = questsGivenBy(npcId).includes(quest.id);
  const ended = questsEndedBy(npcId).includes(quest.id);
  switch (state) {
    case "ready":
      return ended ? "ready" : "none";
    case "active":
      return ended ? "in_progress" : "none";
    case "available":
      return given ? "available" : "none";
    // Locked quests (level, prerequisites, log cap, daily cooldown) show no
    // marker at all - a grey ! teasing an unofferable quest is just noise.
    default:
      return "none";
  }
}

/** NPC marker computation, purely from cached definitions + cached player log. */
export async function markersFor(username: string, mapName: string): Promise<Record<number, MarkerState>> {
  const normalized = normMap(mapName);
  let npcs: Npc[] = [];
  try {
    npcs = ((await assetCache.get("npcs")) || []) as Npc[];
  } catch {
    npcs = [];
  }
  const result: Record<number, MarkerState> = {};
  for (const npc of npcs || []) {
    if (normMap(npc.map) !== normalized) continue;
    const npcId = Number(npc.id);
    if (!Number.isFinite(npcId)) continue;
    const questIds = [...new Set([...questsGivenBy(npcId), ...questsEndedBy(npcId)])];
    let best: MarkerState = "none";
    for (const qid of questIds) {
      const marker = markerForQuest(username, qid, npcId);
      if (PRECEDENCE[marker] > PRECEDENCE[best]) best = marker;
      if (best === "ready") break;
    }
    if (best !== "none") result[npcId] = best;
  }
  return result;
}

/** Sync variant for tests and hot paths where NPCs are already in hand. */
export function markersForSync(
  username: string,
  npcsOnMap: Array<{ id: number }>
): Record<number, MarkerState> {
  const result: Record<number, MarkerState> = {};
  for (const npc of npcsOnMap || []) {
    const npcId = Number((npc as any).id);
    if (!Number.isFinite(npcId)) continue;
    const questIds = [...new Set([...questsGivenBy(npcId), ...questsEndedBy(npcId)])];
    let best: MarkerState = "none";
    for (const qid of questIds) {
      const marker = markerForQuest(username, qid, npcId);
      if (PRECEDENCE[marker] > PRECEDENCE[best]) best = marker;
      if (best === "ready") break;
    }
    if (best !== "none") result[npcId] = best;
  }
  return result;
}

let levelHookRegistered = false;

/**
 * Quest availability is level-gated, so markers must refresh the moment a
 * player levels up - otherwise grey ! markers never turn gold without a
 * relog, map change or quest action.
 */
export function registerLevelUpHook(): void {
  if (levelHookRegistered) return;
  levelHookRegistered = true;
  listener.on(Events.PLAYER_LEVEL_UP, async ({ player }: any) => {
    try {
      const username = player?.username;
      const wt = player?.wt;
      if (!username || !wt || wt.readyState !== 1) return;
      const map = String(player?.location?.map ?? "").replaceAll(".json", "");
      const markers = await markersFor(username, map);
      for (const packet of packetManager.questMarkers({ map, markers })) {
        try {
          wt.send(packet);
        } catch {
          // Connection closing.
        }
      }
    } catch (error) {
      log.warn(`Quest marker refresh on level-up failed: ${error}`);
    }
  });
}

const questMarkers = {
  markersFor,
  markersForSync,
  eligibilitySync,
  registerLevelUpHook,
};

export default questMarkers;
