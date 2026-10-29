import achievements from "../../systems/achievements";
import assetCache from "../../services/assetCache";
import bags from "../../systems/bags";
import { readNpcList } from "../../systems/npcStreaming";
import consumables, { CONSUMABLE_COOLDOWN_MS, isKept } from "../../systems/consumables";
import equipment from "../../systems/equipment.ts";
import homes, { cannotSetHome } from "../../systems/homes";
import inventory from "../../systems/inventory";
import log from "../../modules/logger";
import loot from "../../systems/loot";
import lootChest from "../../systems/lootChest";
import player from "../../systems/player.ts";
import playerCache from "../../services/playermanager.ts";
import { Events } from "../../systems/events";
import { atomically } from "../../services/batch";
import { broadcastToAOIBestEffort } from "../aoi";
import { listener } from "../../modules/event_bus";
import { packetManager } from "../packet_manager";
import { ITEM_CALL_BUSY, blockEquipmentChangeWhilePvp, castHome, computeBagSlot, getAnimationNameForDirection, getBagBoundaries, getInventorySlots, isQuestRateLimited, isTrading, openChestOnOwner, openCorpseHere, patchInventoryBagSlots, pickupLootHere, sendBelongingsOf, sendPacket, sendSpriteSheetAnimation, sendStatsToPartyMembers, subscriptionLocked, takeChestItems, takeCorpseLootHere } from "../receiver";
import type { PacketContext } from "./context";

// Packet handlers moved from receiver.ts's packetReceiver switch (phase 6, Task 1). The case bodies are unchanged.

export const handles: ReadonlySet<string> = new Set(["SAVE_HOTBAR", "SAVE_INVENTORY_CONFIG", "CREATURE_LOOT", "CREATURE_LOOT_TAKE", "USE_ITEM", "SET_HOME", "EQUIP_ITEM", "UNEQUIP_ITEM", "BAG_EQUIP", "BAG_UNEQUIP", "SAVE_INVENTORY_SLOTS", "DELETE_ITEM", "PICKUP_LOOT", "BATCH_PICKUP_LOOT", "OPEN_LOOT_CHEST", "TAKE_CHEST_ITEMS", "TAKE_ALL_CHEST_ITEMS", "ACHIEVEMENTS_LIST"]);

export async function handle(ctx: PacketContext): Promise<unknown> {
  const { currentPlayer, data, type, wt } = ctx;
  switch (type) {

      case "SAVE_HOTBAR": {
        if (!currentPlayer) return;
        await player.saveHotBarConfig(currentPlayer.username, data as any);
        break;
      }

      case "SAVE_INVENTORY_CONFIG": {
        if (!currentPlayer) return;
        await player.saveInventoryConfig(currentPlayer.username, data as any);
        break;
      }

      case "CREATURE_LOOT":
      case "CREATURE_LOOT_TAKE": {
        if (!currentPlayer) return;
        if (currentPlayer.isDead || currentPlayer.isGhost || currentPlayer.isGuest) return;
        if (subscriptionLocked(wt, currentPlayer, "loot")) return;
        const creatureId = Number((data as any)?.id);
        if (!Number.isFinite(creatureId)) return;
        const lootErrors: Record<string, string> = {
          not_found: "Corpse not found.",
          too_far: "You are too far away to loot that.",
          not_allowed: "You don't have permission to loot that corpse.",
          empty: "There is nothing to loot.",
          failed: "Could not take the loot. Try again.",
          full: "Your bags are full.",
          busy: ITEM_CALL_BUSY,
        };
        if (type === "CREATURE_LOOT") {
          // A corpse a neighbouring node owns is opened there (LOOT_OPEN).
          const opened = await openCorpseHere(currentPlayer, creatureId);
          if (typeof opened === "string") {
            sendPacket(wt, packetManager.notify({ message: lootErrors[opened] }));
            break;
          }
          sendPacket(wt, packetManager.creatureLootContents({ id: creatureId, items: opened.items, copper: opened.copper }));
          break;
        }
        const rawIndices = (data as any)?.indices;
        const indices = Array.isArray(rawIndices) ? rawIndices.map(Number).filter(Number.isFinite) : null;
        const result = await takeCorpseLootHere(currentPlayer, creatureId, indices);
        if (typeof result === "string") {
          sendPacket(wt, packetManager.notify({ message: lootErrors[result] }));
          break;
        }
        if (result.taken.length > 0) {
          currentPlayer.inventory = await inventory.get(currentPlayer.username);
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        }
        if (result.full) sendPacket(wt, packetManager.notify({ message: lootErrors.full }));
        // The loot window shows what is left, or closes when nothing is.
        sendPacket(wt, packetManager.creatureLootContents({ id: creatureId, items: result.remaining, copper: 0 }));
        break;
      }

      case "USE_ITEM": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "use_item")) return;
        // The stats the server holds are the ones a use restores.
        const user = playerCache.get(currentPlayer.id) || currentPlayer;
        const used = await consumables.use(user, (data as any)?.item, { trading: isTrading(currentPlayer.username) });
        if (!used.ok) {
          sendPacket(wt, packetManager.notify({ message: used.message }));
          break;
        }
        if (used.kind === "home") {
          await castHome(currentPlayer, used.item);
          break;
        }
        currentPlayer.stats = user.stats;
        playerCache.set(user.id, user);
        await sendBelongingsOf(user);
        // Shown to everyone near as a heal is, when it healed.
        const healed = used.health > 0 ? { isCrit: false, damage: -used.health } : {};
        broadcastToAOIBestEffort(user, packetManager.updateStats({ id: user.id, target: user.id, stats: user.stats, ...healed }));
        sendStatsToPartyMembers(user.username, user.id, user.stats);
        sendPacket(wt, packetManager.itemCooldown({ kind: "consumable", remaining: used.cooldown, total: CONSUMABLE_COOLDOWN_MS }));
        if (used.health > 0) listener.emit(Events.PLAYER_HEALED, { caster: user, target: user, amount: used.health, source: used.item } as any);
        listener.emit(Events.ITEM_USED, { player: user, item: used.item, health: used.health, stamina: used.stamina, home: null });
        break;
      }

      case "SET_HOME": {
        if (!currentPlayer) return;
        if (isQuestRateLimited(`npc:${wt.data.id}`)) return;
        const npcId = Number((data as any)?.npcId);
        const innkeeper = (await readNpcList()).find((held) => Number(held.id) === npcId);
        const reason = cannotSetHome(currentPlayer, innkeeper);
        if (reason) {
          sendPacket(wt, packetManager.notify({ message: reason }));
          break;
        }
        try {
          await homes.set(currentPlayer, innkeeper!);
        } catch (error) {
          log.error(`The home of ${currentPlayer.username} could not be set: ${error}`);
          sendPacket(wt, packetManager.notify({ message: "Your home could not be set. Nothing changed." }));
          break;
        }
        sendPacket(wt, packetManager.notify({ message: "You have updated your home location" }));
        listener.emit(Events.HOME_SET, { player: currentPlayer, npcId, inn: innkeeper!.name || null });
        break;
      }

      case "EQUIP_ITEM": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "equip")) break;
        // As for a bag (see BAG_EQUIP): an item on offer in a trade is not put on while the trade is open.
        if (isTrading(currentPlayer.username)) {
          sendPacket(wt, packetManager.notify({ message: "You can't change equipment while trading." }));
          break;
        }
        const item = (data as any).item;
        const slotIndex = (data as any).slotIndex;
        if (!item) return;
        const equipmentItems = currentPlayer.inventory.filter((invItem: any) => invItem.type === "equipment");
        const foundEquipment = equipmentItems.find((invItem: any) => invItem.name.toLowerCase() === item.toLowerCase());
        const slot = foundEquipment?.equipment_slot;
        if (await blockEquipmentChangeWhilePvp(wt, currentPlayer, slot)) return;

        if (foundEquipment?.level_requirement) {
          const playerLevel = currentPlayer.stats.level || 1;
          if (playerLevel < foundEquipment.level_requirement) return;
        }

        const previouslyEquippedItem = currentPlayer.equipment[slot];

        const result = await equipment.equipItem(currentPlayer.username, slot, item);
        if (result) {

          const canonicalName = foundEquipment?.name || item;

          if (previouslyEquippedItem) {
            const previousItem = currentPlayer.inventory.find((invItem: any) => invItem.name.toLowerCase() === previouslyEquippedItem.toLowerCase());
            if (previousItem) {
              previousItem.equipped = false;
            }
          }

          currentPlayer.equipment[slot] = canonicalName;

          const inventoryItem = currentPlayer.inventory.find((invItem: any) => invItem.name.toLowerCase() === item.toLowerCase());
          if (inventoryItem) {
            inventoryItem.equipped = true;
          }

          if (slotIndex !== undefined) {

            const freshConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = freshConfig;

            const config = currentPlayer.config && currentPlayer.config.length > 0 ? currentPlayer.config[0] : null;

            const inventoryConfig = config?.inventory_config || {};

            if (previouslyEquippedItem) {
              inventoryConfig[slotIndex.toString()] = previouslyEquippedItem;
            }

            for (const key in inventoryConfig) {
              if (inventoryConfig[key] && inventoryConfig[key].toLowerCase() === item.toLowerCase()) {
                delete inventoryConfig[key];
                break;
              }
            }

            for (const key in inventoryConfig) {
              if (inventoryConfig[key] === null) {
                delete inventoryConfig[key];
              }
            }

            await player.saveInventoryConfig(currentPlayer.username, inventoryConfig);

            const updatedConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = updatedConfig;
            playerCache.set(currentPlayer.id, currentPlayer);
          }

          playerCache.set(currentPlayer.id, currentPlayer);

          const stats = await player.synchronizeStats(currentPlayer.username);
          if (stats) {
            const currentHealth = currentPlayer.stats.health;
            const currentStamina = currentPlayer.stats.stamina;

            currentPlayer.stats = stats;

            currentPlayer.stats.health = Math.min(currentHealth, stats.total_max_health);
            currentPlayer.stats.stamina = Math.min(currentStamina, stats.total_max_stamina);

            playerCache.set(currentPlayer.id, currentPlayer);

            sendPacket(
              wt,
              packetManager.updateStats({
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );

            await sendStatsToPartyMembers(
              currentPlayer.username,
              currentPlayer.id,
              currentPlayer.stats
            );

            broadcastToAOIBestEffort(
              currentPlayer,
              packetManager.updateStats({
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );

            if (slotIndex !== undefined) {
              sendPacket(
                wt,
                packetManager.clientConfig(currentPlayer.config || [])
              );
            }

            sendPacket(
              wt,
              packetManager.equipment(currentPlayer.equipment)
            );
            sendPacket(
              wt,
              packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer))
            );

            currentPlayer.equipmentRevision = (currentPlayer.equipmentRevision || 0) + 1;

            const currentAnimationName = getAnimationNameForDirection(
              currentPlayer.location.position?.direction || "down",
              !!currentPlayer.moving,
              !!currentPlayer.mounted,
              currentPlayer.mount_type || undefined,
              !!currentPlayer.casting
            );
            await sendSpriteSheetAnimation(wt, currentAnimationName, currentPlayer.id);
          }
        }
        listener.emit(Events.ITEM_EQUIP, { player: currentPlayer, item: foundEquipment, slot });
        break;
      }

      case "UNEQUIP_ITEM": {
        if (!currentPlayer) return;
        const slot = (data as any).slot;
        const targetSlotIndex = (data as any).targetSlotIndex;
        if (!slot) return;

        const equippedItemName = currentPlayer.equipment[slot];
        if (!equippedItemName) return;
        if (await blockEquipmentChangeWhilePvp(wt, currentPlayer, slot)) return;

        const result = await equipment.unEquipItem(currentPlayer.username, slot, equippedItemName);
        if (result) {

          const inventoryItem = currentPlayer.inventory.find((invItem: any) => invItem.name.toLowerCase() === equippedItemName.toLowerCase());
          if (inventoryItem) {
            const maxSlots = await getInventorySlots(currentPlayer);
            const bagBoundaries = await getBagBoundaries(currentPlayer.username);
            const occupied = new Set<number>();
            for (const inv of currentPlayer.inventory) {
              if (inv !== inventoryItem && !inv.equipped && inv.slot != null) occupied.add(inv.slot);
            }

            let chosen = inventoryItem.slot;
            if (chosen == null || chosen < 0 || chosen >= maxSlots || occupied.has(chosen)) {
              chosen = targetSlotIndex;
            }
            if (chosen == null || chosen < 0 || chosen >= maxSlots || occupied.has(chosen)) {
              chosen = 0;
              while (occupied.has(chosen) && chosen < maxSlots) chosen++;
            }
            if (chosen < maxSlots) {
              inventoryItem.slot = chosen;
              inventoryItem.bag_slot = computeBagSlot(chosen, bagBoundaries);
              await inventory.setUnequippedSlot(currentPlayer.username, equippedItemName, chosen, inventoryItem.bag_slot);
            }
            inventoryItem.equipped = false;
          }

          currentPlayer.equipment[slot] = null;

          if (targetSlotIndex !== undefined) {

            const freshConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = freshConfig;

            const config = currentPlayer.config && currentPlayer.config.length > 0 ? currentPlayer.config[0] : null;

            const inventoryConfig = config?.inventory_config || {};

            inventoryConfig[targetSlotIndex.toString()] = equippedItemName;

            for (const key in inventoryConfig) {
              if (inventoryConfig[key] === null) {
                delete inventoryConfig[key];
              }
            }

            await player.saveInventoryConfig(currentPlayer.username, inventoryConfig);

            const updatedConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = updatedConfig;
          }

          playerCache.set(currentPlayer.id, currentPlayer);

          const stats = await player.synchronizeStats(currentPlayer.username);
          if (stats) {
            const currentHealth = currentPlayer.stats.health;
            const currentStamina = currentPlayer.stats.stamina;

            currentPlayer.stats = stats;

            currentPlayer.stats.health = Math.min(currentHealth, stats.total_max_health);
            currentPlayer.stats.stamina = Math.min(currentStamina, stats.total_max_stamina);

            playerCache.set(currentPlayer.id, currentPlayer);

            sendPacket(
              wt,
              packetManager.updateStats({
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );

            await sendStatsToPartyMembers(
              currentPlayer.username,
              currentPlayer.id,
              currentPlayer.stats
            );

            broadcastToAOIBestEffort(
              currentPlayer,
              packetManager.updateStats({
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );

            sendPacket(
              wt,
              packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer))
            );
            sendPacket(
              wt,
              packetManager.equipment(currentPlayer.equipment)
            );

            currentPlayer.equipmentRevision = (currentPlayer.equipmentRevision || 0) + 1;

            const currentAnimationName = getAnimationNameForDirection(
              currentPlayer.location.position?.direction || "down",
              !!currentPlayer.moving,
              !!currentPlayer.mounted,
              currentPlayer.mount_type || undefined,
              !!currentPlayer.casting
            );
            await sendSpriteSheetAnimation(wt, currentAnimationName, currentPlayer.id);
          }
        }
        listener.emit(Events.ITEM_UNEQUIP, { player: currentPlayer, slot });
        break;
      }

      case "BAG_EQUIP": {
        if (!currentPlayer) return;
        if (subscriptionLocked(wt, currentPlayer, "equip")) break;
        // What is spare of an item can be on offer in a trade: nothing more of it is put to use until the trade is over.
        if (isTrading(currentPlayer.username)) {
          sendPacket(wt, packetManager.notify({ message: "You can't change equipment while trading." }));
          break;
        }
        const item = (data as any).item;
        const bagSlot = (data as any).slot;
        if (!item || !bagSlot) return;
        if (!bags.SLOTS.includes(bagSlot)) return;

        // One bag change at a time for a player, and none while a batch of theirs (mail, a sale) counts
        // what is in use: two equips read "none equipped" side by side, and one bag filled two slots.
        await atomically([currentPlayer.username], async () => {
          const inventoryItem = currentPlayer.inventory.find((invItem: any) =>
            invItem.name.toLowerCase() === String(item).toLowerCase() &&
            invItem.bag_slots != null &&
            invItem.bag_slots > 0
          );
          if (!inventoryItem) return;

          const existingBags = await bags.ensure(currentPlayer.username);
          if (existingBags[bagSlot] && existingBags[bagSlot].toLowerCase() === String(item).toLowerCase()) return;

          // Counted against what the player holds now, not the copy made before the lock was taken.
          const held = ((await inventory.find(currentPlayer.username, { name: inventoryItem.name, quantity: 0 } as any)) || [])
            .reduce((sum: number, row: any) => sum + (Number(row.quantity) || 0), 0);
          const alreadyEquippedCount = bags.SLOTS.filter((s: string) =>
            existingBags[s] && existingBags[s].toLowerCase() === String(item).toLowerCase()
          ).length;
          if (alreadyEquippedCount >= held) return;

          const canonicalName = inventoryItem.name;

          await bags.setBag(currentPlayer.username, bagSlot, canonicalName);
          await inventory.setEquipped(currentPlayer.username, canonicalName, true);
          if (alreadyEquippedCount + 1 >= held) {
            await inventory.clearSlot(currentPlayer.username, canonicalName);
          }
          const freshInventory = await inventory.get(currentPlayer.username);
          currentPlayer.inventory = await patchInventoryBagSlots(freshInventory, currentPlayer.username);
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(wt, packetManager.bags(await bags.ensure(currentPlayer.username)));
          sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        });
        break;
      }

      case "BAG_UNEQUIP": {
        if (!currentPlayer) return;
        const bagSlot = (data as any).slot;
        if (!bagSlot) return;
        if (!bags.SLOTS.includes(bagSlot)) return;

        // As BAG_EQUIP: one bag change at a time for a player (this one takes the bag out and puts it back to measure).
        await atomically([currentPlayer.username], async () => {
          const bagRow = await bags.ensure(currentPlayer.username);
          const itemName = bagRow[bagSlot];
          if (!itemName) return;

          // Temporarily remove to calculate new max
          await bags.setBag(currentPlayer.username, bagSlot, null);
          const newMax = await getInventorySlots(currentPlayer);
          await bags.setBag(currentPlayer.username, bagSlot, itemName); // restore

          const freshInv = await inventory.get(currentPlayer.username);
          const itemsBeyond = (freshInv || []).filter((i: any) => !i.equipped && i.slot != null && i.slot >= newMax);
          if (itemsBeyond.length > 0) {
            sendPacket(wt, packetManager.notify({ message: `Cannot unequip bag - ${itemsBeyond.length} item(s) occupy the extra slots. Move them to free up space first.` }));
            return;
          }

          await bags.setBag(currentPlayer.username, bagSlot, null);
          const updatedBags = await bags.ensure(currentPlayer.username);
          const stillEquipped = bags.SLOTS.some((s: string) =>
            updatedBags[s] && updatedBags[s].toLowerCase() === itemName.toLowerCase()
          );
          if (itemName && !stillEquipped) {
            const invItem = currentPlayer.inventory.find((i: any) => i.name.toLowerCase() === itemName.toLowerCase());
            await inventory.setUnequippedSlot(currentPlayer.username, itemName, invItem?.slot ?? null, invItem?.bag_slot ?? null);
          }
          currentPlayer.inventory = await patchInventoryBagSlots(await inventory.get(currentPlayer.username), currentPlayer.username);
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(wt, packetManager.bags(await bags.ensure(currentPlayer.username)));
          sendPacket(wt, packetManager.inventory(currentPlayer.inventory, newMax));
        });
        break;
      }

      case "SAVE_INVENTORY_SLOTS": {
        if (!currentPlayer) return;
        const slots = (data as any)?.slots;
        if (!Array.isArray(slots)) return;

        const maxSlots = await getInventorySlots(currentPlayer);
        const boundaries = await getBagBoundaries(currentPlayer.username);
        const seen = new Set<number>();
        const validItems = new Map<string, string>();
        if (Array.isArray(currentPlayer.inventory)) {
          for (const inv of currentPlayer.inventory) {
            validItems.set(inv.name.toLowerCase(), inv.name);
          }
        }
        for (const s of slots) {
          if (typeof s.slot !== "number" || s.slot < 0 || s.slot >= maxSlots) return;
          if (seen.has(s.slot)) return;
          seen.add(s.slot);
          if (!s.item || typeof s.item !== "string") return;
          const canonical = validItems.get(s.item.toLowerCase());
          if (!canonical) return;
        }

        const patched = slots.map((s: any) => {
          const canonical = validItems.get(s.item.toLowerCase()) || s.item;
          return {
            ...s,
            item: canonical,
            bag_slot: computeBagSlot(s.slot, boundaries),
          };
        });

        await inventory.saveSlots(currentPlayer.username, patched);

        const slotMap = new Map(patched.map((s: any) => [s.item.toLowerCase(), s]));
        if (Array.isArray(currentPlayer.inventory)) {
          for (const inv of currentPlayer.inventory) {
            const s = slotMap.get(inv.name.toLowerCase());
            if (s) {
              inv.slot = s.slot;
              inv.bag_slot = s.bag_slot;
            }
          }
        }
        playerCache.set(currentPlayer.id, currentPlayer);
        break;
      }

      case "DELETE_ITEM": {
        if (!currentPlayer) return;
        const itemName = (data as any)?.item;
        const from = (data as any)?.from;
        const slot = (data as any)?.slot;
        if (!itemName || !from) return;

        if (from === "inventory") {
          const invItem = currentPlayer.inventory.find((i: any) =>
            i.name.toLowerCase() === String(itemName).toLowerCase()
          );
          if (!invItem) return;
          // The home item stays with its player.
          const definition = (((await assetCache.get("items")) || []) as Item[]).find((held) => held.name.toLowerCase() === String(invItem.name).toLowerCase());
          if (isKept(definition)) {
            sendPacket(wt, packetManager.notify({ message: `${invItem.name} cannot be destroyed.` }));
            break;
          }

          await inventory.delete(currentPlayer.username, { name: invItem.name, quantity: 0 });
          currentPlayer.inventory = currentPlayer.inventory.filter((i: any) => i !== invItem);
          playerCache.set(currentPlayer.id, currentPlayer);

          sendPacket(wt, packetManager.removeInventoryItem({ name: invItem.name }));
          sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        } else if (from === "equipment" && slot) {
          const equippedName = currentPlayer.equipment[slot];
          if (!equippedName || equippedName.toLowerCase() !== String(itemName).toLowerCase()) return;
          if (await blockEquipmentChangeWhilePvp(wt, currentPlayer, slot)) return;

          await equipment.unEquipItem(currentPlayer.username, slot, equippedName);
          await inventory.delete(currentPlayer.username, { name: equippedName, quantity: 0 });
          currentPlayer.equipment[slot] = null;

          currentPlayer.inventory = currentPlayer.inventory.filter((i: any) =>
            i.name.toLowerCase() !== equippedName.toLowerCase()
          );
          playerCache.set(currentPlayer.id, currentPlayer);

          sendPacket(wt, packetManager.removeInventoryItem({ name: equippedName }));
          sendPacket(wt, packetManager.equipment(currentPlayer.equipment));
          sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));

          const stats = await player.synchronizeStats(currentPlayer.username);
          if (stats) {
            currentPlayer.stats = stats;
            playerCache.set(currentPlayer.id, currentPlayer);
            sendPacket(wt, packetManager.updateStats({ target: currentPlayer.id, stats: currentPlayer.stats }));
          }
        }
        break;
      }

      case "PICKUP_LOOT": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot pick up loot.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        if (subscriptionLocked(wt, currentPlayer, "loot")) return;
        const lootId = (data as any)?.id;
        if (!lootId) return;

        // Loot a neighbouring node owns is picked up there (PICKUP_REQUEST); the item is added here.
        const picked = await pickupLootHere(currentPlayer, lootId);
        if (!picked.added) {
          if (picked.message) sendPacket(wt, packetManager.notify({ message: picked.message }));
          break;
        }

        // Re-read the inventory instead of patching the cached list by hand: an
        // item the player did not hold before needs its full details (quality,
        // icon, type), and the client cannot draw an entry without them.
        currentPlayer.inventory = await patchInventoryBagSlots(await inventory.get(currentPlayer.username), currentPlayer.username);
        playerCache.set(currentPlayer.id, currentPlayer);
        sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        break;
      }

      case "BATCH_PICKUP_LOOT": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot pick up loot.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        if (subscriptionLocked(wt, currentPlayer, "loot")) return;

        const items = loot.pickupAllNearby(currentPlayer);
        if (items.length === 0) break;

        for (const item of items) {
          await inventory.add(currentPlayer.username, { name: item.item, quantity: item.quantity });
        }

        // As in PICKUP_LOOT: re-read, so new items arrive with their full details.
        currentPlayer.inventory = await patchInventoryBagSlots(await inventory.get(currentPlayer.username), currentPlayer.username);
        playerCache.set(currentPlayer.id, currentPlayer);
        sendPacket(wt, packetManager.inventory(currentPlayer.inventory, await getInventorySlots(currentPlayer)));
        sendPacket(wt, packetManager.notify({ message: `Picked up ${items.length} item(s).` }));
        break;
      }

      case "OPEN_LOOT_CHEST": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot open chests.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        if (subscriptionLocked(wt, currentPlayer, "loot")) return;
        const chestId = (data as any)?.chestId;
        if (!chestId) return;
        // A chest a neighbouring node owns is opened there (CHEST_OPEN), with the same checks.
        const openedRemote = await openChestOnOwner(currentPlayer, String(chestId));
        if (openedRemote) {
          sendPacket(wt, openedRemote);
          break;
        }
        const chest = lootChest.getChest(chestId);
        if (!chest) { sendPacket(wt, packetManager.notify({ message: "Chest not found." })); break; }
        if (chest.map !== currentPlayer.location.map) { sendPacket(wt, packetManager.notify({ message: "Chest is on a different map." })); break; }
        const playerPos = currentPlayer.location.position;
        const playerX = typeof playerPos === 'string' ? Number(playerPos.split(',')[0]) : (playerPos as any).x;
        const playerY = typeof playerPos === 'string' ? Number(playerPos.split(',')[1]) : (playerPos as any).y;
        if (!lootChest.isWithinRange(chestId, playerX, playerY)) { sendPacket(wt, packetManager.notify({ message: "You are too far from the chest." })); break; }
        const result = await lootChest.open(chestId, String(currentPlayer.id));
        if (!result) { sendPacket(wt, packetManager.notify({ message: "Could not open chest." })); break; }
        if (result.items.length === 0) { sendPacket(wt, packetManager.notify({ message: "This chest is empty for you." })); break; }
        sendPacket(wt, packetManager.lootChestContents({ chestId, items: result.items }));
        break;
      }

      case "TAKE_CHEST_ITEMS": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot take chest items.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        if (subscriptionLocked(wt, currentPlayer, "loot")) return;
        const chestId = (data as any)?.chestId;
        const indices = (data as any)?.indices;
        if (!chestId || !Array.isArray(indices) || indices.length === 0) return;
        const result = await takeChestItems(currentPlayer, String(chestId), indices);
        if (!result) { sendPacket(wt, packetManager.notify({ message: "Could not take items." })); break; }
        currentPlayer.inventory = await inventory.get(currentPlayer.username);
        playerCache.set(currentPlayer.id, currentPlayer);
        const invSlots = await getInventorySlots(currentPlayer);
        sendPacket(wt, packetManager.inventory(currentPlayer.inventory, invSlots));
        if (result.allTaken) {
          sendPacket(wt, packetManager.lootChestDespawn(chestId));
          sendPacket(wt, packetManager.notify({ message: `Took ${result.taken.length} item(s). Chest emptied.` }));
        } else {
          sendPacket(wt, packetManager.notify({ message: `Took ${result.taken.length} item(s). ${result.remaining.length} item(s) remain.` }));
        }
        break;
      }

      case "TAKE_ALL_CHEST_ITEMS": {
        if (!currentPlayer) return;
        // Corpses and ghosts cannot take chest items.
        if (currentPlayer.isDead || currentPlayer.isGhost) return;
        if (subscriptionLocked(wt, currentPlayer, "loot")) return;
        const chestId = (data as any)?.chestId;
        if (!chestId) return;
        const result = await takeChestItems(currentPlayer, String(chestId), null);
        if (!result) { sendPacket(wt, packetManager.notify({ message: "Could not take items." })); break; }
        currentPlayer.inventory = await inventory.get(currentPlayer.username);
        playerCache.set(currentPlayer.id, currentPlayer);
        const invSlots = await getInventorySlots(currentPlayer);
        sendPacket(wt, packetManager.inventory(currentPlayer.inventory, invSlots));
        sendPacket(wt, packetManager.lootChestDespawn(chestId));
        sendPacket(wt, packetManager.notify({ message: `Took all ${result.taken.length} item(s).` }));
        break;
      }

      case "ACHIEVEMENTS_LIST": {
        if (!currentPlayer) return;
        if (isQuestRateLimited(`achievements:${wt.data.id}`)) return;
        // read from the caches only (systems/achievements/store.ts)
        await achievements.sendList(currentPlayer);
        break;
      }
  }
}
