// The connection ticket the Gateway signs (GET /api/gateway/connection-token)
// and a client hands the game server in AUTH_CONNECT. The signed string covers
// the origin the Gateway saw and the account the ticket is for, so neither can
// be swapped by the client, and a ticket opens one connection only.
//
// A ticket may also name the cluster node it is for (nodeId). That field is
// optional: it is empty for tickets from the Gateway until phase 3, and the
// signed string is then unchanged (no trailing ":"). A ticket that names a
// node is refused by every other node; in cluster mode a ticket must name one.
// A node signs tickets too: for a login it hands to the node that owns the
// player's spawn block (SWITCH, see nodeTicket).
//
// The Gateway's src/webserver/server.ts and the benchmark's generator
// (src/utility/benchmark-transport.ts) build the same string: change all three together.

import crypto from "crypto";

/** The account a ticket is for: the SHA-256 of its account token, so the ticket never carries the token itself. */
export function accountBinding(accountToken: string): string {
  return crypto.createHash("sha256").update(String(accountToken)).digest("hex");
}

/** The string a ticket's signature is the HMAC-SHA256 of. The node id is appended only when there is one. */
export function ticketPayload(token: string, timestamp: string, expiresAt: string, origin: string, account: string, nodeId = ""): string {
  const base = `${token}:${timestamp}:${expiresAt}:${origin}:${account}`;
  return nodeId ? `${base}:${nodeId}` : base;
}

export function signTicket(secret: string, token: string, timestamp: string, expiresAt: string, origin: string, account: string, nodeId = ""): string {
  return crypto.createHmac("sha256", secret).update(ticketPayload(token, timestamp, expiresAt, origin, account, nodeId)).digest("hex");
}

/** How long a ticket a node signs for a SWITCH lasts: the client uses it at once. */
export const NODE_TICKET_TTL_MS = 30_000;
// The token of a ticket a node signs starts with this; the Gateway's are hex. The token is signed, so a client cannot
// add or remove it: a node knows a login that another node has already handed over.
const SWITCH_TOKEN_PREFIX = "switch-";

/** Whether a ticket's token (one that passed checkTicket) is from a node's SWITCH rather than from the Gateway. */
export function isSwitchTicket(token: unknown): boolean {
  return typeof token === "string" && token.startsWith(SWITCH_TOKEN_PREFIX);
}

export interface NodeTicket {
  token: string;
  timestamp: number;
  expiresAt: number;
  signature: string;
  origin: string;
  account: string;
  nodeId: string;
}

/** A ticket a node signs to hand a login to another node (SWITCH): for the same account and origin, bound to that node. */
export function nodeTicket(secret: string, origin: string, account: string, nodeId: string, now = Date.now()): NodeTicket {
  const token = SWITCH_TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
  const timestamp = now;
  const expiresAt = now + NODE_TICKET_TTL_MS;
  const signature = signTicket(secret, token, String(timestamp), String(expiresAt), origin, account, nodeId);
  return { token, timestamp, expiresAt, signature, origin, account, nodeId };
}

export interface TicketFields {
  token?: unknown;
  timestamp?: unknown;
  expiresAt?: unknown;
  signature?: unknown;
  origin?: unknown;
  account?: unknown;
  nodeId?: unknown;
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
 * expired, that its origin is allowed (when a list is given), that it is not
 * for another node (when it names one and selfNodeId is given), that it names
 * a node at all (when requireNode: cluster mode), and that it was not used
 * before. On success it is spent, and the account it is for is
 * returned ("" for a ticket for no account, which cannot log anyone in).
 */
export function checkTicket(fields: TicketFields, secret: string | undefined, allowedOrigins: readonly string[], now = Date.now(), selfNodeId = "", requireNode = false): TicketCheck {
  const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : null);
  const token = text(fields.token);
  const timestamp = text(fields.timestamp);
  const expiresAt = text(fields.expiresAt);
  const signature = text(fields.signature);
  const origin = text(fields.origin) ?? "";
  const account = text(fields.account) ?? "";
  const nodeId = text(fields.nodeId) ?? "";
  if (!token || !timestamp || !expiresAt || !signature) return { ok: false, reason: "incomplete" };
  if (!secret) return { ok: false, reason: "no secret" };

  const expected = Buffer.from(signTicket(secret, token, timestamp, expiresAt, origin, account, nodeId), "hex");
  const given = /^[0-9a-f]+$/i.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "invalid signature" };

  const expires = Number(expiresAt);
  if (!Number.isFinite(expires) || now > expires) return { ok: false, reason: "expired" };

  const allowed = allowedOrigins.map((o) => o.trim()).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(origin)) return { ok: false, reason: `disallowed origin ${origin}` };

  if (requireNode && !nodeId) return { ok: false, reason: "no node" };
  if (nodeId && selfNodeId && nodeId !== selfNodeId) return { ok: false, reason: "for another node" };

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
