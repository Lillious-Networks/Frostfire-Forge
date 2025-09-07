import query from "../controllers/sqldatabase";
import log from "../modules/logger";

const parties = {
    async isInParty(username: string): Promise<boolean> {
        if (!username) return false;
        try {
            const result = await query("SELECT party_id FROM accounts WHERE username = ?", [username]) as any[];
            if (result.length === 0) return false; // User not found
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
            if (result.length === 0 || !result[0].members) return []; // Party not found or no members
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
            if (result.length === 0 || !result[0].leader) return null; // Party not found or no leader
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
            // Check if the user is already in a party
            const existingParty = await this.exists(username);
            if (existingParty) return [];

            // Get party members
            const members = await this.getPartyMembers(partyId) as string[];
            if (!members || members?.length === 0) return [];

            // Check if party members exceed the limit of 5
            if (members.length >= 5) return [];

            // Prevent adding the same user multiple times
            if (members.includes(username)) return [];

            // Add the user to the party
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
            if (!partyId) return []; // User is not in a party

            await query("UPDATE accounts SET party_id = NULL WHERE username = ?", [username]);

            const members = await this.getPartyMembers(partyId);

            // Remove the user from the members list
            const updatedMembers = members.filter((member: string) => member !== username).join(", ");
            await query("UPDATE parties SET members = ? WHERE id = ?", [updatedMembers, partyId]);

            // If the party has no members left, delete the party
            const memberArray = Array.isArray(updatedMembers) ? updatedMembers.split(", ") : [updatedMembers];
            if (memberArray.length <= 1) {
                await this.delete(partyId);
                return true; // Party deleted
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
            // Remove party_id from all members in the accounts table
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
            if (existingParty) return false; // Leader is already in a party

            const members = [leader, username].join(", ");
            const result = await query("INSERT INTO parties (leader, members) VALUES (?, ?)", [leader, members]) as any;
            const partyId = result.lastInsertRowid;

            // Update the accounts table to set the party_id for both users
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
            if (!partyId) return false; // User is not in a party

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
            if (!partyId) return false; // User is not in a party

            const isLeader = await this.isPartyLeader(username);
            if (!isLeader) return false; // User is not the leader and cannot disband

            const members = await this.getPartyMembers(partyId);
            if (members.length === 0) return false; // No members to disband

            // Remove all members from the party
            await query("UPDATE accounts SET party_id = NULL WHERE party_id = ?", [partyId]);
            // Delete the party
            return await this.delete(partyId);
        } catch (error) {
            log.error(`Error disbanding party: ${error}`);
            return false;
        }
    }
}

export default parties;