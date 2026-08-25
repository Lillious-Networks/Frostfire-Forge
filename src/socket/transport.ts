import { createServer } from "@webtransport-bun/webtransport";
import crypto from "crypto";
import { FrameDecoder, encodeFrame, encodeCloseReason, decodeCloseReason } from "./framing.ts";
import { topicBus } from "./topics.ts";
import log from "../modules/logger.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let lastNativeLogMsg = "";
let lastNativeLogAt = 0;

const activeConnectionIds = new Set<string>();

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
const BATCH_ENTRY_BYTES = 9;

export const CLOSE_NORMAL = 0;
export const CLOSE_ABNORMAL = 1;

// Below the library's hard 64MB per-session queue limit: once a connection's
// queue passes this, sendFrame stops writing instead of letting the transport
// destroy the stream with E_QUEUE_FULL.
const MAX_SAFE_QUEUE_BYTES = 48 * 1024 * 1024;

export { encodeCloseReason, decodeCloseReason };

export interface TransportHandlers {
  validateConnectionToken: (
    token: string | null,
    timestamp: string | null,
    expiresAt: string | null,
    signature: string | null,
    origin: string | null
  ) => boolean;
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
  handlers: TransportHandlers;
}

export class TransportConnection {
  readonly session: any;
  data: any = {};
  readyState: number = 0;
  lastFrameReadAt: number = 0;
  private writer: any = null;
  private pendingWriteBytes: number = 0;
  private closedFlag: boolean = false;
  private closeHandled: boolean = false;
  private maxDatagramSize: number;
  private maxFrameSize: number;

  constructor(session: any, maxDatagramSize: number, maxFrameSize: number) {
    this.session = session;
    this.maxDatagramSize = maxDatagramSize;
    this.maxFrameSize = maxFrameSize;
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
      if (this.session?.metricsSnapshot) {
        queuedBytes = this.session.metricsSnapshot().queuedBytes || 0;
      }
    } catch {
      queuedBytes = 0;
    }

    this.lastMetricsAt = Date.now();
    this.lastQueuedBytes = queuedBytes;

    return queuedBytes;
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

  send(payload: Uint8Array): void {
    if (this.readyState !== 1 || !payload || payload.length === 0) return;

    if (MOVEMENT_HEADERS.has(payload[0])) {
      this.sendMovement(payload);
      return;
    }

    this.sendFrame(payload);
  }

  /**
   * Send a message as an unreliable datagram (fire-and-forget, no queueing).
   * Use for periodic, loss-tolerant messages (SERVER_TIME, TIME_SYNC replies)
   * that would otherwise contend for the reliable stream's ordering queue.
   */
  sendBestEffort(payload: Uint8Array): void {
    if (this.readyState !== 1 || !payload || payload.length === 0) return;
    if (payload.length > this.maxDatagramSize) {
      this.sendFrame(payload);
      return;
    }
    this.sendDatagram(payload);
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
    try {
      this.session.sendDatagram(payload).catch((error: any) => {
        if (this.readyState !== 3) {
          log.debug(`Datagram send failed: ${error?.message || error}`);
        }
      });
    } catch (error) {
      if (this.readyState !== 3) {
        log.debug(`Datagram send failed: ${error}`);
      }
    }
  }

  private sendFrame(payload: Uint8Array): void {
    if (payload.length > this.maxFrameSize) {
      log.warn(`Dropping oversized frame for connection ${this.data?.id}: ${payload.length} bytes`);
      return;
    }

    const writer = this.writer;
    if (!writer) return;

    // Last-resort tripwire: if the session's outbound queue is already near the
    // hard limit (64MB), the client is hopelessly behind - skip the write
    // instead of letting the transport reject it with E_QUEUE_FULL. The client
    // either recovers or its own watchdog reconnects.
    const queuedBytes = this.getFreshQueuedBytes();
    if (queuedBytes > MAX_SAFE_QUEUE_BYTES) {
      const now = Date.now();
      if (now - this.lastQueueFullLogAt > 10000) {
        this.lastQueueFullLogAt = now;
        log.warn(
          `[WebTransport] Stream queue full for connection ${this.data?.id} ` +
          `(${this.data?.useragent || "unknown agent"}) - ${Math.round(queuedBytes / 1024)}KB queued, dropping stream frames (client is not keeping up)`
        );
      }
      return;
    }

    const frame = encodeFrame(payload);
    this.pendingWriteBytes += frame.length;

    writer.write(frame)
      .then(() => {
        this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - frame.length);
      })
      .catch((error: any) => {
        this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - frame.length);
        if (this.readyState === 3) return;

        const message = String(error?.message || error);
        if (message.includes("E_QUEUE_FULL")) {
          const now = Date.now();
          if (now - this.lastQueueFullLogAt > 10000) {
            this.lastQueueFullLogAt = now;
            log.warn(
              `[WebTransport] Stream queue full for connection ${this.data?.id} ` +
              `(${this.data?.useragent || "unknown agent"}) - dropping stream frames (client is not keeping up)`
            );
          }
          return;
        }

        log.debug(`Frame write failed: ${message}`);
      });
  }

  close(code: number = 1000, reason: string = ""): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.readyState = 3;

    const wtCode = code === 1000 ? CLOSE_NORMAL : CLOSE_ABNORMAL;
    try {
      this.session.close({ code: wtCode, reason: encodeCloseReason(code, reason) });
    } catch (error: any) {
      log.debug(`[WebTransport] Session close failed: ${error?.message || error}`);
    }
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

export function startWebTransportServer(options: TransportServerOptions): any {
  return createServer({
    host: "0.0.0.0",
    port: options.port,
    tls: {
      certPem: options.certPem,
      keyPem: options.keyPem,
    },
    limits: {
      maxSessions: options.maxSessions,
      maxDatagramSize: options.maxDatagramSize,
      idleTimeoutMs: options.idleTimeoutMs,
      maxHandshakesInFlight: 2000,
      maxStreamsPerSessionBidi: 500,
      maxStreamsPerSessionUni: 500,
      maxQueuedBytesPerSession: 64 * 1024 * 1024,
      maxQueuedBytesGlobal: 4 * 1024 * 1024 * 1024,
      handshakeTimeoutMs: 15000,
    },
    rateLimits: options.rateLimits,
    log: (event: any) => {
      if (event.level !== "warn" && event.level !== "error") return;

      const msg = String(event?.msg || "");
      if (!msg || msg.includes("(redacted)")) return;

      // Throttle repeated identical warnings to once per 10 seconds.
      const now = Date.now();
      if (msg === lastNativeLogMsg && now - lastNativeLogAt < 10000) return;
      lastNativeLogMsg = msg;
      lastNativeLogAt = now;

      log.warn(`[WebTransport] ${msg}`);
    },
    onSession: (session: any) => {
      handleSession(session, options).catch((error: any) => {
        if (!isSessionClosedError(error)) {
          log.debug(`[WebTransport] Session handler failed: ${error?.message || error}`);
        }
      });
    },
  });
}

async function handleSession(session: any, options: TransportServerOptions): Promise<void> {
  const connection = new TransportConnection(session, options.maxDatagramSize, options.maxFrameSize);

  const authTimer = setTimeout(() => {
    if (!connection.data.id) {
      log.warn(`[WebTransport] Authentication timeout for session ${session?.id}`);
      connection.close(1008, "Authentication timeout");
    }
  }, options.authTimeoutMs);

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
    const decoder = new FrameDecoder(options.maxFrameSize);
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
          continue;
        }

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
      for await (const datagram of session.incomingDatagrams()) {
        if (!connection.data.id) continue;

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
  const valid = options.handlers.validateConnectionToken(
    data?.token ?? null,
    data?.timestamp ?? null,
    data?.expiresAt ?? null,
    data?.signature ?? null,
    data?.origin ?? null
  );

  if (!valid) {
    log.warn(`[WebTransport] Rejected connection with invalid token from ${connection.session?.peer?.ip || "unknown"}`);
    return false;
  }

  if (authTimer) clearTimeout(authTimer);

  let id: string;
  let attempts = 0;
  do {
    id = parseInt(crypto.randomBytes(4).toString("hex"), 16).toString();
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
  };

  connection.attachStream(writable);
  options.handlers.onOpen(connection);

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
