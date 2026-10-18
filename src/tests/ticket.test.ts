import { describe, expect, test } from "bun:test";
import { accountBinding, checkTicket, signTicket, ticketAllows, ticketPayload } from "../socket/ticket";

const SECRET = "test-secret";
const NOW = 1_800_000_000_000;
let seq = 0;

/** A ticket as the Gateway issues one: for this account token, from this origin. */
function issue(over: Record<string, unknown> = {}, accountToken = "account-token", origin = "https://play.example") {
  const token = `ticket-${++seq}`;
  const timestamp = String(NOW);
  const expiresAt = String(NOW + 60_000);
  const account = accountBinding(accountToken);
  return { token, timestamp, expiresAt, origin, account, signature: signTicket(SECRET, token, timestamp, expiresAt, origin, account), ...over };
}

describe("a connection ticket", () => {
  test("signs the origin and the account with the rest", () => {
    expect(ticketPayload("t", "1", "2", "https://o", "a")).toBe("t:1:2:https://o:a");
  });

  test("a good one is accepted once, and names its account", () => {
    const ticket = issue();
    expect(checkTicket(ticket, SECRET, ["https://play.example"], NOW)).toEqual({ ok: true, account: accountBinding("account-token"), origin: "https://play.example" });
    expect(checkTicket(ticket, SECRET, ["https://play.example"], NOW)).toMatchObject({ ok: false, reason: "already used" });
  });

  test("a changed origin or account breaks the signature", () => {
    expect(checkTicket({ ...issue(), origin: "https://evil.example" }, SECRET, [], NOW)).toMatchObject({ ok: false, reason: "invalid signature" });
    expect(checkTicket({ ...issue(), account: accountBinding("someone-else") }, SECRET, [], NOW)).toMatchObject({ ok: false, reason: "invalid signature" });
  });

  test("a signed origin not on the list is refused", () => {
    expect(checkTicket(issue({}, "x", "https://other.example"), SECRET, ["https://play.example"], NOW)).toMatchObject({ ok: false });
  });

  test("expired, wrong secret, garbage signature or missing fields are refused", () => {
    expect(checkTicket(issue(), SECRET, [], NOW + 60_001)).toMatchObject({ ok: false, reason: "expired" });
    expect(checkTicket(issue(), "other-secret", [], NOW)).toMatchObject({ ok: false, reason: "invalid signature" });
    expect(checkTicket(issue({ signature: "zz" }), SECRET, [], NOW)).toMatchObject({ ok: false, reason: "invalid signature" });
    expect(checkTicket(issue({ signature: undefined }), SECRET, [], NOW)).toMatchObject({ ok: false, reason: "incomplete" });
    expect(checkTicket(issue(), undefined, [], NOW)).toMatchObject({ ok: false });
  });
});

describe("a login on a ticket's connection", () => {
  test("is allowed only with the account token the ticket was issued for", () => {
    const binding = accountBinding("account-token");
    expect(ticketAllows(binding, "account-token")).toBe(true);
    expect(ticketAllows(binding, "another-token")).toBe(false);
    // A ticket for no account (a client that only connects) logs nobody in.
    expect(ticketAllows("", "account-token")).toBe(false);
    expect(ticketAllows(undefined, "account-token")).toBe(false);
  });
});
