/**
 * Pose frame counters (measurement only): how many animation frames go out and how many repeat the pose the
 * receiver was already sent. Counting never changes a packet, its order or its timing. Logged every 60 s at
 * debug/trace level, like getStreamWriteStats in socket/transport.ts.
 *
 * Viewer poses go out two ways (socket/posedgram.ts): `poseOnly` counts the pose frames on the reliable stream (a
 * stream write each: the kind that stalled a node), `datagram` the pose datagrams sent with a change and
 * `datagramRepeats` the ones sent again after it. The log line holds the totals and, over the 60 s since the last
 * line, streamPoseFramesPerSec and datagramPoseSendsPerSec (first sends and repeats), so they show apart.
 */
import log from "../modules/logger";

const MAX_NAMES = 64;
const MAX_SEEN_PER_VIEWER = 256;

const state = {
  calls: 0,
  repeats: 0,
  self: 0,
  poseOnly: 0,
  full: 0,
  relayCalls: 0,
  viewerRepeats: 0,
  datagram: 0,
  datagramRepeats: 0,
};
const byName = new Map<string, number>();
const lastKeyBySubject = new WeakMap<object, string>();
const lastKeyByViewer = new WeakMap<object, Map<string, string>>();

/** One animation call for `subject`, by animation `name` and pose `key`. */
export function notePoseCall(subject: object, name: string, key: string): void {
  state.calls++;
  const known = byName.get(name);
  if (known !== undefined) byName.set(name, known + 1);
  else if (byName.size < MAX_NAMES) byName.set(name, 1);
  else byName.set("other", (byName.get("other") ?? 0) + 1);
  if (lastKeyBySubject.get(subject) === key) state.repeats++;
  lastKeyBySubject.set(subject, key);
}

export function notePoseSelf(): void { state.self++; }
/** Calls of the ghost relay (it sends nothing without a cluster or peers), not frames. */
export function notePoseRelay(): void { state.relayCalls++; }

/** A frame to a viewer for `subjectId`: pose-only or full; `key` is the pose key (when known). */
export function notePoseViewer(viewer: object, subjectId: string, key: string | undefined, poseOnly: boolean): void {
  if (poseOnly) state.poseOnly++;
  else state.full++;
  if (key === undefined) return;
  let map = lastKeyByViewer.get(viewer);
  if (!map) lastKeyByViewer.set(viewer, (map = new Map()));
  else if (map.size >= MAX_SEEN_PER_VIEWER && !map.has(subjectId)) map.clear();
  if (map.get(subjectId) === key) state.viewerRepeats++;
  map.set(subjectId, key);
}

/** A pose datagram to a viewer for `subjectId` (sent with the change); `key` is the pose key (when known). */
export function notePoseDatagram(viewer: object, subjectId: string, key: string | undefined): void {
  state.datagram++;
  if (key === undefined) return;
  let map = lastKeyByViewer.get(viewer);
  if (!map) lastKeyByViewer.set(viewer, (map = new Map()));
  else if (map.size >= MAX_SEEN_PER_VIEWER && !map.has(subjectId)) map.clear();
  if (map.get(subjectId) === key) state.viewerRepeats++;
  map.set(subjectId, key);
}

/** Pose records sent again by datagram after a change (one per viewer and pose). */
export function notePoseRepeats(count: number): void { state.datagramRepeats += count; }

export interface PoseStats {
  calls: number;
  repeats: number;
  self: number;
  poseOnly: number;
  full: number;
  relayCalls: number;
  viewerRepeats: number;
  datagram: number;
  datagramRepeats: number;
  byName: Record<string, number>;
}

export function getPoseStats(): PoseStats {
  return { ...state, byName: Object.fromEntries(byName) };
}

if (process.env.LOG_LEVEL === "debug" || process.env.LOG_LEVEL === "trace") {
  let lastCalls = -1;
  let lastFrames = -1;
  let lastStream = 0;
  let lastDatagram = 0;
  let lastAt = Date.now();
  const timer = setInterval(() => {
    const s = getPoseStats();
    const frames = s.self + s.poseOnly + s.full + s.relayCalls + s.datagram + s.datagramRepeats;
    if (s.calls === lastCalls && frames === lastFrames) return;
    lastCalls = s.calls;
    lastFrames = frames;
    const now = Date.now();
    const seconds = Math.max(1, (now - lastAt) / 1000);
    const streamPerSec = ((s.poseOnly - lastStream) / seconds).toFixed(1);
    const datagramPerSec = ((s.datagram + s.datagramRepeats - lastDatagram) / seconds).toFixed(1);
    lastStream = s.poseOnly;
    lastDatagram = s.datagram + s.datagramRepeats;
    lastAt = now;
    log.debug(`[Pose] calls=${s.calls} repeats=${s.repeats} self=${s.self} poseOnly=${s.poseOnly} full=${s.full} relayCalls=${s.relayCalls} viewerRepeats=${s.viewerRepeats} datagramPose=${s.datagram} datagramRepeats=${s.datagramRepeats} streamPoseFramesPerSec=${streamPerSec} datagramPoseSendsPerSec=${datagramPerSec} names=${JSON.stringify(s.byName)}`);
  }, 60_000);
  (timer as any).unref?.();
}

/** Test seam: zero the counters. */
export function resetPoseStats(): void {
  for (const k of Object.keys(state) as (keyof typeof state)[]) state[k] = 0;
  byName.clear();
}
