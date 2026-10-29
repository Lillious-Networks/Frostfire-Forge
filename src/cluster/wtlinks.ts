import { WebTransport, serve } from "@lillious-networks/webtransport-bun";
import type { WebTransportBidirectionalStream, WebTransportServer, WebTransportServerSession, WebTransportSessionRequest, WebTransportWriter } from "@lillious-networks/webtransport-bun";
import log from "../modules/logger";
import { FrameDecoder, encodeFrame } from "../socket/framing";
import type { LinkChannel, LinkHandlers, LinkPeerAddress, LinkTransport } from "./linktransport";

// Node links over WebTransport (spec §1): a listener of its own on NODE_LINK_PORT,
// apart from the client listener and its rate limits, with the engine's
// certificate. A dialler pins the peer's certificate hash from its NodeInfo;
// the library has no "skip verification". One bidirectional stream per session
// carries length-prefixed frames; datagrams carry GHOST_MOVE.
//
// Two lanes in front of that one stream (LaneWriter, stall fix). Control frames (calls, their answers, pings: the small
// messages a node waits on) go ahead of bulk frames (ghosts, AOI), so a call queued behind a backlog of bulk frames on
// a busy link is not stuck behind them. It is one stream and one writer, so a lane is only a queue: each lane keeps its
// own order, no frame is dropped or merged, and the writer is given at most LANE_WINDOW_BYTES at a time, which is all
// a control frame can wait behind. A second stream was not used: the library does not say whether two streams of one
// session share a send queue, and a second stream would need its own hello, accept and read loop on both ends.

export const LINK_FRAME_BYTES = 4 * 1024 * 1024;
/** The first frame of a link is a hello, so a stranger gets this much buffer until it has sent one. */
export const LINK_FIRST_FRAME_BYTES = 8 * 1024;
/** The largest datagram a link sends. The same cap holds on the loopback link; the path may allow less. */
export const LINK_DATAGRAM_BYTES = 1200;
/** How long a new session may take to open its stream (M1: before the hello, a stranger is held to about 1 s). */
export const STREAM_WAIT_MS = 1000;
const DIAL_TIMEOUT_MS = 5000;
/**
 * The bytes the lane writer hands to the stream at once (at least one frame). The rest waits in the lanes, where a
 * control frame passes it. A frame is never split, so a control frame can wait behind one whole bulk frame.
 */
export const LANE_WINDOW_BYTES = 256 * 1024;
/** A peer that stays connected but stops reading is cut off once this many max-size frames are waiting. */
const BACKLOG_FRAMES = 4;
/** Sessions the listener holds at once, every kind. */
const MAX_SESSIONS = 64;
/** Sessions from one source address that have not yet said hello, at once (M1). */
export const PRE_HELLO_PER_SOURCE = 4;
/** Sessions that have not yet said hello, in all: half the listener's, so the links that are up keep the rest. */
export const PRE_HELLO_MAX = MAX_SESSIONS / 2;

export interface WebTransportLinksOptions {
  /** The interface the listener binds (NODE_LINK_BIND_HOST). Default 0.0.0.0. */
  hostname?: string;
  port: number;
  certPem: string;
  keyPem: string;
  maxFrameSize?: number;
  /** The largest first frame accepted from a peer; after it, `maxFrameSize` applies. */
  firstFrameBytes?: number;
  dialTimeoutMs?: number;
  /** How long a new session may take to open its stream. */
  streamWaitMs?: number;
  /**
   * The source address of an incoming session, or null when it cannot be told. webtransport-bun 0.1.6 gives a
   * session no peer address (its IncomingSession has only path, authority, headers and protocols), so by default
   * every session is null: the per-source cap and the known-address places of PreHelloGate wait for a library that
   * says, and the oldest-stranger eviction is what holds meanwhile.
   */
  sourceOf?: (session: WebTransportServerSession, request: WebTransportSessionRequest | undefined) => string | null;
  /** The addresses of the known nodes (their NodeInfo): a session from one keeps its place before the hello. */
  knownSources?: () => Iterable<string>;
  preHelloPerSource?: number;
  preHelloMax?: number;
}

export interface PreHelloSlot {
  /** The session said hello, or ended: its place is free. A second call does nothing. */
  release(): void;
}

interface PreHelloEntry {
  source: string | null;
  known: boolean;
  evict: () => void;
}

/**
 * Holds the sessions that have not yet said hello to a limit (M1), so idle strangers cannot fill the listener:
 * - at most `perSource` from one source address: one more is refused;
 * - at most `max` in all. When full, the oldest one from an address that is not a known node's is closed to make
 *   room: a stranger that idles loses its place to the next comer, so it cannot keep a peer's redial out. A known
 *   node's session is never put out for a stranger. A newcomer is refused only when every place is a known node's.
 * A session whose source cannot be told (null) has no per-source cap and is never a known node's.
 */
export class PreHelloGate {
  // Insertion order is age: the first one not known is the one to put out.
  private readonly pending = new Set<PreHelloEntry>();

  constructor(private readonly perSource = PRE_HELLO_PER_SOURCE, private readonly max = PRE_HELLO_MAX) {}

  /** A place for a new session, or null when it is refused. `evict` closes it, should a newer one need its place. */
  admit(source: string | null, known: boolean, evict: () => void): PreHelloSlot | null {
    if (source !== null) {
      let same = 0;
      for (const entry of this.pending) if (entry.source === source) same++;
      if (same >= this.perSource) return null;
    }
    if (this.pending.size >= this.max) {
      let oldest: PreHelloEntry | null = null;
      for (const entry of this.pending) {
        if (!entry.known) {
          oldest = entry;
          break;
        }
      }
      if (!oldest) return null;
      this.pending.delete(oldest);
      try {
        oldest.evict();
      } catch (error) {
        log.debug(`[Links] Closing a session for a newer one failed: ${messageOf(error)}`);
      }
    }
    const entry: PreHelloEntry = { source, known, evict };
    this.pending.add(entry);
    return { release: () => { this.pending.delete(entry); } };
  }

  /** Sessions waiting for their hello now. */
  get size(): number {
    return this.pending.size;
  }
}

class FrameQueue {
  private items: Uint8Array[] = [];
  private head = 0;
  get length(): number {
    return this.items.length - this.head;
  }
  push(frame: Uint8Array): void {
    this.items.push(frame);
  }
  shift(): Uint8Array | undefined {
    const frame = this.items[this.head];
    if (frame === undefined) return undefined;
    this.head++;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return frame;
  }
  peek(): Uint8Array | undefined {
    return this.items[this.head];
  }
  clear(): void {
    this.items = [];
    this.head = 0;
  }
}

/**
 * The write side of a link's stream: control frames before bulk frames, each lane in the order pushed. At most
 * `windowBytes` are with the stream's writer at once (one frame at least), so a control frame waits behind what the
 * writer already holds and nothing more. `write` takes a frame and settles when the stream has taken it in; a
 * failed write ends the writer and is reported once through `failed`.
 */
export class LaneWriter {
  private readonly control = new FrameQueue();
  private readonly bulk = new FrameQueue();
  private inFlight = 0;
  private queued = 0;
  private stopped = false;

  constructor(
    private readonly write: (frame: Uint8Array) => Promise<void>,
    private readonly failed: (error: unknown) => void,
    private readonly windowBytes = LANE_WINDOW_BYTES,
  ) {}

  /** The bytes pushed and not yet taken by the stream: waiting in a lane, or with the writer. */
  get backlog(): number {
    return this.queued;
  }

  push(frame: Uint8Array, control: boolean): void {
    if (this.stopped) return;
    this.queued += frame.length;
    (control ? this.control : this.bulk).push(frame);
    this.pump();
  }

  /** No more frames go out; the ones waiting are dropped (the channel is closed). */
  stop(): void {
    this.stopped = true;
    this.control.clear();
    this.bulk.clear();
  }

  private pump(): void {
    while (!this.stopped) {
      const lane = this.control.length > 0 ? this.control : this.bulk;
      const next = lane.peek();
      if (!next) return;
      if (this.inFlight > 0 && this.inFlight + next.length > this.windowBytes) return;
      lane.shift();
      this.inFlight += next.length;
      let writing: Promise<void>;
      try {
        writing = this.write(next);
      } catch (error) {
        writing = Promise.reject(error);
      }
      writing.then(
        () => {
          this.inFlight -= next.length;
          this.queued -= next.length;
          this.pump();
        },
        (error) => {
          // Several writes may be with the stream at once: the first failure ends the writer, and is reported once.
          if (this.stopped) return;
          this.stop();
          this.failed(error);
        },
      );
    }
  }
}

// A read fails or ends a moment before the session reports why it closed. The session's reason is
// the useful one, so a failed read waits this long for it before giving its own.
const REASON_WAIT_MS = 250;

const messageOf = (error: unknown): string => String((error as any)?.message ?? error);

/**
 * Frames off a stream. The first one is held to `firstFrameBytes`, so a peer that has not yet said
 * hello cannot make this node buffer megabytes; once it is complete the limit rises to `maxFrameSize`.
 * The first frame is cut out of the stream by its own header, because the bytes behind it may already
 * be in the same chunk and belong to the larger limit.
 */
export class LinkFrameReader {
  private readonly decoder: FrameDecoder;
  private readonly header = new Uint8Array(4);
  private headerBytes = 0;
  private firstEnd = 0;
  private received = 0;
  private raised = false;

  constructor(private readonly maxFrameSize: number, firstFrameBytes: number) {
    this.decoder = new FrameDecoder(Math.min(firstFrameBytes, maxFrameSize));
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let rest = chunk;
    while (rest.length > 0 && !this.decoder.isOverflowed()) {
      if (this.raised) {
        // A loop, not a spread: a chunk of many tiny frames would overflow the argument list.
        for (const frame of this.decoder.push(rest)) frames.push(frame);
        break;
      }
      let take = rest.length;
      if (this.headerBytes < 4) {
        take = Math.min(take, 4 - this.headerBytes);
        this.header.set(rest.subarray(0, take), this.headerBytes);
        this.headerBytes += take;
        if (this.headerBytes === 4) this.firstEnd = 4 + new DataView(this.header.buffer).getUint32(0, true);
      } else {
        take = Math.min(take, this.firstEnd - this.received);
      }
      const out = this.decoder.push(rest.subarray(0, take));
      this.received += take;
      rest = rest.subarray(take);
      for (const frame of out) frames.push(frame);
      if (out.length > 0) {
        this.decoder.setMaxFrameSize(this.maxFrameSize);
        this.raised = true;
      }
    }
    return frames;
  }

  isOverflowed(): boolean {
    return this.decoder.isOverflowed();
  }
}

class WtChannel implements LinkChannel {
  private handlers: LinkHandlers | null = null;
  private readonly writer: WebTransportWriter;
  private reading = false;
  private done = false;
  /** Why the channel ended, until `closed` has been delivered to the handlers. */
  private pendingClose: string | null = null;
  private readonly sessionEnded: Promise<void>;
  /** The lanes in front of the stream's writer; their backlog is the bytes it has not yet taken. */
  private readonly lanes: LaneWriter;

  constructor(
    private readonly session: WebTransport | WebTransportServerSession,
    private readonly stream: WebTransportBidirectionalStream,
    readonly remote: string,
    private readonly maxFrameSize: number,
    private readonly firstFrameBytes: number,
    private readonly onDone: (channel: WtChannel) => void,
    private readonly onAuthenticated: () => void = () => {},
  ) {
    this.writer = stream.writable.getWriter();
    this.lanes = new LaneWriter(
      (frame) => this.writer.write(frame),
      // As a read error does: the peer's own reason wins when it arrives in time.
      (error) => { void this.sessionReason().then(() => this.close(`write failed: ${messageOf(error)}`)); },
    );
    this.sessionEnded = session.closed.then(
      (info) => this.finish(info?.reason || "closed"),
      (error) => this.finish(messageOf(error)),
    );
  }

  /** The largest datagram this channel sends now: the link's cap, or less when the path allows less. */
  get maxDatagramBytes(): number {
    const path = Number(this.session.datagrams.maxDatagramSize);
    return Number.isFinite(path) && path > 0 ? Math.min(LINK_DATAGRAM_BYTES, path) : LINK_DATAGRAM_BYTES;
  }

  start(handlers: LinkHandlers): void {
    this.handlers = handlers;
    // A channel that ended before anyone listened still reports it, once.
    if (this.pendingClose !== null) {
      this.notifyClosed();
      return;
    }
    if (this.done || this.reading) return;
    this.reading = true;
    void this.readFrames();
    void this.readDatagrams();
  }

  send(payload: Uint8Array, control = false): boolean {
    if (this.done) return false;
    // The other end would overflow its decoder and drop the whole link.
    if (payload.length > this.maxFrameSize) {
      log.warn(`[Links] Refused a ${payload.length} byte frame to ${this.remote}: the limit is ${this.maxFrameSize}`);
      return false;
    }
    const frame = encodeFrame(payload);
    // The writer takes bytes only as fast as the peer reads. The library's own counters do not show
    // the wait (desiredSize counts chunks, queuedBytes only what the transport already holds), so
    // the channel counts the bytes itself.
    if (this.lanes.backlog + frame.length > BACKLOG_FRAMES * this.maxFrameSize) {
      this.close("send backlog");
      return false;
    }
    this.lanes.push(frame, control);
    return true;
  }

  authenticated(): void {
    this.onAuthenticated();
  }

  sendDatagram(data: Uint8Array): boolean {
    if (this.done || data.length > this.maxDatagramBytes) return false;
    try {
      return this.session.datagrams.sendSync(data);
    } catch {
      return false;
    }
  }

  close(reason: string): void {
    if (this.done) return;
    try {
      this.session.close({ closeCode: 0, reason });
    } catch (error) {
      log.debug(`[Links] Close of ${this.remote} failed: ${messageOf(error)}`);
    }
    // The caller's own `closed` comes on a later tick, as on the loopback link: a handler must not
    // run in the middle of the code that called close().
    this.finish(reason, true);
  }

  private finish(reason: string, later = false): void {
    if (this.done) return;
    this.done = true;
    this.pendingClose = reason;
    this.lanes.stop();
    this.onDone(this);
    if (!this.handlers) return;
    if (later) setImmediate(() => this.notifyClosed());
    else this.notifyClosed();
  }

  private notifyClosed(): void {
    if (this.pendingClose === null || !this.handlers) return;
    const reason = this.pendingClose;
    this.pendingClose = null;
    try {
      this.handlers.closed(reason);
    } catch (error) {
      log.error(`[Links] Close handler for ${this.remote} threw: ${messageOf(error)}`);
    }
  }

  private async readFrames(): Promise<void> {
    const reader = new LinkFrameReader(this.maxFrameSize, this.firstFrameBytes);
    try {
      for await (const chunk of this.stream.readable) {
        if (this.done) return;
        for (const frame of reader.push(chunk)) {
          // A handler may have closed the channel: what is left of the chunk is dropped.
          if (this.done) return;
          try {
            this.handlers?.frame(frame);
          } catch (error) {
            log.error(`[Links] Frame handler for ${this.remote} threw: ${messageOf(error)}`);
          }
        }
        if (reader.isOverflowed()) {
          this.close("frame too large");
          return;
        }
      }
      await this.sessionReason();
      this.close("stream ended");
    } catch (error) {
      await this.sessionReason();
      this.close(`read failed: ${messageOf(error)}`);
    }
  }

  private async sessionReason(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.sessionEnded, new Promise((resolve) => { timer = setTimeout(resolve, REASON_WAIT_MS); })]);
    clearTimeout(timer);
  }

  private async readDatagrams(): Promise<void> {
    try {
      const reader = this.session.datagrams.readable.getReader();
      while (!this.done) {
        const { value, done } = await reader.read();
        if (done || this.done) return;
        if (!value) continue;
        try {
          this.handlers?.datagram(value);
        } catch (error) {
          log.error(`[Links] Datagram handler for ${this.remote} threw: ${messageOf(error)}`);
        }
      }
    } catch {
      // The session closed: readFrames or `closed` reports it.
    }
  }
}

export class WebTransportLinks implements LinkTransport {
  private server: WebTransportServer | null = null;
  private channels = new Set<WtChannel>();
  private stopped = false;
  private listening = false;
  private readonly maxFrameSize: number;
  private readonly firstFrameBytes: number;
  private readonly gate: PreHelloGate;

  constructor(private readonly options: WebTransportLinksOptions) {
    this.maxFrameSize = options.maxFrameSize ?? LINK_FRAME_BYTES;
    this.firstFrameBytes = options.firstFrameBytes ?? LINK_FIRST_FRAME_BYTES;
    this.gate = new PreHelloGate(options.preHelloPerSource ?? PRE_HELLO_PER_SOURCE, options.preHelloMax ?? PRE_HELLO_MAX);
  }

  /** Sessions waiting for their hello now (tests). */
  get pendingSessions(): number {
    return this.gate.size;
  }

  async listen(accept: (channel: LinkChannel) => void): Promise<void> {
    if (this.server || this.listening) throw new Error("Links are already listening");
    this.listening = true;
    this.stopped = false;
    // serve() rejects on a port in use (os error 10048 on Windows): the caller decides what that means.
    let server: WebTransportServer;
    try {
      server = await serve({
      hostname: this.options.hostname ?? "0.0.0.0",
      port: this.options.port,
      cert: this.options.certPem,
      key: this.options.keyPem,
      maxSessions: MAX_SESSIONS,
      maxConcurrentStreams: 4,
      // Returning accepts the session and throwing would reject it, but who may link is decided
      // in-band (LINK_HELLO), so every session is accepted and the gate and stream wait below guard it.
      session: (session, request) => {
        this.acceptSession(session, request, accept).catch((error) => log.debug(`[Links] Session failed: ${messageOf(error)}`));
      },
      error: (error) => log.debug(`[Links] ${messageOf(error)}`),
      });
    } finally {
      this.listening = false;
    }
    // stop() ran while serve() was pending: it could not see this server, so stop it here.
    if (this.stopped) {
      await server.stop();
      throw new Error("Links are stopped");
    }
    this.server = server;
  }

  private isKnown(source: string): boolean {
    const known = this.options.knownSources?.();
    if (!known) return false;
    for (const address of known) if (address === source) return true;
    return false;
  }

  private async acceptSession(
    session: WebTransportServerSession, request: WebTransportSessionRequest | undefined, accept: (channel: LinkChannel) => void,
  ): Promise<void> {
    // Before anything is read: a session over the per-source cap is refused, and a full gate puts out its oldest stranger.
    const source = this.options.sourceOf?.(session, request) ?? null;
    const slot = this.gate.admit(source, source !== null && this.isKnown(source), () => {
      try { session.close({ closeCode: 1008, reason: "busy" }); } catch {}
    });
    if (!slot) {
      log.debug(`[Links] Session from ${source ?? "an unknown address"} refused: too many sessions waiting for a hello`);
      try { session.close({ closeCode: 1008, reason: "too many sessions" }); } catch {}
      return;
    }
    // However it ends (no stream, no hello, a close from either side), its place is free.
    session.closed.then(() => slot.release(), () => slot.release());
    const reader = session.incomingBidirectionalStreams.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.options.streamWaitMs ?? STREAM_WAIT_MS); });
    // A session that closes before it opens a stream ends or fails this read.
    const opened = reader.read().then((result) => (result.done ? null : result.value), () => null);
    const first = await Promise.race([opened, timedOut]);
    clearTimeout(timer);
    if (!first || this.stopped) {
      try { session.close({ closeCode: 1008, reason: first ? "stopping" : "no stream" }); } catch {}
      return;
    }
    const channel = new WtChannel(
      session, first, source ?? "inbound", this.maxFrameSize, this.firstFrameBytes, (done) => this.channels.delete(done), () => slot.release(),
    );
    this.channels.add(channel);
    try {
      accept(channel);
    } catch (error) {
      log.error(`[Links] Accepting a channel failed: ${messageOf(error)}`);
      channel.close("accept failed");
    }
  }

  async dial(peer: LinkPeerAddress): Promise<LinkChannel> {
    if (this.stopped) throw new Error("Links are stopped");
    const url = `https://${peer.host}:${peer.port}`;
    // With a hash the peer's certificate is pinned. Without one the host is verified against the
    // certificate's names, so it has to be among them.
    const session = peer.certHash
      ? new WebTransport(url, { serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(Buffer.from(peer.certHash, "base64")) }] })
      : new WebTransport(url);
    // Whichever of these loses the race below must not become an unhandled rejection.
    session.closed.catch(() => {});
    session.ready.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A peer that answers after this gives up keeps its QUIC session until its own no-stream wait (3 s) closes it.
      await Promise.race([
        session.ready,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer from ${peer.host}:${peer.port}`)), this.options.dialTimeoutMs ?? DIAL_TIMEOUT_MS); }),
      ]);
      // Without stream credit this fails at once instead of waiting for it.
      const stream = await session.createBidirectionalStream({ waitUntilAvailable: false });
      if (this.stopped) throw new Error("Links are stopped");
      const channel = new WtChannel(session, stream, `${peer.host}:${peer.port}`, this.maxFrameSize, this.firstFrameBytes, (done) => this.channels.delete(done));
      this.channels.add(channel);
      return channel;
    } catch (error) {
      try { session.close({ closeCode: 0, reason: "dial failed" }); } catch {}
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const channel of [...this.channels]) channel.close("stopping");
    const server = this.server;
    this.server = null;
    await server?.stop();
  }
}
