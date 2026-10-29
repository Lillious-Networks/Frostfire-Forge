import { findPlayersWithTargetInAOI, getPlayersNearPoint } from "../socket/aoi";
import log from "../modules/logger";
import ignores from "../systems/ignores";
import { fromWire, toWire } from "./linkproto";
import type { LinkSender } from "./linktransport";
import { mirrorByUsername } from "./mirrors";
import { MIRROR_KEEP_PX, nodesWithin, type Owners } from "./strip";

// aoiEvent (spec §6): something seen by everyone within `radius` of a point,
// such as a line of say chat. Local players in range get it here; neighbours
// whose blocks fall inside the radius get it over the node link and deliver it
// to their own players in range.

/** The largest radius a neighbour's AOI_EVENT is delivered with here. */
const MAX_REMOTE_RADIUS_PX = MIRROR_KEEP_PX * 2;

let state: { links: LinkSender; ownersOf: (map: string) => Owners } | null = null;

export function attachAoiEvents(links: LinkSender, ownersOf: (map: string) => Owners): void {
  state = { links, ownersOf };
  // The handler cannot be taken back off the links: it delivers only while these links are attached.
  links.on("AOI_EVENT", (data) => {
    if (state?.links !== links) return;
    // An event reaches across one strip at most: a larger radius from the wire would scan the whole map.
    const radius = Math.min(Number(data?.radius), MAX_REMOTE_RADIUS_PX);
    const speaker = typeof data?.speaker === "string" && data.speaker ? data.speaker : undefined;
    deliverLocal(String(data?.map ?? ""), data?.layerId ?? null, Number(data?.x), Number(data?.y), radius, fromWire(data?.packets), !!data?.bestEffort, speaker);
  });
}

export function detachAoiEvents(): void {
  state = null;
}

export function aoiEvent(map: string, layerId: string | null, x: number, y: number, radius: number, packets: Uint8Array[], options: { bestEffort?: boolean } = {}): void {
  deliverLocal(map, layerId, x, y, radius, packets, !!options.bestEffort);
  forwardAoiEvent(map, layerId, x, y, radius, packets, options);
}

/**
 * Only the neighbours' part, for callers that already sent to their own players (say chat translates per listener).
 * `speaker` is the username of whoever the event is heard from (chat only): the neighbour holds back from it the
 * listeners who ignore them, and keeps the ones that can see them.
 */
export function forwardAoiEvent(map: string, layerId: string | null, x: number, y: number, radius: number, packets: Uint8Array[], options: { bestEffort?: boolean; speaker?: string } = {}): void {
  if (!state || packets.length === 0) return;
  const bare = map.replace(/\.json$/, "");
  const peers = nodesWithin(state.ownersOf(bare), x, y, radius, state.links.self);
  if (peers.size === 0) return;
  const message = { map: bare, layerId, x, y, radius, packets: toWire(packets), bestEffort: !!options.bestEffort, ...(options.speaker ? { speaker: options.speaker } : {}) };
  for (const peer of peers) if (state.links.isUp(peer)) state.links.send(peer, "AOI_EVENT", message);
}

function send(player: any, packets: Uint8Array[], bestEffort: boolean): void {
  const wt = player?.wt;
  if (!wt || wt.readyState !== 1) return;
  try {
    for (const packet of packets) {
      if (bestEffort && typeof wt.sendBestEffort === "function") wt.sendBestEffort(packet);
      else wt.send(packet);
    }
  } catch (error) {
    log.debug(`AOI event not sent to ${player.id}: ${error}`);
  }
}

function deliverLocal(map: string, layerId: string | null, x: number, y: number, radius: number, packets: Uint8Array[], bestEffort: boolean, speaker?: string): void {
  if (!map || !Number.isFinite(x) || !Number.isFinite(y) || !(radius > 0)) return;
  // A null layer reaches every layer (as broadcastToAOIAtPosition treats it).
  let listeners = getPlayersNearPoint(x, y, map, radius, layerId ?? undefined);
  if (!speaker) {
    for (const player of listeners) send(player, packets, bestEffort);
    return;
  }

  // A line heard across a border: hearing matches seeing (when the speaker's mirror is here), and the
  // listener's ignore list holds it back. The speaker's node has already applied the mute.
  const mirror = mirrorByUsername(speaker);
  if (mirror) {
    const viewers = new Set(findPlayersWithTargetInAOI(mirror.id).map((p) => String(p.id)));
    listeners = listeners.filter((p) => viewers.has(String(p.id)));
  }
  if (listeners.length === 0) return;
  ignores.notIgnoring(speaker, listeners.map((p) => p.username)).then((heard) => {
    const hearing = new Set(heard);
    for (const player of listeners) if (hearing.has(player.username)) send(player, packets, bestEffort);
  }, (error) => {
    // Ignore lists that cannot be read hold nothing back, as in chatgate: chat goes on.
    log.error(`Ignore lists could not be read, so a line from ${speaker} is not held back by them: ${error}`);
    for (const player of listeners) send(player, packets, bestEffort);
  });
}
