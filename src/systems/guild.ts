import query from "../controllers/sqldatabase";
import log from "../modules/logger";

const guilds = {
    async isInGuild(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            const result = await query("SELECT guild_id FROM accounts WHERE username = ?", [username]) as any[];
            if (result.length === 0) return false; // User not found
            return result.length > 0;
        } catch (error) {
            log.error(`Error checking if user is in guild: ${error}`);
            return false;
        }
    },
    async isGuildLeader(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            const result = await query("SELECT id FROM guilds WHERE leader = ?", [username]) as any[];
            return result.length > 0;
        } catch (error) {
            log.error(`Error checking if user is guild leader: ${error}`);
            return false;
        }
    },
    async getGuildId(username: string): Promise<number | null> {
        if (!username) return null;
        try {
            const result = await query("SELECT guild_id FROM accounts WHERE username = ?", [username]) as any[];
            if (result.length === 0 || !result[0].guild_id) return null;
            return result[0].guild_id;
        } catch (error) {
            log.error(`Error getting guild ID for user: ${error}`);
            return null;
        }
    },
    async getGuildName(guildId: number): Promise<string | null> {
        if (!guildId) return null;
        try {
            const result = await query("SELECT name FROM guilds WHERE id = ?", [guildId]) as any[];
            if (result.length === 0 || !result[0].name) return null; // Guild not found or no name
            return result[0].name;
        } catch (error) {
            log.error(`Error getting guild name: ${error}`);
            return null;
        }
    },
    async getGuildMembers(guildId: number): Promise<string[]> {
        if (!guildId) return [];
        try {
            const result = await query("SELECT members FROM guilds WHERE id = ?", [guildId]) as any[];
            if (result.length === 0 || !result[0].members) return []; // Guild not found or no members
            const members = result[0].members.split(",").map((member: any) => member.trim());
            return members.filter((member: any) => member);
        } catch (error) {
            log.error(`Error getting guild members: ${error}`);
            return [];
        }
    },
    async getGuildLeader(guildId: number): Promise<string | null> {
        if (!guildId) return null;
        try {
            const result = await query("SELECT leader FROM guilds WHERE id = ?", [guildId]) as any[];
            if (result.length === 0 || !result[0].leader) return null; // Guild not found or no leader
            return result[0].leader;
        } catch (error) {
            log.error(`Error getting guild leader: ${error}`);
            return null;
        }
    },
    async exists(name: string): Promise<boolean> {
        if (!name) return false;
        try {
            const result = await query("SELECT id FROM guilds WHERE name = ?", [name]) as any[];
            return result.length > 0;
        } catch (error) {
            log.error(`Error checking if guild exists: ${error}`);
            return false;
        }
    },
    async add(username: string, guildId: number): Promise<string[]> {
        if (!username) return [];
        try {
            // Check if the user is already in a guild
            const existingGuild = await this.exists(username);
            if (existingGuild) return [];

            // Get guild members
            const members = await this.getGuildMembers(guildId) as string[];
            if (!members || members?.length === 0) return [];

            // Check if guild members exceed the limit of 500
            if (members.length >= 500) return [];

            // Prevent adding the same user multiple times
            if (members.includes(username)) return [];

            // Add the user to the guild
            await query("UPDATE accounts SET guild_id = ? WHERE username = ?", [guildId, username]);
            const updatedMembers = [...members, username].join(", ");
            await query("UPDATE guilds SET members = ? WHERE id = ?", [updatedMembers, guildId]);
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
            if (!guildId) return []; // User is not in a guild

            await query("UPDATE accounts SET guild_id = NULL WHERE username = ?", [username]);

            const members = await this.getGuildMembers(guildId);

            // Remove the user from the members list
            const updatedMembers = members.filter((member: string) => member !== username).join(", ");
            await query("UPDATE guilds SET members = ? WHERE id = ?", [updatedMembers, guildId]);
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
            await query("DELETE FROM guilds WHERE id = ?", [guildId]);
            // Remove guild_id from all members in the accounts table
            await query("UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", [guildId]);
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
            if (!guildId) return false; // User is not in a guild

            const isLeader = await this.isGuildLeader(username);
            if (isLeader) {
                return false; // Guild leaders cannot leave the guild
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
            if (!guildId) return false; // User is not in a guild

            const isLeader = await this.isGuildLeader(username);
            if (!isLeader) return false; // User is not the leader and cannot disband

            const members = await this.getGuildMembers(guildId);
            if (members.length === 0) return false; // No members to disband

            // Remove all members from the guild
            await query("UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", [guildId]);
            // Delete the guild
            return await this.delete(guildId);
        } catch (error) {
            log.error(`Error disbanding guild: ${error}`);
            return false;
        }
    },
    async create(username: string, name: string): Promise<string[] | boolean> {
        if (!username || !name) return false;
        try {
            const existingGuild = await this.exists(name);
            if (existingGuild) return false; // Guild name already exists

            // Check if the user is already in a guild
            const inGuild = await this.isInGuild(username);
            if (inGuild) return false;

            const members = username;;
            const result = await query("INSERT INTO guilds (leader, name, members) VALUES (?, ?, ?)", [username, name, members]) as any;
            const guildId = result.lastInsertRowid;
            // Update the accounts table to set the guild_id for the user
            await query("UPDATE accounts SET guild_id = ? WHERE username = ?", [guildId, username]);
            return members.split(", ").map((member: string) => member.trim());
        } catch (error) {
            log.error(`Error creating guild: ${error}`);
            return false;
        }
    }
}

export default guilds;