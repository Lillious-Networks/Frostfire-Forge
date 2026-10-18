import { beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

// ------------------------------------------------------------ fake database
// One accounts table, with the statements a login sends.

type Row = Record<string, any>;
let accounts: Row[];
/** What player.clear() wrote to every account. */
let clearedWith: string[] = [];

const byToken = (token: string) => accounts.find((row) => row.token === token);

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text === "SELECT username, banned, token_expires, twofa_pending, email_verified, guest_mode FROM accounts WHERE token = ?") {
      const row = byToken(params[0]);
      return row ? [{ username: row.username, banned: row.banned, token_expires: row.token_expires, twofa_pending: row.twofa_pending, email_verified: row.email_verified, guest_mode: row.guest_mode }] : [];
    }
    if (text.startsWith("UPDATE accounts SET verification_code = NULL")) {
      clearedWith.push(text);
      return { affectedRows: accounts.length };
    }
    if (text === "UPDATE accounts SET token = NULL, token_expires = NULL WHERE token = ?") {
      const row = byToken(params[0]);
      if (row) Object.assign(row, { token: null, token_expires: null });
      return { affectedRows: row ? 1 : 0 };
    }
    if (text.startsWith("UPDATE accounts SET session_id = ?, online = 1, session_server = ?, session_seen = ? WHERE token = ?")) {
      const [sid, server, seen, token, again] = params;
      const row = byToken(token);
      if (row && (!row.online || !row.session_id || row.session_id === again)) Object.assign(row, { session_id: sid, online: 1, session_server: server, session_seen: seen });
      return { affectedRows: 1 };
    }
    if (text === "SELECT session_id, session_server, session_seen FROM accounts WHERE username = ?") {
      const row = accounts.find((account) => account.username === params[0]);
      return row ? [{ session_id: row.session_id, session_server: row.session_server, session_seen: row.session_seen }] : [];
    }
    if (text === "UPDATE accounts SET session_id = NULL, online = ? WHERE session_id = ?") {
      for (const row of accounts) if (row.session_id === params[1]) Object.assign(row, { session_id: null, online: params[0] });
      return { affectedRows: 1 };
    }
    if (text === "SELECT session_id FROM accounts WHERE token = ?") {
      const row = byToken(params[0]);
      return row ? [{ session_id: row.session_id }] : [];
    }
    if (text === "SELECT username FROM accounts WHERE token = ? AND token_expires > ?") {
      const row = byToken(params[0]);
      return row && Number(row.token_expires) > params[1] ? [{ username: row.username }] : [];
    }
    if (text === "UPDATE accounts SET token = ?, token_expires = ? WHERE username = ?") {
      const row = accounts.find((account) => account.username === params[2]);
      if (row) Object.assign(row, { token: params[0], token_expires: params[1] });
      return { affectedRows: row ? 1 : 0 };
    }
    return [];
  },
}));

const { default: player, tokenLive, loginStepMissing, heldElsewhere } = await import("../systems/player");

const HOUR = 60 * 60 * 1000;

const account = (username: string, over: Row = {}): Row => ({
  username, banned: 0, token: `t-${username}`, token_expires: Date.now() + HOUR, session_id: null, online: 0,
  twofa_pending: 0, email_verified: 1, guest_mode: 0, ...over,
});

beforeEach(() => {
  clearedWith = [];
  accounts = [
    account("fresh"),
    account("stale", { token_expires: Date.now() - 1 }),
    // Issued before tokens had an expiry.
    account("legacy", { token_expires: null }),
    // Password given, second factor not yet.
    account("halfway", { twofa_pending: 1 }),
    account("unverified", { email_verified: 0 }),
    account("guest_1", { email_verified: 0, guest_mode: 1 }),
  ];
});

describe("a token logs in only once every login step is done", () => {
  test("not while two-factor authentication is pending", async () => {
    expect(await player.setSessionId("t-halfway", "601")).toBe(false);
    expect(accounts[3]).toMatchObject({ online: 0, session_id: null });
  });

  test("not before the e-mail address is verified", async () => {
    expect(await player.setSessionId("t-unverified", "602")).toBe(false);
  });

  test("a guest has no e-mail to verify", async () => {
    expect(await player.setSessionId("t-guest_1", "603")).toBe("guest_1");
  });

  test("loginStepMissing says which step", () => {
    expect(loginStepMissing({ twofa_pending: 1, email_verified: 1 })).toMatch(/two-factor/);
    expect(loginStepMissing({ twofa_pending: 0, email_verified: 0 })).toMatch(/e-mail/);
    expect(loginStepMissing({ twofa_pending: "0", email_verified: "1" })).toBeNull();
    expect(loginStepMissing(undefined)).toMatch(/e-mail/);
  });

  test("a restart leaves a pending second step pending", async () => {
    await player.clear();
    expect(clearedWith.length).toBeGreaterThan(0);
    for (const text of clearedWith) expect(text).not.toContain("twofa_pending");
  });
});

describe("account tokens expire", () => {
  test("a token within its lifetime logs in", async () => {
    expect(await player.setSessionId("t-fresh", "501")).toBe("fresh");
  });

  test("an expired token is refused and forgotten", async () => {
    expect(await player.setSessionId("t-stale", "502")).toBe(false);
    expect(accounts[1].token).toBeNull();
    expect(accounts[1].online).toBe(0);
  });

  test("a token with no expiry has expired", async () => {
    expect(await player.setSessionId("t-legacy", "503")).toBe(false);
    expect(accounts[2].token).toBeNull();
  });

  test("a token is only found by name while it lasts", async () => {
    expect(await player.getUsernameByToken("t-fresh")).toEqual([{ username: "fresh" }]);
    expect(await player.getUsernameByToken("t-stale")).toEqual([]);
  });

  test("a new token is given an expiry in the future", async () => {
    const token = await player.setToken("legacy");
    expect(accounts[2].token).toBe(token);
    expect(tokenLive(accounts[2])).toBe(true);
    expect(accounts[2].token_expires).toBeGreaterThan(Date.now() + 24 * HOUR);
  });

  test("tokenLive reads the expiry as a number, as either database gives it", () => {
    expect(tokenLive({ token_expires: String(Date.now() + HOUR) })).toBe(true);
    expect(tokenLive({ token_expires: Date.now() - 1 })).toBe(false);
    expect(tokenLive({ token_expires: null })).toBe(false);
    expect(tokenLive(undefined)).toBe(false);
  });
});

describe("one account, one realm at a time", () => {
  test("a session another realm still vouches for is not taken over", async () => {
    Object.assign(accounts[0], { online: 1, session_id: "999", session_server: "realm-b", session_seen: Date.now() - 1000 });
    expect(await player.setSessionId("t-fresh", "701")).toBe(false);
    expect(accounts[0]).toMatchObject({ session_id: "999", session_server: "realm-b" });
  });

  test("one the other realm stopped vouching for is taken over", async () => {
    Object.assign(accounts[0], { online: 1, session_id: "999", session_server: "realm-b", session_seen: Date.now() - 10 * 60_000 });
    expect(await player.setSessionId("t-fresh", "702")).toBe("fresh");
    expect(accounts[0]).toMatchObject({ session_id: "702", online: 1 });
  });

  test("one held by this realm is taken over, as a second login here always was", async () => {
    Object.assign(accounts[0], { online: 1, session_id: "999", session_server: process.env.SERVER_ID || "default", session_seen: Date.now() });
    expect(await player.setSessionId("t-fresh", "703")).toBe("fresh");
  });

  test("heldElsewhere reads either database's values", () => {
    expect(heldElsewhere({ session_server: "realm-b", session_seen: String(Date.now()) })).toBe(true);
    expect(heldElsewhere({ session_server: null, session_seen: Date.now() })).toBe(false);
    expect(heldElsewhere({ session_server: "realm-b", session_seen: null })).toBe(false);
  });
});
