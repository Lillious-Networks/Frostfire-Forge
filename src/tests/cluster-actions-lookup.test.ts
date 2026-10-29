import { afterEach, expect, test } from "bun:test";
import { ATTACK_MEMORY_MS, forgetVictim, isRecentAttacker, recordAttack, resetAttacks } from "../cluster/attackers";
import { Ghosts } from "../cluster/ghosts";
import { bareMap, mirrorByUsername, mirrorOwner, mirrorPlayers, mirrorsNearPoint, mirrorsOnLayerNear } from "../cluster/mirrors";
import { receiverSource as readReceiverSource } from "./receiver-source";

afterEach(() => {
  mirrorPlayers.clear();
  resetAttacks();
});

const mirror = (id: string, username: string, map: string, x: number, y: number, from = "b") =>
  ({ id, username, remote: true, mirrorFrom: from, location: { map, position: { x, y, direction: "down" } } });

test("bareMap drops one .json ending", () => {
  expect(bareMap("forest.json")).toBe("forest");
  expect(bareMap("forest")).toBe("forest");
  expect(bareMap(undefined)).toBe("");
});

test("a mirror is found by username, any case, and its owner by id", () => {
  mirrorPlayers.set("7", mirror("7", "Alice", "forest", 0, 0, "node-2"));
  expect(mirrorByUsername("alice")?.id).toBe("7");
  expect(mirrorByUsername("bob")).toBeUndefined();
  expect(mirrorOwner("7")).toBe("node-2");
  expect(mirrorOwner(7)).toBe("node-2");
  expect(mirrorOwner("8")).toBeNull();
});

test("mirrorsNearPoint keeps mirrors on the map inside the radius", () => {
  mirrorPlayers.set("1", mirror("1", "near", "forest", 10, 0));
  mirrorPlayers.set("2", mirror("2", "far", "forest", 500, 0));
  mirrorPlayers.set("3", mirror("3", "other", "cave", 0, 0));
  expect(mirrorsNearPoint("forest.json", 0, 0, 50).map((m) => m.id)).toEqual(["1"]);
  expect(mirrorsNearPoint("forest", 0, 0, 1000).map((m) => m.id).sort()).toEqual(["1", "2"]);
});

test("mirrorsOnLayerNear keeps the mirrors on the layer, or every layer when it is undefined", () => {
  mirrorPlayers.set("1", { ...mirror("1", "a", "forest", 0, 0), aoi: { layerId: "L1" } });
  mirrorPlayers.set("2", { ...mirror("2", "b", "forest", 5, 0), aoi: { layerId: "L2" } });
  mirrorPlayers.set("3", mirror("3", "c", "forest", 5, 5));
  expect(mirrorsOnLayerNear("forest", 0, 0, 50, "L1").map((m) => m.id)).toEqual(["1"]);
  expect(mirrorsOnLayerNear("forest", 0, 0, 50, null).map((m) => m.id)).toEqual(["3"]);
  expect(mirrorsOnLayerNear("forest", 0, 0, 50, undefined).map((m) => m.id).sort()).toEqual(["1", "2", "3"]);
});

test("ownerOf names the node a mirrored entity came from, for its kind only", () => {
  const ghosts = new Ghosts();
  // The store is private: a mirror is put there the way the receiver does, through its MirrorStore.
  (ghosts as any).mirrors.set({ kind: "loot", id: "loot_12", num: 12, from: "node-3", confirmedAt: 0 });
  expect(ghosts.ownerOf("loot", "loot_12")).toBe("node-3");
  expect(ghosts.ownerOf("chest", "loot_12")).toBeNull();
  expect(ghosts.ownerOf("loot", "loot_13")).toBeNull();
});

test("an empty username finds no mirror, and a mirror without a location is skipped", () => {
  mirrorPlayers.set("1", { id: "1", remote: true, mirrorFrom: "b" });
  expect(mirrorByUsername("")).toBeUndefined();
  expect(mirrorsNearPoint("", 0, 0, 100)).toEqual([]);
});

test("numeric ids are remembered as their strings, and a victim can be forgotten", () => {
  recordAttack(5, 6, 1000);
  expect(isRecentAttacker("6", "5", 1001)).toBe(true);
  forgetVictim(6);
  expect(isRecentAttacker("6", "5", 1001)).toBe(false);
});

test("a recent attacker is remembered for ATTACK_MEMORY_MS", () => {
  recordAttack("att", "vic", 1000);
  expect(isRecentAttacker("vic", "att", 1000 + ATTACK_MEMORY_MS - 1)).toBe(true);
  expect(isRecentAttacker("att", "vic", 1001)).toBe(false);
  expect(isRecentAttacker("vic", "att", 1000 + ATTACK_MEMORY_MS + 1)).toBe(false);
});

// ------------------------------------------------ the receiver's lookups
// socket/receiver.ts cannot be imported by a test (it imports the server, which starts it), so, as the
// other receiver tests do, the helpers are read from its source and run with the names they use handed in.
const receiverSource = readReceiverSource();
const receiverTranspiler = new Bun.Transpiler({ loader: "ts" });
function sliceOf(from: string, to: string): string {
  const start = receiverSource.indexOf(from);
  const end = receiverSource.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`${from} was not found in socket/receiver.ts`);
  return receiverSource.slice(start, end).replace(/^export /gm, "");
}
const lookups: any = new Function(`"use strict";\n${receiverTranspiler.transformSync(
  `function make({ getPlayersNearPoint, mirrorsOnLayerNear }: any) { ${sliceOf("function playersAndMirrorsNear(", "/** The players within `distance`")}\nreturn { playersAndMirrorsNear, inspectPlayerData }; }`,
)}\nreturn make;`)()({ getPlayersNearPoint: (...args: any[]) => nearLocal(...args), mirrorsOnLayerNear });
let nearLocal: (...args: any[]) => any[] = () => [];

test("an area spell finds the local players and the mirrors the same query finds", () => {
  mirrorPlayers.set("m1", { ...mirror("m1", "far", "forest", 5, 0), aoi: { layerId: "L1" } });
  mirrorPlayers.set("m2", { ...mirror("m2", "other", "forest", 5, 0), aoi: { layerId: "L2" } });
  let asked: any[] = [];
  nearLocal = (...args) => { asked = args; return [{ id: "local" }]; };
  const found = lookups.playersAndMirrorsNear(0, 0, "forest.json", 50, "L1");
  expect(found.map((p: any) => p.id)).toEqual(["local", "m1"]);
  expect(asked).toEqual([0, 0, "forest.json", 50, "L1"]);
});

test("the inspect window gets the whole inventory when asked, else only what is worn", () => {
  const target = { id: "9", username: "T", stats: { level: 3 }, equipment: { head: "Helm", hand: null }, inventory: [{ name: "Helm" }, { name: "Apple" }] };
  expect(lookups.inspectPlayerData(target, true).inventory.map((r: any) => r.name)).toEqual(["Helm", "Apple"]);
  const worn = lookups.inspectPlayerData(target, false);
  expect(worn.inventory.map((r: any) => r.name)).toEqual(["Helm"]);
  expect(worn).toMatchObject({ id: "9", username: "T", stats: { level: 3 }, equipment: { head: "Helm", hand: null } });
});

// The two helpers of the splash and inspect paths, run with stand-ins for the names they use.
const routing: (given: Record<string, any>) => any = new Function(`"use strict";\n${receiverTranspiler.transformSync(
  `function make({ hitRemotePlayer, remoteHit, playerCache, mirrorPlayers, runOnPlayer }: any) { ${sliceOf("function routeSplashToMirror(", "/**\n * A hit on a player of this node")}\nreturn { routeSplashToMirror, inspectOnOwner }; }`,
)}\nreturn make;`)();

function splashFakes() {
  const sent: any[][] = [];
  const releases: (() => void)[] = [];
  const helpers = routing({
    // A hit that lands once released: the owner's answer is not instant.
    hitRemotePlayer: (caster: any, victim: any, hit: any) => {
      sent.push([caster, victim, hit]);
      return new Promise<boolean>((resolve) => releases.push(() => resolve(true)));
    },
    remoteHit: (...args: any[]) => ({ made: args }),
  });
  return { sent, releases, route: helpers.routeSplashToMirror };
}

test("a splash victim that is a mirror is sent to its owner as a rolled hit, and the caller is told not to apply it", () => {
  const { sent, route } = splashFakes();
  const pending: Promise<boolean>[] = [];
  const caster = { id: "c" };
  const victim = { id: "m", remote: true };
  const spell = { name: "Nova" };
  const how = { skipEffects: true, showsDamage: false, harmful: true };
  expect(route(pending, caster, victim, spell, 12, how)).toBe(true);
  expect(pending).toHaveLength(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]![0]).toBe(caster);
  expect(sent[0]![1]).toBe(victim);
  // remoteHit(caster, spell, damage, isCrit, how): the rolled damage and the flags of the site are passed through.
  expect(sent[0]![2].made).toEqual([caster, spell, 12, false, how]);
  expect(sent[0]![2].made[4]).toBe(how);
});

test("a splash victim that is a local player is left to the caller and nothing is sent", () => {
  const { sent, route } = splashFakes();
  const pending: Promise<boolean>[] = [];
  expect(route(pending, { id: "c" }, { id: "p" }, {}, 12, { showsDamage: true, harmful: true })).toBe(false);
  expect(route(pending, { id: "c" }, { id: "p", remote: false }, {}, 12, { showsDamage: true, harmful: true })).toBe(false);
  expect(pending).toEqual([]);
  expect(sent).toEqual([]);
});

test("the hits on several mirrors are all started before any of them is answered", async () => {
  const { sent, releases, route } = splashFakes();
  const pending: Promise<boolean>[] = [];
  for (const id of ["m1", "m2", "m3"]) route(pending, { id: "c" }, { id, remote: true }, {}, 5, { showsDamage: true, harmful: true });
  // None has been answered yet, and all three were sent: a dead owner link does not hold the others back.
  expect(sent.map((s) => s[1].id)).toEqual(["m1", "m2", "m3"]);
  expect(releases).toHaveLength(3);
  let done = false;
  const all = Promise.all(pending).then(() => { done = true; });
  releases[2]!();
  releases[0]!();
  await Promise.resolve();
  expect(done).toBe(false);
  releases[1]!();
  await all;
  expect(done).toBe(true);
});

function inspectFakes(local: Record<string, any>, mirrors: Record<string, any>) {
  const calls: any[][] = [];
  const cache = { get: (id: string) => local[id] };
  const map = { get: (id: string) => mirrors[id] };
  const helpers = routing({ playerCache: cache, mirrorPlayers: map, runOnPlayer: async (...args: any[]) => { calls.push(args); return true; } });
  return { calls, inspectOnOwner: helpers.inspectOnOwner };
}

test("inspecting a mirror asks its owner for the answer, with the asker's own admin flag and never a client's", async () => {
  const { calls, inspectOnOwner } = inspectFakes({}, { "7": { id: "7", username: "Border" } });
  expect(await inspectOnOwner({ username: "Asker", isAdmin: false }, "7")).toBe(true);
  expect(await inspectOnOwner({ username: "Asker" }, 7)).toBe(true);
  expect(await inspectOnOwner({ username: "Boss", isAdmin: true }, "7")).toBe(true);
  expect(calls).toEqual([
    ["Border", "cells-inspect", { asker: "Asker", admin: false }],
    ["Border", "cells-inspect", { asker: "Asker", admin: false }],
    ["Border", "cells-inspect", { asker: "Boss", admin: true }],
  ]);
});

test("inspecting a player of this node, nobody, or an unknown id is left to the local lookup", async () => {
  const { calls, inspectOnOwner } = inspectFakes({ "5": { id: "5" } }, { "5": { id: "5", username: "Twin" }, "7": { id: "7", username: "Border" } });
  const asker = { username: "Asker", isAdmin: true };
  // The id is held locally (even if a mirror of it exists): the local player is inspected.
  expect(await inspectOnOwner(asker, "5")).toBe(false);
  expect(await inspectOnOwner(asker, undefined)).toBe(false);
  expect(await inspectOnOwner(asker, "")).toBe(false);
  expect(await inspectOnOwner(asker, "99")).toBe(false);
  expect(calls).toEqual([]);
});

test("the splash loops: the area queries, the routing calls and the wait for the owners are as each site needs", () => {
  expect(receiverSource).not.toContain("phase 5 sends it APPLY_EFFECT");
  expect(receiverSource.match(/playersAndMirrorsNear\(/g)).toHaveLength(4);
  const once = (text: string) => expect(receiverSource.split(text).length - 1).toBe(1);
  // The layer of the caster is what each area query is asked for.
  once("for (const p of playersAndMirrorsNear(aoeX, aoeY, currentPlayer.location.map, aoeRadius, layerManager.getPlayerLayer(currentPlayer.id))) {");
  once("for (const p of playersAndMirrorsNear(groundX, groundY, currentPlayer.location.map, groundAoERadius, layerManager.getPlayerLayer(currentPlayer.id))) {");
  once("for (const p of playersAndMirrorsNear(targetX, targetY, currentPlayer.location.map, aoeRadius, layerManager.getPlayerLayer(currentPlayer.id))) {");
  // Each victim is routed by one statement that ends in its own continue, with the flags the local block uses.
  once("if (routeSplashToMirror(remoteHits, currentPlayer, st, spell, splashDmg, { skipEffects: spell_damage > 0 && splashDmg === 0, showsDamage: spell_damage !== 0, harmful: !aoeIsHeal })) continue;");
  once("if (routeSplashToMirror(remoteHits, currentPlayer, st, spell, splashDmg, { skipEffects: spell_damage > 0 && splashDmg === 0, showsDamage: spell_damage !== 0, harmful: !isHeal })) continue;");
  once("if (routeSplashToMirror(remoteHits, currentPlayer, splashTarget, spell, splashDmg, { showsDamage: true, harmful: spell_damage > 0 || spellIsHostileEffect })) continue;");
  expect(receiverSource.match(/routeSplashToMirror\(/g)).toHaveLength(4);
  // The owners are waited for once per loop, after it.
  expect(receiverSource.match(/const remoteHits: Promise<boolean>\[\] = \[\];/g)).toHaveLength(3);
  expect(receiverSource.match(/if \(remoteHits\.length\) await Promise\.allSettled\(remoteHits\);/g)).toHaveLength(3);
  // A hit on a mirror is never awaited inside a loop one at a time.
  expect(receiverSource).not.toMatch(/await hitRemotePlayer\(currentPlayer, (st|splashTarget),/);
});

test("a mirrored creature's spell text is asked of its owner, a local one's is not", () => {
  expect(receiverSource).toContain('creatures.combat.damageCreature(creature, caster.id, amount, now, 1, creature.remote ? "spell" : null)');
  expect(receiverSource).toContain('damageCreature(target, after.id, amount, now, 1, target.remote ? (isCrit ? "crit" : "spell") : null)');
});

test("targeting, inspect, invites, ignore and report look a mirror up", () => {
  expect(receiverSource).toContain("const playersInRange = withMirrors(");
  // INSPECTPLAYER asks the owner first, and ends there when a mirror was inspected.
  expect(receiverSource.split("if (await inspectOnOwner(currentPlayer, targetId)) break;").length - 1).toBe(1);
  expect(receiverSource.match(/const invitedUser = entityById\(invited_user\);/g)).toHaveLength(2);
  expect(receiverSource).toContain("const get_friend = entityById(id);");
  expect(receiverSource).toContain("const named = entityById((data as any)?.id)?.username");
  expect(receiverSource).toContain("const reported = entityById((data as any)?.id)?.username");
});

test("SELECTPLAYER offers the mirrors on the map, and the inspected node answers by name unless the player is stealthed", () => {
  expect(receiverSource).toContain("if (bareMap(mirror.location?.map) === bareMap(currentPlayer.location.map)) players.push(mirror);");
  const action = sliceOf('registerPlayerAction("cells-inspect"', "registerPlayerAction(\"displaced-login\"");
  expect(action).toContain("if (p.isStealth && !admin) return;");
  expect(action).toContain("deliverToPlayer(String(asker), packetManager.inspectPlayer(inspectPlayerData(p, !!admin)))");
});
