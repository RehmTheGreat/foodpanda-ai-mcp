import type { Cache } from './index.js';
import type { Logger } from '../logger.js';

/**
 * Optional Redis backend.
 *
 * `redis` is NOT a declared dependency — this module is only ever reached via a
 * dynamic import from createCache() when CACHE_BACKEND=redis. Users who want it
 * run `npm install redis`. Keeping it out of the dependency tree means the
 * default install stays small and the server keeps its zero-config promise.
 */
export class RedisCache implements Cache {
  private hits = 0;
  private misses = 0;

  private constructor(
    private readonly client: any,
    private readonly logger: Logger,
  ) {}

  static async connect(url: string, logger: Logger): Promise<RedisCache> {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - optional peer dependency, absent from the default install
    const mod: any = await import('redis');
    const client = mod.createClient({ url });
    client.on('error', (e: unknown) =>
      logger.warn('redis client error', { error: e instanceof Error ? e.message : String(e) }),
    );
    await client.connect();
    return new RedisCache(client, logger);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.client.get(key);
      if (raw == null) {
        this.misses++;
        return undefined;
      }
      this.hits++;
      return JSON.parse(raw) as T;
    } catch (err) {
      // A cache failure must degrade to a cache miss, never to a request failure.
      this.logger.warn('redis get failed', { error: err instanceof Error ? err.message : String(err) });
      this.misses++;
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    try {
      await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (err) {
      this.logger.warn('redis set failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch {
      /* ignore */
    }
  }

  async clear(): Promise<void> {
    try {
      await this.client.flushDb();
    } catch {
      /* ignore */
    }
  }

  stats() {
    return { hits: this.hits, misses: this.misses, size: -1, backend: 'redis' };
  }
}
