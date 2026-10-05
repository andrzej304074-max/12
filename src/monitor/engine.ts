import { getConfig, type VintedAccount } from "../config.js";
import { log } from "../log.js";
import { getSettings } from "../settings.js";
import { getStore, keys } from "../store/index.js";
import { listAccounts } from "../vinted/accounts.js";
import { likeItem, sendOffer } from "../vinted/actions.js";
import { RefusalError } from "../vinted/client.js";
import { getSellerItems } from "../vinted/search.js";
import type { NormalisedItem } from "../vinted/types.js";
import { checkInbox } from "./inbox-watch.js";
import { formatFinds, notify } from "./notify.js";
import { checkBudget, getLimits, LimitError } from "./safety.js";

/**
 * Watchlist polling.
 *
 * A pass fetches each watched seller's newest listings, diffs them against the
 * ids already seen, and records anything new as a "find" with a suggested
 * negotiation price.
 *
 * Contacting the seller is opt-in twice over: a watch must have auto_like /
 * auto_offer set, and AUTO_ACTIONS_ENABLED must be true. Even then, actions
 * wait in a queue and go out only inside the activity window, under the
 * hourly and daily limits, and never while the circuit breaker is tripped.
 */

export type AutoKind = "like" | "offer";

export interface Watch {
  sellerId: string;
  /** Login captured when the watch was created, for readable output. */
  sellerLogin: string | null;
  addedAt: string;
  domain: string | null;
  /** Overrides the account discount for this seller, as a percentage. */
  discountPct: number | null;
  /** Like this seller's new items automatically. */
  autoLike?: boolean;
  /** Send the discounted offer on this seller's new items automatically. */
  autoOffer?: boolean;
}

export interface AutoActionRecord {
  kind: AutoKind;
  ok: boolean;
  at: string;
  detail: string;
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
  /** Set once acted on, so it stops resurfacing. */
  handledAt?: string;
  /** Automatic actions still waiting for budget or the activity window. */
  autoPending?: AutoKind[];
  /** What the automation already did for this find. */
  autoActions?: AutoActionRecord[];
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
  autoActions: { itemId: string; kind: AutoKind; ok: boolean; detail: string }[];
  /** Why the automatic queue stopped early, if it did. */
  autoStoppedBecause: string | null;
  notified: boolean;
  /** New unread messages found by the cron pass (set by runPass only). */
  newMessages?: number;
}

const FIND_TTL = 60 * 60 * 24 * 30;

/**
 * Works through finds with pending automatic actions, oldest first.
 * Stops at the first sign the account should slow down: pause, outside the
 * window, or the hourly limit. A daily cap only skips that kind of action.
 */
export async function processAutoQueue(
  account: VintedAccount,
  result: PassResult,
): Promise<void> {
  if (!(await getSettings()).autoActionsEnabled) return;
  const store = getStore();
  const queue = (await listFinds(account.id))
    .filter((f) => f.autoPending?.length)
    .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt));

  for (const find of queue) {
    const pending = [...(find.autoPending ?? [])];
    const done: AutoActionRecord[] = [...(find.autoActions ?? [])];
    let stop: string | null = null;

    for (const kind of [...pending]) {
      const verdict = await checkBudget(account.id, kind, { automatic: true });
      if (!verdict.ok) {
        if (verdict.reason === "daily") continue;
        if (verdict.reason === "disabled") {
          pending.splice(pending.indexOf(kind), 1);
          done.push({ kind, ok: false, at: new Date().toISOString(), detail: verdict.message });
          continue;
        }
        stop = verdict.message;
        break;
      }

      const record = (ok: boolean, detail: string) => {
        done.push({ kind, ok, at: new Date().toISOString(), detail });
        result.autoActions.push({ itemId: find.itemId, kind, ok, detail });
      };

      try {
        if (kind === "like") {
          await likeItem(account, find.itemId, { automatic: true });
          record(true, "liked");
        } else {
          if (find.suggestedOfferPrice === null) {
            record(false, "no usable asking price, offer skipped");
          } else {
            await sendOffer(account, find.itemId, find.suggestedOfferPrice, find.currency, {
              automatic: true,
            });
            record(true, `offered ${find.suggestedOfferPrice}`);
          }
        }
        pending.splice(pending.indexOf(kind), 1);
      } catch (err) {
        const message = (err as Error).message;
        if (err instanceof LimitError) continue;
        if (err instanceof RefusalError) {
          // Breaker is tripped; keep the action queued for after the pause.
          record(false, message);
          stop = `Vinted refused an action, automation paused: ${message}`;
          break;
        }
        // Unknown outcome on a non-idempotent write: never retry it.
        record(false, message);
        pending.splice(pending.indexOf(kind), 1);
      }
    }

    const updated: Find = { ...find, autoPending: pending, autoActions: done };
    if (pending.length === 0 && done.some((d) => d.ok) && !updated.handledAt) {
      updated.handledAt = new Date().toISOString();
    }
    await store.set(keys.find(account.id, find.itemId), updated, FIND_TTL);

    if (stop) {
      result.autoStoppedBecause = stop;
      return;
    }
  }
}

/** Runs one monitoring pass for a single account. */
export async function runPassForAccount(
  account: VintedAccount,
): Promise<PassResult> {
  const cfg = getConfig();
  const store = getStore();
  const watches = await listWatches(account.id);
  const limits = await getLimits(account.id);
  const result: PassResult = {
    accountId: account.id,
    sellersChecked: 0,
    newFinds: [],
    errors: [],
    autoActions: [],
    autoStoppedBecause: null,
    notified: false,
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

      const discountPct = watch.discountPct ?? limits.discountPct;
      const autoPending: AutoKind[] = (await getSettings()).autoActionsEnabled
        ? [
            ...(watch.autoLike ? (["like"] as const) : []),
            ...(watch.autoOffer ? (["offer"] as const) : []),
          ]
        : [];
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
          ...(autoPending.length ? { autoPending: [...autoPending] } : {}),
        };
        // Finds expire after 30 days so the store does not grow without bound.
        await store.set(keys.find(account.id, item.id), find, FIND_TTL);
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

  if (result.newFinds.length) {
    result.notified = await notify(formatFinds(account.id, result.newFinds));
  }
  await processAutoQueue(account, result);
  return result;
}

/** Runs a monitoring pass for every configured account. */
export async function runPass(): Promise<PassResult[]> {
  const results: PassResult[] = [];
  for (const account of await listAccounts()) {
    // A session that expired needs a fresh login in the panel; polling with
    // it would only produce 401s.
    if (account.status === "needs_login") continue;
    const result = await runPassForAccount(account);
    try {
      const inbox = await checkInbox(account);
      result.newMessages = inbox.newMessages;
    } catch (err) {
      result.errors.push({ sellerId: "inbox", message: (err as Error).message });
    }
    results.push(result);
  }
  await getStore().set(keys.lastRun(), new Date().toISOString());
  return results;
}

export async function getFind(accountId: string, itemId: string): Promise<Find | null> {
  return getStore().get<Find>(keys.find(accountId, itemId));
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
