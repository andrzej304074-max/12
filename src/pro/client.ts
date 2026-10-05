import { getConfig } from "../config.js";
import { log } from "../log.js";
import { cleanSnippet } from "../vinted/evidence.js";
import { markProOk, markProRejected, type ProAccount } from "./accounts.js";
import { ProError } from "./errors.js";
import { assertProPath, proBaseUrl } from "./hosts.js";
import { signRequest } from "./signing.js";

/**
 * Signed HTTP client for the Vinted Pro Integrations API.
 *
 * What it does and does not do:
 *   - every attempt is signed afresh (the timestamp is part of the signature);
 *   - GET, PUT and DELETE are repeated after a network error or a 5xx; POST is
 *     not, because creating twice is worse than failing once. A 429 means the
 *     request was refused before it did anything, so it is the one answer that
 *     is waited out and repeated for every method;
 *   - redirects are never followed (a signed request must not travel on);
 *   - no error message, log line or return value ever contains a key, a header
 *     or the request body.
 */

export type ProMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface ProCallOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /**
   * One attempt, and whatever comes back is returned as it is - a 429 or a 5xx
   * included - instead of being waited out or turned into an error. For looking
   * at the raw answer (pro_raw_get).
   */
  once?: boolean;
}

export interface ProRaw {
  status: number;
  contentType: string | null;
  headers: Headers;
  bytes: Uint8Array;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt: number) => Math.min(8000, 500 * 2 ** attempt);
const MAX_WAIT_MS = 20_000;

/** Percent-encodes like encodeURIComponent plus the characters URL parsing would rewrite. */
function enc(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The query string, built once and used both on the wire and in the signature. */
export function buildQuery(query: ProCallOptions["query"]): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${enc(key)}=${enc(String(value))}`);
  }
  return parts.join("&");
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Vinted's error body is `{"error": "CODE"}`; tolerate the obvious variants. */
function errorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  if (typeof rec.error === "string") return rec.error;
  if (rec.error && typeof rec.error === "object") {
    const inner = rec.error as Record<string, unknown>;
    if (typeof inner.code === "string") return inner.code;
  }
  return typeof rec.code === "string" ? rec.code : null;
}

function describe(status: number, code: string | null): string {
  return code ? `${status}, ${code}` : String(status);
}

/** Turns a final non-2xx answer into an error a person can act on. */
export function errorFromResponse(raw: ProRaw, secrets: string[] = []): ProError {
  const body = parseJson(raw.bytes);
  const code = errorCode(body);
  const where = describe(raw.status, code);
  const retryAfter = retryAfterMs(raw.headers);
  const retryAfterSeconds = retryAfter === null ? null : Math.ceil(retryAfter / 1000);

  switch (raw.status) {
    case 401:
      return new ProError(
        `Vinted Pro refused the signature (${where}). Check that the token was copied whole, that it belongs to the same environment as the account (sandbox and production tokens differ) and that this server's clock is right: the timestamp is part of the signature.`,
        "auth",
        401,
        code,
        body,
      );
    case 403:
      return new ProError(
        `Vinted Pro refused access (${where}). The account has to be on Vinted's allowlist for Pro Integrations, and its market has to be one the API serves. The documentation lists AT, BE, DE, ES, FR, IT, LU, NL, PT and UK; Poland is not on that list, so ask Vinted whether the account is supported.`,
        "forbidden",
        403,
        code,
        body,
      );
    case 404:
      return new ProError(
        `Not found (${where}). Vinted also answers 404 for resources that are not managed through Pro Integrations.`,
        "not_found",
        404,
        code,
        body,
      );
    case 429:
      return new ProError(
        `Vinted Pro is rate limiting this account (${where})${retryAfterSeconds !== null ? `; retry after ${retryAfterSeconds} s` : ""}.`,
        "rate_limited",
        429,
        code,
        body,
        retryAfterSeconds,
      );
    case 400:
    case 422: {
      const detail = body === undefined ? cleanSnippet(Buffer.from(raw.bytes).toString("utf8"), secrets, 200) : JSON.stringify(body).slice(0, 600);
      return new ProError(`Vinted Pro rejected the request (${where}): ${detail}`, "validation", raw.status, code, body);
    }
    default:
      if (raw.status >= 500) {
        return new ProError(`Vinted Pro had an error (${where}). Try again in a moment.`, "server", raw.status, code, body);
      }
      if (raw.status >= 300 && raw.status < 400) {
        return new ProError(
          `Vinted Pro answered with a redirect (${raw.status}); it was not followed because the request was signed. The address is probably wrong.`,
          "unexpected",
          raw.status,
        );
      }
      return new ProError(
        `Unexpected answer from Vinted Pro (${where}): ${cleanSnippet(Buffer.from(raw.bytes).toString("utf8"), secrets, 200)}`,
        "unexpected",
        raw.status,
        code,
        body,
      );
  }
}

export class ProClient {
  private lastRequestAt = 0;

  constructor(private readonly cfg = getConfig()) {}

  private async pace(): Promise<void> {
    const wait = this.cfg.pro.minRequestIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /**
   * One signed exchange, with the retry rules above. Returns the final answer
   * for any status below 500 (even an error); the callers decide what an error
   * means. A 5xx or a 429 that outlasts the retries throws.
   */
  async raw(
    account: ProAccount,
    method: ProMethod,
    path: string,
    opts: ProCallOptions = {},
    accept = "application/json",
  ): Promise<ProRaw> {
    assertProPath(path);
    const qs = buildQuery(opts.query);
    const pathWithQuery = qs ? `${path}?${qs}` : path;
    const bodyText = opts.body === undefined ? "" : JSON.stringify(opts.body);
    const base = proBaseUrl(account.env);
    const repeatable = method !== "POST";
    const secrets = [account.accessKey, account.signingKey];
    const max = opts.once ? 0 : this.cfg.pro.maxRetries;

    let last: ProError | null = null;
    for (let attempt = 0; attempt <= max; attempt++) {
      await this.pace();
      const { headers: signature } = signRequest(account, method, pathWithQuery, bodyText);

      let res: Response;
      let bytes: Uint8Array;
      try {
        res = await fetch(`${base}${pathWithQuery}`, {
          method,
          headers: {
            ...signature,
            Accept: accept,
            ...(bodyText ? { "Content-Type": "application/json" } : {}),
          },
          ...(bodyText ? { body: bodyText } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(this.cfg.pro.timeoutMs),
        });
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        const timedOut = (err as Error).name === "TimeoutError";
        last = new ProError(
          `${timedOut ? `Vinted Pro did not answer within ${Math.round(this.cfg.pro.timeoutMs / 1000)} s` : `Network error talking to Vinted Pro: ${(err as Error).message}`}.${repeatable ? "" : " The request may or may not have been processed; check before repeating it."}`,
          "network",
        );
        if (repeatable && attempt < max) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw last;
      }

      const raw: ProRaw = { status: res.status, contentType: res.headers.get("content-type"), headers: res.headers, bytes };

      if (opts.once) {
        await this.note(account, raw.status);
        return raw;
      }
      if (raw.status === 429) {
        last = errorFromResponse(raw, secrets);
        if (attempt < max) {
          await sleep(Math.min(retryAfterMs(res.headers) ?? backoffMs(attempt), MAX_WAIT_MS));
          continue;
        }
        throw last;
      }
      if (raw.status >= 500) {
        last = errorFromResponse(raw, secrets);
        if (repeatable && attempt < max) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw last;
      }

      await this.note(account, raw.status);
      return raw;
    }
    throw last ?? new ProError("The request to Vinted Pro failed.", "unexpected");
  }

  /** Keeps the account's status honest without ever failing the request. */
  private async note(account: ProAccount, status: number): Promise<void> {
    try {
      if (status === 401) await markProRejected(account.id, "token rejected (401)");
      else if (status === 403) await markProRejected(account.id, "access forbidden (403)");
      else if (status >= 200 && status < 300) await markProOk(account);
    } catch (err) {
      log.warn("could not record pro account status", { id: account.id, message: (err as Error).message });
    }
  }

  /** A JSON call. Throws a ProError for anything that is not a 2xx answer. */
  async json<T = unknown>(
    account: ProAccount,
    method: ProMethod,
    path: string,
    opts: ProCallOptions = {},
  ): Promise<{ status: number; data: T }> {
    const raw = await this.raw(account, method, path, opts);
    if (raw.status < 200 || raw.status >= 300) {
      throw errorFromResponse(raw, [account.accessKey, account.signingKey]);
    }
    if (raw.status === 204 || raw.bytes.length === 0) return { status: raw.status, data: {} as T };
    const data = parseJson(raw.bytes);
    if (data === undefined) {
      throw new ProError(
        `Vinted Pro answered ${raw.status} but not with JSON: ${cleanSnippet(Buffer.from(raw.bytes).toString("utf8"), [account.accessKey, account.signingKey], 160)}`,
        "unexpected",
        raw.status,
      );
    }
    return { status: raw.status, data: data as T };
  }

  /** A PDF download (the shipping label). */
  async pdf(account: ProAccount, path: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const raw = await this.raw(account, "GET", path, {}, "application/pdf");
    if (raw.status !== 200) throw errorFromResponse(raw, [account.accessKey, account.signingKey]);
    const isPdf = Buffer.from(raw.bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
    if (!isPdf) {
      throw new ProError("Vinted Pro answered 200 but the body is not a PDF.", "unexpected", 200);
    }
    return { bytes: raw.bytes, contentType: raw.contentType ?? "application/pdf" };
  }
}

let shared: ProClient | null = null;
export function getProClient(): ProClient {
  if (!shared) shared = new ProClient();
  return shared;
}
export function resetProClientCache(): void {
  shared = null;
}
