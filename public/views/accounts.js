import { add, api, avatar, copyText, fail, field, h, pill, runAction, state, table, toast, tool, ago } from "../lib.js";

const MARKETS = [
  "www.vinted.pl", "www.vinted.de", "www.vinted.fr", "www.vinted.co.uk", "www.vinted.lt",
  "www.vinted.cz", "www.vinted.es", "www.vinted.it", "www.vinted.nl", "www.vinted.be",
  "www.vinted.at", "www.vinted.pt", "www.vinted.sk", "www.vinted.hu", "www.vinted.ro",
  "www.vinted.se", "www.vinted.dk", "www.vinted.fi",
];

const LOGIN_MESSAGES = {
  bad_credentials: "Vinted odrzucił login lub hasło. Sprawdź dane i spróbuj ponownie.",
  blocked:
    "Vinted zablokował to połączenie ochroną antybotową, zanim sprawdził hasło — dlatego widzisz ten komunikat przy każdym haśle. Serwer nie ma jak przejść tego sprawdzenia, a niczego nie omijamy ani nie ponawiamy prób.",
  rejected:
    "Vinted odrzucił zapytanie logowania i nie podał powodu. Zwykle to ochrona antybotowa, ale odpowiedź nie zawiera rozpoznawalnych znaczników, więc nie da się tego potwierdzić. Szczegóły techniczne są poniżej.",
  expired: "Ta weryfikacja wygasła. Zacznij logowanie od nowa.",
  bad_code: "Vinted nie przyjął kodu. Sprawdź go i spróbuj jeszcze raz.",
  no_encryption: "Brak ENCRYPTION_KEY na serwerze — bez niego nie można bezpiecznie zapisać konta. Ustaw go na Vercel i wdróż ponownie.",
};

/** Polish wording for the cases where the server's message is English. */
function loginErrorText(err) {
  const d = err.details;
  if (err.kind === "unexpected" && d) {
    const page = /html/i.test(d.contentType || "") || (d.status >= 300 && d.status < 400);
    return `Vinted odpowiedział ${page ? "stroną internetową zamiast danych logowania" : "w nieoczekiwany sposób"} (HTTP ${d.status}). Najpewniej zmienił się adres lub format logowania — to nie wina hasła ani blokada antybotowa. Szczegóły techniczne są poniżej.`;
  }
  if (err.kind === "rate_limited") {
    if (d) return "Vinted ogranicza liczbę zapytań z tego serwera (HTTP 429). Spróbuj za kilka minut.";
    if (/wrong codes/i.test(err.message)) return "Za dużo błędnych kodów. Zacznij logowanie od nowa.";
    if (/Connection checks/i.test(err.message)) return "Sprawdzenie połączenia można wykonać najwyżej 10 razy na godzinę. Odczekaj chwilę.";
    return "Za dużo prób logowania na to konto (limit 3 na godzinę). Odczekaj — seria pomyłek może skończyć się zablokowaniem konta przez Vinted.";
  }
  return LOGIN_MESSAGES[err.kind] || err.message;
}

/** What Vinted actually answered, for pasting into a bug report. Never contains the password. */
function techDetails(d) {
  const rows = [
    ["Kod odpowiedzi", `HTTP ${d.status}`],
    ["Serwer", d.server || "—"],
    ["Typ treści", d.contentType || "—"],
    d.location ? ["Przekierowanie", d.location] : null,
    ["Znaczniki ochrony antybotowej", d.markers?.length ? d.markers.join(", ") : "brak"],
    d.hints?.length ? ["Wskazówki", d.hints.join("; ")] : null,
    ["Fragment odpowiedzi", d.snippet || "—"],
  ].filter(Boolean);
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  return h(
    "details",
    { class: "tech" },
    h("summary", {}, "Szczegóły techniczne"),
    h("pre", { class: "mono" }, text),
    h("button", { type: "button", class: "link small", onclick: () => copyText(text) }, "Skopiuj"),
  );
}

function loginErrorNode(err) {
  return h("div", {}, loginErrorText(err), err.details ? techDetails(err.details) : null);
}

const PROBE_VERDICTS = {
  wall: ["bad", "Vinted blokuje ten serwer ochroną antybotową, zanim w ogóle sprawdzi hasło. Dlatego komunikat o blokadzie pojawia się przy każdym haśle. Serwer nie ma jak przejść tego sprawdzenia — nie obchodzimy go i nie będziemy próbować."],
  reachable: ["ok", "Vinted odpowiada temu serwerowi na logowanie — ochrona antybotowa nie zablokowała zapytania. Jeśli logowanie mimo to pokazuje blokadę, dotyczy ona dopiero kroku z hasłem."],
  endpoint_missing: ["warn", "Adres logowania zwraca stronę internetową zamiast danych — prawdopodobnie się zmienił. To błąd po naszej stronie, nie Twojego hasła."],
  rate_limited: ["warn", "Vinted ogranicza liczbę zapytań z tego serwera (HTTP 429). Spróbuj za kilka minut."],
  network: ["bad", "Serwer nie może połączyć się z Vinted (błąd sieci)."],
  inconclusive: ["warn", "Vinted odrzucił zapytanie, ale w odpowiedzi nie ma rozpoznawalnych znaczników ochrony antybotowej. Skopiuj wynik i prześlij go, żeby można to ocenić."],
};
const PROBE_LABELS = {
  "Home page": "Strona główna",
  "Login endpoint (no credentials sent)": "Adres logowania (bez żadnych danych)",
  "Public API": "Publiczne API",
};
const PROBE_RESULTS = {
  api: "dane (JSON)",
  wall: "blokada antybotowa",
  rate_limited: "limit zapytań",
  rejected: "odrzucone bez powodu",
  not_api: "strona internetowa",
  network_error: "błąd sieci",
};

function probeCard(result) {
  const [kind, text] = PROBE_VERDICTS[result.verdict] || ["warn", result.summary];
  const raw = JSON.stringify(result, null, 2);
  return h(
    "div",
    { class: "card" },
    h("h2", {}, "Wynik sprawdzenia połączenia"),
    h("p", { class: "muted small" }, `Rynek: ${result.domain}. Wysłano 3 zapytania bez żadnych danych konta.`),
    h("div", { class: `notice ${kind}` }, text),
    table(
      ["Sprawdzenie", "Wynik", "HTTP", "Serwer", "Znaczniki blokady"],
      result.checks.map((c) => [
        PROBE_LABELS[c.label] || c.label,
        PROBE_RESULTS[c.verdict] || c.verdict,
        c.evidence ? c.evidence.status : "—",
        c.evidence?.server || "—",
        c.evidence ? (c.evidence.markers.length ? c.evidence.markers.join(", ") : "brak") : c.error || "—",
      ]),
    ),
    result.checks.map((c) =>
      c.evidence?.snippet || c.error
        ? h("details", { class: "tech" }, h("summary", {}, `Odpowiedź: ${PROBE_LABELS[c.label] || c.label}`), h("pre", { class: "mono" }, c.error ? `Błąd: ${c.error}` : c.evidence.snippet))
        : null,
    ),
    h("div", { class: "row", style: "margin-top:.8rem" }, h("button", { type: "button", onclick: () => copyText(raw) }, "Skopiuj wynik")),
  );
}

export async function render(root, ctx) {
  const data = await ctx.refreshAccounts();
  const wizardBox = h("div");
  const logBox = h("div");
  const probeBox = h("div");
  const probeMarket = h("select", { "aria-label": "Rynek do sprawdzenia", style: "width:auto" }, MARKETS.map((m) => h("option", { value: m }, m)));
  probeMarket.value = data.defaultDomain || MARKETS[0];

  add(root, 
    state.me?.setup && state.me.setup.durableStorage === false
      ? h(
          "div",
          { class: "notice warn" },
          "Brak trwałego magazynu (Upstash Redis): podłączone konta, obserwowani i limity znikną, gdy funkcja na Vercel się wyłączy. Ustaw UPSTASH_REDIS_REST_URL i UPSTASH_REDIS_REST_TOKEN, zanim podłączysz konta.",
        )
      : null,
    !data.encryptionKey
      ? h(
          "div",
          { class: "notice warn" },
          "Brak ENCRYPTION_KEY: nie da się podłączyć konta przez panel. Wygeneruj klucz (openssl rand -hex 32), dodaj go w ustawieniach projektu na Vercel i wdróż ponownie.",
        )
      : null,
    h(
      "div",
      { class: "row", style: "margin-bottom:1rem" },
      h("button", { class: "primary", type: "button", onclick: () => openWizard() }, "Dodaj konto"),
      h("span", { style: "margin-left:auto" }),
      probeMarket,
      h("button", { type: "button", onclick: runProbe }, "Sprawdź połączenie z Vinted"),
    ),
    wizardBox,
    probeBox,
    state.accounts.length === 0
      ? h("div", { class: "empty" }, "Brak podłączonych kont.")
      : table(
          ["Konto", "Rynek", "Źródło", "Status", "Sesja od", ""],
          state.accounts.map((a) => [
            h("div", { class: "row" }, avatar(a.avatarUrl), h("div", {}, h("b", {}, a.label), h("div", { class: "muted small" }, a.login ? `@${a.login}` : a.id))),
            a.domain,
            a.source === "env" ? "zmienna środowiskowa" : "panel",
            a.status === "connected"
              ? pill("połączone", "ok")
              : h("span", {}, pill("wymaga logowania", "bad"), a.statusReason ? h("div", { class: "muted small" }, a.statusReason) : null),
            a.tokenSetAt ? ago(a.tokenSetAt) : "—",
            h(
              "div",
              { class: "row" },
              h("button", { type: "button", onclick: () => test(a) }, "Testuj"),
              a.source === "panel" ? h("button", { type: "button", onclick: () => openWizard(a) }, "Zaloguj ponownie") : null,
              a.source === "panel" ? h("button", { type: "button", class: "danger", onclick: () => remove(a) }, "Usuń") : null,
            ),
          ]),
        ),
    h("div", { class: "row", style: "margin-top:1.5rem" }, h("button", { type: "button", class: "link", onclick: showLog }, "Pokaż dziennik prób logowania")),
    logBox,
  );

  async function test(account) {
    try {
      const r = await tool("test_account", { account_id: account.id });
      if (r.ok) toast(`Sesja działa${r.login ? ` — @${r.login}` : ""}`);
      else toast(r.detail || "Test nieudany", true);
      await ctx.refreshAccounts();
      window.dispatchEvent(new Event("hashchange"));
    } catch (err) {
      fail(err);
    }
  }

  async function remove(account) {
    try {
      const r = await runAction("remove_account", { account_id: account.id }, `Usunąć konto „${account.label}"?`, "Usuń");
      if (r) {
        await ctx.refreshAccounts();
        location.reload();
      }
    } catch (err) {
      fail(err);
    }
  }

  async function runProbe(event) {
    const button = event.currentTarget;
    button.disabled = true;
    probeBox.replaceChildren(h("p", { class: "muted" }, "Sprawdzam, co Vinted odpowiada temu serwerowi (3 zapytania, bez żadnych danych logowania)…"));
    try {
      probeBox.replaceChildren(probeCard(await tool("diagnose_login", { domain: probeMarket.value })));
    } catch (err) {
      probeBox.replaceChildren();
      fail(err);
    } finally {
      button.disabled = false;
    }
  }

  async function showLog() {
    try {
      const { log } = await api("/login-log");
      logBox.replaceChildren(
        log.length === 0
          ? h("p", { class: "muted" }, "Brak prób logowania.")
          : table(["Kiedy", "Rynek", "Kto", "Wynik"], log.map((e) => [ago(e.at), e.domain, e.who, e.outcome])),
      );
    } catch (err) {
      fail(err);
    }
  }

  function openWizard(existing) {
    const error = h("div", { class: "notice bad", hidden: true });
    const email = h("input", { type: "text", autocomplete: "off", required: true, placeholder: "e-mail lub login" });
    const password = h("input", { type: "password", autocomplete: "new-password", required: true });
    const label = h("input", { type: "text", placeholder: "np. Konto główne", value: existing?.label || "" });
    const market = h("select", {}, MARKETS.map((m) => h("option", { value: m }, m)));
    market.value = existing?.domain || data.defaultDomain || MARKETS[0];
    const submit = h("button", { class: "primary", type: "submit" }, "Zaloguj");

    const show = (err) => {
      error.replaceChildren(loginErrorNode(err));
      error.hidden = false;
    };

    const form = h(
      "form",
      {
        class: "card",
        onsubmit: async (e) => {
          e.preventDefault();
          error.hidden = true;
          submit.disabled = true;
          try {
            const result = await api("/account-login", {
              method: "POST",
              body: {
                domain: market.value,
                email: email.value,
                password: password.value,
                label: label.value,
                ...(existing ? { accountId: existing.id } : {}),
              },
            });
            password.value = "";
            if (result.status === "challenge") askCode(result);
            else done(result);
          } catch (err) {
            password.value = "";
            show(err);
          } finally {
            submit.disabled = false;
          }
        },
      },
      h("h2", {}, existing ? `Zaloguj ponownie: ${existing.label}` : "Podłącz konto Vinted"),
      h("p", { class: "muted small" }, "Podajesz dane logowania Vinted. Hasło jest użyte jednorazowo do zalogowania i nigdzie nie jest zapisywane — serwer trzyma tylko zaszyfrowane tokeny sesji. Kod weryfikacyjny (SMS) wpiszesz w następnym kroku."),
      field("Rynek", market),
      field("Login (e-mail)", email),
      field("Hasło", password),
      field("Nazwa konta (opcjonalnie)", label),
      error,
      h("div", { class: "row" }, submit, h("button", { type: "button", onclick: () => wizardBox.replaceChildren() }, "Anuluj")),
    );
    wizardBox.replaceChildren(form);
    email.focus();

    function askCode(challenge) {
      const code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", required: true, maxlength: "10" });
      const err = h("div", { class: "notice bad", hidden: true });
      const go = h("button", { class: "primary", type: "submit" }, "Potwierdź kod");
      wizardBox.replaceChildren(
        h(
          "form",
          {
            class: "card",
            onsubmit: async (e) => {
              e.preventDefault();
              err.hidden = true;
              go.disabled = true;
              try {
                done(await api("/account-verify", { method: "POST", body: { loginId: challenge.loginId, code: code.value } }));
              } catch (ex) {
                err.replaceChildren(loginErrorNode(ex));
                err.hidden = false;
                if (ex.kind === "expired" || ex.kind === "blocked" || ex.kind === "rate_limited") {
                  setTimeout(() => openWizard(existing), 2500);
                }
              } finally {
                go.disabled = false;
              }
            },
          },
          h("h2", {}, "Kod weryfikacyjny"),
          h(
            "p",
            { class: "muted small" },
            `Vinted wysłał kod${challenge.method === "sms" ? " SMS-em" : challenge.method === "email" ? " e-mailem" : ""}${challenge.hint ? ` (${challenge.hint})` : ""}. Wpisz go poniżej. Ważny jest kilka minut; masz 5 prób.`,
          ),
          field("Kod", code),
          err,
          h("div", { class: "row" }, go, h("button", { type: "button", onclick: () => openWizard(existing) }, "Zacznij od nowa")),
        ),
      );
      code.focus();
    }

    async function done(result) {
      wizardBox.replaceChildren(
        h(
          "div",
          { class: "notice ok" },
          `Połączono jako ${result.account.login ? `@${result.account.login}` : result.account.label}.`,
          result.warning ? h("div", { class: "small" }, result.warning) : null,
        ),
      );
      await ctx.refreshAccounts();
      setTimeout(() => location.reload(), 1200);
    }
  }
}
