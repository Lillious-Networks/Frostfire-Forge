import { redis } from "bun";

type RedisValue = any;

class AssetCacheService {
  private client = redis;
  private prefix: string;

  constructor(prefix = "asset:") {
    this.prefix = prefix;
  }

  private prefixed(key: string) {
    return `${this.prefix}${key}`;
  }

  private async logRedisType(key: string) {
    try {
      const type = await this.client.send("TYPE", [this.prefixed(key)]);

      return type;
    } catch (e) {
      console.error(`[RedisDebug] Failed to get type for key ${this.prefixed(key)}:`, e);
      return null;
    }
  }

  async add(key: string, value: RedisValue): Promise<void> {
    await this.logRedisType(key);
    await this.client.set(this.prefixed(key), JSON.stringify(value));
  }

  async get(key: string): Promise<RedisValue> {
    await this.logRedisType(key);
    const raw = await this.client.get(this.prefixed(key));
    return raw === null ? undefined : JSON.parse(raw);
  }

  async remove(key: string): Promise<void> {
    await this.logRedisType(key);
    await this.client.del(this.prefixed(key));
  }

  async clear(): Promise<void> {
    const pattern = this.prefix + "*";
    const keys = (await this.client.send("KEYS", [pattern])) as string[] | null;
    if (!keys || keys.length === 0) return;

    const chunkSize = 500;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      await this.client.send("DEL", chunk);
    }
  }

  async list(): Promise<Record<string, RedisValue>> {
    const pattern = this.prefix + "*";
    const keys = (await this.client.send("KEYS", [pattern])) as string[] | null;
    const out: Record<string, RedisValue> = {};
    if (!keys || keys.length === 0) return out;

    const values = (await this.client.send("MGET", keys)) as (string | null)[];
    for (let i = 0; i < keys.length; i++) {
      const shortKey = keys[i].slice(this.prefix.length);
      out[shortKey] = values[i] === null ? undefined : JSON.parse(values[i] as string);
    }
    return out;
  }

  async addNested(key: string, nestedKey: string, value: RedisValue): Promise<void> {
    const type = await this.logRedisType(key);
    if (type && type !== "none" && type !== "hash") {
      console.warn(`[RedisDebug] WARNING: Key ${this.prefixed(key)} exists as ${type}, cannot HSET`);
    }
    await this.client.send("HSET", [this.prefixed(key), nestedKey, JSON.stringify(value)]);
  }

  async getNested(key: string, nestedKey: string): Promise<RedisValue> {
    const type = await this.logRedisType(key);
    if (type && type !== "hash") {
      console.warn(`[RedisDebug] WARNING: Key ${this.prefixed(key)} exists as ${type}, cannot HGET`);
    }
    const raw = (await this.client.send("HGET", [this.prefixed(key), nestedKey])) as string | null;
    return raw === null ? undefined : JSON.parse(raw);
  }

  async removeNested(key: string, nestedKey: string): Promise<void> {
    const type = await this.logRedisType(key);
    if (type && type !== "hash") {
      console.warn(`[RedisDebug] WARNING: Key ${this.prefixed(key)} exists as ${type}, cannot HDEL`);
    }
    await this.client.send("HDEL", [this.prefixed(key), nestedKey]);
  }

  async set(key: string, value: RedisValue): Promise<void> {
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
}

const assetCache = new AssetCacheService();
export default assetCache;
