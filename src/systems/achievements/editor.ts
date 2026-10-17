/**
 * Achievement editor: what the admin achievement editor window (/achievements) asks for, built as the gathering
 * editor is (systems/gathering/editor.ts). Every field of a save is checked here, written to the achievements table
 * and then to the cache the counting reads (store.ts), and answered with every achievement as it then stands. The
 * pick lists (creatures, quests, items, mounts, maps, spells, icons) come from caches, given by index.ts.
 */
import log from "../../modules/logger";
import permissions from "../permissions";
import * as store from "./store";
import {
  CRITERIA, CRITERION_TYPES, ID_TARGETS, LIMITS, isCriterion,
  type AchievementDef, type AchievementInput, type CriterionType, type PickList, type TargetRule,
} from "./types";

export const EDITOR_PERMISSIONS = ["tools.achievement_editor", "tools.*", "server.admin", "server.*"];
export const DENIED = "You don't have permission to use the achievement editor.";

// -------------------------------------------------------------- permission

/** Admins, and anyone holding the editor's permission: the stored permissions, asked on every packet. */
export async function canUseEditor(admin: any): Promise<boolean> {
  if (!admin?.username || admin.isGuest) return false;
  if (admin.isAdmin) return true;
  const held = String((await permissions.get(admin.username)) || "").split(",").map((p) => p.trim()).filter(Boolean);
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

/** Whether a player could have the editor open, from the permissions copied at login: who is told to reload. */
export function mayHaveEditorOpen(player: any): boolean {
  if (player?.isAdmin) return true;
  const held: string[] = Array.isArray(player?.permissions) ? player.permissions : [];
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

// ------------------------------------------------------------------ checks

/** One entry of a pick list: `value` is what is stored (an id as text, or a name). */
export interface Option {
  value: string;
  label: string;
  image?: string | null;
}

export type EditorOptions = Record<PickList, Option[]> & { icons: Option[] };

/** What the server knows of the world, given by index.ts. */
export interface EditorWorld {
  options(): Promise<EditorOptions>;
}

export interface EditorData {
  achievements: AchievementDef[];
  criteria: Array<{ type: CriterionType; label: string; target: TargetRule; pick: PickList | null }>;
  options: EditorOptions;
  limits: typeof LIMITS;
  /** The tables are there: changes can be saved. */
  ready: boolean;
}

export type ReadResult = { ok: true; achievement: AchievementInput } | { ok: false; errors: string[]; fields: Record<string, string> };

const PICK_NOUN: Record<PickList, string> = { creatures: "creature", quests: "quest", items: "item", mounts: "mount", maps: "map", spells: "spell" };
const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** The achievement an editor sent, or which fields are wrong. `others`: every other achievement (for the name). */
export function readAchievement(raw: any, options: EditorOptions, others: AchievementDef[]): ReadResult {
  const fields: Record<string, string> = {};

  const name = String(raw?.name ?? "").trim();
  if (!name) fields["name"] = "Enter a name.";
  else if (name.length > LIMITS.nameMax) fields["name"] = `A name is ${LIMITS.nameMax} characters at most.`;
  else if (others.some((def) => lower(def.name) === lower(name))) fields["name"] = `Another achievement is called ${name}.`;

  const description = String(raw?.description ?? "").trim();
  if (description.length > LIMITS.descriptionMax) fields["description"] = `A description is ${LIMITS.descriptionMax} characters at most.`;

  const iconText = String(raw?.icon ?? "").trim();
  if (iconText.length > LIMITS.iconMax) fields["icon"] = `An icon name is ${LIMITS.iconMax} characters at most.`;
  const icon = iconText || null;

  const type: CriterionType | null = isCriterion(raw?.type) ? raw.type : null;
  let target: string | null = null;
  if (!type) fields["type"] = "Pick what counts.";
  else {
    const rule = CRITERIA[type];
    const wanted = String(raw?.target ?? "").trim();
    if (rule.target !== "none" && rule.pick) {
      if (!wanted) {
        if (rule.target === "required") fields["target"] = `Pick the ${PICK_NOUN[rule.pick]}.`;
      } else {
        const found = options[rule.pick].find((option) =>
          ID_TARGETS.has(type) ? Number(option.value) === Number(wanted) : lower(option.value) === lower(wanted));
        if (found) target = found.value;
        else fields["target"] = `There is no ${PICK_NOUN[rule.pick]} ${wanted}.`;
      }
    }
  }

  const whole = (key: string, max: number, label: string): number => {
    const given = raw?.[key];
    const value = Number(given);
    if (given === null || given === undefined || given === "" || !Number.isInteger(value) || value < 1 || value > max) {
      fields[key] = `${label} must be a whole number from 1 to ${max}.`;
      return 1;
    }
    return value;
  };
  const count = whole("count", LIMITS.countMax, type === "level" ? "Level" : "How many");

  const wantedItem = String(raw?.reward_item ?? "").trim();
  let reward_item: string | null = null;
  if (wantedItem) {
    reward_item = options.items.find((option) => lower(option.value) === lower(wantedItem))?.value ?? null;
    if (!reward_item) fields["reward_item"] = `There is no item called ${wantedItem}.`;
  }
  const reward_quantity = reward_item || wantedItem ? whole("reward_quantity", LIMITS.quantityMax, "Quantity") : 1;

  const wantedMount = String(raw?.reward_mount ?? "").trim();
  let reward_mount: string | null = null;
  if (wantedMount) {
    reward_mount = options.mounts.find((option) => lower(option.value) === lower(wantedMount))?.value ?? null;
    if (!reward_mount) fields["reward_mount"] = `There is no mount called ${wantedMount}.`;
  }

  const wrong = Object.keys(fields).length;
  if (wrong > 0 || !type) return { ok: false, errors: [wrong === 1 ? "1 field needs fixing." : `${wrong} fields need fixing.`], fields };
  return {
    ok: true,
    achievement: { name, description, icon, type, target, count, reward_item, reward_quantity, reward_mount, enabled: raw?.enabled !== false },
  };
}

// ------------------------------------------------------------------ editor

export async function buildEditorData(world: EditorWorld): Promise<EditorData> {
  return {
    achievements: await store.definitions(),
    criteria: CRITERION_TYPES.map((type) => ({ type, label: CRITERIA[type].label, target: CRITERIA[type].target, pick: CRITERIA[type].pick })),
    options: await world.options(),
    limits: LIMITS,
    ready: store.isReady(),
  };
}

export type EditorAnswer =
  | { kind: "data"; data: EditorData }
  | {
    kind: "result"; ok: boolean; errors: string[]; fields?: Record<string, string>; id: number | null; notes: string[];
    denied?: boolean; data: EditorData | null;
    /** The achievements changed: the other open editors are told. */
    changed?: boolean;
  };

/** One packet of the editor, after its permission is checked. */
export async function handleEditorPacket(admin: any, type: string, data: any, world: EditorWorld): Promise<EditorAnswer> {
  if (!(await canUseEditor(admin))) return { kind: "result", ok: false, errors: [DENIED], notes: [], id: null, denied: true, data: null };
  if (type === "ACHIEVEMENT_EDITOR_LIST") return { kind: "data", data: await buildEditorData(world) };

  const rawId = data?.id;
  const id = rawId === null || rawId === undefined || rawId === "" ? null : Number(rawId);
  const refused = async (errors: string[], fields?: Record<string, string>): Promise<EditorAnswer> =>
    ({ kind: "result", ok: false, errors, fields, notes: [], id, data: await buildEditorData(world) });
  if (id !== null && !Number.isInteger(id)) return refused(["That achievement does not exist."]);
  const all = await store.definitions();
  const existing = id === null ? null : all.find((def) => def.id === id) ?? null;
  if (id !== null && !existing) return refused(["That achievement does not exist any more."]);
  if (!store.isReady()) return refused(["Achievements cannot be changed: the achievement tables are missing. The server log says why."]);

  if (type === "ACHIEVEMENT_EDITOR_SAVE") {
    const read = readAchievement(data, await world.options(), all.filter((def) => def.id !== id));
    if (!read.ok) return refused(read.errors, read.fields);
    const saved = await store.saveDefinition(id, read.achievement);
    if (!saved.ok) return refused([saved.message]);
    log.info(`[Achievements] ${admin.username} saved achievement ${saved.def.id} (${saved.def.name}).`);
    const notes = saved.reset
      ? ["Players who earned it keep it. Progress made toward it so far is started again."]
      : existing !== null && existing.count !== saved.def.count
        ? ["Players who earned it keep it. Progress made so far is kept and compared with the new count."]
        : [];
    return { kind: "result", ok: true, errors: [], notes, id: saved.def.id, data: await buildEditorData(world), changed: true };
  }

  if (type === "ACHIEVEMENT_EDITOR_DELETE") {
    if (!existing) return refused(["Pick an achievement."]);
    const done = await store.deleteDefinition(existing.id);
    if (!done.ok) return refused([done.message]);
    log.info(`[Achievements] ${admin.username} deleted achievement ${existing.id} (${existing.name}).`);
    return { kind: "result", ok: true, errors: [], notes: [], id: existing.id, data: await buildEditorData(world), changed: true };
  }

  return refused([`Unknown request ${type}.`]);
}
