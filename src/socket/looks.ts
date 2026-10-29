/**
 * Which sprite looks a client holds, so an animation change can go out as a small pose packet.
 *
 * A look is the set of sheets a player is drawn with: the mount, the body, the head and the worn items' sheets,
 * named as in SPRITE_SHEET_ANIMATION. The client builds a player's layered animation from those names and, for a
 * pose change, only needs the pose name. So a viewer may be sent the pose alone exactly when the last full sheet
 * it was sent for that player has the same look. Anything else (a viewer that was never sent one, an equipment or
 * mount change, a sheet table that was edited) gets the full packet, which also records its look here.
 *
 * The record is a signature of the sheets that were really sent, not a revision counter, so it cannot claim more
 * than the client has: a packet built from older data records the older look and the next pose goes out in full.
 * It is kept per connection, so a new connection starts empty.
 */

/** The sheet fields of a SPRITE_SHEET_ANIMATION packet, in the order they are written. */
export const LOOK_FIELDS = [
  "mountSprite", "bodySprite", "headSprite", "armorHelmetSprite", "armorShoulderguardsSprite", "armorNeckSprite",
  "armorHandsSprite", "armorChestSprite", "armorFeetSprite", "armorLegsSprite", "armorWeaponSprite",
] as const;

/** More subjects than this per connection and the record starts again: the next poses go out in full. */
const MAX_SEEN_PER_CONNECTION = 512;

const seen = new WeakMap<object, Map<string, string>>();
const signatures = new WeakMap<object, string>();

/** The look of a packet's sheets: their names and the urls the client loads them from, in field order. */
export function lookSignature(data: any): string {
  if (data && typeof data === "object") {
    const known = signatures.get(data);
    if (known !== undefined) return known;
  }
  let signature = "";
  for (const field of LOOK_FIELDS) {
    const sheet = data?.[field];
    signature += (sheet?.name ?? "") + "\u0002" + (sheet?.templateUrl ?? "") + "\u0002" + (sheet?.imageUrl ?? "") + "\u0001";
  }
  if (data && typeof data === "object") signatures.set(data, signature);
  return signature;
}

/** The connection was sent the full sheet of `subjectId` with this look. */
export function noteLook(wt: object | null | undefined, subjectId: string, signature: string): void {
  if (!wt || typeof wt !== "object") return;
  let map = seen.get(wt);
  if (!map) seen.set(wt, (map = new Map()));
  else if (map.size >= MAX_SEEN_PER_CONNECTION && !map.has(subjectId)) map.clear();
  map.set(subjectId, signature);
}

/** The connection was sent something for `subjectId` that does not carry a look it can use. */
export function forgetLook(wt: object | null | undefined, subjectId: string): void {
  if (!wt || typeof wt !== "object") return;
  seen.get(wt)?.delete(subjectId);
}

/** True when the pose alone is enough for this connection. */
export function holdsLook(wt: object | null | undefined, subjectId: string, signature: string): boolean {
  if (!wt || typeof wt !== "object") return false;
  return seen.get(wt)?.get(subjectId) === signature;
}
