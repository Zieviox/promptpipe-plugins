"use strict";
// The screen's adapter: Preact with htm draws the screen from the State (components are plain
// functions of their inputs, no state of their own: the State is the only state); markdown-it
// shows replies (HTML in them escaped, S10; tables, D5); SortableJS reorders lists (a drop is put
// back and sent as a record move, so Preact stays the only one changing the page).

const html = htm.bind(preact.h);
// The one renderer for all text on the screen: replies, thinking, your messages, guides. A line
// break shows as one (as typed, and as the sites' text came in).
const md = markdownit({ html: false, linkify: true, breaks: true });
md.renderer.rules.fence = (
  (fence) => (tokens, i, options, env, self) =>
    fence(tokens, i, options, env, self).replace(
      "<pre>",
      '<pre><button class="code-copy">Copy</button>',
    )
)(md.renderer.rules.fence);

const ui_get = () => PP.state_get().ui;
const ui_set = (change) => PP.state_set((s) => ({ ...s, ui: { ...s.ui, ...change(s.ui) } }));

// What went wrong, in plain words: the code says what kind, and the technical text is kept apart
// (the failed message's Details) for whoever fixes a plugin. `site`: the provider's name.
const error_words = (error, site) => {
  const code = (error && error.code) || "";
  const text = String((error && error.message) || error || "");
  const name = site || "the site";
  const Name = site || "The site";
  if (
    /isn't in this page's scripts|not connected|reloaded|did not finish loading|isn't ready again/.test(
      text,
    )
  )
    return `${Name} wasn't ready. Try again in a moment.`;
  if (/not supported on this platform/.test(text)) return "That only works in the phone app.";
  if (code === "unavailable")
    return `Couldn't reach ${name}. Check the connection, then try again.`;
  if (code === "deadline_exceeded") return `${Name} took too long to answer.`;
  if (code === "cancelled") return "Stopped.";
  if (code === "internal" || code === "unknown")
    return "Something went wrong in the app. Try again.";
  return text;
};

// A short notice; errors stay longer and say what to do (an `Error` with a page offers Open the
// site and Copy page report where the screen shows them).
// `open`: a chat a tap on the toast opens ("Reply ready").
// `action`: a button on the toast, { label, command } (Undo, Redo).
const toast = (text, error, open, action) => {
  const id = PP.id_create();
  ui_set((ui) => ({ toasts: [...ui.toasts, { id, text, error, open, action }] }));
  setTimeout(
    () => ui_set((ui) => ({ toasts: ui.toasts.filter((t) => t.id !== id) })),
    error || action ? 7000 : 3500,
  );
};

// Run a call; a failure becomes an error toast instead of an exception.
const call_try = async (name, data, done) => {
  try {
    const result = await PP.call_send(name, data);
    if (done) toast(done);
    return result;
  } catch (error) {
    toast(error_words(error), true);
    return null;
  }
};

// A record operation applied and saved; a failure becomes an error toast.
// Your actions: each can be undone (its commit message is its label); `undo_toast` also shows
// what was done with an Undo button (deleting, moving).
const apply_try = async (operation, message, undo_toast) => {
  try {
    const result = await PP.record_apply(operation, message, message || undefined);
    if (undo_toast) toast(undo_toast, false, null, { label: "Undo", command: "undo" });
    const failed = result && result.commit_error;
    if (failed && failed.code !== "unimplemented")
      toast(`Saved, but not added to the history: ${failed.message}`, true);
    return result;
  } catch (error) {
    toast(error.message, true);
    return null;
  }
};

// The app's own confirm and text prompt: what OK runs is a command id and its data, so the
// dialog is plain data in the State.
const dialog_open = (dialog) => ui_set(() => ({ dialog: { value: "", ok: "OK", ...dialog } }));

// "Are you sure?" with one button that runs `command` (a run or command id) with `data`.
const confirm_open = (title, label, command, data = {}) =>
  dialog_open({ title, choices: [["yes", label]], command, data });

const markdown_render = (text, cls = "reply") =>
  html`<div class=${`md ${cls}`} dangerouslySetInnerHTML=${{ __html: md.render(text || "") }}></div>`;

// The wireframe's line icons (one family, 1.7 stroke, in the text colour; design/ux/wireframe.html).
const ICONS = JSON.parse(PP.content_read("runtime-screen", "icons.json") || "{}");

const icon_svg = (name) =>
  html`<span class="svg" aria-hidden="true"
    ><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"
      stroke-linecap="round" stroke-linejoin="round" dangerouslySetInnerHTML=${{ __html: ICONS[name] || "" }}></svg
  ></span>`;

// A round icon button (header, sheet headers, the message bar); `cls` "act" for the small
// square ones under messages; `help` names its command, or is its own line for help mode.
const icon_render = (name, label, onClick, on, cls = "icon", help) =>
  html`<button class=${`${cls}${on ? " on" : ""}`} aria-label=${label} title=${label} onClick=${onClick}
    data-command=${help && PP.HELP && PP.HELP[help] ? help : undefined} data-help=${help && !(PP.HELP && PP.HELP[help]) ? help : undefined}>
    ${ICONS[name] ? icon_svg(name) : name}
  </button>`;

const switch_render = (on, label, onClick) =>
  html`<button
    class=${`switch${on ? " on" : ""}`}
    role="switch"
    aria-checked=${String(!!on)}
    aria-label=${label}
    onClick=${(e) => (e.stopPropagation(), onClick(!on))}
  ></button>`;

// One row of a sheet: label, a line under it, and what sits on the right.
const item_render = ({ label, sub, right, onClick, cls = "", key, icon }) =>
  html`<button key=${key} class=${`item ${cls}`} onClick=${onClick} data-lit=${typeof label === "string" ? label : undefined}>
    ${icon ? html`<span class="lead">${icon_svg(icon)}</span>` : null}<span class="grow">${label}${sub ? html`<small>${sub}</small>` : null}</span>${right === "›" ? html`<span class="ch">${icon_svg("right")}</span>` : right || null}
  </button>`;

// A text box that takes the focus when it first appears (`autofocus` only works on page load).
const focus_ref = (el) => {
  if (el && !el.__focused) {
    el.__focused = true;
    setTimeout(() => el.focus(), 0);
  }
};

// A list SortableJS can reorder; lists with the same `group` trade items. A drop is undone on the
// page and handed to `on_drop({ id, kind, from, to, index, into })` (`from`/`to`: the lists'
// data-list; `into`: the data-into of a row it was dropped onto, when `into` is on), so Preact
// stays the only one changing the page.
const sortable_ref =
  (on_drop, { group, into } = {}) =>
  (el) => {
    if (!el || el.__sortable) return;
    let target = null;
    const mark = (row) => {
      if (target && target !== row) target.classList.remove("di");
      if (row) row.classList.add("di");
      target = row;
    };
    el.__sortable = Sortable.create(el, {
      group,
      handle: ".grip",
      animation: 120,
      onMove: (e, pointer) => {
        if (!into) return true;
        const row = e.related.closest("[data-into]");
        const box = row && row.getBoundingClientRect();
        const middle =
          box &&
          pointer.clientY > box.top + box.height / 4 &&
          pointer.clientY < box.bottom - box.height / 4;
        mark(middle && row !== e.dragged ? row : null);
        return !middle;
      },
      onEnd: (e) => {
        const into_path = target ? target.dataset.into : null;
        mark(null);
        e.to.removeChild(e.item);
        e.from.insertBefore(e.item, e.from.children[e.oldIndex] || null);
        if (into_path === null && e.from === e.to && e.oldIndex === e.newIndex) return;
        const { id, kind } = e.item.dataset;
        on_drop({
          id,
          kind,
          from: e.from.dataset.list,
          to: e.to.dataset.list,
          index: e.newIndex,
          into: into_path,
        });
      },
    });
  };

PP.plugin_set({
  functions: {
    html,
    error_words,
    ui_get,
    ui_set,
    toast,
    call_try,
    apply_try,
    dialog_open,
    confirm_open,
    markdown_render,
    icon_render,
    icon_svg,
    switch_render,
    item_render,
    sortable_ref,
    focus_ref,
  },
});
