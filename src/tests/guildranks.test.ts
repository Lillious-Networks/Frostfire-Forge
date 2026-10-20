import { describe, expect, test } from "bun:test";
import {
  ALL_PERMISSIONS, DEFAULT_RANKS, GUILD_CHAT, GuildPermission, MAX_MOTD, MAX_NOTE,
  cleanText, demotedRank, hasPermission, lowestRank, outranks, promotedRank, rankPermissions, refusalText, validRankName,
} from "../systems/guildranks";

describe("default ranks", () => {
  test("are the five WoW ranks, contiguous from 0", () => {
    expect(DEFAULT_RANKS.map((rank) => rank.name)).toEqual(["Guild Master", "Officer", "Veteran", "Member", "Initiate"]);
    expect(DEFAULT_RANKS.map((rank) => rank.index)).toEqual([0, 1, 2, 3, 4]);
  });
  test("give the permissions the spec names", () => {
    expect(DEFAULT_RANKS[0].permissions).toBe(ALL_PERMISSIONS);
    expect(DEFAULT_RANKS[1].permissions).toBe(ALL_PERMISSIONS);
    expect(DEFAULT_RANKS[2].permissions).toBe(GUILD_CHAT | GuildPermission.INVITE);
    expect(DEFAULT_RANKS[3].permissions).toBe(GUILD_CHAT);
    expect(DEFAULT_RANKS[4].permissions).toBe(GUILD_CHAT);
  });
});

describe("permissions", () => {
  const ranks = [{ index: 0, name: "GM", permissions: 0 }, { index: 1, name: "Grunt", permissions: GuildPermission.INVITE }];
  test("rank 0 has every bit whatever is stored", () => {
    expect(rankPermissions(ranks, 0)).toBe(ALL_PERMISSIONS);
    expect(hasPermission(ranks, 0, GuildPermission.KICK)).toBe(true);
  });
  test("other ranks have what is stored, an unknown rank nothing", () => {
    expect(hasPermission(ranks, 1, GuildPermission.INVITE)).toBe(true);
    expect(hasPermission(ranks, 1, GuildPermission.KICK)).toBe(false);
    expect(rankPermissions(ranks, 7)).toBe(0);
  });
});

describe("hierarchy", () => {
  test("only a higher rank (lower index) outranks", () => {
    expect(outranks(1, 2)).toBe(true);
    expect(outranks(2, 2)).toBe(false);
    expect(outranks(3, 2)).toBe(false);
  });
  test("promote stops one rank below the actor and never reaches rank 0", () => {
    expect(promotedRank(1, 3)).toBe(2);
    expect(promotedRank(1, 2)).toBeNull();
    expect(promotedRank(0, 1)).toBeNull();
    expect(promotedRank(0, 2)).toBe(1);
  });
  test("demote stops at the lowest rank", () => {
    expect(lowestRank(DEFAULT_RANKS)).toBe(4);
    expect(demotedRank(DEFAULT_RANKS, 3)).toBe(4);
    expect(demotedRank(DEFAULT_RANKS, 4)).toBeNull();
  });
});

describe("text", () => {
  test("rank names are 1 to 20 letters and spaces, trimmed", () => {
    expect(validRankName("  Raider ")).toBe("Raider");
    expect(validRankName("")).toBeNull();
    expect(validRankName("x".repeat(21))).toBeNull();
    expect(validRankName("Rank 2")).toBeNull();
    expect(validRankName(42)).toBeNull();
  });
  test("notes and MOTD are trimmed, may be empty, refused over the cap", () => {
    expect(cleanText("  hi  ", MAX_NOTE)).toBe("hi");
    expect(cleanText("", MAX_NOTE)).toBe("");
    expect(cleanText("x".repeat(32), MAX_NOTE)).toBeNull();
    expect(cleanText(null, MAX_NOTE)).toBeNull();
  });
  test("notes and MOTD refuse a swear only as a whole word, in any case", () => {
    expect(cleanText("Hello everyone", MAX_MOTD)).toBe("Hello everyone");
    expect(cleanText("classic raid tonight", MAX_MOTD)).toBe("classic raid tonight");
    expect(cleanText("pass the boss, assist the tank", MAX_MOTD)).toBe("pass the boss, assist the tank");
    expect(cleanText("scrap", MAX_NOTE)).toBe("scrap");
    expect(cleanText("what the shit", MAX_MOTD)).toBeNull();
    expect(cleanText("SHIT!", MAX_NOTE)).toBeNull();
  });
  test("rank names still refuse a swear inside a word", () => {
    expect(validRankName("Classic")).toBeNull();
  });
  test("every refusal has a line of text", () => {
    for (const text of Object.values(refusalText)) expect(text.length).toBeGreaterThan(0);
  });
});
