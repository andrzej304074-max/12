import { vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { resetStoreCache } from "../src/store/index.js";
import { resetClientCache } from "../src/vinted/client.js";
import { handleRequest } from "../src/mcp/server.js";

export const TEST_KEY = "ab".repeat(32);

/** Clean environment: no leftovers from other test files. */
export function freshEnv(extra: Record<string, string | undefined> = {}) {
  for (const key of [
    "VERCEL", "MCP_AUTH_TOKEN", "ADMIN_PASSWORD", "SESSION_SECRET", "ENCRYPTION_KEY",
    "VINTED_ACCOUNTS", "NOTIFY_WEBHOOK_URL", "AUTO_ACTIONS_ENABLED", "ACTIVE_HOURS",
    "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "CRON_SECRET",
  ]) {
    delete process.env[key];
  }
  process.env.NODE_ENV = "test";
  process.env.VINTED_MIN_REQUEST_INTERVAL_MS = "0";
  process.env.ACTIVE_HOURS = "0-0";
  process.env.ENCRYPTION_KEY = TEST_KEY;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
  resetStoreCache();
  resetClientCache();
}

export function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function htmlRes(status: number, body: string) {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/**
 * Replaces fetch. Calls to the local test server (127.0.0.1) go through to the
 * real fetch; everything else is answered by `handler`, so a test can never
 * reach the network.
 */
export function mockFetch(handler: Handler) {
  const real = globalThis.fetch;
  const calls: { url: URL; init?: RequestInit }[] = [];
  const mock = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "127.0.0.1") return real(input as string, init);
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal("fetch", mock);
  return { calls, mock };
}

/** Calls an MCP tool and returns the parsed JSON text (or the raw text). */
export async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = (await handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { isError?: boolean; content: { text: string }[] } };
  const text = res.result.content[0]!.text;
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { isError: res.result.isError ?? false, text, body };
}
