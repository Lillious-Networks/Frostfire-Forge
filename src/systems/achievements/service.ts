// The rules of achievements without the network around them: what an event adds to whose progress, and what happens
// when an achievement is reached. A player's progress changes in their turn (store.inTurn), so two events that come
// together are counted one after the other and an achievement is earned once. Earning one is one batch
// (services/batch): the row with its date, the reward item in the bags (or in the mail when they are full) and the
// mount, all kept or none. index.ts gives it the real dependencies; the tests give it their own.
import { deliverToPlayer } from "../../cluster/deliver";
import log from "../../modules/logger";
import { atomically } from "../../services/batch";
import playerCache from "../../services/playermanager";
import { packetManager } from "../../socket/packet_manager";
import collectables from "../collectables";
import inventory from "../inventory";
import mail from "../mail";
import { deedsOf, matches, progressAfter } from "./criteria";
import * as store from "./store";
import type { AchievementDef, AchievementView, Deed, PlayerAchievement } from "./types";

/** The sender shown on a reward that did not fit in the bags. It has a space, so no account can have the name (the Gateway allows letters, digits and underscores only). */
export const MAIL_SENDER = "Achievement Rewards";

export interface ServiceDeps {
  /** Whether one more of `item` fits in the player's bags (systems/vendors.ts hasRoomFor). */
  hasRoomFor(username: string, item: string): Promise<boolean>;
  /** The usernames of the player's party and guild: who hears "<name> earned <achievement>." */
  circleOf(username: string): Promise<{ party: string[]; guild: string[] }>;
  /** After a reward: the online player's client is sent their bags, collectables or mail count again. */
  refresh(player: any, what: { inventory: boolean; collectables: boolean; mail: boolean }): Promise<void>;
  /** Every item name, lower case to as written. */
  items(): Promise<Map<string, string>>;
  /** Every mount name, lower case to as written. */
  mounts(): Promise<Map<string, string>>;
  /** The asset server URL of an icon name. */
  iconUrl(icon: string | null): string | null;
  now?(): number;
}

/** What earning an achievement gave. */
export interface Earned {
  at: number;
  item: string | null;
  quantity: number;
  mount: string | null;
  /** The item did not fit in the bags and was mailed. */
  mailed: boolean;
}

const lower = (name: unknown) => String(name ?? "").toLowerCase();
/** A name as players read it. */
const named = (username: string) => username.charAt(0).toUpperCase() + username.slice(1);

function send(wt: any, packets: any[]): void {
  if (!wt || !wt.send || wt.readyState !== 1) return;
  try {
    for (const p of packets) wt.send(p);
  } catch {
    // Connection closing.
  }
}

export class AchievementService {
  constructor(private readonly deps: ServiceDeps) {}

  /** An event the achievements count: each deed it stands for, in turn. Never throws. */
  async onEvent(event: string, payload: any): Promise<void> {
    let deeds: Deed[];
    try {
      deeds = deedsOf(event, payload);
    } catch (error) {
      log.error(`[Achievements] ${event} could not be read: ${error}`);
      return;
    }
    for (const deed of deeds) {
      try {
        await this.record(deed);
      } catch (error) {
        log.error(`[Achievements] ${deed.type} of ${deed.username} could not be counted: ${error}`);
      }
    }
  }

  /** One deed: added to the progress of every enabled achievement it counts toward that the player has not earned. */
  async record(deed: Deed): Promise<void> {
    if (!store.isReady()) return;
    // a guest account is temporary: nothing is counted for it
    if (playerCache.getByUsername(deed.username)?.isGuest) return;
    // Most deeds count toward nothing: they do not wait for the player's turn, and no rows are read or copied.
    if (!(await store.definitionsOfType(deed.type)).some((def) => matches(def, deed))) return;
    const earned: Array<{ def: AchievementDef; done: Earned }> = [];
    await store.inTurn(deed.username, async () => {
      // Looked at again in the turn: an achievement deleted, switched off or changed while this waited for it is not
      // counted, and leaves no row for the player behind.
      if (!(await store.definitionsOfType(deed.type)).some((def) => matches(def, deed))) return;
      const rows = await store.rowsOf(deed.username);
      // and once more after the rows are read, which may have waited for the database
      const counted = (await store.definitionsOfType(deed.type)).filter((def) => matches(def, deed));
      let changed = false;
      let failed = false;
      for (const def of counted) {
        let row = rows.find((held) => held.achievement_id === def.id);
        if (row && row.completed_at !== null) continue;
        if (!row) {
          const fresh: PlayerAchievement = { achievement_id: def.id, progress: 0, completed_at: null };
          rows.push(fresh);
          row = fresh;
        }
        const next = progressAfter(def, row.progress, deed);
        if (next === row.progress && next < def.count) continue;
        changed = true;
        row.progress = next;
        if (next < def.count) {
          store.markChanged(deed.username, def.id, next);
          continue;
        }
        const done = await this.complete(deed.username, def, next);
        if (done) {
          row.completed_at = done.at;
          store.clearChanged(deed.username, def.id);
          earned.push({ def, done });
        } else {
          // Nothing was reported given, but the write may have been made (one that timed out, say): the rows held
          // are forgotten, so the next read asks the database. One short, so the next deed of its kind tries again
          // (and finds it earned already if it was written).
          failed = true;
          store.markChanged(deed.username, def.id, def.count - 1);
        }
      }
      if (failed) await store.forgetRows(deed.username);
      else if (changed) await store.holdRows(deed.username, rows);
    });
    for (const { def, done } of earned) await this.announce(deed.username, def, done);
  }

  /** Earns `def` for the player as one batch. What it gave, or null when nothing was kept (logged). */
  private async complete(username: string, def: AchievementDef, progress: number): Promise<Earned | null> {
    const at = (this.deps.now ?? Date.now)();
    try {
      const item = def.reward_item ? ((await this.deps.items()).get(lower(def.reward_item)) ?? null) : null;
      if (def.reward_item && !item) log.warn(`[Achievements] ${def.name} gives ${def.reward_item}, which is not an item any more: it is not given.`);
      const mount = def.reward_mount ? ((await this.deps.mounts()).get(lower(def.reward_mount)) ?? null) : null;
      if (def.reward_mount && !mount) log.warn(`[Achievements] ${def.name} gives the mount ${def.reward_mount}, which does not exist any more: it is not given.`);
      const quantity = Math.max(1, Math.floor(Number(def.reward_quantity)) || 1);
      // Room is looked at before the batch, as a vendor does.
      const mailed = item !== null && !(await this.deps.hasRoomFor(username, item));
      await atomically([username], async (batch) => {
        for (const statement of store.completionStatements(username, def.id, progress, at)) batch.add(statement);
        if (item && !mailed && !(await inventory.add(username, { name: item, quantity }, batch))) {
          throw new Error(`${item} could not be added to the bags`);
        }
        if (item && mailed) {
          await mail.deliverIn(batch, username, {
            sender: MAIL_SENDER,
            subject: `Achievement: ${def.name}`,
            body: `You earned ${def.name}. Your bags were full, so your reward is attached.`,
            items: [{ name: item, quantity }],
          }, at);
        }
        if (mount) await collectables.add({ type: "mount", item: mount, username, icon: null }, batch);
      });
      log.info(`[Achievements] ${username} earned ${def.name}.`);
      return { at, item, quantity, mount, mailed };
    } catch (error) {
      log.error(`[Achievements] ${def.name} could not be given to ${username}: ${error}`);
      return null;
    }
  }

  /** The popup and the reward's refresh for the earner when online, then the line to their party and guild. */
  private async announce(username: string, def: AchievementDef, done: Earned): Promise<void> {
    const online = playerCache.getByUsername(username);
    if (online?.wt) {
      send(online.wt, packetManager.achievementEarned({
        id: def.id, name: def.name, description: def.description, icon: this.deps.iconUrl(def.icon),
        rewardItem: done.item, rewardQuantity: done.item ? done.quantity : 0, rewardMount: done.mount, mailed: done.mailed,
      }));
      try {
        await this.deps.refresh(online, { inventory: !!done.item && !done.mailed, collectables: !!done.mount, mail: done.mailed });
      } catch (error) {
        log.error(`[Achievements] The windows of ${username} could not be brought up to date after ${def.name}: ${error}`);
      }
    }
    await this.tellCircle(String(online?.username ?? username), def);
  }

  /**
   * "<name> has completed [<achievement>]" as a line from the game, to who is online: in party chat to the party,
   * and in guild chat to the guild members who are not in the party (no one is told twice). The line carries the
   * achievement's id so the client can make its name a link to the reader's own achievements window.
   */
  private async tellCircle(username: string, def: AchievementDef): Promise<void> {
    let circle: { party: string[]; guild: string[] };
    try {
      circle = await this.deps.circleOf(username);
    } catch (error) {
      log.error(`[Achievements] The party and guild of ${username} could not be told: ${error}`);
      return;
    }
    const who = named(username);
    const line = { id: null, username: "", system: true, message: `${who} has completed [${def.name}]`, who, achievementId: def.id, achievement: def.name };
    const told = new Set<string>();
    // Wherever each member is online: on this node or, in a cluster, another.
    const tell = async (members: string[], packets: any[]) => {
      for (const member of members.map(lower)) {
        if (told.has(member)) continue;
        told.add(member);
        await deliverToPlayer(member, packets);
      }
    };
    if (circle.party.length > 0) await tell(circle.party, packetManager.partyChat(line));
    if (circle.guild.length > 0) await tell(circle.guild, packetManager.guildChat(line));
  }

  /** Every enabled achievement with the player's progress and when they earned it: what their window shows. */
  async listFor(username: string, guest = false): Promise<AchievementView[]> {
    const rows = guest ? [] : await store.rowsOf(username);
    return (await store.definitions())
      .filter((def) => def.enabled)
      .map((def) => {
        const row = rows.find((held) => held.achievement_id === def.id);
        return {
          id: def.id, name: def.name, description: def.description, icon: this.deps.iconUrl(def.icon),
          type: def.type, count: def.count, progress: Math.min(row?.progress ?? 0, def.count), completedAt: row?.completed_at ?? null,
          rewardItem: def.reward_item, rewardQuantity: def.reward_item ? def.reward_quantity : 0, rewardMount: def.reward_mount,
        };
      });
  }
}
