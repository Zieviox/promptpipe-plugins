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
    ${PP.icon_render("☰", "Chats", () => PP.command_run("drawer"))}
    <button class="title" aria-label="Chat title" onClick=${() => PP.command_run("chat_sheet")}>
      ${chat ? chat.name : "New chat"} ▾
    </button>
    <button
      class="pill"
      aria-label="Switch provider"
      onClick=${() => PP.ui_set((ui) => ({ menu: !ui.menu }))}
    >
      <span class=${`dot ${page_status(state, chat)}`}></span>${
        plugin ? plugin.manifest.name : "No provider"
      }${model ? html` · <small>${model}</small>` : null}
    </button>
    ${PP.icon_render("⌕", "Find chats and functions", () => PP.command_run("find"))}
    ${
      PP.setting_get(state, "help.button")
        ? PP.icon_render(
            "?",
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
  const pick = (id) =>
    PP.apply_try((s) =>
      chat
        ? PP.record_set(s, { collection: "chats", id: chat.id, fields: { own: { provider: id } } })
        : PP.record_set(s, { collection: "settings", fields: { "chats.provider": id } }),
    ).then(() => PP.ui_set(() => ({ menu: false })));
  const current = PP.provider_get(state, chat);
  return html`<div class="menu" role="menu">
    ${providers.map((p) =>
      PP.item_render({
        key: p.id,
        label: p.manifest.name,
        sub: p.id === current ? "This chat uses it" : "",
        onClick: () => pick(p.id),
        right: p.id === current ? "✓" : null,
      }),
    )}
    ${PP.item_render({
      label: "Open its site",
      sub: "Log in once, see the pages",
      onClick: () => (PP.ui_set(() => ({ menu: false })), PP.command_run("site_view")),
    })}
    ${PP.item_render({ label: "Profile and provider", onClick: () => PP.sheet_open("provider") })}
    ${PP.item_render({
      label: "Get providers",
      onClick: () => PP.sheet_open("plugins", { tab: "catalogue", filter: "provider" }),
    })}
  </div>`;
};

const unfolded = (state, id) => state.ui.unfolded.includes(id);
const fold_toggle = (id) =>
  PP.ui_set((ui) => ({
    unfolded: ui.unfolded.includes(id) ? ui.unfolded.filter((x) => x !== id) : [...ui.unfolded, id],
  }));

const reply_actions = (state, turn, last) => {
  const mode = PP.setting_get(state, "look.quick_actions");
  const shown =
    unfolded(state, `actions:${turn.id}`) !== (mode === "every" || (mode === "newest" && last));
  const copy = () => PP.call_try("clipboard_write", { text: turn.reply }, "Copied");
  const quote = () =>
    PP.draft_set(
      `${PP.draft_get(state).text}${turn.reply
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}\n\n`,
    );
  if (!shown)
    return html`<div class="actions">
      ${PP.icon_render("⋯", "Show actions", () => fold_toggle(`actions:${turn.id}`))}
    </div>`;
  return html`<div class="actions">
    ${PP.icon_render("⧉", "Copy", copy)}${PP.icon_render("❝", "Quote", quote)}
    ${PP.icon_render("↻", "Send again", () =>
      PP.message_send({ chat: turn.chat, message: turn.message }),
    )}
    ${PP.icon_render("⋯", "More", () => PP.sheet_open("turn", { id: turn.id }))}
    ${(turn.tags || []).map((t) => html`<span class="tag" key=${t}>#${t}</span>`)}
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
      if (dx > 0)
        PP.draft_set(`${PP.draft_get(state).text}> ${turn.reply.replace(/\n/g, "\n> ")}\n\n`);
      else PP.call_try("clipboard_write", { text: turn.reply }, "Copied");
    },
  };
};

const turn_render = (state, turn, last) => {
  const long = (turn.message || "").split("\n").length > 6 || (turn.message || "").length > 500;
  const think_id = `think:${turn.id}`;
  return html`<div class="turn" key=${turn.id} id=${`turn-${turn.id}`}>
    <div
      class=${`you${long && !unfolded(state, turn.id) ? " folded" : ""}`}
      onClick=${() => long && fold_toggle(turn.id)}
    >
      ${turn.message}
    </div>
    ${
      turn.thinking
        ? html`<details
          open=${unfolded(state, think_id)}
          onToggle=${(e) => e.target.open !== unfolded(state, think_id) && fold_toggle(think_id)}
        >
          <summary class="muted">
            Thought for ${Math.max(1, Math.round((turn.thought_ms || 0) / 1000))}s
          </summary>
          <div class="thinking">${PP.markdown_render(turn.thinking)}</div>
        </details>`
        : null
    }
    <div ...${swipe_handlers(turn, state)}>${PP.markdown_render(turn.reply)}</div>
    ${turn.error ? html`<div class="error">${turn.error.message}</div>` : null}
    ${reply_actions(state, turn, last)}
  </div>`;
};

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
  const body =
    turns.length || sends.length
      ? [
          ...turns.map((t, i) => turn_render(state, t, i === turns.length - 1)),
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
    ${PP.icon_render("≡", "Quick edit and add", () => PP.command_run("quick_edit"))}
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
      "⤢",
      state.ui.composer.big ? "Smaller message box" : "Bigger message box",
      () => PP.command_run("composer_big"),
    )}
    <button
      class=${`send${stop ? " stop" : ""}`}
      aria-label=${stop ? "Stop" : "Send"}
      onClick=${() => PP.command_run(stop ? "stop" : "send")}
    >
      ${stop ? "■" : "↑"}
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
