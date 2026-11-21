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

const chat_open = async (id) => {
  PP.ui_set((ui) => ({
    chat: id,
    drawer: false,
    unseen: { ...ui.unseen, [id]: undefined },
    composer: { big: false },
  }));
  if (id) await PP.chat_load(id);
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
    const name = text.split("\n")[0].slice(0, 60) || "New chat";
    const folder = state.ui.folder || "";
    const fields = {
      name,
      file: PP.chat_file_build(state, name, folder),
      tags: [],
      own: {},
      created: PP.time_get(),
      updated: PP.time_get(),
    };
    const made = await PP.apply_try((s) =>
      PP.record_create(s, { collection: "chats", fields, id: chat }),
    );
    if (!made) return;
    PP.state_set((s) => ({ ...s, loaded: [...s.loaded, chat], ui: { ...s.ui, chat } }));
  }
  await PP.apply_try((s) => ({
    state: { ...s, drafts: s.drafts.filter((d) => d.id !== (state.ui.chat || "new")) },
    targets: [{ file: "drafts" }],
  }));
  PP.message_send({
    chat,
    message: text,
    attachments: draft.attachments,
    replaces: draft.replaces || null,
  });
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
  PP.apply_try((s) =>
    PP.record_set(s, { collection: "settings", fields: { "chats.profile": next.id } }),
  );
  PP.toast(`Profile: ${next.name}`);
};

const site_view_toggle = (state) => {
  const open = !state.ui.site_view.open;
  const page = state.ui.site_view.page || (state.pages[0] && state.pages[0].id);
  if (open && !page) return PP.toast("Get a provider first: tap its name at the top", true);
  PP.ui_set(() => ({ site_view: { open, page }, sheets: [], drawer: false }));
};

// ---------- the table ----------

const C = (id, label, place, key, run) => ({ id, label, place, key, run });

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
  C("send", "Send", "Message box", "Ctrl+Enter", message_send),
  C("stop", "Stop waiting", "Message box", "", send_stop),
];

// What a dialog's OK or a sheet's item runs with its data (the dialog adds the text typed as `value` and
// the button pressed as `choice`); not listed in Find.
const RUNS = {
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
    COMMANDS,
    command_run,
    sheet_open,
    sheet_close,
    chat_get,
    chat_open,
    draft_get,
    draft_set,
    message_send_run: message_send,
  },
});
