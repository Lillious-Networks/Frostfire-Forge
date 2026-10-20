import swears from "../utility/swears.json";

/** What a guild rank allows, one bit each, stored in guild_ranks.permissions. */
export const GuildPermission = {
    GUILD_CHAT_LISTEN: 1 << 0,
    GUILD_CHAT_SPEAK: 1 << 1,
    OFFICER_CHAT_LISTEN: 1 << 2,
    OFFICER_CHAT_SPEAK: 1 << 3,
    INVITE: 1 << 4,
    KICK: 1 << 5,
    PROMOTE: 1 << 6,
    DEMOTE: 1 << 7,
    SET_MOTD: 1 << 8,
    EDIT_PUBLIC_NOTE: 1 << 9,
    VIEW_OFFICER_NOTE: 1 << 10,
    EDIT_OFFICER_NOTE: 1 << 11,
} as const;
export type GuildPermissionName = keyof typeof GuildPermission;

export const ALL_PERMISSIONS = (1 << 12) - 1;
export const GUILD_CHAT = GuildPermission.GUILD_CHAT_LISTEN | GuildPermission.GUILD_CHAT_SPEAK;
export const MIN_RANKS = 2;
export const MAX_RANKS = 8;
export const MAX_RANK_NAME = 20;
export const MAX_MOTD = 128;
export const MAX_NOTE = 31;
export const MAX_MEMBERS = 1000;

export type GuildRank = { index: number; name: string; permissions: number };

/** A new guild's ranks, and an old guild's when the migration gives it ranks. */
export const DEFAULT_RANKS: GuildRank[] = [
    { index: 0, name: "Guild Master", permissions: ALL_PERMISSIONS },
    { index: 1, name: "Officer", permissions: ALL_PERMISSIONS },
    { index: 2, name: "Veteran", permissions: GUILD_CHAT | GuildPermission.INVITE },
    { index: 3, name: "Member", permissions: GUILD_CHAT },
    { index: 4, name: "Initiate", permissions: GUILD_CHAT },
];

/** What a rank added by the Guild Master starts with. */
export const NEW_RANK_PERMISSIONS = GUILD_CHAT;

/** Rank 0 has every bit, whatever is stored. A rank the guild does not have has none. */
export function rankPermissions(ranks: GuildRank[], index: number): number {
    if (index === 0) return ALL_PERMISSIONS;
    return ranks.find((rank) => rank.index === index)?.permissions ?? 0;
}

export function hasPermission(ranks: GuildRank[], index: number, permission: number): boolean {
    return (rankPermissions(ranks, index) & permission) === permission;
}

/** A lower index is a higher rank. */
export function outranks(actorRank: number, targetRank: number): boolean {
    return targetRank > actorRank;
}

export function lowestRank(ranks: GuildRank[]): number {
    return ranks.reduce((lowest, rank) => Math.max(lowest, rank.index), 0);
}

/** One rank up, never to the actor's own rank or above. Rank 0 is reached only by a leader transfer. */
export function promotedRank(actorRank: number, targetRank: number): number | null {
    const next = targetRank - 1;
    return next > actorRank ? next : null;
}

/** One rank down, not past the lowest. */
export function demotedRank(ranks: GuildRank[], targetRank: number): number | null {
    const next = targetRank + 1;
    return next <= lowestRank(ranks) ? next : null;
}

/** Anywhere in the text, inside a word too: for names, where "classic" is refused. */
export function containsSwear(text: string): boolean {
    const lower = text.toLowerCase();
    return swears.some((swear: { id: string }) => lower.includes(swear.id.toLowerCase()));
}

// Each swear as a whole word, built once.
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const swearWords = swears.map((swear: { id: string }) => new RegExp("(?<![a-z0-9])" + escaped(swear.id) + "(?![a-z0-9])", "i"));

/** Only as a whole word: for notes and MOTDs, where "hello everyone" and "classic raid" are fine. */
export function containsSwearWord(text: string): boolean {
    return swearWords.some((word) => word.test(text));
}

/** A rank name as stored: trimmed, 1 to 20 letters and spaces, no swears. Null when it is not one. */
export function validRankName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const name = value.trim();
    if (name.length === 0 || name.length > MAX_RANK_NAME) return null;
    if (!/^[A-Za-z ]+$/.test(name)) return null;
    if (containsSwear(name)) return null;
    return name;
}

/** A note or MOTD as stored: trimmed, at most `max` characters, no swear words. Empty clears it. Null when refused. */
export function cleanText(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (text.length > max) return null;
    if (text && containsSwearWord(text)) return null;
    return text;
}

export type GuildRefusal =
    | "not_in_guild" | "no_permission" | "not_member" | "not_below" | "self"
    | "promote_ceiling" | "demote_floor" | "bad_text" | "bad_name"
    | "max_ranks" | "min_ranks" | "rank_in_use" | "rank_zero" | "no_rank" | "failed";

/** `changed: false` is a save of what was already there: nothing was written, and nobody needs telling. */
export type GuildResult = { ok: true; changed?: false } | { ok: false; reason: GuildRefusal };

export const refusalText: Record<GuildRefusal, string> = {
    not_in_guild: "You are not in a guild",
    no_permission: "You do not have permission to do that.",
    not_member: "That player is not in your guild",
    not_below: "You can only do that to members below your rank.",
    self: "You cannot do that to yourself.",
    promote_ceiling: "You can only promote members up to one rank below yours.",
    demote_floor: "That member is already at the lowest rank.",
    bad_text: "That text is too long or not allowed.",
    bad_name: "Rank names are 1 to 20 letters and spaces.",
    max_ranks: "A guild can have at most 8 ranks.",
    min_ranks: "A guild needs at least 2 ranks.",
    rank_in_use: "Move every member out of that rank first.",
    rank_zero: "The Guild Master rank always has every permission.",
    no_rank: "That rank does not exist.",
    failed: "That did not work. Please try again.",
};
