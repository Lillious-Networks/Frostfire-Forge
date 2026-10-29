import type { LinkChannel, LinkHandlers, LinkPeerAddress, LinkTransport } from "./linktransport";

// Node links inside one process, for tests. Delivery is asynchronous (setImmediate) like a socket.
// freeze() stands in for a node that died hard: nothing it sends or is sent arrives, and nobody is
// told the link closed. Only the ping timeout of links.ts can notice.

/** The real link refuses larger datagrams (Global Constraints: 1200 B). */
export const MAX_DATAGRAM_BYTES = 1200;

type LinkEvent = { kind: "frame" | "datagram"; data: Uint8Array } | { kind: "closed"; reason: string };

class LoopbackEnd implements LinkChannel {
  other!: LoopbackEnd;
  private handlers: LinkHandlers | null = null;
  private pending: LinkEvent[] = [];
  private pumping = false;
  private open = true;

  constructor(readonly remote: string, private readonly owner: LoopbackTransport, private readonly net: LoopbackNetwork) {}

  start(handlers: LinkHandlers): void {
    this.handlers = handlers;
    this.pump();
  }

  send(payload: Uint8Array): boolean {
    if (!this.open) return false;
    this.other.arrive({ kind: "frame", data: payload.slice() }, this.owner);
    return true;
  }

  sendDatagram(data: Uint8Array): boolean {
    if (!this.open || data.byteLength > MAX_DATAGRAM_BYTES) return false;
    if (this.net.dropsNext()) return true;
    this.other.arrive({ kind: "datagram", data: data.slice() }, this.owner);
    return true;
  }

  close(reason: string): void {
    if (!this.open) return;
    this.open = false;
    this.owner.forget(this);
    // After a local close, nothing queued is delivered except the closed event.
    this.pending = [{ kind: "closed", reason }];
    setImmediate(() => this.pump());
    this.other.arrive({ kind: "closed", reason }, this.owner);
  }

  /** From the other end. Lost when either side is frozen. */
  arrive(event: LinkEvent, from: LoopbackTransport): void {
    if (this.owner.frozen || from.frozen) return;
    setImmediate(() => {
      if (this.owner.frozen) return;
      if (event.kind === "closed") {
        if (!this.open) return;
        this.open = false;
        this.owner.forget(this);
        this.pending.push(event);
      } else if (this.open) {
        this.pending.push(event);
      }
      this.pump();
    });
  }

  /** Hand queued events to the handlers, in order. Never called from send or close, so no handler runs inside them. */
  private pump(): void {
    if (!this.handlers || this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.length > 0) this.dispatch(this.pending.shift()!);
    } finally {
      this.pumping = false;
    }
  }

  private dispatch(event: LinkEvent): void {
    const handlers = this.handlers!;
    if (event.kind === "closed") handlers.closed(event.reason);
    else if (event.kind === "frame") handlers.frame(event.data);
    else handlers.datagram(event.data);
  }
}

export class LoopbackTransport implements LinkTransport {
  frozen = false;
  private accept: ((channel: LinkChannel) => void) | null = null;
  private channels = new Set<LoopbackEnd>();

  constructor(private readonly net: LoopbackNetwork, readonly address: string) {}

  async listen(accept: (channel: LinkChannel) => void): Promise<void> {
    this.accept = accept;
    this.net.listeners.set(this.address, this);
  }

  async dial(peer: LinkPeerAddress): Promise<LinkChannel> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const server = this.net.listeners.get(`${peer.host}:${peer.port}`);
    if (!server || !server.accept || server.frozen || this.frozen) throw new Error(`loopback: nothing answers at ${peer.host}:${peer.port}`);
    const mine = new LoopbackEnd(server.address, this, this.net);
    const theirs = new LoopbackEnd(this.address, server, this.net);
    mine.other = theirs;
    theirs.other = mine;
    this.channels.add(mine);
    server.channels.add(theirs);
    try {
      server.accept(theirs);
    } catch (error) {
      mine.close("accept failed");
      theirs.close("accept failed");
      throw error;
    }
    return mine;
  }

  async stop(): Promise<void> {
    // A newer transport may have taken this address since; only unregister ourselves.
    if (this.net.listeners.get(this.address) === this) this.net.listeners.delete(this.address);
    this.accept = null;
    for (const channel of [...this.channels]) channel.close("stopped");
  }

  freeze(): void { this.frozen = true; }
  unfreeze(): void { this.frozen = false; }

  forget(channel: LoopbackEnd): void {
    this.channels.delete(channel);
  }
}

export class LoopbackNetwork {
  readonly listeners = new Map<string, LoopbackTransport>();
  /** Drop every n-th datagram sent on this network; 0 drops none. */
  datagramLoss = 0;
  private datagrams = 0;

  transport(host: string, port: number): LoopbackTransport {
    return new LoopbackTransport(this, `${host}:${port}`);
  }

  dropsNext(): boolean {
    this.datagrams++;
    return this.datagramLoss > 0 && this.datagrams % this.datagramLoss === 0;
  }
}
