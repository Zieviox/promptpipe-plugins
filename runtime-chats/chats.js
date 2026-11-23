"use strict";
// Chats: counting tags, Find's query and the search, folders and your order, site chats,
// attachments, the chats folder, and the files a chat is saved as. Functions that change records
// return { state, targets } (or { error }); the loader applies the state and saves the targets.

// ---------- tags (UC20) ----------
// A tag ending in "#" counts up. A chat keeps "name#"; each new message gets the next number; a
// message holds one number per counter. Counters run within each chat or across all chats, as set.

const tag_clean = (raw) =>
  String(raw || "")
    .trim()
    .replace(/\s+/g, "-");
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

// A folder renamed: its chats (and those of folders inside it) get the new path, and so do its
// Folder records. `moves` are the files to move ({ from, to }), done by whoever applies this.
const folder_rename = (state, { from, to }) => {
  const clean = String(to || "")
    .trim()
    .replace(/[\\:*?"<>|]/g, "-")
    .replace(/^\/+|\/+$/g, "");
  if (!clean) return { error: { code: "invalid_argument", message: "Give the folder a new name" } };
  const path = from.includes("/") ? `${from.slice(0, from.lastIndexOf("/"))}/${clean}` : clean;
  if (path === from)
    return { error: { code: "invalid_argument", message: "Give the folder a new name" } };
  const swap = (p) =>
    p === from ? path : p.startsWith(`${from}/`) ? path + p.slice(from.length) : p;
  if (
    state.folders.some((f) => f.id === path) ||
    state.chats.some((c) => c.file.startsWith(`${path}/`))
  )
    return { error: { code: "already_exists", message: `There's already a folder "${clean}"` } };
  const moves = state.chats
    .filter((c) => swap(c.file) !== c.file)
    .map((c) => ({ id: c.id, from: c.file, to: swap(c.file) }));
  const files = new Map(moves.map((m) => [m.id, m.to]));
  const chats = state.chats.map((c) => (files.has(c.id) ? { ...c, file: files.get(c.id) } : c));
  const folders = state.folders.map((f) => ({ ...f, id: swap(f.id), order: f.order.map(swap) }));
  const targets = [{ file: "folders" }, ...moves.map((m) => ({ chat: m.id }))];
  return { state: { ...state, chats, folders }, targets, moves };
};

// A folder deleted: its chats (and those of folders inside it) go to the top level, kept.
const folder_delete = (state, { path }) => {
  const inside = (p) => p === path || p.startsWith(`${path}/`);
  const ids = state.chats
    .filter((c) => inside(c.file.slice(0, Math.max(0, c.file.lastIndexOf("/")))))
    .map((c) => c.id);
  const moved = ids.length
    ? folder_move(state, ids, { folder: "" })
    : { state, targets: [], moves: [] };
  if (moved.error) return moved;
  const folders = moved.state.folders.filter((f) => !inside(f.id));
  return {
    ...moved,
    state: { ...moved.state, folders },
    targets: [{ file: "folders" }, ...moved.targets],
  };
};

const url_same = (a, b) => {
  const clean = (u) =>
    String(u || "")
      .replace(/[?#].*$/, "")
      .replace(/\/$/, "");
  return clean(a) !== "" && clean(a) === clean(b);
};

// A site's short name from a link ("https://chat.qwen.ai/c/1" → "Qwen"), for people to read.
const site_name_get = (url) => {
  try {
    const name = new URL(url).host.replace(/^(www|chat|chatgpt)\./, "").split(".")[0];
    return name ? name[0].toUpperCase() + name.slice(1) : "AI";
  } catch {
    return "AI";
  }
};

// The one way to make a chat: named (or after its first message's first line, 60 characters),
// its file in the folder, dated (UC1, UC41).
const chat_create = (state, { id, name, message, folder = "", own = {}, site_url, at }) => {
  const title =
    name ||
    String(message || "")
      .split("\n")[0]
      .slice(0, 60)
      .trim() ||
    "New chat";
  const time = at || PP.time_get();
  const file = chat_file_build(state, title, folder);
  const fields = { name: title, file, tags: [], own, created: time, updated: time };
  return PP.record_create(state, {
    collection: "chats",
    id,
    fields: { ...fields, ...(site_url && { site_url }) },
  });
};

// The chat already linked to this site chat, or a new one linked to it.
const site_chat_open = (state, { provider, url, name, id, at }) => {
  const known = state.chats.find((c) => url_same(c.site_url, url));
  if (known) return { state, record: known, targets: [] };
  return chat_create(state, { id, name: name || url, own: { provider }, site_url: url, at });
};

// The page's messages into the chat (all of them, or the newest); with save off, the newest
// reply decoded by the after-reply hooks, as a preview.
const words = (text) =>
  String(text || "")
    .replace(/\s+/g, " ")
    .trim();

// For telling the same text apart from formatting: letters and digits only.
const loose = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

// A message as the site shows it, without what PromptPipe sent around it: the chat's profile's
// System prompt texts are taken off, then each plugin takes off its own part (sent_unwrap: Base64
// its instruction, decoding your text; Memory its summary), leaving yours.
const message_unwrap = async (state, chat, text) => {
  const record = state.chats.find((c) => c.id === chat);
  const profile = record && PP.profile_get(state, record);
  const texts = ((state.config && state.config.blocks) || [])
    .filter((b) => profile && b.profile === profile.id && b.type === "prompt" && b.text)
    .map((b) => b.text.trim())
    .sort((a, b) => b.length - a.length);
  let out = String(text || "");
  for (const t of texts) out = out.split(t).join("");
  if (PP.hook_run) out = await PP.hook_run("sent_unwrap", out, { chat: record });
  return out.replace(/\n{3,}/g, "\n\n").trim() || String(text || "").trim();
};

// The page's messages into the chat (all, or the newest), or the newest reply decoded as a
// preview (UC13). A message already in the chat (by what was sent, or your text) is skipped; one
// PromptPipe sent shows as your text; replies go through the profile's reply plugins (Base64
// decoding, say), as live ones do. Answers how many were added and how many were already here.
const site_chat_import = async (state, { chat, page, which, save }) => {
  const turns = await PP.call_send("site_read", { page, which, wait: false });
  const record = state.chats.find((c) => c.id === chat);
  const after = (reply) =>
    PP.hook_run
      ? PP.hook_run("reply_after", reply || "", { chat: record, notes: [] })
      : reply || "";
  if (!save) {
    const last = turns[turns.length - 1] || {};
    return { preview: await after(last.reply) };
  }
  const here = state.turns.filter((t) => t.chat === chat);
  // (A copy of the list: what this import adds is checked too.)
  let result = { state, targets: [] };
  let added = 0;
  let skipped = 0;
  let fixed = 0;
  for (const turn of turns) {
    const mine = turn.message ? await message_unwrap(state, chat, turn.message) : "";
    // Already here: by what was sent, your text, or (a message without one) its reply; formatting
    // aside (the site shows text a little differently from what was sent).
    const known = here.some(
      (t) =>
        (turn.site_ref && t.site_ref === turn.site_ref) ||
        (turn.message &&
          (loose(t.sent) === loose(turn.message) ||
            loose(t.message) === loose(turn.message) ||
            loose(t.message) === loose(mine))) ||
        (!turn.message && turn.reply && loose(t.received || t.reply) === loose(turn.reply)),
    );
    if (known) {
      skipped += 1;
      continue;
    }
    // Brought in before without your text (an earlier import that missed it): filled in, not added.
    const blank =
      turn.message &&
      here.find((t) => !loose(t.message) && loose(t.received || t.reply) === loose(turn.reply));
    if (blank) {
      const set = PP.record_set(result.state, {
        collection: "turns",
        id: blank.id,
        fields: { message: mine, sent: turn.message },
      });
      if (set.error) return set;
      result = { state: set.state, targets: [{ chat }] };
      here.splice(here.indexOf(blank), 1, { ...blank, message: mine, sent: turn.message });
      fixed += 1;
      continue;
    }
    const fields = {
      chat,
      at: PP.time_get(),
      tags: [],
      message: mine,
      sent: turn.message || "",
      received: turn.reply || "",
      reply: await after(turn.reply),
      thinking: turn.thinking || "",
      site_ref: turn.site_ref || "",
      notes: ["added from the site"],
    };
    const made = PP.record_create(result.state, {
      collection: "turns",
      fields,
      id: PP.id_create(),
    });
    if (made.error) return made;
    result = { state: made.state, targets: [{ chat }] };
    here.push(made.record); // the next ones are checked against it too
    added += 1;
  }
  return { ...result, added, skipped, fixed };
};

// A chat's repeated messages (the same message and reply again, as an import that read every
// reply three times left them): every copy after the first, as a record operation.
const turns_repeated_remove = (state, { chat }) => {
  const seen = new Set();
  const repeated = [];
  for (const t of state.turns.filter((x) => x.chat === chat)) {
    const key = `${words(t.message)}\u0000${words(t.reply)}`;
    if (seen.has(key)) repeated.push(t.id);
    else seen.add(key);
  }
  return {
    state: { ...state, turns: state.turns.filter((t) => !repeated.includes(t.id)) },
    targets: repeated.length ? [{ chat }] : [],
    removed: repeated.length,
  };
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

// A folder deep enough that its paths pass what Android allows (the old app copied its chats
// folder into itself ~500 levels deep; the import copied that): deleted from the top, each folder
// below moved up to a short name first, so no path is ever long. Not while a chat lives in it.
const folder_deep_remove = async (state, { folder }) => {
  const inside = state.chats.filter((c) => c.file.startsWith(`${folder}/`)).length;
  if (inside) return { removed: 0, chats: inside };
  const queue = [folder];
  let removed = 0;
  let n = 0;
  while (queue.length) {
    const current = queue.shift();
    const entries = await PP.call_send("file_list", {
      root: "chats",
      folder: current,
      hidden: true,
    }).catch(() => []);
    for (const e of entries.filter((x) => x.folder)) {
      const short = `.promptpipe/trash-${Date.now().toString(36)}-${(n += 1)}`;
      await PP.call_send("file_move", { root: "chats", from: `${current}/${e.name}`, to: short });
      queue.push(short);
    }
    await PP.call_send("file_delete", { root: "chats", path: current });
    removed += 1;
  }
  return { removed, chats: 0 };
};

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

// ---------- a chat's turns ----------

// Read a chat's turns and its plugins' data into the State once (record_get on chats brings
// them, UC16; plugin data D6).
const chat_load = async (id) => {
  if ((PP.state_get().loaded || []).includes(id)) return;
  const dir = `.promptpipe/chats/${id}`;
  const files = await PP.call_send("file_read", { root: "chats", pattern: `${dir}/*.json` });
  const name = (f) =>
    f.path
      .split("/")
      .pop()
      .replace(/\.json$/, "");
  // By its own path too, if the pattern didn't bring it: a chat must never look empty (and then be
  // saved empty) because a listing missed its messages.
  const turns_file =
    files.find((f) => name(f) === "turns") ||
    (
      await PP.call_send("file_read", { root: "chats", path: `${dir}/turns.json` }).catch(() => [])
    )[0];
  const turns = turns_file ? JSON.parse(turns_file.data) : [];
  const data = files
    .filter((f) => !["turns", "meta"].includes(name(f)))
    .map((f) => ({ id: `${id}/${name(f)}`, chat: id, plugin: name(f), data: JSON.parse(f.data) }));
  PP.state_set((s) => ({
    ...s,
    turns: [...s.turns, ...turns],
    chat_data: [...(s.chat_data || []).filter((d) => d.chat !== id), ...data],
    loaded: [...(s.loaded || []), id],
  }));
};

// A plugin's data for a chat (D6), and the operation that sets it.
const chat_data_get = (state, chat, plugin) =>
  ((state.chat_data || []).find((d) => d.id === `${chat}/${plugin}`) || {}).data;

const chat_data_set = (state, chat, plugin, data) => {
  const id = `${chat}/${plugin}`;
  const chat_data = [
    ...(state.chat_data || []).filter((d) => d.id !== id),
    { id, chat, plugin, data },
  ];
  return { state: { ...state, chat_data }, targets: [{ file: "chat_data", id }, { chat }] };
};

// ---------- the files a chat is saved as ----------

// meta.json (the chat without its turns), turns.json, and the readable file.
const chat_files_build = async (state, id) => {
  const meta = state.chats.find((c) => c.id === id);
  const loaded = (state.loaded || []).includes(id);
  const dir = `.promptpipe/chats/${id}`;
  const read = () => PP.call_send("file_read", { root: "chats", path: `${dir}/turns.json` });
  const [file] = await read().catch(() => []);
  const disk = file ? JSON.parse(file.data) : [];
  const mine = state.turns.filter((t) => t.chat === id);
  // A chat that was loaded without its messages (a listing that missed them) would be saved with
  // only the new ones: when the State shares none of the saved messages, they're kept first.
  // (Only when there's something new to save: deleting a chat's last message leaves it empty.)
  const missed =
    loaded && mine.length && disk.length && !disk.some((d) => mine.some((t) => t.id === d.id));
  const turns = !loaded ? disk : missed ? [...disk, ...mine] : mine;
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
    folder_rename,
    folder_delete,
    chat_file_build,
    chat_create,
    url_same,
    site_name_get,
    site_chat_open,
    site_chat_import,
    folder_deep_remove,
    turns_repeated_remove,
    attachment_add,
    chats_folder_move,
    chat_files_build,
    chat_load,
    chat_data_get,
    chat_data_set,
  },
  calls: {
    chat_find: (d, state) => chat_find(state, d.query),
    site_chat_open: (d, state) => site_chat_open(state, d),
    site_chat_import: (d, state) => site_chat_import(state, d),
    folder_deep_remove: (d, state) => folder_deep_remove(state, d),
    attachment_add: (d, state) => attachment_add(state, d),
    chats_folder_move: (d, state) => chats_folder_move(state, d),
  },
});
