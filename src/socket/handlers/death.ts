import * as resurrection from "../../systems/resurrection";
import log from "../../modules/logger";
import player from "../../systems/player.ts";
import playerCache from "../../services/playermanager.ts";
import spellEffects from "../../systems/spelleffects";
import { Events } from "../../systems/events";
import { listener } from "../../modules/event_bus";
import { packetManager } from "../packet_manager";
import { GHOST_TELEPORT_DELAY_MS, REVIVE_OFFER_RADIUS, bumpStateRevision, filterPlayersByMap, findGraveyardSpawn, forceStopPlayerMovement, resyncNpcChunks, sendPacket, sendStatsToPartyMembers, stateRevision } from "../receiver";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["RELEASE_SPIRIT", "CONFIRM_REVIVE", "CONFIRM_GRAVEYARD_REVIVE"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, type } = ctx;
  switch (type) {

      case "RELEASE_SPIRIT": {
        if (!currentPlayer) return;
        // Only a corpse awaiting release can release. Ghosts are already out.
        if (!currentPlayer.isDead || currentPlayer.isGhost || currentPlayer.ghostTeleportPending) return;

        const spawn = findGraveyardSpawn(
          currentPlayer.location.map,
          currentPlayer.location.position.x,
          currentPlayer.location.position.y
        );
        currentPlayer.stats.health = 0;
        currentPlayer.stats.stamina = 0;
        // Belt and braces: ghosts move at mounted speed with no lingering
        // combat modifiers (death already resets these, keep them clean here).
        currentPlayer.slowPercent = 0;
        currentPlayer.slowMultiplier = 1;
        currentPlayer.stunnedUntil = 0;
        currentPlayer.isDead = false;
        currentPlayer.isGhost = true;
        currentPlayer.reviveOffered = false;
        currentPlayer.ghostTeleportPending = true;
        await forceStopPlayerMovement(currentPlayer);
        // Server state moves now so SAVE/logout/disconnect all agree on the
        // graveyard (relog lands there). Only the moveXY broadcast waits for
        // the client's mid-black moment below.
        currentPlayer.location.position = { x: spawn.x, y: spawn.y, direction: "down" };
        playerCache.set(currentPlayer.id, currentPlayer);
        try {
          await player.setDeadState(currentPlayer.username, 2, currentPlayer.corpse);
        } catch (e: any) {
          log.error(`Failed to persist ghost state for ${currentPlayer.username}: ${e?.message || e}`);
        }

        // Announce ghost form immediately: it starts the client's ~5s release
        // cinematic and carries the destination so graveyard chunks preload.
        // pendingTeleport keeps observers from rendering the ghost at the
        // corpse; the confirm at teleport time is their spawn signal.
        bumpStateRevision();
        const releaseMap = currentPlayer.location.map;
        const releaseId = currentPlayer.id;
        filterPlayersByMap(releaseMap).forEach((p) => {
          sendPacket(
            p.wt,
            packetManager.playerGhost({ id: releaseId, ghost: true, x: spawn.x, y: spawn.y, map: releaseMap, pendingTeleport: true })
          );
        });
        listener.emit(Events.PLAYER_GHOST_RELEASED, { player: currentPlayer });

        setTimeout(() => {
          const p = playerCache.get(releaseId);
          if (!p || !p.isGhost || !p.ghostTeleportPending) return;
          p.ghostTeleportPending = false;
          playerCache.set(p.id, p);
          void resyncNpcChunks(p, p.wt); // the graveyard's NPCs
          bumpStateRevision();
          filterPlayersByMap(p.location.map).forEach((v) => {
            sendPacket(
              v.wt,
              packetManager.moveXY({
                i: p.id,
                d: { x: spawn.x, y: spawn.y, dr: "down" },
                r: stateRevision(),
                s: p.isStealth ? 1 : 0
              })
            );
            // Ghost spawn signal: render from here, at the graveyard.
            sendPacket(
              v.wt,
              packetManager.playerGhost({ id: p.id, ghost: true, x: spawn.x, y: spawn.y, map: p.location.map })
            );
          });
        }, GHOST_TELEPORT_DELAY_MS);
        break;
      }

      case "CONFIRM_REVIVE": {
        if (!currentPlayer) return;
        // Rejecting a confirm revokes the offer client-side so a stale popup
        // can never linger: it only hides on this verdict or on REVIVE.
        const denyRevive = () => {
          currentPlayer.reviveOffered = false;
          if (currentPlayer.wt) {
            sendPacket(currentPlayer.wt, packetManager.reviveOffer({ revoked: true }));
          }
        };
        // Only a ghost standing at its own corpse can revive.
        if (!currentPlayer.isGhost) return;
        if (!currentPlayer.corpse) {
          denyRevive();
          return;
        }
        if (currentPlayer.corpse.map !== currentPlayer.location.map) {
          denyRevive();
          return;
        }
        const dx = currentPlayer.location.position.x - currentPlayer.corpse.x;
        const dy = currentPlayer.location.position.y - currentPlayer.corpse.y;
        if (dx * dx + dy * dy > REVIVE_OFFER_RADIUS * REVIVE_OFFER_RADIUS) {
          denyRevive();
          return;
        }

        currentPlayer.stats.health = Math.round(currentPlayer.stats.total_max_health * 0.5);
        currentPlayer.stats.stamina = Math.round(currentPlayer.stats.total_max_stamina * 0.5);
        currentPlayer.isDead = false;
        currentPlayer.isGhost = false;
        currentPlayer.corpse = null;
        currentPlayer.reviveOffered = false;
        playerCache.set(currentPlayer.id, currentPlayer);
        try {
          await player.setDeadState(currentPlayer.username, 0, null);
        } catch (e: any) {
          log.error(`Failed to clear death state for ${currentPlayer.username}: ${e?.message || e}`);
        }

        bumpStateRevision();
        const playersInMap = filterPlayersByMap(currentPlayer.location.map);
        playersInMap.forEach((p) => {
          sendPacket(
            p.wt,
            packetManager.playerGhost({ id: currentPlayer.id, ghost: false })
          );
          sendPacket(
            p.wt,
            packetManager.revive({
              id: currentPlayer.id,
              target: currentPlayer.id,
              stats: currentPlayer.stats,
            })
          );
        });
        sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
        listener.emit(Events.PLAYER_REVIVED, { player: currentPlayer });
        break;
      }

      case "CONFIRM_GRAVEYARD_REVIVE": {
        if (!currentPlayer) return;
        // Only a ghost may resurrect at the graveyard. No distance check:
        // skipping the corpse run is the point, Resurrection Sickness is
        // the price (15 min: -20% health, -10% all other stats).
        if (!currentPlayer.isGhost || currentPlayer.isDead) return;

        resurrection.applySickness(currentPlayer);
        const synced = await player.synchronizeStats(currentPlayer.username);
        if (synced) {
          currentPlayer.stats = synced;
        }
        currentPlayer.stats.health = Math.round(currentPlayer.stats.total_max_health * 0.5);
        currentPlayer.stats.stamina = Math.round(currentPlayer.stats.total_max_stamina * 0.5);
        currentPlayer.isDead = false;
        currentPlayer.isGhost = false;
        currentPlayer.corpse = null;
        currentPlayer.reviveOffered = false;
        currentPlayer.ghostTeleportPending = false;
        playerCache.set(currentPlayer.id, currentPlayer);
        try {
          await player.setDeadState(currentPlayer.username, 0, null);
        } catch (e: any) {
          log.error(`Failed to clear death state for ${currentPlayer.username}: ${e?.message || e}`);
        }

        bumpStateRevision();
        filterPlayersByMap(currentPlayer.location.map).forEach((p) => {
          sendPacket(
            p.wt,
            packetManager.playerGhost({ id: currentPlayer.id, ghost: false })
          );
          sendPacket(
            p.wt,
            packetManager.revive({
              id: currentPlayer.id,
              target: currentPlayer.id,
              stats: currentPlayer.stats,
            })
          );
        });
        spellEffects.broadcastEffectsUpdate(currentPlayer);
        sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
        sendPacket(
          currentPlayer.wt,
          packetManager.notify({ message: "You have been resurrected with Resurrection Sickness (15 min)." })
        );
        listener.emit(Events.PLAYER_REVIVED, { player: currentPlayer });
        break;
      }
  }
}
