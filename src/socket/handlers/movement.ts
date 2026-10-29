import AOI_CONFIG from "../../config/aoi.json";
import gameLoop from "../../services/gameloop";
import layerManager from "../../services/layermanager";
import log from "../../modules/logger";
import { ghosts } from "../../cluster/ghosts";
import { playerHandoff } from "../../cluster/handoff";
import player from "../../systems/player.ts";
import spatialGrid from "../../services/spatialgrid";
import spellEffects from "../../systems/spelleffects";
import { Events } from "../../systems/events";
import { TICK_MS, cadenceDue, scaledStep } from "../../services/tickrate";
import { listener } from "../../modules/event_bus";
import { packetManager } from "../packet_manager";
import { syncNpcChunks, preloadNpcsAt } from "../../systems/npcStreaming";
import { updatePlayerAOI, shouldUpdateAOI, broadcastToAOI, handleMapChangeAOI } from "../aoi";
import packetReceiver from "../receiver";
import { PROFILE, VALID_DIRECTIONS, WARP_SCAN_MS, bumpStateRevision, checkGhostReviveProximity, despawnBatchQueue, forceStopPlayerMovement, getDirectionOffsets, getInventorySlots, interruptPlayerCast, isInteriorMap, mapPropertiesCache, maps, movementBatchQueue, prof, queueFinalMovement, resyncNpcChunks, sendPacket, sendPositionAnimation, spawnBatchQueue, stateRevision, subscriptionLocked, transitionPlayerToMap, warpInterceptors } from "../receiver";
import { recoverResumedWalk, resumeCatchUpSteps } from "../arrival";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["MOVEXY", "TELEPORTXY", "MOUNT"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, server, type, wt } = ctx;
  switch (type) {

      case "MOVEXY": {
        if (!currentPlayer) return;

        // MOVEXY is dispatched fire-and-forget (PROCESS_IMMEDIATELY, no await in
        // server.ts) so multiple handlers for one connection interleave across
        // their await points. Stamp this invocation with a monotonic generation;
        // a newer MOVEXY bumps past it, marking any suspended older handler stale
        // so it won't (re)register the player as moving after a later "abort".
        const moveSeq = ++currentPlayer._moveSeq;

        await player.preloadMapCollision(currentPlayer.location.map);

        // px per 30 Hz tick (180 px a second); scaledStep keeps that speed at any TICK_RATE.
        const baseSpeed = 6;
        const mountSpeedMultiplier = 1.35;

        const direction = data.toString().toLowerCase();

        // The first move of a player who came by a handoff: the new node says how long taking them in took.
        if (wt.data?.handoffLanding && direction !== "abort") {
          wt.data.handoffLanding = false;
          playerHandoff.firstMove(String(wt.data.ticketToken ?? ""));
        }

        // The first MOVEXY of a resumed handoff walk takes what it makes up (receiver.ts); any other drops it.
        const resumeCatchUp = wt.data?.resumeCatchUp;
        if (resumeCatchUp) wt.data.resumeCatchUp = undefined;

        if (direction === "abort") {
          // The key was let go: the next warp walked into is meant (see _warpHold below).
          currentPlayer._warpHold = undefined;
          await forceStopPlayerMovement(currentPlayer);
          return;
        }

        // Corpses awaiting release cannot move. Ghosts can (mounted speed),
        // except during the release cinematic's pending teleport window.
        if (currentPlayer.isDead || currentPlayer.ghostTeleportPending) {
          await forceStopPlayerMovement(currentPlayer);
          return;
        }

        // A newer MOVEXY (another direction, or an "abort") arrived while this
        // handler was awaiting above - it is now authoritative. Drop this one.
        if (currentPlayer._moveSeq !== moveSeq) {
          return;
        }

        if (currentPlayer.casting && currentPlayer.interruptableSpell) {
          await interruptPlayerCast(currentPlayer);
        }

        if (!VALID_DIRECTIONS.has(direction)) return;

        // Turning is new input too: a warp may take the player again.
        if (currentPlayer._warpHold && currentPlayer._warpHold !== direction) currentPlayer._warpHold = undefined;

        // Stunned players cannot move. stunnedUntil is an epoch timestamp
        // (Date.now()-based), so it must be compared against Date.now().
        if (currentPlayer.stunnedUntil && currentPlayer.stunnedUntil > Date.now()) {
          return;
        }

        // Mid-cast (a can_move spell; the rest were interrupted above) the key
        // changes where the caster walks, not where they face: they stay turned
        // toward the target until restoreWalkingFacing runs at cast end. A cast
        // on self has no target to face, so the caster turns as usual.
        const facing = currentPlayer.casting && !currentPlayer.castOnSelf
          ? currentPlayer.location.position.direction || direction
          : direction;
        currentPlayer.location.position.direction = facing || "down";
        currentPlayer.moving = true;
        ghosts.touch("player", currentPlayer.id);

        // Track direction changes for smooth transitions
        if (!currentPlayer._movementState) {
          currentPlayer._movementState = {
            currentDirection: direction,
            targetDirection: direction,
            directionChangeTime: 0,
          };
        } else {
          // A new direction starts its own sub-px carry (scaledStep): the old one's would push the first step off.
          if (currentPlayer._movementState.targetDirection !== direction) currentPlayer._stepCarry = undefined;
          currentPlayer._movementState.targetDirection = direction;
          currentPlayer._movementState.directionChangeTime = Date.now();
        }

        bumpStateRevision();
        await sendPositionAnimation(
          wt,
          currentPlayer.location.position.direction,
          true,
          currentPlayer.mounted,
          currentPlayer.mount_type || "unicorn",
          undefined,
          stateRevision(),
          currentPlayer.casting || false
        );

        const wasAlreadyMoving = gameLoop.isPlayerMoving(currentPlayer.id);

        const movePlayer = async () => {

          if (!wt || wt.readyState !== 1) {
            gameLoop.unregisterMovingPlayer(currentPlayer.id);
            return;
          }

          // A newer MOVEXY superseded the packet that registered this callback
          // (e.g. an "abort" that raced past this handler). Stop rather than
          // keep stepping - the client believes it has stopped.
          if (currentPlayer._moveSeq !== moveSeq) {
            await forceStopPlayerMovement(currentPlayer);
            return;
          }

          // Safety net: if a stun landed mid-movement and the stun handler's
          // force-stop somehow didn't unregister us, halt here rather than
          // waiting for a client ABORT that may never arrive.
          if (spellEffects.isStunned(currentPlayer)) {
            await forceStopPlayerMovement(currentPlayer);
            return;
          }

          const tempPosition = { ...currentPlayer.location.position };
          const playerHeight = 40;
          const playerWidth = 24;

          const speed = (currentPlayer.mounted || currentPlayer.isGhost ? baseSpeed * mountSpeedMultiplier : baseSpeed) * (currentPlayer.slowMultiplier || 1);

          // Offsets are derived from a shared static unit table (see
          // DIRECTION_UNIT_OFFSETS) rather than rebuilding a 9-object literal
          // on every tick of every moving player.
          const directionOffsets = getDirectionOffsets(speed);

          // This tick's offset, as a 30 Hz tick takes it (scaledStep below makes it this tick's move).
          let stepX = 0;
          let stepY = 0;

          // Handle direction transitions smoothly
          let activeDirection = direction;
          if (currentPlayer._movementState) {
            const timeSinceDirectionChange = Date.now() - currentPlayer._movementState.directionChangeTime;
            const DIRECTION_TRANSITION_TIME = 50; // ms to blend direction changes

            if (timeSinceDirectionChange < DIRECTION_TRANSITION_TIME &&
                currentPlayer._movementState.currentDirection !== currentPlayer._movementState.targetDirection) {
              // During transition: blend between old and new direction
              const transitionProgress = Math.min(1, timeSinceDirectionChange / DIRECTION_TRANSITION_TIME);

              const oldOffset = directionOffsets[currentPlayer._movementState.currentDirection] || directionOffsets.down;
              const newOffset = directionOffsets[currentPlayer._movementState.targetDirection] || directionOffsets.down;

              // Smoothly interpolate between old and new direction offsets
              const blendedOffset = {
                dx: oldOffset.dx + (newOffset.dx - oldOffset.dx) * transitionProgress,
                dy: oldOffset.dy + (newOffset.dy - oldOffset.dy) * transitionProgress,
              };

              stepX = blendedOffset.dx;
              stepY = blendedOffset.dy;
            } else {
              // Direction transition complete, use target direction
              if (currentPlayer._movementState.currentDirection !== currentPlayer._movementState.targetDirection) {
                currentPlayer._movementState.currentDirection = currentPlayer._movementState.targetDirection;
              }
              activeDirection = currentPlayer._movementState.currentDirection;
              const offset = directionOffsets[activeDirection];
              if (offset) {
                stepX = offset.dx;
                stepY = offset.dy;
              }
            }
          } else {
            const offset = directionOffsets[direction];
            if (offset) {
              stepX = offset.dx;
              stepY = offset.dy;
            }
          }

          // At 30 Hz the move is the offset rounded to whole px, as it always was. At another TICK_RATE it covers the
          // same px a second in smaller steps, the part of a px each leaves over carried to the next (_stepCarry).
          let moveX = scaledStep(stepX, currentPlayer._stepCarry?.x ?? 0);
          let moveY = scaledStep(stepY, currentPlayer._stepCarry?.y ?? 0);
          tempPosition.x = tempPosition.x + moveX.move;
          tempPosition.y = tempPosition.y + moveY.move;

          // Round for collision detection only
          const _profCollStart = PROFILE ? performance.now() : 0;
          const checkAt = (x: number, y: number) => player.checkCollisionSync(
            currentPlayer.location.map,
            {
              x: Math.round(x),
              y: Math.round(y),
              direction,
            },
            {
              width: playerWidth,
              height: playerHeight,
            }
          );
          let collision = checkAt(tempPosition.x, tempPosition.y);

          // A diagonal step into a wall only loses the blocked axis: the player slides along
          // the open one (e.g. moving upright under a wall keeps going right) instead of stopping.
          // Diagonal is read from the offset, not this tick's move: above 30 Hz a slow step can
          // move 0 px on one axis for a tick, and that tick's slide is then just no move.
          const startX = currentPlayer.location.position.x;
          const startY = currentPlayer.location.position.y;
          if (
            collision?.reason === "tile_collision" &&
            Math.round(stepX) !== 0 &&
            Math.round(stepY) !== 0
          ) {
            for (const slide of [{ x: tempPosition.x, y: startY }, { x: startX, y: tempPosition.y }]) {
              const slideCollision = checkAt(slide.x, slide.y);
              if (slideCollision?.reason !== "tile_collision") {
                tempPosition.x = slide.x;
                tempPosition.y = slide.y;
                collision = slideCollision;
                // The blocked axis carries nothing on.
                if (slide.y === startY) moveY = { move: 0, carry: 0 };
                else moveX = { move: 0, carry: 0 };
                break;
              }
            }
          }
          if (PROFILE) prof.collisionMs += performance.now() - _profCollStart;

          const isColliding = collision?.value === true;

          if (PROFILE && isColliding && !currentPlayer.isNoclip) {
            prof.collisionBlocks++;
            prof.collisionReasons[collision?.reason || "unknown"] =
              (prof.collisionReasons[collision?.reason || "unknown"] || 0) + 1;
          }

          if (!isColliding || currentPlayer.isNoclip) {
            currentPlayer.location.position.x = Math.round(tempPosition.x);
            currentPlayer.location.position.y = Math.round(tempPosition.y);
            // A handoff reads how long the walk has stood since (arrival.ts walkIdleMsOf).
            currentPlayer._lastStepAt = performance.now();
            ghosts.touch("player", currentPlayer.id);
            currentPlayer._stepCarry = { x: moveX.carry, y: moveY.carry };
            checkGhostReviveProximity(currentPlayer);
          }

          if (isColliding && !currentPlayer.isNoclip) {
            queueFinalMovement(currentPlayer);
            gameLoop.unregisterMovingPlayer(currentPlayer.id);
            currentPlayer.moving = false;
            ghosts.touch("player", currentPlayer.id);
            // Clean up movement state on collision
            if (currentPlayer._movementState) {
              currentPlayer._movementState = undefined;
            }
            currentPlayer._stepCarry = undefined;

            bumpStateRevision();
            await sendPositionAnimation(
              wt,
              currentPlayer.location.position.direction || direction,
              false,
              currentPlayer.mounted,
              currentPlayer.mount_type || "unicorn",
              undefined,
              stateRevision(),
              currentPlayer.casting || false
            );

            const reason = collision?.reason;

            if (reason === "tile_collision" && collision?.tile) {
              sendPacket(wt, packetManager.collisionDebug({
                tileX: collision.tile.x,
                tileY: collision.tile.y
              }));
            }

            if (reason === "warp_collision" && collision?.warp) {
              // Corpses and ghosts cannot use warps.
              if (currentPlayer.isDead || currentPlayer.isGhost) {
                return;
              }
              // Players in combat cannot use warps (admin summons bypass this path entirely)
              if (currentPlayer.pvp) {
                const nowTs = performance.now();
                if (!currentPlayer.lastCombatWarpNotify || nowTs - currentPlayer.lastCombatWarpNotify > 2000) {
                  currentPlayer.lastCombatWarpNotify = nowTs;
            sendPacket(
              wt,
              packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer))
            );
                }
                return;
              }
              const warp = collision.warp as {
                map: string;
                x: number;
                y: number;
              };

              // A warp sets its traveller down in front of the way back (a house's door, its room's door; a
              // cave's shaft, its mine door). Someone still holding the key they came in on would walk straight
              // back through. So the way they were walking does not take them through a warp again until they
              // let go of the key or turn (cleared at the top of this handler): until then a warp is a wall.
              if (currentPlayer._warpHold === direction) {
                return;
              }

              for (const interceptor of warpInterceptors) {
                if (await interceptor(warp, wt, currentPlayer, sendPacket)) {
                  return;
                }
              }

              currentPlayer._warpHold = direction;

              const currentMap = currentPlayer.location.map;

              // Saved as standing where the warp leads, or the warp is not taken. A row the database did not
              // change is not a refusal by itself: the account may already be saved there (see arriveAt). Read as
              // one, it left a player who came back inside by their home item unable to walk out the door.
              const arrived = await player.arriveAt(
                currentPlayer.id,
                warp.map.replace(".json", ""),
                {
                  x: warp.x || 0,
                  y: warp.y || 0,
                  direction: currentPlayer.location.position?.direction || "down",
                }
              );

              if (arrived) {
                const newMap = warp.map.replace(".json", "");
                const newPosition = {
                  x: warp.x || 0,
                  y: warp.y || 0
                };

                if (currentMap !== warp.map) {
                  await transitionPlayerToMap(currentPlayer, newMap, newPosition, wt, spawnBatchQueue, despawnBatchQueue);
                } else {
                  await handleMapChangeAOI(currentPlayer, newMap, newPosition, spawnBatchQueue, despawnBatchQueue);

                  currentPlayer.location.position.direction = currentPlayer.location.position?.direction || "down";

                  bumpStateRevision();

                  const movementData = {
                    i: wt.data.id,
                    d: {
                      x: Number(currentPlayer.location.position.x),
                      y: Number(currentPlayer.location.position.y),
                      dr: currentPlayer.location.position.direction
                    },
                    r: stateRevision(),
                    s: currentPlayer.isStealth ? 1 : 0
                  };
                  sendPacket(wt, packetManager.moveXY(movementData));
                }
              }
            }

            return;
          }

          bumpStateRevision();

          // Check for nearby warps and preload their destination maps.
          // Throttled: a player moves at most ~8px per tick and the trigger
          // radius is 100px, so scanning every warp on the map (plus a linear
          // mapPropertiesCache lookup and a Set allocation) on EVERY tick of
          // EVERY moving player was wasted work. Every 8th tick still leaves
          // ~35px of slack before the radius could be crossed unnoticed.
          // Kept in time (WARP_SCAN_MS, 8 ticks at 30 Hz) so the slack is the same at any TICK_RATE.
          const warpScanNow = performance.now();
          if (currentPlayer._warpScanAt === undefined) currentPlayer._warpScanAt = warpScanNow;
          const shouldScanWarps = cadenceDue(warpScanNow - currentPlayer._warpScanAt, WARP_SCAN_MS, TICK_MS);
          if (shouldScanWarps) currentPlayer._warpScanAt = warpScanNow;

          const mapNameWithJson = shouldScanWarps
            ? (currentPlayer.location.map.endsWith('.json')
              ? currentPlayer.location.map
              : `${currentPlayer.location.map}.json`)
            : null;
          const playerMapProperties = shouldScanWarps
            ? mapPropertiesCache.find((m: any) => m.name === mapNameWithJson)
            : null;
          if (playerMapProperties?.warps && Array.isArray(playerMapProperties.warps)) {
            const WARP_PRELOAD_DISTANCE = 100; // pixels
            const now = performance.now();
            const preloadedDestinations = new Set<string>();

            const warpPreloadDistanceSq = WARP_PRELOAD_DISTANCE * WARP_PRELOAD_DISTANCE;

            for (const warp of playerMapProperties.warps) {
              const warpX = warp.position?.x || warp.x;
              const warpY = warp.position?.y || warp.y;
              // Squared compare: Math.hypot is markedly slower and the actual
              // distance is never used, only the threshold test.
              const warpDx = currentPlayer.location.position.x - warpX;
              const warpDy = currentPlayer.location.position.y - warpY;
              const distanceSq = warpDx * warpDx + warpDy * warpDy;

              if (distanceSq < warpPreloadDistanceSq) {
                const destMapName = warp.map.replace(".json", "");

                if (!currentPlayer._warpPreloadTimes) {
                  currentPlayer._warpPreloadTimes = {};
                }

                // Skip if already preloaded
                if (currentPlayer._warpPreloadTimes[destMapName]) {
                  continue;
                }

                // Skip if already preloaded in this movement frame
                if (preloadedDestinations.has(destMapName)) {
                  continue;
                }

                // Mark as preloaded immediately to prevent re-preloading
                currentPlayer._warpPreloadTimes[destMapName] = now;
                preloadedDestinations.add(destMapName);

                try {
                  // Find the destination map
                  const destMap = maps.find((m: MapData) =>
                    m.name === (warp.map.endsWith('.json') ? warp.map : `${warp.map}.json`)
                  );

                  if (destMap) {
                    // Calculate chunks around the warp destination
                    const tilewidth = destMap.data?.tilewidth || 32;
                    const tileheight = destMap.data?.tileheight || 32;
                    const CHUNK_SIZE_CONFIG: { [key: number]: number } = {
                      16: 64,
                      32: 32,
                      64: 16,
                    };
                    const CHUNK_SIZE = CHUNK_SIZE_CONFIG[tilewidth] || 32;
                    const chunkPixelSize = CHUNK_SIZE * tilewidth;

                    const chunksX = Math.ceil((destMap.data?.width || 0) / CHUNK_SIZE);
                    const chunksY = Math.ceil((destMap.data?.height || 0) / CHUNK_SIZE);

                    // Clamp warp position to valid chunk range
                    let spawnChunkX = Math.floor(warpX / chunkPixelSize);
                    let spawnChunkY = Math.floor(warpY / chunkPixelSize);
                    spawnChunkX = Math.max(0, Math.min(spawnChunkX, Math.max(0, chunksX - 1)));
                    spawnChunkY = Math.max(0, Math.min(spawnChunkY, Math.max(0, chunksY - 1)));

                    const viewportWidth = 1920; // Standard viewport
                    const viewportHeight = 1080;
                    const padding = chunkPixelSize;

                    const chunksNeededX = Math.ceil(
                      (viewportWidth + padding * 2) / chunkPixelSize / 2
                    );
                    const chunksNeededY = Math.ceil(
                      (viewportHeight + padding * 2) / chunkPixelSize / 2
                    );

                    const chunksToPreload: Array<{ x: number; y: number; data?: any }> = [];
                    for (let dy = -chunksNeededY; dy <= chunksNeededY; dy++) {
                      for (let dx = -chunksNeededX; dx <= chunksNeededX; dx++) {
                        const chunkX = spawnChunkX + dx;
                        const chunkY = spawnChunkY + dy;
                        if (chunkX >= 0 && chunkY >= 0 && chunkX < chunksX && chunkY < chunksY) {
                          chunksToPreload.push({ x: chunkX, y: chunkY });
                        }
                      }
                    }

                    // and the NPCs round the arrival point (warp.x / warp.y), held by the client for that map
                    if (Number.isFinite(Number(warp.x)) && Number.isFinite(Number(warp.y))) {
                      const npcPreload = await preloadNpcsAt(currentPlayer, destMapName, Number(warp.x), Number(warp.y));
                      if (npcPreload.length) sendPacket(wt, npcPreload);
                    }

                    if (chunksToPreload.length > 0) {
                      sendPacket(
                        wt,
                        packetManager.preloadMapChunks({
                          mapName: destMapName,
                          chunks: chunksToPreload,
                          tilewidth: tilewidth,
                          tileheight: tileheight,
                          chunkSize: CHUNK_SIZE,
                          width: destMap.data?.width || 0,
                          height: destMap.data?.height || 0,
                          tilesets: destMap.data?.tilesets || [],
                        })
                      );
                    }
                  }
                } catch (err) {
                  log.warn(`Failed to preload warp chunks: ${err}`);
                }
              }
            }
          }

          // NPCs follow the map chunks round the player (npcStreaming); only does work when the player's chunk changed
          if (shouldScanWarps) {
            const npcPackets = await syncNpcChunks(currentPlayer);
            if (npcPackets.length) sendPacket(wt, npcPackets);
          }

          // The spatial grid follows every step, not only AOI updates, so grid
          // queries (AOI candidates, aggro, position sends) never lag a player
          // by more than one tick. Only does work when the 512 px cell changes.
          if (AOI_CONFIG.USE_SPATIAL_GRID && spatialGrid.hasPlayer(currentPlayer.id)) {
            spatialGrid.updatePlayer(
              currentPlayer.id,
              Number(currentPlayer.location.position.x),
              Number(currentPlayer.location.position.y),
              String(currentPlayer.location.map).replaceAll(".json", "")
            );
          }

          // Every AOI_UPDATE_MS of walking (10 ticks at 30 Hz), whatever the TICK_RATE.
          if (gameLoop.isAOIUpdateDue(currentPlayer.id) && shouldUpdateAOI(currentPlayer)) {
            // NOTE: timing lives inside updatePlayerAOI (see [profile:aoi]).
            // Wrapping the await here would charge this callback for every
            // other mover's work that runs while it's suspended.
            if (PROFILE) prof.aoiUpdateCount++;
            await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
          }

          const movementData = {
            i: wt.data.id,
            d: {
              x: Number(currentPlayer.location.position.x),
              y: Number(currentPlayer.location.position.y),
              dr: currentPlayer.location.position.direction
            },
            r: stateRevision(),
            s: currentPlayer.isStealth ? 1 : 0
          };

          if (wt.readyState === 1) {
            // Direct self-echo, every tick, as a datagram (binary moveXY, 0x02).
            // It is the client's only source for its own position - it ignores
            // its entry in the batches below. A lost echo is just a skipped
            // step: the client interpolates across it using the send time
            // each packet carries, and drops any that arrive out of order.
            // Other players learn about this mover via the batched flush below.
            sendPacket(wt, packetManager.moveXY(movementData));

            const layerId = currentPlayer.aoi?.layerId || layerManager.getPlayerLayer(currentPlayer.id);
            const groupKey = layerId || currentPlayer.location.map;
            if (!movementBatchQueue.has(groupKey)) {
              movementBatchQueue.set(groupKey, new Map());
            }
            movementBatchQueue.get(groupKey)!.set(currentPlayer.id, movementData);
          }

          if (PROFILE) prof.moveCbCount++;
        };

        // Final staleness check: if an "abort" (or newer direction) landed while
        // we were building the callback, that newer handler owns the movement
        // state now - don't (re)register from this stale one.
        if (currentPlayer._moveSeq !== moveSeq) {
          break;
        }

        // This handler is the newest and about to register the mover. A tick of the older mover that ran while this one
        // awaited above ended in forceStopPlayerMovement (its MOVEXY was superseded), which cleared `moving` and sent an
        // idle pose; a registered mover with `moving` false would show idle to the player and to viewers while they
        // walk. Put both back.
        if (recoverResumedWalk(currentPlayer, wt.data?.walkRecoverUntil, Date.now())) {
          await sendPositionAnimation(
            wt,
            currentPlayer.location.position.direction,
            true,
            currentPlayer.mounted,
            currentPlayer.mount_type || "unicorn",
            undefined,
            stateRevision(),
            currentPlayer.casting || false
          );
          // Another MOVEXY (or an abort) came while the pose was built: it owns the movement now.
          if (currentPlayer._moveSeq !== moveSeq) break;
        }

        gameLoop.registerMovingPlayer(currentPlayer.id, movePlayer);

        if (!wasAlreadyMoving) {
          await movePlayer();
          // A resumed handoff walk takes the steps of the ticks it stood still between the nodes at once. Each is a
          // step as any other (collisions, warps); a stop or a newer MOVEXY ends them.
          const catchUp = resumeCatchUpSteps(resumeCatchUp, direction, Date.now(), TICK_MS);
          for (let i = 0; i < catchUp && currentPlayer._moveSeq === moveSeq && gameLoop.isPlayerMoving(currentPlayer.id); i++) {
            await movePlayer();
          }
        }
        break;
      }

      case "TELEPORTXY": {
        if (!currentPlayer?.isAdmin) return;
        const prevDirection = currentPlayer.location.position?.direction;
        currentPlayer.location.position = data;
        currentPlayer.location.position.direction =
          (data as any).direction || prevDirection || "down";

        currentPlayer.location.position.x = Math.round(
          Number(currentPlayer.location.position.x)
        );
        currentPlayer.location.position.y = Math.round(
          Number(currentPlayer.location.position.y)
        );
        bumpStateRevision();
        ghosts.touch("player", currentPlayer.id);

        if (shouldUpdateAOI(currentPlayer)) {
          await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
        }

        const movementData = {
          i: wt.data.id,
          d: {
            x: Number(currentPlayer.location.position.x),
            y: Number(currentPlayer.location.position.y),
            dr: currentPlayer.location.position.direction
          },
          r: stateRevision(),
          s: currentPlayer.isStealth ? 1 : 0
        };
        broadcastToAOI(currentPlayer, packetManager.moveXY(movementData), true);
        // a teleport skips the walk that would stream in the NPCs round the new spot (npcStreaming)
        await resyncNpcChunks(currentPlayer, wt);
        break;
      }

      case "MOUNT": {
        if (!currentPlayer) return;

        // Dismounting if mounted is already true
        const dismounting = currentPlayer.mounted === true;
        // Getting off stays allowed: only mounting is locked.
        if (!dismounting && subscriptionLocked(wt, currentPlayer, "mount")) return;


        // Prevent mounting while casting
        if (currentPlayer.casting && !dismounting) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Cannot mount while casting." })
          );
          return;
        }

        // Prevent mounting when PvP flag is enabled or vanished
        if ((currentPlayer.pvp || currentPlayer.isVanished) && !dismounting) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Cannot mount while in PvP." })
          );
          return;
        }

        // Corpses and ghosts cannot mount.
        if ((currentPlayer.isDead || currentPlayer.isGhost) && !dismounting) {
          return;
        }

        // No mount is ridden inside a building.
        if (!dismounting && isInteriorMap(currentPlayer.location?.map)) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Cannot mount indoors." })
          );
          return;
        }

        const canMount = player.canMount(currentPlayer);
        const mount = (data as any).mount;
        if (!mount) {
          sendPacket(
            wt,
            packetManager.notify({ message: "No mount type specified." })
          );
          break;
        }

        if (!canMount) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Mount feature is currently locked.",
              })
            );

            break;
          }

        if (!dismounting) {
          const hasMount = currentPlayer.collectables.some((c: any) => c.type === "mount" && c.item === mount);
          if (!hasMount) {
            sendPacket(
              wt,
              packetManager.notify({ message: "You do not have the specified mount." })
            );
            break;
          }
        }

        currentPlayer.mounted = !currentPlayer.mounted;

        if (currentPlayer.mounted) {
          currentPlayer.mount_type = mount;
        } else {
          currentPlayer.mount_type = null;
        }

        const direction = currentPlayer.location.position?.direction || "down";
        const walking = currentPlayer.moving || false;
        const mounted = currentPlayer.mounted;

        bumpStateRevision();

        await sendPositionAnimation(
          wt,
          direction,
          walking,
          mounted,
          currentPlayer.mount_type,
          currentPlayer.id,
          stateRevision(),
          currentPlayer.casting || false
        );

        if (gameLoop.isPlayerMoving(currentPlayer.id)) {

          const moveDirection = currentPlayer.location.position?.direction || "down";

          await packetReceiver(server, wt, JSON.stringify({ type: "MOVEXY", data: moveDirection }));
        }
        listener.emit(Events.PLAYER_MOUNT, { player: currentPlayer, mounted: currentPlayer.mounted, mountType: currentPlayer.mount_type });
        break;
      }
  }
}
