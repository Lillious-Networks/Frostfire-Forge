import query, { transaction } from "../controllers/sqldatabase";
import log from "../modules/logger";
import { tableCache, dropRows, turns } from "../services/datacache";
import {
    ALL_PERMISSIONS, DEFAULT_RANKS, GuildPermission, MAX_MEMBERS, MAX_MOTD, MAX_NOTE, MAX_RANKS, MIN_RANKS, NEW_RANK_PERMISSIONS,
    cleanText, containsSwear, demotedRank, hasPermission, lowestRank, outranks, promotedRank, validRankName,
    type GuildRank, type GuildRefusal, type GuildResult,
} from "./guildranks";

type GuildRow = { id: number; name: string; leader: string; motd: string };
type RankRow = { guild_id: number; rank_index: number; name: string; permissions: number };
export type MemberRow = { username: string; guild_id: number; rank_index: number; public_note: string; officer_note: string };

export type GuildPacket = {
    guild_name: string | null;
    members: string[];
    motd: string;
    ranks: GuildRank[];
    roster: Array<{ username: string; rank: number; public_note: string; officer_note?: string }>;
    my_rank: number | null;
};

// Every guild, rank and member. Reads are answered from these rows; every
// change below is written to the database and then to them. A write the
// database does not answer has all three read again (see `writing`).
//
// Who is in a guild is who guild_members names. accounts.guild_id says the
// same after each change here, and is what a login reads.
const guildRows = tableCache<GuildRow>("guilds", async () => {
    const result = await query("SELECT id, name, leader, motd FROM guilds", []) as any[];
    return (result || []).map((row: any) => ({ id: Number(row.id), name: row.name, leader: row.leader, motd: row.motd ?? "" }));
});
const rankRows = tableCache<RankRow>("guild_ranks", async () => {
    const result = await query("SELECT guild_id, rank_index, name, permissions FROM guild_ranks", []) as any[];
    return (result || []).map((row: any) => ({ guild_id: Number(row.guild_id), rank_index: Number(row.rank_index), name: row.name, permissions: Number(row.permissions) }));
});
const memberRows = tableCache<MemberRow>("guild_members", async () => {
    const result = await query("SELECT username, guild_id, rank_index, public_note, officer_note FROM guild_members", []) as any[];
    return (result || []).map((row: any) => ({
        username: row.username, guild_id: Number(row.guild_id), rank_index: Number(row.rank_index),
        public_note: row.public_note ?? "", officer_note: row.officer_note ?? "",
    }));
});

/** One change to a guild at a time: each reads the rows held and writes from them. */
const inTurn = turns();

const lower = (value: string | null | undefined) => String(value ?? "").toLowerCase();
const byId = (guildId: number) => (row: GuildRow) => Number(row.id) === Number(guildId);
const named = (username: string) => (row: MemberRow) => lower(row.username) === lower(username);
const inGuild = (guildId: number) => (row: { guild_id: number }) => Number(row.guild_id) === Number(guildId);
const ranked = (a: MemberRow, b: MemberRow) => a.rank_index - b.rank_index || lower(a.username).localeCompare(lower(b.username));

async function ranksOf(guildId: number): Promise<GuildRank[]> {
    const rows = await rankRows.filter(inGuild(guildId));
    return rows.map((row) => ({ index: row.rank_index, name: row.name, permissions: row.permissions })).sort((a, b) => a.index - b.index);
}

async function membersOf(guildId: number): Promise<MemberRow[]> {
    return (await memberRows.filter(inGuild(guildId))).sort(ranked);
}

/**
 * Runs one write. `accounts` are the usernames whose guild_id it sets: the
 * player system caches accounts, and is told to read those again whether or
 * not the write was answered. When it is not answered the guild tables are
 * read again too, and the failure is still thrown.
 */
async function writing<T>(accounts: Array<string | null | undefined>, write: () => Promise<T>): Promise<T> {
    try {
        return await write();
    } catch (error) {
        for (const table of [guildRows, rankRows, memberRows]) {
            await table.reload().catch((failure) => log.error(`Error reading the guilds again after a failed write: ${failure}`));
        }
        throw error;
    } finally {
        for (const username of new Set(accounts)) {
            if (username) await dropRows("accounts", username);
        }
    }
}

type Pair = { ok: true; guildId: number; ranks: GuildRank[]; actor: MemberRow; target: MemberRow } | { ok: false; reason: GuildRefusal };

/** The actor and target as members of one guild, or why not. */
async function pairOf(actor: string, target: string): Promise<Pair> {
    const me = await memberRows.find(named(actor));
    if (!me) return { ok: false, reason: "not_in_guild" };
    const them = await memberRows.find(named(target));
    if (!them || them.guild_id !== me.guild_id) return { ok: false, reason: "not_member" };
    return { ok: true, guildId: me.guild_id, ranks: await ranksOf(me.guild_id), actor: me, target: them };
}

const refuse = (reason: GuildRefusal): GuildResult => ({ ok: false, reason });
/** A save of what is already there: nothing written, nobody to tell. */
const unchanged = (): GuildResult => ({ ok: true, changed: false });

/** One write, then its row in the cache. A thrown write is "failed". */
async function saving(write: () => Promise<unknown>, cache: () => Promise<unknown>): Promise<GuildResult> {
    try {
        await writing([], write);
        await cache();
        return { ok: true };
    } catch (error) {
        log.error(`Error changing a guild: ${error}`);
        return refuse("failed");
    }
}

async function setRank(row: MemberRow, rank: number): Promise<GuildResult> {
    return saving(
        () => query("UPDATE guild_members SET rank_index = ? WHERE username = ?", [rank, row.username]),
        () => memberRows.put({ ...row, rank_index: rank }, named(row.username)),
    );
}

type Outcome = GuildResult & { members?: string[] };

/**
 * Runs `work` in the actor's guild's turn, with the actor and target read
 * again inside it: what a change checks and writes back is what the turn
 * before it left. Not in the same guild any more is refused.
 */
async function inPair(actor: string, target: string, work: (pair: Extract<Pair, { ok: true }>) => Promise<Outcome>): Promise<Outcome> {
    const seen = await memberRows.find(named(actor));
    if (!seen) return refuse("not_in_guild");
    return inTurn(seen.guild_id, async () => {
        const pair = await pairOf(actor, target);
        if (!pair.ok) return refuse(pair.reason);
        if (pair.guildId !== seen.guild_id) return refuse("not_in_guild");
        return work(pair);
    });
}

/** As `inPair`, for what only the Guild Master does. */
async function inMaster(actor: string, work: (guildId: number) => Promise<GuildResult>): Promise<GuildResult> {
    const seen = await memberRows.find(named(actor));
    if (!seen) return refuse("not_in_guild");
    return inTurn(seen.guild_id, async () => {
        const me = await memberRows.find(named(actor));
        if (!me || me.guild_id !== seen.guild_id) return refuse("not_in_guild");
        if (me.rank_index !== 0) return refuse("no_permission");
        return work(me.guild_id);
    });
}

// The changes that need a turn, without one: callers hold the guild's turn.

/** New leader to rank 0, old leader to rank 1. */
async function setLeaderIn(guildId: number, username: string): Promise<string[]> {
    try {
        const guild = await guildRows.find(byId(guildId));
        const target = await memberRows.find(named(username));
        if (!guild || !target || Number(target.guild_id) !== Number(guildId)) return [];
        const old = await memberRows.find(named(guild.leader));
        const statements = [
            { sql: "UPDATE guilds SET leader = ? WHERE id = ?", values: [target.username, guildId] },
            { sql: "UPDATE guild_members SET rank_index = ? WHERE username = ?", values: [0, target.username] },
        ];
        if (old && lower(old.username) !== lower(target.username)) statements.push({ sql: "UPDATE guild_members SET rank_index = ? WHERE username = ?", values: [1, old.username] });
        await writing([], () => transaction(statements));
        await guildRows.put({ ...guild, leader: target.username }, byId(guildId));
        await memberRows.put({ ...target, rank_index: 0 }, named(target.username));
        if (old && lower(old.username) !== lower(target.username)) await memberRows.put({ ...old, rank_index: 1 }, named(old.username));
        return (await membersOf(guildId)).map((row) => row.username);
    } catch (error) {
        log.error(`Error setting guild leader: ${error}`);
        return [];
    }
}

/** Who is left, or none when the member is gone, is the Guild Master, or the write failed. */
async function removeIn(seen: MemberRow): Promise<string[]> {
    try {
        const me = await memberRows.find(named(seen.username));
        if (!me || me.guild_id !== seen.guild_id) return [];
        // The leader may have changed since the caller looked: rank 0 hands over or disbands, it never leaves.
        if (me.rank_index === 0) return [];
        await writing([me.username], () => transaction([
            { sql: "UPDATE accounts SET guild_id = NULL WHERE username = ?", values: [me.username] },
            { sql: "DELETE FROM guild_members WHERE username = ?", values: [me.username] },
        ]));
        await memberRows.remove(named(me.username));
        return (await membersOf(me.guild_id)).map((row) => row.username);
    } catch (error) {
        log.error(`Error removing user from guild: ${error}`);
        return [];
    }
}

async function deleteIn(guildId: number): Promise<boolean> {
    try {
        const guild = await guildRows.find(byId(guildId));
        const freed = [...(await membersOf(guildId)).map((row) => row.username), guild?.leader];
        await writing(freed, () => transaction([
            { sql: "DELETE FROM guild_members WHERE guild_id = ?", values: [guildId] },
            { sql: "DELETE FROM guild_ranks WHERE guild_id = ?", values: [guildId] },
            { sql: "DELETE FROM guilds WHERE id = ?", values: [guildId] },
            { sql: "UPDATE accounts SET guild_id = NULL WHERE guild_id = ?", values: [guildId] },
        ]));
        await memberRows.remove(inGuild(guildId));
        await rankRows.remove(inGuild(guildId));
        await guildRows.remove(byId(guildId));
        log.info(`Guild with ID ${guildId} deleted successfully.`);
        return true;
    } catch (error) {
        log.error(`Error deleting guild: ${error}`);
        return false;
    }
}

const guilds = {
    async isInGuild(username: string): Promise<boolean> {
        if (!username) return false;
        try { return (await memberRows.find(named(username))) !== null; }
        catch (error) { log.error(`Error checking if user is in guild: ${error}`); return false; }
    },
    async isGuildLeader(username: string): Promise<boolean> {
        if (!username) return false;
        try { return (await guildRows.find((row) => lower(row.leader) === lower(username))) !== null; }
        catch (error) { log.error(`Error checking if user is guild leader: ${error}`); return false; }
    },
    async getGuildId(username: string): Promise<number | null> {
        if (!username) return null;
        try { return (await memberRows.find(named(username)))?.guild_id ?? null; }
        catch (error) { log.error(`Error getting guild ID for user: ${error}`); return null; }
    },
    async getGuildName(guildId: number): Promise<string | null> {
        if (!guildId) return null;
        try { return (await guildRows.find(byId(guildId)))?.name || null; }
        catch (error) { log.error(`Error getting guild name: ${error}`); return null; }
    },
    /** Leader first (rank 0), then by rank, then by name. */
    async getGuildMembers(guildId: number): Promise<string[]> {
        if (!guildId) return [];
        try { return (await membersOf(guildId)).map((row) => row.username); }
        catch (error) { log.error(`Error getting guild members: ${error}`); return []; }
    },
    async getGuildLeader(guildId: number): Promise<string | null> {
        if (!guildId) return null;
        try { return (await guildRows.find(byId(guildId)))?.leader || null; }
        catch (error) { log.error(`Error getting guild leader: ${error}`); return null; }
    },
    async getRanks(guildId: number): Promise<GuildRank[]> {
        if (!guildId) return [];
        try { return await ranksOf(guildId); }
        catch (error) { log.error(`Error getting guild ranks: ${error}`); return []; }
    },
    async getMember(username: string): Promise<MemberRow | null> {
        if (!username) return null;
        try { return await memberRows.find(named(username)); }
        catch (error) { log.error(`Error getting guild member: ${error}`); return null; }
    },
    async getMotd(guildId: number): Promise<string> {
        if (!guildId) return "";
        try { return (await guildRows.find(byId(guildId)))?.motd ?? ""; }
        catch (error) { log.error(`Error getting guild MOTD: ${error}`); return ""; }
    },
    /** Whether `username`'s rank has `permission`. False outside a guild. */
    async can(username: string, permission: number): Promise<boolean> {
        const me = await this.getMember(username);
        if (!me) return false;
        return hasPermission(await this.getRanks(me.guild_id), me.rank_index, permission);
    },
    /** The members whose rank has `permission`, in roster order. For chat audiences. */
    async listeners(guildId: number, permission: number): Promise<string[]> {
        const ranks = await this.getRanks(guildId);
        return (await membersOf(guildId)).filter((row) => hasPermission(ranks, row.rank_index, permission)).map((row) => row.username);
    },
    async exists(name: string): Promise<boolean> {
        if (!name) return false;
        try { return (await guildRows.find((row) => lower(row.name) === lower(name))) !== null; }
        catch (error) { log.error(`Error checking if guild exists: ${error}`); return false; }
    },
    async list(): Promise<Array<{ id: number; name: string; leader: string; members: string[] }>> {
        try {
            const result = await guildRows.all();
            const inNameOrder = (a: GuildRow, b: GuildRow) => (lower(a.name) < lower(b.name) ? -1 : lower(a.name) > lower(b.name) ? 1 : 0);
            const all = await memberRows.all();
            return result.sort(inNameOrder).map((row) => ({
                id: row.id, name: row.name, leader: row.leader,
                members: all.filter(inGuild(row.id)).sort(ranked).map((m) => m.username),
            }));
        } catch (error) {
            log.error(`Error listing guilds: ${error}`);
            return [];
        }
    },
    /** New leader to rank 0, old leader to rank 1. */
    async setLeader(guildId: number, username: string): Promise<string[]> {
        if (!guildId || !username) return [];
        return inTurn(guildId, () => setLeaderIn(guildId, username));
    },
    /** Joins at the lowest rank. */
    async add(username: string, guildId: number): Promise<string[]> {
        if (!username || !guildId) return [];
        return inTurn(guildId, async () => {
            try {
                if (await this.isInGuild(username)) return [];
                const members = await membersOf(guildId);
                if (members.length === 0 || members.length >= MAX_MEMBERS) return [];
                const rank = lowestRank(await ranksOf(guildId));
                await writing([username], () => transaction([
                    { sql: "UPDATE accounts SET guild_id = ? WHERE username = ?", values: [guildId, username] },
                    { sql: "INSERT INTO guild_members (username, guild_id, rank_index, public_note, officer_note) VALUES (?, ?, ?, '', '')", values: [username, guildId, rank] },
                ]));
                await memberRows.put({ username, guild_id: guildId, rank_index: rank, public_note: "", officer_note: "" }, named(username));
                return await this.getGuildMembers(guildId);
            } catch (error) {
                log.error(`Error adding user to guild: ${error}`);
                return [];
            }
        });
    },
    async remove(username: string): Promise<string[] | boolean> {
        if (!username) return [];
        const me = await this.getMember(username);
        if (!me) return [];
        return inTurn(me.guild_id, () => removeIn(me));
    },
    async delete(guildId: number): Promise<boolean> {
        if (!guildId) return false;
        return inTurn(guildId, () => deleteIn(guildId));
    },
    async leave(username: string): Promise<boolean | string[]> {
        if (!username) return false;
        try {
            if (!(await this.getGuildId(username))) return false;
            if (await this.isGuildLeader(username)) return false;
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
            if (!(await this.isGuildLeader(username))) return false;
            // Asked again in the turn: a transfer queued before this one may have made someone else the leader.
            return await inTurn(guildId, async () => {
                const guild = await guildRows.find(byId(guildId));
                if (!guild || lower(guild.leader) !== lower(username)) return false;
                return deleteIn(guildId);
            });
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
            if (containsSwear(trimmed)) {
                log.warn(`Blocked guild creation with bad word: "${trimmed}" by user ${username}`);
                return false;
            }
            if (await this.exists(trimmed)) return false;
            if (await this.isInGuild(username)) return false;

            const results = await writing([username], () => transaction([
                { sql: "INSERT INTO guilds (leader, name, motd) VALUES (?, ?, '')", values: [username, trimmed] },
                ...DEFAULT_RANKS.map((rank) => ({
                    sql: "INSERT INTO guild_ranks (guild_id, rank_index, name, permissions) SELECT id, ?, ?, ? FROM guilds WHERE name = ?",
                    values: [rank.index, rank.name, rank.permissions, trimmed],
                })),
                { sql: "INSERT INTO guild_members (username, guild_id, rank_index, public_note, officer_note) SELECT ?, id, 0, '', '' FROM guilds WHERE name = ?", values: [username, trimmed] },
                { sql: "UPDATE accounts SET guild_id = (SELECT id FROM guilds WHERE name = ?) WHERE username = ?", values: [trimmed, username] },
            ]));
            const guildId = Number(results?.[0]?.lastInsertRowid);
            // Without the id the database gave it, the new rows can only be had by reading the tables again.
            if (guildId > 0) {
                await guildRows.put({ id: guildId, name: trimmed, leader: username, motd: "" }, byId(guildId));
                for (const rank of DEFAULT_RANKS) {
                    await rankRows.put({ guild_id: guildId, rank_index: rank.index, name: rank.name, permissions: rank.permissions }, (row) => row.guild_id === guildId && row.rank_index === rank.index);
                }
                await memberRows.put({ username, guild_id: guildId, rank_index: 0, public_note: "", officer_note: "" }, named(username));
            } else {
                for (const table of [guildRows, rankRows, memberRows]) await table.reload();
            }
            return [username];
        } catch (error) {
            log.error(`Error creating guild: ${error}`);
            return false;
        }
    },
    async kick(actor: string, target: string): Promise<GuildResult & { members?: string[] }> {
        if (lower(actor) === lower(target)) return refuse("self");
        return inPair(actor, target, async (pair) => {
            if (!hasPermission(pair.ranks, pair.actor.rank_index, GuildPermission.KICK)) return refuse("no_permission");
            if (!outranks(pair.actor.rank_index, pair.target.rank_index)) return refuse("not_below");
            const members = await removeIn(pair.target);
            if (members.length === 0) return refuse("failed");
            return { ok: true, members };
        });
    },
    async promote(actor: string, target: string): Promise<GuildResult> {
        return inPair(actor, target, async (pair) => {
            if (!hasPermission(pair.ranks, pair.actor.rank_index, GuildPermission.PROMOTE)) return refuse("no_permission");
            if (!outranks(pair.actor.rank_index, pair.target.rank_index)) return refuse("not_below");
            const next = promotedRank(pair.actor.rank_index, pair.target.rank_index);
            if (next === null) return refuse("promote_ceiling");
            return setRank(pair.target, next);
        });
    },
    async demote(actor: string, target: string): Promise<GuildResult> {
        return inPair(actor, target, async (pair) => {
            if (!hasPermission(pair.ranks, pair.actor.rank_index, GuildPermission.DEMOTE)) return refuse("no_permission");
            if (!outranks(pair.actor.rank_index, pair.target.rank_index)) return refuse("not_below");
            const next = demotedRank(pair.ranks, pair.target.rank_index);
            if (next === null) return refuse("demote_floor");
            return setRank(pair.target, next);
        });
    },
    async setMotd(actor: string, motd: unknown): Promise<GuildResult> {
        const seen = await memberRows.find(named(actor));
        if (!seen) return refuse("not_in_guild");
        return inTurn(seen.guild_id, async () => {
            const me = await memberRows.find(named(actor));
            if (!me || me.guild_id !== seen.guild_id) return refuse("not_in_guild");
            if (!hasPermission(await ranksOf(me.guild_id), me.rank_index, GuildPermission.SET_MOTD)) return refuse("no_permission");
            const text = cleanText(motd, MAX_MOTD);
            if (text === null) return refuse("bad_text");
            const guild = await guildRows.find(byId(me.guild_id));
            if (!guild) return refuse("not_in_guild");
            if (guild.motd === text) return unchanged();
            return saving(
                () => query("UPDATE guilds SET motd = ? WHERE id = ?", [text, me.guild_id]),
                () => guildRows.put({ ...guild, motd: text }, byId(me.guild_id)),
            );
        });
    },
    async setNote(actor: string, target: string, note: unknown, officer: boolean): Promise<GuildResult> {
        return inPair(actor, target, async (pair) => {
            const self = lower(pair.actor.username) === lower(pair.target.username);
            const bit = officer ? GuildPermission.EDIT_OFFICER_NOTE : GuildPermission.EDIT_PUBLIC_NOTE;
            const mayEdit = hasPermission(pair.ranks, pair.actor.rank_index, bit);
            // Own public note: always. Own officer note: with the bit. Anyone else's: the bit and a lower rank.
            if (self ? officer && !mayEdit : !mayEdit) return refuse("no_permission");
            if (!self && !outranks(pair.actor.rank_index, pair.target.rank_index)) return refuse("not_below");
            const text = cleanText(note, MAX_NOTE);
            if (text === null) return refuse("bad_text");
            const column = officer ? "officer_note" : "public_note";
            if (pair.target[column] === text) return unchanged();
            return saving(
                () => query(`UPDATE guild_members SET ${column} = ? WHERE username = ?`, [text, pair.target.username]),
                () => memberRows.put({ ...pair.target, [column]: text }, named(pair.target.username)),
            );
        });
    },
    async addRank(actor: string, name: unknown): Promise<GuildResult> {
        return inMaster(actor, async (guildId) => {
            const ranks = await ranksOf(guildId);
            if (ranks.length >= MAX_RANKS) return refuse("max_ranks");
            const rankName = validRankName(name);
            if (rankName === null) return refuse("bad_name");
            const index = lowestRank(ranks) + 1;
            return saving(
                () => query("INSERT INTO guild_ranks (guild_id, rank_index, name, permissions) VALUES (?, ?, ?, ?)", [guildId, index, rankName, NEW_RANK_PERMISSIONS]),
                () => rankRows.put({ guild_id: guildId, rank_index: index, name: rankName, permissions: NEW_RANK_PERMISSIONS }, (row) => row.guild_id === guildId && row.rank_index === index),
            );
        });
    },
    async editRank(actor: string, index: number, changes: { name?: unknown; permissions?: unknown }): Promise<GuildResult> {
        return inMaster(actor, async (guildId) => {
            const rank = (await ranksOf(guildId)).find((r) => r.index === Number(index));
            if (!rank) return refuse("no_rank");
            if (rank.index === 0 && changes.permissions !== undefined) return refuse("rank_zero");
            const name = changes.name === undefined ? rank.name : validRankName(changes.name);
            if (name === null) return refuse("bad_name");
            if (changes.permissions !== undefined && !(typeof changes.permissions === "number" && Number.isInteger(changes.permissions))) return refuse("bad_text");
            const permissions = changes.permissions === undefined ? rank.permissions : ((changes.permissions as number) & ALL_PERMISSIONS);
            if (name === rank.name && permissions === rank.permissions) return unchanged();
            return saving(
                () => query("UPDATE guild_ranks SET name = ?, permissions = ? WHERE guild_id = ? AND rank_index = ?", [name, permissions, guildId, rank.index]),
                () => rankRows.put({ guild_id: guildId, rank_index: rank.index, name, permissions }, (row) => row.guild_id === guildId && row.rank_index === rank.index),
            );
        });
    },
    async deleteRank(actor: string): Promise<GuildResult> {
        return inMaster(actor, async (guildId) => {
            const ranks = await ranksOf(guildId);
            if (ranks.length <= MIN_RANKS) return refuse("min_ranks");
            const lowest = lowestRank(ranks);
            if ((await membersOf(guildId)).some((row) => row.rank_index === lowest)) return refuse("rank_in_use");
            return saving(
                () => query("DELETE FROM guild_ranks WHERE guild_id = ? AND rank_index = ?", [guildId, lowest]),
                () => rankRows.remove((row) => row.guild_id === guildId && row.rank_index === lowest),
            );
        });
    },
    async transferLeader(actor: string, target: string): Promise<GuildResult> {
        if (lower(actor) === lower(target)) return refuse("self");
        return inPair(actor, target, async (pair) => {
            if (pair.actor.rank_index !== 0) return refuse("no_permission");
            const members = await setLeaderIn(pair.guildId, pair.target.username);
            return members.length > 0 ? { ok: true } : refuse("failed");
        });
    },
    async packetFor(guildId: number, viewer: string): Promise<GuildPacket> {
        return (await this.packetsFor(guildId, [viewer])).get(viewer)!;
    },
    /**
     * The guild as each viewer's rank may see it, keyed by the name as given.
     * The guild is read and built once; per viewer only the officer notes
     * and their own rank differ. The packets share the parts they have in common.
     */
    async packetsFor(guildId: number, viewers: string[]): Promise<Map<string, GuildPacket>> {
        const ranks = await this.getRanks(guildId);
        const members = await membersOf(guildId);
        const base = {
            guild_name: await this.getGuildName(guildId),
            members: members.map((row) => row.username),
            motd: await this.getMotd(guildId),
            // Rank 0 holds every permission whatever its row says.
            ranks: ranks.map((rank) => (rank.index === 0 ? { ...rank, permissions: ALL_PERMISSIONS } : rank)),
        };
        const rosterOf = (seesOfficerNotes: boolean) => members.map((row) => ({
            username: row.username,
            rank: row.rank_index,
            public_note: row.public_note,
            ...(seesOfficerNotes ? { officer_note: row.officer_note } : {}),
        }));
        const rosters = new Map<boolean, GuildPacket["roster"]>();
        const packets = new Map<string, GuildPacket>();
        for (const viewer of viewers) {
            const me = members.find(named(viewer));
            const seesOfficerNotes = !!me && hasPermission(ranks, me.rank_index, GuildPermission.VIEW_OFFICER_NOTE);
            if (!rosters.has(seesOfficerNotes)) rosters.set(seesOfficerNotes, rosterOf(seesOfficerNotes));
            packets.set(viewer, { ...base, roster: rosters.get(seesOfficerNotes)!, my_rank: me ? me.rank_index : null });
        }
        return packets;
    },
};

export default guilds;
