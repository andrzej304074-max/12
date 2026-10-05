import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStore, keys } from "../src/store/index.js";
import { listAccounts, saveAccount } from "../src/vinted/accounts.js";
import { VintedClient } from "../src/vinted/client.js";
import {
  getLoginLog,
  LoginError,
  recoverAccount,
  refreshSession,
  startLogin,
  verifyLogin,
} from "../src/vinted/login.js";
import { freshEnv, htmlRes, jsonRes, mockFetch } from "./helpers.js";

const PASSWORD = "hunter2-very-secret";
const TOKENS = { access_token: "access-secret-123", refresh_token: "refresh-secret-456", expires_in: 7200 };
const USER = { user: { id: 42, login: "ala", photo: { url: "https://img.example/a.jpg" } } };

const login = (overrides = {}) =>
  startLogin({ domain: "www.vinted.pl", email: "ala@example.com", password: PASSWORD, ...overrides });

function vinted(overrides: Record<string, (url: URL, init?: RequestInit) => Response> = {}) {
  return mockFetch((url, init) => {
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const handler = overrides[key];
    if (handler) return handler(url, init);
    if (key === "POST /oauth/token") {
      return jsonRes(200, TOKENS, { "set-cookie": "_vinted_fr_session=sess-abc; Path=/; HttpOnly" });
    }
    if (key === "GET /api/v2/users/current") return jsonRes(200, USER);
    return jsonRes(404, {});
  });
}

const body = (call: { init?: RequestInit }) => JSON.parse(String(call.init!.body));

beforeEach(() => freshEnv());
afterEach(() => vi.unstubAllGlobals());

describe("login without a challenge", () => {
  it("connects the account and reads the profile", async () => {
    vinted();
    const result = await login();
    expect(result).toMatchObject({ status: "connected", warning: null });
    if (result.status !== "connected") return;
    expect(result.account).toMatchObject({ login: "ala", userId: 42, source: "panel", status: "connected" });
  });

  it("stores the tokens and the session cookie, encrypted", async () => {
    vinted();
    await login();
    const [account] = await listAccounts();
    expect(account).toMatchObject({
      accessToken: "access-secret-123",
      refreshToken: "refresh-secret-456",
      sessionCookie: "sess-abc",
    });
    expect(account!.expiresAt).toBeGreaterThan(Date.now() + 7_000_000);
    expect(JSON.stringify(await getStore().get(keys.account("ala")))).not.toContain("access-secret-123");
  });

  it("sends the password only to the Vinted login endpoint, once", async () => {
    const { calls } = vinted();
    await login();
    const withPassword = calls.filter((c) => String(c.init?.body ?? "").includes(PASSWORD));
    expect(withPassword).toHaveLength(1);
    expect(withPassword[0]!.url.pathname).toBe("/oauth/token");
    expect(body(withPassword[0]!)).toMatchObject({ grant_type: "password", username: "ala@example.com" });
  });

  it("never keeps the password in the store or the login log", async () => {
    vinted();
    await login();
    const store = getStore() as unknown as { map: Map<string, unknown> };
    expect(JSON.stringify([...store.map.entries()])).not.toContain(PASSWORD);
    expect(JSON.stringify(await getLoginLog())).not.toContain(PASSWORD);
  });

  it("masks the e-mail in the login log", async () => {
    vinted();
    await login();
    const [entry] = await getLoginLog();
    expect(entry).toMatchObject({ who: "a***@example.com", outcome: "connected" });
  });

  it("warns when the profile cannot be read but still connects", async () => {
    vinted({ "GET /api/v2/users/current": () => jsonRes(500, {}) });
    const result = await login();
    expect(result).toMatchObject({ status: "connected" });
    if (result.status === "connected") expect(result.warning).toMatch(/profile could not be read/);
  });

  it("re-login keeps the existing account id", async () => {
    vinted();
    const first = await login();
    if (first.status !== "connected") throw new Error("expected connected");
    await login({ accountId: first.account.id });
    expect(await listAccounts()).toHaveLength(1);
  });
});

describe("login with a verification code", () => {
  const challenge = () =>
    jsonRes(400, { error: "two_factor_required", two_factor_token: "tft-1", message: "We sent an SMS code", phone_hint: "+48 *** *** 123" });

  it("asks for the code and returns a login id", async () => {
    vinted({ "POST /oauth/token": challenge });
    const result = await login();
    expect(result).toMatchObject({ status: "challenge", method: "sms", hint: "+48 *** *** 123" });
  });

  it("keeps the challenge encrypted and without the password", async () => {
    vinted({ "POST /oauth/token": challenge });
    const result = await login();
    if (result.status !== "challenge") throw new Error("expected challenge");
    const stored = await getStore().get<string>(keys.loginState(result.loginId));
    expect(stored).toBeTruthy();
    expect(stored).not.toContain("tft-1");
    expect(stored).not.toContain(PASSWORD);
  });

  it("completes the login once the code is accepted", async () => {
    let n = 0;
    const { calls } = vinted({
      "POST /oauth/token": () => (++n === 1 ? challenge() : jsonRes(200, TOKENS)),
    });
    const first = await login();
    if (first.status !== "challenge") throw new Error("expected challenge");
    const done = await verifyLogin({ loginId: first.loginId, code: "123456" });
    expect(done).toMatchObject({ status: "connected" });
    const verifyBody = body(calls.filter((c) => c.url.pathname === "/oauth/token")[1]!);
    expect(verifyBody).toMatchObject({ two_factor_token: "tft-1", verification_code: "123456" });
    expect(verifyBody.password).toBeUndefined();
    expect(await getStore().get(keys.loginState(first.loginId))).toBeNull();
  });

  it("allows another try after a wrong code", async () => {
    let n = 0;
    vinted({
      "POST /oauth/token": () =>
        ++n === 1 ? challenge() : n === 2 ? jsonRes(400, { error: "invalid_code", error_description: "Zły kod" }) : jsonRes(200, TOKENS),
    });
    const first = await login();
    if (first.status !== "challenge") throw new Error("expected challenge");
    await expect(verifyLogin({ loginId: first.loginId, code: "000000" })).rejects.toMatchObject({ kind: "bad_code", message: "Zły kod" });
    expect(await verifyLogin({ loginId: first.loginId, code: "123456" })).toMatchObject({ status: "connected" });
  });

  it("gives up after too many wrong codes", async () => {
    let n = 0;
    vinted({ "POST /oauth/token": () => (++n === 1 ? challenge() : jsonRes(400, { error: "invalid_code" })) });
    const first = await login();
    if (first.status !== "challenge") throw new Error("expected challenge");
    for (let i = 0; i < 5; i++) {
      await expect(verifyLogin({ loginId: first.loginId, code: "000000" })).rejects.toMatchObject({ kind: "bad_code" });
    }
    await expect(verifyLogin({ loginId: first.loginId, code: "000000" })).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("reports an unknown or expired verification", async () => {
    vinted();
    await expect(verifyLogin({ loginId: "nope", code: "123456" })).rejects.toMatchObject({ kind: "expired" });
  });

  it("rejects a malformed code without contacting Vinted", async () => {
    const { calls } = vinted();
    await expect(verifyLogin({ loginId: "x", code: "12 34" })).rejects.toMatchObject({ kind: "invalid_input" });
    expect(calls).toHaveLength(0);
  });
});

describe("when Vinted pushes back", () => {
  it("stops with a clear message on a bot-protection page, and does not retry", async () => {
    const { calls } = vinted({ "POST /oauth/token": () => htmlRes(403, "<html>Just a moment... cloudflare captcha</html>") });
    await expect(login()).rejects.toMatchObject({ kind: "blocked", message: expect.stringMatching(/Nothing was bypassed/) });
    expect(calls.filter((c) => c.url.pathname === "/oauth/token")).toHaveLength(1);
  });

  it("treats a 429 as a block", async () => {
    vinted({ "POST /oauth/token": () => jsonRes(429, {}) });
    await expect(login()).rejects.toMatchObject({ kind: "blocked" });
  });

  it("treats an HTML answer where JSON was expected as a block", async () => {
    vinted({ "POST /oauth/token": () => htmlRes(200, "<html>captcha</html>") });
    await expect(login()).rejects.toMatchObject({ kind: "blocked" });
  });

  it("reports wrong credentials", async () => {
    vinted({ "POST /oauth/token": () => jsonRes(400, { error: "invalid_grant" }) });
    await expect(login()).rejects.toMatchObject({ kind: "bad_credentials" });
  });

  it("limits login attempts per account per hour", async () => {
    const { calls } = vinted({ "POST /oauth/token": () => jsonRes(400, { error: "invalid_grant" }) });
    for (let i = 0; i < 3; i++) await expect(login()).rejects.toMatchObject({ kind: "bad_credentials" });
    await expect(login()).rejects.toMatchObject({ kind: "rate_limited" });
    expect(calls.filter((c) => c.url.pathname === "/oauth/token")).toHaveLength(3);
  });

  it("explains an unexpected answer", async () => {
    vinted({ "POST /oauth/token": () => jsonRes(500, { oops: true }) });
    await expect(login()).rejects.toMatchObject({ kind: "unexpected", message: expect.stringMatching(/HTTP 500/) });
  });
});

describe("input checks", () => {
  it("refuses to send the password anywhere when there is no encryption key", async () => {
    freshEnv({ ENCRYPTION_KEY: undefined });
    const { calls } = vinted();
    await expect(login()).rejects.toMatchObject({ kind: "no_encryption" });
    expect(calls).toHaveLength(0);
  });

  it.each(["evil.com", "www.vinted.pl.evil.com", "vinted.pl@evil.com", "localhost", ""])("rejects the host %j", async (domain) => {
    const { calls } = vinted();
    await expect(login({ domain })).rejects.toBeInstanceOf(LoginError);
    expect(calls).toHaveLength(0);
  });

  it.each(["www.vinted.pl", "www.vinted.de", "www.vinted.co.uk", "vinted.fr"])("accepts the host %s", async (domain) => {
    vinted();
    expect(await login({ domain })).toMatchObject({ status: "connected" });
  });

  it("requires a login and a password", async () => {
    vinted();
    await expect(login({ email: "" })).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(login({ password: "" })).rejects.toMatchObject({ kind: "invalid_input" });
  });
});

describe("keeping the session alive", () => {
  async function connected() {
    vinted();
    await login();
    return (await listAccounts())[0]!;
  }

  it("renews the session from the refresh token", async () => {
    const account = await connected();
    vinted({
      "POST /oauth/token": () => jsonRes(200, { access_token: "rotated-token", expires_in: 3600 }),
    });
    const next = await refreshSession(account);
    expect(next.accessToken).toBe("rotated-token");
    expect(next.refreshToken).toBe("refresh-secret-456");
  });

  it("flags the account when Vinted refuses to renew", async () => {
    const account = await connected();
    vinted({ "POST /oauth/token": () => jsonRes(400, { error: "invalid_grant" }) });
    expect(await recoverAccount(account)).toBeNull();
    expect((await listAccounts())[0]!.status).toBe("needs_login");
  });

  it("does not flag the account when the refresh is merely blocked", async () => {
    const account = await connected();
    vinted({ "POST /oauth/token": () => htmlRes(403, "captcha") });
    expect(await recoverAccount(account)).toBeNull();
    expect((await listAccounts())[0]!.status).toBe("connected");
  });

  it("renews and retries once when a request gets a 401", async () => {
    const account = await connected();
    let catalogCalls = 0;
    const { calls } = vinted({
      "GET /api/v2/catalog/items": (_u, init) => {
        catalogCalls++;
        const cookie = (init!.headers as Record<string, string>).cookie;
        return (cookie ?? "").includes("rotated-token") ? jsonRes(200, { items: [] }) : jsonRes(401, {});
      },
      "POST /oauth/token": () => jsonRes(200, { access_token: "rotated-token", expires_in: 3600 }),
    });
    await new VintedClient().get("/api/v2/catalog/items", { account });
    expect(catalogCalls).toBe(2);
    expect(calls.some((c) => c.url.pathname === "/oauth/token")).toBe(true);
  });

  it("renews ahead of time when the token is about to expire", async () => {
    const account = { ...(await connected()), expiresAt: Date.now() + 60_000 };
    let sent = "";
    vinted({
      "GET /api/v2/catalog/items": (_u, init) => {
        sent = (init!.headers as Record<string, string>).cookie ?? "";
        return jsonRes(200, { items: [] });
      },
      "POST /oauth/token": () => jsonRes(200, { access_token: "fresh-token", expires_in: 3600 }),
    });
    await new VintedClient().get("/api/v2/catalog/items", { account });
    expect(sent).toContain("fresh-token");
  });

  it("does not retry a write after a 401 that could not be renewed", async () => {
    const account = await connected();
    const { calls } = vinted({
      "POST /api/v2/offers": () => jsonRes(401, {}),
      "POST /oauth/token": () => jsonRes(400, { error: "invalid_grant" }),
    });
    await expect(new VintedClient().send("POST", "/api/v2/offers", { account, body: {} })).rejects.toThrow();
    expect(calls.filter((c) => c.url.pathname === "/api/v2/offers")).toHaveLength(1);
  });

  it("leaves env accounts alone", async () => {
    freshEnv({ VINTED_ACCOUNTS: JSON.stringify([{ id: "env1", accessToken: "t" }]) });
    const { calls } = vinted();
    const [account] = await listAccounts();
    expect(await recoverAccount(account!)).toBeNull();
    expect(calls).toHaveLength(0);
    await saveAccount({ label: "x", domain: "www.vinted.pl", userId: null, login: null, avatarUrl: null, secrets: { accessToken: "a" } });
  });
});
