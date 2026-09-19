import { describe, expect, mock, test } from "bun:test";

mock.module("../controllers/sqldatabase", () => ({ default: async () => [] }));

const { ThreatTable, createCombatState } = await import("../systems/creatures/threat");
const { aggroRadiusYards, canProximityAggro, greyLevel, isGreyToPlayer } = await import("../systems/creatures/aggro");
const combatRolls = await import("../systems/creatures/combat");
const { CreatureCombatSystem, UNREACHABLE_DROP_MS, meleeRangePx } = await import("../systems/creatures/engine");
const { CreatureRegistry } = await import("../systems/creatures/registry");
const { NavGrid, FOOT_H } = await import("../systems/creatures/navgrid");
const { normalizeTemplate, normalizeSpawn } = await import("../systems/creatures/repository");
const { CreatureFlags, yards } = await import("../systems/creatures/constants");
const { createAuras } = await import("../systems/creatures/auras");

// ------------------------------------------------------------------ threat

describe("threat table", () => {
  test("damage threat accumulates and top is highest (ties go to first)", () => {
    const t = new ThreatTable();
    t.add("a", 10, 1);
    t.add("b", 10, 2);
    expect(t.top()).toBe("a");
    t.add("b", 1, 3);
    expect(t.top()).toBe("b");
    t.add("b", -100, 4);
    expect(t.threatOf("b")).toBe(0);
  });

  test("110% rule in melee, 130% at range", () => {
    const t = new ThreatTable();
    t.add("tank", 100, 0);
    expect(t.selectVictim(0, () => true)).toBe("tank");

    t.add("melee", 109, 1);
    expect(t.selectVictim(1, (id) => id === "melee")).toBe("tank");
    t.add("melee", 1, 2);
    expect(t.selectVictim(2, (id) => id === "melee")).toBe("melee");

    const r = new ThreatTable();
    r.add("tank", 100, 0);
    r.selectVictim(0, () => true);
    r.add("mage", 129, 1);
    expect(r.selectVictim(1, () => false)).toBe("tank");
    r.add("mage", 1, 2);
    expect(r.selectVictim(2, () => false)).toBe("mage");
  });

  test("taunt forces the victim for its duration and matches top threat", () => {
    const t = new ThreatTable();
    t.add("dps", 500, 0);
    t.add("tank", 50, 0);
    t.selectVictim(0, () => true);
    t.taunt("tank", 1000, 3000);
    expect(t.threatOf("tank")).toBe(500);
    expect(t.selectVictim(2000, () => true)).toBe("tank");
    t.add("dps", 1000, 4100);
    expect(t.selectVictim(4100, () => true)).toBe("dps");
  });

  test("removing the victim or ineligible units picks the next highest", () => {
    const t = new ThreatTable();
    t.add("a", 300, 0);
    t.add("b", 200, 0);
    t.add("c", 100, 0);
    t.selectVictim(0, () => true);
    t.remove("a");
    expect(t.selectVictim(1, () => true)).toBe("b");
    expect(t.selectVictim(2, () => true, (id) => id !== "b")).toBe("c");
  });

  test("modify scales threat (fade / feign style drops)", () => {
    const t = new ThreatTable();
    t.add("rogue", 1000, 0);
    t.modify("rogue", 0.5);
    expect(t.threatOf("rogue")).toBe(500);
    expect(t.snapshot()[0]).toMatchObject({ unitId: "rogue", threat: 500 });
  });
});

// ------------------------------------------------------------------- aggro

describe("aggro radius", () => {
  test("20 yards at equal level, +/-1 per level, clamped 5..45", () => {
    expect(aggroRadiusYards(10, 10)).toBe(20);
    expect(aggroRadiusYards(15, 10)).toBe(25);
    expect(aggroRadiusYards(10, 17)).toBe(13);
    expect(aggroRadiusYards(60, 1)).toBe(45);
    expect(aggroRadiusYards(1, 40)).toBe(5);
    expect(aggroRadiusYards(10, 10, 8)).toBe(8);
  });

  test("grey level table", () => {
    expect(greyLevel(5)).toBe(0);
    expect(greyLevel(10)).toBe(4);
    expect(greyLevel(39)).toBe(31);
    expect(greyLevel(40)).toBe(31);
    expect(greyLevel(59)).toBe(47);
    expect(greyLevel(60)).toBe(51);
    expect(isGreyToPlayer(4, 10)).toBe(true);
    expect(isGreyToPlayer(5, 10)).toBe(false);
  });

  const player = { level: 10, alive: true, gmHidden: false, stealthed: false };
  test("grey, dead, GM-hidden and stealthed players are not proximity-aggroed", () => {
    expect(canProximityAggro(10, null, false, player, 19)).toBe(true);
    expect(canProximityAggro(10, null, false, player, 21)).toBe(false);
    expect(canProximityAggro(4, null, false, player, 1)).toBe(false);
    expect(canProximityAggro(10, null, false, { ...player, alive: false }, 1)).toBe(false);
    expect(canProximityAggro(10, null, false, { ...player, gmHidden: true }, 1)).toBe(false);
    expect(canProximityAggro(10, null, false, { ...player, stealthed: true }, 1)).toBe(false);
    expect(canProximityAggro(10, null, true, { ...player, stealthed: true }, 1.5)).toBe(true);
    expect(canProximityAggro(10, null, true, { ...player, stealthed: true }, 3)).toBe(false);
  });
});

// ------------------------------------------------------------ attack tables

function distribution(roll: () => { outcome: string }, n = 100_000) {
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const o = roll().outcome;
    counts[o] = (counts[o] || 0) + 1;
  }
  const pct: Record<string, number> = {};
  for (const k in counts) pct[k] = (counts[k] / n) * 100;
  return pct;
}

function seeded(seed = 42) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

describe("attack tables", () => {
  test("creature vs player at equal level: 5% miss, 5% crit, dodge only from the front", () => {
    const front = combatRolls.creatureVsPlayerTable(10, 10, 8, true);
    expect(front).toEqual({ miss: 5, dodge: 8, parry: 0, crit: 5, crush: 0 });
    expect(combatRolls.creatureVsPlayerTable(10, 10, 8, false).dodge).toBe(0);

    const r = seeded();
    const pct = distribution(() => combatRolls.rollCreatureVsPlayer(front, r));
    expect(pct.miss).toBeCloseTo(5, 0);
    expect(pct.dodge).toBeCloseTo(8, 0);
    expect(pct.crit).toBeCloseTo(5, 0);
    expect(pct.crush ?? 0).toBe(0);
  });

  test("crushing blows only from creatures 3+ levels higher", () => {
    expect(combatRolls.creatureVsPlayerTable(12, 10, 0, true).crush).toBe(0);
    expect(combatRolls.creatureVsPlayerTable(13, 10, 0, true).crush).toBe(15);
    expect(combatRolls.creatureVsPlayerTable(14, 10, 0, true).crush).toBe(25);
    const roll = combatRolls.rollCreatureVsPlayer({ miss: 0, dodge: 0, parry: 0, crit: 0, crush: 100 }, () => 0.5);
    expect(roll).toEqual({ outcome: "crush", multiplier: 1.5 });
  });

  test("player vs creature: glancing vs same/higher level, no parry for beasts or from behind", () => {
    const humanoid = combatRolls.playerVsCreatureTable(10, 10, "humanoid", true, 5);
    expect(humanoid).toEqual({ miss: 5, dodge: 5, parry: 5, glancing: 10, crit: 5 });
    expect(combatRolls.playerVsCreatureTable(10, 10, "beast", true, 5).parry).toBe(0);
    expect(combatRolls.playerVsCreatureTable(10, 10, "humanoid", false, 5).parry).toBe(0);
    expect(combatRolls.playerVsCreatureTable(10, 8, "humanoid", true, 5).glancing).toBe(0);
    expect(combatRolls.playerVsCreatureTable(10, 13, "humanoid", true, 5).miss).toBeCloseTo(9, 5);

    const r = seeded(7);
    const pct = distribution(() => combatRolls.rollPlayerVsCreature(humanoid, 2, r));
    expect(pct.glancing).toBeCloseTo(10, 0);
    expect(pct.hit).toBeCloseTo(70, 0);
  });

  test("weapon profile prefers its damage range, falls back to the damage stat", () => {
    expect(combatRolls.weaponProfile({ damage_min: 8, damage_max: 14, attack_speed_ms: 2600 }))
      .toEqual({ damageMin: 8, damageMax: 14, swingMs: 2600 });
    // Older weapons carry only a flat damage stat.
    expect(combatRolls.weaponProfile({ stat_damage: 10 }))
      .toEqual({ damageMin: 10, damageMax: 15, swingMs: 2000 });
    // A single bound still yields a usable range, and speed has a floor.
    expect(combatRolls.weaponProfile({ damage_max: 6, attack_speed_ms: 100 }))
      .toEqual({ damageMin: 6, damageMax: 6, swingMs: 500 });
    expect(combatRolls.weaponProfile({})).toBeNull();
    expect(combatRolls.weaponProfile(null)).toBeNull();
  });

  test("swing damage: weapon range plus speed-scaled damage stat, unarmed scales with level", () => {
    // Slow weapon gets proportionally more from the damage stat than a fast one.
    const slow = combatRolls.playerMeleeDamageRange(10, 20, { damageMin: 10, damageMax: 20, swingMs: 3000 });
    const fast = combatRolls.playerMeleeDamageRange(10, 20, { damageMin: 10, damageMax: 20, swingMs: 1500 });
    expect(slow).toEqual([40, 50]);
    expect(fast).toEqual([25, 35]);

    // Bare-handed: weak, but still scales with level so low levels can fight.
    expect(combatRolls.playerMeleeDamageRange(10, 0, null)).toEqual([11, 22]);
    expect(combatRolls.playerMeleeDamageRange(1, 0, null)).toEqual([2, 4]);
  });

  test("spell miss, armor and facing", () => {
    expect(combatRolls.spellMissChance(10, 10)).toBe(4);
    expect(combatRolls.spellMissChance(10, 12)).toBe(6);
    expect(combatRolls.spellMissChance(10, 13)).toBe(17);
    expect(combatRolls.armorReduction(0, 10)).toBe(0);
    expect(combatRolls.armorReduction(1250, 10)).toBeCloseTo(0.5, 5);
    expect(combatRolls.armorReduction(1e9, 1)).toBe(0.75);
    expect(combatRolls.playerArmorReduction(90)).toBe(0.75);
    expect(combatRolls.isInFront({ x: 0, y: 0 }, "right", { x: 10, y: 3 })).toBe(true);
    expect(combatRolls.isInFront({ x: 0, y: 0 }, "right", { x: -10, y: 0 })).toBe(false);
  });
});

// ------------------------------------------------------------------ engine

const T = 32;
const tile = (tx: number, ty: number) => ({ x: tx * T + T / 2, y: ty * T + T / 2 - FOOT_H / 2 });

function openGrid(w = 60, h = 30) {
  return new NavGrid(w, h, T, T, new Uint8Array(w * h));
}

function makeCreature(id: number, x: number, y: number, over: any = {}) {
  return {
    id, templateId: 1, spawnId: 1, poolId: null, map: "main", layerId: null, x, y, dir: "down",
    homeX: x, homeY: y, level: 10, health: 100, maxHealth: 100, state: "idle" as any, spawnedAt: 0,
    move: null, waitUntil: 0, patrolIndex: 0, patrolForward: true, sentX: x, sentY: y, sentDir: "down",
    sentMoving: false, combat: createCombatState(), auras: createAuras(), casting: null, abilityStates: new Map(), ...over,
  };
}

function setup(templateOver: any = {}, gridOverride?: any, extraTemplates: Record<number, any> = {}) {
  const registry = new CreatureRegistry(128);
  const template = normalizeTemplate({
    id: 1, name: "Wolf", level_min: 10, level_max: 10, damage_min: 10, damage_max: 10, attack_speed_ms: 2000,
    move_speed_run: 7, armor: 0, creature_type: "humanoid", ...templateOver,
  });
  const spawn = normalizeSpawn({ id: 1, template_id: 1, map: "main" });
  const players = new Map<string, any>();
  const events: any = { damage: [] as any[], texts: [] as any[], died: [] as any[], stopped: [] as any[], combatMarks: new Set<string>(), dazed: [] as string[], taps: [] as any[], playerEffects: [] as any[], casts: [] as any[], auraChanges: [] as number[], pendingImpacts: [] as any[], launches: [] as any[] };
  const others = new Map<number, any>(Object.entries(extraTemplates).map(([id, t]) => [Number(id), normalizeTemplate({ id: Number(id), name: "Other", ...t })]));
  const links = new Map<number, number[]>();
  const abilities = new Map<number, any[]>();
  const spells = new Map<number, any>();
  const grid = gridOverride === undefined ? openGrid() : gridOverride;
  let roll = 0.5;
  const system = new CreatureCombatSystem(registry, {
    rng: () => roll,
    template: (id: number) => others.get(id) ?? template,
    spawn: () => spawn,
    patrol: () => undefined,
    grid: () => grid ?? undefined,
    getPlayer: (id) => players.get(id) ?? null,
    playersNear: (map, x, y, r) => [...players.values()].filter((p) => p.map === map && Math.hypot(p.x - x, p.y - y) <= r),
    damagePlayer: (_c, playerId, amount, outcome) => {
      events.damage.push({ playerId, amount, outcome });
      const p = players.get(playerId);
      if (p) {
        p.health -= amount;
        if (p.health <= 0) p.alive = false;
      }
    },
    dazePlayer: (id) => events.dazed.push(id),
    markPlayerInCombat: (id) => events.combatMarks.add(id),
    onHealthChanged: () => {},
    onStateChanged: () => {},
    onCombatText: (t) => events.texts.push(t),
    onDied: (c, killer) => events.died.push({ id: c.id, killer }),
    onAutoAttackStopped: (playerId, creatureId) => events.stopped.push({ playerId, creatureId }),
    onTapChanged: (c) => events.taps.push({ id: c.id, tapper: c.combat.tapper }),
    linkedCreatures: (c) => (links.get(c.id) ?? []).map((id) => registry.get(id)).filter(Boolean) as any[],
    spell: (id) => spells.get(id),
    abilities: (templateId) => abilities.get(templateId) ?? [],
    applySpellEffectsToPlayer: (_c, playerId, spell) => events.playerEffects.push({ playerId, spell: spell.name }),
    // Projectile flight: record the delay, then land the hit immediately so the
    // combat assertions stay synchronous.
    later: (ms: number, fn: () => void) => {
      events.pendingImpacts.push({ ms });
      fn();
    },
    onSpellLaunch: (c: any, spell: any) => events.launches.push({ id: c.id, spell: spell.name }),
    onCastStart: (c) => events.casts.push({ id: c.id, phase: "start", spell: c.casting?.spellName }),
    onCastEnd: (c, spell, result) => events.casts.push({ id: c.id, phase: "end", spell, result }),
    onAurasChanged: (c) => events.auraChanges.push(c.id),
  });
  const addPlayer = (id: string, pos: { x: number; y: number }, over: any = {}) => {
    const p = {
      id, username: id, map: "main", layerId: null, x: pos.x, y: pos.y, dir: "up", level: 10, alive: true,
      gmHidden: false, stealthed: false, casting: false, dodgePct: 0, critPct: 0, critDamagePct: 0,
      statDamage: 0, armorPct: 0, health: 1000, ...over,
    };
    players.set(id, p);
    return p;
  };
  return { registry, system, template, players, events, addPlayer, links, abilities, spells, setRoll: (v: number) => (roll = v) };
}

function run(system: any, creature: any, from: number, to: number) {
  for (let now = from; now <= to; now += 100) system.tick(creature, now, 100);
}

describe("creature combat engine", () => {
  test("aggressive creatures aggro players inside the level-scaled radius only", () => {
    const { registry, system, addPlayer } = setup();
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    addPlayer("far", { x: c.x + yards(21), y: c.y });
    system.tick(c, 0);
    expect(c.state).not.toBe("combat");

    addPlayer("near", { x: c.x + yards(19), y: c.y });
    system.tick(c, 1000);
    expect(c.state).toBe("combat");
    expect(c.combat.threat.has("near")).toBe(true);
    expect(c.combat.threat.has("far")).toBe(false);
    expect(system.isInCombatWith("near")).toBe(true);
  });

  test("walls block proximity aggro", () => {
    const walls = new Uint8Array(60 * 30);
    for (let y = 0; y < 30; y++) walls[y * 60 + 12] = 1;
    const { registry, system, addPlayer } = setup({}, new NavGrid(60, 30, T, T, walls));
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    addPlayer("p", tile(14, 10));
    system.tick(c, 0);
    expect(c.state).not.toBe("combat");
  });

  test("neutral creatures ignore proximity but fight back when hit", () => {
    const { registry, system, addPlayer } = setup({ stance: "neutral" });
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    addPlayer("p", { x: c.x + 10, y: c.y });
    system.tick(c, 0);
    expect(c.state).not.toBe("combat");
    system.damageCreature(c, "p", 5, 100);
    expect(c.state).toBe("combat");
    expect(c.health).toBe(95);
    expect(c.combat.threat.threatOf("p")).toBe(5);
  });

  test("passive creatures flee when hit and never attack", () => {
    const { registry, system, addPlayer, events } = setup({ stance: "passive" });
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    addPlayer("p", { x: c.x - 20, y: c.y });
    system.damageCreature(c, "p", 5, 0);
    expect(c.state).toBe("fleeing");
    const startX = c.x;
    run(system, c, 100, 3000);
    expect(c.x).toBeGreaterThan(startX);
    expect(events.damage.length).toBe(0);
    run(system, c, 3100, 5000);
    expect(c.state).toBe("idle");
    expect(c.combat.threat.isEmpty()).toBe(true);
  });

  test("chases into reach but has no attack of its own: no abilities, no damage", () => {
    const { registry, system, addPlayer, events, setRoll } = setup();
    setRoll(0.5);
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    addPlayer("p", tile(15, 10), { dir: "right" }); // back turned: nothing to daze either
    system.damageCreature(c, "p", 1, 0);
    run(system, c, 100, 5000);
    const d = Math.hypot(c.x - tile(15, 10).x, c.y - tile(15, 10).y);
    expect(d).toBeLessThanOrEqual(meleeRangePx(normalizeTemplate({ id: 1, name: "x" })));
    expect(c.combat.threat.victimId).toBe("p");
    expect(events.damage).toEqual([]);
    expect(events.dazed).toEqual([]);
  });

  test("leashing past the range evades: immune, returns home, full health", () => {
    const { registry, system, addPlayer, events } = setup({ leash_override: 10 });
    const home = tile(10, 10);
    const c = makeCreature(1, home.x, home.y, { health: 40 });
    registry.add(c);
    const p = addPlayer("p", { x: home.x + 30, y: home.y });
    system.damageCreature(c, "p", 1, 0);
    p.x = home.x + yards(40);
    run(system, c, 100, 3000);
    expect(["evading", "idle"]).toContain(c.state);

    // Immune while evading.
    if (c.state === "evading") {
      expect(system.damageCreature(c, "p", 50, 3100)).toBe(0);
      expect(events.texts.at(-1).kind).toBe("evade");
    }
    run(system, c, 3200, 9000);
    expect(c.state).toBe("idle");
    expect(c.health).toBe(c.maxHealth);
    expect(Math.hypot(c.x - home.x, c.y - home.y)).toBeLessThan(1);
    expect(c.combat.threat.isEmpty()).toBe(true);
    expect(system.isInCombatWith("p")).toBe(false);
  });

  test("unreachable targets are dropped after 5 seconds, then the creature evades", () => {
    const walls = new Uint8Array(60 * 30);
    for (let y = 0; y < 30; y++) walls[y * 60 + 20] = 1;
    const { registry, system, addPlayer } = setup({ ranged: false }, new NavGrid(60, 30, T, T, walls));
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    addPlayer("p", tile(25, 10));
    system.damageCreature(c, "p", 1, 0);
    run(system, c, 100, UNREACHABLE_DROP_MS - 500);
    expect(c.state).toBe("combat");
    run(system, c, UNREACHABLE_DROP_MS, UNREACHABLE_DROP_MS + 1000);
    expect(c.state).not.toBe("combat");
    expect(system.isInCombatWith("p")).toBe(false);
  });

  test("dead or departed players leave the table; empty table evades", () => {
    const { registry, system, addPlayer } = setup();
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    addPlayer("a", tile(11, 10));
    addPlayer("b", tile(11, 11));
    system.damageCreature(c, "a", 10, 0);
    system.damageCreature(c, "b", 1, 0);
    system.removeUnit("a", 100);
    expect(c.combat.threat.has("a")).toBe(false);
    expect(c.state).toBe("combat");
    system.removeUnit("b", 200);
    expect(c.state).toBe("evading");
  });

  test("ranged spells land after projectile flight, scaled by distance and capped", () => {
    const { registry, system, addPlayer, events, spells, abilities } = setup();
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    spells.set(1, { id: 1, name: "fire_bolt", damage: 20, range: 2000, cast_time: 0, effects: [] });
    abilities.set(c.templateId, [ability({ spell_id: 1, trigger: "combat_timer", initial_cd_min_ms: 0, initial_cd_max_ms: 0 })]);

    // 200px away: 200ms of flight.
    addPlayer("p", { x: c.x + 200, y: c.y });
    system.damageCreature(c, "p", 1, 0);
    run(system, c, 100, 300);
    expect(events.pendingImpacts.at(-1).ms).toBe(200);

    // Distant targets are capped so a shot never hangs in the air.
    expect(events.pendingImpacts.every((i: any) => i.ms <= 500)).toBe(true);
  });

  test("going stealthed or GM-hidden drops the player from the table and evades", () => {
    const { registry, system, addPlayer } = setup();
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    const rogue = addPlayer("rogue", tile(11, 10));
    system.damageCreature(c, "rogue", 10, 0);
    expect(c.state).toBe("combat");

    // Vanish: the creature loses its target and resets.
    rogue.stealthed = true;
    system.tick(c, 1000, 100);
    expect(c.combat.threat.has("rogue")).toBe(false);
    expect(c.state).toBe("evading");
  });

  test("a GM-hidden admin is never aggroed or kept in combat", () => {
    const { registry, system, addPlayer } = setup();
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    const admin = addPlayer("admin", tile(11, 10), { gmHidden: true });

    // No proximity aggro while hidden.
    system.tick(c, 1000, 100);
    expect(c.state).not.toBe("combat");

    // Even forced onto the table, the creature drops them on the next tick.
    system.damageCreature(c, "admin", 10, 1000);
    expect(c.state).toBe("combat");
    system.tick(c, 1100, 100);
    expect(c.combat.threat.has("admin")).toBe(false);
    void admin;
  });

  test("healing splits 0.5 threat per point across engaged creatures and pulls the healer", () => {
    const { registry, system, addPlayer } = setup({ stance: "neutral" });
    const c1 = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    const c2 = makeCreature(2, tile(12, 10).x, tile(12, 10).y);
    registry.add(c1);
    registry.add(c2);
    addPlayer("tank", tile(11, 10));
    addPlayer("healer", tile(11, 14));
    system.damageCreature(c1, "tank", 1, 0);
    system.damageCreature(c2, "tank", 1, 0);
    system.onPlayerHealed("healer", "tank", 100, 10);
    expect(c1.combat.threat.threatOf("healer")).toBe(25);
    expect(c2.combat.threat.threatOf("healer")).toBe(25);
    system.onPlayerHealed("healer", "nobody", 100, 10);
    expect(c1.combat.threat.threatOf("healer")).toBe(25);
  });

  test("low health flee once per combat, then resume fighting", () => {
    const { registry, system, addPlayer } = setup({ flee_at_hp_pct: 20, flee_duration_ms: 1000 });
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    addPlayer("p", tile(11, 10));
    system.damageCreature(c, "p", 85, 0);
    system.tick(c, 100);
    expect(c.state).toBe("fleeing");
    run(system, c, 200, 1300);
    expect(c.state).toBe("combat");
    system.tick(c, 1400);
    expect(c.state).not.toBe("fleeing");
  });

  test("NEVER_FLEE and NO_LEASH flags", () => {
    const { registry, system, addPlayer } = setup({ flee_at_hp_pct: 50, flags: CreatureFlags.NEVER_FLEE | CreatureFlags.NO_LEASH, leash_override: 5 });
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    const p = addPlayer("p", tile(11, 10));
    system.damageCreature(c, "p", 90, 0);
    p.x = tile(30, 10).x;
    run(system, c, 100, 3000);
    expect(c.state).toBe("combat");
  });

  test("killing blow: dead state, corpse timer, auto-attacks stop, killer reported", () => {
    const { registry, system, addPlayer, events } = setup();
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y, { health: 10 });
    registry.add(c);
    addPlayer("p", tile(10, 10));
    expect(system.startAutoAttack("p", 1, 0)).toBeNull();
    expect(system.damageCreature(c, "p", 50, 100)).toBe(10);
    expect(c.state).toBe("dead");
    expect(c.combat.corpseUntil).toBeGreaterThan(100);
    expect(events.died).toEqual([{ id: 1, killer: "p" }]);
    expect(events.stopped).toEqual([{ playerId: "p", creatureId: 1 }]);
    expect(system.isInCombatWith("p")).toBe(false);
    expect(system.damageCreature(c, "p", 50, 200)).toBe(0);
  });

  test("player auto-attack swings every 2s in melee range and pulls the creature", () => {
    const { registry, system, addPlayer, events, setRoll } = setup({ stance: "neutral", armor: 0 });
    setRoll(0.9); // 90 on the table: a normal hit
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y, { health: 1000, maxHealth: 1000 });
    registry.add(c);
    const p = addPlayer("p", { x: c.x + 100, y: c.y });
    expect(system.startAutoAttack("p", 1, 0)).toBeNull();
    system.tickPlayerAttacks(0);
    expect(c.health).toBe(1000); // out of range

    p.x = c.x + 10;
    system.tickPlayerAttacks(100);
    expect(c.health).toBeLessThan(1000);
    expect(c.state).toBe("combat");
    const afterFirst = c.health;
    system.tickPlayerAttacks(1000);
    expect(c.health).toBe(afterFirst);
    system.tickPlayerAttacks(2100);
    expect(c.health).toBeLessThan(afterFirst);
    expect(events.texts.some((t: any) => t.sourceId === "p" && t.kind === "hit")).toBe(true);
  });

  test("auto-attack stops when the player dies or changes map", () => {
    const { registry, system, addPlayer, events } = setup({ stance: "neutral" });
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    const p = addPlayer("p", tile(10, 10));
    system.startAutoAttack("p", 1, 0);
    p.map = "cave";
    system.tickPlayerAttacks(100);
    expect(system.autoAttackTarget("p")).toBeNull();
    expect(events.stopped.length).toBe(1);
    expect(system.startAutoAttack("p", 1, 200)).toBe("invalid_target");
  });
});

describe("social aggro and tapping", () => {
  test("same-type creatures within the assist radius join; other types and far ones don't", () => {
    const { registry, system, addPlayer } = setup({ stance: "neutral", assist_radius: 10, creature_type: "humanoid" }, undefined, {
      2: { stance: "aggressive", creature_type: "beast" },
    });
    const puller = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    const buddy = makeCreature(2, tile(12, 10).x, tile(12, 10).y);
    const beast = makeCreature(3, tile(11, 11).x, tile(11, 11).y, { templateId: 2 });
    const far = makeCreature(4, tile(30, 10).x, tile(30, 10).y);
    for (const c of [puller, buddy, beast, far]) registry.add(c);
    addPlayer("p", tile(9, 10));
    system.damageCreature(puller, "p", 5, 0);
    expect(puller.state).toBe("combat");
    expect(buddy.state).toBe("combat");
    expect(buddy.combat.threat.has("p")).toBe(true);
    expect(beast.state).not.toBe("combat");
    expect(far.state).not.toBe("combat");
  });

  test("walls stop assists; NO_SOCIAL_AGGRO stops both calling and answering", () => {
    const walls = new Uint8Array(60 * 30);
    for (let y = 0; y < 30; y++) walls[y * 60 + 11] = 1;
    const { registry, system, addPlayer } = setup({ stance: "neutral", assist_radius: 10 }, new NavGrid(60, 30, T, T, walls), {
      2: { stance: "neutral", assist_radius: 10, flags: CreatureFlags.NO_SOCIAL_AGGRO },
    });
    const a = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    const behindWall = makeCreature(2, tile(12, 10).x, tile(12, 10).y);
    const loner = makeCreature(3, tile(10, 12).x, tile(10, 12).y, { templateId: 2 });
    for (const c of [a, behindWall, loner]) registry.add(c);
    addPlayer("p", tile(9, 10));
    system.damageCreature(a, "p", 5, 0);
    expect(behindWall.state).not.toBe("combat");
    expect(loner.state).not.toBe("combat");
  });

  test("link groups pull every member regardless of distance, without chaining assists", () => {
    const { registry, system, addPlayer, links } = setup({ stance: "neutral", assist_radius: 10 });
    const a = makeCreature(1, tile(5, 5).x, tile(5, 5).y);
    const linked = makeCreature(2, tile(50, 25).x, tile(50, 25).y);
    const nearLinked = makeCreature(3, tile(51, 25).x, tile(51, 25).y);
    for (const c of [a, linked, nearLinked]) registry.add(c);
    links.set(1, [2]);
    addPlayer("p", tile(4, 5));
    system.damageCreature(a, "p", 5, 0);
    expect(linked.state).toBe("combat");
    expect(nearLinked.state).not.toBe("combat");
  });

  test("fleeing at low health calls idle allies in the call-for-help radius", () => {
    const { registry, system, addPlayer } = setup({ flee_at_hp_pct: 20, assist_radius: 0, call_for_help_radius: 15, stance: "neutral" });
    const a = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    const ally = makeCreature(2, tile(13, 10).x, tile(13, 10).y);
    registry.add(a);
    registry.add(ally);
    addPlayer("p", tile(9, 10));
    system.damageCreature(a, "p", 85, 0);
    expect(ally.state).not.toBe("combat");
    system.tick(a, 100);
    expect(a.state).toBe("fleeing");
    expect(ally.state).toBe("combat");
  });

  test("first hostile action taps; later attackers don't steal it; evade clears it", () => {
    const { registry, system, addPlayer, events } = setup({ stance: "neutral" });
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    addPlayer("first", tile(9, 10), { username: "First" });
    addPlayer("second", tile(11, 10), { username: "Second" });
    system.damageCreature(c, "first", 1, 0);
    system.damageCreature(c, "second", 50, 10);
    expect(c.combat.tapper).toEqual({ playerId: "first", username: "first" });
    expect(events.taps.length).toBe(1);
    system.evade(c, 100);
    expect(c.combat.tapper).toBeNull();
    expect(events.taps.length).toBe(2);
  });

  test("proximity aggro alone does not tap", () => {
    const { registry, system, addPlayer } = setup();
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    addPlayer("p", tile(12, 10));
    system.tick(c, 0);
    expect(c.state).toBe("combat");
    expect(c.combat.tapper).toBeNull();
  });

  test("the tapper survives death so rewards can be granted", () => {
    const { registry, system, addPlayer } = setup({ stance: "neutral" });
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y, { health: 5 });
    registry.add(c);
    addPlayer("p", tile(10, 10), { username: "P" });
    system.damageCreature(c, "p", 10, 0);
    expect(c.state).toBe("dead");
    expect(c.combat.tapper?.username).toBe("p");
  });
});

// ------------------------------------------------------- phase 5: spells

const auraOps = await import("../systems/creatures/auras");
const abilityOps = await import("../systems/creatures/abilities");
const { normalizeAbility } = await import("../systems/creatures/repository");

const ability = (over: any = {}) => normalizeAbility({ id: 1, template_id: 1, spell_id: 100, trigger: "combat_timer", initial_cd_min_ms: 0, initial_cd_max_ms: 0, cooldown_min_ms: 5000, cooldown_max_ms: 5000, ...over });
const spell = (over: any = {}) => ({ id: 100, name: "shadow_bolt", damage: 20, mana: 0, range: 400, cast_time: 2, cooldown: 0, effects: [], aoe_radius: 0, ...over });

describe("creature auras", () => {
  test("DoTs tick on schedule, stack, refresh and expire", () => {
    const a = auraOps.createAuras();
    const effect = { type: "damage_over_time", value: 5, duration: 6, interval: 2, stackable: true, max_stacks: 2 };
    expect(auraOps.applyDot(a, "corruption", "p", effect as any, 0)).toBe(true);
    expect(auraOps.collectDotTicks(a, 1999)).toEqual([]);
    expect(auraOps.collectDotTicks(a, 2000).map((t) => t.amount)).toEqual([5]);
    auraOps.applyDot(a, "corruption", "p", effect as any, 3000);
    auraOps.applyDot(a, "corruption", "p", effect as any, 3000);
    expect(a.dots[0].stacks).toBe(2);
    expect(auraOps.collectDotTicks(a, 4000).map((t) => t.amount)).toEqual([10]);
    expect(auraOps.collectDotTicks(a, 20000).length).toBe(2);
    expect(a.dots.length).toBe(0);
  });

  test("strongest slow wins; stun and lockout expire", () => {
    const a = auraOps.createAuras();
    auraOps.applySlow(a, "a", 30, 1000, 0);
    auraOps.applySlow(a, "b", 60, 500, 0);
    expect(auraOps.slowMultiplier(a, 100)).toBeCloseTo(0.4, 5);
    expect(auraOps.slowMultiplier(a, 600)).toBeCloseTo(0.7, 5);
    expect(auraOps.slowMultiplier(a, 1100)).toBe(1);
    auraOps.applyStun(a, 1000, 0);
    expect(auraOps.isStunned(a, 999)).toBe(true);
    expect(auraOps.isStunned(a, 1000)).toBe(false);
    auraOps.applyCastLockout(a, 500, 0);
    expect(auraOps.aurasPayload(a, 100).map((p) => p.kind).sort()).toEqual(["lockout", "stun"]);
  });
});

describe("ability scheduling", () => {
  test("initial delay, cooldown, one-shot triggers and priority", () => {
    const states = new Map();
    const timer = ability({ id: 1, initial_cd_min_ms: 1000, initial_cd_max_ms: 1000, priority: 1 });
    const enrage = ability({ id: 2, trigger: "hp_below", trigger_value: 30, priority: 5 });
    const opener = ability({ id: 3, trigger: "on_aggro" });
    const kick = ability({ id: 4, trigger: "target_casting" });
    const list = [timer, enrage, opener, kick];
    abilityOps.resetAbilityStates(states, list, 0, () => 0);

    const cond = (now: number, hp = 100, casting = false) => ({ now, healthPct: hp, inCombat: true, victimCasting: casting });
    expect(abilityOps.readyAbilities(list, states, cond(0)).map((a) => a.id)).toEqual([3]);
    abilityOps.markUsed(opener, states, 0, () => 0);
    expect(abilityOps.readyAbilities(list, states, cond(1000, 25, true)).map((a) => a.id)).toEqual([2, 1, 4]);
    abilityOps.markUsed(enrage, states, 1000, () => 0);
    expect(abilityOps.readyAbilities(list, states, cond(99999, 10)).map((a) => a.id)).toEqual([1]);
    expect(abilityOps.isTriggered(ability({ trigger: "on_death" }), { nextReadyAt: 0, fired: false }, cond(0))).toBe(false);
  });
});

describe("creature casting", () => {
  function caster(over: any = {}, spellOver: any = {}, abilityOver: any = {}) {
    const ctx = setup({ stance: "neutral", ...over });
    ctx.spells.set(100, spell(spellOver));
    ctx.abilities.set(1, [ability(abilityOver)]);
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y, { health: 1000, maxHealth: 1000 });
    ctx.registry.add(c);
    const p = ctx.addPlayer("p", tile(14, 10));
    return { ...ctx, c, p };
  }

  test("casts with a cast bar, then damages the target", () => {
    const { system, c, events, setRoll } = caster();
    setRoll(0.5);
    system.damageCreature(c, "p", 1, 0);
    system.tick(c, 100);
    expect(c.casting?.spellName).toBe("shadow_bolt");
    expect(events.casts[0]).toMatchObject({ phase: "start", spell: "shadow_bolt" });
    run(system, c, 200, 2000);
    expect(c.casting).not.toBeNull();
    system.tick(c, 2100);
    expect(c.casting).toBeNull();
    expect(events.casts.at(-1)).toMatchObject({ phase: "end", result: "success" });
    expect(events.damage.some((d: any) => d.playerId === "p")).toBe(true);
  });

  test("casting stops melee swings", () => {
    const { system, c, events, p } = caster();
    p.x = c.x + 10;
    system.damageCreature(c, "p", 1, 0);
    system.tick(c, 100);
    expect(c.casting).not.toBeNull();
    const swings = events.damage.length;
    run(system, c, 200, 1500);
    expect(events.damage.length).toBe(swings);
  });

  test("interrupt cancels interruptible casts and locks out casting", () => {
    const { system, c, events } = caster();
    system.damageCreature(c, "p", 1, 0);
    system.tick(c, 100);
    system.applySpellToCreature(c, "p", { name: "kick", effects: [{ type: "interrupt", value: 0, duration: 4 }] } as any, 500);
    expect(c.casting).toBeNull();
    expect(events.casts.at(-1)).toMatchObject({ phase: "end", result: "interrupted" });
    expect(auraOps.isCastLockedOut(c.auras, 4000)).toBe(true);
    expect(events.texts.at(-1).kind).toBe("interrupted");
  });

  test("dying mid-cast ends the cast quietly, not as interrupted", () => {
    const { system, c, events } = caster();
    system.damageCreature(c, "p", 1, 0);
    system.tick(c, 100);
    expect(c.casting).not.toBeNull();

    system.damageCreature(c, "p", c.health + 100, 500);
    expect(c.state).toBe("dead");
    expect(c.casting).toBeNull();
    expect(events.casts.at(-1)).toMatchObject({ phase: "end", result: "failed" });
    expect(events.texts.some((t: any) => t.kind === "interrupted")).toBe(false);
  });

  test("uninterruptible casts ignore interrupts but stuns still break them", () => {
    const { system, c, events } = caster({}, {}, { interruptible: 0 });
    system.damageCreature(c, "p", 1, 0);
    system.tick(c, 100);
    system.applySpellToCreature(c, "p", { name: "kick", effects: [{ type: "interrupt", value: 0 }] } as any, 500);
    expect(c.casting).not.toBeNull();
    system.applySpellToCreature(c, "p", { name: "hammer", effects: [{ type: "stun", value: 0, duration: 2 }] } as any, 600);
    expect(c.casting).toBeNull();
    expect(events.casts.at(-1).result).toBe("interrupted");
    const swings = events.damage.length;
    run(system, c, 700, 2500);
    expect(events.damage.length).toBe(swings);
  });

  test("stun immunity flag", () => {
    const { system, c, events } = caster({ flags: CreatureFlags.IMMUNE_STUN });
    system.applySpellToCreature(c, "p", { name: "hammer", effects: [{ type: "stun", value: 0, duration: 2 }] } as any, 0);
    expect(auraOps.isStunned(c.auras, 100)).toBe(false);
    expect(events.texts.at(-1).kind).toBe("immune");
  });

  test("target moving out of range fails the cast", () => {
    const { system, c, p, events } = caster();
    system.damageCreature(c, "p", 1, 0);
    system.tick(c, 100);
    p.x = c.x + 2000;
    run(system, c, 200, 2200);
    expect(events.casts.some((e: any) => e.phase === "end" && e.result === "failed")).toBe(true);
  });

  test("hp_below fires once; effects on players go through the engine", () => {
    const { system, c, events } = caster({}, { cast_time: 0, damage: 0, effects: [{ type: "stun", value: 0, duration: 1 }] }, { trigger: "hp_below", trigger_value: 50 });
    system.damageCreature(c, "p", 400, 0);
    system.tick(c, 100);
    expect(events.playerEffects.length).toBe(0);
    system.damageCreature(c, "p", 200, 200);
    system.tick(c, 300);
    expect(events.playerEffects).toEqual([{ playerId: "p", spell: "shadow_bolt" }]);
    run(system, c, 400, 20000);
    expect(events.playerEffects.length).toBe(1);
  });

  test("on_death abilities fire when the creature dies", () => {
    const { system, c, events } = caster({}, { cast_time: 0, damage: 30, aoe_radius: 500 }, { trigger: "on_death" });
    c.health = 5;
    system.damageCreature(c, "p", 1, 0);
    system.damageCreature(c, "p", 10, 100);
    expect(c.state).toBe("dead");
    expect(events.damage.some((d: any) => d.playerId === "p")).toBe(true);
  });

  test("lowest_hp_ally heals the most injured nearby creature", () => {
    const { system, c, registry, events } = caster({}, { cast_time: 0, damage: -50 }, { target_mode: "lowest_hp_ally", max_range: 30 });
    const hurt = makeCreature(2, tile(12, 10).x, tile(12, 10).y, { health: 20, maxHealth: 100 });
    registry.add(hurt);
    system.damageCreature(c, "p", 1, 0);
    system.tick(c, 100);
    expect(hurt.health).toBeGreaterThan(20);
    expect(events.texts.some((t: any) => t.kind === "heal" && t.creatureId === 2)).toBe(true);
  });
});

describe("player effects on creatures", () => {
  test("DoT ticks damage, taps and pulls the creature", () => {
    const { registry, system, addPlayer } = setup({ stance: "neutral" });
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y, { health: 100, maxHealth: 100 });
    registry.add(c);
    addPlayer("p", tile(14, 10), { username: "P" });
    system.applySpellToCreature(c, "p", { name: "rend", effects: [{ type: "damage_over_time", value: 7, duration: 6, interval: 1 }] } as any, 0);
    system.tick(c, 1000);
    expect(c.health).toBe(93);
    expect(c.state).toBe("combat");
    expect(c.combat.tapper?.playerId).toBe("p");
  });

  test("DoT ticks include the caster's damage stat share (classic WoW)", () => {
    const { registry, system, addPlayer } = setup({ stance: "neutral" });
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y, { health: 1000, maxHealth: 1000 });
    registry.add(c);
    // 6s every 1s = 6 ticks sharing 6/15 of 60 = 24 -> +4 per tick on top of 7.
    addPlayer("p", tile(14, 10), { statDamage: 60 });
    system.applySpellToCreature(c, "p", { name: "rend", effects: [{ type: "damage_over_time", value: 7, duration: 6, interval: 1 }] } as any, 0);
    system.tick(c, 1000);
    expect(c.health).toBe(1000 - 11);
  });

  test("slows reduce chase speed", () => {
    const distances: number[] = [];
    for (const slowed of [false, true]) {
      const ctx = setup();
      const c = makeCreature(1, tile(5, 10).x, tile(5, 10).y);
      ctx.registry.add(c);
      ctx.addPlayer("p", tile(40, 10));
      ctx.system.damageCreature(c, "p", 1, 0);
      if (slowed) ctx.system.applySpellToCreature(c, "p", { name: "frost", effects: [{ type: "slow", value: 50, duration: 10 }] } as any, 0);
      run(ctx.system, c, 100, 1500);
      distances.push(c.x - tile(5, 10).x);
    }
    expect(distances[1]).toBeLessThan(distances[0] * 0.7);
  });

  test("taunt forces the victim; NO_TAUNT creatures are immune", () => {
    const { registry, system, addPlayer } = setup({ stance: "neutral" });
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y, { health: 10000, maxHealth: 10000 });
    registry.add(c);
    addPlayer("dps", tile(11, 10));
    addPlayer("tank", tile(9, 10));
    system.damageCreature(c, "dps", 500, 0);
    system.tick(c, 100);
    expect(c.combat.threat.victimId).toBe("dps");
    system.applySpellToCreature(c, "tank", { name: "taunt", effects: [{ type: "taunt", value: 0, duration: 3 }] } as any, 200);
    system.tick(c, 300);
    expect(c.combat.threat.victimId).toBe("tank");
    expect(c.combat.threat.threatOf("tank")).toBe(500);

    const immune = setup({ stance: "neutral", flags: CreatureFlags.NO_TAUNT });
    const c2 = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    immune.registry.add(c2);
    immune.addPlayer("tank", tile(9, 10));
    immune.system.applySpellToCreature(c2, "tank", { name: "taunt", effects: [{ type: "taunt", value: 0 }] } as any, 0);
    expect(immune.events.texts.at(-1).kind).toBe("immune");
  });

  test("feign death drops threat (resisted by higher levels) and threat effects scale it", () => {
    const { registry, system, addPlayer, setRoll } = setup({ stance: "neutral" });
    const even = makeCreature(1, tile(10, 10).x, tile(10, 10).y, { level: 10, health: 10000, maxHealth: 10000 });
    const high = makeCreature(2, tile(12, 10).x, tile(12, 10).y, { level: 20, health: 10000, maxHealth: 10000 });
    registry.add(even);
    registry.add(high);
    addPlayer("hunter", tile(11, 10), { level: 10 });
    addPlayer("tank", tile(11, 11), { level: 10 });
    for (const c of [even, high]) {
      system.damageCreature(c, "hunter", 100, 0);
      system.damageCreature(c, "tank", 50, 0);
    }
    system.modifyThreatEverywhere("hunter", -50);
    expect(even.combat.threat.threatOf("hunter")).toBe(50);
    setRoll(0.5);
    expect(system.feignDeath("hunter", 10, 100)).toBe(1);
    expect(even.combat.threat.has("hunter")).toBe(false);
    expect(high.combat.threat.has("hunter")).toBe(true);
  });

  test("evading clears auras", () => {
    const { registry, system, addPlayer } = setup({ stance: "neutral" });
    const c = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
    registry.add(c);
    addPlayer("p", tile(11, 10));
    system.applySpellToCreature(c, "p", { name: "rend", effects: [{ type: "damage_over_time", value: 1, duration: 60, interval: 1 }, { type: "slow", value: 50, duration: 60 }] } as any, 0);
    system.evade(c, 100);
    expect(c.auras.dots.length).toBe(0);
    expect(auraOps.slowMultiplier(c.auras, 200)).toBe(1);
  });
});
