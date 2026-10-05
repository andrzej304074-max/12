// Shared helpers for the panel. No framework, no innerHTML: every piece of
// text, including messages written by other people, goes in as a text node.

export const state = {
  accounts: [],
  accountId: localStorage.getItem("accountId") || "",
  me: null,
};

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [key, val] of Object.entries(attrs || {})) {
    if (val === false || val === null || val === undefined) continue;
    if (key === "class") el.className = val;
    else if (key === "value") value = val;
    else if (key === "checked") el.checked = Boolean(val);
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), val);
    else el.setAttribute(key, val === true ? "" : val);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

/** Replaces the children of an element; unlike replaceChildren it accepts arrays and skips empty values. */
export function put(el, ...kids) {
  el.replaceChildren(
    ...kids
      .flat(Infinity)
      .filter((k) => k !== null && k !== undefined && k !== false)
      .map((k) => (k.nodeType ? k : document.createTextNode(String(k)))),
  );
}

/** Appends children, skipping null/false (Node.append would print the word "null"). */
export function add(el, ...kids) {
  el.append(
    ...kids
      .flat(Infinity)
      .filter((k) => k !== null && k !== undefined && k !== false)
      .map((k) => (k.nodeType ? k : document.createTextNode(String(k)))),
  );
}

/** Only https links and images from the network are ever put into the page. */
export function safeUrl(url) {
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : "";
}

export function money(price, currency) {
  if (price === null || price === undefined) return "—";
  return `${price} ${currency || ""}`.trim();
}

export function ago(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return String(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "przed chwilą";
  if (s < 3600) return `${Math.floor(s / 60)} min temu`;
  if (s < 86400) return `${Math.floor(s / 3600)} h temu`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d temu`;
  return new Date(t).toLocaleDateString("pl-PL");
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api/app${path}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && data?.error === "unauthenticated") {
      window.dispatchEvent(new Event("session-expired"));
    }
    const err = new Error(data?.message || res.statusText);
    err.status = res.status;
    err.kind = data?.error;
    throw err;
  }
  return data;
}

/** Runs an MCP tool through the panel backend; throws on a tool error. */
export async function tool(name, args = {}) {
  const r = await api("/tool", { method: "POST", body: { name, arguments: args } });
  if (r.isError) throw new Error(r.text);
  return r.data ?? r.text;
}

/** For actions the person just triggered by hand: the click is the confirmation. */
export function sendDirect(name, args = {}) {
  return tool(name, { ...args, confirm: true });
}

export function toast(message, bad = false) {
  const el = h("div", { class: `toast${bad ? " bad" : ""}` }, message);
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), bad ? 7000 : 3500);
}

/** Shows an error from a failed call; keeps the UI usable. */
export function fail(err) {
  toast(err?.message || String(err), true);
}

export function dialog({ title, body, confirmLabel = "OK", cancelLabel = "Anuluj", danger = false, disabled = false }) {
  const el = document.getElementById("dialog");
  return new Promise((resolve) => {
    const done = (value) => {
      el.close();
      el.replaceChildren();
      resolve(value);
    };
    el.replaceChildren(
      h("h2", {}, title),
      body || "",
      h(
        "div",
        { class: "row" },
        cancelLabel ? h("button", { type: "button", onclick: () => done(false) }, cancelLabel) : null,
        h(
          "button",
          { type: "button", class: danger ? "primary danger" : "primary", disabled, onclick: () => done(true) },
          confirmLabel,
        ),
      ),
    );
    el.oncancel = (e) => {
      e.preventDefault();
      done(false);
    };
    el.showModal();
  });
}

const META_KEYS = new Set(["preview", "sent", "next", "account", "action", "allowedNow", "blockedBecause"]);

/**
 * Two-step action for high-impact things: ask the tool for a preview, show
 * exactly what would be sent, and only send after the person confirms.
 */
export async function runAction(name, args, title, confirmLabel = "Wyślij") {
  const preview = await tool(name, args);
  if (!preview.preview) return preview; // the tool refused, e.g. a draft with blockers
  const shown = Object.fromEntries(Object.entries(preview).filter(([k]) => !META_KEYS.has(k)));
  const blocked =
    preview.allowedNow === false || (preview.likeAllowed === false && preview.offerAllowed === false);
  const ok = await dialog({
    title,
    body: h(
      "div",
      {},
      h("pre", { class: "mono" }, JSON.stringify(shown, null, 2)),
      blocked ? h("div", { class: "notice bad" }, `Zablokowane: ${preview.blockedBecause || "limit wyczerpany"}`) : null,
    ),
    confirmLabel,
    disabled: blocked,
  });
  if (!ok) return null;
  const result = await tool(name, { ...args, confirm: true });
  toast("Gotowe");
  return result;
}

export function selectedAccount() {
  return state.accounts.find((a) => a.id === state.accountId) || null;
}

/** The account a single-account view acts on: the selected one, else the first usable. */
export function currentAccount() {
  return (
    selectedAccount() ||
    state.accounts.find((a) => a.status !== "needs_login") ||
    state.accounts[0] ||
    null
  );
}

export function accountArgs() {
  const account = currentAccount();
  return account ? { account_id: account.id } : {};
}

export function accountLabel(id) {
  return state.accounts.find((a) => a.id === id)?.label || id;
}

export function avatar(url, size) {
  const src = safeUrl(url);
  return src
    ? h("img", { class: "avatar", src, alt: "", loading: "lazy", style: size ? `width:${size}px;height:${size}px` : false })
    : h("span", { class: "avatar", style: size ? `width:${size}px;height:${size}px` : false });
}

export function pill(text, kind) {
  return h("span", { class: `pill ${kind || ""}` }, text);
}

export function table(headers, rows) {
  return h(
    "div",
    { class: "tablewrap" },
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, headers.map((x) => h("th", {}, x)))),
      h("tbody", {}, rows.map((cells) => h("tr", {}, cells.map((c) => h("td", {}, c))))),
    ),
  );
}

export function field(label, input) {
  return h("div", { class: "field" }, h("label", {}, label), input);
}

/** Resizes a photo in the browser so it fits Vercel's request limit. */
export async function shrinkImage(file, maxSide = 1600, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
  return { base64: String(dataUrl).split(",")[1], preview: dataUrl, bytes: blob.size };
}
