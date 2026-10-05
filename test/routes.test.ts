import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleApp, routeOf } from "../src/app/router.js";
import type { VercelLikeRequest, VercelLikeResponse } from "../src/http.js";
import { freshEnv } from "./helpers.js";

/**
 * Vercel turns api/app/[...path].ts into the route ^/api/app/([^/]+)$ - one path
 * segment only (found by running `vercel build`). A panel route with a slash in
 * it would answer 404 in production while passing every local test, so these
 * tests pin the rule down.
 */
const VERCEL_CATCH_ALL = /^\/api\/app\/([^/]+)$/;

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesIn(full) : [full];
  });
}

describe("panel routes fit Vercel's catch-all", () => {
  it("every route the router handles is a single segment", () => {
    const source = readFileSync("src/app/router.ts", "utf8");
    const routes = [...source.matchAll(/route === "([^"]+)"/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(8);
    for (const route of routes) {
      expect(`/api/app${route}`, `route ${route}`).toMatch(VERCEL_CATCH_ALL);
    }
  });

  it("every route the page calls is matched by that pattern", () => {
    const sources = filesIn("public").filter((f) => f.endsWith(".js"));
    const called = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bapi\(\s*["'`](\/[^"'`?]*)/g)) called.add(m[1]!);
      for (const m of text.matchAll(/["'`]\/api\/app(\/[^"'`?$\s]+)/g)) called.add(m[1]!);
    }
    // Sanity: the scan really finds the calls.
    expect([...called]).toEqual(expect.arrayContaining(["/me", "/login", "/tool", "/account-login", "/account-verify", "/accounts"]));
    for (const route of called) {
      expect(`/api/app${route}`, `the page calls ${route}`).toMatch(VERCEL_CATCH_ALL);
    }
  });

  it("every route the page calls exists in the router", () => {
    const router = readFileSync("src/app/router.ts", "utf8");
    const handled = new Set([...router.matchAll(/route === "([^"]+)"/g)].map((m) => m[1]!));
    for (const file of filesIn("public").filter((f) => f.endsWith(".js"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bapi\(\s*["'`](\/[^"'`?]*)/g)) {
        expect(handled.has(m[1]!), `${file} calls ${m[1]}`).toBe(true);
      }
    }
  });
});

describe("routeOf", () => {
  it("reads the original URL", () => {
    expect(routeOf("/api/app/me")).toBe("/me");
    expect(routeOf("/api/app/mcp-config?reveal=1")).toBe("/mcp-config");
    expect(routeOf("/api/app/tool/")).toBe("/tool");
  });

  it("reads the internal catch-all form Vercel can pass", () => {
    expect(routeOf("/api/app/[...path]?...path=me")).toBe("/me");
    expect(routeOf("/api/app/%5B...path%5D?...path=account-login")).toBe("/account-login");
  });

  it("falls back to the root", () => {
    expect(routeOf("/api/app")).toBe("/");
    expect(routeOf("")).toBe("/");
    expect(routeOf("/api/app/[...path]")).toBe("/");
  });
});

describe("the internal catch-all form over HTTP", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    freshEnv({ ADMIN_PASSWORD: "panel-pass" });
    server = createServer((req, res) => void handleApp(req as VercelLikeRequest, res as VercelLikeResponse));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it("serves /me when the segment arrives as a query parameter", async () => {
    const res = await fetch(`${base}/api/app/[...path]?...path=me`);
    expect(await res.json()).toEqual({ authenticated: false, passwordConfigured: true });
  });
});
