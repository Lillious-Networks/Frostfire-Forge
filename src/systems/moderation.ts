// What the mute, ignore and report commands do and say. The receiver hands
// each one the player who asked and what they typed, and sends what comes
// back: nothing here touches a connection.

import playerCache from "../services/playermanager";
import { linesSeenBy } from "./chatgate";
import friends from "./friends";
import ignores, { IGNORE_LIMIT } from "./ignores";
import mutes, { parseDuration } from "./mutes";
import player from "./player";
import reports, { REPORT_CATEGORIES, type Place, type RefusedReport, type Report, type ReportCategory } from "./reports";

const NO_PERMISSION = "You don't have permission to use this command";
const NOT_FOUND = "Player not found";

/** How many open reports /reports lists. */
const LISTED = 10;

const lower = (username: unknown) => String(username ?? "").toLowerCase();
const shown = (username: string) => username.charAt(0).toUpperCase() + username.slice(1);

/** Whether a player holds `permission`, or every admin permission. */
export const can = (actor: any, permission: string): boolean =>
  !!actor?.permissions?.some((held: string) => held === permission || held === "admin.*");

/** The name an account has, for a name typed in any case. Null when there is no such account. */
async function accountName(username: unknown): Promise<string | null> {
  const account = (await player.findByUsername(lower(username))) as { username: string }[] | undefined;
  return account?.[0]?.username ? lower(account[0].username) : null;
}

/** Where an online player is. */
function placeOf(online: any): Place {
  const position = online?.location?.position;
  if (!online?.location?.map || !position) return null;
  return { map: String(online.location.map).replaceAll(".json", ""), x: Math.round(Number(position.x) || 0), y: Math.round(Number(position.y) || 0) };
}

/** How long ago `then` was, in the largest unit that fits. */
export function ago(then: number, now = Date.now()): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

// ------------------------------------------------------------------- mute

/** /mute <username> [duration] [reason]. The answer is for the one who asked: the muted player is told nothing. */
export async function muteCommand(actor: any, args: string[], now = Date.now()): Promise<string> {
  if (!can(actor, "admin.mute")) return NO_PERMISSION;
  if (!args[0]) return "Usage: /mute <username> [duration] [reason]";
  const target = await accountName(args[0]);
  if (!target) return NOT_FOUND;
  if (target === lower(actor.username)) return "You cannot mute yourself";
  if (await player.isAdmin(target)) return "You cannot mute other admins";

  // A second word that is not a duration is the start of the reason, unless it is the word that
  // says there is none: with it, a reason may begin with what would read as one.
  const duration = parseDuration(args[1]);
  const reason = args.slice(duration === null && lower(args[1]) !== "permanent" ? 1 : 2).join(" ");
  await mutes.mute(target, actor.username, duration, reason, now);
  return duration === null ? `Muted ${shown(target)} until they are unmuted` : `Muted ${shown(target)} for ${args[1].toLowerCase()}`;
}

/** /unmute <username>. */
export async function unmuteCommand(actor: any, args: string[], now = Date.now()): Promise<string> {
  if (!can(actor, "admin.unmute")) return NO_PERMISSION;
  if (!args[0]) return "Usage: /unmute <username>";
  const target = await accountName(args[0]);
  if (!target) return NOT_FOUND;
  return (await mutes.unmute(target, now)) ? `Unmuted ${shown(target)}` : `${shown(target)} is not muted`;
}

// ----------------------------------------------------------------- ignore

export interface IgnoreAnswer {
  message: string;
  /** The list changed: the names the player now ignores, for their client. */
  ignored?: string[];
  /** They were friends until now: who the other player was, and each one's list as it now stands. */
  unfriended?: { target: string; mine: string[]; theirs: string[] };
}

/**
 * /ignore <username>. The player ignored is told nothing. A friendship
 * between the two ends on both sides: a friend is shown when the other is
 * online, which is not for someone they ignore to see.
 */
export async function ignore(actor: any, name: unknown): Promise<IgnoreAnswer> {
  if (!String(name ?? "").trim()) return { message: "Usage: /ignore <username>" };
  const me = lower(actor.username);
  const result = await ignores.add(me, String(name));
  if (result === "unknown") return { message: NOT_FOUND };
  if (result === "self") return { message: "You cannot ignore yourself" };
  if (result === "staff") return { message: "Admins cannot ignore players" };
  if (result === "admin") return { message: "You cannot ignore an admin" };
  if (result === "full") return { message: `Your ignore list is full (${IGNORE_LIMIT} players)` };

  const target = (await accountName(name)) as string;
  if (result === "already") return { message: `You are already ignoring ${shown(target)}` };

  const answer: IgnoreAnswer = { message: `You are now ignoring ${shown(target)}`, ignored: await ignores.list(me) };
  const [mine, theirs] = [await friends.list(me), await friends.list(target)];
  if (mine.map(lower).includes(target) || theirs.map(lower).includes(me)) {
    answer.unfriended = { target, mine: await friends.remove(me, target), theirs: await friends.remove(target, me) };
  }
  return answer;
}

/** /unignore <username>. */
export async function unignore(actor: any, name: unknown): Promise<IgnoreAnswer> {
  if (!String(name ?? "").trim()) return { message: "Usage: /unignore <username>" };
  const me = lower(actor.username);
  const target = lower(name);
  if (!(await ignores.remove(me, target))) return { message: `You are not ignoring ${shown(target)}` };
  return { message: `You are no longer ignoring ${shown(target)}`, ignored: await ignores.list(me) };
}

/** /ignorelist. */
export async function ignoreList(actor: any): Promise<string> {
  const names = await ignores.list(actor.username);
  return names.length === 0 ? "You are not ignoring anyone" : `You are ignoring: ${names.map(shown).join(", ")}`;
}

// ----------------------------------------------------------------- report

const REFUSED: Record<RefusedReport, string> = {
  self: "You cannot report yourself",
  category: "Choose a reason for the report",
  duplicate: "You have already reported this player",
  limit: "You have sent too many reports. Try again later",
};

/** What each category is called where it is shown. */
export const CATEGORY_LABELS: Record<ReportCategory, string> = {
  harassment: "Harassment",
  spam: "Spam",
  cheating: "Cheating",
  name: "Offensive name",
  other: "Other",
};

/**
 * Files a report from `actor` on the player named. The lines attached are the
 * reported player's latest that reached the reporter. `report` is there when
 * one was filed, for the staff to be told of.
 */
export async function report(actor: any, name: unknown, category: unknown, details: unknown, now = Date.now()): Promise<{ message: string; report?: Report }> {
  if (!lower(name).trim()) return { message: "Usage: /report <username> <reason>" };
  const target = await accountName(name);
  if (!target) return { message: NOT_FOUND };
  const filed = await reports.file({
    reporter: actor.username,
    target,
    category: REPORT_CATEGORIES.includes(category as ReportCategory) ? (category as string) : "",
    details: typeof details === "string" ? details : null,
    lines: linesSeenBy(target, actor.username),
    reporterAt: placeOf(actor),
    targetAt: placeOf(playerCache.getByUsername(target)),
  }, now);
  if (!filed.ok) return { message: REFUSED[filed.code] };
  return { message: "Thank you. Your report was sent", report: filed.report };
}

/** What the staff online are told when a report comes in. */
export const staffNotice = (filed: Report): string =>
  `New report #${filed.id}: ${shown(filed.reporter)} reported ${shown(filed.target)} (${CATEGORY_LABELS[filed.category]}). /reports view ${filed.id}`;

const oneLine = (filed: Report, now: number): string =>
  `#${filed.id} ${shown(filed.target)} (${CATEGORY_LABELS[filed.category]}) by ${shown(filed.reporter)}, ${ago(filed.created_at, now)}`;

/** /reports, /reports view <id>, /reports resolve <id> [note]. */
export async function reportsCommand(actor: any, args: string[], now = Date.now()): Promise<string> {
  if (!can(actor, "admin.reports")) return NO_PERMISSION;
  const mode = (args[0] || "list").toLowerCase();

  if (mode === "list") {
    const open = await reports.open();
    if (open.length === 0) return "There are no open reports";
    const more = open.length > LISTED ? [`...and ${open.length - LISTED} more in the control panel`] : [];
    return [`Open reports: ${open.length}`, ...open.slice(0, LISTED).map((filed) => oneLine(filed, now)), ...more].join("\n");
  }

  const id = Number(args[1]);
  if ((mode !== "view" && mode !== "resolve") || !Number.isInteger(id) || id <= 0) {
    return "Usage: /reports, /reports view <number>, /reports resolve <number> [note]";
  }

  if (mode === "resolve") {
    const resolved = await reports.resolve(id, actor.username, args.slice(2).join(" ") || null, now);
    return resolved ? `Report #${id} resolved` : "No open report has that number";
  }

  const filed = await reports.get(id);
  if (!filed) return "No report has that number";
  const where = filed.target_map ? `${shown(filed.target)} was at ${filed.target_map} (${filed.target_x}, ${filed.target_y})` : `${shown(filed.target)} was offline`;
  const others = await reports.openAgainst(filed.target);
  return [
    oneLine(filed, now) + (filed.status === "resolved" ? `, resolved by ${shown(filed.resolved_by ?? "")}` : ""),
    ...(filed.details ? [`"${filed.details}"`] : []),
    where,
    ...filed.chat_log.map((line) => `[${line.channel}] ${line.text}`),
    `Open reports naming ${shown(filed.target)}: ${others}`,
  ].join("\n");
}
