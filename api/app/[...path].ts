import { handleApp } from "../../src/app/router.js";
import type { VercelLikeRequest, VercelLikeResponse } from "../../src/http.js";

/**
 * The panel's backend. One catch-all function serves every /api/app/* route,
 * which keeps the deployment well under Vercel's per-project function limit.
 */
export default async function handler(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
): Promise<void> {
  await handleApp(req, res);
}
