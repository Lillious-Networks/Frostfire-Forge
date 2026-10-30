import { packetManager } from "./packet_manager";

// Tells a walking player's client which node it will be sent to (HANDOFF_PREPARE) or to drop the session it opened for
// it (HANDOFF_ABORT), that the node stopped stepping it for the handoff (HANDOFF_BEGIN) and that the node kept it after
// all (HANDOFF_STAY). Kept apart from server.ts so a test can run it against a recording connection.

/** The connection side this needs: an open check and a send that takes one frame. */
export interface PrepareConnection {
  readyState: number;
  send(frame: Uint8Array): unknown;
}

/** Each frame the packet manager answers is sent on its own: `send` takes one. Nothing for a closed connection. */
function sendFrames(wt: PrepareConnection | null | undefined, frames: () => Uint8Array[]): void {
  if (!wt || wt.readyState !== 1) return;
  for (const frame of frames()) wt.send(frame);
}

/** Sends the prepare for `node`, or the withdrawal for null, to the player's own open connection. */
export function sendHandoffPrepare(wt: PrepareConnection | null | undefined, node: { nodeId: string; publicHost: string; port: number; wtPort: number; useSSL: boolean } | null): void {
  sendFrames(wt, () => (node ? packetManager.handoffPrepare(node) : packetManager.handoffAbort()));
}

/** Where the player stands (rounded), or null when it is not known. */
function pointOf(player: any): { x: number; y: number } | null {
  const x = Number(player?.location?.position?.x);
  const y = Number(player?.location?.position?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
}

/** Tells the player's client the node stopped stepping them for a handoff, and where (rounded): it walks them on from there until the new node has them. */
export function sendHandoffBegin(wt: PrepareConnection | null | undefined, player: any): void {
  sendFrames(wt, () => packetManager.handoffBegin(pointOf(player)));
}

/** Tells the player's client the handoff was given up after the begin: the node keeps them where they stand (rounded). */
export function sendHandoffStay(wt: PrepareConnection | null | undefined, player: any): void {
  sendFrames(wt, () => packetManager.handoffStay(pointOf(player)));
}
