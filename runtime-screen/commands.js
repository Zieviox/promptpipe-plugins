"use strict";
// The command table (strategy 2): every action the person can take, read by the menus, the keys,
// Find's functions, help mode and the guides (the command list in the requirements is its
// content). A command's `run` gets the State and its data.

// ---------- what commands do ----------

// Opening a sheet drops what it read last time (ui.loads under its name), so it reads afresh.
const sheet_open = (name, data = {}) =>
  PP.ui_set((ui) => ({
    sheets: [...ui.sheets, { name, data }],
    menu: false,
    loads: Object.fromEntries(Object.entries(ui.loads || {}).filter(([k]) => !k.startsWith(name))),
  }));
const sheet_close = () => PP.ui_set((ui) => ({ sheets: ui.sheets.slice(0, -1) }));

const chat_get = (state) => state.chats.find((c) => c.id === state.ui.chat) || null;

// Opening a chat: it shows at its newest message, and its profile becomes the one new chats
// start with (wireframe v38).
const chat_open = async (id) => {
  PP.ui_set((ui) => ({
    chat: id,
    drawer: false,
    unseen: { ...ui.unseen, [id]: undefined },
    composer: { big: false },
    bottom: true,
  }));
  if (!id) return;
  await PP.chat_load(id);
  const state = PP.state_get();
  const own = ((state.chats.find((c) => c.id === id) || {}).own || {}).profile;
  if (own && own !== PP.setting_get(state, "chats.profile"))
    PP.apply_try((s) =>
      PP.record_set(s, { collection: "settings", fields: { "chats.profile": own } }),
    );
};

// Chats in the list's order, for Alt+↑ and Alt+↓.
const chat_step = (state, by) => {
  const ids = state.chats.map((c) => c.id);
  const at = ids.indexOf(state.ui.chat);
  const next = ids[at + by];
  if (next) chat_open(next);
};

const draft_get = (state) =>
  state.drafts.find((d) => d.id === (state.ui.chat || "new")) || { text: "", attachments: [] };

// Undo and Redo your actions (the newest first), said in a toast that offers the other.
const undo_run = async () => {
  const label = await PP.record_undo().catch((e) => (PP.toast(PP.error_words(e), true), undefined));
  if (label === undefined) return;
  if (!label) return PP.toast("Nothing to undo");
  PP.toast(`Undone: ${label}`, false, null, { label: "Redo", command: "redo" });
};
const redo_run = async () => {
  const label = await PP.record_redo().catch((e) => (PP.toast(PP.error_words(e), true), undefined));
  if (label === undefined) return;
  if (!label) return PP.toast("Nothing to redo");
  PP.toast(`Redone: ${label}`, false, null, { label: "Undo", command: "undo" });
};

// Whether the profile is off for the open chat (or the chat about to start): your message goes
// alone, as typed. Kept with the chat (own.raw), or with the new chat's draft until it starts.
const raw_get = (state) => {
  const chat = chat_get(state);
  return chat ? !!(chat.own && chat.own.raw) : !!draft_get(state).raw;
};
const raw_set = (state, on) => {
  const chat = chat_get(state);
  if (!chat) return draft_set(draft_get(state).text, { raw: on });
  return PP.apply_try((s) =>
    PP.record_set(s, { collection: "chats", id: chat.id, fields: { own: { raw: on || null } } }),
  );
};

// The draft is kept per chat on this device (UC7): in the State at once, in its file shortly after.
let draft_timer = 0;
const draft_set = (text, fields = {}) => {
  PP.state_set((s) => {
    const id = s.ui.chat || "new";
    const old = s.drafts.find((d) => d.id === id) || { id, attachments: [] };
    return { ...s, drafts: [...s.drafts.filter((d) => d.id !== id), { ...old, ...fields, text }] };
  });
  clearTimeout(draft_timer);
  draft_timer = setTimeout(
    () => PP.apply_try((s) => ({ state: s, targets: [{ file: "drafts" }] })),
    600,
  );
};

// Send what's in the box: a new chat is made with its first message (named after its first line).
const message_send = async (state) => {
  const draft = draft_get(state);
  const text = draft.text.trim();
  if (!text && !draft.attachments.length) return PP.toast("Type a message first");
  let chat = state.ui.chat;
  if (!chat) {
    chat = PP.id_create();
    const folder = state.ui.folder || "";
    const own = draft.raw ? { raw: true } : {};
    const made = await PP.apply_try((s) =>
      PP.chat_create(s, { id: chat, message: text, folder, own }),
    );
    if (!made) return;
    PP.state_set((s) => ({ ...s, loaded: [...s.loaded, chat], ui: { ...s.ui, chat } }));
  }
  // The message is saved in the outbox before the box is cleared, so the text is always kept
  // somewhere, whatever happens next.
  PP.message_send({
    chat,
    message: text,
    attachments: draft.attachments,
    replaces: draft.replaces || null,
    plain: raw_get(PP.state_get()),
  });
  await PP.outbox_save();
  await PP.apply_try((s) => ({
    state: { ...s, drafts: s.drafts.filter((d) => d.id !== (state.ui.chat || "new")) },
    targets: [{ file: "drafts" }],
  }));
};

const send_stop = (state) => {
  const send = state.sends.find(
    (s) => s.chat === state.ui.chat && ["waiting", "sending"].includes(s.status),
  );
  if (send) PP.call_try("send_stop", { send: send.id });
};

// Edit and resend your last message: back into the box, replacing it when sent (UC5).
const last_edit = (state) => {
  const turns = state.turns.filter((t) => t.chat === state.ui.chat);
  const last = turns[turns.length - 1];
  if (last) draft_set(last.message, { replaces: last.id });
};

const scale_set = (state, by) => {
  const now = PP.setting_get(state, "look.scale");
  const value = by === 0 ? 100 : Math.max(60, Math.min(200, now + by));
  PP.apply_try((s) =>
    PP.record_set(s, { collection: "settings", fields: { "look.scale": value } }),
  );
  PP.toast(`UI scale ${value}%`);
};

const profile_next = (state) => {
  const profiles = state.config.profiles;
  const at = profiles.indexOf(PP.profile_get(state, chat_get(state)));
  const next = profiles[(at + 1) % profiles.length];
  PP.profile_pick(chat_get(state), next.id);
  PP.toast(`Profile: ${next.name}`);
};

// The site view (UC12): the page of the chat's provider, opened first when there's none yet.
const site_view_toggle = async (state) => {
  const open = !state.ui.site_view.open;
  const provider = PP.provider_get(state, chat_get(state));
  const own = state.pages.find((p) => p.provider === provider);
  let page = (own && own.id) || state.ui.site_view.page || (state.pages[0] && state.pages[0].id);
  if (open && !own) {
    const plugin = state.plugins.find((p) => p.id === provider);
    if (!plugin && !page) return PP.toast("Get a provider first: tap its name at the top", true);
    if (plugin) {
      const added = await PP.page_add(
        PP.provider_build(state, plugin),
        plugin.manifest.provider.url,
      ).catch((error) => (PP.toast(error.message, true), undefined));
      if (added === undefined) return;
      if (added) page = added.id;
      else if (!page) return PP.toast("That's the most pages at once (Settings › Sites)", true);
    }
  }
  PP.ui_set(() => ({ site_view: { open, page }, sheets: [], drawer: false }));
};

// ---------- the table ----------

// One plain line per command, for help mode's card and the hover "?" (spec: every control explains
// itself).
const HELP = {
  chat_new: "Starts an empty chat; it's saved with its first message.",
  drawer: "Your chats and folders: pinned first, search, tags, drag to reorder.",
  selection:
    "Pick several chats to pin, move or delete them together. Press and hold a chat does the same.",
  folder_new: "A new folder for chats. Drop chats onto it to put them in.",
  chat_previous: "Opens the chat above this one in the list.",
  chat_next: "Opens the chat below this one in the list.",
  site_view: "Shows the AI site's own page: log in there, and see what the app types.",
  site_chats: "Lists the chats in the site's own sidebar, to continue one here.",
  models: "Picks the site's model and its options (Thinking, Search), set before each message.",
  site_link: "This chat reads and sends in the page that's open now.",
  site_import: "Copies the messages of the linked site chat into this chat.",
  site_newest: "Adds the reply the page shows now to this chat.",
  site_decode: "Shows the page's newest reply as your plugins would decode it, without saving it.",
  chat_sheet: "This chat: rename, tags, pin, move, copy, share, its history.",
  chat_tag: "A tag every message in this chat gets. A tag ending in # counts up.",
  chat_copy: "Copies the whole chat as Markdown.",
  chat_share: "Shares the whole chat with another app, or saves it as a file.",
  chat_move: "Moves this chat into a folder.",
  thinking_fold: "Opens or closes every reply's thinking at once.",
  last_edit: "Puts your last message back in the box; sending replaces it.",
  composer_big: "Makes the message box big for long text, or small again. What you typed stays.",
  quick_edit: "This chat's profile: turn its blocks on or off, reorder them, add text files.",
  text_file: "Puts a text file's words into the message box.",
  text_files: "Puts several text files into the box, one after another.",
  attach: "Attaches files to your message; they're kept with the chat.",
  profile_edit: "Opens the profile this chat uses: its blocks, in the order they're sent.",
  profiles: "Your profiles: make one from a template, import or export them.",
  profile_next: "Switches this chat to the next profile.",
  prompts: "System prompts you keep; a profile can link one, and one edit changes them all.",
  plugins: "The profile's blocks and the plugin library: install, update, remove.",
  plugins_reload: "Restarts the app with the plugins as they are on disk.",
  profiles_export: "Saves your profiles to a file you can share or keep.",
  profiles_import: "Brings in profiles from a file.",
  prompts_export: "Saves the prompt library to a file.",
  prompts_import: "Brings in prompts from .md or .txt files, or a library file.",
  plugin_file_install: "Installs a plugin from a .zip on your phone.",
  credentials: "API keys and tokens, kept encrypted and only ever sent to their own sites.",
  storage_check: "Checks what the app can do in your chats folder, with Android's own answers.",
  history: "Every saved change, as git commits.",
  settings: "Everything you can set, in groups.",
  scale_up: "Makes everything bigger.",
  scale_down: "Makes everything smaller.",
  scale_reset: "Back to the normal size.",
  help: "Every shortcut, and the gestures.",
  help_mode: "Tap anything to see what it does, instead of doing it.",
  quick_start: "Short guides to the app; each can be shown again.",
  find: "Finds chats, messages, functions and settings by name.",
  logs: "Every notice and error, failed sends and site problems, kept so you can read a missed one; with the core's log and the crash record.",
  undo: "Undoes your last action (deleting, moving, renaming, a change to a profile…); again for the one before.",
  redo: "Does again what Undo undid.",
  send: "Sends your message. Sending more while a reply comes queues them in order.",
  stop: "Stops waiting for the reply that's coming.",
  plugin_install: "Installs a plugin.",
};

const C = (id, label, place, key, run) => ({ id, label, place, key, run, help: HELP[id] || "" });

const COMMANDS = [
  C("chat_new", "New chat", "Chats", "Ctrl+N", () => chat_open(null)),
  C("drawer", "Chats and folders", "Chats", "Ctrl+B", (s) =>
    PP.ui_set(() => ({ drawer: !s.ui.drawer })),
  ),
  C("selection", "Select chats", "Chats", "", () =>
    PP.ui_set(() => ({ drawer: true, selection: { on: true, ids: [] } })),
  ),
  C("folder_new", "New folder", "Chats", "", () =>
    PP.dialog_open({ title: "New folder", ok: "Create", command: "folder_create" }),
  ),
  C("chat_previous", "Previous chat", "Chats", "Alt+ArrowUp", (s) => chat_step(s, -1)),
  C("chat_next", "Next chat", "Chats", "Alt+ArrowDown", (s) => chat_step(s, 1)),
  C("site_view", "Show AI page", "Chats", "Alt+S", site_view_toggle),
  C("site_chats", "Open a chat from the site", "Chats", "", () => sheet_open("site_chats")),
  C("models", "Model and options", "Provider sheet", "Ctrl+M", () => sheet_open("models")),
  C("site_link", "Link this chat to the open page", "Provider sheet", "", (s) => PP.chat_link(s)),
  C("site_import", "Import messages from the linked site chat", "Provider sheet", "", (s) =>
    PP.site_import(s, "all", true),
  ),
  C("site_newest", "Add the page's newest reply", "Provider sheet", "", (s) =>
    PP.site_import(s, "newest", true),
  ),
  C("site_decode", "Decode the page's newest reply (preview)", "Provider sheet", "", (s) =>
    PP.site_import(s, "newest", false),
  ),
  C("chat_sheet", "Chat details", "Chat", "F2", () => sheet_open("chat")),
  C("chat_tag", "Add chat tag", "Chat", "Ctrl+T", () =>
    PP.dialog_open({
      title: "Tag for every message in this chat (name# numbers them)",
      ok: "Add",
      command: "chat_tag_add",
    }),
  ),
  C("chat_copy", "Copy the whole chat", "Chat", "", (s) => PP.chat_export(s, "clipboard")),
  C("chat_share", "Share or export the whole chat", "Chat", "", (s) => PP.chat_export(s, "share")),
  C("chat_move", "Move chat to folder", "Chat", "", () => sheet_open("move")),
  C("thinking_fold", "Fold or unfold all thinking", "Chat", "Ctrl+/", (s) =>
    PP.ui_set((ui) => ({
      unfolded: ui.unfolded.length ? [] : s.turns.map((t) => `think:${t.id}`),
    })),
  ),
  C("last_edit", "Edit and resend last message", "Message box", "ArrowUp", last_edit),
  C("composer_big", "Bigger or smaller message box", "Message box", "Ctrl+E", () =>
    PP.ui_set((ui) => ({ composer: { big: !ui.composer.big } })),
  ),
  C("quick_edit", "Quick edit", "Message box", "", () => sheet_open("quick")),
  C("text_file", "Put a text file in the box", "Message box", "", (s) =>
    PP.text_files_add(s, false),
  ),
  C("text_files", "Put several text files in the box", "Message box", "", (s) =>
    PP.text_files_add(s, true),
  ),
  C("attach", "Attach files", "Message box", "", (s) => PP.files_attach(s)),
  C("profile_edit", "Edit this profile", "Profile", "Ctrl+Shift+L", (s) =>
    sheet_open("profile", { id: PP.profile_get(s, chat_get(s)).id }),
  ),
  C("profiles", "Profiles: new, import, export", "Profile", "", () => sheet_open("profiles")),
  C("profile_next", "Next profile", "Profile", "Ctrl+P", profile_next),
  C("prompts", "Prompt library", "Settings", "", () => sheet_open("prompts")),
  C("plugins", "Plugins", "Settings", "Ctrl+Shift+P", () => sheet_open("plugins")),
  C("plugins_reload", "Reload plugins", "Settings › Plugins", "Ctrl+Shift+R", () =>
    PP.call_try("app_start", { mode: "normal" }),
  ),
  C("profiles_export", "Export all profiles", "Settings › Import and export", "", (s, d) =>
    PP.records_export("profiles", (d && d.ids) || s.config.profiles.map((p) => p.id)),
  ),
  C("profiles_import", "Import a profile", "Settings › Import and export", "", () =>
    PP.records_import("profiles"),
  ),
  C("prompts_export", "Export the prompt library", "Settings › Import and export", "", (s) =>
    PP.records_export(
      "prompts",
      s.prompts.map((p) => p.id),
    ),
  ),
  C("prompts_import", "Import prompts", "Settings › Import and export", "", () =>
    PP.records_import("prompts"),
  ),
  C("plugin_file_install", "Install a plugin from a file", "Settings › Plugins", "", async () => {
    const [file] =
      (await PP.call_try("picker_open", { types: ["application/zip"], many: false })) || [];
    if (file) PP.command_run("plugin_install", { zip: PP.base64_decode(file.data) });
  }),
  C("credentials", "Credentials", "Settings", "", () => sheet_open("credentials")),
  C("storage_check", "Storage check", "Settings › Chats and storage", "", () =>
    sheet_open("storage_check"),
  ),
  C("history", "Git history", "Settings › Chats and storage", "", () =>
    sheet_open("history", { all: true }),
  ),
  C("settings", "Settings", "Settings", "Ctrl+,", () => sheet_open("settings")),
  C("scale_up", "Bigger UI", "Settings › Look", "Ctrl+=", (s) => scale_set(s, 5)),
  C("scale_down", "Smaller UI", "Settings › Look", "Ctrl+-", (s) => scale_set(s, -5)),
  C("scale_reset", "UI scale 100%", "Settings › Look", "Ctrl+0", (s) => scale_set(s, 0)),
  C("help", "Shortcuts and help", "Help", "Ctrl+?", () => sheet_open("help")),
  C("help_mode", "Help mode", "Help", "", () =>
    PP.ui_set((ui) => ({ help: !ui.help, help_card: null })),
  ),
  C("quick_start", "Quick start", "Help", "", () => sheet_open("quick_start")),
  C("find", "Find", "everywhere", "Ctrl+K", () => sheet_open("find")),
  C("undo", "Undo", "everywhere", "Ctrl+Z", undo_run),
  C("logs", "Logs", "Settings › Advanced", "", (state) => {
    // Opening it marks what's there as seen (the dot on Settings goes).
    PP.state_set((s) => ({
      ...s,
      log: { ...(s.log || { entries: [] }), seen_at: new Date().toISOString() },
    }));
    PP.store_save(PP.state_get(), [{ file: "log" }]).catch(() => null);
    sheet_open("log");
  }),
  C("redo", "Redo", "everywhere", "Ctrl+Shift+Z", redo_run),
  C("send", "Send", "Message box", "Ctrl+Enter", message_send),
  C("stop", "Stop waiting", "Message box", "", send_stop),
];

// What a dialog's OK or a sheet's item runs with its data (the dialog adds the text typed as `value` and
// the button pressed as `choice`); not listed in Find.
const RUNS = {
  // A message and its reply deleted, after the dialog's yes (it stays in the history).
  turn_delete: (s, d) =>
    d.choice === "yes" &&
    PP.apply_try(
      (st) => PP.record_delete(st, { collection: "turns", id: d.id }),
      "message deleted",
      "Message deleted",
    ),
  log_clear: (s, d) => {
    if (d.choice !== "yes") return;
    PP.state_set((st) => ({ ...st, log: { entries: [], seen_at: new Date().toISOString() } }));
    PP.store_save(PP.state_get(), [{ file: "log" }]).catch(() => null);
  },
  // Its text back into the box, or discarded (the dialog's choice).
  send_dismiss: (s, d) => d.choice && PP.send_dismiss(d.send, d.choice),
  // Confirmed in the dialog first (choice "yes").
  chats_delete: (s, d) => d.choice === "yes" && PP.chats_delete(d.ids),
  folder_delete: (s, d) =>
    d.choice === "yes" && PP.folder_delete_run(d.path).then(() => PP.sheet_close()),
  profile_delete: (s, d) =>
    d.choice === "yes" &&
    PP.apply_try((x) => PP.record_delete(x, { collection: "profiles", id: d.id })).then(() =>
      PP.sheet_close(),
    ),
  plugin_remove: (s, d) =>
    d.choice === "yes" &&
    PP.call_try("plugin_remove", { plugin: d.plugin, copy: d.copy }, "Removed. Restart the app."),
  first_launch_reset: (s, d) =>
    d.choice === "yes" &&
    PP.apply_try((x) => PP.record_set(x, { collection: "settings", fields: { "help.seen": [] } })),
  source_remove: (s, d) =>
    d.choice === "yes" &&
    PP.apply_try((x) => PP.record_delete(x, { collection: "sources", id: d.id })),
  // Another provider for a chat that has replies: a new conversation there (Memory carries the
  // context), so the chat's link to its old site chat goes.
  provider_switch: (s, d) =>
    d.choice === "yes" &&
    PP.apply_try(
      (x) =>
        PP.record_set(x, {
          collection: "chats",
          id: d.chat,
          fields: { own: { provider: d.provider }, site_url: "" },
        }),
      "provider switched",
    ),
  chat_tag_remove: (s, d) => d.choice === "yes" && PP.chat_tag_remove(s, d.tag),
  folder_create: (s, d) => PP.folder_create(s, d.value),
  chat_tag_add: (s, d) => PP.chat_tag_add(s, d.value),
  turn_tag_add: (s, d) => PP.turn_tag_add(s, d.id, d.value),
  chat_rename: (s, d) => PP.chat_rename(s, d.value),
  profile_rename: (s, d) =>
    d.value.trim() &&
    PP.apply_try((x) =>
      PP.record_set(x, { collection: "profiles", id: d.id, fields: { name: d.value.trim() } }),
    ),
  chats_folder_move: (s, d) =>
    PP.call_try("chats_folder_move", { folder: d.value.trim(), how: d.choice || "move" }, "Done"),
  record_import: (s, d) => PP.record_import_run({ ...d, clash: d.choice }),
  // Adding a source: its key is shown (in groups of four) and added only when you trust it.
  source_add: async (s, d) => {
    if (d.choice === "yes") {
      const fields = { url: d.url, key: d.key, on: true };
      await PP.apply_try((x) =>
        PP.record_create(x, { collection: "sources", id: PP.id_create(), fields }),
      );
      return PP.state_set((x) => ({ ...x, catalogue: null }));
    }
    const found = await PP.call_try("source_verify", { url: d.value });
    if (!found) return;
    const groups = found.source.key.match(/.{4}/g).join(" ");
    PP.dialog_open({
      title: `${found.source.url} offers ${found.count} plugins, signed with the key ${groups}. Only add sources from people you trust: plugins are code and can read your chats. Its owner can update the plugins you install from it. Trust this key?`,
      choices: [["yes", "Trust and add"]],
      command: "source_add",
      data: found.source,
    });
  },
  plugin_install: async (s, from) => {
    const answer = await PP.call_try("plugin_install", from);
    if (answer && answer.conflict) {
      const name = answer.conflict.manifest.name;
      return PP.dialog_open({
        title: `“${name}” is already installed. Replace it?`,
        choices: [["yes", "Replace"]],
        command: "plugin_install",
        data: { ...from, confirmed: true },
      });
    }
    if (answer) PP.toast("Installed. Restart the app to use it.");
  },
};

const command_run = (id, data) => {
  const state = PP.state_get();
  const command =
    COMMANDS.find((c) => c.id === id) || (PP.plugin_commands || []).find((c) => c.id === id);
  if (command)
    return Promise.resolve(command.run(state, data)).catch((e) => PP.toast(e.message, true));
  if (RUNS[id])
    return Promise.resolve(RUNS[id](state, data || {})).catch((e) => PP.toast(e.message, true));
};

PP.plugin_set({
  functions: {
    HELP,
    COMMANDS,
    command_run,
    sheet_open,
    sheet_close,
    chat_get,
    chat_open,
    draft_get,
    raw_get,
    raw_set,
    draft_set,
    message_send_run: message_send,
  },
});
