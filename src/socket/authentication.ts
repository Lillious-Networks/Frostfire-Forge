import { parentPort, workerData } from "worker_threads";
import player from "../systems/player.ts";
import query from "../controllers/sqldatabase.ts";
import log from "../modules/logger.ts";
import parties from "../systems/parties.ts";
import guilds from "../systems/guild.ts";
import collectables from "../systems/collectables.ts";

const items = workerData?.assets?.items ? JSON.parse(workerData.assets.items) : [];
const spells = workerData?.assets?.spells ? JSON.parse(workerData.assets.spells) : [];
const mounts = workerData?.assets?.mounts ? JSON.parse(workerData.assets.mounts) : [];

const authentication = {
    async process(token: string, id: string): Promise<Authentication> {
        try {

            const session = await player.setSessionId(token, id);

            if (!session) {
                return {
                    authenticated: false,
                    completed: true,
                    error: "Invalid session"
                } as Authentication;
            }

            const getUsername = (await player.getUsernameBySession(id)) as any[];
            const username = getUsername[0]?.username as string;
            const playerData = await player.GetPlayerLoginData(username) as unknown as PlayerData;
            const equipmentItems = items.filter((i: Item) => i.type === "equipment" && i.equipment_slot && i.name);

            for (const slot in playerData.equipment) {

                if (slot === 'body' || slot === 'head' || slot === 'helmet' || slot === 'necklace' ||
                    slot === 'gloves' || slot === 'chestplate' || slot === 'boots' || slot === 'pants' || slot === 'weapon') {
                    continue;
                }

                const itemName = playerData.equipment[slot as keyof Equipment];
                if (itemName) {
                    const exists = equipmentItems.some((item: Item) => item.name.toLowerCase() === itemName.toLowerCase() && item.equipment_slot?.toLowerCase() === slot.toLowerCase());
                    if (!exists) {
                        playerData.equipment[slot as keyof Equipment] = null as any;
                    }
                }
            }

            const inventoryData = await query("SELECT item, quantity, equipped FROM inventory WHERE username = ?", [username]) as any[];
            const collectablesData = await collectables.list(username) as unknown as Collectable[];
            const learnedSpellsData = await query("SELECT spell FROM learned_spells WHERE username = ?", [username]) as any[];

            collectablesData.filter((c) => c.type === "mount" && !mounts.some((m: Mount) => m.name === c.item)).forEach((invalidMount) => {
                collectablesData.splice(collectablesData.indexOf(invalidMount), 1);
            });

            collectablesData.forEach((c) => {
                if (c.type === "mount") {
                    const mountDetails = (mounts as any).find((m: Mount) => m.name === c.item);
                    c.icon = mountDetails ? mountDetails.icon : null;
                }
            });

            playerData.collectables = collectablesData.map((c) => ({ type: c.type, item: c.item, icon: c.icon }));

            const playerInventoryData = await Promise.all(
                inventoryData.map(async (item: any) => {

                    const itemDetails = (items as any).find((i: any) => i.name === item.item);

                    if (itemDetails) {
                    return {
                        ...itemDetails,
                        ...item,
                    };
                    } else {

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

            const guildMembers = playerData.guild_id ? await guilds.getGuildMembers(Number(playerData.guild_id)) : null;

            playerData.inventory = playerInventoryData;
            playerData.party = partyMembers || [];
            playerData.guild = guildMembers || [];

            const spellsByName: Record<string, SpellData> = Object.create(null);
            for (const sp of spells) {
                spellsByName[sp.name] = sp;
            }

            const learnedSpells: Record<string, {
                icon: string | null,
                sprite: string | null,
                description: string | null,
                mana: number,
                cooldown: number,
                cast_time: number,
                damage: number,
                type: string | null,
                effects: SpellEffect[],
                particles: string | null,
            }> = Object.create(null);

            for (const row of learnedSpellsData) {
                const name = row.spell;
                const spellDetails = spellsByName[name];

                if (!spellDetails) continue;

                learnedSpells[name] = {
                    icon: spellDetails.icon ?? null,
                    sprite: spellDetails.sprite ?? null,
                    description: spellDetails.description ?? null,
                    mana: spellDetails.mana ?? 0,
                    cooldown: spellDetails.cooldown ?? 0,
                    cast_time: spellDetails.cast_time ?? 0,
                    damage: spellDetails.damage ?? 0,
                    type: spellDetails.type ?? null,
                    effects: Array.isArray(spellDetails.effects) ? spellDetails.effects : [],
                    particles: spellDetails.particles ?? null,
                };
            }

            playerData.learnedSpells = learnedSpells;

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
                data: playerData,
                error: null
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

parentPort?.on("message", async (data: { token: string, id: string }) => {
    const result = await authentication.process(data.token, data.id);
    parentPort?.postMessage({ ...result, token: data.token, id: data.id });
});