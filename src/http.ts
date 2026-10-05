import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Thin helpers over Node's req/res.
 *
 * Vercel's Node runtime decorates the response with res.json() and friends,
 * but writing the response directly keeps these handlers runnable under a
 * plain node:http server too, which is what the tests use.
 */

export type VercelLikeRequest = IncomingMessage & {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
};

export type VercelLikeResponse = ServerResponse;

const MAX_BODY_BYTES = 1_000_000;

/** Reads and parses a JSON body, using Vercel's pre-parsed one when present. */
export async function readJsonBody(
  req: VercelLikeRequest,
  maxBytes = MAX_BODY_BYTES,
): Promise<unknown> {
  if (req.body !== undefined && req.body !== null && req.body !== "") {
    if (typeof req.body === "string") return JSON.parse(req.body);
    return req.body;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sendJson(
  res: VercelLikeResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

export function sendNoContent(
  res: VercelLikeResponse,
  status = 202,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end();
}

/** CORS for browser-based MCP clients. */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
};

/** Pulls a single header value, collapsing the array form Node may hand back. */
export function header(
  req: VercelLikeRequest,
  name: string,
): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
