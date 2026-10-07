import query from "../controllers/sqldatabase";
import { verify, randomBytes } from "../modules/hash";
import log from "../modules/logger";
import assetCache from "../services/assetCache";
import { getWorldMap, type WorldBits } from "../modules/worldmaps";
import * as settings from "../config/settings.json";
import playerCache from "../services/playermanager.ts";
import { realmWhitelist } from "../services/whitelist";
import { rowCache, tableCache, dropRows, dropAllRows, reloadTable, type RowCache } from "../services/datacache";
import type { Batch } from "../services/batch";
import { Events, listener } from "./events";
import { isSick, applySicknessToStats } from "./resurrection";
const defaultMap = settings.default_map?.replace(".json", "") || "main";

// What the engine writes of an account. The rest of the row (session, token,
// e-mail, password, two-factor) is the gateway's to write and is not held:
// who is online is asked of the player cache instead.
interface AccountRow {
  id: number;
  username: string;
  role: number;
  banned: number;
  guest_mode: number;
  stealth: number;
  noclip: number;
  is_dead: number;
  corpse_map: string | null;
  corpse_x: number | null;
  corpse_y: number | null;
  map: string;
  position: string;
  direction: string;
  party_id: number | null;
  guild_id: number | null;
}

// The id and name of every account: what a search of the accounts asks,
// instead of the database. It is read at startup with the other tables. The
// gateway makes accounts without the engine hearing of it, so it is read
// again on the server's tick (below), and an account whose row is read from
// the database, as a login does, is added if it is not listed.
const allAccounts = tableCache<{ id: number; username: string }>("account_names", async () =>
  ((await query("SELECT id, username FROM accounts")) as { id: number; username: string }[]) || []
);

// How long the names are held before they are read again: 5 minutes. An
// account the gateway made, and that has not logged in to the game since, is
// found by a search at most this much later.
const ACCOUNT_NAMES_REFRESH_MS = 5 * 60 * 1000;
let accountNamesReadAt = Date.now();

listener.on(Events.SERVER_TICK, async function refreshAccountNames() {
  const since = Date.now() - accountNamesReadAt;
  // Less than nothing: the clock was set back, and how long it has been is not known.
  if (since >= 0 && since < ACCOUNT_NAMES_REFRESH_MS) return;
  accountNamesReadAt = Date.now();
  try {
    await allAccounts.reload();
  } catch (error) {
    log.error(`Failed to read the account names again: ${error}`);
  }
});

/** An account just read from the database joins the names a search asks, unless it is listed already. */
async function listAccount(account: AccountRow): Promise<void> {
  // Not in a login worker: nothing is held there, and asking would read every account.
  if (!Bun.isMainThread) return;
  const name = String(account.username).toLowerCase();
  try {
    if (await allAccounts.find((listed) => Number(listed.id) === Number(account.id) && listed.username === account.username)) return;
    // In place of whoever held the name before, if it was given to a new account.
    await allAccounts.put({ id: account.id, username: account.username }, (listed) => String(listed.username).toLowerCase() === name);
  } catch (error) {
    // The account itself was read: only a search is the poorer for this.
    log.error(`Failed to list the account ${name} for searches: ${error}`);
  }
}

const accountRows = rowCache<AccountRow>("accounts", async (username) => {
  const rows = (await query(
    "SELECT id, username, role, banned, guest_mode, stealth, noclip, is_dead, corpse_map, corpse_x, corpse_y, map, position, direction, party_id, guild_id FROM accounts WHERE username = ?",
    [username]
  )) as AccountRow[];
  if (rows?.[0]) await listAccount(rows[0]);
  return rows?.[0];
}, { perPlayer: true });

// Account id -> username, for the lookups made by id. Only the name is held
// here: what is known of the account is its row above, so the two cannot
// disagree.
const accountNames = rowCache<string>("account_ids", async (id) => {
  const rows = (await query("SELECT username FROM accounts WHERE id = ?", [Number(id)])) as { username: string }[];
  return rows?.[0]?.username;
});

const statRows = rowCache<StatsData>("stats", async (username) => {
  const rows = (await query("SELECT * FROM stats WHERE username = ?", [username])) as StatsData[];
  return rows?.[0];
}, { perPlayer: true });

const configRows = rowCache<Record<string, any>>("clientconfig", async (username) => {
  const rows = (await query("SELECT * FROM clientconfig WHERE username = ?", [username])) as Record<string, any>[];
  return rows?.[0];
}, { perPlayer: true });

/** The account with this id. */
async function accountById(id: number): Promise<AccountRow | null> {
  const username = await accountNames.get(id);
  if (!username) return null;
  const account = await accountRows.get(username);
  if (account && Number(account.id) === Number(id)) return account;
  // The name is no longer that account's (it was deleted): look the id up again next time.
  await accountNames.drop(id);
  return null;
}

/** The account `WHERE username = ? OR session_id = ?` found: of the player online under that session id, or by name. */
async function accountByNameOrSession(identifier: string | null | undefined): Promise<AccountRow | null> {
  if (!identifier) return null;
  return accountRows.get(playerCache.get(identifier)?.username || identifier);
}

/** The id of the session a username is online under. */
function sessionOf(username: string): string | undefined {
  const id = playerCache.getByUsername(username)?.id;
  return id === undefined || id === null ? undefined : String(id);
}

const whole = (...values: unknown[]) => values.every((value) => Number.isInteger(value));
const text = (...values: unknown[]) => values.every((value) => typeof value === "string");

/**
 * What SQL's `LIKE pattern` accepts, in any case: % stands for any run of
 * characters and _ for any one. Every other character stands for itself, a
 * backslash too (the searches made here are of letters, digits and _).
 */
function like(pattern: string): (value: unknown) => boolean {
  const source = [...pattern]
    .map((character) => (character === "%" ? ".*" : character === "_" ? "." : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  const expression = new RegExp(`^${source}$`, "isu");
  return (value) => expression.test(String(value));
}

/**
 * Runs a write to a player's row. When the database does not answer it, the
 * row is read again: a statement that timed out may still have been applied,
 * so what is held can be trusted no longer.
 */
async function writing<T>(rows: RowCache<any>, username: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (username) await rows.drop(username);
    throw error;
  }
}

/**
 * After a write to a player's row: the columns written, on the row held.
 * `asGiven` false: the database stores one of them differently from what it
 * was handed (a fraction in a whole-number column, say), so the row is read
 * again rather than guessed at.
 */
async function wrote<T>(rows: RowCache<T>, username: string, columns: Partial<T>, asGiven = true): Promise<void> {
  if (asGiven) await rows.patch(username, columns);
  else await rows.drop(username);
}

/**
 * Whose row a write `WHERE session_id = ?` changes: the player online under
 * that session. A session that has already left the player cache (a
 * disconnect's last save) is nobody here, and its rows are forgotten with
 * the player.
 */
const usernameOfSession = (session_id: string): string | undefined => playerCache.get(session_id)?.username;

/** False when the database says a write changed no row: the session was not that account's any more. */
const changedRows = (response: any) => !(response && typeof response === "object" && "affectedRows" in response && Number(response.affectedRows) === 0);

/**
 * After a layout is saved to a config column: the same on the row held, in
 * the form the database gives that column back. That is the text written
 * where the column is text and the parsed value where it is JSON, which the
 * row held shows; a row that shows neither is read again.
 */
async function wroteLayout(username: string, column: "hotbar_config" | "inventory_config", json: string | undefined): Promise<void> {
  if (json === undefined) return configRows.patch(username, { [column]: null });
  const held = await configRows.get(username);
  const shown = [held?.hotbar_config, held?.inventory_config].find((value) => value !== null && value !== undefined);
  if (typeof shown === "string") await configRows.patch(username, { [column]: json });
  else if (typeof shown === "object") await configRows.patch(username, { [column]: JSON.parse(json) });
  else await configRows.drop(username);
}

// The caches of the per-player tables the guest clean-up deletes from.
const CLEANED = ["accounts", "account_ids", "inventory", "stats", "clientconfig", "quest_log", "currency", "collectables", "equipment", "learned_spells", "spell_usage", "permissions", "friends"];

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

const tokenExpiry = new Map<string, number>();

function trackToken(token: string): void {
  tokenExpiry.set(token, Date.now() + TOKEN_EXPIRY_MS);
}

function isTokenExpired(token: string): boolean {
  const expiry = tokenExpiry.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    tokenExpiry.delete(token);
    return true;
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of tokenExpiry) {
    if (now > expiry) tokenExpiry.delete(token);
  }
}, 60 * 60 * 1000).unref();

type CachedMap = typeof mapCache extends Map<string, infer V> ? V : never;

const mapCache: Map<
  string,
  {
    warps: Record<string, WarpObject>;
    collisionRLE?: number[];
    /** A world's collision (modules/worldmaps.ts): one bit per tile, in place of the run lengths. */
    collisionBits?: WorldBits;
    grid?: Uint8Array;
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
  }
> = new Map();

// Fills mapCache for a world. A world has no collision run lengths in the asset cache, so the lookups below take its
// entry from here before they go looking for them.
function cacheWorldMap(mapKey: string): CachedMap | undefined {
  const world = getWorldMap(mapKey);
  if (!world) return undefined;

  const warps = world.properties?.warps;
  const entry: CachedMap = {
    warps: Array.isArray(warps)
      ? Object.fromEntries(
          (warps as WarpObject[]).map((warp, idx) => [warp.name ?? String(idx), warp])
        )
      : ((warps || {}) as Record<string, WarpObject>),
    collisionBits: world.collision,
    width: world.width,
    height: world.height,
    tileWidth: world.tileWidth,
    tileHeight: world.tileHeight,
  };

  mapCache.set(mapKey, entry);
  return entry;
}

function queryRLE(rleData: number[], targetIndex: number): number {
  if (!rleData || rleData.length < 2) return 0;

  let currentIndex = 0;

  for (let i = 2; i < rleData.length; i += 2) {
    const value = rleData[i];
    const count = rleData[i + 1];

    if (currentIndex + count > targetIndex) {
      return value;
    }

    currentIndex += count;
  }

  return 0;
}

export async function hasLineOfSight(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  map: string,
  maxDistance: number = 200
): Promise<boolean> {
  const mapKey = map.replace(".json", "");

  const distance = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
  if (distance > maxDistance) return false;

  let mapDataCached = mapCache.get(mapKey) ?? cacheWorldMap(mapKey);
  if (!mapDataCached) {
    const mapProperties = (await assetCache.get("mapProperties")) as MapProperties[];
    const mapData = mapProperties?.find((m: any) => m.name.replace(".json", "") === mapKey);
    if (!mapData) return false;

    const collisionData = await assetCache.getNested(mapKey, "collision");
    if (!collisionData || !Array.isArray(collisionData)) return false;

    mapDataCached = {
      warps: Array.isArray(mapData.warps)
        ? Object.fromEntries(
            (mapData.warps as WarpObject[]).map((warp, idx) => [warp.name ?? String(idx), warp])
          )
        : (mapData.warps || {}),
      collisionRLE: collisionData,
      width: collisionData[0],
      height: collisionData[1],
      tileWidth: mapData.tileWidth,
      tileHeight: mapData.tileHeight,
    };

    mapCache.set(mapKey, mapDataCached);
  }

  const { collisionRLE, collisionBits, width, height, tileWidth, tileHeight } = mapDataCached;

  if (!collisionRLE && !collisionBits) return false;

  const startTileX = Math.floor(startX / tileWidth);
  const startTileY = Math.floor(startY / tileHeight);
  const endTileX = Math.floor(endX / tileWidth);
  const endTileY = Math.floor(endY / tileHeight);

  if (startTileX < 0 || startTileY < 0 || startTileX >= width || startTileY >= height) return false;
  if (endTileX < 0 || endTileY < 0 || endTileX >= width || endTileY >= height) return false;

  const dx = Math.abs(endTileX - startTileX);
  const dy = Math.abs(endTileY - startTileY);
  const sx = startTileX < endTileX ? 1 : -1;
  const sy = startTileY < endTileY ? 1 : -1;
  let err = dx - dy;

  let currentX = startTileX;
  let currentY = startTileY;

  while (true) {

    if (currentX >= 0 && currentX < width && currentY >= 0 && currentY < height) {
      const tileIndex = currentY * width + currentX;
      const tileValue = collisionBits ? collisionBits.isSet(currentX, currentY) : queryRLE(collisionRLE!, tileIndex);

      if (tileValue !== 0) {
        return false;
      }
    }

    if (currentX === endTileX && currentY === endTileY) {
      break;
    }

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      currentX += sx;
    }
    if (e2 < dx) {
      err += dx;
      currentY += sy;
    }
  }

  return true;
}

const player = {
  clear: async () => {
    try {
      // Reset all accounts
      await query(
        "UPDATE accounts SET verification_code = NULL, party_id = NULL, twofa_pending = 0"
      );

      // Get guest usernames for cleanup
      const guestUsernames = "(SELECT username FROM accounts WHERE guest_mode = 1)";

      // Delete guest data from all related tables with username columns
      await query(`DELETE FROM inventory WHERE username IN ${guestUsernames}`);
      await query(`DELETE FROM stats WHERE username IN ${guestUsernames}`);
      await query(`DELETE FROM clientconfig WHERE username IN ${guestUsernames}`);
      await query(`DELETE FROM quest_log WHERE username IN ${guestUsernames}`);
      await query(`DELETE FROM currency WHERE username IN ${guestUsernames}`);
      await query(`DELETE FROM collectables WHERE username IN ${guestUsernames}`);
      await query(`DELETE FROM equipment WHERE username IN ${guestUsernames}`);
      await query(`DELETE FROM learned_spells WHERE username IN ${guestUsernames}`);
      await query(`DELETE FROM permissions WHERE username IN ${guestUsernames}`);
      await query(`DELETE FROM friendslist WHERE username IN ${guestUsernames}`);

      // Delete parties led by guests
      await query(`DELETE FROM parties WHERE leader IN ${guestUsernames}`);

      // Delete guilds led by guests
      await query(`DELETE FROM guilds WHERE leader IN ${guestUsernames}`);

      // Clear all parties
      if (process.env.DATABASE_ENGINE === "sqlite") {
        await query("DELETE FROM parties");
      } else {
        await query("TRUNCATE TABLE parties");
      }

      // Delete guest accounts
      await query("DELETE FROM accounts WHERE guest_mode = 1");
    } finally {
      // None of this names the rows it wrote: every account lost its party,
      // and the guests are picked by the database. So the caches of these
      // tables forget everything and read again, also when it stopped half way.
      await Promise.all(CLEANED.map((name) => dropAllRows(name)));
      await Promise.all([reloadTable("parties"), reloadTable("guilds"), allAccounts.reload()]);
    }
  },
  register: async (
    username: string,
    password_hash: string,
    email: string,
    req: any,
    guest: boolean
  ) => {
    if (!username || !password_hash || !email)
      return { error: "Missing fields" };
    username = username.toLowerCase();
    email = email.toLowerCase();

    if (!guest && username.startsWith("guest_"))
      return { error: "Username cannot start with 'guest_'" };

    const usernameExists = (await player.findByUsername(username)) as string[];
    if (usernameExists && usernameExists.length != 0)
      return { error: "Username already exists" };

    const emailExists = (await player.findByEmail(email)) as string[];
    if (emailExists && emailExists.length != 0)
      return { error: "Email already exists" };

    const response = await query(
      "INSERT INTO accounts (email, username, token, password_hash, ip_address, geo_location, map, position, guest_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        email,
        username,
        null,
        password_hash,
        req.ip,
        req.headers["cf-ipcountry"],
        defaultMap,
        "0,0",
        guest ? 1 : 0,
      ]
    ).catch((err) => {
      log.error(err);
      return { error: "An unexpected error occurred" };
    });
    if (!response) return { error: "An unexpected error occurred" };

    try {
      await query(
        "INSERT INTO stats (username, health, max_health, stamina, max_stamina, xp, max_xp, level, stat_critical_damage, stat_critical_chance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [username, 100, 100, 100, 100, 0, 100, 1, 10, 10]
      );

      await query(
        "INSERT INTO clientconfig (username, fps, music_volume, effects_volume, muted) VALUES (?, ?, ?, ?, ?)",
        [username, 60, 50, 50, 0]
      );

      // (Nothing for the quest log: it holds a row for each quest a player has taken, and a new one has taken
      // none. The row once written for it here, a name and no quest, is refused by the table as it is now, and
      // nothing after it was then written.)
      await query(
        "INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?)",
        [username, 0, 0, 0]
      );

      await query(
        "INSERT INTO equipment (username) VALUES (?)",
        [username]
      );

      await query("INSERT INTO collectables (type, item, username) VALUES (?, ?, ?)", ["mount", "unicorn", username]);

      await query("INSERT INTO learned_spells (spell, username) VALUES (?, ?)", ["frost_bolt", username]);
    } finally {
      // A cache that looked for this name before now holds that it has no rows: the new ones are read.
      await Promise.all([
        accountRows.drop(username),
        statRows.drop(username),
        configRows.drop(username),
        ...["currency", "equipment", "collectables", "learned_spells"].map((name) => dropRows(name, username)),
        // Who knows the spell every new account is given.
        dropRows("spell_usage", "frost_bolt"),
      ]);
    }

    return username;
  },
  verify: async (session_id: string) => {

    const response = (await query(
      "SELECT verified FROM accounts WHERE session_id = ?",
      [session_id]
    )) as any[];

    if (response[0]?.verified) return true;
    return false;
  },
  findByUsername: async (username: string): Promise<unknown[] | undefined> => {
    if (!username) return;
    username = username.toLowerCase();
    const account = await accountRows.get(username);
    return account ? [{ username: account.username }] : [];
  },
  /** The accounts with this username or, for a player who is online, this session id. */
  findPlayerInDatabase: async (username?: string, id?: string) => {
    if (!username && !id) return;
    if (username) username = username.toLowerCase();
    const found: AccountRow[] = [];
    for (const name of [username, id ? playerCache.get(id)?.username : undefined]) {
      const account = name ? await accountRows.get(name) : null;
      if (account && !found.some((other) => other.id === account.id)) found.push(account);
    }
    return found.map((account) => ({ username: account.username, banned: account.banned }));
  },
  /**
   * One account for the admin tools: by account id when `id` is given, otherwise by username.
   * `session_id` is the session they are online under, null when they are not.
   */
  findAccount: async (username?: string, id?: number) => {
    if (!username && !id) return null;
    const account = id ? await accountById(id) : await accountRows.get(username as string);
    if (!account) return null;
    return {
      id: account.id,
      username: account.username,
      session_id: sessionOf(account.username) ?? null,
      banned: account.banned,
      is_dead: account.is_dead,
    };
  },
  /**
   * Accounts whose username contains `search`, for the admin tools' player lists:
   * what `username LIKE '%search%' ORDER BY username LIMIT limit` gave, asked of
   * the names held. An account the gateway made since they were last read is not
   * among them until it logs in or they are read again.
   */
  searchAccounts: async (search: string, limit: number) => {
    if (!search) return [];
    const matches = like(`%${search.toLowerCase()}%`);
    const found = await allAccounts.filter((account) => matches(account.username));
    return found
      .sort((a, b) => String(a.username).localeCompare(String(b.username)))
      .slice(0, Math.max(1, Math.trunc(limit) || 1));
  },
  /** What the engine holds of an account: the columns it writes, as the database has them. Null when there is no such account. */
  getAccount: async (username: string) => {
    if (!username) return null;
    return accountRows.get(username);
  },
  findByEmail: async (email: string) => {
    if (!email) return;
    const response = await query("SELECT email FROM accounts WHERE email = ?", [
      email,
    ]);
    return response;
  },
  getLocation: async (player: Player) => {
    const username = player.username || player.id;
    const account = await accountByNameOrSession(username);
    const map = account?.map as string;
    const position: PositionData = {
      x: Math.round(Number(account?.position?.split(",")[0])),
      y: Math.round(Number(account?.position?.split(",")[1])),
      direction: account?.direction || "down",
    };

    if (
      !map ||
      (!position.x && position.x.toString() != "0") ||
      (!position.y && position.y.toString() != "0")
    ) {
      return null;
    }

    return { map, position };
  },
  setLocation: async (
    session_id: string,
    map: string,
    position: PositionData
  ) => {
    if (!session_id || !map || !position) return;
    const at = `${Math.round(position.x)},${Math.round(position.y)}`;
    const username = usernameOfSession(session_id);
    const response = await writing(accountRows, username, () => query(
      "UPDATE accounts SET map = ?, position = ?, direction = ? WHERE session_id = ?",
      [map, at, position.direction, session_id]
    ));
    if (username && changedRows(response)) {
      await wrote(accountRows, username, { map, position: at, direction: position.direction as string }, text(map, position.direction));
    }
    return response;
  },
  /**
   * setLocation for a player who has just been moved somewhere (through a warp, say), answering
   * whether the account is saved as standing there: its row was changed, or it already said so.
   * The database answers a write with the rows it changed, so a move to where the account was last
   * saved changes none, exactly as a write for a session that is no longer the account's does. The
   * two are told apart by the row held: a door leads to one spot, and a player brought back inside
   * some other way walks out to the very place they were saved at.
   */
  arriveAt: async (session_id: string, map: string, position: PositionData): Promise<boolean> => {
    if (!session_id || !map || !position) return false;
    const response = await player.setLocation(session_id, map, position);
    if (changedRows(response)) return true;
    const username = usernameOfSession(session_id);
    const held = username ? await accountByNameOrSession(username) : null;
    const mapName = (name: unknown) => String(name ?? "").replaceAll(".json", "");
    return !!held && mapName(held.map) === mapName(map) && held.position === `${Math.round(position.x)},${Math.round(position.y)}`;
  },
  /** setLocation for a player who is offline, and so has no session id to be found by. */
  setLocationByUsername: async (
    username: string,
    map: string,
    position: PositionData
  ) => {
    if (!username || !map || !position) return;
    const at = `${Math.round(position.x)},${Math.round(position.y)}`;
    const response = await writing(accountRows, username, () => query(
      "UPDATE accounts SET map = ?, position = ?, direction = ? WHERE username = ?",
      [map, at, position.direction, username.toLowerCase()]
    ));
    await wrote(accountRows, username, { map, position: at, direction: position.direction as string }, text(map, position.direction));
    return response;
  },
  setDeadState: async (
    username: string,
    isDead: number,
    corpse: { map: string; x: number; y: number } | null
  ) => {
    if (!username) return;
    const state = {
      is_dead: isDead,
      corpse_map: corpse?.map || null,
      corpse_x: corpse ? Math.round(corpse.x) : null,
      corpse_y: corpse ? Math.round(corpse.y) : null,
    };
    const response = await writing(accountRows, username, () => query(
      "UPDATE accounts SET is_dead = ?, corpse_map = ?, corpse_x = ?, corpse_y = ? WHERE username = ?",
      [state.is_dead, state.corpse_map, state.corpse_x, state.corpse_y, username.toLowerCase()]
    ));
    await wrote(accountRows, username, state, whole(isDead) && (!corpse || (text(corpse.map) && whole(state.corpse_x, state.corpse_y))));
    return response;
  },
  setSessionId: async (
    token: string,
    sessionId: string
  ): Promise<boolean | string> => {
    if (!token || !sessionId) return false;
    if (isTokenExpired(token)) {
      await query("UPDATE accounts SET token = NULL WHERE token = ?", [token]);
      return false;
    }

    // sessionId comes from wt.data.id which is a number via parseInt(),
    // but the DB column is VARCHAR. Normalize to string for comparisons.
    const sid = String(sessionId);
    const accountResult = await query(
      "SELECT username, banned FROM accounts WHERE token = ?",
      [token]
    ) as any[];
    const username = accountResult[0]?.username as string;
    if (!username) return false;

    if (accountResult[0]?.banned === 1) {
      log.debug(`User ${username} is banned`);
      await player.logout(sid);
      return false;
    }

    // Attempt to atomically claim the session.
    // The WHERE clause only matches if no other session is active
    // (online=0 OR session_id IS NULL) or this is a re-auth.
    await query(
      `UPDATE accounts
       SET session_id = ?, online = 1
       WHERE token = ?
         AND (online = 0 OR session_id IS NULL OR session_id = ?)`,
      [sid, token, sid]
    );

    // Verify the claim succeeded by reading back the session_id
    const verifyResult = await query(
      "SELECT session_id FROM accounts WHERE token = ?",
      [token]
    ) as any[];

    if (String(verifyResult[0]?.session_id ?? "") === sid) {
      return username;
    }

    // Claim failed - another session is active. Resolve it.
    const existingSessionResult = await query(
      "SELECT session_id FROM accounts WHERE username = ?",
      [username]
    ) as any[];

    const existingSessionId = existingSessionResult[0]?.session_id;

    if (String(existingSessionId ?? "") === sid) {
      return false;
    }

    if (existingSessionId) {
      log.info(`Clearing existing session for ${username} to allow new login`);
      await player.clearSessionId(existingSessionId);
    }

    // Retry the atomic claim now that the existing session is cleared
    await query(
      `UPDATE accounts
       SET session_id = ?, online = 1
       WHERE token = ?
         AND (online = 0 OR session_id IS NULL OR session_id = ?)`,
      [sid, token, sid]
    );

    // Verify the retry claim succeeded
    const retryVerifyResult = await query(
      "SELECT session_id FROM accounts WHERE token = ?",
      [token]
    ) as any[];

    return String(retryVerifyResult[0]?.session_id ?? "") === sid ? username : false;
  },
  getSessionId: async (token: string) => {
    if (!token || isTokenExpired(token)) return;
    const response = await query(
      "SELECT session_id FROM accounts WHERE token = ?",
      [token]
    );
    return response;
  },
  logout: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "UPDATE accounts SET token = NULL, online = ?, session_id = NULL, verification_code = NULL, verified = ? WHERE session_id = ?",
      [0, 0, session_id]
    );
    return response;
  },
  clearSessionId: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "UPDATE accounts SET session_id = NULL, online = ? WHERE session_id = ?",
      [0, session_id]
    );
    return response;
  },
  login: async (username: string, password: string) => {
    if (!username || !password) return;
    username = username.toLowerCase();

    const response = (await query(
      "SELECT username, banned, token, password_hash FROM accounts WHERE username = ?",
      [username]
    )) as {
      username: string;
      banned: number;
      token: string;
      password_hash: string;
    }[];
    if (response.length === 0 || response[0].banned === 1) {
      log.debug(`User ${username} failed to login`);
      return;
    }

    const isValid = await verify(password, response[0].password_hash);
    if (!isValid) {
      log.debug(`User ${username} failed to login`);
      return;
    }

    const existingToken = !response[0].token || isTokenExpired(response[0].token) ? null : response[0].token;
    const token = existingToken || (await player.setToken(username));

    log.debug(`User ${username} logged in`);

    await query(
      "UPDATE accounts SET last_login = CURRENT_TIMESTAMP WHERE username = ?",
      [username]
    );
    return token;
  },
  getUsernameBySession: async (session_id: string) => {
    if (!session_id) return;
    const online = playerCache.get(session_id);
    return online?.username ? [{ username: online.username, id: online.userid }] : [];
  },
  /** The session a username is online under: nothing when they are not online. */
  getSessionIdByUsername: async (username: string): Promise<any> => {
    if (!username) return;
    return sessionOf(username);
  },
  getPartyIdByUsername: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    return (await accountRows.get(username))?.party_id;
  },
  getUsernameByToken: async (token: string) => {
    if (!token) return;
    if (isTokenExpired(token)) {
      await query("UPDATE accounts SET token = NULL WHERE token = ?", [token]);
      return;
    }
    const response = await query(
      "SELECT username FROM accounts WHERE token = ?",
      [token]
    );
    return response;
  },
  getEmail: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT email FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.email;
  },
  returnHome: async (session_id: string) => {
    if (!session_id) return;
    const username = usernameOfSession(session_id);
    const response = await writing(accountRows, username, () => query(
      "UPDATE accounts SET map = ?, position = '0,0' WHERE session_id = ?",
      [defaultMap, session_id]
    ));
    if (username && changedRows(response)) await wrote(accountRows, username, { map: defaultMap, position: "0,0" });
    return response;
  },
  setToken: async (username: string) => {
    const token = randomBytes(32);
    if (!username || !token) return;

    const response = await query(
      "UPDATE accounts SET token = ? WHERE username = ?",
      [token, username]
    );
    if (!response) return;

    trackToken(token);
    return token;
  },
  /** Whether a username is online on this server, as the rows `SELECT online` gave. */
  isOnline: async (username: string) => {
    if (!username) return;
    return [{ online: playerCache.getByUsername(username) ? 1 : 0 }];
  },
  isBanned: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const account = await accountRows.get(username);
    return account ? [{ banned: account.banned }] : [];
  },
  /** The players online on a map, with their position as it is stored. */
  getPlayers: async (map: string) => {
    if (!map) return;
    const on = map.replace(".json", "");
    return Object.values(playerCache.list())
      .filter((online: any) => online?.username && String(online.location?.map ?? "").replace(".json", "") === on)
      .map((online: any) => ({
        username: online.username,
        id: String(online.id),
        position: `${Math.round(online.location.position?.x)},${Math.round(online.location.position?.y)}`,
        map: online.location.map,
      }));
  },
  /** The map the player online under a session is on. */
  getMap: async (session_id: string) => {
    if (!session_id) return;
    return playerCache.get(session_id)?.location?.map as string;
  },
  isAdmin: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    return (await accountRows.get(username))?.role === 1;
  },
  isGuest: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    return (await accountRows.get(username))?.guest_mode === 1;
  },
  toggleAdmin: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const account = await accountRows.get(username);
    if (!account) return false;
    // Written as the value it becomes, not as "the other one": the database
    // and the row held then end the same whatever either held before.
    const role = account.role === 1 ? 0 : 1;
    const response = (await writing(accountRows, username, () => query(
      "UPDATE accounts SET role = ? WHERE username = ?",
      [role, username]
    ))) as any;
    if (!response) return;
    await accountRows.patch(username, { role });
    const admin = role === 1;

    if (!admin) {
      (await writing(accountRows, username, () => query(
        "UPDATE accounts SET stealth = 0, noclip = 0 WHERE username = ?",
        [username]
      ))) as any;
      await accountRows.patch(username, { stealth: 0, noclip: 0 });
    }
    log.debug(`${username} admin status has been updated to ${admin}`);
    return admin;
  },
  isStealth: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    return (await accountRows.get(username))?.stealth === 1;
  },
  toggleStealth: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const account = await accountRows.get(username);
    if (!account) return false;
    // Only an admin's stealth changes.
    if (account.role !== 1) return account.stealth === 1;
    const stealth = account.stealth === 1 ? 0 : 1;
    (await writing(accountRows, username, () => query(
      "UPDATE accounts SET stealth = ? WHERE username = ?",
      [stealth, username]
    ))) as any;
    await accountRows.patch(username, { stealth });
    return stealth === 1;
  },
  isNoclip: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    return (await accountRows.get(username))?.noclip === 1;
  },
  toggleNoclip: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const account = await accountRows.get(username);
    if (!account) return false;
    const noclip = account.noclip === 1 ? 0 : 1;
    (await writing(accountRows, username, () => query(
      "UPDATE accounts SET noclip = ? WHERE username = ?",
      [noclip, username]
    ))) as any;
    await accountRows.patch(username, { noclip });
    return noclip === 1;
  },
  /** The session a username is online under: nothing when they are not online. */
  getSession: async (username: string): Promise<any> => {
    if (!username) return;
    return sessionOf(username);
  },
  getStats: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const stats = await statRows.get(username);
    if (!stats) return [];
    return {
      health: stats.health,
      max_health: stats.max_health,
      total_max_health: stats.max_health,
      stamina: stats.stamina,
      max_stamina: stats.max_stamina,
      total_max_stamina: stats.max_stamina,
      level: stats.level,
      xp: stats.xp,
      max_xp: stats.max_xp,
      stat_critical_chance: stats.stat_critical_chance,
      stat_critical_damage: stats.stat_critical_damage,
      stat_armor: stats.stat_armor,
      stat_damage: stats.stat_damage,
      stat_health: stats.stat_health,
      stat_stamina: stats.stat_stamina,
      stat_avoidance: stats.stat_avoidance,
    };
  },
  setStats: async (username: string, stats: StatsData) => {
    if (!username) return;
    username = username.toLowerCase();
    if (
      !stats.health ||
      !stats.max_health ||
      !stats.stamina ||
      !stats.max_stamina
    )
      return;
    const saved = {
      health: stats.health,
      max_health: stats.max_health,
      stamina: stats.stamina,
      max_stamina: stats.max_stamina,
    };
    const response = await writing(statRows, username, () => query(
      "UPDATE stats SET health = ?, max_health = ?, stamina = ?, max_stamina = ? WHERE username = ?",
      [
        saved.health,
        saved.max_health,
        saved.stamina,
        saved.max_stamina,
        username,
      ]
    ));
    await wrote(statRows, username, saved, whole(...Object.values(saved)));
    if (!response) return [];
    return response;
  },
  /** Every column a player's stats row holds; setStats writes only the four that change in play. */
  setBaseStats: async (username: string, stats: StatsData) => {
    if (!username || !stats) return;
    username = username.toLowerCase();
    const saved = {
      health: stats.health,
      max_health: stats.max_health,
      stamina: stats.stamina,
      max_stamina: stats.max_stamina,
      xp: stats.xp,
      max_xp: stats.max_xp,
      level: stats.level,
      stat_critical_damage: stats.stat_critical_damage,
      stat_critical_chance: stats.stat_critical_chance,
      stat_armor: stats.stat_armor,
      stat_damage: stats.stat_damage,
      stat_avoidance: stats.stat_avoidance,
    };
    const response = await writing(statRows, username, () => query(
      "UPDATE stats SET health = ?, max_health = ?, stamina = ?, max_stamina = ?, xp = ?, max_xp = ?, level = ?, stat_critical_damage = ?, stat_critical_chance = ?, stat_armor = ?, stat_damage = ?, stat_avoidance = ? WHERE username = ?",
      [...Object.values(saved), username]
    ));
    await wrote(statRows, username, saved, whole(...Object.values(saved)));
    return response;
  },
  /**
   * With a `batch` (see services/batch), the write is added to it instead of sent: the gain is
   * worked from the stats the batch has so far, and is on the row held once the batch is kept.
   */
  increaseXp: async (username: string, xp: number, batch?: Batch) => {
    if (!username) return;
    username = username.toLowerCase();

    const pending = batch && await batch.pending(statRows, username, async () => {
      const start = { stats: (await player.getStats(username)) as StatsData, saved: {} as Partial<StatsData>, leveledUp: false };
      batch.kept(() => wrote(statRows, username, start.saved, whole(...Object.values(start.saved))));
      batch.after(async () => { if (start.leveledUp) await player.synchronizeStats(username); });
      batch.undone(() => statRows.drop(username));
      return start;
    });
    // A player with no stats row has nothing to add to.
    if (pending && Array.isArray(pending.stats)) return [];

    const stats = pending ? pending.stats : (await player.getStats(username)) as StatsData;
    let leveledUp = false;

    while (xp > 0) {
      const xpToLevel = stats.max_xp - stats.xp;
      if (xp >= xpToLevel) {
        stats.level++;
        xp -= xpToLevel;
        stats.xp = 0;
        leveledUp = true;

        stats.max_xp = player.getNewMaxXp(stats.level);

        stats.max_health = player.getMaxHealthForLevel(stats.level);
        stats.max_stamina = player.getMaxStaminaForLevel(stats.level);

        stats.health = stats.max_health;
        stats.stamina = stats.max_stamina;
      } else {
        stats.xp += xp;
        xp = 0;
      }
    }

    const saved: Partial<StatsData> = leveledUp
      ? { xp: stats.xp, max_xp: stats.max_xp, level: stats.level, max_health: stats.max_health, health: stats.health, max_stamina: stats.max_stamina, stamina: stats.stamina }
      : { xp: stats.xp, max_xp: stats.max_xp, level: stats.level };
    const sql = leveledUp
      ? "UPDATE stats SET xp = ?, max_xp = ?, level = ?, max_health = ?, health = ?, max_stamina = ?, stamina = ? WHERE username = ?"
      : "UPDATE stats SET xp = ?, max_xp = ?, level = ? WHERE username = ?";
    if (batch && pending) {
      Object.assign(pending.saved, saved);
      pending.leveledUp ||= leveledUp;
      batch.add({ sql, values: [...Object.values(saved), username] });
      return { xp: stats.xp, level: stats.level, max_xp: stats.max_xp };
    }
    const response = await writing(statRows, username, () => query(sql, [...Object.values(saved), username]));
    await wrote(statRows, username, saved, whole(...Object.values(saved)));
    if (leveledUp) {
      await player.synchronizeStats(username);
    }
    if (!response) return [];
    return {
      xp: stats.xp,
      level: stats.level,
      max_xp: stats.max_xp,
    };
  },
  getNewMaxXp: (level: number) => {
    return Math.floor(100 * Math.pow(1.1, level - 1));
  },
  getMaxHealthForLevel: (level: number) => {

    const baseHealth = 100;
    return Math.floor(baseHealth + Math.pow(level, 1.5) * 5);
  },
  getMaxStaminaForLevel: (level: number) => {

    const baseStamina = 100;
    return Math.floor(baseStamina + Math.pow(level, 1.5) * 3);
  },
  increaseLevel: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await writing(statRows, username, () => query(
      "UPDATE stats SET level = level + 1 WHERE username = ?",
      [username]
    ));
    // One more than whatever the database held: read it rather than work it out.
    await statRows.drop(username);
    return response;
  },
  getConfig: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const config = await configRows.get(username);
    return config ? [config] : [];
  },
  setConfig: async (session_id: string, data: any) => {
    if (!session_id) return;
    if (
      !data.fps ||
      typeof data.music_volume != "number" ||
      typeof data.effects_volume != "number" ||
      typeof data.muted != "boolean"
    )
      return [];
    const username = playerCache.get(session_id)?.username;
    if (!username) return [];
    const saved = {
      fps: data.fps,
      music_volume: data.music_volume || 0,
      effects_volume: data.effects_volume || 0,
    };
    const response = await writing(configRows, username, () => query(
      "UPDATE clientconfig SET fps = ?, music_volume = ?, effects_volume = ?, muted = ? WHERE username = ?",
      [
        saved.fps,
        saved.music_volume,
        saved.effects_volume,
        data.muted,
        username,
      ]
    ));
    // A yes or no is stored, and read back, as 1 or 0.
    await wrote(configRows, username, { ...saved, muted: data.muted ? 1 : 0 }, whole(...Object.values(saved)));
    if (!response) return [];
    return response;
  },
  isInPvPZone: async (
    map: string,
    position: PositionData,
    playerProperties: PlayerProperties
  ) => {
    const playerWidth = playerProperties.width || 32;
    const playerHeight = playerProperties.height || 32;

    const mapKey = map.replace(".json", "");

    // A world's no-pvp zones are a bitset (modules/worldmaps.ts), a Tiled map's are run lengths
    const worldNoPvp = getWorldMap(mapKey)?.nopvp;
    const pvpData = worldNoPvp ? null : await assetCache.getNested(mapKey, "nopvp");

    if (!worldNoPvp && (!pvpData || !Array.isArray(pvpData) || pvpData.length < 3)) return true;

    const mapPropertiesRaw = await assetCache.get("mapProperties") as MapProperties[];
    if (!mapPropertiesRaw) return true;

    const mapData = mapPropertiesRaw.find(m => m.name.replace(".json", "") === mapKey);
    if (!mapData) return true;
    const tileWidth = mapData.tileWidth;
    const tileHeight = mapData.tileHeight;

    const margin = 0.1;

    const left = Math.floor((position.x - playerWidth / 2 + margin) / tileWidth);
    const right = Math.floor((position.x + playerWidth / 2 - margin) / tileWidth);

    const top = Math.floor((position.y - playerHeight / 2 + playerHeight / 2 + margin) / tileHeight);
    const bottom = Math.floor((position.y + playerHeight / 2 - margin) / tileHeight);

    for (let tileY = top; tileY <= bottom; tileY++) {
      for (let tileX = left; tileX <= right; tileX++) {

        if (tileX < 0 || tileY < 0 || tileX >= mapData.width || tileY >= mapData.height) continue;

        const targetIndex = tileY * mapData.width + tileX;

        const tileValue = worldNoPvp ? worldNoPvp.isSet(tileX, tileY) : queryRLE(pvpData, targetIndex);

        if (tileValue !== 0) {
          return false;
        }
      }
    }

    return true;
  },
  checkCollisionSync: function (
    map: string,
    position: PositionData,
    playerProperties: PlayerProperties
  ) {
    const mapKey = map.replace(".json", "");
    const mapDataCached = mapCache.get(mapKey) ?? cacheWorldMap(mapKey);
    if (!mapDataCached) return { value: true, reason: "no_map_data" as const };

    const playerWidth = playerProperties.width || 32;
    const playerHeight = playerProperties.height || 32;
    const { warps, collisionRLE, collisionBits, width, height, tileWidth, tileHeight } = mapDataCached;

    for (const key in warps) {
      const warp = warps[key];
      if (
        // across, the position is the middle of the sprite (as the tile test below has it): a warp is met by
        // the player's own width centred on it, so a rectangle is entered as readily from its left as its right
        position.x + playerWidth / 2 > warp.position.x &&
        position.x - playerWidth / 2 < warp.position.x + warp.size.width &&
        position.y + playerHeight > warp.position.y &&
        position.y < warp.position.y + warp.size.height
      ) {
        return {
          value: true,
          reason: "warp_collision" as const,
          warp: { map: warp.map, x: warp.x, y: warp.y },
        };
      }
    }

    const margin = 0.1;

    const left = Math.floor((position.x - playerWidth / 2 + margin) / tileWidth);
    const right = Math.floor((position.x + playerWidth / 2 - margin) / tileWidth);

    const top = Math.floor((position.y - playerHeight / 2 + playerHeight / 2 + margin) / tileHeight);
    const bottom = Math.floor((position.y + playerHeight / 2 - margin) / tileHeight);

    for (let tileY = top; tileY <= bottom; tileY++) {
      for (let tileX = left; tileX <= right; tileX++) {

        if (tileX < 0 || tileY < 0 || tileX >= width || tileY >= height) continue;

        const tileIndex = tileY * width + tileX;
        const tileValue = collisionBits ? collisionBits.isSet(tileX, tileY) : collisionRLE ? queryRLE(collisionRLE, tileIndex) : 0;

        if (tileValue !== 0) return { value: true, reason: "tile_collision" as const, tile: { x: tileX, y: tileY } };
      }
    }

    return { value: false, reason: "no_collision" as const };
  },

  preloadMapCollision: async function (mapName: string): Promise<void> {
    const mapKey = mapName.replace(".json", "");
    if (mapCache.has(mapKey) || cacheWorldMap(mapKey)) return;

    const mapProperties = await assetCache.get("mapProperties") as MapProperties[];
    const mapData = mapProperties.find((m: any) => m.name.replace(".json", "") === mapKey);
    if (!mapData) {
      log.warn(`[preloadMapCollision] no mapProperties entry for "${mapKey}" - movement will be blocked (no_map_data)`);
      return;
    }

    let collisionData: any;
    try {
      const fetched = await assetCache.getNested(mapKey, "collision");
      collisionData = fetched !== undefined ? fetched : (await assetCache.get(mapKey))?.collision;
      if (!collisionData || !Array.isArray(collisionData)) {
        log.warn(`[preloadMapCollision] collision data for "${mapKey}" missing/not-array (${typeof collisionData}) - movement will be blocked`);
        return;
      }
    } catch (e) {
      log.warn(`[preloadMapCollision] fetch failed for "${mapKey}": ${e} - movement will be blocked`);
      return;
    }

    mapCache.set(mapKey, {
      warps: Array.isArray(mapData.warps)
        ? Object.fromEntries(
            (mapData.warps as WarpObject[]).map((warp, idx) => [warp.name ?? String(idx), warp])
          )
        : (mapData.warps || {}),
      collisionRLE: collisionData,
      width: collisionData[0],
      height: collisionData[1],
      tileWidth: mapData.tileWidth,
      tileHeight: mapData.tileHeight,
    });
  },

  checkIfWouldCollide: async function (
    map: string,
    position: PositionData,
    playerProperties: PlayerProperties,
    mapPropertiesCache?: any
  ) {
    const playerWidth = playerProperties.width || 32;
    const playerHeight = playerProperties.height || 32;
    const mapKey = map.replace(".json", "");

    let mapDataCached = mapCache.get(mapKey) ?? cacheWorldMap(mapKey);
    if (!mapDataCached) {

      const mapProperties = mapPropertiesCache || (await assetCache.get("mapProperties")) as MapProperties[];
      const mapData = mapProperties.find((m: any) => m.name.replace(".json", "") === mapKey);
      if (!mapData) return { value: true, reason: "no_map_data" };

      let collisionData: any;
      try {
        const fetched = await assetCache.getNested(mapKey, "collision");
        collisionData = fetched !== undefined ? fetched : (await assetCache.get(mapKey))?.collision;
        if (!collisionData || !Array.isArray(collisionData)) return { value: true, reason: "no_collision_data" };
      } catch (err: any) {
        return { value: true, reason: "redis_error" };
      }

      mapDataCached = {
        warps: Array.isArray(mapData.warps)
          ? Object.fromEntries(
              (mapData.warps as WarpObject[]).map((warp, idx) => [warp.name ?? String(idx), warp])
            )
          : (mapData.warps || {}),
        collisionRLE: collisionData,
        width: collisionData[0],
        height: collisionData[1],
        tileWidth: mapData.tileWidth,
        tileHeight: mapData.tileHeight,
      };

      mapCache.set(mapKey, mapDataCached);
    }

    const { warps, collisionRLE, collisionBits, width, height, tileWidth, tileHeight } = mapDataCached;

    for (const key in warps) {
      const warp = warps[key];
      if (
        // across, the position is the middle of the sprite (as the tile test below has it): a warp is met by
        // the player's own width centred on it, so a rectangle is entered as readily from its left as its right
        position.x + playerWidth / 2 > warp.position.x &&
        position.x - playerWidth / 2 < warp.position.x + warp.size.width &&
        position.y + playerHeight > warp.position.y &&
        position.y < warp.position.y + warp.size.height
      ) {
        return {
          value: true,
          reason: "warp_collision",
          warp: { map: warp.map, x: warp.x, y: warp.y },
        };
      }
    }

    const margin = 0.1;

    const left = Math.floor((position.x - playerWidth / 2 + margin) / tileWidth);
    const right = Math.floor((position.x + playerWidth / 2 - margin) / tileWidth);

    const top = Math.floor((position.y - playerHeight / 2 + playerHeight / 2 + margin) / tileHeight);
    const bottom = Math.floor((position.y + playerHeight / 2 - margin) / tileHeight);

    for (let tileY = top; tileY <= bottom; tileY++) {
      for (let tileX = left; tileX <= right; tileX++) {

        if (tileX < 0 || tileY < 0 || tileX >= width || tileY >= height) continue;

        const tileIndex = tileY * width + tileX;
        const tileValue = collisionBits ? collisionBits.isSet(tileX, tileY) : collisionRLE ? queryRLE(collisionRLE, tileIndex) : 0;

        if (tileValue !== 0) return { value: true, reason: "tile_collision", tile: { x: tileX, y: tileY } };
      }
    }

    return { value: false, reason: "no_collision" };
  },
  kick: async (username: string, wt: any) => {
    const session_id = sessionOf(username);
    if (session_id) {
      player.logout(session_id);
    }
    if (wt) wt.close();
  },
  ban: async (username: string, wt: any) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await writing(accountRows, username, () => query(
      "UPDATE accounts SET banned = 1 WHERE username = ?",
      [username]
    ));
    await accountRows.patch(username, { banned: 1 });
    const session_id = await player.getSession(username);
    if (session_id) {
      player.logout(session_id);
    }
    if (wt) wt.close();
    return response;
  },
  unban: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await writing(accountRows, username, () => query(
      "UPDATE accounts SET banned = 0 WHERE username = ?",
      [username]
    ));
    await accountRows.patch(username, { banned: 0 });
    return response;
  },
  canAttack: async (
    self: Player,
    target: Player,
    playerProperties: PlayerProperties,
    maxPathfindingDistance: number = 300
  ): Promise<{ value: boolean; reason?: string }> => {

    const isSelf = self.id === target.id || self.username === target.username;

    if (!self || !target) return { value: false, reason: "invalid" };

    if (target.isStealth || self.isStealth) return { value: false, reason: "path_blocked" };

    if (!self.stats || self.stats.health <= 0)
      return { value: false, reason: "dead" };

    if (
      !self.location ||
      !target.location ||
      target.location.map !== self.location.map
    )
      return { value: false, reason: "different_map" };

    if (self.isStealth || target.isStealth)
      return { value: false, reason: "stealth" };

    const targetPosition = target.location.position as unknown as PositionData;
    const selfPosition = self.location.position as unknown as PositionData;
    const direction = selfPosition.direction;

    if (!direction) {
      return { value: false, reason: "invalid_direction" };
    }

    const dx = targetPosition.x - selfPosition.x;
    const dy = targetPosition.y - selfPosition.y;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    const isFacingTarget = (targetAngle: number, tolerance: number = 45): boolean => {
      const minAngle = targetAngle - tolerance;
      const maxAngle = targetAngle + tolerance;

      if (minAngle < -180) {
        return angle >= (minAngle + 360) || angle <= maxAngle;
      } else if (maxAngle > 180) {
        return angle >= minAngle || angle <= (maxAngle - 360);
      }

      return angle >= minAngle && angle <= maxAngle;
    };

    const directionAngles: { [key: string]: number } = {
      right: 0,
      downright: 45,
      down: 90,
      downleft: 135,
      left: 180,
      upleft: -135,
      up: -90,
      upright: -45,
    };

    if (!isSelf) {
      const targetAngle = directionAngles[direction];
      if (targetAngle === undefined || !isFacingTarget(targetAngle)) {
        return { value: false, reason: "direction" };
      }
    }

    const isPvpAllowedTarget = await player.isInPvPZone(
      self.location.map,
      targetPosition,
      playerProperties
    );
    if (!isPvpAllowedTarget) return { value: false, reason: "nopvp" };
    const isPvpAllowedSelf = await player.isInPvPZone(
      self.location.map,
      selfPosition,
      playerProperties
    );
    if (!isPvpAllowedSelf) return { value: false, reason: "nopvp" };

    const hasPath = await hasLineOfSight(
      selfPosition.x,
      selfPosition.y,
      targetPosition.x,
      targetPosition.y,
      self.location.map,
      maxPathfindingDistance
    );

    if (!isSelf) {
      if (!hasPath) {
        // Distinguish "out of range" from "line of sight blocked"
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > maxPathfindingDistance) {
          return { value: false, reason: "range" };
        }
        return { value: false, reason: "path_blocked" };
      }
    }

    return { value: true, reason: "pvp" };
  },
  findClosestPlayer: (
    self: Player,
    players: Player[],
    range: number
  ): NullablePlayer => {
    if (!players) return null;
    if (!self.location?.position) return null;

    let closestPlayer = null;
    let closestDistance = range;
    const selfPosition = self.location.position as unknown as PositionData;
    for (const player of players) {
      if (player.location) {
        const position = player.location.position as unknown as PositionData;
        const distance = Math.sqrt(
          Math.pow(selfPosition.x - position.x, 2) +
            Math.pow(selfPosition.y - position.y, 2)
        );
        if (player.isStealth) continue;
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPlayer = player;
        }
      }
    }
    return closestPlayer;
  },

  findPlayersInFacingCone: (
    self: Player,
    players: Player[],
    range: number,
    coneAngle: number = 90
  ): Player[] => {
    if (!players || !self.location?.position) return [];

    const selfPosition = self.location.position as unknown as PositionData;
    const direction = selfPosition.direction || "down";

    const directionAngles: { [key: string]: number } = {
      right: 0,
      downright: 45,
      down: 90,
      downleft: 135,
      left: 180,
      upleft: -135,
      up: -90,
      upright: -45,
    };

    const facingAngle = directionAngles[direction] ?? 90;
    const tolerance = coneAngle / 2; // Divide cone angle in half for each side

    const isFacingTarget = (targetAngle: number): boolean => {
      const minAngle = facingAngle - tolerance;
      const maxAngle = facingAngle + tolerance;

      if (minAngle < -180) {
        return targetAngle >= (minAngle + 360) || targetAngle <= maxAngle;
      } else if (maxAngle > 180) {
        return targetAngle >= minAngle || targetAngle <= (maxAngle - 360);
      }

      return targetAngle >= minAngle && targetAngle <= maxAngle;
    };

    const playersInCone: Player[] = [];

    for (const player of players) {
      if (!player.location || player.isStealth || player.id === self.id) continue;

      const position = player.location.position as unknown as PositionData;
      const dx = position.x - selfPosition.x;
      const dy = position.y - selfPosition.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > range) continue;

      const angle = Math.atan2(dy, dx) * (180 / Math.PI);

      if (isFacingTarget(angle)) {
        playersInCone.push(player);
      }
    }

    // Sort by distance (closest first)
    playersInCone.sort((a, b) => {
      const posA = a?.location?.position as unknown as PositionData;
      const posB = b?.location?.position as unknown as PositionData;
      const distA = Math.sqrt(
        Math.pow(selfPosition.x - posA.x, 2) +
          Math.pow(selfPosition.y - posA.y, 2)
      );
      const distB = Math.sqrt(
        Math.pow(selfPosition.x - posB.x, 2) +
          Math.pow(selfPosition.y - posB.y, 2)
      );
      return distA - distB;
    });

    return playersInCone;
  },

  findClosestPlayerInCone: (
    self: Player,
    players: Player[],
    range: number,
    coneAngle: number = 90
  ): NullablePlayer => {
    const playersInCone = player.findPlayersInFacingCone(
      self,
      players,
      range,
      coneAngle
    );
    return playersInCone.length > 0 ? playersInCone[0] : null;
  },

  getNextTargetInCone: (
    self: Player,
    players: Player[],
    range: number,
    currentTargetId: string | null,
    coneAngle: number = 90
  ): NullablePlayer => {
    const playersInCone = player.findPlayersInFacingCone(
      self,
      players,
      range,
      coneAngle
    );

    if (playersInCone.length === 0) return null;
    if (!currentTargetId) return playersInCone[0];

    // Find current target index
    const currentIndex = playersInCone.findIndex(
      (p) => p.id === currentTargetId
    );

    // If current target not in cone or is last in list, return first
    if (currentIndex === -1 || currentIndex === playersInCone.length - 1) {
      return playersInCone[0];
    }

    // Return next target
    return playersInCone[currentIndex + 1];
  },
  canMount: (player: Player): boolean => {

    if (!player || !player.stats) return false;

    return true;
  },
  saveHotBarConfig: async (username: string, hotbar: any) => {
    if (!username) return;
    username = username.toLowerCase();
    const hotbarString = JSON.stringify(hotbar);
    const response = await writing(configRows, username, () => query(
      "UPDATE clientconfig SET hotbar_config = ? WHERE username = ?",
      [hotbarString, username]
    ));
    await wroteLayout(username, "hotbar_config", hotbarString);
    return response;
  },
  saveInventoryConfig: async (username: string, inventoryConfig: any) => {
    if (!username) return;
    username = username.toLowerCase();

    const inventoryString = JSON.stringify(inventoryConfig);

    const response = await writing(configRows, username, () => query(
      "UPDATE clientconfig SET inventory_config = ? WHERE username = ?",
      [inventoryString, username]
    ));
    await wroteLayout(username, "inventory_config", inventoryString);
    return response;
  },

  synchronizeStats: async (username: string) => {
    const id = await player.getSessionIdByUsername(username);
    const pcache = playerCache.get(id);
    if (!pcache) return;
    const currentStats = { ...pcache.stats };

    currentStats.total_max_health = currentStats.max_health;
    currentStats.total_max_stamina = currentStats.max_stamina;

    const baseStats = await player.getStats(username) as StatsData;
    if (baseStats) {
      currentStats.stat_critical_chance = baseStats.stat_critical_chance || 0;
      currentStats.stat_critical_damage = baseStats.stat_critical_damage || 0;
      currentStats.stat_armor = baseStats.stat_armor || 0;
      currentStats.stat_damage = baseStats.stat_damage || 0;
      currentStats.stat_avoidance = baseStats.stat_avoidance || 0;
    }

    const equippedItems = Object.values(pcache.equipment).filter((eqItem: any) => eqItem !== null);
    const items = [];
    for (const equippedItemName of equippedItems) {
      const itemDetails = pcache.inventory.find((invItem: any) =>
        invItem.name.toLowerCase() === (equippedItemName as string).toLowerCase()
      );
      if (itemDetails) {
        items.push(itemDetails);
      }
    }

    if (pcache.equipment) {
      for (const slot in pcache.equipment) {
        const item = pcache.equipment[slot];
        if (!item) continue;
        const itemData = items.find((it: any) => it.name.toLowerCase() === item.toLowerCase()) as StatsData;
        currentStats.total_max_health += itemData?.stat_health || 0;
        currentStats.total_max_stamina += itemData?.stat_stamina || 0;
        currentStats.stat_critical_chance += itemData?.stat_critical_chance || 0;
        currentStats.stat_critical_damage += itemData?.stat_critical_damage || 0;
        currentStats.stat_armor += itemData?.stat_armor || 0;
        currentStats.stat_damage += itemData?.stat_damage || 0;
        currentStats.stat_avoidance += itemData?.stat_avoidance || 0;
      }
    }

    // Resurrection Sickness survives every recompute while its wall clock
    // runs (totals are rebuilt from base + equipment each sync).
    if (isSick(pcache)) {
      applySicknessToStats(currentStats);
    }

    return currentStats;
  },
  whitelistAdd: async (username: string): Promise<{ success: boolean; message: string }> => {
    if (!username) return { success: false, message: "Username is required" };
    username = username.toLowerCase().trim();

    // Add to in-memory set
    if (realmWhitelist.has(username)) {
      return { success: false, message: `${username} is already whitelisted` };
    }

    realmWhitelist.add(username);

    try {
      const realmId = process.env.SERVER_ID || "default";
      await query("INSERT INTO whitelist (realm, username) VALUES (?, ?)", [realmId, username]);
      return { success: true, message: `Added ${username} to whitelist` };
    } catch (error: any) {
      realmWhitelist.delete(username);
      if (error?.code === 'ER_DUP_ENTRY' || error?.message?.includes('UNIQUE constraint')) {
        return { success: false, message: `${username} is already whitelisted` };
      }
      log.error(`Failed to add whitelist entry: ${error}`);
      return { success: false, message: "Failed to save whitelist to database" };
    }
  },
  whitelistRemove: async (username: string): Promise<{ success: boolean; message: string }> => {
    if (!username) return { success: false, message: "Username is required" };
    username = username.toLowerCase().trim();

    // Remove from in-memory set
    if (!realmWhitelist.has(username)) {
      return { success: false, message: `${username} is not whitelisted` };
    }

    realmWhitelist.delete(username);

    try {
      const realmId = process.env.SERVER_ID || "default";
      await query("DELETE FROM whitelist WHERE realm = ? AND username = ?", [realmId, username]);
      return { success: true, message: `Removed ${username} from whitelist` };
    } catch (error) {
      realmWhitelist.add(username);
      log.error(`Failed to remove whitelist entry: ${error}`);
      return { success: false, message: "Failed to remove whitelist from database" };
    }
  },
  GetPlayerLoginData: async (username: string) => {
    if (!username) return null;
    username = username.toLowerCase();

    const accountQuery = `
      SELECT a.id, a.username, a.map, a.position, a.direction, a.role,
             a.guest_mode, a.stealth, a.noclip, a.party_id, a.guild_id,
             a.is_dead, a.corpse_map, a.corpse_x, a.corpse_y
      FROM accounts a WHERE a.username = ?
    `;

    const result = await query(accountQuery, [username]) as any[];
    if (!result || result.length === 0) return null;

    const data = result[0];

    const [
      statsResult,
      permsResult,
      currencyResult,
      friendsResult,
      configResult,
      questResult,
      questProgressResult,
      equipResult,
      guildResult,
    ] = await Promise.all([
      query("SELECT max_health, health, max_stamina, stamina, xp, max_xp, level, stat_critical_damage, stat_critical_chance, stat_armor, stat_damage, stat_health, stat_stamina, stat_avoidance FROM stats WHERE username = ?", [username]) as Promise<any[]>,
      query("SELECT permissions FROM permissions WHERE username = ?", [username]) as Promise<any[]>,
      query("SELECT copper, silver, gold FROM currency WHERE username = ?", [username]) as Promise<any[]>,
      query("SELECT friends FROM friendslist WHERE username = ?", [username]) as Promise<any[]>,
      query("SELECT fps, music_volume, effects_volume, muted, hotbar_config, inventory_config FROM clientconfig WHERE username = ?", [username]) as Promise<any[]>,
      query("SELECT quest_id, state, accepted_at, completed_at, times_completed FROM quest_log WHERE username = ?", [username]) as Promise<any[]>,
      query("SELECT quest_id, objective_id, count FROM quest_objective_progress WHERE username = ?", [username]) as Promise<any[]>,
      query("SELECT head, body, helmet, necklace, shoulderguards, chestplate, wristguards, gloves, belt, pants, boots, ring_1, ring_2, trinket_1, trinket_2, weapon FROM equipment WHERE username = ?", [username]) as Promise<any[]>,
      data.guild_id ? query("SELECT name AS guild_name FROM guilds WHERE id = ?", [data.guild_id]) as Promise<any[]> : Promise.resolve([]),
    ]);

    const stats = statsResult?.[0] || {};
    const perms = permsResult?.[0]?.permissions || [];
    const currency = currencyResult?.[0] || {};
    const friends = friendsResult?.[0]?.friends || "";
    const config = configResult?.[0] || {};
    const questRows = questResult || [];
    const questProgressRows = questProgressResult || [];
    const equip = equipResult?.[0] || {};
    const guild = guildResult?.[0] || {};

    const questProgressByQuest = new Map<number, Record<number, number>>();
    for (const r of questProgressRows) {
      const qid = Number(r.quest_id);
      const bucket = questProgressByQuest.get(qid) || {};
      bucket[Number(r.objective_id)] = Number(r.count) || 0;
      questProgressByQuest.set(qid, bucket);
    }
    const questActive: QuestLogEntry[] = [];
    const questCompleted: number[] = [];
    for (const r of questRows) {
      const qid = Number(r.quest_id);
      if (r.state === "completed") {
        if (!questCompleted.includes(qid)) questCompleted.push(qid);
      } else {
        questActive.push({
          quest_id: qid,
          state: r.state === "ready" ? "ready" : "active",
          accepted_at: Number(r.accepted_at) || 0,
          completed_at: Number(r.completed_at) || 0,
          times_completed: Number(r.times_completed) || 0,
          progress: questProgressByQuest.get(qid) || {},
        });
      }
    }

    return {
      id: data.id,
      username: data.username,
      location: {
        map: data.map,
        position: {
          x: Number(data.position?.split(",")[0] || 0),
          y: Number(data.position?.split(",")[1] || 0),
          direction: data.direction || "down"
        }
      },
      permissions: perms,
      stats: {
        max_health: stats.max_health,
        total_max_health: stats.max_health,
        health: stats.health,
        max_stamina: stats.max_stamina,
        total_max_stamina: stats.max_stamina,
        stamina: stats.stamina,
        xp: stats.xp,
        max_xp: stats.max_xp,
        level: stats.level,
        stat_critical_chance: stats.stat_critical_chance || 0,
        stat_critical_damage: stats.stat_critical_damage || 0,
        stat_armor: stats.stat_armor || 0,
        stat_damage: stats.stat_damage || 0,
        stat_health: stats.stat_health || 0,
        stat_stamina: stats.stat_stamina || 0,
        stat_avoidance: stats.stat_avoidance || 0,
        absorbtion: 0
      },
      currency: {
        copper: currency.copper || 0,
        silver: currency.silver || 0,
        gold: currency.gold || 0
      },
      friends: friends ? friends.split(",").map((f: string) => f.trim()).filter((f: string) => f !== "") : [],
      party_id: data.party_id,
      guild_id: data.guild_id,
      guild_name: guild.guild_name || null,
      config: config.fps ? [{
        fps: config.fps,
        music_volume: config.music_volume,
        effects_volume: config.effects_volume,
        muted: config.muted,
        hotbar_config: config.hotbar_config || null,
        inventory_config: config.inventory_config || null
      }] : [],
      questlog: {
        active: questActive,
        completed: questCompleted,
      },
      isAdmin: data.role === 1,
      isGuest: data.guest_mode === 1,
      isStealth: data.stealth === 1,
      isNoclip: data.noclip === 1,
      isDead: Number(data.is_dead) || 0,
      corpse: data.corpse_map ? {
        map: data.corpse_map,
        x: Number(data.corpse_x) || 0,
        y: Number(data.corpse_y) || 0,
      } : null,
      equipment: {
        head: equip.head,
        body: equip.body,
        helmet: equip.helmet,
        necklace: equip.necklace,
        shoulderguards: equip.shoulderguards,
        chestplate: equip.chestplate,
        wristguards: equip.wristguards,
        gloves: equip.gloves,
        belt: equip.belt,
        pants: equip.pants,
        boots: equip.boots,
        ring_1: equip.ring_1,
        ring_2: equip.ring_2,
        trinket_1: equip.trinket_1,
        trinket_2: equip.trinket_2,
        weapon: equip.weapon
      }
    };
  },
};

export function clearMapCache(mapName?: string) {
  if (mapName) {
    const mapKey = mapName.replace(".json", "");
    mapCache.delete(mapKey);
    log.info(`Cleared map cache for: ${mapKey}`);
  } else {
    mapCache.clear();
    log.info("Cleared all map caches");
  }
}

export default player;
