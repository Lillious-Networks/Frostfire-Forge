/**
 * Spell editor: validation and CRUD for the admin spell editor window (/se).
 * A spell is referred to by name (learned_spells, hotbars) and by id (creature
 * abilities), so its name is fixed once it exists, and it cannot be deleted
 * while a player knows it or a creature casts it.
 */
import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import playerCache from "../services/playermanager";
import log from "../modules/logger";
import { getSpriteUrl } from "../modules/spriteSheetManager";
import { packetManager } from "../socket/packet_manager";
import { refreshAuthSpells } from "../socket/authentication_pool";
import { rowCache, tableCache } from "../services/datacache";
import permissions from "./permissions";
import spells from "./spells";
import { listSprites, type SpriteSheetOption } from "./creatures/editor";
import { CACHE_KEYS as CREATURES } from "./creatures/repository";

/** The tool's own permission and the wildcards over it, as the item, quest and creature editors have theirs. */
export const EDITOR_PERMISSIONS = ["tools.spell_editor", "tools.*", "server.admin", "server.*"];
export const DENIED = "You don't have permission to use the spell editor.";

/** Results per search. An empty search lists every spell: there are few of them. */
export const SEARCH_LIMIT = 200;
/** The only spell category the game knows; nothing reads the column. */
export const SPELL_TYPES = ["spell"];
export const MAX_EFFECTS = 10;
export const NAME_MAX = 64;
/** Column sizes of the spells table. */
export const DESCRIPTION_MAX = 255;
export const ICON_MAX = 255;
export const PARTICLES_MAX = 500;

const PLUGIN_SPELL = "This spell comes from a plugin and lives in memory only: it cannot be saved or deleted here. Duplicate it to make a copy in the database.";

/** Letters, digits, spaces, underscores, hyphens and apostrophes. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _'-]*$/;
const ICON_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9 _.-]*$/;

const lower = (s: unknown): string => String(s ?? "").toLowerCase();

/**
 * A backslash or a control character (a line break is fine). A stored text
 * must never hold one: the database layer escapes quotes only.
 */
function hasUnsafeText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 92 || (code < 32 && code !== 10)) return true;
  }
  return false;
}

/** Particle names that cannot sit in a comma-separated list or in the effects JSON as they are. */
const isUnsafeParticle = (name: string): boolean => hasUnsafeText(name) || /[",\n]/.test(name);

// -------------------------------------------------------------- permission

/**
 * Admins, and anyone holding the tool's permission: the rule of the item, quest
 * and creature editors. The permissions are read from the database on every
 * packet, not trusted from the copy made at login.
 */
export async function canUseEditor(admin: any): Promise<boolean> {
  if (!admin?.username || admin.isGuest) return false;
  if (admin.isAdmin) return true;
  const held = String((await permissions.get(admin.username)) || "").split(",").map((p) => p.trim()).filter(Boolean);
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

/**
 * Whether a player could have the editor open, from the permissions copied at
 * login. Only used to pick who is told to reload after a change.
 */
export function mayHaveEditorOpen(player: any): boolean {
  if (player?.isAdmin) return true;
  const held: string[] = Array.isArray(player?.permissions) ? player.permissions : [];
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

// ------------------------------------------------------------- field rules

export interface NumberRule {
  label: string;
  min: number;
  max: number;
  /** Decimal places kept; 0 for whole numbers. */
  decimals: number;
}

/** Limits for the numeric columns. Only cast_time holds fractions. */
export const NUMBER_FIELDS: Record<string, NumberRule> = {
  damage: { label: "Damage", min: -100000, max: 100000, decimals: 0 },
  mana: { label: "Mana cost", min: 0, max: 1000, decimals: 0 },
  range: { label: "Range", min: 0, max: 5000, decimals: 0 },
  cast_time: { label: "Cast time", min: 0, max: 60, decimals: 2 },
  cooldown: { label: "Cooldown", min: 0, max: 86400, decimals: 0 },
  aoe_radius: { label: "Area radius", min: 0, max: 2000, decimals: 0 },
  ground_duration: { label: "Ground duration", min: 0, max: 600, decimals: 0 },
  charge_distance: { label: "Charge distance", min: 0, max: 2000, decimals: 0 },
};

const FLAG_FIELDS: Record<string, string> = {
  can_move: "Cast while moving",
  ground_aoe: "Ground targeted",
  is_thrown: "Thrown",
  teleport_behind: "Teleport behind",
};

export type EffectFieldKey = "value" | "duration" | "interval" | "stackable" | "max_stacks" | "target_particles";

export interface EffectFieldRule {
  key: EffectFieldKey;
  label: string;
  hint: string;
  /** For numbers: the range allowed and the decimal places kept. */
  min?: number;
  max?: number;
  decimals?: number;
  /** What a newly added effect starts with. */
  initial?: number | boolean;
  /** Only used, and only shown, while the effect's `stackable` is on. */
  whenStackable?: boolean;
}

export interface EffectTypeRule {
  type: string;
  label: string;
  summary: string;
  fields: EffectFieldRule[];
}

const seconds = (label: string, hint: string, min: number, initial: number): EffectFieldRule =>
  ({ key: "duration", label, hint, min, max: 3600, decimals: 2, initial });
const targetParticles: EffectFieldRule = {
  key: "target_particles", label: "Particles on the target", hint: "Shown on the affected target while the effect lasts.",
};
const periodic = (what: string): EffectFieldRule[] => [
  { key: "value", label: `${what} per tick`, hint: `${what} each tick, per stack. The caster's damage stat adds a share on top.`, min: 1, max: 100000, decimals: 0, initial: 5 },
  seconds("Duration (seconds)", "How long it lasts. Casting it again restarts the timer.", 0.1, 10),
  { key: "interval", label: "Tick every (seconds)", hint: "Seconds between ticks.", min: 0.25, max: 3600, decimals: 2, initial: 2 },
  { key: "stackable", label: "Stacks", hint: "Casting it again adds a stack instead of only restarting the timer.", initial: false },
  { key: "max_stacks", label: "Most stacks", hint: "Each stack ticks for the full amount.", min: 1, max: 100, decimals: 0, initial: 5, whenStackable: true },
  targetParticles,
];

/**
 * Every effect type the engine has a handler for, with the fields that handler
 * reads (spelleffects.ts, dots.ts, receiver.ts, creatures/index.ts and
 * creatures/engine.ts). Anything else in a stored effect is ignored by the game.
 */
export const EFFECT_TYPES: EffectTypeRule[] = [
  { type: "damage_over_time", label: "Damage over time", summary: "Hurts the target every tick.", fields: periodic("Damage") },
  { type: "heal_over_time", label: "Heal over time", summary: "Heals the target every tick.", fields: periodic("Healing") },
  {
    type: "absorbtion", label: "Absorb shield", summary: "A shield that soaks up damage before health is touched.",
    fields: [
      { key: "value", label: "Absorbs", hint: "Damage soaked up before it breaks. Never more than the target's max health.", min: 1, max: 1000000, decimals: 0, initial: 50 },
      seconds("Duration (seconds)", "0 lasts until it is used up, and is then not shown on the buff bar.", 0, 8),
      targetParticles,
    ],
  },
  {
    type: "stun", label: "Stun", summary: "The target cannot move or cast.",
    fields: [seconds("Duration (seconds)", "How long the target is stunned.", 0.1, 3), targetParticles],
  },
  {
    type: "slow", label: "Slow", summary: "The target moves slower. The strongest slow on a target wins.",
    fields: [
      { key: "value", label: "Slow %", hint: "50 halves movement speed.", min: 1, max: 99, decimals: 0, initial: 50 },
      seconds("Duration (seconds)", "How long the target is slowed.", 0.1, 5),
      targetParticles,
    ],
  },
  {
    type: "vanish", label: "Vanish", summary: "Hides the target from everyone but admins and their party. Damage or a hostile cast breaks it.",
    fields: [seconds("Duration (seconds)", "0 lasts until it is broken.", 0, 0), targetParticles],
  },
  {
    type: "interrupt", label: "Interrupt", summary: "Stops a cast in progress and locks the target's spells.",
    fields: [seconds("Lockout (seconds)", "How long their spells stay locked. 0 uses 3 seconds.", 0, 3)],
  },
  {
    type: "visual", label: "Visual only", summary: "Plays particles on the target. No effect on the game.",
    fields: [seconds("Duration (seconds)", "How long the particles play.", 0.1, 5), targetParticles],
  },
  {
    type: "taunt", label: "Taunt", summary: "Forces a creature to attack the caster. Does nothing to players.",
    fields: [seconds("Duration (seconds)", "How long the creature is forced onto the caster. 0 uses 3 seconds.", 0, 3)],
  },
  {
    type: "feign_death", label: "Feign death", summary: "The caster drops off the threat list of every creature they are fighting. Higher-level creatures can resist.",
    fields: [],
  },
  {
    type: "threat", label: "Threat change", summary: "Changes the caster's threat: on the creature hit, or on every creature they are fighting when cast on themself.",
    fields: [{ key: "value", label: "Threat %", hint: "-50 halves the caster's threat, -100 clears it, 100 doubles it.", min: -100, max: 1000, decimals: 0, initial: -50 }],
  },
];

/** Damage and healing over time are kept as one timer per spell on a target. */
const PERIODIC_TYPES = ["damage_over_time", "heal_over_time"];

const effectRule = (type: unknown): EffectTypeRule | undefined => EFFECT_TYPES.find((rule) => rule.type === type);

// ------------------------------------------------------------- normalizing

/** A number a client sent, or NaN for anything that is not one. Blank counts as 0, the column default. */
function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

function numberError(value: unknown, rule: { label: string; min?: number; max?: number; decimals?: number }): string | null {
  const n = toNumber(value);
  const decimals = rule.decimals ?? 0;
  if (!Number.isFinite(n)) return `${rule.label} must be a number.`;
  if (decimals === 0 && !Number.isInteger(n)) return `${rule.label} must be a whole number.`;
  const scaled = n * 10 ** decimals;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-9) return `${rule.label} can have at most ${decimals} decimal places.`;
  const min = rule.min ?? 0;
  const max = rule.max ?? Number.MAX_SAFE_INTEGER;
  if (n < min || n > max) return `${rule.label} must be between ${min} and ${max}.`;
  return null;
}

const FLAG_VALUES: unknown[] = [true, false, 0, 1, "0", "1", null, undefined];
const flag = (value: unknown): number => (value === true || value === 1 || value === "1" ? 1 : 0);

/** The names in a comma-separated list (or an array of names), trimmed, without blanks or repeats. */
export function particleList(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(",");
  const names: string[] = [];
  for (const part of parts) {
    const name = String(part ?? "").trim();
    if (name && !names.some((n) => lower(n) === lower(name))) names.push(name);
  }
  return names;
}

/** A particle list as the columns hold it, each name spelled as the particle is. Unknown names are kept as sent. */
function particleColumn(value: unknown, known: string[]): string | null {
  const names = particleList(value).map((name) => known.find((k) => lower(k) === lower(name)) ?? name);
  return names.length > 0 ? names.join(",") : null;
}

/** One effect with only the fields its type uses, in the order the README lists them. */
export function normalizeEffect(input: any, known: string[] = []): SpellEffect {
  const rule = effectRule(input?.type);
  const effect: SpellEffect = { type: String(input?.type ?? ""), value: 0 };
  if (!rule) return effect;
  const stackable = input?.stackable === true || input?.stackable === 1 || input?.stackable === "1";
  for (const field of rule.fields) {
    if (field.key === "stackable") {
      if (stackable) effect.stackable = true;
    } else if (field.key === "target_particles") {
      const names = particleColumn(input?.target_particles, known);
      if (names) effect.target_particles = names;
    } else if (!field.whenStackable || stackable) {
      effect[field.key] = toNumber(input?.[field.key]);
    }
  }
  return effect;
}

export type SpellRow = Omit<SpellData, "id" | "sprite">;

/** Shapes editor input into a row, dropping anything the table does not hold. */
export function normalizeSpell(input: any, known: string[] = []): SpellRow {
  const groundAoe = flag(input?.ground_aoe);
  const radius = toNumber(input?.aoe_radius);
  return {
    name: String(input?.name ?? "").trim(),
    damage: toNumber(input?.damage),
    mana: toNumber(input?.mana),
    range: toNumber(input?.range),
    type: SPELL_TYPES[0],
    cast_time: toNumber(input?.cast_time),
    cooldown: toNumber(input?.cooldown),
    can_move: flag(input?.can_move),
    description: String(input?.description ?? "").trim(),
    icon: input?.icon ? String(input.icon).trim() : null,
    effects: (Array.isArray(input?.effects) ? input.effects : []).map((effect: any) => normalizeEffect(effect, known)),
    particles: particleColumn(input?.particles, known),
    aoe_radius: radius > 0 ? radius : null,
    ground_aoe: groundAoe,
    // Only a ground-targeted spell leaves a zone or is thrown.
    ground_duration: groundAoe ? toNumber(input?.ground_duration) : 0,
    is_thrown: groundAoe ? flag(input?.is_thrown) : 0,
    charge_distance: toNumber(input?.charge_distance),
    teleport_behind: flag(input?.teleport_behind),
  };
}

// --------------------------------------------------------------- validation

/** A problem with one field. `field` is the key the editor shows it under, e.g. "damage" or "effects.0.value". */
export interface FieldError {
  field: string;
  message: string;
}

export interface ValidationContext {
  /** Lower-cased names of every cached spell. */
  existingNames: Set<string>;
  /** Name of the spell being edited, or null for a new one. */
  originalName: string | null;
  /** Particles that exist. */
  particles: string[];
  /** Sprites the asset server has (a spell's icon is a sprite, as the hotbar draws it); empty when it could not be asked. */
  icons: string[];
  /** The stored spell being edited, so what it already uses stays allowed. */
  stored?: SpellData | null;
}

function particleErrors(value: unknown, field: string, ctx: ValidationContext, max: number): FieldError[] {
  const errors: FieldError[] = [];
  const names = particleList(value);
  for (const name of names) {
    if (!ctx.particles.some((k) => lower(k) === lower(name))) errors.push({ field, message: `Particle "${name}" does not exist.` });
  }
  if (names.join(",").length > max) errors.push({ field, message: `Too many particles: the list must fit in ${max} characters.` });
  return errors;
}

export function validateEffects(input: unknown, ctx: ValidationContext): FieldError[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) return [{ field: "effects", message: "Effects must be a list." }];
  const errors: FieldError[] = [];
  if (input.length > MAX_EFFECTS) errors.push({ field: "effects", message: `A spell can have at most ${MAX_EFFECTS} effects.` });

  const seen = new Set<string>();
  input.forEach((effect: any, index: number) => {
    const at = `effects.${index}`;
    const rule = effectRule(effect?.type);
    if (!rule) {
      errors.push({ field: `${at}.type`, message: "Effect type is not valid." });
      return;
    }
    // The game keeps one of each effect per spell on a target: a second one replaces the first.
    if (seen.has(rule.type)) {
      errors.push({ field: `${at}.type`, message: `Only one ${rule.label} effect per spell: a second one replaces the first.` });
    } else if (PERIODIC_TYPES.includes(rule.type) && PERIODIC_TYPES.some((t) => seen.has(t))) {
      errors.push({ field: `${at}.type`, message: "A spell cannot both damage and heal over time: they share one timer and the second replaces the first." });
    }
    seen.add(rule.type);

    const stackable = effect?.stackable === true || effect?.stackable === 1 || effect?.stackable === "1";
    for (const field of rule.fields) {
      if (field.key === "stackable") {
        if (!FLAG_VALUES.includes(effect?.stackable)) errors.push({ field: `${at}.stackable`, message: `${field.label} must be on or off.` });
      } else if (field.key === "target_particles") {
        errors.push(...particleErrors(effect?.target_particles, `${at}.target_particles`, ctx, PARTICLES_MAX));
      } else if (!field.whenStackable || stackable) {
        const message = numberError(effect?.[field.key], field);
        if (message) errors.push({ field: `${at}.${field.key}`, message });
      }
    }
  });
  return errors;
}

export function validateSpell(input: any, ctx: ValidationContext): FieldError[] {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => errors.push({ field, message });
  const spell = normalizeSpell(input, ctx.particles);

  if (ctx.originalName !== null) {
    // Players, hotbars and creatures refer to a spell that exists: it keeps its name.
    if (spell.name !== ctx.originalName.trim()) add("name", "A spell's name cannot be changed. Duplicate it to make a renamed copy.");
  } else if (!spell.name) add("name", "Name is required.");
  else if (spell.name.length > NAME_MAX) add("name", `Name must be ${NAME_MAX} characters or fewer.`);
  else if (!NAME_PATTERN.test(spell.name)) add("name", "Name can hold letters, digits, spaces, underscores, hyphens and apostrophes.");
  else if (ctx.existingNames.has(lower(spell.name))) add("name", "A spell with that name already exists.");

  if (input?.type !== undefined && input?.type !== null && input.type !== "" && !SPELL_TYPES.includes(String(input.type)) && input.type !== ctx.stored?.type) {
    add("type", "Type is not valid.");
  }

  for (const [key, rule] of Object.entries(NUMBER_FIELDS)) {
    const message = numberError(input?.[key], rule);
    if (message) add(key, message);
  }
  for (const [key, label] of Object.entries(FLAG_FIELDS)) {
    if (!FLAG_VALUES.includes(input?.[key])) add(key, `${label} must be on or off.`);
  }

  if (spell.description.length > DESCRIPTION_MAX) add("description", `Description must be ${DESCRIPTION_MAX} characters or fewer.`);
  if (hasUnsafeText(spell.description)) add("description", "Description cannot hold backslashes or control characters.");

  if (spell.icon !== null) {
    if (spell.icon.length > ICON_MAX || !ICON_PATTERN.test(spell.icon)) add("icon", "Icon is not a valid asset name.");
    else if (ctx.icons.length > 0 && !ctx.icons.includes(spell.icon) && spell.icon !== ctx.stored?.icon) add("icon", "That icon is not on the asset server.");
  }

  errors.push(...particleErrors(input?.particles, "particles", ctx, PARTICLES_MAX));
  errors.push(...validateEffects(input?.effects, ctx));

  const clean = !errors.some((e) => e.field === "damage" || e.field === "aoe_radius" || e.field.startsWith("effects"));
  // The server refuses to cast a spell that does nothing (SPELL_FAILED "no_effects").
  if (clean && spell.damage === 0 && spell.effects.length === 0) {
    add("damage", "A spell with no damage, no healing and no effects cannot be cast: give it one of them.");
  }
  if (clean && spell.ground_aoe === 1 && spell.aoe_radius === null) {
    add("aoe_radius", "A ground-targeted spell needs an area radius: with none it hits nothing.");
  }

  // Last line of defence for the escaping described at hasUnsafeText: nothing written may hold a backslash.
  if (errors.length === 0 && values(spell).some((v) => typeof v === "string" && v.includes("\\"))) {
    add("name", "The spell holds a backslash, which cannot be stored.");
  }
  return errors;
}

// ------------------------------------------------------------------ storage

const COLUMNS = [
  "name", "damage", "mana", "`range`", "type", "cast_time", "cooldown", "can_move", "description", "icon",
  "effects", "particles", "aoe_radius", "ground_aoe", "ground_duration", "is_thrown", "charge_distance", "teleport_behind",
];

function values(spell: SpellRow): Array<string | number | null> {
  return [
    spell.name, spell.damage, spell.mana, spell.range, spell.type, spell.cast_time, spell.cooldown, spell.can_move,
    spell.description, spell.icon, JSON.stringify(spell.effects), spell.particles, spell.aoe_radius, spell.ground_aoe,
    spell.ground_duration, spell.is_thrown, spell.charge_distance, spell.teleport_behind,
  ];
}

async function cachedSpells(): Promise<SpellData[]> {
  const list = await assetCache.get("spells");
  return Array.isArray(list) ? (list as SpellData[]) : [];
}

/** Particles a spell can name. Names the lists cannot hold as they are (a comma, a quote) are left out. */
async function particleNames(): Promise<string[]> {
  const list = await assetCache.get("particles");
  return (Array.isArray(list) ? list : [])
    .map((p: any) => String(p?.name ?? ""))
    .filter((name) => name && !isUnsafeParticle(name))
    .sort((a, b) => a.localeCompare(b));
}

// The rows a WHERE on a name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: unknown, b: unknown) =>
  (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? lower(a) === lower(b) : String(a) === String(b);

/** A row of the spells table, as far as the editor's checks need it. */
type StoredSpell = { id: number; name: string };

// The id and name of every spell the database holds, in the order of their
// ids. Which spells are stored, whether a name is taken and what a spell's
// ids are is answered from these; a save or a delete here is written to the
// database and then to them. Nothing else adds or removes a row of spells.
const storedSpells = tableCache<StoredSpell>("stored_spells", async () => {
  const rows = ((await query("SELECT id, name FROM spells ORDER BY id")) || []) as any[];
  return rows.map((row) => ({ id: Number(row.id), name: String(row.name) }));
});

/** The stored rows of a name, lowest id first, as the database would find them. */
async function storedRows(name: string): Promise<StoredSpell[]> {
  return (await storedSpells.all()).filter((row) => sameName(row.name, name)).sort((a, b) => a.id - b.id);
}

/**
 * Names of the spells the database holds. A cached spell that is not among
 * them was added by a plugin and lives in memory only.
 */
async function persistedNames(): Promise<Set<string>> {
  return new Set((await storedSpells.all()).map((row) => lower(row.name)));
}

// Who knows a spell, by its name in lower case: every player's row of it,
// online or not, which no other cache holds. Read the first time an admin
// asks about the spell, and forgotten whenever anyone learns or unlearns it
// (spells.ts) or it is deleted here.
const knownBy = rowCache<string[]>("spell_usage", async (key) => {
  // The table is asked by the name as the spell has it: not every engine finds it in another case.
  const spell = (await cachedSpells()).find((s) => lower(s.name) === key);
  const rows = ((await query("SELECT username FROM learned_spells WHERE spell = ?", [spell?.name ?? key])) || []) as any[];
  return rows.map((row) => String(row.username));
});

/** A spells row as the server keeps it in memory, as the asset loader builds it at startup. */
function fromRow(row: any): SpellData {
  let effects = row.effects;
  if (typeof effects === "string") {
    try {
      effects = JSON.parse(effects);
    } catch {
      effects = [];
    }
  }
  const number = (v: unknown) => Number(v) || 0;
  return {
    ...row,
    id: Number(row.id),
    damage: number(row.damage),
    mana: number(row.mana),
    range: number(row.range),
    cast_time: number(row.cast_time),
    cooldown: number(row.cooldown),
    can_move: number(row.can_move),
    effects: Array.isArray(effects) ? effects : [],
    aoe_radius: row.aoe_radius === null || row.aoe_radius === undefined ? null : number(row.aoe_radius),
    ground_aoe: number(row.ground_aoe),
    ground_duration: number(row.ground_duration),
    is_thrown: number(row.is_thrown),
    charge_distance: number(row.charge_distance),
    teleport_behind: number(row.teleport_behind),
  };
}

/** What the editor shows for a spell. `plugin` spells are read-only. */
function toEditorSpell(spell: SpellData, names: Set<string>) {
  return {
    id: spell.id ?? null,
    name: spell.name,
    damage: Number(spell.damage) || 0,
    mana: Number(spell.mana) || 0,
    range: Number(spell.range) || 0,
    type: spell.type ?? SPELL_TYPES[0],
    cast_time: Number(spell.cast_time) || 0,
    cooldown: Number(spell.cooldown) || 0,
    can_move: spell.can_move ? 1 : 0,
    description: spell.description ?? "",
    icon: spell.icon ?? null,
    effects: Array.isArray(spell.effects) ? spell.effects : [],
    particles: spell.particles ?? null,
    aoe_radius: Number(spell.aoe_radius) || 0,
    ground_aoe: spell.ground_aoe ? 1 : 0,
    ground_duration: Number(spell.ground_duration) || 0,
    is_thrown: spell.is_thrown ? 1 : 0,
    charge_distance: Number(spell.charge_distance) || 0,
    teleport_behind: spell.teleport_behind ? 1 : 0,
    plugin: !names.has(lower(spell.name)),
  };
}

export type EditorSpell = ReturnType<typeof toEditorSpell>;

// ---------------------------------------------------------------- live game

function send(wt: any, packets: any[]): void {
  if (!wt || !wt.send || wt.readyState !== 1) return;
  try {
    for (const p of packets) wt.send(p);
  } catch {
    // Connection closing.
  }
}

/** Send a player their spell book as the client lists it (sprite URLs), as the player editor does. */
function sendSpellBook(target: any): void {
  const spellBook: Record<string, any> = {};
  for (const [name, spell] of Object.entries(target.learnedSpells || {}) as [string, any][]) {
    spellBook[name] = { ...spell, spriteUrl: getSpriteUrl(spell.icon) };
  }
  send(target.wt, packetManager.spells(spellBook));
}

/**
 * The cached spell list changed. Casting reads the cache, so the new values
 * already apply; this brings the rest up to date: the login workers, which
 * build a spell book from their own copy of the list, and every online player
 * who knows the spell (spell book, hotbar and tooltips are drawn from what
 * the client was last sent).
 */
async function spellChanged(name: string): Promise<void> {
  try {
    await refreshAuthSpells();
  } catch (error) {
    log.error(`Could not hand the changed spells to the login workers: ${error}`);
  }
  for (const live of Object.values(playerCache.list() as Record<string, any>)) {
    if (!live?.wt || !live.username || !live.learnedSpells?.[name]) continue;
    try {
      live.learnedSpells = await spells.learnedDetails(live.username);
      sendSpellBook(live);
    } catch (error) {
      log.error(`Could not refresh the spell book of ${live.username}: ${error}`);
    }
  }
}

// ------------------------------------------------------------------ actions

export interface SpellEditorData {
  spellCount: number;
  types: string[];
  numbers: Record<string, NumberRule>;
  effectTypes: EffectTypeRule[];
  maxEffects: number;
  limits: { name: number; description: number; particles: number };
  /**
   * Sprites the asset server has, for the icon picker: the hotbar and the
   * spell book draw a spell's icon from /sprite?name=<icon>.
   */
  icons: SpriteSheetOption[];
  /** Names of the particles that exist. */
  particles: string[];
}

/** Columns added to spells after its first release; a database set up before then gets them when the editor opens. */
const LATER_COLUMNS = [
  { name: "ground_aoe", type: "INT NULL DEFAULT 0" },
  { name: "ground_duration", type: "INT NULL DEFAULT 0" },
  { name: "is_thrown", type: "INT NULL DEFAULT 0" },
  { name: "charge_distance", type: "INT NULL DEFAULT 0" },
  { name: "teleport_behind", type: "INT NULL DEFAULT 0" },
];

/**
 * Makes the spells table hold what the editor offers, so a save never fails on
 * a missing column and never keeps a different value than was entered:
 * cast_time was first created as a whole number of seconds, which stored a
 * 1.5 second cast as 2. If the column cannot be changed the editor takes whole
 * seconds for it instead, and the reason is logged for whoever runs the server.
 */
async function prepareSchema(): Promise<void> {
  for (const col of LATER_COLUMNS) {
    try {
      await query(`SELECT ${col.name} FROM spells LIMIT 1`);
    } catch {
      try {
        await query(`ALTER TABLE spells ADD COLUMN ${col.name} ${col.type}`);
        log.info(`Added the ${col.name} column to the spells table`);
      } catch (error) {
        log.error(`Could not add the ${col.name} column to the spells table: ${error}`);
      }
    }
  }

  let fractions = true; // SQLite keeps a fraction whatever the column was declared as
  if ((process.env.DATABASE_ENGINE || "mysql") === "mysql") {
    const castTimeType = async () => {
      const rows = ((await query(
        "SELECT DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spells' AND COLUMN_NAME = 'cast_time'"
      )) || []) as any[];
      return String(rows[0]?.type ?? rows[0]?.TYPE ?? "").toLowerCase();
    };
    try {
      if ((await castTimeType()).includes("int")) {
        await query("ALTER TABLE spells MODIFY COLUMN cast_time DOUBLE NULL DEFAULT 0");
        log.info("The spells table's cast_time column now holds fractions of a second");
      }
      fractions = !(await castTimeType()).includes("int");
    } catch (error) {
      fractions = false;
      log.error(`Could not let the spells table's cast_time column hold fractions of a second; the spell editor takes whole seconds: ${error}`);
    }
  }
  NUMBER_FIELDS.cast_time!.decimals = fractions ? 2 : 0;
}

/** The last schema check: made each time the editor opens, and before a save that somehow comes first. */
let schema: Promise<void> | null = null;

/** Rules and pick lists. The spells themselves are fetched by search. */
export async function buildEditorData(): Promise<SpellEditorData> {
  schema = prepareSchema();
  await schema;
  return {
    spellCount: (await cachedSpells()).length,
    types: SPELL_TYPES,
    numbers: NUMBER_FIELDS,
    effectTypes: EFFECT_TYPES,
    maxEffects: MAX_EFFECTS,
    limits: { name: NAME_MAX, description: DESCRIPTION_MAX, particles: PARTICLES_MAX },
    icons: await listSprites(),
    particles: await particleNames(),
  };
}

export interface SpellSearchResult {
  query: string;
  spells: EditorSpell[];
  /** Matches beyond the ones returned. */
  truncated: number;
  /** The spell the editor has open, as it is now, whether or not it matches the search; null once it is gone. */
  name: string | null;
  open: EditorSpell | null;
}

/**
 * Name search over the cached spells. An empty query lists them all. `openName`
 * is the spell being edited, sent back as it is now so the form can follow a save.
 */
export async function searchSpells(rawQuery: unknown, openName?: unknown): Promise<SpellSearchResult> {
  const wanted = lower(rawQuery).trim();
  const names = await persistedNames();
  const all = (await cachedSpells()).filter((s) => s?.name);
  const name = typeof openName === "string" && openName ? openName : null;
  const open = name !== null ? all.find((s) => s.name === name) ?? null : null;
  const matches = all
    .filter((s) => !wanted || lower(s.name).includes(wanted))
    .sort((a, b) => {
      // Names that start with the query are what the user usually means.
      const aStarts = lower(a.name).startsWith(wanted);
      const bStarts = lower(b.name).startsWith(wanted);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return {
    query: wanted,
    spells: matches.slice(0, SEARCH_LIMIT).map((s) => toEditorSpell(s, names)),
    truncated: Math.max(0, matches.length - SEARCH_LIMIT),
    name,
    open: open ? toEditorSpell(open, names) : null,
  };
}

export interface ActionResult {
  kind: "result";
  ok: boolean;
  errors: string[];
  /** Problems by field, for the editor to show next to each one. */
  fields?: Record<string, string>;
  name?: string;
  denied?: boolean;
  /** The spell list changed: other open editors should reload. */
  changed?: boolean;
}

export type EditorResult =
  | { kind: "data"; data: SpellEditorData }
  | { kind: "search"; data: SpellSearchResult }
  | ActionResult;

const refuse = (...errors: string[]): ActionResult => ({ kind: "result", ok: false, errors });

function invalid(errors: FieldError[]): ActionResult {
  const fields: Record<string, string> = {};
  for (const error of errors) fields[error.field] ??= error.message;
  return { kind: "result", ok: false, errors: errors.map((e) => e.message), fields };
}

/**
 * Writes run one at a time. Each is a check followed by a write, and the
 * database layer has no transactions: two saves of one name, or the same
 * request arriving twice, must not both pass the check before either writes.
 */
let writes: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = writes.then(work, work);
  writes = run.catch(() => {});
  return run;
}

/** A spell as the columns of its row keep it: what a statement here writes, by column. */
function asWritten(spell: SpellRow): Record<string, string | number | null> {
  const written = values(spell);
  return Object.fromEntries(COLUMNS.map((column, i) => [column.replaceAll("`", ""), written[i]!]));
}

/**
 * After a write that threw: it may still have been applied (a timeout, say),
 * so what is held is no longer known to be what the database holds. Which
 * spells are stored is forgotten, to be read by whoever next asks, and the
 * spells table is read again into the list every system reads from; the
 * plugins' spells, which are no rows of it, stay as they are.
 */
async function rereadSpells(name: string): Promise<void> {
  try {
    const wasStored = await persistedNames();
    await storedSpells.drop();
    const rows = (((await spells.list()) || []) as any[]).map(fromRow);
    const read = new Set(rows.map((row) => lower(row.name)));
    const plugins = (await cachedSpells()).filter((s) => !wasStored.has(lower(s.name)) && !read.has(lower(s.name)));
    await assetCache.set("spells", [...plugins, ...rows]);
  } catch (again) {
    await storedSpells.drop();
    log.error(`Could not read the spells again after a write that failed: ${again}`);
    return;
  }
  await spellChanged(name);
}

/** A statement that changes the row of the spell `name`. One that throws has the spells read again (rereadSpells). */
async function write(name: string, sql: string, params: any[]): Promise<any> {
  try {
    return await query(sql, params);
  } catch (error) {
    await rereadSpells(name);
    throw error;
  }
}

/** Insert or update, then put the row as it was written into the cache every system reads from. */
async function saveSpell(admin: any, data: any): Promise<ActionResult> {
  await (schema ??= prepareSchema());
  const list = await cachedSpells();
  const originalName = data?.originalName ? String(data.originalName) : null;
  const stored = originalName !== null ? list.find((s) => s.name === originalName) ?? null : null;
  if (originalName !== null && !stored) return refuse("That spell no longer exists. It may have been deleted by someone else.");

  const known = await particleNames();
  const errors = validateSpell(data, {
    existingNames: new Set(list.map((s) => lower(s.name))),
    originalName,
    particles: known,
    icons: (await listSprites()).map((i) => i.name),
    stored,
  });
  if (errors.length) return invalid(errors);
  const spell = normalizeSpell(data, known);
  if (originalName !== null) spell.name = originalName;

  const rows = await storedRows(spell.name);
  let id: number;
  if (originalName !== null) {
    if (rows.length === 0) return refuse(PLUGIN_SPELL);
    // One statement, so the row is never left half written. The name is the key and does not change.
    await write(
      spell.name,
      `UPDATE spells SET ${COLUMNS.slice(1).map((c) => `${c} = ?`).join(", ")} WHERE name = ?`,
      [...values(spell).slice(1), spell.name]
    );
    id = rows[0].id;
  } else {
    if (rows.length > 0) return invalid([{ field: "name", message: "A spell with that name already exists." }]);
    // MySQL's spells.name is not unique, so the statement itself refuses a second row of the name.
    const result = await write(
      spell.name,
      `INSERT INTO spells (${COLUMNS.join(", ")}) SELECT * FROM (SELECT ${COLUMNS.map((_, i) => `? AS c${i}`).join(", ")}) AS incoming ` +
        `WHERE NOT EXISTS (SELECT 1 FROM spells WHERE name = ?)`,
      [...values(spell), spell.name]
    );
    const answered = Number(result?.lastInsertRowid);
    const rowsAdded = result?.affectedRows ?? result?.count;
    const addedNone = rowsAdded !== null && rowsAdded !== undefined && Number(rowsAdded) === 0;
    if (Number.isInteger(answered) && answered > 0 && !addedNone && !(await storedSpells.find((row) => row.id === answered))) {
      id = answered;
      await storedSpells.put({ id, name: spell.name }, (row) => row.id === answered);
    } else {
      // The answer does not say which row was added (not every engine's does, for a statement of this shape), or
      // says none was: a row of the name that the server did not hold, put there by something else. The stored
      // spells are read again to see.
      try {
        await storedSpells.reload();
      } catch (error) {
        await rereadSpells(spell.name);
        throw error;
      }
      const kept = await storedRows(spell.name);
      if (kept.length === 0) return refuse("The database did not keep the spell.");
      if (addedNone) return invalid([{ field: "name", message: "A spell with that name already exists." }]);
      id = kept[0].id;
    }
  }

  // The row is its id and every column as it was written: the schema check and the editor's rules see to it that
  // the table keeps what it is given, so this is what a restart would load.
  const saved = fromRow({ id, ...asWritten(spell) });

  const fresh = await cachedSpells();
  const index = fresh.findIndex((s) => s.name === saved.name);
  if (index === -1) fresh.push(saved);
  else fresh[index] = saved;
  await assetCache.set("spells", fresh);

  log.info(`[SPELL EDITOR] ${admin.username} ${originalName === null ? "created" : "saved"} spell ${saved.name}`);
  await spellChanged(saved.name);
  return { kind: "result", ok: true, errors: [], name: saved.name, changed: true };
}

/** Where a spell is still used, as lines for the editor. Empty when it is free to delete. */
async function usage(name: string, ids: number[]): Promise<string[]> {
  const lines: string[] = [];
  const few = (list: string[]) => (list.length > 10 ? `${list.slice(0, 10).join(", ")} and ${list.length - 10} more` : list.join(", "));

  const players = [...new Set((await knownBy.get(lower(name))) ?? [])];
  if (players.length > 0) {
    lines.push(`Known by ${players.length} player${players.length === 1 ? "" : "s"}: ${few(players)}. Remove it from them in the player editor first.`);
  }

  if (ids.length > 0) {
    // Which creature casts it is read from the creature tables the server holds.
    const held = async (key: string) => {
      const list = await assetCache.get(key);
      return Array.isArray(list) ? (list as any[]) : [];
    };
    const abilities = (await held(CREATURES.abilities)).filter((ability) => ids.includes(Number(ability?.spell_id)));
    const templateIds = [...new Set(abilities.map((ability) => Number(ability.template_id)))];
    if (templateIds.length > 0) {
      const templates = await held(CREATURES.templates);
      const creatures = templateIds.map((id) => String(templates.find((t) => Number(t?.id) === id)?.name ?? `creature #${id}`));
      lines.push(`Cast by ${creatures.length} creature${creatures.length === 1 ? "" : "s"}: ${few(creatures)}. Remove the ability in the creature editor first.`);
    }
  }
  return lines;
}

/** Delete a spell nobody knows and no creature casts. */
async function deleteSpell(admin: any, data: any): Promise<ActionResult> {
  const name = String(data?.name ?? "").trim();
  if (!name) return refuse("Nothing selected.");
  const spell = (await cachedSpells()).find((s) => s.name === name);
  if (!spell) return refuse("That spell no longer exists. It may have been deleted by someone else.");

  const rows = await storedRows(name);
  if (rows.length === 0) return refuse(PLUGIN_SPELL);
  const ids = rows.map((row) => row.id);

  const inUse = await usage(name, ids);
  if (inUse.length > 0) return refuse(`${name} is still in use and was not deleted.`, ...inUse);

  // The statement checks again as it deletes, so a spell learned in between stays.
  const result = await write(
    name,
    "DELETE FROM spells WHERE name = ? AND NOT EXISTS (SELECT 1 FROM learned_spells WHERE spell = ?) " +
      "AND NOT EXISTS (SELECT 1 FROM creature_abilities WHERE spell_id IN (?))",
    [name, name, ids]
  );
  // Whether it deleted is what its answer says. An answer that says nothing, or none, has the stored spells read
  // again to see.
  if (Number(result?.affectedRows ?? result?.count) > 0) {
    await storedSpells.remove((row) => sameName(row.name, name));
  } else {
    await storedSpells.reload();
    if ((await storedRows(name)).length > 0) {
      // Still there: somebody knows it who was not held as knowing it. Who does is read again.
      await knownBy.drop(lower(name));
      return refuse(`${name} is still in use and was not deleted.`, ...(await usage(name, ids)));
    }
  }
  await knownBy.drop(lower(name));

  const fresh = await cachedSpells();
  const index = fresh.findIndex((s) => s.name === name);
  if (index !== -1) {
    fresh.splice(index, 1);
    await assetCache.set("spells", fresh);
  }

  log.info(`[SPELL EDITOR] ${admin.username} deleted spell ${name}`);
  await spellChanged(name);
  return { kind: "result", ok: true, errors: [], name, changed: true };
}

/** Teach a saved spell to the admin's own character, to try it out. */
async function learnSpell(admin: any, data: any): Promise<ActionResult> {
  const name = String(data?.name ?? "").trim();
  const spell = name ? (await cachedSpells()).find((s) => s.name === name) : null;
  if (!spell) return refuse("That spell does not exist. Save it first.");
  if ((await spells.listLearned(admin.username)).includes(spell.name)) return refuse(`You already know ${spell.name}.`);

  await spells.learnSpell(admin.username, spell.name);
  admin.learnedSpells = await spells.learnedDetails(admin.username);
  sendSpellBook(admin);
  return { kind: "result", ok: true, errors: [], name: spell.name };
}

/** Dispatch for every SPELL_EDITOR_* packet. Permission is checked here, on each one. */
export async function handleEditorPacket(admin: any, type: string, data: any): Promise<EditorResult> {
  if (!(await canUseEditor(admin))) return { kind: "result", ok: false, errors: [DENIED], denied: true };
  try {
    switch (type) {
      case "SPELL_EDITOR_LIST":
        return { kind: "data", data: await buildEditorData() };
      case "SPELL_EDITOR_SEARCH":
        return { kind: "search", data: await searchSpells(data?.query, data?.name) };
      case "SPELL_EDITOR_SAVE":
        return await oneAtATime(() => saveSpell(admin, data));
      case "SPELL_EDITOR_DELETE":
        return await oneAtATime(() => deleteSpell(admin, data));
      case "SPELL_EDITOR_LEARN":
        return await oneAtATime(() => learnSpell(admin, data));
      default:
        return refuse(`Unknown spell editor action: ${type}`);
    }
  } catch (error) {
    log.error(`Spell editor ${type} failed: ${error}`);
    return refuse(`The server could not do that: ${(error as Error)?.message ?? error}`);
  }
}
