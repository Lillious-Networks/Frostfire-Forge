import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { LinkCalls, linkCalls } from "../cluster/linkcalls";
import { swapApplierForTest } from "../cluster/effects";
import { mirrorPlayers } from "../cluster/mirrors";
import { casterFor, refusalOf, sendPlayerHit, setPlayerHitApplier, setSpellLookup, type PlayerHit, type PlayerHitApplier, type SpellLookup } from "../cluster/playerhits";
import log from "../modules/logger";
import assetCache from "../services/assetCache";
import playerCache from "../services/playermanager";
import { linkPair } from "./cluster-fakelink";

// The receiver sets its applier once, when it loads, and every test file shares one process: put it back afterwards.
// A stand-in for it is set for the whole file, so that afterAll can see that every test put it back.
const outer = setPlayerHitApplier(null);
const sentinel: PlayerHitApplier = async () => ({ outcome: "missing" });
setPlayerHitApplier(sentinel);
let savedApplier: PlayerHitApplier | null = null;
// The creature system sets the in-process spell lookup when it loads: a test sets its own and puts that one back.
let savedLookup: SpellLookup | null = null;
const knowSpells = (list: any[]) => { setSpellLookup((id) => list.find((spell) => spell.id === id)); };

beforeEach(() => {
  savedApplier = setPlayerHitApplier(null);
  savedLookup = setSpellLookup(null);
});

afterEach(() => {
  mirrorPlayers.clear();
  setPlayerHitApplier(savedApplier);
  setSpellLookup(savedLookup);
  linkCalls.detach();
});

const hit = (over: Partial<PlayerHit> = {}): PlayerHit => ({
  casterId: "c1", casterName: "Caster", casterStats: { level: 5, stat_damage: 3 },
  casterLocation: { map: "forest", position: { x: 10, y: 20 } }, casterLayer: null, casterParty: [],
  spell: null, damage: 12, isCrit: false, skipEffects: false, showsDamage: true, harmful: true, ...over,
});
const target = (over: any = {}) => ({ id: "t1", username: "Target", stats: { health: 50 }, location: { map: "forest", position: { x: 0, y: 0 } }, ...over });

test("refusalOf protects a dead, hidden, guest or no-PvP target, and lets a heal through no-PvP", () => {
  expect(refusalOf(undefined, hit(), true)).toBe("missing");
  expect(refusalOf(target({ isDead: true }), hit(), true)).toBe("dead");
  expect(refusalOf(target({ isGhost: true }), hit(), true)).toBe("dead");
  expect(refusalOf(target({ isStealth: true }), hit(), true)).toBe("immune");
  expect(refusalOf(target({ isGuest: true }), hit(), true)).toBe("immune");
  expect(refusalOf(target(), hit(), false)).toBe("nopvp");
  expect(refusalOf(target(), hit({ harmful: false, damage: -10 }), false)).toBeNull();
  expect(refusalOf(target(), hit(), true)).toBeNull();
});

test("refusalOf answers dead for a target at 0 health whose isDead is not set yet (a death in progress)", () => {
  expect(refusalOf(target({ stats: { health: 0 } }), hit(), true)).toBe("dead");
  expect(refusalOf(target({ stats: { health: -4 } }), hit({ harmful: false, damage: -3 }), true)).toBe("dead");
  expect(refusalOf(target({ stats: { health: 1 } }), hit(), true)).toBeNull();
});

test("refusalOf treats a target on another map than the caster's as missing, whether its name ends in .json or not", () => {
  expect(refusalOf(target({ location: { map: "cave", position: { x: 0, y: 0 } } }), hit(), true)).toBe("missing");
  expect(refusalOf(target({ location: { map: "forest.json", position: { x: 0, y: 0 } } }), hit(), true)).toBeNull();
});

test("refusalOf treats a target on another layer than the caster's as missing", () => {
  expect(refusalOf(target({ aoi: { layerId: "L2" } }), hit({ casterLayer: "L1" }), true)).toBe("missing");
  expect(refusalOf(target({ aoi: { layerId: "L2" } }), hit({ casterLayer: null }), true)).toBe("missing");
  expect(refusalOf(target({ aoi: { layerId: "L1" } }), hit({ casterLayer: "L1" }), true)).toBeNull();
});

test("casterFor builds a stand-in marked remote, with no socket and no AOI", () => {
  mirrorPlayers.set("c1", { id: "c1", username: "Caster", remote: true, mirrorFrom: "a", wt: { fake: true }, aoi: { layerId: "x" }, guild: "G" });
  const caster = casterFor(hit(), "a");
  expect(caster).toMatchObject({ id: "c1", username: "Caster", remote: true, mirrorFrom: "a", guild: "G", stats: { level: 5, stat_damage: 3 } });
  expect(caster.wt).toBeUndefined();
  expect(caster.aoi).toBeUndefined();
  // The mirror itself is not changed.
  expect(mirrorPlayers.get("c1").stats).toBeUndefined();
});

test("a player hit goes to the target's owner, which applies it with a caster stand-in", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  const seen: any[] = [];
  // The caster is a player of the asking node, mirrored here.
  mirrorPlayers.set("c1", { id: "c1", username: "Caster", remote: true, mirrorFrom: "a" });
  setPlayerHitApplier(async (targetId, h, caster) => {
    seen.push([targetId, h.damage, caster.id, caster.remote]);
    return { outcome: "applied", stats: { health: 38 } };
  });
  expect(await caller.call("b", "APPLY_EFFECT", { op: "player_hit", target: "t1", body: hit() })).toEqual({ ok: true, answer: { outcome: "applied", stats: { health: 38 } } });
  expect(seen).toEqual([["t1", 12, "c1", true]]);
  // A caster mirrored here from another node cannot be claimed by this one.
  mirrorPlayers.set("c1", { id: "c1", username: "Caster", remote: true, mirrorFrom: "z" });
  expect(await caller.call("b", "APPLY_EFFECT", { op: "player_hit", target: "t1", body: hit() })).toEqual({ ok: true, answer: { outcome: "refused", reason: "caster" } });
});

test("sendPlayerHit sends to the mirror's owner, and is null for a player that is not mirrored", async () => {
  const { a, b } = linkPair();
  const owner = new LinkCalls();
  linkCalls.attach(a);
  owner.attach(b);
  // The owner's side answers every effect itself; the real player_hit applier is not registered a second time.
  owner.handle("APPLY_EFFECT", (effect) => ({ outcome: "killed", reason: `${effect.op}:${effect.target}` }));
  mirrorPlayers.set("t1", { id: "t1", username: "Target", remote: true, mirrorFrom: "b" });
  expect(await sendPlayerHit({ id: "t1" }, hit())).toEqual({ outcome: "killed", reason: "player_hit:t1" });
  expect(await sendPlayerHit({ id: "t2" }, hit())).toBeNull();
});

test("swapApplierForTest can stand in for the player_hit op and puts the real one back", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  const restore = swapApplierForTest("player_hit", () => ({ outcome: "applied", reason: "swapped" }));
  try {
    expect(await caller.call("b", "APPLY_EFFECT", { op: "player_hit", target: "t1", body: hit() })).toEqual({ ok: true, answer: { outcome: "applied", reason: "swapped" } });
  } finally {
    restore();
  }
  // Restored: the real op is back, and reaches the applier handed in.
  mirrorPlayers.set("c1", { id: "c1", username: "Caster", remote: true, mirrorFrom: "a" });
  setPlayerHitApplier(async () => ({ outcome: "applied", reason: "real" }));
  expect(await caller.call("b", "APPLY_EFFECT", { op: "player_hit", target: "t1", body: hit() })).toEqual({ ok: true, answer: { outcome: "applied", reason: "real" } });
});

// ------------------------------------------------------------------ the owner does not trust the body

/** Runs `fn` with the real player_hit op reachable from node "a", the caster c1 mirrored from "a", and every singleton put back. */
async function owner(fn: (call: (body: any) => Promise<any>, seen: Array<{ targetId: string; hit: PlayerHit; caster: any }>) => Promise<void>, mirror: any = { mirrorFrom: "a" }): Promise<void> {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  const seen: Array<{ targetId: string; hit: PlayerHit; caster: any }> = [];
  setPlayerHitApplier(async (targetId, h, caster) => {
    seen.push({ targetId, hit: h, caster });
    return { outcome: "applied" };
  });
  if (mirror) mirrorPlayers.set("c1", { id: "c1", username: "Caster", remote: true, ...mirror });
  try {
    await fn((body) => caller.call("b", "APPLY_EFFECT", { op: "player_hit", target: "t1", body }), seen);
  } finally {
    caller.detach();
  }
}

test("a hit that does damage is harmful whatever the body says, so the no-PvP check cannot be skipped by clearing the flag", async () => {
  await owner(async (call, seen) => {
    await call(hit({ harmful: false, damage: 5000 }));
    expect(seen[0]!.hit.harmful).toBe(true);
    // A heal and an effect-only hit keep what they sent.
    await call(hit({ harmful: false, damage: -30 }));
    expect(seen[1]!.hit.harmful).toBe(false);
    await call(hit({ harmful: true, damage: 0 }));
    expect(seen[2]!.hit.harmful).toBe(true);
  });
});

test("a hit whose spell has a hostile effect is harmful with no damage and the flag cleared, and a benign spell is not", async () => {
  knowSpells([{ id: 9, name: "Frost", damage: 0, effects: [{ type: "stun" }] }, { id: 10, name: "Ward", damage: 0, effects: [{ type: "barrier" }] }]);
  await owner(async (call, seen) => {
    await call(hit({ harmful: false, damage: 0, spell: { id: 9 } as any }));
    expect(seen[0]!.hit.harmful).toBe(true);
    await call(hit({ harmful: false, damage: 0, spell: { id: 10 } as any }));
    expect(seen[1]!.hit.harmful).toBe(false);
  });
});

test("a heal with a hostile effect stays a heal: the owner does not count its effects as harm, but damage above 0 is harm", async () => {
  // An area heal that also slows: the caster's own area heal does not treat it as harm, so neither does the owner.
  knowSpells([{ id: 11, name: "Cleansing Rain", damage: -20, effects: [{ type: "slow" }] }, { id: 12, name: "Frost Nova", damage: 20, effects: [{ type: "slow" }] }]);
  await owner(async (call, seen) => {
    await call(hit({ harmful: false, damage: -15, spell: { id: 11 } as any }));
    expect(seen[0]!.hit.harmful).toBe(false);
    // Damage sent with a heal spell's id is still damage.
    await call(hit({ harmful: false, damage: 40, spell: { id: 11 } as any }));
    expect(seen[1]!.hit.harmful).toBe(true);
    // A spell that is not a heal, with the same effect, is harm.
    await call(hit({ harmful: false, damage: 0, spell: { id: 12 } as any }));
    expect(seen[2]!.hit.harmful).toBe(true);
  });
});

test("refusalOf counts a hit that takes health away as harm, whatever the flag says", () => {
  expect(refusalOf(target(), hit({ harmful: false, damage: 5000 }), false)).toBe("nopvp");
  expect(refusalOf(target(), hit({ harmful: false, damage: 0 }), false)).toBeNull();
  expect(refusalOf(target(), hit({ harmful: false, damage: -30 }), false)).toBeNull();
});

test("a caster this node mirrors from another node, or a player of this node, is refused; one it does not mirror is accepted from the peer", async () => {
  // Not mirrored here (a spell's range can reach past the mirror band): the authenticated peer's word is taken, the
  // hit is still cleaned, and the stand-in is marked as a remote player of the asking node.
  // It happens in real play, so it is a debug line and not a warning.
  const debug = spyOn(log, "debug").mockImplementation((() => {}) as any);
  const warn = spyOn(log, "warn").mockImplementation((() => {}) as any);
  try {
    await owner(async (call, seen) => {
      expect(await call(hit({ harmful: false, damage: 5000, casterName: "Stranger" }))).toEqual({ ok: true, answer: { outcome: "applied" } });
      expect(seen.length).toBe(1);
      expect(seen[0]!.hit.harmful).toBe(true);
      expect(seen[0]!.caster).toMatchObject({ id: "c1", username: "Stranger", remote: true, mirrorFrom: "a" });
    }, null);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]![0])).toContain("c1");
    expect(warn).not.toHaveBeenCalled();
  } finally {
    debug.mockRestore();
    warn.mockRestore();
  }
  // The id of a player who is on this node is never a remote caster.
  playerCache.set("c1", { id: "c1", username: "Local" } as any);
  try {
    await owner(async (call, seen) => {
      expect(await call(hit())).toEqual({ ok: true, answer: { outcome: "refused", reason: "caster" } });
      expect(seen).toEqual([]);
    }, null);
  } finally {
    playerCache.remove("c1");
  }
  await owner(async (call, seen) => {
    expect(await call(hit())).toEqual({ ok: true, answer: { outcome: "refused", reason: "caster" } });
    expect(seen).toEqual([]);
  }, { mirrorFrom: "z" });
  // The control: a caster mirrored from the asking node.
  await owner(async (call, seen) => {
    expect(await call(hit())).toEqual({ ok: true, answer: { outcome: "applied" } });
    expect(seen.length).toBe(1);
  });
});

test("the caster's name is the mirror's, not the one in the body", async () => {
  await owner(async (call, seen) => {
    await call(hit({ casterName: "Administrator" }));
    expect(seen[0]!.caster.username).toBe("Caster");
    expect(seen[0]!.hit.casterName).toBe("Caster");
  });
});

test("the spell is this node's own copy, found by id; a spell this node does not have is refused", async () => {
  knowSpells([{ id: 9, name: "Frost", damage: 5, effects: [{ type: "slow", value: 10 }] }]);
  await owner(async (call, seen) => {
    const forged = { id: 9, name: "Frost", damage: 5, effects: [{ type: "stun", value: 9999, duration: 9999 }] };
    expect(await call(hit({ spell: forged as any }))).toEqual({ ok: true, answer: { outcome: "applied" } });
    expect(seen[0]!.hit.spell as any).toEqual({ id: 9, name: "Frost", damage: 5, effects: [{ type: "slow", value: 10 }] });
    expect(await call(hit({ spell: { id: 777, name: "Doom", effects: [{ type: "stun" }] } as any }))).toEqual({ ok: true, answer: { outcome: "refused", reason: "spell" } });
    expect(await call(hit({ spell: { name: "No id", effects: [] } as any }))).toEqual({ ok: true, answer: { outcome: "refused", reason: "spell" } });
    expect(seen.length).toBe(1);
    // No spell at all (a melee-like hit) is not a spell to look up.
    expect(await call(hit({ spell: null }))).toEqual({ ok: true, answer: { outcome: "applied" } });
  });
});

test("a hit with a spell reads no asset cache: the spell comes from the in-process lookup", async () => {
  knowSpells([{ id: 9, name: "Frost", damage: 5, effects: [] }]);
  const reads = spyOn(assetCache, "get");
  try {
    await owner(async (call, seen) => {
      for (let i = 0; i < 3; i++) await call(hit({ spell: { id: 9 } as any }));
      expect(seen.length).toBe(3);
    });
    expect(reads).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
  }
});

test("the damage is held to the target's full health plus its barriers, and a damage that is not a number is none", async () => {
  playerCache.set("t1", { id: "t1", username: "Target", stats: { health: 80, total_max_health: 100 }, barriers: [{ amount: 50 }, { amount: -7 }] } as any);
  try {
    await owner(async (call, seen) => {
      await call(hit({ damage: 1e9 }));
      expect(seen[0]!.hit.damage).toBe(150);
      await call(hit({ harmful: false, damage: -1e9 }));
      expect(seen[1]!.hit.damage).toBe(-150);
      await call(hit({ damage: "lots" as any }));
      expect(seen[2]!.hit.damage).toBe(0);
      // What play can do is not touched.
      await call(hit({ damage: 12 }));
      expect(seen[3]!.hit.damage).toBe(12);
    });
  } finally {
    playerCache.remove("t1");
  }
});

test("a casterParty that is not a list of names is an empty party, so nothing throws after the damage", async () => {
  await owner(async (call, seen) => {
    for (const party of [null, "Target", { length: 1 }, undefined]) await call(hit({ casterParty: party as any }));
    expect(seen.map((s) => s.hit.casterParty)).toEqual([[], [], [], []]);
    expect(seen.map((s) => s.caster.party)).toEqual([[], [], [], []]);
    await call(hit({ casterParty: ["Target", 7, null, "Other"] as any }));
    expect(seen[4]!.hit.casterParty).toEqual(["Target", "Other"]);
  });
});

test("setPlayerHitApplier answers the applier it replaces", () => {
  const first: PlayerHitApplier = async () => ({ outcome: "applied" });
  const second: PlayerHitApplier = async () => ({ outcome: "missing" });
  // beforeEach cleared the applier the receiver may have set.
  expect(setPlayerHitApplier(first)).toBeNull();
  expect(setPlayerHitApplier(second)).toBe(first);
  expect(setPlayerHitApplier(null)).toBe(second);
});

// m1: every test put back the applier it found, and this file puts back what was there before it.
afterAll(() => {
  expect(setPlayerHitApplier(outer)).toBe(sentinel);
});
