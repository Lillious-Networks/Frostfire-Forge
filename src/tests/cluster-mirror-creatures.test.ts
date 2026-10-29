import { expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// The rows the stub database answers with, by table name (no table named: none). Only the last test reads any.
const tableRows: Record<string, any[]> = {};
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string) => {
    const table = Object.keys(tableRows).find((name) => sql.includes(name));
    return table ? tableRows[table]! : [];
  },
}));

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

const { createCombatState } = await import("../systems/creatures/threat");
const { CreatureCombatSystem } = await import("../systems/creatures/engine");
const { CreatureRegistry } = await import("../systems/creatures/registry");
const { NavGrid, FOOT_H } = await import("../systems/creatures/navgrid");
const { normalizeTemplate, normalizeSpawn } = await import("../systems/creatures/repository");
const { createAuras } = await import("../systems/creatures/auras");

// ------------------------------------------------------------------ engine (helpers from creature-combat.test.ts)

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

function setup(templateOver: any = {}) {
  const registry = new CreatureRegistry(128);
  const template = normalizeTemplate({
    id: 1, name: "Wolf", level_min: 10, level_max: 10, damage_min: 10, damage_max: 10, attack_speed_ms: 2000,
    move_speed_run: 7, armor: 0, creature_type: "humanoid", ...templateOver,
  });
  const spawn = normalizeSpawn({ id: 1, template_id: 1, map: "main" });
  const players = new Map<string, any>();
  const events: any = { damage: [] as any[], died: [] as any[] };
  const grid = openGrid();
  const system = new CreatureCombatSystem(registry, {
    rng: () => 0.5,
    template: () => template,
    spawn: () => spawn,
    patrol: () => undefined,
    grid: () => grid,
    getPlayer: (id) => players.get(id) ?? null,
    playersNear: (map, x, y, r) => [...players.values()].filter((p) => p.map === map && Math.hypot(p.x - x, p.y - y) <= r),
    damagePlayer: (_c, playerId, amount, outcome) => events.damage.push({ playerId, amount, outcome }),
    dazePlayer: () => {},
    markPlayerInCombat: () => {},
    onHealthChanged: () => {},
    onStateChanged: () => {},
    onCombatText: () => {},
    onDied: (c, killer) => events.died.push({ id: c.id, killer }),
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
  return { registry, system, events, addPlayer };
}

test("the combat system never writes to a mirror", () => {
  const { registry, system, addPlayer, events } = setup();
  const mirror = makeCreature(50, 100, 100, { remote: true });
  registry.add(mirror as any);
  addPlayer("p1", { x: 110, y: 100 });
  const now = 1000;
  expect(system.damageCreature(mirror as any, "p1", 30, now)).toBe(0);
  system.addThreat(mirror as any, "p1", 100, now);
  system.enterCombat(mirror as any, now);
  system.tick(mirror as any, now + 100);
  system.die(mirror as any, "p1", now);
  expect(system.interruptCreature(mirror as any, 2000, now)).toBe(false);
  expect(mirror.health).toBe(100);
  expect(mirror.state).toBe("idle");
  expect(mirror.combat.threat.top()).toBeNull();
  expect(mirror.combat.tapper).toBeNull();
  expect(events.died).toEqual([]);
});

test("allies called for help skip mirrors, and still answer when local", () => {
  const { registry, system, addPlayer } = setup({ stance: "neutral", assist_radius: 10 });
  const puller = makeCreature(1, tile(10, 10).x, tile(10, 10).y);
  const mirror = makeCreature(2, tile(12, 10).x, tile(12, 10).y, { remote: true });
  const buddy = makeCreature(3, tile(10, 12).x, tile(10, 12).y);
  for (const c of [puller, mirror, buddy]) registry.add(c as any);
  addPlayer("p1", tile(9, 10));
  system.damageCreature(puller as any, "p1", 1, 1000);
  expect(puller.state).toBe("combat");
  // The control: a local ally as near as the mirror is pulled.
  expect(buddy.state).toBe("combat");
  expect(mirror.state).toBe("idle");
  expect(mirror.combat.threat.top()).toBeNull();
});

// ------------------------------------------------------------------ the real creature module

const creatures = await import("../systems/creatures");
// Without --parallel the test files share one process: a creature another file left in the registry is not this file's.
for (const left of [...creatures.registry.all()]) creatures.registry.remove(left.id);
const { ghosts } = await import("../cluster/ghosts");

const record = (over: any = {}) => ({
  id: 777001, templateId: 1, spawnId: 0, map: "main", layerId: null, x: 300, y: 300, dir: "down", moving: false,
  level: 5, health: 40, maxHealth: 50, state: "idle", victimId: null, tapper: null, casting: null, auras: [], ...over,
});

test("a creature mirror is in the registry, targetable, and leaves cleanly", () => {
  const kind = (creatures as any).creatureGhostKind;
  expect(kind.spawn(record(), "a")).toBe(true);
  const mirror = creatures.getCreature(777001)!;
  expect(mirror.remote).toBe(true);
  // Phase 5: a mirror is targetable; what is done to it goes to its owner.
  expect(creatures.isTargetableBy({ id: "p", location: { map: "main", position: { x: 300, y: 300 } } }, mirror)).toBe(true);
  // "p" is not a player of this node, so the engine refuses it as dead; the mirror itself is no longer refused.
  expect(creatures.startAutoAttack({ id: "p", location: { map: "main", position: { x: 300, y: 300 } } }, 777001)).toBe("dead");
  kind.update(777001, { health: 10 });
  expect(creatures.getCreature(777001)!.health).toBe(10);
  kind.update(777001, { victimId: "p" });
  expect(creatures.getCreature(777001)!.combat.threat.victimId).toBe("p");
  kind.update(777001, { victimId: null });
  expect(creatures.getCreature(777001)!.combat.threat.victimId).toBeNull();
  kind.move(777001, 340, 300, 3, 2);
  expect(creatures.getCreature(777001)!.x).toBe(340);
  expect(creatures.getCreature(777001)!.move).not.toBeNull();
  kind.despawn(777001, "left");
  expect(creatures.getCreature(777001)).toBeUndefined();
});

test("a resent spawn replaces the mirror: fields it leaves out are cleared", () => {
  const kind = (creatures as any).creatureGhostKind;
  kind.spawn(record({ casting: { spell: "Bolt" }, tapper: { playerId: "x", username: "x" } }), "a");
  expect(kind.spawn(record({ health: 20, x: 320 }), "a")).toBe(true);
  const mirror = creatures.getCreature(777001)!;
  expect(mirror.health).toBe(20);
  expect(mirror.x).toBe(320);
  expect(mirror.casting).toBeNull();
  expect(mirror.combat.tapper).toBeNull();
  kind.despawn(777001, "left");
});

test("a creature record with a position that is not a number is refused, and a move to one is ignored", () => {
  const kind = (creatures as any).creatureGhostKind;
  for (const bad of [Number.NaN, null, "300", Infinity]) {
    expect(kind.spawn(record({ x: bad }), "a")).toBe(false);
    expect(kind.spawn(record({ y: bad }), "a")).toBe(false);
    expect(kind.spawn(record({ templateId: bad }), "a")).toBe(false);
  }
  expect(kind.spawn(record({ map: 5 }), "a")).toBe(false);
  expect(creatures.getCreature(777001)).toBeUndefined();

  expect(kind.spawn(record(), "a")).toBe(true);
  // A resend with a bad position leaves the mirror as it was.
  expect(kind.spawn(record({ x: Number.NaN }), "a")).toBe(false);
  expect(creatures.getCreature(777001)!.x).toBe(300);
  kind.move(777001, Number.NaN, 300, 3, 2);
  kind.move(777001, 340, Infinity, 3, 2);
  expect(creatures.getCreature(777001)!.x).toBe(300);
  expect(creatures.getCreature(777001)!.y).toBe(300);
  kind.despawn(777001, "left");
});

test("a spawn never replaces a local creature", () => {
  const kind = (creatures as any).creatureGhostKind;
  const fake = { id: 777002, map: "main", layerId: null, x: 1, y: 1 } as any;
  creatures.registry.add({ ...fake, templateId: 1, combat: { threat: { victimId: null } } });
  expect(kind.spawn(record({ id: 777002, x: 9, y: 9, level: 1, health: 1, maxHealth: 1 }), "a")).toBe(false);
  expect(creatures.getCreature(777002)!.x).toBe(1);
  // Nor does a despawn sent for it remove it.
  kind.despawn(777002, "gone");
  expect(creatures.getCreature(777002)).toBeDefined();
  creatures.registry.remove(777002);
});

test("the owner's candidates and snapshots leave mirrors out", () => {
  const kind = (creatures as any).creatureGhostKind;
  kind.spawn(record({ id: 777003 }), "a");
  expect([...kind.candidates()].some((c: any) => c.id === 777003)).toBe(false);
  expect(kind.snapshot(777003)).toBeNull();
  expect(kind.state(777003)).toBeNull();
  expect(kind.motion(777003)).toBeNull();
  kind.despawn(777003, "left");
});

test("the creature kind is registered with the ghosts", () => {
  expect((ghosts as any).kinds.get("creature")).toBe((creatures as any).creatureGhostKind);
});

// ------------------------------------------------------------------ the remaining engine guards

test("call for help, lowest-hp-ally, heals, spells and cast cancels skip a mirror", () => {
  const { registry, system, addPlayer } = setup({ stance: "neutral", call_for_help_radius: 15 });
  const caller = makeCreature(1, tile(10, 10).x, tile(10, 10).y, { health: 90 });
  const mirror = makeCreature(2, tile(12, 10).x, tile(12, 10).y, { remote: true, health: 10 });
  const buddy = makeCreature(3, tile(10, 12).x, tile(10, 12).y, { health: 50 });
  for (const c of [caller, mirror, buddy]) registry.add(c as any);
  addPlayer("p1", tile(9, 10));
  const now = 1000;
  caller.combat.threat.add("p1", 10, now);
  const template = (system as any).world.template(1);
  (system as any).callForHelp(caller, template, now);
  expect(buddy.state).toBe("combat");
  expect(mirror.state).toBe("idle");
  expect(mirror.combat.threat.top()).toBeNull();

  // The mirror is the most hurt, yet the local buddy is picked.
  const target = system.pickAbilityTarget(caller as any, template, { target_mode: "lowest_hp_ally", max_range: 50 } as any, {} as any, null);
  expect(target).toEqual({ kind: "creature", id: "3" });

  (system as any).healCreature(mirror, 50, "p1");
  expect(mirror.health).toBe(10);
  (system as any).healCreature(buddy, 10, "p1");
  expect(buddy.health).toBe(60);

  const burn = { name: "Burn", effects: [{ type: "damage_over_time", value: 5, duration: 10, interval: 1 }] } as any;
  system.applySpellToCreature(mirror as any, "p1", burn, now);
  expect(mirror.auras.dots).toEqual([]);
  system.applySpellToCreature(buddy as any, "p1", burn, now);
  expect(buddy.auras.dots.length).toBe(1);

  const cast = { spellName: "Bolt", interruptible: true, startedAt: now, endsAt: now + 1000, target: { kind: "player", id: "p1" } };
  (mirror as any).casting = { ...cast };
  expect(system.cancelCast(mirror as any, "failed")).toBe(false);
  expect(mirror.casting).not.toBeNull();
  (buddy as any).casting = { ...cast };
  expect(system.cancelCast(buddy as any, "failed")).toBe(true);
});

// ------------------------------------------------------------------ the module with a viewer and a template

const { default: assetCache } = await import("../services/assetCache");
const { CACHE_KEYS } = await import("../systems/creatures/repository");
const { listener, Events } = await import("../systems/events");
const playerCache = (await import("../services/playermanager")).default;
// Without --parallel the test files share one process: a player another file left in the cache is not this file's.
playerCache.clear();
const mapIndex = (await import("../services/mapindex")).default;
const { corpseLoot } = await import("../systems/creatures/kill");
const { Ghosts } = await import("../cluster/ghosts");
const { CREATURE_MOVE_HEADER, decodeCreatureMoves } = await import("../socket/creature_move_codec");

function decode(packet: Uint8Array): any {
  // A moving creature's step is a binary datagram: shown here as the CREATURE_MOVE it stands for.
  if (packet[0] === CREATURE_MOVE_HEADER) return { type: "CREATURE_MOVE", data: { c: decodeCreatureMoves(packet) } };
  return JSON.parse(new TextDecoder().decode(packet));
}

function addViewer(id: string, x: number, y: number): any {
  const wt: any = { readyState: 1, reliable: [] as any[], datagrams: [] as any[] };
  wt.send = (packet: Uint8Array) => wt.reliable.push(decode(packet));
  wt.sendBestEffort = (packet: Uint8Array) => wt.datagrams.push(decode(packet));
  const p: any = { id, username: id, location: { map: "main.json", position: { x, y, direction: "down" } }, wt, stats: {}, aoi: { aoiRadius: 1000 } };
  playerCache.add(id, p);
  mapIndex.addPlayer(id, "main");
  return playerCache.get(id);
}

function removeViewer(p: any): void {
  creatures.sync.forget(p.id);
  mapIndex.removePlayer(p.id);
  playerCache.remove(p.id);
}

function statePacket(id: number): Uint8Array[] {
  return [new TextEncoder().encode(JSON.stringify({ type: "CREATURE_STATE", data: { id, state: "combat", victimId: null } }))];
}

// The template the mirrors use, as init reads it; init also hooks the creature tick to FIXED_UPDATE.
await assetCache.set(CACHE_KEYS.templates, [normalizeTemplate({ id: 1, name: "Wolf", level_min: 5, level_max: 5, sprite_type: "none" })]);
await creatures.init();

test("a mirror is shown with its auras and never as lootable; relays and moves reach its viewers", () => {
  const kind = (creatures as any).creatureGhostKind;
  const viewer = addViewer("cv1", 300, 300);
  const now = Date.now();
  const aura = { id: "Burn", kind: "dot", stacks: 2, expiresAt: now + 8000 };
  expect(kind.spawn(record({ id: 777200, state: "dead", auras: [aura] }), "a")).toBe(true);
  const spawn = viewer.wt.reliable.find((p: any) => p.type === "CREATURE_SPAWN" && p.data.creatures.some((c: any) => c.id === 777200));
  expect(spawn).toBeDefined();
  const shown = spawn.data.creatures.find((c: any) => c.id === 777200);
  expect(shown.lootable).toBe(false);
  expect(shown.auras.length).toBe(1);
  expect(shown.auras[0].id).toBe("Burn");
  expect(shown.auras[0].expiresAt).toBeUndefined();
  expect(shown.auras[0].remainingMs).toBeGreaterThan(7000);
  expect(shown.auras[0].remainingMs).toBeLessThanOrEqual(8000);

  // A packet relayed by the owner reaches the viewers here.
  kind.relay(777200, statePacket(777200), false);
  expect(viewer.wt.reliable.some((p: any) => p.type === "CREATURE_STATE" && p.data.id === 777200)).toBe(true);

  // A mirror move is sent with the tick's moves; the tick itself never runs the mirror.
  creatures.resetStats();
  kind.move(777200, 340, 300, 3, 2);
  listener.emit(Events.FIXED_UPDATE);
  const move = viewer.wt.datagrams.find((p: any) => p.type === "CREATURE_MOVE" && p.data.c.some((e: any) => e[0] === 777200));
  expect(move).toBeDefined();
  expect([...creatures.sync.observedIds()]).toContain(777200);
  expect((creatures.stats() as any).tick.avgCreaturesPerTick).toBe(0);
  expect(creatures.getCreature(777200)!.state).toBe("dead");

  kind.despawn(777200, "left");
  expect(viewer.wt.reliable.some((p: any) => p.type === "CREATURE_DESPAWN")).toBe(true);
  removeViewer(viewer);
});

test("toViewers relays a local creature's packets and never a mirror's", () => {
  const kind = (creatures as any).creatureGhostKind;
  const relay = spyOn(ghosts, "relay");
  const local = makeCreature(777300, 300, 300);
  creatures.registry.add(local as any);
  kind.spawn(record({ id: 777301 }), "a");
  creatures.combat.emitCombatText({ creatureId: 777300, targetId: "creature:777300", sourceId: "p", kind: "melee", amount: 3 } as any);
  creatures.combat.emitCombatText({ creatureId: 777301, targetId: "creature:777301", sourceId: "p", kind: "melee", amount: 3 } as any);
  expect(relay.mock.calls.map((c) => [c[0], c[1], c[3]])).toEqual([["creature", 777300, true]]);
  relay.mockRestore();
  kind.despawn(777301, "left");
  creatures.registry.remove(777300);
});

test("a mirror's corpse cannot be opened or looted here, and the editor refuses it", async () => {
  const kind = (creatures as any).creatureGhostKind;
  const looter = { id: "lt1", username: "lt1", location: { map: "main", position: { x: 300, y: 300 } } };
  kind.spawn(record({ id: 777400, state: "dead" }), "a");
  corpseLoot.create(777400, [], 5, ["lt1"], ["lt1"]);
  // The control: a local corpse set up the same way opens.
  const local = makeCreature(777401, 300, 300, { state: "dead" });
  creatures.registry.add(local as any);
  corpseLoot.create(777401, [], 5, ["lt1"], ["lt1"]);
  expect(typeof creatures.openCorpseFor(looter, 777401)).toBe("object");
  expect(creatures.openCorpseFor(looter, 777400)).toBe("empty");
  expect(await creatures.takeCorpseLootFor(looter, 777400, null)).toBe("empty");
  const admin = { id: "adm1", username: "adm1", isAdmin: true, permissions: ["admin.*"] };
  const result = await creatures.handleEditorPacket(admin, "CREATURE_EDITOR_ACTION", { action: "kill", creatureId: 777400 });
  expect(result.ok).toBe(false);
  expect(result.errors).toEqual(["That creature is on another node."]);
  expect(creatures.getCreature(777400)).toBeDefined();
  corpseLoot.remove(777400);
  corpseLoot.remove(777401);
  kind.despawn(777400, "left");
  creatures.registry.remove(777401);
});

test("stats count this node's creatures, and mirrors apart", () => {
  const kind = (creatures as any).creatureGhostKind;
  const before = creatures.stats() as any;
  const local = makeCreature(777500, 300, 300);
  creatures.registry.add(local as any);
  kind.spawn(record({ id: 777501 }), "a");
  kind.spawn(record({ id: 777502 }), "a");
  const after = creatures.stats() as any;
  expect(after.mirrors).toBe(before.mirrors + 2);
  expect(after.creatures).toBe(before.creatures + 1);
  kind.despawn(777501, "left");
  kind.despawn(777502, "left");
  creatures.registry.remove(777500);
  expect((creatures.stats() as any).mirrors).toBe(before.mirrors);
});

test("a creature with a DoT sends no GHOST_STATE while its auras stay the same", async () => {
  const sent: string[] = [];
  const link: any = {
    isUp: (peer: string) => peer === "b",
    send: (_peer: string, kind: string) => { sent.push(kind); return true; },
    sendDatagram: () => true,
    on: () => {},
    onDatagram: () => {},
    onPeerUp: () => {},
    onPeerDown: () => {},
  };
  const owner = new Ghosts({ scanMs: 1_000_000 });
  owner.register((creatures as any).creatureGhostKind);
  owner.attach(link, () => new Set(["b"]));
  const burning = makeCreature(777600, 300, 300);
  burning.auras.dots.push({ id: "Burn", casterId: "p", amountPerTick: 5, intervalMs: 1000, expiresAt: Date.now() + 60_000, nextTickAt: Date.now() + 1000, stacks: 1, maxStacks: 1 });
  creatures.registry.add(burning as any);
  try {
    owner.scan();
    expect(sent).toContain("GHOST_SPAWN");
    await Bun.sleep(25);
    owner.scan();
    await Bun.sleep(25);
    owner.scan();
    expect(sent.filter((k) => k === "GHOST_STATE").length).toBe(0);
    // The control: a refreshed DoT is a change.
    burning.auras.dots[0].expiresAt += 5000;
    owner.scan();
    expect(sent.filter((k) => k === "GHOST_STATE").length).toBe(1);
  } finally {
    owner.detach();
    creatures.registry.remove(777600);
  }
});

// ------------------------------------------------------------------ the sweep, the load report and data changes

const { loadReport, reportCreaturesFrom } = await import("../cluster");
const { planRebalance } = await import("../cluster/rebalance");

test("the corpse sweep despawns local corpses only", () => {
  const kind = (creatures as any).creatureGhostKind;
  kind.spawn(record({ id: 777700, state: "dead" }), "a");
  creatures.getCreature(777700)!.combat.corpseUntil = 0;
  // The control: a local corpse nobody sees, past its time.
  const local = makeCreature(777701, 300, 300, { state: "dead" });
  local.combat.corpseUntil = 0;
  creatures.registry.add(local as any);
  listener.emit(Events.SERVER_TICK);
  expect(creatures.getCreature(777701)).toBeUndefined();
  expect(creatures.getCreature(777700)?.remote).toBe(true);
  kind.despawn(777700, "left");
});

test("dormant creatures add no load: unequal counts of them, and no players, plan no move (perf fix 2)", () => {
  // Three dormant creatures, nobody near them and nobody fighting them: they cost no tick and stay when a block moves.
  const kind = (creatures as any).creatureGhostKind;
  const dormant = [777810, 777811, 777812].map((id) => makeCreature(id, 300, 300));
  for (const c of dormant) creatures.registry.add(c as any);
  reportCreaturesFrom(creatures.reportedCreatures, creatures.reportedCreatureTotal);
  try {
    const busy = loadReport("n1", Date.now());
    expect(busy.creatures).toBe(0);
    expect(busy.blocks).toEqual({});
    const owners: Record<string, { nodeId: string; epoch: number; since: number }> = {
      "0,0": { nodeId: "n1", epoch: 1, since: 0 }, "1,0": { nodeId: "n1", epoch: 1, since: 0 }, "2,0": { nodeId: "n2", epoch: 1, since: 0 },
    };
    // n2 holds none of them: before the fix n1's three dormant creatures read as load 0.3 against n2's 0.
    const plan = planRebalance({ now: 1_000_000, tables: [{ map: "main", table: { epoch: 1, owners } }], loads: [busy, { nodeId: "n2", at: 0, players: 0, creatures: 0, blocks: {} }], busy: new Set() });
    expect(plan).toEqual([]);
    // One of them wakes in a fight: it counts, 0.1.
    dormant[0]!.state = "combat";
    creatures.combat.adopt(dormant[0] as any);
    expect(loadReport("n1", Date.now()).creatures).toBe(1);
    expect(Object.values(loadReport("n1", Date.now()).blocks)).toEqual([0.1]);
    // The total is every live creature, awake or not, and it is no load: the blocks hold the awake one only.
    const report = loadReport("n1", Date.now());
    expect(report.creatures).toBe(1);
    expect(report.creaturesTotal).toBe(creatures.reportedCreatureTotal());
    expect(report.creaturesTotal).toBeGreaterThanOrEqual(3);
    kind.spawn(record({ id: 777813 }), "a");
    expect(loadReport("n1", Date.now()).creaturesTotal).toBe(report.creaturesTotal);
    dormant[1]!.state = "dead";
    expect(loadReport("n1", Date.now()).creaturesTotal).toBe(report.creaturesTotal! - 1);
    kind.despawn(777813, "left");
  } finally {
    reportCreaturesFrom(null);
    creatures.combat.forget(dormant[0] as any);
    for (const c of dormant) creatures.registry.remove(c.id);
  }
});

test("the load report counts no mirrors", () => {
  const kind = (creatures as any).creatureGhostKind;
  // Awake: in a fight, so tickCreatures ticks it and the report counts it. 777803 is dormant and is not counted.
  const local = makeCreature(777800, 300, 300, { state: "combat" });
  creatures.registry.add(local as any);
  creatures.combat.adopt(local as any);
  const dormant = makeCreature(777803, 300, 300);
  creatures.registry.add(dormant as any);
  kind.spawn(record({ id: 777801 }), "a");
  const ids = [...creatures.reportedCreatures()].map((c) => c.id);
  expect(ids).toContain(777800);
  expect(ids).not.toContain(777801);
  expect(ids).not.toContain(777803);
  // Through the cluster's load report too. Other test files share the module and reset its source, so set it again.
  reportCreaturesFrom(creatures.reportedCreatures);
  try {
    const before = loadReport("n1", Date.now()).creatures;
    kind.spawn(record({ id: 777802 }), "a");
    expect(loadReport("n1", Date.now()).creatures).toBe(before);
  } finally {
    reportCreaturesFrom(null);
  }
  kind.despawn(777801, "left");
  kind.despawn(777802, "left");
  creatures.combat.forget(local as any);
  creatures.registry.remove(777800);
  creatures.registry.remove(777803);
});

// Last: applyDataChange reloads the tables from the stubbed database, which empties the templates.
test("a data change refreshes local creatures only", async () => {
  const kind = (creatures as any).creatureGhostKind;
  kind.spawn(record({ id: 777900 }), "a");
  const local = makeCreature(777901, 300, 300);
  creatures.registry.add(local as any);
  try {
    await creatures.applyDataChange({ templateIds: [1] });
    expect(creatures.getCreature(777901)).toBeUndefined();
    expect(creatures.getCreature(777900)?.remote).toBe(true);
  } finally {
    kind.despawn(777900, "left");
    // The creature module is shared by the files of a run that is not --parallel, and it was read from a database with no
    // tables: the Wolf this file set is read again, as it was before.
    tableRows.creature_templates = [{ id: 1, name: "Wolf", level_min: 5, level_max: 5, sprite_type: "none" }];
    await creatures.applyDataChange({});
    delete tableRows.creature_templates;
  }
});
