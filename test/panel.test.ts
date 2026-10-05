import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApp } from "../src/app/router.js";
import type { VercelLikeRequest, VercelLikeResponse } from "../src/http.js";
import { createSessionCookie, verifySession } from "../src/session.js";
import { freshEnv, jsonRes, mockFetch } from "./helpers.js";

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

beforeEach(() => freshEnv({ ADMIN_PASSWORD: "panel-pass", MCP_AUTH_TOKEN: "mcp-secret-token" }));
afterEach(() => vi.unstubAllGlobals());

interface Opts {
  method?: string;
  body?: unknown;
  cookie?: string;
  origin?: string | null;
  headers?: Record<string, string>;
}

async function call(path: string, { method = "GET", body, cookie, origin, headers = {} }: Opts = {}) {
  const sendOrigin = origin === undefined ? (method === "GET" ? null : base) : origin;
  const res = await fetch(`${base}/api/app${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(sendOrigin ? { origin: sendOrigin } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
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
  expect(r.status).toBe(200);
  return r.setCookie!.split(";")[0]!;
}

describe("deployment", () => {
  it("has the catch-all function and the static page", () => {
    expect(existsSync("api/app/[...path].ts")).toBe(true);
    expect(existsSync("public/index.html")).toBe(true);
    expect(existsSync("public/app.js")).toBe(true);
  });
});

describe("signing in", () => {
  it("reports it is signed out", async () => {
    const r = await call("/me");
    expect(r.json).toEqual({ authenticated: false, passwordConfigured: true });
  });

  it("rejects a wrong password", async () => {
    const r = await call("/login", { method: "POST", body: { password: "nope" } });
    expect(r.status).toBe(401);
    expect(r.setCookie).toBeNull();
  });

  it("sets a hardened session cookie on success", async () => {
    const r = await call("/login", { method: "POST", body: { password: "panel-pass" } });
    expect(r.setCookie).toMatch(/HttpOnly/);
    expect(r.setCookie).toMatch(/SameSite=Strict/);
    expect(r.setCookie).toMatch(/Path=\//);
  });

  it("adds Secure in production", async () => {
    process.env.VERCEL = "1";
    const { resetConfigCache } = await import("../src/config.js");
    resetConfigCache();
    expect(createSessionCookie()).toMatch(/Secure/);
  });

  it("recognises the session afterwards, with setup flags but no secrets", async () => {
    const cookie = await signIn();
    const r = await call("/me", { cookie });
    expect(r.json).toMatchObject({ authenticated: true, setup: { encryptionKey: true, mcpAuthToken: true, durableStorage: false } });
    expect(r.text).not.toContain("mcp-secret-token");
    expect(r.text).not.toContain("panel-pass");
  });

  it("locks out an address after five wrong passwords", async () => {
    for (let i = 0; i < 5; i++) await call("/login", { method: "POST", body: { password: "bad" } });
    const locked = await call("/login", { method: "POST", body: { password: "panel-pass" } });
    expect(locked.status).toBe(429);
  });

  it("is disabled without ADMIN_PASSWORD", async () => {
    freshEnv({ ADMIN_PASSWORD: undefined });
    const r = await call("/login", { method: "POST", body: { password: "anything" } });
    expect(r.status).toBe(503);
    expect((await call("/me")).json.passwordConfigured).toBe(false);
  });

  it("signs out", async () => {
    const r = await call("/logout", { method: "POST" });
    expect(r.setCookie).toMatch(/Max-Age=0/);
  });
});

describe("session cookie", () => {
  it("rejects a tampered cookie", async () => {
    const cookie = (await signIn()).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect(verifySession(cookie)).toBe(false);
  });

  it("rejects an expired cookie", () => {
    const stale = createSessionCookie(Date.now() - 8 * 24 * 3600 * 1000).split(";")[0]!;
    expect(verifySession(stale)).toBe(false);
  });

  it("rejects a cookie signed with another secret", async () => {
    const cookie = await signIn();
    process.env.SESSION_SECRET = "a-different-secret";
    const { resetConfigCache } = await import("../src/config.js");
    resetConfigCache();
    expect(verifySession(cookie)).toBe(false);
  });

  it("is not valid without a password or secret configured", async () => {
    const cookie = await signIn();
    freshEnv({ ADMIN_PASSWORD: undefined });
    expect(verifySession(cookie)).toBe(false);
  });
});

describe("protection", () => {
  it("refuses every API call without a session", async () => {
    for (const path of ["/tools", "/accounts", "/mcp-config", "/login-log"]) {
      expect((await call(path)).status).toBe(401);
    }
    expect((await call("/tool", { method: "POST", body: { name: "list_accounts" } })).status).toBe(401);
    expect((await call("/account-login", { method: "POST", body: {} })).status).toBe(401);
  });

  it("refuses a state-changing request without an Origin header", async () => {
    const cookie = await signIn();
    const r = await call("/tool", { method: "POST", cookie, origin: null, body: { name: "list_accounts" } });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("bad_origin");
  });

  it("refuses a request from another origin", async () => {
    const cookie = await signIn();
    const r = await call("/tool", { method: "POST", cookie, origin: "https://evil.example", body: { name: "list_accounts" } });
    expect(r.status).toBe(403);
  });

  it("also checks the origin on login", async () => {
    const r = await call("/login", { method: "POST", origin: "https://evil.example", body: { password: "panel-pass" } });
    expect(r.status).toBe(403);
  });

  it("answers unknown routes with 404", async () => {
    const cookie = await signIn();
    expect((await call("/nothing", { cookie })).status).toBe(404);
  });
});

describe("running tools", () => {
  it("runs a tool the same way MCP does", async () => {
    const cookie = await signIn();
    const r = await call("/tool", { method: "POST", cookie, body: { name: "preview_offer_price", arguments: { asking_price: 200 } } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ askingPrice: 200, discountPct: 20, offerPrice: 160 });
    const { callTool } = await import("./helpers.js");
    expect((await callTool("preview_offer_price", { asking_price: 200 })).body).toEqual(r.json.data);
  });

  it("returns tool errors as errors", async () => {
    const cookie = await signIn();
    const r = await call("/tool", { method: "POST", cookie, body: { name: "draft_listing", arguments: {} } });
    expect(r.status).toBe(200);
    expect(r.json.isError).toBe(true);
    expect(r.json.text).toMatch(/required/);
  });

  it("answers an unknown tool with 404", async () => {
    const cookie = await signIn();
    expect((await call("/tool", { method: "POST", cookie, body: { name: "nope" } })).status).toBe(404);
  });

  it("lists the tools", async () => {
    const cookie = await signIn();
    const r = await call("/tools", { cookie });
    expect(r.json.tools.length).toBeGreaterThan(30);
    expect(r.json.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["list_conversations", "upload_photo", "set_automation_limits"]));
  });

  it("still keeps the confirm gate when called from the panel", async () => {
    const { calls } = mockFetch(() => jsonRes(200, {}));
    freshEnv({ ADMIN_PASSWORD: "panel-pass", VINTED_ACCOUNTS: JSON.stringify([{ id: "main", accessToken: "t" }]) });
    const cookie = await signIn();
    const r = await call("/tool", { method: "POST", cookie, body: { name: "make_offer", arguments: { item_id: "1", price: 50 } } });
    expect(r.json.data).toMatchObject({ preview: true, sent: false });
    expect(calls).toHaveLength(0);
  });
});

describe("MCP connection details", () => {
  it("hides the token unless asked", async () => {
    const cookie = await signIn();
    const hidden = await call("/mcp-config", { cookie });
    expect(hidden.json.token).toBeNull();
    expect(hidden.text).not.toContain("mcp-secret-token");
    expect(hidden.json.command).toContain("<MCP_AUTH_TOKEN>");
    const shown = await call("/mcp-config?reveal=1", { cookie });
    expect(shown.json.token).toBe("mcp-secret-token");
    expect(shown.json.command).toContain("mcp-secret-token");
  });

  it("builds the endpoint from the request host", async () => {
    const cookie = await signIn();
    const r = await call("/mcp-config", { cookie });
    expect(r.json.endpoint).toBe(`${base}/api/mcp`);
  });
});

describe("connecting an account", () => {
  const vinted = () =>
    mockFetch((url, init) => {
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      if (key === "POST /oauth/token") return jsonRes(200, { access_token: "access-secret-123", refresh_token: "refresh-secret-456", expires_in: 3600 });
      if (key === "GET /api/v2/users/current") return jsonRes(200, { user: { id: 7, login: "ola" } });
      return jsonRes(404, {});
    });

  it("connects through the panel and never echoes secrets back", async () => {
    vinted();
    const cookie = await signIn();
    const r = await call("/account-login", { method: "POST", cookie, body: { domain: "www.vinted.pl", email: "ola@example.com", password: "pw-not-to-leak" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "connected", account: { login: "ola" } });
    for (const secret of ["access-secret-123", "refresh-secret-456", "pw-not-to-leak"]) expect(r.text).not.toContain(secret);

    const list = await call("/accounts", { cookie });
    expect(list.json.accounts).toHaveLength(1);
    expect(list.text).not.toContain("access-secret-123");
  });

  it("maps login failures to HTTP statuses with a kind", async () => {
    mockFetch(() => jsonRes(400, { error: "invalid_grant" }));
    const cookie = await signIn();
    const r = await call("/account-login", { method: "POST", cookie, body: { domain: "www.vinted.pl", email: "a@b.pl", password: "x" } });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("bad_credentials");
  });

  it("rejects a host that is not Vinted", async () => {
    const { calls } = vinted();
    const cookie = await signIn();
    const r = await call("/account-login", { method: "POST", cookie, body: { domain: "evil.example", email: "a@b.pl", password: "x" } });
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("walks through a verification code", async () => {
    let n = 0;
    mockFetch((url, init) => {
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      if (key === "POST /oauth/token") {
        return ++n === 1 ? jsonRes(400, { error: "two_factor_required", two_factor_token: "t1", message: "sms" }) : jsonRes(200, { access_token: "tok", expires_in: 3600 });
      }
      return jsonRes(200, { user: { id: 1, login: "kasia" } });
    });
    const cookie = await signIn();
    const start = await call("/account-login", { method: "POST", cookie, body: { domain: "www.vinted.pl", email: "k@b.pl", password: "x" } });
    expect(start.json.status).toBe("challenge");
    const done = await call("/account-verify", { method: "POST", cookie, body: { loginId: start.json.loginId, code: "123456" } });
    expect(done.json).toMatchObject({ status: "connected", account: { login: "kasia" } });
  });

  it("serves the login log without passwords", async () => {
    vinted();
    const cookie = await signIn();
    await call("/account-login", { method: "POST", cookie, body: { domain: "www.vinted.pl", email: "ola@example.com", password: "pw-not-to-leak" } });
    const r = await call("/login-log", { cookie });
    expect(r.json.log).toHaveLength(1);
    expect(r.text).not.toContain("pw-not-to-leak");
  });
});
