import { ARRIVAL_TTL_MS } from "../cluster/handoff";
import { bareMapName } from "../cluster/handoffwatch";
import type { LinkContext } from "../cluster/linkhooks";
import log from "../modules/logger";
import cooldownManager from "../services/cooldownmanager";
import effectManager from "../services/effectmanager";
import { CONSUMABLE_COOLDOWN_MS, setReadyIn as setConsumableReadyIn } from "../systems/consumables";
import { SICKNESS_DURATION_MS, saveOnDisconnect as saveSickness } from "../systems/resurrection";
import { STAT_INT_MAX } from "../systems/creatures/remotereward";

// Cells phase 6: the arrival side of a player handoff, kept out of the receiver so it can be tested. The state record
// is the one Task 13's handoffState builds on the old node (Deviation 18): cooldowns, the last attack and the
// consumable cooldown travel as remaining or elapsed milliseconds, the effects and the sickness as Date.now()
// deadlines. The record came over a link and is the only source of these values here, so each element is checked
// against what this node's own rules could have made, and what could not is dropped or clamped, with a warning.

export interface HandoffState {
  dots: any[];
  barriers: any[];
  stuns: any[];
  slows: any[];
  cooldowns: Record<string, number>;
  lockoutMs: number;
  sickUntil: number;
  deadState: 0 | 1 | 2;
  corpse: { map: string; x: number; y: number } | null;
  pvp: boolean;
  lastAttackAgoMs: number | null;
  mounted: boolean;
  mount_type: string | null;
  /** The shared consumable cooldown left (ms, 0 when ready), at most a full cooldown. */
  consumableReadyIn: number;
  /** The direction the player was walking when handed off (one of the eight), or null: the arrival goes on walking. */
  walk: string | null;
}

/** The directions a MOVEXY names (the same eight as VALID_DIRECTIONS in receiver.ts), as the walk of an arrival may be. */
export const WALK_DIRECTIONS: ReadonlySet<string> = new Set(["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"]);

/**
 * The way a player is walking, for the handoff: the direction their mover steps in (their facing can differ while a
 * cast is on), or null when they stand. The drain unregisters the mover but leaves `moving` as it was, so this reads
 * the player's own record, not the game loop.
 */
export function walkOf(p: any): string | null {
  if (p?.moving !== true || p.isDead) return null;
  const direction = String(p._movementState?.targetDirection ?? p.location?.position?.direction ?? "").toLowerCase();
  return WALK_DIRECTIONS.has(direction) ? direction : null;
}

/**
 * The walk the new node has the player in when it sends HANDOFF_DONE: the direction of the resumed walk (the MOVEXY it
 * is about to run for the arrival, as walkOf read it on the old node), or null when it does not walk the player. A dead
 * or stunned player, or one a teleport holds, is not walked, so they are null. The dead, stun and teleport checks are
 * defence: walk is already null for a dead player (walkOf), and no stun or teleport is set before the walk resumes.
 */
export function doneWalkOf(walk: string | null | undefined, p: any, now = Date.now()): string | null {
  if (typeof walk !== "string" || !WALK_DIRECTIONS.has(walk)) return null;
  if (p?.isDead || p?.ghostTeleportPending) return null;
  if (Number(p?.stunnedUntil) > now) return null;
  return walk;
}

/** The most effects of one kind an arrival brings. */
export const MAX_ARRIVAL_EFFECTS = 32;
/** The shortest horizon for a timed effect: the built-in ones (the creatures' daze) are not in the spell list. */
export const MIN_EFFECT_HORIZON_MS = 60_000;
/** How far the old node's clock may be ahead of this one's (Date.now() deadlines; the nodes run NTP). */
export const ARRIVAL_CLOCK_SLACK_MS = 5_000;
/** A DoT's stacks when its spell names none (systems/dots.ts). */
const DEFAULT_MAX_STACKS = 5;

/**
 * The DoT scheduler's period in seconds (SCHEDULER_INTERVAL_MS in systems/dots.ts, 250 ms; the spell editor's
 * smallest "tick every" is the same). A DoT that ticks faster is one no spell makes: it would tick on every pass.
 * The test of this file reads dots.ts, so the two cannot drift apart.
 */
export const MIN_DOT_INTERVAL_S = 0.25;

/**
 * What this node knows that an arrival's record is checked against. Without a lookup nothing is known: a caster is
 * cleared and a corpse is dropped.
 */
export interface ArrivalKnown {
  /** Whether `id` / `username` is a player this node holds: in the player cache, or the mirror of one on a neighbour. */
  caster?: (id: string, username: string) => boolean;
  /** This node's maps (assetCache "maps"), as adminMoveOf reads them. */
  maps?: ReadonlyArray<{ name: string }>;
}

/** Whether `maps` holds the map a corpse names, as adminMoveOf reads it (the name without ".json"). */
function holdsMap(maps: ReadonlyArray<{ name: string }> | undefined, corpseMap: string): boolean {
  const map = corpseMap.replace(/\.json$/, "");
  return (maps ?? []).some((m) => m?.name === `${map}.json`);
}

/**
 * The maps an arrival's corpse is checked against. `startup` is the list this node loaded at start; `load` reads the
 * whole set from the cache (20 MB over Redis), so it runs only for a corpse on a map the startup list lacks (a map
 * created since, assetloader.addCreatedMap). An arrival with no corpse, or one on a startup map, never calls it.
 */
export async function arrivalMaps(
  rawState: any,
  startup: ReadonlyArray<{ name: string }> | null | undefined,
  load: () => Promise<ReadonlyArray<{ name: string }> | null | undefined>,
): Promise<ReadonlyArray<{ name: string }>> {
  const c = rawState?.corpse;
  const start = startup ?? [];
  // Anything handoffStateOf drops before the map check needs no list.
  if (!c || typeof c !== "object" || typeof c.map !== "string" || c.map.length === 0 || !finite(c.x) || !finite(c.y)) return start;
  if (holdsMap(start, c.map)) return start;
  return (await load()) || start;
}

/** What this node's spells allow an arrival's effects to be. */
export interface ArrivalLimits {
  /** Date.now() at the arrival. */
  now: number;
  /** The largest barrier any spell gives. */
  barrierMax: number;
  /** Whether a spell gives a barrier with no end (expiresAt 0). */
  permanentBarriers: boolean;
  /** The latest a timed effect may end, from now: the longest effect of any spell, at least a minute. */
  effectHorizonMs: number;
  /** The most stacks any DoT or HoT may have. */
  maxStacks: number;
}

/** The limits read from this node's spells (assetCache "spells"). */
export function arrivalLimits(spells: ReadonlyArray<any> | null | undefined, now = Date.now()): ArrivalLimits {
  let barrierMax = 0;
  let permanentBarriers = false;
  let longestSec = 0;
  let maxStacks = DEFAULT_MAX_STACKS;
  for (const spell of Array.isArray(spells) ? spells : []) {
    for (const effect of Array.isArray(spell?.effects) ? spell.effects : []) {
      const value = Number(effect?.value);
      const duration = Number(effect?.duration);
      if (Number.isFinite(duration) && duration > longestSec) longestSec = duration;
      if (effect?.type === "absorbtion" && Number.isFinite(value) && value > 0) {
        barrierMax = Math.max(barrierMax, value);
        if (!(duration > 0)) permanentBarriers = true;
      }
      const stacks = Number(effect?.max_stacks);
      if (Number.isFinite(stacks) && stacks > maxStacks) maxStacks = Math.floor(stacks);
    }
  }
  return { now, barrierMax, permanentBarriers, effectHorizonMs: Math.max(MIN_EFFECT_HORIZON_MS, longestSec * 1000), maxStacks };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Keeps the elements of one effect list that `why` finds nothing wrong with (it answers the reason, or null), at most
 * MAX_ARRIVAL_EFFECTS of them. Each one dropped is logged with the player's name.
 */
function checkedList(who: string, kind: string, value: unknown, why: (element: any) => string | null): any[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    log.warn(`The ${kind} ${who} brought by handoff were dropped: not a list`);
    return [];
  }
  const kept: any[] = [];
  for (const element of value) {
    const reason = element && typeof element === "object" ? why(element) : "not a record";
    if (reason !== null) {
      log.warn(`One of the ${kind} ${who} brought by handoff was dropped: ${reason}`);
      continue;
    }
    if (kept.length >= MAX_ARRIVAL_EFFECTS) {
      log.warn(`The ${kind} ${who} brought by handoff were cut to ${MAX_ARRIVAL_EFFECTS}: they brought ${value.length}`);
      break;
    }
    kept.push(element);
  }
  return kept;
}

/**
 * One DoT or HoT of an arrival that passed the checks, made to fit what a spell can make: a tick no faster than the
 * scheduler runs, a tick no larger than STAT_INT_MAX over all stacks (the sign stays: a HoT is negative), a next tick
 * neither older than an arrival can be nor farther ahead than one period, and a caster only when this node knows them. A caster who is not a known
 * player gives no kill or PvP credit (systems/dots.ts treats an empty caster as no caster).
 */
function clampedDot(d: any, now: number, who: string, known: ArrivalKnown): any {
  const out = { ...d };
  if (out.interval < MIN_DOT_INTERVAL_S) {
    log.warn(`The tick of one of the effects over time ${who} brought by handoff was every ${out.interval} s: cut to ${MIN_DOT_INTERVAL_S} s`);
    out.interval = MIN_DOT_INTERVAL_S;
  }
  const most = Math.max(1, Math.floor(STAT_INT_MAX / out.maxStacks));
  if (Math.abs(out.damagePerTick) > most) {
    log.warn(`One of the effects over time ${who} brought by handoff ticked for ${out.damagePerTick}: cut to ${out.damagePerTick < 0 ? -most : most}`);
    out.damagePerTick = out.damagePerTick < 0 ? -most : most;
  }
  const periodMs = out.interval * 1000;
  // Ticks owed for the time the handoff took are kept (the scheduler pays them one per pass, as after a relog): the
  // arrival waits at most ARRIVAL_TTL_MS, so a tick further behind than that, and a period, cannot be a real one.
  if (out.nextTickAt < now - ARRIVAL_TTL_MS - periodMs) out.nextTickAt = now;
  else if (out.nextTickAt > now + periodMs + ARRIVAL_CLOCK_SLACK_MS) out.nextTickAt = now + periodMs;
  const id = typeof out.casterId === "string" || typeof out.casterId === "number" ? String(out.casterId) : "";
  const name = typeof out.casterUsername === "string" ? out.casterUsername : "";
  if (id !== "" || name !== "") {
    if (id !== "" && name !== "" && known.caster?.(id, name) === true) {
      out.casterId = id;
      out.casterUsername = name;
    } else {
      // A creature casts as "creature:<id>" under its template's name (creatures/index.ts): its credit goes nowhere, and
      // that is no news. Anyone else who is not known is.
      const creature = typeof out.casterId === "string" && out.casterId.startsWith("creature:");
      (creature ? log.debug : log.warn)(`The caster of one of the effects over time ${who} brought by handoff is not a player this node knows: no credit for it`);
      out.casterId = "";
      out.casterUsername = "";
    }
  } else {
    // No caster named: fields that are there are made empty text, and ones that are not stay out.
    if ("casterId" in out) out.casterId = "";
    if ("casterUsername" in out) out.casterUsername = "";
  }
  return out;
}

/**
 * The record as it came over the link, each field made the type the login reads and each element checked against
 * `limits`. `who` names the player in the warnings.
 */
export function handoffStateOf(raw: unknown, limits: ArrivalLimits, who = "an arriving player", known: ArrivalKnown = {}): HandoffState {
  const r: any = raw && typeof raw === "object" ? raw : {};
  const latest = limits.now + limits.effectHorizonMs + ARRIVAL_CLOCK_SLACK_MS;
  const ends = (e: any): string | null =>
    !finite(e.expiresAt) || e.expiresAt < 0 ? "no end time" : e.expiresAt > latest ? `it ends ${Math.round((e.expiresAt - limits.now) / 1000)} s from now` : null;

  const cooldowns: Record<string, number> = {};
  if (r.cooldowns && typeof r.cooldowns === "object") {
    for (const [spellId, left] of Object.entries(r.cooldowns)) {
      if (Number.isInteger(Number(spellId)) && positive(left) > 0) cooldowns[spellId] = positive(left);
    }
  }

  const barriers = checkedList(who, "barriers", r.barriers, (b) => {
    if (!finite(b.amount) || b.amount <= 0 || b.amount > limits.barrierMax) return `an amount of ${b.amount}, the most a spell gives is ${limits.barrierMax}`;
    if (b.expiresAt === 0) return limits.permanentBarriers ? null : "no end, and no spell gives a barrier without one";
    return ends(b);
  });
  const stuns = checkedList(who, "stuns", r.stuns, ends);
  const slows = checkedList(who, "slows", r.slows, (s) =>
    !finite(s.slowPercent) || s.slowPercent < 1 || s.slowPercent > 99 ? `a slow of ${s.slowPercent}%` : ends(s));
  const checkedDots = checkedList(who, "effects over time", r.dots, (d) => {
    if (!finite(d.damagePerTick) || !Number.isInteger(d.damagePerTick) || d.damagePerTick === 0) return `${d.damagePerTick} a tick`;
    if (!finite(d.interval) || d.interval <= 0) return `a tick every ${d.interval} s`;
    if (!finite(d.nextTickAt)) return "no next tick";
    if (!Number.isInteger(d.maxStacks) || d.maxStacks < 1 || d.maxStacks > limits.maxStacks) return `at most ${d.maxStacks} stacks`;
    if (!Number.isInteger(d.stacks) || d.stacks < 1 || d.stacks > d.maxStacks) return `${d.stacks} stacks`;
    return ends(d);
  });
  const dots = checkedDots.map((d) => clampedDot(d, limits.now, who, known));

  let sickUntil = positive(r.sickUntil);
  const sickLatest = limits.now + SICKNESS_DURATION_MS + ARRIVAL_CLOCK_SLACK_MS;
  if (sickUntil > sickLatest) {
    log.warn(`The resurrection sickness ${who} brought by handoff ended ${Math.round((sickUntil - limits.now) / 1000)} s from now: cut to the full sickness`);
    sickUntil = limits.now + SICKNESS_DURATION_MS;
  }

  const dead = Number(r.deadState);
  const deadState: 0 | 1 | 2 = dead === 1 || dead === 2 ? dead : 0;
  let corpse: HandoffState["corpse"] = null;
  if (r.corpse != null) {
    const c = r.corpse;
    if (c && typeof c === "object" && typeof c.map === "string" && c.map.length > 0 && finite(c.x) && finite(c.y)) {
      // The map is one this node has, named as adminMoveOf reads it (the name without ".json").
      if (holdsMap(known.maps, c.map)) {
        corpse = { map: c.map, x: c.x, y: c.y };
      } else {
        log.warn(`The corpse ${who} brought by handoff was dropped: an unknown map ${JSON.stringify(String(c.map).slice(0, 64))}`);
      }
    } else {
      log.warn(`The corpse ${who} brought by handoff was dropped: not a map and a point`);
    }
  }

  let consumableReadyIn = 0;
  if (r.consumableReadyIn != null) {
    const left = r.consumableReadyIn;
    if (!finite(left) || left < 0) {
      log.warn(`The consumable cooldown ${who} brought by handoff was dropped: ${left}`);
    } else if (left > CONSUMABLE_COOLDOWN_MS) {
      log.warn(`The consumable cooldown ${who} brought by handoff was ${left} ms: cut to ${CONSUMABLE_COOLDOWN_MS}`);
      consumableReadyIn = CONSUMABLE_COOLDOWN_MS;
    } else {
      consumableReadyIn = left;
    }
  }

  return {
    dots,
    barriers,
    stuns,
    slows,
    cooldowns,
    lockoutMs: positive(r.lockoutMs),
    sickUntil,
    deadState,
    corpse,
    pvp: r.pvp === true,
    lastAttackAgoMs: r.lastAttackAgoMs == null ? null : positive(r.lastAttackAgoMs),
    mounted: r.mounted === true,
    mount_type: typeof r.mount_type === "string" ? r.mount_type : null,
    consumableReadyIn,
    // A dead player does not walk; anything but one of the eight directions is no walk.
    walk: deadState === 0 && typeof r.walk === "string" && WALK_DIRECTIONS.has(r.walk) ? r.walk : null,
  };
}

/**
 * Put what the player brings where the login path restores it from: the effects under the lowercase name, the
 * cooldowns and lockout as this node's performance.now() deadlines, the sickness as a relog leaves it. What this
 * node kept of the player from an earlier visit is replaced, never added to.
 */
export function seedArrival(username: string, state: HandoffState, now = performance.now()): void {
  const lower = username.toLowerCase();
  effectManager.saveDots(lower, state.dots);
  effectManager.saveBarriers(lower, state.barriers);
  effectManager.saveStuns(lower, state.stuns);
  effectManager.saveSlows(lower, state.slows);
  cooldownManager.removePlayer(username);
  for (const [spellId, left] of Object.entries(state.cooldowns)) cooldownManager.setCooldown(username, Number(spellId), now + left);
  if (state.lockoutMs > 0) cooldownManager.setLockout(username, now + state.lockoutMs);
  saveSickness({ username, resurrectionSickUntil: state.sickUntil });
  if (state.consumableReadyIn > 0) setConsumableReadyIn(username, state.consumableReadyIn);
}

/** The playerCache fields an arrival brings instead of the login's defaults. */
export function arrivalFields(state: HandoffState, now = performance.now()) {
  return {
    pvp: state.pvp,
    last_attack: state.lastAttackAgoMs == null ? null : now - state.lastAttackAgoMs,
    mounted: state.mounted,
    mount_type: state.mounted ? state.mount_type : null,
  };
}

/**
 * The mount an arrival keeps, checked as the MOUNT packet checks it (socket/handlers/movement.ts): the player owns
 * the mount among their collectables, is alive, and does not stand inside a building. The old node's word is not
 * enough: a warp into a building is handed off before the warp's own dismount runs, and the record came over a link.
 */
export function arrivalMount(
  fields: { mounted: boolean; mount_type: string | null },
  collectables: ReadonlyArray<any>,
  deadState: number,
  interior: boolean
): { mounted: boolean; mount_type: string | null } {
  const owned = fields.mount_type !== null && collectables.some((c: any) => c?.type === "mount" && c?.item === fields.mount_type);
  return fields.mounted && owned && deadState === 0 && !interior
    ? { mounted: true, mount_type: fields.mount_type }
    : { mounted: false, mount_type: null };
}

/** The players the client showed on the old node that it does not see here: they are despawned once. */
export function playersToDespawn(shownBefore: Iterable<string>, shownNow: ReadonlySet<string>, selfId: string): string[] {
  const out: string[] = [];
  for (const id of shownBefore) {
    const key = String(id);
    if (key !== selfId && !shownNow.has(key)) out.push(key);
  }
  return out;
}

/**
 * Whether a player is dragged by an admin, or is an admin dragging someone (dragged id to admin id). The ids are
 * compared as text: the map's keys and values are numbers by their type, but a drag started with an id read from a
 * packet can hold a string.
 */
export function draggedCheck(dragged: ReadonlyMap<number, number>): (playerId: string) => boolean {
  return (playerId) => {
    const id = String(playerId);
    for (const [draggedId, adminId] of dragged) {
      if (String(draggedId) === id || String(adminId) === id) return true;
    }
    return false;
  };
}

/** An admin's summon or teleport sent from the admin's node (cells-summon), each field checked. */
export interface AdminMove {
  by: string;
  map: string;
  x: number;
  y: number;
  why: "summon" | "teleport";
  admins: boolean;
}

/** The name of the admin who sent a remote action, or null when it is not a name. */
export function remoteAdminOf(args: any): string | null {
  const by = args?.by;
  return typeof by === "string" && by.trim().length > 0 ? by : null;
}

/**
 * The summon or teleport a link brought, or why it is refused. Every field is checked before use: the map is one
 * this node has (its name without ".json"), the point is a finite number inside that map, and `why` and `admins`
 * are exactly what the admin's node sends.
 */
export function adminMoveOf(args: any, maps: ReadonlyArray<{ name: string; data?: any }>): AdminMove | string {
  const by = remoteAdminOf(args);
  if (by === null) return "no admin name";
  if (args.why !== "summon" && args.why !== "teleport") return `an unknown reason ${JSON.stringify(args.why)}`;
  if (typeof args.admins !== "boolean") return "no admins flag";
  if (typeof args.map !== "string" || args.map.length === 0) return "no map";
  const map = args.map.replace(/\.json$/, "");
  const known = maps.find((m) => m?.name === `${map}.json`);
  if (!known) return `an unknown map ${JSON.stringify(map)}`;
  if (typeof args.x !== "number" || typeof args.y !== "number" || !Number.isFinite(args.x) || !Number.isFinite(args.y)) return "no point";
  const data = known.data;
  const width = Number(data?.width) * Number(data?.tilewidth);
  const height = Number(data?.height) * Number(data?.tileheight);
  if (!(width > 0) || !(height > 0)) return `a map without a size ${JSON.stringify(map)}`;
  const x = Math.round(args.x);
  const y = Math.round(args.y);
  if (x < 0 || y < 0 || x > width || y > height) return `a point outside ${map} (${x}, ${y})`;
  return { by, map, x, y, why: args.why, admins: args.admins };
}

/**
 * Whether the admin who asked for cells-teleport-to may summon admins, as the admin's own node worked it out from
 * their permissions (commands.ts TELEPORT). Only a boolean true counts: a missing or other value is false.
 */
export function reverseSummonAdmins(args: any): boolean {
  return args?.admins === true;
}

/** The node that owns a warp's destination when it is not this one; null to warp here. */
export function warpTarget(ctx: Pick<LinkContext, "ownerAt" | "self"> | null, map: string, x: number, y: number): string | null {
  if (!ctx) return null;
  const owner = ctx.ownerAt(bareMapName(map), x, y);
  return owner && owner !== ctx.self ? owner : null;
}

/**
 * What a resumed arrival's own SPAWN_PLAYER shows, at the deferred spawn step. The client kept its world and the
 * player has walked on since the snapshot: the spawn carries the walk, the mount and the cast as they are now, and the
 * point they stand at now, or the client would rebuild an idle pose and snap back to the snapshot point while the
 * server has them walking on. Null when the player has no usable point (the caller keeps the login values).
 */
export function resumeSelfSpawn(
  current: any,
  nameOf: (direction: string, walking: boolean, mounted: boolean, mountType: string | undefined, casting: boolean) => string,
  moverRunning: boolean = false
): { animationName: string; x: number; y: number; direction: string } | null {
  const here = current?.location?.position;
  if (!here || !Number.isFinite(here.x) || !Number.isFinite(here.y)) return null;
  const direction = here.direction || "down";
  const mounted = current.mounted === true;
  // `moverRunning`: the game loop steps this player (a mover is registered). That is a walk even when a stray stop
  // cleared `moving` while the newest MOVEXY was still on its way to registering the mover.
  return {
    animationName: nameOf(direction, (current.moving === true || moverRunning) && !current.isDead, mounted, mounted ? current.mount_type || undefined : undefined, current.casting === true),
    x: here.x,
    y: here.y,
    direction,
  };
}

/** How long after a resumed handoff arrival that walks a superseded mover's stray stop is undone (movement.ts). */
export const RESUME_WALK_RECOVER_MS = 3000;
/** The longest the deferred spawn waits for the resumed walk to begin. */
export const RESUME_WALK_WAIT_MS = 500;

/**
 * Waits for `work`, at most `ms`; the timer is cleared when the work ends first. Never rejects.
 */
export async function waitFor(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work.catch(() => undefined), new Promise<void>((done) => { timer = setTimeout(done, ms); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A mover about to register after a stray stop (a superseded mover's tick cleared `moving`): for a player who just
 * arrived by a resumed handoff (`until` is the end of that window, undefined for everyone else), `moving` is put back
 * and true is returned, so the caller sends the walk pose again. Anyone else, a dead or ghost-teleporting player, a
 * player who is moving already, or a window that has ended is left alone (false).
 */
export function recoverResumedWalk(
  player: { moving?: boolean; isDead?: boolean; ghostTeleportPending?: boolean },
  until: number | undefined,
  now: number
): boolean {
  if (until === undefined || !(now <= until)) return false;
  if (player.moving || player.isDead || player.ghostTeleportPending) return false;
  player.moving = true;
  return true;
}
