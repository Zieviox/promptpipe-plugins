"use strict";
// The screen's adapter: Preact with htm draws the screen from the State (components are plain
// functions of their inputs, no state of their own: the State is the only state); markdown-it
// shows replies (HTML in them escaped, S10; tables, D5); SortableJS reorders lists (a drop is put
// back and sent as a record move, so Preact stays the only one changing the page).

const html = htm.bind(preact.h);
const md = markdownit({ html: false, linkify: true });
md.renderer.rules.fence = (
  (fence) => (tokens, i, options, env, self) =>
    fence(tokens, i, options, env, self).replace(
      "<pre>",
      '<pre><button class="code-copy">Copy</button>',
    )
)(md.renderer.rules.fence);

const ui_get = () => PP.state_get().ui;
const ui_set = (change) => PP.state_set((s) => ({ ...s, ui: { ...s.ui, ...change(s.ui) } }));

// A short notice; errors stay longer and say what to do (an `Error` with a page offers Open the
// site and Copy page report where the screen shows them).
const toast = (text, error) => {
  const id = PP.id_create();
  ui_set((ui) => ({ toasts: [...ui.toasts, { id, text, error }] }));
  setTimeout(
    () => ui_set((ui) => ({ toasts: ui.toasts.filter((t) => t.id !== id) })),
    error ? 8000 : 3500,
  );
};

// Run a call; a failure becomes an error toast instead of an exception.
const call_try = async (name, data, done) => {
  try {
    const result = await PP.call_send(name, data);
    if (done) toast(done);
    return result;
  } catch (error) {
    toast(error.message, true);
    return null;
  }
};

// A record operation applied and saved; a failure becomes an error toast.
const apply_try = async (operation, message) => {
  try {
    return await PP.record_apply(operation, message);
  } catch (error) {
    toast(error.message, true);
    return null;
  }
};

// The app's own confirm and text prompt: what OK runs is a command id and its data, so the
// dialog is plain data in the State.
const dialog_open = (dialog) => ui_set(() => ({ dialog: { value: "", ok: "OK", ...dialog } }));

const markdown_render = (text) =>
  html`<div class="reply" dangerouslySetInnerHTML=${{ __html: md.render(text || "") }}></div>`;

const icon_render = (name, label, onClick, on) =>
  html`<button
    class=${`icon${on ? " on" : ""}`}
    aria-label=${label}
    title=${label}
    onClick=${onClick}
  >
    ${name}
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
const item_render = ({ label, sub, right, onClick, cls = "", key }) =>
  html`<button key=${key} class=${`item ${cls}`} onClick=${onClick}>
    <span class="grow">${label}${sub ? html`<small>${sub}</small>` : null}</span>${right || null}
  </button>`;

// A list SortableJS can reorder: the drop is undone on the page and handed to `on_move`.
const sortable_ref = (on_move) => (el) => {
  if (!el || el.__sortable) return;
  el.__sortable = Sortable.create(el, {
    handle: ".grip",
    animation: 120,
    onEnd: (e) => {
      if (e.oldIndex === e.newIndex) return;
      el.removeChild(e.item);
      el.insertBefore(e.item, el.children[e.oldIndex] || null);
      on_move(e.item.dataset.id, e.newIndex);
    },
  });
};

PP.plugin_set({
  functions: {
    html,
    ui_get,
    ui_set,
    toast,
    call_try,
    apply_try,
    dialog_open,
    markdown_render,
    icon_render,
    switch_render,
    item_render,
    sortable_ref,
  },
});
