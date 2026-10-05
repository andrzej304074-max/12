import { getConfig } from "../config.js";
import { ProError, ProInputError } from "./errors.js";

/**
 * Where the signed requests may go.
 *
 * The signing key never leaves this server, but a signed request is still a
 * credential: it must only ever be sent to Vinted's two documented hosts.
 * Overrides exist for tests and local demos; in production they are accepted
 * only for hosts under vinted.com.
 */

export type ProEnv = "sandbox" | "production";

export const PRO_ENVS: readonly ProEnv[] = ["sandbox", "production"];

export const PRO_BASE_URLS: Record<ProEnv, string> = {
  production: "https://pro.svc.vinted.com",
  sandbox: "https://pro-public-sandbox.svc.vinted.com",
};

export function isProEnv(value: unknown): value is ProEnv {
  return value === "sandbox" || value === "production";
}

export function proBaseUrl(env: ProEnv): string {
  const cfg = getConfig();
  const override = env === "sandbox" ? cfg.pro.baseUrlSandbox : cfg.pro.baseUrlProduction;
  if (!override) return PRO_BASE_URLS[env];

  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new ProError(`The ${env} base URL override is not a valid URL.`, "config");
  }
  if (cfg.isProduction && (url.protocol !== "https:" || !/(^|\.)vinted\.com$/i.test(url.hostname))) {
    throw new ProError(
      `The ${env} base URL override must be an https address under vinted.com when running in production.`,
      "config",
    );
  }
  return `${url.protocol}//${url.host}`;
}

/** Ids that end up inside a request path: no slashes, dots or anything clever. */
export function safeId(value: string, what = "id"): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new ProInputError(`"${what}" may only contain letters, digits, "-" and "_" (up to 64 characters).`);
  }
  return value;
}

/** A path the integration is allowed to call, checked before it is signed. */
export function assertProPath(path: string): string {
  if (!/^\/(api|dev)\/v\d{1,2}\/[A-Za-z0-9._~\-/]*$/.test(path) || /(^|\/)\.\.?(\/|$)/.test(path) || path.includes("//")) {
    throw new ProInputError(`"${path}" is not a Vinted Pro API path (expected /api/v1/... or /api/v2/...).`);
  }
  return path;
}
