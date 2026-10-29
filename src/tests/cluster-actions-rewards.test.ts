import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { LinkCalls, linkCalls } from "../cluster/linkcalls";
import { mirrorPlayers } from "../cluster/mirrors";
import { sendRewards, setRewardApplier, type RewardApplier, type RewardBody } from "../systems/creatures/remotereward";
import { linkPair } from "./cluster-fakelink";
import { databaseModule, mockQuery } from "./setup";

// kill.ts reaches the database through many modules; none of this test's rewards read or write a row.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));

const { applyReward, handleKill, setKnownTemplates } = await import("../systems/creatures/kill");
const { CreatureFlags } = await import("../systems/creatures/constants");
const { distributeKillXp } = await import("../systems/creatures/rewards");
const { AIState } = await import("../systems/creatures/types");
const { Events, listener } = await import("../systems/events");
const { default: playerCache } = await import("../services/playermanager");
const { default: playerSystem } = await import("../systems/player");

// kill.ts sets its applier when it loads, and every test file shares one process: put it back afterwards.
let saved: RewardApplier | null = null;

beforeEach(() => {
  saved = setRewardApplier(null);
});

afterEach(() => {
  mirrorPlayers.clear();
  setRewardApplier(saved);
  linkCalls.detach();
});

const reward = (over: Partial<RewardBody> = {}): RewardBody =>
  ({ username: "alice", playerId: "7", creatureId: 50, templateId: 3, templateName: "Wolf", xp: 40, ...over });

test("APPLY_REWARD runs the applier and answers whether the player was here", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  const applied: string[] = [];
  setRewardApplier(async (body) => {
    applied.push(body.username);
    return body.username === "alice";
  });
  expect(await caller.call("b", "APPLY_REWARD", reward())).toEqual({ ok: true, answer: { ok: true } });
  expect(await caller.call("b", "APPLY_REWARD", reward({ username: "bob" }))).toEqual({ ok: true, answer: { ok: false } });
  expect(applied).toEqual(["alice", "bob"]);
  caller.detach();
});

test("with no applier, APPLY_REWARD answers not applied", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  // beforeEach cleared the applier kill.ts may have set.
  expect(await caller.call("b", "APPLY_REWARD", reward())).toEqual({ ok: true, answer: { ok: false } });
  caller.detach();
});

test("setRewardApplier answers the applier it replaces", () => {
  const first: RewardApplier = async () => true;
  const second: RewardApplier = async () => false;
  expect(setRewardApplier(first)).toBeNull();
  expect(setRewardApplier(second)).toBe(first);
  expect(setRewardApplier(null)).toBe(second);
});

test("sendRewards sends each share to the member's node and names the shares not confirmed", async () => {
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  const got: RewardBody[] = [];
  owner.handle("APPLY_REWARD", (body: RewardBody) => {
    got.push(body);
    return { ok: body.username !== "carol" };
  });
  mirrorPlayers.set("7", { id: "7", username: "alice", remote: true, mirrorFrom: "b" });
  mirrorPlayers.set("8", { id: "8", username: "carol", remote: true, mirrorFrom: "b" });
  // dave has no mirror any more: his node is not known.
  const missed = await sendRewards([reward(), reward({ username: "carol", playerId: "8" }), reward({ username: "dave", playerId: "9" })]);
  expect(missed.sort()).toEqual(["carol", "dave"]);
  expect(got.map((body) => [body.username, body.xp, body.templateName])).toEqual([["alice", 40, "Wolf"], ["carol", 40, "Wolf"]]);
  owner.detach();
});

test("a share for a node whose link is down is not confirmed", async () => {
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  owner.handle("APPLY_REWARD", () => ({ ok: true }));
  mirrorPlayers.set("7", { id: "7", username: "alice", remote: true, mirrorFrom: "b" });
  b.setUp(false);
  expect(await sendRewards([reward()])).toEqual(["alice"]);
  owner.detach();
});

// ------------------------------------------------------------------ handleKill and applyReward

// The party: ann (level 10, the tapper) and bob (20) are here. cat (30) is a mirror 400 px from the corpse, dan a
// mirror 900 px away (out of the 800 px reward range) and eve a mirror that is a ghost. Level 30 against a level 30
// creature gives XP, so every share is more than zero.
const levels: Record<string, number> = { ann: 10, bob: 20, cat: 30 };
const CORPSE = { x: 1000, y: 1000 };

const here = (id: string, name: string, x: number, over: any = {}) => ({
  id, username: name, location: { map: "main.json", position: { x, y: CORPSE.y } }, stats: { level: levels[name] ?? 5 }, ...over,
});
const mirror = (id: string, name: string, x: number, over: any = {}) => ({
  ...here(id, name, x), remote: true, mirrorFrom: "b", location: { map: "main", position: { x, y: CORPSE.y } }, ...over,
});

const creature = (): any => ({
  id: 50, map: "main", x: CORPSE.x, y: CORPSE.y, layerId: null, level: 30, state: AIState.DEAD,
  combat: { tapper: { playerId: "1", username: "ann" }, corpseUntil: 0 },
});
const template = (flags = 0): any => ({ id: 3, name: "Wolf", rank: "normal", xp_mult: 1, flags, loot_table_id: null, gold_min: 0, gold_max: 0, level_min: 30, level_max: 30 });

/** The shares one node would give this party for this creature. */
function reference(members: Array<[string, number]>): Map<string, number> {
  return distributeKillXp(members.map(([username, level]) => ({ username, level })), 30, "normal", 1);
}

interface Seen {
  awards: Array<[string, number]>;
  bodies: RewardBody[];
  credited: string[];
  link: any;
  hasLink: () => boolean;
}

/**
 * Runs `body` with the local players, the mirrors, a link to the node "b" (its APPLY_REWARD answered by `answer`)
 * and listeners on the XP awards and the kill credit. Everything is put back afterwards.
 */
async function scene(
  locals: any[],
  mirrors: any[],
  body: (seen: Seen) => Promise<void>,
  answer: (reward: RewardBody) => unknown = () => ({ ok: true })
): Promise<void> {
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  const bodies: RewardBody[] = [];
  owner.handle("APPLY_REWARD", (reward: RewardBody) => {
    bodies.push(reward);
    return answer(reward);
  });
  const awards: Array<[string, number]> = [];
  const increase = spyOn(playerSystem, "increaseXp").mockImplementation((async (username: string, amount: number) => {
    awards.push([username, amount]);
    return { xp: amount, max_xp: 1000, level: levels[username] ?? 5 };
  }) as any);
  const credited: string[] = [];
  const hear = (event: any) => credited.push(`${event.player.username}:${event.templateId}`);
  listener.on(Events.CREATURE_KILL_CREDIT, hear);
  for (const p of locals) playerCache.add(p.id, p);
  for (const m of mirrors) mirrorPlayers.set(m.id, m);
  try {
    await body({ awards, bodies, credited, link: b, hasLink: () => a.sent.includes("CALL") });
  } finally {
    for (const p of locals) playerCache.remove(p.id);
    listener.off(Events.CREATURE_KILL_CREDIT, hear);
    increase.mockRestore();
    owner.detach();
  }
}

const party = ["bob", "cat", "dan", "eve"];
const ann = () => here("1", "ann", 1000, { party });
const bob = () => here("2", "bob", 1100);
const cat = () => mirror("m3", "cat", 1400);
const dan = () => mirror("m4", "dan", 1900);
const eve = () => mirror("m5", "eve", 1100, { isGhost: true });
const sorted = (pairs: Array<[string, number]>) => [...pairs].sort((x, y) => x[0].localeCompare(y[0]));

test("a kill splits the XP over local and remote members: locals are paid here, the mirror's share goes to its node", async () => {
  const split = reference([["ann", 10], ["bob", 20], ["cat", 30]]);
  expect(split.get("cat")).toBeGreaterThan(0);
  await scene([ann(), bob()], [cat(), dan(), eve()], async (seen) => {
    await handleKill(creature(), template());
    // Here: ann and bob only. Out of range (dan) and a ghost (eve) are in neither the split nor the calls.
    expect(sorted(seen.awards)).toEqual([["ann", split.get("ann")!], ["bob", split.get("bob")!]]);
    // One call, for cat, carrying cat's share and the kill.
    expect(seen.bodies).toEqual([{ username: "cat", playerId: "m3", creatureId: 50, templateId: 3, templateName: "Wolf", xp: split.get("cat")! }]);
    // The shares are those of one node paying three members: the same total.
    const total = seen.awards.reduce((sum, [, amount]) => sum + amount, 0) + seen.bodies[0].xp;
    expect(total).toBe([...split.values()].reduce((sum, amount) => sum + amount, 0));
    // Kill credit is emitted here for the local members only; cat's node emits its own.
    expect(seen.credited.sort()).toEqual(["ann:3", "bob:3"]);
  });
});

test("the shares are the same numbers when the remote member is a local player", async () => {
  const split = reference([["ann", 10], ["bob", 20], ["cat", 30]]);
  const local = here("3", "cat", 1400);
  await scene([ann(), bob(), local], [], async (seen) => {
    await handleKill(creature(), template());
    expect(sorted(seen.awards)).toEqual([["ann", split.get("ann")!], ["bob", split.get("bob")!], ["cat", split.get("cat")!]]);
    expect(seen.bodies).toEqual([]);
  });
});

test("a mirror that is gone before the kill is no member: the others share as two", async () => {
  const split = reference([["ann", 10], ["bob", 20]]);
  await scene([ann(), bob()], [], async (seen) => {
    await handleKill(creature(), template());
    expect(sorted(seen.awards)).toEqual([["ann", split.get("ann")!], ["bob", split.get("bob")!]]);
    expect(seen.bodies).toEqual([]);
    // With no mirror at all, nothing is sent over a link.
    expect(seen.hasLink()).toBe(false);
  });
});

test("a node that answers not applied, or whose link is down, does not stop the local awards", async () => {
  const split = reference([["ann", 10], ["bob", 20], ["cat", 30]]);
  await scene([ann(), bob()], [cat()], async (seen) => {
    await handleKill(creature(), template());
    expect(seen.bodies.length).toBe(1);
    expect(sorted(seen.awards)).toEqual([["ann", split.get("ann")!], ["bob", split.get("bob")!]]);
  }, () => ({ ok: false }));
  await scene([ann(), bob()], [cat()], async (seen) => {
    seen.link.setUp(false);
    await handleKill(creature(), template());
    expect(seen.bodies).toEqual([]);
    expect(sorted(seen.awards)).toEqual([["ann", split.get("ann")!], ["bob", split.get("bob")!]]);
    expect(seen.credited.sort()).toEqual(["ann:3", "bob:3"]);
  });
});

test("a creature that gives no XP pays nobody, and the remote member still gets the call with 0 XP", async () => {
  await scene([ann(), bob()], [cat()], async (seen) => {
    await handleKill(creature(), template(CreatureFlags.NO_XP));
    expect(seen.awards).toEqual([]);
    expect(seen.bodies.map((reward) => [reward.username, reward.xp])).toEqual([["cat", 0]]);
    expect(seen.credited.sort()).toEqual(["ann:3", "bob:3"]);
  });
});

test("a mirror with no stats has no known level: it is left out of the split and gets 0 XP", async () => {
  const split = reference([["ann", 10], ["bob", 20], ["cat", 30]]);
  const faceless = mirror("m6", "fay", 1200, { stats: null });
  const grouped = ann();
  grouped.party = [...party, "fay"];
  await scene([grouped, bob()], [cat(), faceless], async (seen) => {
    await handleKill(creature(), template());
    // Counted as level 1 it would make the group four and move every share.
    expect(sorted(seen.awards)).toEqual([["ann", split.get("ann")!], ["bob", split.get("bob")!]]);
    expect(seen.bodies.map((reward) => [reward.username, reward.xp]).sort()).toEqual([["cat", split.get("cat")!], ["fay", 0]]);
  });
});

test("applyReward pays XP and gives kill credit to the player here, and refuses an unknown id or a wrong name", async () => {
  const reward: RewardBody = { username: "Ann", playerId: "1", creatureId: 50, templateId: 3, templateName: "Wolf", xp: 40 };
  // The template is this node's own: it names the creature, and it is what the XP is held to.
  const saved = setKnownTemplates(new Map([[3, template()]]));
  try {
    await scene([ann()], [], async (seen) => {
      expect(await applyReward(reward)).toBe(true);
      expect(seen.awards).toEqual([["ann", 40]]);
      expect(seen.credited).toEqual(["ann:3"]);
      expect(await applyReward({ ...reward, playerId: "99" })).toBe(false);
      expect(await applyReward({ ...reward, username: "bob" })).toBe(false);
      expect(seen.awards.length).toBe(1);
      expect(seen.credited.length).toBe(1);
    });
  } finally {
    setKnownTemplates(saved);
  }
});
