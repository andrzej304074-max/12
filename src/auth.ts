import { getConfig } from "./config.js";

/**
 * Bearer-token gate for the MCP endpoint.
 *
 * The endpoint is a public URL on Vercel and it reads marketplace accounts, so
 * it is closed by default: with MCP_AUTH_TOKEN unset the server refuses every
 * request in production rather than serving an open one.
 */

export type AuthOutcome =
  | { ok: true }
  | { ok: false; status: number; message: string };

/** Constant-time comparison, so a wrong token leaks no timing signal. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function checkBearer(
  header: string | undefined,
  expected: string | null,
  { requireInProduction = true } = {},
): AuthOutcome {
  const cfg = getConfig();
  if (!expected) {
    if (cfg.isProduction && requireInProduction) {
      return {
        ok: false,
        status: 500,
        message:
          "Server is misconfigured: no shared secret is set, so it refuses to serve requests. Set MCP_AUTH_TOKEN in the Vercel project settings.",
      };
    }
    return { ok: true };
  }
  const supplied = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!supplied) {
    return { ok: false, status: 401, message: "Missing bearer token." };
  }
  if (!safeEqual(supplied, expected)) {
    return { ok: false, status: 403, message: "Invalid bearer token." };
  }
  return { ok: true };
}

export function authenticateMcp(header: string | undefined): AuthOutcome {
  return checkBearer(header, getConfig().mcpAuthToken);
}

/** Vercel Cron presents `Authorization: Bearer $CRON_SECRET`. */
export function authenticateCron(header: string | undefined): AuthOutcome {
  return checkBearer(header, getConfig().cronSecret);
}
