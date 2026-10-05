import { add, ago, currentAccount, fail, field, h, pill, state, table, toast, tool } from "../lib.js";

const FIELDS = [
  ["likesPerDay", "likes_per_day", "Polubienia na dobę", "0 wyłącza"],
  ["offersPerDay", "offers_per_day", "Oferty na dobę", "0 wyłącza"],
  ["actionsPerHour", "actions_per_hour", "Auto-akcje na godzinę", "0 wyłącza automat"],
  ["autopauseHours", "autopause_hours", "Pauza po odmowie Vinted (godz.)", ""],
  ["discountPct", "discount_pct", "Domyślny rabat oferty (%)", "0–90"],
];

export async function render(root) {
  const account = currentAccount();
  if (!account) {
    add(root, h("div", { class: "notice warn" }, "Najpierw podłącz konto w zakładce Konta."));
    return;
  }

  let s;
  try {
    s = await tool("get_automation_status", { account_id: account.id });
  } catch (err) {
    fail(err);
    return;
  }
  const L = s.limits;
  const source = (key) => pill(s.limitSource[key] === "environment" ? "domyślne" : "ustawione", s.limitSource[key] === "environment" ? "" : "ok");

  const inputs = {};
  for (const [key] of FIELDS) inputs[key] = h("input", { type: "number", min: "0", step: "1", value: L[key] });
  const hours = h("input", { type: "text", value: `${L.activeHours.start}-${L.activeHours.end}`, placeholder: "8-22" });

  add(root, 
    state.accounts.length > 1 ? h("p", { class: "muted small" }, `Konto: ${account.label}. Zmienisz je w prawym górnym rogu.`) : null,
    !s.autoActionsEnabled
      ? h("div", { class: "notice warn" }, "Automatyka jest wyłączona (główny wyłącznik na Pulpicie). Poniższe limity obowiązują też akcje ręczne (dzienne).")
      : null,
    s.autopause
      ? h(
          "div",
          { class: "notice bad" },
          h("b", {}, "Automat wstrzymany"),
          ` do ${new Date(s.autopause.until).toLocaleString("pl-PL")}: ${s.autopause.reason} `,
          h("button", { type: "button", onclick: resume }, "Wznów"),
        )
      : null,
    h(
      "div",
      { class: "grid", style: "margin-bottom:1rem" },
      meter("Polubienia dziś", s.usage.likesToday, L.likesPerDay),
      meter("Oferty dziś", s.usage.offersToday, L.offersPerDay),
      meter("Auto-akcje w tej godzinie", s.usage.automaticThisHour, L.actionsPerHour),
      h(
        "div",
        { class: "card", style: "margin:0" },
        h("div", { class: "muted small" }, "Okno godzin"),
        h("div", { class: "stat" }, `${s.activityWindow.start}–${s.activityWindow.end}`),
        h("div", { class: "muted small" }, `${s.activityWindow.timeZone}, teraz ${s.activityWindow.localHourNow}:00 — ${s.activityWindow.insideNow ? "w oknie" : "poza oknem"}`),
      ),
    ),
    h(
      "form",
      { class: "card", onsubmit: save },
      h("h2", {}, "Limity tego konta"),
      h("p", { class: "muted small" }, "Zmiany działają od razu, bez wdrażania. „Domyślne” to wartości ze zmiennych środowiskowych."),
      h("div", { class: "grid" }, FIELDS.map(([key, , label, hint]) => h("div", {}, field(label, inputs[key]), h("div", { class: "row small" }, source(key), hint ? h("span", { class: "muted" }, hint) : null)))),
      h("div", { style: "max-width:240px;margin-top:1rem" }, field("Okno godzin (np. 8-22 lub 22-6; 0-0 = cała doba)", hours), h("div", { class: "small" }, source("activeHours"))),
      h("div", { class: "row", style: "margin-top:1rem" }, h("button", { class: "primary", type: "submit" }, "Zapisz"), h("button", { type: "button", onclick: resetAll }, "Przywróć domyślne")),
    ),
    h("div", { class: "card" }, h("h2", {}, "Kolejka automatu"), s.queue.length === 0 ? h("p", { class: "muted" }, "Pusta.") : table(["Przedmiot", "Oczekuje"], s.queue.map((q) => [q.title || q.itemId, q.pending.map((k) => (k === "like" ? "polubienie" : "oferta")).join(", ")]))),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Ostatnie akcje"),
      s.recentActions.length === 0
        ? h("p", { class: "muted" }, "Brak.")
        : table(["Kiedy", "Akcja", "Przedmiot", "Tryb", "Wynik"], s.recentActions.map((a) => [ago(a.at), a.kind, a.itemId || "—", a.automatic ? "auto" : "ręcznie", a.ok ? pill("ok", "ok") : h("span", {}, pill("błąd", "bad"), " ", h("span", { class: "muted small" }, a.detail))])),
    ),
  );

  function meter(label, used, cap) {
    return h("div", { class: "card", style: "margin:0" }, h("div", { class: "muted small" }, label), h("div", { class: "stat" }, cap === 0 ? `${used} / wył.` : `${used} / ${cap}`));
  }

  async function save(e) {
    e.preventDefault();
    try {
      const body = { account_id: account.id };
      for (const [key, arg] of FIELDS) {
        if (Number(inputs[key].value) !== L[key]) body[arg] = Number(inputs[key].value);
      }
      if (hours.value.trim() !== `${L.activeHours.start}-${L.activeHours.end}`) body.active_hours = hours.value.trim();
      if (Object.keys(body).length === 1) return toast("Nic nie zmieniono.");
      await tool("set_automation_limits", body);
      toast("Zapisano limity");
      window.dispatchEvent(new Event("hashchange"));
    } catch (err) {
      fail(err);
    }
  }

  async function resetAll() {
    try {
      await tool("set_automation_limits", { account_id: account.id, reset: true });
      toast("Przywrócono domyślne");
      window.dispatchEvent(new Event("hashchange"));
    } catch (err) {
      fail(err);
    }
  }

  async function resume() {
    try {
      await tool("resume_automation", { account_id: account.id });
      toast("Automat wznowiony");
      window.dispatchEvent(new Event("hashchange"));
    } catch (err) {
      fail(err);
    }
  }
}
