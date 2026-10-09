/**
 * Player subscriptions: what a player who has not paid may not do.
 *
 * The game owner charges a monthly subscription through the Gateway. An admin
 * ticks, in the control panel (or with /subscription), what an unsubscribed
 * player may not do; each tick is one row of `subscription_locks`. The
 * Gateway sets `accounts.subscribed` when a payment comes in, and writes
 * `subscription_status.enabled = 1` only while it has all its Stripe settings,
 * so a game without them can never lock its players out.
 *
 * Every check reads the copy held here, never the database: the two tables are
 * table caches (datacache.ts), read at startup and again once a minute, so a
 * change made in another realm or by the Gateway arrives within that minute.
 * A change made here is written to the database first and then to the cache.
 */
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { tableCache } from "../services/datacache";
import { Events, listener } from "./events";

/** What a locked player is told. */
export const REFUSAL = "A subscription is needed for this.";

/** Every lock, in the order the control panel lists them. The id is what the table and the commands hold. */
export const LOCKS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "login", label: "Log In" },
  { id: "chat", label: "Chat" },
  { id: "whisper", label: "Whisper" },
  { id: "party_chat", label: "Party Chat" },
  { id: "guild_chat", label: "Guild Chat" },
  { id: "trade", label: "Trade" },
  { id: "party", label: "Parties" },
  { id: "guild", label: "Guilds" },
  { id: "friends", label: "Friends" },
  { id: "mount", label: "Mounts" },
  { id: "combat", label: "Combat" },
  { id: "equip", label: "Equip Items" },
  { id: "use_item", label: "Use Items" },
  { id: "loot", label: "Loot" },
  { id: "quests", label: "Quests" },
  { id: "vendor", label: "Vendors" },
];

const KNOWN = new Set(LOCKS.map((lock) => lock.id));

/** Whether `id` is one of the locks above. */
export const isLockId = (id: unknown): id is string => typeof id === "string" && KNOWN.has(id);

// ----------------------------------------------------------------- schema

const sqlite = (): boolean => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";

/** The columns of `accounts` this feature adds, as the setup scripts declare them. */
const COLUMNS: Record<"mysql" | "sqlite", Array<{ name: string; type: string }>> = {
  mysql: [
    { name: "subscribed", type: "INT NOT NULL DEFAULT 0" },
    { name: "stripe_customer_id", type: "VARCHAR(64) DEFAULT NULL" },
    { name: "subscription_ends", type: "BIGINT DEFAULT NULL" },
  ],
  sqlite: [
    { name: "subscribed", type: "INTEGER NOT NULL DEFAULT 0" },
    { name: "stripe_customer_id", type: "TEXT DEFAULT NULL" },
    { name: "subscription_ends", type: "INTEGER DEFAULT NULL" },
  ],
};

/** False until the columns and tables are known to be there: until then nothing is read, written or locked. */
let ready = false;

/** Whether the subscription columns and tables are in the database (the start-time step succeeded). */
export const subscriptionsReady = (): boolean => ready;

async function hasColumn(name: string): Promise<boolean> {
  if (sqlite()) {
    const rows = (await query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'`)) as any[];
    return new RegExp(`\\b${name}\\b`).test(String(rows?.[0]?.sql || ""));
  }
  const rows = (await query(
    `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts' AND COLUMN_NAME = ?`,
    [name]
  )) as any[];
  return Number(rows?.[0]?.count) > 0;
}

/**
 * Start-time safety step. The setup scripts add the same columns and tables,
 * but a database that is already live may not have had its setup run before
 * this version starts, and a login that selects a missing column fails for
 * everyone. So the columns and tables are added here, if they are missing,
 * before the first login and before the table caches are read. Safe on every
 * start: whatever is there is left alone. If it cannot be done, one warning is
 * logged and the feature stays off: everyone counts as subscribed and nothing
 * is locked. It never throws, so it cannot stop the server from starting.
 */
export async function ensureSubscriptionSchema(): Promise<boolean> {
  ready = false;
  try {
    const lite = sqlite();
    for (const column of COLUMNS[lite ? "sqlite" : "mysql"]) {
      if (await hasColumn(column.name)) continue;
      try {
        await query(`ALTER TABLE accounts ADD COLUMN ${column.name} ${column.type}`);
      } catch (error) {
        // Another realm starting at the same moment may have added it first.
        if (!(await hasColumn(column.name))) throw error;
      }
    }
    await query(`CREATE TABLE IF NOT EXISTS subscription_locks (name ${lite ? "TEXT" : "VARCHAR(64)"} NOT NULL PRIMARY KEY)`);
    await query(
      lite
        ? `CREATE TABLE IF NOT EXISTS subscription_status (id INTEGER NOT NULL PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`
        : `CREATE TABLE IF NOT EXISTS subscription_status (id INT NOT NULL PRIMARY KEY, enabled INT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL DEFAULT 0)`
    );
    await query(`INSERT ${lite ? "OR IGNORE" : "IGNORE"} INTO subscription_status (id, enabled, updated_at) VALUES (1, 0, 0)`);
    ready = true;
  } catch (error) {
    log.warn(`[Subscriptions] The subscription columns and tables could not be added to the database, so subscriptions stay off (everyone counts as subscribed, nothing is locked): ${error}`);
  }
  return ready;
}

// ------------------------------------------------------------------ caches

const lockRows = tableCache<{ name: string }>("subscription_locks", async () =>
  ready ? (((await query("SELECT name FROM subscription_locks")) as { name: string }[]) || []) : []
);

const statusRows = tableCache<{ id: number; enabled: number; updated_at: number }>("subscription_status", async () =>
  ready ? (((await query("SELECT id, enabled, updated_at FROM subscription_status")) as any[]) || []) : []
);

/** What a check reads: kept in step with the two caches, so a check is synchronous and cannot throw. */
let enabled = false;
let locked = new Set<string>();

/** Takes what the two caches hold as the state the checks read. A failure leaves the state as it was. */
export async function refreshSubscriptions(): Promise<void> {
  try {
    const [names, status] = await Promise.all([lockRows.all(), statusRows.all()]);
    locked = new Set(names.map((row) => String(row.name)).filter((name) => KNOWN.has(name)));
    enabled = status.some((row) => Number(row.id) === 1 && Number(row.enabled) === 1);
  } catch (error) {
    log.error(`[Subscriptions] The locks could not be read: ${error}`);
  }
}

/** Once a minute: read both tables again, for a change made by another realm or the Gateway. */
const RELOAD_MS = 60 * 1000;
let reloadedAt = Date.now();

if (Bun.isMainThread) {
  listener.on(Events.SERVER_TICK, async function reloadSubscriptions() {
    if (!ready) return;
    const since = Date.now() - reloadedAt;
    // Less than nothing: the clock was set back, and how long it has been is not known.
    if (since >= 0 && since < RELOAD_MS) return;
    reloadedAt = Date.now();
    try {
      await Promise.all([lockRows.reload(), statusRows.reload()]);
    } catch (error) {
      log.error(`[Subscriptions] The locks could not be read again: ${error}`);
      return;
    }
    await refreshSubscriptions();
  });
}

// ------------------------------------------------------------------- rules

/** Who a lock applies to: the fields of a live player it reads. */
export interface SubscriptionSubject {
  isAdmin?: boolean | null;
  isGuest?: boolean | null;
  isSubscribed?: boolean | null;
}

/**
 * Whether `subject` may not do `id`: subscriptions are on, `id` is ticked, and
 * they are not an admin and have not paid. A guest counts as not subscribed
 * (a guest cannot subscribe). Only ever asked of the player who acts.
 */
export function isLocked(subject: SubscriptionSubject | null | undefined, id: string): boolean {
  if (!subject || !enabled || !locked.has(id)) return false;
  if (subject.isAdmin) return false;
  // A player whose flag was never set is not locked: only an account read as unpaid is.
  return !!subject.isGuest || subject.isSubscribed === false;
}

/** The words for a player locked out of `id`, or null when they may. */
export function refusal(subject: SubscriptionSubject | null | undefined, id: string): string | null {
  return isLocked(subject, id) ? REFUSAL : null;
}

/** What the control panel shows: whether the locks bite, which are ticked, and what can be ticked. */
export function subscriptionState(): { enabled: boolean; locks: string[]; options: Array<{ id: string; label: string }> } {
  return {
    enabled,
    locks: LOCKS.filter((lock) => locked.has(lock.id)).map((lock) => lock.id),
    options: LOCKS.map((lock) => ({ ...lock })),
  };
}

/** True while subscriptions are on (the Gateway has its Stripe settings). */
export const subscriptionsEnabled = (): boolean => enabled;

let turn: Promise<unknown> = Promise.resolve();

/**
 * Ticks (`on`) or unticks `id`. The database is written first, then the
 * cache; the checks follow at once, in this realm.
 */
export function setLock(id: string, on: boolean): Promise<{ success: boolean; message: string }> {
  // One change at a time, so two admins cannot leave the cache different from the table.
  const mine = turn.then(() => change(id, on));
  turn = mine.catch(() => {});
  return mine;
}

async function change(id: string, on: boolean): Promise<{ success: boolean; message: string }> {
  const label = LOCKS.find((lock) => lock.id === id)?.label;
  if (!label) return { success: false, message: `Unknown lock "${id}". Use /subscription list to see them.` };
  if (!ready) return { success: false, message: "Subscriptions are not set up on this database, so nothing was changed." };
  if (locked.has(id) === on) return { success: true, message: `${label} is already ${on ? "locked" : "unlocked"} for players who are not subscribed.` };
  try {
    if (on) await query(`INSERT ${sqlite() ? "OR IGNORE" : "IGNORE"} INTO subscription_locks (name) VALUES (?)`, [id]);
    else await query("DELETE FROM subscription_locks WHERE name = ?", [id]);
  } catch (error) {
    log.error(`[Subscriptions] Failed to ${on ? "lock" : "unlock"} ${id}: ${error}`);
    // The write may have been applied: read the table again on the next look.
    await lockRows.drop();
    return { success: false, message: "The change could not be saved, so nothing was changed." };
  }
  if (on) await lockRows.put({ name: id }, (row) => row.name === id);
  else await lockRows.remove((row) => row.name === id);
  await refreshSubscriptions();
  log.info(`[Subscriptions] ${label} is now ${on ? "locked" : "unlocked"} for players who are not subscribed`);
  return {
    success: true,
    message: `${label} is now ${on ? "locked" : "unlocked"} for players who are not subscribed.${enabled ? "" : " Locks only apply once subscriptions are set up on the Gateway."}`,
  };
}
