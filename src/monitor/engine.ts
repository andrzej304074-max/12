import { getConfig, type VintedAccount } from "../config.js";
import { log } from "../log.js";
import { getStore, keys } from "../store/index.js";
import { getSellerItems } from "../vinted/search.js";
import type { NormalisedItem } from "../vinted/types.js";

/**
 * Watchlist polling.
 *
 * A pass fetches each watched seller's newest listings, diffs them against the
 * ids already seen, and records anything new as a "find" with a suggested
 * negotiation price.
 *
 * A pass never contacts the seller. Detection and contact are separate on
 * purpose: findings sit in the store until a person reviews them, so an
 * automated poll can never turn into an automated approach to a stranger.
 */

export interface Watch {
  sellerId: string;
  /** Login captured when the watch was created, for readable output. */
  sellerLogin: string | null;
  addedAt: string;
  domain: string | null;
  /** Overrides the global discount for this seller, as a percentage. */
  discountPct: number | null;
}

export interface Find {
  itemId: string;
  accountId: string;
  sellerId: string;
  sellerLogin: string | null;
  title: string;
  askingPrice: number | null;
  currency: string | null;
  suggestedOfferPrice: number | null;
  discountPct: number;
  url: string | null;
  photoUrl: string | null;
  detectedAt: string;
  /** Set once a person has acted on it, so it stops resurfacing. */
  handledAt?: string;
}

/** Applies the negotiation discount, rounded to whole currency units. */
export function offerPriceFor(
  asking: number | null,
  discountPct: number,
): number | null {
  if (asking === null || !Number.isFinite(asking) || asking <= 0) return null;
  const pct = Math.min(Math.max(discountPct, 0), 90);
  const raw = asking * (1 - pct / 100);
  // Vinted offers are whole units; never round down to zero.
  return Math.max(1, Math.round(raw));
}

export async function listWatches(accountId: string): Promise<Watch[]> {
  const store = getStore();
  const ids = await store.smembers(keys.watches(accountId));
  const watches: Watch[] = [];
  for (const sellerId of ids) {
    const meta = await store.get<Watch>(keys.watchMeta(accountId, sellerId));
    watches.push(
      meta ?? {
        sellerId,
        sellerLogin: null,
        addedAt: "unknown",
        domain: null,
        discountPct: null,
      },
    );
  }
  return watches;
}

export async function addWatch(
  accountId: string,
  watch: Watch,
): Promise<void> {
  const store = getStore();
  await store.sadd(keys.watches(accountId), watch.sellerId);
  await store.set(keys.watchMeta(accountId, watch.sellerId), watch);
}

export async function removeWatch(
  accountId: string,
  sellerId: string,
): Promise<void> {
  const store = getStore();
  await store.srem(keys.watches(accountId), sellerId);
  await store.del(keys.watchMeta(accountId, sellerId));
  await store.del(keys.seen(accountId, sellerId));
}

/**
 * Records the seller's current listings as already seen without emitting
 * finds, so adding a watch does not immediately produce a backlog of every
 * item the seller has ever posted.
 */
export async function seedWatch(
  accountId: string,
  sellerId: string,
  items: NormalisedItem[],
): Promise<number> {
  const store = getStore();
  const ids = items.map((i) => i.id);
  if (ids.length) await store.sadd(keys.seen(accountId, sellerId), ...ids);
  return ids.length;
}

export interface PassResult {
  accountId: string;
  sellersChecked: number;
  newFinds: Find[];
  errors: { sellerId: string; message: string }[];
}

/** Runs one monitoring pass for a single account. */
export async function runPassForAccount(
  account: VintedAccount,
): Promise<PassResult> {
  const cfg = getConfig();
  const store = getStore();
  const watches = await listWatches(account.id);
  const result: PassResult = {
    accountId: account.id,
    sellersChecked: 0,
    newFinds: [],
    errors: [],
  };

  for (const watch of watches) {
    try {
      const items = await getSellerItems(watch.sellerId, {
        account,
        ...(watch.domain ? { domain: watch.domain } : {}),
      });
      result.sellersChecked++;

      const seen = new Set(
        await store.smembers(keys.seen(account.id, watch.sellerId)),
      );
      const fresh = items.filter((item) => !seen.has(item.id));
      if (fresh.length === 0) continue;

      const discountPct = watch.discountPct ?? cfg.offerDiscountPct;
      for (const item of fresh) {
        const find: Find = {
          itemId: item.id,
          accountId: account.id,
          sellerId: watch.sellerId,
          sellerLogin: item.sellerLogin ?? watch.sellerLogin,
          title: item.title,
          askingPrice: item.price,
          currency: item.currency,
          suggestedOfferPrice: offerPriceFor(item.price, discountPct),
          discountPct,
          url: item.url,
          photoUrl: item.photoUrl,
          detectedAt: new Date().toISOString(),
        };
        // Finds expire after 30 days so the store does not grow without bound.
        await store.set(keys.find(account.id, item.id), find, 60 * 60 * 24 * 30);
        await store.sadd(keys.finds(account.id), item.id);
        result.newFinds.push(find);
      }
      await store.sadd(
        keys.seen(account.id, watch.sellerId),
        ...fresh.map((i) => i.id),
      );
    } catch (err) {
      const message = (err as Error).message;
      result.errors.push({ sellerId: watch.sellerId, message });
      log.warn("watch pass failed", { sellerId: watch.sellerId, message });
    }
  }
  return result;
}

/** Runs a monitoring pass for every configured account. */
export async function runPass(): Promise<PassResult[]> {
  const cfg = getConfig();
  const results: PassResult[] = [];
  for (const account of cfg.accounts) {
    results.push(await runPassForAccount(account));
  }
  await getStore().set(keys.lastRun(), new Date().toISOString());
  return results;
}

/** Returns recorded finds, newest first. */
export async function listFinds(
  accountId: string,
  opts: { includeHandled?: boolean; limit?: number } = {},
): Promise<Find[]> {
  const store = getStore();
  const ids = await store.smembers(keys.finds(accountId));
  const finds: Find[] = [];
  for (const itemId of ids) {
    const find = await store.get<Find>(keys.find(accountId, itemId));
    if (!find) {
      // Expired out of the store; drop the dangling index entry.
      await store.srem(keys.finds(accountId), itemId);
      continue;
    }
    if (!opts.includeHandled && find.handledAt) continue;
    finds.push(find);
  }
  finds.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  return opts.limit ? finds.slice(0, opts.limit) : finds;
}

/** Marks a find as dealt with so it stops appearing in the queue. */
export async function markFindHandled(
  accountId: string,
  itemId: string,
  note: string,
): Promise<Find | null> {
  const store = getStore();
  const find = await store.get<Find>(keys.find(accountId, itemId));
  if (!find) return null;
  const updated: Find = { ...find, handledAt: new Date().toISOString() };
  await store.set(keys.find(accountId, itemId), updated, 60 * 60 * 24 * 30);
  log.info("find marked handled", { itemId, accountId, note });
  return updated;
}
