import log from "../modules/logger";
import type { ClusterStore } from "./store";

// A node ticket (SWITCH) is signed for 30 s. A handoff ticket names a player
// that the new node is holding for this one connection, so it is spent on
// first use: a copy of it (the client retried, or the ticket leaked) is
// refused everywhere in the cluster. The mark outlives the ticket by a second,
// so a ticket cannot be used again just as it expires.

export const TICKET_KEY_PREFIX = "cells:ticket:";

/**
 * What the spend found: "spent" (this connection spent it, it may log in), "reused" (spent before, by another
 * connection), "unknown" (it could not be checked). Only "spent" logs in.
 */
export type TicketSpend = "spent" | "reused" | "unknown";

export async function spendTicket(
  store: Pick<ClusterStore, "setIfAbsent">, token: string, expiresAt: number, now = Date.now(),
): Promise<TicketSpend> {
  if (!token) return "unknown";
  // A NaN or fractional TTL would be refused by Redis and take the refusal below.
  const left = Number.isFinite(expiresAt) && Number.isFinite(now) ? Math.ceil(expiresAt - now) : 0;
  const ttlMs = Math.max(1_000, left + 1_000);
  try {
    return (await store.setIfAbsent(TICKET_KEY_PREFIX + token, "1", ttlMs)) ? "spent" : "reused";
  } catch (error) {
    // Fails closed (security review L1): a spend that cannot be recorded cannot stop a copy of the ticket either,
    // so the ticket is refused. Redis down pauses handoffs anyway (spec §7); the client logs in again via the Gateway.
    log.warn(`Ticket spend not recorded (store failed); the SWITCH ticket is refused: ${error}`);
    return "unknown";
  }
}
