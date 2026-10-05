import { getConfig } from "../config.js";
import {
  header,
  readJsonBody,
  sendJson,
  type VercelLikeRequest,
  type VercelLikeResponse,
} from "../http.js";
import { log } from "../log.js";
import { callTool, SERVER_INFO } from "../mcp/server.js";
import { toolManifest } from "../mcp/tools/index.js";
import {
  checkPassword,
  clearFailures,
  clearSessionCookie,
  createSessionCookie,
  isLockedOut,
  registerFailure,
  verifySession,
} from "../session.js";
import { getStore } from "../store/index.js";
import { listAccountSummaries } from "../vinted/accounts.js";
import {
  getLoginLog,
  LoginError,
  startLogin,
  verifyLogin,
  type LoginFailure,
} from "../vinted/login.js";

/**
 * Backend of the web panel, mounted at /api/app/*.
 *
 * Every route is ONE path segment (see routeOf). Everything except /login and
 * /me needs a valid session. The panel does not
 * reimplement any feature: /tool runs the same tool handlers the MCP endpoint
 * runs, through the same callTool(). Only the account login (which carries a
 * password and a verification code) has dedicated routes, because that data
 * must never travel through a tool call or an MCP client.
 */

const BODY_LIMIT = 4_000_000;

const LOGIN_STATUS: Record<LoginFailure, number> = {
  invalid_input: 400,
  bad_credentials: 401,
  expired: 410,
  bad_code: 422,
  rate_limited: 429,
  blocked: 409,
  no_encryption: 503,
  unexpected: 502,
};

function clientIp(req: VercelLikeRequest): string {
  const forwarded = header(req, "x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
}

/** Mutating requests must come from the panel's own origin. */
function sameOrigin(req: VercelLikeRequest): boolean {
  const origin = header(req, "origin");
  const host = header(req, "host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function setupFlags() {
  const cfg = getConfig();
  return {
    durableStorage: getStore().durable,
    encryptionKey: cfg.encryptionKey !== null,
    mcpAuthToken: cfg.mcpAuthToken !== null,
    cronSecret: cfg.cronSecret !== null,
    notifyWebhook: cfg.notifyWebhookUrl !== null,
  };
}

/**
 * Works out which panel route a request is for.
 *
 * Vercel turns the catch-all file api/app/[...path].ts into a route that
 * matches exactly ONE path segment, so every panel route is a single segment
 * (/account-login, not /accounts/login) - a test enforces that. The function may
 * receive the original URL or an internal one that carries the segment in a
 * "...path" query parameter; both are understood.
 */
export function routeOf(rawUrl: string): string {
  const url = new URL(rawUrl || "/", "http://local");
  let path = url.pathname;
  if (path.includes("[") || /%5b/i.test(path)) {
    path = `/api/app/${url.searchParams.get("...path") ?? ""}`;
  }
  return path.replace(/^\/api\/app/, "").replace(/\/+$/, "") || "/";
}

export async function handleApp(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const route = routeOf(req.url ?? "/");

  try {
    if (method !== "GET" && !sameOrigin(req)) {
      sendJson(res, 403, { error: "bad_origin", message: "Request origin does not match the panel." });
      return;
    }

    const cfg = getConfig();
    const authenticated = verifySession(header(req, "cookie"));

    if (route === "/me" && method === "GET") {
      sendJson(res, 200, {
        authenticated,
        passwordConfigured: cfg.adminPassword !== null,
        ...(authenticated ? { setup: setupFlags(), server: SERVER_INFO } : {}),
      });
      return;
    }

    if (route === "/login" && method === "POST") {
      if (!cfg.adminPassword) {
        sendJson(res, 503, {
          error: "panel_disabled",
          message: "The panel is disabled: set ADMIN_PASSWORD in the Vercel project settings.",
        });
        return;
      }
      const ip = clientIp(req);
      if (await isLockedOut(ip)) {
        sendJson(res, 429, {
          error: "locked_out",
          message: "Too many wrong passwords. Try again in 15 minutes.",
        });
        return;
      }
      const body = asObject(await readJsonBody(req));
      if (typeof body.password !== "string" || !checkPassword(body.password)) {
        await registerFailure(ip);
        sendJson(res, 401, { error: "bad_password", message: "Wrong password." });
        return;
      }
      await clearFailures(ip);
      sendJson(res, 200, { ok: true }, { "set-cookie": createSessionCookie() });
      return;
    }

    if (route === "/logout" && method === "POST") {
      sendJson(res, 200, { ok: true }, { "set-cookie": clearSessionCookie() });
      return;
    }

    if (!authenticated) {
      sendJson(res, 401, { error: "unauthenticated", message: "Sign in first." });
      return;
    }

    if (route === "/tools" && method === "GET") {
      sendJson(res, 200, { tools: toolManifest() });
      return;
    }

    if (route === "/tool" && method === "POST") {
      const body = asObject(await readJsonBody(req, BODY_LIMIT));
      const name = typeof body.name === "string" ? body.name : "";
      const result = await callTool(name, asObject(body.arguments));
      if (!result) {
        sendJson(res, 404, { error: "unknown_tool", message: `Unknown tool "${name}".` });
        return;
      }
      const text = result.content.map((c) => c.text).join("\n");
      let data: unknown = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      sendJson(res, 200, { isError: result.isError ?? false, text, data });
      return;
    }

    if (route === "/mcp-config" && method === "GET") {
      const host = header(req, "host") ?? "localhost";
      const proto = header(req, "x-forwarded-proto") ?? (cfg.isProduction ? "https" : "http");
      const endpoint = `${proto}://${host}/api/mcp`;
      const reveal = new URL(req.url ?? "/", "http://local").searchParams.get("reveal") === "1";
      const token = reveal ? cfg.mcpAuthToken : null;
      sendJson(res, 200, {
        endpoint,
        authConfigured: cfg.mcpAuthToken !== null,
        token,
        command: `claude mcp add --transport http vinted ${endpoint} --header "Authorization: Bearer ${token ?? "<MCP_AUTH_TOKEN>"}"`,
      });
      return;
    }

    if (route === "/accounts" && method === "GET") {
      sendJson(res, 200, {
        accounts: await listAccountSummaries(),
        encryptionKey: cfg.encryptionKey !== null,
        defaultDomain: cfg.defaultDomain,
      });
      return;
    }

    if (route === "/login-log" && method === "GET") {
      sendJson(res, 200, { log: await getLoginLog() });
      return;
    }

    if (route === "/account-login" && method === "POST") {
      const body = asObject(await readJsonBody(req));
      const result = await startLogin({
        ...(typeof body.domain === "string" ? { domain: body.domain } : {}),
        email: typeof body.email === "string" ? body.email : "",
        password: typeof body.password === "string" ? body.password : "",
        ...(typeof body.label === "string" && body.label ? { label: body.label } : {}),
        ...(typeof body.accountId === "string" && body.accountId ? { accountId: body.accountId } : {}),
      });
      sendJson(res, 200, result);
      return;
    }

    if (route === "/account-verify" && method === "POST") {
      const body = asObject(await readJsonBody(req));
      const result = await verifyLogin({
        loginId: typeof body.loginId === "string" ? body.loginId : "",
        code: typeof body.code === "string" ? body.code : "",
      });
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: "not_found", message: `No route ${method} ${route}.` });
  } catch (err) {
    if (err instanceof LoginError) {
      sendJson(res, LOGIN_STATUS[err.kind], { error: err.kind, message: err.message });
      return;
    }
    log.error("panel request failed", { route, message: (err as Error).message });
    sendJson(res, 500, { error: "internal", message: (err as Error).message });
  }
}
