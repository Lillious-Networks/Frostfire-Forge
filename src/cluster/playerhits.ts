import log from "../modules/logger";
import layerManager from "../services/layermanager";
import playerCache from "../services/playermanager";
import { spellHasHostileEffects } from "../systems/spelleffects";
import { onApplyEffect, sendEffect, type EffectResult } from "./effects";
import { bareMap, mirrorOwner, mirrorPlayers } from "./mirrors";

// A player's spell on a player of a neighbouring node (spec §4). The caster's
// node rolls the hit, where the caster's stats are, and sends it as a
// player_hit to the target's owner. The owner makes every check that protects
// the target (same map and layer, no-PvP, GM stealth, guests, death) and
// applies it the way a local hit is applied. The applier itself lives with the
// spell code (socket/receiver.ts) and is handed in through setPlayerHitApplier.

export interface PlayerHit {
  casterId: string;
  casterName: string;
  casterStats: any;
  casterLocation: { map: string; position: { x: number; y: number; direction?: string } };
  /** The caster's layer on the caster's node; the target must be on the same one. */
  casterLayer: string | null;
  casterParty: string[];
  spell: SpellData | null;
  /** Final damage after the target's avoidance and armor; negative heals. */
  damage: number;
  isCrit: boolean;
  /** A damage spell the target avoided: its effects do not land. */
  skipEffects: boolean;
  /** Spell damage is not 0: the damage number is shown. */
  showsDamage: boolean;
  /** Damage above 0 or a hostile effect: the target's no-PvP check applies. */
  harmful: boolean;
}

export type HitRefusal = "missing" | "dead" | "immune" | "nopvp";
export type PlayerHitApplier = (targetId: string, hit: PlayerHit, caster: any) => Promise<EffectResult>;

/**
 * Why the target's owner refuses a hit, or null. `harmAllowed` is the owner's no-PvP answer for the
 * caster's sent position and the target's own; a hit that does no harm (a heal, a buff) ignores it.
 * A target that has since moved to another map or layer than the one the caster hit is missing.
 */
export function refusalOf(target: any, hit: PlayerHit, harmAllowed: boolean): HitRefusal | null {
  // A hit that takes health away is harm whatever the flag says: a peer cannot get damage past the no-PvP check by clearing it.
  const harmful = hit.harmful || Number(hit.damage) > 0;
  if (!target?.stats || !target.location) return "missing";
  if (bareMap(target.location.map) !== bareMap(hit.casterLocation?.map)) return "missing";
  const layer = target.aoi?.layerId ?? layerManager.getPlayerLayer(String(target.id)) ?? null;
  if (layer !== (hit.casterLayer ?? null)) return "missing";
  // Health 0 or less is a death in progress: handlePlayerDeath sets isDead only after its awaits.
  if (target.isDead || target.isGhost || target.stats.health <= 0) return "dead";
  // An admin in GM stealth is out of the game for everyone else, and guests cannot be attacked.
  if (target.isStealth || target.isGuest) return "immune";
  if (harmful && !harmAllowed) return "nopvp";
  return null;
}

/**
 * A stand-in for the caster on the target's owner: what the spell code reads of a caster (id, name,
 * stats, place, party), on top of the caster's mirror when there is one. It is marked remote, so
 * nothing is sent to it and handlePlayerDeath and setPlayerPvp leave it alone. The mirror itself
 * is never changed.
 */
export function casterFor(hit: PlayerHit, from: string): any {
  const mirror = mirrorPlayers.get(String(hit.casterId));
  return {
    ...(mirror ?? {}),
    id: String(hit.casterId),
    username: hit.casterName,
    stats: { ...(hit.casterStats ?? {}) },
    location: hit.casterLocation,
    party: [...(hit.casterParty ?? [])],
    remote: true,
    mirrorFrom: from,
    wt: undefined,
    aoi: undefined,
  };
}

let applier: PlayerHitApplier | null = null;

/**
 * The spell code's applier of a hit on a local player. Null removes it (tests). Answers the applier that was set
 * before, so a test can put it back: every test file shares one process, and the receiver sets its applier only
 * once, when it loads.
 */
export function setPlayerHitApplier(fn: PlayerHitApplier | null): PlayerHitApplier | null {
  const previous = applier;
  applier = fn;
  return previous;
}

export type SpellLookup = (id: number) => SpellData | undefined;

let spellLookup: SpellLookup | null = null;

/**
 * The in-process lookup of this node's spells by id. The creature system sets it when it loads, with the map it keeps
 * current for its own casts, so a hit from a neighbouring node reads no asset cache. Answers the one set before, so
 * a test can put it back. With none set, no spell is known.
 */
export function setSpellLookup(fn: SpellLookup | null): SpellLookup | null {
  const previous = spellLookup;
  spellLookup = fn;
  return previous;
}

/**
 * This node's copy of the spell a hit names, found by its id; undefined when there is none.
 * The spell in a body is the sender's word: its effects and numbers are never used.
 */
function localSpell(sent: any): SpellData | undefined {
  const id = Number(sent?.id);
  return Number.isFinite(id) ? spellLookup?.(id) : undefined;
}

/**
 * The most a hit can matter to `target`: its full health plus every barrier it holds. Damage beyond that kills no
 * more surely, and healing beyond it heals no more, so a hit is held to it. A target that is not here has no
 * reach to hold a hit to: the applier answers that it is missing.
 */
function reachOf(target: any): number {
  if (!target?.stats) return Infinity;
  const health = Math.max(0, Number(target?.stats?.total_max_health ?? target?.stats?.max_health) || 0);
  const barriers = Array.isArray(target?.barriers) ? target.barriers : [];
  return health + barriers.reduce((sum: number, b: any) => sum + Math.max(0, Number(b?.amount) || 0), 0);
}

/**
 * The hit as the owner applies it, field by field from what the peer sent: the damage held to what the target can
 * lose or regain, `harmful` set whenever it hurts, or its spell has a hostile effect (as the caster's own code counts a
 * spell that is not a heal), the caster's name the mirror's own, the party a list of names and the spell this node's
 * copy. A hit that is not an object in some field is made one.
 */
export function cleanHit(hit: PlayerHit, spell: SpellData | null, target: any, casterName: string): PlayerHit {
  const reach = reachOf(target);
  const sent = Number(hit.damage);
  const damage = Number.isFinite(sent) ? Math.max(-reach, Math.min(reach, sent)) : 0;
  const object = (value: any) => (value && typeof value === "object" ? value : {});
  return {
    casterId: hit.casterId,
    casterName,
    casterStats: object(hit.casterStats),
    casterLocation: object(hit.casterLocation),
    casterLayer: hit.casterLayer ?? null,
    casterParty: Array.isArray(hit.casterParty) ? hit.casterParty.filter((name) => typeof name === "string") : [],
    spell,
    damage,
    isCrit: !!hit.isCrit,
    skipEffects: !!hit.skipEffects,
    showsDamage: !!hit.showsDamage,
    // A heal (a spell whose damage is below 0) stays a heal: its hostile effects are not counted, as the caster's
    // own area heal does not count them. Damage above 0 is harm in any case.
    harmful: damage > 0 || !!hit.harmful || (spell != null && !(Number(spell.damage) < 0) && spellHasHostileEffects(spell)),
  };
}

/** How far the caster position a hit carries may be from where the caster's mirror here last stood. */
export const CASTER_DRIFT_PX = 128;
/** Added to a spell's range and splash: the target moved on its own node since the caster's node saw it. */
export const RANGE_TOLERANCE_PX = 64;

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Why the owner refuses a hit for where it came from, or null. The caster position the peer sent must be near its
 * mirror here (when there is one), and the target, as it stands here, within the spell's range and splash from it.
 * A target that is not here is not measured: refusalOf answers that it is missing.
 */
export function reachRefusal(known: any, target: any, hit: PlayerHit, spell: SpellData | null): "caster" | "range" | null {
  const sent = { x: Number(hit?.casterLocation?.position?.x), y: Number(hit?.casterLocation?.position?.y) };
  if (!Number.isFinite(sent.x) || !Number.isFinite(sent.y)) return "caster";
  const mirror = known?.location?.position;
  if (mirror && Number.isFinite(Number(mirror.x)) && Number.isFinite(Number(mirror.y))) {
    if (distance(sent, { x: Number(mirror.x), y: Number(mirror.y) }) > CASTER_DRIFT_PX) return "caster";
  }
  const position = target?.location?.position;
  if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) return null;
  const reach = (Number(spell?.range) || 100) + (Number(spell?.aoe_radius) || 0) + RANGE_TOLERANCE_PX;
  return distance(sent, { x: Number(position.x), y: Number(position.y) }) > reach ? "range" : null;
}

// Registered once at load; it runs only when the links are attached (the cluster is on).
onApplyEffect("player_hit", async (target, hit: PlayerHit, from): Promise<EffectResult> => {
  if (!applier || !hit || typeof hit.casterId !== "string") return { outcome: "missing" };
  // A caster this node mirrors from another node cannot be claimed by the asker, and nor can a player of this node.
  // A caster this node does not mirror at all is accepted from the authenticated peer: a spell's range and splash
  // can reach past the mirror band, and a target can stand outside its owner's blocks before there is a handoff.
  const known = mirrorPlayers.get(hit.casterId);
  if ((known && known.mirrorFrom !== from) || (!known && playerCache.get(hit.casterId))) return { outcome: "refused", reason: "caster" };
  if (!known) log.debug(`player_hit from ${from}: caster ${String(hit.casterId).slice(0, 64)} is not mirrored here`);
  let spell: SpellData | null = null;
  if (hit.spell != null) {
    spell = localSpell(hit.spell) ?? null;
    if (!spell) return { outcome: "refused", reason: "spell" };
  }
  const local = playerCache.get(String(target));
  const far = reachRefusal(known, local, hit, spell);
  if (far) return { outcome: "refused", reason: far };
  const clean = cleanHit(hit, spell, local, String(known?.username ?? hit.casterName ?? "").slice(0, 64));
  return applier(String(target), clean, casterFor(clean, from));
});

/** Send `hit` to the owner of the mirrored `target`. Null when it is not mirrored, or no answer came. */
export async function sendPlayerHit(target: any, hit: PlayerHit): Promise<EffectResult | null> {
  const owner = mirrorOwner(target?.id);
  if (!owner) return null;
  return sendEffect(owner, { op: "player_hit", target: String(target.id), body: hit });
}
