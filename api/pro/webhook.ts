import type { VercelLikeRequest, VercelLikeResponse } from "../../src/http.js";
import { handleProWebhook } from "../../src/pro/receiver.js";

/**
 * Where Vinted Pro delivers webhook events (see src/pro/receiver.ts).
 *
 * The signature is checked over the exact bytes of the body, so set
 * NODEJS_HELPERS=0 in the Vercel project: it stops the Node runtime from
 * parsing the body before this function runs. Everything else in this project
 * works the same with or without it.
 */
export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  await handleProWebhook(req, res);
}
