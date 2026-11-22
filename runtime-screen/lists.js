"use strict";
// The chats list (pinned first, then your order of folders and chats; search and tag chips;
// select mode; drag to reorder), the site view's bar (tabs, the address bar, the linked chat), and
// Find (chats, functions and messages, UC18).

const { html } = PP;

// Every folder: those holding chats, and the Folder records (made empty, or holding your order).
const folder_list = (state) =>
  [
    ...new Set([
      ...state.chats.map((c) => c.file.slice(0, Math.max(0, c.file.lastIndexOf("/")))),
      ...state.folders.map((f) => f.id),
    ]),
  ]
    .filter(Boolean)
    .sort();

// A folder's order filled in from what's shown (leaving out `ids`), so an index into the shown
// list is an index into the order.
const order_fill = (state, path, ids = []) => {
  const order = entries_get(state, path)
    .map((e) => e.id)
    .filter((id) => !ids.includes(id));
  const record = state.folders.find((f) => f.id === path) || { id: path, order: [], pinned: [] };
  return {
    ...state,
    folders: [...state.folders.filter((f) => f.id !== path), { ...record, order }],
  };
};

// A folder moved among its neighbours: the parent's order is filled in from what's shown, then the
// folder goes to its new place.
const folder_order_move = (state, parent, path, index) => {
  const ids = entries_get(state, parent)
    .map((e) => e.id)
    .filter((id) => id !== path);
  ids.splice(index, 0, path);
  const record = state.folders.find((f) => f.id === parent) || {
    id: parent,
    order: [],
    pinned: [],
  };
  const folders = [...state.folders.filter((f) => f.id !== parent), { ...record, order: ids }];
  return { state: { ...state, folders }, targets: [{ file: "folders" }] };
};

// A folder's entries in your order; what you never placed: folders by name, then chats newest first.
const entries_get = (state, path) => {
  const record = state.folders.find((f) => f.id === path) || { order: [] };
  const pinned = (state.folders.find((f) => f.id === "") || { pinned: [] }).pinned || [];
  const in_folder = (file) =>
    (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "") === path;
  const chats = state.chats.filter((c) => in_folder(c.file) && !pinned.includes(c.id));
  const prefix = path ? `${path}/` : "";
  const folders = folder_list(state)
    .filter((f) => f.startsWith(prefix) && f !== path)
    .map((f) => prefix + f.slice(prefix.length).split("/")[0]);
  const all = [...new Set(folders)]
    .map((f) => ({ folder: f, id: f }))
    .concat(chats.map((c) => ({ chat: c, id: c.id })));
  const known = record.order
    .map((id) => all.find((e) => e.id === id || e.folder === `${path ? `${path}/` : ""}${id}`))
    .filter(Boolean);
  const rest = all
    .filter((e) => !known.includes(e))
    .sort((a, b) =>
      a.folder && b.folder
        ? a.folder.localeCompare(b.folder)
        : a.folder
          ? -1
          : b.folder
            ? 1
            : (b.chat.updated || "").localeCompare(a.chat.updated || ""),
    );
  return [...known, ...rest];
};

const pinned_get = (state) =>
  (state.folders.find((f) => f.id === "") || { pinned: [] }).pinned || [];
const parent_get = (file) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
const chats_in = (state, path) =>
  state.chats.filter((c) => c.file.startsWith(`${path}/`)).map((c) => c.id);

// The ids a drag or a tap acts on: all the selected chats when the row is one of them.
const picked_ids = (state, id) =>
  state.ui.selection.on && state.ui.selection.ids.includes(id) ? state.ui.selection.ids : [id];

const select_toggle = (ids) =>
  PP.ui_set((ui) => {
    const all = ids.every((id) => ui.selection.ids.includes(id));
    const rest = ui.selection.ids.filter((id) => !ids.includes(id));
    return { selection: { on: true, ids: all ? rest : [...rest, ...ids] } };
  });

// Press and hold a row to start selecting (UC17); the tap that ends the press is then ignored.
let held_at = 0;
const hold_handlers = (ids) => {
  let timer = 0;
  const cancel = () => clearTimeout(timer);
  return {
    onPointerDown: () =>
      (timer = setTimeout(() => ((held_at = Date.now()), select_toggle(ids)), 500)),
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onClickCapture: (e) => Date.now() - held_at < 800 && (e.stopPropagation(), e.preventDefault()),
  };
};

// A chat row: name, its tags (muted), "Replying…" or "Reply ready", the pin, the grip.
const chat_row = (state, chat, pinned) => {
  const selecting = state.ui.selection.on;
  const picked = state.ui.selection.ids.includes(chat.id);
  const busy = state.sends.some((s) => s.chat === chat.id && s.status === "sending");
  const ready = !!state.ui.unseen[chat.id];
  const pin = () =>
    PP.chats_move(
      picked_ids(state, chat.id),
      pinned ? { folder: parent_get(chat.file) } : { pinned: 0 },
      pinned ? "chats: unpinned" : "chats: pinned",
    );
  const open = () => (selecting ? select_toggle([chat.id]) : PP.chat_open(chat.id));
  return html`<div
    class=${`row${chat.id === state.ui.chat ? " current" : ""}${picked ? " sel" : ""}`}
    key=${chat.id}
    data-id=${chat.id}
    data-kind="chat"
  >
    ${selecting ? html`<span class=${`cb${picked ? " on" : ""}`}>${picked ? PP.icon_svg("check") : null}</span>` : null}
    <button class="grow ct" onClick=${open} ...${hold_handlers([chat.id])}>${chat.name}</button>
    ${busy ? html`<small class="status">Replying…</small>` : ready ? html`<small class="status"><span class="dot"></span>Reply ready</small>` : (chat.tags || []).length ? html`<small class="ctag">${chat.tags.join(" ")}</small>` : null}
    <button class=${`pb${pinned ? " on" : ""}`} aria-label=${pinned ? "Unpin" : "Pin"} onClick=${pin}>${PP.icon_svg("pin")}</button>
    <span class="grip" aria-label="Drag to move">${PP.icon_svg("grip")}</span>
  </div>`;
};

// A folder: open or closed, its name, how many chats, rename or delete, the grip; a chat dropped
// onto it goes into it.
const folder_row = (state, path, depth) => {
  const open =
    state.ui.folders_open.includes(path) ||
    (PP.chat_get(state) || { file: "" }).file.startsWith(`${path}/`);
  const ids = chats_in(state, path);
  const toggle = () =>
    state.ui.selection.on
      ? select_toggle(ids)
      : PP.ui_set((ui) => ({
          folders_open: open
            ? ui.folders_open.filter((f) => f !== path)
            : [...ui.folders_open, path],
        }));
  return html`<div key=${path} data-id=${path} data-kind="folder">
    <div class="row folder" data-into=${path}>
      <button class="grow fold" onClick=${toggle}>${PP.icon_svg(open ? "down" : "right")} <span>${path.split("/").pop()}</span></button>
      <small class="count">${ids.length}</small>
      <button class="pb" aria-label=${`Rename or delete folder ${path}`} onClick=${() => PP.sheet_open("folder", { path })}>${PP.icon_svg("edit")}</button>
      <span class="grip" aria-label="Drag to move">${PP.icon_svg("grip")}</span>
    </div>
    ${open ? list_render(state, path, depth + 1) : null}
  </div>`;
};

// One list of a folder's entries, which can trade chats with the other lists.
const list_render = (state, path, depth = 0) => {
  const pinned = pinned_get(state);
  return html`<div class=${depth ? "list ind" : "list"} data-list=${path} ref=${PP.sortable_ref(drop_run, { group: "chats", into: true })}>
    ${entries_get(state, path).map((e) => (e.chat ? chat_row(state, e.chat, pinned.includes(e.chat.id)) : folder_row(state, e.folder, depth)))}
  </div>`;
};

// A drop: onto a folder = into it; into Pinned = pinned there; between rows = that place, which
// also takes a chat out of a folder. A folder moves only among its own neighbours.
const drop_run = ({ id, kind, from, to, index, into }) => {
  const state = PP.state_get();
  if (kind === "folder") {
    if (into !== null || to !== from || to === "pinned") return;
    return PP.apply_try((s) => PP.folder_order_move(s, to, id, index), "chats: folders reordered");
  }
  const ids = picked_ids(state, id);
  if (into !== null) return PP.chats_move(ids, { folder: into }, `chats: moved to ${into}`);
  if (to === "pinned") return PP.chats_move(ids, { pinned: index }, "chats: pinned");
  return PP.chats_move(ids, { folder: to, index }, "chats: moved");
};

const drawer_render = (state) => {
  const query = state.ui.query.toLowerCase();
  const pinned_ids = pinned_get(state);
  const pinned = pinned_ids.map((id) => state.chats.find((c) => c.id === id)).filter(Boolean);
  const found = query
    ? state.chats.filter((c) =>
        `${c.name} ${(c.tags || []).map((t) => `#${t}`).join(" ")}`.toLowerCase().includes(query),
      )
    : null;
  const tags = [...new Set(state.chats.flatMap((c) => c.tags || []))].sort().slice(0, 12);
  const sel = state.ui.selection;
  const all_pinned = sel.ids.length && sel.ids.every((id) => pinned_ids.includes(id));
  const done = () => PP.ui_set(() => ({ selection: { on: false, ids: [] } }));
  const pin_all = () =>
    PP.chats_move(
      sel.ids,
      all_pinned ? { folder: "" } : { pinned: 0 },
      all_pinned ? "chats: unpinned" : "chats: pinned",
    ).then(done);
  const updates = ((state.catalogue && state.catalogue.updates) || []).length;
  const close = () => PP.ui_set(() => ({ drawer: false }));
  return html`<div class="layer">
    <div class="scrim" onClick=${close}></div>
    <div class="drawer" role="dialog" aria-label="Chats">
      <h2>
        <span class="grow">Chats</span>
        ${PP.icon_render("check", sel.on ? "Done selecting" : "Select chats", () => (sel.on ? done() : PP.ui_set(() => ({ selection: { on: true, ids: [] } }))), sel.on)}
        ${PP.setting_get(state, "help.button") ? PP.icon_render("help", "Help: explain things", () => PP.command_run("help_mode"), state.ui.help) : null}
        ${PP.icon_render("close", "Close", close)}
      </h2>
      <div class="chips">
        <button class="item prim grow" onClick=${() => PP.command_run("chat_new")}>+ New chat</button>
        <button class="item auto" onClick=${() => PP.ui_set(() => ({ folder_new: "" }))}>+ Folder</button>
      </div>
      ${
        state.ui.folder_new !== undefined && state.ui.folder_new !== null
          ? html`<div class="search">
            ${PP.icon_svg("folder")}
            <input aria-label="Folder name" placeholder="Folder name" ref=${PP.focus_ref} value=${state.ui.folder_new}
              onInput=${(e) => PP.ui_set(() => ({ folder_new: e.target.value }))}
              onKeyDown=${(e) => e.key === "Enter" && PP.folder_create(PP.state_get(), e.target.value).then(() => PP.ui_set(() => ({ folder_new: null })))} />
            <button class="pill" onClick=${() => PP.folder_create(PP.state_get(), state.ui.folder_new).then(() => PP.ui_set(() => ({ folder_new: null })))}>Create</button>
            <button class="pill" onClick=${() => PP.ui_set(() => ({ folder_new: null }))}>Cancel</button>
          </div>`
          : null
      }
      <div class="search">
        ${PP.icon_svg("search")}
        <input type="search" placeholder="Search chats, #tag" aria-label="Search chats" value=${state.ui.query} onInput=${(e) => PP.ui_set(() => ({ query: e.target.value }))} />
      </div>
      ${tags.length ? html`<div class="chips">${tags.map((t) => html`<button class="pill" key=${t} onClick=${() => PP.ui_set(() => ({ query: `#${t}` }))}>#${t}</button>`)}</div>` : null}
      ${
        sel.on
          ? html`<div class="chips selbar">
            <small class="grow">${sel.ids.length} selected</small>
            <button class="pill" onClick=${pin_all}>${all_pinned ? "Unpin" : "Pin"}</button>
            <button class="pill" onClick=${() => PP.sheet_open("move", { ids: sel.ids })}>Move…</button>
            <button class="pill" onClick=${() => PP.chats_delete_ask(sel.ids)}>Delete</button>
            <button class="pill on" onClick=${done}>Done</button>
          </div>`
          : null
      }
      <div class="lists">
        ${
          found
            ? found.map((c) => chat_row(state, c, pinned_ids.includes(c.id)))
            : html`<div class="row folder pinhead">
                <button class="grow fold" onClick=${() => PP.ui_set((ui) => ({ pinned_closed: !ui.pinned_closed }))}>${PP.icon_svg(state.ui.pinned_closed ? "right" : "down")} <span>Pinned</span></button>
                <small class="count">${pinned.length}</small><span class="pb">${PP.icon_svg("pin")}</span>
              </div>
              <div class=${`list${state.ui.pinned_closed ? " shut" : ""}`} data-list="pinned" ref=${PP.sortable_ref(drop_run, { group: "chats" })}>
                ${state.ui.pinned_closed ? null : pinned.map((c) => chat_row(state, c, true))}
              </div>
              ${list_render(state, "")}`
        }
      </div>
      <div class="chips drawerfoot">
        <button class="pill big" onClick=${() => PP.command_run("settings")}>${PP.icon_svg("settings")} Settings${updates ? html`<span class="badge">${updates}</span>` : null}</button>
        <button class="pill big" onClick=${() => PP.command_run("quick_start")}>${PP.icon_svg("play")} Quick start</button>
      </div>
    </div>
  </div>`;
};

// The site view: back, the pages as tabs with their state, close, a new page, the address bar
// (not overwritten while you type, #240), and which chat the page is linked to (UC12).
const site_bar_render = (state) => {
  const shown = state.pages.find((p) => p.id === state.ui.site_view.page) || state.pages[0];
  const show = (page) => {
    PP.ui_set(() => ({ site_view: { open: true, page: page.id } }));
    PP.call_try("view_set", { page: page.id, region: PP.region_get() });
  };
  const linked = state.chats.find((c) => shown && c.site_url && shown.url.startsWith(c.site_url));
  const go = (e) =>
    e.key === "Enter" && PP.call_try("page_navigate", { page: shown.id, to: e.target.value });
  const close = () => (
    PP.ui_set(() => ({ site_view: { open: false, page: null } })),
    PP.call_try("view_set", { page: null })
  );
  // A page not linked to a chat: a chat linked to it (made if there's none), then opened.
  const open_here = async (page) => {
    const chat = await PP.call_try("site_chat_open", {
      provider: page.provider,
      url: page.url,
      name: page.title,
      id: PP.id_create(),
      at: PP.time_get(),
    });
    if (chat) (close(), PP.chat_open(chat.id));
  };
  const chat_of = (page) => state.chats.find((c) => c.site_url && page.url.startsWith(c.site_url));
  const plugin = shown && state.plugins.find((p) => p.id === shown.provider);
  const dot = (p) => (p.status === "ready" ? "ready" : p.status === "busy" ? "busy" : "off");
  return html`<div class="site-bar" id="site-bar">
      <div class="top">
        ${PP.icon_render("back", "Back to the chat", close)}
        <span class="t">AI page${plugin ? ` · ${plugin.manifest.name}` : ""}</span>
        ${PP.setting_get(state, "help.button") ? PP.icon_render("help", "Help: explain things", () => PP.command_run("help_mode"), state.ui.help) : null}
        <button class="pill" onClick=${() => PP.sheet_open("provider")}>Profile and site</button>
      </div>
      <div class="tabstrip" role="tablist">
        ${state.pages.map((p) => {
          const chat = chat_of(p);
          return html`<div class=${`it page${p === shown ? " on" : ""}`} role="tab" aria-selected=${String(p === shown)} key=${p.id}>
            <button class="pt" onClick=${() => show(p)}>
              <span class=${`dot ${dot(p)}`}></span><span class="tx">${chat ? chat.name : "Not linked"}</span>
            </button>
            ${PP.icon_render("close", "Close page", () => PP.call_try("page_close", { page: p.id }), false, "act")}
          </div>`;
        })}
        ${PP.icon_render("plus", "New page", () => PP.view_page_add(state), false, "icon card")}
      </div>
      ${
        shown
          ? html`<div class="urlbar">
              ${PP.icon_render("back", "Back inside the site", () => PP.call_try("page_navigate", { page: shown.id, to: "back" }), false, "icon card")}
              <label class="search"><input aria-label="Page address" value=${shown.url} onKeyDown=${go} /></label>
              ${PP.icon_render("retry", "Reload", () => PP.call_try("page_navigate", { page: shown.id, to: "reload" }), false, "icon card")}
            </div>`
          : null
      }
      ${
        shown
          ? linked
            ? html`<div class="foot linkrow">
                <span class="grow">Linked to chat: ${linked.name}</span>
                <button class="pill" onClick=${() => (close(), PP.chat_open(linked.id))}>Open chat</button>
              </div>`
            : html`<button class="item prim linkrow" onClick=${() => open_here(shown)}>Open in PromptPipe</button>`
          : null
      }
    </div>
    <div class="site-page">
      ${shown ? html`<b>${new URL(shown.url).host}</b><p>The site's page shows here: your log-in, the chat as the site draws it, and its own buttons.</p>` : "No pages open. Tap + for a new one."}
    </div>`;
};

// ---------- Find ----------

// Ranked by where each word falls: the name's start 4, a later word's start 3, inside 2, the
// place 1; commands before chats when tied.
const result_compare = (words) => (a, b) =>
  score(b, words) - score(a, words) || (a.chat ? 1 : 0) - (b.chat ? 1 : 0);
const score = (entry, words) =>
  words.reduce((sum, w) => {
    const name = entry.label.toLowerCase();
    if (name.startsWith(w)) return sum + 4;
    if (name.split(/\s+/).some((x) => x.startsWith(w))) return sum + 3;
    if (name.includes(w)) return sum + 2;
    return sum + ((entry.place || "").toLowerCase().includes(w) ? 1 : 0);
  }, 0);

// 40 characters before the first match, 140 after, the matches marked.
const snippet_build = (text, words) => {
  const lower = text.toLowerCase();
  const at = Math.max(
    0,
    Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), text.length),
  );
  const start = Math.max(0, at - 40);
  const part =
    (start ? "…" : "") + text.slice(start, at + 140) + (at + 140 < text.length ? "…" : "");
  const marked = words.reduce(
    (t, w) =>
      t.replace(
        new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
        (m) => `\u0001${m}\u0002`,
      ),
    part,
  );
  return marked
    .split(/(\u0001[^\u0002]*\u0002)/)
    .map((p) => (p.startsWith("\u0001") ? html`<mark>${p.slice(1, -1)}</mark>` : p));
};

// Your last picks in Find, kept on this device (a convenience: it can be empty).
const recent_get = () => {
  try {
    return JSON.parse(localStorage.getItem("pp:find_recent") || "[]");
  } catch {
    return [];
  }
};
const recent_add = (entry) => {
  try {
    const list = [
      { id: entry.id, label: entry.label },
      ...recent_get().filter((r) => r.id !== entry.id),
    ];
    localStorage.setItem("pp:find_recent", JSON.stringify(list.slice(0, 4)));
  } catch {}
};

// Everything Find knows: chats, functions (the commands) and settings, each with where it lives.
const find_entries = (state) => [
  ...state.chats.map((c) => ({ id: c.id, label: c.name, place: "Chat", chat: c })),
  ...[...PP.COMMANDS, ...(PP.plugin_commands || [])],
  ...(state.schemas.settings || [])
    .filter((d) => d.section && !d.hidden)
    .map((d) => ({
      id: `setting:${d.key}`,
      label: d.label,
      place: `Settings › ${d.section}`,
      setting: d,
    })),
];

// A pick: a chat opens; a setting opens its section with the row lit up; a function runs.
const find_run = (state, entry) => {
  recent_add(entry);
  if (entry.chat) return (PP.ui_set(() => ({ sheets: [] })), PP.chat_open(entry.chat.id));
  if (entry.setting)
    return PP.ui_set(() => ({
      sheets: [
        { name: "settings", data: {} },
        { name: "section", data: { name: entry.setting.section } },
      ],
      lit: entry.label,
    }));
  PP.ui_set(() => ({ sheets: [] }));
  PP.command_run(entry.id);
};

const find_row = (state, e) =>
  PP.item_render({
    key: e.id,
    label: e.label,
    sub: e.place,
    right: e.key ? html`<kbd>${e.key}</kbd>` : null,
    onClick: () => find_run(state, e),
  });

const find_render = (state) => {
  const text = state.ui.query;
  const query = PP.query_parse(text);
  const words = query.words;
  const entries = find_entries(state);
  const matches = (e) =>
    words.length && words.every((w) => `${e.label} ${e.place || ""}`.toLowerCase().includes(w));
  const found = entries.filter(matches).sort(result_compare(words));
  const group = (title, list, n) =>
    list.length
      ? html`<div class="label">${title}</div>${list.slice(0, n).map((e) => find_row(state, e))}`
      : null;
  const messages = state.ui.find_results || [];
  const recent = recent_get()
    .map((r) => entries.find((e) => e.id === r.id))
    .filter(Boolean);
  return html`<div class="search">
      ${PP.icon_svg("search")}
      <input type="search" ref=${PP.focus_ref} placeholder="Find chats and functions" aria-label="Find chats and functions"
        value=${text} onInput=${(e) => PP.find_search(e.target.value)} />
    </div>
    ${
      !text
        ? html`${
            recent.length
              ? html`<div class="label">Recent</div>
            <div class="chips">${recent.map((e) => html`<button class="pill" key=${e.id} onClick=${() => find_run(state, e)}>${e.label}</button>`)}</div>`
              : null
          }
          <div class="label">Try</div>
          <div class="chips">
            ${["model", "profile", "plugin", "prompt", "export", "folder"].map((w) => html`<button class="pill" key=${w} onClick=${() => PP.find_search(w)}>${w}</button>`)}
          </div>
          <small>In messages too: "phrase", #tag, in:folder, is:you</small>`
        : null
    }
    ${group(
      "Chats",
      found.filter((e) => e.chat),
      8,
    )}
    ${group(
      "Functions",
      found.filter((e) => !e.chat && !e.setting),
      25,
    )}
    ${group(
      "Settings",
      found.filter((e) => e.setting),
      15,
    )}
    ${text.length >= 2 && messages.length ? html`<div class="label">Messages (${messages.length})</div>` : null}
    ${messages.slice(0, 200).map((m) => {
      const chat = state.chats.find((c) => c.id === m.chat) || { name: "?" };
      const all = [...words, ...query.phrases];
      return PP.item_render({
        key: `${m.chat}/${m.turn.id}`,
        label: `${chat.name} · ${(m.turn.at || "").slice(0, 16).replace("T", " ")}`,
        sub: snippet_build(`${m.turn.message} ⟶ ${m.turn.reply}`, all),
        onClick: () => (PP.ui_set(() => ({ sheets: [] })), PP.chat_open(m.chat)),
      });
    })}`;
};

let find_timer = 0;
const find_search = (text) => {
  PP.ui_set(() => ({ query: text }));
  clearTimeout(find_timer);
  find_timer = setTimeout(async () => {
    const results =
      text.length >= 2 ? await PP.chat_find(PP.state_get(), text).catch(() => []) : [];
    PP.ui_set(() => ({ find_results: results }));
  }, 120);
};

PP.plugin_set({
  functions: {
    folder_list,
    folder_order_move,
    order_fill,
    drawer_render,
    site_bar_render,
    find_render,
    find_search,
    snippet_build,
    result_compare,
  },
});
