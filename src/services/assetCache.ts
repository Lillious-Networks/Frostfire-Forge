import { sharedRedis } from "./redisclient";

type RedisValue = any;

// Who wants to know when a key is written here, for what they keep of it in memory (the sheets of the items, say).
// A write made by another process (a node of the cluster, on a shared Redis) is not heard: a listener that must
// see those too refreshes on a timer as well.
const changeListeners = new Map<string, Set<() => void>>();

function changed(key: string): void {
  for (const listener of changeListeners.get(key) ?? []) {
    try {
      listener();
    } catch {
      // A listener must not undo a write.
    }
  }
}

function changedAll(): void {
  for (const key of changeListeners.keys()) changed(key);
}

interface CacheService {
  add(key: string, value: any): Promise<void>;
  get(key: string): Promise<any>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  list(): Promise<Record<string, RedisValue>>;
  addNested(key: string, nestedKey: string, value: RedisValue): Promise<void>;
  getNested(key: string, nestedKey: string): Promise<RedisValue>;
  removeNested(key: string, nestedKey: string): Promise<void>;
  set(key: string, value: any): Promise<void>;
  setNested(key: string, nestedKey: string, value: RedisValue): Promise<void>;
  getAll(): Promise<Record<string, RedisValue>>;
  close(): void;
  /** Calls `listener` after `key` is written or removed through this cache (clear() counts for every key). */
  onChange(key: string, listener: () => void): void;
}

class MemoryCacheService implements CacheService {
  private cache = new Map<string, any>();
  private hashes = new Map<string, Map<string, any>>();
  private prefix: string;

  constructor(prefix = "asset:") {
    this.prefix = prefix;
  }

  private prefixed(key: string) {
    return `${this.prefix}${key}`;
  }

  async add(key: string, value: any): Promise<void> {
    this.cache.set(this.prefixed(key), value);
    changed(key);
  }

  async get(key: string): Promise<any> {
    return this.cache.get(this.prefixed(key)) ?? null;
  }

  async remove(key: string): Promise<void> {
    this.cache.delete(this.prefixed(key));
    this.hashes.delete(this.prefixed(key));
    changed(key);
  }

  async clear(): Promise<void> {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(this.prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }

    const hashesToDelete: string[] = [];
    for (const key of this.hashes.keys()) {
      if (key.startsWith(this.prefix)) {
        hashesToDelete.push(key);
      }
    }
    for (const key of hashesToDelete) {
      this.hashes.delete(key);
    }
    changedAll();
  }

  async list(): Promise<Record<string, RedisValue>> {
    const out: Record<string, RedisValue> = {};
    for (const [key, value] of this.cache.entries()) {
      if (key.startsWith(this.prefix)) {
        const shortKey = key.slice(this.prefix.length);
        out[shortKey] = value;
      }
    }
    return out;
  }

  async addNested(key: string, nestedKey: string, value: RedisValue): Promise<void> {
    const prefixedKey = this.prefixed(key);
    if (!this.hashes.has(prefixedKey)) {
      this.hashes.set(prefixedKey, new Map());
    }
    this.hashes.get(prefixedKey)!.set(nestedKey, value);
  }

  async getNested(key: string, nestedKey: string): Promise<RedisValue> {
    const prefixedKey = this.prefixed(key);
    const hash = this.hashes.get(prefixedKey);
    return hash?.get(nestedKey) ?? undefined;
  }

  async removeNested(key: string, nestedKey: string): Promise<void> {
    const prefixedKey = this.prefixed(key);
    const hash = this.hashes.get(prefixedKey);
    if (hash) {
      hash.delete(nestedKey);
    }
  }

  async set(key: string, value: any): Promise<void> {
    await this.add(key, value);
  }

  async setNested(key: string, nestedKey: string, value: RedisValue): Promise<void> {
    await this.addNested(key, nestedKey, value);
  }

  async getAll(): Promise<Record<string, RedisValue>> {
    return await this.list();
  }

  close(): void {
    this.cache.clear();
    this.hashes.clear();
  }

  onChange(key: string, listener: () => void): void {
    (changeListeners.get(key) ?? changeListeners.set(key, new Set()).get(key)!).add(listener);
  }
}

class RedisCacheService implements CacheService {
  private client: any;
  private prefix: string;

  constructor(prefix = "asset:", client: any = sharedRedis()) {
    this.prefix = prefix;
    // Not Bun's `redis` singleton: that one stops reconnecting after a long outage (services/redisclient.ts).
    this.client = client;
  }

  private prefixed(key: string) {
    return `${this.prefix}${key}`;
  }

  private reconstructBuffers(obj: any, depth: number = 0): any {
    if (!obj || typeof obj !== 'object') return obj;

    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return Buffer.from(obj.data);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.reconstructBuffers(item, depth + 1));
    }

    const result: any = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = this.reconstructBuffers(obj[key], depth + 1);
      }
    }
    return result;
  }

  private async safeSend<T = any>(cmd: string, args: string[]): Promise<T> {
    const key = args[0];
    try {
      return await this.client.send(cmd, args);
    } catch (e: any) {
      let type: string | null = null;
      try {
        type = await this.client.send("TYPE", [key]);
      } catch {
        type = "unknown";
      }

      console.error(
        `[RedisDebug] ERROR on ${cmd} ${args.join(" ")} | key=${key} | type=${type}`
      );
      console.error(new Error("[RedisDebug] stack trace").stack);
      throw e;
    }
  }

  private async ensureHashKey(key: string): Promise<void> {
    const type = await this.safeSend("TYPE", [this.prefixed(key)]);
    if (type !== "none" && type !== "hash") {
      await this.safeSend("DEL", [this.prefixed(key)]);
    }
  }

  async add(key: string, value: any) {
    const data = typeof value === "string" ? value : JSON.stringify(value);
    await this.client.set(this.prefixed(key), data);
    changed(key);
  }

  async get(key: string) {
    const data = await this.client.get(this.prefixed(key));
    if (!data) return null;
    try {
      const parsed = JSON.parse(data);

      return this.reconstructBuffers(parsed);
    } catch {
      return data;
    }
  }

  /**
   * Like get, but when the stored text is the one `digest` was made of (length and hash), nothing is parsed or copied
   * and `same` is true. Lets a holder of a big list see that it did not change without paying for a copy of it.
   */
  async getIfChanged(key: string, digest: string | null): Promise<{ digest: string; same: boolean; value?: any }> {
    const data = await this.client.get(this.prefixed(key));
    if (!data) return { digest: "", same: digest === "", value: null };
    const now = `${data.length}:${Bun.hash(data)}`;
    if (now === digest) return { digest: now, same: true };
    let value: any;
    try {
      value = this.reconstructBuffers(JSON.parse(data));
    } catch {
      value = data;
    }
    return { digest: now, same: false, value };
  }

  async remove(key: string): Promise<void> {
    await this.safeSend("DEL", [this.prefixed(key)]);
    changed(key);
  }

  async clear(): Promise<void> {
    const pattern = this.prefix + "*";
    const keys = (await this.safeSend<string[]>("KEYS", [pattern])) ?? [];
    if (keys.length === 0) return;

    const chunkSize = 500;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      await this.safeSend("DEL", chunk);
    }
    changedAll();
  }

  async list(): Promise<Record<string, RedisValue>> {
    const pattern = this.prefix + "*";
    const keys = (await this.safeSend<string[]>("KEYS", [pattern])) ?? [];
    const out: Record<string, RedisValue> = {};
    if (keys.length === 0) return out;

    const stringKeys: string[] = [];
    for (const k of keys) {
      const type = await this.safeSend("TYPE", [k]);
      if (type === "string") stringKeys.push(k);
    }

    const values = (await this.safeSend<(string | null)[]>("MGET", stringKeys)) ?? [];
    for (let i = 0; i < stringKeys.length; i++) {
      const shortKey = stringKeys[i].slice(this.prefix.length);
      if (values[i] === null) {
        out[shortKey] = undefined;
      } else {
        const parsed = JSON.parse(values[i] as string);

        out[shortKey] = this.reconstructBuffers(parsed);
      }
    }
    return out;
  }

  async addNested(key: string, nestedKey: string, value: RedisValue): Promise<void> {
    await this.ensureHashKey(key);
    await this.safeSend("HSET", [this.prefixed(key), nestedKey, JSON.stringify(value)]);
  }

  async getNested(key: string, nestedKey: string): Promise<RedisValue> {
    await this.ensureHashKey(key);
    const raw = await this.safeSend<string | null>("HGET", [this.prefixed(key), nestedKey]);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw);

    return this.reconstructBuffers(parsed);
  }

  async removeNested(key: string, nestedKey: string): Promise<void> {
    await this.ensureHashKey(key);
    await this.safeSend("HDEL", [this.prefixed(key), nestedKey]);
  }

  async set(key: string, value: any) {
    await this.add(key, value);
  }

  async setNested(key: string, nestedKey: string, value: RedisValue): Promise<void> {
    await this.addNested(key, nestedKey, value);
  }

  close(): void {
    if (typeof (this.client as any).close === "function") {
      (this.client as any).close();
    }
  }

  onChange(key: string, listener: () => void): void {
    (changeListeners.get(key) ?? changeListeners.set(key, new Set()).get(key)!).add(listener);
  }

  async getAll(): Promise<Record<string, RedisValue>> {
    return await this.list();
  }
}

const cacheType = process.env.CACHE?.toLowerCase() || "memory";
const assetCache: CacheService = cacheType === "redis"
  ? new RedisCacheService()
  : new MemoryCacheService();

export default assetCache;