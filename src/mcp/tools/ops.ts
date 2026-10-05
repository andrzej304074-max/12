import { getConfig } from "../../config.js";
import { purgeAccountData } from "../../monitor/purge.js";
import { getSettings, setAutoActionsEnabled } from "../../settings.js";
import { getStore } from "../../store/index.js";
import {
  AccountError,
  deleteAccount,
  listAccounts,
  listAccountSummaries,
  resolveAccount,
  updateProfile,
} from "../../vinted/accounts.js";
import { getClient, VintedError } from "../../vinted/client.js";
import { endpoints, probeTargets } from "../../vinted/endpoints.js";
import { jsonResult } from "../protocol.js";
import { ArgumentError, optBoolean, optString, requireString, type Tool } from "./types.js";

/** Operational tools: what is connected, does it work, and housekeeping. */

const listAccountsTool: Tool = {
  name: "list_accounts",
  title: "List connected accounts",
  description:
    "Shows which Vinted accounts are connected (from the web panel or VINTED_ACCOUNTS) and whether each session is still valid. Credentials are never returned.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler() {
    const cfg = getConfig();
    const store = getStore();
    return jsonResult({
      accounts: await listAccountSummaries(),
      defaultDomain: cfg.defaultDomain,
      offerDiscountPct: cfg.offerDiscountPct,
      autoActionsEnabled: (await getSettings()).autoActionsEnabled,
      durableStorage: store.durable,
      storageBackend: store.durable ? "upstash-redis" : "in-memory (not persistent)",
    });
  },
};

const diagnoseConnection: Tool = {
  name: "diagnose_connection",
  title: "Diagnose the Vinted connection",
  description:
    "Probes each Vinted read endpoint this server depends on and reports which ones answer. Run it first when a tool starts failing: Vinted's web API is unversioned and paths shift, and this pinpoints which one broke. Optionally verifies an account's credentials too.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      account_id: {
        type: "string",
        description: "Also check this account's credentials.",
      },
      domain: { type: "string", description: "Marketplace host to probe." },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const cfg = getConfig();
    const domain = optString(args, "domain") ?? cfg.defaultDomain;
    const client = getClient();

    const probes: {
      label: string;
      path: string;
      ok: boolean;
      detail: string;
    }[] = [];

    for (const target of probeTargets) {
      try {
        await client.get<unknown>(target.path, {
          domain,
          query: { page: 1, per_page: 1, query: "test", search_text: "test" },
        });
        probes.push({
          label: target.label,
          path: target.path,
          ok: true,
          detail: "responded with JSON",
        });
      } catch (err) {
        const detail =
          err instanceof VintedError
            ? `${err.status ?? "network"}: ${err.message}`
            : (err as Error).message;
        probes.push({ label: target.label, path: target.path, ok: false, detail });
      }
    }

    let accountCheck: { id: string; ok: boolean; detail: string } | null = null;
    const accounts = await listAccounts();
    const accountId = optString(args, "account_id");
    if (accountId || accounts.length === 1) {
      try {
        const account = await resolveAccount(accountId);
        // A cheap authenticated read: the catalog, as this account.
        await client.get<unknown>(probeTargets[0]!.path, {
          account,
          query: { page: 1, per_page: 1 },
        });
        accountCheck = { id: account.id, ok: true, detail: "credentials accepted" };
      } catch (err) {
        accountCheck = {
          id: accountId ?? accounts[0]?.id ?? "unknown",
          ok: false,
          detail: (err as Error).message,
        };
      }
    }

    const failing = probes.filter((p) => !p.ok);
    return jsonResult({
      domain,
      probes,
      accountCheck,
      storage: {
        durable: getStore().durable,
        backend: getStore().durable ? "upstash-redis" : "in-memory",
      },
      verdict:
        failing.length === 0
          ? "All probed endpoints responded."
          : `${failing.length} of ${probes.length} endpoints failed. Update the matching entry in src/vinted/endpoints.ts.`,
    });
  },
};

const testAccount: Tool = {
  name: "test_account",
  title: "Test an account's session",
  description:
    "Checks that the account's session still works by reading its own profile, and fills in the login name and user id when they were missing.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: { account_id: { type: "string", description: "Account to test." } },
    additionalProperties: false,
  },
  async handler(args) {
    const account = await resolveAccount(optString(args, "account_id"));
    try {
      const res = await getClient().get<{
        user?: { id?: number; login?: string; photo?: { url?: string } };
      }>(endpoints.currentUser(), { account });
      const user = res.user;
      if (!user) {
        return jsonResult({ account: account.id, ok: false, detail: "The profile endpoint returned no user - its shape has probably changed." });
      }
      if (account.source === "panel") {
        await updateProfile(account.id, {
          ...(typeof user.id === "number" ? { userId: user.id } : {}),
          ...(user.login ? { login: user.login } : {}),
          ...(user.photo?.url ? { avatarUrl: user.photo.url } : {}),
        });
      }
      return jsonResult({ account: account.id, ok: true, login: user.login ?? null, userId: user.id ?? null });
    } catch (err) {
      return jsonResult({
        account: account.id,
        ok: false,
        detail: (err as Error).message,
        needsLogin: err instanceof VintedError && err.status === 401,
      });
    }
  },
};

const removeAccount: Tool = {
  name: "remove_account",
  title: "Remove a connected account",
  description:
    "Disconnects a panel account and deletes everything stored about it: credentials, watchlist, finds, limits, drafts. Accounts defined in VINTED_ACCOUNTS are removed by editing that variable. Needs confirm: true.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: {
      account_id: { type: "string", description: "Account to remove." },
      confirm: { type: "boolean", description: "Must be true to delete." },
    },
    required: ["account_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await resolveAccount(requireString(args, "account_id"));
    if (account.source !== "panel") {
      throw new AccountError(
        `"${account.id}" comes from VINTED_ACCOUNTS; remove it from that variable in the Vercel project settings.`,
      );
    }
    if (optBoolean(args, "confirm") !== true) {
      return jsonResult({
        preview: true,
        removed: false,
        account: account.id,
        wouldDelete: "credentials, watchlist, finds, limits, drafts and inbox state of this account",
        next: "Call again with confirm: true to remove.",
      });
    }
    await purgeAccountData(account.id);
    await deleteAccount(account.id);
    return jsonResult({ removed: true, account: account.id });
  },
};

const setAutoEnabled: Tool = {
  name: "set_auto_actions_enabled",
  title: "Turn automatic actions on or off",
  description:
    "Master switch for automatic likes and offers on watched sellers. Overrides AUTO_ACTIONS_ENABLED until changed again. Per-seller flags and per-account limits still apply.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: { enabled: { type: "boolean", description: "true to allow automatic actions." } },
    required: ["enabled"],
    additionalProperties: false,
  },
  async handler(args) {
    const enabled = optBoolean(args, "enabled");
    if (enabled === undefined) throw new ArgumentError('"enabled" is required and must be a boolean.');
    return jsonResult(await setAutoActionsEnabled(enabled));
  },
};

export const opsTools: Tool[] = [
  listAccountsTool,
  diagnoseConnection,
  testAccount,
  removeAccount,
  setAutoEnabled,
];
