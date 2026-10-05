import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import healthHandler from "../api/health.js";
import mcpHandler from "../api/mcp.js";
import { handleApp } from "../src/app/router.js";
import type { VercelLikeRequest, VercelLikeResponse } from "../src/http.js";

/**
 * Local demo: the real panel and backend, with a pretend Vinted.
 *
 *   npm run demo        then open http://localhost:3000, password "demo"
 *
 * Every request to a Vinted host is answered from memory here, so the whole
 * panel can be tried without an account or network access. Login password for
 * the pretend Vinted is "demo-pass"; a login name containing "2fa" asks for the
 * code 123456. This file is a development aid and is not deployed.
 */

process.env.ADMIN_PASSWORD ??= "demo";
process.env.ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.MCP_AUTH_TOKEN ??= "demo-mcp-token";
process.env.VINTED_MIN_REQUEST_INTERVAL_MS ??= "0";
process.env.ACTIVE_HOURS ??= "0-0";

// ---------------------------------------------------------------- pretend Vinted
const messages: Record<string, { id: number; entity_type: string; entity: Record<string, unknown>; created_at_ts: string }[]> = {
  "101": [
    { id: 1, entity_type: "message", entity: { body: "Dzień dobry, czy kurtka jest nadal dostępna?", user_id: 7 }, created_at_ts: new Date(Date.now() - 3600_000).toISOString() },
    { id: 2, entity_type: "message", entity: { body: "Tak, jest dostępna 🙂", user_id: 42 }, created_at_ts: new Date(Date.now() - 3000_000).toISOString() },
    { id: 3, entity_type: "offer_request_message", entity: { id: 900, price: { amount: "90", currency_code: "PLN" }, status_title: "Oczekuje na odpowiedź", user_id: 7 }, created_at_ts: new Date(Date.now() - 600_000).toISOString() },
  ],
  "102": [{ id: 4, entity_type: "message", entity: { body: "Dziękuję, paczka doszła!", user_id: 8 }, created_at_ts: new Date(Date.now() - 86400_000).toISOString() }],
  "103": [{ id: 5, entity_type: "message", entity: { body: "Czy zejdziesz do 60 zł?", user_id: 9 }, created_at_ts: new Date(Date.now() - 1800_000).toISOString() }],
};
const conversations = [
  { id: 101, who: { id: 7, login: "kupujaca_ania" }, item: { id: 555, title: "Kurtka Zara M", price: "120.0" }, unread: true },
  { id: 102, who: { id: 8, login: "marek_88" }, item: { id: 556, title: "Buty Nike Air Max 42", price: "180.0" }, unread: false },
  { id: 103, who: { id: 9, login: "basia.k" }, item: { id: 557, title: "Sukienka H&M S", price: "70.0" }, unread: true },
];
let nextPhoto = 9000;
let sellerPolls = 0;

const mine = [
  { id: 555, title: "Kurtka Zara M", price: { amount: "120.0", currency_code: "PLN" }, view_count: 214, favourite_count: 18, brand_title: "Zara", size_title: "M" },
  { id: 556, title: "Buty Nike Air Max 42", price: { amount: "180.0", currency_code: "PLN" }, view_count: 96, favourite_count: 7, brand_title: "Nike", size_title: "42" },
];
const catalog = Array.from({ length: 14 }, (_, i) => ({
  id: 1000 + i,
  title: ["Kurtka Zara M", "Zara płaszcz wełniany", "Kurtka zimowa Zara", "Zara bluza", "Kurtka jeansowa Zara"][i % 5],
  price: { amount: String(60 + i * 9), currency_code: "PLN" },
  brand_title: "Zara",
  size_title: "M",
  favourite_count: i,
  user: { id: 300 + i, login: `sprzedawca${i}` },
}));

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function pretendVinted(url: URL, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  const path = url.pathname;
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const tokens = { access_token: "demo-access", refresh_token: "demo-refresh", expires_in: 7200 };

  if (path === "/" && method === "GET") return new Response("<html></html>", { headers: { "content-type": "text/html" } });
  if (path === "/oauth/token") {
    if (body.grant_type === "refresh_token") return json(200, tokens);
    // The code step carries the challenge token and the code, not the password.
    if (body.verification_code) {
      if (body.two_factor_token !== "demo-tft") return json(400, { error: "invalid_grant" });
      if (body.verification_code !== "123456") return json(400, { error: "invalid_code", error_description: "Nieprawidłowy kod" });
      return json(200, tokens, { "set-cookie": "_vinted_fr_session=demo-session; Path=/" });
    }
    if (body.password !== "demo-pass") return json(400, { error: "invalid_grant" });
    if (String(body.username).includes("2fa")) {
      return json(400, { error: "two_factor_required", two_factor_token: "demo-tft", message: "Wysłaliśmy kod SMS", phone_hint: "+48 *** *** 321" });
    }
    return json(200, tokens, { "set-cookie": "_vinted_fr_session=demo-session; Path=/" });
  }
  if (path === "/api/v2/users/current") return json(200, { user: { id: 42, login: "demo_ala" } });
  if (path === "/api/v2/inbox") {
    return json(200, {
      conversations: conversations.map((c) => ({
        id: c.id,
        description: String((messages[String(c.id)]!.at(-1)!.entity.body ?? messages[String(c.id)]!.at(-1)!.entity.status_title) ?? ""),
        unread: c.unread,
        updated_at: messages[String(c.id)]!.at(-1)!.created_at_ts,
        opposite_user: c.who,
        transaction: { item_id: c.item.id, item_title: c.item.title, item_price: { amount: c.item.price, currency_code: "PLN" } },
      })),
    });
  }
  let m = /^\/api\/v2\/conversations\/(\d+)$/.exec(path);
  if (m && method === "GET") {
    const c = conversations.find((x) => String(x.id) === m![1])!;
    c.unread = false;
    return json(200, { conversation: { id: c.id, opposite_user: c.who, transaction: { item_id: c.item.id, item_title: c.item.title, item_price: { amount: c.item.price, currency_code: "PLN" } }, messages: messages[m[1]!] } });
  }
  m = /^\/api\/v2\/conversations\/(\d+)\/messages$/.exec(path);
  if (m && method === "POST") {
    messages[m[1]!]!.push({ id: Date.now(), entity_type: "message", entity: { body: body.body, user_id: 42 }, created_at_ts: new Date().toISOString() });
    return json(200, {});
  }
  m = /^\/api\/v2\/conversations\/(\d+)\/offers\/(\d+)\/(accept|reject)$/.exec(path);
  if (m) {
    const offer = messages[m[1]!]!.find((x) => x.entity.id === Number(m![2]));
    if (offer) offer.entity.status_title = m[3] === "accept" ? "Zaakceptowana" : "Odrzucona";
    return json(200, {});
  }
  if (path === "/api/v2/users/42/items") return json(200, { items: mine });
  if (path === "/api/v2/users/777") return json(200, { user: { id: 777, login: "sprzedawca777" } });
  if (path === "/api/v2/users/777/items") {
    sellerPolls++;
    const items = [
      { id: 7001, title: "Sweter wełniany", price: { amount: "80.0", currency_code: "PLN" }, user: { id: 777, login: "sprzedawca777" } },
      { id: 7002, title: "Spodnie Levi's 501", price: { amount: "110.0", currency_code: "PLN" }, user: { id: 777, login: "sprzedawca777" } },
    ];
    // From the second poll on, the seller has posted something new.
    if (sellerPolls > 1) items.unshift({ id: 7003, title: "Nowa kurtka puchowa", price: { amount: "250.0", currency_code: "PLN" }, user: { id: 777, login: "sprzedawca777" } });
    return json(200, { items });
  }
  if (path === "/api/v2/catalog/items") return json(200, { items: catalog });
  if (path === "/api/v2/catalogs") {
    return json(200, { catalogs: [{ id: 1, title: "Kobiety", children: [{ id: 10, title: "Odzież wierzchnia", children: [{ id: 1001, title: "Kurtki", children: [] }, { id: 1002, title: "Płaszcze", children: [] }] }] }] });
  }
  if (path === "/api/v2/search_suggestions") return json(200, { search_suggestions: [{ id: 53, title: "Zara", type: "brand" }, { id: 12, title: "Nike", type: "brand" }] });
  if (path === "/api/v2/photos") return json(200, { id: nextPhoto++ });
  if (path === "/api/v2/items" && method === "POST") return json(200, { item: { id: 8000 + Math.floor(Math.random() * 999) } });
  if (path.startsWith("/api/v2/items/") || path === "/api/v2/offers" || path === "/api/v2/user_favourites/toggle") return json(200, {});
  return json(404, { error: "not_found_in_demo", path });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  if (/(^|\.)vinted\.[a-z.]+$/.test(url.hostname)) return pretendVinted(url, init);
  return realFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------- server
const PUBLIC = join(process.cwd(), "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://local").pathname;
  const r = req as VercelLikeRequest;
  const s = res as VercelLikeResponse;
  if (pathname.startsWith("/api/app")) return void (await handleApp(r, s));
  if (pathname === "/api/mcp") return void (await mcpHandler(r, s));
  if (pathname === "/api/health") return void (await healthHandler(r, s));

  const file = normalize(join(PUBLIC, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(await readFile(file));
  } catch {
    res.writeHead(404).end("Not found");
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`Demo panel: http://localhost:${port}  (password: ${process.env.ADMIN_PASSWORD})`);
  console.log('Pretend Vinted login password: "demo-pass"; a login containing "2fa" asks for code 123456.');
});
