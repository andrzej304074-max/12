import { authenticateCron } from "../../src/auth.js";
import { unofficialEnabled } from "../../src/features.js";
import {
  header,
  sendJson,
  type VercelLikeRequest,
  type VercelLikeResponse,
} from "../../src/http.js";
import { log } from "../../src/log.js";
import { runPass } from "../../src/monitor/engine.js";
import { reconcileAllPro } from "../../src/pro/reconcile.js";
import { getStore } from "../../src/store/index.js";

/**
 * The daily job, wired up in vercel.json.
 *
 * Vinted Pro: catches up on anything asynchronous that a webhook did not report
 * (items still "in progress", a stale ontology cache). See src/pro/reconcile.ts.
 *
 * Only when ENABLE_UNOFFICIAL=true, the watchlist poll of the unofficial
 * consumer API: it detects new listings, notifies the webhook if one is set,
 * and - only for watches with auto_like / auto_offer and only when
 * AUTO_ACTIONS_ENABLED is true - works through the automatic-action queue under
 * the account's limits, activity window and circuit breaker. See
 * src/monitor/engine.ts.
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
    const results = unofficialEnabled() ? await runPass() : [];
    const pro = await reconcileAllPro();
    const totalFinds = results.reduce((sum, r) => sum + r.newFinds.length, 0);
    const totalAutoActions = results.reduce(
      (sum, r) => sum + r.autoActions.filter((a) => a.ok).length,
      0,
    );
    log.info("monitor pass complete", {
      accounts: results.length,
      totalFinds,
      totalAutoActions,
    });
    sendJson(res, 200, {
      ranAt: new Date().toISOString(),
      unofficial: unofficialEnabled(),
      pro,
      accounts: results.length,
      totalFinds,
      totalAutoActions,
      results: results.map((r) => ({
        accountId: r.accountId,
        sellersChecked: r.sellersChecked,
        newFinds: r.newFinds.length,
        autoActions: r.autoActions,
        autoStoppedBecause: r.autoStoppedBecause,
        notified: r.notified,
        errors: r.errors,
      })),
    });
  } catch (err) {
    log.error("monitor pass failed", { message: (err as Error).message });
    sendJson(res, 500, { error: (err as Error).message });
  }
}
