import { add, ago, currentAccount, dialog, fail, field, h, safeUrl, state, table, toast, tool } from "../lib.js";

/** Accepts a numeric id or a profile link such as https://www.vinted.pl/member/12345-nick. */
export function parseSellerId(text) {
  const value = String(text || "").trim();
  if (/^\d+$/.test(value)) return value;
  const match = /\/member\/(\d+)/.exec(value);
  return match ? match[1] : "";
}

export async function render(root) {
  const account = currentAccount();
  if (!account) {
    add(root, h("div", { class: "notice warn" }, "Najpierw podłącz konto w zakładce Konta."));
    return;
  }
  if (account.status === "needs_login") {
    add(root, h("div", { class: "notice bad" }, `Konto „${account.label}" wymaga ponownego zalogowania (zakładka Konta).`));
    return;
  }

  let info;
  try {
    info = await tool("list_watches", { account_id: account.id });
  } catch (err) {
    fail(err);
    return;
  }

  const seller = h("input", { type: "text", placeholder: "ID sprzedawcy lub link do profilu", required: true });
  const discount = h("input", { type: "number", min: "0", max: "90", placeholder: `domyślnie ${info.defaultDiscountPct}%` });
  const autoLike = h("input", { type: "checkbox" });
  const autoOffer = h("input", { type: "checkbox" });

  add(root, 
    state.accounts.length > 1
      ? h("p", { class: "muted small" }, `Konto: ${account.label}. Zmienisz je w prawym górnym rogu.`)
      : null,
    !info.durableStorage
      ? h("div", { class: "notice warn" }, "Brak trwałego magazynu (Upstash) — obserwowani znikną po wygaśnięciu funkcji. Ustaw UPSTASH_REDIS_REST_URL i _TOKEN.")
      : null,
    h(
      "form",
      {
        class: "card",
        onsubmit: async (e) => {
          e.preventDefault();
          const id = parseSellerId(seller.value);
          if (!id) return toast("Podaj numeryczne ID sprzedawcy albo link do jego profilu.", true);
          try {
            const r = await tool("watch_seller", {
              account_id: account.id,
              seller_id: id,
              ...(discount.value !== "" ? { discount_pct: Number(discount.value) } : {}),
              auto_like: autoLike.checked,
              auto_offer: autoOffer.checked,
            });
            const wantsAuto = r.watching.autoLike || r.watching.autoOffer;
            const autoNote = !wantsAuto
              ? ""
              : r.automation.includes("master switch is off")
                ? " Automat jest wyłączony na Pulpicie, więc nic nie zostanie wysłane automatycznie."
                : " Automat działa dla tego sprzedawcy (w granicach limitów i okna godzin).";
            toast(`Obserwujesz ${r.watching.sellerLogin || id}.${autoNote}`);
            window.dispatchEvent(new Event("hashchange"));
          } catch (err) {
            fail(err);
          }
        },
      },
      h("h2", {}, "Dodaj sprzedawcę"),
      h("div", { class: "row" }, h("div", { class: "grow" }, field("Sprzedawca", seller)), h("div", { style: "width:9rem" }, field("Rabat oferty %", discount))),
      h(
        "div",
        { class: "row", style: "margin-bottom:.8rem" },
        h("label", { class: "check" }, autoLike, "Automatycznie polub nowe"),
        h("label", { class: "check" }, autoOffer, "Automatycznie wyślij ofertę"),
      ),
      h("p", { class: "muted small" }, "Automatyka działa tylko gdy jest włączona na Pulpicie i w granicach limitów oraz okna godzin (zakładka Automatyka)."),
      h("button", { class: "primary", type: "submit" }, "Obserwuj"),
    ),
    info.watches.length === 0
      ? h("div", { class: "empty" }, "Nikogo jeszcze nie obserwujesz.")
      : table(
          ["Sprzedawca", "Rabat", "Auto-polubienie", "Auto-oferta", "Od", ""],
          info.watches.map((w) => [
            h(
              "a",
              { href: safeUrl(`https://${w.domain || account.domain}/member/${w.sellerId}`), target: "_blank", rel: "noopener noreferrer" },
              w.sellerLogin ? `@${w.sellerLogin}` : w.sellerId,
            ),
            w.discountPct === null ? h("span", { class: "muted" }, `${info.defaultDiscountPct}% (domyślny)`) : `${w.discountPct}%`,
            toggle(w, "auto_like", w.autoLike),
            toggle(w, "auto_offer", w.autoOffer),
            ago(w.addedAt),
            h("div", { class: "row" }, h("button", { type: "button", onclick: () => editDiscount(w) }, "Rabat"), h("button", { type: "button", class: "danger", onclick: () => remove(w) }, "Usuń")),
          ]),
        ),
  );

  function toggle(watch, key, value) {
    return h("input", {
      type: "checkbox",
      checked: Boolean(value),
      "aria-label": key,
      onchange: async (e) => {
        try {
          await tool("update_watch", { account_id: account.id, seller_id: watch.sellerId, [key]: e.target.checked });
          toast("Zapisano");
        } catch (err) {
          e.target.checked = !e.target.checked;
          fail(err);
        }
      },
    });
  }

  async function editDiscount(watch) {
    const input = h("input", { type: "number", min: "0", max: "90", value: watch.discountPct ?? "", placeholder: "puste = domyślny" });
    const ok = await dialog({ title: "Rabat oferty dla tego sprzedawcy", body: field("Procent poniżej ceny (0–90). Puste = domyślny konta.", input), confirmLabel: "Zapisz" });
    if (!ok) return;
    try {
      await tool("update_watch", { account_id: account.id, seller_id: watch.sellerId, discount_pct: input.value === "" ? null : Number(input.value) });
      window.dispatchEvent(new Event("hashchange"));
    } catch (err) {
      fail(err);
    }
  }

  async function remove(watch) {
    const ok = await dialog({ title: "Przestać obserwować?", body: h("p", {}, watch.sellerLogin ? `@${watch.sellerLogin}` : watch.sellerId), confirmLabel: "Usuń", danger: true });
    if (!ok) return;
    try {
      await tool("unwatch_seller", { account_id: account.id, seller_id: watch.sellerId });
      window.dispatchEvent(new Event("hashchange"));
    } catch (err) {
      fail(err);
    }
  }
}
