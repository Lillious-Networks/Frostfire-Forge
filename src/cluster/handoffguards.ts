import log from "../modules/logger";
import { isSwitchTicket } from "../socket/ticket";
import { trackPacket } from "./inflight";

// Small decisions of the server's handoff wiring (cells phase 6), kept apart from socket/server.ts (which cannot be
// imported by a test: it starts the server) so they are tested by what they do.

/**
 * Whether a connection that opens with `token` spends it: only a SWITCH ticket, and only in cluster mode (a store
 * to spend it in). The Gateway's own login tokens are never spent here.
 */
export function spendsTicket<S>(store: S | null | undefined, token: unknown): store is S {
  return !!store && isSwitchTicket(token);
}

/**
 * The id an arriving connection keeps: the one its handoff claimed (`kept`), unless a connection of this node still
 * has that id open (a quick hand-back). Null: the connection gets a new id.
 */
export function arrivalId(kept: string | null, isOpen: (id: string) => boolean): string | null {
  return kept !== null && !isOpen(kept) ? kept : null;
}

/**
 * A teleport from outside a packet (the plugin API). With cells off it runs as before. With cells on, it runs as a
 * packet of the player's would (inside trackPacket, so a handoff's drain waits for it), and a player being handed
 * off (`handoff`, or `wt.data.handedOff`) is not moved: the move would be lost on the new node and leave the client
 * out of step. The check is made inside the tracked call, so a handoff that starts later waits for this move.
 * True when the teleport ran.
 */
export async function guardedTeleport(cellsOn: boolean, player: any, teleport: () => Promise<unknown>): Promise<boolean> {
  if (!cellsOn) {
    await teleport();
    return true;
  }
  return trackPacket(String(player?.id), async () => {
    if (player?.handoff || player?.wt?.data?.handedOff) {
      log.warn(`Teleport of player ${player?.id} refused: the player is being handed off to another node`);
      return false;
    }
    await teleport();
    return true;
  });
}

/** How long a shutdown may take from the signal, in all: under the 20 s stop grace the compose files give. */
export const SHUTDOWN_DEADLINE_MS = 9_000;

/**
 * Runs one shutdown step for at most `capMs` and never past `deadline` (ms, as `now` counts). True when the step
 * ended in time (a step that failed has ended: it is logged). A step cut short, or skipped because no time is left,
 * is logged. Never throws.
 */
export async function boundedStep(
  what: string,
  step: () => unknown,
  deadline: number,
  capMs = Infinity,
  now: () => number = Date.now,
): Promise<boolean> {
  const ms = Math.min(capMs, deadline - now());
  if (!(ms > 0)) {
    log.warn(`Shutdown: ${what} skipped, the shutdown deadline has passed.`);
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([
    Promise.resolve()
      .then(step)
      .then(
        () => true,
        (error) => {
          log.error(`Shutdown: ${what} failed: ${error}`);
          return true;
        },
      ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  if (!ended) log.warn(`Shutdown: ${what} cut short after ${Math.round(ms)} ms.`);
  return ended;
}
