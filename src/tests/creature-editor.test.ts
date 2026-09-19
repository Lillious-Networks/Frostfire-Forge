import { describe, expect, mock, test } from "bun:test";

mock.module("../controllers/sqldatabase", () => ({ default: async () => [] }));

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

const editor = await import("../systems/creatures/editor");
const { NavGridCache, FOOT_H } = await import("../systems/creatures/navgrid");
const { normalizeTemplate, normalizeSpawn, normalizePatrolPath } = await import("../systems/creatures/repository");
const { CreatureFlags, yards } = await import("../systems/creatures/constants");

const T = 32;
const tile = (tx: number, ty: number) => ({ x: tx * T + T / 2, y: ty * T + T / 2 - FOOT_H / 2 });

/** RLE for a 20x20 map with a single wall tile at (5,5). */
function wallAtFiveFive(): number[] {
  const index = 5 * 20 + 5;
  return [20, 20, 0, index, 1, 1, 0, 400 - index - 1];
}

function context() {
  const navGrids = new NavGridCache();
  navGrids.update("main", wallAtFiveFive(), T, T);
  return {
    templateIds: new Set([1, 2]),
    spellIds: new Set([100]),
    lootTableIds: new Set([7]),
    pathIds: new Map([[3, "main"], [4, "cave"]]),
    linkGroupIds: new Set([9]),
    poolIds: new Set([11]),
    maps: new Set(["main", "cave"]),
    navGrids,
  };
}

const template = (over: any = {}) => ({ ...normalizeTemplate({ id: 1, name: "Wolf" }), ...over });
const spawn = (over: any = {}) => ({ ...normalizeSpawn({ id: 1, template_id: 1, map: "main", x: tile(2, 2).x, y: tile(2, 2).y }), ...over });

describe("editor permissions", () => {
  test("admins, tools.creature_editor and wildcards pass; others do not", () => {
    expect(editor.canUseEditor(null)).toBe(false);
    expect(editor.canUseEditor({ permissions: [] })).toBe(false);
    expect(editor.canUseEditor({ permissions: ["tools.npc_editor"] })).toBe(false);
    expect(editor.canUseEditor({ isAdmin: true, permissions: [] })).toBe(true);
    expect(editor.canUseEditor({ permissions: ["tools.creature_editor"] })).toBe(true);
    expect(editor.canUseEditor({ permissions: ["tools.*"] })).toBe(true);
    expect(editor.canUseEditor({ permissions: ["server.*"] })).toBe(true);
  });
});

describe("template validation", () => {
  test("accepts a sane template", () => {
    expect(editor.validateTemplate(template(), context())).toEqual([]);
  });

  test("rejects bad names, levels, ranges and unknown loot tables", () => {
    const errors = editor.validateTemplate(
      template({ name: "  ", level_min: 0, level_max: -1, scale: 0, flee_at_hp_pct: 150, gold_min: 10, gold_max: 1, loot_table_id: 99 }),
      context()
    );
    expect(errors).toEqual(expect.arrayContaining([
      "Name is required.",
      "Minimum level must be at least 1.",
      "Maximum level cannot be below minimum level.",
      "Scale must be greater than 0.",
      "Flee health must be between 0 and 100.",
      "Maximum money cannot be below minimum money.",
      "Loot table does not exist.",
    ]));
  });

  test("ignores the legacy melee fields: creatures only attack with abilities", () => {
    expect(editor.validateTemplate(template({ damage_min: 10, damage_max: 2, attack_speed_ms: 50 }), context())).toEqual([]);
  });

  test("rejects unknown stance and rank", () => {
    const errors = editor.validateTemplate(template({ stance: "friendly", rank: "legendary" }), context());
    expect(errors).toContain("Stance must be aggressive, neutral or passive.");
    expect(errors).toContain("Rank is not valid.");
  });
});

describe("ability validation", () => {
  const ability = (over: any = {}) => ({
    template_id: 1, spell_id: 100, trigger: "combat_timer", trigger_value: 0, initial_cd_min_ms: 0, initial_cd_max_ms: 1000,
    cooldown_min_ms: 5000, cooldown_max_ms: 8000, chance_pct: 100, target_mode: "current", max_range: 30, ...over,
  });

  test("accepts a sane ability", () => {
    expect(editor.validateAbility(ability(), context())).toEqual([]);
  });

  test("checks references, ranges and hp_below thresholds", () => {
    const errors = editor.validateAbility(
      ability({ template_id: 99, spell_id: 5, trigger: "whenever", target_mode: "everyone", cooldown_max_ms: 1, initial_cd_max_ms: -1, chance_pct: 150 }),
      context()
    );
    expect(errors).toEqual(expect.arrayContaining([
      "Creature template does not exist.",
      "Spell does not exist.",
      "Trigger is not valid.",
      "Target mode is not valid.",
      "Maximum cooldown cannot be below minimum cooldown.",
      "Maximum initial delay cannot be below minimum.",
      "Chance must be between 0 and 100.",
    ]));
    expect(editor.validateAbility(ability({ trigger: "hp_below", trigger_value: 0 }), context())).toContain("Health threshold must be between 1 and 100.");
    expect(editor.validateAbility(ability({ trigger: "hp_below", trigger_value: 30 }), context())).toEqual([]);
  });

  // A creature's abilities are saved as one list.
  const existing = [
    { id: 10, template_id: 1 },
    { id: 11, template_id: 1 },
    { id: 20, template_id: 2 },
  ];
  const spellName = (id: number) => (id === 100 ? "Bite" : undefined);

  test("ability set: keeps own ids, inserts new ones, deletes the rest", () => {
    const plan = editor.planAbilitySet(1, [ability({ id: 10 }), ability({ id: 0, chance_pct: 50 })], existing, context(), spellName);
    expect(plan.errors).toEqual([]);
    expect(plan.upserts.map((a: any) => a.id)).toEqual([10, 0]);
    expect(plan.upserts.every((a: any) => a.template_id === 1)).toBe(true);
    expect(plan.deleteIds).toEqual([11]);
  });

  test("ability set: another creature's ability id is inserted fresh, never overwritten", () => {
    const plan = editor.planAbilitySet(1, [ability({ id: 20, template_id: 2 })], existing, context(), spellName);
    expect(plan.upserts).toEqual([expect.objectContaining({ id: 0, template_id: 1 })]);
    expect(plan.deleteIds.sort()).toEqual([10, 11]);
  });

  test("ability set: an empty list removes every ability of that creature only", () => {
    const plan = editor.planAbilitySet(1, [], existing, context(), spellName);
    expect(plan.upserts).toEqual([]);
    expect(plan.deleteIds.sort()).toEqual([10, 11]);
  });

  test("ability set: any invalid entry rejects the whole save, naming the entry", () => {
    const plan = editor.planAbilitySet(1, [ability(), ability({ chance_pct: 150 })], existing, context(), spellName);
    expect(plan.errors).toEqual(["Ability 2 (Bite): Chance must be between 0 and 100."]);
    expect(plan.upserts).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
    expect(editor.planAbilitySet(99, [], existing, context(), spellName).errors).toEqual(["Creature template does not exist."]);
  });
});

describe("spawn validation", () => {
  test("accepts a walkable spawn", () => {
    expect(editor.validateSpawn(spawn(), context())).toEqual([]);
  });

  test("rejects collision, unknown maps and mismatched patrol paths", () => {
    expect(editor.validateSpawn(spawn({ x: tile(5, 5).x, y: tile(5, 5).y }), context())).toContain("That position is inside collision.");
    expect(editor.validateSpawn(spawn({ map: "nowhere" }), context())).toContain('Map "nowhere" does not exist.');
    expect(editor.validateSpawn(spawn({ movement_type: "patrol", patrol_path_id: 4 }), context())).toContain("Patrol path belongs to a different map.");
    expect(editor.validateSpawn(spawn({ movement_type: "patrol" }), context())).toContain("Patrol movement needs a patrol path.");
    expect(editor.validateSpawn(spawn({ movement_type: "wander", wander_radius: 0 }), context())).toContain("Wander movement needs a wander radius.");
    expect(editor.validateSpawn(spawn({ respawn_min_s: 100, respawn_max_s: 10 }), context())).toContain("Maximum respawn cannot be below minimum respawn.");
    expect(editor.validateSpawn(spawn({ link_group_id: 77 }), context())).toContain("Link group does not exist.");
    expect(editor.validateSpawn(spawn({ pool_id: 77 }), context())).toContain("Spawn pool does not exist.");
  });

  test("patrol spawns pointing at a path on the same map are fine", () => {
    expect(editor.validateSpawn(spawn({ movement_type: "patrol", patrol_path_id: 3 }), context())).toEqual([]);
  });
});

describe("path, pool and link group validation", () => {
  test("paths need two walkable points on a real map", () => {
    const ok = { map: "main", loop: true, points: [tile(1, 1), tile(2, 1)] };
    expect(editor.validatePatrolPath(ok, context())).toEqual([]);
    expect(editor.validatePatrolPath({ ...ok, points: [tile(1, 1)] }, context())).toContain("A patrol path needs at least two points.");
    expect(editor.validatePatrolPath({ ...ok, points: [tile(1, 1), tile(5, 5)] }, context())).toContain("Point 2 is inside collision.");
    expect(editor.validatePatrolPath({ ...ok, map: "gone" }, context())).toContain('Map "gone" does not exist.');
  });

  test("paths accept points_json as well as points", () => {
    const pts = [tile(1, 1), tile(2, 1)];
    expect(editor.validatePatrolPath({ map: "main", loop: true, points_json: JSON.stringify(pts) }, context())).toEqual([]);
    expect(editor.validatePatrolPath({ map: "main", loop: true, points_json: pts }, context())).toEqual([]);
  });

  test("editor-saves keep their points instead of wiping the path", () => {
    const pts = [{ ...tile(1, 1), wait_ms: 0 }, { ...tile(2, 1), wait_ms: 500 }];
    // The editor posts points as an array; the database stores points_json.
    // Both shapes must survive normalization or every save empties the path.
    expect(normalizePatrolPath({ id: 3, map: "main", loop: 1, points: pts }).points).toEqual(pts);
    expect(normalizePatrolPath({ id: 3, map: "main", loop: 1, points_json: JSON.stringify(pts) }).points).toEqual(pts);
  });

  test("pools and link groups", () => {
    expect(editor.validatePool({ max_active: 2, rare_chance_pct: 5, rare_template_id: 2 }, context())).toEqual([]);
    expect(editor.validatePool({ max_active: 0, rare_chance_pct: 500, rare_template_id: 42 }, context())).toEqual([
      "Max active must be at least 1.",
      "Rare chance must be between 0 and 100.",
      "Rare template does not exist.",
    ]);
    expect(editor.validateLinkGroup({ name: "Camp" })).toEqual([]);
    expect(editor.validateLinkGroup({ name: "  " })).toEqual(["Link group name is required."]);
  });
});

describe("debug radii", () => {
  test("aggro scales with level difference and uses the template overrides", () => {
    const t = template({ assist_radius: 10, call_for_help_radius: 15, leash_override: 40 });
    const s = spawn({ wander_radius: 8 });
    const radii = editor.debugRadii(t, 10, 15, s);
    expect(radii.aggro).toBe(yards(25));
    expect(radii.assist).toBe(yards(10));
    expect(radii.callForHelp).toBe(yards(15));
    expect(radii.leash).toBe(yards(40));
    expect(radii.wander).toBe(yards(8));
    expect(editor.debugRadii(template(), 60, 1, undefined).aggro).toBe(yards(5));
    expect(editor.debugRadii(template({ aggro_radius_override: 12 }), 10, 10, undefined).aggro).toBe(yards(12));
    expect(editor.debugRadii(template({ flags: CreatureFlags.NO_LEASH }), 10, 10, undefined).leash).toBe(yards(60));
  });
});
