import log from "../modules/logger";
import playerCache from "../services/playermanager";
import type { ClusterBus } from "./bus";
import type { PlayerDirectory } from "./directory";
import { MAX_FORWARD_HOPS } from "./linkcalls";
import { storeHealth, type StoreGate } from "./health";

// Reaching a player wherever they are: on this node, packets go straight to
// their connection; on another node (cluster mode), they go there over the
// bus. Without a cluster only this node's players can be reached, as before.
// Actions are for what has to happen to the player object itself (a party id
// cleared, a kick): they run on the node that holds the player.

export interface LocalPlayers {
  get(key: string): any;
  getByUsername(username: string): any;
  list(): Record<string, any>;
}

type Action = (player: any, args: any) => void | Promise<void>;

/** The node a player who just left this node went to, or null (cells phase 6 forwarding). */
export type Forwarder = (username: string) => string | null;

const toWire = (packets: Uint8Array[]) => packets.map((p) => Buffer.from(p).toString("base64"));
const fromWire = (packets: unknown): Uint8Array[] =>
  Array.isArray(packets) ? packets.map((p) => new Uint8Array(Buffer.from(String(p), "base64"))) : [];

/** How many times a bus message was passed on: `hops`, or 1 for the old `forwarded: true`, else 0. */
export function hopsOf(data: any): number {
  const hops = Number(data?.hops);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  return data?.forwarded === true ? 1 : 0;
}

function sendTo(player: any, packets: Uint8Array[], bestEffort: boolean): boolean {
  const wt = player?.wt;
  if (!wt || wt.readyState !== 1) return false;
  try {
    for (const packet of packets) {
      if (bestEffort && typeof wt.sendBestEffort === "function") wt.sendBestEffort(packet);
      else wt.send(packet);
    }
  } catch (error) {
    log.debug(`Delivery to ${player?.username} failed: ${error}`);
  }
  return true;
}

/** How long a delivery, an action or a broadcast to another node waits for a cluster store that is down (ms). */
export const DELIVERY_HOLD_MS = 10_000;
/** The most deliveries waiting at once: past it one fails at once, as it did before the hold. */
export const MAX_HELD_DELIVERIES = 1_000;

export interface DeliveryOptions {
  /** The store's health. The node's (health.ts) unless a test gives another. */
  health?: StoreGate;
  holdMs?: number;
  maxHeld?: number;
}

export class Delivery {
  private bus: ClusterBus | null = null;
  private directory: PlayerDirectory | null = null;
  private actions = new Map<string, Action>();
  // What an action carried, for the warning when it reaches no player (a share sent with no answer, say).
  private lostNotes = new Map<string, (args: any) => string>();
  private forwarder: Forwarder | null = null;

  private readonly health: StoreGate;
  private readonly holdMs: number;
  private readonly maxHeld: number;
  private held = 0;

  constructor(private players: LocalPlayers, opts: DeliveryOptions = {}) {
    this.health = opts.health ?? storeHealth;
    this.holdMs = opts.holdMs ?? DELIVERY_HOLD_MS;
    this.maxHeld = opts.maxHeld ?? MAX_HELD_DELIVERIES;
  }

  /**
   * Whether a message for another node may go now. With the cluster off, or the store up, at once. While the store
   * is down it waits for it, at most `holdMs`, and at most `maxHeld` messages wait at once (spec §7: delivery pauses).
   * False when it may not: the caller logs what is lost.
   */
  private async storeBack(): Promise<boolean> {
    if (!this.bus || this.health.up()) return true;
    if (this.held >= this.maxHeld) return false;
    this.held++;
    try {
      return await this.health.whenUp(this.holdMs);
    } finally {
      this.held--;
    }
  }

  attach(bus: ClusterBus, directory: PlayerDirectory): void {
    this.bus = bus;
    this.directory = directory;
    bus.on("deliver", async (data) => {
      const username = String(data?.username ?? "");
      const packets = fromWire(data?.packets);
      const local = this.players.getByUsername(username);
      if (local) {
        sendTo(local, packets, !!data?.bestEffort);
        return;
      }
      // Sent before the sender learned the player moved on: passed on, at most MAX_FORWARD_HOPS times in all.
      const hops = hopsOf(data);
      const next = await this.nextHop(username, hops, data?.epoch);
      if (next) {
        await this.passOn(next.peer, "deliver", { username, packets: toWire(packets), bestEffort: !!data?.bestEffort, hops: hops + 1, ...(next.epoch ? { epoch: next.epoch } : {}) });
      }
    });
    bus.on("broadcast", (data) => this.sendToAll(fromWire(data?.packets)));
    bus.on("player-action", async (data) => {
      const byName = !data?.playerId;
      const player = byName ? this.players.getByUsername(String(data?.username ?? "")) : this.players.get(String(data.playerId));
      if (player) {
        await this.runLocal(player, String(data?.action), data?.args);
        return;
      }
      // Only an action addressed by name follows the player: a session id names a session this node had.
      const hops = hopsOf(data);
      const next = byName ? await this.nextHop(String(data?.username ?? ""), hops, data?.epoch) : null;
      // The note is only for a log line: one that throws on odd arguments never stops the pass-on.
      let note = "";
      try {
        note = this.lostNotes.get(String(data?.action))?.(data?.args) ?? "";
      } catch {
        note = "";
      }
      if (next && await this.passOn(next.peer, "player-action", {
        username: data?.username, action: data?.action, args: data?.args, hops: hops + 1, ...(next.epoch ? { epoch: next.epoch } : {}),
      })) {
        // A directory pass-on goes to a node that may have died since its claim: what the action carried is named
        // here, so it is in the log if that node never runs it.
        if (next.directory) {
          log.warn(`Player action "${data?.action}" found no player ${data?.username} here, passed on to ${next.peer} by the directory${note ? `: ${note}` : ""}`);
        }
        return;
      }
      log.warn(`Player action "${data?.action}" found no player ${data?.username ?? data?.playerId} here${note ? `: ${note}` : ""}`);
    });
  }

  /** Back to reaching this node's players only (what tests that joined a cluster undo). */
  detach(): void {
    this.bus = null;
    this.directory = null;
  }

  /**
   * Where to pass a delivery or an action for a player who just left this node (the forward table, Task 13).
   * Answers the one set before, so a test can put it back.
   */
  setForwarder(fn: Forwarder | null): Forwarder | null {
    const previous = this.forwarder;
    this.forwarder = fn;
    return previous;
  }

  /** The node to pass a message for `username` on to, or null. Never this node. */
  private forwardPeer(username: string): string | null {
    const peer = this.forwarder?.(username) ?? null;
    return peer && this.bus && peer !== this.bus.nodeId ? peer : null;
  }

  /**
   * Where a message for `username` that found no player here goes next, or null. Never past MAX_FORWARD_HOPS in all.
   * First the forward table (the player just left this node); then the directory, when it names another node under
   * an epoch above the one the sender read (the player moved on after the sender looked). A message sent with no
   * epoch counts as read at 0. A loop between two nodes ends at the hop limit. `epoch` is what the next node counts
   * as read: the directory's, or on a forward-table hop the one this message came with, so the next node never
   * follows an entry older than what was already known. `directory`: the hop came from the directory.
   */
  private async nextHop(username: string, hops: number, sentEpoch: unknown): Promise<{ peer: string; epoch?: number; directory?: true } | null> {
    if (hops >= MAX_FORWARD_HOPS) return null;
    const sent = Number(sentEpoch);
    const seen = Number.isFinite(sent) && sent > 0 ? sent : 0;
    const peer = this.forwardPeer(username);
    if (peer) return seen ? { peer, epoch: seen } : { peer };
    if (!this.bus || !this.directory) return null;
    try {
      const entry = await this.directory.get(username);
      if (entry && entry.nodeId !== this.bus.nodeId && entry.epoch > seen) return { peer: entry.nodeId, epoch: entry.epoch, directory: true };
    } catch (error) {
      log.error(`Directory lookup of ${username} for a pass-on failed: ${error}`);
    }
    return null;
  }

  registerAction(name: string, action: Action, lostNote?: (args: any) => string): void {
    if (this.actions.has(name)) throw new Error(`Player action "${name}" is already registered`);
    this.actions.set(name, action);
    if (lostNote) this.lostNotes.set(name, lostNote);
  }

  /** Whether the player is online (here or, in a cluster, anywhere); the packets are sent if so. */
  async deliverToPlayer(username: string, packets: Uint8Array[], options: { bestEffort?: boolean } = {}): Promise<boolean> {
    const local = this.players.getByUsername(username);
    if (local) return sendTo(local, packets, !!options.bestEffort);
    const back = await this.storeBack();
    // The player may have logged in or arrived here while the delivery was held, and a local send needs no store.
    const arrived = this.players.getByUsername(username);
    if (arrived) return sendTo(arrived, packets, !!options.bestEffort);
    if (!back) {
      log.warn(`Delivery to ${username} was dropped: the cluster store is down`);
      return false;
    }
    const peer = this.forwardPeer(username);
    if (peer) return this.passOn(peer, "deliver", { username, packets: toWire(packets), bestEffort: !!options.bestEffort });
    try {
      const entry = await this.remoteEntry(username);
      if (!entry) return false;
      await this.bus!.toNode(entry.nodeId, "deliver", { username, packets: toWire(packets), bestEffort: !!options.bestEffort, epoch: entry.epoch });
      return true;
    } catch (error) {
      log.error(`Cluster delivery to ${username} failed: ${error}`);
      return false;
    }
  }

  async broadcastWorld(packets: Uint8Array[]): Promise<void> {
    if (!this.bus) {
      this.sendToAll(packets);
      return;
    }
    if (!(await this.storeBack())) {
      log.warn("A world broadcast reached this node's players only: the cluster store is down");
      this.sendToAll(packets);
      return;
    }
    try {
      await this.bus.toWorld("broadcast", { packets: toWire(packets) });
    } catch (error) {
      log.error(`Cluster broadcast failed: ${error}`);
      // The world did not get it, but this node's players still do.
      this.sendToAll(packets);
    }
  }

  /** Runs a registered action on the player's node. Whether the player is online. */
  async runOnPlayer(username: string, action: string, args?: unknown): Promise<boolean> {
    const local = this.players.getByUsername(username);
    if (local) {
      await this.runLocal(local, action, args);
      return true;
    }
    const back = await this.storeBack();
    // The player may have logged in or arrived here while the action was held, and a local run needs no store.
    const arrived = this.players.getByUsername(username);
    if (arrived) {
      await this.runLocal(arrived, action, args);
      return true;
    }
    if (!back) {
      // The note is only for a log line: one that throws on odd arguments never changes the answer.
      let note = "";
      try {
        note = this.lostNotes.get(action)?.(args) ?? "";
      } catch {
        note = "";
      }
      log.warn(`Action "${action}" for ${username} was dropped: the cluster store is down${note ? `: ${note}` : ""}`);
      return false;
    }
    const peer = this.forwardPeer(username);
    if (peer) return this.passOn(peer, "player-action", { username, action, args });
    try {
      const entry = await this.remoteEntry(username);
      if (!entry) return false;
      await this.bus!.toNode(entry.nodeId, "player-action", { username, action, args, epoch: entry.epoch });
      return true;
    } catch (error) {
      log.error(`Cluster action "${action}" for ${username} failed: ${error}`);
      return false;
    }
  }

  /** An action for one session on one node (an old session a newer login displaced). */
  async runOnPlayerAt(nodeId: string, playerId: string, action: string, args?: unknown): Promise<void> {
    if (!this.bus || nodeId === this.bus.nodeId) {
      const player = this.players.get(playerId);
      if (player) await this.runLocal(player, action, args);
      return;
    }
    if (!(await this.storeBack())) {
      log.warn(`Action "${action}" for session ${playerId} on ${nodeId} was dropped: the cluster store is down`);
      return;
    }
    try {
      await this.bus.toNode(nodeId, "player-action", { playerId, action, args });
    } catch (error) {
      log.error(`Cluster action "${action}" for session ${playerId} on ${nodeId} failed: ${error}`);
    }
  }

  async isOnline(username: string): Promise<boolean> {
    if (this.players.getByUsername(username)) return true;
    if (this.forwardPeer(username)) return true;
    const back = await this.storeBack();
    // The player may have logged in or arrived here while the lookup was held.
    if (this.players.getByUsername(username)) return true;
    if (!back) {
      log.warn(`Whether ${username} is online is not known: the cluster store is down`);
      return false;
    }
    try {
      return !!(await this.remoteEntry(username));
    } catch (error) {
      log.error(`Cluster lookup of ${username} failed: ${error}`);
      return false;
    }
  }

  /** Send a bus message on to `peer`. False when it could not be published (the caller logs what was lost). */
  private async passOn(peer: string, kind: "deliver" | "player-action", data: any): Promise<boolean> {
    try {
      await this.bus!.toNode(peer, kind, data);
      return true;
    } catch (error) {
      log.error(`Passing ${kind} for ${data?.username} on to ${peer} failed: ${error}`);
      return false;
    }
  }

  private async remoteEntry(username: string) {
    if (!this.bus || !this.directory) return null;
    const entry = await this.directory.get(username);
    return entry && entry.nodeId !== this.bus.nodeId ? entry : null;
  }

  private async runLocal(player: any, name: string, args: unknown): Promise<void> {
    const action = this.actions.get(name);
    if (!action) {
      log.warn(`Player action "${name}" is not registered`);
      return;
    }
    await action(player, args);
  }

  private sendToAll(packets: Uint8Array[]): void {
    for (const player of Object.values(this.players.list())) {
      if (player?.username) sendTo(player, packets, false);
    }
  }
}

export const delivery = new Delivery(playerCache);
export const deliverToPlayer = delivery.deliverToPlayer.bind(delivery);
export const broadcastWorld = delivery.broadcastWorld.bind(delivery);
export const runOnPlayer = delivery.runOnPlayer.bind(delivery);
export const registerPlayerAction = delivery.registerAction.bind(delivery);
export const isOnline = delivery.isOnline.bind(delivery);
