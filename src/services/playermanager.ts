class PlayerManager {
    private cache: { [key: string]: any };
    // Lowercased username -> the key that player is held under.
    private byUsername = new Map<string, string>();

    constructor() {

        this.cache = {};
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
        const username = this.cache[key]?.username;
        if (typeof username === "string" && this.byUsername.get(username.toLowerCase()) === key) {
            this.byUsername.delete(username.toLowerCase());
        }
        delete this.cache[key];
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
