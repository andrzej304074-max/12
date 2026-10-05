import { add, ago, fail, h, pill, state, table, toast, tool } from "../lib.js";

export async function render(root, ctx) {
  const setup = state.me?.setup || {};
  const accounts = state.accounts;
  const broken = accounts.filter((a) => a.status === "needs_login");
  const ready = accounts.filter((a) => a.status !== "needs_login");

  let unread = 0;
  let finds = 0;
  let auto = false;
  let lastRun = null;
  try {
    if (ready.length) {
      unread = (await tool("list_conversations", { all_accounts: true, unread_only: true })).unread || 0;
      for (const a of ready) finds += (await tool("list_new_finds", { account_id: a.id, limit: 200 })).count || 0;
      const info = await tool("list_accounts");
      auto = info.autoActionsEnabled;
      const watches = await tool("list_watches", { account_id: ready[0].id });
      lastRun = watches.lastMonitorRun;
    } else {
      auto = (await tool("list_accounts")).autoActionsEnabled;
    }
  } catch (err) {
    fail(err);
  }

  const result = h("div");
  const toggle = h("input", {
    type: "checkbox",
    checked: auto,
    onchange: async (e) => {
      try {
        await tool("set_auto_actions_enabled", { enabled: e.target.checked });
        toast(e.target.checked ? "Automatyka włączona" : "Automatyka wyłączona");
      } catch (err) {
        e.target.checked = !e.target.checked;
        fail(err);
      }
    },
  });

  const checks = [
    ["Trwały magazyn (Upstash Redis)", setup.durableStorage, "Bez niego lista obserwowanych i znaleziska giną po każdym wywołaniu."],
    ["Klucz szyfrowania (ENCRYPTION_KEY)", setup.encryptionKey, "Potrzebny, żeby zapisywać konta podłączone przez panel."],
    ["Token MCP (MCP_AUTH_TOKEN)", setup.mcpAuthToken, "Bez niego endpoint /api/mcp odmawia obsługi na produkcji."],
    ["Sekret crona (CRON_SECRET)", setup.cronSecret, "Chroni /api/cron/monitor przed ręcznym wywołaniem z zewnątrz."],
    ["Webhook powiadomień", setup.notifyWebhook, "Opcjonalny: powiadomienia o znaleziskach i wiadomościach na telefon."],
  ];

  add(root, 
    broken.length
      ? h("div", { class: "notice bad" }, `Konta wymagające ponownego zalogowania: ${broken.map((a) => a.label).join(", ")}. Zrób to w zakładce Konta.`)
      : null,
    h(
      "div",
      { class: "grid", style: "margin-bottom:1rem" },
      stat("Konta", `${ready.length}/${accounts.length}`, "połączone"),
      stat("Nieprzeczytane", unread, "wiadomości"),
      stat("Nowe znaleziska", finds, "do obejrzenia"),
      h(
        "div",
        { class: "card", style: "margin:0" },
        h("div", { class: "muted small" }, "Automatyka"),
        h("label", { class: "check", style: "margin-top:.4rem" }, toggle, "Auto polubienia i oferty"),
        h("div", { class: "muted small", style: "margin-top:.4rem" }, "Główny wyłącznik. Limity i okno godzin w zakładce Automatyka."),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Monitoring"),
      h("p", { class: "muted" }, lastRun ? `Ostatni przebieg crona: ${ago(lastRun)}.` : "Cron jeszcze nie działał."),
      h("button", { type: "button", class: "primary", onclick: runNow }, "Uruchom przebieg teraz"),
      result,
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Konfiguracja serwera"),
      table(
        ["Element", "Stan", "Po co"],
        checks.map(([name, ok, why]) => [name, ok ? pill("ok", "ok") : pill("brak", name.startsWith("Webhook") ? "warn" : "bad"), h("span", { class: "muted" }, why)]),
      ),
    ),
  );

  async function runNow(event) {
    const button = event.currentTarget;
    button.disabled = true;
    result.replaceChildren(h("p", { class: "muted" }, "Sprawdzam obserwowanych sprzedawców…"));
    try {
      const r = await tool("run_monitor_pass", { all_accounts: true });
      result.replaceChildren(
        r.results.length === 0
          ? h("p", { class: "muted" }, "Brak kont do sprawdzenia.")
          : table(
              ["Konto", "Sprzedawcy", "Nowe", "Auto-akcje", "Uwagi"],
              r.results.map((x) => [
                x.accountId,
                x.sellersChecked,
                x.newFinds.length,
                x.autoActions.filter((a) => a.ok).length,
                [x.autoStoppedBecause, ...x.errors.map((e) => e.message)].filter(Boolean).join("; ") || "—",
              ]),
            ),
      );
    } catch (err) {
      result.replaceChildren();
      fail(err);
    } finally {
      button.disabled = false;
    }
  }
}

function stat(label, value, hint) {
  return h("div", { class: "card", style: "margin:0" }, h("div", { class: "muted small" }, label), h("div", { class: "stat" }, value), h("div", { class: "muted small" }, hint));
}
