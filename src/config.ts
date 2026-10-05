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
  /** Optional CSRF token some write endpoints require, from the page meta tag. */
  csrfToken?: string;
  /** Per-account marketplace domain, falls back to the global default. */
  domain?: string;
  /** Numeric Vinted user id of this account, when known. */
  userId?: number;
  /** Where the account came from: VINTED_ACCOUNTS ("env") or the panel. */
  source?: "env" | "panel";
  /** Vinted login name, filled in when the account is connected. */
  login?: string;
  avatarUrl?: string;
  /** "needs_login" when the session expired and the panel must log in again. */
  status?: "connected" | "needs_login";
  /** Panel accounts only: lets the server renew the session by itself. */
  refreshToken?: string;
  /** Epoch ms at which accessToken stops working, when Vinted told us. */
  expiresAt?: number;
}

export interface Config {
  /** Bearer token that callers must present on /api/mcp. */
  mcpAuthToken: string | null;
  /** Secret Vercel Cron presents on /api/cron/monitor. */
  cronSecret: string | null;
  /** Password of the web panel. Without it the panel is disabled. */
  adminPassword: string | null;
  /** Signs panel session cookies. Falls back to a key derived from the password. */
  sessionSecret: string | null;
  /** 32-byte key (hex or base64) encrypting stored Vinted credentials. */
  encryptionKey: string | null;
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
  /** Default ceiling on likes per account per UTC day (0 disables). */
  maxLikesPerDay: number;
  /** Default ceiling on offers per account per UTC day (0 disables). */
  maxOffersPerDay: number;
  /** Default ceiling on automatic actions per account per hour (0 disables). */
  maxActionsPerHour: number;
  /** Default activity window for automatic actions, local hours [start, end). */
  activeHours: { start: number; end: number };
  /** IANA time zone the activity window is read in. */
  timeZone: string;
  /** How long the circuit breaker pauses automation after a refusal. */
  autopauseHours: number;
  /** Master switch: the cron sends nothing unless this is true. */
  autoActionsEnabled: boolean;
  /** Optional webhook (Discord/Slack-compatible JSON) notified of new finds. */
  notifyWebhookUrl: string | null;
  /** Items pulled per seller on each monitor pass. */
  monitorPageSize: number;
  /** User-Agent sent to Vinted. Identifies this client honestly. */
  userAgent: string;
  isProduction: boolean;
  /**
   * Show the tools and panel views built on Vinted's unofficial consumer API.
   * Off by default: that API is not covered by the official Pro Integrations
   * API, is blocked for servers, and the Pro documentation says using it
   * breaks Vinted's terms.
   */
  unofficialEnabled: boolean;
  /** Vinted Pro Integrations (the official, partner-only API). */
  pro: {
    /** Overrides of the two documented hosts; checked in src/pro/hosts.ts. */
    baseUrlSandbox: string | null;
    baseUrlProduction: string | null;
    /** Minimum gap between two requests to the Pro API, milliseconds. */
    minRequestIntervalMs: number;
    /** Retries for requests that are safe to repeat. */
    maxRetries: number;
    timeoutMs: number;
  };
  /** Vercel Blob read-write token; enables photo upload from the panel. */
  blobToken: string | null;
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
      source: "env",
      status: "connected",
    };
    if (typeof rec.sessionCookie === "string" && rec.sessionCookie) {
      account.sessionCookie = rec.sessionCookie;
    }
    if (typeof rec.csrfToken === "string" && rec.csrfToken) {
      account.csrfToken = rec.csrfToken;
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

/** Parses "8-22" into an hour window. Throws on nonsense. */
export function parseActiveHours(raw: string): { start: number; end: number } {
  const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(raw);
  if (!match) throw new Error(`Invalid active hours "${raw}", expected e.g. "8-22".`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > 24 || end > 24) {
    throw new Error(`Invalid active hours "${raw}", hours must be 0-24.`);
  }
  return { start, end };
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  // The Vercel integration for Upstash often names its variables KV_REST_API_*;
  // accept those too, with the UPSTASH_* names taking precedence.
  const upstashUrl = str("UPSTASH_REDIS_REST_URL") ?? str("KV_REST_API_URL");
  const upstashToken = str("UPSTASH_REDIS_REST_TOKEN") ?? str("KV_REST_API_TOKEN");
  cached = {
    mcpAuthToken: str("MCP_AUTH_TOKEN"),
    cronSecret: str("CRON_SECRET"),
    adminPassword: str("ADMIN_PASSWORD"),
    sessionSecret: str("SESSION_SECRET"),
    encryptionKey: str("ENCRYPTION_KEY"),
    defaultDomain: str("VINTED_DOMAIN") ?? "www.vinted.pl",
    accounts: parseAccounts(str("VINTED_ACCOUNTS")),
    upstash:
      upstashUrl && upstashToken
        ? { url: upstashUrl.replace(/\/$/, ""), token: upstashToken }
        : null,
    minRequestIntervalMs: num("VINTED_MIN_REQUEST_INTERVAL_MS", 1200),
    maxRetries: num("VINTED_MAX_RETRIES", 2),
    offerDiscountPct: num("OFFER_DISCOUNT_PCT", 20),
    maxLikesPerDay: num("MAX_LIKES_PER_DAY", 30),
    maxOffersPerDay: num("MAX_OFFERS_PER_DAY", 10),
    maxActionsPerHour: num("MAX_ACTIONS_PER_HOUR", 6),
    activeHours: parseActiveHours(str("ACTIVE_HOURS") ?? "8-22"),
    timeZone: str("ACTIVE_TIMEZONE") ?? "Europe/Warsaw",
    autopauseHours: num("AUTOPAUSE_HOURS", 24),
    autoActionsEnabled: str("AUTO_ACTIONS_ENABLED") === "true",
    notifyWebhookUrl: str("NOTIFY_WEBHOOK_URL"),
    monitorPageSize: num("MONITOR_PAGE_SIZE", 20),
    userAgent:
      str("VINTED_USER_AGENT") ??
      "vinted-seller-mcp/1.0 (+https://github.com/andrzej304074-max/12)",
    isProduction: process.env.NODE_ENV === "production" || !!process.env.VERCEL,
    unofficialEnabled: str("ENABLE_UNOFFICIAL") === "true",
    pro: {
      baseUrlSandbox: str("VINTED_PRO_BASE_URL_SANDBOX"),
      baseUrlProduction: str("VINTED_PRO_BASE_URL_PRODUCTION"),
      minRequestIntervalMs: num("VINTED_PRO_MIN_REQUEST_INTERVAL_MS", 300),
      maxRetries: num("VINTED_PRO_MAX_RETRIES", 2),
      timeoutMs: num("VINTED_PRO_TIMEOUT_MS", 30_000),
    },
    blobToken: str("BLOB_READ_WRITE_TOKEN"),
  };
  return cached;
}

/** Test helper: drops the memoised config so env changes take effect. */
export function resetConfigCache(): void {
  cached = null;
}
