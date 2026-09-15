import { authenticateMcp } from "../src/auth.js";
import {
  CORS_HEADERS,
  header,
  readJsonBody,
  sendJson,
  sendNoContent,
  type VercelLikeRequest,
  type VercelLikeResponse,
} from "../src/http.js";
import { log } from "../src/log.js";
import { ErrorCode, failure } from "../src/mcp/protocol.js";
import { handleMessage } from "../src/mcp/server.js";

/**
 * MCP endpoint, Streamable HTTP in stateless mode.
 *
 * One POST carries one JSON-RPC message (or a batch) and gets one JSON
 * response. GET is refused: without a durable session a serverless function
 * has nothing to stream, and clients fall back to POST when SSE is absent.
 */
export default async function handler(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
): Promise<void> {
  if (req.method === "OPTIONS") {
    sendNoContent(res, 204, CORS_HEADERS);
    return;
  }

  if (req.method !== "POST") {
    sendJson(
      res,
      405,
      failure(
        null,
        ErrorCode.InvalidRequest,
        "This endpoint speaks MCP over POST only; it does not offer an SSE stream.",
      ),
      { ...CORS_HEADERS, allow: "POST, OPTIONS" },
    );
    return;
  }

  const auth = authenticateMcp(header(req, "authorization"));
  if (!auth.ok) {
    sendJson(
      res,
      auth.status,
      failure(null, ErrorCode.InvalidRequest, auth.message),
      CORS_HEADERS,
    );
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(
      res,
      400,
      failure(null, ErrorCode.ParseError, (err as Error).message),
      CORS_HEADERS,
    );
    return;
  }

  try {
    const response = await handleMessage(body);
    if (response === null) {
      // Notifications only - nothing to return.
      sendNoContent(res, 202, CORS_HEADERS);
      return;
    }
    sendJson(res, 200, response, CORS_HEADERS);
  } catch (err) {
    log.error("mcp handler failed", { message: (err as Error).message });
    sendJson(
      res,
      500,
      failure(null, ErrorCode.InternalError, (err as Error).message),
      CORS_HEADERS,
    );
  }
}
