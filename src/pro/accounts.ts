import { randomBytes } from "node:crypto";
import { CryptoError, decryptJson, encryptJson } from "../crypto.js";
import { getStore, keys } from "../store/index.js";
import { ProError, ProInputError } from "./errors.js";
import { isProEnv, PRO_ENVS, type ProEnv } from "./hosts.js";
import { parseToken, type ProCredentials } from "./signing.js";

/**
 * Vinted Pro accounts.
 *
 * They live in their own registry, apart from the consumer accounts of the
 * unofficial API: the two have nothing in common (a signed API token against a
 * session cookie) and the monitor that walks consumer accounts must never meet
 * a Pro one. Ids always start with "pro-".
 *
 * The token (access key and signing key) is stored AES-encrypted and is
 * returned by nothing: not by a summary, a tool, a route or a log line.
 */

export type ProStatus = "connected" | "rejected";

interface WebhookRecord {
  /** Vinted's id of the registration, once known. */
  id: string | null;
  url: string;
  events: string[];
  registeredAt: string;
  /** Encrypted: the key Vinted signs this webhook's deliveries with. */
  signingKey: string | null;
}

interface ProAccountRecord {
  id: string;
  label: string;
  env: ProEnv;
  createdAt: string;
  tokenSetAt: string;
  status: ProStatus;
  statusReason: string | null;
  lastOkAt: string | null;
  /** Encrypted ProCredentials. */
  secrets: string;
  webhook: WebhookRecord | null;
}

/** An account with its credentials, for the client only. */
export interface ProAccount extends ProCredentials {
  id: string;
  label: string;
  env: ProEnv;
  status: ProStatus;
  statusReason: string | null;
  lastOkAt: string | null;
}

/** What may leave the server. */
export interface ProAccountSummary {
  id: string;
  label: string;
  env: ProEnv;
  status: ProStatus;
  statusReason: string | null;
  createdAt: string;
  tokenSetAt: string;
  lastOkAt: string | null;
  webhook: { registered: boolean; url: string | null; events: string[] };
}

function slug(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return base || "konto";
}

function summarise(rec: ProAccountRecord): ProAccountSummary {
  return {
    id: rec.id,
    label: rec.label,
    env: rec.env,
    status: rec.status,
    statusReason: rec.statusReason,
    createdAt: rec.createdAt,
    tokenSetAt: rec.tokenSetAt,
    lastOkAt: rec.lastOkAt,
    webhook: {
      registered: rec.webhook !== null,
      url: rec.webhook?.url ?? null,
      events: rec.webhook?.events ?? [],
    },
  };
}

async function readRecords(): Promise<ProAccountRecord[]> {
  const store = getStore();
  const records: ProAccountRecord[] = [];
  for (const id of await store.smembers(keys.proAccountIds())) {
    const rec = await store.get<ProAccountRecord>(keys.proAccount(id));
    if (rec) records.push(rec);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listProAccounts(): Promise<ProAccountSummary[]> {
  return (await readRecords()).map(summarise);
}

export interface NewProAccount {
  /** Replace the token of this existing account instead of creating one. */
  id?: string;
  label: string;
  env: ProEnv;
  /** The portal's `<access_key>,<signing_key>` string. */
  token: string;
}

/** Creates an account, or replaces the token (and environment) of one. */
export async function saveProAccount(input: NewProAccount): Promise<ProAccountSummary> {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label || label.length > 60) {
    throw new ProInputError("Give the account a name of 1 to 60 characters.");
  }
  if (!isProEnv(input.env)) {
    throw new ProInputError(`The environment must be one of: ${PRO_ENVS.join(", ")}.`);
  }
  const creds = parseToken(input.token);

  const store = getStore();
  const now = new Date().toISOString();
  let id = input.id;
  let createdAt = now;
  let webhook: WebhookRecord | null = null;

  if (id) {
    const existing = await store.get<ProAccountRecord>(keys.proAccount(id));
    if (!existing) throw new ProInputError(`Unknown Vinted Pro account "${id}".`);
    createdAt = existing.createdAt;
    // A webhook registered for the other environment is of no use to the new token.
    webhook = existing.env === input.env ? existing.webhook : null;
  } else {
    const taken = new Set(await store.smembers(keys.proAccountIds()));
    const base = `pro-${slug(label)}`;
    id = base;
    while (taken.has(id)) id = `${base}-${randomBytes(2).toString("hex")}`;
  }

  const record: ProAccountRecord = {
    id,
    label,
    env: input.env,
    createdAt,
    tokenSetAt: now,
    status: "connected",
    statusReason: null,
    lastOkAt: null,
    secrets: encryptJson(creds),
    webhook,
  };
  await store.set(keys.proAccount(id), record);
  await store.sadd(keys.proAccountIds(), id);
  return summarise(record);
}

function toAccount(rec: ProAccountRecord): ProAccount {
  let creds: ProCredentials;
  try {
    creds = decryptJson<ProCredentials>(rec.secrets);
  } catch (err) {
    if (err instanceof CryptoError) {
      throw new ProError(
        `The stored token of "${rec.id}" cannot be read (${err.message}). Add the token again in the panel.`,
        "config",
      );
    }
    throw err;
  }
  return {
    id: rec.id,
    label: rec.label,
    env: rec.env,
    status: rec.status,
    statusReason: rec.statusReason,
    lastOkAt: rec.lastOkAt,
    accessKey: creds.accessKey,
    signingKey: creds.signingKey,
  };
}

/** The account a tool acts as; implied when exactly one is connected. */
export async function getProAccount(id?: string): Promise<ProAccount> {
  const records = await readRecords();
  if (records.length === 0) {
    throw new ProError(
      "No Vinted Pro account is connected. Add one in the panel (Konta → Vinted Pro).",
      "config",
    );
  }
  if (!id) {
    if (records.length === 1) return toAccount(records[0]!);
    throw new ProError(
      `Several Vinted Pro accounts are connected (${records.map((r) => r.id).join(", ")}); pass "account_id".`,
      "config",
    );
  }
  const found = records.find((r) => r.id === id);
  if (!found) {
    throw new ProError(
      `Unknown Vinted Pro account "${id}". Connected: ${records.map((r) => r.id).join(", ")}.`,
      "config",
    );
  }
  return toAccount(found);
}

/** Secret-free view of one account, or null. */
export async function describeProAccount(id: string): Promise<ProAccountSummary | null> {
  const rec = await getStore().get<ProAccountRecord>(keys.proAccount(id));
  return rec ? summarise(rec) : null;
}

/** The token was refused: show it in the panel and stop pretending it works. */
export async function markProRejected(id: string, reason: string): Promise<void> {
  const store = getStore();
  const rec = await store.get<ProAccountRecord>(keys.proAccount(id));
  if (!rec || (rec.status === "rejected" && rec.statusReason === reason)) return;
  await store.set(keys.proAccount(id), { ...rec, status: "rejected", statusReason: reason });
}

const OK_REFRESH_MS = 60 * 60 * 1000;

/** A request succeeded. Writes only when something actually changes. */
export async function markProOk(account: ProAccount): Promise<void> {
  const stale = !account.lastOkAt || Date.now() - Date.parse(account.lastOkAt) > OK_REFRESH_MS;
  if (account.status === "connected" && !stale) return;
  const store = getStore();
  const rec = await store.get<ProAccountRecord>(keys.proAccount(account.id));
  if (!rec) return;
  await store.set(keys.proAccount(account.id), {
    ...rec,
    status: "connected",
    statusReason: null,
    lastOkAt: new Date().toISOString(),
  });
}

export interface WebhookRegistration {
  id: string | null;
  url: string;
  events: string[];
  /** Plain signing key returned by Vinted when the webhook was created. */
  signingKey: string | null;
}

export async function setProWebhook(id: string, reg: WebhookRegistration): Promise<void> {
  const store = getStore();
  const rec = await store.get<ProAccountRecord>(keys.proAccount(id));
  if (!rec) throw new ProInputError(`Unknown Vinted Pro account "${id}".`);
  await store.set(keys.proAccount(id), {
    ...rec,
    webhook: {
      id: reg.id,
      url: reg.url,
      events: reg.events,
      registeredAt: new Date().toISOString(),
      signingKey: reg.signingKey ? encryptJson(reg.signingKey) : null,
    },
  });
}

export async function clearProWebhook(id: string): Promise<void> {
  const store = getStore();
  const rec = await store.get<ProAccountRecord>(keys.proAccount(id));
  if (!rec || !rec.webhook) return;
  await store.set(keys.proAccount(id), { ...rec, webhook: null });
}

/** Vinted's id of the registered webhook, if one is recorded. */
export async function getProWebhookId(id: string): Promise<string | null> {
  const rec = await getStore().get<ProAccountRecord>(keys.proAccount(id));
  return rec?.webhook?.id ?? null;
}

/**
 * The webhook signing keys of every account, for the receiver: it has to find
 * out which account a delivery belongs to by trying the keys.
 */
export async function listWebhookSecrets(): Promise<{ accountId: string; signingKey: string }[]> {
  const out: { accountId: string; signingKey: string }[] = [];
  for (const rec of await readRecords()) {
    if (!rec.webhook?.signingKey) continue;
    try {
      out.push({ accountId: rec.id, signingKey: decryptJson<string>(rec.webhook.signingKey) });
    } catch {
      // An unreadable key can verify nothing; the receiver will reject its deliveries.
    }
  }
  return out;
}

/** Deletes an account and everything kept about it. */
export async function deleteProAccount(id: string): Promise<boolean> {
  const store = getStore();
  const rec = await store.get<ProAccountRecord>(keys.proAccount(id));
  if (!rec) return false;
  await store.del(keys.proAccount(id));
  await store.srem(keys.proAccountIds(), id);
  for (const key of [keys.proOntology(id), keys.proEvents(id), keys.proActions(id), keys.proItems(id)]) {
    await store.del(key);
  }
  return true;
}
