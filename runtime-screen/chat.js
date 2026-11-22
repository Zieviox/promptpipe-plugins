"use strict";
// The chat: the header (the chat's name, the provider with its model and state dot, Find, ?), the
// provider's menu, the turns (your message folded when long, the thinking folded unless it's
// streaming, the reply's Markdown and its actions), the sends on their way, queued and failed,
// "↓ 1 new", and the message box.

const { html } = PP;

const page_status = (state, chat) => {
  const sending = state.sends.some((s) => s.chat === (chat && chat.id) && s.status === "sending");
  const page = state.pages.find((p) => p.provider === PP.provider_get(state, chat));
  if (sending) return "busy";
  if (!page) return state.pages.length ? "off" : "none";
  return page.status === "ready" ? "" : page.status === "failed" ? "none" : "off";
};

const header_render = (state) => {
  const chat = PP.chat_get(state);
  const plugin = state.plugins.find((p) => p.id === PP.provider_get(state, chat));
  const model = PP.model_get(state, chat);
  return html`<div class="top">
    ${PP.icon_render("menu", "Chats", () => PP.command_run("drawer"))}
    <button class="title" aria-label="Chat title" onClick=${() => PP.command_run("chat_sheet")}>
      ${chat ? chat.name : "New chat"}
    </button>
    <button
      class="pill"
      aria-label="Switch provider"
      onClick=${() => PP.ui_set((ui) => ({ menu: !ui.menu }))}
    >
      <span class=${`dot ${page_status(state, chat)}`}></span
      ><span class="tx">${plugin ? plugin.manifest.name : "No provider"}${model ? ` · ${model}` : ""}</span
      >${PP.icon_svg("down")}
    </button>
    ${PP.icon_render("search", "Find chats and functions", () => PP.command_run("find"))}
    ${
      PP.setting_get(state, "help.button")
        ? PP.icon_render(
            "help",
            "Help: tap, then tap anything",
            () => PP.command_run("help_mode"),
            state.ui.help,
          )
        : null
    }
  </div>`;
};

// Switch the chat's provider (its own; the default for new chats when no chat is open), open its
// site, or get one (UC9).
const provider_menu_render = (state) => {
  const chat = PP.chat_get(state);
  const providers = state.plugins.filter((p) => (p.manifest.tags || []).includes("provider"));
  const current = PP.provider_get(state, chat);
  const close = () => PP.ui_set(() => ({ menu: false }));
  const has_replies = chat && state.turns.some((t) => t.chat === chat.id);
  const pick = (p) => {
    close();
    if (p.id === current) return;
    if (has_replies)
      return PP.confirm_open(
        `Continue this chat on ${p.manifest.name}? It starts a new conversation there, and Memory carries the context.`,
        "Yes",
        "provider_switch",
        { chat: chat.id, provider: p.id },
      );
    PP.apply_try((s) =>
      chat
        ? PP.record_set(s, {
            collection: "chats",
            id: chat.id,
            fields: { own: { provider: p.id } },
          })
        : PP.record_set(s, { collection: "settings", fields: { "chats.provider": p.id } }),
    );
  };
  const status = (p) => {
    const page = state.pages.find((x) => x.provider === p.id);
    return page ? (page.status === "ready" ? "" : page.status === "busy" ? "busy" : "off") : "none";
  };
  const plain = (label, run) =>
    html`<button class="mi" onClick=${() => (close(), run())}>${label}</button>`;
  return html`<div class="menu" role="menu">
    ${providers.map(
      (p) => html`<button class="mi pv" key=${p.id} onClick=${() => pick(p)}>
        <span class=${`radio${p.id === current ? " on" : ""}`}></span>
        <span class="grow">${p.manifest.name}<small>${PP.model_get(state, { own: { provider: p.id } }) || "Model as the site has it"}</small></span>
        <span class=${`dot ${status(p)}`}></span>
      </button>`,
    )}
    <hr />
    ${plain("Show the page", () => PP.command_run("site_view"))}
    ${plain("Open a chat from the site", () => PP.sheet_open("site_chats"))}
    ${plain("Site, model and profile…", () => PP.sheet_open("provider"))}
    ${plain("Get providers", () => PP.sheet_open("plugins", { tab: "catalogue", filter: "provider" }))}
  </div>`;
};

const unfolded = (state, id) => state.ui.unfolded.includes(id);
const fold_toggle = (id) =>
  PP.ui_set((ui) => ({
    unfolded: ui.unfolded.includes(id) ? ui.unfolded.filter((x) => x !== id) : [...ui.unfolded, id],
  }));

const time_short = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : "";

// The provider that answered: the one whose site the turn's site chat is on, else the chat's.
const provider_name_get = (state, turn) => {
  const host = (url) => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  };
  const site = host(turn.page_url);
  const by_site =
    site &&
    state.plugins.find((p) => p.manifest.provider && host(p.manifest.provider.url) === site);
  const plugin =
    by_site || state.plugins.find((p) => p.id === PP.provider_get(state, PP.chat_get(state)));
  return plugin ? plugin.manifest.name : "AI";
};

const quote_add = (state, text) =>
  PP.draft_set(
    `${PP.draft_get(state).text}${text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n")}\n\n`,
  );

// Under a reply: the foot (open or close the actions, the time, the tag count when closed); open,
// the actions (Copy, Quote, Send again, Select text, More) and the tags with "+ tag". Open by
// default on the newest reply, every reply or none, as set.
const reply_foot = (state, turn, last) => {
  const mode = PP.setting_get(state, "look.quick_actions");
  const open =
    unfolded(state, `actions:${turn.id}`) !== (mode === "every" || (mode === "newest" && last));
  const toggle = () => fold_toggle(`actions:${turn.id}`);
  const tags = turn.tags || [];
  const foot = html`<div class="foot">
    ${PP.icon_render(open ? "up" : "more", open ? "Hide actions" : "Show actions", toggle, false, "act")}
    <span>${time_short(turn.at)}</span>${!open && tags.length ? html`<span class="tg">#${tags.length}</span>` : null}
  </div>`;
  if (!open) return foot;
  return html`${foot}
    <div class="actions">
      ${PP.icon_render("copy", "Copy", () => PP.call_try("clipboard_write", { text: turn.reply }, "Copied"), false, "act")}
      ${PP.icon_render("quote", "Quote", () => quote_add(state, turn.reply), false, "act")}
      ${PP.icon_render("retry", "Send again", () => PP.message_send({ chat: turn.chat, message: turn.message }), false, "act")}
      ${PP.icon_render("select", "Select text", () => PP.sheet_open("select_text", { text: turn.reply }), false, "act")}
      ${PP.icon_render("more", "More", () => PP.sheet_open("turn", { id: turn.id }), false, "act")}
    </div>
    <div class="chips">
      ${tags.map((t) => html`<span class="tag" key=${t}>#${t}</span>`)}
      <button class="tag" onClick=${() => PP.dialog_open({ title: "Tag this message (name# numbers it)", ok: "Add", command: "turn_tag_add", data: { id: turn.id } })}>+ tag</button>
    </div>`;
};

// A swipe across a reply: right quotes it, left copies it (UC6).
const swipe_handlers = (turn, state) => {
  let start = null;
  return {
    onPointerDown: (e) => (start = { x: e.clientX, y: e.clientY }),
    onPointerUp: (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = Math.abs(e.clientY - start.y);
      start = null;
      if (Math.abs(dx) < 80 || dy > 40) return;
      if (dx > 0) quote_add(state, turn.reply);
      else PP.call_try("clipboard_write", { text: turn.reply }, "Copied");
    },
  };
};

// Your message: over 8 lines or 600 characters it's tucked (about 6 lines, fading out) with a
// "Show more" line; Copy and Edit under it (Edit puts it back in the box and replaces it when sent).
const message_render = (state, turn) => {
  const text = turn.message || "";
  const long = text.split("\n").length > 8 || text.length > 600;
  const open = unfolded(state, turn.id);
  return html`<div class="youwrap">
    <div class=${`you${long && !open ? " tuck" : ""}`}>${text}</div>
    ${long ? html`<button class="thin" onClick=${() => fold_toggle(turn.id)}>${open ? "Show less" : "Show more"} ${PP.icon_svg(open ? "up" : "down")}</button>` : null}
    <div class="actions right">
      ${PP.icon_render("copy", "Copy your message", () => PP.call_try("clipboard_write", { text }, "Copied"), false, "act")}
      ${PP.icon_render("edit", "Edit and send again", () => PP.draft_set(text, { replaces: turn.id }), false, "act")}
    </div>
  </div>`;
};

// "Thought for N s · sent with N": opens the thinking, what was sent with the message, and the
// full text of what went out.
const thin_render = (state, turn) => {
  const id = `think:${turn.id}`;
  const open = unfolded(state, id);
  const sent = turn.blocks || [];
  const label = [
    turn.thinking ? `Thought for ${Math.max(1, Math.round((turn.thought_ms || 0) / 1000))} s` : "",
    sent.length ? `sent with ${sent.length}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (!label) return null;
  return html`<button class="thin" onClick=${() => fold_toggle(id)}>${PP.icon_svg(open ? "up" : "down")} ${label[0].toUpperCase() + label.slice(1)}</button>
    ${
      open
        ? html`<div class="thinbox">
      ${turn.thinking ? PP.markdown_render(turn.thinking) : null}
      ${sent.length ? html`<small>Sent with: ${sent.join(", ")}</small>` : null}
      <button class="thin" onClick=${() => PP.sheet_open("turn", { id: turn.id })}>Show the full text</button>
    </div>`
        : null
    }`;
};

const turn_render = (state, turn, last) =>
  html`<div class="turn" key=${turn.id} id=${`turn-${turn.id}`}>
    ${message_render(state, turn)}
    <div class="ai">
      <small>${provider_name_get(state, turn)}${turn.model ? ` · ${turn.model}` : ""}</small>
      <div ...${swipe_handlers(turn, state)}>${PP.markdown_render(turn.reply)}</div>
      ${thin_render(state, turn)}
      ${turn.error ? html`<div class="error">${turn.error.message}</div>` : null}
      ${reply_foot(state, turn, last)}
    </div>
  </div>`;

// A send on its way: the thinking's newest line and the reply so far; queued: under the chat,
// with Move up, Edit and Remove (UC2); failed: its reason and what can be done (UC4).
const send_render = (state, send) => {
  if (send.status === "failed") {
    const site =
      send.page &&
      ["permission_denied", "failed_precondition", "unavailable", "not_found"].includes(
        send.error.code,
      );
    const resolve = (choice) => () => PP.call_try("failure_resolve", { send: send.id, choice });
    return html`<div class="turn failed" key=${send.id}>
      <div class="you">${send.message}</div>
      <div class="error">${send.error.message}</div>
      <div class="chips">
        <button class="pill" onClick=${resolve("check")}>Check</button
        ><button class="pill" onClick=${resolve("retry")}>Retry</button>
        <button class="pill" onClick=${resolve("edit")}>Edit</button
        ><button class="pill" onClick=${resolve("dismiss")}>Dismiss</button>
        ${
          site
            ? html`<button
                class="pill"
                onClick=${() => PP.ui_set(() => ({ site_view: { open: true, page: send.page } }))}
              >
                Open the site
              </button>
              <button class="pill" onClick=${() => PP.page_report_copy(send.page)}>
                Copy page report
              </button>`
            : null
        }
      </div>
    </div>`;
  }
  if (send.status === "queued") {
    const remove = () =>
      PP.apply_try((s) => PP.record_delete(s, { collection: "sends", id: send.id }));
    const edit = () => (PP.draft_set(send.message), remove());
    const up = () =>
      PP.apply_try((s) => PP.record_move(s, { collection: "sends", id: send.id, index: 0 }));
    return html`<div class="turn queued" key=${send.id}>
      <div class="you">${send.message}</div>
      <div class="chips">
        <small>Queued</small><button class="pill" onClick=${up}>Move up</button>
        <button class="pill" onClick=${edit}>Edit</button
        ><button class="pill" onClick=${remove}>Remove</button>
      </div>
    </div>`;
  }
  const last_line = (send.thinking || "").trim().split("\n").pop();
  return html`<div class="turn" key=${send.id}>
    <div class="you">${send.message}</div>
    ${send.thinking ? html`<div class="thinking"><small>${last_line}</small></div>` : null}
    ${send.reply ? PP.markdown_render(send.reply) : null}
    <small class="muted">${send.progress}</small>
  </div>`;
};

const chat_render = (state) => {
  const id = state.ui.chat;
  const turns = state.turns.filter((t) => t.chat === id);
  const sends = state.sends.filter((s) => s.chat === id && s.chat);
  const hooks = state.plugins.map((p) => PP.hook_get(p.id, "turn_render")).filter(Boolean);
  const body =
    turns.length || sends.length
      ? [
          ...turns.flatMap((t, i) => {
            // A plugin's `turn_render` hook adds parts before and after a turn (dividers, notes).
            const context = { chat: PP.chat_get(state), turns, index: i };
            const parts = hooks.map((hook) => hook(t, context) || {});
            const last = i === turns.length - 1;
            return [
              ...parts.map((p) => p.before),
              turn_render(state, t, last),
              ...parts.map((p) => p.after),
            ];
          }),
          ...sends.map((s) => send_render(state, s)),
        ]
      : html`<div class="empty">Say hello: type a message and send.</div>`;
  return html`<div
    class="chat"
    id="chat"
    onClick=${(e) =>
      e.target.classList.contains("code-copy") &&
      PP.call_try(
        "clipboard_write",
        { text: e.target.parentElement.textContent.replace(/^Copy/, "") },
        "Copied",
      )}
  >
    ${body}
  </div>`;
};

const new_reply_render = (state) => {
  const turn = state.ui.unseen[state.ui.chat];
  if (!turn) return null;
  const jump = () => {
    document.getElementById(`turn-${turn}`)?.scrollIntoView({ block: "start" });
    PP.ui_set((ui) => ({ unseen: { ...ui.unseen, [ui.chat]: undefined } }));
  };
  return html`<button class="pill on new-reply" onClick=${jump}>↓ 1 new</button>`;
};

const composer_render = (state) => {
  const draft = PP.draft_get(state);
  const busy = state.sends.some(
    (s) => s.chat === state.ui.chat && s.chat && ["waiting", "sending"].includes(s.status),
  );
  const stop = busy && !draft.text.trim();
  const key = (e) => {
    const enter_sends = PP.setting_get(state, "look.enter_sends");
    if (e.key === "Enter" && (e.ctrlKey || (enter_sends && !e.shiftKey)))
      return e.preventDefault(), PP.command_run("send");
    if (e.key === "ArrowUp" && !e.target.value)
      return e.preventDefault(), PP.command_run("last_edit");
  };
  return html`<div class=${`composer${state.ui.composer.big ? " big" : ""}`}>
    ${PP.icon_render("stackadd", "Quick edit and add", () => PP.command_run("quick_edit"))}
    <textarea
      id="message"
      rows="1"
      placeholder="Message"
      aria-label="Message"
      value=${draft.text}
      onInput=${(e) => PP.draft_set(e.target.value)}
      onKeyDown=${key}
    ></textarea>
    ${draft.attachments.length ? html`<small>${draft.attachments.length} attached</small>` : null}
    ${PP.icon_render(
      state.ui.composer.big ? "shrink" : "expand",
      state.ui.composer.big ? "Smaller message box" : "Bigger message box",
      () => PP.command_run("composer_big"),
    )}
    <button
      class=${`send${stop ? " stop" : ""}`}
      aria-label=${stop ? "Stop" : "Send"}
      onClick=${() => PP.command_run(stop ? "stop" : "send")}
    >
      ${PP.icon_svg(stop ? "stop" : "send")}
    </button>
  </div>`;
};

PP.plugin_set({
  functions: {
    header_render,
    provider_menu_render,
    chat_render,
    new_reply_render,
    composer_render,
  },
});
