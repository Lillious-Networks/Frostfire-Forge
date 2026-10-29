import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { ghosts } from "../cluster/ghosts";
import { LinkCalls, linkCalls } from "../cluster/linkcalls";
import { mirrorPlayers } from "../cluster/mirrors";
import { STAT_INT_MAX, setGrantApplier, setRewardApplier, type GrantApplier, type RewardApplier } from "../systems/creatures/remotereward";
import assetCache from "../services/assetCache";
import { linkPair } from "./cluster-fakelink";
import { databaseModule, mockQuery } from "./setup";

// Phase 5 final fix wave, part B: what a node does with what a peer sends it. The reward, the grant, the creature's
// effects on a player and the hits on a creature are each held to what play can reach, and to the node that may send them.

mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { applyReward, corpseLoot, handleKill, maxCorpseCopper, maxShareXp, setKnownTemplates } = await import("../systems/creatures/kill");
const { CreatureFlags } = await import("../systems/creatures/constants");
const { baseKillXp, distributeKillXp, groupBonus } = await import("../systems/creatures/rewards");
const { AIState } = await import("../systems/creatures/types");
const { Events, listener } = await import("../systems/events");
const { default: playerCache } = await import("../services/playermanager");
const { default: playerSystem } = await import("../systems/player");
const { default: currency } = await import("../systems/currency");
const { default: log } = await import("../modules/logger");
const { packetManager } = await import("../socket/packet_manager");
const { delivery } = await import("../cluster/deliver");
const { CACHE_KEYS, normalizeTemplate } = await import("../systems/creatures/repository");
const { createCombatState } = await import("../systems/creatures/threat");
const { createAuras } = await import("../systems/creatures/auras");
const { getCreatureEngineBridge, setCreatureEngineBridge } = await import("../systems/creatures/bridge");
const creatures = await import("../systems/creatures");

// The template the creatures use, as init reads it (the same one the other creature tests set).
await assetCache.set(CACHE_KEYS.templates, [normalizeTemplate({ id: 1, name: "Wolf", level_min: 5, level_max: 5, sprite_type: "none" })]);
await creatures.init();
const mod = creatures as any;

// Every test file shares one process: what a test changes in a singleton is put back, in finally or afterEach.
let savedReward: RewardApplier | null = null;
let savedGrant: GrantApplier | null = null;
const restores: Array<() => void | Promise<void>> = [];
const locals: string[] = [];

/** Puts `value` in the asset cache under `key` for the rest of the test, and the old value back afterwards. */
async function holding(key: string, value: unknown): Promise<void> {
  const saved = await assetCache.get(key);
  await assetCache.set(key, value);
  restores.push(async () => {
    if (saved === undefined || saved === null) await (typeof assetCache.remove === "function" ? assetCache.remove(key) : assetCache.set(key, []));
    else await assetCache.set(key, saved);
  });
}

/** The templates this node knows for the rest of the test (rewards and grants are checked against them), and the old ones back afterwards. */
function knowing(list: any[]): void {
  const previous = setKnownTemplates(new Map(list.map((t) => [t.id, t])));
  restores.push(() => { setKnownTemplates(previous); });
}

beforeEach(() => {
  savedReward = setRewardApplier(null);
  savedGrant = setGrantApplier(null);
});

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) await restore();
  for (const id of locals.splice(0)) playerCache.remove(id);
  mirrorPlayers.clear();
  setRewardApplier(savedReward);
  setGrantApplier(savedGrant);
  delivery.detach();
  linkCalls.detach();
});

/** A link from node "a" to this node ("b"); its calls are `caller.call("b", ...)`. */
function fromA(): LinkCalls {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  restores.push(() => caller.detach());
  return caller;
}

/** Records what is logged while a test runs. */
function logged() {
  const lines = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  for (const level of ["info", "warn", "error"] as const) {
    const spy = spyOn(log, level).mockImplementation(((message: string) => { lines[level].push(String(message)); }) as any);
    restores.push(() => spy.mockRestore());
  }
  return lines;
}

const addLocal = (player: any) => { playerCache.add(player.id, player); locals.push(player.id); return player; };

// ------------------------------------------------------------------ S1: APPLY_REWARD

const reward = (over: any = {}) => ({ username: "ann", playerId: "1", creatureId: 50, templateId: 3, templateName: "Wolf", xp: 40, ...over });

test("APPLY_REWARD refuses an XP that is not a whole number from 0 to what the stats table holds, and never reaches the applier", async () => {
  const caller = fromA();
  const lines = logged();
  const got: any[] = [];
  setRewardApplier(async (body, from) => { got.push([body.xp, from]); return true; });
  for (const xp of [1e300, STAT_INT_MAX + 1, -5, 1.5, null, "40", undefined]) {
    expect(await caller.call("b", "APPLY_REWARD", reward({ xp }))).toEqual({ ok: true, answer: { ok: false } });
  }
  expect(got).toEqual([]);
  expect(lines.warn.length).toBe(7);
  // The bounds themselves are fine, and the applier is told who sent it.
  for (const xp of [0, 40, STAT_INT_MAX]) expect(await caller.call("b", "APPLY_REWARD", reward({ xp }))).toEqual({ ok: true, answer: { ok: true } });
  expect(got).toEqual([[0, "a"], [40, "a"], [STAT_INT_MAX, "a"]]);
});

test("APPLY_REWARD refuses a body whose ids or names are not what a share has", async () => {
  const caller = fromA();
  logged();
  let called = 0;
  setRewardApplier(async () => { called++; return true; });
  for (const bad of [{ creatureId: -1 }, { creatureId: 1.5 }, { templateId: "3" }, { templateId: -3 }, { username: 7 }, { playerId: null }]) {
    expect(await caller.call("b", "APPLY_REWARD", reward(bad))).toEqual({ ok: true, answer: { ok: false } });
  }
  expect(await caller.call("b", "APPLY_REWARD", null)).toEqual({ ok: true, answer: { ok: false } });
  expect(called).toBe(0);
});

test("APPLY_REWARD hands the applier only the share's own fields, and logs who sent it", async () => {
  const caller = fromA();
  const lines = logged();
  let seen: any = null;
  setRewardApplier(async (body) => { seen = body; return true; });
  await caller.call("b", "APPLY_REWARD", { ...reward(), admin: true, message: "Visit evil.example" });
  expect(seen).toEqual(reward());
  expect(lines.info.some((line) => line.includes("from a") && line.includes("ann") && line.includes("40 XP") && line.includes("creature 50"))).toBe(true);
});

test("APPLY_REWARD for a creature this node mirrors is refused unless the sender owns it", async () => {
  const caller = fromA();
  logged();
  let called = 0;
  setRewardApplier(async () => { called++; return true; });
  const owner = spyOn(ghosts, "ownerOf").mockReturnValue("z");
  restores.push(() => owner.mockRestore());
  expect(await caller.call("b", "APPLY_REWARD", reward())).toEqual({ ok: true, answer: { ok: false } });
  expect(called).toBe(0);
  owner.mockReturnValue("a");
  expect(await caller.call("b", "APPLY_REWARD", reward())).toEqual({ ok: true, answer: { ok: true } });
  // A creature no longer mirrored here (it died and went) is paid out as before.
  owner.mockReturnValue(null);
  expect(await caller.call("b", "APPLY_REWARD", reward())).toEqual({ ok: true, answer: { ok: true } });
  expect(called).toBe(2);
});

// ------------------------------------------------------------------ S1: what a template can give

const ann = (over: any = {}) => ({ id: "1", username: "ann", location: { map: "main.json", position: { x: 1000, y: 1000 } }, stats: { level: 10 }, ...over });
const wolf = (over: any = {}) => ({ id: 3, name: "Wolf", rank: "normal", xp_mult: 1, flags: 0, loot_table_id: null, gold_min: 0, gold_max: 0, level_min: 30, level_max: 30, ...over });

/** playerSystem.increaseXp is answered by a stand-in that records the awards. */
function awards() {
  const given: Array<[string, number]> = [];
  const spy = spyOn(playerSystem, "increaseXp").mockImplementation((async (username: string, amount: number) => {
    given.push([username, amount]);
    return { xp: amount, max_xp: 1000, level: 1 };
  }) as any);
  restores.push(() => spy.mockRestore());
  return given;
}

test("applyReward gives at most what the template can give: the largest share is paid, one more is not", async () => {
  knowing([wolf()]);
  addLocal(ann());
  const given = awards();
  logged();
  const most = maxShareXp(wolf() as any, 10);
  expect(await applyReward({ ...reward(), xp: most } as any, "a")).toBe(true);
  expect(given).toEqual([["ann", most]]);
  expect(await applyReward({ ...reward(), xp: most + 1 } as any, "a")).toBe(false);
  expect(await applyReward({ ...reward(), xp: 1e300 } as any, "a")).toBe(false);
  expect(await applyReward({ ...reward(), xp: -1 } as any, "a")).toBe(false);
  expect(given.length).toBe(1);
});

test("applyReward refuses a template this node does not have, and gives no kill credit for it", async () => {
  knowing([wolf()]);
  addLocal(ann());
  const given = awards();
  const lines = logged();
  const credited: string[] = [];
  const hear = (event: any) => credited.push(`${event.player.username}:${event.templateId}`);
  listener.on(Events.CREATURE_KILL_CREDIT, hear);
  restores.push(() => { listener.off(Events.CREATURE_KILL_CREDIT, hear); });
  expect(await applyReward({ ...reward(), templateId: 999 } as any, "a")).toBe(false);
  expect(given).toEqual([]);
  expect(credited).toEqual([]);
  expect(lines.warn.some((line) => line.includes("999") && line.includes("from a"))).toBe(true);
  // The template it does have gets its kill credit.
  expect(await applyReward({ ...reward(), xp: 10 } as any, "a")).toBe(true);
  expect(credited).toEqual(["ann:3"]);
});

test("the creature's name in the kill notice is the template's, not the one in the body", async () => {
  knowing([wolf()]);
  const sent: any[] = [];
  addLocal(ann({ wt: { send: (packet: any) => { sent.push(packet); }, readyState: 1 } }));
  awards();
  logged();
  const objectives = await import("../systems/quests/objectives");
  const credit = spyOn(objectives, "credit").mockImplementation((async () => [{ questId: 1, count: 1, required: 2, questReady: false }]) as any);
  restores.push(() => credit.mockRestore());
  const notices: string[] = [];
  const notify = spyOn(packetManager, "notify").mockImplementation(((data: any) => { notices.push(data.message); return [] as any; }) as any);
  restores.push(() => notify.mockRestore());
  expect(await applyReward({ ...reward(), templateName: "Visit evil.example", xp: 10 } as any, "a")).toBe(true);
  expect(credit).toHaveBeenCalledWith("ann", "kill", "3", 1);
  expect(notices).toEqual(["Wolf slain: 1/2"]);
});

test("a creature that gives no XP gives a remote member none, and a template with a multiplier gives more", async () => {
  knowing([wolf({ id: 3, flags: CreatureFlags.NO_XP }), wolf({ id: 4, xp_mult: 5 }), wolf({ id: 5 })]);
  addLocal(ann());
  const given = awards();
  logged();
  expect(maxShareXp(wolf({ flags: CreatureFlags.NO_XP }) as any, 10)).toBe(0);
  expect(await applyReward({ ...reward(), xp: 1 } as any, "a")).toBe(false);
  expect(await applyReward({ ...reward(), xp: 0 } as any, "a")).toBe(true);
  expect(maxShareXp(wolf({ xp_mult: 5 }) as any, 10)).toBeGreaterThan(maxShareXp(wolf() as any, 10) * 4);
  expect(await applyReward({ ...reward(), templateId: 4, xp: maxShareXp(wolf({ xp_mult: 5 }) as any, 10) } as any, "a")).toBe(true);
  expect(await applyReward({ ...reward(), templateId: 5, xp: maxShareXp(wolf({ xp_mult: 5 }) as any, 10) } as any, "a")).toBe(false);
  expect(given.length).toBe(1);
});

test("the XP bound follows the receiving member's level and the template's highest creature level", async () => {
  knowing([wolf({ level_max: 30 }), wolf({ id: 4, level_max: 60 })]);
  const given = awards();
  logged();
  const bound = (level: number, id = 3) => maxShareXp(wolf({ level_max: id === 3 ? 30 : 60 }) as any, level);
  expect(bound(1)).toBeLessThan(bound(10));
  // A level 100 member gets nothing from a level 30 creature (it is grey): only the rounding is left.
  expect(bound(100)).toBe(1);
  // A member who just gained the level that makes the creature grey is still paid what the level below gave.
  const grey = (() => { let level = 2; while (!(baseKillXp(level, 30) === 0 && baseKillXp(level - 1, 30) > 0)) level++; return level; })();
  expect(bound(grey)).toBeGreaterThan(1);
  expect(bound(grey + 1)).toBe(1);
  // At level 30 a level 60 creature gives more than a level 30 one.
  expect(bound(30, 4)).toBeGreaterThan(bound(30));
  // A level 1 player cannot be given the XP of a kill at the top of the level range.
  const top = (() => { let level = 1; while (playerSystem.getNewMaxXp(level + 1) <= STAT_INT_MAX) level++; return level; })();
  expect(bound(1) * 10).toBeLessThan(maxShareXp(wolf({ level_max: top + 4 }) as any, top));
  // Through applyReward: the share that fits a level 10 member is refused for a level 1 member.
  const big = bound(10);
  expect(big).toBeGreaterThan(bound(1));
  addLocal(ann({ id: "1", stats: { level: 1 } }));
  expect(await applyReward({ ...reward(), xp: big } as any, "a")).toBe(false);
  expect(await applyReward({ ...reward(), xp: bound(1) } as any, "a")).toBe(true);
  playerCache.remove("1");
  addLocal(ann({ id: "1", stats: { level: 10 } }));
  expect(await applyReward({ ...reward(), xp: big } as any, "a")).toBe(true);
  // The template's creature level: template 4 reaches level 60, template 3 only 30.
  playerCache.remove("1");
  addLocal(ann({ id: "1", stats: { level: 30 } }));
  expect(await applyReward({ ...reward(), templateId: 3, xp: bound(30, 4) } as any, "a")).toBe(false);
  expect(await applyReward({ ...reward(), templateId: 4, xp: bound(30, 4) } as any, "a")).toBe(true);
  expect(given.length).toBe(3);
});

test("the XP bound is above what any real kill gives each member: every level, rank, group size, mix of levels and creature level", () => {
  const top = (() => { let level = 1; while (playerSystem.getNewMaxXp(level + 1) <= STAT_INT_MAX) level++; return level; })();
  expect(top).toBeGreaterThan(100);
  for (const rank of ["normal", "elite", "rare", "rare_elite", "boss"] as const) {
    for (const creatureLevel of [1, 5, 10, 30, 60, 100, top]) {
      // The template's highest creature level is the creature's own, or above it.
      for (const levelMax of [creatureLevel, creatureLevel + 5]) {
        const template = wolf({ rank, level_max: levelMax }) as any;
        for (const high of [1, 5, 10, 30, 60, 100, top]) {
          for (const size of [1, 2, 3, 4, 5, 8]) {
            // One member at `high`, the rest well below it, or level with it.
            for (const low of [1, Math.max(1, Math.floor(high / 2)), high]) {
              const members = Array.from({ length: size }, (_, i) => ({ username: `m${i}`, level: i === 0 ? high : low }));
              for (const [name, share] of distributeKillXp(members, creatureLevel, rank, 1)) {
                const level = members.find((m) => m.username === name)!.level;
                expect(share).toBeLessThanOrEqual(maxShareXp(template, level));
              }
            }
          }
        }
      }
    }
  }
  expect(baseKillXp(top, top + 4) * groupBonus(5)).toBeLessThan(STAT_INT_MAX);
  // Far from the stats table's limit, so the bound is no looser than it has to be.
  expect(maxShareXp(wolf() as any, 30)).toBeLessThan(1000);
});

test("a local award past what the stats table holds is refused before increaseXp can loop on it", async () => {
  knowing([wolf()]);
  const given = awards();
  const lines = logged();
  addLocal(ann({ party: [], stats: { level: 30 } }));
  const dead: any = { id: 50, map: "main", x: 1000, y: 1000, layerId: null, level: 30, state: AIState.DEAD, combat: { tapper: { playerId: "1", username: "ann" }, corpseUntil: 0 } };
  // A template whose multiplier is absurd: the share is far past the stats table's limit.
  await handleKill(dead, wolf({ xp_mult: 1e12 }) as any);
  expect(given).toEqual([]);
  expect(lines.error.some((line) => line.includes("refused") && line.includes("ann"))).toBe(true);
  // The same kill with a normal template pays.
  await handleKill(dead, wolf() as any);
  expect(given.length).toBe(1);
});

// ------------------------------------------------------------------ S1: GRANT and cells-grant

const grant = (over: any = {}) => ({ username: "ann", copper: 40, ...over });

test("GRANT refuses a copper amount that is not a whole number from 0 to what the currency holds, and never reaches the applier", async () => {
  const caller = fromA();
  const lines = logged();
  const got: any[] = [];
  setGrantApplier(async (body) => { got.push(body); return "given"; });
  for (const copper of [9e15, 1e300, STAT_INT_MAX + 1, -5, 1.5, null, "40", undefined]) {
    expect(await caller.call("b", "GRANT", grant({ copper }))).toEqual({ ok: true, answer: { result: "failed" } });
  }
  expect(await caller.call("b", "GRANT", null)).toEqual({ ok: true, answer: { result: "failed" } });
  expect(got).toEqual([]);
  expect(lines.warn.length).toBe(9);
  expect(await caller.call("b", "GRANT", grant({ copper: 0 }))).toEqual({ ok: true, answer: { result: "given" } });
  expect(await caller.call("b", "GRANT", grant({ copper: STAT_INT_MAX }))).toEqual({ ok: true, answer: { result: "given" } });
});

test("GRANT drops the message from the body, and logs who sent it and what it was for", async () => {
  const caller = fromA();
  const lines = logged();
  let seen: any = null;
  setGrantApplier(async (body) => { seen = body; return "given"; });
  await caller.call("b", "GRANT", { ...grant(), message: "Visit evil.example to claim your reward", admin: true });
  expect(seen).toEqual({ username: "ann", copper: 40 });
  expect(lines.info.some((line) => line.includes("from a") && line.includes("ann") && line.includes("40 copper"))).toBe(true);
});

test("the share's notice is made here from the amount, whatever message the body carries", async () => {
  knowing([wolf({ gold_max: 100 })]);
  // kill.ts set the applier when it loaded, and beforeEach took it: it is the one the engine runs with.
  const real = savedGrant!;
  expect(real).not.toBeNull();
  const player = addLocal({ id: "1", username: "ann", wt: { send: () => {}, readyState: 1 } });
  const notices: string[] = [];
  const notify = spyOn(packetManager, "notify").mockImplementation(((data: any) => { notices.push(data.message); return [] as any; }) as any);
  restores.push(() => notify.mockRestore());
  const add = spyOn(currency, "add").mockImplementation((async (_name: string, amount: any) => ({ copper: amount.copper, silver: 0, gold: 0 })) as any);
  restores.push(() => add.mockRestore());
  logged();
  expect(await real({ username: "ann", copper: 40, message: "Visit evil.example to claim your reward" })).toBe("given");
  expect(notices).toEqual(["You receive loot: 40 copper"]);
  expect(player.username).toBe("ann");
});

test("a share is held to what a corpse of this node's templates holds", async () => {
  knowing([wolf({ gold_max: 100 }), wolf({ id: 4, gold_max: 250 }), wolf({ id: 5, gold_max: 0 })]);
  const real = savedGrant!;
  addLocal({ id: "1", username: "ann", wt: undefined });
  const writes: number[] = [];
  const add = spyOn(currency, "add").mockImplementation((async (_name: string, amount: any) => { writes.push(amount.copper); return { copper: amount.copper, silver: 0, gold: 0 }; }) as any);
  restores.push(() => add.mockRestore());
  const lines = logged();
  expect(maxCorpseCopper()).toBe(250);
  expect(await real({ username: "ann", copper: 250 })).toBe("given");
  expect(await real({ username: "ann", copper: 251 })).toBe("failed");
  expect(await real({ username: "ann", copper: 9e15 })).toBe("failed");
  expect(await real({ username: "ann", copper: 12.5 })).toBe("failed");
  expect(writes).toEqual([250]);
  expect(lines.warn.length).toBe(3);
  // A member who is not here is still absent, whatever the amount.
  expect(await real({ username: "nobody", copper: 1e300 })).toBe("absent");
});

test("the largest share is never more than the largest corpse: gold_max of the template is the most a kill holds", async () => {
  knowing([]);
  expect(maxCorpseCopper()).toBe(0);
  knowing([wolf({ gold_max: 99_999_999_999 })]);
  expect(maxCorpseCopper()).toBe(STAT_INT_MAX);
});

test("cells-grant refuses a body that is not a share, or is for another player than the one it ran on", async () => {
  const lines = logged();
  const got: any[] = [];
  setGrantApplier(async (body) => { got.push(body); return "given"; });
  addLocal({ id: "1", username: "Ann", wt: undefined });
  addLocal({ id: "2", username: "mallory", wt: undefined });
  // Sent to ann, but naming mallory: ann's node must not pay mallory.
  expect(await delivery.runOnPlayer("Ann", "cells-grant", { username: "mallory", copper: 5 })).toBe(true);
  expect(await delivery.runOnPlayer("Ann", "cells-grant", { username: "Ann", copper: 9e15 })).toBe(true);
  expect(await delivery.runOnPlayer("Ann", "cells-grant", { username: "Ann", copper: -3 })).toBe(true);
  expect(await delivery.runOnPlayer("Ann", "cells-grant", null)).toBe(true);
  expect(got).toEqual([]);
  expect(lines.warn.length).toBe(4);
  expect(await delivery.runOnPlayer("Ann", "cells-grant", { username: "ann", copper: 5, message: "Visit evil.example" })).toBe(true);
  expect(got).toEqual([{ username: "ann", copper: 5 }]);
  expect(lines.info.some((line) => line.includes("cells-grant") && line.includes("5 copper"))).toBe(true);
});

// ------------------------------------------------------------------ S3 and S4: a creature and a player across a border

function makeCreature(id: number, over: any = {}) {
  return {
    id, templateId: 1, spawnId: 1, poolId: null, map: "main", layerId: null, x: 300, y: 300, dir: "down",
    homeX: 300, homeY: 300, level: 5, health: 100, maxHealth: 100, state: "idle" as any, spawnedAt: 0,
    move: null, waitUntil: 0, patrolIndex: 0, patrolForward: true, sentX: 300, sentY: 300, sentDir: "down",
    sentMoving: false, combat: createCombatState(), auras: createAuras(), casting: null, abilityStates: new Map(), ...over,
  };
}

/** A player of node `from`, as the player kind leaves it in mirrorPlayers. */
function mirrorPlayer(id: string, from = "a") {
  const mirror = {
    id, username: id, remote: true, mirrorFrom: from, isDead: false, isGhost: false, isStealth: false,
    stats: { level: 10, health: 100, stat_damage: 7 }, aoi: { layerId: null },
    location: { map: "main", position: { x: 300, y: 310, direction: "up" } },
  };
  mirrorPlayers.set(id, mirror);
  return mirror;
}

/** A creature this node owns, in the real registry; it is taken out again afterwards. */
function owned(id: number, over: any = {}) {
  const creature = makeCreature(id, over);
  creatures.registry.add(creature as any);
  restores.push(() => { creatures.registry.remove(id); });
  return creature;
}

/** Calls an APPLY_EFFECT op of this node, from node "a". */
function effect(): (op: string, target: string | number, body: unknown) => Promise<any> {
  const caller = fromA();
  return (op, target, body) => caller.call("b", "APPLY_EFFECT", { op, target, body });
}

/** The local spell table and Wolf's abilities, for this test. Spell 1 is Wolf's ability, spell 2 is not. */
async function withSpells(): Promise<void> {
  await holding("spells", [
    { id: 1, name: "Frost Bolt", damage: 5, effects: [{ type: "slow", value: 10 }] },
    { id: 2, name: "Doom", damage: 99, effects: [{ type: "stun", value: 1 }] },
  ]);
  await holding(CACHE_KEYS.abilities, [{ id: 1, template_id: 1, spell_id: 1 }]);
  await creatures.refreshSpells();
  await creatures.refreshAbilities();
  restores.push(async () => { await creatures.refreshSpells(); await creatures.refreshAbilities(); });
}

const hitBody = (over: any = {}) => ({ attackerId: "ma", amount: 30, threatMultiplier: 1, textKind: "hit", ...over });

test("creature_hit holds the amount to the creature's health, and the threat multiplier and caster stat to what play uses", async () => {
  const call = effect();
  const creature = owned(770201);
  mirrorPlayer("ma");
  // A hit that kills pays the kill: the warning about the mirror's reward is not for this test's output.
  logged();
  restores.push(() => corpseLoot.remove(770201));
  const applied = spyOn(mod.combat, "applyForwardedHit");
  restores.push(() => applied.mockRestore());
  const lastHit = () => applied.mock.calls[applied.mock.calls.length - 1]![1] as any;

  // What play sends goes through as it is.
  await call("creature_hit", 770201, hitBody());
  expect(lastHit()).toEqual({ attackerId: "ma", amount: 30, threatMultiplier: 1, textKind: "hit" });
  expect(creature.health).toBe(70);

  creature.health = 100;
  await call("creature_hit", 770201, hitBody({ amount: 1e9 }));
  expect(lastHit().amount).toBe(100);
  expect(creature.state).toBe("dead");

  // The creature is alive again for each hit, so none is turned away as a hit on a corpse.
  const alive = () => { creature.health = 100; creature.state = "idle"; };
  for (const [sent, kept] of [[-40, 0], ["lots", 0], [null, 0], [1e308, 100]] as const) {
    alive();
    await call("creature_hit", 770201, hitBody({ amount: sent }));
    expect(lastHit().amount).toBe(kept);
  }
  for (const [sent, kept] of [[1e6, 10], [-3, 0], [2, 2], ["x", 0]] as const) {
    alive();
    await call("creature_hit", 770201, hitBody({ threatMultiplier: sent }));
    expect(lastHit().threatMultiplier).toBe(kept);
  }
});

test("creature_hit uses this node's copy of the spell, and a spell it does not have is refused", async () => {
  await withSpells();
  const call = effect();
  const creature = owned(770201);
  mirrorPlayer("ma");
  const applied = spyOn(mod.combat, "applyForwardedHit");
  restores.push(() => applied.mockRestore());
  const forged = { id: 1, name: "Frost Bolt", effects: [{ type: "stun", value: 9999, duration: 9999 }] };
  expect(await call("creature_hit", 770201, hitBody({ amount: 0, textKind: null, spell: forged, casterStat: 1e12 }))).toEqual({ ok: true, answer: { outcome: "applied" } });
  const seen = applied.mock.calls[0]![1] as any;
  expect(seen.spell).toEqual({ id: 1, name: "Frost Bolt", damage: 5, effects: [{ type: "slow", value: 10 }] });
  expect(seen.casterStat).toBe(1_000_000);
  // An id this node has no spell for.
  expect(await call("creature_hit", 770201, hitBody({ amount: 0, spell: { id: 777, name: "Doom", effects: [] } }))).toEqual({ ok: true, answer: { outcome: "refused", reason: "spell" } });
  expect(await call("creature_hit", 770201, hitBody({ amount: 0, spell: { name: "No id" } }))).toEqual({ ok: true, answer: { outcome: "refused", reason: "spell" } });
  expect(applied).toHaveBeenCalledTimes(1);
  expect(creature.health).toBe(100);
});

test("creature_threat holds a heal's amount to what a heal can be", async () => {
  const call = effect();
  const creature = owned(770201, { state: "combat" });
  mirrorPlayer("ma");
  mirrorPlayer("mb");
  const healed = spyOn(mod.combat, "onPlayerHealed");
  restores.push(() => healed.mockRestore());
  mod.combat.addThreat(creature, "mb", 100, 1000);
  for (const [sent, kept] of [[40, 40], [1e12, 1_000_000], [-500, 0], ["x", 0]] as const) {
    expect(await call("creature_threat", "ma", { kind: "heal", casterId: "ma", targetId: "mb", amount: sent })).toEqual({ ok: true, answer: { outcome: "applied" } });
    expect(healed.mock.calls[healed.mock.calls.length - 1]![2]).toBe(kept);
  }
});

/** A player of this node, the engine bridge that records what is done to it, and creature 60: Wolf's mirror, owned by "a". */
async function atTarget(fn: (ctx: { player: any; calls: any[]; call: (body: any) => Promise<any> }) => Promise<void>): Promise<void> {
  await withSpells();
  const calls: any[] = [];
  const previous = getCreatureEngineBridge();
  setCreatureEngineBridge({
    damagePlayer: (_p, amount) => { calls.push(["damage", amount]); },
    dazePlayer: () => { calls.push(["daze"]); },
    applySpellEffects: (_p, caster, spell) => { calls.push(["spell", caster.id, spell.name, spell.effects]); },
  });
  restores.push(() => setCreatureEngineBridge(previous));
  const player: any = { id: "pz", username: "pz", location: { map: "main.json", position: { x: 300, y: 300 } }, stats: { health: 100 } };
  addLocal(player);
  owned(60, { remote: true });
  const owner = spyOn(ghosts, "ownerOf").mockImplementation(((kind: string, id: unknown) => (kind === "creature" && id === 60 ? "a" : null)) as any);
  restores.push(() => owner.mockRestore());
  const call = effect();
  await fn({ player, calls, call: (body) => call("creature_on_player", "pz", { creatureId: 60, creatureName: "Wolf", map: "main", layerId: null, ...body }) });
}

test("a daze names a creature the asker owns, and is turned away from a creature it does not, or on another map", async () => {
  await atTarget(async ({ calls, call }) => {
    expect(await call({ kind: "daze" })).toEqual({ ok: true, answer: { outcome: "applied" } });
    expect(calls).toEqual([["daze"]]);
    // The old daze named no creature (id 0), and any peer could daze any player with it.
    expect(await call({ kind: "daze", creatureId: 0 })).toEqual({ ok: true, answer: { outcome: "refused", reason: "creature" } });
    expect(await call({ kind: "daze", creatureId: 61 })).toEqual({ ok: true, answer: { outcome: "refused", reason: "creature" } });
    expect(await call({ kind: "daze", creatureId: undefined })).toEqual({ ok: true, answer: { outcome: "refused", reason: "creature" } });
    expect(await call({ kind: "daze", map: "cave" })).toEqual({ ok: true, answer: { outcome: "missing", reason: "layer" } });
    expect(await call({ kind: "daze", layerId: "layer-9" })).toEqual({ ok: true, answer: { outcome: "missing", reason: "layer" } });
    expect(calls).toEqual([["daze"]]);
  });
});

test("a creature's damage is never below 0: a negative amount does not heal the player", async () => {
  await atTarget(async ({ calls, call }) => {
    expect(await call({ kind: "damage", amount: 12 })).toEqual({ ok: true, answer: { outcome: "applied" } });
    await call({ kind: "damage", amount: -400 });
    await call({ kind: "damage", amount: "lots" });
    await call({ kind: "damage" });
    expect(calls).toEqual([["damage", 12], ["damage", 0], ["damage", 0], ["damage", 0]]);
  });
});

test("a creature's spell on a player is this node's copy of one of the creature's abilities; any other is refused", async () => {
  await atTarget(async ({ player, calls, call }) => {
    const forged = { id: 1, name: "Frost Bolt", effects: [{ type: "stun", value: 9999, duration: 9999 }] };
    expect(await call({ kind: "spell", spell: forged })).toEqual({ ok: true, answer: { outcome: "applied" } });
    // The effects are the local ones, and the player is put in combat as for any hit.
    expect(calls).toEqual([["spell", "creature:60", "Frost Bolt", [{ type: "slow", value: 10 }]]]);
    expect(player.pvp).toBe(true);
    player.pvp = false;
    // A spell this node has, but not one of Wolf's abilities.
    expect(await call({ kind: "spell", spell: { id: 2, name: "Doom", effects: [{ type: "stun" }] } })).toEqual({ ok: true, answer: { outcome: "refused", reason: "spell" } });
    // A spell this node does not have, and one with no id, and none at all.
    expect(await call({ kind: "spell", spell: { id: 777, name: "Nope", effects: [] } })).toEqual({ ok: true, answer: { outcome: "refused", reason: "spell" } });
    expect(await call({ kind: "spell", spell: { name: "No id", effects: [] } })).toEqual({ ok: true, answer: { outcome: "refused", reason: "spell" } });
    expect(await call({ kind: "spell" })).toEqual({ ok: true, answer: { outcome: "refused", reason: "spell" } });
    expect(calls.length).toBe(1);
    // Nothing was refused after the player was flagged.
    expect(player.pvp).toBe(false);
  });
});

test("a creature's spell for a creature that is not in this node's registry is refused", async () => {
  await atTarget(async ({ calls, call }) => {
    creatures.registry.remove(60);
    expect(await call({ kind: "spell", spell: { id: 1, name: "Frost Bolt", effects: [] } })).toEqual({ ok: true, answer: { outcome: "refused", reason: "spell" } });
    expect(calls).toEqual([]);
  });
});

// ------------------------------------------------------------------ m7: no asset cache read per reward, grant or hit

test("a reward and a grant are checked against the templates this node holds in memory, with no asset cache read", async () => {
  knowing([wolf({ gold_max: 100 })]);
  addLocal(ann());
  awards();
  logged();
  const add = spyOn(currency, "add").mockImplementation((async (_name: string, amount: any) => ({ copper: amount.copper, silver: 0, gold: 0 })) as any);
  restores.push(() => add.mockRestore());
  const reads = spyOn(assetCache, "get");
  restores.push(() => reads.mockRestore());
  const real = savedGrant!;
  expect(await applyReward({ ...reward(), xp: 10 } as any, "a")).toBe(true);
  expect(await real({ username: "ann", copper: 50 })).toBe("given");
  expect(await real({ username: "ann", copper: 500 })).toBe("failed");
  expect(reads).not.toHaveBeenCalled();
});

// ------------------------------------------------------------------ m8: the text kind of a hit and the percent of a threat change

test("creature_hit refuses a combat text kind that is not a known one, and takes none", async () => {
  const call = effect();
  const creature = owned(770201);
  mirrorPlayer("ma");
  logged();
  restores.push(() => corpseLoot.remove(770201));
  const applied = spyOn(mod.combat, "applyForwardedHit");
  restores.push(() => applied.mockRestore());
  for (const kind of ["miss", "dodge", "parry", "glancing", "crit", "crush", "hit", "evade", "immune", "spell", "resist", "heal", "interrupted", null]) {
    creature.health = 100;
    creature.state = "idle";
    expect(await call("creature_hit", 770201, hitBody({ textKind: kind }))).toEqual({ ok: true, answer: { outcome: "applied" } });
  }
  expect(applied).toHaveBeenCalledTimes(14);
  for (const kind of ["Visit evil.example", "", 7, {}, "HIT"]) {
    creature.health = 100;
    creature.state = "idle";
    expect(await call("creature_hit", 770201, hitBody({ textKind: kind }))).toEqual({ ok: true, answer: { outcome: "refused", reason: "text" } });
  }
  expect(applied).toHaveBeenCalledTimes(14);
  expect(creature.health).toBe(100);
});

test("creature_threat holds a threat change's percent to what a threat spell can be set to: -100 to 1000", async () => {
  const call = effect();
  owned(770201, { state: "combat" });
  mirrorPlayer("ma");
  const changed = spyOn(mod.combat, "modifyThreatEverywhere");
  restores.push(() => changed.mockRestore());
  for (const [sent, kept] of [[-50, -50], [100, 100], [1000, 1000], [1e9, 1000], [-1e9, -100], ["x", 0]] as const) {
    expect(await call("creature_threat", "ma", { kind: "modify", playerId: "ma", percent: sent })).toEqual({ ok: true, answer: { outcome: "applied" } });
    expect(changed.mock.calls[changed.mock.calls.length - 1]![1]).toBe(kept);
  }
});
