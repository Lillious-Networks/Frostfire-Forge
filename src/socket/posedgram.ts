/**
 * Viewer pose changes by datagram.
 *
 * A player's walk/idle/cast change used to be one reliable stream frame per viewer, and a native stream write costs
 * 150-190 us of main-thread time against about 11 us for a datagram (stall2500 report): at 800 players a node
 * made 3.3-3.8k such writes a second, 81-87% of them poses, and stalled. The per-viewer pose now goes as a datagram
 * (socket/pose_codec.ts) carrying the player's pose revision. The rest stays reliable: the full sheets, the pose a
 * viewer is sent on spawn, on entering the view and at a landing, the player's own copy and the mirror relay.
 *
 * A datagram can be lost, arrive late or out of order, so:
 *  - Repeat. A pose is state, not an event. After each change the current pose goes again, by datagram, to the same
 *    viewers at POSE_REPEAT_MS after the change (100, 400 and 1500 ms), and a newer change of the player stops the
 *    repeats of the older one. A repeat carries the pose and revision of the player's latest change, never an older
 *    pose. A viewer reaches the current pose within the last repeat (1.5 s plus the trip) if one datagram of the
 *    four gets through and the client knows the player by then; if all four are lost it keeps the pose it had until the
 *    player's next change, the viewer's next entry into the view (reliable), or the next repeat of a later change.
 *  - Revision. Each change of a player takes the next number of that player's pose revision (`poseRev` on the
 *    player). The client applies a datagram pose only when its revision is newer than the one it shows for that
 *    player, so a late or repeated datagram changes nothing. The revision travels with a handed-off player in the
 *    handoff state (`poseRev`), and the new node counts on from it: it never sends a lower one. The stream copies of
 *    a viewer's pose and sheet (the full sheet of a viewer that does not hold the look, the stream pose of a
 *    connection without datagrams) carry the same revision (`poseRev`, built per change by `withRevision`), so a
 *    client that already shows a newer pose keeps it when such a copy arrives late (posepacket.ts). A client
 *    forgets the revision only when it builds the player anew (spawn, entering the view, a landing), and takes a
 *    sheet or pose with no revision (the spawn path, the relay, an older engine) as a baseline, so a revision that
 *    restarted (a login after a crash) is not shut out.
 */
import log from "../modules/logger";
import playerCache from "../services/playermanager";
import * as aoiReverse from "../services/aoiReverseIndex";
import { POSE_REVISION_MAX } from "./pose_codec";
import { notePoseRepeats } from "./posestats";

/** When the current pose is sent again, in ms after the change. Each entry is one more datagram per viewer. */
export const POSE_REPEAT_MS: readonly number[] = [100, 400, 1500];

/** The next pose revision of `player`, which is recorded on it. Past the width of the datagram field it stops rising: such a pose goes on the stream. */
export function nextPoseRevision(player: any): number {
  const last = Number.isSafeInteger(player?.poseRev) && player.poseRev > 0 ? player.poseRev : 0;
  const next = last >= POSE_REVISION_MAX ? POSE_REVISION_MAX + 1 : last + 1;
  if (player && typeof player === "object") player.poseRev = next;
  return next;
}

/** The pose revision an arriving player's handoff state carries: a non-negative integer that fits the datagram field, else 0. */
export function arrivedPoseRevision(state: unknown): number {
  const value = (state as { poseRev?: unknown } | null | undefined)?.poseRev;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= POSE_REVISION_MAX ? value : 0;
}

interface Pending {
  source: any;
  id: string;
  revision: number;
  record: Uint8Array;
  viewers: string[];
  changedAt: number;
  step: number;
}

export interface RepeaterDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Whether the player is still here and live (not logged out, not handed off, not a mirror). */
  live(source: any): boolean;
  /** The player with this id, or null. */
  viewer(id: string): any | null;
  /** Whether the viewer still has the player in its view. */
  sees(viewerId: string, sourceId: string): boolean;
}

const defaultDeps: RepeaterDeps = {
  now: () => performance.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as any).unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as any),
  live: (source) => !!source && !source.remote && !source.handedOff && playerCache.get(source.id) === source,
  viewer: (id) => playerCache.get(id) ?? null,
  sees: (viewerId, sourceId) => aoiReverse.getViewers(sourceId).has(viewerId),
};

export class PoseRepeater {
  private pending = new Map<string, Pending>();
  private timer: unknown = null;
  private timerAt = Infinity;
  private deps: RepeaterDeps;

  constructor(deps: Partial<RepeaterDeps> = {}, private delays: readonly number[] = POSE_REPEAT_MS) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /** Swap parts of the clock and lookups (tests); a pending timer is dropped. */
  configure(deps: Partial<RepeaterDeps>, delays?: readonly number[]): void {
    this.reset();
    this.deps = { ...defaultDeps, ...deps };
    if (delays) this.delays = delays;
  }

  /** Forget everything pending and stop the timer. */
  reset(): void {
    this.pending.clear();
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  /** Players with repeats pending. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * A change of `source`'s pose, sent now to `viewers` (ids). Their copies are sent again after each delay; the repeats
   * of an older change of this player stop. A change older than the one pending is ignored (a pose never goes back).
   */
  schedule(source: any, revision: number, record: Uint8Array, viewers: string[]): void {
    const id = String(source.id);
    const old = this.pending.get(id);
    if (old && old.revision > revision) return;
    if (viewers.length === 0 || this.delays.length === 0) {
      this.pending.delete(id);
      return;
    }
    this.pending.set(id, { source, id, revision, record, viewers, changedAt: this.deps.now(), step: 0 });
    this.arm();
  }

  /** Stops the repeats of this player. */
  cancel(id: string): void {
    this.pending.delete(String(id));
  }

  private dueAt(p: Pending): number {
    return p.changedAt + this.delays[p.step];
  }

  private arm(): void {
    let earliest = Infinity;
    for (const p of this.pending.values()) earliest = Math.min(earliest, this.dueAt(p));
    if (earliest === Infinity) return;
    if (this.timer !== null) {
      if (this.timerAt <= earliest) return;
      this.deps.clearTimer(this.timer);
    }
    this.timerAt = earliest;
    this.timer = this.deps.setTimer(() => this.run(), Math.max(0, earliest - this.deps.now()));
  }

  /** Sends what is due. Public so the tests (and nothing else) can drive it. */
  run(): void {
    this.timer = null;
    this.timerAt = Infinity;
    try {
      const now = this.deps.now();
      const byConnection = new Map<any, Uint8Array[]>();
      for (const [id, p] of this.pending) {
        if (this.dueAt(p) > now) continue;
        p.step++;
        if (p.step >= this.delays.length) this.pending.delete(id);
        // Gone (logged out, handed off), or a later change of the player took another way: nothing to repeat.
        if (!this.deps.live(p.source) || p.source.poseRev !== p.revision) {
          this.pending.delete(id);
          continue;
        }
        for (const viewerId of p.viewers) {
          const viewer = this.deps.viewer(viewerId);
          const wt = viewer?.wt;
          if (!wt || wt.readyState !== 1 || typeof wt.sendPoseRecords !== "function") continue;
          if (!this.deps.sees(viewerId, p.id)) continue;
          let list = byConnection.get(wt);
          if (!list) byConnection.set(wt, (list = []));
          list.push(p.record);
        }
      }
      let sent = 0;
      for (const [wt, records] of byConnection) {
        try {
          if (wt.sendPoseRecords(records)) sent += records.length;
        } catch (error) {
          log.debug(`Pose repeat failed: ${error}`);
        }
      }
      if (sent > 0) notePoseRepeats(sent);
    } catch (error) {
      log.debug(`Pose repeats failed: ${error}`);
    } finally {
      this.arm();
    }
  }
}

/** The repeats of this node's players. */
export const poseRepeats = new PoseRepeater();
