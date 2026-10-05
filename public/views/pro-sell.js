import { add, api, fail, h, put, runAction, safeUrl, shrinkImage, state, toast, tool } from "../lib.js";
import { accountBar, loadProAccounts, noAccountNotice, pickAccount } from "./pro-common.js";

// Wystaw: build a listing from Vinted's own dictionaries, validate it, create it.

const fold = (t) => t.toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/[̀-ͯ]/g, "");

const ERROR_TEXT = {
  CATALOG_NOT_LEAF: "Wybierz kategorię końcową (bez podkategorii).",
  TITLE_LENGTH: "Tytuł ma niewłaściwą długość (5–100 znaków).",
  DESCRIPTION_LENGTH: "Opis ma niewłaściwą długość (5–2000 znaków).",
  BRAND_REQUIRED: "Podaj markę.",
  FIELD_DISABLED: "Ta kategoria nie przyjmuje tego pola.",
  PHOTOS_REQUIRED: "Dodaj przynajmniej jedno zdjęcie.",
  PHOTO_URL_INVALID: "Adres zdjęcia jest nieprawidłowy.",
  PHOTO_NOT_HTTPS: "Adres zdjęcia nie jest https. Vinted pobiera zdjęcia sam, więc muszą być publiczne i trwałe.",
  TEXT_REQUIRED: "To pole jest wymagane.",
  PRICE_INVALID: "Podaj cenę większą od zera.",
  ID_REQUIRED: "Wybierz wartość ze słownika Vinted.",
};

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
  const host = h("div");
  add(root, host);
  await start(pickAccount(accounts));

  async function start(account) {
    put(host, accountBar(accounts, account, start), h("p", { class: "muted" }, "Wczytuję słowniki Vinted…"));
    let onto;
    try {
      onto = await api(`/pro-ontology?account=${encodeURIComponent(account.id)}`);
    } catch (err) {
      put(host, accountBar(accounts, account, start), h("div", { class: "notice bad" }, err.message));
      return;
    }
    form(account, onto);
  }

  function form(account, onto) {
    let leaf = null;

    // ---- inputs
    const title = h("input", { type: "text", maxlength: "100", autocomplete: "off" });
    const titleCount = h("span", { class: "muted small" }, "0/100");
    title.addEventListener("input", () => (titleCount.textContent = `${[...title.value].length}/100`));
    const description = h("textarea", { rows: "6", maxlength: "2000" });
    const price = h("input", { type: "number", min: "0.01", step: "0.01" });
    const brand = h("input", { type: "text", autocomplete: "off", placeholder: "np. Levi's" });
    const brandNote = h("div", { class: "muted small" });
    const sku = h("input", { type: "text", maxlength: "64", placeholder: "Twój SKU (zalecane)" });
    const draft = h("input", { type: "checkbox", checked: true });

    const dict = (entries, placeholder) =>
      entries
        ? h("select", {}, h("option", { value: "" }, placeholder), entries.map((e) => h("option", { value: e.id }, e.title)))
        : h("input", { type: "number", min: "0", step: "1", placeholder: `${placeholder} (id z ontologii)` });
    const condition = dict(onto.conditions, "— stan —");
    const pkg = dict(onto.packageSizes, "— rozmiar paczki —");
    let size = h("input", { type: "number", min: "0", step: "1", placeholder: "id rozmiaru" });
    const sizeBox = h("div");
    put(sizeBox, size);

    const colorBoxes = (onto.colors || []).map((c) => ({ id: c.id, input: h("input", { type: "checkbox" }), title: c.title }));
    const colorsFallback = h("input", { type: "text", placeholder: "id kolorów oddzielone przecinkami (opcjonalnie)" });
    const colorsBox = onto.colors ? h("div", { class: "row" }, colorBoxes.map((c) => h("label", { class: "check" }, c.input, c.title))) : colorsFallback;

    // ---- category search
    const catInput = h("input", { type: "search", placeholder: "Szukaj kategorii, np. kurtki jeansowe", autocomplete: "off" });
    const catList = h("div", { class: "card", style: "padding:.4rem;max-height:14rem;overflow:auto;margin-bottom:.4rem", hidden: true });
    const catChosen = h("div", { class: "muted small" }, "Nie wybrano kategorii.");
    catInput.addEventListener("input", () => {
      const words = fold(catInput.value).split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        catList.hidden = true;
        return;
      }
      const found = onto.leaves.filter((l) => words.every((w) => fold(l.path).includes(w))).slice(0, 12);
      put(
        catList,
        found.length
          ? found.map((l) => h("button", { type: "button", class: "link", style: "display:block;text-align:left;padding:.25rem .3rem;width:100%", onclick: () => choose(l) }, l.path))
          : h("div", { class: "muted small" }, "Brak pasujących kategorii. Można wybrać tylko kategorie końcowe."),
      );
      catList.hidden = false;
    });
    function choose(l) {
      leaf = l;
      catInput.value = "";
      catList.hidden = true;
      put(catChosen, h("b", {}, l.path), ` (id ${l.id})`);
      const noBrand = l.disabledFields.includes("brand");
      brand.disabled = noBrand;
      if (noBrand) brand.value = "";
      put(brandNote, noBrand ? "Ta kategoria nie przyjmuje marki." : "");
      // Sizes come from the size groups of the chosen category.
      const sizes = (onto.sizeGroups || []).filter((g) => l.sizeGroupIds.includes(g.id)).flatMap((g) => g.sizes);
      if (onto.sizeGroups) {
        size = sizes.length
          ? h("select", {}, h("option", { value: "" }, "— rozmiar —"), sizes.map((s) => h("option", { value: s.id }, s.title)))
          : h("select", { disabled: true }, h("option", {}, "Ta kategoria nie ma rozmiarów"));
        put(sizeBox, size);
      }
    }

    // ---- photos
    const urls = h("textarea", { rows: "3", placeholder: "Adresy zdjęć (https), jeden na linię" });
    const thumbs = h("div", { class: "photos" });
    const picker = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
    const canUpload = Boolean(state.me?.setup?.photoUpload);
    const photoList = () => [...new Set(urls.value.split(/\s+/).map((s) => s.trim()).filter(Boolean))];
    const drawThumbs = () => put(thumbs, photoList().filter((u) => safeUrl(u)).map((u) => h("div", { class: "photo" }, h("img", { src: u, alt: "", loading: "lazy" }))));
    urls.addEventListener("input", drawThumbs);
    picker.addEventListener("change", async () => {
      for (const file of picker.files) {
        try {
          const shrunk = await shrinkImage(file, 1600, 0.85);
          const r = await api("/pro-upload", { method: "POST", body: { base64: shrunk.base64 } });
          urls.value = `${urls.value.trim()}\n${r.url}`.trim();
          drawThumbs();
        } catch (err) {
          fail(err);
        }
      }
      picker.value = "";
    });

    // ---- problems, shown next to the field they are about
    const general = h("div");
    const result = h("div");
    const notes = {};
    const wrap = (name, label, input, extra) => {
      notes[name] = h("div", { class: "err small", style: "color:var(--danger)" });
      return h("div", { class: "field" }, h("label", {}, label), input, extra || null, notes[name]);
    };
    function showProblems(problems) {
      for (const n of Object.values(notes)) n.replaceChildren();
      general.replaceChildren();
      for (const p of problems) {
        const text = ERROR_TEXT[p.code ?? p.error] || p.message || p.code || p.error;
        const note = notes[p.field];
        const line = h("div", { class: p.level === "warning" ? "muted" : "" }, p.level === "warning" ? `Uwaga: ${text}` : text);
        if (note) note.append(line);
        else general.append(h("div", { class: "notice warn" }, `${p.field}: `, text));
      }
    }

    function colorIds() {
      if (onto.colors) return colorBoxes.filter((c) => c.input.checked).map((c) => c.id);
      return colorsFallback.value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    }

    function payload() {
      const item = {
        title: title.value.trim(),
        description: description.value.trim(),
        price: Number(price.value),
        catalog_id: leaf?.id,
        status_id: Number(condition.value),
        package_size_id: Number(pkg.value),
        photo_urls: photoList(),
      };
      if (!brand.disabled && brand.value.trim()) item.brand = brand.value.trim();
      const colors = colorIds();
      if (colors.length) item.color_ids = colors;
      if (size.value) item.size_id = Number(size.value);
      if (sku.value.trim()) item.reference = sku.value.trim();
      return item;
    }

    /** Local rules plus Vinted's own validation. Returns true when nothing blocks. */
    async function validate() {
      const r = await tool("pro_validate_items", { account_id: account.id, items: [payload()] });
      const fromVinted = (r.vinted?.results?.[0]?.errors || []).map((e) => ({ field: e.field, code: e.error, level: "error" }));
      showProblems([...r.problems, ...fromVinted]);
      if (r.vinted?.unavailable) put(result, h("div", { class: "notice warn" }, `Walidacja Vinted jest niedostępna: ${r.vinted.unavailable}`));
      return r.ok;
    }

    async function onValidate(event) {
      const button = event.currentTarget;
      button.disabled = true;
      put(result);
      try {
        if (await validate()) put(result, h("div", { class: "notice ok" }, "Walidacja przeszła. Możesz utworzyć ofertę."));
        else put(result, h("div", { class: "notice bad" }, "Walidacja znalazła problemy. Szczegóły są przy polach."));
      } catch (err) {
        fail(err);
      } finally {
        button.disabled = false;
      }
    }

    async function onCreate(event) {
      const button = event.currentTarget;
      button.disabled = true;
      put(result);
      try {
        if (!(await validate())) {
          put(result, h("div", { class: "notice bad" }, "Najpierw popraw problemy zaznaczone przy polach."));
          return;
        }
        const publish = !draft.checked;
        const r = await runAction(
          "pro_create_items",
          { account_id: account.id, items: [payload()], publish },
          publish ? "Utworzyć i OPUBLIKOWAĆ ofertę?" : "Utworzyć ofertę jako szkic?",
          publish ? "Utwórz i opublikuj" : "Utwórz szkic",
        );
        if (!r) return;
        if (!r.created) {
          showProblems(r.problems || []);
          put(result, h("div", { class: "notice bad" }, r.reason || "Oferta nie została utworzona."));
          return;
        }
        put(
          result,
          h(
            "div",
            { class: "notice ok" },
            "Przyjęto do przetwarzania. Vinted tworzy ofertę w tle; wynik zobaczysz w zakładce ",
            h("a", { href: "#/pro-items" }, "Oferty"),
            " lub ",
            h("a", { href: "#/pro-events" }, "Zdarzenia"),
            ".",
          ),
        );
        toast("Oferta przyjęta");
      } catch (err) {
        fail(err);
      } finally {
        button.disabled = false;
      }
    }

    async function onSuggest(event) {
      if (!leaf) return toast("Najpierw wybierz kategorię.", true);
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const r = await tool("pro_price_suggestion", { account_id: account.id, catalog_id: leaf.id, ...(condition.value ? { status_id: Number(condition.value) } : {}) });
        put(result, h("div", { class: "notice" }, "Podpowiedź ceny od Vinted: ", h("span", { class: "mono" }, JSON.stringify(r.suggestion))));
      } catch (err) {
        fail(err);
      } finally {
        button.disabled = false;
      }
    }

    put(
      host,
      accountBar(accounts, account, start),
      h(
        "div",
        { class: "two" },
        h(
          "div",
          { class: "card" },
          h("h2", {}, "Nowa oferta"),
          wrap("catalog_id", "Kategoria (tylko końcowe)", catInput, [catList, catChosen]),
          wrap("title", "Tytuł", title, titleCount),
          wrap("description", "Opis", description),
          h("div", { class: "row" }, h("div", { class: "grow" }, wrap("price", "Cena", price)), h("div", { class: "grow" }, wrap("reference", "SKU", sku))),
          wrap("brand", "Marka (tekstem)", brand, brandNote),
          h("div", { class: "row" }, h("div", { class: "grow" }, wrap("status_id", "Stan", condition)), h("div", { class: "grow" }, wrap("package_size_id", "Rozmiar paczki", pkg))),
          wrap("size_id", "Rozmiar", sizeBox),
          wrap("color_ids", "Kolory", colorsBox),
          wrap(
            "photo_urls",
            "Zdjęcia",
            urls,
            h(
              "div",
              { class: "row", style: "margin:.4rem 0" },
              picker,
              h("button", { type: "button", disabled: !canUpload, onclick: () => picker.click(), title: canUpload ? "" : "Wymaga sklepu Vercel Blob (BLOB_READ_WRITE_TOKEN)" }, "Wgraj zdjęcia"),
              canUpload ? null : h("span", { class: "muted small" }, "Wgrywanie wymaga Vercel Blob; na razie wklej adresy zdjęć, które już są w internecie."),
            ),
          ),
          thumbs,
          h("label", { class: "check", style: "margin:.6rem 0" }, draft, "Utwórz jako szkic (zalecane; publikacja dopiero po sprawdzeniu)"),
          general,
          h(
            "div",
            { class: "row" },
            h("button", { type: "button", onclick: onSuggest }, "Podpowiedź ceny"),
            h("button", { type: "button", onclick: onValidate }, "Waliduj"),
            h("button", { type: "button", class: "primary", onclick: onCreate }, "Utwórz"),
          ),
          result,
        ),
        h(
          "div",
          { class: "card" },
          h("h3", {}, "Jak to działa"),
          h("p", { class: "muted small" }, "Kategorie, stany, rozmiary paczek i kolory pochodzą z ontologii Vinted (pobieranej raz na dobę). Nie wpisuj ich z pamięci: identyfikatory różnią się między rynkami."),
          h("p", { class: "muted small" }, "Zdjęcia muszą być publiczne i trwałe; Vinted pobiera je sam. Oferta powstaje asynchronicznie: odpowiedź oznacza tylko przyjęcie, a wynik przychodzi webhookiem."),
          h("p", { class: "muted small" }, `Ontologia: ${onto.leaves.length} kategorii końcowych, pobrana ${onto.fromCache ? "z pamięci podręcznej" : "przed chwilą"}.`),
        ),
      ),
    );
  }
}
