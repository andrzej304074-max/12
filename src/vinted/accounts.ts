import { randomBytes } from "node:crypto";
import { getConfig, type VintedAccount } from "../config.js";
import { decryptJson, encryptJson } from "../crypto.js";
import { log } from "../log.js";
import { getStore, keys } from "../store/index.js";

/**
 * Accounts.
 *
 * Two sources feed one list: accounts defined in VINTED_ACCOUNTS (read-only,
 * "env") and accounts connected through the panel ("panel"), whose credentials
 * are stored AES-encrypted. Tools name the account they act as; when only one
 * exists it is implied.
 *
 * Passwords are never stored - only the tokens Vinted issued after login.
 */

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

/** The secret part of a panel account, stored encrypted as one blob. */
export interface AccountSecrets {
  accessToken: string;
  refreshToken?: string;
  sessionCookie?: string;
  csrfToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

interface AccountRecord {
  id: string;
  label: string;
  domain: string;
  userId: number | null;
  login: string | null;
  avatarUrl: string | null;
  createdAt: string;
  tokenSetAt: string;
  status: "connected" | "needs_login";
  statusReason: string | null;
  /** Encrypted AccountSecrets. */
  secrets: string;
}

export interface AccountSummary {
  id: string;
  label: string;
  domain: string;
  userId: number | null;
  login: string | null;
  avatarUrl: string | null;
  source: "env" | "panel";
  status: "connected" | "needs_login";
  statusReason: string | null;
  tokenSetAt: string | null;
}

function fromRecord(rec: AccountRecord): VintedAccount {
  let secrets: AccountSecrets | null = null;
  try {
    secrets = decryptJson<AccountSecrets>(rec.secrets);
  } catch (err) {
    log.warn("account credentials unreadable", { id: rec.id, message: (err as Error).message });
  }
  const account: VintedAccount = {
    id: rec.id,
    label: rec.label,
    accessToken: secrets?.accessToken ?? "",
    domain: rec.domain,
    source: "panel",
    status: secrets ? rec.status : "needs_login",
  };
  if (secrets?.refreshToken) account.refreshToken = secrets.refreshToken;
  if (secrets?.sessionCookie) account.sessionCookie = secrets.sessionCookie;
  if (secrets?.csrfToken) account.csrfToken = secrets.csrfToken;
  if (secrets?.expiresAt) account.expiresAt = secrets.expiresAt;
  if (rec.userId !== null) account.userId = rec.userId;
  if (rec.login) account.login = rec.login;
  if (rec.avatarUrl) account.avatarUrl = rec.avatarUrl;
  return account;
}

async function readRecords(): Promise<AccountRecord[]> {
  const store = getStore();
  const records: AccountRecord[] = [];
  for (const id of await store.smembers(keys.accountIds())) {
    const rec = await store.get<AccountRecord>(keys.account(id));
    if (rec) records.push(rec);
  }
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return records;
}

/** Every account the server can act as: env accounts first, then panel ones. */
export async function listAccounts(): Promise<VintedAccount[]> {
  const env = getConfig().accounts;
  const taken = new Set(env.map((a) => a.id));
  const panel = (await readRecords())
    .filter((rec) => !taken.has(rec.id))
    .map(fromRecord);
  return [...env, ...panel];
}

export async function resolveAccount(
  accountId: string | undefined,
): Promise<VintedAccount> {
  const accounts = await listAccounts();
  if (accounts.length === 0) {
    throw new AccountError(
      "No Vinted accounts are connected. Add one in the web panel (Accounts tab).",
    );
  }
  if (!accountId) {
    if (accounts.length === 1) return accounts[0]!;
    throw new AccountError(
      `Several accounts are connected (${accounts
        .map((a) => a.id)
        .join(", ")}); pass "account_id" to choose one.`,
    );
  }
  const found = accounts.find((a) => a.id === accountId);
  if (!found) {
    throw new AccountError(
      `Unknown account "${accountId}". Connected accounts: ${accounts
        .map((a) => a.id)
        .join(", ")}.`,
    );
  }
  return found;
}

/** Account summary safe to return to a client - never includes credentials. */
export function describeAccount(account: VintedAccount): AccountSummary {
  return {
    id: account.id,
    label: account.label,
    domain: account.domain ?? getConfig().defaultDomain,
    userId: account.userId ?? null,
    login: account.login ?? null,
    avatarUrl: account.avatarUrl ?? null,
    source: account.source ?? "env",
    status: account.status ?? "connected",
    statusReason: null,
    tokenSetAt: null,
  };
}

export async function listAccountSummaries(): Promise<AccountSummary[]> {
  const env = getConfig().accounts.map(describeAccount);
  const taken = new Set(env.map((a) => a.id));
  const panel = (await readRecords())
    .filter((rec) => !taken.has(rec.id))
    .map<AccountSummary>((rec) => ({
      id: rec.id,
      label: rec.label,
      domain: rec.domain,
      userId: rec.userId,
      login: rec.login,
      avatarUrl: rec.avatarUrl,
      source: "panel",
      status: rec.status,
      statusReason: rec.statusReason,
      tokenSetAt: rec.tokenSetAt,
    }));
  return [...env, ...panel];
}

function slug(text: string): string {
  const base = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return base || "konto";
}

export interface NewAccount {
  /** Reuse an existing panel account (re-login) instead of creating one. */
  id?: string;
  label: string;
  domain: string;
  userId: number | null;
  login: string | null;
  avatarUrl: string | null;
  secrets: AccountSecrets;
}

/** Creates or replaces a panel account and returns it. */
export async function saveAccount(input: NewAccount): Promise<VintedAccount> {
  const store = getStore();
  const now = new Date().toISOString();
  let id = input.id;
  let createdAt = now;

  if (id) {
    const existing = await store.get<AccountRecord>(keys.account(id));
    if (!existing) throw new AccountError(`Unknown panel account "${id}".`);
    createdAt = existing.createdAt;
  } else {
    const taken = new Set([
      ...getConfig().accounts.map((a) => a.id),
      ...(await store.smembers(keys.accountIds())),
    ]);
    const base = slug(input.login ?? input.label);
    id = base;
    while (taken.has(id)) id = `${base}-${randomBytes(2).toString("hex")}`;
  }

  const record: AccountRecord = {
    id,
    label: input.label,
    domain: input.domain,
    userId: input.userId,
    login: input.login,
    avatarUrl: input.avatarUrl,
    createdAt,
    tokenSetAt: now,
    status: "connected",
    statusReason: null,
    secrets: encryptJson(input.secrets),
  };
  await store.set(keys.account(id), record);
  await store.sadd(keys.accountIds(), id);
  return fromRecord(record);
}

/** Merges new secrets (for example a refreshed token) into a panel account. */
export async function updateSecrets(
  id: string,
  patch: Partial<AccountSecrets>,
): Promise<VintedAccount | null> {
  const store = getStore();
  const rec = await store.get<AccountRecord>(keys.account(id));
  if (!rec) return null;
  const current = decryptJson<AccountSecrets>(rec.secrets);
  const next: AccountRecord = {
    ...rec,
    tokenSetAt: new Date().toISOString(),
    status: "connected",
    statusReason: null,
    secrets: encryptJson({ ...current, ...patch }),
  };
  await store.set(keys.account(id), next);
  return fromRecord(next);
}

/** Fills in profile fields learned after connecting. */
export async function updateProfile(
  id: string,
  patch: { userId?: number; login?: string; avatarUrl?: string },
): Promise<void> {
  const store = getStore();
  const rec = await store.get<AccountRecord>(keys.account(id));
  if (!rec) return;
  await store.set(keys.account(id), {
    ...rec,
    userId: patch.userId ?? rec.userId,
    login: patch.login ?? rec.login,
    avatarUrl: patch.avatarUrl ?? rec.avatarUrl,
  });
}

/** Returns true when the status actually changed. */
export async function markNeedsLogin(id: string, reason: string): Promise<boolean> {
  const store = getStore();
  const rec = await store.get<AccountRecord>(keys.account(id));
  if (!rec || rec.status === "needs_login") return false;
  await store.set(keys.account(id), { ...rec, status: "needs_login", statusReason: reason });
  return true;
}

/** Removes a panel account's record. Related data is purged separately. */
export async function deleteAccount(id: string): Promise<boolean> {
  const store = getStore();
  const rec = await store.get<AccountRecord>(keys.account(id));
  if (!rec) return false;
  await store.del(keys.account(id));
  await store.srem(keys.accountIds(), id);
  return true;
}
