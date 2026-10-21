/**
 * Mount editor: what the admin mount editor window (/mounteditor) asks for. Mounts are few, so the window is sent
 * every one of them and searches them itself, as the achievement editor does (achievements/editor.ts). Every field
 * of a save is checked here and written through systems/mounts.ts, which keeps the cached list in step; the login
 * workers are then handed the new list, since they build a player's collection from their own copy of it.
 *
 * A mount is known by its name everywhere (players' collections, achievement rewards), so a saved mount
 * keeps its name: it is never renamed. What it looks like when ridden is the sprite sheet mount_<name> on the asset
 * server (spritesheets/mounts/<name>.png); the editor says whether that sheet is there.
 */
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import assetCache from "../services/assetCache";
import { refreshAuthMounts } from "../socket/authentication_pool";
import type { SpriteSheetOption } from "./creatures/editor";
import mounts from "./mounts";

export const EDITOR_PERMISSIONS = ["tools.mount_editor", "tools.*", "server.admin", "server.*"];
export const DENIED = "You don't have permission to use the mount editor.";

/** What the asset server has, for the editor: its icons, and its sprite sheets by slot. */
export interface AssetLists {
  icons(): Promise<SpriteSheetOption[]>;
  spriteSheets(): Promise<Record<string, SpriteSheetOption[]>>;
}

/**
 * The asset server's lists, as the other editors ask for them. Loaded when first asked for. The sheets are asked for
 * afresh each time: a mount's sheet is added to the asset server after the mount is made, and the editor says whether
 * it is there.
 */
const assetServer: AssetLists = {
  icons: async () => (await import("./creatures/editor")).listIcons(),
  spriteSheets: async () => (await import("./creatures/editor")).listSpriteSheets(true),
};

/** The longest each field can be: what the mounts table holds. */
export const LIMITS = { nameMax: 255, descriptionMax: 500, iconMax: 255 };

const sqlite = () => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";
const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** The sprite sheet a mount is drawn with when ridden. */
export const sheetOf = (name: string) => `mount_${name.toLowerCase()}`;

// -------------------------------------------------------------- permission

/**
 * Admins, and anyone holding the editor's permission, from the permissions copied to the player at login, as the
 * item editor asks (itemeditor.ts). Asked on every packet, and of every other player when they are told to reload.
 */
export function canUseEditor(player: any): boolean {
  if (!player || player.isGuest) return false;
  if (player.isAdmin) return true;
  const held: string[] = Array.isArray(player.permissions) ? player.permissions : [];
  return held.some((p) => EDITOR_PERMISSIONS.includes(p));
}

/** The editor's permission, so it can be granted where the permissions are picked from a list. Never throws. */
export async function ensureMountEditorPermission(): Promise<void> {
  try {
    await query(`INSERT ${sqlite() ? "OR IGNORE" : "IGNORE"} INTO permission_types (name) VALUES ('tools.mount_editor')`);
  } catch {
    // no permission_types table: nothing lists them
  }
}

// ------------------------------------------------------------------ checks

export interface MountInput {
  name: string;
  description: string;
  icon: string | null;
}

export type ReadResult = { ok: true; mount: MountInput } | { ok: false; errors: string[]; fields: Record<string, string> };

/**
 * The mount an editor sent, or which fields are wrong. `originalName` is the saved mount being changed, or null for a
 * new one; `existing` is every mount there is.
 */
export function readMount(raw: any, originalName: string | null, existing: Mount[]): ReadResult {
  const fields: Record<string, string> = {};

  // A saved mount keeps its name, whatever was sent.
  const name = originalName ?? String(raw?.name ?? "").trim();
  if (originalName === null) {
    if (!name) fields["name"] = "Enter a name.";
    else if (name.length > LIMITS.nameMax) fields["name"] = `A name is ${LIMITS.nameMax} characters at most.`;
    // Its sprite sheet is a file named after it.
    else if (/[\\/]|\.\./.test(name)) fields["name"] = "A name cannot hold / or \\ or two dots in a row.";
    else if (existing.some((m) => lower(m.name) === lower(name))) fields["name"] = `There is already a mount called ${name}.`;
  }

  const description = String(raw?.description ?? "").trim();
  if (!description) fields["description"] = "Enter a description.";
  else if (description.length > LIMITS.descriptionMax) fields["description"] = `A description is ${LIMITS.descriptionMax} characters at most.`;

  const iconText = String(raw?.icon ?? "").trim();
  if (iconText.length > LIMITS.iconMax) fields["icon"] = `An icon name is ${LIMITS.iconMax} characters at most.`;

  const wrong = Object.keys(fields).length;
  if (wrong > 0) return { ok: false, errors: [wrong === 1 ? "1 field needs fixing." : `${wrong} fields need fixing.`], fields };
  return { ok: true, mount: { name, description, icon: iconText || null } };
}

// ------------------------------------------------------------------ editor

export interface EditorMount {
  name: string;
  description: string;
  icon: string | null;
  /** The sprite sheet it is drawn with when ridden. */
  sheet: string;
  /** That sheet is on the asset server. */
  hasSheet: boolean;
}

export interface EditorData {
  mounts: EditorMount[];
  icons: SpriteSheetOption[];
  limits: typeof LIMITS;
}

async function held(): Promise<Mount[]> {
  return ((await assetCache.get("mounts")) || []) as Mount[];
}

export async function buildEditorData(assets: AssetLists = assetServer): Promise<EditorData> {
  const [all, icons, sheets] = await Promise.all([held(), assets.icons(), assets.spriteSheets()]);
  // Asked of every sheet, not only the mounts slot: a sheet the asset server files elsewhere still draws.
  const known = new Set(Object.values(sheets).flat().map((sheet) => sheet.name.toLowerCase()));
  return {
    mounts: all
      .filter((m) => m?.name)
      .map((m) => ({
        name: String(m.name), description: String(m.description ?? ""), icon: typeof m.icon === "string" ? m.icon : null,
        sheet: sheetOf(String(m.name)), hasSheet: known.has(sheetOf(String(m.name))),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    icons,
    limits: LIMITS,
  };
}

/**
 * The mount list changed. The login workers build a player's collection from their own copy of the list, and leave
 * out a mount they do not know, so hand them the new one.
 */
async function mountsChanged(): Promise<void> {
  try {
    await refreshAuthMounts();
  } catch (error) {
    log.error(`Could not hand the changed mounts to the login workers: ${error}`);
  }
}

export type EditorAnswer =
  | { kind: "data"; data: EditorData }
  | {
    kind: "result"; ok: boolean; errors: string[]; fields?: Record<string, string>; name: string | null;
    denied?: boolean; data: EditorData | null;
    /** The mounts changed: the other open editors are told. */
    changed?: boolean;
  };

/** One packet of the editor. Permission is checked first, on every one. */
export async function handleEditorPacket(admin: any, type: string, data: any, assets: AssetLists = assetServer): Promise<EditorAnswer> {
  if (!canUseEditor(admin)) return { kind: "result", ok: false, errors: [DENIED], name: null, denied: true, data: null };
  if (type === "MOUNT_EDITOR_LIST") return { kind: "data", data: await buildEditorData(assets) };

  const wanted = String(data?.originalName ?? "").trim();
  const all = await held();
  const existing = wanted ? all.find((m) => lower(m.name) === lower(wanted)) ?? null : null;
  const refused = async (errors: string[], fields?: Record<string, string>): Promise<EditorAnswer> =>
    ({ kind: "result", ok: false, errors, fields, name: existing?.name ?? null, data: await buildEditorData(assets) });
  if (wanted && !existing) return refused([`There is no mount called ${wanted} any more.`]);

  if (type === "MOUNT_EDITOR_SAVE") {
    const read = readMount(data, existing?.name ?? null, all);
    if (!read.ok) return refused(read.errors, read.fields);
    const { mount } = read;
    try {
      // Particles are kept as they are: nothing draws them on a mount, so the editor does not show them.
      if (existing) await mounts.update({ ...mount, particles: existing.particles ?? null });
      else await mounts.add({ ...mount, particles: null });
    } catch (error) {
      log.error(`[Mounts] ${admin.username} could not save mount ${mount.name}: ${error}`);
      return refused(["The mount could not be saved. The server log says why."]);
    }
    await mountsChanged();
    log.info(`[Mounts] ${admin.username} ${existing ? "changed" : "added"} mount ${mount.name}.`);
    return { kind: "result", ok: true, errors: [], name: mount.name, data: await buildEditorData(assets), changed: true };
  }

  if (type === "MOUNT_EDITOR_DELETE") {
    if (!existing) return refused(["Pick a mount."]);
    try {
      await mounts.remove(existing);
    } catch (error) {
      log.error(`[Mounts] ${admin.username} could not delete mount ${existing.name}: ${error}`);
      return refused(["The mount could not be deleted. The server log says why."]);
    }
    await mountsChanged();
    log.info(`[Mounts] ${admin.username} deleted mount ${existing.name}.`);
    return { kind: "result", ok: true, errors: [], name: existing.name, data: await buildEditorData(assets), changed: true };
  }

  return refused([`Unknown request ${type}.`]);
}
