// Mail, as in World of Warcraft. At a mailbox a player writes to another
// character by name, with items and coins attached, and pays postage. The mail
// waits in the recipient's mailbox until they take what is attached. Mail left
// MAIL_DAYS goes back to its sender while anything is still attached to it, and
// is deleted when nothing is (or when it was sent back already).
//
// Mailboxes stand in front of inns: one beside the door of each house an
// innkeeper is in, on open country (see mailboxesOn). Mail is only read, sent
// or taken within reach of one; that is the caller's to check (atMailbox).
//
// Each player's mail is held in a per-player cache: reads are answered from it,
// and every change is written to the database and then to it. A change that
// also moves items or coins goes through a batch (services/batch), so the mail
// and the belongings change together or not at all.

import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import assetCache from "../services/assetCache";
import { atomically, type Batch } from "../services/batch";
import { rowCache, turns } from "../services/datacache";
import bags from "./bags";
import currency, { CURRENCY_LIMITS, coinsOf, coinsWorth } from "./currency";
import ignores from "./ignores";
import inventory from "./inventory";
import { innDoors } from "./mapmarkers";
import player from "./player";
import { inUse } from "./spare";
import { readGift } from "./trades";

/** How far (px) from a mailbox a player may stand and still use it. The reach of talking to an NPC. */
export const MAIL_RANGE = 120;
/** How many different items one mail holds. */
export const MAIL_ITEMS_MAX = 12;
/** How many mails a mailbox holds. Mail sent back to its sender is let in past this. */
export const INBOX_MAX = 100;
export const SUBJECT_MAX = 64;
export const BODY_MAX = 500;
/** Postage, in copper: for each item attached, and for a mail with none. */
export const POSTAGE_COPPER = 30;
/** How long a mail waits before it goes back, or is deleted. */
export const MAIL_DAYS = 30;
const DAY_MS = 86_400_000;

export interface MailItem {
  name: string;
  quantity: number;
}

/** A row of the mail table. Times are milliseconds since the epoch. */
export interface Mail {
  id: number;
  /** Whose mailbox it is in, as accounts are keyed (lower case). */
  recipient: string;
  sender: string;
  subject: string;
  body: string;
  items: MailItem[];
  coins: Currency;
  sent_at: number;
  expires_at: number;
  read: boolean;
  /** It was sent back to its sender: it is not sent back again. */
  returned: boolean;
}

/** What a player is shown of a mail: each item with what it is (its icon, quality and so on). */
export interface MailView {
  id: number;
  sender: string;
  subject: string;
  body: string;
  items: Array<Record<string, unknown>>;
  coins: Currency;
  sentAt: number;
  expiresAt: number;
  read: boolean;
  returned: boolean;
}

/** Who is mailing: what the rules read of a player. */
export interface Mailer {
  username: string;
  isGuest?: boolean;
}

export type MailAnswer = { ok: true; message: string } | { ok: false; message: string };
export type SendAnswer = { ok: true; message: string; recipient: string } | { ok: false; message: string };

/** A change that is not made, for a reason the player is told. */
class Refused extends Error {}

const lower = (username: unknown) => String(username ?? "").toLowerCase();
/** A name as players read it. */
const named = (username: string) => username.charAt(0).toUpperCase() + username.slice(1);
const noCoins = (): Currency => ({ copper: 0, silver: 0, gold: 0 });
const MOST_COINS = coinsWorth(CURRENCY_LIMITS);
const hasAttachments = (mail: Mail) => mail.items.length > 0 || coinsWorth(mail.coins) > 0;

/** Postage for a mail with `items` different items attached, in copper. */
export const postageFor = (items: number) => POSTAGE_COPPER * Math.max(1, items);

// ---------------------------------------------------------------- mailboxes

export interface Mailbox {
  id: string;
  /** Where it stands (map px): the middle of its foot. */
  x: number;
  y: number;
}

/**
 * Where a map's mailboxes stand: in front of each inn's door (see mapmarkers.innDoors), one tile
 * out from the door and beside the way in, on the right where that is clear, else on the left.
 * `blocked` says whether a point (map px) is in something solid.
 */
export function mailboxesOn(
  map: string,
  npcs: Npc[],
  warps: WarpObject[] | Record<string, WarpObject> | null | undefined,
  outdoors: (map: string) => boolean,
  blocked: (x: number, y: number) => boolean = () => false,
): Mailbox[] {
  const here = String(map ?? "").replaceAll(".json", "");
  const boxes: Mailbox[] = [];
  for (const door of innDoors(here, npcs, warps, outdoors)) {
    const left = Number(door.position?.x);
    const top = Number(door.position?.y);
    const width = Number(door.size?.width) || 32;
    const height = Number(door.size?.height) || 32;
    const foot = top + height + 24;
    const spots = [
      { x: left + width + 24, y: foot },
      { x: left - 24, y: foot },
      { x: left + width + 24, y: foot + 32 },
      { x: left - 24, y: foot + 32 },
    ];
    const spot = spots.find((at) => !blocked(at.x, at.y - 4)) ?? spots[0];
    const x = Math.round(spot.x);
    const y = Math.round(spot.y);
    boxes.push({ id: `${here}:${x}:${y}`, x, y });
  }
  return boxes;
}

/** Whether a player standing at `x`, `y` is within reach of one of `boxes`. */
export function atMailbox(boxes: Mailbox[], x: number, y: number): boolean {
  return boxes.some((box) => Math.hypot(box.x - x, box.y - y) <= MAIL_RANGE);
}

// -------------------------------------------------------------------- schema

const sqlite = (): boolean => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";

/** The mail table, as the setup scripts make it. */
export const MAIL_TABLE: Record<"mysql" | "sqlite", string> = {
  mysql: `
    CREATE TABLE IF NOT EXISTS mail (
      id INT AUTO_INCREMENT PRIMARY KEY,
      recipient VARCHAR(255) NOT NULL,
      sender VARCHAR(255) NOT NULL,
      subject VARCHAR(64) NOT NULL,
      body TEXT NOT NULL,
      items TEXT NOT NULL,
      copper INT NOT NULL DEFAULT 0,
      silver INT NOT NULL DEFAULT 0,
      gold INT NOT NULL DEFAULT 0,
      sent_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      is_read INT NOT NULL DEFAULT 0,
      returned INT NOT NULL DEFAULT 0,
      INDEX idx_mail_recipient (recipient)
    )
  `,
  sqlite: `
    CREATE TABLE IF NOT EXISTS mail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      sender TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      items TEXT NOT NULL,
      copper INTEGER NOT NULL DEFAULT 0,
      silver INTEGER NOT NULL DEFAULT 0,
      gold INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      returned INTEGER NOT NULL DEFAULT 0
    )
  `,
};

/**
 * Start-time safety step: the setup scripts make the mail table, but a database that is already
 * live may not have had its setup run before this version starts. Safe on every start. It never
 * throws: when the table cannot be made, one warning is logged and mail fails when it is used.
 */
export async function ensureMailSchema(): Promise<boolean> {
  try {
    await query(MAIL_TABLE[sqlite() ? "sqlite" : "mysql"]);
    if (sqlite()) await query("CREATE INDEX IF NOT EXISTS idx_mail_recipient ON mail (recipient)");
    return true;
  } catch (error) {
    log.warn(`[Mail] The mail table could not be made: ${error}`);
    return false;
  }
}

// --------------------------------------------------------------------- cache

const COLUMNS = "id, recipient, sender, subject, body, items, copper, silver, gold, sent_at, expires_at, is_read, returned";

/** What a row holds of the items: text, or already parsed in a JSON column. A row that cannot be read holds none. */
function itemsOf(stored: unknown): MailItem[] {
  try {
    const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item) => typeof item?.name === "string" && Number(item?.quantity) > 0)
        .map((item) => ({ name: item.name, quantity: Number(item.quantity) }));
    }
  } catch {
    // Shown as nothing attached.
  }
  return [];
}

const fromRow = (row: any): Mail => ({
  id: Number(row.id),
  recipient: lower(row.recipient),
  sender: String(row.sender ?? ""),
  subject: String(row.subject ?? ""),
  body: String(row.body ?? ""),
  items: itemsOf(row.items),
  coins: { copper: Number(row.copper) || 0, silver: Number(row.silver) || 0, gold: Number(row.gold) || 0 },
  sent_at: Number(row.sent_at),
  expires_at: Number(row.expires_at),
  read: Number(row.is_read) === 1,
  returned: Number(row.returned) === 1,
});

// Each player's mail, oldest first.
const rows = rowCache<Mail[]>("mail", async (username) =>
  (((await query(`SELECT ${COLUMNS} FROM mail WHERE recipient = ? ORDER BY id`, [username])) as any[]) || []).map(fromRow)
, { perPlayer: true });

// One change to a player's mail at a time: each works from the mail held and puts back the result.
const oneAtATime = turns();

/** The id the database gave the row an INSERT made, when its answer says. */
function insertedId(result: any): number | null {
  const id = Number(result?.lastInsertRowid);
  return Number.isInteger(id) && id > 0 ? id : null;
}

type Pending = { held: Mail[]; written: boolean; unknown: boolean };

/**
 * A player's mail as `batch` has it so far, with this system's turn for them taken until the batch
 * ends. Once the batch is kept, what it left is the mail held; if it is not, the mail held is
 * forgotten and the next read asks the database.
 */
async function pendingIn(batch: Batch, username: string): Promise<Pending> {
  await batch.hold(oneAtATime, username);
  return batch.pending(rows, username, async () => {
    const pending: Pending = { held: (await rows.get(username)) ?? [], written: false, unknown: false };
    batch.kept(() => (pending.written ? (pending.unknown ? rows.drop(username) : rows.set(username, pending.held)) : undefined));
    batch.undone(() => (pending.written ? rows.drop(username) : undefined));
    return pending;
  });
}

/** A change to one player's mail alone: the statement, then what it left as the mail held. */
function write(username: string, sql: string, values: unknown[], left: (held: Mail[]) => Mail[]): Promise<void> {
  return oneAtATime(username, async () => {
    const held = (await rows.get(username)) ?? [];
    try {
      await query(sql, values);
    } catch (error) {
      // A statement that failed may still have been written (one that timed out, say).
      await rows.drop(username);
      throw error;
    }
    await rows.set(username, left(held));
  });
}

/** Runs a change, and answers a refusal or a failure in words: nothing was written when it is not `ok`. */
async function settle(what: string, work: () => Promise<string>): Promise<MailAnswer> {
  try {
    return { ok: true, message: await work() };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, message: error.message };
    log.error(`Mail could not be ${what}: ${error}`);
    return { ok: false, message: `The mail could not be ${what}.` };
  }
}

/** Text a player wrote, without control characters (a body keeps its line breaks). */
const cleaned = (text: unknown, lines: boolean) =>
  String(text ?? "").replace(lines ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, "");

/** Sends `mail` back to its sender, as part of `batch`: it leaves `owner`'s mailbox and waits in theirs as new. */
async function sendBack(batch: Batch, owner: string, mail: Mail, now: number): Promise<void> {
  const from = await pendingIn(batch, owner);
  const to = await pendingIn(batch, lower(mail.sender));
  const back: Mail = { ...mail, recipient: lower(mail.sender), sender: owner, sent_at: now, expires_at: now + MAIL_DAYS * DAY_MS, read: false, returned: true };
  batch.add({
    sql: "UPDATE mail SET recipient = ?, sender = ?, sent_at = ?, expires_at = ?, is_read = 0, returned = 1 WHERE id = ? AND recipient = ?",
    values: [back.recipient, back.sender, back.sent_at, back.expires_at, mail.id, owner],
    mustChange: true,
  });
  from.held = from.held.filter((held) => held.id !== mail.id);
  from.written = true;
  to.held = [...to.held, back];
  to.written = true;
}

const mail = {
  /**
   * Sends a mail: `raw` is { to, subject, body, items: [{ name, quantity }], coins }. What is
   * attached and the postage leave the sender's bags and purse, and the mail is in the recipient's
   * mailbox, together or not at all.
   */
  async send(from: Mailer, raw: any, now = Date.now()): Promise<SendAnswer> {
    if (from.isGuest) return { ok: false, message: "Please create an account to use that feature." };
    const to = cleaned(raw?.to, false).trim().slice(0, 64);
    if (!to) return { ok: false, message: "Enter a recipient." };
    const account = await player.getAccount(to);
    if (!account) return { ok: false, message: `There is no character named ${to}.` };
    const recipient = lower(account.username);
    const sender = lower(from.username);
    const their = named(String(account.username));
    if (recipient === sender) return { ok: false, message: "You cannot send mail to yourself." };
    if (Number(account.guest_mode) === 1) return { ok: false, message: `${their} is a guest and cannot receive mail.` };

    const subject = cleaned(raw?.subject, false).trim();
    if (!subject) return { ok: false, message: "Enter a subject." };
    if (subject.length > SUBJECT_MAX) return { ok: false, message: `A subject is ${SUBJECT_MAX} characters at most.` };
    const body = cleaned(raw?.body, true).trimEnd();
    if (body.length > BODY_MAX) return { ok: false, message: `A mail is ${BODY_MAX} characters at most.` };
    if (await ignores.blocks(recipient, sender)) return { ok: false, message: `${their} is not accepting your mail.` };

    const gift = await readGift(sender, { items: raw?.items ?? [], coins: raw?.coins }, { most: MAIL_ITEMS_MAX, holder: "A mail", verb: "mailed" });
    if (typeof gift === "string") return { ok: false, message: gift };
    const postage = postageFor(gift.items.length);
    const cost = coinsWorth(gift.coins) + postage;
    if (coinsWorth(await currency.get(sender)) < cost) return { ok: false, message: `You cannot afford the postage (${postage} copper).` };

    const answer = await settle("sent", () => atomically([sender, recipient], async (batch) => {
      for (const item of gift.items) {
        const held = await inventory.heldIn(batch, sender, item.name);
        if (!held || held.quantity - (await inUse(sender, item.name, held.equipped)) < item.quantity) {
          throw new Refused(`You no longer have ${item.quantity} ${item.name}.`);
        }
      }
      if (coinsWorth(await currency.heldIn(batch, sender)) < cost) throw new Refused(`You cannot afford the postage (${postage} copper).`);
      const box = await pendingIn(batch, recipient);
      if (box.held.length >= INBOX_MAX) throw new Refused(`${their}'s mailbox is full.`);

      for (const item of gift.items) {
        if (!(await inventory.remove(sender, item, batch))) throw new Refused(`You no longer have ${item.quantity} ${item.name}.`);
      }
      await currency.remove(sender, coinsOf(cost), batch);

      const sent: Mail = {
        id: 0, recipient, sender: from.username, subject, body, items: gift.items, coins: { ...gift.coins },
        sent_at: now, expires_at: now + MAIL_DAYS * DAY_MS, read: false, returned: false,
      };
      batch.add({
        sql: "INSERT INTO mail (recipient, sender, subject, body, items, copper, silver, gold, sent_at, expires_at, is_read, returned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
        values: [recipient, sent.sender, subject, body, JSON.stringify(sent.items), sent.coins.copper, sent.coins.silver, sent.coins.gold, sent.sent_at, sent.expires_at],
        mustChange: true,
      }, (result) => {
        const id = insertedId(result);
        if (id === null) box.unknown = true;
        else sent.id = id;
      });
      box.held = [...box.held, sent];
      box.written = true;
      return `Mail sent to ${their}.`;
    }));
    return answer.ok ? { ok: true, message: answer.message, recipient } : answer;
  },

  /**
   * Takes what is attached to one of a player's mails into their bags and purse: `part` is
   * "all", "coins", or the index of one item. A mail with no text and nothing left is deleted.
   */
  async take(owner: string, mailId: number, part: "all" | "coins" | number): Promise<MailAnswer> {
    const name = lower(owner);
    const found = ((await rows.get(name)) ?? []).find((held) => held.id === Number(mailId));
    if (!found) return { ok: false, message: "That mail is gone." };
    const wanted = (held: Mail) => (part === "all" ? held.items : part === "coins" ? [] : held.items[part] ? [held.items[part]] : []);
    // Room is looked at before the batch, as a vendor does: one new slot for anything not held already.
    const carried = ((await inventory.get(name)) as any[]) ?? [];
    const newStacks = wanted(found).filter((item) => !carried.some((row) => lower(row.item ?? row.name) === lower(item.name))).length;
    if (newStacks > 0 && carried.length + newStacks > (await bags.capacity(name))) return { ok: false, message: "Your bags are full." };

    return settle("taken", () => atomically([name], async (batch) => {
      const box = await pendingIn(batch, name);
      const held = box.held.find((other) => other.id === Number(mailId));
      if (!held) throw new Refused("That mail is gone.");
      const items = wanted(held);
      const coins = part === "all" || part === "coins" ? held.coins : noCoins();
      if (items.length === 0 && coinsWorth(coins) === 0) throw new Refused("Nothing is attached.");

      if (coinsWorth(coins) > 0) {
        if (coinsWorth(await currency.heldIn(batch, name)) + coinsWorth(coins) > MOST_COINS) throw new Refused("You cannot hold that many coins.");
        await currency.add(name, coins, batch);
      }
      for (const item of items) {
        if (!(await inventory.add(name, item, batch))) throw new Error(`${item.name} could not be given to ${name}`);
      }

      const left: Mail = {
        ...held,
        items: held.items.filter((item) => !items.includes(item)),
        coins: coinsWorth(coins) > 0 ? noCoins() : held.coins,
        read: true,
      };
      if (!hasAttachments(left) && !left.body.trim()) {
        batch.add({ sql: "DELETE FROM mail WHERE id = ? AND recipient = ?", values: [held.id, name], mustChange: true });
        box.held = box.held.filter((other) => other.id !== held.id);
      } else {
        batch.add({
          sql: "UPDATE mail SET items = ?, copper = ?, silver = ?, gold = ?, is_read = 1 WHERE id = ? AND recipient = ?",
          values: [JSON.stringify(left.items), left.coins.copper, left.coins.silver, left.coins.gold, held.id, name],
          mustChange: true,
        });
        box.held = box.held.map((other) => (other.id === held.id ? left : other));
      }
      box.written = true;
      const took = [...items.map((item) => `${item.quantity} ${item.name}`), ...(coinsWorth(coins) > 0 ? ["the coins"] : [])];
      return `Took ${took.join(", ")}.`;
    }));
  },

  /** Marks one of a player's mails read. */
  async markRead(owner: string, mailId: number): Promise<void> {
    const name = lower(owner);
    const held = ((await rows.get(name)) ?? []).find((other) => other.id === Number(mailId));
    if (!held || held.read) return;
    await write(name, "UPDATE mail SET is_read = 1 WHERE id = ? AND recipient = ?", [held.id, name], (all) =>
      all.map((other) => (other.id === held.id ? { ...other, read: true } : other)));
  },

  /** Deletes one of a player's mails. One with something still attached is not deleted. */
  async remove(owner: string, mailId: number): Promise<MailAnswer> {
    const name = lower(owner);
    const held = ((await rows.get(name)) ?? []).find((other) => other.id === Number(mailId));
    if (!held) return { ok: false, message: "That mail is gone." };
    if (hasAttachments(held)) return { ok: false, message: "Take what is attached first." };
    return settle("deleted", async () => {
      await write(name, "DELETE FROM mail WHERE id = ? AND recipient = ?", [held.id, name], (all) => all.filter((other) => other.id !== held.id));
      return "Mail deleted.";
    });
  },

  /** Sends one of a player's mails back to whoever sent it, with what is still attached. */
  async returnToSender(owner: string, mailId: number, now = Date.now()): Promise<MailAnswer> {
    const name = lower(owner);
    const held = ((await rows.get(name)) ?? []).find((other) => other.id === Number(mailId));
    if (!held) return { ok: false, message: "That mail is gone." };
    if (held.returned) return { ok: false, message: "Mail that was sent back cannot be sent back again." };
    if (!(await player.getAccount(held.sender))) return { ok: false, message: `${named(held.sender)} no longer exists.` };
    const sender = lower(held.sender);
    return settle("sent back", () => atomically([name, sender], async (batch) => {
      const box = await pendingIn(batch, name);
      const still = box.held.find((other) => other.id === held.id);
      if (!still) throw new Refused("That mail is gone.");
      await sendBack(batch, name, still, now);
      return `Mail sent back to ${named(held.sender)}.`;
    }));
  },

  /**
   * Deals with a player's mail that waited too long: sent back to its sender while anything is
   * attached (and it was not sent back already, and the sender still exists), deleted otherwise.
   */
  async expire(owner: string, now = Date.now()): Promise<void> {
    const name = lower(owner);
    const due = ((await rows.get(name)) ?? []).filter((held) => held.expires_at <= now);
    if (due.length === 0) return;
    const goesBack = async (held: Mail) =>
      hasAttachments(held) && !held.returned && lower(held.sender) !== name && !!(await player.getAccount(held.sender));
    const senders: string[] = [];
    for (const held of due) if (await goesBack(held)) senders.push(lower(held.sender));
    try {
      await atomically([name, ...senders], async (batch) => {
        const box = await pendingIn(batch, name);
        for (const held of box.held.filter((other) => other.expires_at <= now)) {
          if (senders.includes(lower(held.sender)) && (await goesBack(held))) {
            await sendBack(batch, name, held, now);
          } else {
            batch.add({ sql: "DELETE FROM mail WHERE id = ? AND recipient = ?", values: [held.id, name] });
            box.held = box.held.filter((other) => other.id !== held.id);
            box.written = true;
          }
        }
      });
    } catch (error) {
      log.error(`The old mail of ${name} could not be dealt with: ${error}`);
    }
  },

  /** A player's mail as they are shown it, the newest first. Old mail is dealt with first (see expire). */
  async inbox(owner: string, now = Date.now()): Promise<MailView[]> {
    const name = lower(owner);
    await mail.expire(name, now);
    const definitions = new Map((((await assetCache.get("items")) as Item[]) || []).map((item) => [lower(item.name), item]));
    return ((await rows.get(name)) ?? [])
      .slice()
      .sort((a, b) => b.sent_at - a.sent_at || b.id - a.id)
      .map((held) => ({
        id: held.id,
        sender: named(held.sender),
        subject: held.subject,
        body: held.body,
        items: held.items.map(({ name: item, quantity }) => ({ ...(definitions.get(lower(item)) ?? { name: item }), quantity })),
        coins: { ...held.coins },
        sentAt: held.sent_at,
        expiresAt: held.expires_at,
        read: held.read,
        returned: held.returned,
      }));
  },

  /** How many of a player's mails are unread. */
  async unread(owner: string, now = Date.now()): Promise<number> {
    return ((await rows.get(lower(owner))) ?? []).filter((held) => !held.read && held.expires_at > now).length;
  },
};

export default mail;
