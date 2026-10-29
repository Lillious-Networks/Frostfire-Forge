import log from "../modules/logger";
import type { LinkCalls } from "./linkcalls";
import type { LinkSender } from "./linktransport";

// Modules that work over the node links (the player and creature handoffs,
// the forwarding table, the watch ticks) register here at load. startCluster
// runs them once the links are attached, and undoes them at shutdown. Without
// a cluster they never run.

export interface LinkContext {
  calls: LinkCalls;
  links: LinkSender;
  self: string;
  /** The node that owns the block at (x, y) of `map` (a bare map name, no ".json"), or null. */
  ownerAt(map: string, x: number, y: number): string | null;
  /** The cluster's store: `isUp?.() === false` while Redis is away, when handoffs pause (a missing store or method counts as up). */
  store?: { isUp?(): boolean };
}
export type LinkHook = (ctx: LinkContext) => (() => void) | void;

const hooks = new Set<LinkHook>();

/** Run `fn` each time the cluster attaches its links; what it returns runs at detach. */
export function onLinksAttached(fn: LinkHook): () => void {
  hooks.add(fn);
  return () => { hooks.delete(fn); };
}

/** startCluster runs this after linkCalls.attach; the result undoes every hook. */
export function runLinkHooks(ctx: LinkContext): () => void {
  const undos: Array<() => void> = [];
  for (const hook of [...hooks]) {
    try {
      const undo = hook(ctx);
      if (undo) undos.push(undo);
    } catch (error) {
      log.error(`A link hook failed to start: ${error}`);
    }
  }
  return () => {
    for (const undo of undos.reverse()) {
      try {
        undo();
      } catch (error) {
        log.error(`A link hook failed to stop: ${error}`);
      }
    }
  };
}
