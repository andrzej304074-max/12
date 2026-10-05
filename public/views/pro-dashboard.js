import { add, ago, fail, h, pill, state, table, tool } from "../lib.js";
import { accountBar, loadProAccounts, noAccountNotice, pickAccount, statusPill } from "./pro-common.js";

// Pulpit: is the connection healthy, what happened lately, what is not set up.

export async function render(root) {
  let accounts = [];
  try {
    accounts = await loadProAccounts();
  } catch (err) {
    fail(err);
  }
  if (accounts.length === 0) {
    add(root, noAccountNotice());
    return;
  }
  const body = h("div");
  add(root, body);
  await draw(pickAccount(accounts));

  async function draw(account) {
    body.replaceChildren(accountBar(accounts, account, draw));
    let events = [];
    let actions = [];
    let tracked = [];
    try {
      events = (await tool("pro_list_events", { account_id: account.id, limit: 6 })).events;
      actions = (await tool("pro_list_actions", { account_id: account.id })).actions.slice(0, 6);
      tracked = (await tool("pro_list_items", { account_id: account.id, limit: 1 }).catch(() => ({ tracked: [] }))).tracked || [];
    } catch (err) {
      fail(err);
    }

    const counts = {};
    for (const t of tracked) counts[t.status] = (counts[t.status] || 0) + 1;
    const setup = state.me?.setup || {};
    const checks = [
      ["Klucz szyfrowania (ENCRYPTION_KEY)", setup.encryptionKey, "Bez niego nie da się zapisać tokenu.", "bad"],
      ["Trwały magazyn (Upstash Redis)", setup.durableStorage, "Bez niego konta, zdarzenia i pamięć podręczna giną po każdym wywołaniu.", "bad"],
      ["Surowe ciało webhooków (NODEJS_HELPERS=0)", setup.rawBodyForWebhooks, "Podpis webhooka obejmuje dokładne bajty; bez tej zmiennej część dostaw może być odrzucana.", "warn"],
      ["Wgrywanie zdjęć (Vercel Blob)", setup.photoUpload, "Bez niego zdjęcia trzeba wkleić jako adresy URL.", "warn"],
      ["Token MCP (MCP_AUTH_TOKEN)", setup.mcpAuthToken, "Bez niego endpoint /api/mcp odmawia obsługi na produkcji.", "bad"],
      ["Sekret crona (CRON_SECRET)", setup.cronSecret, "Chroni codzienne uzgodnienie przed ręcznym wywołaniem z zewnątrz.", "bad"],
      ["Webhook powiadomień (NOTIFY_WEBHOOK_URL)", setup.notifyWebhook, "Opcjonalny: powiadomienia o sprzedaży i zamówieniach.", "warn"],
    ];

    add(
      body,
      account.status !== "connected"
        ? h("div", { class: "notice bad" }, `Vinted odrzucił token tego konta (${account.statusReason || "brak szczegółów"}). Dodaj go ponownie w zakładce Konta.`)
        : null,
      h(
        "div",
        { class: "grid", style: "margin-bottom:1rem" },
        stat("Ostatnio działało", account.lastOkAt ? ago(account.lastOkAt) : "—", "udane zapytanie do Vinted Pro"),
        stat("Śledzone oferty", tracked.length, Object.keys(counts).map((k) => `${k}: ${counts[k]}`).join(", ") || "jeszcze żadnej"),
        stat("Webhook", account.webhook.registered ? "włączony" : "brak", account.webhook.registered ? `${account.webhook.events.length} typów zdarzeń` : "zarejestruj w zakładce Zdarzenia"),
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Ostatnie zdarzenia"),
        events.length === 0
          ? h("p", { class: "muted" }, "Jeszcze nic nie przyszło webhookiem.")
          : table(["Kiedy", "Zdarzenie", "Szczegóły"], events.map((e) => [ago(e.at), statusPill(e.type), h("span", { class: "muted" }, e.summary)])),
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Co wysłano do Vinted Pro"),
        actions.length === 0
          ? h("p", { class: "muted" }, "Jeszcze nic.")
          : table(["Kiedy", "Akcja", "Ile", "Wynik"], actions.map((a) => [ago(a.at), a.kind, a.count, a.ok ? pill("ok", "ok") : h("span", {}, pill("błąd", "bad"), h("div", { class: "muted small" }, a.detail)) ])),
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Konfiguracja serwera"),
        table(
          ["Element", "Stan", "Po co"],
          checks.map(([name, ok, why, kind]) => [name, ok ? pill("ok", "ok") : pill("brak", kind), h("span", { class: "muted" }, why)]),
        ),
      ),
    );
  }
}

function stat(label, value, hint) {
  return h("div", { class: "card", style: "margin:0" }, h("div", { class: "muted small" }, label), h("div", { class: "stat" }, value), h("div", { class: "muted small" }, hint));
}
