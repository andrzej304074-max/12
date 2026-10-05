import { getStore, keys } from "../store/index.js";
import { listWatches, removeWatch } from "./engine.js";

/**
 * Removes everything the server keeps about an account except the account
 * record itself: watchlist, seen items, finds, limits, pause, action log,
 * inbox state and drafts.
 */
export async function purgeAccountData(accountId: string): Promise<void> {
  const store = getStore();

  for (const watch of await listWatches(accountId)) {
    await removeWatch(accountId, watch.sellerId);
  }
  for (const itemId of await store.smembers(keys.finds(accountId))) {
    await store.del(keys.find(accountId, itemId));
  }
  for (const draftId of await store.smembers(keys.drafts(accountId))) {
    await store.del(keys.draft(accountId, draftId));
  }
  for (const key of [
    keys.finds(accountId),
    keys.drafts(accountId),
    keys.limits(accountId),
    keys.autopause(accountId),
    keys.actionLog(accountId),
    keys.inboxSeen(accountId),
    keys.inboxSeeded(accountId),
  ]) {
    await store.del(key);
  }
}
