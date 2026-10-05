import { notify } from "../monitor/notify.js";
import { getStore, keys } from "../store/index.js";
import { markProRejected } from "./accounts.js";
import { noteItems } from "./state.js";

/**
 * Webhook events: what Vinted told us happened.
 *
 * Creating, editing and deleting listings are asynchronous at Vinted, so the
 * real outcome arrives here. Each delivery is kept in a short log (the last
 * 100 per account), the item index is updated, and the events a seller wants
 * to hear about reach the notification webhook.
 *
 * The documentation only gives the shape of an event loosely
 * ({"event_type": ..., "data": {...}}), so everything read out of `data` is
 * optional and a missing field never stops an event from being recorded.
 */

export interface ProEvent {
  /** Stable id of this record (not Vinted's). */
  id: string;
  at: string;
  type: string;
  accountId: string;
  /** One readable line; never contains personal data beyond ids and references. */
  summary: string;
  itemId: string | null;
  reference: string | null;
  orderId: string | null;
  /** The event's `data`, kept for the panel; capped in size. */
  data: unknown;
}

const LOG_LENGTH = 100;
const TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_DATA_CHARS = 4000;

/** Events worth a push notification. */
const NOTIFY_TYPES = new Set([
  "ITEM_SOLD",
  "ORDER_CREATED",
  "ORDER_CANCELLED",
  "SHIPMENT_LABEL_CREATED",
  "CANCEL_ORDER_FAILURE",
  "CREATE_ITEM_FAILURE",
  "UPDATE_ITEM_FAILURE",
  "DELETE_ITEM_FAILURE",
  "VINTED_AUTHENTICATION_ERROR",
]);

/** The event types the documentation lists, used when registering a webhook. */
export const DOCUMENTED_EVENTS = [
  "CREATE_ITEM_SUCCESS",
  "CREATE_ITEM_FAILURE",
  "UPDATE_ITEM_SUCCESS",
  "UPDATE_ITEM_FAILURE",
  "DELETE_ITEM_SUCCESS",
  "DELETE_ITEM_FAILURE",
  "ITEM_PUBLISHED",
  "ITEM_UPDATED",
  "ITEM_DRAFT_UPDATED",
  "ITEM_REUPLOADED",
  "ITEM_DELETED",
  "ITEM_SOLD",
  "ORDER_CREATED",
  "ORDER_CANCELLED",
  "CANCEL_ORDER_FAILURE",
  "SHIPMENT_LABEL_CREATED",
  "VINTED_AUTHENTICATION_ERROR",
] as const;

/** What an event says about the item it concerns, as a status for the item index. */
const ITEM_STATUS_BY_EVENT: Record<string, string> = {
  CREATE_ITEM_SUCCESS: "CREATED",
  CREATE_ITEM_FAILURE: "CREATE_FAILED",
  UPDATE_ITEM_SUCCESS: "UPDATED",
  UPDATE_ITEM_FAILURE: "UPDATE_FAILED",
  DELETE_ITEM_SUCCESS: "DELETED",
  DELETE_ITEM_FAILURE: "DELETE_FAILED",
  ITEM_PUBLISHED: "PUBLISHED",
  ITEM_UPDATED: "UPDATED",
  ITEM_DRAFT_UPDATED: "DRAFT",
  ITEM_REUPLOADED: "PUBLISHED",
  ITEM_DELETED: "DELETED",
  ITEM_SOLD: "SOLD",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Reads the interesting ids out of an event's data, whichever of the likely names it uses. */
export function describeEvent(type: string, data: unknown): Pick<ProEvent, "itemId" | "reference" | "orderId" | "summary"> {
  const d = isRecord(data) ? data : {};
  const isOrder = /^(ORDER_|CANCEL_ORDER|SHIPMENT_)/.test(type);
  const orderId = text(d.order_id) ?? (isOrder ? text(d.id) : null);
  const itemId = text(d.item_id) ?? (isOrder ? null : text(d.id));
  const reference = text(d.reference);
  const parts = [type];
  if (reference) parts.push(`reference ${reference}`);
  if (itemId) parts.push(`item ${itemId}`);
  if (orderId) parts.push(`order ${orderId}`);
  return { itemId, reference, orderId, summary: parts.join(" · ") };
}

function capData(data: unknown): unknown {
  const raw = JSON.stringify(data ?? null);
  return raw.length <= MAX_DATA_CHARS ? (data ?? null) : { truncated: true, preview: raw.slice(0, MAX_DATA_CHARS) };
}

export async function listProEvents(accountId: string, opts: { type?: string; limit?: number } = {}): Promise<ProEvent[]> {
  const all = (await getStore().get<ProEvent[]>(keys.proEvents(accountId))) ?? [];
  const filtered = opts.type ? all.filter((e) => e.type === opts.type) : all;
  return filtered.slice(0, Math.min(Math.max(opts.limit ?? 50, 1), LOG_LENGTH));
}

/**
 * Records one verified delivery: log it, update the item index, react to the
 * events that change the account's standing, and notify. Notification failures
 * never fail a delivery.
 */
export async function recordProEvent(accountId: string, type: string, data: unknown): Promise<ProEvent> {
  const store = getStore();
  const described = describeEvent(type, data);
  const event: ProEvent = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    type,
    accountId,
    ...described,
    data: capData(data),
  };
  const current = (await store.get<ProEvent[]>(keys.proEvents(accountId))) ?? [];
  await store.set(keys.proEvents(accountId), [event, ...current].slice(0, LOG_LENGTH), TTL_SECONDS);

  const itemStatus = ITEM_STATUS_BY_EVENT[type];
  if (itemStatus && event.itemId) {
    await noteItems(accountId, [{ id: event.itemId, reference: event.reference, status: itemStatus }]);
  }
  if (type === "VINTED_AUTHENTICATION_ERROR") {
    await markProRejected(accountId, "Vinted reported an authentication problem with this integration");
  }
  if (NOTIFY_TYPES.has(type)) {
    await notify(`Vinted Pro [${accountId}]: ${event.summary}`);
  }
  return event;
}
