import { add, ago, currentAccount, fail, field, h, put, runAction, shrinkImage, state, toast, tool } from "../lib.js";

const CONDITIONS = [
  ["6", "Nowy z metką"],
  ["1", "Nowy bez metki"],
  ["2", "Bardzo dobry"],
  ["3", "Dobry"],
  ["4", "Zadowalający"],
];

// The tool's messages are written for MCP clients (English); the panel shows these.
const ISSUES_PL = {
  "title:blocker": "Tytuł jest za długi (maks. ok. 100 znaków).",
  "description:blocker": "Opis jest za długi (maks. ok. 3000 znaków).",
  "description:warning": "Opis jest bardzo krótki. Podaj wymiary i wady - kupujący zadają wtedy mniej pytań.",
  "price:blocker": "Podaj cenę większą od zera.",
  "catalog_id:blocker": "Wybierz kategorię.",
  "brand:warning": "Brak marki. Oferty z marką pojawiają się w znacznie większej liczbie wyszukiwań.",
  "size:warning": "Brak rozmiaru. Ubrania bez rozmiaru są pomijane w większości wyszukiwań.",
  "condition:blocker": "Wybierz stan przedmiotu.",
  "photos:blocker": "Dodaj co najmniej jedno zdjęcie.",
  "photos:warning": "Mniej niż trzy zdjęcia. Oferty z 4 lub więcej zdjęciami sprzedają się szybciej.",
};
const issueText = (i) => ISSUES_PL[`${i.field}:${i.severity}`] || i.message;

const CURRENCY = {
  pl: "PLN", uk: "GBP", cz: "CZK", hu: "HUF", ro: "RON", se: "SEK", dk: "DKK",
};
function currencyFor(domain) {
  const tld = String(domain || "").split(".").pop();
  return CURRENCY[tld] || "EUR";
}

export async function render(root) {
  const account = currentAccount();
  if (!account || account.status === "needs_login") {
    add(root, h("div", { class: "notice warn" }, "Do wystawiania potrzebne jest połączone konto z aktywną sesją (zakładka Konta)."));
    return;
  }

  const draft = {
    id: null,
    title: "",
    description: "",
    price: "",
    currency: currencyFor(account.domain),
    brand: "",
    brandId: null,
    size: "",
    condition: "",
    catalogId: null,
    categoryPath: "",
    photos: [], // { id, preview }
  };

  const photosBox = h("div", { class: "photos" });
  const issues = h("div");
  const catResults = h("div");
  const brandResults = h("div");
  const priceBox = h("div");
  const draftsBox = h("div");
  const catLabel = h("div", { class: "muted small" });
  const brandLabel = h("div", { class: "muted small" });

  const title = input("text", "title", { maxlength: "100" });
  const description = h("textarea", { rows: "6", maxlength: "3000", oninput: (e) => { draft.description = e.target.value; validateSoon(); } });
  const price = input("number", "price", { min: "1", step: "1" });
  const size = input("text", "size", {});
  const condition = h(
    "select",
    { onchange: (e) => { draft.condition = e.target.value; validateSoon(); } },
    h("option", { value: "" }, "— wybierz —"),
    CONDITIONS.map(([v, l]) => h("option", { value: v }, l)),
  );
  const catQuery = h("input", { type: "text", placeholder: "szukaj kategorii, np. kurtki zimowe" });
  const brandQuery = h("input", { type: "text", placeholder: "szukaj marki" });
  const file = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, onchange: (e) => addFiles([...e.target.files]) });
  const drop = h(
    "div",
    { class: "drop", tabindex: "0", onclick: () => file.click() },
    "Przeciągnij zdjęcia tutaj lub kliknij, żeby wybrać",
  );
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles([...e.dataTransfer.files]); });

  function input(type, key, extra) {
    return h("input", { type, ...extra, oninput: (e) => { draft[key] = e.target.value; validateSoon(); } });
  }

  add(root, 
    h(
      "div",
      { class: "two" },
      h(
        "div",
        {},
        state.accounts.length > 1 ? h("p", { class: "muted small" }, `Konto: ${account.label}. Zmienisz je w prawym górnym rogu.`) : null,
        h("div", { class: "card" }, h("h2", {}, "Zdjęcia"), photosBox, drop, file),
        h(
          "div",
          { class: "card" },
          h("h2", {}, "Opis"),
          field("Tytuł", title),
          field("Opis", description),
          h("div", { class: "row" }, h("div", { class: "grow" }, field("Rozmiar", size)), h("div", { class: "grow" }, field("Stan", condition))),
        ),
        h(
          "div",
          { class: "card" },
          h("h2", {}, "Kategoria i marka"),
          field("Kategoria", h("div", {}, h("div", { class: "row" }, h("div", { class: "grow" }, catQuery), h("button", { type: "button", onclick: searchCategory }, "Szukaj")), catLabel, catResults)),
          field("Marka", h("div", {}, h("div", { class: "row" }, h("div", { class: "grow" }, brandQuery), h("button", { type: "button", onclick: searchBrand }, "Szukaj")), brandLabel, brandResults)),
        ),
        h(
          "div",
          { class: "card" },
          h("h2", {}, "Cena"),
          h("div", { class: "row" }, h("div", { style: "width:10rem" }, field(`Cena (${draft.currency})`, price)), h("button", { type: "button", onclick: suggestPrice }, "Podpowiedz cenę")),
          priceBox,
        ),
        h(
          "div",
          { class: "card" },
          h("h2", {}, "Sprawdzenie"),
          issues,
          h(
            "div",
            { class: "row", style: "margin-top:1rem" },
            h("button", { type: "button", onclick: saveDraft }, "Zapisz szkic"),
            h("button", { type: "button", class: "primary", onclick: publish }, "Wystaw"),
          ),
        ),
      ),
      h("div", { class: "card" }, h("h2", {}, "Szkice"), draftsBox, h("button", { type: "button", class: "link small", onclick: reset }, "Nowa oferta")),
    ),
  );

  function fillForm() {
    title.value = draft.title;
    description.value = draft.description;
    price.value = draft.price;
    size.value = draft.size;
    condition.value = draft.condition;
    catLabel.textContent = draft.catalogId ? `Wybrano: ${draft.categoryPath || draft.catalogId}` : "Nie wybrano kategorii.";
    brandLabel.textContent = draft.brand ? `Wybrano: ${draft.brand}` : "Nie wybrano marki.";
    drawPhotos();
    validateSoon();
  }

  function reset() {
    Object.assign(draft, { id: null, title: "", description: "", price: "", brand: "", brandId: null, size: "", condition: "", catalogId: null, categoryPath: "", photos: [] });
    fillForm();
  }

  function drawPhotos() {
    photosBox.replaceChildren(
      ...draft.photos.map((p, i) =>
        h(
          "div",
          { class: "photo" },
          p.preview ? h("img", { src: p.preview, alt: "" }) : h("div", { class: "ph" }, `zdjęcie #${p.id}`),
          h(
            "div",
            { class: "ctl" },
            h("button", { type: "button", disabled: i === 0, "aria-label": "W lewo", onclick: () => move(i, -1) }, "◀"),
            h("button", { type: "button", class: "danger", "aria-label": "Usuń", onclick: () => { draft.photos.splice(i, 1); drawPhotos(); validateSoon(); } }, "✕"),
            h("button", { type: "button", disabled: i === draft.photos.length - 1, "aria-label": "W prawo", onclick: () => move(i, 1) }, "▶"),
          ),
        ),
      ),
    );
  }

  function move(i, delta) {
    const j = i + delta;
    [draft.photos[i], draft.photos[j]] = [draft.photos[j], draft.photos[i]];
    drawPhotos();
  }

  async function addFiles(files) {
    for (const f of files.filter((x) => x.type.startsWith("image/"))) {
      if (draft.photos.length >= 20) return toast("Maksymalnie 20 zdjęć.", true);
      try {
        const small = await shrinkImage(f);
        const r = await tool("upload_photo", { account_id: account.id, data_base64: small.base64, mime: "image/jpeg" });
        draft.photos.push({ id: r.photoId, preview: small.preview });
        drawPhotos();
        validateSoon();
      } catch (err) {
        fail(err);
      }
    }
    file.value = "";
  }

  async function searchCategory() {
    if (!catQuery.value.trim()) return;
    try {
      const r = await tool("find_category", { query: catQuery.value, limit: 12 });
      put(catResults,
        r.matches.length === 0
          ? h("p", { class: "muted small" }, "Brak wyników.")
          : r.matches.map((m) =>
              h("div", {}, h("button", { type: "button", class: "link", onclick: () => { draft.catalogId = m.id; draft.categoryPath = m.path; catLabel.textContent = `Wybrano: ${m.path}`; catResults.replaceChildren(); validateSoon(); } }, m.path)),
            ),
      );
    } catch (err) {
      fail(err);
    }
  }

  async function searchBrand() {
    if (!brandQuery.value.trim()) return;
    try {
      const r = await tool("find_brand", { query: brandQuery.value });
      put(brandResults,
        r.suggestions.length === 0
          ? h("p", { class: "muted small" }, "Brak wyników.")
          : r.suggestions.map((s) =>
              h("div", {}, h("button", { type: "button", class: "link", onclick: () => { draft.brand = s.title; draft.brandId = s.id; brandLabel.textContent = `Wybrano: ${s.title}`; brandResults.replaceChildren(); validateSoon(); } }, s.title)),
            ),
      );
    } catch (err) {
      fail(err);
    }
  }

  async function suggestPrice() {
    const query = [draft.brand, draft.title].filter(Boolean).join(" ").trim();
    if (!query) return toast("Najpierw wpisz tytuł.", true);
    priceBox.replaceChildren(h("p", { class: "muted" }, "Liczę…"));
    try {
      const r = await tool("estimate_price", { query, currency: draft.currency });
      if (!r.distribution) {
        priceBox.replaceChildren(h("p", { class: "muted" }, r.message || "Brak danych."));
        return;
      }
      const chip = (label, value) =>
        h("button", { type: "button", onclick: () => { draft.price = String(Math.round(value)); price.value = draft.price; validateSoon(); } }, `${label}: ${value} ${r.distribution.currency || ""}`);
      priceBox.replaceChildren(
        h("div", { class: "row", style: "margin-top:.6rem" }, chip("Szybka", r.quickSale), chip("Rekomendowana", r.recommended), chip("Ambitna", r.ambitious)),
        h("p", { class: "muted small" }, `Pewność: ${{ low: "niska", medium: "średnia", high: "wysoka" }[r.confidence]}, próba ${r.distribution.sampleSize}. To ceny wywoławcze, nie sprzedaży.`),
      );
    } catch (err) {
      priceBox.replaceChildren();
      fail(err);
    }
  }

  function payload() {
    return {
      account_id: account.id,
      title: draft.title,
      description: draft.description,
      price: draft.price === "" ? undefined : Number(draft.price),
      currency: draft.currency,
      ...(draft.brand ? { brand: draft.brand } : {}),
      ...(draft.brandId !== null ? { brand_id: Number(draft.brandId) } : {}),
      ...(draft.size ? { size: draft.size } : {}),
      ...(draft.condition ? { condition: draft.condition } : {}),
      ...(draft.catalogId !== null ? { catalog_id: draft.catalogId } : {}),
    };
  }

  let timer;
  function validateSoon() {
    clearTimeout(timer);
    timer = setTimeout(validate, 400);
  }
  async function validate() {
    if (!draft.title.trim() || !draft.description.trim()) {
      issues.replaceChildren(h("p", { class: "muted small" }, "Wpisz tytuł i opis, a sprawdzę resztę na bieżąco."));
      return;
    }
    try {
      const { account_id, ...rest } = payload();
      const r = await tool("validate_listing", { ...rest, photo_count: draft.photos.length });
      put(issues,
        r.issues.length === 0
          ? h("div", { class: "notice ok" }, "Wszystko wygląda dobrze.")
          : r.issues.map((i) => h("div", { class: `notice ${i.severity === "blocker" ? "bad" : "warn"}` }, `${i.severity === "blocker" ? "Wymagane" : "Warto poprawić"}: ${issueText(i)}`)),
      );
    } catch (err) {
      issues.replaceChildren(h("div", { class: "notice bad" }, err.message));
    }
  }

  async function saveDraft() {
    try {
      const { account_id, ...rest } = draft;
      const r = await tool("save_draft", {
        account_id: account.id,
        ...(draft.id ? { id: draft.id } : {}),
        draft: { ...rest, photos: draft.photos.map((p) => ({ id: p.id })) },
      });
      draft.id = r.id;
      toast("Zapisano szkic");
      loadDrafts();
    } catch (err) {
      fail(err);
    }
  }

  async function publish() {
    try {
      const args = { ...payload(), photo_ids: draft.photos.map((p) => p.id) };
      const r = await runAction("publish_listing", args, "Opublikować ofertę?", "Wystaw");
      if (!r) return;
      if (r.refused) {
        issues.replaceChildren(...(r.blockers || []).map((b) => h("div", { class: "notice bad" }, issueText(b))));
        return;
      }
      toast("Oferta opublikowana");
      if (draft.id) await tool("delete_draft", { account_id: account.id, id: draft.id });
      reset();
      loadDrafts();
    } catch (err) {
      fail(err);
    }
  }

  async function loadDrafts() {
    try {
      const r = await tool("list_drafts", { account_id: account.id });
      put(draftsBox,
        r.drafts.length === 0
          ? h("p", { class: "muted small" }, "Brak szkiców.")
          : r.drafts.map((d) =>
              h(
                "div",
                { class: "row", style: "justify-content:space-between;padding:.3rem 0;border-bottom:1px solid var(--line)" },
                h("div", { style: "min-width:0" }, h("div", {}, d.data.title || "Bez tytułu"), h("div", { class: "muted small" }, ago(d.updatedAt))),
                h(
                  "div",
                  { class: "row" },
                  h("button", { type: "button", onclick: () => { Object.assign(draft, d.data, { id: d.id, photos: (d.data.photos || []).map((p) => ({ id: p.id, preview: null })) }); fillForm(); } }, "Otwórz"),
                  h("button", { type: "button", class: "danger", "aria-label": "Usuń szkic", onclick: async () => { await tool("delete_draft", { account_id: account.id, id: d.id }).catch(fail); loadDrafts(); } }, "✕"),
                ),
              ),
            ),
      );
    } catch (err) {
      fail(err);
    }
  }

  fillForm();
  loadDrafts();
}
