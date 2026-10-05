import { log } from "../log.js";
import { LimitError } from "../monitor/safety.js";
import { AccountError } from "../vinted/accounts.js";
import { VintedError } from "../vinted/client.js";
import {
  ErrorCode,
  failure,
  isJsonRpcRequest,
  isNotification,
  jsonResult,
  PROTOCOL_VERSION,
  success,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolResult,
} from "./protocol.js";
import { findTool, toolManifest } from "./tools/index.js";
import { ArgumentError } from "./tools/types.js";

export const SERVER_INFO = {
  name: "vinted-seller-mcp",
  title: "Vinted Seller MCP",
  version: "1.0.0",
} as const;

const INSTRUCTIONS = `Research and monitoring tools for selling on Vinted.

What it does: finds comparable listings, estimates a defensible price, resolves
categories and brands, drafts and validates listings, and watches chosen sellers
for newly posted items - reporting each with a suggested negotiation price.

Actions that change something on Vinted (like_item, make_offer, process_find,
send_message, publish_listing, delete_listing) never send without
confirm: true. Called without it they return a preview - show it to the user
and only confirm once they have agreed. Automatic likes/offers on watched
sellers are opt-in per seller, off unless AUTO_ACTIONS_ENABLED is set, and
bounded by the limits shown in get_automation_status.`;

/**
 * Turns an exception into a tool result. Argument, account and upstream errors
 * are the caller's to fix, so they come back as readable tool errors rather
 * than protocol-level failures; anything else is logged and reported plainly.
 */
function toToolError(name: string, err: unknown): ToolResult {
  if (
    err instanceof ArgumentError ||
    err instanceof AccountError ||
    err instanceof LimitError ||
    err instanceof VintedError
  ) {
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
  log.error("tool threw", { tool: name, message: (err as Error).message });
  return {
    content: [
      {
        type: "text",
        text: `Tool "${name}" failed: ${(err as Error).message}`,
      },
    ],
    isError: true,
  };
}

/** Handles one JSON-RPC request. Returns null for notifications. */
export async function handleRequest(
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return success(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return success(id, {});

    case "tools/list":
      return success(id, { tools: toolManifest() });

    case "tools/call": {
      const params = req.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) {
        return failure(id, ErrorCode.InvalidParams, "Missing tool name.");
      }
      const tool = findTool(name);
      if (!tool) {
        return failure(id, ErrorCode.MethodNotFound, `Unknown tool "${name}".`);
      }
      const args =
        typeof params.arguments === "object" && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        return success(id, await tool.handler(args));
      } catch (err) {
        return success(id, toToolError(name, err));
      }
    }

    // Declared-but-empty capabilities keep conformance checkers happy.
    case "resources/list":
      return success(id, { resources: [] });
    case "prompts/list":
      return success(id, { prompts: [] });

    default:
      if (isNotification(req)) return null;
      return failure(
        id,
        ErrorCode.MethodNotFound,
        `Unsupported method "${req.method}".`,
      );
  }
}

/**
 * Handles a parsed request body, which may be a single request or a batch.
 * Returns null when nothing needs to be sent back (all notifications).
 */
export async function handleMessage(
  body: unknown,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const entry of body) {
      if (!isJsonRpcRequest(entry)) {
        responses.push(
          failure(null, ErrorCode.InvalidRequest, "Not a JSON-RPC 2.0 request."),
        );
        continue;
      }
      const response = await handleRequest(entry);
      if (response) responses.push(response);
    }
    return responses.length ? responses : null;
  }

  if (!isJsonRpcRequest(body)) {
    return failure(null, ErrorCode.InvalidRequest, "Not a JSON-RPC 2.0 request.");
  }
  return handleRequest(body);
}

export { jsonResult };
