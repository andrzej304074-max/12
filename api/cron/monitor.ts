import { authenticateCron } from "../../src/auth.js";
import {
  header,
  sendJson,
  type VercelLikeRequest,
  type VercelLikeResponse,
} from "../../src/http.js";
import { log } from "../../src/log.js";
import { runPass } from "../../src/monitor/engine.js";
import { getStore } from "../../src/store/index.js";

/**
 * Scheduled watchlist poll, wired up in vercel.json.
 *
 * It only detects and records. It never likes an item, messages a seller or
 * sends an offer - a scheduled job acting on strangers unattended is exactly
 * what this design avoids. Findings wait in the store for a person.
 */
export default async function handler(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
): Promise<void> {
  const auth = authenticateCron(header(req, "authorization"));
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.message });
    return;
  }

  const store = getStore();
  if (!store.durable) {
    sendJson(res, 200, {
      skipped: true,
      reason:
        "No durable storage configured, so a scheduled pass has nowhere to record findings. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    });
    return;
  }

  try {
    const results = await runPass();
    const totalFinds = results.reduce((sum, r) => sum + r.newFinds.length, 0);
    log.info("monitor pass complete", {
      accounts: results.length,
      totalFinds,
    });
    sendJson(res, 200, {
      ranAt: new Date().toISOString(),
      accounts: results.length,
      totalFinds,
      results: results.map((r) => ({
        accountId: r.accountId,
        sellersChecked: r.sellersChecked,
        newFinds: r.newFinds.length,
        errors: r.errors,
      })),
    });
  } catch (err) {
    log.error("monitor pass failed", { message: (err as Error).message });
    sendJson(res, 500, { error: (err as Error).message });
  }
}
