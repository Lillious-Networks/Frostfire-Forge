// Reliable delivery over the mesh UDP link.
//
// Two independent seq spaces share the link: reliable seqs are acked and
// retransmitted; unreliable seqs are fire-and-forget telemetry (movers,
// heartbeats). Ordering is guaranteed only for reliable messages: they are
// delivered strictly in seq order, with out-of-order arrivals buffered until
// the gap fills (via retransmit).

import {
  MeshMessageType,
  decodeDatagram,
  decodeAck,
  encodeAck,
  encodeDatagram,
} from "./protocol.ts";

export interface ReliableChannelOptions {
  send: (data: Uint8Array) => void;
  onDeliver: (type: MeshMessageType, payload: Uint8Array) => void;
  onPeerTimeout?: () => void;
  retransmitDelayMs?: number;
  maxRetries?: number;
  maxPending?: number;
  ackDelayMs?: number;
}

interface PendingEntry {
  data: Uint8Array;
  sentAt: number;
  retries: number;
}

interface QueuedMessage {
  type: MeshMessageType;
  payload: Uint8Array;
}

export class ReliableChannel {
  private send: (data: Uint8Array) => void;
  private onDeliver: (type: MeshMessageType, payload: Uint8Array) => void;
  private onPeerTimeout?: () => void;

  private retransmitDelayMs: number;
  private maxRetries: number;
  private maxPending: number;
  private ackDelayMs: number;

  private reliableSeq = 0;
  private unreliableSeq = 0;
  private pending = new Map<number, PendingEntry>();
  private outboundQueue: QueuedMessage[] = [];

  private nextExpectedSeq = 0;
  private reorder = new Map<number, QueuedMessage>();
  private ackDirty = false;

  private retransmitTimer: ReturnType<typeof setInterval> | null = null;
  private ackTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: ReliableChannelOptions) {
    this.send = options.send;
    this.onDeliver = options.onDeliver;
    this.onPeerTimeout = options.onPeerTimeout;
    this.retransmitDelayMs = options.retransmitDelayMs ?? 200;
    this.maxRetries = options.maxRetries ?? 15;
    this.maxPending = options.maxPending ?? 256;
    this.ackDelayMs = options.ackDelayMs ?? 10;

    this.retransmitTimer = setInterval(() => this.sweepRetransmits(), this.retransmitDelayMs);
    this.ackTimer = setInterval(() => this.flushAck(), this.ackDelayMs);
    (this.retransmitTimer as any)?.unref?.();
    (this.ackTimer as any)?.unref?.();
  }

  sendReliable(type: MeshMessageType, payload: Uint8Array): void {
    if (this.closed) return;
    if (this.pending.size >= this.maxPending) {
      this.outboundQueue.push({ type, payload });
      return;
    }
    this.dispatchReliable(type, payload);
  }

  sendUnreliable(type: MeshMessageType, payload: Uint8Array): void {
    if (this.closed) return;
    const seq = this.unreliableSeq;
    this.unreliableSeq = (this.unreliableSeq + 1) & 0xffff;
    this.send(encodeDatagram(seq, false, type, payload));
  }

  /**
   * Process one inbound datagram. Reliable messages are acked and delivered
   * in seq order via onDeliver; unreliable messages are delivered immediately.
   * Set deliver=false to still ack/reorder without app delivery (used during
   * the HELLO handshake, which the socket consumes itself).
   */
  handleIncoming(data: Uint8Array, deliver: boolean = true): void {
    if (this.closed) return;
    const decoded = decodeDatagram(data);
    if (!decoded) return;

    if (decoded.ackOnly) {
      const ack = decodeAck(decoded.payload);
      if (ack) this.handleAck(ack.ackBase, ack.ackBitmap);
      return;
    }

    if (decoded.reliable) {
      this.markAck(decoded.seq);
      if (decoded.seq === this.nextExpectedSeq) {
        this.nextExpectedSeq = (this.nextExpectedSeq + 1) & 0xffff;
        if (deliver) this.onDeliver(decoded.type, decoded.payload);
        this.drainReorder(deliver);
      } else if (seqDistance(decoded.seq, this.nextExpectedSeq) > 0) {
        if (!this.reorder.has(decoded.seq)) {
          this.reorder.set(decoded.seq, { type: decoded.type, payload: decoded.payload });
        }
      }
      return;
    }

    if (deliver) this.onDeliver(decoded.type, decoded.payload);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get queuedCount(): number {
    return this.outboundQueue.length;
  }

  close(): void {
    this.closed = true;
    if (this.retransmitTimer) clearInterval(this.retransmitTimer);
    if (this.ackTimer) clearInterval(this.ackTimer);
    this.retransmitTimer = null;
    this.ackTimer = null;
    this.pending.clear();
    this.outboundQueue.length = 0;
    this.reorder.clear();
  }

  private dispatchReliable(type: MeshMessageType, payload: Uint8Array): void {
    const seq = this.reliableSeq;
    this.reliableSeq = (this.reliableSeq + 1) & 0xffff;
    const data = encodeDatagram(seq, true, type, payload);
    this.pending.set(seq, { data, sentAt: Date.now(), retries: 0 });
    this.send(data);
  }

  private handleAck(ackBase: number, ackBitmap: number): void {
    for (const [seq] of this.pending) {
      const offset = seqDistance(seq, ackBase);
      const acked =
        offset < 0 || (offset > 0 && offset <= 32 && (ackBitmap & (1 << (offset - 1))) !== 0);
      if (acked) this.pending.delete(seq);
    }
    this.flushOutbound();
  }

  private flushOutbound(): void {
    while (this.outboundQueue.length > 0 && this.pending.size < this.maxPending) {
      const message = this.outboundQueue.shift()!;
      this.dispatchReliable(message.type, message.payload);
    }
  }

  private markAck(_seq: number): void {
    // Any reliable arrival re-arms the ack flush: duplicates matter too, since
    // a retransmit means our previous ack may have been lost.
    this.ackDirty = true;
  }

  private flushAck(): void {
    if (this.closed) return;
    if (!this.ackDirty) return;
    this.ackDirty = false;

    let bitmap = 0;
    for (const seq of this.reorder.keys()) {
      const offset = seq - this.nextExpectedSeq - 1;
      if (offset >= 0 && offset < 32) {
        bitmap |= 1 << offset;
      }
    }
    this.send(encodeAck(this.nextExpectedSeq, bitmap));
  }

  private sweepRetransmits(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const [seq, entry] of this.pending) {
      if (now - entry.sentAt < this.retransmitDelayMs) continue;
      if (entry.retries >= this.maxRetries) {
        this.pending.delete(seq);
        this.onPeerTimeout?.();
        continue;
      }
      entry.retries++;
      entry.sentAt = now;
      this.send(entry.data);
    }
  }

  private drainReorder(deliver: boolean): void {
    while (this.reorder.has(this.nextExpectedSeq)) {
      const message = this.reorder.get(this.nextExpectedSeq)!;
      this.reorder.delete(this.nextExpectedSeq);
      this.nextExpectedSeq = (this.nextExpectedSeq + 1) & 0xffff;
      if (deliver) this.onDeliver(message.type, message.payload);
    }
  }
}

export function seqDistance(seq: number, base: number): number {
  // Signed distance with u16 wraparound: the sender never exceeds the window
  // (maxPending <= 0x8000), so distances are unambiguous. Exactly 0x8000 is
  // the midpoint - treat it as behind (negative).
  let d = seq - base;
  if (d >= 0x8000) d -= 0x10000;
  if (d < -0x8000) d += 0x10000;
  return d;
}
