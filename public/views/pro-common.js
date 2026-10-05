import { h, pill, tool } from "../lib.js";

// Pieces shared by the Vinted Pro views.

const KEY = "proAccountId";

export async function loadProAccounts() {
  return (await tool("pro_list_accounts")).accounts;
}

/** The account a view acts on: the one chosen last, else the first that works. */
export function pickAccount(accounts) {
  const saved = localStorage.getItem(KEY);
  return accounts.find((a) => a.id === saved) || accounts.find((a) => a.status === "connected") || accounts[0] || null;
}

export function noAccountNotice() {
  return h("div", { class: "notice warn" }, "Najpierw dodaj konto Vinted Pro w zakładce ", h("a", { href: "#/accounts" }, "Konta"), ".");
}

export function envPill(env) {
  return pill(env === "production" ? "produkcja" : "sandbox (testy)", env === "production" ? "ok" : "warn");
}

/** Account picker (when there are several) with the environment, for the top of a view. */
export function accountBar(accounts, current, onChange) {
  const select =
    accounts.length > 1
      ? h(
          "select",
          {
            "aria-label": "Konto Vinted Pro",
            style: "width:auto",
            onchange: (e) => {
              localStorage.setItem(KEY, e.target.value);
              onChange(accounts.find((a) => a.id === e.target.value));
            },
          },
          accounts.map((a) => h("option", { value: a.id, selected: a.id === current.id }, a.label)),
        )
      : h("b", {}, current.label);
  return h(
    "div",
    { class: "row", style: "margin-bottom:1rem" },
    select,
    envPill(current.env),
    current.status !== "connected" ? pill("token odrzucony", "bad") : null,
  );
}

/** Vinted may send a price as a number, a string or {amount, currency_code}. */
export function showPrice(price) {
  if (price === null || price === undefined || price === "") return "—";
  if (typeof price === "object") {
    const amount = price.amount ?? price.value ?? "";
    const cur = price.currency_code ?? price.currency ?? "";
    return `${amount} ${cur}`.trim() || "—";
  }
  return String(price);
}

/** The list inside an answer, whichever of the likely shapes it has. */
export function listIn(data, ...names) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const name of ["items", "orders", ...names]) if (Array.isArray(data[name])) return data[name];
  }
  return [];
}

export const shortId = (id) => (String(id).length > 14 ? `${String(id).slice(0, 8)}…` : String(id));

/** A small collapsible block with the raw answer, for comparing with what the page shows. */
export function rawBlock(title, data) {
  return h("details", { class: "tech" }, h("summary", {}, title), h("pre", { class: "mono" }, JSON.stringify(data, null, 2).slice(0, 20000)));
}

const STATUS_KIND = {
  PUBLISHED: "ok",
  CREATED: "ok",
  DRAFT: "",
  IN_PROGRESS: "warn",
  SOLD: "ok",
  DELETED: "bad",
  CREATE_FAILED: "bad",
  UPDATE_FAILED: "bad",
  DELETE_FAILED: "bad",
};

export function statusPill(status) {
  if (!status) return "—";
  return pill(String(status), STATUS_KIND[String(status).toUpperCase()] ?? "");
}
