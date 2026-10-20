/**
 * What needs no server in tile footprints (systems/footprints.ts): the kinds of prints, reading an editor save and the
 * rows of tile_footprints.
 */
export const PRINT_STYLES = ["boot", "bare", "hole"] as const;
export type PrintStyle = (typeof PRINT_STYLES)[number];
/** How a tile's prints look: their style, colour ("#rrggbb"), darkness (0.05 to 1) and fade time (s). */
export interface Footprint { style: PrintStyle; color: string; opacity: number; fade: number }
/** tileset key -> tile id (as text) -> its prints */
export type TileFootprints = Record<string, Record<string, Footprint>>;
/** A save: these tiles of one tileset take these prints; null takes them away. */
export interface FootprintChange { tileset: string; ids: number[]; print: Footprint | null }

/** At most this many changes in one save, tiles in one change, and a tile id below MAX_TILE_ID (as for tile sounds). */
export const MAX_CHANGES = 64, MAX_IDS = 65536, MAX_TILE_ID = 1_000_000, MAX_KEY = 64;
/** Darkness from and to, and fade time from and to (s). */
export const MIN_OPACITY = 0.05, MAX_OPACITY = 1, MIN_FADE = 1, MAX_FADE = 600;
const KEY_RE = /^[a-z0-9 ._-]+$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;

export interface FootprintRow { tileset: string; tile_id: number; style: string; color: string; opacity: number; fade_s: number }

const roundOpacity = (n: number) => Math.round(n * 100) / 100;

/** A print as kept, or null when it is not one a save could have written. */
function readPrint(raw: any): Footprint | null {
  const style = String(raw?.style ?? "").toLowerCase();
  const color = String(raw?.color ?? "").toLowerCase();
  const opacity = Number(raw?.opacity), fade = Number(raw?.fade);
  if (!(PRINT_STYLES as readonly string[]).includes(style) || !COLOR_RE.test(color)) return null;
  if (!(opacity >= MIN_OPACITY && opacity <= MAX_OPACITY) || !Number.isInteger(fade) || fade < MIN_FADE || fade > MAX_FADE) return null;
  return { style: style as PrintStyle, color, opacity: roundOpacity(opacity), fade };
}

/** The rows as one list (a row that is not a valid print is left out). */
export function fromRows(list: FootprintRow[]): TileFootprints {
  const out: TileFootprints = {};
  for (const row of list) {
    const print = readPrint({ style: row.style, color: row.color, opacity: Number(row.opacity), fade: Number(row.fade_s) });
    if (!print) continue;
    (out[String(row.tileset).toLowerCase()] ??= {})[String(Number(row.tile_id))] = print;
  }
  return out;
}

/** Who may save: the same as for saving a map or tile sounds. */
export function mayEditFootprints(perms: string[]): boolean {
  return perms.includes("server.admin") || perms.includes("server.*");
}

/** A save as the editor sent it, made tidy (tileset in lower case, each tile once, in order), or what is wrong with it. */
export function readFootprintChanges(raw: unknown): { changes: FootprintChange[] } | { error: string } {
  const list = (raw as any)?.changes;
  if (!Array.isArray(list) || list.length === 0) return { error: "Nothing to save." };
  if (list.length > MAX_CHANGES) return { error: `At most ${MAX_CHANGES} changes can be saved at once.` };
  const changes: FootprintChange[] = [];
  for (const c of list) {
    const tileset = typeof c?.tileset === "string" ? c.tileset.trim().toLowerCase() : "";
    if (!tileset || tileset.length > MAX_KEY || !KEY_RE.test(tileset)) return { error: "A change names no valid tileset." };
    if (!Array.isArray(c.ids) || c.ids.length === 0 || c.ids.length > MAX_IDS) return { error: `Pick 1 to ${MAX_IDS.toLocaleString()} tiles.` };
    if (c.ids.some((id: unknown) => !Number.isInteger(id) || (id as number) < 0 || (id as number) >= MAX_TILE_ID)) return { error: "A tile id is not valid." };
    let print: Footprint | null = null;
    if (c.print !== null && c.print !== undefined) {
      print = readPrint(c.print);
      if (!print) {
        return { error: `Footprints need a style (${PRINT_STYLES.join(", ")}), a colour, a darkness of ${MIN_OPACITY * 100} to 100 % and a fade time of ${MIN_FADE} to ${MAX_FADE} s.` };
      }
    }
    changes.push({ tileset, ids: [...new Set<number>(c.ids)].sort((a, b) => a - b), print });
  }
  return { changes };
}

