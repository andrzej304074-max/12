import { add, ago, dialog, fail, field, h, put, runAction, table, toast, tool } from "../lib.js";
import { accountBar, listIn, loadProAccounts, noAccountNotice, pickAccount, rawBlock, shortId, showPrice, statusPill } from "./pro-common.js";

// Zamówienia: orders, shipments and shipping labels.
//
// As with the item list, the shape of an order is not fixed by the
// documentation, so the table reads the likely names and keeps the raw answer.

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
  let cursors = [undefined];
  const bar = h("div");
  const list = h("div");
  add(root, bar, list);
  drawBar();
  await load();

  function drawBar() {
    put(
      bar,
      accountBar(accounts, account, (a) => {
        account = a;
        cursors = [undefined];
        drawBar();
        load();
      }),
      h("div", { class: "row", style: "margin-bottom:1rem" }, h("button", { type: "button", onclick: () => load() }, "Odśwież")),
    );
  }

  async function load() {
    put(list, h("p", { class: "muted" }, "Ładowanie…"));
    try {
      const r = await tool("pro_list_orders", { account_id: account.id, ...(cursors.at(-1) ? { after_id: cursors.at(-1) } : {}) });
      if (!ctx.isCurrent()) return;
      const orders = listIn(r.data);
      const last = orders.at(-1)?.id;
      put(
        list,
        orders.length === 0
          ? h("div", { class: "empty" }, "Brak zamówień na tej stronie.")
          : table(
              ["Zamówienie", "Status", "Pozycje", "Kwota", "Utworzone", ""],
              orders.map((o) => [
                h("span", { class: "mono", title: String(o.id) }, shortId(o.id)),
                statusPill(o.status),
                h("span", {}, (o.items || []).map((i) => i.reference || shortId(i.id)).join(", ") || "—"),
                orderTotal(o),
                o.created_at ? ago(o.created_at) : "—",
                h(
                  "div",
                  { class: "row" },
                  h("button", { type: "button", onclick: () => details(o) }, "Szczegóły"),
                  h("a", { class: "btn", href: `/api/app/pro-label?account=${encodeURIComponent(account.id)}&order=${encodeURIComponent(o.id)}`, target: "_blank", rel: "noopener" }, "Etykieta PDF"),
                  h("button", { type: "button", onclick: () => cancel(o) }, "Anuluj"),
                  h("button", { type: "button", onclick: () => relist(o) }, "Wystaw ponownie"),
                ),
              ]),
            ),
        h(
          "div",
          { class: "row", style: "margin-top:.8rem" },
          cursors.length > 1 ? h("button", { type: "button", onclick: () => { cursors.pop(); load(); } }, "← Poprzednia") : null,
          orders.length >= 50 && last ? h("button", { type: "button", onclick: () => { cursors.push(String(last)); load(); } }, "Następna →") : null,
        ),
        rawBlock("Surowa odpowiedź Vinted", r.data),
      );
    } catch (err) {
      put(list);
      fail(err);
    }
  }

  function orderTotal(order) {
    if (order.total !== undefined) return showPrice(order.total);
    const sum = (order.items || []).reduce((acc, i) => acc + (Number(typeof i.price === "object" ? i.price?.amount : i.price) || 0), 0);
    return sum > 0 ? `${sum.toFixed(2)} ${order.currency || ""}`.trim() : "—";
  }

  async function details(order) {
    try {
      const [o, s] = await Promise.all([
        tool("pro_get_order", { account_id: account.id, order_id: String(order.id) }),
        tool("pro_get_shipment", { account_id: account.id, order_id: String(order.id) }).catch((err) => ({ shipment: { error: err.message } })),
      ]);
      await dialog({
        title: `Zamówienie ${order.id}`,
        body: h("pre", { class: "mono" }, JSON.stringify({ order: o.order, shipment: s.shipment }, null, 2).slice(0, 12000)),
        confirmLabel: "Zamknij",
        cancelLabel: "",
      });
    } catch (err) {
      fail(err);
    }
  }

  async function cancel(order) {
    const reason = h("input", { type: "text", maxlength: "100", required: true, placeholder: "np. Przedmiot uszkodzony w magazynie" });
    const ok = await dialog({
      title: `Anulować zamówienie ${order.id}?`,
      body: field("Powód (do 100 znaków, wymagany)", reason),
      confirmLabel: "Dalej",
      danger: true,
    });
    if (!ok) return;
    if (!reason.value.trim()) return toast("Podaj powód anulowania.", true);
    try {
      if (await runAction("pro_cancel_order", { account_id: account.id, order_id: String(order.id), reason: reason.value.trim() }, "Anulować to zamówienie?", "Anuluj zamówienie")) {
        toast("Przyjęte. Ewentualny błąd przyjdzie webhookiem.");
        load();
      }
    } catch (err) {
      fail(err);
    }
  }

  async function relist(order) {
    try {
      if (await runAction("pro_relist_orders", { account_id: account.id, order_ids: [String(order.id)] }, "Wystawić ponownie przedmioty z tego zamówienia?", "Wystaw ponownie")) {
        toast("Przyjęte.");
        load();
      }
    } catch (err) {
      fail(err);
    }
  }
}
