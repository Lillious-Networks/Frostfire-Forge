import crypto from "crypto";
import log from "../modules/logger";
import { blockTableKey } from "./blocks";
import type { ClusterStore } from "./store";

// Sealed store records (security review phase 7, H1). Since phase 7 some Redis records carry authority: a parked grant
// is written to a player's rows, a snapshot places a player, a tombstone or a run announcement fences a node, a settle
// mark holds a player's writes, a move order says where a block's state is, a block table says which node owns which
// block. Anyone who could write Redis could forge them. Each one is now sealed with the store key (clusterkeys.ts, HKDF label cells-store-v1), which only the nodes
// and the coordinator hold: an HMAC-SHA256 over the record's kind, its Redis key and its value. Binding the key means
// a sealed record copied under another key (another player's snapshot, another grant id) does not open there.
//
// The seal is one more field, `seal`, at the end of the record's JSON object. The record stays a JSON object with its
// own fields at the top: the stores' Lua scripts read `epoch` from move orders and block tables (swapIfEpoch,
// deleteIfEpoch) as before, and tools that read a field (the chaos script reads an order's `state` and a table's
// `owners`) still can. The value is given back exactly as it was sealed, byte for byte: the seal is cut off the end, so
// no JSON is ever re-encoded to check it.
//
// A record with no seal, or one that does not open, counts as missing: SealedStore answers null, and logs it once per
// Redis key (warn). Nothing throws on it. Records written before this change have no seal, so they count as missing too
// (see the report: a hand-over parked before the upgrade is logged by name and not given). One reader tells the two
// apart: for the coordinator a missing block table is a map to split afresh, which would give its blocks a second
// time, so a table that does not open is one it cannot read (refusedRecord), left alone like a corrupt one. A table
// deleted outright is told apart by the map's epoch counter and by what the coordinator read before (readTable).
//
// SealedStore applies this to every key with a sealed prefix, in every call that reads or writes a value, so no writer
// or reader can miss it: startCluster (index.ts) and the coordinator process (coordinator-main.ts) wrap their store in
// it once, and everything they make uses that. Other keys pass through unchanged. Sets (the grant lists, the order
// list) are not sealed: an id listed there counts only with a sealed record of its own, which names its id and run.
//
// What a seal does not stop: a party that can write Redis can still delete a record, or put back an older record it
// read before (a sealed revision of the same key). Each reader says what that can do (grants: at most once by GETDEL
// and the database id row; snapshots: owner epochs; orders: see moveorders.ts).

export type SealKind = "grant" | "snapshot" | "tombstone" | "noderun" | "nodeinfo" | "settle" | "move" | "blocks";

/** The key prefixes whose records are sealed, and their kind. Prefixes end in ":", so none is a prefix of another kind's. */
export const SEALED_PREFIXES: ReadonlyArray<readonly [string, SealKind]> = [
  ["cells:grant:", "grant"],
  ["cells:snap:", "snapshot"],
  ["cells:dead:", "tombstone"],
  ["cells:noderun:", "noderun"],
  ["cells:nodeinfo:", "nodeinfo"],
  ["cells:settle:", "settle"],
  ["cells:move:", "move"],
  // The block tables, by blocks.ts's own key helper ("cells:blocks:"). Not the epoch counters (cells:blocksepoch:*): a
  // counter is a number, read by INCRBY.
  [blockTableKey(""), "blocks"],
];

/** The kind of a sealed key, or null for a key that is not sealed. */
export function sealKindOf(key: string): SealKind | null {
  for (const [prefix, kind] of SEALED_PREFIXES) if (key.startsWith(prefix)) return kind;
  return null;
}

const SEAL_FIELD = "seal";
const MAC_BYTES = 32;
const TAIL_HEAD = `"${SEAL_FIELD}":"`;
// `"seal":"<64 hex>"}`
const TAIL_LENGTH = TAIL_HEAD.length + MAC_BYTES * 2 + 2;
const TAIL = /^"seal":"([0-9a-f]{64})"\}$/;
/** The most refused keys remembered for the once-per-key log; past it the memory starts over. */
export const REFUSED_KEEP = 4096;
/** How much of a refused record the log line shows. */
const SHOWN_CHARS = 300;

function macOf(storeKey: string, kind: SealKind, key: string, value: string): Buffer {
  // JSON of the three: no separator inside a key or value can shift one field into the next.
  return crypto.createHmac("sha256", Buffer.from(storeKey, "hex")).update(JSON.stringify([kind, key, value])).digest();
}

/** `value`, a JSON object as a string, sealed under `key` with the store key. Throws on a value that is not an object. */
export function seal(kind: SealKind, key: string, value: string, storeKey: string): string {
  if (typeof value !== "string" || !value.startsWith("{") || !value.endsWith("}")) {
    throw new Error(`Only a JSON object can be sealed: the ${kind} record at ${key} is not one`);
  }
  const tail = `${TAIL_HEAD}${macOf(storeKey, kind, key, value).toString("hex")}"}`;
  return value.slice(1, -1).trim() === "" ? `{${tail}` : `${value.slice(0, -1)},${tail}`;
}

/** The value sealed in `stored` under `key`, or null: no seal, a seal that does not open, or not a sealed object. */
export function open(kind: SealKind, key: string, stored: string, storeKey: string): string | null {
  if (typeof stored !== "string" || stored.length <= TAIL_LENGTH) return null;
  const match = TAIL.exec(stored.slice(-TAIL_LENGTH));
  if (!match) return null;
  const head = stored.slice(0, -TAIL_LENGTH);
  let value: string;
  if (head === "{") value = "{}";
  else if (head.startsWith("{") && head.endsWith(",")) value = `${head.slice(0, -1)}}`;
  else return null;
  const expected = macOf(storeKey, kind, key, value);
  const given = Buffer.from(match[1]!, "hex");
  // Constant time: the length is fixed by the pattern above.
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? value : null;
}

/**
 * A store whose sealed records (SEALED_PREFIXES) are sealed on every write and opened on every read. A record that does
 * not open is answered as missing (null) and logged once per key. Every other key and call passes through as it is.
 */
export class SealedStore implements ClusterStore {
  /** Keys whose refusal was logged. */
  private refused = new Set<string>();
  isUp?: () => boolean;

  constructor(readonly inner: ClusterStore, private readonly storeKey: string) {
    if (!/^[0-9a-f]{64}$/.test(storeKey)) throw new Error("The store key must be 32 bytes as hex (clusterkeys.ts)");
    if (inner.isUp) this.isUp = () => inner.isUp!();
  }

  /** The value to write at `key`: sealed when the key is sealed. */
  private sealed(key: string, value: string): string {
    const kind = sealKindOf(key);
    return kind ? seal(kind, key, value, this.storeKey) : value;
  }

  /** The value read at `key`: opened when the key is sealed, or null (logged once per key) when it does not open. */
  private opened(key: string, raw: string | null): string | null {
    const kind = sealKindOf(key);
    if (!kind || raw === null) return raw;
    const value = open(kind, key, raw, this.storeKey);
    if (value === null) this.refuse(key, kind, raw);
    return value;
  }

  private refuse(key: string, kind: SealKind, raw: string): void {
    if (this.refused.has(key)) return;
    if (this.refused.size >= REFUSED_KEEP) this.refused.clear();
    this.refused.add(key);
    const shown = JSON.stringify(String(raw).slice(0, SHOWN_CHARS));
    const lost = kind === "grant" ? " A hand-over parked before records were sealed is lost here, and not given:" : "";
    log.warn(`Store record ${key} (${kind}) has no valid seal: it was written before records were sealed, or not by this cluster, and counts as missing.${lost} unverified content ${shown}`);
  }

  async get(key: string): Promise<string | null> {
    return this.opened(key, await this.inner.get(key));
  }

  /** Whether `key` is sealed and holds a record that does not open (it reads as missing). See refusedRecord. */
  async refusedAt(key: string): Promise<boolean> {
    const kind = sealKindOf(key);
    if (!kind) return false;
    const raw = await this.inner.get(key);
    return raw !== null && open(kind, key, raw, this.storeKey) === null;
  }

  set(key: string, value: string, ttlMs?: number): Promise<void> {
    return this.inner.set(key, this.sealed(key, value), ttlMs);
  }

  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    return this.inner.setIfAbsent(key, this.sealed(key, value), ttlMs);
  }

  del(key: string): Promise<void> {
    return this.inner.del(key);
  }

  async take(key: string): Promise<string | null> {
    return this.opened(key, await this.inner.take(key));
  }

  incrBy(key: string, amount: number): Promise<number> {
    return this.inner.incrBy(key, amount);
  }

  swapIfEpoch(key: string, expectedEpoch: number, value: string): Promise<boolean> {
    return this.inner.swapIfEpoch(key, expectedEpoch, this.sealed(key, value));
  }

  deleteIfEpoch(key: string, epoch: number): Promise<boolean> {
    return this.inner.deleteIfEpoch(key, epoch);
  }

  renewIfEpoch(key: string, epoch: number, ttlMs: number): Promise<boolean> {
    return this.inner.renewIfEpoch(key, epoch, ttlMs);
  }

  addToSet(key: string, member: string): Promise<void> {
    return this.inner.addToSet(key, member);
  }

  removeFromSet(key: string, member: string): Promise<void> {
    return this.inner.removeFromSet(key, member);
  }

  members(key: string): Promise<string[]> {
    return this.inner.members(key);
  }

  expire(key: string, ttlMs: number): Promise<void> {
    return this.inner.expire(key, ttlMs);
  }

  publish(channel: string, message: string): Promise<void> {
    return this.inner.publish(channel, message);
  }

  subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    return this.inner.subscribe(channel, handler);
  }

  unsubscribe(channel: string, handler: (message: string) => void): Promise<void> {
    return this.inner.unsubscribe(channel, handler);
  }

  close(): void {
    this.inner.close();
  }
}

/**
 * Whether `key` holds a record whose seal does not open: one `store` answers as missing although something is there.
 * False for a store that does not seal, a key that is not sealed, an absent key, or a record that opens. A reader for
 * which missing means "start afresh" (the coordinator's block tables) tells the two apart with it.
 */
export async function refusedRecord(store: ClusterStore, key: string): Promise<boolean> {
  return store instanceof SealedStore ? store.refusedAt(key) : false;
}

/** `store` with its sealed records sealed under `storeKey`. A store already sealed is used as it is, not sealed twice. */
export function sealStore(store: ClusterStore, storeKey: string): SealedStore {
  return store instanceof SealedStore ? store : new SealedStore(store, storeKey);
}
