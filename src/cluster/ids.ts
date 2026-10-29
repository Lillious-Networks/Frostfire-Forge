import log from "../modules/logger";
import type { ClusterStore } from "./store";

// Ids that are unique across every node of the world: players (and, from
// phase 2, creatures, loot and the rest) keep theirs when they move to
// another node, and the client keys entities by them. Each node takes a block
// of ids at a time from one counter in Redis; the wire formats carry a u32.

export const ID_BLOCK = 65_536;
const COUNTER = "cells:ids";
const U32_MAX = 0xffff_ffff;
const RETRY_MAX_MS = 30_000;

export class IdAllocator {
  private nextId = 1;
  private last = 0;
  private spare: [number, number] | null = null;
  private fetching = false;
  private ready = false;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private readonly blocksPerCycle: number;

  // `retryMs`: the wait before a failed fetch of the next block is tried again (doubling, up to RETRY_MAX_MS).
  constructor(private store: ClusterStore, private blockSize = ID_BLOCK, private retryMs = 1000) {
    this.blocksPerCycle = Math.floor(U32_MAX / blockSize);
  }

  async init(): Promise<void> {
    [this.nextId, this.last] = await this.takeBlock();
    this.ready = true;
  }

  /** The next id, or null when this block is used up and the next one has not arrived. */
  tryNext(): number | null {
    if (!this.ready) return null;
    if (this.nextId > this.last) {
      if (!this.spare) {
        this.ensureSpare();
        return null;
      }
      [this.nextId, this.last] = this.spare;
      this.spare = null;
    }
    const id = this.nextId++;
    // Fetched early (half the block is left), so a slow Redis has a whole half block of ids to be slow in.
    if (this.last - this.nextId < this.blockSize / 2) this.ensureSpare();
    return id;
  }

  next(): number {
    const id = this.tryNext();
    if (id === null) throw new Error("No world ids left: the next block has not arrived");
    return id;
  }

  private ensureSpare(): void {
    if (this.spare || this.fetching || this.retry) return;
    this.fetching = true;
    this.takeBlock()
      .then((block) => {
        this.spare = block;
        this.failures = 0;
      })
      .catch((error) => {
        log.error(`Could not take a block of world ids: ${error}`);
        const wait = Math.min(this.retryMs * 2 ** this.failures++, RETRY_MAX_MS);
        this.retry = setTimeout(() => {
          this.retry = null;
          this.ensureSpare();
        }, wait);
        (this.retry as any).unref?.();
      })
      .finally(() => { this.fetching = false; });
  }

  // The counter only grows; the block it names wraps round the u32 range, so
  // two nodes taking blocks at the same moment still get different ones. Ids
  // from four billion ids ago belong to no one by the time they come round.
  private async takeBlock(): Promise<[number, number]> {
    const taken = await this.store.incrBy(COUNTER, this.blockSize);
    const index = (Math.floor(taken / this.blockSize) - 1) % this.blocksPerCycle;
    const first = index * this.blockSize + 1;
    return [first, first + this.blockSize - 1];
  }
}
