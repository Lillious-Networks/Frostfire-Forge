import crypto from "crypto";
import log from "../modules/logger";
import type { ClusterStore } from "./store";

// Messages between nodes that are few and small: social packets, commands to
// a player on another node, world broadcasts. Heavy traffic between
// neighbours (mirrors, handoffs) goes on node links instead (phase 4).
//
// Every envelope is signed with the bus key (clusterkeys.ts), which only the
// nodes and the coordinator hold: anything else that can reach Redis cannot
// send a command. An envelope is { kind, from, to, data, ts, nonce, sig }. The
// signature covers the other six, serialized with sorted keys. `to` is the
// node the envelope was sent to, or "*" for the world channel: an envelope
// copied onto another node's channel is not for that node. A receiver drops,
// before any handler sees it, an envelope whose signature is missing or wrong,
// whose `to` is not the channel it came on, whose ts is more than 10 s from its
// own clock or from before the bus started, or whose nonce it has already taken
// within that window.

export const WORLD_CHANNEL = "cells:world";
export const nodeChannel = (nodeId: string) => `cells:node:${nodeId}`;

/** How far an envelope's ts may be from the receiver's clock, either way. */
export const BUS_WINDOW_MS = 10_000;
/** The `to` of an envelope sent on the world channel. */
export const WORLD_TARGET = "*";
/**
 * How far before this bus started an envelope's ts may be. The nonce set starts empty, so a restarted node would
 * take a copy of an envelope it already took; one sent before it started is refused instead. Smaller than the window:
 * a fence as wide as the window would refuse nothing it does not already refuse. Synced clocks (NTP) are well inside.
 */
export const BUS_START_SKEW_MS = 2_000;
/** The most nonces kept. Pruning by age keeps far fewer at the bus's rate; this only bounds a burst. */
export const BUS_NONCES_MAX = 100_000;
/** At most one warning per this long about dropped envelopes; the rest are counted into the next one. */
const DROP_LOG_MS = 10_000;

// `unknown` return: a handler may end in an expression (a push, say); the result is only awaited.
type Handler = (data: any, from: string) => unknown;

export interface ClusterBusOptions {
  /** The clock for ts and the replay window. Tests move it. */
  now?: () => number;
}

/** JSON with every object's keys sorted, at every depth: the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  // undefined (a missing field) and anything JSON cannot hold read as null, as JSON.stringify writes them in an array.
  return JSON.stringify(value) ?? "null";
}

interface Signed {
  kind: unknown;
  from: unknown;
  to: unknown;
  data: unknown;
  ts: unknown;
  nonce: unknown;
}

/** HMAC-SHA256 over the canonical text of the six signed fields, as hex. */
export function busSignature(key: string, { kind, from, to, data, ts, nonce }: Signed): string {
  return crypto.createHmac("sha256", key).update(`cells-bus:${canonicalJson({ kind, from, to, data, ts, nonce })}`).digest("hex");
}

/**
 * The message to publish: the envelope, signed. `to` is the target node's id, or WORLD_TARGET on the world channel.
 * The fields are signed as a receiver will parse them.
 */
export function sealEnvelope(key: string, from: string, to: string, kind: string, data: unknown, ts: number): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  // Through JSON first, so what is signed is exactly what the receiver gets back (no undefined, no toJSON, no Map).
  const body = JSON.parse(JSON.stringify({ kind, from, to, data, ts, nonce }));
  return JSON.stringify({ ...body, sig: busSignature(key, body) });
}

/** Nonces of envelopes already taken, kept for twice the window: each envelope is good once. */
export class BusNonces {
  private used = new Map<string, number>();

  constructor(private readonly max = BUS_NONCES_MAX) {}

  /** Records the nonce. False when it was taken before. */
  claim(nonce: string, now: number): boolean {
    // Oldest first (insertion order): stop at the first one still inside the window.
    for (const [seen, at] of this.used) {
      if (now - at <= BUS_WINDOW_MS * 2 && this.used.size < this.max) break;
      this.used.delete(seen);
    }
    if (this.used.has(nonce)) return false;
    this.used.set(nonce, now);
    return true;
  }

  get size(): number {
    return this.used.size;
  }
}

export class ClusterBus {
  private handlers = new Map<string, Handler>();
  private readonly nonces = new BusNonces();
  private readonly now: () => number;
  private droppedLoggedAt = -Infinity;
  private droppedQuietly = 0;
  /** When start first ran (this bus's clock): an envelope sent well before it is refused. */
  private startedAt: number | null = null;

  constructor(private store: ClusterStore, readonly nodeId: string, private readonly key: string, options: ClusterBusOptions = {}) {
    // Never an unsigned bus: a node or coordinator without the key does not get one.
    if (!key) throw new Error("Cluster bus: no bus key (CLUSTER_LINK_SECRET)");
    this.now = options.now ?? Date.now;
  }

  // Per channel, the function the store calls: kept so stop can hand the same one back.
  private listening = new Map<string, (message: string) => void>();

  /** Listens on this node's channel and the world channel. A second call adds nothing. */
  async start(): Promise<void> {
    this.startedAt ??= this.now();
    for (const channel of [nodeChannel(this.nodeId), WORLD_CHANNEL]) {
      if (this.listening.has(channel)) continue;
      const listener = (message: string) => { void this.receive(message, channel); };
      this.listening.set(channel, listener);
      try {
        await this.store.subscribe(channel, listener);
      } catch (error) {
        this.listening.delete(channel);
        throw error;
      }
    }
  }

  /** Stops listening; handlers stay registered, so start may be called again. */
  async stop(): Promise<void> {
    const listening = [...this.listening];
    this.listening.clear();
    for (const [channel, listener] of listening) await this.store.unsubscribe(channel, listener);
  }

  on(kind: string, handler: Handler): void {
    if (this.handlers.has(kind)) throw new Error(`Cluster bus: "${kind}" already has a handler`);
    this.handlers.set(kind, handler);
  }

  toNode(nodeId: string, kind: string, data: unknown): Promise<void> {
    return this.store.publish(nodeChannel(nodeId), sealEnvelope(this.key, this.nodeId, nodeId, kind, data, this.now()));
  }

  /** To every node, this one included. */
  toWorld(kind: string, data: unknown): Promise<void> {
    return this.store.publish(WORLD_CHANNEL, sealEnvelope(this.key, this.nodeId, WORLD_TARGET, kind, data, this.now()));
  }

  /**
   * The envelope when it is signed, sent to the channel it came on, fresh and new; null (and a warning, at most one
   * per DROP_LOG_MS) otherwise.
   */
  private open(message: string, channel: string): { kind: string; from: string; data: unknown } | null {
    let envelope: any = null;
    try {
      envelope = JSON.parse(message);
    } catch {
      envelope = null;
    }
    // Only an object is a message: JSON that is null or a number is dropped like text that is not JSON.
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return this.drop("not a JSON object");
    const { kind, from, ts, nonce, sig } = envelope;
    if (typeof kind !== "string" || typeof from !== "string") return this.drop("no kind or sender");
    // Buffer.from(.., "hex") stops at the first bad pair, so a padded signature would still verify.
    if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return this.drop(`"${kind}" from ${from} is not signed`);
    if (typeof ts !== "number" || !Number.isFinite(ts) || typeof nonce !== "string" || nonce.length < 16 || nonce.length > 128) {
      return this.drop(`"${kind}" from ${from} has no ts or nonce`);
    }
    const expected = Buffer.from(busSignature(this.key, envelope), "hex");
    // Never log the key or the signature: the likely cause is enough to act on.
    if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), expected)) return this.drop(`"${kind}" from ${from} has a bad signature (wrong CLUSTER_LINK_SECRET?)`);
    // Signed for this channel: this node on its own channel, "*" on the world one. A copy moved to another channel is not.
    const target = channel === WORLD_CHANNEL ? WORLD_TARGET : channel === nodeChannel(this.nodeId) ? this.nodeId : null;
    if (target === null || envelope.to !== target) return this.drop(`"${kind}" from ${from} was not sent to this channel`);
    const now = this.now();
    if (Math.abs(now - ts) > BUS_WINDOW_MS) return this.drop(`"${kind}" from ${from} is ${Math.round((now - ts) / 1000)} s off this node's clock`);
    if (this.startedAt !== null && ts < this.startedAt - BUS_START_SKEW_MS) {
      return this.drop(`"${kind}" from ${from} was sent before this node started`);
    }
    // Last: a nonce is only taken for an envelope that is otherwise good, so junk cannot fill the set.
    if (!this.nonces.claim(nonce, now)) return this.drop(`"${kind}" from ${from} was a replay`);
    return { kind, from, data: envelope.data };
  }

  private drop(why: string): null {
    const now = this.now();
    if (now - this.droppedLoggedAt >= DROP_LOG_MS) {
      const more = this.droppedQuietly > 0 ? ` (and ${this.droppedQuietly} more since the last warning)` : "";
      log.warn(`Cluster bus: dropped a message: ${why}${more}`);
      this.droppedLoggedAt = now;
      this.droppedQuietly = 0;
    } else {
      this.droppedQuietly++;
    }
    return null;
  }

  private async receive(message: string, channel: string): Promise<void> {
    const envelope = this.open(message, channel);
    if (!envelope) return;
    const handler = this.handlers.get(envelope.kind);
    if (!handler) {
      log.debug(`Cluster bus: nothing handles "${envelope.kind}"`);
      return;
    }
    try {
      await handler(envelope.data, envelope.from);
    } catch (error) {
      log.error(`Cluster bus: "${envelope.kind}" from ${envelope.from} failed: ${error}`);
    }
  }
}
