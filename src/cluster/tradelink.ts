// The two-player trade across a border (spec §4). A trade is held on the node of
// the player who asked for it (the host). The player who was asked may be on a
// neighbouring node (the partner's node). The host runs every rule of the trade,
// as for two players of its own: the asked player is read from their mirror, and
// their offer from the shared database. The partner's node only relays:
//
// - TP_ANSWER (call, partner's node to host): the asked player answered the invitation.
// - TP_UPDATE (call, partner's node to host): the asked player offered, accepted, cancelled or left.
// - TP_STATE (cast, host to partner's node): the trade as it stands for the asked player.
// - TP_CLOSED (cast, host to partner's node): the trade ended, and whether to reload their bags.
//
// Each trade carries a stamp, made by the partner's node for its TP_ANSWER and kept by both nodes while the
// trade lasts. A cast or an update that carries another stamp belongs to an earlier trade of the same two
// nodes and is dropped, so a late message cannot close or change a newer trade.
//
// Nothing is retried. An update that did not arrive is followed by one cancel, and the trade is let go here.
// A cancel that finds the trade being swapped is answered "settling": the swap goes on, so the partner's node
// keeps its host for a while (SETTLE_WAIT_MS) to take the end of the trade, which carries the right reload.
//
// A trade let go here because its host's node went down may still be swapped there: the player is marked
// unsettled (cluster/tradesettle.ts) before their bags are read again, so no write here puts back what they gave.
// While marked, they open and accept no trade across a border either way: its host would write their rows from the
// shared cache, which this node's mark does not fence.

import log from "../modules/logger";
import { linkCalls, type LinkCalls } from "./linkcalls";
import { tradeSettle, type TradeSettle } from "./tradesettle";

/** The answer to a trade invitation, sent by the node of the one who answered to the asker's node. */
export interface TradeAnswer {
  /** The asker, and their id on the host. */
  asker: string;
  askerId: string;
  authorization: string;
  /** The one who answered, on the node that sends this. */
  partner: string;
  partnerId: string;
  accepted: boolean;
  /** The partner's node's stamp for the trade this answer may open. Every cast and update of the trade carries it. */
  stamp?: string;
}
export type TradeOp = "offer" | "accept" | "cancel" | "leave";
export interface TradeUpdate {
  username: string;
  op: TradeOp;
  /** TRADE_OFFER's packet body, for "offer". */
  offer?: unknown;
  /** The trade's stamp. */
  stamp?: string;
}
export interface TradeReply {
  ok: boolean;
  /** What the asked player is told. */
  reason?: string;
  /** TP_ANSWER: a trade was opened. */
  opened?: boolean;
  /** TP_UPDATE: the host holds no trade of theirs. */
  gone?: boolean;
  /** TP_UPDATE: the trade is being swapped, and cannot be cancelled now. Its end is cast when the swap is done. */
  settling?: boolean;
  /** sendUpdate: the end of the trade arrived while it was waited for, and has been shown to the player. */
  closed?: boolean;
}
export interface TradeStateCast {
  username: string;
  /** The TRADE_STATE packet body (systems/trades.ts TradeView). */
  state: unknown;
  stamp?: string;
}
export interface TradeClosedCast {
  username: string;
  completed: boolean;
  message: string;
  /** The offers changed hands: the player's bags and coins are read again. */
  reload: boolean;
  stamp?: string;
}
export interface TradeLost {
  /**
   * host: this node holds the trade and `username` is the partner on `peer`.
   * partner: `username` is this node's player, whose trade `peer` held.
   */
  role: "host" | "partner";
  username: string;
  peer: string;
}
export interface TradeHandlers {
  /** Host: the asked player answered an invitation of a player of this node. */
  answer(body: TradeAnswer, from: string): Promise<TradeReply>;
  /** Host: the asked player changed the trade held here. */
  update(body: TradeUpdate, from: string): Promise<TradeReply>;
  /** Partner's node: the trade as it stands for its player. */
  state(body: TradeStateCast): void | Promise<void>;
  /** Partner's node: its player's trade ended. */
  closed(body: TradeClosedCast): void | Promise<void>;
  /** The link to `peer` went down with a trade across it. Task 14 ends the trade and reloads the bags. */
  lost?(body: TradeLost): void | Promise<void>;
}

/** How long (ms) the partner's node waits for the end of a trade that was being swapped when it let go of it. */
export const SETTLE_WAIT_MS = 30_000;
export const TRADE_UNREACHABLE = "The trade could not be reached. Your bags show what you hold now.";
/** Told to a player who answers or accepts a trade while a lost trade of theirs (or their partner's) is settling. */
export const TRADE_SETTLING = "A trade that was cut off is still being settled. Try again in a moment.";
const ANSWER_UNREACHABLE = "Unable to process invitation - user not found or has disconnected";
const NOT_TRADING = "You are not trading.";
const lower = (name: unknown) => String(name ?? "").toLowerCase();

/** Partner's node: the trade of one of its players held elsewhere. */
interface HostEntry {
  peer: string;
  stamp: string;
  /** The trade as its host last sent it (TP_STATE). */
  state?: unknown;
  /** How many updates of this trade are on their way to the host. */
  inflight?: number;
  /**
   * An accept of this trade was sent to the host (whether or not it arrived). Only then can the host swap it: the
   * host swaps once both players have accepted, and this player's accept reaches it only this way.
   */
  accepted?: boolean;
  /** How many accepts of this trade are on their way to the host (sent, and not yet answered). */
  acceptsInFlight?: number;
  /**
   * An accept of this trade was sent, and no TP_STATE has shown since whether it stands. Unlike `accepted` it is let
   * go: by a TP_STATE that arrives while no accept is on its way, and with the entry when the trade ends. The host
   * casts the state an accept made before it answers the accept, on the same ordered link, so a state that arrives
   * after the answer shows the accept, shows it taken back (an offer changed), or shows that it never stood (the host
   * refused it: "wait", or a lost trade settling). A refused accept casts no state of its own, so its record stays
   * until the host's next state, or the end of the trade: a leave meanwhile is marked without need, which costs only
   * a delay. A state that arrives while an accept is on its way may have been cast before the host read it, and lets
   * go of nothing.
   */
  acceptUnshown?: boolean;
}

/** Host: an asked player of a neighbouring node. */
interface PartnerEntry {
  peer: string;
  stamp: string;
  /** The player of this node who asked them, once the trade opened. */
  asker?: string;
}

export class TradeLink {
  /** Host: an asked player of a neighbouring node, their node, and the trade's stamp. */
  private partners = new Map<string, PartnerEntry>();
  /**
   * Partner's node: a player of this node, the node that holds their trade, and the trade's stamp. `inflight` is how
   * many updates of this trade are on their way to the host (sendUpdate tells the player how each ended). A count on
   * the trade, not a flag on the player: two quick actions are two updates in flight, and an update of an earlier
   * trade does not hide the loss of a newer one.
   */
  private hosts = new Map<string, HostEntry>();
  /** Partner's node: a player whose trade was being swapped, and the wait for its end. */
  private waiting = new Map<string, { host: HostEntry; end: (closed: boolean) => void }>();
  private handlers: TradeHandlers | null = null;

  constructor(
    private readonly calls: LinkCalls,
    private readonly settleWaitMs = SETTLE_WAIT_MS,
    private readonly fence: TradeSettle = tradeSettle,
  ) {
    calls.handle("TP_ANSWER", async (body: TradeAnswer, from) => {
      if (!this.handlers) return { ok: false, reason: ANSWER_UNREACHABLE };
      // A trade opened now would be swapped here, from rows of a marked player that may predate a lost swap.
      if (body?.accepted && (this.fence.unsettled(body.asker) || this.fence.unsettled(body.partner))) {
        log.info(`The answer of ${lower(body.partner)} to the trade invitation of ${lower(body.asker)} was refused: a lost trade is settling`);
        return { ok: false, reason: TRADE_SETTLING };
      }
      const reply = await this.handlers.answer(body, from);
      // The asker is kept with the partner, so that an accept of theirs is refused while the asker is marked.
      const partner = reply?.opened ? this.partners.get(lower(body.partner)) : undefined;
      if (partner && partner.peer === from) partner.asker = lower(body.asker);
      return reply;
    });
    calls.handle("TP_UPDATE", (body: TradeUpdate, from) => {
      // Only the node the asked player is on speaks for them.
      const partner = this.partners.get(lower(body?.username));
      if (!this.handlers || partner?.peer !== from || partner.stamp !== (body?.stamp ?? "")) {
        log.warn(`Trade update "${body?.op}" for ${lower(body?.username)} from ${from} refused: no trade of theirs is held here for that node`);
        return { ok: false, gone: true, reason: NOT_TRADING };
      }
      // An accept could start the swap here, which reads the rows of both players.
      if (body.op === "accept" && (this.fence.unsettled(body.username) || (partner.asker && this.fence.unsettled(partner.asker)))) {
        log.info(`The accept of ${lower(body.username)} from ${from} was refused: a lost trade is settling`);
        return { ok: false, reason: TRADE_SETTLING };
      }
      return this.handlers.update({ ...body, username: lower(body.username) }, from);
    });
    calls.onCast("TP_STATE", (body: TradeStateCast, from) => {
      if (!this.fromHost(lower(body?.username), from, body?.stamp)) {
        log.info(`The trade window of ${lower(body?.username)} from ${from} was dropped: that node holds no trade of theirs`);
        return;
      }
      // Kept, so that a player whose own action is refused here can be shown the trade as the host holds it again.
      const host = this.hosts.get(lower(body?.username))!;
      host.state = body.state;
      if (!host.acceptsInFlight) host.acceptUnshown = false;
      this.run(() => this.handlers?.state(body));
    });
    calls.onCast("TP_CLOSED", (body: TradeClosedCast, from) => {
      const name = lower(body?.username);
      if (!this.fromHost(name, from, body?.stamp)) {
        log.info(`The end of the trade of ${name} from ${from} was dropped: that node holds no trade of theirs`);
        return;
      }
      this.hosts.delete(name);
      // Whoever waits for this end is released once it has been shown and the bags are read again.
      void this.run(() => this.handlers?.closed(body)).then(() => this.waiting.get(name)?.end(true));
    });
    // A node that went down takes its trades with it (cells phase 6). Registered at load; it runs only while the
    // links are attached.
    calls.onPeerDown((peer) => this.peerDown(peer));
  }

  setHandlers(handlers: TradeHandlers | null): void {
    this.handlers = handlers;
  }

  /**
   * Host: the node of an asked player of a neighbouring node. Null for a player of this node, or one not trading here.
   * Null too once the link to their node went down (peerDown drops them in the same turn as the link): the last check
   * before a swap (trades.accept's noLonger, through the receiver's traderNamed) then finds them gone, and no swap
   * is started with a node that cannot be told its end.
   */
  partnerPeer(username: string): string | null {
    return this.partners.get(lower(username))?.peer ?? null;
  }

  /** Host: the asked player is on `peer`, and the trade they answered for carries `stamp` (the one in their TP_ANSWER). */
  setPartner(username: string, peer: string, stamp = ""): void {
    this.partners.set(lower(username), { peer, stamp });
  }

  dropPartner(username: string): void {
    this.partners.delete(lower(username));
  }

  /** Partner's node: the node that holds this node's player's trade. Null when no trade is held elsewhere. */
  hostOf(username: string): string | null {
    return this.hosts.get(lower(username))?.peer ?? null;
  }

  /** Partner's node: the trade of this node's player as its host last sent it (TP_STATE), which is what a swap would make. Null before the first. */
  lastState(username: string): unknown | null {
    return this.hosts.get(lower(username))?.state ?? null;
  }

  /**
   * Partner's node: an accept of this node's player's trade held elsewhere was sent, and no state from the host has
   * shown since whether it stands. The host may swap with it while lastState shows no accept, so a player who leaves
   * now is treated as one shown accepted.
   */
  acceptSent(username: string): boolean {
    return this.hosts.get(lower(username))?.acceptUnshown === true;
  }

  /** Records a host for a player, as an accepted answer does, and (`accepted`) that they sent an accept. For tests. */
  setHost(username: string, peer: string, stamp = "", accepted = false): void {
    this.hosts.set(lower(username), { peer, stamp, accepted });
  }

  dropHost(username: string): void {
    this.hosts.delete(lower(username));
  }

  /** Partner's node: the answer of its player to an invitation held on `peer`. The host is kept only when a trade opened. */
  async sendAnswer(peer: string, body: TradeAnswer): Promise<TradeReply> {
    const name = lower(body.partner);
    // The host would swap from this player's rows in the shared cache, which their mark here does not fence.
    if (body.accepted && this.fence.unsettled(name)) return { ok: false, reason: TRADE_SETTLING };
    // A trade this player already has is not touched by an answer that opens none (a second invitation declined).
    const had = this.hosts.has(name);
    const mine = { peer, stamp: crypto.randomUUID() };
    // Recorded before asking: the host sends the trade's first TP_STATE before it answers.
    if (body.accepted && !had) this.hosts.set(name, mine);
    const sent = await this.calls.call<TradeReply>(peer, "TP_ANSWER", { ...body, stamp: mine.stamp });
    const reply: TradeReply = sent.ok && sent.answer ? sent.answer : { ok: false, reason: ANSWER_UNREACHABLE };
    // An answer that did not arrive may still have opened a trade there. It is not asked again: it is ended by its asker, or by the sweep.
    if (body.accepted && !sent.ok) log.warn(`The answer of ${name} to the trade invitation of ${lower(body.asker)} on ${peer} ended ${sent.why}: a trade may be open there that ${name} is not shown`);
    if (body.accepted && !had && !reply.opened && this.hosts.get(name) === mine) this.hosts.delete(name);
    return reply;
  }

  /** Partner's node: its player acts on their trade held elsewhere. Null when no trade of theirs is held elsewhere. */
  async sendUpdate(username: string, op: TradeOp, offer?: unknown): Promise<TradeReply | null> {
    const name = lower(username);
    const host = this.hosts.get(name);
    if (!host) return null;
    // Not sent: the swap it could start would read this player's rows on the host, past their mark here.
    if (op === "accept" && this.fence.unsettled(name)) return { ok: false, reason: TRADE_SETTLING };
    // Recorded before it is sent: an accept that is not answered may still have arrived.
    if (op === "accept") {
      host.accepted = true;
      host.acceptUnshown = true;
      host.acceptsInFlight = (host.acceptsInFlight ?? 0) + 1;
    }
    host.inflight = (host.inflight ?? 0) + 1;
    try {
      const { peer, stamp } = host;
      // One who leaves is done with the trade, whatever its host answers.
      if (op === "leave") this.hosts.delete(name);
      const sent = await this.calls.call<TradeReply>(peer, "TP_UPDATE", offer === undefined ? { username: name, op, stamp } : { username: name, op, offer, stamp });
      // An update that did not arrive, or may not have: it is not sent again. The trade is let go here, and one
      // cancel is sent after it, so that a trade the update left open there does not outlive the player's window.
      // A link that is down sends nothing, cancel included (peerDown ends the trades of a node that went down).
      if (!sent.ok) {
        log.warn(`The trade update "${op}" of ${name} to ${peer} ended ${sent.why}: the trade is ended for ${name} here, and may still be open there`);
        if (op !== "leave") {
          const followed = await this.calls.call<TradeReply>(peer, "TP_UPDATE", { username: name, op: "cancel", stamp });
          // The swap is under way there and goes on. Its end is cast with the reload that is right: wait for it.
          if (followed.ok && followed.answer?.settling && this.hosts.get(name) === host) {
            if (await this.awaitEnd(name, host)) return { ok: false, gone: true, closed: true };
            log.warn(`The end of the trade of ${name} did not arrive from ${peer} within ${this.settleWaitMs} ms of a swap that was under way (or the link went down): their bags and coins are read again now`);
          }
        }
        if (this.hosts.get(name) === host) this.hosts.delete(name);
        return { ok: false, gone: true, reason: TRADE_UNREACHABLE };
      }
      if (sent.answer?.gone && this.hosts.get(name) === host) this.hosts.delete(name);
      return sent.answer;
    } finally {
      host.inflight = Math.max(0, (host.inflight ?? 1) - 1);
      if (op === "accept") host.acceptsInFlight = Math.max(0, (host.acceptsInFlight ?? 1) - 1);
    }
  }

  /** Host: the trade as it stands for an asked player of a neighbouring node. False when they are not one, or the cast was not sent. */
  sendState(username: string, state: unknown): boolean {
    const peer = this.partnerPeer(username);
    if (!peer) return false;
    const sent = this.calls.cast(peer, "TP_STATE", { username: lower(username), state, stamp: this.partners.get(lower(username))?.stamp });
    if (!sent) log.warn(`The trade window of ${lower(username)} could not be sent to ${peer}: the link is down`);
    return sent;
  }

  /** Host: the trade of an asked player of a neighbouring node ended. They stop being a partner here either way. */
  sendClosed(username: string, closed: Omit<TradeClosedCast, "username" | "stamp">): boolean {
    const peer = this.partnerPeer(username);
    const stamp = this.partners.get(lower(username))?.stamp;
    this.dropPartner(username);
    if (!peer) return false;
    const sent = this.calls.cast(peer, "TP_CLOSED", { username: lower(username), ...closed, stamp });
    // Their node finds out the next time they act on the trade, and a swap's reload is not made until then.
    if (!sent) log.warn(`The end of the trade of ${lower(username)} could not be sent to ${peer}: the link is down${closed.reload ? ", and their bags and coins are not read again there" : ""}`);
    return sent;
  }

  /**
   * Every trade across `peer` is let go here: the link is down, so neither node can reach the other about it.
   * A host's partners on that node are dropped, and so are this node's players whose trade that node held. Each
   * goes to the `lost` handler, which ends the trade and reads the bags again. A player whose own update was on its
   * way is told by sendUpdate; a wait for the end of a swap there ends now.
   *
   * A swap that started on that node before the link dropped may still commit there. This node's players whose trade
   * it held, and who sent an accept, are marked unsettled first (cluster/tradesettle.ts), so their writes here wait
   * for it and read it. One who sent no accept cannot have been swapped, and is not held up. A host's own players
   * need no mark: their swap is made here.
   */
  peerDown(peer: string): void {
    for (const [name, partner] of [...this.partners]) {
      if (partner.peer !== peer) continue;
      this.partners.delete(name);
      log.warn(`The link to ${peer} went down: the trade with ${name} is ended here`);
      void this.run(() => this.handlers?.lost?.({ role: "host", username: name, peer }));
    }
    // Marked before anything reads their bags again: `lost` below, or the relay once sendUpdate answers (an update in
    // flight, or a wait for the end of a swap, which is only made while the trade is held here: its player is in hosts).
    // A swap under way (one a cancel was answered "settling" for) was accepted by them, so `accepted` covers it.
    for (const [name, host] of [...this.hosts]) {
      if (host.peer !== peer) continue;
      if (host.accepted) void this.fence.unsettle(name, "the link went down with their accepted trade held there", peer);
      this.hosts.delete(name);
      if (host.inflight) continue;
      log.warn(`The link to ${peer} went down: the trade of ${name} held there is ended here`);
      void this.run(() => this.handlers?.lost?.({ role: "partner", username: name, peer }));
    }
    for (const wait of [...this.waiting.values()]) {
      if (wait.host.peer === peer) wait.end(false);
    }
  }

  /** Forgets every partner, host and handler. For tests. */
  reset(): void {
    for (const wait of [...this.waiting.values()]) wait.end(false);
    this.partners.clear();
    this.hosts.clear();
    this.handlers = null;
  }

  /** Whether a cast about `name`'s trade came from the node and the trade recorded for them. */
  private fromHost(name: string, from: string, stamp: unknown): boolean {
    const host = this.hosts.get(name);
    return !!host && host.peer === from && host.stamp === (stamp ?? "");
  }

  /**
   * Waits for the end of `name`'s trade held on `host`: true when it arrived (and was shown), false when the wait ran
   * out or the link to the host went down (peerDown).
   */
  private awaitEnd(name: string, host: HostEntry): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const end = (closed: boolean) => {
        clearTimeout(timer);
        if (this.waiting.get(name)?.end === end) this.waiting.delete(name);
        resolve(closed);
      };
      const timer = setTimeout(() => end(false), this.settleWaitMs);
      this.waiting.set(name, { host, end });
    });
  }

  private run(work: () => void | Promise<void>): Promise<void> {
    const failed = (error: unknown) => log.warn(`A trade message from a neighbouring node could not be handled: ${error}`);
    try {
      return Promise.resolve(work()).catch(failed);
    } catch (error) {
      failed(error);
      return Promise.resolve();
    }
  }
}

/** The node's trade link. Its handlers are registered on `linkCalls`, and do nothing until the links are attached. */
export const tradeLink = new TradeLink(linkCalls);
