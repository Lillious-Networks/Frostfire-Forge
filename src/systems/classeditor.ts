/**
 * Class editor: what the admin class editor window (/cle) asks for. USER REQUEST 2026-10-14 ("create a class editor
 * that can define certain base stats and learn certain spells at certain levels"). A class (systems/classes.ts) is
 * a name, a description, the stats a new character of it starts with, and the spells it learns, each at a level.
 * Each change is checked, written to the table and then to the list held, and answered with whether it was done and
 * every class as it then stands. Like the weather editor, it reads only what the server holds (the classes and the
 * spells), never the database.
 */
import log from "../modules/logger";
import assetCache from "../services/assetCache";
import { getSpriteUrl } from "../modules/spriteSheetManager";
import permissions from "./permissions";
import classes, { classesReady, STAT_COLUMNS, type CharacterClass, type ClassSpell } from "./classes";

/** The tool's own permission and the wildcards over it, as the other editors have theirs. */
export const EDITOR_PERMISSIONS = ["tools.class_editor", "tools.*", "server.admin", "server.*"];
export const DENIED = "You don't have permission to use the class editor.";

/** Column size of classes.name. */
export const NAME_MAX = 45;
export const DESCRIPTION_MAX = 500;
/** The most spells one class learns, and the highest level one can be learned at. */
export const SPELLS_MAX = 50, LEVEL_MAX = 1000;

/** Limits of a stat, as the editor is sent and held to them. */
export interface NumberRule { label: string; min: number; max: number; hint: string }
export const NUMBER_FIELDS: Record<(typeof STAT_COLUMNS)[number], NumberRule> = {
  max_health: { label: "Health", min: 1, max: 100000, hint: "The health a new character starts with, and its most at level 1." },
  max_stamina: { label: "Stamina", min: 0, max: 100000, hint: "The stamina a new character starts with, and its most at level 1." },
  stat_damage: { label: "Damage", min: 0, max: 10000, hint: "Added to the damage of every hit and every damaging spell." },
  stat_armor: { label: "Armor", min: 0, max: 10000, hint: "Takes away from the damage the character is dealt." },
  stat_critical_chance: { label: "Critical chance", min: 0, max: 100, hint: "Percent chance that a hit is critical." },
  stat_critical_damage: { label: "Critical damage", min: 0, max: 1000, hint: "Percent added to the damage of a critical hit." },
  stat_avoidance: { label: "Avoidance", min: 0, max: 100, hint: "Percent chance that a hit misses the character." },
};

const lower = (s: unknown): string => String(s ?? "").toLowerCase();

// -------------------------------------------------------------- permission

/** Admins, and anyone holding the tool's permission: the stored permissions, asked on every packet. */
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

// ----------------------------------------------------------------- reading

/** A spell as the picker shows it. */
export interface SpellOption { name: string; icon: string | null; description: string; type: string | null }

async function spellOptions(): Promise<SpellOption[]> {
  const list = await assetCache.get("spells");
  return (Array.isArray(list) ? (list as SpellData[]) : [])
    .filter((s) => s?.name)
    .map((s) => ({ name: String(s.name), icon: getSpriteUrl((s as any).icon ?? null), description: String(s.description ?? ""), type: (s as any).type ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ClassEditorData {
  classes: CharacterClass[];
  spells: SpellOption[];
  numbers: Record<string, NumberRule>;
  nameMax: number;
  descriptionMax: number;
  spellsMax: number;
  levelMax: number;
  /** False when the classes table could not be made at start: nothing can be saved. */
  ready: boolean;
}

export async function buildEditorData(): Promise<ClassEditorData> {
  return {
    classes: await classes.list(),
    spells: await spellOptions(),
    numbers: NUMBER_FIELDS,
    nameMax: NAME_MAX,
    descriptionMax: DESCRIPTION_MAX,
    spellsMax: SPELLS_MAX,
    levelMax: LEVEL_MAX,
    ready: classesReady(),
  };
}

// -------------------------------------------------------------- validation

export interface FieldError { field: string; message: string }

/** What is wrong with a class sent by the editor, by field ("spells.3" for the fourth spell). */
export function validateClass(data: any, ctx: { others: CharacterClass[]; spellNames: Set<string> }): FieldError[] {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => { if (!errors.some((e) => e.field === field)) errors.push({ field, message }); };

  const name = typeof data?.name === "string" ? data.name.trim() : "";
  if (!name) add("name", "Name is required.");
  else if (name.length > NAME_MAX) add("name", `Name must be ${NAME_MAX} characters or fewer.`);
  else if (ctx.others.some((c) => lower(c.name) === lower(name))) add("name", "A class with that name already exists.");

  if (data?.description != null && typeof data.description !== "string") add("description", "Description must be text.");
  else if (String(data?.description ?? "").length > DESCRIPTION_MAX) add("description", `Description must be ${DESCRIPTION_MAX} characters or fewer.`);

  for (const [key, rule] of Object.entries(NUMBER_FIELDS)) {
    const value = data?.[key];
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) add(key, `${rule.label} must be a whole number.`);
    else if (value < rule.min || value > rule.max) add(key, `${rule.label} must be between ${rule.min} and ${rule.max}.`);
  }

  const list = Array.isArray(data?.spells) ? data.spells : null;
  if (!list) add("spells", "Spells must be a list.");
  else {
    if (list.length > SPELLS_MAX) add("spells", `A class learns ${SPELLS_MAX} spells at most.`);
    const seen = new Set<string>();
    list.forEach((entry: any, i: number) => {
      const spell = typeof entry?.spell === "string" ? entry.spell : "";
      const level = entry?.level;
      if (!spell) add(`spells.${i}`, "Pick a spell.");
      else if (!ctx.spellNames.has(spell)) add(`spells.${i}`, `${spell} is not a spell (any more).`);
      else if (seen.has(lower(spell))) add(`spells.${i}`, `${spell} is in the list twice.`);
      else if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > LEVEL_MAX) add(`spells.${i}`, `The level must be a whole number from 1 to ${LEVEL_MAX}.`);
      seen.add(lower(spell));
    });
  }
  return errors;
}

// ----------------------------------------------------------------- changes

interface Outcome { errors: string[]; fields?: Record<string, string>; name?: string; notes?: string[]; changed?: boolean }
const refuse = (...errors: string[]): Outcome => ({ errors });
function invalid(errors: FieldError[]): Outcome {
  const fields: Record<string, string> = {};
  for (const error of errors) fields[error.field] ??= error.message;
  return { errors: errors.map((e) => e.message), fields };
}

const GONE = "That class no longer exists. It may have been deleted by someone else.";

async function saveClass(admin: any, data: any): Promise<Outcome> {
  if (!classesReady()) return refuse("The classes table could not be made when the server started, so nothing can be saved. The server log says why.");
  const all = await classes.list();
  const id = data?.id === null || data?.id === undefined ? null : Number(data.id);
  if (id !== null && !all.some((c) => c.id === id)) return refuse(GONE);

  const spellNames = new Set((await spellOptions()).map((s) => s.name));
  const errors = validateClass(data, { others: all.filter((c) => c.id !== id), spellNames });
  if (errors.length) return invalid(errors);

  const spells: ClassSpell[] = (data.spells as any[]).map((e) => ({ spell: String(e.spell), level: Number(e.level) }));
  const row = {
    id,
    name: String(data.name).trim(),
    description: String(data.description ?? "").trim(),
    ...(Object.fromEntries(STAT_COLUMNS.map((k) => [k, Number(data[k])])) as Record<(typeof STAT_COLUMNS)[number], number>),
    spells: spells.sort((a, b) => a.level - b.level || a.spell.localeCompare(b.spell)),
  };
  const saved = await classes.save(row);
  if (!saved) return refuse("The server did not keep the class.");
  log.info(`[CLASS EDITOR] ${admin.username} ${id === null ? "created" : "saved"} class ${saved.name}`);
  return {
    errors: [],
    name: saved.name,
    changed: true,
    notes: [
      id === null
        ? "New characters can choose it on the character page from now on."
        : "New characters of it start with these stats. Characters already made keep theirs, and learn the spells at their levels as they reach them (the ones already passed at their next login).",
    ],
  };
}

/**
 * Delete a class. Characters already made of it keep their stats and spells and go on playing: they learn no more
 * class spells, and are not asked to make a new character.
 */
async function deleteClass(admin: any, data: any): Promise<Outcome> {
  const id = Number(data?.id);
  const row = Number.isInteger(id) ? await classes.get(id) : null;
  if (!row) return refuse(GONE);
  await classes.remove(row.id);
  if (await classes.get(row.id)) return refuse(`The server did not delete ${row.name}.`);
  log.info(`[CLASS EDITOR] ${admin.username} deleted class ${row.name}`);
  const left = (await classes.list()).length;
  return {
    errors: [], name: row.name, changed: true,
    notes: left === 0 ? ["There are no classes left: new accounts go straight into the game again, without a character page."] : [],
  };
}

/** Changes run one at a time: each is a check followed by a write. */
let changes: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = changes.then(work, work);
  changes = run.catch(() => {});
  return run;
}

export interface ActionResult {
  kind: "result";
  ok: boolean;
  errors: string[];
  fields?: Record<string, string>;
  name?: string;
  notes: string[];
  denied?: boolean;
  changed?: boolean;
  data: ClassEditorData | null;
}
export type EditorResult = { kind: "data"; data: ClassEditorData } | ActionResult;

function change(type: string, work: () => Promise<Outcome>): Promise<ActionResult> {
  return oneAtATime(async () => {
    let outcome: Outcome;
    try {
      outcome = await work();
    } catch (error) {
      log.error(`Class editor ${type} failed: ${error}`);
      outcome = refuse(`The server could not do that: ${(error as Error)?.message ?? error}`);
    }
    return {
      kind: "result", ok: outcome.errors.length === 0, errors: outcome.errors, fields: outcome.fields, name: outcome.name,
      notes: outcome.notes ?? [], changed: outcome.changed, data: await buildEditorData(),
    };
  });
}

/** Dispatch for every CLASS_EDITOR_* packet. Permission is checked here, on each one. */
export async function handleEditorPacket(admin: any, type: string, data: any): Promise<EditorResult> {
  if (!(await canUseEditor(admin))) return { kind: "result", ok: false, errors: [DENIED], notes: [], denied: true, data: null };
  switch (type) {
    case "CLASS_EDITOR_LIST":
      return { kind: "data", data: await buildEditorData() };
    case "CLASS_EDITOR_SAVE":
      return change(type, () => saveClass(admin, data));
    case "CLASS_EDITOR_DELETE":
      return change(type, () => deleteClass(admin, data));
    default:
      return change(type, async () => refuse(`Unknown class editor action: ${type}`));
  }
}
