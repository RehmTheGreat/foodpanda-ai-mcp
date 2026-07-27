export type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(
      `Upstream circuit breaker is open; refusing to send more requests for ${Math.ceil(retryAfterMs / 1000)}s. ` +
        `This protects the upstream API after repeated failures.`,
    );
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Circuit breaker, one instance per upstream host.
 *
 * closed    -> normal operation, failures counted
 * open      -> fail fast without touching the network, until resetMs elapses
 * half-open -> allow exactly one trial request; success closes, failure re-opens
 *
 * The point is to stop hammering an upstream that is already unhappy, and to
 * turn a slow cascade of timeouts into an immediate, explanatory error.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private halfOpenInFlight = false;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  get currentState(): BreakerState {
    this.maybeHalfOpen();
    return this.state;
  }

  private maybeHalfOpen(): void {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.resetMs) {
      this.state = 'half-open';
      this.halfOpenInFlight = false;
    }
  }

  /** Throws CircuitOpenError when the circuit is refusing traffic. */
  assertAllowed(): void {
    this.maybeHalfOpen();
    if (this.state === 'open') {
      throw new CircuitOpenError(Math.max(0, this.resetMs - (Date.now() - this.openedAt)));
    }
    if (this.state === 'half-open' && this.halfOpenInFlight) {
      throw new CircuitOpenError(this.resetMs);
    }
    if (this.state === 'half-open') this.halfOpenInFlight = true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
    this.halfOpenInFlight = false;
  }

  recordFailure(): void {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      this.halfOpenInFlight = false;
    }
  }

  stats() {
    return { state: this.currentState, failures: this.failures };
  }
}
