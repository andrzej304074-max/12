import { getConfig } from "../config.js";
import { clearProWebhook, getProWebhookId, setProWebhook, type ProAccount } from "./accounts.js";
import { recordProAction } from "./actionlog.js";
import { getProClient } from "./client.js";
import { proEndpoints } from "./endpoints.js";
import { DOCUMENTED_EVENTS } from "./events.js";
import { ProError, ProInputError } from "./errors.js";
import { safeId } from "./hosts.js";

/**
 * Webhook registration at Vinted: where Vinted should send events, and the
 * signing key it will sign them with.
 *
 * Vinted returns that key once, when the webhook is created. It is stored
 * encrypted and is only ever used to verify deliveries (see receiver.ts); no
 * answer from this server contains it.
 */

export const WEBHOOK_PATH = "/api/pro/webhook";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The address Vinted is told to call. Only an https address of this
 * deployment's webhook function is accepted (http only outside production), so
 * events cannot be pointed at some other server by a mistyped or injected URL.
 */
export function checkWebhookUrl(raw: string, accountId: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProInputError("The webhook address is not a valid URL.");
  }
  const production = getConfig().isProduction;
  if (production && url.protocol !== "https:") throw new ProInputError("The webhook address must be https.");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ProInputError("The webhook address must be http(s).");
  if (production && /^(localhost|127\.|10\.|192\.168\.|\[?::1)/i.test(url.hostname)) {
    throw new ProInputError("The webhook address must be this deployment's public address.");
  }
  if (url.pathname !== WEBHOOK_PATH) {
    throw new ProInputError(`The webhook address must end with ${WEBHOOK_PATH}.`);
  }
  url.search = "";
  url.hash = "";
  url.searchParams.set("account", safeId(accountId, "account id"));
  return url.toString();
}

/** This deployment's webhook address, when Vercel tells us the host. */
export function defaultWebhookUrl(accountId: string): string | null {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (!host) return null;
  return checkWebhookUrl(`https://${host}${WEBHOOK_PATH}`, accountId);
}

export async function listWebhooks(account: ProAccount) {
  return (await getProClient().json<unknown>(account, "GET", proEndpoints.webhooks())).data;
}

export interface RegisteredWebhook {
  id: string | null;
  url: string;
  events: string[];
}

/** Registers (or re-registers) the account's webhook and stores its signing key. */
export async function registerWebhook(
  account: ProAccount,
  url: string,
  events: readonly string[] = DOCUMENTED_EVENTS,
): Promise<RegisteredWebhook> {
  const checked = checkWebhookUrl(url, account.id);
  const wanted = [...new Set(events)];
  if (wanted.length === 0) throw new ProInputError("Give at least one event type.");

  // One registration per account: replace the previous one rather than pile up.
  const previous = await getProWebhookId(account.id);
  if (previous) {
    try {
      await getProClient().json(account, "DELETE", proEndpoints.webhook(previous));
    } catch (err) {
      if (!(err instanceof ProError && err.kind === "not_found")) throw err;
    }
    await clearProWebhook(account.id);
  }

  const { data } = await getProClient().json<unknown>(account, "POST", proEndpoints.webhooks(), {
    body: { url: checked, event_types: wanted },
  });
  const body = isRecord(data) ? data : isRecord((data as Record<string, unknown> | undefined)?.webhook) ? ((data as Record<string, unknown>).webhook as Record<string, unknown>) : {};
  const id = typeof body.id === "string" ? body.id : typeof body.id === "number" ? String(body.id) : null;
  const signingKey = typeof body.signing_key === "string" && body.signing_key !== "" ? body.signing_key : null;

  if (!signingKey) {
    // Without the key a delivery cannot be verified, so a webhook we cannot trust is worse than none.
    if (id) {
      try {
        await getProClient().json(account, "DELETE", proEndpoints.webhook(id));
      } catch {
        /* best effort: the error below says what to do */
      }
    }
    await recordProAction(account.id, { kind: "register_webhook", count: 1, ok: false, detail: "no signing key in the answer" });
    throw new ProError(
      "Vinted registered the webhook but did not return its signing key, so deliveries could not be verified. The registration was removed again. Check the answer with pro_raw_get on /api/v1/webhooks.",
      "unexpected",
    );
  }

  await setProWebhook(account.id, { id, url: checked, events: wanted, signingKey });
  await recordProAction(account.id, { kind: "register_webhook", count: 1, ok: true, detail: `${wanted.length} event type(s)` });
  return { id, url: checked, events: wanted };
}

export async function deleteWebhook(account: ProAccount, webhookId?: string): Promise<{ deleted: string | null }> {
  const id = webhookId ?? (await getProWebhookId(account.id));
  if (!id) throw new ProInputError("No webhook is registered for this account.");
  try {
    await getProClient().json(account, "DELETE", proEndpoints.webhook(id));
  } catch (err) {
    // Already gone at Vinted: still forget it here.
    if (!(err instanceof ProError && err.kind === "not_found")) {
      await recordProAction(account.id, { kind: "delete_webhook", count: 1, ok: false, detail: (err as Error).message });
      throw err;
    }
  }
  if (id === (await getProWebhookId(account.id))) await clearProWebhook(account.id);
  await recordProAction(account.id, { kind: "delete_webhook", count: 1, ok: true, detail: "removed" });
  return { deleted: id };
}

/** Sandbox only: asks Vinted to simulate a sale, which sends the webhooks. */
export async function simulateSale(account: ProAccount, itemId: string): Promise<unknown> {
  if (account.env !== "sandbox") {
    throw new ProInputError("Sales can only be simulated in the sandbox; this account is set to production.");
  }
  const { data } = await getProClient().json<unknown>(account, "POST", proEndpoints.devItemSold(itemId));
  await recordProAction(account.id, { kind: "simulate_sale", count: 1, ok: true, detail: "sandbox sale triggered" });
  return data;
}
