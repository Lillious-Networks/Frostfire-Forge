import { describe, expect, mock, test } from "bun:test";
import { databaseModule, mockQuery } from "./setup";
import { PLACED_NPC_BASE, placedNpc, placedNpcId } from "../modules/mapnpc";

// Nothing here reads the database: the home rules and the NPC list are only loaded for what they say of an NPC.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));

const { getNpcSpriteLayers } = await import("../modules/spriteSheetManager");
const { cannotSetHome, isInnkeeper } = await import("../systems/homes");
const { default: npcs } = await import("../systems/npcs");
const { npcForClient } = await import("../systems/npcStreaming");

// An NPC a map places itself: a point of type "npc" on an object layer, as the map generator writes an inn's keeper
// into the room of one house of every town.

const keeper = (more: Record<string, unknown> = {}) => ({
  height: 0, id: 9, name: "Ashfield Inn", point: true, rotation: 0, type: "npc", visible: true, width: 0, x: 344, y: 288,
  properties: [
    { name: "direction", type: "string", value: "down" },
    { name: "sprite_type", type: "string", value: "animated" },
    { name: "sprite_body", type: "string", value: "player_body_default" },
    { name: "sprite_head", type: "string", value: "player_head_default" },
    { name: "innkeeper", type: "bool", value: true },
    { name: "dialog", type: "string", value: "Welcome to Ashfield, traveller." },
  ],
  ...more,
});

describe("an NPC placed by a map", () => {
  test("is a whole NPC: named, standing on its point, drawn from its sheets, an innkeeper", () => {
    const npc = placedNpc("house_33_40.json", keeper())!;
    expect(npc).toMatchObject({
      map: "house_33_40", name: "Ashfield Inn", position: { x: 344, y: 288, direction: "down" }, hidden: false,
      dialog: "Welcome to Ashfield, traveller.", gossip: null, script: null, quest_giver: false, innkeeper: true,
      sprite_type: "animated", sprite_body: "player_body_default", sprite_head: "player_head_default",
      sprite_helmet: null, sprite_shoulderguards: null, sprite_neck: null, sprite_hands: null, sprite_chest: null,
      sprite_feet: null, sprite_legs: null, sprite_weapon: null,
    });
    // not a row of the npcs table: the editors leave it be
    expect(npcs.isMapNpc(npc)).toBe(true);
    const layers = getNpcSpriteLayers(npc)!;
    expect([layers.body?.name, layers.head?.name, layers.helmet, layers.weapon]).toEqual(["player_body_default", "player_head_default", null, null]);
  });

  test("keeps its id from one start to the next, below every other NPC's", () => {
    const id = placedNpcId("house_33_40", "Ashfield Inn");
    expect(placedNpc("house_33_40.json", keeper())!.id).toBe(id);
    expect(placedNpcId("house_33_40.json", "Ashfield Inn")).toBe(id);
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeLessThanOrEqual(-PLACED_NPC_BASE);
    expect(id).toBeGreaterThan(-2 * PLACED_NPC_BASE); // a signed 32 bit column holds it (player_home.npc_id)
    // another map or another name is another NPC
    expect(placedNpcId("house_103_70", "Ashfield Inn")).not.toBe(id);
    expect(placedNpcId("house_33_40", "Hollymere Inn")).not.toBe(id);
    const many = new Set(Array.from({ length: 5000 }, (_, k) => placedNpcId(`house_${k % 71}_${k}`, `Town ${k % 58} Inn`)));
    expect(many.size).toBe(5000);
  });

  test("can be made a player's home, from beside it", () => {
    const npc = placedNpc("house_33_40.json", keeper())!;
    expect(isInnkeeper(npc)).toBe(true);
    const guest = (x: number, y: number, map = "house_33_40") => ({ username: "hero", location: { map, position: { x, y } } });
    expect(cannotSetHome(guest(344, 320), npc)).toBeNull();
    expect(cannotSetHome(guest(344, 320, "overworld"), npc)).toBe("You are too far from the innkeeper.");
    expect(cannotSetHome(guest(344, 600), npc)).toBe("You are too far from the innkeeper.");
    expect(isInnkeeper(placedNpc("house_33_40", keeper({ properties: [] })))).toBe(false);
  });

  test("is sent to the client as any NPC is", async () => {
    const sent = await npcForClient(placedNpc("house_33_40.json", keeper())!);
    expect(sent).toMatchObject({ name: "Ashfield Inn", hidden: false, innkeeper: true, vendor: false, sprite_type: "animated", particles: [], location: { x: 344, y: 288, direction: "down" } });
    expect(sent.spriteLayers.body.imageUrl).toContain("name=player_body_default");
    expect(sent.spriteLayers.head.imageUrl).toContain("name=player_head_default");
    expect(sent.spriteLayers.body.templateUrl).toContain("name=npc_body_base");
  });

  test("says what it is drawn as when its map does not, and is nothing without a name or a place", () => {
    const sheet = (name: string) => [{ name, type: "string", value: "player_body_default" }];
    expect(placedNpc("m", keeper({ properties: sheet("sprite_body") }))!.sprite_type).toBe("animated");
    expect(placedNpc("m", keeper({ properties: [] }))!.sprite_type).toBe("none");
    expect(placedNpc("m", keeper({ properties: [{ name: "direction", type: "string", value: "sideways" }] }))!.position.direction).toBe("down");
    expect(placedNpc("m", keeper({ properties: [{ name: "Direction", type: "string", value: "Left" }] }))!.position.direction).toBe("left");
    expect(placedNpc("m", keeper({ name: "  " }))).toBeNull();
    expect(placedNpc("m", keeper({ x: undefined }))).toBeNull();
    expect(placedNpc("m", null)).toBeNull();
  });
});
