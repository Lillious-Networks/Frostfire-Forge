import {
  IDLE_PATH_MAX_NODES,
  WANDER_WAIT_MAX_MS,
  WANDER_WAIT_MIN_MS,
  randInt,
  speedPxPerSec,
  yards,
  type Rng,
} from "./constants";
import { advance, setDestination } from "./movement";
import type { NavGrid } from "./navgrid";
import { AIState, type CreatureInstance, type CreaturePatrolPath, type CreatureSpawn, type CreatureTemplate } from "./types";

export interface AIContext {
  now: number;
  dtMs: number;
  grid: NavGrid | undefined;
  template: CreatureTemplate;
  spawn: CreatureSpawn | undefined;
  patrol: CreaturePatrolPath | undefined;
  rng: Rng;
  place(creature: CreatureInstance, x: number, y: number): void;
}

const AT_POINT_PX = 2;

/** One AI step. Phase 2 covers out-of-combat behaviour: idle, wander, patrol. */
export function tickCreature(creature: CreatureInstance, ctx: AIContext): void {
  if (creature.state === AIState.DEAD) return;
  const grid = ctx.grid;
  if (!grid) return;

  const movementType = ctx.spawn?.movement_type ?? "idle";
  if (movementType === "patrol" && ctx.patrol && ctx.patrol.points.length > 0) {
    tickPatrol(creature, grid, ctx, ctx.patrol);
  } else if (movementType === "wander" && (ctx.spawn?.wander_radius ?? 0) > 0) {
    tickWander(creature, grid, ctx);
  } else {
    tickIdle(creature, grid, ctx);
  }
}

function place(ctx: AIContext, creature: CreatureInstance) {
  return (x: number, y: number) => ctx.place(creature, x, y);
}

function walkSpeed(ctx: AIContext): number {
  return speedPxPerSec(ctx.template.move_speed_walk);
}

/** Stationary creatures walk back to their spawn point if displaced. */
function tickIdle(creature: CreatureInstance, grid: NavGrid, ctx: AIContext): void {
  creature.state = AIState.IDLE;
  if (creature.move) {
    const result = advance(creature, grid, ctx.dtMs, place(ctx, creature));
    if (result === "arrived" && ctx.spawn) creature.dir = ctx.spawn.direction;
    return;
  }
  if (ctx.now < creature.waitUntil) return;
  if (Math.hypot(creature.x - creature.homeX, creature.y - creature.homeY) <= AT_POINT_PX) return;
  if (!setDestination(creature, grid, { x: creature.homeX, y: creature.homeY }, walkSpeed(ctx), IDLE_PATH_MAX_NODES)) {
    creature.waitUntil = ctx.now + 5000;
  }
}

function tickWander(creature: CreatureInstance, grid: NavGrid, ctx: AIContext): void {
  creature.state = AIState.WANDER;
  if (creature.move) {
    const result = advance(creature, grid, ctx.dtMs, place(ctx, creature));
    if (result === "arrived" || result === "stuck") {
      creature.waitUntil = ctx.now + randInt(WANDER_WAIT_MIN_MS, WANDER_WAIT_MAX_MS, ctx.rng);
    }
    return;
  }
  if (ctx.now < creature.waitUntil) return;

  const radius = yards(ctx.spawn!.wander_radius);
  const point = grid.randomPointNear({ x: creature.homeX, y: creature.homeY }, radius, ctx.rng);
  if (!point || !setDestination(creature, grid, point, walkSpeed(ctx), IDLE_PATH_MAX_NODES)) {
    creature.waitUntil = ctx.now + randInt(WANDER_WAIT_MIN_MS, WANDER_WAIT_MAX_MS, ctx.rng);
  }
}

function tickPatrol(creature: CreatureInstance, grid: NavGrid, ctx: AIContext, patrol: CreaturePatrolPath): void {
  creature.state = AIState.PATROL;
  const points = patrol.points;
  if (creature.patrolIndex >= points.length) creature.patrolIndex = 0;

  if (creature.move) {
    const result = advance(creature, grid, ctx.dtMs, place(ctx, creature));
    if (result === "arrived") {
      creature.waitUntil = ctx.now + points[creature.patrolIndex].wait_ms;
      advancePatrolIndex(creature, patrol);
    } else if (result === "stuck") {
      creature.waitUntil = ctx.now + 1000;
    }
    return;
  }
  if (ctx.now < creature.waitUntil) return;

  // Skip points we are already standing on, and unreachable ones (try each once).
  for (let attempts = 0; attempts < points.length; attempts++) {
    const target = points[creature.patrolIndex];
    if (Math.hypot(target.x - creature.x, target.y - creature.y) <= AT_POINT_PX) {
      creature.waitUntil = ctx.now + target.wait_ms;
      advancePatrolIndex(creature, patrol);
      return;
    }
    if (setDestination(creature, grid, target, walkSpeed(ctx), IDLE_PATH_MAX_NODES)) return;
    advancePatrolIndex(creature, patrol);
  }
  creature.waitUntil = ctx.now + 5000;
}

/** Loop paths wrap; open paths walk back and forth. */
export function advancePatrolIndex(creature: CreatureInstance, patrol: CreaturePatrolPath): void {
  const n = patrol.points.length;
  if (n <= 1) {
    creature.patrolIndex = 0;
    return;
  }
  if (patrol.loop) {
    creature.patrolIndex = (creature.patrolIndex + 1) % n;
    return;
  }
  let next = creature.patrolIndex + (creature.patrolForward ? 1 : -1);
  if (next >= n) {
    creature.patrolForward = false;
    next = n - 2;
  } else if (next < 0) {
    creature.patrolForward = true;
    next = 1;
  }
  creature.patrolIndex = next;
}
