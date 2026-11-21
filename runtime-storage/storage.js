"use strict";
// Storage: an outside change answered in the shared dialog (D7), the local API's token (UC37),
// connections (UC40.6), the storage check (UC36), and the first things after the app starts.

// The shared dialog's answer. theirs: take the file as it is now (a kept edit of a readable chat
// is read back into the chat); ours: write the app's version over it; both: keep theirs beside
// it as a copy, then write ours.
const change_resolve = async (state, { change, choice }) => {
  const { root, path } = change;
  if (choice === "both") {
    const copy = path.replace(/(\.\w+)?$/, (ext) => ` (outside copy)${ext || ""}`);
    await PP.call_send("file_move", { root, from: path, to: copy, copy: true, overwrite: false });
  }
  if (choice === "ours" || choice === "both") {
    const written = await PP.store_save(
      { ...state, revisions: { ...state.revisions, [`${root}/${path}`]: change.theirs } },
      [change.target],
    );
    PP.state_set((s) => ({
      ...s,
      revisions: written.revisions,
      changes: s.changes.filter((c) => c !== change),
    }));
    return written;
  }
  const [file] = await PP.call_send("file_read", { root, path });
  const chat = state.chats.find((c) => c.file === path);
  let sections = {};
  PP.state_set((s) => {
    const next = {
      ...s,
      revisions: { ...s.revisions, [`${root}/${path}`]: file.revision },
      changes: s.changes.filter((c) => c !== change),
    };
    if (path === "config.json") return { ...next, config: JSON.parse(file.data) };
    if (!chat) return next;
    const edited = PP.chat_parse(file.data);
    const turns = next.turns.map((t) => {
      const e = edited.turns.find((x) => x.id === t.id);
      return e
        ? { ...t, message: e.message, reply: e.reply, thinking: e.thinking || t.thinking }
        : t;
    });
    const chats = next.chats.map((c) =>
      c.id === chat.id ? { ...c, name: edited.name, tags: edited.tags } : c,
    );
    sections = edited.sections;
    return { ...next, turns, chats };
  });
  if (!chat) return;
  // A plugin's edited section (Memory's summaries) goes back into its data (D6, D7).
  const parsed = Object.keys(sections).filter((p) => PP.hook_get(p, "chat_section_parse"));
  for (const plugin of parsed) {
    const parse = PP.hook_get(plugin, "chat_section_parse");
    PP.state_set((s) => {
      const data = parse(sections[plugin], PP.chat_data_get(s, chat.id, plugin));
      return PP.chat_data_set(s, chat.id, plugin, data).state;
    });
  }
  const data = parsed.map((p) => ({ file: "chat_data", id: `${chat.id}/${p}` }));
  await PP.record_apply(
    (s) => ({ state: s, targets: [{ chat: chat.id }, ...data] }),
    `outside edit: ${chat.name}`,
  );
};

// A new local API token: its hash in the settings (the core checks requests against it), its
// value kept in credentials, where the screen shows it masked (UC37).
const api_token_create = async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  const hash = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  await PP.call_send("credential_create", {
    name: "local API token",
    access: "read_write",
    tags: ["local API"],
    value: token,
  });
  await PP.record_apply((s) => ({
    state: { ...s, config: { ...s.config, api_token_hash: hash } },
    targets: [{ file: "config" }],
  }));
  return { token };
};

// The problems in a connection: its provider, address and credential (UC40.6).
const connection_verify = (state, connection) =>
  [
    !state.plugins.some((p) => p.id === connection.provider) && "its provider isn't installed",
    !/^https:\/\//.test(connection.base_url || "") && "its address must start with https://",
    !state.credentials.some((c) => c.name === connection.credential) &&
      "its credential isn't in Credentials",
  ].filter(Boolean);

// What the chats folder allows, step by step, with the phone's own answer (UC36).
const storage_verify = async () => {
  const checks = [
    ["make a folder and write in it", ".promptpipe/check/a.txt"],
    ["write a file beside the chats", ".promptpipe-check.txt"],
  ];
  const out = [];
  for (const [name, path] of checks) {
    try {
      await PP.call_send("file_write", { root: "chats", path, data: "ok", expected: "none" });
      await PP.call_send("file_delete", { root: "chats", path });
      out.push({ name, ok: true });
    } catch (error) {
      out.push({ name, ok: false, why: error.message });
    }
  }
  return out;
};

// After loading: the provider's site page in the background, so it's ready to log in or send
// (UC9), and the plugins' update check when it's due (UC31).
const app_start_run = async (state) => {
  const id = PP.provider_get(state, null);
  const plugin = state.plugins.find((p) => p.id === id);
  if (plugin && !state.pages.length) {
    const page = await PP.call_send("page_open", {
      url: plugin.manifest.provider.url,
      provider: PP.provider_build(state, plugin),
    });
    PP.state_set((s) => ({ ...s, pages: [...s.pages, page] }));
  }
  const every = { daily: 1, weekly: 7 }[PP.setting_get(state, "updates.check")];
  const last = Date.parse(PP.setting_get(state, "updates.checked") || 0);
  if (every && Date.parse(PP.time_get()) - last > every * 86400000) {
    const result = await PP.catalogue_load(state);
    PP.state_set((s) => ({ ...s, catalogue: result }));
    await PP.record_apply((s) =>
      PP.record_set(s, { collection: "settings", fields: { "updates.checked": PP.time_get() } }),
    );
  }
};

// ---------- loading the State at start ----------

const CONFIG_NEW = {
  version: 1,
  settings: {},
  profiles: [],
  blocks: [],
  groups: [],
  templates: [],
  provider_choices: {},
  connections: [],
  sources: [],
};

// Everything the app keeps, read into the State once: settings, the prompt library, folders,
// counters, drafts, every chat's meta (not its turns), the credentials' listing. A first start
// makes the profile you have from Plain.
const state_load = async (state) => {
  const schemas = JSON.parse(PP.content_read("runtime-records", "schemas.json"));
  const chats_default = `${(state.app && state.app.app_folder) || ""}/chats`;
  schemas.settings = schemas.settings.map((d) =>
    d.key === "storage.chats_folder" ? { ...d, default: chats_default } : d,
  );
  const revisions = {};
  const read = async (root, path, fallback) => {
    const [file] = await PP.call_send("file_read", { root, path }).catch(() => []);
    if (!file) return fallback;
    revisions[`${root}/${path}`] = file.revision;
    return JSON.parse(file.data);
  };
  const config = { ...CONFIG_NEW, ...(await read("app", "config.json", {})) };
  const metas = await PP.call_send("file_read", {
    root: "chats",
    pattern: ".promptpipe/chats/*/meta.json",
  }).catch(() => []);
  let next = {
    ...state,
    schemas,
    config,
    revisions,
    prompts: await read("chats", ".promptpipe/prompts.json", []),
    folders: await read("chats", ".promptpipe/folders.json", []),
    counters: await read("chats", ".promptpipe/counters.json", {}),
    drafts: await read("app", "drafts.json", []),
    chats: metas.map((f) => JSON.parse(f.data)),
    chat_data: [],
    credentials: await PP.call_send("credential_list", {}).catch(() => []),
  };
  if (!config.profiles.length) {
    const made = PP.profile_create(next, { template: "plain", name: "Plain", id: PP.id_create() });
    next = made.state;
    const settings = { ...next.config.settings, "chats.profile": made.record.id };
    next = { ...next, config: { ...next.config, settings } };
    const saved = await PP.store_save(next, [{ file: "config" }]);
    next = { ...next, revisions: { ...next.revisions, ...saved.revisions } };
  }
  return next;
};

PP.plugin_set({
  functions: {
    change_resolve,
    api_token_create,
    connection_verify,
    storage_verify,
    app_start_run,
    state_load,
  },
  calls: {
    change_resolve: (d, state) => change_resolve(state, d),
    api_token_create: () => api_token_create(),
    storage_verify: () => storage_verify(),
  },
});
