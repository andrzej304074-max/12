import { getStore, keys } from "../store/index.js";

/**
 * What we last learned about each item we created or heard of in a webhook.
 *
 * Creating, editing and deleting are asynchronous at Vinted: the request is
 * accepted at once and the outcome arrives later, by webhook or by asking for
 * the item's status. This small index keeps the latest word per item so the
 * panel can show "in progress" or "published" without asking Vinted again.
 * It is a cache of events, not a source of truth; the item list comes from the
 * API.
 */

export interface ItemState {
  id: string;
  reference: string | null;
  /** Vinted's status string, or the last webhook event name. */
  status: string;
  updatedAt: string;
}

const MAX_ITEMS = 500;
const TTL_SECONDS = 60 * 60 * 24 * 60;

type Index = Record<string, ItemState>;

export async function noteItems(
  accountId: string,
  entries: { id: string; reference?: string | null; status: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  const store = getStore();
  const index = (await store.get<Index>(keys.proItems(accountId))) ?? {};
  const now = new Date().toISOString();
  for (const entry of entries) {
    index[entry.id] = {
      id: entry.id,
      reference: entry.reference ?? index[entry.id]?.reference ?? null,
      status: entry.status,
      updatedAt: now,
    };
  }
  const kept = Object.values(index)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_ITEMS);
  await store.set(keys.proItems(accountId), Object.fromEntries(kept.map((s) => [s.id, s])), TTL_SECONDS);
}

export async function getItemStates(accountId: string): Promise<ItemState[]> {
  const index = (await getStore().get<Index>(keys.proItems(accountId))) ?? {};
  return Object.values(index).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
