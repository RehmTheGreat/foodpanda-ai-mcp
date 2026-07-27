import type { Cache } from '../cache/index.js';
import type { Logger } from '../logger.js';
import { CircuitBreaker, CircuitOpenError } from './circuitBreaker.js';
import { RateLimiter } from './rateLimiter.js';

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly url: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/**
 * Raised when the upstream edge (PerimeterX) challenges the request instead of
 * serving it.
 *
 * This is explicitly NOT retried and NOT worked around. Defeating a bot
 * challenge would mean impersonating a browser and evading a control the site
 * operator deliberately put in place. The correct response is to stop, tell the
 * user plainly, and back off — which is what this error does.
 */
export class UpstreamBlockedError extends Error {
  constructor(readonly url: string) {
    super(
      'The upstream endpoint responded with a bot-protection challenge (HTTP 403) instead of data. ' +
        'This usually means too many requests came from this IP address recently. ' +
        'It normally clears on its own after a while. ' +
        'To reduce the chance of it recurring, lower FOODPANDA_RATE_LIMIT_RPS and FOODPANDA_MAX_CONCURRENCY, ' +
        'or use fewer menu-heavy calls (search_menu_items, or openNow filters) in quick succession. ' +
        'Restaurant search, cuisine browsing and deal listing use a different host and are usually still available.',
    );
    this.name = 'UpstreamBlockedError';
  }
}

/** PerimeterX challenge pages carry these markers regardless of status text. */
function looksLikeBotChallenge(body: string): boolean {
  return /"appId"\s*:\s*"PX|_pxhd|px-cloud\.net|Please confirm you are a human/i.test(body);
}

export interface HttpClientOptions {
  userAgent: string;
  timeoutMs: number;
  maxRetries: number;
  rateLimitRps: number;
  rateLimitBurst: number;
  maxConcurrency: number;
  breakerThreshold: number;
  breakerResetMs: number;
  cache: Cache;
  logger: Logger;
  /** Injection seam for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface GetJsonOptions {
  headers?: Record<string, string>;
  /** Cache TTL in seconds. 0 disables caching for this call. */
  ttlSeconds?: number;
  /** Overrides the cache key derived from the URL. */
  cacheKey?: string;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 530]);

/**
 * The single place in the codebase that performs network I/O.
 *
 * Layers, outermost first:
 *   cache -> in-flight coalescing -> circuit breaker -> rate limiter
 *         -> concurrency gate -> timeout -> retry with exponential backoff + jitter
 */
export class HttpClient {
  private readonly limiter: RateLimiter;
  private readonly breakers = new Map<string, CircuitBreaker>();
  /** Coalescing map: identical concurrent GETs share one upstream request. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly fetchImpl: typeof fetch;
  private requestCount = 0;
  private coalescedCount = 0;

  constructor(private readonly opts: HttpClientOptions) {
    this.limiter = new RateLimiter(opts.rateLimitRps, opts.rateLimitBurst, opts.maxConcurrency);
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  private breakerFor(url: string): CircuitBreaker {
    const host = new URL(url).host;
    let b = this.breakers.get(host);
    if (!b) {
      b = new CircuitBreaker(this.opts.breakerThreshold, this.opts.breakerResetMs);
      this.breakers.set(host, b);
    }
    return b;
  }

  async getJson<T = unknown>(url: string, options: GetJsonOptions = {}): Promise<T> {
    const key = options.cacheKey ?? `GET:${url}`;
    const ttl = options.ttlSeconds ?? 0;

    if (ttl > 0) {
      const cached = await this.opts.cache.get<T>(key);
      if (cached !== undefined) {
        this.opts.logger.debug('cache hit', { key });
        return cached;
      }
    }

    // Request coalescing: a second caller asking for the same thing while the
    // first is still in flight waits on that promise instead of issuing a
    // duplicate upstream request.
    const existing = this.inFlight.get(key);
    if (existing) {
      this.coalescedCount++;
      this.opts.logger.debug('coalesced onto in-flight request', { key });
      return existing as Promise<T>;
    }

    const promise = this.execute<T>(url, options)
      .then(async (value) => {
        if (ttl > 0) await this.opts.cache.set(key, value, ttl);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  private async execute<T>(url: string, options: GetJsonOptions): Promise<T> {
    const breaker = this.breakerFor(url);
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      breaker.assertAllowed();

      try {
        const result = await this.limiter.run(() => this.doFetch<T>(url, options));
        breaker.recordSuccess();
        return result;
      } catch (err) {
        lastErr = err;

        // A tripped breaker is not a transport failure; never retry through it.
        if (err instanceof CircuitOpenError) throw err;
        // Never retry a bot challenge — repeating it is exactly the behaviour
        // the challenge exists to stop.
        if (err instanceof UpstreamBlockedError) {
          breaker.recordFailure();
          throw err;
        }

        const retryable = err instanceof UpstreamError ? err.retryable : true;
        breaker.recordFailure();

        if (!retryable || attempt === this.opts.maxRetries) break;

        // Exponential backoff with full jitter, capped, so parallel clients do
        // not synchronise into a retry stampede.
        const base = Math.min(1000 * 2 ** attempt, 8000);
        const delay = Math.floor(Math.random() * base);
        this.opts.logger.warn('upstream request failed, retrying', {
          url,
          attempt: attempt + 1,
          maxRetries: this.opts.maxRetries,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastErr;
  }

  private async doFetch<T>(url: string, options: GetJsonOptions): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    // Honour a caller-supplied signal as well as our own timeout.
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const started = Date.now();
    this.requestCount++;

    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'user-agent': this.opts.userAgent,
          accept: 'application/json',
          ...(options.headers ?? {}),
        },
        signal: controller.signal,
      });

      const ms = Date.now() - started;
      const rlRemaining = res.headers.get('x-ratelimit-remaining');
      this.opts.logger.debug('upstream response', {
        url,
        status: res.status,
        ms,
        rateLimitRemaining: rlRemaining,
      });

      // If upstream tells us we are running out of budget, slow down proactively.
      if (rlRemaining !== null && Number(rlRemaining) < 10) {
        this.opts.logger.warn('upstream rate limit budget low', { remaining: rlRemaining, url });
      }

      if (!res.ok) {
        const retryable = RETRYABLE_STATUS.has(res.status);
        const body = await res.text().catch(() => '');

        // A bot challenge is a hard stop: retrying makes the situation worse and
        // circumventing it is not something this client will do.
        if (res.status === 403 && looksLikeBotChallenge(body)) {
          this.opts.logger.warn('upstream served a bot-protection challenge', { url, status: res.status });
          throw new UpstreamBlockedError(url);
        }

        throw new UpstreamError(
          `Upstream returned ${res.status} ${res.statusText} for ${new URL(url).pathname}${
            body ? `: ${body.slice(0, 200)}` : ''
          }`,
          res.status,
          url,
          retryable,
        );
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof UpstreamError || err instanceof UpstreamBlockedError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new UpstreamError(`Request timed out after ${this.opts.timeoutMs}ms`, undefined, url, true);
      }
      throw new UpstreamError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        url,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  stats() {
    return {
      requests: this.requestCount,
      coalesced: this.coalescedCount,
      limiter: this.limiter.stats(),
      breakers: Object.fromEntries([...this.breakers].map(([h, b]) => [h, b.stats()])),
      cache: this.opts.cache.stats(),
    };
  }
}
