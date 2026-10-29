import assetCache from "../../services/assetCache";
import currencySystem from "../../systems/currency";
import homes, { isInnkeeper } from "../../systems/homes";
import inventory from "../../systems/inventory";
import log from "../../modules/logger";
import npcSystem from "../../systems/npcs";
import player from "../../systems/player.ts";
import playerCache from "../../services/playermanager.ts";
import query from "../../controllers/sqldatabase";
import questDefinitions from "../../systems/quests/definitions";
import questLogApi from "../../systems/quests/log";
import vendors from "../../systems/vendors";
import { readNpcList } from "../../systems/npcStreaming";
import { Events } from "../../systems/events";
import { broadcastToAOI } from "../aoi";
import { credit as creditObjective } from "../../systems/quests/objectives";
import { listSpriteSheets, listIcons } from "../../systems/creatures/editor";
import { listener } from "../../modules/event_bus";
import { packetManager } from "../packet_manager";
import { NPC_INTERACT_RADIUS, filterPlayersByMap, getInventorySlots, isQuestRateLimited, patchInventoryBagSlots, resendMapMarkers, sendPacket, sendQuestMarkersFor, sendVendorAnswer, sendVendorStock, subscriptionLocked, vendorFor, vendorStockFrom } from "../receiver";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["NPC_INTERACT", "VENDOR_OPEN", "VENDOR_BUY", "VENDOR_SELL", "VENDOR_BUYBACK", "QUEST_SELECT", "QUEST_ACCEPT", "QUEST_DECLINE", "QUEST_ABANDON", "QUEST_TURN_IN", "LIST_NPCS", "ADD_NPC", "SAVE_NPC", "MOVE_NPC", "DELETE_NPC"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, resolveNpcForClient, type, wt } = ctx;
  switch (type) {

      case "NPC_INTERACT": {
        if (!currentPlayer) return;
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        if (isQuestRateLimited(`npc:${wt.data.id}`)) return;
        const npcId = Number((data as any)?.npcId ?? (data as any)?.id);
        if (!Number.isFinite(npcId)) return;
        const npcsData = await readNpcList();
        const npc = npcsData.find((n) => Number(n.id) === npcId);
        if (!npc || npc.hidden) return;
        const playerMap = String(currentPlayer.location.map ?? "").replaceAll(".json", "");
        if (String(npc.map ?? "").replaceAll(".json", "") !== playerMap) return;
        const pos = currentPlayer.location.position;
        if (!pos) return;
        const dist = Math.hypot(Number(pos.x) - Number(npc.position.x), Number(pos.y) - Number(npc.position.y));
        if (dist > NPC_INTERACT_RADIUS) {
          sendPacket(wt, packetManager.questError({ code: "too_far", message: "You are too far from that NPC." }));
          break;
        }
        // Talk objectives credit on interaction, before the offer list is built.
        try {
          const talkUpdates = await creditObjective(currentPlayer.username, "talk", String(npcId), 1);
          if (talkUpdates.length > 0) {
            const byQuest = new Map<number, ObjectiveUpdate[]>();
            for (const u of talkUpdates) {
              const list = byQuest.get(u.questId) || [];
              list.push(u);
              byQuest.set(u.questId, list);
            }
            for (const [questId, questUpdates] of byQuest) {
              sendPacket(wt, packetManager.questProgress({ questId, updates: questUpdates }));
            }
            await sendQuestMarkersFor(wt, currentPlayer.username, playerMap);
          }
        } catch {
          // Talk credit is best-effort.
        }
        const offers = await questLogApi.offersFor(currentPlayer.username, npcId);
        // Locked quests (level-gated, prerequisite-locked) are hidden from
        // the player, so they must not count toward the skip-the-menu
        // decision: one visible quest opens its frame directly.
        const visibleOffers = offers.filter(
          (o) => !(o.marker === "available_future" && (o.reason === "level_too_low" || o.reason === "missing_prerequisite"))
        );
        // An NPC with something in stock is a vendor. With no quest to talk about, talking to it opens
        // its goods; with quests, they are listed and the goods are one more line under them.
        const sells = vendors.isVendor(npc);
        // An innkeeper's inn can be made the player's home: a line of its own, so talking to one always lists what it offers.
        const keepsInn = isInnkeeper(npc);
        if (visibleOffers.length === 0) {
          if (sells && !keepsInn) {
            const vendor = await vendorFor(wt, currentPlayer, npcId);
            if (vendor) await sendVendorStock(wt, currentPlayer, vendor);
            break;
          }
          sendPacket(
            wt,
            packetManager.npcGossip({ npcId, name: npc.name || null, gossipText: npc.dialog || null, quests: [], vendor: sells, innkeeper: keepsInn })
          );
          break;
        }
        if (visibleOffers.length === 1 && !sells && !keepsInn) {
          const offer = visibleOffers[0]!;
          const quest = questDefinitions.find(offer.questId);
          if (!quest) break;
          if (offer.action === "offer") {
            const eligibility = await questLogApi.eligibility(currentPlayer.username, quest.id);
            sendPacket(
              wt,
              packetManager.questOffer({ npcId, quest, canAccept: eligibility === "available", reason: eligibility })
            );
          } else if (offer.action === "incomplete") {
            const cached = questLogApi.getCachedLog(currentPlayer.username);
            const entry = cached?.active.find((e) => e.quest_id === quest.id);
            const progress: ObjectiveUpdate[] = (quest.objectives || []).map((o) => ({
              questId: quest.id,
              objectiveId: o.id,
              type: o.type,
              target: o.target,
              count: Math.min(Number(entry?.progress[o.id]) || 0, o.required_count),
              required: o.required_count,
              questReady: false,
            }));
            sendPacket(wt, packetManager.questIncomplete({ npcId, quest, progress }));
          } else {
            sendPacket(wt, packetManager.questTurnInOffer({ npcId, quest }));
          }
          break;
        }
        sendPacket(
          wt,
          packetManager.npcGossip({ npcId, name: npc.name || null, gossipText: npc.dialog || null, quests: offers, vendor: sells, innkeeper: keepsInn })
        );
        break;
      }

      case "VENDOR_OPEN": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "vendor")) return;
        if (isQuestRateLimited(`npc:${wt.data.id}`)) return;
        const vendor = await vendorFor(wt, currentPlayer, (data as any)?.npcId);
        if (vendor) await sendVendorStock(wt, currentPlayer, vendor);
        break;
      }

      case "VENDOR_BUY": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "vendor")) return;
        const vendor = await vendorFor(wt, currentPlayer, (data as any)?.npcId);
        if (!vendor) break;
        const bought = await vendors.buy(currentPlayer.username, vendor, String((data as any)?.item ?? ""), (data as any)?.quantity ?? 1);
        await sendVendorAnswer(wt, currentPlayer, vendor, bought, Events.VENDOR_BUY);
        break;
      }

      case "VENDOR_SELL": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "vendor")) return;
        const vendor = await vendorFor(wt, currentPlayer, (data as any)?.npcId);
        if (!vendor) break;
        // No amount is all of it that is spare.
        const sold = await vendors.sell(currentPlayer.username, String((data as any)?.item ?? ""), (data as any)?.quantity ?? undefined);
        await sendVendorAnswer(wt, currentPlayer, vendor, sold, Events.VENDOR_SELL);
        break;
      }

      case "VENDOR_BUYBACK": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "vendor")) return;
        const vendor = await vendorFor(wt, currentPlayer, (data as any)?.npcId);
        if (!vendor) break;
        const returned = await vendors.buyback(currentPlayer.username, (data as any)?.index);
        await sendVendorAnswer(wt, currentPlayer, vendor, returned, Events.VENDOR_BUY);
        break;
      }

      case "QUEST_SELECT": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "quests")) return;
        if (isQuestRateLimited(`qs:${wt.data.id}`)) return;
        const npcId = Number((data as any)?.npcId);
        const questId = Number((data as any)?.questId);
        if (!Number.isFinite(npcId) || !Number.isFinite(questId)) return;
        const npcsData = await readNpcList();
        const npc = npcsData.find((n) => Number(n.id) === npcId);
        if (!npc || npc.hidden) return;
        const playerMap = String(currentPlayer.location.map ?? "").replaceAll(".json", "");
        if (String(npc.map ?? "").replaceAll(".json", "") !== playerMap) return;
        const pos = currentPlayer.location.position;
        if (!pos) return;
        if (Math.hypot(Number(pos.x) - Number(npc.position.x), Number(pos.y) - Number(npc.position.y)) > NPC_INTERACT_RADIUS) {
          sendPacket(wt, packetManager.questError({ code: "too_far", message: "You are too far from that NPC." }));
          break;
        }
        const offers = await questLogApi.offersFor(currentPlayer.username, npcId);
        const offer = offers.find((o) => o.questId === questId);
        if (!offer) return;
        const quest = questDefinitions.find(questId);
        if (!quest) return;
        if (offer.action === "offer") {
          const eligibility = await questLogApi.eligibility(currentPlayer.username, quest.id);
          sendPacket(
            wt,
            packetManager.questOffer({ npcId, quest, canAccept: eligibility === "available", reason: eligibility })
          );
        } else if (offer.action === "incomplete") {
          const cached = questLogApi.getCachedLog(currentPlayer.username);
          const entry = cached?.active.find((e) => e.quest_id === quest.id);
          const progress: ObjectiveUpdate[] = (quest.objectives || []).map((o) => ({
            questId: quest.id,
            objectiveId: o.id,
            type: o.type,
            target: o.target,
            count: Math.min(Number(entry?.progress[o.id]) || 0, o.required_count),
            required: o.required_count,
            questReady: false,
          }));
          sendPacket(wt, packetManager.questIncomplete({ npcId, quest, progress }));
        } else {
          sendPacket(wt, packetManager.questTurnInOffer({ npcId, quest }));
        }
        break;
      }

      case "QUEST_ACCEPT": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "quests")) return;
        if (isQuestRateLimited(`qa:${wt.data.id}`)) return;
        const npcId = Number((data as any)?.npcId);
        const questId = Number((data as any)?.questId);
        if (!Number.isFinite(npcId) || !Number.isFinite(questId)) return;
        // Never trust a client-supplied quest id without checking range.
        const npcsData = await readNpcList();
        const npc = npcsData.find((n) => Number(n.id) === npcId);
        if (!npc) return;
        const playerMap = String(currentPlayer.location.map ?? "").replaceAll(".json", "");
        if (String(npc.map ?? "").replaceAll(".json", "") !== playerMap) return;
        const pos = currentPlayer.location.position;
        if (!pos) return;
        if (Math.hypot(Number(pos.x) - Number(npc.position.x), Number(pos.y) - Number(npc.position.y)) > NPC_INTERACT_RADIUS) {
          sendPacket(wt, packetManager.questError({ code: "too_far", message: "You are too far from that NPC." }));
          break;
        }
        const result = await questLogApi.accept(currentPlayer.username, questId, npcId);
        if (!result.ok || !result.entry || !result.quest) {
          sendPacket(wt, packetManager.questError({ code: result.code || "ineligible", message: result.error || "You cannot accept that quest." }));
          break;
        }
        sendPacket(wt, packetManager.questLogEntry({ entry: result.entry, quest: result.quest }));
        // The accept backfill may have credited collect/explore immediately.
        const backfilled: ObjectiveUpdate[] = (result.quest.objectives || [])
          .filter((o) => (Number(result.entry!.progress[o.id]) || 0) > 0)
          .map((o) => ({
            questId: result.quest!.id,
            objectiveId: o.id,
            type: o.type,
            target: o.target,
            count: Number(result.entry!.progress[o.id]) || 0,
            required: o.required_count,
            questReady: result.entry!.state === "ready",
          }));
        if (backfilled.length > 0) {
          sendPacket(wt, packetManager.questProgress({ questId: result.quest.id, updates: backfilled }));
        }
        await sendQuestMarkersFor(wt, currentPlayer.username, currentPlayer.location.map);
        break;
      }

      case "QUEST_DECLINE": {
        // Closes the frame client-side. No state change; exists so packet
        // interceptors and plugins can observe it.
        break;
      }

      case "QUEST_ABANDON": {
        if (!currentPlayer) return;
        if (isQuestRateLimited(`qab:${wt.data.id}`)) return;
        const questId = Number((data as any)?.questId);
        if (!Number.isFinite(questId)) return;
        const cached = questLogApi.getCachedLog(currentPlayer.username);
        const entry = cached?.active.find((e) => e.quest_id === questId);
        if (!entry) {
          sendPacket(wt, packetManager.questError({ code: "not_active", message: "That quest is not in your log." }));
          break;
        }
        const quest = questDefinitions.find(questId);
        await questLogApi.abandon(currentPlayer.username, questId);
        // Still in the log: the abandon could not be written, so the quest is not gone.
        if (questLogApi.getCachedLog(currentPlayer.username)?.active.some((e) => e.quest_id === questId)) {
          sendPacket(wt, packetManager.questError({ code: "db_error", message: "Could not abandon the quest." }));
          break;
        }
        if (quest) {
          sendPacket(wt, packetManager.questLogEntry({ entry: null, quest, removed: true }));
        }
        await sendQuestMarkersFor(wt, currentPlayer.username, currentPlayer.location.map);
        break;
      }

      case "QUEST_TURN_IN": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "quests")) return;
        if (isQuestRateLimited(`qt:${wt.data.id}`)) return;
        const npcId = Number((data as any)?.npcId);
        const questId = Number((data as any)?.questId);
        const rewardChoiceIndex = (data as any)?.rewardChoiceIndex;
        if (!Number.isFinite(npcId) || !Number.isFinite(questId)) return;
        // Range check before anything else; never trust client-supplied ids.
        const npcsData = await readNpcList();
        const npc = npcsData.find((n) => Number(n.id) === npcId);
        if (!npc) return;
        const playerMap = String(currentPlayer.location.map ?? "").replaceAll(".json", "");
        if (String(npc.map ?? "").replaceAll(".json", "") !== playerMap) return;
        const pos = currentPlayer.location.position;
        if (!pos) return;
        if (Math.hypot(Number(pos.x) - Number(npc.position.x), Number(pos.y) - Number(npc.position.y)) > NPC_INTERACT_RADIUS) {
          sendPacket(wt, packetManager.questError({ code: "too_far", message: "You are too far from that NPC." }));
          break;
        }
        const result = await questLogApi.turnIn(currentPlayer.username, questId, npcId, rewardChoiceIndex);
        if (!result.ok) {
          sendPacket(
            wt,
            packetManager.questError({ code: result.code || "turnin_failed", message: result.error || "Could not turn in that quest." })
          );
          break;
        }
        const quest = questDefinitions.find(questId);
        if (quest) {
          sendPacket(wt, packetManager.questLogEntry({ entry: null, quest, removed: true }));
        }
        sendPacket(
          wt,
          packetManager.questCompleted({
            questId: result.questId!,
            xp: result.xp || 0,
            copper: result.copper || 0,
            items: result.items || [],
            nextQuestId: result.nextQuestId ?? null,
          })
        );
        // Sync the client with the granted rewards.
        try {
          currentPlayer.inventory = await patchInventoryBagSlots(await inventory.get(currentPlayer.username), currentPlayer.username);
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        } catch {
          // Best-effort.
        }
        try {
          const balance = await currencySystem.get(currentPlayer.username);
          currentPlayer.currency = balance;
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(wt, packetManager.currency(balance));
        } catch {
          // Best-effort.
        }
        try {
          // Merge the fresh XP first: synchronizeStats rebuilds from the
          // in-memory copy and would otherwise wipe the just-granted
          // xp/level back to their pre-turn-in values (same pattern as the
          // creature-kill XP path).
          const levelBefore = Number(currentPlayer.stats?.level) || 1;
          const xpResult = result.xpResult;
          if (xpResult) {
            currentPlayer.stats.xp = xpResult.xp;
            currentPlayer.stats.max_xp = xpResult.max_xp;
            currentPlayer.stats.level = xpResult.level;
          }
          const leveled = !!xpResult && xpResult.level > levelBefore;
          if (leveled) {
            currentPlayer.stats.max_health = player.getMaxHealthForLevel(xpResult!.level);
            currentPlayer.stats.max_stamina = player.getMaxStaminaForLevel(xpResult!.level);
            const synced = await player.synchronizeStats(currentPlayer.username);
            if (synced) currentPlayer.stats = synced;
            currentPlayer.stats.health = currentPlayer.stats.total_max_health ?? currentPlayer.stats.max_health;
            currentPlayer.stats.stamina = currentPlayer.stats.total_max_stamina ?? currentPlayer.stats.max_stamina;
          } else {
            const syncedStats = await player.synchronizeStats(currentPlayer.username);
            if (syncedStats) currentPlayer.stats = syncedStats;
          }
          playerCache.set(currentPlayer.id, currentPlayer);
          // XP bar: UPDATESTATS handlers only merge health/mana, so push the
          // dedicated XP packet too.
          if (xpResult) {
            sendPacket(
              wt,
              packetManager.updateXp({ id: currentPlayer.id, xp: xpResult.xp, level: xpResult.level, max_xp: xpResult.max_xp })
            );
          }
          const statsPacket = packetManager.updateStats({ id: currentPlayer.id, target: currentPlayer.id, stats: currentPlayer.stats });
          if (leveled) {
            broadcastToAOI(currentPlayer, statsPacket);
            listener.emit(Events.PLAYER_LEVEL_UP, { player: currentPlayer, level: xpResult!.level });
          } else {
            sendPacket(wt, statsPacket);
          }
        } catch {
          // Best-effort.
        }
        await sendQuestMarkersFor(wt, currentPlayer.username, currentPlayer.location.map);
        break;
      }

      case "LIST_NPCS": {
        if (!currentPlayer) return;
        // The NPC editor's list (scripts, stock, quest links): for those who may save NPCs, as SAVE_NPC.
        if (!currentPlayer.permissions.some((p: string) => p === "server.admin" || p === "server.*")) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to edit NPCs." }));
          return;
        }

        try {
          const allNpcs = await assetCache.get("npcs") as Npc[];
          const mapName = currentPlayer.location.map;
          // map-placed particle NPCs are edited in the map (Particles layer), not here
          const npcsInMap = (allNpcs || []).filter((npc: Npc) => npc.map === mapName && !npcSystem.isMapNpc(npc));
          // Resolve particles to include all particle data (including time fields)
          const resolvedNpcs = await Promise.all(npcsInMap.map(resolveNpcForClient));
          // Quest links for the NPC editor's given/ended pickers.
          for (const npc of resolvedNpcs) {
            const npcId = Number((npc as any).id);
            if (Number.isFinite(npcId)) {
              (npc as any).questsGiven = questDefinitions.questsGivenBy(npcId);
              (npc as any).questsEnded = questDefinitions.questsEndedBy(npcId);
            }
          }
          const questCatalog = questDefinitions.getCachedQuestsSync().map((q) => ({ id: q.id, name: q.name }));
          // Sprite data for the appearance tab, same feed as the creature editor.
          const [spriteSheets, icons] = await Promise.all([listSpriteSheets(), listIcons()]);
          // The items there are, for picking what a vendor stocks.
          const items = (((await assetCache.get("items")) || []) as Item[])
            .map((item) => ({ name: item.name, icon: item.icon ?? null, quality: item.quality, sell_price: item.sell_price ?? 1, buy_price: item.buy_price ?? 0 }));

          sendPacket(wt, packetManager.npcList(resolvedNpcs, questCatalog, { spriteSheets, icons, items }));
        } catch (error: any) {
          log.error(`Error listing NPCs: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: "Error loading NPCs." }));
        }
        break;
      }

      case "ADD_NPC": {
        if (!currentPlayer) return;

        if (
          !currentPlayer.permissions.some(
            (p: string) => p === "server.admin" || p === "server.*"
          )
        ) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to add NPCs." }));
          return;
        }

        try {
          const mapName = currentPlayer.location.map;
          const clientData = data as any;
          const newNpc: Npc = {
            id: null,
            last_updated: null,
            map: mapName,
            name: clientData?.name ?? null,
            position: {
              x: clientData?.position?.x ?? currentPlayer.location.position.x,
              y: clientData?.position?.y ?? currentPlayer.location.position.y,
              direction: clientData?.position?.direction ?? "down",
            },
            hidden: clientData?.hidden ?? false,
            script: clientData?.script ?? null,
            dialog: clientData?.dialog ?? null,
            gossip: clientData?.gossip ?? null,
            particles: clientData?.particles ?? [],
            quest_giver: clientData?.quest_giver === true || clientData?.quest_giver === 1,
            sprite_type: clientData?.sprite_type ?? 'animated',
            sprite_body: clientData?.sprite_body ?? null,
            sprite_head: clientData?.sprite_head ?? null,
            sprite_helmet: clientData?.sprite_helmet ?? null,
            sprite_shoulderguards: clientData?.sprite_shoulderguards ?? null,
            sprite_neck: clientData?.sprite_neck ?? null,
            sprite_hands: clientData?.sprite_hands ?? null,
            sprite_chest: clientData?.sprite_chest ?? null,
            sprite_feet: clientData?.sprite_feet ?? null,
            sprite_legs: clientData?.sprite_legs ?? null,
            sprite_weapon: clientData?.sprite_weapon ?? null,
            vendor_items: await vendorStockFrom(wt, clientData?.vendor_items),
            innkeeper: clientData?.innkeeper === true || clientData?.innkeeper === 1,
            sound_npc: clientData?.sound_npc === true || clientData?.sound_npc === 1,
            sound: typeof clientData?.sound === "string" ? clientData.sound : null,
            sound_radius: Number(clientData?.sound_radius) || 0,
          };

          await npcSystem.add(newNpc);
          const updatedNpcs = await npcSystem.list();
          await assetCache.set("npcs", updatedNpcs);
          if (newNpc.innkeeper || vendors.isVendor(newNpc)) void resendMapMarkers();

          const createdNpc = updatedNpcs
            .filter((n: Npc) => n.map === mapName)
            .sort((a: Npc, b: Npc) => (b.id ?? 0) - (a.id ?? 0))[0];

          // Quest links arrive as questsGiven / questsEnded arrays.
          if (createdNpc?.id) {
            const given: number[] = Array.isArray(clientData?.questsGiven) ? clientData.questsGiven : [];
            const ended: number[] = Array.isArray(clientData?.questsEnded) ? clientData.questsEnded : [];
            try {
              await query("DELETE FROM npc_quests WHERE npc_id = ?", [createdNpc.id]);
              for (const qid of [...new Set([...given.map(Number), ...ended.map(Number)])]) {
                if (!Number.isFinite(qid)) continue;
                if (given.map(Number).includes(qid)) {
                  await query("INSERT INTO npc_quests (npc_id, quest_id, `role`) VALUES (?, ?, 'giver')", [createdNpc.id, qid]);
                }
                if (ended.map(Number).includes(qid)) {
                  await query("INSERT INTO npc_quests (npc_id, quest_id, `role`) VALUES (?, ?, 'ender')", [createdNpc.id, qid]);
                }
              }
              await questDefinitions.reload();
            } catch {
              // Quest links are best-effort on NPC create. Some may have been
              // written: the links held are read again, so they are what the
              // database has.
              await questDefinitions.reload().catch(() => {});
            }
          }

          if (createdNpc) {
            const resolvedNpc = await resolveNpcForClient(createdNpc);
            const updatePacket = packetManager.npcUpdated(resolvedNpc);
            const playersInMap = filterPlayersByMap(mapName);
            for (const p of playersInMap) {
              if (p.wt && p.wt.readyState === 1) {
                sendPacket(p.wt, updatePacket);
              }
            }
          }

          log.info(`NPC added by ${currentPlayer.username} on map ${mapName}`);
        } catch (error: any) {
          log.error(`Error adding NPC: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: "Error adding NPC." }));
        }
        break;
      }

      case "SAVE_NPC": {
        if (!currentPlayer) return;

        if (
          !currentPlayer.permissions.some(
            (p: string) => p === "server.admin" || p === "server.*"
          )
        ) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to save NPCs." }));
          return;
        }

        try {
          const npcData = data as unknown as Npc;
          if (!npcData?.id) {
            sendPacket(wt, packetManager.notify({ message: "Invalid NPC data." }));
            return;
          }

          // What the NPC stocks is checked against the items there are. An editor that sends no
          // stock at all (one from before vendors) leaves what the NPC has.
          npcData.vendor_items = npcData.vendor_items === undefined
            ? (((await assetCache.get("npcs")) || []) as Npc[]).find((held) => Number(held.id) === Number(npcData.id))?.vendor_items ?? []
            : await vendorStockFrom(wt, npcData.vendor_items);
          // Whether it keeps an inn, the same way: an editor that does not say leaves it as it is.
          npcData.innkeeper = npcData.innkeeper === undefined
            ? (((await assetCache.get("npcs")) || []) as Npc[]).find((held) => Number(held.id) === Number(npcData.id))?.innkeeper === true
            : npcData.innkeeper === true || (npcData.innkeeper as unknown) === 1;
          // Its sound, the same way: an editor from before sound NPCs leaves what the NPC plays.
          if (npcData.sound_npc === undefined) {
            const held = (((await assetCache.get("npcs")) || []) as Npc[]).find((n) => Number(n.id) === Number(npcData.id));
            npcData.sound_npc = held?.sound_npc === true;
            npcData.sound = held?.sound ?? null;
            npcData.sound_radius = held?.sound_radius ?? 0;
          } else {
            npcData.sound_npc = npcData.sound_npc === true || (npcData.sound_npc as unknown) === 1;
            npcData.sound = typeof npcData.sound === "string" ? npcData.sound : null;
          }

          await npcSystem.update(npcData);
          const updatedNpcs = await npcSystem.list();
          await assetCache.set("npcs", updatedNpcs);

          // Quest links arrive as questsGiven / questsEnded arrays.
          try {
            const given: number[] = Array.isArray((npcData as any)?.questsGiven) ? (npcData as any).questsGiven : [];
            const ended: number[] = Array.isArray((npcData as any)?.questsEnded) ? (npcData as any).questsEnded : [];
            if ((npcData as any)?.questsGiven !== undefined || (npcData as any)?.questsEnded !== undefined) {
              await query("DELETE FROM npc_quests WHERE npc_id = ?", [npcData.id]);
              for (const qid of [...new Set([...given.map(Number), ...ended.map(Number)])]) {
                if (!Number.isFinite(qid)) continue;
                if (given.map(Number).includes(qid)) {
                  await query("INSERT INTO npc_quests (npc_id, quest_id, `role`) VALUES (?, ?, 'giver')", [npcData.id, qid]);
                }
                if (ended.map(Number).includes(qid)) {
                  await query("INSERT INTO npc_quests (npc_id, quest_id, `role`) VALUES (?, ?, 'ender')", [npcData.id, qid]);
                }
              }
              await questDefinitions.reload();
            }
          } catch {
            // Quest links are best-effort on NPC save. Some may have been
            // written: the links held are read again, so they are what the
            // database has.
            await questDefinitions.reload().catch(() => {});
          }

          const updatedNpc = updatedNpcs.find((n: Npc) => n.id === npcData.id);
          if (updatedNpc) {
            const resolvedNpc = await resolveNpcForClient(updatedNpc);
            const updatePacket = packetManager.npcUpdated(resolvedNpc);
            const playersInMap = filterPlayersByMap(resolvedNpc.map);
            for (const p of playersInMap) {
              if (p.wt && p.wt.readyState === 1) {
                sendPacket(p.wt, updatePacket);
              }
            }
          }

          // It may have become an innkeeper or a vendor, or stopped being one.
          void resendMapMarkers();
          sendPacket(wt, packetManager.notify({ message: "NPC saved successfully." }));
          log.info(`NPC ${npcData.id} saved by ${currentPlayer.username}`);
        } catch (error: any) {
          log.error(`Error saving NPC: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: "Error saving NPC." }));
        }
        break;
      }

      case "MOVE_NPC": {
        if (!currentPlayer) return;

        if (
          !currentPlayer.permissions.some(
            (p: string) => p === "server.admin" || p === "server.*"
          )
        ) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to move NPCs." }));
          return;
        }

        try {
          const { id, position } = data as unknown as { id: number; position: { x: number; y: number } };
          if (!id || !position) {
            sendPacket(wt, packetManager.notify({ message: "Invalid NPC move data." }));
            return;
          }

          const allNpcs = await assetCache.get("npcs") as Npc[];
          const existingNpc = (allNpcs || []).find((n: Npc) => n.id === id);
          if (!existingNpc) {
            sendPacket(wt, packetManager.notify({ message: "NPC not found." }));
            return;
          }

          const updatedNpcData: Npc = {
            ...existingNpc,
            position: {
              x: position.x,
              y: position.y,
              direction: existingNpc.position.direction || "down",
            },
          };

          await npcSystem.update(updatedNpcData);
          const updatedNpcs = await npcSystem.list();
          await assetCache.set("npcs", updatedNpcs);

          const updatedNpc = updatedNpcs.find((n: Npc) => n.id === id);
          if (updatedNpc) {
            const resolvedNpc = await resolveNpcForClient(updatedNpc);
            const updatePacket = packetManager.npcUpdated(resolvedNpc);
            const playersInMap = filterPlayersByMap(resolvedNpc.map);
            for (const p of playersInMap) {
              if (p.wt && p.wt.readyState === 1) {
                sendPacket(p.wt, updatePacket);
              }
            }
          }

          log.info(`NPC ${id} moved by ${currentPlayer.username}`);
        } catch (error: any) {
          log.error(`Error moving NPC: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: "Error moving NPC." }));
        }
        break;
      }

      case "DELETE_NPC": {
        if (!currentPlayer) return;

        if (
          !currentPlayer.permissions.some(
            (p: string) => p === "server.admin" || p === "server.*"
          )
        ) {
          sendPacket(wt, packetManager.notify({ message: "You do not have permission to delete NPCs." }));
          return;
        }

        try {
          const { id } = data as unknown as { id: number };
          if (!id) {
            sendPacket(wt, packetManager.notify({ message: "Invalid NPC ID." }));
            return;
          }

          const allNpcs = await assetCache.get("npcs") as Npc[];
          const existingNpc = (allNpcs || []).find((n: Npc) => n.id === id);
          if (!existingNpc) {
            sendPacket(wt, packetManager.notify({ message: "NPC not found." }));
            return;
          }

          const mapName = existingNpc.map;
          await npcSystem.remove({ id } as Npc);
          const updatedNpcs = await npcSystem.list();
          await assetCache.set("npcs", updatedNpcs);
          // Nobody's home is at an innkeeper that is gone.
          if (existingNpc.innkeeper) await homes.innGone(id).catch((error) => log.error(`The homes at NPC ${id} could not be cleared: ${error}`));
          // Its inn or its shop is no longer marked on anyone's map.
          if (existingNpc.innkeeper || vendors.isVendor(existingNpc)) void resendMapMarkers();

          const removePacket = packetManager.npcRemoved(id);
          const playersInMap = filterPlayersByMap(mapName);
          for (const p of playersInMap) {
            if (p.wt && p.wt.readyState === 1) {
              sendPacket(p.wt, removePacket);
            }
          }

          sendPacket(wt, packetManager.notify({ message: "NPC deleted successfully." }));
          log.info(`NPC ${id} deleted by ${currentPlayer.username}`);
        } catch (error: any) {
          log.error(`Error deleting NPC: ${error.message}`);
          sendPacket(wt, packetManager.notify({ message: "Error deleting NPC." }));
        }
        break;
      }
  }
}
