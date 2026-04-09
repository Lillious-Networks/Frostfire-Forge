import player from "./player";
import log from "../modules/logger";

export const DEFAULT_TILE_SIZE = 32;
export const MAX_ASTAR_ITERATIONS = 5000;
export const MAX_SEARCH_TILES = 500;
export const PATH_RECALC_DISTANCE_TILES = 2;
export const ENTITY_COLLISION_SIZE = 24;

// Helper to get tile size from entity's map
export function getTileSize(entity: any, tileSize?: number): number {
  return tileSize || entity.tileSize || DEFAULT_TILE_SIZE;
}

/**
 * Entity pathfinding state
 */
export interface PathState {
  path: Array<{ x: number; y: number }>;
  pathIndex: number;
  lastPathTargetTile: string | null;
}

/**
 * A* Pathfinding node
 */
interface PathNode {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: PathNode | null;
}

// ----------------------------------------------------------------------
// Priority Queue (Min‑Heap) for A* open list
// ----------------------------------------------------------------------
class PriorityQueue<T> {
  private heap: { node: T; priority: number }[] = [];

  enqueue(node: T, priority: number): void {
    this.heap.push({ node, priority });
    this.siftUp(this.heap.length - 1);
  }

  dequeue(): T | null {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    const bottom = this.heap.pop();
    if (this.heap.length > 0 && bottom) {
      this.heap[0] = bottom;
      this.siftDown(0);
    }
    return top.node;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  private siftUp(idx: number): void {
    const item = this.heap[idx];
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      const parent = this.heap[parentIdx];
      if (item.priority >= parent.priority) break;
      this.heap[idx] = parent;
      idx = parentIdx;
    }
    this.heap[idx] = item;
  }

  private siftDown(idx: number): void {
    const item = this.heap[idx];
    const length = this.heap.length;
    while (true) {
      const leftIdx = (idx << 1) + 1;
      const rightIdx = leftIdx + 1;
      let swapIdx = -1;

      if (leftIdx < length && this.heap[leftIdx].priority < item.priority) {
        swapIdx = leftIdx;
      }
      if (rightIdx < length) {
        if (
          (swapIdx === -1 && this.heap[rightIdx].priority < item.priority) ||
          (swapIdx !== -1 && this.heap[rightIdx].priority < this.heap[leftIdx].priority)
        ) {
          swapIdx = rightIdx;
        }
      }

      if (swapIdx === -1) break;
      this.heap[idx] = this.heap[swapIdx];
      idx = swapIdx;
    }
    this.heap[idx] = item;
  }
}

// ----------------------------------------------------------------------
// Utility functions
// ----------------------------------------------------------------------
export function toTile(x: number, y: number, tileSize: number = DEFAULT_TILE_SIZE): { x: number; y: number } {
  return {
    x: Math.floor(x / tileSize),
    y: Math.floor(y / tileSize),
  };
}

export function tileToCenter(tileX: number, tileY: number, tileSize: number = DEFAULT_TILE_SIZE): { x: number; y: number } {
  return {
    x: tileX * tileSize + tileSize / 2,
    y: tileY * tileSize + tileSize / 2,
  };
}

export function getDistance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

export function clearPathState(pathState: PathState): void {
  pathState.path = [];
  pathState.pathIndex = 0;
  pathState.lastPathTargetTile = null;
}

// ----------------------------------------------------------------------
// Collision and walkability
// ----------------------------------------------------------------------
export async function checkCollision(entity: any, x: number, y: number): Promise<boolean> {
  try {
    const result = await player.checkIfWouldCollide(
      entity.map,
      { x, y, direction: entity.position.direction },
      { width: ENTITY_COLLISION_SIZE, height: ENTITY_COLLISION_SIZE }
    );
    return result.value;
  } catch (error) {
    log.warn(`Collision check failed for entity ${entity.id}: ${error}`);
    return true;
  }
}

/**
 * Line of sight check using DDA algorithm.
 * Only checks obstruction, not facing direction.
 */
export async function hasLineOfSight(
  entity: any,
  targetPos: { x: number; y: number },
  overrideX?: number,
  overrideY?: number,
  maxDistance: number = 300 
): Promise<boolean> {
  const startX = overrideX !== undefined ? overrideX : entity.position.x;
  const startY = overrideY !== undefined ? overrideY : entity.position.y;

  const dx = targetPos.x - startX;
  const dy = targetPos.y - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  
  if (distance > maxDistance) return false;
  if (distance < 1) return true;

  const precision = 2; // Check every 2 pixels
  const steps = Math.ceil(distance / precision);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const checkX = startX + dx * t;
    const checkY = startY + dy * t;

    // Use actual collision to ensure the entire body fits
    if (await checkCollision(entity, checkX, checkY)) {
      return false;
    }
  }

  return true;
}

/**
 * Cached walkability check – reduces redundant collision queries during a single A* call.
 */
async function isTileWalkableCached(
  entity: any,
  tileX: number,
  tileY: number,
  cache: Map<string, boolean>
): Promise<boolean> {
  const key = `${tileX},${tileY}`;
  if (cache.has(key)) return cache.get(key)!;

  // Simple center check - let actual movement collision handling prevent clipping
  const tileSize = getTileSize(entity);
  const center = tileToCenter(tileX, tileY, tileSize);
  const blocked = await checkCollision(entity, center.x, center.y);
  cache.set(key, !blocked);
  return !blocked;
}

// --- PATHFINDING ---

export async function buildAStarPath(
  entity: any,
  targetPos: { x: number; y: number }
): Promise<Array<{ x: number; y: number }>> {
  const tileSize = getTileSize(entity);
  const startTile = toTile(entity.position.x, entity.position.y, tileSize);
  const goalTile = toTile(targetPos.x, targetPos.y, tileSize);

  if (startTile.x === goalTile.x && startTile.y === goalTile.y) return [startTile];

  const heuristic = (dx: number, dy: number): number => {
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    return (adx + ady) + (1.414 - 2) * Math.min(adx, ady);
  };

  const openSet = new PriorityQueue<PathNode>();
  const closedSet = new Set<string>();
  const nodeMap = new Map<string, PathNode>();
  const walkableCache = new Map<string, boolean>();

  const startNode: PathNode = {
    x: startTile.x, y: startTile.y, g: 0, 
    h: heuristic(startTile.x - goalTile.x, startTile.y - goalTile.y), 
    f: 0, parent: null 
  };
  startNode.f = startNode.h;
  openSet.enqueue(startNode, startNode.f);
  nodeMap.set(`${startTile.x},${startTile.y}`, startNode);

  let bestNode = startNode;
  let iterations = 0;

  while (!openSet.isEmpty() && iterations < MAX_ASTAR_ITERATIONS) {
    iterations++;
    const current = openSet.dequeue()!;
    const key = `${current.x},${current.y}`;

    if (closedSet.has(key)) continue;
    closedSet.add(key);

    if (current.x === goalTile.x && current.y === goalTile.y) {
      bestNode = current;
      break;
    }

    const neighbors = [
      { x: 1, y: 0, cost: 1 }, { x: -1, y: 0, cost: 1 },
      { x: 0, y: 1, cost: 1 }, { x: 0, y: -1, cost: 1 },
      { x: 1, y: 1, cost: 1.414 }, { x: 1, y: -1, cost: 1.414 },
      { x: -1, y: 1, cost: 1.414 }, { x: -1, y: -1, cost: 1.414 }
    ];

    for (const offset of neighbors) {
      const nx = current.x + offset.x;
      const ny = current.y + offset.y;
      const nKey = `${nx},${ny}`;

      if (closedSet.has(nKey) || !(await isTileWalkableCached(entity, nx, ny, walkableCache))) continue;

      // Symmetrical Corner-Cutting prevention
      if (offset.x !== 0 && offset.y !== 0) {
        const s1 = await isTileWalkableCached(entity, current.x + offset.x, current.y, walkableCache);
        const s2 = await isTileWalkableCached(entity, current.x, current.y + offset.y, walkableCache);
        if (!s1 || !s2) continue;
      }

      // Penalty to keep the path away from red tiles
      let penalty = 0;
      for (let x = -1; x <= 1; x++) {
        for (let y = -1; y <= 1; y++) {
          if (!(await isTileWalkableCached(entity, nx + x, ny + y, walkableCache))) penalty += 5;
        }
      }

      const g = current.g + offset.cost + penalty;
      const h = heuristic(nx - goalTile.x, ny - goalTile.y);
      const f = g + h;

      const existing = nodeMap.get(nKey);
      if (existing && g >= existing.g) continue;

      const node: PathNode = { x: nx, y: ny, g, h, f, parent: current };
      nodeMap.set(nKey, node);
      openSet.enqueue(node, f);
    }
  }

  const path: Array<{ x: number; y: number }> = [];
  let curr: PathNode | null = bestNode;
  while (curr) {
    path.unshift({ x: curr.x, y: curr.y });
    curr = curr.parent;
  }

  // SMOOTHING: Limited to a Vision Radius of 5 tiles
  if (path.length <= 2) return path;
  const smoothed = [path[0]];
  let head = 0;
  const VISION_RADIUS = tileSize * 5;

  while (head < path.length - 1) {
    let furthestVisible = head + 1;
    for (let i = path.length - 1; i > head + 1; i--) {
      const p1 = tileToCenter(path[head].x, path[head].y, tileSize);
      const p2 = tileToCenter(path[i].x, path[i].y, tileSize);
      
      if (getDistance(p1.x, p1.y, p2.x, p2.y) > VISION_RADIUS) continue;

      const safetyBox = { ...entity, width: entity.width + 4, height: entity.height + 4 };
      if (await hasLineOfSight(safetyBox, p2, p1.x, p1.y, VISION_RADIUS)) {
        furthestVisible = i;
        break;
      }
    }
    smoothed.push(path[furthestVisible]);
    head = furthestVisible;
  }

  return smoothed;
}

// --- MOVEMENT ---

export async function getNextPathStep(
  entity: any,
  targetPos: { x: number; y: number },
  moveSpeed: number,
  pathState: PathState,
  attackRange: number
): Promise<{ x: number; y: number } | null> {
  const tileSize = getTileSize(entity);
  const targetTile = toTile(targetPos.x, targetPos.y, tileSize);
  const targetKey = `${targetTile.x},${targetTile.y}`;

  if (pathState.path.length === 0) {
    // Build initial path
    pathState.path = await buildAStarPath(entity, targetPos);
    pathState.pathIndex = 1;
    pathState.lastPathTargetTile = targetKey;
  } else if (pathState.lastPathTargetTile !== targetKey) {
    // Target moved to a different tile - only recalculate from current waypoint to new target
    if (pathState.pathIndex < pathState.path.length) {
      const currentWaypoint = pathState.path[pathState.pathIndex];
      const fromPos = tileToCenter(currentWaypoint.x, currentWaypoint.y, tileSize);
      // Build path from current waypoint to new target using the same entity
      const fakeEntity = {
        map: entity.map,
        position: { ...fromPos, direction: entity.position.direction },
        id: entity.id
      };
      const newPathSegment = await buildAStarPath(fakeEntity, targetPos);
      if (newPathSegment.length > 0) {
        // Keep the old path up to current index, replace the rest with new segment
        pathState.path = pathState.path.slice(0, pathState.pathIndex).concat(newPathSegment);
      }
    }
    pathState.lastPathTargetTile = targetKey;
  }

  const distToPlayer = getDistance(entity.position.x, entity.position.y, targetPos.x, targetPos.y);

  // If path is exhausted, but we aren't in range, keep chasing directly
  if (pathState.pathIndex >= pathState.path.length) {
    if (distToPlayer > attackRange - 2) {
        const hasLOS = await hasLineOfSight(entity, targetPos);
        if (hasLOS) {
            const angle = Math.atan2(targetPos.y - entity.position.y, targetPos.x - entity.position.x);
            return {
                x: entity.position.x + Math.cos(angle) * moveSpeed,
                y: entity.position.y + Math.sin(angle) * moveSpeed
            };
        }
    }
    return null;
  }

  const wp = pathState.path[pathState.pathIndex];
  const center = tileToCenter(wp.x, wp.y, tileSize);
  const distToWP = getDistance(entity.position.x, entity.position.y, center.x, center.y);

  if (distToWP < Math.max(moveSpeed, 2)) {
    pathState.pathIndex++;
    return getNextPathStep(entity, targetPos, moveSpeed, pathState, attackRange);
  }

  const deltaX = center.x - entity.position.x;
  const deltaY = center.y - entity.position.y;

  // Use smooth interpolation capped at moveSpeed (like players do)
  const step = Math.min(moveSpeed, distToWP);
  const nextX = entity.position.x + (deltaX / distToWP) * step;
  const nextY = entity.position.y + (deltaY / distToWP) * step;

  if (await checkCollision(entity, nextX, nextY)) {
    pathState.path = []; // Reset and retry
    return null;
  }

  return { x: nextX, y: nextY };
}

/**
 * Path smoothing – removes redundant intermediate waypoints where direct line‑of‑sight exists.
 */
export async function smoothPath(
  entity: any,
  rawPath: Array<{ x: number; y: number }>
): Promise<Array<{ x: number; y: number }>> {
  if (rawPath.length <= 2) return rawPath;

  const tileSize = getTileSize(entity);
  const smoothed: Array<{ x: number; y: number }> = [rawPath[0]];
  let currentIdx = 0;

  while (currentIdx < rawPath.length - 1) {
    let furthestVisible = currentIdx + 1;
    // Look ahead from the end backwards to find the furthest visible tile
    for (let i = rawPath.length - 1; i > currentIdx; i--) {
      const from = tileToCenter(rawPath[currentIdx].x, rawPath[currentIdx].y, tileSize);
      const to = tileToCenter(rawPath[i].x, rawPath[i].y, tileSize);
      if (await hasLineOfSight({ ...entity, position: { x: from.x, y: from.y } }, to)) {
        furthestVisible = i;
        break;
      }
    }
    smoothed.push(rawPath[furthestVisible]);
    currentIdx = furthestVisible;
  }

  return smoothed;
}

// ----------------------------------------------------------------------
// Path following and steering
// ----------------------------------------------------------------------

export async function steerTowards(
  entity: any,
  targetPos: { x: number; y: number },
  moveSpeed: number,
  pathState: PathState,
  attackRange: number
): Promise<{ x: number; y: number } | null> {
  const currentX = entity.position.x;
  const currentY = entity.position.y;
  const dx = targetPos.x - currentX;
  const dy = targetPos.y - currentY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < 1) return null;

  // 1. Only try direct movement if we have no path yet (initial aggro)
  if (pathState.path.length === 0) {
    // Check if we have line of sight to target
    const hasDirectLOS = await hasLineOfSight(entity, targetPos);

    // If we have LOS, try direct movement
    if (hasDirectLOS) {
      const dirX = (dx / distance) * moveSpeed;
      const dirY = (dy / distance) * moveSpeed;
      const directX = currentX + dirX;
      const directY = currentY + dirY;

      if (!(await checkCollision(entity, directX, directY))) {
        return { x: directX, y: directY };
      }
      // Direct movement failed - switch to pathfinding
    }
  }

  // 2. Use A* pathfinding if no direct LOS or direct movement failed
  const pathStep = await getNextPathStep(entity, targetPos, moveSpeed, pathState, attackRange);
  if (pathStep) {
    return pathStep;
  }

  // 3. If A* pathfinding fails, give up
  return null;
}