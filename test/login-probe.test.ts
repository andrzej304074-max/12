import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, freshEnv, htmlRes, jsonRes, mockFetch } from "./helpers.js";
import { LoginError, probeLogin } from "../src/vinted/login.js";

// A normal Vinted page: it embeds DataDome's tag, which is NOT a block.
const HOME = '<html><head><script src="https://js.datadome.co/tags.js"></script></head><body>Vinted</body></html>';
const WALL_JSON = { url: "https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqAAAAAMA1234567890abcdef" };
const WALL_HEADERS = { "x-datadome": "protected" };

type Responder = (url: URL, init?: RequestInit) => Response;

/** Answers the three probe requests; each can be overridden. */
function vinted(over: { home?: Responder; login?: Responder; api?: Responder } = {}) {
  return mockFetch((url, init) => {
    if (url.pathname === "/") return (over.home ?? (() => htmlRes(200, HOME)))(url, init);
    if (url.pathname === "/oauth/token") return (over.login ?? (() => jsonRes(400, { error: "invalid_grant" })))(url, init);
    if (url.pathname === "/api/v2/catalogs") return (over.api ?? (() => jsonRes(200, { catalogs: [] })))(url, init);
    return jsonRes(404, {});
  });
}

beforeEach(() => freshEnv());
afterEach(() => vi.unstubAllGlobals());

describe("probeLogin verdicts", () => {
  it("reports reachable when the login endpoint answers with data, even though the home page mentions DataDome", async () => {
    vinted();
    const result = await probeLogin("www.vinted.pl");
    expect(result.verdict).toBe("reachable");
    expect(result.checks.map((c) => c.verdict)).toEqual(["not_api", "api", "api"]);
    expect(result.checks[0]!.evidence!.markers).toEqual([]);
  });

  it("reports a wall when Vinted serves a challenge, and says the password is never looked at", async () => {
    vinted({
      home: () => jsonRes(403, WALL_JSON, WALL_HEADERS),
      login: () => jsonRes(403, WALL_JSON, WALL_HEADERS),
      api: () => jsonRes(403, WALL_JSON, WALL_HEADERS),
    });
    const result = await probeLogin("www.vinted.pl");
    expect(result.verdict).toBe("wall");
    expect(result.summary).toMatch(/before any password/);
    expect(result.checks.every((c) => c.verdict === "wall")).toBe(true);
    expect(result.checks[1]!.evidence!.markers).toEqual(expect.arrayContaining(["header:x-datadome", "body:captcha-delivery.com"]));
  });

  it("reports a wall when only the login endpoint is challenged", async () => {
    vinted({ login: () => jsonRes(403, WALL_JSON, WALL_HEADERS) });
    expect((await probeLogin("www.vinted.pl")).verdict).toBe("wall");
  });

  it("reports a missing endpoint - not a block - when the login address returns a web page that mentions DataDome", async () => {
    vinted({ login: () => htmlRes(404, HOME + "captcha") });
    const result = await probeLogin("www.vinted.pl");
    expect(result.verdict).toBe("endpoint_missing");
    expect(result.summary).toMatch(/probably changed/);
    expect(result.checks[1]!.evidence).toMatchObject({ status: 404, markers: [] });
  });

  it("reports a redirect from the login address as a missing endpoint", async () => {
    vinted({ login: () => new Response(null, { status: 301, headers: { location: "https://www.vinted.pl/" } }) });
    const result = await probeLogin("www.vinted.pl");
    expect(result.verdict).toBe("endpoint_missing");
    expect(result.checks[1]!.evidence!.location).toBe("https://www.vinted.pl/");
  });

  it("reports a rate limit", async () => {
    vinted({ login: () => jsonRes(429, {}) });
    expect((await probeLogin("www.vinted.pl")).verdict).toBe("rate_limited");
  });

  it("reports a network failure per check and overall", async () => {
    mockFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const result = await probeLogin("www.vinted.pl");
    expect(result.verdict).toBe("network");
    expect(result.checks.every((c) => c.verdict === "network_error" && /ENOTFOUND/.test(c.error ?? ""))).toBe(true);
  });

  it("is inconclusive for a JSON 403 without any marker, rather than guessing", async () => {
    vinted({ login: () => jsonRes(403, { message: "nope" }) });
    const result = await probeLogin("www.vinted.pl");
    expect(result.verdict).toBe("inconclusive");
    expect(result.summary).toMatch(/no recognisable bot-protection marker/);
  });

  it("is inconclusive for a plain 403 page without markers", async () => {
    vinted({ login: () => htmlRes(403, "<html>Forbidden</html>") });
    expect((await probeLogin("www.vinted.pl")).verdict).toBe("inconclusive");
  });
});

describe("probeLogin sends nothing about an account", () => {
  it("makes exactly three requests with no credentials, cookie or password", async () => {
    const { calls } = vinted();
    await probeLogin("www.vinted.pl");
    expect(calls.map((c) => `${c.init?.method} ${c.url.pathname}`)).toEqual(["GET /", "POST /oauth/token", "GET /api/v2/catalogs"]);
    const login = calls[1]!;
    const body = JSON.parse(String(login.init!.body));
    expect(body).toEqual({ client_id: "web", scope: "user", grant_type: "refresh_token", refresh_token: "connection-check" });
    expect(String(login.init!.body)).not.toMatch(/password|username/);
    for (const call of calls) {
      const headers = call.init!.headers as Record<string, string>;
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers["user-agent"]).toMatch(/vinted-seller-mcp/);
      expect(call.init!.redirect).toBe("manual");
    }
  });

  it("only ever talks to the requested Vinted host", async () => {
    const { calls } = vinted();
    await probeLogin("www.vinted.de");
    expect(calls.every((c) => c.url.hostname === "www.vinted.de")).toBe(true);
  });

  it("keeps the snippets short and free of tags", async () => {
    vinted({ home: () => htmlRes(200, "<html><body>" + "x ".repeat(2000) + "</body></html>") });
    const [home] = (await probeLogin("www.vinted.pl")).checks;
    expect(home!.evidence!.snippet.length).toBeLessThanOrEqual(200);
    expect(home!.evidence!.snippet).not.toContain("<");
  });

  it("spaces the requests out", async () => {
    process.env.VINTED_MIN_REQUEST_INTERVAL_MS = "40";
    const { resetConfigCache } = await import("../src/config.js");
    resetConfigCache();
    vinted();
    const started = Date.now();
    await probeLogin("www.vinted.pl");
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });
});

describe("probeLogin limits and input", () => {
  it("refuses a host that is not Vinted without any request", async () => {
    const { calls } = vinted();
    await expect(probeLogin("evil.example")).rejects.toMatchObject({ kind: "invalid_input" });
    expect(calls).toHaveLength(0);
  });

  it("is capped at ten checks per hour", async () => {
    const { calls } = vinted();
    for (let i = 0; i < 10; i++) await probeLogin("www.vinted.pl");
    const before = calls.length;
    await expect(probeLogin("www.vinted.pl")).rejects.toBeInstanceOf(LoginError);
    await expect(probeLogin("www.vinted.pl")).rejects.toMatchObject({ kind: "rate_limited" });
    expect(calls.length).toBe(before);
  });
});

describe("the diagnose_login tool", () => {
  it("returns the probe result", async () => {
    vinted();
    const r = await callTool("diagnose_login", { domain: "www.vinted.pl" });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ domain: "www.vinted.pl", verdict: "reachable" });
    expect(r.body.checks).toHaveLength(3);
  });

  it("defaults to the configured market", async () => {
    const { calls } = vinted();
    await callTool("diagnose_login", {});
    expect(calls[0]!.url.hostname).toBe("www.vinted.pl");
  });

  it("turns a bad host into a readable tool error", async () => {
    vinted();
    const r = await callTool("diagnose_login", { domain: "evil.example" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not a Vinted marketplace host/);
  });
});
