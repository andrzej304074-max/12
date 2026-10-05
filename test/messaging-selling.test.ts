import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { checkInbox } from "../src/monitor/inbox-watch.js";
import { addWatch, listWatches, seedWatch } from "../src/monitor/engine.js";
import { getSettings, setAutoActionsEnabled } from "../src/settings.js";
import { getStore, keys } from "../src/store/index.js";
import { listAccounts, saveAccount } from "../src/vinted/accounts.js";
import { normaliseConversation, normaliseMessage } from "../src/vinted/inbox.js";
import { callTool, freshEnv, jsonRes, mockFetch } from "./helpers.js";

const ACCOUNT = { label: "Ala", domain: "www.vinted.pl", userId: 42, login: "ala", avatarUrl: null, secrets: { accessToken: "tok-ala" } };

const INBOX = {
  conversations: [
    { id: 101, description: "Czy aktualne?", unread: true, updated_at: "2026-10-05T10:00:00Z", opposite_user: { id: 7, login: "kupujaca", photo: { url: "https://img/k.jpg" } }, transaction: { item_id: 555, item_title: "Kurtka Zara", item_price: { amount: "120.0", currency_code: "PLN" } } },
    { id: 102, description: "Dziękuję", unread: false, updated_at: "2026-10-04T10:00:00Z", opposite_user: { id: 8, login: "inna" } },
  ],
};
const CONVERSATION = {
  conversation: {
    id: 101,
    opposite_user: { id: 7, login: "kupujaca" },
    transaction: { item_id: 555, item_title: "Kurtka Zara" },
    messages: [
      { id: 1, entity_type: "message", entity: { body: "Dzień dobry", user_id: 7 }, created_at_ts: "2026-10-05T09:00:00Z" },
      { id: 2, entity_type: "message", entity: { body: "Cześć!", user_id: 42 }, created_at_ts: "2026-10-05T09:01:00Z" },
      { id: 3, entity_type: "offer_request_message", entity: { id: 900, price: { amount: "90", currency_code: "PLN" }, status_title: "Oczekuje", user_id: 7 }, created_at_ts: "2026-10-05T09:02:00Z" },
      { id: 4, entity_type: "status_message", entity: { title: "Oferta wysłana" } },
    ],
  },
};

function vinted(extra: Record<string, (url: URL, init?: RequestInit) => Response> = {}) {
  return mockFetch((url, init) => {
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (extra[key]) return extra[key](url, init);
    if (key === "GET /api/v2/inbox") return jsonRes(200, INBOX);
    if (key === "GET /api/v2/conversations/101") return jsonRes(200, CONVERSATION);
    return jsonRes(200, {});
  });
}

beforeEach(async () => {
  freshEnv();
  await saveAccount(ACCOUNT);
});
afterEach(() => vi.unstubAllGlobals());

describe("normalising conversations", () => {
  it("reads the fields the panel shows", () => {
    expect(normaliseConversation(INBOX.conversations[0], "ala")).toMatchObject({
      id: "101", accountId: "ala", lastMessage: "Czy aktualne?", unread: true,
      withUser: { login: "kupujaca", avatarUrl: "https://img/k.jpg" },
      item: { id: "555", title: "Kurtka Zara", price: 120, currency: "PLN" },
    });
  });

  it("survives a nearly empty payload", () => {
    expect(normaliseConversation({ id: 5 }, "a")).toMatchObject({ id: "5", lastMessage: "", unread: false, item: null });
    expect(normaliseConversation({}, "a")).toBeNull();
    expect(normaliseConversation(null, "a")).toBeNull();
  });

  it("tells my messages from theirs and recognises offers and system lines", () => {
    const msgs = CONVERSATION.conversation.messages.map((m) => normaliseMessage(m, 42)!);
    expect(msgs.map((m) => [m.kind, m.fromMe])).toEqual([["text", false], ["text", true], ["offer", false], ["system", false]]);
    expect(msgs[2]!.offer).toMatchObject({ id: "900", price: 90, currency: "PLN", status: "Oczekuje" });
  });
});

describe("inbox tools", () => {
  it("lists conversations and counts the unread ones", async () => {
    vinted();
    const r = await callTool("list_conversations", {});
    expect(r.body.count).toBe(2);
    expect(r.body.unread).toBe(1);
    expect((await callTool("list_conversations", { unread_only: true })).body.count).toBe(1);
  });

  it("combines several accounts and reports one that failed", async () => {
    await saveAccount({ ...ACCOUNT, login: "ola", label: "Ola", secrets: { accessToken: "tok-ola" } });
    vinted({
      "GET /api/v2/inbox": (_u, init) =>
        ((init!.headers as Record<string, string>).cookie ?? "").includes("tok-ola") ? jsonRes(500, {}) : jsonRes(200, INBOX),
    });
    const r = await callTool("list_conversations", { all_accounts: true });
    expect(r.body.count).toBe(2);
    expect(r.body.errors).toHaveLength(1);
    expect(r.body.errors[0].accountId).toBe("ola");
  });

  it("skips accounts that need a new login", async () => {
    const { markNeedsLogin } = await import("../src/vinted/accounts.js");
    await markNeedsLogin("ala", "expired");
    const { calls } = vinted();
    expect((await callTool("list_conversations", { all_accounts: true })).body.count).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("opens a conversation", async () => {
    vinted();
    const r = await callTool("get_conversation", { conversation_id: "101" });
    expect(r.body.messages).toHaveLength(4);
    expect(r.body.messages[1].fromMe).toBe(true);
  });

  it("previews a reply and sends nothing without confirm", async () => {
    const { calls } = vinted();
    const r = await callTool("reply_conversation", { conversation_id: "101", text: "Tak, aktualne" });
    expect(r.body).toMatchObject({ preview: true, sent: false });
    expect(calls).toHaveLength(0);
  });

  it("sends a reply with confirm", async () => {
    const { calls } = vinted();
    const r = await callTool("reply_conversation", { conversation_id: "101", text: "Tak, aktualne", confirm: true });
    expect(r.body).toMatchObject({ sent: true });
    const call = calls.find((c) => c.url.pathname === "/api/v2/conversations/101/messages")!;
    expect(JSON.parse(String(call.init!.body))).toEqual({ body: "Tak, aktualne" });
  });

  it("rejects an overlong reply", async () => {
    vinted();
    const r = await callTool("reply_conversation", { conversation_id: "101", text: "x".repeat(2001), confirm: true });
    expect(r.isError).toBe(true);
  });

  it("accepts and rejects offers only after confirm", async () => {
    const { calls } = vinted();
    const args = { conversation_id: "101", offer_id: "900" };
    expect((await callTool("respond_to_offer", { ...args, accept: true })).body).toMatchObject({ preview: true });
    expect(calls).toHaveLength(0);
    await callTool("respond_to_offer", { ...args, accept: true, confirm: true });
    await callTool("respond_to_offer", { ...args, accept: false, confirm: true });
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/v2/conversations/101/offers/900/accept",
      "/api/v2/conversations/101/offers/900/reject",
    ]);
  });

  it("requires a decision when answering an offer", async () => {
    vinted();
    expect((await callTool("respond_to_offer", { conversation_id: "1", offer_id: "2" })).isError).toBe(true);
  });
});

describe("reply templates", () => {
  it("offers defaults, then saves and returns custom ones", async () => {
    expect((await callTool("get_reply_templates")).body.isDefault).toBe(true);
    await callTool("set_reply_templates", { templates: [" Cześć ", "", "Dzięki"] });
    expect((await callTool("get_reply_templates")).body).toEqual({ templates: ["Cześć", "Dzięki"], isDefault: false });
  });

  it("validates the input", async () => {
    expect((await callTool("set_reply_templates", { templates: "x" })).isError).toBe(true);
    expect((await callTool("set_reply_templates", { templates: Array(21).fill("a") })).isError).toBe(true);
    expect((await callTool("set_reply_templates", { templates: ["a".repeat(501)] })).isError).toBe(true);
  });
});

describe("watching new messages", () => {
  const webhook = () => {
    process.env.NOTIFY_WEBHOOK_URL = "https://hooks.example.test/x";
    resetConfigCache();
  };

  it("only records what is there on the first run", async () => {
    webhook();
    const { calls } = vinted();
    const [account] = await listAccounts();
    expect(await checkInbox(account!)).toMatchObject({ seededOnly: true, newMessages: 0, notified: false });
    expect(calls.some((c) => c.url.hostname.includes("hooks"))).toBe(false);
  });

  it("notifies once about a new unread message, then not again", async () => {
    webhook();
    let inbox = INBOX;
    const { calls } = vinted({ "GET /api/v2/inbox": () => jsonRes(200, inbox) });
    const [account] = await listAccounts();
    await checkInbox(account!);
    inbox = { conversations: [{ ...INBOX.conversations[1]!, unread: true, description: "Nowa wiadomość!" } as never, INBOX.conversations[0]!] };
    expect(await checkInbox(account!)).toMatchObject({ newMessages: 1, notified: true });
    expect(await checkInbox(account!)).toMatchObject({ newMessages: 0, notified: false });
    expect(calls.filter((c) => c.url.hostname.includes("hooks"))).toHaveLength(1);
  });
});

describe("selling tools", () => {
  it("uploads a photo as multipart and returns its id", async () => {
    const { calls } = vinted({ "POST /api/v2/photos": () => jsonRes(200, { id: 7777 }) });
    const r = await callTool("upload_photo", { data_base64: Buffer.from("jpeg-bytes").toString("base64"), mime: "image/jpeg" });
    expect(r.body).toEqual({ photoId: 7777, account: "ala" });
    const body = calls[0]!.init!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect((body.get("photo[file]") as File).size).toBe(10);
    expect(body.get("photo[type]")).toBe("item");
    expect((calls[0]!.init!.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("rejects an empty, oversized or wrongly typed photo before sending", async () => {
    const { calls } = vinted();
    expect((await callTool("upload_photo", { data_base64: "", mime: "image/jpeg" })).isError).toBe(true);
    expect((await callTool("upload_photo", { data_base64: "AAAA", mime: "image/gif" })).isError).toBe(true);
    const big = Buffer.alloc(3_600_000).toString("base64");
    expect((await callTool("upload_photo", { data_base64: big, mime: "image/jpeg" })).text).toMatch(/limit/);
    expect(calls).toHaveLength(0);
  });

  it("explains when the upload response has no id", async () => {
    vinted({ "POST /api/v2/photos": () => jsonRes(200, {}) });
    const r = await callTool("upload_photo", { data_base64: "AAAA", mime: "image/png" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no photo id/);
  });

  it("lists the account's own listings", async () => {
    const { calls } = vinted({
      "GET /api/v2/users/42/items": () => jsonRes(200, { items: [{ id: 1, title: "Buty", price: { amount: "50", currency_code: "PLN" }, view_count: 12, favourite_count: 3 }] }),
    });
    const r = await callTool("list_my_listings", {});
    expect(r.body.items[0]).toMatchObject({ title: "Buty", price: 50, views: 12, favourites: 3 });
    expect((calls[0]!.init!.headers as Record<string, string>).cookie).toContain("tok-ala");
  });

  it("asks for the user id when it is unknown", async () => {
    await saveAccount({ ...ACCOUNT, userId: null, login: "bez-id", secrets: { accessToken: "t" } });
    vinted();
    const r = await callTool("list_my_listings", { account_id: "bez-id" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/test_account/);
  });

  it("edits a listing only after confirm and only the given fields", async () => {
    const { calls } = vinted();
    expect((await callTool("update_listing", { item_id: "9", price: 80 })).body).toMatchObject({ preview: true });
    expect(calls).toHaveLength(0);
    await callTool("update_listing", { item_id: "9", price: 80, confirm: true });
    expect(calls[0]!.init!.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ item: { price: "80.00" } });
  });

  it("validates listing edits", async () => {
    vinted();
    expect((await callTool("update_listing", { item_id: "9", confirm: true })).isError).toBe(true);
    expect((await callTool("update_listing", { item_id: "9", price: -5, confirm: true })).isError).toBe(true);
  });

  it("saves, lists and deletes drafts", async () => {
    const saved = (await callTool("save_draft", { draft: { title: "Szkic 1", price: 10 } })).body;
    await callTool("save_draft", { id: saved.id, draft: { title: "Szkic 1 (v2)" } });
    const list = (await callTool("list_drafts")).body.drafts;
    expect(list).toHaveLength(1);
    expect(list[0].data.title).toBe("Szkic 1 (v2)");
    await callTool("delete_draft", { id: saved.id });
    expect((await callTool("list_drafts")).body.drafts).toEqual([]);
  });

  it("keeps drafts per account and rejects bad ones", async () => {
    await saveAccount({ ...ACCOUNT, login: "ola", secrets: { accessToken: "t" } });
    await callTool("save_draft", { account_id: "ala", draft: { title: "A" } });
    expect((await callTool("list_drafts", { account_id: "ola" })).body.drafts).toEqual([]);
    expect((await callTool("save_draft", { account_id: "ala", draft: "nope" })).isError).toBe(true);
    expect((await callTool("save_draft", { account_id: "ala", draft: { x: "y".repeat(21_000) } })).isError).toBe(true);
  });
});

describe("watchlist settings", () => {
  async function watching() {
    await addWatch("ala", { sellerId: "77", sellerLogin: "s", addedAt: "now", domain: null, discountPct: 30, autoLike: true });
    await seedWatch("ala", "77", []);
  }

  it("changes flags without resetting what counts as seen", async () => {
    await watching();
    await getStore().sadd(keys.seen("ala", "77"), "1", "2");
    await callTool("update_watch", { seller_id: "77", auto_offer: true, auto_like: false });
    expect((await listWatches("ala"))[0]).toMatchObject({ autoOffer: true, autoLike: false, discountPct: 30 });
    expect((await getStore().smembers(keys.seen("ala", "77"))).sort()).toEqual(["1", "2"]);
  });

  it("returns to the account discount with null, and validates the range", async () => {
    await watching();
    await callTool("update_watch", { seller_id: "77", discount_pct: null });
    expect((await listWatches("ala"))[0]!.discountPct).toBeNull();
    expect((await callTool("update_watch", { seller_id: "77", discount_pct: 95 })).isError).toBe(true);
  });

  it("rejects an unknown seller", async () => {
    expect((await callTool("update_watch", { seller_id: "1", auto_like: true })).isError).toBe(true);
  });
});

describe("removing an account", () => {
  it("previews first, then deletes the account and everything stored about it", async () => {
    await addWatch("ala", { sellerId: "77", sellerLogin: null, addedAt: "now", domain: null, discountPct: null });
    await callTool("save_draft", { draft: { title: "x" } });
    await callTool("set_automation_limits", { offers_per_day: 3 });
    expect((await callTool("remove_account", { account_id: "ala" })).body).toMatchObject({ preview: true, removed: false });
    expect(await listAccounts()).toHaveLength(1);

    expect((await callTool("remove_account", { account_id: "ala", confirm: true })).body).toEqual({ removed: true, account: "ala" });
    expect(await listAccounts()).toEqual([]);
    const store = getStore();
    expect(await store.smembers(keys.watches("ala"))).toEqual([]);
    expect(await store.smembers(keys.drafts("ala"))).toEqual([]);
    expect(await store.get(keys.limits("ala"))).toBeNull();
  });

  it("refuses to remove an env account", async () => {
    freshEnv({ VINTED_ACCOUNTS: JSON.stringify([{ id: "env1", accessToken: "t" }]) });
    const r = await callTool("remove_account", { account_id: "env1", confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/VINTED_ACCOUNTS/);
  });
});

describe("account tools", () => {
  it("tests a session and fills in the profile", async () => {
    await saveAccount({ ...ACCOUNT, userId: null, login: null, label: "Nowe", secrets: { accessToken: "t" } });
    vinted({ "GET /api/v2/users/current": () => jsonRes(200, { user: { id: 99, login: "odnalezione" } }) });
    const [acc] = await listAccounts();
    const r = await callTool("test_account", { account_id: acc!.id });
    expect(r.body).toMatchObject({ ok: true, login: "odnalezione", userId: 99 });
    expect((await listAccounts()).find((a) => a.id === acc!.id)).toMatchObject({ userId: 99, login: "odnalezione" });
  });

  it("reports a dead session without throwing", async () => {
    vinted({ "GET /api/v2/users/current": () => jsonRes(401, {}) });
    const r = await callTool("test_account", {});
    expect(r.body).toMatchObject({ ok: false, needsLogin: true });
  });

  it("lists accounts without credentials", async () => {
    const r = await callTool("list_accounts");
    expect(r.text).not.toContain("tok-ala");
    expect(r.body.accounts[0]).toMatchObject({ id: "ala", login: "ala", source: "panel", status: "connected" });
  });
});

describe("master switch", () => {
  it("defaults to the environment and is overridden from the panel", async () => {
    expect((await getSettings()).autoActionsEnabled).toBe(false);
    await callTool("set_auto_actions_enabled", { enabled: true });
    expect((await getSettings()).autoActionsEnabled).toBe(true);
    expect((await callTool("list_accounts")).body.autoActionsEnabled).toBe(true);
    await setAutoActionsEnabled(false);
    expect((await getSettings()).autoActionsEnabled).toBe(false);
  });

  it("wins over the environment value in both directions", async () => {
    freshEnv({ AUTO_ACTIONS_ENABLED: "true" });
    expect((await getSettings()).autoActionsEnabled).toBe(true);
    await setAutoActionsEnabled(false);
    expect((await getSettings()).autoActionsEnabled).toBe(false);
  });

  it("requires a boolean", async () => {
    expect((await callTool("set_auto_actions_enabled", {})).isError).toBe(true);
  });
});
