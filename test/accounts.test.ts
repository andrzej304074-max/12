import { beforeEach, describe, expect, it } from "vitest";
import { getStore, keys } from "../src/store/index.js";
import {
  AccountError,
  deleteAccount,
  describeAccount,
  listAccounts,
  listAccountSummaries,
  markNeedsLogin,
  resolveAccount,
  saveAccount,
  updateSecrets,
} from "../src/vinted/accounts.js";
import { freshEnv } from "./helpers.js";

const NEW = {
  label: "Moj sklep",
  domain: "www.vinted.pl",
  userId: 42,
  login: "ala",
  avatarUrl: null,
  secrets: { accessToken: "access-secret-123", refreshToken: "refresh-secret-456", expiresAt: Date.now() + 3_600_000 },
};

beforeEach(() => freshEnv());

describe("panel accounts", () => {
  it("saves an account and lists it with its decrypted credentials", async () => {
    const saved = await saveAccount(NEW);
    expect(saved.id).toBe("ala");
    const [account] = await listAccounts();
    expect(account).toMatchObject({ id: "ala", accessToken: "access-secret-123", refreshToken: "refresh-secret-456", source: "panel", userId: 42 });
  });

  it("never stores credentials in plaintext", async () => {
    await saveAccount(NEW);
    const raw = JSON.stringify(await getStore().get(keys.account("ala")));
    expect(raw).not.toContain("access-secret-123");
    expect(raw).not.toContain("refresh-secret-456");
  });

  it("never returns credentials in summaries", async () => {
    await saveAccount(NEW);
    const summaries = JSON.stringify(await listAccountSummaries());
    expect(summaries).not.toContain("access-secret-123");
    expect(summaries).not.toContain("refresh-secret-456");
    expect(JSON.stringify(describeAccount((await listAccounts())[0]!))).not.toContain("secret");
  });

  it("gives a second account with the same login a distinct id", async () => {
    const a = await saveAccount(NEW);
    const b = await saveAccount(NEW);
    expect(a.id).not.toBe(b.id);
  });

  it("does not let a panel account take an env account's id", async () => {
    freshEnv({ VINTED_ACCOUNTS: JSON.stringify([{ id: "ala", accessToken: "env-token" }]) });
    const saved = await saveAccount(NEW);
    expect(saved.id).not.toBe("ala");
    expect((await listAccounts()).find((a) => a.id === "ala")!.source).toBe("env");
  });

  it("lists env accounts before panel accounts", async () => {
    freshEnv({ VINTED_ACCOUNTS: JSON.stringify([{ id: "env1", accessToken: "t" }]) });
    await saveAccount(NEW);
    expect((await listAccounts()).map((a) => a.source)).toEqual(["env", "panel"]);
  });

  it("re-login keeps the id and replaces the credentials", async () => {
    const first = await saveAccount(NEW);
    await markNeedsLogin(first.id, "expired");
    await saveAccount({ ...NEW, id: first.id, secrets: { accessToken: "brand-new-token" } });
    const account = await resolveAccount(first.id);
    expect(account.accessToken).toBe("brand-new-token");
    expect(account.status).toBe("connected");
  });

  it("refuses a re-login for an unknown account", async () => {
    await expect(saveAccount({ ...NEW, id: "ghost" })).rejects.toBeInstanceOf(AccountError);
  });

  it("merges refreshed secrets and keeps the rest", async () => {
    await saveAccount(NEW);
    await updateSecrets("ala", { accessToken: "rotated" });
    const account = await resolveAccount("ala");
    expect(account.accessToken).toBe("rotated");
    expect(account.refreshToken).toBe("refresh-secret-456");
  });

  it("flags needs_login once and reports whether it changed", async () => {
    await saveAccount(NEW);
    expect(await markNeedsLogin("ala", "expired")).toBe(true);
    expect(await markNeedsLogin("ala", "expired")).toBe(false);
    expect((await resolveAccount("ala")).status).toBe("needs_login");
  });

  it("deletes an account", async () => {
    await saveAccount(NEW);
    expect(await deleteAccount("ala")).toBe(true);
    expect(await listAccounts()).toEqual([]);
    expect(await deleteAccount("ala")).toBe(false);
  });

  it("flags an account whose credentials cannot be decrypted", async () => {
    await saveAccount(NEW);
    process.env.ENCRYPTION_KEY = "cd".repeat(32);
    const { resetConfigCache } = await import("../src/config.js");
    resetConfigCache();
    const [account] = await listAccounts();
    expect(account!.status).toBe("needs_login");
    expect(account!.accessToken).toBe("");
  });
});

describe("resolveAccount", () => {
  it("explains how to add an account when there are none", async () => {
    await expect(resolveAccount(undefined)).rejects.toThrow(/web panel/);
  });

  it("implies the only account", async () => {
    await saveAccount(NEW);
    expect((await resolveAccount(undefined)).id).toBe("ala");
  });

  it("demands an id when there are several", async () => {
    await saveAccount(NEW);
    await saveAccount({ ...NEW, login: "ola" });
    await expect(resolveAccount(undefined)).rejects.toThrow(/account_id/);
  });

  it("rejects an unknown id", async () => {
    await saveAccount(NEW);
    await expect(resolveAccount("nope")).rejects.toThrow(/Unknown account/);
  });
});
