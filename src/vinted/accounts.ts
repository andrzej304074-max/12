import { getConfig, type VintedAccount } from "../config.js";

/**
 * Account selection.
 *
 * Several Vinted accounts can be wired to one deployment. Tools name the one
 * they act as; when only a single account is configured it is implied, which
 * keeps the common case free of ceremony.
 */

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

export function resolveAccount(accountId: string | undefined): VintedAccount {
  const { accounts } = getConfig();
  if (accounts.length === 0) {
    throw new AccountError(
      "No Vinted accounts are configured. Set VINTED_ACCOUNTS in the Vercel project settings - see .env.example.",
    );
  }
  if (!accountId) {
    if (accounts.length === 1) return accounts[0]!;
    throw new AccountError(
      `Several accounts are configured (${accounts
        .map((a) => a.id)
        .join(", ")}); pass "account_id" to choose one.`,
    );
  }
  const found = accounts.find((a) => a.id === accountId);
  if (!found) {
    throw new AccountError(
      `Unknown account "${accountId}". Configured accounts: ${accounts
        .map((a) => a.id)
        .join(", ")}.`,
    );
  }
  return found;
}

/** Account summary safe to return to a client - never includes the token. */
export function describeAccount(account: VintedAccount): {
  id: string;
  label: string;
  domain: string;
  userId: number | null;
} {
  return {
    id: account.id,
    label: account.label,
    domain: account.domain ?? getConfig().defaultDomain,
    userId: account.userId ?? null,
  };
}
