import { afterEach, beforeEach, expect, test } from "bun:test";
import { LinkCalls, linkCalls } from "../cluster/linkcalls";
import { mirrorPlayers } from "../cluster/mirrors";
import { CASTER_DRIFT_PX, RANGE_TOLERANCE_PX, reachRefusal, setPlayerHitApplier, setSpellLookup, type PlayerHit, type PlayerHitApplier, type SpellLookup } from "../cluster/playerhits";
import playerCache from "../services/playermanager";
import { linkPair } from "./cluster-fakelink";

let savedApplier: PlayerHitApplier | null = null;
let savedLookup: SpellLookup | null = null;
beforeEach(() => {
  savedApplier = setPlayerHitApplier(null);
  savedLookup = setSpellLookup(null);
});
afterEach(() => {
  mirrorPlayers.clear();
  setPlayerHitApplier(savedApplier);
  setSpellLookup(savedLookup);
  linkCalls.detach();
  playerCache.remove("t1");
});

const hit = (x: number, y: number, over: Partial<PlayerHit> = {}): PlayerHit => ({
  casterId: "c1", casterName: "Caster", casterStats: {}, casterLocation: { map: "forest", position: { x, y } },
  casterLayer: null, casterParty: [], spell: null, damage: 5, isCrit: false, skipEffects: false, showsDamage: true, harmful: true, ...over,
});
const at = (x: number, y: number) => ({ id: "t1", username: "Target", stats: { health: 50 }, location: { map: "forest", position: { x, y } } });
const mirrorAt = (x: number, y: number) => ({ id: "c1", username: "Caster", remote: true, mirrorFrom: "a", location: { map: "forest", position: { x, y } } });

test("a caster sent near its mirror, hitting within range, is in reach", () => {
  expect(reachRefusal(mirrorAt(0, 0), at(90, 0), hit(10, 0), null)).toBeNull();
});

test("a caster sent farther than the drift from its mirror is refused", () => {
  expect(reachRefusal(mirrorAt(0, 0), at(0, 0), hit(CASTER_DRIFT_PX + 1, 0), null)).toBe("caster");
});

test("a caster not mirrored here is not held to a mirror", () => {
  expect(reachRefusal(undefined, at(10, 0), hit(0, 0), null)).toBeNull();
});

test("a target beyond the spell's range is refused", () => {
  const spell = { id: 1, range: 200, aoe_radius: 0 } as any;
  expect(reachRefusal(undefined, at(200 + RANGE_TOLERANCE_PX - 1, 0), hit(0, 0), spell)).toBeNull();
  expect(reachRefusal(undefined, at(200 + RANGE_TOLERANCE_PX + 1, 0), hit(0, 0), spell)).toBe("range");
});

test("a splash radius adds to the range", () => {
  const spell = { id: 1, range: 200, aoe_radius: 100 } as any;
  expect(reachRefusal(undefined, at(300 + RANGE_TOLERANCE_PX - 1, 0), hit(0, 0), spell)).toBeNull();
});

test("a hit with no spell is held to 100 px", () => {
  expect(reachRefusal(undefined, at(100 + RANGE_TOLERANCE_PX + 1, 0), hit(0, 0), null)).toBe("range");
});

test("a caster position that is no number is refused", () => {
  expect(reachRefusal(undefined, at(0, 0), hit(NaN, 0), null)).toBe("caster");
});

test("the owner refuses a drifted caster before the applier runs", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  try {
    let applied = 0;
    setPlayerHitApplier(async () => (applied++, { outcome: "applied" }));
    mirrorPlayers.set("c1", mirrorAt(0, 0));
    const outcome = await caller.call("b", "APPLY_EFFECT", { op: "player_hit", target: "t1", body: hit(5000, 0) });
    expect(outcome).toEqual({ ok: true, answer: { outcome: "refused", reason: "caster" } });
    expect(applied).toBe(0);
  } finally {
    caller.detach();
  }
});

test("the owner refuses a local target out of range before the applier runs", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  try {
    let applied = 0;
    setPlayerHitApplier(async () => (applied++, { outcome: "applied" }));
    playerCache.set("t1", at(3000, 0));
    const outcome = await caller.call("b", "APPLY_EFFECT", { op: "player_hit", target: "t1", body: hit(0, 0) });
    expect(outcome).toEqual({ ok: true, answer: { outcome: "refused", reason: "range" } });
    expect(applied).toBe(0);
  } finally {
    caller.detach();
  }
});

test("a legal hit across a block border, at the edge of the spell's range, reaches the applier", async () => {
  const { a, b } = linkPair();
  const caller = new LinkCalls();
  caller.attach(a);
  linkCalls.attach(b);
  try {
    // The caster stands on node a, mirrored here; it has moved 100 px since the mirror last updated, inside the drift.
    // The target is local here, and sits the spell's range plus the tolerance, less 1 px, past where the hit was cast.
    const spell = { id: 1, range: 200, aoe_radius: 0 } as any;
    setSpellLookup((id) => (id === 1 ? spell : undefined));
    const seen: PlayerHit[] = [];
    setPlayerHitApplier(async (_target, clean) => (seen.push(clean), { outcome: "applied" }));
    mirrorPlayers.set("c1", mirrorAt(0, 0));
    playerCache.set("t1", at(100 + 200 + RANGE_TOLERANCE_PX - 1, 0));
    const outcome = await caller.call("b", "APPLY_EFFECT", { op: "player_hit", target: "t1", body: hit(100, 0, { spell: { id: 1 } as any }) });
    expect(outcome).toEqual({ ok: true, answer: { outcome: "applied" } });
    expect(seen.length).toBe(1);
  } finally {
    caller.detach();
  }
});
