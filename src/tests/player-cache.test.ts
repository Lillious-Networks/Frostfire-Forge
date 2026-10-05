import { afterAll, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// ------------------------------------------------------------ fake database
// The statement shapes systems/player.ts sends, run against in-memory tables.
// Anything else is an error: a read the caches should have answered shows up
// as a statement nobody expected.

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let queries: string[];
/** How many more writes are answered before the connection is lost. */
let writesLeft: number;
/** A write that is not answered was still made, as one that timed out can have been. Otherwise it was refused. */
let lostAfterWriting: boolean;
/** Every read fails, as on a lost connection. */
let readsFail: boolean;
/** The config columns come back parsed, as a JSON column gives them. Otherwise as the text written (SQLite). */
let parsedJson: boolean;

/** Tables whose number columns are whole: a fraction is rounded on the way in, as MySQL does. */
const WHOLE = ["stats", "clientconfig"];
const JSON_COLUMNS = ["hotbar_config", "inventory_config"];

const same = (held: any, wanted: any) => held != null && wanted != null && String(held).toLowerCase() === String(wanted).toLowerCase();

function stored(table: string, value: any): any {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && WHOLE.includes(table)) return Math.round(value);
  return value;
}

function literal(token: string, args: any[]): any {
  if (token === "?") return args.shift();
  if (token === "NULL") return null;
  if (token.startsWith("'")) return token.slice(1, -1);
  return Number(token);
}

function run(sql: string, params: any[] = []): any {
  const text = sql.replace(/\s+/g, " ").trim();
  const args = [...params];
  queries.push(text);
  if (readsFail && text.startsWith("SELECT")) throw new Error("database gone");

  const select = text.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (\w+) (=|LIKE) \?)?(?: ORDER BY (\w+))?(?: LIMIT (\d+))?$/);
  if (select) {
    const [, columns, table, column, op, order, limit] = select;
    const wanted = args.shift();
    const rows = (tables[table] || [])
      .filter((row) => !column || (op === "LIKE" ? String(row[column]).includes(String(wanted).replaceAll("%", "")) : same(row[column], wanted)))
      .sort((a, b) => (order ? String(a[order]).localeCompare(String(b[order])) : 0))
      .map((row) => {
        const out: Row = columns === "*" ? { ...row } : Object.fromEntries(columns.split(", ").map((name) => [name, row[name]]));
        for (const name of JSON_COLUMNS) {
          if (parsedJson && typeof out[name] === "string") out[name] = JSON.parse(out[name]);
        }
        return out;
      });
    return limit ? rows.slice(0, Number(limit)) : rows;
  }
  // A read of another system's table, by a cache of its own that an earlier test file left behind.
  if (text.startsWith("SELECT")) return [];

  const lost = writesLeft-- <= 0;
  if (lost && !lostAfterWriting) throw new Error("database gone");
  const result = write(text, args);
  if (lost) throw new Error("database gone");
  return result;
}

function write(text: string, args: any[]): any {
  const update = text.match(/^UPDATE (\w+) SET (.+?)(?: WHERE (\w+) = \?)?$/);
  if (update) {
    const [, table, sets, column] = update;
    const apply = sets.split(", ").map((part) => {
      const [, name, rhs] = part.match(/^(\w+) = (.+)$/)!;
      const more = rhs.match(/^(\w+) \+ (\d+)$/);
      if (more) return (row: Row) => { row[name] = row[more[1]] + Number(more[2]); };
      const value = stored(table, literal(rhs, args));
      return (row: Row) => { row[name] = value; };
    });
    const wanted = args.shift();
    const rows = tables[table].filter((row) => !column || same(row[column], wanted));
    for (const row of rows) for (const assign of apply) assign(row);
    return { affectedRows: rows.length };
  }

  const insert = text.match(/^INSERT INTO (\w+) \((.+?)\) VALUES \((.+?)\)$/);
  if (insert) {
    const [, table, columns, values] = insert;
    const tokens = values.split(", ");
    const row: Row = {};
    columns.split(", ").forEach((name, i) => { row[name] = stored(table, literal(tokens[i], args)); });
    // The columns an account is not given take their defaults.
    (tables[table] ||= []).push(table === "accounts" ? { ...account(nextId++, row.username), ...row } : row);
    return { affectedRows: 1 };
  }

  if (text === "TRUNCATE TABLE parties") {
    tables.parties = [];
    return { affectedRows: 0 };
  }
  const remove = text.match(/^DELETE FROM (\w+)(?: WHERE (\w+) (IN \(SELECT username FROM accounts WHERE guest_mode = 1\)|= 1))?$/);
  if (remove) {
    const [, table, column, test] = remove;
    const guests = tables.accounts.filter((row) => row.guest_mode === 1).map((row) => row.username);
    const before = (tables[table] || []).length;
    tables[table] = (tables[table] || []).filter((row) => (!column ? false : test === "= 1" ? row[column] !== 1 : !guests.includes(row[column])));
    return { affectedRows: before - tables[table].length };
  }

  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => ({
  default: async (sql: string, params: any[] = []) => run(sql, params),
}));

// The caches of other systems are told by name when this one writes their
// tables. What they were told is kept: those systems are not this file's to
// load, and a table of theirs is not read again from this fake database.
const realCache = { ...(await import("../services/datacache")) };
let told: string[];
mock.module("../services/datacache", () => ({
  ...realCache,
  dropRows: async (name: string, key: string | number) => {
    told.push(`${name} ${String(key).toLowerCase()}`);
    await realCache.dropRows(name, key);
  },
  dropAllRows: async (name: string) => {
    told.push(`${name} *`);
    await realCache.dropAllRows(name);
  },
  reloadTable: async (name: string) => {
    told.push(`${name} reload`);
  },
}));

const { clearCaches, dropRows, forgetPlayer, refreshPlayer } = realCache;
const { default: playerCache } = await import("../services/playermanager");
const { Events, listener } = await import("../systems/events");
const { default: player } = await import("../systems/player");

// ------------------------------------------------------------------ fixtures

const SESSIONS = ["6101", "6102", "6103"];
let nextId: number;

function account(id: number, username: string, over: Row = {}): Row {
  return {
  id, username, email: `${username}@example.test`, token: null, session_id: null, online: 0, verified: 0, banned: 0, role: 0,
    guest_mode: 0, stealth: 0, noclip: 0, party_id: null, guild_id: null, is_dead: 0, corpse_map: null, corpse_x: null, corpse_y: null,
    map: "overworld", position: "320,480", direction: "down", ...over,
  };
}
const stats = (username: string, over: Row = {}): Row => ({
  id: 1, username, health: 80, max_health: 100, stamina: 60, max_stamina: 100, xp: 40, max_xp: 100, level: 1,
  stat_critical_damage: 10, stat_critical_chance: 12, stat_armor: 3, stat_damage: 4, stat_health: 0, stat_stamina: 0, stat_avoidance: 5, ...over,
});
const config = (username: string, over: Row = {}): Row => ({
  id: 1, username, fps: 60, music_volume: 50, effects_volume: 50, muted: 0, hotbar_config: null, inventory_config: null, ...over,
});

const row = (username: string, table = "accounts") => tables[table].find((r) => r.username === username)!;

/** Put a player online, as the receiver does once a login is through. */
function online(id: string, username: string, over: Row = {}): any {
  const held = row(username);
  held.session_id = id;
  held.online = 1;
  const live = { id, userid: held.id, username, location: { map: "overworld", position: { x: 900, y: 700, direction: "left" } }, ...over };
  playerCache.add(id, live);
  return live;
}

/** What `read` answers, having checked it did so without the database. */
async function fromCache<T>(read: () => Promise<T>): Promise<T> {
  const before = queries.length;
  const answer = await read();
  expect(queries.slice(before)).toEqual([]);
  return answer;
}

/** The statements `work` sent. */
async function sentBy(work: () => Promise<unknown>): Promise<string[]> {
  const before = queries.length;
  await work();
  return queries.slice(before);
}

const location = (username: string) => player.getLocation({ username } as any);

beforeEach(async () => {
  for (const id of SESSIONS) playerCache.remove(id);
  await clearCaches();
  told = [];
  writesLeft = Infinity;
  lostAfterWriting = false;
  readsFail = false;
  parsedJson = false;
  nextId = 5000;
  tables = {
    accounts: [
      account(4301, "pc_boss", { role: 1, stealth: 1, noclip: 1 }),
      account(4302, "pc_mod", { role: 1 }),
      account(4303, "pc_hero"),
      account(4304, "pc_ally", { party_id: 9, guild_id: 7 }),
      account(4305, "pc_exile", { banned: 1, is_dead: 1 }),
      account(4306, "guest_pc", { guest_mode: 1 }),
    ],
    stats: [stats("pc_hero"), stats("pc_ally"), stats("guest_pc")],
    clientconfig: [config("pc_hero"), config("guest_pc")],
    inventory: [{ username: "pc_hero", item: "Potion" }, { username: "guest_pc", item: "Potion" }],
    quest_log: [{ username: "guest_pc" }],
    currency: [{ username: "guest_pc", copper: 1 }],
    collectables: [{ username: "guest_pc", type: "mount", item: "unicorn" }],
    equipment: [{ username: "guest_pc" }],
    learned_spells: [{ username: "guest_pc", spell: "frost_bolt" }],
    permissions: [{ username: "guest_pc", permissions: "" }],
    friendslist: [{ username: "guest_pc", friends: "" }],
    parties: [{ id: 9, leader: "pc_ally", members: "pc_ally" }],
    guilds: [{ id: 7, name: "Frostguard", leader: "pc_ally", members: "pc_ally" }, { id: 8, name: "Visitors", leader: "guest_pc", members: "guest_pc" }],
  };
  // As at startup: the names of the accounts are read with the other tables, before anything asks.
  queries = [];
  await player.searchAccounts("pc_", 1);
  queries = [];
});

afterAll(() => {
  for (const id of SESSIONS) playerCache.remove(id);
  setSystemTime();
  mock.module("../services/datacache", () => realCache);
});

// --------------------------------------------------------------- who is online

describe("who is online is answered from the players held, never the database", () => {
  test("a username's session is the one it is online under, in any case", async () => {
    online("6101", "pc_hero");
    queries = [];
    expect(await player.getSessionIdByUsername("PC_Hero")).toBe("6101");
    expect(await player.getSession("pc_hero")).toBe("6101");
    expect(await player.isOnline("pc_hero")).toEqual([{ online: 1 }]);
    expect(queries).toEqual([]);
  });

  test("a player who is not online has no session, whatever the database still holds", async () => {
    // Left behind by a server that stopped without logging its players out.
    row("pc_hero").session_id = "5555";
    expect(await player.getSessionIdByUsername("pc_hero")).toBeUndefined();
    expect(await player.getSession("pc_hero")).toBeUndefined();
    expect(await player.getSessionIdByUsername("pc_nobody")).toBeUndefined();
    expect(await player.getSessionIdByUsername("")).toBeUndefined();
    expect(await player.isOnline("pc_hero")).toEqual([{ online: 0 }]);
    expect(queries).toEqual([]);
  });

  test("a session's username and map, and the players on a map", async () => {
    online("6101", "pc_hero");
    // A map no other test file leaves players on: the players held are shared.
    online("6102", "pc_ally", { location: { map: "pc_cave", position: { x: 10.4, y: 20.6, direction: "up" } } });
    queries = [];

    expect(await player.getUsernameBySession("6101")).toEqual([{ username: "pc_hero", id: 4303 }]);
    expect(await player.getUsernameBySession("6199")).toEqual([]);
    expect(await player.getUsernameBySession("")).toBeUndefined();
    expect(await player.getMap("6102")).toBe("pc_cave");
    expect(await player.getMap("6199")).toBeUndefined();
    expect(await player.getPlayers("pc_cave")).toEqual([{ username: "pc_ally", id: "6102", position: "10,21", map: "pc_cave" }]);
    expect(await player.getPlayers("")).toBeUndefined();
    expect(queries).toEqual([]);
  });

  test("kick logs out the session the player is online under, and only then", async () => {
    online("6101", "pc_hero");
    queries = [];
    let closed = 0;
    const wt = { close: () => { closed++; } };

    await player.kick("pc_hero", wt);
    expect(queries).toEqual(["UPDATE accounts SET token = NULL, online = ?, session_id = NULL, verification_code = NULL, verified = ? WHERE session_id = ?"]);
    expect(row("pc_hero").session_id).toBeNull();

    queries = [];
    await player.kick("pc_ally", wt);
    expect(queries).toEqual([]);
    expect(closed).toBe(2);
  });

  test("an online player's stats are put together without the database once their base stats are held", async () => {
    online("6101", "pc_hero", { stats: { health: 80, max_health: 100, stamina: 60, max_stamina: 100 }, equipment: {}, inventory: [] });
    const first = await player.synchronizeStats("pc_hero");
    expect(first).toMatchObject({ total_max_health: 100, stat_armor: 3, stat_damage: 4, stat_avoidance: 5 });
    expect(await fromCache(() => player.synchronizeStats("pc_hero"))).toEqual(first);
    expect(await fromCache(() => player.synchronizeStats("pc_ally"))).toBeUndefined();
  });
});

// -------------------------------------------------------------- account rows

describe("what the engine knows of an account", () => {
  const READS: Record<string, { read: () => Promise<any>; answer: any; loads: number }> = {
    isAdmin: { read: () => player.isAdmin("PC_Boss"), answer: true, loads: 1 },
    isGuest: { read: () => player.isGuest("guest_pc"), answer: true, loads: 1 },
    isStealth: { read: () => player.isStealth("pc_boss"), answer: true, loads: 1 },
    isNoclip: { read: () => player.isNoclip("pc_boss"), answer: true, loads: 1 },
    isBanned: { read: () => player.isBanned("pc_exile"), answer: [{ banned: 1 }], loads: 1 },
    getPartyIdByUsername: { read: () => player.getPartyIdByUsername("pc_ally"), answer: 9, loads: 1 },
    findByUsername: { read: () => player.findByUsername("PC_Hero"), answer: [{ username: "pc_hero" }], loads: 1 },
    findPlayerInDatabase: { read: () => player.findPlayerInDatabase("pc_exile"), answer: [{ username: "pc_exile", banned: 1 }], loads: 1 },
    "findAccount by username": { read: () => player.findAccount("pc_exile"), answer: { id: 4305, username: "pc_exile", session_id: null, banned: 1, is_dead: 1 }, loads: 1 },
    // The id finds the name, the name finds the row.
    "findAccount by id": { read: () => player.findAccount(undefined, 4305), answer: { id: 4305, username: "pc_exile", session_id: null, banned: 1, is_dead: 1 }, loads: 2 },
    getLocation: { read: () => location("pc_hero"), answer: { map: "overworld", position: { x: 320, y: 480, direction: "down" } }, loads: 1 },
    // Everything held of the account, and nothing the gateway writes.
    getAccount: {
      read: () => player.getAccount("PC_Ally"),
      answer: {
        id: 4304, username: "pc_ally", role: 0, banned: 0, guest_mode: 0, stealth: 0, noclip: 0, is_dead: 0, corpse_map: null, corpse_x: null, corpse_y: null,
        map: "overworld", position: "320,480", direction: "down", party_id: 9, guild_id: 7,
      },
      loads: 1,
    },
  };

  for (const [name, { read, answer, loads }] of Object.entries(READS)) {
    test(`${name} reads the database the first time and the cache after`, async () => {
      expect(await read()).toEqual(answer);
      expect(queries).toHaveLength(loads);
      expect(await fromCache(read)).toEqual(answer);
      expect(await fromCache(read)).toEqual(answer);
    });
  }

  test("every question about one account is answered from the one row", async () => {
    expect(await player.isAdmin("pc_boss")).toBe(true);
    expect(await fromCache(() => player.isStealth("pc_boss"))).toBe(true);
    expect(await fromCache(() => player.isGuest("pc_boss"))).toBe(false);
    expect(await fromCache(() => player.findAccount("pc_boss"))).toMatchObject({ id: 4301, banned: 0 });
    expect(await fromCache(() => player.findPlayerInDatabase("pc_boss"))).toEqual([{ username: "pc_boss", banned: 0 }]);
    expect(queries).toHaveLength(1);
  });

  test("an account that does not exist answers as it did from the database", async () => {
    expect(await player.isAdmin("pc_nobody")).toBe(false);
    expect(await player.isGuest("pc_nobody")).toBe(false);
    expect(await player.isStealth("pc_nobody")).toBe(false);
    expect(await player.isNoclip("pc_nobody")).toBe(false);
    expect(await player.isBanned("pc_nobody")).toEqual([]);
    expect(await player.getPartyIdByUsername("pc_nobody")).toBeUndefined();
    expect(await player.getPartyIdByUsername("pc_hero")).toBeNull();
    expect(await player.findByUsername("pc_nobody")).toEqual([]);
    expect(await player.findPlayerInDatabase("pc_nobody")).toEqual([]);
    expect(await player.findAccount("pc_nobody")).toBeNull();
    expect(await player.findAccount(undefined, 9999)).toBeNull();
    expect(await location("pc_nobody")).toBeNull();
  });

  test("nothing asked for answers nothing, without a read", async () => {
    expect(await player.isAdmin("")).toBeUndefined();
    expect(await player.isGuest("")).toBeUndefined();
    expect(await player.isBanned("")).toBeUndefined();
    expect(await player.findByUsername("")).toBeUndefined();
    expect(await player.findPlayerInDatabase()).toBeUndefined();
    expect(await player.findAccount()).toBeNull();
    expect(queries).toEqual([]);
  });

  test("the session of an account is who is online, not a column of the row", async () => {
    row("pc_exile").session_id = "5555";
    expect((await player.findAccount("pc_exile"))!.session_id).toBeNull();
    online("6101", "pc_hero");
    expect((await player.findAccount("pc_hero"))!.session_id).toBe("6101");
    expect((await player.findAccount(undefined, 4303))!.session_id).toBe("6101");
  });

  test("a session id finds the account of the player online under it", async () => {
    online("6101", "pc_hero");
    expect(await player.findPlayerInDatabase(undefined, "6101")).toEqual([{ username: "pc_hero", banned: 0 }]);
    expect(await player.findPlayerInDatabase("pc_hero", "6101")).toEqual([{ username: "pc_hero", banned: 0 }]);
    expect(await player.findPlayerInDatabase("pc_exile", "6101")).toEqual([{ username: "pc_exile", banned: 1 }, { username: "pc_hero", banned: 0 }]);
    expect(await player.findPlayerInDatabase(undefined, "9999")).toEqual([]);
    expect(await player.getLocation({ id: "6101" } as any)).toEqual({ map: "overworld", position: { x: 320, y: 480, direction: "down" } });
  });

  test("an id and a name that stand for one account never disagree", async () => {
    expect((await player.findAccount(undefined, 4303))!.banned).toBe(0);
    await player.ban("pc_hero", null);
    expect((await fromCache(() => player.findAccount(undefined, 4303)))!.banned).toBe(1);
    expect((await fromCache(() => player.findAccount("pc_hero")))!.banned).toBe(1);
  });

  test("an id whose name was given to a new account is looked up again", async () => {
    expect((await player.findAccount(undefined, 4303))!.username).toBe("pc_hero");
    // The account is deleted and the name registered again: the gateway's doing, seen here at the next login.
    tables.accounts = tables.accounts.filter((r) => r.username !== "pc_hero");
    tables.accounts.push(account(4999, "pc_hero"));
    await refreshPlayer("pc_hero");

    expect(await player.findAccount(undefined, 4303)).toBeNull();
    expect(await player.findAccount(undefined, 4303)).toBeNull();
    expect((await player.findAccount(undefined, 4999))!.username).toBe("pc_hero");
  });

  test("a row another system wrote is read again once that system says so", async () => {
    expect(await player.getPartyIdByUsername("pc_hero")).toBeNull();
    row("pc_hero").party_id = 12;
    expect(await fromCache(() => player.getPartyIdByUsername("pc_hero"))).toBeNull();
    await dropRows("accounts", "PC_Hero");
    expect(await player.getPartyIdByUsername("pc_hero")).toBe(12);
  });

  test("a player's row is read again when they log in and let go when they leave", async () => {
    expect(await player.isAdmin("pc_hero")).toBe(false);
    row("pc_hero").role = 1;
    await refreshPlayer("pc_hero");
    expect(await fromCache(() => player.isAdmin("pc_hero"))).toBe(true);

    await forgetPlayer("pc_hero");
    expect(await sentBy(() => player.isAdmin("pc_hero"))).toHaveLength(1);
  });
});

// ------------------------------------------------------------ account search

describe("a search of the accounts", () => {
  /** What the server runs on every tick of its clock, a second apart. */
  const tick = () => {
    const refresh = listener.listeners(Events.SERVER_TICK).find((run) => run.name === "refreshAccountNames");
    if (!refresh) throw new Error("Nothing reads the account names again on the server's tick");
    return (refresh as () => Promise<void>)();
  };
  const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));
  const MINUTE = 60 * 1000;

  test("is answered from the names read at startup, never the database", async () => {
    await clearCaches();
    expect(await sentBy(() => player.searchAccounts("pc_", 3))).toEqual(["SELECT id, username FROM accounts"]);

    expect(await fromCache(() => player.searchAccounts("pc_", 3))).toEqual([{ id: 4304, username: "pc_ally" }, { id: 4301, username: "pc_boss" }, { id: 4305, username: "pc_exile" }]);
    expect(await fromCache(() => player.searchAccounts("hero", 5))).toEqual([{ id: 4303, username: "pc_hero" }]);
    expect(await fromCache(() => player.searchAccounts("nobody", 5))).toEqual([]);
    expect(await fromCache(() => player.searchAccounts("", 5))).toEqual([]);
  });

  test("matches as LIKE did: anywhere in the name, in any case, _ for any one character and % for any run", async () => {
    tables.accounts.push(account(4401, "pcxboss"), account(4402, "PC_Shout"), account(4403, "a.b"), account(4404, "axb"));
    await clearCaches();
    const names = async (search: string) => (await player.searchAccounts(search, 20)).map((found) => found.username);

    expect(await names("BOSS")).toEqual(["pc_boss", "pcxboss"]);
    expect(await names("shout")).toEqual(["PC_Shout"]);
    expect(await names("pc_boss")).toEqual(["pc_boss", "pcxboss"]);
    expect(await names("c_b")).toEqual(["pc_boss", "pcxboss"]);
    expect(await names("p%ss")).toEqual(["pc_boss", "pcxboss"]);
    expect(await names("_____boss")).toEqual([]);
    // Nothing else stands for anything.
    expect(await names("a.b")).toEqual(["a.b"]);
    expect(await names("(")).toEqual([]);
    expect(await names("[a-z]")).toEqual([]);
  });

  test("gives the first names in order, as many as were asked for and never none", async () => {
    const names = async (limit: number) => (await player.searchAccounts("pc_", limit)).map((found) => found.username);
    expect(await names(20)).toEqual(["pc_ally", "pc_boss", "pc_exile", "pc_hero", "pc_mod"]);
    expect(await names(2)).toEqual(["pc_ally", "pc_boss"]);
    expect(await names(2.9)).toEqual(["pc_ally", "pc_boss"]);
    expect(await names(0)).toEqual(["pc_ally"]);
    expect(await names(NaN)).toEqual(["pc_ally"]);
  });

  test("hands out copies: changing an answer changes nothing held", async () => {
    const found = await player.searchAccounts("hero", 5);
    found[0].username = "mine";
    expect(await player.searchAccounts("hero", 5)).toEqual([{ id: 4303, username: "pc_hero" }]);
  });

  test("finds an account the gateway made as soon as it logs in", async () => {
    tables.accounts.push(account(4400, "pc_newcomer"));
    expect(await fromCache(() => player.searchAccounts("newcomer", 5))).toEqual([]);

    // A login reads the player's rows again.
    await refreshPlayer("PC_Newcomer");
    expect(await fromCache(() => player.searchAccounts("newcomer", 5))).toEqual([{ id: 4400, username: "pc_newcomer" }]);

    // Someone already listed is listed once.
    await refreshPlayer("pc_newcomer");
    await refreshPlayer("pc_hero");
    expect(await fromCache(() => player.searchAccounts("pc_", 20))).toHaveLength(6);
  });

  test("lists a name that was given to a new account once, under its new id", async () => {
    tables.accounts = tables.accounts.filter((r) => r.username !== "pc_hero");
    tables.accounts.push(account(4999, "pc_hero"));
    await refreshPlayer("pc_hero");
    expect(await fromCache(() => player.searchAccounts("hero", 5))).toEqual([{ id: 4999, username: "pc_hero" }]);
  });

  test("reads the names again on the server's tick, every five minutes", async () => {
    try {
      // Whenever it last read them, five minutes from now it is due.
      await tick();
      later(5 * MINUTE);
      tables.accounts.push(account(4400, "pc_newcomer"));
      expect(await sentBy(tick)).toEqual(["SELECT id, username FROM accounts"]);
      expect(await fromCache(() => player.searchAccounts("newcomer", 5))).toEqual([{ id: 4400, username: "pc_newcomer" }]);

      tables.accounts.push(account(4401, "pc_latecomer"));
      expect(await sentBy(tick)).toEqual([]);
      later(5 * MINUTE - 1000);
      expect(await sentBy(tick)).toEqual([]);
      expect(await fromCache(() => player.searchAccounts("latecomer", 5))).toEqual([]);

      later(1000);
      expect(await sentBy(tick)).toEqual(["SELECT id, username FROM accounts"]);
      expect(await sentBy(tick)).toEqual([]);
      expect(await fromCache(() => player.searchAccounts("latecomer", 5))).toEqual([{ id: 4401, username: "pc_latecomer" }]);
    } finally {
      setSystemTime();
    }
  });

  test("a clock that is set back does not put the next reading off", async () => {
    try {
      await tick();
      later(5 * MINUTE);
      await tick();
      // An hour earlier than the last reading: how long ago that was is no longer known.
      later(-60 * MINUTE);
      expect(await sentBy(tick)).toEqual(["SELECT id, username FROM accounts"]);
      expect(await sentBy(tick)).toEqual([]);
    } finally {
      setSystemTime();
    }
  });

  test("when the names cannot be read again, the tick says so and the next search reads them", async () => {
    const logged = spyOn(console, "log").mockImplementation(() => {});
    try {
      await tick();
      later(5 * MINUTE);
      readsFail = true;
      await tick();
      readsFail = false;
      expect(logged.mock.calls.some((call) => String(call[0]).includes("account names"))).toBe(true);

      tables.accounts.push(account(4400, "pc_newcomer"));
      expect(await sentBy(async () => {
        expect(await player.searchAccounts("newcomer", 5)).toEqual([{ id: 4400, username: "pc_newcomer" }]);
      })).toEqual(["SELECT id, username FROM accounts"]);
    } finally {
      logged.mockRestore();
      setSystemTime();
    }
  });
});

describe("a write to an account", () => {
  test("toggleAdmin writes the role, and the next check has it without asking", async () => {
    expect(await player.isAdmin("pc_hero")).toBe(false);
    expect(await sentBy(async () => { expect(await player.toggleAdmin("PC_Hero")).toBe(true); })).toEqual(["UPDATE accounts SET role = ? WHERE username = ?"]);
    expect(row("pc_hero").role).toBe(1);
    expect(await fromCache(() => player.isAdmin("pc_hero"))).toBe(true);
  });

  test("taking the role away clears stealth and noclip with it", async () => {
    expect(await player.toggleAdmin("pc_boss")).toBe(false);
    expect(row("pc_boss")).toMatchObject({ role: 0, stealth: 0, noclip: 0 });
    expect(await fromCache(() => player.isAdmin("pc_boss"))).toBe(false);
    expect(await fromCache(() => player.isStealth("pc_boss"))).toBe(false);
    expect(await fromCache(() => player.isNoclip("pc_boss"))).toBe(false);
  });

  test("toggleAdmin on a name with no account changes nothing", async () => {
    expect(await player.toggleAdmin("pc_nobody")).toBe(false);
    expect(await player.toggleAdmin("")).toBeUndefined();
    expect(queries.filter((q) => !q.startsWith("SELECT"))).toEqual([]);
  });

  test("toggleStealth is for admins, toggleNoclip for anyone", async () => {
    expect(await player.toggleStealth("pc_mod")).toBe(true);
    expect(row("pc_mod").stealth).toBe(1);
    expect(await fromCache(() => player.isStealth("pc_mod"))).toBe(true);
    expect(await player.toggleStealth("pc_mod")).toBe(false);
    expect(row("pc_mod").stealth).toBe(0);

    expect(await player.toggleStealth("pc_hero")).toBe(false);
    expect(row("pc_hero").stealth).toBe(0);
    expect(await player.toggleStealth("pc_nobody")).toBe(false);

    expect(await player.toggleNoclip("pc_hero")).toBe(true);
    expect(row("pc_hero").noclip).toBe(1);
    expect(await fromCache(() => player.isNoclip("pc_hero"))).toBe(true);
    expect(await player.toggleNoclip("pc_hero")).toBe(false);
    expect(row("pc_hero").noclip).toBe(0);
    expect(await player.toggleNoclip("pc_nobody")).toBe(false);
  });

  test("ban and unban are seen by every lookup of the account", async () => {
    expect((await player.findAccount("pc_hero"))!.banned).toBe(0);
    expect<any>(await player.ban("PC_Hero", null)).toEqual({ affectedRows: 1 });
    expect(row("pc_hero").banned).toBe(1);
    expect((await fromCache(() => player.findAccount("pc_hero")))!.banned).toBe(1);
    expect(await fromCache(() => player.isBanned("pc_hero"))).toEqual([{ banned: 1 }]);
    expect(await fromCache(() => player.findPlayerInDatabase("pc_hero"))).toEqual([{ username: "pc_hero", banned: 1 }]);

    expect<any>(await player.unban("pc_hero")).toEqual({ affectedRows: 1 });
    expect(row("pc_hero").banned).toBe(0);
    expect((await fromCache(() => player.findAccount("pc_hero")))!.banned).toBe(0);
  });

  test("banning a player who is online logs their session out and closes their connection", async () => {
    online("6101", "pc_hero");
    let closed = 0;
    expect(await sentBy(() => player.ban("pc_hero", { close: () => { closed++; } }))).toEqual([
      "UPDATE accounts SET banned = 1 WHERE username = ?",
      "UPDATE accounts SET token = NULL, online = ?, session_id = NULL, verification_code = NULL, verified = ? WHERE session_id = ?",
    ]);
    expect(row("pc_hero")).toMatchObject({ banned: 1, session_id: null });
    expect(closed).toBe(1);
  });

  test("setLocation writes where the session's player is, and the row held follows", async () => {
    online("6101", "pc_hero");
    await location("pc_hero");
    expect<any>(await player.setLocation("6101", "cave", { x: 12.4, y: 99.6, direction: "up" })).toEqual({ affectedRows: 1 });
    expect(row("pc_hero")).toMatchObject({ map: "cave", position: "12,100", direction: "up" });
    expect(await fromCache(() => location("pc_hero"))).toEqual({ map: "cave", position: { x: 12, y: 100, direction: "up" } });
  });

  test("setLocation for a session the database gives to nobody leaves the row held alone", async () => {
    online("6101", "pc_hero");
    // Logged in somewhere else since: the gateway gave the account another session.
    row("pc_hero").session_id = "7777";
    await location("pc_hero");
    expect<any>(await player.setLocation("6101", "cave", { x: 1, y: 2, direction: "up" })).toEqual({ affectedRows: 0 });
    expect(await fromCache(() => location("pc_hero"))).toEqual({ map: "overworld", position: { x: 320, y: 480, direction: "down" } });
  });

  test("a save made for a session that has already left the players held is read once the player is let go", async () => {
    // A disconnect: the player leaves the players held, is saved by session id, and is then forgotten.
    online("6101", "pc_hero");
    await location("pc_hero");
    playerCache.remove("6101");
    await player.setLocation("6101", "cave", { x: 7, y: 8, direction: "up" });
    expect(row("pc_hero")).toMatchObject({ map: "cave", position: "7,8" });
    await forgetPlayer("pc_hero");
    expect(await location("pc_hero")).toEqual({ map: "cave", position: { x: 7, y: 8, direction: "up" } });
  });

  test("setLocationByUsername, returnHome and setDeadState are seen without asking", async () => {
    await location("pc_ally");
    await player.setLocationByUsername("PC_Ally", "cave", { x: 5, y: 6, direction: "left" });
    expect(row("pc_ally")).toMatchObject({ map: "cave", position: "5,6", direction: "left" });
    expect(await fromCache(() => location("pc_ally"))).toEqual({ map: "cave", position: { x: 5, y: 6, direction: "left" } });

    online("6102", "pc_ally");
    await player.returnHome("6102");
    // The default map is the server's setting.
    const home = row("pc_ally").map;
    expect(home).not.toBe("cave");
    expect(row("pc_ally").position).toBe("0,0");
    expect(await fromCache(() => location("pc_ally"))).toEqual({ map: home, position: { x: 0, y: 0, direction: "left" } });

    await player.setDeadState("pc_ally", 2, { map: "cave", x: 4.6, y: 8.2 });
    expect(row("pc_ally")).toMatchObject({ is_dead: 2, corpse_map: "cave", corpse_x: 5, corpse_y: 8 });
    expect((await fromCache(() => player.findAccount("pc_ally")))!.is_dead).toBe(2);
    await player.setDeadState("pc_ally", 0, null);
    expect(row("pc_ally")).toMatchObject({ is_dead: 0, corpse_map: null, corpse_x: null, corpse_y: null });
    expect((await fromCache(() => player.findAccount("pc_ally")))!.is_dead).toBe(0);
  });

  test("a write the database stores differently from what it was given has the row read again", async () => {
    await location("pc_hero");
    // No direction: the column keeps what it had or takes its default, which is the database's to say.
    await player.setLocationByUsername("pc_hero", "cave", { x: 1, y: 2 } as any);
    row("pc_hero").direction = "down";
    expect(await sentBy(() => location("pc_hero"))).toHaveLength(1);
    expect(await fromCache(() => location("pc_hero"))).toEqual({ map: "cave", position: { x: 1, y: 2, direction: "down" } });
  });

  const WRITES: Record<string, () => Promise<any>> = {
    toggleAdmin: () => player.toggleAdmin("pc_boss"),
    toggleStealth: () => player.toggleStealth("pc_boss"),
    toggleNoclip: () => player.toggleNoclip("pc_boss"),
    ban: () => player.ban("pc_boss", null),
    unban: () => player.unban("pc_exile"),
    setLocation: () => player.setLocation("6101", "cave", { x: 1, y: 2, direction: "up" }),
    setLocationByUsername: () => player.setLocationByUsername("pc_boss", "cave", { x: 1, y: 2, direction: "up" }),
    returnHome: () => player.returnHome("6101"),
    setDeadState: () => player.setDeadState("pc_boss", 1, { map: "cave", x: 1, y: 2 }),
  };

  const snapshot = async () => ({
    boss: await player.findAccount("pc_boss"), admin: await player.isAdmin("pc_boss"), stealth: await player.isStealth("pc_boss"),
    noclip: await player.isNoclip("pc_boss"), at: await location("pc_boss"), exile: await player.findAccount("pc_exile"),
  });

  for (const [name, write] of Object.entries(WRITES)) {
    for (const made of [false, true]) {
      test(`${name}: a write the database ${made ? "made but never answered" : "refused"} has the row read again`, async () => {
        online("6101", "pc_boss");
        const before = await snapshot();

        writesLeft = 0;
        lostAfterWriting = made;
        await expect(write()).rejects.toThrow("database gone");
        writesLeft = Infinity;

        // The next read asks the database, once, and the ones after it do not.
        let after: any;
        expect(await sentBy(async () => { after = await snapshot(); })).toHaveLength(1);
        expect(await fromCache(snapshot)).toEqual(after);
        if (made) expect(after).not.toEqual(before);
        else expect(after).toEqual(before);
        // What it answers is what the database holds.
        await clearCaches();
        expect(await snapshot()).toEqual(after);
      });
    }
  }

  test("taking the role away: when clearing stealth is not answered, the role already written is not lost", async () => {
    await snapshot();
    writesLeft = 1;
    await expect(player.toggleAdmin("pc_boss")).rejects.toThrow("database gone");
    writesLeft = Infinity;

    expect(row("pc_boss")).toMatchObject({ role: 0, stealth: 1, noclip: 1 });
    expect(await sentBy(async () => { expect(await player.isAdmin("pc_boss")).toBe(false); })).toHaveLength(1);
    expect(await fromCache(() => player.isStealth("pc_boss"))).toBe(true);
  });
});

// --------------------------------------------------------------------- stats

describe("a player's stats", () => {
  const SHAPE = {
    health: 80, max_health: 100, total_max_health: 100, stamina: 60, max_stamina: 100, total_max_stamina: 100, level: 1, xp: 40, max_xp: 100,
    stat_critical_chance: 12, stat_critical_damage: 10, stat_armor: 3, stat_damage: 4, stat_health: 0, stat_stamina: 0, stat_avoidance: 5,
  };

  test("are read once, in the shape they always had", async () => {
    expect(await player.getStats("PC_Hero")).toEqual(SHAPE);
    expect(queries).toEqual(["SELECT * FROM stats WHERE username = ?"]);
    expect(await fromCache(() => player.getStats("pc_hero"))).toEqual(SHAPE);
    expect(await player.getStats("pc_nobody")).toEqual([]);
    expect(await player.getStats("")).toBeUndefined();
  });

  test("setStats writes the four that change in play, and the next read has them", async () => {
    await player.getStats("pc_hero");
    await player.setStats("PC_Hero", { health: 55, max_health: 120, stamina: 30, max_stamina: 110 } as any);
    expect(row("pc_hero", "stats")).toMatchObject({ health: 55, max_health: 120, stamina: 30, max_stamina: 110, xp: 40 });
    expect(await fromCache(() => player.getStats("pc_hero"))).toEqual({ ...SHAPE, health: 55, max_health: 120, total_max_health: 120, stamina: 30, max_stamina: 110, total_max_stamina: 110 });
  });

  test("setStats with nothing to save writes nothing", async () => {
    expect(await sentBy(() => player.setStats("pc_hero", { health: 0, max_health: 100, stamina: 0, max_stamina: 100 } as any))).toEqual([]);
  });

  test("a fraction the database rounds is not guessed at: the row is read again", async () => {
    await player.getStats("pc_hero");
    await player.setStats("pc_hero", { health: 55.6, max_health: 120, stamina: 30, max_stamina: 110 } as any);
    expect(await sentBy(async () => { expect((await player.getStats("pc_hero") as any).health).toBe(56); })).toHaveLength(1);
    expect((await fromCache(() => player.getStats("pc_hero")) as any).health).toBe(56);
  });

  test("setBaseStats writes every column, and the next read has them", async () => {
    await player.getStats("pc_hero");
    const next = { health: 90, max_health: 200, stamina: 70, max_stamina: 150, xp: 5, max_xp: 300, level: 7, stat_critical_damage: 20, stat_critical_chance: 21, stat_armor: 22, stat_damage: 23, stat_avoidance: 24 };
    await player.setBaseStats("PC_Hero", next as any);
    expect(row("pc_hero", "stats")).toMatchObject(next);
    expect(await fromCache(() => player.getStats("pc_hero"))).toEqual({ ...next, total_max_health: 200, total_max_stamina: 150, stat_health: 0, stat_stamina: 0 });
  });

  test("increaseXp adds to what is held, writes it, and holds the result", async () => {
    expect(await player.increaseXp("PC_Hero", 25)).toEqual({ xp: 65, level: 1, max_xp: 100 });
    expect(row("pc_hero", "stats")).toMatchObject({ xp: 65, level: 1, max_xp: 100, health: 80 });
    // The second gain starts from the first without reading it back.
    expect(await sentBy(async () => { expect(await player.increaseXp("pc_hero", 10)).toEqual({ xp: 75, level: 1, max_xp: 100 }); })).toEqual(["UPDATE stats SET xp = ?, max_xp = ?, level = ? WHERE username = ?"]);
    expect(row("pc_hero", "stats").xp).toBe(75);
    expect(await fromCache(() => player.getStats("pc_hero"))).toMatchObject({ xp: 75, level: 1 });
  });

  test("a level gained is written with its new maximums and held", async () => {
    expect(await player.increaseXp("pc_hero", 70)).toEqual({ xp: 10, level: 2, max_xp: 110 });
    const gained = { xp: 10, level: 2, max_xp: 110, max_health: player.getMaxHealthForLevel(2), health: player.getMaxHealthForLevel(2), max_stamina: player.getMaxStaminaForLevel(2), stamina: player.getMaxStaminaForLevel(2) };
    expect(row("pc_hero", "stats")).toMatchObject(gained);
    expect(await fromCache(() => player.getStats("pc_hero"))).toMatchObject(gained);
  });

  test("increaseLevel changes what the database holds by one, so the row is read again", async () => {
    await player.getStats("pc_hero");
    await player.increaseLevel("pc_hero");
    expect(row("pc_hero", "stats").level).toBe(2);
    expect(await sentBy(async () => { expect(await player.getStats("pc_hero")).toMatchObject({ level: 2 }); })).toHaveLength(1);
  });

  const WRITES: Record<string, () => Promise<any>> = {
    setStats: () => player.setStats("pc_hero", { health: 1, max_health: 2, stamina: 3, max_stamina: 4 } as any),
    setBaseStats: () => player.setBaseStats("pc_hero", { health: 1, max_health: 2, stamina: 3, max_stamina: 4, xp: 5, max_xp: 6, level: 7, stat_critical_damage: 8, stat_critical_chance: 9, stat_armor: 10, stat_damage: 11, stat_avoidance: 12 } as any),
    increaseXp: () => player.increaseXp("pc_hero", 500),
    increaseLevel: () => player.increaseLevel("pc_hero"),
  };

  for (const [name, write] of Object.entries(WRITES)) {
    for (const made of [false, true]) {
      test(`${name}: a write the database ${made ? "made but never answered" : "refused"} has the row read again`, async () => {
        const before = await player.getStats("pc_hero");

        writesLeft = 0;
        lostAfterWriting = made;
        await expect(write()).rejects.toThrow("database gone");
        writesLeft = Infinity;

        let after: any;
        expect(await sentBy(async () => { after = await player.getStats("pc_hero"); })).toEqual(["SELECT * FROM stats WHERE username = ?"]);
        expect(await fromCache(() => player.getStats("pc_hero"))).toEqual(after);
        if (made) expect(after).not.toEqual(before);
        else expect(after).toEqual(before);
        await clearCaches();
        expect(await player.getStats("pc_hero")).toEqual(after);
      });
    }
  }
});

// -------------------------------------------------------------- client config

describe("a player's client config", () => {
  test("is read once, as the rows it always was", async () => {
    expect(await player.getConfig("PC_Hero")).toEqual([config("pc_hero")]);
    expect(queries).toEqual(["SELECT * FROM clientconfig WHERE username = ?"]);
    expect(await fromCache(() => player.getConfig("pc_hero"))).toEqual([config("pc_hero")]);
    expect(await player.getConfig("pc_nobody")).toEqual([]);
    expect(await player.getConfig("")).toBeUndefined();
  });

  test("setConfig writes for the player the session is, and the next read has it", async () => {
    online("6101", "pc_hero");
    await player.getConfig("pc_hero");
    expect(await sentBy(() => player.setConfig("6101", { fps: 144, music_volume: 0, effects_volume: 35, muted: true }))).toEqual([
      "UPDATE clientconfig SET fps = ?, music_volume = ?, effects_volume = ?, muted = ? WHERE username = ?",
    ]);
    expect(row("pc_hero", "clientconfig")).toMatchObject({ fps: 144, music_volume: 0, effects_volume: 35, muted: 1 });
    expect(await fromCache(() => player.getConfig("pc_hero"))).toEqual([config("pc_hero", { fps: 144, music_volume: 0, effects_volume: 35, muted: 1 })]);
  });

  test("setConfig refuses what is not a config, and a session nobody is online under", async () => {
    online("6101", "pc_hero");
    queries = [];
    expect(await player.setConfig("", { fps: 60, music_volume: 1, effects_volume: 1, muted: false })).toBeUndefined();
    expect(await player.setConfig("6101", { fps: 0, music_volume: 1, effects_volume: 1, muted: false })).toEqual([]);
    expect(await player.setConfig("6101", { fps: 60, music_volume: "1", effects_volume: 1, muted: false })).toEqual([]);
    expect(await player.setConfig("9999", { fps: 60, music_volume: 1, effects_volume: 1, muted: false })).toEqual([]);
    expect(queries).toEqual([]);
  });

  test("a volume the database rounds is not guessed at: the row is read again", async () => {
    online("6101", "pc_hero");
    await player.getConfig("pc_hero");
    await player.setConfig("6101", { fps: 60, music_volume: 12.5, effects_volume: 35, muted: false });
    expect(await sentBy(async () => { expect((await player.getConfig("pc_hero") as any)[0].music_volume).toBe(13); })).toHaveLength(1);
  });

  test("a saved layout is held as text where the database holds it as text", async () => {
    row("pc_hero", "clientconfig").inventory_config = '{"0":"sword"}';
    await player.getConfig("pc_hero");

    await player.saveHotBarConfig("PC_Hero", { 1: "frost_bolt" });
    await player.saveInventoryConfig("pc_hero", { 0: "shield", 3: "potion" });
    expect(row("pc_hero", "clientconfig")).toMatchObject({ hotbar_config: '{"1":"frost_bolt"}', inventory_config: '{"0":"shield","3":"potion"}' });
    expect(await fromCache(() => player.getConfig("pc_hero"))).toEqual([config("pc_hero", { hotbar_config: '{"1":"frost_bolt"}', inventory_config: '{"0":"shield","3":"potion"}' })]);
  });

  test("a saved layout is held parsed where the database gives it back parsed, as a copy of its own", async () => {
    parsedJson = true;
    row("pc_hero", "clientconfig").inventory_config = '{"0":"sword"}';
    await player.getConfig("pc_hero");

    const layout: Record<string, string> = { 0: "shield" };
    await player.saveInventoryConfig("pc_hero", layout);
    layout[0] = "changed after the save";
    await player.saveHotBarConfig("pc_hero", { 1: "frost_bolt" });

    const held = await fromCache(() => player.getConfig("pc_hero"));
    expect(held).toEqual([config("pc_hero", { hotbar_config: { 1: "frost_bolt" }, inventory_config: { 0: "shield" } })]);
    // As the database would say it.
    await clearCaches();
    expect(await player.getConfig("pc_hero")).toEqual(held);
  });

  test("a first saved layout does not show which of the two the database gives: the row is read again", async () => {
    await player.getConfig("pc_hero");
    await player.saveHotBarConfig("pc_hero", { 1: "frost_bolt" });
    expect(await sentBy(async () => { expect((await player.getConfig("pc_hero") as any)[0].hotbar_config).toBe('{"1":"frost_bolt"}'); })).toHaveLength(1);
    // Now it shows.
    await player.saveInventoryConfig("pc_hero", { 0: "shield" });
    expect((await fromCache(() => player.getConfig("pc_hero")) as any)[0].inventory_config).toBe('{"0":"shield"}');
  });

  const WRITES: Record<string, () => Promise<any>> = {
    setConfig: () => player.setConfig("6101", { fps: 144, music_volume: 1, effects_volume: 2, muted: true }),
    saveHotBarConfig: () => player.saveHotBarConfig("pc_hero", { 1: "frost_bolt" }),
    saveInventoryConfig: () => player.saveInventoryConfig("pc_hero", { 0: "shield" }),
  };

  for (const [name, write] of Object.entries(WRITES)) {
    for (const made of [false, true]) {
      test(`${name}: a write the database ${made ? "made but never answered" : "refused"} has the row read again`, async () => {
        online("6101", "pc_hero");
        row("pc_hero", "clientconfig").inventory_config = '{"0":"sword"}';
        const before = await player.getConfig("pc_hero");

        writesLeft = 0;
        lostAfterWriting = made;
        await expect(write()).rejects.toThrow("database gone");
        writesLeft = Infinity;

        let after: any;
        expect(await sentBy(async () => { after = await player.getConfig("pc_hero"); })).toEqual(["SELECT * FROM clientconfig WHERE username = ?"]);
        expect(await fromCache(() => player.getConfig("pc_hero"))).toEqual(after);
        if (made) expect(after).not.toEqual(before);
        else expect(after).toEqual(before);
        await clearCaches();
        expect(await player.getConfig("pc_hero")).toEqual(after);
      });
    }
  }
});

// ------------------------------------------------- tables other systems cache

describe("the guest clean-up", () => {
  test("has every cache of a table it wrote read again", async () => {
    await player.getPartyIdByUsername("pc_ally");
    await player.findAccount("guest_pc");
    await player.findAccount(undefined, 4306);
    await player.getStats("guest_pc");
    await player.getConfig("guest_pc");
    expect(await player.searchAccounts("guest", 5)).toEqual([{ id: 4306, username: "guest_pc" }]);
    queries = [];

    await player.clear();

    expect(tables.accounts.map((r) => r.username)).toEqual(["pc_boss", "pc_mod", "pc_hero", "pc_ally", "pc_exile"]);
    expect(tables.parties).toEqual([]);
    expect(tables.guilds.map((g) => g.name)).toEqual(["Frostguard"]);
    for (const table of ["stats", "clientconfig", "inventory", "quest_log", "currency", "collectables", "equipment", "learned_spells", "permissions", "friendslist"]) {
      expect(tables[table].some((r) => r.username === "guest_pc")).toBe(false);
    }

    // Every account lost its party, and the guest everything.
    expect(await player.getPartyIdByUsername("pc_ally")).toBeNull();
    expect(await player.findAccount("guest_pc")).toBeNull();
    expect(await player.findAccount(undefined, 4306)).toBeNull();
    expect(await player.getStats("guest_pc")).toEqual([]);
    expect(await player.getConfig("guest_pc")).toEqual([]);
    // The names were read again by the clean-up itself, not by the search.
    expect(await fromCache(() => player.searchAccounts("guest", 5))).toEqual([]);

    expect(told.sort()).toEqual([
      "account_ids *", "accounts *", "clientconfig *", "collectables *", "currency *", "equipment *", "friends *", "guilds reload",
      "inventory *", "learned_spells *", "parties reload", "permissions *", "quest_log *", "spell_usage *", "stats *",
    ]);
  });

  test("that the database stops half way still has them read again", async () => {
    await player.getPartyIdByUsername("pc_ally");
    await player.getStats("guest_pc");
    // The parties are taken off every account and the guest's first rows deleted, then the connection is lost.
    writesLeft = 3;
    await expect(player.clear()).rejects.toThrow("database gone");
    writesLeft = Infinity;
    expect(tables.accounts.some((r) => r.username === "guest_pc")).toBe(true);

    expect(await player.getPartyIdByUsername("pc_ally")).toBeNull();
    expect(await player.getStats("guest_pc")).toEqual([]);
    expect(told).toContain("accounts *");
    expect(told).toContain("parties reload");
  });
});

describe("a new account's default rows", () => {
  test("are read by every cache that had looked for them", async () => {
    expect(await player.findAccount("pc_newcomer")).toBeNull();
    expect(await player.getStats("pc_newcomer")).toEqual([]);
    expect(await player.getConfig("pc_newcomer")).toEqual([]);

    expect(await player.register("PC_Newcomer", "hash", "New@Example.test", { ip: "127.0.0.1", headers: {} }, false)).toBe("pc_newcomer");

    expect(await player.findAccount("pc_newcomer")).toMatchObject({ username: "pc_newcomer", banned: 0 });
    expect(await player.getStats("pc_newcomer")).toMatchObject({ health: 100, level: 1 });
    expect(await player.getConfig("pc_newcomer")).toMatchObject([{ fps: 60, muted: 0 }]);
    expect(await fromCache(() => player.searchAccounts("newcomer", 5))).toMatchObject([{ username: "pc_newcomer" }]);
    // And who knows frost_bolt, which every new account is given.
    expect(told.sort()).toEqual(["collectables pc_newcomer", "currency pc_newcomer", "equipment pc_newcomer", "learned_spells pc_newcomer", "quest_log pc_newcomer", "spell_usage frost_bolt"]);
  });
});
