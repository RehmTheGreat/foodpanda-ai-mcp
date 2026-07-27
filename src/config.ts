import { z } from 'zod';

/**
 * All configuration is optional. The server must run correctly with a completely
 * empty environment — that is a hard product requirement, not a convenience.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : !/^(false|0|no|off)$/i.test(v)));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
    });

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  MCP_TRANSPORT: z.enum(['stdio', 'http']).optional(),
  PORT: int(3000, 1, 65535),
  HOST: z.string().optional(),
  ALLOWED_ORIGINS: csv,
  ALLOWED_HOSTS: csv,

  FOODPANDA_DEFAULT_MARKET: z.string().optional(),
  FOODPANDA_LANGUAGE_ID: int(1, 1, 999),

  /**
   * Ceiling on how many nearby vendors a filtered search may scan.
   *
   * This bounds the LISTING host only, which has no page-size cap and is not the
   * bot-protected one, so a high value is cheap: a dense city of ~500 vendors is
   * two or three requests. It does NOT affect menu fetches, which hit the
   * rate-limited host and stay bounded by each tool's own limit.
   */
  FOODPANDA_MAX_SCAN: int(600, 20, 5000),
  /** Vendors requested per listing page. Upstream honours large values. */
  FOODPANDA_LISTING_PAGE_SIZE: int(200, 20, 400),

  // Deliberately conservative. The menu host sits behind PerimeterX and starts
  // serving bot challenges when one IP gets busy, so throughput is limited by
  // what the edge tolerates, not by what the API can serve.
  FOODPANDA_RATE_LIMIT_RPS: int(2, 1, 100),
  FOODPANDA_RATE_LIMIT_BURST: int(4, 1, 200),
  FOODPANDA_MAX_CONCURRENCY: int(2, 1, 32),
  FOODPANDA_TIMEOUT_MS: int(15_000, 1_000, 120_000),
  FOODPANDA_MAX_RETRIES: int(3, 0, 8),
  FOODPANDA_BREAKER_THRESHOLD: int(5, 1, 100),
  FOODPANDA_BREAKER_RESET_MS: int(30_000, 1_000, 600_000),

  CACHE_BACKEND: z.enum(['memory', 'redis']).optional(),
  CACHE_MAX_ENTRIES: int(500, 10, 100_000),
  CACHE_TTL_LISTING_S: int(120, 0, 86_400),
  // Vendor detail is the expensive, rate-limited call; cache it longer so
  // repeated menu work reuses one fetch.
  CACHE_TTL_VENDOR_S: int(900, 0, 86_400),
  CACHE_TTL_CONFIG_S: int(86_400, 0, 2_592_000),
  CACHE_TTL_GEOCODE_S: int(604_800, 0, 2_592_000),
  REDIS_URL: z.string().optional(),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'silent']).optional(),
  LOG_FORMAT: z.enum(['json', 'pretty']).optional(),

  GEOCODER_USER_AGENT: z.string().optional(),
  GEOCODER_ENABLED: bool(true),
});

export interface Config {
  transport: 'stdio' | 'http';
  port: number;
  host: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  defaultMarket: string;
  languageId: number;
  maxScan: number;
  listingPageSize: number;
  rateLimitRps: number;
  rateLimitBurst: number;
  maxConcurrency: number;
  timeoutMs: number;
  maxRetries: number;
  breakerThreshold: number;
  breakerResetMs: number;
  cacheBackend: 'memory' | 'redis';
  cacheMaxEntries: number;
  ttl: { listing: number; vendor: number; config: number; geocode: number };
  redisUrl: string | undefined;
  logLevel: 'error' | 'warn' | 'info' | 'debug' | 'silent';
  logFormat: 'json' | 'pretty';
  geocoderUserAgent: string;
  geocoderEnabled: boolean;
  userAgent: string;
}

export const SERVER_NAME = 'foodpanda-ai-mcp';
export const SERVER_VERSION = '0.2.1';

/**
 * A polite, honest, identifying User-Agent. We do not impersonate a browser:
 * the project is named, versioned and linkable so operators can identify and
 * contact the source of the traffic.
 */
const UA = `${SERVER_NAME}/${SERVER_VERSION} (+https://github.com/RehmTheGreat/foodpanda-ai-mcp)`;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  // Config must never be able to crash startup; fall back to defaults on a bad value.
  const e = parsed.success ? parsed.data : EnvSchema.parse({});

  // An explicit --http / --stdio flag beats the environment variable.
  const argv = process.argv.slice(2);
  const flagTransport = argv.includes('--http') ? 'http' : argv.includes('--stdio') ? 'stdio' : undefined;

  return {
    transport: flagTransport ?? e.MCP_TRANSPORT ?? 'stdio',
    port: e.PORT,
    host: e.HOST || '0.0.0.0',
    allowedOrigins: e.ALLOWED_ORIGINS.length ? e.ALLOWED_ORIGINS : ['*'],
    allowedHosts: e.ALLOWED_HOSTS,
    defaultMarket: (e.FOODPANDA_DEFAULT_MARKET || 'pk').toLowerCase(),
    languageId: e.FOODPANDA_LANGUAGE_ID,
    maxScan: e.FOODPANDA_MAX_SCAN,
    listingPageSize: e.FOODPANDA_LISTING_PAGE_SIZE,
    rateLimitRps: e.FOODPANDA_RATE_LIMIT_RPS,
    rateLimitBurst: e.FOODPANDA_RATE_LIMIT_BURST,
    maxConcurrency: e.FOODPANDA_MAX_CONCURRENCY,
    timeoutMs: e.FOODPANDA_TIMEOUT_MS,
    maxRetries: e.FOODPANDA_MAX_RETRIES,
    breakerThreshold: e.FOODPANDA_BREAKER_THRESHOLD,
    breakerResetMs: e.FOODPANDA_BREAKER_RESET_MS,
    cacheBackend: e.CACHE_BACKEND ?? 'memory',
    cacheMaxEntries: e.CACHE_MAX_ENTRIES,
    ttl: {
      listing: e.CACHE_TTL_LISTING_S,
      vendor: e.CACHE_TTL_VENDOR_S,
      config: e.CACHE_TTL_CONFIG_S,
      geocode: e.CACHE_TTL_GEOCODE_S,
    },
    redisUrl: e.REDIS_URL || undefined,
    logLevel: e.LOG_LEVEL ?? 'info',
    logFormat: e.LOG_FORMAT ?? 'json',
    geocoderUserAgent: e.GEOCODER_USER_AGENT || UA,
    geocoderEnabled: e.GEOCODER_ENABLED,
    userAgent: UA,
  };
}
