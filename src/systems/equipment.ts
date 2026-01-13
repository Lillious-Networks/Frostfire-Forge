import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import inventory from "./inventory";
import log from "../modules/logger";

const equipment = {
    async list(username: string) {
        if (!username) return null;
        const response = await query("SELECT * FROM equipment WHERE username = ?", [username]) as any[];
        if (response.length === 0) return null;
        return response[0];
    },
    async equipItem(username: string, slot: string, item: string | null) {
        if (!username || !slot) return false;
        if (slot !== "helmet" && slot !== "necklace" && slot !== "shoulder" && slot !== "back" && slot !== "chest" && slot !== "wrists" && slot !== "hands" && slot !== "waist" && slot !== "legs" && slot !== "feet" && slot !== "ring_1" && slot !== "ring_2" && slot !== "trinket_1" && slot !== "trinket_2" && slot !== "weapon" && slot !== "off_hand_weapon") {
            log.error(`Invalid equipment slot: ${slot}`);
            return false;
        }

        // Check if we are replacing an item with another item. If we are, un-equip the current item first.
        try {
            const currentEquipment = await equipment.list(username);
            if (currentEquipment && currentEquipment[slot as keyof Equipment] && item && currentEquipment[slot as keyof Equipment] !== item) {
                await equipment.unEquipItem(username, slot, currentEquipment[slot as keyof Equipment]);
            }
        } catch (error) {
            log.error(`Error checking current equipment for user ${username}: ${error}`);
            return false;
        }

        try {
            const equipmentItems = await assetCache.get("items") as Item[];
            if (item) {
                const itemObj = equipmentItems.find((i) => i.name.toLowerCase() === item.toLowerCase() && i.equipment_slot?.toLowerCase() === slot.toLowerCase());
                if (!itemObj) {
                    log.error(`Item ${item} cannot be equipped in slot ${slot} for user ${username}`);
                    return false;
                }

                await query(`UPDATE equipment SET ${slot} = ? WHERE username = ?`, [itemObj.name, username]);
                await inventory.setEquipped(username, itemObj.name, true);
                return true;
            }
        } catch (error) {
            log.error(`Error equipping item ${item} for user ${username}: ${error}`);
            return false;
        }
    },
    unEquipItem: async (username: string, slot: string, item: string) => {
        if (!username || !slot) return false;
        if (slot !== "helmet" && slot !== "necklace" && slot !== "shoulder" && slot !== "back" && slot !== "chest" && slot !== "wrists" && slot !== "hands" && slot !== "waist" && slot !== "legs" && slot !== "feet" && slot !== "ring_1" && slot !== "ring_2" && slot !== "trinket_1" && slot !== "trinket_2" && slot !== "weapon" && slot !== "off_hand_weapon") {
            log.error(`Invalid equipment slot: ${slot}`);
            return false;
        }
        try {
            await query(`UPDATE equipment SET ${slot} = NULL WHERE username = ?`, [username]);
            await inventory.setEquipped(username, item, false);
            return true;
        } catch (error) {
            log.error(`Error unequipping item from slot ${slot} for user ${username}: ${error}`);
            return false;
        }
    }
};

export default equipment;