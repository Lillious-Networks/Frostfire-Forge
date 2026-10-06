import query from "../controllers/sqldatabase";
import { rowCache, turns } from "../services/datacache";
import player from "./player";

/** The most players one player ignores. */
export const IGNORE_LIMIT = 100;

/** What became of asking to ignore someone. "staff": the one asking is an admin. "admin": the one named is. */
export type IgnoreResult = "added" | "already" | "self" | "unknown" | "full" | "staff" | "admin";

// The names each player ignores, in the order they were added. A line of chat
// asks this of everyone it would go to, and is answered from these rows: a
// change below is written to the database and then to them.
const rows = rowCache<string[]>("ignores", async (username) =>
  ((await query("SELECT ignored FROM ignores WHERE username = ?", [username])) as { ignored: string }[] || []).map((row) => lower(row.ignored))
, { perPlayer: true });

// One change to a player's list at a time: each works from the list held and
// puts back what its statement left, so two side by side would each put back
// a list without the other's name.
const oneAtATime = turns();

const lower = (username: string) => String(username ?? "").toLowerCase();

/**
 * A change to a player's list, in its turn. When its statement fails the list
 * held is forgotten and the next read asks the database: a statement that
 * timed out may still have been written.
 */
function change<T>(username: string, work: (held: string[]) => Promise<T>): Promise<T> {
  return oneAtATime(username, async () => {
    try {
      return await work((await rows.get(username)) ?? []);
    } catch (error) {
      await rows.drop(username);
      throw error;
    }
  });
}

const ignores = {
  /** The names a player ignores. */
  async list(username: string): Promise<string[]> {
    const name = lower(username);
    return name ? (await rows.get(name)) ?? [] : [];
  },
  /** Whether `other` is on a player's list. Whether that holds anything back is `blocks`. */
  async isIgnoring(username: string, other: string): Promise<boolean> {
    return (await ignores.list(username)).includes(lower(other));
  },
  /**
   * Whether what `sender` sends is held back from `recipient`: the recipient ignores them, and
   * neither is an admin. An admin is always heard and hears everyone, also where a list from
   * before they were one says otherwise.
   */
  async blocks(recipient: string, sender: string): Promise<boolean> {
    if (!(await ignores.isIgnoring(recipient, sender))) return false;
    return !(await player.isAdmin(sender)) && !(await player.isAdmin(recipient));
  },
  /** Of `recipients`, the ones `sender` is not held back from, as they were given. */
  async notIgnoring(sender: string, recipients: string[]): Promise<string[]> {
    const kept: string[] = [];
    for (const recipient of recipients) {
      if (!(await ignores.blocks(recipient, sender))) kept.push(recipient);
    }
    return kept;
  },
  /** Puts `other` on a player's list, by the name their account has. */
  async add(username: string, other: string, now = Date.now()): Promise<IgnoreResult> {
    const name = lower(username);
    // Whether there is such an account is the player system's to say, from the accounts it holds.
    const account = (await player.findByUsername(other)) as { username: string }[] | undefined;
    const ignored = lower(account?.[0]?.username ?? "");
    if (!name || !ignored) return "unknown";
    if (ignored === name) return "self";
    // Admins have to reach every player, and to see what every player says.
    if (await player.isAdmin(name)) return "staff";
    if (await player.isAdmin(ignored)) return "admin";

    return change(name, async (held) => {
      if (held.includes(ignored)) return "already";
      if (held.length >= IGNORE_LIMIT) return "full";
      await query("INSERT INTO ignores (username, ignored, created_at) VALUES (?, ?, ?)", [name, ignored, now]);
      await rows.set(name, [...held, ignored]);
      return "added";
    });
  },
  /** Takes `other` off a player's list. False when they were not on it. */
  async remove(username: string, other: string): Promise<boolean> {
    const name = lower(username);
    const ignored = lower(other);
    if (!name || !ignored) return false;

    return change(name, async (held) => {
      if (!held.includes(ignored)) return false;
      await query("DELETE FROM ignores WHERE username = ? AND ignored = ?", [name, ignored]);
      await rows.set(name, held.filter((entry) => entry !== ignored));
      return true;
    });
  },
};

export default ignores;
