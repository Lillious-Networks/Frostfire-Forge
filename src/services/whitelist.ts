// The realm whitelist: whether it is on, and the usernames it lets in.
//
// WHITELIST in the environment says how the server starts. An admin can switch
// it while the server runs (/whitelist on|off, or the control panel); that
// lasts until the server stops, and the environment decides again at the next
// start.
//
// The usernames are read from the database when the whitelist is turned on,
// never at a login: a login reads the set held here.

import query from "../controllers/sqldatabase";
import log from "../modules/logger";

/** Lower case usernames. Filled by loadRealmWhitelist; /whitelist add and remove keep it in step with the database. */
export const realmWhitelist = new Set<string>();

let enabled = process.env.WHITELIST === "true";
const listeners: Array<(enabled: boolean) => void> = [];

const realm = (): string => process.env.SERVER_ID || "default";

const UNTIL_RESTART = "This lasts until the server restarts: the WHITELIST setting decides how it starts.";

/** Whether logins are checked against the whitelist right now. */
export function isWhitelistEnabled(): boolean {
  return enabled;
}

/** `listener` is called with the new state each time the whitelist is switched. */
export function onWhitelistSwitch(listener: (enabled: boolean) => void): void {
  listeners.push(listener);
}

/**
 * Reads this realm's usernames from the database, in place of the ones held.
 * Resolves with how many there are; if the database fails, so does this, and
 * the ones held are left as they were.
 */
export async function loadRealmWhitelist(): Promise<number> {
  const rows = (await query("SELECT username FROM whitelist WHERE realm = ?", [realm()])) as Array<{ username: string }>;
  realmWhitelist.clear();
  for (const row of rows) realmWhitelist.add(String(row.username).toLowerCase());
  return realmWhitelist.size;
}

let turn: Promise<unknown> = Promise.resolve();

/**
 * Turns the whitelist on or off for as long as the server runs. Turning it on
 * reads the usernames from the database first and puts `by` (the admin asking)
 * on the list if they are not on it, so whoever turns it on can log back in.
 * Players already online are left alone: only logins from then on are checked.
 */
export function setWhitelistEnabled(wanted: boolean, by?: string): Promise<{ success: boolean; message: string }> {
  // One switch at a time: the list is read between being asked and enforcing it.
  const mine = turn.then(() => switchTo(wanted, by));
  turn = mine.catch(() => {});
  return mine;
}

async function switchTo(wanted: boolean, by?: string): Promise<{ success: boolean; message: string }> {
  if (wanted === enabled) return { success: false, message: `Whitelist is already ${wanted ? "on" : "off"}` };

  const admin = String(by ?? "").toLowerCase().trim();
  let added = false;
  if (wanted) {
    try {
      await loadRealmWhitelist();
      if (admin && !realmWhitelist.has(admin)) {
        await query("INSERT INTO whitelist (realm, username) VALUES (?, ?)", [realm(), admin]);
        realmWhitelist.add(admin);
        added = true;
      }
    } catch (error) {
      log.error(`Failed to turn the whitelist on: ${error}`);
      return { success: false, message: "The whitelist could not be read from the database, so it was left off" };
    }
  }

  enabled = wanted;
  log.info(`[Whitelist] Turned ${wanted ? "on" : "off"}${admin ? ` by ${admin}` : ""}`);
  for (const listener of listeners) {
    try {
      listener(enabled);
    } catch (error) {
      log.error(`Whitelist switch listener failed: ${error}`);
    }
  }

  if (!wanted) return { success: true, message: `Whitelist is off: anyone can log in. ${UNTIL_RESTART}` };
  const names = `${realmWhitelist.size} ${realmWhitelist.size === 1 ? "name" : "names"}`;
  return {
    success: true,
    message: `Whitelist is on with ${names}${added ? " (you were added)" : ""}. Players already online stay, new logins are checked. ${UNTIL_RESTART}`,
  };
}
