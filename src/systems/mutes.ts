import query, { transaction } from "../controllers/sqldatabase";
import log from "../modules/logger";
import { tableCache } from "../services/datacache";

/** A row of the mutes table. Times are milliseconds since the epoch; no `expires_at` is a mute until it is lifted. */
export interface Mute {
  username: string;
  muted_by: string;
  reason: string | null;
  created_at: number;
  expires_at: number | null;
}

// Every mute. Whether a player is muted is asked on every line of chat, and is
// answered from these rows: a change below is written to the database and then
// to them, and a write the database does not answer has them read again.
const rows = tableCache<Mute>("mutes", async () => {
  const result = (await query("SELECT username, muted_by, reason, created_at, expires_at FROM mutes", [])) as any[];
  return (result || []).map((row) => ({
    username: String(row.username).toLowerCase(),
    muted_by: row.muted_by,
    reason: row.reason ?? null,
    created_at: Number(row.created_at),
    expires_at: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
  }));
});

const lower = (username: string) => String(username ?? "").toLowerCase();
const of = (name: string) => (row: Mute) => row.username === name;
const over = (mute: Mute, now: number) => mute.expires_at !== null && mute.expires_at <= now;

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** How long "30m", "2h", "7d" or "1w" is, in milliseconds. Null for anything that is not a whole number and one of those units. */
export function parseDuration(text: string | null | undefined): number | null {
  const match = /^(\d+)([smhdw])$/i.exec(String(text ?? ""));
  if (!match) return null;
  const length = Number(match[1]) * UNITS[match[2].toLowerCase()];
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

/**
 * Runs one write. When the database does not answer it the mutes are read
 * again: a statement that timed out may still have been applied, so what is
 * held can be trusted no longer. The failure is still thrown.
 */
async function writing<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    await rows.reload().catch((failure) => log.error(`Error reading the mutes again after a failed write: ${failure}`));
    throw error;
  }
}

/** Takes a mute out: the row, then the row held. */
async function remove(name: string): Promise<void> {
  await writing(() => query("DELETE FROM mutes WHERE username = ?", [name]));
  await rows.remove(of(name));
}

const mutes = {
  /** The mute a player is under, or null. One whose time has passed is over, and is taken out when it is found. */
  async get(username: string, now = Date.now()): Promise<Mute | null> {
    const name = lower(username);
    if (!name) return null;
    const mute = await rows.find(of(name));
    if (!mute) return null;
    if (!over(mute, now)) return mute;
    // Left in, it would only be found and passed over again.
    await remove(name).catch((error) => log.error(`Error removing the mute of ${name} that is over: ${error}`));
    return null;
  },
  async isMuted(username: string, now = Date.now()): Promise<boolean> {
    return (await mutes.get(username, now)) !== null;
  },
  /** Mutes a player for `duration` milliseconds, or until it is lifted when there is none. A mute they are under is replaced. */
  async mute(username: string, by: string, duration: number | null, reason: string | null, now = Date.now()): Promise<Mute> {
    const mute: Mute = {
      username: lower(username),
      muted_by: lower(by),
      reason: reason?.trim() || null,
      created_at: now,
      expires_at: duration === null ? null : now + duration,
    };
    // Out and in again as one: a mute is never lifted without the new one taking its place.
    await writing(() => transaction([
      { sql: "DELETE FROM mutes WHERE username = ?", values: [mute.username] },
      {
        sql: "INSERT INTO mutes (username, muted_by, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        values: [mute.username, mute.muted_by, mute.reason, mute.created_at, mute.expires_at],
      },
    ]));
    await rows.put(mute, of(mute.username));
    return mute;
  },
  /** Lifts a player's mute. False when they were under none. */
  async unmute(username: string, now = Date.now()): Promise<boolean> {
    const name = lower(username);
    if (!(await mutes.get(name, now))) return false;
    await remove(name);
    return true;
  },
  /** The mutes in force, the soonest over first and the ones that last until lifted at the end. */
  async list(now = Date.now()): Promise<Mute[]> {
    return (await rows.filter((mute) => !over(mute, now)))
      .sort((a, b) => (a.expires_at ?? Infinity) - (b.expires_at ?? Infinity));
  },
};

export default mutes;
