// Shared by the gathering tests: a grid of 32 px tiles and a random that repeats. Not a test file itself.
import type { GatherGrid, Rng } from "../systems/gathering/types";

/** Every tile walkable except those in `blocked` ("tx,ty"). */
export function openGrid(blocked: Set<string> = new Set(), tile = 32): GatherGrid {
  return {
    tileOf: (p) => ({ tx: Math.floor(p.x / tile), ty: Math.floor(p.y / tile) }),
    anchorOfTile: (tx, ty) => ({ x: tx * tile + tile / 2, y: ty * tile + tile / 2 }),
    isWalkable: (x, y) => !blocked.has(`${Math.floor(x / tile)},${Math.floor(y / tile)}`),
  };
}

/** No tile walkable. */
export function closedGrid(): GatherGrid {
  return { ...openGrid(), isWalkable: () => false };
}

/** The same numbers in [0, 1) every run (Park-Miller). */
export function seeded(seed = 1): Rng {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}
