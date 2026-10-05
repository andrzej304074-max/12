import type { Store } from "./index.js";

interface Entry {
  value: unknown;
  expiresAt: number | null;
}

/**
 * In-process store for local development and tests.
 *
 * On Vercel each invocation may land on a fresh instance, so this loses data
 * between requests - the monitor reports it as non-durable rather than
 * pretending a watchlist was saved.
 */
export class MemoryStore implements Store {
  readonly durable = false;
  private readonly map = new Map<string, Entry>();
  private readonly sets = new Map<string, Set<string>>();

  private live(key: string): Entry | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.live(key);
    return entry ? (entry.value as T) : null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.map.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async setNx<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    if (this.live(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
    this.sets.delete(key);
  }

  async sadd(key: string, ...members: string[]): Promise<void> {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const member of members) set.add(member);
    this.sets.set(key, set);
  }

  async srem(key: string, ...members: string[]): Promise<void> {
    const set = this.sets.get(key);
    if (!set) return;
    for (const member of members) set.delete(member);
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const current = (await this.get<number>(key)) ?? 0;
    const next = current + 1;
    await this.set(key, next, ttlSeconds);
    return next;
  }
}
