import { listener } from "../modules/event_bus";
import log from "../modules/logger";
import playerCache from "../services/playermanager";
import { Events, setPlayerPvp } from "../systems/events";
import type { DotInstance, RemoteDotCaster } from "../systems/dots";
import { registerPlayerAction, runOnPlayer } from "./deliver";
import { mirrorPlayers } from "./mirrors";

// Kill credit and PvP state for a DoT whose caster is on another node (cells phase 6). The DoT ticks on the
// target's node; the caster's node is told through the bus (cells-dot-credit), as a party's XP share is.

/** A caster is told about ticks on one target at most this often. A kill is always sent. */
export const CREDIT_THROTTLE_MS = 2_000;
const MAX_TRACKED = 4_096;
const MAX_NAME = 64;

/** A name from a peer or a DoT, cut to 64 characters and without control characters, so it is safe in a log line. */
function printable(value: unknown): string {
  return String(value ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "").slice(0, MAX_NAME);
}

export interface DotCreditBody { victimId: string; victimName: string; killed: boolean }

export interface DotCreditDeps {
  now(): number;
  /** Run cells-dot-credit on the caster's node (runOnPlayer). */
  send(casterUsername: string, body: DotCreditBody): Promise<boolean>;
  mirror(id: string): any | null;
}

export class DotCredit implements RemoteDotCaster {
  private readonly last = new Map<string, number>();

  constructor(private readonly deps: DotCreditDeps) {}

  credit(dot: DotInstance, target: any, killed: boolean): void {
    if (!dot.casterUsername) return;
    const key = `${dot.casterId}|${target?.id}`;
    const now = this.deps.now();
    const last = this.last.get(key);
    if (!killed && last !== undefined && now - last < CREDIT_THROTTLE_MS) return;
    // Deleting before setting keeps the map in the order of the last send, oldest first.
    this.last.delete(key);
    if (!killed) this.last.set(key, now);
    if (this.last.size > MAX_TRACKED) {
      // Walk from the oldest and stop at the first entry that is both recent and inside the cap, so the sweep costs
      // what it removes: a map full of fresh entries drops its oldest ones instead of being walked on every call.
      for (const [k, at] of this.last) {
        if (this.last.size <= MAX_TRACKED && now - at < CREDIT_THROTTLE_MS) break;
        this.last.delete(k);
      }
    }
    const body = { victimId: String(target?.id ?? ""), victimName: String(target?.username ?? ""), killed };
    void this.deps.send(dot.casterUsername, body).then((reached) => {
      if (!reached && killed) log.info(`The kill of ${body.victimName} by the DoT of ${printable(dot.casterUsername)} reached no node: they are offline`);
    }, (error) => {
      log.error(`Cluster DoT credit to ${printable(dot.casterUsername)} failed: ${error}`);
    });
  }

  /** A stand-in for the caster, built on their mirror when there is one, as playerhits.ts casterFor does. */
  killer(dot: DotInstance): any {
    const mirror = this.deps.mirror(dot.casterId);
    return {
      ...(mirror ?? {}),
      id: dot.casterId,
      username: mirror?.username ?? dot.casterUsername,
      remote: true,
      wt: undefined,
      aoi: undefined,
    };
  }
}

/** The credit a node sent, as far as its shape goes, or null. Names are cut to 64 characters. */
export function checkedCredit(body: unknown): DotCreditBody | null {
  const b = body as Partial<DotCreditBody> | null;
  if (!b || typeof b !== "object" || typeof b.victimId !== "string" || !b.victimId || typeof b.killed !== "boolean") return null;
  const victimId = printable(b.victimId);
  if (!victimId) return null;
  return { victimId, victimName: printable(b.victimName), killed: b.killed };
}

export interface ApplyCreditDeps {
  setPvp(player: any): void;
  mirror(id: string): any | null;
  emitDeath(victim: any, killer: any): void;
  /**
   * Whether the id is a player on this node. A DoT on a local player ticks here and never reaches this node as a
   * credit, so a peer that names one is lying about a death it cannot have caused. Without it nothing is refused.
   */
  local?(id: string): boolean;
}

/**
 * The caster's node: the caster enters PvP as if the tick had landed here, and a kill is emitted as PLAYER_DEATH
 * with the caster as the killer and the victim's mirror (or a stub marked remote) as the player.
 */
export function applyDotCredit(caster: any, body: unknown, deps: ApplyCreditDeps): boolean {
  const credit = checkedCredit(body);
  if (!credit || !caster || caster.remote || String(caster.id) === credit.victimId) return false;
  if (credit.killed && deps.local?.(credit.victimId)) return false;
  deps.setPvp(caster);
  caster.last_attack = performance.now();
  if (credit.killed) {
    const victim = deps.mirror(credit.victimId) ?? { id: credit.victimId, username: credit.victimName, remote: true };
    deps.emitDeath(victim, caster);
  }
  return true;
}

/** This node's credit sender: set as the remote DoT caster by the cluster (Task 13), never otherwise. */
export const dotCredit = new DotCredit({
  now: Date.now,
  send: (casterUsername, body) => runOnPlayer(casterUsername, "cells-dot-credit", body),
  mirror: (id) => mirrorPlayers.get(String(id)) ?? null,
});

registerPlayerAction("cells-dot-credit", (caster, body) => {
  applyDotCredit(caster, body, {
    setPvp: (player) => setPlayerPvp(player, true),
    mirror: (id) => mirrorPlayers.get(String(id)) ?? null,
    emitDeath: (victim, killer) => listener.emit(Events.PLAYER_DEATH, { player: victim, killer } as any),
    local: (id) => playerCache.get(id) !== undefined,
  });
});
