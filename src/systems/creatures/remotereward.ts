import { registerPlayerAction, runOnPlayer } from "../../cluster/deliver";
import { ghosts } from "../../cluster/ghosts";
import { linkCalls } from "../../cluster/linkcalls";
import { grants } from "../../cluster/grants";
import { mirrorByUsername, mirrorOwner } from "../../cluster/mirrors";
import log from "../../modules/logger";

/**
 * A remote member's share of a kill (APPLY_REWARD, spec §4). The creature's owner decides it; the node the
 * player is on applies it, so the XP, the level-up and the quest credit happen where the player is.
 */
export interface RewardBody {
  username: string;
  playerId: string;
  creatureId: number;
  templateId: number;
  templateName: string;
  xp: number;
}

/**
 * The largest whole number the stats and currency columns hold (playereditor.ts INT_MAX, currency.ts storedAsGiven).
 * No XP or money amount that reaches this node over a link may be larger: it is the outer bound of every check below.
 */
export const STAT_INT_MAX = 2147483647;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** A name or id as it is written in a log line: peers send these, so only the start of one is kept. */
const shown = (value: unknown) => String(value).slice(0, 64);

/**
 * Applies a share to a player of this node. False when that player is not here, or the share is not one a kill of
 * that creature can give. `from` is the node that sent it (the node of the creature).
 */
export type RewardApplier = (body: RewardBody, from?: string) => Promise<boolean>;

let applier: RewardApplier | null = null;

/**
 * kill.ts sets this when it loads. Tests set their own. Answers the applier that was set before, so a test
 * can put it back: every test file shares one process, and kill.ts sets its applier only once, at load.
 */
export function setRewardApplier(fn: RewardApplier | null): RewardApplier | null {
  const previous = applier;
  applier = fn;
  return previous;
}

/**
 * Sends each share to the node its player is on (where the mirror came from). Answers the usernames whose
 * node did not confirm: no mirror, a link down or timed out, or the player was not there. Not retried.
 */
export async function sendRewards(bodies: RewardBody[]): Promise<string[]> {
  const missed: string[] = [];
  await Promise.all(bodies.map(async (body) => {
    const peer = mirrorOwner(body.playerId);
    if (!peer) {
      missed.push(body.username);
      return;
    }
    const outcome = await linkCalls.call<{ ok: boolean }>(peer, "APPLY_REWARD", body);
    if (!outcome.ok || !outcome.answer?.ok) missed.push(body.username);
  }));
  return missed;
}

/**
 * The share a peer sent, as far as its shape goes, or null with the reason logged. Built field by field, so nothing
 * else the peer put in the body travels on. Which creature template it names, and how much that template can give,
 * is for the applier (it reads this node's tables).
 */
export function checkedReward(body: unknown, from: string): RewardBody | null {
  const b = body as Partial<RewardBody> | null;
  if (!b || typeof b.username !== "string" || typeof b.playerId !== "string" || !isCount(b.creatureId) || !isCount(b.templateId) || !isCount(b.xp) || b.xp > STAT_INT_MAX) {
    log.warn(`Kill reward from ${shown(from)} refused: its fields are not a share (${shown(b?.username)}, xp ${shown(b?.xp)})`);
    return null;
  }
  // A creature this node mirrors belongs to the node that owns it: nobody else may pay out for its kill.
  const owner = ghosts.ownerOf("creature", b.creatureId);
  if (owner && owner !== from) {
    log.warn(`Kill reward from ${shown(from)} for creature ${b.creatureId} refused: the creature belongs to ${owner}`);
    return null;
  }
  return { username: b.username, playerId: b.playerId, creatureId: b.creatureId, templateId: b.templateId, templateName: String(b.templateName ?? ""), xp: b.xp };
}

linkCalls.handle("APPLY_REWARD", async (body: RewardBody, from: string) => {
  const share = checkedReward(body, from);
  if (!share) return { ok: false };
  log.info(`APPLY_REWARD from ${shown(from)}: ${shown(share.username)} (${shown(share.playerId)}), ${share.xp} XP for creature ${share.creatureId}`);
  return { ok: applier ? await applier(share, from) : false };
});

/**
 * A share of a corpse's money for a member who is on another node (GRANT, or the cells-grant player action).
 * The notice the player is shown is made by the node that pays, from the amount: a `message` is not read.
 */
export interface GrantBody {
  username: string;
  copper: number;
  /** Not sent any more, and ignored when it arrives. */
  message?: string;
  /** The grant id (cluster/grants.ts): the receiver gives one id once. Set by sendGrant while the store is attached. */
  id?: string;
}

/** given: written there. sent: sent to their node, no answer. absent: they are not there. unknown: the link failed. */
export type GrantOutcome = "given" | "sent" | "absent" | "failed" | "unknown";

/** Gives a share to a player of this node. "absent" when they are not here, "failed" for an amount no corpse holds. */
export type GrantApplier = (body: GrantBody) => Promise<GrantOutcome>;

let grantApplier: GrantApplier | null = null;

/**
 * kill.ts sets this when it loads. Tests set their own. Answers the applier that was set before, so a test can
 * put it back (as setRewardApplier does).
 */
export function setGrantApplier(fn: GrantApplier | null): GrantApplier | null {
  const previous = grantApplier;
  grantApplier = fn;
  return previous;
}

/**
 * Sends a share to the node its player is on: the node their mirror came from (GRANT), else wherever the
 * directory has them (cells-grant). "absent" when they are on no node. With the cluster store attached the share
 * carries a grant id, so a GRANT that failed after it was sent is sent again through the directory: the receiver
 * gives one id once (kill.ts grantCopper). Without one it is not retried.
 */
export async function sendGrant(share: GrantBody): Promise<GrantOutcome> {
  const body: GrantBody = grants.attached() && !share.id ? { ...share, id: grants.newId() } : share;
  const peer = mirrorByUsername(body.username)?.mirrorFrom;
  // A link that is down sends nothing, so the share is certainly unapplied: the directory may know another way.
  if (peer && linkCalls.isUp(peer)) {
    const outcome = await linkCalls.call<{ result: GrantOutcome }>(peer, "GRANT", body);
    if (!outcome.ok) {
      if (!body.id) return "unknown";
      // It may have been given there: sent again with the same id, it is given at most once.
      return (await runOnPlayer(body.username, "cells-grant", body)) ? "sent" : "unknown";
    }
    const result = outcome.answer?.result ?? "unknown";
    // The mirror was stale: they moved on. The directory knows where.
    if (result !== "absent") return result;
  }
  return (await runOnPlayer(body.username, "cells-grant", body)) ? "sent" : "absent";
}

/** The share a peer sent, as far as its shape goes, or null. Only the name, the amount and a grant id are kept. */
export function checkedGrant(body: unknown): GrantBody | null {
  const b = body as Partial<GrantBody> | null;
  if (!b || typeof b.username !== "string" || !isCount(b.copper) || b.copper > STAT_INT_MAX) return null;
  const id = typeof b.id === "string" && b.id.length > 0 && b.id.length <= 128 ? b.id : null;
  return id ? { username: b.username, copper: b.copper, id } : { username: b.username, copper: b.copper };
}

linkCalls.handle("GRANT", async (body: GrantBody, from: string) => {
  const share = checkedGrant(body);
  if (!share) {
    log.warn(`Corpse money from ${shown(from)} refused: its fields are not a share (${shown((body as any)?.username)}, ${shown((body as any)?.copper)} copper)`);
    return { result: "failed" as GrantOutcome };
  }
  log.info(`GRANT from ${shown(from)}: ${shown(share.username)}, ${share.copper} copper`);
  return { result: grantApplier ? await grantApplier(share) : "failed" };
});
registerPlayerAction("cells-grant", async (player, body: GrantBody) => {
  // Sent with no answer: this line is the only record of a share that was not given. The bus does not say which node
  // sent it, so the lines name the player it ran on.
  const share = checkedGrant(body);
  // The action runs on the player the sender named; a body for someone else is not theirs to pay out.
  if (!share || String(player?.username ?? "").toLowerCase() !== share.username.toLowerCase()) {
    log.warn(`Corpse money for ${shown((body as any)?.username)} (${shown((body as any)?.copper)} copper) refused on arrival: not a share for ${shown(player?.username)}`);
    return;
  }
  log.info(`cells-grant (bus): ${shown(share.username)}, ${share.copper} copper`);
  const result = grantApplier ? await grantApplier(share) : "failed";
  if (result !== "given") log.warn(`Corpse money for ${share.username} (${share.copper} copper) was ${result} on arrival`);
}, (body: GrantBody) => `corpse money (${body?.copper} copper) was not given`);
