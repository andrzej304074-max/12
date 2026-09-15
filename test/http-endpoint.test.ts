import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mcpHandler from "../api/mcp.js";
import healthHandler from "../api/health.js";
import { resetConfigCache } from "../src/config.js";
import type { VercelLikeRequest, VercelLikeResponse } from "../src/http.js";

/**
 * Exercises the real request path - routing, auth, body parsing and the
 * JSON-RPC envelope - against a plain node:http server, which is the closest
 * stand-in for Vercel's Node runtime available offline.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  process.env.MCP_AUTH_TOKEN = "test-secret";
  delete process.env.VERCEL;
  process.env.NODE_ENV = "test";
  resetConfigCache();

  server = createServer((req, res) => {
    const handler = req.url?.startsWith("/api/health") ? healthHandler : mcpHandler;
    void handler(req as VercelLikeRequest, res as VercelLikeResponse);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  process.env.MCP_AUTH_TOKEN = "test-secret";
  resetConfigCache();
});

function rpc(body: unknown, token: string | null = "test-secret") {
  return fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/mcp", () => {
  it("rejects a request with no bearer token", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, null);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "nope");
    expect(res.status).toBe(403);
  });

  it("completes an initialize handshake", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("vinted-seller-mcp");
  });

  it("lists tools", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools.length).toBeGreaterThan(10);
  });

  it("calls a tool over HTTP", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "preview_offer_price", arguments: { asking_price: 50 } },
    });
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(body.result.content[0]!.text).offerPrice).toBe(40);
  });

  it("returns 202 with no body for a notification", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("reports malformed JSON as a parse error", async () => {
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-secret",
      },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("refuses GET, since it offers no SSE stream", async () => {
    const res = await fetch(`${base}/api/mcp`, {
      method: "GET",
      headers: { authorization: "Bearer test-secret" },
    });
    expect(res.status).toBe(405);
  });

  it("answers a CORS preflight", async () => {
    const res = await fetch(`${base}/api/mcp`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("GET /api/health", () => {
  it("reports status without requiring a token and without leaking secrets", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", authConfigured: true });
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });
});
