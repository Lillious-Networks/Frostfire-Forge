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
