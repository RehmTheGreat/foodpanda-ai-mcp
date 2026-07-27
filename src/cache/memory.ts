import type { Cache } from './index.js';

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * TTL + LRU in-memory cache.
 *
 * LRU is implemented by exploiting the insertion-order guarantee of Map: a read
 * deletes and re-inserts the key, moving it to the end, so the oldest key is
 * always the first one Map iteration yields. Bounded by `maxEntries` so a
 * long-running server cannot grow without limit.
 */
export class MemoryCache implements Cache {
  private readonly store = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxEntries: number = 500) {}

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return; // caching disabled for this class of data
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  stats() {
    return { hits: this.hits, misses: this.misses, size: this.store.size, backend: 'memory' };
  }
}
