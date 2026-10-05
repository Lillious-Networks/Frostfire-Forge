import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import swears from "../utility/swears.json";
import { tableCache, dropRows } from "../services/datacache";

/** A guild as the table has it: `members` is the comma-separated list, the leader first. */
type GuildRow = { id: number; name: string; leader: string; members: string | null };

// Every guild. Reads are answered from these rows, and every change below is
// written to the database and then to them. A write the database does not
// answer has them read again instead (see `writing`).
//
// Who is in a guild is who its member list names. accounts.guild_id says the
// same after each change here, and is what a login reads.
const rows = tableCache<GuildRow>("guilds", async () => {
    const result = await query("SELECT id, name, leader, members FROM guilds", []) as any[];
    return (result || []).map((row: any) => ({ id: row.id, name: row.name, leader: row.leader, members: row.members }));
});

const lower = (value: string | null) => String(value ?? "").toLowerCase();
const listed = (members: string | null): string[] => (members ? members.split(",").map((member) => member.trim()).filter((member) => member) : []);
const byId = (guildId: number) => (row: GuildRow) => Number(row.id) === Number(guildId);

/** Whether a stored member list names `name` (in lower case). */
const names = (members: string | null, name: string): boolean =>
    !!members && members.toLowerCase().includes(name) && listed(members).some((member) => lower(member) === name);

/** The guild whose list names `username`, in any case, as the accounts table matched it. The newest, should old data name it twice. */
async function guildOf(username: string): Promise<GuildRow | null> {
    const name = lower(username);
    let found = null as GuildRow | null;
    // Looks at every row held and copies none: `find` copies only a row it returns, and is given none.
    await rows.find((row) => {
        if ((!found || Number(row.id) > Number(found.id)) && names(row.members, name)) found = row;
        return false;
    });
    return found ? { ...found } : null;
}

/** After an UPDATE of one guild: the same change to the row held, if the guild is still there. */
async function change(guildId: number, changed: Partial<GuildRow>): Promise<void> {
    const guild = await rows.find(byId(guildId));
    if (guild) await rows.put({ ...guild, ...changed }, byId(guildId));
}

/**
 * Runs one write. `accounts` are the usernames whose guild_id it sets: the
 * player system caches accounts, and is told to read those again whether or
 * not the write was answered.
 *
 * When it is not answered the guilds are read again too: a statement that
 * timed out may still have been applied, so what is held can be trusted no
 * longer. The failure is still thrown, for the caller to answer with.
 */
async function writing<T>(accounts: Array<string | null | undefined>, write: () => Promise<T>): Promise<T> {
    try {
        return await write();
    } catch (error) {
        await rows.reload().catch((failure) => log.error(`Error reading the guilds again after a failed write: ${failure}`));
        throw error;
    } finally {
        for (const username of new Set(accounts)) {
            if (username) await dropRows("accounts", username);
        }
    }
}

const guilds = {
    async isInGuild(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            return (await guildOf(username)) !== null;
        } catch (error) {
            log.error(`Error checking if user is in guild: ${error}`);
            return false;
        }
    },
    async isGuildLeader(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            const name = lower(username);
            return (await rows.find((row) => lower(row.leader) === name)) !== null;
        } catch (error) {
            log.error(`Error checking if user is guild leader: ${error}`);
            return false;
        }
    },
    async getGuildId(username: string): Promise<number | null> {
        if (!username) return null;
        try {
            const guild = await guildOf(username);
            if (!guild || !guild.id) return null;
            return guild.id;
        } catch (error) {
            log.error(`Error getting guild ID for user: ${error}`);
            return null;
        }
    },
    async getGuildName(guildId: number): Promise<string | null> {
        if (!guildId) return null;
        try {
            const guild = await rows.find(byId(guildId));
            if (!guild || !guild.name) return null;
            return guild.name;
        } catch (error) {
            log.error(`Error getting guild name: ${error}`);
            return null;
        }
    },
    async getGuildMembers(guildId: number): Promise<string[]> {
        if (!guildId) return [];
        try {
            const guild = await rows.find(byId(guildId));
            if (!guild || !guild.members) return [];
            return listed(guild.members);
        } catch (error) {
            log.error(`Error getting guild members: ${error}`);
            return [];
        }
    },
    async getGuildLeader(guildId: number): Promise<string | null> {
        if (!guildId) return null;
        try {
            const guild = await rows.find(byId(guildId));
            if (!guild || !guild.leader) return null;
            return guild.leader;
        } catch (error) {
            log.error(`Error getting guild leader: ${error}`);
            return null;
        }
    },
    async exists(name: string): Promise<boolean> {
        if (!name) return false;
        try {
            const wanted = lower(name);
            return (await rows.find((row) => lower(row.name) === wanted)) !== null;
        } catch (error) {
            log.error(`Error checking if guild exists: ${error}`);
            return false;
        }
    },
    async list(): Promise<Array<{ id: number; name: string; leader: string; members: string[] }>> {
        try {
            const result = await rows.all();
            if (!result || result.length === 0) return [];
            const inNameOrder = (a: GuildRow, b: GuildRow) => (lower(a.name) < lower(b.name) ? -1 : lower(a.name) > lower(b.name) ? 1 : 0);
            return result.sort(inNameOrder).map((row) => ({
                id: row.id,
                name: row.name,
                leader: row.leader,
                members: listed(row.members)
            }));
        } catch (error) {
            log.error(`Error listing guilds: ${error}`);
            return [];
        }
    },
    // The leader heads the member list: that is how clients tell who leads.
    async setLeader(guildId: number, username: string): Promise<string[]> {
        if (!guildId || !username) return [];
        try {
            const members = await this.getGuildMembers(guildId);
            if (!members.includes(username)) return [];

            const reordered = [username, ...members.filter((member: string) => member !== username)];
            await writing([], () => query("UPDATE guilds SET leader = ?, members = ? WHERE id = ?", [username, reordered.join(", "), guildId]));
            await change(guildId, { leader: username, members: reordered.join(", ") });
            return reordered;
        } catch (error) {
            log.error(`Error setting guild leader: ${error}`);
            return [];
        }
    },
    async add(username: string, guildId: number): Promise<string[]> {
        if (!username) return [];
        try {

            const existingGuild = await this.isInGuild(username);
            if (existingGuild) return [];

            const members = await this.getGuildMembers(guildId) as string[];
            if (!members || members?.length === 0) return [];

            if (members.length >= 500) return [];

            if (members.includes(username)) return [];

            await writing([username], () => query("UPDATE accounts SET guild_id = ? WHERE username = ?", [guildId, username]));
            const updatedMembers = [...members, username].join(", ");
            await writing([], () => query("UPDATE guilds SET members = ? WHERE id = ?", [updatedMembers, guildId]));
            await change(guildId, { members: updatedMembers });
            return updatedMembers.split(", ").map((member: string) => member.trim());
        } catch (error) {
            log.error(`Error adding user to guild: ${error}`);
            return [];
        }
    },
    async remove(username: string): Promise<string[] | boolean> {
        if (!username) return [];
        try {
            const guildId = await this.getGuildId(username);
            if (!guildId) return [];

            await writing([username], () => query("UPDATE accounts SET guild_id = NULL WHERE username = ?", [username]));

            const members = await this.getGuildMembers(guildId);

            // In any case, as the account above was matched: the name must leave the list for the player to have left the guild.
            const updatedMembers = members.filter((member: string) => lower(member) !== lower(username)).join(", ");
            await writing([], () => query("UPDATE guilds SET members = ? WHERE id = ?", [updatedMembers, guildId]));
            await change(guildId, { members: updatedMembers });
            const memberArray = updatedMembers.split(",").map((member: string) => member.trim());
            return memberArray.map((member: string) => member.trim());
        } catch (error) {
            log.error(`Error removing user from guild: ${error}`);
            return [];
        }
    },
    async delete(guildId: number): Promise<boolean> {
        if (!guildId) return false;
        try {
            const guild = await rows.find(byId(guildId));
            await writing([], () => query("DELETE FROM guilds WHERE id = ?", [guildId]));
            await rows.remove(byId(guildId));

            // The accounts that pointed at it: its members.
            const freed = guild ? [...listed(guild.members), guild.leader] : [];
            await writing(freed, () => query("UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", [guildId]));
            log.info(`Guild with ID ${guildId} deleted successfully.`);
            return true;
        } catch (error) {
            log.error(`Error deleting guild: ${error}`);
            return false;
        }
    },
    async leave(username: string): Promise<boolean | string[]> {
        if (!username) return false;
        try {
            const guildId = await this.getGuildId(username);
            if (!guildId) return false;

            const isLeader = await this.isGuildLeader(username);
            if (isLeader) {
                return false;
            }
            return await this.remove(username);
        } catch (error) {
            log.error(`Error leaving guild: ${error}`);
            return false;
        }
    },
    async disband(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            const guildId = await this.getGuildId(username);
            if (!guildId) return false;

            const isLeader = await this.isGuildLeader(username);
            if (!isLeader) return false;

            const members = await this.getGuildMembers(guildId);
            if (members.length === 0) return false;

            await writing(members, () => query("UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", [guildId]));

            return await this.delete(guildId);
        } catch (error) {
            log.error(`Error disbanding guild: ${error}`);
            return false;
        }
    },
    async create(username: string, name: string): Promise<string[] | boolean> {
        if (!username || !name) return false;
        try {
            const trimmed = name.trim();
            if (trimmed.length === 0 || trimmed.length > 20) return false;
            if (!/^[A-Za-z ]+$/.test(trimmed)) return false;

            const lowerName = trimmed.toLowerCase();
            for (const swear of swears) {
                if (lowerName.includes(swear.id.toLowerCase())) {
                    log.warn(`Blocked guild creation with bad word: "${trimmed}" matched "${swear.id}" by user ${username}`);
                    return false;
                }
            }

            const existingGuild = await this.exists(trimmed);
            if (existingGuild) return false;

            const inGuild = await this.isInGuild(username);
            if (inGuild) return false;

            const members = username;;
            const result = await writing([], () => query("INSERT INTO guilds (leader, name, members) VALUES (?, ?, ?)", [username, trimmed, members])) as any;
            const guildId = result.lastInsertRowid;
            // Without the id the database gave it, the new row can only be had by reading the table again.
            if (Number(guildId) > 0) await rows.put({ id: Number(guildId), name: trimmed, leader: username, members }, byId(guildId));
            else await rows.reload();

            await writing([username], () => query("UPDATE accounts SET guild_id = ? WHERE username = ?", [guildId, username]));
            return members.split(", ").map((member: string) => member.trim());
        } catch (error) {
            log.error(`Error creating guild: ${error}`);
            return false;
        }
    }
}

export default guilds;