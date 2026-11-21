"use strict";
// Chats: counting tags, Find's query and the search, folders and your order, site chats,
// attachments, the chats folder, and the files a chat is saved as. Functions that change records
// return { state, targets } (or { error }); the loader applies the state and saves the targets.

// ---------- tags (UC20) ----------
// A tag ending in "#" counts up. A chat keeps "name#"; each new message gets the next number; a
// message holds one number per counter. Counters run within each chat or across all chats, as set.

const tag_clean = (raw) => String(raw || "").trim().replace(/\s+/g, "-");
const counter_parse = (tag) => /^(.+)#(\d*)$/.exec(tag);

// The tag a chat keeps: a numbered counter tag goes back to "name#".
const chat_tag_build = (raw) => {
  const tag = tag_clean(raw);
  const counter = counter_parse(tag);
  return counter ? `${counter[1]}#` : tag;
};

// A tag added to one message: "name#" takes the next number, "name#7" sets 7 (and the counter
// moves up to it); either replaces the message's earlier number for that counter.
const turn_tag_build = (tags, raw, counters, scope) => {
  const tag = tag_clean(raw);
  const counter = counter_parse(tag);
  if (!counter) return { tags: [...new Set([...tags, tag])], counters };
  const key = `${scope}/${counter[1]}`;
  const number = counter[2] ? Number(counter[2]) : (counters[key] || 0) + 1;
  const next = { ...counters, [key]: Math.max(counters[key] || 0, number) };
  const others = tags.filter((t) => (counter_parse(t) || [])[1] !== counter[1]);
  return { tags: [...others, `${counter[1]}#${number}`], counters: next };
};

// A new message's tags: the chat's, with each counter numbered.
const turn_tags_build = (chat_tags, counters, scope) =>
  chat_tags.reduce((acc, tag) => turn_tag_build(acc.tags, tag, acc.counters, scope), {
    tags: [],
    counters,
  });

// ---------- Find (UC18) ----------

// Words, "exact phrases", #tag (a prefix), in:folder, is:you or is:ai.
const query_parse = (text) => {
  const query = { words: [], phrases: [], tags: [], folder: "", side: "" };
  const parts = String(text).match(/"[^"]*"|\S+/g) || [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (part.startsWith('"')) query.phrases.push(lower.replace(/"/g, ""));
    else if (part.startsWith("#") && part.length > 1) query.tags.push(lower.slice(1));
    else if (lower.startsWith("in:")) query.folder = part.slice(3);
    else if (lower === "is:you" || lower === "is:ai") query.side = lower.slice(3);
    else query.words.push(lower);
  }
  return query;
};

const folder_get = (file) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");

// Every message that matches, newest first: the core finds the text, the rest is checked here.
const chat_find = async (state, text) => {
  const query = query_parse(text);
  const ask = { root: "chats", words: query.words, phrases: query.phrases };
  const matches = await PP.call_send("file_find", ask);
  const chats = new Map(state.chats.map((c) => [c.id, c]));
  return matches
    .filter(({ chat, turn }) => {
      const meta = chats.get(chat);
      if (!meta) return false;
      if (query.folder && !folder_get(meta.file).startsWith(query.folder)) return false;
      const tags = [...(turn.tags || []), ...(meta.tags || [])].map((t) => t.toLowerCase());
      if (!query.tags.every((q) => tags.some((t) => t.startsWith(q)))) return false;
      const side = query.side === "you" ? turn.message : query.side === "ai" ? turn.reply : null;
      const all = side ?? `${meta.name} ${turn.message} ${turn.reply}`;
      return [...query.words, ...query.phrases].every((w) => all.toLowerCase().includes(w));
    })
    .sort((a, b) => (b.turn.at || "").localeCompare(a.turn.at || ""));
};

// ---------- folders and your order (UC17) ----------
// A Folder record keeps your order of its entries (chat ids and folder names) and, at the top
// level, the pinned chats. place: { folder, index } or { pinned: index }.

const folder_record_get = (state, path) =>
  state.folders.find((f) => f.id === path) || { id: path, order: [], pinned: [] };

const folder_put = (folders, record) => [...folders.filter((f) => f.id !== record.id), record];

// A chat's file name in a folder: its name, made safe for a file system, unique there.
const chat_file_build = (state, name, folder) => {
  const safe = String(name || "Chat").replace(/[\\/:*?"<>|\n]+/g, " ");
  const base = safe.trim().slice(0, 60) || "Chat";
  const taken = new Set(state.chats.map((c) => c.file));
  const path = (n) => (folder ? `${folder}/` : "") + (n === 1 ? base : `${base} (${n})`) + ".md";
  let n = 1;
  while (taken.has(path(n))) n += 1;
  return path(n);
};

const folder_move = (state, ids, place) => {
  // Out of every order and out of Pinned first, then in at the new place.
  let folders = state.folders.map((f) => ({
    ...f,
    order: f.order.filter((id) => !ids.includes(id)),
    pinned: (f.pinned || []).filter((id) => !ids.includes(id)),
  }));
  const top = folder_record_get({ folders }, "");
  if (place.pinned !== undefined) {
    const pinned = [...top.pinned];
    pinned.splice(place.pinned, 0, ...ids);
    folders = folder_put(folders, { ...top, pinned });
    return { state: { ...state, folders }, targets: [{ file: "folders" }], moves: [] };
  }
  const name_get = (file) => file.split("/").pop();
  const moves = state.chats
    .filter((c) => ids.includes(c.id))
    .map((c) => {
      const to = (place.folder ? `${place.folder}/` : "") + name_get(c.file);
      return { id: c.id, from: c.file, to };
    });
  const clash = moves.find((m) => m.from !== m.to && state.chats.some((c) => c.file === m.to));
  if (clash) {
    const name = name_get(clash.to).replace(/\.md$/, "");
    const message = `"${name}" already exists. Rename one of the chats first.`;
    return { error: { code: "already_exists", message } };
  }
  const target = folder_record_get({ folders }, place.folder || "");
  const order = [...target.order];
  order.splice(place.index ?? order.length, 0, ...ids);
  folders = folder_put(folders, { ...target, order });
  const files = new Map(moves.map((m) => [m.id, m.to]));
  const chats = state.chats.map((c) => (files.has(c.id) ? { ...c, file: files.get(c.id) } : c));
  const targets = [{ file: "folders" }, ...ids.map((id) => ({ chat: id }))];
  return { state: { ...state, chats, folders }, targets, moves };
};

// ---------- site chats (UC13) ----------

const url_same = (a, b) => {
  const clean = (u) => String(u || "").replace(/[?#].*$/, "").replace(/\/$/, "");
  return clean(a) !== "" && clean(a) === clean(b);
};

// The chat already linked to this site chat, or a new one linked to it.
const site_chat_open = (state, { provider, url, name, id, at }) => {
  const known = state.chats.find((c) => url_same(c.site_url, url));
  if (known) return { state, record: known, targets: [] };
  const file = chat_file_build(state, name || "Site chat", "");
  const fields = { name: name || url, file, site_url: url, own: { provider }, tags: [] };
  const dated = { ...fields, created: at, updated: at };
  return PP.record_create(state, { collection: "chats", fields: dated, id });
};

// The page's messages into the chat (all of them, or the newest); with save off, the newest
// reply decoded by the after-reply hooks, as a preview.
const site_chat_import = async (state, { chat, page, which, save }) => {
  const turns = await PP.call_send("site_read", { page, which, wait: false });
  if (!save) {
    const last = turns[turns.length - 1] || {};
    return { preview: await PP.hook_run("reply_after", last.reply || "", { chat }) };
  }
  let result = { state, targets: [] };
  for (const turn of turns) {
    const fields = { ...turn, chat, at: PP.time_get(), tags: [] };
    const create = { collection: "turns", fields, id: PP.id_create() };
    const made = PP.record_create(result.state, create);
    if (made.error) return made;
    result = { state: made.state, targets: [{ chat }] };
  }
  return result;
};

// ---------- attachments (UC48) ----------

// Files are copied into the chat's data folder at once (so a draft's attachments survive a
// restart) and listed on the chat's draft.
const attachment_add = async (state, { chat, files }) => {
  const added = [];
  for (const file of files) {
    const id = PP.id_create();
    const path = `.promptpipe/chats/${chat}/attachments/${id}-${file.name}`;
    await PP.call_send("file_write", { root: "chats", path, data: file.data, encoding: "base64" });
    added.push({ id, name: file.name, mime_type: file.mime_type, size: file.size, path });
  }
  const draft = state.drafts.find((d) => d.id === chat) || { id: chat, text: "", attachments: [] };
  const next = { ...draft, attachments: [...draft.attachments, ...added] };
  const drafts = [...state.drafts.filter((d) => d.id !== chat), next];
  return { state: { ...state, drafts }, targets: [{ file: "drafts" }], attachments: added };
};

// ---------- the chats folder (UC36) ----------

// move: use the new folder, then copy the chats into it; use: use it as it is; merge: copy its
// chats into the folder in use. Copies never overwrite (the core's `file_move` with `copy`).
const chats_folder_move = async (state, { folder, how }) => {
  const old = PP.setting_get(state, "storage.chats_folder");
  const fields = { "storage.chats_folder": folder };
  const set = () => PP.record_set(state, { collection: "settings", fields });
  const result = how === "merge" ? { state, targets: [] } : set();
  if (how === "use") return result;
  if (how === "move") await PP.store_save(result.state, result.targets);
  const from = how === "merge" ? folder : old;
  const copy = { root: "device", from, to_root: "chats", to: "", copy: true, overwrite: false };
  return { ...result, copied: (await PP.call_send("file_move", copy)).copied };
};

// ---------- the files a chat is saved as ----------

// meta.json (the chat without its turns), turns.json, and the readable file.
const chat_files_build = async (state, id) => {
  const meta = state.chats.find((c) => c.id === id);
  const loaded = (state.loaded || []).includes(id);
  const dir = `.promptpipe/chats/${id}`;
  const read = () => PP.call_send("file_read", { root: "chats", path: `${dir}/turns.json` });
  const turns = loaded
    ? state.turns.filter((t) => t.chat === id)
    : JSON.parse((await read())[0].data);
  const chat = { ...meta, turns };
  const info = {
    provider: PP.provider_get(state, chat),
    model: PP.model_get(state, chat),
    profile: PP.profile_get(state, chat).name,
    offset_min: PP.time_offset_get ? PP.time_offset_get() : 0,
  };
  const sections = PP.hook_run ? await PP.hook_run("chat_section_format", [], { chat }) : [];
  return [
    { root: "chats", path: `${dir}/meta.json`, data: meta },
    { root: "chats", path: `${dir}/turns.json`, data: turns },
    { root: "chats", path: meta.file, data: PP.chat_format(chat, info, sections) },
  ];
};

PP.plugin_set({
  functions: {
    chat_tag_build,
    turn_tag_build,
    turn_tags_build,
    query_parse,
    chat_find,
    folder_move,
    chat_file_build,
    site_chat_open,
    site_chat_import,
    attachment_add,
    chats_folder_move,
    chat_files_build,
  },
  calls: {
    chat_find: (d, state) => chat_find(state, d.query),
    site_chat_open: (d, state) => site_chat_open(state, d),
    site_chat_import: (d, state) => site_chat_import(state, d),
    attachment_add: (d, state) => attachment_add(state, d),
    chats_folder_move: (d, state) => chats_folder_move(state, d),
  },
});
