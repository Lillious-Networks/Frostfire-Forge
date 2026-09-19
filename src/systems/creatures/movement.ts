import type { NavGrid, Point } from "./navgrid";
import type { CreatureInstance } from "./types";

export type MoveResult = "idle" | "moving" | "arrived" | "stuck";

/** Ticks without progress before a path is abandoned. */
const STUCK_TICKS = 3;
const ARRIVE_EPSILON = 0.5;

/** 8-way facing using the same names as player directions. */
export function directionFor(dx: number, dy: number, fallback: string): string {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return fallback;
  const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  switch ((sector + 8) % 8) {
    case 0: return "right";
    case 1: return "downright";
    case 2: return "down";
    case 3: return "downleft";
    case 4: return "left";
    case 5: return "upleft";
    case 6: return "up";
    default: return "upright";
  }
}

/** Plan a path to `target`. Returns false (and leaves the creature still) if unreachable. */
export function setDestination(
  creature: CreatureInstance,
  grid: NavGrid,
  target: Point,
  speedPxPerSec: number,
  maxNodes?: number
): boolean {
  const path = grid.findPath({ x: creature.x, y: creature.y }, target, maxNodes);
  if (!path || path.length === 0) {
    creature.move = null;
    return false;
  }
  creature.move = { path, index: 0, speed: speedPxPerSec, stuckTicks: 0 };
  return true;
}

export function stop(creature: CreatureInstance): void {
  creature.move = null;
}

/**
 * Advance along the current path by speed * dt, sliding on walls. `place` is
 * called with the final position so the registry can re-bucket the creature.
 */
export function advance(
  creature: CreatureInstance,
  grid: NavGrid,
  dtMs: number,
  place: (x: number, y: number) => void
): MoveResult {
  const move = creature.move;
  if (!move) return "idle";

  let budget = (move.speed * dtMs) / 1000;
  let pos: Point = { x: creature.x, y: creature.y };
  let dir = creature.dir;

  while (budget > 0 && move.index < move.path.length) {
    const target = move.path[move.index];
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= ARRIVE_EPSILON) {
      move.index++;
      continue;
    }
    const t = Math.min(1, budget / dist);
    const next = grid.step(pos, dx * t, dy * t);
    const travelled = Math.hypot(next.x - pos.x, next.y - pos.y);
    if (travelled < 0.01) break;
    dir = directionFor(next.x - pos.x, next.y - pos.y, dir);
    pos = next;
    budget -= travelled;
    if (t >= 1 && Math.hypot(target.x - pos.x, target.y - pos.y) <= ARRIVE_EPSILON) {
      move.index++;
    } else if (travelled < dist * t - 0.01) {
      // Slid along a wall; stop spending budget this tick and re-evaluate next tick.
      break;
    }
  }

  const progressed = pos.x !== creature.x || pos.y !== creature.y;
  creature.dir = dir;
  if (progressed) place(pos.x, pos.y);

  if (move.index >= move.path.length) {
    creature.move = null;
    return "arrived";
  }
  if (!progressed) {
    move.stuckTicks++;
    if (move.stuckTicks >= STUCK_TICKS) {
      creature.move = null;
      return "stuck";
    }
  } else {
    move.stuckTicks = 0;
  }
  return "moving";
}
