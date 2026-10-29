import * as moderation from "../../systems/moderation";
import friends from "../../systems/friends";
import guilds from "../../systems/guild.ts";
import log from "../../modules/logger";
import parties from "../../systems/parties.ts";
import player from "../../systems/player.ts";
import playerCache from "../../services/playermanager.ts";
import spellEffects from "../../systems/spelleffects";
import trades from "../../systems/trades";
import { Events } from "../../systems/events";
import { GuildPermission, refusalText } from "../../systems/guildranks";
import { clusterEnabled } from "../../cluster/config";
import { deliverToPlayer, isOnline, runOnPlayer } from "../../cluster/deliver";
import { entityById } from "../../cluster/mirrors";
import { getPlayerSpriteSheetData, getMountSpriteUrl } from "../../modules/spriteSheetManager";
import { invitations } from "../../cluster/invitations";
import { listener } from "../../modules/event_bus";
import { packetManager } from "../packet_manager";
import { clearParty } from "../partystate";
import { randomBytes } from "../../modules/hash";
import { forgetLook } from "../looks";
import { syncPartyLayers, queueSpawnPlayerPacket, broadcastPlayerUpdate } from "../aoi";
import { answerTradeIfAcross, channelLineOk, chatHearing, chatLinksOf, getAnimationNameForDirection, guildDone, guildEditOk, isQuestRateLimited, kickedFromGuild, offerInvitation, officerChat, pushGuild, queueSpawnForReceivers, sendAnimationTo, sendIgnoreAnswer, sendPacket, sendReport, sendTradeState, shownName, subscriptionLocked, tradeRefusal, withSender } from "../receiver";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["KICK_PARTY_MEMBER", "LEAVE_PARTY", "DISBAND_GUILD", "LEAVE_GUILD", "KICK_GUILD_MEMBER", "GUILD_PROMOTE", "GUILD_DEMOTE", "GUILD_SET_MOTD", "GUILD_SET_NOTE", "GUILD_ADD_RANK", "GUILD_EDIT_RANK", "GUILD_DELETE_RANK", "GUILD_TRANSFER_LEADER", "CREATE_GUILD", "INVITE_GUILD", "GUILD_CHAT", "OFFICER_CHAT", "INVITE_PARTY", "IGNORE_PLAYER", "UNIGNORE_PLAYER", "REPORT_PLAYER", "ADD_FRIEND", "INVITATION_RESPONSE", "REMOVE_FRIEND"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, type, wt } = ctx;
  switch (type) {

      case "KICK_PARTY_MEMBER": {
        if (!currentPlayer) return;

        const partyId = await parties.getPartyId(currentPlayer.username);
        if (!partyId) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const isLeader = await parties.isPartyLeader(currentPlayer.username);
        if (!isLeader) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You are not the party leader" })
          );
          return;
        }

        const member = (data as any)?.username;
        if (!member) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Please provide a username" })
          );
          return;
        }

        const members = await parties.getPartyMembers(partyId);
        if (!members || members?.length === 0) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        if (!members.includes(member)) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${member.charAt(0).toUpperCase() + member.slice(1)
                } is not in your party`,
            })
          );
          return;
        }

        const result = await parties.remove(member);

        // An empty list is the party system's answer when nobody was removed.
        if (result === false || (Array.isArray(result) && result.length === 0)) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `Failed to kick ${member.charAt(0).toUpperCase() + member.slice(1)
                } from the party`,
            })
          );
          return;
        }

        if (typeof result === "boolean" && result) {

          members.forEach(async (m: string) => {
            await runOnPlayer(m, "party-cleared", { message: "The party has been disbanded" });
          });
          listener.emit(Events.PARTY_CHANGED, { type: "disband", members });
          return;
        }

        if (Array.isArray(result) && result.length > 0) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${member.charAt(0).toUpperCase() + member.slice(1)
                } has been kicked from the party`,
            })
          );
          // Those still in the party, the leader among them, get the list as it now is.
          const kickedNotice = `${currentPlayer.username.charAt(0).toUpperCase() +
            currentPlayer.username.slice(1)
            } has kicked ${member.charAt(0).toUpperCase() + member.slice(1)
            } from the party`;
          result.forEach(async (m: string) => {
            const isKicker = m.toLowerCase() === currentPlayer.username.toLowerCase();
            await runOnPlayer(m, "party-update", { members: result, notice: isKicker ? null : kickedNotice });
          });

          const partyLeader = await parties.getPartyLeader(partyId);
          if (partyLeader && result.length > 0) {
            await syncPartyLayers(partyLeader, result, playerCache, sendAnimationTo);
          }

          // The kicked player is not on that list: they are told they have no party.
          if (await runOnPlayer(member, "party-cleared", { message: `You have been kicked from the party` })) {
            listener.emit(Events.PARTY_CHANGED, { type: "kick", username: currentPlayer.username, kickedUsername: member, members: [member] });
          }
        }

        break;
      }

      case "LEAVE_PARTY": {
        if (!currentPlayer) return;

        const partyId = await parties.getPartyId(currentPlayer.username);
        if (!partyId) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const members = await parties.getPartyMembers(partyId);
        if (!members || members?.length === 0) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const result = await parties.leave(currentPlayer.username);

        const type = typeof result;
        // An empty list is the party system's answer when nobody was removed.
        if (result === false || (Array.isArray(result) && result.length === 0)) {
          sendPacket(
            wt,
            packetManager.notify({ message: "Failed to leave party" })
          );
          return;
        }

        if (type === "boolean" && result) {
          members.forEach(async (member: string) => {
            await runOnPlayer(member, "party-cleared", { message: "The party has been disbanded" });
          });
          listener.emit(Events.PARTY_CHANGED, { type: "disband", members });
          // Local: a vanished player is only ever spawned for the party members on this node (INVITATION_RESPONSE).
          if (currentPlayer.isVanished) {
            for (const member of members) {
              const session_id = await player.getSessionIdByUsername(member);
              const pm = session_id && playerCache.get(session_id);
              if (pm && pm.wt && pm.id !== currentPlayer.id) {
                forgetLook(pm.wt, String(currentPlayer.id));
                sendPacket(pm.wt, packetManager.despawnPlayer(currentPlayer.id));
              }
            }
          }
          return;
        }

        if (type === "object" && (result as string[]).length > 0) {
          sendPacket(
            wt,
            packetManager.notify({ message: "You have left the party" })
          );
          if (clusterEnabled()) clearParty(currentPlayer);
          else currentPlayer.party = [];
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(wt, packetManager.updateParty({ members: [] }));
          listener.emit(Events.PARTY_CHANGED, { type: "leave", username: currentPlayer.username, members: [currentPlayer.username] });

          const leftNotice = `${currentPlayer.username.charAt(0).toUpperCase() +
            currentPlayer.username.slice(1)
            } has left the party`;
          (result as string[]).forEach(async (member: string) => {
            await runOnPlayer(member, "party-update", { members: result, notice: leftNotice });
          });

          if ((result as string[]).length > 0) {
            const remainingPartyId = await parties.getPartyId((result as string[])[0]);
            if (remainingPartyId) {
              const partyLeader = await parties.getPartyLeader(remainingPartyId);
              if (partyLeader) {
                await syncPartyLayers(partyLeader, result as string[], playerCache, sendAnimationTo);
              }
            }
          }
          // Vanish: former party members can no longer see the vanished player
          // Local: a vanished player is only ever spawned for the party members on this node (INVITATION_RESPONSE).
          if (currentPlayer.isVanished) {
            for (const member of (result as string[])) {
              const session_id = await player.getSessionIdByUsername(member);
              const pm = session_id && playerCache.get(session_id);
              if (pm && pm.wt && pm.id !== currentPlayer.id) {
                forgetLook(pm.wt, String(currentPlayer.id));
                sendPacket(pm.wt, packetManager.despawnPlayer(currentPlayer.id));
              }
            }
          }
        }
        break;
      }

      case "DISBAND_GUILD": {
        if (!currentPlayer) return;

        const guildId = currentPlayer.guild_id;
        if (!guildId) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        const isLeader = await guilds.isGuildLeader(currentPlayer.username);
        if (!isLeader) {
          sendPacket(wt, packetManager.notify({ message: "You are not the guild leader" }));
          return;
        }

        const members = await guilds.getGuildMembers(guildId);
        if (!members || members.length === 0) {
          sendPacket(wt, packetManager.notify({ message: "Your guild has no members" }));
          return;
        }

        // First, so nobody is told of a disband the guild refused (a transfer got there first).
        if (!(await guilds.disband(currentPlayer.username))) {
          sendPacket(wt, packetManager.notify({ message: "Failed to disband guild" }));
          return;
        }

        for (const member of members) {
          await runOnPlayer(member, "guild-disbanded", { notice: member.toLowerCase() !== currentPlayer.username.toLowerCase() });
        }

        listener.emit(Events.GUILD_CHANGED, { type: "disband", guildId, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username });

        break;
      }

      case "LEAVE_GUILD": {
        if (!currentPlayer) return;

        const guildId = currentPlayer.guild_id;
        if (!guildId) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        const isLeader = await guilds.isGuildLeader(currentPlayer.username);
        if (isLeader) {
          sendPacket(wt, packetManager.notify({ message: "You cannot leave your own guild." }));
          return;
        }

        const members = await guilds.getGuildMembers(guildId);
        if (!members || members.length === 0) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        const result = await guilds.leave(currentPlayer.username);

        // No one left is a leave refused (the Guild Master never leaves) or not written.
        if (!result || (Array.isArray(result) && result.length === 0)) {
          sendPacket(wt, packetManager.notify({ message: "Failed to leave guild" }));
          return;
        }

        listener.emit(Events.GUILD_CHANGED, { type: "leave", guildId, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username });

        currentPlayer.guild_id = null;
        currentPlayer.guild = [];
        currentPlayer.guild_name = null;
        playerCache.set(currentPlayer.id, currentPlayer);

        broadcastPlayerUpdate(currentPlayer);
        sendPacket(wt, packetManager.updateGuild({ members: [] }));
        await pushGuild(guildId);

        break;
      }

      case "KICK_GUILD_MEMBER": {
        if (!currentPlayer) return;

        const guildId = currentPlayer.guild_id;
        if (!guildId) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        const memberUsername = (data as any)?.username;
        if (!memberUsername || typeof memberUsername !== "string") {
          sendPacket(wt, packetManager.notify({ message: "Please provide a username" }));
          return;
        }
        if (!guildEditOk(wt, type)) return;
        const kicked = await guilds.kick(currentPlayer.username, memberUsername);
        if (!guildDone(wt, kicked)) return;
        sendPacket(wt, packetManager.notify({ message: `${memberUsername} has been kicked from the guild` }));
        await pushGuild(guildId);
        await kickedFromGuild(currentPlayer, guildId, memberUsername);

        break;
      }

      case "GUILD_PROMOTE":
      case "GUILD_DEMOTE": {
        if (!currentPlayer) return;
        const target = (data as any)?.username;
        if (typeof target !== "string" || !target) return;
        if (!guildEditOk(wt, type)) return;
        const up = type === "GUILD_PROMOTE";
        const result = up ? await guilds.promote(currentPlayer.username, target) : await guilds.demote(currentPlayer.username, target);
        if (!guildDone(wt, result)) return;
        await pushGuild(currentPlayer.guild_id);
        listener.emit(Events.GUILD_CHANGED, { type: up ? "promote" : "demote", guildId: currentPlayer.guild_id, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username, targetUsername: target });
        break;
      }

      case "GUILD_SET_MOTD": {
        if (!currentPlayer) return;
        if (!guildEditOk(wt, type)) return;
        const result = await guilds.setMotd(currentPlayer.username, (data as any)?.motd);
        if (!guildDone(wt, result) || result.changed === false) return;
        await pushGuild(currentPlayer.guild_id);
        listener.emit(Events.GUILD_CHANGED, { type: "motd", guildId: currentPlayer.guild_id, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username });
        break;
      }

      case "GUILD_SET_NOTE": {
        if (!currentPlayer) return;
        const { username: target, note, officer } = (data as any) || {};
        if (typeof target !== "string" || !target) return;
        if (!guildEditOk(wt, officer === true ? "GUILD_SET_OFFICER_NOTE" : type)) return;
        const result = await guilds.setNote(currentPlayer.username, target, note, officer === true);
        if (!guildDone(wt, result) || result.changed === false) return;
        await pushGuild(currentPlayer.guild_id);
        listener.emit(Events.GUILD_CHANGED, { type: "note", guildId: currentPlayer.guild_id, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username, targetUsername: target });
        break;
      }

      case "GUILD_ADD_RANK":
      case "GUILD_EDIT_RANK":
      case "GUILD_DELETE_RANK": {
        if (!currentPlayer) return;
        if (!guildEditOk(wt, type)) return;
        const body = (data as any) || {};
        const result = type === "GUILD_ADD_RANK" ? await guilds.addRank(currentPlayer.username, body.name)
          : type === "GUILD_EDIT_RANK" ? await guilds.editRank(currentPlayer.username, Number(body.index), { name: body.name, permissions: body.permissions })
          : await guilds.deleteRank(currentPlayer.username);
        if (!guildDone(wt, result) || result.changed === false) return;
        await pushGuild(currentPlayer.guild_id);
        listener.emit(Events.GUILD_CHANGED, { type: "rank", guildId: currentPlayer.guild_id, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username });
        break;
      }

      case "GUILD_TRANSFER_LEADER": {
        if (!currentPlayer) return;
        const target = (data as any)?.username;
        if (typeof target !== "string" || !target) return;
        if (!guildEditOk(wt, type)) return;
        const result = await guilds.transferLeader(currentPlayer.username, target);
        if (!guildDone(wt, result)) return;
        await pushGuild(currentPlayer.guild_id);
        listener.emit(Events.GUILD_CHANGED, { type: "transfer", guildId: currentPlayer.guild_id, guildName: currentPlayer.guild_name, playerUsername: currentPlayer.username, targetUsername: target });
        break;
      }

      case "CREATE_GUILD": {
        if (!currentPlayer) return;
        if (currentPlayer.isGuest) {
          sendPacket(wt, packetManager.notify({ message: "Please create an account to use that feature." }));
          return;
        }
        if (subscriptionLocked(wt, currentPlayer, "guild")) return;

        const guildName = (data as any)?.name;
        if (!guildName || !guildName.trim()) {
          sendPacket(wt, packetManager.notify({ message: "Please provide a guild name" }));
          return;
        }

        const alreadyInGuild = await guilds.isInGuild(currentPlayer.username);
        if (alreadyInGuild) {
          sendPacket(wt, packetManager.notify({ message: "You are already in a guild" }));
          return;
        }

        const nameExists = await guilds.exists(guildName.trim());
        if (nameExists) {
          sendPacket(wt, packetManager.notify({ message: "A guild with that name already exists" }));
          return;
        }

        const result = await guilds.create(currentPlayer.username.toLowerCase(), guildName.trim());
        if (!result) {
          sendPacket(wt, packetManager.notify({ message: "Failed to create guild" }));
          return;
        }

        const guildId = await guilds.getGuildId(currentPlayer.username);
        currentPlayer.guild_id = guildId;
        currentPlayer.guild = result as string[];
        currentPlayer.guild_name = guildName.trim();
        playerCache.set(currentPlayer.id, currentPlayer);

        broadcastPlayerUpdate(currentPlayer);
        await pushGuild(guildId);
        sendPacket(wt, packetManager.notify({ message: `Guild "${guildName.trim()}" created successfully` }));
        listener.emit(Events.GUILD_CHANGED, { type: "create", guildId: currentPlayer.guild_id, guildName: guildName.trim(), playerUsername: currentPlayer.username });
        break;
      }

      case "INVITE_GUILD": {
        const invited_user = (data as any).id;
        const invitedUser = entityById(invited_user);
        const invitedUserUsername = invitedUser?.username || invited_user;
        if (!currentPlayer || !invited_user || !invitedUserUsername) return;

        if (currentPlayer.isGuest) {
          sendPacket(wt, packetManager.notify({ message: "Please create an account to use that feature." }));
          return;
        }
        if (subscriptionLocked(wt, currentPlayer, "guild")) return;

        if (invitedUser.isGuest) {
          sendPacket(wt, packetManager.notify({
            message: `${invitedUserUsername.charAt(0).toUpperCase() + invitedUserUsername.slice(1)} is a guest and cannot join a guild.`,
          }));
          return;
        }

        const guildId = currentPlayer.guild_id;
        if (!guildId) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        if (!(await guilds.can(currentPlayer.username, GuildPermission.INVITE))) {
          sendPacket(wt, packetManager.notify({ message: refusalText.no_permission }));
          return;
        }

        const invitedUserInGuild = await guilds.isInGuild(invitedUserUsername);
        if (invitedUserInGuild) {
          sendPacket(wt, packetManager.notify({
            message: `${invitedUserUsername.charAt(0).toUpperCase() + invitedUserUsername.slice(1)} is already in a guild`,
          }));
          return;
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

        // The one invited is a player in sight on this node.
        await offerInvitation(currentPlayer, invitedUserUsername, invite_data);
        sendPacket(
          wt,
          packetManager.notify({
            message: `Invitation sent to ${invitedUserUsername.charAt(0).toUpperCase() + invitedUserUsername.slice(1)}`,
          })
        );
        break;
      }

      case "GUILD_CHAT": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "guild_chat")) return;

        const { message } = data as any;
        // As /guild: the chat cap, the rate limit, mutes and ignores.
        if (!channelLineOk(wt, message)) return;

        const guildId = currentPlayer.guild_id;
        if (!guildId) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        const allMembers = await guilds.getGuildMembers(guildId);
        if (!allMembers || allMembers.length === 0) {
          sendPacket(wt, packetManager.notify({ message: "You are not in a guild" }));
          return;
        }

        if (!(await guilds.can(currentPlayer.username, GuildPermission.GUILD_CHAT_SPEAK))) {
          sendPacket(wt, packetManager.notify({ message: refusalText.no_permission }));
          return;
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

      case "OFFICER_CHAT": {
        if (!currentPlayer) return;
        await officerChat(wt, currentPlayer, (data as any)?.message);
        break;
      }

      case "INVITE_PARTY": {
        const invited_user = (data as any).id;
        const invitedUser = entityById(invited_user);
        const invitedUserUsername = invitedUser?.username || invited_user;
        if (!currentPlayer || !invited_user || !invitedUserUsername) return;

        if (currentPlayer.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }
        if (subscriptionLocked(wt, currentPlayer, "party")) return;

        if (invitedUser.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is a guest and cannot be invited to a party.`,
            })
          );
          return;
        }

        const partyId = await parties.getPartyId(currentPlayer.username);
        if (partyId) {

          const isLeader = await parties.isPartyLeader(currentPlayer.username);
          if (!isLeader) {
            sendPacket(
              wt,
              packetManager.notify({ message: "You are not the party leader" })
            );
            return;
          }
        }

        const invitedUserPartyId = await parties.getPartyId(
          invitedUserUsername
        );

        if (invitedUserPartyId) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is already in a party`,
            })
          );
          return;
        }

        const invitedUserLeader = await parties.isPartyLeader(
          invitedUserUsername
        );
        if (invitedUserLeader) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is already in a party`,
            })
          );
          return;
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

        if (!invitedUser) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is not online`,
            })
          );
          return;
        }

        // The one invited is a player in sight on this node.
        await offerInvitation(currentPlayer, invitedUserUsername, invite_data);
        sendPacket(
          wt,
          packetManager.notify({
            message: `Invitation sent to ${invitedUserUsername.charAt(0).toUpperCase() +
              invitedUserUsername.slice(1)
              }`,
          })
        );
        listener.emit(Events.PARTY_INVITE, { inviterUsername: currentPlayer.username, invitedUsername: invitedUserUsername });
        break;
      }

      case "IGNORE_PLAYER":
      case "UNIGNORE_PLAYER": {
        if (!currentPlayer) return;
        if (currentPlayer.isGuest) {
          sendPacket(wt, packetManager.notify({ message: "Please create an account to use that feature." }));
          return;
        }
        // Each one writes a row: the same pace as the other things a player clicks.
        if (isQuestRateLimited(String(currentPlayer.id))) return;
        // By the id of a player in sight (the menu on a character), or by name (the list of who is ignored).
        const named = entityById((data as any)?.id)?.username ?? (data as any)?.username;
        if (typeof named !== "string" || !named) return;
        await sendIgnoreAnswer(wt, type === "IGNORE_PLAYER" ? await moderation.ignore(currentPlayer, named) : await moderation.unignore(currentPlayer, named));
        break;
      }

      case "REPORT_PLAYER": {
        if (!currentPlayer) return;
        if (currentPlayer.isGuest) {
          sendPacket(wt, packetManager.notify({ message: "Please create an account to use that feature." }));
          return;
        }
        if (isQuestRateLimited(String(currentPlayer.id))) return;
        const reported = entityById((data as any)?.id)?.username ?? (data as any)?.username;
        if (typeof reported !== "string" || !reported) return;
        await sendReport(wt, currentPlayer, reported, (data as any)?.category, (data as any)?.details);
        break;
      }

      case "ADD_FRIEND": {
        const id = (data as any).id;
        if (!id) return;

        if (!currentPlayer) return;

        if (currentPlayer.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }
        if (subscriptionLocked(wt, currentPlayer, "friends")) return;

        const get_friend = entityById(id);
        if (!get_friend) return;

        if (get_friend.id === currentPlayer.id || get_friend.username.toLowerCase() === currentPlayer.username.toLowerCase()) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "You cannot add yourself as a friend.",
            })
          );
          return;
        }

        const player_username =
          currentPlayer.username.charAt(0).toUpperCase() +
          currentPlayer.username.slice(1);

        if (get_friend.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: `${get_friend.username.charAt(0).toUpperCase() +
                get_friend.username.slice(1)
                } is a guest and cannot be added as a friend.`,
            })
          );
          return;
        }

        const invite_data = {
          action: "FRIEND_REQUEST",
          message: `${player_username} wants to add you as a friend`,
          originator: currentPlayer.id.toString(),
          authorization: randomBytes(16).toString(),
        };

        // The one asked is a player in sight on this node.
        await offerInvitation(currentPlayer, get_friend.username, invite_data);
        break;
      }

      case "INVITATION_RESPONSE": {
        const { action, originator, authorization, response } = data as any;
        if (!action || !originator || !authorization || !response) return;

        log.info(
          `Invitation response received: ${action}, ${originator}, ${authorization}, ${response}`
        );

        const inviterGone = () => sendPacket(
          wt,
          packetManager.notify({
            message:
              "Unable to process invitation - user not found or has disconnected",
          })
        );
        const notFound = () => sendPacket(wt, packetManager.notify({ message: "Invitation not found or has already been processed" }));

        // A trade request stays on the asker's cached player. With a cluster, the asker may be a player of a
        // neighbouring node: their node holds the invitation, and answers it (cluster/tradelink.ts).
        if (action.toUpperCase() === "TRADE_REQUEST") {
          const inviter = playerCache.get(originator);
          if (!inviter) {
            if (await answerTradeIfAcross(wt, currentPlayer, originator, authorization, response)) break;
            inviterGone();
            return;
          }

          const invite = inviter.invitations.find((inv: any) => inv.authorization === authorization);
          if (!invite || invite.action !== action || invite.originator !== originator) {
            notFound();
            return;
          }

          inviter.invitations = inviter.invitations.filter((inv: any) => inv.authorization !== authorization);
          playerCache.set(inviter.id, inviter);

          // Answered by someone it was not sent to: it is spent, and nothing comes of it.
          if (invite.target !== currentPlayer.id.toString()) break;
          if (response.toUpperCase() !== "ACCEPT") {
            sendPacket(inviter.wt, packetManager.notify({ message: `${shownName(currentPlayer.username)} declined your trade request` }));
            break;
          }
          // Things may have changed since it was asked: one walked off, or began another trade.
          const refusal = tradeRefusal(currentPlayer, inviter);
          const trade = refusal ?? trades.open(inviter, currentPlayer);
          if (typeof trade === "string") {
            sendPacket(wt, packetManager.notify({ message: trade }));
            break;
          }
          await sendTradeState(trade);
          break;
        }

        // Party, guild and friend invitations (cluster/invitations.ts): the inviter may be on another node, and
        // is reached by name. Taking one spends it, so of two answers only one finds it.
        const invite = await invitations.take(authorization);
        // Without a cluster an inviter who left took their invitations along: they are said to be gone, as before.
        const inviterOnline = invite ? await isOnline(invite.originatorName) : clusterEnabled() || !!playerCache.get(originator);
        if (!inviterOnline) {
          inviterGone();
          return;
        }

        if (!invite || invite.action !== action || invite.originator !== originator) {
          // An answer that does not match leaves the invitation open, as before.
          if (invite) await invitations.add(invite);
          notFound();
          return;
        }

        // Subscription locks on accepting an invitation (a trade is checked with the trade itself). The invitation stays open.
        if (response.toUpperCase() === "ACCEPT") {
          const lockOfInvitation = ({ INVITE_PARTY: "party", INVITE_GUILD: "guild", FRIEND_REQUEST: "friends" } as Record<string, string>)[action.toUpperCase()];
          if (lockOfInvitation && subscriptionLocked(wt, currentPlayer, lockOfInvitation)) {
            await invitations.add(invite);
            return;
          }
        }

        // The inviter's side (notices, their cached party or guild) is reached by name, on whichever node holds them.
        const inviterName = invite.originatorName;

        switch (action.toUpperCase()) {

          case "FRIEND_REQUEST": {
            if (response.toUpperCase() === "ACCEPT") {

              const updatedCurrentPlayersFriendsList = await friends.add(
                currentPlayer.username.toLowerCase(),
                inviterName.toLowerCase()
              );

              const updatedFriendsList = await friends.add(
                inviterName.toLowerCase(),
                currentPlayer.username.toLowerCase()
              );

              sendPacket(
                wt,
                packetManager.notify({
                  message: `You are now friends with ${inviterName.charAt(0).toUpperCase() +
                    inviterName.slice(1)
                    }`,
                })
              );
              sendPacket(
                wt,
                packetManager.updateFriends({
                  friends: updatedCurrentPlayersFriendsList,
                })
              );

              await deliverToPlayer(
                inviterName,
                packetManager.notify({
                  message: `You are now friends with ${currentPlayer.username.charAt(0).toUpperCase() +
                    currentPlayer.username.slice(1)
                    }`,
                })
              );

              await deliverToPlayer(
                inviterName,
                packetManager.updateFriends({ friends: updatedFriendsList })
              );

              // only an accepted request makes friends
              listener.emit(Events.FRIEND_ADDED, { type: "add", playerUsername: currentPlayer.username, friendUsername: inviterName });
            }
            break;
          }
          case "INVITE_PARTY": {

            const partyId = await parties.getPartyId(inviterName);
            let updatedPartyMembers: string[] | boolean = false;
            if (response.toUpperCase() === "ACCEPT") {

              if (partyId) {

                updatedPartyMembers = await parties.add(
                  currentPlayer.username.toLowerCase(),
                  partyId
                );
                // An empty list is the party system's answer when the player was not added.
                if (!updatedPartyMembers || updatedPartyMembers.length === 0) {
                  sendPacket(
                    wt,
                    packetManager.notify({ message: "Failed to join party" })
                  );
                  return;
                }
                sendPacket(
                  wt,
                  packetManager.notify({
                    message: `You have joined ${inviterName.charAt(0).toUpperCase() +
                      inviterName.slice(1)
                      }'s party`,
                  })
                );
                await deliverToPlayer(
                  inviterName,
                  packetManager.notify({
                    message: `${currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1)
                      } has joined your party`,
                  })
                );

                for (const member of (updatedPartyMembers as string[])) {
                  await runOnPlayer(member, "party-update", { members: updatedPartyMembers, notice: null });
                }

                const partyLeader = await parties.getPartyLeader(partyId);
                if (partyLeader && updatedPartyMembers.length > 0) {
                  await syncPartyLayers(partyLeader, updatedPartyMembers as string[], playerCache, sendAnimationTo);
                }

                // Vanish: spawn all vanished party members to all other online party members
                // Local: a spawn is built from the cached player and queued for players on this node.
                for (const memberUsername of (updatedPartyMembers as string[])) {
                  const memberSessionId = await player.getSessionIdByUsername(memberUsername);
                  const memberPlayer = memberSessionId && playerCache.get(memberSessionId);
                  if (!memberPlayer || !memberPlayer.isVanished) continue;
                  const sd = queueSpawnPlayerPacket(memberPlayer);
                  if (!sd) continue;
                  const an = getAnimationNameForDirection(memberPlayer.location.position?.direction || "down", !!memberPlayer.moving, !!memberPlayer.mounted, memberPlayer.mount_type, !!memberPlayer.casting);
                  const ss = await getPlayerSpriteSheetData(an, memberPlayer.equipment || null);
                  const ms = memberPlayer.mount_type ? getMountSpriteUrl(memberPlayer.mount_type) : null;
                  if (ss?.bodySprite || ss?.headSprite || ms) {
                    (sd as any).spriteData = { mountSprite: ms, bodySprite: ss.bodySprite || null, headSprite: ss.headSprite || null, armorHelmetSprite: ss.armorHelmetSprite || null, armorShoulderguardsSprite: ss.armorShoulderguardsSprite || null, armorNeckSprite: ss.armorNeckSprite || null, armorHandsSprite: ss.armorHandsSprite || null, armorChestSprite: ss.armorChestSprite || null, armorFeetSprite: ss.armorFeetSprite || null, armorLegsSprite: ss.armorLegsSprite || null, armorWeaponSprite: ss.armorWeaponSprite || null, animationState: ss.animationState };
                  }
                  const fx = spellEffects.getEffectsPayload(memberPlayer);
                  if (fx.length > 0) (sd as any).effects = fx;
                  const receivers: any[] = [];
                  for (const otherUsername of (updatedPartyMembers as string[])) {
                    if (otherUsername.toLowerCase() === memberUsername.toLowerCase()) continue;
                    const otherSessionId = await player.getSessionIdByUsername(otherUsername);
                    const otherPlayer = otherSessionId && playerCache.get(otherSessionId);
                    if (otherPlayer && otherPlayer.wt) receivers.push(otherPlayer);
                  }
                  queueSpawnForReceivers(memberPlayer, receivers, (sd as any).spriteData);
                }
              } else {

                updatedPartyMembers = await parties.create(
                  inviterName.toLowerCase(),
                  currentPlayer.username.toLowerCase()
                );
                if (!updatedPartyMembers) {
                  sendPacket(
                    wt,
                    packetManager.notify({ message: "Failed to create party" })
                  );
                  return;
                }
                sendPacket(
                  wt,
                  packetManager.notify({
                    message: `You have joined ${inviterName.charAt(0).toUpperCase() +
                      inviterName.slice(1)
                      }'s party`,
                  })
                );
                await deliverToPlayer(
                  inviterName,
                  packetManager.notify({
                    message: `${currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1)
                      } has joined your party`,
                  })
                );
                await deliverToPlayer(
                  inviterName,
                  packetManager.updateParty({ members: updatedPartyMembers })
                );
                sendPacket(
                  wt,
                  packetManager.updateParty({ members: updatedPartyMembers })
                );
                for (const member of (updatedPartyMembers as string[])) {
                  await runOnPlayer(member, "party-update", { members: updatedPartyMembers, notice: null });
                }

                if (Array.isArray(updatedPartyMembers) && updatedPartyMembers.length > 0) {
                  // Local: layers are synced among the party members on this node (the leader too, or nothing is).
                  await syncPartyLayers(inviterName.toLowerCase(), updatedPartyMembers as string[], playerCache, sendAnimationTo);
                }

                // Vanish: spawn all vanished party members to all other online party members
                // Local: a spawn is built from the cached player and queued for players on this node.
                for (const memberUsername of (updatedPartyMembers as string[])) {
                  const memberSessionId = await player.getSessionIdByUsername(memberUsername);
                  const memberPlayer = memberSessionId && playerCache.get(memberSessionId);
                  if (!memberPlayer || !memberPlayer.isVanished) continue;
                  const sd = queueSpawnPlayerPacket(memberPlayer);
                  if (!sd) continue;
                  const an = getAnimationNameForDirection(memberPlayer.location.position?.direction || "down", !!memberPlayer.moving, !!memberPlayer.mounted, memberPlayer.mount_type, !!memberPlayer.casting);
                  const ss = await getPlayerSpriteSheetData(an, memberPlayer.equipment || null);
                  const ms = memberPlayer.mount_type ? getMountSpriteUrl(memberPlayer.mount_type) : null;
                  if (ss?.bodySprite || ss?.headSprite || ms) {
                    (sd as any).spriteData = { mountSprite: ms, bodySprite: ss.bodySprite || null, headSprite: ss.headSprite || null, armorHelmetSprite: ss.armorHelmetSprite || null, armorShoulderguardsSprite: ss.armorShoulderguardsSprite || null, armorNeckSprite: ss.armorNeckSprite || null, armorHandsSprite: ss.armorHandsSprite || null, armorChestSprite: ss.armorChestSprite || null, armorFeetSprite: ss.armorFeetSprite || null, armorLegsSprite: ss.armorLegsSprite || null, armorWeaponSprite: ss.armorWeaponSprite || null, animationState: ss.animationState };
                  }
                  const fx = spellEffects.getEffectsPayload(memberPlayer);
                  if (fx.length > 0) (sd as any).effects = fx;
                  const receivers: any[] = [];
                  for (const otherUsername of (updatedPartyMembers as string[])) {
                    if (otherUsername.toLowerCase() === memberUsername.toLowerCase()) continue;
                    const otherSessionId = await player.getSessionIdByUsername(otherUsername);
                    const otherPlayer = otherSessionId && playerCache.get(otherSessionId);
                    if (otherPlayer && otherPlayer.wt) receivers.push(otherPlayer);
                  }
                  queueSpawnForReceivers(memberPlayer, receivers, (sd as any).spriteData);
                }

              }
            }
            // Only a join is a join: a declined invitation leaves this false.
            if (Array.isArray(updatedPartyMembers) && updatedPartyMembers.length > 0) {
              listener.emit(Events.PARTY_CHANGED, { type: "join", username: currentPlayer.username, members: updatedPartyMembers } as any);
            }
            break;
          }
          case "INVITE_GUILD": {
            if (response.toUpperCase() === "ACCEPT") {

              // A guest is never sent one from this node; one sent by name from another node could not tell.
              if (currentPlayer.isGuest) {
                sendPacket(wt, packetManager.notify({ message: "Please create an account to use that feature." }));
                return;
              }

              const guildId = await guilds.getGuildId(inviterName);
              if (!guildId) {
                sendPacket(wt, packetManager.notify({ message: "That guild no longer exists" }));
                return;
              }

              if (!(await guilds.can(inviterName, GuildPermission.INVITE))) {
                sendPacket(wt, packetManager.notify({ message: "The inviter can no longer invite to the guild" }));
                return;
              }

              const targetInGuild = await guilds.isInGuild(currentPlayer.username);
              if (targetInGuild) {
                sendPacket(wt, packetManager.notify({ message: "You are already in a guild" }));
                return;
              }

              const updatedGuildMembers = await guilds.add(
                currentPlayer.username.toLowerCase(),
                guildId
              );
              if (!updatedGuildMembers || updatedGuildMembers.length === 0) {
                sendPacket(wt, packetManager.notify({ message: "Failed to join guild" }));
                return;
              }

              const guildName = await guilds.getGuildName(guildId);

              sendPacket(wt, packetManager.notify({
                message: `You have joined "${guildName}"`,
              }));
              await deliverToPlayer(inviterName, packetManager.notify({
                message: `${currentPlayer.username} has joined your guild`,
              }));

              currentPlayer.guild_id = guildId;
              currentPlayer.guild = updatedGuildMembers;
              currentPlayer.guild_name = guildName;
              playerCache.set(currentPlayer.id, currentPlayer);

              broadcastPlayerUpdate(currentPlayer);
              await pushGuild(guildId);
              listener.emit(Events.GUILD_CHANGED, { type: "join", guildId, guildName, playerUsername: currentPlayer.username });
            }
            break;
          }
        }
        break;
      }

      case "REMOVE_FRIEND": {
        const id = (data as any).id;
        const username = (data as any).username;

        if (!currentPlayer) return;

        let get_friend;
        if (id) {
          get_friend = playerCache.get(id);
        } else if (username) {

          get_friend = Object.values(playerCache.list()).find(
            (p: any) => p.username.toLowerCase() === username.toLowerCase()
          );

          if (!get_friend) {
            get_friend = await player.findPlayerInDatabase(username);

            if (Array.isArray(get_friend) && get_friend.length > 0) {
              get_friend = get_friend[0];
            }
          }
        }

        const updatedFriendsList = await friends.remove(
          currentPlayer.username.toLowerCase(),
          get_friend?.username?.toLowerCase() || username.toLowerCase()
        );

        const updatedCurrentPlayersFriendsList = await friends.remove(
          get_friend?.username?.toLowerCase() || username.toLowerCase(),
          currentPlayer.username.toLowerCase()
        );

        // Online here or, in a cluster, on another node (then only their name was found here).
        await deliverToPlayer(
          get_friend?.username?.toLowerCase() || username.toLowerCase(),
          packetManager.updateFriends({
            friends: updatedCurrentPlayersFriendsList,
          })
        );

        sendPacket(
          wt,
          packetManager.updateFriends({ friends: updatedFriendsList })
        );
        sendPacket(
          wt,
          packetManager.notify({
            message: `You have removed ${get_friend.username.charAt(0).toUpperCase() +
              get_friend.username.slice(1)
              } from your friends list`,
          })
        );
        listener.emit(Events.FRIEND_REMOVED, { type: "remove", playerUsername: currentPlayer.username, friendUsername: get_friend.username });
        break;
      }
  }
}
