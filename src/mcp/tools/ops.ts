import { getConfig } from "../../config.js";
import { getStore } from "../../store/index.js";
import { describeAccount, resolveAccount } from "../../vinted/accounts.js";
import { getClient, VintedError } from "../../vinted/client.js";
import { probeTargets } from "../../vinted/endpoints.js";
import { jsonResult } from "../protocol.js";
import { optString, type Tool } from "./types.js";

/** Operational tools: what is configured, and does it actually work. */

const listAccounts: Tool = {
  name: "list_accounts",
  title: "List configured accounts",
  description:
    "Shows which Vinted accounts this deployment is wired to. Access tokens are never returned.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler() {
    const cfg = getConfig();
    const store = getStore();
    return jsonResult({
      accounts: cfg.accounts.map(describeAccount),
      defaultDomain: cfg.defaultDomain,
      offerDiscountPct: cfg.offerDiscountPct,
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
    const accountId = optString(args, "account_id");
    if (accountId || cfg.accounts.length === 1) {
      try {
        const account = resolveAccount(accountId);
        // A cheap authenticated read: the catalog, as this account.
        await client.get<unknown>(probeTargets[0]!.path, {
          account,
          query: { page: 1, per_page: 1 },
        });
        accountCheck = { id: account.id, ok: true, detail: "credentials accepted" };
      } catch (err) {
        accountCheck = {
          id: accountId ?? cfg.accounts[0]?.id ?? "unknown",
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

export const opsTools: Tool[] = [listAccounts, diagnoseConnection];
