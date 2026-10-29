import crypto from "crypto";
import { BATCH_HEADER, DIRECTION_MAP, MAX_ENTRIES, encodeBatch } from "../socket/movement_batch";
import { LINK_FRAME_BYTES } from "./wtlinks";

// What travels on a node link (spec §1, §3). Reliable messages are JSON frames
// { t, d } on the link's one stream. GHOST_MOVE goes as datagrams in the
// client's 13-byte movement batch format: [0x01][u16 count] then per entry
// [u32 id][i32 x][i32 y][u8 dir | flags << 4].

/** How old a LINK_HELLO may be, either way, before it is refused. */
export const HELLO_WINDOW_MS = 10_000;
/** Entries encodeBatch puts in one datagram (1200 bytes less header and probe room: 91). Its own split, not a copy. */
export const GHOST_MOVES_PER_DATAGRAM = MAX_ENTRIES;
/** Flag bits of a GHOST_MOVE entry: a stealthed player, a moving entity. */
export const FLAG_STEALTH = 1;
export const FLAG_MOVING = 2;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The largest link frame decoded. A larger one is dropped: a peer cannot make this node parse an unbounded payload.
 * The same limit as the WebTransport link's frame reader (wtlinks.ts), so the loopback link holds to it too.
 */
export const LINK_FRAME_MAX_BYTES = LINK_FRAME_BYTES;

export function encodeLinkFrame(t: string, d: unknown): Uint8Array {
  return encoder.encode(JSON.stringify({ t, d }));
}

export function decodeLinkFrame(payload: Uint8Array, maxBytes = LINK_FRAME_MAX_BYTES): { t: string; d: any } | null {
  if (payload.byteLength > maxBytes) return null;
  let frame: any;
  try {
    frame = JSON.parse(decoder.decode(payload));
  } catch {
    return null;
  }
  return frame && typeof frame === "object" && typeof frame.t === "string" ? { t: frame.t, d: frame.d } : null;
}

export interface LinkHello {
  from: string;
  to: string;
  ts: number;
  nonce: string;
  sig: string;
}

export function linkSignature(secret: string, from: string, to: string, ts: number, nonce: string): string {
  // The "link:" prefix keeps a link signature from ever passing as a ticket signature (ticket.ts), and the reverse.
  return crypto.createHmac("sha256", secret).update(`link:${from}:${to}:${ts}:${nonce}`).digest("hex");
}

export function makeHello(secret: string, from: string, to: string, now: number): LinkHello {
  // ":" separates the signed fields: an id holding one could make two different HELLOs sign the same.
  if (from.includes(":") || to.includes(":")) throw new Error("A node id cannot contain ':'");
  const nonce = crypto.randomBytes(16).toString("hex");
  return { from, to, ts: now, nonce, sig: linkSignature(secret, from, to, now, nonce) };
}

/** Nonces of HELLOs already accepted, kept for twice the window: each HELLO is good once. */
export class HelloNonces {
  private used = new Map<string, number>();

  /** Records the nonce. False when it was used before. */
  claim(nonce: string, now: number): boolean {
    // Oldest first (insertion order): stop at the first one still inside the window.
    for (const [seen, at] of this.used) {
      if (now - at <= HELLO_WINDOW_MS * 2) break;
      this.used.delete(seen);
    }
    if (this.used.has(nonce)) return false;
    this.used.set(nonce, now);
    return true;
  }
}

/** The peer's node id when `hello` is a good HELLO to `self`; null otherwise. */
export function checkHello(secret: string, hello: unknown, self: string, now: number, nonces: HelloNonces): string | null {
  if (!secret || !hello || typeof hello !== "object") return null;
  const { from, to, ts, nonce, sig } = hello as Partial<LinkHello>;
  if (typeof from !== "string" || !from || from === self || to !== self || from.includes(":") || self.includes(":")) return null;
  if (typeof ts !== "number" || !Number.isFinite(ts) || Math.abs(now - ts) > HELLO_WINDOW_MS) return null;
  if (typeof nonce !== "string" || nonce.length < 16 || typeof sig !== "string") return null;
  // Buffer.from(.., "hex") stops at the first bad pair, so a padded signature would still verify.
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = Buffer.from(linkSignature(secret, from, to, ts, nonce), "hex");
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return nonces.claim(nonce, now) ? from : null;
}

export interface GhostMoveEntry {
  /** The entity's u32 (idNumber). */
  num: number;
  x: number;
  y: number;
  /** DIRECTION_MAP code, 0-7. */
  dir: number;
  /** FLAG_* bits, 0-15. */
  flags: number;
}

/** One datagram per GHOST_MOVES_PER_DATAGRAM entries, each at most 1200 bytes. */
export function encodeGhostMoves(entries: GhostMoveEntry[]): Uint8Array[] {
  if (entries.length === 0) return [];
  // encodeBatch writes `direction | (stealth << 4)`: the flags ride in the stealth nibble.
  const { data, offsets } = encodeBatch(entries.map((entry) => ({
    id: entry.num >>> 0,
    x: Math.round(entry.x),
    y: Math.round(entry.y),
    direction: entry.dir & 0x0f,
    stealth: entry.flags & 0x0f,
  })));
  // `offsets` ends with the total length: it bounds the last datagram and starts none.
  return offsets.slice(0, -1).map((start, i) => data.slice(start, offsets[i + 1]));
}

export function decodeGhostMoves(datagram: Uint8Array): GhostMoveEntry[] {
  if (datagram.length < 3 || datagram[0] !== BATCH_HEADER) return [];
  const view = new DataView(datagram.buffer, datagram.byteOffset, datagram.byteLength);
  const count = view.getUint16(1, true);
  if (3 + count * 13 > datagram.length) return [];
  const entries: GhostMoveEntry[] = [];
  for (let i = 0, at = 3; i < count; i++, at += 13) {
    const byte = datagram[at + 12];
    entries.push({
      num: view.getUint32(at, true),
      x: view.getInt32(at + 4, true),
      y: view.getInt32(at + 8, true),
      dir: byte & 0x0f,
      flags: byte >> 4,
    });
  }
  return entries;
}

/**
 * The u32 of an entity id: every id comes from the world counter (entityids.ts), whether it is a
 * number (creatures, gathering nodes), a decimal string (players) or "<kind>_<n>" / "t<n>". -1: none.
 */
export function idNumber(id: string | number): number {
  if (typeof id === "number") return Number.isInteger(id) && id >= 0 && id <= 0xffffffff ? id : -1;
  // A word, then digits: "-3" or "abc" has no id, as with a number.
  const match = /^[A-Za-z_]*(\d+)$/.exec(String(id));
  const n = match ? Number(match[1]) : NaN;
  return Number.isInteger(n) && n <= 0xffffffff ? n : -1;
}

const DIRECTION_NAMES: string[] = [];
for (const [name, code] of Object.entries(DIRECTION_MAP)) DIRECTION_NAMES[code] = name;

export function directionCode(direction: unknown): number {
  const name = String(direction);
  return Object.hasOwn(DIRECTION_MAP, name) ? DIRECTION_MAP[name] : DIRECTION_MAP.down;
}

export function directionName(code: number): string {
  return DIRECTION_NAMES[code] ?? "down";
}

/** Client packets as JSON-safe strings, the way delivery (deliver.ts) sends them between nodes. */
export function toWire(packets: Uint8Array[]): string[] {
  return packets.map((packet) => Buffer.from(packet).toString("base64"));
}

export function fromWire(packets: unknown): Uint8Array[] {
  return Array.isArray(packets) ? packets.map((packet) => new Uint8Array(Buffer.from(String(packet), "base64"))) : [];
}
