import { describe, it, expect } from 'vitest';
import { makeClient, testConfig, fixture } from './helpers.js';
import { UpstreamBlockedError, UpstreamError, HttpClient } from '../src/http/client.js';
import { CircuitBreaker, CircuitOpenError } from '../src/http/circuitBreaker.js';
import { RateLimiter } from '../src/http/rateLimiter.js';
import { MemoryCache } from '../src/cache/memory.js';
import { nullLogger } from '../src/logger.js';

describe('HttpClient', () => {
  it('returns parsed JSON on success', async () => {
    const { http } = makeClient([{ match: 'example.test', body: { ok: true } }]);
    await expect(http.getJson('https://example.test/x')).resolves.toEqual({ ok: true });
  });

  it('detects a real PerimeterX challenge and refuses to retry it', async () => {
    // The fixture is a genuine captured challenge body, not an invented string.
    const challenge = fixture('perimeterx-403.json');
    const { http, stub } = makeClient(
      [{ match: 'blocked.test', status: 403, body: challenge }],
      testConfig({ maxRetries: 3 }),
    );

    await expect(http.getJson('https://blocked.test/v')).rejects.toBeInstanceOf(UpstreamBlockedError);
    // Exactly one attempt: retrying a bot challenge is the wrong behaviour.
    expect(stub.calls).toHaveLength(1);
  });

  it('explains what to do when blocked', async () => {
    const { http } = makeClient([{ match: 'blocked.test', status: 403, body: fixture('perimeterx-403.json') }]);
    await expect(http.getJson('https://blocked.test/v')).rejects.toThrow(/bot-protection|403/i);
  });

  it('gives caller-actionable advice instead of unsettable server env vars (Bug 5)', async () => {
    const { http } = makeClient([{ match: 'blocked.test', status: 403, body: fixture('perimeterx-403.json') }]);
    let message = '';
    try {
      await http.getJson('https://blocked.test/v');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // A hosted MCP client cannot set the server's environment, so telling it
    // to change FOODPANDA_RATE_LIMIT_RPS / FOODPANDA_MAX_CONCURRENCY is advice
    // it cannot act on.
    expect(message).not.toMatch(/FOODPANDA_RATE_LIMIT_RPS|FOODPANDA_MAX_CONCURRENCY/);
    expect(message).toMatch(/wait|retry/i);
    expect(message).toMatch(/restaurantLimit|fewer/i);
  });

  it('explains a "vendor does not deliver here" response in plain English (Bug 5)', async () => {
    const { http } = makeClient([{ match: 'x.test', status: 400, body: fixture('vendor-not-deliverable-400.json') }]);
    let message = '';
    try {
      await http.getJson('https://x.test/v');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/does not deliver|cannot deliver/i);
    // A clean sentence, not a slice of the raw upstream JSON dump.
    expect(message).not.toMatch(/[{}"]/);
    expect(message).not.toContain('exception_type');
  });

  it('treats a plain 403 without a challenge body as an ordinary error', async () => {
    const { http } = makeClient([{ match: 'x.test', status: 403, body: { error: 'Invalid Client ID' } }]);
    await expect(http.getJson('https://x.test/v')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('retries retryable statuses then succeeds', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return n < 3
        ? new Response('{}', { status: 503 })
        : new Response(JSON.stringify({ ok: n }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const http = new HttpClient({
      ...baseOpts(),
      maxRetries: 3,
      fetchImpl: impl,
    });
    await expect(http.getJson('https://retry.test/a')).resolves.toEqual({ ok: 3 });
    expect(n).toBe(3);
  });

  it('does not retry a 404', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const http = new HttpClient({ ...baseOpts(), maxRetries: 3, fetchImpl: impl });
    await expect(http.getJson('https://nf.test/a')).rejects.toBeInstanceOf(UpstreamError);
    expect(n).toBe(1);
  });

  it('serves the second identical request from cache', async () => {
    const { http, stub } = makeClient([{ match: 'c.test', body: { v: 1 } }]);
    await http.getJson('https://c.test/a', { ttlSeconds: 60 });
    await http.getJson('https://c.test/a', { ttlSeconds: 60 });
    expect(stub.calls).toHaveLength(1);
  });

  it('coalesces concurrent identical requests into one upstream call', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const impl = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const http = new HttpClient({ ...baseOpts(), fetchImpl: impl });
    await Promise.all([
      http.getJson('https://same.test/a'),
      http.getJson('https://same.test/a'),
      http.getJson('https://same.test/a'),
    ]);
    expect(maxInFlight).toBe(1);
    expect(http.stats().coalesced).toBe(2);
  });

  it('opens the circuit after repeated failures and then fails fast', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    const http = new HttpClient({
      ...baseOpts(),
      maxRetries: 0,
      breakerThreshold: 3,
      breakerResetMs: 60_000,
      fetchImpl: impl,
    });

    for (let i = 0; i < 3; i++) {
      await expect(http.getJson(`https://brk.test/${i}`)).rejects.toBeTruthy();
    }
    const before = n;
    await expect(http.getJson('https://brk.test/next')).rejects.toBeInstanceOf(CircuitOpenError);
    // Circuit is open: no further network calls were made.
    expect(n).toBe(before);
  });

  it('reports a timeout as a retryable upstream error', async () => {
    const impl = (async (_u: any, init: any) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      })) as typeof fetch;

    const http = new HttpClient({ ...baseOpts(), timeoutMs: 40, maxRetries: 0, fetchImpl: impl });
    await expect(http.getJson('https://slow.test/a')).rejects.toThrow(/timed out/i);
  });
});

describe('CircuitBreaker', () => {
  it('closes again after a successful trial request', () => {
    const b = new CircuitBreaker(2, 0);
    b.recordFailure();
    b.recordFailure();
    expect(b.currentState).toBe('half-open'); // resetMs=0 -> immediately trialable
    b.assertAllowed();
    b.recordSuccess();
    expect(b.currentState).toBe('closed');
  });

  it('re-opens when the trial request also fails', () => {
    const b = new CircuitBreaker(1, 0);
    b.recordFailure();
    b.assertAllowed();
    b.recordFailure();
    expect(['open', 'half-open']).toContain(b.currentState);
  });
});

describe('RateLimiter', () => {
  it('never exceeds the configured concurrency', async () => {
    const limiter = new RateLimiter(1000, 1000, 2);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        limiter.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('throttles sustained throughput to roughly the configured rate', async () => {
    const limiter = new RateLimiter(20, 1, 8); // 20/s, burst 1
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 5 }, () => limiter.run(async () => {})));
    // 4 tokens must be regenerated at 20/s => at least ~150ms.
    expect(Date.now() - t0).toBeGreaterThan(120);
  });
});

describe('MemoryCache', () => {
  it('expires entries once the TTL elapses', async () => {
    const c = new MemoryCache(10);
    await c.set('k', 'v', 0.05);
    expect(await c.get('k')).toBe('v');
    await new Promise((r) => setTimeout(r, 80));
    expect(await c.get('k')).toBeUndefined();
  });

  it('evicts least-recently-used entries past the bound', async () => {
    const c = new MemoryCache(2);
    await c.set('a', 1, 60);
    await c.set('b', 2, 60);
    await c.get('a'); // refresh a's recency so b becomes oldest
    await c.set('c', 3, 60);
    expect(await c.get('b')).toBeUndefined();
    expect(await c.get('a')).toBe(1);
    expect(await c.get('c')).toBe(3);
  });

  it('ignores a non-positive TTL', async () => {
    const c = new MemoryCache(10);
    await c.set('k', 'v', 0);
    expect(await c.get('k')).toBeUndefined();
  });
});

function baseOpts() {
  const cfg = testConfig();
  return {
    userAgent: cfg.userAgent,
    timeoutMs: cfg.timeoutMs,
    maxRetries: 0,
    rateLimitRps: 1000,
    rateLimitBurst: 1000,
    maxConcurrency: 16,
    breakerThreshold: 100,
    breakerResetMs: 1000,
    cache: new MemoryCache(50),
    logger: nullLogger,
  };
}
