import { add, ago, fail, h, pill, put, runAction, state, table, toast, tool } from "../lib.js";
import { accountBar, loadProAccounts, noAccountNotice, pickAccount, statusPill } from "./pro-common.js";

// Zdarzenia: the webhook (registration and deliveries) and what Vinted has told us.

export async function render(root, ctx) {
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

  let account = pickAccount(accounts);
  const body = h("div");
  add(root, body);
  await draw(account);

  async function draw(acct) {
    account = acct;
    put(body, accountBar(accounts, account, draw), h("p", { class: "muted" }, "Ładowanie…"));
    let data;
    let fresh = account;
    try {
      data = await tool("pro_list_events", { account_id: account.id, limit: 100 });
      fresh = (await loadProAccounts()).find((a) => a.id === account.id) || account;
    } catch (err) {
      fail(err);
      return;
    }
    if (!ctx.isCurrent()) return;
    account = fresh;
    const raw = state.me?.setup?.rawBodyForWebhooks;
    const hook = account.webhook;
    const url = `${location.origin}/api/pro/webhook`;

    const itemId = h("input", { type: "text", placeholder: "Id oferty (UUID) utworzonej w sandboxie", style: "min-width:18rem" });

    put(
      body,
      accountBar(accounts, account, draw),
      !raw
        ? h(
            "div",
            { class: "notice warn" },
            "Zalecane: ustaw w Vercelu zmienną NODEJS_HELPERS=0 i zrób Redeploy. Podpis webhooka obejmuje dokładne bajty ciała, a Vercel domyślnie je parsuje; bez tej zmiennej część dostaw może być odrzucana (wtedy zobaczysz je niżej jako odrzucone, z fromParsed).",
          )
        : null,
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Webhook"),
        hook.registered
          ? h("p", {}, pill("zarejestrowany", "ok"), " ", h("span", { class: "mono small" }, hook.url), h("div", { class: "muted small" }, `${hook.events.length} typów zdarzeń. Klucz podpisu jest zapisany zaszyfrowany i nie jest nigdzie pokazywany.`))
          : h("p", { class: "muted" }, "Brak. Bez webhooka wynik tworzenia, edycji i usuwania ofert oraz sprzedaż poznasz dopiero przy codziennym uzgodnieniu."),
        h(
          "div",
          { class: "row" },
          h("button", { type: "button", class: "primary", onclick: () => register() }, hook.registered ? "Zarejestruj ponownie" : "Zarejestruj webhook"),
          hook.registered ? h("button", { type: "button", class: "danger", onclick: () => unregister() }, "Usuń webhook") : null,
          h("button", { type: "button", onclick: () => draw(account) }, "Odśwież"),
        ),
        h("p", { class: "muted small", style: "margin-top:.6rem" }, `Adres, który dostanie Vinted: ${url}?account=${account.id}`),
      ),
      account.env === "sandbox"
        ? h(
            "div",
            { class: "card" },
            h("h2", {}, "Symulacja sprzedaży (sandbox)"),
            h("p", { class: "muted small" }, "Vinted wyśle wtedy ITEM_SOLD, ORDER_CREATED i SHIPMENT_LABEL_CREATED. Tak sprawdzisz całą ścieżkę: webhook, zamówienie, etykieta."),
            h("div", { class: "row" }, itemId, h("button", { type: "button", onclick: () => simulate() }, "Symuluj sprzedaż")),
          )
        : null,
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Otrzymane zdarzenia"),
        data.events.length === 0
          ? h("p", { class: "muted" }, "Jeszcze nic nie przyszło.")
          : table(
              ["Kiedy", "Zdarzenie", "Szczegóły", "Dane"],
              data.events.map((e) => [
                h("span", { title: e.at }, ago(e.at)),
                statusPill(e.type),
                h("span", { class: "muted" }, e.summary.replace(`${e.type} · `, "")),
                h("details", { class: "tech" }, h("summary", {}, "pokaż"), h("pre", { class: "mono" }, JSON.stringify(e.data, null, 2))),
              ]),
            ),
      ),
      data.refusedDeliveries.length
        ? h(
            "div",
            { class: "card" },
            h("h2", {}, "Odrzucone dostawy"),
            h("p", { class: "muted small" }, "Dostawy, których podpis się nie zgodził. Nie zawierają niczego z ciała ani z podpisu."),
            table(
              ["Kiedy", "Powód", "Rozmiar", "Ciało odbudowane"],
              data.refusedDeliveries.map((r) => [ago(r.at), r.reasons.join("; "), `${r.bodyBytes} B`, r.fromParsed ? pill("tak: ustaw NODEJS_HELPERS=0", "warn") : "nie"]),
            ),
          )
        : null,
    );

    async function register() {
      try {
        if (await runAction("pro_register_webhook", { account_id: account.id, url }, "Zarejestrować webhook u Vinted?", "Zarejestruj")) {
          toast("Webhook zarejestrowany.");
          draw(account);
        }
      } catch (err) {
        fail(err);
      }
    }

    async function unregister() {
      try {
        if (await runAction("pro_delete_webhook", { account_id: account.id }, "Usunąć webhook u Vinted?", "Usuń")) {
          draw(account);
        }
      } catch (err) {
        fail(err);
      }
    }

    async function simulate() {
      if (!itemId.value.trim()) return toast("Podaj id oferty.", true);
      try {
        if (await runAction("pro_simulate_sale", { account_id: account.id, item_id: itemId.value.trim() }, "Zasymulować sprzedaż tej oferty w sandboxie?", "Symuluj")) {
          toast("Zlecone. Zdarzenia pojawią się za chwilę.");
          setTimeout(() => ctx.isCurrent() && draw(account), 2500);
        }
      } catch (err) {
        fail(err);
      }
    }
  }

  // New deliveries show up without a manual refresh while the view is open.
  const timer = setInterval(() => {
    if (!document.hidden && ctx.isCurrent()) refreshEvents();
  }, 20000);
  ctx.onCleanup(() => clearInterval(timer));
  async function refreshEvents() {
    try {
      await draw(account);
    } catch {
      /* the next tick tries again */
    }
  }
}
