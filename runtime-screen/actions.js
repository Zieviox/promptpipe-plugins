"use strict";
// What the screen's commands and rows do beyond opening a sheet: linking a chat to the page and
// importing from it, exporting and importing records, tags, renaming, deleting chats, folders,
// text files and attachments, more pages, and the page report.

const page_shown = (state) =>
  state.pages.find((p) => p.id === state.ui.site_view.page) || state.pages[0];
const chat_set = (chat, fields, message) =>
  PP.apply_try((s) => PP.record_set(s, { collection: "chats", id: chat.id, fields }), message);

// Link the open chat to the page shown (UC12): it reads and sends there from now on.
const chat_link = async (state) => {
  const chat = PP.chat_get(state);
  const page = page_shown(state);
  if (!chat || !page) return PP.toast("Open a chat and its site first", true);
  if (
    await chat_set(
      chat,
      { site_url: page.url, own: { provider: page.provider } },
      `linked: ${chat.name}`,
    )
  )
    PP.toast("Linked");
};

// The page's messages into the chat (all, or the newest), or the newest reply decoded as a
// preview (UC13). With no chat open, a chat linked to the page is opened first.
const site_import = async (state, which, save) => {
  const page = page_shown(state);
  if (!page) return PP.toast("Open the site first", true);
  let chat = state.ui.chat;
  if (!chat && save) {
    const made = await PP.call_try("site_chat_open", {
      provider: page.provider,
      url: page.url,
      name: page.title,
      id: PP.id_create(),
      at: PP.time_get(),
    });
    if (!made) return;
    chat = made.id;
  }
  if (chat) await PP.chat_open(chat);
  const answer = await PP.call_try("site_chat_import", { chat, page: page.id, which, save });
  if (answer && !save)
    PP.sheet_open("text", { title: "The newest reply, decoded", text: answer.preview });
  if (answer && save) {
    const n = (k) => answer[k] || 0;
    const added = n("added") === 1 ? "1 message" : `${n("added")} messages`;
    const parts = [
      n("added") ? `Added ${added}` : "",
      n("fixed") ? `filled in your text in ${n("fixed")}` : "",
      n("skipped") ? `${n("skipped")} were already here` : "",
    ].filter(Boolean);
    PP.toast(
      n("added") || n("fixed")
        ? parts.join("; ").replace(/^./, (c) => c.toUpperCase())
        : "Nothing new: every message on the page is already here",
    );
  }
};

// The record_export call, with the result said: copied, shared, or the file it saved.
const records_export = async (collection, ids, to = "file") => {
  const where = await PP.call_try("record_export", { collection, ids, to });
  if (to === "clipboard") PP.toast("Copied");
  else if (typeof where === "string") PP.toast(`Saved to ${where}`);
};

const chat_export = (state, to) => state.ui.chat && records_export("chats", [state.ui.chat], to);

const text_decode = (base64) => new TextDecoder().decode(PP.base64_decode(base64));

// Files picked and read in; a profile file's name clash is asked unless Settings says (UC27).
const records_import = async (collection, clash) => {
  const files = await PP.call_try("picker_open", {
    types: ["application/json", "text/markdown", "text/plain"],
    many: true,
  });
  for (const file of files || [])
    record_import_run({ collection, text: text_decode(file.data), name: file.name, clash });
};

const record_import_run = async (data) => {
  const answer = await PP.call_try("record_import", data);
  if (!answer) return;
  if (!answer.clashes)
    return PP.toast(data.collection === "prompts" ? "Added to the library" : "Imported");
  const missing = answer.plugins.filter((id) => !PP.state_get().plugins.some((p) => p.id === id));
  PP.dialog_open({
    title: `“${answer.clashes.join("”, “")}” is already here${missing.length ? `. Not installed: ${missing.join(", ")}` : ""}`,
    choices: [
      ["both", "Keep both"],
      ["replace", "Replace"],
    ],
    command: "record_import",
    data,
  });
};

const text_files_add = async (state, many) => {
  const files = await PP.call_try("picker_open", { types: ["text/*", "application/json"], many });
  if (!files || !files.length) return;
  const texts = files.map((f) =>
    many ? `${f.name}:\n\n${text_decode(f.data)}` : text_decode(f.data),
  );
  const now = PP.draft_get(PP.state_get()).text;
  PP.draft_set(`${now}${now ? "\n\n" : ""}${texts.join("\n\n")}`);
};

// Attachments are copied into the chat's data folder at once (UC48); a chat not yet saved keeps
// them under "new" until its first message.
const files_attach = async (state) => {
  const files = await PP.call_try("picker_open", { types: ["*/*"], many: true });
  if (!files || !files.length) return;
  const added = await PP.call_try("attachment_add", { chat: state.ui.chat || "new", files });
  if (!added) return;
  // Said at once when the chat's provider can't send them, not only when the send fails.
  const now = PP.state_get();
  const plugin = now.plugins.find((p) => p.id === PP.provider_get(now, PP.chat_get(now)));
  const refused = PP.attachments_check(plugin, PP.draft_get(now).attachments);
  if (refused) PP.toast(`Attached, but: ${refused}`, true);
  else PP.toast(`${files.length} attached`);
};

// After a change that moved chats' files (a move, a folder renamed or deleted): the files at the
// old places are deleted (the change wrote them at the new ones) and that is committed too.
const old_files_delete = async (result, message) => {
  const gone = ((result && result.moves) || []).filter((m) => m.from !== m.to).map((m) => m.from);
  for (const path of gone)
    await PP.call_send("file_delete", { root: "chats", path }).catch(() => null);
  if (gone.length) await PP.repo_commit(gone, message).catch(() => null);
  return result;
};

// Chats moved into a folder (at a place in it) or into or out of Pinned (UC17).
const chats_move = async (ids, place, message) => {
  const fill = (s) => (place.folder !== undefined ? PP.order_fill(s, place.folder, ids) : s);
  const what =
    place.pinned !== undefined ? "Pinned" : message.includes("unpinned") ? "Unpinned" : "Moved";
  return old_files_delete(
    await PP.apply_try((s) => PP.folder_move(fill(s), ids, place), message, what),
    message,
  );
};

const folder_rename = async (from, to) =>
  old_files_delete(
    await PP.apply_try((s) => PP.folder_rename(s, { from, to }), `folder renamed: ${from} → ${to}`),
    `folder renamed: ${from}`,
  );

const folder_delete = async (path) =>
  old_files_delete(
    await PP.apply_try((s) => PP.folder_delete(s, { path }), `folder deleted: ${path}`),
    `folder deleted: ${path}`,
  );

// Deleting asks first.
const chats_delete_ask = (ids) => {
  const names = PP.state_get()
    .chats.filter((c) => ids.includes(c.id))
    .map((c) => c.name);
  if (!names.length) return;
  PP.dialog_open({
    title:
      names.length === 1
        ? `Delete “${names[0]}”? It stays in the history.`
        : `Delete ${names.length} chats? They stay in the history.`,
    choices: [["yes", "Delete"]],
    command: "chats_delete",
    data: { ids },
  });
};

// A folder is a Folder record until a chat is moved into it.
const folder_create = (state, name) => {
  const clean = String(name || "")
    .trim()
    .replace(/[\\:*?"<>|]/g, "-")
    .replace(/^\/+|\/+$/g, "");
  if (!clean) return;
  const id = state.ui.folder ? `${state.ui.folder}/${clean}` : clean;
  return PP.apply_try(
    (s) => PP.record_create(s, { collection: "folders", id, fields: { order: [] } }),
    `folder: ${id}`,
  );
};

const chat_tag_add = (state, raw) => {
  const chat = PP.chat_get(state);
  if (!chat || !String(raw || "").trim()) return;
  return chat_set(
    chat,
    { tags: [...new Set([...(chat.tags || []), PP.chat_tag_build(raw)])] },
    `tag: ${chat.name}`,
  );
};

const chat_tag_remove = (state, tag) => {
  const chat = PP.chat_get(state);
  return (
    chat &&
    PP.apply_try(
      (s) =>
        PP.record_set(s, {
          collection: "chats",
          id: chat.id,
          fields: { tags: (chat.tags || []).filter((t) => t !== tag) },
        }),
      `tag removed: ${chat.name}`,
      `Tag ${tag} removed`,
    )
  );
};

// One message's tag: "name#" takes the counter's next number (UC20).
const turn_tag_add = (state, id, raw) =>
  PP.apply_try((s) => {
    const turn = s.turns.find((t) => t.id === id);
    const scope = PP.setting_get(s, "tags.counter_scope") === "all" ? "all" : turn.chat;
    const tagged = PP.turn_tag_build(turn.tags || [], raw, s.counters || {}, scope);
    const set = PP.record_set(s, { collection: "turns", id, fields: { tags: tagged.tags } });
    if (set.error) return set;
    return {
      ...set,
      state: { ...set.state, counters: tagged.counters },
      targets: [...set.targets, { file: "counters" }],
    };
  }, "message tagged");

const chat_rename = (state, name) => {
  const chat = PP.chat_get(state);
  return (
    chat &&
    String(name || "").trim() &&
    chat_set(chat, { name: name.trim() }, `renamed: ${name.trim()}`)
  );
};

// Deleted chats leave the State and the folder; they stay in the history (UC17). Their messages
// are loaded first, so Undo brings the whole chat back.
const chats_delete = async (ids) => {
  for (const id of ids) await PP.chat_load(id);
  const state = PP.state_get();
  const gone = state.chats.filter((c) => ids.includes(c.id));
  if (!gone.length) return;
  const label = gone.length === 1 ? `deleted: ${gone[0].name}` : `deleted: ${gone.length} chats`;
  await PP.apply_try(
    (s) => ({
      state: {
        ...s,
        chats: s.chats.filter((c) => !ids.includes(c.id)),
        turns: s.turns.filter((t) => !ids.includes(t.chat)),
      },
      targets: [],
    }),
    label,
    gone.length === 1 ? "Chat deleted" : `${gone.length} chats deleted`,
  );
  PP.ui_set((ui) => ({ chat: ids.includes(ui.chat) ? null : ui.chat, sheets: [] }));
  const paths = gone.flatMap((c) => [
    `.promptpipe/chats/${c.id}/meta.json`,
    `.promptpipe/chats/${c.id}/turns.json`,
    c.file,
  ]);
  for (const path of paths)
    await PP.call_send("file_delete", {
      root: "chats",
      path,
      expected: (state.revisions || {})[`chats/${path}`],
    }).catch(() => null);
  await PP.repo_commit(paths, label).catch((e) => PP.toast(e.message, true));
};

// Another page of the shown page's provider (the site view's ＋), through the pool's page_add.
const view_page_add = async (state) => {
  const page = page_shown(state);
  const plugin = page && state.plugins.find((p) => p.id === page.provider);
  if (!plugin) return PP.toast("Open a provider's site first", true);
  const added = await PP.page_add(PP.provider_build(state, plugin), plugin.manifest.provider.url);
  if (!added) return PP.toast("That's the most pages at once (Settings › Sites)", true);
  PP.ui_set(() => ({ site_view: { open: true, page: added.id } }));
};

// The site view's place on the screen, as fractions of the screen's area (the contract's
// `view_set` region: l, t, r, b from 0 to 1): under the site bar, to the bottom.
const region_get = () => {
  const bar = document.getElementById("site-bar");
  const top = bar ? bar.getBoundingClientRect().bottom : 0;
  return { l: 0, t: Math.min(1, top / Math.max(1, innerHeight)), r: 1, b: 1 };
};

// The page's outline (a provider's own report wins, UC46), headed with the provider and address,
// for whoever fixes the provider plugin.
const page_report_copy = async (id) => {
  const state = PP.state_get();
  const page = state.pages.find((p) => p.id === id);
  if (!page) return PP.toast("No page to report", true);
  const report = await PP.call_try("site_report_build", { page: id });
  const plugin = state.plugins.find((p) => p.id === page.provider);
  const name = plugin ? plugin.manifest.name : "the site";
  const text = report && `Page Report for ${name} (${report.url})\n\n${report.report}`;
  if (text)
    PP.call_try(
      "clipboard_write",
      { text },
      "Page Report copied. Paste it to whoever fixes the provider plugin.",
    );
};

const credential_create = async (form) => {
  const list = (text) =>
    String(text || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  if (!form.name || !form.value) return PP.toast("A name and the secret, please", true);
  const made = await PP.call_try(
    "credential_create",
    { ...form, hosts: list(form.hosts), tags: list(form.tags) },
    "Saved",
  );
  if (!made) return;
  PP.state_set((s) => ({
    ...s,
    credentials: [...s.credentials.filter((c) => c.name !== made.name), made],
    ui: { ...s.ui, credential_form: null },
  }));
  PP.sheet_close();
};

const credential_delete = async (name) => {
  if ((await PP.call_try("credential_delete", { name }, "Removed")) !== null)
    PP.state_set((s) => ({ ...s, credentials: s.credentials.filter((c) => c.name !== name) }));
};

PP.plugin_set({
  functions: {
    chat_link,
    site_import,
    records_export,
    records_import,
    record_import_run,
    chat_export,
    text_files_add,
    files_attach,
    folder_create,
    chat_tag_add,
    chat_tag_remove,
    turn_tag_add,
    chat_rename,
    chats_delete,
    chats_move,
    chats_delete_ask,
    folder_rename_run: folder_rename,
    folder_delete_run: folder_delete,
    view_page_add,
    region_get,
    page_report_copy,
    credential_create,
    credential_delete,
  },
});
