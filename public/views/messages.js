import { add,
  accountLabel,
  ago,
  avatar,
  dialog,
  fail,
  field,
  h,
  money,
  put,
  runAction,
  safeUrl,
  sendDirect,
  state,
  toast,
  tool,
} from "../lib.js";

export async function render(root, ctx) {
  if (state.accounts.length === 0) {
    add(root, h("div", { class: "notice warn" }, "Najpierw podłącz konto w zakładce Konta."));
    return;
  }

  let unreadOnly = false;
  let active = null; // { accountId, id }
  let templates = [];

  const list = h("div", { class: "items" });
  const errors = h("div");
  const thread = h("div", { class: "thread" }, h("div", { class: "empty" }, "Wybierz rozmowę z listy."));

  const unreadBox = h("input", {
    type: "checkbox",
    onchange: (e) => {
      unreadOnly = e.target.checked;
      loadList();
    },
  });
  add(root, 
    h(
      "div",
      { class: "chat" },
      h(
        "div",
        { class: "convlist" },
        h(
          "div",
          { class: "row", style: "padding:.6rem .75rem;border-bottom:1px solid var(--line)" },
          h("label", { class: "check" }, unreadBox, "Tylko nieprzeczytane"),
          h("button", { type: "button", onclick: () => loadList(), style: "margin-left:auto" }, "Odśwież"),
        ),
        errors,
        list,
      ),
      thread,
    ),
  );

  async function loadList(quiet = false) {
    try {
      const args = state.accountId ? { account_id: state.accountId } : { all_accounts: true };
      const r = await tool("list_conversations", { ...args, unread_only: unreadOnly });
      if (!ctx.isCurrent()) return;
      ctx.setBadge("messages", r.unread || 0);
      errors.replaceChildren(
        ...(r.errors || []).map((e) =>
          h("div", { class: "notice warn", style: "margin:.5rem" }, `${accountLabel(e.accountId)}: ${e.message}`),
        ),
      );
      put(list,
        r.conversations.length === 0
          ? h("div", { class: "empty" }, "Brak rozmów.")
          : r.conversations.map((c) => convRow(c)),
      );
    } catch (err) {
      if (!quiet) fail(err);
    }
  }

  function convRow(c) {
    const isActive = active && active.id === c.id && active.accountId === c.accountId;
    return h(
      "div",
      {
        class: `conv${c.unread ? " unread" : ""}${isActive ? " active" : ""}`,
        onclick: () => openConversation(c),
      },
      avatar(c.withUser.avatarUrl),
      h(
        "div",
        { class: "meta" },
        h("div", { class: "name" }, h("b", {}, c.withUser.login || "—"), h("span", { class: "muted small" }, ago(c.updatedAt))),
        h("div", { class: "last" }, c.lastMessage || "…"),
        h(
          "div",
          { class: "muted small" },
          [c.item?.title, state.accounts.length > 1 ? accountLabel(c.accountId) : null].filter(Boolean).join(" · "),
        ),
      ),
    );
  }

  async function openConversation(summary) {
    active = { accountId: summary.accountId, id: summary.id };
    thread.replaceChildren(h("div", { class: "empty" }, "Ładowanie…"));
    list.querySelectorAll(".conv").forEach((el) => el.classList.remove("active"));
    try {
      const detail = await tool("get_conversation", {
        account_id: summary.accountId,
        conversation_id: summary.id,
      });
      if (!detail.messages) throw new Error(detail.message || "Nie znaleziono rozmowy.");
      drawThread(detail);
    } catch (err) {
      thread.replaceChildren(h("div", { class: "notice bad", style: "margin:1rem" }, err.message));
    }
  }

  function drawThread(detail) {
    const item = detail.item;
    const box = h("div", { class: "messages" });
    for (const m of detail.messages) box.append(bubble(m, detail));
    const text = h("textarea", { rows: "2", placeholder: "Napisz wiadomość… (Enter wysyła, Shift+Enter nowa linia)" });
    const send = async () => {
      const value = text.value.trim();
      if (!value) return;
      try {
        await sendDirect("reply_conversation", {
          account_id: detail.accountId,
          conversation_id: detail.id,
          text: value,
        });
        text.value = "";
        await openConversation({ accountId: detail.accountId, id: detail.id });
        loadList(true);
      } catch (err) {
        fail(err);
      }
    };
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    const picker = h(
      "select",
      {
        "aria-label": "Szablon odpowiedzi",
        onchange: (e) => {
          if (e.target.value) text.value = e.target.value;
          e.target.value = "";
          text.focus();
        },
      },
      h("option", { value: "" }, "Szybka odpowiedź…"),
      templates.map((t) => h("option", { value: t }, t.length > 60 ? `${t.slice(0, 60)}…` : t)),
    );

    thread.replaceChildren(
      h(
        "header",
        {},
        avatar(detail.withUser.avatarUrl, 36),
        h(
          "div",
          { style: "min-width:0;flex:1" },
          h("b", {}, detail.withUser.login || "—"),
          h("div", { class: "muted small" }, [item?.title, item ? money(item.price, item.currency) : null, accountLabel(detail.accountId)].filter(Boolean).join(" · ")),
        ),
        item?.photoUrl && safeUrl(item.photoUrl)
          ? h("img", { class: "avatar", style: "border-radius:6px", src: item.photoUrl, alt: "" })
          : null,
      ),
      box,
      h(
        "div",
        { class: "composer" },
        text,
        h(
          "div",
          { class: "row" },
          picker,
          h("button", { type: "button", class: "link small", onclick: editTemplates }, "Edytuj szablony"),
          h("button", { type: "button", class: "primary", style: "margin-left:auto", onclick: send }, "Wyślij"),
        ),
      ),
    );
    box.scrollTop = box.scrollHeight;
    text.focus();
  }

  function bubble(m, detail) {
    if (m.kind === "system") return h("div", { class: "bubble system" }, m.text);
    if (m.kind === "offer") {
      const buttons =
        !m.fromMe && m.offer?.id
          ? h(
              "div",
              { class: "row", style: "margin-top:.4rem" },
              h("button", { type: "button", class: "primary", onclick: () => answer(detail, m, true) }, "Akceptuj"),
              h("button", { type: "button", class: "danger", onclick: () => answer(detail, m, false) }, "Odrzuć"),
            )
          : null;
      return h(
        "div",
        { class: `bubble offer${m.fromMe ? " mine" : ""}` },
        h("b", {}, m.fromMe ? "Twoja oferta: " : "Oferta: "),
        money(m.offer?.price, m.offer?.currency),
        m.offer?.status ? h("div", { class: "muted small" }, m.offer.status) : null,
        m.text && m.text !== m.offer?.status ? h("div", {}, m.text) : null,
        buttons,
        h("time", {}, ago(m.createdAt)),
      );
    }
    return h("div", { class: `bubble${m.fromMe ? " mine" : ""}` }, m.text, h("time", {}, ago(m.createdAt)));
  }

  async function answer(detail, m, accept) {
    try {
      const r = await runAction(
        "respond_to_offer",
        { account_id: detail.accountId, conversation_id: detail.id, offer_id: m.offer.id, accept },
        accept ? "Zaakceptować ofertę?" : "Odrzucić ofertę?",
        accept ? "Akceptuj" : "Odrzuć",
      );
      if (r) await openConversation({ accountId: detail.accountId, id: detail.id });
    } catch (err) {
      fail(err);
    }
  }

  async function editTemplates() {
    const area = h("textarea", { rows: "8", value: templates.join("\n") });
    const ok = await dialog({
      title: "Szablony szybkich odpowiedzi",
      body: h("div", {}, field("Jeden szablon w linii (maks. 20)", area)),
      confirmLabel: "Zapisz",
    });
    if (!ok) return;
    try {
      const r = await tool("set_reply_templates", {
        templates: area.value.split("\n").map((l) => l.trim()).filter(Boolean),
      });
      templates = r.templates;
      toast("Zapisano szablony");
      if (active) openConversation({ accountId: active.accountId, id: active.id });
    } catch (err) {
      fail(err);
    }
  }

  try {
    templates = (await tool("get_reply_templates")).templates || [];
  } catch {
    templates = [];
  }
  await loadList();
  const timer = setInterval(() => {
    if (!document.hidden) loadList(true);
  }, 30_000);
  ctx.onCleanup(() => clearInterval(timer));
}
