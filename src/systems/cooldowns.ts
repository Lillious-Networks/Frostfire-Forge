// Every cooldown a player is waiting on, ended at once: what the /cooldowns
// admin command does.
//
// A player's cooldowns are kept by what they are on: spells and the lockout
// after an interrupt by the cooldown manager (and on the player the server
// holds), the one consumables share by systems/consumables, and the home
// item's hour by systems/homes, in the database.

import cooldownManager from "../services/cooldownmanager";
import consumables from "./consumables";
import homes from "./homes";

/**
 * Ends every cooldown of a player. `player` is the one the server holds: what it carries of its
 * spell cooldowns is cleared with the rest. Throws when the home item's hour could not be written;
 * the others, which are held in memory, are reset all the same.
 */
export async function resetCooldowns(player: { username: string; spellCooldowns?: Record<string, number>; spellLockoutUntil?: number }): Promise<void> {
  const username = String(player.username).toLowerCase();
  // Kept under the name the player carries.
  cooldownManager.removePlayer(player.username);
  cooldownManager.removePlayer(username);
  player.spellCooldowns = {};
  player.spellLockoutUntil = 0;
  consumables.clearCooldown(username);
  await homes.clearCooldown(username);
}
