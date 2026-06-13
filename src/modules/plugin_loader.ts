import fs from "node:fs";
import path from "node:path";
import type EventEmitter from "node:events";
import log from "./logger.ts";
import { Events } from "../systems/events";

const loadedPlugins = new Map<string, LoadedPlugin>();
const directory = path.join(import.meta.dir, "..", "plugins");

export async function loadPlugins(emitter?: EventEmitter): Promise<Map<string, LoadedPlugin>> {

    await scanPluginDirectory(directory, emitter);

    return loadedPlugins;
}

async function scanPluginDirectory(pluginsDir: string, emitter?: EventEmitter): Promise<void> {
    if (!fs.existsSync(pluginsDir)) {
        log.warn(`Plugins directory not found: ${pluginsDir}`);
        return;
    }

    const rootManifestPath = path.join(pluginsDir, "manifest.json");
    if (fs.existsSync(rootManifestPath)) {
        await loadPluginFromDir(pluginsDir, path.basename(pluginsDir), emitter);
    }

    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

        const name = entry.name;
        if (name === "types.ts" || name === "loader.ts") continue;

        const pluginDir = path.join(pluginsDir, name);
        const manifestPath = path.join(pluginDir, "manifest.json");

        if (!fs.existsSync(manifestPath)) {
            continue;
        }

        await loadPluginFromDir(pluginDir, name, emitter);
    }
}

async function loadPluginFromDir(pluginDir: string, name: string, emitter?: EventEmitter): Promise<void> {
    const manifestPath = path.join(pluginDir, "manifest.json");

    try {
        const manifestContent = fs.readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestContent) as PluginManifest;

        if (!manifest.name || !manifest.entry || !manifest.provides) {
            log.warn(`Invalid plugin manifest in ${name}: missing required fields`);
            return;
        }

        const entryPath = path.resolve(pluginDir, manifest.entry);
        if (!fs.existsSync(entryPath)) {
            log.warn(`Plugin entry file not found: ${entryPath} (skipping ${manifest.name})`);
            return;
        }

        const pluginModule = await import(entryPath);

        if (typeof pluginModule.default?.register !== "function") {
            log.error(`Plugin ${manifest.name} does not export a default object with a register function`);
            return;
        }

        loadedPlugins.set(manifest.name, {
            manifest,
            module: pluginModule.default,
            dirPath: pluginDir,
        });

        if (emitter) emitter.emit(Events.PLUGIN_LOAD, { name: manifest.name, version: manifest.version, dirPath: pluginDir });
        log.success(`Loaded plugin: ${manifest.name} v${manifest.version}`);
    } catch (err) {
        log.error(`Failed to load plugin from ${name}: ${err}`);
    }
}

export async function registerPlugin(engine: EngineAPI, pluginName: string, emitter?: EventEmitter): Promise<boolean> {
    const plugin = loadedPlugins.get(pluginName);
    if (!plugin) {
        log.error(`Plugin not loaded: ${pluginName}`);
        return false;
    }

    try {
        if (emitter) emitter.emit(Events.PLUGIN_INITIALIZE, { name: pluginName, engine });
        await plugin.module.register(engine, plugin.manifest);
        if (emitter) emitter.emit(Events.PLUGIN_REGISTER, { name: pluginName });
        log.success(`Registered plugin: ${pluginName}`);
        return true;
    } catch (err) {
        log.error(`Failed to register plugin ${pluginName}: ${err}`);
        return false;
    }
}

export async function registerAllPlugins(engine: EngineAPI, emitter?: EventEmitter): Promise<string[]> {
    const names = [...loadedPlugins.keys()];

    for (const name of names) {
        registerPlugin(engine, name, emitter)
            .catch(err => log.error(`Failed to register plugin ${name}: ${err}`));
    }

    return names;
}

export async function unregisterPlugin(pluginName: string, emitter?: EventEmitter): Promise<void> {
    const plugin = loadedPlugins.get(pluginName);
    if (!plugin || !plugin.module.unregister) return;

    try {
        await plugin.module.unregister(plugin.manifest);
        if (emitter) emitter.emit(Events.PLUGIN_UNREGISTER, { name: pluginName });
        log.info(`Unregistered plugin: ${pluginName}`);
    } catch (err) {
        log.error(`Failed to unregister plugin ${pluginName}: ${err}`);
    }
}

export function getLoadedPlugins(): Map<string, LoadedPlugin> {
    return loadedPlugins;
}
