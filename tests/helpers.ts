import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient } from '../src/http/client.js';
import { MemoryCache } from '../src/cache/memory.js';
import { nullLogger } from '../src/logger.js';
import { loadConfig, type Config } from '../src/config.js';
import { FoodpandaAdapter } from '../src/adapters/foodpanda.js';
import { GeocodeAdapter } from '../src/adapters/geocode.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

export interface RouteSpec {
  /** Substring or regexp matched against the request URL. */
  match: string | RegExp;
  status?: number;
  body?: unknown;
  /** Raw text body, used for non-JSON responses such as challenge pages. */
  text?: string;
  headers?: Record<string, string>;
  /**
   * Build the body from the request URL. Needed to emulate offset pagination,
   * where the response depends on the limit/offset the caller asked for.
   * Takes precedence over `body`.
   */
  handler?: (url: string) => unknown;
}

export interface StubFetch {
  impl: typeof fetch;
  calls: string[];
}

/** Build a fetch stub that serves fixtures by URL pattern. */
export function stubFetch(routes: RouteSpec[]): StubFetch {
  const calls: string[] = [];

  const impl = (async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);

    const route = routes.find((r) =>
      typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url),
    );

    if (!route) {
      return new Response(JSON.stringify({ error: 'no stub route' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    const body =
      route.text ?? JSON.stringify(route.handler ? route.handler(url) : (route.body ?? {}));
    return new Response(body, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  }) as typeof fetch;

  return { impl, calls };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    // Tests must not sleep on retry backoff or rate limiting.
    rateLimitRps: 1000,
    rateLimitBurst: 1000,
    maxConcurrency: 16,
    maxRetries: 0,
    timeoutMs: 2000,
    ttl: { listing: 0, vendor: 0, config: 0, geocode: 0 },
    ...overrides,
  };
}

export function makeClient(routes: RouteSpec[], config: Config = testConfig()) {
  const stub = stubFetch(routes);
  const http = new HttpClient({
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    rateLimitRps: config.rateLimitRps,
    rateLimitBurst: config.rateLimitBurst,
    maxConcurrency: config.maxConcurrency,
    breakerThreshold: config.breakerThreshold,
    breakerResetMs: config.breakerResetMs,
    cache: new MemoryCache(100),
    logger: nullLogger,
    fetchImpl: stub.impl,
  });
  return { http, stub, config };
}

export function makeAdapter(routes: RouteSpec[], config: Config = testConfig()) {
  const { http, stub } = makeClient(routes, config);
  return {
    adapter: new FoodpandaAdapter(http, config, nullLogger),
    geocoder: new GeocodeAdapter(http, config),
    http,
    stub,
    config,
  };
}

/** The standard happy-path route table used by most tests. */
export function defaultRoutes(): RouteSpec[] {
  return [
    { match: 'disco.deliveryhero.io', body: fixture('listing-pk.json') },
    { match: '/api/v5/configuration', body: fixture('configuration-pk.json') },
    { match: '/api/v5/vendors/', body: fixture('vendor-detail-pk.json') },
    { match: 'nominatim.openstreetmap.org/search', body: fixture('nominatim-search.json') },
  ];
}
