/**
 * Persistence used by the monitor: watchlists, already-seen item ids and the
 * per-day action counters that cap likes and offers.
 *
 * Serverless functions keep no state between invocations, so anything that has
 * to survive a cron tick goes through a Store. Upstash Redis is used when its
 * REST credentials are present; otherwise an in-process map stands in so the
 * server still runs locally and in tests.
 */

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  sadd(key: string, ...members: string[]): Promise<void>;
  srem(key: string, ...members: string[]): Promise<void>;
  smembers(key: string): Promise<string[]>;
  /** Increments a counter and returns the new value. */
  incr(key: string, ttlSeconds?: number): Promise<number>;
  /** True when this store survives between invocations. */
  readonly durable: boolean;
}

import { getConfig } from "../config.js";
import { MemoryStore } from "./memory.js";
import { UpstashStore } from "./upstash.js";

let cached: Store | null = null;

export function getStore(): Store {
  if (cached) return cached;
  const { upstash } = getConfig();
  cached = upstash
    ? new UpstashStore(upstash.url, upstash.token)
    : new MemoryStore();
  return cached;
}

/** Test helper: forces the next getStore() to build a fresh instance. */
export function resetStoreCache(): void {
  cached = null;
}

/** Key builders, kept together so the layout stays greppable. */
export const keys = {
  watches: (accountId: string) => `watch:${accountId}`,
  watchMeta: (accountId: string, sellerId: string) =>
    `watch:${accountId}:${sellerId}:meta`,
  seen: (accountId: string, sellerId: string) =>
    `seen:${accountId}:${sellerId}`,
  finds: (accountId: string) => `finds:${accountId}`,
  find: (accountId: string, itemId: string) => `find:${accountId}:${itemId}`,
  likeCount: (accountId: string, day: string) => `cnt:like:${accountId}:${day}`,
  offerCount: (accountId: string, day: string) =>
    `cnt:offer:${accountId}:${day}`,
  hourCount: (accountId: string, hour: string) =>
    `cnt:hour:${accountId}:${hour}`,
  limits: (accountId: string) => `limits:${accountId}`,
  autopause: (accountId: string) => `autopause:${accountId}`,
  actionLog: (accountId: string) => `actionlog:${accountId}`,
  lastRun: () => `monitor:lastRun`,
};

/** UTC day stamp used to scope the per-day action counters. */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** UTC hour stamp used to scope the per-hour action counter. */
export function thisHour(now: Date = new Date()): string {
  return now.toISOString().slice(0, 13);
}
