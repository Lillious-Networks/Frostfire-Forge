import { describeGrant, grants, type GrantItem, type ParkedGrant } from "../cluster/grants";
import { onLinksAttached } from "../cluster/linkhooks";
import log from "../modules/logger";
import { atomically } from "../services/batch";
import { packetManager } from "../socket/packet_manager";
import { formatMoney } from "./creatures/kill";
import currency from "./currency";
import { grantWrittenBefore, pruneGrantWrites, recordGrantWrite } from "./grantwrites";
import inventory from "./inventory";
import { handedVerdict } from "./itembounds";

/** A grant whose bounds are not read yet: nothing of it was written, and it is parked again. */
class BoundsNotReady extends Error {
  constructor(id: string) {
    super(`hand-over ${id} waits for its bounds to be read`);
    this.name = "BoundsNotReady";
  }
}

// Writes a grant the asker did not claim (cluster/grants.ts): the items and money in one batch for the player it
// names, and the packets when the player is on this node. inventory.add answers nothing for a name that is not an
// item; such an item is logged by name, as receiveHanded in socket/receiver.ts does.
//
// A recovered gather (GATHER_REQUEST) is written as the owner parked it: its item and quantity, without the
// gatherer's node's check against the area's item and largest yield (gathering/remote.ts receiveGathered). It never
// gives more than the owner took off the node, so nothing is made; only an owner whose tables differ from this node's
// can give more than a claimed answer would have written.
//
// Security review phase 7: a grant comes back from the cluster store, which this node does not trust to hold only what
// an owner parked (H1). It is written only when it is in bounds (itembounds.ts: every item is one, every quantity at
// most ITEM_QUANTITY_MAX, the copper at most a corpse's); else it is refused whole and logged lost by name. Its id is
// written with it, in the same transaction (grantwrites.ts, M2): a grant the store brought back after it was written
// finds its row, and is skipped.

function send(wt: any, packets: any[]): void {
  if (!wt || !wt.send || wt.readyState !== 1) return;
  try {
    for (const packet of packets) wt.send(packet);
  } catch {
    // Connection closing.
  }
}

export async function giveGrant(grant: ParkedGrant, player: any | null): Promise<void> {
  const username = grant.username;
  // Guard (test "a grant out of bounds is refused whole and logged lost by name").
  const verdict = await handedVerdict({
    player: username, items: grant.items, copper: grant.copper,
    source: `Hand-over ${grant.id} (${grant.call} on ${grant.owner})`, waits: "it is parked again for a later check",
  });
  if (verdict === "refused") return;
  const added: GrantItem[] = [];
  let balance: Currency | null;
  try {
    balance = await atomically([username], async (batch) => {
      // A bound not read yet (fix round 1): thrown before anything is sent, so nothingWritten holds and the grant
      // writer's caller (cluster/grants.ts write) parks it again. Guard (test "a grant with copper before the
      // templates load stays parked, and is written after they load").
      if (verdict === "not-ready") throw new BoundsNotReady(grant.id);
      added.length = 0;
      // First in the batch: its guard is the transaction's first statement (grantwrites.ts).
      await recordGrantWrite(batch, grant.id);
      for (const item of grant.items) {
        if (await inventory.add(username, { name: item.itemName, quantity: item.quantity } as any, batch)) added.push(item);
      }
      return grant.copper > 0 ? await currency.add(username, { copper: grant.copper, silver: 0, gold: 0 }, batch) : null;
    });
  } catch (error) {
    // Guard (test "a grant whose id was written before is skipped, not written again").
    if (grantWrittenBefore(error)) {
      log.info(`Hand-over ${grant.id} (${grant.call} on ${grant.owner}) for ${username} was written before: not written again (${describeGrant(grant)})`);
      return;
    }
    throw error;
  }
  for (const item of grant.items) {
    if (!added.includes(item)) log.error(`Hand-over ${grant.id} for ${username}: ${item.quantity} x ${item.itemName} is not an item, so it is lost`);
  }
  log.info(`Hand-over ${grant.id} (${grant.call} on ${grant.owner}) written for ${username}${player ? "" : " to their rows"}: ${describeGrant(grant)}`);
  if (!player?.wt) return;
  for (const item of added) send(player.wt, packetManager.lootReceived({ itemName: item.itemName, quantity: item.quantity, quality: "common" }));
  if (balance) {
    send(player.wt, packetManager.currency(balance));
    send(player.wt, packetManager.notify({ message: `You receive loot: ${formatMoney(grant.copper)}` }));
  }
}

grants.setWriter(giveGrant);

// grant_writes rows older than GRANT_WRITES_KEEP_MS are deleted when the cluster starts. Only startCluster runs the
// link hooks, so with the cluster off this never runs. Guard (test "grant_writes rows older than 30 days are deleted
// in one statement at cluster start, and a failure is logged and ignored").
onLinksAttached(() => { void pruneGrantWrites(); });
