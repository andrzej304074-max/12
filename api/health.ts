import { getConfig } from "../src/config.js";
import { sendJson, type VercelLikeRequest, type VercelLikeResponse } from "../src/http.js";
import { SERVER_INFO } from "../src/mcp/server.js";
import { allTools } from "../src/mcp/tools/index.js";
import { getStore } from "../src/store/index.js";
import { listAccounts } from "../src/vinted/accounts.js";

/** Unauthenticated liveness probe. Reports no secrets and no account details. */
export default async function handler(
  _req: VercelLikeRequest,
  res: VercelLikeResponse,
): Promise<void> {
  const cfg = getConfig();
  sendJson(res, 200, {
    status: "ok",
    server: SERVER_INFO,
    tools: allTools.length,
    accountsConfigured: (await listAccounts()).length,
    authConfigured: cfg.mcpAuthToken !== null,
    durableStorage: getStore().durable,
  });
}
