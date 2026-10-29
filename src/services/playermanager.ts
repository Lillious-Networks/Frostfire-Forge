import log from "../modules/logger";

type PlayerListener = (key: string, value: any) => void;

export class PlayerManager {
    private cache: { [key: string]: any };
    // Lowercased username -> the key that player is held under.
    private byUsername = new Map<string, string>();
    private addListeners: PlayerListener[] = [];
    private removeListeners: PlayerListener[] = [];

    constructor() {

        this.cache = {};
    }

    // A listener that throws is logged and skipped: it must never break the cache.
    private notify(listeners: PlayerListener[], key: string, value: any) {
        // A copy: a listener may remove itself (or another) while the others are told.
        for (const listener of [...listeners]) {
            try {
                listener(key, value);
            } catch (error) {
                log.error(`Player cache listener failed: ${error}`);
            }
        }
    }

    /** Called with each player added to the cache (a login, on this node). */
    onAdd(listener: PlayerListener): () => void {
        this.addListeners.push(listener);
        return () => {
            const at = this.addListeners.indexOf(listener);
            if (at >= 0) this.addListeners.splice(at, 1);
        };
    }

    /** Called with each player removed from the cache (a logout, on this node). */
    onRemove(listener: PlayerListener): () => void {
        this.removeListeners.push(listener);
        return () => {
            const at = this.removeListeners.indexOf(listener);
            if (at >= 0) this.removeListeners.splice(at, 1);
        };
    }

    // `login`: a new session takes the name. Otherwise a name already held by
    // another live session keeps it, so an old session still being written
    // while it is disconnected does not take the name back from the new one.
    private index(key: string, value: any, login: boolean) {
        const username = value?.username;
        if (typeof username !== "string" || !username) return;
        const name = username.toLowerCase();
        const holder = this.byUsername.get(name);
        if (login || holder === undefined || holder === key || this.cache[holder] === undefined) {
            this.byUsername.set(name, key);
        }
    }

    add(key: string, value: any) {
        this.cache[key] = value;
        this.index(key, value, true);
        this.notify(this.addListeners, key, value);
    }

        get(key: string) {
        return this.cache[key];
    }

    /** The online player with this username (any case), without reading the database. */
    getByUsername(username: string) {
        if (!username) return undefined;
        const name = String(username).toLowerCase();
        const key = this.byUsername.get(name);
        if (key === undefined) return undefined;
        const value = this.cache[key];
        if (value?.username?.toLowerCase() === name) return value;
        this.byUsername.delete(name);
        return undefined;
    }

    remove(key: string) {
        const value = this.cache[key];
        const username = value?.username;
        if (typeof username === "string" && this.byUsername.get(username.toLowerCase()) === key) {
            this.byUsername.delete(username.toLowerCase());
        }
        delete this.cache[key];
        if (value !== undefined) this.notify(this.removeListeners, key, value);
    }

    clear() {
        this.cache = {};
        this.byUsername.clear();
    }
    list() {
        return this.cache;
    }
    addNested(key: string, nestedKey: string, value: any) {
        if (!this.cache[key]) {
            this.cache[key] = {};
        }
        this.cache[key][nestedKey] = value;
    }
    set(key: string, value: any) {
        // A player handed to another node (cells phase 6) is gone from here: a write-back of an object held across
        // an await must not make it live on two nodes, nor replace the session that now has its id (a hand-back
        // keeps the id). Only the object the cache holds is written again.
        if (value?.handedOff === true && this.cache[key] !== value) return;
        this.cache[key] = value;
        this.index(key, value, false);
    }
    setNested(key: string, nestedKey: string, value: any) {
        if (!this.cache[key]) {
            this.cache[key] = {};
        }
        this.cache[key][nestedKey] = value;
    }
}

const playerCache: PlayerManager = new PlayerManager();
export default playerCache;
