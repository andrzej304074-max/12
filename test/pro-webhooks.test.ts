import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhook, type FakePro } from "../scripts/fake-pro.js";
import { describeProAccount, getProAccount, listWebhookSecrets } from "../src/pro/accounts.js";
import { listProEvents, recordProEvent } from "../src/pro/events.js";
import { handleProWebhook, listRefusedDeliveries } from "../src/pro/receiver.js";
import { reconcileAllPro, reconcileProAccount } from "../src/pro/reconcile.js";
import { getItemStates } from "../src/pro/state.js";
import { checkWebhookUrl } from "../src/pro/webhooks.js";
import type { VercelLikeRequest, VercelLikeResponse } from "../src/http.js";
import { callTool, jsonRes } from "./helpers.js";
import { addAccount, setupPro, SIGNING_KEY } from "./pro-helpers.js";

const HOST = "https://panel.example.app";
const URL_FOR = (id: string) => `${HOST}/api/pro/webhook?account=${id}`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    void handleProWebhook(req as VercelLikeRequest, res as VercelLikeResponse);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});
afterEach(() => vi.restoreAllMocks());

let fake: FakePro;
let calls: { url: URL; init?: RequestInit }[];

function start(extraEnv: Record<string, string | undefined> = {}, handler?: Parameters<typeof setupPro>[1]) {
  const s = setupPro(extraEnv, handler);
  fake = s.fake;
  calls = s.net.calls;
}

/** Registers the webhook through the tool and returns Vinted's signing key for it. */
async function registerHook() {
  const account = await addAccount();
  await callTool("pro_register_webhook", { url: `${HOST}/api/pro/webhook`, confirm: true });
  const key = [...fake.webhooks.values()][0]!.signing_key;
  return { account, key };
}

async function deliver(raw: string, opts: { key?: string; t?: number; account?: string | null; method?: string; signature?: string | null } = {}) {
  const signature = opts.signature === undefined ? signWebhook(raw, opts.key ?? "", opts.t) : opts.signature;
  const query = opts.account === null ? "" : `?account=${opts.account ?? "pro-test"}`;
  const res = await fetch(`${base}/api/pro/webhook${query}`, {
    method: opts.method ?? "POST",
    headers: { "content-type": "application/json", ...(signature ? { "x-vpi-webhook-hmac-sha256": signature } : {}) },
    ...((opts.method ?? "POST") === "POST" ? { body: raw } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, allow: res.headers.get("allow") };
}

const envelope = (type: string, data: Record<string, unknown> = {}) => JSON.stringify({ event_type: type, data });

describe("registering the webhook", () => {
  beforeEach(() => start());

  it("previews without sending, with this deployment's address and every documented event", async () => {
    const account = await addAccount();
    const { body } = await callTool("pro_register_webhook", { url: `${HOST}/api/pro/webhook` });
    expect(body).toMatchObject({ preview: true, sent: false, action: "register_webhook" });
    expect(body.wouldSend.url).toBe(URL_FOR(account.id));
    expect(body.wouldSend.events).toContain("ITEM_SOLD");
    expect(body.wouldSend.events).toHaveLength(17);
    expect(fake.requests.filter((r) => r.path === "/api/v1/webhooks")).toHaveLength(0);
  });

  it("registers with confirm, stores the key encrypted and never shows it", async () => {
    const account = await addAccount();
    const { body, text } = await callTool("pro_register_webhook", { url: `${HOST}/api/pro/webhook`, events: ["ITEM_SOLD", "ORDER_CREATED"], confirm: true });
    const key = [...fake.webhooks.values()][0]!.signing_key;
    expect(body).toMatchObject({ registered: true, url: URL_FOR(account.id), events: ["ITEM_SOLD", "ORDER_CREATED"] });
    expect(text).not.toContain(key);

    const sent = JSON.parse(fake.requests.find((r) => r.method === "POST" && r.path === "/api/v1/webhooks")!.body);
    expect(sent).toEqual({ url: URL_FOR(account.id), event_types: ["ITEM_SOLD", "ORDER_CREATED"] });
    expect(await listWebhookSecrets()).toEqual([{ accountId: account.id, signingKey: key }]);
    expect((await describeProAccount(account.id))?.webhook).toEqual({ registered: true, url: URL_FOR(account.id), events: ["ITEM_SOLD", "ORDER_CREATED"] });

    const listed = await callTool("pro_list_webhooks");
    expect(listed.body.registeredHere.registered).toBe(true);
    expect(listed.text).not.toContain(key);
  });

  it("replaces an earlier registration instead of piling up", async () => {
    await addAccount();
    await callTool("pro_register_webhook", { url: `${HOST}/api/pro/webhook`, confirm: true });
    const first = [...fake.webhooks.keys()][0]!;
    await callTool("pro_register_webhook", { url: `${HOST}/api/pro/webhook`, confirm: true });
    expect(fake.webhooks.has(first)).toBe(false);
    expect(fake.webhooks.size).toBe(1);
    expect((await callTool("pro_register_webhook", { url: `${HOST}/api/pro/webhook` })).body.replaces).toMatch(/panel\.example/);
  });

  it("removes a registration whose answer has no signing key, rather than keep one it cannot verify", async () => {
    start({}, (url, init) => {
      if (url.pathname === "/api/v1/webhooks" && init?.method === "POST") return jsonRes(201, { id: "wh_x" });
      if (url.pathname === "/api/v1/webhooks/wh_x" && init?.method === "DELETE") return new Response(null, { status: 204 });
      return undefined;
    });
    const account = await addAccount();
    const { isError, text } = await callTool("pro_register_webhook", { url: `${HOST}/api/pro/webhook`, confirm: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/did not return its signing key/);
    expect((await describeProAccount(account.id))?.webhook.registered).toBe(false);
    expect(await listWebhookSecrets()).toEqual([]);
  });

  it("accepts only this deployment's webhook address", async () => {
    start();
    expect(checkWebhookUrl(`${HOST}/api/pro/webhook`, "pro-a")).toBe(`${HOST}/api/pro/webhook?account=pro-a`);
    expect(checkWebhookUrl(`${HOST}/api/pro/webhook?x=1#y`, "pro-a")).toBe(`${HOST}/api/pro/webhook?account=pro-a`);
    expect(() => checkWebhookUrl(`${HOST}/somewhere/else`, "pro-a")).toThrow(/must end with \/api\/pro\/webhook/);
    expect(() => checkWebhookUrl("not a url", "pro-a")).toThrow(/valid URL/);
    expect(() => checkWebhookUrl("ftp://x.example/api/pro/webhook", "pro-a")).toThrow(/http\(s\)/);
    expect(() => checkWebhookUrl(`${HOST}/api/pro/webhook`, "../x")).toThrow();

    start({ NODE_ENV: "production" });
    expect(() => checkWebhookUrl("http://panel.example.app/api/pro/webhook", "pro-a")).toThrow(/must be https/);
    expect(() => checkWebhookUrl("https://localhost/api/pro/webhook", "pro-a")).toThrow(/public address/);
    expect(() => checkWebhookUrl("https://192.168.1.5/api/pro/webhook", "pro-a")).toThrow(/public address/);
  });

  it("needs an address, takes the Vercel one when it is known, and checks the event names", async () => {
    await addAccount();
    const missing = await callTool("pro_register_webhook", {});
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/"url" is required/);

    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "my-app.vercel.app");
    const withDefault = await callTool("pro_register_webhook", {});
    expect(withDefault.body.wouldSend.url).toMatch(/^https:\/\/my-app\.vercel\.app\/api\/pro\/webhook\?account=/);
    vi.unstubAllEnvs();

    const bad = await callTool("pro_register_webhook", { url: `${HOST}/api/pro/webhook`, events: ["not an event"] });
    expect(bad.isError).toBe(true);
  });

  it("deletes only with confirm, and forgets a webhook that is already gone at Vinted", async () => {
    const { account } = await registerHook();
    const preview = await callTool("pro_delete_webhook", {});
    expect(preview.body).toMatchObject({ preview: true, action: "delete_webhook" });
    expect(fake.webhooks.size).toBe(1);

    fake.webhooks.clear(); // gone at Vinted already
    const done = await callTool("pro_delete_webhook", { confirm: true });
    expect(done.isError).toBe(false);
    expect((await describeProAccount(account.id))?.webhook.registered).toBe(false);
    expect((await callTool("pro_delete_webhook", { confirm: true })).isError).toBe(true);
  });
});

describe("receiving a delivery", () => {
  beforeEach(() => start());

  it("records a delivery signed over the raw body and updates the item index", async () => {
    const { account, key } = await registerHook();
    const raw = envelope("CREATE_ITEM_SUCCESS", { id: "item-1", reference: "SKU-1" });
    const r = await deliver(raw, { key, account: account.id });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });

    const events = await listProEvents(account.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "CREATE_ITEM_SUCCESS", itemId: "item-1", reference: "SKU-1", summary: "CREATE_ITEM_SUCCESS · reference SKU-1 · item item-1" });
    expect(await getItemStates(account.id)).toEqual([expect.objectContaining({ id: "item-1", reference: "SKU-1", status: "CREATED" })]);
    expect((await callTool("pro_list_events")).body.events).toHaveLength(1);
  });

  it("verifies against the exact bytes: whitespace and key order matter, a re-serialised body is not the same", async () => {
    const { account, key } = await registerHook();
    const pretty = JSON.stringify({ event_type: "ITEM_SOLD", data: { id: "i1", note: "żółć" } }, null, 2);
    expect((await deliver(pretty, { key, account: account.id })).status).toBe(200);
    // Signed over one text, sent as another with identical meaning: refused.
    const compact = JSON.stringify(JSON.parse(pretty));
    const signedForPretty = signWebhook(pretty, key);
    expect((await deliver(compact, { account: account.id, signature: signedForPretty })).status).toBe(401);
  });

  it("refuses a wrong key, a tampered body, an old timestamp and a missing signature, and records none of them", async () => {
    const { account, key } = await registerHook();
    const raw = envelope("ITEM_SOLD", { id: "i1" });
    expect((await deliver(raw, { key: "whsec_other", account: account.id })).status).toBe(401);
    expect((await deliver(raw.replace("i1", "i2"), { account: account.id, signature: signWebhook(raw, key) })).status).toBe(401);
    expect((await deliver(raw, { key, t: Math.floor(Date.now() / 1000) - 3600, account: account.id })).status).toBe(401);
    expect((await deliver(raw, { account: account.id, signature: null })).status).toBe(401);
    expect(await listProEvents(account.id)).toEqual([]);

    const refused = await listRefusedDeliveries();
    expect(refused).toHaveLength(4);
    expect(refused.map((r) => r.reasons[0])).toEqual([
      `${account.id}: missing`,
      `${account.id}: stale`,
      `${account.id}: mismatch`,
      `${account.id}: mismatch`,
    ]);
    expect(JSON.stringify(refused)).not.toContain(key);
    expect(JSON.stringify(refused)).not.toContain("i1");
    expect(refused[0]).toMatchObject({ fromParsed: false, hadSignature: false, bodyBytes: raw.length });
  });

  it("refuses a delivery that names another account, or when nothing is registered", async () => {
    const { account, key } = await registerHook();
    const raw = envelope("ITEM_SOLD", { id: "i1" });
    expect((await deliver(raw, { key, account: "pro-other" })).status).toBe(401);
    expect((await listRefusedDeliveries())[0]!.reasons[0]).toMatch(/no webhook registered for "pro-other"/);
    // Without ?account= the receiver tries every registered key.
    expect((await deliver(raw, { key, account: null })).status).toBe(200);
    expect(await listProEvents(account.id)).toHaveLength(1);

    start();
    expect((await deliver(raw, { key: "whsec_x", account: "pro-test" })).status).toBe(401);
    expect((await listRefusedDeliveries())[0]!.reasons).toEqual(["no webhook registered for \"pro-test\""]);
  });

  it("handles a repeated delivery once", async () => {
    const { account, key } = await registerHook();
    const raw = envelope("ORDER_CREATED", { id: 987654321 });
    const signature = signWebhook(raw, key);
    expect((await deliver(raw, { account: account.id, signature })).json).toEqual({ ok: true });
    expect((await deliver(raw, { account: account.id, signature })).json).toEqual({ ok: true, duplicate: true });
    expect(await listProEvents(account.id)).toHaveLength(1);
    expect((await listProEvents(account.id))[0]).toMatchObject({ orderId: "987654321", itemId: null });
  });

  it("rejects a verified delivery that is not an event, and anything but POST or a huge body", async () => {
    const { account, key } = await registerHook();
    expect((await deliver("not json", { key, account: account.id })).status).toBe(400);
    expect((await deliver(JSON.stringify({ data: {} }), { key, account: account.id })).status).toBe(400);
    expect((await deliver(JSON.stringify({ event_type: "lower case", data: {} }), { key, account: account.id })).status).toBe(400);
    const get = await deliver("", { method: "GET", key, account: account.id });
    expect(get.status).toBe(405);
    expect(get.allow).toBe("POST");
    const huge = await fetch(`${base}/api/pro/webhook?account=${account.id}`, { method: "POST", body: "x".repeat(1_100_000) });
    expect(huge.status).toBe(413);
    expect(await listProEvents(account.id)).toEqual([]);
  });

  it("keeps the last 100 events, newest first, and can filter by type", async () => {
    const { account, key } = await registerHook();
    for (let i = 0; i < 104; i++) {
      await recordProEvent(account.id, i % 5 === 0 ? "ITEM_SOLD" : "ITEM_PUBLISHED", { id: `i${i}` });
    }
    // The newest one arrives the real way, through the receiver.
    expect((await deliver(envelope("ITEM_SOLD", { id: "i104" }), { key, account: account.id })).status).toBe(200);
    const all = await listProEvents(account.id, { limit: 500 });
    expect(all).toHaveLength(100);
    expect(all[0]!.itemId).toBe("i104");
    expect(all.at(-1)!.itemId).toBe("i5");
    const sold = await callTool("pro_list_events", { type: "ITEM_SOLD", limit: 3 });
    expect(sold.body.events.map((e: { itemId: string }) => e.itemId)).toEqual(["i104", "i100", "i95"]);
  });

  it("never writes the body or the key to the log", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { account, key } = await registerHook();
    await deliver(envelope("ITEM_SOLD", { id: "secret-item-id-123" }), { key: "whsec_other", account: account.id });
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/pro webhook refused/);
    expect(logged).not.toContain("secret-item-id-123");
    expect(logged).not.toContain(key);
    expect(logged).not.toContain(SIGNING_KEY);
  });
});

describe("when the platform parsed the body first", () => {
  beforeEach(() => start());

  function fakeReq(parsed: unknown, headers: Record<string, string>, accountId: string): VercelLikeRequest {
    const req = Readable.from([]) as unknown as VercelLikeRequest;
    Object.assign(req, { method: "POST", url: `/api/pro/webhook?account=${accountId}`, headers, body: parsed });
    return req;
  }
  function fakeRes() {
    const out: { status: number; body: string } = { status: 0, body: "" };
    const res = {
      writeHead(status: number) {
        out.status = status;
        return res;
      },
      end(body?: string) {
        out.body = body ?? "";
      },
    } as unknown as VercelLikeResponse;
    return { res, out };
  }

  it("verifies compact JSON, which re-serialising reproduces exactly", async () => {
    const { account, key } = await registerHook();
    const raw = envelope("ITEM_SOLD", { id: "i1", reference: "SKU-1" });
    const { res, out } = fakeRes();
    await handleProWebhook(fakeReq(JSON.parse(raw), { "x-vpi-webhook-hmac-sha256": signWebhook(raw, key) }, account.id), res);
    expect(out.status).toBe(200);
    expect(await listProEvents(account.id)).toHaveLength(1);
  });

  it("fails closed when the original had other whitespace, and says the body was rebuilt", async () => {
    const { account, key } = await registerHook();
    const raw = JSON.stringify({ event_type: "ITEM_SOLD", data: { id: "i1" } }, null, 2);
    const { res, out } = fakeRes();
    await handleProWebhook(fakeReq(JSON.parse(raw), { "x-vpi-webhook-hmac-sha256": signWebhook(raw, key) }, account.id), res);
    expect(out.status).toBe(401);
    expect(await listProEvents(account.id)).toEqual([]);
    expect((await listRefusedDeliveries())[0]).toMatchObject({ fromParsed: true });
    expect((await callTool("pro_list_events")).body.rawBodyForWebhooks).toBe(false);
  });
});

describe("what a delivery sets in motion", () => {
  it("notifies about a sale and survives a notification that fails", async () => {
    start({ NOTIFY_WEBHOOK_URL: "https://hooks.example/notify" }, (url) => (url.hostname === "hooks.example" ? new Response("nope", { status: 500 }) : undefined));
    const { account, key } = await registerHook();
    const r = await deliver(envelope("ITEM_SOLD", { id: "i1", reference: "SKU-1" }), { key, account: account.id });
    expect(r.status).toBe(200);
    const notified = calls.filter((c) => c.url.hostname === "hooks.example");
    expect(notified).toHaveLength(1);
    expect(JSON.parse(String(notified[0]!.init!.body)).text).toBe(`Vinted Pro [${account.id}]: ITEM_SOLD · reference SKU-1 · item i1`);
    expect(await listProEvents(account.id)).toHaveLength(1);
  });

  it("does not notify about routine events", async () => {
    start({ NOTIFY_WEBHOOK_URL: "https://hooks.example/notify" }, (url) => (url.hostname === "hooks.example" ? new Response("ok") : undefined));
    const { account, key } = await registerHook();
    await deliver(envelope("ITEM_UPDATED", { id: "i1" }), { key, account: account.id });
    expect(calls.filter((c) => c.url.hostname === "hooks.example")).toHaveLength(0);
  });

  it("flags the account when Vinted reports an authentication problem", async () => {
    start();
    const { account, key } = await registerHook();
    await deliver(envelope("VINTED_AUTHENTICATION_ERROR", {}), { key, account: account.id });
    expect(await describeProAccount(account.id)).toMatchObject({ status: "rejected" });
  });
});

describe("the sandbox path: sale, order, label", () => {
  it("runs from a created item to a downloadable label through signed webhooks", async () => {
    start();
    const { account, key } = await registerHook();
    await callTool("pro_create_items", {
      confirm: true,
      items: [{ reference: "SKU-1", title: "Kurtka jeansowa Levi's M", description: "Klasyczna kurtka, bez uszkodzeń.", price: 39, catalog_id: 1234, status_id: 2, package_size_id: 2, brand: "Levi's", photo_urls: ["https://cdn.example/1.jpg"] }],
    });
    fake.processPending();
    const itemId = [...fake.items.keys()][0]!;

    const preview = await callTool("pro_simulate_sale", { item_id: itemId });
    expect(preview.body.preview).toBe(true);
    expect(fake.orders.size).toBe(0);
    await callTool("pro_simulate_sale", { item_id: itemId, confirm: true });
    expect(fake.orders.size).toBe(1);

    // Vinted would now call the webhook; do it the way it does, signed with the registration's key.
    for (const event of fake.outbox) {
      expect((await deliver(JSON.stringify({ event_type: event.event_type, data: event.data }), { key, account: account.id })).status).toBe(200);
    }
    const types = (await listProEvents(account.id, { limit: 100 })).map((e) => e.type).sort();
    expect(types).toEqual(["CREATE_ITEM_SUCCESS", "ITEM_SOLD", "ORDER_CREATED", "SHIPMENT_LABEL_CREATED"]);
    expect((await getItemStates(account.id)).find((s) => s.id === itemId)?.status).toBe("SOLD");

    const order = [...fake.orders.values()][0]!;
    const label = await callTool("pro_get_label", { order_id: String(order.id) });
    expect(Buffer.from(label.body.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("refuses to simulate a sale for a production account", async () => {
    start();
    await addAccount("Prod", "production");
    const { isError, text } = await callTool("pro_simulate_sale", { item_id: "x", confirm: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/only be simulated in the sandbox/);
  });
});

describe("the daily catch-up", () => {
  const later = () => Date.now() + 10 * 60 * 1000;
  const first = { reference: "SKU-1", title: "Kurtka jeansowa Levi's M", description: "Klasyczna kurtka, bez uszkodzeń.", price: 39, catalog_id: 1234, status_id: 2, package_size_id: 2, brand: "Levi's", photo_urls: ["https://cdn.example/1.jpg"] };

  it("asks for the status of items still in progress and picks up what a lost webhook missed", async () => {
    start();
    await addAccount();
    await callTool("pro_create_items", { items: [first], confirm: true });
    const account = await getProAccount();

    // Too fresh: left alone.
    expect((await reconcileProAccount(account)).checkedItems).toBe(0);

    fake.processPending(); // Vinted finished; the webhook never arrived
    const result = await reconcileProAccount(account, { now: later() });
    expect(result).toMatchObject({ checkedItems: 1, updatedItems: 1, errors: [], skipped: null });
    expect((await getItemStates(account.id))[0]).toMatchObject({ status: "DRAFT" });
    // Settled: nothing to ask next time.
    expect((await reconcileProAccount(account, { now: later() })).checkedItems).toBe(0);
  });

  it("refreshes the ontology only when its cache is old or missing", async () => {
    start();
    await addAccount();
    const account = await getProAccount();
    expect((await reconcileProAccount(account)).ontologyRefreshed).toBe(true);
    expect((await reconcileProAccount(account)).ontologyRefreshed).toBe(false);
    expect((await reconcileProAccount(account, { now: Date.now() + 21 * 3600 * 1000 })).ontologyRefreshed).toBe(true);
  });

  it("leaves a rejected token alone", async () => {
    start({}, () => jsonRes(401, { error: "INVALID_SIGNATURE" }));
    await addAccount();
    await callTool("diagnose_pro"); // flags the account
    const results = await reconcileAllPro();
    expect(results).toHaveLength(1);
    expect(results[0]!.skipped).toMatch(/token rejected/);
    expect(results[0]!.checkedItems).toBe(0);
  });

  it("stops asking when Vinted rate limits", async () => {
    let statusCalls = 0;
    start({ VINTED_PRO_MAX_RETRIES: "0" }, (url) => {
      if (url.pathname.endsWith("/status")) {
        statusCalls++;
        return jsonRes(429, { error: "TOO_MANY" }, { "retry-after": "0" });
      }
      return undefined;
    });
    await addAccount();
    await callTool("pro_create_items", {
      confirm: true,
      skip_validation: true,
      items: [first, { ...first, reference: "SKU-2" }, { ...first, reference: "SKU-3" }],
    });
    const result = await reconcileProAccount(await getProAccount(), { now: later() });
    expect(statusCalls).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});
