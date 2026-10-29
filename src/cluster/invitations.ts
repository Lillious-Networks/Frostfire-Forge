import playerCache from "../services/playermanager";
import type { ClusterStore } from "./store";

// Party, guild and friend invitations, kept until they are answered. Without a
// cluster they live in this process, as they lived on the inviter's cached
// player, and go when the inviter leaves this node's cache. In a cluster they
// are in the store, so the player who answers can be on another node than the
// one who asked. Trade requests are not kept here: both traders are on one node.

export interface Invitation {
  action: string;
  /** The inviter's player id (what the client answers with). */
  originator: string;
  originatorName: string;
  authorization: string;
  /** Who it was sent to. */
  target?: string;
}

/** Who sends word of players leaving this node's cache. */
interface LeavingPlayers {
  onRemove(listener: (key: string, value: any) => void): void;
}

const INVITE_TTL_MS = 5 * 60 * 1000;
const inviteKey = (authorization: string) => `cells:invite:${authorization}`;
const fromKey = (username: string) => `cells:invitesfrom:${username.toLowerCase()}`;

const parse = (raw: string | null): Invitation | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Invitation;
  } catch {
    return null;
  }
};

const matches = (invitation: Invitation, action: string, target?: string) =>
  invitation.action === action &&
  (target === undefined || String(invitation.target ?? "").toLowerCase() === target.toLowerCase());

export class Invitations {
  // Without a store: each invitation by its authorization, and the authorizations each player (lowercased) sent.
  private held = new Map<string, Invitation>();
  private sent = new Map<string, Set<string>>();

  constructor(private store: ClusterStore | null, players?: LeavingPlayers) {
    players?.onRemove((key, value) => this.forget(String(key), value?.username));
  }

  /** In a cluster: from now on invitations are kept in the store (null: in this process again). */
  attach(store: ClusterStore | null): void {
    this.store = store;
  }

  /** `ttlMs` applies in the store; without one an invitation lasts until answered or its inviter leaves. */
  async add(invitation: Invitation, ttlMs = INVITE_TTL_MS): Promise<void> {
    if (this.store) {
      await this.store.set(inviteKey(invitation.authorization), JSON.stringify(invitation), ttlMs);
      const from = fromKey(invitation.originatorName);
      await this.store.addToSet(from, invitation.authorization);
      // The list of what a player sent goes when the last invitation in it has expired, whether or not it was answered.
      await this.store.expire(from, ttlMs);
      return;
    }
    this.held.set(invitation.authorization, invitation);
    const name = invitation.originatorName.toLowerCase();
    if (!this.sent.has(name)) this.sent.set(name, new Set());
    this.sent.get(name)!.add(invitation.authorization);
  }

  /** The invitation, which is then gone: of two answers to it only one finds it. */
  async take(authorization: string): Promise<Invitation | null> {
    if (this.store) {
      const invitation = parse(await this.store.take(inviteKey(authorization)));
      if (invitation) await this.store.removeFromSet(fromKey(invitation.originatorName), authorization);
      return invitation;
    }
    const invitation = this.held.get(authorization);
    if (!invitation) return null;
    this.drop(invitation);
    return invitation;
  }

  /** An open invitation the player sent: of this action and, when given, to this target (any case). */
  async findFrom(originatorName: string, action: string, target?: string): Promise<Invitation | null> {
    if (this.store) {
      const key = fromKey(originatorName);
      for (const authorization of await this.store.members(key)) {
        const invitation = parse(await this.store.get(inviteKey(authorization)));
        // One that expired unanswered is still listed: it is cleared now.
        if (!invitation) await this.store.removeFromSet(key, authorization);
        else if (matches(invitation, action, target)) return invitation;
      }
      return null;
    }
    for (const authorization of this.sent.get(originatorName.toLowerCase()) ?? []) {
      const invitation = this.held.get(authorization);
      if (invitation && matches(invitation, action, target)) return invitation;
    }
    return null;
  }

  // Without a store: the invitations a session sent go with it. A newer session of the same name keeps its own.
  private forget(playerId: string, username: unknown): void {
    if (this.store) return;
    const names = typeof username === "string" ? [username.toLowerCase()] : [...this.sent.keys()];
    for (const name of names) {
      for (const authorization of [...(this.sent.get(name) ?? [])]) {
        const invitation = this.held.get(authorization);
        if (invitation && invitation.originator === playerId) this.drop(invitation);
      }
    }
  }

  private drop(invitation: Invitation): void {
    this.held.delete(invitation.authorization);
    const name = invitation.originatorName.toLowerCase();
    const sent = this.sent.get(name);
    sent?.delete(invitation.authorization);
    if (sent?.size === 0) this.sent.delete(name);
  }
}

export const invitations = new Invitations(null, playerCache);
