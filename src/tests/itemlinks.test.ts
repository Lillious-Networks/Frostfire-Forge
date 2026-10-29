import { describe, expect, test } from "bun:test";
import { afterEach, beforeEach } from "bun:test";
import { canonicalLinks, clearItemNameCache, findChatLinks, findItemLinks, protectLinks, restoreLinks, LINK_FIELDS, MAX_ITEM_LINKS } from "../systems/itemlinks";
import { receiverSource } from "./receiver-source";

beforeEach(clearItemNameCache);
afterEach(clearItemNameCache);

const item = (name: string, over: Record<string, unknown> = {}): any => ({
  name, quality: "common", type: "equipment", description: "", icon: `${name.toLowerCase().replace(/ /g, "_")}.png`,
  stat_armor: null, stat_damage: null, stat_critical_chance: null, stat_critical_damage: null,
  stat_health: null, stat_stamina: null, stat_avoidance: null, level_requirement: null,
  equipable: true, equipment_slot: null, bag_slots: null, damage_min: null, damage_max: null, attack_speed_ms: null,
  sell_price: 5, buy_price: 50, restore_health: 10, restore_stamina: 10, no_combat: false, teleports_home: false, soulbound: false,
  ...over,
});

const items = [
  item("Iron Sword", { quality: "rare", stat_damage: 12, equipment_slot: "weapon", level_requirement: 3, soulbound: true }),
  item("Health Potion", { quality: "uncommon", type: "consumable", no_combat: true }),
  item("Wolf Pelt"),
  item("Cloth Cap"), item("Old Boots"), item("Lucky Ring"), item("Red Gem"),
];

describe("findItemLinks", () => {
  test("a bracketed real item name is a link carrying the exact item name", () => {
    const links = findItemLinks("look at [Iron Sword] now", items);
    expect(links).toHaveLength(1);
    expect(links[0].name).toBe("Iron Sword");
    expect(links[0].quality).toBe("rare");
  });

  test("the match ignores case and the result carries the item's own spelling", () => {
    expect(findItemLinks("[iron sword] and [HEALTH POTION]", items).map((l) => l.name)).toEqual(["Iron Sword", "Health Potion"]);
  });

  test("padding and repeated spaces inside the brackets are normalised", () => {
    expect(findItemLinks("[  Iron   Sword ]", items).map((l) => l.name)).toEqual(["Iron Sword"]);
  });

  test("brackets around something that is not an item stay plain", () => {
    expect(findItemLinks("[hello] [Iron Swordd] [] [ ]", items)).toEqual([]);
    expect(findItemLinks("no brackets Iron Sword", items)).toEqual([]);
  });

  test("an unclosed or nested bracket is not a link", () => {
    expect(findItemLinks("[Iron Sword", items)).toEqual([]);
    expect(findItemLinks("[[Iron Sword]]", items).map((l) => l.name)).toEqual(["Iron Sword"]);
  });

  test("the same item twice, in any case, counts once", () => {
    const links = findItemLinks("[Wolf Pelt] [wolf pelt] [WOLF PELT]", items);
    expect(links.map((l) => l.name)).toEqual(["Wolf Pelt"]);
  });

  test("at most five links, the first five distinct items", () => {
    const text = "[Iron Sword] [Health Potion] [Wolf Pelt] [Cloth Cap] [Old Boots] [Lucky Ring] [Red Gem]";
    expect(MAX_ITEM_LINKS).toBe(5);
    expect(findItemLinks(text, items).map((l) => l.name)).toEqual(["Iron Sword", "Health Potion", "Wolf Pelt", "Cloth Cap", "Old Boots"]);
    expect(findItemLinks(text, items, 2).map((l) => l.name)).toEqual(["Iron Sword", "Health Potion"]);
  });

  test("repeats do not use up the cap", () => {
    const text = "[Iron Sword] [Iron Sword] [Iron Sword] [Iron Sword] [Iron Sword] [Iron Sword] [Health Potion]";
    expect(findItemLinks(text, items).map((l) => l.name)).toEqual(["Iron Sword", "Health Potion"]);
  });

  test("the tooltip fields are present and the icon becomes a url", () => {
    const [sword] = findItemLinks("[Iron Sword]", items, 5, (icon) => `http://assets/icon?name=${icon}`);
    expect(sword).toMatchObject({
      name: "Iron Sword", quality: "rare", type: "equipment", equipment_slot: "weapon", level_requirement: 3,
      stat_damage: 12, soulbound: true, sell_price: 5, icon: "iron_sword.png", iconUrl: "http://assets/icon?name=iron_sword.png",
    });
    for (const field of ["description", "stat_armor", "stat_health", "stat_stamina", "stat_critical_chance", "stat_critical_damage", "stat_avoidance", "no_combat"]) {
      expect(field in sword).toBe(true);
    }
  });

  test("fields the tooltip does not need are not sent", () => {
    const [sword] = findItemLinks("[Iron Sword]", items);
    const sent = Object.keys(sword).sort();
    expect(sent).toEqual([...LINK_FIELDS, "iconUrl", "kind"].sort());
    for (const field of ["buy_price", "restore_health", "restore_stamina", "teleports_home", "equipable", "bag_slots", "damage_min", "damage_max", "attack_speed_ms"]) {
      expect(field in sword).toBe(false);
    }
  });

  test("an item with no icon has a null icon url", () => {
    const [cap] = findItemLinks("[Cloth Cap]", [item("Cloth Cap", { icon: null })], 5, (icon) => (icon ? `u/${icon}` : null));
    expect(cap.iconUrl).toBeNull();
  });

  test("with no icon helper the icon url is the icon name", () => {
    expect(findItemLinks("[Wolf Pelt]", items)[0].iconUrl).toBe("wolf_pelt.png");
  });

  test("text with no items, an empty list, or a non-string gives no links", () => {
    expect(findItemLinks("", items)).toEqual([]);
    expect(findItemLinks("[Iron Sword]", [])).toEqual([]);
    expect(findItemLinks(undefined as any, items)).toEqual([]);
    expect(findItemLinks("[Iron Sword]", undefined as any)).toEqual([]);
  });

  test("an item with no name is skipped", () => {
    expect(findItemLinks("[]", [item("")])).toEqual([]);
  });
});

describe("protectLinks and restoreLinks", () => {
  const linksOf = (text: string) => findItemLinks(text, items);

  test("a round trip gives the text back", () => {
    const text = "trade my [Iron Sword] for your [Health Potion] please";
    const { text: held, held: names } = protectLinks(text, linksOf(text));
    expect(held).not.toContain("[");
    expect(held).not.toContain("Iron Sword");
    expect(restoreLinks(held, names)).toBe(text);
  });

  test("text with no links is untouched", () => {
    const { text, held } = protectLinks("hello [world]", []);
    expect(text).toBe("hello [world]");
    expect(restoreLinks(text, held)).toBe("hello [world]");
  });

  test("a repeated link is protected and restored at every place", () => {
    const text = "[Wolf Pelt] and again [wolf pelt]";
    const { text: held, held: names } = protectLinks(text, linksOf(text));
    expect(restoreLinks(held, names)).toBe("[Wolf Pelt] and again [Wolf Pelt]");
  });

  test("a restored token carries the item's exact name", () => {
    const text = "got [iron sword]";
    const { text: held, held: names } = protectLinks(text, linksOf(text));
    expect(restoreLinks(held, names)).toBe("got [Iron Sword]");
  });

  test("brackets that are not links are left for the translator", () => {
    const text = "[hello] [Iron Sword]";
    const { text: held, held: names } = protectLinks(text, linksOf(text));
    expect(held.startsWith("[hello] ")).toBe(true);
    expect(restoreLinks(held, names)).toBe("[hello] [Iron Sword]");
  });

  test("a link past the cap stays plain text", () => {
    const text = "[Iron Sword] [Health Potion] [Wolf Pelt]";
    const links = findItemLinks(text, items, 2);
    const { text: held, held: names } = protectLinks(text, links);
    expect(held).toContain("[Wolf Pelt]");
    expect(restoreLinks(held, names)).toBe(text);
  });

  test("a translator that changes the words around a link leaves the link whole", () => {
    const text = "hello friend, I sell [Iron Sword] and [Health Potion] today";
    const { text: held, held: names } = protectLinks(text, linksOf(text));
    const translated = held
      .replace("hello friend", "hola amigo")
      .replace("I sell", "vendo")
      .replace("and", "y")
      .replace("today", "hoy");
    expect(restoreLinks(translated, names)).toBe("hola amigo, vendo [Iron Sword] y [Health Potion] hoy");
  });

  test("a translator that reorders the links still restores each one", () => {
    const text = "[Iron Sword] then [Health Potion]";
    const { text: held, held: names } = protectLinks(text, linksOf(text));
    const [a, b] = held.split(" then ");
    expect(restoreLinks(`${b} luego ${a}`, names)).toBe("[Health Potion] luego [Iron Sword]");
  });

  test("a placeholder is private-use characters a player cannot type", () => {
    const { text: held } = protectLinks("[Iron Sword]", linksOf("[Iron Sword]"));
    expect(held).toBe("0");
  });

  test("private-use characters typed by the sender are stripped before protecting", () => {
    const text = "1 [Iron Sword] 0";
    const { text: held, held: names } = protectLinks(text, linksOf(text));
    expect(held).toBe("1 0 0");
    expect(restoreLinks(held, names)).toBe("1 [Iron Sword] 0");
    expect(protectLinks("ab", []).text).toBe("ab");
  });

  test("a translator that drops a placeholder gives null, so the caller can keep the original", () => {
    const text = "[Iron Sword] and [Health Potion]";
    const { text: held, held: names } = protectLinks(text, linksOf(text));
    expect(restoreLinks(held.replace("0", "sword"), names)).toBeNull();
  });

  test("a placeholder with the wrong marks or case is not accepted", () => {
    const { held: names } = protectLinks("[Iron Sword]", linksOf("[Iron Sword]"));
    expect(restoreLinks("__ITEM0__", names)).toBeNull();
    expect(restoreLinks(" 0 ", names)).toBeNull();
  });

  test("a translation that failed (not a string) gives null", () => {
    const { held } = protectLinks("[Iron Sword]", linksOf("[Iron Sword]"));
    expect(restoreLinks(undefined as any, held)).toBeNull();
  });

  test("a placeholder number the translator made up is left as it is", () => {
    const { text: held, held: names } = protectLinks("[Iron Sword]", linksOf("[Iron Sword]"));
    expect(restoreLinks(`${held} 9`, names)).toBe("[Iron Sword] 9");
  });

  test("canonicalLinks writes every link token with the item's exact name", () => {
    const text = "[iron sword], [ HEALTH   potion ] and [nothing]";
    expect(canonicalLinks(text, linksOf(text))).toBe("[Iron Sword], [Health Potion] and [nothing]");
    expect(canonicalLinks(text, [])).toBe(text);
  });

  test("typed placeholder-like text stays as typed, in a line with a link", () => {
    const text = "__ITEM0__ _item0_ __ITEM1__ [iron sword] 0";
    expect(canonicalLinks(text, linksOf(text))).toBe("__ITEM0__ _item0_ __ITEM1__ [Iron Sword] 0");
    const { text: held, held: names } = protectLinks("__ITEM0__ [Iron Sword]", linksOf("[Iron Sword]"));
    expect(restoreLinks(held, names)).toBe("__ITEM0__ [Iron Sword]");
  });

  test("dollar signs in item names are restored literally", () => {
    const odd = [item("Gold $& Co")];
    const text = "[gold $& co]";
    const links = findItemLinks(text, odd);
    const { text: held, held: names } = protectLinks(text, links);
    expect(restoreLinks(held, names)).toBe("[Gold $& Co]");
  });
});

describe("the chat relays", () => {
  const source = receiverSource();

  test("global, party, guild (command and packet) and whisper lines are linked", () => {
    expect(source.match(/chatLinksOf\(/g)?.length).toBeGreaterThanOrEqual(6);
    expect(source).toContain("protectLinks(sentMessage, sentLinks)");
    expect(source).toContain("text.length > MAX_CHAT_LENGTH");
    expect(source).toContain("Chat translation to ${player.language} failed");
    expect(source).toContain("restoreLinks(await language.translate(protectedLine.text");
  });

  test("links are read from the item and achievement caches, never the database", () => {
    const helper = source.slice(source.indexOf("async function chatLinksOf"), source.indexOf("async function vendorStockFrom"));
    expect(helper).toContain('assetCache.get("items")');
    expect(helper).toContain("achievementDefinitions");
    expect(helper).not.toMatch(/query\(/);
  });
});

describe("the kept name map", () => {
  test("a new list of the same length is read from the kept map within 30 seconds", () => {
    const first = [item("Iron Sword"), item("Wolf Pelt")];
    expect(findItemLinks("[Iron Sword]", first)).toHaveLength(1);
    const renamed = [item("Steel Sword"), item("Wolf Pelt")];
    expect(findItemLinks("[Steel Sword]", renamed)).toHaveLength(0);
  });

  test("a list of another length is read afresh at once", () => {
    expect(findItemLinks("[Iron Sword]", [item("Iron Sword")])).toHaveLength(1);
    expect(findItemLinks("[Wolf Pelt]", [item("Iron Sword"), item("Wolf Pelt")])).toHaveLength(1);
  });

  test("after 30 seconds the map is rebuilt", () => {
    const real = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      expect(findItemLinks("[Iron Sword]", [item("Iron Sword")])).toHaveLength(1);
      now += 29_000;
      expect(findItemLinks("[Steel Sword]", [item("Steel Sword")])).toHaveLength(0);
      now += 2_000;
      expect(findItemLinks("[Steel Sword]", [item("Steel Sword")])).toHaveLength(1);
    } finally {
      Date.now = real;
    }
  });

  test("a change made to the held item object itself shows at once", () => {
    const sword = item("Iron Sword", { quality: "common" });
    const list = [sword];
    expect(findItemLinks("[Iron Sword]", list)[0].quality).toBe("common");
    sword.quality = "epic";
    expect(findItemLinks("[Iron Sword]", list)[0].quality).toBe("epic");
  });
});

describe("achievement links", () => {
  const achievements: any[] = [
    { id: 7, name: "Wolf Hunter", description: "Slay ten wolves", icon: "wolf_badge.png", enabled: true },
    { id: 8, name: "Iron Sword", description: "Same name as an item", icon: null, enabled: true },
    { id: 9, name: "Retired", description: "Not offered any more", icon: null, enabled: false },
    { id: 10, name: "Gold Digger", description: "", icon: "gold.png", enabled: 1 },
    { id: 11, name: "Disabled Number", description: "", icon: null, enabled: 0 },
    { id: 12, name: "Tidy Room", description: "", icon: null, enabled: true },
    { id: 13, name: "Early Bird", description: "", icon: null, enabled: true },
  ];
  const iconUrl = (icon: string | null) => (icon ? `http://assets/icon?name=${icon}` : null);

  test("an achievement name becomes an achievement link with id, name, description and icon url", async () => {
    const links = await findChatLinks("I got [wolf  hunter] today", items, achievements, 5, iconUrl);
    expect(links).toEqual([{ kind: "achievement", id: 7, name: "Wolf Hunter", description: "Slay ten wolves", icon: "http://assets/icon?name=wolf_badge.png" }]);
  });

  test("an achievement with no icon has a null icon", async () => {
    expect(await findChatLinks("[Tidy Room]", items, achievements, 5, iconUrl)).toEqual([
      { kind: "achievement", id: 12, name: "Tidy Room", description: "", icon: null },
    ]);
  });

  test("an item wins over an achievement of the same name", async () => {
    const links = await findChatLinks("[Iron Sword]", items, achievements);
    expect(links).toHaveLength(1);
    expect(links[0].kind).toBe("item");
    expect(links[0].name).toBe("Iron Sword");
  });

  test("a disabled achievement is not linked", async () => {
    expect(await findChatLinks("[Retired] [Disabled Number]", items, achievements)).toEqual([]);
  });

  test("item entries carry kind item", async () => {
    expect((await findChatLinks("[Wolf Pelt]", items, achievements)).map((l) => l.kind)).toEqual(["item"]);
    expect(findItemLinks("[Wolf Pelt]", items)[0].kind).toBe("item");
  });

  test("items and achievements mix in order of appearance", async () => {
    const links = await findChatLinks("[Wolf Hunter] then [Wolf Pelt] then [Gold Digger]", items, achievements);
    expect(links.map((l) => `${l.kind}:${l.name}`)).toEqual(["achievement:Wolf Hunter", "item:Wolf Pelt", "achievement:Gold Digger"]);
  });

  test("the cap counts both kinds together", async () => {
    const text = "[Wolf Hunter] [Iron Sword] [Gold Digger] [Health Potion] [Tidy Room] [Early Bird] [Wolf Pelt]";
    expect((await findChatLinks(text, items, achievements)).map((l) => l.name)).toEqual(["Wolf Hunter", "Iron Sword", "Gold Digger", "Health Potion", "Tidy Room"]);
    expect((await findChatLinks(text, items, achievements, 2)).map((l) => l.name)).toEqual(["Wolf Hunter", "Iron Sword"]);
  });

  test("a repeated achievement counts once", async () => {
    expect((await findChatLinks("[Wolf Hunter] [wolf hunter]", items, achievements)).map((l) => l.name)).toEqual(["Wolf Hunter"]);
  });

  test("achievements link even when there are no items, and items when there are no achievements", async () => {
    expect(await findChatLinks("[Wolf Hunter]", [], achievements)).toHaveLength(1);
    expect(await findChatLinks("[Wolf Pelt]", items, [])).toHaveLength(1);
    expect(await findChatLinks("[Wolf Hunter]", [], [])).toEqual([]);
    expect(await findChatLinks("[Wolf Hunter]", items, undefined as any)).toEqual([]);
  });

  test("findItemLinks never links an achievement", async () => {
    expect(findItemLinks("[Wolf Hunter]", items)).toEqual([]);
  });

  test("protect and restore work with mixed kinds", async () => {
    const text = "got [wolf hunter] and [iron sword] and [gold digger]!";
    const links = await findChatLinks(text, items, achievements);
    const { text: held, held: names } = protectLinks(text, links);
    expect(held).not.toContain("[");
    expect(held).not.toContain("Wolf Hunter");
    expect(restoreLinks(held, names)).toBe("got [Wolf Hunter] and [Iron Sword] and [Gold Digger]!");
  });

  test("canonicalLinks writes the achievement's exact name", async () => {
    const text = "[ wolf HUNTER ] and [nothing]";
    expect(canonicalLinks(text, await findChatLinks(text, items, achievements))).toBe("[Wolf Hunter] and [nothing]");
  });

  test("a getter is not called for a line of item links, a non-link, or a repeat", async () => {
    let calls = 0;
    const getter = () => { calls++; return achievements; };
    expect((await findChatLinks("[Iron Sword] [wolf pelt] [Iron Sword]", items, getter)).map((l) => l.name)).toEqual(["Iron Sword", "Wolf Pelt"]);
    expect(await findChatLinks("no brackets", items, getter)).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a getter is called once, on the first token that is not an item, and may be async", async () => {
    let calls = 0;
    const getter = async () => { calls++; return achievements; };
    const links = await findChatLinks("[Wolf Pelt] [Wolf Hunter] [nothing] [Gold Digger]", items, getter);
    expect(links.map((l) => `${l.kind}:${l.name}`)).toEqual(["item:Wolf Pelt", "achievement:Wolf Hunter", "achievement:Gold Digger"]);
    expect(calls).toBe(1);
  });

  test("a getter that gives nothing leaves item links alone", async () => {
    const links = await findChatLinks("[Wolf Pelt] [Wolf Hunter]", items, (async () => undefined) as any);
    expect(links.map((l) => l.name)).toEqual(["Wolf Pelt"]);
  });
});
