import { createHmac, timingSafeEqual } from "node:crypto";
import { ProInputError } from "./errors.js";

/**
 * Request and webhook signing for the Vinted Pro Integrations API.
 *
 * This is not OAuth2. The portal issues one string, `<access_key>,<signing_key>`.
 * Every request carries the access key and an HMAC-SHA256 signature made with
 * the signing key, which itself is never sent.
 *
 *   X-Vpi-Access-Key:  <access_key>
 *   X-Vpi-Hmac-Sha256: t=<unix seconds>,v1=<hex>
 *   v1 = hex( HMAC_SHA256( key = signing_key,
 *                          msg = "<t>.<METHOD>.<path?query>.<access_key>.<body>" ) )
 *
 * `path?query` is exactly what goes on the wire, and `body` is exactly the
 * bytes sent (empty when there is none). A webhook is signed the same way with
 * the webhook's own key over "<t>.<raw body>".
 */

export interface ProCredentials {
  accessKey: string;
  signingKey: string;
}

const PRINTABLE = /^[\x21-\x7e]+$/;

/** Splits the portal's token on its first comma and sanity-checks both halves. */
export function parseToken(token: string): ProCredentials {
  const trimmed = token.trim();
  const comma = trimmed.indexOf(",");
  if (comma <= 0 || comma === trimmed.length - 1) {
    throw new ProInputError(
      "The token must be the whole string from the Vinted Pro portal: <access_key>,<signing_key> (two parts separated by a comma).",
    );
  }
  const accessKey = trimmed.slice(0, comma).trim();
  const signingKey = trimmed.slice(comma + 1).trim();
  if (!PRINTABLE.test(accessKey) || !PRINTABLE.test(signingKey)) {
    throw new ProInputError(
      "The token contains spaces or characters that cannot be part of a key. Copy it again from the portal.",
    );
  }
  return { accessKey, signingKey };
}

export function signingPayload(
  t: number,
  method: string,
  pathWithQuery: string,
  accessKey: string,
  body: string,
): string {
  return `${t}.${method.toUpperCase()}.${pathWithQuery}.${accessKey}.${body}`;
}

/**
 * Headers for one request. A retry must call this again: the timestamp is part
 * of the signature and the server rejects stale ones.
 */
export function signRequest(
  creds: ProCredentials,
  method: string,
  pathWithQuery: string,
  body: string,
  now: number = Date.now(),
): { t: number; headers: Record<string, string> } {
  const t = Math.floor(now / 1000);
  const v1 = createHmac("sha256", creds.signingKey)
    .update(signingPayload(t, method, pathWithQuery, creds.accessKey, body))
    .digest("hex");
  return {
    t,
    headers: {
      "X-Vpi-Access-Key": creds.accessKey,
      "X-Vpi-Hmac-Sha256": `t=${t},v1=${v1}`,
    },
  };
}

export type WebhookVerdict =
  | { ok: true; t: number }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

/** Replay window for webhooks, seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

function equalHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a.toLowerCase(), "hex"), Buffer.from(b.toLowerCase(), "hex"));
}

/**
 * Checks `X-Vpi-Webhook-Hmac-Sha256: t=<ts>,v1=<hex>` over the raw body.
 * Constant-time comparison; an old timestamp is refused to stop replays.
 */
export function verifyWebhookSignature(
  header: string | undefined,
  rawBody: string | Uint8Array,
  webhookSigningKey: string,
  { now = Date.now(), toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS } = {},
): WebhookVerdict {
  if (!header) return { ok: false, reason: "missing" };
  let t = "";
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === "t") t = value;
    else if (name === "v1" && value !== "") candidates.push(value);
  }
  if (!/^\d{1,12}$/.test(t) || candidates.length === 0) return { ok: false, reason: "malformed" };
  const seconds = Number(t);
  if (Math.abs(now / 1000 - seconds) > toleranceSeconds) return { ok: false, reason: "stale" };

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const expected = createHmac("sha256", webhookSigningKey)
    .update(Buffer.concat([Buffer.from(`${t}.`, "utf8"), body]))
    .digest("hex");
  return candidates.some((candidate) => equalHex(candidate, expected))
    ? { ok: true, t: seconds }
    : { ok: false, reason: "mismatch" };
}
