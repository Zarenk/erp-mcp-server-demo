export interface RateResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets (for the Retry-After header). */
  retryAfterSec: number;
}

/** Fixed-window counter. Simple, O(1), good enough for a demo (see README for the production notes). */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private nextSweep = 0;

  constructor(
    readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  hit(bucketId: string): RateResult {
    const t = this.now();
    this.sweep(t);
    let b = this.buckets.get(bucketId);
    if (!b || t >= b.resetAt) {
      b = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(bucketId, b);
    }
    b.count += 1;
    return {
      allowed: b.count <= this.limit,
      remaining: Math.max(0, this.limit - b.count),
      retryAfterSec: Math.max(1, Math.ceil((b.resetAt - t) / 1000)),
    };
  }

  /** Bucket ids currently tracked (exposed for tests: they must never contain raw keys). */
  bucketIds(): string[] {
    return [...this.buckets.keys()];
  }

  private sweep(t: number): void {
    if (t < this.nextSweep) return;
    this.nextSweep = t + this.windowMs;
    for (const [id, b] of this.buckets) if (t >= b.resetAt) this.buckets.delete(id);
  }
}
