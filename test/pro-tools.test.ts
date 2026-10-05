import { describe, expect, it } from "vitest";
import type { FakePro } from "../scripts/fake-pro.js";
import { jsonRes, callTool } from "./helpers.js";
import { ACCESS_KEY, addAccount, setupPro, SIGNING_KEY } from "./pro-helpers.js";

/**
 * The Vinted Pro tools, end to end through the MCP dispatcher, against the fake
 * Pro API (scripts/fake-pro.ts), which checks every signature on its own.
 */

const item = (over: Record<string, unknown> = {}) => ({
  reference: "SKU-1",
  title: "Kurtka jeansowa Levi's rozmiar M",
  description: "Klasyczna kurtka jeansowa, noszona kilka razy, bez uszkodzeń.",
  price: 39,
  catalog_id: 1234,
  status_id: 2,
  package_size_id: 2,
  brand: "Levi's",
  color_ids: [9],
  size_id: 207,
  photo_urls: ["https://cdn.example/sku-1/1.jpg"],
  ...over,
});

const posts = (fake: FakePro, path: string) => fake.requests.filter((r) => r.method === "POST" && r.path === path);

describe("diagnose_pro", () => {
  it("signs a harmless read, reports the ontology and caches it", async () => {
    const { fake } = setupPro();
    await addAccount();
    const { body } = await callTool("diagnose_pro");
    expect(body).toMatchObject({ ok: true, verdict: "ok", environment: "sandbox", baseUrl: "https://pro-public-sandbox.svc.vinted.com" });
    expect(body.ontology.categories).toEqual({ total: 4, leaves: 2 });
    expect(body.ontology.topLevelKeys.map((k: { key: string }) => k.key)).toContain("catalogs");
    expect(body.server.unix).toBeGreaterThan(1_700_000_000);
    expect(fake.requests[0]!.signatureOk).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SIGNING_KEY);

    // The ontology is now cached: finding a category does not ask Vinted again.
    const before = fake.requests.length;
    await callTool("pro_find_category", { query: "kurtki" });
    expect(fake.requests.length).toBe(before);
  });

  it("says what a refused signature means and what to check", async () => {
    setupPro();
    await addAccount("Zły", "sandbox", `${ACCESS_KEY},wrong-signing-key`);
    const { body } = await callTool("diagnose_pro");
    expect(body).toMatchObject({ ok: false, verdict: "unauthorized", status: 401, code: "INVALID_SIGNATURE" });
    expect(body.hints.join(" ")).toMatch(/clock says/);
    expect(body.hints.join(" ")).toMatch(/sandbox/);
    expect(JSON.stringify(body)).not.toContain("wrong-signing-key");
  });

  it("explains a 403: allowlist, and that Poland is not on the documented list", async () => {
    setupPro({}, () => jsonRes(403, { error: "NOT_ALLOWLISTED" }));
    await addAccount();
    const { body } = await callTool("diagnose_pro");
    expect(body).toMatchObject({ ok: false, verdict: "forbidden", status: 403 });
    expect(body.hints.join(" ")).toMatch(/allowlist/);
    expect(body.hints.join(" ")).toMatch(/Poland/);
  });

  it("reports an unreachable server", async () => {
    setupPro({ VINTED_PRO_MAX_RETRIES: "0" }, () => {
      throw new TypeError("fetch failed");
    });
    await addAccount();
    const { body } = await callTool("diagnose_pro");
    expect(body).toMatchObject({ ok: false, verdict: "network" });
  });

  it("points to the panel when no account is connected", async () => {
    setupPro();
    const { isError, text } = await callTool("diagnose_pro");
    expect(isError).toBe(true);
    expect(text).toMatch(/Konta/);
  });
});

describe("accounts through tools", () => {
  it("lists accounts without secrets, and removes one only with confirm", async () => {
    setupPro();
    const a = await addAccount();
    const listed = await callTool("pro_list_accounts");
    expect(listed.body.accounts).toHaveLength(1);
    expect(listed.text).not.toContain(SIGNING_KEY);
    expect(listed.text).not.toContain(ACCESS_KEY);

    const preview = await callTool("pro_remove_account", { account_id: a.id });
    expect(preview.body).toMatchObject({ preview: true, removed: false });
    expect((await callTool("pro_list_accounts")).body.accounts).toHaveLength(1);
    expect((await callTool("pro_remove_account", { account_id: a.id, confirm: true })).body).toMatchObject({ removed: true });
    expect((await callTool("pro_list_accounts")).body.accounts).toHaveLength(0);
  });

  it("offers no tool that takes a token", async () => {
    const { proTools } = await import("../src/mcp/tools/pro.js");
    for (const tool of proTools) {
      const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
      expect(props.filter((p) => /token|secret|signing|password/i.test(p))).toEqual([]);
    }
  });
});

describe("ontology and categories", () => {
  it("finds leaf categories by words, ignoring diacritics, and shows disabled fields", async () => {
    setupPro();
    await addAccount();
    const jeans = await callTool("pro_find_category", { query: "kurtki jeansowe" });
    expect(jeans.body.categories[0]).toMatchObject({ catalog_id: 1234, leaf: true, path: "Kobiety › Odzież wierzchnia › Kurtki jeansowe" });
    const coats = await callTool("pro_find_category", { query: "plaszcze" });
    expect(coats.body.categories[0]).toMatchObject({ catalog_id: 1235, disabled_fields: ["brand"], size_group_ids: [4] });
    const parents = await callTool("pro_find_category", { query: "odziez wierzchnia" });
    expect(parents.body.categories.map((c: { leaf: boolean }) => c.leaf)).toEqual([true, true, false]);
    expect((await callTool("pro_find_category", { query: "zzz" })).body.count).toBe(0);
  });

  it("returns one section as Vinted sent it, or lists the sections when asked for an unknown one", async () => {
    setupPro();
    await addAccount();
    const colors = await callTool("pro_get_ontology", { key: "colors" });
    expect(colors.body.data).toEqual([{ id: 9, title: "Niebieski" }, { id: 12, title: "Czarny" }]);
    const unknown = await callTool("pro_get_ontology", { key: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/catalogs, colors/);
    const summary = await callTool("pro_get_ontology", { refresh: true });
    expect(summary.body.fromCache).toBe(false);
    expect((await callTool("pro_get_ontology")).body.fromCache).toBe(true);
  });
});

describe("pro_validate_items", () => {
  it("combines the local checks with Vinted's own validation", async () => {
    const { fake } = setupPro();
    await addAccount();
    const { body } = await callTool("pro_validate_items", {
      items: [item(), item({ reference: "SKU-2", catalog_id: 1905, title: "Kurt" })],
    });
    expect(body.ok).toBe(false);
    const fields = body.problems.map((p: { index: number; field: string; level: string }) => `${p.index}:${p.field}:${p.level}`);
    expect(fields).toContain("1:title:warning");
    expect(fields).toContain("1:catalog_id:warning");
    expect(body.vinted.invalid).toBe(1);
    expect(body.vinted.results[1].errors.map((e: { error: string }) => e.error)).toContain("CATALOG_NOT_LEAF");
    expect(posts(fake, "/api/v1/items/validate")).toHaveLength(1);
    expect(posts(fake, "/api/v1/items")).toHaveLength(0);
  });

  it("leaves out a field the category disables, so Vinted does not reject it", async () => {
    const { fake } = setupPro();
    await addAccount();
    const { body } = await callTool("pro_validate_items", { items: [item({ catalog_id: 1235 })] });
    expect(body.ok).toBe(true);
    const sent = JSON.parse(posts(fake, "/api/v1/items/validate")[0]!.body).items[0];
    expect(sent).not.toHaveProperty("brand");
  });

  it("does not demand a brand where the category has none", async () => {
    setupPro();
    await addAccount();
    const noBrand = item({ catalog_id: 1235 });
    delete (noBrand as Record<string, unknown>).brand;
    expect((await callTool("pro_validate_items", { items: [noBrand] })).body.ok).toBe(true);
    const missing = item();
    delete (missing as Record<string, unknown>).brand;
    const bad = await callTool("pro_validate_items", { items: [missing] });
    expect(bad.body.problems[0]).toMatchObject({ field: "brand", level: "error" });
  });
});

describe("pro_create_items", () => {
  it("previews without sending anything to Vinted's items endpoint", async () => {
    const { fake } = setupPro();
    await addAccount();
    const { body } = await callTool("pro_create_items", { items: [item(), item({ reference: "SKU-2" })] });
    expect(body).toMatchObject({ preview: true, sent: false, action: "create_items" });
    expect(body.wouldSend).toMatchObject({ items: 2, requests: 1, mode: "drafts" });
    expect(body.wouldSend.firstItem).toMatchObject({ price: 39, catalog_id: 1234, photos: 1 });
    expect(body.blocked).toBe(false);
    expect(posts(fake, "/api/v1/items")).toHaveLength(0);
    expect(posts(fake, "/api/v1/items/validate")).toHaveLength(0);
  });

  it("blocks an item with a missing required field, even with confirm", async () => {
    const { fake } = setupPro();
    await addAccount();
    const broken = item();
    delete (broken as Record<string, unknown>).package_size_id;
    const preview = await callTool("pro_create_items", { items: [broken] });
    expect(preview.body.blocked).toBe(true);
    const sent = await callTool("pro_create_items", { items: [broken], confirm: true });
    expect(sent.body).toMatchObject({ created: false, blocked: true });
    expect(sent.body.problems[0]).toMatchObject({ field: "package_size_id", level: "error" });
    expect(posts(fake, "/api/v1/items")).toHaveLength(0);
  });

  it("creates drafts by default, after validating, and remembers the item as in progress", async () => {
    const { fake } = setupPro();
    await addAccount();
    const { body } = await callTool("pro_create_items", { items: [item()], confirm: true });
    expect(body).toMatchObject({ created: true, mode: "drafts", itemsSent: 1, requests: 1 });
    expect(body.asynchronous).toMatch(/background/);

    const order = fake.requests.filter((r) => r.method === "POST").map((r) => r.path);
    expect(order).toEqual(["/api/v1/items/validate", "/api/v1/items"]);
    const sent = JSON.parse(posts(fake, "/api/v1/items")[0]!.body);
    expect(sent.items[0]).toMatchObject({ reference: "SKU-1", is_draft: true, price: 39, brand: "Levi's" });

    const listed = await callTool("pro_list_items");
    expect(listed.body.tracked).toEqual([expect.objectContaining({ reference: "SKU-1", status: "IN_PROGRESS" })]);
    expect((await callTool("pro_list_actions")).body.actions[0]).toMatchObject({ kind: "create_items", count: 1, ok: true });
  });

  it("splits a large batch into requests of 100", async () => {
    const { fake } = setupPro();
    await addAccount();
    const items = Array.from({ length: 250 }, (_, i) => item({ reference: `SKU-${i}` }));
    const { body } = await callTool("pro_create_items", { items, confirm: true });
    expect(body).toMatchObject({ created: true, itemsSent: 250, requests: 3 });
    const sizes = posts(fake, "/api/v1/items").map((r) => JSON.parse(r.body).items.length);
    expect(sizes).toEqual([100, 100, 50]);
    expect(posts(fake, "/api/v1/items/validate").map((r) => JSON.parse(r.body).items.length)).toEqual([100, 100, 50]);
  });

  it("refuses more than 500 items in one call", async () => {
    setupPro();
    await addAccount();
    const items = Array.from({ length: 501 }, (_, i) => item({ reference: `SKU-${i}` }));
    const { isError, text } = await callTool("pro_create_items", { items });
    expect(isError).toBe(true);
    expect(text).toMatch(/At most 500/);
  });

  it("will not publish a live listing unless publish: true says so", async () => {
    const { fake } = setupPro();
    await addAccount();
    const live = item({ is_draft: false });
    const refused = await callTool("pro_create_items", { items: [live], confirm: true });
    expect(refused.body).toMatchObject({ created: false, blocked: true });
    expect(refused.body.problems[0].message).toMatch(/publish: true/);
    expect(posts(fake, "/api/v1/items")).toHaveLength(0);

    const published = await callTool("pro_create_items", { items: [live], publish: true, confirm: true });
    expect(published.body).toMatchObject({ created: true, mode: "published" });
    expect(JSON.parse(posts(fake, "/api/v1/items")[0]!.body).items[0].is_draft).toBe(false);
  });

  it("creates nothing when Vinted's validation finds errors, unless told to skip it", async () => {
    const { fake } = setupPro();
    await addAccount();
    const bad = item({ catalog_id: 1905 });
    const stopped = await callTool("pro_create_items", { items: [bad], confirm: true });
    expect(stopped.body).toMatchObject({ created: false });
    expect(stopped.body.validation.invalid).toBe(1);
    expect(posts(fake, "/api/v1/items")).toHaveLength(0);

    const forced = await callTool("pro_create_items", { items: [bad], confirm: true, skip_validation: true });
    expect(forced.body.created).toBe(true);
    expect(posts(fake, "/api/v1/items")).toHaveLength(1);
  });

  it("goes ahead when the validate endpoint does not exist, and says nothing was checked", async () => {
    const { fake } = setupPro({}, (url) => (url.pathname === "/api/v1/items/validate" ? jsonRes(404, { error: "NOT_FOUND" }) : undefined));
    await addAccount();
    const { body } = await callTool("pro_create_items", { items: [item()], confirm: true });
    expect(body.created).toBe(true);
    expect(posts(fake, "/api/v1/items")).toHaveLength(1);
  });

  it("reports where it stopped when a later request fails, because earlier ones already went through", async () => {
    let creates = 0;
    const { fake } = setupPro({ VINTED_PRO_MAX_RETRIES: "0" }, (url, init) => {
      if (url.pathname === "/api/v1/items" && init?.method === "POST" && ++creates === 2) return jsonRes(503, { error: "UNAVAILABLE" });
      return undefined;
    });
    await addAccount();
    const items = Array.from({ length: 150 }, (_, i) => item({ reference: `SKU-${i}` }));
    const { body } = await callTool("pro_create_items", { items, confirm: true, skip_validation: true });
    expect(body).toMatchObject({ created: true, itemsSent: 100, requests: 1 });
    expect(body.stoppedBecause).toMatch(/503/);
    expect(body.warning).toMatch(/already accepted/);
    expect(fake.items.size).toBe(100);
    expect((await callTool("pro_list_actions")).body.actions[0]).toMatchObject({ kind: "create_items", ok: false, count: 100 });
  });

  it("surfaces the error when the very first request fails", async () => {
    setupPro({ VINTED_PRO_MAX_RETRIES: "0" }, (url, init) => (url.pathname === "/api/v1/items" && init?.method === "POST" ? jsonRes(503, {}) : undefined));
    await addAccount();
    const { isError, text } = await callTool("pro_create_items", { items: [item()], confirm: true, skip_validation: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/503/);
  });
});

describe("item status and the other writes", () => {
  it("follows an item from IN_PROGRESS to a draft", async () => {
    const { fake } = setupPro();
    await addAccount();
    await callTool("pro_create_items", { items: [item()], confirm: true });
    const id = [...fake.items.keys()][0]!;
    expect((await callTool("pro_get_item_status", { item_id: id })).body.status).toMatchObject({ status: "IN_PROGRESS" });
    fake.processPending();
    expect((await callTool("pro_get_item_status", { item_id: id })).body.status).toMatchObject({ status: "DRAFT" });
    expect((await callTool("pro_list_items")).body.tracked[0]).toMatchObject({ id, status: "DRAFT" });
  });

  it("updates only with confirm, and only items that name an id and something to change", async () => {
    const { fake } = setupPro();
    await addAccount();
    await callTool("pro_create_items", { items: [item()], confirm: true });
    const id = [...fake.items.keys()][0]!;

    const preview = await callTool("pro_update_items", { items: [{ id, price: 35 }] });
    expect(preview.body).toMatchObject({ preview: true, blocked: false });
    expect(preview.body.wouldSend.fields).toEqual(["price"]);
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(0);

    const sent = await callTool("pro_update_items", { items: [{ id, price: 35, is_draft: false }], confirm: true });
    expect(sent.body).toMatchObject({ updated: true, itemsSent: 1 });
    expect(JSON.parse(fake.requests.filter((r) => r.method === "PUT")[0]!.body)).toEqual({ items: [{ id, price: 35, is_draft: false }] });

    const bad = await callTool("pro_update_items", { items: [{ price: 35 }, { id }, { id: "../x", price: 1 }], confirm: true });
    expect(bad.body).toMatchObject({ updated: false, blocked: true });
    expect(bad.body.problems.map((p: { index: number }) => p.index).sort()).toEqual([0, 1, 2]);
  });

  it("deletes only with confirm and refuses an id that could change the path", async () => {
    const { fake } = setupPro();
    await addAccount();
    const preview = await callTool("pro_delete_items", { item_ids: ["abc"] });
    expect(preview.body).toMatchObject({ preview: true, action: "delete_items" });
    expect(fake.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);

    const sent = await callTool("pro_delete_items", { item_ids: ["abc", "def"], confirm: true });
    expect(sent.body).toMatchObject({ itemsSent: 2 });
    expect(JSON.parse(fake.requests.filter((r) => r.method === "DELETE")[0]!.body)).toEqual({ item_ids: ["abc", "def"] });

    const evil = await callTool("pro_delete_items", { item_ids: ["../orders/1"], confirm: true });
    expect(evil.isError).toBe(true);
    expect(fake.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("sets references on imported items", async () => {
    const { fake } = setupPro();
    await addAccount();
    const preview = await callTool("pro_set_item_references", { items: [{ id: "abc", reference: "SKU-9" }] });
    expect(preview.body.preview).toBe(true);
    const sent = await callTool("pro_set_item_references", { items: [{ id: "abc", reference: "SKU-9" }], confirm: true });
    expect(sent.body.itemsSent).toBe(1);
    expect(JSON.parse(fake.requests.filter((r) => r.method === "PUT")[0]!.body)).toEqual({ items: [{ id: "abc", reference: "SKU-9" }] });
    expect((await callTool("pro_set_item_references", { items: [{ id: "abc" }] })).isError).toBe(true);
  });
});

describe("orders", () => {
  it("lists with the cursor, reads an order and its shipment", async () => {
    const { fake } = setupPro();
    await addAccount();
    const first = fake.addOrder({ items: [{ id: "i1", reference: "SKU-1", price: "39.00" }] });
    const second = fake.addOrder();
    const all = await callTool("pro_list_orders");
    expect(all.body.data.orders).toHaveLength(2);
    const next = await callTool("pro_list_orders", { after_id: String(first.id) });
    expect(next.body.data.orders.map((o: { id: number }) => o.id)).toEqual([second.id]);
    expect(fake.requests.at(-1)!.path).toBe(`/api/v1/orders?after-id=${first.id}`);
    expect((await callTool("pro_get_order", { order_id: String(first.id) })).body.order).toMatchObject({ id: first.id });
    expect((await callTool("pro_get_shipment", { order_id: String(first.id) })).body.shipment).toMatchObject({ carrier: "DPD" });
    expect((await callTool("pro_get_order", { order_id: "1" })).text).toMatch(/Not found \(404, ORDER_NOT_FOUND\)/);
    expect((await callTool("pro_get_order", { order_id: "1/../2" })).isError).toBe(true);
  });

  it("returns the label as a PDF once it exists, and a clear 404 before", async () => {
    const { fake } = setupPro();
    await addAccount();
    const early = fake.addOrder({ labelReady: false });
    const late = fake.addOrder({ labelReady: true });
    expect((await callTool("pro_get_label", { order_id: String(early.id) })).isError).toBe(true);
    const { body } = await callTool("pro_get_label", { order_id: String(late.id) });
    expect(body).toMatchObject({ contentType: "application/pdf", filename: `label_${late.id}.pdf` });
    expect(Buffer.from(body.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.bytes).toBe(Buffer.from(body.base64, "base64").length);
  });

  it("cancels only with confirm and a reason of at most 100 characters", async () => {
    const { fake } = setupPro();
    await addAccount();
    const order = fake.addOrder();
    const preview = await callTool("pro_cancel_order", { order_id: String(order.id), reason: "Przedmiot uszkodzony w magazynie" });
    expect(preview.body).toMatchObject({ preview: true, action: "cancel_order" });
    expect(fake.orders.get(order.id)!.status).toBe("CREATED");

    const tooLong = await callTool("pro_cancel_order", { order_id: String(order.id), reason: "x".repeat(101), confirm: true });
    expect(tooLong.isError).toBe(true);
    expect(fake.orders.get(order.id)!.status).toBe("CREATED");

    const sent = await callTool("pro_cancel_order", { order_id: String(order.id), reason: "Przedmiot uszkodzony w magazynie", confirm: true });
    expect(sent.body).toMatchObject({ cancelled: "requested" });
    expect(fake.orders.get(order.id)!.status).toBe("CANCELLED");
    expect(JSON.parse(posts(fake, `/api/v1/orders/${order.id}/cancel`)[0]!.body)).toEqual({ cancellation_reason_explanation: "Przedmiot uszkodzony w magazynie" });
    expect((await callTool("pro_list_actions")).body.actions[0]).toMatchObject({ kind: "cancel_order", ok: true });
  });

  it("relists with numeric order ids, only with confirm", async () => {
    const { fake } = setupPro();
    await addAccount();
    expect((await callTool("pro_relist_orders", { order_ids: ["987654321"] })).body.preview).toBe(true);
    expect(posts(fake, "/api/v1/orders/relist")).toHaveLength(0);
    await callTool("pro_relist_orders", { order_ids: ["987654321", "5"], confirm: true });
    expect(JSON.parse(posts(fake, "/api/v1/orders/relist")[0]!.body)).toEqual({ order_ids: [987654321, 5] });
  });
});

describe("pro_raw_get", () => {
  it("shows the raw answer, errors included, and keeps to API paths", async () => {
    const { fake } = setupPro();
    await addAccount();
    const ok = await callTool("pro_raw_get", { path: "/api/v1/ontologies" });
    expect(ok.body).toMatchObject({ status: 200 });
    expect(ok.body.json.colors).toBeTruthy();

    const missing = await callTool("pro_raw_get", { path: "/api/v1/orders/42" });
    expect(missing.body).toMatchObject({ status: 404, json: { error: "ORDER_NOT_FOUND" } });

    const withQuery = await callTool("pro_raw_get", { path: "/api/v1/orders", query: { "after-id": "7", limit: 5 } });
    expect(withQuery.body.status).toBe(200);
    expect(fake.requests.at(-1)!.path).toBe("/api/v1/orders?after-id=7&limit=5");

    for (const path of ["/dev/v1/triggers/item-sold/x", "/api/v1/../x", "/oauth/token", "https://evil.example/api/v1/x"]) {
      expect((await callTool("pro_raw_get", { path })).isError).toBe(true);
    }
    expect((await callTool("pro_raw_get", { path: "/api/v1/orders", query: { a: { b: 1 } } })).isError).toBe(true);
  });

  it("returns a non-JSON answer as scrubbed text", async () => {
    setupPro({}, () => new Response(`<h1>gateway</h1> ${SIGNING_KEY}`, { status: 502, headers: { "content-type": "text/html" } }));
    await addAccount();
    const { body } = await callTool("pro_raw_get", { path: "/api/v1/orders" });
    expect(body.status).toBe(502);
    expect(body.text).toContain("gateway");
    expect(body.text).not.toContain(SIGNING_KEY);
  });
});
