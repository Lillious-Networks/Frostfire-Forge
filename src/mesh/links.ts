// MeshLinks: connection manager over the mesh UDP transport.
//
// Maintains the desired peer set (static config + gateway-provided list),
// performs the HELLO handshake via MeshSocket, keeps links alive with
// heartbeats, detects dead peers, and reconnects with exponential backoff.

import { MeshSocket } from "./udp.ts";
import { MeshMessageType } from "./protocol.ts";
import { learnPeerIndex, forgetPeerIndex } from "./regions.ts";
import log from "../modules/logger.ts";

export interface MeshPeerDescriptor {
  serverId: string;
  host: string;
  port: number;
}

export interface MeshLinksOptions {
  enabled: boolean;
  bindHost: string;
  port: number;
  cluster: string;
  secret: string;
  localServerId: string;
  serverIndex?: number;
  heartbeatIntervalMs?: number;
  peerTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  retransmitDelayMs?: number;
  maxRetries?: number;
}

type MessageHandler = (serverId: string, type: MeshMessageType, payload: Uint8Array) => void;
type PeerHandler = (serverId: string) => void;

export class MeshLinks {
  readonly enabled: boolean;
  private options: MeshLinksOptions;
  private socket: MeshSocket | null = null;
  private desiredPeers = new Map<string, MeshPeerDescriptor>();
  private reconnectDelays = new Map<string, number>();
  private nextConnectAt = new Map<string, number>();
  private messageHandlers: MessageHandler[] = [];
  private peerUpHandlers: PeerHandler[] = [];
  private peerDownHandlers: PeerHandler[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(options: MeshLinksOptions) {
    this.options = options;
    this.enabled = options.enabled;
  }

  async start(): Promise<void> {
    if (!this.enabled || this.started) return;
    this.started = true;

    const { secret, cluster, localServerId } = this.options;
    if (!secret) {
      throw new Error("Mesh is enabled but no MESH_SECRET is configured");
    }
    if (!cluster) {
      throw new Error("Mesh is enabled but no MESH_CLUSTER is configured");
    }

    this.socket = new MeshSocket({
      bindHost: this.options.bindHost,
      port: this.options.port,
      secret,
      cluster,
      localServerId,
      serverIndex: this.options.serverIndex ?? 0,
      onMessage: (serverId, type, payload) => {
        for (const handler of this.messageHandlers) {
          try {
            handler(serverId, type, payload);
          } catch (error: any) {
            console.error(`[Mesh] Message handler failed: ${error?.message || error}`);
          }
        }
      },
      onPeerUp: (serverId, serverIndex) => {
        learnPeerIndex(serverId, serverIndex);
        this.reconnectDelays.delete(serverId);
        this.nextConnectAt.delete(serverId);
        for (const handler of this.peerUpHandlers) {
          try {
            handler(serverId);
          } catch (error: any) {
            console.error(`[Mesh] Peer-up handler failed: ${error?.message || error}`);
          }
        }
      },
      onPeerDown: (serverId) => {
        forgetPeerIndex(serverId);
        for (const handler of this.peerDownHandlers) {
          try {
            handler(serverId);
          } catch (error: any) {
            console.error(`[Mesh] Peer-down handler failed: ${error?.message || error}`);
          }
        }
      },
      retransmitDelayMs: this.options.retransmitDelayMs,
      maxRetries: this.options.maxRetries,
    });

    await this.socket.start();

    const heartbeatMs = this.options.heartbeatIntervalMs ?? 1000;
    this.heartbeatTimer = setInterval(() => this.tick(), heartbeatMs);
    (this.heartbeatTimer as any)?.unref?.();

    this.tick();
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.socket?.stop();
    this.socket = null;
    this.desiredPeers.clear();
    this.reconnectDelays.clear();
    this.nextConnectAt.clear();
    this.started = false;
  }

  get port(): number {
    return this.socket ? this.socket.port : 0;
  }

  setPeerList(peers: MeshPeerDescriptor[]): void {
    const next = new Map<string, MeshPeerDescriptor>();
    for (const peer of peers) {
      if (!peer.serverId || !peer.host || !peer.port) continue;
      if (peer.serverId === this.options.localServerId) continue;
      next.set(peer.serverId, peer);
    }
    this.desiredPeers = next;
    this.tick();
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onPeerUp(handler: PeerHandler): void {
    this.peerUpHandlers.push(handler);
  }

  onPeerDown(handler: PeerHandler): void {
    this.peerDownHandlers.push(handler);
  }

  sendToServer(serverId: string, type: MeshMessageType, payload: Uint8Array, reliable: boolean = true): boolean {
    if (!this.socket) return false;
    return reliable
      ? this.socket.sendReliable(serverId, type, payload)
      : this.socket.sendUnreliable(serverId, type, payload);
  }

  broadcast(type: MeshMessageType, payload: Uint8Array, reliable: boolean = true): void {
    if (!this.socket) return;
    if (reliable) {
      this.socket.broadcastReliable(type, payload);
    } else {
      this.socket.broadcastUnreliable(type, payload);
    }
  }

  getConnectedServerIds(): string[] {
    return this.socket ? this.socket.getConnectedServerIds() : [];
  }

  isConnected(serverId: string): boolean {
    return this.socket ? this.socket.isConnected(serverId) : false;
  }

  getDesiredServerIds(): string[] {
    return Array.from(this.desiredPeers.keys());
  }

  private tick(): void {
    if (!this.socket || !this.started) return;

    const now = Date.now();
    const peerTimeoutMs = this.options.peerTimeoutMs ?? 5000;

    for (const serverId of this.socket.getConnectedServerIds()) {
      const silence = this.socket.getPeerSilenceMs(serverId);
      if (silence > peerTimeoutMs) {
        log.warn(`[Mesh] Peer ${serverId} silent for ${silence}ms, dropping link`);
        this.socket.dropPeer(serverId);
        this.scheduleReconnect(serverId, now);
        continue;
      }
      this.socket.sendUnreliable(serverId, MeshMessageType.HEARTBEAT, EMPTY_PAYLOAD);
    }

    for (const [serverId, descriptor] of this.desiredPeers) {
      if (this.socket.isConnected(serverId)) continue;
      const nextAt = this.nextConnectAt.get(serverId) ?? 0;
      if (now < nextAt) continue;
      this.socket.connectTo(descriptor.serverId, descriptor.host, descriptor.port);
      this.scheduleReconnect(serverId, now);
    }
  }

  private scheduleReconnect(serverId: string, now: number): void {
    const current = this.reconnectDelays.get(serverId) ?? 0;
    const base = this.options.reconnectBaseDelayMs ?? 2000;
    const max = this.options.reconnectMaxDelayMs ?? 30000;
    const next = current === 0 ? base : Math.min(current * 2, max);
    this.reconnectDelays.set(serverId, next);
    this.nextConnectAt.set(serverId, now + next);
  }
}

const EMPTY_PAYLOAD = new Uint8Array(0);
