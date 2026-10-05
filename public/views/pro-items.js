import { add, ago, dialog, fail, field, h, put, runAction, table, toast, tool } from "../lib.js";
import { accountBar, listIn, loadProAccounts, noAccountNotice, pickAccount, rawBlock, shortId, showPrice, statusPill } from "./pro-common.js";

// Oferty: own listings through Vinted Pro, plus the ones imported from Vinted.
//
// The documentation does not fix the shape of an item in a list, so the table
// reads the likely field names and the raw answer is one click away.

const PAGE = 30;

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
  let tab = "items";
  let cursors = [undefined]; // cursor of each page shown so far; the last is the current one
  const bar = h("div");
  const tabs = h("div", { class: "row", style: "margin-bottom:1rem" });
  const list = h("div");
  add(root, bar, tabs, list);
  drawBar();
  await load();

  function drawBar() {
    put(bar, accountBar(accounts, account, (a) => {
      account = a;
      cursors = [undefined];
      drawBar();
      load();
    }));
    put(
      tabs,
      h("button", { type: "button", class: tab === "items" ? "primary" : "", onclick: () => switchTab("items") }, "Oferty"),
      h("button", { type: "button", class: tab === "imported" ? "primary" : "", onclick: () => switchTab("imported") }, "Zaimportowane z Vinted"),
      h("span", { style: "margin-left:auto" }),
      h("button", { type: "button", onclick: () => load() }, "Odśwież"),
    );
  }

  function switchTab(next) {
    tab = next;
    cursors = [undefined];
    drawBar();
    load();
  }

  async function load() {
    put(list, h("p", { class: "muted" }, "Ładowanie…"));
    try {
      const args = { account_id: account.id, limit: PAGE, ...(cursors.at(-1) ? { after_item_id: cursors.at(-1) } : {}) };
      const r = await tool(tab === "items" ? "pro_list_items" : "pro_list_imported_items", args);
      if (!ctx.isCurrent()) return;
      const items = listIn(r.data);
      const tracked = Object.fromEntries((r.tracked || []).map((t) => [t.id, t]));
      put(list, tab === "items" ? itemsTable(items, tracked) : importedTable(items), pager(items), rawBlock("Surowa odpowiedź Vinted", r.data));
    } catch (err) {
      put(list);
      fail(err);
    }
  }

  function pager(items) {
    const last = items.at(-1)?.id;
    return h(
      "div",
      { class: "row", style: "margin-top:.8rem" },
      cursors.length > 1
        ? h("button", { type: "button", onclick: () => { cursors.pop(); load(); } }, "← Poprzednia")
        : null,
      items.length >= PAGE && last
        ? h("button", { type: "button", onclick: () => { cursors.push(String(last)); load(); } }, "Następna →")
        : null,
    );
  }

  function itemsTable(items, tracked) {
    if (items.length === 0) return h("div", { class: "empty" }, "Brak ofert na tej stronie.");
    return table(
      ["Oferta", "SKU", "Cena", "Status", "Id", ""],
      items.map((item) => {
        const state = item.status ?? tracked[item.id]?.status;
        return [
          h("div", {}, h("b", {}, item.title ?? item.name ?? "(bez tytułu)"), item.updatedAt || tracked[item.id]?.updatedAt ? h("div", { class: "muted small" }, `zmiana ${ago(tracked[item.id]?.updatedAt)}`) : null),
          item.reference ?? tracked[item.id]?.reference ?? "—",
          showPrice(item.price),
          statusPill(state),
          h("span", { class: "mono muted", title: String(item.id) }, shortId(item.id)),
          h(
            "div",
            { class: "row" },
            h("button", { type: "button", onclick: () => changePrice(item) }, "Cena"),
            h("button", { type: "button", onclick: () => visibility(item) }, "Szkic / publikacja"),
            h("button", { type: "button", onclick: () => checkStatus(item) }, "Status"),
            h("button", { type: "button", class: "danger", onclick: () => remove(item) }, "Usuń"),
          ),
        ];
      }),
    );
  }

  function importedTable(items) {
    if (items.length === 0) return h("div", { class: "empty" }, "Brak zaimportowanych ofert. Vinted importuje oferty dodane poza API (np. ręcznie).");
    const inputs = new Map();
    const rows = items.map((item) => {
      const input = h("input", { type: "text", maxlength: "64", placeholder: "Twój SKU", value: item.reference ?? "" });
      inputs.set(item.id, input);
      return [h("b", {}, item.title ?? item.name ?? "(bez tytułu)"), showPrice(item.price), h("span", { class: "mono muted", title: String(item.id) }, shortId(item.id)), input];
    });
    return h(
      "div",
      {},
      h("p", { class: "muted small" }, "Nadaj zaimportowanym ofertom własne referencje (SKU), żeby zarządzać nimi tutaj."),
      table(["Oferta", "Cena", "Id", "Referencja"], rows),
      h(
        "div",
        { class: "row", style: "margin-top:.8rem" },
        h(
          "button",
          {
            type: "button",
            class: "primary",
            onclick: async () => {
              const chosen = [...inputs].map(([id, input]) => ({ id: String(id), reference: input.value.trim() })).filter((x) => x.reference);
              if (chosen.length === 0) return toast("Wpisz przynajmniej jedną referencję.");
              try {
                if (await runAction("pro_set_item_references", { account_id: account.id, items: chosen }, `Zapisać ${chosen.length} referencji?`, "Zapisz")) load();
              } catch (err) {
                fail(err);
              }
            },
          },
          "Zapisz referencje",
        ),
      ),
    );
  }

  async function changePrice(item) {
    const price = h("input", { type: "number", min: "0.01", step: "0.01", required: true });
    const ok = await dialog({ title: "Zmień cenę", body: field(`Nowa cena (obecnie ${showPrice(item.price)})`, price), confirmLabel: "Dalej" });
    if (!ok || price.value === "") return;
    try {
      if (await runAction("pro_update_items", { account_id: account.id, items: [{ id: String(item.id), price: Number(price.value) }] }, "Zmienić cenę oferty?", "Zmień")) {
        toast("Przyjęte. Wynik przyjdzie webhookiem.");
        load();
      }
    } catch (err) {
      fail(err);
    }
  }

  async function visibility(item) {
    const publish = h("input", { type: "radio", name: "vis", value: "false", checked: true });
    const draft = h("input", { type: "radio", name: "vis", value: "true" });
    const ok = await dialog({
      title: "Szkic czy publikacja?",
      body: h("div", {}, h("label", { class: "check" }, publish, "Opublikuj"), h("br"), h("label", { class: "check" }, draft, "Zmień na szkic")),
      confirmLabel: "Dalej",
    });
    if (!ok) return;
    try {
      if (await runAction("pro_update_items", { account_id: account.id, items: [{ id: String(item.id), is_draft: draft.checked }] }, draft.checked ? "Zmienić ofertę na szkic?" : "Opublikować ofertę?", "Zatwierdź")) {
        toast("Przyjęte. Wynik przyjdzie webhookiem.");
        load();
      }
    } catch (err) {
      fail(err);
    }
  }

  async function checkStatus(item) {
    try {
      const r = await tool("pro_get_item_status", { account_id: account.id, item_id: String(item.id) });
      toast(`Status: ${r.status?.status ?? JSON.stringify(r.status)}`);
      load();
    } catch (err) {
      fail(err);
    }
  }

  async function remove(item) {
    try {
      if (await runAction("pro_delete_items", { account_id: account.id, item_ids: [String(item.id)] }, `Usunąć ofertę „${item.title ?? shortId(item.id)}"? Tego nie da się cofnąć.`, "Usuń")) {
        toast("Przyjęte. Wynik przyjdzie webhookiem.");
        load();
      }
    } catch (err) {
      fail(err);
    }
  }
}
