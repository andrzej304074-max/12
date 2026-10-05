import { add, api, avatar, fail, field, h, pill, runAction, state, table, toast, tool, ago } from "../lib.js";

const MARKETS = [
  "www.vinted.pl", "www.vinted.de", "www.vinted.fr", "www.vinted.co.uk", "www.vinted.lt",
  "www.vinted.cz", "www.vinted.es", "www.vinted.it", "www.vinted.nl", "www.vinted.be",
  "www.vinted.at", "www.vinted.pt", "www.vinted.sk", "www.vinted.hu", "www.vinted.ro",
  "www.vinted.se", "www.vinted.dk", "www.vinted.fi",
];

const LOGIN_MESSAGES = {
  bad_credentials: "Vinted odrzucił login lub hasło. Sprawdź dane i spróbuj ponownie.",
  blocked:
    "Vinted zażądał weryfikacji antybotowej (CAPTCHA lub limit), której serwer nie przejdzie. Niczego nie obchodzimy i nie ponawiamy prób — spróbuj ponownie później.",
  expired: "Ta weryfikacja wygasła. Zacznij logowanie od nowa.",
  bad_code: "Vinted nie przyjął kodu. Sprawdź go i spróbuj jeszcze raz.",
  no_encryption: "Brak ENCRYPTION_KEY na serwerze — bez niego nie można bezpiecznie zapisać konta. Ustaw go na Vercel i wdróż ponownie.",
};

export async function render(root, ctx) {
  const data = await ctx.refreshAccounts();
  const wizardBox = h("div");
  const logBox = h("div");

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
    h("div", { class: "row", style: "margin-bottom:1rem" }, h("button", { class: "primary", type: "button", onclick: () => openWizard() }, "Dodaj konto")),
    wizardBox,
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

    const show = (message) => {
      error.textContent = message;
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
            show(LOGIN_MESSAGES[err.kind] || err.message);
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
                err.textContent = LOGIN_MESSAGES[ex.kind] || ex.message;
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
