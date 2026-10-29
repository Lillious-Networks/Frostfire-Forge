import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";
import { receiverSource } from "./receiver-source";

// The receiver's helpers for a player's hit across a border (withMirrors, remoteHit, hitRemotePlayer,
// applyRemotePlayerHit). socket/receiver.ts cannot be imported by a test (it imports the server, which
// starts it), so, as the other receiver tests do, the code under test is read from its source and run
// with the names it uses handed in. The AOI, mirror, attacker and refusal code is the real thing; the
// owner's side of the link is a stand-in written in each test.
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));
const aoiConfig: Record<string, any> = {
  DEFAULT_RADIUS: 1000,
  UPDATE_THRESHOLD: 100,
  GRID_CELL_SIZE: 512,
  USE_SPATIAL_GRID: true,
  SPATIAL_GRID_THRESHOLD: 50,
  MAX_PLAYERS_PER_LAYER: 50,
  DEBUG: false,
};
mock.module("../config/aoi.json", () => ({ default: aoiConfig, ...aoiConfig }));

const playerCache = (await import("../services/playermanager")).default;
const { default: layerManager } = await import("../services/layermanager");
const aoiReverse = await import("../services/aoiReverseIndex");
const { broadcastStatsUpdateToAOI, broadcastToAOIBestEffort, findPlayersWithTargetInAOI } = await import("../socket/aoi");
const { mirrorPlayers, mirrorsNearPoint, playerLayer } = await import("../cluster/mirrors");
const { refusalOf } = await import("../cluster/playerhits");
const { recordAttack, isRecentAttacker, resetAttacks } = await import("../cluster/attackers");
const { Events, setPlayerPvp } = await import("../systems/events");

type Row = Record<string, any>;
const source = receiverSource();
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** The receiver's hit helpers, from the first to just before the line that registers the applier. */
function helperCode(): string {
  const start = source.indexOf("function withMirrors(");
  const end = source.indexOf("// Registered once at load; the effect channel", start);
  if (start < 0 || end < 0) throw new Error("The hit helpers were not found in socket/receiver.ts");
  return source.slice(start, end).replace(/^export /gm, "");
}

const NAMES = [
  "filterPlayersByDistance", "playerCache", "layerManager", "mirrorPlayers", "mirrorsNearPoint", "playerLayer", "parsePos",
  "sendPlayerHit", "setPlayerPvp", "broadcastStatsUpdateToAOI", "findPlayersWithTargetInAOI", "sendPacketBestEffort",
  "packetManager", "listener", "Events", "player", "PVP_BODY", "areaSpellHarms", "refusalOf", "spellEffects",
  "handlePlayerDeath", "recordAttack", "sendStatsToPartyMembers", "cancelEffect",
];
const compiled: (given: Row) => any = new Function(`"use strict";\n${transpiler.transformSync(
  `function make({ ${NAMES.join(", ")} }: any) { ${helperCode()}\nreturn { withMirrors, remoteHit, hitRemotePlayer, applyRemotePlayerHit }; }`,
)}\nreturn make;`)();

// ------------------------------------------------------------------ fixtures

/** Every event emitted, as [event, payload]. */
let emitted: any[][];
/** What the stand-in for the owner's link answers (null: no answer), and the hits it was sent. */
let ownerAnswer: any;
let ownerSees: ((hit: any) => void) | null;
let sentHits: any[];
let harmAllowed: boolean;
let deaths: any[][];
let effectCalls: any[][];
let barrier: number;

const decode = (packet: Uint8Array): any => JSON.parse(new TextDecoder().decode(packet));
function recordingWt(): any {
  const wt: any = { readyState: 1, sent: [] as any[] };
  wt.send = (packet: Uint8Array) => wt.sent.push(decode(packet));
  wt.sendBestEffort = (packet: Uint8Array) => wt.sent.push(decode(packet));
  return wt;
}
function sendPacketBestEffort(wt: any, packets: any[]) {
  if (!wt || typeof wt.sendBestEffort !== "function" || wt.readyState !== 1) return;
  for (const packet of packets) wt.sendBestEffort(packet);
}
const parsePos = (pos: any) => {
  if (typeof pos === "string") {
    const [x, y] = pos.split(",");
    return { x: Number(x), y: Number(y) };
  }
  return { x: pos?.x ?? 0, y: pos?.y ?? 0 };
};

const listener = {
  emit: (...event: any[]) => { emitted.push(event); },
};

const helpers = () => compiled({
  filterPlayersByDistance: () => [],
  playerCache,
  layerManager,
  mirrorPlayers,
  mirrorsNearPoint,
  playerLayer,
  parsePos,
  sendPlayerHit: async (_target: any, hit: any) => {
    sentHits.push(hit);
    ownerSees?.(hit);
    return ownerAnswer;
  },
  setPlayerPvp,
  broadcastStatsUpdateToAOI,
  findPlayersWithTargetInAOI,
  sendPacketBestEffort,
  packetManager: { updateStats: (data: any) => [new TextEncoder().encode(JSON.stringify({ type: "UPDATESTATS", data }))] },
  listener,
  Events,
  player: { isInPvPZone: () => false },
  PVP_BODY: {},
  areaSpellHarms: async () => harmAllowed,
  refusalOf,
  spellEffects: {
    consumeBarrier: (_target: any, damage: number) => Math.min(barrier, damage),
    broadcastEffectsUpdate: () => {},
    getVanishedEffectId: () => null,
    applySpellEffects: async (...args: any[]) => { effectCalls.push(args); return { absorb: 2 }; },
  },
  // The real one emits PLAYER_DEATH once at its end; this one does the same.
  handlePlayerDeath: async (target: any, killer: any) => {
    deaths.push([target, killer]);
    target.isDead = true;
    listener.emit(Events.PLAYER_DEATH, { player: target, killer });
  },
  recordAttack,
  sendStatsToPartyMembers: () => {},
  cancelEffect: () => {},
});

beforeEach(() => {
  emitted = [];
  ownerAnswer = null;
  ownerSees = null;
  sentHits = [];
  harmAllowed = true;
  deaths = [];
  effectCalls = [];
  barrier = 0;
  playerCache.clear();
  aoiReverse._reset();
  resetAttacks();
});
afterEach(() => {
  mirrorPlayers.clear();
  playerCache.clear();
  aoiReverse._reset();
});

const eventsOf = (name: string) => emitted.filter(([event]) => event === name);

/** A hit as remoteHit makes it. */
const hitOf = (over: Row = {}): any => ({
  casterId: "c1", casterName: "Caster", casterStats: { level: 5 },
  casterLocation: { map: "forest", position: { x: 10, y: 20 } }, casterLayer: null, casterParty: [],
  spell: null, damage: 12, isCrit: false, skipEffects: false, showsDamage: true, harmful: true, ...over,
});
const casterStandIn = () => ({ id: "c1", username: "Caster", stats: { level: 5 }, remote: true, mirrorFrom: "a" });
function localTarget(over: Row = {}): any {
  const target: Row = {
    id: "t1", username: "Target", stats: { health: 50, total_max_health: 100 },
    location: { map: "forest.json", position: { x: 0, y: 0 } }, aoi: { layerId: null, playersInAOI: new Set<string>() },
    wt: recordingWt(), ...over,
  };
  playerCache.add("t1", target);
  return target;
}

// ------------------------------------------------- the owner applies a hit

test("the owner applies damage through the barrier, flags and records the attack, and answers applied", async () => {
  const target = localTarget();
  barrier = 5;
  const answer = await helpers().applyRemotePlayerHit("t1", hitOf(), casterStandIn());
  expect(answer.outcome).toBe("applied");
  expect(target.stats.health).toBe(43);
  expect(answer.stats.health).toBe(43);
  expect(target.pvp).toBe(true);
  expect(typeof target.last_attack).toBe("number");
  expect(isRecentAttacker("t1", "c1")).toBe(true);
  expect(eventsOf(Events.PLAYER_DAMAGED)).toHaveLength(1);
  expect(eventsOf(Events.PLAYER_DEATH)).toHaveLength(0);
  expect(deaths).toHaveLength(0);
});

test("the owner applies a heal up to the maximum and records no attack", async () => {
  const target = localTarget({ stats: { health: 95, total_max_health: 100 } });
  const answer = await helpers().applyRemotePlayerHit("t1", hitOf({ damage: -20, harmful: false }), casterStandIn());
  expect(answer.outcome).toBe("applied");
  expect(target.stats.health).toBe(100);
  expect(eventsOf(Events.PLAYER_HEALED)).toHaveLength(1);
  expect(target.pvp).toBeUndefined();
  expect(isRecentAttacker("t1", "c1")).toBe(false);
});

test("the owner applies the spell's effects unless the hit was avoided", async () => {
  localTarget();
  const spell = { name: "Frost", effects: [{ type: "slow" }] };
  const answer = await helpers().applyRemotePlayerHit("t1", hitOf({ spell }), casterStandIn());
  expect(effectCalls).toHaveLength(1);
  expect(answer.absorb).toBe(2);
  await helpers().applyRemotePlayerHit("t1", hitOf({ spell, damage: 0, skipEffects: true }), casterStandIn());
  expect(effectCalls).toHaveLength(1);
});

test("a lethal hit is a death on the owner: handlePlayerDeath once with the stand-in as killer, one PLAYER_DEATH, outcome killed", async () => {
  const target = localTarget({ stats: { health: 5, total_max_health: 100 } });
  const caster = casterStandIn();
  const spell = { name: "Frost", effects: [{ type: "slow" }] };
  const answer = await helpers().applyRemotePlayerHit("t1", hitOf({ spell }), caster);
  expect(answer.outcome).toBe("killed");
  expect(deaths).toHaveLength(1);
  expect(deaths[0]![0]).toBe(target);
  expect(deaths[0]![1].remote).toBe(true);
  expect(eventsOf(Events.PLAYER_DEATH)).toHaveLength(1);
  expect(eventsOf(Events.PLAYER_DEATH)[0]![1].killer).toBe(caster);
  // The effects of a spell that killed are not applied, and no damage number is shown after it.
  expect(effectCalls).toHaveLength(0);
});

test("a refused hit changes nothing and emits nothing: dead, in a no-PvP area, or not on this node", async () => {
  const target = localTarget({ isDead: true });
  let answer = await helpers().applyRemotePlayerHit("t1", hitOf(), casterStandIn());
  expect(answer).toEqual({ outcome: "refused", reason: "dead" });
  target.isDead = false;

  harmAllowed = false;
  answer = await helpers().applyRemotePlayerHit("t1", hitOf(), casterStandIn());
  expect(answer).toEqual({ outcome: "refused", reason: "nopvp" });
  harmAllowed = true;

  answer = await helpers().applyRemotePlayerHit("nobody", hitOf(), casterStandIn());
  expect(answer).toEqual({ outcome: "missing", reason: "missing" });

  expect(target.stats.health).toBe(50);
  expect(target.pvp).toBeUndefined();
  expect(emitted).toEqual([]);
  expect(deaths).toHaveLength(0);
  expect(isRecentAttacker("t1", "c1")).toBe(false);
});

// ------------------------------------------- the caster's node sends a hit

function casterNode(): { caster: any; mirror: any } {
  const caster: Row = {
    id: "c1", username: "Caster", stats: { level: 5 }, party: ["Friend"], wt: recordingWt(),
    location: { map: "forest.json", position: { x: 10, y: 20, direction: "right" } },
    aoi: { layerId: "forest:layer_1", playersInAOI: new Set<string>() },
  };
  playerCache.add("c1", caster);
  const mirror: Row = {
    id: "t1", username: "Target", remote: true, mirrorFrom: "b", stats: { health: 50 },
    location: { map: "forest", position: { x: 30, y: 20 } }, aoi: { layerId: "forest:layer_1", playersInAOI: new Set<string>() },
  };
  mirrorPlayers.set("t1", mirror);
  return { caster, mirror };
}

test("a hit that landed flags the caster, stamps its last attack and never writes the mirror", async () => {
  const { caster, mirror } = casterNode();
  const before = JSON.stringify(mirror);
  ownerAnswer = { outcome: "applied", stats: { health: 38 }, absorb: 0 };
  expect(await helpers().hitRemotePlayer(caster, mirror, hitOf())).toBe(true);
  expect(caster.pvp).toBe(true);
  expect(typeof caster.last_attack).toBe("number");
  expect(JSON.stringify(mirror)).toBe(before);
  expect(mirror.pvp).toBeUndefined();
  expect(mirror.last_attack).toBeUndefined();
});

test("a kill emits one PLAYER_DEATH with the mirror as the player and the caster as the killer", async () => {
  const { caster, mirror } = casterNode();
  ownerAnswer = { outcome: "killed", stats: { health: 0 } };
  expect(await helpers().hitRemotePlayer(caster, mirror, hitOf())).toBe(true);
  const deathsHeard = eventsOf(Events.PLAYER_DEATH);
  expect(deathsHeard).toHaveLength(1);
  expect(deathsHeard[0]![1]).toEqual({ player: mirror, killer: caster });
  expect(deaths).toHaveLength(0);
  expect(mirror.isDead).toBeUndefined();
});

test("a hit that did not land (refused, missing, no answer) leaves the caster unflagged and emits nothing", async () => {
  const { caster, mirror } = casterNode();
  for (const answer of [{ outcome: "refused", reason: "nopvp" }, { outcome: "missing" }, null]) {
    ownerAnswer = answer;
    expect(await helpers().hitRemotePlayer(caster, mirror, hitOf())).toBe(false);
  }
  expect(caster.pvp).toBeUndefined();
  expect(caster.last_attack).toBeUndefined();
  expect(emitted).toEqual([]);
  expect(caster.wt.sent).toEqual([]);
});

test("a hit on a party member does not flag the caster", async () => {
  const { caster, mirror } = casterNode();
  mirror.username = "Friend";
  ownerAnswer = { outcome: "applied", stats: { health: 38 } };
  await helpers().hitRemotePlayer(caster, mirror, hitOf({ casterParty: ["Friend"] }));
  expect(caster.pvp).toBeUndefined();
});

test("remoteHit takes the caster's place, party and layer", () => {
  const { caster } = casterNode();
  const hit = helpers().remoteHit(caster, { name: "Frost" }, 7, true, { showsDamage: true, harmful: true });
  expect(hit).toMatchObject({
    casterId: "c1", casterName: "Caster", casterLayer: "forest:layer_1", casterParty: ["Friend"],
    spell: { name: "Frost" }, damage: 7, isCrit: true, skipEffects: false, showsDamage: true, harmful: true,
    casterLocation: { map: "forest.json", position: { x: 10, y: 20, direction: "right" } },
  });
  // A copy: the caster moving on does not change the hit.
  caster.location.position.x = 99;
  expect(hit.casterLocation.position.x).toBe(10);
});

// ------------------------------------------ the damage number is shown once

/** Players with a socket that records what they are sent, and who sees whom. */
function viewer(id: string): any {
  const p: Row = { id, username: `user${id}`, party: [], wt: recordingWt(), location: { map: "forest.json", position: { x: 0, y: 0 } }, aoi: { layerId: null, playersInAOI: new Set<string>() } };
  playerCache.add(id, p);
  return p;
}
const sees = (viewerPlayer: any, seenId: string) => {
  viewerPlayer.aoi.playersInAOI.add(seenId);
  aoiReverse.addViewer(seenId, viewerPlayer.id);
};
const numbersSeen = (p: any) => p.wt.sent.filter((packet: any) => packet.type === "UPDATESTATS" && packet.data.damage === 12).length;

test("on a hit that landed, every viewer here gets the damage number once: the owner's relay reaches the mirror's viewers", async () => {
  const { caster, mirror } = casterNode();
  const seesBoth = viewer("v1");
  const seesCasterOnly = viewer("v2");
  const seesMirrorOnly = viewer("v3");
  sees(caster, "t1");
  sees(seesBoth, "t1");
  sees(seesBoth, "c1");
  sees(seesCasterOnly, "c1");
  sees(seesMirrorOnly, "t1");
  // The owner shows its viewers the number and relays it to the viewers of the mirror here (ghosts.relay).
  ownerSees = (hit) => {
    const packets = [new TextEncoder().encode(JSON.stringify({ type: "UPDATESTATS", data: { id: hit.casterId, target: "t1", damage: hit.damage } }))];
    broadcastToAOIBestEffort(mirror, packets as any, false);
  };
  ownerAnswer = { outcome: "applied", stats: { health: 38 }, absorb: 0 };
  await helpers().hitRemotePlayer(caster, mirror, hitOf());
  expect([caster, seesBoth, seesCasterOnly, seesMirrorOnly].map(numbersSeen)).toEqual([1, 1, 1, 1]);
});

test("on a kill nothing was relayed, so every viewer is sent the damage number here", async () => {
  const { caster, mirror } = casterNode();
  const seesBoth = viewer("v1");
  const seesCasterOnly = viewer("v2");
  const seesMirrorOnly = viewer("v3");
  sees(caster, "t1");
  sees(seesBoth, "t1");
  sees(seesBoth, "c1");
  sees(seesCasterOnly, "c1");
  sees(seesMirrorOnly, "t1");
  ownerAnswer = { outcome: "killed", stats: { health: 0 }, absorb: 0 };
  await helpers().hitRemotePlayer(caster, mirror, hitOf());
  expect([caster, seesBoth, seesCasterOnly, seesMirrorOnly].map(numbersSeen)).toEqual([1, 1, 1, 1]);
});

test("a hit that shows no damage sends no number", async () => {
  const { caster, mirror } = casterNode();
  sees(caster, "t1");
  ownerAnswer = { outcome: "applied", stats: { health: 38 } };
  await helpers().hitRemotePlayer(caster, mirror, hitOf({ showsDamage: false }));
  expect(caster.wt.sent).toEqual([]);
});

// -------------------------------------------------------------- withMirrors

test("withMirrors adds the mirrors in range on the caster's layer, also when the caster's position is a string", () => {
  const { caster } = casterNode();
  mirrorPlayers.set("m2", { id: "m2", username: "Near", remote: true, location: { map: "forest", position: { x: 40, y: 20 } }, aoi: { layerId: "forest:layer_2" } });
  mirrorPlayers.set("m3", { id: "m3", username: "Far", remote: true, location: { map: "forest", position: { x: 4000, y: 20 } }, aoi: { layerId: "forest:layer_1" } });
  const wt = { data: { id: "c1" } };
  expect(helpers().withMirrors(wt, 100, "forest.json").map((p: any) => p.id)).toEqual(["t1"]);
  caster.location.position = "10,20";
  expect(helpers().withMirrors(wt, 100, "forest.json").map((p: any) => p.id)).toEqual(["t1"]);
});

// ------------------------------------------------ the HOTBAR's remote branches
// The cast flow cannot be run on its own, so these read its source for the three rules of the branches
// around a mirrored target.

const hotbarRemoteCalls = [...source.matchAll(/await hitRemotePlayer\(currentPlayer, target, remoteHit\([^\n]*(?:\n[^\n]*){0,6}/g)].map((m) => m[0]);

test("charge and teleport-behind flag a mirrored target also when the spell has no effects", () => {
  const charge = hotbarRemoteCalls.filter((call) => call.includes("skipEffects: !hasEffects"));
  expect(charge).toHaveLength(2);
  for (const call of charge) expect(call).toContain("harmful: true");
  // The call is not inside an effects check: it is the line right after the comment of the branch.
  expect(source).not.toMatch(/if \(Array\.isArray\(spell\.effects\) && spell\.effects\.length > 0\) \{\s*await hitRemotePlayer/);
});

test("a dodged damage spell is still a harmful hit on a mirrored target", () => {
  const main = hotbarRemoteCalls.find((call) => call.includes("showsDamage: spell_damage !== 0"));
  expect(main).toBeDefined();
  expect(main).toContain("harmful: spell_damage > 0 || spellIsHostileEffect");
});

test("a single-target cast whose hit did not land ends before the PvP flag, the cast event and the splash", () => {
  const at = source.indexOf("if (!remoteLanded) break;");
  expect(at).toBeGreaterThan(0);
  const after = source.slice(at, at + 400);
  expect(after).toContain("// Is not in the targets party and is not self, then set PvP flag on both");
  expect(source.indexOf("remoteLanded = await hitRemotePlayer(")).toBeGreaterThan(0);
});
