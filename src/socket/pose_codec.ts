/**
 * A viewer's copy of a pose change as a binary datagram (the Gateway's core/posepacket.ts reads the same layout).
 *
 *   [u8 0x05][u16 count, little endian] then per pose, 9 bytes and the state:
 *   [u32 id][u32 revision][u8 n][n bytes, the animation state in UTF-8, e.g. "walk_down"]
 *
 * It carries what the SPRITE_SHEET_POSE stream packet carries ({ id, animationState }) and the pose revision of the
 * animated player (socket/posedgram.ts): a client applies a pose only if its revision is newer than the one it shows,
 * so a datagram that arrives late, twice or out of order can never put an older pose back.
 *
 * A pose is state, not an event, and a datagram can be lost: the server sends the current pose again twice after each
 * change (PoseRepeater). Anything a client needs to see a player for the first time (the full sheets, the pose on
 * spawn, on entering the view, at a landing) stays on the reliable stream.
 *
 * Widths: the id is a player id (a decimal number, at most 0xffffffff, as in the movement datagrams), the revision a
 * counter of the player's pose changes and the state at most 255 bytes. A pose outside that (a non-numeric id, a
 * revision past u32, a longer state) has no record: encodePoseRecord gives null and the caller sends it as the
 * SPRITE_SHEET_POSE stream packet, so what the client is told never differs.
 *
 * The datagram header is its own byte: 0x01 and 0x02 are movement, 0x04 creature moves, and JSON starts with "{".
 */

export const POSE_DATAGRAM_HEADER = 0x05;
export const POSE_DATAGRAM_HEADER_BYTES = 3;
/** The bytes of a record before its state. */
export const POSE_RECORD_FIXED_BYTES = 9;
/** The longest state a record holds. */
export const POSE_STATE_MAX_BYTES = 255;
/** The most a revision holds. */
export const POSE_REVISION_MAX = 0xffffffff;

const encoder = new TextEncoder();

/** The record of a pose, or null when a field does not fit its width. */
export function encodePoseRecord(id: string | number, revision: number, state: string): Uint8Array | null {
  const numeric = typeof id === "number" ? id : /^\d{1,10}$/.test(id) ? Number(id) : NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xffffffff) return null;
  if (!Number.isInteger(revision) || revision < 0 || revision > POSE_REVISION_MAX) return null;
  if (typeof state !== "string" || state.length === 0 || state.length > POSE_STATE_MAX_BYTES) return null;
  const text = encoder.encode(state);
  if (text.length > POSE_STATE_MAX_BYTES) return null;
  const record = new Uint8Array(POSE_RECORD_FIXED_BYTES + text.length);
  const view = new DataView(record.buffer);
  view.setUint32(0, numeric, true);
  view.setUint32(4, revision, true);
  record[8] = text.length;
  record.set(text, POSE_RECORD_FIXED_BYTES);
  return record;
}

/**
 * Datagrams of whole records, none longer than `maxBytes` and in the order given. A record that does not fit a
 * datagram of its own is left out (none is, at the sizes in use: a record is at most 264 bytes).
 */
export function packPoseRecords(records: readonly Uint8Array[], maxBytes: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let group: Uint8Array[] = [];
  let size = POSE_DATAGRAM_HEADER_BYTES;
  const flush = () => {
    if (group.length === 0) return;
    const payload = new Uint8Array(size);
    payload[0] = POSE_DATAGRAM_HEADER;
    new DataView(payload.buffer).setUint16(1, group.length, true);
    let at = POSE_DATAGRAM_HEADER_BYTES;
    for (const record of group) {
      payload.set(record, at);
      at += record.length;
    }
    out.push(payload);
    group = [];
    size = POSE_DATAGRAM_HEADER_BYTES;
  };
  for (const record of records) {
    if (POSE_DATAGRAM_HEADER_BYTES + record.length > maxBytes) continue;
    if (size + record.length > maxBytes || group.length >= 0xffff) flush();
    group.push(record);
    size += record.length;
  }
  flush();
  return out;
}

export interface PoseEntry {
  id: string;
  revision: number;
  state: string;
}

const decoder = new TextDecoder();

/** The poses of a datagram; none for anything that is not a whole, well-formed one (never throws). Used by the tests; the client has its own decoder. */
export function decodePoseDatagram(bytes: Uint8Array): PoseEntry[] {
  const entries: PoseEntry[] = [];
  if (!bytes || bytes.length < POSE_DATAGRAM_HEADER_BYTES || bytes[0] !== POSE_DATAGRAM_HEADER) return entries;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(1, true);
  let at = POSE_DATAGRAM_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    if (at + POSE_RECORD_FIXED_BYTES > bytes.length) break;
    const n = bytes[at + 8];
    if (at + POSE_RECORD_FIXED_BYTES + n > bytes.length) break;
    entries.push({
      id: String(view.getUint32(at, true)),
      revision: view.getUint32(at + 4, true),
      state: decoder.decode(bytes.subarray(at + POSE_RECORD_FIXED_BYTES, at + POSE_RECORD_FIXED_BYTES + n)),
    });
    at += POSE_RECORD_FIXED_BYTES + n;
  }
  return entries;
}
