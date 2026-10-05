import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApp } from "../src/app/router.js";
import type { VercelLikeRequest, VercelLikeResponse } from "../src/http.js";
import { setupPro, ACCESS_KEY, PRO_TOKEN, SIGNING_KEY } from "./pro-helpers.js";

/** The panel's Vinted Pro routes: the token goes in through a dedicated route and never comes back out. */

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleApp(req as VercelLikeRequest, res as VercelLikeResponse);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

let fake: ReturnType<typeof setupPro>["fake"];
beforeEach(() => {
  ({ fake } = setupPro({ ADMIN_PASSWORD: "panel-pass" }));
});
afterEach(() => vi.unstubAllGlobals());

async function call(path: string, opts: { method?: string; body?: unknown; rawBody?: string; cookie?: string; origin?: string | null } = {}) {
  const method = opts.method ?? "GET";
  const origin = opts.origin === undefined ? (method === "GET" ? null : base) : opts.origin;
  const res = await fetch(`${base}/api/app${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined || opts.rawBody !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(origin ? { origin } : {}),
    },
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, setCookie: res.headers.get("set-cookie") };
}

async function signIn(): Promise<string> {
  const r = await call("/login", { method: "POST", body: { password: "panel-pass" } });
  return r.setCookie!.split(";")[0]!;
}

const good = { label: "Sklep główny", env: "sandbox", token: PRO_TOKEN };

describe("adding a Vinted Pro account", () => {
  it("needs a session and the panel's own origin", async () => {
    expect((await call("/pro-account", { method: "POST", body: good })).status).toBe(401);
    const cookie = await signIn();
    expect((await call("/pro-account", { method: "POST", body: good, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/pro-account", { method: "POST", body: good, cookie, origin: null })).status).toBe(403);
  });

  it("stores the token and answers with a summary that has no secret in it", async () => {
    const cookie = await signIn();
    const r = await call("/pro-account", { method: "POST", body: good, cookie });
    expect(r.status).toBe(200);
    expect(r.json.account).toMatchObject({ id: "pro-sklep-glowny", label: "Sklep główny", env: "sandbox", status: "connected" });
    expect(r.text).not.toContain(SIGNING_KEY);
    expect(r.text).not.toContain(ACCESS_KEY);

    const listed = await call("/tool", { method: "POST", body: { name: "pro_list_accounts", arguments: {} }, cookie });
    expect(listed.json.data.accounts).toHaveLength(1);
    expect(listed.text).not.toContain(SIGNING_KEY);
  });

  it("then lets the panel run the connection check through the tool endpoint", async () => {
    const cookie = await signIn();
    await call("/pro-account", { method: "POST", body: good, cookie });
    const r = await call("/tool", { method: "POST", body: { name: "diagnose_pro", arguments: { account_id: "pro-sklep-glowny" } }, cookie });
    expect(r.json.isError).toBe(false);
    expect(r.json.data).toMatchObject({ ok: true, verdict: "ok" });
    expect(fake.requests[0]!.signatureOk).toBe(true);
  });

  it("replaces the token of an existing account", async () => {
    const cookie = await signIn();
    await call("/pro-account", { method: "POST", body: good, cookie });
    const r = await call("/pro-account", { method: "POST", body: { ...good, accountId: "pro-sklep-glowny", env: "production", token: "NEW,NEWKEY" }, cookie });
    expect(r.status).toBe(200);
    expect(r.json.account).toMatchObject({ id: "pro-sklep-glowny", env: "production" });
    const listed = await call("/tool", { method: "POST", body: { name: "pro_list_accounts", arguments: {} }, cookie });
    expect(listed.json.data.accounts).toHaveLength(1);
  });

  it.each([
    ["an unknown environment", { ...good, env: "staging" }, /sandbox or production/],
    ["a token with no comma", { ...good, token: "justonepart" }, /<access_key>,<signing_key>/],
    ["no name", { ...good, label: "" }, /1 to 60/],
    ["an unknown account id", { ...good, accountId: "pro-nope" }, /Unknown/],
  ])("answers 400 for %s", async (_name, body, message) => {
    const cookie = await signIn();
    const r = await call("/pro-account", { method: "POST", body, cookie });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_input");
    expect(r.json.message).toMatch(message);
    expect(r.text).not.toContain("justonepart");
  });

  it("does not quote a broken request body, which could contain the token", async () => {
    const cookie = await signIn();
    const r = await call("/pro-account", { method: "POST", rawBody: `{"label":"A","env":"sandbox","token":"${ACCESS_KEY},${SIGNING_KEY}"`, cookie });
    expect(r.status).toBe(400);
    expect(r.json.message).toBe("The request body is not valid JSON.");
    expect(r.text).not.toContain(SIGNING_KEY);
    expect(r.text).not.toContain(ACCESS_KEY);
  });

  it("explains a missing ENCRYPTION_KEY instead of storing the token in the clear", async () => {
    ({ fake } = setupPro({ ADMIN_PASSWORD: "panel-pass", ENCRYPTION_KEY: undefined }));
    const cookie = await signIn();
    const r = await call("/pro-account", { method: "POST", body: good, cookie });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("no_encryption");
    const listed = await call("/tool", { method: "POST", body: { name: "pro_list_accounts", arguments: {} }, cookie });
    expect(listed.json.data.accounts).toEqual([]);
  });
});

describe("feature flags", () => {
  it("tells the page which features exist", async () => {
    const cookie = await signIn();
    expect((await call("/me", { cookie })).json.features).toEqual({ pro: true, unofficial: true });
    ({ fake } = setupPro({ ADMIN_PASSWORD: "panel-pass", ENABLE_UNOFFICIAL: undefined }));
    const cookie2 = await signIn();
    expect((await call("/me", { cookie: cookie2 })).json.features).toEqual({ pro: true, unofficial: false });
  });

  it("hides the unofficial tools from the panel too, by default", async () => {
    ({ fake } = setupPro({ ADMIN_PASSWORD: "panel-pass", ENABLE_UNOFFICIAL: undefined }));
    const cookie = await signIn();
    const names = (await call("/tools", { cookie })).json.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("diagnose_pro");
    expect(names).not.toContain("like_item");
    const r = await call("/tool", { method: "POST", body: { name: "like_item", arguments: { item_id: "1", confirm: true } }, cookie });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("unknown_tool");
  });
});
