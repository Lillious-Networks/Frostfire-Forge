// The stand-ins for the generated config files (see preload.ts, which loads this for every test file).
//
// The files under src/config are generated when the server starts and are not
// checked in, so a fresh checkout (a CI machine) has none. Some of the engine's
// modules import them, and a test file that loads one of those, however
// indirectly, cannot be loaded there. So every test file is given the same
// stand-ins, whichever file runs first and whether or not the real files
// are on disk: a test never depends on what this machine's config happens to
// say.
//
// A process a test starts (a fixture, the coordinator, validate_config) is not a test run, so bunfig.toml's preload
// does not reach it: it is started with `--preload` on this file, which needs nothing but the stand-ins.
import { mock } from "bun:test";

const settings = { creatures: {} };
const settingsModule = () => ({ default: settings, ...settings });
mock.module("../config/settings.json", settingsModule);

const aoi = {
  DEFAULT_RADIUS: 1000,
  UPDATE_THRESHOLD: 100,
  GRID_CELL_SIZE: 512,
  USE_SPATIAL_GRID: true,
  SPATIAL_GRID_THRESHOLD: 50,
  MAX_PLAYERS_PER_LAYER: 50,
  DEBUG: false,
};
const aoiModule = () => ({ default: aoi, ...aoi });
mock.module("../config/aoi.json", aoiModule);

/** The stand-ins by the path a test imports them with, for preload.ts to put back when a test file has put its own in place. */
export const configStandIns: Record<string, () => Record<string, any>> = {
  "../config/settings.json": settingsModule,
  "../config/aoi.json": aoiModule,
};
