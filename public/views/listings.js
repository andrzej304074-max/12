import { add, currentAccount, dialog, fail, field, h, money, runAction, safeUrl, state, table, toast, tool } from "../lib.js";

export async function render(root) {
  const account = currentAccount();
  if (!account || account.status === "needs_login") {
    add(root, h("div", { class: "notice warn" }, "Potrzebne jest połączone konto z aktywną sesją (zakładka Konta)."));
    return;
  }
  if (account.userId === null || account.userId === undefined) {
    add(root, 
      h(
        "div",
        { class: "notice warn" },
        "Nie znam ID tego konta, a bez niego nie pobiorę Twoich ofert. ",
        h(
          "button",
          {
            type: "button",
            onclick: async () => {
              try {
                const r = await tool("test_account", { account_id: account.id });
                if (!r.ok) throw new Error(r.detail || "Test nieudany");
                const data = await fetch("/api/app/accounts", { credentials: "same-origin" }).then((x) => x.json());
                state.accounts = data.accounts;
                window.dispatchEvent(new Event("hashchange"));
              } catch (err) {
                fail(err);
              }
            },
          },
          "Pobierz ID konta",
        ),
      ),
    );
    return;
  }

  let items = [];
  try {
    items = (await tool("list_my_listings", { account_id: account.id })).items;
  } catch (err) {
    fail(err);
  }

  add(root, 
    state.accounts.length > 1 ? h("p", { class: "muted small" }, `Konto: ${account.label}. Zmienisz je w prawym górnym rogu.`) : null,
    items.length === 0
      ? h("div", { class: "empty" }, "Brak aktywnych ofert.")
      : table(
          ["", "Oferta", "Cena", "Wyświetlenia", "♥", ""],
          items.map((i) => [
            safeUrl(i.photoUrl) ? h("img", { class: "thumb", src: i.photoUrl, alt: "", loading: "lazy" }) : "",
            h("a", { href: safeUrl(i.url), target: "_blank", rel: "noopener noreferrer" }, i.title),
            money(i.price, i.currency),
            i.views ?? "—",
            i.favourites ?? "—",
            h(
              "div",
              { class: "row" },
              h("button", { type: "button", onclick: () => edit(i) }, "Edytuj"),
              h("button", { type: "button", onclick: () => duplicate(i) }, "Duplikuj"),
              h("button", { type: "button", class: "danger", onclick: () => remove(i) }, "Usuń"),
            ),
          ]),
        ),
  );

  async function edit(item) {
    const title = h("input", { type: "text", value: item.title, maxlength: "100" });
    const price = h("input", { type: "number", min: "1", step: "1", value: item.price ?? "" });
    const description = h("textarea", { rows: "6", placeholder: "Zostaw puste, żeby nie zmieniać opisu" });
    const ok = await dialog({
      title: "Edytuj ofertę",
      body: h("div", {}, field("Tytuł", title), field("Cena", price), field("Nowy opis", description)),
      confirmLabel: "Dalej",
    });
    if (!ok) return;
    const changes = {};
    if (title.value.trim() && title.value.trim() !== item.title) changes.title = title.value.trim();
    if (price.value !== "" && Number(price.value) !== item.price) changes.price = Number(price.value);
    if (description.value.trim()) changes.description = description.value.trim();
    if (Object.keys(changes).length === 0) return toast("Nic się nie zmieniło.");
    try {
      const r = await runAction("update_listing", { account_id: account.id, item_id: item.id, ...changes }, "Zapisać zmiany w ofercie?", "Zapisz");
      if (r) window.dispatchEvent(new Event("hashchange"));
    } catch (err) {
      fail(err);
    }
  }

  async function remove(item) {
    try {
      const r = await runAction("delete_listing", { account_id: account.id, item_id: item.id }, `Usunąć ofertę „${item.title}"? Tego nie da się cofnąć.`, "Usuń");
      if (r) window.dispatchEvent(new Event("hashchange"));
    } catch (err) {
      fail(err);
    }
  }

  async function duplicate(item) {
    try {
      await tool("save_draft", {
        account_id: account.id,
        draft: { title: item.title, description: "", price: item.price ?? "", brand: item.brand || "", size: item.size || "", currency: item.currency || "", photos: [] },
      });
      toast("Dodano szkic. Otwórz go w zakładce Wystaw.");
    } catch (err) {
      fail(err);
    }
  }
}
