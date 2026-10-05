import { getProAccount, listProAccounts, type ProAccount } from "./accounts.js";
import { ProError } from "./errors.js";
import { getItemStatus } from "./items.js";
import { loadOntology, ontologyFetchedAt } from "./ontology.js";
import { getItemStates } from "./state.js";

/**
 * The daily catch-up for everything asynchronous.
 *
 * Webhooks are the primary way to learn how a create, edit or delete turned
 * out, but a delivery can be lost, refused or never registered. Once a day the
 * cron asks for the status of any item that has been "in progress" for a while,
 * and keeps the ontology cache warm so the panel's listing form never waits for
 * it. It is bounded (it must fit one function invocation) and it leaves a
 * rejected token alone instead of hammering Vinted with it.
 */

const STALE_AFTER_MS = 5 * 60 * 1000;
const ONTOLOGY_MAX_AGE_MS = 20 * 60 * 60 * 1000;

export interface ReconcileResult {
  accountId: string;
  /** Items whose status was asked for. */
  checkedItems: number;
  /** Of those, how many changed. */
  updatedItems: number;
  ontologyRefreshed: boolean;
  skipped: string | null;
  errors: string[];
}

export async function reconcileProAccount(
  account: ProAccount,
  opts: { now?: number; maxChecks?: number } = {},
): Promise<ReconcileResult> {
  const now = opts.now ?? Date.now();
  const result: ReconcileResult = { accountId: account.id, checkedItems: 0, updatedItems: 0, ontologyRefreshed: false, skipped: null, errors: [] };
  if (account.status === "rejected") {
    result.skipped = `token rejected (${account.statusReason ?? "no reason recorded"}); add the token again in the panel`;
    return result;
  }

  const waiting = (await getItemStates(account.id)).filter(
    (s) => s.status === "IN_PROGRESS" && now - Date.parse(s.updatedAt) > STALE_AFTER_MS,
  );
  for (const state of waiting.slice(0, opts.maxChecks ?? 40)) {
    try {
      await getItemStatus(account, state.id);
      result.checkedItems++;
      const after = (await getItemStates(account.id)).find((s) => s.id === state.id);
      if (after && after.status !== state.status) result.updatedItems++;
    } catch (err) {
      result.errors.push(`${state.id}: ${(err as Error).message}`);
      // Rate limited or refused: more calls would only make it worse.
      if (err instanceof ProError && (err.kind === "rate_limited" || err.kind === "auth" || err.kind === "forbidden")) break;
    }
  }

  try {
    const fetchedAt = await ontologyFetchedAt(account.id);
    if (!fetchedAt || now - Date.parse(fetchedAt) > ONTOLOGY_MAX_AGE_MS) {
      await loadOntology(account, { refresh: true });
      result.ontologyRefreshed = true;
    }
  } catch (err) {
    result.errors.push(`ontology: ${(err as Error).message}`);
  }
  return result;
}

export async function reconcileAllPro(opts: { now?: number } = {}): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];
  for (const summary of await listProAccounts()) {
    try {
      results.push(await reconcileProAccount(await getProAccount(summary.id), opts));
    } catch (err) {
      results.push({
        accountId: summary.id,
        checkedItems: 0,
        updatedItems: 0,
        ontologyRefreshed: false,
        skipped: null,
        errors: [(err as Error).message],
      });
    }
  }
  return results;
}
