import { safeId } from "./hosts.js";

/**
 * Every Vinted Pro path in one place, with how sure we are of it.
 *
 * Source: the integrator documentation pasted by the project owner, which was
 * compiled from fragments of the official docs and two open-source clients.
 * The official OpenAPI file (api.yml) is the source of truth; when it is added
 * as docs/vinted-pro/api.yml, test/pro-contract.test.ts checks this table
 * against it.
 *
 *   [ok]    confirmed by a quotation from the official documentation
 *   [prob]  agreed by independent clients built on api.yml, not quoted
 *   [?]     not confirmed - check api.yml or ask Vinted
 */

export const proEndpoints = {
  /** [ok] GET - every dictionary needed to build a valid listing. */
  ontologies: () => `/api/v1/ontologies`,

  /** [prob] GET ?catalog_id&brand_id&status_id */
  priceSuggestions: () => `/api/v2/item-price-suggestions`,

  /** [ok] POST create, PUT update; [prob] GET list, DELETE remove. */
  items: () => `/api/v1/items`,

  /** [prob] POST - same body as create, creates nothing. */
  itemsValidate: () => `/api/v1/items/validate`,

  /** [ok] the endpoint exists (GetItemStatus); [prob] the path. */
  itemStatus: (itemUuid: string) => `/api/v1/items/${safeId(itemUuid, "item id")}/status`,

  /** [ok] GET - items added on Vinted outside the API. */
  itemsImported: () => `/api/v1/items/imported`,

  /** [ok] PUT - attach our reference (SKU) to imported items. */
  itemReferences: () => `/api/v1/items/item-references`,

  /** [prob] GET ?after-id (the cursor name differs between clients, see schema.ts). */
  orders: () => `/api/v1/orders`,
  order: (orderId: string) => `/api/v1/orders/${safeId(orderId, "order id")}`,
  orderShipment: (orderId: string) => `/api/v1/orders/${safeId(orderId, "order id")}/shipment`,

  /** [ok] GET with Accept: application/pdf. */
  orderLabel: (orderId: string) => `/api/v1/orders/${safeId(orderId, "order id")}/shipment-label`,

  /** [prob] POST { cancellation_reason_explanation } */
  orderCancel: (orderId: string) => `/api/v1/orders/${safeId(orderId, "order id")}/cancel`,

  /** [prob] POST { order_ids } */
  ordersRelist: () => `/api/v1/orders/relist`,

  /** [prob] GET list, POST register. */
  webhooks: () => `/api/v1/webhooks`,
  webhook: (webhookId: string) => `/api/v1/webhooks/${safeId(webhookId, "webhook id")}`,

  /** [prob] POST, sandbox only: simulates a sale, which sends the webhooks. */
  devItemSold: (itemId: string) => `/dev/v1/triggers/item-sold/${safeId(itemId, "item id")}`,
} as const;
