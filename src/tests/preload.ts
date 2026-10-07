// Loaded once before the test files (bunfig.toml).
//
// The files under src/config are generated when the server starts and are not
// checked in, so a fresh checkout (a CI machine) has none. Some of the engine's
// modules import them, and a test file that loads one of those, however
// indirectly, cannot be loaded there. So every test file is given the same
// stand-ins, here, whichever file runs first and whether or not the real files
// are on disk: a test never depends on what this machine's config happens to
// say.
import { mock } from "bun:test";

const settings = { creatures: {} };
mock.module("../config/settings.json", () => ({ default: settings, ...settings }));

const aoi = {
  DEFAULT_RADIUS: 1000,
  UPDATE_THRESHOLD: 100,
  GRID_CELL_SIZE: 512,
  USE_SPATIAL_GRID: true,
  SPATIAL_GRID_THRESHOLD: 50,
  MAX_PLAYERS_PER_LAYER: 50,
  DEBUG: false,
};
mock.module("../config/aoi.json", () => ({ default: aoi, ...aoi }));
