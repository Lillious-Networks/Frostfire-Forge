import query from "../controllers/sqldatabase";
import log from "../modules/logger";

const parties = {
    async isInParty(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            const result = await query("SELECT party_id FROM accounts WHERE username = ?", [username]) as any[];
            if (result.length === 0) return false;
            return result.length > 0;
        } catch (error) {
            log.error(`Error checking if user is in party: ${error}`);
            return false;
        }
    },
    async isPartyLeader(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            const result = await query("SELECT id FROM parties WHERE leader = ?", [username]) as any[];
            return result.length > 0;
        } catch (error) {
            log.error(`Error checking if user is party leader: ${error}`);
            return false;
        }
    },
    async getPartyId(username: string): Promise<number | null> {
        if (!username) return null;
        try {
            const result = await query("SELECT party_id FROM accounts WHERE username = ?", [username]) as any[];
            if (result.length === 0 || !result[0].party_id) return null;
            return result[0].party_id;
        } catch (error) {
            log.error(`Error getting party ID for user: ${error}`);
            return null;
        }
    },
    async getPartyMembers(partyId: number): Promise<string[]> {
        if (!partyId) return [];
        try {
            const result = await query("SELECT members FROM parties WHERE id = ?", [partyId]) as any[];
            if (result.length === 0 || !result[0].members) return [];
            const members = result[0].members.split(",").map((member: any) => member.trim());
            return members.filter((member: any) => member);
        } catch (error) {
            log.error(`Error getting party members: ${error}`);
            return [];
        }
    },
    async getPartyLeader(partyId: number): Promise<string | null> {
        if (!partyId) return null;
        try {
            const result = await query("SELECT leader FROM parties WHERE id = ?", [partyId]) as any[];
            if (result.length === 0 || !result[0].leader) return null;
            return result[0].leader;
        } catch (error) {
            log.error(`Error getting party leader: ${error}`);
            return null;
        }
    },
    async exists(username: string): Promise<boolean> {
        if (!username) return false;
        const result = await this.getPartyId(username);
        return result !== null;
    },
    async add(username: string, partyId: number): Promise<string[]> {
        if (!username) return [];
        try {

            const existingParty = await this.exists(username);
            if (existingParty) return [];

            const members = await this.getPartyMembers(partyId) as string[];
            if (!members || members?.length === 0) return [];

            if (members.length >= 5) return [];

            if (members.includes(username)) return [];

            await query("UPDATE accounts SET party_id = ? WHERE username = ?", [partyId, username]);
            const updatedMembers = [...members, username].join(", ");
            await query("UPDATE parties SET members = ? WHERE id = ?", [updatedMembers, partyId]);
            return updatedMembers.split(", ").map((member: string) => member.trim());
        } catch (error) {
            log.error(`Error adding user to party: ${error}`);
            return [];
        }
    },
    async remove(username: string): Promise<string[] | boolean> {
        if (!username) return [];
        try {
            const partyId = await this.getPartyId(username);
            if (!partyId) return [];

            await query("UPDATE accounts SET party_id = NULL WHERE username = ?", [username]);

            const members = await this.getPartyMembers(partyId);

            const updatedMembers = members.filter((member: string) => member !== username).join(", ");
            await query("UPDATE parties SET members = ? WHERE id = ?", [updatedMembers, partyId]);

            const memberArray = Array.isArray(updatedMembers) ? updatedMembers.split(", ") : [updatedMembers];
            if (memberArray.length <= 1) {
                await this.delete(partyId);
                return true;
            }

            return memberArray.map((member: string) => member.trim());
        } catch (error) {
            log.error(`Error removing user from party: ${error}`);
            return [];
        }
    },
    async delete(partyId: number): Promise<boolean> {
        if (!partyId) return false;
        try {
            await query("DELETE FROM parties WHERE id = ?", [partyId]);

            await query("UPDATE accounts SET party_id = NULL WHERE party_id = ?", [partyId]);
            log.info(`Party with ID ${partyId} deleted successfully.`);
            return true;
        } catch (error) {
            log.error(`Error deleting party: ${error}`);
            return false;
        }
    },
    async create(leader: string, username: string): Promise<string[] | boolean> {
        if (!leader || !username) return false;
        try {
            const existingParty = await this.exists(leader);
            if (existingParty) return false;

            const members = [leader, username].join(", ");
            const result = await query("INSERT INTO parties (leader, members) VALUES (?, ?)", [leader, members]) as any;
            const partyId = result.lastInsertRowid;

            await query("UPDATE accounts SET party_id = ? WHERE username IN (?, ?)", [partyId, leader, username]);
            return members.split(", ").map((member: string) => member.trim());
        } catch (error) {
            log.error(`Error creating party: ${error}`);
            return false;
        }
    },
    async leave(username: string): Promise<boolean | string[]> {
        if (!username) return false;
        try {
            const partyId = await this.getPartyId(username);
            if (!partyId) return false;

            const isLeader = await this.isPartyLeader(username);
            if (isLeader) return await this.delete(partyId);

            return await this.remove(username);
        } catch (error) {
            log.error(`Error leaving party: ${error}`);
            return false;
        }
    },
    async disband(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            const partyId = await this.getPartyId(username);
            if (!partyId) return false;

            const isLeader = await this.isPartyLeader(username);
            if (!isLeader) return false;

            const members = await this.getPartyMembers(partyId);
            if (members.length === 0) return false;

            await query("UPDATE accounts SET party_id = NULL WHERE party_id = ?", [partyId]);

            return await this.delete(partyId);
        } catch (error) {
            log.error(`Error disbanding party: ${error}`);
            return false;
        }
    },
    async getAllParties(): Promise<Array<{ id: number; leader: string; members: string[] }>> {
        try {
            const result = await query("SELECT id, leader, members FROM parties", []) as any[];
            if (!result || result.length === 0) return [];

            return result.map((row: any) => ({
                id: row.id,
                leader: row.leader,
                members: row.members ? row.members.split(",").map((m: string) => m.trim()).filter((m: string) => m) : []
            }));
        } catch (error) {
            log.error(`Error getting all parties: ${error}`);
            return [];
        }
    }
}

export default parties;