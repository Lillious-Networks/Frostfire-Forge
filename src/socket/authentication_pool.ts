import { Worker } from "worker_threads";
import assetCache from "../services/assetCache";
import log from "../modules/logger";

const AUTH_POOL_SIZE = 4;

const prepareAssets = async () => {
    const items = await assetCache.get("items");
    const maps = await assetCache.get("maps");
    const mounts = await assetCache.get("mounts");
    const spells = await assetCache.get("spells");

    return {
        items: items ? JSON.stringify(items) : null,
        maps: maps ? JSON.stringify(maps) : null,
        mounts: mounts ? JSON.stringify(mounts) : null,
        spells: spells ? JSON.stringify(spells) : null,
    };
};

let serializedAssets: Awaited<ReturnType<typeof prepareAssets>> | null = null;
const authWorkers: Worker[] = [];
let nextAuthWorker = 0;

async function createWorker(): Promise<Worker> {
    const worker = new Worker(new URL("authentication.ts", import.meta.url), {
        workerData: { assets: serializedAssets }
    });

    worker.on("error", (error) => {
        log.error(`[AUTH POOL] Worker error: ${error.message}`);
        const idx = authWorkers.indexOf(worker);
        if (idx >= 0) {
            authWorkers.splice(idx, 1);
            createWorker().then(w => authWorkers.push(w));
        }
    });

    worker.on("exit", (code) => {
        if (code !== 0) {
            log.error(`[AUTH POOL] Worker exited with code ${code}`);
        }
        const idx = authWorkers.indexOf(worker);
        if (idx >= 0) {
            authWorkers.splice(idx, 1);
            createWorker().then(w => authWorkers.push(w));
        }
    });

    return worker;
}

async function initPool(): Promise<void> {
    if (authWorkers.length > 0) return;

    serializedAssets = await prepareAssets();

    for (let i = 0; i < AUTH_POOL_SIZE; i++) {
        authWorkers.push(await createWorker());
    }
    log.info(`[AUTH POOL] ${AUTH_POOL_SIZE} workers ready`);
}

export async function getAuthWorker(): Promise<Worker> {
    if (authWorkers.length === 0) {
        await initPool();
    }
    const worker = authWorkers[nextAuthWorker];
    nextAuthWorker = (nextAuthWorker + 1) % authWorkers.length;
    return worker;
}

export function resetAuthWorker(): void {
    for (const w of authWorkers) {
        w.terminate();
    }
    authWorkers.length = 0;
    serializedAssets = null;
}
