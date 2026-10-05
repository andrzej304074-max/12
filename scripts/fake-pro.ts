import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * A stand-in for the Vinted Pro Integrations API, built from the integrator
 * documentation, for tests and the local demo.
 *
 * It checks the signature of every request with its own, separate
 * implementation of the documented algorithm - so a mistake in src/pro/signing.ts
 * cannot hide behind a matching mistake here - and then behaves like the
 * documentation says: asynchronous create/update/delete, leaf-only categories,
 * 100 items per request, labels only after the label webhook, 404 for unknown
 * orders. It is NOT Vinted: whatever the documentation leaves open is
 * guessed here and flagged where it matters.
 */

export interface RecordedRequest {
  method: string;
  /** Path with query string, exactly as signed. */
  path: string;
  body: string;
  headers: Record<string, string>;
  signatureOk: boolean;
}

export interface FakeItem {
  id: string;
  reference: string | null;
  status: "IN_PROGRESS" | "DRAFT" | "PUBLISHED" | "SOLD" | "DELETED";
  data: Record<string, unknown>;
}

export interface FakeOrder {
  id: number;
  status: string;
  items: { id: string; reference: string | null; price: string }[];
  currency: string;
  created_at: string;
  labelReady: boolean;
}

export interface FakeWebhook {
  id: string;
  url: string;
  event_types: string[];
  signing_key: string;
}

export interface OutboxEvent {
  event_type: string;
  data: Record<string, unknown>;
}

export const FAKE_ONTOLOGY = {
  catalogs: [
    {
      id: 1904,
      title: "Kobiety",
      catalogs: [
        {
          id: 1905,
          title: "Odzież wierzchnia",
          catalogs: [
            { id: 1234, title: "Kurtki jeansowe", catalogs: [], size_group_ids: [4], item_attribute_ids: [], disabled_fields: [] },
            { id: 1235, title: "Płaszcze", catalogs: [], size_group_ids: [4], item_attribute_ids: [], disabled_fields: ["brand"] },
          ],
        },
      ],
    },
  ],
  colors: [
    { id: 9, title: "Niebieski" },
    { id: 12, title: "Czarny" },
  ],
  package_sizes: [
    { id: 1, title: "Mała" },
    { id: 2, title: "Średnia" },
  ],
  statuses: [
    { id: 1, title: "Nowy z metką" },
    { id: 2, title: "Bardzo dobry" },
  ],
  size_groups: [{ id: 4, sizes: [{ id: 206, title: "S" }, { id: 207, title: "M" }] }],
};

const LEAVES = new Set([1234, 1235]);
const NO_BRAND = new Set([1235]);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function lowerHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  const entries = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h);
  for (const [k, v] of entries) out[k.toLowerCase()] = String(v);
  return out;
}

export interface FakeProOptions {
  accessKey: string;
  signingKey: string;
  now?: () => number;
}

export function createFakePro(opts: FakeProOptions) {
  const now = opts.now ?? (() => Date.now());
  const items = new Map<string, FakeItem>();
  const orders = new Map<number, FakeOrder>();
  const webhooks = new Map<string, FakeWebhook>();
  const requests: RecordedRequest[] = [];
  const outbox: OutboxEvent[] = [];
  let nextOrderId = 987654321;

  /** The documented algorithm, written out independently of src/pro/signing.ts. */
  function checkSignature(method: string, pathWithQuery: string, body: string, headers: Record<string, string>): boolean {
    if (headers["x-vpi-access-key"] !== opts.accessKey) return false;
    const header = headers["x-vpi-hmac-sha256"] ?? "";
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (!m) return false;
    const t = Number(m[1]);
    if (Math.abs(now() / 1000 - t) > 300) return false;
    const message = [t, method, pathWithQuery, opts.accessKey, body].join(".");
    const expected = createHmac("sha256", opts.signingKey).update(message).digest();
    const given = Buffer.from(m[2]!, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  function itemErrors(item: Record<string, unknown>): { field: string; error: string }[] {
    const errors: { field: string; error: string }[] = [];
    const title = typeof item.title === "string" ? item.title : "";
    if ([...title].length < 5 || [...title].length > 100) errors.push({ field: "title", error: "TITLE_LENGTH" });
    const description = typeof item.description === "string" ? item.description : "";
    if ([...description].length < 5) errors.push({ field: "description", error: "DESCRIPTION_LENGTH" });
    if (!LEAVES.has(Number(item.catalog_id))) errors.push({ field: "catalog_id", error: "CATALOG_NOT_LEAF" });
    if (!NO_BRAND.has(Number(item.catalog_id)) && !item.brand) errors.push({ field: "brand", error: "BRAND_REQUIRED" });
    if (NO_BRAND.has(Number(item.catalog_id)) && "brand" in item) errors.push({ field: "brand", error: "FIELD_DISABLED" });
    if (!Array.isArray(item.photo_urls) || item.photo_urls.length === 0) errors.push({ field: "photo_urls", error: "PHOTOS_REQUIRED" });
    return errors;
  }

  function handle(url: URL, init?: RequestInit): Response {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = lowerHeaders(init);
    const path = url.pathname + url.search;
    const ok = checkSignature(method, path, body, headers);
    requests.push({ method, path, body, headers, signatureOk: ok });
    if (!ok) return json(401, { error: "INVALID_SIGNATURE" });

    const route = url.pathname;
    let m: RegExpExecArray | null;
    const parsed = (): Record<string, unknown> => {
      try {
        return body ? (JSON.parse(body) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    };

    if (method === "GET" && route === "/api/v1/ontologies") return json(200, FAKE_ONTOLOGY);

    if (method === "POST" && route === "/api/v1/items/validate") {
      const list = (parsed().items as Record<string, unknown>[] | undefined) ?? [];
      if (list.length > 100) return json(422, { error: "TOO_MANY_ITEMS" });
      return json(200, { items: list.map((item) => ({ reference: item.reference ?? null, errors: itemErrors(item) })) });
    }

    if (route === "/api/v1/items" && method === "POST") {
      const list = (parsed().items as Record<string, unknown>[] | undefined) ?? [];
      if (list.length === 0 || list.length > 100) return json(422, { error: "TOO_MANY_ITEMS" });
      const created = list.map((data) => {
        const id = randomUUID();
        items.set(id, { id, reference: typeof data.reference === "string" ? data.reference : null, status: "IN_PROGRESS", data });
        return { reference: data.reference ?? null, id, status: "IN_PROGRESS" };
      });
      return json(202, { items: created });
    }

    if (route === "/api/v1/items" && method === "PUT") {
      const list = (parsed().items as Record<string, unknown>[] | undefined) ?? [];
      if (list.length === 0 || list.length > 100) return json(422, { error: "TOO_MANY_ITEMS" });
      for (const patch of list) {
        const found = typeof patch.id === "string" ? items.get(patch.id) : undefined;
        if (found) found.data = { ...found.data, ...patch };
      }
      return json(202, {});
    }

    if (route === "/api/v1/items" && method === "DELETE") {
      const ids = (parsed().item_ids as string[] | undefined) ?? [];
      if (ids.length === 0 || ids.length > 100) return json(422, { error: "TOO_MANY_ITEMS" });
      for (const id of ids) {
        const found = items.get(id);
        // Documented: 202 even for unknown ids; items still in progress cannot be deleted.
        if (found && found.status !== "IN_PROGRESS") {
          found.status = "DELETED";
          outbox.push({ event_type: "DELETE_ITEM_SUCCESS", data: { id } });
        }
      }
      return json(202, {});
    }

    if (route === "/api/v1/items" && method === "GET") {
      const list = [...items.values()].filter((i) => i.status !== "DELETED");
      const after = url.searchParams.get("after_item_id");
      const start = after ? list.findIndex((i) => i.id === after) + 1 : 0;
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json(200, { items: list.slice(start, start + limit).map((i) => ({ id: i.id, reference: i.reference, status: i.status, ...i.data })) });
    }

    if (method === "GET" && route === "/api/v1/items/imported") return json(200, { items: [] });
    if (method === "PUT" && route === "/api/v1/items/item-references") return json(200, {});

    if ((m = /^\/api\/v1\/items\/([A-Za-z0-9_-]+)\/status$/.exec(route)) && method === "GET") {
      const found = items.get(m[1]!);
      return found ? json(200, { id: found.id, status: found.status }) : json(404, { error: "ITEM_NOT_FOUND" });
    }

    if (method === "GET" && route === "/api/v1/orders") {
      const list = [...orders.values()];
      const after = url.searchParams.get("after-id");
      const start = after ? list.findIndex((o) => String(o.id) === after) + 1 : 0;
      return json(200, { orders: list.slice(start, start + 50) });
    }
    if ((m = /^\/api\/v1\/orders\/(\d+)$/.exec(route)) && method === "GET") {
      const order = orders.get(Number(m[1]));
      return order ? json(200, order) : json(404, { error: "ORDER_NOT_FOUND" });
    }
    if ((m = /^\/api\/v1\/orders\/(\d+)\/shipment$/.exec(route)) && method === "GET") {
      return orders.has(Number(m[1])) ? json(200, { carrier: "DPD", tracking_code: "TRACK123" }) : json(404, { error: "ORDER_NOT_FOUND" });
    }
    if ((m = /^\/api\/v1\/orders\/(\d+)\/shipment-label$/.exec(route)) && method === "GET") {
      const order = orders.get(Number(m[1]));
      if (!order || !order.labelReady) return json(404, { error: "ORDER_NOT_FOUND" });
      return new Response(Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    if ((m = /^\/api\/v1\/orders\/(\d+)\/cancel$/.exec(route)) && method === "POST") {
      const order = orders.get(Number(m[1]));
      if (!order) return json(404, { error: "ORDER_NOT_FOUND" });
      const reason = parsed().cancellation_reason_explanation;
      if (typeof reason !== "string" || reason.length === 0 || [...reason].length > 100) return json(422, { error: "INVALID_REASON" });
      order.status = "CANCELLED";
      outbox.push({ event_type: "ORDER_CANCELLED", data: { id: order.id } });
      return json(202, {});
    }
    if (method === "POST" && route === "/api/v1/orders/relist") return json(202, {});

    if (route === "/api/v1/webhooks" && method === "GET") {
      return json(200, { webhooks: [...webhooks.values()].map(({ signing_key: _omit, ...rest }) => rest) });
    }
    if (route === "/api/v1/webhooks" && method === "POST") {
      const b = parsed();
      const webhook: FakeWebhook = {
        id: `wh_${webhooks.size + 1}`,
        url: String(b.url ?? ""),
        event_types: Array.isArray(b.event_types) ? (b.event_types as string[]) : [],
        signing_key: `whsec_${randomUUID().replace(/-/g, "")}`,
      };
      webhooks.set(webhook.id, webhook);
      return json(201, webhook);
    }
    if ((m = /^\/api\/v1\/webhooks\/([A-Za-z0-9_-]+)$/.exec(route)) && method === "DELETE") {
      return webhooks.delete(m[1]!) ? new Response(null, { status: 204 }) : json(404, { error: "WEBHOOK_NOT_FOUND" });
    }

    if ((m = /^\/dev\/v1\/triggers\/item-sold\/([A-Za-z0-9_-]+)$/.exec(route)) && method === "POST") {
      const item = items.get(m[1]!);
      if (!item) return json(404, { error: "ITEM_NOT_FOUND" });
      item.status = "SOLD";
      const order: FakeOrder = {
        id: nextOrderId++,
        status: "CREATED",
        items: [{ id: item.id, reference: item.reference, price: String(item.data.price ?? "0") }],
        currency: "EUR",
        created_at: new Date(now()).toISOString(),
        labelReady: false,
      };
      orders.set(order.id, order);
      outbox.push({ event_type: "ITEM_SOLD", data: { id: item.id, reference: item.reference } });
      outbox.push({ event_type: "ORDER_CREATED", data: { id: order.id } });
      order.labelReady = true;
      outbox.push({ event_type: "SHIPMENT_LABEL_CREATED", data: { order_id: order.id } });
      return json(202, {});
    }

    return json(404, { error: "NOT_FOUND" });
  }

  return {
    handle,
    requests,
    items,
    orders,
    webhooks,
    outbox,
    /** Vinted finishes the asynchronous work: creations become drafts or live listings. */
    processPending(): void {
      for (const item of items.values()) {
        if (item.status !== "IN_PROGRESS") continue;
        item.status = item.data.is_draft === false ? "PUBLISHED" : "DRAFT";
        outbox.push({ event_type: "CREATE_ITEM_SUCCESS", data: { id: item.id, reference: item.reference } });
      }
    },
    addOrder(order: Partial<FakeOrder> = {}): FakeOrder {
      const full: FakeOrder = {
        id: nextOrderId++,
        status: "CREATED",
        items: [],
        currency: "EUR",
        created_at: new Date(now()).toISOString(),
        labelReady: false,
        ...order,
      };
      orders.set(full.id, full);
      return full;
    },
  };
}

export type FakePro = ReturnType<typeof createFakePro>;

/** Signs a webhook delivery the way the documentation describes. */
export function signWebhook(rawBody: string, webhookKey: string, t: number = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", webhookKey).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}
