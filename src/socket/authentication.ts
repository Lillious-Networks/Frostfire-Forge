import { parentPort, workerData } from "worker_threads";
import player from "../systems/player.ts";
import query from "../controllers/sqldatabase.ts";
import log from "../modules/logger.ts";
import parties from "../systems/parties.ts";
import collectables from "../systems/collectables.ts";

// Assets are passed once via workerData when worker is created
// Keep as plain objects - they get JSON.stringified again when sent back to main thread
const items = workerData?.assets?.items ? JSON.parse(workerData.assets.items) : [];
const mounts = workerData?.assets?.mounts ? JSON.parse(workerData.assets.mounts) : [];

// Debug what was loaded into worker
log.debug(`[WORKER INIT] Loaded ${items.length} items, ${mounts.length} mounts`);
if (mounts.length > 0) {
    log.debug(`[WORKER INIT] First mount: name=${mounts[0]?.name}, has icon=${!!mounts[0]?.icon}`);
}

const authentication = {
    async process(token: string, id: string): Promise<Authentication> {
        try {
            // Set the session ID for the player
            const session = await player.setSessionId(token, id);

            // Check if session is valid
            // If not, return an error
            if (!session) {
                return {
                    authenticated: false,
                    completed: true,
                    error: "Invalid session"
                } as Authentication;
            }

            const getUsername = (await player.getUsernameBySession(id)) as any[];
            const username = getUsername[0]?.username as string;
            const playerData = await player.GetPlayerLoginData(username) as PlayerData;
            const inventoryData = await query("SELECT item, quantity FROM inventory WHERE username = ?", [username]) as any[];
            const collectablesData = await collectables.list(username) as unknown as Collectable[];
            // Fetch all types of collectables that are mounts and validate against mounts cache to see if they exist
            collectablesData.filter((c) => c.type === "mount" && !mounts.some((m: Mount) => m.name === c.item)).forEach((invalidMount) => {
                collectablesData.splice(collectablesData.indexOf(invalidMount), 1);
            });

            // Add icon property to each collectable from mounts cache
            collectablesData.forEach((c) => {
                if (c.type === "mount") {
                    log.debug(`[WORKER] Looking for mount: ${c.item}, available mounts: ${mounts.map((m: any) => m.name).join(', ')}`);
                    const mountDetails = (mounts as any).find((m: Mount) => m.name === c.item);
                    log.debug(`[WORKER] Found mount details: ${!!mountDetails}, has icon: ${!!mountDetails?.icon}`);
                    c.icon = mountDetails ? mountDetails.icon : null;
                }
            });

            // Attach collectables to player data and map the item and type
            playerData.collectables = collectablesData.map((c) => ({ type: c.type, item: c.item, icon: c.icon }));

            // Fetch and process details for each item
            const playerInventoryData = await Promise.all(
                inventoryData.map(async (item: any) => {
                    // Fetch item details from cache
                    const itemDetails = (items as any).find((i: any) => i.name === item.item);

                    if (itemDetails) {
                    // Debug first item icon in worker
                    if (item.item === inventoryData[0].item && itemDetails.icon) {
                        log.debug(`[WORKER] Item ${item.item} icon type: ${typeof itemDetails.icon}, has .data: ${!!itemDetails.icon?.data}, isBuffer: ${Buffer.isBuffer(itemDetails.icon)}`);
                    }
                    return {
                        ...item, // Inventory item details
                        ...itemDetails, // Item details from cache
                    };
                    } else {
                    // If item details are not found, return the item with blank details
                    log.error(`Item details not found for: ${item.item}`);
                    return {
                        ...item,
                        name: item.item,
                        quality: "unknown",
                        description: "unknown",
                        icon: null,
                    };
                    }
                })
            );

            const partyMembers = playerData.party_id ? await parties.getPartyMembers(Number(playerData.party_id)) : null;

            playerData.inventory = playerInventoryData;
            playerData.party = partyMembers || [];

            if (!playerData) {
                return {
                    authenticated: true,
                    completed: true,
                    error: "Player data not found"
                } as Authentication;
            }

            return {
                authenticated: true,
                completed: true,
                data: playerData
            }

        } catch (err) {
            return {
                authenticated: false,
                completed: true,
                error: err instanceof Error ? err.message : String(err)
            } as Authentication;
        }
    }
}

// Listen for authentication requests
parentPort?.on("message", async (data: { token: string, id: string }) => {
    const result = await authentication.process(data.token, data.id);
    parentPort?.postMessage({ ...result, token: data.token, id: data.id });
});