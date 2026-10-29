import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import type { PlayerDirectory } from "./directory";

// One writer per player (spec §7). The directory epoch a node claimed a player under is also the player's owner
// epoch in the database: the claim raises accounts.owner_epoch to it (never lowers it), and every save of the player
// in cluster mode is `... WHERE username = ? AND owner_epoch = ?` (player.saveFenced). A node that lost the player
// (a handoff, a newer login, its blocks given away while it stalled) holds an older epoch, so its saves change
// nothing. This replaces the session-stolen check for players whose epoch is held.
//
// The directory's counters live in Redis. A Redis that lost them hands out low epochs again, below what the database
// holds: a claim refused that way is lifted (the counter is raised past the stored epoch) when the directory still
// names this node and this session for the player. A claim refused for any other reason means another node owns the
// player now: this session ends.

const changed = (response: any) => !(response && typeof response === "object" && "affectedRows" in response && Number(response.affectedRows ?? response.count) === 0);

/** Raises the account's owner epoch to `epoch`. False when it holds a higher one (or the account is gone). */
export async function claimOwnerEpoch(username: string, epoch: number): Promise<boolean> {
  const name = username.toLowerCase();
  const response = await query("UPDATE accounts SET owner_epoch = ? WHERE username = ? AND owner_epoch < ?", [epoch, name, epoch]);
  if (changed(response)) return true;
  // The same epoch claimed again (a re-run of the same claim) changes no row, and is still this claim's.
  return (await storedOwnerEpoch(name)) === epoch;
}

/** The account's owner epoch; null for no account. */
export async function storedOwnerEpoch(username: string): Promise<number | null> {
  const rows = (await query("SELECT owner_epoch, saved_at FROM accounts WHERE username = ?", [username.toLowerCase()])) as any[];
  return rows?.[0] ? Number(rows[0].owner_epoch) || 0 : null;
}

export interface OwnerEpochDeps {
  directory: Pick<PlayerDirectory, "get" | "lift" | "release" | "nodeId">;
  /**
   * Ends this player's session here: closes only `player`'s own connection and cleans up that row, as the SAVE loop's
   * owner-epoch refusal does. Never player.kick by username: that logs out whichever session the name has here now,
   * which may be a newer one.
   */
  kick(player: any, why: string): void;
}

/**
 * Takes the owner epoch for a player who just logged in here under directory epoch `epoch`. Sets player.ownerEpoch
 * and answers it (a lifted epoch is higher than the one given); null when it was not taken, and the player is kicked.
 * A guest has no rows to fence: null, and nothing is asked.
 */
export async function adoptOwnerEpoch(player: any, epoch: number, deps: OwnerEpochDeps): Promise<number | null> {
  const username = String(player?.username ?? "");
  if (!username || player?.isGuest) return null;
  if (await claimOwnerEpoch(username, epoch)) {
    player.ownerEpoch = epoch;
    return epoch;
  }
  const entry = await deps.directory.get(username);
  const ours = !!entry && entry.nodeId === deps.directory.nodeId && entry.epoch === epoch && entry.playerId === String(player.id);
  if (ours) {
    const floor = (await storedOwnerEpoch(username)) ?? 0;
    const lifted = await deps.directory.lift(username, floor, entry!);
    if (lifted !== null && lifted > floor && (await claimOwnerEpoch(username, lifted))) {
      log.warn(`Owner epoch of ${username} lifted from ${epoch} to ${lifted}: the directory counter was behind the database`);
      player.ownerEpoch = lifted;
      return lifted;
    }
    // The entry was lifted but the database went higher meanwhile: the lifted entry names this node, and presence
    // releases only the claimed epoch, so it is released here before the kick.
    if (lifted !== null) {
      await deps.directory.release(username, lifted)
        .catch((error) => log.error(`Directory release of ${username} at lifted epoch ${lifted} failed: ${error}`));
    }
  }
  log.warn(`Owner epoch ${epoch} of ${username} was refused: another node owns the player, so this session ends`);
  deps.kick(player, "owner");
  return null;
}

/** A cluster save of this player goes through player.saveFenced: its owner epoch is held. */
export function fencedSaves(player: any): boolean {
  return typeof player?.ownerEpoch === "number" && player.ownerEpoch > 0;
}
