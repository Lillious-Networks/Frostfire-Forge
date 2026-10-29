import log from "../modules/logger";
import { chooseNewer, type SavedSnapshot } from "./snapshots";

// A login from the database after a crash (spec §7). The node that held the player saved them on its save interval
// and wrote a snapshot every 5 s (snapshots.ts); a crash loses what happened since the last save. The login reads
// the account's save stamp and the snapshot, and plays from the snapshot when chooseNewer picks it: newer than the
// last fenced save, and from the owner epoch the database holds or a later one.
//
// The stamp is read before this login claims the owner epoch (the claim runs when the player is cached, presence.ts),
// so it is the stamp of the node that held the player. The caller makes sure of the order (socket/receiver.ts).
//
// A snapshot at 0 health moves the player and leaves the row's stats: the player died after the last save, the death
// was not saved, and a living player at 0 health is worse than one at the saved health. A snapshot on a map this
// node does not have is not used. Nothing here is an item.
//
// Recovery never raises a stat above the row. The row's max_health and max_stamina are kept: a level-up or an admin
// edit writes them straight to the row without moving saved_at, so they may be newer than the snapshot. Health and
// stamina are held to the smaller of the snapshot's and the row's maximums. A snapshot whose maximums are 0 or less is
// corrupt and not used at all.
//
// The same gap holds for the location: a warp or a revive that writes the row's map and position straight after the
// snapshot does not move saved_at either, so recovery may put the player back at the snapshot's point (at most one
// snapshot interval earlier). Dead rows are not recovered at all (the caller skips them).

/** How long the reads may take before the login goes on from the row: a stalled store never holds a login. */
export const RECOVERY_READ_MS = 1_000;

export interface RecoveryDeps {
  stamp(username: string): Promise<{ ownerEpoch: number; savedAt: number } | null>;
  snapshot(username: string): Promise<SavedSnapshot | null>;
  /** Whether this node has the map (bare name). */
  knownMap(map: string): boolean;
  /** The bound on the snapshot read: RECOVERY_READ_MS unless a test sets it. */
  readMs?: number;
}

const clamp = (value: number, most: number) => Math.max(0, Math.min(value, most));
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** The snapshot read, or "late" when it takes longer than `ms`. A late answer is dropped (the race handles a late rejection). */
function bounded(read: Promise<SavedSnapshot | null>, ms: number): Promise<SavedSnapshot | null | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
    (timer as any)?.unref?.();
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/** Plays the login from the snapshot when it is newer than the last save: sets location and stats. Answers the snapshot used, or null. Never throws. */
export async function recoverLogin(playerData: any, deps: RecoveryDeps): Promise<SavedSnapshot | null> {
  const username = typeof playerData?.username === "string" ? playerData.username : "";
  if (!username) return null;
  let stamp: { ownerEpoch: number; savedAt: number } | null;
  let read: SavedSnapshot | null | "late";
  try {
    [stamp, read] = await Promise.all([deps.stamp(username), bounded(deps.snapshot(username), deps.readMs ?? RECOVERY_READ_MS)]);
  } catch (error) {
    log.error(`Login of ${username}: the snapshot could not be read, so the saved row is used: ${error}`);
    return null;
  }
  if (read === "late") {
    log.warn(`Login of ${username}: the snapshot was not read within ${deps.readMs ?? RECOVERY_READ_MS} ms, so the saved row is used`);
    return null;
  }
  const chosen = chooseNewer(stamp, read);
  if (!chosen) return null;
  if (chosen.username !== username.toLowerCase()) return null;
  if (!deps.knownMap(chosen.map)) {
    log.warn(`Login of ${username}: the snapshot is on ${chosen.map}, which this node does not have, so the saved row is used`);
    return null;
  }
  const stats = chosen.stats;
  if (stats && (!positive(stats.max_health) || !positive(stats.max_stamina))) {
    log.warn(`Login of ${username}: the snapshot has a maximum of 0 or less, so it is not used and the saved row is`);
    return null;
  }
  playerData.location = { map: chosen.map, position: { x: chosen.x, y: chosen.y, direction: chosen.direction } };
  const row = playerData.stats;
  const rowMaxHealth = Number(row?.max_health);
  const rowMaxStamina = Number(row?.max_stamina);
  // A row with no stats (or no maximums) has NaN here and keeps what it has.
  if (stats && stats.health > 0 && positive(rowMaxHealth) && positive(rowMaxStamina)) {
    // The row's maximums stay: they are never older than the snapshot's.
    row.health = clamp(stats.health, Math.min(stats.max_health, rowMaxHealth));
    row.stamina = clamp(stats.stamina, Math.min(stats.max_stamina, rowMaxStamina));
  }
  log.info(`Login of ${username} plays from the snapshot of epoch ${chosen.epoch} at ${chosen.at}, newer than the last save at ${stamp!.savedAt}`);
  return chosen;
}
