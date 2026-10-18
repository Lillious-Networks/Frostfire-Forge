// The connection ticket the Gateway signs (GET /api/gateway/connection-token)
// and a client hands the game server in AUTH_CONNECT. The signed string covers
// the origin the Gateway saw and the account the ticket is for, so neither can
// be swapped by the client, and a ticket opens one connection only.
//
// The Gateway's src/webserver/server.ts and the benchmark's generator
// (src/utility/benchmark-transport.ts) build the same string: change all three together.

import crypto from "crypto";

/** The account a ticket is for: the SHA-256 of its account token, so the ticket never carries the token itself. */
export function accountBinding(accountToken: string): string {
  return crypto.createHash("sha256").update(String(accountToken)).digest("hex");
}

/** The string a ticket's signature is the HMAC-SHA256 of. */
export function ticketPayload(token: string, timestamp: string, expiresAt: string, origin: string, account: string): string {
  return `${token}:${timestamp}:${expiresAt}:${origin}:${account}`;
}

export function signTicket(secret: string, token: string, timestamp: string, expiresAt: string, origin: string, account: string): string {
  return crypto.createHmac("sha256", secret).update(ticketPayload(token, timestamp, expiresAt, origin, account)).digest("hex");
}

export interface TicketFields {
  token?: unknown;
  timestamp?: unknown;
  expiresAt?: unknown;
  signature?: unknown;
  origin?: unknown;
  account?: unknown;
}

export type TicketCheck = { ok: true; account: string; origin: string } | { ok: false; reason: string };

// Tickets already used, until they expire: each opens one connection.
const used = new Map<string, number>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < 30_000) return;
  lastSweep = now;
  for (const [token, expires] of used) if (expires < now) used.delete(token);
}

/**
 * Checks a ticket: its signature (compared in constant time), that it has not
 * expired, that its origin is allowed (when a list is given), and that it was
 * not used before. On success it is spent, and the account it is for is
 * returned ("" for a ticket for no account, which cannot log anyone in).
 */
export function checkTicket(fields: TicketFields, secret: string | undefined, allowedOrigins: readonly string[], now = Date.now()): TicketCheck {
  const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : null);
  const token = text(fields.token);
  const timestamp = text(fields.timestamp);
  const expiresAt = text(fields.expiresAt);
  const signature = text(fields.signature);
  const origin = text(fields.origin) ?? "";
  const account = text(fields.account) ?? "";
  if (!token || !timestamp || !expiresAt || !signature) return { ok: false, reason: "incomplete" };
  if (!secret) return { ok: false, reason: "no secret" };

  const expected = Buffer.from(signTicket(secret, token, timestamp, expiresAt, origin, account), "hex");
  const given = /^[0-9a-f]+$/i.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "invalid signature" };

  const expires = Number(expiresAt);
  if (!Number.isFinite(expires) || now > expires) return { ok: false, reason: "expired" };

  const allowed = allowedOrigins.map((o) => o.trim()).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(origin)) return { ok: false, reason: `disallowed origin ${origin}` };

  sweep(now);
  if (used.has(token)) return { ok: false, reason: "already used" };
  used.set(token, expires);
  return { ok: true, account, origin };
}

/** Whether the account token sent at login is the one the connection's ticket is for. */
export function ticketAllows(ticketAccount: unknown, accountToken: string): boolean {
  if (typeof ticketAccount !== "string" || ticketAccount.length !== 64) return false;
  const expected = Buffer.from(accountBinding(accountToken), "hex");
  const given = Buffer.from(ticketAccount, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
