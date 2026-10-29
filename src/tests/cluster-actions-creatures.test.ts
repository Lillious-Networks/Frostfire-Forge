import { expect, mock, spyOn, test } from "bun:test";
import { databaseModule, mockQuery } from "./setup";

mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { createCombatState } = await import("../systems/creatures/threat");
const { CreatureCombatSystem } = await import("../systems/creatures/engine");
const { CreatureRegistry } = await import("../systems/creatures/registry");
const { NavGrid } = await import("../systems/creatures/navgrid");
const { normalizeTemplate, normalizeSpawn } = await import("../systems/creatures/repository");
const { createAuras } = await import("../systems/creatures/auras");

// Hits on a mirrored creature go to its owner; the owner applies them. One engine
// plays both nodes: a mirror (remote) records what it forwards, and a local
// creature takes what the owner would be handed.

function makeCreature(id: number, x: number, y: number, over: any = {}) {
  return {
    id, templateId: 1, spawnId: 1, poolId: null, map: "main", layerId: null, x, y, dir: "down",
    homeX: x, homeY: y, level: 10, health: 100, maxHealth: 100, state: "idle" as any, spawnedAt: 0,
    move: null, waitUntil: 0, patrolIndex: 0, patrolForward: true, sentX: x, sentY: y, sentDir: "down",
    sentMoving: false, combat: createCombatState(), auras: createAuras(), casting: null, abilityStates: new Map(), ...over,
  };
}

function setup() {
  const registry = new CreatureRegistry(128);
  const template = normalizeTemplate({
    id: 1, name: "Wolf", level_min: 10, level_max: 10, damage_min: 10, damage_max: 10, attack_speed_ms: 2000,
    move_speed_run: 7, armor: 0, creature_type: "humanoid",
  });
  const spawn = normalizeSpawn({ id: 1, template_id: 1, map: "main" });
  const players = new Map<string, any>();
  const forwarded: any[] = [];
  const texts: any[] = [];
  const marked: string[] = [];
  const grid = new NavGrid(60, 30, 32, 32, new Uint8Array(60 * 30));
  const system = new CreatureCombatSystem(registry, {
    rng: () => 0.5,
    template: () => template,
    spawn: () => spawn,
    patrol: () => undefined,
    grid: () => grid,
    getPlayer: (id) => players.get(id) ?? null,
    playersNear: () => [],
    damagePlayer: () => {},
    dazePlayer: () => {},
    markPlayerInCombat: (id) => marked.push(id),
    onHealthChanged: () => {},
    onStateChanged: () => {},
    onCombatText: (text) => texts.push(text),
    onDied: () => {},
    onAutoAttackStopped: () => {},
    onTapChanged: () => {},
    linkedCreatures: () => [],
    spell: () => undefined,
    abilities: () => [],
    applySpellEffectsToPlayer: () => {},
    later: (_ms: number, fn: () => void) => fn(),
    onSpellLaunch: () => {},
    onCastStart: () => {},
    onCastEnd: () => {},
    onAurasChanged: () => {},
    forwardHit: (creature, hit) => forwarded.push({ id: creature.id, ...hit }),
  });
  const addPlayer = (id: string, x: number, y: number, over: any = {}) => {
    const p = {
      id, username: id, map: "main", layerId: null, x, y, dir: "up", level: 10, alive: true,
      gmHidden: false, stealthed: false, casting: false, dodgePct: 0, critPct: 0, critDamagePct: 0,
      statDamage: 7, armorPct: 0, weapon: null, ...over,
    };
    players.set(id, p);
    return p;
  };
  return { registry, system, forwarded, texts, marked, addPlayer };
}

test("a hit on a mirror is forwarded with its text, and the mirror is not changed", () => {
  const { registry, system, forwarded, texts, marked, addPlayer } = setup();
  const mirror = makeCreature(50, 100, 100, { remote: true });
  registry.add(mirror as any);
  addPlayer("p1", 110, 100);
  expect(system.damageCreature(mirror as any, "p1", 30, 1000, 2, "spell")).toBe(0);
  expect(forwarded).toEqual([{ id: 50, attackerId: "p1", amount: 30, threatMultiplier: 2, textKind: "spell" }]);
  expect(marked).toEqual(["p1"]);
  expect(mirror.health).toBe(100);
  expect(mirror.combat.tapper).toBeNull();
  expect(texts).toEqual([]);
});

test("combat text for a mirror is left to its owner", () => {
  const { registry, system, texts } = setup();
  registry.add(makeCreature(50, 100, 100, { remote: true }) as any);
  registry.add(makeCreature(51, 100, 100) as any);
  system.emitCombatText({ creatureId: 50, targetId: "creature:50", sourceId: "p1", kind: "spell", amount: 5 });
  system.emitCombatText({ creatureId: 51, targetId: "creature:51", sourceId: "p1", kind: "spell", amount: 5 });
  expect(texts.map((t) => t.creatureId)).toEqual([51]);
});

test("a local hit with a text kind shows the text once, with the damage dealt", () => {
  const { registry, system, texts } = setup();
  const local = makeCreature(51, 100, 100, { health: 20 });
  registry.add(local as any);
  expect(system.damageCreature(local as any, "p1", 30, 1000, 1, "spell")).toBe(20);
  expect(texts).toEqual([{ creatureId: 51, targetId: "creature:51", sourceId: "p1", kind: "spell", amount: 20 }]);
});

test("an auto-attack swing on a mirror is rolled here and forwarded", () => {
  const { registry, system, forwarded, texts, addPlayer } = setup();
  const mirror = makeCreature(50, 100, 100, { remote: true });
  registry.add(mirror as any);
  addPlayer("p1", 100, 110);
  expect(system.startAutoAttack("p1", 50, 1000)).toBeNull();
  system.tickPlayerAttacks(1000);
  expect(forwarded.length).toBe(1);
  expect(forwarded[0].attackerId).toBe("p1");
  expect(typeof forwarded[0].textKind).toBe("string");
  expect(texts).toEqual([]);
  expect(mirror.health).toBe(100);
});

test("the owner applies a forwarded hit: damage, text, threat and tap", () => {
  const { registry, system, texts, addPlayer } = setup();
  const owned = makeCreature(51, 100, 100);
  registry.add(owned as any);
  // The attacker is a mirror on the owner: the world's getPlayer finds it.
  addPlayer("p1", 110, 100);
  expect(system.applyForwardedHit(owned as any, { attackerId: "p1", amount: 30, threatMultiplier: 1, textKind: "hit" }, 1000)).toEqual({ landed: true, killed: false });
  expect(owned.health).toBe(70);
  expect(texts).toEqual([{ creatureId: 51, targetId: "creature:51", sourceId: "p1", kind: "hit", amount: 30 }]);
  expect(owned.combat.tapper).toEqual({ playerId: "p1", username: "p1" });
  expect(owned.combat.threat.top()).toBe("p1");
  expect(system.applyForwardedHit(owned as any, { attackerId: "p1", amount: 500, threatMultiplier: 1, textKind: "hit" }, 1100)).toEqual({ landed: true, killed: true });
  expect(system.applyForwardedHit(owned as any, { attackerId: "p1", amount: 5, threatMultiplier: 1, textKind: "hit" }, 1200)).toEqual({ landed: false, killed: false });
});

test("an avoided forwarded swing deals nothing but still pulls and taps", () => {
  const { registry, system, texts, addPlayer } = setup();
  const owned = makeCreature(51, 100, 100);
  registry.add(owned as any);
  addPlayer("p1", 110, 100);
  system.applyForwardedHit(owned as any, { attackerId: "p1", amount: 0, threatMultiplier: 1, textKind: "dodge" as any, avoided: true }, 1000);
  expect(owned.health).toBe(100);
  expect(texts).toEqual([{ creatureId: 51, targetId: "creature:51", sourceId: "p1", kind: "dodge", amount: 0 }]);
  expect(owned.combat.tapper?.playerId).toBe("p1");
  expect(owned.state).toBe("combat");
});

test("a spell on a mirror is forwarded with the caster's damage stat, and the owner uses it", () => {
  const { registry, system, forwarded, addPlayer } = setup();
  const mirror = makeCreature(50, 100, 100, { remote: true });
  const owned = makeCreature(51, 100, 100);
  registry.add(mirror as any);
  registry.add(owned as any);
  addPlayer("p1", 110, 100);
  const spell = { id: 9, name: "Burn", effects: [{ type: "taunt" }] } as any;
  system.applySpellToCreature(mirror as any, "p1", spell, 1000);
  expect(forwarded).toEqual([{ id: 50, attackerId: "p1", amount: 0, threatMultiplier: 1, textKind: null, spell, casterStat: 7 }]);
  const applied = spyOn(system, "applySpellToCreature");
  system.applyForwardedHit(owned as any, forwarded[0], 1000);
  expect(applied).toHaveBeenCalledWith(owned, "p1", spell, 1000, 7);
});


test("a creature's spell on a mirrored ally is not forwarded: the owner would refuse any source but a player", () => {
  const { registry, system, forwarded, addPlayer } = setup();
  const mirror = makeCreature(50, 100, 100, { remote: true });
  registry.add(mirror as any);
  addPlayer("p1", 110, 100);
  const spell = { id: 9, name: "Mend", effects: [{ type: "heal_over_time", value: 5, duration: 6, interval: 1 }] } as any;
  system.applySpellToCreature(mirror as any, "creature:9", spell, 1000);
  expect(forwarded).toEqual([]);
  // The control: the same spell from a player is.
  system.applySpellToCreature(mirror as any, "p1", spell, 1000);
  expect(forwarded.length).toBe(1);
});

// ------------------------------------------------------------------ the real mod, through the links

const { linkCalls, LinkCalls } = await import("../cluster/linkcalls");
const { ghosts } = await import("../cluster/ghosts");
const { mirrorPlayers } = await import("../cluster/mirrors");
const { default: playerCache } = await import("../services/playermanager");
const { default: assetCache } = await import("../services/assetCache");
const { default: AOI } = await import("../config/aoi.json");
const { CACHE_KEYS } = await import("../systems/creatures/repository");
const { getCreatureEngineBridge, setCreatureEngineBridge } = await import("../systems/creatures/bridge");
const creatures = await import("../systems/creatures");
const { linkPair, settle } = await import("./cluster-fakelink");

// The template the creatures use, as init reads it (the same one cluster-mirror-creatures.test.ts sets).
await assetCache.set(CACHE_KEYS.templates, [normalizeTemplate({ id: 1, name: "Wolf", level_min: 5, level_max: 5, sprite_type: "none" })]);
await creatures.init();

const mod = creatures as any;
const kind = mod.creatureGhostKind;
const record = (over: any = {}) => ({
  id: 770100, templateId: 1, spawnId: 0, map: "main", layerId: null, x: 300, y: 300, dir: "down", moving: false,
  level: 5, health: 40, maxHealth: 50, state: "idle", victimId: null, tapper: null, casting: null, auras: [], ...over,
});

/** A player of node `from`, as the player kind leaves it in mirrorPlayers. */
function mirrorPlayer(id: string, from = "a", over: any = {}) {
  const mirror = {
    id, username: id, remote: true, mirrorFrom: from, isDead: false, isGhost: false, isStealth: false,
    stats: { level: 10, health: 100, stat_damage: 7 }, aoi: { layerId: null },
    location: { map: "main", position: { x: 300, y: 310, direction: "up" } }, ...over,
  };
  mirrorPlayers.set(id, mirror);
  return mirror;
}

/** The ids of the creatures these tests put in the registry or spawn as mirrors. */
const CREATURE_IDS = [770001, 770002, 770003, 770004, 770100, 770101];

function clearCreatures(): void {
  for (const id of CREATURE_IDS) {
    if (creatures.getCreature(id)?.remote) kind.despawn(id, "left");
    else creatures.registry.remove(id);
  }
}

/** Runs `fn` with the real appliers reachable from node "a", and puts every singleton back after it. */
async function over(fn: (call: (op: string, target: string | number, body: unknown) => Promise<any>) => Promise<void>): Promise<void> {
  const { a, b } = linkPair();
  const asker = new LinkCalls();
  asker.attach(a);
  linkCalls.attach(b);
  try {
    await fn((op, target, body) => asker.call("b", "APPLY_EFFECT", { op, target, body }));
  } finally {
    linkCalls.detach();
    mirrorPlayers.clear();
    clearCreatures();
  }
}

/** A creature this node owns, in the real registry. */
function owned(id: number, over: any = {}) {
  const creature = makeCreature(id, 300, 300, over);
  creatures.registry.add(creature as any);
  return creature;
}

const hitBody = (over: any = {}) => ({ attackerId: "ma", amount: 30, threatMultiplier: 1, textKind: "hit", ...over });

test("creature_hit applies the hit of a mirrored player: damage, tap, threat, then a kill", async () => {
  await over(async (call) => {
    const creature = owned(770001);
    mirrorPlayer("ma");
    expect(await call("creature_hit", 770001, hitBody())).toEqual({ ok: true, answer: { outcome: "applied" } });
    expect(creature.health).toBe(70);
    expect(creature.combat.tapper).toEqual({ playerId: "ma", username: "ma" });
    expect(creature.combat.threat.top()).toBe("ma");
    expect(await call("creature_hit", 770001, hitBody({ amount: 500 }))).toEqual({ ok: true, answer: { outcome: "killed" } });
    expect(creature.state).toBe("dead");
    expect(await call("creature_hit", 770001, hitBody())).toEqual({ ok: true, answer: { outcome: "refused", reason: "dead" } });
  });
});

test("creature_hit is refused for an attacker not mirrored from the asker, and for another layer", async () => {
  await over(async (call) => {
    const creature = owned(770001);
    mirrorPlayer("mz", "z");
    // The asker is "a"; the attacker is a player of "z".
    expect(await call("creature_hit", 770001, hitBody({ attackerId: "mz" }))).toEqual({ ok: true, answer: { outcome: "refused", reason: "attacker" } });
    expect(await call("creature_hit", 770001, hitBody({ attackerId: "nobody" }))).toEqual({ ok: true, answer: { outcome: "refused", reason: "attacker" } });
    expect(creature.health).toBe(100);

    mirrorPlayer("ma");
    const layered = owned(770002, { layerId: "L1" });
    expect(await call("creature_hit", 770002, hitBody())).toEqual({ ok: true, answer: { outcome: "refused", reason: "layer" } });
    expect(layered.health).toBe(100);
    // On the creature's layer the same hit lands.
    mirrorPlayer("ma", "a", { aoi: { layerId: "L1" } });
    expect(await call("creature_hit", 770002, hitBody())).toEqual({ ok: true, answer: { outcome: "applied" } });
    expect(layered.health).toBe(70);
  });
});

test("creature_hit finds nothing at an unknown creature, or at a mirror", async () => {
  await over(async (call) => {
    mirrorPlayer("ma");
    expect(await call("creature_hit", 999999, hitBody())).toEqual({ ok: true, answer: { outcome: "missing" } });
    // A mirror is not a creature this node owns, though its attacker would pass every other check.
    expect(kind.spawn(record({ id: 770101 }), "a")).toBe(true);
    expect(await call("creature_hit", 770101, hitBody())).toEqual({ ok: true, answer: { outcome: "missing" } });
    expect(creatures.getCreature(770101)!.health).toBe(40);
  });
});

test("creature_threat changes the threat of a mirrored player: modify, heal and feign", async () => {
  await over(async (call) => {
    const creature = owned(770001, { state: "combat" });
    mirrorPlayer("ma");
    mirrorPlayer("mb");
    mod.combat.addThreat(creature, "ma", 100, 1000);
    expect(await call("creature_threat", "ma", { kind: "modify", playerId: "ma", percent: -50 })).toEqual({ ok: true, answer: { outcome: "applied" } });
    expect(creature.combat.threat.threatOf("ma")).toBe(50);

    // The healer is not in the table yet; the healed player is. Half the amount is the threat, split by creature.
    expect(await call("creature_threat", "ma", { kind: "heal", casterId: "mb", targetId: "ma", amount: 40 })).toEqual({ ok: true, answer: { outcome: "applied" } });
    expect(creature.combat.threat.threatOf("mb")).toBe(20);

    // Level 10 against a level 5 creature: never resisted. The mirror leaves the table and the answer counts the resisted.
    expect(await call("creature_threat", "ma", { kind: "feign", playerId: "ma", level: 10 })).toEqual({ ok: true, answer: { outcome: "applied", reason: "0" } });
    expect(creature.combat.threat.has("ma")).toBe(false);
    expect(creature.combat.threat.has("mb")).toBe(true);
  });
});

test("creature_threat is refused for a player not mirrored from the asker, and changes nothing", async () => {
  await over(async (call) => {
    const creature = owned(770001, { state: "combat" });
    mod.combat.addThreat(creature, "mz", 100, 1000);
    expect(await call("creature_threat", "mz", { kind: "modify", playerId: "mz", percent: -50 })).toEqual({ ok: true, answer: { outcome: "refused", reason: "player" } });
    mirrorPlayer("mz", "z");
    expect(await call("creature_threat", "mz", { kind: "modify", playerId: "mz", percent: -50 })).toEqual({ ok: true, answer: { outcome: "refused", reason: "player" } });
    expect(creature.combat.threat.threatOf("mz")).toBe(100);
  });
});

// ------------------------------------------------------------------ a creature's attack on a mirrored player: the target's node

/**
 * A player of this node and the engine bridge that records what is done to it; both are put back. Creature 60 is a
 * mirror of the asking node's creature here, of template 1, whose one ability is spell 1 (Frost Bolt).
 */
async function atTarget(fn: (ctx: { player: any; calls: any[]; call: (body: any) => Promise<any> }) => Promise<void>): Promise<void> {
  const calls: any[] = [];
  const savedSpells = await assetCache.get("spells");
  const savedAbilities = await assetCache.get(CACHE_KEYS.abilities);
  await assetCache.set("spells", [{ id: 1, name: "Frost Bolt", effects: [] }]);
  await assetCache.set(CACHE_KEYS.abilities, [{ id: 1, template_id: 1, spell_id: 1 }]);
  await creatures.refreshSpells();
  await creatures.refreshAbilities();
  creatures.registry.add(makeCreature(60, 300, 300, { remote: true }) as any);
  const previousBridge = getCreatureEngineBridge();
  setCreatureEngineBridge({
    damagePlayer: (p, amount) => { calls.push(["damage", amount]); if (amount >= 1000) p.stats.health = 0; },
    dazePlayer: () => { calls.push(["daze"]); },
    applySpellEffects: (_p, caster, spell) => { calls.push(["spell", caster.id, spell.name]); },
  });
  const player: any = { id: "pz", username: "pz", location: { map: "main.json", position: { x: 300, y: 300 } }, stats: { health: 100 } };
  playerCache.set("pz", player);
  try {
    await over(async (call) => {
      await fn({ player, calls, call: (body) => call("creature_on_player", "pz", { creatureId: 60, creatureName: "Wolf", map: "main", layerId: null, ...body }) });
    });
  } finally {
    playerCache.remove("pz");
    setCreatureEngineBridge(previousBridge);
    creatures.registry.remove(60);
    if (savedSpells === undefined || savedSpells === null) await (typeof assetCache.remove === "function" ? assetCache.remove("spells") : assetCache.set("spells", []));
    else await assetCache.set("spells", savedSpells);
    if (savedAbilities === undefined || savedAbilities === null) await (typeof assetCache.remove === "function" ? assetCache.remove(CACHE_KEYS.abilities) : assetCache.set(CACHE_KEYS.abilities, []));
    else await assetCache.set(CACHE_KEYS.abilities, savedAbilities);
    await creatures.refreshSpells();
    await creatures.refreshAbilities();
  }
}

test("creature_on_player is refused for a creature the asker does not own", async () => {
  await atTarget(async ({ calls, call }) => {
    // Creature 60 is not a mirror held here from "a": the asker may not hurt anyone with it.
    expect(await call({ kind: "damage", amount: 12 })).toEqual({ ok: true, answer: { outcome: "refused", reason: "creature" } });
    expect(calls).toEqual([]);
  });
});

test("creature_on_player damages the player, and flags them in combat", async () => {
  await atTarget(async ({ player, calls, call }) => {
    const owner = spyOn(ghosts, "ownerOf").mockReturnValue("a");
    try {
      expect(await call({ kind: "damage", amount: 12 })).toEqual({ ok: true, answer: { outcome: "applied" } });
      expect(calls).toEqual([["damage", 12]]);
      expect(player.pvp).toBe(true);
      expect(typeof player.last_attack).toBe("number");
    } finally {
      owner.mockRestore();
    }
  });
});

test("creature_on_player runs a creature's spell on the player, and a daze", async () => {
  await atTarget(async ({ player, calls, call }) => {
    const owner = spyOn(ghosts, "ownerOf").mockReturnValue("a");
    try {
      expect(await call({ kind: "spell", spell: { id: 1, name: "Frost Bolt", effects: [] } })).toEqual({ ok: true, answer: { outcome: "applied" } });
      expect(calls).toEqual([["spell", "creature:60", "Frost Bolt"]]);
      expect(player.pvp).toBe(true);
      player.pvp = false;
      delete player.last_attack;
      // A daze names its creature like the rest, and is not a blow that puts the player in combat.
      expect(await call({ kind: "daze" })).toEqual({ ok: true, answer: { outcome: "applied" } });
      expect(calls).toEqual([["spell", "creature:60", "Frost Bolt"], ["daze"]]);
      expect(player.pvp).toBe(false);
    } finally {
      owner.mockRestore();
    }
  });
});

test("creature_on_player reports a kill, and spares a player who is dead, a ghost or hidden", async () => {
  await atTarget(async ({ player, calls, call }) => {
    const owner = spyOn(ghosts, "ownerOf").mockReturnValue("a");
    try {
      for (const flag of ["isDead", "isGhost", "isStealth"]) {
        player[flag] = true;
        expect(await call({ kind: "damage", amount: 12 })).toEqual({ ok: true, answer: { outcome: "refused", reason: "immune" } });
        player[flag] = false;
      }
      expect(calls).toEqual([]);
      expect(player.pvp).toBeUndefined();
      expect(await call({ kind: "damage", amount: 1000 })).toEqual({ ok: true, answer: { outcome: "killed" } });
    } finally {
      owner.mockRestore();
    }
  });
});

test("creature_on_player is turned away when the creature is on another map or layer than the player", async () => {
  await atTarget(async ({ calls, call }) => {
    const owner = spyOn(ghosts, "ownerOf").mockReturnValue("a");
    try {
      // The creature's map is bare and the player's is not: the same map.
      expect(await call({ kind: "damage", amount: 12 })).toEqual({ ok: true, answer: { outcome: "applied" } });
      expect(await call({ kind: "damage", amount: 12, layerId: "layer-9" })).toEqual({ ok: true, answer: { outcome: "missing", reason: "layer" } });
      expect(await call({ kind: "damage", amount: 12, map: "cave" })).toEqual({ ok: true, answer: { outcome: "missing", reason: "layer" } });
      // A body with no map is a creature the sender could not place.
      expect(await call({ kind: "damage", amount: 12, map: undefined })).toEqual({ ok: true, answer: { outcome: "missing", reason: "layer" } });
      expect(calls).toEqual([["damage", 12]]);
    } finally {
      owner.mockRestore();
    }
  });
});

// ------------------------------------------------------------------ a creature's attack on a mirrored player: the creature's node

/** What this node sends over the links, answered as `answer`. */
function sentCalls(answer: any) {
  return spyOn(linkCalls, "call").mockResolvedValue(answer as any);
}
const world = () => (mod.combat as any).world;

test("a creature here that hits a mirrored player sends one creature_on_player with its map and layer", async () => {
  const sent = sentCalls({ ok: true, answer: { outcome: "applied" } });
  try {
    const creature = owned(770001, { layerId: "L1" });
    mirrorPlayer("mq", "a");
    world().damagePlayer(creature, "mq", 12, "crit");
    world().applySpellEffectsToPlayer(creature, "mq", { id: 4, name: "Bolt", effects: [] });
    world().dazePlayer("mq", creature);
    await settle();
    expect(sent.mock.calls).toEqual([
      ["a", "APPLY_EFFECT", { op: "creature_on_player", target: "mq", body: { kind: "damage", creatureId: 770001, creatureName: "Wolf", amount: 12, isCrit: true, map: "main", layerId: "L1" } }],
      ["a", "APPLY_EFFECT", { op: "creature_on_player", target: "mq", body: { kind: "spell", creatureId: 770001, creatureName: "Wolf", spell: { id: 4, name: "Bolt", effects: [] }, map: "main", layerId: "L1" } }],
      ["a", "APPLY_EFFECT", { op: "creature_on_player", target: "mq", body: { kind: "daze", creatureId: 770001, creatureName: "Wolf", map: "main", layerId: "L1" } }],
    ]);
    // A player nobody mirrors gets nothing sent.
    sent.mockClear();
    world().damagePlayer(creature, "nobody", 12, "hit");
    await settle();
    expect(sent).not.toHaveBeenCalled();
  } finally {
    sent.mockRestore();
    mirrorPlayers.clear();
    clearCreatures();
  }
});

test("a spell that lands after its creature is gone still carries the creature's map and layer", async () => {
  const sent = sentCalls({ ok: true, answer: { outcome: "applied" } });
  try {
    // Not in the registry: the creature was removed while the projectile flew.
    const creature = makeCreature(770003, 300, 300, { layerId: "L2" });
    mirrorPlayer("mq", "a");
    world().applySpellEffectsToPlayer(creature, "mq", { id: 4, name: "Bolt", effects: [] });
    await settle();
    expect(sent.mock.calls[0]![2]).toMatchObject({ body: { kind: "spell", map: "main", layerId: "L2" } });
  } finally {
    sent.mockRestore();
    mirrorPlayers.clear();
  }
});

test("a killed answer takes the mirrored player out of the creature's threat table", async () => {
  const sent = sentCalls({ ok: true, answer: { outcome: "killed" } });
  try {
    const creature = owned(770001, { state: "combat" });
    mirrorPlayer("mq", "a");
    mod.combat.addThreat(creature, "mq", 100, 1000);
    expect(creature.combat.threat.has("mq")).toBe(true);
    world().damagePlayer(creature, "mq", 12, "hit");
    await settle();
    expect(creature.combat.threat.has("mq")).toBe(false);
  } finally {
    sent.mockRestore();
    mirrorPlayers.clear();
    clearCreatures();
  }
});

test("a link that fails while a creature attacks a mirrored player leaves no unhandled rejection", async () => {
  const sent = spyOn(linkCalls, "call").mockRejectedValue(new Error("link gone"));
  try {
    const creature = owned(770001);
    mirrorPlayer("mq", "a");
    world().damagePlayer(creature, "mq", 12, "hit");
    await settle();
    expect(sent).toHaveBeenCalledTimes(1);
  } finally {
    sent.mockRestore();
    mirrorPlayers.clear();
    clearCreatures();
  }
});

// ------------------------------------------------------------------ a player's hit on a mirrored creature: the player's node

test("a swing the owner turns away ends the auto-attack; one it takes, or a spell it refuses, does not", async () => {
  const owner = spyOn(ghosts, "ownerOf").mockReturnValue("a");
  const attacker: any = { id: "pl", username: "pl", location: { map: "main", position: { x: 300, y: 310, direction: "up" } }, stats: { level: 10, health: 100 } };
  playerCache.set("pl", attacker);
  let sent = sentCalls({ ok: true, answer: { outcome: "applied" } });
  try {
    expect(kind.spawn(record({ id: 770004 }), "a")).toBe(true);
    const swing = async (answer: any, now: number) => {
      sent.mockRestore();
      sent = sentCalls(answer);
      expect(creatures.startAutoAttack(attacker, 770004)).toBeNull();
      mod.combat.tickPlayerAttacks(now);
      await settle();
      expect(sent).toHaveBeenCalledTimes(1);
      expect(sent.mock.calls[0]![2]).toMatchObject({ op: "creature_hit", target: 770004 });
    };
    await swing({ ok: true, answer: { outcome: "applied" } }, Date.now() + 1000);
    expect(mod.combat.autoAttackTarget("pl")).toBe(770004);
    const turnedAway: any[] = [
      { ok: true, answer: { outcome: "refused", reason: "layer" } },
      { ok: true, answer: { outcome: "refused", reason: "attacker" } },
      { ok: true, answer: { outcome: "refused", reason: "dead" } },
      { ok: true, answer: { outcome: "missing" } },
      { ok: false, why: "down" },
    ];
    for (const answer of turnedAway) {
      mod.combat.stopAutoAttack("pl", false);
      await swing(answer, Date.now() + 1000);
      expect(mod.combat.autoAttackTarget("pl")).toBeNull();
    }
    // A spell is not an auto-attack: its refusal leaves the swing going.
    mod.combat.stopAutoAttack("pl", false);
    expect(creatures.startAutoAttack(attacker, 770004)).toBeNull();
    sent.mockRestore();
    sent = sentCalls({ ok: true, answer: { outcome: "refused", reason: "layer" } });
    mod.combat.applySpellToCreature(creatures.getCreature(770004), "pl", { id: 9, name: "Burn", effects: [{ type: "taunt" }] }, 1);
    await settle();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(mod.combat.autoAttackTarget("pl")).toBe(770004);
  } finally {
    sent.mockRestore();
    owner.mockRestore();
    mod.combat.stopAutoAttack("pl", false);
    playerCache.remove("pl");
    clearCreatures();
  }
});

/** A mirrored creature and a player of this node standing at it, with `ghosts.ownerOf` answering "a". */
async function withMirrorTarget(fn: (attacker: any) => Promise<void>): Promise<void> {
  const owner = spyOn(ghosts, "ownerOf").mockReturnValue("a");
  const attacker: any = { id: "pl", username: "pl", location: { map: "main", position: { x: 300, y: 310, direction: "up" } }, stats: { level: 10, health: 100 } };
  playerCache.set("pl", attacker);
  try {
    expect(kind.spawn(record({ id: 770004 }), "a")).toBe(true);
    await fn(attacker);
  } finally {
    owner.mockRestore();
    mod.combat.stopAutoAttack("pl", false);
    playerCache.remove("pl");
    clearCreatures();
  }
}

test("a refused hit on a mirror leaves the attacker's auto-attack on another creature running", async () => {
  await withMirrorTarget(async (attacker) => {
    owned(770001);
    const sent = sentCalls({ ok: true, answer: { outcome: "refused", reason: "layer" } });
    try {
      expect(creatures.startAutoAttack(attacker, 770001)).toBeNull();
      // A zone tick, say, on the mirror: it is refused, and it is not what the player is swinging at.
      mod.combat.damageCreature(creatures.getCreature(770004), "pl", 5, Date.now(), 1, "spell");
      await settle();
      expect(sent).toHaveBeenCalledTimes(1);
      expect(sent.mock.calls[0]![2]).toMatchObject({ op: "creature_hit", target: 770004 });
      expect(mod.combat.autoAttackTarget("pl")).toBe(770001);
    } finally {
      sent.mockRestore();
    }
  });
});

test("a swing whose link call rejects throws nothing and leaves no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const record_ = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", record_);
  const sent = spyOn(linkCalls, "call").mockRejectedValue(new Error("link gone"));
  try {
    await withMirrorTarget(async (attacker) => {
      expect(creatures.startAutoAttack(attacker, 770004)).toBeNull();
      expect(() => mod.combat.tickPlayerAttacks(Date.now() + 1000)).not.toThrow();
      await settle();
      expect(sent).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    });
  } finally {
    sent.mockRestore();
    process.off("unhandledRejection", record_);
  }
});

// ------------------------------------------------------------------ aggro on a mirrored player

test("a creature sees mirrored players near it: from the grid when it is on, from the mirror store when it is off", () => {
  const mirror = mirrorPlayer("mq", "a");
  const was = (AOI as any).USE_SPATIAL_GRID;
  try {
    (AOI as any).USE_SPATIAL_GRID = false;
    expect(world().playersNear("main", 300, 300, 100).map((u: any) => u.id)).toEqual(["mq"]);
    expect(world().playersNear("main", 900, 900, 100)).toEqual([]);
    expect(world().playersNear("cave", 300, 300, 100)).toEqual([]);
    // The grid does not hold this mirror, and the store is not read as well: nothing to count twice.
    (AOI as any).USE_SPATIAL_GRID = true;
    expect(world().playersNear("main", 300, 300, 100)).toEqual([]);
    // A mirror is a player to the combat system whichever way it is found.
    expect(world().getPlayer("mq")).toMatchObject({ id: "mq", map: "main", x: 300, y: 310, layerId: null, level: 10, alive: true, statDamage: 7 });
    mirror.isDead = true;
    expect(world().getPlayer("mq").alive).toBe(false);
  } finally {
    (AOI as any).USE_SPATIAL_GRID = was;
    mirrorPlayers.clear();
  }
});
