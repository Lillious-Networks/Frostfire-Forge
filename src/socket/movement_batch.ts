import AOI_CONFIG from "../config/aoi.json";
import { BASE_TICK_MS, BASE_TICK_RATE, TICK_MS } from "../services/tickrate";

export const BATCH_HEADER = 0x01;
// Keep in sync with settings.webtransport.maxDatagramSize (server.ts passes
// that value to the transport). 1200 is the conservative QUIC-safe default:
// raising it risks PMTU black-holing, which shows up as intermittent movement
// loss rather than a clean error.
export const MAX_DATAGRAM_SIZE = 1200;
const ENTRY_BYTES = 13; // [u32 id][i32 x][i32 y][u8 dir|stealth]
const PROBE_BYTES = 10; // [u32 seq][u32 seconds][u16 ms]
/** Entries encodeBatch puts in one datagram. */
export const MAX_ENTRIES = Math.floor((MAX_DATAGRAM_SIZE - 3 - PROBE_BYTES) / ENTRY_BYTES);

// Movers farther than NEAR_TIER_DISTANCE from a receiver are sent on one tick in
// every FAR_UPDATE_EVERY. The client interpolates between server timestamps, so
// a slower far rate does not look like teleporting. Set FAR_UPDATE_EVERY to 1
// for full-rate updates everywhere. Read with a fallback: aoi.json is generated,
// so an older file (or a test's stand-in) may not have the keys yet.
// FAR_UPDATE_EVERY counts 30 Hz ticks (3: every 100 ms), so it is a time: each
// flush turns it into flushes at the spacing the flush is running at (one per
// tick, or the back-off's), so far movers keep that time at any TICK_RATE and
// under back-off.
const tierConfig = AOI_CONFIG as { NEAR_TIER_DISTANCE?: number; FAR_UPDATE_EVERY?: number };
export const NEAR_TIER_DISTANCE: number = tierConfig.NEAR_TIER_DISTANCE ?? 500;
const FAR_UPDATE_EVERY_30: number = tierConfig.FAR_UPDATE_EVERY ?? 3;

/**
 * A far mover's interval in flushes, for flushes `flushMs` apart: FAR_UPDATE_EVERY (`every30`, in 30 Hz ticks) of
 * time, never under one flush; 1 stays full rate.
 */
export function farUpdateEvery(flushMs: number = TICK_MS, every30: number = FAR_UPDATE_EVERY_30): number {
  return every30 <= 1 ? 1 : Math.max(1, Math.round((every30 * BASE_TICK_MS) / Math.max(1, flushMs)));
}

/** The far interval for a flush after every tick (collectReceiverEntries' default). */
export const FAR_UPDATE_EVERY: number = farUpdateEvery(TICK_MS);

/** When the next movement flush is due (flushDue); null before the first. */
export interface FlushPacer {
  nextAt: number | null;
}

/**
 * Whether the movement flush after the tick at `now` goes out. Every tick, unless the back-off (ticks running late,
 * an overloaded flush, real outbound volume) asks for `backoffMs` between flushes: then the first tick from half a
 * tick before each `backoffMs` mark. The marks are kept (not counted from the last flush), so the flushes average
 * `backoffMs` apart whatever the tick rate: a 50 ms back-off at 30 Hz goes out on alternate 1 and 2 ticks, 20 a
 * second. A pacer that fell more than a back-off behind starts again from now.
 */
export function flushDue(pacer: FlushPacer, now: number, backoffMs: number, tickMs: number = TICK_MS): boolean {
  if (backoffMs <= 0 || pacer.nextAt === null) {
    pacer.nextAt = now + Math.max(0, backoffMs);
    return true;
  }
  if (now < pacer.nextAt - tickMs / 2) return false;
  pacer.nextAt = now - pacer.nextAt > backoffMs ? now + backoffMs : pacer.nextAt + backoffMs;
  return true;
}

/**
 * The game loop's after-tick hook for the movement flush: `flush` (given the back-off in use) after every tick that
 * flushDue lets through, never two at once (a tick while one still runs is skipped: the flush is overloaded).
 */
export function afterTickFlush(
  flush: (backoffMs: number) => Promise<void>,
  backoff: () => number,
  now: () => number = () => performance.now(),
  tickMs: number = TICK_MS
): () => Promise<void> {
  const pacer: FlushPacer = { nextAt: null };
  let running = false;
  return async () => {
    if (running) return;
    const backoffMs = backoff();
    if (!flushDue(pacer, now(), backoffMs, tickMs)) return;
    running = true;
    try {
      await flush(backoffMs);
    } catch {
      // A failed flush is not the loop's to handle: the next tick flushes again.
    } finally {
      running = false;
    }
  };
}

export const DIRECTION_MAP: Record<string, number> = {
  up: 0, down: 1, left: 2, right: 3,
  upleft: 4, upright: 5, downleft: 6, downright: 7,
};

export interface MoverSnapshot {
  id: string;
  x: number;
  y: number;
  direction: string;
  stealth: boolean;
  vanished: boolean;
  party: string[];
  // The mover's last position before it stopped. Never throttled: a far mover
  // that stopped on an off-slot tick would otherwise freeze short of where it
  // ended up.
  final?: boolean;
}

export interface ReceiverInfo {
  x: number;
  y: number;
  isAdmin: boolean;
  username: string;
  // The receiver's current target, which is always sent at full rate.
  targetId?: string;
  seq?: number;
  // The receiver's own player id. A batch leaves out the receiver's own entry (the client skips it: its position
  // comes from the per-tick MOVEXY echo), and a receiver whose only entry that was gets no batch.
  selfId?: string;
}

// Position of each mover in the flush's mover list, built once per flush. With
// it a receiver walks whichever is smaller, its visible set (capped) or the
// mover list, so a flush costs O(receivers x min(visible, movers)) instead of
// O(receivers x movers). A repeated id keeps its first position.
export function indexMovers(movers: MoverSnapshot[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < movers.length; i++) {
    if (!index.has(movers[i].id)) index.set(movers[i].id, i);
  }
  return index;
}

/** What collectReceiverEntries saw of one receiver's movers, for the movement volume (batchVolume). */
export interface EntryTally {
  /** Entries that go at every flush: near movers, and far ones kept at full rate (party, target, a final stop). */
  full: number;
  /** Far movers held to the far interval, whether due on this flush or not. */
  far: number;
}

/**
 * `tally`, when given, is added to (see EntryTally). It counts far movers by distance alone, whatever `farEvery`
 * is, so it reads the same under any back-off.
 */
export function collectReceiverEntries(
  set: Set<string>,
  movers: MoverSnapshot[],
  receiver: ReceiverInfo,
  tick: number,
  tierDistance = 0,
  farEvery = FAR_UPDATE_EVERY,
  moverIndex?: Map<string, number>,
  tally?: EntryTally
): any[] {
  const entries: any[] = [];

  // Entries keep the mover list's order either way: the ids found through the
  // visible set are sorted by their list position (at most the set's size).
  let candidates: Iterable<MoverSnapshot> = movers;
  if (moverIndex && set.size < movers.length) {
    const positions: number[] = [];
    for (const id of set) {
      const position = moverIndex.get(id);
      if (position !== undefined) positions.push(position);
    }
    positions.sort((a, b) => a - b);
    candidates = positions.map((position) => movers[position]);
  }

  for (const mover of candidates) {
    if (!set.has(mover.id)) continue;
    if (mover.id === receiver.selfId) continue;
    if (mover.stealth && !receiver.isAdmin) continue;
    if (mover.vanished && !receiver.isAdmin && !(mover.party || []).includes(receiver.username)) continue;

    // Party members, the receiver's target and a mover's final stop position
    // stay at full rate however far.
    let farTier = false;
    if (tierDistance > 0 && (farEvery > 1 || tally) && !mover.final && mover.id !== receiver.targetId && !(mover.party || []).includes(receiver.username)) {
      const dx = mover.x - receiver.x;
      const dy = mover.y - receiver.y;
      farTier = dx * dx + dy * dy > tierDistance * tierDistance;
    }
    if (farTier) {
      if (tally) tally.far++;
      // The id staggers movers so they do not all land on the same tick.
      if (farEvery > 1 && (tick + (parseInt(mover.id, 10) || 0)) % farEvery !== 0) continue;
    } else if (tally) {
      tally.full++;
    }

    entries.push({
      id: parseInt(mover.id, 10) || 0,
      x: Math.round(mover.x),
      y: Math.round(mover.y),
      direction: DIRECTION_MAP[mover.direction] ?? 1,
      stealth: mover.stealth ? 1 : 0,
    });
  }

  return entries;
}

/**
 * The datagrams one receiver's batch counts as in the movement volume: what it would be sent with far movers
 * at `farEveryBase`, the far interval of a flush after every tick (no back-off). The floor (and any back-off)
 * shortens the far interval, so far movers go in more of the flushes it runs; counting what was really sent
 * would let the floor hold its own reading up after the load fell. Full-rate entries go every flush either way.
 */
export function batchVolume(tally: EntryTally, farEveryBase: number = FAR_UPDATE_EVERY): number {
  const base = Math.max(1, farEveryBase);
  const datagrams = Math.max(1, Math.ceil((tally.full + tally.far / base) / MAX_ENTRIES));
  if (tally.full > 0) return datagrams;
  // Far movers only: a datagram on the flushes where at least one of them is due (their ids stagger them).
  return tally.far > 0 ? (1 - (1 - 1 / base) ** tally.far) * datagrams : 0;
}

// Movement volume: decides the flush floor (receiver.ts getAdaptiveBatchInterval). At low volume there is no reason
// to throttle (a fast flush makes movement look smooth for the handful of players watching), but at high volume each
// flush is ~1 datagram per active receiver and flushing at 60 Hz would saturate the single native UDP send path (~9%
// loss + lag oscillation). So the floor slides: none (a flush after every tick) when the server is nearly idle, 50 ms
// (20 Hz) once there is real outbound volume.
//
// The volume is counted per flush and taken at a flush every 30 Hz tick (the rate HIGH_VOLUME_RATE was tuned at), so
// neither the TICK_RATE nor the floor's fewer flushes move it; and far movers are counted at the unthrottled far
// interval (batchVolume), so the floor's shorter far interval does not either. It engages at HIGH_VOLUME_RATE and lets
// go only under HIGH_VOLUME_RELEASE, so a server near the line does not swing between the two cadences every second or two.
export const HIGH_VOLUME_RATE = 8000; // datagrams/sec at 30 flushes a second ~ a few hundred concurrent players
export const HIGH_VOLUME_RELEASE = 6000;

export class MovementVolume {
  private counted = 0;
  private flushes = 0;
  /** Datagrams a second, smoothed over the samples. */
  rate = 0;
  /** Whether the floor is engaged. */
  high = false;

  /** One flush ran. */
  flushed(): void {
    this.flushes++;
  }

  /** A flush's batches, as batchVolume counts them (they may come back from a worker after the flush). */
  add(volume: number): void {
    this.counted += volume;
  }

  /** Once a second: the new rate, and whether the floor is engaged. */
  sample(): boolean {
    const perFlush = this.flushes > 0 ? this.counted / this.flushes : 0;
    this.rate = this.rate * 0.5 + perFlush * BASE_TICK_RATE * 0.5;
    this.counted = 0;
    this.flushes = 0;
    if (this.rate >= HIGH_VOLUME_RATE) this.high = true;
    else if (this.rate < HIGH_VOLUME_RELEASE) this.high = false;
    return this.high;
  }
}

// Who needs a batch for one group of movers: the movers themselves (their own
// echo) and everyone who can see at least one of them. Visiting only these,
// rather than the whole layer, keeps a flush proportional to who is watching.
export function collectGroupReceivers(
  moverIds: Iterable<string>,
  getViewers: (moverId: string) => Iterable<string>
): string[] {
  const receivers = new Set<string>();
  for (const moverId of moverIds) {
    receivers.add(moverId);
    for (const viewerId of getViewers(moverId)) receivers.add(viewerId);
  }
  return [...receivers];
}

// A change to one receiver's visible set, mirrored to the movement worker.
// `replace` marks a full snapshot: the set becomes exactly `add`, so ids that
// were removed while the worker was not being fed do not linger.
export interface ReceiverDiff {
  playerId: string;
  add: string[];
  remove: string[];
  replace?: boolean;
}

export function applyReceiverDiffs(sets: Map<string, Set<string>>, diffs: ReceiverDiff[]): void {
  for (const diff of diffs) {
    if (diff.replace) {
      sets.set(diff.playerId, new Set(diff.add));
      continue;
    }
    let set = sets.get(diff.playerId);
    if (!set) {
      set = new Set<string>();
      sets.set(diff.playerId, set);
    }
    for (const add of diff.add) set.add(add);
    for (const remove of diff.remove) set.delete(remove);
  }
}

// Fold two diff lists (older first) into one that has the same effect when
// applied. Used when a queued flush for a layer is replaced by a newer one, so
// the dropped request's diffs and snapshots still reach the worker.
export function mergeReceiverDiffs(older: ReceiverDiff[], newer: ReceiverDiff[]): ReceiverDiff[] {
  const merged = new Map<string, ReceiverDiff>();
  for (const diff of [...older, ...newer]) {
    const previous = merged.get(diff.playerId);
    if (!previous || diff.replace) {
      merged.set(diff.playerId, { playerId: diff.playerId, add: [...diff.add], remove: [...diff.remove], replace: diff.replace });
      continue;
    }
    const removed = new Set(diff.remove);
    const added = new Set(diff.add);
    const add = new Set([...previous.add].filter((id) => !removed.has(id)));
    for (const id of added) add.add(id);
    // A snapshot already is the whole set, so it has nothing left to remove.
    const remove = previous.replace
      ? new Set<string>()
      : new Set([...previous.remove].filter((id) => !added.has(id)));
    if (!previous.replace) for (const id of removed) remove.add(id);
    merged.set(diff.playerId, { playerId: diff.playerId, add: [...add], remove: [...remove], replace: previous.replace });
  }
  return [...merged.values()];
}

interface MergeableFlush {
  movers: MoverSnapshot[];
  receiverIds: string[];
  receiverInfo: Record<string, ReceiverInfo>;
  diffs: ReceiverDiff[];
}

// Combine a queued flush with the newer one that replaces it. The newer
// request's values win; whatever only the older one carried (diffs, snapshots,
// movers such as a final stop position, their receivers) is kept.
export function mergeFlushRequests<T extends MergeableFlush>(older: T, newer: T): T {
  const moverIds = new Set(newer.movers.map((mover) => mover.id));
  return {
    ...newer,
    movers: [...older.movers.filter((mover) => !moverIds.has(mover.id)), ...newer.movers],
    receiverIds: [...new Set([...older.receiverIds, ...newer.receiverIds])],
    receiverInfo: { ...older.receiverInfo, ...newer.receiverInfo },
    diffs: mergeReceiverDiffs(older.diffs || [], newer.diffs || []),
  };
}

export interface MovementProbe {
  seq: number;
  serverSendTime: number;
}

export function encodeBatch(entries: any[], probe?: MovementProbe): { data: Uint8Array; offsets: number[] } {
  const frames: Uint8Array[] = [];
  const offsets: number[] = [];

  for (let i = 0; i < entries.length; i += MAX_ENTRIES) {
    const chunkEntries = Math.min(MAX_ENTRIES, entries.length - i);
    const frame = new Uint8Array(3 + chunkEntries * ENTRY_BYTES + (probe ? PROBE_BYTES : 0));
    const view = new DataView(frame.buffer);
    frame[0] = BATCH_HEADER;
    view.setUint16(1, chunkEntries, true);

    let offset = 3;
    for (let j = 0; j < chunkEntries; j++) {
      const mover = entries[i + j];
      view.setUint32(offset, mover.id, true);
      view.setInt32(offset + 4, mover.x, true);
      view.setInt32(offset + 8, mover.y, true);
      frame[offset + 12] = mover.direction | (mover.stealth << 4);
      offset += ENTRY_BYTES;
    }

    // Trailing one-way latency probe: [u32 seq][u32 seconds][u16 ms].
    // Clients parse exactly `count` entries and ignore the trailing bytes,
    // so this is transparent to the game client. The timestamp is split into
    // seconds + milliseconds because Date.now() overflows a single u32.
    if (probe) {
      view.setUint32(offset, probe.seq + (i / MAX_ENTRIES), true);
      view.setUint32(offset + 4, Math.floor(probe.serverSendTime / 1000), true);
      view.setUint16(offset + 8, probe.serverSendTime % 1000, true);
    }

    frames.push(frame);
  }

  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const data = new Uint8Array(total);
  let pos = 0;
  for (const frame of frames) {
    data.set(frame, pos);
    offsets.push(pos);
    pos += frame.length;
  }
  offsets.push(total);

  return { data, offsets };
}
