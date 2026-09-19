/**
 * What happens when a tapped creature dies: XP (with party split), quest kill
 * credit and corpse loot. Owns the corpse loot store.
 */
import log from "../../modules/logger";
import layerManager from "../../services/layermanager";
import playerCache from "../../services/playermanager";
import { broadcastToAOI } from "../../socket/aoi";
import { packetManager } from "../../socket/packet_manager";
import currency from "../currency";
import { Events, listener } from "../events";
import inventory from "../inventory";
import lootTable from "../lootTable";
import playerSystem from "../player";
import { questKills } from "../questlog";
import { CORPSE_EMPTY_MS, CORPSE_WITH_LOOT_MS, CreatureFlags, randInt, yards } from "./constants";
import { CorpseLootStore, type CorpseItem } from "./loot";
import { distributeKillXp, REWARD_RANGE_YD } from "./rewards";
import { AIState, type CreatureInstance, type CreatureTemplate } from "./types";

export const corpseLoot = new CorpseLootStore();

/** Players must be this close to a corpse to loot it (matches loot chests). */
export const LOOT_RANGE_PX = 120;

const lower = (s: unknown) => String(s ?? "").toLowerCase();
const normMap = (map: unknown) => String(map ?? "").replaceAll(".json", "");

function send(wt: any, packets: any[]): void {
  if (!wt || !wt.send || wt.readyState !== 1) return;
  try {
    for (const p of packets) wt.send(p);
  } catch {
    // Connection closing.
  }
}

export function findPlayerByUsername(username: string): any | null {
  const target = lower(username);
  for (const p of Object.values(playerCache.list() as Record<string, any>)) {
    if (p && lower(p.username) === target) return p;
  }
  return null;
}

function tapperPlayer(creature: CreatureInstance): any | null {
  const tap = creature.combat.tapper;
  if (!tap) return null;
  const byId = playerCache.get(tap.playerId);
  return byId && lower(byId.username) === tap.username ? byId : findPlayerByUsername(tap.username);
}

/** Tapper plus their current party, lowercased usernames. */
export function tapGroupNames(creature: CreatureInstance): string[] {
  const tap = creature.combat.tapper;
  if (!tap) return [];
  const names = new Set<string>([tap.username]);
  for (const member of tapperPlayer(creature)?.party || []) names.add(lower(member));
  return [...names];
}

/** Tap state as seen by one player: grey nameplate when someone outside their group owns the kill. */
export function tapStateFor(creature: CreatureInstance, viewerId: string): "none" | "mine" | "other" {
  const tap = creature.combat.tapper;
  if (!tap) return "none";
  if (tap.playerId === viewerId) return "mine";
  const viewer = lower(playerCache.get(viewerId)?.username);
  if (!viewer) return "other";
  if (viewer === tap.username) return "mine";
  const party = (playerCache.get(tap.playerId)?.party || []).map(lower);
  return party.includes(viewer) ? "mine" : "other";
}

/** Group members near enough to the corpse (same map and layer, not a ghost) to get rewards. */
export function eligibleMembers(creature: CreatureInstance): any[] {
  const range = yards(REWARD_RANGE_YD);
  const members: any[] = [];
  for (const name of tapGroupNames(creature)) {
    const p = findPlayerByUsername(name);
    const pos = p?.location?.position;
    if (!p || !pos || p.isGhost) continue;
    if (normMap(p.location.map) !== creature.map) continue;
    if (creature.layerId !== null && layerManager.getPlayerLayer(p.id) !== creature.layerId) continue;
    if (Math.hypot(pos.x - creature.x, pos.y - creature.y) > range) continue;
    members.push(p);
  }
  return members;
}

export function formatMoney(copper: number): string {
  const gold = Math.floor(copper / 10000);
  const silver = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  return [gold ? `${gold} gold` : "", silver ? `${silver} silver` : "", c || (!gold && !silver) ? `${c} copper` : ""]
    .filter(Boolean)
    .join(", ");
}

async function awardXp(member: any, amount: number, creatureId: number): Promise<void> {
  if (amount <= 0) return;
  const levelBefore = Number(member.stats?.level) || 1;
  const result: any = await playerSystem.increaseXp(member.username, amount);
  const fresh = playerCache.get(member.id);
  if (!fresh || !result || Array.isArray(result)) return;

  fresh.stats.xp = result.xp;
  fresh.stats.max_xp = result.max_xp;
  const leveled = result.level > levelBefore;
  if (leveled) {
    fresh.stats.level = result.level;
    fresh.stats.max_health = playerSystem.getMaxHealthForLevel(result.level);
    fresh.stats.max_stamina = playerSystem.getMaxStaminaForLevel(result.level);
    const synced = await playerSystem.synchronizeStats(fresh.username);
    if (synced) fresh.stats = synced;
    fresh.stats.health = fresh.stats.total_max_health ?? fresh.stats.max_health;
    fresh.stats.stamina = fresh.stats.total_max_stamina ?? fresh.stats.max_stamina;
  }
  playerCache.set(fresh.id, fresh);

  const stats = packetManager.updateStats({ id: fresh.id, target: fresh.id, stats: fresh.stats });
  if (leveled) {
    broadcastToAOI(fresh, stats);
    listener.emit(Events.PLAYER_LEVEL_UP, { player: fresh, level: result.level });
  } else {
    send(fresh.wt, stats);
  }
  send(fresh.wt, packetManager.creatureXp({ creatureId, amount }));
}

async function creditQuests(members: any[], creature: CreatureInstance, template: CreatureTemplate): Promise<void> {
  for (const member of members) {
    try {
      const updates = await questKills.creditKill(member.username, template.id);
      for (const u of updates) {
        send(member.wt, packetManager.notify({ message: `${template.name} slain: ${u.count}/${u.required}` }));
      }
      listener.emit(Events.CREATURE_KILL_CREDIT, { player: member, templateId: template.id, creature, updates });
    } catch (error) {
      log.error(`Creature kill credit failed for ${member.username}: ${error}`);
    }
  }
}

async function createCorpseLoot(creature: CreatureInstance, template: CreatureTemplate, members: any[]): Promise<void> {
  const items: CorpseItem[] = template.loot_table_id ? ((await lootTable.roll(template.loot_table_id)) as CorpseItem[]) : [];
  const copper = template.gold_max > 0 ? randInt(template.gold_min, template.gold_max) : 0;
  const names = members.map((m) => lower(m.username));
  const tapper = tapperPlayer(creature);
  const groupKey = names.length > 1 && tapper?.party_id ? `party:${tapper.party_id}` : null;
  const owner = corpseLoot.pickOwner(groupKey, names);
  if (!owner) return;
  const loot = corpseLoot.create(creature.id, items, copper, [owner], names);
  // The creature may have despawned while the loot table was being rolled.
  if (!loot || creature.state !== AIState.DEAD) {
    corpseLoot.remove(creature.id);
    return;
  }
  creature.combat.corpseUntil = Math.max(creature.combat.corpseUntil, Date.now() + CORPSE_WITH_LOOT_MS);
  send(findPlayerByUsername(owner)?.wt, packetManager.creatureLootable({ id: creature.id, lootable: true }));
}

/** Rewards for a creature that just died. Untapped kills give nothing. */
export async function handleKill(creature: CreatureInstance, template: CreatureTemplate): Promise<void> {
  if (!creature.combat.tapper) return;
  const members = eligibleMembers(creature);
  if (members.length === 0) return;

  const xpTask = async () => {
    if ((template.flags & CreatureFlags.NO_XP) !== 0) return;
    const xp = distributeKillXp(
      members.map((m) => ({ username: lower(m.username), level: Number(m.stats?.level) || 1 })),
      creature.level,
      template.rank,
      template.xp_mult
    );
    for (const member of members) {
      try {
        await awardXp(member, xp.get(lower(member.username)) ?? 0, creature.id);
      } catch (error) {
        log.error(`Creature XP award failed for ${member.username}: ${error}`);
      }
    }
  };

  await Promise.all([
    xpTask(),
    creditQuests(members, creature, template),
    createCorpseLoot(creature, template, members).catch((error) => log.error(`Corpse loot failed: ${error}`)),
  ]);
}

export type LootError = "not_found" | "too_far" | "not_allowed" | "empty";

function checkLootAccess(player: any, creature: CreatureInstance | undefined): LootError | null {
  if (!creature || creature.state !== AIState.DEAD || !corpseLoot.has(creature.id)) return "empty";
  if (normMap(player?.location?.map) !== creature.map) return "not_found";
  if (creature.layerId !== null && layerManager.getPlayerLayer(player.id) !== creature.layerId) return "not_found";
  const pos = player.location.position;
  if (Math.hypot(pos.x - creature.x, pos.y - creature.y) > LOOT_RANGE_PX) return "too_far";
  if (!corpseLoot.canLoot(creature.id, player.username)) return "not_allowed";
  return null;
}

export function openCorpse(player: any, creature: CreatureInstance | undefined): { items: CorpseItem[]; copper: number } | LootError {
  const error = checkLootAccess(player, creature);
  if (error) return error;
  const loot = corpseLoot.get(creature!.id)!;
  return { items: corpseLoot.remaining(creature!.id), copper: loot.copper };
}

export async function takeCorpseLoot(
  player: any,
  creature: CreatureInstance | undefined,
  indices: number[] | null
): Promise<{ taken: CorpseItem[]; empty: boolean } | LootError> {
  const error = checkLootAccess(player, creature);
  if (error) return error;
  const result = corpseLoot.take(creature!.id, player.username, indices);
  if (!result) return "not_allowed";

  for (const item of result.taken) {
    await inventory.add(player.username, { name: item.itemName, quantity: item.quantity } as any);
  }
  for (const [name, copper] of result.copper) {
    const newBalance = await currency.add(name, { copper, silver: 0, gold: 0 });
    const recipient = findPlayerByUsername(name);
    if (recipient?.wt) {
      send(recipient.wt, packetManager.currency(newBalance));
      send(recipient.wt, packetManager.notify({ message: `You receive loot: ${formatMoney(copper)}` }));
    }
  }
  if (result.empty) {
    send(player.wt, packetManager.creatureLootable({ id: creature!.id, lootable: false }));
    creature!.combat.corpseUntil = Math.min(creature!.combat.corpseUntil, Date.now() + CORPSE_EMPTY_MS);
  }
  return { taken: result.taken, empty: result.empty };
}
