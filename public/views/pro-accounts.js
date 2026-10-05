import { api, copyText, fail, field, h, pill, put, runAction, table, tool, ago } from "../lib.js";

// Vinted Pro (the official API): accounts and the connection check.

const VERDICTS = {
  ok: ["ok", "Vinted Pro przyjął podpis i token. Połączenie działa."],
  unauthorized: [
    "bad",
    "Vinted Pro odrzucił podpis lub token (401). Sprawdź, czy token jest cały („klucz_dostępu,klucz_podpisu”), czy należy do tego samego środowiska (sandbox i produkcja mają osobne tokeny) i czy zegar serwera jest poprawny.",
  ],
  forbidden: [
    "bad",
    "Vinted Pro odmówił dostępu (403). Konto musi być na liście dozwolonych (allowlist) Vinted Pro Integrations, a jego rynek obsługiwany przez API. Dokumentacja wymienia AT, BE, DE, ES, FR, IT, LU, NL, PT i UK — Polski nie ma na tej liście. Zapytaj Vinted, czy Twoje konto jest obsługiwane.",
  ],
  rate_limited: ["warn", "Vinted Pro ogranicza liczbę zapytań (429). Spróbuj za chwilę."],
  server_error: ["warn", "Vinted Pro zwrócił błąd serwera. Spróbuj ponownie za chwilę."],
  network: ["bad", "Serwer nie może połączyć się z Vinted Pro (błąd sieci)."],
  config: ["bad", "Integracja nie jest skonfigurowana (np. zmieniono ENCRYPTION_KEY). Dodaj token ponownie."],
  unexpected: ["warn", "Nieoczekiwana odpowiedź Vinted Pro. Skopiuj wynik i prześlij go do oceny."],
};

const ENV_LABELS = { sandbox: "sandbox (testy)", production: "produkcja" };

function resultCard(result) {
  const [kind, text] = VERDICTS[result.verdict] || ["warn", result.message || "Brak werdyktu."];
  const raw = JSON.stringify(result, null, 2);
  const rows = [
    ["Konto", result.account],
    ["Środowisko", ENV_LABELS[result.environment] || result.environment],
    ["Adres API", result.baseUrl],
    result.status ? ["Kod odpowiedzi", `HTTP ${result.status}${result.code ? ` (${result.code})` : ""}`] : null,
    result.server ? ["Czas serwera", `${result.server.time} (unix ${result.server.unix})`] : null,
    result.ontology ? ["Kategorie w ontologii", `${result.ontology.categories.total} (w tym ${result.ontology.categories.leaves} liści)`] : null,
    result.ontology ? ["Sekcje ontologii", result.ontology.topLevelKeys.map((k) => `${k.key}${k.count !== null ? ` (${k.count})` : ""}`).join(", ")] : null,
  ].filter(Boolean);
  return h(
    "div",
    { class: "card" },
    h("h2", {}, "Wynik sprawdzenia połączenia"),
    h("div", { class: `notice ${kind}` }, text),
    result.hints?.length ? h("ul", {}, result.hints.map((x) => h("li", {}, x))) : null,
    table(["", ""], rows),
    h("div", { class: "row", style: "margin-top:.8rem" }, h("button", { type: "button", onclick: () => copyText(raw) }, "Skopiuj wynik")),
  );
}

/** The "Vinted Pro" card of the Accounts view. */
export function proAccountsCard() {
  const root = h("div", { class: "card" });
  const formBox = h("div");
  const resultBox = h("div", { style: "margin-top:1rem" });
  const listBox = h("div");
  let accounts = [];

  async function reload() {
    try {
      accounts = (await tool("pro_list_accounts")).accounts;
    } catch (err) {
      fail(err);
    }
    drawList();
  }

  async function check(id, button) {
    if (button) button.disabled = true;
    put(resultBox, h("p", { class: "muted" }, "Sprawdzam, co Vinted Pro odpowiada (jedno podpisane zapytanie)…"));
    try {
      put(resultBox, resultCard(await tool("diagnose_pro", { account_id: id })));
      await reload();
    } catch (err) {
      put(resultBox);
      fail(err);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function remove(account) {
    try {
      if (await runAction("pro_remove_account", { account_id: account.id }, `Usunąć konto Pro „${account.label}"? Oferty u Vinted zostają.`, "Usuń")) {
        put(resultBox);
        await reload();
      }
    } catch (err) {
      fail(err);
    }
  }

  function drawList() {
    put(
      listBox,
      accounts.length === 0
        ? h("div", { class: "empty" }, "Brak podłączonych kont Vinted Pro.")
        : table(
            ["Konto", "Środowisko", "Status", "Ostatnio działało", ""],
            accounts.map((a) => [
              h("div", {}, h("b", {}, a.label), h("div", { class: "muted small mono" }, a.id)),
              pill(ENV_LABELS[a.env] || a.env, a.env === "production" ? "ok" : "warn"),
              a.status === "connected"
                ? pill("token przyjęty", "ok")
                : h("span", {}, pill("token odrzucony", "bad"), a.statusReason ? h("div", { class: "muted small" }, a.statusReason) : null),
              a.lastOkAt ? ago(a.lastOkAt) : "jeszcze nie sprawdzono",
              h(
                "div",
                { class: "row" },
                h("button", { type: "button", onclick: (e) => check(a.id, e.currentTarget) }, "Testuj"),
                h("button", { type: "button", onclick: () => openForm(a) }, "Zmień token"),
                h("button", { type: "button", class: "danger", onclick: () => remove(a) }, "Usuń"),
              ),
            ]),
          ),
    );
  }

  function openForm(existing) {
    const error = h("div", { class: "notice bad", hidden: true });
    const label = h("input", { type: "text", required: true, maxlength: "60", placeholder: "np. Sklep główny", value: existing?.label || "" });
    const env = h(
      "select",
      {},
      h("option", { value: "sandbox" }, "Sandbox (testy)"),
      h("option", { value: "production" }, "Produkcja"),
    );
    env.value = existing?.env || "sandbox";
    const token = h("input", { type: "password", autocomplete: "off", required: true, spellcheck: "false", placeholder: "klucz_dostępu,klucz_podpisu" });
    const submit = h("button", { class: "primary", type: "submit" }, existing ? "Zapisz token" : "Dodaj konto");

    put(
      formBox,
      h(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            error.hidden = true;
            submit.disabled = true;
            try {
              const r = await api("/pro-account", {
                method: "POST",
                body: { label: label.value, env: env.value, token: token.value, ...(existing ? { accountId: existing.id } : {}) },
              });
              token.value = "";
              put(formBox);
              await reload();
              await check(r.account.id);
            } catch (err) {
              token.value = "";
              error.textContent = err.message;
              error.hidden = false;
            } finally {
              submit.disabled = false;
            }
          },
        },
        h("h3", {}, existing ? `Zmień token: ${existing.label}` : "Dodaj konto Vinted Pro"),
        field("Nazwa konta", label),
        field("Środowisko", env),
        field("Token z portalu Vinted Pro", token),
        h(
          "p",
          { class: "muted small" },
          "Token to jeden ciąg z portalu Vinted Pro: klucz_dostępu,klucz_podpisu. Sandbox i produkcja mają osobne tokeny. Zapisujemy go zaszyfrowanego i nigdy nie jest wyświetlany ani zwracany; wpisujesz go tylko tutaj, nie w żadnym narzędziu ani w rozmowie.",
        ),
        error,
        h("div", { class: "row" }, submit, h("button", { type: "button", onclick: () => put(formBox) }, "Anuluj")),
      ),
    );
    label.focus();
  }

  put(
    root,
    h("h2", {}, "Vinted Pro (oficjalne API)"),
    h(
      "p",
      { class: "muted small" },
      "Oferty, zamówienia i etykiety przez oficjalne Vinted Pro Integrations. Dostęp mają tylko konta z listy dozwolonych (allowlist) Vinted. Dokumentacja wymienia rynki AT, BE, DE, ES, FR, IT, LU, NL, PT i UK — Polski i PLN nie ma na tej liście, więc zapytaj Vinted, czy Twoje konto jest obsługiwane. Zacznij od sandboxu.",
    ),
    h("div", { class: "row", style: "margin-bottom:.8rem" }, h("button", { class: "primary", type: "button", onclick: () => openForm() }, "Dodaj konto Vinted Pro")),
    formBox,
    listBox,
    resultBox,
  );
  void reload();
  return root;
}
