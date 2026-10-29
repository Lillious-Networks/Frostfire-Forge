import { packetManager } from "./packet_manager";

// Tells a walking player's client which node it will be sent to (HANDOFF_PREPARE) or to drop the session it opened for
// it (HANDOFF_ABORT). Kept apart from server.ts so a test can run it against a recording connection.

/** The connection side this needs: an open check and a send that takes one frame. */
export interface PrepareConnection {
  readyState: number;
  send(frame: Uint8Array): unknown;
}

/**
 * Sends the prepare for `node`, or the withdrawal for null, to the player's own open connection. The packet manager
 * answers a list of frames and `send` takes one, so each frame is sent on its own.
 */
export function sendHandoffPrepare(wt: PrepareConnection | null | undefined, node: { nodeId: string; publicHost: string; port: number; wtPort: number; useSSL: boolean } | null): void {
  if (!wt || wt.readyState !== 1) return;
  const frames: Uint8Array[] = node ? packetManager.handoffPrepare(node) : packetManager.handoffAbort();
  for (const frame of frames) wt.send(frame);
}
