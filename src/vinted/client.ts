import { getConfig, type VintedAccount } from "../config.js";
import { log } from "../log.js";
import { endpoints } from "./endpoints.js";
import { classify, collectEvidence, describeEvidence, type Evidence } from "./evidence.js";
import { assertVintedHost, HostError } from "./hosts.js";
import { freshAccount, recoverAccount } from "./login.js";

/**
 * Minimal read client for Vinted's web API.
 *
 * Two deliberate properties, both the opposite of "look like a human":
 *   - it identifies itself honestly in the User-Agent, and
 *   - it backs off when told to, honouring 429 and Retry-After instead of
 *     grinding through the limit.
 * Spacing requests out is here to avoid hammering someone else's service, not
 * to disguise the client. Nothing in this file randomises timing, rotates
 * fingerprints or otherwise tries to defeat bot detection.
 *
 * Writes (`send`) are never retried: liking or offering is not idempotent, and
 * a retry after a timeout could send the same offer twice.
 */

export class VintedError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly path: string,
  ) {
    super(message);
    this.name = "VintedError";
  }
}

/**
 * Vinted pushed back on a write: auth refused, rate limited, or a challenge
 * page instead of JSON. The circuit breaker pauses automation on this.
 */
export class RefusalError extends VintedError {
  constructor(
    message: string,
    status: number | null,
    path: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message, status, path);
    this.name = "RefusalError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Acts as this account. Omit for anonymous, public reads. */
  account?: VintedAccount;
  /** Overrides the marketplace host for this one call. */
  domain?: string;
}

export class VintedClient {
  private lastRequestAt = 0;
  private anonToken: string | null = null;
  private anonCookie: string | null = null;

  constructor(private readonly cfg = getConfig()) {}

  /** Serialises outbound calls so we never burst on a shared API. */
  private async pace(): Promise<void> {
    const gap = Date.now() - this.lastRequestAt;
    const wait = this.cfg.minRequestIntervalMs - gap;
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /**
   * Fetches an anonymous session cookie from the homepage. Public catalog
   * reads need one; it carries no identity and no account is involved.
   */
  private async ensureAnonSession(domain: string): Promise<void> {
    if (this.anonToken || this.anonCookie) return;
    await this.pace();
    const res = await fetch(`https://${domain}${endpoints.home()}`, {
      headers: { "user-agent": this.cfg.userAgent, accept: "text/html" },
      redirect: "follow",
    });
    const raw = res.headers.get("set-cookie") ?? "";
    this.anonToken = readCookie(raw, "access_token_web");
    this.anonCookie = readCookie(raw, "_vinted_fr_session");
    if (!this.anonToken && !this.anonCookie) {
      log.warn("no anonymous session cookie returned", { status: res.status });
    }
  }

  private cookieHeader(account?: VintedAccount): string {
    const parts: string[] = [];
    if (account) {
      parts.push(`access_token_web=${account.accessToken}`);
      if (account.sessionCookie) {
        parts.push(`_vinted_fr_session=${account.sessionCookie}`);
      }
    } else {
      if (this.anonToken) parts.push(`access_token_web=${this.anonToken}`);
      if (this.anonCookie) parts.push(`_vinted_fr_session=${this.anonCookie}`);
    }
    return parts.join("; ");
  }

  /** Performs a GET against the Vinted API and parses the JSON body. */
  async get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const domain = hostFor(opts.domain ?? opts.account?.domain ?? this.cfg.defaultDomain, path);
    if (!opts.account) await this.ensureAnonSession(domain);
    let account = opts.account ? await freshAccount(opts.account) : undefined;
    let recovered = false;

    const url = new URL(`https://${domain}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    let lastError: VintedError | null = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      await this.pace();
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            "user-agent": this.cfg.userAgent,
            accept: "application/json",
            "accept-language": "pl-PL,pl;q=0.9,en;q=0.8",
            cookie: this.cookieHeader(account),
          },
        });
      } catch (err) {
        lastError = new VintedError(
          `network error: ${(err as Error).message}`,
          null,
          path,
        );
        await sleep(backoffMs(attempt));
        continue;
      }

      const text = await res.text().catch(() => "");
      const evidence = collectEvidence(res.status, res.headers, text);
      const isJson = /json/i.test(evidence.contentType ?? "") || /^\s*[{[]/.test(text);

      // A challenge is final: retrying it would only hammer a protected site.
      if (classify(evidence, isJson) === "wall") {
        throw new VintedError(wallMessage(evidence), res.status, path);
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : backoffMs(attempt);
        lastError = new VintedError(
          `upstream returned ${res.status}`,
          res.status,
          path,
        );
        log.warn("backing off", { path, status: res.status, waitMs });
        if (attempt < this.cfg.maxRetries) await sleep(waitMs);
        continue;
      }

      if (res.status === 401 && account && !recovered) {
        // Session expired: renew it once from the refresh token and retry.
        const next = await recoverAccount(account);
        if (next) {
          account = next;
          recovered = true;
          continue;
        }
      }

      if (res.status === 401 || res.status === 403) {
        throw new VintedError(
          account
            ? `Vinted rejected the credentials for account "${account.id}" (${describeEvidence(evidence)}). The session has most likely expired - log in again in the panel (Accounts tab).`
            : `Vinted refused an anonymous read (${describeEvidence(evidence)}). From a server this is often bot protection, but the answer has no recognisable marker.`,
          res.status,
          path,
        );
      }

      if (!res.ok) {
        throw new VintedError(
          `unexpected answer (${describeEvidence(evidence)}): ${evidence.snippet}`,
          res.status,
          path,
        );
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new VintedError(
          `Vinted answered with a web page instead of JSON (${describeEvidence(evidence)}); the endpoint has probably changed: ${evidence.snippet}`,
          res.status,
          path,
        );
      }
    }
    throw lastError ?? new VintedError("request failed", null, path);
  }

  /** Performs one write as an account. Never retried. */
  async send<T>(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    opts: SendOptions,
    alreadyRecovered = false,
  ): Promise<T> {
    const account = await freshAccount(opts.account);
    const domain = hostFor(opts.domain ?? account.domain ?? this.cfg.defaultDomain, path);
    const url = new URL(`https://${domain}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    await this.pace();
    const headers: Record<string, string> = {
      "user-agent": this.cfg.userAgent,
      accept: "application/json",
      "accept-language": "pl-PL,pl;q=0.9,en;q=0.8",
      cookie: this.cookieHeader(account),
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (account.csrfToken) headers["x-csrf-token"] = account.csrfToken;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        // A FormData body sets its own multipart content-type.
        ...(opts.form
          ? { body: opts.form }
          : opts.body !== undefined
            ? { body: JSON.stringify(opts.body) }
            : {}),
      });
    } catch (err) {
      throw new VintedError(
        `network error, the action may or may not have gone through - check in Vinted before repeating: ${(err as Error).message}`,
        null,
        path,
      );
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new RefusalError(
        "Vinted is rate limiting this account (429).",
        429,
        path,
        Number.isFinite(retryAfter) ? retryAfter : null,
      );
    }
    if (res.status === 401 && !alreadyRecovered) {
      // A 401 means the request was rejected before doing anything, so after
      // renewing the session it is safe to send it once more.
      const next = await recoverAccount(account);
      if (next) return this.send<T>(method, path, { ...opts, account: next }, true);
    }
    const text = res.status === 204 ? "" : await res.text().catch(() => "");
    const evidence = collectEvidence(res.status, res.headers, text);
    const isJson = /json/i.test(evidence.contentType ?? "") || /^\s*[{[]/.test(text);
    if (classify(evidence, isJson) === "wall") {
      throw new RefusalError(wallMessage(evidence), res.status, path);
    }
    if (res.status === 401 || res.status === 403) {
      throw new RefusalError(
        `Vinted refused the action for account "${account.id}" (${describeEvidence(evidence)}). The session may have expired (log in again in the panel), or the action needs a CSRF token or a captcha.`,
        res.status,
        path,
      );
    }
    if (res.ok && !isJson && res.status !== 204) {
      throw new RefusalError(
        `Vinted answered with a web page instead of JSON (${describeEvidence(evidence)}) - the endpoint has probably changed, or a challenge was served: ${evidence.snippet}`,
        res.status,
        path,
      );
    }
    if (!res.ok) {
      throw new VintedError(
        `action failed (${describeEvidence(evidence)}): ${evidence.snippet}`,
        res.status,
        path,
      );
    }
    if (res.status === 204) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return {} as T;
    }
  }
}

export interface SendOptions {
  account: VintedAccount;
  body?: unknown;
  /** Multipart upload; takes precedence over `body`. */
  form?: FormData;
  query?: RequestOptions["query"];
  domain?: string;
}

function wallMessage(evidence: Evidence): string {
  return `Vinted's bot protection blocked this request (${describeEvidence(evidence)}). A server cannot pass that check; nothing was bypassed and the request was not repeated.`;
}

/** Refuses any host that is not a Vinted marketplace, before a cookie is attached. */
function hostFor(domain: string, path: string): string {
  try {
    return assertVintedHost(domain);
  } catch (err) {
    if (err instanceof HostError) throw new VintedError(err.message, null, path);
    throw err;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}

/** Pulls one cookie value out of a raw Set-Cookie header. */
export function readCookie(raw: string, name: string): string | null {
  const match = new RegExp(`${name}=([^;,\\s]+)`).exec(raw);
  return match?.[1] ?? null;
}

let shared: VintedClient | null = null;
export function getClient(): VintedClient {
  if (!shared) shared = new VintedClient();
  return shared;
}
export function resetClientCache(): void {
  shared = null;
}
