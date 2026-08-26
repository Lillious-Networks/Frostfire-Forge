// Outbound delivery abstraction.
//
// Phase 1 assumed every simulated player owns its connection (presence =
// authority). Phase 2 splits the two: the presence server holds the
// WebTransport connection, the authority server simulates the avatar. Every
// outbound packet should go through sendToPlayer() so the routing decision
// lives in one place - today it always resolves to the local connection, and
// the mesh relay path plugs in here when handoffs land.

import log from "../modules/logger.ts";
import { MeshMessageType } from "./protocol.ts";
import type { MeshLinks } from "./links.ts";

export interface DeliverablePlayer {
  id: string;
  username?: string;
  ws?: any;
  remotePresence?: string;
}

type Packet = Uint8Array;

let meshLinks: MeshLinks | null = null;

export function attachMeshLinks(links: MeshLinks | null): void {
  meshLinks = links;
}

function tryLocalSend(ws: any, packet: Packet): boolean {
  if (!ws || typeof ws.send !== "function" || ws.readyState !== 1) return false;
  try {
    ws.send(packet);
    return true;
  } catch (error) {
    log.debug(`Delivery send failed: ${(error as any)?.message || error}`);
    return false;
  }
}

/**
 * Relay one packet to the presence server holding this player's connection
 * (remote-authority avatar). Best-effort: dropped when the mesh link is down.
 */
function relayToPresence(player: DeliverablePlayer, packet: Packet): boolean {
  if (!meshLinks || !player.remotePresence) return false;
  const payload = JSON.stringify({
    playerId: player.id,
    packets: [btoa(String.fromCharCode(...packet))],
  });
  return meshLinks.sendToServer(player.remotePresence, MeshMessageType.OUTPUT_FORWARD, new TextEncoder().encode(payload), true);
}

/**
 * Deliver one or many packets to a player. Binary movement payloads and JSON
 * packets both flow through here (TransportConnection.send routes 0x01/0x02/
 * 0x03 frames to datagrams itself).
 *
 * Returns false when the player has no local connection (remote-authority
 * player). Phase 2.2 forwards those through the mesh relay to the presence
 * server instead of dropping them.
 */
export function sendToPlayer(player: DeliverablePlayer | null | undefined, packets: Packet[] | Packet | null): boolean {
  if (!player || !packets) return false;
  const ws = player.ws;

  if (Array.isArray(packets)) {
    let delivered = true;
    for (const packet of packets) {
      if (!tryLocalSend(ws, packet)) {
        if (!relayToPresence(player, packet)) delivered = false;
      }
    }
    return delivered;
  }

  if (tryLocalSend(ws, packets)) return true;
  return relayToPresence(player, packets);
}

/** Fire-and-forget datagram path (loss-tolerant packets). */
export function sendBestEffortToPlayer(player: DeliverablePlayer | null | undefined, packet: Packet | null): boolean {
  if (!player || !packet) return false;
  const ws = player.ws;
  if (!ws || typeof ws.sendBestEffort !== "function" || ws.readyState !== 1) return false;
  try {
    ws.sendBestEffort(packet);
    return true;
  } catch (error) {
    log.debug(`Best-effort send failed: ${(error as any)?.message || error}`);
    return false;
  }
}
