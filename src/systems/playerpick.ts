// Which player a click lands on. The client draws characters back to front -
// whoever stands further south covers those behind, and the viewer's own
// character is on top of anyone on the very same line - so a click on
// overlapping players takes the one drawn on top.

// The visible character inside a player's 64px frame, in pixels from the
// anchor: measured on the default body and head sheets with their animation
// offsets, on foot (head top to feet). The client uses the same box for its
// own picks (Gateway js/core/depthorder.ts).
const BODY = { halfWidth: 12, up: 18, down: 21 };

type Placed = { id: string; location: { position: { x: number; y: number } } };

/**
 * The player a click at (x, y) selects, or null: of those within `range` of
 * it, the one drawn on top among the players whose body is under the point,
 * or the nearest when it misses every body.
 */
export function pickPlayerAt<T extends Placed>(players: T[], x: number, y: number, range: number, viewerId: string): T | null {
  let top: T | null = null;
  let topY = -Infinity;
  let topDistSq = Infinity;
  let nearest: T | null = null;
  let nearestDistSq = Infinity;
  for (const p of players) {
    const px = Number(p.location.position.x);
    const py = Number(p.location.position.y);
    const dx = px - x;
    const dy = py - y;
    if (!(Math.abs(dx) < range && Math.abs(dy) < range)) continue;
    const distSq = dx * dx + dy * dy;
    if (distSq < nearestDistSq) {
      nearest = p;
      nearestDistSq = distSq;
    }
    if (Math.abs(dx) > BODY.halfWidth || dy > BODY.up || dy < -BODY.down) continue;
    // In front: further south, else the viewer's own, else nearer the click
    // (the server cannot see which of two others a client drew last).
    const row = Math.round(py);
    const inFront = row !== topY ? row > topY
      : p.id === viewerId ? true
      : top?.id === viewerId ? false
      : distSq < topDistSq;
    if (!top || inFront) {
      top = p;
      topY = row;
      topDistSq = distSq;
    }
  }
  return top ?? nearest;
}
