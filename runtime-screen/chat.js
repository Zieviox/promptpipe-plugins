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
    ${PP.icon_render("menu", "Chats", () => PP.command_run("drawer"), false, "icon", "drawer")}
    <button class="title" aria-label="Chat title" data-command="chat_sheet" onClick=${() => PP.command_run("chat_sheet")}>
      ${chat ? chat.name : "New chat"}
    </button>
    <button
      class="pill"
      aria-label="Switch provider"
      data-help="The AI site this chat uses and its model; the dot is green when its page is ready. Tap to switch."
      onClick=${() => PP.ui_set((ui) => ({ menu: !ui.menu }))}
    >
      <span class=${`dot ${page_status(state, chat)}`}></span
      ><span class="tx">${plugin ? plugin.manifest.name : "No provider"}${model ? ` · ${model}` : ""}</span
      >${PP.icon_svg("down")}
    </button>
    ${PP.icon_render("search", "Find chats and functions", () => PP.command_run("find"), false, "icon", "find")}
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
  // Versions of this message (an edit, Send again): "‹ 2/3 ›", switching what's shown after it.
  const versions = PP.versions_get(state, turn);
  const step = (by) => {
    const next = versions.list[versions.index + by];
    if (next) PP.call_try("version_show", { turn: turn.id, id: next.id });
  };
  const switcher =
    versions.list.length > 1
      ? html`<span class="versions">
          ${PP.icon_render("back", "Previous version", () => step(-1), false, "act")}
          <span>${versions.index + 1}/${versions.list.length}</span>
          ${PP.icon_render("right", "Next version", () => step(1), false, "act")}
        </span>`
      : null;
  const foot = html`<div class="foot">
    ${PP.icon_render(open ? "up" : "more", open ? "Hide actions" : "Show actions", toggle, false, "act")}
    <span>${time_short(turn.at)}</span>${!open && tags.length ? html`<span class="tg">#${tags.length}</span>` : null}
    ${switcher}
  </div>`;
  if (!open) return foot;
  return html`${foot}
    <div class="actions">
      ${PP.icon_render("copy", "Copy", () => PP.call_try("clipboard_write", { text: turn.reply }, "Copied"), false, "act", "Copies this reply.")}
      ${PP.icon_render("quote", "Quote", () => quote_add(state, turn.reply), false, "act", "Puts this reply in your message as a quote.")}
      ${PP.icon_render("retry", "Send again", () => PP.message_send({ chat: turn.chat, message: turn.message, replaces: turn.id, regenerate: true }), false, "act", "A new reply to the same message: a new version beside this one (‹ 2/2 ›); on the site, its Regenerate.")}
      ${PP.icon_render("sites", "Check against the site", () => turn_check_run(turn.id), false, "act", "Compares this reply with the site's and takes the site's version if it's different (one cut short, say).")}
      ${PP.icon_render("more", "More", () => PP.sheet_open("turn", { id: turn.id }), false, "act", "Tags, the message sent, its blocks and more for this reply.")}
    </div>
    <div class="chips">
      ${tags.map((t) => html`<span class="tag" key=${t}>#${t}</span>`)}
      <button class="tag" onClick=${() => PP.dialog_open({ title: "Tag this message (name# numbers it)", ok: "Add", command: "turn_tag_add", data: { id: turn.id } })}>+ tag</button>
    </div>`;
};

// Your message, the same wherever it is: saved, on its way, queued or failed. Copy and Edit are
// always there (Edit sends it again as a new message unless it's a saved one it replaces). Over 8
// lines or 600 characters it's tucked (about 6 lines, fading out) with a "Show more" line.
const message_render = (state, turn) => {
  const text = turn.message || "";
  const long = text.split("\n").length > 8 || text.length > 600;
  const open = unfolded(state, turn.id);
  return html`<div class="youwrap">
    <div class=${`you${long && !open ? " tuck" : ""}`}>${PP.markdown_render(text, "mine")}</div>
    ${long ? html`<button class="thin" onClick=${() => fold_toggle(turn.id)}>${open ? "Show less" : "Show more"} ${PP.icon_svg(open ? "up" : "down")}</button>` : null}
    <div class="actions right">
      ${PP.icon_render("copy", "Copy your message", () => PP.call_try("clipboard_write", { text }, "Copied"), false, "act")}
      ${PP.icon_render("edit", "Edit and send again", () => PP.draft_set(text, turn.saved === false ? {} : { replaces: turn.id }), false, "act")}
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
      ${turn.thinking ? html`<div class="thinking">${PP.markdown_render(turn.thinking, "thought")}</div>` : null}
      ${sent.length ? html`<small>Sent with: ${sent.join(", ")}</small>` : null}
      <button class="thin" onClick=${() => PP.sheet_open("turn", { id: turn.id })}>Show the full text</button>
    </div>`
        : null
    }`;
};

// A saved reply against the site's version (cut short, or doubted), said in a toast.
const turn_check_run = async (id) => {
  PP.toast("Checking the site…");
  const result = await PP.call_try("turn_check", { turn: id });
  if (!result) return;
  if (result.status === "updated") PP.toast("Updated with the site's version");
  else if (result.status === "same") PP.toast("It matches the site");
  else PP.toast(result.why, true);
};

// Removing a failed or waiting message asks where its text goes: nothing you typed goes silently.
const send_dismiss_ask = (send) =>
  PP.dialog_open({
    title: "Remove this message? Its text can go back in the message box.",
    choices: [
      ["back", "Put it back in the box"],
      ["discard", "Discard it"],
    ],
    command: "send_dismiss",
    data: { send: send.id },
  });

// Over a chat's waiting messages: how many, why they hold, and Pause or Resume.
const HOLDS = {
  failed: "a message above didn't go",
  "cut short": "the reply above was cut short",
  removed: "the message before was removed",
  paused: "paused",
};
const queue_bar_render = (state, chat, waiting) => {
  const why = PP.hold_get(state, chat);
  const n = waiting.length;
  const count = `${n} message${n === 1 ? "" : "s"} waiting`;
  return html`<div class="queuebar" key="queuebar">
    <span class="grow">${why ? `${count} · ${HOLDS[why] || "held"}` : count}</span>
    ${
      why && why !== "failed"
        ? html`<button class="pill on" onClick=${() => PP.queue_pause(chat, false)}>${PP.icon_svg("play")} Resume</button>`
        : why
          ? null
          : html`<button class="pill" onClick=${() => PP.queue_pause(chat, true)}>Pause</button>`
    }
  </div>`;
};

const turn_render = (state, turn, last) =>
  html`<div class="turn" key=${turn.id} id=${`turn-${turn.id}`}>
    ${message_render(state, turn)}
    <div class="ai">
      <small>${provider_name_get(state, turn)}${turn.model ? ` · ${turn.model}` : ""}</small>
      ${PP.markdown_render(turn.reply)}
      ${thin_render(state, turn)}
      ${
        turn.error
          ? html`<div class="notice">
              <span class="ni">${PP.icon_svg("alert")}</span>
              <div class="grow">
                <div>This reply was cut short. The site may have the rest.</div>
                <details><summary>Details</summary><small>${turn.error.message}</small></details>
              </div>
            </div>
            <div class="chips choices">
              <button class="pill on" onClick=${() => turn_check_run(turn.id)}>Check against the site</button>
            </div>`
          : null
      }
      ${reply_foot(state, turn, last)}
    </div>
  </div>`;

// A send on its way: the thinking and the reply so far; waiting: Send now, Edit and Remove (UC2);
// failed: what happened and what can be done (UC4). Removing asks where the text goes.
const send_render = (state, send) => {
  const chat = state.chats.find((c) => c.id === send.chat);
  const plugin = state.plugins.find((p) => p.id === PP.provider_get(state, chat));
  const site = plugin ? plugin.manifest.name : null;
  const you = message_render(state, { id: send.id, message: send.message, saved: false });
  // Failed: what happened in plain words (the technical text under Details), Retry first.
  if (send.status === "failed") {
    const words = PP.error_words(send.error, site);
    const raw = send.error.message;
    const resolve = (choice) => () => PP.call_try("failure_resolve", { send: send.id, choice });
    return html`<div class="turn failed" key=${send.id}>
      ${you}
      <div class="notice">
        <span class="ni">${PP.icon_svg("alert")}</span>
        <div class="grow">
          <div>${words}</div>
          ${
            raw && raw !== words
              ? html`<details><summary>Details</summary><small>${raw}</small></details>`
              : null
          }
        </div>
      </div>
      <div class="chips choices">
        <button class="pill on" onClick=${resolve("retry")}>${PP.icon_svg("retry")} Retry</button>
        <button class="pill" onClick=${resolve("check")}>Check the page</button>
        <button class="pill" onClick=${resolve("edit")}>Edit</button>
        ${
          send.page
            ? html`<button
                class="pill"
                onClick=${() => PP.ui_set(() => ({ site_view: { open: true, page: send.page } }))}
              >
                Open the site
              </button>`
            : null
        }
        <button class="pill quiet" onClick=${() => send_dismiss_ask(send)}>Dismiss</button>
      </div>
    </div>`;
  }
  if (send.status === "queued") {
    const edit = () => (PP.draft_set(send.message), PP.send_dismiss(send.id, "discard"));
    return html`<div class="turn queued" key=${send.id}>
      ${you}
      <div class="chips choices">
        ${send.force ? html`<span class="status">Sending next</span>` : null}
        ${send.force ? null : html`<button class="pill" onClick=${() => PP.send_now(send.id)}>Send now</button>`}
        <button class="pill" onClick=${edit}>Edit</button>
        <button class="pill quiet" onClick=${() => send_dismiss_ask(send)}>Remove</button>
      </div>
    </div>`;
  }
  // On its way: the thinking in full as it comes, then the reply as it's written. The status line
  // says what's happening in words (no character counts); a pulsing dot while it's alive.
  const secs = Math.max(1, Math.round((Date.now() - Date.parse(send.at || 0)) / 1000));
  const live = send.thinking && !send.reply;
  const status = live
    ? `Thinking · ${secs} s`
    : send.reply
      ? "Writing…"
      : /chars$/.test(send.progress || "")
        ? "Thinking…"
        : send.progress || `Waiting for ${site || "the site"}…`;
  return html`<div class="turn" key=${send.id}>
    ${you}
    <div class="live"><span class="pulse"></span>${status}</div>
    ${live ? html`<div class="thinking live">${PP.markdown_render(send.thinking, "thought")}</div>` : null}
    ${send.reply ? PP.markdown_render(send.reply) : null}
  </div>`;
};

const chat_render = (state) => {
  const id = state.ui.chat;
  const turns = PP.turns_shown(state, id); // with branches, the versions shown
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
          ...sends.flatMap((s, i) =>
            s.status === "queued" && !sends.slice(0, i).some((x) => x.status === "queued")
              ? [
                  queue_bar_render(
                    state,
                    id,
                    sends.filter((x) => x.status === "queued"),
                  ),
                  send_render(state, s),
                ]
              : [send_render(state, s)],
          ),
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

// "↓ 1 new" for a reply that finished while you were scrolled up (to its start), else "Jump to
// latest" whenever you're scrolled up (to the bottom).
const new_reply_render = (state) => {
  const turn = state.ui.unseen[state.ui.chat];
  const box = () => document.getElementById("chat");
  if (turn)
    return html`<button class="jump" onClick=${() => {
      document.getElementById(`turn-${turn}`)?.scrollIntoView({ block: "start" });
      PP.ui_set((ui) => ({ unseen: { ...ui.unseen, [ui.chat]: undefined } }));
    }}>↓ 1 new</button>`;
  if (!state.ui.scrolled_up) return null;
  return html`<button class="jump" onClick=${() => box() && (box().scrollTop = box().scrollHeight)}>Jump to latest</button>`;
};

// The box is as tall as its text and the container around it (.boxscroll) scrolls: GeckoView
// hides a selection handle scrolled out of a scrolling container, but not one scrolled out of a
// text box that scrolls itself (it was drawn over the chat above).
// The message box is the browser engine's own: what you type is never written back into it (that
// breaks word choice on the keyboard and the selection); only a change from elsewhere (Edit, a
// quote, a send emptying it, another chat) is put in. Its height follows its lines, measured on an
// off-screen copy, so the box itself never collapses or jumps while you select in it.
let box_copy = null;
const COPIED = [
  "width", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
  "word-spacing", "padding-left", "padding-right", "padding-top", "padding-bottom", "border-left-width",
  "border-right-width", "box-sizing", "white-space", "overflow-wrap", "word-break", "tab-size",
];
const box_size = (el) => {
  if (!el) return;
  if (!box_copy) {
    box_copy = document.createElement("textarea");
    box_copy.setAttribute("aria-hidden", "true");
    box_copy.tabIndex = -1;
    box_copy.style.cssText =
      "position:fixed;left:-9999px;top:0;visibility:hidden;height:0;min-height:0;overflow:hidden;border:0;";
    document.body.append(box_copy);
  }
  const style = getComputedStyle(el);
  COPIED.forEach((name) => box_copy.style.setProperty(name, style.getPropertyValue(name)));
  box_copy.value = el.value || " ";
  const height = `${box_copy.scrollHeight}px`;
  if (el.style.height !== height) el.style.height = height;
};
let box_known = null; // the text and width the box was last sized for
const box_sync = (el, text) => {
  if (el.value !== text) el.value = text;
  const known = `${el.clientWidth} ${el.value}`;
  if (known !== box_known) ((box_known = known), box_size(el));
};
addEventListener("resize", () => {
  const el = document.getElementById("message");
  if (el) box_size(el);
});

const composer_render = (state) => {
  const draft = PP.draft_get(state);
  const busy = state.sends.some(
    (s) => s.chat === state.ui.chat && s.chat && ["waiting", "sending"].includes(s.status),
  );
  const stop = busy && !draft.text.trim();
  const key = (e) => {
    const enter_sends = PP.setting_get(state, "look.enter_sends");
    if (e.key === "Enter" && (e.ctrlKey || (enter_sends && !e.shiftKey)))
      return (e.preventDefault(), PP.command_run("send"));
    if (e.key === "ArrowUp" && !e.target.value)
      return (e.preventDefault(), PP.command_run("last_edit"));
  };
  // An edit: the send replaces that message (and its reply); said over the box, × to send it as a
  // new message instead.
  const editing = draft.replaces && state.turns.find((t) => t.id === draft.replaces);
  const edit_bar = editing
    ? html`<div class="editbar">
        ${PP.icon_svg("edit")}
        <span class="grow">Editing your message · sent as a new version of it (the old one stays)</span>
        ${PP.icon_render("close", "Not a version: send as a new message", () => PP.draft_set(draft.text, { replaces: null }), false, "act")}
      </div>`
    : null;
  // A tap on the box's edge (around the text) puts the cursor in the text. A tap on its buttons
  // leaves the cursor (and the keyboard) in the box: otherwise the buttons would move back beside
  // the text under the finger, and the tap would miss.
  const edge = (e) => {
    const el = e.currentTarget.querySelector("textarea");
    if (!el || e.target === el) return;
    if ((e.target === e.currentTarget || e.target.classList.contains("boxscroll")) && document.activeElement !== el)
      return (e.preventDefault(), el.focus());
    if (document.activeElement === el && e.target.closest("button")) e.preventDefault();
  };
  return html`${edit_bar}<div class=${`composer${state.ui.composer.big ? " big" : ""}`} onMouseDown=${edge}>
    ${PP.icon_render("stackadd", "Quick edit and add", () => (document.activeElement?.blur(), PP.command_run("quick_edit")), false, "icon", "quick_edit")}
    <div class="boxscroll">
      <textarea
        id="message"
        rows="1"
        placeholder=${PP.raw_get(state) ? "Message (profile off)" : "Message"}
        aria-label="Message"
        onInput=${(e) => ((box_known = `${e.target.clientWidth} ${e.target.value}`), box_size(e.target), PP.draft_type(e.target.value))}
        onFocus=${(e) => box_size(e.target)}
        onBlur=${(e) => box_size(e.target)}
        onKeyDown=${key}
      ></textarea>
    </div>
    ${draft.attachments.length ? html`<small>${draft.attachments.length} attached</small>` : null}
    ${PP.icon_render(
      state.ui.composer.big ? "shrink" : "expand",
      state.ui.composer.big ? "Smaller message box" : "Bigger message box",
      () => PP.command_run("composer_big"),
      false,
      "icon",
      "composer_big",
    )}
    <button
      class=${`send${stop ? " stop" : ""}`}
      aria-label=${stop ? "Stop" : "Send"}
      data-command=${stop ? "stop" : "send"}
      onClick=${() => PP.command_run(stop ? "stop" : "send")}
    >
      ${PP.icon_svg(stop ? "stop" : "send")}
    </button>
  </div>`;
};

PP.plugin_set({
  functions: {
    turn_check_run,
    box_size,
    box_sync,
    header_render,
    provider_menu_render,
    chat_render,
    new_reply_render,
    composer_render,
  },
});
