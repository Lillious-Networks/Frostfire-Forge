// Item links in chat: a `[Item Name]` in a chat line that names a real item is
// sent to the client with that item's tooltip data, so the client can show the
// line's token as a link. Pure: the item list comes in as an argument, so this
// never reads the database or a cache itself.

/** The most links one chat line carries. */
export const MAX_ITEM_LINKS = 5;

/** The item fields a link carries: what the client's item tooltip shows, and nothing private. */
export const LINK_FIELDS = [
  "name", "quality", "type", "equipment_slot", "level_requirement",
  "stat_damage", "stat_armor", "stat_health", "stat_stamina",
  "stat_critical_chance", "stat_critical_damage", "stat_avoidance",
  "description", "soulbound", "no_combat", "sell_price", "icon",
] as const;

export interface ItemLink {
  kind: "item";
  name: string;
  quality: string;
  type: string;
  equipment_slot: string | null;
  level_requirement: number | null;
  stat_damage: number | null;
  stat_armor: number | null;
  stat_health: number | null;
  stat_stamina: number | null;
  stat_critical_chance: number | null;
  stat_critical_damage: number | null;
  stat_avoidance: number | null;
  description: string;
  soulbound: boolean;
  no_combat: boolean;
  sell_price: number | null;
  icon: string | null;
  iconUrl: string | null;
}

/** An achievement as a link carries it: the exact name, what the achievement is for, and its icon as a url. */
export interface AchievementLink {
  kind: "achievement";
  id: number;
  name: string;
  description: string;
  icon: string | null;
}

/** Either kind of link a chat line carries. */
export type ChatLink = ItemLink | AchievementLink;

/** The achievement fields the link search reads (a definition from the achievements store has them all). */
export interface LinkableAchievement {
  id: number;
  name: string;
  description?: string | null;
  icon?: string | null;
  enabled?: boolean | number;
}

const TOKEN = /\[([^\[\]]+)\]/g;
// A translation placeholder is built from two private-use characters round the link's number. A
// player cannot type them (protectLinks strips them from the line first), so typed text can
// never be mistaken for one.
const OPEN = "";
const CLOSE = "";
const PLACEHOLDER = /(\d+)/g;
const RESERVED = /[]/g;

const key = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

// The lowercase name -> item map, kept between lines. It is rebuilt when the list's length changes
// or after NAME_MAP_TTL_MS, whichever comes first. A time bound (not the array reference) is what
// makes this correct with CACHE=redis, where every assetCache.get returns a new array. An item
// added or removed rebuilds it at once; an item edited (fields or name) can show its old values in
// links for at most the TTL, since the editors replace the item object rather than change it.
const NAME_MAP_TTL_MS = 30_000;
let nameMap: { map: Map<string, Record<string, any>>; length: number; builtAt: number } | null = null;

/** Forgets the kept name map (tests). */
export function clearItemNameCache(): void {
  nameMap = null;
}

function namesOf(items: Array<Record<string, any>>): Map<string, Record<string, any>> {
  const now = Date.now();
  if (nameMap && nameMap.length === items.length && now - nameMap.builtAt < NAME_MAP_TTL_MS && now >= nameMap.builtAt) return nameMap.map;
  const map = new Map<string, Record<string, any>>();
  for (const item of items) {
    if (!item || typeof item.name !== "string" || !item.name.trim()) continue;
    const k = key(item.name);
    if (!map.has(k)) map.set(k, item);
  }
  nameMap = { map, length: items.length, builtAt: now };
  return map;
}

function linkOf(item: any, iconUrl: (icon: string | null) => string | null): ItemLink {
  const link: any = { kind: "item" };
  for (const field of LINK_FIELDS) link[field] = item[field] ?? null;
  link.soulbound = !!item.soulbound;
  link.no_combat = !!item.no_combat;
  link.description = item.description ?? "";
  link.iconUrl = iconUrl(item.icon ?? null);
  return link;
}

type AchievementSource = LinkableAchievement[] | (() => LinkableAchievement[] | Promise<LinkableAchievement[]>);

/**
 * One scan of a line. `achievements` null means "not read yet": the scan stops with null at the first
 * token that is not an item (and could be an achievement), so the caller can read them and scan again.
 */
function scan(
  text: string,
  items: Array<Record<string, any>>,
  achievements: LinkableAchievement[] | null,
  max: number,
  iconUrl: (icon: string | null) => string | null,
): ChatLink[] | null {
  if (typeof text !== "string" || max <= 0 || !text.includes("[")) return [];
  const hasItems = Array.isArray(items) && items.length > 0;
  const byName = hasItems ? namesOf(items) : null;
  // Built on the first token that is not an item; a line of item links never reads the achievements.
  let achievementsByName: Map<string, LinkableAchievement> | null = null;
  const links: ChatLink[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    if (links.length >= max) break;
    const k = key(match[1]);
    if (seen.has(k)) continue;
    const item = byName?.get(k);
    if (item) {
      seen.add(k);
      links.push(linkOf(item, iconUrl));
      continue;
    }
    if (achievements === null) return null;
    if (!Array.isArray(achievements) || achievements.length === 0) continue;
    if (!achievementsByName) {
      achievementsByName = new Map();
      for (const def of achievements) {
        if (!def || !def.enabled || typeof def.name !== "string" || !def.name.trim()) continue;
        const name = key(def.name);
        if (!achievementsByName.has(name)) achievementsByName.set(name, def);
      }
    }
    const def = achievementsByName.get(k);
    if (!def) continue;
    seen.add(k);
    links.push({ kind: "achievement", id: Number(def.id), name: def.name, description: def.description ?? "", icon: iconUrl(def.icon ?? null) });
  }
  return links;
}

/**
 * The links in a chat line: each distinct `[Name]` that names a real item or, when no item has that
 * name, an enabled achievement (case and spacing ignored), in order of first appearance, at most `max`
 * of both kinds together. `achievements` is the list or a getter for it (sync or async); a getter is
 * called only once a token turns up that is not an item, so a line of item links never reads them.
 * `iconUrl` turns an icon name into the url the client loads.
 */
export async function findChatLinks(
  text: string,
  items: Array<Record<string, any>>,
  achievements: AchievementSource,
  max: number = MAX_ITEM_LINKS,
  iconUrl: (icon: string | null) => string | null = (icon) => icon,
): Promise<ChatLink[]> {
  if (typeof achievements !== "function") return scan(text, items, achievements ?? [], max, iconUrl) ?? [];
  const first = scan(text, items, null, max, iconUrl);
  if (first !== null) return first;
  return scan(text, items, (await achievements()) ?? [], max, iconUrl) ?? [];
}

/** The item links in a chat line (see `findChatLinks`); achievements are not looked at. */
export function findItemLinks(
  text: string,
  items: Array<Record<string, any>>,
  max: number = MAX_ITEM_LINKS,
  iconUrl: (icon: string | null) => string | null = (icon) => icon,
): ItemLink[] {
  return (scan(text, items, [], max, iconUrl) ?? []) as ItemLink[];
}

/** The line with each link token written as `[Exact Name]`, so the client finds every link by its name. */
export function canonicalLinks(text: string, links: Array<{ name: string }>): string {
  if (links.length === 0 || typeof text !== "string") return text;
  const exact = new Map(links.map((link) => [key(link.name), link.name]));
  return text.replace(TOKEN, (token, name: string) => {
    const found = exact.get(key(name));
    return found === undefined ? token : `[${found}]`;
  });
}

/**
 * Swaps each link's `[Name]` token for a placeholder (private-use characters round
 * the link's number) that a player cannot type: those characters are stripped from
 * the line first. `held` is what `restoreLinks` needs to put the tokens back: the
 * links' exact names, by placeholder number. Brackets that are not links (unknown
 * names, links past the cap) are left as they are.
 */
export function protectLinks(text: string, links: Array<{ name: string }>): { text: string; held: string[] } {
  const held = links.map((link) => link.name);
  if (typeof text !== "string") return { text, held };
  const clean = text.replace(RESERVED, "");
  if (held.length === 0) return { text: clean, held };
  const numbers = new Map(held.map((name, index) => [key(name), index]));
  return {
    text: clean.replace(TOKEN, (token, name: string) => {
      const index = numbers.get(key(name));
      return index === undefined ? token : `${OPEN}${index}${CLOSE}`;
    }),
    held,
  };
}

/**
 * Puts the link tokens back, each as `[Exact Name]`, exactly. Null when the text is not
 * a string or lost a placeholder (the translator mangled it): the caller keeps
 * the untranslated line then, so a link is never half there.
 */
export function restoreLinks(text: string, held: string[]): string | null {
  if (typeof text !== "string") return null;
  const found = new Set<number>();
  const restored = text.replace(PLACEHOLDER, (placeholder, digits: string) => {
    const index = Number(digits);
    if (!Number.isInteger(index) || index >= held.length) return placeholder;
    found.add(index);
    return `[${held[index]}]`;
  });
  return found.size === held.length ? restored : null;
}
