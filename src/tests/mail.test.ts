import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";
import { GuardError } from "../controllers/sqltransaction";

// Mail between players: where mailboxes stand, and sending, taking, deleting,
// sending back and the expiry of mail. The real mail, inventory, currency and
// player systems run against a fake database, and what each player holds there
// is compared with what was sent.
//
// Named to run before questrewards.test.ts, which stands in for the inventory
// and currency systems in every file that runs after it.

mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// ------------------------------------------------------------ fake database

type Row = Record<string, any>;
let tables: { inventory: Row[]; currency: Row[]; mail: Row[]; equipment: Row[]; bags: Row[]; ignores: Row[]; accounts: Row[]; mailbox_spots: Row[] };
let nextId: number;
/** Statements that are refused. */
let failing: ((sql: string) => boolean) | null;

const fold = (value: any) => String(value).toLowerCase();
const mine = (username: string) => (row: Row) => fold(row.username) === fold(username);
const ACCOUNT = /^SELECT .+ FROM accounts WHERE username = \?$/;
const MAIL_COLUMNS = "id, recipient, sender, subject, body, items, copper, silver, gold, sent_at, expires_at, is_read, returned";

function run(sql: string, params: any[] = []): any {
  const text = sql.replace(/\s+/g, " ").trim();
  if (failing?.(text)) throw new Error("database gone");

  if (ACCOUNT.test(text)) return tables.accounts.filter(mine(params[0])).map((row) => ({ ...row }));
  if (text === "SELECT ignored FROM ignores WHERE username = ?") return tables.ignores.filter(mine(params[0])).map(({ ignored }) => ({ ignored }));
  if (text === "SELECT * FROM inventory WHERE username = ?") return tables.inventory.filter(mine(params[0])).map((row) => ({ ...row }));
  if (text === "SELECT copper, silver, gold FROM currency WHERE username = ?") {
    return tables.currency.filter(mine(params[0])).map(({ copper, silver, gold }) => ({ copper, silver, gold }));
  }
  if (text === "SELECT * FROM equipment WHERE username = ?") return tables.equipment.filter(mine(params[0])).map((row) => ({ ...row }));
  if (text === "SELECT * FROM bags WHERE username = ?") return tables.bags.filter(mine(params[0])).map((row) => ({ ...row }));
  if (text === `SELECT ${MAIL_COLUMNS} FROM mail WHERE recipient = ? ORDER BY id`) {
    return tables.mail.filter((row) => row.recipient === params[0]).sort((a, b) => a.id - b.id).map((row) => ({ ...row }));
  }
  if (text === "SELECT map, spots FROM mailbox_spots") return tables.mailbox_spots.map((row) => ({ ...row }));
  // Any other table (the quest log an inventory change reports to) holds nothing.
  if (text.startsWith("SELECT ")) return [];
  if (text.startsWith("CREATE TABLE IF NOT EXISTS mailbox_spots") || text.startsWith("INSERT IGNORE INTO permission_types")) return { affectedRows: 0 };
  if (text === "INSERT INTO mailbox_spots (map, spots) VALUES (?, ?) ON DUPLICATE KEY UPDATE spots = ?") {
    const [map, spots] = params;
    const row = tables.mailbox_spots.find((held) => held.map === map);
    if (row) row.spots = spots;
    else tables.mailbox_spots.push({ map, spots });
    return { affectedRows: row ? 2 : 1 };
  }
  if (text === "DELETE FROM mailbox_spots WHERE map = ?") {
    const before = tables.mailbox_spots.length;
    tables.mailbox_spots = tables.mailbox_spots.filter((row) => row.map !== params[0]);
    return { affectedRows: before - tables.mailbox_spots.length };
  }

  if (text === "INSERT IGNORE INTO inventory (username, item, quantity) VALUES (?, ?, ?)") {
    const [username, item, quantity] = params;
    const row = { id: nextId++, username, item, quantity: Number(quantity), equipped: 0, slot: null, bag_slot: null };
    tables.inventory.push(row);
    return { affectedRows: 1, lastInsertRowid: row.id };
  }
  if (text === "UPDATE inventory SET quantity = ? WHERE item = ? AND username = ?") {
    const [quantity, item, username] = params;
    const rows = tables.inventory.filter((row) => mine(username)(row) && fold(row.item) === fold(item) && row.quantity !== Number(quantity));
    rows.forEach((row) => { row.quantity = Number(quantity); });
    return { affectedRows: rows.length };
  }
  if (text === "DELETE FROM inventory WHERE item = ? AND username = ?") {
    const [item, username] = params;
    const before = tables.inventory.length;
    tables.inventory = tables.inventory.filter((row) => !(mine(username)(row) && fold(row.item) === fold(item)));
    return { affectedRows: before - tables.inventory.length };
  }
  if (text.startsWith("INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE")) {
    const [username, copper, silver, gold] = params;
    const row = tables.currency.find(mine(username));
    if (row) Object.assign(row, { copper, silver, gold });
    else tables.currency.push({ username, copper, silver, gold });
    return { affectedRows: row ? 2 : 1 };
  }
  if (text === "INSERT INTO mail (recipient, sender, subject, body, items, copper, silver, gold, sent_at, expires_at, is_read, returned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)") {
    const [recipient, sender, subject, body, items, copper, silver, gold, sent_at, expires_at] = params;
    const row = { id: nextId++, recipient, sender, subject, body, items, copper, silver, gold, sent_at, expires_at, is_read: 0, returned: 0 };
    tables.mail.push(row);
    return { affectedRows: 1, lastInsertRowid: row.id };
  }
  const mailRow = (id: any, recipient: any) => tables.mail.filter((row) => row.id === Number(id) && row.recipient === recipient);
  if (text === "UPDATE mail SET items = ?, copper = ?, silver = ?, gold = ?, is_read = 1 WHERE id = ? AND recipient = ?") {
    const [items, copper, silver, gold, id, recipient] = params;
    const rows = mailRow(id, recipient);
    rows.forEach((row) => Object.assign(row, { items, copper, silver, gold, is_read: 1 }));
    return { affectedRows: rows.length };
  }
  if (text === "UPDATE mail SET is_read = 1 WHERE id = ? AND recipient = ?") {
    const rows = mailRow(params[0], params[1]);
    rows.forEach((row) => { row.is_read = 1; });
    return { affectedRows: rows.length };
  }
  if (text === "UPDATE mail SET recipient = ?, sender = ?, sent_at = ?, expires_at = ?, is_read = 0, returned = 1 WHERE id = ? AND recipient = ?") {
    const [recipient, sender, sent_at, expires_at, id, owner] = params;
    const rows = mailRow(id, owner);
    rows.forEach((row) => Object.assign(row, { recipient, sender, sent_at, expires_at, is_read: 0, returned: 1 }));
    return { affectedRows: rows.length };
  }
  if (text === "DELETE FROM mail WHERE id = ? AND recipient = ?") {
    const before = tables.mail.length;
    tables.mail = tables.mail.filter((row) => !(row.id === Number(params[0]) && row.recipient === params[1]));
    return { affectedRows: before - tables.mail.length };
  }
  throw new Error(`The fake database does not understand: ${text}`);
}

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => run(sql, params),
  // All of its statements or none.
  transaction: async (statements: Array<{ sql: string; values?: any[]; mustChange?: boolean }>) => {
    const before = structuredClone({ tables, nextId });
    try {
      return statements.map((statement, index) => {
        const answer = run(statement.sql, statement.values);
        if (statement.mustChange && answer.affectedRows === 0) throw new GuardError(index);
        return answer;
      });
    } catch (error) {
      ({ tables, nextId } = before);
      throw error;
    }
  },
}));

const item = (name: string, type = "material") => ({ name, quality: "common", type, description: "", icon: `${fold(name).replace(/ /g, "_")}.png`, equipment_slot: null, bag_slots: null });
const assets = new Map<string, any>([
  ["items", [item("Iron Ore"), item("Rat Tail"), item("Iron Helmet", "equipment"), item("Sealed Letter", "quest"), { ...item("Home Stone", "consumable"), teleports_home: 1 }, { ...item("Bound Ring", "equipment"), soulbound: 1 }]],
]);
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => assets.get(key) ?? null,
    set: async (key: string, value: any) => assets.set(key, value),
    add: async (key: string, value: any) => assets.set(key, value),
  },
}));

// The systems compare names the way the configured database does: these tests are of MySQL, the default.
const configuredEngine = process.env.DATABASE_ENGINE;
delete process.env.DATABASE_ENGINE;

const { clearCaches } = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
const { coinsWorth } = await import("../systems/currency");
const { default: mail, mailboxesOn, atMailbox, MAIL_RANGE, MAIL_DAYS, INBOX_MAX, POSTAGE_COPPER, postageFor } = await import("../systems/mail");
const mailboxEditor = await import("../systems/mailboxeditor");

let logged: Array<ReturnType<typeof spyOn>>;
beforeAll(async () => {
  logged = [spyOn(log, "info"), spyOn(log, "warn"), spyOn(log, "error")].map((spy) => spy.mockImplementation(() => {}));
  await mailboxEditor.ensureMailboxSchema();
});
afterAll(async () => {
  for (const spy of logged) spy.mockRestore();
  if (configuredEngine !== undefined) process.env.DATABASE_ENGINE = configuredEngine;
  await clearCaches();
});

// ------------------------------------------------------------------ fixtures

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const coins = (gold = 0, silver = 0, copper = 0) => ({ gold, silver, copper });
const hero = { username: "hero" };
/** What a player holds in the database: item to quantity. */
const holds = (username: string) => Object.fromEntries(tables.inventory.filter(mine(username)).map((row) => [row.item, row.quantity]));
const purse = (username: string) => {
  const row = tables.currency.find(mine(username));
  return row ? coinsWorth({ copper: row.copper, silver: row.silver, gold: row.gold }) : 0;
};
const mailOf = (recipient: string) => tables.mail.filter((row) => row.recipient === recipient);
const letter = (over: Row = {}) => ({ to: "Ally", subject: "Hello", body: "A gift.", items: [], coins: coins(), ...over });
/** A mail already in a mailbox. */
const stored = (over: Row = {}) => {
  const row = {
    id: nextId++, recipient: "ally", sender: "hero", subject: "Old", body: "", items: "[]", copper: 0, silver: 0, gold: 0,
    sent_at: NOW - DAY, expires_at: NOW + 29 * DAY, is_read: 0, returned: 0, ...over,
  };
  tables.mail.push(row);
  return row;
};

beforeEach(async () => {
  nextId = 100;
  failing = null;
  tables = {
    inventory: [
      { id: 1, username: "hero", item: "Iron Ore", quantity: 10, equipped: 0, slot: 0, bag_slot: 0 },
      { id: 2, username: "hero", item: "Iron Helmet", quantity: 1, equipped: 1, slot: null, bag_slot: null },
      { id: 3, username: "hero", item: "Sealed Letter", quantity: 1, equipped: 0, slot: 1, bag_slot: 0 },
      { id: 5, username: "hero", item: "Home Stone", quantity: 1, equipped: 0, slot: 2, bag_slot: 0 },
      { id: 6, username: "hero", item: "Bound Ring", quantity: 1, equipped: 0, slot: 3, bag_slot: 0 },
      { id: 4, username: "ally", item: "Rat Tail", quantity: 2, equipped: 0, slot: 0, bag_slot: 0 },
    ],
    currency: [{ username: "hero", copper: 50, silver: 2, gold: 1 }, { username: "ally", copper: 0, silver: 0, gold: 0 }],
    mail: [],
    equipment: [{ id: 1, username: "hero", helmet: "Iron Helmet", weapon: null }],
    bags: [],
    ignores: [],
    accounts: [
      { id: 1, username: "hero", role: 0, guest_mode: 0 },
      { id: 2, username: "ally", role: 0, guest_mode: 0 },
      { id: 3, username: "visitor", role: 0, guest_mode: 1 },
    ],
    mailbox_spots: [],
  };
  await clearCaches();
});

// ----------------------------------------------------------------- mailboxes

describe("mailboxes", () => {
  const innkeeper = { id: 1, name: "Bree", map: "house_1", innkeeper: true, hidden: false } as any;
  const vendor = { id: 2, name: "Sam", map: "house_2", innkeeper: false, hidden: false } as any;
  const door = (map: string, x: number, y: number) => ({ name: map, map, x, y, position: { x, y }, size: { width: 32, height: 32 }, layer: null });
  const outdoors = (map: string) => map === "overworld";

  test("one stands in front of each inn door on open country, beside the way in", () => {
    const boxes = mailboxesOn("overworld", [innkeeper, vendor], [door("house_1", 320, 640), door("house_1", 400, 640), door("house_2", 800, 640)], outdoors);
    expect(boxes).toEqual([{ id: "overworld:376:696", x: 376, y: 696 }]);
  });

  test("it goes on the left when the right is solid", () => {
    const boxes = mailboxesOn("overworld", [innkeeper], [door("house_1", 320, 640)], outdoors, (x) => x > 352);
    expect(boxes).toEqual([{ id: "overworld:296:696", x: 296, y: 696 }]);
  });

  test("there are none indoors, nor for a hidden innkeeper", () => {
    expect(mailboxesOn("house_9", [innkeeper], [door("house_1", 320, 640)], outdoors)).toEqual([]);
    expect(mailboxesOn("overworld", [{ ...innkeeper, hidden: true }], [door("house_1", 320, 640)], outdoors)).toEqual([]);
  });

  test("a player within reach of one may use it", () => {
    const boxes = [{ id: "b", x: 100, y: 100 }];
    expect(atMailbox(boxes, 100 + MAIL_RANGE, 100)).toBe(true);
    expect(atMailbox(boxes, 101 + MAIL_RANGE, 100)).toBe(false);
    expect(atMailbox([], 100, 100)).toBe(false);
  });
});

// ---------------------------------------------------------- placed by hand

describe("mailboxes placed by hand (/mailbox)", () => {
  test("a map left alone has none of its own: its inns place them", async () => {
    expect(await mailboxEditor.placedOn("overworld")).toBeNull();
  });

  test("placed mailboxes are saved, rounded, and stand in place of the inns' ones", async () => {
    const placed = await mailboxEditor.place("overworld.json", [{ x: 100.4, y: 200 }, { x: 300, y: 400.6 }]);
    expect(placed).toEqual({ ok: true, mailboxes: [{ id: "overworld:100:200", x: 100, y: 200 }, { id: "overworld:300:401", x: 300, y: 401 }] });
    expect(tables.mailbox_spots).toEqual([{ map: "overworld", spots: JSON.stringify([{ x: 100, y: 200 }, { x: 300, y: 401 }]) }]);
    expect(await mailboxEditor.placedOn("overworld")).toEqual([{ id: "overworld:100:200", x: 100, y: 200 }, { id: "overworld:300:401", x: 300, y: 401 }]);
    // read again from the database
    await clearCaches();
    expect((await mailboxEditor.placedOn("overworld"))?.map((box) => box.id)).toEqual(["overworld:100:200", "overworld:300:401"]);
  });

  test("moving one saves the list again; an empty list is a map with no mailbox", async () => {
    await mailboxEditor.place("overworld", [{ x: 100, y: 200 }]);
    await mailboxEditor.place("overworld", [{ x: 150, y: 250 }]);
    expect(await mailboxEditor.placedOn("overworld")).toEqual([{ id: "overworld:150:250", x: 150, y: 250 }]);
    await mailboxEditor.place("overworld", []);
    expect(await mailboxEditor.placedOn("overworld")).toEqual([]);
    expect(tables.mailbox_spots).toHaveLength(1);
  });

  test("a reset gives the map back to its inns", async () => {
    await mailboxEditor.place("overworld", [{ x: 100, y: 200 }]);
    expect(await mailboxEditor.reset("overworld")).toEqual({ ok: true });
    expect(tables.mailbox_spots).toEqual([]);
    expect(await mailboxEditor.placedOn("overworld")).toBeNull();
  });

  test("spots off the map, on top of each other or not a list are refused, and nothing is saved", async () => {
    const off = `X and Y must be whole numbers from 0 to ${mailboxEditor.COORDINATE_MAX}.`;
    expect(await mailboxEditor.place("overworld", [{ x: 1, y: 1 }, { x: -1, y: 5 }])).toEqual({ ok: false, message: off, at: 1 });
    expect(await mailboxEditor.place("overworld", [{ x: "a", y: 5 }])).toEqual({ ok: false, message: off, at: 0 });
    expect(await mailboxEditor.place("overworld", [{ x: null, y: 5 }])).toEqual({ ok: false, message: off, at: 0 });
    expect(await mailboxEditor.place("overworld", [{ x: 5, y: 5 }, { x: 5.2, y: 4.8 }])).toEqual({ ok: false, message: "Another mailbox stands on the same spot.", at: 1 });
    expect(await mailboxEditor.place("overworld", null)).toEqual({ ok: false, message: "No mailboxes were sent." });
    expect(tables.mailbox_spots).toEqual([]);
  });

  test("a failed write changes nothing held", async () => {
    await mailboxEditor.place("overworld", [{ x: 100, y: 200 }]);
    failing = (sql) => sql.startsWith("INSERT INTO mailbox_spots");
    expect(await mailboxEditor.place("overworld", [{ x: 1, y: 2 }])).toEqual({ ok: false, message: "The mailboxes could not be saved." });
    expect(await mailboxEditor.placedOn("overworld")).toEqual([{ id: "overworld:100:200", x: 100, y: 200 }]);
  });

  test("admins may use the editor; players and guests may not", async () => {
    expect(await mailboxEditor.canUseEditor({ username: "boss", isAdmin: true })).toBe(true);
    expect(await mailboxEditor.canUseEditor({ username: "hero" })).toBe(false);
    expect(await mailboxEditor.canUseEditor({ username: "visitor", isGuest: true, isAdmin: true })).toBe(false);
    expect(mailboxEditor.mayHaveEditorOpen({ permissions: ["tools.mailbox_editor"] })).toBe(true);
    expect(mailboxEditor.mayHaveEditorOpen({ permissions: ["admin.warp"] })).toBe(false);
  });
});

describe("the mailbox editor's packets", () => {
  const boss = { username: "boss", isAdmin: true };
  /** The world as the receiver tells it: the admin is on the overworld, whose one inn has a mailbox. */
  const world = (here = "overworld") => ({
    here,
    mailboxesOf: async (map: string) => (await mailboxEditor.placedOn(map)) ?? (map === "overworld" ? [{ id: "overworld:376:696", x: 376, y: 696 }] : []),
    isMap: async (map: string) => ["overworld", "underworld", "house_1"].includes(map),
    maps: async () => ["underworld.json", "house_1.json", "overworld.json"],
  });

  test("with no search, the list is the map the admin is on, then the maps they visited recently: not every map", async () => {
    await mailboxEditor.place("underworld", [{ x: 5, y: 6 }]);
    const answer = await mailboxEditor.handleEditorPacket(boss, "MAILBOX_EDITOR_LIST", { recent: ["underworld.json", "nowhere", "overworld"] }, world());
    expect(answer).toEqual({
      kind: "data",
      data: {
        here: "overworld",
        maps: [
          { map: "overworld", mailboxes: [{ x: 376, y: 696 }], placed: false },
          { map: "underworld", mailboxes: [{ x: 5, y: 6 }], placed: true },
        ],
        query: "", truncated: 0, coordinateMax: mailboxEditor.COORDINATE_MAX, ready: true,
      },
    });
    // a map placed by hand is not listed for that alone
    const alone = await mailboxEditor.handleEditorPacket(boss, "MAILBOX_EDITOR_LIST", null, world());
    expect(alone.kind === "data" && alone.data.maps.map((m) => m.map)).toEqual(["overworld"]);
  });

  test("at most RECENT_LIMIT recent maps are listed", async () => {
    const many = Array.from({ length: mailboxEditor.RECENT_LIMIT + 5 }, (_, i) => `house_${i}`);
    const answer = await mailboxEditor.handleEditorPacket(boss, "MAILBOX_EDITOR_LIST", { recent: many }, { ...world(), maps: async () => ["overworld", ...many] });
    expect(answer.kind === "data" && answer.data.maps.map((m) => m.map)).toEqual(["overworld", ...many.slice(0, mailboxEditor.RECENT_LIMIT)]);
  });

  test("a search finds any map by its name, those that start with it first, and keeps the open map listed", async () => {
    const found = await mailboxEditor.handleEditorPacket(boss, "MAILBOX_EDITOR_LIST", { query: "World", open: "house_1" }, world());
    expect(found.kind === "data" && found.data.maps.map((m) => m.map)).toEqual(["overworld", "underworld", "house_1"]);
    const starts = await mailboxEditor.handleEditorPacket(boss, "MAILBOX_EDITOR_LIST", { query: "under" }, world());
    expect(starts.kind === "data" && starts.data.maps.map((m) => m.map)).toEqual(["underworld"]);
  });

  test("a search sends SEARCH_LIMIT maps at most and says how many more there are", async () => {
    const many = Array.from({ length: mailboxEditor.SEARCH_LIMIT + 7 }, (_, i) => `house_${String(i).padStart(3, "0")}`);
    const answer = await mailboxEditor.handleEditorPacket(boss, "MAILBOX_EDITOR_LIST", { query: "house" }, { ...world(), maps: async () => many });
    expect(answer.kind === "data" && answer.data.maps.length).toBe(mailboxEditor.SEARCH_LIMIT);
    expect(answer.kind === "data" && answer.data.truncated).toBe(7);
  });

  test("a save places the map's mailboxes and says which map changed", async () => {
    const answer = await mailboxEditor.handleEditorPacket(boss, "MAILBOX_EDITOR_SAVE", { map: "overworld.json", mailboxes: [{ x: 10, y: 20 }] }, world());
    expect(answer).toMatchObject({ kind: "result", ok: true, name: "overworld", changed: "overworld" });
    expect(answer.kind === "result" && answer.data?.maps[0]).toEqual({ map: "overworld", mailboxes: [{ x: 10, y: 20 }], placed: true });
  });

  test("a save names the mailbox that is wrong, and refuses a map there is not", async () => {
    const wrong = await mailboxEditor.handleEditorPacket(boss, "MAILBOX_EDITOR_SAVE", { map: "overworld", mailboxes: [{ x: 1, y: 1 }, { x: 1, y: 1 }] }, world());
    expect(wrong).toMatchObject({ kind: "result", ok: false, fields: { "mailboxes.1": "Another mailbox stands on the same spot." } });
    const nowhere = await mailboxEditor.handleEditorPacket(boss, "MAILBOX_EDITOR_SAVE", { map: "nowhere", mailboxes: [] }, world());
    expect(nowhere).toMatchObject({ kind: "result", ok: false, errors: ["There is no map called nowhere."] });
    expect(tables.mailbox_spots).toEqual([]);
  });

  test("a delete gives the map back to its inns; a map its inns place already is refused", async () => {
    await mailboxEditor.place("underworld", [{ x: 5, y: 6 }]);
    const done = await mailboxEditor.handleEditorPacket(boss, "MAILBOX_EDITOR_DELETE", { map: "underworld" }, world());
    expect(done).toMatchObject({ kind: "result", ok: true, changed: "underworld", notes: ["Its inns place its mailboxes again."] });
    expect(tables.mailbox_spots).toEqual([]);
    const again = await mailboxEditor.handleEditorPacket(boss, "MAILBOX_EDITOR_DELETE", { map: "underworld" }, world());
    expect(again).toMatchObject({ kind: "result", ok: false, errors: ["The mailboxes of underworld are already placed in front of its inns."] });
  });

  test("a player without the permission is refused before anything is read or changed", async () => {
    const answer = await mailboxEditor.handleEditorPacket({ username: "hero" }, "MAILBOX_EDITOR_SAVE", { map: "overworld", mailboxes: [] }, world());
    expect(answer).toEqual({ kind: "result", ok: false, errors: [mailboxEditor.DENIED], notes: [], name: null, denied: true, data: null });
    expect(tables.mailbox_spots).toEqual([]);
  });
});

// ------------------------------------------------------------------- sending

describe("sending mail", () => {
  test("what is attached and the postage leave the sender, and the mail waits for the recipient", async () => {
    const answer = await mail.send(hero, letter({ items: [{ name: "Iron Ore", quantity: 4 }], coins: coins(0, 1, 0) }), NOW);
    expect(answer).toEqual({ ok: true, message: "Mail sent to Ally.", recipient: "ally" });
    expect(holds("hero")["Iron Ore"]).toBe(6);
    expect(purse("hero")).toBe(coinsWorth(coins(1, 2, 50)) - 100 - POSTAGE_COPPER);
    expect(mailOf("ally")).toHaveLength(1);

    const [view] = await mail.inbox("ally", NOW);
    expect(view).toMatchObject({ sender: "Hero", subject: "Hello", body: "A gift.", coins: coins(0, 1, 0), read: false, returned: false, expiresAt: NOW + MAIL_DAYS * DAY });
    expect(view.items).toEqual([{ ...item("Iron Ore"), quantity: 4 }]);
    expect(await mail.unread("ally", NOW)).toBe(1);
  });

  test("postage is paid for each item attached", async () => {
    expect(postageFor(0)).toBe(POSTAGE_COPPER);
    expect(postageFor(3)).toBe(3 * POSTAGE_COPPER);
  });

  test("refusals write nothing", async () => {
    const refused = async (raw: Row, message: string, from: any = hero) => {
      expect(await mail.send(from, letter(raw), NOW)).toEqual({ ok: false, message });
    };
    await refused({ to: "" }, "Enter a recipient.");
    await refused({ to: "Nobody" }, "There is no character named Nobody.");
    await refused({ to: "HERO" }, "You cannot send mail to yourself.");
    await refused({ to: "visitor" }, "Visitor is a guest and cannot receive mail.");
    await refused({ subject: "  " }, "Enter a subject.");
    await refused({ subject: "x".repeat(65) }, "A subject is 64 characters at most.");
    await refused({ body: "x".repeat(501) }, "A mail is 500 characters at most.");
    await refused({ items: [{ name: "Sealed Letter", quantity: 1 }] }, "Sealed Letter is a quest item and cannot be mailed.");
    await refused({ items: [{ name: "Iron Helmet", quantity: 1 }] }, "Iron Helmet is in use and cannot be mailed.");
    await refused({ items: [{ name: "Home Stone", quantity: 1 }] }, "Home Stone cannot be mailed.");
    await refused({ items: [{ name: "Bound Ring", quantity: 1 }] }, "Bound Ring is soulbound and cannot be mailed.");
    await refused({ items: [{ name: "Iron Ore", quantity: 11 }] }, "You do not have 11 Iron Ore.");
    await refused({ coins: coins(1, 2, 50) }, `You cannot afford the postage (${POSTAGE_COPPER} copper).`);
    await refused({}, "Please create an account to use that feature.", { username: "hero", isGuest: true });
    tables.ignores.push({ username: "ally", ignored: "hero" });
    // Written behind the caches, which are emptied so it is read.
    await clearCaches();
    await refused({}, "Ally is not accepting your mail.");

    expect(tables.mail).toEqual([]);
    expect(holds("hero")["Iron Ore"]).toBe(10);
    expect(purse("hero")).toBe(coinsWorth(coins(1, 2, 50)));
  });

  test("a full mailbox takes no more", async () => {
    for (let index = 0; index < INBOX_MAX; index++) stored();
    expect(await mail.send(hero, letter(), NOW)).toEqual({ ok: false, message: "Ally's mailbox is full." });
    expect(purse("hero")).toBe(coinsWorth(coins(1, 2, 50)));
  });

  test("a failed write leaves everything as it was, in the database and in what is held", async () => {
    failing = (sql) => sql.startsWith("INSERT INTO mail");
    const answer = await mail.send(hero, letter({ items: [{ name: "Iron Ore", quantity: 4 }] }), NOW);
    expect(answer).toEqual({ ok: false, message: "The mail could not be sent." });
    failing = null;
    expect(holds("hero")["Iron Ore"]).toBe(10);
    expect(await mail.inbox("ally", NOW)).toEqual([]);
    expect(await mail.send(hero, letter(), NOW)).toMatchObject({ ok: true });
    expect(await mail.inbox("ally", NOW)).toHaveLength(1);
  });
});

// -------------------------------------------------------------------- taking

describe("taking what is attached", () => {
  test("everything goes into the bags and purse, and a mail with text stays", async () => {
    const row = stored({ body: "Thanks", items: JSON.stringify([{ name: "Iron Ore", quantity: 3 }, { name: "Rat Tail", quantity: 1 }]), silver: 5 });
    expect(await mail.take("ally", row.id, "all")).toEqual({ ok: true, message: "Took 3 Iron Ore, 1 Rat Tail, the coins." });
    expect(holds("ally")).toEqual({ "Rat Tail": 3, "Iron Ore": 3 });
    expect(purse("ally")).toBe(500);
    expect(mailOf("ally")).toHaveLength(1);
    expect((await mail.inbox("ally", NOW))[0]).toMatchObject({ items: [], coins: coins(), read: true });
  });

  test("one item at a time, by its place", async () => {
    const row = stored({ items: JSON.stringify([{ name: "Iron Ore", quantity: 3 }, { name: "Rat Tail", quantity: 1 }]) });
    expect(await mail.take("ally", row.id, 1)).toEqual({ ok: true, message: "Took 1 Rat Tail." });
    expect((await mail.inbox("ally", NOW))[0].items).toEqual([{ ...item("Iron Ore"), quantity: 3 }]);
    expect(await mail.take("ally", row.id, 5)).toEqual({ ok: false, message: "Nothing is attached." });
  });

  test("a mail with no text is deleted once nothing is left on it", async () => {
    const row = stored({ items: JSON.stringify([{ name: "Iron Ore", quantity: 3 }]) });
    await mail.take("ally", row.id, "all");
    expect(mailOf("ally")).toEqual([]);
    expect(await mail.inbox("ally", NOW)).toEqual([]);
  });

  test("full bags take no new items", async () => {
    tables.inventory.push(...Array.from({ length: 24 }, (_, index) => ({ id: 50 + index, username: "ally", item: `Junk ${index}`, quantity: 1, equipped: 0, slot: index + 1, bag_slot: 0 })));
    const row = stored({ items: JSON.stringify([{ name: "Iron Ore", quantity: 3 }]) });
    expect(await mail.take("ally", row.id, "all")).toEqual({ ok: false, message: "Your bags are full." });
    expect(mailOf("ally")).toHaveLength(1);
  });

  test("someone else's mail is not there to take", async () => {
    const row = stored({ items: JSON.stringify([{ name: "Iron Ore", quantity: 3 }]) });
    expect(await mail.take("hero", row.id, "all")).toEqual({ ok: false, message: "That mail is gone." });
  });
});

// ------------------------------------------------ reading, deleting, returning

describe("reading, deleting and sending back", () => {
  test("a read mail is no longer unread", async () => {
    const row = stored();
    await mail.markRead("ally", row.id);
    expect(row.is_read).toBe(1);
    expect(await mail.unread("ally", NOW)).toBe(0);
  });

  test("a mail is deleted only once nothing is attached", async () => {
    const row = stored({ copper: 5 });
    expect(await mail.remove("ally", row.id)).toEqual({ ok: false, message: "Take what is attached first." });
    await mail.take("ally", row.id, "coins");
    expect(mailOf("ally")).toEqual([]);
    const empty = stored({ body: "Hi" });
    await clearCaches();
    expect(await mail.remove("ally", empty.id)).toEqual({ ok: true, message: "Mail deleted." });
    expect(mailOf("ally")).toEqual([]);
  });

  test("sent back, a mail waits in its sender's mailbox with what is still attached, once", async () => {
    const row = stored({ items: JSON.stringify([{ name: "Iron Ore", quantity: 3 }]) });
    expect(await mail.returnToSender("ally", row.id, NOW)).toEqual({ ok: true, message: "Mail sent back to Hero." });
    expect(mailOf("ally")).toEqual([]);
    const [back] = await mail.inbox("hero", NOW);
    expect(back).toMatchObject({ sender: "Ally", returned: true, read: false, expiresAt: NOW + MAIL_DAYS * DAY });
    expect(await mail.returnToSender("hero", back.id, NOW)).toEqual({ ok: false, message: "Mail that was sent back cannot be sent back again." });
  });
});

// -------------------------------------------------------------------- expiry

describe("old mail", () => {
  test("goes back to its sender while something is attached, and is deleted when not", async () => {
    const withItems = stored({ items: JSON.stringify([{ name: "Iron Ore", quantity: 3 }]), expires_at: NOW - 1 });
    stored({ subject: "Empty", expires_at: NOW - 1 });
    stored({ subject: "Back already", returned: 1, copper: 5, expires_at: NOW - 1 });
    const fresh = stored({ subject: "Fresh" });

    expect((await mail.inbox("ally", NOW)).map((view) => view.id)).toEqual([fresh.id]);
    expect(mailOf("hero").map((row) => row.id)).toEqual([withItems.id]);
    expect((await mail.inbox("hero", NOW))[0]).toMatchObject({ returned: true, sender: "Ally" });
  });
});
