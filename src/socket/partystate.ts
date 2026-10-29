import log from "../modules/logger";

// A player's party is two fields: the member names (`party`) and the party's row id (`party_id`). The player update
// sends the id to everyone who sees the player, and a handoff carries it to the next node, so the two change
// together, here.

/** Sets the player's party list and party id together. No members: no party, so party_id is null. */
export async function applyPartyMembers(p: any, members: string[], partyIdOf: (username: string) => Promise<number | null>): Promise<void> {
  p.party = members;
  if (members.length === 0) {
    p.party_id = null;
    return;
  }
  let partyId: number | null = null;
  try {
    partyId = await partyIdOf(p.username);
  } catch (error) {
    log.error(`The party id of ${p.username} could not be read: ${error}`);
  }
  // A newer update or a clear replaced the party while the look-up ran: the id of this one is not written.
  if (p.party !== members) return;
  p.party_id = partyId;
}

export function clearParty(p: any): void {
  p.party = [];
  p.party_id = null;
}

/**
 * Writes a player back to the cache after an await, unless the cache no longer holds them (they disconnected while the
 * look-up ran, and must not be put back).
 */
export function cacheIfHeld(cache: { get(id: string): any; set(id: string, value: any): void }, p: any): void {
  if (cache.get(p.id) === p) cache.set(p.id, p);
}
