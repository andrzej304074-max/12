/**
 * Central runtime configuration, read once from the environment.
 *
 * Every secret lives in an environment variable. Nothing here is ever written
 * to the store or to a log line - see `redact()` in ./log.ts.
 */

export interface VintedAccount {
  /** Stable handle used by MCP tools to pick which account acts. */
  id: string;
  /** Human label shown in tool output. */
  label: string;
  /**
   * The `access_token_web` value copied from a browser that is signed in to
   * Vinted. Obtained by signing in manually - this server never asks for, sees
   * or stores a Vinted password.
   */
  accessToken: string;
  /** Optional `_vinted_fr_session` cookie, some endpoints want it alongside. */
  sessionCookie?: string;
  /** Per-account marketplace domain, falls back to the global default. */
  domain?: string;
  /** Numeric Vinted user id of this account, when known. */
  userId?: number;
}

export interface Config {
  /** Bearer token that callers must present on /api/mcp. */
  mcpAuthToken: string | null;
  /** Secret Vercel Cron presents on /api/cron/monitor. */
  cronSecret: string | null;
  /** Default marketplace host, e.g. "www.vinted.pl". */
  defaultDomain: string;
  accounts: VintedAccount[];
  upstash: { url: string; token: string } | null;
  /** Minimum gap between two outbound Vinted requests, milliseconds. */
  minRequestIntervalMs: number;
  /** How many times a failed Vinted request is retried. */
  maxRetries: number;
  /** Discount applied when proposing a negotiation price, as a percentage. */
  offerDiscountPct: number;
  /** Hard ceiling on confirmed likes per account per UTC day. */
  maxLikesPerDay: number;
  /** Hard ceiling on confirmed offers per account per UTC day. */
  maxOffersPerDay: number;
  /** Items pulled per seller on each monitor pass. */
  monitorPageSize: number;
  /** User-Agent sent to Vinted. Identifies this client honestly. */
  userAgent: string;
  isProduction: boolean;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string): string | null {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * Parses VINTED_ACCOUNTS. Accepts a JSON array of account objects.
 * A malformed value throws at startup rather than silently yielding zero
 * accounts, which would look like "no accounts configured" and waste time.
 */
export function parseAccounts(raw: string | null): VintedAccount[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `VINTED_ACCOUNTS is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("VINTED_ACCOUNTS must be a JSON array of account objects");
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`VINTED_ACCOUNTS[${index}] is not an object`);
    }
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const accessToken =
      typeof rec.accessToken === "string" ? rec.accessToken.trim() : "";
    if (!id) throw new Error(`VINTED_ACCOUNTS[${index}].id is required`);
    if (!accessToken) {
      throw new Error(`VINTED_ACCOUNTS[${index}].accessToken is required`);
    }
    const account: VintedAccount = {
      id,
      label: typeof rec.label === "string" && rec.label ? rec.label : id,
      accessToken,
    };
    if (typeof rec.sessionCookie === "string" && rec.sessionCookie) {
      account.sessionCookie = rec.sessionCookie;
    }
    if (typeof rec.domain === "string" && rec.domain) {
      account.domain = rec.domain;
    }
    if (typeof rec.userId === "number" && Number.isFinite(rec.userId)) {
      account.userId = rec.userId;
    }
    return account;
  });
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  const upstashUrl = str("UPSTASH_REDIS_REST_URL");
  const upstashToken = str("UPSTASH_REDIS_REST_TOKEN");
  cached = {
    mcpAuthToken: str("MCP_AUTH_TOKEN"),
    cronSecret: str("CRON_SECRET"),
    defaultDomain: str("VINTED_DOMAIN") ?? "www.vinted.pl",
    accounts: parseAccounts(str("VINTED_ACCOUNTS")),
    upstash:
      upstashUrl && upstashToken
        ? { url: upstashUrl.replace(/\/$/, ""), token: upstashToken }
        : null,
    minRequestIntervalMs: num("VINTED_MIN_REQUEST_INTERVAL_MS", 1200),
    maxRetries: num("VINTED_MAX_RETRIES", 2),
    offerDiscountPct: num("OFFER_DISCOUNT_PCT", 20),
    maxLikesPerDay: num("MAX_LIKES_PER_DAY", 100),
    maxOffersPerDay: num("MAX_OFFERS_PER_DAY", 25),
    monitorPageSize: num("MONITOR_PAGE_SIZE", 20),
    userAgent:
      str("VINTED_USER_AGENT") ??
      "vinted-seller-mcp/1.0 (+https://github.com/andrzej304074-max/12)",
    isProduction: process.env.NODE_ENV === "production" || !!process.env.VERCEL,
  };
  return cached;
}

/** Test helper: drops the memoised config so env changes take effect. */
export function resetConfigCache(): void {
  cached = null;
}
