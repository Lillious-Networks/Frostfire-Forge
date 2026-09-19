import { describe, expect, mock, test } from "bun:test";

mock.module("../controllers/sqldatabase", () => ({ default: async () => [] }));

const { entityToTemplate, mapStance, spawnInput } = await import("../utility/migrate_entities_to_creatures");
const { normalizeTemplate, normalizeSpawn } = await import("../systems/creatures/repository");
const { YARD_PX, speedPxPerSec } = await import("../systems/creatures/constants");

describe("legacy entity migration", () => {
  test("stances map aggressive/neutral directly and friendly to passive with a warning", () => {
    const warnings: string[] = [];
    expect(mapStance("aggressive", warnings, "x")).toBe("aggressive");
    expect(mapStance("neutral", warnings, "x")).toBe("neutral");
    expect(mapStance(null, warnings, "x")).toBe("neutral");
    expect(warnings).toEqual([]);
    expect(mapStance("friendly", warnings, "x")).toBe("passive");
    expect(warnings.length).toBe(1);
  });

  test("an entity row becomes a valid template with equivalent stats", () => {
    const warnings: string[] = [];
    const input = entityToTemplate(
      { id: 4, name: "Bandit Boss", map: "main.json", position: "320,480", aggro_type: "aggressive", level: 10, max_health: 900, aggro_range: 240, speed: 2, aggro_leash: 480, entity_type: "boss", loot_table_id: 7, sprite_body: "bandit" },
      warnings
    );
    const t = normalizeTemplate(input);
    expect(t.name).toBe("Bandit Boss");
    expect(t.rank).toBe("boss");
    expect(t.stance).toBe("aggressive");
    expect(t.level_min).toBe(10);
    expect(t.health_base).toBe(900);
    expect(t.health_per_level).toBe(0);
    // Legacy damage was 5 + 1.5 * level, +/- 2.
    expect(t.damage_min).toBe(18);
    expect(t.damage_max).toBe(22);
    expect(t.aggro_radius_override).toBe(240 / YARD_PX);
    expect(t.leash_override).toBe(480 / YARD_PX);
    expect(t.loot_table_id).toBe(7);
    expect(t.sprite).toBe("bandit");
    // speed 2 px per 16ms tick = 125 px/s in the new speed scale.
    expect(speedPxPerSec(t.move_speed_run)).toBeCloseTo(125, 0);
    expect(warnings).toEqual([]);
  });

  test("missing names and unknown entity types fall back sensibly", () => {
    const warnings: string[] = [];
    const t = normalizeTemplate(entityToTemplate({ id: 9, name: null, map: "main", position: "0,0", entity_type: "elite" }, warnings));
    expect(t.name).toBe("Creature 9");
    expect(t.rank).toBe("normal");
    expect(warnings.some((w) => w.includes("unknown entity_type"))).toBe(true);
  });

  test("spawns keep the entity's map (without .json), position and respawn", () => {
    const s = normalizeSpawn(spawnInput(3, "main.json", "100,200", "left", 45));
    expect(s).toMatchObject({ template_id: 3, map: "main", x: 100, y: 200, direction: "left", respawn_min_s: 45, respawn_max_s: 45, movement_type: "idle" });
  });
});
