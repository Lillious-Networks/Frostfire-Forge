import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";

// Cells phase 6, security review of the arrival side (M2, M4 detail, L3, L7) and the final review's M1 and M2:
//   - what a DoT or HoT brings with an arriving player (arrival.ts) is clamped to what a spell can make, and its
//     caster is kept only when this node knows them;
//   - the corpse's map is one this node has;
//   - the reverse summon (cells-teleport-to) carries the admin's own summon-admins permission, sent by the admin's
//     node and passed on by the target's, never made up;
//   - a gather result is checked against the node's item and largest yield (gathering/remote.ts);
//   - a teleport outside a packet, and a trade, are refused for a player in a handoff.
// The receiver cannot be imported by a test (it imports the server, which starts it): the pieces that decide are cut
// out of its source and run with the names they use handed in, as cluster-handoff-receiver.test.ts does.

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const { default: log } = await import("../modules/logger");
const { STAT_INT_MAX } = await import("../systems/creatures/remotereward");
const { withPeriodicBonus } = await import("../systems/spellmath");
const { arrivalLimits, handoffStateOf, MIN_DOT_INTERVAL_S, reverseSummonAdmins } = await import("../socket/arrival");
const { receiveGathered } = await import("../systems/gathering/remote");
const { REASONS } = await import("../systems/gathering/service");
const { ARRIVAL_TTL_MS } = await import("../cluster/handoff");

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function quietLog(): { warned: string[]; errored: string[]; info: string[] } {
  const seen = { warned: [] as string[], errored: [] as string[], info: [] as string[] };
  const warn = spyOn(log, "warn").mockImplementation(((message: string) => { seen.warned.push(message); }) as any);
  const error = spyOn(log, "error").mockImplementation(((message: string) => { seen.errored.push(message); }) as any);
  const info = spyOn(log, "info").mockImplementation(((message: string) => { seen.info.push(message); }) as any);
  const debug = spyOn(log, "debug").mockImplementation((() => {}) as any);
  restores.push(() => warn.mockRestore(), () => error.mockRestore(), () => info.mockRestore(), () => debug.mockRestore());
  return seen;
}

// ------------------------------------------------------------------ M2: DoTs and HoTs that arrive with a player

// The default poison (database_setup.ts), a HoT, and the largest and fastest effects the spell editor allows
// (spelleditor.ts: value up to 100000, a tick every 0.25 s at the least, up to 100 stacks).
const SPELLS = [
  { name: "poison_bolt", effects: [{ type: "damage_over_time", value: 4, duration: 12, interval: 3, stackable: true, max_stacks: 5 }] },
  { name: "renew", effects: [{ type: "heal_over_time", value: 6, duration: 15, interval: 3 }] },
  { name: "plague", effects: [{ type: "damage_over_time", value: 100_000, duration: 10, interval: 0.25, stackable: true, max_stacks: 100 }] },
  { name: "ice_age", effects: [{ type: "damage_over_time", value: 7, duration: 10, interval: 3600 }] },
];
const limits = (now = Date.now()) => arrivalLimits(SPELLS, now);

/** A caster this node knows: the one player of its cache and its mirrors. */
const caster = (id: string, username: string) => id === "7" && username === "Mage";
const KNOWN = { caster, maps: [{ name: "main.json" }] };

/** The DoT the dots.ts scheduler holds for a spell's effect, as applyDot builds it (the caster's damage stat adds a share). */
function dotOf(spell: (typeof SPELLS)[number], statDamage: number, over: any = {}) {
  const base: any = spell.effects[0];
  const effect = withPeriodicBonus(base.type === "heal_over_time" ? { ...base, value: -Math.abs(base.value) } : base, statDamage);
  const stackable = base.stackable === true;
  const maxStacks = stackable ? Math.max(1, Number(base.max_stacks) || 5) : 1;
  const now = Date.now();
  return {
    id: spell.name, spell: spell.name, icon: null, casterId: "7", casterUsername: "Mage",
    damagePerTick: Math.floor(Number(effect.value)), interval: base.interval, duration: base.duration, stackable, maxStacks,
    stacks: stackable ? maxStacks : 1, expiresAt: now + base.duration * 1000, nextTickAt: now + base.interval * 1000, particles: null,
    ...over,
  };
}
const dotsOf = (dots: any[], known: any = KNOWN, now = Date.now()) => handoffStateOf({ dots }, limits(now), "Probe", known).dots;

test("the scheduler period the arrival clamps to is the one of systems/dots.ts", () => {
  const dotsSource = readFileSync(join(import.meta.dir, "..", "systems", "dots.ts"), "utf8");
  const period = Number(/const SCHEDULER_INTERVAL_MS = (\d+);/.exec(dotsSource)?.[1]);
  expect(period).toBeGreaterThan(0);
  expect(MIN_DOT_INTERVAL_S).toBe(period / 1000);
});

test("a DoT or HoT of any spell passes unchanged, with its caster", () => {
  const logged = quietLog();
  for (const spell of SPELLS) {
    for (const stat of [0, 250, 40_000]) {
      const dot = dotOf(spell, stat);
      expect(dotsOf([dot])).toEqual([dot]);
    }
  }
  // The effects of the largest spell: 100000 a tick and 100 stacks stays inside STAT_INT_MAX with a damage stat's share.
  const plague = dotOf(SPELLS[2]!, 40_000);
  expect(Math.abs(plague.damagePerTick) * plague.maxStacks).toBeLessThanOrEqual(STAT_INT_MAX);
  // A HoT keeps its sign, and a DoT with no caster named stays as it is.
  expect(dotsOf([dotOf(SPELLS[1]!, 100)])[0].damagePerTick).toBeLessThan(0);
  expect(dotsOf([dotOf(SPELLS[0]!, 0, { casterId: "", casterUsername: "" })])).toHaveLength(1);
  expect(logged.warned).toEqual([]);
});

test("a DoT that arrives late keeps the ticks it is owed (review I1)", () => {
  const logged = quietLog();
  const now = Date.now();
  // A handoff takes 0.5 to 3 s (SWITCH, reconnect, AUTH) and up to the arrival's 30 s wait: the scheduler pays what
  // fell due, one tick per pass, as after a relog.
  for (const [spell, behind] of [[SPELLS[2]!, 1200], [SPELLS[2]!, 3000], [SPELLS[0]!, 3000], [SPELLS[1]!, 2500], [SPELLS[0]!, ARRIVAL_TTL_MS]] as const) {
    const dot = dotOf(spell, 0, { nextTickAt: now - behind, expiresAt: now + 60_000 });
    expect(dotsOf([dot], KNOWN, now)).toEqual([dot]);
  }
  expect(logged.warned).toEqual([]);
});

test("a tick time further behind than an arrival can wait, and a period, is brought to now (review I1)", () => {
  quietLog();
  const now = Date.now();
  const period = 3000;
  const at = (nextTickAt: number) => dotsOf([dotOf(SPELLS[0]!, 0, { nextTickAt, expiresAt: now + 60_000 })], KNOWN, now)[0].nextTickAt;
  expect(at(now - ARRIVAL_TTL_MS - period)).toBe(now - ARRIVAL_TTL_MS - period);
  expect(at(now - ARRIVAL_TTL_MS - period - 1)).toBe(now);
  expect(at(-1e15)).toBe(now);
});

test("a creature's DoT arrives with no caster, and that is no warning (review M1)", () => {
  const logged = quietLog();
  // Creatures cast as "creature:<id>" under their template's name (creatures/index.ts), so applyDot stored these.
  const [dot] = dotsOf([dotOf(SPELLS[0]!, 0, { casterId: "creature:12", casterUsername: "Wolf" })]);
  expect([dot.casterId, dot.casterUsername]).toEqual(["", ""]);
  expect(dot.damagePerTick).toBe(4);
  expect(logged.warned).toEqual([]);
  // The same name on an id that is not a creature's is still a warning.
  dotsOf([dotOf(SPELLS[0]!, 0, { casterId: "99", casterUsername: "Wolf" })]);
  expect(logged.warned).toHaveLength(1);
});

test("a tick every 1e-9 s is cut to the scheduler's period, and a slow one stays", () => {
  const logged = quietLog();
  const fast = dotsOf([dotOf(SPELLS[0]!, 0, { interval: 1e-9 })]);
  expect(fast).toHaveLength(1);
  expect(fast[0].interval).toBe(MIN_DOT_INTERVAL_S);
  expect(dotsOf([dotOf(SPELLS[0]!, 0, { interval: 0.249 })])[0].interval).toBe(MIN_DOT_INTERVAL_S);
  expect(dotsOf([dotOf(SPELLS[0]!, 0, { interval: MIN_DOT_INTERVAL_S })])[0].interval).toBe(MIN_DOT_INTERVAL_S);
  expect(dotsOf([dotOf(SPELLS[0]!, 0, { interval: 3600 })])[0].interval).toBe(3600);
  expect(logged.warned.filter((line) => line.includes("cut to 0.25 s"))).toHaveLength(2);
});

test("a tick of 1e12, either sign, is cut so that a tick over all stacks stays inside STAT_INT_MAX, and the sign stays", () => {
  const logged = quietLog();
  for (const maxStacks of [1, 5, 100]) {
    const most = Math.floor(STAT_INT_MAX / maxStacks);
    const hot = dotsOf([dotOf(SPELLS[0]!, 0, { damagePerTick: -1e12, maxStacks, stacks: 1 })])[0];
    const dot = dotsOf([dotOf(SPELLS[0]!, 0, { damagePerTick: 1e12, maxStacks, stacks: 1 })])[0];
    expect(dot.damagePerTick).toBe(most);
    expect(hot.damagePerTick).toBe(-most);
    expect(Math.abs(dot.damagePerTick) * maxStacks).toBeLessThanOrEqual(STAT_INT_MAX);
    expect(Math.abs(hot.damagePerTick) * maxStacks).toBeLessThanOrEqual(STAT_INT_MAX);
  }
  // Just inside the cap stays as it is.
  const inside = Math.floor(STAT_INT_MAX / 5);
  expect(dotsOf([dotOf(SPELLS[0]!, 0, { damagePerTick: inside, maxStacks: 5, stacks: 1 })])[0].damagePerTick).toBe(inside);
  expect(logged.warned.filter((line) => line.includes("ticked for"))).toHaveLength(6);
});

test("an effect that is no whole tick, or no number of stacks, is still dropped as before", () => {
  quietLog();
  expect(dotsOf([dotOf(SPELLS[0]!, 0, { damagePerTick: 1.5 })])).toEqual([]);
  expect(dotsOf([dotOf(SPELLS[0]!, 0, { damagePerTick: 0 })])).toEqual([]);
  expect(dotsOf([dotOf(SPELLS[0]!, 0, { interval: 0 })])).toEqual([]);
  expect(dotsOf([dotOf(SPELLS[0]!, 0, { interval: Number.NaN })])).toEqual([]);
  expect(dotsOf([dotOf(SPELLS[0]!, 0, { maxStacks: 0 })])).toEqual([]);
});

test("a tick time far behind or ahead is brought to the next period, so the interval cannot be dodged through it", () => {
  quietLog();
  const now = Date.now();
  const behind = dotsOf([dotOf(SPELLS[0]!, 0, { nextTickAt: -1e15 })], KNOWN, now)[0];
  expect(behind.nextTickAt).toBe(now);
  const ahead = dotsOf([dotOf(SPELLS[0]!, 0, { nextTickAt: 1e15, expiresAt: now + 10_000 })], KNOWN, now)[0];
  expect(ahead.nextTickAt).toBe(now + 3000);
  // One that is a little late (the link took a moment) is kept.
  const late = dotOf(SPELLS[0]!, 0, { nextTickAt: now - 500 });
  expect(dotsOf([late], KNOWN, now)[0].nextTickAt).toBe(now - 500);
});

test("a DoT's caster is kept only when this node knows them: under that id and that name", () => {
  const logged = quietLog();
  const known = dotsOf([dotOf(SPELLS[0]!, 0)])[0];
  expect([known.casterId, known.casterUsername]).toEqual(["7", "Mage"]);
  // An invented player, a real id under another name, a real name under another id, one half of a pair.
  for (const forged of [
    { casterId: "999", casterUsername: "Nobody" },
    { casterId: "7", casterUsername: "Victim" },
    { casterId: "8", casterUsername: "Mage" },
    { casterId: "7", casterUsername: "" },
    { casterId: "", casterUsername: "Mage" },
    { casterId: { evil: true }, casterUsername: "Mage" },
  ]) {
    const [dot] = dotsOf([dotOf(SPELLS[0]!, 0, forged)]);
    expect([dot.casterId, dot.casterUsername]).toEqual(["", ""]);
    // The effect itself stays: only its credit goes.
    expect(dot.damagePerTick).toBe(4);
  }
  expect(logged.warned.filter((line) => line.includes("not a player this node knows"))).toHaveLength(6);
  // No lookup given: nobody is known.
  const none = handoffStateOf({ dots: [dotOf(SPELLS[0]!, 0)] }, limits(), "Probe").dots[0];
  expect([none.casterId, none.casterUsername]).toEqual(["", ""]);
});

test("the receiver's lookup knows a caster in the player cache or among the mirrors, by id and by name", () => {
  const cache = new Map<string, any>([["7", { username: "Mage" }]]);
  const mirrors = new Map<string, any>([["9", { username: "Priest" }]]);
  const known = compile(cut(receiverSource, "function knownDotCaster(", "\n}\n"), ["playerCache", "mirrorPlayers"], "knownDotCaster")({
    playerCache: { get: (id: string) => cache.get(id) },
    mirrorPlayers: { get: (id: string) => mirrors.get(id) },
  }) as (id: string, username: string) => boolean;
  expect(known("7", "Mage")).toBe(true);
  expect(known("7", "mage")).toBe(true);
  expect(known("9", "Priest")).toBe(true);
  expect(known("7", "Priest")).toBe(false);
  expect(known("9", "Mage")).toBe(false);
  expect(known("8", "Mage")).toBe(false);
  expect(known("7", "")).toBe(false);
});

test("a DoT without a caster is safe for the scheduler: dots.ts gives it no remote credit and no killer", () => {
  // tickPlayerDot looks the caster up by id and takes the remote path only for a non-empty id, so "" is a DoT with no
  // caster at all (what applyDot makes of a creature or a missing caster). Read from the source, as the code is not exported.
  const source = readFileSync(join(import.meta.dir, "..", "systems", "dots.ts"), "utf8");
  expect(source).toContain("const remote = !caster && dot.casterId && dot.casterId !== String(target.id) ? remoteCaster : null;");
  expect(source).toContain("caster || remote?.killer(dot) || null");
  expect(source).toContain('casterId: String(caster?.id ?? ""),');
});

// ------------------------------------------------------------------ L3: the corpse's map

test("a corpse on a map this node does not have is dropped with a warning; a known map keeps it", () => {
  const logged = quietLog();
  const corpseOf = (map: string, known: any = KNOWN) => handoffStateOf({ deadState: 1, corpse: { map, x: 10, y: 20 } }, limits(), "Probe", known).corpse;
  expect(corpseOf("main")).toEqual({ map: "main", x: 10, y: 20 });
  expect(corpseOf("main.json")).toEqual({ map: "main.json", x: 10, y: 20 });
  expect(logged.warned).toEqual([]);
  expect(corpseOf("nowhere")).toBeNull();
  expect(corpseOf("../../etc/passwd")).toBeNull();
  expect(corpseOf("MAIN")).toBeNull();
  // The suffix is ".json" with a real dot: any other character there is another name (review M2).
  expect(corpseOf("mainXjson")).toBeNull();
  expect(logged.warned).toHaveLength(4);
  expect(logged.warned[0]).toContain("an unknown map");
  expect(logged.warned[0]).toContain("nowhere");
  // No map list given: no map is known.
  expect(corpseOf("main", {})).toBeNull();
  expect(corpseOf("main", { maps: [] })).toBeNull();
  // A very long name is cut in the log line.
  corpseOf("x".repeat(5000));
  expect(logged.warned.at(-1)!.length).toBeLessThan(300);
});

// ------------------------------------------------------------------ M4: the reverse summon's permission

const receiverSource = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8");
const commandsSource = readFileSync(join(import.meta.dir, "..", "socket", "handlers", "commands.ts"), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts" });
function compile(code: string, names: string[], result: string): (given: Record<string, any>) => any {
  return new Function(`"use strict";\n${transpiler.transformSync(
    `function make({ ${names.join(", ")} }: any) {\n${code}\nreturn ${result};\n}`,
  )}\nreturn make;`)();
}
/** The source from `start` to the first `end` after it (included). */
function cut(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to + end.length);
}

test("reverseSummonAdmins: only a boolean true is a permission", () => {
  expect(reverseSummonAdmins({ by: "Admin", admins: true })).toBe(true);
  expect(reverseSummonAdmins({ by: "Admin", admins: false })).toBe(false);
  for (const admins of [undefined, null, 1, "true", "yes", {}, [], [true], 0, Number.NaN]) {
    expect(reverseSummonAdmins({ by: "Admin", admins })).toBe(false);
  }
  expect(reverseSummonAdmins({ by: "Admin" })).toBe(false);
  expect(reverseSummonAdmins(null)).toBe(false);
  expect(reverseSummonAdmins(undefined)).toBe(false);
});

/** The cells-teleport-to action of the receiver, run with stand-ins; answers what it asked the admin's node to run. */
function teleportToAction() {
  const ran: any[][] = [];
  const actions = new Map<string, (target: any, args: any) => Promise<void>>();
  const code = [
    cut(receiverSource, "const busyNote = ", ";\n"),
    cut(receiverSource, "function guardedAction(", "\n}\n"),
    cut(receiverSource, 'registerPlayerAction("cells-teleport-to"', "\n})));\n"),
  ].join("\n");
  compile(code, ["registerPlayerAction", "trackPacket", "remoteAdminOf", "reverseSummonAdmins", "log", "deliverToPlayer", "packetManager", "shownName", "runOnPlayer"], "null")({
    registerPlayerAction: (name: string, fn: any) => { actions.set(name, fn); },
    trackPacket: async (_id: string, work: () => Promise<void>) => work(),
    remoteAdminOf: (args: any) => (typeof args?.by === "string" && args.by.trim() ? args.by : null),
    reverseSummonAdmins,
    log,
    deliverToPlayer: async () => true,
    packetManager: { notify: (data: any) => data },
    shownName: (name: string) => name,
    runOnPlayer: async (...call: any[]) => { ran.push(call); return true; },
  });
  const target = { id: "7", username: "bob", location: { map: "main", position: { x: 40, y: 80 } } };
  return { run: (args: any) => actions.get("cells-teleport-to")!(target, args), ran };
}

test("the target's node passes the admin's summon-admins permission on, and never makes one up (security M4)", async () => {
  quietLog();
  const { run, ran } = teleportToAction();
  const sentOnTo = () => ran.map((call) => call[2].admins);
  await run({ by: "Admin", admins: true });
  await run({ by: "Admin", admins: false });
  await run({ by: "Admin" });
  await run({ by: "Admin", admins: "true" });
  await run({ by: "Admin", admins: 1 });
  expect(sentOnTo()).toEqual([true, false, false, false, false]);
  expect(ran[0]).toEqual(["Admin", "cells-summon", { by: "bob", map: "main", x: 40, y: 80, why: "teleport", admins: true }]);
  // The literal is gone from the source.
  expect(cut(receiverSource, 'registerPlayerAction("cells-teleport-to"', "\n})));\n")).not.toContain("admins: true");
});

test("the admin's own node puts its summon-admins permission in the cells-teleport-to args, read as /summon reads it", () => {
  const teleport = cut(commandsSource, 'case "TELEPORT": {', "cells-teleport-to");
  const sendFrom = commandsSource.indexOf('"cells-teleport-to", {', commandsSource.indexOf('case "TELEPORT": {'));
  expect(sendFrom).toBeGreaterThan(0);
  expect(teleport.length).toBeGreaterThan(0);
  const call = cut(commandsSource.slice(sendFrom), '"cells-teleport-to", {', "}));");
  const expression = /admins: ([^\n]+),\n/.exec(call)?.[1];
  expect(expression).toBeDefined();
  // The same expression as the summon sends and checks locally.
  const summon = cut(commandsSource, '"cells-summon", {', "}));");
  expect(/admins: ([^\n]+),\n/.exec(summon)?.[1]).toBe(expression!);
  const admins = compile(`const admins = (currentPlayer: any) => ${expression};`, [], "admins")({});
  expect(admins({ permissions: ["admin.summon", "admin.summonadmins"] })).toBe(true);
  expect(admins({ permissions: ["admin.*"] })).toBe(true);
  expect(admins({ permissions: ["admin.summon"] })).toBe(false);
  expect(admins({ permissions: ["admin.teleport"] })).toBe(false);
  expect(admins({ permissions: [] })).toBe(false);
});

// ------------------------------------------------------------------ L7: a remote gather's item and quantity

const expected = { item: "Copper Ore", maxQuantity: 4 };
function receiving(over: { stillHere?: boolean; give?: (name: string, item: string, quantity: number) => Promise<boolean> } = {}) {
  const gave: any[] = [];
  const deps = {
    expected,
    stillHere: () => over.stillHere ?? true,
    give: over.give ?? (async (...args: [string, string, number]) => (gave.push(args), true)),
  };
  return { gave, deps };
}

test("an item the node does not give is refused with a warning, and nothing is granted", async () => {
  const logged = quietLog();
  const { gave, deps } = receiving();
  for (const item of ["Iron Ore", "Diamond", "copper ore ", "Copper  Ore", "../x", "Copper Ore\u0000"]) {
    expect(await receiveGathered("alice", "b", 4, { ok: true, item, quantity: 1 }, deps)).toEqual({ ok: false, reason: REASONS.failed });
  }
  expect(gave).toEqual([]);
  expect(logged.warned).toHaveLength(6);
  expect(logged.warned[0]).toContain("Iron Ore");
  expect(logged.warned[0]).toContain("nothing is granted");
  // A node with no known item (its mirror is gone) grants nothing either.
  const nothing = receiving();
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 1 }, { ...nothing.deps, expected: { item: "", maxQuantity: 4 } })).toEqual({ ok: false, reason: REASONS.failed });
  expect(nothing.gave).toEqual([]);
});

test("a quantity above the node's largest yield is cut to it, once, and the item is written as the node spells it", async () => {
  const logged = quietLog();
  const { gave, deps } = receiving();
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 1e9 }, deps)).toEqual({ ok: true, item: "Copper Ore", quantity: 4 });
  expect(gave).toEqual([["alice", "Copper Ore", 4]]);
  expect(logged.warned.filter((line) => line.includes("at most 4"))).toHaveLength(1);
  // Written once per answer, and spelled as the node does, not as the answer does.
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "COPPER ORE", quantity: 2 }, deps)).toEqual({ ok: true, item: "Copper Ore", quantity: 2 });
  expect(gave).toEqual([["alice", "Copper Ore", 4], ["alice", "Copper Ore", 2]]);
  // Infinity is cut to the yield; a negative count and text are what the rules already made of them (one).
  for (const [quantity, written] of [[Number.POSITIVE_INFINITY, 4], [-5, 1], ["x", 1], [4, 4], [5, 4]] as const) {
    const each = receiving();
    expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: quantity as any }, each.deps)).toMatchObject({ ok: true, quantity: written });
    expect(each.gave).toEqual([["alice", "Copper Ore", written]]);
  }
});

test("a node of an area this node does not know yields one, and a failed write grants once and no more", async () => {
  quietLog();
  const unknownArea = receiving();
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3 }, { ...unknownArea.deps, expected: { item: "Copper Ore", maxQuantity: Number.NaN } })).toMatchObject({ ok: true, quantity: 1 });
  expect(unknownArea.gave).toEqual([["alice", "Copper Ore", 1]]);
  // A refused write is not retried and not written twice.
  let calls = 0;
  const refused = receiving({ give: async () => { calls++; return false; } });
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3 }, refused.deps)).toEqual({ ok: false, reason: REASONS.failed });
  expect(calls).toBe(1);
  // A player who left is granted nothing, mismatch or not.
  const left = receiving({ stillHere: false });
  expect(await receiveGathered("alice", "b", 4, { ok: true, item: "Copper Ore", quantity: 3 }, left.deps)).toEqual({ ok: false, reason: REASONS.failed });
  expect(left.gave).toEqual([]);
});

// ------------------------------------------------------------------ final review M1: a teleport outside a packet

/** teleportPlayerWrapper, cut out of the receiver, with CELLS_ON given; answers what it asked of the transition. */
function teleportWrapper(cellsOn: boolean) {
  const moved: any[][] = [];
  const code = [
    cut(receiverSource, "const inHandoff = ", ";\n"),
    cut(receiverSource, "export async function teleportPlayerWrapper(", "\n}\n").replace(/^export /, ""),
  ].join("\n");
  const wrapper = compile(code, ["CELLS_ON", "log", "transitionPlayerToMap", "spawnBatchQueue", "despawnBatchQueue"], "teleportPlayerWrapper")({
    CELLS_ON: cellsOn,
    log,
    transitionPlayerToMap: async (...call: any[]) => { moved.push(call); },
    spawnBatchQueue: new Map(),
    despawnBatchQueue: new Map(),
  });
  return { wrapper, moved };
}
const person = (over: any = {}) => ({ id: "7", username: "bob", wt: { data: {} }, location: { map: "main", position: { x: 1, y: 2, direction: "up" } }, ...over });

test("with the cluster on, a teleport outside a packet changes nothing for a player in a handoff, and says so", async () => {
  const logged = quietLog();
  const { wrapper, moved } = teleportWrapper(true);
  await wrapper(person({ handoff: true }), "main.json", 5, 6);
  await wrapper(person({ handoff: { to: "b" } }), "main.json", 5, 6);
  await wrapper(person({ wt: { data: { handedOff: true } } }), "main.json", 5, 6);
  expect(moved).toEqual([]);
  expect(logged.info.filter((line) => line.includes("Teleport of bob") && line.includes("changing server node"))).toHaveLength(3);
  // Anyone else is moved as before, and a player with no connection is still left alone.
  await wrapper(person(), "main.json", 5, 6);
  expect(moved).toHaveLength(1);
  expect(moved[0]![1]).toBe("main");
  expect(moved[0]![2]).toEqual({ x: 5, y: 6, direction: "up" });
  await wrapper(person({ wt: undefined }), "main.json", 5, 6);
  expect(moved).toHaveLength(1);
});

test("with the cluster off, a teleport is exactly what it was, whatever the player carries", async () => {
  quietLog();
  const { wrapper, moved } = teleportWrapper(false);
  await wrapper(person({ handoff: true }), "main.json", 5, 6);
  await wrapper(person({ wt: { data: { handedOff: true } } }), "main.json", 5, 6);
  expect(moved).toHaveLength(2);
});

test("the packet-driven paths still refuse a handoff inside trackPacket, as before", () => {
  // The summon, the revive and the teleport-to action answer a busy note for a player in a handoff and move nobody.
  for (const action of ["cells-summon", "cells-teleport-to"]) {
    const body = cut(receiverSource, `registerPlayerAction("${action}"`, "\n})));\n");
    expect(body).toContain("trackPacket(String(target.id)");
    expect(body).toContain("if (target.handoff) {");
    expect(body).toContain("busyNote(target.username)");
  }
  const revive = cut(receiverSource, 'registerPlayerAction("cells-revive"', "\n})));\n");
  expect(revive).toContain("target.handoff");
});

test("a relocation by the player editor changes nothing for a player in a handoff (review M3)", async () => {
  const logged = quietLog();
  const opening = "relocate: async (target, map, x, y, direction) => {\n";
  const text = cut(receiverSource, opening, "\n    }\n");
  const guard = text.slice(opening.length);
  const run = (cellsOn: boolean) => compile(
    `const relocate = (target: any) => {\n${guard}\n    return "went on";\n  };`,
    ["CELLS_ON", "inHandoff", "log"], "relocate",
  )({ CELLS_ON: cellsOn, inHandoff: (p: any) => !!(p?.handoff || p?.wt?.data?.handedOff), log }) as (target: any) => string | undefined;
  expect(run(true)({ username: "bob", handoff: true })).toBeUndefined();
  expect(run(true)({ username: "bob", wt: { data: { handedOff: true } } })).toBeUndefined();
  expect(run(true)({ username: "bob" })).toBe("went on");
  expect(run(false)({ username: "bob", handoff: true })).toBe("went on");
  expect(logged.info.filter((line) => line.includes("Relocation of bob"))).toHaveLength(2);
  // It is the first thing the action does: before it stops the player's movement or writes a location.
  expect(receiverSource.slice(receiverSource.indexOf("relocate: async (target, map, x, y, direction) => {"))).toMatch(/^[^]{0,600}?if \(CELLS_ON && inHandoff\(target\)\)[^]*?forceStopPlayerMovement\(target\)/);
});

// ------------------------------------------------------------------ final review M2: a trade with a player in a handoff

/** tradeRefusal, cut out of the receiver, with the rules it asks (cannotTrade, subscriptions, busyRefusal) given. */
function tradeRefusal(rules: { cannot?: string | null; unsubscribed?: string | null; busy?: string | null } = {}) {
  const code = cut(receiverSource, "export function tradeRefusal(", "\n}\n").replace(/^export /, "");
  return compile(code, ["cannotTrade", "subscriptionRefusal", "busyRefusal"], "tradeRefusal")({
    cannotTrade: () => rules.cannot ?? null,
    subscriptionRefusal: () => rules.unsubscribed ?? null,
    busyRefusal: () => rules.busy ?? null,
  }) as (asker: any, asked: any) => string | null;
}

test("a trade is refused as busy for a player in a handoff, whether asker or asked, and others trade as before", () => {
  const refuse = tradeRefusal();
  const here = () => ({ username: "ann", wt: { data: {} } });
  expect(refuse(here(), here())).toBeNull();
  const away = [
    { username: "bob", handoff: true, wt: { data: {} } },
    { username: "bob", handoff: { to: "b" }, wt: { data: {} } },
    { username: "bob", wt: { data: { handedOff: true } } },
  ];
  for (const player of away) {
    expect(refuse(here(), player)).toBe("That player is busy.");
    expect(refuse(player, here())).toBe("That player is busy.");
  }
  // A mirror (no connection of its own) and a player with no connection data are asked as before.
  expect(refuse({ username: "ann" }, { username: "bob", remote: true })).toBeNull();
  // The other refusals are still said, for a player who is not in a handoff.
  expect(tradeRefusal({ cannot: "You cannot trade with yourself." })(here(), here())).toBe("You cannot trade with yourself.");
  expect(tradeRefusal({ busy: "You are already trading." })(here(), here())).toBe("You are already trading.");
});
