import { add, accountLabel, ago, dialog, fail, field, h, money, pill, runAction, safeUrl, sendDirect, state, table, toast, tool } from "../lib.js";

export async function render(root, ctx) {
  const accounts = (state.accountId ? state.accounts.filter((a) => a.id === state.accountId) : state.accounts).filter(
    (a) => a.status !== "needs_login",
  );
  if (accounts.length === 0) {
    add(root, h("div", { class: "notice warn" }, "Brak połączonego konta z aktywną sesją (zakładka Konta)."));
    return;
  }

  const finds = [];
  for (const a of accounts) {
    try {
      const r = await tool("list_new_finds", { account_id: a.id, limit: 100 });
      finds.push(...r.finds);
    } catch (err) {
      fail(err);
    }
  }
  finds.sort((x, y) => y.detectedAt.localeCompare(x.detectedAt));
  ctx.setBadge("finds", finds.length);

  add(root, 
    h("div", { class: "row", style: "margin-bottom:1rem" }, h("button", { type: "button", onclick: () => window.dispatchEvent(new Event("hashchange")) }, "Odśwież")),
    finds.length === 0
      ? h("div", { class: "empty" }, "Brak nowych znalezisk. Pojawią się, gdy obserwowani sprzedawcy dodadzą przedmioty.")
      : table(
          ["", "Przedmiot", "Cena", "Oferta", "Stan", ""],
          finds.map((f) => [
            safeUrl(f.photoUrl) ? h("img", { class: "thumb", src: f.photoUrl, alt: "", loading: "lazy" }) : "",
            h(
              "div",
              {},
              h("a", { href: safeUrl(f.url), target: "_blank", rel: "noopener noreferrer" }, f.title || f.itemId),
              h("div", { class: "muted small" }, [f.sellerLogin ? `@${f.sellerLogin}` : null, ago(f.detectedAt), state.accounts.length > 1 ? accountLabel(f.accountId) : null].filter(Boolean).join(" · ")),
            ),
            money(f.askingPrice, f.currency),
            f.suggestedOfferPrice === null ? "—" : h("span", {}, money(f.suggestedOfferPrice, f.currency), h("span", { class: "muted small" }, ` (−${f.discountPct}%)`)),
            autoState(f),
            h(
              "div",
              { class: "row" },
              h("button", { type: "button", onclick: () => like(f) }, "Polub"),
              h("button", { type: "button", onclick: () => offer(f) }, "Oferta"),
              h("button", { type: "button", class: "primary", onclick: () => both(f) }, "Polub + oferta"),
              h("button", { type: "button", onclick: () => handled(f) }, "Załatwione"),
            ),
          ]),
        ),
  );

  function autoState(f) {
    const parts = [];
    for (const k of f.autoPending || []) parts.push(pill(`czeka: ${k === "like" ? "polubienie" : "oferta"}`, "warn"));
    for (const a of f.autoActions || []) parts.push(pill(`${a.kind === "like" ? "polubiono" : "oferta"}${a.ok ? "" : " ✗"}`, a.ok ? "ok" : "bad"));
    return parts.length ? h("div", { class: "row" }, parts) : h("span", { class: "muted" }, "—");
  }

  async function like(f) {
    try {
      await sendDirect("like_item", { account_id: f.accountId, item_id: f.itemId });
      toast("Polubiono");
    } catch (err) {
      fail(err);
    }
  }

  async function offer(f) {
    const price = h("input", { type: "number", min: "1", step: "1", value: f.suggestedOfferPrice ?? "" });
    const ok = await dialog({
      title: "Wyślij ofertę",
      body: h("div", {}, h("p", {}, f.title), field(`Kwota oferty (cena wywoławcza: ${money(f.askingPrice, f.currency)})`, price)),
      confirmLabel: "Wyślij ofertę",
    });
    if (!ok) return;
    try {
      await sendDirect("make_offer", { account_id: f.accountId, item_id: f.itemId, price: Number(price.value) });
      toast("Oferta wysłana");
    } catch (err) {
      fail(err);
    }
  }

  async function both(f) {
    try {
      const r = await runAction("process_find", { account_id: f.accountId, item_id: f.itemId }, "Polubić i wysłać ofertę?");
      if (r) window.dispatchEvent(new Event("hashchange"));
    } catch (err) {
      fail(err);
    }
  }

  async function handled(f) {
    try {
      await tool("mark_find_handled", { account_id: f.accountId, item_id: f.itemId });
      window.dispatchEvent(new Event("hashchange"));
    } catch (err) {
      fail(err);
    }
  }
}
