// What the cluster keeps in Redis, behind the few calls it needs, so tests
// (and nodes sharing one process in a test) can use MemoryStore instead.

export interface ClusterStore {
  get(key: string): Promise<string | null>;
  /** `ttlMs` 0 or absent: the value does not expire. */
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Sets only when the key is absent; whether it did. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Reads and deletes the key in one step: only one caller can ever take a value. */
  take(key: string): Promise<string | null>;
  incrBy(key: string, amount: number): Promise<number>;
  /**
   * For JSON values with an `epoch` number: replaces the value only when the
   * one held has epoch `expectedEpoch` (an absent key has epoch 0).
   */
  swapIfEpoch(key: string, expectedEpoch: number, value: string): Promise<boolean>;
  /** Deletes the key only when its value has epoch `epoch`. */
  deleteIfEpoch(key: string, epoch: number): Promise<boolean>;
  /**
   * Sets the key to go after `ttlMs` (replacing any earlier time) only when its value
   * has epoch `epoch`, in one step: a lock renewed this way never loses its ttl.
   */
  renewIfEpoch(key: string, epoch: number, ttlMs: number): Promise<boolean>;
  addToSet(key: string, member: string): Promise<void>;
  removeFromSet(key: string, member: string): Promise<void>;
  members(key: string): Promise<string[]>;
  /** The key (a value or a set) goes after `ttlMs`; a later `expire` replaces the time. */
  expire(key: string, ttlMs: number): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  /** Stops one handler; the channel is left when it has none. Unknown handlers are ignored. */
  unsubscribe(channel: string, handler: (message: string) => void): Promise<void>;
  close(): void;
  /** False while the store cannot be reached; callers treat a store without it as up. */
  isUp?(): boolean;
}
