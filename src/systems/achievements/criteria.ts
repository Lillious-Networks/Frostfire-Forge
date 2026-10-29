// What an engine event is to the achievements: the deeds it stands for (who did what, how much), and whether a deed
// counts toward an achievement. No state and no network: service.ts does the counting, index.ts the listening.
import { Events } from "../events";
import { CRITERIA, ID_TARGETS, type AchievementDef, type CriterionType, type Deed } from "./types";

/** Every event a deed is read from: what index.ts listens to. */
export const COUNTED_EVENTS: readonly string[] = [
  Events.CREATURE_KILL_CREDIT, Events.PLAYER_DEATH, Events.QUEST_COMPLETED, Events.PLAYER_LEVEL_UP,
  Events.GATHER_COMPLETED, Events.PLAYER_LOOT_RETRIEVED, Events.COLLECTABLE_ADDED, Events.MAP_ENTER,
  Events.SPELL_CAST, Events.TRADE_COMPLETED, Events.FRIEND_ADDED, Events.GUILD_CHANGED, Events.PLAYER_MOUNT,
];

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
const mapName = (value: unknown) => String(value ?? "").trim().replace(/\.json$/i, "");
const nameOf = (player: any) => String(player?.username ?? "");

/** The deeds an event stands for. Payloads are as the engine emits them (see systems/events.ts and the emit sites). */
export function deedsOf(event: string, payload: any): Deed[] {
  const deeds: Deed[] = [];
  const add = (username: unknown, type: CriterionType, target: string | number | null, amount: unknown = 1) => {
    const name = String(username ?? "").trim();
    const count = Math.floor(Number(amount));
    if (!name || !Number.isFinite(count) || count <= 0) return;
    deeds.push({ username: name, type, target, amount: count });
  };
  switch (event) {
    case Events.CREATURE_KILL_CREDIT:
      // each player credited, party members included (systems/creatures/kill.ts)
      if (Number.isFinite(Number(payload?.templateId))) add(nameOf(payload?.player), "creature_kill", Number(payload?.templateId));
      break;
    case Events.PLAYER_DEATH: {
      const victim = nameOf(payload?.player);
      // Across a border the death is emitted on both nodes: the victim's counts the death, the killer's the kill.
      if (!payload?.player?.remote) add(victim, "death", null);
      const killer = payload?.killer;
      // creatures and the tornado kill as stand-ins marked isCreature (socket/receiver.ts)
      if (killer && !killer.remote && !killer.isCreature && nameOf(killer) && lower(nameOf(killer)) !== lower(victim)) add(nameOf(killer), "pvp_kill", null);
      break;
    }
    case Events.QUEST_COMPLETED:
      add(payload?.username, "quest_complete", Number(payload?.questId));
      break;
    case Events.PLAYER_LEVEL_UP:
      // emitted as { player, level }
      add(nameOf(payload?.player), "level", null, payload?.level ?? payload?.newLevel ?? payload?.player?.stats?.level);
      break;
    case Events.GATHER_COMPLETED:
      if (String(payload?.item ?? "").trim()) add(nameOf(payload?.player), "gather", String(payload.item), payload?.quantity ?? 1);
      break;
    case Events.PLAYER_LOOT_RETRIEVED:
      if (String(payload?.itemName ?? "").trim()) add(nameOf(payload?.player), "loot", String(payload.itemName), payload?.quantity ?? 1);
      break;
    case Events.COLLECTABLE_ADDED:
      // only mounts are collectables achievements count
      if (lower(payload?.type) === "mount" && String(payload?.item ?? "").trim()) add(payload?.username, "collectable", String(payload.item));
      break;
    case Events.MAP_ENTER:
      add(nameOf(payload?.player), "map_visit", mapName(payload?.mapName));
      break;
    case Events.SPELL_CAST:
      add(nameOf(payload?.player), "spell_cast", String(payload?.spellName ?? ""));
      break;
    case Events.TRADE_COMPLETED:
      add(payload?.trade?.player_a, "trade", null);
      add(payload?.trade?.player_b, "trade", null);
      break;
    case Events.FRIEND_ADDED: {
      // a friendship is both ways: it counts for the one who accepted and the one who asked (once if they are the same)
      const accepted = String(payload?.playerUsername ?? "").trim();
      const asked = String(payload?.friendUsername ?? "").trim();
      add(accepted, "friend_add", null);
      if (lower(asked) !== lower(accepted)) add(asked, "friend_add", null);
      break;
    }
    case Events.GUILD_CHANGED:
      if (payload?.type === "join" || payload?.type === "create") add(payload?.playerUsername, "guild_join", null);
      break;
    case Events.PLAYER_MOUNT:
      if (payload?.mounted === true) add(nameOf(payload?.player), "mount_ride", payload?.mountType ? String(payload.mountType) : null);
      break;
    default:
      break;
  }
  return deeds;
}

const comparable = (type: CriterionType, value: string | number) => (type === "map_visit" ? lower(mapName(value)) : lower(value));

/** Whether `deed` counts toward `def`: the same type, and the target `def` names (or any, where that is allowed). */
export function matches(def: AchievementDef, deed: Deed): boolean {
  if (def.type !== deed.type) return false;
  const rule = CRITERIA[def.type].target;
  if (rule === "none") return true;
  if (def.target === null || def.target.trim() === "") return rule === "optional";
  if (deed.target === null || deed.target === "") return false;
  if (ID_TARGETS.has(def.type)) return Number(def.target) === Number(deed.target);
  return comparable(def.type, def.target) === comparable(def.type, deed.target);
}

/** The progress after `deed`: a level keeps the highest level reached, everything else adds up. */
export function progressAfter(def: AchievementDef, current: number, deed: Deed): number {
  return def.type === "level" ? Math.max(current, deed.amount) : current + deed.amount;
}
