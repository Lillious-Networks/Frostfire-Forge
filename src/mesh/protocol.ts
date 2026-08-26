// Mesh wire protocol: shared datagram framing for server-to-server links.
//
// Datagram layout (little-endian):
//   [0..3]  u32 magic   0x46464D53 ("FFMS")
//   [4]     u8  version (1)
//   [5]     u8  flags   bit0 RELIABLE, bit1 ACK_ONLY
//   [6..7]  u16 seq     reliable-seq when RELIABLE is set, else unreliable-seq
//   [8]     u8  type    MeshMessageType
//   [9..]   payload     JSON for control messages, binary for hot paths
//
// ACK_ONLY datagrams carry no message type; their payload is a compact ack:
//   [0..3]  u32 ackBase    cumulative: every reliable seq < ackBase is received
//   [4..7]  u32 ackBitmap  bit N set = reliable seq ackBase+N received (N < 32)

import crypto from "crypto";

export const MESH_MAGIC = 0x46464d53;
export const MESH_VERSION = 1;
export const MESH_HEADER_SIZE = 9;
// Max mesh datagram payload. SPAWN blobs (sprite data included) and large
// MOVER_BATCHes exceed 1200 bytes by a wide margin; the mesh links run on
// loopback / overlay networks where IP fragmentation is fine, so the ceiling
// is the UDP payload limit. (Proper fragmentation is future work.)
export const MESH_MAX_DATAGRAM = 65507;

export const FLAG_RELIABLE = 0x01;
export const FLAG_ACK_ONLY = 0x02;

// Client-facing direction encoding: 0=up,1=down,2=left,3=right,4=upleft,
// 5=upright,6=downleft,7=downright (same order as movement_batch.DIRECTION_MAP).
export const DIRECTION_NAMES = ["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"];

export const MESH_PLAYER_ID_ENTITIES_MAX = 0xffffff;
export const MESH_PLAYER_ID_OFFSET = 0x80;

export enum MeshMessageType {
  HELLO = 0x01,
  HELLO_ACK = 0x02,
  HEARTBEAT = 0x03,
  SUBSCRIBE = 0x10,
  UNSUBSCRIBE = 0x11,
  MOVER_BATCH = 0x20,
  SPAWN = 0x21,
  DESPAWN = 0x22,
  STATE_EVENT = 0x23,
  INPUT_FORWARD = 0x24,
  AUTHORITY_CHANGE = 0x25,
  OUTPUT_FORWARD = 0x26,
  INPUT_PACKET = 0x27,
  CONNECTION_COUNT = 0x28,
  HANDOFF_REQUEST = 0x30,
  HANDOFF_ACCEPT = 0x31,
  HANDOFF_COMPLETE = 0x32,
  HANDOFF_ABORT = 0x33,
  PING = 0x40,
  PONG = 0x41,
}

export const RELIABLE_TYPES: ReadonlySet<MeshMessageType> = new Set([
  MeshMessageType.HELLO,
  MeshMessageType.HELLO_ACK,
  MeshMessageType.SUBSCRIBE,
  MeshMessageType.UNSUBSCRIBE,
  MeshMessageType.SPAWN,
  MeshMessageType.DESPAWN,
  MeshMessageType.STATE_EVENT,
  MeshMessageType.AUTHORITY_CHANGE,
  MeshMessageType.OUTPUT_FORWARD,
  MeshMessageType.INPUT_PACKET,
  MeshMessageType.HANDOFF_REQUEST,
  MeshMessageType.HANDOFF_ACCEPT,
  MeshMessageType.HANDOFF_COMPLETE,
  MeshMessageType.HANDOFF_ABORT,
]);

export interface DecodedDatagram {
  flags: number;
  seq: number;
  reliable: boolean;
  ackOnly: boolean;
  type: MeshMessageType;
  payload: Uint8Array;
}

export interface MeshHelloPayload {
  serverId: string;
  cluster: string;
  serverIndex: number;
  nonce: string;
  timestamp: number;
  signature: string;
}

export interface HelloVerification {
  ok: boolean;
  serverId: string;
  serverIndex: number;
  error: string;
}

export function encodeDatagram(
  seq: number,
  reliable: boolean,
  type: MeshMessageType,
  payload: Uint8Array
): Uint8Array {
  const data = new Uint8Array(MESH_HEADER_SIZE + payload.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, MESH_MAGIC, true);
  view.setUint8(4, MESH_VERSION);
  view.setUint8(5, reliable ? FLAG_RELIABLE : 0);
  view.setUint16(6, seq & 0xffff, true);
  view.setUint8(8, type);
  data.set(payload, MESH_HEADER_SIZE);
  return data;
}

export function encodeAck(ackBase: number, ackBitmap: number): Uint8Array {
  const data = new Uint8Array(MESH_HEADER_SIZE + 8);
  const view = new DataView(data.buffer);
  view.setUint32(0, MESH_MAGIC, true);
  view.setUint8(4, MESH_VERSION);
  view.setUint8(5, FLAG_ACK_ONLY);
  view.setUint16(6, ackBase & 0xffff, true);
  view.setUint32(9, ackBase >>> 0, true);
  view.setUint32(13, ackBitmap >>> 0, true);
  return data;
}

export function decodeDatagram(data: Uint8Array): DecodedDatagram | null {
  if (data.length < MESH_HEADER_SIZE) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.length);
  if (view.getUint32(0, true) !== MESH_MAGIC) return null;
  if (view.getUint8(4) !== MESH_VERSION) return null;

  const flags = view.getUint8(5);
  const seq = view.getUint16(6, true);
  const ackOnly = (flags & FLAG_ACK_ONLY) !== 0;
  const reliable = (flags & FLAG_RELIABLE) !== 0;
  const type = ackOnly ? MeshMessageType.PING : (view.getUint8(8) as MeshMessageType);
  const payload = new Uint8Array(data.buffer, data.byteOffset + MESH_HEADER_SIZE, data.length - MESH_HEADER_SIZE);
  return { flags, seq, reliable, ackOnly, type, payload };
}

export function decodeAck(payload: Uint8Array): { ackBase: number; ackBitmap: number } | null {
  if (payload.length < 8) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
  return { ackBase: view.getUint32(0, true), ackBitmap: view.getUint32(4, true) };
}

export function buildHelloPayload(
  serverId: string,
  cluster: string,
  secret: string,
  serverIndex: number = 0
): MeshHelloPayload {
  const nonce = crypto.randomBytes(8).toString("hex");
  const timestamp = Date.now();
  const signature = signHello(serverId, cluster, nonce, timestamp, secret);
  return { serverId, cluster, serverIndex, nonce, timestamp, signature };
}

export function signHello(
  serverId: string,
  cluster: string,
  nonce: string,
  timestamp: number,
  secret: string
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${serverId}:${cluster}:${nonce}:${timestamp}`)
    .digest("hex");
}

export function verifyHelloPayload(
  payload: unknown,
  secret: string,
  cluster: string,
  now: number = Date.now(),
  maxAgeMs: number = 30000
): HelloVerification {
  const hello = payload as MeshHelloPayload | null;
  if (!hello || typeof hello.serverId !== "string" || !hello.serverId) {
    return { ok: false, serverId: "", serverIndex: 0, error: "missing serverId" };
  }
  if (hello.cluster !== cluster) {
    return { ok: false, serverId: hello.serverId, serverIndex: hello.serverIndex || 0, error: "cluster mismatch" };
  }
  if (typeof hello.timestamp !== "number" || Math.abs(now - hello.timestamp) > maxAgeMs) {
    return { ok: false, serverId: hello.serverId, serverIndex: hello.serverIndex || 0, error: "stale timestamp" };
  }
  if (typeof hello.nonce !== "string" || typeof hello.signature !== "string") {
    return { ok: false, serverId: hello.serverId, serverIndex: hello.serverIndex || 0, error: "malformed hello" };
  }
  const expected = signHello(hello.serverId, hello.cluster, hello.nonce, hello.timestamp, secret);
  if (hello.signature !== expected) {
    return { ok: false, serverId: hello.serverId, serverIndex: hello.serverIndex || 0, error: "bad signature" };
  }
  return { ok: true, serverId: hello.serverId, serverIndex: hello.serverIndex || 0, error: "" };
}

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// MOVER_BATCH payload (binary, unreliable):
//   [0]     u8  nameLen
//   [1..]   nameLen x u8   normalized map name (utf8)
//   [+0..1] u16 count
//   [+2..]  count x 9-byte entries: u32 id | i16 x | i16 y | u8 direction|stealth<<4
// The entry stride matches the client BATCH_MOVEXY format so presence servers
// can re-encode forwarded movers without translation.

export const MESH_MOVER_ENTRY_BYTES = 9;
export const MESH_MOVER_FIXED_BYTES = 3; // nameLen byte + u16 count

export interface MeshMoverEntry {
  id: number;
  x: number;
  y: number;
  direction: number;
  stealth: number;
}

export function encodeMoverBatch(mapName: string, movers: MeshMoverEntry[]): Uint8Array {
  const nameBytes = textEncoder.encode(mapName);
  const data = new Uint8Array(MESH_MOVER_FIXED_BYTES + nameBytes.length + movers.length * MESH_MOVER_ENTRY_BYTES);
  const view = new DataView(data.buffer);
  data[0] = nameBytes.length;
  data.set(nameBytes, 1);
  view.setUint16(1 + nameBytes.length, movers.length, true);
  let offset = MESH_MOVER_FIXED_BYTES + nameBytes.length;
  for (const mover of movers) {
    view.setUint32(offset, mover.id >>> 0, true);
    view.setInt16(offset + 4, mover.x, true);
    view.setInt16(offset + 6, mover.y, true);
    view.setUint8(offset + 8, (mover.direction & 0x0f) | ((mover.stealth & 0x0f) << 4));
    offset += MESH_MOVER_ENTRY_BYTES;
  }
  return data;
}

export function decodeMoverBatch(payload: Uint8Array): { mapName: string; movers: MeshMoverEntry[] } | null {
  if (payload.length < MESH_MOVER_FIXED_BYTES) return null;
  const nameLen = payload[0];
  if (payload.length < MESH_MOVER_FIXED_BYTES + nameLen) return null;
  const mapName = textDecoder.decode(payload.subarray(1, 1 + nameLen));
  const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
  const count = view.getUint16(1 + nameLen, true);
  const movers: MeshMoverEntry[] = [];
  let offset = MESH_MOVER_FIXED_BYTES + nameLen;
  for (let i = 0; i < count; i++) {
    if (offset + MESH_MOVER_ENTRY_BYTES > payload.length) return null;
    const flags = view.getUint8(offset + 8);
    movers.push({
      id: view.getUint32(offset, true),
      x: view.getInt16(offset + 4, true),
      y: view.getInt16(offset + 6, true),
      direction: flags & 0x0f,
      stealth: (flags >> 4) & 0x0f,
    });
    offset += MESH_MOVER_ENTRY_BYTES;
  }
  return { mapName, movers };
}

// INPUT_FORWARD payload (binary, unreliable): the movement direction of a
// remotely simulated avatar.
//   [0..3]  u32 playerId
//   [4]     u8  direction index (DIRECTION_NAMES order)
export const INPUT_FORWARD_BYTES = 5;

export function encodeInputForward(playerId: string | number, directionIndex: number): Uint8Array {
  const data = new Uint8Array(INPUT_FORWARD_BYTES);
  const view = new DataView(data.buffer);
  view.setUint32(0, Number(playerId) >>> 0, true);
  view.setUint8(4, directionIndex & 0x0f);
  return data;
}

export function decodeInputForward(payload: Uint8Array): { playerId: string; directionIndex: number } | null {
  if (payload.length < INPUT_FORWARD_BYTES) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
  return {
    playerId: String(view.getUint32(0, true)),
    directionIndex: view.getUint8(4) & 0x0f,
  };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
