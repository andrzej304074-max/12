import { add, fail, field, h, money, safeUrl, table, tool } from "../lib.js";

export async function render(root) {
  const searchOut = h("div");
  const estimateOut = h("div");
  const lookupOut = h("div");

  const q = h("input", { type: "text", placeholder: "np. Nike Air Max 90 białe 42", required: true });
  const from = h("input", { type: "number", min: "0", placeholder: "cena od" });
  const to = h("input", { type: "number", min: "0", placeholder: "cena do" });
  const order = h(
    "select",
    {},
    h("option", { value: "relevance" }, "trafność"),
    h("option", { value: "newest_first" }, "najnowsze"),
    h("option", { value: "price_low_to_high" }, "cena rosnąco"),
    h("option", { value: "price_high_to_low" }, "cena malejąco"),
  );
  const est = h("input", { type: "text", placeholder: "Opis przedmiotu do wyceny", required: true });
  const look = h("input", { type: "text", placeholder: "nazwa kategorii lub marki", required: true });

  add(root, 
    h(
      "form",
      { class: "card", onsubmit: search },
      h("h2", {}, "Podobne oferty"),
      h("div", { class: "row" }, h("div", { class: "grow" }, q), h("div", { style: "width:7rem" }, from), h("div", { style: "width:7rem" }, to), h("div", { style: "width:10rem" }, order), h("button", { class: "primary", type: "submit" }, "Szukaj")),
      searchOut,
    ),
    h(
      "form",
      { class: "card", onsubmit: estimate },
      h("h2", {}, "Wycena"),
      h("p", { class: "muted small" }, "Na podstawie cen wywoławczych podobnych ofert. Vinted nie udostępnia cen sprzedaży."),
      h("div", { class: "row" }, h("div", { class: "grow" }, est), h("button", { class: "primary", type: "submit" }, "Wyceń")),
      estimateOut,
    ),
    h(
      "form",
      { class: "card", onsubmit: lookup },
      h("h2", {}, "Kategorie i marki"),
      h("div", { class: "row" }, h("div", { class: "grow" }, look), h("button", { type: "submit", name: "category" }, "Kategoria"), h("button", { type: "submit", name: "brand" }, "Marka")),
      lookupOut,
    ),
  );

  async function search(e) {
    e.preventDefault();
    searchOut.replaceChildren(h("p", { class: "muted" }, "Szukam…"));
    try {
      const r = await tool("search_similar_items", {
        query: q.value,
        order: order.value,
        per_page: 24,
        ...(from.value ? { price_from: Number(from.value) } : {}),
        ...(to.value ? { price_to: Number(to.value) } : {}),
      });
      searchOut.replaceChildren(
        r.items.length === 0
          ? h("p", { class: "muted" }, "Brak wyników.")
          : table(
              ["", "Przedmiot", "Cena", "Marka / rozmiar", "♥"],
              r.items.map((i) => [
                safeUrl(i.photoUrl) ? h("img", { class: "thumb", src: i.photoUrl, alt: "", loading: "lazy" }) : "",
                h("a", { href: safeUrl(i.url), target: "_blank", rel: "noopener noreferrer" }, i.title),
                money(i.price, i.currency),
                [i.brand, i.size].filter(Boolean).join(" / ") || "—",
                i.favourites ?? "—",
              ]),
            ),
      );
    } catch (err) {
      searchOut.replaceChildren();
      fail(err);
    }
  }

  async function estimate(e) {
    e.preventDefault();
    estimateOut.replaceChildren(h("p", { class: "muted" }, "Liczę…"));
    try {
      const r = await tool("estimate_price", { query: est.value });
      if (!r.distribution) {
        estimateOut.replaceChildren(h("p", { class: "muted" }, r.message || "Brak danych."));
        return;
      }
      const d = r.distribution;
      const cur = d.currency || "";
      estimateOut.replaceChildren(
        h(
          "div",
          { class: "grid", style: "margin:.8rem 0" },
          price("Szybka sprzedaż", r.quickSale, cur),
          price("Rekomendowana", r.recommended, cur),
          price("Ambitna", r.ambitious, cur),
        ),
        h("p", {}, `Pewność: ${{ low: "niska", medium: "średnia", high: "wysoka" }[r.confidence]} · próba: ${d.sampleSize} · zakres ${d.min}–${d.max} ${cur} · średnia ${d.mean}`),
        h("ul", { class: "muted small" }, r.notes.map((n) => h("li", {}, n))),
      );
    } catch (err) {
      estimateOut.replaceChildren();
      fail(err);
    }
  }

  function price(label, value, cur) {
    return h("div", { class: "card", style: "margin:0" }, h("div", { class: "muted small" }, label), h("div", { class: "stat" }, `${value} ${cur}`));
  }

  async function lookup(e) {
    e.preventDefault();
    const isBrand = e.submitter?.name === "brand";
    lookupOut.replaceChildren(h("p", { class: "muted" }, "Szukam…"));
    try {
      if (isBrand) {
        const r = await tool("find_brand", { query: look.value });
        lookupOut.replaceChildren(r.suggestions.length ? table(["ID", "Nazwa", "Typ"], r.suggestions.map((s) => [s.id ?? "—", s.title, s.kind])) : h("p", { class: "muted" }, "Brak wyników."));
      } else {
        const r = await tool("find_category", { query: look.value });
        lookupOut.replaceChildren(r.matches.length ? table(["ID", "Ścieżka"], r.matches.map((m) => [m.id, m.path])) : h("p", { class: "muted" }, "Brak wyników."));
      }
    } catch (err) {
      lookupOut.replaceChildren();
      fail(err);
    }
  }
}
