/**
 * Token-bucket rate limiter plus a concurrency gate.
 *
 * Upstream advertises ~100 requests per window via x-ratelimit-limit (observed
 * during research). We deliberately run an order of magnitude below that: this
 * is an unofficial client of someone else's API, so being a quiet neighbour
 * matters more than being fast.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly maxConcurrency: number,
  ) {
    this.tokens = burst;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.ratePerSecond);
    this.lastRefill = now;
  }

  /** Milliseconds until at least one token is available. */
  private waitTime(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
  }

  async acquire(): Promise<void> {
    // Concurrency gate first.
    if (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inFlight++;

    // Then the token bucket.
    for (;;) {
      const wait = this.waitTime();
      if (wait === 0) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  stats() {
    return { tokens: Math.floor(this.tokens), inFlight: this.inFlight, queued: this.queue.length };
  }
}
