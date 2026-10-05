import { add, api, fail, field, h, table, toast, tool } from "../lib.js";

export async function render(root) {
  let config;
  let tools = [];
  try {
    config = await api("/mcp-config");
    tools = (await api("/tools")).tools;
  } catch (err) {
    fail(err);
    return;
  }

  const command = h("pre", { class: "mono", style: "white-space:pre-wrap;word-break:break-all;background:var(--bg);padding:.6rem;border-radius:6px" }, config.command);
  const tokenNote = h("p", { class: "muted small" }, config.authConfigured ? "Token MCP jest ustawiony w zmiennych środowiskowych (MCP_AUTH_TOKEN)." : "MCP_AUTH_TOKEN nie jest ustawiony — na produkcji endpoint odmówi obsługi.");

  const pick = h("select", { onchange: fillArgs }, tools.map((t) => h("option", { value: t.name }, t.name)));
  const description = h("p", { class: "muted small" });
  const args = h("textarea", { rows: "7", class: "mono", spellcheck: "false" });
  const out = h("pre", { class: "mono", style: "white-space:pre-wrap;word-break:break-word;background:var(--bg);padding:.6rem;border-radius:6px;max-height:24rem;overflow:auto" });

  add(root, 
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Podłączenie klienta MCP"),
      h("p", {}, "Adres endpointu: ", h("span", { class: "mono" }, config.endpoint)),
      tokenNote,
      command,
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", onclick: reveal }, "Pokaż token w poleceniu"),
        h("button", { type: "button", onclick: () => copy(command.textContent) }, "Kopiuj polecenie"),
      ),
      h("p", { class: "muted small" }, "Konta, limity, obserwowani i szkice są wspólne: to, co ustawisz tu, widzi MCP, i odwrotnie."),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Zaawansowane: wywołaj narzędzie"),
      h("p", { class: "muted small" }, "Surowe wywołanie dowolnego narzędzia MCP. Narzędzia zmieniające dane na Vinted wysyłają dopiero z \"confirm\": true — bez niego zwracają podgląd."),
      field("Narzędzie", pick),
      description,
      field("Argumenty (JSON)", args),
      h("button", { type: "button", class: "primary", onclick: run }, "Wywołaj"),
      out,
    ),
    h("div", { class: "card" }, h("h2", {}, `Narzędzia (${tools.length})`), table(["Nazwa", "Opis"], tools.map((t) => [h("span", { class: "mono" }, t.name), h("span", { class: "muted" }, t.description)]))),
  );

  function fillArgs() {
    const t = tools.find((x) => x.name === pick.value);
    description.textContent = t?.description || "";
    const example = {};
    for (const key of t?.inputSchema?.required || []) example[key] = "";
    args.value = JSON.stringify(example, null, 2);
  }

  async function run() {
    let parsed;
    try {
      parsed = args.value.trim() ? JSON.parse(args.value) : {};
    } catch {
      return toast("Argumenty nie są poprawnym JSON-em.", true);
    }
    out.textContent = "…";
    try {
      const r = await tool(pick.value, parsed);
      out.textContent = typeof r === "string" ? r : JSON.stringify(r, null, 2);
    } catch (err) {
      out.textContent = `Błąd: ${err.message}`;
    }
  }

  async function reveal() {
    try {
      const r = await api("/mcp-config?reveal=1");
      command.textContent = r.command;
      if (!r.token) toast("Token nie jest ustawiony w zmiennych środowiskowych.", true);
    } catch (err) {
      fail(err);
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Skopiowano");
    } catch {
      toast("Nie udało się skopiować — zaznacz tekst ręcznie.", true);
    }
  }

  fillArgs();
}
