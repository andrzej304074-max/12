import { api, fail, h, state, tool } from "./lib.js";

// Views of the official Vinted Pro integration: always there.
const PRO_VIEWS = [
  ["pro-dashboard", "Pulpit"],
  ["pro-items", "Oferty"],
  ["pro-sell", "Wystaw"],
  ["pro-orders", "Zamówienia"],
  ["pro-events", "Zdarzenia"],
];
const OFFICIAL_VIEWS = [...PRO_VIEWS, ["accounts", "Konta"], ["mcp", "MCP"]];

// Views built on the unofficial consumer API: shown only when the server has
// ENABLE_UNOFFICIAL=true (the page learns it from /me). The Pro views stay,
// marked as such.
const ALL_VIEWS = [
  ["messages", "Wiadomości"],
  ["dashboard", "Pulpit"],
  ...PRO_VIEWS.map(([id, label]) => [id, `Pro: ${label}`]),
  ["accounts", "Konta"],
  ["watches", "Obserwowani"],
  ["finds", "Znaleziska"],
  ["research", "Research"],
  ["sell", "Wystaw"],
  ["listings", "Moje oferty"],
  ["automation", "Automatyka"],
  ["mcp", "MCP"],
];

const unofficial = () => Boolean(state.me?.features?.unofficial);
const views = () => (unofficial() ? ALL_VIEWS : OFFICIAL_VIEWS);

const $ = (id) => document.getElementById(id);
const badges = { messages: 0, finds: 0 };
let cleanups = [];
let renderToken = 0;

// ---------------------------------------------------------------- theme
const THEMES = ["auto", "light", "dark"];
function applyTheme() {
  const theme = localStorage.getItem("theme") || "auto";
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  $("theme").textContent = `Motyw: ${{ auto: "auto", light: "jasny", dark: "ciemny" }[theme]}`;
}
$("theme").addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf(localStorage.getItem("theme") || "auto") + 1) % THEMES.length];
  localStorage.setItem("theme", next);
  applyTheme();
});
applyTheme();

// ---------------------------------------------------------------- login
function showLogin(passwordConfigured = true) {
  $("app").hidden = true;
  $("login").hidden = false;
  $("login-note").textContent = passwordConfigured
    ? "Zaloguj się hasłem do panelu."
    : "Panel jest wyłączony: ustaw ADMIN_PASSWORD w zmiennych projektu na Vercel i wdróż ponownie.";
  $("login-form").querySelector("button").disabled = !passwordConfigured;
  $("login-pass").focus();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("login-error");
  error.hidden = true;
  try {
    await api("/login", { method: "POST", body: { password: $("login-pass").value } });
    $("login-pass").value = "";
    await start();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

$("logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

window.addEventListener("session-expired", () => showLogin());

// ---------------------------------------------------------------- shell
export async function refreshAccounts() {
  const data = await api("/accounts");
  state.accounts = data.accounts;
  if (state.accountId && !state.accounts.some((a) => a.id === state.accountId)) {
    state.accountId = "";
    localStorage.removeItem("accountId");
  }
  renderSwitch();
  return data;
}

function renderSwitch() {
  const box = $("account-switch");
  box.replaceChildren();
  if (!unofficial() || state.accounts.length === 0) return;
  const select = h(
    "select",
    {
      "aria-label": "Konto",
      onchange: (e) => {
        state.accountId = e.target.value;
        localStorage.setItem("accountId", state.accountId);
        route();
      },
    },
    h("option", { value: "" }, "Wszystkie konta"),
    state.accounts.map((a) =>
      h("option", { value: a.id, selected: a.id === state.accountId }, `${a.label}${a.login ? ` (@${a.login})` : ""}${a.status === "needs_login" ? " — wymaga logowania" : ""}`),
    ),
  );
  select.value = state.accountId;
  box.append(select);
}

function renderNav(active) {
  $("nav").replaceChildren(
    ...views().map(([id, label]) =>
      h(
        "a",
        { href: `#/${id}`, class: id === active ? "active" : "" },
        label,
        badges[id] ? h("span", { class: "badge" }, badges[id]) : null,
      ),
    ),
  );
}

export function setBadge(id, count) {
  badges[id] = count;
  renderNav(currentView());
}

function currentView() {
  const id = location.hash.replace(/^#\//, "");
  return views().some(([v]) => v === id) ? id : views()[0][0];
}

async function route() {
  const id = currentView();
  const token = ++renderToken;
  cleanups.forEach((fn) => fn());
  cleanups = [];
  renderNav(id);
  $("title").textContent = views().find(([v]) => v === id)[1];
  const root = $("view");
  root.replaceChildren(h("p", { class: "muted" }, "Ładowanie…"));
  try {
    const mod = await import(`./views/${id}.js`);
    if (token !== renderToken) return;
    root.replaceChildren();
    await mod.render(root, {
      onCleanup: (fn) => cleanups.push(fn),
      isCurrent: () => token === renderToken,
      refreshAccounts,
      setBadge,
    });
  } catch (err) {
    if (token === renderToken) {
      root.replaceChildren(h("div", { class: "notice bad" }, `Nie udało się wczytać widoku: ${err.message}`));
    }
  }
}

async function pollBadges() {
  if (!unofficial() || document.hidden || state.accounts.length === 0) return;
  try {
    const inbox = await tool("list_conversations", { all_accounts: true, unread_only: true });
    badges.messages = inbox.unread || 0;
    let finds = 0;
    for (const a of state.accounts.filter((x) => x.status !== "needs_login")) {
      const r = await tool("list_new_finds", { account_id: a.id, limit: 200 });
      finds += r.count || 0;
    }
    badges.finds = finds;
    renderNav(currentView());
  } catch {
    /* badges are a convenience; stay quiet */
  }
}

/** Where to land: messages if the consumer features are on, else the Pro dashboard once an account exists. */
async function defaultView() {
  if (unofficial() && state.accounts.length) return "#/messages";
  try {
    return (await tool("pro_list_accounts")).accounts.length ? "#/pro-dashboard" : "#/accounts";
  } catch {
    return "#/accounts";
  }
}

async function start() {
  try {
    const me = await api("/me");
    state.me = me;
    if (!me.authenticated) {
      showLogin(me.passwordConfigured);
      return;
    }
    $("login").hidden = true;
    $("app").hidden = false;
    await refreshAccounts();
    if (!location.hash) location.hash = await defaultView();
    await route();
    pollBadges();
  } catch (err) {
    fail(err);
  }
}

window.addEventListener("hashchange", route);
setInterval(pollBadges, 60_000);
start();
