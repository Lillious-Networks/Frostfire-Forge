// Achievements wired to the engine: the events they count (criteria.ts) handed to the service, progress written on
// the save tick and when a player leaves, the list a player's window asks for, and the client brought up to date
// after a reward through the receiver (setBridge). See types.ts for the request.
import log from "../../modules/logger";
import { getIconUrl } from "../../modules/spriteSheetManager";
import assetCache from "../../services/assetCache";
import playerCache from "../../services/playermanager";
import { packetManager } from "../../socket/packet_manager";
import { Events, listener } from "../events";
import guilds from "../guild";
import parties from "../parties";
import player from "../player";
import { getCachedQuestsSync } from "../quests/definitions";
import { hasRoomFor } from "../vendors";
import { COUNTED_EVENTS } from "./criteria";
import * as editor from "./editor";
import { AchievementService } from "./service";
import * as store from "./store";

/** What the receiver does for the achievements: an online player's bags, collectables and mail count sent again. */
export interface AchievementsBridge {
  syncInventory(target: any): Promise<void>;
  sendCollectables(target: any): Promise<void>;
  sendMailNotice(target: any): Promise<void>;
}

let bridge: AchievementsBridge | null = null;

/** Set once by socket/receiver.ts, which has the helpers that send a player's bags and collectables. */
export function setBridge(next: AchievementsBridge): void {
  bridge = next;
}

function send(wt: any, packets: any[]): void {
  if (!wt || !wt.send || wt.readyState !== 1) return;
  try {
    for (const p of packets) wt.send(p);
  } catch {
    // Connection closing.
  }
}

/** Every item or mount name in the asset cache, lower case to as written. */
async function namesOf(key: "items" | "mounts"): Promise<Map<string, string>> {
  const list = ((await assetCache.get(key)) || []) as any[];
  return new Map(list.filter((entry) => entry?.name).map((entry): [string, string] => [String(entry.name).toLowerCase(), String(entry.name)]));
}

/** The party and guild members of a player, from the caches the party and guild systems keep. */
async function circleOf(username: string): Promise<{ party: string[]; guild: string[] }> {
  const partyId = Number(await player.getPartyIdByUsername(username)) || 0;
  const party = partyId ? await parties.getPartyMembers(partyId) : [];
  const guildId = Number(playerCache.getByUsername(username)?.guild_id) || 0;
  const guild = guildId ? await guilds.getGuildMembers(guildId) : [];
  return { party, guild };
}

export const service = new AchievementService({
  hasRoomFor,
  circleOf,
  refresh: async (target, what) => {
    if (!bridge) return;
    if (what.inventory) await bridge.syncInventory(target);
    if (what.collectables) await bridge.sendCollectables(target);
    if (what.mail) await bridge.sendMailNotice(target);
  },
  items: () => namesOf("items"),
  mounts: () => namesOf("mounts"),
  iconUrl: getIconUrl,
});

/** The save tick (onSave, 60 s): every player's changed progress is written. */
export async function onSave(): Promise<void> {
  try {
    await store.flushAll();
  } catch (error) {
    log.error(`[Achievements] Saving progress failed: ${error}`);
  }
}

/** A player logged out or disconnected: their changed progress is written. */
export async function onLeave(payload: any): Promise<void> {
  const username = payload?.player?.username;
  if (!username) return;
  try {
    await store.flush(String(username));
  } catch (error) {
    log.error(`[Achievements] Saving the progress of ${username} failed: ${error}`);
  }
}

/** A player's window asked for their achievements. */
export async function sendList(target: any): Promise<void> {
  if (!target?.wt || !target?.username) return;
  send(target.wt, packetManager.achievements({ achievements: await service.listFor(String(target.username), !!target.isGuest) }));
}

const handlers: Array<[string, (payload: any) => void]> = [];

/** Starts counting. Called once from socket/server.ts, after the creatures and gathering. */
export async function init(): Promise<void> {
  if (handlers.length > 0) return;
  for (const event of COUNTED_EVENTS) handlers.push([event, (payload: any) => void service.onEvent(event, payload)]);
  handlers.push(
    [Events.SAVE, () => void onSave()],
    [Events.PLAYER_LOGOUT, (payload: any) => void onLeave(payload)],
    [Events.PLAYER_DISCONNECT, (payload: any) => void onLeave(payload)],
  );
  for (const [event, handler] of handlers) listener.on(event, handler);
  if (store.isReady()) log.success(`Achievements started: ${(await store.definitions()).filter((def) => def.enabled).length} enabled`);
}

/** Stops counting: every listener init added is let go. For tests. */
export function stop(): void {
  for (const [event, handler] of handlers.splice(0)) listener.off(event, handler);
}

// ------------------------------------------------------------------ editor

const byLabel = (a: editor.Option, b: editor.Option) => a.label.localeCompare(b.label);

/** The editor's pick lists, from the caches: never the database on a request. */
async function editorOptions(): Promise<editor.EditorOptions> {
  const listed = async (key: string) => (((await assetCache.get(key)) || []) as any[]).filter(Boolean);
  const creatures = (await listed("creatureTemplates"))
    .filter((t) => t.id !== null && t.id !== undefined)
    .map((t) => ({ value: String(t.id), label: `${t.name ?? "Creature"} (#${t.id})` }))
    .sort(byLabel);
  const quests = getCachedQuestsSync().map((q) => ({ value: String(q.id), label: `${q.name} (#${q.id})` })).sort(byLabel);
  const items = (await listed("items")).filter((i) => i.name).map((i) => ({ value: String(i.name), label: String(i.name), image: getIconUrl(i.icon ?? null) })).sort(byLabel);
  const mounts = (await listed("mounts")).filter((m) => m.name).map((m) => ({ value: String(m.name), label: String(m.name), image: getIconUrl(m.icon ?? null) })).sort(byLabel);
  let mapNames = (await listed("mapProperties")).map((m) => String(m.name ?? "").replace(/\.json$/i, "")).filter(Boolean);
  if (mapNames.length === 0) mapNames = (await listed("maps")).map((m) => String(m.name ?? "").replace(/\.json$/i, "")).filter(Boolean);
  const maps = [...new Set(mapNames)].map((name) => ({ value: name, label: name })).sort(byLabel);
  const spells = (await listed("spells")).filter((s) => s.name).map((s) => ({ value: String(s.name), label: String(s.name) })).sort(byLabel);
  let icons: editor.Option[] = [];
  try {
    // the asset server's icon list, fetched once and kept (the creature and item editors use it too)
    const { listIcons } = await import("../creatures/editor");
    icons = (await listIcons()).map((icon) => ({ value: icon.name, label: icon.name, image: icon.image }));
  } catch (error) {
    log.warn(`[Achievements] The icons could not be listed for the editor: ${error}`);
  }
  return { creatures, quests, items, mounts, maps, spells, icons };
}

/** One editor packet: answered to the admin; a change tells the other open editors. */
export async function handleEditorPacket(admin: any, type: string, data: any): Promise<void> {
  const wt = admin?.wt;
  if (!wt) return;
  const answer = await editor.handleEditorPacket(admin, type, data, { options: editorOptions });
  if (answer.kind === "data") return send(wt, packetManager.achievementEditorData(answer.data));
  if (answer.denied) send(wt, packetManager.notify({ message: editor.DENIED }));
  send(wt, packetManager.achievementEditorResult({ ok: answer.ok, errors: answer.errors, fields: answer.fields, id: answer.id, notes: answer.notes, action: type, data: answer.data }));
  if (!answer.changed) return;
  const updated = packetManager.achievementEditorUpdated({ by: admin.username });
  for (const other of Object.values(playerCache.list()) as any[]) {
    if (other?.wt && other.id !== admin.id && editor.mayHaveEditorOpen(other)) send(other.wt, updated);
  }
}

export const canUseEditor = editor.canUseEditor;

export default { init, stop, setBridge, sendList, onSave, onLeave, service, handleEditorPacket, canUseEditor };
