import type { ProAccount } from "./accounts.js";
import { recordProAction } from "./actionlog.js";
import { getProClient } from "./client.js";
import { proEndpoints } from "./endpoints.js";
import { ProInputError } from "./errors.js";
import { safeId } from "./hosts.js";
import { CANCEL_REASON_MAX, MAX_BATCH, ORDERS_CURSOR_PARAM } from "./schema.js";

/**
 * Orders, shipments and labels.
 *
 * The label is a PDF that Vinted has already paid for; it exists only after
 * the SHIPMENT_LABEL_CREATED webhook, so asking too early answers 404.
 */

export async function listOrders(account: ProAccount, opts: { afterId?: string } = {}) {
  const { data } = await getProClient().json<unknown>(account, "GET", proEndpoints.orders(), {
    query: { [ORDERS_CURSOR_PARAM]: opts.afterId ? safeId(opts.afterId, "after_id") : undefined },
  });
  return data;
}

export async function getOrder(account: ProAccount, orderId: string) {
  return (await getProClient().json<unknown>(account, "GET", proEndpoints.order(orderId))).data;
}

export async function getShipment(account: ProAccount, orderId: string) {
  return (await getProClient().json<unknown>(account, "GET", proEndpoints.orderShipment(orderId))).data;
}

export async function getLabel(account: ProAccount, orderId: string) {
  return getProClient().pdf(account, proEndpoints.orderLabel(orderId));
}

/** Order ids are numbers in the documentation's examples; send them as such. */
function bodyId(id: string): number | string {
  return /^\d{1,15}$/.test(id) ? Number(id) : id;
}

export async function cancelOrder(account: ProAccount, orderId: string, reason: string) {
  const text = reason.trim();
  if (!text) throw new ProInputError("A reason is required to cancel an order.");
  if ([...text].length > CANCEL_REASON_MAX) {
    throw new ProInputError(`The reason may be at most ${CANCEL_REASON_MAX} characters.`);
  }
  try {
    const { data } = await getProClient().json<unknown>(account, "POST", proEndpoints.orderCancel(orderId), {
      body: { cancellation_reason_explanation: text },
    });
    await recordProAction(account.id, { kind: "cancel_order", count: 1, ok: true, detail: "cancellation accepted" });
    return data;
  } catch (err) {
    await recordProAction(account.id, { kind: "cancel_order", count: 1, ok: false, detail: (err as Error).message });
    throw err;
  }
}

export async function relistOrders(account: ProAccount, orderIds: string[]) {
  if (orderIds.length === 0) throw new ProInputError("Give at least one order id.");
  if (orderIds.length > MAX_BATCH) throw new ProInputError(`At most ${MAX_BATCH} orders per request.`);
  for (const id of orderIds) safeId(id, "order id");
  try {
    const { data } = await getProClient().json<unknown>(account, "POST", proEndpoints.ordersRelist(), {
      body: { order_ids: orderIds.map(bodyId) },
    });
    await recordProAction(account.id, { kind: "relist_orders", count: orderIds.length, ok: true, detail: "relist accepted" });
    return data;
  } catch (err) {
    await recordProAction(account.id, { kind: "relist_orders", count: orderIds.length, ok: false, detail: (err as Error).message });
    throw err;
  }
}
