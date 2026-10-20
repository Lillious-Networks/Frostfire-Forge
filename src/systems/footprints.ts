/**
 * Footprints (USER REQUEST 2026-10-20: "a section in the editor to be able to add footsteps on certain tiles": visible
 * footprints, with their colour and darkness, how long they stay, and their style).
 *
 * The map editor's Footprints tab gives tiles of a tileset the prints players leave on them: a style (boot prints, bare
 * feet, holes in deep snow), a colour, how dark they are, and how many seconds they take to fade. Kept as the fishable
 * tiles are (systems/fishing): by tileset picture (the image's file name without its extension, in lower case) and tile
 * id, in one list for every map, as rows of tile_footprints. They are only drawn, so every player is sent the whole list
 * (TILE_FOOTPRINTS) at login and after every save.
 */
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { tableCache } from "../services/datacache";
import { fromRows, mayEditFootprints, readFootprintChanges, type FootprintChange, type FootprintRow, type TileFootprints } from "./footprintrules";

export * from "./footprintrules";

const sqlite = (): boolean => (process.env.DATABASE_ENGINE || "mysql") === "sqlite";

/** The table, as the setup scripts make it. */
export const TILE_FOOTPRINTS_TABLE: Record<"mysql" | "sqlite", string> = {
  mysql: `CREATE TABLE IF NOT EXISTS tile_footprints (
    tileset VARCHAR(64) NOT NULL,
    tile_id INT NOT NULL,
    style VARCHAR(16) NOT NULL,
    color VARCHAR(7) NOT NULL,
    opacity FLOAT NOT NULL,
    fade_s INT NOT NULL,
    PRIMARY KEY (tileset, tile_id)
  )`,
  sqlite: `CREATE TABLE IF NOT EXISTS tile_footprints (
    tileset TEXT NOT NULL,
    tile_id INTEGER NOT NULL,
    style TEXT NOT NULL,
    color TEXT NOT NULL,
    opacity REAL NOT NULL,
    fade_s INTEGER NOT NULL,
    PRIMARY KEY (tileset, tile_id)
  )`,
};

let ready = false;

/** Start-time safety step: makes the table when missing. Never throws: without it, no tile takes prints. */
export async function ensureFootprintsSchema(): Promise<boolean> {
  ready = false;
  try {
    await query(TILE_FOOTPRINTS_TABLE[sqlite() ? "sqlite" : "mysql"]);
    ready = true;
  } catch (error) {
    log.warn(`[Footprints] The tile_footprints table could not be made, so no tile takes footprints: ${error}`);
  }
  return ready;
}


const rows = tableCache<FootprintRow>("tile_footprints", async () =>
  ready ? (((await query(`SELECT tileset, tile_id, style, color, opacity, fade_s FROM tile_footprints`)) as FootprintRow[]) || []) : []
);

/** Every tile that takes prints, and how they look. */
export async function getFootprints(): Promise<TileFootprints> {
  return ready ? fromRows(await rows.all()) : {};
}

const SAVE_ROWS = 500;

/** Write the changes, then read the list again. Returns it as it is now. Throws when the database refuses. */
export async function saveFootprints(changes: FootprintChange[]): Promise<TileFootprints> {
  if (!ready) throw new Error("the tile_footprints table is missing");
  try {
    for (const change of changes) {
      for (let at = 0; at < change.ids.length; at += SAVE_ROWS) {
        const ids = change.ids.slice(at, at + SAVE_ROWS);
        if (change.print === null) {
          await query(`DELETE FROM tile_footprints WHERE tileset = ? AND tile_id IN (${ids.map(() => "?").join(", ")})`, [change.tileset, ...ids]);
          continue;
        }
        const { style, color, opacity, fade } = change.print;
        const values = ids.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
        const params = ids.flatMap((id) => [change.tileset, id, style, color, opacity, fade]);
        await query(
          sqlite()
            ? `INSERT OR REPLACE INTO tile_footprints (tileset, tile_id, style, color, opacity, fade_s) VALUES ${values}`
            : `INSERT INTO tile_footprints (tileset, tile_id, style, color, opacity, fade_s) VALUES ${values}
               ON DUPLICATE KEY UPDATE style = VALUES(style), color = VALUES(color), opacity = VALUES(opacity), fade_s = VALUES(fade_s)`,
          params
        );
      }
    }
  } catch (error) {
    // part of it may have been written: the next read takes the table as it is
    await rows.drop();
    throw error;
  }
  await rows.reload();
  return getFootprints();
}

export default { ensureFootprintsSchema, getFootprints, mayEditFootprints, readFootprintChanges, saveFootprints };
