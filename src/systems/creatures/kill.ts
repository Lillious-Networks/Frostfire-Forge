/**
 * What happens when a tapped creature dies: XP (with party split), quest kill
 * credit and corpse loot. Owns the corpse loot store.
 */
import log from "../../modules/logger";
import { getIconUrl } from "../../modules/spriteSheetManager";
import assetCache from "../../services/assetCache";
import playerCache from "../../services/playermanager";
import { deliverToPlayer, isOnline } from "../../cluster/deliver";
import { entityById, mirrorByUsername, playerLayer } from "../../cluster/mirrors";
import { fitsInRoom, type BagRoom } from "../../cluster/remoteitems";
import { STAT_INT_MAX, sendGrant, sendRewards, setGrantApplier, setRewardApplier, type GrantBody, type GrantOutcome, type RewardBody } from "./remotereward";
import { atomically, nothingWritten } from "../../services/batch";
import { grants } from "../../cluster/grants";
import { clusterEnabled } from "../../cluster/config";
import { grantWrittenBefore, recordGrantWrite } from "../grantwrites";
import { setCopperCap } from "../itembounds";
import { broadcastToAOI } from "../../socket/aoi";
import { packetManager } from "../../socket/packet_manager";
import bags from "../bags";
import currency from "../currency";
import { Events, listener } from "../events";
import inventory from "../inventory";
import lootTable from "../lootTable";
import playerSystem from "../player";
import { credit } from "../quests/objectives";
import { markersFor } from "../quests/markers";
import { CORPSE_EMPTY_MS, CORPSE_WITH_LOOT_MS, CreatureFlags, randInt, yards } from "./constants";
import { CorpseLootStore, type CorpseItem } from "./loot";
import { baseKillXp, distributeKillXp, groupBonus, rankMultiplier, REWARD_RANGE_YD } from "./rewards";
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

/** A group member by name: the player here, or the mirror of a player on a neighbouring node (cluster mode). */
export function findMemberByUsername(username: string): any | null {
  return findPlayerByUsername(username) ?? mirrorByUsername(username) ?? null;
}

function tapperPlayer(creature: CreatureInstance): any | null {
  const tap = creature.combat.tapper;
  if (!tap) return null;
  const byId = entityById(tap.playerId);
  return byId && lower(byId.username) === tap.username ? byId : findMemberByUsername(tap.username);
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
  const party = (entityById(tap.playerId)?.party || []).map(lower);
  return party.includes(viewer) ? "mine" : "other";
}

/** Group members near enough to the corpse (same map and layer, not a ghost) to get rewards. */
export function eligibleMembers(creature: CreatureInstance): any[] {
  const range = yards(REWARD_RANGE_YD);
  const members: any[] = [];
  for (const name of tapGroupNames(creature)) {
    const p = findMemberByUsername(name);
    const pos = p?.location?.position;
    if (!p || !pos || p.isGhost) continue;
    if (normMap(p.location.map) !== creature.map) continue;
    if (creature.layerId !== null && playerLayer(p.id) !== creature.layerId) continue;
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
  // increaseXp (systems/player.ts) levels up once per pass, with no limit of its own: an amount beyond what the stats
  // table holds would keep it running, and with it this node's one thread, for as long as the number is large.
  if (!Number.isFinite(amount) || amount > STAT_INT_MAX) {
    log.error(`XP award of ${amount} to ${member?.username} for creature ${creatureId} refused: more than the stats table holds`);
    return;
  }
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
      const updates = await credit(member.username, "kill", String(template.id), 1);
      if (updates.length === 0) {
        listener.emit(Events.CREATURE_KILL_CREDIT, { player: member, templateId: template.id, creature, updates });
        continue;
      }
      const byQuest = new Map<number, typeof updates>();
      for (const u of updates) {
        const list = byQuest.get(u.questId) || [];
        list.push(u);
        byQuest.set(u.questId, list);
      }
      for (const [questId, questUpdates] of byQuest) {
        send(member.wt, packetManager.questProgress({ questId, updates: questUpdates }));
        for (const u of questUpdates) {
          if (!u.questReady) {
            send(member.wt, packetManager.notify({ message: `${template.name} slain: ${u.count}/${u.required}` }));
          }
        }
      }
      try {
        const map = member?.location?.map;
        if (map) {
          const markers = await markersFor(member.username, String(map));
          send(member.wt, packetManager.questMarkers({ map: String(map).replaceAll(".json", ""), markers }));
        }
      } catch {
        // Markers are best-effort on the kill path.
      }
      listener.emit(Events.CREATURE_KILL_CREDIT, { player: member, templateId: template.id, creature, updates });
    } catch (error) {
      log.error(`Creature kill credit failed for ${member.username}: ${error}`);
    }
  }
}

async function createCorpseLoot(creature: CreatureInstance, template: CreatureTemplate, members: any[]): Promise<void> {
  const rolled: CorpseItem[] = template.loot_table_id ? ((await lootTable.roll(template.loot_table_id)) as CorpseItem[]) : [];
  // The roll names an icon after the item; the item's own icon is the one the bags show.
  const known = ((await assetCache.get("items")) as any[]) || [];
  const items = rolled.map((item) => {
    const def = known.find((k) => lower(k?.name) === lower(item.itemName));
    return def?.icon ? { ...item, iconUrl: getIconUrl(def.icon) || item.iconUrl } : item;
  });
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
  const lootable = packetManager.creatureLootable({ id: creature.id, lootable: true });
  const ownerHere = findPlayerByUsername(owner);
  // The loot owner may be a player of a neighbouring node, who sees this corpse as a mirror.
  if (ownerHere) send(ownerHere.wt, lootable);
  else void deliverToPlayer(owner, lootable);
}

/** Rewards for a creature that just died. Untapped kills give nothing. */
export async function handleKill(creature: CreatureInstance, template: CreatureTemplate): Promise<void> {
  if (!creature.combat.tapper) return;
  const members = eligibleMembers(creature);
  if (members.length === 0) return;

  // A member on a neighbouring node (a mirror) gets their share there (APPLY_REWARD). The split counts everyone.
  const local = members.filter((m) => !m.remote);
  const away = members.filter((m) => m.remote);
  // A mirror that arrived without stats has no known level: it is left out of the split (it would count as
  // level 1 and skew the highest level for everyone) and gets 0 XP, with its quest credit as the rest do.
  const counted = members.filter((m) => !(m.remote && !m.stats));
  const xp = (template.flags & CreatureFlags.NO_XP) !== 0
    ? new Map<string, number>()
    : distributeKillXp(
      counted.map((m) => ({ username: lower(m.username), level: Number(m.stats?.level) || 1 })),
      creature.level,
      template.rank,
      template.xp_mult
    );

  const xpTask = async () => {
    for (const member of local) {
      try {
        await awardXp(member, xp.get(lower(member.username)) ?? 0, creature.id);
      } catch (error) {
        log.error(`Creature XP award failed for ${member.username}: ${error}`);
      }
    }
  };

  const awayTask = async () => {
    if (away.length === 0) return;
    try {
      const shares: RewardBody[] = away.map((m) => ({
        username: m.username,
        playerId: String(m.id),
        creatureId: creature.id,
        templateId: template.id,
        templateName: template.name,
        xp: xp.get(lower(m.username)) ?? 0,
      }));
      for (const name of await sendRewards(shares)) {
        log.warn(`Kill reward for ${name} on another node was not confirmed (creature ${creature.id})`);
      }
    } catch (error) {
      log.error(`Creature rewards for members on other nodes failed: ${error}`);
    }
  };

  await Promise.all([
    xpTask(),
    awayTask(),
    creditQuests(local, creature, template),
    createCorpseLoot(creature, template, members).catch((error) => log.error(`Corpse loot failed: ${error}`)),
  ]);
}

/**
 * A share of a kill made on a neighbouring node, for a player here (APPLY_REWARD): their XP and their quest
 * credit, as handleKill gives a local member. False when the player is not here (they moved or left).
 */
export async function applyReward(body: RewardBody, from?: string): Promise<boolean> {
  const member = playerCache.get(String(body?.playerId));
  if (!member || lower(member.username) !== lower(body.username)) return false;
  // The creature is named by its template, and the template is this node's own: the kill credit and the name in the
  // notice come from its table, not from the body, and the XP cannot be more than that template gives.
  const template = knownTemplates.get(Number(body.templateId));
  if (!template) {
    log.warn(`Kill reward from ${from} for ${member.username} names creature template ${body.templateId}, which this node does not have`);
    return false;
  }
  const most = maxShareXp(template, Number(member.stats?.level) || 1);
  const xp = Number(body.xp);
  if (!Number.isFinite(xp) || xp < 0 || xp > most) {
    log.warn(`Kill reward from ${from} for ${member.username}: ${body.xp} XP is more than creature template ${template.id} gives (${most} at most)`);
    return false;
  }
  await awardXp(member, xp, Number(body.creatureId));
  // Quest credit reads only the template's id and name, and passes the creature on in CREATURE_KILL_CREDIT.
  // On this path that creature carries only its id, so a plugin listening for the event gets no map or level.
  await creditQuests(
    [member],
    { id: Number(body.creatureId) } as CreatureInstance,
    { id: template.id, name: template.name } as CreatureTemplate
  );
  return true;
}

/**
 * This node's creature templates by id, and the most copper any of them drops. The creature system hands them in
 * each time it loads its tables (setKnownTemplates), so a reward or a grant is checked with no read of the asset
 * cache. Answers the map that was held before, so a test can put it back.
 */
let knownTemplates = new Map<number, CreatureTemplate>();
let mostCopperDropped = 0;

export function setKnownTemplates(templates: Map<number, CreatureTemplate>): Map<number, CreatureTemplate> {
  const previous = knownTemplates;
  knownTemplates = templates;
  mostCopperDropped = Math.min(STAT_INT_MAX, [...templates.values()].reduce((most, t) => Math.max(most, Number(t?.gold_max) || 0), 0));
  return previous;
}

/** The biggest group bonus there is (groupBonus, 1 to 5 members). */
const MAX_GROUP_BONUS = Math.max(...[1, 2, 3, 4, 5].map(groupBonus));

/**
 * The most XP a member of level `memberLevel` can be given for a kill of a creature of this template: what the
 * local kill reward gives a player of that level for the template's highest creature level (baseKillXp, which only
 * grows with the creature's level), times the rank and the template's multiplier and the biggest group bonus.
 * A share is never more than the whole, and the whole is worked from the highest member's level, which is above
 * this member's only when that member is in a group with them: then the share is cut by their part of the levels,
 * and stays under this bound. A member who gained a level between the kill and the reward arriving is allowed what
 * the level below gave. Rounded up by one, and at most what the stats table holds.
 */
export function maxShareXp(template: CreatureTemplate, memberLevel: number): number {
  if ((template.flags & CreatureFlags.NO_XP) !== 0) return 0;
  const level = Math.max(1, Number(memberLevel) || 1);
  const creatureLevel = Math.max(1, Number(template.level_max) || 1);
  const whole = Math.max(baseKillXp(level, creatureLevel), baseKillXp(Math.max(1, level - 1), creatureLevel)) * rankMultiplier(template.rank) * Math.max(0, Number(template.xp_mult) || 0) * MAX_GROUP_BONUS;
  return Math.min(STAT_INT_MAX, Math.ceil(whole) + 1);
}

/** The most copper a corpse holds: the biggest gold_max of this node's templates. A member's share is never more than that. */
export function maxCorpseCopper(): number {
  return mostCopperDropped;
}

setRewardApplier(applyReward);
// Hand-overs from other nodes carry corpse money at most (itembounds.ts). With no templates loaded yet the cap is not
// known (null): such a hand-over waits, parked, instead of being refused.
setCopperCap(() => (knownTemplates.size > 0 ? maxCorpseCopper() : null));

export type LootError = "not_found" | "too_far" | "not_allowed" | "empty" | "failed" | "full";

/**
 * The items a player's bags have room for, in order: more of something they hold takes no slot,
 * anything else takes one (as vendors and mail count it, systems/vendors.ts hasRoomFor).
 */
async function fitsInBags(username: string, items: CorpseItem[]): Promise<CorpseItem[]> {
  return fitsInRoom(await bagRoom(username), items);
}

/** The room in a player's bags (fitsInBags), as a looter's node sends it to a corpse's owner (LOOT_TAKE). */
export async function bagRoom(username: string): Promise<BagRoom> {
  const carried = ((await inventory.get(username)) as any[]) ?? [];
  return {
    free: (await bags.capacity(username)) - carried.length,
    held: [...new Set(carried.map((row) => lower(row.item ?? row.name)))],
  };
}

function checkLootAccess(player: any, creature: CreatureInstance | undefined): LootError | null {
  if (!creature || creature.state !== AIState.DEAD || !corpseLoot.has(creature.id)) return "empty";
  if (normMap(player?.location?.map) !== creature.map) return "not_found";
  if (creature.layerId !== null && playerLayer(player.id) !== creature.layerId) return "not_found";
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
  indices: number[] | null,
  room?: BagRoom
): Promise<{ taken: CorpseItem[]; empty: boolean; full: boolean; remaining: CorpseItem[]; copper: number } | LootError> {
  const error = checkLootAccess(player, creature);
  if (error) return error;
  // A looter of a neighbouring node (a mirror, LOOT_TAKE) sends the room in their bags, and their node
  // writes what they take: the items and their share of the money go back in the answer.
  const handOver = !!player.remote;
  // Only what fits in the looter's bags is taken: the rest stays on the corpse.
  const wanted = corpseLoot.remaining(creature!.id).filter((item) => !indices || indices.includes(item.index));
  const fits = handOver ? fitsInRoom(room ?? { free: 0, held: [] }, wanted) : await fitsInBags(player.username, wanted);
  const full = fits.length < wanted.length;
  // Looked at again: the corpse may have been looted or gone while the bags were counted.
  const loot = corpseLoot.get(creature!.id);
  if (!loot || creature!.state !== AIState.DEAD) return "empty";
  if (full && fits.length === 0 && loot.copper <= 0) return "full";
  // Off the corpse before anything else is awaited: a second take meanwhile finds it gone.
  const result = corpseLoot.take(creature!.id, player.username, fits.map((item) => item.index));
  if (!result) return "not_allowed";

  // Who gets their share where: written here for a player here or offline, sent to the node of a member on
  // another node (sendGrant), or handed over to a looter of a neighbouring node.
  const looterKey = lower(player.username);
  const here: string[] = [];
  const away: string[] = [];
  // Asked all at once: each lookup of a member who is not here can go to the directory.
  const members = [...result.copper.keys()].filter((name) => !(handOver && name === looterKey));
  const elsewhere = await Promise.all(members.map(async (name) => !findPlayerByUsername(name) && (!!mirrorByUsername(name) || (await isOnline(name)))));
  members.forEach((name, i) => (elsewhere[i] ? away : here).push(name));

  // The items and every share written here are kept together or not at all.
  let balances: Map<string, Currency>;
  // The items that were really added: the batch add answers nothing for a name that is not an item.
  let added: CorpseItem[] = [];
  const keys = handOver ? here : [player.username, ...here];
  try {
    balances = keys.length === 0 ? new Map() : await atomically(keys, async (batch) => {
      added = [];
      if (!handOver) {
        for (const item of result.taken) {
          if (await inventory.add(player.username, { name: item.itemName, quantity: item.quantity } as any, batch)) added.push(item);
        }
      }
      const after = new Map<string, Currency>();
      for (const name of here) {
        after.set(name, await currency.add(name, { copper: result.copper.get(name)!, silver: 0, gold: 0 }, batch));
      }
      return after;
    });
  } catch (error) {
    log.error(`Corpse loot could not be given to ${player.username}: ${error}`);
    // Nobody was given anything: it is on the corpse again, while there is one.
    if (creature!.state === AIState.DEAD) corpseLoot.restore(loot, result);
    return "failed";
  }

  for (const name of here) {
    const copper = result.copper.get(name)!;
    const newBalance = balances.get(name)!;
    const recipient = findPlayerByUsername(name);
    if (recipient?.wt) {
      send(recipient.wt, packetManager.currency(newBalance));
      send(recipient.wt, packetManager.notify({ message: `You receive loot: ${formatMoney(copper)}` }));
    }
  }
  // The shares for members on other nodes are already off the corpse, so they are paid after the looter is answered:
  // a grant to a slow node must not hold the answer back, or the looter's call (the same 10 s) times out and the
  // items they took are lost. Nothing of the looter's is in these shares, so the two cannot overlap.
  if (away.length > 0) {
    const paying = payAway(away.map((name) => ({ username: name, copper: result.copper.get(name)! })))
      .finally(() => pending.delete(paying));
    pending.add(paying);
  }
  // The same hook a pickup from the ground has (systems/loot.ts), so what counts loot counts this too.
  // A looter of a neighbouring node gets these from their own node.
  for (const item of added) {
    send(player.wt, packetManager.lootReceived({ itemName: item.itemName, quantity: item.quantity, quality: item.quality || "common" }));
    listener.emit(Events.PLAYER_LOOT_RETRIEVED, { player, itemName: item.itemName, quantity: item.quantity, mapName: creature!.map, x: creature!.x, y: creature!.y } as any);
  }
  if (result.empty) {
    // A mirror has no connection here: send() skips it, and the looter's node tells its player.
    send(player.wt, packetManager.creatureLootable({ id: creature!.id, lootable: false }));
    creature!.combat.corpseUntil = Math.min(creature!.combat.corpseUntil, Date.now() + CORPSE_EMPTY_MS);
  }
  return {
    taken: result.taken,
    empty: result.empty,
    full,
    remaining: corpseLoot.remaining(creature!.id),
    copper: handOver ? result.copper.get(looterKey) ?? 0 : 0,
  };
}

/** The payments of shares to members on other nodes that are still under way. */
const pending = new Set<Promise<unknown>>();

/** Resolves once every share sent to another node has an outcome (tests wait on this; so can a shutdown). */
export async function grantsPaid(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/**
 * Sends each share to the node of its member, all at once, and logs the ones that are lost. Each is already off
 * the corpse, so none is retried (Deviation 15); a member who went offline meanwhile is written here.
 */
async function payAway(shares: GrantBody[]): Promise<void> {
  await Promise.all(shares.map(async (share) => {
    try {
      const outcome = await sendGrant(share);
      // Offline by now: their rows are written here, as for any offline member.
      if (outcome === "absent") await grantCopper(share, false);
      else if (outcome === "failed" || outcome === "unknown") log.warn(`Corpse money for ${share.username} (${share.copper} copper) on another node was ${outcome}`);
    } catch (error) {
      log.error(`Corpse money for ${share.username} (${share.copper} copper) was lost: ${error}`);
    }
  }));
}

/**
 * A share of a corpse's money for a player of this node (GRANT, cells-grant), or, when `mustBeHere` is false,
 * for one who is offline (their rows are written here). "absent" when they must be here and are not.
 */
async function grantCopper(body: GrantBody, mustBeHere: boolean): Promise<GrantOutcome> {
  const member = findPlayerByUsername(body.username);
  if (!member && mustBeHere) return "absent";
  const copper = Math.max(0, Math.floor(Number(body.copper) || 0));
  if (copper === 0) return "given";
  // A share a peer sent (mustBeHere) cannot be more than a corpse holds. One written for an offline member is this
  // node's own and was taken off its own corpse.
  if (mustBeHere) {
    const most = maxCorpseCopper();
    if (!Number.isInteger(body.copper) || copper > most) {
      log.warn(`Corpse money of ${body.copper} copper for ${body.username} refused: no corpse of this node's creatures holds more than ${most}`);
      return "failed";
    }
  }
  // A share with a grant id is given once (cluster/grants.ts): one sent again after a lost answer finds the mark.
  const id = body.id;
  // Security review L7: every sender sets an id in cluster mode, and a share without one could be paid twice when
  // sent again. One a peer sent without an id is refused there. Guard (test "a share without an id is refused in
  // cluster mode, and given as before with the cluster off").
  if (!id && mustBeHere && clusterEnabled()) {
    log.error(`Corpse money for ${body.username} (${copper} copper) is refused and lost: a share from another node carries no grant id, so it could be given twice`);
    return "failed";
  }
  if (id) {
    let first: boolean;
    try {
      first = await grants.firstApply(id);
    } catch (error) {
      // Without the mark a second send of this share would be given again: it is not given, and so it is lost.
      log.error(`Corpse money ${id} for ${body.username} (${copper} copper) is lost: its once-only mark could not be set, so it is not given: ${error}`);
      return "failed";
    }
    if (!first) {
      log.info(`Corpse money ${id} for ${body.username} (${copper} copper) was given before: not given again`);
      return "given";
    }
  }
  try {
    const balance = await atomically([body.username], async (batch) => {
      // The id's row goes with the money (grantwrites.ts, security review M2): the store's mark above is the fast
      // path, and this row is the proof should the store lose the mark. First in the batch, so its guard is known.
      if (id) await recordGrantWrite(batch, id);
      return await currency.add(body.username, { copper, silver: 0, gold: 0 }, batch);
    });
    if (member?.wt) {
      send(member.wt, packetManager.currency(balance));
      // Made here from the amount, never taken from the body.
      send(member.wt, packetManager.notify({ message: `You receive loot: ${formatMoney(copper)}` }));
    }
    return "given";
  } catch (error) {
    // Guard (test "a share whose id was written before is not given again, and keeps its mark").
    if (id && grantWrittenBefore(error)) {
      log.info(`Corpse money ${id} for ${body.username} (${copper} copper) was given before: not given again`);
      return "given";
    }
    log.error(`Corpse money (${copper} copper) could not be given to ${body.username}: ${error}`);
    if (id) {
      // Nothing was written: a second send of the same share may give it. Any other failure may come after the
      // commit (a kept step, or a commit whose answer was lost), so the mark stays and the share is not given again.
      if (nothingWritten(error)) await grants.unapply(id);
      else log.error(`Corpse money ${id} (${copper} copper) for ${body.username} may have been written; it is not given again (lost if it was not)`);
    }
    return "failed";
  }
}

setGrantApplier((body) => grantCopper(body, true));
