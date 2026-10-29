import AOI_CONFIG from "../../config/aoi.json";
import creatures from "../../systems/creatures";
import player from "../../systems/player.ts";
import playerCache from "../../services/playermanager.ts";
import { bareMap, mirrorPlayers } from "../../cluster/mirrors";
import { packetManager } from "../packet_manager";
import { pickPlayerAt } from "../../systems/playerpick";
import { PROFILE, currentTargetMap, inspectOnOwner, inspectPlayerData, isQuestRateLimited, prof, sendPacket, withMirrors } from "../receiver";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["SELECTPLAYER", "TARGETCLOSEST", "INSPECTPLAYER"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, type, wt } = ctx;
  switch (type) {

      case "SELECTPLAYER": {
        if (!currentPlayer) return;
        const location = data as unknown as LocationData;
        const cache = playerCache.list();

        // Players of neighbouring nodes (mirrors) on this map can be picked too.
        const players = Object.values(cache).filter(
          (p) => p.location.map === currentPlayer.location.map
        );
        for (const mirror of mirrorPlayers.values()) {
          if (bareMap(mirror.location?.map) === bareMap(currentPlayer.location.map)) players.push(mirror);
        }

        // Taps from touch devices get a wider pick area: a fingertip is far
        // less precise than a cursor. Where players overlap under the click,
        // the one the client draws on top wins; otherwise the nearest.
        const pickRange = (data as any)?.touch === true ? 49 : 35;
        const pickX = Math.floor(Number(location.x));
        const pickY = Math.floor(Number(location.y));
        // Corpses cannot be targeted (despawned for observers). Ghosts can be
        // targeted and interacted with, except while their graveyard teleport
        // is still pending (not rendered anywhere yet). Stealthed players are
        // drawn for admins only. None of them can be the one on top.
        const shown = players.filter(
          (p) => !p.isDead && !(p.isGhost && p.ghostTeleportPending) && !(p.isStealth && !currentPlayer.isAdmin)
        );
        const selectedPlayer: any = pickPlayerAt(shown, pickX, pickY, pickRange, currentPlayer.id);

        if (!selectedPlayer) {
          // Clicking only a corpse or a hidden player clears the selection.
          if (pickPlayerAt(players, pickX, pickY, pickRange, currentPlayer.id)) {
            currentPlayer.selectedPlayerId = null;
            sendPacket(wt, packetManager.selectPlayer({ id: wt.data.id, data: null }));
          }
          break;
        }
        // The AOI keeps the selected player visible past the visibility cap.
        currentPlayer.selectedPlayerId = selectedPlayer.id;
        const selectPlayerData = {
          id: selectedPlayer.id,
          username: selectedPlayer.username,
          stats: selectedPlayer.stats,
        };
        sendPacket(wt, packetManager.selectPlayer(selectPlayerData));
        break;
      }

      case "TARGETCLOSEST": {
        if (!currentPlayer) return;

        // Tab-target reach = AOI radius: you can target anyone you can actually
        // see rendered, even if no spell can reach them. Spell range is enforced
        // separately at cast time ("Target is out of range"), so a wider select
        // range never lets you hit something you couldn't before.
        const TARGETING_RANGE = (AOI_CONFIG as any).DEFAULT_RADIUS ?? 1000;
        const CONE_ANGLE = 90; // 90 degree cone (45 degrees on each side of facing direction)

        const _tcT0 = PROFILE ? performance.now() : 0;

        // Get all players on the same map
        // Players of neighbouring nodes (mirrors) in reach can be targeted too.
        const playersInRange = withMirrors(
          wt,
          TARGETING_RANGE,
          currentPlayer.location.map
        ).filter((p) => !p.isStealth && !p.isDead && !(p.isGhost && p.ghostTeleportPending) && p.id !== currentPlayer.id);

        const _tcT1 = PROFILE ? performance.now() : 0;

        // Find next player target using cone-based directional targeting with cycling
        const currentTargetId = currentTargetMap.get(currentPlayer.id) || null;
        const nextPlayer = player.getNextTargetInCone(
          currentPlayer,
          playersInRange,
          TARGETING_RANGE,
          currentTargetId,
          CONE_ANGLE
        );

        const _tcT2 = PROFILE ? performance.now() : 0;

        // Closest creature in the facing cone, cycling like players do.
        const creatureCandidates = creatures.coneTargets(currentPlayer, TARGETING_RANGE, CONE_ANGLE);
        let nextCreature: { id: number; distance: number } | null = null;
        if (creatureCandidates.length > 0) {
          const currentTargetId = currentTargetMap.get(currentPlayer.id) || null;
          const currentIndex = creatureCandidates.findIndex((c) => `c:${c.id}` === currentTargetId);
          nextCreature = currentIndex === -1 || currentIndex === creatureCandidates.length - 1
            ? creatureCandidates[0]
            : creatureCandidates[currentIndex + 1];
        }

        // Pick whichever is closer: the next player or the next creature.
        let targetToSelect: any = null;
        if (nextPlayer && nextCreature) {
          const playerPos = nextPlayer?.location?.position as any;
          const playerDistance = Math.hypot(currentPlayer.location.position.x - playerPos.x, currentPlayer.location.position.y - playerPos.y);
          targetToSelect = playerDistance < nextCreature.distance ? nextPlayer : nextCreature;
        } else {
          targetToSelect = nextPlayer || nextCreature;
        }
        if (targetToSelect) {
          // Update current target for cycling
          currentTargetMap.set(currentPlayer.id, targetToSelect.stats ? targetToSelect.id : `c:${targetToSelect.id}`);
          // The AOI keeps the selected player visible past the visibility cap.
          currentPlayer.selectedPlayerId = targetToSelect.stats ? targetToSelect.id : null;

          if (targetToSelect.stats) {
            // It's a player
            const selectPlayerData = {
              id: targetToSelect.id || null,
              username: targetToSelect.username || null,
              stats: targetToSelect.stats || null,
            };
            sendPacket(wt, packetManager.selectPlayer(selectPlayerData));
          } else {
            sendPacket(wt, packetManager.creatureTargeted({ id: targetToSelect.id }));
          }
        }
        if (PROFILE) {
          const now = performance.now();
          prof.tcFilterMs += _tcT1 - _tcT0;
          prof.tcConeMs += _tcT2 - _tcT1;
          prof.tcCreatureMs += now - _tcT2;
          prof.tcCount++;
        }
        break;
      }

      case "INSPECTPLAYER": {
        if (currentPlayer) {
          const targetId = (data as any)?.id;

          // A player of a neighbouring node is inspected where they are: that node sends the answer (cells-inspect).
          // That is a message to another node, so a client cannot ask without limit; the inspect of a player here is left as it was.
          if (targetId && !playerCache.get(targetId) && mirrorPlayers.has(String(targetId)) && isQuestRateLimited(`inspect:${currentPlayer.id}`)) break;
          if (await inspectOnOwner(currentPlayer, targetId)) break;
          const found = targetId
            ? playerCache.get(targetId)
            : currentPlayer;
          // A stealthed admin is not there to anyone but admins.
          const targetPlayer = found && found !== currentPlayer && found.isStealth && !currentPlayer.isAdmin ? null : found;

          if (targetPlayer) {
            // Their whole inventory to themselves and to admins. Anyone else gets only the rows of
            // what they wear, which is all the inspect window draws (each slot's icon and tooltip).
            const whole = targetPlayer === currentPlayer || targetPlayer.id === currentPlayer.id || currentPlayer.isAdmin;
            sendPacket(wt, packetManager.inspectPlayer(inspectPlayerData(targetPlayer, whole)));
          }
        }
        break;
      }
  }
}
