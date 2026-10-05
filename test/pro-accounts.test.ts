import { describe, expect, it } from "vitest";
import { resetConfigCache } from "../src/config.js";
import {
  clearProWebhook,
  deleteProAccount,
  describeProAccount,
  getProAccount,
  listProAccounts,
  listWebhookSecrets,
  markProOk,
  markProRejected,
  saveProAccount,
  setProWebhook,
} from "../src/pro/accounts.js";
import { CryptoError } from "../src/crypto.js";
import { ProError, ProInputError } from "../src/pro/errors.js";
import { getStore, keys } from "../src/store/index.js";
import { ACCESS_KEY, PRO_TOKEN, setupPro, SIGNING_KEY } from "./pro-helpers.js";

describe("saving an account", () => {
  it("stores the token encrypted and returns a summary without it", async () => {
    setupPro();
    const summary = await saveProAccount({ label: "Sklep główny", env: "sandbox", token: PRO_TOKEN });
    expect(summary.id).toBe("pro-sklep-glowny");
    expect(summary).toMatchObject({ label: "Sklep główny", env: "sandbox", status: "connected", lastOkAt: null });
    expect(summary.webhook).toEqual({ registered: false, url: null, events: [] });
    expect(JSON.stringify(summary)).not.toContain(SIGNING_KEY);
    expect(JSON.stringify(summary)).not.toContain(ACCESS_KEY);

    const stored = JSON.stringify(await getStore().get(keys.proAccount(summary.id)));
    expect(stored).not.toContain(SIGNING_KEY);
    expect(stored).not.toContain(ACCESS_KEY);
    expect(stored).toContain('"secrets":"v1.');
  });

  it("keeps ids unique and always prefixed with pro-", async () => {
    setupPro();
    const a = await saveProAccount({ label: "Sklep", env: "sandbox", token: PRO_TOKEN });
    const b = await saveProAccount({ label: "Sklep", env: "production", token: "OTHER,KEYS" });
    expect(a.id).toBe("pro-sklep");
    expect(b.id).toMatch(/^pro-sklep-[0-9a-f]{4}$/);
    expect((await listProAccounts()).map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it("refuses bad input with an error the caller can act on", async () => {
    setupPro();
    await expect(saveProAccount({ label: "", env: "sandbox", token: PRO_TOKEN })).rejects.toThrow(ProInputError);
    await expect(saveProAccount({ label: "x".repeat(61), env: "sandbox", token: PRO_TOKEN })).rejects.toThrow(/1 to 60/);
    await expect(saveProAccount({ label: "A", env: "staging" as never, token: PRO_TOKEN })).rejects.toThrow(/sandbox, production/);
    await expect(saveProAccount({ label: "A", env: "sandbox", token: "no-comma" })).rejects.toThrow(ProInputError);
    await expect(saveProAccount({ label: "A", env: "sandbox", id: "pro-nope", token: PRO_TOKEN })).rejects.toThrow(/Unknown/);
    expect(await listProAccounts()).toEqual([]);
  });

  it("will not store a token without ENCRYPTION_KEY", async () => {
    setupPro({ ENCRYPTION_KEY: undefined });
    await expect(saveProAccount({ label: "A", env: "sandbox", token: PRO_TOKEN })).rejects.toThrow(CryptoError);
    expect(await listProAccounts()).toEqual([]);
  });

  it("replaces the token of an existing account, keeping its id, and clears a rejection", async () => {
    setupPro();
    const first = await saveProAccount({ label: "Sklep", env: "sandbox", token: PRO_TOKEN });
    await markProRejected(first.id, "token rejected (401)");
    const second = await saveProAccount({ id: first.id, label: "Sklep", env: "sandbox", token: `${ACCESS_KEY},new-signing` });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.status).toBe("connected");
    expect((await getProAccount(first.id)).signingKey).toBe("new-signing");
  });

  it("drops a webhook registered for the other environment when the environment changes", async () => {
    setupPro();
    const first = await saveProAccount({ label: "Sklep", env: "sandbox", token: PRO_TOKEN });
    await setProWebhook(first.id, { id: "wh_1", url: "https://panel.example/api/pro/webhook", events: ["ITEM_SOLD"], signingKey: "whsec_a" });
    const same = await saveProAccount({ id: first.id, label: "Sklep", env: "sandbox", token: PRO_TOKEN });
    expect(same.webhook.registered).toBe(true);
    const moved = await saveProAccount({ id: first.id, label: "Sklep", env: "production", token: PRO_TOKEN });
    expect(moved.webhook.registered).toBe(false);
  });
});

describe("choosing the account a tool acts as", () => {
  it("explains what to do when none is connected", async () => {
    setupPro();
    const err = await getProAccount().catch((e) => e as ProError);
    expect(err).toBeInstanceOf(ProError);
    expect((err as ProError).kind).toBe("config");
    expect((err as ProError).message).toMatch(/Konta/);
  });

  it("implies the only account, asks for an id when there are several, rejects an unknown id", async () => {
    setupPro();
    const a = await saveProAccount({ label: "Jeden", env: "sandbox", token: PRO_TOKEN });
    expect((await getProAccount()).id).toBe(a.id);
    const b = await saveProAccount({ label: "Dwa", env: "sandbox", token: "B,B" });
    await expect(getProAccount()).rejects.toThrow(/pass "account_id"/);
    expect((await getProAccount(b.id)).accessKey).toBe("B");
    await expect(getProAccount("pro-missing")).rejects.toThrow(/Unknown Vinted Pro account/);
  });

  it("says so, without crashing, when the stored token can no longer be decrypted", async () => {
    setupPro();
    const a = await saveProAccount({ label: "Jeden", env: "sandbox", token: PRO_TOKEN });
    process.env.ENCRYPTION_KEY = "cd".repeat(32);
    resetConfigCache();
    const err = await getProAccount(a.id).catch((e) => e as ProError);
    expect(err).toBeInstanceOf(ProError);
    expect((err as ProError).kind).toBe("config");
    expect((err as ProError).message).toMatch(/cannot be read/);
    // Summaries need no key, so the panel can still list the account and ask for the token again.
    expect(await listProAccounts()).toHaveLength(1);
  });
});

describe("status", () => {
  it("marks a rejected token and a later success, writing only when something changes", async () => {
    setupPro();
    const a = await saveProAccount({ label: "Sklep", env: "sandbox", token: PRO_TOKEN });
    await markProRejected(a.id, "token rejected (401)");
    expect(await describeProAccount(a.id)).toMatchObject({ status: "rejected", statusReason: "token rejected (401)" });

    await markProOk(await getProAccount(a.id));
    const ok = await describeProAccount(a.id);
    expect(ok).toMatchObject({ status: "connected", statusReason: null });
    expect(ok?.lastOkAt).toBeTruthy();

    // Fresh and connected: no write at all.
    const store = getStore();
    const before = await store.get(keys.proAccount(a.id));
    await markProOk(await getProAccount(a.id));
    expect(await store.get(keys.proAccount(a.id))).toEqual(before);
  });
});

describe("webhook registration", () => {
  it("keeps Vinted's signing key encrypted, hands it only to the receiver, and shows no key", async () => {
    setupPro();
    const a = await saveProAccount({ label: "Sklep", env: "sandbox", token: PRO_TOKEN });
    await setProWebhook(a.id, { id: "wh_1", url: "https://panel.example/api/pro/webhook?account=pro-sklep", events: ["ITEM_SOLD", "ORDER_CREATED"], signingKey: "whsec_topsecret" });

    const summary = await describeProAccount(a.id);
    expect(summary?.webhook).toEqual({ registered: true, url: "https://panel.example/api/pro/webhook?account=pro-sklep", events: ["ITEM_SOLD", "ORDER_CREATED"] });
    expect(JSON.stringify(summary)).not.toContain("whsec_topsecret");
    expect(JSON.stringify(await getStore().get(keys.proAccount(a.id)))).not.toContain("whsec_topsecret");

    expect(await listWebhookSecrets()).toEqual([{ accountId: a.id, signingKey: "whsec_topsecret" }]);
    await clearProWebhook(a.id);
    expect(await listWebhookSecrets()).toEqual([]);
    expect((await describeProAccount(a.id))?.webhook.registered).toBe(false);
  });
});

describe("removing an account", () => {
  it("deletes the record and everything kept about it", async () => {
    setupPro();
    const a = await saveProAccount({ label: "Sklep", env: "sandbox", token: PRO_TOKEN });
    const store = getStore();
    for (const key of [keys.proOntology(a.id), keys.proEvents(a.id), keys.proActions(a.id), keys.proItems(a.id)]) {
      await store.set(key, { something: true });
    }
    expect(await deleteProAccount(a.id)).toBe(true);
    expect(await listProAccounts()).toEqual([]);
    for (const key of [keys.proAccount(a.id), keys.proOntology(a.id), keys.proEvents(a.id), keys.proActions(a.id), keys.proItems(a.id)]) {
      expect(await store.get(key)).toBeNull();
    }
    expect(await deleteProAccount(a.id)).toBe(false);
  });
});
