import type { Logger } from '../logger.js';
import { MemoryCache } from './memory.js';

/**
 * Minimal async cache contract. Deliberately tiny so alternative backends
 * (Redis, Cloudflare KV, Deno KV) are trivial to implement.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  stats(): { hits: number; misses: number; size: number; backend: string };
}

export interface CacheOptions {
  backend: 'memory' | 'redis';
  maxEntries: number;
  redisUrl?: string | undefined;
  logger: Logger;
}

/**
 * Redis is an *optional* dependency: it is imported dynamically and only when
 * explicitly requested. If it is not installed or cannot connect, we log and
 * fall back to memory rather than failing startup — a cache is an optimisation,
 * never a correctness requirement.
 */
export async function createCache(opts: CacheOptions): Promise<Cache> {
  if (opts.backend === 'redis') {
    if (!opts.redisUrl) {
      opts.logger.warn('CACHE_BACKEND=redis but REDIS_URL is empty; using in-memory cache');
      return new MemoryCache(opts.maxEntries);
    }
    try {
      const { RedisCache } = await import('./redis.js');
      const cache = await RedisCache.connect(opts.redisUrl, opts.logger);
      opts.logger.info('cache backend ready', { backend: 'redis' });
      return cache;
    } catch (err) {
      opts.logger.warn('redis cache unavailable, falling back to memory', {
        error: err instanceof Error ? err.message : String(err),
      });
      return new MemoryCache(opts.maxEntries);
    }
  }
  return new MemoryCache(opts.maxEntries);
}

export { MemoryCache };
