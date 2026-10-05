import { createHash, createHmac } from "node:crypto";
import { safeEqual } from "./auth.js";
import { getConfig } from "./config.js";
import { getStore, keys } from "./store/index.js";

/**
 * Sign-in for the web panel: one administrator password, a signed session
 * cookie, and a lockout after repeated wrong passwords.
 */

export const SESSION_COOKIE = "vs_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const MAX_FAILURES = 5;
const LOCKOUT_SECONDS = 15 * 60;

function signingKey(): Buffer | null {
  const cfg = getConfig();
  if (cfg.sessionSecret) return Buffer.from(cfg.sessionSecret, "utf8");
  if (cfg.adminPassword) {
    return createHash("sha256").update(`panel-session|${cfg.adminPassword}`).digest();
  }
  return null;
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Compares passwords without leaking length or position of a mismatch. */
export function checkPassword(candidate: string): boolean {
  const expected = getConfig().adminPassword;
  if (!expected) return false;
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  return safeEqual(hash(candidate), hash(expected));
}

function cookieAttributes(maxAge: number): string {
  const secure = getConfig().isProduction ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function createSessionCookie(now = Date.now()): string {
  const key = signingKey();
  if (!key) throw new Error("The panel is disabled: ADMIN_PASSWORD is not set.");
  const payload = Buffer.from(
    JSON.stringify({ exp: now + SESSION_SECONDS * 1000 }),
  ).toString("base64url");
  return `${SESSION_COOKIE}=${payload}.${sign(payload, key)}; ${cookieAttributes(SESSION_SECONDS)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(0)}`;
}

export function verifySession(cookieHeader: string | undefined, now = Date.now()): boolean {
  const key = signingKey();
  if (!key || !cookieHeader) return false;
  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return false;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload, key))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof exp === "number" && exp > now;
  } catch {
    return false;
  }
}

export async function isLockedOut(ip: string): Promise<boolean> {
  const failures = await getStore().get<number>(keys.panelFails(ip));
  return (failures ?? 0) >= MAX_FAILURES;
}

export async function registerFailure(ip: string): Promise<void> {
  await getStore().incr(keys.panelFails(ip), LOCKOUT_SECONDS);
}

export async function clearFailures(ip: string): Promise<void> {
  await getStore().del(keys.panelFails(ip));
}
