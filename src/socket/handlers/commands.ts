import * as classEditor from "../../systems/classeditor";
import * as controlPanel from "../../systems/controlpanel";
import * as itemEditor from "../../systems/itemeditor";
import * as mailboxEditor from "../../systems/mailboxeditor";
import * as moderation from "../../systems/moderation";
import * as mountEditor from "../../systems/mounteditor";
import * as playerEditor from "../../systems/playereditor";
import * as questEditor from "../../systems/quests/editor";
import * as resurrection from "../../systems/resurrection";
import * as spellEditor from "../../systems/spelleditor";
import * as weatherApi from "../../systems/weatherapi";
import * as weatherEditor from "../../systems/weathereditor";
import achievements from "../../systems/achievements";
import assetCache from "../../services/assetCache";
import creatures from "../../systems/creatures";
import gathering from "../../systems/gathering";
import guilds from "../../systems/guild.ts";
import inventory from "../../systems/inventory";
import layerManager from "../../services/layermanager";
import log from "../../modules/logger";
import loot from "../../systems/loot";
import lootChest from "../../systems/lootChest";
import lootTable, { normalizeDropChance } from "../../systems/lootTable";
import mapIndex from "../../services/mapindex";
import parties from "../../systems/parties.ts";
import permissions, { canGrant, outranks } from "../../systems/permissions";
import player from "../../systems/player.ts";
import playerCache from "../../services/playermanager.ts";
import spellEffects from "../../systems/spelleffects";
import worlds from "../../systems/worlds";
import { Events } from "../../systems/events";
import { GuildPermission, refusalText } from "../../systems/guildranks";
import { audience as chatAudience } from "../../systems/chatgate";
import { broadcastWorld, deliverToPlayer, isOnline, runOnPlayer } from "../../cluster/deliver";
import { clearShared } from "../../cluster/clearguard";
import { decryptPrivateKey, decryptRsa, _privateKey } from "../../modules/cipher";
import { drainQueries } from "../../controllers/sqldatabase";
import { getPlayerSpriteSheetData, getIconUrl, getMountSpriteUrl } from "../../modules/spriteSheetManager";
import { ghosts } from "../../cluster/ghosts";
import { gracefulShutdown } from "../server.ts";
import { isWhitelistEnabled, setWhitelistEnabled } from "../../services/whitelist";
import { listener } from "../../modules/event_bus";
import { notifyLayerChanged, updatePlayerAOI, broadcastToAOI, findPlayersWithTargetInAOI } from "../aoi";
import { packetManager } from "../packet_manager";
import { randomBytes } from "../../modules/hash";
import { reloadMap } from "../../modules/assetloader";
import { resetCooldowns } from "../../systems/cooldowns";
import { setLock as setSubscriptionLock, isLockId as isSubscriptionLock, subscriptionState } from "../../systems/subscriptions";
import { forgetLook } from "../looks";
import { MAX_COMMAND_LENGTH, TORNADO, bumpStateRevision, channelLineOk, chatHearing, chatLinksOf, chatRateOk, constructMapMetadata, defaultMap, despawnBatchQueue, destinationLayerFor, draggedPlayersMap, filterPlayersByMap, getAnimationNameForDirection, guildDone, guildEditOk, handlePlayerDeath, isCiphertext, kickedFromGuild, mapPropertiesCache, maps, offerInvitation, officerChat, panelCommands, panelHears, pushGuild, queueSpawnForReceivers, randomPick, resolvedWeatherCache, restartState, reviveDeps, resyncNpcChunks, rowOf, sendAnimationTo, sendIgnoreAnswer, sendPacket, sendReport, sendToWholeMap, spawnBatchQueue, stateRevision, subscriptionLocked, transitionPlayerToMap, weatherShown, withSender, worldsCache } from "../receiver";
import { revivePlayer } from "../revive";
import { settleForAdmin, settleStoreAttached, settlingNotice } from "../../cluster/tradesettle";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["COMMAND", "NOCLIP", "STEALTH", "DRAG_PLAYER_START", "DRAG_PLAYER_STOP", "DRAG_UPDATE", "GET_ONLINE_PLAYERS"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, parsedMessage, type, wt } = ctx;
  switch (type) {

      case "NOCLIP": {
        if (!currentPlayer?.isAdmin) return;
        const isNoclip = await player.toggleNoclip(currentPlayer.username);
        currentPlayer.isNoclip = isNoclip;
        const noclipData = {
          id: wt.data.id,
          isNoclip: currentPlayer.isNoclip,
        };
        sendPacket(wt, packetManager.noclip(noclipData));
        break;
      }

      case "STEALTH": {
        if (!currentPlayer?.isAdmin) return;
        const isStealth = await player.toggleStealth(currentPlayer.username);
        currentPlayer.isStealth = isStealth;
        ghosts.touch("player", currentPlayer.id);
        const playersInMap = filterPlayersByMap(currentPlayer.location.map);
        const stealthData = {
          id: wt.data.id,
          isStealth: currentPlayer.isStealth,
        };
        sendPacket(wt, packetManager.stealth(stealthData));
        playersInMap.forEach((player) => {
          const stealthData = {
            id: wt.data.id,
            isStealth: currentPlayer.isStealth,
          };
          sendPacket(player.wt, packetManager.stealth(stealthData));
        });
        // Cluster mode: the viewers of this player's mirrors hear of it too. The despawn or spawn below goes
        // map-wide here; the mirror's node does that part itself when the stealth flag reaches the mirror.
        ghosts.relay("player", String(currentPlayer.id), packetManager.stealth(stealthData), false);
        if (isStealth) {
          // When stealthing, despawn from other players (admins can still see stealthed players)
          playersInMap.forEach((player) => {
            if (player.id === currentPlayer.id) return;
            if (player.isAdmin) return;
            forgetLook(player.wt, String(currentPlayer.id));
            sendPacket(player.wt, packetManager.despawnPlayer(currentPlayer.id as string));
          });
        } else if (!isStealth) {
          bumpStateRevision();
          // Spawn the admin to all other players using the same spawn packet format
          // First fetch sprite data asynchronously
          const animationName = getAnimationNameForDirection(
            currentPlayer.location.position?.direction || "down",
            !!currentPlayer.moving,
            !!currentPlayer.mounted,
            currentPlayer.mount_type,
            !!currentPlayer.casting
          );
          const playerSpriteData = await getPlayerSpriteSheetData(animationName, currentPlayer.equipment || null);
          const mountSpriteForBatch = currentPlayer.mount_type ? getMountSpriteUrl(currentPlayer.mount_type) : null;

          let spriteData = null;
          if (playerSpriteData?.bodySprite || playerSpriteData?.headSprite || mountSpriteForBatch) {
            spriteData = {
              mountSprite: mountSpriteForBatch,
              bodySprite: playerSpriteData.bodySprite || null,
              headSprite: playerSpriteData.headSprite || null,
              armorHelmetSprite: playerSpriteData.armorHelmetSprite || null,
              armorShoulderguardsSprite: playerSpriteData.armorShoulderguardsSprite || null,
              armorNeckSprite: playerSpriteData.armorNeckSprite || null,
              armorHandsSprite: playerSpriteData.armorHandsSprite || null,
              armorChestSprite: playerSpriteData.armorChestSprite || null,
              armorFeetSprite: playerSpriteData.armorFeetSprite || null,
              armorLegsSprite: playerSpriteData.armorLegsSprite || null,
              armorWeaponSprite: playerSpriteData.armorWeaponSprite || null,
              animationState: playerSpriteData.animationState,
            };
          }

          const nonAdminPlayers = playersInMap.filter((player) => {
            if (player.id === currentPlayer.id) return false;
            if (player.isAdmin) return false;
            return true;
          });

          queueSpawnForReceivers(currentPlayer, nonAdminPlayers, spriteData);

          for (const player of nonAdminPlayers) {
            const moveXYData = {
              i: wt.data.id,
              d: {
                x: Number(currentPlayer.location.position.x),
                y: Number(currentPlayer.location.position.y),
                dr: currentPlayer.location.position.direction
              },
              r: stateRevision(),
              s: currentPlayer.isStealth ? 1 : 0
            };

            if (currentPlayer.location.position?.direction) {
              sendPacket(player.wt, packetManager.moveXY(moveXYData));
            }
          }
        }
        listener.emit(Events.PLAYER_STEALTH_CHANGE, { player: currentPlayer, isStealth: currentPlayer.isStealth });
        break;
      }

      case "DRAG_PLAYER_START": {
        // Check for admin.drag or admin.* permission
        if (!currentPlayer || !Array.isArray(currentPlayer.permissions)) {
          sendPacket(wt, packetManager.notify({ message: "Permissions not loaded" }));
          break;
        }

        const hasPermission = currentPlayer.permissions.some(
          (p: string) => p === "admin.drag" || p === "admin.*"
        );

        if (!hasPermission) {
          break;
        }

        const targetPlayerId = (data as any)?.id;
        if (!targetPlayerId) break;

        const targetPlayer = playerCache.get(targetPlayerId);
        if (!targetPlayer) break;

        // Track that this player is being dragged
        draggedPlayersMap.set(targetPlayerId, wt.data.id);

        // Send confirmation to admin that drag started
        const dragStartData = {
          id: targetPlayerId,
          adminId: wt.data.id,
        };
        sendPacket(wt, packetManager.dragPlayerStart(dragStartData));

        // Notify all players on the map that drag started
        const playersInMap = filterPlayersByMap(targetPlayer.location.map);
        playersInMap.forEach((p) => {
          if (p.wt && p.wt.readyState === 1) {
            sendPacket(p.wt, packetManager.dragPlayerStart(dragStartData));
          }
        });
        break;
      }

      case "DRAG_PLAYER_STOP": {
        // Check for admin.drag or admin.* permission
        if (!currentPlayer || !Array.isArray(currentPlayer.permissions)) break;

        const hasPermission = currentPlayer.permissions.some(
          (p: string) => p === "admin.drag" || p === "admin.*"
        );

        if (!hasPermission) break;

        const targetPlayerId = (data as any)?.id;
        if (!targetPlayerId) break;

        const targetPlayer = playerCache.get(targetPlayerId);
        if (!targetPlayer) break;

        // Remove tracking that this player was being dragged
        draggedPlayersMap.delete(targetPlayerId);

        // Send confirmation to admin that drag stopped
        const dragStopData = {
          id: targetPlayerId,
          adminId: wt.data.id,
        };
        sendPacket(wt, packetManager.dragPlayerStop(dragStopData));

        // Notify all players on the map that drag stopped
        const playersInMap = filterPlayersByMap(targetPlayer.location.map);
        playersInMap.forEach((p) => {
          if (p.wt && p.wt.readyState === 1) {
            sendPacket(p.wt, packetManager.dragPlayerStop(dragStopData));
          }
        });

        // Save where they were put down. Once, here: the updates while they
        // are carried arrive twenty a second.
        try {
          await player.setLocation(targetPlayer.id, targetPlayer.location.map, targetPlayer.location.position);
        } catch (e) {
          log.error(`Failed to set location for dragged player: ${e}`);
        }
        break;
      }

      case "DRAG_UPDATE": {
        // Check for admin.drag or admin.* permission
        if (!currentPlayer || !Array.isArray(currentPlayer.permissions)) break;

        const hasPermission = currentPlayer.permissions.some(
          (p: string) => p === "admin.drag" || p === "admin.*"
        );

        if (!hasPermission) break;

        const targetPlayerId = (data as any)?.id;
        const newX = (data as any)?.x;
        const newY = (data as any)?.y;

        if (targetPlayerId === undefined || newX === undefined || newY === undefined) break;

        const targetPlayer = playerCache.get(targetPlayerId);
        if (!targetPlayer) break;

        // Update target player position without collision check (admin drag bypasses collision)
        targetPlayer.location.position.x = newX;
        targetPlayer.location.position.y = newY;

        // Update AOI boundaries for the dragged player to handle visibility changes.
        // The queues are what deliver the spawns: without them a player dragged
        // out of someone's range and back was marked visible but never re-sent,
        // so they stayed invisible (to the dragging admin included).
        await updatePlayerAOI(targetPlayer, spawnBatchQueue, despawnBatchQueue);

        // Broadcast position update to all players in AOI
        bumpStateRevision();
        const moveXYData = {
          i: targetPlayerId,
          d: {
            x: Number(newX),
            y: Number(newY),
            dr: targetPlayer.location.position.direction,
          },
          r: stateRevision(),
          s: targetPlayer.isStealth ? 1 : 0,
        };

        broadcastToAOI(targetPlayer, packetManager.moveXY(moveXYData), true);
        break;
      }

      case "COMMAND": {
        if (!currentPlayer) return;
        // Corpses keep party/whisper/guild chat; the allowlist is enforced
        // after parsing below. Ghosts keep all commands; only proximity say
        // (/s, the CHAT packet) is barred for them.
        if (currentPlayer.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }
        const _data = data as any;
        const command = _data?.command;
        const mode = _data?.mode;

        // A command line is text, or in decrypt mode one RSA block; capped before
        // it is split. Decrypting costs a private-key operation, so it is held to
        // the chat rate limit.
        if (mode === "decrypt" ? !isCiphertext(command) : typeof command !== "string") return;
        if (typeof command === "string" && command.length > MAX_COMMAND_LENGTH) {
          sendPacket(wt, packetManager.notify({ message: `Command too long (max ${MAX_COMMAND_LENGTH} characters).` }));
          return;
        }
        if (mode === "decrypt" && !chatRateOk(wt)) return;

        let decryptedMessage;
        if (mode && mode == "decrypt") {
          const encryptedMessage = Buffer.from(
            Object.values(command) as number[]
          );

          const privateKey = _privateKey;
          if (!privateKey) return;
          const decryptedPrivateKey = decryptPrivateKey(
            privateKey,
            process.env.RSA_PASSPHRASE || ""
          ).toString();
          decryptedMessage =
            decryptRsa(encryptedMessage, decryptedPrivateKey) || "";
          if (typeof decryptedMessage !== "string" || decryptedMessage.length > MAX_COMMAND_LENGTH) return;
        } else {
          decryptedMessage = command;
        }

        const commandParts = decryptedMessage.match(/[^\s"]+|"([^"]*)"/g) || [];
        // A command run for the control panel arrives already split: its
        // arguments are values, not chat text to parse.
        const panelCommand = panelCommands.get(parsedMessage);
        const commandName = panelCommand?.name ?? commandParts[0]?.toUpperCase();

        // Corpses may use chat channels only: no admin, tool, or other
        // commands while awaiting release.
        if (
          currentPlayer.isDead &&
          !["P", "PARTY", "W", "WHISPER", "G", "GUILD", "O", "OFFICER"].includes(commandName || "")
        ) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You cannot do that while dead." })
          );
          return;
        }

        const args = panelCommand?.args ?? commandParts
          .slice(1)
          .map((arg: any) => (arg.startsWith('"') ? arg.slice(1, -1) : arg));

        switch (commandName) {

          case "P":
          case "PARTY": {
            if (!currentPlayer) return;
            if (subscriptionLocked(wt, currentPlayer, "party_chat")) break;
            const message = args.join(" ");
            if (!message) {
              sendPacket(
                wt,
                packetManager.notify({ message: "Please provide a message" })
              );
              break;
            }
            if (!channelLineOk(wt, message)) break;

            const partyId = await player.getPartyIdByUsername(
              currentPlayer.username
            );
            if (!partyId) {
              sendPacket(
                wt,
                packetManager.notify({ message: "You are not in a party" })
              );
              break;
            }

            const partyMembers = await parties.getPartyMembers(partyId);
            if (partyMembers.length === 0 || !partyMembers) {
              sendPacket(
                wt,
                packetManager.notify({ message: "You are not in a party" })
              );
              break;
            }

            const partyHearing = await chatHearing(currentPlayer.username, "party", message, partyMembers);
            const partyLine = await chatLinksOf(message);

            partyMembers.forEach(async (member: any) => {
              if (!partyHearing.has(String(member).toLowerCase())) return;
              await deliverToPlayer(
                member,
                packetManager.partyChat({
                  id: wt.data.id,
                  message: partyLine.message,
                  ...(partyLine.links.length > 0 ? { links: partyLine.links } : {}),
                  username:
                    currentPlayer.username.charAt(0).toUpperCase() +
                    currentPlayer.username.slice(1),
                })
              );
            });

            if (!partyHearing.muted) listener.emit(Events.PARTY_CHAT, { player: currentPlayer, message, partyMembers } as any);
            break;
          }

          case "W":
          case "WHISPER": {
            if (subscriptionLocked(wt, currentPlayer, "whisper")) break;
            const username = args[0]?.toLowerCase() || null;
            if (!username) {
              const notifyData = {
                message: "Please provide a username",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const players = Object.values(playerCache.list());
            const targetPlayer = players.find(
              (p) => p.username.toLowerCase() === username.toLowerCase()
            );

            // In a cluster the target may be online on another node: their name is all there is of them here.
            if (!targetPlayer && !(await isOnline(username))) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const targetName: string = targetPlayer?.username ?? username;

            if (!channelLineOk(wt, args.slice(1).join(" "))) break;

            // The whisper is shown as sent either way: a muted player, or one
            // the target ignores, is not told that it went nowhere.
            const whispered = await chatAudience(currentPlayer.username, "whisper", args.slice(1).join(" "), [targetName]);
            const whisperLine = await chatLinksOf(args.slice(1).join(" "));
            const whisperLinks = whisperLine.links.length > 0 ? { links: whisperLine.links } : {};
            if (whispered.recipients.length > 0) {
              await deliverToPlayer(
                targetName,
                packetManager.whisper({
                  id: wt.data.id,
                  message: whisperLine.message,
                  ...whisperLinks,

                  username: `<- ${currentPlayer.username.charAt(0).toUpperCase() +
                    currentPlayer.username.slice(1)
                    }`,
                })
              );
            }

            sendPacket(
              wt,
              packetManager.whisper({
                id: targetPlayer?.id ?? null,
                message: whisperLine.message,
                ...whisperLinks,
                username: `-> ${targetName.charAt(0).toUpperCase() +
                  targetName.slice(1)
                  }`,
              })
            );

            break;
          }

          case "INVITE": {
            const username = args[0]?.toLowerCase() || null;
            if (!username) {
              sendPacket(
                wt,
                packetManager.notify({
                  message: "Usage: /invite <username>",
                })
              );
              break;
            }

            if (username === currentPlayer.username.toLowerCase()) {
              sendPacket(
                wt,
                packetManager.notify({
                  message: "You cannot invite yourself to a party.",
                })
              );
              break;
            }

            const players = Object.values(playerCache.list());
            // On this node, or (in a cluster) on another one: then only the name is known here.
            const targetPlayer: any = players.find(
              (p: any) => p.username && p.username.toLowerCase() === username.toLowerCase()
            );

            if (!targetPlayer && !(await isOnline(username))) {
              sendPacket(
                wt,
                packetManager.notify({
                  message: `Player ${username} is not online.`,
                })
              );
              break;
            }
            const targetName: string = targetPlayer?.username ?? username;

            if (targetPlayer?.id === currentPlayer.id) {
              sendPacket(
                wt,
                packetManager.notify({
                  message: "You cannot invite yourself to a party.",
                })
              );
              break;
            }

            // As before: this looks among the invitations the target sent, which never match.
            const existingInvite = targetPlayer?.invitations?.find(
              (invite: any) => invite?.type === "party" && invite?.from === currentPlayer.username
            );

            if (existingInvite) {
              sendPacket(
                wt,
                packetManager.notify({
                  message: `You have already sent a party invite to ${targetName}.`,
                })
              );
              break;
            }

            const player_username =
              currentPlayer.username.charAt(0).toUpperCase() +
              currentPlayer.username.slice(1);

            const invite_data = {
              action: "INVITE_PARTY",
              message: `${player_username} wants to invite you to their party`,
              originator: currentPlayer.id.toString(),
              authorization: randomBytes(16).toString(),
            };

            if (!(await offerInvitation(currentPlayer, targetName, invite_data)) && !targetPlayer) {
              sendPacket(wt, packetManager.notify({ message: `Player ${username} is not online.` }));
              break;
            }

            sendPacket(
              wt,
              packetManager.notify({
                message: `Invitation sent to ${targetName.charAt(0).toUpperCase() +
                  targetName.slice(1)
                  }`,
              })
            );

            break;
          }

          case "G":
          case "GUILD": {
            if (!currentPlayer) return;
            if (subscriptionLocked(wt, currentPlayer, "guild_chat")) break;
            const message = args.join(" ");
            if (!message) {
              sendPacket(wt, packetManager.notify({ message: "Please provide a message" }));
              break;
            }
            if (!channelLineOk(wt, message)) break;

            const guildId = currentPlayer.guild_id;
            if (!guildId) {
              sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
              break;
            }

            const allMembers = await guilds.getGuildMembers(guildId);
            if (!allMembers || allMembers.length === 0) {
              sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
              break;
            }

            if (!(await guilds.can(currentPlayer.username, GuildPermission.GUILD_CHAT_SPEAK))) {
              sendPacket(wt, packetManager.notify({ message: refusalText.no_permission }));
              break;
            }

            const guildMembers = await guilds.listeners(guildId, GuildPermission.GUILD_CHAT_LISTEN);
            const guildHearing = await chatHearing(currentPlayer.username, "guild", message, guildMembers);
            const guildLine = await chatLinksOf(message);

            for (const member of withSender(guildMembers, currentPlayer.username)) {
              if (!guildHearing.has(String(member).toLowerCase())) continue;
              await deliverToPlayer(
                member,
                packetManager.guildChat({
                  id: wt.data.id,
                  message: guildLine.message,
                  ...(guildLine.links.length > 0 ? { links: guildLine.links } : {}),
                  username:
                    currentPlayer.username.charAt(0).toUpperCase() +
                    currentPlayer.username.slice(1),
                })
              );
            }

            if (!guildHearing.muted) listener.emit(Events.GUILD_CHAT, { player: currentPlayer, message, guildMembers, guildId } as any);
            break;
          }

          case "O":
          case "OFFICER": {
            if (!currentPlayer) return;
            const officerLine = args.join(" ");
            if (!officerLine) {
              sendPacket(wt, packetManager.notify({ message: "Please provide a message" }));
              break;
            }
            await officerChat(wt, currentPlayer, officerLine);
            break;
          }

          case "GPROMOTE":
          case "GDEMOTE": {
            if (!currentPlayer) return;
            if (subscriptionLocked(wt, currentPlayer, "guild")) break;
            const target = args[0];
            if (!target) {
              sendPacket(wt, packetManager.notify({ message: "Please provide a username" }));
              break;
            }
            if (!guildEditOk(wt, commandName)) break;
            const up = commandName === "GPROMOTE";
            const result = up ? await guilds.promote(currentPlayer.username, target) : await guilds.demote(currentPlayer.username, target);
            if (!guildDone(wt, result)) break;
            await pushGuild(currentPlayer.guild_id);
            listener.emit(Events.GUILD_CHANGED, { type: up ? "promote" : "demote", guildId: currentPlayer.guild_id, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username, targetUsername: target });
            break;
          }

          case "GREMOVE": {
            if (!currentPlayer) return;
            if (subscriptionLocked(wt, currentPlayer, "guild")) break;
            const target = args[0];
            if (!target) {
              sendPacket(wt, packetManager.notify({ message: "Please provide a username" }));
              break;
            }
            if (!guildEditOk(wt, commandName)) break;
            const guildId = currentPlayer.guild_id;
            const kicked = await guilds.kick(currentPlayer.username, target);
            if (!guildDone(wt, kicked)) break;
            sendPacket(wt, packetManager.notify({ message: `${target} has been kicked from the guild` }));
            await pushGuild(guildId);
            await kickedFromGuild(currentPlayer, guildId, target);
            break;
          }

          case "GMOTD": {
            if (!currentPlayer) return;
            if (subscriptionLocked(wt, currentPlayer, "guild")) break;
            if (!guildEditOk(wt, commandName)) break;
            const result = await guilds.setMotd(currentPlayer.username, args.join(" "));
            if (!guildDone(wt, result) || result.changed === false) break;
            await pushGuild(currentPlayer.guild_id);
            listener.emit(Events.GUILD_CHANGED, { type: "motd", guildId: currentPlayer.guild_id, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username });
            break;
          }

          case "GLEADER": {
            if (!currentPlayer) return;
            if (subscriptionLocked(wt, currentPlayer, "guild")) break;
            const target = args[0];
            if (!target) {
              sendPacket(wt, packetManager.notify({ message: "Please provide a username" }));
              break;
            }
            if (!guildEditOk(wt, commandName)) break;
            const result = await guilds.transferLeader(currentPlayer.username, target);
            if (!guildDone(wt, result)) break;
            await pushGuild(currentPlayer.guild_id);
            listener.emit(Events.GUILD_CHANGED, { type: "transfer", guildId: currentPlayer.guild_id, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username, targetUsername: target });
            break;
          }

          case "GINVITE": {
            if (!currentPlayer) return;
            if (currentPlayer.isGuest) {
              sendPacket(wt, packetManager.notify({ message: "Please create an account to use that feature." }));
              break;
            }
            if (subscriptionLocked(wt, currentPlayer, "guild")) break;

            const guildId = currentPlayer.guild_id;
            if (!guildId) {
              sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
              break;
            }

            if (!(await guilds.can(currentPlayer.username, GuildPermission.INVITE))) {
              sendPacket(wt, packetManager.notify({ message: refusalText.no_permission }));
              break;
            }

            const username = args[0]?.toLowerCase() || null;
            if (!username) {
              sendPacket(wt, packetManager.notify({ message: "Usage: /ginvite <username>" }));
              break;
            }

            if (username === currentPlayer.username.toLowerCase()) {
              sendPacket(wt, packetManager.notify({ message: "You cannot invite yourself to your guild." }));
              break;
            }

            const players = Object.values(playerCache.list());
            // On this node, or (in a cluster) on another one: then only the name is known here.
            const targetPlayer: any = players.find(
              (p: any) => p.username && p.username.toLowerCase() === username.toLowerCase()
            );

            if (!targetPlayer && !(await isOnline(username))) {
              sendPacket(wt, packetManager.notify({ message: `Player ${username} is not online.` }));
              break;
            }
            const targetName: string = targetPlayer?.username ?? username;

            // A guest on another node is refused when they answer (INVITATION_RESPONSE).
            if (targetPlayer?.isGuest) {
              sendPacket(wt, packetManager.notify({ message: `${targetName} is a guest and cannot join a guild.` }));
              break;
            }

            const targetInGuild = await guilds.isInGuild(targetName);
            if (targetInGuild) {
              sendPacket(wt, packetManager.notify({ message: `${targetName} is already in a guild` }));
              break;
            }

            // As before: this looks among the invitations the target sent, which never match.
            const existingInvite = targetPlayer?.invitations?.find(
              (invite: any) => invite?.action === "INVITE_GUILD" && invite?.originator === currentPlayer.id.toString()
            );

            if (existingInvite) {
              sendPacket(wt, packetManager.notify({ message: `You have already sent a guild invite to ${targetName}.` }));
              break;
            }

            const player_username =
              currentPlayer.username.charAt(0).toUpperCase() +
              currentPlayer.username.slice(1);

            const guildName = currentPlayer.guild_name || "Unknown Guild";

            const invite_data = {
              action: "INVITE_GUILD",
              message: `${player_username} wants to invite you to join "${guildName}"`,
              originator: currentPlayer.id.toString(),
              authorization: randomBytes(16).toString(),
            };

            if (!(await offerInvitation(currentPlayer, targetName, invite_data)) && !targetPlayer) {
              sendPacket(wt, packetManager.notify({ message: `Player ${username} is not online.` }));
              break;
            }

            sendPacket(
              wt,
              packetManager.notify({
                message: `Invitation sent to ${targetName.charAt(0).toUpperCase() +
                  targetName.slice(1)}`,
              })
            );

            break;
          }

          case "SUMMON": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.summon" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const identifier = args[0]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(identifier))) {

              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              targetPlayer = playerCache.get(identifier);
            }

            if (!targetPlayer) {
              // A player on another node is summoned by that node (cells-summon, socket/receiver.ts): it checks
              // the admin rule, tells the player, and moves them, by a handoff when this point is not its own.
              // Only a name is asked for: an id is local to the node that gave it.
              const sent = isNaN(Number(identifier)) && (await runOnPlayer(identifier, "cells-summon", {
                by: currentPlayer.username,
                map: currentPlayer.location.map,
                x: Math.round(currentPlayer.location.position.x),
                y: Math.round(currentPlayer.location.position.y),
                why: "summon",
                admins: currentPlayer.permissions.some((p: string) => p === "admin.summonadmins" || p === "admin.*"),
              }));
              if (!sent) {
                sendPacket(wt, packetManager.notify({ message: "Player not found or is not online" }));
              }
              break;
            }

            if (targetPlayer.handoff) {
              // Its snapshot is taken: a move now would be lost on the node it is going to.
              sendPacket(wt, packetManager.notify({
                message: `${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)} is changing server node; try again`,
              }));
              break;
            }

            if (targetPlayer.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot summon yourself",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.isAdmin && !currentPlayer.permissions.some((p: string) => p === "admin.summonadmins" || p === "admin.*")) {
              const notifyData = {
                message: "You cannot summon other admins",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.location.map !== currentPlayer.location.map) {

              const result = await player.setLocation(
                targetPlayer.id,
                currentPlayer.location.map,
                {
                  x: currentPlayer.location.position.x,
                  y: currentPlayer.location.position.y,
                  direction: targetPlayer.location.position?.direction || "down",
                }
              );

              if (
                result &&
                typeof result === "object" &&
                "affectedRows" in result &&
                ((result as { affectedRows: number | null; count?: number }).affectedRows ?? (result as { count?: number }).count) != 0
              ) {
                if (!currentPlayer.forceVisibleTo) currentPlayer.forceVisibleTo = new Set();
                currentPlayer.forceVisibleTo.add(targetPlayer.id);

                playerCache.set(targetPlayer.id, targetPlayer);

                setTimeout(() => {
                  const admin = playerCache.get(currentPlayer.id);
                  if (admin?.forceVisibleTo) {
                    admin.forceVisibleTo.delete(targetPlayer.id);
                    playerCache.set(admin.id, admin);
                  }
                }, 5000);

                await transitionPlayerToMap(
                  targetPlayer,
                  currentPlayer.location.map,
                  {
                    x: Math.round(currentPlayer.location.position.x),
                    y: Math.round(currentPlayer.location.position.y),
                    direction: targetPlayer.location.position?.direction || "down",
                  },
                  targetPlayer.wt,
                  spawnBatchQueue,
                  despawnBatchQueue
                );

                sendPacket(
                  targetPlayer.wt,
                  packetManager.notify({
                    message: `You have been summoned by an admin`,
                  })
                );

                sendPacket(
                  wt,
                  packetManager.notify({
                    message: `Summoned ${targetPlayer.username.charAt(0).toUpperCase() +
                      targetPlayer.username.slice(1)
                      } to your location`,
                  })
                );
              } else {
                const notifyData = {
                  message: "Failed to summon player",
                };
                sendPacket(wt, packetManager.notify(notifyData));
              }
            } else {

              targetPlayer.location.position = {
                x: Math.round(currentPlayer.location.position.x),
                y: Math.round(currentPlayer.location.position.y),
                direction: targetPlayer.location.position?.direction || "down",
              };
              const summonedLayerId = destinationLayerFor(
                targetPlayer,
                currentPlayer.aoi?.layerId,
                layerManager.updatePlayerBlock(targetPlayer.id, targetPlayer.location.position.x, targetPlayer.location.position.y)
              );
              if (summonedLayerId) {
                layerManager.movePlayerToLayer(targetPlayer.id, summonedLayerId);
                targetPlayer.aoi.layerId = summonedLayerId;
                notifyLayerChanged(targetPlayer.id);
                log.info(`[SUMMON] ${targetPlayer.username} moved to layer ${summonedLayerId}`);
              }

              playerCache.set(targetPlayer.id, targetPlayer);

              await updatePlayerAOI(targetPlayer, spawnBatchQueue, despawnBatchQueue);
              await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
              await resyncNpcChunks(targetPlayer, targetPlayer.wt); // summoned within the map

              const targetAnimationNameForSprite = getAnimationNameForDirection(
                targetPlayer.location.position?.direction || "down",
                !!targetPlayer.moving,
                !!targetPlayer.mounted,
                targetPlayer.mount_type,
                !!targetPlayer.casting
              );
              const targetSpriteData = await getPlayerSpriteSheetData(targetAnimationNameForSprite, targetPlayer.equipment || null);

              let targetSpritesData = null;
              if (targetSpriteData?.bodySprite || targetSpriteData?.headSprite) {
                targetSpritesData = {
                  mountSprite: targetPlayer.mounted && targetPlayer.mount_type ? getMountSpriteUrl(targetPlayer.mount_type) : null,
                  bodySprite: targetSpriteData.bodySprite || null,
                  headSprite: targetSpriteData.headSprite || null,
                  armorHelmetSprite: targetSpriteData.armorHelmetSprite || null,
                  armorShoulderguardsSprite: targetSpriteData.armorShoulderguardsSprite || null,
                  armorNeckSprite: targetSpriteData.armorNeckSprite || null,
                  armorHandsSprite: targetSpriteData.armorHandsSprite || null,
                  armorChestSprite: targetSpriteData.armorChestSprite || null,
                  armorFeetSprite: targetSpriteData.armorFeetSprite || null,
                  armorLegsSprite: targetSpriteData.armorLegsSprite || null,
                  armorWeaponSprite: targetSpriteData.armorWeaponSprite || null,
                  animationState: targetSpriteData.animationState,
                };
              }

              const targetSpawnData = {
                id: targetPlayer.id,
                userid: targetPlayer.userid,
                location: {
                  map: targetPlayer.location.map,
                  x: targetPlayer.location.position.x,
                  y: targetPlayer.location.position.y,
                  direction: targetPlayer.location.position?.direction || "down",
                  moving: targetPlayer.moving || false,
                },
                username: targetPlayer.username,
                isAdmin: targetPlayer.isAdmin,
                isGuest: targetPlayer.isGuest,
                isStealth: targetPlayer.isStealth,
                isNoclip: targetPlayer.isNoclip,
                stats: targetPlayer.stats,
                animation: null,
                spriteData: targetSpritesData,
                mounted: targetPlayer.mounted,
                guild: targetPlayer.guild || [],
                guild_name: targetPlayer.guild_name || null,
              };

              forgetLook(wt, String(targetPlayer.id));
              sendPacket(wt, packetManager.loadPlayers({
                players: [targetSpawnData],
                snapshotRevision: stateRevision()
              }));

              const targetAnimationName = getAnimationNameForDirection(
                targetPlayer.location.position?.direction || "down",
                !!targetPlayer.moving,
                !!targetPlayer.mounted,
                targetPlayer.mount_type || undefined,
                !!targetPlayer.casting
              );
              await sendAnimationTo(wt, targetAnimationName, targetPlayer.id);

              bumpStateRevision();

              const targetMovementData = {
                i: targetPlayer.id,
                d: {
                  x: Number(targetPlayer.location.position.x),
                  y: Number(targetPlayer.location.position.y),
                  dr: targetPlayer.location.position.direction
                },
                r: stateRevision(),
                s: targetPlayer.isStealth ? 1 : 0
              };
              sendPacket(targetPlayer.wt, packetManager.moveXY(targetMovementData));

              sendPacket(wt, packetManager.moveXY(targetMovementData));

              // Everyone who now sees the summoned player (above the visibility
              // cap that is not the same as everyone the admin sees).
              for (const otherPlayer of findPlayersWithTargetInAOI(targetPlayer.id)) {
                if (!otherPlayer.wt || otherPlayer.id === targetPlayer.id || otherPlayer.id === currentPlayer.id) continue;

                const canSeeTarget = !targetPlayer.isStealth || otherPlayer.isAdmin;
                if (canSeeTarget) {
                  sendPacket(otherPlayer.wt, packetManager.moveXY(targetMovementData));
                }
              }

              sendPacket(
                targetPlayer.wt,
                packetManager.notify({
                  message: `You have been summoned by an admin`,
                })
              );

              sendPacket(
                wt,
                packetManager.notify({
                  message: `Summoned ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)
                    }`,
                })
              );
            }
            break;
          }

          case "GOTO":
          case "TELEPORT": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.summon" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const identifier = args[0]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(identifier))) {

              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {

              targetPlayer = playerCache.get(identifier);
            }

            if (!targetPlayer) {
              // A player on another node: that node sends back its player's point, and this admin is moved by the
              // admin's own node (cells-teleport-to, then cells-summon; Deviation 21). Only a name is asked for:
              // an id is local to the node that gave it.
              const sent = isNaN(Number(identifier)) && (await runOnPlayer(identifier, "cells-teleport-to", {
                by: currentPlayer.username,
                // The admin's own held permission, as /summon reads it: the target's node passes it on to the
                // cells-summon it sends back, and never makes one up.
                admins: currentPlayer.permissions.some((p: string) => p === "admin.summonadmins" || p === "admin.*"),
              }));
              if (!sent) {
                sendPacket(wt, packetManager.notify({ message: "Player not found or is not online" }));
              }
              break;
            }

            if (targetPlayer.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot teleport to yourself",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.location.map !== currentPlayer.location.map) {

              const result = await player.setLocation(
                currentPlayer.id,
                targetPlayer.location.map,
                {
                  x: targetPlayer.location.position.x,
                  y: targetPlayer.location.position.y,
                  direction: currentPlayer.location.position?.direction || "down",
                }
              );

              if (
                result &&
                typeof result === "object" &&
                "affectedRows" in result &&
                ((result as { affectedRows: number | null; count?: number }).affectedRows ?? (result as { count?: number }).count) != 0
              ) {
                if (!currentPlayer.forceVisibleTo) currentPlayer.forceVisibleTo = new Set();
                currentPlayer.forceVisibleTo.add(targetPlayer.id);

                playerCache.set(currentPlayer.id, currentPlayer);
                playerCache.set(targetPlayer.id, targetPlayer);

                setTimeout(() => {
                  const admin = playerCache.get(currentPlayer.id);
                  if (admin?.forceVisibleTo) {
                    admin.forceVisibleTo.delete(targetPlayer.id);
                    playerCache.set(admin.id, admin);
                  }
                }, 5000);

                await transitionPlayerToMap(
                  currentPlayer,
                  targetPlayer.location.map,
                  {
                    x: Math.round(targetPlayer.location.position.x),
                    y: Math.round(targetPlayer.location.position.y),
                    direction: currentPlayer.location.position?.direction || "down",
                  },
                  wt,
                  spawnBatchQueue,
                  despawnBatchQueue
                );

                sendPacket(
                  wt,
                  packetManager.notify({
                    message: `Teleported to ${targetPlayer.username.charAt(0).toUpperCase() +
                      targetPlayer.username.slice(1)
                      }'s location`,
                  })
                );
              } else {
                const notifyData = {
                  message: "Failed to teleport to player",
                };
                sendPacket(wt, packetManager.notify(notifyData));
              }
            } else {

              currentPlayer.location.position = {
                x: Math.round(targetPlayer.location.position.x),
                y: Math.round(targetPlayer.location.position.y),
                direction: currentPlayer.location.position?.direction || "down",
              };
              const teleportLayerId = destinationLayerFor(
                currentPlayer,
                targetPlayer.aoi?.layerId,
                layerManager.updatePlayerBlock(currentPlayer.id, currentPlayer.location.position.x, currentPlayer.location.position.y)
              );
              if (teleportLayerId) {
                layerManager.movePlayerToLayer(currentPlayer.id, teleportLayerId);
                currentPlayer.aoi.layerId = teleportLayerId;
                notifyLayerChanged(currentPlayer.id);
                log.info(`[TELEPORT] Admin ${currentPlayer.username} moved to layer ${teleportLayerId}`);
              }

              playerCache.set(currentPlayer.id, currentPlayer);

              await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
              await updatePlayerAOI(targetPlayer, spawnBatchQueue, despawnBatchQueue);
              await resyncNpcChunks(currentPlayer, wt); // teleported within the map

              const targetAnimationNameForSpriteTeleport = getAnimationNameForDirection(
                targetPlayer.location.position?.direction || "down",
                !!targetPlayer.moving,
                !!targetPlayer.mounted,
                targetPlayer.mount_type,
                !!targetPlayer.casting
              );
              const targetSpriteDataTeleport = await getPlayerSpriteSheetData(targetAnimationNameForSpriteTeleport, targetPlayer.equipment || null);

              let targetSpritesDataTeleport = null;
              if (targetSpriteDataTeleport?.bodySprite || targetSpriteDataTeleport?.headSprite) {
                targetSpritesDataTeleport = {
                  mountSprite: targetPlayer.mounted && targetPlayer.mount_type ? getMountSpriteUrl(targetPlayer.mount_type) : null,
                  bodySprite: targetSpriteDataTeleport.bodySprite || null,
                  headSprite: targetSpriteDataTeleport.headSprite || null,
                  armorHelmetSprite: targetSpriteDataTeleport.armorHelmetSprite || null,
                  armorShoulderguardsSprite: targetSpriteDataTeleport.armorShoulderguardsSprite || null,
                  armorNeckSprite: targetSpriteDataTeleport.armorNeckSprite || null,
                  armorHandsSprite: targetSpriteDataTeleport.armorHandsSprite || null,
                  armorChestSprite: targetSpriteDataTeleport.armorChestSprite || null,
                  armorFeetSprite: targetSpriteDataTeleport.armorFeetSprite || null,
                  armorLegsSprite: targetSpriteDataTeleport.armorLegsSprite || null,
                  armorWeaponSprite: targetSpriteDataTeleport.armorWeaponSprite || null,
                  animationState: targetSpriteDataTeleport.animationState,
                };
              }

              const targetSpawnDataTeleport = {
                id: targetPlayer.id,
                userid: targetPlayer.userid,
                location: {
                  map: targetPlayer.location.map,
                  x: targetPlayer.location.position.x,
                  y: targetPlayer.location.position.y,
                  direction: targetPlayer.location.position?.direction || "down",
                  moving: targetPlayer.moving || false,
                },
                username: targetPlayer.username,
                isAdmin: targetPlayer.isAdmin,
                isGuest: targetPlayer.isGuest,
                isStealth: targetPlayer.isStealth,
                isNoclip: targetPlayer.isNoclip,
                stats: targetPlayer.stats,
                animation: null,
                spriteData: targetSpritesDataTeleport,
                mounted: targetPlayer.mounted,
                guild: targetPlayer.guild || [],
                guild_name: targetPlayer.guild_name || null,
              };

              forgetLook(wt, String(targetPlayer.id));
              sendPacket(wt, packetManager.loadPlayers({
                players: [targetSpawnDataTeleport],
                snapshotRevision: stateRevision()
              }));

              const targetAnimationNameTeleport = getAnimationNameForDirection(
                targetPlayer.location.position?.direction || "down",
                !!targetPlayer.moving,
                !!targetPlayer.mounted,
                targetPlayer.mount_type || undefined,
                !!targetPlayer.casting
              );
              await sendAnimationTo(wt, targetAnimationNameTeleport, targetPlayer.id);

              bumpStateRevision();

              const adminMovementData = {
                i: currentPlayer.id,
                d: {
                  x: Number(currentPlayer.location.position.x),
                  y: Number(currentPlayer.location.position.y),
                  dr: currentPlayer.location.position.direction
                },
                r: stateRevision(),
                s: currentPlayer.isStealth ? 1 : 0
              };
              sendPacket(wt, packetManager.moveXY(adminMovementData));

              const targetMovementData = {
                i: targetPlayer.id,
                d: {
                  x: Number(targetPlayer.location.position.x),
                  y: Number(targetPlayer.location.position.y),
                  dr: targetPlayer.location.position.direction
                },
                r: stateRevision(),
                s: targetPlayer.isStealth ? 1 : 0
              };
              sendPacket(targetPlayer.wt, packetManager.moveXY(targetMovementData));

              broadcastToAOI(currentPlayer, packetManager.moveXY(adminMovementData), true);
              broadcastToAOI(targetPlayer, packetManager.moveXY(targetMovementData), true);

              sendPacket(
                wt,
                packetManager.notify({
                  message: `Teleported to ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)
                    }`,
                })
              );
            }
            break;
          }

          case "KICK":
          case "DISCONNECT": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.kick" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(identifier))) {

              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {

              targetPlayer = playerCache.get(identifier);
            }

            if (targetPlayer?.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot disconnect yourself",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (!targetPlayer) {
              // Not here: a player on another node (cluster mode) is disconnected where they are.
              if (isNaN(Number(identifier)) && (await isOnline(identifier))) {
                if (await player.isAdmin(identifier)) {
                  sendPacket(wt, packetManager.notify({ message: "You cannot disconnect other admins" }));
                  break;
                }
                if (await runOnPlayer(identifier, "admin-kick")) {
                  sendPacket(wt, packetManager.notify({ message: `Disconnected ${identifier.charAt(0).toUpperCase() + identifier.slice(1)} from the server` }));
                  break;
                }
              }
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.isAdmin) {
              const notifyData = {
                message: "You cannot disconnect other admins",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (!(await runOnPlayer(targetPlayer.username, "admin-kick"))) {
              sendPacket(wt, packetManager.notify({ message: "Player not found or is not online" }));
              break;
            }
            const notifyData = {
              message: `Disconnected ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } from the server`,
            };
            sendPacket(wt, packetManager.notify(notifyData));
            break;
          }

          case "NOTIFY":
          case "BROADCAST": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.notify" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            let message;
            let audience = "ALL";

            if (!args[0]) return;
            if (!["ALL", "ADMINS", "MAP"].includes(args[0].toUpperCase())) {
              message = args.join(" ");
            } else {
              audience = args[0].toUpperCase();
              message = args.slice(1).join(" ");
            }

            if (!message) return;

            switch (audience) {
              case "ALL": {
                // Every player on every node when clustered.
                const notifyData = {
                  message: message,
                };
                const announcement = packetManager.notify(notifyData);
                await broadcastWorld(announcement);
                panelHears(wt, announcement);
                break;
              }
              case "ADMINS": {
                const playersInMap = filterPlayersByMap(
                  currentPlayer.location.map
                );
                const playersInMapAdmins = playersInMap.filter(
                  (p) => p.isAdmin
                );
                playersInMapAdmins.forEach((player) => {
                  const notifyData = {
                    message: message,
                  };
                  sendPacket(player.wt, packetManager.notify(notifyData));
                });
                break;
              }
              case "MAP": {
                const playersInMap = filterPlayersByMap(
                  currentPlayer.location.map
                );
                playersInMap.forEach((player) => {
                  const notifyData = {
                    message: message,
                  };
                  sendPacket(player.wt, packetManager.notify(notifyData));
                });
                break;
              }
            }
            break;
          }

          case "MUTE": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.mute" || p === "admin.*"
              )
            ) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.notify({ message: await moderation.muteCommand(currentPlayer, args) }));
            break;
          }

          case "UNMUTE": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.unmute" || p === "admin.*"
              )
            ) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.notify({ message: await moderation.unmuteCommand(currentPlayer, args) }));
            break;
          }

          case "IGNORE": {
            await sendIgnoreAnswer(wt, await moderation.ignore(currentPlayer, args[0]));
            break;
          }

          case "UNIGNORE": {
            await sendIgnoreAnswer(wt, await moderation.unignore(currentPlayer, args[0]));
            break;
          }

          case "IGNORELIST": {
            sendPacket(wt, packetManager.notify({ message: await moderation.ignoreList(currentPlayer) }));
            break;
          }

          case "REPORT": {
            // From chat a report has no category to pick: the reason typed is what it says.
            const reason = args.slice(1).join(" ");
            if (!args[0] || !reason) {
              sendPacket(wt, packetManager.notify({ message: "Usage: /report <username> <reason>" }));
              break;
            }
            await sendReport(wt, currentPlayer, args[0], "other", reason);
            break;
          }

          case "REPORTS": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.reports" || p === "admin.*"
              )
            ) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.notify({ message: await moderation.reportsCommand(currentPlayer, args) }));
            break;
          }

          case "TRADES": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.trades" || p === "admin.*"
              )
            ) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.notify({ message: await moderation.tradesCommand(currentPlayer, args) }));
            break;
          }

          case "BAN": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.ban" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(identifier))) {

              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {

              targetPlayer = playerCache.get(identifier);
            }

            // One not here is found in the database: online on another node, or not at all.
            const heldHere = !!targetPlayer;
            if (!targetPlayer) {
              const dbPlayer = (await player.findPlayerInDatabase(
                identifier
              )) as { username: string; banned: number }[];
              targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.username.toLowerCase() === currentPlayer.username.toLowerCase()) {
              const notifyData = {
                message: "You cannot ban yourself",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // Asked of the account, not the target found: one found in the
            // database (offline) carries no isAdmin.
            if (await player.isAdmin(targetPlayer.username)) {
              const notifyData = {
                message: "You cannot ban other admins",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.banned) {
              const notifyData = {
                message: `${targetPlayer.username.charAt(0).toUpperCase() +
                  targetPlayer.username.slice(1)
                  } is already banned`,
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            await player.ban(targetPlayer.username, targetPlayer.wt);
            // The account is banned; a session on another node is ended where it is.
            if (!heldHere) await runOnPlayer(targetPlayer.username, "admin-kick");
            const notifyData = {
              message: `Banned ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } from the server`,
            };
            sendPacket(wt, packetManager.notify(notifyData));
            break;
          }
          case "UNBAN": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.unban" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0] || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const targetPlayer = (await player.findPlayerInDatabase(
              identifier
            )) as { username: string; banned: number }[] as any[];
            // A name with no account is an empty list, not nothing.
            if (!targetPlayer?.length) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer[0].id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot unban yourself",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            await player.unban(targetPlayer[0].username);
            const notifyData = {
              message: `Unbanned ${targetPlayer[0].username} from the server`,
            };
            sendPacket(wt, packetManager.notify(notifyData));
            break;
          }

          case "ADMIN":
          case "SETADMIN": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.admin" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(identifier))) {

              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {

              targetPlayer = playerCache.get(identifier);
            }

            if (!targetPlayer) {
              const dbPlayer = (await player.findPlayerInDatabase(
                identifier
              )) as { username: string; banned: number }[];
              targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (targetPlayer.username.toLowerCase() === currentPlayer.username.toLowerCase()) {
              const notifyData = {
                message: "You cannot toggle your own admin status",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // Demoting clears what the target holds, so it is held to the
            // rule of changing it: a lower admin cannot demote a higher one.
            if (!outranks(currentPlayer.permissions, await permissions.held(targetPlayer.username))) {
              const notifyData = {
                message: "You cannot change the admin status of someone who holds permissions you cannot grant",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const admin = await player.toggleAdmin(targetPlayer.username);

            if (targetPlayer && targetPlayer.wt) {
              targetPlayer.isAdmin = admin;
              // toggleAdmin clears them with the role.
              if (admin === false) targetPlayer.permissions = [];
              playerCache.set(targetPlayer.id, targetPlayer);
            }
            const notifyData = {
              message: `${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } is now ${admin ? "an admin" : "not an admin"}`,
            };

            if (targetPlayer?.wt) {
              sendPacket(targetPlayer.wt, packetManager.reconnect());
            }
            sendPacket(wt, packetManager.notify(notifyData));
            break;
          }

          case "WHITELIST": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.whitelist" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const whitelistMode = args[0]?.toLowerCase() || null;
            const whitelistUsername = args[1] || null;

            // Switch it while the server runs. Turning it on loads the
            // usernames and puts this admin on the list; players already
            // online stay, only new logins are checked.
            if (whitelistMode === "on" || whitelistMode === "off") {
              const result = await setWhitelistEnabled(whitelistMode === "on", currentPlayer.username);
              const notifyData = {
                message: result.message,
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // Check if whitelist is enabled
            if (!isWhitelistEnabled()) {
              const notifyData = {
                message: "Whitelist is not enabled on this realm. Turn it on with /whitelist on",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (!whitelistMode || !["add", "remove"].includes(whitelistMode)) {
              const notifyData = {
                message: "Usage: /whitelist on|off, or /whitelist add|remove [username]",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (!whitelistUsername) {
              const notifyData = {
                message: `Usage: /whitelist ${whitelistMode} [username]`,
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            try {
              if (whitelistMode === "add") {
                if (whitelistUsername.toLowerCase() === currentPlayer.username.toLowerCase()) {
                  const notifyData = {
                    message: "You cannot add yourself to the whitelist",
                  };
                  sendPacket(wt, packetManager.notify(notifyData));
                  break;
                }
                const result = await player.whitelistAdd(whitelistUsername);
                const notifyData = {
                  message: result.message,
                };
                sendPacket(wt, packetManager.notify(notifyData));
              } else if (whitelistMode === "remove") {
                if (whitelistUsername.toLowerCase() === currentPlayer.username.toLowerCase()) {
                  const notifyData = {
                    message: "You cannot remove yourself from the whitelist",
                  };
                  sendPacket(wt, packetManager.notify(notifyData));
                  break;
                }
                const result = await player.whitelistRemove(whitelistUsername);
                const notifyData = {
                  message: result.message,
                };
                sendPacket(wt, packetManager.notify(notifyData));
              }
            } catch (error) {
              log.error(`Whitelist command error: ${error}`);
              const notifyData = {
                message: "An error occurred while processing the whitelist command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
            }
            break;
          }

          case "SUBSCRIPTION": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.subscription" || p === "admin.*"
              )
            ) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }

            const subscriptionMode = args[0]?.toLowerCase() || null;
            const subscriptionId = args[1]?.toLowerCase() || null;

            if (subscriptionMode === "list") {
              const state = subscriptionState();
              sendPacket(wt, packetManager.notify({
                message: `Subscriptions are ${state.enabled ? "on" : "off (the Gateway has no Stripe settings, so nothing is locked)"}. Locked for players who are not subscribed: ${state.locks.length ? state.locks.join(", ") : "nothing"}`,
              }));
              sendPacket(wt, packetManager.notify({
                message: `Locks: ${state.options.map((option) => option.id).join(", ")}`,
              }));
              break;
            }

            if (subscriptionMode !== "lock" && subscriptionMode !== "unlock") {
              sendPacket(wt, packetManager.notify({ message: "Usage: /subscription list, or /subscription lock|unlock [id]" }));
              break;
            }

            if (!subscriptionId || !isSubscriptionLock(subscriptionId)) {
              sendPacket(wt, packetManager.notify({
                message: `Usage: /subscription ${subscriptionMode} [id]. Use /subscription list to see the ids`,
              }));
              break;
            }

            try {
              const result = await setSubscriptionLock(subscriptionId, subscriptionMode === "lock");
              sendPacket(wt, packetManager.notify({ message: result.message }));
            } catch (error) {
              log.error(`Subscription command error: ${error}`);
              sendPacket(wt, packetManager.notify({ message: "An error occurred while processing the subscription command" }));
            }
            break;
          }

          case "SHUTDOWN": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.shutdown" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            // Two admins asking at once would each warn, disconnect and
            // spawn: the second is told the first is under way.
            if (restartState.shutdownStarted) {
              sendPacket(wt, packetManager.notify({ message: "The server is already shutting down" }));
              break;
            }
            restartState.shutdownStarted = true;
            const players = Object.values(playerCache.list());
            players.forEach((player) => {
              const notifyData = {
                message:
                  "⚠️ Server shutting down - please reconnect in a few minutes ⚠️",
              };
              sendPacket(player.wt, packetManager.notify(notifyData));
            });

            await new Promise((resolve) => setTimeout(resolve, 5000));
            players.forEach((player) => {
              player.wt.close(1000, "Server is restarting", { drain: true });
            });

            const checkInterval = setInterval(async () => {
              const remainingPlayers = Object.values(playerCache.list());
              remainingPlayers.forEach((player) => {
                player.wt.close(1000, "Server is restarting", { drain: true });
              });

              if (remainingPlayers.length === 0) {
                clearInterval(checkInterval);
                await clearShared(() => player.clear());
                // Each disconnect saves its player after leaving the cache:
                // let the database answer those writes before the process ends.
                await drainQueries();
                await gracefulShutdown("/shutdown");
              }
            }, 100);
            break;
          }

          case "TE":
          case "TILEEDITOR": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "tools.tile_editor" || p === "tools.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            sendPacket(wt, packetManager.toggleTileEditor());
            break;
          }

          case "PE":
          case "PARTICLEEDITOR": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "tools.particle_editor" || p === "tools.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            sendPacket(wt, packetManager.toggleParticleEditor());
            break;
          }

          case "IE":
          case "ITEMEDITOR": {
            if (!itemEditor.canUseEditor(currentPlayer)) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleItemEditor());
            break;
          }

          case "ME":
          case "MOUNTEDITOR": {
            if (!mountEditor.canUseEditor(currentPlayer)) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleMountEditor());
            break;
          }

          case "SE":
          case "SPELLEDITOR": {
            if (!(await spellEditor.canUseEditor(currentPlayer))) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleSpellEditor());
            break;
          }

          case "WE":
          case "WEATHEREDITOR": {
            if (!(await weatherEditor.canUseEditor(currentPlayer))) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleWeatherEditor());
            break;
          }

          case "MAILBOX": {
            if (!(await mailboxEditor.canUseEditor(currentPlayer))) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleMailboxEditor());
            break;
          }

          case "GATHERING": {
            if (!(await gathering.canUseEditor(currentPlayer))) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleGatheringEditor());
            break;
          }

          case "ACHIEVEMENTS": {
            if (!(await achievements.canUseEditor(currentPlayer))) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleAchievementEditor());
            break;
          }

          case "CLE":
          case "CLASSEDITOR": {
            if (!(await classEditor.canUseEditor(currentPlayer))) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleClassEditor());
            break;
          }

          case "QE":
          case "QUESTEDITOR": {
            if (!questEditor.canUseEditor(currentPlayer)) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleQuestEditor());
            break;
          }

          case "CE":
          case "CREATUREEDITOR": {
            if (!creatures.canUseEditor(currentPlayer)) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleCreatureEditor());
            break;
          }

          case "NE":
          case "NPCEDITOR": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "tools.npc_editor" || p === "tools.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            sendPacket(wt, packetManager.toggleNpcEditor());
            break;
          }

          case "PLAYER": {
            // /player edit <username | id>: open the player editor on that player.
            if (!(await playerEditor.canUseEditor(currentPlayer))) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            if (args[0]?.toUpperCase() !== "EDIT" || !args[1]) {
              sendPacket(wt, packetManager.notify({ message: "Usage: /player edit <username | id>" }));
              break;
            }
            const editTarget = await playerEditor.resolveTarget(args[1]);
            if (!editTarget) {
              sendPacket(wt, packetManager.notify({ message: "Player not found" }));
              break;
            }
            sendPacket(wt, packetManager.playerEditorOpen({ target: editTarget.username }));
            break;
          }

          case "CP":
          case "CONTROLPANEL": {
            if (!controlPanel.canUsePanel(currentPlayer)) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleControlPanel());
            break;
          }

          case "RESTART": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.restart" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (restartState.scheduled) {
              restartState.timers.forEach((timer) => clearTimeout(timer));
              restartState.timers = [];
              restartState.scheduled = false;

              const players = Object.values(playerCache.list());
              players.forEach((player) => {
                const notifyData = {
                  message: "⚠️ Server restart has been aborted ⚠️",
                };
                sendPacket(player.wt, packetManager.notify(notifyData));
              });
              break;
            }

            restartState.scheduled = true;
            restartState.timers = [];

            const minutes = 15;
            const RESTART_DELAY = minutes * 60000;
            const totalMinutes = Math.floor(RESTART_DELAY / 60000);

            const minuteIntervals = Array.from(
              { length: totalMinutes },
              (_, i) => totalMinutes - i
            );
            const secondIntervals = Array.from(
              { length: 30 },
              (_, i) => 30 - i
            );

            minuteIntervals.forEach((minutes) => {
              restartState.timers.push(
                setTimeout(() => {
                  const players = Object.values(playerCache.list());
                  players.forEach((player) => {
                    const notifyData = {
                      message: `⚠️ Server restarting in ${minutes} minute${minutes === 1 ? "" : "s"
                        } ⚠️`,
                    };
                    sendPacket(player.wt, packetManager.notify(notifyData));
                  });
                }, RESTART_DELAY - minutes * 60 * 1000)
              );
            });

            secondIntervals.forEach((seconds) => {
              restartState.timers.push(
                setTimeout(() => {
                  const players = Object.values(playerCache.list());
                  players.forEach((player) => {
                    const notifyData = {
                      message: `⚠️ Server restarting in ${seconds} second${seconds === 1 ? "" : "s"
                        } ⚠️`,
                    };
                    sendPacket(player.wt, packetManager.notify(notifyData));
                  });
                }, RESTART_DELAY - seconds * 1000)
              );
            });

            restartState.timers.push(
              setTimeout(() => {
                const players = Object.values(playerCache.list());
                players.forEach((player) => {
                  player.wt.close(1000, "Server is restarting", { drain: true });
                });

                const checkInterval = setInterval(async () => {
                  const remainingPlayers = Object.values(playerCache.list());
                  remainingPlayers.forEach((player) => {
                    player.wt.close(1000, "Server is restarting", { drain: true });
                  });

                  if (remainingPlayers.length === 0) {
                    clearInterval(checkInterval);
                    await clearShared(() => player.clear());
                    await drainQueries();
                    // The process ends here. Starting it again is its
                    // supervisor's job (the Docker restart policy).
                    await gracefulShutdown("/restart");
                  }
                }, 100);
              }, RESTART_DELAY)
            );
            break;
          }

          case "RESPAWN": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.respawn" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            const identifier = args[0]?.toLowerCase() || null;

            if (!identifier) {
              targetPlayer = currentPlayer;
            } else {

              const players = Object.values(playerCache.list());
              if (isNaN(Number(identifier))) {

                targetPlayer = players.find(
                  (p) => p.username.toLowerCase() === identifier.toLowerCase()
                );
              } else {

                targetPlayer = playerCache.get(identifier);
              }

              if (!targetPlayer) {
                const dbPlayer = (await player.findPlayerInDatabase(
                  identifier
                )) as { username: string }[];
                targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
              }

              if (!targetPlayer) {
                const notifyData = {
                  message: "Player not found",
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
            }

            const defaultMapProps = mapPropertiesCache.find(
              (m: any) => m.name === `${defaultMap}.json`
            );
            const centerX = defaultMapProps?.spawn ? defaultMapProps.spawn.x : defaultMapProps
              ? (defaultMapProps.width * defaultMapProps.tileWidth) / 2
              : 0;
            const centerY = defaultMapProps?.spawn ? defaultMapProps.spawn.y : defaultMapProps
              ? (defaultMapProps.height * defaultMapProps.tileHeight) / 2
              : 0;

            // By username: the target may be offline, and has a session id only while online.
            await player.setLocationByUsername(targetPlayer.username, `${defaultMap}`, {
              x: centerX,
              y: centerY,
              direction: "down",
            });

            if (playerCache.get(targetPlayer.id)) {
              targetPlayer.location.position = {
                x: Math.round(centerX),
                y: Math.round(centerY),
                direction: "down",
              };
              // Admin respawn releases any death state: corpse/ghost cleared,
              // full health, position is the respawn point.
              targetPlayer.isDead = false;
              targetPlayer.isGhost = false;
              targetPlayer.corpse = null;
              targetPlayer.reviveOffered = false;
              targetPlayer.ghostTeleportPending = false;
              resurrection.clearSickness(targetPlayer);
              const respawnSynced = await player.synchronizeStats(targetPlayer.username);
              if (respawnSynced) {
                targetPlayer.stats = respawnSynced;
              }
              if (targetPlayer.stats) {
                targetPlayer.stats.health = targetPlayer.stats.total_max_health;
                targetPlayer.stats.stamina = targetPlayer.stats.total_max_stamina;
              }
              playerCache.set(targetPlayer.id, targetPlayer);
              await resyncNpcChunks(targetPlayer, targetPlayer.wt); // respawned at the map's centre
              try {
                await player.setDeadState(targetPlayer.username, 0, null);
              } catch (e: any) {
                log.error(`Failed to clear death state for ${targetPlayer.username}: ${e?.message || e}`);
              }
              const playersInMap = filterPlayersByMap(
                targetPlayer.location.map
              );
              bumpStateRevision();
              playersInMap.forEach((player) => {
                const moveData = {
                  i: targetPlayer.id,
                  d: {
                    x: Number(targetPlayer.location.position.x),
                    y: Number(targetPlayer.location.position.y),
                    dr: targetPlayer.location.position.direction
                  },
                  r: stateRevision(),
                  s: targetPlayer.isStealth ? 1 : 0
                };
                sendPacket(player.wt, packetManager.moveXY(moveData));
                sendPacket(player.wt, packetManager.playerGhost({ id: targetPlayer.id, ghost: false }));
                if (targetPlayer.stats) {
                  sendPacket(player.wt, packetManager.revive({
                    id: targetPlayer.id,
                    target: targetPlayer.id,
                    stats: targetPlayer.stats,
                  }));
                }
              });
              spellEffects.broadcastEffectsUpdate(targetPlayer);
            }

            const notifyData = {
              message: `Respawned ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                }`,
            };
            sendPacket(wt, packetManager.notify(notifyData));
            // An offline target is an account, not a player in the world: only where they will log in changed.
            if (targetPlayer.location) {
              listener.emit(Events.PLAYER_RESPAWN, { player: targetPlayer, mapName: targetPlayer.location.map, x: targetPlayer.location.position.x, y: targetPlayer.location.position.y });
            }
            break;
          }

          case "REVIVE": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.revive" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const reviveIdentifier = args[0]?.toLowerCase() || null;

            let reviveTarget: any = null;
            if (!reviveIdentifier) {
              reviveTarget = currentPlayer;
            } else {
              const players = Object.values(playerCache.list());
              if (isNaN(Number(reviveIdentifier))) {
                reviveTarget = players.find(
                  (p) => p.username.toLowerCase() === reviveIdentifier.toLowerCase()
                );
              } else {
                reviveTarget = playerCache.get(reviveIdentifier);
              }
            }

            const onlineTarget = reviveTarget ? playerCache.get(reviveTarget.id) : null;
            if (!onlineTarget) {
              // A player on another node is revived there (cells-revive, socket/receiver.ts; Deviation 20).
              // Only a name is asked for: an id is local to the node that gave it.
              const sent = !!reviveIdentifier && isNaN(Number(reviveIdentifier))
                && (await runOnPlayer(reviveIdentifier, "cells-revive", { by: currentPlayer.username }));
              if (!sent) {
                sendPacket(wt, packetManager.notify({ message: "Player must be online to revive" }));
              }
              break;
            }

            if (onlineTarget.handoff) {
              // Its snapshot is taken: a revive now would be lost on the node it is going to.
              sendPacket(wt, packetManager.notify({
                message: `${onlineTarget.username.charAt(0).toUpperCase() + onlineTarget.username.slice(1)} is changing server node; try again`,
              }));
              break;
            }

            const shownTarget = onlineTarget.username.charAt(0).toUpperCase() + onlineTarget.username.slice(1);
            // Revive in place at full health: one body with the cells-revive action (src/socket/revive.ts).
            // The admin's note goes out before PLAYER_REVIVED, as it always did.
            const reviveResult = await revivePlayer(onlineTarget, reviveDeps(), () => {
              sendPacket(wt, packetManager.notify({ message: `Revived ${shownTarget}` }));
            });
            if (reviveResult === "not-dead") {
              sendPacket(wt, packetManager.notify({ message: `${shownTarget} is not dead` }));
            }
            break;
          }

          // Ends every cooldown an online player is waiting on: spells, the lockout after an
          // interrupt, the one consumables share and the home item's hour. Themselves, when no
          // player is named.
          case "COOLDOWNS":
          case "RESETCOOLDOWNS": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.cooldowns" || p === "admin.*"
              )
            ) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }

            const named = args[0]?.toLowerCase() || null;
            const found = !named
              ? currentPlayer
              : isNaN(Number(named))
                ? Object.values(playerCache.list()).find((p: any) => p.username.toLowerCase() === named)
                : playerCache.get(named);
            const waiting = found ? playerCache.get((found as any).id) : null;
            if (!waiting) {
              sendPacket(wt, packetManager.notify({ message: "Player must be online to reset their cooldowns" }));
              break;
            }

            const waitingName = waiting.username.charAt(0).toUpperCase() + waiting.username.slice(1);
            try {
              await resetCooldowns(waiting);
            } catch (error) {
              log.error(`The cooldowns of ${waiting.username} could not all be reset: ${error}`);
              sendPacket(wt, packetManager.notify({ message: `The home cooldown of ${waitingName} could not be reset. The others were.` }));
            }
            // The admin's own, as their connection carries them.
            if (waiting.id === currentPlayer.id) {
              currentPlayer.spellCooldowns = waiting.spellCooldowns;
              currentPlayer.spellLockoutUntil = 0;
            }
            playerCache.set(waiting.id, waiting);
            if (waiting.wt) sendPacket(waiting.wt, packetManager.cooldownsReset());
            sendPacket(wt, packetManager.notify({ message: `Reset the cooldowns of ${waitingName}` }));
            break;
          }

          case "KILL": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.kill" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const killIdentifier = args[0]?.toLowerCase() || null;

            let killTarget: any = null;
            if (!killIdentifier) {
              killTarget = currentPlayer;
            } else {
              const players = Object.values(playerCache.list());
              if (isNaN(Number(killIdentifier))) {
                killTarget = players.find(
                  (p) => p.username.toLowerCase() === killIdentifier.toLowerCase()
                );
              } else {
                killTarget = playerCache.get(killIdentifier);
              }
            }

            const onlineTarget = killTarget ? playerCache.get(killTarget.id) : null;
            if (!onlineTarget) {
              sendPacket(wt, packetManager.notify({ message: "Player must be online to kill" }));
              break;
            }

            // As kick and ban: not another admin (yourself is fine).
            if (onlineTarget.id !== currentPlayer.id && (onlineTarget.isAdmin || await player.isAdmin(onlineTarget.username))) {
              sendPacket(wt, packetManager.notify({ message: "You cannot kill other admins" }));
              break;
            }

            if (onlineTarget.isDead || onlineTarget.isGhost) {
              const notifyData = {
                message: `${onlineTarget.username.charAt(0).toUpperCase() + onlineTarget.username.slice(1)} is already dead`,
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // Force the standard death flow: skeleton, corpse persistence,
            // Release Spirit popup, full server-side locks.
            await handlePlayerDeath(onlineTarget, currentPlayer, {
              damage: onlineTarget.stats?.health || 0,
              isCrit: false,
            });

            sendPacket(wt, packetManager.notify({
              message: `Killed ${onlineTarget.username.charAt(0).toUpperCase() + onlineTarget.username.slice(1)}`,
            }));
            break;
          }

          case "PERMISSION":
          case "PERMISSIONS": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.permission" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const mode = args[0]?.toUpperCase() || null;
            if (!mode) {
              const notifyData = {
                message: "Please provide a mode",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (
              mode !== "ADD" &&
              mode !== "REMOVE" &&
              mode !== "SET" &&
              mode !== "CLEAR" &&
              mode !== "LIST"
            ) {
              const notifyData = {
                message: "Invalid mode",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            const identifier = args[1]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const players = Object.values(playerCache.list());
            if (isNaN(Number(identifier))) {

              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {

              targetPlayer = playerCache.get(identifier);
            }

            if (!targetPlayer) {
              const dbPlayer = (await player.findPlayerInDatabase(
                identifier
              )) as { username: string }[];
              targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // SECURITY: Permission checks FIRST before any other logic
            let hasPermissionToModify = false;
            let requiredPermission = "";

            if (mode === "ADD" || mode === "SET") {
              requiredPermission = "permission.add";
            } else if (mode === "REMOVE" || mode === "CLEAR") {
              requiredPermission = "permission.remove";
            } else if (mode === "LIST") {
              requiredPermission = "permission.list";
            }

            // Check if user has required permission
            hasPermissionToModify = currentPlayer.permissions.some(
              (p: string) =>
                p === requiredPermission || p === "permission.*"
            );

            if (!hasPermissionToModify) {
              const notifyData = {
                message: "Insufficient permissions for this operation",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // SECURITY: Always prevent self-modification regardless of permission level.
            // By name: a target found in the database has no session id.
            if (targetPlayer.username.toLowerCase() === currentPlayer.username.toLowerCase() && mode !== "LIST") {
              const notifyData = {
                message: "You cannot modify your own permissions",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // Whether the target is an admin is asked of the account the player
            // system holds (which every change of role is written to), not of
            // the copy made at login, and so holds for a target who is offline.
            // Only granting is held to this: what a former admin still holds
            // has to stay listable and removable.
            if((mode === "ADD" || mode === "SET") && !(await player.isAdmin(targetPlayer.username))) {
              const notifyData = {
                message: "You can only grant permissions to admin players",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            // SECURITY: Only someone who could have given the target all they
            // hold may change it, so a lower admin cannot strip a higher one.
            if (mode !== "LIST" && !outranks(currentPlayer.permissions, await permissions.held(targetPlayer.username))) {
              const notifyData = {
                message: "You cannot change the permissions of someone who holds permissions you cannot grant",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            let access;
            let permissionsArray: string[] = [];
            if (mode !== "CLEAR" && mode !== "LIST") {
              access = args.slice(2).join(" ");

              const validPermissions = await permissions.list();

              permissionsArray = access.split(",").map((p: string) => p.trim());

              // Validate all permissions exist
              for (const permission of permissionsArray) {
                if (!validPermissions.includes(permission)) {
                  const notifyData = {
                    message: `Invalid permission: ${permission}`,
                  };
                  sendPacket(wt, packetManager.notify(notifyData));
                  return;
                }
              }

              // SECURITY: Validate user can only grant permissions they have
              for (const permission of permissionsArray) {
                if (!canGrant(currentPlayer.permissions, permission)) {
                  const notifyData = {
                    message: `You cannot grant the ${permission} permission`,
                  };
                  sendPacket(wt, packetManager.notify(notifyData));
                  return;
                }
              }
            }

            // Perform the permission modification
            switch (mode) {
              case "ADD": {
                // permissions.add takes one name: a joined list is stored again beside the names already held.
                for (const permission of permissionsArray) {
                  await permissions.add(targetPlayer.username, permission);
                }

                if (targetPlayer.wt) {
                  const existingPerms = targetPlayer.permissions || [];
                  targetPlayer.permissions = [
                    ...new Set([...existingPerms, ...permissionsArray])
                  ];
                  playerCache.set(targetPlayer.id, targetPlayer);
                }

                // Audit log
                log.info(
                  `[PERMISSION_AUDIT] ${currentPlayer.username} (${currentPlayer.id}) added permissions [${permissionsArray.join(
                    ", "
                  )}] to ${targetPlayer.username}`
                );

                const notifyData = {
                  message: `Permissions \`${permissionsArray.join(
                    ", "
                  )}\` added to ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)}`,
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
              case "REMOVE": {
                // permissions.remove takes one name: a joined list matches nothing.
                for (const permission of permissionsArray) {
                  await permissions.remove(targetPlayer.username, permission);
                }

                if (targetPlayer.wt) {
                  targetPlayer.permissions = (targetPlayer.permissions || []).filter(
                    (p: string) => !permissionsArray.includes(p)
                  );
                  playerCache.set(targetPlayer.id, targetPlayer);
                }

                // Audit log
                log.info(
                  `[PERMISSION_AUDIT] ${currentPlayer.username} (${currentPlayer.id}) removed permissions [${permissionsArray.join(
                    ", "
                  )}] from ${targetPlayer.username}`
                );

                const notifyData = {
                  message: `Permissions removed from ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)}`,
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
              case "SET": {
                await permissions.set(targetPlayer.username, permissionsArray);

                if (targetPlayer.wt) {
                  targetPlayer.permissions = permissionsArray;
                  playerCache.set(targetPlayer.id, targetPlayer);
                }

                // Audit log
                log.info(
                  `[PERMISSION_AUDIT] ${currentPlayer.username} (${currentPlayer.id}) set permissions to [${permissionsArray.join(
                    ", "
                  )}] for ${targetPlayer.username}`
                );

                const notifyData = {
                  message: `Permissions set for ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)}`,
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
              case "CLEAR": {
                await permissions.clear(targetPlayer.username);

                targetPlayer.permissions = [];
                const p = playerCache.get(targetPlayer.id);
                if (p && p.wt) {
                  playerCache.set(targetPlayer.id, targetPlayer);
                }

                // Audit log
                log.info(
                  `[PERMISSION_AUDIT] ${currentPlayer.username} (${currentPlayer.id}) cleared all permissions for ${targetPlayer.username}`
                );

                const notifyData = {
                  message: `Permissions cleared for ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)}`,
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
              case "LIST": {
                const response =
                  ((await permissions.get(targetPlayer.username)) as string) ||
                  "No permissions found";
                const notifyData = {
                  message: `Permissions for ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)}: ${response.replaceAll(
                    ",",
                    ", "
                  )}`,
                };
                sendPacket(wt, packetManager.notify(notifyData));
                break;
              }
            }
            break;
          }
          case "RELOADMAP": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.reloadmap" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const mapName = args[0]?.toLowerCase() || null;
            if (!mapName) {
              const notifyData = {
                message: "Please provide a map name",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const map = (maps as any[]).find(
              (m) => m.name === `${mapName}.json`
            );
            if (!map) {
              const notifyData = {
                message: `Map ${mapName} not found`,
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const result = (await reloadMap(mapName)) as MapData | null;
            if (result) {
              const notifyData = {
                message: `Map ${mapName} reloaded successfully`,
              };
              sendPacket(wt, packetManager.notify(notifyData));

              map.compressed = result.compressed;
              map.data = result.data;

              const playersInMap = filterPlayersByMap(mapName);

              playersInMap.forEach((player) => {
                const mapMetadata = constructMapMetadata(
                  mapName,
                  player.location.position?.x || 0,
                  player.location.position?.y || 0,
                  player.location.position?.direction || "down",
                  maps,
                  mapPropertiesCache
                );
                sendPacket(player.wt, packetManager.loadMap(mapMetadata));
                // loading a map clears the client's creatures and gathering nodes
                creatures.resyncPlayer(player.id);
                gathering.resyncPlayer(player.id);
              });
            } else {
              log.error(`Failed to reload map ${mapName}`);
              const notifyData = {
                message: `Failed to reload map ${mapName}`,
              };
              sendPacket(wt, packetManager.notify(notifyData));
            }
            break;
          }
          case "WARP": {

            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.warp" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }
            const currentMapName = currentPlayer.location.map;

            const mapName = args[0]?.toLowerCase() || null;
            if (!mapName) {
              const notifyData = {
                message: "Please provide a map name",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            if (mapName === currentMapName) {
              const notifyData = {
                message: "You are already in this map",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const map = (maps as any[]).find(
              (map: MapData) => map.name === `${mapName}.json`
            );

            if (!map) {
              const notifyData = {
                message: "Map not found",
              };
              sendPacket(wt, packetManager.notify(notifyData));
              break;
            }

            const identifier = args[1]?.toLowerCase() || null;

            if (!identifier) {

              const mapProps = mapPropertiesCache.find((m: any) => m.name === `${mapName}.json`);
              // A world names its own spawn (a town square): its centre may well be a lake
              const centerX = mapProps?.spawn ? mapProps.spawn.x : mapProps
                ? (mapProps.width * mapProps.tileWidth) / 2
                : 0;
              const centerY = mapProps?.spawn ? mapProps.spawn.y : mapProps
                ? (mapProps.height * mapProps.tileHeight) / 2
                : 0;

              const result = await player.setLocation(
                currentPlayer.id,
                mapName,
                {
                  x: centerX,
                  y: centerY,
                  direction: currentPlayer.location.position?.direction || "down",
                }
              );

              if (
                result &&
                typeof result === "object" &&
                "affectedRows" in result &&
                ((result as { affectedRows: number | null; count?: number }).affectedRows ?? (result as { count?: number }).count) != 0
              ) {
                await transitionPlayerToMap(
                  currentPlayer,
                  mapName,
                  {
                    x: centerX,
                    y: centerY,
                    direction: currentPlayer.location.position?.direction || "down",
                  },
                  wt,
                  spawnBatchQueue,
                  despawnBatchQueue
                );
              } else {
                const notifyData = {
                  message: "Failed to update location",
                };
                sendPacket(wt, packetManager.notify(notifyData));
              }
              break;
            }

            // /warp moves only the admin who typed it: /summon is the command
            // that moves another player.
            sendPacket(
              wt,
              packetManager.notify({ message: "Warping another player is not supported. Usage: /warp <map>" })
            );
            break;
          }
          case "WEATHER": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.weather" || p === "admin.*"
              )
            ) {
              sendPacket(
                wt,
                packetManager.notify({ message: "You don't have permission to use this command" })
              );
              break;
            }

            const weatherName = args[0]?.toLowerCase() || null;
            if (!weatherName) {
              sendPacket(
                wt,
                packetManager.notify({ message: "Usage: /weather <weather_name|clear|random|weather_api|tornado>" })
              );
              break;
            }

            // "clear", "random", "weather_api" and "tornado" are /weather's own words: they need no row of the weather table.
            if (weatherName !== "clear" && weatherName !== "random" && weatherName !== weatherApi.WEATHER_API && weatherName !== TORNADO) {
              const allWeathers = await assetCache.get("weather") as WeatherData[];
              if (!allWeathers?.find((w: WeatherData) => w.name === weatherName)) {
                sendPacket(
                  wt,
                  packetManager.notify({ message: `Weather '${weatherName}' not found` })
                );
                break;
              }
            }

            const currentMapName = currentPlayer.location.map;

            const existingWorld = worldsCache.find((w) => w.name === currentMapName);
            await worlds.update({ name: currentMapName, weather: weatherName, players: existingWorld?.players || 0 });

            if (existingWorld) {
              existingWorld.weather = weatherName;
            }

            resolvedWeatherCache.delete(currentMapName);

            let weatherData = null;
            let resolvedWeatherName = weatherName;
            if (weatherName === "random") {
              const randomWeather = randomPick(await assetCache.get("weather") as WeatherData[]);
              if (randomWeather) {
                weatherData = randomWeather;
                resolvedWeatherName = randomWeather.name;
                resolvedWeatherCache.set(currentMapName, { weather: resolvedWeatherName, weatherData: randomWeather });
              } else {
                resolvedWeatherName = "clear";
              }
            } else if (weatherName === weatherApi.WEATHER_API) {
              weatherData = weatherApi.currentWeather();
            } else {
              weatherData = rowOf(await assetCache.get("weather") as WeatherData[], weatherName);
            }

            const playerIds = mapIndex.getPlayersOnMap(currentMapName);
            for (const playerId of playerIds) {
              const player = playerCache.get(playerId);
              if (player?.wt && player.wt.readyState === 1) {
                sendPacket(
                  player.wt,
                  packetManager.changeWeather(await weatherShown(resolvedWeatherName, weatherData))
                );
              }
            }

            sendPacket(
              wt,
              packetManager.notify({ message: `Weather changed to '${weatherName}' for world '${currentMapName}'` })
            );
            break;
          }
          case "GIVE": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.items" || p === "admin.*"
              )
            ) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }

            const targetIdentifier = args[0]?.toLowerCase() || null;
            const itemName = args[1] || null;
            const quantity = parseInt(args[2]) || 1;

            if (!targetIdentifier || !itemName) {
              sendPacket(wt, packetManager.notify({ message: "Usage: /give <user> <item> <amount>" }));
              break;
            }

            let targetPlayer;
            if (isNaN(Number(targetIdentifier))) {
              const players = Object.values(playerCache.list());
              targetPlayer = players.find((p: any) => p.username.toLowerCase() === targetIdentifier.toLowerCase());
            } else {
              targetPlayer = playerCache.get(targetIdentifier);
            }

            if (!targetPlayer) {
              const dbPlayer = await player.findPlayerInDatabase(targetIdentifier, undefined) as { username: string }[];
              targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
            }

            if (!targetPlayer) {
              sendPacket(wt, packetManager.notify({ message: "Player not found" }));
              break;
            }

            const targetName = targetPlayer.username;

            const items = await assetCache.get("items") as Item[];
            const itemDef = Array.isArray(items) ? items.find((i: any) => i.name.toLowerCase() === itemName.toLowerCase()) : null;
            if (!itemDef) {
              sendPacket(wt, packetManager.notify({ message: `Item '${itemName}' does not exist` }));
              break;
            }

            // A trade lost on another node may still be settling for this player (cluster/tradesettle.ts): the item
            // is added once their mark has run out, so the count starts from what the swap left. The admin is told
            // while it waits, so the command is not sent again. Guard (test "/give waits for the target's mark
            // before it adds the item").
            if (settleStoreAttached()) {
              const refused = await settleForAdmin(targetName, (leftMs) => sendPacket(wt, packetManager.notify({ message: settlingNotice(targetName, leftMs) })));
              if (refused) {
                sendPacket(wt, packetManager.notify({ message: refused }));
                break;
              }
            }

            await inventory.add(targetName, { name: itemDef.name, quantity });

            const cachedTarget = playerCache.get(targetPlayer.id);
            if (cachedTarget) {
              if (!Array.isArray(cachedTarget.inventory)) cachedTarget.inventory = [];
              const existing = cachedTarget.inventory.find((i: any) => i.name.toLowerCase() === itemDef.name.toLowerCase());
              if (existing) {
                existing.quantity += quantity;
                if (cachedTarget.wt) {
                  sendPacket(cachedTarget.wt, packetManager.addInventoryItem(existing));
                  sendPacket(cachedTarget.wt, packetManager.notify({ message: `You received ${quantity}x ${itemDef.name}` }));
                }
              } else {
                const newItem = {
                  name: itemDef.name,
                  quantity,
                  equipped: false,
                  slot: null,
                  bag_slot: null,
                  type: itemDef?.type || '',
                  quality: itemDef?.quality || 'common',
                  iconUrl: getIconUrl(itemDef?.icon),
                  equipment_slot: itemDef?.equipment_slot || null,
                  bag_slots: itemDef?.bag_slots ?? null,
                  stat_health: itemDef?.stat_health ?? null,
                  stat_stamina: itemDef?.stat_stamina ?? null,
                  stat_armor: itemDef?.stat_armor ?? null,
                  stat_damage: itemDef?.stat_damage ?? null,
                  stat_critical_chance: itemDef?.stat_critical_chance ?? null,
                  stat_critical_damage: itemDef?.stat_critical_damage ?? null,
                  stat_avoidance: itemDef?.stat_avoidance ?? null,
                  level_requirement: itemDef?.level_requirement ?? null,
                  description: itemDef?.description || '',
                };
                cachedTarget.inventory.push(newItem);
                if (cachedTarget.wt) {
                  sendPacket(cachedTarget.wt, packetManager.addInventoryItem(newItem));
                  sendPacket(cachedTarget.wt, packetManager.notify({ message: `You received ${quantity}x ${itemDef.name}` }));
                }
              }
              playerCache.set(cachedTarget.id, cachedTarget);
            }

            sendPacket(wt, packetManager.notify({ message: `Gave ${quantity}x ${itemDef.name} to ${targetName}` }));
            break;
          }
          case "DROP": {
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.items" || p === "admin.*"
              )
            ) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }

            const dropItem = args[0] || null;
            const dropQty = Math.min(parseInt(args[1]) || 1, 9999);

            if (!dropItem) {
              sendPacket(wt, packetManager.notify({ message: "Usage: /drop <item> [amount]" }));
              break;
            }

            const dropItems = await assetCache.get("items") as Item[];
            const dropDef = Array.isArray(dropItems) ? dropItems.find((i: any) => i.name.toLowerCase() === dropItem.toLowerCase()) : null;
            if (!dropDef) {
              sendPacket(wt, packetManager.notify({ message: `Item '${dropItem}' does not exist` }));
              break;
            }

            const iconUrl = getIconUrl(dropDef.icon) || "";
            const quality = dropDef.quality || "common";
            // Dropped for everyone: no owner, so any player nearby may pick it up.
            let spawnedLoot;
            try {
              spawnedLoot = loot.create(currentPlayer, dropDef.name, dropQty, iconUrl, quality, null);
            } catch (error) {
              log.error(`/drop of ${dropDef.name} by ${currentPlayer.username} failed: ${error}`);
              sendPacket(wt, packetManager.notify({ message: "Could not drop the item. Try again." }));
              break;
            }

            const spawnData = {
              id: spawnedLoot.id,
              item: spawnedLoot.item,
              quantity: spawnedLoot.quantity,
              quality: spawnedLoot.quality,
              iconUrl: spawnedLoot.iconUrl,
              x: spawnedLoot.x,
              y: spawnedLoot.y,
              ownerId: spawnedLoot.ownerId,
              ownerName: spawnedLoot.ownerName,
            };
            sendToWholeMap(spawnedLoot.map, packetManager.lootSpawn(spawnData));

            sendPacket(wt, packetManager.notify({ message: `Dropped ${dropQty}x ${dropDef.name}.` }));
            break;
          }
          case "SPAWNCHEST": {
            if (!currentPlayer.permissions.some((p: string) => p === "admin.items" || p === "admin.*")) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            const mode = args[0]?.toLowerCase() || null;
            if (!mode || (mode !== "table" && mode !== "inline")) {
              sendPacket(wt, packetManager.notify({ message: "Usage: /spawnchest table <loot_table_id> or /spawnchest inline <item> <min> <max> <chance> ..." }));
              break;
            }
            const playerPos = typeof currentPlayer.location.position === 'string'
              ? { x: Number(currentPlayer.location.position.split(',')[0]), y: Number(currentPlayer.location.position.split(',')[1]) }
              : (currentPlayer.location.position as any);
            if (mode === "table") {
              const tableId = parseInt(args[1]);
              if (!tableId || isNaN(tableId)) { sendPacket(wt, packetManager.notify({ message: "Usage: /spawnchest table <loot_table_id>" })); break; }
              const table = await lootTable.get(tableId);
              if (!table) { sendPacket(wt, packetManager.notify({ message: `Loot table ${tableId} not found.` })); break; }
              let chestId: string;
              try {
                chestId = lootChest.spawn(currentPlayer.location.map, playerPos.x, playerPos.y, tableId, undefined, currentPlayer.username);
              } catch (error) {
                log.error(`/spawnchest by ${currentPlayer.username} failed: ${error}`);
                sendPacket(wt, packetManager.notify({ message: "Could not spawn the chest. Try again." }));
                break;
              }
              const chestData = { id: chestId, x: playerPos.x, y: playerPos.y, iconUrl: getIconUrl("loot_chest"), map: currentPlayer.location.map };
              sendToWholeMap(currentPlayer.location.map, packetManager.lootChestSpawn(chestData));
              sendPacket(wt, packetManager.notify({ message: `Loot chest spawned using table "${table.name}".` }));
            } else {
              const itemArgs = args.slice(1);
              if (itemArgs.length < 4 || itemArgs.length % 4 !== 0) {
                sendPacket(wt, packetManager.notify({ message: "Usage: /spawnchest inline <item> <min> <max> <chance> ..." }));
                break;
              }
              const inlineEntries: any[] = [];
              for (let i = 0; i < itemArgs.length; i += 4) {
                const itemName = itemArgs[i]; const minQty = parseInt(itemArgs[i + 1]); const maxQty = parseInt(itemArgs[i + 2]); const chance = parseFloat(itemArgs[i + 3]);
                if (!itemName || isNaN(minQty) || isNaN(maxQty) || isNaN(chance)) { sendPacket(wt, packetManager.notify({ message: `Invalid entry at position ${i}` })); break; }
                inlineEntries.push({ itemName, minQuantity: minQty, maxQuantity: maxQty, dropChance: chance, quality: "common" });
              }
              if (inlineEntries.length === 0) break;
              let chestId: string;
              try {
                chestId = lootChest.spawn(currentPlayer.location.map, playerPos.x, playerPos.y, undefined, inlineEntries, currentPlayer.username);
              } catch (error) {
                log.error(`/spawnchest by ${currentPlayer.username} failed: ${error}`);
                sendPacket(wt, packetManager.notify({ message: "Could not spawn the chest. Try again." }));
                break;
              }
              const chestData = { id: chestId, x: playerPos.x, y: playerPos.y, iconUrl: getIconUrl("loot_chest"), map: currentPlayer.location.map };
              sendToWholeMap(currentPlayer.location.map, packetManager.lootChestSpawn(chestData));
              sendPacket(wt, packetManager.notify({ message: `Loot chest spawned with ${inlineEntries.length} inline entries.` }));
            }
            break;
          }
          case "LOOTTABLE": {
            if (!currentPlayer.permissions.some((p: string) => p === "admin.loot" || p === "admin.*")) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            const sub = args[0]?.toLowerCase() || null;
            if (!sub) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable list|create|delete|info|additem|removeitem ..." })); break; }
            if (sub === "list") {
              const tables = await lootTable.list();
              const names = tables.length ? tables.map((t: any) => `#${t.id} ${t.name} (${t.items.length} items)`).join(", ") : "No loot tables found.";
              sendPacket(wt, packetManager.notify({ message: `Loot tables: ${names}` }));
            } else if (sub === "create") {
              const name = args[1]; if (!name) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable create <name>" })); break; }
              const r = await lootTable.create(name);
              sendPacket(wt, packetManager.notify({ message: r ? `Loot table "${name}" created.` : `Table "${name}" already exists.` }));
            } else if (sub === "delete") {
              const id = parseInt(args[1]); if (!id || isNaN(id)) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable delete <id>" })); break; }
              await lootTable.delete(id); sendPacket(wt, packetManager.notify({ message: `Loot table ${id} deleted.` }));
            } else if (sub === "info") {
              const id = parseInt(args[1]); if (!id || isNaN(id)) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable info <id>" })); break; }
              const table = await lootTable.get(id);
              if (!table) { sendPacket(wt, packetManager.notify({ message: `Loot table ${id} not found.` })); break; }
              const lines = table.items.map((it: any) => `  #${it.id} ${it.item_name} (${it.min_quantity}-${it.max_quantity}, ${it.drop_chance}%, ${it.quality})`).join("\n");
              sendPacket(wt, packetManager.notify({ message: `Table #${table.id} "${table.name}":\n${lines || "  (no items)"}` }));
            } else if (sub === "additem") {
              const tableId = parseInt(args[1]); const itemName = args[2];
              const minQty = parseInt(args[3]) || 1; const maxQty = parseInt(args[4]) || 1;
              const chance = normalizeDropChance(args[5]); const quality = args[6] || "common";
              if (!tableId || isNaN(tableId) || !itemName) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable additem <tableId> <item> <min> <max> <chance> [quality]" })); break; }
              const r = await lootTable.addItem(tableId, itemName, minQty, maxQty, chance, quality);
              if (r && (r as any).error) { sendPacket(wt, packetManager.notify({ message: (r as any).error })); break; }
              sendPacket(wt, packetManager.notify({ message: `Added "${itemName}" to loot table ${tableId}.` }));
            } else if (sub === "removeitem") {
              const itemId = parseInt(args[1]); if (!itemId || isNaN(itemId)) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable removeitem <itemId>" })); break; }
              await lootTable.removeItem(itemId); sendPacket(wt, packetManager.notify({ message: `Item ${itemId} removed from loot table.` }));
            } else if (sub === "updateitem") {
              const itemId = parseInt(args[1]); const minQty = parseInt(args[2]) || 1; const maxQty = parseInt(args[3]) || 1;
              const chance = normalizeDropChance(args[4]); const quality = args[5] || "common";
              if (!itemId || isNaN(itemId)) { sendPacket(wt, packetManager.notify({ message: "Usage: /loottable updateitem <itemId> <min> <max> <chance> [quality]" })); break; }
              await lootTable.updateItem(itemId, minQty, maxQty, chance, quality);
              sendPacket(wt, packetManager.notify({ message: `Item ${itemId} updated.` }));
            } else { sendPacket(wt, packetManager.notify({ message: "Unknown sub-command. Use: list|create|delete|info|additem|removeitem|updateitem" })); }
            break;
          }
          case "LE":
          case "LOOTEDITOR": {
            if (!currentPlayer.permissions.some((p: string) => p === "admin.loot" || p === "admin.*")) {
              sendPacket(wt, packetManager.notify({ message: "You don't have permission to use this command" }));
              break;
            }
            sendPacket(wt, packetManager.toggleLootEditor());
            break;
          }
          default: {
            const notifyData = {
              message: "Invalid command",
            };
            sendPacket(wt, packetManager.notify(notifyData));
            break;
          }
        }
        break;
      }

      case "GET_ONLINE_PLAYERS": {
        if (!currentPlayer?.isAdmin) return;

        const allPlayers = Object.values(playerCache.list());
        const playerList = allPlayers.map((p: any) => ({
          username: p.username,
          map: p.location.map.replace(".json", ""),
          isAdmin: p.isAdmin || false
        }));

        sendPacket(wt, packetManager.onlinePlayersList(playerList));
        break;
      }
  }
}
