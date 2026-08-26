// MeshSocket: the raw UDP transport for server-to-server mesh links.
//
// One bound dgram socket per game server. Peers are identified by
// address:port; each peer gets its own ReliableChannel. Authentication is the
// mutual HELLO/HELLO_ACK handshake (HMAC-SHA256 over MESH_SECRET), validated
// against the shared cluster name. Unauthenticated peers can only progress the
// handshake - everything else is dropped before the app sees it.

import dgram from "node:dgram";
import log from "../modules/logger.ts";
import { ReliableChannel } from "./reliable_channel.ts";
import {
  MeshMessageType,
  decodeDatagram,
  buildHelloPayload,
  verifyHelloPayload,
  MESH_MAX_DATAGRAM,
} from "./protocol.ts";

export interface MeshSocketOptions {
  bindHost: string;
  port: number;
  secret: string;
  cluster: string;
  localServerId: string;
  serverIndex?: number;
  onMessage: (serverId: string, type: MeshMessageType, payload: Uint8Array) => void;
  onPeerUp?: (serverId: string, serverIndex: number) => void;
  onPeerDown?: (serverId: string) => void;
  retransmitDelayMs?: number;
  maxRetries?: number;
}

interface PeerEntry {
  key: string;
  address: string;
  port: number;
  serverId: string;
  serverIndex: number;
  authenticated: boolean;
  channel: ReliableChannel;
  lastHeardAt: number;
}

export class MeshSocket {
  private options: MeshSocketOptions;
  private socket: dgram.Socket | null = null;
  private peers = new Map<string, PeerEntry>();
  private byServerId = new Map<string, string>();
  private boundPort = 0;

  constructor(options: MeshSocketOptions) {
    this.options = options;
  }

  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      socket.on("error", (error: Error) => {
        log.error(`[Mesh] Socket error: ${error?.message || error}`);
        if (!this.boundPort) reject(error);
      });
      socket.on("message", (data: Uint8Array, rinfo: dgram.RemoteInfo) => {
        this.handleDatagram(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), rinfo);
      });
      socket.bind(this.options.port, this.options.bindHost, () => {
        try {
          const address = socket.address();
          this.boundPort = typeof address === "object" && address ? address.port : this.options.port;
          this.socket = socket;
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  stop(): void {
    for (const peer of this.peers.values()) {
      peer.channel.close();
    }
    this.peers.clear();
    this.byServerId.clear();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already closed
      }
      this.socket = null;
    }
  }

  connectTo(serverId: string, host: string, port: number): void {
    const key = `${host}:${port}`;
    let peer = this.peers.get(key);
    if (peer && peer.authenticated) return;

    if (!peer) {
      peer = this.createPeer(key, host, port, serverId);
    } else {
      peer.serverId = serverId;
    }
    this.sendHello(peer);
  }

  sendReliable(serverId: string, type: MeshMessageType, payload: Uint8Array): boolean {
    const peer = this.lookupPeer(serverId);
    if (!peer) return false;
    peer.channel.sendReliable(type, payload);
    return true;
  }

  sendUnreliable(serverId: string, type: MeshMessageType, payload: Uint8Array): boolean {
    const peer = this.lookupPeer(serverId);
    if (!peer) return false;
    peer.channel.sendUnreliable(type, payload);
    return true;
  }

  broadcastReliable(type: MeshMessageType, payload: Uint8Array): void {
    for (const peer of this.peers.values()) {
      if (peer.authenticated) peer.channel.sendReliable(type, payload);
    }
  }

  broadcastUnreliable(type: MeshMessageType, payload: Uint8Array): void {
    for (const peer of this.peers.values()) {
      if (peer.authenticated) peer.channel.sendUnreliable(type, payload);
    }
  }

  getConnectedServerIds(): string[] {
    return Array.from(this.byServerId.keys());
  }

  isConnected(serverId: string): boolean {
    return this.byServerId.has(serverId);
  }

  getPeerSilenceMs(serverId: string): number {
    const key = this.byServerId.get(serverId);
    if (!key) return 0;
    const peer = this.peers.get(key);
    if (!peer) return 0;
    return Date.now() - peer.lastHeardAt;
  }

  dropPeer(serverId: string): void {
    const key = this.byServerId.get(serverId);
    if (!key) return;
    const peer = this.peers.get(key);
    if (!peer) return;
    this.removePeer(peer, true);
  }

  private createPeer(key: string, address: string, port: number, serverId: string): PeerEntry {
    const peer: PeerEntry = {
      key,
      address,
      port,
      serverId,
      serverIndex: 0,
      authenticated: false,
      lastHeardAt: Date.now(),
      channel: new ReliableChannel({
        send: (data) => this.sendRaw(peer, data),
        onDeliver: (type, payload) => {
          // Handshake and keepalive frames stay internal; everything else
          // reaches the app.
          if (!peer.authenticated) return;
          if (
            type === MeshMessageType.HELLO ||
            type === MeshMessageType.HELLO_ACK ||
            type === MeshMessageType.HEARTBEAT
          ) {
            return;
          }
          this.options.onMessage(peer.serverId, type, payload);
        },
        onPeerTimeout: () => {
          if (!peer.authenticated) return;
          log.warn(`[Mesh] Peer ${peer.serverId} timed out (unacked reliable traffic)`);
          this.removePeer(peer, true);
        },
        retransmitDelayMs: this.options.retransmitDelayMs,
        maxRetries: this.options.maxRetries,
      }),
    };
    this.peers.set(key, peer);
    return peer;
  }

  private sendRaw(peer: PeerEntry, data: Uint8Array): void {
    if (!this.socket) return;
    try {
      this.socket.send(data, peer.port, peer.address);
    } catch (error: any) {
      log.debug(`[Mesh] Send to ${peer.serverId || peer.key} failed: ${error?.message || error}`);
    }
  }

  private sendHello(peer: PeerEntry): void {
    const hello = buildHelloPayload(
      this.options.localServerId,
      this.options.cluster,
      this.options.secret,
      this.options.serverIndex ?? 0
    );
    const payload = new TextEncoder().encode(JSON.stringify(hello));
    peer.channel.sendReliable(MeshMessageType.HELLO, payload);
  }

  private handleDatagram(data: Uint8Array, rinfo: dgram.RemoteInfo): void {
    if (data.length > MESH_MAX_DATAGRAM + 64) return;
    const decoded = decodeDatagram(data);
    if (!decoded) return;

    const key = `${rinfo.address}:${rinfo.port}`;
    let peer = this.peers.get(key);
    if (!peer) {
      peer = this.createPeer(key, rinfo.address, rinfo.port, "");
    }
    peer.lastHeardAt = Date.now();

    if (!peer.authenticated) {
      if (decoded.ackOnly) {
        peer.channel.handleIncoming(data, false);
        return;
      }
      if (decoded.type === MeshMessageType.HELLO) {
        this.acceptHello(peer, data, decoded.payload);
        return;
      }
      if (decoded.type === MeshMessageType.HELLO_ACK) {
        this.finishHello(peer, data, decoded.payload);
        return;
      }
      return;
    }

    peer.channel.handleIncoming(data);
  }

  private acceptHello(peer: PeerEntry, framed: Uint8Array, payload: Uint8Array): void {
    // Feed the HELLO through the channel so its seq is acked (the sender would
    // otherwise retransmit into its window forever), but suppress delivery.
    peer.channel.handleIncoming(framed, false);

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    const verification = verifyHelloPayload(parsed, this.options.secret, this.options.cluster);
    if (!verification.ok) {
      log.warn(`[Mesh] Rejected HELLO from ${peer.key}: ${verification.error}`);
      return;
    }

    peer.serverId = verification.serverId;
    peer.serverIndex = verification.serverIndex;
    this.bindServerId(peer);

    const reply = buildHelloPayload(
      this.options.localServerId,
      this.options.cluster,
      this.options.secret,
      this.options.serverIndex ?? 0
    );
    peer.channel.sendReliable(MeshMessageType.HELLO_ACK, new TextEncoder().encode(JSON.stringify(reply)));
    this.options.onPeerUp?.(peer.serverId, peer.serverIndex);
  }

  private finishHello(peer: PeerEntry, framed: Uint8Array, payload: Uint8Array): void {
    // Ack the dialed side's HELLO_ACK so its pending entry is released.
    peer.channel.handleIncoming(framed, false);

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    const verification = verifyHelloPayload(parsed, this.options.secret, this.options.cluster);
    if (!verification.ok) {
      log.warn(`[Mesh] Rejected HELLO_ACK from ${peer.key}: ${verification.error}`);
      return;
    }

    peer.serverId = verification.serverId;
    peer.serverIndex = verification.serverIndex;
    this.bindServerId(peer);
    this.options.onPeerUp?.(peer.serverId, peer.serverIndex);
  }

  private bindServerId(peer: PeerEntry): void {
    const existingKey = this.byServerId.get(peer.serverId);
    if (existingKey && existingKey !== peer.key) {
      // Same serverId reconnected from a new address: replace the stale link.
      const stale = this.peers.get(existingKey);
      if (stale) this.removePeer(stale, true);
    }
    this.byServerId.set(peer.serverId, peer.key);
    peer.authenticated = true;
    log.success(`[Mesh] Peer ${peer.serverId} authenticated (${peer.key})`);
  }

  private removePeer(peer: PeerEntry, notify: boolean): void {
    this.peers.delete(peer.key);
    if (this.byServerId.get(peer.serverId) === peer.key) {
      this.byServerId.delete(peer.serverId);
    }
    peer.channel.close();
    if (peer.authenticated && notify) {
      this.options.onPeerDown?.(peer.serverId);
    }
  }

  private lookupPeer(serverId: string): PeerEntry | null {
    const key = this.byServerId.get(serverId);
    if (!key) return null;
    const peer = this.peers.get(key);
    if (!peer || !peer.authenticated) return null;
    return peer;
  }
}
