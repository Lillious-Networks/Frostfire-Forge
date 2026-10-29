import language from "../../systems/language";
import log from "../../modules/logger";
import { Events } from "../../systems/events";
import { MIRROR_RADIUS_PX } from "../../cluster/strip";
import { audience as chatAudience } from "../../systems/chatgate";
import { clusterEnabled } from "../../cluster/config";
import { decryptPrivateKey, decryptRsa, _privateKey } from "../../modules/cipher";
import { findPlayersWithTargetInAOI } from "../aoi";
import { forwardAoiEvent } from "../../cluster/aoievent";
import { listener } from "../../modules/event_bus";
import { packetManager } from "../packet_manager";
import { protectLinks, restoreLinks, type ChatLink } from "../../systems/itemlinks";
import { CHAT_RATE_MAX, CHAT_RATE_WINDOW, MAX_CHAT_LENGTH, chatLinksOf, chatRateLimit, filterPlayersByMap, generateGhostSpeak, isCiphertext, sendPacket, sendPacketBestEffort, subscriptionLocked } from "../receiver";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["CHAT", "TYPING", "STOPTYPING"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, type, wt } = ctx;
  switch (type) {

      case "CHAT": {
        if (!currentPlayer) return;
        // Corpses cannot talk. Ghost speech comes out as spirit-tongue
        // (except admins, who speak normally). Applied after decryption below.
        if (currentPlayer.isDead) return;
        const ghostSpeak = currentPlayer.isGhost && !currentPlayer.isAdmin;
        if (currentPlayer.isGuest) {
          sendPacket(
            wt,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }
        if (subscriptionLocked(wt, currentPlayer, "chat")) return;
        const messageData = data as any;
        const message = messageData?.message;
        const mode = messageData?.mode;

        // A line is text, or in decrypt mode the bytes of one RSA block: anything
        // else (an array of text, a huge object) would skip the length cap.
        if (message != null && (mode === "decrypt" ? !isCiphertext(message) : typeof message !== "string")) return;
        if (typeof message === "string" && message.length > MAX_CHAT_LENGTH) {
          sendPacket(wt, packetManager.notify({ message: `Message too long (max ${MAX_CHAT_LENGTH} characters).` }));
          return;
        }

        const now = Date.now();
        const timestamps = chatRateLimit.get(wt.data.id) || [];
        const recent = timestamps.filter((t) => now - t < CHAT_RATE_WINDOW);
        if (recent.length >= CHAT_RATE_MAX) {
          sendPacket(wt, packetManager.notify({ message: "You are sending messages too fast." }));
          return;
        }
        recent.push(now);
        chatRateLimit.set(wt.data.id, recent);

        const sendMessageToPlayer = (playerWs: any, message: string, links: ChatLink[] = []) => {
          const chatData = {
            id: wt.data.id,
            message,
            username: currentPlayer.username,
            ...(links.length > 0 ? { links } : {}),
          };
          sendPacket(playerWs, packetManager.chat(chatData));
        };

        if (message == null) {
          sendMessageToPlayer(wt, "");
          findPlayersWithTargetInAOI(currentPlayer.id).forEach((player) => {
            sendMessageToPlayer(player.wt, "");
          });
          return;
        }

        let decryptedMessage;
        if (mode && mode == "decrypt") {
          const encryptedMessage = Buffer.from(
            Object.values(message) as number[]
          );
          const privateKey = _privateKey;
          if (!privateKey) return;
          const decryptedPrivateKey = decryptPrivateKey(
            privateKey,
            process.env.RSA_PASSPHRASE || ""
          ).toString();
          decryptedMessage =
            decryptRsa(encryptedMessage, decryptedPrivateKey) || "";
          if (typeof decryptedMessage !== "string" || decryptedMessage.length > MAX_CHAT_LENGTH) return;
        } else {
          decryptedMessage = message;
        }

        // Ghosts (non-admin) speak only in spirit-tongue: random short
        // O-words, deliberately unrelated to the real message's length.
        if (ghostSpeak) {
          decryptedMessage = generateGhostSpeak();
        }

        // Item links come from the text actually sent: a ghost's spirit-tongue has none.
        const linked = ghostSpeak
          ? { message: decryptedMessage as string, links: [] as ChatLink[] }
          : await chatLinksOf(decryptedMessage as string);
        const sentMessage = linked.message;
        const sentLinks = linked.links;

        sendMessageToPlayer(wt, sentMessage, sentLinks);

        // Who hears a line is who can see the speaker: on a big map that is the
        // crowd nearby, not every player on it.
        let playersInMap = findPlayersWithTargetInAOI(currentPlayer.id).filter((p) => p.id !== wt.data.id);

        if (currentPlayer.isStealth) {

          playersInMap = playersInMap.filter((p) => p.isAdmin);
        }

        // A muted player's line stops here, shown to them alone, and a player
        // who ignores them is left out. Neither is told.
        const said = await chatAudience(currentPlayer.username, "say", decryptedMessage as string, playersInMap.map((p) => p.username));
        if (said.muted) return;
        const hearing = new Set(said.recipients);
        playersInMap = playersInMap.filter((p) => hearing.has(p.username));

        // Cluster mode: listeners across a block border hear the line too, even when no one here does (so
        // before the return below). Their node sends it as written: translation needs the listener's
        // language, which only their node knows. A stealthed or vanished speaker is heard by admins only,
        // and the other node cannot tell its admins apart for this, so the line stays here. Cluster off,
        // the packet is not even built.
        if (clusterEnabled() && !currentPlayer.isStealth && !currentPlayer.isVanished) {
          forwardAoiEvent(
            String(currentPlayer.location.map), currentPlayer.aoi?.layerId ?? null,
            Number(currentPlayer.location.position.x), Number(currentPlayer.location.position.y),
            MIRROR_RADIUS_PX,
            packetManager.chat({ id: wt.data.id, message: sentMessage, username: currentPlayer.username, ...(sentLinks.length > 0 ? { links: sentLinks } : {}) }),
            // The other node holds the line back from listeners who ignore the speaker or cannot see them.
            { speaker: currentPlayer.username }
          );
        }

        listener.emit(Events.PLAYER_CHAT, { player: currentPlayer, message: decryptedMessage || data?.toString(), mapName: currentPlayer.location.map });

        if (playersInMap.length === 0) return;

        const translations: Record<string, string> = {};
        // Link tokens go through the translator as placeholders and are put back after, so a link
        // is never translated; a translation that lost one is dropped for the line as sent.
        const protectedLine = protectLinks(sentMessage, sentLinks);

        playersInMap.forEach(async (player) => {
          if (!translations[player.language]) {

            // A translator that throws must not cost the recipient the line: they get it as sent,
            // links included (this runs once per language, so it logs once per language).
            let line = sentMessage;
            if (player.language !== currentPlayer.language) {
              try {
                line = sentLinks.length === 0
                  ? await language.translate(sentMessage, player.language) ?? sentMessage
                  : restoreLinks(await language.translate(protectedLine.text, player.language), protectedLine.held) ?? sentMessage;
              } catch (error) {
                log.warn(`Chat translation to ${player.language} failed, sending the line untranslated: ${error}`);
              }
            }
            translations[player.language] = line;
          }

          const chatData = {
            id: wt.data.id,
            message: translations[player.language],
            username: currentPlayer.username,
            ...(sentLinks.length > 0 ? { links: sentLinks } : {}),
          };

          sendPacket(player.wt, packetManager.chat(chatData));
        });
        break;
      }

      case "TYPING": {
        if (!currentPlayer || currentPlayer?.isGuest) return;
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        const typingData = {
          id: wt.data.id,
        };
        let playersInMap = filterPlayersByMap(currentPlayer.location.map);
        if (currentPlayer.isStealth) {
          playersInMap = playersInMap.filter((p) => p.isAdmin);
        }
        playersInMap.forEach((player) => {
          sendPacketBestEffort(player.wt, packetManager.typing(typingData));
        });
        break;
      }

      case "STOPTYPING": {
        if (!currentPlayer || currentPlayer.isGuest) return;
        let playersInMap = filterPlayersByMap(currentPlayer.location.map);
        const stopTypingData = {
          id: wt.data.id,
        };
        if (currentPlayer.isStealth) {
          playersInMap = playersInMap.filter((p) => p.isAdmin);
        }
        playersInMap.forEach((player) => {
          sendPacketBestEffort(player.wt, packetManager.stopTyping(stopTypingData));
        });
        break;
      }
  }
}
