import { createHash, randomBytes } from "node:crypto";
import { getConfig, type VintedAccount } from "../config.js";
import { decryptJson, encryptJson } from "../crypto.js";
import { log } from "../log.js";
import { notify } from "../monitor/notify.js";
import { getStore, keys } from "../store/index.js";
import {
  listAccountSummaries,
  markNeedsLogin,
  saveAccount,
  updateSecrets,
  type AccountSecrets,
  type AccountSummary,
} from "./accounts.js";
import { endpoints } from "./endpoints.js";
import { assertVintedHost, HostError } from "./hosts.js";

/**
 * Connecting a Vinted account with login + password + the code Vinted sends.
 *
 * What this does and does not do:
 *   - The password is used once, in the request to Vinted, and is never
 *     stored, logged or returned. Only the tokens Vinted issues are kept,
 *     encrypted (src/crypto.ts).
 *   - The verification code is always typed by the account owner; this module
 *     only forwards it.
 *   - If Vinted answers with a captcha, a bot-protection page or a rate limit,
 *     the login stops with a clear message. There is deliberately no attempt
 *     to solve, bypass or disguise anything - and no retry loop that would
 *     keep hammering a login endpoint.
 *
 * The request and response field names below are UNVERIFIED (Vinted's login is
 * not a documented API and could not be exercised from the build environment).
 * They live in LOGIN_FIELDS so the first real login can be corrected in one
 * place after comparing with the browser's Network tab.
 */

export const LOGIN_FIELDS = {
  clientId: "web",
  scope: "user",
  /** Keys of the challenge response that must be echoed back with the code. */
  challengeKeys: [
    "two_factor_token",
    "verification_token",
    "control_code",
    "session_id",
    "login_token",
    "challenge_id",
  ],
  /** Request key carrying the code the user typed. */
  codeKey: "verification_code",
} as const;

export type LoginFailure =
  | "bad_credentials"
  | "blocked"
  | "rate_limited"
  | "bad_code"
  | "expired"
  | "invalid_input"
  | "no_encryption"
  | "unexpected";

export class LoginError extends Error {
  constructor(
    readonly kind: LoginFailure,
    message: string,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

export type LoginResult =
  | { status: "connected"; account: AccountSummary; warning: string | null }
  | {
      status: "challenge";
      loginId: string;
      method: string | null;
      hint: string | null;
    };

const MAX_LOGIN_ATTEMPTS_PER_HOUR = 3;
const MAX_CODE_ATTEMPTS = 5;
const CHALLENGE_TTL_SECONDS = 600;

const BLOCK_PATTERN =
  /captcha|datadome|cloudflare|just a moment|access denied|challenge-platform|are you a robot|bot detection|perimeterx/i;

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, unknown> | null;
}

async function postToken(
  domain: string,
  body: Record<string, unknown>,
): Promise<RawResponse> {
  const cfg = getConfig();
  let res: Response;
  try {
    res = await fetch(`https://${domain}${endpoints.oauthToken()}`, {
      method: "POST",
      headers: {
        "user-agent": cfg.userAgent,
        accept: "application/json",
        "content-type": "application/json",
        "accept-language": "pl-PL,pl;q=0.9,en;q=0.8",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LoginError("unexpected", `Network error talking to ${domain}: ${(err as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** True when the answer is a bot-protection or rate-limit response, not an API one. */
export function looksBlocked(res: RawResponse): boolean {
  if (res.status === 429) return true;
  if (res.json) return res.status === 403 && BLOCK_PATTERN.test(res.text);
  // Not JSON: an HTML page where the API should have answered.
  return res.status === 403 || res.status === 503 || BLOCK_PATTERN.test(res.text);
}

const BLOCKED_MESSAGE =
  "Vinted required a bot-protection check (captcha or rate limit) that a server cannot pass. Nothing was bypassed and no further attempts were made - try again later.";

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

interface Tokens {
  secrets: AccountSecrets;
}

function readTokens(res: RawResponse): Tokens | null {
  const json = res.json;
  const accessToken = str(json?.access_token);
  if (res.status < 200 || res.status >= 300 || !accessToken) return null;
  const secrets: AccountSecrets = { accessToken };
  const refresh = str(json?.refresh_token);
  if (refresh) secrets.refreshToken = refresh;
  const expiresIn = Number(json?.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    secrets.expiresAt = Date.now() + expiresIn * 1000;
  }
  const cookie = /_vinted_fr_session=([^;,\s]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (cookie?.[1]) secrets.sessionCookie = cookie[1];
  return { secrets };
}

interface Challenge {
  echo: Record<string, unknown>;
  method: string | null;
  hint: string | null;
}

export function findChallenge(res: RawResponse): Challenge | null {
  const json = res.json;
  if (!json) return null;
  const echo: Record<string, unknown> = {};
  for (const key of LOGIN_FIELDS.challengeKeys) {
    if (json[key] !== undefined) echo[key] = json[key];
  }
  const text = res.text.toLowerCase();
  const mentionsCode = /two.?factor|2fa|verification|one.?time|otp|mfa|sms/.test(text);
  if (Object.keys(echo).length === 0 && !mentionsCode) return null;
  return {
    echo,
    method: /sms|phone|text message/.test(text) ? "sms" : /e-?mail/.test(text) ? "email" : null,
    hint: str(json.phone_hint) ?? str(json.masked_phone) ?? str(json.phone) ?? null,
  };
}

function isBadCredentials(res: RawResponse): boolean {
  const code = str(res.json?.error)?.toLowerCase() ?? "";
  return (
    code === "invalid_grant" ||
    code === "invalid_credentials" ||
    (res.status === 401 && !findChallenge(res))
  );
}

interface UserInfo {
  userId: number | null;
  login: string | null;
  avatarUrl: string | null;
}

async function fetchCurrentUser(
  domain: string,
  secrets: AccountSecrets,
): Promise<UserInfo | null> {
  const cookie = [
    `access_token_web=${secrets.accessToken}`,
    ...(secrets.sessionCookie ? [`_vinted_fr_session=${secrets.sessionCookie}`] : []),
  ].join("; ");
  try {
    const res = await fetch(`https://${domain}${endpoints.currentUser()}`, {
      headers: {
        "user-agent": getConfig().userAgent,
        accept: "application/json",
        cookie,
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      user?: { id?: number; login?: string; photo?: { url?: string } };
    };
    const user = body.user;
    if (!user) return null;
    return {
      userId: typeof user.id === "number" ? user.id : null,
      login: user.login ?? null,
      avatarUrl: user.photo?.url ?? null,
    };
  } catch {
    return null;
  }
}

function maskEmail(email: string): string {
  const [name = "", host = ""] = email.split("@");
  return `${name.slice(0, 1)}***${host ? `@${host}` : ""}`;
}

interface LoginLogEntry {
  at: string;
  domain: string;
  who: string;
  outcome: string;
}

async function logAttempt(domain: string, email: string, outcome: string): Promise<void> {
  const store = getStore();
  const current = (await store.get<LoginLogEntry[]>(keys.loginLog())) ?? [];
  const entry: LoginLogEntry = { at: new Date().toISOString(), domain, who: maskEmail(email), outcome };
  await store.set(keys.loginLog(), [entry, ...current].slice(0, 30), 60 * 60 * 24 * 30);
}

/** Recent login attempts (no passwords, e-mail masked), newest first. */
export async function getLoginLog(): Promise<LoginLogEntry[]> {
  return (await getStore().get<LoginLogEntry[]>(keys.loginLog())) ?? [];
}

function checkDomain(domain: string): string {
  try {
    return assertVintedHost(domain);
  } catch (err) {
    if (err instanceof HostError) throw new LoginError("invalid_input", err.message);
    throw err;
  }
}

interface ChallengeState {
  domain: string;
  email: string;
  label: string | null;
  accountId: string | null;
  echo: Record<string, unknown>;
}

async function finalize(
  domain: string,
  label: string | null,
  accountId: string | null,
  tokens: Tokens,
): Promise<LoginResult> {
  const user = await fetchCurrentUser(domain, tokens.secrets);
  const account = await saveAccount({
    ...(accountId ? { id: accountId } : {}),
    label: label || user?.login || domain,
    domain,
    userId: user?.userId ?? null,
    login: user?.login ?? null,
    avatarUrl: user?.avatarUrl ?? null,
    secrets: tokens.secrets,
  });
  const summary = (await listAccountSummaries()).find((a) => a.id === account.id)!;
  return {
    status: "connected",
    account: summary,
    warning: user
      ? null
      : "Logged in, but the profile could not be read, so the login name and user id are unknown. Run the account test.",
  };
}

export interface LoginInput {
  domain?: string;
  email: string;
  password: string;
  label?: string;
  /** Re-login for an existing panel account. */
  accountId?: string;
}

export async function startLogin(input: LoginInput): Promise<LoginResult> {
  const domain = checkDomain(input.domain ?? getConfig().defaultDomain);
  const email = input.email?.trim() ?? "";
  if (!email || !input.password) {
    throw new LoginError("invalid_input", "Login and password are required.");
  }
  // Refuse before the password goes anywhere if it could not be stored safely.
  if (!getConfig().encryptionKey) {
    throw new LoginError(
      "no_encryption",
      "ENCRYPTION_KEY is not set, so credentials could not be stored safely. Set it in the Vercel project settings first.",
    );
  }

  const store = getStore();
  const hash = createHash("sha256").update(`${domain}|${email.toLowerCase()}`).digest("hex").slice(0, 16);
  const attempts = await store.incr(keys.loginAttempts(hash), 3600);
  if (attempts > MAX_LOGIN_ATTEMPTS_PER_HOUR) {
    await logAttempt(domain, email, "rate_limited");
    throw new LoginError(
      "rate_limited",
      `Too many login attempts for this account (limit ${MAX_LOGIN_ATTEMPTS_PER_HOUR} per hour). Wait before trying again - repeated failures can get the account locked.`,
    );
  }

  const res = await postToken(domain, {
    client_id: LOGIN_FIELDS.clientId,
    scope: LOGIN_FIELDS.scope,
    grant_type: "password",
    username: email,
    password: input.password,
  });

  if (looksBlocked(res)) {
    await logAttempt(domain, email, "blocked");
    throw new LoginError("blocked", BLOCKED_MESSAGE);
  }

  const tokens = readTokens(res);
  if (tokens) {
    await logAttempt(domain, email, "connected");
    return finalize(domain, input.label ?? null, input.accountId ?? null, tokens);
  }

  if (isBadCredentials(res)) {
    await logAttempt(domain, email, "bad_credentials");
    throw new LoginError("bad_credentials", "Vinted rejected the login or password.");
  }

  const challenge = findChallenge(res);
  if (challenge) {
    const loginId = randomBytes(12).toString("hex");
    const state: ChallengeState = {
      domain,
      email,
      label: input.label ?? null,
      accountId: input.accountId ?? null,
      echo: challenge.echo,
    };
    await store.set(keys.loginState(loginId), encryptJson(state), CHALLENGE_TTL_SECONDS);
    await logAttempt(domain, email, "challenge");
    return { status: "challenge", loginId, method: challenge.method, hint: challenge.hint };
  }

  await logAttempt(domain, email, `unexpected_${res.status}`);
  log.warn("unexpected login response", { status: res.status });
  throw new LoginError(
    "unexpected",
    `Vinted answered the login with an unexpected response (HTTP ${res.status}). The login endpoint probably changed - see docs/ACCOUNTS.md.`,
  );
}

export async function verifyLogin(input: { loginId: string; code: string }): Promise<LoginResult> {
  const code = input.code?.trim() ?? "";
  if (!/^[A-Za-z0-9]{4,10}$/.test(code)) {
    throw new LoginError("invalid_input", "The code should be 4-10 letters or digits.");
  }
  const store = getStore();
  const stored = await store.get<string>(keys.loginState(input.loginId));
  if (!stored) {
    throw new LoginError("expired", "This verification expired. Start the login again.");
  }
  const attempts = await store.incr(keys.loginVerifyAttempts(input.loginId), CHALLENGE_TTL_SECONDS);
  if (attempts > MAX_CODE_ATTEMPTS) {
    await store.del(keys.loginState(input.loginId));
    throw new LoginError("rate_limited", "Too many wrong codes. Start the login again.");
  }
  const state = decryptJson<ChallengeState>(stored);

  const res = await postToken(state.domain, {
    client_id: LOGIN_FIELDS.clientId,
    scope: LOGIN_FIELDS.scope,
    grant_type: "password",
    username: state.email,
    ...state.echo,
    [LOGIN_FIELDS.codeKey]: code,
  });

  if (looksBlocked(res)) {
    await store.del(keys.loginState(input.loginId));
    await logAttempt(state.domain, state.email, "blocked_on_code");
    throw new LoginError("blocked", BLOCKED_MESSAGE);
  }
  const tokens = readTokens(res);
  if (tokens) {
    await store.del(keys.loginState(input.loginId));
    await logAttempt(state.domain, state.email, "connected");
    return finalize(state.domain, state.label, state.accountId, tokens);
  }
  await logAttempt(state.domain, state.email, "bad_code");
  throw new LoginError(
    "bad_code",
    str(res.json?.error_description) ?? "Vinted did not accept that code. Check it and try again.",
  );
}

/** Renews a panel account's session from its refresh token. */
export async function refreshSession(account: VintedAccount): Promise<VintedAccount> {
  if (!account.refreshToken) {
    throw new LoginError("expired", "No refresh token stored for this account.");
  }
  const domain = checkDomain(account.domain ?? getConfig().defaultDomain);
  const res = await postToken(domain, {
    client_id: LOGIN_FIELDS.clientId,
    scope: LOGIN_FIELDS.scope,
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
  });
  if (looksBlocked(res)) throw new LoginError("blocked", BLOCKED_MESSAGE);
  const tokens = readTokens(res);
  if (!tokens) {
    throw new LoginError("expired", "Vinted refused to renew the session; a new login is needed.");
  }
  const updated = await updateSecrets(account.id, {
    ...tokens.secrets,
    // Keep the old refresh token if Vinted did not rotate it.
    refreshToken: tokens.secrets.refreshToken ?? account.refreshToken,
  });
  if (!updated) throw new LoginError("expired", "The account no longer exists.");
  return updated;
}

const inflight = new Map<string, Promise<VintedAccount | null>>();

/** Marks the account as needing a login and tells the webhook, once. */
export async function flagNeedsLogin(account: VintedAccount, reason: string): Promise<void> {
  if (account.source !== "panel") return;
  if (await markNeedsLogin(account.id, reason)) {
    await notify(`Konto ${account.label} wymaga ponownego zalogowania w panelu (${reason}).`);
  }
}

/**
 * Called after a 401. Returns a renewed account to retry with, or null when
 * the session cannot be renewed (the account is then flagged for re-login).
 */
export async function recoverAccount(account: VintedAccount): Promise<VintedAccount | null> {
  if (account.source !== "panel") return null;
  if (!account.refreshToken) {
    await flagNeedsLogin(account, "sesja wygasła");
    return null;
  }
  const pending =
    inflight.get(account.id) ??
    refreshSession(account)
      .catch(async (err) => {
        if (err instanceof LoginError && err.kind === "expired") {
          await flagNeedsLogin(account, "sesja wygasła");
        } else {
          log.warn("session refresh failed", { id: account.id, message: (err as Error).message });
        }
        return null;
      })
      .finally(() => inflight.delete(account.id));
  inflight.set(account.id, pending);
  return pending;
}

/** Renews the session ahead of time when it is about to expire. */
export async function freshAccount(account: VintedAccount): Promise<VintedAccount> {
  if (account.source !== "panel" || !account.refreshToken || !account.expiresAt) return account;
  if (account.expiresAt - Date.now() > 5 * 60_000) return account;
  return (await recoverAccount(account)) ?? account;
}
