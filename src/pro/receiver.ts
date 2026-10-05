import { createHash } from "node:crypto";
import { header, sendJson, type VercelLikeRequest, type VercelLikeResponse } from "../http.js";
import { log } from "../log.js";
import { getStore, keys } from "../store/index.js";
import { listWebhookSecrets } from "./accounts.js";
import { recordProEvent } from "./events.js";
import { verifyWebhookSignature } from "./signing.js";

/**
 * Receiver of Vinted Pro webhook deliveries (api/pro/webhook.ts).
 *
 * A delivery is believed only if its HMAC matches. The signature covers the
 * exact bytes Vinted sent, so the body is read raw and nothing is parsed, logged
 * or acted on until the signature checks out.
 *
 * On Vercel the Node runtime normally parses a JSON body before the handler
 * runs, which loses those bytes. Setting NODEJS_HELPERS=0 turns that off (the
 * code uses none of the helpers) and the raw stream arrives untouched. When it
 * has been parsed anyway the receiver falls back to re-serialising it: that
 * only verifies if Vinted's JSON is byte-for-byte what JSON.stringify gives, and
 * where it is not the delivery is refused (fail closed) and noted, so the cause
 * can be seen in the panel.
 */

const MAX_BODY_BYTES = 1_000_000;
const DEDUPE_SECONDS = 10 * 60;
const REFUSED_LOG_LENGTH = 10;

export class BodyTooLarge extends Error {}

export interface RawBody {
  bytes: Buffer;
  /** True when the platform had already parsed the body and it was rebuilt from that. */
  fromParsed: boolean;
}

/** The request body as bytes, taken from the stream before anything else touches it. */
export async function readRawBody(req: VercelLikeRequest, maxBytes = MAX_BODY_BYTES): Promise<RawBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buf.length;
      if (total > maxBytes) throw new BodyTooLarge();
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof BodyTooLarge) throw err;
    // A broken stream is treated like an empty one; the checks below decide.
  }
  if (total > 0) return { bytes: Buffer.concat(chunks), fromParsed: false };

  // Nothing left in the stream: the platform may have read it already.
  const parsed = req.body;
  if (typeof parsed === "string") return { bytes: Buffer.from(parsed, "utf8"), fromParsed: true };
  if (Buffer.isBuffer(parsed)) return { bytes: parsed, fromParsed: false };
  if (parsed !== undefined && parsed !== null) {
    return { bytes: Buffer.from(JSON.stringify(parsed), "utf8"), fromParsed: true };
  }
  return { bytes: Buffer.alloc(0), fromParsed: false };
}

export interface RefusedDelivery {
  at: string;
  /** Why each candidate account's key did not verify the delivery. */
  reasons: string[];
  /** Whether the body had to be rebuilt from a parsed one. */
  fromParsed: boolean;
  bodyBytes: number;
  hadSignature: boolean;
  /** The ?account= the delivery named, if any. */
  account: string | null;
}

/** The last few refused deliveries: enough to see why, with nothing from the body or the signature. */
export async function listRefusedDeliveries(): Promise<RefusedDelivery[]> {
  return (await getStore().get<RefusedDelivery[]>(keys.proSeen("refused"))) ?? [];
}

async function noteRefused(entry: RefusedDelivery): Promise<void> {
  try {
    const store = getStore();
    const current = (await store.get<RefusedDelivery[]>(keys.proSeen("refused"))) ?? [];
    await store.set(keys.proSeen("refused"), [entry, ...current].slice(0, REFUSED_LOG_LENGTH), 60 * 60 * 24 * 14);
  } catch {
    // Diagnostics must never turn a refusal into an error.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function handleProWebhook(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    return;
  }

  let raw: RawBody;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    const tooLarge = err instanceof BodyTooLarge;
    // The rest of an oversized body is never read, so the connection must not be reused.
    sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? "too_large" : "bad_request" }, { connection: "close" });
    return;
  }

  const signature = header(req, "x-vpi-webhook-hmac-sha256");
  const named = new URL(req.url ?? "/", "http://local").searchParams.get("account");
  const secrets = await listWebhookSecrets();
  const candidates = named ? secrets.filter((s) => s.accountId === named) : secrets;

  let matched: { accountId: string; t: number } | null = null;
  const reasons: string[] = [];
  for (const candidate of candidates) {
    const verdict = verifyWebhookSignature(signature, raw.bytes, candidate.signingKey);
    if (verdict.ok) {
      matched = { accountId: candidate.accountId, t: verdict.t };
      break;
    }
    reasons.push(`${candidate.accountId}: ${verdict.reason}`);
  }

  if (!matched) {
    if (candidates.length === 0) reasons.push(named ? `no webhook registered for "${named}"` : "no webhook registered");
    await noteRefused({
      at: new Date().toISOString(),
      reasons,
      fromParsed: raw.fromParsed,
      bodyBytes: raw.bytes.length,
      hadSignature: Boolean(signature),
      account: named,
    });
    log.warn("pro webhook refused", { reasons, fromParsed: raw.fromParsed, bodyBytes: raw.bytes.length });
    sendJson(res, 401, { error: "unverified" });
    return;
  }

  // The same delivery can arrive more than once; handle it once.
  const digest = createHash("sha256").update(matched.accountId).update("\n").update(String(matched.t)).update("\n").update(raw.bytes).digest("hex");
  const store = getStore();
  if (!(await store.setNx(keys.proSeen(digest), 1, DEDUPE_SECONDS))) {
    sendJson(res, 200, { ok: true, duplicate: true });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.bytes.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "not_json" });
    return;
  }
  const type = isRecord(body) ? (typeof body.event_type === "string" ? body.event_type : typeof body.type === "string" ? body.type : null) : null;
  if (!type || !/^[A-Z][A-Z0-9_]{2,63}$/.test(type)) {
    sendJson(res, 400, { error: "no_event_type" });
    return;
  }

  try {
    await recordProEvent(matched.accountId, type, isRecord(body) ? body.data : undefined);
  } catch (err) {
    // Let Vinted try again later: forget that this one was seen.
    await store.del(keys.proSeen(digest));
    log.error("pro webhook processing failed", { type, accountId: matched.accountId, message: (err as Error).message });
    sendJson(res, 500, { error: "processing_failed" });
    return;
  }
  sendJson(res, 200, { ok: true });
}
