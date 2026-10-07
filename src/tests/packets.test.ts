import { expect, test } from "bun:test";
import { packetTypes } from "../socket/types";
import { packetManager } from "../socket/packet_manager";

function decode(packet: Uint8Array) {
    return JSON.parse(new TextDecoder().decode(packet));
}

// ── New packet types ──

test("LEARN_SPELL type exists", () => {
    expect(packetTypes.LEARN_SPELL).toBe("LEARN_SPELL");
});

test("UNLEARN_SPELL type exists", () => {
    expect(packetTypes.UNLEARN_SPELL).toBe("UNLEARN_SPELL");
});

test("ADD_INVENTORY_ITEM type exists", () => {
    expect(packetTypes.ADD_INVENTORY_ITEM).toBe("ADD_INVENTORY_ITEM");
});

test("REMOVE_INVENTORY_ITEM type exists", () => {
    expect(packetTypes.REMOVE_INVENTORY_ITEM).toBe("REMOVE_INVENTORY_ITEM");
});

test("ADD_COLLECTABLE type exists", () => {
    expect(packetTypes.ADD_COLLECTABLE).toBe("ADD_COLLECTABLE");
});

test("REMOVE_COLLECTABLE type exists", () => {
    expect(packetTypes.REMOVE_COLLECTABLE).toBe("REMOVE_COLLECTABLE");
});

// ── learnSpell builder ──

test("packetManager.learnSpell encodes correctly", () => {
    const data = { name: "fireball", description: "test", mana: 10, cooldown: 5, cast_time: 2, damage: 25, type: "fire", effects: [], spriteUrl: "http://localhost/sprite?name=fireball" };
    const [pkt] = packetManager.learnSpell(data);
    const json = decode(pkt);
    expect(json.type).toBe("LEARN_SPELL");
    expect(json.data.name).toBe("fireball");
    expect(json.data.mana).toBe(10);
    expect(json.data.type).toBe("fire");
});

// ── unlearnSpell builder ──

test("packetManager.unlearnSpell encodes correctly", () => {
    const data = { name: "fireball" };
    const [pkt] = packetManager.unlearnSpell(data);
    const json = decode(pkt);
    expect(json.type).toBe("UNLEARN_SPELL");
    expect(json.data.name).toBe("fireball");
});

// ── addInventoryItem builder ──

test("packetManager.addInventoryItem encodes correctly", () => {
    const data = { name: "iron_sword", quantity: 1, quality: "rare", iconUrl: "/icon?name=iron_sword" };
    const [pkt] = packetManager.addInventoryItem(data);
    const json = decode(pkt);
    expect(json.type).toBe("ADD_INVENTORY_ITEM");
    expect(json.data.name).toBe("iron_sword");
    expect(json.data.quantity).toBe(1);
});

// ── removeInventoryItem builder ──

test("packetManager.removeInventoryItem encodes correctly", () => {
    const data = { name: "iron_sword" };
    const [pkt] = packetManager.removeInventoryItem(data);
    const json = decode(pkt);
    expect(json.type).toBe("REMOVE_INVENTORY_ITEM");
    expect(json.data.name).toBe("iron_sword");
});

// ── addCollectable builder ──

test("packetManager.addCollectable encodes correctly", () => {
    const data = { type: "mount", item: "unicorn", iconUrl: "/icon?name=unicorn" };
    const [pkt] = packetManager.addCollectable(data);
    const json = decode(pkt);
    expect(json.type).toBe("ADD_COLLECTABLE");
    expect(json.data.item).toBe("unicorn");
    expect(json.data.type).toBe("mount");
});

// ── removeCollectable builder ──

test("packetManager.removeCollectable encodes correctly", () => {
    const data = { item: "unicorn" };
    const [pkt] = packetManager.removeCollectable(data);
    const json = decode(pkt);
    expect(json.type).toBe("REMOVE_COLLECTABLE");
    expect(json.data.item).toBe("unicorn");
});

// ── Existing builders regression ──

test("packetManager.spells encodes correctly", () => {
    const data = { fireball: { spriteUrl: "/sprite?name=fireball", mana: 10 } };
    const [pkt] = packetManager.spells(data);
    const json = decode(pkt);
    expect(json.type).toBe("SPELLS");
    expect(json.data.fireball.mana).toBe(10);
});

test("packetManager.inventory encodes correctly", () => {
    const data = [{ name: "iron_sword", iconUrl: "/icon?name=iron_sword", quantity: 1 }];
    const [pkt] = packetManager.inventory(data);
    const json = decode(pkt);
    expect(json.type).toBe("INVENTORY");
    expect(json.data[0].name).toBe("iron_sword");
});

test("packetManager.collectables encodes correctly", () => {
    const data = [{ type: "mount", item: "unicorn", iconUrl: "/icon?name=unicorn" }];
    const [pkt] = packetManager.collectables(data as any);
    const json = decode(pkt);
    expect(json.type).toBe("COLLECTABLES");
    expect(json.data[0].item).toBe("unicorn");
});

test("packetManager.equipment encodes correctly", () => {
    const data = { weapon: "iron_sword", helmet: null };
    const [pkt] = packetManager.equipment(data as any);
    const json = decode(pkt);
    expect(json.type).toBe("EQUIPMENT");
    expect(json.data.weapon).toBe("iron_sword");
});

// ── createNpc builder ──

test("packetManager.createNpc says whether the NPC is a vendor", () => {
    const npc = { id: 7, name: "Smith", position: { x: 1, y: 2, direction: "down" }, hidden: false, dialog: null, particles: [], map: "overworld", sprite_type: "none" };
    const sent = (data: any) => decode(packetManager.createNpc(data)[0]).data;
    expect(sent({ ...npc, vendor: true }).vendor).toBe(true);
    expect(sent({ ...npc, vendor_items: [{ item: "Bread", price: 5 }] }).vendor).toBe(true);
    expect(sent({ ...npc, vendor_items: [] }).vendor).toBe(false);
    expect(sent(npc).vendor).toBe(false);
});

test("packetManager.itemCooldown says which cooldown, how long is left of it and how long it is in all", () => {
    expect(decode(packetManager.itemCooldown({ kind: "consumable", remaining: 12_000, total: 30_000 })[0]))
        .toEqual({ type: "ITEM_COOLDOWN", data: { kind: "consumable", remaining: 12_000, total: 30_000 } });
    expect(decode(packetManager.itemCooldown({ kind: "home", remaining: 3_600_000, total: 3_600_000 })[0]).data.kind).toBe("home");
});

test("packetManager.cooldownsReset tells a player every cooldown of theirs is over", () => {
    expect(decode(packetManager.cooldownsReset()[0])).toEqual({ type: "COOLDOWNS_RESET", data: null });
});

test("packetManager.mapMarkers says where a map's inns and caves are", () => {
    const markers = [{ kind: "inn" as const, x: 1008, y: 2000, name: "The Rusty Anchor" }, { kind: "cave" as const, x: 8032, y: 2500, name: null }];
    expect(decode(packetManager.mapMarkers({ map: "overworld", markers })[0])).toEqual({ type: "MAP_MARKERS", data: { map: "overworld", markers } });
});

test("packetManager.npcGossip says whether the NPC keeps an inn", () => {
    const sent = decode(packetManager.npcGossip({ npcId: 7, name: "Host", gossipText: null, quests: [], vendor: false, innkeeper: true })[0]);
    expect(sent).toEqual({ type: "NPC_GOSSIP", data: { npcId: 7, name: "Host", gossipText: null, quests: [], vendor: false, innkeeper: true } });
});

test("packetManager.createNpc says whether the NPC is an innkeeper", () => {
    const npc = { id: 7, name: "Host", position: { x: 1, y: 2, direction: "down" }, hidden: false, dialog: null, particles: [], map: "overworld", sprite_type: "none" };
    const sent = (data: any) => decode(packetManager.createNpc(data)[0]).data;
    expect(sent({ ...npc, innkeeper: true }).innkeeper).toBe(true);
    expect(sent({ ...npc, innkeeper: false }).innkeeper).toBe(false);
    expect(sent(npc).innkeeper).toBe(false);
});
