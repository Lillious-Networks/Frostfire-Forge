import { serve } from "@lillious-networks/webtransport-bun";
import crypto from "crypto";
import { FrameDecoder, encodeFrame, encodeCloseReason, decodeCloseReason, CONNECT_FRAME_BYTES, LOGIN_FRAME_BYTES, PLAYER_FRAME_BYTES, frameLimitFor } from "./framing.ts";
import { topicBus } from "./topics.ts";
import { isSwitchTicket, type TicketFields } from "./ticket.ts";
import { RateBucket } from "./ratebucket.ts";
import log from "../modules/logger.ts";
import { logNoIds } from "../cluster/entityids.ts";
import { CREATURE_MOVE_ENTRY_BYTES, CREATURE_MOVE_HEADER, CREATURE_MOVE_HEADER_BYTES } from "./creature_move_codec.ts";
import { packPoseRecords } from "./pose_codec.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const activeConnectionIds = new Set<string>();
/** The server-wide datagram budget (rateLimits.datagramsPerSec / datagramsBurst), set when the server starts. */
let serverDatagrams: RateBucket | null = null;

function isSessionClosedError(error: any): boolean {
  if (!error) return false;
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  return (
    code === "GenericFailure" ||
    code === "E_SESSION_CLOSED" ||
    message.includes("E_SESSION_CLOSED") ||
    message.toLowerCase().includes("session is closed") ||
    message.toLowerCase().includes("session closed")
  );
}

const MOVEMENT_HEADERS = new Set<number>([0x01, 0x02, 0x03]);
const BATCH_MOVEXY_HEADER = 0x01;
const BATCH_HEADER_BYTES = 3;
const BATCH_ENTRY_BYTES = 13; // [u32 id][i32 x][i32 y][u8 dir|stealth]

export const CLOSE_NORMAL = 0;
export const CLOSE_ABNORMAL = 1;

// Below the library's hard 64MB per-session queue limit: once a connection's
// queue passes this, sendFrame stops writing instead of letting the transport
// destroy the stream with E_QUEUE_FULL.
const MAX_SAFE_QUEUE_BYTES = 48 * 1024 * 1024;

// The most one stream write holds when a turn's frames are coalesced. The client's
// frame decoder slices its buffer once per frame, so decoding one read costs about
// the square of its size (0.7 ms at 16 KB, 50 ms at 256 KB): small writes keep it cheap.
const MAX_FLUSH_BYTES = 16 * 1024;

// sendThenClose: the longest it waits for its frames to be written, then for the peer to close the session itself
// (it has read them), and the grace it gives a session that cannot say when the peer closed.
export const SEND_THEN_CLOSE_WRITE_MS = 1000;
const SEND_THEN_CLOSE_PEER_MS = 3000;
const SEND_THEN_CLOSE_GRACE_MS = 100;

// A stream frame whose payload is empty, or one 0x00 byte, carries nothing the client reads (it parses it as JSON and
// ignores the failure). Such frames were seen, five to a connection, from a node under overload, with no log line naming
// the sender. They are dropped here and logged once per caller per minute, with the top of the stack, so the next run
// names the code that queues them.
const EMPTY_FRAME_LOG_MS = 60_000;
const EMPTY_FRAME_SOURCES_MAX = 64;
const emptyFrameLoggedAt = new Map<string, number>();

/** Whether `payload` is a frame with nothing in it: no bytes, or a single 0x00. */
export function isEmptyFrame(payload: Uint8Array): boolean {
  return payload.length === 0 || (payload.length === 1 && payload[0] === 0);
}

/** Logs a dropped empty frame once per source (the first caller outside this file) per minute. */
export function noteEmptyFrame(payload: Uint8Array, connectionId?: unknown, now: number = Date.now()): void {
  const frames = (new Error().stack ?? "").split("\n").slice(1).map((line) => line.trim()).filter((line) => line !== "" && !/socket[\\/]transport\.ts/.test(line));
  const source = frames[0] ?? "unknown";
  const last = emptyFrameLoggedAt.get(source);
  if (last !== undefined && now - last < EMPTY_FRAME_LOG_MS) return;
  if (emptyFrameLoggedAt.size >= EMPTY_FRAME_SOURCES_MAX) emptyFrameLoggedAt.clear();
  emptyFrameLoggedAt.set(source, now);
  log.warn(`Dropping an empty frame (${payload.length} byte${payload.length === 1 ? ", 0x00" : "s"}) for connection ${connectionId}, queued by ${frames.slice(0, 3).join(" <- ") || "unknown"}; logged once a minute per source`);
}

/** `promise`, or false once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | false> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

export { encodeCloseReason, decodeCloseReason };

export { CONNECT_FRAME_BYTES, LOGIN_FRAME_BYTES, PLAYER_FRAME_BYTES, frameLimitFor };

export interface TransportHandlers {
  /** The account the ticket is for ("" for none) and the origin it was signed for, or null when it is refused. */
  validateConnectionToken: (fields: TicketFields) => { account: string; origin: string } | null;
  onOpen: (connection: TransportConnection) => void;
  onClose: (connection: TransportConnection) => void;
  onMessage: (connection: TransportConnection, message: string) => void;
}

export interface TransportServerOptions {
  port: number;
  certPem: string;
  keyPem: string;
  chatDecryptionKey: string;
  maxFrameSize: number;
  maxDatagramSize: number;
  authTimeoutMs: number;
  idleTimeoutMs: number;
  maxSessions: number;
  rateLimits?: any;
  // Cluster mode: ids unique across the world (cluster/ids.ts) in place of random ones.
  /** The id for a new connection, given its ticket's token (a handoff arrival keeps its old id). Null: none left. */
  allocateId?: (token: string) => string | null;
  handlers: TransportHandlers;
}

interface FlushBatch { promise: Promise<void>; resolve: () => void; remaining: number }

// Process-wide stream write counters (see getStreamWriteStats), logged every 60 s at debug/trace level.
let streamWrites = 0;
let streamFrames = 0;
let streamBytes = 0;
let streamMergedWrites = 0;

/** Stream writes, frames, bytes and merged writes (more than one frame) since the process started. */
export function getStreamWriteStats(): { writes: number; frames: number; bytes: number; mergedWrites: number } {
  return { writes: streamWrites, frames: streamFrames, bytes: streamBytes, mergedWrites: streamMergedWrites };
}

if (process.env.LOG_LEVEL === "debug" || process.env.LOG_LEVEL === "trace") {
  let lastWrites = 0;
  const statsTimer = setInterval(() => {
    const s = getStreamWriteStats();
    if (s.writes === lastWrites) return;
    lastWrites = s.writes;
    log.debug(`[WebTransport] stream writes=${s.writes} frames=${s.frames} bytes=${s.bytes} merged=${s.mergedWrites}`);
  }, 60_000);
  (statsTimer as any).unref?.();
}

export class TransportConnection {
  readonly session: any;
  data: any = {};
  readyState: number = 0;
  lastFrameReadAt: number = 0;
  private writer: any = null;
  private pendingWriteBytes: number = 0;
  private pendingFrames: Uint8Array[] = [];
  private pendingFrameBytes: number = 0;
  private pendingFlush: FlushBatch | null = null;
  // Frames flushed but not yet written, oldest first from outHead; outBatches[i] is the send that owns outFrames[i].
  private outFrames: Uint8Array[] = [];
  private outBatches: FlushBatch[] = [];
  private outHead: number = 0;
  private writing: boolean = false;
  private writeFailed: boolean = false;
  private deferredClose: { code: number; reason: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private closedFlag: boolean = false;
  private closeHandled: boolean = false;
  private maxDatagramSize: number;
  private maxFrameSize: number;
  private frameLimiter: ((bytes: number) => void) | null = null;
  /** Set once a player has logged in on this connection: until then it is closed after idleTimeoutMs. */
  loggedIn: boolean = false;
  /** @internal Movement and other datagrams: excess is dropped (rateLimits.datagramsPerSec / datagramsBurst). */
  datagramBucket: RateBucket | null = null;

  constructor(session: any, maxDatagramSize: number, maxFrameSize: number) {
    this.session = session;
    this.maxDatagramSize = maxDatagramSize;
    this.maxFrameSize = maxFrameSize;
  }

  /** A player logged in on this connection: it is no longer closed for sitting idle before a login. */
  markLoggedIn(): void {
    this.loggedIn = true;
  }

  /** The largest frame accepted from this connection from now on, at most the server's maximum. */
  setFrameLimit(bytes: number): void {
    this.frameLimiter?.(Math.min(bytes, this.maxFrameSize));
  }

  /** @internal The stream reader's decoder, so setFrameLimit reaches it. */
  useFrameLimiter(limiter: (bytes: number) => void): void {
    this.frameLimiter = limiter;
  }

  private lastMetricsAt = 0;
  private lastQueuedBytes = 0;
  private lastQueueFullLogAt = 0;

  get bufferedAmount(): number {
    if (this.readyState !== 1) return 0;

    // metricsSnapshot() is a native call - the flush samples this for every
    // receiver on every flush (thousands of times per second at scale), so
    // cache the snapshot briefly. Backpressure checks tolerate 250ms staleness.
    const now = Date.now();
    if (now - this.lastMetricsAt < 250) {
      return this.lastQueuedBytes + this.pendingWriteBytes;
    }

    return this.getFreshQueuedBytes() + this.pendingWriteBytes;
  }

  /**
   * Bypasses the bufferedAmount cache. Use before writing large bursts (spawn
   * batches) where a stale reading could push the session queue past its limit.
   */
  getFreshQueuedBytes(): number {
    if (this.readyState !== 1) return 0;

    let queuedBytes = 0;
    try {
      // A cheap synchronous read of the session's send backlog, replacing the
      // previous library's metricsSnapshot(). Still sampled rather than read
      // per frame: see getSampledQueuedBytes.
      queuedBytes = Number(this.session?.queuedBytes ?? 0n);
    } catch {
      queuedBytes = 0;
    }

    this.lastMetricsAt = Date.now();
    this.lastQueuedBytes = queuedBytes;

    return queuedBytes;
  }

  /**
   * Sampled queue reading for the per-frame write path. metricsSnapshot() is
   * a native call; sampling it on EVERY reliable frame (spawns, chat, topic
   * broadcasts - tens of thousands per second at 1000+ players) was a
   * measurable cost. Refresh at most once per maxAgeMs; between samples the
   * estimate is kept conservative by pendingWriteBytes accounting. The 48MB
   * tripwire sits 16MB below the hard 64MB limit, which absorbs the staleness.
   */
  private getSampledQueuedBytes(maxAgeMs: number = 100): number {
    const now = Date.now();
    if (now - this.lastMetricsAt >= maxAgeMs) {
      this.getFreshQueuedBytes();
    }
    return this.lastQueuedBytes;
  }

  isOpen(): boolean {
    return this.readyState === 1;
  }

  attachStream(writable: any): void {
    if (!writable) return;
    try {
      this.writer = writable.getWriter();
    } catch {
      this.writer = null;
      return;
    }
    this.readyState = 1;
  }

  send(payload: Uint8Array): boolean {
    if (this.readyState !== 1 || !payload || this.dropEmpty(payload)) return false;

    if (MOVEMENT_HEADERS.has(payload[0])) {
      this.sendMovement(payload);
      return true;
    }

    return this.sendFrame(payload) !== null;
  }

  /**
   * send for one payload going to many connections: `shared` holds the length-prefixed frame (encodeFrame), built
   * by the first connection that really queues it, so a broadcast frames its bytes once and every viewer's queue
   * holds the same frame instead of its own copy. The frame is only ever read (copied into a coalesced write or
   * written as it is), so sharing it is safe. Every guard of send applies, and a connection that drops the payload
   * never builds the frame; a payload that is not a stream frame (a movement header) goes the ordinary way.
   * Both return false when the payload was dropped, true when it was queued (or sent).
   */
  sendFramed(payload: Uint8Array, shared: { frame?: Uint8Array }): boolean {
    if (this.readyState !== 1 || !payload || this.dropEmpty(payload)) return false;

    if (MOVEMENT_HEADERS.has(payload[0])) {
      this.sendMovement(payload);
      return true;
    }

    return this.sendFrame(payload, shared) !== null;
  }

  /**
   * Send a message as an unreliable datagram (fire-and-forget, no queueing).
   * Use for periodic, loss-tolerant messages (SERVER_TIME, stats updates)
   * that would otherwise contend for the reliable stream's ordering queue.
   */
  sendBestEffort(payload: Uint8Array): void {
    if (this.readyState !== 1 || !payload || this.dropEmpty(payload)) return;
    if (payload.length > this.maxDatagramSize) {
      if (payload[0] === CREATURE_MOVE_HEADER && this.sendSplitCreatureMoves(payload)) return;
      this.sendFrame(payload);
      return;
    }
    this.sendDatagram(payload);
  }

  /**
   * A binary CREATURE_MOVE past the datagram size goes as several datagrams of whole records, each with its own
   * header and count. False when not even one record fits a datagram (or the payload is not a whole number of
   * records): the caller then sends it on the stream, where the client decodes it alike.
   */
  private sendSplitCreatureMoves(payload: Uint8Array): boolean {
    const perDatagram = Math.floor((this.maxDatagramSize - CREATURE_MOVE_HEADER_BYTES) / CREATURE_MOVE_ENTRY_BYTES);
    const body = payload.length - CREATURE_MOVE_HEADER_BYTES;
    if (perDatagram < 1 || body < 0 || body % CREATURE_MOVE_ENTRY_BYTES !== 0) return false;
    const total = body / CREATURE_MOVE_ENTRY_BYTES;
    for (let first = 0; first < total; first += perDatagram) {
      const count = Math.min(perDatagram, total - first);
      const chunk = new Uint8Array(CREATURE_MOVE_HEADER_BYTES + count * CREATURE_MOVE_ENTRY_BYTES);
      chunk[0] = CREATURE_MOVE_HEADER;
      new DataView(chunk.buffer).setUint16(1, count, true);
      chunk.set(
        payload.subarray(CREATURE_MOVE_HEADER_BYTES + first * CREATURE_MOVE_ENTRY_BYTES, CREATURE_MOVE_HEADER_BYTES + (first + count) * CREATURE_MOVE_ENTRY_BYTES),
        CREATURE_MOVE_HEADER_BYTES
      );
      this.sendDatagram(chunk);
    }
    return true;
  }

  private sendMovement(payload: Uint8Array): void {
    if (payload.length <= this.maxDatagramSize) {
      this.sendDatagram(payload);
      return;
    }

    if (payload[0] === BATCH_MOVEXY_HEADER) {
      this.sendSplitBatch(payload);
      return;
    }

    this.sendFrame(payload);
  }

  private sendSplitBatch(payload: Uint8Array): void {
    if (payload.length < BATCH_HEADER_BYTES) return;

    const count = new DataView(payload.buffer, payload.byteOffset, BATCH_HEADER_BYTES).getUint16(1, true);
    if (count === 0) return;

    const entriesPerDatagram = Math.max(1, Math.floor((this.maxDatagramSize - BATCH_HEADER_BYTES) / BATCH_ENTRY_BYTES));
    let offset = BATCH_HEADER_BYTES;

    while (offset < payload.length) {
      const remainingBytes = payload.length - offset;
      const remainingEntries = Math.floor(remainingBytes / BATCH_ENTRY_BYTES);
      if (remainingEntries <= 0) break;

      const chunkCount = Math.min(entriesPerDatagram, remainingEntries);
      const chunk = new Uint8Array(BATCH_HEADER_BYTES + chunkCount * BATCH_ENTRY_BYTES);
      chunk[0] = BATCH_MOVEXY_HEADER;
      new DataView(chunk.buffer).setUint16(1, chunkCount, true);
      chunk.set(payload.slice(offset, offset + chunkCount * BATCH_ENTRY_BYTES), BATCH_HEADER_BYTES);

      this.sendDatagram(chunk);
      offset += chunkCount * BATCH_ENTRY_BYTES;
    }
  }

  private sendDatagram(payload: Uint8Array): void {
    // Prefer the synchronous native path: datagrams are lossy and the enqueue
    // does not block, so the Promise + tokio task hop of the async sendDatagram
    // is pure overhead - and at high player counts the server pushes tens of
    // thousands of movement datagrams per second through here.
    // sendSync skips the writer and promise a spec datagram write allocates.
    // Datagrams are unreliable and the enqueue never blocks, so there is
    // nothing to await, and this path carries tens of thousands per second.
    try {
      this.session.datagrams.sendSync(payload);
    } catch (error) {
      if (this.readyState !== 3 && !isSessionClosedError(error)) {
        log.debug(`Datagram send failed: ${error}`);
      }
    }
  }

  /**
   * Send several movement datagrams in a single native call. Each element must
   * already be datagram-sized (the movement encoder guarantees this). Falls
   * one crossing into the transport.
   */
  sendMovementBatch(payloads: Uint8Array[]): void {
    if (this.readyState !== 1 || payloads.length === 0) return;
    try {
      this.session.datagrams.sendSyncBatch(payloads);
    } catch (error) {
      if (!isSessionClosedError(error)) {
        log.debug(`Datagram batch send failed: ${error}`);
      }
    }
  }

  /**
   * Pose records (socket/pose_codec.ts) as datagrams: packed into datagrams of whole records no longer than the
   * datagram size the movement datagrams respect, and sent in one native call (sendSync for one datagram, sendSyncBatch
   * for more). Fire-and-forget like any datagram. False when nothing was sent (the connection is not open, or no
   * records), so the caller sends the pose on the stream.
   */
  sendPoseRecords(records: Uint8Array[]): boolean {
    if (this.readyState !== 1 || records.length === 0) return false;
    const datagrams = packPoseRecords(records, this.maxDatagramSize);
    if (datagrams.length === 0) return false;
    if (datagrams.length === 1) this.sendDatagram(datagrams[0]);
    else this.sendMovementBatch(datagrams);
    return true;
  }

  // True (and logged, see noteEmptyFrame) for a payload that is empty or one 0x00 byte: it is not sent.
  private dropEmpty(payload: Uint8Array): boolean {
    if (!isEmptyFrame(payload)) return false;
    noteEmptyFrame(payload, this.data?.id);
    return true;
  }

  /** Resolves once the frame is written (or the write failed); null when it was not sent at all. */
  private sendFrame(payload: Uint8Array, shared?: { frame?: Uint8Array }): Promise<void> | null {
    if (this.dropEmpty(payload)) return null;
    if (payload.length > this.maxFrameSize) {
      log.warn(`Dropping oversized frame for connection ${this.data?.id}: ${payload.length} bytes`);
      return null;
    }

    const writer = this.writer;
    if (!writer || this.writeFailed) return null;

    // Last-resort tripwire: if the session's outbound queue is already near the
    // hard limit (64MB), the client is hopelessly behind - skip the write
    // instead of letting the transport reject it with E_QUEUE_FULL. The client
    // either recovers or its own watchdog reconnects.
    // Uses the sampled reading (see getSampledQueuedBytes) - a native snapshot
    // per frame is far too expensive at scale.
    const queuedBytes = this.getSampledQueuedBytes(100) + this.pendingWriteBytes;
    if (queuedBytes > MAX_SAFE_QUEUE_BYTES) {
      const now = Date.now();
      if (now - this.lastQueueFullLogAt > 10000) {
        this.lastQueueFullLogAt = now;
        log.warn(
          `[WebTransport] Stream queue full for connection ${this.data?.id} ` +
          `(${this.data?.useragent || "unknown agent"}) - ${Math.round(queuedBytes / 1024)}KB queued, dropping stream frames (client is not keeping up)`
        );
      }
      return null;
    }

    const frame = shared ? (shared.frame ??= encodeFrame(payload)) : encodeFrame(payload);
    this.pendingWriteBytes += frame.length;
    this.pendingFrames.push(frame);
    this.pendingFrameBytes += frame.length;

    // One flush per connection per turn: every frame queued until the current
    // synchronous work ends goes into the outbox together. A microtask runs as
    // soon as that work returns, in the same event-loop turn, so a frame never
    // waits behind timers or I/O the way it would with setImmediate.
    if (!this.pendingFlush) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      this.pendingFlush = { promise, resolve, remaining: 0 };
      queueMicrotask(() => this.flushFrames());
    }
    return this.pendingFlush.promise;
  }

  /**
   * Moves the turn's queued frames to the outbox and starts the write pump. A
   * connection that is no longer open (or whose stream failed) drops what is
   * queued instead of writing.
   */
  private flushFrames(): void {
    const batch = this.pendingFlush;
    if (!batch) return;
    const frames = this.pendingFrames;
    const total = this.pendingFrameBytes;
    this.pendingFlush = null;
    this.pendingFrames = [];
    this.pendingFrameBytes = 0;

    if (this.readyState !== 1 || !this.writer || this.writeFailed) {
      this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - total);
      batch.resolve();
      return;
    }

    batch.remaining = frames.length;
    for (let i = 0; i < frames.length; i++) {
      this.outFrames.push(frames[i]);
      this.outBatches.push(batch);
    }
    this.pumpWrites();
  }

  /**
   * At most one stream write is in flight per connection. Idle, the first write
   * leaves at once; while one is in flight the frames pile up in the outbox, and
   * when it settles everything queued goes out together, split into writes of
   * whole frames of at most MAX_FLUSH_BYTES (a single larger frame is written
   * alone), in queue order. Without this each flush became its own queued write
   * on the stream, and long ticks made those queues longer.
   */
  private pumpWrites(): void {
    if (this.writing) return;
    const frames = this.outFrames;
    const first = this.outHead;
    if (first >= frames.length) {
      this.finishDrain();
      return;
    }
    const writer = this.writer;
    if (!writer || this.writeFailed || (this.readyState !== 1 && !this.deferredClose)) {
      this.dropOutbox();
      return;
    }

    let end = first;
    let size = 0;
    while (end < frames.length && (end === first || size + frames[end].length <= MAX_FLUSH_BYTES)) {
      size += frames[end].length;
      end++;
    }
    let chunk: Uint8Array;
    if (end - first === 1) {
      chunk = frames[first];
    } else {
      chunk = new Uint8Array(size);
      let offset = 0;
      for (let i = first; i < end; i++) {
        chunk.set(frames[i], offset);
        offset += frames[i].length;
      }
    }
    const batches = this.outBatches.slice(first, end);
    if (end >= frames.length) {
      this.outFrames = [];
      this.outBatches = [];
      this.outHead = 0;
    } else if (end > 512) {
      this.outFrames = frames.slice(end);
      this.outBatches = this.outBatches.slice(end);
      this.outHead = 0;
    } else {
      this.outHead = end;
    }

    this.writing = true;
    streamWrites++;
    streamFrames += batches.length;
    streamBytes += size;
    if (batches.length > 1) streamMergedWrites++;

    let written: Promise<void>;
    try {
      written = Promise.resolve(writer.write(chunk));
    } catch (error) {
      written = Promise.reject(error);
    }
    written.then(
      () => this.writeSettled(size, batches, null),
      (error: any) => this.writeSettled(size, batches, error)
    );
  }

  private writeSettled(size: number, batches: FlushBatch[], error: any): void {
    this.writing = false;
    this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - size);
    for (const batch of batches) {
      if (--batch.remaining <= 0) batch.resolve();
    }
    if (error) {
      this.writeFailed = true;
      // There is no queue-full error here: a write that outruns the peer
      // waits on QUIC flow control, and the queuedBytes tripwire above sheds
      // frames before a client gets that far behind.
      const sessionClosed = isSessionClosedError(error);
      if (this.readyState !== 3 && !sessionClosed) {
        log.debug(`Frame write failed: ${String(error?.message || error)}`);
      }
      this.dropOutbox();
      // The stream is dead but the session may not be: without a close the player stays connected and gets nothing,
      // for good. Closing runs the normal disconnect path (save, cleanup). A session that is already closed needs none,
      // and close() ignores a connection that is closing, so this happens once; it must not throw out of the write path.
      if (!sessionClosed) {
        try {
          this.close(1011, "stream write failed");
        } catch (closeError: any) {
          log.debug(`[WebTransport] Close after a failed write failed: ${String(closeError?.message || closeError)}`);
        }
      }
      return;
    }
    this.pumpWrites();
  }

  /** The stream is dead or the connection closed: what is queued is not written. Settles every waiting send. */
  private dropOutbox(): void {
    const frames = this.outFrames;
    const batches = this.outBatches;
    for (let i = this.outHead; i < frames.length; i++) {
      this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - frames[i].length);
      if (--batches[i].remaining <= 0) batches[i].resolve();
    }
    this.outFrames = [];
    this.outBatches = [];
    this.outHead = 0;
    this.finishDrain();
  }

  // The outbox is empty and nothing is in flight: a close that waited for the queued frames goes through now.
  private finishDrain(): void {
    if (this.writing || this.outHead < this.outFrames.length) return;
    const deferred = this.deferredClose;
    if (!deferred) return;
    this.deferredClose = null;
    clearTimeout(deferred.timer);
    this.closeSession(deferred.code, deferred.reason);
  }

  private closeSession(code: number, reason: string): void {
    const wtCode = code === 1000 ? CLOSE_NORMAL : CLOSE_ABNORMAL;
    try {
      this.session.close({ closeCode: wtCode, reason: encodeCloseReason(code, reason) });
    } catch (error: any) {
      log.debug(`[WebTransport] Session close failed: ${error?.message || error}`);
    }
  }

  /**
   * Sends the last frames on the stream and closes once the peer has them: a
   * close straight after a send can lose them (the session's close drops what
   * the stream has not delivered yet). For a frame the peer answers by closing
   * the session itself (SWITCH), the peer's close is the sign it was read; the
   * session is closed from here only when that does not come within peerMs.
   * A write that does not finish within writeMs does not hold the close.
   */
  async sendThenClose(payloads: Uint8Array[], code: number, reason: string, { writeMs = SEND_THEN_CLOSE_WRITE_MS, peerMs = SEND_THEN_CLOSE_PEER_MS } = {}): Promise<void> {
    if (this.readyState !== 1) return;
    const writes = payloads.map((payload) => this.sendFrame(payload)).filter((write) => write !== null);
    // The frames go out now, with whatever was queued before them, not at the end of the turn.
    if (this.pendingFlush) this.flushFrames();
    const written = await within(Promise.all(writes).then(() => true), writeMs);
    if (written) {
      const peerClosed = this.session?.closed;
      if (peerClosed && typeof peerClosed.then === "function") await within(Promise.resolve(peerClosed).catch(() => {}), peerMs);
      else await new Promise((resolve) => setTimeout(resolve, SEND_THEN_CLOSE_GRACE_MS));
    }
    // It has waited for its own write (writeMs) and the peer already: a write still in flight is not waited for again.
    this.close(code, reason, { drain: true, inFlight: false });
  }

  /**
   * drain: a graceful send (the restart notice, the "logged in from another location" notice) - the write in flight
   * (the frames this very turn queued start one at once on an idle connection) and the frames still queued behind it are
   * written before the session closes, for writeMs at most. Any other close ends the session at once and drops them.
   * inFlight: whether the drain also waits for the write in flight (default: with drain); sendThenClose has waited already.
   */
  close(code: number = 1000, reason: string = "", { drain = false, inFlight = drain }: { drain?: boolean; inFlight?: boolean } = {}): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    // Frames queued this turn are written before the session closes, as they were when each frame wrote at once.
    if (this.pendingFlush) this.flushFrames();
    this.readyState = 3;

    // A graceful close writes the write in flight and the frames still behind it first (never after the close); a stuck write holds it for writeMs at most.
    if (this.outHead < this.outFrames.length && !drain) this.dropOutbox();
    if (this.outHead < this.outFrames.length || (inFlight && this.writing)) {
      const timer = setTimeout(() => {
        const deferred = this.deferredClose;
        if (!deferred) return;
        this.deferredClose = null;
        this.dropOutbox();
        this.closeSession(deferred.code, deferred.reason);
      }, SEND_THEN_CLOSE_WRITE_MS);
      (timer as any).unref?.();
      this.deferredClose = { code, reason, timer };
      return;
    }
    this.closeSession(code, reason);
  }

  subscribe(topic: string): void {
    topicBus.subscribe(topic, this);
  }

  unsubscribe(topic: string): void {
    topicBus.unsubscribe(topic, this);
  }

  markCloseHandled(): void {
    this.closeHandled = true;
  }

  isCloseHandled(): boolean {
    return this.closeHandled;
  }
}

/**
 * How long a cluster node lets a session sit without its AUTH_CONNECT. A client opens its session to the next node
 * while the player is still walking toward the border (HANDOFF_PREPARE) and holds it, unauthenticated and with no
 * player, until the SWITCH brings the ticket; it gives the session up after 10 s itself, so the node waits longer than
 * that. Bounded, and the same for every session of a cluster node; a single node keeps its configured timeout.
 */
export const PREOPEN_AUTH_TIMEOUT_MS = 15_000;

/** The time a session may stay without its AUTH_CONNECT on this server. */
export function authTimeoutFor(options: Pick<TransportServerOptions, "authTimeoutMs" | "allocateId">): number {
  return options.allocateId ? Math.max(options.authTimeoutMs, PREOPEN_AUTH_TIMEOUT_MS) : options.authTimeoutMs;
}

/** Closes the connection after `ms` unless it was given an id (AUTH_CONNECT passed) by then. */
export function startAuthTimer(connection: TransportConnection, ms: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (!connection.data.id) {
      log.warn(`[WebTransport] Authentication timeout for session ${connection.session?.id}`);
      connection.close(1008, "Authentication timeout");
    }
  }, ms);
}

export function startWebTransportServer(options: TransportServerOptions): Promise<any> {
  // This library takes no rate limits of its own, so the configured ones are
  // applied here: new sessions against handshakesPerSec / handshakesBurst
  // (server-wide: the library does not say which address a session is from,
  // so handshakesBurstPerPrefix cannot be applied), datagrams against
  // datagramsPerSec / datagramsBurst server-wide and
  // datagramsPerSecPerConnection / datagramsBurstPerConnection (default 240
  // and 480: a client moves at 30 a second) for each connection, and streams by
  // maxConcurrentStreams (a client uses one). Queues are still shed via the
  // queuedBytes tripwire in sendFrame(). See the notes on MAX_SAFE_QUEUE_BYTES.
  const limits = options.rateLimits || {};
  const handshakes = new RateBucket(Number(limits.handshakesPerSec), Number(limits.handshakesBurst));
  serverDatagrams = new RateBucket(Number(limits.datagramsPerSec), Number(limits.datagramsBurst));
  let refusedHandshakes = 0;
  let lastRefusalLog = -Infinity;
  return serve({
    hostname: "0.0.0.0",
    port: options.port,
    cert: options.certPem,
    key: options.keyPem,
    maxSessions: options.maxSessions,
    maxConcurrentStreams: Number(limits.maxConcurrentStreams) || 16,
    session: (session: any) => {
      if (!handshakes.take()) {
        refusedHandshakes++;
        const now = Date.now();
        if (now - lastRefusalLog >= 10_000) {
          log.warn(`[WebTransport] Handshake rate limit reached: ${refusedHandshakes} session(s) refused`);
          lastRefusalLog = now;
          refusedHandshakes = 0;
        }
        // Throwing rejects the session.
        throw new Error("Handshake rate limit reached");
      }
      handleSession(session, options).catch((error: any) => {
        if (!isSessionClosedError(error)) {
          log.debug(`[WebTransport] Session handler failed: ${error?.message || error}`);
        }
      });
    },
    error: (error: any) => {
      if (!isSessionClosedError(error)) {
        log.warn(`[WebTransport] ${error?.message || error}`);
      }
    },
  });
}

async function handleSession(session: any, options: TransportServerOptions): Promise<void> {
  const connection = new TransportConnection(session, options.maxDatagramSize, options.maxFrameSize);
  const limits = options.rateLimits || {};
  connection.datagramBucket = new RateBucket(Number(limits.datagramsPerSecPerConnection ?? 240), Number(limits.datagramsBurstPerConnection ?? 480));

  const authTimer = startAuthTimer(connection, authTimeoutFor(options));

  session.closed
    .then(() => {
      if (authTimer) clearTimeout(authTimer);
      finishClose(connection, options);
    })
    .catch(() => {
      if (authTimer) clearTimeout(authTimer);
      finishClose(connection, options);
    });

  startDatagramLoop(session, connection, options);
  await startStreamLoop(session, connection, authTimer, options);

  if (authTimer) clearTimeout(authTimer);
  finishClose(connection, options);
}

async function startStreamLoop(
  session: any,
  connection: TransportConnection,
  authTimer: any,
  options: TransportServerOptions
): Promise<void> {
  try {
    const incomingStreams = session?.incomingBidirectionalStreams;
    if (!incomingStreams || typeof incomingStreams.getReader !== "function") {
      connection.close(1008, "No incoming stream support");
      return;
    }

    const streamReader = incomingStreams.getReader();
    const first = await streamReader.read();
    if (first.done || !first.value) {
      connection.close(1008, "No control stream received");
      return;
    }

    const bidi = first.value;
    const decoder = new FrameDecoder(Math.min(CONNECT_FRAME_BYTES, options.maxFrameSize));
    connection.useFrameLimiter((bytes) => decoder.setMaxFrameSize(bytes));
    let authenticated = false;

    for await (const chunk of bidi.readable) {
      if (decoder.isOverflowed()) {
        connection.close(1009, "Frame too large");
        return;
      }

      const frames = decoder.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      const readWallTime = Date.now();

      for (const frame of frames) {
        if (!authenticated) {
          authenticated = tryAuthenticate(connection, frame, bidi.writable, authTimer, options);
          if (!authenticated) {
            connection.close(1008, "Unauthorized: Invalid token");
            return;
          }
          // Room for the AUTH packet; the receiver allows a player's limit once they are logged in.
          connection.setFrameLimit(LOGIN_FRAME_BYTES);
          continue;
        }

        // A handler closed this connection (LOGOUT, a kick) while frames the
        // client sent after it were still in this chunk. Handlers can't act on
        // a closed connection, and running them anyway (e.g. a trailing
        // movement packet re-registering a mover) would undo the close
        // cleanup - stop reading instead.
        if (!connection.isOpen()) return;

        // Stamp the actual read time so handlers can measure event-loop
        // queueing between frame arrival and dispatch.
        connection.lastFrameReadAt = readWallTime;

        const message = textDecoder.decode(frame);
        options.handlers.onMessage(connection, message);
      }
    }
  } catch {
    // Expected on session close
  }
}

function startDatagramLoop(session: any, connection: TransportConnection, options: TransportServerOptions): void {
  (async () => {
    try {
      // Datagrams arrive as a WHATWG ReadableStream rather than the async
      // iterator the previous library exposed.
      const reader = session.datagrams.readable.getReader();
      for (;;) {
        const { value: datagram, done } = await reader.read();
        if (done) break;
        if (!connection.data.id) continue;
        // Closed by a handler: late datagrams are dropped, as on the stream.
        if (!connection.isOpen()) break;
        // Over the connection's datagram rate: dropped, as a lossy datagram may be.
        if (connection.datagramBucket && !connection.datagramBucket.take()) continue;
        if (serverDatagrams && !serverDatagrams.take()) continue;

        try {
          const message = textDecoder.decode(datagram instanceof Uint8Array ? datagram : new Uint8Array(datagram));
          options.handlers.onMessage(connection, message);
        } catch (error: any) {
          log.debug(`[WebTransport] Datagram handling failed: ${error?.message || error}`);
        }
      }
    } catch {
      // Expected on session close
    }
  })();
}

function tryAuthenticate(
  connection: TransportConnection,
  frame: Uint8Array,
  writable: any,
  authTimer: any,
  options: TransportServerOptions
): boolean {
  let parsed: any;
  try {
    parsed = JSON.parse(textDecoder.decode(frame));
  } catch {
    return false;
  }

  if (!parsed || parsed.type !== "AUTH_CONNECT") {
    return false;
  }

  const data = parsed?.data || {};
  const ticket = options.handlers.validateConnectionToken({
    token: data?.token,
    timestamp: data?.timestamp,
    expiresAt: data?.expiresAt,
    signature: data?.signature,
    origin: data?.origin,
    account: data?.account,
    nodeId: data?.nodeId,
  });

  if (!ticket) {
    log.warn(`[WebTransport] Rejected connection with invalid token from ${connection.session?.peer?.ip || "unknown"}`);
    return false;
  }

  if (authTimer) clearTimeout(authTimer);

  let id: string;
  let attempts = 0;
  do {
    const allocated = options.allocateId ? options.allocateId(String(data?.token ?? "")) : parseInt(crypto.randomBytes(4).toString("hex"), 16).toString();
    if (allocated === null) {
      logNoIds("transport", "[WebTransport] Refused a connection: this node has no world ids left to give it");
      return false;
    }
    id = allocated;
    attempts++;
    if (attempts > 100) {
      log.error("[WebTransport] Failed to allocate unique connection ID after 100 attempts");
      return false;
    }
  } while (activeConnectionIds.has(id));

  activeConnectionIds.add(id);

  connection.data = {
    id,
    useragent: data?.useragent || "unknown",
    chatDecryptionKey: options.chatDecryptionKey,
    // The account this connection may log in as (see ticket.ts): AUTH is refused for any other.
    ticketAccount: ticket.account,
    // The origin its ticket was signed for: a SWITCH ticket to another node is signed for the same one.
    ticketOrigin: ticket.origin,
    // Opened with a ticket another node signed (SWITCH): this login is not handed on again.
    switched: isSwitchTicket(data?.token),
    // The ticket itself: a node ticket is spent on first use (cluster/ticketspend.ts).
    ticketToken: String(data?.token ?? ""),
    ticketExpiresAt: Number(data?.expiresAt) || 0,
  };

  connection.attachStream(writable);
  options.handlers.onOpen(connection);

  // A connection that holds a ticket but never logs anyone in is closed after
  // idleTimeoutMs, so it cannot sit on a session slot. A logged-in player may
  // idle (QUIC's own idle timeout closes a dead peer).
  if (options.idleTimeoutMs > 0) {
    const idle = setTimeout(() => {
      if (!connection.loggedIn && connection.isOpen()) connection.close(1008, "No login");
    }, options.idleTimeoutMs);
    (idle as any).unref?.();
    connection.session?.closed?.finally?.(() => clearTimeout(idle));
  }

  connection.send(textEncoder.encode(JSON.stringify({ type: "AUTH_CONNECT_SUCCESS", data: null })));

  return true;
}

function finishClose(connection: TransportConnection, options: TransportServerOptions): void {
  if (connection.isCloseHandled()) return;
  connection.markCloseHandled();

  connection.readyState = 3;
  topicBus.clear(connection);

  if (connection.data?.id != null) {
    activeConnectionIds.delete(connection.data.id);
    options.handlers.onClose(connection);
  }
}
