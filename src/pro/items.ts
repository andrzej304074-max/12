import type { ProAccount } from "./accounts.js";
import { recordProAction } from "./actionlog.js";
import { getProClient } from "./client.js";
import { proEndpoints } from "./endpoints.js";
import { ProError } from "./errors.js";
import { safeId } from "./hosts.js";
import { chunk, ITEMS_CURSOR_PARAM, ITEMS_LIMIT_PARAM } from "./schema.js";
import { noteItems } from "./state.js";

/**
 * Listings through the Pro API: validate, create, update, delete, list, status,
 * import. Create, update and delete are asynchronous: the answer only says the
 * request was accepted, and the outcome comes later (webhook or status call).
 *
 * Every write is split into requests of at most 100 items, sent one after the
 * other. If one request fails the ones before it have already been accepted, so
 * the result reports what went through and where it stopped.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The list of items in an answer, whichever of the likely shapes it has. */
export function itemsIn(data: unknown): Record<string, unknown>[] {
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.items) ? data.items : [];
  return list.filter(isRecord);
}

export interface ListOptions {
  afterItemId?: string;
  limit?: number;
}

export async function listItems(account: ProAccount, opts: ListOptions = {}) {
  const { data } = await getProClient().json<unknown>(account, "GET", proEndpoints.items(), {
    query: {
      [ITEMS_CURSOR_PARAM]: opts.afterItemId ? safeId(opts.afterItemId, "after_item_id") : undefined,
      [ITEMS_LIMIT_PARAM]: opts.limit,
    },
  });
  return data;
}

export async function listImportedItems(account: ProAccount, opts: ListOptions = {}) {
  const { data } = await getProClient().json<unknown>(account, "GET", proEndpoints.itemsImported(), {
    query: {
      [ITEMS_CURSOR_PARAM]: opts.afterItemId ? safeId(opts.afterItemId, "after_item_id") : undefined,
      [ITEMS_LIMIT_PARAM]: opts.limit,
    },
  });
  return data;
}

export async function getItemStatus(account: ProAccount, itemId: string) {
  const { data } = await getProClient().json<unknown>(account, "GET", proEndpoints.itemStatus(itemId));
  const status = isRecord(data) && typeof data.status === "string" ? data.status : null;
  if (status) await noteItems(account.id, [{ id: itemId, status }]);
  return data;
}

export async function priceSuggestion(
  account: ProAccount,
  query: { catalogId: number; brandId?: number; statusId?: number },
) {
  const { data } = await getProClient().json<unknown>(account, "GET", proEndpoints.priceSuggestions(), {
    query: { catalog_id: query.catalogId, brand_id: query.brandId, status_id: query.statusId },
  });
  return data;
}

export interface ValidationResult {
  /** One entry per item, in order, as Vinted reported them. */
  results: unknown[];
  /** Items with at least one error. */
  invalid: number;
  /** Set when the validate endpoint is not there (404/405): nothing was checked. */
  unavailable: string | null;
}

/** Asks Vinted to validate items without creating anything. */
export async function validateItems(account: ProAccount, items: Record<string, unknown>[]): Promise<ValidationResult> {
  const results: unknown[] = [];
  let invalid = 0;
  for (const part of chunk(items)) {
    try {
      const { data } = await getProClient().json<unknown>(account, "POST", proEndpoints.itemsValidate(), {
        body: { items: part },
      });
      const entries = itemsIn(data);
      for (const entry of entries) {
        results.push(entry);
        if (Array.isArray(entry.errors) && entry.errors.length > 0) invalid++;
      }
      if (entries.length === 0) results.push(data);
    } catch (err) {
      if (err instanceof ProError && (err.status === 404 || err.status === 405)) {
        return { results, invalid, unavailable: `The validate endpoint answered ${err.status}; nothing was checked.` };
      }
      throw err;
    }
  }
  return { results, invalid, unavailable: null };
}

export interface WriteResult {
  /** What Vinted accepted, per request, as it answered. */
  accepted: unknown[];
  requests: number;
  /** Set if a later request failed: the earlier ones went through. */
  stoppedBecause: string | null;
  itemsSent: number;
}

async function writeInChunks(
  account: ProAccount,
  kind: string,
  method: "POST" | "PUT" | "DELETE",
  items: unknown[],
  bodyOf: (part: unknown[]) => unknown,
  noteStatus: string | null,
): Promise<WriteResult> {
  const accepted: unknown[] = [];
  let requests = 0;
  let itemsSent = 0;
  let stoppedBecause: string | null = null;
  for (const part of chunk(items)) {
    try {
      const { data } = await getProClient().json<unknown>(account, method, proEndpoints.items(), {
        body: bodyOf(part),
      });
      requests++;
      itemsSent += part.length;
      accepted.push(data);
      if (noteStatus) {
        await noteItems(
          account.id,
          itemsIn(data)
            .map((entry) => ({
              id: typeof entry.id === "string" ? entry.id : typeof entry.item_id === "string" ? entry.item_id : "",
              reference: typeof entry.reference === "string" ? entry.reference : null,
              status: typeof entry.status === "string" ? entry.status : noteStatus,
            }))
            .filter((entry) => entry.id !== ""),
        );
      }
    } catch (err) {
      stoppedBecause = (err as Error).message;
      break;
    }
  }
  await recordProAction(account.id, {
    kind,
    count: itemsSent,
    ok: stoppedBecause === null,
    detail: stoppedBecause ?? `${requests} request(s) accepted`,
  });
  if (stoppedBecause !== null && requests === 0) throw new ProError(stoppedBecause, "unexpected");
  return { accepted, requests, stoppedBecause, itemsSent };
}

export function createItems(account: ProAccount, items: Record<string, unknown>[]): Promise<WriteResult> {
  return writeInChunks(account, "create_items", "POST", items, (part) => ({ items: part }), "IN_PROGRESS");
}

export function updateItems(account: ProAccount, items: Record<string, unknown>[]): Promise<WriteResult> {
  return writeInChunks(account, "update_items", "PUT", items, (part) => ({ items: part }), null);
}

export function deleteItems(account: ProAccount, itemIds: string[]): Promise<WriteResult> {
  for (const id of itemIds) safeId(id, "item id");
  return writeInChunks(account, "delete_items", "DELETE", itemIds, (part) => ({ item_ids: part }), null);
}

/** Attaches our reference (SKU) to items that were imported from Vinted. */
export async function setItemReferences(
  account: ProAccount,
  items: { id: string; reference: string }[],
): Promise<WriteResult> {
  const accepted: unknown[] = [];
  let requests = 0;
  let itemsSent = 0;
  let stoppedBecause: string | null = null;
  for (const part of chunk(items)) {
    try {
      const { data } = await getProClient().json<unknown>(account, "PUT", proEndpoints.itemReferences(), {
        body: { items: part },
      });
      requests++;
      itemsSent += part.length;
      accepted.push(data);
    } catch (err) {
      stoppedBecause = (err as Error).message;
      break;
    }
  }
  await recordProAction(account.id, {
    kind: "set_references",
    count: itemsSent,
    ok: stoppedBecause === null,
    detail: stoppedBecause ?? `${requests} request(s) accepted`,
  });
  if (stoppedBecause !== null && requests === 0) throw new ProError(stoppedBecause, "unexpected");
  return { accepted, requests, stoppedBecause, itemsSent };
}
