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

const chat_row = (state, chat) => {
  const selecting = state.ui.selection.on;
  const picked = state.ui.selection.ids.includes(chat.id);
  const busy = state.sends.some((s) => s.chat === chat.id && s.status === "sending");
  const unseen = !!state.ui.unseen[chat.id];
  const pin = () => PP.apply_try((s) => PP.folder_move(s, [chat.id], { pinned: 0 }));
  const open = () =>
    selecting
      ? PP.ui_set((ui) => ({
          selection: {
            on: true,
            ids: picked
              ? ui.selection.ids.filter((x) => x !== chat.id)
              : [...ui.selection.ids, chat.id],
          },
        }))
      : PP.chat_open(chat.id);
  return html`<div
    class=${`row${chat.id === state.ui.chat ? " current" : ""}`}
    key=${chat.id}
    data-id=${chat.id}
  >
    <span class="grip" aria-label="Drag to move">⋮⋮</span>
    ${selecting ? html`<span>${picked ? "☑" : "☐"}</span>` : null}
    <button class="grow" onClick=${open}>
      ${chat.name}${
        (chat.tags || []).length ? html` <small>#${chat.tags.join(" #")}</small>` : null
      }
    </button>
    ${
      busy
        ? html`<small>answering…</small>`
        : unseen
          ? html`<small class="badge">new</small>`
          : null
    }
    <button aria-label="Pin" onClick=${pin}>📌</button>
  </div>`;
};

const folder_rows = (state, path, depth = 0) =>
  entries_get(state, path).map((e) => {
    if (e.chat) return chat_row(state, e.chat);
    const open =
      state.ui.folders_open.includes(e.folder) ||
      (PP.chat_get(state) || { file: "" }).file.startsWith(`${e.folder}/`);
    const toggle = () =>
      PP.ui_set((ui) => ({
        folders_open: open
          ? ui.folders_open.filter((f) => f !== e.folder)
          : [...ui.folders_open, e.folder],
      }));
    return html`<div key=${e.folder} data-id=${e.folder}>
      <div class="row folder">
        <span class="grip">⋮⋮</span
        ><button class="grow" onClick=${toggle}>
          ${open ? "▾" : "▸"} ${e.folder.split("/").pop()}
        </button>
        <button
          aria-label="New chat here"
          onClick=${() => (PP.ui_set(() => ({ folder: e.folder })), PP.chat_open(null))}
        >
          ＋
        </button>
      </div>
      ${
        open
          ? html`<div style="margin-left:16px">${folder_rows(state, e.folder, depth + 1)}</div>`
          : null
      }
    </div>`;
  });

const drawer_render = (state) => {
  const query = state.ui.query.toLowerCase();
  const pinned_ids = (state.folders.find((f) => f.id === "") || { pinned: [] }).pinned || [];
  const pinned = pinned_ids.map((id) => state.chats.find((c) => c.id === id)).filter(Boolean);
  const found = query
    ? state.chats.filter((c) =>
        `${c.name} ${(c.tags || []).map((t) => `#${t}`).join(" ")}`.toLowerCase().includes(query),
      )
    : null;
  const tags = [...new Set(state.chats.flatMap((c) => c.tags || []))].slice(0, 12);
  const move = (id, index) => PP.apply_try((s) => PP.folder_move(s, [id], { folder: "", index }));
  const sel = state.ui.selection;
  const bulk = (run) => () => (
    run(sel.ids), PP.ui_set(() => ({ selection: { on: false, ids: [] } }))
  );
  return html`<div class="layer">
    <div class="scrim" onClick=${() => PP.ui_set(() => ({ drawer: false }))}></div>
    <div class="drawer" role="dialog" aria-label="Chats">
      <h2>Chats</h2>
      <div class="chips">
        <button class="item prim" style="flex:1" onClick=${() => PP.command_run("chat_new")}>
          New chat
        </button>
        <button class="pill" onClick=${() => PP.command_run("folder_new")}>New folder</button>
        <button
          class="pill"
          aria-label="Select chats"
          onClick=${() => PP.ui_set(() => ({ selection: { on: !sel.on, ids: [] } }))}
        >
          ${sel.on ? "Done" : "Select"}
        </button>
      </div>
      <input
        class="field"
        type="search"
        placeholder="Search chats"
        aria-label="Search chats"
        value=${state.ui.query}
        onInput=${(e) => PP.ui_set(() => ({ query: e.target.value }))}
      />
      ${
        tags.length
          ? html`<div class="chips">
            ${tags.map(
              (t) =>
                html`<button
                  class="tag"
                  key=${t}
                  onClick=${() => PP.ui_set(() => ({ query: `#${t}` }))}
                >
                  #${t}
                </button>`,
            )}
          </div>`
          : null
      }
      ${
        sel.on
          ? html`<div class="chips">
            <small>${sel.ids.length} picked</small>
            <button
              class="pill"
              onClick=${bulk((ids) => PP.apply_try((s) => PP.folder_move(s, ids, { pinned: 0 })))}
            >
              Pin
            </button>
            <button class="pill" onClick=${() => PP.sheet_open("move", { ids: sel.ids })}>
              Move
            </button>
            <button class="pill" onClick=${bulk((ids) => PP.chats_delete(ids))}>Delete</button>
          </div>`
          : null
      }
      ${
        found
          ? found.map((c) => chat_row(state, c))
          : html`${
              pinned.length
                ? html`<div class="label">Pinned</div>
                  ${pinned.map((c) => chat_row(state, c))}`
                : null
            }
            <div ref=${PP.sortable_ref(move)}>${folder_rows(state, "")}</div>`
      }
      <button class="pill" onClick=${() => PP.sheet_open("site_chats")}>On the site…</button>
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
  return html`<div class="site-bar" id="site-bar">
    <div class="chips">
      ${PP.icon_render("‹", "Back to the chat", close)}<b class="grow">AI page</b> ${PP.icon_render(
        "↻",
        "Reload",
        () => PP.call_try("page_navigate", { page: shown.id, to: "reload" }),
      )}
      ${PP.icon_render("⇠", "Back inside the site", () =>
        PP.call_try("page_navigate", { page: shown.id, to: "back" }),
      )}
    </div>
    <div class="chips">
      ${state.pages.map(
        (p) =>
          html`<span class=${`pill${p === shown ? " on" : ""}`} key=${p.id}>
            <button onClick=${() => show(p)}>
              <span
                class=${`dot ${p.status === "ready" ? "" : p.status === "busy" ? "busy" : "off"}`}
              ></span>
              ${p.title || p.url}
            </button>
            <button
              aria-label="Close page"
              onClick=${() => PP.call_try("page_close", { page: p.id })}
            >
              ✕
            </button></span
          >`,
      )} <button class="pill" aria-label="New page" onClick=${() => PP.view_page_add(state)}>＋</button>
    </div>
    ${
      shown
        ? html`<input class="field" aria-label="Address" value=${shown.url} onKeyDown=${go} />`
        : null
    }
    <small>${linked ? `Linked to “${linked.name}”` : "Not linked to a chat"}</small>
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

const find_render = (state) => {
  const text = state.ui.query;
  const query = PP.query_parse(text);
  const words = query.words;
  const functions = [...PP.COMMANDS, ...(PP.plugin_commands || [])].map((c) => ({
    ...c,
    label: c.label,
  }));
  const chats = state.chats.map((c) => ({ id: c.id, label: c.name, place: "Chat", chat: c }));
  const matches = (e) =>
    words.length && words.every((w) => `${e.label} ${e.place || ""}`.toLowerCase().includes(w));
  const found = [...functions, ...chats].filter(matches).sort(result_compare(words));
  const messages = state.ui.find_results || [];
  const run = (e) => (PP.sheet_close(), e.chat ? PP.chat_open(e.chat.id) : PP.command_run(e.id));
  return html` <input
      class="field"
      type="search"
      autofocus
      placeholder="Find chats and functions"
      aria-label="Find chats and functions"
      value=${text}
      onInput=${(e) => PP.find_search(e.target.value)}
    />
    <small>Also "phrase", #tag, in:folder, is:you</small>
    ${
      !text
        ? html`<div class="label">Try</div>
          <div class="chips">
            ${["model", "profile", "plugin", "prompt", "export", "folder"].map(
              (w) =>
                html`<button class="pill" key=${w} onClick=${() => PP.find_search(w)}>
                  ${w}
                </button>`,
            )}
          </div>`
        : null
    }
    ${found
      .filter((e) => e.chat)
      .slice(0, 8)
      .map((e) =>
        PP.item_render({ key: e.id, label: e.label, sub: e.place, onClick: () => run(e) }),
      )}
    ${found
      .filter((e) => !e.chat)
      .slice(0, 25)
      .map((e) =>
        PP.item_render({
          key: e.id,
          label: e.label,
          sub: e.place,
          right: e.key ? html`<small>${e.key}</small>` : null,
          onClick: () => run(e),
        }),
      )}
    ${text.length >= 2 ? html`<div class="label">Messages (${messages.length})</div>` : null}
    ${messages.slice(0, 200).map((m) => {
      const chat = state.chats.find((c) => c.id === m.chat) || { name: "?" };
      const all = [...words, ...query.phrases];
      return PP.item_render({
        key: `${m.chat}/${m.turn.id}`,
        label: `${chat.name} · ${(m.turn.at || "").slice(0, 16).replace("T", " ")}`,
        sub: snippet_build(`${m.turn.message} ⟶ ${m.turn.reply}`, all),
        onClick: () => (PP.sheet_close(), PP.chat_open(m.chat)),
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
    drawer_render,
    site_bar_render,
    find_render,
    find_search,
    snippet_build,
    result_compare,
  },
});
