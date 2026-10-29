import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";
import { receiverSource } from "./receiver-source";
import { revivePlayer } from "../socket/revive";
import { LoginPrefetch } from "../socket/loginprefetch";

// Cells phase 6, Task 14: the arrival side of a player handoff (socket/arrival.ts) and its wiring in the receiver.
// The receiver cannot be imported by a test (it imports the server, which starts it): its wiring is read from its
// source, and the few pieces that decide something are cut out of it and run with the names they use handed in.

mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

const cooldownManager = (await import("../services/cooldownmanager")).default;
const effectManager = (await import("../services/effectmanager")).default;
const playerCache = (await import("../services/playermanager")).default;
const resurrection = await import("../systems/resurrection");
const { default: log } = await import("../modules/logger");
const { trackPacket } = await import("../cluster/inflight");
const { tradeSettle } = await import("../cluster/tradesettle");
const { handoffBlocked, pickHandoffs } = await import("../cluster/handoffwatch");
const {
  adminMoveOf, arrivalFields, arrivalLimits, arrivalMaps, arrivalMount, draggedCheck, handoffStateOf, playersToDespawn, remoteAdminOf, reverseSummonAdmins, seedArrival, warpTarget,
  ARRIVAL_CLOCK_SLACK_MS, MAX_ARRIVAL_EFFECTS,
} = await import("../socket/arrival");

const { SICKNESS_DURATION_MS } = resurrection;
const consumables = await import("../systems/consumables");

// The spells the limits are read from: a 50-point barrier for 30 s, and a poison of 120 s that stacks to 8.
const SPELLS = [
  { name: "Shield", effects: [{ type: "absorbtion", value: 50, duration: 30 }] },
  { name: "Poison", effects: [{ type: "damage_over_time", value: 5, duration: 120, interval: 2, max_stacks: 8 }] },
];
const limits = (now = Date.now()) => arrivalLimits(SPELLS, now);
// What this node knows (security review M2, L3): the maps, and the players a DoT's caster may be.
const KNOWN_MAPS = [{ name: "main.json" }];
const known = { maps: KNOWN_MAPS, caster: () => true };

const state = (over: any = {}) => handoffStateOf({
  dots: [], barriers: [], stuns: [], slows: [], cooldowns: {}, lockoutMs: 0, sickUntil: 0, deadState: 0,
  corpse: null, pvp: false, lastAttackAgoMs: null, mounted: false, mount_type: null, ...over,
}, limits(), "an arriving player", known);
const dot = (over: any = {}) => ({
  id: "Poison", spell: "Poison", damagePerTick: 5, interval: 2, duration: 120, stackable: true, maxStacks: 8, stacks: 2,
  expiresAt: Date.now() + 60_000, nextTickAt: Date.now() + 2_000, ...over,
});

function forget(username: string): void {
  effectManager.clearAll(username.toLowerCase());
  cooldownManager.removePlayer(username);
  resurrection.saveOnDisconnect({ username, resurrectionSickUntil: 0 });
}

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function quietLog(): { warned: string[]; errored: string[] } {
  const seen = { warned: [] as string[], errored: [] as string[] };
  const warn = spyOn(log, "warn").mockImplementation(((message: string) => { seen.warned.push(message); }) as any);
  const error = spyOn(log, "error").mockImplementation(((message: string) => { seen.errored.push(message); }) as any);
  const debug = spyOn(log, "debug").mockImplementation((() => {}) as any);
  restores.push(() => warn.mockRestore(), () => error.mockRestore(), () => debug.mockRestore());
  return seen;
}

// ------------------------------------------------------------------ arrival.ts

test("handoffStateOf makes a malformed record harmless", () => {
  const logged = quietLog();
  const s = handoffStateOf({ deadState: 7, cooldowns: { x: 5, 3: -1, 4: 100 }, lockoutMs: "nope", dots: "x", corpse: 5, pvp: "yes" }, limits());
  expect(s.deadState).toBe(0);
  expect(s.cooldowns).toEqual({ 4: 100 });
  expect(s.lockoutMs).toBe(0);
  expect(s.dots).toEqual([]);
  expect(logged.warned).toContain("The effects over time an arriving player brought by handoff were dropped: not a list");
  expect(s.corpse).toBeNull();
  expect(s.pvp).toBe(false);
  expect(s.consumableReadyIn).toBe(0);
  expect(handoffStateOf(null, limits()).deadState).toBe(0);
  expect(handoffStateOf({ deadState: 2 }, limits()).deadState).toBe(2);
  // A corpse is a map's name and a point: each part is checked on its own.
  expect(handoffStateOf({ corpse: { map: { evil: true }, x: 1, y: 2 } }, limits()).corpse).toBeNull();
  expect(handoffStateOf({ corpse: { map: "", x: 1, y: 2 } }, limits()).corpse).toBeNull();
  expect(handoffStateOf({ corpse: { map: "main", x: 1, y: Number.NaN } }, limits()).corpse).toBeNull();
  expect(handoffStateOf({ corpse: { map: "main", x: 1, y: 2 } }, limits(), "x", known).corpse).toEqual({ map: "main", x: 1, y: 2 });
});

test("arrivalMaps reads the whole map set only for a corpse on a map the startup list lacks (perf fix 1)", async () => {
  const quiet = quietLog();
  const startup = [{ name: "main.json" }, { name: "town.json" }];
  const all = [...startup, { name: "made-later.json" }];
  const load = mock(async () => all);
  // No corpse, a malformed one, or a corpse on a startup map (with or without ".json"): the "maps" key is not read.
  expect(await arrivalMaps({ corpse: null }, startup, load)).toBe(startup);
  expect(await arrivalMaps(undefined, startup, load)).toBe(startup);
  expect(await arrivalMaps({ corpse: { map: { evil: true }, x: 1, y: 2 } }, startup, load)).toBe(startup);
  expect(await arrivalMaps({ corpse: { map: "", x: 1, y: 2 } }, startup, load)).toBe(startup);
  expect(await arrivalMaps({ corpse: { map: "town", x: 1, y: 2 } }, startup, load)).toBe(startup);
  expect(await arrivalMaps({ corpse: { map: "main.json", x: 1, y: 2 } }, startup, load)).toBe(startup);
  // A corpse whose point is not two finite numbers is dropped by handoffStateOf, so it needs no read either.
  expect(await arrivalMaps({ corpse: { map: "made-later", x: Number.NaN, y: 2 } }, startup, load)).toBe(startup);
  expect(await arrivalMaps({ corpse: { map: "made-later", x: 1, y: "2" } }, startup, load)).toBe(startup);
  expect(await arrivalMaps({ corpse: { map: "made-later", x: 1 } }, startup, load)).toBe(startup);
  expect(load).not.toHaveBeenCalled();
  // A corpse on a map created since start: one read, and the corpse is kept.
  const found = await arrivalMaps({ corpse: { map: "made-later", x: 3, y: 4 } }, startup, load);
  expect(load).toHaveBeenCalledTimes(1);
  expect(state({ corpse: { map: "made-later", x: 3, y: 4 } }).corpse).toBeNull();
  expect(handoffStateOf({ corpse: { map: "made-later", x: 3, y: 4 } }, limits(), "x", { maps: found }).corpse).toEqual({ map: "made-later", x: 3, y: 4 });
  // A corpse on a map nobody has is still dropped, after one read; a failed or empty read leaves the startup list.
  const none = await arrivalMaps({ corpse: { map: "nowhere", x: 3, y: 4 } }, startup, load);
  expect(load).toHaveBeenCalledTimes(2);
  expect(handoffStateOf({ corpse: { map: "nowhere", x: 3, y: 4 } }, limits(), "x", { maps: none }).corpse).toBeNull();
  expect(quiet.warned.some((line) => line.includes("an unknown map"))).toBe(true);
  expect(await arrivalMaps({ corpse: { map: "nowhere", x: 3, y: 4 } }, startup, async () => null)).toBe(startup);
  expect(await arrivalMaps({ corpse: { map: "main", x: 3, y: 4 } }, null, async () => null)).toEqual([]);
});

test("arrivalLimits reads the caps from the spells: the largest barrier, the longest effect, the most stacks", () => {
  expect(arrivalLimits(SPELLS, 1_000)).toEqual({ now: 1_000, barrierMax: 50, permanentBarriers: false, effectHorizonMs: 120_000, maxStacks: 8 });
  // No spells: no barrier can be real, and the horizon and stacks are the built-in floors.
  expect(arrivalLimits(null, 1_000)).toEqual({ now: 1_000, barrierMax: 0, permanentBarriers: false, effectHorizonMs: 60_000, maxStacks: 5 });
  // A barrier spell with no duration makes a barrier without an end.
  expect(arrivalLimits([{ effects: [{ type: "absorbtion", value: 80 }] }], 0).permanentBarriers).toBe(true);
});

test("the probe's arrival record is cut down to what this node's spells could have made (review I1)", () => {
  const logged = quietLog();
  const now = Date.now();
  const year = 365 * 24 * 3600 * 1000;
  const s = handoffStateOf({
    barriers: [
      { id: "Shield", amount: 1e12, expiresAt: 0 },
      { id: "Shield", amount: 40, expiresAt: 0 },
      { id: "Shield", amount: Number.NaN, expiresAt: now + 10_000 },
      { id: "Shield", amount: -5, expiresAt: now + 10_000 },
      { id: "Shield", amount: 1e12, expiresAt: now + 10_000 },
      { id: "Shield", amount: 40, expiresAt: now + year },
      { id: "Shield", amount: 50, expiresAt: now + 20_000 },
    ],
    slows: [{ slowPercent: -900, expiresAt: now + 4_000 }, { slowPercent: 100, expiresAt: now + 4_000 }, { slowPercent: 50, expiresAt: now + year }, { slowPercent: 50, expiresAt: now + 4_000 }],
    stuns: [{ expiresAt: now + year }, { expiresAt: "soon" }, { expiresAt: now + 3_000 }],
    dots: [
      dot({ expiresAt: now + year }), dot({ damagePerTick: Infinity }), dot({ damagePerTick: 0.5 }), dot({ damagePerTick: 0 }), dot({ interval: 0 }),
      dot({ stacks: 9 }), dot({ maxStacks: 50, stacks: 50 }), dot({ nextTickAt: null }), dot({ damagePerTick: -7 }), 7,
    ],
    sickUntil: now + 10 * year,
    corpse: { map: { evil: true }, x: "1", y: 2, padding: "x".repeat(1000) },
    consumableReadyIn: 9e9,
  }, limits(now), "Probe");
  // Kept: the 50-point timed barrier, the 50% slow, the 3 s stun, and the heal over time.
  expect(s.barriers).toEqual([{ id: "Shield", amount: 50, expiresAt: now + 20_000 }]);
  expect(s.slows).toEqual([{ slowPercent: 50, expiresAt: now + 4_000 }]);
  expect(s.stuns).toEqual([{ expiresAt: now + 3_000 }]);
  expect(s.dots.map((d: any) => d.damagePerTick)).toEqual([-7]);
  // Clamped: the sickness to a full one, the consumable cooldown to a full one.
  expect(s.sickUntil).toBe(now + SICKNESS_DURATION_MS);
  expect(s.consumableReadyIn).toBe(consumables.CONSUMABLE_COOLDOWN_MS);
  expect(s.corpse).toBeNull();
  // Each one dropped or clamped is a warning that names the player.
  expect(logged.warned.length).toBe(6 + 3 + 2 + 9 + 1 + 1 + 1);
  expect(logged.warned.every((line) => line.includes("Probe"))).toBe(true);
});

test("an arrival's sound record passes unchanged, and a corpse keeps only its map and point", () => {
  const logged = quietLog();
  const now = Date.now();
  const raw = {
    barriers: [{ id: "Shield", amount: 50, expiresAt: now + 30_000 + ARRIVAL_CLOCK_SLACK_MS }],
    slows: [{ slowPercent: 99, expiresAt: now }, { slowPercent: 1, expiresAt: now + 1 }],
    stuns: [{ expiresAt: now + 120_000 }],
    dots: [dot(), dot({ stacks: 8 })],
    sickUntil: now + SICKNESS_DURATION_MS + ARRIVAL_CLOCK_SLACK_MS,
    corpse: { map: "main", x: 10, y: 20.5, extra: "dropped" },
    consumableReadyIn: 12_000,
    deadState: 1,
  };
  const s = handoffStateOf(raw, limits(now), "Sound", known);
  expect(s.barriers).toEqual(raw.barriers);
  expect(s.slows).toEqual(raw.slows);
  expect(s.stuns).toEqual(raw.stuns);
  expect(s.dots).toEqual(raw.dots);
  expect(s.sickUntil).toBe(raw.sickUntil);
  expect(s.corpse).toEqual({ map: "main", x: 10, y: 20.5 });
  expect(s.consumableReadyIn).toBe(12_000);
  expect(logged.warned).toEqual([]);
  // A barrier with no end only when a spell makes one.
  expect(handoffStateOf({ barriers: [{ amount: 40, expiresAt: 0 }] }, arrivalLimits([{ effects: [{ type: "absorbtion", value: 80 }] }], now)).barriers).toHaveLength(1);
  expect(logged.warned).toEqual([]);
});

test("an arrival brings at most MAX_ARRIVAL_EFFECTS of one kind, and a consumable cooldown below zero is none", () => {
  const logged = quietLog();
  const now = Date.now();
  const s = handoffStateOf({ stuns: Array.from({ length: 40 }, () => ({ expiresAt: now + 1_000 })), consumableReadyIn: -5 }, limits(now), "Many");
  expect(s.stuns).toHaveLength(MAX_ARRIVAL_EFFECTS);
  expect(s.consumableReadyIn).toBe(0);
  expect(logged.warned).toHaveLength(2);
  expect(handoffStateOf({ consumableReadyIn: Number.NaN }, limits(now)).consumableReadyIn).toBe(0);
});

test("seedArrival sets the consumable cooldown the arrival brought, and leaves it when none", () => {
  try {
    seedArrival("Quaff", state({ consumableReadyIn: 12_000 }));
    expect(consumables.readyIn("Quaff")).toBeGreaterThan(11_000);
    expect(consumables.readyIn("Quaff")).toBeLessThanOrEqual(12_000);
    consumables.setReadyIn("Quaff", 0);
    seedArrival("Quaff", state({ consumableReadyIn: 0 }));
    expect(consumables.readyIn("Quaff")).toBe(0);
  } finally {
    consumables.setReadyIn("Quaff", 0);
    forget("Quaff");
  }
});

test("seedArrival puts effects, cooldowns, lockout and sickness where the login restores them", () => {
  const until = Date.now() + 60_000;
  const arrived: any = { id: "881001", username: "Hero", stats: { health: 100, total_max_health: 100, stamina: 50, total_max_stamina: 50 } };
  try {
    seedArrival("Hero", state({
      dots: [dot({ expiresAt: until })], barriers: [{ amount: 30, expiresAt: until }],
      stuns: [{ expiresAt: until }], slows: [{ slowPercent: 20, expiresAt: until }],
      cooldowns: { 5: 3_000 }, lockoutMs: 2_000, sickUntil: until,
    }), 1_000);
    expect(effectManager.loadDots("hero")).toHaveLength(1);
    expect(effectManager.loadBarriers("hero")).toHaveLength(1);
    expect(effectManager.loadStuns("hero")).toHaveLength(1);
    expect(effectManager.loadSlows("hero")).toHaveLength(1);
    expect(cooldownManager._spellCooldowns.get("Hero")?.get(5)).toBe(4_000);
    expect(cooldownManager._spellLockouts.get("Hero")).toBe(3_000);
    expect(resurrection.restoreOnLogin(arrived)).toBe(true);
  } finally {
    // restoreOnLogin armed a timer and wrote the player into playerCache: both are undone.
    resurrection.clearSickness(arrived);
    playerCache.remove("881001");
    forget("Hero");
  }
});

test("seedArrival replaces what this node kept of the player from an earlier visit", () => {
  try {
    // Guard: cooldownManager.removePlayer before the seed. A stale cooldown must not come back.
    cooldownManager.setCooldown("Back", 99, performance.now() + 1_000_000);
    cooldownManager.setLockout("Back", performance.now() + 1_000_000);
    effectManager.saveDots("back", [{ id: "old", expiresAt: Date.now() + 60_000 }]);
    resurrection.saveOnDisconnect({ username: "Back", resurrectionSickUntil: Date.now() + 60_000 });
    seedArrival("Back", state({ cooldowns: { 5: 3_000 } }));
    expect(Object.keys(cooldownManager.getActiveCooldowns("Back"))).toEqual(["5"]);
    expect(cooldownManager.getLockout("Back")).toBe(0);
    expect(effectManager.loadDots("back")).toEqual([]);
    expect(resurrection.restoreOnLogin({ id: "881002", username: "Back", stats: {} })).toBe(false);
  } finally {
    forget("Back");
  }
});

test("arrivalFields turns the elapsed time since the last attack into this node's clock", () => {
  expect(arrivalFields(state({ pvp: true, lastAttackAgoMs: 400, mounted: true, mount_type: "horse" }), 10_000))
    .toEqual({ pvp: true, last_attack: 9_600, mounted: true, mount_type: "horse" });
  expect(arrivalFields(state({ mount_type: "horse" }), 10_000))
    .toEqual({ pvp: false, last_attack: null, mounted: false, mount_type: null });
});

test("an arrival keeps its mount only when it owns it, is alive and stands outside", () => {
  const riding = { mounted: true, mount_type: "horse" };
  const owned = [{ type: "mount", item: "horse" }];
  expect(arrivalMount(riding, owned, 0, false)).toEqual({ mounted: true, mount_type: "horse" });
  // Guard: the collectables check (the MOUNT packet's rule). A record from the link cannot give a mount.
  expect(arrivalMount(riding, [{ type: "mount", item: "pony" }, { type: "pet", item: "horse" }], 0, false)).toEqual({ mounted: false, mount_type: null });
  // Guard: the interior check. A warp into a building is handed off before the warp's own dismount.
  expect(arrivalMount(riding, owned, 0, true)).toEqual({ mounted: false, mount_type: null });
  // Guard: a corpse or a ghost does not ride.
  expect(arrivalMount(riding, owned, 2, false)).toEqual({ mounted: false, mount_type: null });
  expect(arrivalMount({ mounted: false, mount_type: null }, owned, 0, false)).toEqual({ mounted: false, mount_type: null });
});

test("playersToDespawn lists what the client showed and does not see here, never itself", () => {
  expect(playersToDespawn(["1", "2", "3", "9"], new Set(["2"]), "9")).toEqual(["1", "3"]);
  expect(playersToDespawn([], new Set(["2"]), "9")).toEqual([]);
});

test("draggedCheck finds a dragged player and a dragging admin", () => {
  const check = draggedCheck(new Map([[5, 6]]));
  expect(check("5")).toBe(true);
  expect(check("6")).toBe(true);
  expect(check("7")).toBe(false);
});

test("draggedCheck compares the ids as text, whatever type the drag stored them with (R9)", () => {
  // A drag started from a packet can store the ids as strings in the number-typed map.
  const check = draggedCheck(new Map<any, any>([["5", "6"], [8, "9"]]));
  expect(check("5")).toBe(true);
  expect(check("6")).toBe(true);
  expect(check("8")).toBe(true);
  expect(check("9")).toBe(true);
  expect(check("7")).toBe(false);
  expect(check("")).toBe(false);
});

test("warpTarget names another node's destination only", () => {
  const ctx = { self: "a", ownerAt: (map: string, x: number) => (map === "main" ? (x < 1000 ? "a" : "b") : null) };
  expect(warpTarget(ctx, "main.json", 1500, 0)).toBe("b");
  expect(warpTarget(ctx, "main", 500, 0)).toBeNull();
  expect(warpTarget(ctx, "void", 500, 0)).toBeNull();
  expect(warpTarget(null, "main", 1500, 0)).toBeNull();
});

const MAPS = [{ name: "main.json", data: { width: 100, height: 50, tilewidth: 32, tileheight: 32 } }, { name: "nosize.json", data: {} }];
const goodMove = { by: "Admin", map: "main", x: 320, y: 160, why: "summon", admins: false };

test("adminMoveOf checks every field a remote summon brings, and refuses a bad one", () => {
  expect(adminMoveOf(goodMove, MAPS)).toEqual({ by: "Admin", map: "main", x: 320, y: 160, why: "summon", admins: false });
  expect(adminMoveOf({ ...goodMove, map: "main.json", why: "teleport", admins: true, x: 10.4 }, MAPS))
    .toEqual({ by: "Admin", map: "main", x: 10, y: 160, why: "teleport", admins: true });
  // The edges of the map are inside it.
  expect(typeof adminMoveOf({ ...goodMove, x: 3200, y: 1600 }, MAPS)).toBe("object");
  const refused = [
    null, {}, { ...goodMove, by: "" }, { ...goodMove, by: "  " }, { ...goodMove, by: 5 },
    { ...goodMove, map: "nowhere" }, { ...goodMove, map: 7 }, { ...goodMove, map: "" }, { ...goodMove, map: "nosize" },
    { ...goodMove, x: "320" }, { ...goodMove, y: Number.NaN }, { ...goodMove, x: Infinity },
    { ...goodMove, x: -1 }, { ...goodMove, y: 1601 }, { ...goodMove, x: 3201 },
    { ...goodMove, why: "kidnap" }, { ...goodMove, why: undefined },
    { ...goodMove, admins: "true" }, { ...goodMove, admins: undefined },
  ];
  for (const args of refused) expect(typeof adminMoveOf(args, MAPS)).toBe("string");
  expect(remoteAdminOf({ by: "Admin" })).toBe("Admin");
  expect(remoteAdminOf({ by: "" })).toBeNull();
  expect(remoteAdminOf({ by: 3 })).toBeNull();
  expect(remoteAdminOf(undefined)).toBeNull();
});

// ------------------------------------------------------------------ receiver.ts wiring (read from its source)

/**
 * The source with its whole-line comments taken out, so that a check of the code's text is not met by a comment
 * that quotes it. A trailing comment stays: it cannot be told from a string that holds "//" without parsing.
 */
function stripComments(text: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      inBlock = !trimmed.includes("*/");
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

const source = stripComments(receiverSource());
const receiverOnly = stripComments(await Bun.file(new URL("../socket/receiver.ts", import.meta.url)).text());
// The end of the login's first stretch: the secondary loads that follow the cache.
const LOGIN_END = "const currentPlayerData = playerCache.get(wt.data.id);";
const transpiler = new Bun.Transpiler({ loader: "ts" });

function body(start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** Runs `code` (TypeScript cut out of the receiver) with `names` handed in, and returns what `result` names. */
function compile(code: string, names: string[], result: string): (given: Record<string, any>) => any {
  return new Function(`"use strict";\n${transpiler.transformSync(
    `function make({ ${names.join(", ")} }: any) {\n${code}\nreturn ${result};\n}`,
  )}\nreturn make;`)();
}

test("a player being handed off sends nothing but PING and PONG, and every packet is counted in flight", () => {
  const preamble = body("const currentPlayer = playerCache.get(wt.data.id) || null;", "async function resolveNpcParticles(");
  const freeze = preamble.indexOf("(wt.data?.handedOff || currentPlayer?.handoff)");
  expect(freeze).toBeGreaterThan(0);
  expect(preamble.indexOf('type !== "PING" && type !== "PONG"')).toBeGreaterThan(0);
  // The freeze comes before the interceptors and the plugins.
  expect(freeze).toBeLessThan(preamble.indexOf("for (const interceptor of packetInterceptors)"));
  expect(preamble).toContain('trackPacket(String(wt.data?.id ?? ""), () => pluginHandler(');
  expect(source).toContain('trackPacket(String(wt.data?.id ?? ""), () => handler.handle(');
});

test("a single node pays nothing per packet: the freeze and the count run only in cluster mode, read once at load", () => {
  expect(receiverOnly).toContain("const CELLS_ON = clusterEnabled();");
  const receiver = body("export default async function packetReceiver(", "\n}\n");
  expect(receiver).toContain("if (CELLS_ON && (wt.data?.handedOff || currentPlayer?.handoff)");
  expect(receiver).toContain('if (CELLS_ON) await trackPacket(String(wt.data?.id ?? ""), () => pluginHandler(');
  expect(receiver).toContain("else await pluginHandler(wt, currentPlayer, data, sendPacket);");
  // Each packet is counted once: one trackPacket for the plugin, one for the router, never both.
  expect(receiver.match(/trackPacket\(/g)?.length).toBe(2);
  const router = receiver.slice(receiver.indexOf("const handler = routes.route("));
  // Guard (review M4.1): the router's count is the gated branch itself, and the single node calls the handler bare.
  expect(router).toContain('    if (CELLS_ON) {\n      return await trackPacket(String(wt.data?.id ?? ""), () => handler.handle({');
  expect(router).toMatch(/\n    \}\n    return await handler\.handle\(\{ server, wt, message/);
  expect(receiver).not.toContain("clusterEnabled()");
});

test("the login takes the arrival before the login switch, seeds it before the cache, and resumes the world", () => {
  const login = body("if (await classes.characterRequired(playerData.characterClass))", LOGIN_END);
  const take = login.indexOf("playerHandoff.takeArrival(");
  expect(take).toBeGreaterThan(0);
  // The name given is the one the database gave for the ticket's account.
  // Guard (review M4.2): taken only with the cluster on; a single node never takes one.
  expect(login).toContain('const arrival = clusterEnabled()\n      ? playerHandoff.takeArrival(String(wt.data?.ticketToken ?? ""), playerData.username, String(wt.data.id))\n      : null;');
  // Guard (review M4.3, M4.4): an arrival's death and corpse are the ones it brought, never the rows'.
  expect(login).toContain("const loginDeadState = arrivalState ? arrivalState.deadState : Number(playerData.isDead) || 0;");
  expect(login).toContain("corpse: loginDeadState === 0 ? null : arrivalState ? arrivalState.corpse : playerData.corpse || null,");
  // The arrival record is checked against this node's spells before anything reads it (review I1).
  expect(login).toContain('handoffStateOf(arrival.snapshot.state, arrivalLimits((await assetCache.get("spells")) as SpellData[] | null), playerData.username, {');
  // ... and against the players and maps this node knows (security review M2, L3).
  expect(login).toContain("caster: knownDotCaster,");
  // Perf fix 1: the startup list answers it; the 20 MB "maps" key is read only through arrivalMaps' fallback.
  expect(login).toContain('maps: await arrivalMaps(arrival.snapshot.state, maps as MapData[] | null, () => assetCache.get("maps") as Promise<MapData[] | null>),');
  expect(login).not.toContain('((await assetCache.get("maps")) || [])');
  // Guard: an arrival is never switched again (B owns the point; a second switch would loop).
  expect(login).toContain("if (!arrival && (await switchLoginIfElsewhere(");
  expect(take).toBeLessThan(login.indexOf("switchLoginIfElsewhere("));
  // Guard: the seed comes before the add, which reads the cooldowns and lockout.
  const seed = login.indexOf("seedArrival(playerData.username, arrivalState)");
  expect(seed).toBeGreaterThan(0);
  expect(seed).toBeLessThan(login.indexOf("playerCache.add(wt.data.id"));
  // Guard: the mirror gives way only once the player is local (dropMirror reads it as shadowed).
  expect(login.indexOf('ghosts.dropMirror("player", arrival.snapshot.id)')).toBeGreaterThan(login.indexOf("playerCache.add(wt.data.id"));
  expect(login).toContain("const resume = !!arrival?.resume && !!savedMap;");
  expect(login).toContain("packetManager.handoffDone(");
  expect(login).toContain("creatures.sync.adopt(");
  expect(login).toContain("playersToDespawn(arrival.snapshot.playerIds");
  expect(login).toContain("pvp: fields.pvp");
  expect(login).toContain("if (!arrival && loginDeadState === 1 && playerData.corpse?.map)");
  // Guard: the arrival's mount is checked against the collectables and the map (N-3).
  expect(login).toContain("arrivalMount(fields, limitedCollectables, loginDeadState, isInteriorMap(spawnLocation.map))");
  expect(login).toContain("mounted: mount.mounted,");
  expect(login).toContain("mount_type: mount.mount_type,");
});

test("every login on a cluster node forgets the forward left for the player, a fresh one too (Task 8)", () => {
  const login = body("if (await classes.characterRequired(playerData.characterClass))", LOGIN_END);
  const forget = login.indexOf("    if (clusterEnabled()) forwardTable.forgetPlayer(String(_pcache.id), playerData.username);");
  expect(forget).toBeGreaterThan(login.indexOf("arriving.username = null;"));
  // Once, at the login's own level: not inside an arrival's block, so a fresh login runs it as well (review nit).
  expect(login.match(/forwardTable\.forgetPlayer\(/g)?.length).toBe(1);
  expect(login.charAt(forget - 1)).toBe("\n");
});

test("an arrival that fails before the cache is told and closed; from the cache on, the disconnect cleans up (review M1)", () => {
  const login = body("async function completeLogin(", LOGIN_END);
  const take = login.indexOf("playerHandoff.takeArrival(");
  const mark = login.indexOf("if (arrival) Object.assign(arriving, { wt, username: playerData.username, sessionId });");
  // Guard: marked at once after the take, before the record is read (handoffStateOf and the spells may throw).
  expect(mark).toBeGreaterThan(take);
  expect(mark).toBeLessThan(login.indexOf("handoffStateOf("));
  // Guard: no map fails the arrival instead of returning silently.
  expect(login).toMatch(/if \(!map\) \{\n\s*if \(arriving\.username !== null\) await failArrival\(arriving, `there is no map/);
  // Guard: the world count is lowered again only when this login raised it.
  expect(login.indexOf("if (arriving.username !== null) arriving.countedMap = spawnLocation.map;"))
    .toBeGreaterThan(login.indexOf("await worlds.adjustPlayerCount(spawnLocation.map, 1)"));
  // Guard: the arrival's stretch ends once the cache holds the player, before anything else is run for them.
  const cached = login.indexOf("if (!_pcache) {\n      if (arriving.username !== null) await failArrival(arriving, \"the player cache did not take them\");\n      return;\n    }");
  const done = login.indexOf("arriving.username = null;");
  expect(cached).toBeGreaterThan(0);
  expect(done).toBeGreaterThan(cached);
  expect(done).toBeLessThan(login.indexOf("ghosts.dropMirror("));
});

// failArrival and the registration around the login, cut out of the receiver and run.
const failCode = [
  body("async function failArrival(", "\n}\n") + "\n}\n",
  body('authWorker.on("message", (result: any) => {', "\n});\n") + "\n});\n",
].join("\n");
function makeLogin(complete: (result: any, arriving: any) => Promise<void>) {
  const seen = { sent: [] as any[], closed: [] as any[][], counts: [] as any[][], cleared: [] as any[] };
  let handler: ((result: any) => Promise<void>) | null = null;
  compile(failCode, ["authWorker", "completeLogin", "log", "worlds", "player", "sendPacket", "packetManager", "LoginPrefetch", "loginPrefetch"], "null")({
    authWorker: { on: (_event: string, fn: any) => { handler = fn; } },
    LoginPrefetch,
    loginPrefetch: new LoginPrefetch(() => {}),
    completeLogin: complete,
    log,
    worlds: { adjustPlayerCount: async (...call: any[]) => { seen.counts.push(call); return 1; } },
    player: { clearSessionId: async (id: any) => { seen.cleared.push(id); } },
    sendPacket: (_wt: any, packet: any) => { seen.sent.push(packet); },
    packetManager: { loginFailed: () => "LOGIN_FAILED" },
  });
  const wt = { close: (...call: any[]) => { seen.closed.push(call); } };
  return { run: handler!, seen, wt };
}

test("an arrival whose login throws is logged, told LOGIN_FAILED, closed, and its count and session undone", async () => {
  const logged = quietLog();
  const { run, seen, wt } = makeLogin(async (_result, arriving) => {
    Object.assign(arriving, { wt, username: "Mover", sessionId: "s1" });
    arriving.countedMap = "main.json";
    throw new Error("spells unreadable");
  });
  await expect(run({})).resolves.toBeUndefined();
  expect(seen.sent).toEqual(["LOGIN_FAILED"]);
  expect(seen.closed).toEqual([[1008, "The move to this server could not be completed"]]);
  expect(seen.counts).toEqual([["main.json", -1]]);
  expect(seen.cleared).toEqual(["s1"]);
  expect(logged.errored.some((line) => line.includes("Mover") && line.includes("spells unreadable"))).toBe(true);
});

test("an arrival that fails before its count is raised lowers no count; a login that is not an arrival throws as before", async () => {
  quietLog();
  const early = makeLogin(async (_result, arriving) => {
    Object.assign(arriving, { wt: early.wt, username: "Mover", sessionId: null });
    throw new Error("no record");
  });
  await early.run({});
  expect(early.seen.counts).toEqual([]);
  expect(early.seen.cleared).toEqual([]);
  expect(early.seen.closed.length).toBe(1);
  // Guard: the rethrow. A fresh login, or an arrival past the cache, is not closed by this.
  const fresh = makeLogin(async () => { throw new Error("database down"); });
  await expect(fresh.run({})).rejects.toThrow("database down");
  expect(fresh.seen.sent).toEqual([]);
  expect(fresh.seen.closed).toEqual([]);
  // A connection that cannot be closed is logged, and failArrival still does not throw.
  const logged = quietLog();
  const broken = makeLogin(async (_result, arriving) => {
    Object.assign(arriving, { wt: { close: () => { throw new Error("already closed"); } }, username: "Mover", sessionId: null });
    throw new Error("boom");
  });
  await expect(broken.run({})).resolves.toBeUndefined();
  expect(logged.errored.some((line) => line.includes("already closed"))).toBe(true);
});

test("the login's map load is the one replaced by HANDOFF_DONE on a resume (R14: the login's, not the warp's)", () => {
  const login = body("if (await classes.characterRequired(playerData.characterClass))", LOGIN_END);
  expect(login).toMatch(/if \(resume\) \{[\s\S]*?packetManager\.handoffDone\([\s\S]*?\} else \{\n\s*sendPacket\(wt, packetManager\.loadMap\(mapMetadata\)\);/);
  const warp = body("async function transitionPlayerToMap(", "setImmediate(async () => {");
  expect(warp).toContain("sendPacket(wt, packetManager.loadMap(mapMetadata));");
  expect(warp).not.toContain("handoffDone");
});

test("a trade lost with its peer ends on the host and reloads the partner's bags", () => {
  expect(source).toContain("lost: loseTrade");
  const lose = body("async function loseTrade(", "\n}\n");
  expect(lose).toContain("endTradeOf(body.username)");
  expect(lose).toContain("sendBelongingsOf(online, true)");
  expect(lose).toContain("TRADE_UNREACHABLE");
  expect(lose).toContain("reloadWhenSettled(body.username)");
});

test("a warp into another node's block is a handoff, restored when refused", () => {
  const warp = body("async function transitionPlayerToMap(", "loot.cancelCleanup(player.username);");
  expect(warp).toContain("warpTarget(handoffCtx, newMapName, newPosition.x, newPosition.y)");
  expect(warp).toContain("handoffBlocked(player, owner, handoffChecks) === null");
  expect(warp).toContain("playerHandoff.handOff(player, owner, { fullLoad: true })");
  // Guard: a refused handoff puts the player back where they were before the warp happens here.
  expect(warp).toContain("player.location = before;");
  expect(warp).toContain("delete player.handoffFromMap;");
  // The restore runs in a finally, so a handOff that threw would not leave the player at the destination.
  expect(warp.indexOf("} finally {")).toBeLessThan(warp.indexOf("player.location = before;"));
  // Guard (review M4.7): the restore's condition, then the return of a switch or a disconnect.
  expect(warp).toContain('} finally {\n      if (result !== "switched" && result !== "gone") {\n        player.location = before;\n        delete player.handoffFromMap;\n      }\n    }');
  expect(warp).toContain('if (result === "switched" || result === "gone") return;');
});

// The handoff checks, cut out of the receiver with storeUp and run.
const checksCode = [
  body("function storeUp(", "\n}\n") + "\n}\n",
  body("const handoffChecks: HandoffChecks = {", "\n};\n") + "\n};\n",
].join("\n");
function makeChecks(given: { trading?: boolean; dragged?: Map<any, any>; up?: boolean; store?: any }) {
  const make = compile(`let handoffCtx: any = ctx;\n${checksCode}`, ["isTrading", "draggedCheck", "draggedPlayersMap", "playerHandoff", "ctx"], "handoffChecks");
  const ctx = given.up === undefined ? null : { calls: { isUp: () => given.up }, ...(given.store === undefined ? {} : { store: given.store }) };
  return make({
    isTrading: () => !!given.trading,
    draggedCheck,
    draggedPlayersMap: given.dragged ?? new Map(),
    playerHandoff: { pending: () => false, coolingDown: () => false },
    ctx,
  });
}

test("the watch runs while the links are attached, with the receiver's own checks", () => {
  const checks = body("const handoffChecks: HandoffChecks = {", "\n};\n");
  expect(checks).toContain("isTrading(username)");
  expect(checks).toContain("dragged: draggedCheck(draggedPlayersMap)");
  expect(checks).toContain("handoffCtx?.calls.isUp(peer) ?? false");
  const hook = body("onLinksAttached((ctx) => {", "\n});\n");
  expect(hook).toContain("handoffCtx = ctx;");
  expect(hook).toContain("pickHandoffs(players, ctx.ownerAt, ctx.self, handoffChecks)");
  expect(hook).toContain("Object.values(playerCache.list())");
  expect(hook).toContain("clearInterval(watch)");
  expect(hook).toContain("handoffCtx = null;");
});

test("a handoff waits while the link or the shared store is down; a store that cannot say counts as up (R12)", () => {
  expect(makeChecks({ up: true }).linkUp("b")).toBe(true);
  expect(makeChecks({ up: false }).linkUp("b")).toBe(false);
  // No links attached: no handoff.
  expect(makeChecks({}).linkUp("b")).toBe(false);
  // Guard: storeUp. A store that says it is down pauses every handoff.
  expect(makeChecks({ up: true, store: { isUp: () => false } }).linkUp("b")).toBe(false);
  expect(makeChecks({ up: true, store: { isUp: () => true } }).linkUp("b")).toBe(true);
  expect(makeChecks({ up: true, store: {} }).linkUp("b")).toBe(true);
});

test("a player still unsettled after a lost trade is not handed off until the mark runs out, and is shown as settling", async () => {
  // A mark left by another file must not decide the null checks below.
  tradeSettle.reset();
  expect(makeChecks({ up: true }).trading("bob")).toBe(false);
  expect(makeChecks({ up: true, trading: true }).trading("bob")).toBe(true);
  expect(makeChecks({ up: true, dragged: new Map<any, any>([["4", 1]]) }).dragged("4")).toBe(true);
  // The receiver gives no settling check: handoffBlocked asks the node's own marks, and names them "settling".
  expect(body("const handoffChecks: HandoffChecks = {", "\n};\n")).not.toContain("settling");
  const checks = makeChecks({ up: true });
  expect(checks.trading("bob")).toBe(false);
  const bob = { id: "7", username: "bob" };
  expect(handoffBlocked(bob, "b", checks)).toBeNull();
  tradeSettle.reset({ ms: 60_000, drop: async () => {} });
  try {
    await tradeSettle.unsettle("bob", "test", "c");
    expect(handoffBlocked(bob, "b", checks)).toBe("settling");
    expect(pickHandoffs([{ ...bob, location: { map: "main", position: { x: 5_000, y: 5_000 } } }], () => "b", "a", checks)).toEqual([]);
  } finally {
    tradeSettle.reset();
  }
  expect(handoffBlocked(bob, "b", checks)).toBeNull();
});

test("the remote admin actions are registered and refuse a player in a handoff", () => {
  for (const name of ["cells-revive", "cells-summon", "cells-teleport-to"]) {
    const action = body(`registerPlayerAction("${name}"`, "\n})));\n");
    expect(action).toContain("trackPacket(String(target.id)");
    expect(action).toContain("if (target.handoff)");
    expect(action).toContain(`guardedAction("${name}"`);
  }
  const summon = body('registerPlayerAction("cells-summon"', "\n})));\n");
  expect(summon).toContain('move.why === "summon" && target.isAdmin && !move.admins');
  expect(summon).toContain("teleportPlayerWrapper(target, map, x, y)");
  const revive = body('registerPlayerAction("cells-revive"', "\n})));\n");
  // The body is revivePlayer's (cells phase 7, Task 10): one body with the REVIVE command.
  expect(revive).toContain("revivePlayer(target, reviveDeps()");
  // R14: the exported shownName, not a copy of it.
  expect(receiverOnly).not.toContain("const shownCap");
});

// The summon action, cut out of the receiver and run as the delivery runs it.
const summonCode = [
  body("const busyNote = ", ";\n") + ";\n",
  body("function guardedAction(", "\n}\n") + "\n}\n",
  body('registerPlayerAction("cells-summon"', "\n})));\n") + "\n})));\n",
].join("\n");
function makeSummon() {
  const seen = { teleports: [] as any[][], delivered: [] as any[][], sent: [] as any[] };
  let action: ((target: any, args: any) => Promise<void>) | null = null;
  compile(summonCode, [
    "registerPlayerAction", "trackPacket", "adminMoveOf", "assetCache", "log", "deliverToPlayer", "packetManager", "shownName",
    "sendPacket", "teleportPlayerWrapper",
  ], "null")({
    registerPlayerAction: (_name: string, fn: any) => { action = fn; },
    trackPacket,
    adminMoveOf,
    assetCache: { get: async () => MAPS },
    log,
    deliverToPlayer: async (...call: any[]) => { seen.delivered.push(call); return true; },
    packetManager: { notify: (data: any) => data },
    shownName: (name: string) => name.charAt(0).toUpperCase() + name.slice(1),
    sendPacket: (_wt: any, packet: any) => { seen.sent.push(packet); },
    teleportPlayerWrapper: async (...call: any[]) => { seen.teleports.push(call); },
  });
  return { run: action!, seen };
}

test("a malformed remote summon is logged and dropped: nobody is moved, told or thrown at", async () => {
  const logged = quietLog();
  const { run, seen } = makeSummon();
  const target = () => ({ id: "7", username: "bob", isAdmin: false, wt: {} });
  const bad = [
    { ...goodMove, map: "nowhere" }, { ...goodMove, x: Number.NaN }, { ...goodMove, y: 99_999 },
    { ...goodMove, why: "kidnap" }, { ...goodMove, admins: "yes" }, { ...goodMove, by: "" }, null,
  ];
  for (const args of bad) await expect(run(target(), args)).resolves.toBeUndefined();
  expect(seen.teleports).toEqual([]);
  expect(seen.sent).toEqual([]);
  expect(seen.delivered).toEqual([]);
  expect(logged.warned.length).toBe(bad.length);
  expect(logged.warned.every((line) => line.includes("summon of bob was dropped"))).toBe(true);

  // A good one moves the player, told first; a player in a handoff is not moved and the admin is told.
  await run(target(), goodMove);
  expect(seen.teleports).toEqual([[expect.objectContaining({ id: "7" }), "main", 320, 160]]);
  expect(seen.sent).toEqual([{ message: "You have been summoned by an admin" }]);
  await run({ ...target(), handoff: true }, goodMove);
  expect(seen.teleports.length).toBe(1);
  expect(seen.delivered.at(-1)).toEqual(["Admin", { message: "Bob is changing server node; try again" }]);
  // The admin rule.
  await run({ ...target(), isAdmin: true }, goodMove);
  expect(seen.teleports.length).toBe(1);
  expect(seen.delivered.at(-1)).toEqual(["Admin", { message: "You cannot summon other admins" }]);
});

test("a remote action that fails is logged, and does not throw back to the delivery", async () => {
  const logged = quietLog();
  const { run } = makeSummon();
  // A target whose move throws.
  const target = { id: "7", username: "bob", isAdmin: false, get wt(): any { throw new Error("socket gone"); } };
  await expect(run(target, goodMove)).resolves.toBeUndefined();
  expect(logged.errored.some((line) => line.includes("cells-summon") && line.includes("socket gone"))).toBe(true);
});

test("the remote revive and teleport-to drop an action that names no admin", () => {
  for (const name of ["cells-revive", "cells-teleport-to"]) {
    const action = body(`registerPlayerAction("${name}"`, "\n})));\n");
    const check = action.indexOf("if (by === null) {");
    expect(check).toBeGreaterThan(0);
    expect(action.indexOf("const by = remoteAdminOf(args);")).toBeLessThan(check);
    expect(check).toBeLessThan(action.indexOf("if (target.handoff)"));
  }
});

// The revive and teleport-to actions, cut out of the receiver and run as the delivery runs them.
const adminActionsCode = [
  body("const busyNote = ", ";\n") + ";\n",
  body("function guardedAction(", "\n}\n") + "\n}\n",
  body('registerPlayerAction("cells-revive"', "\n})));\n") + "\n})));\n",
  body('registerPlayerAction("cells-teleport-to"', "\n})));\n") + "\n})));\n",
].join("\n");
function makeAdminActions() {
  const seen = { delivered: [] as any[][], ran: [] as any[][], order: [] as string[] };
  const actions = new Map<string, (target: any, args: any) => Promise<void>>();
  // The node's side of revivePlayer, recorded in `seen.order` next to the admin's notes.
  const fakeReviveDeps = () => ({
    clearSickness: () => { seen.order.push("sickness"); },
    synchronizeStats: async () => null,
    setDeadState: async () => { seen.order.push("dead-state"); },
    keep: () => {},
    bumpStateRevision: () => {},
    viewersOn: () => [],
    send: () => {},
    ghostPacket: () => [],
    revivePacket: () => [],
    broadcastEffects: () => {},
    sendPartyStats: () => { seen.order.push("party"); },
    revived: () => { seen.order.push("PLAYER_REVIVED"); },
  });
  compile(adminActionsCode, [
    "registerPlayerAction", "trackPacket", "remoteAdminOf", "reverseSummonAdmins", "log", "deliverToPlayer", "packetManager", "shownName", "runOnPlayer",
    "revivePlayer", "reviveDeps",
  ], "null")({
    registerPlayerAction: (name: string, fn: any) => { actions.set(name, fn); },
    trackPacket,
    remoteAdminOf,
    revivePlayer,
    reviveDeps: fakeReviveDeps,
    reverseSummonAdmins,
    log,
    deliverToPlayer: async (...call: any[]) => { seen.delivered.push(call); seen.order.push("note"); return true; },
    packetManager: { notify: (data: any) => data },
    shownName: (name: string) => name.charAt(0).toUpperCase() + name.slice(1),
    runOnPlayer: async (...call: any[]) => { seen.ran.push(call); return true; },
  });
  return { revive: actions.get("cells-revive")!, teleportTo: actions.get("cells-teleport-to")!, seen };
}

test("a remote revive or teleport-to that names no admin is dropped with a warning: nobody is told or moved (review M4.5, M4.6)", async () => {
  const logged = quietLog();
  const { revive, teleportTo, seen } = makeAdminActions();
  // Alive, so a revive that went on would answer "is not dead" to whoever it names.
  const target = () => ({ id: "7", username: "bob", isDead: false, isGhost: false, location: { map: "main", position: { x: 40, y: 80 } } });
  const bad = [{ by: 3 }, {}, { by: "" }, { by: "   " }, null];
  for (const args of bad) {
    await expect(revive(target(), args)).resolves.toBeUndefined();
    await expect(teleportTo(target(), args)).resolves.toBeUndefined();
  }
  expect(seen.delivered).toEqual([]);
  expect(seen.ran).toEqual([]);
  expect(logged.errored).toEqual([]);
  expect(logged.warned.filter((line) => line.includes("A remote revive of bob was dropped")).length).toBe(bad.length);
  expect(logged.warned.filter((line) => line.includes("A remote teleport to bob was dropped")).length).toBe(bad.length);

  // A named admin goes on: the revive answers, the teleport asks the admin's node to move them here.
  await revive(target(), { by: "Admin" });
  expect(seen.delivered).toEqual([["Admin", { message: "Bob is not dead" }]]);
  await teleportTo(target(), { by: "Admin", admins: true });
  expect(seen.ran).toEqual([["Admin", "cells-summon", { by: "bob", map: "main", x: 40, y: 80, why: "teleport", admins: true }]]);
  expect(logged.errored).toEqual([]);
});

test("a remote revive of a dead player tells the admin 'Revived' before PLAYER_REVIVED, as the REVIVE command does", async () => {
  const logged = quietLog();
  const { revive, seen } = makeAdminActions();
  const dead = { id: "7", username: "bob", isDead: true, isGhost: true, stats: { total_max_health: 9, total_max_stamina: 4 }, location: { map: "main" } };
  await revive(dead, { by: "Admin" });
  expect(seen.delivered).toEqual([["Admin", { message: "Revived Bob" }]]);
  expect(seen.order).toEqual(["sickness", "dead-state", "party", "note", "PLAYER_REVIVED"]);
  expect(dead.isDead).toBe(false);
  expect(logged.errored).toEqual([]);
  // A ghost that is not dead, or a corpse that is not yet a ghost, is revived too; neither is "not dead".
  for (const flags of [{ isDead: false, isGhost: true }, { isDead: true, isGhost: false }]) {
    seen.delivered.length = 0;
    await revive({ ...dead, ...flags, stats: { total_max_health: 9, total_max_stamina: 4 } }, { by: "Admin" });
    expect(seen.delivered).toEqual([["Admin", { message: "Revived Bob" }]]);
  }
});
