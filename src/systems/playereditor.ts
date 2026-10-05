/**
 * Player editor: the admin window that changes another player's state.
 * Every change goes through the system that owns that state, so an offline
 * player is edited in the database and an online one also has their live copy
 * and their client brought up to date. Each packet is permission-checked and
 * validated here before anything is touched.
 */
import assetCache from "../services/assetCache";
import playerCache from "../services/playermanager";
import { turns } from "../services/datacache";
import log from "../modules/logger";
import { packetManager } from "../socket/packet_manager";
import { Events, listener } from "./events";
import player from "./player";
import permissions from "./permissions";
import inventory from "./inventory";
import equipment, { EQUIPMENT_SLOTS } from "./equipment";
import currency, { CURRENCY_LIMITS } from "./currency";
import collectables from "./collectables";
import spells from "./spells";
import friends from "./friends";
import guilds from "./guild";
import parties from "./parties";
import bags from "./bags";
import questLog, { rowsOf } from "./quests/log";
import questDefinitions from "./quests/definitions";
import { markersFor } from "./quests/markers";

/** Admins of the server itself: the rule the particle editor's packets use. */
export const EDITOR_PERMISSIONS = ["server.admin", "server.*"];
export const DENIED = "You don't have permission to use the player editor.";

/** Results per search: the editor finds a known player or item, it does not browse. */
export const SEARCH_LIMIT = 50;
/** Ceiling for a stat or an item stack. */
export const VALUE_MAX = 1000000;
/** The stats table holds 32-bit integers. */
const INT_MAX = 2147483647;

const DIRECTIONS = ["down", "up", "left", "right", "downleft", "downright", "upleft", "upright"];
/** Collections that can be given from here: each needs a catalogue to check the item against. */
const COLLECTABLE_TYPES = ["mount"];
/** Usernames are letters, digits and underscores; nothing else is looked up. */
const USERNAME = /^[a-zA-Z0-9_]{1,64}$/;
const DEAD = "The player is dead: revive them before changing this.";

/**
 * What only the socket layer can do for an online player (area-of-interest
 * broadcasts, sprites, map changes), registered by receiver.ts so this module
 * does not import it.
 */
export interface PlayerEditorBridge {
  /** Rebuild the live inventory from the database, bag slots worked out, and send it. */
  syncInventory(target: any): Promise<void>;
  /** Fresh stats for the players who can see the target and for their party. */
  broadcastStats(target: any): Promise<void>;
  /** Worn items changed: redraw the target's sprite for them and everyone who sees them. */
  refreshAppearance(target: any): Promise<void>;
  /** Send the target's collectables as the client lists them (icon URLs). */
  sendCollectables(target: any): void;
  /** Send the target's spell book as the client lists it (sprite URLs). */
  sendSpells(target: any): void;
  /** Announce the target to onlookers again: guild name and the flags drawn with the nameplate. */
  announce(target: any): void;
  /** A party's membership changed: gather its online members on the leader's layer. */
  syncPartyLayers(leader: string, members: string[]): Promise<void>;
  /** Move an online player, across maps or within one. */
  relocate(target: any, map: string, x: number, y: number, direction: string): Promise<void>;
}

let bridge: PlayerEditorBridge | null = null;

export function setPlayerEditorBridge(next: PlayerEditorBridge | null): void {
  bridge = next;
}

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const normMap = (map: unknown): string => String(map ?? "").replaceAll(".json", "");

function send(wt: any, packets: any[]): void {
  if (!wt || !wt.send || wt.readyState !== 1) return;
  try {
    for (const p of packets) wt.send(p);
  } catch {
    // Connection closing.
  }
}

/** A whole number within [min, max], or null for anything else a client can send. */
function wholeNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value === "string" ? value.trim() === "" : typeof value !== "number") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

async function cached<T>(key: string): Promise<T[]> {
  const value = await assetCache.get(key);
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * The live copy of a player, or null while they are offline. It is edited in
 * place and never stored back: a player who has just disconnected must not be
 * put back in the cache by a change that was still in flight.
 */
export function findOnline(username: string): any | null {
  const target = lower(username);
  for (const p of Object.values(playerCache.list() as Record<string, any>)) {
    if (p && lower(p.username) === target) return p;
  }
  return null;
}

// -------------------------------------------------------------- permission

async function heldPermissions(username: string): Promise<string[]> {
  const held = (await permissions.get(username)) as string;
  return String(held || "").split(",").map((p) => p.trim()).filter(Boolean);
}

/**
 * Asked of the permissions system on every packet (the row its cache holds,
 * which every change to a player's permissions is written to), not trusted
 * from the copy made at login.
 */
export async function canUseEditor(admin: any): Promise<boolean> {
  if (!admin?.username || admin.isGuest) return false;
  const held = await heldPermissions(admin.username);
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

// ------------------------------------------------------------------ target

export interface EditorTarget {
  username: string;
  userid: number;
}

/**
 * Who `/player edit <id>` and the editor's packets mean. A number is a
 * connection id first (what the other admin commands take), then an account
 * id; anything else is a username. Offline players resolve from their account.
 */
export async function resolveTarget(identifier: unknown): Promise<EditorTarget | null> {
  if (typeof identifier !== "string" && typeof identifier !== "number") return null;
  const id = String(identifier).trim();
  if (!USERNAME.test(id)) return null;

  if (/^\d+$/.test(id)) {
    const session = playerCache.get(id);
    if (session?.username) return { username: lower(session.username), userid: Number(session.userid) || 0 };
    const byId = await player.findAccount(undefined, Number(id));
    if (byId) return { username: lower(byId.username), userid: Number(byId.id) };
  }

  const live = findOnline(id);
  if (live) return { username: lower(live.username), userid: Number(live.userid) || 0 };
  const account = await player.findAccount(id);
  return account ? { username: lower(account.username), userid: Number(account.id) } : null;
}

// ---------------------------------------------------------------- snapshot

/** The level curve outgrows the stats table's integers: the last level whose XP still fits. */
function maxLevel(): number {
  let level = 1;
  while (player.getNewMaxXp(level + 1) <= INT_MAX) level++;
  return level;
}

export async function buildOptions(admin: any): Promise<PlayerEditorOptions> {
  const [maps, mounts, allSpells, guildList, permissionTypes] = await Promise.all([
    cached<MapProperties>("mapProperties"),
    cached<Mount>("mounts"),
    cached<SpellData>("spells"),
    guilds.list(),
    permissions.list(),
  ]);
  return {
    editor: lower(admin?.username),
    slots: [...EQUIPMENT_SLOTS],
    directions: DIRECTIONS,
    collectableTypes: COLLECTABLE_TYPES,
    maps: maps.map((m) => ({
      name: normMap(m.name),
      width: (Number(m.width) || 0) * (Number(m.tileWidth) || 0),
      height: (Number(m.height) || 0) * (Number(m.tileHeight) || 0),
    })),
    mounts: mounts.map((m) => ({ name: m.name, icon: typeof m.icon === "string" ? m.icon : null })),
    spells: allSpells.map((s) => ({ name: s.name, icon: s.icon ?? null })),
    quests: questDefinitions.getCachedQuestsSync().map((q) => ({ id: q.id, name: q.name, level: q.quest_level || q.required_level })),
    guilds: guildList.map((g) => ({ id: g.id, name: g.name, leader: g.leader, members: g.members.length })),
    permissionTypes,
    limits: { level: maxLevel(), value: VALUE_MAX, currency: CURRENCY_LIMITS },
  };
}

async function ownedCollectables(username: string): Promise<PlayerEditorSnapshot["collectables"]> {
  const [rows, mounts] = await Promise.all([collectables.list(username), cached<Mount>("mounts")]);
  return (rows || []).map((row: any) => {
    const mount = row.type === "mount" ? mounts.find((m) => lower(m.name) === lower(row.item)) : null;
    return {
      type: String(row.type),
      item: String(row.item),
      icon: typeof mount?.icon === "string" ? mount.icon : null,
      known: row.type !== "mount" || !!mount,
    };
  });
}

async function guildOf(username: string): Promise<PlayerEditorSnapshot["guild"]> {
  const id = await guilds.getGuildId(username);
  if (!id) return null;
  const [name, leader, members] = await Promise.all([guilds.getGuildName(id), guilds.getGuildLeader(id), guilds.getGuildMembers(id)]);
  return { id, name: name || "", leader: leader || "", members };
}

async function partyOf(username: string): Promise<PlayerEditorSnapshot["party"]> {
  const id = await parties.getPartyId(username);
  if (!id) return null;
  const [leader, members] = await Promise.all([parties.getPartyLeader(id), parties.getPartyMembers(id)]);
  return { id, leader: leader || "", members };
}

/** A player's quests as their rows of the two tables say: what is under way, with the count of each objective, and what is done. */
async function questsOf(username: string): Promise<{ active: Array<{ quest_id: number; state: "active" | "ready"; progress: Record<number, number> }>; completed: number[] }> {
  const { log: entries, progress } = await rowsOf(username);
  const counts = new Map<number, Record<number, number>>();
  for (const row of progress) {
    const quest = counts.get(Number(row.quest_id)) || {};
    quest[Number(row.objective_id)] = Number(row.count) || 0;
    counts.set(Number(row.quest_id), quest);
  }
  const active: Array<{ quest_id: number; state: "active" | "ready"; progress: Record<number, number> }> = [];
  const completed: number[] = [];
  for (const row of entries) {
    const id = Number(row.quest_id);
    if (row.state !== "completed") active.push({ quest_id: id, state: row.state === "ready" ? "ready" : "active", progress: counts.get(id) || {} });
    else if (!completed.includes(id)) completed.push(id);
  }
  return { active, completed };
}

/**
 * Everything the editor shows, from what the systems hold of the player:
 * nothing here asks the database. An online player's vitals and position
 * come from their live copy instead: those are only written down on the
 * periodic save.
 */
export async function buildSnapshot(username: string): Promise<PlayerEditorSnapshot | null> {
  const account = await player.getAccount(username);
  if (!account) return null;

  const [base, balance, friendList, held, quests, rows, worn, bagRow, owned, learned, slots, guild, party, items] = await Promise.all([
    player.getStats(username),
    currency.get(username),
    friends.list(username),
    heldPermissions(username),
    questsOf(username),
    inventory.get(username) as Promise<any[]>,
    equipment.list(username),
    bags.get(username),
    ownedCollectables(username),
    spells.listLearned(username),
    bags.capacity(username),
    guildOf(username),
    partyOf(username),
    cached<Item>("items"),
  ]);
  const live = findOnline(username);
  // An account with no stats row has none to show.
  const stats: Partial<StatsData> = !base || Array.isArray(base) ? {} : base;
  const vitals = live?.stats || stats;
  const known = new Set(items.map((i) => lower(i.name)));
  const [x, y] = String(account.position ?? "").split(",");

  return {
    username: account.username,
    userid: Number(account.id),
    online: !!live,
    sessionId: live ? String(live.id) : null,
    isAdmin: account.role === 1,
    isGuest: account.guest_mode === 1,
    banned: Number(account.banned) === 1,
    dead: live ? (live.isDead ? 1 : live.isGhost ? 2 : 0) : Number(account.is_dead) || 0,
    location: live?.location?.position
      ? {
          map: normMap(live.location.map),
          x: Math.round(Number(live.location.position.x) || 0),
          y: Math.round(Number(live.location.position.y) || 0),
          direction: live.location.position.direction || "down",
        }
      : { map: normMap(account.map), x: Number(x || 0), y: Number(y || 0), direction: account.direction || "down" },
    stats: {
      level: Number(vitals.level) || 1,
      xp: Number(vitals.xp) || 0,
      max_xp: Number(vitals.max_xp) || 0,
      health: Number(vitals.health) || 0,
      max_health: Number(vitals.max_health) || 0,
      stamina: Number(vitals.stamina) || 0,
      max_stamina: Number(vitals.max_stamina) || 0,
      stat_damage: Number(stats.stat_damage) || 0,
      stat_armor: Number(stats.stat_armor) || 0,
      stat_critical_chance: Number(stats.stat_critical_chance) || 0,
      stat_critical_damage: Number(stats.stat_critical_damage) || 0,
      stat_avoidance: Number(stats.stat_avoidance) || 0,
    },
    totals: live?.stats
      ? {
          max_health: Number(live.stats.total_max_health) || 0,
          max_stamina: Number(live.stats.total_max_stamina) || 0,
          stat_damage: Number(live.stats.stat_damage) || 0,
          stat_armor: Number(live.stats.stat_armor) || 0,
          stat_critical_chance: Number(live.stats.stat_critical_chance) || 0,
          stat_critical_damage: Number(live.stats.stat_critical_damage) || 0,
          stat_avoidance: Number(live.stats.stat_avoidance) || 0,
        }
      : null,
    currency: { copper: balance.copper || 0, silver: balance.silver || 0, gold: balance.gold || 0 },
    inventory: (rows || []).map((row: any) => ({
      name: String(row.name ?? row.item),
      quantity: Number(row.quantity) || 0,
      equipped: !!Number(row.equipped),
      quality: row.quality ?? null,
      type: row.type ?? null,
      icon: typeof row.icon === "string" ? row.icon : null,
      equipment_slot: row.equipment_slot ?? null,
      level_requirement: row.level_requirement ?? null,
      known: known.has(lower(row.name ?? row.item)),
    })),
    inventorySlots: slots,
    equipment: Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => [slot, worn?.[slot] || null])),
    bags: Object.fromEntries(bags.SLOTS.map((slot) => [slot, bagRow?.[slot] || null])),
    collectables: owned,
    spells: learned,
    friends: friendList,
    guild,
    party,
    quests: {
      active: quests.active.map((entry) => {
        const quest = questDefinitions.find(entry.quest_id);
        return {
          id: entry.quest_id,
          name: quest?.name || `Quest #${entry.quest_id}`,
          state: entry.state,
          objectives: (quest?.objectives || []).map((o) => ({
            id: o.id,
            label: o.description || `${o.type} ${o.target}`,
            count: Number(entry.progress[o.id]) || 0,
            required: o.required_count,
          })),
        };
      }),
      completed: quests.completed.map((id) => ({ id, name: questDefinitions.find(id)?.name || `Quest #${id}` })),
    },
    permissions: held,
  };
}

// ------------------------------------------------------------------ search

function isSlot(slot: unknown): slot is (typeof EQUIPMENT_SLOTS)[number] {
  return typeof slot === "string" && (EQUIPMENT_SLOTS as readonly string[]).includes(slot);
}

export type EditorSearch =
  | { kind: "players"; query: string; players: Array<{ username: string; userid: number; online: boolean }>; truncated: number }
  | { kind: "items"; query: string; slot: string | null; items: Array<Pick<Item, "name" | "quality" | "type" | "icon" | "equipment_slot" | "level_requirement">>; truncated: number };

/**
 * Player search lists who is online until something is typed, then matches
 * every account. Item search matches names, or with `slot` what fits that slot.
 */
export async function search(data: any): Promise<EditorSearch> {
  const query = String(data?.query ?? "").trim().toLowerCase().slice(0, 64);

  if (data?.kind === "items") {
    const slot = isSlot(data?.slot) ? data.slot : null;
    const all = await cached<Item>("items");
    const matches = !query && !slot
      ? []
      : all
          .filter((i) => (!slot || lower(i.equipment_slot) === slot) && lower(i.name).includes(query))
          .sort((a, b) => {
            // Names that start with the query are what the user usually means.
            const aStarts = lower(a.name).startsWith(query);
            const bStarts = lower(b.name).startsWith(query);
            if (aStarts !== bStarts) return aStarts ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
    return {
      kind: "items",
      query,
      slot,
      items: matches.slice(0, SEARCH_LIMIT).map((i) => ({
        name: i.name,
        quality: i.quality,
        type: i.type,
        icon: i.icon,
        equipment_slot: i.equipment_slot,
        level_requirement: i.level_requirement,
      })),
      truncated: Math.max(0, matches.length - SEARCH_LIMIT),
    };
  }

  const online = new Map<string, number>();
  for (const p of Object.values(playerCache.list() as Record<string, any>)) {
    if (p?.username) online.set(lower(p.username), Number(p.userid) || 0);
  }
  let players: Array<{ username: string; userid: number; online: boolean }>;
  if (!query) {
    players = [...online].map(([username, userid]) => ({ username, userid, online: true }));
  } else {
    const clean = query.replace(/[^a-z0-9_]/g, "");
    const rows = clean ? await player.searchAccounts(clean, SEARCH_LIMIT + 1) : [];
    players = rows.map((row) => ({ username: lower(row.username), userid: Number(row.id), online: online.has(lower(row.username)) }));
  }
  players.sort((a, b) => a.username.localeCompare(b.username));
  return { kind: "players", query, players: players.slice(0, SEARCH_LIMIT), truncated: Math.max(0, players.length - SEARCH_LIMIT) };
}

// ------------------------------------------------------------------- stats

/**
 * [label, min, max] of each stat that can be set. max_xp is not one: it
 * follows the level, whose own maximum is maxLevel().
 */
const STAT_FIELDS: Record<string, [string, number, number]> = {
  level: ["Level", 1, INT_MAX],
  xp: ["XP", 0, INT_MAX],
  health: ["Health", 1, VALUE_MAX],
  max_health: ["Max health", 1, VALUE_MAX],
  stamina: ["Mana", 0, VALUE_MAX],
  max_stamina: ["Max mana", 1, VALUE_MAX],
  stat_damage: ["Damage", 0, VALUE_MAX],
  stat_armor: ["Armor", 0, VALUE_MAX],
  stat_critical_chance: ["Critical chance", 0, VALUE_MAX],
  stat_critical_damage: ["Critical damage", 0, VALUE_MAX],
  stat_avoidance: ["Avoidance", 0, VALUE_MAX],
};
const VITALS = ["level", "xp", "max_xp", "health", "max_health", "stamina", "max_stamina"] as const;
const BASE_STATS = ["stat_damage", "stat_armor", "stat_critical_chance", "stat_critical_damage", "stat_avoidance"] as const;

/** Dead players sit at 0 health until revived; their stats and position belong to the death flow. */
async function isDead(username: string): Promise<boolean> {
  const live = findOnline(username);
  if (live) return !!(live.isDead || live.isGhost);
  const account = await player.findAccount(username);
  return (Number(account?.is_dead) || 0) !== 0;
}

/** Health and mana the worn items add on top of the base maximums. */
async function gearBonus(username: string): Promise<{ health: number; stamina: number }> {
  const [worn, items] = await Promise.all([equipment.list(username), cached<Item>("items")]);
  const bonus = { health: 0, stamina: 0 };
  for (const slot of EQUIPMENT_SLOTS) {
    const name = worn?.[slot];
    if (!name) continue;
    const item = items.find((i) => lower(i.name) === lower(name));
    bonus.health += Number(item?.stat_health) || 0;
    bonus.stamina += Number(item?.stat_stamina) || 0;
  }
  return bonus;
}

/** Recompute a live player's totals (base + equipment) and tell every client that shows them. */
async function pushStats(live: any): Promise<void> {
  const synced = await player.synchronizeStats(live.username);
  if (synced) {
    // A total may have dropped below what the player had: nothing sits above its maximum.
    synced.health = Math.min(synced.health, synced.total_max_health);
    synced.stamina = Math.min(synced.stamina, synced.total_max_stamina);
    live.stats = synced;
  }
  send(live.wt, packetManager.updateStats({ id: live.id, target: live.id, stats: live.stats }));
  // The XP bar has its own packet.
  send(live.wt, packetManager.updateXp({ id: live.id, xp: live.stats.xp, level: live.stats.level, max_xp: live.stats.max_xp }));
  await bridge?.broadcastStats(live);
}

async function setStats({ username, data }: ActionContext): Promise<string[]> {
  const input = data?.stats;
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["No stats were given."];
  const base = (await player.getStats(username)) as any;
  if (!base || Array.isArray(base)) return ["That player has no stats to edit."];
  if (await isDead(username)) return [DEAD];

  // An online player's vitals live in the cache until the next save.
  const live = findOnline(username);
  const next: Record<string, number> = {};
  for (const key of VITALS) next[key] = Number((live?.stats ?? base)[key]) || 0;
  for (const key of BASE_STATS) next[key] = Number(base[key]) || 0;
  const before = { ...next };

  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    const field = Object.hasOwn(STAT_FIELDS, key) ? STAT_FIELDS[key] : null;
    if (!field) {
      errors.push(`Unknown stat: ${key}.`);
      continue;
    }
    const [label, min] = field;
    const max = key === "level" ? maxLevel() : field[2];
    const value = wholeNumber(input[key], min, max);
    if (value === null) errors.push(`${label} must be a whole number from ${min} to ${max}.`);
    else next[key] = value;
  }
  if (errors.length) return errors;

  // The XP a level needs and its base maximums follow the level, as on a level-up.
  if (next.level !== before.level) {
    next.max_xp = player.getNewMaxXp(next.level);
    if (!("max_health" in input)) next.max_health = player.getMaxHealthForLevel(next.level);
    if (!("max_stamina" in input)) next.max_stamina = player.getMaxStaminaForLevel(next.level);
  }
  const bonus = await gearBonus(username);
  const maxHealth = next.max_health + bonus.health;
  const maxStamina = next.max_stamina + bonus.stamina;
  if ("xp" in input && next.xp >= next.max_xp) errors.push(`XP must be below ${next.max_xp}, what level ${next.level} needs.`);
  if ("health" in input && next.health > maxHealth) errors.push(`Health cannot be above the maximum of ${maxHealth}.`);
  if ("stamina" in input && next.stamina > maxStamina) errors.push(`Mana cannot be above the maximum of ${maxStamina}.`);
  if (errors.length) return errors;
  // Values that were not sent still have to fit under what was.
  next.xp = Math.max(0, Math.min(next.xp, next.max_xp - 1));
  next.health = Math.max(1, Math.min(next.health, maxHealth));
  next.stamina = Math.min(next.stamina, maxStamina);

  await player.setBaseStats(username, next as unknown as StatsData);

  const online = findOnline(username);
  if (online?.stats) {
    // Only what changed: health and mana keep moving while the player is in a fight.
    for (const key of VITALS) {
      if (next[key] !== before[key]) online.stats[key] = next[key];
    }
    await pushStats(online);
    if (next.level !== before.level) {
      // Quest availability is level-gated, in both directions.
      if (next.level > before.level) listener.emit(Events.PLAYER_LEVEL_UP, { player: online, level: next.level });
      await pushQuestMarkers(online);
    }
  }
  return [];
}

// ---------------------------------------------------------------- currency

async function setCurrency({ username, data }: ActionContext): Promise<string[]> {
  const errors: string[] = [];
  const balance: Currency = { copper: 0, silver: 0, gold: 0 };
  for (const coin of ["gold", "silver", "copper"] as const) {
    const value = wholeNumber(data?.[coin], 0, CURRENCY_LIMITS[coin]);
    if (value === null) errors.push(`${coin.charAt(0).toUpperCase()}${coin.slice(1)} must be a whole number from 0 to ${CURRENCY_LIMITS[coin]}.`);
    else balance[coin] = value;
  }
  if (errors.length) return errors;

  await currency.set(username, balance);
  const live = findOnline(username);
  if (live) {
    live.currency = balance;
    send(live.wt, packetManager.currency(balance));
  }
  return [];
}

// --------------------------------------------------------------- inventory

async function findItem(name: unknown): Promise<Item | null> {
  const wanted = lower(name).trim();
  if (!wanted) return null;
  return (await cached<Item>("items")).find((i) => lower(i.name) === wanted) || null;
}

/** How many of an item are worn or serving as a bag: that many must stay in the inventory. */
async function inUse(username: string, itemName: string): Promise<number> {
  const [worn, bagRow] = await Promise.all([equipment.list(username), bags.get(username)]);
  const wanted = lower(itemName);
  let count = 0;
  for (const slot of EQUIPMENT_SLOTS) if (lower(worn?.[slot]) === wanted) count++;
  for (const slot of bags.SLOTS) if (lower(bagRow?.[slot]) === wanted) count++;
  return count;
}

/**
 * Bring a stack to the size `target` returns for what is held now (a string
 * is an error), through the inventory system's own add and remove.
 */
async function adjustInventory(username: string, rawName: unknown, target: (held: number) => number | string): Promise<string[]> {
  const rows = (await inventory.get(username)) as any[];
  const wanted = lower(rawName).trim();
  const row = wanted ? rows.find((r) => lower(r.name) === wanted) : null;
  const item = await findItem(rawName);
  if (!row && !item) return ["That item does not exist."];
  const name: string = item?.name ?? row.name;
  const held = Number(row?.quantity) || 0;

  const quantity = target(held);
  if (typeof quantity === "string") return [quantity];
  if (quantity === held) return [];

  if (quantity > held) {
    if (!item) return [`${name} no longer exists as an item: it can only be removed.`];
    if (!row && rows.length >= (await bags.capacity(username))) return ["The inventory is full."];
    await inventory.add(username, { name, quantity: quantity - held });
  } else {
    if (quantity < (await inUse(username, name))) return [`${name} is equipped: unequip it before removing it.`];
    if (item) await inventory.remove(username, { name, quantity: held - quantity });
    else if (quantity === 0) await inventory.delete(username, { name, quantity: 0 });
    else return [`${name} no longer exists as an item: it can only be removed whole.`];
  }

  const live = findOnline(username);
  if (live) {
    await bridge?.syncInventory(live);
    // Collect objectives count what the inventory holds.
    await pushQuestLog(live);
  }
  return [];
}

async function addItem({ username, data }: ActionContext): Promise<string[]> {
  const quantity = wholeNumber(data?.quantity, 1, VALUE_MAX);
  if (quantity === null) return [`Quantity must be a whole number from 1 to ${VALUE_MAX}.`];
  return adjustInventory(username, data?.item, (held) =>
    held + quantity > VALUE_MAX ? `A stack holds at most ${VALUE_MAX}.` : held + quantity
  );
}

async function removeItem({ username, data }: ActionContext): Promise<string[]> {
  // No quantity removes the whole stack.
  const all = data?.quantity === undefined || data?.quantity === null;
  const quantity = all ? 0 : wholeNumber(data.quantity, 1, VALUE_MAX);
  if (quantity === null) return [`Quantity must be a whole number from 1 to ${VALUE_MAX}.`];
  return adjustInventory(username, data?.item, (held) => {
    if (held === 0) return "The player does not have that item.";
    return all ? 0 : Math.max(0, held - quantity);
  });
}

async function setItemQuantity({ username, data }: ActionContext): Promise<string[]> {
  const quantity = wholeNumber(data?.quantity, 0, VALUE_MAX);
  if (quantity === null) return [`Quantity must be a whole number from 0 to ${VALUE_MAX}.`];
  return adjustInventory(username, data?.item, () => quantity);
}

// --------------------------------------------------------------- equipment

/** A worn item changed: the live copy, its stat totals, both lists and the sprite. */
async function pushEquipment(live: any, slot: string, item: string | null): Promise<void> {
  if (!live.equipment) live.equipment = {};
  live.equipment[slot] = item;
  // The inventory first: stat totals are worked out from its rows.
  await bridge?.syncInventory(live);
  await pushStats(live);
  send(live.wt, packetManager.equipment(live.equipment));
  live.equipmentRevision = (live.equipmentRevision || 0) + 1;
  await bridge?.refreshAppearance(live);
}

async function equipItem({ username, data }: ActionContext): Promise<string[]> {
  const slot = data?.slot;
  if (!isSlot(slot)) return ["That is not an equipment slot."];
  const item = await findItem(data?.item);
  if (!item) return ["That item does not exist."];
  if (lower(item.equipment_slot) !== slot) return [`${item.name} does not go in the ${slot} slot.`];
  const worn = await equipment.list(username);
  if (!worn) return ["That player has no equipment to edit."];
  if (lower(worn[slot]) === lower(item.name)) return [`${item.name} is already equipped.`];

  // A worn item is an inventory row flagged as equipped, so it has to be owned first.
  const rows = (await inventory.get(username)) as any[];
  if (!rows.some((r) => lower(r.name) === lower(item.name))) {
    if (rows.length >= (await bags.capacity(username))) return ["The inventory is full."];
    await inventory.add(username, { name: item.name, quantity: 1 });
  }
  if ((await equipment.equipItem(username, slot, item.name)) !== true) return [`Could not equip ${item.name}.`];

  const live = findOnline(username);
  if (live) {
    await pushEquipment(live, slot, item.name);
    listener.emit(Events.ITEM_EQUIP, { player: live, item, slot });
  }
  return [];
}

async function unequipItem({ username, data }: ActionContext): Promise<string[]> {
  const slot = data?.slot;
  if (!isSlot(slot)) return ["That is not an equipment slot."];
  const current = (await equipment.list(username))?.[slot];
  if (!current) return ["Nothing is equipped in that slot."];
  if ((await equipment.unEquipItem(username, slot, current)) !== true) return ["Could not unequip that item."];

  const live = findOnline(username);
  if (live) {
    await pushEquipment(live, slot, null);
    listener.emit(Events.ITEM_UNEQUIP, { player: live, slot });
  }
  return [];
}

// ------------------------------------------------------------- collections

async function pushCollectables(username: string): Promise<void> {
  const live = findOnline(username);
  if (!live) return;
  // As at login: a mount that no longer exists is not handed to the client.
  live.collectables = (await ownedCollectables(username))
    .filter((c) => c.known)
    .map((c) => ({ type: c.type, item: c.item, icon: c.icon }));
  bridge?.sendCollectables(live);
}

async function addCollectable({ username, data }: ActionContext): Promise<string[]> {
  const type = lower(data?.type).trim();
  if (!COLLECTABLE_TYPES.includes(type)) return ["That kind of collectable cannot be given from here."];
  const wanted = lower(data?.item).trim();
  const mount = wanted ? (await cached<Mount>("mounts")).find((m) => lower(m.name) === wanted) : null;
  if (!mount) return ["That mount does not exist."];
  if (await collectables.find({ type, item: mount.name, username, icon: null })) return [`The player already has ${mount.name}.`];

  await collectables.add({ type, item: mount.name, username, icon: null });
  await pushCollectables(username);
  return [];
}

async function removeCollectable({ username, data }: ActionContext): Promise<string[]> {
  const owned = (await collectables.list(username)) || [];
  const row = owned.find((c: any) => lower(c.type) === lower(data?.type) && lower(c.item) === lower(data?.item));
  if (!row) return ["The player does not have that collectable."];
  const live = findOnline(username);
  if (live?.mounted && row.type === "mount" && lower(live.mount_type) === lower(row.item)) {
    return ["The player is riding that mount: it can be removed once they dismount."];
  }

  await collectables.remove({ type: row.type, item: row.item, username, icon: null });
  await pushCollectables(username);
  return [];
}

async function pushSpells(username: string): Promise<void> {
  const live = findOnline(username);
  if (!live) return;
  live.learnedSpells = await spells.learnedDetails(username);
  bridge?.sendSpells(live);
}

async function learnSpell({ username, data }: ActionContext): Promise<string[]> {
  const wanted = lower(data?.spell).trim();
  const spell = wanted ? (await cached<SpellData>("spells")).find((s) => lower(s.name) === wanted) : null;
  if (!spell) return ["That spell does not exist."];
  if ((await spells.listLearned(username)).includes(spell.name)) return [`The player already knows ${spell.name}.`];

  await spells.learnSpell(username, spell.name);
  await pushSpells(username);
  return [];
}

async function unlearnSpell({ username, data }: ActionContext): Promise<string[]> {
  const wanted = lower(data?.spell).trim();
  const name = wanted ? (await spells.listLearned(username)).find((s) => lower(s) === wanted) : null;
  if (!name) return ["The player has not learned that spell."];

  await spells.unlearnSpell(username, name);
  await pushSpells(username);
  return [];
}

// ----------------------------------------------------------------- friends

function pushFriends(username: string, list: string[]): void {
  const live = findOnline(username);
  if (!live) return;
  live.friends = list;
  send(live.wt, packetManager.updateFriends({ friends: list }));
}

async function addFriend({ username, data }: ActionContext): Promise<string[]> {
  const other = await resolveTarget(data?.username);
  if (!other) return ["That player does not exist."];
  if (other.username === username) return ["A player cannot be their own friend."];
  if ((await friends.list(username)).includes(other.username)) return [`${other.username} is already their friend.`];

  // Friendship is mutual everywhere else: each list gets the other name.
  pushFriends(username, await friends.add(username, other.username));
  pushFriends(other.username, await friends.add(other.username, username));
  const [mine, theirs] = [findOnline(username), findOnline(other.username)];
  if (mine && theirs) {
    send(mine.wt, packetManager.updateOnlineStatus({ online: true, username: theirs.username }));
    send(theirs.wt, packetManager.updateOnlineStatus({ online: true, username: mine.username }));
  }
  listener.emit(Events.FRIEND_ADDED, { type: "add", playerUsername: username, friendUsername: other.username });
  return [];
}

async function removeFriend({ username, data }: ActionContext): Promise<string[]> {
  const wanted = lower(data?.username).trim();
  const friend = wanted ? (await friends.list(username)).find((f: string) => lower(f) === wanted) : null;
  if (!friend) return ["That player is not their friend."];

  await friends.remove(username, friend);
  // The friends system only removes names that still have an account.
  const mine = await friends.list(username);
  if (mine.includes(friend)) return [`Could not remove ${friend}: that account no longer exists.`];
  pushFriends(username, mine);
  pushFriends(friend, await friends.remove(friend, username));
  listener.emit(Events.FRIEND_REMOVED, { type: "remove", playerUsername: username, friendUsername: friend });
  return [];
}

// ------------------------------------------------------------------- guild

/** Tell a guild's online members who is in it now. */
function pushGuildMembers(members: string[], guildId: number, guildName: string): void {
  for (const member of members) {
    const live = findOnline(member);
    if (!live) continue;
    live.guild_id = guildId;
    live.guild = members;
    live.guild_name = guildName;
    send(live.wt, packetManager.updateGuild({ members, guild_name: guildName }));
  }
}

function clearGuild(username: string, message: string): void {
  const live = findOnline(username);
  if (!live) return;
  live.guild_id = null;
  live.guild = [];
  live.guild_name = null;
  send(live.wt, packetManager.updateGuild({ members: [] }));
  send(live.wt, packetManager.notify({ message }));
  bridge?.announce(live);
}

async function joinGuild({ username, data }: ActionContext): Promise<string[]> {
  const wanted = lower(data?.guild).trim();
  const guild = wanted ? (await guilds.list()).find((g) => lower(g.name) === wanted) : null;
  if (!guild) return ["That guild does not exist."];
  if (await player.isGuest(username)) return ["Guests cannot join a guild."];
  if (await guilds.isInGuild(username)) return ["The player is already in a guild: remove them from it first."];

  const members = await guilds.add(username, guild.id);
  if (members.length === 0) return ["Could not add the player to that guild; it may be full."];
  pushGuildMembers(members, guild.id, guild.name);
  const live = findOnline(username);
  if (live) {
    send(live.wt, packetManager.notify({ message: `You have joined "${guild.name}"` }));
    bridge?.announce(live);
  }
  listener.emit(Events.GUILD_CHANGED, { type: "join", guildId: guild.id, guildName: guild.name, playerUsername: username });
  return [];
}

async function leaveGuild({ admin, username }: ActionContext): Promise<string[]> {
  const guild = await guildOf(username);
  if (!guild) return ["The player is not in a guild."];
  if (lower(guild.leader) === username) return ["The player leads that guild: make someone else the leader, or disband it."];

  const result = await guilds.remove(username);
  if (!Array.isArray(result)) return ["Could not remove the player from the guild."];
  clearGuild(username, "You have been removed from the guild");
  pushGuildMembers(result.filter(Boolean), guild.id, guild.name);
  listener.emit(Events.GUILD_CHANGED, { type: "kick", guildId: guild.id, guildName: guild.name, playerUsername: admin.username, kickedUsername: username });
  return [];
}

async function leadGuild({ username }: ActionContext): Promise<string[]> {
  const guild = await guildOf(username);
  if (!guild) return ["The player is not in a guild."];
  if (lower(guild.leader) === username) return ["The player already leads that guild."];

  const members = await guilds.setLeader(guild.id, username);
  if (members.length === 0) return ["Could not change the guild's leader."];
  pushGuildMembers(members, guild.id, guild.name);
  return [];
}

async function disbandGuild({ username }: ActionContext): Promise<string[]> {
  const guild = await guildOf(username);
  if (!guild) return ["The player is not in a guild."];
  if (lower(guild.leader) !== username) return ["Only the guild's leader can have it disbanded from here."];

  if (!(await guilds.disband(username))) return ["Could not disband the guild."];
  for (const member of guild.members) clearGuild(member, "The guild has been disbanded");
  listener.emit(Events.GUILD_CHANGED, { type: "disband", guildId: guild.id, guildName: guild.name, playerUsername: username });
  return [];
}

// ------------------------------------------------------------------- party

/** Give the online players in `usernames` their party as it now stands. */
function pushParty(usernames: string[], partyId: number | null, members: string[], message?: string): void {
  for (const member of usernames) {
    const live = findOnline(member);
    if (!live) continue;
    live.party_id = partyId;
    live.party = members;
    send(live.wt, packetManager.updateParty({ members }));
    if (message) send(live.wt, packetManager.notify({ message }));
  }
}

async function joinParty({ username, data }: ActionContext): Promise<string[]> {
  const other = await resolveTarget(data?.username);
  if (!other) return ["That player does not exist."];
  if (other.username === username) return ["Pick another player: a party needs two."];
  if (await parties.isInParty(username)) return ["The player is already in a party: remove them from it first."];

  // The other player's party when they have one; otherwise a new one that they lead.
  const existing = await parties.getPartyId(other.username);
  const members = existing ? await parties.add(username, existing) : await parties.create(other.username, username);
  if (!Array.isArray(members) || members.length === 0) return ["Could not add the player to that party; it may be full."];

  const partyId = await parties.getPartyId(username);
  const leader = (partyId && (await parties.getPartyLeader(partyId))) || other.username;
  pushParty(members, partyId, members);
  await bridge?.syncPartyLayers(leader, members);
  listener.emit(Events.PARTY_CHANGED, { type: "join", username, members });
  return [];
}

async function leaveParty({ admin, username }: ActionContext): Promise<string[]> {
  const party = await partyOf(username);
  if (!party) return ["The player is not in a party."];

  const result = await parties.leave(username);
  // An empty list is the party system's answer when nobody was removed.
  if (result === false || (Array.isArray(result) && result.length === 0)) return ["Could not remove the player from the party."];
  if (result === true) {
    // The party went with them: it was theirs, or too few were left.
    pushParty(party.members, null, [], "The party has been disbanded");
    listener.emit(Events.PARTY_CHANGED, { type: "disband", members: party.members });
    return [];
  }
  pushParty([username], null, [], "You have been removed from the party");
  pushParty(result, party.id, result);
  await bridge?.syncPartyLayers(party.leader, result);
  listener.emit(Events.PARTY_CHANGED, { type: "kick", username: admin.username, kickedUsername: username, members: [username] });
  return [];
}

// ------------------------------------------------------------------ quests

async function pushQuestMarkers(live: any): Promise<void> {
  try {
    const map = normMap(live.location?.map);
    send(live.wt, packetManager.questMarkers({ map, markers: await markersFor(live.username, map) }));
  } catch {
    // Markers are best-effort.
  }
}

/** The whole log with its definitions, as at login, then the markers that depend on it. */
async function pushQuestLog(live: any): Promise<void> {
  const data = questLog.getCachedLog(live.username) || (await questLog.load(live.username));
  const definitions: Quest[] = [];
  for (const id of new Set([...data.active.map((e) => e.quest_id), ...data.completed])) {
    const quest = questDefinitions.find(id);
    if (quest) definitions.push(quest);
  }
  send(live.wt, packetManager.questLog({ active: data.active, completed: data.completed, definitions }));
  await pushQuestMarkers(live);
}

async function questAction({ username, data }: ActionContext, apply: (quest: Quest, log: QuestLogData) => Promise<string | null>): Promise<string[]> {
  const id = wholeNumber(data?.questId, 1, INT_MAX);
  const quest = id === null ? undefined : questDefinitions.find(id);
  if (!quest) return ["That quest does not exist."];
  const current = questLog.getCachedLog(username) || (await questLog.load(username));

  const error = await apply(quest, current);
  if (error) return [error];
  const live = findOnline(username);
  if (live) await pushQuestLog(live);
  return [];
}

const acceptQuest = (ctx: ActionContext) =>
  questAction(ctx, async (quest) => {
    const result = await questLog.forceAccept(ctx.username, quest.id);
    return result.ok ? null : result.error || "Could not start that quest.";
  });

const abandonQuest = (ctx: ActionContext) =>
  questAction(ctx, async (quest, current) => {
    if (!current.active.some((e) => e.quest_id === quest.id)) return "That quest is not in the player's log.";
    await questLog.abandon(ctx.username, quest.id);
    // abandon() answers nothing: whether it was written is what the rows now say.
    const left = (await rowsOf(ctx.username)).log.some((row) => Number(row.quest_id) === quest.id && row.state !== "completed");
    return left ? "Could not abandon that quest." : null;
  });

const completeQuest = (ctx: ActionContext) =>
  questAction(ctx, async (quest) => {
    const result = await questLog.forceComplete(ctx.username, quest.id);
    return result.ok ? null : result.error || "Could not complete that quest.";
  });

const forgetQuest = (ctx: ActionContext) =>
  questAction(ctx, async (quest, current) => {
    if (!current.active.some((e) => e.quest_id === quest.id) && !current.completed.includes(quest.id)) {
      return "The player has no record of that quest.";
    }
    await questLog.forget(ctx.username, quest.id);
    const left = (await rowsOf(ctx.username)).log.some((row) => Number(row.quest_id) === quest.id);
    return left ? "Could not forget that quest." : null;
  });

// ------------------------------------------------------------------ access

/**
 * The /permission command's rules, so the editor is no way round them: never
 * your own, adding and removing each need their own permission, and you can
 * only hand out what you hold.
 */
async function setPermissions({ admin, username, data }: ActionContext): Promise<string[]> {
  if (lower(admin.username) === username) return ["You cannot modify your own permissions."];
  if (!Array.isArray(data?.permissions)) return ["No permissions were given."];
  const next = [...new Set((data.permissions as unknown[]).map((p) => String(p).trim()))];

  const valid = await permissions.list();
  const invalid = next.filter((p) => !valid.includes(p));
  if (invalid.length) return invalid.map((p) => `Invalid permission: ${p}`);
  // The permissions column is 255 characters wide.
  if (next.join(",").length > 255) return ["That is more permissions than one player can hold."];

  const current = await heldPermissions(username);
  const added = next.filter((p) => !current.includes(p));
  const removed = current.filter((p) => !next.includes(p));
  if (added.length === 0 && removed.length === 0) return [];

  const held = await heldPermissions(admin.username);
  const holds = (...names: string[]) => held.some((p) => names.includes(p));
  if (added.length && !holds("permission.add", "permission.*")) return ["You need permission.add to give permissions."];
  if (removed.length && !holds("permission.remove", "permission.*")) return ["You need permission.remove to take permissions away."];
  const beyond = added.filter((p) => !holds(p, "permission.*", "server.*"));
  if (beyond.length) return beyond.map((p) => `You cannot grant the ${p} permission.`);

  if (next.length) await permissions.set(username, next);
  else await permissions.clear(username);
  const live = findOnline(username);
  if (live) live.permissions = next;
  log.info(`[PERMISSION_AUDIT] ${admin.username} (${admin.id}) set permissions to [${next.join(", ")}] for ${username}`);
  return [];
}

async function setAdmin({ admin, username, data }: ActionContext): Promise<string[]> {
  if (lower(admin.username) === username) return ["You cannot toggle your own admin status."];
  if (typeof data?.value !== "boolean") return ["Admin must be on or off."];
  if ((await player.isAdmin(username)) === data.value) return [];

  const isAdmin = !!(await player.toggleAdmin(username));
  const live = findOnline(username);
  if (live) {
    live.isAdmin = isAdmin;
    if (!isAdmin) {
      // toggleAdmin clears these with the role.
      live.isStealth = false;
      live.isNoclip = false;
    }
    // As /admin does: the client reloads to pick up its new role.
    send(live.wt, packetManager.reconnect());
  }
  return [];
}

// ---------------------------------------------------------------- location

async function setLocation({ username, data }: ActionContext): Promise<string[]> {
  const wanted = normMap(data?.map).trim();
  const map = wanted ? (await cached<MapProperties>("mapProperties")).find((m) => normMap(m.name) === wanted) : null;
  if (!map) return ["That map does not exist."];

  // Positions are pixels from the map's top left corner.
  const width = (Number(map.width) || 0) * (Number(map.tileWidth) || 0) || VALUE_MAX;
  const height = (Number(map.height) || 0) * (Number(map.tileHeight) || 0) || VALUE_MAX;
  const x = wholeNumber(data?.x, 0, width);
  const y = wholeNumber(data?.y, 0, height);
  const direction = data?.direction ?? "down";
  const errors: string[] = [];
  if (x === null) errors.push(`X must be a whole number from 0 to ${width}.`);
  if (y === null) errors.push(`Y must be a whole number from 0 to ${height}.`);
  if (!DIRECTIONS.includes(direction)) errors.push("That is not a direction.");
  if (x === null || y === null || errors.length) return errors;
  if (await isDead(username)) return [DEAD];

  const live = findOnline(username);
  if (!live) {
    await player.setLocationByUsername(username, normMap(map.name), { x, y, direction });
    return [];
  }
  if (!bridge) return ["Online players cannot be moved right now."];
  await bridge.relocate(live, normMap(map.name), x, y, direction);
  return [];
}

// ---------------------------------------------------------------- dispatch

interface ActionContext {
  /** The admin making the change. */
  admin: any;
  /** The player being changed: their username as the accounts table holds it. */
  username: string;
  data: any;
}

/** Each returns what was wrong with the request; an empty list means the change was made. */
const ACTIONS: Record<string, (ctx: ActionContext) => Promise<string[]>> = {
  "stats.set": setStats,
  "currency.set": setCurrency,
  "inventory.add": addItem,
  "inventory.remove": removeItem,
  "inventory.set": setItemQuantity,
  "equipment.equip": equipItem,
  "equipment.unequip": unequipItem,
  "collectable.add": addCollectable,
  "collectable.remove": removeCollectable,
  "spell.learn": learnSpell,
  "spell.unlearn": unlearnSpell,
  "friend.add": addFriend,
  "friend.remove": removeFriend,
  "guild.join": joinGuild,
  "guild.leave": leaveGuild,
  "guild.lead": leadGuild,
  "guild.disband": disbandGuild,
  "party.join": joinParty,
  "party.leave": leaveParty,
  "quest.accept": acceptQuest,
  "quest.abandon": abandonQuest,
  "quest.complete": completeQuest,
  "quest.forget": forgetQuest,
  "permissions.set": setPermissions,
  "admin.set": setAdmin,
  "location.set": setLocation,
};

export type EditorResult =
  | { kind: "data"; data: { options: PlayerEditorOptions; snapshot: PlayerEditorSnapshot } }
  | { kind: "search"; data: EditorSearch }
  | { kind: "result"; ok: boolean; errors: string[]; action: string; snapshot: PlayerEditorSnapshot | null; denied?: boolean };

/**
 * Dispatch for every PLAYER_EDITOR_* packet. Permission is checked here, on
 * every packet, so no caller can reach a change without it.
 */
export async function handleEditorPacket(admin: any, type: string, data: any): Promise<EditorResult> {
  const action = type === "PLAYER_EDITOR_ACTION" ? String(data?.action ?? "") : type === "PLAYER_EDITOR_SEARCH" ? "search" : "load";
  const fail = (errors: string[], snapshot: PlayerEditorSnapshot | null = null): EditorResult =>
    ({ kind: "result", ok: false, errors, action, snapshot });

  if (!(await canUseEditor(admin))) {
    log.warn(`[PLAYER_EDITOR] ${admin?.username} was refused ${action}`);
    return { kind: "result", ok: false, errors: [DENIED], action, snapshot: null, denied: true };
  }

  if (type === "PLAYER_EDITOR_SEARCH") return { kind: "search", data: await search(data) };
  if (type !== "PLAYER_EDITOR_LOAD" && type !== "PLAYER_EDITOR_ACTION") {
    return fail([`Unknown player editor action: ${type}`]);
  }

  const target = await resolveTarget(data?.target);
  if (!target) return fail(["Player not found."]);

  if (type === "PLAYER_EDITOR_LOAD") {
    const snapshot = await buildSnapshot(target.username);
    if (!snapshot) return fail(["Player not found."]);
    return { kind: "data", data: { options: await buildOptions(admin), snapshot } };
  }

  const handler = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!handler) return fail([`Unknown player editor action: ${action}`]);

  return oneAtATime<EditorResult>(target.username, async () => {
    let errors: string[];
    try {
      errors = await handler({ admin, username: target.username, data });
    } catch (error) {
      log.error(`[PLAYER_EDITOR] ${action} on ${target.username} failed: ${error}`);
      errors = ["The change failed on the server."];
    }
    if (errors.length === 0) {
      const details = { ...data };
      delete details.target;
      delete details.action;
      log.info(`[PLAYER_EDITOR] ${admin.username} (${admin.id}) applied ${action} to ${target.username}: ${JSON.stringify(details).slice(0, 300)}`);
    }
    // The fresh state either way: after a refusal the editor still shows what the server has.
    return { kind: "result", ok: errors.length === 0, errors, action, snapshot: await buildSnapshot(target.username) };
  });
}

/**
 * Changes to one player run one after the other. The handlers check, then write ("already has that mount?", then the
 * insert; "is admin?", then the toggle), and two packets for the same player used to run side by side: both passed
 * the check before either wrote, so a doubled request gave the player the mount or spell twice (those tables have no
 * unique key) and flipped the admin role on and straight back off. Two admins editing one player are ordered too.
 * The control panel orders its own changes through here as well, so the two windows cannot cross on one player.
 */
export const oneAtATime = turns();
