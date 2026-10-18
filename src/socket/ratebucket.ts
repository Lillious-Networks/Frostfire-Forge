/**
 * A token bucket: up to `burst` at once, refilled at `perSec` a second. `take`
 * is false (and takes nothing) when the bucket is empty. A rate that is not a
 * positive number means no limit.
 */
export class RateBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly perSec: number, private readonly burst: number, now = Date.now()) {
    this.tokens = burst;
    this.last = now;
  }

  get unlimited(): boolean {
    return !(this.perSec > 0) || !(this.burst > 0) || !Number.isFinite(this.perSec) || this.perSec >= Number.MAX_SAFE_INTEGER;
  }

  take(now = Date.now()): boolean {
    if (this.unlimited) return true;
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.perSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
