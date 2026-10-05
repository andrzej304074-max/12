import { getStore, keys } from "../store/index.js";

/**
 * A short audit trail of what was sent to Vinted Pro for an account: what kind
 * of write, how many items, whether it was accepted. It carries no request
 * data (no titles, prices or keys), only enough to answer "what did the
 * integration do, and when".
 */

export interface ProActionEntry {
  at: string;
  /** e.g. "create_items", "cancel_order". */
  kind: string;
  count: number;
  ok: boolean;
  detail: string;
}

const LOG_LENGTH = 100;
const TTL_SECONDS = 60 * 60 * 24 * 30;

export async function recordProAction(accountId: string, entry: Omit<ProActionEntry, "at">): Promise<void> {
  const store = getStore();
  const current = (await store.get<ProActionEntry[]>(keys.proActions(accountId))) ?? [];
  const next = [{ at: new Date().toISOString(), ...entry }, ...current].slice(0, LOG_LENGTH);
  await store.set(keys.proActions(accountId), next, TTL_SECONDS);
}

export async function getProActions(accountId: string): Promise<ProActionEntry[]> {
  return (await getStore().get<ProActionEntry[]>(keys.proActions(accountId))) ?? [];
}
