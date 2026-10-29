/**
 * USER REQUEST 2026-10-17 ("Can we add a tornado system as well that spawn 1 or 2 on the map at most during a
 * thunderstorm with a rare chance or '/weather tornado' is set? Tornadoes when close to players should pull them in and
 * do 5% damage every second"): tornadoes, kept here, moved here, and shown to the players of their map.
 *
 * - When: a world that shows a thunderstorm (its own, a random one, or the real weather's) has a rare chance of one:
 *   STORM_CHANCE every SPAWN_EVERY ms, about one every quarter of an hour of storm. A world on "tornado" always has one
 *   and often two. Never more than MAX_PER_MAP on a map, and only on a map someone is on. When the storm passes, its
 *   tornadoes die away; each lives a while anyway (LIFE).
 * - Where (USER REQUEST 2026-10-17: "tornadoes should also spawn anywhere on the map and not follow the player or be
 *   forced near the player. They are their own thing"): anywhere on the map, set off in any direction.
 * - How it moves: SPEED px a second, its heading wandering at random, whoever is about; it turns back from the map's
 *   edge. It goes over anything.
 * - Pull: a player within PULL_RADIUS px is drawn in, harder the nearer (PULL_EDGE to PULL_CORE px a second, always
 *   less than a walk, 180: a player who runs gets away), and carried round it a little (SWIRL of the pull, across).
 *   Never into a wall: a step that would end in one is not taken.
 * - Harm: a player within HURT_RADIUS px loses HURT_SHARE (5%) of their maximum health at once, then again every
 *   second they stay. Dead players, ghosts, guests and admins in stealth are left alone.
 * - Shown: every SHOW_EVERY ms the players of a map with tornadoes are told where each is (TORNADOES), and once more
 *   with none when the last has gone. Each player is told only of the tornadoes near them (showNearby).
 *
 * The engine is reached through a bridge (setTornadoBridge, set by receiver.ts): which weather each world shows, its
 * players, its size and walls, and moving, hurting and telling players. tick() is called every 100 ms (forming, dying,
 * harm, telling); pull() on every tick of the movement loop (TICK_RATE, 60 Hz by default), before its steps.
 *
 * USER REPORT 2026-10-17 ("when the tornado moves the player, it's extremely jittery"): the pull was a step every
 * 100 ms. The client draws movement a little in the past between the 30-a-second steps of a walk, so it stopped at
 * each pull step until the next came (stop, go), and a player walking took every third step longer. The tornadoes now
 * move, and pull, on the movement loop's own tick, before its steps: a step every tick, the same as a walk's, and a
 * walking player's step goes on from where the pull left them. Positions are whole px; the part of a px each step
 * leaves over is kept (`exact`), so a slow pull is not uneven steps of 1 and 2 px.
 */
import log from "../modules/logger";
import { logNoIds, nextEntityId } from "../cluster/entityids";
import { TICK_MS } from "../services/tickrate";

export const MAX_PER_MAP = 2;
export const STORM_CHANCE = 0.012;
export const SPAWN_EVERY = 10_000;
/** In a world on "tornado": the chance of a second one, at each look, while there is one. */
export const SECOND_CHANCE = 0.35;
/** ms a tornado lives: [least, most], in a storm and in a world on "tornado". */
export const LIFE = { storm: [60_000, 150_000], tornado: [90_000, 240_000] } as const;
export const SPEED = [80, 130] as const;
export const PULL_RADIUS = 176, PULL_EDGE = 30, PULL_CORE = 110, SWIRL = 0.6;
export const HURT_RADIUS = 64, HURT_SHARE = 0.05, HURT_EVERY = 1000;
export const SHOW_EVERY = 100;
/** How near the map's edge (px) a tornado turns back. */
const EDGE = 200;

export type TornadoWeather = "tornado" | "storm" | "none";

export interface Tornado {
  id: string;
  map: string;
  x: number;
  y: number;
  /** radians: 0 is right, PI / 2 down */
  heading: number;
  speed: number;
  diesAt: number;
}

export interface TornadoBridge {
  /** Each world and what its weather means for tornadoes now. */
  weathers(): Promise<Array<{ map: string; weather: TornadoWeather }>> | Array<{ map: string; weather: TornadoWeather }>;
  /** The players on a map (the live objects of the player cache). */
  players(map: string): any[];
  /** The map's size in px, or null when it is not known. */
  size(map: string): { width: number; height: number } | null;
  /** Whether a player may stand at (x, y) on the map. */
  walkable(map: string, x: number, y: number, who: any): boolean;
  /** Moves a player to (x, y) on their own map, and tells them and those around them. */
  move(who: any, x: number, y: number): void | Promise<void>;
  /** Takes `amount` health from a player, with all that follows (their stats shown, death). */
  hurt(who: any, amount: number): void | Promise<void>;
  /** Tells the players of a map where its tornadoes are (the engine's answer is showNearby, so each hears of the near ones). */
  show(map: string, tornadoes: Array<{ id: string; x: number; y: number }>): void;
}

let bridge: TornadoBridge | null = null;
export function setTornadoBridge(next: TornadoBridge | null): void {
  bridge = next;
}

/** How far past a viewer's own sight radius (px) a tornado is still shown to them: it is tall, and seen from afar. */
export const SHOW_MARGIN = 512;

/** What showNearby needs of the engine. */
export interface ShowViewers {
  /** The players on the map within `reach` px of (x, y), the widest sight radius plus SHOW_MARGIN: the candidates. */
  near(x: number, y: number): any[];
  /** A player still on the map, by id. */
  get(id: string): any | undefined;
  /** How far a player sees (px). */
  reach(viewer: any): number;
  /** Tells a player the tornadoes they now see. An empty list ends what they were shown, so it must not be lost. */
  send(viewer: any, tornadoes: Array<{ id: string; x: number; y: number }>): void;
}

/** Each map's players whose last list held tornadoes, to be sent one empty list when it holds none. */
const shownTo = new Map<string, Set<string>>();

/**
 * Tells each player of a map only the tornadoes within their sight radius plus SHOW_MARGIN, not every tornado on a map
 * that can be huge. The client replaces its list wholesale with each one, so a player whose list has become empty is
 * sent one empty list (once, not at every show) and then left alone.
 */
export function showNearby(map: string, tornadoes: Array<{ id: string; x: number; y: number }>, viewers: ShowViewers): void {
  const lists = new Map<string, { viewer: any; list: Array<{ id: string; x: number; y: number }> }>();
  for (const tornado of tornadoes) {
    for (const viewer of viewers.near(tornado.x, tornado.y)) {
      const at = viewer?.location?.position;
      if (!at) continue;
      const reach = viewers.reach(viewer) + SHOW_MARGIN;
      if ((at.x - tornado.x) ** 2 + (at.y - tornado.y) ** 2 > reach * reach) continue;
      const key = String(viewer.id);
      const entry = lists.get(key);
      if (entry) entry.list.push(tornado);
      else lists.set(key, { viewer, list: [tornado] });
    }
  }
  for (const { viewer, list } of lists.values()) viewers.send(viewer, list);
  for (const id of shownTo.get(map) ?? []) {
    if (lists.has(id)) continue;
    const gone = viewers.get(id);
    if (gone) viewers.send(gone, []);
  }
  if (lists.size) shownTo.set(map, new Set(lists.keys()));
  else shownTo.delete(map);
}

const byMap = new Map<string, Tornado[]>();
/** Each map's weather for tornadoes, as last read (once a second). */
let weathers = new Map<string, TornadoWeather>();
let weathersAt = -Infinity;
const lastSpawnLook = new Map<string, number>();
const lastShown = new Map<string, number>();
/** Maps told of tornadoes the last time, to be told once when there are none. */
const shownSome = new Set<string>();
/** When each player may next be hurt (player id -> ms). */
const nextHurt = new Map<string, number>();
/** Where each pulled player is to the part of a px, and the whole px that stood for it (player id -> place). */
const exact = new Map<string, { x: number; y: number; atX: number; atY: number }>();
let lastPull = 0;
let pulling = false;
let ticking = false;

const norm = (map: string) => String(map ?? "").replace(/\.json$/, "");
const between = (range: readonly [number, number]) => range[0] + Math.random() * (range[1] - range[0]);
/** A random number of about a normal spread (mean 0, deviation 1). */
const jolt = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;

/** The tornadoes on a map now. */
export function tornadoesOn(map: string): Tornado[] {
  return byMap.get(norm(map)) ?? [];
}

/** The maps that have (or have just had) tornadoes. */
export function tornadoMaps(): string[] {
  return [...byMap.keys()];
}

// Cluster mode: tornadoes another node owns near the border. Shown with this map's own, never moved,
// pulled or hurt with here.
const remoteTornadoes = new Map<string, { id: string; map: string; x: number; y: number }>();

/** A mirror of another node's tornado, or its new place. False when the id is one of this node's own. */
export function setRemoteTornado(t: { id: string; map: string; x: number; y: number }): boolean {
  const map = norm(t.map);
  for (const list of byMap.values()) if (list.some((own) => own.id === t.id)) return false;
  remoteTornadoes.set(t.id, { id: t.id, map, x: Math.round(t.x), y: Math.round(t.y) });
  // A map with only remote tornadoes still needs its show pass (the loop in tick walks byMap).
  if (!byMap.has(map)) byMap.set(map, []);
  return true;
}

/** A mirrored tornado's new place. Only the spawn checks the id against this node's own. */
export function moveRemoteTornado(id: string, x: number, y: number): void {
  const t = remoteTornadoes.get(id);
  if (!t) return;
  t.x = Math.round(x);
  t.y = Math.round(y);
}

export function removeRemoteTornado(id: string): void {
  remoteTornadoes.delete(id);
}

/** Cluster mode, a block moving away: this node's tornado `id` leaves it (it is no longer moved, pulled with or shown here). */
export function takeOwnTornado(id: string): Tornado | null {
  for (const list of byMap.values()) {
    const at = list.findIndex((t) => t.id === id);
    if (at >= 0) return list.splice(at, 1)[0] ?? null;
  }
  return null;
}

/**
 * Cluster mode: a tornado of a block that moved here (or back) is this node's own, to move, pull with and show.
 * MAX_PER_MAP limits only the forming of new ones. As loot.adoptOwn: "mirror", "new", or null when this node has that id.
 */
export function adoptTornado(tornado: Tornado): "mirror" | "new" | null {
  for (const list of byMap.values()) if (list.some((own) => own.id === tornado.id)) return null;
  const known = remoteTornadoes.delete(tornado.id);
  const map = norm(tornado.map);
  const list = byMap.get(map) ?? [];
  list.push({ ...tornado, map });
  byMap.set(map, list);
  return known ? "mirror" : "new";
}

function remoteOn(map: string): Array<{ id: string; x: number; y: number }> {
  const out: Array<{ id: string; x: number; y: number }> = [];
  for (const t of remoteTornadoes.values()) if (t.map === map) out.push({ id: t.id, x: t.x, y: t.y });
  return out;
}

/** Who a tornado may pull and hurt. */
export function affected(who: any): boolean {
  return !!who && !who.isDead && !who.isGhost && !who.isGuest && !who.isStealth && !who.ghostTeleportPending
    && Number.isFinite(Number(who.location?.position?.x)) && Number.isFinite(Number(who.location?.position?.y));
}

/** Starts a tornado anywhere on `map`, which `players` are on. Null when the map's size is not known, or no id could be had. */
export function spawn(map: string, players: any[], kind: "storm" | "tornado", now: number): Tornado | null {
  if (!players.some(affected) || tornadoesOn(map).length >= MAX_PER_MAP) return null;
  const size = bridge?.size(map) ?? null;
  if (!size || size.width <= EDGE * 2 || size.height <= EDGE * 2) return null;
  let id: string;
  try {
    id = `t${nextEntityId()}`;
  } catch (error) {
    logNoIds("tornadoes", `Tornadoes: none formed on ${map}: ${error}`);
    return null;
  }
  const tornado: Tornado = {
    id, map: norm(map),
    x: EDGE + Math.random() * (size.width - EDGE * 2), y: EDGE + Math.random() * (size.height - EDGE * 2),
    heading: Math.random() * Math.PI * 2, speed: between(SPEED), diesAt: now + between(LIFE[kind]),
  };
  const list = byMap.get(tornado.map) ?? [];
  list.push(tornado);
  byMap.set(tornado.map, list);
  log.debug(`A tornado formed on ${tornado.map} at ${Math.round(tornado.x)}, ${Math.round(tornado.y)}`);
  return tornado;
}

/** Moves a tornado on by `dt` seconds, inside the map's `size`: it wanders, and turns back from the edge. */
export function steer(tornado: Tornado, dt: number, size: { width: number; height: number } | null): void {
  tornado.heading += jolt() * 0.5 * Math.sqrt(dt);
  if (size && (tornado.x < EDGE || tornado.y < EDGE || tornado.x > size.width - EDGE || tornado.y > size.height - EDGE)) {
    const home = Math.atan2(size.height / 2 - tornado.y, size.width / 2 - tornado.x);
    const diff = Math.atan2(Math.sin(home - tornado.heading), Math.cos(home - tornado.heading));
    tornado.heading += Math.max(-2 * dt, Math.min(2 * dt, diff));
  }
  tornado.x += Math.cos(tornado.heading) * tornado.speed * dt;
  tornado.y += Math.sin(tornado.heading) * tornado.speed * dt;
  if (size) {
    tornado.x = Math.min(size.width, Math.max(0, tornado.x));
    tornado.y = Math.min(size.height, Math.max(0, tornado.y));
  }
}

/**
 * Where a player at (x, y) is drawn to over `dt` seconds by a tornado at (cx, cy), or null when it is out of reach:
 * in toward it (never past its middle), and round it a little; `inX`, `inY` the same step without the swirl.
 */
export function pullStep(cx: number, cy: number, x: number, y: number, dt: number): { x: number; y: number; inX: number; inY: number } | null {
  const dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy);
  if (d >= PULL_RADIUS || d < 1) return null;
  const strength = PULL_EDGE + (PULL_CORE - PULL_EDGE) * (1 - d / PULL_RADIUS);
  const inward = Math.min(d, strength * dt), around = strength * SWIRL * dt;
  const ux = dx / d, uy = dy / d;
  // round it counterclockwise on the screen, as a tornado of the northern half of the world turns
  return { x: x + ux * inward + uy * around, y: y + uy * inward - ux * around, inX: x + ux * inward, inY: y + uy * inward };
}

async function pullPlayers(map: string, tornadoes: Tornado[], players: any[], dt: number): Promise<void> {
  for (const who of players) {
    if (!affected(who)) continue;
    const id = String(who.id), atX = Number(who.location.position.x), atY = Number(who.location.position.y);
    const kept = exact.get(id);
    // (the part of a px left over last time, unless something else has moved them since)
    let x = kept && kept.atX === atX && kept.atY === atY ? kept.x : atX;
    let y = kept && kept.atX === atX && kept.atY === atY ? kept.y : atY;
    let moved = false;
    for (const tornado of tornadoes) {
      const step = pullStep(tornado.x, tornado.y, x, y, dt);
      if (!step) continue;
      // a step into a wall is not taken; one straight in may still be, when the swirl is what met it
      const free = (px: number, py: number) => who.isNoclip || bridge!.walkable(map, Math.round(px), Math.round(py), who);
      if (free(step.x, step.y)) { x = step.x; y = step.y; moved = true; }
      else if (free(step.inX, step.inY)) { x = step.inX; y = step.inY; moved = true; }
    }
    if (!moved) { exact.delete(id); continue; }
    const nx = Math.round(x), ny = Math.round(y);
    exact.set(id, { x, y, atX: nx, atY: ny });
    if (nx !== atX || ny !== atY) await bridge!.move(who, nx, ny);
  }
}

async function hurtPlayers(tornadoes: Tornado[], players: any[], now: number): Promise<void> {
  for (const who of players) {
    const id = String(who?.id);
    if (!affected(who) || !tornadoes.some((t) => Math.hypot(t.x - who.location.position.x, t.y - who.location.position.y) < HURT_RADIUS)) {
      nextHurt.delete(id);
      continue;
    }
    if (now < (nextHurt.get(id) ?? 0)) continue;
    nextHurt.set(id, now + HURT_EVERY);
    const max = Number(who.stats?.total_max_health ?? who.stats?.max_health) || 0;
    if (max > 0) await bridge!.hurt(who, Math.max(1, Math.floor(max * HURT_SHARE)));
  }
}

/** Moves every tornado, and pulls the players near it: called on every tick of the movement loop (TICK_MS apart). */
export async function pull(now: number = Date.now()): Promise<void> {
  if (!bridge || pulling) return;
  pulling = true;
  try {
    const dt = lastPull ? Math.min(0.1, Math.max(0, (now - lastPull) / 1000)) : TICK_MS / 1000;
    lastPull = now;
    if (dt <= 0) return;
    for (const [map, list] of byMap) {
      if (!list.length) continue;
      const players = bridge.players(map), size = bridge.size(map);
      for (const tornado of list) steer(tornado, dt, size);
      await pullPlayers(map, list, players, dt);
    }
  } catch (error) {
    log.error(`Tornadoes: ${error}`);
  } finally {
    pulling = false;
  }
}

/** One step of every tornado: called every 100 ms. */
export async function tick(now: number = Date.now()): Promise<void> {
  if (!bridge || ticking) return;
  ticking = true;
  try {
    if (now - weathersAt >= 1000) {
      weathersAt = now;
      weathers = new Map((await bridge.weathers()).map((w) => [norm(w.map), w.weather]));
    }

    for (const [map, weather] of weathers) {
      const list = byMap.get(map) ?? [];
      // the storm passed: its tornadoes go
      if (weather === "none") { if (list.length) byMap.set(map, []); continue; }
      if (now - (lastSpawnLook.get(map) ?? -Infinity) < SPAWN_EVERY) continue;
      lastSpawnLook.set(map, now);
      const players = bridge.players(map);
      if (!players.some(affected)) continue;
      const roll = Math.random();
      if (weather === "storm" ? roll < STORM_CHANCE : list.length === 0 || roll < SECOND_CHANCE) {
        spawn(map, players, weather, now);
      }
    }

    for (const [map, list] of byMap) {
      // The dead go from the map's own list, not a copy: a tornado a block move takes (takeOwnTornado) while the
      // harm below awaits is then neither hurt with nor shown again here.
      for (let i = list.length - 1; i >= 0; i--) if (!(list[i]!.diesAt > now)) list.splice(i, 1);
      const alive = list;
      const players = alive.length ? bridge.players(map) : [];
      if (alive.length) await hurtPlayers(alive, players, now);
      const shown = [...alive.map((t) => ({ id: t.id, x: Math.round(t.x), y: Math.round(t.y) })), ...remoteOn(map)];
      if (now - (lastShown.get(map) ?? -Infinity) >= SHOW_EVERY && (shown.length || shownSome.has(map))) {
        lastShown.set(map, now);
        bridge.show(map, shown);
        if (shown.length) shownSome.add(map);
        else shownSome.delete(map);
      }
      if (!alive.length && !shownSome.has(map) && remoteOn(map).length === 0) byMap.delete(map);
    }
  } catch (error) {
    log.error(`Tornadoes: ${error}`);
  } finally {
    ticking = false;
  }
}

/** For tests: forget every tornado. */
export function resetTornadoes(): void {
  byMap.clear();
  remoteTornadoes.clear();
  weathers = new Map();
  weathersAt = -Infinity;
  lastSpawnLook.clear();
  lastShown.clear();
  shownSome.clear();
  shownTo.clear();
  nextHurt.clear();
  exact.clear();
  lastPull = 0;
  pulling = false;
  ticking = false;
}
