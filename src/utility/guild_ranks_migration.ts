import { DEFAULT_RANKS, lowestRank } from "../systems/guildranks";
import log from "../modules/logger";

type Ask = (sql: string, values?: any[]) => Promise<any>;
type Statement = { sql: string; values: any[] };
type RunAll = (statements: Statement[]) => Promise<unknown>;

/**
 * Gives every guild that has no guild_ranks rows yet the default ranks and
 * one member row per name on its old comma list: the leader at rank 0, the
 * rest at the lowest rank. Each guild is written as one transaction, so a
 * failure leaves it untouched and setup can run again. A name already in
 * guild_members (or listed by a newer guild) is skipped, since a player can
 * be in one guild only. Answers how many guilds it changed.
 */
export async function migrateGuildRanks(ask: Ask, runAll: RunAll): Promise<number> {
    const guilds = ((await ask("SELECT id, leader, members FROM guilds")) || []) as Array<{ id: number; leader: string; members: string | null }>;
    const done = new Set((((await ask("SELECT DISTINCT guild_id FROM guild_ranks")) || []) as any[]).map((row) => Number(row.guild_id)));
    const seen = new Set((((await ask("SELECT username FROM guild_members")) || []) as any[]).map((row) => String(row.username).toLowerCase()));
    const lowest = lowestRank(DEFAULT_RANKS);
    let migrated = 0;

    // Newest first, so a player listed by two guilds stays in the newest one
    for (const guild of [...guilds].sort((a, b) => Number(b.id) - Number(a.id))) {
        if (done.has(Number(guild.id))) continue;
        const statements: Statement[] = DEFAULT_RANKS.map((rank) => ({
            sql: "INSERT INTO guild_ranks (guild_id, rank_index, name, permissions) VALUES (?, ?, ?, ?)",
            values: [guild.id, rank.index, rank.name, rank.permissions],
        }));
        const listed = String(guild.members ?? "").split(",").map((name) => name.trim()).filter(Boolean);
        // A name this guild already took (the leader is on their own list too) is no clash
        const handled = new Set<string>();
        for (const name of [guild.leader, ...listed]) {
            if (!name) continue;
            const key = String(name).toLowerCase();
            if (handled.has(key)) continue;
            handled.add(key);
            if (seen.has(key)) {
                log.warn(`Guild ${guild.id}: ${name} is already in a guild, skipped`);
                continue;
            }
            seen.add(key);
            const rank = key === String(guild.leader).toLowerCase() ? 0 : lowest;
            statements.push({
                sql: "INSERT INTO guild_members (username, guild_id, rank_index, public_note, officer_note) VALUES (?, ?, ?, '', '')",
                values: [name, guild.id, rank],
            });
        }
        await runAll(statements);
        migrated++;
    }
    return migrated;
}
