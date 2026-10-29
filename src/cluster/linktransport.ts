// The transport under a node link, kept small so the loopback link (tests) and
// WebTransport (wtlinks.ts) are interchangeable. A channel is one session: one
// ordered, reliable stream of frames plus unreliable datagrams. Framing and
// authentication are above this layer (links.ts).

export interface LinkHandlers {
  /** One reliable frame, in the order it was sent. */
  frame(payload: Uint8Array): void;
  /** One unreliable datagram. It may be lost, and may arrive out of order. */
  datagram(data: Uint8Array): void;
  /** The channel is gone, for good. Fires once per channel on each end, including the end that called close(). */
  closed(reason: string): void;
}

export interface LinkChannel {
  /** The address of the node at the other end, as the dialler knows it. */
  readonly remote: string;
  /** Attach handlers. Anything that arrived before this call is delivered now, in order. */
  start(handlers: LinkHandlers): void;
  /**
   * Send one reliable frame. Returns false when the channel is closed, and nothing is sent. A `control` frame (a call,
   * its answer, a ping) may go out ahead of bulk frames still waiting on a channel that has lanes (wtlinks.ts); each
   * kind keeps its own order, and none is dropped. A channel with one lane (the loopback link) ignores the flag.
   */
  send(payload: Uint8Array, control?: boolean): boolean;
  /** Send one unreliable datagram. Returns false when it was not sent. A true result does not promise delivery. */
  sendDatagram(data: Uint8Array): boolean;
  /** Close the channel. Both ends' `closed` fire with the reason, the other side's unless it is frozen. The closer's own `closed` fires later, never inside close(). */
  close(reason: string): void;
  /**
   * The acceptor took this channel's LINK_HELLO: it is a peer's now, no longer a stranger's. A transport that
   * holds strangers to a limit (wtlinks.ts) frees its place. Optional: the loopback link has no such limit.
   */
  authenticated?(): void;
}

export interface LinkPeerAddress {
  /** Host name or address of the peer's link listener. */
  host: string;
  /** UDP port of the peer's link listener. */
  port: number;
  /** Hash of the peer's certificate for pinning. Empty when the transport does not pin. */
  certHash: string;
}

export interface LinkTransport {
  /** Start accepting channels. `accept` runs once per incoming channel, before any frame is delivered on it. */
  listen(accept: (channel: LinkChannel) => void): Promise<void>;
  /** Open a channel to a peer. Rejects when nothing answers, or the peer refuses. */
  dial(peer: LinkPeerAddress): Promise<LinkChannel>;
  /** Stop listening and close every channel this transport owns, each with a `closed` to its other side. */
  stop(): Promise<void>;
}

/** What the ghosts need of the links (NodeLinks implements it; tests may fake it). */
export interface LinkSender {
  /** This node's id. */
  readonly self: string;
  /** True while a live, authenticated link to `peer` is up. */
  isUp(peer: string): boolean;
  /** Send a reliable message of `kind` to `peer`. Returns false when no link is up, and nothing is sent. */
  send(peer: string, kind: string, data: unknown): boolean;
  /** Send an unreliable datagram to `peer`. Returns false when it was not sent. */
  sendDatagram(peer: string, data: Uint8Array): boolean;
  /** Handle every reliable message of `kind`, whichever peer sent it. */
  on(kind: string, handler: (data: any, from: string) => void): void;
  /** Handle every incoming datagram, whichever peer sent it. */
  onDatagram(handler: (data: Uint8Array, from: string) => void): void;
  /**
   * Run when a link to a peer comes up. It may run again without a peer-down in between, when a
   * new link replaces the old one (the peer may have restarted): treat every peer-up as a reset.
   */
  onPeerUp(handler: (peer: string) => void): void;
  /** Run when a link to a peer goes down: silence, a close, or the peer no longer wanted. Not on a replacement, and not on stop(). */
  onPeerDown(handler: (peer: string) => void): void;
}
